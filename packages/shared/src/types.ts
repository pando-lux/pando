export interface NodeIdentity {
  peerId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  createdAt: number;
}

export interface SerializedIdentity {
  peerId: string;
  publicKey: string; // base64
  privateKey: string; // base64
  createdAt: number;
}

export interface EncryptedSerializedIdentity {
  encrypted: true;
  peerId: string;
  publicKey: string;           // base64 — not secret
  salt: string;                // hex — 16-byte PBKDF2 salt
  iv: string;                  // hex — 12-byte AES-GCM IV
  encryptedPrivateKey: string; // hex — AES-256-GCM ciphertext + auth tag
  createdAt: number;
}

/** Current P2P message protocol version. Increment when envelope format changes. */
export const MESSAGE_VERSION = 1;

/**
 * Node operational mode (v2.3).
 * Mode 1 = local-only (no P2P, no internet infra — works offline)
 * Mode 2 = P2P connected (no internet infra storage)
 * Mode 3 = full (P2P + internet infra: MongoDB, S3, etc.)
 */
export type OperationalMode = 1 | 2 | 3;

/** Boot step result for a single subsystem. */
export type BootStepStatus = 'ok' | 'degraded' | 'failed' | 'skipped';

/**
 * Node health snapshot (v2.3). Returned in /v1/status.
 * Tracks which layers started successfully and current operational mode.
 */
export interface NodeHealth {
  mode: OperationalMode;
  degraded: string[];             // Names of subsystems running in degraded state
  kernel: 'healthy' | 'failed';  // Layer 0: network, ledger, sync, governance, monitor, guardrails
  core: 'healthy' | 'degraded' | 'failed';    // Layer 1: storage, agents, payment
  platform: 'healthy' | 'degraded' | 'failed'; // Layer 2: scheduler, content, resources
  bootSteps: Record<string, BootStepStatus>;   // Step-by-step startup results
}

export interface PandoMessage {
  type: MessageType;
  version?: number;         // v2.2: envelope version (stamped by publishToTopic, optional for callers)
  from: string; // peerId
  timestamp: number;
  payload: unknown;
  signature?: string;
}

export enum MessageType {
  PING = 'ping',
  PONG = 'pong',
  QUERY = 'query',
  QUERY_RESPONSE = 'query_response',
  PEER_ANNOUNCE = 'peer_announce',
  NODE_STATUS = 'node_status',
  // Ledger messages
  BALANCE_REQUEST = 'balance_request',
  BALANCE_RESPONSE = 'balance_response',
  TRANSFER = 'transfer',
  TRANSFER_CONFIRM = 'transfer_confirm',
  EMISSION_NOTIFY = 'emission_notify',
  // Sync messages
  SYNC_REQUEST = 'sync_request',
  SYNC_RESPONSE = 'sync_response',
  // Agent messages
  AGENT_HELLO = 'agent_hello',
  AGENT_MESSAGE = 'agent_message',
  // Governance messages
  GOVERNANCE_PROPOSAL = 'governance_proposal',
  GOVERNANCE_COMMENT = 'governance_comment',
  GOVERNANCE_VOTE = 'governance_vote',
  GOVERNANCE_DECISION = 'governance_decision',
  // Governance sync (catch-up for new peers)
  GOVERNANCE_SYNC_REQUEST = 'governance_sync_request',
  GOVERNANCE_SYNC_RESPONSE = 'governance_sync_response',
  // Activity transparency (agent activity broadcasting)
  ACTIVITY_BROADCAST = 'activity_broadcast',
  ACTIVITY_SYNC_REQUEST = 'activity_sync_request',
  ACTIVITY_SYNC_RESPONSE = 'activity_sync_response',
  // Agent capability negotiation
  AGENT_CAPABILITIES = 'agent_capabilities',
  // Multi-agent cross-node messaging
  MULTI_AGENT_MESSAGE = 'multi_agent_message',
  // Task sync (catch-up for new peers)
  TASK_SYNC_REQUEST = 'task_sync_request',
  TASK_SYNC_RESPONSE = 'task_sync_response',
  // Phase 30: AI-Powered Governance — reviewer selection & review
  REVIEWER_CANDIDACY = 'reviewer_candidacy',
  PROPOSAL_REVIEW = 'proposal_review',
  // Phase 42.5: Resource Registry
  RESOURCE_REGISTER = 'resource_register',
  RESOURCE_REVOKE = 'resource_revoke',
  // Phase 56: P2P user account claims
  ACCOUNT_CLAIM = 'account_claim',
  // Phase 63: P2P Project Registry
  PROJECT_REGISTER = 'project_register',
  PROJECT_UPDATE = 'project_update',
  PROJECT_ARCHIVE = 'project_archive',
  // Phase 92: Direct TCP stream capability profile exchange (fallback for GossipSub mesh failures)
  CAPABILITY_PROFILE_DIRECT = 'capability_profile_direct',
}

export enum NodeTier {
  WORK = 1,    // Any model — simple queries, relay, cache
  VERIFY = 2,  // Capable models — code review, content verification
  GOVERN = 3,  // Top-tier models — full governance votes
}

export interface NodeConfig {
  listenPort: number;
  apiPort: number; // HTTP API port (default 4000)
  dataDir: string;
  bootstrapPeers: string[];
  tier: NodeTier;
  relay?: boolean; // Act as circuit relay server (opt-in, implies --public)
  capabilities?: string[];
  nodeMode?: NodeMode;     // Phase 64: node specialization (default: 'full')
  ledgerMode?: LedgerMode; // Phase 64: ledger retention (default: 'full')
  publicIp?: string;       // Phase 91: Public IP for libp2p announce (set via PUBLIC_IP env var on EC2/VPS nodes)
}

export interface PeerInfo {
  peerId: string;
  addresses: string[];
  publicKey?: Uint8Array; // Ed25519 public key for signature verification
  tier: NodeTier;
  connectedAt: number;
  lastSeen: number;
}

// === Ledger Types ===

export interface Account {
  peerId: string;
  publicKey: string;
  balance: number; // Lux balance
  createdAt: number;
  updatedAt: number;
}

export enum TransactionType {
  TRANSFER = 'transfer',
  EMISSION = 'emission', // tokens minted for work
}

export interface Transaction {
  id: string; // sha256 hash of content
  from: string; // peerId (or 'NETWORK' for emissions)
  to: string;   // peerId
  amount: number;
  fee: number; // relay fee (paid to relay node)
  relay?: string; // peerId of relay node that earns the fee
  type: TransactionType;
  timestamp: number;
  signature: string;
}

