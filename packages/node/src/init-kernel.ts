import { WorkType, MessageType } from '@pando/shared';
import { PandoLedger } from '@pando/ledger';
import { PandoNetwork } from './kernel/network.js';
import { LedgerSync } from './kernel/sync.js';
import { GovernanceSync } from './kernel/governance.js';
import { TaskQueue } from './platform/task-queue.js';
import { Guardrails } from './kernel/guardrails.js';
import { RequestReplyManager } from './core/request-reply.js';
import { ReputationManager } from './kernel/reputation.js';
import { EmissionWitness, TOPIC_EMISSIONS } from './kernel/emission-witness.js';
import { SecurityMonitor } from './kernel/security-monitor.js';
import { UpgradeProtocol } from './core/upgrade-protocol.js';
import { LocalCapabilityStore } from './platform/local-capability-store.js';
import { detectCapabilities, detectCapabilityProfile } from './platform/capability-detector.js';
import { ProjectRegistry } from './platform/project-registry.js';
import { ResourceProofChallenger } from './platform/resource-proof.js';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { join } from 'node:path';
import { homedir, freemem, totalmem } from 'node:os';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export async function initKernel(node: any): Promise<void> {
    // Prevent crash on unhandled errors (only register once)
    if (!node.errorHandlersRegistered) {
      node.errorHandlersRegistered = true;
      process.on('unhandledRejection', (err) => {
        console.error(`[error] Unhandled rejection: ${err}`);
      });
      process.on('uncaughtException', (err) => {
        console.error(`[error] Uncaught exception: ${err.message}`);
      });
    }

    console.log(`Identity: ${node.identity.peerId}`);

    // Phase 55: Load linked user account (rewards flow to user, not node)
    const linkedUserPath = join(node.config.dataDir || join(homedir(), '.pando'), 'linked-user.json');
    try {
      const data = JSON.parse(readFileSync(linkedUserPath, 'utf-8'));
      if (data.peerId) {
        node.linkedUser = data;
        console.log(`[node] Linked to user account: ${data.username || data.peerId}`);
      }
    } catch { /* no linked user, that's fine */ }

    // Phase 96: Init LocalCapabilityStore before capability detection
    node.localCapStore = new LocalCapabilityStore(node.config.dataDir || undefined);

    // Contributor mode: auto-enable shareCompute (contributes PandoCode AI compute)
    if (node.config.nodeMode === 'contributor') {
      node.localCapStore.setShareCompute(true);
    }

    node.capabilityDetection = detectCapabilities(node.config.capabilities);
    node.detectedCapabilities = node.capabilityDetection.capabilities.map((c: any) => c as string);
    // Phase 96: Write full detected list to local store (preserves existing sharedCapabilities)
    node.localCapStore.setDetected(node.detectedCapabilities);
    console.log(`Capabilities (local): ${node.detectedCapabilities.join(', ')}`);
    const shared = node.localCapStore.getShared();
    console.log(`Capabilities (shared): ${shared.length > 0 ? shared.join(', ') : '(none — use /contribute to share)'}`);

    // Phase A + 96: Detect rich capability profile for broadcast
    // detectCapabilityProfile reads sharedCapabilities from localCapStore — peers only see what user shared
    const linkedUserForProfile = node.linkedUser?.username ? { username: node.linkedUser.username } : null;
    const capProfile = detectCapabilityProfile(node.identity.peerId, node.config.apiPort, linkedUserForProfile, node.localCapStore);
    node.capabilityRegistry.setLocalProfile(capProfile);
    // Phase 96: Wire LocalCapabilityStore into registry for own-task routing
    node.capabilityRegistry.setLocalCapabilityStore(node.localCapStore);
    const activeResources = Object.entries(capProfile.capabilities)
      .filter(([, v]) => v).map(([k]) => k);
    console.log(`Resources: ${activeResources.join(', ')}`);

    // Initialize ledger
    node.ledger = new PandoLedger(node.config.dataDir || undefined);
    const publicKeyStr = uint8ArrayToString(node.identity.publicKey, 'base64');
    const isNew = !node.ledger.accounts.exists(node.identity.peerId);
    node.ledger.registerNode(node.identity.peerId, publicKeyStr);

    // Genesis allocation for new nodes — bootstrap the economy
    if (isNew) {
      const genesisTx = node.ledger.rewardWork(
        node.identity.peerId,
        WorkType.PEER_RELAYED,
        'genesis: node registration'
      );
      console.log(`Genesis: +${genesisTx.amount} Lux minted`);
      // Genesis tx will be included in catch-up sync (sync not started yet)
    }

    // Check for existing snapshots — load latest for faster bootstrap
    const snapshotInfo = node.ledger.getSnapshotInfo(node.config.dataDir || undefined);
    if (snapshotInfo) {
      console.log(`Snapshot: found ${snapshotInfo.filename} (${snapshotInfo.accountCount} accounts, ${snapshotInfo.transactionCount} txs)`);
      node.lastSnapshotTxCount = snapshotInfo.transactionCount;
    } else {
      node.lastSnapshotTxCount = node.ledger.getNetworkStats().totalTransactions;
    }

    const balance = node.ledger.accounts.getBalance(node.identity.peerId);
    console.log(`Ledger: ${balance} Lux`);

    // Start networking
    node.network = new PandoNetwork(node.identity, node.config);
    await node.network.start();

    const addresses = node.network.getListenAddresses();
    console.log('Listening:');
    for (const addr of addresses) {
      console.log(`  ${addr}`);
    }

    // Start ledger sync (GossipSub)
    node.sync = new LedgerSync(node.network, node.ledger, node.identity.peerId);
    await node.sync.start();

    // Phase 56: Wire user account claim broadcasting to P2P sync
    if (node.userAccountStore && node.sync) {
      node.userAccountStore.setBroadcastClaim((claim: any) => node.sync!.broadcastClaim(claim));
    }

    // Start governance layer (proposals, voting, agent communication)
    node.governance = new GovernanceSync(node.network, node.identity.peerId, node.ledger.getDatabase());
    await node.governance.start();

    // Wire governance rewards — emit Lux for votes and accepted proposals
    node.governance.setRewardCallback((peerId: any, workType: any, workProof: any) => {
      return node.ledger!.rewardWork(peerId, workType, workProof);
    });

    // Wire governance activity broadcasting — governance events → pando/activity GossipSub
    node.governance.setActivityBroadcaster(async (record: any) => {
      // Store locally in ledger
      try { node.ledger!.recordActivity(record); } catch {}
      // Broadcast to network
      await node.sync!.broadcastActivity(record);
    });

    // When a new governance proposal arrives, push SSE
    node.governance.onProposal((proposal: any) => {
      node.apiServer?.pushEvent('proposal', {
        id: proposal.id,
        title: proposal.title,
        proposedBy: proposal.proposedBy,
        status: proposal.status,
        timestamp: proposal.createdAt,
      });
    });

    // Phase 63: P2P Project Registry
    node.projectRegistry = new ProjectRegistry(
      node.network,
      node.identity.peerId,
      node.ledger.getDatabase()
    );
    await node.projectRegistry.start();

    // Wire ProjectRegistry into LedgerSync for catch-up sync
    if (node.sync && node.projectRegistry) {
      node.sync.setProjectRegistry(node.projectRegistry);
    }

    // Initialize EmissionWitness — witness-based emission system
    node.emissionWitness = new EmissionWitness(node.identity.peerId, node.config.dataDir || undefined);
    node.emissionWitness.setNetwork(node.network);
    node.emissionWitness.setLedger(node.ledger);
    node.emissionWitness.setSync(node.sync);
    node.emissionWitness.setPrivateKey(node.identity.privateKey);
    node.emissionWitness.setEmitCallback((peerId: any, workType: any, workProof: any) => {
      try {
        const wt = workType as WorkType;
        const tx = node.ledger!.rewardWork(peerId, wt, workProof);
        node.sync?.broadcastTransaction(tx).catch(() => {});
        return tx;
      } catch (err: any) {
        console.error(`[emission-witness] Mint error: ${err.message}`);
        return null;
      }
    });
    node.emissionWitness.start();

    // Subscribe to 'pando/emissions' GossipSub topic
    await node.network.subscribeTopic(TOPIC_EMISSIONS, (message: any) => {
      if (!message.payload) return;
      const fromPeerId = message.from || 'unknown';
      if (fromPeerId === node.identity!.peerId) return;
      // Record emission proposal for security abuse detection
      node.securityMonitor?.recordEmissionProposal(fromPeerId);
      node.emissionWitness?.handleMessage(message.payload, fromPeerId);
    });
    console.log(`[emission-witness] Subscribed to GossipSub topic: ${TOPIC_EMISSIONS}`);

    // Initialize SecurityMonitor — anomaly detection + quarantine system
    const dataDir = node.config.dataDir || join(homedir(), '.pando');

    // Write running-commit.txt so the orchestrator's safe-restart guard can
    // detect when a newer build is ready and the node is idle.
    try {
      const headCommit = (execSync('git rev-parse HEAD', {
        cwd: process.cwd(), encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
      }) as string).trim();
      writeFileSync(join(dataDir, 'running-commit.txt'), headCommit);
      console.log(`[node] Running commit: ${headCommit.slice(0, 8)}`);
    } catch { /* git unavailable — skip silently */ }

    node.securityMonitor = new SecurityMonitor(dataDir, node.identity.peerId);
    node.securityMonitor.setNetwork(node.network);
    node.securityMonitor.setLedger(node.ledger);
    if (node.emissionWitness) {
      node.securityMonitor.setEmissionWitness(node.emissionWitness);
    }
    node.securityMonitor.start();

    // Periodic sync cleanup + database pruning
    let cleanupCycle = 0;
    node.cleanupTimer = setInterval(() => {
      node.sync?.cleanup();
      node.governance?.cleanup();
      cleanupCycle++;
    }, 60_000);

    // Create passive TaskQueue — always available for API + P2P task sync
    // (even without --scheduler or --agent)
    node.taskQueue = new TaskQueue(dataDir);
    node.taskQueue.setNetwork(node.network);
    node.taskQueue.setLocalPeerId(node.identity.peerId);

    // Create Guardrails — safety system for self-generated changes (Phase 9.3)
    node.guardrails = new Guardrails(dataDir);

    // Phase 13: Create UpgradeProtocol — self-evolving upgrade lifecycle
    node.upgradeProtocol = new UpgradeProtocol({
      governance: node.governance!,
      guardrails: node.guardrails,
      dataDir,
      repoDir: process.cwd(),
      localPeerId: node.identity.peerId,
      networkProvider: () => node.network,
      workersActiveFn: () => node.engineAdapter?.getActiveEngines()?.length ?? 0,
      messagesPendingFn: () => false,
    });

    // Subscribe to GossipSub task events so all nodes see task changes
    await node.network.subscribeTaskEvents();
    node.network.onTaskEvent((payload: any, fromPeerId: any) => {
      if (!node.taskQueue) return;
      if (payload.type === 'created' && payload.task) {
        const task = { ...payload.task, origin: fromPeerId };
        const inserted = node.taskQueue.insertRemoteTask(task);
        if (inserted) {
          console.log(`[task-sync] Received new task from ${fromPeerId.slice(0, 12)}: ${payload.task.title}`);
        }
      } else if (payload.type === 'claimed' && payload.task) {
        // Phase 8: Claim conflict resolution
        const localTask = node.taskQueue.getTask(payload.task.id);
        if (localTask && (localTask.status === 'claimed' || localTask.status === 'in_progress')
            && localTask.claimedByNode === node.identity!.peerId) {
          // We also claimed this task — conflict!
          const remoteClaimedAt = payload.task.claimedAt || 0;
          const localClaimedAt = localTask.claimedAt || 0;
          let weWin = false;
          if (localClaimedAt < remoteClaimedAt) {
            weWin = true;
          } else if (localClaimedAt === remoteClaimedAt) {
            // Tiebreak: lower peerId wins (deterministic)
            weWin = node.identity!.peerId < fromPeerId;
          }
          if (!weWin) {
            // We lost the race — release our local claim
            console.log(`[task] Claim conflict on ${payload.task.id.slice(0, 8)} — ${fromPeerId.slice(0, 12)} wins (earlier claim)`);
            node.taskQueue.forceReleaseTask(payload.task.id);
            // Apply the remote claim
            node.taskQueue.updateRemoteStatus(
              payload.task.id, 'claimed', payload.task.assignedTo,
              undefined, payload.task.claimedByNode,
            );
          } else {
            console.log(`[task] Claim conflict on ${payload.task.id.slice(0, 8)} — we win (earlier claim)`);
          }
        } else {
          // No conflict — apply remote claim normally
          const updated = node.taskQueue.updateRemoteStatus(
            payload.task.id, payload.task.status, payload.task.assignedTo,
            undefined, payload.task.claimedByNode,
          );
          if (updated) {
            console.log(`[task-sync] Task ${payload.task.id.slice(0, 8)} claimed by ${fromPeerId.slice(0, 12)}`);
          }
        }
      } else if (payload.type === 'completed' && payload.task) {
        const executedByNode = payload.executedByNode || payload.task.executedByNode || fromPeerId;
        const updated = node.taskQueue.updateRemoteStatus(
          payload.task.id, payload.task.status, undefined, payload.task.result,
          undefined, executedByNode,
        );
        if (updated) {
          console.log(`[task-sync] Task ${payload.task.id.slice(0, 8)} completed by ${fromPeerId.slice(0, 12)}`);
        }

        // Phase 8: If this task originated from us, store the remote output
        const localTask = node.taskQueue.getTask(payload.task.id);
        if (localTask && localTask.originNode === node.identity!.peerId) {
          if (payload.output) {
            node.taskQueue.storeRemoteOutput(payload.task.id, payload.output, executedByNode);
          }
          // Push remote_completed timeline event
          node.taskQueue.pushTimelineEvent(payload.task.id, {
            event: 'remote_completed',
            detail: `Task executed by remote node ${executedByNode.slice(0, 12)}`,
            metadata: {
              executedByNode,
              duration: payload.duration,
              hasOutput: !!payload.output,
            },
          });
          console.log(`[task] Remote task ${payload.task.id.slice(0, 8)} completed by ${executedByNode.slice(0, 12)}`);
        }
      } else if (payload.type === 'timeline' && payload.task && payload.timelineEvent) {
        // Phase 8.3: Apply remote timeline event to local task
        const applied = node.taskQueue.applyRemoteTimelineEvent(payload.task.id, payload.timelineEvent);
        if (applied) {
          console.log(`[task-sync] Timeline event '${payload.timelineEvent.event}' for task ${payload.task.id.slice(0, 8)} from ${fromPeerId.slice(0, 12)}`);

          // Emit to SSE so gateway can show real-time progress for remote tasks
          // First try the Scheduler's per-task emitter (if scheduler is running and tracking this task)
          const schedulerEmitter = node.scheduler?.getTaskEmitter(payload.task.id);
          if (schedulerEmitter) {
            schedulerEmitter.emit('output', {
              type: 'timeline',
              timestamp: payload.timelineEvent.timestamp,
              event: payload.timelineEvent.event,
              detail: payload.timelineEvent.detail,
              metadata: payload.timelineEvent.metadata,
              remote: true,
              executingNode: payload.executingNode || fromPeerId,
            });
          } else {
            // No scheduler emitter — use remote task emitter for SSE
            let remoteEmitter = node.remoteTaskEmitters.get(payload.task.id);
            if (!remoteEmitter) {
              remoteEmitter = new EventEmitter();
              node.remoteTaskEmitters.set(payload.task.id, remoteEmitter);
              // Auto-cleanup after 30 minutes of inactivity
              setTimeout(() => {
                node.remoteTaskEmitters.delete(payload.task.id);
                remoteEmitter!.removeAllListeners();
              }, 30 * 60 * 1000);
            }
            remoteEmitter.emit('output', {
              type: 'timeline',
              timestamp: payload.timelineEvent.timestamp,
              event: payload.timelineEvent.event,
              detail: payload.timelineEvent.detail,
              metadata: payload.timelineEvent.metadata,
              remote: true,
              executingNode: payload.executingNode || fromPeerId,
            });
          }
        }
      }
    });

    // Subscribe to agent messages (required for request/reply)
    await node.network.subscribeAgentMessages();

    // Start Request/Reply Manager (Phase 10.1) — uses agent-messages topic (broadcast queries only)
    node.requestReply = new RequestReplyManager(node.network);
    await node.requestReply.start();

    // Phase A: Initialize HttpPeerClient for direct peer-to-peer HTTP operations
    {
      const { HttpPeerClient } = await import('./core/http-peer-client.js');
      node.httpPeerClient = new HttpPeerClient(node.identity!, node.capabilityRegistry);
    }

    // Register built-in request handlers
    node.requestReply.registerHandler('ping', async () => {
      return { pong: true, uptime: Math.floor(process.uptime()), peerId: node.identity!.peerId };
    });

    node.requestReply.registerHandler('health_check', async () => {
      const monitor = node.getMonitor();
      // Include worker process memory (claude.exe / node.exe children)
      const workerStats: any[] = [];
      const workerMemory = {
        totalWorkerRssBytes: workerStats.reduce((sum, s) => sum + s.rssBytes, 0),
        freeMemBytes: freemem(),
        totalMemBytes: totalmem(),
        perWorker: workerStats,
      };
      if (monitor) {
        const metrics = monitor.getCurrentMetrics();
        return { ...metrics, workerMemory };
      }
      // Fallback basic health info when monitor is not running
      return {
        timestamp: Date.now(),
        nodeHealth: 'healthy',
        peerCount: node.network!.getPeerCount(),
        schedulerRunning: !!node.scheduler,
        uptimeSeconds: Math.floor(process.uptime()),
        workerMemory,
      };
    });

    // P2P chat proxy — remote nodes forward full build requests here.
    // Contributor daily cap: max 50 compute jobs/day (configurable via PANDO_DAILY_COMPUTE_CAP)
    const DAILY_COMPUTE_CAP = parseInt(process.env.PANDO_DAILY_COMPUTE_CAP || '50', 10);
    node.requestReply.registerHandler('chat_proxy', async (req: any) => {
      if (!node.localCapStore?.isShareCompute()) {
        return { error: 'This node is not sharing compute.' };
      }
      if (!node.engineAdapter?.available) {
        return { error: 'Engine not available on this node.' };
      }

      // Daily compute cap — reset counter at midnight UTC
      const today = new Date().toISOString().slice(0, 10);
      if (node.dailyComputeResetDate !== today) {
        node.dailyComputeJobs = 0;
        node.dailyComputeResetDate = today;
      }
      if (node.dailyComputeJobs >= DAILY_COMPUTE_CAP) {
        return { error: `Daily compute cap reached (${DAILY_COMPUTE_CAP} jobs/day). Try again tomorrow.` };
      }
      node.dailyComputeJobs++;

      const { message, threadId, tier } = req.payload || {};
      if (!message) return { error: 'message required' };

      // Generate project ID locally — skip MongoDB to avoid circular P2P proxy calls.
      // When EC2 (no AI capability) forwards to Windows (has PandoCode) via chat_proxy,
      // calling projectStore.createProject() would P2P-proxy back to EC2 → timeout.
      // The orchestrator only needs a projectId string; full MongoDB record is not required.
      const projectId = randomUUID();
      console.log(`[chat_proxy] Generated local projectId ${projectId} for P2P request from ${req.from}`);

      // Update thread if provided
      if (threadId) {
        const ts = node.getThreadStore();
        if (ts) {
          try { ts.updateThread(threadId, { projectId }); } catch { /* best effort */ }
        }
      }

      // Route to EngineAdapter
      if (!node.engineAdapter?.available) {
        return { error: 'EngineAdapter not available' };
      }
      // Fire-and-forget: stream response back via chat_result P2P handler
      (async () => {
        try {
          const chunks: string[] = [];
          for await (const event of node.engineAdapter!.send(message, projectId)) {
            if (event.type === 'stream:chunk' && event.content) chunks.push(event.content);
          }
          const content = chunks.join('');
          if (threadId && req.from && node.httpPeerClient) {
            try {
              await node.httpPeerClient.dispatchRequest(req.from, 'chat_result', { threadId, message: content }, 10_000);
            } catch { /* best-effort — peer may not be reachable via HTTP */ }
          }
          // Reward contributor with Lux for processing this compute job
          if (content.length > 0 && node.identity && node.ledger) {
            try {
              node.ledger.rewardWork(
                node.identity.peerId, WorkType.COMPUTE_CONTRIBUTED,
                `compute:${projectId}:${content.length}chars:from:${req.from?.slice(0, 12)}`
              );
              console.log(`[chat_proxy] Earned Lux for compute job (project ${projectId})`);
            } catch { /* best-effort reward */ }
          }
          // Trigger app update via AppManager after engine completes
          const appMgr = node.getAppManager?.();
          if (appMgr && projectId) {
            appMgr.update(projectId).catch((e: any) => console.warn('[app-manager] Auto-update failed:', e.message));
          }
        } catch (err: any) {
          console.warn(`[chat_proxy] Engine send failed: ${err.message?.slice(0, 100)}`);
        }
      })();

      return { status: 'queued', projectId, threadId };
    });

    // P2P chat result — remote orchestrator sends back the AI response to the originating node.
    node.requestReply.registerHandler('chat_result', async (req: any) => {
      const { threadId, message: content } = req.payload || {};
      if (!threadId || !content) return { error: 'threadId and message required' };
      // Fire SSE so the local gateway user sees the result
      node.apiServer?.pushEvent('chat_message', {
        threadId,
        role: 'assistant',
        content,
        timestamp: Date.now(),
      });
      // Also write to local ThreadStore for persistence
      const ts = node.getThreadStore();
      if (ts) {
        ts.addMessage(threadId, { role: 'assistant', content, timestamp: Date.now() }).catch(() => {});
      }
      return { status: 'delivered' };
    });

    // Remote task queries — allows any node to query this node's tasks via P2P
    node.requestReply.registerHandler('task_list', async (req: any) => {
      const tasks = node.taskQueue!.getTasks();
      const limit = req.payload?.limit || 50;
      // Return summary: id, title, status, priority, createdAt, cost, tier
      return tasks.slice(0, limit).map((t: any) => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority,
        createdAt: t.createdAt, cost: t.cost, parentTask: t.parentTask,
        childTasks: t.childTasks, executedByNode: t.executedByNode,
      }));
    });

    node.requestReply.registerHandler('task_detail', async (req: any) => {
      const taskId = req.payload?.taskId;
      if (!taskId) return { error: 'taskId required' };
      const task = node.taskQueue!.getTask(taskId);
      if (!task) return { error: 'Task not found' };
      return task;
    });

    // Subscribe to capability declarations from peers
    await node.network.subscribeCapabilities();
    node.network.onCapabilityDeclaration((declaration: any, fromPeerId: any) => {
      node.peerCapabilities.set(fromPeerId, declaration);
      console.log(`[capabilities] Peer ${fromPeerId.slice(0, 12)} declared: [${declaration.capabilities.join(', ')}]`);
    });

    // Phase A: Handle incoming CapabilityProfile messages via GossipSub
    node.network.onCapabilityProfile((profile: any, fromPeerId: any) => {
      node.capabilityRegistry.updatePeerProfile(profile);
      const activeResources = Object.entries(profile.capabilities)
        .filter(([, v]) => v).map(([k]) => k);
      console.log(`[capabilities] Peer ${fromPeerId.slice(0, 12)} profile: [${activeResources.join(', ')}]`);
    });

    // Broadcast our capabilities when a new peer connects
    // Uses a triple-broadcast pattern because GossipSub mesh formation
    // takes several seconds after TCP connection — immediate broadcast
    // is often lost before the mesh is ready.
    node.network.onPeerConnect(async (peerId: string) => {
      // Immediate broadcast (may be lost if mesh not ready)
      try {
        await node.broadcastCapabilities();
        await node.broadcastCapabilityProfile();
      } catch {}
      // Delayed rebroadcast after mesh formation
      setTimeout(async () => {
        try {
          await node.broadcastCapabilities();
          await node.broadcastCapabilityProfile();
        } catch {}
      }, 10_000);
      // Final safety net for slow mesh formation
      setTimeout(async () => {
        try {
          await node.broadcastCapabilities();
          await node.broadcastCapabilityProfile();
        } catch {}
      }, 30_000);

      // Phase 92: Direct TCP stream fallback for GossipSub mesh failures.
      // GossipSub requires min D=6 peers in mesh to reliably propagate.
      // Small networks (2-5 nodes) often fail to form a mesh after simultaneous
      // restarts. Direct TCP stream bypasses GossipSub entirely.
      setTimeout(async () => {
        try {
          const profile = node.capabilityRegistry.getLocalProfile();
          if (!profile || !node.network) return;
          profile.updatedAt = Date.now();
          await node.network.sendMessage(peerId, {
            type: MessageType.CAPABILITY_PROFILE_DIRECT,
            from: node.getIdentity()!.peerId,
            timestamp: Date.now(),
            payload: profile,
          });
          console.log(`[capabilities] Direct profile sent to ${peerId.slice(0, 12)}`);
        } catch {}
      }, 2_000);

      // Peer exchange: share our peer list so new nodes can form a full mesh.
      // Delayed 5s to let the connection settle and capability exchange finish first.
      setTimeout(async () => {
        try {
          if (!node.network) return;
          const peerAddrs = (await node.network.getConnectedPeerAddresses())
            .filter((p: any) => p.peerId !== peerId); // don't send them their own address
          if (peerAddrs.length === 0) return;
          await node.network.sendMessage(peerId, {
            type: MessageType.PEER_EXCHANGE,
            from: node.getIdentity()!.peerId,
            timestamp: Date.now(),
            payload: { peers: peerAddrs },
          });
          console.log(`[peer-exchange] Shared ${peerAddrs.length} peer(s) with ${peerId.slice(0, 12)}`);
        } catch {}
      }, 5_000);

      // Phase 69: Auto-wrap removed — credentials in MongoDB, not per-node.

      // Phase 83: Deferred data loading for P2PStorageBackend nodes.
      // When the first compute peer connects, retry loadFromBackend if it failed at startup.
      if (node.getStorageBackendType() === 'p2p' && !node._p2pDataLoaded) {
        setTimeout(async () => {
          if (node._p2pDataLoaded) return;
          try {
            if (node.threadStore) await node.threadStore.loadFromBackend();
            if (node.projectStore) await (node.projectStore as any).loadFromBackend();
            if (node.revenueEngine) await (node.revenueEngine as any).loadFromBackend();
            if (node.contributionTracker) await (node.contributionTracker as any).loadFromBackend();
            node._p2pDataLoaded = true;
            console.log('[data] P2P deferred data loading complete — stores hydrated from compute peer');
          } catch (err: any) {
            console.warn(`[data] P2P deferred loading failed: ${err.message}`);
          }
        }, 5_000); // Wait 5s for capability profile to sync so P2PStorageBackend can find peers
      }
    });

    // Initial broadcast of our capabilities
    try {
      await node.broadcastCapabilities();
      await node.broadcastCapabilityProfile();
    } catch {}

    // Phase A: Re-broadcast capability profile every 5 minutes (heartbeat)
    node.capabilityBroadcastTimer = setInterval(async () => {
      try {
        await node.broadcastCapabilityProfile();
      } catch {}
      // Periodic cleanup of expired profiles
      node.capabilityRegistry.cleanup();
    }, 5 * 60 * 1000);

    // Subscribe to agent events (needed for Phase 10 — reputation, profile sharing)
    await node.network.subscribeAgentEvents();

    // ── Phase 82: Simple P2P Self-Upgrade via GossipSub ──────────────────────
    if (node.upgradeProtocol) {
      const upgradeProtocol = node.upgradeProtocol;

      // Wire broadcast: publish to pando/upgrades topic
      upgradeProtocol.setBroadcast(async (msg: Record<string, unknown>) => {
        const { TOPIC_UPGRADES } = await import('./core/upgrade-protocol.js');
        await node.network!.publishToTopic(TOPIC_UPGRADES, {
          type: 'agent_event' as any, from: node.identity!.peerId, timestamp: Date.now(), payload: msg,
        } as any);
      });

      // Wire restart
      upgradeProtocol.setRequestRestart((reason?: string) => {
        node.requestGracefulRestart(reason);
      });

      // Subscribe to upgrade notifications from peers
      const { TOPIC_UPGRADES } = await import('./core/upgrade-protocol.js');
      await node.network.subscribeTopic(TOPIC_UPGRADES, async (msg: any) => {
        try {
          const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
          if (!payload || payload.type !== 'upgrade_available') return;
          if (payload.fromPeerId === node.identity!.peerId) return;

          const { commitHash, description, governanceId } = payload;
          if (!commitHash) return;
          if (upgradeProtocol.hasApplied(commitHash)) return;
          if (node.upgradeInProgress || node.restartPending) return;

          console.log(`[upgrade] Peer notified: new upgrade available (${commitHash.slice(0, 8)}): ${description}`);
          node.upgradeInProgress = true;
          try {
            const result = await upgradeProtocol.pullAndUpgrade(commitHash);
            if (!result.success) {
              console.error(`[upgrade] Pull failed: ${result.message}`);
            }
          } catch (err: any) {
            console.error(`[upgrade] Failed: ${err.message}`);
          } finally {
            node.upgradeInProgress = false;
          }
        } catch (err: any) {
          console.error(`[upgrade] Error handling pando/upgrades: ${err.message}`);
        }
      });

      // When governance approves an upgrade: pull locally, then broadcast to peers
      if (node.governance) {
        node.governance.onUpgradeApproved(async (govProposal: any) => {
          const commitHash = govProposal.upgradePayload?.commitHash;
          const description = govProposal.upgradePayload?.description || govProposal.title;
          if (!commitHash) {
            console.warn(`[upgrade] Governance approved but no commitHash in payload`);
            return;
          }
          console.log(`[upgrade] Governance approved upgrade: ${commitHash.slice(0, 8)} — ${description}`);

          // Pull and build locally
          node.upgradeInProgress = true;
          try {
            const result = await upgradeProtocol.pullAndUpgrade(commitHash);
            if (result.success) {
              // Broadcast to all peers so they pull too
              await upgradeProtocol.broadcastUpgradeNotification(commitHash, description, govProposal.id);

              // Auto-deploy gateway to all contributed hosting accounts
              const filesTouched: string[] = (govProposal.upgradePayload as any)?.filesTouched || [];
              const gatewayChanged = filesTouched.some(f => f.startsWith('packages/gateway/'));
              if (gatewayChanged && node.gatewayDeployPool) {
                try {
                  const results = await node.gatewayDeployPool.deployToAll(commitHash);
                  const succeeded = results.filter((r: any) => r.status === 'live').length;
                  const failed = results.filter((r: any) => r.status === 'failed').length;
                  if (results.length > 0) {
                    console.log(`[upgrade] Gateway deployed to ${succeeded} hosting account(s)${failed > 0 ? ` (${failed} failed)` : ''}`);
                  } else {
                    console.log(`[upgrade] Gateway changed but no hosting credentials contributed — skipping deploy`);
                  }
                } catch (err: any) {
                  console.warn(`[upgrade] Gateway deploy pool error: ${err.message}`);
                }
              }
            } else {
              console.error(`[upgrade] Local pull failed: ${result.message}`);
            }
          } catch (err: any) {
            console.error(`[upgrade] Upgrade failed: ${err.message}`);
          } finally {
            node.upgradeInProgress = false;
          }
        });
      }
      // Start catch-up timer: periodically scans governance for missed upgrades
      // Handles case where proposer goes offline before broadcasting
      upgradeProtocol.startCatchupTimer(async (commitHash: string) => {
        if (node.upgradeInProgress || node.restartPending) {
          return { success: false, message: 'Upgrade already in progress' };
        }
        node.upgradeInProgress = true;
        try {
          return await upgradeProtocol.pullAndUpgrade(commitHash);
        } finally {
          node.upgradeInProgress = false;
        }
      });

      console.log('[upgrade] Phase 82 simple self-upgrade wired (with catch-up timer)');

      // Periodic governance re-sync: every 5 min, re-sync with a random connected peer.
      // Handles thin GossipSub meshes where governance votes/decisions don't propagate.
      setInterval(() => {
        if (!node.governance || !node.network) return;
        const peers = node.network.getPeers();
        if (peers.length === 0) return;
        const randomPeer = peers[Math.floor(Math.random() * peers.length)];
        node.governance.requestSync(randomPeer.peerId).catch(() => {});
      }, 5 * 60 * 1000);

      // Delayed peer re-exchange: 30s + 90s after boot, share full peer list with all peers.
      // The per-connection exchange (5s) may miss peers that haven't connected yet.
      for (const delay of [30_000, 90_000]) {
        setTimeout(async () => {
          if (!node.network) return;
          const peers = node.network.getPeers();
          const peerAddrs = await node.network.getConnectedPeerAddresses();
          if (peers.length < 2 || peerAddrs.length === 0) return;
          for (const peer of peers) {
            const toShare = peerAddrs.filter((p: any) => p.peerId !== peer.peerId);
            if (toShare.length === 0) continue;
            try {
              await node.network.sendMessage(peer.peerId, {
                type: MessageType.PEER_EXCHANGE,
                from: node.getIdentity()!.peerId,
                timestamp: Date.now(),
                payload: { peers: toShare },
              });
            } catch {}
          }
          console.log(`[peer-exchange] Re-shared peers with ${peers.length} connected peer(s)`);
        }, delay);
      }

      // Log if this is a post-upgrade restart
      const lastUpgradeFile = join(dataDir, 'last-upgrade.json');
      if (existsSync(lastUpgradeFile)) {
        try {
          const info = JSON.parse(readFileSync(lastUpgradeFile, 'utf-8'));
          console.log(`[upgrade] Restarted after upgrade (reason: ${info.reason}, at: ${new Date(info.timestamp).toISOString()})`);
          unlinkSync(lastUpgradeFile);
        } catch {}
      }
    }

    // Start Reputation Manager (Phase 10.3) — performance tracking, P2P sync
    node.reputation = new ReputationManager(dataDir, node.network, node.requestReply, node.httpPeerClient);
    node.reputation.start();

    // Phase 12.3: Initialize ResourceProofChallenger — verifies nodes provide what they claim
    node.resourceProofChallenger = new ResourceProofChallenger(
      node.requestReply, node.network, node.identity.peerId, dataDir, node.httpPeerClient,
    );
    node.resourceProofChallenger.startChallengeLoop();
}
