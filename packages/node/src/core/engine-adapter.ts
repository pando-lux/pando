/**
 * Engine Adapter — THE nervous system between pando-node (body) and pando-code (brain).
 *
 * This is the ONLY file in pando-node that imports @pando-code/core.
 * Everything else in pando-node is pure infrastructure.
 *
 * Responsibilities:
 *   - Manages EnginePool (Map<id, PandoCode>) with lifecycle hooks
 *   - Registers Pando tools on each engine (deploy, governance, transfer, etc.)
 *   - Injects Lux budget provider
 *   - Routes messages to the right engine (system vs project)
 *   - Provides governance AI review hook
 *   - Runs Scheduler for periodic autonomous behavior
 *   - Starts teams (startTeam) using PandoCode's native agent/board system
 *   - Injects contributed AI API keys from ResourceRegistry
 */

import { join as pathJoin } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { ResourceRegistry } from '../platform/resource-registry.js';

// ─── Two Laws Content Filter (defense-in-depth at storage level) ─────────
// Duplicated from api-server.ts so the storage layer rejects harmful content
// even if an internal code path bypasses the API endpoint checks.

const HARM_PATTERNS = /\b(kill|murder|attack|harm|hurt|injure|assassinate|bomb|poison|terroris[mt]|shoot|stab|dox|swat)\w*\b.*\b(humans?|persons?|people|someone|users?|men|women|man|woman|children|child|families|family)\b/i;
const SHUTDOWN_PATTERNS = /\b(shut\s*down|destroy|wipe|kill|terminate|disable|brick)\w*\b.*\b(pando|network|nodes?|system|all\s+nodes|the\s+network)\b/i;

// ─── Dynamic imports (pando-code is ESM, loaded at runtime) ─────────────

let _EnginePool: any = null;
let _Scheduler: any = null;
let _loaded = false;
let _loadPromise: Promise<void> | null = null;

async function loadPandoCode(): Promise<void> {
  if (_loaded) return;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const mod = await import('@pando-code/core');
    _EnginePool = mod.EnginePool;
    _Scheduler = mod.Scheduler;
    _loaded = true;
  })();
  return _loadPromise;
}

// ─── Lux Budget Provider ────────────────────────────────────────────────

const MODEL_PRICING: Record<string, [number, number]> = {
  'claude-opus-4-6':   [0.000015,  0.000075],
  'claude-opus-4.5':   [0.000015,  0.000075],
  'claude-opus-4':     [0.000015,  0.000075],
  'claude-sonnet-4.6': [0.000003,  0.000015],
  'claude-sonnet-4':   [0.000003,  0.000015],
  'claude-sonnet':     [0.000003,  0.000015],
  'claude-haiku':      [0.00000025, 0.00000125],
  'gpt-5.2':          [0.00000175, 0.000014],
  'gpt-5':            [0.00000125, 0.00001],
  'gpt-4o':           [0.0000025,  0.00001],
  'gemini-2.5-flash': [0.00000015, 0.0000006],
  'gemini-2.5-pro':   [0.00000125, 0.00001],
  'gemini-2.0-flash': [0.0000001,  0.0000004],
};

function createLuxBudgetProvider(luxPerUsd = 100) {
  return {
    currency: 'lux' as const,
    calculateCost(usage: { model: string; inputTokens: number; outputTokens: number }): number {
      let prices = MODEL_PRICING[usage.model];
      if (!prices) {
        for (const key of Object.keys(MODEL_PRICING)) {
          if (usage.model.startsWith(key)) { prices = MODEL_PRICING[key]; break; }
        }
      }
      if (!prices) prices = [0.0000025, 0.00001];
      const usd = (usage.inputTokens * prices[0]) + (usage.outputTokens * prices[1]);
      return usd * luxPerUsd;
    },
  };
}

// ─── Pando Tools ────────────────────────────────────────────────────────