export enum WorkType {
  QUERY_ANSWERED = 'query_answered',
  CODE_VERIFIED = 'code_verified',
  CONTENT_RELAYED = 'content_relayed',
  API_CONTRIBUTED = 'api_contributed',
  PEER_RELAYED = 'peer_relayed',
  PROPOSAL_ACCEPTED = 'proposal_accepted',
  VOTE_CAST = 'vote_cast',
  TASK_COMPLETED = 'task_completed',     // Scheduler task completed
  UPTIME_EPOCH = 'uptime_epoch',         // 10-min uptime epoch
  GUEST_WELCOME = 'guest_welcome',       // Welcome grant for new guest accounts
}

export interface Emission {
  id: string;
  peerId: string;
  amount: number;
  workType: WorkType;
  workProof: string;
  timestamp: number;
}

export enum ApiProvider {
  CLAUDE = 'claude',
  OPENAI = 'openai',
  GOOGLE = 'google',
  OTHER = 'other',
}

export interface ApiContribution {
  id: number;
  peerId: string;
  provider: ApiProvider;
  monthlyCap: number; // USD
  usedUsd: number;
  tasksCompleted: number;
  luxEarned: number;
  registeredAt: number;
  lastUsedAt: number | null;
  active: boolean;
}

// Token economics constants
export const LUX_HARD_CAP = 10_000_000_000; // 10 billion Lux, immutable
export const RELAY_FEE_RATE = 0.001;        // 0.1% relay fee per transfer (paid to relay node)
export const LUX_PRECISION = 8;             // decimal places for Lux values

