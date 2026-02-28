/**
 * Orchestrator — The deterministic tick loop at the heart of the agent system.
 *
 * One class, used at every level of the hierarchy:
 *   - Council orchestrator: manages the network, delegates to departments
 *   - Department orchestrator: manages a functional area (engineering, QA)
 *   - Project orchestrator: manages a user's project, spawns builders/testers
 *
 * The tick loop:
 *   1. Read board (tasks for this orchestrator)
 *   2. Read inbox (unread messages)
 *   3. Classify: Tier 1 (deterministic) or Tier 2 (needs AI judgment)
 *   4. If Tier 2: session-persistent AI call (boot prompt on first tick, tick update on subsequent)
 *   5. Execute actions returned by AI or determined by code
 *   6. Log the tick
 *
 * Key design decisions:
 *   - Session-persistent AI brain (Opus). First tick = boot prompt with full instructions.
 *     Subsequent ticks = short board-state update. Session rotates every ~50 ticks.
 *   - All state in SQLite. Nothing in memory except the timer handle + session ID.
 *   - Same class at all levels. Only the config and rolePrompt differ.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDatabase, AgentIdentity, InboxMessage, Lesson } from './agent-database.js';
import type { MessageBus } from '../core/message-bus.js';
import type { WorkerPool } from '../core/worker-pool.js';
import type { OrgManager } from './org-manager.js';
import type { AIBackendRegistry } from '../core/ai-backend-registry.js';
import type { GenomeBridge, GenomeBridgeRegistry } from './genome-bridge.js';
import type { ScenarioRunner } from './scenario-runner.js';
import type { TemplateRegistry } from './template-registry.js';
import type { ThreadStore } from './thread-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorDeps {
  db: AgentDatabase;
  messageBus: MessageBus;
  workerPool: WorkerPool;
  orgManager: OrgManager;
  aiRegistry: AIBackendRegistry;
  /** Callback to create governance proposals */
  onPropose?: (title: string, description: string, diff?: string) => Promise<void>;
  /** Callback to commit code */
  onCommit?: (message: string) => Promise<boolean>;
  /** Genome knowledge graph bridge for architecture context */
  genomeBridge?: GenomeBridge;
  /** Per-project genome registry (prefers project-specific genome over Pando's) */
  genomeBridgeRegistry?: GenomeBridgeRegistry;
  /** Scenario runner for post-upgrade regression testing */
  scenarioRunner?: ScenarioRunner;
  /** Phase 105: Template registry for available roles */
  templateRegistry?: TemplateRegistry;
  /** API port for worker HTTP calls (deploy, validate, etc.) */
  apiPort?: number;
  /** Data directory for reading api-token and running-commit.txt */
  dataDir?: string;
  /** Repo root directory for git rev-parse HEAD (safe restart check) */
  repoDir?: string;
  /** Thread store for writing orchestrator responses back to chat UI */
  threadStore?: ThreadStore;
  /** Push SSE events to connected clients (chat_message, etc.) */
  pushEvent?: (event: string, data: any) => void;
}

export type OrchestratorAction =
  | { type: 'spawn_worker'; role: string; templateId?: string; taskId?: string; fileScope?: string[]; rolePrompt?: string }
  | { type: 'kill_worker'; workerId: string }
  | { type: 'create_task'; title: string; description: string; priority?: number }
  | { type: 'assign_task'; taskId: string; workerId: string }
  | { type: 'send_message'; recipientId: string; message: string }
  | { type: 'create_team'; role: string; rolePrompt?: string }
  | { type: 'dissolve_team'; orchestratorId: string }
  | { type: 'record_lesson'; lesson: string; source?: string; tags?: string[] }
  | { type: 'escalate'; message: string }
  | { type: 'propose_upgrade'; title: string; description: string }
  | { type: 'commit_code'; message: string }
  | { type: 'respond_to_user'; message: string }
  | { type: 'run_scenarios'; category?: string };

interface BoardState {
  pendingTasks: number;
  activeTasks: number;
  activeWorkers: number;
  maxWorkers: number;
  messages: InboxMessage[];
  workerReports: InboxMessage[];
  healthAlerts: InboxMessage[];
  userRequests: InboxMessage[];
  peerDisconnects: InboxMessage[];
  directives: Array<{ id: number; content: string }>;
  recentlyFailed: Array<{ id: string; role: string; failedAt: string; lastTask: string | null; rolePrompt: string | null }>;
  overdueWorkers: Array<{ id: string; role: string; spawnedAt: string; lastReportAt: string | null }>;
  interruptedWorkers: Array<{ workerId: string; role: string; rolePrompt: string | null; sessionId: string | null }>;
}

// ---------------------------------------------------------------------------
// Orchestrator class
// ---------------------------------------------------------------------------

