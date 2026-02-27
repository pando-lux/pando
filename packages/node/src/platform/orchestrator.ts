// TODO: Add orchestrator-level health metrics tracking
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
 *   4. If Tier 2: short, stateless, 1-turn AI call
 *   5. Execute actions returned by AI or determined by code
 *   6. Log the tick
 *
 * Key design decisions:
 *   - No long AI conversations. Each tick is a fresh AI call.
 *   - All state in SQLite. Nothing in memory except the timer handle.
 *   - Same class at all levels. Only the config and rolePrompt differ.
 */

import type { AgentDatabase, AgentIdentity, InboxMessage, Lesson } from './agent-database.js';
import type { MessageBus } from '../core/message-bus.js';
import type { WorkerPool } from '../core/worker-pool.js';
import type { OrgManager } from './org-manager.js';
import type { AIBackendRegistry } from '../core/ai-backend-registry.js';
import type { GenomeBridge } from './genome-bridge.js';
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
  /** Scenario runner for post-upgrade regression testing */
  scenarioRunner?: ScenarioRunner;
  /** Phase 105: Template registry for available roles */
  templateRegistry?: TemplateRegistry;
  /** API port for worker HTTP calls (deploy, validate, etc.) */
  apiPort?: number;
  /** Data directory for reading api-token */
  dataDir?: string;
  /** Thread store for writing orchestrator responses back to chat UI */
  threadStore?: ThreadStore;
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
  | { type: 'deploy'; projectId: string }
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
  directives: string[];
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

      // 1. Read board and inbox
      const board = this.readBoard();

      // 2. Classify: Tier 1 (deterministic) or Tier 2 (AI judgment)
      const tier = this.classify(board);

      let actions: OrchestratorAction[] = [];

      const uptimeMs = Date.now() - this._startTime;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const inboxSummary = `msgs=${board.messages.length} reports=${board.workerReports.length} alerts=${board.healthAlerts.length} requests=${board.userRequests.length}`;
      console.log(`[Orchestrator ${this.orchestratorId}] Tick — Tier ${tier}, workers=${board.activeWorkers}/${board.maxWorkers}, ${inboxSummary}, uptime=${uptimeSec}s`);

      if (tier === 1) {
        // Tier 1: deterministic actions
        actions = this.deterministic(board, agent);
      } else {
        // Tier 2: call AI for judgment
        console.log(`[Orchestrator ${this.orchestratorId}] Calling AI...`);
        actions = await this.callAI(board, agent);
        console.log(`[Orchestrator ${this.orchestratorId}] AI returned ${actions.length} action(s): ${actions.map(a => a.type).join(', ') || 'none'}`);
      }

      // 3. Execute actions
      for (const action of actions) {
        try {
          await this.execute(action, agent);
        } catch (err: any) {
          console.error(`[Orchestrator ${this.orchestratorId}] action error (${action.type}):`, err.message?.slice(0, 200));
        }
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

      // 5. Mark messages as read
      const allMessageIds = [
        ...board.messages.map(m => m.id),
        ...board.workerReports.map(m => m.id),
        ...board.healthAlerts.map(m => m.id),
        ...board.userRequests.map(m => m.id),
      ];
      if (allMessageIds.length > 0) {
        this.deps.messageBus.markRead(allMessageIds);
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
        }),
        aiInput: tier === 2 ? 'AI called' : null,
        aiOutput: tier === 2 ? JSON.stringify(actions) : null,
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
    const otherMessages = messages.filter(m =>
      !['worker_report', 'health_alert', 'user_request'].includes(m.type));

    // Track threadId from user requests for respond_to_user
    for (const req of userRequests) {
      try {
        const payload = typeof req.payload === 'string' ? JSON.parse(req.payload) : req.payload;
        if (payload.threadId) this._lastThreadId = payload.threadId;
      } catch { /* ignore */ }
    }

    // Get directives
    const directives = this.deps.db.getDirectives(this.orchestratorId);

    return {
      pendingTasks: this.deps.db.listAgents({ parentId: this.orchestratorId, status: 'pending' }).length,
      activeTasks: activeWorkers.filter(w => w.currentTaskId).length,
      activeWorkers: activeWorkers.length,
      maxWorkers: agent.maxWorkers,
      messages: otherMessages,
      workerReports,
      healthAlerts,
      userRequests,
      directives: directives.map(d => d.content),
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
   * Only truly empty ticks are Tier 1.
   */
  private classify(board: BoardState): 1 | 2 {
    // Tier 1: Nothing to do — empty inbox
    if (board.workerReports.length === 0 &&
        board.healthAlerts.length === 0 &&
        board.userRequests.length === 0 &&
        board.messages.length === 0) {
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
    const backend = this.deps.aiRegistry.getBest('text-generation');
    if (!backend) {
      console.error(`[Orchestrator ${this.orchestratorId}] No AI backend available`);
      return [];
    }

    // Build the AI prompt
    const prompt = this.buildAIPrompt(board, agent);

    try {
      const result = await backend.execute({
        type: 'text',
        prompt,
        options: { model: 'claude-sonnet-4-6', noTools: true },
      });

      if (!result.success || !result.output) {
        console.error(`[Orchestrator ${this.orchestratorId}] AI call failed:`, result.error);
        return [];
      }

      // Parse actions from AI output
      return this.parseAIActions(result.output);
    } catch (err) {
      console.error(`[Orchestrator ${this.orchestratorId}] AI call error:`, err);
      return [];
    }
  }

  private buildAIPrompt(board: BoardState, agent: AgentIdentity): string {
    const sections: string[] = [];

    sections.push(`# ROLE: Manager for orchestrator "${agent.role}" (${this.orchestratorId})`);
    sections.push('');
    sections.push('You are the MANAGER of this team. You read reports from your workers, assess the situation, and decide what happens next.');
    sections.push('You do NOT do work yourself — you delegate to specialized workers.');
    sections.push('You output ONLY a JSON array of action objects. Nothing else.');
    sections.push('');
    sections.push('## CRITICAL RULES');
    sections.push('1. You MUST NOT read, write, or modify any files. You have NO file access.');
    sections.push('2. You MUST NOT use any tools (Read, Edit, Write, Bash, Grep, etc.).');
    sections.push('3. For ANY code change, spawn a "builder" worker.');
    sections.push('4. For verification, spawn a "tester" worker.');
    sections.push('5. For deployment, spawn a "devops" worker.');
    sections.push('6. Output ONLY a raw JSON array. No markdown, no backticks, no explanation.');
    sections.push('');

    // Board state
    sections.push('## Current State');
    sections.push(`Active workers: ${board.activeWorkers}/${board.maxWorkers}`);
    sections.push(`Active tasks: ${board.activeTasks}`);
    sections.push(`Pending tasks: ${board.pendingTasks}`);
    sections.push('');

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
        sections.push(`- ${d}`);
      }
      sections.push('');
    }

    // Gap 2 fix: Inject lessons into the manager's OWN prompt so it learns from past decisions
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
      // Also inject org-wide knowledge
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
    if (this.deps.genomeBridge?.isLoaded() && board.userRequests.length > 0) {
      const requestText = board.userRequests.map(r => {
        try { return JSON.parse(r.payload).message || r.payload; } catch { return r.payload; }
      }).join(' ');
      const ctx = this.deps.genomeBridge.contextForTask({ taskDescription: requestText });
      if (ctx) {
        sections.push('## Architecture Knowledge');
        sections.push(ctx);
        sections.push('');
      }
      const failing = this.deps.genomeBridge.failingTests();
      if (failing.length > 0) {
        sections.push(`### Failing Tests (${failing.length}):`);
        for (const t of failing) {
          sections.push(`- ${t._name}: ${t.description || ''}`);
        }
        sections.push('');
      }
    }

    // Role prompt
    if (agent.rolePrompt) {
      sections.push('## Your Role');
      sections.push(agent.rolePrompt);
      sections.push('');
    }

    // Phase 105: Available roles from TemplateRegistry
    const availableRoles: string[] = ['builder', 'tester', 'reviewer', 'researcher', 'devops'];
    if (this.deps.templateRegistry) {
      const templates = this.deps.templateRegistry.listTemplates({ status: 'active' });
      const roles = [...new Set(templates.map(t => t.role))];
      if (roles.length > 0) availableRoles.splice(0, availableRoles.length, ...roles);
    }

    // Available actions
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
    // Project context for deployment instructions
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
    // Council-specific pipeline: code changes go through governance
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
    }
    sections.push('### Key Decisions (use your judgment):');
    sections.push('- Builder reports code changes? At minimum: commit_code the changes. For important changes, QA first.');
    sections.push('- Multiple workers reporting? Read ALL reports before deciding next step.');
    sections.push('- QA failed multiple times? record_lesson with the pattern, then try a different approach or escalate.');
    sections.push('- Health alert? Assess severity. Critical → spawn builder. Minor → record_lesson.');
    sections.push('- Simple question with no code needed? respond_to_user directly.');
    sections.push('- Check "Lessons Learned" above — avoid repeating past mistakes.');
    sections.push('- Nothing to do? Return [].');
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
    sections.push('OUTPUT: Return ONLY a JSON array. Example: [{"type":"spawn_worker","role":"builder","rolePrompt":"Build a landing page with..."}]');
    sections.push('If nothing needs to be done: []');

    return sections.join('\n');
  }

  private parseAIActions(output: string): OrchestratorAction[] {
    try {
      // Try to extract JSON array from the output
      const jsonMatch = output.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const actions = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(actions)) return [];

      // Validate each action has a type
      return actions.filter((a: any) => a && typeof a.type === 'string') as OrchestratorAction[];
    } catch {
      console.error(`[Orchestrator ${this.orchestratorId}] Failed to parse AI actions:`, output.slice(0, 200));
      return [];
    }
  }

  // =========================================================================
  // Action execution
  // =========================================================================

  private async execute(action: OrchestratorAction, agent: AgentIdentity): Promise<void> {
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
          await this.deps.onCommit(action.message);
        }
        break;
      }

      case 'deploy': {
        // Phase 105: Deployment is now agent-driven (devops worker calls the API).
        // This case is kept for backward compatibility but should not be used.
        console.log(`[Orchestrator ${this.orchestratorId}] Deploy action received — deployment is now handled by devops agent`);
        break;
      }

      case 'respond_to_user': {
        console.log(`[Orchestrator ${this.orchestratorId}] → User: ${action.message}`);
        // Write response to ThreadStore so it appears in the chat UI
        if (this.deps.threadStore && this._lastThreadId) {
          try {
            this.deps.threadStore.addMessage(this._lastThreadId, {
              role: 'assistant',
              content: action.message,
              timestamp: Date.now(),
            });
          } catch (err: any) {
            console.warn(`[Orchestrator ${this.orchestratorId}] ThreadStore write failed: ${err.message?.slice(0, 100)}`);
          }
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
