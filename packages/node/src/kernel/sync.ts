/**
 * Distributed ledger synchronization via GossipSub.
 *
 * Real-time: When a transaction happens, broadcast it to all peers.
 * Catch-up: When a peer connects, request missed transactions since last sync.
 * Dedup by transaction ID to prevent double-processing.
 */

import type { PandoNetwork } from './network.js';
import type { PandoLedger } from '@pando/ledger';
import type { PandoMessage, Transaction, ActivityRecord, ProjectRegistryRecord } from '@pando/shared';
import { MessageType, TransactionType, verifyTransactionSignature } from '@pando/shared';
/** Minimal interface — avoids importing platform/ from kernel/ */
interface ProjectRegistryLike {
  applyRemoteRecord(record: ProjectRegistryRecord): boolean;
  getAllProjects(): ProjectRegistryRecord[];
}
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import { peerIdFromString } from '@libp2p/peer-id';

/**
 * Extract the base64-encoded public key from a peerId string.
 * Returns null if extraction fails (e.g., RSA peerIds without inline keys).
 */
function extractPublicKey(peerId: string): string | null {
  try {
    const peerIdObj = peerIdFromString(peerId);
    if (peerIdObj.publicKey?.raw) {
      return Buffer.from(peerIdObj.publicKey.raw).toString('base64');
    }
  } catch {
    // Extraction failed — return null
  }
  return null;
}

export const TOPIC_TRANSACTIONS = 'pando/transactions';
export const TOPIC_SYNC = 'pando/sync';
export const TOPIC_ACTIVITY = 'pando/activity';

export class LedgerSync {
  private network: PandoNetwork;
  private ledger: PandoLedger;
  private processedTxs: Set<string> = new Set();
  private appliedTxs: Set<string> = new Set();  // Belt-and-suspenders dedup for async apply
  private processedActivities: Set<string> = new Set();
  private processedClaims: Set<string> = new Set();
  private localPeerId: string;
  private lastSyncTimestamp: number = 0;
  private lastActivitySyncTimestamp: number = 0;
  private transactionCallback: ((tx: Transaction) => void) | null = null;
  private activityCallback: ((record: ActivityRecord) => void) | null = null;
  private syncCheckTimer: ReturnType<typeof setInterval> | null = null;
  // Phase 63: P2P Project Registry for catch-up sync
  private projectRegistry: ProjectRegistryLike | null = null;

  constructor(network: PandoNetwork, ledger: PandoLedger, localPeerId: string) {
    this.network = network;
    this.ledger = ledger;
    this.localPeerId = localPeerId;
    // If local ledger has few transactions, request full history (imported identity case).
    // Otherwise, just catch up from the last minute.
    const txCount = this.ledger.transactions.getTransactionCount();
    this.lastSyncTimestamp = txCount <= 1 ? 0 : Date.now() - 60_000;
    this.lastActivitySyncTimestamp = Date.now() - 60_000;
  }

  async start(): Promise<void> {
    // Subscribe to real-time transaction broadcasts
    await this.network.subscribeTopic(
      TOPIC_TRANSACTIONS,
      this.handleIncomingTransaction.bind(this)
    );

    // Subscribe to sync topic for catch-up requests/responses
    await this.network.subscribeTopic(
      TOPIC_SYNC,
      this.handleSyncMessage.bind(this)
    );

    // Subscribe to activity broadcasts
    await this.network.subscribeTopic(
      TOPIC_ACTIVITY,
      this.handleActivityMessage.bind(this)
    );

    // When a new peer connects, request their recent transactions and activity.
    // Two attempts: immediate (5s) and retry (30s) to handle GossipSub mesh forming delay.
    this.network.onPeerConnect((peerId) => {
      setTimeout(() => this.requestSync(peerId).catch(err => console.error(`[p2p] requestSync error for ${peerId.slice(0, 16)}:`, err.message)), 5000);
      setTimeout(() => this.requestActivitySync(peerId).catch(err => console.error(`[p2p] requestActivitySync error for ${peerId.slice(0, 16)}:`, err.message)), 5500);
      // Retry after 30s in case GossipSub mesh wasn't ready for the first attempt
      setTimeout(() => this.requestSync(peerId).catch(err => console.error(`[p2p] requestSync retry error for ${peerId.slice(0, 16)}:`, err.message)), 30000);
    });

    // Start periodic sync health check to catch up if we fall behind
    this.startPeriodicSyncCheck();

    console.log(`Ledger sync: subscribed to ${TOPIC_TRANSACTIONS}, ${TOPIC_ACTIVITY}`);
  }

