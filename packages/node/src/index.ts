// @know
// entity PandoNode {
//   type: module
//   blueprint: NODE_CORE
//   status: active
//   description: "Main PandoNode class that wires together all subsystems (kernel, core, platform layers), manages startup/shutdown lifecycle, and exposes getters for every subsystem."
//   depends_on: [PandoNetwork, PandoLedger, ApiServer, LedgerSync, GovernanceSync, Orchestrator, Scheduler, HealthMonitor, Guardrails, EmissionWitness, SecurityMonitor, CapabilityRegistry, ResourceRegistry, StorageBackend]
//   @gotcha("PandoNode is a GOD OBJECT with 50+ private fields — each subsystem is nullable and initialized conditionally during start(). Always null-check before use.")
//   @gotcha("detectClaudeCode() has a 3-second timeout — on slow systems (Windows especially) this can delay startup.")
//   @gotcha("Daily emission cap (500 Lux) is tracked in-memory (dailyEmissions) and reset by date string comparison — restarting the node resets the counter.")
//   @gotcha("Peer exchange runs at 5s after each peer connect, plus 30s and 90s after boot. It shares addresses from getConnectedPeerAddresses() which includes peerStore announce addresses for NAT/VPC traversal.")
//   @gotcha("Governance re-sync runs every 5 min to catch missed votes/decisions in thin GossipSub meshes (<6 peers).")
//   @why("Subsystems are initialized in layered order: kernel (network, ledger, sync) -> core (agents, storage) -> platform (scheduler, resources). This matches the import boundary rule.")
// }
// @end

import { loadOrCreateIdentity, loadRawIdentityFile, saveIdentity, type NodeIdentity, type NodeConfig, WorkType, MessageType, NodeCapability, type CapabilityDeclaration, type NodeHealth, type OperationalMode } from '@pando/shared';
import { PandoLedger } from '@pando/ledger';
import { PandoNetwork } from './kernel/network.js';
import { ApiServer } from './api/api-server.js';
import { LedgerSync } from './kernel/sync.js';
import { GovernanceSync } from './kernel/governance.js';
import { FileRegistry } from './platform/file-registry.js';
import { Scheduler } from './platform/scheduler.js';
import { TaskQueue } from './platform/task-queue.js';
import { HealthMonitor } from './kernel/monitor.js';
import { Guardrails } from './kernel/guardrails.js';
import { RequestReplyManager } from './core/request-reply.js';
import { ReputationManager } from './kernel/reputation.js';
import { AgentDatabase } from './platform/agent-database.js';
import { MessageBus } from './core/message-bus.js';
import { WorkerPool } from './core/worker-pool.js';
import { OrgManager } from './platform/org-manager.js';
import { Orchestrator } from './platform/orchestrator.js';
import { EmissionWitness, TOPIC_EMISSIONS } from './kernel/emission-witness.js';
import { SecurityMonitor } from './kernel/security-monitor.js';
import { ResourceProofChallenger } from './platform/resource-proof.js';
import { ReputationWeightedGovernance } from './platform/reputation-governance.js';
import { ContentSafetyReviewer } from './platform/content-safety.js';
import { GenomeBridge, GenomeBridgeRegistry } from './platform/genome-bridge.js';
import { TemplateRegistry } from './platform/template-registry.js';
import { ScenarioRunner } from './platform/scenario-runner.js';
import { ContentRegistry } from './platform/content-registry.js';
import { ContentPublisher } from './platform/content-publish.js';
import { ContentMaintenance } from './platform/content-maintenance.js';
import { PipelineRunner } from './platform/pipeline-runner.js';
import { CodePipeline } from './platform/code-pipeline.js';
import { QaRunner } from './platform/qa-runner.js';
import { DeployManager } from './core/deploy-manager.js';
import { VersionProtocol } from './core/version-protocol.js';
import { detectCapabilities, detectCapabilityProfile, type DetectionResult } from './platform/capability-detector.js';
import { CapabilityRegistry } from './platform/capability-registry.js';
import { LocalCapabilityStore } from './platform/local-capability-store.js';
import { ResourceRouter } from './platform/resource-router.js';
import { ResourceMeter } from './platform/resource-meter.js';
import { ResourceMarketplace } from './platform/resource-marketplace.js';
import { ResourceRegistry } from './platform/resource-registry.js';
import { ResourceHealthChecker } from './platform/resource-health.js';
import { CredentialStore } from './core/credential-store.js';
import type { CapabilityProfile } from '@pando/shared';
import { getDefaultConfig } from './config.js';
const RESTART_EXIT_CODE = 75;
import { UpgradeProtocol, safeGitReset } from './core/upgrade-protocol.js';
import { RegressionSuite } from './platform/regression-suite.js';
import { PaymentGate } from './core/payment-gate.js';
import { UserAccountStore } from './platform/user-accounts.js';
import { ProjectStore } from './platform/project-store.js';
import { ProjectRegistry, TOPIC_PROJECTS } from './platform/project-registry.js';
import { RevenueEngine } from './platform/revenue-engine.js';
import { ContributionTracker } from './platform/contribution-tracker.js';
import { GenomeAgent } from './platform/genome-agent.js';
// Council replaced by Orchestrator
import { NetworkState } from './kernel/network-state.js';
import { ThreadStore } from './platform/thread-store.js';
import { HostingService } from './platform/hosting-service.js';
import { CloudInstanceManager } from './core/cloud-instance-manager.js';
import type { StorageBackend } from './core/storage-backend.js';
import { AIBackendRegistry } from './core/ai-backend-registry.js';
import { ClaudeBackend } from './core/ai-backend-claude.js';
import { OllamaBackend } from './core/ai-backend-ollama.js';
import { LocalEnvironment } from './kernel/local-environment.js';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { join } from 'node:path';
import { homedir, freemem, totalmem } from 'node:os';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';

/** Phase 68.2: Single constant for the node-level manager ID. */
const DEFAULT_MANAGER_ID = 'pando-node-mgr';

/**
 * Phase 52.3: Detect if Claude Code CLI is installed and available in PATH.
 * Used to auto-enable the scheduler when Claude Code is present.
 * Has a 10-second timeout to handle slow Windows startup.
 */
