import { WorkType, MessageType } from '@pando/shared';
import { debug, isDebug } from './logger.js';
import { ResourceRouter } from './platform/resource-router.js';
import { ResourceMeter } from './platform/resource-meter.js';
import { ResourceMarketplace } from './platform/resource-marketplace.js';
import { RegressionSuite } from './platform/regression-suite.js';
import { PaymentGate } from './core/payment-gate.js';
import { UserAccountStore } from './platform/user-accounts.js';
import { ProjectStore } from './platform/project-store.js';
import { RevenueEngine } from './platform/revenue-engine.js';
import { ContributionTracker } from './platform/contribution-tracker.js';
import { ContentRegistry } from './platform/content-registry.js';
import { ContentPublisher } from './platform/content-publish.js';
import { ContentMaintenance } from './platform/content-maintenance.js';
import { ThreadStore } from './platform/thread-store.js';
import { CloudInstanceManager } from './core/cloud-instance-manager.js';
import { NetworkState } from './kernel/network-state.js';
import { LocalEnvironment } from './kernel/local-environment.js';
import { ApiServer } from './api/api-server.js';
import { GitOps } from './core/git-ops.js';
import { TeamRegistry } from './core/team-registry.js';
import { ServiceLoader } from './core/service-loader.js';
import { PANDO_INFRA_AGENTS } from './core/engine-adapter.js';
import type { CredentialStore } from './core/credential-store.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { multiaddr as ma } from '@multiformats/multiaddr';

const DEFAULT_MANAGER_ID = 'pando-node-mgr';