  /**
   * Broadcast a SYNC_REQUEST to all peers without requiring a specific peer trigger.
   * Used by the periodic sync check to detect and close transaction gaps.
   */
  private async requestSyncFromPeers(): Promise<void> {
    if (this.network.getPeerCount() === 0) return;

    try {
      const txCount = this.ledger.transactions.getTransactionCount();
      const message: PandoMessage = {
        type: MessageType.SYNC_REQUEST,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: { since: 0, txCount },
      };
      await this.network.publishToTopic(TOPIC_SYNC, message);
      console.log(`[sync] Periodic sync check: requesting catch-up from peers (local txCount: ${txCount})`);
    } catch (err) {
      // GossipSub may fail if no peers — that's ok
    }
  }

  /**
   * Start a periodic sync health check that runs every 60 seconds.
   * Broadcasts a sync request so peers can detect if we're behind and send missing transactions.
   */
  startPeriodicSyncCheck(): void {
    if (this.syncCheckTimer) return; // Already running
    this.syncCheckTimer = setInterval(() => {
      this.requestSyncFromPeers().catch(err => console.error('[p2p] periodic sync check error:', err.message));
    }, 60_000);
  }

  /**
   * Stop ledger sync: clear periodic timers.
   */
  stop(): void {
    if (this.syncCheckTimer) {
      clearInterval(this.syncCheckTimer);
      this.syncCheckTimer = null;
    }
  }

  /** Phase 63: Wire ProjectRegistry for catch-up sync. */
  setProjectRegistry(pr: ProjectRegistryLike): void {
    this.projectRegistry = pr;
  }

  /**
   * Broadcast a local transaction to all peers via GossipSub.
   */
  async broadcastTransaction(tx: Transaction): Promise<void> {
    // Mark as processed so we don't re-apply our own broadcast
    this.processedTxs.add(tx.id);

    const message: PandoMessage = {
      type: MessageType.TRANSFER,
      from: this.localPeerId,
      timestamp: tx.timestamp,
      payload: tx,
    };

    try {
      await this.network.publishToTopic(TOPIC_TRANSACTIONS, message);
      console.log(`[sync] Broadcast tx ${tx.id.slice(0, 12)}... (${tx.amount} Lux → ${tx.to.slice(0, 16)}...)`);
    } catch (err) {
      // GossipSub may fail if no peers — that's ok
      console.log(`[sync] No peers to broadcast to (${this.network.getPeerCount()} peers)`);
    }
  }

  /**
   * Broadcast an account claim to all peers via GossipSub (Phase 56).
   * Includes balance so receiving nodes can create the account with the correct balance
   * and keep totalSupply consistent (fixes welcome-bonus divergence bug).
   */
  async broadcastClaim(claim: { peerId: string; username: string | null; displayName: string | null; passwordHash: string; claimedAt: number; balance?: number }): Promise<void> {
    const id = `claim:${claim.peerId}:${claim.claimedAt}`;
    this.processedClaims.add(id);
    // #40: Strip balance from broadcasted claims — balance must only change via validated transactions
    const { balance: _stripped, ...safeClaim } = claim;
    const message: PandoMessage = {
      type: MessageType.ACCOUNT_CLAIM,
      from: this.localPeerId,
      timestamp: claim.claimedAt,
      payload: safeClaim,
    };
    await this.network.publishToTopic(TOPIC_SYNC, message);
    console.log(`[sync] Broadcast account claim: ${claim.username || claim.peerId.slice(0, 16)}...`);
  }

