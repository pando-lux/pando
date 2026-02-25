import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { AccountStore } from './accounts.js';
import { TransactionStore } from './transactions.js';
import { ContributionStore } from './contributions.js';
import type { Account, Transaction, ApiContribution, ActivityRecord, AgentScore } from '@pando/shared';
import type { WorkType } from '@pando/shared';
import { ApiProvider, LUX_HARD_CAP } from '@pando/shared';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LedgerSnapshot {
  version: 1;
  timestamp: number;
  transactionCount: number;
  totalSupply: number;
  accounts: Array<{ peerId: string; publicKey: string; balance: number }>;
}

export interface SnapshotInfo {
  filename: string;
  timestamp: number;
  transactionCount: number;
  totalSupply: number;
  accountCount: number;
}

export class PandoLedger {
  private db: Database.Database;
  readonly accounts: AccountStore;
  readonly transactions: TransactionStore;
  readonly contributions: ContributionStore;

  constructor(dataDir?: string) {
    this.db = openDatabase(dataDir);
    this.accounts = new AccountStore(this.db);
    this.transactions = new TransactionStore(this.db, this.accounts);
    this.contributions = new ContributionStore(this.db, this.accounts, this.transactions);
  }

  /**
   * Register a new node on the ledger. Called when a node first joins.
   */
  registerNode(peerId: string, publicKey: string): Account {
    return this.accounts.create(peerId, publicKey);
  }

  /** Get account by peerId (returns null if not found). */
  getAccount(peerId: string): Account | null {
    return this.accounts.get(peerId);
  }

  /**
   * Transfer Lux from one peer to another.
   * Fee goes to the relay node (the peer facilitating the transaction).
   */
  transfer(from: string, to: string, amount: number, relay?: string): Transaction {
    return this.transactions.transfer(from, to, amount, relay);
  }

  /**
   * Apply a pre-validated remote transaction (from GossipSub sync).
   * Credits the recipient without checking sender balance.
   */
  applyRemoteTransaction(tx: Transaction): void {
    return this.transactions.applyRemoteTransaction(tx);
  }

  getTransactionsSince(timestamp: number, limit?: number): Transaction[] {
    return this.transactions.getTransactionsSince(timestamp, limit);
  }

  /**
   * Reward a node for useful work.
   * Mints new Lux (up to hard cap).
   */
  rewardWork(peerId: string, workType: WorkType, workProof: string): Transaction {
    return this.contributions.rewardWork(peerId, workType, workProof);
  }

  /**
   * Register an API key contribution.
   */
  registerApiKey(peerId: string, provider: ApiProvider, monthlyCap: number): ApiContribution {
    return this.contributions.register(peerId, provider, monthlyCap);
  }

  /**
   * Record usage of a contributed API key and reward the contributor.
   */
  recordApiUsage(contributionId: number, costUsd: number, workProof: string): number {
    return this.contributions.recordUsage(contributionId, costUsd, workProof);
  }

  /**
   * Get network-wide stats.
   */
  getNetworkStats() {
    return {
      totalSupply: this.transactions.getTotalSupply(),
      hardCap: LUX_HARD_CAP,
      totalBurned: this.transactions.getTotalBurned(),
      totalRelayFees: this.transactions.getTotalRelayFees(),
      circulatingSupply: this.transactions.getTotalSupply(),
      totalAccounts: this.accounts.getAccountCount(),
      totalTransactions: this.transactions.getTransactionCount(),
      activeContributors: this.contributions.getActiveContributorCount(),
      totalApiSpend: this.contributions.getTotalApiSpend(),
    };
  }

  /**
   * Get a summary for a specific peer.
   */
  getPeerSummary(peerId: string) {
    const account = this.accounts.get(peerId);
    if (!account) return null;

    return {
      account,
      recentTransactions: this.transactions.getTransactionsForPeer(peerId, 20),
      apiContributions: this.contributions.getByPeer(peerId),
    };
  }

