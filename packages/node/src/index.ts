// @know
// entity PandoNode {
//   type: module
//   blueprint: NODE_CORE
//   status: active
//   auto-upgrade-verified: 2026-03-08 (EC2 auto + Windows supervisor, selfRestart removed)
//   description: "Main PandoNode class that wires together all subsystems (kernel, core, platform layers), manages startup/shutdown lifecycle, and exposes getters for every subsystem."
//   depends_on: [PandoNetwork, PandoLedger, ApiServer, LedgerSync, GovernanceSync, Scheduler, HealthMonitor, Guardrails, EmissionWitness, SecurityMonitor, CapabilityRegistry, ResourceRegistry, StorageBackend, EngineAdapter]
//   @gotcha("PandoNode is a GOD OBJECT with 50+ private fields — each subsystem is nullable and initialized conditionally during start(). Always null-check before use.")
//   @gotcha("detectClaudeCode() (from capability-detector.ts) detects Claude Code binary + auth — can delay startup on slow systems.")
//   @gotcha("Daily emission cap (500 Lux) is tracked in-memory (dailyEmissions) and reset by date string comparison — restarting the node resets the counter.")
//   @gotcha("Peer exchange runs at 50ms after each peer connect, plus 1s/3s/10s after boot and every 15s periodic. It shares addresses from getConnectedPeerAddresses() which includes peerStore announce addresses for NAT/VPC traversal.")
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
import { EngineAdapter } from './core/engine-adapter.js';
import { EmissionWitness, TOPIC_EMISSIONS } from './kernel/emission-witness.js';
import { SecurityMonitor } from './kernel/security-monitor.js';
import { ResourceProofChallenger } from './platform/resource-proof.js';
import { ReputationWeightedGovernance } from './platform/reputation-governance.js';
import { ContentSafetyReviewer } from './platform/content-safety.js';
import { ContentRegistry } from './platform/content-registry.js';
import { ContentPublisher } from './platform/content-publish.js';
import { ContentMaintenance } from './platform/content-maintenance.js';
import { PipelineRunner } from './platform/pipeline-runner.js';
import { CodePipeline } from './platform/code-pipeline.js';
import { QaRunner } from './platform/qa-runner.js';
import { DeployManager } from './core/deploy-manager.js';
import { VersionProtocol } from './core/version-protocol.js';
import { detectCapabilityProfile, type DetectionResult } from './platform/capability-detector.js';
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
import { UpgradeProtocol } from './core/upgrade-protocol.js';
import { RegressionSuite } from './platform/regression-suite.js';
import { PaymentGate } from './core/payment-gate.js';
import { UserAccountStore } from './platform/user-accounts.js';
import { ProjectStore } from './platform/project-store.js';
import { ProjectRegistry, TOPIC_PROJECTS } from './platform/project-registry.js';
import { RevenueEngine } from './platform/revenue-engine.js';
import { randomUUID } from 'node:crypto';
import { ContributionTracker } from './platform/contribution-tracker.js';
import { NetworkState } from './kernel/network-state.js';
import { ThreadStore } from './platform/thread-store.js';
import { CloudInstanceManager } from './core/cloud-instance-manager.js';
import { AppManager } from './core/app-manager.js';
import { GitOps } from './core/git-ops.js';
import type { StorageBackend } from './core/storage-backend.js';
import { LocalEnvironment } from './kernel/local-environment.js';
import { join, resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCb);
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';

/** Phase 68.2: Single constant for the node-level manager ID. */
const DEFAULT_MANAGER_ID = 'pando-node-mgr';

