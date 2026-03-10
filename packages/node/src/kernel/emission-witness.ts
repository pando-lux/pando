/**
 * Witness-based emission system for Pando.
 *
 * Instead of nodes self-minting Lux directly, emissions go through a
 * proposal → witness → quorum flow:
 *
 *  1. Node proposes an emission (work proof + amount).
 *  2. Proposal is broadcast via GossipSub on 'pando/emissions'.
 *  3. Peer nodes validate and sign a WitnessAttestation (Ed25519).
 *  4. Once 2+ independent witnesses attest (or bootstrap fallback for <3 nodes),
 *     the emission is finalized and the reward is minted.
 *  5. Proposals expire after 5 minutes.
 *
 * Rate limiting: 10 proposals per node per hour.
 * Anti-spoofing: proposals must come from registered peers with valid signatures.
 */

import type { PandoNetwork } from './network.js';
import type { PandoLedger } from '@pando/ledger';
import type { LedgerSync } from './sync.js';
import type { Transaction, WorkType } from '@pando/shared';
import { DAILY_EMISSION_CAP } from '@pando/shared';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ── Types ────────────────────────────────────────────────────

export interface EmissionProposal {
  id: string;
  peerId: string;          // proposer
  workType: string;        // WorkType enum value
  workProof: string;       // description of work done
  amount: number;          // Lux amount (filled by ledger estimate or caller)
  timestamp: number;
  expiresAt: number;       // timestamp + 5 min
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  witnesses: WitnessAttestation[];
  finalizedAt?: number;
  transactionId?: string;  // ledger tx id after finalization
}

export interface WitnessAttestation {
  witnessPeerId: string;
  proposalId: string;
  approved: boolean;
  signature: string;       // Ed25519 signature over canonical attestation payload
  timestamp: number;
}

export interface EmissionStats {
  totalProposals: number;
  totalApproved: number;
  totalRejected: number;
  totalExpired: number;
  pendingCount: number;
  totalLuxEmitted: number;
  proposalsThisHour: number;
  rateLimitPerHour: number;
  quorumRequired: number;
  bootstrapFallback: boolean;
}

// Wire message shapes for GossipSub
interface EmissionGossipMessage {
  kind: 'proposal' | 'attestation';
  proposal?: EmissionProposal;
  attestation?: WitnessAttestation;
}

// ── Constants ────────────────────────────────────────────────

const PROPOSAL_TIMEOUT_MS = 5 * 60 * 1000;           // 5 minutes
const RATE_LIMIT_PER_HOUR = 10;                       // 10 proposals per node per hour
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;          // 1 hour
const QUORUM_REQUIRED = 2;                             // 2+ independent witnesses
const BOOTSTRAP_NODE_THRESHOLD = 3;                    // if <3 nodes, use bootstrap fallback
const MAX_HISTORY = 500;                               // max completed proposals kept
const CLEANUP_INTERVAL_MS = 60_000;                    // run cleanup every 60s
const BOOTSTRAP_DAILY_CAP = 50;                        // max Lux/day auto-approved in bootstrap mode
const DAY_MS = 24 * 60 * 60 * 1000;                   // milliseconds in a day

// Work proof validation: must contain a valid task/work ID (hex string, 8+ chars)
const WORK_PROOF_ID_PATTERN = /[0-9a-f]{8,}/i;

export const TOPIC_EMISSIONS = 'pando/emissions';

// ── EmissionWitness class ────────────────────────────────────

export class EmissionWitness {
  private network: PandoNetwork | null = null;
  private ledger: PandoLedger | null = null;
  private sync: LedgerSync | null = null;
  private localPeerId: string;
  private localPrivateKey: Uint8Array | null = null;

  // Proposal storage
  private pending: Map<string, EmissionProposal> = new Map();
  private history: EmissionProposal[] = [];

  // Rate limiting: peerId → timestamps of proposals within the window
  private rateLimits: Map<string, number[]> = new Map();
  private rateLimitsFilePath: string;

  // Anti-replay: track processed attestation keys to avoid double-counting
  private processedAttestations: Set<string> = new Set();

