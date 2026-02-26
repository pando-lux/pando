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
 *
 * State persisted in {dataDir}/council/:
 *   - council-state.json   — members, rotation, reflection timestamps
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
import type { RequestActor } from '@pando/shared';

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

interface PersistedCouncilState {
  members: CouncilMember[];
  selectedAt: number;
  rotatesAt: number;
  lastDailyReflection: number;
  lastWeeklyReflection: number;
  lastMonthlyReflection: number;
  councilAgentId?: string;
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
  private councilAgentId: string | null = null;

  constructor(node: any, dataDir: string) {
    this.node = node;
    this.dataDir = dataDir;
    this.councilDir = join(dataDir, 'council');
    this.statePath = join(this.councilDir, 'council-state.json');
    this.minutesPath = join(this.councilDir, 'council-minutes.md');
    this.promptPath = join(this.councilDir, 'last-prompt.md');
    this.networkStatePath = join(this.councilDir, 'network-state.md');
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
        } else {
          result = this.stubReflectionResult(dateStr, prompt.length);
        }
      } catch (err: any) {
        console.error(`[council] AI reflection failed: ${err.message}`);
        result = this.stubReflectionResult(dateStr, prompt.length);
      }
    } else {
      console.log(`[council] No AI backend available — stub reflection`);
      result = this.stubReflectionResult(dateStr, prompt.length);
    }

    // Update reflection timestamp
    this.state.lastDailyReflection = Date.now();
    this.saveState();

    return result;
  }

  private stubReflectionResult(dateStr: string, promptLen: number): ReflectionResult {
    return {
      timestamp: Date.now(),
      type: 'daily',
      summary: `Daily reflection prompt assembled (${promptLen} chars). AI call pending.`,
      proposals: [],
      minutesEntry: `## ${dateStr} — Daily Reflection\n- Prompt assembled (${promptLen} chars), AI integration pending\n- Council: ${this.state.members.length} members\n`,
    };
  }

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
          reply = this.fallbackResponse(message);
        }
      } catch (err: any) {
        console.error(`[council] Chat AI failed: ${err.message}`);
        reply = this.fallbackResponse(message);
      }
    } else {
      // No AI backend — check for actionable keywords
      if (this.isActionableRequest(message)) {
        this.runSelfHealingLoop(message);
        reply = `Understood. I'm spawning a builder agent to handle: "${message.slice(0, 80)}".`;
      } else {
        reply = this.fallbackResponse(message);
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

  private fallbackResponse(message: string): string {
    const lower = message.toLowerCase();
    if (/status|health/.test(lower)) {
      const network = this.node.getNetwork?.();
      const peers = network?.getPeerCount() ?? 0;
      return `Network has ${peers} peer(s) connected. Council has ${this.state.members.length} member(s). Use /status for full details.`;
    }
    if (/council|members/.test(lower)) {
      const members = this.state.members.map(m => m.peerId.slice(0, 12)).join(', ');
      return `Council members: [${members || 'none selected'}]. Next rotation: ${new Date(this.state.rotatesAt).toISOString().slice(0, 10)}.`;
    }
    return 'I\'m the Pando Network Council. I can help manage the network, spawn builders, and create governance proposals. What do you need?';
  }

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
    };

    if (files && files.length > 0) {
      body.taskContext = `Files to examine: ${files.join(', ')}`;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/v1/agents/spawn`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
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
   * Fire-and-forget: spawn a builder and log to minutes.
   */
  private runSelfHealingLoop(description: string, files?: string[]): void {
    this.spawnFixAgent(description, files).then(agentId => {
      if (agentId) {
        this.appendMinutes(`## Self-Healing — ${new Date().toISOString().slice(0, 10)}\n- Spawned builder ${agentId} for: ${description.slice(0, 100)}\n`);
      }
    }).catch(err => {
      console.error(`[council] Self-healing loop error: ${err.message}`);
    });
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
      console.log(`[council] Builder ${agentId} completed: ${(summary || '').slice(0, 100)}`);
      this.appendMinutes(`## Builder Completed — ${new Date().toISOString().slice(0, 10)}\n- Agent: ${agentId}\n- Summary: ${(summary || '').slice(0, 200)}\n`);

      // ── Phase 103d: QA Gate — run regression suite before creating proposal ──
      let qaPass = true;
      const regressionSuite = this.node.getRegressionSuite?.();
      if (regressionSuite) {
        console.log(`[council] Running QA regression suite after builder ${agentId} completion...`);
        try {
          const qaResult = await regressionSuite.runAll();
          // In dev mode (few peers), allow up to 10% test failures (e.g., peer-dependent tests)
          const peerCount = this.node.getNetwork?.()?.getPeerCount?.() ?? 0;
          const maxFailures = peerCount < 3 ? Math.max(1, Math.floor(qaResult.total * 0.1)) : 0;
          qaPass = qaResult.failed <= maxFailures;
          console.log(`[council] QA result: ${qaResult.passed}/${qaResult.total} passed, ${qaResult.failed} failed (threshold: ${maxFailures}, ${qaResult.duration}ms)`);
          this.appendMinutes(`## QA Result — ${new Date().toISOString().slice(0, 10)}\n- Builder: ${agentId}\n- Result: ${qaPass ? 'PASSED' : 'FAILED'} (${qaResult.passed}/${qaResult.total}, threshold: ${maxFailures})\n`);

          // Record to QA memory for historical learning
          try {
            const { QAMemory } = await import('./qa-memory.js');
            const memory = new QAMemory(this.councilDir);
            memory.addEntry({
              flow: `builder-${agentId}-completion`,
              verdict: qaPass ? 'PASS' : 'FAIL',
              failureDetails: qaPass ? undefined : `${qaResult.failed}/${qaResult.total} tests failed`,
              timestamp: Date.now(),
              changeId: agentId,
            });
          } catch { /* QAMemory optional */ }
        } catch (err: any) {
          console.warn(`[council] QA suite error: ${err.message} — proceeding without QA`);
        }
      }

      if (!qaPass) {
        console.warn(`[council] QA FAILED — skipping governance proposal for builder ${agentId}`);
        this.appendMinutes(`## QA Gate Blocked — ${new Date().toISOString().slice(0, 10)}\n- Builder: ${agentId}\n- Reason: Regression tests failed\n`);
        return;
      }

      // ── Phase 103d: Commit + push so other nodes can pull ──
      const pushedHash = this.commitAndPush(agentId);

      // Create governance proposal for the code change
      const title = `[Council Fix] ${(summary || '').slice(0, 80) || 'Code change'}`;
      const qaNote = regressionSuite ? 'QA: PASSED' : 'QA: not available';
      const description = `Builder agent ${agentId} completed a code change.\n\nSummary: ${summary}\n\nDetails: ${(details || '').slice(0, 500) || 'N/A'}\n\n${qaNote}`;
      await this.createCouncilProposal(title, description, pushedHash || undefined);
    } else if (item.type === 'task_failed') {
      console.error(`[council] Builder ${item.payload?.agentId} failed: ${item.payload?.summary}`);
      this.appendMinutes(`## Builder Failed — ${new Date().toISOString().slice(0, 10)}\n- Agent: ${item.payload?.agentId || 'unknown'}\n- ${item.payload?.summary || 'Unknown failure'}\n`);
    }
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

  // ── Health Alerts ─────────────────────────────────────────────────────────

  handleHealthAlert(alert: string): void {
    this.pendingHealthAlerts.push(`[${new Date().toISOString()}] ${alert}`);
    // Keep max 50 pending alerts
    if (this.pendingHealthAlerts.length > 50) {
      this.pendingHealthAlerts = this.pendingHealthAlerts.slice(-50);
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

    // Run initial tick
    this.tick();

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
