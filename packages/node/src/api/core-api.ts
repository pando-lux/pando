/**
 * Layer 1 (Core) API routes — registered by registerCoreRoutes().
 *
 * Routes: /upgrade (remaining), /emissions/*, /security/*,
 *         /admin/shutdown, /admin/migrate-apps, /admin/cleanup-projects
 *
 * Note: /agents/* and /auth/* are in platform-api.ts.
 *       /instances/* is in platform-api.ts.
 */

import { execSync } from 'node:child_process';
import { GitOps } from '../core/git-ops.js';
import type { RouteHelpers } from './middleware/auth.js';
import { violatesTwoLaws } from './api-server.js';

export async function registerCoreRoutes(fastify: any, deps: RouteHelpers): Promise<void> {
  const { node } = deps;
    // ── Upgrade Route ─────────────────────────────────────────────────────────
    // POST /upgrade — Pull latest code, build, and schedule graceful restart.
    // Idempotent: if an upgrade is already in progress, returns current status.
    fastify.post('/upgrade', async (request: any, reply: any) => {
      // Governance hardening: require operator bearer token
      const authHeader = request.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== deps.apiToken) {
        return reply.code(401).send({ error: 'Operator authentication required for /upgrade' });
      }

      // Idempotent — return status if already in progress or pending restart
      if (node.isUpgradeInProgress()) {
        return { status: 'in_progress', message: 'Upgrade already in progress.' };
      }
      if (node.isRestartPending()) {
        return { status: 'restart_pending', message: 'Build succeeded. Waiting for active tasks to finish before restart.' };
      }

      node.setUpgradeInProgress(true);

      // Determine repo directory — launchers cd into the repo root before starting
      const repoDir = process.cwd();

      try {
        const git = new GitOps(repoDir);

        // Step 0: ensure git safe.directory (compute instances run as 'pando' user, repo cloned by root)
        git.addSafeDirectory();

        // Step 1: fetch + reset to origin/master (handles orphan-branch force pushes)
        console.log('[upgrade] Fetching latest code...');
        let pullOutput: string;
        try {
          git.fetch('origin', 'master');
          const localSha = git.getCurrentCommit();
          const remoteSha = git.getRemoteCommit('origin', 'master');
          if (localSha === remoteSha) {
            pullOutput = 'Already up to date.';
          } else {
            git.stashAndReset('origin/master');
            pullOutput = `Updated ${localSha.slice(0, 8)} -> ${remoteSha.slice(0, 8)}`;
          }
        } catch (err: any) {
          node.setUpgradeInProgress(false);
          const msg = err.stderr?.toString()?.slice(0, 500) || err.message;
          console.error(`[upgrade] Git fetch/reset failed: ${msg}`);
          return reply.code(500).send({ status: 'error', step: 'git_pull', error: 'Git pull failed' });
        }

        // Check if already up to date
        if (pullOutput.includes('Already up to date') || pullOutput.includes('Already up-to-date')) {
          node.setUpgradeInProgress(false);
          console.log('[upgrade] Already up to date. No build needed.');
          return { status: 'up_to_date', message: 'Already up to date. No changes to build.' };
        }

        console.log(`[upgrade] Pull result: ${pullOutput.split('\n')[0]}`);

        // Step 2a: Install dependencies (new packages may have been added)
        console.log('[upgrade] Installing dependencies...');
        try {
          execSync('npm install', {
            cwd: repoDir, encoding: 'utf-8', timeout: 180_000,
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          });
        } catch (installErr: any) {
          console.warn(`[upgrade] npm install warning: ${(installErr.stderr?.toString() || installErr.message)?.slice(0, 200)}`);
        }

        // Step 2b: npm run build
        console.log('[upgrade] Building...');
        try {
          execSync('npm run build', {
            cwd: repoDir,
            encoding: 'utf-8',
            timeout: 300_000, // 5 minutes
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (err: any) {
          node.setUpgradeInProgress(false);
          const stderr = err.stderr?.toString()?.slice(-500) || err.message;
          console.error(`[upgrade] Build FAILED: ${stderr}`);
          return reply.code(500).send({ status: 'error', step: 'build', error: 'Build failed' });
        }

        console.log('[upgrade] Build passed.');
        node.setUpgradeInProgress(false);

        // Step 3: Schedule graceful restart
        console.log('[upgrade] Scheduling graceful restart...');
        node.requestGracefulRestart();

        // Push SSE event so gateway knows
        deps.pushEvent('upgrade', {
          status: 'restart_pending',
          message: 'Upgrade successful. Restarting node...',
          timestamp: Date.now(),
        });

        return {
          status: 'restart_pending',
          message: 'Build succeeded. Node will restart after active tasks complete.',
          pullOutput: pullOutput.split('\n').slice(0, 5).join('\n'),
        };
      } catch (err: any) {
        node.setUpgradeInProgress(false);
        console.error(`[upgrade] Unexpected error: ${err.message}`);
        return reply.code(500).send({ status: 'error', step: 'unknown', error: 'Upgrade failed' });
      }
    });

    // GET /upgrade/status — Phase 82: simple upgrade status
    fastify.get('/upgrade/status', async () => {
      const upgradeProtocol = node.getUpgradeProtocol();
      return {
        upgradeInProgress: node.isUpgradeInProgress(),
        restartPending: node.isRestartPending(),
        ...(upgradeProtocol ? upgradeProtocol.getUpgradeStatus() : {}),
      };
    });

    // GET /upgrade/diagnose — diagnostic: check what the catchup timer would do
    fastify.get('/upgrade/diagnose', async () => {
      const upgradeProtocol = node.getUpgradeProtocol();
      const gov = node.getGovernance();
      if (!gov || !upgradeProtocol) return { error: 'Not ready' };

      const results: any[] = [];
      const proposals = gov.getProposals();
      const currentVersion = upgradeProtocol.getUpgradeStatus().currentVersion;

      for (const p of proposals) {
        if (p.status !== 'passed' || p.category !== 'upgrade') continue;
        const commitHash = (p as any).upgradePayload?.commitHash;
        if (!commitHash) { results.push({ id: p.id.slice(0, 16), skip: 'no commitHash' }); continue; }
        // Validate commitHash is a safe hex string (prevents command injection)
        if (!/^[0-9a-f]{6,40}$/i.test(commitHash)) { results.push({ id: p.id.slice(0, 16), skip: 'invalid commitHash format' }); continue; }
        if (upgradeProtocol.hasApplied(commitHash)) { results.push({ id: p.id.slice(0, 16), commitHash, skip: 'already applied' }); continue; }
        if (currentVersion?.startsWith(commitHash) || commitHash.startsWith((currentVersion || '').slice(0, commitHash.length))) {
          results.push({ id: p.id.slice(0, 16), commitHash, skip: 'current version matches' }); continue;
        }

        // Check git
        const diagGit = new GitOps(process.cwd());
        const isAncestor = diagGit.isAncestor(commitHash, 'HEAD');

        let canFetch = false;
        try {
          diagGit.lsRemote('origin', 'master');
          canFetch = true;
        } catch {}

        results.push({
          id: p.id.slice(0, 16),
          commitHash,
          currentVersion,
          isAncestor,
          canFetch,
          wouldUpgrade: !isAncestor && canFetch,
        });
      }

      return { diagnose: results, upgradeInProgress: node.isUpgradeInProgress() };
    });

    // POST /upgrade/propose — submit upgrade proposal (description only, no diff)
    fastify.post('/upgrade/propose', async (request: any, reply: any) => {
      const authHeader = request.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== deps.apiToken) {
        return reply.code(401).send({ error: 'Operator authentication required for /upgrade/propose' });
      }
      const upgradeProtocol = node.getUpgradeProtocol();
      if (!upgradeProtocol) {
        return reply.code(503).send({ error: 'Upgrade protocol not ready' });
      }
      const { description } = request.body || {};
      if (!description) {
        return reply.code(400).send({ error: 'Missing required field: description' });
      }
      try {
        const proposal = await upgradeProtocol.createUpgradeProposal(description);
        return { success: true, proposal };
      } catch (err: any) {
        return reply.code(400).send({ error: 'Failed to create upgrade proposal' });
      }
    });

    // POST /upgrade/rollback — emergency rollback
    fastify.post('/upgrade/rollback', async (request: any, reply: any) => {
      const authHeader = request.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== deps.apiToken) {
        return reply.code(401).send({ error: 'Operator authentication required for /upgrade/rollback' });
      }
      const upgradeProtocol = node.getUpgradeProtocol();
      if (!upgradeProtocol) {
        return reply.code(503).send({ error: 'Upgrade protocol not ready' });
      }
      const { reason, targetVersion } = request.body || {};
      if (reason) {
        upgradeProtocol.proposeEmergencyRollback(reason);
      }
      const result = await upgradeProtocol.executeRollback(targetVersion);
      return result;
    });

    // GET /upgrade/history — upgrade history
    fastify.get('/upgrade/history', async (request: any, reply: any) => {
      const upgradeProtocol = node.getUpgradeProtocol();
      if (!upgradeProtocol) {
        return reply.code(503).send({ error: 'Upgrade protocol not ready' });
      }
      return { history: upgradeProtocol.getUpgradeHistory() };
    });

    // POST /upgrade/pin — pin current version
    fastify.post('/upgrade/pin', async (request: any, reply: any) => {
      const authHeader = request.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== deps.apiToken) {
        return reply.code(401).send({ error: 'Operator authentication required for /upgrade/pin' });
      }
      const upgradeProtocol = node.getUpgradeProtocol();
      if (!upgradeProtocol) {
        return reply.code(503).send({ error: 'Upgrade protocol not ready' });
      }
      const { version } = request.body || {};
      if (!version) {
        return reply.code(400).send({ error: 'Missing required field: version' });
      }
      upgradeProtocol.pinVersion(version);
      return { success: true, pinnedVersion: version };
    });

    // POST /upgrade/unpin — unpin version
    fastify.post('/upgrade/unpin', async (request: any, reply: any) => {
      const authHeader = request.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== deps.apiToken) {
        return reply.code(401).send({ error: 'Operator authentication required for /upgrade/unpin' });
      }
      const upgradeProtocol = node.getUpgradeProtocol();
      if (!upgradeProtocol) {
        return reply.code(503).send({ error: 'Upgrade protocol not ready' });
      }
      upgradeProtocol.unpinVersion();
      return { success: true, pinnedVersion: null };
    });

    // ── Emission Witness API ────────────────────────────────

    // GET /emissions/pending — list pending emission proposals
    fastify.get('/emissions/pending', async () => {
      const ew = node.getEmissionWitness();
      if (!ew) {
        return { pending: [] };
      }
      return { pending: ew.getPending() };
    });

    // GET /emissions/history — list completed emission proposals
    fastify.get('/emissions/history', async (request: any) => {
      const ew = node.getEmissionWitness();
      if (!ew) {
        return { history: [] };
      }
      const limit = Math.min(parseInt(request.query?.limit) || 50, 200);
      return { history: ew.getHistory(limit) };
    });

    // GET /emissions/stats — emission system statistics
    fastify.get('/emissions/stats', async () => {
      const ew = node.getEmissionWitness();
      if (!ew) {
        return {
          totalProposals: 0, totalApproved: 0, totalRejected: 0,
          totalExpired: 0, pendingCount: 0, totalLuxEmitted: 0,
          proposalsThisHour: 0, rateLimitPerHour: 10,
          quorumRequired: 2, bootstrapFallback: true,
        };
      }
      return ew.getStats();
    });

    // ── Security Monitor API ──────────────────────────────────

    // GET /security/alerts — list security alerts (newest first)
    // Query params: ?limit=N, ?type=message_flood, ?severity=critical, ?active=true
    fastify.get('/security/alerts', async (request: any) => {
      const sm = node.getSecurityMonitor();
      if (!sm) {
        return { alerts: [] };
      }
      const limit = Math.min(parseInt(request.query?.limit) || 100, 200);
      const typeFilter = request.query?.type as string | undefined;
      const severityFilter = request.query?.severity as string | undefined;
      const activeFilter = request.query?.active as string | undefined;

      let alerts = sm.getAlerts(limit);

      if (typeFilter) {
        alerts = alerts.filter(a => a.type === typeFilter);
      }
      if (severityFilter) {
        alerts = alerts.filter(a => a.severity === severityFilter);
      }
      if (activeFilter === 'true') {
        alerts = alerts.filter(a => !a.resolved);
      } else if (activeFilter === 'false') {
        alerts = alerts.filter(a => a.resolved);
      }

      return { alerts };
    });

    // GET /security/stats — security system statistics
    fastify.get('/security/stats', async () => {
      const sm = node.getSecurityMonitor();
      if (!sm) {
        return {
          totalAlerts: 0, activeAlerts: 0, resolvedAlerts: 0,
          alertsByType: {}, quarantinedPeers: 0,
          detectorStatus: {}, lastCheckAt: null,
        };
      }
      return sm.getStats();
    });

    // GET /security/quarantine — list quarantined peers
    fastify.get('/security/quarantine', async () => {
      const sm = node.getSecurityMonitor();
      if (!sm) {
        return { quarantine: [] };
      }
      return { quarantine: sm.getQuarantine() };
    });

    // POST /security/quarantine/:peerId/release — release a peer from quarantine
    fastify.post('/security/quarantine/:peerId/release', async (request: any, reply: any) => {
      const sm = node.getSecurityMonitor();
      if (!sm) {
        return reply.code(503).send({ error: 'Security monitor not initialized.' });
      }
      const peerId = request.params.peerId;
      const entry = sm.releasePeer(peerId);
      if (!entry) {
        return reply.code(404).send({ error: 'Peer not found in quarantine or already released.' });
      }
      return { released: true, entry };
    });

    // GET /security/proofs — Resource proof scores for all peers (Phase 12.3)
    fastify.get('/security/proofs', async () => {
      const rpc = node.getResourceProofChallenger();
      if (!rpc) {
        return { scores: [] };
      }
      return { scores: rpc.getAllScores() };
    });

    // POST /security/challenge/:peerId — Trigger manual challenge (Phase 12.3)
    fastify.post('/security/challenge/:peerId', async (request: any, reply: any) => {
      const rpc = node.getResourceProofChallenger();
      if (!rpc) {
        return reply.code(503).send({ error: 'Resource proof challenger not initialized.' });
      }
      const peerId = request.params.peerId;
      const body = request.body || {};
      const challengeType = body.type || 'storage';

      try {
        let result;
        switch (challengeType) {
          case 'storage':
            result = await rpc.challengeStorage(peerId);
            break;
          case 'compute':
            result = await rpc.challengeCompute(peerId);
            break;
          case 'bandwidth':
            result = await rpc.challengeBandwidth(peerId);
            break;
          default:
            return reply.code(400).send({ error: `Invalid challenge type: ${challengeType}. Must be storage, compute, or bandwidth.` });
        }
        return { result };
      } catch (err: any) {
        console.error('[api] Challenge failed:', err.message);
        return reply.code(500).send({ error: 'Challenge failed' });
      }
    });

    // GET /security/safety-reviews — Content safety review history (Phase 12.5)
    fastify.get('/security/safety-reviews', async (request: any) => {
      const csr = node.getContentSafetyReviewer();
      if (!csr) {
        return { reviews: [] };
      }
      const contentId = request.query?.contentId as string | undefined;
      return { reviews: csr.getReviewHistory(contentId) };
    });

    // POST /security/quarantine/:peerId/appeal — Appeal quarantine (Phase 12.6)
    fastify.post('/security/quarantine/:peerId/appeal', async (request: any, reply: any) => {
      const sm = node.getSecurityMonitor();
      if (!sm) {
        return reply.code(503).send({ error: 'Security monitor not initialized.' });
      }
      const peerId = request.params.peerId;
      const { reason } = request.body || {};
      if (!reason || typeof reason !== 'string') {
        return reply.code(400).send({ error: 'Appeal reason is required.' });
      }
      const entry = sm.appealQuarantine(peerId, reason);
      if (!entry) {
        return reply.code(404).send({ error: 'Peer not found in active quarantine.' });
      }
      return { appealed: true, entry };
    });

    // ── Team API ──────────────────────────────────────────────────────────

    // GET /teams — List all teams from registry, enriched with active status
    fastify.get('/teams', async () => {
      const registry = node.getTeamRegistry();
      const adapter = node.getEngineAdapter();
      if (!registry) return { teams: [] };
      const teams = registry.listTeams().map((t: any) => ({
        ...t,
        running: adapter?.isTeamActive(t.id) ?? false,
      }));
      // Also include any active teams not in the registry (edge case: started without registration)
      const activeIds = adapter?.getActiveTeamIds?.() ?? [];
      for (const activeId of activeIds) {
        if (!teams.some((t: any) => t.id === activeId)) {
          teams.push({ id: activeId, running: true, displayName: activeId, status: 'active' });
        }
      }
      return { teams };
    });

    // GET /teams/:teamId — Team config + status
    fastify.get('/teams/:teamId', async (request: any, reply: any) => {
      const registry = node.getTeamRegistry();
      if (!registry) return reply.code(503).send({ error: 'Team registry not initialized' });
      const team = registry.getTeam(request.params.teamId);
      if (!team) return reply.code(404).send({ error: 'Team not found' });
      const adapter = node.getEngineAdapter();
      return { ...team, running: adapter?.isTeamActive(team.id) ?? false };
    });

    // GET /teams/:teamId/board — Board tasks (local or stub for remote)
    // Query params: ?include_done=true to also return completed tasks
    fastify.get('/teams/:teamId/board', async (request: any, reply: any) => {
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return { tasks: [] };
      const teamId = request.params.teamId as string;
      const includeDone = (request.query as any)?.include_done === 'true';
      return { tasks: adapter.getTeamBoard(teamId, includeDone) };
    });

    // POST /teams/:teamId/board — Add a task to team board
    fastify.post('/teams/:teamId/board', async (request: any, reply: any) => {
      const teamId = request.params.teamId as string;
      const body = request.body as any;
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      if (!title) return reply.code(400).send({ error: 'Title required' });
      if (title.length > 200) return reply.code(400).send({ error: 'Title too long (max 200 chars)' });
      const description = typeof body?.description === 'string' ? body.description.slice(0, 2000) : undefined;
      const lawViolation = violatesTwoLaws(`${title} ${description || ''}`);
      if (lawViolation) return reply.code(403).send({ error: lawViolation });
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'PandoCode not available' });
      const taskId = adapter.addTeamBoardTask(teamId, title, description);
      if (!taskId) return reply.code(500).send({ error: 'Failed to create task' });
      return { status: 'created', taskId };
    });

    // PATCH /teams/:teamId/board/:taskId — Update a board task
    fastify.patch('/teams/:teamId/board/:taskId', async (request: any, reply: any) => {
      const { teamId, taskId } = request.params as any;
      const body = request.body as any;
      if (body?.status && !['pending', 'in_progress', 'in-progress', 'done'].includes(body.status)) {
        return reply.code(400).send({ error: 'Invalid status. Must be: pending, in_progress, or done' });
      }
      if (body?.progress !== undefined && typeof body.progress !== 'string') {
        return reply.code(400).send({ error: 'Progress must be a string' });
      }
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'PandoCode not available' });
      const ok = adapter.updateTeamBoardTask(teamId, taskId, {
        status: body?.status,
        progress: typeof body?.progress === 'string' ? body.progress.slice(0, 1000) : undefined,
      });
      return ok ? { status: 'updated' } : reply.code(404).send({ error: 'Task not found or no changes' });
    });

    // POST /teams/:teamId/trigger — Trigger team lead immediately
    fastify.post('/teams/:teamId/trigger', async (request: any, reply: any) => {
      const teamId = request.params.teamId as string;
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) {
        return reply.code(503).send({ error: 'PandoCode not available on this node' });
      }
      if (!adapter.isTeamActive(teamId)) {
        return reply.code(404).send({ error: `Team "${teamId}" is not running on this node` });
      }

      const message = (request.body as any)?.message || 'Check your inbox and review board tasks now.';
      if (typeof message !== 'string' || message.length > 5000) {
        return reply.code(400).send({ error: 'Message must be a string (max 5000 chars)' });
      }
      const agentId = (request.body as any)?.agentId || 'lead';

      // Two Laws check on trigger message
      const lawViolation = violatesTwoLaws(message);
      if (lawViolation) return reply.code(403).send({ error: lawViolation });

      // Lead uses claude-code (slow) — run in background
      if (agentId === 'lead') {
        adapter.triggerTeamAgentBackground(teamId, agentId, message);
        return { team: teamId, agent: agentId, status: 'triggered', message: 'Running in background.' };
      }

      // Non-lead agents are fast — wait for completion
      const toolCalls: any[] = [];
      const textChunks: string[] = [];
      try {
        for await (const event of adapter.sendToTeamAgent(teamId, agentId, message)) {
          if (event.type === 'tool:start') {
            toolCalls.push({ tool: event.toolName, args: event.args });
          } else if (event.type === 'tool:result') {
            const out = event.result?.output || '';
            const preview = out.length > 300 ? out.slice(0, 300) + '...' : out;
            toolCalls.push({ tool: event.toolName, success: event.result?.success, output: preview });
          } else if (event.type === 'stream:chunk' && event.content) {
            textChunks.push(event.content);
          }
        }
      } catch (err: any) {
        console.error('[api] Team agent trigger failed:', err.message);
        return reply.code(500).send({ error: 'Agent trigger failed' });
      }

      return { team: teamId, agent: agentId, toolCalls, response: textChunks.join('') };
    });

    // POST /teams/:teamId/request — Submit user request (adds to board, may trigger lead)
    fastify.post('/teams/:teamId/request', async (request: any, reply: any) => {
      const teamId = request.params.teamId as string;
      const body = request.body as any;
      const message = body?.message?.trim();
      if (!message || message.length < 5) {
        return reply.code(400).send({ error: 'Message required (min 5 chars)' });
      }
      if (message.length > 500) {
        return reply.code(400).send({ error: 'Message too long (max 500 chars)' });
      }
      const lawViolation = violatesTwoLaws(message);
      if (lawViolation) return reply.code(403).send({ error: lawViolation });
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) {
        return reply.code(503).send({ error: 'PandoCode not available on this node' });
      }
      const severity = /\b(crash(es|ed|ing)?|critical|down|outage|broken|bug|error|fail(s|ed|ing)?)\b/i.test(message) ? 'BUG' : 'FEATURE';
      const taskTitle = `[${severity}:user] ${message.slice(0, 120)}`;
      const taskId = adapter.addTeamBoardTask(teamId, taskTitle, message.slice(0, 500));
      if (!taskId) {
        return reply.code(500).send({ error: 'Could not create board task' });
      }
      // Auto-trigger lead to process the new task (background, non-blocking)
      if (adapter.isTeamActive(teamId)) {
        adapter.triggerTeamAgentBackground(teamId, 'lead', 'New user request on board. Check your inbox and review board tasks now.');
      }
      return { status: 'ok', taskId, message: `Report submitted to team "${teamId}". Lead triggered.` };
    });

    // POST /teams — Create a new team
    fastify.post('/teams', async (request: any, reply: any) => {
      const registry = node.getTeamRegistry();
      if (!registry) return reply.code(503).send({ error: 'Team registry not initialized' });
      const body = request.body as any;
      if (!body?.id || !body?.displayName) {
        return reply.code(400).send({ error: 'Required: id, displayName' });
      }
      if (typeof body.id !== 'string' || body.id.length > 100) {
        return reply.code(400).send({ error: 'id must be a string (max 100 chars)' });
      }
      if (typeof body.displayName !== 'string' || body.displayName.length > 200) {
        return reply.code(400).send({ error: 'displayName must be a string (max 200 chars)' });
      }
      if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 2000)) {
        return reply.code(400).send({ error: 'description must be a string (max 2000 chars)' });
      }
      try {
        const team = registry.createTeam({
          id: body.id.trim(),
          displayName: body.displayName.trim(),
          managingNode: node.getIdentity()?.peerId || null,
          lastHeartbeat: Date.now(),
          status: 'active',
          repos: body.repos || [],
          agentCount: body.agentCount || 1,
          governanceRequired: body.governanceRequired || false,
          createdBy: node.getIdentity()?.peerId || null,
          claimedAt: Date.now(),
        });
        return { status: 'created', team };
      } catch (err: any) {
        return reply.code(400).send({ error: 'Failed to create team' });
      }
    });

    // PATCH /teams/:teamId — Update team config
    fastify.patch('/teams/:teamId', async (request: any, reply: any) => {
      const registry = node.getTeamRegistry();
      if (!registry) return reply.code(503).send({ error: 'Team registry not initialized' });
      const teamId = request.params.teamId as string;
      const team = registry.getTeam(teamId);
      if (!team) return reply.code(404).send({ error: 'Team not found' });
      const body = request.body as any;
      registry.updateTeam(teamId, body);
      return { status: 'updated' };
    });

    // DELETE /teams/:teamId — Stop team, mark orphaned
    fastify.delete('/teams/:teamId', async (request: any, reply: any) => {
      const teamId = request.params.teamId as string;
      const adapter = node.getEngineAdapter();
      if (adapter?.isTeamActive(teamId)) {
        await adapter.stopTeam(teamId);
      }
      const registry = node.getTeamRegistry();
      if (registry) {
        registry.updateTeam(teamId, { status: 'orphaned', managingNode: null });
      }
      return { status: 'stopped' };
    });

    // GET /teams/:teamId/agents — List agents with details
    fastify.get('/teams/:teamId/agents', async (request: any, reply: any) => {
      try {
        const teamId = (request.params as any).teamId;
        const adapter = node.getEngineAdapter();
        const agents = adapter?.getTeamAgents?.(teamId) ?? [];
        return { teamId, agents };
      } catch (err: any) {
        console.error('[api] List agents failed:', err.message);
        return reply.status(500).send({ error: 'Failed to list agents' });
      }
    });

    // GET /teams/:teamId/agents/:agentId/messages — Agent conversation history
    fastify.get('/teams/:teamId/agents/:agentId/messages', async (request: any, reply: any) => {
      try {
        const { teamId, agentId } = request.params as any;
        const limit = Math.min(parseInt((request.query as any)?.limit || '20', 10) || 20, 100);
        const adapter = node.getEngineAdapter();
        if (!adapter?.available) return { messages: [] };
        const messages = adapter.getTeamAgentMessages(teamId, agentId, limit);
        return { messages };
      } catch (err: any) {
        console.error('[api] Get agent messages failed:', err.message);
        return reply.status(500).send({ error: 'Failed to get agent messages' });
      }
    });

    // POST /teams/:teamId/message — Send a message between agents in a team
    fastify.post('/teams/:teamId/message', async (request: any, reply: any) => {
      try {
        const teamId = request.params.teamId as string;
        const adapter = node.getEngineAdapter();
        if (!adapter?.available) {
          return reply.code(503).send({ error: 'PandoCode not available on this node' });
        }
        if (!adapter.isTeamActive(teamId)) {
          return reply.code(404).send({ error: `Team "${teamId}" is not running on this node` });
        }
        const body = request.body as any || {};
        const { from, to, message } = body;
        if (!from || !to || !message) {
          return reply.code(400).send({ error: 'Required fields: from, to, message' });
        }
        if (typeof from !== 'string' || typeof to !== 'string') {
          return reply.code(400).send({ error: 'from and to must be strings' });
        }
        if (typeof message !== 'string' || message.length < 1 || message.length > 2000) {
          return reply.code(400).send({ error: 'Message must be 1-2000 chars' });
        }
        const lawViolation = violatesTwoLaws(message);
        if (lawViolation) return reply.code(403).send({ error: lawViolation });
        const ok = adapter.sendTeamMessage(teamId, from, to, message);
        return ok ? { status: 'sent', from, to } : reply.code(500).send({ error: 'Failed to send message' });
      } catch (err: any) {
        console.error('[api] Team message send failed:', err.message);
        return reply.code(500).send({ error: 'Failed to send message' });
      }
    });

    // POST /teams/:teamId/agents/spawn — Spawn a new agent on a team
    fastify.post('/teams/:teamId/agents/spawn', async (request: any, reply: any) => {
      try {
        const teamId = request.params.teamId as string;
        const adapter = node.getEngineAdapter();
        if (!adapter?.available) {
          return reply.code(503).send({ error: 'PandoCode not available on this node' });
        }
        if (!adapter.isTeamActive(teamId)) {
          return reply.code(404).send({ error: `Team "${teamId}" is not running on this node` });
        }

        const body = request.body as any || {};
        const { template, task, customPrompt, agentId: requestedAgentId } = body;

        // Validate template ID type
        if (template !== undefined && typeof template !== 'string') {
          return reply.code(400).send({ error: 'template must be a string' });
        }

        // Validate user-provided text against Two Laws
        if (task) {
          const lawViolation = violatesTwoLaws(task);
          if (lawViolation) return reply.code(403).send({ error: lawViolation });
        }
        if (customPrompt) {
          const lawViolation = violatesTwoLaws(customPrompt);
          if (lawViolation) return reply.code(403).send({ error: lawViolation });
        }

        // Check agent limit (max 10)
        const currentAgents = adapter.getTeamAgents(teamId);
        if (currentAgents.length >= 10) {
          return reply.code(400).send({ error: 'Team agent limit reached (10). Stop unused agents before spawning new ones.' });
        }

        // Resolve template and prompt
        const allTemplates = adapter.getTemplates();
        let prompt = '';
        let role = 'worker';
        let model = 'claude-code';
        let displayName = 'Custom Agent';

        if (template) {
          const tpl = allTemplates.find((t: any) => t.id === template);
          if (!tpl) {
            return reply.code(400).send({ error: `Template "${template}" not found. Use GET /v1/templates to list available templates.` });
          }
          prompt = tpl.promptSkeleton;
          role = tpl.role;
          model = tpl.model;
          displayName = tpl.displayName;
          if (task) {
            prompt += `\n\n## Your Current Task\n${task}`;
          }
        } else if (customPrompt) {
          prompt = customPrompt;
          if (task) {
            prompt += `\n\n## Your Current Task\n${task}`;
          }
        } else {
          return reply.code(400).send({ error: 'Provide either a template ID or customPrompt' });
        }

        const agentId = requestedAgentId || `${template || 'custom'}-${Date.now().toString(36)}`;

        await adapter.spawnTeamAgent(teamId, {
          id: agentId,
          role,
          displayName,
          prompt,
          model,
          tickIntervalMs: 0,
        });

        return { status: 'spawned', agentId, role, displayName };
      } catch (err: any) {
        console.error('[api] Agent spawn failed:', err.message);
        return reply.code(500).send({ error: 'Failed to spawn agent' });
      }
    });

    // DELETE /teams/:teamId/agents/:agentId — Stop and remove an agent
    fastify.delete('/teams/:teamId/agents/:agentId', async (request: any, reply: any) => {
      try {
        const { teamId, agentId } = request.params as any;
        const adapter = node.getEngineAdapter();
        if (!adapter?.available) {
          return reply.code(503).send({ error: 'PandoCode not available on this node' });
        }
        if (!adapter.isTeamActive(teamId)) {
          return reply.code(404).send({ error: `Team "${teamId}" is not running on this node` });
        }

        // Don't allow stopping the lead
        if (agentId === 'lead') {
          return reply.code(400).send({ error: 'Cannot stop the lead agent. Stop the entire team instead.' });
        }

        // Check that agent exists
        const agents = adapter.getTeamAgents(teamId);
        const agent = agents.find((a: any) => a.id === agentId);
        if (!agent) {
          return reply.code(404).send({ error: `Agent "${agentId}" not found in team "${teamId}"` });
        }

        await adapter.stopTeamAgent(teamId, agentId);
        return { status: 'stopped', agentId };
      } catch (err: any) {
        console.error('[api] Agent stop failed:', err.message);
        return reply.code(500).send({ error: 'Failed to stop agent' });
      }
    });

    // POST /teams/:teamId/agents/:agentId/trigger — Trigger a specific agent manually
    fastify.post('/teams/:teamId/agents/:agentId/trigger', async (request: any, reply: any) => {
      try {
        const { teamId, agentId } = request.params as any;
        const adapter = node.getEngineAdapter();
        if (!adapter?.isTeamActive(teamId)) {
          return reply.status(404).send({ error: 'Team not running' });
        }
        const message = (request.body as any)?.message || 'Manual trigger: check your inbox and process board tasks.';
        if (typeof message !== 'string' || message.length > 5000) {
          return reply.code(400).send({ error: 'Message must be a string (max 5000 chars)' });
        }
        // Two Laws check on trigger message
        const lawViolation = violatesTwoLaws(message);
        if (lawViolation) return reply.code(403).send({ error: lawViolation });
        // Run in background — return immediately
        adapter.triggerTeamAgentBackground(teamId, agentId, message);
        return { status: 'triggered', teamId, agentId };
      } catch (err: any) {
        console.error('[api] Agent trigger failed:', err.message);
        return reply.status(500).send({ error: 'Agent trigger failed' });
      }
    });

    // GET /teams/:teamId/cost — Team cost summary from PandoCode budget_usage table
    fastify.get('/teams/:teamId/cost', async (request: any, reply: any) => {
      try {
        const teamId = (request.params as any).teamId;
        const adapter = node.getEngineAdapter();
        const cost = adapter?.getTeamCost?.(teamId) ?? { totalTokens: 0, totalCostLux: 0, byAgent: {} };
        return { teamId, ...cost };
      } catch (err: any) {
        console.error('[api] Team cost query failed:', err.message);
        return reply.status(500).send({ error: 'Failed to get team cost' });
      }
    });

    // GET /teams/:teamId/activity — Recent messages + tool_calls from PandoCode DB
    fastify.get('/teams/:teamId/activity', async (request: any, reply: any) => {
      try {
        const teamId = (request.params as any).teamId;
        const limit = Math.min(Number((request.query as any)?.limit) || 20, 100);
        const adapter = node.getEngineAdapter();
        const activity = adapter?.getTeamActivity?.(teamId, limit) ?? { messages: [], toolCalls: [] };
        return { teamId, ...activity };
      } catch (err: any) {
        console.error('[api] Team activity query failed:', err.message);
        return reply.status(500).send({ error: 'Failed to get team activity' });
      }
    });

    // ── Agent Templates ──────────────────────────────────────────────────
    fastify.get('/templates', async (_request: any, reply: any) => {
      try {
        const adapter = node.getEngineAdapter();
        const templates = adapter?.getTemplates?.() ?? [];
        return { templates };
      } catch (err: any) {
        console.error('[api] Templates list failed:', err.message);
        return reply.code(500).send({ error: 'Failed to list templates' });
      }
    });

    // POST /templates — create custom template
    fastify.post('/templates', async (request: any, reply: any) => {
      try {
        const body = request.body;
        if (!body?.id || !body?.role || !body?.promptSkeleton) {
          return reply.status(400).send({ error: 'Required: id, role, promptSkeleton' });
        }
        // Validate ID is safe for filesystem
        if (!/^[a-zA-Z0-9_-]+$/.test(body.id)) {
          return reply.status(400).send({ error: 'Template ID must be alphanumeric with dashes/underscores' });
        }
        // Don't allow overwriting built-in templates
        const builtIn = ['worker', 'builder', 'tester', 'observer', 'reviewer'];
        if (builtIn.includes(body.id)) {
          return reply.status(400).send({ error: 'Cannot overwrite built-in template' });
        }

        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { homedir } = await import('node:os');
        const dir = join(homedir(), '.pando', 'teams', 'templates');
        mkdirSync(dir, { recursive: true });

        const template = {
          id: body.id,
          displayName: body.displayName || body.id,
          description: body.description || '',
          role: body.role,
          promptSkeleton: body.promptSkeleton,
          model: body.model || 'claude-code',
          tickIntervalMs: body.tickIntervalMs || 0,
        };

        writeFileSync(join(dir, `${body.id}.json`), JSON.stringify(template, null, 2));
        return { status: 'created', template };
      } catch (err: any) {
        console.error('[api] Template create failed:', err.message);
        return reply.status(500).send({ error: 'Failed to create template' });
      }
    });

    // DELETE /templates/:id — delete custom template
    fastify.delete('/templates/:id', async (request: any, reply: any) => {
      try {
        const id = (request.params as any).id;
        const builtIn = ['worker', 'builder', 'tester', 'observer', 'reviewer'];
        if (builtIn.includes(id)) {
          return reply.status(400).send({ error: 'Cannot delete built-in template' });
        }

        const { existsSync, unlinkSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { homedir } = await import('node:os');
        const filePath = join(homedir(), '.pando', 'teams', 'templates', `${id}.json`);

        if (!existsSync(filePath)) {
          return reply.status(404).send({ error: 'Template not found' });
        }

        unlinkSync(filePath);
        return { status: 'deleted', id };
      } catch (err: any) {
        console.error('[api] Template delete failed:', err.message);
        return reply.status(500).send({ error: 'Failed to delete template' });
      }
    });

    // ── Team Task Progress ──────────────────────────────────────────────
    fastify.get('/teams/:teamId/tasks', async (request: any, reply: any) => {
      try {
        const adapter = node.getEngineAdapter();
        const tasks = adapter?.getTeamBoard(request.params.teamId) ?? [];
        return { tasks };
      } catch (err: any) {
        console.error('[api] Team tasks list failed:', err.message);
        return reply.code(500).send({ error: 'Failed to list team tasks' });
      }
    });

    fastify.get('/teams/:teamId/tasks/:taskId', async (request: any, reply: any) => {
      try {
        const adapter = node.getEngineAdapter();
        const tasks = adapter?.getTeamBoard(request.params.teamId) ?? [];
        const task = tasks.find((t: any) => t.id === request.params.taskId);
        if (!task) return reply.code(404).send({ error: 'Task not found' });
        return task;
      } catch (err: any) {
        console.error('[api] Team task get failed:', err.message);
        return reply.code(500).send({ error: 'Failed to get team task' });
      }
    });

    // ── Team Status ─────────────────────────────────────────────────────
    fastify.get('/teams/:teamId/status', async (request: any, reply: any) => {
      try {
        const teamId = request.params.teamId as string;
        const adapter = node.getEngineAdapter();
        const isActive = adapter?.isTeamActive(teamId) ?? false;
        const agents = adapter?.getTeamAgents?.(teamId) ?? [];
        const tasks = adapter?.getTeamBoard(teamId) ?? [];
        return {
          teamId,
          active: isActive,
          agentCount: agents.length,
          agents: agents.map((a: any) => ({ id: a.id, role: a.role, displayName: a.displayName, status: a.status })),
          pendingTasks: tasks.length,
          managingNode: node.getIdentity?.()?.peerId || 'unknown',
        };
      } catch (err: any) {
        console.error('[api] Team status failed:', err.message);
        return reply.code(500).send({ error: 'Failed to get team status' });
      }
    });

    // ── Legacy /council/* routes (gateway compatibility) ──────────────────────
    // The gateway UI still calls /api/council/* which proxies to these endpoints.
    // All routes delegate to the pando-infra team via the teams system.
    // TODO: Remove once gateway routes are migrated to /v1/teams/pando-infra/*.

    fastify.get('/council/status', async () => {
      const adapter = node.getEngineAdapter();
      return { active: adapter?.isTeamActive('pando-infra') ?? false };
    });

    fastify.get('/council/board', async () => {
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return { tasks: [] };
      return { tasks: adapter.getTeamBoard('pando-infra') };
    });

    fastify.post('/council/request', async (request: any, reply: any) => {
      // Legacy route — delegates to /v1/teams/pando-infra/request
      const body = request.body as any;
      const message = body?.message?.trim();
      if (!message || message.length < 5) return reply.code(400).send({ error: 'Message required (min 5 chars)' });
      if (message.length > 500) return reply.code(400).send({ error: 'Message too long (max 500 chars)' });
      const lawViolation = violatesTwoLaws(message);
      if (lawViolation) return reply.code(403).send({ error: lawViolation });
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'PandoCode not available' });
      const severity = /\b(crash(es|ed|ing)?|critical|down|outage|broken|bug|error|fail(s|ed|ing)?)\b/i.test(message) ? 'BUG' : 'FEATURE';
      const taskTitle = `[${severity}:user] ${message.slice(0, 120)}`;
      const taskId = adapter.addTeamBoardTask('pando-infra', taskTitle, message.slice(0, 500));
      if (!taskId) return reply.code(500).send({ error: 'Could not create board task' });
      if (adapter.isTeamActive('pando-infra')) {
        adapter.triggerTeamAgentBackground('pando-infra', 'lead', 'New user request on board.');
      }
      return { status: 'ok', taskId };
    });

    fastify.post('/council/trigger/:agent', async (request: any, reply: any) => {
      const agentId = request.params.agent as string;
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'PandoCode not available' });
      if (!adapter.isTeamActive('pando-infra')) return reply.code(503).send({ error: 'pando-infra team not running' });
      const message = (request.body as any)?.message || 'Run your checks now.';
      if (typeof message !== 'string' || message.length > 5000) {
        return reply.code(400).send({ error: 'Message must be a string (max 5000 chars)' });
      }
      const lawViolation = violatesTwoLaws(message);
      if (lawViolation) return reply.code(403).send({ error: lawViolation });
      adapter.triggerTeamAgentBackground('pando-infra', agentId, message);
      return { agent: agentId, status: 'triggered' };
    });

    fastify.post('/council/tasks', async (request: any, reply: any) => {
      const body = request.body as any;
      const title = body?.title?.trim();
      if (!title) return reply.code(400).send({ error: 'Title required' });
      const lawViolation = violatesTwoLaws(`${title} ${body?.description || ''}`);
      if (lawViolation) return reply.code(403).send({ error: lawViolation });
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'PandoCode not available' });
      const taskId = adapter.addTeamBoardTask('pando-infra', title, body?.description);
      if (!taskId) return reply.code(500).send({ error: 'Failed to create task' });
      return { status: 'created', taskId };
    });

    fastify.patch('/council/tasks/:taskId', async (request: any, reply: any) => {
      const taskId = request.params.taskId as string;
      const body = request.body as any;
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'PandoCode not available' });
      const ok = adapter.updateTeamBoardTask('pando-infra', taskId, { status: body?.status, progress: body?.progress });
      return ok ? { status: 'updated' } : reply.code(404).send({ error: 'Task not found' });
    });

    fastify.get('/council/inbox/:agentId', async (request: any) => {
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return { messages: [] };
      return { messages: adapter.getTeamInbox('pando-infra', request.params.agentId) };
    });

    fastify.post('/council/message', async (request: any, reply: any) => {
      const body = request.body as any;
      const { from, to, message } = body || {};
      if (!from || !to || !message) return reply.code(400).send({ error: 'Required: from, to, message' });
      if (typeof from !== 'string' || typeof to !== 'string') {
        return reply.code(400).send({ error: 'from and to must be strings' });
      }
      if (typeof message !== 'string' || message.length < 1 || message.length > 2000) {
        return reply.code(400).send({ error: 'Message must be 1-2000 chars' });
      }
      const lawViolation = violatesTwoLaws(message);
      if (lawViolation) return reply.code(403).send({ error: lawViolation });
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'PandoCode not available' });
      const ok = adapter.sendTeamMessage('pando-infra', from, to, message);
      return ok ? { status: 'sent' } : reply.code(500).send({ error: 'Failed to send message' });
    });

    // ── Atomic Commit + Propose (Self-Upgrade Pipeline) ─────────────────────

    // POST /infra/commit-and-propose — One-call atomic pipeline:
    //   git add → npm run build → git commit → [governance propose → push] or [push]
    // Used by pando-infra lead agent after editing code. Single curl call replaces 5+ sequential bash commands.
    //
    // GOVERNANCE ENFORCEMENT: If the team has governanceRequired=true, push is
    // DEFERRED until the governance proposal passes. The onUpgradeApproved
    // callback handles the push. Code is committed locally and a proposal created,
    // but the remote repo is NOT updated until governance approves.
    fastify.post('/infra/commit-and-propose', async (request: any, reply: any) => {
      const authHeader = request.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== deps.apiToken) {
        return reply.code(401).send({ error: 'Operator authentication required' });
      }

      const body = request.body as any || {};
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
      const teamId = typeof body.teamId === 'string' ? body.teamId.trim() : 'pando-infra';

      if (!message) return reply.code(400).send({ error: 'message required (commit message)' });
      if (message.length > 1000) return reply.code(400).send({ error: 'message too long (max 1000 chars)' });

      const lawViolation = violatesTwoLaws(message);
      if (lawViolation) return reply.code(403).send({ error: lawViolation });

      // Check if this team requires governance approval before push
      const teamRegistry = node.getTeamRegistry();
      const teamConfig = teamRegistry?.getTeam(teamId);
      const governanceRequired = teamConfig?.governanceRequired ?? false;

      const repoDir = process.cwd();
      const git = new GitOps(repoDir);
      const steps: string[] = [];

      try {
        // Step 1: Stage all changes (exclude CLAUDE.md worker context files)
        git.exec(['add', '-A', '--', ':(exclude)CLAUDE.md', ':(exclude)*.db', ':(exclude)*.db-shm', ':(exclude)*.db-wal']);
        steps.push('staged');

        // Step 2: Check if there are actual changes
        if (!git.hasUncommittedChanges()) {
          return reply.code(400).send({ error: 'No changes to commit', steps });
        }
        steps.push('changes-detected');

        // Step 3: Build check (npm run build must pass)
        try {
          execSync('npm run build', { cwd: repoDir, timeout: 180_000, stdio: 'pipe', encoding: 'utf-8' });
          steps.push('build-passed');
        } catch (buildErr: any) {
          // Unstage on build failure so agent can fix
          try { git.exec(['reset', 'HEAD']); } catch { /* ignore */ }
          console.error('[api] Build failed during commit-and-propose:', (buildErr.stderr || buildErr.message)?.slice(0, 500));
          return reply.code(400).send({ error: 'Build failed — fix errors before committing', steps });
        }

        // Step 4: Commit
        const commitHash = git.commit(message);
        steps.push(`committed:${commitHash}`);

        // Step 5: Create governance proposal BEFORE push (if governance required)
        let proposalId = '';
        if (governanceRequired) {
          // Governance-gated flow: propose first, push is deferred until approval.
          // The onUpgradeApproved callback in init-kernel.ts handles the push
          // when the proposal passes.
          try {
            const gov = node.getGovernance();
            if (gov) {
              const title = `Upgrade: ${message.slice(0, 150)}`;
              const proposal = await gov.createProposal(title, message, 300_000, {
                category: 'upgrade' as any,
                upgradePayload: { commitHash, description: message },
              });
              proposalId = proposal.id;
              steps.push(`proposed:${proposalId}`);
              steps.push('push-deferred:governance-required');
              console.log(`[api] Governance required — push deferred until proposal ${proposalId.slice(0, 8)} passes (commit ${commitHash.slice(0, 8)})`);
            } else {
              // No governance module available — block the push entirely
              console.error('[api] Governance required but governance module not available — push blocked');
              return reply.code(503).send({ error: 'Governance required but governance module not available', commitHash, steps });
            }
          } catch (govErr: any) {
            console.error('[api] Governance proposal failed:', govErr.message);
            return reply.code(500).send({ error: 'Governance proposal failed — push blocked', commitHash, steps });
          }
        } else {
          // No governance required — push immediately, then propose (informational)
          try {
            git.push('origin', 'master');
            steps.push('pushed');
          } catch (pushErr: any) {
            console.error('[api] Git push failed:', pushErr.message);
            return reply.code(500).send({ error: 'Push failed', commitHash, steps });
          }

          // Informational governance proposal (non-blocking)
          try {
            const gov = node.getGovernance();
            if (gov) {
              const title = `Upgrade: ${message.slice(0, 150)}`;
              const proposal = await gov.createProposal(title, message, 300_000, {
                category: 'upgrade' as any,
                upgradePayload: { commitHash, description: message },
              });
              proposalId = proposal.id;
              steps.push(`proposed:${proposalId}`);
            }
          } catch (govErr: any) {
            console.error('[api] Governance proposal failed:', govErr.message);
            steps.push('proposal-failed');
          }
        }

        // Step 6: Update board task (if taskId provided)
        if (taskId) {
          try {
            const adapter = node.getEngineAdapter();
            if (adapter?.available) {
              const progress = governanceRequired
                ? `Committed ${commitHash}, proposal ${proposalId} — push pending governance approval`
                : `Committed ${commitHash}, proposal ${proposalId || 'skipped'}`;
              adapter.updateTeamBoardTask(teamId, taskId, {
                status: 'done',
                progress,
              });
              steps.push('task-completed');
            }
          } catch { /* non-fatal */ }
        }

        return {
          status: 'success',
          commitHash,
          proposalId,
          governanceRequired,
          pushDeferred: governanceRequired,
          steps,
        };
      } catch (err: any) {
        console.error('[api] Commit-and-propose failed:', err.message);
        return reply.code(500).send({ error: 'Operation failed', steps });
      }
    });

    // ── Chat API (Phase 27: AgentManager) ──────────────────────────────────

    // POST /chat/message — Phase 68.3: Doorman-routed chat
    // Doorman classifies intent → simple (instant) / question (AI answer) / build (create project + manager)

}
