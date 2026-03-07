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
 *   - Injects contributed AI API keys from ResourceRegistry
 */

import type { ResourceRegistry } from '../platform/resource-registry.js';
import { OBSERVER_PROMPT, QA_PROMPT, COUNCIL_PROMPT, TOOL_SETS } from './council-prompts.js';

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
  const baseUrl = `http://localhost:${apiPort}`;
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
    // ── Findings tools (Council/Observer/QA) ──
    {
      name: 'pando_create_finding',
      description: 'Create a finding (observation or test failure). Used by Observer and QA agents.',
      parameters: z.object({
        source: z.enum(['observer', 'qa', 'council', 'user']).describe('Who created this finding'),
        severity: z.enum(['info', 'warning', 'critical']).describe('Severity level'),
        category: z.enum(['health', 'test_failure', 'security', 'performance', 'suggestion']).describe('Category'),
        title: z.string().describe('Short title'),
        detail: z.string().describe('Full diagnostic detail'),
        target: z.string().optional().describe('Affected component (e.g. "@pando/node")'),
      }),
      execute: async (args: any) => ok(await api('POST', '/v1/findings', args)),
    },
    {
      name: 'pando_list_findings',
      description: 'List findings. Filter by status, severity, or source.',
      parameters: z.object({
        status: z.enum(['open', 'in_progress', 'resolved', 'wont_fix']).optional().describe('Filter by status'),
        severity: z.enum(['info', 'warning', 'critical']).optional().describe('Filter by severity'),
        source: z.enum(['observer', 'qa', 'council', 'user']).optional().describe('Filter by source'),
      }),
      execute: async (args: any) => {
        const params = new URLSearchParams();
        if (args.status) params.set('status', args.status);
        if (args.severity) params.set('severity', args.severity);
        if (args.source) params.set('source', args.source);
        const qs = params.toString();
        return ok(await api('GET', `/v1/findings${qs ? '?' + qs : ''}`));
      },
    },
    {
      name: 'pando_update_finding',
      description: 'Update a finding status. Used by Council to resolve findings.',
      parameters: z.object({
        id: z.string().describe('Finding ID'),
        status: z.enum(['open', 'in_progress', 'resolved', 'wont_fix']).optional().describe('New status'),
        resolvedBy: z.string().optional().describe('Who resolved it'),
        actionTaken: z.string().optional().describe('What was done to resolve'),
      }),
      execute: async (args: any) => {
        const { id, ...body } = args;
        return ok(await api('PATCH', `/v1/findings/${id}`, body));
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
  /** Schedule periodic observer/QA checks. Default: true. */
  enableScheduler?: boolean;
  /** Observer check interval (ms). Default: 30 min. */
  observerIntervalMs?: number;
  /** QA check interval (ms). Default: 30 min. */
  qaIntervalMs?: number;
  /** Council check interval (ms). Default: 15 min. */
  councilIntervalMs?: number;
  /** Enable council/observer/QA agents. Default: false (opt-in). */
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

  /** Whether the adapter is ready (pando-code loaded + pool started). */
  get available(): boolean { return this.started; }

  /**
   * Start the adapter: load pando-code, create pool, boot system engine.
   */
  async start(config: AdapterConfig): Promise<void> {
    this.config = config;

    // Load pando-code dynamically
    await loadPandoCode();

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
        // Register Pando tools (filtered for council agents)
        const allowedSet = (TOOL_SETS as any)[id] as string[] | null | undefined;
        for (const tool of this.pandoTools) {
          if (!allowedSet || allowedSet.includes(tool.name)) {
            engine.tools.register(tool);
          }
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
        intervalMs: config.observerIntervalMs ?? 30 * 60 * 1000,
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

  /** Shutdown everything gracefully. */
  async shutdown(): Promise<void> {
    this.scheduler?.stop();
    await this.pool?.shutdown();
    this.started = false;
    console.log('[EngineAdapter] Shut down.');
  }

  // ─── Council Agents ──────────────────────────────────────────────────

  /**
   * Start the three council agents: Observer, QA, Council.
   * Each is a PandoCode engine with a specialized system prompt and tool set.
   * See BIBLE.md Section 5.10 for architecture.
   */
  private async startCouncilAgents(): Promise<void> {
    if (!this.pool || !this.config) return;

    const { join } = await import('node:path');
    const { mkdirSync } = await import('node:fs');
    const baseDir = this.config.dataDir || join((await import('node:os')).homedir(), '.pando');

    const agents = [
      { id: 'observer', prompt: OBSERVER_PROMPT },
      { id: 'qa',       prompt: QA_PROMPT },
      { id: 'council',  prompt: COUNCIL_PROMPT },
    ];

    for (const agent of agents) {
      const agentDir = join(baseDir, 'council', agent.id);
      mkdirSync(agentDir, { recursive: true });

      // Tool filtering happens in onAfterCreate via TOOL_SETS lookup by engine id
      await this.pool.getOrCreate(agent.id, {
        projectPath: agentDir,
        systemPrompt: agent.prompt,
      });

      console.log(`[EngineAdapter] Council agent "${agent.id}" started.`);
    }

    // Register scheduler ticks for each agent
    if (this.scheduler) {
      const observerInterval = this.config.observerIntervalMs ?? 30 * 60_000;
      const qaInterval = this.config.qaIntervalMs ?? 30 * 60_000;
      const councilInterval = this.config.councilIntervalMs ?? 15 * 60_000;

      this.scheduler.register({
        name: 'observer-tick',
        engineId: 'observer',
        intervalMs: observerInterval,
        prompt: 'Run your periodic checks. Monitor network health, peer connectivity, deployment status. Report anomalies as findings.',
        active: true,
      });

      this.scheduler.register({
        name: 'qa-tick',
        engineId: 'qa',
        intervalMs: qaInterval,
        prompt: 'Run your test suite. Check API health, peer connectivity, project system integrity. Report failures as findings.',
        active: true,
        delayMs: Math.floor(observerInterval / 2), // offset by half to stagger
      });

      this.scheduler.register({
        name: 'council-tick',
        engineId: 'council',
        intervalMs: councilInterval,
        prompt: 'Check findings. Read open findings, prioritize by severity, and act on actionable items. Resolve what you can.',
        active: true,
      });

      console.log('[EngineAdapter] Council scheduler ticks registered.');
    }
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

    // 3. Warn if no keys available at all
    const finalAvailable = Object.entries(PROVIDER_ENV_MAP).filter(([_, v]) => process.env[v]);
    if (finalAvailable.length === 0) {
      console.warn('[EngineAdapter] No AI API keys found. PandoCode will use its own configured provider. Set GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY if needed.');
    }
  }
}