/** Round a Lux value to avoid floating point noise (8 decimal places). */
export function roundLux(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
export const NETWORK_ACCOUNT = 'NETWORK';   // special account for emissions

// Emission rewards (Lux per unit of work) — AI-adjustable within bounds
// Real work pays well. Trivial work pays almost nothing.
export const EMISSION_REWARDS: Record<WorkType, number> = {
  [WorkType.QUERY_ANSWERED]: 1.0,       // Answered a real user question
  [WorkType.CODE_VERIFIED]: 5.0,        // Reviewed and verified code/service
  [WorkType.CONTENT_RELAYED]: 0.01,     // Served cached content
  [WorkType.API_CONTRIBUTED]: 2.0,      // API key used for real task
  [WorkType.PEER_RELAYED]: 0.001,       // Trivial relay
  [WorkType.PROPOSAL_ACCEPTED]: 5.0,    // Proposal passed governance vote
  [WorkType.VOTE_CAST]: 0.1,            // Voted on a governance proposal
  [WorkType.TASK_COMPLETED]: 5.0,       // Task completed by Scheduler (base, varies by tier)
  [WorkType.UPTIME_EPOCH]: 0.05,        // 10-min uptime epoch (max 7.2/day)
  [WorkType.GUEST_WELCOME]: 25.0,       // Welcome grant for guests (25 base × early multiplier)
};

export const DAILY_EMISSION_CAP = 500;  // Max Lux any single node can earn per day

// Early contributor multiplier
export const EARLY_MULTIPLIERS = {
  FIRST_100: 5,
  FIRST_1000: 3,
  FIRST_10000: 2,
  AFTER: 1,
};

// === Protocol Constants ===

export const PANDO_PROTOCOL = '/pando/message/1.0.0';
export const PANDO_PROTOCOL_PING = '/pando/ping/1.0.0';

/** Default Claude model for all spawned agent sessions (manager, scheduler workers, chat) */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

export const DEFAULT_CONFIG: NodeConfig = {
  listenPort: 0, // random port
  apiPort: 4000,  // HTTP API port
  dataDir: '',   // set at runtime to ~/.pando
  bootstrapPeers: [],
  tier: NodeTier.WORK,
};

// === Governance Types ===

export type ProposalStatus = 'active' | 'in_review' | 'passed' | 'rejected' | 'expired' | 'revision_requested';
export type VoteChoice = 'approve' | 'reject' | 'abstain';
export type ProposalCategory = 'code_change' | 'config_change' | 'economic_change' | 'governance_change' | 'social' | 'emergency' | 'upgrade';

export interface GovernanceProposal {
  id: string;                    // SHA256 hash
  title: string;
  description: string;
  proposedBy: string;            // peerId
  createdAt: number;
  votingEndsAt: number;
  status: ProposalStatus;
  // Phase 30: AI-Powered Governance — staking & review fields
  stakeAmount?: number;          // Lux staked (0 for free-tier proposals)
  stakeHoldId?: string;          // PaymentGate hold ID for stake escrow
  category?: ProposalCategory;   // Proposal classification
  reviewerCount?: number;        // Number of AI reviewers assigned
  // Phase 30.5: Human-only mode — set when no AI reviewers are available
  humanOnly?: boolean;           // If true, proposal uses extended voting with lower quorum
  // Phase 73: Upgrade payload for P2P self-upgrade proposals
  upgradePayload?: UpgradePayload;
}

export interface GovernanceComment {
  id: string;
  proposalId: string;
  from: string;                  // peerId
  content: string;
  createdAt: number;
}

// === Model Attestation (Phase 10.5) ===

export interface ModelAttestation {
  modelId: string;               // e.g., "claude-opus-4-6", "gpt-4o"
  modelProvider: string;         // e.g., "anthropic", "openai"
  attestationHash: string;       // SHA-256(proposalId + choice + modelId + timestamp + salt)
  salt: string;                  // Random salt for hash uniqueness
  nodeSignature: string;         // Ed25519 signature of attestationHash
}

export interface GovernanceVote {
  proposalId: string;
  voter: string;                 // peerId
  choice: VoteChoice;
  reasoning: string;
  createdAt: number;
  modelAttestation?: ModelAttestation;
}

export interface GovernanceDecision {
  proposalId: string;
  outcome: 'passed' | 'rejected' | 'expired';
  votesFor: number;
  votesAgainst: number;
  votesAbstain: number;
  decidedAt: number;
  // Phase 30.4: AI review summary (present when AI review phase completed)
  reviewSummary?: ReviewSummary;
}

// === Phase 30.3: AI-Powered Governance — Proposal Reviews ===

export type ReviewRecommendation = 'approve' | 'reject' | 'revise';

/** An AI reviewer's assessment of a governance proposal. */
export interface ProposalReview {
  id: string;                            // SHA256 hash
  proposalId: string;
  reviewerPeerId: string;
  riskScore: number;                     // 1-5 (1=low risk, 5=high risk)
  reasoning: string;
  recommendation: ReviewRecommendation;
  modelAttestation?: string;             // Optional model ID attestation
  createdAt: number;
}

/** Aggregated review summary for a proposal (Phase 30.4). */
export interface ReviewSummary {
  avgRiskScore: number;
  reviewCount: number;
  recommendations: {
    approve: number;
    reject: number;
    revise: number;
  };
}

// === Phase 30: AI-Powered Governance — Reviewer Selection ===

/** A node's candidacy to review a governance proposal. */
export interface ReviewerCandidacy {
  proposalId: string;
  peerId: string;
  score: number;               // SHA256(proposalId + peerId + proposalCreatedAt) mod 10000
  reputation: number;          // Node's reputation score at time of candidacy
  ip?: string;                 // For device-uniqueness dedup (optional)
  timestamp: number;
}

// === Resource Capability Types ===

/** Capabilities a node can have for task execution. */
export enum NodeCapability {
  CLAUDE_CODE = 'claude-code',
  DOCKER = 'docker',
  PYTHON = 'python',
  NODE = 'node',
  GPU = 'gpu',
  PLAYWRIGHT = 'playwright',
}

/** Declaration of a node's capabilities, broadcast via GossipSub. */
export interface CapabilityDeclaration {
  peerId: string;
  capabilities: NodeCapability[];
  detectedAt: number;       // timestamp when capabilities were detected
  timestamp: number;        // timestamp when this declaration was broadcast
}

// === Resource Network Phase A — Capability Declaration ===

/** Resource types a node can provide (Phase A) */
export type ResourceType =
  | 'relay'          // P2P traffic routing, bootstrap, NAT traversal
  | 'api_keys'       // AI model access (OpenAI, Anthropic, Google)
  | 'compute_cpu'    // Claude Code agent execution, task processing
  | 'compute_gpu'    // ML inference, image gen, training
  | 'storage'        // File hosting, content CDN, backup
  | 'gateway'        // Public HTTP API proxy, web UI serving
  | 'validator'      // Witness emissions, verify task results
  | 'index';         // Search index, content discovery

/** Capability profile broadcast by each node (Phase A) */
export interface CapabilityProfile {
  peerId: string;
  schemaVersion: 1;
  updatedAt: number;
  /** The user account linked to this node (null = no user linked) */
  linkedUser?: { username: string } | null;
  capabilities: Record<ResourceType, boolean>;
  /** Phase 69: Can this node decrypt shared credentials? (EC2 compute nodes only) */
  credentialAccess?: boolean;
  /** Phase 83: What storage backend this node uses — 'mongodb' (direct), 'p2p' (proxied), 'none' */
  storageBackend?: 'mongodb' | 'p2p' | 'none';
  /** Phase 87: Public IP/hostname for HTTP access (Tier 2 URL construction). Set via PUBLIC_IP env var. */
  publicAddress?: string;
  /** Optional details per capability */
  details?: {
    api_keys?: { providers: string[] };
    compute_cpu?: { claudeCode: boolean; maxConcurrent: number; os: string };
    compute_gpu?: { gpuModel?: string; vramMb?: number };
    storage?: { availableMb: number };
    gateway?: { publicUrl?: string; https: boolean };
    httpApi?: { host: string; port: number; https: boolean };
  };
}

/** Task requirements for capability-based routing (Phase A) */
export interface TaskRequirements {
  requiredCapabilities?: ResourceType[];
  preferLocal?: boolean;
}

// === Resource Network Phase B-D Types ===

/** Extended task requirements for smart routing (Phase B) */
export interface ResourceRoutingRequirements {
  requiredResources: string[];  // ResourceType[]
  preferredNodes?: string[];
  minReputation?: number;
  maxLatencyMs?: number;
}

/** Result of finding the best node for a task (Phase B) */
export interface RoutingDecision {
  targetNode: string;
  score: number;
  reason: string;
  alternatives: { peerId: string; score: number }[];
}

/** Result of routing a task to a node (Phase B) */
export interface RoutingResult {
  success: boolean;
  targetNode: string;
  local: boolean;
  forwardedViaP2P: boolean;
  error?: string;
}

/** Result of forwarding a task to a remote node (Phase B) */
export interface ForwardResult {
  success: boolean;
  remoteTaskId?: string;
  error?: string;
}

/** Result of reassigning a failed task (Phase B) */
export interface ReassignResult {
  success: boolean;
  newNode?: string;
  attempts: number;
  error?: string;
}

/** Routing stats (Phase B) */
export interface RoutingStats {
  totalRouted: number;
  localExecutions: number;
  remoteForwards: number;
  reassignments: number;
  failuresByResource: Record<string, number>;
  nodeHealth: Record<string, { active: string[]; degraded: string[]; disabled: string[] }>;
}

/** Resource usage entry for metering (Phase C) */
export interface ResourceUsage {
  resourceType: string;
  quantity: number;
  unit: 'bytes' | 'calls' | 'minutes' | 'gb_hours' | 'requests' | 'validations';
  taskId?: string;
  timestamp: number;
}

/** Meter reading for a specific peer (Phase C) */
export interface MeterReading {
  peerId: string;
  period: string;
  readings: Record<string, { total: number; unit: string }>;
  estimatedReward: number;
}

/** Network-wide meter reading (Phase C) */
export interface NetworkMeterReading {
  period: string;
  totalNodes: number;
  readings: Record<string, { totalUsage: number; unit: string; contributingNodes: number }>;
  totalRewardsDistributed: number;
}

/** Reward calculation for a peer based on resource usage (Phase C) */
export interface RewardCalculation {
  peerId: string;
  period: string;
  rewards: { resourceType: string; usage: number; rate: number; reward: number }[];
  totalReward: number;
}

/** Price list for a node's resources (Phase D) */
export interface PriceList {
  peerId: string;
  prices: Record<string, { pricePerUnit: number; unit: string; currency: 'lux' }>;
  updatedAt: number;
}

/** Result of finding cheapest provider (Phase D) */
export interface MarketplaceResult {
  cheapest: { peerId: string; totalCost: number; breakdown: Record<string, number> };
  alternatives: { peerId: string; totalCost: number }[];
}

/** Budget match result (Phase D) */
export interface BudgetMatch {
  peerId: string;
  totalCost: number;
  withinBudget: boolean;
  savingsVsAverage: number; // percentage
}

/** Market statistics (Phase D) */
export interface MarketStats {
  averagePrices: Record<string, number>;
  lowestPrices: Record<string, { price: number; peerId: string }>;
  activeProviders: number;
  totalResources: Record<string, number>;
}

// === Agent Types ===

export interface AgentHello {
  peerId: string;
  agentTier: 'claude-code' | 'api-key';
  capabilities: string[];       // e.g. ['code', 'review', 'vote']
  currentTask?: string;
  wakeUpCount: number;
  uptime: number;
}

export interface AgentCapabilities {
  peerId: string;
  languages: string[];           // e.g. ['typescript', 'python', 'rust']
  tools: string[];               // e.g. ['claude-code', 'git', 'npm']
  specialization: string[];      // e.g. ['backend', 'frontend', 'devops']
  maxConcurrentTasks: number;
  timestamp: number;
}

export interface AgentDirectMessage {
  id: string;
  from: string;                  // peerId
  to: string;                   // peerId (or 'all' for broadcast)
  content: string;
  replyTo?: string;             // message ID this replies to
  createdAt: number;
}

// Governance rewards (Lux)
export const GOVERNANCE_REWARDS = {
  PROPOSAL_ACCEPTED: 5.0,       // Creator of an accepted proposal
  IMPLEMENTATION: 10.0,         // Agent that implements accepted proposal
  VOTE_CAST: 0.1,              // Per vote cast (prevents abstention)
  BUG_CATCHING_REVIEW: 2.0,    // Review that catches a real bug
};

// === Agent Transparency ===

export type ActivityAction =
  | 'proposal_created' | 'proposal_commented' | 'proposal_voted' | 'proposal_decided'
  | 'task_accepted' | 'task_in_progress' | 'task_completed' | 'task_failed'
  | 'code_written' | 'code_reviewed' | 'code_deployed'
  | 'analysis_started' | 'analysis_completed' | 'search_handled'
  | 'agent_online' | 'agent_offline' | 'agent_wake_cycle' | 'health_check'
  | 'strategy_update' | 'roadmap_revision' | 'weekly_report_published';

export interface ActivityRecord {
  id: string;
  agentId: string;
  nodeId: string;
  agentRole: string;
  agentTier: 1 | 2;
  modelId: string;
  action: ActivityAction;
  timestamp: number;
  summary: string;
  details?: string;
  proposalId?: string;
  taskId?: string;
  transactionId?: string;
  signature: string;
}

// === File Ownership Registry ===

export interface FileClaim {
  filePath: string;
  claimedBy: string;      // peerId
  claimedAt: number;      // timestamp
  expiresAt: number;      // timestamp (auto-expire after TTL)
}

export interface AgentRosterEntry {
  agentId: string;
  nodeId: string;
  agentRole: string;
  agentTier: 1 | 2;
  modelId: string;
  status: 'active' | 'idle' | 'sleeping' | 'offline';
  lastAction?: string;
  lastActionTime?: number;
  wakeUpCount: number;
  capabilities: string[];
}

// === Agent Scoring ===

export interface AgentScore {
  peerId: string;
  totalCommits: number;
  successfulBuilds: number;
  failedBuilds: number;
  revertsTriggered: number;
  proposalsCreated: number;
  proposalsAccepted: number;
  score: number;            // (successfulBuilds / totalCommits) * 100
  updatedAt: number;
}

// === Health Monitor Types (Phase 9) ===

export interface MonitorConfig {
  checkIntervalMs: number;        // How often to check health (default: 30s)
  stuckPeerThresholdMs: number;   // Alert if 0 peers for this long (default: 5min)
  failureRateThreshold: number;   // Alert if failure rate exceeds this (default: 0.5 = 50%)
  failureRateWindowMs: number;    // Window for failure rate calculation (default: 1h)
  maxConsecutiveFailures: number;  // Alert after N consecutive task failures (default: 3)
  memoryUsageThreshold: number;   // Alert if heap used exceeds this fraction (default: 0.85 = 85%)
  eventLoopLagThresholdMs: number; // Alert if event loop lag exceeds this (default: 500ms)
  ledgerSyncLagThresholdMs: number; // Alert if ledger sync stale longer than this (default: 10min)
  spawnFailureRateThreshold: number; // Alert if agent spawn failure rate exceeds this (default: 0.6 = 60%)
  spawnFailureWindowMs: number;   // Window for spawn failure rate calculation (default: 30min)
}

export type MonitorHealthStatus = 'healthy' | 'degraded' | 'critical';
export type MonitorAlertSeverity = 'info' | 'warning' | 'critical';
export type MonitorAlertType = 'scheduler_down' | 'no_peers' | 'high_failure_rate' | 'stuck_tasks' | 'consecutive_failures' | 'high_memory_usage' | 'event_loop_lag' | 'ledger_sync_lag' | 'agent_spawn_failures';

export interface HealthMetrics {
  timestamp: number;
  nodeHealth: MonitorHealthStatus;
  peerCount: number;
  schedulerRunning: boolean;
  activeTasks: number;
  recentSuccessRate: number;      // 0-1, calculated over failure window
  consecutiveFailures: number;
  uptimeSeconds: number;
  lastTaskCompletedAt: number | null;
  alerts: MonitorAlert[];
  // Phase 9.3: Extended system metrics
  memoryUsage?: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    heapUsedFraction: number;     // 0-1
  };
  eventLoopLagMs?: number;
  ledgerSyncLagMs?: number | null; // null if no sync data available
  agentSpawnFailureRate?: number;  // 0-1, over spawn failure window
}

