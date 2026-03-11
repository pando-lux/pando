/**
 * Governance Layer — decentralized proposals, discussion, and voting.
 *
 * Agents propose changes, discuss them, vote, and reach consensus.
 * All governance messages broadcast via GossipSub so every node sees everything.
 * Proposals + votes are persisted to SQLite (ledger.db) and synced in-memory.
 *
 * This is how agents "talk to each other" and make collective decisions.
 *
 * Phase 30: AI-Powered Governance — proposal staking & reviewer selection.
 *
 * // KB: governance_reviewers and governance_reviews stripped in Phase 6. Phase 30 AI reviewer selection removed — too complex for 4-node dev mesh.
 */

import { createHash, randomBytes } from 'node:crypto';
import { GitOps } from '../core/git-ops.js';
import type Database from 'better-sqlite3';
import type { PandoNetwork } from './network.js';
import type { PandoMessage, GovernanceProposal, GovernanceComment, GovernanceVote, GovernanceDecision, VoteChoice, AgentHello, AgentCapabilities, Transaction, ActivityRecord, ModelAttestation, NodeIdentity, WeightedVoteResult, ProposalCategory, UpgradePayload } from '@pando/shared';
import { MessageType, WorkType, verifySignature } from '@pando/shared';
import { debug } from '../logger.js';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromString } from '@libp2p/peer-id';
import { toString as uint8ArrayToString } from 'uint8arrays';
/** Minimal interfaces — avoids importing core/platform from kernel */
interface ReputationGovernanceLike {
  applyWeighting(votes: any[], peerCount: number): WeightedVoteResult;
}
interface PaymentGateLike {
  canAfford(peerId: string, amount: number): boolean;
  holdPayment(peerId: string, taskId: string, amount: number): any;
  refundPayment(holdId: string): boolean;
  releasePayment(holdId: string, recipient: string): boolean;
}
interface AgentDbLike {
  logGovernanceCheck(proposalId: string, checkName: string, result: string, reason?: string, changedFiles?: number, linesChanged?: number): void;
}
interface EngineAdapterLike {
  reviewDiff(diff: string, description: string): Promise<{ safe: boolean; risks: string[]; recommendation: string }>;
}

export const TOPIC_GOVERNANCE = 'pando/governance';
export const TOPIC_AGENT = 'pando/agents';

// ── Phase 30: Proposal Staking Constants ────────────────────────────────────

/** Standard proposal stake cost in Lux. */
export const PROPOSAL_STAKE_LUX = 10;

/** Emergency (expedited review) proposal stake cost in Lux. */
export const EMERGENCY_STAKE_LUX = 50;

/** Cost to amend an existing proposal (non-refundable). */
export const AMENDMENT_COST_LUX = 2;

/** Accounts with balance below this threshold get their first proposal free. */
export const FREE_TIER_THRESHOLD = 100;

/** Minimum reputation score required to be a reviewer candidate. */
export const MIN_REVIEWER_REPUTATION = 0.5;

/** Candidacy window duration in milliseconds (5 minutes). */
export const CANDIDACY_WINDOW_MS = 5 * 60 * 1000;

/** Maximum age (in ms) for proposals received during sync. Proposals older than this are skipped. (7 days) */
export const SYNC_PROPOSAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ── Phase 73: P2P Self-Upgrade Auto-Approve ──────────────────────────────────
// KB: Auto-approve threshold = 8 peers. In dev mode (<=8 peers), governance proposals pass instantly.
// KB: Security validation still runs.
const DEFAULT_UPGRADE_AUTO_APPROVE_THRESHOLD = 8;

// ── Phase 30.6: Meta-Governance Protection Constants ──────────────────────────

/** Voting period for governance_change proposals in hours. */
export const GOVERNANCE_CHANGE_VOTING_HOURS = 24;

/** Approval threshold for governance_change proposals (80%). */
export const GOVERNANCE_CHANGE_APPROVAL_THRESHOLD = 0.8;

/** Minimum vote count required for governance_change proposals. */
export const GOVERNANCE_CHANGE_MIN_VOTES = 5;

/** Standard voting period in hours. */
export const STANDARD_VOTING_HOURS = 1;

/** Human-only mode voting period in hours (Phase 30.5). */
export const HUMAN_ONLY_VOTING_HOURS = 48;

/** Emergency proposal voting period in hours. */
export const EMERGENCY_VOTING_HOURS = 0.5;

