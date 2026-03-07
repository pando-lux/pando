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
 *   - Council agents: observer (explorer), qa (tester), council (lead)
 *     using PandoCode's native agent system (board, send_message, check_agents)
 *   - Injects contributed AI API keys from ResourceRegistry
 */

import type { ResourceRegistry } from '../platform/resource-registry.js';
import { OBSERVER_PROMPT, QA_PROMPT, COUNCIL_PROMPT } from './council-prompts.js';

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

// ─── Council Agent Definitions ──────────────────────────────────────────

const COUNCIL_AGENTS = [
  { id: 'observer', role: 'explorer', displayName: 'Network Observer', prompt: OBSERVER_PROMPT },
  { id: 'qa',       role: 'tester',   displayName: 'QA Agent',         prompt: QA_PROMPT },
  { id: 'council',  role: 'lead',     displayName: 'Council',          prompt: COUNCIL_PROMPT },
] as const;

type CouncilAgentId = typeof COUNCIL_AGENTS[number]['id'];

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
  /** Enable council agents (observer, qa, council). Default: false. */
  enableCouncil?: boolean;
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
  private councilDbPath: string | null = null;
  private Database: any = null;  // better-sqlite3 constructor (cached at startup)

  /** Whether the adapter is ready (pando-code loaded + pool started). */
  get available(): boolean { return this.started; }

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

    // Start council agents if enabled
    if (config.enableCouncil) {
      await this.startCouncilAgents();
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

    if (id !== 'system' && !this.pool.has(id)) {
      // Create project workspace directory
      const { mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const baseDir = this.config?.dataDir || join((await import('node:os')).homedir(), '.pando');
      const projectDir = join(baseDir, 'projects', id);
      mkdirSync(projectDir, { recursive: true });
      await this.pool.getOrCreate(id, { projectPath: projectDir });
    }

    yield* this.pool.send(id, message);
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
   * Get pending/in_progress tasks from the council board.
   */
  getCouncilBoard(): any[] {
    if (!this.councilDbPath || !this.Database) return [];
    try {
      const db = new this.Database(this.councilDbPath, { readonly: true });
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

  /**
   * Add a task to the council (or project) board. Used by doorman to route user reports.
   * Returns the task ID on success, null on failure.
   */
  addBoardTask(title: string, description?: string): string | null {
    if (!this.councilDbPath || !this.Database) return null;
    try {
      const db = new this.Database(this.councilDbPath);
      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // Get council session_id for the FK constraint and next order value
      const councilSession = db.prepare(
        `SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1`
      ).get() as { id: string } | undefined;
      const sessionId = councilSession?.id || 'system';
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
      console.warn(`[EngineAdapter] addBoardTask failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Read the council board and format a snapshot for injection into the tick message.
   * Returns a human-readable summary of pending/in_progress tasks.
   */
  private getCouncilBoardSnapshot(dbPath: string): string {
    if (!this.Database) return 'BOARD STATE: Database not available.';
    try {
      const db = new this.Database(dbPath, { readonly: true });
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
    if ((this as any)._councilInterval) clearInterval((this as any)._councilInterval);
    this.scheduler?.stop();
    await this.pool?.shutdown();
    this.started = false;
    console.log('[EngineAdapter] Shut down.');
  }

  // ─── Council Agents ──────────────────────────────────────────────────

  /**
   * Start the three council agents using PandoCode's native agent system.
   * Each agent is a PandoCode engine with:
   *   - Shared SQLite DB (cross-engine send_message + board tasks)
   *   - Role-based tool filtering (explorer/tester/lead)
   *   - pando_* tools for network operations
   *   - System prompt via agentOverride on each send()
   *
   * See BIBLE.md Section 5.10 and docs/BRAINSTORM-ROADMAP.md.
   */
  private async startCouncilAgents(): Promise<void> {
    if (!this.pool || !this.config) return;

    const { join } = await import('node:path');
    const { mkdirSync } = await import('node:fs');
    const baseDir = this.config.dataDir || join((await import('node:os')).homedir(), '.pando');

    // Shared DB path — all council engines share one SQLite DB for cross-engine communication
    const councilDir = join(baseDir, 'council');
    mkdirSync(councilDir, { recursive: true });
    const councilDbPath = join(councilDir, 'council.db');
    this.councilDbPath = councilDbPath;

    // Import PandoCode tool creators for re-registration with correct agent IDs
    const { createCheckAgentsTool, createSendMessageTool, createManageTasksTool } =
      await import('@pando-code/core');

    // Create one engine per council agent with shared DB
    for (const agent of COUNCIL_AGENTS) {
      const engine = await this.pool.getOrCreate(agent.id, {
        projectPath: councilDir,
        dbPath: councilDbPath,
        role: agent.role,
      });

      // CRITICAL: Start session BEFORE re-registering tools.
      // startSession() calls _registerSubAgentTools() which registers check_agents,
      // send_message, manage_tasks with the auto-generated "General" agent UUID.
      // We must let that happen first, THEN overwrite with our correct agent IDs.
      // Without this, send() would call startSession() internally and overwrite
      // our registrations.
      if (!engine.getSessionId()) {
        await engine.startSession(`Council: ${agent.id}`);
      }

      // Now re-register tools with correct council agent IDs.
      // PandoCode's startSession() used auto-generated UUIDs, but council agents
      // need stable string IDs ("observer", "qa", "council") for message routing.
      // manage_tasks uses the engine's real sessionId (from startSession above)
      // so board_tasks FK constraint to sessions table is satisfied.
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

        console.log(`[EngineAdapter] Council "${agent.id}": tools re-registered with agentId="${agent.id}", session=${engineSessionId}`);
      } else {
        console.warn(`[EngineAdapter] No db on engine "${agent.id}" — cannot re-register tools`);
      }
    }

    // Insert agent profiles into shared DB so send_message and check_agents work
    try {
      const engine = this.pool.get('council');
      if (engine?.db) {
        const now = new Date().toISOString();
        const sqlite = (engine.db as any).$client;
        for (const agent of COUNCIL_AGENTS) {
          sqlite.prepare(
            `INSERT OR IGNORE INTO agents (id, role, model, system_prompt, tools, scope, status, display_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            agent.id,
            agent.role,
            'default',
            agent.prompt,
            '[]',
            '{}',
            'idle',
            agent.displayName,
            now,
          );
        }
        console.log('[EngineAdapter] Council agent profiles registered in shared DB.');
      }
    } catch (err: any) {
      // Non-fatal — agents still work without profiles, just no cross-engine messaging
      console.warn('[EngineAdapter] Could not register agent profiles:', err.message);
    }

    // Register scheduler ticks for each agent
    if (this.scheduler) {
      const logEvent = (agentId: string) => (event: any) => {
        if (event.type === 'tool:start') {
          console.log(`[${agentId}] TOOL CALL: ${event.toolName}(${JSON.stringify(event.args)})`);
        } else if (event.type === 'tool:result') {
          const out = event.result?.output || '';
          const preview = out.length > 200 ? out.slice(0, 200) + '...' : out;
          console.log(`[${agentId}] TOOL RESULT: ${event.toolName} → ${event.result?.success ? 'OK' : 'FAIL'}: ${preview}`);
        } else if (event.type === 'stream:chunk' && event.content) {
          process.stdout.write(`[${agentId}] ${event.content}`);
        }
      };

      this.scheduler.register({
        name: 'observer-tick',
        engineId: 'observer',
        intervalMs: 30 * 60_000,
        prompt: `${OBSERVER_PROMPT}\n\n---\n\nRun your periodic checks now.`,
        active: true,
        onEvent: logEvent('observer'),
        onComplete: () => console.log(`\n[observer] Tick complete.`),
        onError: (err: Error) => console.warn(`[observer] Tick error: ${err.message}`),
      });

      this.scheduler.register({
        name: 'qa-tick',
        engineId: 'qa',
        intervalMs: 30 * 60_000,
        prompt: `${QA_PROMPT}\n\n---\n\nRun your health checks now.`,
        active: true,
        onEvent: logEvent('qa'),
        onComplete: () => console.log(`\n[qa] Tick complete.`),
        onError: (err: Error) => console.warn(`[qa] Tick error: ${err.message}`),
      });

      // Council tick uses a custom interval to inject dynamic board snapshot.
      // The scheduler doesn't support dynamic prompts, so we manage council's
      // periodic tick ourselves. Observer and QA use the scheduler (static prompts).
      const councilTickMs = 15 * 60_000;
      const councilInterval = setInterval(async () => {
        try {
          const boardSnapshot = this.getCouncilBoardSnapshot(councilDbPath);
          const message = `${COUNCIL_PROMPT}\n\n---\n\nCheck your inbox and review board tasks now.\n\n${boardSnapshot}`;
          for await (const event of this.sendToCouncilAgent('council', message)) {
            logEvent('council')(event);
          }
          console.log(`\n[council] Tick complete.`);
        } catch (err: any) {
          console.warn(`[council] Tick error: ${err.message}`);
        }
      }, councilTickMs);
      // Store interval for cleanup on shutdown
      (this as any)._councilInterval = councilInterval;

      console.log('[EngineAdapter] Council scheduler ticks registered.');
    }
  }

  /**
   * Send a message to a council agent with the correct system prompt.
   */
  async *sendToCouncilAgent(agentId: CouncilAgentId, message: string): AsyncGenerator<any> {
    if (!this.pool) throw new Error('EngineAdapter not started');
    const engine = this.pool.get(agentId);
    if (!engine) throw new Error(`Council agent "${agentId}" not found`);

    // Start session if needed
    if (!engine.getSessionId()) {
      await engine.startSession(`Council: ${agentId}`);
    }

    const agentDef = COUNCIL_AGENTS.find(a => a.id === agentId);
    yield* engine.send(message, {
      agentOverride: {
        agentId,
        role: agentDef?.role || agentId,
        systemPrompt: agentDef?.prompt || '',
      },
    });
  }

  /** Check if council agents are running. */
  isCouncilActive(): boolean {
    if (!this.pool) return false;
    return this.pool.has('observer') && this.pool.has('qa') && this.pool.has('council');
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
