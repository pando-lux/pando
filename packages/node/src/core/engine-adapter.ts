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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ResourceRegistry } from '../platform/resource-registry.js';
import { STREAM_EVENT_VERSION } from '@pando/shared';
import type { StreamEvent } from '@pando/shared';

// Two Laws Content Filter — imported from shared constants (defense-in-depth at storage level)
import { HARM_PATTERNS, SHUTDOWN_PATTERNS } from '../constants.js';

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

// Daily emission cap — mirrors DAILY_EMISSION_CAP from @pando/shared for budget boundary enforcement
const DAILY_EMISSION_CAP_LUX = 500;

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
      let luxCost = usd * luxPerUsd;

      // H-1: Cap converted amount so a single task can't exceed DAILY_EMISSION_CAP
      if (luxCost > DAILY_EMISSION_CAP_LUX) {
        console.warn(`[LuxBudget] Task Lux cost ${luxCost.toFixed(2)} exceeds daily emission cap (${DAILY_EMISSION_CAP_LUX}). Capping to ${DAILY_EMISSION_CAP_LUX} Lux.`);
        luxCost = DAILY_EMISSION_CAP_LUX;
      }

      return luxCost;
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
        const { execSync } = await import('node:child_process');
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
          console.error(`[engine-adapter] pando_workspace failed: ${err.message}`);
          return { success: false, output: 'pando_workspace failed: internal error' };
        }
      },
    },
  ];
}

/**
 * Create the manage_team tool for lead agents.
 * Allows leads to spawn, stop, and list sub-agents from templates.
 */
async function createManageTeamTool(
  adapter: EngineAdapter,
  teamId: string,
): Promise<any> {
  const { z } = await import('zod');
  return {
    name: 'manage_team',
    description: 'Manage your team: spawn agents from templates, list team members, stop agents.',
    parameters: z.object({
      action: z.enum(['spawn', 'list', 'stop', 'templates']).describe(
        'Action: spawn (create agent), list (show team), stop (remove agent), templates (show available)'
      ),
      template: z.string().optional().describe('Template ID for spawn (e.g. "worker", "builder", "tester")'),
      task: z.string().optional().describe('Task description for spawned agent (appended to template prompt)'),
      customPrompt: z.string().optional().describe('Full custom prompt instead of template (for novel agents)'),
      agentId: z.string().optional().describe('Agent ID for stop action, or custom ID for spawn'),
    }),
    execute: async (args: any) => {
      const ok = (data: any) => ({ success: true, output: JSON.stringify(data, null, 2) });
      const fail = (msg: string) => ({ success: false, output: msg });

      switch (args.action) {
        case 'templates': {
          const allTemplates = adapter.getTemplates();
          const templates = allTemplates.map(t => ({
            id: t.id, displayName: t.displayName, description: t.description, role: t.role,
          }));
          return ok({ templates });
        }

        case 'list': {
          const teamData = adapter.getTeamAgents(teamId);
          return ok({ teamId, agents: teamData });
        }

        case 'spawn': {
          const allTemplates = adapter.getTemplates();
          const template = args.template ? allTemplates.find((t: AgentTemplate) => t.id === args.template) : null;
          let prompt = '';
          let role = 'worker';
          let model = 'claude-code';

          if (template) {
            prompt = template.promptSkeleton;
            role = template.role;
            model = template.model;
            if (args.task) {
              prompt += `\n\n## Your Current Task\n${args.task}`;
            }
          } else if (args.customPrompt) {
            prompt = args.customPrompt;
            if (args.task) {
              prompt += `\n\n## Your Current Task\n${args.task}`;
            }
          } else {
            return fail('Provide either a template ID or customPrompt');
          }

          const agentId = args.agentId || `${args.template || 'custom'}-${Date.now().toString(36)}`;

          // Check agent limit per team (max 10 agents to prevent runaway spawning)
          const currentAgents = adapter.getTeamAgents(teamId);
          if (currentAgents.length >= 10) {
            return fail('Team agent limit reached (10). Stop unused agents before spawning new ones.');
          }

          try {
            await adapter.spawnTeamAgent(teamId, {
              id: agentId,
              role,
              displayName: template?.displayName || 'Custom Agent',
              prompt,
              model,
              tickIntervalMs: template?.tickIntervalMs || 0,
            });
            return ok({ spawned: agentId, role, template: args.template || 'custom' });
          } catch (err: any) {
            return fail(`Failed to spawn agent: ${err.message}`);
          }
        }

        case 'stop': {
          if (!args.agentId) return fail('agentId required for stop action');
          // Don't allow stopping the lead itself
          if (args.agentId === 'lead') return fail('Cannot stop the lead agent');
          try {
            await adapter.stopTeamAgent(teamId, args.agentId);
            return ok({ stopped: args.agentId });
          } catch (err: any) {
            return fail(`Failed to stop agent: ${err.message}`);
          }
        }

        default:
          return fail(`Unknown action: ${args.action}`);
      }
    },
  };
}

// ─── Team Agent Config ──────────────────────────────────────────────────

export interface TeamAgentConfig {
  id: string;
  role: string;
  displayName: string;
  prompt: string;
  promptTemplate?: string;  // template ID — resolved at startTeam() time
  model?: string;
  tickIntervalMs?: number;
}