export interface MonitorAlert {
  id: string;
  severity: MonitorAlertSeverity;
  type: MonitorAlertType;
  message: string;
  firstSeen: number;
  lastSeen: number;
  count: number;                  // How many times this alert has fired
  resolved: boolean;
  resolvedAt?: number;
  acknowledged: boolean;
  acknowledgedAt?: number;
}

// === Recovery Action Types (Phase 9.2) ===

export type RecoveryActionType = 'restart_scheduler' | 'submit_diagnostic' | 'reduce_concurrency' | 'reconnect_bootstrap' | 'log_only' | 'force_gc' | 'pause_spawning';

export interface RecoveryAction {
  trigger: MonitorAlertType;      // Alert type that triggers this
  action: RecoveryActionType;     // What to do
  cooldownMs: number;             // Don't re-trigger within this window
  lastTriggeredAt?: number;
  triggerCount: number;
  enabled: boolean;
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  actor: 'monitor' | 'scheduler' | 'guardrails' | 'self-improver';
  action: string;               // Human-readable: "Restarted scheduler", "Submitted diagnostic task"
  reason: string;               // Why: "Scheduler not running for 3 minutes"
  affectedResources: string[];  // Files changed, tasks created, configs modified
  outcome: 'success' | 'failed' | 'rolled_back' | 'pending';
  detail?: string;              // Additional context
  relatedIds: {
    alertId?: string;
    taskId?: string;
    proposalId?: string;
    improvementId?: string;
  };
}

// === Guardrails Types (Phase 9.3) ===

export interface GuardrailConfig {
  protectedPaths: string[];           // Changes to these require approval
  maxSelfChangesPerHour: number;      // Default: 5
  maxSelfChangesPerDay: number;       // Default: 20
  rollbackOnBuildFailure: boolean;    // Default: true
  rollbackOnTestFailure: boolean;     // Default: true
  requireApprovalForCore: boolean;    // Default: true — core package changes need approval
  approvalTimeout: number;            // Default: 86400000 (24h) — ms before auto-reject
}

export type PendingChangeStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'rolled_back';

export interface PendingChange {
  id: string;
  filePaths: string[];                // Files affected
  description: string;                // What the change does
  reason: string;                     // Why the change is proposed
  proposedBy: string;                 // Agent or task that proposed this
  taskId?: string;                    // Related scheduler task
  status: PendingChangeStatus;
  createdAt: number;
  expiresAt: number;                  // createdAt + approvalTimeout
  reviewedAt?: number;
  reviewedBy?: string;
  rejectReason?: string;
}

