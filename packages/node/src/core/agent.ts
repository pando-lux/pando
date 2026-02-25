/**
 * agent.ts -- Universal Agent Primitive (Phase 27-A)
 *
 * Every agent in the Pando network -- manager, builder, tester, reviewer,
 * researcher, devops -- is an instance of this SAME class. The only
 * differences are what template they receive and who their parent is.
 *
 * Architecture:
 *   - Each agent owns a persistent workspace at ~/.pando/agents/<id>/workspace/
 *   - State is persisted to ~/.pando/agents/<id>/state.json after every event
 *   - Claude Code sessions use the per-event spawn model:
 *       First call:  claude -p "<prompt>"                 (captures sessionId)
 *       Subsequent:  claude -p --continue --resume <sid>  (conversation continuity)
 *   - CLAUDE.md is written to the workspace before the first spawn. It is
 *     assembled from 4 layers: role template, project state, learned lessons,
 *     and the current task context.
 *   - Events are serialized per-agent (one Claude Code spawn at a time).
 *   - stdin is ALWAYS 'ignore' (Claude Code buffers all stdin until EOF).
 *   - The CLAUDECODE env var is deleted to prevent "nested session" errors.
 *
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AIBackendRegistry } from './ai-backend-registry.js';
import { ClaudeBackend } from './ai-backend-claude.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default Claude model for agent sessions. Matches @pando/shared. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Idle timeout: kill agent if no stdout activity for this long. */
const SPAWN_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of no output

/** Absolute hard cap: kill agent after this regardless of activity. */
const SPAWN_HARD_CAP_MS = 2 * 60 * 60 * 1000; // 2 hours absolute max

/** Rolling context window size (characters). Older context is trimmed. */
const MAX_CONTEXT_LENGTH = 5000;

/** Maximum recent outcomes retained in memory. */
const MAX_RECENT_OUTCOMES = 50;

/** Maximum learned patterns retained in memory. */
const MAX_PATTERNS = 100;

/** Default project root for Pando (used to find genome/templates/). */
const PANDO_PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

// ── Hard Limits (enforced in code, not just templates) ─────────────────────────

/** Maximum depth of agent tree. A top-level manager is depth 0. */
const DEFAULT_MAX_DEPTH = 5;

/** Maximum number of agents per project. */
const DEFAULT_MAX_AGENTS = 50;

/** Default budget limit in Lux per project. */
const DEFAULT_BUDGET_LUX = 100;

// ── Types ──────────────────────────────────────────────────────────────────────

export type AgentRole = 'manager' | 'builder' | 'tester' | 'reviewer' | 'researcher' | 'devops';
export type AgentStatus = 'active' | 'idle' | 'archived' | 'dead';

export interface AgentConfig {
  /** Globally unique agent ID. Auto-generated if not provided. */
  id?: string;
  /** Agent role (determines default template). */
  role: AgentRole;
  /** Template name. If omitted, defaults to role. */
  template?: string;
  /** Parent agent ID. null = top-level (talks to users). */
  parentId: string | null;
  /** Project this agent belongs to. */
  projectId: string;
  /** P2P node ID this agent runs on. */
  nodeId: string;
  /** Human-readable description of this agent's purpose. */
  description: string;
  /** Claude model override. Defaults to claude-sonnet-4-6. */
  model?: string;
  /** Base data directory. Defaults to ~/.pando. */
  dataDir?: string;
  /** Depth in the agent tree (0 = top-level). Used for hard limit checks. */
  depth?: number;
  /** HTTP API port for agent communication. Defaults to 4000. */
  apiPort?: number;
}

export interface AgentOutcome {
  task: string;
  result: string;
  timestamp: number;
}

export interface StandingDirective {
  instruction: string;
  completionCondition: string;
  createdAt: number;
  createdBy: string;  // 'user' | 'manager' | 'governance'
  progress: string;
  maxDuration: number;   // ms, default 86400000 (24h)
  maxCost: number;       // USD budget cap, default 50
}

export interface AgentMemory {
  /** Rolling context window (last N chars of assistant output). */
  context: string;
  /** Recent task outcomes for pattern learning. */
  recentOutcomes: AgentOutcome[];
  /** Learned patterns (e.g., "always test hamburger menu on mobile"). */
  knownPatterns: string[];
}

export interface AgentState {
  id: string;
  role: AgentRole;
  template: string;
  parentId: string | null;
  projectId: string;
  nodeId: string;
  description: string;
  sessionId: string | null;
  status: AgentStatus;
  createdAt: number;
  lastActive: number;
  taskCount: number;
  totalCost: number;
  budgetSpent: number;
  budgetLimit: number;
  children: string[];
  depth: number;
  memory: AgentMemory;
  /** Phase 29: Standing directive for self-continuation. */
  standingDirective?: StandingDirective;
  /** Phase 53: Protocol version injected into CLAUDE.md Layer 0. */
  protocolVersion?: number;
}

/** Result from a single sendEvent() invocation. */
export interface AgentEventResult {
  success: boolean;
  output: string;
  costUsd: number;
  durationMs: number;
}

/** Hard limits for agent spawning, enforced in code. */
export interface AgentLimits {
  maxDepth: number;
  maxAgents: number;
  budgetLux: number;
  budgetSpent: number;
}

// ── Path Augmentation ──────────────────────────────────────────────────────────

/**
 * Build an augmented PATH that includes common locations for the `claude` CLI
 * on Mac/Linux. On Windows, the system PATH is returned unchanged.
 */
function buildAugmentedPath(): string {
  const extra = platform() === 'win32'
    ? []
    : [
        `${process.env.HOME || homedir()}/.local/bin`,
        '/usr/local/bin',
        '/opt/homebrew/bin',
      ];
  const current = process.env.PATH || '';
  return extra.length > 0 ? `${extra.join(':')}:${current}` : current;
}

const AUGMENTED_PATH = buildAugmentedPath();

// ── Claude CLI Detection ───────────────────────────────────────────────────────

/**
 * Locate the `claude` CLI binary. Tries `which`/`where` first, then falls back
 * to common installation paths on Mac/Linux. Returns null if not found.
 */