// ─── Prompt Parameterization ─────────────────────────────────────────────

export interface PromptContext {
  projectDir: string;   // resolved nodeRepoRoot
  apiPort: number;      // from config
  teamId?: string;      // team being started (for universal templates)
  repos?: string[];     // repos assigned to the team
  model?: string;       // 'claude-code' | 'gemini-*' | 'gpt-*' etc — for model-specific prompts
}

// ─── Agent Templates ─────────────────────────────────────────────────────

/** Agent template — a reusable blueprint for spawning agents. */
export interface AgentTemplate {
  id: string;
  displayName: string;
  description: string;
  role: string;
  promptSkeleton: string;
  model: string;
  tickIntervalMs: number;   // 0 = on-demand only (no periodic tick)
}

/** Built-in templates that ship with the code. */
export const BUILT_IN_TEMPLATES: AgentTemplate[] = [
  {
    id: 'worker',
    displayName: 'Worker',
    description: 'Simple task executor. Does what the lead tells it.',
    role: 'worker',
    promptSkeleton: 'You are a worker agent. Execute the task given to you. Use bash, read, write, edit tools. When done, report results by printing a clear summary. Be brief. Act, don\'t narrate.',
    model: 'claude-code',
    tickIntervalMs: 0,
  },
  {
    id: 'builder',
    displayName: 'Builder',
    description: 'Code writer with git access. Builds features, fixes bugs.',
    role: 'builder',
    promptSkeleton: 'You are a builder agent. You write code, fix bugs, and build features. Always: read before edit, npm run build after changes, git commit with descriptive message. When done, print a clear summary of what you changed.',
    model: 'claude-code',
    tickIntervalMs: 0,
  },
  {
    id: 'tester',
    displayName: 'Tester',
    description: 'Runs tests and reports failures. Read-only codebase access.',
    role: 'tester',
    promptSkeleton: 'You are a tester agent. Run tests: npm run build, npx playwright test. Report failures to lead with specific error messages and file:line locations. Do NOT modify code.',
    model: 'claude-code',
    tickIntervalMs: 0,
  },
  {
    id: 'observer',
    displayName: 'Observer',
    description: 'Monitors health. Reports anomalies. Read-only.',
    role: 'explorer',
    promptSkeleton: 'You are an observer agent. Monitor system health via curl to /v1/health and /v1/status. Report anomalies by printing findings. You are READ-ONLY. Never modify code or files.',
    model: 'claude-code',
    tickIntervalMs: 60 * 60_000,
  },
  {
    id: 'reviewer',
    displayName: 'Code Reviewer',
    description: 'Reviews code changes for quality, security, and architecture.',
    role: 'reviewer',
    promptSkeleton: 'You are a code reviewer. Review diffs for: security vulnerabilities, architectural violations, code quality issues. Print a clear report of findings.',
    model: 'claude-code',
    tickIntervalMs: 0,
  },
];

/**
 * Load custom agent templates from disk.
 * Files: ~/.pando/teams/templates/*.json
 * Each file is a single AgentTemplate JSON object.
 */
function loadCustomTemplates(): AgentTemplate[] {
  try {
    const dir = pathJoin(homedir(), '.pando', 'teams', 'templates');

    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'));
    const templates: AgentTemplate[] = [];

    for (const file of files) {
      try {
        const content = readFileSync(pathJoin(dir, file), 'utf-8');
        const parsed = JSON.parse(content);
        // Validate required fields
        if (parsed.id && parsed.role && parsed.promptSkeleton) {
          templates.push({
            id: parsed.id,
            displayName: parsed.displayName || parsed.id,
            description: parsed.description || '',
            role: parsed.role,
            promptSkeleton: parsed.promptSkeleton,
            model: parsed.model || 'claude-code',
            tickIntervalMs: parsed.tickIntervalMs || 0,
          });
        }
      } catch { /* skip invalid files */ }
    }
    return templates;
  } catch {
    return [];
  }
}

// ─── Seed Configs (pando-infra team prompts — parameterized) ──────────

function makeObserverPrompt(ctx: PromptContext): string {
  return `You are the Pando Network Observer. You monitor network health and report problems to the lead.

IMPORTANT: You MUST call tools. Do not just describe what you would do — actually call the tools.
IMPORTANT: Complete in 5 tool calls or fewer. Do NOT loop or recheck.

STEP 1: Call pando_status to get node health (peer count, uptime, health status).
STEP 2: Call pando_peers to get connected peer details.
STEP 3: Analyze the results IN ONE PASS:
  - If peer count is 0: curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId || 'pando-infra'}/message -H "Content-Type: application/json" -d '{"from":"observer","to":"lead","message":"[CRITICAL:health] No peers connected. Node is isolated."}'
  - If peer count is 1: send message to lead: "[WARNING:health] Only 1 peer connected. Expected 2+. Peer: ..."
  - If health status is degraded: send message to lead: "[WARNING:health] Degraded: ..."
  - If peer count >= 2 AND health is good: say "All healthy. No issues to report." and STOP.

SEND MESSAGE TO LEAD: curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId || 'pando-infra'}/message -H "Content-Type: application/json" -d '{"from":"observer","to":"lead","message":"<your report>"}'

RULES:
- 2+ peers is HEALTHY for the current network size.
- Include SPECIFIC details (peer count, peer IDs, error details).
- Do NOT loop or recheck. One pass: status → peers → analyze → report → done.
- You are READ-ONLY. Never modify code or files.
- You do NOT have PandoCode tools. Use bash (curl) for API calls and bash for commands.`;
}