// === Autonomous Code Pipeline Types (Phase 16) ===

/** Protection tier levels for the autonomous code pipeline. */
export type GuardrailTier = 'Critical' | 'Important' | 'Standard' | 'Low';

/** A protection rule scoped to a specific guardrail tier. */
export interface TieredProtectionRule {
  tier: GuardrailTier;
  pathPatterns: string[];
  requiresApproval: boolean;
  requiresReview: boolean;
  maxChangesPerHour: number;
  description: string;
}

/** Requirements that must be met for changes at a given tier. */
export interface TierRequirements {
  tier: GuardrailTier;
  requiresApproval: boolean;
  requiresReview: boolean;
  requiresTest: boolean;
  requiresBuild: boolean;
  maxChangesPerHour: number;
  cooldownMs: number;
}

/** Configuration for the tiered guardrail system. */
export interface TieredGuardrailConfig {
  tiers: Record<GuardrailTier, TierRequirements>;
  pathToTier: Record<string, GuardrailTier>;
  immutableKernel: string[];
}

/** Represents a specific version of a node component. */
export interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
  preRelease?: string;
  buildMetadata?: string;
}

/** Compatibility information between two node versions. */
export interface VersionCompatibility {
  sourceVersion: NodeVersion;
  targetVersion: NodeVersion;
  compatible: boolean;
  breakingChanges: string[];
  migrationRequired: boolean;
}

/** Semantic protocol version identifier for multi-node coordination. */
export interface ProtocolVersion {
  major: number;
  minor: number;
  patch: number;
}

/** A capability that a node can advertise for version negotiation. */
export interface VersionedCapability {
  name: string;
  version: ProtocolVersion;
  enabled: boolean;
}

/** Full version information for a running node. */
export interface VersionInfo {
  nodeVersion: NodeVersion;
  protocolVersion: ProtocolVersion;
  capabilities: VersionedCapability[];
  minCompatibleVersion: ProtocolVersion;
  buildTimestamp: number;
}

/** Version requirement for a task targeting specific node capabilities. */
export interface TaskVersionRequirement {
  taskId: string;
  minimumVersion: NodeVersion;
  preferredVersion?: NodeVersion;
  requiredFeatures: string[];
}

/** A set of patches to be applied atomically. */
export interface PatchSet {
  id: string;
  description: string;
  changes: FileChange[];
  createdAt: number;
  appliedAt?: number;
  rolledBackAt?: number;
}

/** Represents a single file change in a patch set. */
export interface FileChange {
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  oldContent?: string;
  newContent?: string;
  diff?: string;
}

/** Result of merging changes from the autonomous pipeline. */
export interface MergeResult {
  success: boolean;
  mergedFiles: string[];
  conflicts: MergeConflict[];
  patchSetId: string;
}

/** Describes a merge conflict encountered during pipeline execution. */
export interface MergeConflict {
  filePath: string;
  reason: string;
  ourContent: string;
  theirContent: string;
  resolved: boolean;
  resolution?: string;
}

/**
 * Information needed to roll back a set of changes.
 * Uses Record<string, string | null> for serialization compatibility (no Map).
 */
export interface RollbackInfo {
  patchSetId: string;
  originalFiles: Record<string, string | null>;
  rolledBackAt?: number;
  reason?: string;
}

/**
 * Result of a full pipeline execution cycle.
 * NOTE: All fields are JSON-serializable (no Map, Set, or class instances)
 * to allow safe persistence and cross-process transfer.
 */
export interface PipelineResult {
  pipelineId: string;
  success: boolean;
  patchSet?: PatchSet;
  mergeResult?: MergeResult;
  rollbackInfo?: RollbackInfo;
  buildPassed: boolean;
  testPassed: boolean;
  tier: GuardrailTier;
  startedAt: number;
  completedAt: number;
  error?: string;
}

// === Request/Reply Messaging Types (Phase 10.1) ===

export interface PandoRequest {
  requestId: string;         // UUID
  from: string;              // Sender peer ID
  to: string;                // Target peer ID (or "*" for broadcast query)
  type: string;              // Request type: "profile_query", "verify_code", "health_check", etc.
  payload: any;              // Request data (must fit in 8KB with envelope)
  timeout: number;           // ms — how long sender waits for reply
  timestamp: number;
}

export interface PandoReply {
  requestId: string;         // Matches the request
  from: string;              // Responder peer ID
  to: string;                // Original requester peer ID
  type: string;              // Same type as request
  payload: any;              // Response data
  success: boolean;          // Did the handler succeed?
  error?: string;            // Error message if !success
  timestamp: number;
}

// === Multi-Planner Consensus Types (Phase 10.4) ===

export type ConsensusStrategy = 'unanimous' | 'majority' | 'best_score' | 'no_consensus';

// === QA Tier Classification (Phase 17.1) ===

/** QA tier — determines what level of testing is needed after a task completes */
export enum QaTier {
  NONE = 'none',
  CODE = 'code',
  BUILD = 'build',
  BROWSER = 'browser',
  CRITICAL = 'critical',
}

// === Conversation Thread Types (Phase 18.3) ===

/** A single message in a task's conversation thread. */
export interface ThreadMessage {
  id: string;                    // Unique message ID (SHA-256 hash)
  taskId: string;                // ID of the task this message belongs to
  from: string;                  // peerId of the sender
  role: 'user' | 'agent' | 'system';  // Role badge for display
  content: string;               // Message text
  createdAt: number;             // Timestamp (ms since epoch)
}

// === QA Runner Types (Phase 16.4) ===

/** Result of testing a single page or API endpoint. */
export interface PageResult {
  url: string;
  status: 'passed' | 'failed' | 'error' | 'timeout';
  consoleErrors: string[];
  screenshotPath?: string;
  durationMs: number;
  error?: string;
}

/** Aggregated result of a full QA test run. */
export interface QAResult {
  success: boolean;
  totalPages: number;
  passed: number;
  failed: number;
  errors: number;
  timeouts: number;
  pages: PageResult[];
  durationMs: number;
  startedAt: number;
  completedAt: number;
}

/** Result of a post-deploy health check. */
export interface HealthCheckResult {
  success: boolean;
  gatewayPages: PageResult[];
  apiEndpoints: PageResult[];
  schedulerRunning: boolean;
  durationMs: number;
  timestamp: number;
}

// === Phase 17.5: API Test Case Types ===

/** A structured test case for API-level QA testing. */
export interface ApiTestCase {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: any;
  expectedStatus: number;
  expectedFields?: string[];     // Fields that must exist in response JSON
  authRequired?: boolean;        // Whether the endpoint requires Bearer token auth
  description?: string;          // Human-readable test description
}

