/**
 * Engine Adapter — connection between pando-node and pando-teams.
 *
 * This is the ONLY file in pando-node that imports @pando-teams/core.
 * Everything else in pando-node is pure infrastructure.
 *
 * Responsibilities (post-BIBLE 1.7 migration):
 *   - Manages EnginePool for project engines
 *   - Registers Pando tools on each engine (deploy, governance, transfer, etc.)
 *   - Injects Lux budget provider
 *   - Routes messages to the right engine (system vs project)
 *   - Provides governance AI review hook
 *   - Runs Scheduler for periodic autonomous behavior
 *   - Injects contributed AI API keys from ResourceRegistry
 *   - Board state P2P sync for team failover (file-based)
 *
 * Team management (startTeam, stopTeam, agent lifecycle, tick scheduling,
 * prompt templates, watchdog) has been moved to Teams Server's TeamManager
 * (BIBLE 1.7 Step 3).
 */

import { join as pathJoin } from 'node:path';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ResourceRegistry } from '../platform/resource-registry.js';
import { STREAM_EVENT_VERSION, LUX_PER_USD } from '@pando/shared';
import type { StreamEvent, PandoService, ServiceContext } from '@pando/shared';

// Two Laws Content Filter — imported from shared constants (defense-in-depth at storage level)
import { HARM_PATTERNS, SHUTDOWN_PATTERNS } from '../constants.js';

// ─── Dynamic imports (pando-teams is ESM, loaded at runtime) ─────────────

let _EnginePool: any = null;
let _Scheduler: any = null;
let _loaded = false;
let _loadPromise: Promise<void> | null = null;