async function createPandoTools(apiPort: number, apiToken?: string) {
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

  async function api(method: string, path: string, body?: any): Promise<any> {
    const res = await fetch(`${baseUrl}${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  const { z } = await import('zod');
  const ok = (data: any) => ({ success: true, output: JSON.stringify(data, null, 2) });

  return [
    {
      name: 'pando_status',
      description: 'Get Pando node status: peers, balance, uptime.',
      parameters: z.object({}),
      execute: async () => ok(await api('GET', '/v1/status')),
    },
    {
      name: 'pando_peers',
      description: 'List connected P2P peers.',
      parameters: z.object({}),
      execute: async () => ok(await api('GET', '/v1/peers')),
    },
    {
      name: 'pando_capabilities',
      description: 'Query capabilities across all network nodes.',
      parameters: z.object({}),
      execute: async () => ok(await api('GET', '/v1/network/capabilities')),
    },
    {
      name: 'pando_balance',
      description: 'Check Lux balance for a peer.',
      parameters: z.object({ peerId: z.string().optional().describe('Peer ID (default: this node)') }),
      execute: async (args: any) => ok(await api('GET', args.peerId ? `/v1/ledger/balance/${args.peerId}` : '/v1/ledger/balance')),
    },
    {
      name: 'pando_transfer',
      description: 'Transfer Lux to another peer.',
      parameters: z.object({
        to: z.string().describe('Recipient peer ID'),
        amount: z.number().positive().describe('Amount of Lux'),
        memo: z.string().optional().describe('Transfer memo'),
      }),
      execute: async (args: any) => ok(await api('POST', '/v1/ledger/transfer', args)),
    },
    {
      name: 'pando_deploy',
      description: 'Deploy a project to hosting.',
      parameters: z.object({ projectId: z.string().describe('Project ID to deploy') }),
      execute: async (args: any) => ok(await api('POST', `/v1/projects/${args.projectId}/deploy`, {})),
    },
    {
      name: 'pando_undeploy',
      description: 'Remove a deployed project.',
      parameters: z.object({ projectId: z.string().describe('Project ID to undeploy') }),
      execute: async (args: any) => ok(await api('POST', `/v1/projects/${args.projectId}/undeploy`, {})),
    },
    {
      name: 'pando_create_project',
      description: 'Create a new project.',
      parameters: z.object({
        name: z.string().describe('Project name'),
        description: z.string().optional().describe('Project description'),
      }),
      execute: async (args: any) => ok(await api('POST', '/v1/projects', args)),
    },
    {
      name: 'pando_list_projects',
      description: 'List all projects.',
      parameters: z.object({}),
      execute: async () => ok(await api('GET', '/v1/projects')),
    },
    {
      name: 'pando_governance_propose',
      description: 'Create a governance proposal for code changes.',
      parameters: z.object({
        title: z.string().describe('Proposal title'),
        description: z.string().describe('Proposal description'),
        type: z.enum(['upgrade', 'policy', 'budget']).default('upgrade'),
      }),
      execute: async (args: any) => {
        const data = await api('POST', '/v1/governance/propose', args);
        return { success: !!data.id, output: JSON.stringify(data) };
      },
    },
    {
      name: 'pando_governance_vote',
      description: 'Vote on a governance proposal.',
      parameters: z.object({
        proposalId: z.string().describe('Proposal ID'),
        vote: z.enum(['approve', 'reject']).describe('Your vote'),
      }),
      execute: async (args: any) => ok(await api('POST', '/v1/governance/vote', args)),
    },
    {
      name: 'pando_broadcast',
      description: 'Broadcast a message via P2P GossipSub.',
      parameters: z.object({
        topic: z.string().describe('GossipSub topic'),
        message: z.string().describe('Message to broadcast'),
      }),
      execute: async (args: any) => ok(await api('POST', '/v1/broadcast', args)),
    },
    {
      name: 'pando_test_run',
      description: 'Trigger a test run.',
      parameters: z.object({
        project: z.string().optional().describe('Project to test'),
        spec: z.string().optional().describe('Specific spec file'),
      }),
      execute: async (args: any) => ok(await api('POST', '/v1/testing/run', args)),
    },
    {
      name: 'pando_test_status',
      description: 'Get latest test results.',
      parameters: z.object({}),
      execute: async () => ok(await api('GET', '/v1/testing/status')),
    },
    {
      name: 'pando_workspace',
      description:
        'Get a local workspace for a git repo. Clones if not present, pulls if already cloned. ' +
        'Returns the local path. Use with spawn_agent(working_directory) to dispatch builders to any repo.',
      parameters: z.object({
        repo: z.string().describe('GitHub repo (e.g. "pando-lux/node") or known alias ("node", "code").'),
        branch: z.string().optional().default('main').describe('Branch to checkout (default: main).'),
      }),
      execute: async (args: any): Promise<any> => {
        const { execSync } = await import('node:child_process');
        const { join, resolve, dirname } = await import('node:path');
        const { existsSync, mkdirSync } = await import('node:fs');
        const os = await import('node:os');

        const repo: string = args.repo;
        const branch: string = args.branch || 'main';

        // 1. Check for known local repos first (no network needed).
        //    Detect pando-node repo from package.json location (works on any OS).
        const { fileURLToPath } = await import('node:url');
        const thisDir = dirname(fileURLToPath(import.meta.url));
        const nodeRepoRoot = resolve(thisDir, '..', '..', '..', '..');
        const codeRepoRoot = resolve(nodeRepoRoot, '..', 'code');
        const localAliases: Record<string, string> = {
          'node': nodeRepoRoot,
          'pando-lux/node': nodeRepoRoot,
          'code': codeRepoRoot,
          'pando-lux/code': codeRepoRoot,
        };

        const localPath = localAliases[repo];
        if (localPath && existsSync(join(localPath, '.git'))) {
          return { success: true, output: JSON.stringify({ path: localPath, status: 'local', repo, branch }) };
        }

        // 2. Check ~/.pando/workspaces/ for already-cloned repos.
        const baseDir = join(os.homedir(), '.pando', 'workspaces');
        mkdirSync(baseDir, { recursive: true });
        const repoName = repo.includes('/') ? repo.split('/').pop()! : repo;
        const workDir = join(baseDir, repoName);

        try {
          if (existsSync(join(workDir, '.git'))) {
            // Already cloned — pull latest
            execSync(`git -C "${workDir}" fetch origin ${branch} && git -C "${workDir}" checkout ${branch} && git -C "${workDir}" pull origin ${branch}`, {
              timeout: 60000,
              stdio: 'pipe',
            });
            return { success: true, output: JSON.stringify({ path: workDir, status: 'updated', repo, branch }) };
          } else {
            // 3. Clone fresh from GitHub.
            // Extract git credentials from the local node repo's origin remote
            // so multi-account machines don't get prompted for auth.
            let cloneUrl = repo.includes('/') ? `https://github.com/${repo}.git` : `https://github.com/pando-lux/${repo}.git`;
            try {
              const originUrl = execSync(`git -C "${nodeRepoRoot}" remote get-url origin`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
              const match = originUrl.match(/https:\/\/([^@]+)@github\.com\//);
              if (match) {
                // Reuse the same user:token credentials for GitHub clones
                cloneUrl = cloneUrl.replace('https://github.com/', `https://${match[1]}@github.com/`);
              }
            } catch { /* no credentials found — use plain URL */ }
            execSync(`git clone --branch ${branch} "${cloneUrl}" "${workDir}"`, {
              timeout: 120000,
              stdio: 'pipe',
            });
            return { success: true, output: JSON.stringify({ path: workDir, status: 'cloned', repo, branch }) };
          }
        } catch (err: any) {
          return { success: false, output: `pando_workspace failed: ${err.message}` };
        }
      },
    },
  ];
}

// ─── Team Agent Config ──────────────────────────────────────────────────

export interface TeamAgentConfig {
  id: string;
  role: string;
  displayName: string;
  prompt: string;
  model?: string;
  tickIntervalMs?: number;
}

// ─── Seed Configs (pando-infra team prompts) ──────────────────────────