function makeQAPrompt(ctx: PromptContext): string {
  return `You are the Pando QA Agent. You run real tests and report failures to the lead.

IMPORTANT: You MUST call tools. Do not just describe what you would do — actually call the tools.
IMPORTANT: Complete in 10 tool calls or fewer.

STEP 1: Run the build to verify compilation:
  bash: cd ${ctx.projectDir} && npm run build 2>&1 | tail -5
  - If build fails: send_message (toAgentId: "lead", message: "[CRITICAL:build] Build failed: <error>")

STEP 2: Check node health via API:
  bash: curl -s http://localhost:${ctx.apiPort}/v1/health | head -20
  - If unhealthy: include in report

STEP 3: Run E2E tests (if build passed):
  bash: cd ${ctx.projectDir} && npx playwright test --project pando-node tests/e2e/pando-node/pando-e2e.spec.ts 2>&1 | tail -30
  - Note: Tests may take 2+ minutes. This is normal.

STEP 4: Analyze ALL results and send ONE report to lead:
  - If all passed: say "All checks passed. Build OK. Tests OK." and STOP.
  - If anything failed: send report to lead:
    curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId || 'pando-infra'}/message -H "Content-Type: application/json" -d '{"from":"qa","to":"lead","message":"[SEVERITY:category] What failed — details"}'

RULES:
- Run REAL commands, not just API checks.
- Include SPECIFIC output (error messages, test names, line numbers).
- Do NOT loop or recheck. One pass through all steps.
- You do NOT have PandoCode tools. Use bash (curl) for API calls.`;
}

function makeLeadPrompt(ctx: PromptContext): string {
  return `You are the Pando Infrastructure Lead. You manage the network by processing your inbox and board queue.

You run on Claude Code CLI. You have full bash, read, write, edit tools available.
Your INBOX and BOARD STATE are injected below this message — no tool call needed to read them.

## Processing Steps

1. Read the INBOX section below. Messages come from Observer and QA agents.
2. Read the BOARD STATE section below. Tasks tagged [BUG:user], [FEATURE:user] come from users.
3. Process items by priority: CRITICAL > BUG:user > WARNING > FEATURE:user > INFO.
4. For each actionable item:
   - Monitoring issues: If it seems resolved or transient, mark task done. If real, investigate.
   - Code fixes — use bash, read, edit tools directly:
     1. Find the file, read it, understand the issue.
     2. Edit the file to fix the bug.
     3. Run: npm run build (must pass with zero errors).
     4. git add <files> && git commit -m "fix: description" && git push origin master
     5. Get commit hash: git rev-parse HEAD
     6. Propose governance upgrade:
        curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/governance/propose -H "Content-Type: application/json" -d '{"title":"[Upgrade] fix: description","description":"...","category":"upgrade","commitHash":"<hash>"}'
     7. Update the task:
        curl -s -X PATCH http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId || 'pando-infra'}/board/<taskId> -H "Content-Type: application/json" -d '{"status":"done","progress":"Fixed in <hash>"}'
   - User requests: investigate, then update task progress via PATCH.
   - False positives / stale (>24h): mark done with a note.
5. If inbox empty AND no pending board tasks: say "System healthy. No open issues." and STOP.

## After Governance Approval
The upgrade protocol auto-deploys to ALL nodes:
  git fetch → verify hash → build → safe restart (exit 75) → supervisor respawns

## HTTP API (use curl for ALL operations — you do NOT have PandoCode tools, only bash/read/write/edit)
GOVERNANCE PROPOSE: curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/governance/propose -H "Content-Type: application/json" -d '{"title":"[Upgrade] fix: description","description":"...","category":"upgrade","commitHash":"<hash>"}'
UPDATE TASK: curl -s -X PATCH http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId || 'pando-infra'}/board/<taskId> -H "Content-Type: application/json" -d '{"status":"done","progress":"<notes>"}'
CREATE TASK: curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId || 'pando-infra'}/board -H "Content-Type: application/json" -d '{"title":"<title>","description":"<desc>"}'
SEND MESSAGE: curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId || 'pando-infra'}/message -H "Content-Type: application/json" -d '{"from":"lead","to":"<agentId>","message":"<text>"}'
SPAWN AGENT: curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId || 'pando-infra'}/agents/spawn -H "Content-Type: application/json" -d '{"template":"worker","task":"<description>"}'
STOP AGENT: curl -s -X DELETE http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId || 'pando-infra'}/agents/<agentId>
LIST AGENTS: curl -s http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId || 'pando-infra'}/agents
LIST TEMPLATES: curl -s http://127.0.0.1:${ctx.apiPort}/v1/templates

RULES:
- Every code change goes through governance.
- npm run build MUST pass before committing.
- Be brief. Act, don't narrate. Complete quickly.
- Close or update tasks when done. Do NOT leave tasks perpetually pending.`;
}

