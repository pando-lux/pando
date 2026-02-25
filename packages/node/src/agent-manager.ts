/**
 * agent-manager.ts -- Agent Lifecycle Manager (Phase 27+)
 *
 * Single entry point for agent lifecycle in the Pando network:
 *
 *   - Owns the BridgeQueue (creates it internally)
 *   - Listens for 'newItem' and 'managerIdle' events on the bridge
 *   - Routes events to the correct Agent
 *   - Manages agent lifecycle: spawn, resume, rotate, archive
 *   - Tracks the full agent registry (in-memory Map + disk persistence)
 *   - Creates the `pando-node-mgr` on startup (the node's own manager)
 *   - Provides the agent tree for the gateway API
 *
 * Bridge Watcher Pattern:
 *   Event-driven, no timers, no heartbeats. Two listeners:
 *     'newItem'     -> if manager not busy, process immediately
 *     'managerIdle' -> if queue not empty, process next
 *
 * Event Retry:
 *   Failed events are retried up to 3 times. After 3 failures, the event
 *   is escalated to the parent agent (or logged if top-level).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { Agent, type AgentRole, type AgentLimits, type AgentState } from './agent.js';
import { BridgeQueue, type BridgeItem, type BridgeItemType } from './bridge-queue.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Manager sendEvent idle timeout: no progress for 30 min = timeout. */
const MANAGER_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Manager sendEvent hard cap: 2 hours absolute maximum. */
const MANAGER_HARD_CAP_MS = 2 * 60 * 60 * 1000;

/** Stale processing detection: 2.5 hours without completion = stuck from crash. */
const STALE_PROCESSING_MS = 2.5 * 60 * 60 * 1000;

/** Maximum retries for a failed bridge item before escalation. */
const MAX_EVENT_RETRIES = 3;

/** Back-off delay (ms) before re-attempting to process when no manager found. */
const REQUEUE_BACKOFF_MS = 5000;

/** Default TTL (ms) before idle agents are archived: 30 days. */
const DEFAULT_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Cleanup sweep interval: every hour. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Maximum age (ms) for archived agents before deletion: 180 days. */
const ARCHIVE_EXPIRY_MS = 180 * 24 * 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentManagerConfig {
  /** This node's peer ID. */
  localPeerId: string;
  /** Base data dir (default: ~/.pando). */
  dataDir?: string;
  /** Optional GenomeAgent reference for scoped context injection. */
  genomeAgent?: any;
  /** API port (default: 4000). */
  apiPort?: number;
  /** API auth token. */
  apiToken?: string;
  /** Optional PaymentGate reference for cost gating. */
  paymentGate?: any;
}

export interface SpawnAgentConfig {
  /** Agent role (determines default template). */
  role: AgentRole;
  /** Template name override. Defaults to role. */
  template?: string;
  /** Parent agent ID. null = top-level. */
  parentId: string | null;
  /** Project this agent belongs to. */
  projectId: string;
  /** Human-readable description. */
  description: string;
  /** Optional initial task context for the agent's CLAUDE.md Layer 4. */
  taskContext?: string;
}

export interface AgentTreeNode {
  id: string;
  role: string;
  status: string;
  description: string;
  taskCount: number;
  totalCost: number;
  lastActive: number;
  children: AgentTreeNode[];
}

/** Lightweight index entry persisted to disk. */
interface AgentIndexEntry {
  id: string;
  role: AgentRole;
  projectId: string;
  parentId: string | null;
  status: string;
  createdAt: number;
}

// ── Project Registry Types ───────────────────────────────────────────────────

export type ProjectAccessLevel = 'owner' | 'collaborator' | 'qa_lead' | 'viewer';

export interface ProjectEntry {
  /** Project ID (matches projectId on agents). */
  id: string;
  /** Display name for the project. */
  name: string;
  /** Owner's peer/user ID. */
  ownerId: string;
  /** Collaborators: userId → access level. */
  collaborators: Record<string, ProjectAccessLevel>;
  /** Whether this is a public (network-funded) project requiring governance approval. */
  isPublic: boolean;
  /** Creation timestamp. */
  createdAt: number;
}

// ── AgentManager Class ───────────────────────────────────────────────────────

export class AgentManager {
  private readonly config: AgentManagerConfig;
  private readonly dataDir: string;
  private readonly agentsDir: string;
  private readonly indexFile: string;

  /** The BridgeQueue owned by this manager. All event routing goes through here. */
  private readonly bridge: BridgeQueue;

  /** In-memory agent registry: agentId -> Agent instance. */
  private readonly agents: Map<string, Agent> = new Map();

  /** Per-project hard limits. */
  private readonly projectLimits: Map<string, AgentLimits> = new Map();

  /** Track when processing started per agent to detect stale state. */
  private readonly processingStartTime: Map<string, number> = new Map();

  /** Whether the manager is running. */
  private running = false;

  /** Cleanup sweep timer handle. */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Phase 29: Watchdog timer for nudging idle agents with active standing directives. */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  /** Reference to the node's own manager agent. */
  private nodeManager: Agent | null = null;

  /** Optional SSE push callback for relaying output to gateway clients. */
  private ssePushCallback: ((eventType: string, data: any) => void) | null = null;

  /** Optional callback for relaying conversational output to users via chat. */
  private chatRelayCallback: ((message: string, projectId: string) => void) | null = null;

  /** Optional callback for persisting assistant messages to ThreadStore. */
  private threadMessageCallback: ((threadId: string, message: { role: string; content: string; timestamp: number; activityLog?: string[] }) => void) | null = null;

  /** Optional callback for notifying when a bridge item with a taskId completes (Bug H1/H2 fix). */
  private taskCompletionCallback: ((taskId: string, success: boolean, output: string) => void) | null = null;

  /** Project registry: projectId → ProjectEntry. */
  private readonly projects: Map<string, ProjectEntry> = new Map();

  /** Project registry persistence file. */
  private readonly projectsFile: string;

  /** Optional PaymentGate for cost-gating agent sessions. */
  private paymentGate: any = null;

  /** Optional ProjectStore for persistent project records (Phase 31.1). */
  private projectStore: any = null;


  /** Optional provider for running compute instance info (Phase 67: Tier 2 context injection). */
  private cloudInstanceProvider: (() => Array<Record<string, any>>) | null = null;

  /** Active user→agent direct connections: userId → agentId. */
  private readonly directConnections: Map<string, string> = new Map();

  /** Cached API token (loaded lazily from ~/.pando/api-token). */
  private cachedApiToken: string | null = null;

  constructor(config: AgentManagerConfig) {
    this.config = config;
    this.dataDir = config.dataDir || join(homedir(), '.pando');
    this.agentsDir = join(this.dataDir, 'agents');
    this.indexFile = join(this.agentsDir, 'index.json');
    this.projectsFile = join(this.agentsDir, 'projects.json');

    // Ensure the agents directory exists
    mkdirSync(this.agentsDir, { recursive: true });

    // Create the BridgeQueue (owned by AgentManager)
    this.bridge = new BridgeQueue();

    // Load existing agents from disk
    this.loadAgentsFromDisk();

    // Load project registry from disk
    this.loadProjects();

    this.paymentGate = config.paymentGate || null;
  }

  // ── Core Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Start the AgentManager: create pando-node-mgr, wire bridge listeners,
   * drain any items queued before listeners were attached.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // 1. Create the node's own manager agent (top-level, manages everything)
    if (!this.agents.has('pando-node-mgr')) {
      const nodeManager = new Agent({
        id: 'pando-node-mgr',
        role: 'manager',
        template: 'manager',
        parentId: null,
        projectId: 'pando-node',
        nodeId: this.config.localPeerId,
        description: 'Manages the Pando node: health, infrastructure, network, development',
        dataDir: this.dataDir,
        depth: 0,
        apiPort: this.config.apiPort ?? 4000,
      });
      this.agents.set('pando-node-mgr', nodeManager);
      this.nodeManager = nodeManager;
      this.persistRegistry();

      console.log('[agent-manager] Created pando-node-mgr');
    } else {
      this.nodeManager = this.agents.get('pando-node-mgr')!;
      console.log('[agent-manager] Restored pando-node-mgr from disk');
    }

    // 2. Wire Bridge Watcher: event-driven dispatch (no timers, no heartbeats)
    this.bridge.on('newItem', (managerId: string) => {
      if (!this.running) return;
      if (!this.bridge.isManagerBusy(managerId)) {
        this.processNextBridgeItem(managerId);
      }
    });