  // Stats
  private totalApproved = 0;
  private totalRejected = 0;
  private totalExpired = 0;
  private totalLuxEmitted = 0;

  // Daily emission cap tracking (#25)
  private dailyEmittedLux = 0;
  private dailyEmittedDate = ''; // YYYY-MM-DD string for the current tracking day

  // Bootstrap auto-approve daily cap tracking (#27)
  private dailyBootstrapLux = 0;
  private dailyBootstrapDate = '';

  // Timers
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Callback to finalize emission (rewardWork + broadcast tx)
  private emitCallback: ((peerId: string, workType: string, workProof: string) => Transaction | null) | null = null;

  constructor(localPeerId: string, dataDir?: string) {
    this.localPeerId = localPeerId;
    const dir = dataDir || join(homedir(), '.pando');
    this.rateLimitsFilePath = join(dir, 'emission-rates.json');
    this.loadRateLimits();
  }

  // ── Dependency injection ─────────────────────────────────

  setNetwork(network: PandoNetwork): void {
    this.network = network;
  }

  setLedger(ledger: PandoLedger): void {
    this.ledger = ledger;
  }

  setSync(sync: LedgerSync): void {
    this.sync = sync;
  }

  setPrivateKey(privateKey: Uint8Array): void {
    this.localPrivateKey = privateKey;
  }

  /**
   * Set the callback that actually mints Lux. This wraps the existing
   * ledger.rewardWork + sync.broadcastTransaction pattern.
   */
  setEmitCallback(cb: (peerId: string, workType: string, workProof: string) => Transaction | null): void {
    this.emitCallback = cb;
  }

  // ── Daily cap helpers ───────────────────────────────────

  /** Get today's date string (YYYY-MM-DD) for daily cap tracking. */
  private getTodayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Reset daily counters if the date has rolled over. */
  private resetDailyCountersIfNeeded(): void {
    const today = this.getTodayStr();
    if (this.dailyEmittedDate !== today) {
      this.dailyEmittedLux = 0;
      this.dailyEmittedDate = today;
    }
    if (this.dailyBootstrapDate !== today) {
      this.dailyBootstrapLux = 0;
      this.dailyBootstrapDate = today;
    }
  }

  /** Check if adding `amount` Lux would exceed the daily emission cap. */
  private wouldExceedDailyCap(amount: number): boolean {
    this.resetDailyCountersIfNeeded();
    return (this.dailyEmittedLux + amount) > DAILY_EMISSION_CAP;
  }

  /** Check if adding `amount` Lux would exceed the bootstrap auto-approve daily cap. */
  private wouldExceedBootstrapCap(amount: number): boolean {
    this.resetDailyCountersIfNeeded();
    return (this.dailyBootstrapLux + amount) > BOOTSTRAP_DAILY_CAP;
  }

  /** Record emitted Lux against daily cap counters. */
  private recordDailyEmission(amount: number, isBootstrap: boolean): void {
    this.resetDailyCountersIfNeeded();
    this.dailyEmittedLux += amount;
    if (isBootstrap) {
      this.dailyBootstrapLux += amount;
    }
  }

  // ── Work proof validation ─────────────────────────────

  /**
   * Validate a work proof string. Returns null if valid, or an error message if invalid.
   * - Must be non-empty
   * - Must contain a valid task/work ID format (hex string, 8+ chars)
   * TODO: Full cross-layer validation against task database when accessible from kernel layer.
   */
  private validateWorkProof(workProof: string): string | null {
    if (!workProof || workProof.trim().length === 0) {
      return 'workProof is empty';
    }
    if (workProof.trim().length < 8) {
      return 'workProof too short (must be at least 8 characters)';
    }
    if (!WORK_PROOF_ID_PATTERN.test(workProof)) {
      return 'workProof must contain a valid task/work ID (hex string, 8+ chars)';
    }
    return null; // valid
  }

  // ── Lifecycle ────────────────────────────────────────────

