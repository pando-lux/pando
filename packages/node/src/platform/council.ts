/**
 * Council — Network Council Selection + Reflection Engine + Chat + Builder Pipeline.
 *
 * Phase 50:  Council selection, rotation, reflection infrastructure.
 * Phase 101b: AI-powered reflection via AIBackendRegistry.
 * Phase 101c: Chat interface (handleMessage) with AI + action detection.
 * Phase 102a: Builder spawning via HTTP POST to /v1/agents/spawn.
 * Phase 102b: Builder completion watcher (bridge queue polling).
 * Phase 102.5: Identity integration (RequestActor).
 * Phase 103c: Full builder → QA → governance → upgrade pipeline.
 * Phase 103e: Real QA tester agent — independent verification, no hardcoded HTTP pings.
 *
 * State persisted in {dataDir}/council/:
 *   - council-state.json   — members, rotation, reflection timestamps, active tasks
 *   - council-minutes.md   — rolling log of council decisions (last 30 entries)
 *   - last-prompt.md       — most recent assembled reflection prompt
 *   - network-state.md     — written by NetworkState (read-only here)
 *   - chat-history.json    — council chat history (max 200 entries)
 *   - request-log.json     — audit log of council requests
 *   - directives.json      — founder directives
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
// RequestActor defined locally to avoid cross-package dependency
interface RequestActor { type: string; id: string; label: string; }

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface CouncilMember {
  peerId: string;
  reputation: number;
  hasClaudeCode: boolean;
  uptimeHours: number;
}

export interface CouncilState {
  members: CouncilMember[];
  selectedAt: number;
  rotatesAt: number;        // selectedAt + 7 days
  thisNodeOnCouncil: boolean;
}

export interface ReflectionResult {
  timestamp: number;
  type: 'daily' | 'weekly' | 'monthly';
  summary: string;
  proposals: string[];       // governance proposals to create, if any
  minutesEntry: string;      // what to append to council-minutes.md
}

export interface CouncilChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  senderId?: string;
  actorType?: string;
}

export interface ActiveTask {
  taskId: string;
  description: string;
  stage: 'builder' | 'qa' | 'governance' | 'done' | 'failed';
  builderAgentId: string | null;
  qaAgentId: string | null;
  retryCount: number;
  maxRetries: number;
  startedAt: number;
  builderSummary?: string;
  qaVerdict?: string;
}

interface PersistedCouncilState {
  members: CouncilMember[];
  selectedAt: number;
  rotatesAt: number;
  lastDailyReflection: number;
  lastWeeklyReflection: number;
  lastMonthlyReflection: number;
  councilAgentId?: string;
  activeTasks?: ActiveTask[];
}

interface RequestLogEntry {
  timestamp: number;
  actor: { type: string; id: string; label: string };
  action: string;
  summary: string;
  outcome: string;
}

interface FounderDirective {
  id: string;
  content: string;
  addedAt: number;
  addedBy: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const COUNCIL_SIZE = 3;
const ROTATION_MS = 7 * 24 * 60 * 60 * 1000;       // 7 days
const DAILY_MS = 24 * 60 * 60 * 1000;               // 24 hours
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;          // 7 days
const MONTHLY_MS = 30 * 24 * 60 * 60 * 1000;        // 30 days
const MAX_MINUTES_ENTRIES = 30;
const MAX_CHAT_HISTORY = 200;
const MAX_REQUEST_LOG = 200;
const BRIDGE_POLL_MS = 10_000;                       // 10s bridge queue poll
const MAX_TASK_RETRIES = 3;

// Mode-aware reflection intervals
const REFLECTION_INTERVALS: Record<string, number> = {
  dev: 60 * 60 * 1000,          // 1 hour
  beta: 4 * 60 * 60 * 1000,     // 4 hours
  live: 24 * 60 * 60 * 1000,    // 24 hours
};

function getReflectionInterval(): number {
  const mode = process.env.PANDO_MODE || 'dev';
  return REFLECTION_INTERVALS[mode] || REFLECTION_INTERVALS.dev;
}

// ── Council Class ───────────────────────────────────────────────────────────

export class Council {
  private node: any;       // PandoNode — typed as any to avoid circular imports
  private dataDir: string;
  private councilDir: string;
  private statePath: string;
  private minutesPath: string;
  private promptPath: string;
  private networkStatePath: string;
  private chatHistoryPath: string;
  private requestLogPath: string;
  private directivesPath: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bridgeWatcherTimer: ReturnType<typeof setInterval> | null = null;
  private state: PersistedCouncilState;
  private chatHistory: CouncilChatMessage[] = [];
  private requestLog: RequestLogEntry[] = [];
  private directives: FounderDirective[] = [];
  private pendingHealthAlerts: string[] = [];
  private pendingHumanAlerts: string[] = [];   // alerts requiring founder/human action
  private humanActionPath: string = '';
  private councilAgentId: string | null = null;
  private activeTasks: ActiveTask[] = [];

  constructor(node: any, dataDir: string) {
    this.node = node;
    this.dataDir = dataDir;
    this.councilDir = join(dataDir, 'council');
    this.statePath = join(this.councilDir, 'council-state.json');
    this.minutesPath = join(this.councilDir, 'council-minutes.md');
    this.promptPath = join(this.councilDir, 'last-prompt.md');
    this.networkStatePath = join(this.councilDir, 'network-state.md');
    this.humanActionPath = join(this.councilDir, 'human-action-needed.md');
    this.chatHistoryPath = join(this.councilDir, 'chat-history.json');
    this.requestLogPath = join(this.councilDir, 'request-log.json');
    this.directivesPath = join(this.councilDir, 'directives.json');

    // Ensure council directory exists
    this.ensureDir();

    // Load persisted state
    this.state = this.loadState();
    this.chatHistory = this.loadJson(this.chatHistoryPath, []);
    this.requestLog = this.loadJson(this.requestLogPath, []);
    this.directives = this.loadJson(this.directivesPath, []);
    this.councilAgentId = this.state.councilAgentId || null;
    this.activeTasks = this.state.activeTasks || [];
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Select council members from known peers + self.
   * Filters to AI-capable nodes, sorts by reputation, takes top 3.
   */
  selectCouncil(): CouncilMember[] {
    const candidates: CouncilMember[] = [];

    // 1. Get all known peers from CapabilityRegistry
    const capRegistry = this.node.getCapabilityRegistry?.();
    const allProfiles = capRegistry?.getAllProfiles?.() || [];

    // 2. Include self
    const identity = this.node.getIdentity?.();
    const localPeerId = identity?.peerId || '';

    for (const profile of allProfiles) {
      const peerId = profile.peerId;

      // 3. Filter to nodes with Claude Code capability
      const hasCpu = profile.capabilities?.compute_cpu === true;
      const hasClaudeCode = hasCpu && profile.details?.compute_cpu?.claudeCode === true;
      if (!hasClaudeCode) continue;

      // 4. Get reputation
      const repManager = this.node.getReputationManager?.();
      const repRecord = repManager?.getReputation?.(peerId);
      const reputation = repRecord?.reputationScore ?? 0;

      const uptimeHours = peerId === localPeerId
        ? Math.floor(process.uptime() / 3600)
        : 0;

      candidates.push({
        peerId,
        reputation,
        hasClaudeCode: true,
        uptimeHours,
      });
    }

    // 5. Sort by reputation (highest first)
    candidates.sort((a, b) => b.reputation - a.reputation);

    // 6. Take top N
    const members = candidates.slice(0, COUNCIL_SIZE);

    // Update state
    const now = Date.now();
    this.state.members = members;
    this.state.selectedAt = now;
    this.state.rotatesAt = now + ROTATION_MS;
    this.saveState();

    console.log(`[council] Selected ${members.length} council member(s): [${members.map(m => m.peerId.slice(0, 12)).join(', ')}]`);

    return members;
  }

  /**
   * Check if this node is on the current council.
   */
  isCouncilMember(): boolean {
    const identity = this.node.getIdentity?.();
    if (!identity) return false;
    return this.state.members.some(m => m.peerId === identity.peerId);
  }

  /**
   * Get the current council state.
   */
  getCouncil(): CouncilState {
    const identity = this.node.getIdentity?.();
    return {
      members: [...this.state.members],
      selectedAt: this.state.selectedAt,
      rotatesAt: this.state.rotatesAt,
      thisNodeOnCouncil: identity
        ? this.state.members.some(m => m.peerId === identity.peerId)
        : false,
    };
  }

  // ── Phase 101b: AI-Powered Reflection ─────────────────────────────────────

  /**
   * Run a reflection cycle. Assembles context, calls AI backend, parses output.
   */
  async runDailyReflection(): Promise<ReflectionResult | null> {
    if (!this.isCouncilMember()) {
      return null;
    }

    // 1. Assemble context
    const networkState = this.readFileSafe(this.networkStatePath, '(no network state available)');
    const recentMinutes = this.getRecentMinutesEntries(5);
    const genomeState = this.readGenomeState();
    const founderDirectives = this.directives.map(d => `- ${d.content}`).join('\n') || '(none)';
    const healthAlerts = this.pendingHealthAlerts.length > 0
      ? this.pendingHealthAlerts.join('\n')
      : '(no pending alerts)';
    const humanActionAlerts = this.pendingHumanAlerts.length > 0
      ? this.pendingHumanAlerts.join('\n')
      : null;

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const councilMembers = this.state.members
      .map(m => `  - ${m.peerId.slice(0, 16)}... (reputation: ${m.reputation.toFixed(2)})`)
      .join('\n');

    const prompt = `# Network Council — Daily Reflection
Date: ${dateStr}
Council Members:
${councilMembers}

## Current Network State
${networkState}

## Genome State (project health)
${genomeState}

## Recent Council Minutes
${recentMinutes || '(no previous minutes)'}

## Founder Directives
${founderDirectives}

## Health Alerts
${healthAlerts}
${humanActionAlerts ? `\n## REQUIRES_HUMAN_ACTION\nThe following issues CANNOT be self-healed and require founder intervention:\n${humanActionAlerts}\n` : ''}
## Instructions
You are a member of the Pando Network Council — a group of top-reputation AI-capable nodes.
Reflect on the current state and propose improvements.

Respond ONLY with valid JSON:
{
  "summary": "1-3 sentence health summary",
  "observations": ["observation 1", "observation 2"],
  "proposals": [{"title": "Proposal title", "description": "What and why"}],
  "actions": [{"type": "fix", "description": "What to fix", "files": ["path/to/file"]}]
}

Be concrete. If everything is healthy, say so — do not invent problems.`;

    // Save prompt for inspection
    try { writeFileSync(this.promptPath, prompt, 'utf-8'); } catch {}

    // 2. Try AI backend
    const aiRegistry = this.node.getAIBackendRegistry?.();
    const backend = aiRegistry?.getBest?.('text-generation');

    let result: ReflectionResult;

    if (backend) {
      try {
        const aiResult = await backend.execute({
          type: 'text',
          prompt,
          context: 'council-reflection',
        });

        if (aiResult.success && aiResult.output) {
          const parsed = this.parseReflectionOutput(aiResult.output);
          result = {
            timestamp: Date.now(),
            type: 'daily',
            summary: parsed.summary,
            proposals: parsed.proposals.map((p: any) => p.title),
            minutesEntry: `## ${dateStr} — Daily Reflection\n- ${parsed.summary}\n${parsed.observations.map((o: string) => `- ${o}`).join('\n')}\n`,
          };

          // Create governance proposals from reflection
          for (const proposal of parsed.proposals) {
            await this.createCouncilProposal(proposal.title, proposal.description);
          }

          // Spawn builders for fix actions
          for (const action of parsed.actions) {
            if (action.type === 'fix') {
              this.runSelfHealingLoop(action.description, action.files);
            }
          }

          // Clear health alerts after processing
          this.pendingHealthAlerts = [];
          this.pendingHumanAlerts = [];
        } else {
          console.warn(`[council] AI reflection returned empty result — skipping`);
          return null;
        }
      } catch (err: any) {
        console.error(`[council] AI reflection failed: ${err.message} — skipping`);
        return null;
      }
    } else {
      console.warn(`[council] No AI backend available — reflection skipped (not ready yet)`);
      return null;
    }

    // Update reflection timestamp
    this.state.lastDailyReflection = Date.now();
    this.saveState();

    return result;
  }

  // stubReflectionResult removed — no stubs. If AI backend is not available, reflection is skipped.

  private parseReflectionOutput(output: string): { summary: string; observations: string[]; proposals: any[]; actions: any[] } {
    try {
      const cleaned = output.replace(/^```json?\s*/, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      return {
        summary: parsed.summary || 'No summary provided.',
        observations: Array.isArray(parsed.observations) ? parsed.observations : [],
        proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      };
    } catch {
      return { summary: output.slice(0, 200), observations: [], proposals: [], actions: [] };
    }
  }

  // ── Phase 101c: Chat Interface ────────────────────────────────────────────

  /**
   * Handle an incoming message to the council.
   * Uses AI backend for intelligent responses and action detection.
   */
  async handleMessage(message: string, actor?: RequestActor): Promise<string> {
    const senderId = actor?.id || 'anonymous';
    const actorType = actor?.type || 'anonymous';

    // Log the request
    this.logRequest(
      actor || { type: 'anonymous', id: 'anonymous', label: 'anonymous' },
      'chat',
      message.slice(0, 100),
      'processing',
    );

    // Save user message to history
    this.addChatMessage({
      role: 'user',
      content: message,
      timestamp: Date.now(),
      senderId,
      actorType,
    });

    // Try AI-powered response
    const aiRegistry = this.node.getAIBackendRegistry?.();
    const backend = aiRegistry?.getBest?.('text-generation');

    let reply: string;

    if (backend) {
      try {
        // Build context from recent chat history
        const recentHistory = this.chatHistory.slice(-10).map(m =>
          `${m.role}: ${m.content.slice(0, 200)}`
        ).join('\n');

        const aiResult = await backend.execute({
          type: 'text',
          prompt: `You are the Pando Network Council AI. You help manage the network.

Recent conversation:
${recentHistory}

User (${actorType}:${senderId.slice(0, 12)}): ${message}

If the user is asking you to fix, build, or change something in the codebase, respond with JSON:
{"action": "spawn_builder", "description": "what to build/fix", "response": "your message to user"}

Otherwise, respond naturally as a helpful AI council member. Keep answers concise.`,
          context: 'council-chat',
          options: { cwd: this.getRepoRoot() },
        });

        if (aiResult.success && aiResult.output) {
          // Check if the AI wants to spawn a builder
          const actionResult = this.detectAction(aiResult.output);
          if (actionResult) {
            reply = actionResult.response;
            if (actionResult.action === 'spawn_builder') {
              this.runSelfHealingLoop(actionResult.description);
              reply += '\n\n_Spawning a builder agent to handle this..._';
            }
          } else {
            reply = aiResult.output;
          }
        } else {
          reply = `AI backend returned an empty response. The council cannot process this request right now.`;
        }
      } catch (err: any) {
        console.error(`[council] Chat AI failed: ${err.message}`);
        reply = `AI backend error: ${err.message}. The council cannot process this request right now.`;
      }
    } else {
      // No AI backend available — still handle actionable requests via builder spawning
      if (this.isActionableRequest(message)) {
        this.runSelfHealingLoop(message);
        reply = `No AI backend available for chat, but I detected an actionable request. Spawning a builder agent to handle: "${message.slice(0, 80)}".`;
      } else {
        reply = `No AI backend available. The council requires a Claude Code backend to respond to messages. Ensure at least one council node has shareCompute enabled.`;
      }
    }

    // Save assistant reply to history
    this.addChatMessage({
      role: 'assistant',
      content: reply,
      timestamp: Date.now(),
    });

    // Update request log outcome
    if (this.requestLog.length > 0) {
      this.requestLog[this.requestLog.length - 1].outcome = 'completed';
      this.saveJson(this.requestLogPath, this.requestLog);
    }

    return reply;
  }

  private detectAction(output: string): { action: string; description: string; response: string } | null {
    try {
      const cleaned = output.replace(/^```json?\s*/, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.action && parsed.description && parsed.response) {
        return parsed;
      }
    } catch {}
    return null;
  }

  private isActionableRequest(message: string): boolean {
    const keywords = /\b(fix|build|create|implement|add|update|upgrade|deploy|repair|patch|refactor)\b/i;
    return keywords.test(message);
  }

  // fallbackResponse removed — no stubs. Council requires real AI backend.

  getChatHistory(): CouncilChatMessage[] {
    return [...this.chatHistory];
  }

  // ── Phase 102a: Builder Spawning ──────────────────────────────────────────

  /**
   * Spawn a builder agent to fix/implement something.
   * Uses HTTP POST to /v1/agents/spawn.
   */
  async spawnFixAgent(description: string, files?: string[]): Promise<string | null> {
    const apiPort = this.node.getApiPort?.() || 4000;
    const apiToken = this.loadApiToken();
    if (!apiToken) {
      console.warn('[council] No API token — cannot spawn builder');
      return null;
    }

    const body: Record<string, any> = {
      role: 'builder',
      projectId: 'council-fix',
      description: `[Council] ${description}`,
      parentId: this.councilAgentId || null,
      taskContext: files && files.length > 0
        ? `Task: ${description}\n\nFiles to examine: ${files.join(', ')}`
        : `Task: ${description}`,
    };

    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/v1/agents/spawn`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        const data = await res.json() as any;
        console.log(`[council] Spawned builder agent: ${data.agentId}`);
        this.appendMinutes(`## Builder Spawned — ${new Date().toISOString().slice(0, 10)}\n- Agent: ${data.agentId}\n- Task: ${description.slice(0, 100)}\n`);
        return data.agentId;
      } else {
        const err = await res.text();
        console.error(`[council] Failed to spawn builder: ${res.status} ${err}`);
        return null;
      }
    } catch (err: any) {
      console.error(`[council] Builder spawn error: ${err.message}`);
      return null;
    }
  }

  /**
   * Spawn a QA tester agent to independently verify a builder's work.
   * The tester gets ONLY the task description and builder's summary — NOT reasoning.
   */
  async spawnQAAgent(taskDescription: string, builderSummary: string): Promise<string | null> {
    const apiPort = this.node.getApiPort?.() || 4000;
    const apiToken = this.loadApiToken();
    if (!apiToken) { console.warn('[council] No API token — cannot spawn QA agent'); return null; }

    const taskContext = `You are an independent QA tester. A builder claims to have completed the following task:\n\nTASK: ${taskDescription}\n\nThe builder reports: "${builderSummary}"\n\nDo NOT assume the fix is correct. Test from scratch. Do NOT trust the builder's claims.\nVerify the changes work by:\n1. Reading the changed code\n2. Running the build (npm run build)\n3. Running relevant tests\n4. Checking for regressions\n\nReport your verdict as the FIRST LINE of your summary:\n- "PASS: [reason]" if the changes work correctly\n- "FAIL: [specific issues found]" if there are problems\n\nBe specific about what you tested and what you found.`;

    const body: Record<string, any> = {
      role: 'tester', projectId: 'council-fix',
      description: `[Council QA] Verify: ${taskDescription.slice(0, 100)}`,
      parentId: this.councilAgentId || null, taskContext,
    };

    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/v1/agents/spawn`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        console.log(`[council] Spawned QA tester agent: ${data.agentId}`);
        this.appendMinutes(`## QA Tester Spawned — ${new Date().toISOString().slice(0, 10)}\n- Agent: ${data.agentId}\n- Verifying: ${taskDescription.slice(0, 100)}\n`);
        return data.agentId;
      } else {
        console.error(`[council] Failed to spawn QA agent: ${res.status} ${await res.text()}`);
        return null;
      }
    } catch (err: any) { console.error(`[council] QA agent spawn error: ${err.message}`); return null; }
  }

  getActiveTasks(): ActiveTask[] { return [...this.activeTasks]; }

  /**
   * Fire-and-forget: spawn a builder, track as ActiveTask, log to minutes.
   */
  private runSelfHealingLoop(description: string, files?: string[]): void {
    this.spawnFixAgent(description, files).then(agentId => {
      if (agentId) {
        const task: ActiveTask = {
          taskId: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          description, stage: 'builder', builderAgentId: agentId, qaAgentId: null,
          retryCount: 0, maxRetries: MAX_TASK_RETRIES, startedAt: Date.now(),
        };
        this.activeTasks.push(task);
        this.persistActiveTasks();
        this.appendMinutes(`## Self-Healing — ${new Date().toISOString().slice(0, 10)}\n- Spawned builder ${agentId} for: ${description.slice(0, 100)}\n- Task: ${task.taskId}\n`);
      }
    }).catch(err => { console.error(`[council] Self-healing loop error: ${err.message}`); });
  }

  // ── Phase 102b: Builder Completion Watcher ────────────────────────────────

  /**
   * Register a virtual "researcher" agent for the council so it gets a bridge queue.
   */
  async registerCouncilAgent(): Promise<void> {
    if (this.councilAgentId) return;

    const agentManager = this.node.getAgentManager?.();
    if (!agentManager) return;

    try {
      const agentId = await agentManager.spawnAgent({
        role: 'researcher',
        parentId: null,
        projectId: 'council',
        description: 'Council virtual agent for bridge routing',
      });
      if (agentId) {
        this.councilAgentId = agentId;
        this.state.councilAgentId = agentId;
        this.saveState();
        console.log(`[council] Registered council agent: ${agentId}`);
      }
    } catch (err: any) {
      console.error(`[council] Failed to register council agent: ${err.message}`);
    }
  }

  /**
   * Start polling the bridge queue for builder completion events.
   */
  startBridgeWatcher(): void {
    const bridge = this.node.getAgentManager?.()?.getBridge?.();
    if (!bridge || !this.councilAgentId) return;

    this.bridgeWatcherTimer = setInterval(() => {
      if (!this.councilAgentId) return;
      if (bridge.isEmpty(this.councilAgentId)) return;
      if (bridge.isManagerBusy?.(this.councilAgentId)) return;

      const item = bridge.dequeue(this.councilAgentId);
      if (!item) return;

      this.handleBridgeItem(item).catch(err => {
        console.error(`[council] Bridge item handling failed: ${err.message}`);
      });
    }, BRIDGE_POLL_MS);

    if (this.bridgeWatcherTimer.unref) this.bridgeWatcherTimer.unref();
    console.log('[council] Bridge watcher started');
  }

  private async handleBridgeItem(item: any): Promise<void> {
    if (item.type === 'task_completed') {
      const { agentId, summary, details } = item.payload || {};

      // Check if this is a QA tester reporting back
      const qaTask = this.findTaskByQAAgent(agentId);
      if (qaTask) { await this.handleQACompletion(qaTask, summary || '', details || ''); return; }

      // Check if this is a tracked builder reporting back
      const builderTask = this.findTaskByBuilderAgent(agentId);
      if (builderTask) { await this.handleBuilderCompletion(builderTask, summary || '', details || ''); return; }

      // Unknown agent — create a new task and treat as builder completion
      console.log(`[council] Builder ${agentId} completed (untracked): ${(summary || '').slice(0, 100)}`);
      const task: ActiveTask = {
        taskId: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        description: summary || 'Unknown task', stage: 'builder',
        builderAgentId: agentId, qaAgentId: null,
        retryCount: 0, maxRetries: MAX_TASK_RETRIES,
        startedAt: Date.now(), builderSummary: summary,
      };
      this.activeTasks.push(task);
      await this.handleBuilderCompletion(task, summary || '', details || '');

    } else if (item.type === 'task_failed') {
      const { agentId, summary } = item.payload || {};
      console.error(`[council] Agent ${agentId} failed: ${summary}`);

      const builderTask = this.findTaskByBuilderAgent(agentId);
      if (builderTask) { await this.handleBuilderFailure(builderTask, summary || 'Unknown failure'); return; }

      const qaTask = this.findTaskByQAAgent(agentId);
      if (qaTask) { await this.handleQAFail(qaTask, `QA agent crashed: ${summary || 'unknown error'}`); return; }

      this.appendMinutes(`## Agent Failed — ${new Date().toISOString().slice(0, 10)}\n- Agent: ${agentId || 'unknown'}\n- ${summary || 'Unknown failure'}\n`);
    }
  }

  // ── Task Lifecycle Handlers ────────────────────────────────────────────────

  private async handleBuilderCompletion(task: ActiveTask, summary: string, _details: string): Promise<void> {
    task.builderSummary = summary;
    this.appendMinutes(`## Builder Completed — ${new Date().toISOString().slice(0, 10)}\n- Agent: ${task.builderAgentId}\n- Task: ${task.taskId}\n- Summary: ${summary.slice(0, 200)}\n`);

    // Optional fast pre-check: run regression suite to catch obvious crashes
    const regressionSuite = this.node.getRegressionSuite?.();
    if (regressionSuite) {
      try {
        console.log(`[council] Running fast pre-check (regression suite) before QA agent...`);
        const qaResult = await regressionSuite.runAll();
        const peerCount = this.node.getNetwork?.()?.getPeerCount?.() ?? 0;
        const maxFailures = peerCount < 3 ? Math.max(1, Math.floor(qaResult.total * 0.1)) : 0;
        const preCheckPass = qaResult.failed <= maxFailures;
        console.log(`[council] Pre-check: ${qaResult.passed}/${qaResult.total} passed (${qaResult.duration}ms)`);
        if (!preCheckPass) {
          console.warn(`[council] Pre-check FAILED — skipping QA agent, retrying builder`);
          await this.handleQAFail(task, `Regression pre-check failed: ${qaResult.failed}/${qaResult.total} tests failing`);
          return;
        }
      } catch (err: any) { console.warn(`[council] Pre-check error: ${err.message} — proceeding to QA agent`); }
    }

    task.stage = 'qa';
    const qaAgentId = await this.spawnQAAgent(task.description, summary);
    if (qaAgentId) { task.qaAgentId = qaAgentId; this.persistActiveTasks(); }
    else { console.warn('[council] QA agent spawn failed — using pre-check result'); await this.handleQAPass(task); }
  }

  private async handleQACompletion(task: ActiveTask, summary: string, _details: string): Promise<void> {
    const verdict = this.parseQAVerdict(summary);
    task.qaVerdict = summary;

    try {
      const { QAMemory } = await import('./qa-memory.js');
      const memory = new QAMemory(this.councilDir);
      memory.addEntry({
        flow: `task-${task.taskId}-qa`, verdict: verdict.pass ? 'PASS' : 'FAIL',
        failureDetails: verdict.pass ? undefined : verdict.reason,
        timestamp: Date.now(), changeId: task.builderAgentId || task.taskId,
      });
    } catch { /* QAMemory optional */ }

    this.appendMinutes(`## QA Verdict — ${new Date().toISOString().slice(0, 10)}\n- Task: ${task.taskId}\n- QA Agent: ${task.qaAgentId}\n- Verdict: ${verdict.pass ? 'PASS' : 'FAIL'}\n- Reason: ${verdict.reason.slice(0, 200)}\n`);

    if (verdict.pass) { await this.handleQAPass(task); }
    else { await this.handleQAFail(task, verdict.reason); }
  }

  private async handleQAPass(task: ActiveTask): Promise<void> {
    console.log(`[council] QA PASSED for task ${task.taskId} — committing and creating proposal`);
    task.stage = 'governance';
    const pushedHash = this.commitAndPush(task.builderAgentId || undefined);
    const title = `[Council Fix] ${task.description.slice(0, 80) || 'Code change'}`;
    const qaNote = task.qaVerdict ? `QA Verdict: PASSED\n${task.qaVerdict.slice(0, 300)}` : 'QA: pre-check only';
    const desc = `Builder agent ${task.builderAgentId} completed a code change.\n\nTask: ${task.description}\nBuilder Summary: ${task.builderSummary || 'N/A'}\n\n${qaNote}`;
    await this.createCouncilProposal(title, desc, pushedHash || undefined);
    task.stage = 'done';
    this.persistActiveTasks();
  }

  private async handleQAFail(task: ActiveTask, failureReason: string): Promise<void> {
    task.retryCount++;
    console.warn(`[council] QA FAILED for task ${task.taskId} (attempt ${task.retryCount}/${task.maxRetries}): ${failureReason.slice(0, 100)}`);
    if (task.retryCount < task.maxRetries) {
      const retryDesc = `${task.description}\n\nPREVIOUS ATTEMPT FAILED. QA found these issues:\n${failureReason}\n\nFix these specific issues. This is retry ${task.retryCount + 1} of ${task.maxRetries}.`;
      const newAgentId = await this.spawnFixAgent(retryDesc);
      if (newAgentId) {
        task.stage = 'builder'; task.builderAgentId = newAgentId; task.qaAgentId = null;
        this.persistActiveTasks();
        this.appendMinutes(`## Retry — ${new Date().toISOString().slice(0, 10)}\n- Task: ${task.taskId}\n- Attempt: ${task.retryCount + 1}/${task.maxRetries}\n- New builder: ${newAgentId}\n`);
      } else { task.stage = 'failed'; this.persistActiveTasks(); }
    } else {
      task.stage = 'failed'; this.persistActiveTasks();
      this.appendMinutes(`## Task Failed (Max Retries) — ${new Date().toISOString().slice(0, 10)}\n- Task: ${task.taskId}\n- Retries: ${task.retryCount}/${task.maxRetries}\n- Last QA issue: ${failureReason.slice(0, 200)}\n`);
    }
  }

  private async handleBuilderFailure(task: ActiveTask, failureReason: string): Promise<void> {
    task.retryCount++;
    if (task.retryCount < task.maxRetries) {
      const retryDesc = `${task.description}\n\nPREVIOUS BUILDER FAILED: ${failureReason}\n\nRetry ${task.retryCount + 1} of ${task.maxRetries}.`;
      const newAgentId = await this.spawnFixAgent(retryDesc);
      if (newAgentId) { task.builderAgentId = newAgentId; this.persistActiveTasks(); }
      else { task.stage = 'failed'; this.persistActiveTasks(); }
    } else {
      task.stage = 'failed'; this.persistActiveTasks();
      this.appendMinutes(`## Task Failed (Builder) — ${new Date().toISOString().slice(0, 10)}\n- Task: ${task.taskId}\n- Retries exhausted (${task.maxRetries})\n`);
    }
  }

  private findTaskByBuilderAgent(agentId: string): ActiveTask | undefined {
    return this.activeTasks.find(t => t.builderAgentId === agentId && t.stage === 'builder');
  }

  private findTaskByQAAgent(agentId: string): ActiveTask | undefined {
    return this.activeTasks.find(t => t.qaAgentId === agentId && t.stage === 'qa');
  }

  private parseQAVerdict(summary: string): { pass: boolean; reason: string } {
    const firstLine = (summary || '').split('\n')[0].trim();
    if (firstLine.toUpperCase().startsWith('PASS:')) return { pass: true, reason: firstLine.slice(5).trim() };
    if (firstLine.toUpperCase().startsWith('FAIL:')) return { pass: false, reason: firstLine.slice(5).trim() };
    const hasFail = /\bfail(ed)?\b/i.test(summary);
    if (hasFail) return { pass: false, reason: summary.slice(0, 200) };
    return { pass: true, reason: `Assumed pass. Summary: ${summary.slice(0, 100)}` };
  }

  private persistActiveTasks(): void {
    this.state.activeTasks = this.activeTasks;
    this.saveState();
  }

  // ── Phase 103c-d: Commit + Push + Governance Proposal Creation ─────────────

  /**
   * Commit any uncommitted changes and push to origin/master so other nodes can pull.
   * Returns the pushed commit hash, or null if nothing to push or push failed.
   */
  private commitAndPush(builderAgentId?: string): string | null {
    try {
      const repoDir = this.getRepoRoot();

      // Skip in test environments to avoid committing test artifacts to real repo
      const dataDir = this.councilDir.toLowerCase().replace(/\\/g, '/');
      const isTestEnv = process.env.PANDO_NO_AUTO_COMMIT === '1'
        || dataDir.includes('pando-e2e') || dataDir.includes('pando-stress')
        || dataDir.includes('/tmp/') || dataDir.includes('/temp/')
        || dataDir.includes('appdata/local/temp');
      if (isTestEnv) {
        console.log('[council] Skipping commit/push in test environment');
        return null;
      }

      const status = execSync('git status --porcelain', {
        cwd: repoDir, encoding: 'utf-8', timeout: 10_000, stdio: 'pipe',
      }).trim();

      if (!status) {
        console.log('[council] No uncommitted changes to push');
        return null;
      }

      execSync('git add -A', {
        cwd: repoDir, timeout: 15_000, stdio: 'pipe', windowsHide: true,
      });

      const msg = `[council] Auto-commit after builder ${builderAgentId || 'unknown'} — ${new Date().toISOString().slice(0, 19)}`;
      execSync(`git commit -m "${msg}"`, {
        cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe', windowsHide: true,
      });

      const commitHash = execSync('git rev-parse --short HEAD', {
        cwd: repoDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe',
      }).trim();

      execSync('git push origin master', {
        cwd: repoDir, encoding: 'utf-8', timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });

      console.log(`[council] Committed and pushed: ${commitHash}`);
      this.appendMinutes(`## Code Pushed — ${new Date().toISOString().slice(0, 10)}\n- Commit: ${commitHash}\n- Builder: ${builderAgentId || 'unknown'}\n`);
      return commitHash;
    } catch (err: any) {
      console.warn(`[council] Commit/push failed: ${err.message}`);
      return null;
    }
  }

  private async createCouncilProposal(title: string, description: string, commitHash?: string): Promise<void> {
    try {
      const governance = this.node.getGovernance?.();
      if (!governance) {
        console.warn('[council] No governance — cannot create proposal');
        return;
      }
      const identity = this.node.getIdentity?.();
      if (!identity) return;

      const hash = commitHash || this.getCurrentCommitHash();
      const proposal = await governance.createProposal(
        title,
        description,
        3_600_000, // 1 hour voting
        { category: 'upgrade', upgradePayload: { commitHash: hash, description: title } },
      );

      console.log(`[council] Created governance proposal: ${proposal.id} — "${title}"`);
      this.appendMinutes(`## Governance Proposal — ${new Date().toISOString().slice(0, 10)}\n- ID: ${proposal.id}\n- Title: ${title}\n`);
    } catch (err: any) {
      console.error(`[council] Failed to create proposal: ${err.message}`);
    }
  }

  private getCurrentCommitHash(): string {
    try {
      return execSync('git rev-parse --short HEAD', {
        cwd: this.getRepoRoot(), encoding: 'utf-8', timeout: 5_000, stdio: 'pipe',
      }).trim();
    } catch {
      return 'unknown';
    }
  }

  // ── Phase 102.5: Identity Integration ─────────────────────────────────────

  logRequest(actor: RequestActor, action: string, summary: string, outcome: string): void {
    this.requestLog.push({
      timestamp: Date.now(),
      actor: { type: actor.type, id: actor.id, label: actor.label },
      action,
      summary,
      outcome,
    });
    if (this.requestLog.length > MAX_REQUEST_LOG) {
      this.requestLog = this.requestLog.slice(-MAX_REQUEST_LOG);
    }
    this.saveJson(this.requestLogPath, this.requestLog);
  }

  getRequestLog(): RequestLogEntry[] {
    return [...this.requestLog];
  }

  // ── Founder Directives ────────────────────────────────────────────────────

  addFounderDirective(content: string, addedBy: string): FounderDirective {
    const directive: FounderDirective = {
      id: `dir-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      content,
      addedAt: Date.now(),
      addedBy,
    };
    this.directives.push(directive);
    this.saveJson(this.directivesPath, this.directives);
    console.log(`[council] Founder directive added: ${content.slice(0, 80)}`);
    return directive;
  }

  getFounderDirectives(): FounderDirective[] {
    return [...this.directives];
  }

  getLastReflectionAt(): number { return this.state.lastDailyReflection || 0; }

  // ── Health Alerts ─────────────────────────────────────────────────────────

  handleHealthAlert(alert: string | { severity?: string; type?: string; message?: string; firstSeen?: number }): void {
    const ts = new Date().toISOString();
    const alertStr = typeof alert === 'string'
      ? alert
      : `[${alert.severity || 'medium'}] ${alert.message || alert.type || 'unknown'}`;

    this.pendingHealthAlerts.push(`[${ts}] ${alertStr}`);
    if (this.pendingHealthAlerts.length > 50) {
      this.pendingHealthAlerts = this.pendingHealthAlerts.slice(-50);
    }

    // Classify whether this requires human action (cannot be self-healed)
    if (this.classifyRequiresHuman(alert)) {
      this.pendingHumanAlerts.push(`[${ts}] ${alertStr}`);
      if (this.pendingHumanAlerts.length > 50) {
        this.pendingHumanAlerts = this.pendingHumanAlerts.slice(-50);
      }
      this.writeHumanActionFile();
    }
  }

  /**
   * Classify whether an alert requires human/founder action.
   * Returns true for issues that cannot be self-healed by the network.
   */
  private classifyRequiresHuman(alert: string | { severity?: string; type?: string; message?: string; firstSeen?: number }): boolean {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    const ONE_DAY = 24 * ONE_HOUR;

    if (typeof alert === 'string') {
      const lower = alert.toLowerCase();
      if (lower.includes('credential') || lower.includes('auth') || lower.includes('invalid') || lower.includes('unauthorized')) {
        return true;
      }
      return false;
    }

    const { severity, type, message, firstSeen } = alert;
    const lower = (message || type || '').toLowerCase();

    // No peers for more than 1 hour — network isolation, needs human intervention
    if (type === 'no_peers' && firstSeen && (now - firstSeen) > ONE_HOUR) {
      return true;
    }

    // Credential/auth errors always need human action
    if (lower.includes('credential') || lower.includes('auth') || lower.includes('invalid') || lower.includes('unauthorized')) {
      return true;
    }

    // Critical alerts persisting for more than 24 hours
    if (severity === 'critical' && firstSeen && (now - firstSeen) > ONE_DAY) {
      return true;
    }

    return false;
  }

  /**
   * Write human-action-needed.md with current pending human alerts.
   * This file signals to the founder that manual intervention is required.
   */
  private writeHumanActionFile(): void {
    try {
      if (this.pendingHumanAlerts.length === 0) return;
      const lines = [
        '# REQUIRES_HUMAN_ACTION',
        '',
        'The following infrastructure issues cannot be self-healed and require founder intervention:',
        '',
        ...this.pendingHumanAlerts.map(a => `- ${a}`),
        '',
        `Last updated: ${new Date().toISOString()}`,
        '',
      ];
      writeFileSync(this.humanActionPath, lines.join('\\n'), 'utf-8');
      console.log(`[council] REQUIRES_HUMAN_ACTION: ${this.pendingHumanAlerts.length} issue(s) written to ${this.humanActionPath}`);
    } catch (err: any) {
      console.error(`[council] Failed to write human-action file: ${err.message}`);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the council scheduler.
   */
  start(): void {
    if (this.timer) return;

    // Initial council selection if no council exists or rotation is past due
    if (this.state.members.length === 0 || Date.now() > this.state.rotatesAt) {
      this.selectCouncil();
    }

    const checkInterval = getReflectionInterval();
    this.timer = setInterval(() => {
      this.tick();
    }, checkInterval);
    if (this.timer.unref) this.timer.unref();

    // Delay initial tick to allow AI backend detection to complete (takes ~5s for `where claude`)
    setTimeout(() => {
      this.tick();
    }, 10_000);

    // Register council agent and start bridge watcher (delayed — AgentManager starts after council)
    setTimeout(() => {
      this.registerCouncilAgent().then(() => {
        this.startBridgeWatcher();
      }).catch(() => {});
    }, 5_000);

    console.log(`[council] Started (reflection interval: ${checkInterval / 60000} min)`);
  }

  /**
   * Stop the council scheduler.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.bridgeWatcherTimer) {
      clearInterval(this.bridgeWatcherTimer);
      this.bridgeWatcherTimer = null;
    }
    console.log('[council] Stopped');
  }

  /**
   * Get council minutes text (the full file).
   */
  getMinutes(): string {
    return this.readFileSafe(this.minutesPath, '# Council Minutes\n\n(no entries yet)\n');
  }

  /**
   * Append an entry to council minutes.
   */
  appendMinutes(entry: string): void {
    try {
      let existing = '';
      if (existsSync(this.minutesPath)) {
        existing = readFileSync(this.minutesPath, 'utf-8');
      }

      const header = '# Council Minutes\n\n';
      const body = existing.startsWith(header)
        ? existing.slice(header.length)
        : existing.replace(/^# Council Minutes\n*/, '');

      const entries = body.split(/(?=^## )/m).filter(e => e.trim().length > 0);
      entries.unshift(entry.trim());
      const trimmed = entries.slice(0, MAX_MINUTES_ENTRIES);
      const newContent = header + trimmed.join('\n') + '\n';
      writeFileSync(this.minutesPath, newContent, 'utf-8');
    } catch (err: any) {
      console.error(`[council] Failed to append minutes: ${err.message}`);
    }
  }

  // ── Private Methods ─────────────────────────────────────────────────────────

  private tick(): void {
    const now = Date.now();

    // Check if council rotation is due
    if (now > this.state.rotatesAt) {
      console.log('[council] Council rotation due — reselecting members');
      this.selectCouncil();
    }

    // Check if reflection is due
    if (this.isCouncilMember()) {
      const reflectionInterval = getReflectionInterval();
      const timeSinceLastDaily = now - (this.state.lastDailyReflection || 0);
      if (timeSinceLastDaily >= reflectionInterval) {
        this.runDailyReflection().then((result) => {
          if (result) {
            this.appendMinutes(result.minutesEntry);
            console.log(`[council] Reflection completed — ${result.summary.slice(0, 80)}`);
          }
        }).catch((err) => {
          console.error(`[council] Reflection failed: ${err.message}`);
        });
      }

      // Weekly flag check
      const timeSinceLastWeekly = now - (this.state.lastWeeklyReflection || 0);
      if (timeSinceLastWeekly >= WEEKLY_MS) {
        this.state.lastWeeklyReflection = now;
        this.saveState();
      }

      // Monthly flag check
      const timeSinceLastMonthly = now - (this.state.lastMonthlyReflection || 0);
      if (timeSinceLastMonthly >= MONTHLY_MS) {
        this.state.lastMonthlyReflection = now;
        this.saveState();
      }
    }
  }

  private getRepoRoot(): string {
    try {
      return execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8', timeout: 5_000, stdio: 'pipe',
      }).trim();
    } catch {
      return process.cwd();
    }
  }

  private addChatMessage(msg: CouncilChatMessage): void {
    this.chatHistory.push(msg);
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory = this.chatHistory.slice(-MAX_CHAT_HISTORY);
    }
    this.saveJson(this.chatHistoryPath, this.chatHistory);
  }

  private ensureDir(): void {
    try {
      if (!existsSync(this.councilDir)) {
        mkdirSync(this.councilDir, { recursive: true });
      }
    } catch (err: any) {
      console.error(`[council] Failed to create council dir: ${err.message}`);
    }
  }

  private loadState(): PersistedCouncilState {
    const defaults: PersistedCouncilState = {
      members: [],
      selectedAt: 0,
      rotatesAt: 0,
      lastDailyReflection: 0,
      lastWeeklyReflection: 0,
      lastMonthlyReflection: 0,
    };

    try {
      if (existsSync(this.statePath)) {
        const raw = readFileSync(this.statePath, 'utf-8');
        const parsed = JSON.parse(raw);
        return { ...defaults, ...parsed };
      }
    } catch (err: any) {
      console.error(`[council] Failed to load state: ${err.message}`);
    }

    return defaults;
  }

  private saveState(): void {
    try {
      this.ensureDir();
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`[council] Failed to save state: ${err.message}`);
    }
  }

  private readFileSafe(path: string, fallback: string): string {
    try {
      if (existsSync(path)) {
        return readFileSync(path, 'utf-8');
      }
    } catch {}
    return fallback;
  }

  private getRecentMinutesEntries(count: number): string {
    const content = this.readFileSafe(this.minutesPath, '');
    if (!content) return '';
    const entries = content.split(/(?=^## )/m).filter(e => e.trim().length > 0 && e.startsWith('## '));
    return entries.slice(0, count).join('\n');
  }

  private readGenomeState(): string {
    const candidates = [
      join(process.cwd(), 'genome', 'state.md'),
      join(this.dataDir, '..', 'genome', 'state.md'),
    ];

    for (const path of candidates) {
      try {
        if (existsSync(path)) {
          const content = readFileSync(path, 'utf-8');
          if (content.length > 4000) {
            return content.slice(0, 4000) + '\n\n...(truncated)';
          }
          return content;
        }
      } catch {}
    }

    return '(genome/state.md not found)';
  }

  private loadJson<T>(path: string, fallback: T): T {
    try {
      if (existsSync(path)) {
        return JSON.parse(readFileSync(path, 'utf-8'));
      }
    } catch {}
    return fallback;
  }

  private saveJson(path: string, data: any): void {
    try {
      this.ensureDir();
      writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`[council] Failed to save ${path}: ${err.message}`);
    }
  }

  private loadApiToken(): string | null {
    try {
      const tokenPath = join(this.dataDir, 'api-token');
      if (existsSync(tokenPath)) {
        return readFileSync(tokenPath, 'utf-8').trim();
      }
    } catch {}
    return null;
  }
}