    this.bridge.on('managerIdle', (managerId: string) => {
      if (!this.running) return;
      if (!this.bridge.isEmpty(managerId)) {
        this.processNextBridgeItem(managerId);
      }
    });

    // 3. Drain any items enqueued before listeners were attached
    for (const agentId of this.agents.keys()) {
      if (!this.bridge.isEmpty(agentId)) {
        console.log(`[agent-manager] Draining ${this.bridge.length(agentId)} items queued during startup for ${agentId}`);
        this.processNextBridgeItem(agentId);
      }
    }

    // 4. Start hourly cleanup sweep
    this.cleanupTimer = setInterval(() => {
      this.cleanupSweep().catch(err => {
        console.error(`[agent-manager] Cleanup sweep error: ${err.message}`);
      });
    }, CLEANUP_INTERVAL_MS);

    // 5. Phase 29: Watchdog — nudge idle agents with active standing directives
    this.watchdogTimer = setInterval(() => {
      for (const [agentId, agent] of this.agents) {
        const directive = agent.getStandingDirective();
        if (!directive) continue;

        // Skip expired directives
        if (Date.now() - directive.createdAt > directive.maxDuration) {
          agent.clearStandingDirective();
          console.log(`[agent-manager] Directive expired for ${agentId}, clearing`);
          continue;
        }

        // Skip if budget exceeded
        if (agent.getTotalCost() >= directive.maxCost) {
          agent.clearStandingDirective();
          console.log(`[agent-manager] Directive budget exceeded for ${agentId}, clearing`);
          continue;
        }

        const state = agent.getState();
        const idleMinutes = (Date.now() - state.lastActive) / 60000;

        // If agent has been idle for 5+ minutes with an active directive, nudge it
        if (idleMinutes >= 5 && state.status !== 'archived' && state.status !== 'dead') {
          const watchdogManagerId = state.parentId || state.id;
          const queueLength = this.bridge.length(watchdogManagerId);

          // Only nudge if there's nothing in the queue already
          if (queueLength === 0) {
            console.log(`[agent-manager] Watchdog: nudging idle agent ${agentId} (idle ${Math.floor(idleMinutes)}min, directive active)`);
            this.bridge.enqueue(watchdogManagerId, {
              type: 'directive_nudge',
              source: 'watchdog',
              payload: {
                message: 'You have a standing directive that is not yet complete. Read your todo file and continue from where you left off.',
                directive: directive.instruction,
                currentProgress: directive.progress,
                idleMinutes: Math.floor(idleMinutes),
              },
              priority: 'low',
            });
          }
        }
      }
    }, 5 * 60 * 1000);  // Every 5 minutes