async function loadPandoTeams(): Promise<void> {
  if (_loaded) return;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const mod = await import('@pando-teams/core');
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

function createLuxBudgetProvider(luxPerUsd = LUX_PER_USD) {
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

async function createPandoTools(apiPort: number, apiToken?: string, resourceRegistry?: ResourceRegistry | null) {
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
      execute: async (args: any) => ok(await api('GET', args.peerId ? `/v1/balance/${args.peerId}` : '/v1/wallet')),
    },
    {
      name: 'pando_transfer',
      description: 'Transfer Lux to another peer.',
      parameters: z.object({
        to: z.string().describe('Recipient peer ID'),
        amount: z.number().positive().describe('Amount of Lux'),
        memo: z.string().optional().describe('Transfer memo'),
      }),
      execute: async (args: any) => ok(await api('POST', '/v1/transfer', args)),
    },
    {
      name: 'pando_deploy',
      description: 'Deploy a project to hosting.',
      parameters: z.object({ projectId: z.string().describe('Project ID to deploy') }),
      execute: async (args: any) => ok(await api('POST', `/v1/apps/${args.projectId}/deploy`, {})),
    },
    {
      name: 'pando_undeploy',
      description: 'Remove a deployed project.',
      parameters: z.object({ projectId: z.string().describe('Project ID to undeploy') }),
      execute: async (args: any) => ok(await api('DELETE', `/v1/apps/${args.projectId}`, {})),
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
        commitHash: z.string().optional().describe('Git commit hash for upgrade proposals'),
      }),
      execute: async (args: any) => {
        const data = await api('POST', '/v1/governance/propose', {
          title: args.title,
          description: args.description,
          category: args.type,
          ...(args.commitHash ? { commitHash: args.commitHash } : {}),
        });
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
      execute: async (args: any) => ok(await api('POST', '/v1/governance/vote', {
        proposalId: args.proposalId,
        choice: args.vote,
      })),
    },
    {
      name: 'pando_test_run',
      description: 'Trigger a test run.',
      parameters: z.object({
        project: z.string().optional().describe('Project to test'),
        spec: z.string().optional().describe('Specific spec file'),
        mode: z.enum(['scripted', 'live']).optional().default('scripted').describe('Test mode: scripted (Playwright) or live (playbook)'),
      }),
      execute: async (args: any) => {
        const route = (args.mode === 'live' || args.type === 'live')
          ? '/v1/testing/run/live'
          : '/v1/testing/run/scripted';
        return ok(await api('POST', route, args));
      },
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
        const { join, resolve, dirname } = await import('node:path');
        const { existsSync, mkdirSync } = await import('node:fs');
        const os = await import('node:os');

        const repo: string = args.repo;
        const branch: string = args.branch || 'main';

        // Validate inputs — prevent shell injection
        const SAFE_REF = /^[a-zA-Z0-9._\/-]+$/;
        if (!SAFE_REF.test(branch)) return { success: false, output: 'Invalid branch name' };
        if (!SAFE_REF.test(repo)) return { success: false, output: 'Invalid repo name' };

        // 1. Check for known local repos first (no network needed).
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
            const wsGit = new (await import('./git-ops.js')).GitOps(workDir);
            wsGit.fetch('origin', branch);
            wsGit.checkout(branch);
            wsGit.pull('origin', branch);
            return { success: true, output: JSON.stringify({ path: workDir, status: 'updated', repo, branch }) };
          } else {
            // 3. Clone fresh from GitHub.
            let cloneUrl = repo.includes('/') ? `https://github.com/${repo}.git` : `https://github.com/pando-lux/${repo}.git`;
            if (resourceRegistry?.resolveGitCredential) {
              try {
                const authenticatedUrl = await resourceRegistry.resolveGitCredential(cloneUrl);
                if (authenticatedUrl) cloneUrl = authenticatedUrl;
              } catch { /* credential resolution failed — use plain URL */ }
            }
            const { GitOps: GO } = await import('./git-ops.js');
            GO.cloneSync(cloneUrl, workDir, branch);
            return { success: true, output: JSON.stringify({ path: workDir, status: 'cloned', repo, branch }) };
          }
        } catch (err: any) {
          console.error(`[engine-adapter] pando_workspace failed: ${err.message}`);
          return { success: false, output: 'pando_workspace failed: internal error' };
        }
      },
    },
  ];
}

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
  /** Resolve project metadata (repoUrl, name) by projectId — used for workspace recovery. */
  projectResolver?: (projectId: string) => Promise<{ repoUrl?: string; name?: string } | null>;
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
  private projectIntervals = new Map<string, NodeJS.Timeout>();  // projectId → tick interval

  /** Whether the adapter is ready (pando-teams loaded + pool started). */
  get available(): boolean { return this.started; }

  /** Network linking: always linked when adapter is started (node IS the network). */
  get linked(): boolean { return this.started; }

  /**
   * Start the adapter: load pando-teams, create pool, boot system engine.
   */
  async start(config: AdapterConfig): Promise<void> {
    // Validate dataDir: must be a non-empty absolute path. Fall back to default if invalid.
    if (config.dataDir) {
      const isAbsolute = config.dataDir.startsWith('/') || /^[A-Za-z]:[/\\]/.test(config.dataDir);
      if (typeof config.dataDir !== 'string' || !config.dataDir.trim() || !isAbsolute) {
        console.warn(`[EngineAdapter] Invalid dataDir "${config.dataDir}" — falling back to default`);
        config.dataDir = pathJoin(homedir(), '.pando');
      }
    }
    this.config = config;

    // Load pando-teams dynamically
    await loadPandoTeams();

    // Cache better-sqlite3 for board operations (ESM-safe)
    try {
      const { createRequire } = await import('module');
      const esmRequire = createRequire(import.meta.url);
      this.Database = esmRequire('better-sqlite3');
    } catch { /* better-sqlite3 not available */ }

    // Inject contributed AI API keys
    await this.injectApiKeys(config.resourceRegistry);

    // Pre-create Pando tools and Lux provider (shared across all engines)
    this.pandoTools = await createPandoTools(config.apiPort, config.apiToken, config.resourceRegistry);
    this.luxProvider = createLuxBudgetProvider(config.luxPerUsd);

    // Create engine pool with lifecycle hooks
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
   * Includes a configurable timeout (default 300s) — if the engine hangs, yields
   * an error event and returns instead of blocking forever.
   */
  async *send(message: string, projectId?: string, timeoutMs = 300_000): AsyncGenerator<any> {
    this.requirePool();
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

    // Wrap the engine's async generator with a timeout.
    const source = this.pool.send(id, message);
    const iterator = source[Symbol.asyncIterator]();
    let done = false;

    while (!done) {
      const result = await Promise.race([
        iterator.next(),
        new Promise<{ value: any; done: true }>((_, reject) =>
          setTimeout(() => reject(new Error(`Engine execution timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]).catch((err: Error) => {
        done = true;
        return { value: { type: 'error', error: err.message }, done: false as const };
      });

      if (result.done) {
        done = true;
      } else {
        yield EngineAdapter.normalizeStreamEvent(result.value);
        if (result.value?.type === 'error' && done) {
          iterator.return?.();
          return;
        }
      }
    }
  }

  /**
   * Ensure a project workspace directory exists with network linking metadata.
   * If workspace is empty and project has a GitHub repo, clones it automatically.
   */
  private async ensureProjectWorkspace(projectId: string): Promise<string> {
    const { mkdirSync, writeFileSync, existsSync: fsExists, readdirSync } = await import('node:fs');
    const baseDir = this.config?.dataDir || pathJoin(homedir(), '.pando');
    const projectDir = pathJoin(baseDir, 'projects', projectId);
    mkdirSync(projectDir, { recursive: true });

    // Check if workspace has real content (not just PANDO_PROJECT.json)
    const entries = readdirSync(projectDir).filter(f => f !== 'PANDO_PROJECT.json' && f !== '.git');
    const isEmpty = entries.length === 0;

    // If empty, try to recover from GitHub via projectResolver
    if (isEmpty && this.config?.projectResolver) {
      try {
        const project = await this.config.projectResolver(projectId);
        if (project?.repoUrl) {
          // Validate repoUrl is a proper URL (prevent shell injection)
          const urlSafe = /^https?:\/\/[a-zA-Z0-9._@:/-]+\.git$/.test(project.repoUrl) || /^https?:\/\/github\.com\//.test(project.repoUrl);
          if (!urlSafe) {
            console.warn(`[engine] Skipping workspace recovery — repoUrl looks unsafe: ${project.repoUrl.slice(0, 80)}`);
          } else {
          console.log(`[engine] Workspace empty for ${projectId} — recovering from ${project.repoUrl}`);
          try {
            const gitDir = pathJoin(projectDir, '.git');
            const { GitOps: ProjGitOps } = await import('./git-ops.js');
            const projGit = new ProjGitOps(projectDir);
            if (!fsExists(gitDir)) {
              projGit.init();
              projGit.remoteAdd('origin', project.repoUrl);
            }
            projGit.fetch('origin');
            try {
              projGit.exec(['checkout', '-f', 'origin/main', '--', '.']);
            } catch {
              projGit.exec(['checkout', '-f', 'origin/master', '--', '.']);
            }
            const recovered = readdirSync(projectDir).filter(f => f !== 'PANDO_PROJECT.json' && f !== '.git');
            console.log(`[engine] Recovered ${recovered.length} file(s) from ${project.repoUrl}`);
          } catch (gitErr: any) {
            console.warn(`[engine] Workspace recovery failed for ${projectId}: ${gitErr.message?.slice(0, 200)}`);
          }
          } // close urlSafe else
        }
      } catch (err: any) {
        console.warn(`[engine] projectResolver failed for ${projectId}: ${err.message?.slice(0, 100)}`);
      }
    }

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
      const jsonMatch = output.match(/\{[\s\S]*"safe"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          safe: !!parsed.safe,
          risks: Array.isArray(parsed.risks) ? parsed.risks : [],
          recommendation: parsed.recommendation || (parsed.safe ? 'approve' : 'review'),
        };
      }

      return { safe: true, risks: [], recommendation: 'AI review returned unstructured response — defaulting to approve' };
    } catch (err: any) {
      console.warn('[EngineAdapter] reviewDiff failed:', err.message);
      return { safe: true, risks: [], recommendation: `AI review error: ${err.message}` };
    }
  }

  /** M2-2: Guard — throws if pool is not initialized (start() not called). */
  private requirePool(): void {
    if (!this.pool) throw new Error('EngineAdapter not started — call start() first');
  }

  /**
   * H-2 + H-3: Normalize a raw PandoTeams engine event into a typed StreamEvent
   * with protocol version.
   */
  static normalizeStreamEvent(raw: any): StreamEvent {
    return {
      type: raw.type ?? 'unknown',
      version: STREAM_EVENT_VERSION,
      ...(raw.content !== undefined ? { content: raw.content } : {}),
      ...(raw.toolName !== undefined ? { toolName: raw.toolName } : {}),
      ...(raw.args !== undefined ? { args: raw.args } : {}),
      ...(raw.result !== undefined ? { result: raw.result } : {}),
      ...(raw.error !== undefined ? { error: raw.error } : {}),
    };
  }

  /** List active engines with metadata. */
  getActiveEngines(): any[] {
    if (!this.pool) return [];
    return this.pool.getActive() ?? [];
  }

  /** Check if a project engine exists. */
  hasEngine(projectId: string): boolean {
    if (!this.pool) return false;
    return this.pool.has(projectId) ?? false;
  }

  /** Destroy a specific engine by ID — frees memory and process. */
  async destroyEngine(engineId: string): Promise<boolean> {
    if (!this.pool) return false;
    const engine = this.pool.get(engineId);
    if (!engine) return false;
    try {
      await engine.shutdown().catch(() => {});
      this.pool.engines?.delete(engineId);
      this.pool.lastUsed?.delete(engineId);
      this.pool.createdAt?.delete(engineId);
      console.log(`[EngineAdapter] Destroyed engine: ${engineId}`);
      return true;
    } catch {
      return false;
    }
  }

  /** Get scheduler info. */
  getSchedules(): any[] {
    return this.scheduler?.getAll() ?? [];
  }

  /**
   * Get pending/in_progress tasks from a project's board.
   */
  getProjectBoard(projectId: string): any[] {
    const dbPath = this.resolveProjectDbPath(projectId);
    return this.getBoardTasks(dbPath);
  }

  // ─── Board State P2P Sync (file-based — Teams Server manages live board) ───

  /**
   * Get the board state snapshot for a team as a JSON-serializable object.
   * Used for P2P board state sync (team failover). Returns null if no board data.
   * Reads from the persisted board-state.json file (live board is in Teams Server).
   */
  getBoardStateSnapshot(teamId: string): { savedAt: string; nodeId: string; tasks: any[] } | null {
    try {
      const baseDir = this.config?.dataDir || pathJoin(homedir(), '.pando');
      const filePath = pathJoin(baseDir, 'teams', teamId, 'board-state.json');
      if (!existsSync(filePath)) return null;

      const raw = readFileSync(filePath, 'utf-8');
      const snapshot = JSON.parse(raw);
      const tasks = (snapshot.tasks || []).filter((t: any) => t.status !== 'done');
      if (tasks.length === 0) return null;

      return {
        savedAt: snapshot.savedAt || new Date().toISOString(),
        nodeId: snapshot.nodeId || 'unknown',
        tasks,
      };
    } catch (err: any) {
      console.warn(`[board-sync] getBoardStateSnapshot failed for team ${teamId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Restore board state from a P2P-received snapshot (team failover).
   * Writes the snapshot to board-state.json. Teams Server reads this on boot.
   * Returns true if the file was written successfully.
   */
  restoreBoardStateFromSnapshot(teamId: string, snapshot: { savedAt: string; nodeId: string; tasks: any[] }): boolean {
    try {
      if (!snapshot?.tasks?.length) return false;

      const baseDir = this.config?.dataDir || pathJoin(homedir(), '.pando');
      const teamDir = pathJoin(baseDir, 'teams', teamId);
      mkdirSync(teamDir, { recursive: true });

      const filePath = pathJoin(teamDir, 'board-state.json');
      const tmpPath = filePath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      renameSync(tmpPath, filePath);
      console.log(`[board-sync] Wrote P2P board snapshot for team ${teamId} (${snapshot.tasks.length} tasks from node ${snapshot.nodeId})`);

      return true;
    } catch (err: any) {
      console.warn(`[board-sync] restoreBoardStateFromSnapshot failed for team ${teamId}: ${err.message}`);
      return false;
    }
  }

  // ─── Project Board ─────────────────────────────────────────────────────

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

  /** Resolve the .pando-teams.db path for a project. */
  private resolveProjectDbPath(projectId: string): string | null {
    if (!this.config) return null;
    try {
      const baseDir = this.config.dataDir || pathJoin(homedir(), '.pando');
      const dbPath = pathJoin(baseDir, 'projects', projectId, '.pando-teams.db');
      return existsSync(dbPath) ? dbPath : null;
    } catch {
      return null;
    }
  }

  /** Read board tasks from any PandoTeams SQLite DB. */
  private getBoardTasks(dbPath: string | null, includeDone = false): any[] {
    if (!dbPath || !this.Database) return [];
    try {
      const db = new this.Database(dbPath);
      const statusFilter = includeDone
        ? `status IN ('pending', 'in_progress', 'in-progress', 'done')`
        : `status IN ('pending', 'in_progress', 'in-progress')`;
      const tasks = db.prepare(
        `SELECT id, title, description, status, created_at, progress FROM board_tasks
         WHERE ${statusFilter}
         ORDER BY created_at DESC LIMIT 50`
      ).all();
      db.close();
      return tasks;
    } catch {
      return [];
    }
  }

  /** Insert a board task into any PandoTeams SQLite DB. Dedup by exact title match. */
  private insertBoardTask(dbPath: string | null, title: string, description?: string): string | null {
    if (!dbPath || !this.Database) return null;

    // Defense-in-depth: Two Laws content filter at the storage level.
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

      const id = `task-${randomUUID()}`;
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
   * Only registers once per projectId.
   */
  private ensureProjectTick(projectId: string, dbPath: string): void {
    if (this.projectTicks.has(projectId) || !this.pool || !this.scheduler) return;
    if (!this.pool.has(projectId)) return;

    this.projectTicks.add(projectId);

    const existing = this.projectIntervals.get(projectId);
    if (existing) clearInterval(existing);

    // Project ticks run every 6 hours
    const projectTickMs = 6 * 60 * 60_000;
    const tickInterval = setInterval(async () => {
      try {
        const snapshot = this.getBoardSnapshot(dbPath);
        if (snapshot.includes('No pending tasks')) return;

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

    this.projectIntervals.set(projectId, tickInterval);
    console.log(`[EngineAdapter] Project "${projectId}" scheduler tick registered (every 6h).`);
  }

  /** Stop all project tick intervals and clear the Map. */
  stopProjectTicks(): void {
    for (const [, interval] of this.projectIntervals) {
      clearInterval(interval);
    }
    this.projectIntervals.clear();
    this.projectTicks.clear();
  }

  /**
   * Read a board and format a snapshot for injection into tick messages.
   */
  private getBoardSnapshot(dbPath: string): string {
    if (!this.Database) return 'BOARD STATE: Database not available.';
    try {
      const db = new this.Database(dbPath);
      const tasks = db.prepare(
        `SELECT id, title, description, status, created_at FROM board_tasks
         WHERE status IN ('pending', 'in_progress')
         ORDER BY
           CASE WHEN title LIKE '%CRITICAL%' THEN 0
                WHEN title LIKE '%BUG:user%' THEN 1
                WHEN title LIKE '%WARNING%' THEN 2
                WHEN title LIKE '%FEATURE:user%' THEN 3
                ELSE 4 END,
           created_at ASC
         LIMIT 20`
      ).all() as { id: string; title: string; description: string; status: string; created_at: string }[];
      db.close();

      if (tasks.length === 0) return 'BOARD STATE: No pending tasks.';

      const lines = tasks.map((t) => {
        const age = Date.now() - new Date(t.created_at).getTime();
        const ageStr = age > 86400000 ? `${Math.floor(age / 86400000)}d ago`
          : age > 3600000 ? `${Math.floor(age / 3600000)}h ago`
          : `${Math.floor(age / 60000)}m ago`;
        const desc = t.description ? `\n    ${t.description.slice(0, 500)}` : '';
        return `  [${t.status}] (${t.id}) ${t.title.slice(0, 100)} — ${ageStr}${desc}`;
      });
      return `BOARD STATE (${tasks.length} active tasks):\n${lines.join('\n')}`;
    } catch {
      return 'BOARD STATE: Could not read board.';
    }
  }

  /** Shutdown everything gracefully. */
  async shutdown(): Promise<void> {
    this.stopProjectTicks();
    this.scheduler?.stop();
    await this.pool?.shutdown();
    this.started = false;
    console.log('[EngineAdapter] Shut down.');
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  /**
   * Ensure AI API keys are available for PandoTeams.
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

    // 1. Load PandoTeams's .env if it exists (contributor's configured keys)
    try {
      const { readFileSync, existsSync } = await import('fs');
      const { resolve, dirname } = await import('path');
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const corePkg = require.resolve('@pando-teams/core/package.json');
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
        console.log(`[EngineAdapter] Loaded PandoTeams .env from ${pandoCodeRoot}`);
      }
    } catch { /* ok — no .env file or @pando-teams/core not installed */ }

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
        if (!envVar || process.env[envVar]) continue;
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
      console.warn('[EngineAdapter] No AI API keys found. PandoTeams will use its own configured provider. Set GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY if needed.');
    }
  }

}

// ─── PandoService adapter ────────────────────────────────────────────
// Wraps EngineAdapter as a PandoService for the ServiceLoader pattern.

/**
 * Create a PandoService that wraps EngineAdapter.
 * Called by ServiceLoader when @pando-teams/core is installed,
 * or directly by init-platform.ts during the transition period.
 */
export function createEngineService(adapter: EngineAdapter): PandoService {
  return {
    id: 'pando-teams',
    version: '0.2.0',
    capabilities: ['ai-engine', 'agents', 'board', 'scheduler', 'governance-review'],

    async start(ctx: ServiceContext): Promise<void> {
      await adapter.start({
        apiPort: ctx.apiPort,
        apiToken: ctx.apiToken,
        dataDir: ctx.dataDir,
        resourceRegistry: ctx.resourceRegistry ?? null,
        projectResolver: ctx.projectResolver,
      });
    },

    async stop(): Promise<void> {
      await adapter.shutdown();
    },

    healthy(): boolean {
      return adapter.available;
    },
  };
}