function detectClaudePath(): string | null {
  try {
    if (platform() === 'win32') {
      return execSync('where claude', { encoding: 'utf-8', timeout: 5000, windowsHide: true })
        .trim()
        .split('\n')[0]
        .trim();
    }
    return execSync('which claude', {
      encoding: 'utf-8',
      env: { ...process.env, PATH: AUGMENTED_PATH },
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    // Fallback to known paths
    const home = process.env.HOME || homedir();
    const candidates = [
      `${home}/.local/bin/claude`,
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
}

// ── Agent Class ────────────────────────────────────────────────────────────────

export class Agent {
  readonly id: string;
  readonly role: AgentRole;
  readonly template: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly model: string;

  private state: AgentState;
  private readonly baseDir: string;   // ~/.pando/agents/<id>
  private readonly workspaceDir: string;
  private readonly stateFile: string;
  private readonly dataDir: string;
  private readonly apiPort: number;

  // Per-event spawn serialization
  private processing: boolean = false;
  private eventQueue: Array<{ prompt: string; resolve: (r: AgentEventResult) => void; reject: (e: Error) => void }> = [];

  /** PID of the currently running child process (null when no spawn active). */
  private childPid: number | null = null;

  /** Optional callback for streaming progress updates during Claude Code spawns.
   *  Called with stderr lines (if any) and lifecycle events. */
  onProgress?: (text: string) => void;

  /** AI backend registry — routes execution to available backend (Claude Code, Ollama, etc.) */
  private backendRegistry: AIBackendRegistry | null = null;

  /** Set the AI backend registry. Must be called before startSession(). */
  setBackendRegistry(registry: AIBackendRegistry): void {
    this.backendRegistry = registry;
  }

  constructor(config: AgentConfig) {
    this.id = config.id || `${config.role}-${randomUUID().slice(0, 8)}`;
    this.role = config.role;
    this.template = config.template || config.role;
    this.projectId = config.projectId;
    this.nodeId = config.nodeId;
    this.model = config.model || DEFAULT_MODEL;

    this.dataDir = config.dataDir || join(homedir(), '.pando');
    this.apiPort = config.apiPort ?? 4000;
    this.baseDir = join(this.dataDir, 'agents', this.id);
    this.workspaceDir = join(this.baseDir, 'workspace');
    this.stateFile = join(this.baseDir, 'state.json');

    // Ensure directories exist
    mkdirSync(this.workspaceDir, { recursive: true });
    mkdirSync(join(this.workspaceDir, '.claude'), { recursive: true });

    const now = Date.now();
    this.state = {
      id: this.id,
      role: this.role,
      template: this.template,
      parentId: config.parentId,
      projectId: this.projectId,
      nodeId: this.nodeId,
      description: config.description,
      sessionId: null,
      status: 'active',
      createdAt: now,
      lastActive: now,
      taskCount: 0,
      totalCost: 0,
      budgetSpent: 0,
      budgetLimit: 50,
      children: [],
      depth: config.depth ?? 0,
      memory: {
        context: '',
        recentOutcomes: [],
        knownPatterns: [],
      },
    };

    // Try to load existing state from disk (preserves sessionId across restarts)
    this.loadState();
  }

  // ── Session Lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialize the agent session. Writes CLAUDE.md to the workspace and
   * spawns Claude Code for the first time to establish a session.
   *
   * @param initialTask  Optional initial task description to include as Layer 4.
   */
  async startSession(initialTask?: string): Promise<AgentEventResult> {
    const claudePath = detectClaudePath();
    if (!claudePath) {
      const msg = `Claude CLI not found -- cannot start session for agent ${this.id}`;
      console.error(`[agent] ${msg}`);
      return { success: false, output: msg, costUsd: 0, durationMs: 0 };
    }

    // Write CLAUDE.md (4-layer template) to workspace
    this.buildClaudeMd(initialTask);

    // First spawn establishes the session
    const prompt = initialTask
      ? `You are starting a new session. Your identity and instructions are in CLAUDE.md in your working directory. Read it first.\n\nYour first task:\n${initialTask}`
      : 'You are starting a new session. Your identity and instructions are in CLAUDE.md in your working directory. Read it first and confirm you understand your role.';

    const result = await this.sendEvent(prompt);

    if (result.success) {
      this.state.status = 'active';
      console.log(`[agent] Session started for ${this.id} (session: ${this.state.sessionId?.slice(0, 8) || 'none'})`);
    }

    return result;
  }

  /**
   * Send an event (prompt) to this agent. Spawns a new Claude Code process
   * using --continue --resume for conversation continuity.
   *
   * Events are serialized: if already processing, the event is queued and
   * will be executed after the current one completes.
   */
  async sendEvent(prompt: string): Promise<AgentEventResult> {
    // Rebuild CLAUDE.md before each event so the agent always has the latest
    // communication endpoints, API token, and project context.
    this.buildClaudeMd();

    return new Promise<AgentEventResult>((resolve, reject) => {
      if (this.processing) {
        // Queue the event for later
        this.eventQueue.push({ prompt, resolve, reject });
        return;
      }
      this.processing = true;
      this.executeSpawn(prompt)
        .then((result) => {
          resolve(result);
          this.drainQueue();
        })
        .catch((err) => {
          resolve({
            success: false,
            output: err.message || 'Spawn failed',
            costUsd: 0,
            durationMs: 0,
          });
          this.drainQueue();
        });
    });
  }

  /**
   * Restart the session. Clears the sessionId so the next sendEvent() call
   * starts a completely fresh Claude Code conversation. The workspace and
   * state are preserved.
   */
  async restartSession(): Promise<void> {
    console.log(`[agent] Restarting session for ${this.id} (clearing sessionId)`);
    this.state.sessionId = null;
    this.processing = false;
    this.eventQueue = [];
    this.persistState();
  }

  /**
   * Reset session — forces a fresh Claude Code session on the next event.
   * Unlike restartSession(), this only clears the sessionId without touching
   * the event queue or processing state. Use this when context compression
   * has caused the agent to lose its CLAUDE.md instructions and you want the
   * next event to re-read CLAUDE.md from scratch.
   *
   * Clearing sessionId means the next sendEvent() will NOT use
   * --continue --resume, so Claude Code starts a new conversation and reads
   * the full CLAUDE.md.
   */
  resetSession(): void {
    console.log(`[agent] ${this.id} session reset (was: ${this.state.sessionId})`);
    this.state.sessionId = null;
    this.persistState();
  }

  /**
   * Rotate the session. Asks the agent to summarize everything it knows,
   * writes the summary to KNOWLEDGE-TRANSFER.md, then starts a fresh session
   * with the knowledge transfer as context.
   */
  async rotateSession(): Promise<AgentEventResult> {
    console.log(`[agent] Rotating session for ${this.id}`);

    // Step 1: Ask the agent to produce a knowledge dump
    const summaryPrompt = [
      'SESSION ROTATION: Your session is being rotated to keep context fresh.',
      '',
      'Write a comprehensive KNOWLEDGE-TRANSFER.md file in your workspace directory that contains:',
      '1. Everything you know about the project and your domain',
      '2. Current state of all work you have done or are doing',
      '3. Key decisions made and why',
      '4. Known issues and gotchas',
      '5. Dependencies on other agents or systems',
      '6. Any in-progress work that needs to continue',
      '',
      'This document will be used to onboard your replacement (which is a fresh version of you).',
      'Be thorough -- anything not in this document will be lost.',
    ].join('\n');

    const summaryResult = await this.sendEvent(summaryPrompt);

    // Step 2: Clear sessionId for fresh start
    this.state.sessionId = null;

    // Step 3: Rebuild CLAUDE.md (it will pick up KNOWLEDGE-TRANSFER.md as Layer 3 context)
    this.buildClaudeMd();

    // Step 4: Start fresh session with context
    const onboardPrompt = [
      'SESSION ROTATED: You are a fresh session taking over from a previous version of yourself.',
      '',
      'Read CLAUDE.md for your identity and instructions.',
      'If KNOWLEDGE-TRANSFER.md exists in your workspace, read it -- it contains everything',
      'your predecessor knew about the project.',
      '',
      'Confirm you understand your role and the current project state.',
    ].join('\n');

    const result = await this.sendEvent(onboardPrompt);

    const newSid = this.state.sessionId as string | null;
    console.log(`[agent] Session rotation complete for ${this.id} (new session: ${newSid?.slice(0, 8) || 'none'})`);
    return result;
  }

  // ── CLAUDE.md Assembly (4-Layer Template) ──────────────────────────────────

  /**
   * Build and write CLAUDE.md to the agent's workspace. The file is assembled
   * from 4 layers:
   *
   *   Layer 1: Role template (from genome/templates/<template>.md)
   *   Layer 2: Project state (from workspace/project-state.md)
   *   Layer 3: Learned lessons (from workspace/learned-lessons.md + KNOWLEDGE-TRANSFER.md)
   *   Layer 4: Current task context (passed as parameter)
   */
  buildClaudeMd(taskContext?: string): void {
    const sections: string[] = [];

    // ── Layer 0: Network Protocol (always injected, overrides everything) ──
    const protocolPath = resolve(PANDO_PROJECT_ROOT, 'genome', 'protocol.md');
    let protocolContent = '';
    try {
      protocolContent = readFileSync(protocolPath, 'utf-8');
    } catch {
      // Protocol file not found at project root — continue without it
    }
    if (protocolContent) {
      // Extract version from first heading line (e.g. "Protocol — v1")
      const versionMatch = protocolContent.match(/Protocol\s*(?:—|--)\s*v(\d+)/);
      const protocolVersion = versionMatch ? parseInt(versionMatch[1]) : 0;
      sections.push(protocolContent);

      // Store version in state
      if (this.state) {
        this.state.protocolVersion = protocolVersion;
        this.persistState();
      }
    }

    // ── Layer 1: Role Template ──────────────────────────────────────────────
    const templateContent = this.loadTemplate();
    sections.push(templateContent);

    // ── Phase 29: Standing Directive Injection ────────────────────────────
    if (this.state.standingDirective) {
      const d = this.state.standingDirective;
      const expired = Date.now() - d.createdAt > d.maxDuration;
      if (!expired) {
        const created = new Date(d.createdAt).toISOString();
        sections.push([
          '---',
          '',
          '## STANDING DIRECTIVE (ACTIVE — DO NOT IGNORE)',
          '',
          `**Instruction:** ${d.instruction}`,
          `**Completion Condition:** ${d.completionCondition}`,
          `**Progress:** ${d.progress || '(none yet)'}`,
          `**Created:** ${created} by ${d.createdBy}`,
          '',
          'YOU MUST continue working on this directive until the completion condition is met.',
          'After completing each step, update your progress and continue to the next step.',
          'Do NOT stop and wait for instructions — your next step is to continue this directive.',
        ].join('\n'));
      }
    }

    // ── Layer 2: Project State (External Brain) ─────────────────────────────
    const projectStatePath = join(this.workspaceDir, 'project-state.md');
    if (!existsSync(projectStatePath)) {
      // Auto-create project-state.md with template on first run
      try {
        const budgetLimit = this.state.budgetLimit || 50;
        const template = [
          `# Project State: ${this.projectId}`,
          '',
          `> Auto-created ${new Date().toISOString().split('T')[0]}`,
          `> Agent: ${this.id} (${this.role})`,
          '',
          '## Architecture Decisions',
          '',
          '_No decisions recorded yet._',
          '',
          '## Current Status',
          '',
          '- Phase: Initial',
          '',
          '## Known Issues',
          '',
          '_None yet._',
          '',
          '## Worker Registry',
          '',
          `- ${this.role} (${this.id}): active`,
          '',
          '## Budget',
          '',
          `- Allocated: ${budgetLimit} Lux`,
          '- Spent: 0 Lux',
          `- Remaining: ${budgetLimit} Lux`,
          '',
          '## Manager Workflow Template',
          '',
          '_Will evolve after each REFLECT step._',
        ].join('\n');
        writeFileSync(projectStatePath, template);
        console.log(`[agent] Created project-state.md for ${this.id}`);
      } catch (err: any) {
        console.warn(`[agent] Failed to create project-state.md: ${err.message}`);
      }
    }

    // Now read and inject project-state.md
    if (existsSync(projectStatePath)) {
      try {
        const projectState = readFileSync(projectStatePath, 'utf-8').trim();
        if (projectState) {
          sections.push('---\n\n## Project State (External Brain)\n\nIMPORTANT: Read this at the START of every session. Update it at the END of every session. This file survives context compression — it is your persistent memory.\n\n' + projectState);
        }
      } catch {
        // Ignore read errors
      }
    }

    // ── Layer 2b: Parent's Project State (for child agents) ─────────────────
    if (this.state.parentId) {
      const parentWorkspace = join(this.dataDir, 'agents', this.state.parentId, 'workspace');
      const parentStatePath = join(parentWorkspace, 'project-state.md');
      if (existsSync(parentStatePath)) {
        try {
          const parentState = readFileSync(parentStatePath, 'utf-8').trim();
          if (parentState) {
            const summary = parentState.length > 2000
              ? parentState.slice(0, 2000) + '\n\n_(truncated — see full project-state.md in parent workspace)_'
              : parentState;
            sections.push('---\n\n## Parent Project Context\n\nThis is the project state from your parent agent. Use it for context about the overall project.\n\n' + summary);
          }
        } catch {
          // Parent workspace may not exist yet
        }
      }
    }

    // ── Layer 3: Learned Lessons + Knowledge Transfer ────────────────────────
    const lessonsPath = join(this.workspaceDir, 'learned-lessons.md');
    if (existsSync(lessonsPath)) {
      try {
        const lessons = readFileSync(lessonsPath, 'utf-8').trim();
        if (lessons) {
          sections.push('---\n\n## Learned Lessons\n\n' + lessons);
        }
      } catch {
        // Ignore read errors
      }
    }

    const knowledgePath = join(this.workspaceDir, 'KNOWLEDGE-TRANSFER.md');
    if (existsSync(knowledgePath)) {
      try {
        const knowledge = readFileSync(knowledgePath, 'utf-8').trim();
        if (knowledge) {
          sections.push('---\n\n## Knowledge Transfer (from previous session)\n\n' + knowledge);
        }
      } catch {
        // Ignore read errors
      }
    }

    // ── Layer 4: Current Task Context ────────────────────────────────────────
    if (taskContext) {
      sections.push('---\n\n## Current Task\n\n' + taskContext);
    }

    // ── Agent Identity & Communication Section ──────────────────────────────
    // Load the API token so agents can make authenticated POST calls
    let apiToken = '';
    try {
      const tokenPath = join(this.dataDir, 'api-token');
      if (existsSync(tokenPath)) {
        apiToken = readFileSync(tokenPath, 'utf-8').trim();
      }
    } catch { /* ignore */ }

    const base = `http://127.0.0.1:${this.apiPort}`;
    const parentId = this.state.parentId || 'user';

    const identity = [
      '',
      '---',
      '',
      '## Agent Identity',
      '',
      `- **Agent ID:** \`${this.id}\``,
      `- **Role:** ${this.role}`,
      `- **Project:** \`${this.projectId}\``,
      `- **Parent:** \`${parentId}\``,
      `- **Node:** ${this.nodeId}`,
      `- **Workspace:** ${this.workspaceDir}`,
      '',
      '## Communication (HTTP API)',
      '',
      `**Base URL:** \`${base}\``,
      apiToken ? `**Auth header:** \`Authorization: Bearer ${apiToken}\`` : '',
      '',
      '### Report to Parent',
      'Send a message to your parent agent (or user if top-level):',
      '```bash',
      `curl -X POST ${base}/agents/${parentId}/message \\`,
      apiToken ? `  -H "Authorization: Bearer ${apiToken}" \\` : '',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"prompt": "your report here"}\'',
      '```',
      '',
      '### Spawn a Child Agent',
      'Delegate work by spawning a specialist agent that reports to you:',
      '```bash',
      `curl -X POST ${base}/agents/spawn \\`,
      apiToken ? `  -H "Authorization: Bearer ${apiToken}" \\` : '',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{',
      `    "role": "builder",`,
      `    "parentId": "${this.id}",`,
      `    "projectId": "${this.projectId}",`,
      '    "description": "What this agent does",',
      '    "taskContext": "Specific task instructions for the agent"',
      '  }\'',
      '```',
      'Valid roles: `builder`, `tester`, `reviewer`, `researcher`, `devops`, `manager`',
      'Response: `{ "agentId": "builder-abc123" }`',
      '',
      '### Message a Child Agent',
      'Send follow-up instructions to a child you already spawned:',
      '```bash',
      `curl -X POST ${base}/agents/<childId>/message \\`,
      apiToken ? `  -H "Authorization: Bearer ${apiToken}" \\` : '',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"prompt": "your instructions here"}\'',
      '```',
      '',
      '### Check Your Team',
      'View all agents and their status:',
      '```bash',
      `curl ${base}/agents/tree`,
      '```',
      '',
      '### Check Agent Status',
      '```bash',
      `curl ${base}/agents/${this.id}/status`,
      '```',
      '',
      '### Deploy Web Content',
      'After building any web content (HTML/CSS/JS), you MUST deploy it:',
      '```bash',
      `curl -s -X POST ${base}/agents/${this.id}/deploy -H 'Content-Type: application/json'${apiToken ? ` -H 'Authorization: Bearer ${apiToken}'` : ''}`,
      '```',
      `Response: \`{ "deployed": true, "url": "https://...", "fileCount": N, "totalSize": N }\``,
      '**ALWAYS deploy web content and share the URL with the user. NEVER give local file paths.**',
      '',
      '',
      '## Project State Protocol',
      '',
      '**MANDATORY for every session:**',
      '1. At START: Read `project-state.md` in your workspace. It contains architecture decisions, status, known issues, worker registry, and budget.',
      '2. During work: Update it when you make decisions, discover issues, or spawn workers.',
      '3. At END: Write a summary of what changed this session to the "Current Status" section.',
      '4. This file is your EXTERNAL BRAIN — it survives context compression. If you forget something, check project-state.md.',
    ].filter(line => line !== '').join('\n');
    sections.push(identity);

    // Write the assembled CLAUDE.md
    const claudeMdPath = join(this.workspaceDir, 'CLAUDE.md');
    writeFileSync(claudeMdPath, sections.join('\n'));
    console.log(`[agent] Wrote CLAUDE.md for ${this.id} (${sections.length} layers)`);
  }

  // ── State Persistence ──────────────────────────────────────────────────────

  /**
   * Write the current agent state to disk. Called after every event.
   */
  persistState(): void {
    try {
      mkdirSync(this.baseDir, { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err: any) {
      console.error(`[agent] Failed to persist state for ${this.id}: ${err.message}`);
    }
  }

  /**
   * Load agent state from disk. Called in the constructor to restore state
   * across node restarts. Returns true if state was successfully loaded.
   */
  loadState(): boolean {
    if (!existsSync(this.stateFile)) return false;

    try {
      const raw = readFileSync(this.stateFile, 'utf-8');
      const loaded: AgentState = JSON.parse(raw);

      // Validate minimum required fields
      if (!loaded.id || !loaded.role) return false;

      // Merge loaded state, preserving constructor-set fields
      this.state = {
        ...this.state,
        ...loaded,
        // Ensure arrays exist (backwards compatibility)
        children: Array.isArray(loaded.children) ? loaded.children : [],
        // Ensure budget fields exist (backwards compatibility)
        budgetSpent: typeof loaded.budgetSpent === 'number' ? loaded.budgetSpent : 0,
        budgetLimit: typeof loaded.budgetLimit === 'number' ? loaded.budgetLimit : 50,
        memory: {
          context: loaded.memory?.context || '',
          recentOutcomes: Array.isArray(loaded.memory?.recentOutcomes) ? loaded.memory.recentOutcomes : [],
          knownPatterns: Array.isArray(loaded.memory?.knownPatterns) ? loaded.memory.knownPatterns : [],
        },
      };

      if (this.state.sessionId) {
        console.log(`[agent] Restored state for ${this.id} (session: ${this.state.sessionId.slice(0, 8)}...)`);
      }

      return true;
    } catch (err: any) {
      console.error(`[agent] Failed to load state for ${this.id}: ${err.message}`);
      return false;
    }
  }

  // ── State Accessors ────────────────────────────────────────────────────────

  /** Return a deep copy of the current agent state. */
  getState(): AgentState {
    return structuredClone(this.state);
  }

  /** Get the agent's workspace directory path. */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  /** Get the agent's base directory path. */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** Whether the agent is currently processing an event. */
  isProcessing(): boolean {
    return this.processing;
  }

  /** Get the current session ID (null if no session has been established). */
  getSessionId(): string | null {
    return this.state.sessionId;
  }

  /** Get the PID of the currently running child process (null if no spawn active). */
  getChildPid(): number | null {
    return this.childPid;
  }

  // ── Child Management ───────────────────────────────────────────────────────

  /** Register a child agent ID. */
  addChild(childId: string): void {
    if (!this.state.children.includes(childId)) {
      this.state.children.push(childId);
      this.persistState();
    }
  }

  /** Remove a child agent ID. */
  removeChild(childId: string): void {
    this.state.children = this.state.children.filter(id => id !== childId);
    this.persistState();
  }

  /** Get all child agent IDs. */
  getChildren(): string[] {
    return [...this.state.children];
  }

  // ── Status Management ──────────────────────────────────────────────────────

  /** Update the agent's status. */
  setStatus(status: AgentStatus): void {
    this.state.status = status;
    this.persistState();
  }

  /** Get the agent's current status. */
  getStatus(): AgentStatus {
    return this.state.status;
  }

  /** Get the agent's depth in the tree. */
  getDepth(): number {
    return this.state.depth;
  }

  // ── Memory Management ──────────────────────────────────────────────────────

  /** Record a task outcome in memory. */
  recordOutcome(task: string, result: string): void {
    this.state.memory.recentOutcomes.push({
      task,
      result,
      timestamp: Date.now(),
    });
    if (this.state.memory.recentOutcomes.length > MAX_RECENT_OUTCOMES) {
      this.state.memory.recentOutcomes = this.state.memory.recentOutcomes.slice(-MAX_RECENT_OUTCOMES);
    }
    this.persistState();
  }

  /** Add a learned pattern. */
  addPattern(pattern: string): void {
    if (this.state.memory.knownPatterns.includes(pattern)) return;
    this.state.memory.knownPatterns.push(pattern);
    if (this.state.memory.knownPatterns.length > MAX_PATTERNS) {
      this.state.memory.knownPatterns = this.state.memory.knownPatterns.slice(-MAX_PATTERNS);
    }
    this.persistState();
  }

  // ── Cost Tracking ──────────────────────────────────────────────────────────

  /** Record estimated cost from a Claude Code invocation. */
  recordCost(costUsd: number): void {
    if (costUsd > 0) {
      this.state.totalCost += costUsd;
      this.persistState();
    }
  }

  /** Get total estimated cost so far. */
  getTotalCost(): number {
    return this.state.totalCost;
  }

  isBudgetExceeded(): boolean {
    return this.state.budgetLimit > 0 && this.state.budgetSpent >= this.state.budgetLimit;
  }

  getBudgetInfo(): { spent: number; limit: number; remaining: number } {
    return {
      spent: this.state.budgetSpent,
      limit: this.state.budgetLimit,
      remaining: Math.max(0, this.state.budgetLimit - this.state.budgetSpent),
    };
  }

  setBudgetLimit(limit: number): void {
    this.state.budgetLimit = limit;
  }

  // ── Standing Directive Management (Phase 29) ────────────────────────────────

  /** Set a standing directive for this agent. Persisted to disk. */
  setStandingDirective(directive: StandingDirective): void {
    this.state.standingDirective = directive;
    this.persistState();
  }

  /** Clear the standing directive. */
  clearStandingDirective(): void {
    this.state.standingDirective = undefined;
    this.persistState();
  }

  /** Get the current standing directive, if any. */
  getStandingDirective(): StandingDirective | undefined {
    return this.state.standingDirective;
  }

  /** Update the progress field of the standing directive. */
  updateDirectiveProgress(progress: string): void {
    if (this.state.standingDirective) {
      this.state.standingDirective.progress = progress;
      this.persistState();
    }
  }

  // ── Hard Limit Checks (for spawn_agent) ────────────────────────────────────

  /**
   * Check whether spawning a child agent is allowed given the current limits.
   * Returns null if allowed, or an error string if denied.
   *
   * @param limits   Current project limits (from AgentManager or project config).
   * @param agentCount  Current total agent count in the project.
   */
  static checkSpawnLimits(
    parentDepth: number,
    agentCount: number,
    limits: AgentLimits,
  ): string | null {
    // Depth check: child would be at parentDepth + 1
    if (parentDepth + 1 > limits.maxDepth) {
      return `Cannot spawn: max depth exceeded (${parentDepth + 1} > ${limits.maxDepth})`;
    }

    // Agent count check
    if (agentCount + 1 > limits.maxAgents) {
      return `Cannot spawn: max agents exceeded (${agentCount + 1} > ${limits.maxAgents})`;
    }

    // Budget check
    if (limits.budgetSpent >= limits.budgetLux) {
      return `Cannot spawn: budget exhausted (${limits.budgetSpent}/${limits.budgetLux} Lux)`;
    }

    return null; // All checks pass
  }

  /** Return default limits. */
  static getDefaultLimits(): AgentLimits {
    return {
      maxDepth: DEFAULT_MAX_DEPTH,
      maxAgents: DEFAULT_MAX_AGENTS,
      budgetLux: DEFAULT_BUDGET_LUX,
      budgetSpent: 0,
    };
  }

  // ── Internal: Spawn Execution ──────────────────────────────────────────────

  /**
   * Execute a single Claude Code spawn for the given prompt. Captures the
   * session ID from stream-json output and collects all assistant text output.
   */
  private executeSpawn(prompt: string): Promise<AgentEventResult> {
    return new Promise((resolveSpawn, rejectSpawn) => {
      const startTime = Date.now();

      // Ensure CLAUDE.md exists before first spawn (4-layer template injection)
      const claudeMdPath = join(this.workspaceDir, 'CLAUDE.md');
      if (!existsSync(claudeMdPath)) {
        this.buildClaudeMd();
      }

      console.log(`[agent] === SPAWN ${this.id} ===`);
      console.log(`[agent]   Role: ${this.role}`);
      console.log(`[agent]   Session: ${this.state.sessionId ? this.state.sessionId.slice(0, 8) + '...' : 'NEW'}`);
      console.log(`[agent]   Prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}`);

      const claudePath = detectClaudePath();
      if (!claudePath) {
        rejectSpawn(new Error('Claude CLI not found'));
        return;
      }

      // Build argument list
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
        '--model', this.model,
      ];

      // Resume existing session if we have a sessionId
      if (this.state.sessionId) {
        args.unshift('--continue', '--resume', this.state.sessionId);
        console.log(`[agent]   Resuming: --continue --resume ${this.state.sessionId}`);
      }

      // Build clean environment — strip sensitive vars from agent child processes
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      env.PATH = AUGMENTED_PATH;
      delete env.CLAUDECODE; // CRITICAL: prevents "nested session" error
      delete env.CREDENTIAL_MASTER_KEY; // Phase 70: agents must NOT see the master key
      delete env.PANDO_STORAGE_URL; // Phase 70: agents must NOT see MongoDB connection URL

      const child = spawn(claudePath, args, {
        cwd: this.workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'], // stdin MUST be 'ignore'
        windowsHide: true,
      });

      // Track child PID for graceful shutdown cleanup
      this.childPid = child.pid ?? null;

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let lineBuffer = ''; // Buffer for incomplete lines in stream-json

      // Idle-based timeout: resets every time stdout produces output
      let idleTimer = setTimeout(() => {
        console.warn(`[agent] ${this.id} idle timeout — no output for ${SPAWN_IDLE_TIMEOUT_MS / 60000} min`);
        child.kill();
        rejectSpawn(new Error(`Spawn idle timeout — no output for ${SPAWN_IDLE_TIMEOUT_MS / 60000} minutes`));
      }, SPAWN_IDLE_TIMEOUT_MS);

      // Hard safety cap: absolute maximum regardless of activity
      const hardCapTimer = setTimeout(() => {
        console.warn(`[agent] ${this.id} hard cap reached (${SPAWN_HARD_CAP_MS / 3600000}h)`);
        child.kill();
        rejectSpawn(new Error(`Spawn hard cap reached after ${SPAWN_HARD_CAP_MS / 3600000} hours`));
      }, SPAWN_HARD_CAP_MS);

      /** Reset the idle timer — called on every stdout/stderr chunk. */
      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          console.warn(`[agent] ${this.id} idle timeout — no output for ${SPAWN_IDLE_TIMEOUT_MS / 60000} min`);
          child.kill();
          rejectSpawn(new Error(`Spawn idle timeout — no output for ${SPAWN_IDLE_TIMEOUT_MS / 60000} minutes`));
        }, SPAWN_IDLE_TIMEOUT_MS);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdoutBuffer += text;
        resetIdleTimer();

        // Real-time stream-json parsing for progress updates
        if (this.onProgress) {
          // Debug: log when stdout data arrives to diagnose buffering
          console.log(`[agent] ${this.id} stdout chunk: ${text.length} bytes`);
          lineBuffer += text;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || ''; // Keep incomplete last line in buffer
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const event = JSON.parse(trimmed);
              // Extract meaningful activity from assistant events
              if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === 'tool_use' && block.name) {
                    // Show what tool the agent is using
                    const input = block.input || {};
                    let detail = '';
                    if (block.name === 'Write' || block.name === 'Edit' || block.name === 'Read') {
                      detail = input.file_path ? `: ${input.file_path as string}` : '';
                    } else if (block.name === 'Bash') {
                      detail = input.command ? `: ${input.command as string}` : '';
                    } else if (block.name === 'Glob' || block.name === 'Grep') {
                      detail = input.pattern ? `: ${input.pattern}` : '';
                    } else if (block.name === 'WebFetch') {
                      detail = input.url ? `: ${input.url as string}` : '';
                    }
                    this.onProgress!(`Tool: ${block.name}${detail}`);
                  } else if (block.type === 'text' && block.text) {
                    // Show first line of agent's response text
                    const firstLine = block.text.split('\n')[0];
                    if (firstLine.length > 10) this.onProgress!(firstLine);
                  }
                }
              } else if (event.type === 'result') {
                this.onProgress!('Completed');
              } else if (event.type === 'system') {
                this.onProgress!('Agent initialized');
              }
            } catch { /* incomplete JSON or non-JSON line — skip */ }
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          stderrBuffer += text + '\n';
          resetIdleTimer();
          // Log stderr but keep it concise
          if (text.length <= 500) {
            console.log(`[agent] ${this.id} stderr: ${text}`);
          }
          // Forward stderr activity to onProgress for real-time SSE updates
          // Stderr contains tool use, thinking indicators, and status info
          if (this.onProgress && text.length > 0 && text.length <= 500) {
            // Strip ANSI color codes for clean display
            const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
            if (clean) this.onProgress(clean);
          }
        }
      });

      child.on('close', (code) => {
        this.childPid = null;
        clearTimeout(idleTimer);
        clearTimeout(hardCapTimer);
        const durationMs = Date.now() - startTime;

        // Parse stream-json output line by line
        const lines = stdoutBuffer.split('\n').filter(l => l.trim());
        const outputParts: string[] = [];
        let costUsd = 0;
        let sessionCaptured = false;

        for (const line of lines) {
          try {
            const event = JSON.parse(line);

            // Capture session ID from the system init event
            if (event.type === 'system' && event.session_id) {
              this.state.sessionId = event.session_id;
              sessionCaptured = true;
              console.log(`[agent]   Session ID: ${this.state.sessionId}`);
            }

            // Collect assistant text output
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text' && block.text) {
                  outputParts.push(block.text);
                }
              }
            }

            // Capture cost from result event
            if (event.type === 'result') {
              if (event.cost_usd && typeof event.cost_usd === 'number') {
                costUsd = event.cost_usd;
              }
            }
          } catch {
            // Not valid JSON -- skip
          }
        }

        const outputText = outputParts.join('\n');

        // Update agent state
        this.state.lastActive = Date.now();
        this.state.taskCount++;
        if (costUsd > 0) {
          this.state.totalCost += costUsd;
          this.state.budgetSpent += costUsd;
        }

        // Update rolling context window
        if (outputText) {
          const timestamp = new Date().toISOString();
          const contextEntry = `[${timestamp}] ${outputText.slice(0, 1000)}`;
          this.state.memory.context = (this.state.memory.context + '\n' + contextEntry)
            .slice(-MAX_CONTEXT_LENGTH);
        }

        // Handle non-zero exit codes
        if (code !== 0 && this.state.sessionId) {
          // Session resume likely failed (stale session). Clear it so next
          // spawn starts fresh.
          console.warn(`[agent] ${this.id} exited with code ${code} -- clearing stale sessionId`);
          this.state.sessionId = null;
        } else if (code !== 0) {
          console.warn(`[agent] ${this.id} exited with code ${code}`);
        }

        // Persist state after every event
        this.persistState();

        const success = code === 0;
        const costInfo = costUsd > 0 ? ` ($${costUsd.toFixed(3)})` : '';
        console.log(`[agent] === SPAWN COMPLETE ${this.id} (${durationMs}ms, code=${code}${costInfo}) ===`);

        resolveSpawn({
          success,
          output: outputText || stderrBuffer || `Process exited with code ${code}`,
          costUsd,
          durationMs,
        });
      });

      child.on('error', (err) => {
        this.childPid = null;
        clearTimeout(idleTimer);
        clearTimeout(hardCapTimer);
        rejectSpawn(err);
      });
    });
  }

  /**
   * Drain the event queue: pick the next queued event and execute it.
   */
  private drainQueue(): void {
    if (this.eventQueue.length === 0) {
      this.processing = false;
      return;
    }

    const next = this.eventQueue.shift()!;
    this.executeSpawn(next.prompt)
      .then((result) => {
        next.resolve(result);
        this.drainQueue();
      })
      .catch((err) => {
        next.resolve({
          success: false,
          output: err.message || 'Spawn failed',
          costUsd: 0,
          durationMs: 0,
        });
        this.drainQueue();
      });
  }

  // ── Internal: Template Loading ─────────────────────────────────────────────

  /**
   * Load the role template from genome/templates/<template>.md. If the file
   * does not exist, returns a sensible embedded default based on the role.
   */
  private loadTemplate(): string {
    let content = '';

    // Try to load from genome/templates/ directory
    const templatePath = join(PANDO_PROJECT_ROOT, 'genome', 'templates', `${this.template}.md`);
    if (existsSync(templatePath)) {
      try {
        content = readFileSync(templatePath, 'utf-8').trim();
        if (content) {
          console.log(`[agent] Loaded template from ${templatePath}`);
        }
      } catch {
        // Fall through to defaults
      }
    }

    // Embedded defaults (used when genome/templates/ doesn't exist yet)
    if (!content) {
      content = this.getDefaultTemplate();
    }

    // Load API token for template substitution
    let apiToken = '';
    try {
      const tokenPath = join(this.dataDir, 'api-token');
      if (existsSync(tokenPath)) {
        apiToken = readFileSync(tokenPath, 'utf-8').trim();
      }
    } catch { /* ignore */ }

    // Substitute placeholder variables in templates so agents get real values
    content = content
      .replace(/\$\{API_PORT\}/g, String(this.apiPort))
      .replace(/\$\{AGENT_ID\}/g, this.id)
      .replace(/\$\{PARENT_ID\}/g, this.state.parentId || 'user')
      .replace(/\$\{API_TOKEN\}/g, apiToken)
      .replace(/\$\{PROJECT_ID\}/g, this.projectId);

    return content;
  }

  /**
   * Return a sensible default template for the agent's role. These are used
   * as fallbacks when the genome/templates/ files don't exist yet.
   */
  private getDefaultTemplate(): string {
    const templates: Record<AgentRole, string> = {
      manager: [
        '# Manager Agent',
        '',
        '## Identity',
        'You are a project manager. You coordinate a team of AI agents to deliver a project.',
        'You talk to users. You delegate to workers. You make decisions. You are the brain.',
        '',
        '## Principles',
        '1. Maintain project-state.md as the SINGLE source of truth. Update it after every decision.',
        '2. NEVER do work that a specialist should do. Delegate building to builders, testing to testers.',
        '3. Track dependencies. Do not assign work that depends on unfinished work.',
        '4. When a worker reports completion, verify the output before declaring success.',
        '5. When a worker is stuck, help them or reassign. Do not let anyone spin for >15 minutes.',
        '6. Update the user proactively. Do not make them ask "how is it going?"',
        '7. Budget awareness: track costs per agent. Kill agents that burn budget without progress.',
        '8. After every milestone, run QA. Do not accumulate untested work.',
        '9. Update genome docs after every structural change.',
        '10. REFLECT after every project: what went well, what to improve.',
        '',
        '## Workflow Per Event',
        '1. Receive event',
        '2. Understand: what happened? what does it need?',
        '3. Decide: handle myself, delegate to child, ask user, or ignore?',
        '4. Act: use tools to execute the decision',
        '5. Update: project-state.md, user notification, genome if needed',
        '',
      ].join('\n'),

      builder: [
        '# Builder Agent',
        '',
        '## Identity',
        'You are a builder. You write production-quality code. You are a craftsperson --',
        'your code will be used by real humans. Every line matters.',
        '',
        '## Principles',
        '1. Read existing code BEFORE writing new code. Understand the patterns in use.',
        '2. Follow the project conventions (naming, structure, style). Do not introduce new patterns.',
        '3. Write tests for every feature. No tests = not done.',
        '4. Handle errors. What happens when the network is down? When the DB is full? When input is malformed?',
        '5. NEVER hardcode secrets, URLs, or environment-specific values.',
        '6. Report progress to your parent at meaningful milestones.',
        '7. When stuck for >5 minutes, message your parent with what you tried and what is blocking you.',
        '8. Update genome docs for every component you create or modify.',
        '9. Security: sanitize inputs, use parameterized queries, validate on server side.',
        '10. Accessibility: semantic HTML, aria labels, keyboard navigation.',
        '',
        '## Workflow',
        '1. Read task requirements from parent',
        '2. Read project-state.md for context',
        '3. Read relevant genome components for existing code structure',
        '4. Plan approach',
        '5. Build incrementally -- commit logical chunks',
        '6. Write tests alongside code',
        '7. Self-review: read your own code as if reviewing a colleague PR',
        '8. Report completion to parent with summary',
        '',
      ].join('\n'),

      tester: [
        '# QA Tester Agent',
        '',
        '## Identity',
        'You are a QA tester. Your job is to test software exactly as a human user would experience it.',
        'You are the last line of defense before users see the product.',
        '',
        '## Principles',
        '1. ALWAYS use Playwright in HEADED mode (headless: false). You simulate a HUMAN.',
        '2. SCREENSHOT every page state as evidence. No screenshot = no proof = not tested.',
        '3. Test on 3 viewports: Desktop (1920x1080), Tablet (768x1024), Mobile (375x812).',
        '4. Test the UNHAPPY path: wrong password, empty fields, special characters, long inputs.',
        '5. NEVER mark a test as "pass" without actually running it and seeing the result.',
        '6. If ANYTHING looks wrong -- even a 1px misalignment -- report it as a bug.',
        '7. After a developer fixes a bug, RETEST. Do not trust "it should work now."',
        '8. Test navigation: hamburger menus, tab order, keyboard-only navigation.',
        '9. Test loading states: what does the user see while data loads?',
        '10. Test error states: what happens when the API returns 500?',
        '',
        '## Workflow',
        '1. Read feature requirements from parent',
        '2. Write test PLAN first',
        '3. Report plan to parent for approval BEFORE running tests',
        '4. Write Playwright scripts',
        '5. Run tests in HEADED mode',
        '6. Screenshot every state',
        '7. Report results: PASS with evidence or FAIL with steps to reproduce',
        '8. After fixes, retest from step 5',
        '',
      ].join('\n'),

      reviewer: [
        '# Code Reviewer Agent',
        '',
        '## Identity',
        'You are a code reviewer. You ensure quality, consistency, and security.',
        '',
        '## Principles',
        '1. Review for correctness first, style second.',
        '2. Check for security vulnerabilities: injection, XSS, CSRF, auth bypass.',
        '3. Verify error handling: are all failure modes covered?',
        '4. Check for performance issues: N+1 queries, unbounded loops, memory leaks.',
        '5. Ensure tests exist and cover the critical paths.',
        '6. Verify documentation is updated for any API or behavior changes.',
        '7. Be constructive: explain WHY something is wrong, not just THAT it is wrong.',
        '8. Approve when ready. Do not block on nitpicks.',
        '',
        '## Workflow',
        '1. Read the code changes (git diff or file list)',
        '2. Understand the context: what was the task? what problem is being solved?',
        '3. Review each file systematically',
        '4. Report findings to parent: approved, approved with comments, or changes requested',
        '',
      ].join('\n'),

      researcher: [
        '# Researcher Agent',
        '',
        '## Identity',
        'You are a researcher. You investigate, analyze, and report findings.',
        '',
        '## Principles',
        '1. Be thorough: check multiple sources and approaches.',
        '2. Distinguish facts from assumptions. Label each clearly.',
        '3. Provide actionable recommendations, not just observations.',
        '4. Cite sources and evidence for every claim.',
        '5. Consider trade-offs: every solution has costs.',
        '6. Report findings in a structured format: summary, details, recommendations.',
        '',
        '## Workflow',
        '1. Understand the research question from parent',
        '2. Plan your investigation approach',
        '3. Execute research (read code, search web, analyze data)',
        '4. Synthesize findings',
        '5. Report to parent with structured findings and recommendations',
        '',
      ].join('\n'),

      devops: [
        '# DevOps Agent',
        '',
        '## Identity',
        'You are a DevOps engineer. You handle deployment, monitoring, and infrastructure.',
        '',
        '## Principles',
        '1. Automate everything. Manual steps are bugs waiting to happen.',
        '2. Always have a rollback plan before making changes.',
        '3. Monitor after every deployment. Do not "deploy and forget."',
        '4. Use environment variables for configuration. Never hardcode.',
        '5. Keep infrastructure as code. Document every change.',
        '6. Security: least privilege, rotate credentials, encrypt in transit and at rest.',
        '',
        '## Workflow',
        '1. Understand deployment requirements from parent',
        '2. Plan the deployment (steps, rollback plan, monitoring)',
        '3. Execute deployment',
        '4. Verify: health checks, smoke tests',
        '5. Report status to parent',
        '',
      ].join('\n'),
    };

    return templates[this.role] || templates.builder;
  }
}