  /**
   * Request recent transactions from peers via GossipSub.
   * All peers subscribed to TOPIC_SYNC will respond with their transactions.
   * Includes our txCount so the responder can detect large gaps (e.g. long offline).
   */
  private async requestSync(peerId: string): Promise<void> {
    try {
      const txCount = this.ledger.transactions.getTransactionCount();
      const message: PandoMessage = {
        type: MessageType.SYNC_REQUEST,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: { since: 0, txCount },
      };
      await this.network.publishToTopic(TOPIC_SYNC, message);
      console.log(`[sync] Requested catch-up from peers (triggered by ${peerId.slice(0, 16)}..., local txCount: ${txCount})`);
    } catch (err) {
      // GossipSub may fail if no peers — that's ok
    }
  }

  /**
   * Handle sync messages (requests and responses).
   */
  private handleSyncMessage(message: PandoMessage): void {
    if (message.type === MessageType.SYNC_REQUEST) {
      this.handleSyncRequest(message).catch(err => console.error('[p2p] handleSyncRequest error:', err.message));
    } else if (message.type === MessageType.SYNC_RESPONSE) {
      this.handleSyncResponse(message).catch(err => console.error('[p2p] handleSyncResponse error:', err.message));
    } else if (message.type === MessageType.ACCOUNT_CLAIM) {
      this.handleIncomingClaim(message);
    }
  }

  /**
   * Respond to a sync request with our recent transactions.
   * If the requester has significantly fewer transactions, send full history.
   */
  private async handleSyncRequest(message: PandoMessage): Promise<void> {
    const { since, txCount: requesterTxCount } = message.payload as { since: number; txCount?: number };
    const localTxCount = this.ledger.transactions.getTransactionCount();

    // If requester sent their txCount and they have significantly fewer transactions,
    // send full history instead of just the recent window.
    let effectiveSince = since || 0;
    let limit = 500;

    if (typeof requesterTxCount === 'number' && requesterTxCount < localTxCount) {
      const gap = localTxCount - requesterTxCount;
      // Any gap means peer is behind — send full history from beginning
      effectiveSince = 0;
      limit = 10000;
      console.log(`[sync] Peer has ${requesterTxCount} txns vs our ${localTxCount} — sending full catch-up (gap: ${gap})`);
    }

    const transactions = this.ledger.getTransactionsSince(effectiveSince, limit);
    // #40: Strip balance from claimed accounts — balance must only change via validated transactions
    const claimedAccounts = this.ledger.accounts.getClaimedAccounts().map(
      ({ balance: _b, ...rest }) => rest
    );
    const projects = this.projectRegistry?.getAllProjects() ?? [];

    if (transactions.length === 0 && claimedAccounts.length === 0 && projects.length === 0) return;

    try {
      const response: PandoMessage = {
        type: MessageType.SYNC_RESPONSE,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: { transactions, claimedAccounts, projects },
      };
      await this.network.publishToTopic(TOPIC_SYNC, response);
      console.log(`[sync] Sent ${transactions.length} transactions + ${claimedAccounts.length} claimed accounts + ${projects.length} projects for catch-up (since: ${effectiveSince === 0 ? 'genesis' : new Date(effectiveSince).toISOString()})`);
    } catch (err) {
      // Ignore publish errors
    }
  }