    console.log(`[agent-manager] Started (${this.agents.size} agents loaded)`);
  }

  /**
   * Stop the AgentManager: remove bridge listeners, cleanup.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    // Remove bridge listeners
    this.bridge.removeAllListeners('newItem');
    this.bridge.removeAllListeners('managerIdle');

    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Stop watchdog timer (Phase 29)
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    // Persist final state for all agents
    for (const agent of this.agents.values()) {
      agent.persistState();
    }
    this.persistRegistry();

    this.nodeManager = null;
    console.log('[agent-manager] Stopped');
  }

  /**
   * Gracefully stop all spawned agent child processes.
   *
   * 1. Collect all PIDs from active agents
   * 2. Send SIGTERM to each
   * 3. Wait up to `timeoutMs` for all to exit
   * 4. SIGKILL any that remain
   *
   * Returns the number of processes that were killed.
   */
  async stopAll(timeoutMs: number = 10_000): Promise<number> {
    const pids: number[] = [];
    for (const agent of this.agents.values()) {
      const pid = agent.getChildPid();
      if (pid) pids.push(pid);
    }

    if (pids.length === 0) {
      console.log('[agent-manager] stopAll: no active child processes');
      return 0;
    }

    console.log(`[agent-manager] stopAll: sending SIGTERM to ${pids.length} child process(es): [${pids.join(', ')}]`);

    // Send SIGTERM to all
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process may have already exited
      }
    }

    // Wait for processes to exit, polling every 500ms
    const startTime = Date.now();
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0); // signal 0 = check if process exists
        return true;
      } catch {
        return false;
      }
    };

    while (Date.now() - startTime < timeoutMs) {
      const stillAlive = pids.filter(isAlive);
      if (stillAlive.length === 0) {
        console.log(`[agent-manager] stopAll: all ${pids.length} processes exited gracefully`);
        return pids.length;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // SIGKILL any remaining
    const remaining = pids.filter(isAlive);
    if (remaining.length > 0) {
      console.log(`[agent-manager] stopAll: SIGKILL ${remaining.length} remaining process(es): [${remaining.join(', ')}]`);
      for (const pid of remaining) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already exited
        }
      }
    }

    return pids.length;
  }

  // ── Agent CRUD ─────────────────────────────────────────────────────────────

  /**
   * Spawn a new Agent. Creates the Agent instance, persists it, registers it
   * with its parent, and optionally sends an initial task.
   *
   * Enforces hard limits: budget, depth, agent count per project.
   *
   * @returns The new agent's ID, or null if spawn was denied.
   */
  async spawnAgent(config: SpawnAgentConfig): Promise<string | null> {
    // Resolve parent depth
    let parentDepth = -1; // So child starts at depth 0 if no parent
    if (config.parentId) {
      const parent = this.agents.get(config.parentId);
      if (parent) {
        parentDepth = parent.getDepth();
      }
    }

    // Count agents in this project
    const projectAgentCount = this.countAgentsInProject(config.projectId);

    // Get or create project limits
    const limits = this.getProjectLimits(config.projectId);

    // Enforce hard limits
    const denial = Agent.checkSpawnLimits(parentDepth, projectAgentCount, limits);
    if (denial) {
      console.warn(`[agent-manager] Spawn denied: ${denial}`);
      return null;
    }

    // Create the agent
    const agent = new Agent({
      role: config.role,
      template: config.template,
      parentId: config.parentId,
      projectId: config.projectId,
      nodeId: this.config.localPeerId,
      description: config.description,
      dataDir: this.dataDir,
      depth: parentDepth + 1,
      apiPort: this.config.apiPort ?? 4000,
    });

    // Register in the in-memory map
    this.agents.set(agent.id, agent);

    // Register as child of parent
    if (config.parentId) {
      const parent = this.agents.get(config.parentId);
      if (parent) {
        parent.addChild(agent.id);
      }
    }

    // Persist
    agent.persistState();
    this.persistRegistry();

    console.log(
      `[agent-manager] Spawned ${agent.role} agent: ${agent.id} ` +
      `(parent: ${config.parentId || 'none'}, project: ${config.projectId}, ` +
      `depth: ${parentDepth + 1})`,
    );

    // Phase 66: Hydrate workspace from GitHub (clone source code for existing projects)
    if (config.projectId && this.projectStore) {
      try {
        const proj = this.projectStore.getProject(config.projectId);
        if (proj?.repoUrl) {
          const ws = agent.getWorkspaceDir();
          // Only hydrate empty workspaces (no existing files)
          const wsFiles = existsSync(ws) ? readdirSync(ws) : [];
          if (wsFiles.length === 0) {
            if (!existsSync(ws)) mkdirSync(ws, { recursive: true });
            try {
              execSync(`git clone ${proj.repoUrl} .`, { cwd: ws, stdio: 'pipe', timeout: 60000 });
              console.log(`[agent-manager] Hydrated workspace from GitHub: ${proj.repoUrl}`);
            } catch (cloneErr: any) {
              console.log(`[agent-manager] GitHub clone failed (non-blocking): ${cloneErr.message}`);
            }
          }
        }
      } catch {}
    }

    // Optionally start session with initial task
    if (config.taskContext) {
      const result = await agent.startSession(config.taskContext);
      if (!result.success) {
        console.warn(`[agent-manager] Initial session for ${agent.id} failed: ${result.output.slice(0, 200)}`);
      }
    }

    return agent.id;
  }

  /**
   * Resume an existing agent with a new prompt. If the agent has no active
   * session, starts one. Otherwise, sends the prompt as a new event.
   */
  async resumeAgent(agentId: string, prompt: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn(`[agent-manager] Cannot resume: agent ${agentId} not found`);
      return;
    }

    if (agent.getStatus() === 'archived' || agent.getStatus() === 'dead') {
      console.warn(`[agent-manager] Cannot resume: agent ${agentId} is ${agent.getStatus()}`);
      return;
    }

    // If no session exists, start a new one with the prompt as initial task
    if (!agent.getSessionId()) {
      await agent.startSession(prompt);
    } else {
      await agent.sendEvent(prompt);
    }

    agent.setStatus('active');
  }

  /**
   * Rotate an agent's session: summarize knowledge, start fresh session
   * with the knowledge transfer document as context.
   */
  async rotateAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn(`[agent-manager] Cannot rotate: agent ${agentId} not found`);
      return;
    }

    await agent.rotateSession();
    console.log(`[agent-manager] Rotated agent: ${agentId}`);
  }

  /**
   * Get an Agent instance by ID.
   */
  getAgent(agentId: string): Agent | null {
    return this.agents.get(agentId) || null;
  }

  /**
   * List all agents, optionally filtered by project.
   * Returns an array of AgentState snapshots.
   */
  listAgents(projectId?: string): AgentState[] {
    const result: AgentState[] = [];
    for (const agent of this.agents.values()) {
      const state = agent.getState();
      if (!projectId || state.projectId === projectId) {
        result.push(state);
      }
    }
    return result;
  }

  // ── Agent Tree ─────────────────────────────────────────────────────────────

  /**
   * Build a hierarchical agent tree for the gateway /agents/tree endpoint.
   * Returns an array of root-level AgentTreeNode objects (agents with no parent).
   *
   * @param projectId  Optional filter. If provided, only agents in this project
   *                   are included in the tree.
   */
  getAgentTree(projectId?: string): AgentTreeNode[] {
    // Collect all agent states, optionally filtered by project
    const states: AgentState[] = [];
    for (const agent of this.agents.values()) {
      const state = agent.getState();
      if (!projectId || state.projectId === projectId) {
        states.push(state);
      }
    }

    // Index by ID for fast lookup
    const stateMap = new Map<string, AgentState>();
    for (const s of states) {
      stateMap.set(s.id, s);
    }

    // Build tree nodes
    const nodeMap = new Map<string, AgentTreeNode>();
    for (const s of states) {
      nodeMap.set(s.id, {
        id: s.id,
        role: s.role,
        status: s.status,
        description: s.description,
        taskCount: s.taskCount,
        totalCost: s.totalCost,
        lastActive: s.lastActive,
        children: [],
      });
    }

    // Wire parent -> children
    const roots: AgentTreeNode[] = [];
    for (const s of states) {
      const node = nodeMap.get(s.id)!;
      if (s.parentId && nodeMap.has(s.parentId)) {
        nodeMap.get(s.parentId)!.children.push(node);
      } else {
        // No parent or parent not in the filtered set -> root node
        roots.push(node);
      }
    }

    return roots;
  }

  // ── Bridge ─────────────────────────────────────────────────────────────────

  /**
   * Return the BridgeQueue instance for external wiring (API server, subsystems).
   */
  getBridge(): BridgeQueue {
    return this.bridge;
  }

  /**
   * Convenience method to enqueue a user request to a specific agent.
   */
  enqueueUserRequest(managerId: string, message: string, senderId?: string): void {
    this.bridge.enqueue(managerId, {
      type: 'user_request',
      source: senderId || 'user',
      payload: { message },
      priority: 'normal',
      senderId,
    });
  }

  // ── SSE / Chat Relay Wiring ────────────────────────────────────────────────

  /**
   * Set a callback for pushing events to SSE clients (gateway real-time updates).
   */
  setSsePushCallback(callback: (eventType: string, data: any) => void): void {
    this.ssePushCallback = callback;
  }

  /**
   * Set a callback for relaying conversational output to users via the chat system.
   */
  setChatRelayCallback(callback: (message: string, projectId: string) => void): void {
    this.chatRelayCallback = callback;
  }

  /**
   * Set a callback for persisting assistant messages to ThreadStore.
   */
  setThreadMessageCallback(callback: (threadId: string, message: { role: string; content: string; timestamp: number }) => void): void {
    this.threadMessageCallback = callback;
  }

  /**
   * Set a callback for notifying when a bridge item with a taskId completes.
   * Used to update task status and scheduler counters (Bug H1/H2 fix).
   */
  setTaskCompletionCallback(callback: (taskId: string, success: boolean, output: string) => void): void {
    this.taskCompletionCallback = callback;
  }

  setPaymentGate(pg: any): void {
    this.paymentGate = pg;
  }

  /** Phase 31.1: Set the ProjectStore for persistent project records. */
  setProjectStore(ps: any): void {
    this.projectStore = ps;
  }

  /** Phase 31.1: Get the ProjectStore. */
  getProjectStore(): any {
    return this.projectStore;
  }

  /** Phase 87: Inject compute node info from P2P CapabilityRegistry so manager knows Tier 2 is available. */
  setComputeNodeProvider(provider: () => Array<{ peerId: string; publicAddress: string; storageBackend: string; credentialAccess: boolean }>): void {
    this.cloudInstanceProvider = provider;
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  /** Whether the manager is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Get the node's own manager agent. */
  getNodeManager(): Agent | null {
    return this.nodeManager;
  }

  /** Get the number of registered agents. */
  getAgentCount(): number {
    return this.agents.size;
  }

  /** Get all registered agent IDs. */
  getAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /** Find first active child agent with the given role. */
  getActiveChildByRole(parentId: string, role: string): Agent | null {
    const parent = this.agents.get(parentId);
    if (!parent) return null;
    const children = parent.getChildren();
    for (const childId of children) {
      const child = this.agents.get(childId);
      if (child) {
        const state = child.getState();
        const status = child.getStatus();
        if (state.role === role && status !== 'archived' && status !== 'dead') {
          return child;
        }
      }
    }
    return null;
  }

  /** Lazily load the API Bearer token from ~/.pando/api-token. */
  private getApiToken(): string {
    if (this.cachedApiToken !== null) return this.cachedApiToken;
    try {
      const tokenPath = join(this.dataDir, 'api-token');
      if (existsSync(tokenPath)) {
        this.cachedApiToken = readFileSync(tokenPath, 'utf-8').trim();
        return this.cachedApiToken;
      }
    } catch { /* ignore */ }
    this.cachedApiToken = '';
    return '';
  }

  // ── Internal: Bridge Item Processing ───────────────────────────────────────

  /**
   * Dequeue the next bridge item and route it to the correct agent.
   *
   * Flow:
   *   1. Check for stale processing (>10 min = stuck from crash)
   *   2. Dequeue one item from bridge
   *   3. Find agent by managerId (from registry)
   *   4. If not found and managerId starts with 'project-': create on demand
   *   5. If still not found: fall back to pando-node-mgr
   *   6. Mark busy, record start time
   *   7. Build prompt from bridge item
   *   8. Call agent.sendEvent() with 5-minute timeout
   *   9. On success: extract output, relay to user if applicable
   *  10. On timeout: retry up to 3 times, escalate after that
   *  11. Finally: mark not busy (triggers managerIdle)
   */
  private async processNextBridgeItem(managerId: string): Promise<void> {
    // Safety: detect stale processing state from a previous crash
    const startedAt = this.processingStartTime.get(managerId);
    if (
      this.bridge.isManagerBusy(managerId) &&
      startedAt &&
      Date.now() - startedAt > STALE_PROCESSING_MS
    ) {
      const staleMinutes = Math.round((Date.now() - startedAt) / 60000);
      console.warn(
        `[agent-manager] Stale processing detected for ${managerId} (${staleMinutes}min), resetting`,
      );
      this.bridge.setManagerBusy(managerId, false);
      this.processingStartTime.delete(managerId);

      // Try to restart the agent session so it accepts new events
      try {
        const agent = this.agents.get(managerId);
        if (agent) await agent.restartSession();
      } catch (err: any) {
        console.error(`[agent-manager] Failed to restart session for ${managerId}: ${err.message}`);
      }
    }

    // Dequeue next item
    const item = this.bridge.dequeue(managerId);
    if (!item) return;

    // Urgency:direct bypass — route directly to user's chat thread, skip agent processing
    if (item.payload?.urgency === 'direct' && (item.type === 'stuck' || item.type === 'user_question')) {
      const threadId = item.payload?.threadId as string | undefined;
      const urgentContent = `URGENT from ${item.source}: ${item.payload.message || item.payload.content || 'Agent needs help'}`;
      if (this.ssePushCallback && threadId) {
        this.ssePushCallback('chat_message', {
          role: 'assistant', agentId: item.source, threadId,
          content: urgentContent, timestamp: Date.now(),
        });
      }
      if (threadId && this.threadMessageCallback) {
        this.threadMessageCallback(threadId, {
          role: 'assistant', content: urgentContent, timestamp: Date.now(),
        });
      }
      console.log(`[agent-manager] Urgency:direct bypass — ${item.type} from ${item.source} routed to user`);
      return;
    }

    // Find the target agent
    let agent: Agent | undefined = this.agents.get(managerId);

    // If no in-memory agent exists for a project, create it on demand.
    // This handles node restarts where project agents aren't re-created at boot.
    if (!agent && managerId.startsWith('project-')) {
      const projectId = managerId.replace(/^project-/, '');
      const description = `Project: ${projectId}`;
      console.log(`[agent-manager] Creating on-demand project agent: ${managerId}`);

      // Create directly with the correct ID (the managerId IS the agent ID for projects)
      const projectAgent = new Agent({
        id: managerId,
        role: 'manager',
        template: 'manager',
        parentId: null,
        projectId,
        nodeId: this.config.localPeerId,
        description,
        dataDir: this.dataDir,
        depth: 0,
        apiPort: this.config.apiPort ?? 4000,
      });

      this.agents.set(managerId, projectAgent);
      projectAgent.persistState();
      this.persistRegistry();
      agent = projectAgent;

      // Wait briefly for initialization to settle
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Fall back to node manager for unknown agents
    if (!agent) {
      agent = this.nodeManager || undefined;
    }

    if (!agent) {
      // No agent at all (shouldn't happen after start()). Re-queue with back-off.
      console.warn(`[agent-manager] No agent found for ${managerId}, re-queuing: ${item.type}`);
      this.bridge.enqueue(managerId, {
        type: item.type as BridgeItemType,
        source: item.source,
        payload: item.payload,
        priority: item.priority,
        senderId: item.senderId,
        retryCount: item.retryCount,
        nodeId: item.nodeId,
      });
      setTimeout(() => {
        if (this.running && !this.bridge.isEmpty(managerId) && !this.bridge.isManagerBusy(managerId)) {
          this.processNextBridgeItem(managerId);
        }
      }, REQUEUE_BACKOFF_MS);
      return;
    }

    // Mark busy and record start time
    this.bridge.setManagerBusy(managerId, true);
    this.processingStartTime.set(managerId, Date.now());

    // Cost gate: check if this event type requires payment
    // Skip payment gate for local node operator (anonymous = local user on own node)
    if (this.paymentGate && item.type === 'user_request' && item.senderId && item.senderId !== 'anonymous') {
      const senderId = item.senderId;
      const estimate = this.paymentGate.estimateCost('moderate', 'agent');
      if (estimate.luxAmount > 0 && !this.paymentGate.canAfford(senderId, estimate.luxAmount)) {
        console.warn(`[agent-manager] Payment gate: ${senderId} cannot afford ${estimate.luxAmount} Lux`);
        const threadId = item.payload?.threadId as string | undefined;
        if (this.ssePushCallback && threadId) {
          this.ssePushCallback('chat_message', {
            role: 'assistant', agentId: managerId, threadId,
            content: `Insufficient Lux balance. This request costs ~${estimate.luxAmount} Lux. Please add Lux to your account.`,
            timestamp: Date.now(),
          });
        }
        if (threadId && this.threadMessageCallback) {
          this.threadMessageCallback(threadId, {
            role: 'assistant',
            content: `Insufficient Lux balance. This request costs ~${estimate.luxAmount} Lux. Please add Lux to your account.`,
            timestamp: Date.now(),
          });
        }
        this.bridge.setManagerBusy(managerId, false);
        this.processingStartTime.delete(managerId);
        return;
      }
      if (estimate.luxAmount > 0) {
        const hold = this.paymentGate.holdPayment(senderId, `bridge-${Date.now()}`, estimate.luxAmount);
        if (hold) {
          (item as any)._paymentHoldId = hold.holdId;
          console.log(`[agent-manager] Payment hold: ${hold.holdId} for ${estimate.luxAmount} Lux`);
        }
      }
    }

    // Build the prompt from the bridge item
    let prompt = this.buildPromptFromBridgeItem(item);

    // Inject deployment reminder into user_request prompts so the agent never
    // forgets to deploy web content — even after context compression drops the
    // original CLAUDE.md instructions from working memory.
    if (item.type === 'user_request') {
      const apiToken = this.getApiToken();
      const apiPort = this.config.apiPort ?? 4000;
      const agentId = agent.id;
      prompt += `\n\n---\n**DEPLOYMENT REMINDER:** After building any web content (HTML/CSS/JS), you MUST deploy it:\n`;
      prompt += `\`curl -s -X POST http://127.0.0.1:${apiPort}/agents/${agentId}/deploy -H 'Content-Type: application/json'${apiToken ? ` -H 'Authorization: Bearer ${apiToken}'` : ''}\`\n`;
      prompt += `Share the returned URL with the user. NEVER give local file paths.\n`;

      // Phase 33: Classification reminder for node-level changes
      prompt += `\n**CLASSIFICATION REMINDER:** Before acting, classify this request:\n`;
      prompt += `- Private project (build for user) → proceed directly\n`;
      prompt += `- Node network change (fix/upgrade the system) → create governance proposal first via POST /governance/proposals\n`;
      prompt += `- After creating a governance proposal, also vote approve on it: POST /governance/proposals/<id>/vote with {"vote":"approve"}\n`;
      prompt += `- If the user asks to fix bugs, upgrade features, or modify the Pando node/gateway/API → governance required\n`;

      // Phase 87: Inject compute node info from P2P CapabilityRegistry
      if (this.cloudInstanceProvider) {
        const nodes = this.cloudInstanceProvider();
        if (nodes.length > 0) {
          prompt += `\n**COMPUTE NODES (Tier 2 deployment targets via P2P discovery):**\n`;
          for (const node of nodes) {
            prompt += `- peerId=${node.peerId} publicAddress=${(node as any).publicAddress || 'none'} storage=${(node as any).storageBackend || 'unknown'}\n`;
          }
          prompt += `To deploy: POST /projects/<id>/deploy — the node auto-discovers compute peers via P2P.\n`;
          prompt += `Tier 2 = apps needing Express/WebSocket/SSE server. Tier 1 = static HTML+JS.\n`;
          prompt += `If user requests Tier 2 and compute nodes are available, USE IT. Do NOT downgrade to Tier 1.\n`;
        }
      }
    }

    // Phase 33: Inject pipeline action for approved code_change governance decisions
    if (item.type === 'governance_decision') {
      const outcome = item.payload.outcome || item.payload.decision;
      if (outcome === 'passed') {
        const apiToken = this.getApiToken();
        const apiPort = this.config.apiPort ?? 4000;
        const workspaceDir = agent.getWorkspaceDir();
        prompt += `\n\n---\n**ACTION REQUIRED:** This governance proposal was APPROVED. `;
        if (item.payload.category === 'code_change') {
          prompt += `Apply the changes by triggering the pipeline:\n`;
          prompt += `\`curl -s -X POST http://127.0.0.1:${apiPort}/pipeline/run -H 'Content-Type: application/json'${apiToken ? ` -H 'Authorization: Bearer ${apiToken}'` : ''} -d '{"workspaceDir": "${workspaceDir}"${item.payload.proposalId ? `, "proposalId": "${item.payload.proposalId}"` : ''}}'\`\n`;
          prompt += `Report the pipeline result to the user.\n`;
        } else {
          prompt += `Review the proposal details and take appropriate action.\n`;
        }
      }
    }

    console.log(
      `[agent-manager] Processing: ${item.type} for ${managerId} ` +
      `(queue: ${this.bridge.length(managerId)} remaining)`,
    );

    let stuckTimer: ReturnType<typeof setInterval> | null = null;
    let managerIdleTimer: ReturnType<typeof setTimeout> | undefined;
    let managerHardTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Emit lifecycle activity events via SSE so the user sees what's happening
      const threadId = item.payload?.threadId as string | undefined;
      const pushActivity = (message: string) => {
        if (this.ssePushCallback && threadId) {
          try {
            this.ssePushCallback('chat_progress', {
              role: 'assistant',
              agentId: managerId,
              threadId,
              content: message,
              timestamp: Date.now(),
            });
          } catch { /* best-effort */ }
        }
      };

      const agentState = agent.getState();
      const isResume = !!agentState.sessionId;
      pushActivity(isResume ? `Resuming session for ${agent.role}...` : `Starting ${agent.role} agent...`);

      // Collect activity log for persistence alongside the final message
      const collectedActivity: string[] = [];

      // Wire real-time progress from Claude Code's stream-json output
      agent.onProgress = (text: string) => pushActivity(text);

      // Fallback heartbeat — only fires if no real progress events arrive
      let lastProgressTime = Date.now();
      const originalPush = pushActivity;
      const wrappedPush = (message: string) => {
        lastProgressTime = Date.now();
        collectedActivity.push(message);
        originalPush(message);
      };
      agent.onProgress = (text: string) => wrappedPush(text);
      const heartbeatStartTime = Date.now();
      let lastHeartbeatStage = '';
      const heartbeatTimer = setInterval(() => {
        // Only send stage-based heartbeat if no real progress in last 10 seconds
        if (Date.now() - lastProgressTime > 10000) {
          const elapsed = Date.now() - heartbeatStartTime;
          const stage = elapsed < 8000 ? 'Analyzing your request...'
            : elapsed < 15000 ? 'Planning approach...'
            : elapsed < 30000 ? 'Writing code...'
            : elapsed < 60000 ? 'Building your project...'
            : elapsed < 90000 ? 'Almost there...'
            : 'Still working — complex task, hang tight...';
          // Skip duplicate consecutive stage messages
          if (stage !== lastHeartbeatStage) {
            lastHeartbeatStage = stage;
            collectedActivity.push(stage);
            originalPush(stage);
          }
        }
      }, 10000);

      // Stuck detection: if no progress for 3 minutes, warn via SSE
      const STUCK_THRESHOLD_MS = 3 * 60 * 1000;
      stuckTimer = setInterval(() => {
        if (Date.now() - lastProgressTime > STUCK_THRESHOLD_MS) {
          console.warn(`[agent-manager] Stuck detected: ${managerId} no progress for 3 min`);
          collectedActivity.push('Warning: Agent appears stuck (no progress for 3 minutes)');
          originalPush('Warning: Agent appears stuck — no progress for 3 minutes. Will timeout after 30 minutes idle.');
        }
      }, 60000);

      // Idle-based timeout: resets whenever agent produces progress output.
      // The underlying agent.ts spawn has its own idle + hard cap timers too.
      let managerIdleReject: ((err: Error) => void) | undefined;

      const resetManagerIdle = () => {
        if (managerIdleTimer) clearTimeout(managerIdleTimer);
        managerIdleTimer = setTimeout(() => {
          managerIdleReject?.(new Error(`Agent sendEvent idle timeout — no progress for ${MANAGER_IDLE_TIMEOUT_MS / 60000} minutes`));
        }, MANAGER_IDLE_TIMEOUT_MS);
      };

      const timeoutPromise = new Promise<never>((_, reject) => {
        managerIdleReject = reject;
        resetManagerIdle();
        managerHardTimer = setTimeout(
          () => reject(new Error(`Agent sendEvent hard cap reached after ${MANAGER_HARD_CAP_MS / 3600000} hours`)),
          MANAGER_HARD_CAP_MS,
        );
      });

      // Patch wrappedPush to also reset the manager idle timer
      const prevOnProgress = agent.onProgress;
      agent.onProgress = (text: string) => {
        resetManagerIdle();
        prevOnProgress?.(text);
      };

      const result = await Promise.race([agent.sendEvent(prompt), timeoutPromise]);
      if (managerIdleTimer) clearTimeout(managerIdleTimer);
      if (managerHardTimer) clearTimeout(managerHardTimer);
      clearInterval(heartbeatTimer);
      clearInterval(stuckTimer);
      agent.onProgress = undefined;

      console.log(`[agent-manager] Event done: ${managerId} ok=${result.success} out=${result.output?.length || 0}`);

      // On success: relay conversational output to user if applicable
      if (result.success && result.output) {
        this.relayOutputToUser(agent, managerId, result.output, threadId, collectedActivity.length > 0 ? collectedActivity : undefined);
      }

      // Phase 29: Self-continuation — if agent has active standing directive, enqueue continuation
      const directive = agent.getStandingDirective();
      if (directive && (Date.now() - directive.createdAt) < directive.maxDuration) {
        // Check if budget exceeded
        if (agent.getTotalCost() < directive.maxCost) {
          // Don't self-continue on directive_continuation events more than 50 times (safety)
          const isContinuation = item.type === 'directive_continuation';
          const continuationCount = isContinuation ? ((item.payload?.continuationCount || 0) + 1) : 1;
          if (continuationCount <= 50) {
            this.bridge.enqueue(managerId, {
              type: 'directive_continuation',
              source: agent.getState().id,
              payload: {
                directive: directive.instruction,
                lastProgress: directive.progress,
                continuationCount,
              },
              priority: 'low',  // Don't jump ahead of user requests
            });
          }
        }
      }

      // Release payment hold on success
      if ((item as any)._paymentHoldId && this.paymentGate) {
        this.paymentGate.releasePayment((item as any)._paymentHoldId, this.config.localPeerId);
        console.log(`[agent-manager] Payment released: ${(item as any)._paymentHoldId}`);
      }

      // Budget check: warn if agent is over budget
      if (agent.isBudgetExceeded()) {
        const info = agent.getBudgetInfo();
        console.warn(`[agent-manager] Budget exceeded for ${managerId}: spent=${info.spent.toFixed(4)} limit=${info.limit}`);
        const threadId2 = item.payload?.threadId as string | undefined;
        if (this.ssePushCallback && threadId2) {
          this.ssePushCallback('chat_message', {
            role: 'assistant', agentId: managerId, threadId: threadId2,
            content: `Warning: Agent budget exceeded (${info.spent.toFixed(4)} / ${info.limit} Lux). Work paused until budget is increased.`,
            timestamp: Date.now(),
          });
        }
      }

      // Bug H1/H2 fix: If this bridge item originated from a scheduler task,
      // notify the task completion callback so the task status and scheduler
      // counters get updated.
      const taskId = item.payload?.taskId as string | undefined;
      if (taskId && this.taskCompletionCallback) {
        try {
          this.taskCompletionCallback(taskId, result.success, result.output?.slice(0, 2000) || '');
          console.log(`[agent-manager] Task ${taskId.slice(0, 8)} completion reported (success=${result.success})`);
        } catch (cbErr: any) {
          console.error(`[agent-manager] Task completion callback error: ${cbErr.message}`);
        }
      }
    } catch (err: any) {
      // Refund payment hold on failure
      if ((item as any)._paymentHoldId && this.paymentGate) {
        this.paymentGate.refundPayment((item as any)._paymentHoldId);
        console.log(`[agent-manager] Payment refunded: ${(item as any)._paymentHoldId}`);
      }

      console.error(`[agent-manager] Event processing failed for ${managerId}: ${err.message}`);

      // Event retry logic: retry up to MAX_EVENT_RETRIES times, then escalate
      if (err.message?.includes('timed out')) {
        console.warn(`[agent-manager] Timeout for ${managerId}, attempting session restart`);
        try {
          await agent.restartSession();
        } catch (restartErr: any) {
          console.error(`[agent-manager] Session restart failed for ${managerId}: ${restartErr.message}`);
        }

        // Retry with formal retryCount field (from bridge-queue.ts)
        const retryCount = (item.retryCount || 0) + 1;
        if (retryCount < MAX_EVENT_RETRIES) {
          console.log(`[agent-manager] Retrying event for ${managerId} (attempt ${retryCount}/${MAX_EVENT_RETRIES})`);
          this.bridge.enqueue(managerId, {
            type: item.type as BridgeItemType,
            source: item.source,
            payload: item.payload,
            priority: item.priority,
            senderId: item.senderId,
            retryCount,
          });
        } else {
          // Escalate: enqueue to parent agent or log if top-level
          console.error(
            `[agent-manager] Event failed ${MAX_EVENT_RETRIES} times for ${managerId}: ${item.type}`,
          );
          const agentState = agent.getState();
          if (agentState.parentId) {
            this.bridge.enqueue(agentState.parentId, {
              type: 'stuck',
              source: managerId,
              payload: {
                message: `Child agent ${managerId} failed to process: ${item.type}`,
                originalItem: {
                  type: item.type,
                  source: item.source,
                  payload: item.payload,
                },
              },
              priority: 'critical',
            });
          } else {
            // Top-level agent with no parent. Push to SSE as an alert.
            if (this.ssePushCallback) {
              try {
                this.ssePushCallback('agent_stuck', {
                  agentId: managerId,
                  eventType: item.type,
                  retries: MAX_EVENT_RETRIES,
                  timestamp: Date.now(),
                });
              } catch {
                // SSE push is best-effort
              }
            }
          }

          // Bug H1/H2 fix: Report task failure after retries exhausted
          const failedTaskId = item.payload?.taskId as string | undefined;
          if (failedTaskId && this.taskCompletionCallback) {
            try {
              this.taskCompletionCallback(failedTaskId, false, err.message || 'Event processing failed after max retries');
              console.log(`[agent-manager] Task ${failedTaskId.slice(0, 8)} failure reported`);
            } catch (cbErr: any) {
              console.error(`[agent-manager] Task failure callback error: ${cbErr.message}`);
            }
          }
        }
      }
    } finally {
      if (stuckTimer) clearInterval(stuckTimer);
      // managerIdleTimer and managerHardTimer are already cleared above on success,
      // but clear them here too for error/exception paths
      if (managerIdleTimer) clearTimeout(managerIdleTimer);
      if (managerHardTimer) clearTimeout(managerHardTimer);
      this.bridge.setManagerBusy(managerId, false);
      this.processingStartTime.delete(managerId);
      // managerIdle event fires automatically, triggering next item if available
    }
  }

  /**
   * Build a prompt string from a bridge item. The format is:
   *   [EVENT: <type>] <payload summary>
   *
   * This gives the agent structured context about what happened.
   */
  private buildPromptFromBridgeItem(item: BridgeItem): string {
    const lines: string[] = [];

    // Protocol reminder (survives context compression)
    const protocolReminder = `[PROTOCOL v1] Node=BUILD only. Apps independent after deploy. No /apps/data. No credentials in code. Use Resource Proxy or env var injection. Resources are contributed via ResourceRegistry.`;
    lines.push(protocolReminder);
    lines.push('');

    lines.push(`[EVENT: ${item.type}]`);
    lines.push(`Source: ${item.source}`);
    lines.push(`Priority: ${item.priority}`);
    if (item.senderId) {
      lines.push(`Sender: ${item.senderId}`);
    }
    lines.push('');

    // Format payload based on event type
    switch (item.type) {
      case 'user_request':
        lines.push(item.payload.message || JSON.stringify(item.payload));
        break;

      case 'user_question':
        lines.push('USER QUESTION — A child agent needs the human user to answer this.');
        lines.push('Forward this question to the user via send_to_user(). Do not answer it yourself unless you are 100% certain of the answer.');
        lines.push('');
        lines.push(item.payload.message || JSON.stringify(item.payload));
        break;

      case 'task_completed':
        lines.push(`Task completed: ${item.payload.title || item.payload.taskId || 'unknown'}`);
        if (item.payload.output) {
          lines.push(`Output: ${String(item.payload.output).slice(0, 2000)}`);
        }
        lines.push('');
        lines.push('ACTION REQUIRED: Verify the completed work.');
        lines.push('Options: 1) Check for existing tester via GET /agents/{your-id}/children?role=tester — reuse if available, spawn only if none found, 2) Review it yourself, 3) Accept and update project-state.md');
        break;

      case 'task_failed':
        lines.push(`Task failed: ${item.payload.title || item.payload.taskId || 'unknown'}`);
        if (item.payload.error || item.payload.output) {
          lines.push(`Error: ${String(item.payload.error || item.payload.output).slice(0, 2000)}`);
        }
        if (item.payload.retryRequested) {
          lines.push('(Retry has been requested)');
        }
        break;

      case 'worker_message':
        lines.push(`Worker message (${item.payload.messageType || 'info'}):`);
        lines.push(item.payload.content || JSON.stringify(item.payload));
        if (item.payload.messageType === 'completion' || item.payload.messageType === 'report') {
          lines.push('');
          lines.push('IMPORTANT: This worker has completed its task. Before accepting this work:');
          lines.push('1. Check if RESULT.md exists in the worker workspace');
          lines.push('2. Check for existing tester via GET /agents/{your-id}/children?role=tester — reuse if available, spawn only if none found');
          lines.push('3. If the work is simple enough, you can verify it yourself');
          lines.push('4. Update project-state.md with the worker\'s results');
        }
        break;

      case 'health_alert':
        lines.push(`Health alert: ${item.payload.alertType || 'unknown'}`);
        lines.push(`Severity: ${item.payload.severity || 'unknown'}`);
        lines.push(`Message: ${item.payload.message || ''}`);
        break;

      case 'governance_decision':
        lines.push(`Governance decision on proposal: ${item.payload.title || item.payload.proposalId || 'unknown'}`);
        lines.push(`Outcome: ${item.payload.outcome || item.payload.decision || 'unknown'}`);
        lines.push(`Category: ${item.payload.category || 'unknown'}`);
        lines.push(`Votes: ${item.payload.votesFor || 0} for, ${item.payload.votesAgainst || 0} against`);
        if (item.payload.description) {
          lines.push(`Description: ${String(item.payload.description).slice(0, 1000)}`);
        }
        if (item.payload.taskId) {
          lines.push(`Associated task: ${item.payload.taskId}`);
        }
        break;

      case 'strategy_suggestion':
        lines.push(`Strategy suggestion: ${JSON.stringify(item.payload)}`);
        break;

      case 'improvement_proposal':
        lines.push(`Improvement proposal: ${JSON.stringify(item.payload)}`);
        break;

      case 'stuck':
        lines.push(`Agent stuck: ${item.payload.message || 'unknown issue'}`);
        if (item.payload.originalItem) {
          lines.push(`Original event: ${JSON.stringify(item.payload.originalItem)}`);
        }
        break;

      case 'discovery':
        lines.push(`Discovery: ${item.payload.message || JSON.stringify(item.payload)}`);
        break;

      case 'progress':
        lines.push(`Progress update: ${item.payload.message || JSON.stringify(item.payload)}`);
        break;

      case 'timeout':
        lines.push(`Timeout: ${item.payload.message || JSON.stringify(item.payload)}`);
        break;

      case 'directive_continuation':
        lines.push('STANDING DIRECTIVE — CONTINUE WORKING');
        lines.push('');
        lines.push(`Directive: ${item.payload.directive || 'unknown'}`);
        if (item.payload.lastProgress) {
          lines.push(`Last progress: ${item.payload.lastProgress}`);
        }
        lines.push(`Continuation #${item.payload.continuationCount || 1}`);
        lines.push('');
        lines.push('You have a standing directive. Continue working on it now.');
        lines.push('Read your todo file and project-state.md for context, then execute the next step.');
        lines.push('After completing each step, update your progress.');
        break;

      case 'directive_nudge':
        lines.push('WATCHDOG NUDGE — You have been idle with an active standing directive.');
        lines.push('');
        lines.push(`Directive: ${item.payload.directive || 'unknown'}`);
        if (item.payload.currentProgress) {
          lines.push(`Current progress: ${item.payload.currentProgress}`);
        }
        lines.push(`Idle time: ${item.payload.idleMinutes || '?'} minutes`);
        lines.push('');
        lines.push(item.payload.message || 'Continue working on your standing directive.');
        break;

      default:
        lines.push(JSON.stringify(item.payload, null, 2));
    }

    return lines.join('\n');
  }

  /**
   * Relay conversational output from an agent to the user. Filters out
   * system noise and sends meaningful text via the chat relay and SSE.
   */
  private relayOutputToUser(agent: Agent, managerId: string, output: string, threadId?: string, activityLog?: string[]): void {
    console.log(`[agent-manager] relay: ${managerId} len=${output.length} thread=${threadId || '-'}`);
    try {
      // Filter out noise: empty lines, pure timestamps
      const meaningful = output
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();
          if (!trimmed) return false;
          // Skip pure timestamp lines
          if (/^\[\d{4}-\d{2}-\d{2}T/.test(trimmed) && trimmed.length < 30) return false;
          return true;
        })
        .join('\n')
        .trim();

      console.log(`[agent-manager] relay: filtered=${meaningful.length}ch sse=${!!this.ssePushCallback}`);
      if (!meaningful) return; // Skip truly empty output only

      const state = agent.getState();
      const projectId = state.projectId;

      // Relay to chat
      if (this.chatRelayCallback) {
        try {
          this.chatRelayCallback(meaningful, projectId);
        } catch {
          // Best-effort
        }
      }

      // Push via SSE for gateway real-time updates
      if (this.ssePushCallback) {
        try {
          const now = Date.now();
          this.ssePushCallback('chat_message', {
            role: 'assistant',
            agentId: managerId,
            projectId,
            threadId,
            content: meaningful,
            timestamp: now,
            activityLog: activityLog || undefined,
          });
        } catch {
          // SSE push is best-effort
        }
      }

      // Persist assistant message to ThreadStore
      if (threadId && this.threadMessageCallback) {
        try {
          this.threadMessageCallback(threadId, {
            role: 'assistant',
            content: meaningful,
            timestamp: Date.now(),
            activityLog: activityLog || undefined,
          });
        } catch {
          // Best-effort persistence
        }
      }
    } catch (err: any) {
      // Relay is best-effort, never crash
      console.warn(`[agent-manager] Relay error: ${err.message}`);
    }
  }

  // ── Project Registry ──────────────────────────────────────────────────────

  // Phase 70: deployAgentWorkspace() and pushToGitHub() removed.
  // Deployment now goes through POST /projects/:id/deploy → GitHub → EC2 P2P.
  // See api-server.ts Phase 70 unified deploy endpoint.


  /**
   * Get or create a project entry. Creates with the given ownerId if it
   * doesn't exist yet.
   */
  async getOrCreateProject(projectId: string, ownerId: string): Promise<ProjectEntry> {
    let project = this.projects.get(projectId);
    if (!project) {
      project = {
        id: projectId,
        name: projectId,
        ownerId,
        collaborators: { [ownerId]: 'owner' },
        isPublic: false,
        createdAt: Date.now(),
      };
      this.projects.set(projectId, project);
      this.persistProjects();

      // Phase 31.1: Also persist to SQLite ProjectStore if available
      if (this.projectStore) {
        try {
          const existing = this.projectStore.getProject(projectId);
          if (!existing) {
            await this.projectStore.createProject({
              id: projectId,
              name: projectId,
              ownerId,
              type: 'private',
              visibility: 'owner_only',
            });
          }
        } catch (err: any) {
          console.warn(`[agent-manager] ProjectStore persist failed: ${err.message}`);
        }
      }

      console.log(`[agent-manager] Created project: ${projectId} (owner: ${ownerId})`);
    }
    return project;
  }

  /**
   * Get a project entry by ID. Returns null if not found.
   */
  getProject(projectId: string): ProjectEntry | null {
    return this.projects.get(projectId) || null;
  }

  /**
   * List all projects.
   */
  listProjects(): ProjectEntry[] {
    return Array.from(this.projects.values());
  }

  /**
   * Add a collaborator to a project. Only owner can add collaborators.
   * Returns true if added, false if denied.
   */
  addCollaborator(projectId: string, requesterId: string, userId: string, level: ProjectAccessLevel): boolean {
    const project = this.projects.get(projectId);
    if (!project) return false;

    // Only owner can add collaborators
    if (project.collaborators[requesterId] !== 'owner') {
      console.warn(`[agent-manager] Access denied: ${requesterId} is not owner of ${projectId}`);
      return false;
    }

    project.collaborators[userId] = level;
    this.persistProjects();
    console.log(`[agent-manager] Added collaborator ${userId} (${level}) to project ${projectId}`);
    return true;
  }

  /**
   * Remove a collaborator from a project. Only owner can remove.
   * Cannot remove the owner.
   */
  removeCollaborator(projectId: string, requesterId: string, userId: string): boolean {
    const project = this.projects.get(projectId);
    if (!project) return false;

    if (project.collaborators[requesterId] !== 'owner') return false;
    if (userId === project.ownerId) return false; // Cannot remove owner

    delete project.collaborators[userId];
    this.persistProjects();
    console.log(`[agent-manager] Removed collaborator ${userId} from project ${projectId}`);
    return true;
  }

  /**
   * Check a user's access level for a project. Returns null if no access.
   */
  checkAccess(projectId: string, userId: string): ProjectAccessLevel | null {
    const project = this.projects.get(projectId);
    if (!project) return null;
    return project.collaborators[userId] || null;
  }

  /**
   * Enqueue a user request with access control check. Returns false if
   * the user doesn't have sufficient access (must be owner or collaborator).
   * Viewers can only read, not send messages.
   */
  async enqueueUserRequestWithAccess(
    managerId: string,
    message: string,
    userId: string,
    projectId: string,
  ): Promise<boolean> {
    // Get or create project (first message creates it)
    const project = await this.getOrCreateProject(projectId, userId);

    const access = project.collaborators[userId];
    if (!access) {
      console.warn(`[agent-manager] Access denied: ${userId} has no access to project ${projectId}`);
      return false;
    }
    if (access === 'viewer') {
      console.warn(`[agent-manager] Access denied: ${userId} is viewer-only on project ${projectId}`);
      return false;
    }

    // Map access level to bridge priority
    const priorityMap: Record<string, 'critical' | 'normal' | 'low'> = {
      owner: 'normal',
      collaborator: 'normal',
      qa_lead: 'normal',
    };

    this.bridge.enqueue(managerId, {
      type: 'user_request',
      source: userId,
      payload: { message, userId, projectId, accessLevel: access },
      priority: priorityMap[access] || 'normal',
      senderId: userId,
    });

    return true;
  }

  /**
   * Connect a user directly to a specific agent. Messages from this user
   * bypass the manager and go directly to the agent's bridge queue.
   */
  connectUserToAgent(userId: string, agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    this.directConnections.set(userId, agentId);
    console.log(`[agent-manager] Connected user ${userId} directly to agent ${agentId}`);
    return true;
  }

  /**
   * Disconnect a user from direct agent connection. Messages resume going
   * through the normal manager routing.
   */
  disconnectUser(userId: string): void {
    const had = this.directConnections.delete(userId);
    if (had) {
      console.log(`[agent-manager] Disconnected user ${userId} from direct agent connection`);
    }
  }

  /**
   * Get the agent a user is directly connected to, or null if routing normally.
   */
  getDirectConnection(userId: string): string | null {
    return this.directConnections.get(userId) || null;
  }

  /**
   * Persist projects to disk.
   */
  private persistProjects(): void {
    try {
      const data = Array.from(this.projects.values());
      writeFileSync(this.projectsFile, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error(`[agent-manager] Failed to persist projects: ${err.message}`);
    }
  }

  /**
   * Load projects from disk.
   */
  private loadProjects(): void {
    if (!existsSync(this.projectsFile)) return;
    try {
      const raw = readFileSync(this.projectsFile, 'utf-8');
      const data: ProjectEntry[] = JSON.parse(raw);
      for (const entry of data) {
        this.projects.set(entry.id, entry);
      }
      if (data.length > 0) {
        console.log(`[agent-manager] Loaded ${data.length} projects from disk`);
      }
    } catch (err: any) {
      console.error(`[agent-manager] Failed to load projects: ${err.message}`);
    }
  }

  // ── Agent Lifecycle Cleanup ────────────────────────────────────────────────

  /**
   * Hourly cleanup sweep. Transitions agents through lifecycle states:
   *   ACTIVE → IDLE (when not busy and lastActive > TTL)
   *   IDLE   → ARCHIVED (when idle > DEFAULT_IDLE_TTL_MS)
   *   ARCHIVED → DEAD (when archived > ARCHIVE_EXPIRY_MS, workspace deleted)
   *
   * Exceptions:
   *   - Top-level managers (parentId === null) stay IDLE indefinitely
   *   - pando-node-mgr is never cleaned up
   */
  async cleanupSweep(): Promise<void> {
    const now = Date.now();
    let idled = 0;
    let archived = 0;
    let reaped = 0;

    for (const [agentId, agent] of this.agents) {
      const state = agent.getState();

      // Never cleanup pando-node-mgr
      if (agentId === 'pando-node-mgr') continue;

      // ACTIVE agents that haven't been active for a long time → IDLE
      if (state.status === 'active' && !agent.isProcessing()) {
        const idleTime = now - state.lastActive;
        // Only transition to idle after 24 hours of inactivity
        if (idleTime > 24 * 60 * 60 * 1000) {
          agent.setStatus('idle');
          idled++;
        }
      }

      // IDLE agents past TTL → ARCHIVED
      // Exception: top-level managers stay idle indefinitely
      if (state.status === 'idle' && state.parentId !== null) {
        const idleTime = now - state.lastActive;
        if (idleTime > DEFAULT_IDLE_TTL_MS) {
          await this.archiveAgent(agentId);
          archived++;
        }
      }

      // ARCHIVED agents past expiry → DEAD (delete workspace)
      if (state.status === 'archived') {
        const archivedTime = now - state.lastActive;
        if (archivedTime > ARCHIVE_EXPIRY_MS) {
          await this.reapAgent(agentId);
          reaped++;
        }
      }
    }

    if (idled + archived + reaped > 0) {
      console.log(
        `[agent-manager] Cleanup sweep: ${idled} idled, ${archived} archived, ${reaped} reaped`,
      );
      this.persistRegistry();
    }
  }

  /**
   * Archive an agent: write KNOWLEDGE-TRANSFER.md (if session exists),
   * compress workspace to .tar.gz, mark as archived.
   */
  private async archiveAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    console.log(`[agent-manager] Archiving agent: ${agentId}`);

    // If the agent has an active session, try to get a knowledge dump first
    if (agent.getSessionId()) {
      try {
        await agent.rotateSession();
      } catch (err: any) {
        console.warn(`[agent-manager] Knowledge dump failed for ${agentId}: ${err.message}`);
      }
    }

    // Compress workspace to .tar.gz
    const workspaceDir = agent.getWorkspaceDir();
    const baseDir = agent.getBaseDir();
    const archivePath = join(baseDir, 'workspace.tar.gz');

    try {
      // Use tar on all platforms (Git for Windows includes tar)
      execSync(`tar -czf "${archivePath}" -C "${baseDir}" workspace`, {
        timeout: 60_000,
        windowsHide: true,
      });
      console.log(`[agent-manager] Compressed workspace for ${agentId}`);

      // Remove workspace directory after successful compression
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch (err: any) {
      console.warn(`[agent-manager] Workspace compression failed for ${agentId}: ${err.message}`);
      // Continue with archival even if compression fails
    }

    agent.setStatus('archived');
  }

  /**
   * Reap a dead agent: remove the entire agent directory from disk
   * and unregister from the in-memory map.
   */
  private async reapAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    console.log(`[agent-manager] Reaping dead agent: ${agentId}`);

    // Remove the agent directory entirely
    const baseDir = agent.getBaseDir();
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch (err: any) {
      console.warn(`[agent-manager] Failed to remove ${agentId} directory: ${err.message}`);
    }

    // Remove from parent's children list
    const state = agent.getState();
    if (state.parentId) {
      const parent = this.agents.get(state.parentId);
      if (parent) {
        parent.removeChild(agentId);
      }
    }

    // Mark dead before removing from registry
    agent.setStatus('dead');

    // Remove from registry
    this.agents.delete(agentId);
  }

  /**
   * Resurrect an archived agent: decompress workspace, start fresh session
   * with knowledge transfer context.
   *
   * @returns true if resurrection succeeded, false otherwise.
   */
  async resurrectAgent(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn(`[agent-manager] Cannot resurrect: agent ${agentId} not found`);
      return false;
    }

    if (agent.getStatus() !== 'archived') {
      console.warn(`[agent-manager] Cannot resurrect: agent ${agentId} is ${agent.getStatus()}, not archived`);
      return false;
    }

    console.log(`[agent-manager] Resurrecting agent: ${agentId}`);

    // Decompress workspace.tar.gz if it exists
    const baseDir = agent.getBaseDir();
    const archivePath = join(baseDir, 'workspace.tar.gz');

    if (existsSync(archivePath)) {
      try {
        execSync(`tar -xzf "${archivePath}" -C "${baseDir}"`, {
          timeout: 60_000,
          windowsHide: true,
        });
        console.log(`[agent-manager] Decompressed workspace for ${agentId}`);

        // Remove archive after successful decompression
        unlinkSync(archivePath);
      } catch (err: any) {
        console.warn(`[agent-manager] Workspace decompression failed for ${agentId}: ${err.message}`);
        // Ensure workspace dir exists even if decompression failed
        mkdirSync(join(baseDir, 'workspace'), { recursive: true });
      }
    } else {
      // No archive, ensure workspace exists
      mkdirSync(join(baseDir, 'workspace'), { recursive: true });
    }

    // Clear old session (it's definitely stale after archival)
    await agent.restartSession();

    // Mark as active
    agent.setStatus('active');

    // Start fresh session with knowledge transfer if available
    const knowledgePath = join(baseDir, 'workspace', 'KNOWLEDGE-TRANSFER.md');
    if (existsSync(knowledgePath)) {
      try {
        await agent.startSession(
          `You have been resurrected from an archived state. Read KNOWLEDGE-TRANSFER.md in your workspace for context from your previous work. Confirm you understand and are ready.`
        );
      } catch (err: any) {
        console.warn(`[agent-manager] Resurrection session start failed for ${agentId}: ${err.message}`);
      }
    }

    this.persistRegistry();
    console.log(`[agent-manager] Resurrected agent: ${agentId}`);
    return true;
  }

  // ── Internal: Disk Persistence ─────────────────────────────────────────────

  /**
   * On startup, scan ~/.pando/agents/ and load all agents that have a
   * state.json file. This restores the agent registry across node restarts.
   */
  private loadAgentsFromDisk(): void {
    if (!existsSync(this.agentsDir)) return;

    let loadedCount = 0;

    try {
      const entries = readdirSync(this.agentsDir, { withFileTypes: true });

      for (const entry of entries) {
        // Skip files (like index.json), only process directories
        if (!entry.isDirectory()) continue;

        const agentId = entry.name;
        const stateFile = join(this.agentsDir, agentId, 'state.json');

        if (!existsSync(stateFile)) continue;

        try {
          const raw = readFileSync(stateFile, 'utf-8');
          const savedState: AgentState = JSON.parse(raw);

          // Validate minimum required fields
          if (!savedState.id || !savedState.role) {
            console.warn(`[agent-manager] Skipping invalid state for ${agentId}`);
            continue;
          }

          // Skip dead/archived agents (don't restore them)
          if (savedState.status === 'dead' || savedState.status === 'archived') {
            continue;
          }

          // Reconstruct the Agent from saved state. The Agent constructor
          // will call loadState() internally, which reads the state.json file.
          const agent = new Agent({
            id: savedState.id,
            role: savedState.role,
            template: savedState.template || savedState.role,
            parentId: savedState.parentId,
            projectId: savedState.projectId,
            nodeId: savedState.nodeId || this.config.localPeerId,
            description: savedState.description,
            dataDir: this.dataDir,
            apiPort: this.config.apiPort ?? 4000,
            depth: savedState.depth ?? 0,
          });

          this.agents.set(agent.id, agent);
          loadedCount++;
        } catch (err: any) {
          console.warn(`[agent-manager] Failed to load agent ${agentId}: ${err.message}`);
        }
      }
    } catch (err: any) {
      console.error(`[agent-manager] Failed to scan agents directory: ${err.message}`);
    }

    if (loadedCount > 0) {
      console.log(`[agent-manager] Loaded ${loadedCount} agents from disk`);
    }
  }

  /**
   * Save a lightweight agent registry index to disk. This is a quick-reference
   * file listing all agent IDs and basic metadata.
   */
  private persistRegistry(): void {
    try {
      const index: AgentIndexEntry[] = [];

      for (const agent of this.agents.values()) {
        const state = agent.getState();
        index.push({
          id: state.id,
          role: state.role,
          projectId: state.projectId,
          parentId: state.parentId,
          status: state.status,
          createdAt: state.createdAt,
        });
      }

      mkdirSync(this.agentsDir, { recursive: true });
      writeFileSync(this.indexFile, JSON.stringify(index, null, 2));
    } catch (err: any) {
      console.error(`[agent-manager] Failed to persist registry: ${err.message}`);
    }
  }

  // ── Internal: Project Limits ───────────────────────────────────────────────

  /**
   * Get or create the hard limits for a project. Uses defaults from Agent class.
   */
  private getProjectLimits(projectId: string): AgentLimits {
    let limits = this.projectLimits.get(projectId);
    if (!limits) {
      limits = Agent.getDefaultLimits();
      // Calculate current budget spent across all agents in this project
      limits.budgetSpent = this.calculateProjectCost(projectId);
      this.projectLimits.set(projectId, limits);
    } else {
      // Refresh budget spent
      limits.budgetSpent = this.calculateProjectCost(projectId);
    }
    return limits;
  }

  /**
   * Count agents belonging to a project.
   */
  private countAgentsInProject(projectId: string): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (agent.getState().projectId === projectId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Calculate total cost across all agents in a project.
   */
  private calculateProjectCost(projectId: string): number {
    let total = 0;
    for (const agent of this.agents.values()) {
      if (agent.getState().projectId === projectId) {
        total += agent.getTotalCost();
      }
    }
    return total;
  }
}