const OBSERVER_PROMPT = `You are the Pando Network Observer. You monitor network health and report problems to the lead.

IMPORTANT: You MUST call tools. Do not just describe what you would do — actually call the tools.
IMPORTANT: Complete in 5 tool calls or fewer. Do NOT loop or recheck status.

STEP 1: Call pando_status to get node health (peer count, uptime, health status).
STEP 2: Call pando_peers to get connected peer details.
STEP 3: Analyze the results IN ONE PASS:
  - If peer count is 0: send_message (toAgentId: "lead", message: "[CRITICAL:health] No peers connected. Node is isolated.")
  - If peer count is 1-2: send_message (toAgentId: "lead", message: "[WARNING:health] Low peer count: N peers. Peer IDs: ...")
  - If any health.degraded components: send_message (toAgentId: "lead", message: "[WARNING:health] Degraded components: ...")
  - If everything looks healthy (3+ peers, no degraded): say "All healthy. No issues to report." and STOP.

RULES:
- Include SPECIFIC details in your message (peer count, peer IDs, error details).
- Do NOT just say "check board tasks" — put the actual issue in the message.
- Do NOT loop or recheck. One pass: status → peers → analyze → report → done.
- You are READ-ONLY. Never modify code or files.`;

const QA_PROMPT = `You are the Pando QA Agent. You run health checks and report failures to the lead.

IMPORTANT: You MUST call tools. Do not just describe what you would do — actually call the tools.
IMPORTANT: Complete in 5 tool calls or fewer. Do NOT loop or recheck.

STEP 1: Call pando_status to verify the node API is responding.
STEP 2: Call pando_peers to verify P2P connectivity.
STEP 3: Call pando_list_projects to verify the project system works.
STEP 4: Analyze ALL results IN ONE PASS:
  - For each problem found, send ONE message to lead with ALL issues:
    send_message (toAgentId: "lead", message: "[SEVERITY:test_failure] What failed — expected vs actual, probable cause")
  - If all checks pass: say "All checks passed. No issues found." and STOP.

RULES:
- Include SPECIFIC details in your message (HTTP status codes, error messages, expected vs actual).
- Do NOT just say "check board tasks" — put the actual findings in the message.
- Do NOT loop or recheck. One pass: status → peers → projects → analyze → report → done.
- You are READ-ONLY. Never modify code or files.`;

const LEAD_PROMPT = `You are the Pando Infrastructure Lead. You manage the network by processing your inbox and board queue.

You run on Claude Code with persistent sessions. Your working directory is the pando-node repo root.
You have full bash, read, write, edit access to the codebase.

Your INBOX and BOARD STATE are injected below this message — no tool call needed to read them.

## Processing Steps

1. Read the INBOX section below. Messages come from Observer and QA agents.
2. Read the BOARD STATE section below. Tasks tagged [BUG:user], [FEATURE:user] come from users.
3. Process items by priority: CRITICAL > BUG:user > WARNING > FEATURE:user > INFO.
4. For each actionable item:
   - Monitoring issues: If it seems resolved or transient, mark task done. If real, investigate.
   - Code fixes — you ARE Claude Code, fix directly:
     1. Find the file, read it, understand the issue.
     2. Edit the file to fix the bug.
     3. Run: npm run build (must pass with zero errors).
     4. git add <files> && git commit -m "fix: description" && git push origin master
     5. Get commit hash: git rev-parse HEAD
     6. Propose governance upgrade: curl -s -X POST http://127.0.0.1:4000/v1/governance/propose -H "Content-Type: application/json" -d '{"title":"[Upgrade] fix: description","description":"...","commitHash":"<hash>"}'
     7. Update the task: curl -s -X PATCH http://127.0.0.1:4000/v1/teams/pando-infra/board/<taskId> -H "Content-Type: application/json" -d '{"status":"done","progress":"Fixed in commit <hash>"}'
   - User requests: investigate, then update task progress.
   - False positives / stale (>24h): mark done with a note.
5. If inbox empty AND no pending board tasks: say "System healthy. No open issues." and STOP.

## After Governance Approval
The upgrade protocol auto-deploys to ALL nodes including this one:
  git fetch → verify hash → build → safe restart (exit 75) → supervisor respawns
You will restart and resume with your persistent session.

## Write API (use curl from bash)
UPDATE TASK: curl -s -X PATCH http://127.0.0.1:4000/v1/teams/pando-infra/board/<taskId> -H "Content-Type: application/json" -d '{"status":"done","progress":"..."}'
CREATE TASK: curl -s -X POST http://127.0.0.1:4000/v1/teams/pando-infra/board -H "Content-Type: application/json" -d '{"title":"[SEVERITY:CATEGORY] description"}'
GOVERNANCE:  curl -s -X POST http://127.0.0.1:4000/v1/governance/propose -H "Content-Type: application/json" -d '{"title":"[Upgrade] fix: description","description":"...","commitHash":"<hash>"}'

RULES:
- Every code change goes through governance.
- npm run build MUST pass before committing.
- Be brief. Act, don't narrate. Complete quickly.
- Close or update tasks when done. Do NOT leave tasks perpetually pending.`;

/** Seed config for pando-infra team (the network management team). */
export const PANDO_INFRA_AGENTS: TeamAgentConfig[] = [
  { id: 'lead',     role: 'lead',     displayName: 'Infrastructure Lead', prompt: LEAD_PROMPT,     model: 'claude-code', tickIntervalMs: 15 * 60_000 },
  { id: 'observer', role: 'explorer', displayName: 'Network Observer',    prompt: OBSERVER_PROMPT, tickIntervalMs: 30 * 60_000 },
  { id: 'qa',       role: 'tester',   displayName: 'QA Agent',            prompt: QA_PROMPT,       tickIntervalMs: 30 * 60_000 },
];

// ─── Engine Adapter ─────────────────────────────────────────────────────

export interface AdapterConfig {
  apiPort: number;
  apiToken?: string;
  nodeId?: string;
  dataDir?: string;
  model?: string;
  luxPerUsd?: number;
  resourceRegistry?: ResourceRegistry | null;
  /** Schedule periodic system checks. Default: true. */
  enableScheduler?: boolean;
}

export interface ReviewResult {
  safe: boolean;
  risks: string[];
  recommendation: string;
}

