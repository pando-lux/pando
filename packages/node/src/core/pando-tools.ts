/**
 * Pando Tools — HTTP wrappers injected into every engine by EngineAdapter.
 * KB: 14 tools giving AI agents direct access to the Pando node API (/v1/* endpoints).
 * KB: Registered in engine-adapter.ts pool.onAfterCreate — every engine gets all tools.
 * KB: MUST use 127.0.0.1, not localhost — Node.js fetch() can fail silently with localhost on some platforms.
 * KB: pando_workspace resolves local repo aliases (node/teams/code) before attempting GitHub clone.
 */

// KB: ResourceRegistry param removed Phase 6 — createPandoTools no longer resolves git credentials.
export async function createPandoTools(apiPort: number, apiToken?: string) {
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
        // Try ../teams first (new name), fall back to ../code (legacy name)
        const teamsRepoRoot = existsSync(join(nodeRepoRoot, '..', 'teams', '.git'))
          ? resolve(nodeRepoRoot, '..', 'teams')
          : resolve(nodeRepoRoot, '..', 'code');
        const localAliases: Record<string, string> = {
          'node': nodeRepoRoot,
          'pando-lux/node': nodeRepoRoot,
          'teams': teamsRepoRoot,
          'pando-lux/teams': teamsRepoRoot,
          'code': teamsRepoRoot,
          'pando-lux/code': teamsRepoRoot,
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
            const cloneUrl = repo.includes('/') ? `https://github.com/${repo}.git` : `https://github.com/pando-lux/${repo}.git`;
            const { GitOps: GO } = await import('./git-ops.js');
            GO.cloneSync(cloneUrl, workDir, branch);
            return { success: true, output: JSON.stringify({ path: workDir, status: 'cloned', repo, branch }) };
          }
        } catch (err: any) {
          console.error(`[pando-tools] pando_workspace failed: ${err.message}`);
          return { success: false, output: 'pando_workspace failed: internal error' };
        }
      },
    },
  ];
}