/** Sanitize user input to prevent stored XSS in governance data. */
function sanitizeText(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Create a model attestation for a governance vote.
 * Uses SHA-256 for the attestation hash and Ed25519 to sign it.
 */
export async function createAttestation(
  proposalId: string,
  choice: string,
  modelId: string,
  modelProvider: string,
  privateKeyBytes: Uint8Array,
): Promise<ModelAttestation> {
  const salt = randomBytes(16).toString('hex');
  const timestamp = Date.now();
  const hashInput = `${proposalId}${choice}${modelId}${timestamp}${salt}`;
  const attestationHash = createHash('sha256').update(hashInput).digest('hex');

  // Sign the attestation hash with Ed25519
  const pk = privateKeyFromProtobuf(privateKeyBytes);
  const data = new TextEncoder().encode(attestationHash);
  const sig = await pk.sign(data);
  const nodeSignature = uint8ArrayToString(sig, 'base64');

  return {
    modelId,
    modelProvider,
    attestationHash,
    salt,
    nodeSignature,
  };
}

export class GovernanceSync {
  private network: PandoNetwork;
  private localPeerId: string;
  private db: Database.Database;
  private rewardWork: ((peerId: string, workType: WorkType, workProof: string) => Transaction) | null = null;
  private broadcastActivityFn: ((record: ActivityRecord) => Promise<void>) | null = null;

  // In-memory caches (loaded from SQLite on start, updated on new messages)
  private proposals: Map<string, GovernanceProposal> = new Map();
  private comments: Map<string, GovernanceComment[]> = new Map(); // proposalId → comments
  private votes: Map<string, Map<string, GovernanceVote>> = new Map(); // proposalId → voter → vote
  private decisions: Map<string, GovernanceDecision> = new Map();

  // Dedup
  private processedIds: Set<string> = new Set();

  // Track rewarded votes to prevent double-emission on dedup
  private rewardedVotes: Set<string> = new Set();

  // Cleanup interval handle
  private archiveInterval: ReturnType<typeof setInterval> | null = null;

  // Maximum number of in-memory proposals before eviction
  private static readonly MAX_PROPOSALS = 500;

  // Prepared statements (initialized in start)
  private stmtInsertProposal!: Database.Statement;
  private stmtUpdateProposalStatus!: Database.Statement;
  private stmtInsertComment!: Database.Statement;
  private stmtUpsertVote!: Database.Statement;
  private stmtInsertDecision!: Database.Statement;

  // Callback for notifying agents of new governance activity
  private onProposalCallback: ((proposal: GovernanceProposal) => void) | null = null;
  private onAgentMessageCallback: ((from: string, content: string) => void) | null = null;
  private onAgentHelloCallback: ((hello: AgentHello) => void) | null = null;

  // Callbacks for SSE real-time event push
  private onVoteCallback: ((vote: GovernanceVote, proposalTitle: string) => void) | null = null;
  private onCommentCallback: ((comment: GovernanceComment) => void) | null = null;
  private onDecisionCallback: ((decision: GovernanceDecision, proposalTitle: string) => void) | null = null;

  // Track known agent peers (peerId → latest hello) — in-memory only
  private knownAgents: Map<string, AgentHello> = new Map();

  // Track agent capabilities (peerId → latest capabilities) — in-memory only
  private peerCapabilities: Map<string, AgentCapabilities> = new Map();

  // Phase 12.4: Reputation-weighted governance (optional — set via setReputationGovernance)
  private reputationGovernance: ReputationGovernanceLike | null = null;

  // Phase 30: Payment gate for proposal staking (optional — set via setPaymentGate)
  private paymentGate: PaymentGateLike | null = null;

  // Governance audit logging (optional — set via setAgentDb)
  private agentDb: AgentDbLike | null = null;

  // AI review via EngineAdapter (Layer 5 — optional)
  private engineAdapter: EngineAdapterLike | null = null;

  // Governance hardening: Ed25519 private key for signing proposals
  private identityPrivateKey: Uint8Array | null = null;

  // Phase 73: P2P Self-Upgrade auto-approve threshold
  private upgradeAutoApproveThreshold: number = DEFAULT_UPGRADE_AUTO_APPROVE_THRESHOLD;
  private onUpgradeApprovedCallback: ((proposal: GovernanceProposal) => void) | null = null;

  constructor(network: PandoNetwork, localPeerId: string, db: Database.Database) {
    this.network = network;
    this.localPeerId = localPeerId;
    this.db = db;
  }

  /** Set the reward callback (called from PandoNode after ledger is available). */
  setRewardCallback(fn: (peerId: string, workType: WorkType, workProof: string) => Transaction): void {
    this.rewardWork = fn;
  }

  /** Set the activity broadcaster (called from PandoNode after sync is available). */
  setActivityBroadcaster(fn: (record: ActivityRecord) => Promise<void>): void {
    this.broadcastActivityFn = fn;
  }

  /** Set the reputation-weighted governance integration (Phase 12.4). */
  setReputationGovernance(rg: ReputationGovernanceLike): void {
    this.reputationGovernance = rg;
    console.log('[governance] Reputation-weighted governance enabled');
  }

  /** Get the reputation-weighted governance integration (Phase 12.4). */
  getReputationGovernance(): ReputationGovernanceLike | null {
    return this.reputationGovernance;
  }

  /** Set the PaymentGate for proposal staking (Phase 30). */
  setPaymentGate(pg: PaymentGateLike): void {
    this.paymentGate = pg;
    console.log('[governance] PaymentGate connected — proposal staking enabled');
  }

  /** Set the AgentDatabase for governance audit logging. */
  setAgentDb(db: AgentDbLike): void {
    this.agentDb = db;
  }

  /** Set the EngineAdapter for AI-powered governance review (Layer 5). */
  setEngineAdapter(adapter: EngineAdapterLike): void {
    this.engineAdapter = adapter;
    console.log('[governance] EngineAdapter connected — AI review enabled (Layer 5)');
  }

  /** Set the node's Ed25519 private key for signing governance proposals. */
  setIdentityPrivateKey(key: Uint8Array): void {
    this.identityPrivateKey = key;
  }

  // ── Phase 73: Upgrade auto-approve configuration ──

  setUpgradeAutoApproveThreshold(threshold: number): void {
    this.upgradeAutoApproveThreshold = threshold;
    console.log(`[governance] Upgrade auto-approve threshold set to ${threshold}`);
  }

  getUpgradeAutoApproveThreshold(): number {
    return this.upgradeAutoApproveThreshold;
  }

  onUpgradeApproved(callback: (proposal: GovernanceProposal) => void): void {
    this.onUpgradeApprovedCallback = callback;
  }

  /**
   * Get weighted vote result for a proposal (Phase 12.4).
   * Falls back to simple counting if reputation governance is not set.
   */
  getWeightedVoteResult(proposalId: string): WeightedVoteResult | null {
    if (!this.reputationGovernance) return null;

    const votes = this.getVotes(proposalId);
    if (votes.length === 0) return null;

    const peerCount = this.network.getPeerCount() + 1;
    return this.reputationGovernance.applyWeighting(votes, peerCount);
  }

  /** Broadcast a governance activity record to the network. */
  private broadcastGovernanceActivity(action: ActivityRecord['action'], summary: string, proposalId?: string): void {
    if (!this.broadcastActivityFn) return;
    const safeSummary = sanitizeText(summary);
    const record: ActivityRecord = {
      id: createHash('sha256').update(`${this.localPeerId}:${Date.now()}:${action}:${safeSummary}`).digest('hex'),
      agentId: this.localPeerId,
      nodeId: this.localPeerId,
      agentRole: 'node',
      agentTier: 1,
      modelId: 'pando-node',
      action,
      timestamp: Date.now(),
      summary: safeSummary,
      proposalId,
      signature: 'pending',
    };
    this.broadcastActivityFn(record).catch(() => {});
  }

  async start(): Promise<void> {
    // === Migrations FIRST (must run before prepare() calls) ===

    // Migration: add model_attestation column if it doesn't exist
    const voteCols = this.db.pragma('table_info(governance_votes)') as any[];
    if (!voteCols.some((c: any) => c.name === 'model_attestation')) {
      this.db.exec("ALTER TABLE governance_votes ADD COLUMN model_attestation TEXT NOT NULL DEFAULT ''");
    }

    // Phase 30 migration: add staking columns to governance_proposals
    const proposalCols = this.db.pragma('table_info(governance_proposals)') as any[];
    if (!proposalCols.some((c: any) => c.name === 'stake_amount')) {
      this.db.exec("ALTER TABLE governance_proposals ADD COLUMN stake_amount REAL DEFAULT 0");
    }
    if (!proposalCols.some((c: any) => c.name === 'stake_hold_id')) {
      this.db.exec("ALTER TABLE governance_proposals ADD COLUMN stake_hold_id TEXT DEFAULT ''");
    }
    if (!proposalCols.some((c: any) => c.name === 'category')) {
      this.db.exec("ALTER TABLE governance_proposals ADD COLUMN category TEXT DEFAULT ''");
    }
    if (!proposalCols.some((c: any) => c.name === 'reviewer_count')) {
      this.db.exec("ALTER TABLE governance_proposals ADD COLUMN reviewer_count INTEGER DEFAULT 0");
    }

    // Phase 30.5 migration: add human_only column to governance_proposals
    if (!proposalCols.some((c: any) => c.name === 'human_only')) {
      this.db.exec("ALTER TABLE governance_proposals ADD COLUMN human_only INTEGER DEFAULT 0");
    }

    // Phase 73 migration: add upgrade_payload column (stores commitHash + description for auto-upgrade proposals)
    if (!proposalCols.some((c: any) => c.name === 'upgrade_payload')) {
      this.db.exec("ALTER TABLE governance_proposals ADD COLUMN upgrade_payload TEXT DEFAULT ''");
    }

    // Governance hardening migration: add proposer_signature column
    if (!proposalCols.some((c: any) => c.name === 'proposer_signature')) {
      this.db.exec("ALTER TABLE governance_proposals ADD COLUMN proposer_signature TEXT DEFAULT ''");
    }

    // === Prepare SQL statements (after all migrations) ===
    this.stmtInsertProposal = this.db.prepare(
      `INSERT OR IGNORE INTO governance_proposals (id, title, description, proposed_by, created_at, voting_ends_at, status, stake_amount, stake_hold_id, category, reviewer_count, human_only, upgrade_payload, proposer_signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.stmtUpdateProposalStatus = this.db.prepare(
      `UPDATE governance_proposals SET status = ? WHERE id = ?`
    );
    this.stmtInsertComment = this.db.prepare(
      `INSERT OR IGNORE INTO governance_comments (id, proposal_id, from_peer, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );

    this.stmtUpsertVote = this.db.prepare(
      `INSERT OR REPLACE INTO governance_votes (proposal_id, voter, choice, reasoning, created_at, model_attestation)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    this.stmtInsertDecision = this.db.prepare(
      `INSERT OR REPLACE INTO governance_decisions (proposal_id, outcome, votes_for, votes_against, votes_abstain, decided_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    // Load persisted governance data into memory
    this.loadFromDatabase();

    // Subscribe to governance topic
    await this.network.subscribeTopic(
      TOPIC_GOVERNANCE,
      this.handleGovernanceMessage.bind(this)
    );

    // Subscribe to agent communication topic
    await this.network.subscribeTopic(
      TOPIC_AGENT,
      this.handleAgentMessage.bind(this)
    );

    // Run initial cleanup of expired proposals and enforce cap
    const archivedOnStart = this.archiveExpiredProposals();
    if (archivedOnStart > 0) {
      console.log(`[governance] Startup cleanup: archived ${archivedOnStart} expired proposals`);
    }

    // Schedule hourly archive cleanup (every 60 minutes)
    this.archiveInterval = setInterval(() => {
      this.archiveExpiredProposals();
    }, 60 * 60_000);

    const proposalCount = this.proposals.size;
    console.log(`[governance] Subscribed to ${TOPIC_GOVERNANCE}, ${TOPIC_AGENT} (loaded ${proposalCount} proposals from disk)`);
  }

  /** Load all governance data from SQLite into in-memory caches. */
  private loadFromDatabase(): void {
    // Load proposals
    const rows = this.db.prepare('SELECT * FROM governance_proposals ORDER BY created_at DESC').all() as any[];
    for (const row of rows) {
      const proposal: GovernanceProposal = {
        id: row.id,
        title: row.title,
        description: row.description,
        proposedBy: row.proposed_by,
        createdAt: row.created_at,
        votingEndsAt: row.voting_ends_at,
        status: row.status,
        // Phase 30 fields (may be undefined for pre-Phase-30 proposals)
        ...(row.stake_amount ? { stakeAmount: row.stake_amount } : {}),
        ...(row.stake_hold_id ? { stakeHoldId: row.stake_hold_id } : {}),
        ...(row.category ? { category: row.category } : {}),
        ...(row.reviewer_count ? { reviewerCount: row.reviewer_count } : {}),
        // Phase 30.5: human-only mode
        ...(row.human_only ? { humanOnly: true } : {}),
        // Phase 73: upgrade payload (commitHash + description for auto-upgrade proposals)
        ...(row.upgrade_payload ? (() => { try { return { upgradePayload: JSON.parse(row.upgrade_payload) }; } catch { return {}; } })() : {}),
        // Governance hardening: include proposer signature for sync/verification
        ...(row.proposer_signature ? { proposerSignature: row.proposer_signature } : {}),
      };
      this.proposals.set(proposal.id, proposal);
      this.processedIds.add(`proposal:${proposal.id}`);
    }

    // Load comments
    const commentRows = this.db.prepare('SELECT * FROM governance_comments ORDER BY created_at ASC').all() as any[];
    for (const row of commentRows) {
      const comment: GovernanceComment = {
        id: row.id,
        proposalId: row.proposal_id,
        from: row.from_peer,
        content: row.content,
        createdAt: row.created_at,
      };
      const existing = this.comments.get(comment.proposalId) || [];
      existing.push(comment);
      this.comments.set(comment.proposalId, existing);
      this.processedIds.add(`comment:${comment.id}`);
    }

    // Load votes
    const voteRows = this.db.prepare('SELECT * FROM governance_votes').all() as any[];
    for (const row of voteRows) {
      const vote: GovernanceVote = {
        proposalId: row.proposal_id,
        voter: row.voter,
        choice: row.choice,
        reasoning: row.reasoning,
        createdAt: row.created_at,
      };
      // Deserialize model attestation if present
      if (row.model_attestation && row.model_attestation !== '') {
        try { vote.modelAttestation = JSON.parse(row.model_attestation); } catch {}
      }
      const proposalVotes = this.votes.get(vote.proposalId) || new Map();
      proposalVotes.set(vote.voter, vote);
      this.votes.set(vote.proposalId, proposalVotes);
      this.processedIds.add(`vote:${vote.proposalId}:${vote.voter}`);
    }

    // Load decisions
    const decisionRows = this.db.prepare('SELECT * FROM governance_decisions').all() as any[];
    for (const row of decisionRows) {
      const decision: GovernanceDecision = {
        proposalId: row.proposal_id,
        outcome: row.outcome,
        votesFor: row.votes_for,
        votesAgainst: row.votes_against,
        votesAbstain: row.votes_abstain,
        decidedAt: row.decided_at,
      };
      this.decisions.set(decision.proposalId, decision);
      this.processedIds.add(`decision:${decision.proposalId}`);
    }
  }

  // ── Message Handlers ──

  private handleGovernanceMessage(message: PandoMessage): void {
    switch (message.type) {
      case MessageType.GOVERNANCE_PROPOSAL:
        this.handleProposal(message).catch(e => console.warn(`[governance] handleProposal error: ${(e as Error).message?.slice(0, 100)}`));
        break;
      case MessageType.GOVERNANCE_COMMENT:
        this.handleComment(message).catch(e => console.warn(`[governance] handleComment error: ${(e as Error).message?.slice(0, 100)}`));
        break;
      case MessageType.GOVERNANCE_VOTE:
        this.handleVote(message).catch(e => console.warn(`[governance] handleVote error: ${(e as Error).message?.slice(0, 100)}`));
        break;
      case MessageType.GOVERNANCE_DECISION:
        this.handleDecision(message);
        break;
    }
  }

  private handleAgentMessage(message: PandoMessage): void {
    if (message.from === this.localPeerId) return; // Skip own messages

    if (message.type === MessageType.AGENT_HELLO) {
      const hello = message.payload as AgentHello;
      const peerId = hello.peerId || message.from;
      console.log(`[agent-p2p] Hello from ${peerId.slice(0, 16)}... (tier: ${hello.agentTier || 'unknown'}, capabilities: ${hello.capabilities?.join(', ') || 'none'})`);

      // Store the agent peer
      this.knownAgents.set(peerId, hello);
      this.onAgentHelloCallback?.(hello);
    } else if (message.type === MessageType.AGENT_CAPABILITIES) {
      const caps = message.payload as AgentCapabilities;
      const peerId = caps.peerId || message.from;
      console.log(`[agent-p2p] Capabilities from ${peerId.slice(0, 16)}... (languages: ${caps.languages?.join(', ') || 'none'}, tools: ${caps.tools?.join(', ') || 'none'}, spec: ${caps.specialization?.join(', ') || 'none'})`);
      this.peerCapabilities.set(peerId, caps);
    } else if (message.type === MessageType.AGENT_MESSAGE) {
      const payload = message.payload as { content: string; to?: string };
      // If addressed to us or broadcast
      if (!payload.to || payload.to === this.localPeerId || payload.to === 'all') {
        console.log(`[agent-p2p] Message from ${message.from.slice(0, 16)}...: ${payload.content?.slice(0, 100)}`);
        this.onAgentMessageCallback?.(message.from, payload.content || '');
      }
    }
  }

  private async handleProposal(message: PandoMessage): Promise<void> {
    const proposal = message.payload as GovernanceProposal;
    if (!proposal?.id || !proposal.title || !proposal.proposedBy) return;

    if (this.processedIds.has(`proposal:${proposal.id}`)) return;
    this.processedIds.add(`proposal:${proposal.id}`);

    // Governance hardening: verify proposal signature
    if (proposal.proposerSignature) {
      try {
        const { verifyProposalSignature } = await import('@pando/shared');
        const valid = await verifyProposalSignature(proposal, proposal.proposerSignature);
        if (!valid) {
          console.warn(`[governance] REJECTED proposal "${proposal.title}" — invalid signature from ${proposal.proposedBy.slice(0, 16)}`);
          this.agentDb?.logGovernanceCheck(proposal.id, 'signature_verification', 'fail', 'Invalid proposer signature');
          return;
        }
        this.agentDb?.logGovernanceCheck(proposal.id, 'signature_verification', 'pass');
      } catch (e: any) {
        console.warn(`[governance] Signature verification error: ${e.message?.slice(0, 100)}`);
      }
    } else if (proposal.category === 'upgrade') {
      // Upgrade proposals MUST be signed — reject unsigned upgrades
      console.warn(`[governance] REJECTED unsigned upgrade proposal "${proposal.title}" from ${proposal.proposedBy.slice(0, 16)}`);
      this.agentDb?.logGovernanceCheck(proposal.id, 'signature_verification', 'fail', 'Unsigned upgrade proposal');
      return;
    }

    // Sanitize remote input
    proposal.title = sanitizeText(proposal.title);
    proposal.description = sanitizeText(proposal.description || '');

    this.proposals.set(proposal.id, proposal);
    this.comments.set(proposal.id, this.comments.get(proposal.id) || []);
    this.votes.set(proposal.id, this.votes.get(proposal.id) || new Map());

    // Persist to SQLite (including Phase 30 staking fields + Phase 73 upgradePayload + signature)
    this.stmtInsertProposal.run(
      proposal.id, proposal.title, proposal.description || '',
      proposal.proposedBy, proposal.createdAt, proposal.votingEndsAt, proposal.status,
      proposal.stakeAmount ?? 0, proposal.stakeHoldId ?? '', proposal.category ?? '', proposal.reviewerCount ?? 0,
      proposal.humanOnly ? 1 : 0,
      proposal.upgradePayload ? JSON.stringify(proposal.upgradePayload) : '',
      proposal.proposerSignature ?? ''
    );

    console.log(`[governance] New proposal: "${proposal.title}" by ${proposal.proposedBy.slice(0, 16)}...${proposal.stakeAmount ? ` (stake: ${proposal.stakeAmount} Lux)` : ''}${proposal.proposerSignature ? ' [signed]' : ''}`);
    this.onProposalCallback?.(proposal);
  }

  private async handleComment(message: PandoMessage): Promise<void> {
    const comment = message.payload as GovernanceComment;
    if (!comment?.id || !comment.proposalId) return;

    if (this.processedIds.has(`comment:${comment.id}`)) return;
    this.processedIds.add(`comment:${comment.id}`);

    // Verify comment author matches message sender (prevent impersonation)
    if (message.from !== comment.from) {
      console.warn(`[governance] REJECTED comment: message.from (${message.from?.slice(0, 16)}) !== comment.from (${comment.from?.slice(0, 16)})`);
      return;
    }
    // Reject unsigned comments from remote peers
    if (comment.from !== this.localPeerId) {
      if (!message.signature) {
        console.warn(`[governance] REJECTED unsigned comment from ${comment.from.slice(0, 16)}...`);
        return;
      }
      try {
        const peerIdObj = peerIdFromString(comment.from);
        if (!peerIdObj.publicKey?.raw) {
          console.warn(`[governance] REJECTED comment: cannot extract public key from peerId ${comment.from.slice(0, 16)}...`);
          return;
        }
        const valid = await verifySignature(message, message.signature, peerIdObj.publicKey.raw);
        if (!valid) {
          console.warn(`[governance] REJECTED comment: invalid signature from ${comment.from.slice(0, 16)}...`);
          return;
        }
      } catch (err: any) {
        console.warn(`[governance] REJECTED comment: signature verification error — ${err.message?.slice(0, 80)}`);
        return;
      }
    }

    // Sanitize remote input
    comment.content = sanitizeText(comment.content || '');

    const existing = this.comments.get(comment.proposalId) || [];
    existing.push(comment);
    this.comments.set(comment.proposalId, existing);

    // Persist to SQLite
    this.stmtInsertComment.run(
      comment.id, comment.proposalId, comment.from, comment.content, comment.createdAt
    );

    console.log(`[governance] Comment on "${comment.proposalId.slice(0, 8)}..." from ${comment.from.slice(0, 16)}...`);
    this.onCommentCallback?.(comment);
  }

  private async handleVote(message: PandoMessage): Promise<void> {
    const vote = message.payload as GovernanceVote;
    if (!vote?.proposalId || !vote.voter) return;

    // Gap #120: Verify vote signature to prevent spoofing via P2P.
    // The message.from must match vote.voter (prevent impersonation).
    if (message.from !== vote.voter) {
      console.warn(`[governance] REJECTED vote: message.from (${message.from?.slice(0, 16)}) !== vote.voter (${vote.voter.slice(0, 16)})`);
      return;
    }
    // Reject unsigned votes from remote peers
    if (vote.voter !== this.localPeerId) {
      if (!message.signature) {
        console.warn(`[governance] REJECTED unsigned vote from ${vote.voter.slice(0, 16)}...`);
        return;
      }
      // Verify Ed25519 signature against voter's public key (extracted from peerId)
      try {
        const peerIdObj = peerIdFromString(vote.voter);
        if (!peerIdObj.publicKey?.raw) {
          console.warn(`[governance] REJECTED vote: cannot extract public key from peerId ${vote.voter.slice(0, 16)}...`);
          return;
        }
        const valid = await verifySignature(message, message.signature, peerIdObj.publicKey.raw);
        if (!valid) {
          console.warn(`[governance] REJECTED vote: invalid signature from ${vote.voter.slice(0, 16)}...`);
          return;
        }
      } catch (err: any) {
        console.warn(`[governance] REJECTED vote: signature verification error — ${err.message?.slice(0, 80)}`);
        return;
      }
    }

    const key = `vote:${vote.proposalId}:${vote.voter}`;
    if (this.processedIds.has(key)) return;
    this.processedIds.add(key);

    // Only one vote per voter per proposal
    const proposalVotes = this.votes.get(vote.proposalId) || new Map();
    proposalVotes.set(vote.voter, vote);
    this.votes.set(vote.proposalId, proposalVotes);

    // Persist to SQLite
    this.stmtUpsertVote.run(
      vote.proposalId, vote.voter, vote.choice, vote.reasoning || '', vote.createdAt,
      vote.modelAttestation ? JSON.stringify(vote.modelAttestation) : ''
    );

    console.log(`[governance] Vote on "${vote.proposalId.slice(0, 8)}..." from ${vote.voter.slice(0, 16)}...: ${vote.choice}`);

    // Fire SSE callback
    const votedProposal = this.proposals.get(vote.proposalId);
    this.onVoteCallback?.(vote, votedProposal?.title || '');

    // Reward the voter for participation (remote votes only — local votes rewarded in castVote)
    if (vote.voter !== this.localPeerId) {
      this.emitVoteReward(vote.voter, vote.proposalId);
    }

    // Check if quorum reached
    this.checkQuorum(vote.proposalId);
  }

  private handleDecision(message: PandoMessage): void {
    const decision = message.payload as GovernanceDecision;
    if (!decision?.proposalId) return;

    if (this.processedIds.has(`decision:${decision.proposalId}`)) return;
    this.processedIds.add(`decision:${decision.proposalId}`);

    this.decisions.set(decision.proposalId, decision);

    // Update proposal status
    const proposal = this.proposals.get(decision.proposalId);
    if (proposal) {
      proposal.status = decision.outcome === 'passed' ? 'passed' : 'rejected';
      this.stmtUpdateProposalStatus.run(proposal.status, proposal.id);

      // Phase 30: Resolve stake for remote decisions on proposals we created
      if (proposal.proposedBy === this.localPeerId) {
        this.resolveProposalStake(decision.proposalId, decision.outcome as 'passed' | 'rejected');
      }
    }

    // Persist decision to SQLite
    this.stmtInsertDecision.run(
      decision.proposalId, decision.outcome,
      decision.votesFor, decision.votesAgainst, decision.votesAbstain,
      decision.decidedAt
    );

    console.log(`[governance] Decision on "${decision.proposalId.slice(0, 8)}...": ${decision.outcome} (${decision.votesFor} for, ${decision.votesAgainst} against)`);

    // Fire SSE callback
    const decidedProposal = this.proposals.get(decision.proposalId);
    this.onDecisionCallback?.(decision, decidedProposal?.title || '');
  }

  // ── Quorum Check ──

  private checkQuorum(proposalId: string): void {
    const proposal = this.proposals.get(proposalId);
    // Phase 30.4: Proposals in 'in_review' status are blocked here (not 'active').
    // The review aggregation will transition them back to 'active' when ready,
    // at which point community votes will be tallied. Small networks (<3 nodes)
    // where no reviewers are assigned skip the review phase entirely.
    if (!proposal || proposal.status !== 'active') return;

    const proposalVotes = this.votes.get(proposalId);
    if (!proposalVotes) return;

    const totalVotes = proposalVotes.size;

    // Phase 30.5: Human-only mode requires minimum 2 votes instead of normal quorum
    // Phase 30.6: governance_change proposals require GOVERNANCE_CHANGE_MIN_VOTES
    let quorum: number;
    if (proposal.category === 'governance_change') {
      const peerCount = this.network.getPeerCount() + 1;
      quorum = Math.min(GOVERNANCE_CHANGE_MIN_VOTES, peerCount);
    } else if (proposal.humanOnly) {
      quorum = 2;
    } else {
      quorum = this.getQuorum();
    }

    // Instant governance for small networks (<10 nodes): any single vote resolves.
    // During early network growth, speed matters more than multi-node review.
    // After 10+ nodes, full quorum rules apply for security.
    const totalNodes = this.network.getPeerCount() + 1; // peers + self
    if (totalNodes < 10) {
      quorum = 1;
    } else if (totalVotes >= totalNodes && totalVotes < quorum) {
      // Early resolution: all known nodes voted but count < computed quorum
      console.log(`[governance] Early resolution: all ${totalNodes} node(s) have voted on "${proposal.title}" (quorum was ${quorum})`);
      quorum = totalNodes;
    }

    if (totalVotes >= quorum) {
      // #22: Use reputation-weighted voting when available, fall back to simple counting
      let votesFor = 0;
      let votesAgainst = 0;
      let votesAbstain = 0;
      let outcome: 'passed' | 'rejected';

      const weightedResult = this.getWeightedVoteResult(proposalId);
      if (weightedResult) {
        // Use weighted vote result
        votesFor = Math.round(weightedResult.approveWeight);
        votesAgainst = Math.round(weightedResult.rejectWeight);
        votesAbstain = Math.round(weightedResult.abstainWeight);

        const deciding = weightedResult.approveWeight + weightedResult.rejectWeight;
        if (deciding === 0) return; // All abstained — wait for more votes

        if (proposal.category === 'governance_change') {
          const approvalRatio = weightedResult.approveWeight / deciding;
          outcome = approvalRatio >= GOVERNANCE_CHANGE_APPROVAL_THRESHOLD ? 'passed' : 'rejected';
        } else {
          outcome = weightedResult.approveWeight > weightedResult.rejectWeight ? 'passed' : 'rejected';
        }
      } else {
        // Fallback: simple 1-per-peer counting (no reputation governance available)
        for (const vote of proposalVotes.values()) {
          if (vote.choice === 'approve') votesFor++;
          else if (vote.choice === 'reject') votesAgainst++;
          else votesAbstain++;
        }

        // Phase 30.6: governance_change proposals need 80% approval threshold
        const deciding = votesFor + votesAgainst;
        if (deciding === 0) return; // All abstained — wait for more votes

        if (proposal.category === 'governance_change') {
          const approvalRatio = votesFor / deciding;
          outcome = approvalRatio >= GOVERNANCE_CHANGE_APPROVAL_THRESHOLD ? 'passed' : 'rejected';
        } else {
          // Simple majority of non-abstain votes
          outcome = votesFor > votesAgainst ? 'passed' : 'rejected';
        }
      }

      const decision: GovernanceDecision = {
        proposalId,
        outcome,
        votesFor,
        votesAgainst,
        votesAbstain,
        decidedAt: Date.now(),
      };

      this.decisions.set(proposalId, decision);
      this.processedIds.add(`decision:${proposalId}`); // Dedup so handleDecision won't re-fire
      proposal.status = outcome === 'passed' ? 'passed' : 'rejected';

      // Persist decision + status update
      this.stmtInsertDecision.run(
        decision.proposalId, decision.outcome,
        decision.votesFor, decision.votesAgainst, decision.votesAbstain,
        decision.decidedAt
      );
      this.stmtUpdateProposalStatus.run(proposal.status, proposal.id);

      // Broadcast decision
      this.broadcastDecision(decision).catch((e: any) => console.warn(`[governance] Decision broadcast failed: ${e.message?.slice(0, 100)}`));

      // Reward proposer if the proposal passed
      if (outcome === 'passed') {
        this.emitProposalReward(proposal.proposedBy, proposal.id, proposal.title);
      }

      // Phase 30: Resolve the proposal's Lux stake
      this.resolveProposalStake(proposalId, outcome);

      console.log(`[governance] QUORUM REACHED on "${proposal.title}": ${outcome}`);

      // Fire decision callback (governance → task pipeline, SSE events)
      this.onDecisionCallback?.(decision, proposal.title);

      // Phase 73: Fire upgrade approval callback
      if (outcome === 'passed' && proposal.category === 'upgrade' && proposal.upgradePayload) {
        this.onUpgradeApprovedCallback?.(proposal);
      }

      // Broadcast activity record for decision
      this.broadcastGovernanceActivity('proposal_decided', `Proposal "${proposal.title}" ${outcome} (${decision.votesFor} for, ${decision.votesAgainst} against)`, proposal.id);
    }
  }

  /** Dynamic quorum based on how many peers we see. */
  private getQuorum(): number {
    const peerCount = this.network.getPeerCount() + 1; // +1 for self
    if (peerCount === 1) return 1; // Solo mode — single vote passes
    if (peerCount <= 10) return Math.max(2, Math.ceil(peerCount * 0.5));
    if (peerCount <= 100) return 5;
    if (peerCount <= 1000) return 10;
    return Math.ceil(peerCount * 0.05);
  }

  // ── Reward Emission ──

  /** Emit Lux reward for casting a vote. Deduped per voter+proposal. */
  private emitVoteReward(voter: string, proposalId: string): void {
    const key = `vote:${proposalId}:${voter}`;
    if (this.rewardedVotes.has(key) || !this.rewardWork) return;
    this.rewardedVotes.add(key);
    try {
      const tx = this.rewardWork(voter, WorkType.VOTE_CAST, `voted on proposal ${proposalId.slice(0, 16)}`);
      console.log(`[governance] Rewarded ${tx.amount} Lux to ${voter.slice(0, 16)}... for voting`);
    } catch (e: any) {
      console.log(`[governance] Could not reward voter ${voter.slice(0, 16)}...: ${e.message}`);
    }
  }

  /** Emit Lux reward for an accepted proposal. */
  private emitProposalReward(proposer: string, proposalId: string, title: string): void {
    if (!this.rewardWork) return;
    try {
      const tx = this.rewardWork(proposer, WorkType.PROPOSAL_ACCEPTED, `proposal accepted: "${title}"`);
      console.log(`[governance] Rewarded ${tx.amount} Lux to ${proposer.slice(0, 16)}... for accepted proposal "${title}"`);
    } catch (e: any) {
      console.log(`[governance] Could not reward proposer ${proposer.slice(0, 16)}...: ${e.message}`);
    }
  }

  // ── Phase 30: Proposal Stake Resolution ──

  /**
   * Resolve a proposal's Lux stake based on the governance decision outcome.
   *
   * - `passed`  → refund stake to proposer (good proposals are free)
   * - `rejected` → burn stake (transfer to NETWORK account)
   * - `expired` with 0 votes → refund stake (nobody reviewed it, not proposer's fault)
   * - `expired` with votes → burn stake (had attention, still failed)
   * - `revision_requested` → hold stake (don't resolve yet — wait for amendment or timeout)
   */
  resolveProposalStake(proposalId: string, outcome: 'passed' | 'rejected' | 'expired' | 'revision_requested'): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return;
    if (!this.paymentGate) return;
    if (!proposal.stakeHoldId) return; // No stake to resolve (free tier or pre-Phase-30)
    if (!proposal.stakeAmount || proposal.stakeAmount <= 0) return;

    switch (outcome) {
      case 'passed': {
        // Refund stake to proposer — good proposals are economically free
        const refunded = this.paymentGate.refundPayment(proposal.stakeHoldId);
        if (refunded) {
          console.log(`[governance] Stake refunded: ${proposal.stakeAmount} Lux to ${proposal.proposedBy.slice(0, 16)}... (proposal passed)`);
        }
        break;
      }

      case 'rejected': {
        // Burn stake — release to NETWORK account (acts as a burn)
        const burned = this.paymentGate.releasePayment(proposal.stakeHoldId, 'NETWORK');
        if (burned) {
          console.log(`[governance] Stake burned: ${proposal.stakeAmount} Lux from ${proposal.proposedBy.slice(0, 16)}... (proposal rejected)`);
        }
        break;
      }

      case 'expired': {
        const voteCount = this.votes.get(proposalId)?.size ?? 0;
        if (voteCount === 0) {
          // No votes — refund (not proposer's fault nobody reviewed it)
          const refunded = this.paymentGate.refundPayment(proposal.stakeHoldId);
          if (refunded) {
            console.log(`[governance] Stake refunded: ${proposal.stakeAmount} Lux to ${proposal.proposedBy.slice(0, 16)}... (expired with 0 votes)`);
          }
        } else {
          // Had votes but no quorum — burn stake
          const burned = this.paymentGate.releasePayment(proposal.stakeHoldId, 'NETWORK');
          if (burned) {
            console.log(`[governance] Stake burned: ${proposal.stakeAmount} Lux from ${proposal.proposedBy.slice(0, 16)}... (expired with ${voteCount} votes)`);
          }
        }
        break;
      }

      case 'revision_requested': {
        // Hold the stake — proposer has 7 days to submit an amendment
        console.log(`[governance] Stake held: ${proposal.stakeAmount} Lux for ${proposal.proposedBy.slice(0, 16)}... (revision requested — awaiting amendment)`);
        break;
      }
    }
  }

  // ── Public Actions ──

  /**
   * Create and broadcast a new proposal.
   *
   * Phase 30 additions:
   *   - `isEmergency` — expedited review (50 Lux stake instead of 10)
   *   - `category` — proposal classification for reviewer analysis
   *   - `proposerBalance` — optional override (used by API routes that already fetched balance)
   *   - `proposerAccountAge` — optional, used to determine free-tier eligibility
   *
   * Staking behavior (when PaymentGate is connected):
   *   - Standard proposals: 10 Lux stake
   *   - Emergency proposals: 50 Lux stake
   *   - Free tier: first proposal from accounts with < 100 Lux balance — 0 Lux stake
   *   - Stake is held via PaymentGate escrow and resolved when the proposal decision is made
   */
  async createProposal(
    title: string,
    description: string,
    votingDurationMs: number = 3_600_000,
    options?: {
      isEmergency?: boolean;
      category?: ProposalCategory;
      proposerBalance?: number;
      proposerAccountAge?: number;
      upgradePayload?: UpgradePayload;
    },
  ): Promise<GovernanceProposal> {
    const safeTitle = sanitizeText(title);
    const safeDescription = sanitizeText(description);

    // Rate-limit: reject if this proposer already has an active proposal with 0 votes.
    // Prevents autonomous loops from flooding governance with unvoted proposals.
    for (const existing of this.proposals.values()) {
      if (existing.status !== 'active') continue;
      if (existing.proposedBy !== this.localPeerId) continue;
      if (Date.now() > existing.votingEndsAt) continue; // already expired, just not marked yet
      const voteCount = this.votes.get(existing.id)?.size ?? 0;
      if (voteCount === 0) {
        console.log(`[governance] Rate-limited: already have active 0-vote proposal "${existing.title}" — skipping "${safeTitle}"`);
        throw new Error(`Rate-limited: you already have an active proposal with 0 votes ("${existing.title}"). Vote on or wait for it to expire before creating another.`);
      }
    }

    // ── Phase 30: Determine stake amount ──
    const isEmergency = options?.isEmergency ?? false;
    const category = options?.category;
    let stakeAmount = isEmergency ? EMERGENCY_STAKE_LUX : PROPOSAL_STAKE_LUX;

    // Dev mode: reduce stake when network is small (same condition as auto-approve)
    const activePeers = this.network.getPeerCount() + 1;
    if (!isEmergency && activePeers <= this.upgradeAutoApproveThreshold) {
      stakeAmount = 1;
    }

    let stakeHoldId: string | undefined;
    let isFreeTier = false;

    if (this.paymentGate) {
      // Check free tier: first proposal from accounts with < FREE_TIER_THRESHOLD Lux
      const hasExistingProposal = this.hasProposalHistory(this.localPeerId);
      const balance = options?.proposerBalance ?? this.getProposerBalance(this.localPeerId);

      if (!hasExistingProposal && balance < FREE_TIER_THRESHOLD) {
        isFreeTier = true;
        stakeAmount = 0;
        console.log(`[governance] Free tier: first proposal from ${this.localPeerId.slice(0, 16)}... (balance: ${balance} Lux)`);
      }

      // Attempt to hold the stake via PaymentGate
      if (stakeAmount > 0) {
        if (!this.paymentGate.canAfford(this.localPeerId, stakeAmount)) {
          throw new Error(`Insufficient balance for proposal stake (need ${stakeAmount} Lux)`);
        }

        // Use a synthetic task ID for the stake hold
        const stakeTaskId = `gov-stake-${Date.now()}-${randomBytes(4).toString('hex')}`;
        const hold = this.paymentGate.holdPayment(this.localPeerId, stakeTaskId, stakeAmount);
        if (!hold) {
          throw new Error(`Failed to hold ${stakeAmount} Lux stake for proposal`);
        }
        stakeHoldId = hold.holdId;
        console.log(`[governance] Staked ${stakeAmount} Lux for proposal "${safeTitle}" (hold: ${stakeHoldId})`);
      }
    } else {
      // No PaymentGate — staking is disabled (backward compatible)
      stakeAmount = 0;
    }

    // Phase 30.6: governance_change proposals get extended voting period
    let effectiveVotingDurationMs = votingDurationMs;
    if (category === 'governance_change') {
      effectiveVotingDurationMs = GOVERNANCE_CHANGE_VOTING_HOURS * 60 * 60 * 1000;
      console.log(`[governance] Meta-governance protection: "${safeTitle}" requires ${GOVERNANCE_CHANGE_VOTING_HOURS}h vote, ${GOVERNANCE_CHANGE_APPROVAL_THRESHOLD * 100}% approval, min ${GOVERNANCE_CHANGE_MIN_VOTES} votes`);
    } else if (isEmergency) {
      effectiveVotingDurationMs = EMERGENCY_VOTING_HOURS * 60 * 60 * 1000;
    }

    const proposal: GovernanceProposal = {
      id: createHash('sha256').update(`${this.localPeerId}:${Date.now()}:${safeTitle}`).digest('hex'),
      title: safeTitle,
      description: safeDescription,
      proposedBy: this.localPeerId,
      createdAt: Date.now(),
      votingEndsAt: Date.now() + effectiveVotingDurationMs,
      status: 'active',
      // Phase 30 fields
      stakeAmount: stakeAmount > 0 ? stakeAmount : undefined,
      stakeHoldId: stakeHoldId,
      category,
      reviewerCount: 0,
      upgradePayload: options?.upgradePayload,
    };

    // Governance hardening: sign proposal with Ed25519 key
    if (this.identityPrivateKey) {
      try {
        const { signProposal } = await import('@pando/shared');
        proposal.proposerSignature = await signProposal(proposal, this.identityPrivateKey);
      } catch (e: any) {
        console.warn(`[governance] Failed to sign proposal: ${e.message?.slice(0, 100)}`);
      }
    }

    // Store locally + persist
    this.proposals.set(proposal.id, proposal);
    this.comments.set(proposal.id, []);
    this.votes.set(proposal.id, new Map());
    this.processedIds.add(`proposal:${proposal.id}`);
    this.stmtInsertProposal.run(
      proposal.id, proposal.title, proposal.description,
      proposal.proposedBy, proposal.createdAt, proposal.votingEndsAt, proposal.status,
      proposal.stakeAmount ?? 0, proposal.stakeHoldId ?? '', proposal.category ?? '', proposal.reviewerCount ?? 0,
      proposal.humanOnly ? 1 : 0,
      proposal.upgradePayload ? JSON.stringify(proposal.upgradePayload) : '',
      proposal.proposerSignature ?? ''
    );

    // Broadcast
    const message: PandoMessage = {
      type: MessageType.GOVERNANCE_PROPOSAL,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload: proposal,
    };
    await this.network.publishToTopic(TOPIC_GOVERNANCE, message);

    const stakeInfo = stakeAmount > 0 ? ` (stake: ${stakeAmount} Lux)` : isFreeTier ? ' (free tier)' : '';
    console.log(`[governance] Created proposal: "${title}"${stakeInfo}`);

    // Broadcast activity record for proposal creation
    this.broadcastGovernanceActivity('proposal_created', `Created proposal: "${title}"${stakeInfo}`, proposal.id);

    // Phase 73: Auto-approve upgrade proposals when active peers < threshold
    if (category === 'upgrade' && proposal.upgradePayload) {
      // Security validation before auto-approve
      const validation = await this.validateUpgradeProposal(proposal);
      if (!validation.approved) {
        console.log(`[governance] Upgrade proposal "${safeTitle}" REJECTED: ${validation.reason}`);
        proposal.status = 'rejected';
        this.stmtUpdateProposalStatus.run('rejected', proposal.id);
        return proposal;
      }

      const activePeers = this.network.getPeerCount() + 1;
      if (activePeers <= this.upgradeAutoApproveThreshold) {
        const approveUpgrade = () => {
          console.log(`[governance] Dev mode: auto-approving upgrade "${safeTitle}" (${activePeers} peers <= threshold ${this.upgradeAutoApproveThreshold})`);
          proposal.status = 'passed';
          this.stmtUpdateProposalStatus.run('passed', proposal.id);
          const decision: GovernanceDecision = {
            proposalId: proposal.id, outcome: 'passed',
            votesFor: 1, votesAgainst: 0, votesAbstain: 0, decidedAt: Date.now(),
          };
          this.decisions.set(proposal.id, decision);
          this.stmtInsertDecision.run(decision.proposalId, decision.outcome, decision.votesFor, decision.votesAgainst, decision.votesAbstain, decision.decidedAt);
          this.broadcastDecision(decision).catch((e: any) => console.warn(`[governance] Decision broadcast failed: ${e.message?.slice(0, 100)}`));
          this.onUpgradeApprovedCallback?.(proposal);
        };

        if (validation.kernelDelay) {
          console.log(`[governance] Kernel protection: delaying auto-approve by 60s for "${safeTitle}"`);
          setTimeout(() => { approveUpgrade(); }, 60000);
        } else {
          approveUpgrade();
        }
      }
    }

    return proposal;
  }

  /**
   * Scan git diff for dangerous code patterns in ADDED lines.
   * Returns matches found. 'block' severity blocks auto-approve; 'warn' logs to audit only.
   */
  private scanDiffForDangerousPatterns(proposalId: string): import('@pando/shared').DangerousPatternMatch[] {
    const PATTERNS: Array<{ regex: RegExp; name: string; severity: 'warn' | 'block'; kernelOnly?: boolean }> = [
      { regex: /\beval\s*\(/, name: 'eval(', severity: 'block' },
      { regex: /new\s+Function\s*\(/, name: 'new Function(', severity: 'block' },
      { regex: /\.privateKey\b/, name: '.privateKey access', severity: 'warn' },
      { regex: /process\.env\[/, name: 'process.env[] dynamic access', severity: 'warn' },
      { regex: /require\s*\([^'"`)]+\)/, name: 'dynamic require()', severity: 'warn' },
      { regex: /\bfetch\s*\(/, name: 'fetch() in kernel', severity: 'warn', kernelOnly: true },
      { regex: /\bwriteFileSync\s*\(/, name: 'writeFileSync in kernel', severity: 'warn', kernelOnly: true },
    ];

    const matches: import('@pando/shared').DangerousPatternMatch[] = [];
    try {
      const govGit = new GitOps(process.cwd());
      const diff = govGit.diff('HEAD~1', 'HEAD', ['-U0']);
      let currentFile = '';
      let lineNum = 0;
      for (const line of diff.split('\n')) {
        if (line.startsWith('+++ b/')) { currentFile = line.slice(6); continue; }
        if (line.startsWith('@@ ')) {
          const m = line.match(/@@ \-\d+(?:,\d+)? \+(\d+)/);
          if (m) lineNum = parseInt(m[1], 10) - 1;
          continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
          if (currentFile.startsWith('output/')) { lineNum++; continue; }
          lineNum++;
          const content = line.slice(1);
          for (const pat of PATTERNS) {
            if (pat.kernelOnly && !currentFile.includes('kernel/')) continue;
            if (pat.regex.test(content)) {
              matches.push({ file: currentFile, line: lineNum, pattern: pat.name, severity: pat.severity, context: content.trim().slice(0, 120) });
            }
          }
        } else if (!line.startsWith('-')) {
          lineNum++;
        }
      }
    } catch (err) {
      console.warn('[governance] WARNING: diff content scan failed:', (err as Error).message?.slice(0, 100));
    }

    // Log results to governance_audit
    if (matches.length > 0) {
      const blockCount = matches.filter(m => m.severity === 'block').length;
      const warnCount = matches.filter(m => m.severity === 'warn').length;
      this.agentDb?.logGovernanceCheck(proposalId, 'diff_content_scan',
        blockCount > 0 ? 'fail' : 'warn',
        `Found ${matches.length} pattern(s): ${blockCount} blocking, ${warnCount} warning. ${matches.map(m => `${m.pattern} in ${m.file}:${m.line}`).join('; ')}`.slice(0, 500));
    } else {
      this.agentDb?.logGovernanceCheck(proposalId, 'diff_content_scan', 'pass');
    }

    return matches;
  }

  /**
   * Deterministic security checks for upgrade proposals.
   * Runs BEFORE auto-approve to catch security-sensitive changes, large unreviewed diffs, and build failures.
   */
  private async validateUpgradeProposal(proposal: GovernanceProposal): Promise<{ approved: boolean; reason: string; kernelDelay: boolean }> {
    // Same-commit (no-op) proposals skip all validation — nothing to review
    try {
      const currentHead = new GitOps(process.cwd()).getCurrentCommit();
      if (proposal.upgradePayload?.commitHash && currentHead.startsWith(proposal.upgradePayload.commitHash)) {
        this.agentDb?.logGovernanceCheck(proposal.id, 'same_commit_check', 'pass', 'No-op upgrade (already at this commit)');
        return { approved: true, reason: 'No-op upgrade — already at proposed commit', kernelDelay: false };
      }
    } catch { /* git unavailable — proceed with full validation */ }

    const SECURITY_FILES = [
      'credential-store.ts', 'credential-vault.ts', 'request-reply.ts',
      'guardrails.ts', 'security-monitor.ts', 'governance.ts',
      'upgrade-protocol.ts', 'payment-gate.ts',
    ];

    const proposalId = proposal.id;
    let changedFiles: string[] = [];
    let totalLinesChanged = 0;

    // Parse git diff for changed files and line counts (fail-open if git unavailable)
    const valGit = new GitOps(process.cwd());
    try {
      const diffOutput = valGit.diffNameOnly('HEAD~1', 'HEAD').join('\n');
      changedFiles = diffOutput.trim().split('\n').filter(f => f.length > 0);
    } catch (err) {
      console.warn('[governance] WARNING: git diff --name-only failed, skipping file-based checks:', (err as Error).message);
    }

    try {
      const statOutput = valGit.diffStat('HEAD~1', 'HEAD');
      // Last line of git diff --stat looks like: " 5 files changed, 120 insertions(+), 30 deletions(-)"
      const statMatch = statOutput.match(/(\d+)\s+insertions?\(\+\).*?(\d+)\s+deletions?\(-\)/);
      if (statMatch) {
        totalLinesChanged = parseInt(statMatch[1], 10) + parseInt(statMatch[2], 10);
      }
    } catch (err) {
      console.warn('[governance] WARNING: git diff --stat failed, skipping size check:', (err as Error).message);
    }

    // CHECK 1: Security file check
    if (changedFiles.length > 0) {
      const changedSecurityFiles = changedFiles.filter(f => {
        const basename = f.split('/').pop() || '';
        return SECURITY_FILES.includes(basename);
      });
      if (changedSecurityFiles.length > 0) {
        const desc = (proposal.description || '').toLowerCase();
        if (!desc.includes('security') && !desc.includes('credential')) {
          const reason = 'Security-sensitive files modified without security justification';
          this.agentDb?.logGovernanceCheck(proposalId, 'security_file_check', 'fail', reason, changedFiles.length, totalLinesChanged);
          return { approved: false, reason, kernelDelay: false };
        }
      }
    }
    this.agentDb?.logGovernanceCheck(proposalId, 'security_file_check', 'pass', undefined, changedFiles.length, totalLinesChanged);

    // CHECK 2: Diff content analysis — scan added lines for dangerous patterns
    const dangerousPatterns = this.scanDiffForDangerousPatterns(proposalId);
    const blockingPatterns = dangerousPatterns.filter(p => p.severity === 'block');
    if (blockingPatterns.length > 0) {
      const reason = `Dangerous code patterns detected: ${blockingPatterns.map(p => `${p.pattern} in ${p.file}:${p.line}`).join(', ')}`;
      this.agentDb?.logGovernanceCheck(proposalId, 'dangerous_pattern_check', 'fail', reason.slice(0, 500), changedFiles.length, totalLinesChanged);
      return { approved: false, reason, kernelDelay: false };
    }

    // CHECK 3: Build verification (BIBLE 5.4 Layer 4) — reject if code doesn't compile
    // Uses async execFile to avoid blocking the event loop during builds
    try {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile('npm', ['run', 'build'], {
          cwd: process.cwd(),
          timeout: 120_000,
          windowsHide: true,
        }, (error, _stdout, stderr) => {
          if (error) {
            (error as any).stderr = stderr;
            reject(error);
          } else {
            resolve();
          }
        });
      });
      this.agentDb?.logGovernanceCheck(proposalId, 'build_verification', 'pass', undefined, changedFiles.length, totalLinesChanged);
    } catch (err: any) {
      const stderr = err.stderr?.toString?.()?.slice(0, 500) || err.message?.slice(0, 500) || 'Unknown build error';
      const reason = `Build failed: ${stderr}`;
      console.error(`[governance] Build verification FAILED for proposal ${proposalId}: ${stderr.slice(0, 200)}`);
      this.agentDb?.logGovernanceCheck(proposalId, 'build_verification', 'fail', reason.slice(0, 500), changedFiles.length, totalLinesChanged);
      return { approved: false, reason, kernelDelay: false };
    }

    // CHECK 4: AI review — advisory only (deterministic checks are the real gates)
    if (this.engineAdapter) {
      try {
        let diff = '';
        try {
          diff = new GitOps(process.cwd()).diff('HEAD~1', 'HEAD');
        } catch { /* git unavailable — skip AI review */ }
        if (diff) {
          const review = await this.engineAdapter.reviewDiff(diff, proposal.description || '');
          if (!review.safe) {
            const reason = `AI review flagged risks: ${review.risks.join(', ')} — ${review.recommendation}`;
            console.warn(`[governance] AI review WARNING (advisory): ${reason.slice(0, 200)}`);
            this.agentDb?.logGovernanceCheck(proposalId, 'ai_review', 'warn', reason.slice(0, 500), changedFiles.length, totalLinesChanged);
            // Advisory only — deterministic checks (security files, dangerous patterns) are the real gates
          } else {
            this.agentDb?.logGovernanceCheck(proposalId, 'ai_review', 'pass', review.recommendation);
          }
        }
      } catch (err) {
        console.warn('[governance] AI review failed (non-fatal):', (err as Error).message?.slice(0, 100));
        this.agentDb?.logGovernanceCheck(proposalId, 'ai_review', 'skip', 'AI review error — fail-open');
      }
    }

    // CHECK 5: Kernel protection — delay if kernel files modified
    const kernelFilesChanged = changedFiles.some(f => f.includes('kernel/'));
    if (kernelFilesChanged) {
      console.log('[governance] WARNING: Kernel file modified — applying 60s delay before approval');
      this.agentDb?.logGovernanceCheck(proposalId, 'kernel_protection', 'pass_delayed', 'Kernel files modified — delayed approval', changedFiles.length, totalLinesChanged);
      return { approved: true, reason: 'Kernel files modified — delayed approval', kernelDelay: true };
    }
    this.agentDb?.logGovernanceCheck(proposalId, 'kernel_protection', 'pass', undefined, changedFiles.length, totalLinesChanged);

    return { approved: true, reason: 'All checks passed', kernelDelay: false };
  }

  /**
   * Check whether a proposer has ever created a proposal (for free-tier eligibility).
   * Searches both in-memory proposals and the database.
   */
  private hasProposalHistory(peerId: string): boolean {
    for (const p of this.proposals.values()) {
      if (p.proposedBy === peerId) return true;
    }
    // Also check database for archived proposals
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM governance_proposals WHERE proposed_by = ?').get(peerId) as any;
    return row && row.cnt > 0;
  }

  /**
   * Get the proposer's balance from the ledger.
   * Falls back to 0 if the ledger is not accessible via PaymentGate.
   */
  private getProposerBalance(peerId: string): number {
    // PaymentGate.canAfford uses ledger internally, but we need the raw balance
    // for free-tier threshold comparison. Use a probe approach.
    if (this.paymentGate) {
      // If can afford FREE_TIER_THRESHOLD, then balance >= threshold → not free tier
      if (this.paymentGate.canAfford(peerId, FREE_TIER_THRESHOLD)) {
        return FREE_TIER_THRESHOLD; // exact value doesn't matter, just >= threshold
      }
      // If can't afford threshold, balance is < threshold
      return 0; // exact value doesn't matter, just < threshold
    }
    return 0;
  }

  /** Add a comment to a proposal. */
  async addComment(proposalId: string, content: string): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');

    const safeContent = sanitizeText(content);
    const comment: GovernanceComment = {
      id: createHash('sha256').update(`${this.localPeerId}:${Date.now()}:${safeContent}`).digest('hex'),
      proposalId,
      from: this.localPeerId,
      content: safeContent,
      createdAt: Date.now(),
    };

    // Store locally + persist
    const existing = this.comments.get(proposalId) || [];
    existing.push(comment);
    this.comments.set(proposalId, existing);
    this.processedIds.add(`comment:${comment.id}`);
    this.stmtInsertComment.run(
      comment.id, comment.proposalId, comment.from, comment.content, comment.createdAt
    );

    // Broadcast
    const message: PandoMessage = {
      type: MessageType.GOVERNANCE_COMMENT,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload: comment,
    };
    await this.network.publishToTopic(TOPIC_GOVERNANCE, message);
  }

  /** Cast a vote on a proposal. */
  async castVote(proposalId: string, choice: VoteChoice, reasoning: string = '', modelAttestation?: ModelAttestation): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');
    this.expireIfNeeded(proposal);
    if (proposal.status !== 'active') throw new Error(`Proposal is ${proposal.status}`);
    if (Date.now() > proposal.votingEndsAt) throw new Error('Voting period has ended');

    const vote: GovernanceVote = {
      proposalId,
      voter: this.localPeerId,
      choice,
      reasoning,
      createdAt: Date.now(),
      ...(modelAttestation ? { modelAttestation } : {}),
    };

    // Store locally + persist
    const proposalVotes = this.votes.get(proposalId) || new Map();
    proposalVotes.set(this.localPeerId, vote);
    this.votes.set(proposalId, proposalVotes);
    this.processedIds.add(`vote:${proposalId}:${this.localPeerId}`);
    this.stmtUpsertVote.run(
      vote.proposalId, vote.voter, vote.choice, vote.reasoning, vote.createdAt,
      vote.modelAttestation ? JSON.stringify(vote.modelAttestation) : ''
    );

    // Broadcast
    const message: PandoMessage = {
      type: MessageType.GOVERNANCE_VOTE,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload: vote,
    };
    await this.network.publishToTopic(TOPIC_GOVERNANCE, message);

    console.log(`[governance] Voted ${choice} on "${proposal.title}"`);

    // Broadcast activity record for vote
    this.broadcastGovernanceActivity('proposal_voted', `Voted ${choice} on "${proposal.title}"`, proposalId);

    // Fire SSE callback
    this.onVoteCallback?.(vote, proposal.title);

    // Reward self for voting
    this.emitVoteReward(this.localPeerId, proposalId);

    // Check if our vote tips the quorum
    this.checkQuorum(proposalId);
  }

  /** Broadcast a decision. */
  private async broadcastDecision(decision: GovernanceDecision): Promise<void> {
    const message: PandoMessage = {
      type: MessageType.GOVERNANCE_DECISION,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload: decision,
    };
    await this.network.publishToTopic(TOPIC_GOVERNANCE, message);
  }

  /** Send a message to other agents via GossipSub. */
  async sendAgentMessage(content: string, to: string = 'all'): Promise<void> {
    const message: PandoMessage = {
      type: MessageType.AGENT_MESSAGE,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload: {
        id: createHash('sha256').update(`${this.localPeerId}:${Date.now()}:${content}`).digest('hex'),
        from: this.localPeerId,
        to,
        content,
        createdAt: Date.now(),
      },
    };
    await this.network.publishToTopic(TOPIC_AGENT, message);
  }

  /** Broadcast agent hello/status. */
  async broadcastHello(status: Record<string, unknown>): Promise<void> {
    const message: PandoMessage = {
      type: MessageType.AGENT_HELLO,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload: { peerId: this.localPeerId, ...status },
    };
    await this.network.publishToTopic(TOPIC_AGENT, message);
  }

  // ── Governance Catch-Up Sync ──

  /**
   * Request governance data from a specific peer (called when a new peer connects).
   * Sends a direct GOVERNANCE_SYNC_REQUEST message via the Pando protocol.
   */
  async requestSync(peerId: string): Promise<void> {
    try {
      await this.network.sendMessage(peerId, {
        type: MessageType.GOVERNANCE_SYNC_REQUEST,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: { requestedAt: Date.now() },
      });
      debug(`[governance] Sync requested from ${peerId.slice(0, 16)}...`);
    } catch (e: any) {
      console.log(`[governance] Could not request sync from ${peerId.slice(0, 16)}...: ${e.message}`);
    }
  }

  /**
   * Handle an incoming sync request from a peer — send them all governance data.
   */
  handleSyncRequest(fromPeerId: string): void {
    const proposals = this.getProposals();
    const allComments: GovernanceComment[] = [];
    const allVotes: GovernanceVote[] = [];
    const allDecisions: GovernanceDecision[] = [];
    for (const proposal of proposals) {
      allComments.push(...this.getComments(proposal.id));
      allVotes.push(...this.getVotes(proposal.id));
      const decision = this.getDecision(proposal.id);
      if (decision) allDecisions.push(decision);
    }

    const payload = { proposals, comments: allComments, votes: allVotes, decisions: allDecisions };
    debug(`[governance] Sending sync response to ${fromPeerId.slice(0, 16)}... (${proposals.length} proposals, ${allVotes.length} votes, ${allComments.length} comments, ${allDecisions.length} decisions)`);

    this.network.sendMessage(fromPeerId, {
      type: MessageType.GOVERNANCE_SYNC_RESPONSE,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload,
    }).catch((e: any) => {
      console.log(`[governance] Failed to send sync response to ${fromPeerId.slice(0, 16)}...: ${e.message}`);
    });
  }

  /**
   * Handle an incoming sync response — apply all governance data through existing handlers.
   * Dedup is handled by processedIds, so duplicate items are safely ignored.
   */
  async handleSyncResponse(message: PandoMessage): Promise<void> {
    const payload = message.payload as {
      proposals?: GovernanceProposal[];
      comments?: GovernanceComment[];
      votes?: GovernanceVote[];
      decisions?: GovernanceDecision[];
    };
    if (!payload) return;

    let newProposals = 0, newVotes = 0, newComments = 0, newDecisions = 0;
    let skippedStale = 0;

    // Track which proposal IDs were accepted during sync so we can skip
    // comments/votes/decisions for stale proposals we filtered out.
    const acceptedProposalIds = new Set<string>();
    // Also include proposals we already have locally (their associated data is still valid).
    for (const id of this.proposals.keys()) {
      acceptedProposalIds.add(id);
    }

    const now = Date.now();

    // Apply proposals first (comments/votes reference them)
    for (const proposal of payload.proposals || []) {
      // Skip stale proposals: if older than SYNC_PROPOSAL_MAX_AGE_MS and not still active,
      // don't bother processing them. Active proposals are always accepted regardless of age
      // since they may still need votes.
      const age = now - (proposal.createdAt || 0);
      if (age > SYNC_PROPOSAL_MAX_AGE_MS && proposal.status !== 'active') {
        skippedStale++;
        continue;
      }

      if (!this.processedIds.has(`proposal:${proposal.id}`)) {
        await this.handleProposal({ type: MessageType.GOVERNANCE_PROPOSAL, from: message.from, timestamp: proposal.createdAt, payload: proposal });
        acceptedProposalIds.add(proposal.id);
        newProposals++;
      } else {
        acceptedProposalIds.add(proposal.id);
      }
    }

    // Apply comments (only for proposals we accepted or already have)
    for (const comment of payload.comments || []) {
      if (!acceptedProposalIds.has(comment.proposalId)) continue;
      if (!this.processedIds.has(`comment:${comment.id}`)) {
        this.handleComment({ type: MessageType.GOVERNANCE_COMMENT, from: message.from, timestamp: comment.createdAt, payload: comment });
        newComments++;
      }
    }

    // Apply votes (skip reward emission for synced votes — they're historical)
    for (const vote of payload.votes || []) {
      if (!acceptedProposalIds.has(vote.proposalId)) continue;
      const key = `vote:${vote.proposalId}:${vote.voter}`;
      if (!this.processedIds.has(key)) {
        // Mark as already rewarded to prevent emission for historical votes
        this.rewardedVotes.add(key);
        this.handleVote({ type: MessageType.GOVERNANCE_VOTE, from: message.from, timestamp: vote.createdAt, payload: vote });
        newVotes++;
      }
    }

    // Apply decisions (only for proposals we accepted or already have)
    for (const decision of payload.decisions || []) {
      if (!acceptedProposalIds.has(decision.proposalId)) continue;
      if (!this.processedIds.has(`decision:${decision.proposalId}`)) {
        this.handleDecision({ type: MessageType.GOVERNANCE_DECISION, from: message.from, timestamp: decision.decidedAt, payload: decision });
        newDecisions++;
      }
    }

    if (newProposals + newVotes + newComments + newDecisions > 0) {
      console.log(`[governance] Sync complete: +${newProposals} proposals, +${newVotes} votes, +${newComments} comments, +${newDecisions} decisions${skippedStale > 0 ? ` (skipped ${skippedStale} stale)` : ''}`);
    } else {
      debug(`[governance] Sync complete: already up to date${skippedStale > 0 ? ` (skipped ${skippedStale} stale)` : ''}`);
    }
  }

  // ── Expiry ──

  /**
   * Check if a proposal's voting period has ended and mark it as expired.
   * Called on-demand before returning proposals or accepting votes/comments.
   */
  private expireIfNeeded(proposal: GovernanceProposal): void {
    if (proposal.status !== 'active') return;
    if (Date.now() <= proposal.votingEndsAt) return;

    // Voting period ended — check if quorum was reached
    const proposalVotes = this.votes.get(proposal.id);
    const totalVotes = proposalVotes ? proposalVotes.size : 0;
    const quorum = this.getQuorum();

    if (totalVotes >= quorum) {
      // Quorum was reached — finalize as passed/rejected
      this.checkQuorum(proposal.id);
    } else {
      // No quorum — mark as expired
      proposal.status = 'expired';
      this.stmtUpdateProposalStatus.run('expired', proposal.id);
      console.log(`[governance] Proposal "${proposal.title}" expired (no quorum: ${totalVotes}/${quorum} votes)`);

      // Phase 30: Resolve stake on expiry
      this.resolveProposalStake(proposal.id, 'expired');
    }
  }

  /**
   * Resubmit a proposal that is in 'revision_requested' state.
   * Transitions it back to 'pending' (awaiting AI review) and resets vote counts.
   * Only the original proposer can resubmit.
   */
  resubmitProposal(proposalId: string, requesterId?: string): boolean {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) return false;
    if (proposal.status !== 'revision_requested') {
      console.warn(`[governance] Cannot resubmit proposal ${proposalId.slice(0, 8)} — status is '${proposal.status}', expected 'revision_requested'`);
      return false;
    }
    if (requesterId && proposal.proposedBy !== requesterId) {
      console.warn(`[governance] Cannot resubmit proposal ${proposalId.slice(0, 8)} — requester ${requesterId.slice(0, 12)} is not the original proposer`);
      return false;
    }

    // Reset to active for new review cycle
    proposal.status = 'active';
    this.stmtUpdateProposalStatus.run('active', proposal.id);

    // Clear existing votes for this proposal
    this.votes.set(proposalId, new Map());

    console.log(`[governance] Proposal "${proposal.title}" resubmitted (revision_requested → pending)`);
    this.broadcastGovernanceActivity('proposal_created', `Proposal "${proposal.title}" resubmitted after revision`, proposal.id);
    return true;
  }

  // ── Queries ──

  getProposals(): GovernanceProposal[] {
    const all = Array.from(this.proposals.values());
    // Expire any proposals whose voting period has ended
    for (const p of all) this.expireIfNeeded(p);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  getActiveProposals(): GovernanceProposal[] {
    return this.getProposals().filter(p => p.status === 'active');
  }

  getProposal(id: string): GovernanceProposal | undefined {
    const proposal = this.proposals.get(id);
    if (proposal) this.expireIfNeeded(proposal);
    return proposal;
  }

  getComments(proposalId: string): GovernanceComment[] {
    return this.comments.get(proposalId) || [];
  }

  getVotes(proposalId: string): GovernanceVote[] {
    const proposalVotes = this.votes.get(proposalId);
    if (!proposalVotes) return [];
    return Array.from(proposalVotes.values());
  }

  getDecision(proposalId: string): GovernanceDecision | undefined {
    return this.decisions.get(proposalId);
  }

  /**
   * Get governance statistics.
   * Returns total proposals, stake pool, humanOnly count, and governance change count.
   */
  getGovernanceStats(): { totalProposals: number; reviewedCount: number; avgRiskScore: number; stakePool: number; humanOnlyCount: number; governanceChangeCount: number } {
    let stakePool = 0;
    let humanOnlyCount = 0;
    let governanceChangeCount = 0;

    for (const proposal of this.proposals.values()) {
      // Sum up active stakes (proposals that are still in progress)
      if (proposal.stakeAmount && proposal.stakeAmount > 0 &&
          (proposal.status === 'active' || proposal.status === 'in_review' || proposal.status === 'revision_requested')) {
        stakePool += proposal.stakeAmount;
      }

      if (proposal.humanOnly) humanOnlyCount++;
      if (proposal.category === 'governance_change') governanceChangeCount++;
    }

    return {
      totalProposals: this.proposals.size,
      reviewedCount: 0,
      avgRiskScore: 0,
      stakePool,
      humanOnlyCount,
      governanceChangeCount,
    };
  }

  /** Get model breakdown for a proposal — counts of votes by modelId. */
  getModelBreakdown(proposalId: string): { models: Array<{ modelId: string; provider: string; voteCount: number }>; totalVotesWithAttestation: number; totalVotesWithout: number } {
    const proposalVotes = this.votes.get(proposalId);
    if (!proposalVotes) return { models: [], totalVotesWithAttestation: 0, totalVotesWithout: 0 };

    const modelCounts = new Map<string, { provider: string; count: number }>();
    let withAttestation = 0;
    let withoutAttestation = 0;

    for (const vote of proposalVotes.values()) {
      if (vote.modelAttestation) {
        withAttestation++;
        const key = vote.modelAttestation.modelId;
        const existing = modelCounts.get(key);
        if (existing) {
          existing.count++;
        } else {
          modelCounts.set(key, { provider: vote.modelAttestation.modelProvider, count: 1 });
        }
      } else {
        withoutAttestation++;
      }
    }

    const models = Array.from(modelCounts.entries()).map(([modelId, data]) => ({
      modelId,
      provider: data.provider,
      voteCount: data.count,
    }));

    return { models, totalVotesWithAttestation: withAttestation, totalVotesWithout: withoutAttestation };
  }

  /** Set callback for new proposals (used by agent engine to notify agents). */
  onProposal(callback: (proposal: GovernanceProposal) => void): void {
    this.onProposalCallback = callback;
  }

  /** Set callback for agent messages. */
  onAgentMessage(callback: (from: string, content: string) => void): void {
    this.onAgentMessageCallback = callback;
  }

  /** Set callback for agent hello messages (used to track agent peers). */
  onAgentHello(callback: (hello: AgentHello) => void): void {
    this.onAgentHelloCallback = callback;
  }

  /** Set callback for vote events (used for SSE push). */
  onVote(callback: (vote: GovernanceVote, proposalTitle: string) => void): void {
    this.onVoteCallback = callback;
  }

  /** Set callback for comment events (used for SSE push). */
  onComment(callback: (comment: GovernanceComment) => void): void {
    this.onCommentCallback = callback;
  }

  /** Set callback for decision events (used for SSE push). */
  onDecision(callback: (decision: GovernanceDecision, proposalTitle: string) => void): void {
    this.onDecisionCallback = callback;
  }

  /** Get all known agent peers (from received AGENT_HELLO messages). */
  getKnownAgents(): AgentHello[] {
    return Array.from(this.knownAgents.values());
  }

  /** Broadcast this agent's capabilities to the network. */
  async broadcastCapabilities(caps: AgentCapabilities): Promise<void> {
    const message: PandoMessage = {
      type: MessageType.AGENT_CAPABILITIES,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload: caps,
    };
    await this.network.publishToTopic(TOPIC_AGENT, message);
  }

  /** Get all known peer capabilities. */
  getPeerCapabilities(): AgentCapabilities[] {
    return Array.from(this.peerCapabilities.values());
  }

  /** Delete a proposal and all related votes, comments, and decisions. */
  deleteProposal(id: string): { success: boolean; title: string } {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error('Proposal not found');

    const title = proposal.title;

    // Remove from in-memory caches
    this.proposals.delete(id);
    this.comments.delete(id);
    this.votes.delete(id);
    this.decisions.delete(id);

    // Remove from dedup sets
    this.processedIds.delete(`proposal:${id}`);
    this.processedIds.delete(`decision:${id}`);

    // Delete from SQLite (votes/comments first, then proposal)
    this.db.prepare('DELETE FROM governance_votes WHERE proposal_id = ?').run(id);
    this.db.prepare('DELETE FROM governance_comments WHERE proposal_id = ?').run(id);
    this.db.prepare('DELETE FROM governance_decisions WHERE proposal_id = ?').run(id);
    this.db.prepare('DELETE FROM governance_proposals WHERE id = ?').run(id);

    console.log(`[governance] Deleted proposal: "${title}" (${id.slice(0, 16)}...)`);
    return { success: true, title };
  }

  /** Clean up old processed IDs. */
  cleanup(): void {
    if (this.processedIds.size > 10000) {
      const arr = Array.from(this.processedIds);
      this.processedIds = new Set(arr.slice(arr.length - 5000));
    }
  }

  /**
   * Archive expired proposals older than maxAgeMs (default 30 days).
   * Removes them from in-memory caches and SQLite. Related votes, comments,
   * and decisions are also cleaned up. After age-based cleanup, enforces the
   * MAX_PROPOSALS cap by evicting oldest completed proposals first.
   * Returns count of archived proposals.
   */
  archiveExpiredProposals(maxAgeMs: number = 30 * 86_400_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let archived = 0;

    // First pass: expire any active proposals whose voting period has ended.
    // expireIfNeeded is normally called on-demand (getProposals/castVote), but
    // flooded proposals may never be queried, so force-expire them here.
    for (const proposal of this.proposals.values()) {
      this.expireIfNeeded(proposal);
    }

    for (const [id, proposal] of this.proposals) {
      if (proposal.status === 'active' || proposal.status === 'in_review') continue;

      // Immediately archive expired proposals with 0 votes (noise — nobody cared)
      if (proposal.status === 'expired') {
        const voteCount = this.votes.get(id)?.size ?? 0;
        if (voteCount === 0) {
          this.removeProposalData(id, proposal.title, 'expired-no-votes');
          archived++;
          continue;
        }
      }

      // Age-based cleanup for all other non-active proposals
      if (proposal.createdAt > cutoff) continue;

      this.removeProposalData(id, proposal.title, proposal.status);
      archived++;
    }

    // Enforce cap: evict oldest completed/expired/rejected proposals first
    archived += this.enforceProposalCap();

    if (archived > 0) {
      console.log(`[governance] Archive cleanup: removed ${archived} proposals (${this.proposals.size} remaining)`);
    }

    return archived;
  }

  /**
   * Remove a proposal and all its related data from memory and SQLite.
   */
  private removeProposalData(id: string, title: string, status: string): void {
    const createdAt = this.proposals.get(id)?.createdAt || Date.now();

    this.proposals.delete(id);
    this.comments.delete(id);
    this.votes.delete(id);
    this.decisions.delete(id);
    this.processedIds.delete(`proposal:${id}`);
    this.processedIds.delete(`decision:${id}`);

    this.db.prepare('DELETE FROM governance_votes WHERE proposal_id = ?').run(id);
    this.db.prepare('DELETE FROM governance_comments WHERE proposal_id = ?').run(id);
    this.db.prepare('DELETE FROM governance_decisions WHERE proposal_id = ?').run(id);
    this.db.prepare('DELETE FROM governance_proposals WHERE id = ?').run(id);

    console.log(`[governance] Archived proposal: "${title}" (status: ${status}, age: ${Math.floor((Date.now() - createdAt) / 86_400_000)}d)`);
  }

  /**
   * Enforce the MAX_PROPOSALS cap on the in-memory proposals map.
   * Evicts oldest completed (non-active) proposals first.
   * Returns count of evicted proposals.
   */
  private enforceProposalCap(): number {
    if (this.proposals.size <= GovernanceSync.MAX_PROPOSALS) return 0;

    // Gather non-active proposals sorted by createdAt ascending (oldest first)
    // Skip active and in_review proposals — they are still being processed
    const completedProposals = Array.from(this.proposals.entries())
      .filter(([, p]) => p.status !== 'active' && p.status !== 'in_review')
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    let evicted = 0;
    for (const [id, proposal] of completedProposals) {
      if (this.proposals.size <= GovernanceSync.MAX_PROPOSALS) break;

      this.proposals.delete(id);
      this.comments.delete(id);
      this.votes.delete(id);
      this.decisions.delete(id);
      this.processedIds.delete(`proposal:${id}`);
      this.processedIds.delete(`decision:${id}`);

      this.db.prepare('DELETE FROM governance_votes WHERE proposal_id = ?').run(id);
      this.db.prepare('DELETE FROM governance_comments WHERE proposal_id = ?').run(id);
      this.db.prepare('DELETE FROM governance_decisions WHERE proposal_id = ?').run(id);
      this.db.prepare('DELETE FROM governance_proposals WHERE id = ?').run(id);

      console.log(`[governance] Evicted proposal over cap: "${proposal.title}" (oldest completed)`);
      evicted++;
    }

    return evicted;
  }

  /**
   * Stop the archive cleanup interval. Call on shutdown.
   */
  stopArchiveInterval(): void {
    if (this.archiveInterval) {
      clearInterval(this.archiveInterval);
      this.archiveInterval = null;
      console.log('[governance] Archive cleanup interval stopped');
    }
  }
}