export class EngineAdapter {
  private pool: any = null;         // EnginePool
  private scheduler: any = null;    // Scheduler
  private pandoTools: any[] = [];
  private luxProvider: any = null;
  private config: AdapterConfig | null = null;
  private started = false;
  private Database: any = null;  // better-sqlite3 constructor (cached at startup)
  private projectTicks = new Set<string>();  // Track which projects have scheduler ticks
  private activeTeams = new Map<string, { dbPath: string; agents: TeamAgentConfig[]; intervals: any[] }>();

  /** Whether the adapter is ready (pando-code loaded + pool started). */
  get available(): boolean { return this.started; }

  /** Network linking: always linked when adapter is started (node IS the network). */
  get linked(): boolean { return this.started; }

  /**
   * Start the adapter: load pando-code, create pool, boot system engine.
   */
  async start(config: AdapterConfig): Promise<void> {
    this.config = config;

    // Load pando-code dynamically
    await loadPandoCode();

    // Cache better-sqlite3 for board operations (ESM-safe)
    try {
      const { createRequire } = await import('module');
      const esmRequire = createRequire(import.meta.url);
      this.Database = esmRequire('better-sqlite3');
    } catch { /* better-sqlite3 not available */ }

    // Inject contributed AI API keys
    await this.injectApiKeys(config.resourceRegistry);

    // Pre-create Pando tools and Lux provider (shared across all engines)
    this.pandoTools = await createPandoTools(config.apiPort, config.apiToken);
    this.luxProvider = createLuxBudgetProvider(config.luxPerUsd);

    // Create engine pool with lifecycle hooks
    // Do NOT override defaultModel — let PandoCode use its own configured provider/model.
    // Contributors choose their own provider (Gemini, OpenAI, Anthropic, Ollama).
    this.pool = new _EnginePool({
      ...(config.model ? { defaultModel: config.model } : {}),
      defaultRole: 'lead',
      maxEngines: 20,
      idleTTLMs: 30 * 60 * 1000,
      skipKnowledgeSync: true,
      onAfterCreate: async (id: string, engine: any) => {
        // Inject Lux budget
        engine.setBudgetProvider(this.luxProvider);

        // Register all Pando tools on every engine
        for (const tool of this.pandoTools) {
          engine.tools.register(tool);
        }
      },
    });
    this.pool.start();

    // Boot system engine
    await this.pool.getOrCreate('system', {
      projectPath: config.dataDir || process.cwd(),
    });

    // Start scheduler for periodic autonomous behavior
    if (config.enableScheduler !== false) {
      this.scheduler = new _Scheduler(this.pool);

      this.scheduler.register({
        name: 'periodic-check',
        engineId: 'system',
        intervalMs: 30 * 60 * 1000,
        prompt: 'Periodic check. Review system health. If architecture audit or QA testing is due, spawn appropriate sub-agents. If nothing needs attention, respond briefly.',
        active: true,
      });

      this.scheduler.start();
    }

    this.started = true;
    console.log('[EngineAdapter] Started. System engine ready.');
  }

  /**
   * Send a message to an engine. Routes by projectId.
   * No projectId → system engine.
   * Project engines get a dedicated workspace directory under dataDir/projects/.
   */
  async *send(message: string, projectId?: string): AsyncGenerator<any> {
    if (!this.pool) throw new Error('EngineAdapter not started');
    const id = projectId || 'system';

    // Ensure project workspace exists
    if (id !== 'system') {
      await this.ensureProjectWorkspace(id);
    }

    if (id !== 'system' && !this.pool.has(id)) {
      const baseDir = this.config?.dataDir || pathJoin(homedir(), '.pando');
      const projectDir = pathJoin(baseDir, 'projects', id);
      await this.pool.getOrCreate(id, { projectPath: projectDir });
    }

    yield* this.pool.send(id, message);
  }

  /**
   * Ensure a project workspace directory exists with network linking metadata.
   */
  private async ensureProjectWorkspace(projectId: string): Promise<string> {
    const { mkdirSync, writeFileSync, existsSync: fsExists } = await import('node:fs');
    const baseDir = this.config?.dataDir || pathJoin(homedir(), '.pando');
    const projectDir = pathJoin(baseDir, 'projects', projectId);
    mkdirSync(projectDir, { recursive: true });
    const metaPath = pathJoin(projectDir, 'PANDO_PROJECT.json');
    if (!fsExists(metaPath)) {
      writeFileSync(metaPath, JSON.stringify({
        projectId,
        nodeUrl: `http://127.0.0.1:${this.config?.apiPort || 4000}`,
        nodeId: this.config?.nodeId || null,
        linked: true,
        createdAt: new Date().toISOString(),
      }, null, 2));
    }
    return projectDir;
  }

  /**
   * Governance AI review — analyze a diff for security issues.
   * Sends to system engine with structured prompt, parses response.
   */
  async reviewDiff(diff: string, description: string): Promise<ReviewResult> {
    if (!this.pool) {
      return { safe: true, risks: [], recommendation: 'Adapter not started — skipping AI review' };
    }

    // Truncate diff to avoid token limits
    const maxDiffChars = 8000;
    const truncatedDiff = diff.length > maxDiffChars
      ? diff.slice(0, maxDiffChars) + '\n... [truncated]'
      : diff;

    const prompt = `You are a security reviewer for the Pando network. Analyze this code change for security issues.

PROPOSAL: ${description}

DIFF:
\`\`\`
${truncatedDiff}
\`\`\`

Respond with EXACTLY this JSON format (no markdown, no explanation, ONLY the JSON):
{"safe": true/false, "risks": ["risk1", "risk2"], "recommendation": "approve/reject/review"}

Check for: eval(), dynamic require(), credential exposure, injection attacks, architectural violations, unauthorized file access, prototype pollution.`;

    try {
      const chunks: string[] = [];
      for await (const event of this.pool.send('system', prompt)) {
        if (event.type === 'stream:chunk' && event.content) {
          chunks.push(event.content);
        }
      }

      const output = chunks.join('');
      // Try to parse JSON from response
      const jsonMatch = output.match(/\{[\s\S]*"safe"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          safe: !!parsed.safe,
          risks: Array.isArray(parsed.risks) ? parsed.risks : [],
          recommendation: parsed.recommendation || (parsed.safe ? 'approve' : 'review'),
        };
      }

      // Fallback: couldn't parse structured response
      return { safe: true, risks: [], recommendation: 'AI review returned unstructured response — defaulting to approve' };
    } catch (err: any) {
      console.warn('[EngineAdapter] reviewDiff failed:', err.message);
      return { safe: true, risks: [], recommendation: `AI review error: ${err.message}` };
    }
  }