  start(): void {
    // Periodic cleanup of expired proposals
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ── Propose an emission ──────────────────────────────────

  /**
   * Create and broadcast an emission proposal. This is the replacement for
   * direct `ledger.rewardWork()` calls throughout the codebase.
   *
   * Returns the proposal if created, or null if rate-limited/invalid.
   */
  async propose(
    peerId: string,
    workType: string,
    workProof: string,
  ): Promise<EmissionProposal | null> {
    // Work proof validation (#26)
    const proofError = this.validateWorkProof(workProof);
    if (proofError) {
      console.log(`[emission-witness] Invalid work proof from ${peerId.slice(0, 12)}: ${proofError}`);
      return null;
    }

    // Rate limit check
    if (!this.checkRateLimit(peerId)) {
      console.log(`[emission-witness] Rate limited: ${peerId.slice(0, 12)} (${RATE_LIMIT_PER_HOUR}/hour)`);
      return null;
    }

    // Anti-spoofing: proposer must be a known peer or ourselves
    if (peerId !== this.localPeerId) {
      const peerCount = this.network?.getPeerCount() ?? 0;
      const knownPeers = this.network?.getPeers().map(p => p.peerId) ?? [];
      if (peerCount > 0 && !knownPeers.includes(peerId)) {
        console.log(`[emission-witness] Anti-spoof: unknown peer ${peerId.slice(0, 12)}`);
        return null;
      }
    }

    const now = Date.now();
    const proposal: EmissionProposal = {
      id: randomBytes(16).toString('hex'),
      peerId,
      workType,
      workProof,
      amount: 0, // will be filled on finalization by ledger
      timestamp: now,
      expiresAt: now + PROPOSAL_TIMEOUT_MS,
      status: 'pending',
      witnesses: [],
    };

    // Record rate limit
    this.recordProposal(peerId);

    this.pending.set(proposal.id, proposal);

    // Broadcast to network
    await this.broadcastProposal(proposal);

    // Bootstrap fallback: if network has fewer than BOOTSTRAP_NODE_THRESHOLD
    // peers, auto-approve immediately (single-node or tiny network)
    const peerCount = this.network?.getPeerCount() ?? 0;
    if (peerCount < BOOTSTRAP_NODE_THRESHOLD) {
      // Bootstrap auto-approve daily cap (#27): max BOOTSTRAP_DAILY_CAP Lux/day
      // Use a conservative estimate for the amount (highest single reward = 25 Lux for GUEST_WELCOME)
      const estimatedAmount = 25; // conservative estimate before finalization
      if (this.wouldExceedBootstrapCap(estimatedAmount)) {
        console.log(`[emission-witness] Bootstrap daily cap reached (${this.dailyBootstrapLux}/${BOOTSTRAP_DAILY_CAP} Lux). Proposal ${proposal.id.slice(0, 12)} will wait for witnesses.`);
        // Don't auto-approve — let it wait for real witnesses or expire
      } else {
        this.finalizeProposal(proposal, true /* isBootstrap */);
      }
    }

    return proposal;
  }

  // ── Handle incoming GossipSub messages ───────────────────

  /**
   * Called by the network layer when a message arrives on 'pando/emissions'.
   */
  handleMessage(payload: any, fromPeerId: string): void {
    try {
      if (!payload) return;
      const msg = payload as EmissionGossipMessage;

      if (msg.kind === 'proposal' && msg.proposal) {
        this.handleRemoteProposal(msg.proposal, fromPeerId);
      } else if (msg.kind === 'attestation' && msg.attestation) {
        this.handleRemoteAttestation(msg.attestation, fromPeerId).catch(e => console.warn(`[emission-witness] handleRemoteAttestation error: ${(e as Error).message?.slice(0, 100)}`));
      }
    } catch (err: any) {
      console.error(`[emission-witness] handleMessage error: ${err.message}`);
    }
  }

  /**
   * When a remote node proposes an emission, validate and attest.
   */
  private handleRemoteProposal(proposal: EmissionProposal, fromPeerId: string): void {
    // Skip our own proposals (GossipSub echo)
    if (proposal.peerId === this.localPeerId) return;

    // Anti-spoofing: proposal.peerId must match fromPeerId
    if (proposal.peerId !== fromPeerId) {
      console.log(`[emission-witness] Anti-spoof: proposal peerId mismatch (${proposal.peerId.slice(0, 12)} != ${fromPeerId.slice(0, 12)})`);
      return;
    }

    // Work proof validation (#26) — reject remote proposals with invalid work proofs
    const proofError = this.validateWorkProof(proposal.workProof);
    if (proofError) {
      console.log(`[emission-witness] Rejecting remote proposal from ${fromPeerId.slice(0, 12)}: ${proofError}`);
      return;
    }

    // Check expiry
    if (Date.now() > proposal.expiresAt) {
      return;
    }

    // Rate limit check on the remote peer
    if (!this.checkRateLimit(fromPeerId)) {
      console.log(`[emission-witness] Remote peer rate limited: ${fromPeerId.slice(0, 12)}`);
      return;
    }
    this.recordProposal(fromPeerId);

    // Store proposal if we don't have it
    if (!this.pending.has(proposal.id)) {
      this.pending.set(proposal.id, {
        ...proposal,
        witnesses: [],
        status: 'pending',
      });
    }

    // Auto-attest (we are a witness)
    this.attestProposal(proposal.id, true).catch(() => {});
  }

  /**
   * When a remote witness attestation arrives, apply it to the proposal.
   */
  private async handleRemoteAttestation(attestation: WitnessAttestation, fromPeerId: string): Promise<void> {
    // Attestation peerId must match sender
    if (attestation.witnessPeerId !== fromPeerId) {
      console.log(`[emission-witness] Attestation peerId mismatch`);
      return;
    }

    // Reject unsigned attestations from remote peers
    if (!attestation.signature) {
      console.warn(`[emission-witness] REJECTED unsigned attestation from ${fromPeerId.slice(0, 12)}...`);
      return;
    }

    // Verify Ed25519 signature against witness's public key
    try {
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const { verifySignature } = await import('@pando/shared');
      const peerIdObj = peerIdFromString(attestation.witnessPeerId);
      if (!peerIdObj.publicKey?.raw) {
        console.warn(`[emission-witness] REJECTED attestation: cannot extract public key from ${attestation.witnessPeerId.slice(0, 12)}...`);
        return;
      }
      // Reconstruct canonical message used during signing
      const canonicalMessage = {
        type: 'attestation' as any,
        from: attestation.witnessPeerId,
        timestamp: attestation.timestamp,
        payload: { proposalId: attestation.proposalId, approved: attestation.approved, witnessPeerId: attestation.witnessPeerId },
      };
      const valid = await verifySignature(canonicalMessage, attestation.signature, peerIdObj.publicKey.raw);
      if (!valid) {
        console.warn(`[emission-witness] REJECTED attestation: invalid signature from ${attestation.witnessPeerId.slice(0, 12)}...`);
        return;
      }
    } catch (err: any) {
      console.warn(`[emission-witness] REJECTED attestation: signature verification error — ${err.message?.slice(0, 80)}`);
      return;
    }

    const proposal = this.pending.get(attestation.proposalId);
    if (!proposal) return;
    if (proposal.status !== 'pending') return;

    // Anti-replay: deduplicate
    const attestKey = `${attestation.witnessPeerId}:${attestation.proposalId}`;
    if (this.processedAttestations.has(attestKey)) return;
    this.processedAttestations.add(attestKey);

    // Witness must not be the proposer (independent witnesses)
    if (attestation.witnessPeerId === proposal.peerId) return;

    // Add attestation
    proposal.witnesses.push(attestation);

    // Check quorum
    const approvals = proposal.witnesses.filter(w => w.approved).length;
    if (approvals >= QUORUM_REQUIRED && proposal.status === 'pending') {
      this.finalizeProposal(proposal);
    }
  }

  // ── Attest (witness) a proposal ──────────────────────────

  /**
   * Create and broadcast an attestation for a given proposal.
   */
  async attestProposal(proposalId: string, approved: boolean): Promise<WitnessAttestation | null> {
    const proposal = this.pending.get(proposalId);
    if (!proposal) return null;
    if (proposal.status !== 'pending') return null;

    // We can't witness our own proposals
    if (proposal.peerId === this.localPeerId) return null;

    // Check if we already attested
    const attestKey = `${this.localPeerId}:${proposalId}`;
    if (this.processedAttestations.has(attestKey)) return null;

    // Create attestation with Ed25519 signature
    const attestation: WitnessAttestation = {
      witnessPeerId: this.localPeerId,
      proposalId,
      approved,
      signature: await this.signAttestation(proposalId, approved),
      timestamp: Date.now(),
    };

    this.processedAttestations.add(attestKey);

    // Apply locally
    proposal.witnesses.push(attestation);

    // Check quorum
    const approvals = proposal.witnesses.filter(w => w.approved).length;
    if (approvals >= QUORUM_REQUIRED && proposal.status === 'pending') {
      this.finalizeProposal(proposal);
    }

    // Broadcast attestation to network
    await this.broadcastAttestation(attestation);

    return attestation;
  }

  // ── Finalize ─────────────────────────────────────────────

  private finalizeProposal(proposal: EmissionProposal, isBootstrap = false): void {
    if (proposal.status !== 'pending') return;

    // Daily emission cap check (#25): reject if today's total would exceed DAILY_EMISSION_CAP
    // Use a conservative estimate before minting (actual amount determined by ledger)
    const estimatedAmount = 25; // conservative max per single emission
    if (this.wouldExceedDailyCap(estimatedAmount)) {
      console.log(`[emission-witness] DAILY_EMISSION_CAP reached (${this.dailyEmittedLux}/${DAILY_EMISSION_CAP} Lux today). Rejecting proposal ${proposal.id.slice(0, 12)}.`);
      proposal.status = 'rejected';
      this.totalRejected++;
      this.pending.delete(proposal.id);
      this.history.push(proposal);
      if (this.history.length > MAX_HISTORY) {
        this.history.shift();
      }
      return;
    }

    proposal.status = 'approved';
    proposal.finalizedAt = Date.now();
    this.totalApproved++;

    // Only the proposing node actually mints the Lux
    if (proposal.peerId === this.localPeerId && this.emitCallback) {
      try {
        const tx = this.emitCallback(proposal.peerId, proposal.workType, proposal.workProof);
        if (tx) {
          proposal.amount = tx.amount;
          proposal.transactionId = tx.id;
          this.totalLuxEmitted += tx.amount;
          this.recordDailyEmission(tx.amount, isBootstrap);
          console.log(`[emission-witness] Finalized: +${tx.amount} Lux for ${proposal.workType} (${proposal.witnesses.length} witnesses${isBootstrap ? ', bootstrap' : ''})`);
        }
      } catch (err: any) {
        console.error(`[emission-witness] Finalize error: ${err.message}`);
        proposal.status = 'rejected';
        this.totalApproved--;
        this.totalRejected++;
      }
    }

    // Move from pending to history
    this.pending.delete(proposal.id);
    this.history.push(proposal);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }
  }