export function detectClaudeCode(): boolean {
  try {
    if (process.platform === 'win32') {
      execSync('where claude', { stdio: 'ignore', timeout: 10000 });
    } else {
      execSync('which claude', { stdio: 'ignore', timeout: 10000 });
    }
    return true;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT = 'You are Pando, a helpful AI search assistant on a decentralized open network. Answer the following question clearly and concisely. If you\'re not sure, say so.';

interface SearchResult {
  answer: string;
  sources: string[];
  confidence: string;
  respondedBy: string;
}

export class PandoNode {
  private identity: NodeIdentity | null = null;
  private network: PandoNetwork | null = null;
  private ledger: PandoLedger | null = null;
  private apiServer: ApiServer | null = null;
  private sync: LedgerSync | null = null;
  private governance: GovernanceSync | null = null;
  private scheduler: Scheduler | null = null;
  private monitor: HealthMonitor | null = null;
  private guardrails: Guardrails | null = null;
  private requestReply: RequestReplyManager | null = null;
  private reputation: ReputationManager | null = null;
  private agentDb: AgentDatabase | null = null;
  private messageBus: MessageBus | null = null;
  private workerPool: WorkerPool | null = null;
  private orgManager: OrgManager | null = null;
  private councilOrchestrator: Orchestrator | null = null;
  private councilOrchId: string | null = null;
  private emissionWitness: EmissionWitness | null = null;
  private securityMonitor: SecurityMonitor | null = null;
  private resourceProofChallenger: ResourceProofChallenger | null = null;
  private reputationGovernance: ReputationWeightedGovernance | null = null;
  private contentSafetyReviewer: ContentSafetyReviewer | null = null;
  private genomeBridge: GenomeBridge | null = null;
  private genomeBridgeRegistry: GenomeBridgeRegistry | null = null;
  private templateRegistry: TemplateRegistry | null = null;
  private scenarioRunner: ScenarioRunner | null = null;
  private pipelineRunner: PipelineRunner | null = null;
  private pipelineEnabled = false;
  private schedulerEnabled = false;
  private agentSystemStarted = false;
  private monitorEnabled = false;
  private taskQueue: TaskQueue | null = null; // passive task queue — always available for API + P2P sync
  private fileRegistry: FileRegistry;
  private config: NodeConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private uptimeEpochs: number = 0;
  private dailyEmissions: number = 0;
  private dailyEmissionResetDate: string = '';
  private uptimeTimer: ReturnType<typeof setInterval> | null = null;
  private errorHandlersRegistered = false;
  private lastSnapshotTxCount: number = 0;
  private snapshotInterval: number = 100; // auto-snapshot every N transactions
  private restartPending = false;
  private upgradeInProgress = false;
  // Phase 8.3: Per-task emitters for remote timeline events (SSE streaming)
  private remoteTaskEmitters: Map<string, EventEmitter> = new Map();
  private detectedCapabilities: string[] = [];
  private capabilityDetection: DetectionResult | null = null;
  // Phase 34: Restart handler — allows TUI/caller to intercept restarts
  private restartHandler: ((reason: string, changedFiles?: string[]) => void) | null = null;
  private upgradeCallbacks: Array<(info: { version: string; peerId: string }) => void> = [];
  private peerCapabilities: Map<string, CapabilityDeclaration> = new Map();
  private capabilityRegistry: CapabilityRegistry = new CapabilityRegistry();
  // Phase 96: Local capability store — separates detection from sharing
  private localCapStore: LocalCapabilityStore | null = null;
  private capabilityBroadcastTimer: ReturnType<typeof setInterval> | null = null;
  private resourceRouter: ResourceRouter | null = null;
  private resourceMeter: ResourceMeter | null = null;
  private resourceMarketplace: ResourceMarketplace | null = null;
  private resourceRegistry: ResourceRegistry | null = null;
  private resourceHealthChecker: ResourceHealthChecker | null = null;
  private upgradeProtocol: UpgradeProtocol | null = null;
  private regressionSuite: RegressionSuite | null = null;
  private paymentGate: PaymentGate | null = null;
  // Unified identity system (Ed25519-based accounts)
  private userAccountStore: UserAccountStore | null = null;
  // Phase 31.1: Project Economy
  private projectStore: ProjectStore | null = null;
  // Phase 63: P2P Project Registry
  private projectRegistry: ProjectRegistry | null = null;
  // Phase 31.4: Revenue Engine
  private revenueEngine: RevenueEngine | null = null;
  // Phase 31.9: Contribution Tracker
  private contributionTracker: ContributionTracker | null = null;
  // Phase 11: Content Layer
  private contentRegistry: ContentRegistry | null = null;
  private contentPublisher: ContentPublisher | null = null;
  private contentMaintenance: ContentMaintenance | null = null;
  // Phase 25: Genome Agent
  private genomeAgent: GenomeAgent | null = null;
  // Phase 27: Thread Store for gateway chat
  private threadStore: ThreadStore | null = null;
  // Phase 32: S3 Hosting Service
  private hostingService: HostingService | null = null;
  // Phase 50: Network State Aggregator
  private networkState: NetworkState | null = null;
  // Council orchestrator (replaced Council class)
  // v2.1: AI Backend Registry (exposed for council + subsystems)
  private aiBackendRegistry: AIBackendRegistry | null = null;
  // Phase 64: Cloud Instance Manager (EC2 compute nodes)
  private cloudInstanceManager: CloudInstanceManager | null = null;
  // Phase 42: Pluggable StorageBackend
  private storageBackend: StorageBackend | null = null;
  // Phase 83: Track whether P2P deferred data loading has completed
  private _p2pDataLoaded = false;
  // Phase 55: Linked user account — rewards flow to user, not node
  private linkedUser: { peerId: string; username?: string } | null = null;

  // v2.5: Local Environment — Envelope 1 file indexing + user memory
  private localEnv: LocalEnvironment | null = null;

  // Phase 104: Live orchestrator instances (council + project orchestrators)
  private liveOrchestrators: Map<string, Orchestrator> = new Map();

  // v2.3: Boot health tracking
  private nodeHealth: NodeHealth = {
    mode: 1,
    degraded: [],
    kernel: 'healthy',
    core: 'healthy',
    platform: 'healthy',
    bootSteps: {},
  };

  constructor(config?: Partial<NodeConfig>) {
    this.config = getDefaultConfig(config);
    this.fileRegistry = new FileRegistry();
  }

  /**
   * Check if an identity already exists in the data directory.
   */
  async hasIdentity(): Promise<boolean> {
    const raw = await loadRawIdentityFile(this.config.dataDir);
    return raw !== null;
  }

  /**
   * Import an identity from a file path and save it to this node's data dir.
   */
  async importIdentity(filePath: string): Promise<NodeIdentity> {
    const raw = await import('node:fs/promises').then(fs => fs.readFile(filePath, 'utf-8'));
    const serialized = JSON.parse(raw);
    const { fromString: uint8ArrayFromString } = await import('uint8arrays');
    const identity: NodeIdentity = {
      peerId: serialized.peerId,
      publicKey: uint8ArrayFromString(serialized.publicKey, 'base64'),
      privateKey: uint8ArrayFromString(serialized.privateKey, 'base64'),
      createdAt: serialized.createdAt,
    };
    await saveIdentity(identity, this.config.dataDir);
    return identity;
  }

  /**
   * Phase 42: Set a StorageBackend for user data (threads, messages, user accounts).
   * Call this before start() or startWithIdentity().
   */
  setStorageBackend(backend: StorageBackend): void {
    this.storageBackend = backend;
  }

  /**
   * Phase 42: Get the current StorageBackend (null = no user data storage).
   */
  getStorageBackend(): StorageBackend | null {
    return this.storageBackend;
  }

  /**
   * Phase 42: Get the storage backend type name for status reporting.
   */
  getStorageBackendType(): string {
    if (!this.storageBackend) return 'none';
    // Check class name
    const name = this.storageBackend.constructor?.name || 'unknown';
    if (name === 'MongoStorageBackend') return 'mongodb';
    if (name === 'P2PStorageBackend') return 'p2p';
    return name.toLowerCase().replace('storagebackend', '');
  }

  /**
   * Start with a pre-loaded identity (skips auto-create).
   */
  async startWithIdentity(identity: NodeIdentity): Promise<void> {
    this.identity = identity;
    return this._start();
  }

  /**
   * Start with auto-created identity (headless mode).
   */
  async start(): Promise<void> {
    this.identity = await loadOrCreateIdentity(this.config.dataDir);
    return this._start();
  }

  private async _start(): Promise<void> {
    if (!this.identity) throw new Error('No identity loaded');

    // Prevent crash on unhandled errors (only register once)
    if (!this.errorHandlersRegistered) {
      this.errorHandlersRegistered = true;
      process.on('unhandledRejection', (err) => {
        console.error(`[error] Unhandled rejection: ${err}`);
      });
      process.on('uncaughtException', (err) => {
        console.error(`[error] Uncaught exception: ${err.message}`);
      });
    }

    console.log(`Identity: ${this.identity.peerId}`);

    // Phase 55: Load linked user account (rewards flow to user, not node)
    const linkedUserPath = join(this.config.dataDir || join(homedir(), '.pando'), 'linked-user.json');
    try {
      const data = JSON.parse(readFileSync(linkedUserPath, 'utf-8'));
      if (data.peerId) {
        this.linkedUser = data;
        console.log(`[node] Linked to user account: ${data.username || data.peerId}`);
      }
    } catch { /* no linked user, that's fine */ }

    // Phase 96: Init LocalCapabilityStore before capability detection
    this.localCapStore = new LocalCapabilityStore(this.config.dataDir || undefined);

    this.capabilityDetection = detectCapabilities(this.config.capabilities);
    this.detectedCapabilities = this.capabilityDetection.capabilities.map(c => c as string);
    // Phase 96: Write full detected list to local store (preserves existing sharedCapabilities)
    this.localCapStore.setDetected(this.detectedCapabilities);
    console.log(`Capabilities (local): ${this.detectedCapabilities.join(', ')}`);
    const shared = this.localCapStore.getShared();
    console.log(`Capabilities (shared): ${shared.length > 0 ? shared.join(', ') : '(none — use /contribute to share)'}`);

    // Phase A + 96: Detect rich capability profile for broadcast
    // detectCapabilityProfile reads sharedCapabilities from localCapStore — peers only see what user shared
    const linkedUserForProfile = this.linkedUser?.username ? { username: this.linkedUser.username } : null;
    const capProfile = detectCapabilityProfile(this.identity.peerId, this.config.apiPort, linkedUserForProfile, this.localCapStore);
    this.capabilityRegistry.setLocalProfile(capProfile);
    // Phase 96: Wire LocalCapabilityStore into registry for own-task routing
    this.capabilityRegistry.setLocalCapabilityStore(this.localCapStore);
    const activeResources = Object.entries(capProfile.capabilities)
      .filter(([, v]) => v).map(([k]) => k);
    console.log(`Resources: ${activeResources.join(', ')}`);

    // Initialize ledger
    this.ledger = new PandoLedger(this.config.dataDir || undefined);
    const publicKeyStr = uint8ArrayToString(this.identity.publicKey, 'base64');
    const isNew = !this.ledger.accounts.exists(this.identity.peerId);
    this.ledger.registerNode(this.identity.peerId, publicKeyStr);

    // Genesis allocation for new nodes — bootstrap the economy
    if (isNew) {
      const genesisTx = this.ledger.rewardWork(
        this.identity.peerId,
        WorkType.PEER_RELAYED,
        'genesis: node registration'
      );
      console.log(`Genesis: +${genesisTx.amount} Lux minted`);
      // Genesis tx will be included in catch-up sync (sync not started yet)
    }

    // Check for existing snapshots — load latest for faster bootstrap
    const snapshotInfo = this.ledger.getSnapshotInfo(this.config.dataDir || undefined);
    if (snapshotInfo) {
      console.log(`Snapshot: found ${snapshotInfo.filename} (${snapshotInfo.accountCount} accounts, ${snapshotInfo.transactionCount} txs)`);
      this.lastSnapshotTxCount = snapshotInfo.transactionCount;
    } else {
      this.lastSnapshotTxCount = this.ledger.getNetworkStats().totalTransactions;
    }

    const balance = this.ledger.accounts.getBalance(this.identity.peerId);
    console.log(`Ledger: ${balance} Lux`);

    // Start networking
    this.network = new PandoNetwork(this.identity, this.config);
    await this.network.start();

    const addresses = this.network.getListenAddresses();
    console.log('Listening:');
    for (const addr of addresses) {
      console.log(`  ${addr}`);
    }

    // Start ledger sync (GossipSub)
    this.sync = new LedgerSync(this.network, this.ledger, this.identity.peerId);
    await this.sync.start();

    // Phase 56: Wire user account claim broadcasting to P2P sync
    if (this.userAccountStore && this.sync) {
      this.userAccountStore.setBroadcastClaim((claim) => this.sync!.broadcastClaim(claim));
    }

    // Start governance layer (proposals, voting, agent communication)
    this.governance = new GovernanceSync(this.network, this.identity.peerId, this.ledger.getDatabase());
    await this.governance.start();

    // Wire governance rewards — emit Lux for votes and accepted proposals
    this.governance.setRewardCallback((peerId, workType, workProof) => {
      return this.ledger!.rewardWork(peerId, workType, workProof);
    });

    // Wire governance activity broadcasting — governance events → pando/activity GossipSub
    this.governance.setActivityBroadcaster(async (record) => {
      // Store locally in ledger
      try { this.ledger!.recordActivity(record); } catch {}
      // Broadcast to network
      await this.sync!.broadcastActivity(record);
    });

    // When a new governance proposal arrives, push SSE
    this.governance.onProposal((proposal) => {
      this.apiServer?.pushEvent('proposal', {
        id: proposal.id,
        title: proposal.title,
        proposedBy: proposal.proposedBy,
        status: proposal.status,
        timestamp: proposal.createdAt,
      });
    });

    // Phase 63: P2P Project Registry
    this.projectRegistry = new ProjectRegistry(
      this.network,
      this.identity.peerId,
      this.ledger.getDatabase()
    );
    await this.projectRegistry.start();

    // Wire ProjectRegistry into LedgerSync for catch-up sync
    if (this.sync && this.projectRegistry) {
      this.sync.setProjectRegistry(this.projectRegistry);
    }

    // Initialize EmissionWitness — witness-based emission system
    this.emissionWitness = new EmissionWitness(this.identity.peerId, this.config.dataDir || undefined);
    this.emissionWitness.setNetwork(this.network);
    this.emissionWitness.setLedger(this.ledger);
    this.emissionWitness.setSync(this.sync);
    this.emissionWitness.setPrivateKey(this.identity.privateKey);
    this.emissionWitness.setEmitCallback((peerId, workType, workProof) => {
      try {
        const wt = workType as WorkType;
        const tx = this.ledger!.rewardWork(peerId, wt, workProof);
        this.sync?.broadcastTransaction(tx).catch(() => {});
        return tx;
      } catch (err: any) {
        console.error(`[emission-witness] Mint error: ${err.message}`);
        return null;
      }
    });
    this.emissionWitness.start();

    // Subscribe to 'pando/emissions' GossipSub topic
    await this.network.subscribeTopic(TOPIC_EMISSIONS, (message) => {
      if (!message.payload) return;
      const fromPeerId = message.from || 'unknown';
      if (fromPeerId === this.identity!.peerId) return;
      // Record emission proposal for security abuse detection
      this.securityMonitor?.recordEmissionProposal(fromPeerId);
      this.emissionWitness?.handleMessage(message.payload, fromPeerId);
    });
    console.log(`[emission-witness] Subscribed to GossipSub topic: ${TOPIC_EMISSIONS}`);

    // Initialize SecurityMonitor — anomaly detection + quarantine system
    const dataDir = this.config.dataDir || join(homedir(), '.pando');

    // Write running-commit.txt so the orchestrator's safe-restart guard can
    // detect when a newer build is ready and the node is idle.
    try {
      const headCommit = (execSync('git rev-parse HEAD', {
        cwd: process.cwd(), encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
      }) as string).trim();
      writeFileSync(join(dataDir, 'running-commit.txt'), headCommit);
      console.log(`[node] Running commit: ${headCommit.slice(0, 8)}`);
    } catch { /* git unavailable — skip silently */ }

    this.securityMonitor = new SecurityMonitor(dataDir, this.identity.peerId);
    this.securityMonitor.setNetwork(this.network);
    this.securityMonitor.setLedger(this.ledger);
    if (this.emissionWitness) {
      this.securityMonitor.setEmissionWitness(this.emissionWitness);
    }
    this.securityMonitor.start();

    // Periodic sync cleanup
    this.cleanupTimer = setInterval(() => {
      this.sync?.cleanup();
      this.governance?.cleanup();
    }, 60_000);

    // Create passive TaskQueue — always available for API + P2P task sync
    // (even without --scheduler or --agent)
    this.taskQueue = new TaskQueue(dataDir);
    this.taskQueue.setNetwork(this.network);
    this.taskQueue.setLocalPeerId(this.identity.peerId);

    // Create Guardrails — safety system for self-generated changes (Phase 9.3)
    this.guardrails = new Guardrails(dataDir);

    // Phase 25: Create GenomeAgent — self-maintaining project genome
    const repoDir = process.cwd();
    this.genomeAgent = new GenomeAgent({
      repoDir,
      genomeDir: join(repoDir, 'genome'),
      dataDir,
    });
    if (this.genomeAgent.isAvailable()) {
      console.log('[genome] GenomeAgent initialized (genome.yaml found)');
    }

    // Phase 13: Create UpgradeProtocol — self-evolving upgrade lifecycle
    this.upgradeProtocol = new UpgradeProtocol({
      governance: this.governance!,
      guardrails: this.guardrails,
      dataDir,
      repoDir,
      localPeerId: this.identity.peerId,
      networkProvider: () => this.network,
      workersActiveFn: () => this.workerPool?.getActiveWorkerCount() ?? 0,
      messagesPendingFn: () => this.messageBus?.hasPendingMessages() ?? false,
    });

    // Subscribe to GossipSub task events so all nodes see task changes
    await this.network.subscribeTaskEvents();
    this.network.onTaskEvent((payload, fromPeerId) => {
      if (!this.taskQueue) return;
      if (payload.type === 'created' && payload.task) {
        const task = { ...payload.task, origin: fromPeerId };
        const inserted = this.taskQueue.insertRemoteTask(task);
        if (inserted) {
          console.log(`[task-sync] Received new task from ${fromPeerId.slice(0, 12)}: ${payload.task.title}`);
        }
      } else if (payload.type === 'claimed' && payload.task) {
        // Phase 8: Claim conflict resolution
        const localTask = this.taskQueue.getTask(payload.task.id);
        if (localTask && (localTask.status === 'claimed' || localTask.status === 'in_progress')
            && localTask.claimedByNode === this.identity!.peerId) {
          // We also claimed this task — conflict!
          const remoteClaimedAt = payload.task.claimedAt || 0;
          const localClaimedAt = localTask.claimedAt || 0;
          let weWin = false;
          if (localClaimedAt < remoteClaimedAt) {
            weWin = true;
          } else if (localClaimedAt === remoteClaimedAt) {
            // Tiebreak: lower peerId wins (deterministic)
            weWin = this.identity!.peerId < fromPeerId;
          }
          if (!weWin) {
            // We lost the race — release our local claim
            console.log(`[task] Claim conflict on ${payload.task.id.slice(0, 8)} — ${fromPeerId.slice(0, 12)} wins (earlier claim)`);
            this.taskQueue.forceReleaseTask(payload.task.id);
            // Apply the remote claim
            this.taskQueue.updateRemoteStatus(
              payload.task.id, 'claimed', payload.task.assignedTo,
              undefined, payload.task.claimedByNode,
            );
          } else {
            console.log(`[task] Claim conflict on ${payload.task.id.slice(0, 8)} — we win (earlier claim)`);
          }
        } else {
          // No conflict — apply remote claim normally
          const updated = this.taskQueue.updateRemoteStatus(
            payload.task.id, payload.task.status, payload.task.assignedTo,
            undefined, payload.task.claimedByNode,
          );
          if (updated) {
            console.log(`[task-sync] Task ${payload.task.id.slice(0, 8)} claimed by ${fromPeerId.slice(0, 12)}`);
          }
        }
      } else if (payload.type === 'completed' && payload.task) {
        const executedByNode = payload.executedByNode || payload.task.executedByNode || fromPeerId;
        const updated = this.taskQueue.updateRemoteStatus(
          payload.task.id, payload.task.status, undefined, payload.task.result,
          undefined, executedByNode,
        );
        if (updated) {
          console.log(`[task-sync] Task ${payload.task.id.slice(0, 8)} completed by ${fromPeerId.slice(0, 12)}`);
        }

        // Phase 8: If this task originated from us, store the remote output
        const localTask = this.taskQueue.getTask(payload.task.id);
        if (localTask && localTask.originNode === this.identity!.peerId) {
          if (payload.output) {
            this.taskQueue.storeRemoteOutput(payload.task.id, payload.output, executedByNode);
          }
          // Push remote_completed timeline event
          this.taskQueue.pushTimelineEvent(payload.task.id, {
            event: 'remote_completed',
            detail: `Task executed by remote node ${executedByNode.slice(0, 12)}`,
            metadata: {
              executedByNode,
              duration: payload.duration,
              hasOutput: !!payload.output,
            },
          });
          console.log(`[task] Remote task ${payload.task.id.slice(0, 8)} completed by ${executedByNode.slice(0, 12)}`);
        }
      } else if (payload.type === 'timeline' && payload.task && payload.timelineEvent) {
        // Phase 8.3: Apply remote timeline event to local task
        const applied = this.taskQueue.applyRemoteTimelineEvent(payload.task.id, payload.timelineEvent);
        if (applied) {
          console.log(`[task-sync] Timeline event '${payload.timelineEvent.event}' for task ${payload.task.id.slice(0, 8)} from ${fromPeerId.slice(0, 12)}`);

          // Emit to SSE so gateway can show real-time progress for remote tasks
          // First try the Scheduler's per-task emitter (if scheduler is running and tracking this task)
          const schedulerEmitter = this.scheduler?.getTaskEmitter(payload.task.id);
          if (schedulerEmitter) {
            schedulerEmitter.emit('output', {
              type: 'timeline',
              timestamp: payload.timelineEvent.timestamp,
              event: payload.timelineEvent.event,
              detail: payload.timelineEvent.detail,
              metadata: payload.timelineEvent.metadata,
              remote: true,
              executingNode: payload.executingNode || fromPeerId,
            });
          } else {
            // No scheduler emitter — use remote task emitter for SSE
            let remoteEmitter = this.remoteTaskEmitters.get(payload.task.id);
            if (!remoteEmitter) {
              remoteEmitter = new EventEmitter();
              this.remoteTaskEmitters.set(payload.task.id, remoteEmitter);
              // Auto-cleanup after 30 minutes of inactivity
              setTimeout(() => {
                this.remoteTaskEmitters.delete(payload.task.id);
                remoteEmitter!.removeAllListeners();
              }, 30 * 60 * 1000);
            }
            remoteEmitter.emit('output', {
              type: 'timeline',
              timestamp: payload.timelineEvent.timestamp,
              event: payload.timelineEvent.event,
              detail: payload.timelineEvent.detail,
              metadata: payload.timelineEvent.metadata,
              remote: true,
              executingNode: payload.executingNode || fromPeerId,
            });
          }
        }
      }
    });

    // Subscribe to agent messages (required for request/reply)
    await this.network.subscribeAgentMessages();

    // Start Request/Reply Manager (Phase 10.1) — uses agent-messages topic
    this.requestReply = new RequestReplyManager(this.network);
    await this.requestReply.start();

    // Register built-in request handlers
    this.requestReply.registerHandler('ping', async () => {
      return { pong: true, uptime: Math.floor(process.uptime()), peerId: this.identity!.peerId };
    });

    this.requestReply.registerHandler('health_check', async () => {
      const monitor = this.getMonitor();
      // Include worker process memory (claude.exe / node.exe children)
      const workerStats = this.workerPool?.getWorkerMemoryStats() ?? [];
      const workerMemory = {
        totalWorkerRssBytes: workerStats.reduce((sum, s) => sum + s.rssBytes, 0),
        freeMemBytes: freemem(),
        totalMemBytes: totalmem(),
        perWorker: workerStats,
      };
      if (monitor) {
        const metrics = monitor.getCurrentMetrics();
        return { ...metrics, workerMemory };
      }
      // Fallback basic health info when monitor is not running
      return {
        timestamp: Date.now(),
        nodeHealth: 'healthy',
        peerCount: this.network!.getPeerCount(),
        schedulerRunning: !!this.scheduler,
        uptimeSeconds: Math.floor(process.uptime()),
        workerMemory,
      };
    });

    this.requestReply.registerHandler('profile_query', async () => {
      return []; // Phase 27: ProfileCache removed — agents manage own profiles
    });

    // Phase 98: claude_task — one-shot Claude Code execution for P2P compute routing.
    // Only handles requests when shareCompute=true (user opted in via /contribute claude-code).
    // Receives a prompt, runs claude -p, returns text output. Stateless — no project creation.
    this.requestReply.registerHandler('claude_task', async (req) => {
      if (!this.localCapStore?.isShareCompute()) {
        return { error: 'This node is not sharing compute. Use /contribute claude-code to opt in.' };
      }
      const { prompt, context, model } = req.payload || {};
      if (!prompt) return { error: 'prompt required' };
      const { ClaudeBackend } = await import('./core/ai-backend-claude.js');
      const backend = new ClaudeBackend();
      const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
      const result = await backend.execute({
        type: 'text',
        prompt: fullPrompt,
        options: { model: model || 'claude-opus-4-6' },
      });
      return {
        success: result.success,
        output: result.output,
        error: result.error,
        executedBy: this.identity!.peerId,
      };
    });

    // Remote task queries — allows any node to query this node's tasks via P2P
    this.requestReply.registerHandler('task_list', async (req) => {
      const tasks = this.taskQueue!.getTasks();
      const limit = req.payload?.limit || 50;
      // Return summary: id, title, status, priority, createdAt, cost, tier
      return tasks.slice(0, limit).map((t: any) => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority,
        createdAt: t.createdAt, cost: t.cost, parentTask: t.parentTask,
        childTasks: t.childTasks, executedByNode: t.executedByNode,
      }));
    });

    this.requestReply.registerHandler('task_detail', async (req) => {
      const taskId = req.payload?.taskId;
      if (!taskId) return { error: 'taskId required' };
      const task = this.taskQueue!.getTask(taskId);
      if (!task) return { error: 'Task not found' };
      return task;
    });

    // Subscribe to capability declarations from peers
    await this.network.subscribeCapabilities();
    this.network.onCapabilityDeclaration((declaration, fromPeerId) => {
      this.peerCapabilities.set(fromPeerId, declaration);
      console.log(`[capabilities] Peer ${fromPeerId.slice(0, 12)} declared: [${declaration.capabilities.join(', ')}]`);
    });

    // Phase A: Handle incoming CapabilityProfile messages via GossipSub
    this.network.onCapabilityProfile((profile, fromPeerId) => {
      this.capabilityRegistry.updatePeerProfile(profile);
      const activeResources = Object.entries(profile.capabilities)
        .filter(([, v]) => v).map(([k]) => k);
      console.log(`[capabilities] Peer ${fromPeerId.slice(0, 12)} profile: [${activeResources.join(', ')}]`);
    });

    // Broadcast our capabilities when a new peer connects
    // Uses a triple-broadcast pattern because GossipSub mesh formation
    // takes several seconds after TCP connection — immediate broadcast
    // is often lost before the mesh is ready.
    this.network.onPeerConnect(async (peerId: string) => {
      // Immediate broadcast (may be lost if mesh not ready)
      try {
        await this.broadcastCapabilities();
        await this.broadcastCapabilityProfile();
      } catch {}
      // Delayed rebroadcast after mesh formation
      setTimeout(async () => {
        try {
          await this.broadcastCapabilities();
          await this.broadcastCapabilityProfile();
        } catch {}
      }, 10_000);
      // Final safety net for slow mesh formation
      setTimeout(async () => {
        try {
          await this.broadcastCapabilities();
          await this.broadcastCapabilityProfile();
        } catch {}
      }, 30_000);

      // Phase 92: Direct TCP stream fallback for GossipSub mesh failures.
      // GossipSub requires min D=6 peers in mesh to reliably propagate.
      // Small networks (2-5 nodes) often fail to form a mesh after simultaneous
      // restarts. Direct TCP stream bypasses GossipSub entirely.
      setTimeout(async () => {
        try {
          const profile = this.capabilityRegistry.getLocalProfile();
          if (!profile || !this.network) return;
          profile.updatedAt = Date.now();
          await this.network.sendMessage(peerId, {
            type: MessageType.CAPABILITY_PROFILE_DIRECT,
            from: this.getIdentity()!.peerId,
            timestamp: Date.now(),
            payload: profile,
          });
          console.log(`[capabilities] Direct profile sent to ${peerId.slice(0, 12)}`);
        } catch {}
      }, 2_000);

      // Peer exchange: share our peer list so new nodes can form a full mesh.
      // Delayed 5s to let the connection settle and capability exchange finish first.
      setTimeout(async () => {
        try {
          if (!this.network) return;
          const peerAddrs = (await this.network.getConnectedPeerAddresses())
            .filter(p => p.peerId !== peerId); // don't send them their own address
          if (peerAddrs.length === 0) return;
          await this.network.sendMessage(peerId, {
            type: MessageType.PEER_EXCHANGE,
            from: this.getIdentity()!.peerId,
            timestamp: Date.now(),
            payload: { peers: peerAddrs },
          });
          console.log(`[peer-exchange] Shared ${peerAddrs.length} peer(s) with ${peerId.slice(0, 12)}`);
        } catch {}
      }, 5_000);

      // Phase 69: Auto-wrap removed — credentials in MongoDB, not per-node.

      // Phase 83: Deferred data loading for P2PStorageBackend nodes.
      // When the first compute peer connects, retry loadFromBackend if it failed at startup.
      if (this.getStorageBackendType() === 'p2p' && !this._p2pDataLoaded) {
        setTimeout(async () => {
          if (this._p2pDataLoaded) return;
          try {
            if (this.threadStore) await this.threadStore.loadFromBackend();
            if (this.projectStore) await (this.projectStore as any).loadFromBackend();
            if (this.revenueEngine) await (this.revenueEngine as any).loadFromBackend();
            if (this.contributionTracker) await (this.contributionTracker as any).loadFromBackend();
            this._p2pDataLoaded = true;
            console.log('[data] P2P deferred data loading complete — stores hydrated from compute peer');
          } catch (err: any) {
            console.warn(`[data] P2P deferred loading failed: ${err.message}`);
          }
        }, 5_000); // Wait 5s for capability profile to sync so P2PStorageBackend can find peers
      }
    });

    // Initial broadcast of our capabilities
    try {
      await this.broadcastCapabilities();
      await this.broadcastCapabilityProfile();
    } catch {}

    // Phase A: Re-broadcast capability profile every 5 minutes (heartbeat)
    this.capabilityBroadcastTimer = setInterval(async () => {
      try {
        await this.broadcastCapabilityProfile();
      } catch {}
      // Periodic cleanup of expired profiles
      this.capabilityRegistry.cleanup();
    }, 5 * 60 * 1000);

    // Subscribe to agent events (needed for Phase 10 — reputation, profile sharing)
    await this.network.subscribeAgentEvents();

    // ── Phase 82: Simple P2P Self-Upgrade via GossipSub ──────────────────────
    if (this.upgradeProtocol) {
      const upgradeProtocol = this.upgradeProtocol;

      // Wire broadcast: publish to pando/upgrades topic
      upgradeProtocol.setBroadcast(async (msg: Record<string, unknown>) => {
        const { TOPIC_UPGRADES } = await import('./core/upgrade-protocol.js');
        await this.network!.publishToTopic(TOPIC_UPGRADES, {
          type: 'agent_event' as any, from: this.identity!.peerId, timestamp: Date.now(), payload: msg,
        } as any);
      });

      // Wire restart
      upgradeProtocol.setRequestRestart((reason?: string) => {
        this.requestGracefulRestart(reason);
      });

      // Subscribe to upgrade notifications from peers
      const { TOPIC_UPGRADES } = await import('./core/upgrade-protocol.js');
      await this.network.subscribeTopic(TOPIC_UPGRADES, async (msg: any) => {
        try {
          const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
          if (!payload || payload.type !== 'upgrade_available') return;
          if (payload.fromPeerId === this.identity!.peerId) return;

          const { commitHash, description, governanceId } = payload;
          if (!commitHash) return;
          if (upgradeProtocol.hasApplied(commitHash)) return;
          if (this.upgradeInProgress || this.restartPending) return;

          console.log(`[upgrade] Peer notified: new upgrade available (${commitHash.slice(0, 8)}): ${description}`);
          this.upgradeInProgress = true;
          try {
            const result = await upgradeProtocol.pullAndUpgrade(commitHash);
            if (!result.success) {
              console.error(`[upgrade] Pull failed: ${result.message}`);
            }
          } catch (err: any) {
            console.error(`[upgrade] Failed: ${err.message}`);
          } finally {
            this.upgradeInProgress = false;
          }
        } catch (err: any) {
          console.error(`[upgrade] Error handling pando/upgrades: ${err.message}`);
        }
      });

      // When governance approves an upgrade: pull locally, then broadcast to peers
      if (this.governance) {
        this.governance.onUpgradeApproved(async (govProposal) => {
          const commitHash = govProposal.upgradePayload?.commitHash;
          const description = govProposal.upgradePayload?.description || govProposal.title;
          if (!commitHash) {
            console.warn(`[upgrade] Governance approved but no commitHash in payload`);
            return;
          }
          console.log(`[upgrade] Governance approved upgrade: ${commitHash.slice(0, 8)} — ${description}`);

          // Pull and build locally
          this.upgradeInProgress = true;
          try {
            const result = await upgradeProtocol.pullAndUpgrade(commitHash);
            if (result.success) {
              // Broadcast to all peers so they pull too
              await upgradeProtocol.broadcastUpgradeNotification(commitHash, description, govProposal.id);
            } else {
              console.error(`[upgrade] Local pull failed: ${result.message}`);
            }
          } catch (err: any) {
            console.error(`[upgrade] Upgrade failed: ${err.message}`);
          } finally {
            this.upgradeInProgress = false;
          }
        });
      }
      // Start catch-up timer: periodically scans governance for missed upgrades
      // Handles case where proposer goes offline before broadcasting
      upgradeProtocol.startCatchupTimer(async (commitHash: string) => {
        if (this.upgradeInProgress || this.restartPending) {
          return { success: false, message: 'Upgrade already in progress' };
        }
        this.upgradeInProgress = true;
        try {
          return await upgradeProtocol.pullAndUpgrade(commitHash);
        } finally {
          this.upgradeInProgress = false;
        }
      });

      console.log('[upgrade] Phase 82 simple self-upgrade wired (with catch-up timer)');

      // Periodic governance re-sync: every 5 min, re-sync with a random connected peer.
      // Handles thin GossipSub meshes where governance votes/decisions don't propagate.
      setInterval(() => {
        if (!this.governance || !this.network) return;
        const peers = this.network.getPeers();
        if (peers.length === 0) return;
        const randomPeer = peers[Math.floor(Math.random() * peers.length)];
        this.governance.requestSync(randomPeer.peerId).catch(() => {});
      }, 5 * 60 * 1000);

      // Delayed peer re-exchange: 30s + 90s after boot, share full peer list with all peers.
      // The per-connection exchange (5s) may miss peers that haven't connected yet.
      for (const delay of [30_000, 90_000]) {
        setTimeout(async () => {
          if (!this.network) return;
          const peers = this.network.getPeers();
          const peerAddrs = await this.network.getConnectedPeerAddresses();
          if (peers.length < 2 || peerAddrs.length === 0) return;
          for (const peer of peers) {
            const toShare = peerAddrs.filter(p => p.peerId !== peer.peerId);
            if (toShare.length === 0) continue;
            try {
              await this.network.sendMessage(peer.peerId, {
                type: MessageType.PEER_EXCHANGE,
                from: this.getIdentity()!.peerId,
                timestamp: Date.now(),
                payload: { peers: toShare },
              });
            } catch {}
          }
          console.log(`[peer-exchange] Re-shared peers with ${peers.length} connected peer(s)`);
        }, delay);
      }

      // Log if this is a post-upgrade restart
      const lastUpgradeFile = join(dataDir, 'last-upgrade.json');
      if (existsSync(lastUpgradeFile)) {
        try {
          const info = JSON.parse(readFileSync(lastUpgradeFile, 'utf-8'));
          console.log(`[upgrade] Restarted after upgrade (reason: ${info.reason}, at: ${new Date(info.timestamp).toISOString()})`);
          unlinkSync(lastUpgradeFile);
        } catch {}
      }
    }

    // Start Reputation Manager (Phase 10.3) — performance tracking, P2P sync
    this.reputation = new ReputationManager(dataDir, this.network, this.requestReply);
    this.reputation.start();

    // Phase 12.3: Initialize ResourceProofChallenger — verifies nodes provide what they claim
    this.resourceProofChallenger = new ResourceProofChallenger(
      this.requestReply, this.network, this.identity.peerId, dataDir,
    );
    this.resourceProofChallenger.startChallengeLoop();

    // Phase 12.4: Initialize ReputationWeightedGovernance — reputation-weighted voting
    this.reputationGovernance = new ReputationWeightedGovernance(
      this.reputation,
      () => Math.floor(process.uptime()) * 1000, // uptime in ms
    );
    // Wire into governance
    if (this.governance) {
      this.governance.setReputationGovernance(this.reputationGovernance);
    }

    // Phase 12.5: Initialize ContentSafetyReviewer — rule-based content safety review
    this.contentSafetyReviewer = new ContentSafetyReviewer(this.identity.peerId, dataDir);

    // Phase 69: Resource Registry (metadata-only P2P) + CredentialStore (MongoDB encrypted)
    this.resourceRegistry = new ResourceRegistry(this.network, this.identity.peerId, this.ledger.getDatabase());
    await this.resourceRegistry.start();

    // Auto-connect MongoDB via PANDO_STORAGE_URL env var (if not already set by CLI)
    if (!this.storageBackend) {
      // PANDO_STORAGE_URL env var — primary way to configure MongoDB
      const storageUrl = process.env.PANDO_STORAGE_URL;
      if (storageUrl) {
        try {
          const { MongoStorageBackend } = await import('./core/mongo-backend.js');
          const mongo = new MongoStorageBackend(storageUrl);
          await mongo.init();
          this.setStorageBackend(mongo);
          console.log('[node] MongoDB connected via PANDO_STORAGE_URL');
        } catch (err) {
          console.error(`[node] Failed to connect to MongoDB: ${(err as Error).message}`);
        }
      }
    }

    // Phase 83: If no MongoDB, create P2PStorageBackend to proxy storage to compute nodes
    if (!this.storageBackend) {
      try {
        const { P2PStorageBackend } = await import('./core/p2p-storage-backend.js');
        const p2pBackend = new P2PStorageBackend(this.requestReply, this.capabilityRegistry, this.identity.peerId);
        await p2pBackend.init();
        this.setStorageBackend(p2pBackend);
        // Update capability profile to reflect P2P storage
        const localProfile = this.capabilityRegistry.getLocalProfile();
        if (localProfile) {
          (localProfile as any).storageBackend = 'p2p';
          localProfile.updatedAt = Date.now();
          this.capabilityRegistry.setLocalProfile(localProfile);
        }
        console.log('[node] P2PStorageBackend initialized — proxying storage to compute nodes');
      } catch (err) {
        console.error(`[node] Failed to init P2PStorageBackend: ${(err as Error).message}`);
      }
    }

    // Phase 69: Wire CredentialStore to ResourceRegistry (after MongoDB is connected)
    // v2.4: Delete CREDENTIAL_MASTER_KEY from process.env immediately after loading into memory.
    if (this.storageBackend && typeof (this.storageBackend as any).getDb === 'function') {
      try {
        const mongoDb = (this.storageBackend as any).getDb();
        const credentialStore = new CredentialStore(mongoDb, process.env.CREDENTIAL_MASTER_KEY);
        await credentialStore.init();
        // v2.4: Remove env var from process environment — key now lives ONLY in credentialStore.masterKey
        if (process.env.CREDENTIAL_MASTER_KEY) {
          delete process.env.CREDENTIAL_MASTER_KEY;
          console.log('[security] CREDENTIAL_MASTER_KEY deleted from process.env (key is memory-only now)');
        }
        this.resourceRegistry.setCredentialStore(credentialStore);
        (this as any)._credentialStore = credentialStore; // Store reference for P2P handlers
        // Phase 53.8: Start resource health checker (compute nodes only)
        this.resourceHealthChecker = new ResourceHealthChecker();
        this.resourceHealthChecker.setDependencies(credentialStore, this.resourceRegistry);
        this.resourceHealthChecker.start();
      } catch (err) {
        console.error(`[node] Failed to init CredentialStore: ${(err as Error).message}`);
      }
    }

    // Phase 69 (follow-up): Wire P2P credential proxy for non-secure nodes.
    // If this node has no decryption capability, proxy code_repository credential requests to compute peers.
    {
      const credStore = (this as any)._credentialStore as import('./core/credential-store.js').CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) {
        this.resourceRegistry.setP2PCredentialProxy(async (resourceId: string, type: string) => {
          if (!this.requestReply || !this.capabilityRegistry) return null;
          const allProfiles = this.capabilityRegistry.getAllProfiles();
          const computePeers = allProfiles.filter((p: any) =>
            p.storageBackend === 'mongodb' && p.peerId !== this.identity?.peerId
          );
          for (const peer of computePeers.slice(0, 3)) {
            try {
              const resp = await this.requestReply.request(peer.peerId, 'pando/get-credential', { resourceId, type }, 10_000);
              if (resp?.success && resp.payload?.credential) {
                console.log(`[resources] P2P credential proxy: got ${type} from ${peer.peerId.slice(0, 12)}`);
                return resp.payload.credential;
              }
            } catch { /* try next peer */ }
          }
          console.warn(`[resources] P2P credential proxy: no compute peer could decrypt ${resourceId.slice(0, 8)}`);
          return null;
        });
      }
    }

    // Phase B: Initialize ResourceRouter — smart task routing + error correction
    this.resourceRouter = new ResourceRouter(this.capabilityRegistry, this.requestReply);
    if (this.reputation) {
      this.resourceRouter.setReputationManager(this.reputation);
    }

    // Register task_forward handler so remote nodes can receive forwarded tasks
    this.requestReply.registerHandler('task_forward', async (req) => {
      const taskData = req.payload?.task;
      if (!taskData || !taskData.title) {
        return { error: 'Invalid task data' };
      }
      const tq = this.getActiveTaskQueue();
      if (!tq) {
        return { error: 'No task queue available' };
      }
      // Insert the forwarded task into local queue
      const task = tq.createTask({
        title: taskData.title,
        description: taskData.description || '',
        priority: taskData.priority || 'medium',
        createdBy: taskData.createdBy || req.from,
        managerId: taskData.managerId,
        requiredCapabilities: taskData.requiredCapabilities || (taskData as any).requiredResources,
      });
      console.log(`[resource-router] Received forwarded task ${task.id.slice(0, 8)}: ${task.title}`);
      return { taskId: task.id, accepted: true };
    });

    // Register deploy-app handler — compute nodes handle app deployment via P2P
    // Clones source from GitHub, installs deps, starts backend if needed
    // Phase 80: Persistent port registry — survives node restarts
    const PORT_REGISTRY_PATH = join(dataDir, 'app-ports.json');
    interface PortEntry { port: number; startedAt: number; appDir: string; }
    function loadPortRegistry(): Record<string, PortEntry> {
      try {
        return JSON.parse(readFileSync(PORT_REGISTRY_PATH, 'utf-8'));
      } catch { return {}; }
    }
    function savePortRegistry(registry: Record<string, PortEntry>): void {
      writeFileSync(PORT_REGISTRY_PATH, JSON.stringify(registry, null, 2));
    }
    function nextAvailablePort(registry: Record<string, PortEntry>): number {
      const used = Object.values(registry).map(e => e.port);
      return used.length === 0 ? 3001 : Math.max(...used) + 1;
    }

    this.requestReply.registerHandler('pando/deploy-app', async (req) => {
      const { projectId, repoUrl, tier, envVars } = req.payload || {};
      if (!projectId) return { error: 'Missing projectId' };
      if (!repoUrl) return { error: 'Missing repoUrl — GitHub is required for deployment' };

      const { join } = await import('node:path');
      const { mkdirSync, existsSync, readFileSync, readdirSync, statSync } = await import('node:fs');
      const { execSync } = await import('node:child_process');
      const appDir = join(dataDir, 'hosted-apps', projectId);
      mkdirSync(appDir, { recursive: true });

      // Phase 88: Auto-detect tier from inspecting the actual code
      function detectTierFromCode(dir: string): { detectedTier: 1 | 2; reason: string } {
        const pkgPath = join(dir, 'package.json');
        if (!existsSync(pkgPath)) {
          return { detectedTier: 1, reason: 'No package.json — static files only' };
        }

        let pkg: any;
        try { pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')); } catch {
          return { detectedTier: 1, reason: 'package.json unreadable — treating as static' };
        }

        // Check 1: start script → needs a server → Tier 2
        if (pkg.scripts?.start) {
          return { detectedTier: 2, reason: `package.json has start script: "${pkg.scripts.start}"` };
        }

        // Check 2: server-related dependencies → Tier 2
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const serverDeps = ['express', 'fastify', 'koa', 'hapi', '@hapi/hapi', '@nestjs/core', 'socket.io', 'ws', 'http-server'];
        const foundServerDep = serverDeps.find(d => d in allDeps);
        if (foundServerDep) {
          return { detectedTier: 2, reason: `Server dependency found: ${foundServerDep}` };
        }

        // Check 3: package.json "main" points to a server file → Tier 2
        const serverFileNames = ['server.js', 'server.ts', 'app.js', 'app.ts'];
        if (pkg.main && serverFileNames.includes(pkg.main)) {
          return { detectedTier: 2, reason: `package.json main points to server file: ${pkg.main}` };
        }

        // Check 4: backend/ or server/ directory → Tier 2
        if (existsSync(join(dir, 'backend')) || existsSync(join(dir, 'server'))) {
          return { detectedTier: 2, reason: 'backend/ or server/ directory found' };
        }

        // Default: package.json but no server indicators → frontend build tool or static → Tier 1
        return { detectedTier: 1, reason: 'package.json present but no server indicators — static app' };
      }

      try {
        // Kill existing process if re-deploying (Tier 2 only) — Phase 80: use PM2
        const portRegistry = loadPortRegistry();
        const existing = portRegistry[projectId];
        if (existing) {
          const pm2Name = `app-${projectId}`;
          try { execSync(`pm2 delete ${pm2Name}`, { stdio: 'pipe', timeout: 10_000 }); } catch {}
          delete portRegistry[projectId];
          savePortRegistry(portRegistry);
          console.log(`[deploy] Stopped existing PM2 process ${pm2Name} for ${projectId}`);
        }

        // Clone or pull from GitHub
        if (existsSync(join(appDir, '.git'))) {
          execSync('git pull origin main', { cwd: appDir, stdio: 'pipe', timeout: 60_000 });
          console.log(`[deploy] Updated ${repoUrl} in ${appDir}`);
        } else {
          const tmpDir = appDir + '-tmp-' + Date.now();
          execSync(`git clone ${repoUrl} ${tmpDir}`, { stdio: 'pipe', timeout: 60_000 });
          const { renameSync, rmSync } = await import('node:fs');
          for (const f of readdirSync(tmpDir)) {
            renameSync(join(tmpDir, f), join(appDir, f));
          }
          rmSync(tmpDir, { recursive: true, force: true });
          console.log(`[deploy] Cloned ${repoUrl} to ${appDir}`);
        }

        // ── Phase 88: Auto-detect tier from code ────────────────────────────
        const { detectedTier, reason: tierReason } = detectTierFromCode(appDir);
        if (detectedTier !== tier) {
          console.log(`[deploy] Tier override: requested=${tier}, detected=${detectedTier} (${tierReason})`);
        } else {
          console.log(`[deploy] Tier confirmed: ${detectedTier} (${tierReason})`);
        }
        const effectiveTier = detectedTier;

        // ── Tier 1: Upload static files to S3 ──────────────────────────────
        if (effectiveTier === 1) {
          console.log(`[deploy] Tier 1 — uploading static files to S3 for ${projectId}`);

          // Get S3 credentials from ResourceRegistry
          const registry = this.resourceRegistry;
          if (!registry) return { status: 'failed', error: 'ResourceRegistry not available on compute node' };

          const s3Resources = registry.findResources('storage_blob' as any);
          if (!s3Resources.length) return { status: 'failed', error: 'No storage_blob resource on compute node' };

          const s3Cred = await registry.getCredential(s3Resources[0].resourceId);
          if (!s3Cred) return { status: 'failed', error: 'Could not decrypt S3 credential' };

          // Parse S3 credential — expect JSON with accessKeyId, secretAccessKey, region, bucket
          let s3Config: any;
          try { s3Config = JSON.parse(s3Cred); } catch {
            // Try as simple format: accessKeyId:secretAccessKey
            return { status: 'failed', error: 'S3 credential not in expected JSON format' };
          }

          // Upload files to S3
          const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
          const s3 = new S3Client({
            region: s3Config.region || 'us-east-1',
            credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey },
          });

          const bucket = s3Config.bucket || 'pando-deployments';
          const staticExts = new Set(['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.eot']);
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
            '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff',
            '.woff2': 'font/woff2', '.ttf': 'font/ttf',
          };

          // Inject gateway vars into HTML files
          const gatewayUrl = envVars?.PANDO_GATEWAY_URL || process.env.GATEWAY_PUBLIC_URL || '';
          const projectApiKey = envVars?.PANDO_PROJECT_API_KEY || '';

          let uploadCount = 0;

          // Recursively find all static files
          const scanDir = (dir: string, prefix: string): void => {
            for (const entry of readdirSync(dir)) {
              const fullPath = join(dir, entry);
              const relPath = prefix ? `${prefix}/${entry}` : entry;
              try {
                const st = statSync(fullPath);
                if (st.isDirectory()) {
                  if (entry === 'node_modules' || entry === '.git') continue;
                  scanDir(fullPath, relPath);
                } else if (st.isFile()) {
                  const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
                  if (!staticExts.has(ext)) continue;

                  let content = readFileSync(fullPath);

                  // Inject gateway vars into HTML
                  if (ext === '.html' && gatewayUrl) {
                    let html = content.toString('utf-8');
                    const vars = [`window.PANDO_GATEWAY_URL="${gatewayUrl}"`, `window.PANDO_PROJECT_ID="${projectId}"`];
                    if (projectApiKey) vars.push(`window.PANDO_PROJECT_API_KEY="${projectApiKey}"`);
                    const script = `<script>${vars.join(';')};</script>`;
                    if (html.includes('<head>')) {
                      html = html.replace('<head>', '<head>' + script);
                    } else {
                      html = script + html;
                    }
                    content = Buffer.from(html, 'utf-8');
                  }

                  // Queue upload (synchronous for simplicity)
                  const key = `public/${projectId}/${relPath}`;
                  const putCmd = new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    Body: content,
                    ContentType: mimeTypes[ext] || 'application/octet-stream',
                  });
                  // Fire upload (we'll await them below)
                  s3.send(putCmd).then(() => {}).catch((e: any) => console.log(`[deploy] S3 upload failed for ${key}: ${e.message}`));
                  uploadCount++;
                }
              } catch {}
            }
          };

          // Check if there's a public/ subdirectory — prefer it for Tier 1
          const publicDir = join(appDir, 'public');
          if (existsSync(publicDir) && statSync(publicDir).isDirectory()) {
            scanDir(publicDir, '');
          } else {
            scanDir(appDir, '');
          }

          // Wait a bit for uploads to complete
          await new Promise(r => setTimeout(r, 2000));

          const s3Url = `http://${bucket}.s3-website-${s3Config.region || 'us-east-1'}.amazonaws.com/public/${projectId}/index.html`;
          console.log(`[deploy] Tier 1 complete: ${uploadCount} files uploaded → ${s3Url}`);

          return { status: 'deployed', projectId, type: 'static', s3Url, url: s3Url, fileCount: uploadCount, detectedTier: effectiveTier, tierReason };
        }

        // ── Tier 2: Run as backend app ──────────────────────────────────────
        if (effectiveTier === 2) {
          execSync('npm install --production', { cwd: appDir, stdio: 'pipe', timeout: 120_000 });
          console.log(`[deploy] Dependencies installed for ${projectId}`);

          const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8'));
          const startScript = pkg.scripts?.start;
          const mainFile = pkg.main || 'server.js';

          // Phase 80: PM2 process management with persistent port registry
          const currentRegistry = loadPortRegistry();
          const port = existing?.port || nextAvailablePort(currentRegistry);
          const pm2Name = `app-${projectId}`;

          // Build env var args for PM2
          const envObj: Record<string, string> = { PORT: String(port), NODE_ENV: 'production', ...(envVars || {}) };
          const envArgs = Object.entries(envObj).map(([k, v]) => `${k}=${v}`).join(' ');

          // Delete any existing PM2 process first
          try { execSync(`pm2 delete ${pm2Name}`, { stdio: 'pipe', timeout: 10_000 }); } catch {}

          if (startScript) {
            execSync(`env ${envArgs} pm2 start npm --name ${pm2Name} -- start`, { cwd: appDir, stdio: 'pipe', timeout: 30_000 });
          } else {
            execSync(`env ${envArgs} pm2 start ${mainFile} --name ${pm2Name}`, { cwd: appDir, stdio: 'pipe', timeout: 30_000 });
          }
          execSync('pm2 save', { stdio: 'pipe', timeout: 10_000 });

          // Update persistent port registry
          currentRegistry[projectId] = { port, startedAt: Date.now(), appDir };
          savePortRegistry(currentRegistry);

          // Phase 80: Write nginx reverse proxy config for stable URLs
          try {
            const { writeFileSync, mkdirSync: mkdirNginx } = await import('node:fs');
            const nginxConfDir = '/etc/nginx/pando-apps';
            mkdirNginx(nginxConfDir, { recursive: true });
            const nginxConf = `# Auto-generated by Pando deploy — ${projectId}
location /apps/${projectId}/ {
    proxy_pass http://127.0.0.1:${port}/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
`;
            writeFileSync(join(nginxConfDir, `${projectId}.conf`), nginxConf);
            execSync('sudo nginx -s reload', { stdio: 'pipe', timeout: 10_000 });
            console.log(`[deploy] nginx config written for ${projectId} → port ${port}`);
          } catch (nginxErr: any) {
            console.log(`[deploy] nginx config skipped (not on EC2?): ${nginxErr.message}`);
          }

          console.log(`[deploy] Started ${projectId} via PM2 as ${pm2Name} on port ${port}`);

          // Phase 87: Include publicAddress so caller can construct the URL
          const publicAddress = process.env.PUBLIC_IP || undefined;
          return { status: 'deployed', projectId, port, pm2Name, url: `http://localhost:${port}`, publicAddress, detectedTier: effectiveTier, tierReason };
        }

        // Fallback: code didn't match Tier 1 or Tier 2 detection — serve locally
        return { status: 'deployed', projectId, path: appDir, type: 'static', detectedTier: effectiveTier, tierReason };
      } catch (err: any) {
        console.log(`[deploy] Failed for ${projectId}: ${err.message}`);
        return { status: 'failed', error: err.message };
      }
    });

    // Phase 69 (follow-up): P2P credential proxy handler — EC2 nodes decrypt code_repository credentials
    // for non-secure nodes that lack CREDENTIAL_MASTER_KEY. Only code_repository type is allowed.
    this.requestReply.registerHandler('pando/get-credential', async (req) => {
      const { resourceId, type } = req.payload || {};
      if (!resourceId) return { error: 'Missing resourceId' };
      // Security: only proxy code_repository credentials (GitHub PAT). S3/MongoDB MUST stay on EC2.
      if (type !== 'code_repository') return { error: 'Credential type not proxyable' };
      const credStore = (this as any)._credentialStore as import('./core/credential-store.js').CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) return { error: 'This node cannot decrypt credentials' };
      const credential = await credStore.getCredential(resourceId);
      if (!credential) return { error: 'Credential not found or decryption failed' };
      return { credential };
    });

    // Phase 80: Register undeploy-app handler — remove apps from compute nodes
    this.requestReply.registerHandler('pando/undeploy-app', async (req) => {
      const { projectId, deleteFiles } = req.payload || {};
      if (!projectId) return { error: 'Missing projectId' };

      const { join } = await import('node:path');
      const { execSync } = await import('node:child_process');
      const { unlinkSync, rmSync, existsSync } = await import('node:fs');

      try {
        const pm2Name = `app-${projectId}`;

        // 1. Stop PM2 process
        try {
          execSync(`pm2 delete ${pm2Name}`, { stdio: 'pipe', timeout: 10_000 });
          execSync('pm2 save', { stdio: 'pipe', timeout: 10_000 });
          console.log(`[undeploy] PM2 process ${pm2Name} deleted`);
        } catch {
          console.log(`[undeploy] PM2 process ${pm2Name} not found (already stopped?)`);
        }

        // 2. Remove nginx config
        try {
          const nginxConf = `/etc/nginx/pando-apps/${projectId}.conf`;
          if (existsSync(nginxConf)) {
            unlinkSync(nginxConf);
            execSync('sudo nginx -s reload', { stdio: 'pipe', timeout: 10_000 });
            console.log(`[undeploy] nginx config removed for ${projectId}`);
          }
        } catch (e: any) {
          console.log(`[undeploy] nginx cleanup skipped: ${e.message}`);
        }

        // 3. Remove from port registry
        const registry = loadPortRegistry();
        delete registry[projectId];
        savePortRegistry(registry);

        // 4. Optionally delete app files
        if (deleteFiles) {
          const appDir = join(dataDir, 'hosted-apps', projectId);
          if (existsSync(appDir)) {
            rmSync(appDir, { recursive: true, force: true });
            console.log(`[undeploy] Deleted app files at ${appDir}`);
          }
        }

        console.log(`[undeploy] Project ${projectId} undeployed successfully`);
        return { status: 'undeployed', projectId };
      } catch (err: any) {
        console.log(`[undeploy] Failed for ${projectId}: ${err.message}`);
        return { status: 'failed', error: err.message };
      }
    });

    // Phase 80: Startup reconciliation — cross-check port registry with PM2 on compute nodes
    if (this.config.nodeMode === 'compute') {
      try {
        const { execSync } = await import('node:child_process');
        const registry = loadPortRegistry();
        const registryIds = Object.keys(registry);

        if (registryIds.length > 0) {
          // Get PM2 process list
          let pm2Processes: string[] = [];
          try {
            const pm2Json = execSync('pm2 jlist', { stdio: 'pipe', timeout: 10_000 }).toString();
            const pm2List = JSON.parse(pm2Json);
            pm2Processes = pm2List.map((p: any) => p.name);
          } catch { /* PM2 not running or no processes */ }

          let orphans = 0;
          for (const projectId of registryIds) {
            const pm2Name = `app-${projectId}`;
            if (!pm2Processes.includes(pm2Name)) {
              console.log(`[reconcile] WARNING: ${projectId} in port registry but not in PM2 — orphan entry`);
              orphans++;
            }
          }
          // Check for PM2 processes not in registry
          for (const name of pm2Processes) {
            if (name.startsWith('app-')) {
              const projId = name.slice(4);
              if (!registry[projId]) {
                console.log(`[reconcile] WARNING: PM2 process ${name} not in port registry — unknown process`);
              }
            }
          }
          console.log(`[reconcile] Port registry: ${registryIds.length} entries, PM2: ${pm2Processes.length} app processes, orphans: ${orphans}`);
        }
      } catch (err: any) {
        console.log(`[reconcile] Startup reconciliation skipped: ${err.message}`);
      }
    }

    // Phase 67: Register pando/upgrade-node handler — compute instances can be upgraded via P2P
    this.requestReply.registerHandler('pando/upgrade-node', async (req) => {
      if (this.restartPending || this.upgradeInProgress) {
        return { status: 'already_in_progress' };
      }
      this.upgradeInProgress = true;
      try {
        const { execSync } = await import('node:child_process');
        const repoDir = process.cwd();

        // Ensure git safe.directory (compute instances: repo cloned by root, node runs as 'pando')
        try {
          execSync(`git config --global --add safe.directory ${repoDir}`, {
            cwd: repoDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe',
          });
        } catch {}

        // Fetch + reset to origin/master (handles orphan-branch force pushes)
        execSync('git fetch origin master', {
          cwd: repoDir, encoding: 'utf-8', timeout: 120_000, stdio: 'pipe',
        });
        const localSha = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
        const remoteSha = execSync('git rev-parse origin/master', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();

        if (localSha === remoteSha) {
          this.upgradeInProgress = false;
          console.log('[upgrade-node] Already up to date');
          return { status: 'already_up_to_date', output: 'Already up to date.' };
        }

        safeGitReset(repoDir, 'origin/master');
        const pullOutput = `Updated ${localSha.slice(0, 8)} -> ${remoteSha.slice(0, 8)}`;
        console.log(`[upgrade-node] ${pullOutput}`);

        // Build
        console.log('[upgrade-node] Building...');
        execSync('npm run build', {
          cwd: repoDir, encoding: 'utf-8', timeout: 300_000, stdio: 'pipe',
        });
        console.log('[upgrade-node] Build complete. Scheduling restart...');

        // Schedule graceful restart (exit code 75 → launcher restarts)
        this.requestGracefulRestart('P2P upgrade request');
        return { status: 'restart_pending', output: pullOutput };
      } catch (err: any) {
        this.upgradeInProgress = false;
        console.error(`[upgrade-node] Failed: ${err.message}`);
        return { status: 'failed', error: err.message };
      }
    });

    // Phase 69: Register pando/ai-query handler — compute nodes serve AI queries for untrusted nodes
    this.requestReply.registerHandler('pando/ai-query', async (req) => {
      const credStore = (this as any)._credentialStore as CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) {
        return { error: 'Not a credential node' };
      }
      const { query } = req.payload || {};
      if (!query || typeof query !== 'string') return { error: 'Missing query' };

      const aiKey = await credStore.getActiveByType('ai_api_key');
      if (!aiKey) return { error: 'No AI keys available' };

      const result = aiKey.metadata?.provider === 'openai'
        ? await this.searchOpenAI(query, aiKey.credential, aiKey.metadata?.model || 'gpt-4o-mini')
        : await this.searchGemini(query, aiKey.credential, aiKey.metadata?.model || 'gemini-pro');
      if (result) {
        this.resourceMeter?.recordUsage(aiKey.resourceId, 'api_keys', {
          resourceType: 'api_keys', quantity: 1, unit: 'calls', timestamp: Date.now(),
        });
        return { answer: result.answer, sources: result.sources, confidence: result.confidence };
      }
      return { error: 'AI query failed' };
    });

    // Phase 83: Register pando/storage-proxy handler on compute nodes
    // Untrusted nodes proxy StorageBackend CRUD operations here
    this.requestReply.registerHandler('pando/storage-proxy', async (req) => {
      // Only serve if we have direct MongoDB (compute node)
      if (!this.storageBackend || typeof (this.storageBackend as any).getDb !== 'function') {
        return { error: 'Not a storage node' };
      }
      const { method, args } = req.payload || {};

      // Method allowlist — only StorageBackend CRUD methods
      const ALLOWED_METHODS = ['putRecord', 'getRecord', 'queryRecords', 'deleteRecord', 'listRecords', 'pushToArray'];
      if (!method || !ALLOWED_METHODS.includes(method)) {
        return { error: `Method not allowed: ${method}` };
      }

      // Collection blocklist — never proxy credential operations
      const collection = args?.collection;
      if (collection === 'pando_credentials') {
        return { error: 'Access denied: credential collection' };
      }

      try {
        const backend = this.storageBackend as any;
        let result: any;
        switch (method) {
          case 'putRecord':
            await backend.putRecord(args.collection, args.key, args.data);
            result = undefined;
            break;
          case 'getRecord':
            result = await backend.getRecord(args.collection, args.key);
            break;
          case 'queryRecords':
            result = await backend.queryRecords(args.collection, args.filter, args.options);
            break;
          case 'deleteRecord':
            await backend.deleteRecord(args.collection, args.key);
            result = undefined;
            break;
          case 'listRecords':
            result = await backend.listRecords(args.collection, args.filter);
            break;
          case 'pushToArray':
            await backend.pushToArray(args.collection, args.key, args.field, args.value);
            result = undefined;
            break;
        }
        // Phase 83: After proxy writes, refresh local caches (fire-and-forget)
        const isWrite = ['putRecord', 'deleteRecord', 'pushToArray'].includes(method);
        if (isWrite && collection) {
          if ((collection === 'threads' || collection === 'thread_messages') && this.threadStore) {
            this.threadStore.loadFromBackend().catch(() => {});
          }
        }

        return { result };
      } catch (err) {
        return { error: `Storage proxy error: ${(err as Error).message}` };
      }
    });

    // Phase C: Initialize ResourceMeter — resource usage metering
    this.resourceMeter = new ResourceMeter(dataDir);
    this.resourceMeter.startMeteringLoop(60_000); // prune + save every 60s

    // Phase D: Initialize ResourceMarketplace — marketplace pricing
    this.resourceMarketplace = new ResourceMarketplace(this.capabilityRegistry);
    this.resourceMarketplace.setNetwork(this.network);
    this.resourceMarketplace.setLocalPeerId(this.identity.peerId);

    // Handle incoming price broadcasts via capabilities topic (Phase D)
    this.network.onPriceBroadcast((priceList, fromPeerId) => {
      this.resourceMarketplace?.handlePriceBroadcast(fromPeerId, priceList);
      console.log(`[marketplace] Received prices from ${fromPeerId.slice(0, 12)}`);
    });

    // Broadcast initial prices
    try {
      await this.resourceMarketplace.broadcastPrices();
    } catch {}

    console.log('[resources] ResourceRouter + ResourceMeter + ResourceMarketplace initialized');

    // Phase 17.6: Regression Suite — persistent, auto-growing test suite
    this.regressionSuite = new RegressionSuite({
      dataDir,
      apiBaseUrl: `http://127.0.0.1:${this.config.apiPort}`,
    });
    console.log(`[regression] Suite loaded: ${this.regressionSuite.getStats().total} tests`);

    // Phase 18.6: Payment Gate — Lux escrow for task execution
    this.paymentGate = new PaymentGate(this.ledger, dataDir);
    console.log('[payment-gate] Initialized');

    // Unified identity system — Ed25519 keypairs, guest auto-creation, claim flow
    // Phase 56: Auth data lives in P2P-synced ledger, local keys in auth-local.db
    // Phase 86: Sessions removed — auth is stateless JWT issued by api-server
    this.userAccountStore = new UserAccountStore(this.ledger, dataDir);
    // Phase 35: Daily guest Lux reclamation — unclaimed guests older than 30 days
    // get remaining Lux transferred back to NETWORK for reuse
    const ledgerForReclaim = this.ledger;
    setInterval(() => {
      if (this.userAccountStore && ledgerForReclaim) {
        this.userAccountStore.reclaimExpiredGuests(ledgerForReclaim);
      }
    }, 24 * 60 * 60 * 1000); // Run daily
    // Also run once on startup (catches guests that expired while node was offline)
    setTimeout(() => {
      if (this.userAccountStore && ledgerForReclaim) {
        this.userAccountStore.reclaimExpiredGuests(ledgerForReclaim);
      }
    }, 60_000); // 1 minute after boot
    console.log('[user-accounts] Initialized (with guest Lux reclamation)');

    // Phase 57: User data stores require StorageBackend (MongoDB). Skip if no backend configured.
    if (this.storageBackend) {
      this.projectStore = new ProjectStore(this.ledger.getDatabase(), this.storageBackend);
      this.projectStore.init();

      this.revenueEngine = new RevenueEngine(this.ledger.getDatabase(), this.ledger, this.storageBackend);
      this.revenueEngine.init();

      this.contributionTracker = new ContributionTracker(this.ledger.getDatabase(), this.storageBackend);
      this.contributionTracker.init();
    }

    // Phase 11: Content Layer — persistent hosting & delivery registry
    this.contentRegistry = new ContentRegistry(this.ledger.getDatabase());
    this.contentRegistry.setLocalPeerId(this.identity.peerId);
    if (this.network) {
      this.contentRegistry.setNetwork(this.network);
      await this.contentRegistry.subscribeContentTopic();
    }
    this.contentPublisher = new ContentPublisher(this.contentRegistry);
    this.contentPublisher.setLocalPeerId(this.identity.peerId);
    this.contentMaintenance = new ContentMaintenance(this.contentRegistry);
    this.contentMaintenance.setLocalPeerId(this.identity.peerId);
    // Wire task creation into the scheduler task queue
    const tq = this.getActiveTaskQueue();
    if (tq) {
      this.contentMaintenance.setTaskCreator((title: string, description: string, priority: string) => {
        tq.createTask({
          title,
          description,
          priority: priority as any,
          createdBy: 'content-maintenance',
        });
      });
    }
    this.contentMaintenance.startMaintenanceLoop();
    console.log('[content-layer] ContentRegistry, ContentPublisher, ContentMaintenance initialized');

    // Phase 57: ThreadStore + data loading — only with StorageBackend
    // IMPORTANT: Data loading is non-blocking so API starts fast. P2P storage timeouts
    // (15s each) would otherwise block API startup for minutes on slow networks.
    if (this.storageBackend) {
      this.threadStore = new ThreadStore(this.storageBackend);
      // Fire and forget — data loads in background, retries via deferred loading on peer connect
      (async () => {
        try {
          await this.threadStore!.loadFromBackend();
          if (this.projectStore) await this.projectStore.loadFromBackend();
          if (this.revenueEngine) await (this.revenueEngine as any).loadFromBackend();
          if (this.contributionTracker) await (this.contributionTracker as any).loadFromBackend();
          this._p2pDataLoaded = true;
          console.log('[data] User data stores initialized (storage-backed)');
        } catch (err: any) {
          // Phase 83: P2PStorageBackend may fail if no compute peers yet — non-fatal
          // Will retry via deferred loading when first peer connects
          console.warn(`[data] Backend load failed (will retry when peers connect): ${err.message}`);
        }
      })();
    } else {
      console.log('[data] No StorageBackend — user data features disabled (P2P features still work)');
    }

    // Phase 63: Wire ProjectStore → ProjectRegistry bridge + seed existing projects
    if (this.projectStore && this.projectRegistry) {
      const pr = this.projectRegistry;
      const peerId = this.identity.peerId;
      const username = this.linkedUser?.username;

      // Write-through: when MongoDB writes happen, broadcast to P2P
      this.projectStore.setBroadcastCallback((action: string, project: any) => {
        const resourceIds = (project.resources || []).map((r: any) => r.resourceId);
        const currentUsername = this.linkedUser?.username || username;

        if (action === 'register' && project.apiKey) {
          pr.registerProject(
            project.id, project.name, peerId, project.apiKey, project.visibility,
            resourceIds, currentUsername, project.deploymentUrl, project.deploymentType, project.description
          );
        } else if (action === 'update') {
          // If the project has an API key but isn't in the P2P registry yet,
          // register it instead of updating (fixes generateApiKey() not reaching P2P)
          if (project.apiKey && !pr.getProject(project.id)) {
            pr.registerProject(
              project.id, project.name, peerId, project.apiKey, project.visibility,
              resourceIds, currentUsername, project.deploymentUrl, project.deploymentType, project.description
            );
          } else {
            pr.updateProject(project.id, {
              name: project.name,
              visibility: project.visibility,
              resourceIds,
              status: project.status,
              deploymentUrl: project.deploymentUrl,
              deploymentType: project.deploymentType,
              description: project.description,
            });
          }
        } else if (action === 'archive') {
          pr.archiveProject(project.id);
        }
      });

      // Seed: push existing projects from SQLite cache into P2P registry
      try {
        const existing = this.projectStore.listProjects();
        let seeded = 0;
        for (const p of existing) {
          if (p.apiKey && !pr.getProject(p.id)) {
            pr.registerProject(
              p.id, p.name, peerId, p.apiKey, p.visibility,
              (p.resources || []).map((r: any) => r.resourceId),
              username, p.deploymentUrl, p.deploymentType, p.description
            );
            seeded++;
          }
        }
        if (seeded > 0) console.log(`[project-registry] Seeded ${seeded} existing projects to P2P`);
      } catch (err) {
        console.log(`[project-registry] Seed from ProjectStore skipped: ${(err as Error).message}`);
      }
    }

    // Phase 32: S3 Hosting Service
    this.hostingService = new HostingService();
    console.log('[hosting] S3 hosting service initialized');

    // Phase 64: Cloud Instance Manager — EC2 compute node lifecycle
    this.cloudInstanceManager = new CloudInstanceManager(this);
    this.cloudInstanceManager.init().catch((err: any) =>
      console.warn(`[cloud-instances] Init failed (non-fatal): ${err.message}`));

    // Phase 50: Network State Aggregator — hourly snapshot for council reflection
    this.networkState = new NetworkState(this, dataDir);
    this.networkState.start();
    console.log('[network-state] Aggregator started (hourly snapshots)');

    // Council is now the Orchestrator — initialized in startAgentSystem()

    // v2.5: Local Environment — Envelope 1 file index + user memory (always on, no network)
    try {
      this.localEnv = new LocalEnvironment(dataDir);
      console.log(`[local-env] Initialized (${this.localEnv.getStatus().grantedDirs.length} dirs indexed)`);
    } catch (err: any) {
      console.warn(`[local-env] Init failed (non-fatal): ${err.message}`);
    }

    // Start HTTP API
    this.apiServer = new ApiServer(this);
    // Windows: '::' hangs on some systems, use '0.0.0.0' directly. Linux: '::' for dual-stack.
    const apiHost = process.platform === 'win32' ? '0.0.0.0' : '::';
    await this.apiServer.start({ port: this.config.apiPort, host: apiHost });

    // Wire SSE real-time event push — transactions and governance events
    this.sync.onTransaction((tx) => {
      this.apiServer?.pushEvent('transaction', {
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        type: tx.type,
        timestamp: tx.timestamp,
      });

      // Auto-snapshot: check if we've crossed the snapshot interval
      this.checkAutoSnapshot();
    });
    this.governance.onVote((vote, proposalTitle) => {
      this.apiServer?.pushEvent('vote', {
        proposalId: vote.proposalId,
        proposalTitle,
        voter: vote.voter,
        choice: vote.choice,
        timestamp: vote.createdAt,
      });
    });
    this.governance.onComment((comment) => {
      this.apiServer?.pushEvent('comment', {
        id: comment.id,
        proposalId: comment.proposalId,
        from: comment.from,
        content: comment.content.slice(0, 200),
        timestamp: comment.createdAt,
      });
    });
    this.governance.onDecision((decision, proposalTitle) => {
      this.apiServer?.pushEvent('decision', {
        proposalId: decision.proposalId,
        proposalTitle,
        outcome: decision.outcome,
        votesFor: decision.votesFor,
        votesAgainst: decision.votesAgainst,
        timestamp: decision.decidedAt,
      });

      // Phase 15.2: Governance → Task Pipeline
      // When a proposal passes, auto-create a scheduler task and approve it
      if (decision.outcome === 'passed') {
        const proposal = this.governance?.getProposal(decision.proposalId);
        const tq = this.getActiveTaskQueue();
        let createdTaskId: string | null = null;
        if (proposal && tq) {
          const taskTitle = proposal.title;
          const taskDesc = proposal.description + `\n\n[Auto-created from approved governance proposal ${decision.proposalId.slice(0, 8)}]`;
          const task = tq.createTask({
            title: taskTitle,
            description: taskDesc,
            priority: 'high',
            createdBy: proposal.proposedBy,
            proposalId: decision.proposalId,
          });
          createdTaskId = task.id;
          console.log(`[governance→scheduler] Proposal "${taskTitle}" approved → task created (${task.id.slice(0, 8)})`);

          // Auto-approve the task so the scheduler picks it up
          try {
            if (this.scheduler) {
              this.scheduler.receiveApprovedTask(task.id, DEFAULT_MANAGER_ID);
              console.log(`[governance→scheduler] Task ${task.id.slice(0, 8)} auto-approved`);
            }
          } catch (err: any) {
            console.error(`[governance→scheduler] Failed to auto-approve task: ${err.message}`);
          }
        }

        // Send governance decision to council orchestrator via MessageBus
        if (this.messageBus && this.councilOrchId) {
          try {
            const proposal = this.governance?.getProposal(decision.proposalId);
            this.messageBus.send({
              recipientId: this.councilOrchId,
              senderId: 'governance',
              senderType: 'system',
              type: 'governance_decision',
              payload: {
                proposalId: decision.proposalId,
                title: proposalTitle,
                description: proposal?.description || '',
                outcome: decision.outcome,
                category: proposal?.category || 'unknown',
                votesFor: decision.votesFor,
                votesAgainst: decision.votesAgainst,
                taskId: createdTaskId,
              },
              priority: 0, // critical
            });
            console.log(`[governance→agents] Proposal "${proposalTitle}" → council orchestrator`);
          } catch (err: any) {
            console.error(`[governance→agents] Failed to send governance decision: ${err.message}`);
          }
        }
      }
    });
    // Wire activity sync — push remote activity events to SSE
    this.sync.onActivity((record) => {
      this.apiServer?.pushEvent('activity', {
        id: record.id,
        agentId: record.agentId,
        action: record.action,
        summary: record.summary,
        timestamp: record.timestamp,
      });
    });

    console.log('');
    console.log('Discovering peers...');

    // Epoch-based uptime tracking (every 10 minutes)
    this.uptimeTimer = setInterval(() => {
      this.recordUptimeEpoch();
    }, 10 * 60 * 1000);

    // Peer connection handler — register unknown peers and trigger sync
    this.network.onPeerConnect((peerId) => {
      if (!this.ledger!.accounts.exists(peerId)) {
        this.ledger!.registerNode(peerId, 'remote-peer');
      }

      // Record peer join for Sybil detection
      this.securityMonitor?.recordPeerJoin(peerId);

      // Request governance catch-up sync from the new peer (3s delay for protocol setup)
      if (this.governance) {
        setTimeout(() => {
          this.governance?.requestSync(peerId).catch(() => {});
        }, 3000);
      }

      // Request task catch-up sync from the new peer (2s delay for protocol setup)
      setTimeout(() => {
        this.getActiveTaskQueue()?.requestSync(peerId).catch(() => {});
      }, 2000);

    });

    // Start agent system (Orchestrator + WorkerPool) — only in 'full' mode (needs Claude Code).
    // 'compute' and 'relay' modes skip agents (cloud instances don't have Claude Code).
    if (this.config.nodeMode !== 'compute' && this.config.nodeMode !== 'relay') {
      this.startAgentSystem();
    } else {
      console.log(`[node] Mode '${this.config.nodeMode}' — agent system skipped.`);
    }

    // Handle messages and reward work
    this.network.onMessage((message, from) => {
      // Security: ignore messages from quarantined peers
      if (this.securityMonitor?.isQuarantined(from)) {
        console.log(`[security] Ignoring message from quarantined peer: ${from.slice(0, 16)}`);
        return;
      }

      // Record message for security rate monitoring
      this.securityMonitor?.recordMessage(from);

      console.log(`[${message.type}] from ${from.slice(0, 16)}...`);
      if (message.payload) {
        console.log(`  payload: ${JSON.stringify(message.payload)}`);
      }

      // Ensure the sending peer has an account
      if (!this.ledger!.accounts.exists(from)) {
        this.ledger!.registerNode(from, 'remote-peer');
      }

      // Handle governance sync requests/responses (direct P2P messages)
      if (message.type === MessageType.GOVERNANCE_SYNC_REQUEST) {
        this.governance?.handleSyncRequest(from);
      }
      if (message.type === MessageType.GOVERNANCE_SYNC_RESPONSE) {
        this.governance?.handleSyncResponse(message);
      }

      // Handle task sync requests/responses (direct P2P messages)
      if (message.type === MessageType.TASK_SYNC_REQUEST) {
        this.getActiveTaskQueue()?.handleSyncRequest(from);
      }
      if (message.type === MessageType.TASK_SYNC_RESPONSE) {
        const payload = message.payload as { tasks?: any[] };
        if (payload?.tasks) {
          this.getActiveTaskQueue()?.handleSyncResponse(payload.tasks);
        }
      }

      // Handle balance requests
      if (message.type === MessageType.BALANCE_REQUEST) {
        const peerId = (message.payload as any)?.peerId || from;
        const peerBalance = this.ledger!.accounts.getBalance(peerId);
        this.network!.sendMessage(from, {
          type: MessageType.BALANCE_RESPONSE,
          from: this.identity!.peerId,
          timestamp: Date.now(),
          payload: { peerId, balance: peerBalance },
        }).catch(() => {});
      }

      // Phase 93: Direct TCP stream request/reply (replaces GossipSub for unicast P2P calls)
      if (message.type === MessageType.REQUEST_REPLY_REQUEST || message.type === MessageType.REQUEST_REPLY_REPLY) {
        this.requestReply?.handleDirectMessage(message, from).catch(() => {});
      }

      // Phase 92: Direct TCP stream capability profile exchange
      // Fallback for GossipSub mesh failures (small networks where mesh doesn't form)
      if (message.type === MessageType.CAPABILITY_PROFILE_DIRECT) {
        const profile = message.payload as any;
        if (profile) {
          this.capabilityRegistry.updatePeerProfile(profile);
          const activeResources = Object.entries(profile.capabilities || {})
            .filter(([, v]) => v).map(([k]) => k);
          console.log(`[capabilities] Direct profile from ${from.slice(0, 12)}: [${activeResources.join(', ')}]`);
        }
      }

      // Peer exchange: receive peer list from a connected node and dial unknown peers.
      if (message.type === MessageType.PEER_EXCHANGE) {
        const exchangedPeers = (message.payload as any)?.peers as { peerId: string; addrs: string[] }[] | undefined;
        if (exchangedPeers && Array.isArray(exchangedPeers) && this.network) {
          const network = this.network;
          const myPeerId = this.identity!.peerId;
          const connectedPeers = new Set(network.getPeers().map(p => p.peerId));
          console.log(`[peer-exchange] Received ${exchangedPeers.length} peer(s) from ${from.slice(0, 12)}, already connected to ${connectedPeers.size}`);
          (async () => {
            let dialed = 0;
            for (const peer of exchangedPeers) {
              if (peer.peerId === myPeerId || connectedPeers.has(peer.peerId)) continue;
              for (const addr of peer.addrs) {
                try {
                  await network.dialPeer(addr);
                  dialed++;
                  console.log(`[peer-exchange] Connected to ${peer.peerId.slice(0, 12)} via exchange from ${from.slice(0, 12)}`);
                  break;
                } catch {
                  // addr may be unreachable, try next
                }
              }
            }
            if (dialed > 0) {
              console.log(`[peer-exchange] Discovered ${dialed} new peer(s) from ${from.slice(0, 12)}`);
            }
          })().catch(() => {});
        }
      }
    });

    // v2.4: Subscribe to node_compromised broadcasts from peers
    await this.network.subscribeNodeCompromised();
    this.network.onNodeCompromised((compromisedPeerId, reason, timestamp) => {
      console.warn(`[security] Peer ${compromisedPeerId.slice(0, 12)} signaled compromise (${reason}) at ${new Date(timestamp).toISOString()}`);
      // Remove compromised peer from credential routing by marking them non-credentialAccess
      const profile = this.capabilityRegistry.getPeerProfile(compromisedPeerId);
      if (profile) {
        (profile as any).credentialAccess = false;
        (profile as any).compromisedAt = timestamp;
        this.capabilityRegistry.updatePeerProfile(profile);
        console.warn(`[security] Peer ${compromisedPeerId.slice(0, 12)} removed from credential routing`);
      }
    });

    // Safe self-restart watchdog: detect when the running process has stale compiled code.
    // Checks every 5 minutes: re-reads .build-commit from disk (upgrade catch-up may
    // have rebuilt and updated it), compares against git HEAD, and exits with code 75
    // if they differ and no active workers are in flight.
    {
      const buildCommitPaths = [
        join(process.cwd(), 'packages', 'node', 'dist', '.build-commit'),
        join(process.cwd(), 'dist', '.build-commit'),
      ];
      const readBuildCommit = (): string | null => {
        for (const p of buildCommitPaths) {
          try {
            const val = readFileSync(p, 'utf8').trim();
            if (val) return val;
          } catch { /* try next */ }
        }
        return null;
      };
      const initialCommit = readBuildCommit();
      if (initialCommit) {
        console.log(`[self-restart] Stale-build watchdog active (built at ${initialCommit.slice(0, 8)})`);
        const selfRestartInterval = setInterval(() => {
          try {
            // Re-read .build-commit each cycle — upgrade catch-up may have rebuilt
            const builtCommit = readBuildCommit();
            if (!builtCommit) return;
            const currentCommit = (execSync('git rev-parse HEAD', {
              cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
            }) as string).trim();
            if (currentCommit === builtCommit) return; // build matches HEAD — nothing to do
            const activeWorkers = this.workerPool?.getActiveWorkerCount() ?? 0;
            if (activeWorkers > 0) {
              console.log(`[self-restart] Stale build detected (built=${builtCommit.slice(0, 8)}, head=${currentCommit.slice(0, 8)}) but ${activeWorkers} worker(s) active — deferring restart`);
              return;
            }
            console.log(`[self-restart] Stale build detected and no active workers — restarting (exit ${RESTART_EXIT_CODE})`);
            clearInterval(selfRestartInterval);
            process.exit(RESTART_EXIT_CODE);
          } catch { /* git unavailable or cwd mismatch — skip silently */ }
        }, 5 * 60 * 1000);
        selfRestartInterval.unref(); // don't prevent normal node exit
      } else {
        console.log('[self-restart] No build-commit stamp found — stale-build watchdog disabled (run npm run build to enable)');
      }
    }

    // v2.3: Compute and log final boot health
    this._computeBootHealth();

  }

  /**
   * Record an uptime epoch — mints a small Lux reward for being online.
   * Called every 10 minutes. Capped at 144 epochs/day (7.2 Lux/day max)
   * and subject to the 500 Lux/day per-node daily emission cap.
   */
  private recordUptimeEpoch(): void {
    if (!this.ledger || !this.identity) return;

    // Reset daily counter at midnight
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyEmissionResetDate !== today) {
      this.dailyEmissions = 0;
      this.uptimeEpochs = 0;
      this.dailyEmissionResetDate = today;
    }

    // Daily cap: 500 Lux max per node per day
    if (this.dailyEmissions >= 500) return;

    // Max uptime reward: 7.2 Lux/day (144 epochs × 0.05)
    const MAX_UPTIME_EPOCHS_PER_DAY = 144;
    if (this.uptimeEpochs >= MAX_UPTIME_EPOCHS_PER_DAY) return;

    this.uptimeEpochs++;
    // Phase 54: Node identity = reward recipient
    const rewardRecipient = this.getRewardRecipient();
    if (!rewardRecipient) return;

    if (this.emissionWitness) {
      this.emissionWitness.propose(
        rewardRecipient,
        WorkType.UPTIME_EPOCH,
        `uptime epoch ${this.uptimeEpochs} (${today})`
      ).catch(() => {});
    } else {
      try {
        const tx = this.ledger.rewardWork(
          rewardRecipient,
          WorkType.UPTIME_EPOCH,
          `uptime epoch ${this.uptimeEpochs} (${today})`
        );
        this.dailyEmissions += tx.amount;
        this.sync?.broadcastTransaction(tx).catch(() => {});
      } catch {
        // Cap reached — silently continue
      }
    }
  }

  /**
   * AI search — Phase 69: credential-node-only.
   * If this node has CREDENTIAL_MASTER_KEY, decrypts AI key and calls directly.
   * Otherwise, routes via P2P request-reply to a compute node that has it.
   */
  async search(query: string, identity?: string): Promise<SearchResult> {
    // Try local credential access first (compute nodes with master key)
    if (this.resourceRegistry) {
      const aiKey = await this.resourceRegistry.getActiveAiKey();
      if (aiKey) {
        const result = aiKey.provider === 'openai'
          ? await this.searchOpenAI(query, aiKey.key, aiKey.model)
          : await this.searchGemini(query, aiKey.key, aiKey.model);
        if (result) {
          this.resourceMeter?.recordUsage(aiKey.resourceId, 'api_keys', {
            resourceType: 'api_keys', quantity: 1, unit: 'calls', timestamp: Date.now(),
          });
          return result;
        }
      }
    }

    // Phase 69: Route to a compute node with credentialAccess via P2P
    if (this.capabilityRegistry && this.requestReply) {
      const allProfiles = this.capabilityRegistry.getAllProfiles();
      const credentialProfiles = allProfiles.filter(p =>
        p.credentialAccess === true && p.peerId !== this.identity?.peerId
      );

      for (const profile of credentialProfiles) {
        try {
          const response = await this.requestReply.request(profile.peerId, 'pando/ai-query', { query }, 30_000);
          if (response?.success && response.payload?.answer) {
            return {
              answer: response.payload.answer,
              sources: response.payload.sources || [],
              confidence: response.payload.confidence || 'medium',
              respondedBy: profile.peerId,
            };
          }
        } catch {
          continue; // Try next credential node
        }
      }
    }

    return {
      answer: 'No AI resources available on the network. Contribute an API key via /contribute.',
      sources: [],
      confidence: 'none',
      respondedBy: 'node',
    };
  }

  private async searchOpenAI(query: string, apiKey: string, model: string): Promise<SearchResult | null> {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: query },
          ],
          max_tokens: 1024,
          temperature: 0.7,
        }),
      });
      if (!res.ok) { const e = await res.json() as any; console.error('OpenAI error:', e?.error?.message); return null; }
      const data = await res.json() as any;
      return {
        answer: data?.choices?.[0]?.message?.content || 'No response generated.',
        sources: ['Pando Network', `AI: ${model}`],
        confidence: 'high',
        respondedBy: `pando-ai (${model})`,
      };
    } catch (err) { console.error('OpenAI fetch error:', err); return null; }
  }

  private async searchGemini(query: string, apiKey: string, model: string): Promise<SearchResult | null> {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nQuestion: ${query}` }] }],
          generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
        }),
      });
      if (!res.ok) { const e = await res.json() as any; console.error('Gemini error:', e?.error?.message); return null; }
      const data = await res.json() as any;
      return {
        answer: data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.',
        sources: ['Pando Network', `AI: ${model}`],
        confidence: 'high',
        respondedBy: `pando-ai (${model})`,
      };
    } catch (err) { console.error('Gemini fetch error:', err); return null; }
  }

  /**
   * Check if auto-snapshot threshold has been reached and create one if so.
   */
  private checkAutoSnapshot(): void {
    if (!this.ledger) return;
    const currentTxCount = this.ledger.getNetworkStats().totalTransactions;
    if (currentTxCount - this.lastSnapshotTxCount >= this.snapshotInterval) {
      try {
        const info = this.ledger.createSnapshot(this.config.dataDir || undefined);
        this.lastSnapshotTxCount = currentTxCount;
        console.log(`[snapshot] Auto-created: ${info.filename} (${info.accountCount} accounts, ${info.transactionCount} txs)`);
      } catch (err: any) {
        console.error(`[snapshot] Auto-create failed: ${err.message}`);
      }
    }
  }

  /**
   * v2.4: Trigger local compromise response.
   * Wipes credential key from memory + broadcasts node_compromised to network.
   * Called by: admin endpoint, future OS-level tripwire detection.
   */
  async triggerLocalCompromise(reason: string): Promise<void> {
    console.warn(`[security] TRIPWIRE TRIGGERED: ${reason}`);
    // Step 1: Wipe credential key from memory
    const credStore = (this as any)._credentialStore as CredentialStore | undefined;
    if (credStore) {
      credStore.wipe();
    }
    // Step 2: Broadcast to network
    if (this.network) {
      await this.network.publishNodeCompromised(reason).catch(() => {});
    }
  }

  /** v2.3: Get current boot health snapshot. */
  getNodeHealth(): NodeHealth {
    return { ...this.nodeHealth, bootSteps: { ...this.nodeHealth.bootSteps }, degraded: [...this.nodeHealth.degraded] };
  }

  /**
   * v2.3: Compute final boot health from initialized field state.
   * Called at the end of _start() after all subsystems have been initialized.
   */
  private _computeBootHealth(): void {
    const s = this.nodeHealth.bootSteps;

    // Kernel (Layer 0): must-have P2P primitives
    s['ledger']     = this.ledger         ? 'ok' : 'failed';
    s['network']    = this.network        ? 'ok' : 'failed';
    s['sync']       = this.sync           ? 'ok' : 'failed';
    s['governance'] = this.governance     ? 'ok' : 'failed';
    s['security']   = this.securityMonitor ? 'ok' : 'skipped';

    // Core (Layer 1): business logic
    s['request-reply']    = this.requestReply    ? 'ok' : 'failed';
    s['storage']          = this.storageBackend  ? 'ok' : 'degraded';
    s['resource-registry']= this.resourceRegistry ? 'ok' : 'skipped';
    s['upgrade-protocol'] = this.upgradeProtocol ? 'ok' : 'skipped';

    // Platform (Layer 2): optional services
    s['api-server']   = this.apiServer     ? 'ok' : 'failed';
    s['scheduler']    = this.schedulerEnabled ? 'ok' : 'skipped';
    s['monitor']      = this.monitorEnabled  ? 'ok' : 'skipped';
    s['agents']       = this.agentSystemStarted ? 'ok' : 'skipped';
    s['thread-store'] = this.threadStore   ? 'ok' : 'degraded';
    s['content']      = this.contentRegistry ? 'ok' : 'skipped';
    s['local-env']    = this.localEnv      ? 'ok' : 'degraded';

    // Kernel health: any critical kernel step failed → failed
    const kernelFailed = ['ledger', 'network', 'sync', 'governance'].some(k => s[k] === 'failed');
    this.nodeHealth.kernel = kernelFailed ? 'failed' : 'healthy';

    // Core health: storage degraded or request-reply failed → degraded
    if (s['request-reply'] === 'failed') {
      this.nodeHealth.core = 'failed';
    } else if (s['storage'] === 'degraded') {
      this.nodeHealth.core = 'degraded';
    } else {
      this.nodeHealth.core = 'healthy';
    }

    // Platform health: api-server failed → failed; thread-store degraded → degraded.
    // Scheduler and monitor are only ever 'ok' | 'skipped' (never 'failed'),
    // so skipped services do NOT cause degraded status.
    if (s['api-server'] === 'failed') {
      this.nodeHealth.platform = 'failed';
    } else if (s['thread-store'] === 'degraded') {
      this.nodeHealth.platform = 'degraded';
    } else {
      this.nodeHealth.platform = 'healthy';
    }

    // Operational mode: 3 = full (storage connected), 2 = P2P-only, 1 = local-only
    const mode: OperationalMode = this.storageBackend
      ? 3
      : (this.network ? 2 : 1);
    this.nodeHealth.mode = mode;

    // Collect all degraded/failed steps
    this.nodeHealth.degraded = Object.entries(s)
      .filter(([, v]) => v === 'failed' || v === 'degraded')
      .map(([k]) => k);

    console.log(`[boot] Health: kernel=${this.nodeHealth.kernel} core=${this.nodeHealth.core} platform=${this.nodeHealth.platform} mode=${this.nodeHealth.mode}`);
    if (this.nodeHealth.degraded.length > 0) {
      console.log(`[boot] Degraded: ${this.nodeHealth.degraded.join(', ')}`);
    }
  }

  /** v2.5: Get the Local Environment (Envelope 1 file index + user memory). */
  getLocalEnv(): LocalEnvironment | null {
    return this.localEnv;
  }

  getNetwork(): PandoNetwork | null {
    return this.network;
  }

  getIdentity(): NodeIdentity | null {
    return this.identity;
  }

  getLedger(): PandoLedger | null {
    return this.ledger;
  }

  getSync(): LedgerSync | null {
    return this.sync;
  }

  getApiServer(): ApiServer | null {
    return this.apiServer;
  }

  getDataDir(): string {
    return this.config.dataDir || '';
  }

  getNodeMode(): string {
    return this.config.nodeMode || 'full';
  }

  getLedgerMode(): string {
    return this.config.ledgerMode || 'full';
  }

  getApiPort(): number {
    return this.config.apiPort;
  }

  getCapabilities(): string[] {
    return [...this.detectedCapabilities];
  }

  getCapabilityDeclaration(): CapabilityDeclaration | null {
    if (!this.identity || !this.capabilityDetection) return null;
    return {
      peerId: this.identity.peerId,
      capabilities: this.capabilityDetection.capabilities,
      detectedAt: this.capabilityDetection.detectedAt,
      timestamp: Date.now(),
    };
  }

  getPeerCapabilityDeclarations(): Map<string, CapabilityDeclaration> {
    return new Map(this.peerCapabilities);
  }

  /** Phase A: Get the local node's rich capability profile (broadcast profile — shared caps only) */
  getCapabilityProfile(): CapabilityProfile | null {
    return this.capabilityRegistry.getLocalProfile();
  }

  /** Phase 96: Get the LocalCapabilityStore (full detected + sharing preferences) */
  getLocalCapabilityStore(): LocalCapabilityStore | null {
    return this.localCapStore;
  }

  /** Phase A: Get all known capability profiles (local + peers) */
  getNetworkCapabilityProfiles(): CapabilityProfile[] {
    return this.capabilityRegistry.getAllProfiles();
  }

  /** Phase A: Get the CapabilityRegistry instance */
  getCapabilityRegistry(): CapabilityRegistry {
    return this.capabilityRegistry;
  }

  /** Phase B: Get the ResourceRouter instance */
  getResourceRouter(): ResourceRouter | null {
    return this.resourceRouter;
  }

  /** Phase C: Get the ResourceMeter instance */
  getResourceMeter(): ResourceMeter | null {
    return this.resourceMeter;
  }

  /** Phase D: Get the ResourceMarketplace instance */
  getResourceMarketplace(): ResourceMarketplace | null {
    return this.resourceMarketplace;
  }

  /** Phase 42.5: Get the ResourceRegistry instance */
  getResourceRegistry(): ResourceRegistry | null {
    return this.resourceRegistry;
  }

  getResourceHealthChecker(): ResourceHealthChecker | null {
    return this.resourceHealthChecker;
  }

  /** Returns the reward recipient — only linked user accounts earn rewards */
  getRewardRecipient(): string | null {
    // No login = no rewards. Node is volunteering infrastructure.
    // Rewards only flow when an operator explicitly links their account.
    if (this.linkedUser) return this.linkedUser.peerId;
    return null;
  }

  /** Phase 55: Link a user account to this node — rewards flow to the user */
  linkUser(peerId: string, username?: string): void {
    this.linkedUser = { peerId, username };
    const linkedUserPath = join(this.config.dataDir || join(homedir(), '.pando'), 'linked-user.json');
    writeFileSync(linkedUserPath, JSON.stringify({ peerId, username }, null, 2));
    console.log(`[node] Linked to user account: ${username || peerId}`);
    this.updateCapabilityLinkedUser();
  }

  /** Phase 55: Unlink the user account — rewards revert to node identity */
  unlinkUser(): void {
    this.linkedUser = null;
    const linkedUserPath = join(this.config.dataDir || join(homedir(), '.pando'), 'linked-user.json');
    try {
      if (existsSync(linkedUserPath)) {
        unlinkSync(linkedUserPath);
      }
    } catch { /* ignore */ }
    console.log('[node] Unlinked user account');
    this.updateCapabilityLinkedUser();
  }

  /** Phase 55: Get the linked user account (null = rewards go to node identity) */
  getLinkedUser(): { peerId: string; username?: string } | null {
    return this.linkedUser;
  }

  private async broadcastCapabilities(): Promise<void> {
    const declaration = this.getCapabilityDeclaration();
    if (!declaration || !this.network) return;
    await this.network.publishCapabilities(declaration);
  }

  private updateCapabilityLinkedUser(): void {
    const localProfile = this.capabilityRegistry.getLocalProfile();
    if (localProfile) {
      localProfile.linkedUser = this.linkedUser?.username ? { username: this.linkedUser.username } : null;
      localProfile.updatedAt = Date.now();
      this.capabilityRegistry.setLocalProfile(localProfile);
      this.broadcastCapabilityProfile().catch(() => {});
    }
  }

  /**
   * Phase 97: Rebuild and rebroadcast the capability profile after sharing preferences change.
   * Called by /contribute and /revoke TUI commands after updating LocalCapabilityStore.
   */
  rebuildCapabilityProfile(): void {
    if (!this.identity) return;
    const linkedUserForProfile = this.linkedUser?.username ? { username: this.linkedUser.username } : null;
    const newProfile = detectCapabilityProfile(this.identity.peerId, this.config.apiPort, linkedUserForProfile, this.localCapStore);
    this.capabilityRegistry.setLocalProfile(newProfile);
    this.broadcastCapabilityProfile().catch(() => {});
    const shared = this.localCapStore?.getShared() || [];
    console.log(`[capabilities] Profile rebuilt. Sharing: ${shared.length > 0 ? shared.join(', ') : '(none)'}`);
  }

  private async broadcastCapabilityProfile(): Promise<void> {
    const profile = this.capabilityRegistry.getLocalProfile();
    if (!profile || !this.network) return;
    // Update timestamp before broadcasting
    profile.updatedAt = Date.now();
    await this.network.publishCapabilityProfile(profile);
  }

  // ----------------------------------------------------------
  // Phase 104: Project Orchestrator Pipeline
  // ----------------------------------------------------------

  /**
   * Ensure a project has a local workspace directory.
   * New projects: mkdir + git init + write CLAUDE.md
   * Returning projects with githubRepo: git clone
   * Returns the workspace path or null on failure.
   */
  async ensureProjectWorkspace(projectId: string): Promise<string | null> {
    if (!this.projectStore) return null;

    const project = await this.projectStore.getProjectAsync(projectId);
    if (!project) return null;

    // If workspace already exists and directory is valid, return it
    if (project.workspaceDir && existsSync(project.workspaceDir)) {
      return project.workspaceDir;
    }

    const dataDir = this.config.dataDir || join(homedir(), '.pando');
    const wsDir = join(dataDir, 'projects', projectId);

    if (!existsSync(wsDir)) {
      mkdirSync(wsDir, { recursive: true });
    }

    const hasGitDir = existsSync(join(wsDir, '.git'));

    // If project has a GitHub repo and we don't have a local clone, clone it
    if (!hasGitDir && project.githubRepo) {
      try {
        const pat = await this.getGitHubPat();
        const cloneUrl = pat
          ? `https://x-access-token:${pat}@github.com/${project.githubRepo}.git`
          : `https://github.com/${project.githubRepo}.git`;
        execSync(`git clone ${cloneUrl} .`, { cwd: wsDir, timeout: 60000, stdio: 'ignore' });
        console.log(`[project-workspace] Cloned ${project.githubRepo} into ${wsDir}`);
      } catch (err: any) {
        console.warn(`[project-workspace] Clone failed (using empty workspace): ${err.message?.slice(0, 100)}`);
      }
    }

    // Ensure git is initialized
    if (!existsSync(join(wsDir, '.git'))) {
      try {
        execSync('git init', { cwd: wsDir, timeout: 5000, stdio: 'ignore' });
        console.log(`[project-workspace] Initialized git in ${wsDir}`);
      } catch { /* non-fatal */ }
    }

    // Write initial CLAUDE.md if it doesn't exist
    const claudeMdPath = join(wsDir, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      const content = [
        `# ${project.name}`,
        '',
        project.description || '',
        '',
        `Project ID: ${projectId}`,
        `Tier: ${project.tier || 1}`,
        `Created: ${new Date(project.createdAt).toISOString()}`,
        '',
        '## Build Instructions',
        '',
        'This project is managed by a Pando AI project manager.',
        'Builders: write clean, working code. Run build before reporting done.',
        'Testers: verify independently. Do NOT trust the builder.',
      ].join('\n');
      writeFileSync(claudeMdPath, content);
    }

    // Bootstrap genome directory structure if it doesn't exist
    const genomeDir = join(wsDir, 'genome');
    if (!existsSync(genomeDir)) {
      try {
        mkdirSync(genomeDir, { recursive: true });
        mkdirSync(join(genomeDir, 'rules'), { recursive: true });

        writeFileSync(join(genomeDir, 'genome.yaml'), [
          'version: 1',
          'project: auto-bootstrapped',
          'description: Project knowledge base',
        ].join('\n'));

        writeFileSync(join(genomeDir, 'state.md'), [
          '# Project State',
          '',
          '## Status',
          'Initialized',
          '',
          '## Recent Changes',
          '(none yet)',
        ].join('\n'));

        writeFileSync(join(genomeDir, 'rules', 'deployment.md'), [
          '# Deployment Rules',
          '',
          '## Tier 1 — Static Apps (S3)',
          '- HTML/CSS/JS only apps are deployed to AWS S3 static hosting.',
          '- Build output goes to dist/ or build/ directory.',
          '- No server-side code.',
          '',
          '## Tier 2 — Server Apps (PM2 + nginx)',
          '- Node.js or other server apps run via PM2.',
          '- Served at /apps/<projectId>/ via nginx reverse proxy.',
          '- App must listen on the assigned PORT environment variable.',
          '',
          '## CRITICAL: URL Rules',
          '- NEVER hardcode localhost or 127.0.0.1 in client-facing code.',
          '- Browsers: use window.location.origin or relative paths for API calls.',
          '- Servers: bind to 0.0.0.0 (not localhost) so nginx can proxy to the process.',
          '- WebSocket: use wss:// with window.location.host, not ws://localhost.',
          '',
          '## Port Assignment',
          '- The PORT env var is set by the deployment system. Always use process.env.PORT.',
        ].join('\n'));

        console.log(`[project-workspace] Bootstrapped genome in ${genomeDir}`);
      } catch (err: any) {
        console.warn(`[project-workspace] Genome bootstrap failed (non-fatal): ${err.message?.slice(0, 100)}`);
      }
    }

    // Import team-state.json if it exists (from a previous clone)
    const teamStatePath = join(wsDir, 'team-state.json');
    if (existsSync(teamStatePath) && this.agentDb) {
      try {
        const state = JSON.parse(readFileSync(teamStatePath, 'utf-8'));
        const isV2 = state.version === 2;

        // Import lessons (v1 and v2)
        if (state.lessons?.length) {
          for (const l of state.lessons) {
            this.agentDb.addLesson({
              orchestratorId: 'imported',
              projectId,
              lesson: l.lesson,
              source: l.source || 'imported-team-state',
              relevanceTags: l.relevanceTags ? (typeof l.relevanceTags === 'string' ? JSON.parse(l.relevanceTags) : l.relevanceTags) : [],
              confidence: (l.confidence || 0.5) * 0.8, // Phase 105: slight decay for cross-node transfer
            });
          }
          console.log(`[project-workspace] Imported ${state.lessons.length} lessons from team-state.json`);
        }

        // Phase 105: Import reflections (v2 only)
        if (isV2 && state.reflections?.length) {
          for (const r of state.reflections) {
            this.agentDb.addReflection({
              orchestratorId: 'imported',
              level: r.level || 'project',
              trigger: r.trigger || 'imported',
              inputSummary: undefined,
              output: r.output,
              lessonsCreated: r.lessonsCreated || 0,
            });
          }
          console.log(`[project-workspace] Imported ${state.reflections.length} reflections from team-state.json`);
        }

        // Phase 105: Import directives (v2 only)
        if (isV2 && state.directives?.length) {
          for (const d of state.directives) {
            if (d.active) {
              this.agentDb.addDirective({
                targetId: undefined, // will be bound when orchestrator is created
                content: d.content,
                addedBy: d.addedBy || 'imported',
              });
            }
          }
          console.log(`[project-workspace] Imported ${state.directives.length} directives from team-state.json`);
        }

        // Phase 105: Log team stats (v2 only)
        if (isV2 && state.team?.stats) {
          const s = state.team.stats;
          console.log(`[project-workspace] Previous team: ${s.totalWorkersSpawned || 0} workers spawned, $${(s.totalBudgetSpent || 0).toFixed(2)} budget spent`);
        }
      } catch { /* non-fatal */ }
    }

    // Update project record with workspace path
    await this.projectStore.updateProject(projectId, { workspaceDir: wsDir });
    console.log(`[project-workspace] Workspace ready: ${wsDir}`);
    return wsDir;
  }

  /**
   * Get a GitHub PAT from contributed resources.
   */
  private async getGitHubPat(): Promise<string | null> {
    if (!this.resourceRegistry) return null;
    try {
      const resources = this.resourceRegistry.getAllResources();
      const ghRes = resources.find((r: any) => r.type === 'code_repository' && r.status === 'active');
      if (!ghRes) return null;
      // Try to get credential via P2P proxy
      const cred = await (this as any).proxyCredentialOp?.('get', { resourceId: ghRes.resourceId });
      return cred?.key || null;
    } catch { return null; }
  }

  /**
   * Phase 104: Export team state to JSON in the project workspace.
   * Called before each project commit.
   */
  private exportTeamState(projectId: string, workspaceDir: string): void {
    if (!this.agentDb) return;
    try {
      const agents = this.agentDb.listAgents({ projectId });
      const lessons = this.agentDb.getLessons({ projectId, limit: 50 });

      // Phase 105: v2 format — includes reflections, directives, team blueprint
      // Find the orchestrator for team blueprint
      const orch = agents.find((a: any) => a.type === 'orchestrator');
      const workers = agents.filter((a: any) => a.type === 'worker');

      // Build team blueprint
      const blueprint = orch ? [{
        role: orch.role,
        type: 'orchestrator' as const,
        templateId: orch.templateId || null,
        children: workers.map((w: any) => ({
          role: w.role,
          type: 'worker' as const,
          templateId: w.templateId || null,
        })),
      }] : [];

      // Calculate stats
      const stats = {
        totalWorkersSpawned: workers.length,
        totalBudgetSpent: agents.reduce((sum: number, a: any) => sum + (a.budgetSpent || 0), 0),
        firstCreated: agents.length > 0 ? agents.reduce((min: string, a: any) => a.createdAt < min ? a.createdAt : min, agents[0].createdAt) : null,
        lastActive: agents.length > 0 ? agents.reduce((max: string, a: any) => (a.updatedAt || a.createdAt) > max ? (a.updatedAt || a.createdAt) : max, agents[0].updatedAt || agents[0].createdAt) : null,
      };

      // Get reflections (project-level, last 20)
      let reflections: any[] = [];
      if (orch) {
        try {
          reflections = this.agentDb.getReflections(orch.id, 20).map((r: any) => ({
            level: r.level,
            trigger: r.trigger,
            output: r.output,
            lessonsCreated: r.lessonsCreated,
            createdAt: r.createdAt,
          }));
        } catch { /* reflections table may not have data */ }
      }

      // Get directives (active only)
      let directives: any[] = [];
      if (orch) {
        try {
          directives = this.agentDb.getDirectives(orch.id).map((d: any) => ({
            content: d.content,
            addedBy: d.addedBy,
            active: d.active,
          }));
        } catch { /* non-fatal */ }
      }

      const teamState = {
        version: 2,
        projectId,
        exportedAt: Date.now(),
        team: { blueprint, stats },
        agents: agents.map((a: any) => ({
          id: a.id,
          role: a.role,
          type: a.type,
          status: a.status,
          templateId: a.templateId || null,
          sessionId: a.sessionId || null,
          parentId: a.parentId || null,
          lastReportAt: a.lastReportAt || null,
          budgetSpent: a.budgetSpent || 0,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        })),
        lessons: lessons.map((l: any) => ({
          lesson: l.lesson,
          source: l.source,
          confidence: l.confidence,
          timesUsed: l.timesUsed,
          relevanceTags: l.relevanceTags || null,
        })),
        reflections,
        directives,
      };

      writeFileSync(join(workspaceDir, 'team-state.json'), JSON.stringify(teamState, null, 2));
    } catch (err: any) {
      console.warn(`[project-orch] Failed to export team state: ${err.message?.slice(0, 100)}`);
    }
  }

  /**
   * Phase 104: Create project-scoped onCommit callback.
   * Commits in the project workspace, then pushes to GitHub.
   */
  private makeProjectCommitCallback(projectId: string): (message: string) => Promise<boolean> {
    return async (message: string) => {
      const project = this.projectStore?.getProject(projectId);
      const wsDir = project?.workspaceDir;
      if (!wsDir || !existsSync(wsDir)) {
        console.error(`[project-orch] No workspace for project ${projectId}, cannot commit`);
        return false;
      }

      try {
        // Export team state before committing
        this.exportTeamState(projectId, wsDir);

        // Git add, check, commit (exclude CLAUDE.md — it's a worker context file, not project code)
        execSync('git add -A -- ":(exclude)CLAUDE.md"', { cwd: wsDir, timeout: 10000 });
        const status = execSync('git status --porcelain', { cwd: wsDir, encoding: 'utf-8', timeout: 5000 });
        if (!status.trim()) {
          console.log(`[project-orch] Nothing to commit in project ${projectId}`);
          return false;
        }
        execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: wsDir, timeout: 30000 });
        console.log(`[project-orch] Committed in ${wsDir}: ${message}`);

        // Push to GitHub via the API endpoint (non-fatal if fails)
        try {
          const port = this.config.apiPort;
          let token = '';
          try {
            const tokenPath = join(this.config.dataDir || join(homedir(), '.pando'), 'api-token');
            if (existsSync(tokenPath)) token = readFileSync(tokenPath, 'utf-8').trim();
          } catch { /* no token */ }
          const pushUrl = `http://127.0.0.1:${port}/v1/projects/${projectId}/github/push`;
          await fetch(pushUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceDir: wsDir }),
            signal: AbortSignal.timeout(60000),
          });
          console.log(`[project-orch] Pushed to GitHub for project ${projectId}`);
        } catch (pushErr: any) {
          console.warn(`[project-orch] GitHub push failed (non-fatal): ${pushErr.message?.slice(0, 100)}`);
        }

        // Post-commit: recompile genome graph if genome.py exists in project
        try {
          execSync('python genome.py compile . 2>/dev/null || python3 genome.py compile . 2>/dev/null', {
            cwd: wsDir, timeout: 15000, stdio: 'ignore'
          });
          this.genomeBridgeRegistry?.reloadAll();
          console.log(`[project-orch] Genome recompiled for project ${projectId}`);
        } catch {
          // Python or genome.py not available in project — skip silently
        }

        return true;
      } catch (err: any) {
        console.error(`[project-orch] Commit failed: ${err.message?.slice(0, 200)}`);
        return false;
      }
    };
  }

  // Phase 105: makeProjectDeployCallback removed — deployment is now agent-driven.
  // The devops agent calls POST /v1/projects/:id/deploy directly via HTTP.

  /**
   * Phase 104: Instantiate a live Orchestrator from its DB record.
   * Determines callbacks based on role (council vs project), starts tick loop.
   */
  instantiateOrchestrator(orchId: string): Orchestrator | null {
    if (this.liveOrchestrators.has(orchId)) {
      return this.liveOrchestrators.get(orchId)!;
    }

    if (!this.agentDb || !this.messageBus || !this.workerPool || !this.orgManager || !this.aiBackendRegistry) {
      console.error(`[orchestrator] Cannot instantiate ${orchId} — agent system not ready`);
      return null;
    }

    const agent = this.agentDb.getAgent(orchId);
    if (!agent || agent.type !== 'orchestrator') {
      console.error(`[orchestrator] Cannot instantiate ${orchId} — not found or not an orchestrator`);
      return null;
    }

    const isCouncil = agent.role === 'council';
    const projectId = agent.projectId;

    let onCommit: ((message: string) => Promise<boolean>) | undefined;
    let onPropose: ((title: string, description: string, diff?: string) => Promise<void>) | undefined;

    if (isCouncil) {
      // Council callbacks — operate on Pando repo root
      onCommit = async (message) => {
        try {
          const cwd = process.cwd();
          execSync('git add -A -- ":(exclude)CLAUDE.md"', { cwd, timeout: 10000 });
          const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000 });
          if (!status.trim()) {
            console.log('[orchestrator] Nothing to commit');
            // Still push — flush any orphaned commits from builders that committed directly
            try {
              execSync('git push origin master', { cwd, timeout: 30000 });
              console.log('[orchestrator] Pushed orphaned commits to origin');
            } catch (pushErr: any) {
              console.warn('[orchestrator] Push failed (non-fatal):', pushErr.message?.slice(0, 100));
            }
            return false;
          }
          execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd, timeout: 30000 });
          console.log(`[orchestrator] Committed: ${message}`);
          try {
            execSync('git push origin master', { cwd, timeout: 30000 });
            console.log('[orchestrator] Pushed to origin');
          } catch (pushErr: any) {
            console.warn('[orchestrator] Push failed (non-fatal):', pushErr.message?.slice(0, 100));
          }
          // Post-commit: recompile genome graph and reload bridges
          try {
            execSync('python genome.py compile . 2>/dev/null || python3 genome.py compile . 2>/dev/null', {
              cwd, timeout: 15000, stdio: 'ignore'
            });
            this.genomeBridgeRegistry?.reloadAll();
            console.log('[orchestrator] Genome recompiled + bridge reloaded');
          } catch {
            // Python not available or compiler not found — skip silently
          }
          return true;
        } catch (err: any) {
          console.error('[orchestrator] Commit failed:', err.message?.slice(0, 200));
          return false;
        }
      };
      onPropose = this.upgradeProtocol ? async (title, description) => {
        await this.upgradeProtocol!.createUpgradeProposal(`${title}: ${description}`);
      } : (this.governance ? async (title, description) => {
        await this.governance!.createProposal(title, description);
      } : undefined);
    } else if (projectId) {
      // Project callbacks — operate on project workspace
      onCommit = this.makeProjectCommitCallback(projectId);
    }

    const orch = new Orchestrator(orchId, {
      db: this.agentDb,
      messageBus: this.messageBus,
      workerPool: this.workerPool,
      orgManager: this.orgManager,
      aiRegistry: this.aiBackendRegistry,
      genomeBridge: this.genomeBridge || undefined,
      genomeBridgeRegistry: this.genomeBridgeRegistry ?? undefined,
      scenarioRunner: this.scenarioRunner || undefined,
      templateRegistry: this.templateRegistry || undefined,
      threadStore: this.threadStore || undefined,
      apiPort: this.config.apiPort,
      dataDir: this.config.dataDir || join(homedir(), '.pando'),
      repoDir: process.cwd(),
      onCommit,
      onPropose,
    });

    orch.start();
    this.liveOrchestrators.set(orchId, orch);
    console.log(`[orchestrator] Instantiated ${agent.role} orchestrator: ${orchId}` + (projectId ? ` (project ${projectId})` : ''));

    return orch;
  }

  /**
   * Phase 104: Ensure a project orchestrator is instantiated and running.
   * Called from platform-api.ts when routing messages to project orchestrators.
   */
  async ensureProjectOrchestrator(projectId: string): Promise<string | null> {
    if (!this.orgManager || !this.agentDb) return null;

    // 1. Ensure workspace exists
    await this.ensureProjectWorkspace(projectId);

    // 2. Get or create the orchestrator DB record
    const orchId = this.orgManager.getOrchestratorForProject(projectId);

    // 3. Set workspace on orchestrator DB record
    const project = this.projectStore?.getProject(projectId);
    if (project?.workspaceDir) {
      this.agentDb.updateAgent(orchId, { workspaceDir: project.workspaceDir });
    }

    // 4. Ensure live instance is running
    if (!this.liveOrchestrators.has(orchId)) {
      this.instantiateOrchestrator(orchId);
    }

    return orchId;
  }

  // ----------------------------------------------------------
  // Agent System (Phase 27 — always runs, provides chat routing + project managers)
  // ----------------------------------------------------------

  /**
   * Start the new agent system: AgentDatabase, MessageBus, WorkerPool,
   * OrgManager, and the council Orchestrator.
   */
  startAgentSystem(): void {
    if (this.agentSystemStarted) return;
    this.agentSystemStarted = true;

    const dataDir = this.config.dataDir;

    // v2.1: Initialize AI Backend Registry — detect available backends
    this.aiBackendRegistry = new AIBackendRegistry();
    this.aiBackendRegistry.register(new ClaudeBackend());
    this.aiBackendRegistry.register(new OllamaBackend());
    this.aiBackendRegistry.detectAll().catch(err =>
      console.warn('[ai-backend] Detection error:', err)
    );

    // Initialize unified agent database
    this.agentDb = new AgentDatabase(dataDir);
    const { cleaned, interruptedWorkers } = this.agentDb.cleanupStaleAgents();
    if (cleaned > 0) console.log(`[agents] Cleaned ${cleaned} stale agents from previous run`);
    if (interruptedWorkers.length > 0) console.log(`[agents] ${interruptedWorkers.length} worker(s) were interrupted during restart`);
    console.log('[agents] AgentDatabase initialized');

    // Initialize MessageBus
    this.messageBus = new MessageBus(this.agentDb);
    console.log('[agents] MessageBus initialized');

    // Send worker_interrupted messages for workers interrupted during node restart.
    // Orchestrator (orchestrator.ts) filters for 'worker_interrupted' type and surfaces
    // these in the dedicated interrupted-workers board section.
    for (const worker of interruptedWorkers) {
      try {
        this.messageBus.send({
          recipientId: worker.parentId,
          senderId: worker.id,
          senderType: 'worker',
          type: 'worker_interrupted',
          payload: {
            status: 'interrupted',
            summary: `Worker was interrupted during node restart while working on: ${(worker.rolePrompt || '').slice(0, 200)}`,
            taskId: worker.currentTaskId,
            sessionId: worker.sessionId,
            auto: true,
          },
          priority: 0,
        });
        // Clear currentTaskId so this notification isn't sent again on subsequent restarts
        this.agentDb.updateAgent(worker.id, { currentTaskId: null });
        console.log(`[agents] Sent recovery report for interrupted worker ${worker.id} (${worker.role}) → ${worker.parentId}`);
      } catch (err) {
        console.warn(`[agents] Failed to send recovery report for ${worker.id}:`, err);
      }
    }
    if (interruptedWorkers.length > 0) {
      console.log(`[agents] Notified orchestrator(s) about ${interruptedWorkers.length} interrupted worker(s)`);
    }

    // Initialize GenomeBridge + Registry (reads compiled knowledge graph for agent context)
    const graphPath = join(process.cwd(), 'output', 'graph.json');
    this.genomeBridgeRegistry = new GenomeBridgeRegistry(graphPath);
    this.genomeBridge = this.genomeBridgeRegistry.getPandoBridge();
    if (this.genomeBridge.isLoaded()) {
      const stats = this.genomeBridge.getStats();
      console.log(`[agents] GenomeBridge loaded: ${stats.totalNodes} nodes, ${stats.testNodes} tests`);

      // Initialize ScenarioRunner (reads test scenarios from genome graph)
      let apiToken = '';
      try {
        const tokenPath = join(dataDir, 'api-token');
        if (existsSync(tokenPath)) {
          apiToken = readFileSync(tokenPath, 'utf-8').trim();
        }
      } catch { /* no token available */ }
      this.scenarioRunner = new ScenarioRunner({
        graphPath,
        apiBaseUrl: `http://127.0.0.1:${this.config.apiPort}`,
        apiToken,
      });
      console.log('[agents] ScenarioRunner initialized');
    } else {
      console.log('[agents] GenomeBridge: no graph.json found (genome context disabled)');
    }

    // Phase 105: Initialize TemplateRegistry (shares agents.db)
    this.templateRegistry = new TemplateRegistry(this.agentDb.getRawDb());
    const tmplCount = this.templateRegistry.listTemplates().length;
    console.log(`[agents] TemplateRegistry initialized (${tmplCount} templates)`);
    console.log('[agents] Context API ready: /v1/context/{project,lessons,team,identity,discover}');

    // Initialize WorkerPool
    this.workerPool = new WorkerPool(
      this.agentDb,
      this.aiBackendRegistry,
      this.messageBus,
      { dataDir, apiPort: this.config.apiPort, genomeBridge: this.genomeBridge, genomeBridgeRegistry: this.genomeBridgeRegistry ?? undefined, templateRegistry: this.templateRegistry },
    );
    console.log('[agents] WorkerPool initialized');

    // Initialize OrgManager
    this.orgManager = new OrgManager(this.agentDb, this.workerPool, this.messageBus);
    console.log('[agents] OrgManager initialized');

    // Find existing council orchestrator (survives restarts) or create new
    const existingCouncil = this.agentDb.listAgents({ role: 'council', type: 'orchestrator' })
      .find(a => a.status === 'pending' || a.status === 'active');
    if (existingCouncil) {
      this.councilOrchId = existingCouncil.id;
      this.agentDb.updateAgent(existingCouncil.id, { status: 'active' });
      console.log(`[agents] Council orchestrator rehydrated: ${this.councilOrchId}`);
    } else {
      this.councilOrchId = this.orgManager.createOrchestrator({
        role: 'council',
        level: 0,
        scope: 'public',
        tickIntervalMs: 60000,
        maxWorkers: 10,
        maxChildren: 5,
        persistent: true,
        nodeId: this.identity?.peerId || undefined,
        rolePrompt: `You are the council orchestrator for a Pando node.
Your job: monitor the network, handle user requests (routed from project orchestrators),
respond to health alerts, and manage the self-sustaining loop (build → QA → governance → upgrade).
In dev mode, you are the ONLY top-level orchestrator. Spawn workers directly for tasks.`,
      });
      console.log(`[agents] Council orchestrator created: ${this.councilOrchId}`);
    }

    // Phase 104: Use the unified factory to instantiate the council orchestrator
    this.councilOrchestrator = this.instantiateOrchestrator(this.councilOrchId);
    console.log('[agents] Council orchestrator tick loop started');

    // Phase 104: Rehydrate persistent project orchestrators from DB
    // Check both 'active' and 'pending' (pending = survived restart, needs reactivation)
    const activeOrchs = this.agentDb.listAgents({ type: 'orchestrator' })
      .filter(o => o.status === 'active' || o.status === 'pending');
    for (const orch of activeOrchs) {
      if (orch.id === this.councilOrchId) continue;
      if (!orch.projectId) continue;
      try {
        this.ensureProjectOrchestrator(orch.projectId).catch(err =>
          console.warn(`[agents] Rehydration failed for project ${orch.projectId}: ${err.message}`)
        );
      } catch { /* non-fatal */ }
    }
    console.log(`[agents] Checked ${activeOrchs.filter(o => o.id !== this.councilOrchId && o.projectId).length} project orchestrator(s) for rehydration`);

    // Wire to API server
    if (this.apiServer) {
      this.apiServer.setAgentSystem({
        db: this.agentDb,
        workerPool: this.workerPool,
        messageBus: this.messageBus,
        orgManager: this.orgManager,
      });
    }

    // Phase 30: Wire PaymentGate to Governance for proposal staking
    if (this.paymentGate && this.governance) {
      this.governance.setPaymentGate(this.paymentGate);
    }

    // Phase 30.2: Wire WorkerPool to Governance for reviewer agent spawning
    if (this.governance && this.workerPool && this.councilOrchId) {
      const pool = this.workerPool;
      const orchId = this.councilOrchId;
      this.governance.setAgentManager({
        async spawnAgent(opts: any) {
          return pool.spawn({
            role: opts.role || 'reviewer',
            orchestratorId: orchId,
            projectId: opts.projectId,
            rolePrompt: `${opts.description || ''}\n\n${opts.taskContext || ''}`,
          });
        },
      });
    }

    // Wire health monitor alerts to council orchestrator
    if (this.monitor && this.messageBus && this.councilOrchId) {
      const bus = this.messageBus;
      const councilId = this.councilOrchId;
      this.monitor.onAlert((alert) => {
        bus.send({
          recipientId: councilId,
          senderId: 'health-monitor',
          senderType: 'system',
          type: 'health_alert',
          payload: {
            severity: alert.severity || 'medium',
            message: alert.message || alert.type,
            type: alert.type,
          },
          priority: alert.severity === 'critical' ? 0 : 1,
        });
      });
      console.log('[agents] Health monitor wired to council orchestrator');
    }

    console.log('[agents] Agent system started.');
  }

  // ----------------------------------------------------------
  // Scheduler (Phase 1 — new task-driven orchestrator)
  // ----------------------------------------------------------

  /**
   * Start the Scheduler — creates workspaces, generates agent profiles, and
   * spawns agents to handle tasks from the task queue.
   * Ensures the agent system is started first.
   */
  startScheduler(): Scheduler {
    if (this.scheduler) {
      console.log('[scheduler] Scheduler already running.');
      return this.scheduler;
    }
    this.schedulerEnabled = true;

    // Ensure agent system is running (no-op if already started)
    this.startAgentSystem();

    const dataDir = this.config.dataDir || join(homedir(), '.pando');

    // Reuse the passive TaskQueue (created in _start()) or create one if needed
    const taskQueue = this.taskQueue || new TaskQueue(dataDir);
    if (!this.taskQueue) {
      this.taskQueue = taskQueue;
      if (this.network && this.identity) {
        taskQueue.setNetwork(this.network);
        taskQueue.setLocalPeerId(this.identity.peerId);
      }
    }

    // Phase 54: Reward node identity for task completion
    const rewardForTask = (workType: string, workProof: string) => {
      const recipient = this.getRewardRecipient();
      if (!recipient) return;
      if (this.emissionWitness) {
        this.emissionWitness.propose(recipient, workType, workProof).then((proposal) => {
          if (proposal) {
            console.log(`  [emission-witness] Proposed: ${workType} (${proposal.id.slice(0, 8)})`);
          }
        }).catch((err: any) => {
          console.error(`[emission-witness] Propose failed: ${err.message}`);
        });
      }
    };

    // Create Scheduler — pure executor (task queue + approval tracking)
    this.scheduler = new Scheduler(
      { apiPort: this.config.apiPort },
      taskQueue,
      null as any,  // profileCache — removed (agents manage own profiles)
      null as any,  // workspaceManager — removed (agents own their workspaces)
      undefined,    // claudePath
      dataDir,
      rewardForTask,
    );

    this.scheduler.setNodeCapabilities(this.detectedCapabilities);
    this.scheduler.setCapabilityRegistry(this.capabilityRegistry);
    this.scheduler.setFileRegistry(this.fileRegistry);

    // Wire resource components to scheduler
    if (this.resourceRouter) {
      this.scheduler.setResourceRouter(this.resourceRouter);
    }
    if (this.resourceMeter) {
      this.scheduler.setResourceMeter(this.resourceMeter);
    }

    this.scheduler.start();
    console.log('[scheduler] Scheduler started.');

    // Wire reputation callback
    if (this.reputation) {
      this.scheduler.setReputationCallback((type, detail, metadata) => {
        this.reputation!.recordEvent(type as any, detail, metadata);
      });
    }

    // Wire health monitor to scheduler
    if (this.monitor) {
      this.monitor.attachScheduler(this.scheduler);
    }

    // Task completion/failure → notify council orchestrator via MessageBus
    this.scheduler.on('task:completed', (data: any) => {
      if (this.messageBus && this.councilOrchId && data?.taskId) {
        const task = this.taskQueue?.getTask(data.taskId);
        this.messageBus.send({
          recipientId: this.councilOrchId,
          senderId: 'scheduler',
          senderType: 'system',
          type: 'task_result',
          payload: { taskId: data.taskId, success: true, title: task?.title || data.taskId },
          priority: 1,
        });
      }
    });
    this.scheduler.on('task:failed', (data: any) => {
      if (this.messageBus && this.councilOrchId && data?.taskId) {
        const task = this.taskQueue?.getTask(data.taskId);
        this.messageBus.send({
          recipientId: this.councilOrchId,
          senderId: 'scheduler',
          senderType: 'system',
          type: 'task_result',
          payload: { taskId: data.taskId, success: false, title: task?.title || data.taskId, error: data?.error },
          priority: 0,
        });
      }
    });

    // When a task is approved, send to council orchestrator
    this.scheduler.on('task:approved', (data: any) => {
      if (!this.messageBus || !this.councilOrchId || !this.taskQueue) return;
      const task = this.taskQueue.getTask(data.taskId);
      if (!task) return;

      // Capability check
      if (this.capabilityRegistry) {
        const resourceReqs = task.requiredResources;
        if (resourceReqs && resourceReqs.length > 0 && !this.capabilityRegistry.canExecuteLocally(resourceReqs)) {
          console.log(`[scheduler→agents] Skipping task ${data.taskId.slice(0, 8)}: missing resource capabilities`);
          return;
        }
      }
      const requiredCaps = (task.requiredCapabilities && task.requiredCapabilities.length > 0)
        ? task.requiredCapabilities
        : [NodeCapability.CLAUDE_CODE];
      const missingCaps = requiredCaps.filter((c: string) => !this.detectedCapabilities.includes(c));
      if (missingCaps.length > 0) {
        console.log(`[scheduler→agents] Skipping task ${data.taskId.slice(0, 8)}: missing capabilities`);
        return;
      }

      this.messageBus.send({
        recipientId: this.councilOrchId,
        senderId: 'scheduler',
        senderType: 'system',
        type: 'task_assignment',
        payload: {
          message: `[APPROVED TASK] Execute this task:\n\nTitle: ${task.title}\nDescription: ${task.description || 'No description'}\nPriority: ${task.priority}\nTask ID: ${data.taskId}`,
          taskId: data.taskId,
        },
        priority: task.priority === 'critical' ? 0 : 1,
      });
      console.log(`[scheduler→agents] Approved task ${data.taskId.slice(0, 8)} → council orchestrator`);
    });

    return this.scheduler;
  }

  /**
   * Stop the Agent System and release resources.
   */
  stopAgentSystem(): void {
    // Phase 104: Stop ALL live orchestrators (council + project)
    for (const [, orch] of this.liveOrchestrators) {
      orch.stop();
    }
    this.liveOrchestrators.clear();
    this.councilOrchestrator = null;
    if (this.workerPool) {
      this.workerPool.cleanup();
    }
    if (this.agentDb) {
      this.agentDb.close();
      this.agentDb = null;
    }
    this.messageBus = null;
    this.workerPool = null;
    this.orgManager = null;
    this.councilOrchId = null;
    this.agentSystemStarted = false;
  }

  /**
   * Stop the Scheduler and Agent System, release resources.
   */
  stopScheduler(): void {
    this.stopAgentSystem();
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
      console.log('[scheduler] Scheduler stopped.');
    }
  }

  getScheduler(): Scheduler | null {
    return this.scheduler;
  }

  getAgentDb(): AgentDatabase | null {
    return this.agentDb;
  }

  getMessageBus(): MessageBus | null {
    return this.messageBus;
  }

  getWorkerPool(): WorkerPool | null {
    return this.workerPool;
  }

  getOrgManager(): OrgManager | null {
    return this.orgManager;
  }

  getTemplateRegistry(): TemplateRegistry | null {
    return this.templateRegistry;
  }

  getCouncilOrchId(): string | null {
    return this.councilOrchId;
  }

  getThreadStore(): ThreadStore | null {
    return this.threadStore;
  }

  getEmissionWitness(): EmissionWitness | null {
    return this.emissionWitness;
  }

  getSecurityMonitor(): SecurityMonitor | null {
    return this.securityMonitor;
  }

  getResourceProofChallenger(): ResourceProofChallenger | null {
    return this.resourceProofChallenger;
  }

  getReputationGovernance(): ReputationWeightedGovernance | null {
    return this.reputationGovernance;
  }

  getContentSafetyReviewer(): ContentSafetyReviewer | null {
    return this.contentSafetyReviewer;
  }

  getGenomeBridge(): GenomeBridge | null {
    return this.genomeBridge;
  }

  getGenomeBridgeRegistry(): GenomeBridgeRegistry | null {
    return this.genomeBridgeRegistry;
  }

  // ----------------------------------------------------------
  // Health Monitor (Phase 9 — self-healing foundation)
  // ----------------------------------------------------------

  /**
   * Start the HealthMonitor — polls health metrics, generates alerts,
   * and stores persistent metrics at ~/.pando/monitor/.
   */
  startMonitor(): HealthMonitor {
    if (this.monitor) {
      console.log('[monitor] Monitor already running.');
      return this.monitor;
    }
    this.monitorEnabled = true;

    const dataDir = this.config.dataDir || join(homedir(), '.pando');
    this.monitor = new HealthMonitor(dataDir);
    this.monitor.setSchedulerProvider(() => this.scheduler);
    this.monitor.setNetworkProvider(() => this.network);

    // If scheduler is already running, attach events
    if (this.scheduler) {
      this.monitor.attachScheduler(this.scheduler);
    }

    this.monitor.start();

    return this.monitor;
  }

  /**
   * Stop the HealthMonitor.
   */
  stopMonitor(): void {
    if (this.monitor) {
      this.monitor.stop();
      this.monitor = null;
      console.log('[monitor] Monitor stopped.');
    }
  }

  getMonitor(): HealthMonitor | null {
    return this.monitor;
  }

  getGuardrails(): Guardrails | null {
    return this.guardrails;
  }

  getRequestReply(): RequestReplyManager | null {
    return this.requestReply;
  }

  /**
   * Phase 98: Route a compute task to a peer that has shareCompute=true and compute_cpu capability.
   * Used when the local node has no Claude Code. Returns the peer's output or null if no peer found.
   * Timeout: 5 minutes (collect-and-return — no streaming in V1).
   */
  async routeClaudeTaskP2P(prompt: string, context?: string): Promise<{ output: string; executedBy: string } | null> {
    if (!this.requestReply) return null;
    // Find peers that have opted in to sharing compute
    const candidates = this.capabilityRegistry.getAllProfiles().filter(p =>
      p.shareCompute === true &&
      p.capabilities.compute_cpu === true &&
      p.peerId !== this.identity?.peerId
    );
    if (candidates.length === 0) return null;
    // Pick first available candidate
    const peer = candidates[0];
    try {
      const result = await this.requestReply.request(
        peer.peerId,
        'claude_task',
        { prompt, context },
        5 * 60 * 1000  // 5 min timeout
      ) as any;
      if (result?.error || result?.payload?.error) return null;
      return { output: result.payload?.output || '', executedBy: result.payload?.executedBy || peer.peerId };
    } catch {
      return null;
    }
  }

  getReputationManager(): ReputationManager | null {
    return this.reputation;
  }

  getPipelineRunner(): PipelineRunner | null {
    return this.pipelineRunner;
  }

  isPipelineEnabled(): boolean {
    return this.pipelineEnabled;
  }

  isSchedulerEnabled(): boolean {
    return this.schedulerEnabled;
  }

  isMonitorEnabled(): boolean {
    return this.monitorEnabled;
  }

  /**
   * Enable the Phase 16 code pipeline. Call before startScheduler().
   * Instantiates CodePipeline, QaRunner, DeployManager, VersionProtocol,
   * and wires them into a PipelineRunner.
   */
  enablePipeline(repoDir?: string): void {
    if (this.pipelineRunner) {
      console.log('[pipeline] Pipeline already enabled.');
      return;
    }

    const resolvedRepoDir = repoDir || join(homedir(), 'Desktop', 'pando');
    const dataDir = this.config.dataDir || join(homedir(), '.pando');

    // Guardrails must be initialized (created in _start())
    const guardrails = this.guardrails || new Guardrails(dataDir);

    const codePipeline = new CodePipeline(resolvedRepoDir, guardrails);
    const qaRunner = new QaRunner({
      baseUrl: `http://127.0.0.1:${this.config.apiPort}`,
      screenshotDir: join(dataDir, 'qa-screenshots'),
    });
    const deployManager = new DeployManager(resolvedRepoDir);
    const versionProtocol = new VersionProtocol();

    this.pipelineRunner = new PipelineRunner(
      codePipeline,
      qaRunner,
      deployManager,
      versionProtocol,
      {
        repoDir: resolvedRepoDir,
        qaBaseUrl: `http://127.0.0.1:${this.config.apiPort}`,
        qaScreenshotDir: join(dataDir, 'qa-screenshots'),
      },
      guardrails,
    );

    // NOTE: Restart callback removed. Restart decision is now made by the caller
    // (api-server.ts POST /pipeline/run) based on whether node source files changed.

    this.pipelineEnabled = true;
    console.log(`[pipeline] Phase 16 pipeline enabled (repoDir: ${resolvedRepoDir})`);
  }

  isUpgradeInProgress(): boolean {
    return this.upgradeInProgress;
  }

  setUpgradeInProgress(val: boolean): void {
    this.upgradeInProgress = val;
  }

  isRestartPending(): boolean {
    return this.restartPending;
  }

  /**
   * Phase 34: Set a restart handler so callers (TUI, PM2) can intercept
   * restarts instead of the node calling process.exit(75) directly.
   */
  setRestartHandler(handler: (reason: string, changedFiles?: string[]) => void): void {
    this.restartHandler = handler;
  }

  /**
   * Phase 34: Get the current restart handler (null = default process.exit).
   */
  getRestartHandler(): ((reason: string, changedFiles?: string[]) => void) | null {
    return this.restartHandler;
  }

  /**
   * Phase 34: Register callback for P2P upgrade notifications from peers.
   */
  onUpgradeAvailable(cb: (info: { version: string; peerId: string }) => void): void {
    this.upgradeCallbacks.push(cb);
  }

  /**
   * Phase 34: Emit upgrade notification to all registered callbacks.
   */
  emitUpgradeAvailable(info: { version: string; peerId: string }): void {
    for (const cb of this.upgradeCallbacks) {
      try { cb(info); } catch {}
    }
  }

  getUpgradeProtocol(): UpgradeProtocol | null {
    return this.upgradeProtocol;
  }

  /**
   * Request a graceful restart — waits for active scheduler tasks to complete
   * (up to 5 minutes), then exits with code 75 so the launcher restarts the process.
   * If a restartHandler is set (Phase 34), calls it instead of process.exit.
   */
  requestGracefulRestart(reason?: string, changedFiles?: string[]): void {
    if (this.restartPending) {
      console.log('[upgrade] Restart already pending.');
      return;
    }
    this.restartPending = true;

    // Phase 81: Write upgrade info before restart so we can log it on next boot
    try {
      const dd = this.config.dataDir || join(homedir(), '.pando');
      writeFileSync(join(dd, 'last-upgrade.json'), JSON.stringify({
        reason: reason || 'upgrade', timestamp: Date.now(),
      }));
    } catch {}

    const doRestart = () => {
      if (this.restartHandler) {
        this.restartHandler(reason || 'upgrade', changedFiles);
      } else {
        process.exit(RESTART_EXIT_CODE);
      }
    };

    const scheduler = this.getScheduler();
    const activeTasks = scheduler ? scheduler.getStatus().activeTasks.length : 0;

    if (activeTasks === 0) {
      console.log('[upgrade] No active tasks. Restarting now...');
      doRestart();
      return;
    }

    console.log(`[upgrade] ${activeTasks} active task(s). Waiting for completion (max 5 min)...`);
    const startTime = Date.now();
    const MAX_WAIT = 5 * 60 * 1000; // 5 minutes

    const poll = () => {
      const remaining = scheduler ? scheduler.getStatus().activeTasks.length : 0;
      if (remaining === 0) {
        console.log('[upgrade] All tasks completed. Restarting...');
        doRestart();
        return;
      }
      if (Date.now() - startTime > MAX_WAIT) {
        console.log(`[upgrade] Timeout — ${remaining} task(s) still active. Force restarting...`);
        doRestart();
        return;
      }
      setTimeout(poll, 5000);
    };
    setTimeout(poll, 5000);
  }

  /**
   * Get the active TaskQueue — from scheduler or passive node queue.
   * Every running node has a TaskQueue for API + P2P sync.
   */
  getActiveTaskQueue(): TaskQueue | null {
    if (this.scheduler) {
      return this.scheduler.getTaskQueue();
    }
    return this.taskQueue;
  }

  getGovernance(): GovernanceSync | null {
    return this.governance;
  }

  getFileRegistry(): FileRegistry {
    return this.fileRegistry;
  }

  /**
   * Get a remote task emitter for SSE streaming of cross-node timeline events.
   * Returns null if no remote timeline events have been received for this task.
   */
  getRemoteTaskEmitter(taskId: string): EventEmitter | null {
    return this.remoteTaskEmitters.get(taskId) || null;
  }

  /**
   * Get or create a remote task emitter (for SSE subscription before events arrive).
   */
  getOrCreateRemoteTaskEmitter(taskId: string): EventEmitter {
    let emitter = this.remoteTaskEmitters.get(taskId);
    if (!emitter) {
      emitter = new EventEmitter();
      this.remoteTaskEmitters.set(taskId, emitter);
      // Auto-cleanup after 30 minutes
      setTimeout(() => {
        this.remoteTaskEmitters.delete(taskId);
        emitter!.removeAllListeners();
      }, 30 * 60 * 1000);
    }
    return emitter;
  }

  // Phase 11: Content Layer getters

  getNetworkState(): NetworkState | null {
    return this.networkState;
  }

  getCouncilOrchestrator(): Orchestrator | null {
    return this.councilOrchestrator;
  }

  getAIBackendRegistry(): AIBackendRegistry | null {
    return this.aiBackendRegistry;
  }

  getGenomeAgent(): GenomeAgent | null {
    return this.genomeAgent;
  }

  getContentRegistry(): ContentRegistry | null {
    return this.contentRegistry;
  }

  getContentPublisher(): ContentPublisher | null {
    return this.contentPublisher;
  }

  getContentMaintenance(): ContentMaintenance | null {
    return this.contentMaintenance;
  }

  // Phase 17.6 / 18.6 / 18.7 getters

  getRegressionSuite(): RegressionSuite | null {
    return this.regressionSuite;
  }

  getScenarioRunner(): ScenarioRunner | null {
    return this.scenarioRunner;
  }

  getPaymentGate(): PaymentGate | null {
    return this.paymentGate;
  }

  getUserAccountStore(): UserAccountStore | null {
    return this.userAccountStore;
  }

  getProjectStore(): ProjectStore | null {
    return this.projectStore;
  }

  /** Phase 63: Get the P2P ProjectRegistry instance */
  getProjectRegistry(): ProjectRegistry | null {
    return this.projectRegistry;
  }

  getRevenueEngine(): RevenueEngine | null {
    return this.revenueEngine;
  }

  getContributionTracker(): ContributionTracker | null {
    return this.contributionTracker;
  }

  getHostingService(): HostingService | null {
    return this.hostingService;
  }

  /** Phase 64: Get the CloudInstanceManager */
  getCloudInstanceManager(): CloudInstanceManager | null {
    return this.cloudInstanceManager;
  }

  /** Get known agent peers discovered via AGENT_HELLO. */
  getKnownAgents(): import('@pando/shared').AgentHello[] {
    return this.governance?.getKnownAgents() || [];
  }

  /** Get known peer capabilities discovered via AGENT_CAPABILITIES. */
  getPeerCapabilities(): import('@pando/shared').AgentCapabilities[] {
    return this.governance?.getPeerCapabilities() || [];
  }

  /**
   * Zero out private key in memory and clear identity reference.
   */
  async stop(): Promise<void> {
    if (this.networkState) {
      this.networkState.stop();
      this.networkState = null;
    }
    // Phase 104: Stop ALL live orchestrators (council + project)
    for (const [, orch] of this.liveOrchestrators) {
      orch.stop();
    }
    this.liveOrchestrators.clear();
    this.councilOrchestrator = null;
    this.stopMonitor();
    this.stopScheduler();
    if (this.upgradeProtocol) {
      this.upgradeProtocol.stop();
      this.upgradeProtocol = null;
    }
    if (this.securityMonitor) {
      this.securityMonitor.stop();
      this.securityMonitor = null;
    }
    if (this.emissionWitness) {
      this.emissionWitness.stop();
      this.emissionWitness = null;
    }
    if (this.uptimeTimer) {
      clearInterval(this.uptimeTimer);
      this.uptimeTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.capabilityBroadcastTimer) {
      clearInterval(this.capabilityBroadcastTimer);
      this.capabilityBroadcastTimer = null;
    }
    if (this.governance) {
      this.governance.stopArchiveInterval();
      this.governance = null;
    }
    // Stop content layer
    if (this.contentMaintenance) {
      this.contentMaintenance.stop();
      this.contentMaintenance = null;
    }
    this.contentPublisher = null;
    this.contentRegistry = null;

    // v2.5: Close local environment SQLite DB
    if (this.localEnv) {
      this.localEnv.close();
      this.localEnv = null;
    }

    // Stop resource network components
    this.resourceHealthChecker?.stop();
    this.resourceHealthChecker = null;
    this.resourceRegistry?.stop();
    this.resourceRegistry = null;
    if (this.resourceMeter) {
      this.resourceMeter.stopMeteringLoop();
      this.resourceMeter = null;
    }
    this.resourceRouter = null;
    this.resourceMarketplace = null;

    // Identity system cleanup
    if (this.userAccountStore) {
      this.userAccountStore.close();
      this.userAccountStore = null;
    }
    // Phase 31.1: ProjectStore uses ledger DB, no separate close needed
    this.projectStore = null;
    // Phase 63: ProjectRegistry cleanup
    this.projectRegistry?.stop();
    this.projectRegistry = null;
    // Phase 31.4: RevenueEngine uses ledger DB, no separate close needed
    this.revenueEngine = null;
    // Phase 31.9: ContributionTracker uses ledger DB, no separate close needed
    this.contributionTracker = null;
    if (this.paymentGate) {
      this.paymentGate.cleanup();
      this.paymentGate = null;
    }
    this.regressionSuite = null;

    this.taskQueue = null;
    this.requestReply = null;
    this.reputation = null;
    this.genomeAgent = null;
    // Agent system cleanup handled by stopAgentSystem() via stopScheduler()
    if (this.apiServer) {
      await this.apiServer.stop();
    }
    if (this.network) {
      await this.network.stop();
    }
    if (this.ledger) {
      const stats = this.ledger.getNetworkStats();
      console.log(`Ledger: ${stats.totalSupply} Lux minted, ${stats.totalRelayFees} Lux relay fees, ${stats.totalAccounts} accounts`);
      if (this.identity) {
        const balance = this.ledger.accounts.getBalance(this.identity.peerId);
        console.log(`Balance: ${balance} Lux`);
      }
      this.ledger.close();
    }
    console.log('Node stopped.');
  }
}