  /**
   * Record an agent activity event.
   */
  recordActivity(record: ActivityRecord): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO activity
        (id, agent_id, node_id, agent_role, agent_tier, model_id, action, timestamp, summary, details, proposal_id, task_id, transaction_id, signature, received_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.agentId,
      record.nodeId,
      record.agentRole,
      record.agentTier,
      record.modelId,
      record.action,
      record.timestamp,
      record.summary,
      record.details || null,
      record.proposalId || null,
      record.taskId || null,
      record.transactionId || null,
      record.signature,
      Date.now(),
    );
  }

  /**
   * Query activity records with optional filters.
   */
  getActivity(opts: { limit?: number; since?: number; agentId?: string; action?: string } = {}): ActivityRecord[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts.since) {
      conditions.push('timestamp > ?');
      params.push(opts.since);
    }
    if (opts.agentId) {
      conditions.push('agent_id = ?');
      params.push(opts.agentId);
    }
    if (opts.action) {
      conditions.push('action = ?');
      params.push(opts.action);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit || 50;

    const rows = this.db.prepare(
      `SELECT * FROM activity ${where} ORDER BY timestamp DESC LIMIT ?`
    ).all(...params, limit) as any[];

    return rows.map(row => ({
      id: row.id,
      agentId: row.agent_id,
      nodeId: row.node_id,
      agentRole: row.agent_role,
      agentTier: row.agent_tier,
      modelId: row.model_id,
      action: row.action,
      timestamp: row.timestamp,
      summary: row.summary,
      details: row.details || undefined,
      proposalId: row.proposal_id || undefined,
      taskId: row.task_id || undefined,
      transactionId: row.transaction_id || undefined,
      signature: row.signature,
    }));
  }

  /**
   * Get aggregated activity stats within a time window.
   * Returns total events, breakdown by action, and breakdown by agent.
   */
  getActivityStats(windowMs: number): { total: number; byAction: Record<string, number>; byAgent: Record<string, number> } {
    const since = Date.now() - windowMs;

    const total = (this.db.prepare(
      'SELECT COUNT(*) as cnt FROM activity WHERE timestamp > ?'
    ).get(since) as any)?.cnt || 0;

    const actionRows = this.db.prepare(
      'SELECT action, COUNT(*) as cnt FROM activity WHERE timestamp > ? GROUP BY action ORDER BY cnt DESC'
    ).all(since) as Array<{ action: string; cnt: number }>;

    const agentRows = this.db.prepare(
      'SELECT agent_id, COUNT(*) as cnt FROM activity WHERE timestamp > ? GROUP BY agent_id ORDER BY cnt DESC'
    ).all(since) as Array<{ agent_id: string; cnt: number }>;

    const byAction: Record<string, number> = {};
    for (const row of actionRows) byAction[row.action] = row.cnt;

    const byAgent: Record<string, number> = {};
    for (const row of agentRows) byAgent[row.agent_id] = row.cnt;

    return { total, byAction, byAgent };
  }

  // === Agent Scoring ===

  /**
   * Record an agent score event (build pass, build fail, revert, etc.).
   * Upserts the agent_scores row for the given peerId.
   */
  recordScoreEvent(peerId: string, event: 'commit' | 'build_pass' | 'build_fail' | 'revert' | 'proposal_created' | 'proposal_accepted'): void {
    const now = Date.now();
    // Ensure row exists
    this.db.prepare(
      `INSERT OR IGNORE INTO agent_scores (peer_id, total_commits, successful_builds, failed_builds, reverts_triggered, proposals_created, proposals_accepted, updated_at)
       VALUES (?, 0, 0, 0, 0, 0, 0, ?)`
    ).run(peerId, now);

    const col = event === 'commit' ? 'total_commits'
      : event === 'build_pass' ? 'successful_builds'
      : event === 'build_fail' ? 'failed_builds'
      : event === 'revert' ? 'reverts_triggered'
      : event === 'proposal_created' ? 'proposals_created'
      : 'proposals_accepted';

    this.db.prepare(
      `UPDATE agent_scores SET ${col} = ${col} + 1, updated_at = ? WHERE peer_id = ?`
    ).run(now, peerId);
  }

  /**
   * Get agent score for a specific peer.
   */
  getAgentScore(peerId: string): AgentScore | null {
    const row = this.db.prepare('SELECT * FROM agent_scores WHERE peer_id = ?').get(peerId) as any;
    if (!row) return null;
    return this.rowToAgentScore(row);
  }

  /**
   * Get all agent scores, sorted by score descending.
   */
  getAllAgentScores(): AgentScore[] {
    const rows = this.db.prepare('SELECT * FROM agent_scores ORDER BY successful_builds DESC').all() as any[];
    return rows.map(row => this.rowToAgentScore(row));
  }

  private rowToAgentScore(row: any): AgentScore {
    const totalCommits = row.total_commits;
    const successfulBuilds = row.successful_builds;
    const score = totalCommits > 0 ? Math.round((successfulBuilds / totalCommits) * 100 * 100) / 100 : 0;
    return {
      peerId: row.peer_id,
      totalCommits,
      successfulBuilds,
      failedBuilds: row.failed_builds,
      revertsTriggered: row.reverts_triggered,
      proposalsCreated: row.proposals_created,
      proposalsAccepted: row.proposals_accepted,
      score,
      updatedAt: row.updated_at,
    };
  }

  /** Expose database for governance persistence (same ledger.db). */
  getDatabase(): Database.Database {
    return this.db;
  }

  // === Ledger Snapshots ===

  private getSnapshotDir(dataDir?: string): string {
    const base = dataDir || join(homedir(), '.pando');
    return join(base, 'snapshots');
  }

  /**
   * Create a snapshot of the current ledger state.
   * Serializes all accounts + balances + transaction count to a JSON file.
   * Keeps last 5 snapshots, prunes older ones.
   */
  createSnapshot(dataDir?: string): SnapshotInfo {
    const snapshotDir = this.getSnapshotDir(dataDir);
    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true });
    }

    const rows = this.db.prepare(
      'SELECT peer_id, public_key, balance FROM accounts ORDER BY peer_id'
    ).all() as Array<{ peer_id: string; public_key: string; balance: number }>;

    const stats = this.getNetworkStats();
    const txCount = stats.totalTransactions;

    const snapshot: LedgerSnapshot = {
      version: 1,
      timestamp: Date.now(),
      transactionCount: txCount,
      totalSupply: stats.totalSupply,
      accounts: rows.map(r => ({
        peerId: r.peer_id,
        publicKey: r.public_key,
        balance: r.balance,
      })),
    };

    const filename = `snapshot-${snapshot.timestamp}.json`;
    writeFileSync(join(snapshotDir, filename), JSON.stringify(snapshot, null, 2));

    // Prune old snapshots — keep last 5
    this.pruneSnapshots(snapshotDir, 5);

    return {
      filename,
      timestamp: snapshot.timestamp,
      transactionCount: txCount,
      totalSupply: stats.totalSupply,
      accountCount: rows.length,
    };
  }

  /**
   * Load ledger state from a snapshot file.
   * Initializes accounts and balances from the snapshot data.
   * Should be called on a fresh ledger before replaying remaining transactions.
   */
  loadSnapshot(snapshotPath: string): LedgerSnapshot {
    const raw = readFileSync(snapshotPath, 'utf-8');
    const snapshot: LedgerSnapshot = JSON.parse(raw);

    if (snapshot.version !== 1) {
      throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
    }

    // Apply snapshot: create accounts with balances
    const insertOrUpdate = this.db.transaction(() => {
      for (const acct of snapshot.accounts) {
        const exists = this.accounts.exists(acct.peerId);
        if (!exists) {
          this.db.prepare(
            'INSERT INTO accounts (peer_id, public_key, balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
          ).run(acct.peerId, acct.publicKey, acct.balance, Date.now(), Date.now());
        } else {
          this.db.prepare(
            'UPDATE accounts SET balance = ?, updated_at = ? WHERE peer_id = ?'
          ).run(acct.balance, Date.now(), acct.peerId);
        }
      }

      // Update network stats from snapshot
      this.db.prepare(
        "UPDATE network_stats SET value = ?, updated_at = ? WHERE key = 'total_supply'"
      ).run(String(snapshot.totalSupply), Date.now());

      this.db.prepare(
        "UPDATE network_stats SET value = ?, updated_at = ? WHERE key = 'total_accounts'"
      ).run(String(snapshot.accounts.length), Date.now());
    });

    insertOrUpdate();
    return snapshot;
  }

  /**
   * Get info about the latest snapshot, or null if none exist.
   */
  getSnapshotInfo(dataDir?: string): SnapshotInfo | null {
    const snapshotDir = this.getSnapshotDir(dataDir);
    if (!existsSync(snapshotDir)) return null;

    const files = readdirSync(snapshotDir)
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    const latest = files[0];
    try {
      const raw = readFileSync(join(snapshotDir, latest), 'utf-8');
      const snapshot: LedgerSnapshot = JSON.parse(raw);
      return {
        filename: latest,
        timestamp: snapshot.timestamp,
        transactionCount: snapshot.transactionCount,
        totalSupply: snapshot.totalSupply,
        accountCount: snapshot.accounts.length,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get the full path to the latest snapshot file, or null if none exist.
   */
  getLatestSnapshotPath(dataDir?: string): string | null {
    const snapshotDir = this.getSnapshotDir(dataDir);
    if (!existsSync(snapshotDir)) return null;

    const files = readdirSync(snapshotDir)
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;
    return join(snapshotDir, files[0]);
  }

  private pruneSnapshots(snapshotDir: string, keep: number): void {
    const files = readdirSync(snapshotDir)
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort()
      .reverse();

    // Remove oldest files beyond the keep limit
    for (let i = keep; i < files.length; i++) {
      try {
        unlinkSync(join(snapshotDir, files[i]));
      } catch {}
    }
  }

  close(): void {
    this.db.close();
  }
}

export { AccountStore } from './accounts.js';
export { TransactionStore } from './transactions.js';
export { ContributionStore } from './contributions.js';
export { openDatabase } from './database.js';