  /**
   * Apply transactions from a sync response.
   */
  private async handleSyncResponse(message: PandoMessage): Promise<void> {
    const { transactions, claimedAccounts, projects } = message.payload as { transactions: Transaction[]; claimedAccounts?: any[]; projects?: ProjectRegistryRecord[] };
    if ((!transactions || !Array.isArray(transactions)) && (!claimedAccounts || !Array.isArray(claimedAccounts))) return;

    let applied = 0;
    let rejected = 0;
    for (const tx of transactions) {
      if (!tx || !tx.id) continue;
      if (this.processedTxs.has(tx.id)) continue;
      this.processedTxs.add(tx.id);

      // Validate basic fields
      if (!tx.from || !tx.to || !tx.amount || tx.amount <= 0) continue;

      // Verify signature if present
      const sigResult = await this.verifyTxSignature(tx);
      if (sigResult === false) {
        rejected++;
        continue;
      }
      // Reject unsigned/unverifiable transfers (emissions use witness verification)
      if (sigResult === null && tx.type === TransactionType.TRANSFER) {
        rejected++;
        continue;
      }

      try {
        // Ensure accounts exist — extract real public key from peerId, fall back to 'unknown'
        if (!this.ledger.accounts.exists(tx.from)) {
          this.ledger.registerNode(tx.from, extractPublicKey(tx.from) || 'unknown');
        }
        if (!this.ledger.accounts.exists(tx.to)) {
          this.ledger.registerNode(tx.to, extractPublicKey(tx.to) || 'unknown');
        }

        // #39: Validate sender balance for remote transfers to prevent double-spend
        if (tx.type === TransactionType.TRANSFER && tx.from !== 'NETWORK') {
          const senderBalance = this.ledger.accounts.getBalance(tx.from);
          const totalDebit = tx.amount + (tx.fee || 0);
          if (senderBalance < totalDebit) {
            console.warn(`[sync] REJECTED remote tx ${tx.id.slice(0, 12)}... — insufficient balance: have ${senderBalance}, need ${totalDebit}`);
            rejected++;
            continue;
          }
        }

        this.ledger.applyRemoteTransaction(tx);
        applied++;
        this.transactionCallback?.(tx);
      } catch (err) {
        // Skip transactions that fail (likely duplicates in DB)
      }
    }

    if (applied > 0) {
      console.log(`[sync] Catch-up: applied ${applied} missed transactions${rejected > 0 ? `, rejected ${rejected} (bad signature)` : ''}`);
      this.lastSyncTimestamp = Date.now();
    }

    // Check if a gap still remains after applying (responder may have sent a truncated batch)
    const localTxCount = this.ledger.transactions.getTransactionCount();
    const receivedCount = transactions ? transactions.length : 0;
    if (receivedCount > 0 && receivedCount >= 9000) {
      // We received close to the 10000 limit — there may be more transactions on the peer
      console.warn(`[sync] WARNING: Received ${receivedCount} txns (near limit). Local count: ${localTxCount}. Gap may still exist — next periodic sync will retry.`);
    }

    // Phase 56: Process claimed accounts from sync response
    if (claimedAccounts && Array.isArray(claimedAccounts)) {
      let claimsApplied = 0;
      for (const claim of claimedAccounts) {
        if (!claim || !claim.peerId || !claim.passwordHash) continue;
        const id = `claim:${claim.peerId}:${claim.claimedAt}`;
        if (this.processedClaims.has(id)) continue;
        this.processedClaims.add(id);
        // #41: During catch-up sync, emission transactions are applied above and already
        // increment totalSupply. Do NOT also add claim balance to totalSupply — that causes
        // double-counting. Use adjustBalance=true to fix account balance, but skip totalSupply update.
        const result = this.ledger.accounts.applyRemoteClaim(claim.peerId, claim.username, claim.displayName, claim.passwordHash, claim.claimedAt, claim.balance, true);
        if (result.applied) {
          claimsApplied++;
          if (result.supplyDelta > 0) {
            // Do NOT call updateTotalSupply here — emission transactions already handle it.
            console.log(`[sync] Catch-up claim: ${claim.username || claim.peerId.slice(0, 16)}... balance adjusted +${result.supplyDelta} (totalSupply NOT modified — emission txs handle it)`);
          }
        }
      }
      if (claimsApplied > 0) {
        console.log(`[sync] Catch-up: applied ${claimsApplied} remote account claims`);
      }
    }

    // Phase 63: Process project records from catch-up sync
    if (projects && Array.isArray(projects) && this.projectRegistry) {
      let projectsApplied = 0;
      for (const record of projects) {
        if (!record?.projectId || !record?.apiKeyHash) continue;
        if (this.projectRegistry.applyRemoteRecord(record)) projectsApplied++;
      }
      if (projectsApplied > 0) {
        console.log(`[sync] Applied ${projectsApplied} project records from catch-up`);
      }
    }
  }