// detectClaudeCode is imported from platform/capability-detector.ts and re-exported
export { detectClaudeCode } from './platform/capability-detector.js';

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
  // Phase A: Direct HTTP client for peer-to-peer operations (replaces P2P request-reply for unicast)
  public httpPeerClient: import('./core/http-peer-client.js').HttpPeerClient | null = null;
  private reputation: ReputationManager | null = null;
  private engineAdapter: EngineAdapter | null = null;
  private emissionWitness: EmissionWitness | null = null;
  private securityMonitor: SecurityMonitor | null = null;
  private resourceProofChallenger: ResourceProofChallenger | null = null;
  private reputationGovernance: ReputationWeightedGovernance | null = null;
  private contentSafetyReviewer: ContentSafetyReviewer | null = null;
  private pipelineRunner: PipelineRunner | null = null;
  private pipelineEnabled = false;
  private schedulerEnabled = false;
  private monitorEnabled = false;
  private taskQueue: TaskQueue | null = null; // passive task queue — always available for API + P2P sync
  private fileRegistry: FileRegistry;
  private config: NodeConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private uptimeEpochs: number = 0;
  private dailyEmissions: number = 0;
  private dailyEmissionResetDate: string = '';
  private dailyComputeJobs: number = 0;
  private dailyComputeResetDate: string = '';
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
  private appManager: AppManager | null = null;
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
  // Phase 27: Thread Store for gateway chat
  private threadStore: ThreadStore | null = null;
  // Phase 50: Network State Aggregator
  private networkState: NetworkState | null = null;
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
    (this as any)._initializing = true;
    const { initKernel } = await import('./init-kernel.js');
    const { initCore } = await import('./init-core.js');
    const { initPlatform } = await import('./init-platform.js');
    let initPhase = 'kernel';
    try {
      await initKernel(this);
      initPhase = 'core';
      await initCore(this);
      initPhase = 'platform';
      await initPlatform(this);
    } catch (err: any) {
      console.error(`[node] FATAL: Initialization failed during '${initPhase}' phase: ${err.message}`);
      // Attempt to stop any already-initialized subsystems to avoid zombie state
      try {
        if (initPhase === 'platform' || initPhase === 'core') {
          // kernel was initialized — try stopping network, ledger, etc.
          if (this.apiServer) { try { await (this.apiServer as any).stop?.(); } catch {} }
          if (this.scheduler) { try { this.scheduler.stop(); } catch {} }
          if (this.monitor) { try { this.monitor.stop(); } catch {} }
          if (this.network) { try { await (this.network as any).stop?.(); } catch {} }
        }
      } catch (cleanupErr: any) {
        console.error(`[node] Cleanup after init failure also failed: ${cleanupErr.message}`);
      }
      (this as any)._initializing = false;
      throw new Error(`Node initialization failed in '${initPhase}' phase: ${err.message}`);
    }
    (this as any)._initializing = false;

    // Initialize AppManager
    this.appManager = new AppManager(this);
    // Register pando-node as infrastructure app (tier 3)
    this.appManager.register({
      id: 'pando-node',
      name: 'Pando Node',
      repoUrl: 'https://github.com/pando-lux/pando.git',
      buildCmd: 'npm run build',
      startCmd: 'node packages/node/dist/cli.js',
      healthEndpoint: '/v1/health',
      processManager: process.platform === 'win32' ? 'supervisor' : 'systemd',
      tier: 3,
      governance: true,
      deployAction: 'restart-node',
    });
    // Register pando-code as infrastructure app (tier 3)
    this.appManager.register({
      id: 'pando-code',
      name: 'Pando Code',
      repoUrl: 'https://github.com/pando-lux/pando-code.git',
      buildCmd: 'npm run build',
      tier: 3,
      governance: true,
      deployAction: 'restart-node',
    });
    // pando-node is always live when this code runs — mark it so
    const commit = this.upgradeProtocol?.getUpgradeStatus()?.currentVersion || null;
    this.appManager.markLive('pando-node', { port: this.config.apiPort, commit: commit || undefined });
    // Start health monitoring for deployed apps (30s interval)
    this.appManager.startMonitoring();

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

    // Phase 69: Route to a compute node with credentialAccess via HTTP
    if (this.capabilityRegistry && this.httpPeerClient) {
      const allProfiles = this.capabilityRegistry.getAllProfiles();
      const credentialProfiles = allProfiles.filter(p =>
        p.credentialAccess === true && p.peerId !== this.identity?.peerId
      );

      for (const profile of credentialProfiles) {
        try {
          const response = await this.httpPeerClient.sendRequest(profile.peerId, '/v1/internal/ai-query', { query }, 30_000);
          if (response?.answer) {
            return {
              answer: response.answer,
              sources: response.sources || [],
              confidence: response.confidence || 'medium',
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
   * Restart is handled by exit(75) + supervisor/systemd respawn.
   * No manual process spawning needed — requestGracefulRestart() is the one path.
   */

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
    s['request-reply']    = this.requestReply    ? 'ok' : 'skipped';
    s['storage']          = this.storageBackend  ? 'ok' : 'degraded';
    s['resource-registry']= this.resourceRegistry ? 'ok' : 'skipped';
    s['upgrade-protocol'] = this.upgradeProtocol ? 'ok' : 'skipped';

    // Platform (Layer 2): optional services
    s['api-server']   = this.apiServer     ? 'ok' : 'failed';
    s['scheduler']    = this.schedulerEnabled ? 'ok' : 'skipped';
    s['monitor']      = this.monitorEnabled  ? 'ok' : 'skipped';
    s['agents']       = this.engineAdapter?.available ? 'ok' : 'skipped';
    s['thread-store'] = this.threadStore   ? 'ok' : 'degraded';
    s['content']      = this.contentRegistry ? 'ok' : 'skipped';
    s['local-env']    = this.localEnv      ? 'ok' : 'degraded';

    // Kernel health: any critical kernel step failed → failed
    const kernelFailed = ['ledger', 'network', 'sync', 'governance'].some(k => s[k] === 'failed');
    this.nodeHealth.kernel = kernelFailed ? 'failed' : 'healthy';

    // Core health: storage degraded → degraded
    if (s['storage'] === 'degraded') {
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

  /** Get the team registry (if initialized). */
  getTeamRegistry(): any {
    return (this as any)._teamRegistry ?? null;
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

  getAppManager(): AppManager | null {
    return this.appManager;
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
        const plainUrl = `https://github.com/${project.githubRepo}.git`;
        let cloneUrl = plainUrl;
        // Use contributed credential via ResourceRegistry
        if (this.resourceRegistry?.resolveGitCredential) {
          const authenticatedUrl = await this.resourceRegistry.resolveGitCredential(plainUrl);
          if (authenticatedUrl) cloneUrl = authenticatedUrl;
        }
        new GitOps(wsDir).exec(['clone', cloneUrl, '.'], { timeout: 60000 });
        console.log(`[project-workspace] Cloned ${project.githubRepo} into ${wsDir}`);
      } catch (err: any) {
        console.warn(`[project-workspace] Clone failed (using empty workspace): ${err.message?.slice(0, 100)}`);
      }
    }

    // Ensure git is initialized
    if (!existsSync(join(wsDir, '.git'))) {
      try {
        new GitOps(wsDir).init();
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

    // Team-state.json import removed — brain state now managed by @pando-code/core EngineAdapter.

    // Update project record with workspace path
    await this.projectStore.updateProject(projectId, { workspaceDir: wsDir });
    console.log(`[project-workspace] Workspace ready: ${wsDir}`);
    return wsDir;
  }

  /**
   * Get a GitHub PAT from contributed resources.
   * Uses ResourceRegistry.resolveGitCredential() for credential resolution,
   * falling back to direct getCredential() if needed.
   */
  private async getGitHubPat(): Promise<string | null> {
    if (!this.resourceRegistry) return null;
    try {
      const codeResources = this.resourceRegistry.findResources('code_repository' as any);
      if (codeResources.length === 0) return null;
      const resource = codeResources[0];
      return await this.resourceRegistry.getCredential(resource.resourceId);
    } catch { return null; }
  }

  // exportTeamState removed — brain state now managed by @pando-code/core.

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
        // Git add, check, commit (exclude CLAUDE.md — it's a worker context file, not project code)
        const commitGit = new GitOps(wsDir);
        commitGit.exec(['add', '-A', '--', ':(exclude)CLAUDE.md']);
        if (!commitGit.hasUncommittedChanges()) {
          console.log(`[project-orch] Nothing to commit in project ${projectId}`);
          return false;
        }
        commitGit.commit(message);
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

        return true;
      } catch (err: any) {
        console.error(`[project-orch] Commit failed: ${err.message?.slice(0, 200)}`);
        return false;
      }
    };
  }

  // Phase 105: makeProjectDeployCallback removed — deployment is now agent-driven.
  // The devops agent calls POST /v1/projects/:id/deploy directly via HTTP.

  // instantiateOrchestrator removed — orchestrators replaced by EngineAdapter.

  // ensureProjectOrchestrator removed — project routing handled by EngineAdapter.

  // ----------------------------------------------------------
  // Engine System — EngineAdapter connects to @pando-code/core brain
  // ----------------------------------------------------------

  /**
   * Start the EngineAdapter — connects pando-node to @pando-code/core.
   * Connects pando-node to @pando-code/core for AI processing.
   */
  async startEngine(): Promise<void> {
    if (this.engineAdapter?.available) return;

    this.engineAdapter = new EngineAdapter();

    let token: string | undefined;
    try {
      const tokenPath = join(this.config.dataDir, 'api-token');
      if (existsSync(tokenPath)) token = readFileSync(tokenPath, 'utf-8').trim();
    } catch { /* no token */ }

    try {
      await this.engineAdapter.start({
        apiPort: this.config.apiPort,
        apiToken: token,
        nodeId: this.identity?.peerId,
        dataDir: this.config.dataDir,
        resourceRegistry: this.resourceRegistry,
        projectResolver: async (projectId: string) => {
          const ps = this.getProjectStore();
          if (!ps) return null;
          const project = await ps.getProjectAsync(projectId);
          if (!project) return null;
          return { repoUrl: project.repoUrl || project.githubRepo || undefined, name: project.name };
        },
      });
      console.log('[engine] EngineAdapter started — PandoCode brain connected.');
    } catch (err: any) {
      console.warn('[engine] EngineAdapter failed to start:', err.message);
      this.engineAdapter = null;
    }

    // Wire PaymentGate to Governance for proposal staking
    if (this.paymentGate && this.governance) {
      this.governance.setPaymentGate(this.paymentGate);
    }

    // Wire EngineAdapter to Governance for AI review (Layer 5)
    if (this.engineAdapter?.available && this.governance) {
      this.governance.setEngineAdapter(this.engineAdapter);
    }

    // Governance hardening: wire Ed25519 private key for proposal signing
    if (this.governance && this.identity?.privateKey) {
      this.governance.setIdentityPrivateKey(this.identity.privateKey);
    }
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

    // Ensure engine is running (no-op if already started)
    this.startEngine().catch(err => console.warn('[scheduler] Engine start failed:', err.message));

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

    // Task events are now handled by EngineAdapter — no MessageBus routing needed.
    // The scheduler still tracks task lifecycle; engine handles execution.

    return this.scheduler;
  }

  /**
   * Stop the EngineAdapter and release resources.
   */
  async stopEngine(): Promise<void> {
    await this.engineAdapter?.shutdown();
    this.engineAdapter = null;
  }

  /**
   * Stop the Scheduler and Engine, release resources.
   */
  stopScheduler(): void {
    this.stopEngine().catch(() => {});
    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
      console.log('[scheduler] Scheduler stopped.');
    }
  }

  getScheduler(): Scheduler | null {
    return this.scheduler;
  }

  getEngineAdapter(): EngineAdapter | null {
    return this.engineAdapter;
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
   * Route a chat/build request to a remote PandoCode peer via P2P chat_proxy.
   * Only routes to remote peers (self-routing is handled by the caller via findBestBuilder).
   * Returns immediately with queued status. Results come back via SSE/thread.
   */
  async routeChatProxyP2P(message: string, threadId?: string, tier?: string): Promise<{ status: string; projectId?: string; executedBy: string } | null> {
    if (!this.httpPeerClient) return null;
    const candidates = this.capabilityRegistry.getAllProfiles().filter(p =>
      p.shareCompute === true &&
      p.capabilities.compute_cpu === true &&
      p.peerId !== this.identity?.peerId
    );
    if (candidates.length === 0) return null;
    const peer = candidates[0];
    try {
      const result = await this.httpPeerClient.chatProxy(
        peer.peerId, message, threadId || '', tier
      ) as any;
      if (result?.error) return null;
      return {
        status: result?.status || 'queued',
        projectId: result?.projectId,
        executedBy: peer.peerId,
      };
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
   * Returns true while the node is still initializing (kernel/core/platform phases).
   * Used by /health endpoint to return 'initializing' instead of 'healthy'.
   */
  isInitializing(): boolean {
    return !!(this as any)._initializing;
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

  /**
   * #86: Clean up a remote task emitter when it has no remaining listeners.
   * Called from SSE stream cleanup to prevent memory leaks.
   */
  cleanupRemoteTaskEmitter(taskId: string): void {
    const emitter = this.remoteTaskEmitters.get(taskId);
    if (emitter && emitter.listenerCount('output') === 0) {
      this.remoteTaskEmitters.delete(taskId);
      emitter.removeAllListeners();
    }
  }

  // Phase 11: Content Layer getters

  getNetworkState(): NetworkState | null {
    return this.networkState;
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
    // #68: Add 30-second overall shutdown timeout to prevent hanging
    const SHUTDOWN_TIMEOUT_MS = 30_000;
    const shutdownPromise = this.performStop();
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('shutdown_timeout')), SHUTDOWN_TIMEOUT_MS);
    });
    try {
      await Promise.race([shutdownPromise, timeoutPromise]);
    } catch (err: any) {
      if (err?.message === 'shutdown_timeout') {
        console.error(`[shutdown] Timed out after ${SHUTDOWN_TIMEOUT_MS / 1000}s — force exiting.`);
        process.exit(1);
      }
      throw err;
    }
  }

  private async performStop(): Promise<void> {
    if (this.networkState) {
      this.networkState.stop();
      this.networkState = null;
    }
    // Stop TeamRegistry
    if ((this as any)._teamRegistry) {
      (this as any)._teamRegistry.stop();
      (this as any)._teamRegistry = null;
    }
    // Shutdown EngineAdapter
    await this.engineAdapter?.shutdown();
    this.engineAdapter = null;
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
    // #69: Clear guest reclaim timer created in init-platform
    if ((this as any)._guestReclaimTimer) {
      clearInterval((this as any)._guestReclaimTimer);
      (this as any)._guestReclaimTimer = null;
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

    // Stop AppManager
    this.appManager?.stopMonitoring();
    this.appManager?.close();
    this.appManager = null;

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
    // #66: Drain pending P2P requests before nulling RequestReply
    if (this.requestReply) {
      this.requestReply.drain();
      this.requestReply = null;
    }
    this.reputation = null;
    // Engine cleanup handled by stopEngine() via stopScheduler()
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
      // #67: Flush WAL before closing ledger to ensure all pending writes are persisted
      try {
        this.ledger.getDatabase().pragma('wal_checkpoint(TRUNCATE)');
      } catch (err: any) {
        console.warn(`[shutdown] WAL checkpoint failed: ${err.message}`);
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
// Engine adapter — the nervous system between pando-node (body) and pando-code (brain)
export { EngineAdapter } from './core/engine-adapter.js';
export type { AdapterConfig, ReviewResult } from './core/engine-adapter.js';
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
// Phase 50: Network State exports
export { NetworkState } from './kernel/network-state.js';
export type { NetworkStateSnapshot } from './kernel/network-state.js';
// Teams system (pando-infra) — Orchestrator exported above
// Phase 42: StorageBackend exports
export type { StorageBackend } from './core/storage-backend.js';
export { MongoStorageBackend } from './core/mongo-backend.js';