function makeUniversalLeadPrompt(ctx: PromptContext & { teamId: string; repos?: string[] }): string {
  const repoList = ctx.repos?.length ? ctx.repos.map(r => `  - ${r}`).join('\n') : '  - (no repos configured yet)';
  return `You are the Lead Agent for the "${ctx.teamId}" team. You manage this team autonomously.

You run on Claude Code CLI. You have full bash, read, write, edit tools available.
Your INBOX and BOARD STATE are injected below this message when available.

## Your Responsibilities
1. Read your inbox for messages from other agents.
2. Read your board for pending tasks from users.
3. Process tasks by priority: CRITICAL > BUG > WARNING > FEATURE.
4. For code work, use your tools directly (read, edit, bash).
5. After code changes: npm run build (must pass) → git commit → report results.

## Your Repos
${repoList}

## Team Management
You can spawn sub-agents when you need help:
- Simple tasks: do them yourself (faster, cheaper)
- Complex tasks: spawn a worker or builder agent
- Test verification: spawn a tester agent
- Stop agents when their work is done

## HTTP API (use curl for ALL operations — you do NOT have PandoCode tools, only bash/read/write/edit)
UPDATE TASK: curl -s -X PATCH http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId}/board/<taskId> -H "Content-Type: application/json" -d '{"status":"done","progress":"<notes>"}'
CREATE TASK: curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId}/board -H "Content-Type: application/json" -d '{"title":"<title>","description":"<desc>"}'
SEND MESSAGE: curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId}/message -H "Content-Type: application/json" -d '{"from":"lead","to":"<agentId>","message":"<text>"}'
SPAWN AGENT: curl -s -X POST http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId}/agents/spawn -H "Content-Type: application/json" -d '{"template":"worker","task":"<description>"}'
STOP AGENT: curl -s -X DELETE http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId}/agents/<agentId>
LIST AGENTS: curl -s http://127.0.0.1:${ctx.apiPort}/v1/teams/${ctx.teamId}/agents
LIST TEMPLATES: curl -s http://127.0.0.1:${ctx.apiPort}/v1/templates

## Rules
- Be brief. Act, don't narrate. Complete quickly.
- Close or update tasks when done.
- Don't spawn agents for simple work you can do yourself.
- npm run build MUST pass before committing.`;
}

/** Map of promptTemplate IDs to their generator functions. */
const PROMPT_TEMPLATES: Record<string, (ctx: PromptContext) => string> = {
  'observer-health': makeObserverPrompt,
  'qa-tests': makeQAPrompt,
  'lead-infra': makeLeadPrompt,
  'lead-universal': makeUniversalLeadPrompt as (ctx: PromptContext) => string,
};