  // ── Broadcast helpers ────────────────────────────────────

  private async broadcastProposal(proposal: EmissionProposal): Promise<void> {
    if (!this.network) return;
    const message: EmissionGossipMessage = {
      kind: 'proposal',
      proposal,
    };
    try {
      await this.network.publishToTopic(TOPIC_EMISSIONS, {
        type: 'emission_witness' as any,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: message,
      } as any);
    } catch {
      // No peers — that's ok
    }
  }

  private async broadcastAttestation(attestation: WitnessAttestation): Promise<void> {
    if (!this.network) return;
    const message: EmissionGossipMessage = {
      kind: 'attestation',
      attestation,
    };
    try {
      await this.network.publishToTopic(TOPIC_EMISSIONS, {
        type: 'emission_witness' as any,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: message,
      } as any);
    } catch {
      // No peers — that's ok
    }
  }

  // ── Ed25519 signing ──────────────────────────────────────

  private async signAttestation(proposalId: string, approved: boolean): Promise<string> {
    if (!this.localPrivateKey) return '';
    try {
      // Use the shared signMessage utility pattern — sign canonical JSON of attestation data
      const { signMessage } = await import('@pando/shared');
      const canonicalMessage = {
        type: 'attestation' as any,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: { proposalId, approved, witnessPeerId: this.localPeerId },
      };
      return await signMessage(canonicalMessage, this.localPrivateKey);
    } catch {
      return '';
    }
  }