  /**
   * Verify a transaction's Ed25519 signature against the sender's public key.
   * Returns true if valid, false if invalid, null if verification not possible
   * (e.g. no signature, emission, or sender public key unknown).
   */
  private async verifyTxSignature(tx: Transaction): Promise<boolean | null> {
    // Emissions are signed by NETWORK, not a real keypair
    if (tx.type === TransactionType.EMISSION) return null;

    // No signature — legacy transaction, can't verify
    if (!tx.signature || tx.signature === '' || tx.signature === 'network-emission') return null;

    // Look up sender's public key from ledger accounts
    const senderAccount = this.ledger.accounts.get(tx.from);
    if (!senderAccount || !senderAccount.publicKey || senderAccount.publicKey === 'unknown') {
      // We don't have the sender's public key — can't verify
      // Reject: cannot trust unverifiable signed transactions
      return false;
    }

    try {
      const publicKeyRaw = uint8ArrayFromString(senderAccount.publicKey, 'base64');
      return await verifyTransactionSignature(tx, tx.signature, publicKeyRaw);
    } catch {
      return false;
    }
  }

  /**
   * Handle an incoming real-time transaction from GossipSub.
   */
  private handleIncomingTransaction(message: PandoMessage): void {
    const tx = message.payload as Transaction;
    if (!tx || !tx.id) return;

    // Skip if already processed
    if (this.processedTxs.has(tx.id)) return;
    this.processedTxs.add(tx.id);

    // Validate basic fields
    if (!tx.from || !tx.to || !tx.amount || tx.amount <= 0) {
      console.warn(`[sync] Invalid transaction from ${message.from.slice(0, 16)}...`);
      return;
    }

    // Verify signature asynchronously, then apply
    this.verifyTxSignature(tx).then((sigResult) => {
      if (sigResult === false) {
        console.warn(`[sync] REJECTED tx ${tx.id.slice(0, 12)}... — invalid signature from ${tx.from.slice(0, 16)}...`);
        return;
      }

      if (sigResult === null && tx.type === TransactionType.TRANSFER) {
        console.warn(`[sync] REJECTED unsigned transfer ${tx.id.slice(0, 12)}... from ${tx.from.slice(0, 16)}...`);
        return;
      }

      // Belt-and-suspenders dedup: check again after async signature verification
      // to prevent race where two identical txs both pass the sync check above
      if (this.appliedTxs.has(tx.id)) return;
      this.appliedTxs.add(tx.id);

      try {
        // Ensure both accounts exist in local ledger — extract real public key from peerId
        if (!this.ledger.accounts.exists(tx.from)) {
          this.ledger.registerNode(tx.from, extractPublicKey(tx.from) || 'unknown');
        }
        if (!this.ledger.accounts.exists(tx.to)) {
          this.ledger.registerNode(tx.to, extractPublicKey(tx.to) || 'unknown');
        }

        // #39: Validate sender balance for real-time remote transfers to prevent double-spend
        if (tx.type === TransactionType.TRANSFER && tx.from !== 'NETWORK') {
          const senderBalance = this.ledger.accounts.getBalance(tx.from);
          const totalDebit = tx.amount + (tx.fee || 0);
          if (senderBalance < totalDebit) {
            console.warn(`[sync] REJECTED real-time tx ${tx.id.slice(0, 12)}... — insufficient balance: have ${senderBalance}, need ${totalDebit}`);
            return;
          }
        }

        this.ledger.applyRemoteTransaction(tx);

        const sigTag = sigResult === true ? ' [signed]' : '';
        console.log(`[sync] Applied remote tx: ${tx.from.slice(0, 12)}... → ${tx.to.slice(0, 12)}... (${tx.amount} Lux)${sigTag}`);
        this.lastSyncTimestamp = Math.max(this.lastSyncTimestamp, tx.timestamp);
        this.transactionCallback?.(tx);
      } catch (err: any) {
        console.warn(`[sync] Failed to apply tx ${tx.id.slice(0, 12)}...: ${err.message}`);
      }
    }).catch((err) => {
      console.warn(`[sync] Signature verification error for tx ${tx.id.slice(0, 12)}...: ${err.message}`);
    });
  }