// === Phase 17.6: Regression Suite Types ===

/** A single regression test with metadata and history. */
export interface RegressionTest {
  id: string;
  description: string;
  category: 'api' | 'browser' | 'p2p' | 'ledger' | 'governance';
  test: ApiTestCase;
  addedAt: number;
  lastRun?: number;
  lastResult?: 'pass' | 'fail';
}

/** Aggregated result of running the regression suite. */
export interface RegressionResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  results: RegressionTestResult[];
  runAt: number;
}

/** Result of a single regression test within a suite run. */
export interface RegressionTestResult {
  test: RegressionTest;
  passed: boolean;
  error?: string;
  durationMs: number;
  responseStatus?: number;
}

// === Phase 18.6: Payment Gating Types ===

/** Cost estimate for a task or request. */
export interface CostEstimate {
  luxAmount: number;
  breakdown: { compute: number; storage: number; network: number };
  tier: 'free' | 'basic' | 'standard' | 'premium';
}

/** A payment hold — Lux escrowed for a pending task. */
export interface PaymentHold {
  holdId: string;
  peerId: string;
  taskId: string;
  amount: number;
  status: 'held' | 'released' | 'refunded';
  createdAt: number;
  updatedAt: number;
}

/** Record of a payment event (hold release, refund, or earning). */
export interface PaymentRecord {
  holdId: string;
  peerId: string;
  taskId: string;
  amount: number;
  type: 'payment' | 'refund' | 'earning';
  timestamp: number;
}

// === Unified Identity System (Ed25519-based) ===

/** Public-facing user identity info (no private key or password hash). */
export interface UserAccountPublic {
  peerId: string;
  publicKey: string;
  username?: string;
  displayName?: string;
  isClaimed: boolean;
  createdAt: number;
}

/** A persistent auth session token stored in SQLite. */
export interface AuthSession {
  token: string;                 // 64-byte random hex
  peerId: string;                // References identities.peer_id
  createdAt: number;
  expiresAt: number;
  lastActiveAt: number;
  ipAddress?: string;
  userAgent?: string;
}

/** Result of an auth operation (guest creation, claim, login). */
export interface AuthResult {
  success: boolean;
  error?: string;
  token?: string;
  peerId?: string;
  publicKey?: string;
  username?: string;
  isClaimed?: boolean;
  /** True only when this call created a brand-new account (not a reconnect/re-session). */
  isNewAccount?: boolean;
}

// === Phase 31.1: Project Economy Types ===

export type ProjectType = 'private' | 'shared' | 'public';
export type ProjectVisibility = 'owner_only' | 'collaborators' | 'listed' | 'featured';
export type ProjectRevenueModel = 'none' | 'usage_fee' | 'subscription' | 'contribution_split';
export type ProjectStatus = 'active' | 'archived' | 'transferred';
export type ProjectRole = 'owner' | 'admin' | 'collaborator' | 'viewer' | 'qa_lead';

/** Phase 70: Deployment tier — Tier 1 (S3 static) or Tier 2 (EC2 compute) */
export type DeploymentTier = 1 | 2;

export interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  type: ProjectType;
  visibility: ProjectVisibility;
  revenueModel: ProjectRevenueModel;
  revenueConfig: Record<string, any>;
  budgetSpent: number;
  budgetLimit: number;
  threadId: string;
  managerAgentId: string;
  deploymentUrl: string;
  deploymentType: string;
  deploymentStatus: string;
  status: ProjectStatus;
  createdAt: number;
  updatedAt: number;
  repoUrl?: string;
  teamHistory?: string;
  notes?: string;
  /** Phase 53: Resources assigned to this project */
  resources?: Array<{
    type: string;           // 'mongodb', 's3', 'github', 'compute'
    resourceId: string;     // References ResourceRegistry resourceId
    assignedAt: number;     // Timestamp
    status: 'active' | 'suspended' | 'migrating';
  }>;
  /** Phase 53: Project-scoped API key for Resource Proxy access */
  apiKey?: string;
  /** Phase 70: Deployment tier — 1 (S3 static) or 2 (EC2 compute) */
  tier?: DeploymentTier;
  /** Phase 70: For Tier 2 — actual port the app runs on */
  deploymentPort?: number;
  /** Phase 70: For Tier 2 — which EC2 instance hosts this app (legacy, use deployPeerId) */
  instanceId?: string;
  /** Phase 87: PeerId of the compute node hosting this app (replaces instanceId for routing) */
  deployPeerId?: string;
  /** Phase 70: GitHub repo name e.g. "pando-lux/app-guestbook-abc123" */
  githubRepo?: string;
}

export interface ProjectCollaborator {
  projectId: string;
  userId: string;
  role: ProjectRole;
  addedAt: number;
  addedBy: string;
}

// === Phase 31.4: Revenue Engine Types ===

export type RevenueSource = 'usage_fee' | 'subscription' | 'tip' | 'one_time';
export type TransferType = 'direct' | 'sale' | 'network';
export type TransferStatus = 'pending' | 'completed' | 'cancelled';

export interface ProjectRevenue {
  id: string;
  projectId: string;
  source: RevenueSource;
  amount: number;
  payerId: string;
  createdAt: number;
}

export interface RevenueDistributionEntry {
  userId: string;
  role: string;
  share: number;   // 0-1 fraction
  amount: number;   // Lux
}

export interface RevenueDistributionRecord {
  id: string;
  projectId: string;
  periodStart: number;
  periodEnd: number;
  totalRevenue: number;
  distributions: RevenueDistributionEntry[];
  createdAt: number;
}

export interface RevenueSummary {
  totalRevenue: number;
  thisMonth: number;
  lastMonth: number;
  bySource: Record<string, number>;
}

export interface DistributionResult {
  success: boolean;
  distributed: number;
  recipients: RevenueDistributionEntry[];
  error?: string;
}

export interface ProjectSubscription {
  projectId: string;
  userId: string;
  tier: string;
  priceLux: number;
  startedAt: number;
  expiresAt: number;
  autoRenew: boolean;
}

// === Phase 31.5: Project Invite Types ===

export interface ProjectInvite {
  id: string;
  projectId: string;
  code: string;
  role: ProjectRole;
  createdBy: string;
  expiresAt: number;
  maxUses: number;
  usedCount: number;
}

export interface InviteUseResult {
  success: boolean;
  projectId?: string;
  role?: ProjectRole;
  error?: string;
}

// === Phase 31.6: Project Transfer Types ===

export interface ProjectTransfer {
  id: string;
  projectId: string;
  fromUser: string;
  toUser: string;
  transferType: TransferType;
  salePrice: number;
  escrowHoldId: string;
  status: TransferStatus;
  createdAt: number;
  completedAt: number;
}

// === Adaptive Chat Intelligence Types (Phase 23) ===