export async function initPlatform(node: any): Promise<void> {
    const dataDir = node.config.dataDir || join(homedir(), '.pando');

    // Phase B: Initialize ResourceRouter — smart task routing + error correction
    node.resourceRouter = new ResourceRouter(node.capabilityRegistry, node.requestReply, node.httpPeerClient);
    if (node.reputation) {
      node.resourceRouter.setReputationManager(node.reputation);
    }

    // Register task_forward handler so remote nodes can receive forwarded tasks
    node.requestReply.registerHandler('task_forward', async (req: any) => {
      const taskData = req.payload?.task;
      if (!taskData || !taskData.title) {
        return { error: 'Invalid task data' };
      }
      const tq = node.getActiveTaskQueue();
      if (!tq) {
        return { error: 'No task queue available' };
      }
      // Insert the forwarded task into local queue
      const task = tq.createTask({
        title: taskData.title,
        description: taskData.description || '',
        priority: taskData.priority || 'medium',
        createdBy: taskData.createdBy || req.from,
        managerId: taskData.managerId,
        requiredCapabilities: taskData.requiredCapabilities || (taskData as any).requiredResources,
      });
      console.log(`[resource-router] Received forwarded task ${task.id.slice(0, 8)}: ${task.title}`);
      return { taskId: task.id, accepted: true };
    });

    // Phase 69 (follow-up): P2P credential proxy handler — EC2 nodes decrypt code_repository credentials
    // for non-secure nodes that lack CREDENTIAL_MASTER_KEY. Only code_repository type is allowed.
    node.requestReply.registerHandler('pando/get-credential', async (req: any) => {
      const { resourceId, type } = req.payload || {};
      if (!resourceId) return { error: 'Missing resourceId' };
      // Security: only proxy code_repository credentials (GitHub PAT). S3/MongoDB MUST stay on EC2.
      if (type !== 'code_repository') return { error: 'Credential type not proxyable' };
      const credStore = (node as any)._credentialStore as import('./core/credential-store.js').CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) return { error: 'This node cannot decrypt credentials' };
      const credential = await credStore.getCredential(resourceId);
      if (!credential) return { error: 'Credential not found or decryption failed' };
      return { credential };
    });

    // Phase 67: Register pando/upgrade-node handler — compute instances can be upgraded via P2P
    node.requestReply.registerHandler('pando/upgrade-node', async (req: any) => {
      if (node.restartPending || node.upgradeInProgress) {
        return { status: 'already_in_progress' };
      }
      node.upgradeInProgress = true;
      try {
        const { execSync } = await import('node:child_process');
        const repoDir = process.cwd();
        const git = new GitOps(repoDir);

        // Ensure git safe.directory (compute instances: repo cloned by root, node runs as 'pando')
        git.addSafeDirectory();

        // Fetch + reset to origin/master (handles orphan-branch force pushes)
        git.fetch('origin', 'master');
        const localSha = git.getCurrentCommit();
        const remoteSha = git.getRemoteCommit('origin', 'master');

        if (localSha === remoteSha) {
          node.upgradeInProgress = false;
          console.log('[upgrade-node] Already up to date');
          return { status: 'already_up_to_date', output: 'Already up to date.' };
        }

        git.stashAndReset('origin/master');
        const pullOutput = `Updated ${localSha.slice(0, 8)} -> ${remoteSha.slice(0, 8)}`;
        console.log(`[upgrade-node] ${pullOutput}`);

        // Build
        console.log('[upgrade-node] Building...');
        execSync('npm run build', {
          cwd: repoDir, encoding: 'utf-8', timeout: 300_000, stdio: 'pipe',
        });
        console.log('[upgrade-node] Build complete. Scheduling restart...');

        // Schedule graceful restart (exit code 75 → launcher restarts)
        node.requestGracefulRestart('P2P upgrade request');
        return { status: 'restart_pending', output: pullOutput };
      } catch (err: any) {
        node.upgradeInProgress = false;
        console.error(`[upgrade-node] Failed: ${err.message}`);
        return { status: 'failed', error: err.message };
      }
    });

    // Phase 69: Register pando/ai-query handler — compute nodes serve AI queries for untrusted nodes
    node.requestReply.registerHandler('pando/ai-query', async (req: any) => {
      const credStore = (node as any)._credentialStore as CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) {
        return { error: 'Not a credential node' };
      }
      const { query } = req.payload || {};
      if (!query || typeof query !== 'string') return { error: 'Missing query' };

      const aiKey = await credStore.getActiveByType('ai_api_key');
      if (!aiKey) return { error: 'No AI keys available' };

      const result = aiKey.metadata?.provider === 'openai'
        ? await node.searchOpenAI(query, aiKey.credential, aiKey.metadata?.model || 'gpt-4o-mini')
        : await node.searchGemini(query, aiKey.credential, aiKey.metadata?.model || 'gemini-pro');
      if (result) {
        node.resourceMeter?.recordUsage(aiKey.resourceId, 'api_keys', {
          resourceType: 'api_keys', quantity: 1, unit: 'calls', timestamp: Date.now(),
        });
        // Reward contributor for API compute
        if (node.identity && node.ledger) {
          try { node.ledger.rewardWork(node.identity.peerId, WorkType.API_CONTRIBUTED, `ai-query:${req.from?.slice(0, 12)}`); } catch {}
        }
        return { answer: result.answer, sources: result.sources, confidence: result.confidence };
      }
      return { error: 'AI query failed' };
    });

    // P2P doorman proxy: EC2 nodes classify/answer chat messages using contributed OpenAI keys.
    // Non-EC2 nodes (Windows contributors) route here when they have no local OpenAI key.
    node.requestReply.registerHandler('pando/doorman-classify', async (req: any) => {
      const credStore = (node as any)._credentialStore as CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) {
        return { error: 'Not a credential node' };
      }
      const { message } = req.payload || {};
      if (!message || typeof message !== 'string') return { error: 'Missing message' };

      const aiKey = await credStore.getActiveByType('ai_api_key');
      if (!aiKey || aiKey.metadata?.provider !== 'openai') return { error: 'No OpenAI key' };

      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${aiKey.credential}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `You are the doorman for Pando, an AI-powered network that builds software projects.
Classify the user's message into ONE of these categories and respond with ONLY valid JSON:

1. "question" — general question, small talk, greeting, asking about Pando. You answer it directly.
2. "build" — user wants to BUILD something (app, website, tool, game, etc). Extract a short description.

JSON format:
For questions: {"intent":"question","response":"<your friendly answer, 1-3 sentences>"}
For builds: {"intent":"build","description":"<what they want built, 1 sentence>","tier":<1 or 2>}

Tier rules:
- Tier 1: Pure static apps (portfolio, landing page, simple form with no backend). HTML/CSS/JS only, no server.
- Tier 2: Anything that needs a server (chat, real-time, backend, database, auth, etc). When in doubt, Tier 2.

Be friendly and helpful. Keep answers short.`
              },
              { role: 'user', content: message },
            ],
            max_tokens: 256,
            temperature: 0.3,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const content = data?.choices?.[0]?.message?.content?.trim();
          if (content) {
            const cleaned = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
            const parsed = JSON.parse(cleaned);
            node.resourceMeter?.recordUsage(aiKey.resourceId, 'api_keys', {
              resourceType: 'api_keys', quantity: 1, unit: 'calls', timestamp: Date.now(),
            });
            return parsed;
          }
        }
      } catch (err: any) {
        console.log(`[doorman-proxy] Classification failed: ${err.message?.slice(0, 100)}`);
      }
      return { error: 'Classification failed' };
    });

    node.requestReply.registerHandler('pando/doorman-chat', async (req: any) => {
      const credStore = (node as any)._credentialStore as CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) {
        return { error: 'Not a credential node' };
      }
      const { message, history } = req.payload || {};
      if (!message || typeof message !== 'string') return { error: 'Missing message' };

      const aiKey = await credStore.getActiveByType('ai_api_key');
      if (!aiKey || aiKey.metadata?.provider !== 'openai') return { error: 'No OpenAI key' };

      try {
        const messages = [
          { role: 'system', content: 'You are a helpful AI assistant on the Pando network. Answer questions clearly and concisely.' },
          ...(Array.isArray(history) ? history.slice(-10) : []),
          { role: 'user', content: message },
        ];
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${aiKey.credential}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 512, temperature: 0.7 }),
          signal: AbortSignal.timeout(12000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const reply = data?.choices?.[0]?.message?.content?.trim();
          if (reply) {
            node.resourceMeter?.recordUsage(aiKey.resourceId, 'api_keys', {
              resourceType: 'api_keys', quantity: 1, unit: 'calls', timestamp: Date.now(),
            });
            return { reply };
          }
        }
      } catch (err: any) {
        console.log(`[doorman-proxy] Chat failed: ${err.message?.slice(0, 100)}`);
      }
      return { error: 'Chat failed' };
    });

    // Phase 83: Register pando/storage-proxy handler on compute nodes
    // Untrusted nodes proxy StorageBackend CRUD operations here
    node.requestReply.registerHandler('pando/storage-proxy', async (req: any) => {
      // Only serve if we have direct MongoDB (compute node)
      if (!node.storageBackend || typeof (node.storageBackend as any).getDb !== 'function') {
        return { error: 'Not a storage node' };
      }
      const { method, args } = req.payload || {};

      // Method allowlist — only StorageBackend CRUD methods
      const ALLOWED_METHODS = ['putRecord', 'getRecord', 'queryRecords', 'deleteRecord', 'listRecords', 'pushToArray'];
      if (!method || !ALLOWED_METHODS.includes(method)) {
        return { error: `Method not allowed: ${method}` };
      }

      // Collection blocklist — never proxy credential operations
      const collection = args?.collection;
      if (collection === 'pando_credentials') {
        return { error: 'Access denied: credential collection' };
      }

      try {
        const backend = node.storageBackend as any;
        let result: any;
        switch (method) {
          case 'putRecord':
            await backend.putRecord(args.collection, args.key, args.data);
            result = undefined;
            break;
          case 'getRecord':
            result = await backend.getRecord(args.collection, args.key);
            break;
          case 'queryRecords':
            result = await backend.queryRecords(args.collection, args.filter, args.options);
            break;
          case 'deleteRecord':
            await backend.deleteRecord(args.collection, args.key);
            result = undefined;
            break;
          case 'listRecords':
            result = await backend.listRecords(args.collection, args.filter);
            break;
          case 'pushToArray':
            await backend.pushToArray(args.collection, args.key, args.field, args.value);
            result = undefined;
            break;
        }
        // Phase 83: After proxy writes, refresh local caches (fire-and-forget)
        const isWrite = ['putRecord', 'deleteRecord', 'pushToArray'].includes(method);
        if (isWrite && collection) {
          if ((collection === 'threads' || collection === 'thread_messages') && node.threadStore) {
            node.threadStore.loadFromBackend().catch(() => {});
          }
        }

        return { result };
      } catch (err) {
        return { error: `Storage proxy error: ${(err as Error).message}` };
      }
    });

    // Phase C: Initialize ResourceMeter — resource usage metering
    node.resourceMeter = new ResourceMeter(dataDir);
    node.resourceMeter.startMeteringLoop(60_000); // prune + save every 60s

    // Phase D: Initialize ResourceMarketplace — marketplace pricing
    node.resourceMarketplace = new ResourceMarketplace(node.capabilityRegistry);
    node.resourceMarketplace.setNetwork(node.network);
    node.resourceMarketplace.setLocalPeerId(node.identity.peerId);

    // Subscribe to pando/marketplace GossipSub topic for peer price broadcasts
    await node.resourceMarketplace.subscribeMarketplaceTopic();

    // Also handle legacy price broadcasts via capabilities topic (Phase D backward compat)
    node.network.onPriceBroadcast((priceList: any, fromPeerId: any) => {
      node.resourceMarketplace?.handlePriceBroadcast(fromPeerId, priceList);
    });

    // Broadcast initial prices
    try {
      await node.resourceMarketplace.broadcastPrices();
    } catch {}

    console.log('[resources] ResourceRouter + ResourceMeter + ResourceMarketplace initialized');

    // Phase 17.6: Regression Suite — persistent, auto-growing test suite
    node.regressionSuite = new RegressionSuite({
      dataDir,
      apiBaseUrl: `http://127.0.0.1:${node.config.apiPort}`,
    });
    console.log(`[regression] Suite loaded: ${node.regressionSuite.getStats().total} tests`);

    // Phase 18.6: Payment Gate — Lux escrow for task execution
    node.paymentGate = new PaymentGate(node.ledger, dataDir);
    console.log('[payment-gate] Initialized');

    // Unified identity system — Ed25519 keypairs, guest auto-creation, claim flow
    // Phase 56: Auth data lives in P2P-synced ledger, local keys in auth-local.db
    // Phase 86: Sessions removed — auth is stateless JWT issued by api-server
    node.userAccountStore = new UserAccountStore(node.ledger, dataDir);
    // Phase 35: Daily guest Lux reclamation — unclaimed guests older than 30 days
    // get remaining Lux transferred back to NETWORK for reuse
    const ledgerForReclaim = node.ledger;
    // #69: Store interval ref so stop() can clear it before nulling subsystems
    node._guestReclaimTimer = setInterval(() => {
      if (node.userAccountStore && ledgerForReclaim) {
        node.userAccountStore.reclaimExpiredGuests(ledgerForReclaim);
      }
    }, 24 * 60 * 60 * 1000); // Run daily
    // Also run once on startup (catches guests that expired while node was offline)
    setTimeout(() => {
      if (node.userAccountStore && ledgerForReclaim) {
        node.userAccountStore.reclaimExpiredGuests(ledgerForReclaim);
      }
    }, 60_000); // 1 minute after boot
    console.log('[user-accounts] Initialized (with guest Lux reclamation)');

    // Phase 57: User data stores require StorageBackend (MongoDB). Skip if no backend configured.
    if (node.storageBackend) {
      node.projectStore = new ProjectStore(node.ledger.getDatabase(), node.storageBackend);
      node.projectStore.init();

      // #48: Cancel running tasks when a project is archived
      node.projectStore.setTaskCanceller((projectId: string) => {
        const tq = node.getActiveTaskQueue();
        if (!tq) return;
        const tasks = tq.getTasks({ status: ['open', 'claimed', 'in_progress'] as any });
        for (const task of tasks) {
          if (task.projectId === projectId) {
            tq.updateStatus(task.id, 'rejected');
            tq.setResultNote(task.id, `Cancelled: project ${projectId} was archived`);
            console.log(`[project-store] Cancelled task ${task.id.slice(0, 8)} (project archived)`);
          }
        }
      });

      node.revenueEngine = new RevenueEngine(node.ledger.getDatabase(), node.ledger, node.storageBackend);
      node.revenueEngine.init();

      node.contributionTracker = new ContributionTracker(node.ledger.getDatabase(), node.storageBackend);
      node.contributionTracker.init();
    }

    // Phase 11: Content Layer — persistent hosting & delivery registry
    node.contentRegistry = new ContentRegistry(node.ledger.getDatabase());
    node.contentRegistry.setLocalPeerId(node.identity.peerId);
    if (node.network) {
      node.contentRegistry.setNetwork(node.network);
      await node.contentRegistry.subscribeContentTopic();
    }
    node.contentPublisher = new ContentPublisher(node.contentRegistry);
    node.contentPublisher.setLocalPeerId(node.identity.peerId);
    node.contentMaintenance = new ContentMaintenance(node.contentRegistry);
    node.contentMaintenance.setLocalPeerId(node.identity.peerId);
    // Wire task creation into the scheduler task queue
    const tq = node.getActiveTaskQueue();
    if (tq) {
      node.contentMaintenance.setTaskCreator((title: string, description: string, priority: string) => {
        tq.createTask({
          title,
          description,
          priority: priority as any,
          createdBy: 'content-maintenance',
        });
      });
    }
    node.contentMaintenance.startMaintenanceLoop();
    console.log('[content-layer] ContentRegistry, ContentPublisher, ContentMaintenance initialized');

    // Phase 57: ThreadStore + data loading — only with StorageBackend
    // IMPORTANT: Data loading is non-blocking so API starts fast. P2P storage timeouts
    // (15s each) would otherwise block API startup for minutes on slow networks.
    if (node.storageBackend) {
      node.threadStore = new ThreadStore(node.storageBackend);
      // Fire and forget — data loads in background, retries via deferred loading on peer connect
      (async () => {
        try {
          await node.threadStore!.loadFromBackend();
          if (node.projectStore) await node.projectStore.loadFromBackend();
          if (node.revenueEngine) await (node.revenueEngine as any).loadFromBackend();
          if (node.contributionTracker) await (node.contributionTracker as any).loadFromBackend();
          node._p2pDataLoaded = true;
          console.log('[data] User data stores initialized (storage-backed)');
        } catch (err: any) {
          // Phase 83: P2PStorageBackend may fail if no compute peers yet — non-fatal
          // Will retry via deferred loading when first peer connects
          console.warn(`[data] Backend load failed (will retry when peers connect): ${err.message}`);
        }
      })();
    } else {
      console.log('[data] No StorageBackend — user data features disabled (P2P features still work)');
    }

    // Phase 63: Wire ProjectStore → ProjectRegistry bridge + seed existing projects
    if (node.projectStore && node.projectRegistry) {
      const pr = node.projectRegistry;
      const peerId = node.identity.peerId;
      const username = node.linkedUser?.username;

      // Write-through: when MongoDB writes happen, broadcast to P2P
      node.projectStore.setBroadcastCallback((action: string, project: any) => {
        const resourceIds = (project.resources || []).map((r: any) => r.resourceId);
        const currentUsername = node.linkedUser?.username || username;

        if (action === 'register' && project.apiKey) {
          pr.registerProject(
            project.id, project.name, peerId, project.apiKey, project.visibility,
            resourceIds, currentUsername, project.deploymentUrl, project.deploymentType, project.description
          );
        } else if (action === 'update') {
          // If the project has an API key but isn't in the P2P registry yet,
          // register it instead of updating (fixes generateApiKey() not reaching P2P)
          if (project.apiKey && !pr.getProject(project.id)) {
            pr.registerProject(
              project.id, project.name, peerId, project.apiKey, project.visibility,
              resourceIds, currentUsername, project.deploymentUrl, project.deploymentType, project.description
            );
          } else {
            pr.updateProject(project.id, {
              name: project.name,
              visibility: project.visibility,
              resourceIds,
              status: project.status,
              deploymentUrl: project.deploymentUrl,
              deploymentType: project.deploymentType,
              description: project.description,
            });
          }
        } else if (action === 'archive') {
          pr.archiveProject(project.id);
        }
      });

      // Seed: push existing projects from SQLite cache into P2P registry
      try {
        const existing = node.projectStore.listProjects();
        let seeded = 0;
        for (const p of existing) {
          if (p.apiKey && !pr.getProject(p.id)) {
            pr.registerProject(
              p.id, p.name, peerId, p.apiKey, p.visibility,
              (p.resources || []).map((r: any) => r.resourceId),
              username, p.deploymentUrl, p.deploymentType, p.description
            );
            seeded++;
          }
        }
        if (seeded > 0) console.log(`[project-registry] Seeded ${seeded} existing projects to P2P`);
      } catch (err) {
        console.log(`[project-registry] Seed from ProjectStore skipped: ${(err as Error).message}`);
      }
    }

    // Phase 32: S3 hosting is now handled by AppManager (Tier 1 deploy)

    // Phase 64: Cloud Instance Manager — EC2 compute node lifecycle
    node.cloudInstanceManager = new CloudInstanceManager(node);
    node.cloudInstanceManager.init().catch((err: any) =>
      console.warn(`[cloud-instances] Init failed (non-fatal): ${err.message}`));

    // Phase 50: Network State Aggregator — hourly snapshot for team lead reflection
    node.networkState = new NetworkState(node, dataDir);
    node.networkState.start();
    console.log('[network-state] Aggregator started (hourly snapshots)');

    // Teams managed by EngineAdapter — initialized in startEngine() + team bootstrap

    // v2.5: Local Environment — Envelope 1 file index + user memory (always on, no network)
    try {
      node.localEnv = new LocalEnvironment(dataDir);
      console.log(`[local-env] Initialized (${node.localEnv.getStatus().grantedDirs.length} dirs indexed)`);
    } catch (err: any) {
      console.warn(`[local-env] Init failed (non-fatal): ${err.message}`);
    }

    // Start HTTP API
    node.apiServer = new ApiServer(node);
    // Windows: '::' hangs on some systems, use '0.0.0.0' directly. Linux: '::' for dual-stack.
    const apiHost = process.platform === 'win32' ? '0.0.0.0' : '::';
    await node.apiServer.start({ port: node.config.apiPort, host: apiHost });

    // Wire SSE real-time event push — transactions and governance events
    node.sync.onTransaction((tx: any) => {
      node.apiServer?.pushEvent('transaction', {
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        type: tx.type,
        timestamp: tx.timestamp,
      });

      // Auto-snapshot: check if we've crossed the snapshot interval
      node.checkAutoSnapshot();
    });
    node.governance.onVote((vote: any, proposalTitle: any) => {
      node.apiServer?.pushEvent('vote', {
        proposalId: vote.proposalId,
        proposalTitle,
        voter: vote.voter,
        choice: vote.choice,
        timestamp: vote.createdAt,
      });
    });
    node.governance.onComment((comment: any) => {
      node.apiServer?.pushEvent('comment', {
        id: comment.id,
        proposalId: comment.proposalId,
        from: comment.from,
        content: comment.content.slice(0, 200),
        timestamp: comment.createdAt,
      });
    });
    node.governance.onDecision((decision: any, proposalTitle: any) => {
      node.apiServer?.pushEvent('decision', {
        proposalId: decision.proposalId,
        proposalTitle,
        outcome: decision.outcome,
        votesFor: decision.votesFor,
        votesAgainst: decision.votesAgainst,
        timestamp: decision.decidedAt,
      });

      // Phase 15.2: Governance → Task Pipeline
      // When a proposal passes, auto-create a scheduler task and approve it
      if (decision.outcome === 'passed') {
        const proposal = node.governance?.getProposal(decision.proposalId);
        const tq = node.getActiveTaskQueue();
        let createdTaskId: string | null = null;
        if (proposal && tq) {
          const taskTitle = proposal.title;
          const taskDesc = proposal.description + `\n\n[Auto-created from approved governance proposal ${decision.proposalId.slice(0, 8)}]`;
          const task = tq.createTask({
            title: taskTitle,
            description: taskDesc,
            priority: 'high',
            createdBy: proposal.proposedBy,
            proposalId: decision.proposalId,
          });
          createdTaskId = task.id;
          console.log(`[governance→scheduler] Proposal "${taskTitle}" approved → task created (${task.id.slice(0, 8)})`);

          // Auto-approve the task so the scheduler picks it up
          try {
            if (node.scheduler) {
              node.scheduler.receiveApprovedTask(task.id, DEFAULT_MANAGER_ID);
              console.log(`[governance→scheduler] Task ${task.id.slice(0, 8)} auto-approved`);
            }
          } catch (err: any) {
            console.error(`[governance→scheduler] Failed to auto-approve task: ${err.message}`);
          }
        }

        // Governance decisions are now handled by EngineAdapter — no MessageBus routing needed.
      }
    });
    // Wire activity sync — push remote activity events to SSE
    node.sync.onActivity((record: any) => {
      node.apiServer?.pushEvent('activity', {
        id: record.id,
        agentId: record.agentId,
        action: record.action,
        summary: record.summary,
        timestamp: record.timestamp,
      });
    });

    console.log('');
    console.log('Discovering peers...');

    // Epoch-based uptime tracking (every 10 minutes)
    node.uptimeTimer = setInterval(() => {
      node.recordUptimeEpoch();
    }, 10 * 60 * 1000);

    // Peer connection handler — register unknown peers and trigger sync
    node.network.onPeerConnect((peerId: any) => {
      if (!node.ledger!.accounts.exists(peerId)) {
        node.ledger!.registerNode(peerId, 'remote-peer');
      }

      // Record peer join for Sybil detection
      node.securityMonitor?.recordPeerJoin(peerId);

      // Request governance catch-up sync from the new peer (3s delay for protocol setup)
      if (node.governance) {
        setTimeout(() => {
          node.governance?.requestSync(peerId).catch(() => {});
        }, 3000);
      }

      // Request task catch-up sync from the new peer (2s delay for protocol setup)
      setTimeout(() => {
        node.getActiveTaskQueue()?.requestSync(peerId).catch(() => {});
      }, 2000);

    });

    // Start EngineAdapter — connects to @pando-teams/core brain.
    // 'secure' and 'lightweight' modes skip engines (cloud instances don't have PandoTeams).
    if (node.config.nodeMode !== 'compute' && node.config.nodeMode !== 'relay'
      && node.config.nodeMode !== 'secure' && node.config.nodeMode !== 'lightweight') {
      await node.startEngine();
    } else {
      console.log(`[node] Mode '${node.config.nodeMode}' — engine skipped.`);
    }

    // ── Service Loader ─────────────────────────────────────────────────
    // Initialize the modular service loader. Currently loads @pando-teams/core
    // if installed as an npm package (future: @pando/exchange, @pando/storage).
    // This runs AFTER startEngine() during the transition period — eventually
    // ServiceLoader will replace startEngine() entirely.
    try {
      let token: string | undefined;
      try {
        const tokenPath = join(dataDir, 'api-token');
        if ((await import('node:fs')).existsSync(tokenPath)) {
          token = readFileSync(tokenPath, 'utf-8').trim();
        }
      } catch { /* no token */ }

      const serviceLoader = new ServiceLoader({
        peerId: node.identity?.peerId || '',
        dataDir,
        apiPort: node.config.apiPort,
        apiToken: token,
        registerRoutes: (prefix: string, router: any) => {
          // Future: wire to Fastify server for service-specific routes
          console.log(`[services] Route registration requested: ${prefix}`);
        },
        getCapability: (name: string) => serviceLoader.getCapability(name),
        resourceRegistry: node.getResourceRegistry?.() ?? undefined,
        projectResolver: async (projectId: string) => {
          const ps = node.getProjectStore?.();
          if (!ps) return null;
          const project = await ps.getProjectAsync(projectId);
          if (!project) return null;
          return { repoUrl: project.repoUrl || project.githubRepo || undefined, name: project.name };
        },
      });
      (node as any).serviceLoader = serviceLoader;
      // If the engine adapter is already running, skip loadAll() to avoid double-loading
      // @pando-teams/core. Otherwise, call loadAll() as a fallback discovery mechanism
      // so future services that aren't @pando-teams/core always load through ServiceLoader.
      if (node.getEngineAdapter?.()?.available) {
        // Engine started directly — register it in ServiceLoader so /v1/services reports it
        const { createEngineService } = await import('./core/engine-adapter.js');
        serviceLoader.register(createEngineService(node.getEngineAdapter()));
        console.log('[services] ServiceLoader initialized — engine registered as pando-teams service.');
      } else {
        console.log('[services] ServiceLoader initialized — no engine, calling loadAll() for service discovery.');
        await serviceLoader.loadAll();
      }
    } catch (err: any) {
      console.warn(`[services] ServiceLoader init failed (non-fatal): ${err.message}`);
    }

    // ── Team Registry + Bootstrap ──────────────────────────────────────
    // Initialize the TeamRegistry (SQLite + GossipSub sync) and auto-bootstrap
    // the pando-infra team if the EngineAdapter is available.
    // Skip team bootstrap if explicitly disabled
    if (node.config.enableTeams === false) {
      console.log('[team-registry] Team bootstrap disabled (enableTeams=false) — skipping');
    } else
    try {
      const teamsDbPath = join(dataDir, 'teams', 'teams.db');
      const teamRegistry = new TeamRegistry(teamsDbPath, node.network, node.identity.peerId);
      (node as any)._teamRegistry = teamRegistry;

      // Subscribe to GossipSub team topic + wire peer sync
      teamRegistry.start();

      // Start orphan scan — fast in dev mode (≤8 peers: 30s scan, 2 min threshold)
      const peerCount = node.network?.getPeers?.()?.length ?? 0;
      if (peerCount <= 8) {
        teamRegistry.startOrphanScanDevMode();
      } else {
        teamRegistry.startOrphanScan();
      }

      // Orphan detection callback: auto-claim + start orphaned teams
      teamRegistry.onOrphanDetected = (team) => {
        const adapter = node.getEngineAdapter?.();
        if (!adapter?.available) return;
        console.log(`[team-registry] Auto-claiming orphaned team: ${team.id}`);
        const claimed = teamRegistry.claimTeam(team.id);
        if (claimed) {
          // Request board state from peers before starting team agents
          // so restoreBoardState() in startTeam() can find the snapshot
          console.log(`[board-sync] Requesting board state for claimed team: ${team.id}`);
          node.network.broadcast({
            type: MessageType.BOARD_STATE_REQUEST,
            from: node.identity.peerId,
            timestamp: Date.now(),
            payload: { teamId: team.id },
          }).catch((err: any) =>
            console.warn(`[board-sync] Failed to broadcast BOARD_STATE_REQUEST: ${err.message}`)
          );

          // Delay team start slightly to allow board state responses to arrive
          setTimeout(() => {
            // For pando-infra, use seed agents. For others, use a single default agent.
            const agents = team.id === 'pando-infra' ? PANDO_INFRA_AGENTS : [
              { id: 'lead', role: 'lead', displayName: `${team.displayName} Lead`, prompt: '', promptTemplate: 'lead-universal', model: 'claude-code', tickIntervalMs: 15 * 60_000 },
            ];
            adapter.startTeam(team.id, agents).catch((err: any) =>
              console.warn(`[team-registry] Failed to start claimed team ${team.id}: ${err.message}`)
            );
          }, 5_000); // 5 second delay for P2P board state responses
        }
      };

      // Auto-bootstrap pando-infra — delayed to allow P2P team sync first.
      // Without this delay, both PandoTeams-capable nodes create pando-infra
      // independently (split-brain). The delay lets team_sync_response arrive
      // so we know if another node already manages the team.
      const TEAM_SYNC_WAIT_MS = 10_000; // 10s — enough for P2P sync round-trip
      const bootstrapTeams = () => {
        const adapter = node.getEngineAdapter?.();
        if (!adapter?.available) return;

        const existing = teamRegistry.getTeam('pando-infra');
        if (!existing) {
          // No one has pando-infra yet — create and claim it
          teamRegistry.createTeam({
            id: 'pando-infra',
            displayName: 'Pando Infrastructure',
            managingNode: node.identity.peerId,
            lastHeartbeat: Date.now(),
            status: 'active',
            repos: ['pando-lux/node', 'pando-lux/code'],
            agentCount: PANDO_INFRA_AGENTS.length,
            governanceRequired: true,
            createdBy: node.identity.peerId,
            claimedAt: Date.now(),
          });
          console.log('[team-registry] pando-infra team created and claimed.');
        } else if (!existing.managingNode || existing.status === 'orphaned') {
          // Unclaimed or orphaned — claim it
          const claimed = teamRegistry.claimTeam('pando-infra');
          if (claimed) console.log('[team-registry] pando-infra team claimed (was orphaned).');
        } else if (existing.managingNode === node.identity.peerId) {
          // We already manage it (persisted from previous session) — verify still valid
          console.log('[team-registry] pando-infra already managed by this node.');
        } else {
          // Another node manages it — don't touch it, orphan scan will handle failover
          console.log(`[team-registry] pando-infra managed by peer ${existing.managingNode.slice(0, 16)}... — not claiming.`);
        }

        // If we manage pando-infra, start its agents
        const infra = teamRegistry.getTeam('pando-infra');
        if (infra && infra.managingNode === node.identity.peerId) {
          adapter.startTeam('pando-infra', PANDO_INFRA_AGENTS).catch((err: any) =>
            console.warn(`[team-registry] Failed to start pando-infra team: ${err.message}`)
          );
        }

        // Heartbeat for all teams we manage
        // #audit: Store ref so performStop() can clear it
        // Heartbeat fast in dev mode (30s) so orphan detection works quickly
        const heartbeatMs = peerCount <= 8 ? 30_000 : 5 * 60_000;
        node._teamHeartbeatTimer = setInterval(() => {
          const myTeams = teamRegistry.getTeamsForNode(node.identity.peerId);
          for (const team of myTeams) {
            teamRegistry.updateHeartbeat(team.id);
          }
        }, heartbeatMs);
        node._teamHeartbeatTimer.unref();
      };

      // Request team sync from a random peer, then wait for responses
      const peers = node.network?.getPeers?.() ?? [];
      if (peers.length > 0) {
        console.log(`[team-registry] Waiting ${TEAM_SYNC_WAIT_MS / 1000}s for P2P team sync before bootstrap...`);
        teamRegistry.requestSyncFromPeer(peers[Math.floor(Math.random() * peers.length)]);
        setTimeout(bootstrapTeams, TEAM_SYNC_WAIT_MS);
      } else {
        // No peers yet — bootstrap immediately (we're likely the first node)
        bootstrapTeams();
      }

      console.log('[team-registry] Initialized. Teams: ' + teamRegistry.listTeams().length);
    } catch (err: any) {
      console.warn(`[team-registry] Init failed (non-fatal): ${err.message}`);
    }

    // Handle messages and reward work
    node.network.onMessage(async (message: any, from: any) => {
      // Security: ignore messages from quarantined peers
      if (node.securityMonitor?.isQuarantined(from)) {
        console.log(`[security] Ignoring message from quarantined peer: ${from.slice(0, 16)}`);
        return;
      }

      // Record message for security rate monitoring
      node.securityMonitor?.recordMessage(from);

      debug(`[${message.type}] from ${from.slice(0, 16)}...`);
      if (isDebug && message.payload) {
        const payloadStr = JSON.stringify(message.payload);
        debug(`  payload: ${payloadStr.length > 500 ? payloadStr.slice(0, 500) + '...[' + payloadStr.length + ' bytes]' : payloadStr}`);
      }

      // Ensure the sending peer has an account
      if (!node.ledger!.accounts.exists(from)) {
        node.ledger!.registerNode(from, 'remote-peer');
      }

      // Handle governance sync requests/responses (direct P2P messages)
      if (message.type === MessageType.GOVERNANCE_SYNC_REQUEST) {
        node.governance?.handleSyncRequest(from);
      }
      if (message.type === MessageType.GOVERNANCE_SYNC_RESPONSE) {
        node.governance?.handleSyncResponse(message);
      }

      // Handle direct P2P upgrade notifications (reliable delivery from proposer)
      if (message.type === MessageType.UPGRADE_NOTIFICATION) {
        const payload = message.payload as any;
        if (payload?.type === 'upgrade_available' && payload.commitHash) {
          const { commitHash, description } = payload;
          if (/^[0-9a-f]{6,40}$/i.test(commitHash) && node.upgradeProtocol) {
            if (!node.upgradeProtocol.hasApplied(commitHash) && !node.upgradeInProgress && !node.restartPending) {
              console.log(`[upgrade] Direct P2P: upgrade available (${commitHash.slice(0, 8)}): ${description || ''}`);
              node.upgradeInProgress = true;
              try {
                const result = await node.upgradeProtocol.pullAndUpgrade(commitHash);
                if (!result.success) console.error(`[upgrade] Direct P2P pull failed: ${result.message}`);
              } catch (err: any) {
                console.error(`[upgrade] Direct P2P upgrade failed: ${err.message}`);
              } finally {
                node.upgradeInProgress = false;
              }
            }
          }
        }
      }

      // Handle task sync requests/responses (direct P2P messages)
      if (message.type === MessageType.TASK_SYNC_REQUEST) {
        node.getActiveTaskQueue()?.handleSyncRequest(from);
      }
      if (message.type === MessageType.TASK_SYNC_RESPONSE) {
        const payload = message.payload as { tasks?: any[] };
        if (payload?.tasks) {
          node.getActiveTaskQueue()?.handleSyncResponse(payload.tasks);
        }
      }

      // Handle balance requests
      if (message.type === MessageType.BALANCE_REQUEST) {
        const peerId = (message.payload as any)?.peerId || from;
        const peerBalance = node.ledger!.accounts.getBalance(peerId);
        node.network!.sendMessage(from, {
          type: MessageType.BALANCE_RESPONSE,
          from: node.identity!.peerId,
          timestamp: Date.now(),
          payload: { peerId, balance: peerBalance },
        }).catch(() => {});
      }

      // Phase A: Direct TCP request/reply removed — unicast uses HTTP (HttpPeerClient)

      // Phase 92: Direct TCP stream capability profile exchange
      // Fallback for GossipSub mesh failures (small networks where mesh doesn't form)
      if (message.type === MessageType.CAPABILITY_PROFILE_DIRECT) {
        const profile = message.payload as any;
        if (profile) {
          node.capabilityRegistry.updatePeerProfile(profile);
          const activeResources = Object.entries(profile.capabilities || {})
            .filter(([, v]) => v).map(([k]) => k);
          console.log(`[capabilities] Direct profile from ${from.slice(0, 12)}: [${activeResources.join(', ')}]`);
        }
      }

      // Peer exchange: receive peer list from a connected node and dial unknown peers.
      if (message.type === MessageType.PEER_EXCHANGE) {
        const exchangedPeers = (message.payload as any)?.peers as { peerId: string; addrs: string[] }[] | undefined;
        if (exchangedPeers && Array.isArray(exchangedPeers) && node.network) {
          const network = node.network;
          const myPeerId = node.identity!.peerId;
          const connectedPeers = new Set(network.getPeers().map((p: any) => p.peerId));
          const unknownPeers = exchangedPeers.filter(
            (p: any) => p.peerId !== myPeerId && !connectedPeers.has(p.peerId)
          );
          debug(`[peer-exchange] Received ${exchangedPeers.length} peer(s) from ${from.slice(0, 12)}, ${unknownPeers.length} unknown, already connected to ${connectedPeers.size}`);
          if (unknownPeers.length > 0) {
            // Track successful dials for cascade — trigger on first success, not after all finish
            let cascaded = false;
            const triggerCascade = async () => {
              if (cascaded) return;
              cascaded = true;
              try {
                const allPeers = network.getPeers();
                const peerAddrs = await network.getConnectedPeerAddresses();
                if (allPeers.length >= 2 && peerAddrs.length > 0) {
                  for (const p of allPeers) {
                    const toShare = peerAddrs.filter((a: any) => a.peerId !== p.peerId);
                    if (toShare.length === 0) continue;
                    network.sendMessage(p.peerId, {
                      type: MessageType.PEER_EXCHANGE,
                      from: node.getIdentity()!.peerId,
                      timestamp: Date.now(),
                      payload: { peers: toShare },
                    }).catch(() => {});
                  }
                  console.log(`[peer-exchange] Cascade re-shared with ${allPeers.length} peer(s)`);
                }
              } catch {}
            };
            // Dial all unknown peers in parallel, cascade on first success
            Promise.allSettled(unknownPeers.map(async (peer: any) => {
              const libp2p = network.getLibp2p();
              if (!libp2p) return;
              if (peer.addrs.length === 1) {
                const ac = new AbortController();
                const timer = setTimeout(() => ac.abort(), 500); // 500ms (was 1s) — fast fail on stale addrs
                await libp2p.dial(ma(peer.addrs[0]), { signal: ac.signal });
                clearTimeout(timer);
                console.log(`[peer-exchange] Connected to ${peer.peerId.slice(0, 12)} via exchange from ${from.slice(0, 12)}`);
                triggerCascade();
                return;
              }
              // Multiple addresses: race them — first success wins (800ms, was 1.5s)
              const ac = new AbortController();
              const timer = setTimeout(() => ac.abort(), 800);
              try {
                await Promise.any(peer.addrs.map(async (addr: string) => {
                  await libp2p!.dial(ma(addr), { signal: ac.signal });
                  console.log(`[peer-exchange] Connected to ${peer.peerId.slice(0, 12)} via exchange from ${from.slice(0, 12)}`);
                }));
                triggerCascade();
              } finally {
                clearTimeout(timer);
              }
            }));
          }
        }
      }

      // Handle board state requests (team failover — peer asks for board snapshot)
      if (message.type === MessageType.BOARD_STATE_REQUEST) {
        const reqTeamId = (message.payload as any)?.teamId;
        if (reqTeamId && typeof reqTeamId === 'string') {
          const adapter = node.getEngineAdapter?.();
          if (adapter?.available) {
            const snapshot = adapter.getBoardStateSnapshot(reqTeamId);
            if (snapshot) {
              console.log(`[board-sync] Responding to BOARD_STATE_REQUEST for team ${reqTeamId} (${snapshot.tasks.length} tasks)`);
              node.network.sendMessage(from, {
                type: MessageType.BOARD_STATE_RESPONSE,
                from: node.identity!.peerId,
                timestamp: Date.now(),
                payload: { teamId: reqTeamId, snapshot },
              }).catch((err: any) =>
                console.warn(`[board-sync] Failed to send BOARD_STATE_RESPONSE: ${err.message}`)
              );
            }
          }
        }
      }

      // Handle board state responses (team failover — receiving board from peer)
      if (message.type === MessageType.BOARD_STATE_RESPONSE) {
        const respTeamId = (message.payload as any)?.teamId;
        const snapshot = (message.payload as any)?.snapshot;
        if (respTeamId && snapshot?.tasks?.length) {
          const adapter = node.getEngineAdapter?.();
          if (adapter?.available) {
            // Only restore if we are the managing node for this team
            const teamRegistry = (node as any)._teamRegistry as TeamRegistry | undefined;
            const team = teamRegistry?.getTeam(respTeamId);
            if (team && team.managingNode === node.identity!.peerId) {
              console.log(`[board-sync] Received BOARD_STATE_RESPONSE for team ${respTeamId} from ${from.slice(0, 12)} (${snapshot.tasks.length} tasks)`);
              adapter.restoreBoardStateFromSnapshot(respTeamId, snapshot);
            }
          }
        }
      }

      // Log unhandled message types at debug level so dropped messages are visible
      const handledTypes = new Set([
        MessageType.GOVERNANCE_SYNC_REQUEST, MessageType.GOVERNANCE_SYNC_RESPONSE,
        MessageType.TASK_SYNC_REQUEST, MessageType.TASK_SYNC_RESPONSE,
        MessageType.BALANCE_REQUEST, MessageType.CAPABILITY_PROFILE_DIRECT,
        MessageType.PEER_EXCHANGE, MessageType.UPGRADE_NOTIFICATION,
        MessageType.BOARD_STATE_REQUEST, MessageType.BOARD_STATE_RESPONSE,
      ]);
      if (!handledTypes.has(message.type)) {
        console.log(`[P2P] Unhandled message type: ${message.type}`);
      }
    });

    // v2.4: Subscribe to node_compromised broadcasts from peers
    await node.network.subscribeNodeCompromised();
    node.network.onNodeCompromised((compromisedPeerId: any, reason: any, timestamp: any) => {
      console.warn(`[security] Peer ${compromisedPeerId.slice(0, 12)} signaled compromise (${reason}) at ${new Date(timestamp).toISOString()}`);
      // Remove compromised peer from credential routing by marking them non-credentialAccess
      const profile = node.capabilityRegistry.getPeerProfile(compromisedPeerId);
      if (profile) {
        (profile as any).credentialAccess = false;
        (profile as any).compromisedAt = timestamp;
        node.capabilityRegistry.updatePeerProfile(profile);
        console.warn(`[security] Peer ${compromisedPeerId.slice(0, 12)} removed from credential routing`);
      }
    });

    // Safe self-restart watchdog: detect when the running process has stale compiled code.
    // Checks every 5 minutes: re-reads .build-commit from disk (upgrade catch-up may
    // have rebuilt and updated it), compares against git HEAD, and exits with code 75
    // if they differ and no active workers are in flight.
    {
      const buildCommitPaths = [
        join(process.cwd(), 'packages', 'node', 'dist', '.build-commit'),
        join(process.cwd(), 'dist', '.build-commit'),
      ];
      const readBuildCommit = (): string | null => {
        for (const p of buildCommitPaths) {
          try {
            const val = readFileSync(p, 'utf8').trim();
            if (val) return val;
          } catch { /* try next */ }
        }
        return null;
      };
      const initialCommit = readBuildCommit();
      if (initialCommit) {
        console.log(`[self-restart] Stale-build watchdog active (built at ${initialCommit.slice(0, 8)})`);
        let staleSinceTs: number | null = null; // Track when staleness was first detected
        const MAX_DEFER_MS = 5 * 60_000; // Max 5 minutes deferral then restart anyway
        const selfRestartInterval = setInterval(() => {
          try {
            // Re-read .build-commit each cycle — upgrade catch-up may have rebuilt
            const builtCommit = readBuildCommit();
            if (!builtCommit) return;
            const currentCommit = new GitOps(process.cwd()).getCurrentCommit();
            if (currentCommit === builtCommit) {
              staleSinceTs = null; // Build is fresh
              // Build matches HEAD, but did the build change since this process started?
              if (builtCommit !== initialCommit) {
                console.log(`[self-restart] Build updated since startup (was=${initialCommit.slice(0, 8)}, now=${builtCommit.slice(0, 8)}) — restarting`);
                clearInterval(selfRestartInterval);
                node.requestGracefulRestart('stale-build');
              }
              return;
            }
            // Check if only non-code files changed (e.g. .pando-state/ from board commits)
            // If no packages/ files differ, this isn't a real code change — skip restart
            try {
              const diffOutput = execSync(
                `git diff --name-only ${builtCommit}..${currentCommit}`,
                { cwd: process.cwd(), timeout: 10_000, encoding: 'utf8', windowsHide: true }
              ).trim();
              const changedFiles = diffOutput ? diffOutput.split('\n') : [];
              const hasCodeChanges = changedFiles.some(f =>
                f.startsWith('packages/node/') || f.startsWith('packages/shared/') || f.startsWith('packages/mcp-server/')
              );
              if (!hasCodeChanges) {
                // Only data files changed (board state, docs, etc.) — no restart needed
                staleSinceTs = null;
                return;
              }
            } catch { /* git diff failed — fall through to normal stale-build logic */ }

            // Build is stale — track how long
            if (!staleSinceTs) staleSinceTs = Date.now();
            const staleMs = Date.now() - staleSinceTs;
            const activeEngines = node.engineAdapter?.getActiveEngines()?.length ?? 0;
            if (activeEngines > 0 && staleMs < MAX_DEFER_MS) {
              console.log(`[self-restart] Stale build (built=${builtCommit.slice(0, 8)}, head=${currentCommit.slice(0, 8)}) — ${activeEngines} engine(s) active, deferring (${Math.round(staleMs / 1000)}s/${MAX_DEFER_MS / 1000}s)`);
              return;
            }
            // Either no active engines, or we've deferred long enough
            if (staleMs >= MAX_DEFER_MS) {
              console.log(`[self-restart] Stale build deferred for ${Math.round(staleMs / 1000)}s (max ${MAX_DEFER_MS / 1000}s) — rebuilding and restarting`);
            } else {
              console.log(`[self-restart] Stale build detected and no active engines — restarting`);
            }
            clearInterval(selfRestartInterval);
            // Rebuild before restarting to ensure dist/ is fresh
            try {
              console.log('[self-restart] Running npm run build...');
              execSync('npm run build', { cwd: process.cwd(), timeout: 180_000, stdio: 'pipe', windowsHide: true });
              console.log('[self-restart] Rebuild complete — restarting');
            } catch (buildErr: any) {
              console.warn(`[self-restart] Rebuild failed (restarting anyway): ${(buildErr as Error).message?.slice(0, 200)}`);
            }
            node.requestGracefulRestart('stale-build');
          } catch { /* git unavailable or cwd mismatch — skip silently */ }
        }, 60 * 1000);  // Check every 60s — fast restart after CEO commits
        selfRestartInterval.unref(); // don't prevent normal node exit
      } else {
        console.log('[self-restart] No build-commit stamp found — stale-build watchdog disabled (run npm run build to enable)');
      }
    }
}