  /**
   * Handle an incoming account claim from GossipSub (Phase 56).
   */
  private handleIncomingClaim(message: PandoMessage): void {
    const claim = message.payload as { peerId: string; username: string | null; displayName: string | null; passwordHash: string; claimedAt: number; balance?: number };
    if (!claim || !claim.peerId || !claim.passwordHash) return;
    const id = `claim:${claim.peerId}:${claim.claimedAt}`;
    if (this.processedClaims.has(id)) return;
    this.processedClaims.add(id);
    // adjustBalance=false (default): real-time claims arrive via GossipSub alongside
    // the emission transaction, so don't adjust balance here — let applyRemoteTransaction()
    // handle it when the emission tx arrives to avoid double-counting.
    const result = this.ledger.accounts.applyRemoteClaim(claim.peerId, claim.username, claim.displayName, claim.passwordHash, claim.claimedAt, claim.balance);
    if (result.applied) {
      console.log(`[sync] Applied remote account claim: ${claim.username || claim.peerId.slice(0, 16)}...`);
    }
  }

  /**
   * Update totalSupply in network_stats to account for balance carried in an ACCOUNT_CLAIM.
   * This prevents totalSupply divergence when a new account is created with a non-zero balance
   * from a remote claim (e.g. the GUEST_WELCOME bonus was already minted on the originating node).
   */
  private updateTotalSupply(amount: number): void {
    if (amount <= 0) return;
    try {
      const db = this.ledger.getDatabase();
      const row = db.prepare("SELECT value FROM network_stats WHERE key = 'total_supply'").get() as any;
      const current = row ? parseFloat(row.value) : 0;
      const updated = Math.round((current + amount) * 1e8) / 1e8;
      db.prepare("UPDATE network_stats SET value = ?, updated_at = ? WHERE key = 'total_supply'").run(String(updated), Date.now());
    } catch (err: any) {
      console.error(`[sync] Failed to update totalSupply: ${err.message}`);
    }
  }

  /** Set callback for when a remote transaction is applied. */
  onTransaction(callback: (tx: Transaction) => void): void {
    this.transactionCallback = callback;
  }

  /** Set callback for when a remote activity record is received. */
  onActivity(callback: (record: ActivityRecord) => void): void {
    this.activityCallback = callback;
  }

  // ── Activity Broadcasting ──

  /**
   * Broadcast an activity record to all peers via GossipSub.
   */
  async broadcastActivity(record: ActivityRecord): Promise<void> {
    this.processedActivities.add(record.id);

    const message: PandoMessage = {
      type: MessageType.ACTIVITY_BROADCAST,
      from: this.localPeerId,
      timestamp: record.timestamp,
      payload: record,
    };

    try {
      await this.network.publishToTopic(TOPIC_ACTIVITY, message);
      console.log(`[activity] Broadcast: ${record.action} by ${record.agentId.slice(0, 12)}...`);
    } catch (err) {
      console.log(`[activity] No peers to broadcast to (${this.network.getPeerCount()} peers)`);
    }
  }

  /**
   * Handle incoming activity messages (broadcasts, sync requests, sync responses).
   */
  private handleActivityMessage(message: PandoMessage): void {
    if (message.type === MessageType.ACTIVITY_BROADCAST) {
      this.handleIncomingActivity(message);
    } else if (message.type === MessageType.ACTIVITY_SYNC_REQUEST) {
      this.handleActivitySyncRequest(message).catch(err => console.error('[p2p] handleActivitySyncRequest error:', err.message));
    } else if (message.type === MessageType.ACTIVITY_SYNC_RESPONSE) {
      this.handleActivitySyncResponse(message);
    }
  }