  // ── Rate limiting ────────────────────────────────────────

  private checkRateLimit(peerId: string): boolean {
    const now = Date.now();
    const timestamps = this.rateLimits.get(peerId) || [];
    // Remove old entries outside the window
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    return recent.length < RATE_LIMIT_PER_HOUR;
  }

  private recordProposal(peerId: string): void {
    const now = Date.now();
    const timestamps = this.rateLimits.get(peerId) || [];
    const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    this.rateLimits.set(peerId, recent);
    this.saveRateLimits();
  }

  private loadRateLimits(): void {
    try {
      if (existsSync(this.rateLimitsFilePath)) {
        const raw = readFileSync(this.rateLimitsFilePath, 'utf-8');
        const parsed: Record<string, { count: number; windowStart: number }> = JSON.parse(raw);
        const now = Date.now();
        for (const [peerId, entry] of Object.entries(parsed)) {
          // Only load entries still within the rate limit window
          if (now - entry.windowStart < RATE_LIMIT_WINDOW_MS) {
            // Reconstruct timestamps: spread `count` entries starting from windowStart
            const timestamps: number[] = [];
            for (let i = 0; i < entry.count; i++) {
              timestamps.push(entry.windowStart + i);
            }
            this.rateLimits.set(peerId, timestamps);
          }
        }
      }
    } catch {
      // Degrade gracefully — start with empty rate limits
    }
  }