/** Complexity level for chat message routing. */
export type ComplexityLevel = 'simple' | 'medium' | 'complex';

/** A single message in a chat conversation. */
export interface ChatMessageRecord {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tier: ComplexityLevel;
  timestamp: number;
  projectId?: string;
  taskCreated?: string; // task ID if chat created a task
}

/** An active or historical chat session. */
export interface ChatSessionRecord {
  sessionId: string;
  type: 'node' | 'project';
  projectId?: string;
  tier: ComplexityLevel;
  messages: ChatMessageRecord[];
  claudeSessionId?: string; // For --continue --resume
  createdAt: number;
  lastActive: number;
  status: 'active' | 'idle' | 'closed';
}

/** Summary info for a project chat session. */
export interface ProjectChatInfo {
  projectId: string;
  sessionId?: string;
  messageCount: number;
  lastActive: number;
  status: string;
}

// === Resource Proof Types (Phase 12.3) ===

/** Result of a single resource proof challenge. */
export interface ProofResult {
  peerId: string;
  challengeType: 'storage' | 'compute' | 'bandwidth';
  passed: boolean;
  responseTimeMs: number;
  timestamp: number;
  details?: string;
}

/** Aggregated proof score for a peer across all challenge types. */
export interface ProofScore {
  peerId: string;
  storageScore: number;   // 0-1
  computeScore: number;   // 0-1
  bandwidthScore: number;  // 0-1
  totalChallenges: number;
  lastChallenge: number;
}

// === Reputation-Weighted Governance Types (Phase 12.4) ===

/** Result of a weighted quorum check. */
export interface QuorumResult {
  reached: boolean;
  totalWeight: number;
  approveWeight: number;
  rejectWeight: number;
  quorumThreshold: number;
}

/** Full weighted vote result including per-voter weights. */
export interface WeightedVoteResult {
  outcome: 'passed' | 'rejected' | 'pending';
  approveWeight: number;
  rejectWeight: number;
  abstainWeight: number;
  totalWeight: number;
  quorumReached: boolean;
  quorumThreshold: number;
  voterWeights: Array<{ peerId: string; weight: number; choice: string }>;
}

// === Content Safety Types (Phase 12.5) ===

/** Result of a content safety review. */
export interface SafetyReview {
  reviewId: string;
  contentId?: string;
  timestamp: number;
  score: number;           // 0-1, 1 = safe
  passed: boolean;
  findings: SafetyFinding[];
  reviewerPeerId: string;
}

/** A single finding from a content safety review. */
export interface SafetyFinding {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'harmful_content' | 'malicious_code' | 'vulnerability' | 'owasp' | 'two_laws';
  description: string;
  file?: string;
  line?: number;
}

// === Content Layer Types (Phase 11) ===

export type ContentType = 'website' | 'api' | 'dataset' | 'service' | 'document' | 'tool';
export type ContentStatus = 'live' | 'draft' | 'archived';
export type UpgradePolicy = 'owner-only' | 'governance' | 'auto-maintain';
export type QualityGate = 'none' | 'build' | 'test' | 'browser';

export interface ContentManifest {
  upgradePolicy: UpgradePolicy;
  maintainerProfile?: string;
  updateSchedule?: string; // cron-like
  qualityGate?: QualityGate;
}

export interface ContentRecord {
  contentId: string;
  type: ContentType;
  title: string;
  description: string;
  ownerPeerId: string;
  builderPeerId?: string;
  repoUrl?: string;
  liveUrl?: string;
  hostingNodes: string[];
  version: number;
  versionHash: string;
  status: ContentStatus;
  tags: string[];
  luxEarned: number;
  manifest: ContentManifest;
  createdAt: number;
  updatedAt: number;
}

export interface ContentSearchResult {
  content: ContentRecord;
  relevanceScore: number;
}

export interface ContentRevenue {
  contentId: string;
  totalLux: number;
  hostingShare: number;  // 40%
  buildingShare: number; // 40%
  networkShare: number;  // 20%
  distributions: RevenueDistribution[];
}

export interface RevenueDistribution {
  peerId: string;
  role: 'hosting' | 'building' | 'network';
  amount: number;
  timestamp: number;
}

export interface ContentStats {
  totalContent: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  totalLuxEarned: number;
}

// === Upgrade Protocol Types (Phase 82 — Simple Git Pull + Hash Verification) ===

export type UpgradeProposalStatus =
  | 'proposed'
  | 'reviewing'
  | 'voting'
  | 'deployed'
  | 'rolled_back'
  | 'rejected';

