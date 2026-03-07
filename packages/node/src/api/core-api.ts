/**
 * Layer 1 (Core) API routes — registered by registerCoreRoutes().
 *
 * Routes: /upgrade (remaining), /emissions/*, /security/*,
 *         /admin/shutdown, /admin/migrate-apps, /admin/cleanup-projects
 *
 * Note: /agents/* and /auth/* are registered via agent-tools.ts and
 *       platform-api.ts respectively. /instances/* is in platform-api.ts.
 */

import { execSync } from 'node:child_process';
import { safeGitReset } from '../core/upgrade-protocol.js';
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
        // Step 0: ensure git safe.directory (compute instances run as 'pando' user, repo cloned by root)
        try {
          execSync(`git config --global --add safe.directory ${repoDir}`, {
            cwd: repoDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe', windowsHide: true,
          });
        } catch {}

        // Step 1: fetch + reset to origin/master (handles orphan-branch force pushes)
        console.log('[upgrade] Fetching latest code...');
        let pullOutput: string;
        try {
          execSync('git fetch origin master', {
            cwd: repoDir, encoding: 'utf-8', timeout: 60_000,
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          });
          // Check if we're already at the same commit
          const localSha = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
          const remoteSha = execSync('git rev-parse origin/master', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
          if (localSha === remoteSha) {
            pullOutput = 'Already up to date.';
          } else {
            safeGitReset(repoDir, 'origin/master');
            pullOutput = `Updated ${localSha.slice(0, 8)} -> ${remoteSha.slice(0, 8)}`;
          }
        } catch (err: any) {
          node.setUpgradeInProgress(false);
          const msg = err.stderr?.toString()?.slice(0, 500) || err.message;
          console.error(`[upgrade] Git fetch/reset failed: ${msg}`);
          return reply.code(500).send({ status: 'error', step: 'git_pull', error: msg });
        }

        // Check if already up to date
        if (pullOutput.includes('Already up to date') || pullOutput.includes('Already up-to-date')) {
          node.setUpgradeInProgress(false);
          console.log('[upgrade] Already up to date. No build needed.');
          return { status: 'up_to_date', message: 'Already up to date. No changes to build.' };
        }

        console.log(`[upgrade] Pull result: ${pullOutput.split('\n')[0]}`);

        // Step 2: npm run build
        console.log('[upgrade] Building...');
        try {
          execSync('npm run build', {
            cwd: repoDir,
            encoding: 'utf-8',
            timeout: 180_000, // 3 minutes
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (err: any) {
          node.setUpgradeInProgress(false);
          const stderr = err.stderr?.toString()?.slice(-500) || err.message;
          console.error(`[upgrade] Build FAILED: ${stderr}`);
          return reply.code(500).send({ status: 'error', step: 'build', error: stderr });
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
        return reply.code(500).send({ status: 'error', step: 'unknown', error: err.message });
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
        return reply.code(400).send({ error: err.message });
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
      const limit = parseInt(request.query?.limit) || 50;
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
      const limit = parseInt(request.query?.limit) || 100;
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
        return reply.code(500).send({ error: err.message || 'Challenge failed' });
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

    // ── Council API ──────────────────────────────────────────────────────────

    // GET /council/status — Council system status (uses PandoCode's native agent system)
    fastify.get('/council/status', async () => {
      const adapter = node.getEngineAdapter();
      const active = adapter?.isCouncilActive() ?? false;
      return {
        active,
        engines: active ? adapter!.getActiveEngines().filter((e: any) =>
          ['observer', 'qa', 'council'].includes(e.id)
        ) : [],
        schedules: adapter?.getSchedules()?.filter((s: any) =>
          ['observer-tick', 'qa-tick', 'council-tick'].includes(s.name)
        ) ?? [],
      };
    });

    // POST /council/trigger/:agent — Manually trigger a council agent
    fastify.post('/council/trigger/:agent', async (request: any, reply: any) => {
      const agentId = request.params.agent as string;
      if (!['observer', 'qa', 'council'].includes(agentId)) {
        return reply.code(400).send({ error: 'Invalid agent. Must be: observer, qa, or council' });
      }
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) {
        return reply.code(503).send({ error: 'Engine adapter not available' });
      }
      if (!adapter.isCouncilActive()) {
        return reply.code(503).send({ error: 'Council agents not running' });
      }

      const defaults: Record<string, string> = {
        observer: 'Run your periodic checks now.',
        qa: 'Run your health checks now.',
        council: 'Check your inbox and review board tasks now.',
      };
      const message = (request.body as any)?.message || defaults[agentId];

      const toolCalls: any[] = [];
      const textChunks: string[] = [];
      try {
        for await (const event of adapter.sendToCouncilAgent(agentId as any, message)) {
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
        return reply.code(500).send({ error: err.message });
      }

      return {
        agent: agentId,
        toolCalls,
        response: textChunks.join(''),
      };
    });

    // ── Board API ─────────────────────────────────────────────────────────

    // GET /council/board — Public view of the council board (pending/in_progress tasks)
    fastify.get('/council/board', async () => {
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return { tasks: [], error: 'Council not running' };
      return { tasks: adapter.getCouncilBoard() };
    });

    // POST /council/request — Submit a user report/feature request to the council board
    fastify.post('/council/request', async (request: any, reply: any) => {
      const body = request.body as any;
      const message = body?.message?.trim();
      if (!message || message.length < 5) {
        return reply.code(400).send({ error: 'Message required (min 5 chars)' });
      }
      if (message.length > 500) {
        return reply.code(400).send({ error: 'Message too long (max 500 chars)' });
      }
      const lawViolation = violatesTwoLaws(message);
      if (lawViolation) {
        return reply.code(400).send({ error: lawViolation });
      }
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) {
        return reply.code(503).send({ error: 'Council not running' });
      }
      const severity = /\b(crash(es|ed|ing)?|critical|down|outage|broken|bug|error|fail(s|ed|ing)?)\b/i.test(message) ? 'BUG' : 'FEATURE';
      const taskTitle = `[${severity}:user] ${message.slice(0, 120)}`;
      const taskId = adapter.addBoardTask(taskTitle, message.slice(0, 500));
      if (!taskId) {
        return reply.code(500).send({ error: 'Could not create board task' });
      }
      return { status: 'ok', taskId, message: 'Report submitted to council board.' };
    });

    // ── Claude Code MCP Support Routes ─────────────────────────────────────
    // These routes are called by the Pando MCP server, which is used by Claude Code
    // sessions to interact with the node's storage (memory, board, messaging).

    // POST /memory/save — Save a lesson/memory to the node's memory store
    fastify.post('/memory/save', async (request: any, reply: any) => {
      const body = request.body as any;
      const lesson = body?.lesson?.trim();
      if (!lesson) return reply.code(400).send({ error: 'lesson is required' });

      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'Engine not available' });

      // Store memory in the project's or council's PandoCode DB via board task with [MEMORY] tag
      const projectId = body?.projectId || null;
      const category = body?.category || 'lesson';
      const title = `[MEMORY:${category}] ${lesson.slice(0, 120)}`;
      const taskId = projectId
        ? adapter.addProjectBoardTask(projectId, title, lesson)
        : adapter.addBoardTask(title, lesson);

      return { status: 'ok', taskId, saved: !!taskId };
    });

    // PATCH /board/tasks/:id — Update a board task status/progress
    fastify.patch('/board/tasks/:id', async (request: any, reply: any) => {
      const { id } = request.params as any;
      const { status, progress, projectId } = request.body as any;
      if (!id) return reply.code(400).send({ error: 'taskId is required' });

      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'Engine not available' });

      // Update task in the DB
      const updated = adapter.updateBoardTask(id, { status, progress }, projectId || null);
      return { status: 'ok', updated };
    });

    // POST /board/tasks — Create a board task
    fastify.post('/board/tasks', async (request: any, reply: any) => {
      const { title, description, projectId } = request.body as any;
      if (!title) return reply.code(400).send({ error: 'title is required' });

      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'Engine not available' });

      const taskId = projectId
        ? adapter.addProjectBoardTask(projectId, title, description)
        : adapter.addBoardTask(title, description);

      if (!taskId) return reply.code(500).send({ error: 'Could not create task' });
      return { status: 'ok', taskId };
    });

    // POST /agents/message — Send a message to another agent
    fastify.post('/agents/message', async (request: any, reply: any) => {
      const { toAgentId, message } = request.body as any;
      if (!toAgentId || !message) return reply.code(400).send({ error: 'toAgentId and message required' });

      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return reply.code(503).send({ error: 'Engine not available' });

      const sent = adapter.sendAgentMessage(toAgentId, message);
      return { status: 'ok', sent };
    });

    // GET /agents/inbox — Read inbox messages for an agent
    fastify.get('/agents/inbox', async (request: any) => {
      const { agentId } = request.query as any;

      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return { messages: [] };

      const messages = adapter.readAgentInbox(agentId || 'system');
      return { messages };
    });

    // ── Chat API (Phase 27: AgentManager) ──────────────────────────────────

    // POST /chat/message — Phase 68.3: Doorman-routed chat
    // Doorman classifies intent → simple (instant) / question (AI answer) / build (create project + manager)

}
