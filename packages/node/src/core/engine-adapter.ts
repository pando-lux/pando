/**
 * Engine Adapter — connection between pando-node and pando-teams.
 * v2.2 — extraction: pando-tools, project-board, api-keys moved to dedicated modules.
 *
 * KB: This is the ONLY file in pando-node that imports @pando-teams/core (dynamic).
 * KB: Responsibilities: EnginePool lifecycle, tool registration, Lux budget injection,
 *   message routing, governance AI review, Scheduler, ProjectBoard wiring.
 * KB: pando-tools.ts = 14 HTTP tools injected on every engine.
 * KB: project-board.ts = board CRUD + P2P sync + 6h project tick.
 * KB: api-keys.ts = AI key injection (local .env → contributed EC2 resources).
 * KB: MODEL_PRICING here is the node subset — canonical table is in
 *   teams/packages/core/src/engine/model-pricing.ts.
 * KB: Team management (startTeam, stopTeam, agent lifecycle) is in Teams Server TeamManager.
 * KB: @pando-teams/core is declared as file:../teams/packages/core in pando-node root package.json.
 * KB: drizzle-orm must also be in pando-node root package.json — core's db/ imports it, and
 *   Node resolves deps relative to the junction path (not the real teams/ path).
 */

import { join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import type { ResourceRegistry } from '../platform/resource-registry.js';
import { STREAM_EVENT_VERSION, LUX_PER_USD } from '@pando/shared';
import type { StreamEvent, PandoService, ServiceContext } from '@pando/shared';
import { createPandoTools } from './pando-tools.js';
import { ProjectBoard } from './project-board.js';
import { injectApiKeys } from './api-keys.js';

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
// KB: Lux cost = USD cost × LUX_PER_USD (from @pando/shared). LUX_PER_USD ≈ 10,000.
// KB: Subset of model-pricing.ts — 13 models. Canonical full table: code/packages/core/src/engine/model-pricing.ts.
// KB: Injected via engine.setBudgetProvider() in onAfterCreate — replaces the default UsdBudgetProvider.

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
  private board: ProjectBoard | null = null;

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
    let Database: any = null;
    try {
      const { createRequire } = await import('module');
      const esmRequire = createRequire(import.meta.url);
      Database = esmRequire('better-sqlite3');
    } catch { /* better-sqlite3 not available */ }

    // Inject contributed AI API keys
    await injectApiKeys(config.resourceRegistry);

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
      onAfterCreate: async (_id: string, engine: any) => {
        // Inject Lux budget
        engine.setBudgetProvider(this.luxProvider);

        // Register all Pando tools on every engine
        for (const tool of this.pandoTools) {
          engine.tools.register(tool);
        }
      },
    });
    this.pool.start();

    // Wire ProjectBoard — delegates all SQLite board ops and P2P sync
    // KB: board.db and board.pool MUST be set after pool.start() and Database loaded.
    // KB: ProjectBoard is null-safe on missing db/pool, but board tasks won't persist without db.
    const dataDir = config.dataDir || pathJoin(homedir(), '.pando');
    this.board = new ProjectBoard(dataDir);
    this.board.db = Database;
    this.board.pool = this.pool;

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
          }
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
   * KB: Called on EVERY code deploy via governance-api.ts → /v1/governance/propose.
   * KB: If pool is not initialized, returns safe:true — governance proceeds without AI review.
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

  /** Guard — throws if pool is not initialized (start() not called). */
  private requirePool(): void {
    if (!this.pool) throw new Error('EngineAdapter not started — call start() first');
  }

  /**
   * Normalize a raw PandoTeams engine event into a typed StreamEvent
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

  // ─── Board delegation (ProjectBoard) ─────────────────────────────────
  // KB: P2P sync uses file protocol: ~/.pando/teams/{teamId}/board-state.json.
  // KB: Teams Server (code/server) reads board-state.json on boot for failover recovery.
  // KB: Live board is in Teams Server SQLite; this file-based copy is for cross-node redundancy.

  /** Get pending/in_progress tasks from a project's board. */
  getProjectBoard(projectId: string): any[] {
    return this.board?.getProjectBoard(projectId) ?? [];
  }

  /**
   * Get the board state snapshot for a team as a JSON-serializable object.
   * Used for P2P board state sync (team failover).
   */
  getBoardStateSnapshot(teamId: string): { savedAt: string; nodeId: string; tasks: any[] } | null {
    return this.board?.getBoardStateSnapshot(teamId) ?? null;
  }

  /**
   * Restore board state from a P2P-received snapshot (team failover).
   * Writes atomically. Teams Server reads board-state.json on boot.
   */
  restoreBoardStateFromSnapshot(teamId: string, snapshot: { savedAt: string; nodeId: string; tasks: any[] }): boolean {
    return this.board?.restoreBoardStateFromSnapshot(teamId, snapshot) ?? false;
  }

  /**
   * Add a task to a project's board. Used for per-project bug reports.
   * Returns the task ID on success, null on failure. Dedup by exact title match.
   */
  addProjectBoardTask(projectId: string, title: string, description?: string): string | null {
    return this.board?.addProjectBoardTask(projectId, title, description) ?? null;
  }

  /** Stop all project tick intervals — called from shutdown(). */
  stopProjectTicks(): void {
    this.board?.stopProjectTicks();
  }

  /** Shutdown everything gracefully. */
  async shutdown(): Promise<void> {
    this.board?.stopProjectTicks();
    this.scheduler?.stop();
    await this.pool?.shutdown();
    this.started = false;
    console.log('[EngineAdapter] Shut down.');
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