export { PandoNetwork } from './kernel/network.js';
export { ApiServer } from './api/api-server.js';
export { LedgerSync } from './kernel/sync.js';
export { GovernanceSync } from './kernel/governance.js';
export { FileRegistry } from './platform/file-registry.js';
export { getDefaultConfig } from './config.js';
// New agent system exports
export { AgentDatabase } from './platform/agent-database.js';
export { MessageBus } from './core/message-bus.js';
export { WorkerPool } from './core/worker-pool.js';
export { OrgManager } from './platform/org-manager.js';
export { Orchestrator } from './platform/orchestrator.js';
export { TemplateRegistry } from './platform/template-registry.js';
export { GenomeBridge } from './platform/genome-bridge.js';
export { ScenarioRunner } from './platform/scenario-runner.js';
export { registerAgentRoutes } from './platform/agent-tools.js';
export { Scheduler } from './platform/scheduler.js';
export type { SchedulerConfig, SchedulerStatus, ActiveTask, TaskLifecycle } from './platform/scheduler.js';
export { TaskQueue } from './platform/task-queue.js';
export type { Task, TaskStatus, TaskPriority, TaskResult, TaskRoleMetadata } from './platform/task-queue.js';
export { HealthMonitor } from './kernel/monitor.js';
export { Guardrails } from './kernel/guardrails.js';
export { RequestReplyManager } from './core/request-reply.js';
export type { RequestReplyStats } from './core/request-reply.js';
export { ReputationManager } from './kernel/reputation.js';
export type { ReputationRecord, ReputationEvent } from './kernel/reputation.js';
export { QaRunner } from './platform/qa-runner.js';
export { DeployManager } from './core/deploy-manager.js';
export type { DeployStatus, CommitResult, BuildResult, BackupInfo } from './core/deploy-manager.js';
export { VersionProtocol } from './core/version-protocol.js';
export { PipelineRunner } from './platform/pipeline-runner.js';
export type { PipelineRunnerConfig, PipelineStageResult, PipelineRunResult, PipelineStatus } from './platform/pipeline-runner.js';
export { EmissionWitness, TOPIC_EMISSIONS } from './kernel/emission-witness.js';
export type { EmissionProposal, WitnessAttestation, EmissionStats } from './kernel/emission-witness.js';
export { SecurityMonitor } from './kernel/security-monitor.js';
export type { SecurityAlert, SecurityAlertType, SecurityAlertSeverity, QuarantineEntry, SecurityStats } from './kernel/security-monitor.js';
export { ContentRegistry, TOPIC_CONTENT } from './platform/content-registry.js';
export { ContentPublisher } from './platform/content-publish.js';
export type { PublishOptions, ExtractedContent } from './platform/content-publish.js';
export { ContentMaintenance } from './platform/content-maintenance.js';
export type { MaintenanceConfig, MaintenanceCheck, MaintenanceIssue } from './platform/content-maintenance.js';
export { UpgradeProtocol } from './core/upgrade-protocol.js';
export type { UpgradeProtocolDeps } from './core/upgrade-protocol.js';
export { ResourceRouter } from './platform/resource-router.js';
export { ResourceMeter } from './platform/resource-meter.js';
export { ResourceMarketplace } from './platform/resource-marketplace.js';
export { ResourceRegistry } from './platform/resource-registry.js';
export { RegressionSuite } from './platform/regression-suite.js';
export { PaymentGate } from './core/payment-gate.js';
export { UserAccountStore } from './platform/user-accounts.js';
export { ProjectStore } from './platform/project-store.js';
export { ProjectRegistry, TOPIC_PROJECTS } from './platform/project-registry.js';
export type { CreateProjectOpts, ListProjectsOpts, ProjectStats } from './platform/project-store.js';
export { GenomeAgent } from './platform/genome-agent.js';
export type { GenomeAgentConfig, ScopedGenomeContext, DriftIssue, CommitInfo, ChangedFile, ComponentMatch, GenomeRegistry } from './platform/genome-agent.js';
// Phase 50: Network State exports
export { NetworkState } from './kernel/network-state.js';
export type { NetworkStateSnapshot } from './kernel/network-state.js';
// Council replaced by Orchestrator (exported above)
// Phase 42: StorageBackend exports
export type { StorageBackend } from './core/storage-backend.js';
export { MongoStorageBackend } from './core/mongo-backend.js';