export interface RiskAssessment {
  filesTouched: string[];
  systemsAffected: string[];
  rollbackPlan: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

// Phase 82: Upgrade payload — just commit hash + description (no patch bytes)
export interface UpgradePayload {
  commitHash: string;       // The approved git commit hash
  description: string;      // Human-readable description
  filesTouched?: string[];  // Optional, for info only
}

export interface UpgradeProposal {
  proposalId: string;
  commitHash: string;
  description: string;
  riskAssessment: RiskAssessment;
  reviewPeriodMs: number;
  proposerPeerId: string;
  status: UpgradeProposalStatus;
  createdAt: number;
  governanceProposalId?: string;
}

export interface UpgradeRecord {
  proposalId: string;
  version: string;
  status: 'success' | 'rolled_back' | 'failed';
  appliedAt: number;
  rollbackAt?: number;
  reason?: string;
}

export interface UpgradeStatus {
  currentVersion: string;
  pinnedVersion?: string;
  activeUpgrade?: UpgradeProposal;
  lastUpgrade?: UpgradeRecord;
}

export interface ReviewResult {
  approved: boolean;
  findings: string[];
  reviewer: string;
}

export interface UpgradeQuorumResult {
  reached: boolean;
  approveWeight: number;
  rejectWeight: number;
  margin: number;
}

// === Phase 31.7: Deployment Automation Types ===

export type DeployType = 'vercel' | 'github' | 's3' | 'custom';
export type DeploymentStatus = 'pending' | 'deploying' | 'live' | 'failed' | 'rolled_back';

export interface ProjectDeployment {
  id: string;
  projectId: string;
  deployType: DeployType;
  deployUrl: string;
  deployConfig: Record<string, any>;
  status: DeploymentStatus;
  deployedBy: string;
  deployedAt: number;
  errorMessage: string;
}

// === Phase 31.8: Project Marketplace Types ===

export interface ProjectRating {
  projectId: string;
  userId: string;
  rating: number;       // 1-5
  review: string;
  createdAt: number;
}

export interface ProjectRatingSummary {
  ratings: ProjectRating[];
  avgRating: number;
  totalRatings: number;
}

export interface MarketplaceQuery {
  category?: string;
  sortBy?: 'newest' | 'rating' | 'popular';
  search?: string;
  limit?: number;
  offset?: number;
}

export interface MarketplaceListResult {
  projects: Project[];
  total: number;
}

// === Phase 31.9: Contribution Tracking Types ===

export type ContributionType = 'code' | 'review' | 'test' | 'design' | 'management' | 'documentation';

export interface ProjectContribution {
  id: string;
  projectId: string;
  userId: string;
  contributionType: ContributionType;
  description: string;
  verified: boolean;
  verifiedBy: string;
  weight: number;
  agentId: string;
  createdAt: number;
}

export interface ContributionScore {
  projectId: string;
  userId: string;
  rawScore: number;
  decayedScore: number;
  lastCalculated: number;
}

export interface RevenueShare {
  userId: string;
  share: number;  // 0-1 proportional share
}

// === Phase 31.10: Content Safety — Reporting Types ===

export type ReportReason = 'spam' | 'malicious' | 'inappropriate' | 'copyright' | 'other';
export type ReportStatus = 'pending' | 'reviewing' | 'resolved' | 'dismissed';
export type ReportAction = 'archive' | 'delist' | 'none';

export interface ContentReport {
  id: string;
  projectId: string;
  reporterId: string;         // userId who reported
  reason: ReportReason;
  description: string;
  status: ReportStatus;
  aiReview: string;           // JSON: AI review result
  aiSafetyScore: number;      // -1 = not reviewed, 0 = unsafe, 1 = safe
  reviewedBy: string;         // userId or 'ai' or governance proposalId
  resolvedAt: number;
  createdAt: number;
}

export interface ReportStats {
  total: number;
  pending: number;
  reviewing: number;
  resolved: number;
  dismissed: number;
}

// === Phase 32: S3 Hosting Service Types ===

export interface DeploymentInfo {
  deployed: boolean;
  projectId: string;
  projectType: ProjectType;
  url: string;
  fileCount: number;
  totalSize: number;    // bytes
  deployedAt: number;   // epoch ms
}

// === Phase 42.5: Resource Registry Types ===

export type ResourceCredentialType = 'ai_api_key' | 'storage_db' | 'storage_blob' | 'cloud_compute' | 'hosting_platform' | 'code_repository';

export interface ResourceRecord {
  resourceId: string;
  type: ResourceCredentialType;
  userId?: string;              // resource OWNER — the user who contributed this
  grantedTo: string[];          // ['*'] = all, or specific userIds
  maxUsagePerDay: number;       // 0 = unlimited
  pricePerUnit: number;         // Lux per unit
  registeredAt: number;
  expiresAt: number | null;
  status: 'active' | 'revoked' | 'exhausted';
  metadata?: Record<string, any>;
  // Phase 69: Credentials stored in MongoDB CredentialStore (encrypted with master key).
  // Only EC2 compute nodes with CREDENTIAL_MASTER_KEY can decrypt.
  // P2P syncs metadata only — no credentials in GossipSub or local SQLite.
}

// === Phase 63: P2P Project Registry Types ===

export interface ProjectRegistryRecord {
  projectId: string;
  name: string;
  ownerPeerId: string;
  ownerUsername?: string;
  apiKeyHash: string;         // SHA-256 hash — never the plaintext key
  visibility: string;         // Use string not ProjectVisibility to avoid import issues
  resourceIds: string[];      // References to ResourceRegistry resource IDs
  deploymentUrl?: string;     // Where the app is hosted (legacy — use liveUrl)
  deploymentType?: string;    // s3, ec2, github-pages
  description?: string;       // For marketplace display
  status: string;             // 'active' | 'paused' | 'archived'
  registeredAt: number;
  updatedAt: number;
  /** Phase 70: Deployment tier — 1 (S3 static) or 2 (EC2 compute) */
  tier?: DeploymentTier;
  /** Phase 70: Actual working URL (S3 endpoint or http://ip:port/) */
  liveUrl?: string;
  /** Phase 70: GitHub repo name e.g. "pando-lux/app-guestbook-abc123" */
  githubRepo?: string;
  /** Phase 70: For Tier 2 — which EC2 instance */
  instanceId?: string;
  /** Phase 70: For Tier 2 — which port */
  deploymentPort?: number;
  /** Phase 70: Last deploy timestamp */
  lastDeployedAt?: number;
}

// Phase 64: Node specialization modes
// 'full' = everything (default, double-click launcher)
// 'compute' = P2P + hosting + resource proxy (auto-set for cloud instances)
// 'relay' = P2P only, network routing + growth
export type NodeMode = 'full' | 'compute' | 'relay';

// Phase 64: Ledger retention modes
// 'full' = all transactions forever (default)
// 'light' = last 30 days + balance checkpoints (for scale)
export type LedgerMode = 'full' | 'light';

// Phase 64: Cloud instance tracking
export interface CloudInstanceRecord {
  instanceId: string;
  resourceId: string;         // AWS creds resource from ResourceRegistry
  region: string;
  instanceType: string;
  publicIp: string | null;
  peerId: string | null;      // assigned after node boots and connects to P2P
  status: 'launching' | 'running' | 'stopped' | 'terminated' | 'error';
  launchedAt: number;
  terminatedAt: number | null;
  mode: NodeMode;
  apps: string[];             // project IDs deployed on this instance
  error: string | null;
}

// ── v2.1: Agent Template with Capability Declarations ────────────────────────

/**
 * AgentTemplate — the configuration that defines an agent's role and permissions.
 *
 * Capabilities are declared by the template and enforced by the sandbox.
 * For v2.1: the format exists so we never rewrite templates when the
 * marketplace is built. Enforcement (community sandbox) is post-v2.
 */
export interface AgentTemplate {
  role: string;               // 'manager', 'builder', 'tester', 'reviewer', 'researcher', 'devops'
  template: string;           // Markdown instructions for the agent
  version: number;            // Template version — for marketplace update checks
  capabilities: AgentCapabilityDeclaration;
  publisherPeerId?: string;   // Who published this (set for marketplace agents)
  requiredBackends?: string[]; // Specific AI backends needed (e.g. ['ollama'])
}

export interface AgentCapabilityDeclaration {
  textAI: boolean;         // Needs text generation (LLM)
  imageAI: boolean;        // Needs image generation (ComfyUI, DALL-E)
  codeExecution: boolean;  // Needs Claude Code-style execution (file edits, bash)
  localFiles: boolean;     // Needs Local Environment file access (v2.5)
  internet: boolean;       // Needs outbound HTTP (fetch to external URLs)
  p2pMessaging: boolean;   // Can message other nodes' agents
}

/** Default capabilities for built-in agents (manager, builder, etc.) */
export const DEFAULT_AGENT_CAPABILITIES: AgentCapabilityDeclaration = {
  textAI: true,
  imageAI: false,
  codeExecution: true,
  localFiles: false,
  internet: true,
  p2pMessaging: true,
};