export class Orchestrator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = false;
  private _startTime: number = 0;
  /** Track the most recent threadId from user requests for respond_to_user */
  private _lastThreadId: string | null = null;
  /** Tick counter for periodic self-check (every 10th tick) */
  private _tickCount = 0;
  /** Claude Code session ID for persistent context across ticks */
  private _sessionId: string | null = null;
  /** Number of ticks within the current session */
  private _sessionTickCount = 0;
  /** Consecutive empty ticks (no actions returned by AI) */
  private _consecutiveEmptyTicks = 0;
  /** Consecutive parse failures from AI output */
  private _consecutiveParseFailures = 0;
  /** Rotate session after this many ticks to keep context fresh */
  private static readonly SESSION_ROTATION_TICKS = 50;

  constructor(
    private orchestratorId: string,
    private deps: OrchestratorDeps,
  ) {}

  /**
   * Start the tick loop.
   */
  start(): void {
    const agent = this.deps.db.getAgent(this.orchestratorId);
    if (!agent) throw new Error(`Orchestrator ${this.orchestratorId} not found in database`);
    if (agent.type !== 'orchestrator') throw new Error(`${this.orchestratorId} is not an orchestrator`);

    const interval = agent.tickIntervalMs || 60000;
    this.stopped = false;
    this._startTime = Date.now();

    // Clear session on node restart — old process is dead, session unusable.
    // The AI will get a fresh boot prompt on first tick.
    this._sessionId = null;
    this._sessionTickCount = 0;
    this._consecutiveEmptyTicks = 0;
    this._consecutiveParseFailures = 0;

    // Restore _lastThreadId from SQLite (survives node restarts)
    try {
      const meta = this.deps.db.getMetadata(this.orchestratorId);
      if (meta) {
        const parsed = JSON.parse(meta);
        if (parsed.lastThreadId) this._lastThreadId = parsed.lastThreadId;
      }
    } catch { /* ignore parse errors */ }

    // Tick immediately on start, then on interval
    this.tick().catch(err => console.error(`[Orchestrator ${this.orchestratorId}] tick error:`, err));

    this.timer = setInterval(() => {
      if (!this.ticking && !this.stopped) {
        this.tick().catch(err => console.error(`[Orchestrator ${this.orchestratorId}] tick error:`, err));
      }
    }, interval);
  }

  /**
   * Stop the tick loop.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Check whether a safe self-restart is due (council orchestrator only).
   *
   * A restart is pending when git HEAD has moved past the commit that was
   * running when the node started (recorded in <dataDir>/running-commit.txt).
   * Exits with code 75 only when fully idle: no active workers, no pending
   * tasks, and no unread messages in the bus.  PM2/systemd then restarts the
   * node with the freshly-built binary.
   */
  private checkSafeRestart(): void {
    const agent = this.deps.db.getAgent(this.orchestratorId);
    if (!agent || agent.role !== 'council') return;

    const dataDir = this.deps.dataDir;
    const repoDir = this.deps.repoDir;
    if (!dataDir || !repoDir) return;

    try {
      const stampPath = join(dataDir, 'running-commit.txt');
      if (!existsSync(stampPath)) return;

      const runningCommit = readFileSync(stampPath, 'utf-8').trim();
      const currentHead = (execSync('git rev-parse HEAD', {
        cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
      }) as string).trim();

      if (currentHead === runningCommit) return; // still on the same build — nothing to do

      // A new commit is in the repo.  Only restart when fully idle.
      const activeWorkers = this.deps.db.getActiveWorkers(this.orchestratorId).length;
      const pendingTasks = this.deps.db.listAgents({ parentId: this.orchestratorId, status: 'pending' }).length;
      const messagesPending = this.deps.messageBus.hasPendingMessages();

      if (activeWorkers > 0) {
        console.log(`[Orchestrator ${this.orchestratorId}] Safe restart deferred: ${activeWorkers} active worker(s) (built=${currentHead.slice(0, 8)}, running=${runningCommit.slice(0, 8)})`);
        return;
      }
      if (pendingTasks > 0) {
        console.log(`[Orchestrator ${this.orchestratorId}] Safe restart deferred: ${pendingTasks} pending task(s)`);
        return;
      }
      if (messagesPending) {
        console.log(`[Orchestrator ${this.orchestratorId}] Safe restart deferred: messages in-flight`);
        return;
      }

      console.log(`[Orchestrator ${this.orchestratorId}] Safe restart: exiting with code 75 (upgrade) — built=${currentHead.slice(0, 8)}, was=${runningCommit.slice(0, 8)}`);
      process.exit(75);
    } catch { /* git unavailable or file missing — skip silently */ }
  }

  /**
   * Single tick: read state, decide, act, log.
   */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    const startMs = Date.now();

    try {
      const agent = this.deps.db.getAgent(this.orchestratorId);
      if (!agent || agent.status !== 'active') {
        this.stop();
        return;
      }

      this._tickCount++;
      const uptimeMs = Date.now() - this._startTime;
      const uptimeSec = Math.floor(uptimeMs / 1000);

      // Pre-read guards: skip BEFORE reading inbox so messages aren't consumed and lost
      if (uptimeSec < 120) {
        console.log(`[Orchestrator ${this.orchestratorId}] Node stabilizing (${uptimeSec}s), skipping tick`);
        return;
      }

      const heapUsed = process.memoryUsage().heapUsed;
      if (heapUsed > 524288000) {
        const heapMB = Math.round(heapUsed / (1024 * 1024));
        console.warn(`[Orchestrator ${this.orchestratorId}] Memory pressure (${heapMB}mb), skipping tick`);
        this.dissolveIdleWorkers();
        return;
      }

      // 1. Read board and inbox (messages marked as read here)
      const board = this.readBoard();

      // 1a. Health monitoring (always Tier 1 — deterministic, no AI call)
      await this.runHealthMonitoring(board);

      // 2. Classify: Tier 1 (deterministic) or Tier 2 (AI judgment)
      const tier = this.classify(board);

      let actions: OrchestratorAction[] = [];
      let aiError: string | null = null;

      const inboxSummary = `msgs=${board.messages.length} reports=${board.workerReports.length} alerts=${board.healthAlerts.length} requests=${board.userRequests.length}`;
      console.log(`[Orchestrator ${this.orchestratorId}] Tick — Tier ${tier}, workers=${board.activeWorkers}/${board.maxWorkers}, ${inboxSummary}, uptime=${uptimeSec}s`);

      if (tier === 1) {
        // Tier 1: deterministic actions
        actions = this.deterministic(board, agent);
      } else {
        // Tier 2: call AI for judgment
        console.log(`[Orchestrator ${this.orchestratorId}] Calling AI...`);
        try {
          actions = await this.callAI(board, agent);
          console.log(`[Orchestrator ${this.orchestratorId}] AI returned ${actions.length} action(s): ${actions.map(a => a.type).join(', ') || 'none'}`);
        } catch (aiErr: any) {
          aiError = aiErr.message || 'Unknown AI error';
          console.error(`[Orchestrator ${this.orchestratorId}] AI call failed: ${aiError}`);
          // Messages already consumed — log the failure but don't return silently
          // The orchestrator will see the worker states on next tick
        }
      }

      // 3. Execute actions
      for (const action of actions) {
        try {
          const shouldContinue = await this.execute(action, agent);
          if (shouldContinue === false) {
            console.log(`[Orchestrator ${this.orchestratorId}] Action ${action.type} signaled stop — skipping remaining actions`);
            break;
          }
        } catch (err: any) {
          console.error(`[Orchestrator ${this.orchestratorId}] action error (${action.type}):`, err.message?.slice(0, 200));
        }
      }

      // 3b. Issue 6: Clear currentFocus if worker reports done/failed and no active workers remain
      if (board.workerReports.length > 0) {
        const hasDoneOrFailed = board.workerReports.some(r => {
          try { const p = JSON.parse(r.payload); return p.status === 'done' || p.status === 'failed'; } catch { return false; }
        });
        if (hasDoneOrFailed) {
          const remaining = this.deps.db.getActiveWorkers(this.orchestratorId);
          if (remaining.length === 0) {
            this.deps.db.clearCurrentFocus(this.orchestratorId);
          }
        }
      }

      // 3b2. Deploy URL fix: Auto-respond to user when devops worker reports success with a URL.
      // This is deterministic — no AI judgment needed. Prevents "Processing..." forever.
      if (board.workerReports.length > 0 && this._lastThreadId) {
        for (const report of board.workerReports) {
          try {
            const payload = JSON.parse(report.payload);
            if (payload.status !== 'done') continue;
            // Check if sender is a devops worker
            const worker = this.deps.db.getAgent(report.senderId);
            if (!worker || worker.role !== 'devops') continue;
            // Extract URL from summary
            const summary = payload.summary || '';
            const urlMatch = summary.match(/https?:\/\/[^\s)>"']+/);
            if (!urlMatch) continue;
            const deployUrl = urlMatch[0];
            // Check if AI already sent respond_to_user for this URL in this tick
            const alreadyResponded = actions.some(a =>
              a.type === 'respond_to_user' && a.message.includes(deployUrl));
            if (alreadyResponded) continue;
            // Send respond_to_user deterministically
            console.log(`[Orchestrator ${this.orchestratorId}] Auto-responding with deploy URL: ${deployUrl}`);
            await this.execute({ type: 'respond_to_user', message: `Deployment complete! Your app is live at: ${deployUrl}` }, agent);
          } catch { /* ignore parse errors */ }
        }
      }

      // 3c. Issue MASTER-FIX-2: Deactivate directives after successful Tier 2
      // Directives are standing orders — once the AI has seen them and produced
      // actions, they are consumed. This prevents the same directives from
      // triggering Tier 2 every single tick forever.
      if (tier === 2 && !aiError && board.directives.length > 0) {
        for (const d of board.directives) {
          this.deps.db.deactivateDirective(d.id);
        }
        console.log(`[Orchestrator ${this.orchestratorId}] Deactivated ${board.directives.length} directive(s) after Tier 2 tick`);
      }

      // 4. Reflect on any worker completions (extract lessons)
      for (const report of board.workerReports) {
        try {
          const payload = JSON.parse(report.payload);
          if (payload.status === 'done') {
            this.reflectOnCompletion(report.senderId, payload);
          }
        } catch { /* skip malformed */ }
      }

      // 5. Mark messages as read — but NOT if AI call failed (preserve for retry)
      const allMessageIds = [
        ...board.messages.map(m => m.id),
        ...board.workerReports.map(m => m.id),
        ...board.healthAlerts.map(m => m.id),
        ...board.userRequests.map(m => m.id),
        ...board.peerDisconnects.map(m => m.id),
      ];
      if (!aiError) {
        if (allMessageIds.length > 0) {
          this.deps.messageBus.markRead(allMessageIds);
          this.deps.db.updateAgent(this.orchestratorId, { lastReportAt: new Date().toISOString() });
        }
      } else {
        console.warn(`[Orchestrator ${this.orchestratorId}] AI failed — preserving ${allMessageIds.length} unread messages for retry`);
      }

      // 5. Log the tick
      const tickNumber = this.deps.db.getLatestTickNumber(this.orchestratorId) + 1;
      this.deps.db.logTick({
        orchestratorId: this.orchestratorId,
        tickNumber,
        tier,
        boardSnapshot: JSON.stringify({
          pendingTasks: board.pendingTasks,
          activeTasks: board.activeTasks,
          activeWorkers: board.activeWorkers,
          inboxCount: allMessageIds.length,
          inbox: inboxSummary,
        }),
        aiInput: tier === 2 ? inboxSummary : null,
        aiOutput: tier === 2 ? (aiError ? `ERROR: ${aiError}` : JSON.stringify(actions)) : null,
        actionsTaken: actions.length > 0 ? JSON.stringify(actions.map(a => a.type)) : null,
        durationMs: Date.now() - startMs,
      });

      // Phase 105: Periodic knowledge promotion (every 10th tick)
      if (tickNumber % 10 === 0) {
        try {
          const agent = this.deps.db.getAgent(this.orchestratorId);
          const lessons = this.deps.db.getLessons({
            orchestratorId: this.orchestratorId,
            minConfidence: 0.8,
            limit: 20,
          });
          for (const l of lessons) {
            if (l.timesUsed >= 3) {
              // Check if already in org_knowledge (dedup by text)
              const existing = this.deps.db.getOrgKnowledge({ category: agent?.role || 'general', limit: 100 });
              if (!existing.some(k => k.knowledge === l.lesson)) {
                this.deps.db.addOrgKnowledge({
                  category: agent?.role || 'general',
                  knowledge: l.lesson,
                  source: `promoted from ${this.orchestratorId}`,
                  relevanceTags: l.relevanceTags ? JSON.parse(l.relevanceTags) : undefined,
                });
              }
            }
          }
        } catch { /* non-fatal */ }
      }

      // Update last tick time
      this.deps.db.updateAgent(this.orchestratorId, { lastTickAt: new Date().toISOString() });

      // Check if a safe self-restart is pending (council orchestrator only)
      this.checkSafeRestart();

    } finally {
      this.ticking = false;
    }
  }

  // =========================================================================
  // State reading
  // =========================================================================

  private readBoard(): BoardState {
    const messages = this.deps.messageBus.read(this.orchestratorId);
    const activeWorkers = this.deps.db.getActiveWorkers(this.orchestratorId);
    const agent = this.deps.db.getAgent(this.orchestratorId)!;

    // Categorize messages
    const workerReports = messages.filter(m => m.type === 'worker_report');
    const healthAlerts = messages.filter(m => m.type === 'health_alert');
    const userRequests = messages.filter(m => m.type === 'user_request');
    const peerDisconnects = messages.filter(m => m.type === 'peer_disconnect');
    const interruptedMsgs = messages.filter(m => m.type === 'worker_interrupted');
    const otherMessages = messages.filter(m =>
      !['worker_report', 'health_alert', 'user_request', 'peer_disconnect', 'worker_interrupted'].includes(m.type));

    // Track threadId from user requests for respond_to_user
    for (const req of userRequests) {
      try {
        const payload = typeof req.payload === 'string' ? JSON.parse(req.payload) : req.payload;
        if (payload.threadId) {
          this._lastThreadId = payload.threadId;
          // Persist to SQLite so threadId survives node restarts
          this.deps.db.setMetadata(this.orchestratorId, JSON.stringify({ lastThreadId: payload.threadId }));
        }
      } catch { /* ignore */ }
    }

    // Get directives
    const directives = this.deps.db.getDirectives(this.orchestratorId);

    // Recently failed workers (last 15 minutes) under this orchestrator
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const allFailed = this.deps.db.listAgents({ type: 'worker', status: 'failed', parentId: this.orchestratorId });
    const recentlyFailed = allFailed
      .filter(w => (w.updatedAt || '') >= fifteenMinAgo)
      .map(w => ({
        id: w.id,
        role: w.role,
        failedAt: w.updatedAt || w.createdAt,
        lastTask: w.currentTaskId || null,
        rolePrompt: w.rolePrompt ? w.rolePrompt.slice(0, 200) : null,
      }));

    // Overdue workers: active >10 min with no lastReportAt update
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const overdueWorkers = activeWorkers
      .filter(w => {
        const spawnedLongAgo = (w.createdAt || '') < tenMinAgo;
        const noRecentReport = !w.lastReportAt || w.lastReportAt < tenMinAgo;
        return spawnedLongAgo && noRecentReport;
      })
      .map(w => ({
        id: w.id,
        role: w.role,
        spawnedAt: w.createdAt,
        lastReportAt: w.lastReportAt || null,
      }));

    // Parse interrupted worker notifications (from node restart)
    const interruptedWorkers = interruptedMsgs.map(m => {
      try {
        const p = JSON.parse(m.payload);
        return { workerId: p.workerId as string, role: p.role as string, rolePrompt: (p.rolePrompt as string) || null, sessionId: (p.sessionId as string) || null };
      } catch { return null; }
    }).filter(Boolean) as Array<{ workerId: string; role: string; rolePrompt: string | null; sessionId: string | null }>;

    return {
      pendingTasks: this.deps.db.listAgents({ parentId: this.orchestratorId, status: 'pending' }).length,
      activeTasks: activeWorkers.filter(w => w.currentTaskId).length,
      activeWorkers: activeWorkers.length,
      maxWorkers: agent.maxWorkers,
      messages: otherMessages,
      workerReports,
      healthAlerts,
      userRequests,
      peerDisconnects,
      directives: directives.map(d => ({ id: d.id, content: d.content })),
      recentlyFailed,
      overdueWorkers,
      interruptedWorkers,
    };
  }

  // =========================================================================
  // Classification
  // =========================================================================

  /**
   * Classify this tick as Tier 1 (deterministic, no AI call) or Tier 2 (needs AI).
   *
   * Phase 105: Worker reports are ALWAYS Tier 2. The AI brain is the manager —
   * it reads reports and decides what happens next (spawn QA, commit, deploy, retry).
   *
   * Proactive autonomy: directives and reflection ticks also trigger Tier 2,
   * so the council can self-improve without waiting for human input.
   */
  private classify(board: BoardState): 1 | 2 {
    // Issue 6: Workers are busy AND inbox is empty → let them work (Tier 1).
    // Non-overdue active workers means real work is happening. Don't burn Opus
    // tokens just because standing directives exist.
    const nonOverdueActive = board.activeWorkers - board.overdueWorkers.length;
    const inboxEmpty = board.workerReports.length === 0 &&
        board.healthAlerts.length === 0 &&
        board.userRequests.length === 0 &&
        board.messages.length === 0 &&
        board.interruptedWorkers.length === 0;
    if (nonOverdueActive > 0 && inboxEmpty) {
      return 1;
    }

    // Active directives = standing orders → think
    if (board.directives.length > 0) {
      return 2;
    }

    // Reflection tick — every 5th tick (~5 min), think proactively
    if (this._tickCount > 0 && this._tickCount % 5 === 0) {
      return 2;
    }

    // Recently failed or overdue workers need AI attention immediately
    if (board.recentlyFailed.length > 0 || board.overdueWorkers.length > 0) {
      return 2;
    }

    // Tier 1: Nothing to do — empty inbox, no directives, not reflection tick
    if (inboxEmpty) {
      return 1;
    }

    // Everything else: AI decides
    return 2;
  }

  // =========================================================================
  // Tier 1: Deterministic actions
  // =========================================================================

  /**
   * Tier 1: Only handles empty ticks. All real decisions go to AI (Tier 2).
   *
   * Phase 105: The AI brain IS the manager. It reads worker reports and decides
   * the next step — no hardcoded pipeline. The pipeline flow (builder → QA → deploy)
   * is described in the AI prompt as guidelines, not enforced by code.
   */
  private deterministic(_board: BoardState, _agent: AgentIdentity): OrchestratorAction[] {
    // Nothing to do — empty inbox was classified as Tier 1
    return [];
  }

  // =========================================================================
  // Tier 2: AI judgment
  // =========================================================================

  private async callAI(board: BoardState, agent: AgentIdentity): Promise<OrchestratorAction[]> {
    const backend = this.deps.aiRegistry.getBest('code-execution');
    if (!backend) {
      // Fallback to text-generation if no code-execution backend
      const textBackend = this.deps.aiRegistry.getBest('text-generation');
      if (!textBackend) throw new Error('Claude CLI not found.');
      // Legacy path: stateless text call (no session, no tools)
      const prompt = this.buildBootPrompt(board, agent);
      const result = await textBackend.execute({
        type: 'text',
        prompt,
        options: { model: 'claude-opus-4-6', noTools: true },
      });
      if (!result.success || !result.output) {
        throw new Error(result.error ?? 'AI backend returned no output');
      }
      return this.parseAIActions(result.output);
    }

    // Session-persistent path: boot prompt on first tick, tick update on subsequent
    const isBootTick = !this._sessionId;
    const prompt = isBootTick
      ? this.buildBootPrompt(board, agent)
      : this.buildTickUpdate(board, agent);

    if (isBootTick) {
      console.log(`[Orchestrator ${this.orchestratorId}] Boot tick — full prompt (${prompt.length} chars)`);
    } else {
      console.log(`[Orchestrator ${this.orchestratorId}] Tick update — session ${this._sessionId?.slice(0, 8)} (${prompt.length} chars)`);
    }

    const result = await backend.execute({
      type: 'code',
      prompt,
      sessionId: this._sessionId || undefined,
      options: {
        model: 'claude-opus-4-6',
        noTools: false,
        cwd: agent.workspaceDir || process.cwd(),
      },
    });

    // Save session ID for future ticks
    if (result.sessionId) {
      this._sessionId = result.sessionId;
      this.deps.db.updateAgent(this.orchestratorId, { sessionId: result.sessionId });
    }

    // Track cost
    if (result.cost) {
      const current = this.deps.db.getAgent(this.orchestratorId);
      if (current) {
        this.deps.db.updateAgent(this.orchestratorId, {
          budgetSpent: (current.budgetSpent || 0) + result.cost,
        });
      }
    }

    this._sessionTickCount++;

    if (!result.success || !result.output) {
      this._consecutiveParseFailures++;
      const detail = result.output || result.error || 'AI backend returned no output';
      console.log(`[Orchestrator ${this.orchestratorId}] AI failure detail: ${detail.slice(0, 500)}`);
      if (this._consecutiveParseFailures >= 2) {
        this.rotateSession('2 consecutive AI failures');
      }
      throw new Error(result.error ?? 'AI backend returned no output');
    }

    // Parse actions from AI output
    const actions = this.parseAIActions(result.output);

    // Session rotation checks
    if (this._sessionTickCount >= Orchestrator.SESSION_ROTATION_TICKS) {
      this.rotateSession(`reached ${Orchestrator.SESSION_ROTATION_TICKS} ticks`);
    }

    // Track empty ticks for session health
    if (actions.length === 0) {
      this._consecutiveEmptyTicks++;
      // If 5 empty ticks but there are pending user requests, session may be confused
      if (this._consecutiveEmptyTicks >= 5 && board.userRequests.length > 0) {
        this.rotateSession('5 empty ticks with pending user requests');
      }
    } else {
      this._consecutiveEmptyTicks = 0;
    }

    this._consecutiveParseFailures = 0;
    return actions;
  }

  /**
   * Rotate session: clear session ID so next tick gets a fresh boot prompt.
   */
  private rotateSession(reason: string): void {
    console.log(`[Orchestrator ${this.orchestratorId}] Session rotation: ${reason} (was session ${this._sessionId?.slice(0, 8) || 'none'}, ${this._sessionTickCount} ticks)`);
    this._sessionId = null;
    this._sessionTickCount = 0;
    this._consecutiveEmptyTicks = 0;
    this._consecutiveParseFailures = 0;
  }

  /** Extract project ID from user requests if they reference a known project. */
  private extractProjectId(requests: InboxMessage[]): string | null {
    for (const msg of requests) {
      try {
        const payload = JSON.parse(msg.payload);
        if (payload.projectId) return payload.projectId;
        if (payload.context?.projectId) return payload.context.projectId;
      } catch { /* skip */ }
    }
    return null;
  }

  // =========================================================================
  // Prompt building (3-method split)
  // =========================================================================

  /**
   * Build the full boot prompt for the first tick of a session.
   * Contains all instructions, available actions, decision guide, and current board state.
   */
  private buildBootPrompt(board: BoardState, agent: AgentIdentity): string {
    const sections: string[] = [];

    sections.push(`# ROLE: Manager for orchestrator "${agent.role}" (${this.orchestratorId})`);
    sections.push('');
    sections.push('You are a SESSION-PERSISTENT manager. Your Claude Code session survives across ticks —');
    sections.push('you remember previous decisions, worker reports, and context from earlier ticks.');
    sections.push('You are called every ~60 seconds with a board-state update.');
    sections.push('');
    sections.push('You are the MANAGER of this team. You read reports from your workers, assess the situation, and decide what happens next.');
    sections.push('You do NOT do work yourself — you delegate to specialized workers.');
    sections.push('');

    // Manager template rolePrompt (if available)
    if (agent.templateId && this.deps.templateRegistry) {
      const tmpl = this.deps.templateRegistry.getTemplate(agent.templateId);
      if (tmpl?.rolePrompt) {
        sections.push('## Manager Instructions');
        sections.push(tmpl.rolePrompt);
        sections.push('');
      }
    } else {
      // Inline rules if no template
      sections.push('## CRITICAL RULES');
      sections.push('1. You MUST NOT write, edit, or create any code files. You are a manager, not a developer.');
      sections.push('2. You CAN read files (Read, Glob, Grep) to understand the codebase before making decisions.');
      sections.push('3. You CAN run non-destructive Bash commands (git log, git status, ls) for investigation.');
      sections.push('4. You MUST NOT run destructive commands (rm, git reset, npm install, etc.).');
      sections.push('5. For ANY code change, spawn a "builder" worker.');
      sections.push('6. For verification, spawn a "tester" worker.');
      sections.push('7. For deployment, spawn a "devops" worker.');
      sections.push('');
    }

    // Available actions
    this.appendAvailableActions(sections, agent);

    // Decision guide
    this.appendDecisionGuide(sections, agent);

    // Current board state
    this.appendBoardState(sections, board, agent);

    sections.push('After any reasoning or investigation, output your actions as the LAST thing in a markdown code fence:');
    sections.push('```json');
    sections.push('[{"type":"spawn_worker","role":"builder","rolePrompt":"Build a landing page with..."}]');
    sections.push('```');
    sections.push('If nothing needs to be done:');
    sections.push('```json');
    sections.push('[]');
    sections.push('```');

    return sections.join('\n');
  }

  /**
   * Build a short tick update for resumed sessions.
   * The AI already has full instructions from the boot prompt.
   */
  private buildTickUpdate(board: BoardState, agent: AgentIdentity): string {
    const sections: string[] = [];

    sections.push(`--- TICK UPDATE (tick ${this._sessionTickCount + 1}, ${new Date().toISOString()}) ---`);
    sections.push('');

    // Current board state
    this.appendBoardState(sections, board, agent);

    sections.push('Respond with your JSON array of actions in a code fence. If nothing to do:');
    sections.push('```json');
    sections.push('[]');
    sections.push('```');

    return sections.join('\n');
  }

  /**
   * Append board state sections (shared between boot prompt and tick update).
   */
  private appendBoardState(sections: string[], board: BoardState, agent: AgentIdentity): void {
    // Issue 6: Current focus — remind AI what it's working on
    const currentFocus = this.deps.db.getCurrentFocus(this.orchestratorId);
    if (currentFocus) {
      sections.push('## Current Focus');
      sections.push(currentFocus);
      sections.push('Finish this before starting anything new.');
      sections.push('');
    }

    // Board state counts
    sections.push('## Current State');
    sections.push(`Active workers: ${board.activeWorkers}/${board.maxWorkers}`);
    sections.push(`Active tasks: ${board.activeTasks}`);
    sections.push(`Pending tasks: ${board.pendingTasks}`);
    sections.push('');

    // Full team roster
    {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const fifteenMinAgo2 = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const allTeamWorkers = this.deps.db.listAgents({ type: 'worker', parentId: this.orchestratorId });
      const rosterWorkers = allTeamWorkers.filter(w => {
        if (w.status === 'active') return true;
        if ((w.updatedAt || w.createdAt || '') >= fifteenMinAgo2) return true;
        return (w.createdAt || '') >= twoHoursAgo;
      });
      if (rosterWorkers.length > 0) {
        sections.push('## Your Team');
        const now = Date.now();
        for (const w of rosterWorkers) {
          const spawnedMs = w.createdAt ? new Date(w.createdAt).getTime() : now;
          const ageMin = Math.round((now - spawnedMs) / 60000);
          const ageStr = ageMin < 60 ? `${ageMin}min ago` : `${Math.round(ageMin / 60)}h ago`;
          const lastReport = w.lastReportAt
            ? new Date(w.lastReportAt).toISOString().slice(11, 16)
            : 'never';
          const taskSnippet = w.rolePrompt
            ? w.rolePrompt.replace(/\n/g, ' ').slice(0, 80)
            : (w.currentTaskId || 'no task');
          sections.push(`- ${w.role} ${w.id}: ${w.status.toUpperCase()} (spawned ${ageStr}, last report: ${lastReport}) — ${taskSnippet}`);
        }
        sections.push('');
      }
    }

    // Recently failed workers + consecutive failure tracking
    if (board.recentlyFailed.length > 0) {
      sections.push('## Recently Failed Workers');
      const failCountByRole: Record<string, number> = {};
      for (const w of board.recentlyFailed) {
        failCountByRole[w.role] = (failCountByRole[w.role] || 0) + 1;
        const task = w.rolePrompt ? w.rolePrompt.replace(/\n/g, ' ').slice(0, 120) : (w.lastTask || 'unknown task');
        sections.push(`- ${w.role} ${w.id} failed at ${w.failedAt}. Was working on: ${task}`);
      }
      // Warn about roles with repeated failures
      for (const [role, count] of Object.entries(failCountByRole)) {
        if (count >= 3) {
          sections.push(`\n⚠️ WARNING: ${role} has failed ${count} times recently. Consider: fresh session (kill old worker first), different approach, or simpler scope.`);
        }
      }
      sections.push('');
    }

    // Overdue workers
    if (board.overdueWorkers.length > 0) {
      sections.push('## Overdue Workers (No Report in >10 min)');
      for (const w of board.overdueWorkers) {
        sections.push(`- ${w.role} ${w.id} spawned at ${w.spawnedAt}, last report: ${w.lastReportAt || 'never'}`);
      }
      sections.push('Consider: kill and respawn, or wait longer.');
      sections.push('');
    }

    // Interrupted workers (killed during node restart)
    if (board.interruptedWorkers.length > 0) {
      sections.push('## Interrupted Workers (killed during restart)');
      sections.push('These workers were active when the node restarted. Consider re-spawning them.');
      for (const w of board.interruptedWorkers) {
        const task = w.rolePrompt ? w.rolePrompt.replace(/\n/g, ' ').slice(0, 120) : 'unknown task';
        sections.push(`- ${w.role} ${w.workerId}: was working on: ${task}`);
      }
      sections.push('');
    }

    // Worker reports
    if (board.workerReports.length > 0) {
      sections.push('## Worker Reports');
      for (const report of board.workerReports) {
        try {
          const payload = JSON.parse(report.payload);
          sections.push(`- Worker ${report.senderId}: status=${payload.status}, summary="${payload.summary}"`);
          if (payload.difficulties?.length) sections.push(`  Difficulties: ${payload.difficulties.join(', ')}`);
          if (payload.error) sections.push(`  Error: ${payload.error}`);
        } catch { sections.push(`- Worker ${report.senderId}: (malformed report)`); }
      }
      sections.push('');
    }

    // Health alerts
    if (board.healthAlerts.length > 0) {
      sections.push('## Health Alerts');
      for (const alert of board.healthAlerts) {
        try {
          const payload = JSON.parse(alert.payload);
          sections.push(`- ${payload.severity || 'info'}: ${payload.message || alert.payload}`);
        } catch { sections.push(`- ${alert.payload}`); }
      }
      sections.push('');
    }

    // User requests
    if (board.userRequests.length > 0) {
      sections.push('## User Requests');
      for (const req of board.userRequests) {
        try {
          const payload = JSON.parse(req.payload);
          sections.push(`- From ${req.senderId}: "${payload.message || payload.content || req.payload}"`);
        } catch { sections.push(`- From ${req.senderId}: ${req.payload}`); }
      }
      sections.push('');
    }

    // Other messages
    if (board.messages.length > 0) {
      sections.push('## Other Messages');
      for (const msg of board.messages) {
        sections.push(`- From ${msg.senderId} (${msg.type}): ${msg.payload}`);
      }
      sections.push('');
    }

    // Directives
    if (board.directives.length > 0) {
      sections.push('## Directives');
      for (const d of board.directives) {
        sections.push(`- ${d.content}`);
      }
      sections.push('');
    }

    // Lessons learned
    try {
      const lessons = this.deps.db.getLessons({
        orchestratorId: this.orchestratorId,
        minConfidence: 0.5,
        limit: 15,
      });
      if (lessons.length > 0) {
        sections.push('## Lessons Learned (from past decisions)');
        for (const l of lessons) {
          sections.push(`- [${l.source || 'experience'}] ${l.lesson}`);
        }
        sections.push('');
      }
      const orgKnowledge = this.deps.db.getOrgKnowledge({ category: agent.role, limit: 10 });
      if (orgKnowledge.length > 0) {
        sections.push('## Organizational Knowledge');
        for (const k of orgKnowledge) {
          sections.push(`- ${k.knowledge}`);
        }
        sections.push('');
      }
    } catch { /* non-fatal */ }

    // Genome architecture knowledge
    const requestText = board.userRequests.length > 0
      ? board.userRequests.map(r => {
          try { return JSON.parse(r.payload).message || r.payload; } catch { return r.payload; }
        }).join(' ')
      : 'platform maintenance, self-improvement, and issue resolution';

    let activeGenomeBridge = this.deps.genomeBridge || null;
    if (this.deps.genomeBridgeRegistry && agent.projectId) {
      const projectBridge = this.deps.genomeBridgeRegistry.getForProject(agent.projectId);
      if (projectBridge?.isLoaded()) activeGenomeBridge = projectBridge;
    }

    if (activeGenomeBridge?.isLoaded()) {
      const ctx = activeGenomeBridge.contextForTask({ taskDescription: requestText });
      if (ctx) {
        sections.push('## Architecture Knowledge');
        sections.push(ctx);
        sections.push('');
      }
      const failing = activeGenomeBridge.failingTests();
      if (failing.length > 0) {
        sections.push(`### Failing Tests (${failing.length}):`);
        for (const t of failing) {
          sections.push(`- ${t._name}: ${t.description || ''}`);
        }
        sections.push('');
      }
    }

    // Project discoveries
    if (agent.projectId) {
      try {
        const discoveries = this.deps.db.getDiscoveries({ projectId: agent.projectId, limit: 10 });
        if (discoveries.length > 0) {
          sections.push('## Project Discoveries (from workers)');
          for (const d of discoveries) {
            sections.push(`- [${d.category}] ${d.content} (confidence: ${d.confidence.toFixed(1)})`);
          }
          sections.push('');
        }
      } catch { /* non-fatal */ }
    }

    // Role prompt
    if (agent.rolePrompt) {
      sections.push('## Your Role');
      sections.push(agent.rolePrompt);
      sections.push('');
    }

    // Proactive mode hint
    const isProactive = board.workerReports.length === 0 &&
        board.healthAlerts.length === 0 &&
        board.userRequests.length === 0 &&
        board.messages.length === 0;
    if (isProactive) {
      sections.push('## Proactive Mode — You Are Autonomous');
      sections.push('');
      sections.push('Your inbox is empty. This is a REFLECTION tick — you are not waiting for instructions.');
      sections.push('');
      sections.push('Review and act on:');
      sections.push('1. **Directives** (above): Standing orders from the team. Execute them by spawning workers.');
      sections.push('2. **Failing tests**: If any tests above are failing, spawn a builder to fix them.');
      sections.push('3. **Lessons with recurring problems**: Spawn a researcher to investigate root causes.');
      sections.push('4. **Platform health**: Any degraded services? Spawn a builder to fix.');
      sections.push('5. **Architecture improvements**: Any gaps or tech debt you can identify?');
      sections.push('');
      if (board.recentlyFailed.length > 0) {
        sections.push('Recently failed workers (see above) may have left partial work on disk (uncommitted files, half-written code).');
        sections.push('Before re-attempting their tasks from scratch, check git status to see what is already done.');
        sections.push('This avoids duplicating work and ensures partial progress is not lost.');
        sections.push('');
      }
      sections.push('You are the autonomous manager of this node. Don\'t wait for humans — lead.');
      sections.push('Only return [] if you have genuinely reviewed everything and there is nothing to improve.');
      sections.push('');
    }
  }

  /**
   * Append available actions section (used in boot prompt only).
   */
  private appendAvailableActions(sections: string[], agent: AgentIdentity): void {
    // Available roles from TemplateRegistry
    const availableRoles: string[] = ['builder', 'tester', 'reviewer', 'researcher', 'devops'];
    if (this.deps.templateRegistry) {
      const templates = this.deps.templateRegistry.listTemplates({ status: 'active' });
      const roles = [...new Set(templates.map(t => t.role))].filter(r => r !== 'manager');
      if (roles.length > 0) availableRoles.splice(0, availableRoles.length, ...roles);
    }

    sections.push('## Available Actions');
    sections.push('');
    sections.push('Each action is a JSON object with a "type" field. Return an array of actions.');
    sections.push('');
    sections.push('### For spawning workers (ALWAYS use these for any real work):');
    sections.push(`Available roles: ${availableRoles.join(', ')}`);
    sections.push('- spawn_worker: Spawn a Claude Code worker');
    sections.push('  { "type": "spawn_worker", "role": "<role>", "rolePrompt": "description of the task" }');
    sections.push('  Common: role="builder" for code, role="tester" for QA, role="devops" for deployment');
    sections.push('- kill_worker: Stop a worker');
    sections.push('  { "type": "kill_worker", "workerId": "worker-builder-abc123" }');
    sections.push('');
    sections.push('### For team management:');
    sections.push('- create_team: Create a child orchestrator (sub-team) for a specific domain');
    sections.push('  { "type": "create_team", "role": "qa-team", "rolePrompt": "You manage QA for this project..." }');
    sections.push('  Use when a task is complex enough to need its own manager (e.g., separate QA team, separate frontend team)');
    sections.push('- dissolve_team: Remove a child orchestrator');
    sections.push('  { "type": "dissolve_team", "orchestratorId": "orch-qa-team-abc123" }');
    sections.push('- create_task: Track a task internally');
    sections.push('  { "type": "create_task", "title": "...", "description": "...", "priority": 1 }');
    sections.push('- record_lesson: Save an insight for future reference');
    sections.push('  { "type": "record_lesson", "lesson": "...", "source": "..." }');
    sections.push('- escalate: Escalate to your parent orchestrator');
    sections.push('  { "type": "escalate", "message": "..." }');
    sections.push('');
    sections.push('### For communication:');
    sections.push('- respond_to_user: Reply to a user request');
    sections.push('  { "type": "respond_to_user", "message": "your reply" }');
    sections.push('- send_message: Message another orchestrator');
    sections.push('  { "type": "send_message", "recipientId": "...", "message": "..." }');
    if (this.deps.onPropose) {
      sections.push('');
      sections.push('### For governance:');
      sections.push('- propose_upgrade: { "type": "propose_upgrade", "title": "...", "description": "..." }');
    }
    if (this.deps.onCommit) {
      sections.push('- commit_code: Commit current changes to git');
      sections.push('  { "type": "commit_code", "message": "commit message" }');
    }
    sections.push('');
  }

  /**
   * Append decision guide section (used in boot prompt only).
   */
  private appendDecisionGuide(sections: string[], agent: AgentIdentity): void {
    const apiPort = this.deps.apiPort || 4000;
    const dataDir = this.deps.dataDir || '~/.pando';

    sections.push('## Decision Guide — You Are The Manager');
    sections.push('');
    sections.push('### Standard Pipeline (build request):');
    sections.push('1. User asks to build something → spawn "builder" with detailed rolePrompt');
    sections.push('2. Builder reports "done" → spawn "tester" to verify (include the builder\'s summary so tester knows what to check)');
    sections.push('3. Tester reports PASS → commit_code, then spawn "devops" to deploy');
    sections.push('4. Tester reports FAIL → spawn "builder" again with the failure details so it can fix');
    sections.push('5. DevOps reports deploy success → respond_to_user with the live URL');
    sections.push('6. DevOps reports deploy failure → decide: retry devops? spawn builder to fix? escalate?');
    sections.push('');
    sections.push('### Scaling Up (complex projects):');
    sections.push('- Large task with multiple parts? Use create_team to spawn a sub-team orchestrator for each domain (frontend, backend, etc.)');
    sections.push('- Each sub-team gets its own workers, its own QA, its own lessons. You coordinate across teams.');
    sections.push('- Sub-team reports back to you. You decide when ALL teams are done before proceeding to deploy.');
    sections.push('');
    // Council-specific pipeline
    if (agent.role === 'council' && this.deps.onPropose) {
      sections.push('### Council Pipeline (you are the council):');
      sections.push('When a builder reports code changes:');
      sections.push('- For complex changes: spawn "tester" to QA before committing.');
      sections.push('- For trivial changes (one-line fix, color change): you may skip QA — governance will review.');
      sections.push('- ALWAYS commit_code when a builder makes changes. Never leave code uncommitted.');
      sections.push('- ALWAYS propose_upgrade after committing. This triggers governance + all-node upgrade.');
      sections.push('- respond_to_user AFTER commit + propose_upgrade to confirm the change is deployed.');
      sections.push('The minimum for any code change: builder → commit_code → propose_upgrade → respond_to_user.');
      sections.push('');
      sections.push('### CRITICAL: Governance IS Deployment');
      sections.push('propose_upgrade IS the deployment mechanism. After you call propose_upgrade:');
      sections.push('1. All nodes vote on the proposal via governance');
      sections.push('2. If approved, every node auto-pulls the code, rebuilds, and restarts (via upgrade-protocol catch-up timer, every 5 min)');
      sections.push('3. You do NOT need to deploy manually. DO NOT spawn devops workers to SSH into nodes after propose_upgrade.');
      sections.push('4. Manual devops deployment is ONLY for: emergency fixes when governance is broken, or a specific node that is unreachable by P2P.');
      sections.push('');
      sections.push('WRONG: commit_code → propose_upgrade → spawn devops to SSH deploy to each node');
      sections.push('RIGHT: commit_code → propose_upgrade → DONE. Governance handles the rest.');
      sections.push('');
    }
    sections.push('## Focus Principle — One Task At A Time');
    sections.push('You must focus on ONE task at a time. Do not start unrelated tasks while current work is in progress.');
    sections.push('1. Pick the HIGHEST PRIORITY item (user request > failing test > directive)');
    sections.push('2. Spawn all workers needed for THAT ONE TASK (builder + tester + devops for same task = fine)');
    sections.push('3. Complete it fully: build → test → commit → deploy → verify');
    sections.push('4. THEN pick the next task');
    sections.push('');
    sections.push('DO NOT:');
    sections.push('- Spawn two builders for the same task (duplicate work, file conflicts)');
    sections.push('- Start a new unrelated task while the current one is in progress');
    sections.push('- Deploy one feature while building the next unrelated feature');
    sections.push('');
    sections.push('DO:');
    sections.push('- Multiple workers on the SAME task');
    sections.push('- Queue work mentally — note what needs doing, execute sequentially');
    sections.push('- Finish completely before moving on');
    sections.push('');
    sections.push('### Key Decisions (use your judgment):');
    sections.push('- Builder reports code changes? At minimum: commit_code the changes. For important changes, QA first.');
    sections.push('- Multiple workers reporting? Read ALL reports before deciding next step.');
    sections.push('- QA failed multiple times? record_lesson with the pattern, then try a different approach or escalate.');
    sections.push('- Health alert? Assess severity. Critical → spawn builder. Minor → record_lesson.');
    sections.push('- Simple question with no code needed? respond_to_user directly.');
    sections.push('- Check "Lessons Learned" above — avoid repeating past mistakes.');
    sections.push('- Inbox empty on a reflection tick? Review directives, failing tests, and lessons — proactively fix issues.');
    sections.push('- Only return [] if you have reviewed everything and there is genuinely nothing to improve.');
    sections.push('- When genome-updater reports done, commit_code the .know changes, then propose_upgrade. Genome-only commits will NOT trigger another genome-updater (no recursion).');
    sections.push('');
    if (agent.projectId) {
      sections.push('### Deployment Context (for devops worker):');
      sections.push(`When spawning devops, include this in the rolePrompt:`);
      sections.push(`- Project ID: ${agent.projectId}`);
      sections.push(`- API: http://127.0.0.1:${apiPort}`);
      sections.push(`- Deploy endpoint: POST /v1/projects/${agent.projectId}/deploy with body {"workspaceDir":"${agent.workspaceDir || ''}"}`);
      sections.push(`- Validate endpoint: POST /v1/projects/${agent.projectId}/validate-deploy`);
      sections.push(`- Auth token file: ${dataDir}/api-token`);
      sections.push('');
    }
  }

  /**
   * Parse AI actions from output that may contain text + tool results + JSON.
   * 3-layer parser: pure JSON → code fence → backward bracket scan.
   */
  private parseAIActions(output: string): OrchestratorAction[] {
    // Layer 1: Try pure JSON array (quick path)
    try {
      const trimmed = output.trim();
      if (trimmed.startsWith('[')) {
        const actions = JSON.parse(trimmed);
        if (Array.isArray(actions)) {
          const valid = actions.filter((a: any) => a && typeof a.type === 'string') as OrchestratorAction[];
          this._consecutiveParseFailures = 0;
          return valid;
        }
      }
    } catch { /* not pure JSON */ }

    // Layer 2: Extract from last markdown code fence (```json [...] ```)
    const fenceMatches = [...output.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
    if (fenceMatches.length > 0) {
      // Use the LAST fence (AI may have multiple code blocks, actions are at the end)
      const lastFence = fenceMatches[fenceMatches.length - 1][1].trim();
      try {
        const actions = JSON.parse(lastFence);
        if (Array.isArray(actions)) {
          const valid = actions.filter((a: any) => a && typeof a.type === 'string') as OrchestratorAction[];
          this._consecutiveParseFailures = 0;
          return valid;
        }
      } catch { /* fence content not valid JSON */ }
    }

    // Layer 3: Backward scan for last balanced [...] in output
    try {
      const lastBracket = output.lastIndexOf(']');
      if (lastBracket !== -1) {
        // Walk backwards to find the matching opening bracket
        let depth = 0;
        let start = -1;
        for (let i = lastBracket; i >= 0; i--) {
          if (output[i] === ']') depth++;
          if (output[i] === '[') depth--;
          if (depth === 0) { start = i; break; }
        }
        if (start !== -1) {
          const jsonStr = output.slice(start, lastBracket + 1);
          const actions = JSON.parse(jsonStr);
          if (Array.isArray(actions)) {
            const valid = actions.filter((a: any) => a && typeof a.type === 'string') as OrchestratorAction[];
            this._consecutiveParseFailures = 0;
            return valid;
          }
        }
      }
    } catch { /* backward scan failed */ }

    // All layers failed
    this._consecutiveParseFailures++;
    console.error(`[Orchestrator ${this.orchestratorId}] Failed to parse AI actions (attempt ${this._consecutiveParseFailures}):`, output.slice(0, 300));
    return [];
  }

  // =========================================================================
  // Action execution
  // =========================================================================

  private async execute(action: OrchestratorAction, agent: AgentIdentity): Promise<void | false> {
    switch (action.type) {
      case 'spawn_worker': {
        const workerId = await this.deps.workerPool.spawn({
          role: action.role,
          templateId: action.templateId,               // Phase 105: template reference
          orchestratorId: this.orchestratorId,
          taskId: action.taskId,
          projectId: agent.projectId || undefined,
          scope: agent.scope as any,
          fileScope: action.fileScope,
          rolePrompt: action.rolePrompt,
          workspaceDir: agent.workspaceDir || undefined,  // Phase 104: project workspace
        });
        console.log(`[Orchestrator ${this.orchestratorId}] Spawned ${action.role} worker: ${workerId}`);
        // Change 4: Update lastActivityAt when spawning workers (for idle orchestrator detection)
        this.deps.db.updateAgent(this.orchestratorId, { lastReportAt: new Date().toISOString() });
        // Issue 6: Set current focus so classify() knows work is in progress
        const focusDesc = action.rolePrompt ? action.rolePrompt.replace(/\n/g, ' ').slice(0, 100) : action.role;
        this.deps.db.setCurrentFocus(this.orchestratorId, `${action.role}: ${focusDesc}`);
        break;
      }

      case 'kill_worker': {
        this.deps.workerPool.kill(action.workerId);
        console.log(`[Orchestrator ${this.orchestratorId}] Killed worker: ${action.workerId}`);
        break;
      }

      case 'create_task': {
        // For now, tasks are tracked via the existing task system
        // The orchestrator notes the task in a message to itself
        console.log(`[Orchestrator ${this.orchestratorId}] Task created: ${action.title}`);
        break;
      }

      case 'assign_task': {
        this.deps.db.updateAgent(action.workerId, { currentTaskId: action.taskId });
        break;
      }

      case 'send_message': {
        this.deps.messageBus.send({
          recipientId: action.recipientId,
          senderId: this.orchestratorId,
          senderType: 'orchestrator',
          type: 'cross_team',
          payload: { message: action.message },
        });
        break;
      }

      case 'create_team': {
        const teamId = this.deps.orgManager.createOrchestrator({
          role: action.role,
          parentId: this.orchestratorId,
          scope: agent.scope as any,
          rolePrompt: action.rolePrompt,
        });
        console.log(`[Orchestrator ${this.orchestratorId}] Created team: ${teamId}`);
        break;
      }

      case 'dissolve_team': {
        this.deps.orgManager.dissolve(action.orchestratorId);
        break;
      }

      case 'record_lesson': {
        this.deps.db.addLesson({
          orchestratorId: this.orchestratorId,
          projectId: agent.projectId || undefined,
          lesson: action.lesson,
          source: action.source,
          relevanceTags: action.tags,
        });
        break;
      }

      case 'escalate': {
        if (agent.parentId) {
          this.deps.messageBus.send({
            recipientId: agent.parentId,
            senderId: this.orchestratorId,
            senderType: 'orchestrator',
            type: 'escalation',
            payload: { message: action.message },
            priority: 0, // critical
          });
        }
        break;
      }

      case 'propose_upgrade': {
        if (this.deps.onPropose) {
          await this.deps.onPropose(action.title, action.description);
        }
        break;
      }

      case 'commit_code': {
        if (this.deps.onCommit) {
          const success = await this.deps.onCommit(action.message);
          if (!success) {
            console.log(`[Orchestrator ${this.orchestratorId}] commit_code failed — skipping remaining actions`);
            return false;
          }
        }
        break;
      }

      case 'respond_to_user': {
        console.log(`[Orchestrator ${this.orchestratorId}] → User: ${action.message}`);
        // Write response to ThreadStore so it appears in the chat UI
        if (this.deps.threadStore && this._lastThreadId) {
          try {
            await this.deps.threadStore.addMessage(this._lastThreadId, {
              role: 'assistant',
              content: action.message,
              timestamp: Date.now(),
            });
          } catch (err: any) {
            console.warn(`[Orchestrator ${this.orchestratorId}] ThreadStore write failed: ${err.message?.slice(0, 100)}`);
          }
        }
        // Push SSE event so gateway updates in real-time (no page refresh needed)
        if (this.deps.pushEvent && this._lastThreadId) {
          this.deps.pushEvent('chat_message', {
            threadId: this._lastThreadId,
            role: 'assistant',
            content: action.message,
            timestamp: Date.now(),
          });
        }
        // Also store in MessageBus for API polling fallback
        this.deps.db.sendMessage({
          recipientId: 'user',
          senderId: this.orchestratorId,
          senderType: 'orchestrator',
          type: 'worker_report',
          payload: JSON.stringify({ message: action.message }),
          priority: 1,
        });
        break;
      }

      case 'run_scenarios': {
        // Run genome-based scenario tests (regression after upgrades)
        if (this.deps.scenarioRunner) {
          try {
            const cat = action.category || 'api';
            console.log(`[Orchestrator ${this.orchestratorId}] Running ${cat} scenarios...`);
            const result = await this.deps.scenarioRunner.runCategory(cat);
            this.deps.scenarioRunner.saveResults(result as any);
            console.log(`[Orchestrator ${this.orchestratorId}] Scenarios: ${result.passed}/${result.total} passed, ${result.failed} failed`);

            if (result.failed > 0) {
              // Alert orchestrator about regression failures
              this.deps.messageBus.send({
                recipientId: this.orchestratorId,
                senderId: 'scenario-runner',
                senderType: 'system' as any,
                type: 'health_alert',
                payload: {
                  severity: 'warning',
                  message: `Scenario regression: ${result.failed}/${result.total} failed after upgrade`,
                },
                priority: 0,
              });
            }
          } catch (err: any) {
            console.error(`[Orchestrator ${this.orchestratorId}] Scenario run error:`, err.message?.slice(0, 200));
          }
        }
        break;
      }
    }
  }

  // =========================================================================
  // Memory pressure helpers
  // =========================================================================

  /**
   * Change 1: Dissolve workers with no active task (called under memory pressure).
   */
  private dissolveIdleWorkers(): void {
    const workers = this.deps.db.getActiveWorkers(this.orchestratorId);
    let killed = 0;
    for (const worker of workers) {
      if (!worker.currentTaskId) {
        this.deps.workerPool.kill(worker.id);
        killed++;
      }
    }
    if (killed > 0) {
      console.log(`[Orchestrator ${this.orchestratorId}] Dissolved ${killed} idle worker(s) due to memory pressure`);
    }
  }

  // =========================================================================
  // Health Monitoring (Tier 1 — deterministic, no AI call)
  // =========================================================================

  /**
   * Run health monitoring on every tick. Always Tier 1 — no AI call.
   * Processes health_alert and peer_disconnect messages, plus periodic self-check.
   */
  private async runHealthMonitoring(board: BoardState): Promise<void> {
    // Process health_alert messages
    for (const alertMsg of board.healthAlerts) {
      try {
        const payload = JSON.parse(alertMsg.payload);
        const alertType = payload.alertType || payload.type || '';
        const message = payload.message || alertMsg.payload;
        const severity = payload.severity || 'info';

        console.log(`[Orchestrator ${this.orchestratorId}] Health alert [${severity}] ${alertType}: ${message}`);

        if (alertType === 'high_memory_usage' || message.toLowerCase().includes('memory')) {
          await this.handleHighMemoryAlert(payload);
        }
      } catch { /* skip malformed */ }
    }

    // Process peer_disconnect messages
    for (const msg of board.peerDisconnects) {
      try {
        const payload = JSON.parse(msg.payload);
        const peerId = payload.peerId || payload.peer || msg.senderId;
        console.log(`[Orchestrator ${this.orchestratorId}] Peer disconnected: ${peerId}`);

        // Check if the peer was a compute node (shareCompute: true)
        const isCompute = payload.shareCompute === true ||
          payload.capabilities?.shareCompute === true;
        if (isCompute) {
          console.warn(`[Orchestrator ${this.orchestratorId}] WARNING: Compute node ${peerId} disconnected — active deployments on that node may be affected`);
        }
      } catch { /* skip malformed */ }
    }

    // Periodic self-check every 10th tick (~10 minutes at 60s interval)
    if (this._tickCount > 0 && this._tickCount % 10 === 0) {
      await this.runPeriodicSelfCheck();
    }
  }

  /**
   * Handle a high_memory_usage alert: dissolve idle orchestrators.
   */
  private async handleHighMemoryAlert(_payload: any): Promise<void> {
    const allOrchestrators = this.deps.db.listAgents({ type: 'orchestrator', status: 'active' });
    const allWorkers = this.deps.db.listAgents({ type: 'worker', status: 'active' });
    console.log(`[Orchestrator ${this.orchestratorId}] High memory alert: ${allOrchestrators.length} active orchestrators, ${allWorkers.length} active workers`);

    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    let dissolved = 0;

    for (const orch of allOrchestrators) {
      if (orch.id === this.orchestratorId) continue; // never dissolve self
      const workers = this.deps.db.getActiveWorkers(orch.id);
      const isIdle = workers.length === 0 &&
        (!orch.lastTickAt || orch.lastTickAt < thirtyMinAgo);

      if (isIdle) {
        console.log(`[Orchestrator ${this.orchestratorId}] Dissolving idle orchestrator ${orch.id} (role=${orch.role}) due to high memory`);
        this.deps.orgManager.dissolve(orch.id);
        dissolved++;
      }
    }

    if (dissolved > 0) {
      console.log(`[Orchestrator ${this.orchestratorId}] High memory: dissolved ${dissolved} idle orchestrator(s)`);
    } else {
      console.log(`[Orchestrator ${this.orchestratorId}] High memory: no idle orchestrators to dissolve`);
    }
  }

  /**
   * Periodic self-check (every 10th tick):
   * - Log memory + worker stats
   * - Dissolve stale orchestrators (no workers, no messages in 60 min)
   * - Initiate OOM prevention if RSS > 1.5GB
   */
  private async runPeriodicSelfCheck(): Promise<void> {
    const HIGH_MEMORY_BYTES = 1.5 * 1024 * 1024 * 1024;  // 1.5 GB RSS
    const CRITICAL_MEMORY_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB RSS

    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / (1024 * 1024));
    const myWorkers = this.deps.db.getActiveWorkers(this.orchestratorId);
    const activeTasks = myWorkers.filter(w => w.currentTaskId).length;

    console.log(`[Orchestrator ${this.orchestratorId}] Self-check (tick=${this._tickCount}): RSS=${rssMB}MB, workers=${myWorkers.length} (${activeTasks} with tasks)`);

    // Find stale orchestrators: no active workers AND no tick in last 60 min
    const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const allOrchestrators = this.deps.db.listAgents({ type: 'orchestrator', status: 'active' });
    let dissolved = 0;

    for (const orch of allOrchestrators) {
      if (orch.id === this.orchestratorId) continue;
      const workers = this.deps.db.getActiveWorkers(orch.id);
      const isStale = workers.length === 0 &&
        (!orch.lastTickAt || orch.lastTickAt < sixtyMinAgo);

      if (isStale) {
        console.log(`[Orchestrator ${this.orchestratorId}] Dissolving stale orchestrator ${orch.id} (role=${orch.role}, lastTick=${orch.lastTickAt || 'never'})`);
        this.deps.orgManager.dissolve(orch.id);
        dissolved++;
      }
    }

    if (dissolved > 0) {
      console.log(`[Orchestrator ${this.orchestratorId}] Self-check: dissolved ${dissolved} stale orchestrator(s)`);
    }

    // Dissolve idle project orchestrators (no workers, no activity > 3 minutes)
    // Also dissolve immediately if all workers are done/failed and no unread messages remain.
    const threeMinAgo = new Date(Date.now() - 180000).toISOString();
    let idleProjectsDissolved = 0;
    for (const orch of allOrchestrators) {
      if (orch.id === this.orchestratorId) continue;
      if (orch.role !== 'user_project') continue;
      const orchWorkers = this.deps.db.getActiveWorkers(orch.id);

      // Immediate dissolve: all workers done/failed AND no unread messages
      if (orchWorkers.length === 0) {
        const allWorkers = this.deps.db.listAgents({ type: 'worker', parentId: orch.id });
        const allDoneOrFailed = allWorkers.length > 0 && allWorkers.every(w => w.status === 'done' || w.status === 'failed');
        const unread = this.deps.messageBus.read(orch.id);
        if (allDoneOrFailed && unread.length === 0) {
          console.log(`[Orchestrator ${this.orchestratorId}] Dissolving completed project orchestrator ${orch.id} (all workers done, no unread messages)`);
          this.deps.orgManager.dissolve(orch.id);
          idleProjectsDissolved++;
          continue;
        }

        // Time-based dissolve: no workers, no activity for >3 min
        const lastActivity = orch.lastReportAt || orch.createdAt;
        if (lastActivity < threeMinAgo) {
          console.log(`[Orchestrator ${this.orchestratorId}] Dissolving idle project orchestrator ${orch.id} (no workers, no activity for >3min, lastActivity=${lastActivity})`);
          this.deps.orgManager.dissolve(orch.id);
          idleProjectsDissolved++;
        }
      }
    }
    if (idleProjectsDissolved > 0) {
      console.log(`[Orchestrator ${this.orchestratorId}] Self-check: dissolved ${idleProjectsDissolved} idle project orchestrator(s)`);
    }

    // OOM prevention if RSS > 1.5GB
    if (mem.rss > HIGH_MEMORY_BYTES) {
      await this.initiateOOMPrevention(rssMB, CRITICAL_MEMORY_BYTES);
    }
  }

  /**
   * Graceful OOM prevention:
   * 1. Stop idle workers
   * 2. Dissolve orchestrators with no active work
   * 3. Restart node if still critical (RSS > 2GB)
   */
  private async initiateOOMPrevention(rssMB: number, criticalBytes: number): Promise<void> {
    console.log(`[Orchestrator ${this.orchestratorId}] OOM prevention triggered: RSS=${rssMB}MB`);

    let stoppedWorkers = 0;
    let dissolvedOrchestrators = 0;

    // Step 1: stop idle workers (no active task)
    const myWorkers = this.deps.db.getActiveWorkers(this.orchestratorId);
    for (const worker of myWorkers) {
      if (!worker.currentTaskId) {
        this.deps.workerPool.kill(worker.id);
        stoppedWorkers++;
      }
    }

    // Step 2: dissolve orchestrators with no active work
    const allOrchestrators = this.deps.db.listAgents({ type: 'orchestrator', status: 'active' });
    for (const orch of allOrchestrators) {
      if (orch.id === this.orchestratorId) continue;
      const workers = this.deps.db.getActiveWorkers(orch.id);
      if (workers.length === 0) {
        this.deps.orgManager.dissolve(orch.id);
        dissolvedOrchestrators++;
      }
    }

    console.log(`[Orchestrator ${this.orchestratorId}] OOM prevention: dissolved ${dissolvedOrchestrators} orchestrators, stopped ${stoppedWorkers} workers`);

    // Step 3: restart node if still above critical threshold after cleanup
    const memAfter = process.memoryUsage();
    if (memAfter.rss > criticalBytes) {
      const rssMBAfter = Math.round(memAfter.rss / (1024 * 1024));
      console.log(`[Orchestrator ${this.orchestratorId}] Critical OOM after cleanup: RSS=${rssMBAfter}MB — initiating node restart (exit 75)`);
      // RESTART_EXIT_CODE=75 triggers PM2/systemd to restart the process
      process.exit(75);
    }
  }

  // =========================================================================
  // Reflection (self-healing growth)
  // =========================================================================

  /**
   * Reflect on a worker's completion. Extract lessons.
   */
  private reflectOnCompletion(workerId: string, report: any): void {
    // Record difficulties as lessons with moderate confidence
    if (report.difficulties?.length) {
      for (const difficulty of report.difficulties) {
        this.deps.db.addLesson({
          orchestratorId: this.orchestratorId,
          lesson: `Difficulty encountered: ${difficulty}`,
          source: 'worker_difficulty',
          relevanceTags: [report.role || 'builder'],
          confidence: 0.7,
        });
      }
    }

    // Record the reflection
    this.deps.db.addReflection({
      orchestratorId: this.orchestratorId,
      level: 'task',
      trigger: 'task_complete',
      inputSummary: `Worker ${workerId}: ${report.summary}`,
      output: JSON.stringify({
        difficulties: report.difficulties || [],
        suggestions: report.suggestions || [],
      }),
      lessonsCreated: (report.difficulties?.length || 0) + (report.suggestions?.length || 0),
    });
  }

}