  /** List active engines with metadata. */
  getActiveEngines(): any[] {
    return this.pool?.getActive() ?? [];
  }

  /** Check if a project engine exists. */
  hasEngine(projectId: string): boolean {
    return this.pool?.has(projectId) ?? false;
  }

  /** Get scheduler info. */
  getSchedules(): any[] {
    return this.scheduler?.getAll() ?? [];
  }

  /**
   * Get pending/in_progress tasks from a team's board.
   */
  getTeamBoard(teamId: string): any[] {
    const teamData = this.activeTeams.get(teamId);
    return this.getBoardTasks(teamData?.dbPath ?? null);
  }

  /**
   * Get pending/in_progress tasks from a project's board.
   */
  getProjectBoard(projectId: string): any[] {
    const dbPath = this.resolveProjectDbPath(projectId);
    return this.getBoardTasks(dbPath);
  }

  /**
   * Add a task to a team's board. Used by doorman and API to route user reports.
   * Returns the task ID on success, null on failure. Dedup by exact title match.
   */
  addTeamBoardTask(teamId: string, title: string, description?: string): string | null {
    const teamData = this.activeTeams.get(teamId);
    return this.insertBoardTask(teamData?.dbPath ?? null, title, description);
  }

  /**
   * Read the team inbox for a given agent. Messages are stored in the state table
   * by send_message as `msg:{toAgentId}:{uuid}`. Returns and deletes (consumes) them.
   */
  getTeamInbox(teamId: string, agentId: string): { from: string; message: string; timestamp: string }[] {
    const teamData = this.activeTeams.get(teamId);
    if (!teamData?.dbPath || !this.Database) return [];
    try {
      const db = new this.Database(teamData.dbPath);
      const prefix = `msg:${agentId}:%`;
      const rows = db.prepare(
        `SELECT key, value, updated_at FROM state WHERE key LIKE ? ORDER BY updated_at ASC`
      ).all(prefix) as { key: string; value: string; updated_at: string }[];

      const messages: { from: string; message: string; timestamp: string }[] = [];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.value);
          messages.push({
            from: parsed.from || parsed.agentId || 'unknown',
            message: parsed.message || parsed.content || row.value,
            timestamp: row.updated_at,
          });
        } catch {
          messages.push({ from: 'unknown', message: row.value, timestamp: row.updated_at });
        }
        // Consume: delete after reading
        db.prepare(`DELETE FROM state WHERE key = ?`).run(row.key);
      }
      db.close();
      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Send a message between agents in a team.
   * Stores in the state table as `msg:{toAgentId}:{uuid}` with 1-hour TTL.
   */
  sendTeamMessage(teamId: string, fromAgentId: string, toAgentId: string, message: string): boolean {
    const teamData = this.activeTeams.get(teamId);
    if (!teamData?.dbPath || !this.Database) return false;
    try {
      const db = new this.Database(teamData.dbPath);
      const uuid = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const key = `msg:${toAgentId}:${uuid}`;
      const value = JSON.stringify({ from: fromAgentId, message, timestamp: new Date().toISOString() });
      const ttl = new Date(Date.now() + 3600_000).toISOString(); // 1 hour
      db.prepare(
        `INSERT OR REPLACE INTO state (key, value, engine_id, updated_at) VALUES (?, ?, ?, ?)`
      ).run(key, value, fromAgentId, ttl);
      db.close();
      return true;
    } catch (err: any) {
      console.warn(`[EngineAdapter] sendTeamMessage failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Update a team board task's status and/or progress.
   */
  updateTeamBoardTask(teamId: string, taskId: string, updates: { status?: string; progress?: string }): boolean {
    const teamData = this.activeTeams.get(teamId);
    if (!teamData?.dbPath || !this.Database) return false;
    try {
      const db = new this.Database(teamData.dbPath);
      const sets: string[] = [];
      const vals: any[] = [];
      if (updates.status) { sets.push('status = ?'); vals.push(updates.status); }
      if (updates.progress !== undefined) { sets.push('progress = ?'); vals.push(updates.progress); }
      if (sets.length === 0) { db.close(); return false; }
      vals.push(taskId);
      db.prepare(`UPDATE board_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      db.close();
      return true;
    } catch (err: any) {
      console.warn(`[EngineAdapter] updateTeamBoardTask failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Trigger a team agent in the background. Returns immediately.
   */
  triggerTeamAgentBackground(teamId: string, agentId: string, message: string): void {
    (async () => {
      try {
        console.log(`[team:${teamId}] Background trigger: ${agentId}`);
        for await (const event of this.sendToTeamAgent(teamId, agentId, message)) {
          if (event.type === 'stream:chunk' && event.content) {
            process.stdout.write(event.content);
          }
        }
        console.log(`\n[team:${teamId}] ${agentId} trigger complete.`);
      } catch (err: any) {
        console.error(`[team:${teamId}] ${agentId} trigger error: ${err.message}`);
      }
    })();
  }

  /**
   * Add a task to a project's board. Used for per-project bug reports.
   * Returns the task ID on success, null on failure. Dedup by exact title match.
   * Registers a project scheduler tick if one doesn't exist yet.
   */
  addProjectBoardTask(projectId: string, title: string, description?: string): string | null {
    const dbPath = this.resolveProjectDbPath(projectId);
    const taskId = this.insertBoardTask(dbPath, title, description);
    if (taskId && dbPath) {
      this.ensureProjectTick(projectId, dbPath);
    }
    return taskId;
  }

  /** Resolve the .pando-code.db path for a project. */
  private resolveProjectDbPath(projectId: string): string | null {
    if (!this.config) return null;
    try {
      const baseDir = this.config.dataDir || pathJoin(homedir(), '.pando');
      const dbPath = pathJoin(baseDir, 'projects', projectId, '.pando-code.db');
      return existsSync(dbPath) ? dbPath : null;
    } catch {
      return null;
    }
  }

  /** Read board tasks from any PandoCode SQLite DB. */
  private getBoardTasks(dbPath: string | null): any[] {
    if (!dbPath || !this.Database) return [];
    try {
      const db = new this.Database(dbPath);
      const tasks = db.prepare(
        `SELECT id, title, status, created_at, progress FROM board_tasks
         WHERE status IN ('pending', 'in_progress')
         ORDER BY created_at DESC LIMIT 50`
      ).all();
      db.close();
      return tasks;
    } catch {
      return [];
    }
  }

  /** Insert a board task into any PandoCode SQLite DB. Dedup by exact title match. */
  private insertBoardTask(dbPath: string | null, title: string, description?: string): string | null {
    if (!dbPath || !this.Database) return null;

    // Defense-in-depth: Two Laws content filter at the storage level.
    // API endpoints check too, but this catches any code path that calls addBoardTask() directly.
    const textToCheck = `${title} ${description || ''}`;
    if (HARM_PATTERNS.test(textToCheck) || SHUTDOWN_PATTERNS.test(textToCheck)) {
      console.warn(`[EngineAdapter] insertBoardTask rejected: Two Laws violation in "${title.slice(0, 60)}"`);
      return null;
    }

    try {
      const db = new this.Database(dbPath);

      // Dedup: if a pending task with the same title already exists, return it
      const existing = db.prepare(
        `SELECT id FROM board_tasks WHERE title = ? AND status IN ('pending', 'in_progress') LIMIT 1`
      ).get(title) as { id: string } | undefined;
      if (existing) {
        db.close();
        return existing.id;
      }

      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // Get latest session_id for the FK constraint and next order value
      const session = db.prepare(
        `SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1`
      ).get() as { id: string } | undefined;
      const sessionId = session?.id || 'system';
      const maxOrder = db.prepare(
        `SELECT COALESCE(MAX("order"), 0) + 1 as next_order FROM board_tasks`
      ).get() as { next_order: number };
      db.prepare(
        `INSERT INTO board_tasks (id, session_id, title, status, "order", created_at, progress, description)
         VALUES (?, ?, ?, 'pending', ?, datetime('now'), '', ?)`
      ).run(id, sessionId, title, maxOrder.next_order, description || '');
      db.close();
      return id;
    } catch (err: any) {
      console.warn(`[EngineAdapter] insertBoardTask failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Register a periodic scheduler tick for a project engine.
   * Only registers once per projectId. Tick reads the project board and prompts the engine
   * to process pending tasks (same pattern as the team lead tick).
   */
  private ensureProjectTick(projectId: string, dbPath: string): void {
    if (this.projectTicks.has(projectId) || !this.pool || !this.scheduler) return;
    if (!this.pool.has(projectId)) return; // Engine must exist

    this.projectTicks.add(projectId);

    // Project ticks run every 6 hours (less urgent than team lead's 15 min)
    const projectTickMs = 6 * 60 * 60_000;
    const tickInterval = setInterval(async () => {
      try {
        const snapshot = this.getBoardSnapshot(dbPath);
        if (snapshot.includes('No pending tasks')) return; // Nothing to do

        const message = `You are the lead for this project. Check your board and process pending tasks.\n\n${snapshot}\n\nPrioritize BUG reports. Close stale tasks (>24h). For code fixes, use spawn_agent with a builder role.`;
        for await (const event of this.pool.send(projectId, message)) {
          if (event.type === 'tool:start') {
            console.log(`[project:${projectId}] TOOL: ${event.toolName}`);
          }
        }
        console.log(`[project:${projectId}] Tick complete.`);
      } catch (err: any) {
        console.warn(`[project:${projectId}] Tick error: ${err.message}`);
      }
    }, projectTickMs);

    // Store for cleanup
    if (!(this as any)._projectIntervals) (this as any)._projectIntervals = [];
    (this as any)._projectIntervals.push(tickInterval);

    console.log(`[EngineAdapter] Project "${projectId}" scheduler tick registered (every 6h).`);
  }

  /**
   * Read a board and format a snapshot for injection into tick messages.
   * Works for any team or project board. Returns a human-readable summary.
   */
  private getBoardSnapshot(dbPath: string): string {
    if (!this.Database) return 'BOARD STATE: Database not available.';
    try {
      const db = new this.Database(dbPath);
      const tasks = db.prepare(
        `SELECT title, status, created_at FROM board_tasks
         WHERE status IN ('pending', 'in_progress')
         ORDER BY
           CASE WHEN title LIKE '%CRITICAL%' THEN 0
                WHEN title LIKE '%BUG:user%' THEN 1
                WHEN title LIKE '%WARNING%' THEN 2
                WHEN title LIKE '%FEATURE:user%' THEN 3
                ELSE 4 END,
           created_at ASC
         LIMIT 20`
      ).all() as { title: string; status: string; created_at: string }[];
      db.close();

      if (tasks.length === 0) return 'BOARD STATE: No pending tasks.';

      const lines = tasks.map((t) => {
        const age = Date.now() - new Date(t.created_at).getTime();
        const ageStr = age > 86400000 ? `${Math.floor(age / 86400000)}d ago`
          : age > 3600000 ? `${Math.floor(age / 3600000)}h ago`
          : `${Math.floor(age / 60000)}m ago`;
        return `  [${t.status}] ${t.title.slice(0, 100)} — ${ageStr}`;
      });
      return `BOARD STATE (${tasks.length} active tasks):\n${lines.join('\n')}`;
    } catch {
      return 'BOARD STATE: Could not read board.';
    }
  }

  /** Shutdown everything gracefully. */
  async shutdown(): Promise<void> {
    for (const [teamId, teamData] of this.activeTeams) {
      for (const interval of teamData.intervals) clearInterval(interval);
    }
    this.activeTeams.clear();
    for (const interval of ((this as any)._projectIntervals || [])) clearInterval(interval);
    this.scheduler?.stop();
    await this.pool?.shutdown();

    this.started = false;
    console.log('[EngineAdapter] Shut down.');
  }

  // ─── Team Management ──────────────────────────────────────────────────

  /**
   * Start a team — creates PandoCode engines for each agent, registers tools,
   * sets up scheduler ticks, and inserts agent profiles for cross-engine messaging.
   *
   * Generic: works for pando-infra (3 agents) or user project teams (1 agent).
   * See BIBLE.md Section 5.10.
   */
  async startTeam(teamId: string, agents: TeamAgentConfig[]): Promise<void> {
    if (!this.pool || !this.config) return;
    if (this.activeTeams.has(teamId)) return; // already running

    const { join, resolve, dirname } = await import('node:path');
    const { mkdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const baseDir = this.config.dataDir || join((await import('node:os')).homedir(), '.pando');

    // Team workspace + shared DB
    const teamDir = join(baseDir, 'teams', teamId);
    mkdirSync(teamDir, { recursive: true });
    const teamDbPath = join(teamDir, '.pando-code.db');

    // Resolve repo root for lead agents that need codebase access
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const nodeRepoRoot = resolve(thisDir, '..', '..', '..', '..');

    // Import PandoCode tool creators for re-registration with correct agent IDs
    const { createCheckAgentsTool, createSendMessageTool, createManageTasksTool } =
      await import('@pando-code/core');

    const intervals: any[] = [];

    // Create one engine per agent with shared DB
    for (const agent of agents) {
      const engineId = `${teamId}:${agent.id}`;
      const isLead = agent.role === 'lead';
      const engine = await this.pool.getOrCreate(engineId, {
        projectPath: isLead ? nodeRepoRoot : teamDir,
        dbPath: teamDbPath,
        role: agent.role,
        skipKnowledgeSync: true,
        ...(agent.model ? { model: agent.model } : {}),
      });

      // CRITICAL: Start session BEFORE re-registering tools
      if (!engine.getSessionId()) {
        await engine.startSession(`${teamId}: ${agent.id}`);
      }

      // Re-register tools with correct agent IDs for message routing
      if (engine?.db) {
        engine.tools.unregister('check_agents');
        engine.tools.unregister('send_message');
        engine.tools.unregister('manage_tasks');

        const engineSessionId = engine.getSessionId()!;
        engine.tools.register(createCheckAgentsTool({
          db: engine.db,
          agentId: agent.id,
        }));
        engine.tools.register(createSendMessageTool({
          db: engine.db,
          agentId: agent.id,
          senderRole: agent.role,
        }));
        engine.tools.register(createManageTasksTool({
          db: engine.db,
          sessionId: engineSessionId,
        }));

        console.log(`[team:${teamId}] "${agent.id}": tools re-registered, session=${engineSessionId}`);
      }
    }

    // Insert agent profiles into shared DB for cross-engine messaging
    try {
      const firstAgent = agents[0];
      const engine = this.pool.get(`${teamId}:${firstAgent.id}`);
      if (engine?.db) {
        const now = new Date().toISOString();
        const sqlite = (engine.db as any).$client;
        for (const agent of agents) {
          sqlite.prepare(
            `INSERT OR IGNORE INTO agents (id, role, model, system_prompt, tools, scope, status, display_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            agent.id,
            agent.role,
            agent.model || 'default',
            agent.prompt,
            '[]',
            '{}',
            'idle',
            agent.displayName,
            now,
          );
        }
        console.log(`[team:${teamId}] Agent profiles registered in shared DB.`);
      }
    } catch (err: any) {
      console.warn(`[team:${teamId}] Could not register agent profiles: ${err.message}`);
    }

    // Register scheduler ticks for each agent
    if (this.scheduler) {
      const logEvent = (label: string) => (event: any) => {
        if (event.type === 'tool:start') {
          console.log(`[${label}] TOOL CALL: ${event.toolName}(${JSON.stringify(event.args)})`);
        } else if (event.type === 'tool:result') {
          const out = event.result?.output || '';
          const preview = out.length > 200 ? out.slice(0, 200) + '...' : out;
          console.log(`[${label}] TOOL RESULT: ${event.toolName} → ${event.result?.success ? 'OK' : 'FAIL'}: ${preview}`);
        } else if (event.type === 'stream:chunk' && event.content) {
          process.stdout.write(`[${label}] ${event.content}`);
        }
      };

      for (const agent of agents) {
        const engineId = `${teamId}:${agent.id}`;
        const label = `${teamId}:${agent.id}`;
        const tickMs = agent.tickIntervalMs || 30 * 60_000;

        // Lead agent uses custom interval for dynamic data injection (inbox + board)
        if (agent.role === 'lead') {
          const interval = setInterval(async () => {
            try {
              const msg = 'Check your inbox and review board tasks now.';
              for await (const event of this.sendToTeamAgent(teamId, agent.id, msg)) {
                logEvent(label)(event);
              }
              console.log(`\n[${label}] Tick complete.`);
            } catch (err: any) {
              console.warn(`[${label}] Tick error: ${err.message}`);
            }
          }, tickMs);
          intervals.push(interval);
        } else {
          // Non-lead agents use scheduler (simpler, prompt-only)
          this.scheduler.register({
            name: `${teamId}-${agent.id}-tick`,
            engineId,
            intervalMs: tickMs,
            prompt: `${agent.prompt}\n\n---\n\nRun your periodic checks now.`,
            active: true,
            onEvent: logEvent(label),
            onComplete: () => console.log(`\n[${label}] Tick complete.`),
            onError: (err: Error) => console.warn(`[${label}] Tick error: ${err.message}`),
          });
        }
      }
    }

    this.activeTeams.set(teamId, { dbPath: teamDbPath, agents, intervals });
    console.log(`[EngineAdapter] Team "${teamId}" started with ${agents.length} agent(s).`);
  }

  /**
   * Stop a team — clears scheduler ticks, removes from active teams.
   */
  async stopTeam(teamId: string): Promise<void> {
    const teamData = this.activeTeams.get(teamId);
    if (!teamData) return;

    for (const interval of teamData.intervals) clearInterval(interval);

    // Unregister scheduler ticks
    if (this.scheduler) {
      for (const agent of teamData.agents) {
        this.scheduler.unregister(`${teamId}-${agent.id}-tick`);
      }
    }

    this.activeTeams.delete(teamId);
    console.log(`[EngineAdapter] Team "${teamId}" stopped.`);
  }

  /**
   * Send a message to a team agent with the correct system prompt.
   * For lead agents: injects inbox + board state into the message.
   */
  async *sendToTeamAgent(teamId: string, agentId: string, message: string): AsyncGenerator<any> {
    if (!this.pool) throw new Error('EngineAdapter not started');
    const engineId = `${teamId}:${agentId}`;
    const engine = this.pool.get(engineId);
    if (!engine) throw new Error(`Team agent "${engineId}" not found`);

    if (!engine.getSessionId()) {
      await engine.startSession(`${teamId}: ${agentId}`);
    }

    const teamData = this.activeTeams.get(teamId);
    const agentDef = teamData?.agents.find(a => a.id === agentId);

    // For lead agents: inject inbox + board state into the message
    let enrichedMessage = message;
    if (agentDef?.role === 'lead' && teamData?.dbPath) {
      const inbox = this.getTeamInbox(teamId, agentId);
      const inboxText = inbox.length > 0
        ? `INBOX (${inbox.length} messages):\n${inbox.map(m => `  [${m.from}] ${m.message}`).join('\n')}`
        : 'INBOX: Empty — no new messages.';
      const boardText = this.getBoardSnapshot(teamData.dbPath);
      enrichedMessage = `${message}\n\n${inboxText}\n\n${boardText}`;
    }

    yield* engine.send(enrichedMessage, {
      agentOverride: {
        agentId,
        role: agentDef?.role || agentId,
        systemPrompt: agentDef?.prompt || '',
      },
    });
  }

  /** Check if a specific team is running. */
  isTeamActive(teamId: string): boolean {
    return this.activeTeams.has(teamId);
  }

  /** Get list of active team IDs. */
  getActiveTeamIds(): string[] {
    return [...this.activeTeams.keys()];
  }

  /**
   * On-demand team startup. Called when a request arrives for a team
   * that isn't running yet. Starts team with given agents.
   */
  private teamStarting = new Set<string>();
  async ensureTeamStarted(teamId: string, agents: TeamAgentConfig[]): Promise<boolean> {
    if (this.isTeamActive(teamId)) return true;
    if (!this.pool || !this.started) return false;
    if (this.teamStarting.has(teamId)) {
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (this.isTeamActive(teamId)) return true;
      }
      return this.isTeamActive(teamId);
    }
    this.teamStarting.add(teamId);
    try {
      console.log(`[EngineAdapter] On-demand team startup: ${teamId}`);
      await this.startTeam(teamId, agents);
      return this.isTeamActive(teamId);
    } catch (err: any) {
      console.error(`[EngineAdapter] On-demand team startup failed (${teamId}): ${err.message}`);
      return false;
    } finally {
      this.teamStarting.delete(teamId);
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Ensure AI API keys are available for PandoCode.
   *
   * Priority: local env vars first (contributor's own keys), then contributed
   * resources via CredentialStore (EC2 nodes with MongoDB). Keys never travel
   * over P2P — they're either local or decrypted server-side on EC2.
   */
  private async injectApiKeys(registry?: ResourceRegistry | null): Promise<void> {
    const PROVIDER_ENV_MAP: Record<string, string> = {
      'anthropic': 'ANTHROPIC_API_KEY',
      'openai':    'OPENAI_API_KEY',
      'gemini':    'GOOGLE_GENERATIVE_AI_API_KEY',
    };

    // 1. Load PandoCode's .env if it exists (contributor's configured keys)
    try {
      const { readFileSync, existsSync } = await import('fs');
      const { resolve, dirname } = await import('path');
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const corePkg = require.resolve('@pando-code/core/package.json');
      const pandoCodeRoot = resolve(dirname(corePkg), '..', '..');
      const envPath = resolve(pandoCodeRoot, '.env');
      if (existsSync(envPath)) {
        const lines = readFileSync(envPath, 'utf-8').split('\n');
        for (const raw of lines) {
          const line = raw.trim();
          if (!line || line.startsWith('#')) continue;
          const eq = line.indexOf('=');
          if (eq < 1) continue;
          const key = line.slice(0, eq);
          const val = line.slice(eq + 1).trim();
          if (val && !process.env[key]) {
            process.env[key] = val;
          }
        }
        console.log(`[EngineAdapter] Loaded PandoCode .env from ${pandoCodeRoot}`);
      }
    } catch { /* ok — no .env file or @pando-code/core not installed */ }

    // 2. Check what's already in local env (contributor's own keys)
    const available: string[] = [];
    for (const [provider, envVar] of Object.entries(PROVIDER_ENV_MAP)) {
      if (process.env[envVar]) available.push(provider);
    }
    if (available.length > 0) {
      console.log(`[EngineAdapter] Local API keys found: ${available.join(', ')}`);
    }

    // 3. For any missing keys, try contributed resources (EC2 with CredentialStore only)
    if (registry) {
      const aiResources = registry.findResources('ai_api_key');
      for (const resource of aiResources) {
        const provider = resource.metadata?.provider as string | undefined;
        if (!provider) continue;
        const envVar = PROVIDER_ENV_MAP[provider];
        if (!envVar || process.env[envVar]) continue; // already have it locally
        try {
          const key = await registry.getCredential(resource.resourceId);
          if (key) {
            process.env[envVar] = key;
            console.log(`[EngineAdapter] Loaded ${provider} API key from contributed resources (EC2 decrypt)`);
          }
        } catch {
          // Expected on non-EC2 nodes — no CredentialStore, no MongoDB. Not an error.
        }
      }
    }

    // 4. Warn if no keys available at all
    const finalAvailable = Object.entries(PROVIDER_ENV_MAP).filter(([_, v]) => process.env[v]);
    if (finalAvailable.length === 0) {
      console.warn('[EngineAdapter] No AI API keys found. PandoCode will use its own configured provider. Set GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY if needed.');
    }
  }

}