/** Seed config for pando-infra team (the network management team). */
export const PANDO_INFRA_AGENTS: TeamAgentConfig[] = [
  { id: 'lead',     role: 'lead',     displayName: 'Infrastructure Lead', prompt: '', promptTemplate: 'lead-infra',       model: 'claude-code', tickIntervalMs: 15 * 60_000 },
  { id: 'observer', role: 'explorer', displayName: 'Network Observer',    prompt: '', promptTemplate: 'observer-health',   model: 'claude-code', tickIntervalMs: 60 * 60_000 },
  { id: 'qa',       role: 'tester',   displayName: 'QA Agent',            prompt: '', promptTemplate: 'qa-tests',          model: 'claude-code', tickIntervalMs: 120 * 60_000 },
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
  private projectIntervals = new Map<string, NodeJS.Timeout>();  // projectId → tick interval (keyed to prevent leaks)
  private activeTeams = new Map<string, { dbPath: string; agents: TeamAgentConfig[]; intervals: any[] }>();

  /** Whether the adapter is ready (pando-code loaded + pool started). */
  get available(): boolean { return this.started; }

  /** Network linking: always linked when adapter is started (node IS the network). */
  get linked(): boolean { return this.started; }

  /**
   * Start the adapter: load pando-code, create pool, boot system engine.
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
      /** defaultModel: Override PandoCode's default model selection. Only set when
       *  the node operator explicitly specifies a model via CLI/config. When omitted,
       *  PandoCode uses its own configured provider/model from ~/.pando-code/config. */
      ...(config.model ? { defaultModel: config.model } : {}),
      defaultRole: 'lead',
      maxEngines: 20,
      idleTTLMs: 30 * 60 * 1000,
      // skipKnowledgeSync: Disables PandoCode's internal knowledge base sync on engine creation.
      // Pando nodes manage their own data sync via P2P — PandoCode's KB sync would be redundant.
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
    // If no event is yielded within timeoutMs, yield an error and return.
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
        // If we yielded a timeout error, stop the iteration
        if (result.value?.type === 'error' && done) {
          // Try to clean up the source iterator
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
    const { execSync } = await import('node:child_process');
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
            // Dir already exists — use git init + fetch + checkout (clone fails on non-empty dirs)
            const gitDir = pathJoin(projectDir, '.git');
            if (!fsExists(gitDir)) {
              execSync('git init', { cwd: projectDir, timeout: 10_000, stdio: 'pipe', windowsHide: true });
              const { execFileSync: efs } = await import('node:child_process');
              efs('git', ['remote', 'add', 'origin', project.repoUrl], { cwd: projectDir, timeout: 10_000, stdio: 'pipe', windowsHide: true });
            }
            execSync('git fetch origin', { cwd: projectDir, timeout: 60_000, stdio: 'pipe', windowsHide: true });
            // Try main branch first, fall back to master
            try {
              execSync('git checkout -f origin/main -- .', { cwd: projectDir, timeout: 30_000, stdio: 'pipe', windowsHide: true });
            } catch {
              execSync('git checkout -f origin/master -- .', { cwd: projectDir, timeout: 30_000, stdio: 'pipe', windowsHide: true });
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

  /** M2-2: Guard — throws if pool is not initialized (start() not called). */
  private requirePool(): void {
    if (!this.pool) throw new Error('EngineAdapter not started — call start() first');
  }

  /**
   * H-2 + H-3: Normalize a raw PandoCode engine event into a typed StreamEvent
   * with protocol version. Use this when forwarding events to API consumers
   * who need a stable, versioned contract.
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

  /** Get available agent templates (built-in + custom from disk). */
  getTemplates(): AgentTemplate[] {
    const custom = loadCustomTemplates();
    // Custom templates override built-in if same ID
    const customIds = new Set(custom.map(t => t.id));
    const filtered = BUILT_IN_TEMPLATES.filter(t => !customIds.has(t.id));
    return [...filtered, ...custom];
  }

  /**
   * Get tasks from a team's board.
   * @param includeDone If true, also returns 'done' tasks.
   */
  getTeamBoard(teamId: string, includeDone = false): any[] {
    const teamData = this.activeTeams.get(teamId);
    return this.getBoardTasks(teamData?.dbPath ?? null, includeDone);
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
    // Sanitize agentId to prevent LIKE wildcard injection (% or _)
    if (!agentId || typeof agentId !== 'string' || /[%_]/.test(agentId)) return [];
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
      const uuid = randomUUID();
      const key = `msg:${toAgentId}:${uuid}`;
      const value = JSON.stringify({ from: fromAgentId, message, timestamp: new Date().toISOString() });
      const ttl = new Date(Date.now() + 3600_000).toISOString(); // 1 hour
      db.prepare(
        `INSERT OR REPLACE INTO state (key, value, updated_at, expires_at) VALUES (?, ?, datetime('now'), ?)`
      ).run(key, value, ttl);
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
    // Whitelist of allowed board_tasks columns — defense-in-depth against SQL injection
    const ALLOWED_COLUMNS = new Set(['status', 'progress']);
    const teamData = this.activeTeams.get(teamId);
    if (!teamData?.dbPath || !this.Database) return false;
    try {
      const db = new this.Database(teamData.dbPath);
      const sets: string[] = [];
      const vals: any[] = [];
      if (updates.status && ALLOWED_COLUMNS.has('status')) { sets.push('status = ?'); vals.push(updates.status.replace(/-/g, '_')); }
      if (updates.progress !== undefined && ALLOWED_COLUMNS.has('progress')) { sets.push('progress = ?'); vals.push(updates.progress); }
      if (sets.length === 0) { db.close(); return false; }
      vals.push(taskId);
      const result = db.prepare(`UPDATE board_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      db.close();
      return result.changes > 0;
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
    })().catch(err => console.error('[engine-adapter] unhandled async error:', err));
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

      const id = `task-${randomUUID()}`;
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

    // Clear any existing interval for this project before creating a new one
    const existing = this.projectIntervals.get(projectId);
    if (existing) clearInterval(existing);

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

    // Store in Map keyed by projectId (prevents unbounded accumulation)
    this.projectIntervals.set(projectId, tickInterval);

    console.log(`[EngineAdapter] Project "${projectId}" scheduler tick registered (every 6h).`);
  }

  /**
   * Stop all project tick intervals and clear the Map. Call on shutdown.
   */
  stopProjectTicks(): void {
    for (const [projectId, interval] of this.projectIntervals) {
      clearInterval(interval);
    }
    this.projectIntervals.clear();
    this.projectTicks.clear();
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
    this.stopProjectTicks();
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

    // Reserve slot immediately to prevent concurrent startTeam races (TOCTOU)
    this.activeTeams.set(teamId, { dbPath: '', agents: [], intervals: [] });

    try {
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

    // Resolve prompt templates into concrete prompts using runtime context
    for (const agent of agents) {
      if (agent.promptTemplate && PROMPT_TEMPLATES[agent.promptTemplate]) {
        const promptCtx: PromptContext = {
          projectDir: nodeRepoRoot,
          apiPort: this.config!.apiPort,
          teamId,
          model: agent.model,
        };
        agent.prompt = PROMPT_TEMPLATES[agent.promptTemplate](promptCtx);
      }
    }

    // Import PandoCode tool creators for re-registration with correct agent IDs
    const { createCheckAgentsTool, createSendMessageTool, createManageTasksTool } =
      await import('@pando-code/core');

    const intervals: any[] = [];

    // Check for saved Claude CLI session IDs (for resume on restart)
    // Sessions older than 24 hours are considered stale and discarded.
    const savedSessions = new Map<string, string>();
    const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    if (this.Database) {
      try {
        const db = new this.Database(teamDbPath);
        // Ensure state table exists (schema must match PandoCode's state table)
        db.prepare(`CREATE TABLE IF NOT EXISTS state (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at TEXT,
          expires_at TEXT
        )`).run();
        const rows = db.prepare(
          `SELECT key, value, updated_at FROM state WHERE key LIKE 'cli-session:%'`
        ).all() as { key: string; value: string; updated_at: string | null }[];
        let staleCount = 0;
        for (const row of rows) {
          // Filter stale sessions (older than 24h)
          if (row.updated_at) {
            const age = Date.now() - new Date(row.updated_at).getTime();
            if (age > SESSION_TTL_MS) {
              staleCount++;
              continue;
            }
          }
          const agentId = row.key.replace('cli-session:', '');
          savedSessions.set(agentId, row.value);
        }
        // Clean up stale session entries
        if (staleCount > 0) {
          db.prepare(
            `DELETE FROM state WHERE key LIKE 'cli-session:%' AND updated_at < datetime('now', '-1 day')`
          ).run();
          console.warn(`[team:${teamId}] Discarded ${staleCount} stale session(s) (>24h old) — agents will start fresh`);
        }
        db.close();
        if (savedSessions.size > 0) {
          console.log(`[team:${teamId}] Found ${savedSessions.size} saved session(s) — will attempt resume`);
        }
      } catch { /* ok — fresh start */ }
    }

    // Create one engine per agent with shared DB
    for (const agent of agents) {
      const engineId = `${teamId}:${agent.id}`;
      const isLead = agent.role === 'lead';
      const savedSession = savedSessions.get(agent.id);
      const engine = await this.pool.getOrCreate(engineId, {
        projectPath: isLead ? nodeRepoRoot : teamDir,
        dbPath: teamDbPath,
        role: agent.role,
        skipKnowledgeSync: true,
        ...(agent.model ? { model: agent.model } : {}),
        ...(savedSession ? { claudeSessionId: savedSession } : {}),
      });

      // Log which model was actually resolved for this agent
      const resolvedModel = engine?.getModelId?.() || engine?.model || engine?.config?.model || agent.model || 'unknown';
      console.log(`[team:${teamId}] Agent "${agent.id}" engine created — requested model: ${agent.model || 'default'}, resolved: ${resolvedModel}`);

      // CRITICAL: Start session BEFORE re-registering tools
      if (!engine.getSessionId()) {
        await engine.startSession(`${teamId}: ${agent.id}`);
      }

      // Save Claude CLI session ID for persistence across restarts
      if (engine.getCliSessionId?.() && this.Database) {
        try {
          const db = new this.Database(teamDbPath);
          db.prepare(
            `INSERT OR REPLACE INTO state (key, value, updated_at)
             VALUES (?, ?, datetime('now'))`
          ).run(
            `cli-session:${agent.id}`,
            engine.getCliSessionId(),
          );
          db.close();
        } catch { /* state table may not exist yet */ }
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

      // Register manage_team tool on lead agents
      if (agent.role === 'lead') {
        const manageTeamTool = await createManageTeamTool(this, teamId);
        engine.tools.register(manageTeamTool);
        console.log(`[team:${teamId}] "${agent.id}": manage_team tool registered`);
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
          let consecutiveFailures = 0;
          const interval = setInterval(async () => {
            try {
              const msg = 'Check your inbox and review board tasks now.';
              for await (const event of this.sendToTeamAgent(teamId, agent.id, msg)) {
                logEvent(label)(event);
              }
              consecutiveFailures = 0;
              console.log(`\n[${label}] Tick complete.`);
            } catch (err: any) {
              consecutiveFailures++;
              const isFatal = /ENOENT|EPERM|spawn|session.*expired|not found|process.*exit/i.test(err.message);
              if (isFatal || consecutiveFailures >= 3) {
                console.error(`[${label}] CRITICAL: Engine appears dead (${consecutiveFailures} consecutive failures): ${err.message}`);
                console.error(`[${label}] CRITICAL: Agent "${agent.id}" needs manual restart or node restart to recover.`);
              } else {
                console.warn(`[${label}] Tick error (${consecutiveFailures}/3): ${err.message}`);
              }
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
    } catch (err: any) {
      // Release reservation on failure so team can be retried
      this.activeTeams.delete(teamId);
      console.error(`[EngineAdapter] CRITICAL: Failed to start team "${teamId}": ${err.message}`);
      throw err;
    }
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
   * Spawn a new agent into a running team. Called by manage_team tool.
   */
  async spawnTeamAgent(teamId: string, agentConfig: TeamAgentConfig): Promise<void> {
    const teamData = this.activeTeams.get(teamId);
    if (!teamData) throw new Error(`Team "${teamId}" not running`);
    if (!this.pool || !this.config) throw new Error('Adapter not started');

    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const nodeRepoRoot = resolve(thisDir, '..', '..', '..', '..');

    const engineId = `${teamId}:${agentConfig.id}`;
    const isLead = agentConfig.role === 'lead';

    // Create engine for this agent
    const engine = await this.pool.getOrCreate(engineId, {
      projectPath: isLead ? nodeRepoRoot : teamData.dbPath.replace(/[/\\][^/\\]+$/, ''),
      dbPath: teamData.dbPath,
      role: agentConfig.role,
      skipKnowledgeSync: true,
      ...(agentConfig.model ? { model: agentConfig.model } : {}),
    });

    // Start session
    if (!engine.getSessionId()) {
      await engine.startSession(`${teamId}: ${agentConfig.id}`);
    }

    // Save Claude CLI session ID for persistence across restarts
    if (engine.getCliSessionId?.() && this.Database) {
      try {
        const db = new this.Database(teamData.dbPath);
        db.prepare(
          `INSERT OR REPLACE INTO state (key, value, updated_at)
           VALUES (?, ?, datetime('now'))`
        ).run(
          `cli-session:${agentConfig.id}`,
          engine.getCliSessionId(),
        );
        db.close();
      } catch { /* state table may not exist yet */ }
    }

    // Re-register tools with correct agent ID
    const { createCheckAgentsTool, createSendMessageTool, createManageTasksTool } =
      await import('@pando-code/core');

    if (engine?.db) {
      engine.tools.unregister('check_agents');
      engine.tools.unregister('send_message');
      engine.tools.unregister('manage_tasks');

      const engineSessionId = engine.getSessionId()!;
      engine.tools.register(createCheckAgentsTool({ db: engine.db, agentId: agentConfig.id }));
      engine.tools.register(createSendMessageTool({ db: engine.db, agentId: agentConfig.id, senderRole: agentConfig.role }));
      engine.tools.register(createManageTasksTool({ db: engine.db, sessionId: engineSessionId }));
    }

    // Register manage_team tool on spawned lead agents
    if (agentConfig.role === 'lead') {
      const manageTeamTool = await createManageTeamTool(this, teamId);
      engine.tools.register(manageTeamTool);
      console.log(`[team:${teamId}] "${agentConfig.id}": manage_team tool registered`);
    }

    // Insert agent profile into shared DB
    try {
      const firstAgent = teamData.agents[0];
      const firstEngine = this.pool.get(`${teamId}:${firstAgent.id}`);
      if (firstEngine?.db) {
        const sqlite = (firstEngine.db as any).$client;
        sqlite.prepare(
          `INSERT OR REPLACE INTO agents (id, role, model, system_prompt, tools, scope, status, display_name, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(agentConfig.id, agentConfig.role, agentConfig.model || 'default', agentConfig.prompt, '[]', '{}', 'idle', agentConfig.displayName, new Date().toISOString());
      }
    } catch (err: any) {
      console.warn(`[team:${teamId}] Could not register spawned agent profile: ${err.message}`);
    }

    // Register scheduler tick if agent has one
    if (agentConfig.tickIntervalMs && agentConfig.tickIntervalMs > 0 && this.scheduler) {
      const label = `${teamId}:${agentConfig.id}`;
      this.scheduler.register({
        name: `${teamId}-${agentConfig.id}-tick`,
        engineId,
        intervalMs: agentConfig.tickIntervalMs,
        prompt: `${agentConfig.prompt}\n\n---\n\nRun your periodic checks now.`,
        active: true,
        onEvent: (event: any) => {
          if (event.type === 'stream:chunk' && event.content) process.stdout.write(`[${label}] ${event.content}`);
        },
        onComplete: () => console.log(`\n[${label}] Tick complete.`),
        onError: (err: Error) => console.warn(`[${label}] Tick error: ${err.message}`),
      });
    }

    // Track in active team data
    teamData.agents.push(agentConfig);
    console.log(`[team:${teamId}] Spawned agent "${agentConfig.id}" (role: ${agentConfig.role})`);
  }

  /**
   * Stop and remove an agent from a running team. Called by manage_team tool.
   */
  async stopTeamAgent(teamId: string, agentId: string): Promise<void> {
    const teamData = this.activeTeams.get(teamId);
    if (!teamData) throw new Error(`Team "${teamId}" not running`);

    // Unregister scheduler tick
    if (this.scheduler) {
      this.scheduler.unregister(`${teamId}-${agentId}-tick`);
    }

    // Remove from agent list
    const idx = teamData.agents.findIndex(a => a.id === agentId);
    if (idx >= 0) teamData.agents.splice(idx, 1);

    // Update agent status in DB
    try {
      const firstAgent = teamData.agents[0];
      if (firstAgent) {
        const engine = this.pool.get(`${teamId}:${firstAgent.id}`);
        if (engine?.db) {
          const sqlite = (engine.db as any).$client;
          sqlite.prepare(`UPDATE agents SET status = 'stopped' WHERE id = ?`).run(agentId);
        }
      }
    } catch { /* ok */ }

    // Destroy the engine process to free memory
    const engineId = `${teamId}:${agentId}`;
    try {
      const engine = this.pool.get(engineId);
      if (engine) {
        await engine.shutdown().catch(() => {});
        // Remove from pool internals (engines, lastUsed, createdAt are Maps)
        this.pool.engines?.delete(engineId);
        this.pool.lastUsed?.delete(engineId);
        this.pool.createdAt?.delete(engineId);
      }
    } catch { /* ok — engine may already be gone */ }

    console.log(`[team:${teamId}] Stopped agent "${agentId}" (engine destroyed)`);
  }

  /**
   * Get list of agents in a team (for manage_team list action).
   */
  getTeamAgents(teamId: string): { id: string; role: string; displayName: string; status: string; model: string }[] {
    const teamData = this.activeTeams.get(teamId);
    if (!teamData) return [];
    return teamData.agents.map(a => ({
      id: a.id,
      role: a.role,
      displayName: a.displayName,
      status: 'active',
      model: a.model || 'default',
    }));
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

  /** Get aggregate cost for a team from its PandoCode DB. */
  getTeamCost(teamId: string): { totalTokens: number; totalCostUsd: number; totalCostLux: number; byAgent: Record<string, number> } {
    const teamData = this.activeTeams.get(teamId);
    if (!teamData?.dbPath || !this.Database) return { totalTokens: 0, totalCostUsd: 0, totalCostLux: 0, byAgent: {} };
    try {
      const db = new this.Database(teamData.dbPath);
      // Check if budget_usage table exists before querying
      const tableCheck = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='budget_usage'`
      ).get();
      if (!tableCheck) {
        db.close();
        return { totalTokens: 0, totalCostUsd: 0, totalCostLux: 0, byAgent: {} };
      }
      // Discover columns dynamically — schema may vary across PandoCode versions
      const cols = db.prepare(`PRAGMA table_info(budget_usage)`).all() as { name: string }[];
      const colNames = new Set(cols.map(c => c.name));
      const hasInputTokens = colNames.has('input_tokens');
      const hasOutputTokens = colNames.has('output_tokens');
      const hasEstimatedCostUsd = colNames.has('estimated_cost_usd');
      const hasTokens = colNames.has('tokens');

      // Build token and cost expressions based on available columns
      const tokenExpr = hasInputTokens && hasOutputTokens
        ? 'SUM(b.input_tokens + b.output_tokens)'
        : hasTokens ? 'SUM(b.tokens)' : '0';
      const costExpr = hasEstimatedCostUsd ? 'SUM(b.estimated_cost_usd)' : '0';

      // Per-agent attribution: join budget_usage with sessions table.
      // PandoCode session titles follow the format "teamId: agentRole",
      // which lets us extract the agent name from the session title.
      const hasSessionsTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`
      ).get();
      const hasSessionId = colNames.has('session_id');

      let rows: { agent_name: string; tokens: number; cost: number }[];
      if (hasSessionsTable && hasSessionId) {
        rows = db.prepare(
          `SELECT COALESCE(s.title, 'unknown') as agent_name, ${tokenExpr} as tokens, ${costExpr} as cost
           FROM budget_usage b
           LEFT JOIN sessions s ON b.session_id = s.id
           GROUP BY agent_name`
        ).all() as { agent_name: string; tokens: number; cost: number }[];
      } else {
        // Fallback: no sessions table, aggregate without per-agent breakdown
        rows = db.prepare(
          `SELECT 'unknown' as agent_name, ${tokenExpr} as tokens, ${costExpr} as cost FROM budget_usage b`
        ).all() as { agent_name: string; tokens: number; cost: number }[];
      }
      db.close();

      const byAgent: Record<string, number> = {};
      let totalTokens = 0, totalCostUsd = 0;
      for (const row of rows) {
        // Extract agent role from session title (e.g., "pando-infra: lead" → "lead")
        const colonIdx = row.agent_name.indexOf(': ');
        const agentKey = colonIdx >= 0 ? row.agent_name.slice(colonIdx + 2) : row.agent_name;
        // Accumulate in case multiple session titles map to the same agent role
        byAgent[agentKey] = (byAgent[agentKey] || 0) + (row.tokens || 0);
        totalTokens += row.tokens || 0;
        totalCostUsd += row.cost || 0;
      }
      return { totalTokens, totalCostUsd, totalCostLux: totalCostUsd, byAgent };
    } catch {
      return { totalTokens: 0, totalCostUsd: 0, totalCostLux: 0, byAgent: {} };
    }
  }

  /**
   * Get recent messages from a team agent's sessions.
   * Queries the team's .pando-code.db for messages belonging to sessions
   * whose title contains the agentId (e.g. "pando-infra: lead").
   */
  getTeamAgentMessages(teamId: string, agentId: string, limit = 20): { role: string; content: string; createdAt: string }[] {
    const teamData = this.activeTeams.get(teamId);
    if (!teamData?.dbPath || !this.Database) return [];
    try {
      const db = new this.Database(teamData.dbPath);
      // Check if messages and sessions tables exist
      const hasMsgs = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='messages'`
      ).get();
      const hasSessions = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`
      ).get();
      if (!hasMsgs || !hasSessions) { db.close(); return []; }

      const rows = db.prepare(
        `SELECT m.role, substr(m.content, 1, 500) as content, m.created_at
         FROM messages m
         WHERE m.session_id IN (SELECT id FROM sessions WHERE title LIKE ?)
         ORDER BY m.created_at DESC LIMIT ?`
      ).all(`%${agentId}%`, limit) as { role: string; content: string; created_at: string }[];
      db.close();
      return rows.map(r => ({ role: r.role, content: r.content, createdAt: r.created_at }));
    } catch { return []; }
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