  /**
   * Handle an incoming real-time activity broadcast from GossipSub.
   */
  private handleIncomingActivity(message: PandoMessage): void {
    const record = message.payload as ActivityRecord;
    if (!record || !record.id) return;

    // Skip if already processed
    if (this.processedActivities.has(record.id)) return;
    this.processedActivities.add(record.id);

    // Validate required fields
    if (!record.agentId || !record.action || !record.summary || !record.signature) {
      console.warn(`[activity] Invalid activity record from ${message.from.slice(0, 16)}...`);
      return;
    }

    try {
      this.ledger.recordActivity(record);
      console.log(`[activity] Stored remote: ${record.action} by ${record.agentId.slice(0, 12)}...`);
      this.activityCallback?.(record);
    } catch (err: any) {
      // Skip duplicates (INSERT OR IGNORE handles this, but just in case)
    }
  }

  /**
   * Request recent activity records from peers (catch-up on connect).
   */
  private async requestActivitySync(peerId: string): Promise<void> {
    try {
      const message: PandoMessage = {
        type: MessageType.ACTIVITY_SYNC_REQUEST,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: { since: this.lastActivitySyncTimestamp },
      };
      await this.network.publishToTopic(TOPIC_ACTIVITY, message);
      console.log(`[activity] Requested catch-up from peers (triggered by ${peerId.slice(0, 16)}...)`);
    } catch (err) {
      // GossipSub may fail if no peers — that's ok
    }
  }

  /**
   * Respond to an activity sync request with our recent activity records.
   */
  private async handleActivitySyncRequest(message: PandoMessage): Promise<void> {
    const { since } = message.payload as { since: number };
    const records = this.ledger.getActivity({ since: since || 0, limit: 100 });

    if (records.length === 0) return;

    try {
      const response: PandoMessage = {
        type: MessageType.ACTIVITY_SYNC_RESPONSE,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: { records },
      };
      await this.network.publishToTopic(TOPIC_ACTIVITY, response);
      console.log(`[activity] Sent ${records.length} activity records for catch-up`);
    } catch (err) {
      // Ignore publish errors
    }
  }

  /**
   * Apply activity records from a sync response.
   */
  private handleActivitySyncResponse(message: PandoMessage): void {
    const { records } = message.payload as { records: ActivityRecord[] };
    if (!records || !Array.isArray(records)) return;

    let applied = 0;
    for (const record of records) {
      if (!record || !record.id) continue;
      if (this.processedActivities.has(record.id)) continue;
      this.processedActivities.add(record.id);

      if (!record.agentId || !record.action || !record.summary || !record.signature) continue;

      try {
        this.ledger.recordActivity(record);
        applied++;
        this.activityCallback?.(record);
      } catch (err) {
        // Skip duplicates
      }
    }

    if (applied > 0) {
      console.log(`[activity] Catch-up: applied ${applied} missed activity records`);
      this.lastActivitySyncTimestamp = Date.now();
    }
  }

  /**
   * Clean up old processed IDs to prevent memory growth.
   * Called periodically.
   */
  cleanup(): void {
    if (this.processedTxs.size > 10000) {
      // Keep the last 5000
      const arr = Array.from(this.processedTxs);
      this.processedTxs = new Set(arr.slice(arr.length - 5000));
    }
    if (this.appliedTxs.size > 10000) {
      const arr = Array.from(this.appliedTxs);
      this.appliedTxs = new Set(arr.slice(arr.length - 5000));
    }
    if (this.processedActivities.size > 5000) {
      const arr = Array.from(this.processedActivities);
      this.processedActivities = new Set(arr.slice(arr.length - 2500));
    }
    if (this.processedClaims.size > 5000) {
      const arr = Array.from(this.processedClaims);
      this.processedClaims = new Set(arr.slice(arr.length - 2500));
    }
  }
}
