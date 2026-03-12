/**
 * Engine Adapter — connection between pando-node and pando-teams.
 * v3.0 — Phase 8A followup: replaced EnginePool/Scheduler with HTTP proxy to pando-teams server.
 *
 * KB: Phase 8A removed EnginePool/Scheduler/PandoServer from @pando-teams/core.
 * KB: This file now proxies all AI calls via HTTP to the pando-teams server (default: localhost:4873).
 * KB: teamsBaseUrl = PANDO_TEAMS_URL env var || http://127.0.0.1:4873.
 * KB: pando-tools.ts = 14 HTTP tools injected on every engine (kept for future use).
 * KB: project-board.ts = board CRUD + P2P sync + 6h project tick.
 * KB: api-keys.ts = AI key injection (local .env → contributed EC2 resources).
 * KB: MODEL_PRICING here is the node subset — canonical table is in
 *   teams/packages/core/src/engine/model-pricing.ts.
 * KB: Team management (startTeam, stopTeam, agent lifecycle) is in Teams Server TeamManager.
 */

import { join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import { STREAM_EVENT_VERSION, LUX_PER_USD } from '@pando/shared';
import type { StreamEvent, PandoService, ServiceContext } from '@pando/shared';
import { createPandoTools } from './pando-tools.js';
import { ProjectBoard } from './project-board.js';
import { injectApiKeys } from './api-keys.js';

// ─── Lux Budget Provider ────────────────────────────────────────────────
// KB: Lux cost = USD cost × LUX_PER_USD (from @pando/shared). LUX_PER_USD ≈ 10,000.
// KB: Subset of model-pricing.ts — 13 models. Canonical full table: code/packages/core/src/engine/model-pricing.ts.

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
  // KB: Phase 8A — pool/scheduler replaced with HTTP proxy fields.
  private teamsBaseUrl = '';
  private teamsApiKey = '';
  private pandoTools: any[] = [];
  private luxProvider: any = null;
  private config: AdapterConfig | null = null;
  private started = false;
  private board: ProjectBoard | null = null;

  /** Whether the adapter is ready (pando-teams reachable). */
  get available(): boolean { return this.started; }

  /** Network linking: always linked when adapter is started. */
  get linked(): boolean { return this.started; }

  /**
   * Start the adapter: verify pando-teams reachable, init board.
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

    // Resolve pando-teams URL and API key
    // KB: PANDO_TEAMS_URL env var overrides default. Use 127.0.0.1 not localhost to avoid IPv6 resolution.
    this.teamsBaseUrl = process.env.PANDO_TEAMS_URL || 'http://127.0.0.1:4873';
    this.teamsApiKey = process.env.PANDO_API_KEY || config.apiToken || '';

    // Cache better-sqlite3 for board operations (ESM-safe)
    let Database: any = null;
    try {
      const { createRequire } = await import('module');
      const esmRequire = createRequire(import.meta.url);
      Database = esmRequire('better-sqlite3');
    } catch { /* better-sqlite3 not available */ }

    // Inject contributed AI API keys
    await injectApiKeys();

    // Pre-create Pando tools and Lux provider
    this.pandoTools = await createPandoTools(config.apiPort, config.apiToken);
    this.luxProvider = createLuxBudgetProvider(config.luxPerUsd);

    // Wire ProjectBoard
    // KB: board.db must be set for board tasks to persist.
    const dataDir = config.dataDir || pathJoin(homedir(), '.pando');
    this.board = new ProjectBoard(dataDir);
    this.board.db = Database;

    // Health check — verify pando-teams server is reachable
    // KB: Non-fatal — adapter marks started=true even if teams temporarily unreachable.
    // KB: Teams server may start after node; individual send() calls will fail gracefully if not up.
    try {
      const healthRes = await fetch(`${this.teamsBaseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (healthRes.ok) {
        console.log(`[EngineAdapter] pando-teams reachable at ${this.teamsBaseUrl}`);
      } else {
        console.warn(`[EngineAdapter] pando-teams returned ${healthRes.status} at ${this.teamsBaseUrl}`);
      }
    } catch {
      console.warn(`[EngineAdapter] pando-teams not reachable at ${this.teamsBaseUrl} — will retry on send()`);
    }

    this.started = true;
    console.log('[EngineAdapter] Started. Proxying AI calls to pando-teams at', this.teamsBaseUrl);
  }

  /**
   * Send a message to pando-teams. Routes by projectId (teamId).
   * No projectId → 'system' team.
   * KB: Replaces pool.send() — now a single HTTP POST to /v1/teams/:teamId/chat.
   * KB: Yields one stream:chunk + done event (pando-teams returns full response synchronously).
   */
  async *send(message: string, projectId?: string, timeoutMs = 300_000): AsyncGenerator<any> {
    this.requireStarted();
    const teamId = projectId || 'system';

    // Ensure project workspace exists (for local file operations)
    if (teamId !== 'system') {
      await this.ensureProjectWorkspace(teamId);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.teamsBaseUrl}/v1/teams/${teamId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.teamsApiKey}`,
        },
        body: JSON.stringify({ message, agentId: 'lead' }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`pando-teams chat error ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json() as any;
      const content = data.reply || data.response || data.content || data.text || '';
      yield EngineAdapter.normalizeStreamEvent({ type: 'stream:chunk', content });
      yield EngineAdapter.normalizeStreamEvent({ type: 'done' });
    } catch (err: any) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        yield EngineAdapter.normalizeStreamEvent({ type: 'error', error: `Engine execution timed out after ${timeoutMs}ms` });
      } else {
        yield EngineAdapter.normalizeStreamEvent({ type: 'error', error: err.message });
      }
    } finally {
      clearTimeout(timer);
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
   * Sends to pando-teams system team, parses JSON response.
   * KB: Called on EVERY code deploy via governance-api.ts → /v1/governance/propose.
   * KB: If adapter not started or teams unreachable, returns safe:true — governance proceeds without AI review.
   * KB: Phase 8A — replaced pool.send() loop with single HTTP POST to /v1/teams/system/chat.
   */
  async reviewDiff(diff: string, description: string): Promise<ReviewResult> {
    if (!this.started) {
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
      const res = await fetch(`${this.teamsBaseUrl}/v1/teams/system/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.teamsApiKey}`,
        },
        body: JSON.stringify({ message: prompt, agentId: 'lead' }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        throw new Error(`pando-teams chat error: ${res.status}`);
      }

      const data = await res.json() as any;
      const output = data.reply || data.response || data.content || data.text || '';

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

  /** Guard — throws if adapter not started. */
  private requireStarted(): void {
    if (!this.started) throw new Error('EngineAdapter not started — call start() first');
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

  /** List active engines — pando-teams manages engine lifecycle, returns empty stub. */
  getActiveEngines(): any[] {
    return [];
  }

  /** Check if a project engine exists — always true when started (teams manages lifecycle). */
  hasEngine(_projectId: string): boolean {
    return this.started;
  }

  /** Destroy a specific engine — no-op (teams server manages engine lifecycle). */
  async destroyEngine(_engineId: string): Promise<boolean> {
    return false;
  }

  /** Get scheduler info — Scheduler removed in Phase 8A, returns empty. */
  getSchedules(): any[] {
    return [];
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