  private saveRateLimits(): void {
    try {
      const dir = dirname(this.rateLimitsFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const now = Date.now();
      const data: Record<string, { count: number; windowStart: number }> = {};
      for (const [peerId, timestamps] of this.rateLimits) {
        const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (recent.length > 0) {
          data[peerId] = { count: recent.length, windowStart: Math.min(...recent) };
        }
      }
      writeFileSync(this.rateLimitsFilePath, JSON.stringify(data, null, 2));
    } catch {
      // Degrade gracefully — rate limits will be in-memory only
    }
  }

  // ── Cleanup ──────────────────────────────────────────────

  private cleanup(): void {
    const now = Date.now();
    for (const [id, proposal] of this.pending) {
      if (now > proposal.expiresAt) {
        proposal.status = 'expired';
        this.totalExpired++;
        this.pending.delete(id);
        this.history.push(proposal);
        if (this.history.length > MAX_HISTORY) {
          this.history.shift();
        }
      }
    }

    // Clean up old rate limit entries
    for (const [peerId, timestamps] of this.rateLimits) {
      const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
      if (recent.length === 0) {
        this.rateLimits.delete(peerId);
      } else {
        this.rateLimits.set(peerId, recent);
      }
    }

    // Clean up old attestation keys (keep last hour)
    if (this.processedAttestations.size > 10000) {
      this.processedAttestations.clear();
    }
  }

  // ── Query methods (for API endpoints) ────────────────────

  getPending(): EmissionProposal[] {
    return Array.from(this.pending.values());
  }

  getHistory(limit = 50): EmissionProposal[] {
    return this.history.slice(-limit).reverse();
  }

  getStats(): EmissionStats {
    const now = Date.now();
    const localTimestamps = this.rateLimits.get(this.localPeerId) || [];
    const proposalsThisHour = localTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS).length;
    const peerCount = this.network?.getPeerCount() ?? 0;

    return {
      totalProposals: this.totalApproved + this.totalRejected + this.totalExpired + this.pending.size,
      totalApproved: this.totalApproved,
      totalRejected: this.totalRejected,
      totalExpired: this.totalExpired,
      pendingCount: this.pending.size,
      totalLuxEmitted: this.totalLuxEmitted,
      proposalsThisHour,
      rateLimitPerHour: RATE_LIMIT_PER_HOUR,
      quorumRequired: QUORUM_REQUIRED,
      bootstrapFallback: peerCount < BOOTSTRAP_NODE_THRESHOLD,
    };
  }
}
