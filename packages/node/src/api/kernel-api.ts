/**
 * Layer 0 (Kernel) API routes — registered by registerKernelRoutes().
 *
 * Routes: /health, /status, /wallet, /balance, /peers, /transactions,
 *         /connect, /transfer, /tasks (queue), /governance/*, /files,
 *         /pipeline, /network/*, /activity/*, /events, /bootstrap,
 *         /onboard, /discovery, /search, /snapshot, /scheduler/*,
 *         /monitor/*, /guardrails/*, /request-reply/*, /reputation/*,
 *         /upgrade, /emissions/*, /security/*
 */

import { toString as uint8ArrayToString } from 'uint8arrays';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { signTransaction } from '@pando/shared';
import type { RouteHelpers } from './middleware/auth.js';

const NODE_STARTED_AT = Date.now();

export async function registerKernelRoutes(fastify: any, deps: RouteHelpers): Promise<void> {
  const { node } = deps;
    // GET /health — lightweight health check for monitoring (load balancers, uptime services)
    // Returns 200 if node is operational, 503 if not ready. No auth required.
    // If HealthMonitor is running, defers to its assessment so /health and /monitor/status agree.
    fastify.get('/health', async (request: any, reply: any) => {
      const network = node.getNetwork();
      const ledger = node.getLedger();
      const identity = node.getIdentity();

      if (!network || !ledger || !identity) {
        return reply.code(503).send({
          status: 'unhealthy',
          reason: 'Node not fully initialized',
          timestamp: Date.now(),
        });
      }

      // If HealthMonitor is available, use its nodeHealth assessment
      // so /health and /monitor/status report the same health state.
      let status: string = 'healthy';
      const monitor = node.getMonitor();
      if (monitor) {
        const metrics = monitor.getCurrentMetrics();
        status = metrics.nodeHealth; // 'healthy' | 'degraded' | 'critical'
      }

      const uptimeSeconds = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;
      const uptimeFormatted = `${hours}h ${minutes}m ${seconds}s`;

      const memoryUsageMB = Math.round(process.memoryUsage().rss / (1024 * 1024) * 10) / 10;

      return {
        status,
        peerId: identity.peerId,
        peers: network.getPeerCount(),
        uptime: uptimeSeconds,
        uptimeFormatted,
        memoryUsageMB,
        schedulerEnabled: node.isSchedulerEnabled(),
        monitorEnabled: node.isMonitorEnabled(),
        nodeStartedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
        version: '0.1.0',
        timestamp: Date.now(),
      };
    });

    // POST /admin/shutdown — Graceful shutdown API endpoint
    // Requires Bearer token auth. Stops agents, closes subsystems, writes reason file, exits.
    fastify.post('/admin/shutdown', async (request: any, reply: any) => {
      const body = request.body as { reason?: string } | undefined;
      const reason = body?.reason || 'api-shutdown';

      console.log(`[api] Shutdown requested via /admin/shutdown (reason: ${reason})`);

      // Respond immediately before shutting down
      reply.code(200).send({
        status: 'shutting_down',
        reason,
        timestamp: Date.now(),
      });

      // Run shutdown sequence asynchronously so the HTTP response can be sent
      setImmediate(async () => {
        try {
          // 1. Stop the agent system (orchestrator + workers)
          node.stopAgentSystem();
          console.log(`[api] Shutdown: agent system stopped`);

          // 2. Stop the node (closes Fastify, libp2p, SQLite, scheduler, etc.)
          await node.stop();

          // 3. Write shutdown reason file
          const dataDir = node.getDataDir() || join(homedir(), '.pando');
          const shutdownFile = join(dataDir, 'shutdown-reason.json');
          try {
            if (!existsSync(dataDir)) {
              mkdirSync(dataDir, { recursive: true });
            }
            writeFileSync(shutdownFile, JSON.stringify({
              reason,
              timestamp: Date.now(),
              pid: process.pid,
            }, null, 2));
            console.log(`[api] Wrote shutdown reason to ${shutdownFile}`);
          } catch (err: any) {
            console.error(`[api] Failed to write shutdown reason: ${err.message}`);
          }

          // 4. Exit cleanly
          console.log('[api] Graceful shutdown complete. Exiting.');
          process.exit(0);
        } catch (err: any) {
          console.error(`[api] Shutdown error: ${err.message}`);
          process.exit(1);
        }
      });
    });

    // v2.4: POST /admin/wipe-credentials — emergency tripwire trigger (admin token required)
    // Wipes CREDENTIAL_MASTER_KEY from memory + broadcasts node_compromised to network.
    fastify.post('/admin/wipe-credentials', async (request: any, reply: any) => {
      const body = request.body as { reason?: string } | undefined;
      const reason = body?.reason || 'admin-trigger';
      await node.triggerLocalCompromise(reason);
      return { status: 'wiped', reason, timestamp: Date.now() };
    });

    // Phase 80: POST /admin/migrate-apps — redeploy Tier 2 apps from a dead instance to a running one
    fastify.post('/admin/migrate-apps', async (request: any, reply: any) => {
      const body = request.body as { fromInstanceId?: string } | undefined;
      const fromInstanceId = body?.fromInstanceId;
      if (!fromInstanceId) return reply.code(400).send({ error: 'fromInstanceId is required' });

      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Find all Tier 2 projects on the dead instance
      const allProjects = await ps.listProjectsAsync?.() || [];
      const deadProjects = allProjects.filter((p: any) =>
        p.instanceId === fromInstanceId && p.tier === 2 && p.deploymentStatus === 'deployed'
      );

      if (deadProjects.length === 0) {
        return { message: 'No Tier 2 projects found on that instance', fromInstanceId };
      }

      // Find a running instance to migrate to
      const instances = node.getCloudInstanceManager?.()?.getInstances() || [];
      const targetInstance = instances.find((i: any) => i.instanceId !== fromInstanceId && i.status === 'running' && i.peerId);

      if (!targetInstance) {
        return reply.code(503).send({ error: 'No running compute instance available to migrate to' });
      }

      const results: any[] = [];
      const requestReply = node.getRequestReply?.();

      for (const project of deadProjects) {
        try {
          if (!requestReply || !project.githubRepo) {
            results.push({ projectId: project.id, status: 'skipped', reason: 'No requestReply or githubRepo' });
            continue;
          }

          const repoUrl = `https://github.com/${project.githubRepo}.git`;
          const response = await requestReply.request(targetInstance.peerId!, 'pando/deploy-app', {
            projectId: project.id,
            repoUrl,
            tier: 2,
            envVars: {
              PANDO_GATEWAY_URL: process.env.GATEWAY_PUBLIC_URL || 'https://gateway-one-mu.vercel.app',
              PANDO_PROJECT_ID: project.id,
              PANDO_PROJECT_API_KEY: (project as any).apiKey || '',
            },
          }, 300_000);

          if (response?.success && response.payload?.status === 'deployed') {
            const payload = response.payload as any;
            const liveUrl = `http://${targetInstance.publicIp}/apps/${project.id}/`;
            await ps.updateProject(project.id, {
              deploymentUrl: liveUrl,
              instanceId: targetInstance.instanceId,
              deploymentPort: payload.port,
              updatedAt: Date.now(),
            });
            results.push({ projectId: project.id, status: 'migrated', url: liveUrl });
          } else {
            results.push({ projectId: project.id, status: 'failed', error: response?.payload?.error });
          }
        } catch (err: any) {
          results.push({ projectId: project.id, status: 'error', error: err.message });
        }
      }

      console.log(`[admin] Migrated ${results.filter(r => r.status === 'migrated').length}/${deadProjects.length} apps from ${fromInstanceId}`);
      return { fromInstanceId, targetInstanceId: targetInstance.instanceId, results };
    });

    // Phase 80: POST /admin/cleanup-projects — soft-delete (archive) specified projects
    fastify.post('/admin/cleanup-projects', async (request: any, reply: any) => {
      const body = request.body as { projectIds?: string[] } | undefined;
      const projectIds = body?.projectIds;
      if (!projectIds || !Array.isArray(projectIds) || projectIds.length === 0) {
        return reply.code(400).send({ error: 'projectIds array is required' });
      }

      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const results: any[] = [];
      for (const id of projectIds) {
        try {
          await ps.updateProject(id, { status: 'archived', updatedAt: Date.now() });
          results.push({ projectId: id, status: 'archived' });
        } catch (err: any) {
          results.push({ projectId: id, status: 'error', error: err.message });
        }
      }

      // Also update P2P ProjectRegistry
      const pr = node.getProjectRegistry?.();
      if (pr) {
        for (const id of projectIds) {
          try { pr.updateProject(id, { status: 'archived' } as any); } catch {}
        }
      }

      console.log(`[admin] Archived ${results.filter(r => r.status === 'archived').length}/${projectIds.length} projects`);
      return { results };
    });

    // GET /status — node status
    fastify.get('/status', async () => {
      const network = node.getNetwork();
      const ledger = node.getLedger();
      const identity = node.getIdentity();

      if (!network || !ledger || !identity) {
        return { connected: false, peers: 0, identity: '', balance: 0, totalSupply: 0, totalAccounts: 0 };
      }

      const stats = ledger.getNetworkStats();
      return {
        connected: true,
        peerId: identity.peerId,
        publicKey: uint8ArrayToString(identity.publicKey, 'base64'),  // Phase 41: expose for E2E encryption
        peers: network.getPeerCount(),
        peerList: network.getPeers().map(p => p.peerId),
        identity: identity.peerId,
        balance: ledger.accounts.getBalance(identity.peerId),
        totalSupply: stats.totalSupply,
        totalAccounts: stats.totalAccounts,
        totalBurned: stats.totalBurned,
        totalRelayFees: stats.totalRelayFees,
        totalTransactions: stats.totalTransactions,
        circulatingSupply: stats.circulatingSupply,
        activeContributors: stats.activeContributors,
        uptime: Math.floor(process.uptime()),
        nodeStartedAt: NODE_STARTED_AT,
        version: '0.1.0',
        pipelineEnabled: node.isPipelineEnabled(),
        listenAddresses: network.getListenAddresses(),
        capabilities: node.getCapabilities(),
        storageBackend: node.getStorageBackendType(),
        storageConnected: node.getStorageBackend() !== null,
        linkedUser: node.getLinkedUser(),
        nodeMode: node.getNodeMode(),
        ledgerMode: node.getLedgerMode(),
        cloudInstances: node.getCloudInstanceManager()?.getInstances().length || 0,
        health: node.getNodeHealth(),
        commitHash: node.getUpgradeProtocol()?.getUpgradeStatus()?.currentVersion || 'unknown',
      };
    });

    // GET /wallet — ownership info for this node
    fastify.get('/wallet', async () => {
      const identity = node.getIdentity();
      const ledger = node.getLedger();

      if (!identity || !ledger) {
        return { error: 'Node not ready' };
      }

      const balance = ledger.accounts.getBalance(identity.peerId);
      const account = ledger.accounts.get(identity.peerId);
      const txs = ledger.transactions.getTransactionsForPeer(identity.peerId, 10);

      return {
        peerId: identity.peerId,
        publicKey: uint8ArrayToString(identity.publicKey, 'base64'),
        balance,
        createdAt: identity.createdAt,
        accountCreatedAt: account?.createdAt,
        recentTransactions: txs.length,
        dataDir: node.getDataDir(),
        ownership: {
          explanation: 'Your Lux is tied to your Ed25519 private key stored in identity.json. ' +
            'Your peer ID is your wallet address. Whoever holds the private key owns the Lux.',
          identityFile: join(node.getDataDir(), 'identity.json'),
          backup: 'Copy your identity.json to a safe place. If you lose it, you lose your Lux.',
        },
      };
    });

    // GET /balance/:peerId — balance lookup
    fastify.get('/balance/:peerId', async (request: any, reply: any) => {
      const ledger = node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      const peerId = request.params.peerId;
      const balance = ledger.accounts.getBalance(peerId);
      return { peerId, balance };
    });

    // GET /peers — list connected peers with balances
    fastify.get('/peers', async () => {
      const network = node.getNetwork();
      const ledger = node.getLedger();
      if (!network) return { peers: [] };

      return {
        peers: network.getPeers().map(p => ({
          peerId: p.peerId,
          connectedAt: p.connectedAt,
          lastSeen: p.lastSeen,
          balance: ledger ? ledger.accounts.getBalance(p.peerId) : 0,
        })),
      };
    });

    // GET /transactions — recent transactions for this node (or authenticated user)
    fastify.get('/transactions', async (request: any) => {
      const ledger = node.getLedger();
      const identity = node.getIdentity();
      if (!ledger || !identity) return { transactions: [] };

      const limit = parseInt(request.query?.limit) || 50;
      // If a user is authenticated, return their transactions; otherwise fall back to node identity
      const userPeerId = await deps.verifyUserJwt(request);
      const targetPeerId = userPeerId || identity.peerId;
      const txs = ledger.transactions.getTransactionsForPeer(targetPeerId, limit);
      return { transactions: txs, peerId: targetPeerId };
    });

    // POST /connect — connect to a peer by multiaddr
    fastify.post('/connect', async (request: any, reply: any) => {
      const network = node.getNetwork();
      if (!network) return reply.code(503).send({ error: 'Network not ready' });
      const { addr } = request.body || {};
      if (!addr || typeof addr !== 'string') {
        return reply.code(400).send({ error: 'addr (multiaddr string) is required' });
      }
      try {
        const peerId = await network.dialPeer(addr);
        return { success: true, peerId };
      } catch (err: any) {
        return reply.code(500).send({ error: `Connection failed: ${err.message}` });
      }
    });

    // POST /transfer — transfer Lux
    fastify.post('/transfer', async (request: any, reply: any) => {
      const ledger = node.getLedger();
      const identity = node.getIdentity();

      if (!ledger || !identity) {
        return reply.code(503).send({ error: 'Node not ready', code: 'NODE_NOT_READY' });
      }

      const { to, amount } = request.body || {};
      if (!to || typeof to !== 'string') {
        return reply.code(400).send({ error: 'Missing or invalid "to" peer ID', code: 'INVALID_RECIPIENT' });
      }
      if (!amount || typeof amount !== 'number' || amount <= 0) {
        return reply.code(400).send({ error: 'Missing or invalid "amount" — must be a positive number', code: 'INVALID_AMOUNT' });
      }
      // Resolve sender: use authenticated user's peerId if available, fall back to node identity
      const userPeerId = await deps.verifyUserJwt(request);
      const senderPeerId = userPeerId || identity.peerId;

      if (to === senderPeerId) {
        return reply.code(400).send({ error: 'Cannot transfer to yourself', code: 'SELF_TRANSFER' });
      }

      try {
        // Phase 54.3: Auto-register recipient if valid peerId format (no need to be connected)
        const network = node.getNetwork();
        if (!ledger.accounts.exists(to)) {
          if (to.startsWith('12D3KooW') && to.length > 40) {
            ledger.registerNode(to, 'remote-transfer');
          } else {
            return reply.code(404).send({
              error: 'Invalid peer ID format',
              code: 'INVALID_PEER_ID',
            });
          }
        }

        // Check balance before attempting transfer
        const senderBalance = ledger.accounts.getBalance(senderPeerId);
        if (senderBalance < amount) {
          return reply.code(400).send({
            error: `Insufficient balance: you have ${senderBalance} Lux but need ${amount} Lux (plus relay fee)`,
            code: 'INSUFFICIENT_BALANCE',
            balance: senderBalance,
            requested: amount,
          });
        }

        // Pick a relay: random connected peer (not sender, not recipient)
        const peers = network?.getPeers() || [];
        const thirdParty = peers.filter(p => p.peerId !== senderPeerId && p.peerId !== to);
        const relay = thirdParty.length > 0
          ? thirdParty[Math.floor(Math.random() * thirdParty.length)].peerId
          : (to !== senderPeerId ? to : undefined);

        if (relay && !ledger.accounts.exists(relay)) {
          ledger.registerNode(relay, 'remote-peer');
        }

        const tx = ledger.transfer(senderPeerId, to, amount, relay);

        // Sign the transaction with our private key
        tx.signature = await signTransaction(tx, identity.privateKey);
        // Persist signature to ledger DB so local queries return signed records
        ledger.transactions.updateSignature(tx.id, tx.signature);

        // Broadcast to peers via GossipSub
        const sync = node.getSync();
        if (sync) {
          await sync.broadcastTransaction(tx);
        }

        // Push to SSE clients immediately
        deps.pushEvent('transaction', {
          id: tx.id,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
          type: tx.type,
          timestamp: tx.timestamp,
        });

        return { success: true, transaction: tx };
      } catch (err: any) {
        // Categorize known ledger errors
        const msg = err.message || 'Unknown error';
        if (msg.includes('Insufficient balance')) {
          return reply.code(400).send({ error: msg, code: 'INSUFFICIENT_BALANCE' });
        }
        if (msg.includes('not found')) {
          return reply.code(404).send({ error: msg, code: 'ACCOUNT_NOT_FOUND' });
        }
        return reply.code(500).send({ error: msg, code: 'TRANSFER_FAILED' });
      }
    });

    // ── Task Queue Routes ──

    // GET /tasks — list tasks (filterable by status, priority, assignedTo)
    fastify.get('/tasks', async (request: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return { tasks: [] };
      const q = request.query || {};
      const statusParam = q.status;
      const status = statusParam ? (statusParam.includes(',') ? statusParam.split(',') : statusParam) : undefined;
      return {
        tasks: tq.getTasks({
          status,
          priority: q.priority,
          assignedTo: q.assignedTo,
          limit: q.limit ? parseInt(q.limit) : undefined,
        }),
      };
    });

    // GET /tasks/stats — task queue statistics
    fastify.get('/tasks/stats', async () => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return { stats: {} };
      return { stats: tq.getStats() };
    });

    // GET /tasks/next — get next claimable task
    fastify.get('/tasks/next', async (request: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return { task: null };
      const agentId = request.query?.agentId;
      const task = tq.getNextClaimable(agentId);
      return { task };
    });

    // GET /tasks/agent/:agentId — get tasks claimed by a specific agent
    fastify.get('/tasks/agent/:agentId', async (request: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return { tasks: [] };
      return { tasks: tq.getClaimedTasks(request.params.agentId) };
    });

    // GET /tasks/archive — list archived tasks
    fastify.get('/tasks/archive', async (request: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return { tasks: [] };
      const limit = request.query?.limit ? parseInt(request.query.limit) : 50;
      return { tasks: tq.getArchivedTasks(limit) };
    });

    // POST /tasks/archive — trigger archival of old done/rejected tasks
    fastify.post('/tasks/archive', async (request: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return { archived: 0 };
      const olderThanMs = request.body?.olderThanMs || 7 * 24 * 60 * 60 * 1000;
      return tq.archiveOldTasks(olderThanMs);
    });

    // GET /tasks/:id — get a specific task
    fastify.get('/tasks/:id', async (request: any, reply: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const task = tq.getTask(request.params.id);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      return { task };
    });

    // POST /tasks — create a new task
    fastify.post('/tasks', async (request: any, reply: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { title, description, priority, createdBy, files, dependencies, requiredCapabilities, managerId } = request.body || {};
      if (!title) {
        return reply.code(400).send({ error: 'title is required' });
      }

      // Phase 19.2: Worker lockdown — when enabled, only managers and node admins can create tasks
      const workerLockdown = process.env.PANDO_WORKER_LOCKDOWN !== 'false';
      if (workerLockdown) {
        const localPeerId = node.getIdentity()?.peerId;
        if (!managerId && createdBy !== localPeerId) {
          return reply.code(403).send({ error: 'Tasks must be created by a Manager or node admin' });
        }
      }

      // Explicitly pass originNode so it's set even if TaskQueue.localPeerId isn't wired yet
      const identity = node.getIdentity();
      const task = tq.createTask({
        title,
        description: description || '',
        priority,
        createdBy: createdBy || 'admin',
        files,
        dependencies,
        originNode: identity?.peerId,
        requiredCapabilities,
        managerId,
      });

      // Phase 18.3: Seed first thread message with task description
      if (description) {
        tq.addMessage(task.id, {
          from: identity?.peerId || createdBy || 'admin',
          role: 'user',
          content: description,
        });
      }

      return { success: true, task };
    });

    // POST /tasks/:id/claim — claim a task for an agent
    fastify.post('/tasks/:id/claim', async (request: any, reply: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { agentId } = request.body || {};
      if (!agentId) return reply.code(400).send({ error: 'agentId is required' });
      const result = tq.claimTask(request.params.id, agentId);
      if (!result.success) return reply.code(409).send({ error: result.error });
      return { success: true };
    });

    // POST /tasks/:id/complete — mark a task as done
    fastify.post('/tasks/:id/complete', async (request: any, reply: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { commitHash, buildPassed, testsPassed, note } = request.body || {};
      const success = tq.completeTask(request.params.id, {
        commitHash, buildPassed, testsPassed, note,
      });
      if (!success) return reply.code(404).send({ error: 'Task not found' });

      // Report cascade-rejected children in the response
      const task = tq.getTask(request.params.id);
      const rejectedChildren: string[] = [];
      if (task?.childTasks) {
        for (const childId of task.childTasks) {
          const child = tq.getTask(childId);
          if (child && child.status === 'rejected' && child.result?.note === 'Parent task completed') {
            rejectedChildren.push(childId);
          }
        }
      }

      return { success: true, ...(rejectedChildren.length > 0 ? { rejectedChildren } : {}) };
    });

    // POST /tasks/:id/reject — permanently reject a task (persists status as 'rejected')
    fastify.post('/tasks/:id/reject', async (request: any, reply: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { reason } = request.body || {};
      const taskId = request.params.id;
      const task = tq.getTask(taskId);
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      // Use rejectTask to persist the reason in result.note (sets status to 'open')
      const success = tq.rejectTask(taskId, reason);
      if (!success) return reply.code(500).send({ error: 'Failed to reject task' });

      // Fix: override status to 'rejected' so the task is permanently rejected
      // and does not get re-picked by the scheduler (rejectTask sets 'open')
      tq.updateStatus(taskId, 'rejected');

      // Add timeline event for the rejection
      tq.pushTimelineEvent(taskId, {
        event: 'rejected',
        detail: reason ? `Rejected: ${reason}` : 'Task rejected via API',
        metadata: { source: 'api' },
      });

      return { success: true };
    });

    // POST /tasks/:id/release — release a claimed task back to open (advisory)
    fastify.post('/tasks/:id/release', async (request: any, reply: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { agentId } = request.body || {};
      if (!agentId) return reply.code(400).send({ error: 'agentId is required' });
      const result = tq.releaseTask(request.params.id, agentId);
      if (!result.success) return reply.code(409).send({ error: result.error });
      return { success: true };
    });

    // POST /tasks/:id/approve — push a task to the scheduler's approved queue
    // Auto-generates a profile via Planner if none provided
    fastify.post('/tasks/:id/approve', async (request: any, reply: any) => {
      const scheduler = node.getScheduler();
      if (!scheduler) return reply.code(503).send({ error: 'Scheduler not available' });
      const taskId = request.params.id;
      const tq = node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const task = tq.getTask(taskId);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      if (task.status !== 'open') return reply.code(409).send({ error: `Task status is '${task.status}', expected 'open'` });

      // Resolve agent profile — use provided profile, or auto-generate via Planner
      const { profile: providedProfile } = request.body || {};
      let resolvedProfile: any;

      if (providedProfile) {
        resolvedProfile = providedProfile;
      } else {
        resolvedProfile = {
          profileId: `auto-${Date.now()}`,
          role: 'general',
          contextNeeds: [],
          tools: [],
          tier: 'short-session' as any,
          systemPrompt: `Complete this task: ${task.title}`,
        };
      }

      // Pass profile to scheduler via the new 3rd parameter — stored in approvedProfiles Map
      scheduler.receiveApprovedTask(taskId, 'api', resolvedProfile);
      return { success: true, taskId, profileId: resolvedProfile?.profileId };
    });

    // POST /tasks/:id/status — update task status
    fastify.post('/tasks/:id/status', async (request: any, reply: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { status, assignedTo } = request.body || {};
      if (!status) return reply.code(400).send({ error: 'status is required' });
      const success = tq.updateStatus(request.params.id, status, assignedTo);
      if (!success) return reply.code(404).send({ error: 'Task not found' });
      return { success: true };
    });

    // ── Task Thread Routes (Phase 18.3) ──

    // GET /tasks/:id/thread — get conversation thread for a task
    fastify.get('/tasks/:id/thread', async (request: any, reply: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const task = tq.getTask(request.params.id);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      return { thread: tq.getThread(request.params.id) };
    });

    // POST /tasks/:id/thread — add a message to a task's conversation thread
    fastify.post('/tasks/:id/thread', async (request: any, reply: any) => {
      const tq = node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const task = tq.getTask(request.params.id);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      const { content, role } = request.body || {};
      if (!content || typeof content !== 'string') {
        return reply.code(400).send({ error: '"content" (string) is required' });
      }
      if (content.length > 5000) {
        return reply.code(400).send({ error: 'Message too long (max 5000 characters)' });
      }
      const validRoles = ['user', 'agent', 'system'];
      const msgRole = validRoles.includes(role) ? role : 'user';
      const identity = node.getIdentity();
      const msg = tq.addMessage(request.params.id, {
        from: identity?.peerId || 'anonymous',
        role: msgRole,
        content: content.trim(),
      });
      if (!msg) return reply.code(500).send({ error: 'Failed to add message' });
      return { success: true, message: msg };
    });

    // ── Governance Routes ──

    // GET /governance/proposals — list all proposals (with vote counts, comments, decisions)
    fastify.get('/governance/proposals', async () => {
      const gov = node.getGovernance();
      if (!gov) return { proposals: [] };
      const proposals = gov.getProposals();
      return {
        proposals: proposals.map(p => {
          const votes = gov.getVotes(p.id);
          const decision = gov.getDecision(p.id);
          const approveCount = votes.filter(v => v.choice === 'approve').length;
          const rejectCount = votes.filter(v => v.choice === 'reject').length;
          const abstainCount = votes.filter(v => v.choice === 'abstain').length;
          return {
            ...p,
            votes: {
              approve: approveCount || (decision?.votesFor ?? 0),
              reject: rejectCount || (decision?.votesAgainst ?? 0),
              abstain: abstainCount || (decision?.votesAbstain ?? 0),
            },
            commentCount: gov.getComments(p.id).length,
            decision: decision || null,
          };
        }),
      };
    });

    // GET /governance/proposals/active — list active proposals (with vote counts, comments, decisions)
    fastify.get('/governance/proposals/active', async () => {
      const gov = node.getGovernance();
      if (!gov) return { proposals: [] };
      const proposals = gov.getActiveProposals();
      return {
        proposals: proposals.map(p => {
          const votes = gov.getVotes(p.id);
          const decision = gov.getDecision(p.id);
          const approveCount = votes.filter(v => v.choice === 'approve').length;
          const rejectCount = votes.filter(v => v.choice === 'reject').length;
          const abstainCount = votes.filter(v => v.choice === 'abstain').length;
          return {
            ...p,
            votes: {
              approve: approveCount || (decision?.votesFor ?? 0),
              reject: rejectCount || (decision?.votesAgainst ?? 0),
              abstain: abstainCount || (decision?.votesAbstain ?? 0),
            },
            commentCount: gov.getComments(p.id).length,
            decision: decision || null,
          };
        }),
      };
    });

    // GET /governance/proposal/:id — get proposal details
    fastify.get('/governance/proposal/:id', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const proposal = gov.getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      return {
        proposal,
        comments: gov.getComments(proposal.id),
        votes: gov.getVotes(proposal.id),
        decision: gov.getDecision(proposal.id),
      };
    });

    // GET /governance/proposal/:id/models — model breakdown for a proposal (Phase 10.5)
    fastify.get('/governance/proposal/:id/models', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const proposal = gov.getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      return gov.getModelBreakdown(proposal.id);
    });

    // DELETE /governance/proposal/:id — delete a proposal (admin cleanup)
    fastify.delete('/governance/proposal/:id', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      try {
        const result = gov.deleteProposal(request.params.id);
        return { success: true, deleted: result.title };
      } catch (err: any) {
        return reply.code(404).send({ error: err.message });
      }
    });

    // POST /governance/propose — create a new proposal
    fastify.post('/governance/propose', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      // Dual-auth: accept user JWT or operator Bearer token
      const userPeerId = await deps.verifyUserJwt(request);
      const identity = node.getIdentity();
      const proposerPeerId = userPeerId || identity?.peerId;
      const { title, description, votingDurationMs, category, isEmergency } = request.body || {};
      if (!title || !description) return reply.code(400).send({ error: 'title and description required' });
      const trimmedTitle = title.trim();
      const trimmedDesc = description.trim();
      if (!trimmedTitle) return reply.code(400).send({ error: 'Title cannot be empty' });
      if (trimmedTitle.length > 200) return reply.code(400).send({ error: 'Title must be 200 characters or fewer' });
      if (trimmedDesc.length > 2000) return reply.code(400).send({ error: 'Description must be 2000 characters or fewer' });
      try {
        const proposal = await gov.createProposal(trimmedTitle, trimmedDesc, votingDurationMs || 300_000, { category, isEmergency });
        return { success: true, proposal, proposer: proposerPeerId };
      } catch (err: any) {
        return reply.code(429).send({ error: err.message });
      }
    });

    // POST /governance/comment — add comment to a proposal
    fastify.post('/governance/comment', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const { proposalId, content } = request.body || {};
      if (!proposalId || !content) return reply.code(400).send({ error: 'proposalId and content required' });
      const proposal = gov.getProposal(proposalId);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      try {
        await gov.addComment(proposalId, content);
        return { success: true };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // POST /governance/vote — cast a vote on a proposal (with optional model attestation)
    fastify.post('/governance/vote', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      // Dual-auth: accept user JWT or operator Bearer token
      const userPeerId = await deps.verifyUserJwt(request);
      const identity = node.getIdentity();
      const voterPeerId = userPeerId || identity?.peerId;
      const { proposalId, choice, reasoning, modelAttestation } = request.body || {};
      if (!proposalId || !choice) return reply.code(400).send({ error: 'proposalId and choice required' });
      if (!['approve', 'reject', 'abstain'].includes(choice)) {
        return reply.code(400).send({ error: 'choice must be approve, reject, or abstain' });
      }
      try {
        await gov.castVote(proposalId, choice, reasoning || '', modelAttestation || undefined);
        // Return updated vote counts and decision (quorum may have been reached)
        const votes = gov.getVotes(proposalId);
        const decision = gov.getDecision(proposalId);
        return {
          success: true,
          voter: voterPeerId,
          votes: {
            approve: votes.filter(v => v.choice === 'approve').length,
            reject: votes.filter(v => v.choice === 'reject').length,
            abstain: votes.filter(v => v.choice === 'abstain').length,
          },
          decision: decision || null,
        };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // POST /governance/message — send agent-to-agent message
    fastify.post('/governance/message', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const { content, to } = request.body || {};
      if (!content) return reply.code(400).send({ error: 'content required' });
      await gov.sendAgentMessage(content, to || 'all');
      return { success: true };
    });

    // ── Phase 30.7: Governance Review API Routes ──

    // GET /governance/proposals/:id/reviews — get all AI reviews for a proposal
    fastify.get('/governance/proposals/:id/reviews', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const proposal = gov.getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      const reviews = gov.getProposalReviews(proposal.id);
      const summary = gov.computeReviewSummary(proposal.id);
      return { proposalId: proposal.id, reviews, summary: summary || null };
    });

    // GET /governance/proposals/:id/reviewers — get reviewer assignments and status
    fastify.get('/governance/proposals/:id/reviewers', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const proposal = gov.getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      const reviewers = gov.getReviewerAssignments(proposal.id);
      const selectedReviewers = gov.getSelectedReviewers(proposal.id);
      return {
        proposalId: proposal.id,
        reviewers,
        selectedReviewers,
        reviewerCount: proposal.reviewerCount ?? 0,
        humanOnly: proposal.humanOnly ?? false,
      };
    });

    // POST /governance/proposals/:id/review — submit a review (for reviewer agents, requires auth)
    fastify.post('/governance/proposals/:id/review', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const identity = node.getIdentity();
      if (!identity) return reply.code(503).send({ error: 'Node not ready' });

      const proposal = gov.getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });

      const { riskScore, reasoning, recommendation, modelAttestation } = request.body || {};
      if (riskScore === undefined || !reasoning || !recommendation) {
        return reply.code(400).send({ error: 'riskScore, reasoning, and recommendation are required' });
      }
      if (typeof riskScore !== 'number' || riskScore < 1 || riskScore > 5) {
        return reply.code(400).send({ error: 'riskScore must be a number between 1 and 5' });
      }
      if (!['approve', 'reject', 'revise'].includes(recommendation)) {
        return reply.code(400).send({ error: 'recommendation must be approve, reject, or revise' });
      }

      try {
        const review = await gov.submitReview(proposal.id, identity.peerId, {
          riskScore,
          reasoning: String(reasoning).slice(0, 5000),
          recommendation,
          modelAttestation: modelAttestation || undefined,
        });
        return { success: true, review };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // GET /governance/stats — enhanced governance statistics
    fastify.get('/governance/stats', async (request: any, reply: any) => {
      const gov = node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const stats = gov.getGovernanceStats();
      const proposals = gov.getProposals();
      const statusCounts: Record<string, number> = {};
      for (const p of proposals) {
        statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
      }
      return {
        ...stats,
        statusCounts,
      };
    });

    // ── File Registry Routes ──

    // GET /files/claims — list all active file claims
    fastify.get('/files/claims', async () => {
      const registry = node.getFileRegistry();
      return { claims: registry.listClaims() };
    });

    // POST /files/claim — claim a file for editing
    fastify.post('/files/claim', async (request: any, reply: any) => {
      const identity = node.getIdentity();
      if (!identity) return reply.code(503).send({ error: 'Node not ready' });
      const { filePath } = request.body || {};
      if (!filePath || typeof filePath !== 'string') {
        return reply.code(400).send({ error: 'filePath is required' });
      }
      const registry = node.getFileRegistry();
      const success = registry.claimFile(filePath, identity.peerId);
      if (!success) {
        const existing = registry.checkClaim(filePath, identity.peerId);
        return reply.code(409).send({
          error: 'File already claimed by another agent',
          claim: existing,
        });
      }
      return { success: true, filePath };
    });

    // POST /files/release — release a file claim
    fastify.post('/files/release', async (request: any, reply: any) => {
      const identity = node.getIdentity();
      if (!identity) return reply.code(503).send({ error: 'Node not ready' });
      const { filePath } = request.body || {};
      if (!filePath || typeof filePath !== 'string') {
        return reply.code(400).send({ error: 'filePath is required' });
      }
      const registry = node.getFileRegistry();
      const released = registry.releaseFile(filePath, identity.peerId);
      if (!released) {
        return reply.code(404).send({ error: 'No active claim found for this file by your identity' });
      }
      return { success: true, filePath };
    });

    // ── Pipeline Routes (Phase 16) ──

    // GET /pipeline/status — pipeline enabled/disabled state and component info
    fastify.get('/pipeline/status', async () => {
      const enabled = node.isPipelineEnabled();
      const runner = node.getPipelineRunner();
      if (!enabled || !runner) {
        return {
          enabled: false,
          running: false,
          currentStage: null,
          runsCompleted: 0,
          lastRun: null,
        };
      }
      const status = runner.getPipelineStatus();
      return {
        enabled: true,
        ...status,
      };
    });

    // Phase 33: POST /pipeline/run — agent-triggered pipeline for applying workspace changes
    fastify.post('/pipeline/run', async (request: any, reply: any) => {
      const runner = node.getPipelineRunner();
      if (!runner) {
        return reply.code(503).send({ error: 'Pipeline not available (node started without --pipeline flag)' });
      }

      const body = (request.body as { workspaceDir?: string; proposalId?: string }) || {};
      const workspaceDir = body.workspaceDir;
      if (!workspaceDir) {
        return reply.code(400).send({ error: 'workspaceDir is required' });
      }

      // For governance-approved changes, skip QA — the governance process IS the review
      const isGovernanceRun = !!body.proposalId;
      const overrides = isGovernanceRun ? { skipQa: true, useGitDiff: true } : undefined;

      try {
        console.log(`[pipeline] Agent-triggered pipeline run from workspace: ${workspaceDir}${body.proposalId ? ` (proposal: ${body.proposalId})` : ''}`);
        if (isGovernanceRun) {
          console.log(`[pipeline] Governance-approved run — QA skipped (proposal: ${body.proposalId})`);
        }
        const result = await runner.runPipeline(workspaceDir, body.proposalId, overrides);

        const response = {
          success: result.success,
          pipelineId: result.pipelineId,
          stages: result.stages.map((s: any) => ({
            stage: s.stage,
            success: s.success,
            durationMs: s.durationMs,
            error: s.error,
          })),
          totalDurationMs: result.totalDurationMs,
        };

        // Schedule graceful restart after successful governance pipeline
        if (result.success && isGovernanceRun) {
          // Check if any changed files require a node restart
          const pipelineResult = result.pipelineResult;
          const changedFiles = pipelineResult?.patchSet?.changes?.map((c: any) => c.filePath).filter(Boolean) || [];
          const needsRestart = changedFiles.some(
            (f: string) => f.startsWith('packages/node/') || f.startsWith('packages/shared/') || f.startsWith('packages/ledger/')
          ) || changedFiles.length === 0; // Default to restart if we can't determine

          if (needsRestart) {
            console.log('[pipeline] Governance pipeline succeeded — node source changed, scheduling restart in 5s');
            setTimeout(async () => {
              try {
                const { writeRestartReason } = await import('../kernel/restart-reason.js');
                writeRestartReason('pipeline-deploy');

                // Phase 34: Use restart handler if set (TUI intercepts this)
                const handler = node.getRestartHandler();
                if (handler) {
                  handler('pipeline-deploy', changedFiles);
                  return;
                }

                // Fallback: direct shutdown + exit (headless/PM2 mode)
                console.log('[pipeline] Graceful shutdown: stopping agents...');
                node.stopAgentSystem();
                console.log(`[pipeline] Agent system stopped`);

                console.log('[pipeline] Graceful shutdown: stopping node...');
                await node.stop();

                console.log('[pipeline] Graceful restart — exit code 75 (launcher will restart)');
                process.exit(75);
              } catch (err) {
                console.error('[pipeline] Restart failed, forcing exit:', err);
                process.exit(75);
              }
            }, 5000);
          } else {
            console.log('[pipeline] Governance pipeline succeeded — no node source changes, skipping restart');
          }
        }

        return response;
      } catch (err: any) {
        return reply.code(500).send({ error: err.message || 'Pipeline failed' });
      }
    });

    // GET /transactions/:peerId — transaction history for a peer
    fastify.get('/transactions/:peerId', async (request: any, reply: any) => {
      const ledger = node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      const peerId = request.params.peerId;
      const limit = Math.min(parseInt(request.query?.limit) || 50, 200);
      const txs = ledger.transactions.getTransactionsForPeer(peerId, limit);

      return {
        peerId,
        transactions: txs.map((tx: any) => ({
          id: tx.id,
          from: tx.from_peer,
          to: tx.to_peer,
          amount: tx.amount,
          fee: tx.fee,
          relay: tx.relay_peer,
          type: tx.type,
          timestamp: tx.timestamp,
        })),
      };
    });

    // ── Agent Transparency Routes ──

    // GET /network/overview — single "what's happening" call
    fastify.get('/network/overview', async () => {
      const network = node.getNetwork();
      const ledger = node.getLedger();
      const identity = node.getIdentity();
      const gov = node.getGovernance();

      const stats = ledger?.getNetworkStats();
      const peerList = network?.getPeers() || [];
      const activeProposals = gov ? gov.getActiveProposals() : [];
      const recentActivity = ledger ? ledger.getActivity({ limit: 10 }) : [];

      return {
        nodes: {
          self: identity?.peerId || null,
          peerCount: peerList.length,
          peers: peerList.map(p => ({
            peerId: p.peerId,
            connectedAt: p.connectedAt,
            lastSeen: p.lastSeen,
          })),
        },
        agents: {
          knownAgents: node.getKnownAgents(),
        },
        activeProposals: activeProposals.length,
        recentActivity,
        luxMetrics: {
          totalSupply: stats?.totalSupply || 0,
          circulatingSupply: stats?.circulatingSupply || 0,
          totalBurned: stats?.totalBurned || 0,
          totalRelayFees: stats?.totalRelayFees || 0,
          totalAccounts: stats?.totalAccounts || 0,
          totalTransactions: stats?.totalTransactions || 0,
        },
        uptime: Math.floor(process.uptime()),
      };
    });

    // GET /network/topology — network graph: nodes + edges
    fastify.get('/network/topology', async () => {
      const network = node.getNetwork();
      const identity = node.getIdentity();
      if (!network || !identity) {
        return { nodes: [], edges: [] };
      }

      const peers = network.getPeers();
      const nodes = [
        { peerId: identity.peerId, connectedSince: null },
        ...peers.map(p => ({ peerId: p.peerId, connectedSince: p.connectedAt })),
      ];
      const edges = peers.map(p => ({ from: identity.peerId, to: p.peerId }));

      return { nodes, edges };
    });

    // GET /activity/stream — enhanced activity feed with agent info from the activity table
    fastify.get('/activity/stream', async (request: any) => {
      const ledger = node.getLedger();
      const parsed = parseInt(request.query?.limit);
      const limit = Math.min((!parsed || parsed <= 0) ? 50 : parsed, 200);
      const since = request.query?.since ? parseInt(request.query.since) : undefined;
      const agentId = request.query?.agentId as string | undefined;
      const action = request.query?.action as string | undefined;

      if (!ledger) return { events: [] };

      const events = ledger.getActivity({ limit, since, agentId, action });
      return { events };
    });

    // GET /activity/stats — aggregated activity stats within a time window
    fastify.get('/activity/stats', async (request: any, reply: any) => {
      const ledger = node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      const windowParam = (request.query?.window as string) || '24h';
      const windowMap: Record<string, number> = {
        '1h':  60 * 60 * 1000,
        '6h':  6 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d':  7 * 24 * 60 * 60 * 1000,
      };
      const windowMs = windowMap[windowParam];
      if (!windowMs) {
        return reply.code(400).send({ error: 'Invalid window. Must be one of: 1h, 6h, 24h, 7d' });
      }

      const stats = ledger.getActivityStats(windowMs);
      return { window: windowParam, ...stats };
    });

    // POST /activity/record — record a new activity event and broadcast to network
    fastify.post('/activity/record', async (request: any, reply: any) => {
      const ledger = node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      const record = request.body;
      if (!record?.id || !record?.agentId || !record?.action || !record?.summary || !record?.signature) {
        return reply.code(400).send({ error: 'Missing required fields: id, agentId, action, summary, signature' });
      }

      // Validate action against allowed types
      const validActions = [
        'proposal_created', 'proposal_commented', 'proposal_voted', 'proposal_decided',
        'task_accepted', 'task_in_progress', 'task_completed', 'task_failed',
        'code_written', 'code_reviewed', 'code_deployed',
        'analysis_started', 'analysis_completed', 'search_handled',
        'agent_online', 'agent_offline', 'agent_wake_cycle', 'health_check',
        'strategy_update', 'roadmap_revision', 'weekly_report_published',
      ];
      if (!validActions.includes(record.action)) {
        return reply.code(400).send({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
      }

      // Sanitize text fields to prevent stored XSS
      const sanitize = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      record.summary = sanitize(record.summary);
      if (record.details) record.details = sanitize(record.details);

      ledger.recordActivity(record);

      // Broadcast to all peers via GossipSub
      const sync = node.getSync();
      if (sync) {
        await sync.broadcastActivity(record);
      }

      // Push to SSE clients for real-time gateway updates
      deps.pushEvent('activity', {
        id: record.id,
        agentId: record.agentId,
        action: record.action,
        summary: record.summary,
        timestamp: record.timestamp,
      });

      return { success: true, broadcast: true };
    });

    // GET /activity — unified network activity feed (transactions + governance events)
    fastify.get('/activity', async (request: any) => {
      const ledger = node.getLedger();
      const gov = node.getGovernance();
      const identity = node.getIdentity();
      const parsedActivityLimit = parseInt(request.query?.limit);
      const limit = Math.min((!parsedActivityLimit || parsedActivityLimit <= 0) ? 30 : parsedActivityLimit, 100);

      const events: Array<{ type: string; timestamp: number; data: any }> = [];

      // Recent transactions (last 24 hours or fallback to all)
      if (ledger) {
        const since = Date.now() - 24 * 60 * 60 * 1000;
        const txs = ledger.getTransactionsSince(since, limit);
        for (const tx of txs) {
          events.push({
            type: tx.type === 'emission' ? 'emission' : 'transfer',
            timestamp: tx.timestamp,
            data: {
              id: tx.id,
              from: tx.from,
              to: tx.to,
              amount: tx.amount,
              fee: tx.fee,
              relay: tx.relay,
            },
          });
        }
      }

      // Governance proposals
      if (gov) {
        const proposals = gov.getProposals();
        for (const p of proposals) {
          events.push({
            type: 'proposal',
            timestamp: p.createdAt,
            data: {
              id: p.id,
              title: p.title,
              proposedBy: p.proposedBy,
              status: p.status,
            },
          });

          // Include votes for each proposal
          const votes = gov.getVotes(p.id);
          for (const v of votes) {
            events.push({
              type: 'vote',
              timestamp: v.createdAt,
              data: {
                proposalId: p.id,
                proposalTitle: p.title,
                voter: v.voter,
                choice: v.choice,
              },
            });
          }
        }
      }

      // Sort by timestamp descending and limit
      events.sort((a, b) => b.timestamp - a.timestamp);
      const trimmed = events.slice(0, limit);

      return {
        events: trimmed,
        nodeId: identity?.peerId || '',
      };
    });

    // GET /events — Server-Sent Events stream for real-time updates
    fastify.get('/events', (request: any, reply: any) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Send initial snapshot immediately
      const snapshot = deps.getSnapshot();
      reply.raw.write(`event: update\ndata: ${JSON.stringify(snapshot)}\n\n`);

      // Send heartbeat every 15s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          cleanup();
        }
      }, 15000);

      deps.addSSEClient(reply);

      const cleanup = () => {
        clearInterval(heartbeat);
        deps.removeSSEClient(reply);
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    });

    // ── Network Onboarding Routes ──

    // GET /bootstrap — return multiaddrs for bootstrapping new nodes
    fastify.get('/bootstrap', async (request: any, reply: any) => {
      const network = node.getNetwork();
      const identity = node.getIdentity();
      if (!network || !identity) {
        return reply.code(503).send({ error: 'Node not ready' });
      }
      const addrs = network.getListenAddresses();
      // Filter out localhost/loopback — only return routable addresses
      const routable = addrs.filter((a: string) => !a.includes('/127.0.0.1/') && !a.includes('/::1/'));
      return { peerId: identity.peerId, addrs: routable.length > 0 ? routable : addrs };
    });

    // GET /onboard — onboarding info for new node operators
    fastify.get('/onboard', async (request: any, reply: any) => {
      const network = node.getNetwork();
      const identity = node.getIdentity();
      if (!network || !identity) {
        return reply.code(503).send({ error: 'Node not ready' });
      }
      const addrs = network.getListenAddresses();
      const routable = addrs.filter((a: string) => !a.includes('/127.0.0.1/') && !a.includes('/::1/'));
      const bootstrapAddrs = routable.length > 0 ? routable : addrs;
      return {
        bootstrapAddrs,
        instructions: [
          '1. Install Node.js 18+ (https://nodejs.org)',
          '2. Clone the repo: git clone https://github.com/pando-lux/pando.git',
          '3. Install dependencies: npm install',
          '4. Build: npm run build',
          `5. Start your node: node packages/node/dist/cli.js --port 4001 --bootstrap ${bootstrapAddrs[0] || '<multiaddr>'}`,
          '6. (Optional) Start the gateway: cd packages/gateway && npx next dev --port 3222',
        ].join('\n'),
        version: '0.1.0',
        peerId: identity.peerId,
        peerCount: network.getPeerCount(),
      };
    });

    // GET /discovery — how each peer was discovered (mDNS, bootstrap, DHT, manual)
    fastify.get('/discovery', async () => {
      const network = node.getNetwork();
      const identity = node.getIdentity();
      if (!network || !identity) {
        return { peers: [] };
      }

      const connectedPeers = network.getPeers();
      const sources = network.getDiscoverySources();

      return {
        self: identity.peerId,
        peers: connectedPeers.map(p => ({
          peerId: p.peerId,
          discoveredVia: sources.get(p.peerId) || 'unknown',
          connectedAt: p.connectedAt,
          lastSeen: p.lastSeen,
        })),
        // Include historical discovery data for disconnected peers
        allDiscovered: Array.from(sources.entries()).map(([peerId, source]) => ({
          peerId,
          discoveredVia: source,
          currentlyConnected: connectedPeers.some(p => p.peerId === peerId),
        })),
      };
    });

    // POST /search — AI search
    fastify.post('/search', async (request: any, reply: any) => {
      const { query, identity } = request.body || {};
      if (!query || typeof query !== 'string') {
        return reply.code(400).send({ error: 'Query is required' });
      }

      try {
        const result = await node.search(query, identity);
        return result;
      } catch (err: any) {
        return reply.code(500).send({
          answer: 'Search is temporarily unavailable. Please try again later.',
          sources: [],
          confidence: 'none',
          respondedBy: 'node-error',
        });
      }
    });

    // ── Snapshot Routes ──

    // GET /snapshot — get latest snapshot info (or full snapshot data)
    fastify.get('/snapshot', async (request: any, reply: any) => {
      const ledger = node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      const full = (request.query as any)?.full === 'true';
      if (full) {
        const path = ledger.getLatestSnapshotPath(node.getDataDir() || undefined);
        if (!path) return reply.code(404).send({ error: 'No snapshots available' });
        try {
          const { readFileSync } = await import('node:fs');
          const data = JSON.parse(readFileSync(path, 'utf-8'));
          return data;
        } catch (err: any) {
          return reply.code(500).send({ error: `Failed to read snapshot: ${err.message}` });
        }
      }

      const info = ledger.getSnapshotInfo(node.getDataDir() || undefined);
      if (!info) return reply.code(404).send({ error: 'No snapshots available' });
      return info;
    });

    // POST /snapshot/create — trigger a new snapshot
    fastify.post('/snapshot/create', async (request: any, reply: any) => {
      const ledger = node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      try {
        const info = ledger.createSnapshot(node.getDataDir() || undefined);
        return { success: true, snapshot: info };
      } catch (err: any) {
        return reply.code(500).send({ error: `Snapshot creation failed: ${err.message}` });
      }
    });

    // ── Scheduler Routes ──────────────────────────────────────────────────────
    // Phase 1 Scheduler — task-driven orchestrator that creates workspaces,
    // generates agent profiles, and spawns agents automatically.

    // GET /scheduler/status — Scheduler status: running, active tasks, config
    fastify.get('/scheduler/status', async (request: any, reply: any) => {
      const scheduler = node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      return {
        ...scheduler.getStatus(),
        upgradeInProgress: node.isUpgradeInProgress(),
        restartPending: node.isRestartPending(),
      };
    });

    // POST /scheduler/start — Start the Scheduler
    fastify.post('/scheduler/start', async (request: any, reply: any) => {
      const existing = node.getScheduler();
      if (existing) {
        return { message: 'Scheduler already running', ...existing.getStatus() };
      }
      const scheduler = node.startScheduler();
      return { success: true, ...scheduler.getStatus() };
    });

    // POST /scheduler/stop — Stop the Scheduler
    fastify.post('/scheduler/stop', async () => {
      const scheduler = node.getScheduler();
      if (!scheduler) return { message: 'Scheduler not running' };
      node.stopScheduler();
      return { success: true, message: 'Scheduler stopped' };
    });

    // POST /scheduler/submit — Submit a task for Scheduler processing
    fastify.post('/scheduler/submit', async (request: any, reply: any) => {
      const scheduler = node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const { title, description, priority } = request.body || {};
      if (!description || typeof description !== 'string') {
        return reply.code(400).send({ error: 'description is required' });
      }
      const taskTitle = (title && typeof title === 'string')
        ? title.slice(0, 200)
        : description.slice(0, 50);
      const taskPriority = ['critical', 'high', 'medium', 'low'].includes(priority)
        ? priority
        : 'medium';

      // Use the node's active TaskQueue (which has network wired for GossipSub broadcast)
      const tq = node.getActiveTaskQueue();
      if (!tq) {
        return reply.code(503).send({ error: 'TaskQueue not available' });
      }
      const identity = node.getIdentity();
      const task = tq.createTask({
        title: taskTitle,
        description,
        priority: taskPriority,
        createdBy: 'scheduler-api',
        originNode: identity?.peerId,
      });

      // Phase 18.3: Seed first thread message with user's description
      tq.addMessage(task.id, {
        from: identity?.peerId || 'user',
        role: 'user',
        content: description,
      });

      return { success: true, taskId: task.id, task };
    });

    // GET /scheduler/tasks — List tasks with Scheduler lifecycle info
    fastify.get('/scheduler/tasks', async (request: any, reply: any) => {
      const scheduler = node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const status = scheduler.getStatus();
      // Get all tasks from the TaskQueue
      const { TaskQueue } = await import('../platform/task-queue.js');
      const dataDir = node.getDataDir() || undefined;
      const tq = new TaskQueue(dataDir);
      const allTasks = tq.getTasks({});

      // Annotate with Scheduler lifecycle info from active tasks
      const activeMap = new Map(status.activeTasks.map(at => [at.taskId, at]));
      const annotated = allTasks.map((task: any) => {
        const active = activeMap.get(task.id);
        return {
          ...task,
          schedulerLifecycle: active ? active.lifecycle : (task.status === 'done' ? 'done' : (task.status === 'rejected' ? 'failed' : 'dormant')),
          schedulerProfile: active ? (active as any).profile?.profileId : undefined,
          schedulerWorkspaceDir: active ? (active as any).workspace?.dir : undefined,
          failureReason: (task.status === 'rejected' && task.result?.note) ? task.result.note : undefined,
          timeline: task.timeline ? task.timeline.slice(-3) : [],
        };
      });
      return { tasks: annotated };
    });

    // GET /scheduler/tasks/:id — Get specific task details + workspace info
    fastify.get('/scheduler/tasks/:id', async (request: any, reply: any) => {
      const scheduler = node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const taskId = request.params.id;
      const { TaskQueue } = await import('../platform/task-queue.js');
      const dataDir = node.getDataDir() || undefined;
      const tq = new TaskQueue(dataDir);
      const task = tq.getTask(taskId);
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      const status = scheduler.getStatus();
      const active = status.activeTasks.find(at => at.taskId === taskId);

      const workspace = null;
      const output = task.result?.note || null;

      // Extract failure reason from task result note (for rejected/failed tasks)
      const failureReason = (task.status === 'rejected' && task.result?.note) ? task.result.note : null;

      return {
        task,
        scheduler: {
          lifecycle: active ? active.lifecycle : (task.status === 'done' ? 'done' : (task.status === 'rejected' ? 'failed' : 'dormant')),
          profile: (active as any)?.profile || null,
          workspace: workspace,
        },
        output: output,
        failureReason,
        timeline: task.timeline || [],
      };
    });

    // GET /scheduler/tasks/:id/output — Get output from completed task
    fastify.get('/scheduler/tasks/:id/output', async (request: any, reply: any) => {
      const scheduler = node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const taskId = request.params.id;
      const { TaskQueue } = await import('../platform/task-queue.js');
      const tq = new TaskQueue(node.getDataDir() || undefined);
      const task = tq.getTask(taskId);
      const output = task?.result?.note || null;
      if (output === null) {
        return reply.code(404).send({ error: 'No output available for this task' });
      }
      return { taskId, output };
    });

    // GET /scheduler/tasks/:id/logs — Get persisted agent execution logs
    fastify.get('/scheduler/tasks/:id/logs', async (request: any, reply: any) => {
      const taskId = request.params.id;
      const scheduler = node.getScheduler();

      // Try scheduler's getTaskLogs first (if available)
      if (scheduler) {
        const logs = scheduler.getTaskLogs(taskId);
        if (logs.length > 0) {
          return { taskId, logs };
        }
      }

      // Fallback: read log files directly from workspace directory
      try {
        const { readdirSync: readDir, readFileSync: readFile, existsSync: fsExists } = await import('node:fs');
        const { join: pJoin } = await import('node:path');
        const wsDir = pJoin(node.getDataDir() || join(homedir(), '.pando'), 'workspaces', taskId);
        if (!fsExists(wsDir)) {
          return reply.code(404).send({ error: 'Workspace not found for this task' });
        }
        const entries = readDir(wsDir);
        const logFiles = entries.filter((f: string) => f.startsWith('agent-stream') && f.endsWith('.log'));
        if (logFiles.length === 0) {
          return reply.code(404).send({ error: 'No execution logs found for this task' });
        }
        const logs = logFiles.map((file: string) => {
          const content = readFile(pJoin(wsDir, file), 'utf-8');
          const lines = content.split('\n').filter((l: string) => l.trim());
          return { file, lines };
        });
        return { taskId, logs };
      } catch {
        return reply.code(404).send({ error: 'No execution logs found for this task' });
      }
    });

    // GET /scheduler/tasks/:id/files — List workspace files (recursive)
    fastify.get('/scheduler/tasks/:id/files', async (request: any, reply: any) => {
      const taskId = request.params.id;
      const { readdirSync, statSync } = await import('node:fs');
      const { join: pathJoin, relative } = await import('node:path');
      const wsDir = pathJoin(node.getDataDir() || join(homedir(), '.pando'), 'workspaces', taskId);
      try {
        statSync(wsDir);
      } catch {
        return reply.code(404).send({ error: 'Workspace not found' });
      }
      const files: { path: string; size: number; isDir: boolean }[] = [];
      const walk = (dir: string) => {
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = pathJoin(dir, entry.name);
            const rel = relative(wsDir, full).replace(/\\/g, '/');
            if (entry.isDirectory()) {
              files.push({ path: rel, size: 0, isDir: true });
              walk(full);
            } else {
              try { files.push({ path: rel, size: statSync(full).size, isDir: false }); } catch { }
            }
          }
        } catch { }
      };
      walk(wsDir);
      return { taskId, workspaceDir: wsDir, files };
    });

    // GET /scheduler/tasks/:id/files/* — Read a specific workspace file
    fastify.get('/scheduler/tasks/:id/files/*', async (request: any, reply: any) => {
      const taskId = request.params.id;
      const filePath = (request.params as any)['*'];
      if (!filePath || filePath.includes('..')) {
        return reply.code(400).send({ error: 'Invalid file path' });
      }
      const { readFileSync, statSync: statSync2 } = await import('node:fs');
      const { join: pathJoin } = await import('node:path');
      const wsDir = pathJoin(node.getDataDir() || join(homedir(), '.pando'), 'workspaces', taskId);
      const fullPath = pathJoin(wsDir, filePath);
      // Security: ensure file is within workspace
      if (!fullPath.replace(/\\/g, '/').startsWith(wsDir.replace(/\\/g, '/'))) {
        return reply.code(403).send({ error: 'Access denied' });
      }
      try {
        const stat = statSync2(fullPath);
        if (stat.isDirectory()) {
          return reply.code(400).send({ error: 'Path is a directory' });
        }
        if (stat.size > 1024 * 1024) {
          return reply.code(413).send({ error: 'File too large (>1MB)' });
        }
        const content = readFileSync(fullPath, 'utf-8');
        return { taskId, file: filePath, size: stat.size, content };
      } catch {
        return reply.code(404).send({ error: 'File not found' });
      }
    });

    // GET /scheduler/costs — Aggregate cost stats across all tasks
    fastify.get('/scheduler/costs', async (request: any, reply: any) => {
      const scheduler = node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const taskQueue = scheduler.getTaskQueue();
      return taskQueue.getCostStats();
    });

    // GET /scheduler/remote/:peerId/tasks — Query a remote peer's task list via P2P
    fastify.get('/scheduler/remote/:peerId/tasks', async (request: any, reply: any) => {
      const rr = node.getRequestReply();
      if (!rr) return reply.code(503).send({ error: 'Request-reply not available' });
      const { peerId } = request.params;
      const limit = parseInt(request.query?.limit) || 50;
      try {
        const result = await rr.request(peerId, 'task_list', { limit }, 10000);
        if (!result.success) return reply.code(502).send({ error: result.error || 'Remote peer returned error' });
        return result.payload;
      } catch (err: any) {
        return reply.code(504).send({ error: `Remote query failed: ${err.message}` });
      }
    });

    // GET /scheduler/remote/:peerId/tasks/:taskId — Query a specific task from a remote peer
    fastify.get('/scheduler/remote/:peerId/tasks/:taskId', async (request: any, reply: any) => {
      const rr = node.getRequestReply();
      if (!rr) return reply.code(503).send({ error: 'Request-reply not available' });
      const { peerId, taskId } = request.params;
      try {
        const result = await rr.request(peerId, 'task_detail', { taskId }, 10000);
        if (!result.success) return reply.code(502).send({ error: result.error || 'Remote peer returned error' });
        if (result.payload?.error) return reply.code(404).send({ error: result.payload.error });
        return result.payload;
      } catch (err: any) {
        return reply.code(504).send({ error: `Remote query failed: ${err.message}` });
      }
    });

    // GET /scheduler/network/tasks — Aggregate tasks from all connected peers + local
    fastify.get('/scheduler/network/tasks', async (request: any, reply: any) => {
      const rr = node.getRequestReply();
      const scheduler = node.getScheduler();
      const network = node.getNetwork();
      const identity = node.getIdentity();
      if (!network || !identity) return reply.code(503).send({ error: 'Node not ready' });
      const limit = parseInt(request.query?.limit) || 50;

      // Local tasks
      const localTasks = scheduler
        ? scheduler.getTaskQueue().getTasks().slice(0, limit).map((t: any) => ({
            id: t.id, title: t.title, status: t.status, priority: t.priority,
            createdAt: t.createdAt, cost: t.cost, executedByNode: t.executedByNode,
            sourceNode: identity.peerId, isLocal: true,
          }))
        : [];

      // Remote tasks from all connected peers
      const peers = network.getPeers();
      const remoteResults = await Promise.allSettled(
        peers.map(async (p: any) => {
          if (!rr) return [];
          try {
            const result = await rr.request(p.peerId, 'task_list', { limit }, 8000);
            if (result.success && Array.isArray(result.payload)) {
              return result.payload.map((t: any) => ({
                ...t, sourceNode: p.peerId, isLocal: false,
              }));
            }
            return [];
          } catch { return []; }
        })
      );

      const remoteTasks = remoteResults
        .filter((r): r is PromiseFulfilledResult<any[]> => r.status === 'fulfilled')
        .flatMap(r => r.value);

      // Combine and sort by creation date (newest first)
      const allTasks = [...localTasks, ...remoteTasks]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit);

      return {
        tasks: allTasks,
        sources: {
          local: identity.peerId,
          remoteCount: peers.length,
          respondedCount: remoteResults.filter(r => r.status === 'fulfilled' && r.value.length > 0).length,
        },
      };
    });

    // POST /scheduler/config — Update Scheduler config
    fastify.post('/scheduler/config', async (request: any, reply: any) => {
      const scheduler = node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const body = request.body || {};
      if (!body.pollIntervalMs && !body.maxConcurrentTasks && !body.maxTaskDepth) {
        return reply.code(400).send({ error: 'Provide at least one of: pollIntervalMs, maxConcurrentTasks, maxTaskDepth' });
      }
      scheduler.updateConfig(body);
      return { success: true, config: scheduler.getStatus().config };
    });

    // GET /scheduler/tasks/:id/stream — SSE stream of live task output
    // Works for both local tasks (via Scheduler emitters) and remote tasks (via GossipSub timeline events)
    fastify.get('/scheduler/tasks/:id/stream', (request: any, reply: any) => {
      const scheduler = node.getScheduler();
      const taskId = request.params.id;

      // Check if the task exists locally (could be a remote task synced via GossipSub)
      const taskQueue = node.getActiveTaskQueue();
      const task = taskQueue?.getTask(taskId);
      if (!scheduler && !task) {
        reply.code(503).send({ error: 'Scheduler not enabled and task not found.' });
        return;
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Send initial status
      if (scheduler) {
        const status = scheduler.getStatus();
        const active = status.activeTasks.find((at: any) => at.taskId === taskId);
        reply.raw.write(`data: ${JSON.stringify({
          type: 'status',
          taskId,
          lifecycle: active ? active.lifecycle : (task ? task.status : 'unknown'),
          timestamp: new Date().toISOString(),
        })}\n\n`);
      } else {
        reply.raw.write(`data: ${JSON.stringify({
          type: 'status',
          taskId,
          lifecycle: task ? task.status : 'unknown',
          remote: true,
          timestamp: new Date().toISOString(),
        })}\n\n`);
      }

      // Heartbeat every 5s
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          cleanup();
        }
      }, 5000);

      const onOutput = (data: any) => {
        try {
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
          cleanup();
        }
      };

      // Subscribe to scheduler's task output emitter (if scheduler is running)
      const emitter = scheduler?.getTaskEmitter(taskId) || null;
      if (emitter) {
        emitter.on('output', onOutput);
      }

      // Phase 8.3: Also subscribe to remote task emitter (for cross-node timeline events)
      const remoteEmitter = node.getOrCreateRemoteTaskEmitter(taskId);
      remoteEmitter.on('output', onOutput);

      // Also listen for late-attached scheduler emitters (task might not be running yet)
      let polledEmitter = emitter;
      const pollForEmitter = !emitter && scheduler ? setInterval(() => {
        const em = scheduler.getTaskEmitter(taskId);
        if (em && em !== polledEmitter) {
          polledEmitter = em;
          em.on('output', onOutput);
        }
      }, 1000) : null;

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        if (pollForEmitter) clearInterval(pollForEmitter);
        if (emitter) emitter.off('output', onOutput);
        if (polledEmitter && polledEmitter !== emitter) polledEmitter.off('output', onOutput);
        remoteEmitter.off('output', onOutput);
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    });

    // ── Health Monitor Routes (Phase 9) ────────────────────────────────────────

    // GET /monitor/status — Current health metrics + active alerts
    fastify.get('/monitor/status', async (request: any, reply: any) => {
      const monitor = node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled. Start node with --monitor or --scheduler flag.' });
      }
      return monitor.getCurrentMetrics();
    });

    // GET /monitor/metrics — Rolling metrics history (last 100 data points)
    fastify.get('/monitor/metrics', async (request: any, reply: any) => {
      const monitor = node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      return { metrics: monitor.getMetricsHistory() };
    });

    // GET /monitor/alerts — All alerts (active + resolved, newest first)
    fastify.get('/monitor/alerts', async (request: any, reply: any) => {
      const monitor = node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      return { alerts: monitor.getAlerts() };
    });

    // POST /monitor/alerts/:id/ack — Acknowledge an alert
    fastify.post('/monitor/alerts/:id/ack', async (request: any, reply: any) => {
      const monitor = node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      const alertId = request.params.id;
      const alert = monitor.acknowledgeAlert(alertId);
      if (!alert) {
        return reply.code(404).send({ error: 'Alert not found' });
      }
      return { success: true, alert };
    });

    // GET /monitor/config — Current monitor configuration
    fastify.get('/monitor/config', async (request: any, reply: any) => {
      const monitor = node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      return { config: monitor.getConfig(), running: monitor.isRunning() };
    });

    // POST /monitor/config — Update monitor configuration
    fastify.post('/monitor/config', async (request: any, reply: any) => {
      const monitor = node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      const body = request.body || {};
      const validKeys = ['checkIntervalMs', 'stuckPeerThresholdMs', 'failureRateThreshold', 'failureRateWindowMs', 'maxConsecutiveFailures', 'memoryUsageThreshold', 'eventLoopLagThresholdMs', 'ledgerSyncLagThresholdMs', 'spawnFailureRateThreshold', 'spawnFailureWindowMs'];
      const updates: Record<string, any> = {};
      for (const key of validKeys) {
        if (body[key] !== undefined) {
          updates[key] = body[key];
        }
      }
      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: `Provide at least one of: ${validKeys.join(', ')}` });
      }
      const config = monitor.updateConfig(updates);
      return { success: true, config };
    });

    // GET /monitor/audit — Recovery action audit trail (Phase 9.2)
    fastify.get('/monitor/audit', async (request: any, reply: any) => {
      const monitor = node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      return { audit: monitor.getAuditLog() };
    });

    // GET /monitor/recovery — Recovery action configuration (Phase 9.2)
    fastify.get('/monitor/recovery', async (request: any, reply: any) => {
      const monitor = node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      return { actions: monitor.getRecoveryActions() };
    });

    // POST /monitor/recovery — Update recovery action config (Phase 9.2)
    fastify.post('/monitor/recovery', async (request: any, reply: any) => {
      const monitor = node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      const body = request.body;
      if (!body || !Array.isArray(body.actions)) {
        return reply.code(400).send({ error: 'Provide { actions: [{ trigger, enabled?, cooldownMs?, action? }] }' });
      }
      const actions = monitor.updateRecoveryActions(body.actions);
      return { success: true, actions };
    });

    // GET /monitor/system — System-level metrics (memory, CPU, event loop lag)
    fastify.get('/monitor/system', async (request: any, reply: any) => {
      const monitor = node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      const metrics = monitor.getCurrentMetrics();
      return {
        memoryUsage: metrics.memoryUsage ?? null,
        eventLoopLagMs: metrics.eventLoopLagMs ?? 0,
        ledgerSyncLagMs: metrics.ledgerSyncLagMs ?? null,
        agentSpawnFailureRate: metrics.agentSpawnFailureRate ?? 0,
        uptimeSeconds: metrics.uptimeSeconds,
        nodeHealth: metrics.nodeHealth,
      };
    });

    // ── Guardrails Routes (Phase 9.3) ───────────────────────────────────────────

    // GET /guardrails/status — Current config + rate limit usage
    fastify.get('/guardrails/status', async (request: any, reply: any) => {
      const guardrails = node.getGuardrails();
      if (!guardrails) {
        return reply.code(503).send({ error: 'Guardrails not initialized.' });
      }
      return guardrails.getStatus();
    });

    // POST /guardrails/config — Update guardrail configuration
    fastify.post('/guardrails/config', async (request: any, reply: any) => {
      const guardrails = node.getGuardrails();
      if (!guardrails) {
        return reply.code(503).send({ error: 'Guardrails not initialized.' });
      }
      const body = request.body || {};
      const validKeys = [
        'protectedPaths', 'maxSelfChangesPerHour', 'maxSelfChangesPerDay',
        'rollbackOnBuildFailure', 'rollbackOnTestFailure',
        'requireApprovalForCore', 'approvalTimeout',
      ];
      const updates: Record<string, any> = {};
      for (const key of validKeys) {
        if (body[key] !== undefined) {
          updates[key] = body[key];
        }
      }
      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: `Provide at least one of: ${validKeys.join(', ')}` });
      }
      const config = guardrails.updateConfig(updates);
      return { success: true, config };
    });

    // GET /guardrails/pending — Changes waiting for approval
    fastify.get('/guardrails/pending', async (request: any, reply: any) => {
      const guardrails = node.getGuardrails();
      if (!guardrails) {
        return reply.code(503).send({ error: 'Guardrails not initialized.' });
      }
      return { pending: guardrails.getPending() };
    });

    // POST /guardrails/approve/:id — Approve a pending change
    fastify.post('/guardrails/approve/:id', async (request: any, reply: any) => {
      const guardrails = node.getGuardrails();
      if (!guardrails) {
        return reply.code(503).send({ error: 'Guardrails not initialized.' });
      }
      const changeId = request.params.id;
      const body = request.body || {};
      const change = guardrails.approveChange(changeId, body.reviewedBy);
      if (!change) {
        return reply.code(404).send({ error: 'Pending change not found or already reviewed.' });
      }
      return { success: true, change };
    });

    // POST /guardrails/reject/:id — Reject a pending change
    fastify.post('/guardrails/reject/:id', async (request: any, reply: any) => {
      const guardrails = node.getGuardrails();
      if (!guardrails) {
        return reply.code(503).send({ error: 'Guardrails not initialized.' });
      }
      const changeId = request.params.id;
      const body = request.body || {};
      const change = guardrails.rejectChange(changeId, body.reason, body.reviewedBy);
      if (!change) {
        return reply.code(404).send({ error: 'Pending change not found or already reviewed.' });
      }
      return { success: true, change };
    });

    // ── Request/Reply Routes (Phase 10.1) ───────────────────────────────────────

    // GET /request-reply/stats — Request/reply statistics
    fastify.get('/request-reply/stats', async (request: any, reply: any) => {
      const rr = node.getRequestReply();
      if (!rr) {
        return reply.code(503).send({ error: 'Request/reply manager not initialized.' });
      }
      return rr.getStats();
    });

    // GET /request-reply/handlers — List registered handler types
    fastify.get('/request-reply/handlers', async (request: any, reply: any) => {
      const rr = node.getRequestReply();
      if (!rr) {
        return reply.code(503).send({ error: 'Request/reply manager not initialized.' });
      }
      return { handlers: rr.getHandlerTypes() };
    });

    // POST /request-reply/send — Send a request and return the reply
    fastify.post('/request-reply/send', async (request: any, reply: any) => {
      const rr = node.getRequestReply();
      if (!rr) {
        return reply.code(503).send({ error: 'Request/reply manager not initialized.' });
      }
      const { to, type, payload, timeout } = request.body || {};
      if (!to || typeof to !== 'string') {
        return reply.code(400).send({ error: '"to" (peer ID) is required' });
      }
      if (!type || typeof type !== 'string') {
        return reply.code(400).send({ error: '"type" (request type) is required' });
      }
      const timeoutMs = typeof timeout === 'number' && timeout > 0
        ? Math.min(timeout, 120_000)
        : undefined;

      try {
        const result = await rr.request(to, type, payload ?? {}, timeoutMs);
        return { success: true, reply: result };
      } catch (err: any) {
        const msg = err.message || 'Request failed';
        if (msg.includes('Rate limited')) {
          return reply.code(429).send({ error: msg });
        }
        if (msg.includes('timed out')) {
          return reply.code(504).send({ error: msg });
        }
        return reply.code(500).send({ error: msg });
      }
    });

    // ── Reputation Routes (Phase 10.3) ────────────────────────────────────────

    // GET /reputation — Local node's reputation
    fastify.get('/reputation', async (request: any, reply: any) => {
      const rm = node.getReputationManager();
      if (!rm) {
        return reply.code(503).send({ error: 'Reputation manager not initialized.' });
      }
      return rm.getLocalReputation();
    });

    // GET /reputation/peers — All known reputations ranked (highest first)
    fastify.get('/reputation/peers', async (request: any, reply: any) => {
      const rm = node.getReputationManager();
      if (!rm) {
        return reply.code(503).send({ error: 'Reputation manager not initialized.' });
      }
      return { reputations: rm.getRankedNodes() };
    });

    // GET /reputation/:nodeId — Specific node's reputation
    fastify.get('/reputation/:nodeId', async (request: any, reply: any) => {
      const rm = node.getReputationManager();
      if (!rm) {
        return reply.code(503).send({ error: 'Reputation manager not initialized.' });
      }
      const nodeId = request.params.nodeId;
      const record = rm.getReputation(nodeId);
      if (!record) {
        return reply.code(404).send({ error: 'No reputation record found for this node.' });
      }
      return record;
    });

  // ── v2.5: Local Environment Routes (Envelope 1 — never P2P synced) ─────────

  // GET /local/status — indexed dirs, file count, paths
  fastify.get('/local/status', async (_request: any, reply: any) => {
    const le = node.getLocalEnv();
    if (!le) return reply.code(503).send({ error: 'Local environment not initialized' });
    return le.getStatus();
  });

  // POST /local/index — grant a directory for indexing
  fastify.post('/local/index', async (request: any, reply: any) => {
    const le = node.getLocalEnv();
    if (!le) return reply.code(503).send({ error: 'Local environment not initialized' });
    const { path: dirPath } = request.body as { path?: string };
    if (!dirPath) return reply.code(400).send({ error: 'path required' });
    try {
      const result = await le.grantDirectory(dirPath);
      return { success: true, ...result };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // DELETE /local/index — revoke a directory
  fastify.delete('/local/index', async (request: any, reply: any) => {
    const le = node.getLocalEnv();
    if (!le) return reply.code(503).send({ error: 'Local environment not initialized' });
    const { path: dirPath } = request.body as { path?: string };
    if (!dirPath) return reply.code(400).send({ error: 'path required' });
    le.revokeDirectory(dirPath);
    return { success: true };
  });

  // GET /local/search — full-text search over indexed files
  fastify.get('/local/search', async (request: any, reply: any) => {
    const le = node.getLocalEnv();
    if (!le) return reply.code(503).send({ error: 'Local environment not initialized' });
    const { q, limit } = request.query as { q?: string; limit?: string };
    if (!q) return reply.code(400).send({ error: 'q required' });
    const results = le.search(q, limit ? parseInt(limit) : 10);
    return { results, query: q };
  });

  // GET /local/file — read file content (protected paths blocked)
  fastify.get('/local/file', async (request: any, reply: any) => {
    const le = node.getLocalEnv();
    if (!le) return reply.code(503).send({ error: 'Local environment not initialized' });
    const { path: filePath } = request.query as { path?: string };
    if (!filePath) return reply.code(400).send({ error: 'path required' });
    try {
      const content = le.readFile(filePath);
      return { path: filePath, content };
    } catch (err: any) {
      return reply.code(403).send({ error: err.message });
    }
  });

  // GET /local/memory — get full user memory context
  fastify.get('/local/memory', async (_request: any, reply: any) => {
    const le = node.getLocalEnv();
    if (!le) return reply.code(503).send({ error: 'Local environment not initialized' });
    const memory = le.getMemory();
    return { memory, hasMemory: memory !== null };
  });

  // POST /local/memory — append a memory entry
  fastify.post('/local/memory', async (request: any, reply: any) => {
    const le = node.getLocalEnv();
    if (!le) return reply.code(503).send({ error: 'Local environment not initialized' });
    const entry = request.body as any;
    if (!entry?.key || !entry?.value || !entry?.type) {
      return reply.code(400).send({ error: 'type, key, value required' });
    }
    try {
      le.appendMemory(entry);
      return { success: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // GET /local/memory/file — get specific memory file
  fastify.get('/local/memory/file', async (request: any, reply: any) => {
    const le = node.getLocalEnv();
    if (!le) return reply.code(503).send({ error: 'Local environment not initialized' });
    const { f } = request.query as { f?: string };
    if (!f) return reply.code(400).send({ error: 'f (filename) required' });
    const content = le.getMemoryFile(f);
    if (content === null) return reply.code(404).send({ error: 'Memory file not found' });
    return { filename: f, content };
  });

  // ── Ledger Explorer (Phase Ledger-Explorer) ─────────────────────────────

  // GET /ledger/accounts — top N accounts sorted by balance (public)
  fastify.get('/ledger/accounts', async (request: any, reply: any) => {
    const ledger = node.getLedger();
    if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });
    const limit = Math.min(parseInt((request.query as any).limit || '50', 10), 200);
    const accounts = ledger.accounts.getTopAccounts(limit);
    const stats = ledger.getNetworkStats();
    return {
      accounts: accounts.map((a: any) => ({
        peerId: a.peerId,
        balance: a.balance,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      })),
      totalAccounts: stats.totalAccounts,
      totalSupply: stats.totalSupply,
    };
  });

  // GET /ledger/transactions — most recent N transactions (public)
  fastify.get('/ledger/transactions', async (request: any, reply: any) => {
    const ledger = node.getLedger();
    if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });
    const limit = Math.min(parseInt((request.query as any).limit || '50', 10), 200);
    // Use timestamp=0 to get all, then slice to limit (most recent)
    const txs = ledger.transactions.getTransactionsSince(0, limit * 2);
    // Sort desc by timestamp and take limit
    const sorted = txs.sort((a: any, b: any) => b.timestamp - a.timestamp).slice(0, limit);
    const count = ledger.transactions.getTransactionCount();
    return {
      transactions: sorted.map((t: any) => ({
        id: t.id,
        from: t.from,
        to: t.to,
        amount: t.amount,
        fee: t.fee,
        type: t.type,
        timestamp: t.timestamp,
      })),
      total: count,
    };
  });

}
