/**
 * Layer 2 (Platform) API routes — registered by registerPlatformRoutes().
 *
 * Routes: /chat/*, /bridge/*, /tasks/:id/messages, /capabilities/*,
 *         /network/capabilities/*, /resources/* (network), /capacity,
 *         /network-state, /resources/* (registry), /instances/*,
 *         /content/*, /regression, /payment/*, /auth/*, /projects/*,
 *         /marketplace/*, /teams/*, /apps/*
 */

import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { randomBytes } from 'node:crypto';
import type { RouteHelpers } from './middleware/auth.js';
import { violatesTwoLaws } from './api-server.js';

export async function registerPlatformRoutes(
  fastify: any,
  deps: RouteHelpers,
): Promise<void> {
  const { node } = deps;

  /**
   * Send a message to the EngineAdapter for a project (or system engine if no projectId).
   * Collects the streamed response and returns it.
   */
  async function sendToEngine(
    message: string,
    projectId?: string,
  ): Promise<{ sent: boolean; response?: string }> {
    const adapter = node.getEngineAdapter();
    if (!adapter?.available) return { sent: false };
    try {
      const chunks: string[] = [];
      for await (const event of adapter.send(message, projectId)) {
        if (event.type === 'stream:chunk' && event.content) {
          chunks.push(event.content);
        }
      }
      return { sent: true, response: chunks.join('') };
    } catch (err: any) {
      console.error('[engine] sendToEngine failed:', err.message);
      return { sent: false };
    }
  }

  /** Check if local PandoCode engine is available (provider-agnostic). */
  function hasEngine(): boolean {
    return !!(node.getEngineAdapter()?.available);
  }

  /**
   * Unified build routing — find the best PandoCode peer (including self).
   * Returns { peerId, isLocal } or null if no builders available.
   */
  function findBestBuilder(): { peerId: string; isLocal: boolean } | null {
    const selfPeerId = node.getIdentity()?.peerId;

    // Collect all candidates from capability registry (includes self)
    const capRegistry = node.getCapabilityRegistry();
    const allProfiles = capRegistry?.getAllProfiles() || [];
    const candidates = allProfiles.filter((p: any) =>
      p.shareCompute === true &&
      p.capabilities.compute_cpu === true
    );

    // Check if self is a candidate (has local PandoCode engine)
    const selfHasEngine = hasEngine();
    if (selfHasEngine && selfPeerId) {
      // Self is the best candidate — no P2P overhead
      return { peerId: selfPeerId, isLocal: true };
    }

    // Find best remote peer
    const remoteCandidates = candidates.filter((p: any) => p.peerId !== selfPeerId);
    if (remoteCandidates.length > 0) {
      // TODO: score by latency/load — for now pick first available
      return { peerId: remoteCandidates[0].peerId, isLocal: false };
    }

    return null;
  }

    fastify.post('/chat/message', async (request: any, reply: any) => {
      const peerId = await deps.verifyUserJwt(request);
      if (!peerId) { reply.status(401).send({ error: 'Unauthorized' }); return; }
      const { message, projectId } = request.body || {};
      if (!message || typeof message !== 'string') {
        return reply.code(400).send({ error: 'message is required' });
      }
      const trimmed = (message as string).trim();
      if (!trimmed) return reply.code(400).send({ error: 'message cannot be empty' });

      const threadStore = node.getThreadStore();
      let threadId: string | undefined;

      // Resolve user identity so threads are owned by the authenticated user
      const chatUserId = peerId || undefined;

      // If projectId is provided, skip doorman — route directly to existing project orchestrator
      if (projectId && typeof projectId === 'string') {
        if (threadStore) {
          threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          threadStore.createThread(threadId, trimmed.slice(0, 50), 'project', '', chatUserId);
          threadStore.updateThread(threadId, { projectId });
          await threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'complex' as any });
        }

        // Unified routing — find best PandoCode peer (including self)
        const builder = findBestBuilder();
        if (!builder) {
          const noBuilderReply = 'No PandoCode-capable nodes available on the network. Run /contribute claude-code on a node to enable builds.';
          if (threadStore && threadId) {
            await threadStore.addMessage(threadId, { role: 'assistant', content: noBuilderReply, timestamp: Date.now(), tier: 'simple' as any });
          }
          return { status: 'ok', threadId, reply: noBuilderReply, tier: 'simple' };
        }

        if (builder.isLocal) {
          // Local PandoCode — async engine call
          (async () => {
            try {
              const result = await sendToEngine(trimmed, projectId);
              if (threadStore && threadId && result.response) {
                await threadStore.addMessage(threadId, { role: 'assistant', content: result.response, timestamp: Date.now(), tier: 'complex' as any });
              }
              deps.pushEvent('chat_message', { threadId, projectId, role: 'assistant', content: result.response || 'Build complete.', timestamp: Date.now(), tier: 'complex' });
              // Trigger app-manager update after build — push deploy result back to thread
              const appMgr = node.getAppManager?.();
              if (appMgr && projectId) {
                try {
                  const deployResult = await appMgr.update(projectId);
                  if (deployResult.success) {
                    const app = appMgr.get(projectId);
                    const deployMsg = `App deployed successfully.${app?.deploy_url ? ` URL: ${app.deploy_url}` : ''}${app?.port ? ` Port: ${app.port}` : ''}`;
                    if (threadStore && threadId) {
                      await threadStore.addMessage(threadId, { role: 'assistant', content: deployMsg, timestamp: Date.now(), tier: 'complex' as any });
                    }
                    deps.pushEvent('app_deployed', { threadId, projectId, deployUrl: app?.deploy_url, port: app?.port, status: 'live' });
                    console.log(`[app-manager] Auto-deploy succeeded for ${projectId}`);
                  } else {
                    const failMsg = `Deploy attempted: ${deployResult.error || 'pending remote deployment'}`;
                    if (threadStore && threadId) {
                      await threadStore.addMessage(threadId, { role: 'assistant', content: failMsg, timestamp: Date.now(), tier: 'complex' as any });
                    }
                    deps.pushEvent('app_deploy_status', { threadId, projectId, status: 'failed', error: deployResult.error });
                  }
                } catch (e: any) {
                  console.warn('[app-manager] Auto-update failed:', e.message);
                }
              }
            } catch (err) {
              console.error('[chat] sendToEngine failed:', (err as Error).message);
              if (threadStore && threadId) {
                await threadStore.addMessage(threadId, { role: 'assistant', content: `Engine error: ${(err as Error).message}`, timestamp: Date.now(), tier: 'complex' as any });
              }
            }
          })();
          return { status: 'ok', threadId, projectId, reply: 'AI engine is processing — check the thread for updates.', tier: 'complex', routedTo: builder.peerId };
        }

        // Remote PandoCode peer — route via P2P
        const p2pResult = await node.routeChatProxyP2P?.(trimmed, threadId);
        if (p2pResult) {
          return { status: 'queued', threadId, reply: 'Routed to PandoCode peer. Building — check thread for updates.', tier: 'complex', routedTo: p2pResult.executedBy };
        }
        return { status: 'ok', threadId, reply: 'PandoCode peer did not respond. Try again.', tier: 'simple' };
      }

      // No projectId — doorman handles first contact
      const classification = await deps.doormanClassify(trimmed);

      if (classification.intent === 'simple' || classification.intent === 'question') {
        // Doorman answers directly — no PandoCode engine needed
        const doormanReply = classification.response || 'I can help you build apps or answer questions. Try "build me a todo app"!';
        if (threadStore) {
          threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          threadStore.createThread(threadId, trimmed.slice(0, 50), 'conversation', '', chatUserId);
          await threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'simple' as any });
          await threadStore.addMessage(threadId, { role: 'assistant', content: doormanReply, timestamp: Date.now(), tier: 'simple' as any });
        }
        return { status: 'ok', threadId, reply: doormanReply, tier: 'simple' };
      }

      if (classification.intent === 'report') {
        // User is reporting a bug or requesting a feature — route to appropriate team
        const lawViolation = violatesTwoLaws(trimmed);
        if (lawViolation) {
          return { status: 'ok', threadId: '', reply: lawViolation, tier: 'simple' };
        }
        const adapter = node.getEngineAdapter();
        const targetTeam = classification.targetProject || 'pando-infra';
        const severity = /\b(crash(es|ed|ing)?|critical|down|outage|broken|bug|error|fail(s|ed|ing)?)\b/i.test(trimmed) ? 'BUG' : 'FEATURE';
        const taskTitle = `[${severity}:user] ${(classification.description || trimmed).slice(0, 120)}`;
        const taskId = adapter?.addTeamBoardTask(targetTeam, taskTitle, trimmed.slice(0, 500));
        const reply = taskId
          ? `Thanks for the report! I've added it to the team's board. Task: ${taskId}`
          : `Thanks for the report. The team will review it on the next tick.`;
        threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (threadStore) {
          threadStore.createThread(threadId, trimmed.slice(0, 50), 'conversation', '', chatUserId);
          await threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'simple' as any });
          await threadStore.addMessage(threadId, { role: 'assistant', content: reply, timestamp: Date.now(), tier: 'simple' as any });
        }
        return { status: 'ok', threadId, reply, tier: 'simple' };
      }

      // Intent is 'build' — unified routing: always create project, find best PandoCode peer
      const builder = findBestBuilder();
      if (!builder) {
        threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (threadStore) {
          threadStore.createThread(threadId, trimmed.slice(0, 50), 'conversation', '', chatUserId);
          await threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'complex' as any });
          await threadStore.addMessage(threadId, { role: 'assistant', content: 'No PandoCode-capable nodes available on the network. Run /contribute claude-code on a node to enable builds.', timestamp: Date.now(), tier: 'simple' as any });
        }
        return { status: 'ok', threadId, reply: 'No PandoCode-capable nodes available on the network. Run /contribute claude-code on a node to enable builds.', tier: 'simple' };
      }

      // Always create project first (this node is the router)
      let newProjectId: string | undefined;
      const projectStore = node.getProjectStore?.();
      if (projectStore) {
        try {
          const projName = (classification.description || trimmed).slice(0, 60).replace(/[^a-zA-Z0-9 -]/g, '').trim() || 'New Project';
          const deployTier = (classification.tier === 2) ? 2 : 1;
          const project = await projectStore.createProject({
            name: projName,
            description: classification.description || trimmed,
            ownerId: (await deps.verifyUserJwt(request)) || node.getIdentity()?.peerId || 'anonymous',
            visibility: 'listed',
            tier: deployTier,
          });
          newProjectId = project.id;

          // Set workspace directory so engine + deploy pipeline know where files go
          const { join: joinPath } = await import('node:path');
          const { homedir: getHome } = await import('node:os');
          const wsDir = joinPath(getHome(), '.pando', 'projects', newProjectId);
          await projectStore.updateProject(newProjectId, { workspaceDir: wsDir });

          console.log(`[router] Created project ${newProjectId}: ${projName} (tier ${deployTier}, builder: ${builder.isLocal ? 'local' : builder.peerId})`);

          // Run preflight (auto-generates API key, assigns MongoDB)
          try {
            const pfRes = await fetch(`http://127.0.0.1:${(fastify.server.address() as any)?.port || 4000}/v1/projects/${newProjectId}/preflight`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${deps.apiToken}`, 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(10000),
            });
            if (pfRes.ok) console.log(`[router] Preflight passed for project ${newProjectId}`);
          } catch (pfErr: any) {
            console.log(`[router] Preflight failed: ${pfErr.message} — continuing`);
          }
        } catch (projErr: any) {
          console.log(`[router] Project creation failed: ${projErr.message}`);
        }
      }

      // Create thread linked to project
      if (threadStore) {
        threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        threadStore.createThread(threadId, trimmed.slice(0, 50), 'project', '', chatUserId);
        if (newProjectId) threadStore.updateThread(threadId, { projectId: newProjectId });
        await threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'complex' as any });
      }

      // Route to best builder
      if (builder.isLocal && newProjectId) {
        // Local PandoCode — async engine call (don't block HTTP response)
        (async () => {
          try {
            const result = await sendToEngine(trimmed, newProjectId);
            const engineReply = result.response || 'Build complete.';
            if (threadStore && threadId) {
              await threadStore.addMessage(threadId, { role: 'assistant', content: engineReply, timestamp: Date.now(), tier: 'complex' as any });
            }
            deps.pushEvent('chat_message', { threadId, projectId: newProjectId, role: 'assistant', content: engineReply, timestamp: Date.now(), tier: 'complex' });
            // Trigger app-manager update after build — push deploy result back to thread
            const appMgr = node.getAppManager?.();
            if (appMgr && newProjectId) {
              try {
                const deployResult = await appMgr.update(newProjectId);
                if (deployResult.success) {
                  const app = appMgr.get(newProjectId);
                  const deployMsg = `App deployed successfully.${app?.deploy_url ? ` URL: ${app.deploy_url}` : ''}${app?.port ? ` Port: ${app.port}` : ''}`;
                  if (threadStore && threadId) {
                    await threadStore.addMessage(threadId, { role: 'assistant', content: deployMsg, timestamp: Date.now(), tier: 'complex' as any });
                  }
                  deps.pushEvent('app_deployed', { threadId, projectId: newProjectId, deployUrl: app?.deploy_url, port: app?.port, status: 'live' });
                  console.log(`[app-manager] Auto-deploy succeeded for ${newProjectId}`);
                } else {
                  const failMsg = `Deploy attempted: ${deployResult.error || 'pending remote deployment'}`;
                  if (threadStore && threadId) {
                    await threadStore.addMessage(threadId, { role: 'assistant', content: failMsg, timestamp: Date.now(), tier: 'complex' as any });
                  }
                  deps.pushEvent('app_deploy_status', { threadId, projectId: newProjectId, status: 'failed', error: deployResult.error });
                }
              } catch (e: any) {
                console.warn('[app-manager] Auto-update failed:', e.message);
              }
            }
          } catch (err) {
            console.error('[router] Local engine failed:', (err as Error).message);
            if (threadStore && threadId) {
              await threadStore.addMessage(threadId, { role: 'assistant', content: `Engine error: ${(err as Error).message}`, timestamp: Date.now(), tier: 'complex' as any });
            }
          }
        })();
      } else if (!builder.isLocal) {
        // Remote PandoCode peer — route via P2P
        node.routeChatProxyP2P?.(trimmed, threadId, String(classification.tier || 1)).catch((err: Error) => {
          console.error('[router] P2P routing failed:', err.message);
          if (threadStore && threadId) {
            threadStore.addMessage(threadId, { role: 'assistant', content: 'P2P routing failed. Try again.', timestamp: Date.now(), tier: 'simple' as any });
          }
        });
      }

      return { status: 'ok', threadId, projectId: newProjectId, reply: 'Project created. AI engine is building — check the thread for updates.', tier: 'complex', routedTo: builder.peerId };
    });

    // GET /chat/history — return messages from the most recent thread for this user
    fastify.get('/chat/history', async (request: any) => {
      const threadStore = node.getThreadStore();
      if (!threadStore) return { messages: [] };
      const userId = await deps.verifyUserJwt(request);
      // Use user-scoped query (queryRecords with userId filter) to get only this user's threads
      const threads = userId
        ? await threadStore.listUserThreadsAsync(userId)
        : await threadStore.listThreadsAsync();
      // threads are sorted by updatedAt desc — first is most recent
      if (threads.length > 0) {
        const latest = threads[0];
        const msgs = await threadStore.getMessagesAsync(latest.id);
        return { messages: msgs, threadId: latest.id };
      }
      return { messages: [] };
    });

    // POST /chat/clear — no-op (agents manage their own context)
    fastify.post('/chat/clear', async () => {
      return { success: true };
    });

    // ── Thread API (Phase 27: ThreadStore for gateway chat) ─────────────────

    // GET /chat/threads — list threads (filtered by user, requires authentication)
    fastify.get('/chat/threads', async (request: any) => {
      const threadStore = node.getThreadStore();
      if (!threadStore) return { threads: [] };

      // Require a valid user token — only return threads owned by the authenticated user
      const userId = await deps.verifyUserJwt(request);
      if (userId) {
        // Use async version — reads from storage backend (MongoDB) for cross-node consistency
        const threads = await threadStore.listUserThreadsAsync(userId);
        return { threads };
      }

      // No valid session — return empty list to prevent leaking other users' threads
      return { threads: [] };
    });

    // POST /chat/threads — create a new thread
    fastify.post('/chat/threads', async (request: any, reply: any) => {
      const threadStore = node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });

      const { title, type, encryptionKeys, projectId } = request.body || {};
      const threadTitle = (title || 'New Chat').slice(0, 80);
      const threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // Resolve user ID from token to associate thread with the user
      const userId = (await deps.verifyUserJwt(request)) || undefined;

      // Phase 41: Pass encryptionKeys (peerId -> encrypted threadKey) if provided
      const meta = threadStore.createThread(threadId, threadTitle, projectId ? 'project' : (type || 'conversation'), '', userId, encryptionKeys);
      if (projectId) {
        threadStore.updateThread(threadId, { projectId });
      }
      return meta;
    });

    // GET /chat/threads/:id — get thread messages
    fastify.get('/chat/threads/:id', async (request: any, reply: any) => {
      const threadStore = node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });

      const { id } = request.params || {};
      // Try cache first, then async fallback (for cross-node access via P2P storage)
      const meta = threadStore.getThread(id) || await threadStore.getThreadAsync(id);
      if (!meta) return reply.code(404).send({ error: 'Thread not found' });

      return { ...meta, messages: await threadStore.getMessagesAsync(id) };
    });

    // DELETE /chat/threads/:id — delete a thread
    fastify.delete('/chat/threads/:id', async (request: any, reply: any) => {
      const threadStore = node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });
      const { id } = request.params || {};
      const deleted = threadStore.deleteThread(id);
      if (!deleted) return reply.code(404).send({ error: 'Thread not found' });
      return { success: true, deleted: id };
    });

    // PATCH /chat/threads/:id — update thread metadata
    fastify.patch('/chat/threads/:id', async (request: any, reply: any) => {
      const threadStore = node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });
      const { id } = request.params || {};
      const body = request.body as any || {};
      const updates: any = {};
      if (body.title !== undefined) updates.title = body.title;
      if (body.projectId !== undefined) updates.projectId = body.projectId;
      if (body.archived !== undefined) updates.archived = body.archived;
      if (body.type !== undefined) updates.type = body.type;
      const updated = threadStore.updateThread(id, updates);
      if (!updated) return reply.code(404).send({ error: 'Thread not found' });
      return updated;
    });

    // POST /chat/threads/:id/message — send message in a thread
    fastify.post('/chat/threads/:id/message', async (request: any, reply: any) => {
      const threadStore = node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });

      const { id } = request.params || {};
      const { message, tier, encrypted: isEncrypted, nonce, encryptedThreadKey } = request.body || {};
      if (!message || typeof message !== 'string') {
        return reply.code(400).send({ error: 'message is required' });
      }
      const trimmed = message.trim();
      if (!trimmed) return reply.code(400).send({ error: 'message cannot be empty' });

      // Phase 41.5: If message is encrypted, decrypt it server-side for processing.
      // The encrypted version is stored in the thread for at-rest protection.
      // The encryptedThreadKey is delivered per-request (stateless -- node doesn't store it).
      let plaintextForProcessing = trimmed;
      const threadMeta = threadStore.getThread(id);

      if (isEncrypted && nonce && threadMeta?.encryptionKeys) {
        try {
          plaintextForProcessing = await deps.decryptIncomingMessage(trimmed, nonce, threadMeta, encryptedThreadKey);
        } catch (err: any) {
          console.warn(`[api] Failed to decrypt message for thread ${id}: ${err.message}`);
          // Fall back to treating the content as-is (may be garbled but don't block)
          plaintextForProcessing = trimmed;
        }
      }

      // D#177: Guard against sending ciphertext to AI when decryption fails or is skipped
      if (isEncrypted && plaintextForProcessing === trimmed) {
        const errReply = 'Unable to decrypt your message. Please refresh the page to re-establish encryption.';
        await threadStore.addMessage(id, { role: 'assistant', content: errReply, timestamp: Date.now(), tier: 'simple' as any });
        return { status: 'ok', threadId: id, reply: errReply, tier: 'simple' };
      }

      // Save user message to thread (encrypted form for at-rest protection)
      await threadStore.addMessage(id, {
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
        tier: tier as any,
        encrypted: isEncrypted || false,
        nonce: isEncrypted ? nonce : undefined,
      });

      // ── Phase 68.3: Doorman-routed thread messages ────────────────────────
      // If thread has a projectId, route directly to project manager (no doorman).
      // If no projectId, use doorman to classify intent.
      if (threadMeta?.projectId) {
        // Existing project thread — unified routing to best PandoCode peer
        const builder = findBestBuilder();
        if (!builder) {
          await threadStore.addMessage(id, { role: 'assistant', content: 'No PandoCode-capable nodes available.', timestamp: Date.now(), tier: 'simple' });
          return { status: 'ok', threadId: id, reply: 'No PandoCode-capable nodes available.', tier: 'simple' };
        }
        if (builder.isLocal) {
          // Local PandoCode — async engine
          (async () => {
            try {
              const engineResult = await sendToEngine(plaintextForProcessing, threadMeta.projectId!);
              if (engineResult.response) {
                await threadStore.addMessage(id, { role: 'assistant', content: engineResult.response, timestamp: Date.now(), tier: 'complex' as any });
              }
              deps.pushEvent('chat_message', { threadId: id, projectId: threadMeta.projectId, role: 'assistant', content: engineResult.response || 'Done.', timestamp: Date.now(), tier: 'complex' });
              // Trigger app-manager update after build
              const appMgr = node.getAppManager?.();
              if (appMgr && threadMeta.projectId) {
                appMgr.update(threadMeta.projectId).catch((e: any) => console.warn('[app-manager] Auto-update failed:', e.message));
              }
            } catch (err) {
              console.error('[router] Engine failed:', (err as Error).message);
              await threadStore.addMessage(id, { role: 'assistant', content: `Engine error: ${(err as Error).message}`, timestamp: Date.now(), tier: 'complex' as any });
            }
          })();
          return { status: 'ok', threadId: id, reply: 'Processing — check thread for updates.', tier: 'complex', routedTo: builder.peerId };
        }
        // Remote peer — P2P proxy
        node.routeChatProxyP2P?.(plaintextForProcessing, id).catch(() => {
          threadStore.addMessage(id, { role: 'assistant', content: 'P2P routing failed.', timestamp: Date.now(), tier: 'simple' });
        });
        return { status: 'queued', threadId: id, reply: 'Routed to PandoCode peer — check thread for updates.', tier: 'complex', routedTo: builder.peerId };
      }

      // No projectId — use doorman
      // Smart tier (medium): use multi-turn chat with conversation history
      if (tier === 'medium') {
        const allMessages = await threadStore.getMessagesAsync(id);
        const recentMessages = allMessages
          .filter((m: any) => m.role === 'user' || m.role === 'assistant')
          .filter((m: any) => !m.encrypted) // only use decrypted messages for context
          .slice(0, -1) // exclude the message we just added (last item)
          .slice(-20) // cap to last 20 for context window
          .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
        const smartReply = await deps.doormanChat(plaintextForProcessing, recentMessages);
        if (isEncrypted && threadMeta?.encryptionKeys) {
          try {
            const encReply = await deps.encryptOutgoingMessage(smartReply, threadMeta, encryptedThreadKey);
            await threadStore.addMessage(id, { role: 'assistant', content: encReply.ciphertext, timestamp: Date.now(), tier: 'medium', encrypted: true, nonce: encReply.nonce });
            return { status: 'ok', threadId: id, reply: encReply.ciphertext, tier: 'medium', encrypted: true, nonce: encReply.nonce };
          } catch (err: any) {
            console.warn(`[api] Failed to encrypt smart reply: ${err.message}`);
          }
        }
        await threadStore.addMessage(id, { role: 'assistant', content: smartReply, timestamp: Date.now(), tier: 'medium' });
        return { status: 'ok', threadId: id, reply: smartReply, tier: 'medium' };
      }

      const classification = await deps.doormanClassify(plaintextForProcessing);

      if (classification.intent === 'simple' || classification.intent === 'question') {
        const doormanReply = classification.response || 'Try "build me a todo app" to get started!';
        // Handle encryption if needed
        if (isEncrypted && threadMeta?.encryptionKeys) {
          try {
            const encReply = await deps.encryptOutgoingMessage(doormanReply, threadMeta, encryptedThreadKey);
            await threadStore.addMessage(id, { role: 'assistant', content: encReply.ciphertext, timestamp: Date.now(), tier: 'simple', encrypted: true, nonce: encReply.nonce });
            return { status: 'ok', threadId: id, reply: encReply.ciphertext, tier: 'simple', encrypted: true, nonce: encReply.nonce };
          } catch (err: any) {
            console.warn(`[api] Failed to encrypt doorman reply: ${err.message}`);
          }
        }
        await threadStore.addMessage(id, { role: 'assistant', content: doormanReply, timestamp: Date.now(), tier: 'simple' });
        return { status: 'ok', threadId: id, reply: doormanReply, tier: 'simple' };
      }

      // Build request — unified routing: create project, find best PandoCode peer
      const builder = findBestBuilder();
      if (!builder) {
        await threadStore.addMessage(id, { role: 'assistant', content: 'No PandoCode-capable nodes available on the network.', timestamp: Date.now(), tier: 'simple' });
        return { status: 'ok', threadId: id, reply: 'No PandoCode-capable nodes available on the network.', tier: 'simple' };
      }

      // Always create project first (this node is the router)
      let newProjectId: string | undefined;
      const projectStore = node.getProjectStore?.();
      if (projectStore) {
        try {
          const projName = (classification.description || plaintextForProcessing).slice(0, 60).replace(/[^a-zA-Z0-9 -]/g, '').trim() || 'New Project';
          const deployTier = (classification.tier === 2) ? 2 : 1;
          const project = await projectStore.createProject({
            name: projName,
            description: classification.description || plaintextForProcessing,
            ownerId: (await deps.verifyUserJwt(request)) || node.getIdentity()?.peerId || 'anonymous',
            visibility: 'listed',
            tier: deployTier,
          });
          newProjectId = project.id;
          threadStore.updateThread(id, { projectId: newProjectId });

          // Set workspace directory so engine + deploy pipeline know where files go
          const { join: joinPath } = await import('node:path');
          const { homedir: getHome } = await import('node:os');
          const wsDir = joinPath(getHome(), '.pando', 'projects', newProjectId);
          await projectStore.updateProject(newProjectId, { workspaceDir: wsDir });

          console.log(`[router] Created project ${newProjectId} for thread ${id} (tier ${deployTier}, builder: ${builder.isLocal ? 'local' : builder.peerId})`);

          // Run preflight
          try {
            const pfRes = await fetch(`http://127.0.0.1:${(fastify.server.address() as any)?.port || 4000}/v1/projects/${newProjectId}/preflight`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${deps.apiToken}`, 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(10000),
            });
            if (pfRes.ok) console.log(`[router] Preflight passed for project ${newProjectId}`);
          } catch (pfErr: any) {
            console.log(`[router] Preflight failed: ${pfErr.message}`);
          }
        } catch (projErr: any) {
          console.log(`[router] Project creation failed: ${projErr.message}`);
        }
      }

      const targetProjectId = newProjectId || threadMeta?.projectId;
      if (builder.isLocal && targetProjectId) {
        // Local PandoCode — async engine (don't block HTTP response)
        (async () => {
          try {
            const result = await sendToEngine(plaintextForProcessing, targetProjectId);
            const engineReply = result.response || 'Build complete.';
            await threadStore.addMessage(id, { role: 'assistant', content: engineReply, timestamp: Date.now(), tier: 'complex' as any });
            deps.pushEvent('chat_message', { threadId: id, projectId: targetProjectId, role: 'assistant', content: engineReply, timestamp: Date.now(), tier: 'complex' });
            // Trigger app-manager update after build
            const appMgr = node.getAppManager?.();
            if (appMgr && targetProjectId) {
              appMgr.update(targetProjectId).catch((e: any) => console.warn('[app-manager] Auto-update failed:', e.message));
            }
          } catch (err) {
            console.error('[router] Local engine failed:', (err as Error).message);
            await threadStore.addMessage(id, { role: 'assistant', content: `Engine error: ${(err as Error).message}`, timestamp: Date.now(), tier: 'complex' as any });
          }
        })();
      } else if (!builder.isLocal) {
        // Remote PandoCode peer — route via P2P
        node.routeChatProxyP2P?.(plaintextForProcessing, id, String(classification.tier || 1)).catch((err: Error) => {
          console.error('[router] P2P routing failed:', err.message);
          threadStore.addMessage(id, { role: 'assistant', content: 'P2P routing failed. Try again.', timestamp: Date.now(), tier: 'simple' });
        });
      }

      return { status: 'ok', threadId: id, projectId: targetProjectId, reply: 'Project created. Building — check thread for updates.', tier: 'complex', routedTo: builder.peerId };
    });

    // ── Engine API ──────────────────────────────────────────────────────────

    // GET /engines — list active PandoCode engines
    fastify.get('/engines', async () => {
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return { engines: [] };
      return { engines: adapter.getActiveEngines() };
    });

    // GET /engines/schedules — list scheduler tasks
    fastify.get('/engines/schedules', async () => {
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return { schedules: [] };
      return { schedules: adapter.getSchedules() };
    });

    // ── Capability Declaration API ──────────────────────────────

    // GET /capabilities — local node capability profile (Phase A enriched + Phase 96 local/shared split)
    fastify.get('/capabilities', async () => {
      const identity = node.getIdentity();
      const declaration = node.getCapabilityDeclaration();
      const peerDeclarations = node.getPeerCapabilityDeclarations();

      const peers: Array<{ peerId: string; capabilities: string[]; detectedAt: number; timestamp: number }> = [];
      for (const [peerId, decl] of peerDeclarations) {
        peers.push({
          peerId,
          capabilities: decl.capabilities,
          detectedAt: decl.detectedAt,
          timestamp: decl.timestamp,
        });
      }

      // Phase A: include rich capability profile if available
      const capabilityProfile = node.getCapabilityProfile?.() || null;

      // Phase 96: include local vs shared breakdown
      const localCapStore = node.getLocalCapabilityStore?.() || null;
      const localData = localCapStore?.getData() || null;

      return {
        peerId: identity?.peerId || null,
        capabilities: declaration?.capabilities || node.getCapabilities(),
        detectedAt: declaration?.detectedAt || null,
        peers,
        profile: capabilityProfile,
        // Phase 96: local = all detected (private), shared = what peers see
        local: localData ? { capabilities: localData.capabilities, detectedAt: localData.detectedAt } : null,
        shared: localData ? { capabilities: localData.sharedCapabilities, shareCompute: localData.shareCompute } : null,
      };
    });

    // GET /network/capabilities — all known node capability profiles (Phase A)
    fastify.get('/network/capabilities', async () => {
      const profiles = node.getNetworkCapabilityProfiles?.() || [];
      // Ensure local node's profile is included (Phase 60 fix)
      const localProfile = node.getCapabilityProfile?.();
      if (localProfile && !profiles.some((p: any) => p.peerId === localProfile.peerId)) {
        profiles.unshift(localProfile);
      }
      return {
        count: profiles.length,
        profiles,
      };
    });

    // GET /network/capabilities/user/:username — nodes linked to a specific user (Phase 60)
    fastify.get('/network/capabilities/user/:username', async (request: any) => {
      const { username } = request.params as { username: string };
      const profiles = node.getNetworkCapabilityProfiles?.() || [];
      // Ensure local node's profile is included (Phase 60 fix)
      const localProfile = node.getCapabilityProfile?.();
      if (localProfile && !profiles.some((p: any) => p.peerId === localProfile.peerId)) {
        profiles.unshift(localProfile);
      }
      const userProfiles = profiles.filter(
        (p: any) => p.linkedUser?.username === username
      );
      return {
        count: userProfiles.length,
        profiles: userProfiles,
      };
    });

    // ── Resource Network Routes (Phase B-D) ───────────────────────────

    // GET /resources/routing — routing stats
    fastify.get('/resources/routing', async () => {
      const router = node.getResourceRouter();
      if (!router) return { error: 'ResourceRouter not initialized' };
      return router.getRoutingStats();
    });

    // POST /resources/route — route a task to the best node (requires auth)
    fastify.post('/resources/route', async (request: any, reply: any) => {
      const router = node.getResourceRouter();
      if (!router) return reply.code(503).send({ error: 'ResourceRouter not initialized' });

      const { task, requirements } = request.body || {};
      if (!task || !requirements) {
        return reply.code(400).send({ error: 'task and requirements are required' });
      }

      const result = await router.routeTask(task, requirements);
      return result;
    });

    // GET /resources/metering — current metering readings (network-wide)
    fastify.get('/resources/metering', async (request: any) => {
      const meter = node.getResourceMeter();
      if (!meter) return { error: 'ResourceMeter not initialized' };

      const period = (request.query?.period || 'day') as 'hour' | 'day' | 'week' | 'month';
      return meter.getNetworkUsage(period);
    });

    // GET /resources/metering/:peerId — metering for a specific peer
    fastify.get('/resources/metering/:peerId', async (request: any) => {
      const meter = node.getResourceMeter();
      if (!meter) return { error: 'ResourceMeter not initialized' };

      const { peerId } = request.params;
      const period = (request.query?.period || 'day') as 'hour' | 'day' | 'week' | 'month';
      return meter.getUsage(peerId, period);
    });

    // GET /resources/rewards — reward calculations for local node
    fastify.get('/resources/rewards', async (request: any) => {
      const meter = node.getResourceMeter();
      if (!meter) return { error: 'ResourceMeter not initialized' };

      const identity = node.getIdentity();
      if (!identity) return { error: 'No identity' };

      const period = (request.query?.period || 'day') as 'hour' | 'day' | 'week' | 'month';
      return meter.calculateRewards(identity.peerId, period);
    });

    // GET /resources/marketplace — market stats and local prices
    fastify.get('/resources/marketplace', async () => {
      const marketplace = node.getResourceMarketplace();
      if (!marketplace) return { error: 'ResourceMarketplace not initialized' };

      return {
        localPrices: marketplace.getPrices(),
        stats: marketplace.getMarketStats(),
      };
    });

    // POST /resources/prices — set local prices (requires auth)
    fastify.post('/resources/prices', async (request: any, reply: any) => {
      const marketplace = node.getResourceMarketplace();
      if (!marketplace) return reply.code(503).send({ error: 'ResourceMarketplace not initialized' });

      const { prices } = request.body || {};
      if (!prices || typeof prices !== 'object') {
        return reply.code(400).send({ error: 'prices object is required (resourceType -> pricePerUnit)' });
      }

      for (const [resourceType, pricePerUnit] of Object.entries(prices)) {
        if (typeof pricePerUnit === 'number' && pricePerUnit >= 0) {
          marketplace.setPrice(resourceType, pricePerUnit);
        }
      }

      // Broadcast updated prices
      await marketplace.broadcastPrices();

      return { success: true, prices: marketplace.getPrices() };
    });

    // GET /resources/marketplace/find — find cheapest provider for requirements
    fastify.get('/resources/marketplace/find', async (request: any) => {
      const marketplace = node.getResourceMarketplace();
      if (!marketplace) return { error: 'ResourceMarketplace not initialized' };

      const resourcesParam = request.query?.resources || '';
      const budgetParam = request.query?.budget;

      const requiredResources = resourcesParam
        ? resourcesParam.split(',').map((r: string) => r.trim())
        : [];

      const requirements = { requiredResources };

      if (budgetParam) {
        const budget = parseFloat(budgetParam);
        if (!isNaN(budget) && budget > 0) {
          return {
            matches: marketplace.matchBudget(budget, requirements),
          };
        }
      }

      return marketplace.findCheapest(requirements);
    });

    // ── Capacity Dashboard Endpoint (Phase 49) ────────────────────────

    // GET /capacity — Aggregated capacity dashboard data for the network.
    // Combines supply (marketplace), demand (meter + scheduler), rewards,
    // and network stats into a single response.  Every subsystem call is
    // wrapped in try/catch so partial data is returned when a subsystem
    // is unavailable.
    fastify.get('/capacity', async () => {
      // Unit map for resource types
      const UNIT_MAP: Record<string, string> = {
        relay: 'MB',
        api_keys: 'call',
        compute_cpu: 'minute',
        compute_gpu: 'minute',
        storage: 'GB-hour',
        gateway: '1000 requests',
        validator: 'validation',
        index: 'query',
      };

      // ── Supply ──────────────────────────────────────────────────────
      let supply: any = { totalProviders: 0, resources: {} };
      try {
        const marketplace = node.getResourceMarketplace();
        const capRegistry = node.getCapabilityRegistry();
        const profiles = capRegistry ? capRegistry.getAllProfiles() : [];

        if (marketplace) {
          const stats = marketplace.getMarketStats();
          // stats.totalResources: Record<string, number> (resource -> provider count)
          // stats.averagePrices: Record<string, number>
          // stats.lowestPrices: Record<string, { price: number; peerId: string }>
          // stats.activeProviders: number

          supply.totalProviders = stats.activeProviders;

          // Build per-resource supply info
          const allResourceTypes = new Set([
            ...Object.keys(stats.totalResources || {}),
            ...Object.keys(stats.averagePrices || {}),
          ]);

          for (const rt of allResourceTypes) {
            supply.resources[rt] = {
              providers: (stats.totalResources || {})[rt] || 0,
              averagePrice: (stats.averagePrices || {})[rt] || 0,
              lowestPrice: (stats.lowestPrices || {})[rt]?.price || 0,
              unit: UNIT_MAP[rt] || 'unit',
            };
          }
        } else if (profiles.length > 0) {
          // Marketplace not available but we have capability profiles
          supply.totalProviders = profiles.length;
        }
      } catch (err: any) {
        console.error(`[api] /capacity supply error: ${err.message}`);
      }

      // ── Demand ──────────────────────────────────────────────────────
      let demand: any = {
        period: 'day',
        resources: {},
        tasks: { active: 0, queued: 0, totalProcessed: 0, successRate: 0 },
      };
      try {
        const meter = node.getResourceMeter();
        if (meter) {
          const networkUsage = meter.getNetworkUsage('day');
          // networkUsage.readings: Record<string, { totalUsage, unit, contributingNodes }>
          for (const [rt, reading] of Object.entries(networkUsage.readings || {})) {
            demand.resources[rt] = {
              totalUsage: reading.totalUsage,
              unit: UNIT_MAP[rt] || reading.unit || 'unit',
              contributingNodes: reading.contributingNodes,
            };
          }
        }
      } catch (err: any) {
        console.error(`[api] /capacity demand-meter error: ${err.message}`);
      }

      try {
        const scheduler = node.getScheduler();
        if (scheduler) {
          const status = scheduler.getStatus();
          const totalProcessed = status.totalProcessed || 0;
          const totalSucceeded = status.totalSucceeded || 0;
          const totalFailed = status.totalFailed || 0;

          demand.tasks = {
            active: (status.activeTasks || []).length,
            queued: status.approvedQueueLength || 0,
            totalProcessed,
            successRate: totalProcessed > 0
              ? Math.round((totalSucceeded / totalProcessed) * 10000) / 100
              : 0,
          };
        }
      } catch (err: any) {
        console.error(`[api] /capacity demand-scheduler error: ${err.message}`);
      }

      // ── Rewards ─────────────────────────────────────────────────────
      let rewards: any = { totalDistributed: 0, perResource: {} };
      try {
        const meter = node.getResourceMeter();
        if (meter) {
          const networkUsage = meter.getNetworkUsage('day');
          rewards.totalDistributed = networkUsage.totalRewardsDistributed || 0;

          // Per-resource reward rates and estimated daily earnings
          // Reward rates are defined in resource-meter.ts REWARD_RATES
          const REWARD_RATES: Record<string, number> = {
            relay: 0.001,
            api_keys: 0.01,
            compute_cpu: 0.1,
            compute_gpu: 0.5,
            storage: 0.001,
            gateway: 0.01,
            validator: 0.05,
            index: 0.005,
          };

          for (const [rt, reading] of Object.entries(networkUsage.readings || {})) {
            const rate = REWARD_RATES[rt] || 0;
            const providers = supply.resources[rt]?.providers || 1;
            // Estimated daily per provider = (total daily usage * rate) / providers
            const estimatedDaily = providers > 0
              ? Math.round(((reading.totalUsage * rate) / providers) * 10000) / 10000
              : 0;

            rewards.perResource[rt] = {
              rate,
              estimatedDaily,
            };
          }

          // Also include resource types that have rates but no usage yet
          for (const [rt, rate] of Object.entries(REWARD_RATES)) {
            if (!rewards.perResource[rt]) {
              rewards.perResource[rt] = { rate, estimatedDaily: 0 };
            }
          }
        }
      } catch (err: any) {
        console.error(`[api] /capacity rewards error: ${err.message}`);
      }

      // ── Network ─────────────────────────────────────────────────────
      let network: any = {
        totalNodes: 0,
        totalAccounts: 0,
        totalSupply: 0,
        nodeHealth: 'unknown',
      };
      try {
        const capRegistry = node.getCapabilityRegistry();
        if (capRegistry) {
          network.totalNodes = capRegistry.getAllProfiles().length;
        }
      } catch (err: any) {
        console.error(`[api] /capacity network-caps error: ${err.message}`);
      }

      try {
        const ledger = node.getLedger();
        if (ledger) {
          const stats = ledger.getNetworkStats();
          network.totalAccounts = stats.totalAccounts || 0;
          network.totalSupply = stats.totalSupply || 0;
        }
      } catch (err: any) {
        console.error(`[api] /capacity network-ledger error: ${err.message}`);
      }

      try {
        const monitor = node.getMonitor();
        if (monitor) {
          const metrics = monitor.getCurrentMetrics();
          network.nodeHealth = metrics.nodeHealth || 'unknown';
        }
      } catch (err: any) {
        console.error(`[api] /capacity network-monitor error: ${err.message}`);
      }

      return { supply, demand, rewards, network };
    });

    // ── Network State Endpoint (Phase 50) ──────────────────────────────

    // GET /network-state — aggregated network state snapshot (public, no auth)
    fastify.get('/network-state', async () => {
      const ns = node.getNetworkState?.();
      if (!ns) return { error: 'NetworkState not initialized' };
      return ns.getSnapshot();
    });

    // ── Resource Registry Routes (Phase 42.5) ──────────────────────────

    // GET /resources/health — health check results for all resources (Phase 53.8)
    fastify.get('/resources/health', async () => {
      const checker = node.getResourceHealthChecker?.();
      if (!checker) return { results: [], available: false };
      return { results: checker.getResults(), available: true };
    });

    // GET /resources — list all resources (Phase 69: metadata only, no secrets in records)
    fastify.get('/resources', async (request: any) => {
      const registry = node.getResourceRegistry();
      if (!registry) return { resources: [] };
      const { type } = (request.query || {}) as { type?: string };
      if (type) {
        return { resources: registry.findResources(type as any) };
      }
      return { resources: registry.getAllResources() };
    });

    // POST /resources/register — contribute a new resource (API key, storage, etc.)
    fastify.post('/resources/register', async (request: any, reply: any) => {
      const registry = node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'Resource registry not initialized' });

      const body = request.body as any;
      let { type, credential } = body || {};

      if (!type || !credential) {
        return reply.code(400).send({ error: 'Missing required fields: type, credential' });
      }

      // Phase 60: runtime validation — reject removed resource types
      const VALID_RESOURCE_TYPES = ['ai_api_key', 'storage_db', 'storage_blob', 'cloud_compute', 'hosting_platform', 'code_repository'];
      if (!VALID_RESOURCE_TYPES.includes(type)) {
        return reply.code(400).send({ error: `Invalid resource type '${type}'. Valid types: ${VALID_RESOURCE_TYPES.join(', ')}` });
      }

      // Resolve authenticated user (resources belong to USERS, not nodes)
      const userId = await deps.verifyUserJwt(request) || body.userId;

      const record = await registry.registerResource(type, credential, {
        userId,
        grantedTo: body.grantedTo,
        maxUsagePerDay: body.maxUsagePerDay,
        pricePerUnit: body.pricePerUnit,
        expiresAt: body.expiresAt,
        metadata: body.metadata,
      });

      return { resourceId: record.resourceId, status: record.status, userId: record.userId };
    });

    // POST /resources/:id/revoke — revoke a resource (owner or provider node)
    fastify.post('/resources/:id/revoke', async (request: any, reply: any) => {
      const registry = node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'Resource registry not initialized' });

      const { id } = request.params as { id: string };
      const userId = await deps.verifyUserJwt(request) || undefined;
      const success = await registry.revokeResource(id, userId);
      if (!success) return reply.code(403).send({ error: 'Cannot revoke: not found or not the owner' });
      return { resourceId: id, status: 'revoked' };
    });

    // GET /resources/:id — get a single resource (Phase 69: metadata only)
    fastify.get('/resources/:id', async (request: any, reply: any) => {
      const registry = node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'Resource registry not initialized' });

      const { id } = request.params as { id: string };
      const record = registry.getResource(id);
      if (!record) return reply.code(404).send({ error: 'Resource not found' });
      return record;
    });

    // Phase 69: POST /resources/:id/grant REMOVED — no more per-node granting.
    // Credentials are in MongoDB, decryptable by any compute node with CREDENTIAL_MASTER_KEY.

    // PATCH /resources/:id/owner — link a resource to a user account
    fastify.patch('/resources/:id/owner', async (request: any, reply: any) => {
      const registry = node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'Resource registry not available' });

      const { id } = request.params as { id: string };
      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Authentication required' });

      const success = registry.updateResourceUserId(id, userId, userId);
      if (!success) return reply.code(404).send({ error: 'Resource not found or permission denied' });

      return { success: true, resourceId: id, userId };
    });

    // ── Resource Proxy Routes (Phase 53.2) ──────────────────────────────

    // POST /resource-proxy/validate — validate a project API key and return decrypted MongoDB URI
    fastify.post('/resource-proxy/validate', async (request: any, reply: any) => {
      const body = request.body as { projectKey?: string };
      if (!body?.projectKey || typeof body.projectKey !== 'string') {
        return reply.code(400).send({ error: 'Missing required field: projectKey' });
      }

      const registry = node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'Resource registry not available', valid: false });

      // Phase 63: Try P2P ProjectRegistry first (works on ANY node, no MongoDB needed)
      const projectRegistry = node.getProjectRegistry();
      let projectId: string | null = null;
      let projectResourceIds: string[] = [];

      if (projectRegistry) {
        const record = projectRegistry.validateApiKey(body.projectKey);
        if (record) {
          projectId = record.projectId;
          projectResourceIds = record.resourceIds;
        }
      }

      // Fallback: try ProjectStore (MongoDB) if P2P didn't find it
      if (!projectId) {
        const ps = node.getProjectStore();
        if (ps) {
          const project = await ps.getProjectByApiKeyAsync(body.projectKey);
          if (project) {
            projectId = project.id;
            projectResourceIds = (project.resources || []).map((r: any) => r.resourceId);
          }
        }
      }

      if (!projectId) {
        return reply.code(401).send({ error: 'Invalid project key', valid: false });
      }

      // Find MongoDB resources assigned to this project (type = 'storage_db')
      const dbResources = registry.findResources('storage_db');
      let mongoUri: string | null = null;
      let resourceId: string | null = null;

      // Check for resources specifically granted to this project or to all ('*')
      for (const res of dbResources) {
        // Check if resource metadata references this project
        if (res.metadata?.projectId === projectId || res.grantedTo.includes('*') || res.grantedTo.includes(projectId)) {
          const credential = await registry.getCredential(res.resourceId);
          if (credential) {
            mongoUri = credential;
            resourceId = res.resourceId;
            break;
          }
        }
      }

      // Phase 68.1: No fallback to arbitrary resources. Apps must use their assigned resource.
      // This prevents data leakage between projects sharing the same MongoDB.

      if (!mongoUri) {
        return reply.code(200).send({
          valid: true,
          projectId,
          mongoUri: null,
          resourceId: null,
          error: 'No database resource available',
        });
      }

      return {
        valid: true,
        projectId,
        mongoUri,
        resourceId,
      };
    });

    // POST /resource-proxy/meter — record usage event for Lux billing
    fastify.post('/resource-proxy/meter', async (request: any, reply: any) => {
      const body = request.body as {
        projectId?: string;
        resourceId?: string;
        operation?: string;
        count?: number;
        bytes?: number;
      };

      if (!body?.projectId || !body?.resourceId || !body?.operation) {
        return reply.code(400).send({ error: 'Missing required fields: projectId, resourceId, operation' });
      }

      // Record the usage event (for now, log it — full Lux billing in 53.3)
      const event = {
        projectId: body.projectId,
        resourceId: body.resourceId,
        operation: body.operation,
        count: body.count || 0,
        bytes: body.bytes || 0,
        timestamp: Date.now(),
      };

      console.log(`[resource-proxy] Usage: project=${event.projectId} op=${event.operation} count=${event.count} bytes=${event.bytes}`);

      return { recorded: true, event };
    });

    // ── Cloud Instance Routes (Phase 64) ──────────────────────────────

    // GET /instances — list all managed cloud instances
    fastify.get('/instances', async () => {
      const manager = node.getCloudInstanceManager();
      if (!manager) return { instances: [] };
      return { instances: manager.getInstances() };
    });

    // GET /instances/:id — get a single instance
    fastify.get('/instances/:id', async (request: any, reply: any) => {
      const manager = node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      const instance = manager.getInstance(id);
      if (!instance) return reply.code(404).send({ error: 'Instance not found' });
      return instance;
    });

    // POST /instances/launch — launch a new secure EC2 instance
    fastify.post('/instances/launch', async (request: any, reply: any) => {
      const manager = node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const body = request.body as any;
      if (!body?.resourceId) {
        return reply.code(400).send({ error: 'Missing required field: resourceId' });
      }

      try {
        const record = await manager.launchInstance(body.resourceId, {
          instanceType: body.instanceType,
          region: body.region,
        });
        return record;
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // POST /instances/:id/terminate — terminate a cloud instance
    fastify.post('/instances/:id/terminate', async (request: any, reply: any) => {
      const manager = node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      try {
        await manager.terminateInstance(id);
        return { instanceId: id, status: 'terminated' };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // GET /instances/:id/health — check instance health via AWS API
    fastify.get('/instances/:id/health', async (request: any, reply: any) => {
      const manager = node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      try {
        const health = await manager.checkInstanceHealth(id);
        return { instanceId: id, ...health };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // GET /instances/:id/console — get serial console output (cloud-init logs, boot messages)
    fastify.get('/instances/:id/console', async (request: any, reply: any) => {
      const manager = node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      const { lines } = (request.query || {}) as { lines?: string };
      try {
        const result = await manager.getConsoleOutput(id);
        // Optionally return only the last N lines
        if (lines && result.output) {
          const allLines = result.output.split('\n');
          const n = parseInt(lines, 10) || 50;
          result.output = allLines.slice(-n).join('\n');
        }
        return result;
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // POST /instances/:id/deploy — deploy an app to a compute instance via P2P
    fastify.post('/instances/:id/deploy', async (request: any, reply: any) => {
      const manager = node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      const body = request.body as any;
      if (!body?.projectId) {
        return reply.code(400).send({ error: 'Missing required field: projectId' });
      }

      const instance = manager.getInstance(id);
      if (!instance) return reply.code(404).send({ error: 'Instance not found' });
      if (instance.status !== 'running') {
        return reply.code(409).send({ error: `Instance is ${instance.status}, must be running` });
      }

      try {
        // Auto-inject project credentials as env vars for the deployed app
        const envVars: Record<string, string> = { ...(body.envVars || {}) };
        const gatewayUrl = process.env.GATEWAY_PUBLIC_URL || process.env.GATEWAY_URL || '';
        if (gatewayUrl && !envVars.RESOURCE_PROXY_URL) {
          envVars.RESOURCE_PROXY_URL = `${gatewayUrl}/api/resource-proxy/db`;
        }
        // Look up the project's API key from ProjectStore
        const projectStore = node.getProjectStore?.();
        if (projectStore && !envVars.PROJECT_API_KEY) {
          try {
            const project = projectStore.getProject(body.projectId);
            if (project?.apiKey) {
              envVars.PROJECT_API_KEY = project.apiKey;
            }
          } catch {}
        }
        if (gatewayUrl) {
          envVars.GATEWAY_URL = gatewayUrl;
        }

        const result = await manager.deployApp(id, body.projectId, body.repoUrl, envVars);
        return result;
      } catch (err: any) {
        console.log(`[api] P2P deploy failed: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    });

    // POST /instances/:id/upgrade — upgrade a compute instance via P2P (Phase 67)
    fastify.post('/instances/:id/upgrade', async (request: any, reply: any) => {
      const manager = node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      const instance = manager.getInstance(id);
      if (!instance) return reply.code(404).send({ error: 'Instance not found' });
      if (instance.status !== 'running') {
        return reply.code(409).send({ error: `Instance is ${instance.status}, must be running` });
      }

      try {
        const result = await manager.upgradeInstance(id);
        return { ok: true, instanceId: id, ...result };
      } catch (err: any) {
        console.log(`[api] Instance upgrade failed: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    });

    // ── Content Layer Routes (Phase 11) ──

    // GET /content — list all content (with optional type/status/search query params)
    fastify.get('/content', async (request: any) => {
      const registry = node.getContentRegistry();
      if (!registry) return { content: [], stats: null };

      const { q, type, status, limit } = request.query || {};
      if (q) {
        const results = registry.search(q, parseInt(limit) || 20);
        return { content: results.map((r: any) => r.content), searchResults: results };
      }

      const content = registry.list({
        type: type || undefined,
        status: status || undefined,
        limit: parseInt(limit) || 100,
      });
      return { content };
    });

    // GET /content/search — full-text search
    fastify.get('/content/search', async (request: any) => {
      const registry = node.getContentRegistry();
      if (!registry) return { results: [] };

      const { q, limit } = request.query || {};
      if (!q) return { results: [] };
      const results = registry.search(q, parseInt(limit) || 20);
      return { results };
    });

    // GET /content/stats — content statistics
    fastify.get('/content/stats', async () => {
      const registry = node.getContentRegistry();
      if (!registry) return { totalContent: 0, byType: {}, byStatus: {}, totalLuxEarned: 0 };
      return registry.getStats();
    });

    // GET /content/:id — get specific content record
    fastify.get('/content/:id', async (request: any, reply: any) => {
      const registry = node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const record = registry.get(request.params.id);
      if (!record) return reply.code(404).send({ error: 'Content not found' });
      return record;
    });

    // GET /content/:id/revenue — revenue breakdown for content
    fastify.get('/content/:id/revenue', async (request: any, reply: any) => {
      const registry = node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const revenue = registry.getRevenue(request.params.id);
      if (!revenue) return reply.code(404).send({ error: 'Content not found' });
      return revenue;
    });

    // POST /content — create content record
    fastify.post('/content', async (request: any, reply: any) => {
      const registry = node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const { type, title, description, repoUrl, liveUrl, tags, manifest, status } = request.body || {};
      if (!type || !title) {
        return reply.code(400).send({ error: 'type and title are required' });
      }

      const validTypes = ['website', 'api', 'dataset', 'service', 'document', 'tool'];
      if (!validTypes.includes(type)) {
        return reply.code(400).send({ error: `type must be one of: ${validTypes.join(', ')}` });
      }

      // Dual-auth: use JWT user's peerId if available, fall back to node identity
      const userPeerId = await deps.verifyUserJwt(request);
      const identity = node.getIdentity();
      const ownerPeerId = userPeerId || identity?.peerId;
      const record = registry.create({
        type,
        title,
        description,
        ownerPeerId,
        repoUrl,
        liveUrl,
        tags,
        manifest,
        status,
      });

      return { success: true, contentId: record.contentId, record };
    });

    // PUT /content/:id — update content record (owner check)
    fastify.put('/content/:id', async (request: any, reply: any) => {
      const registry = node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const existing = registry.get(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Content not found' });

      const identity = node.getIdentity();
      if (existing.ownerPeerId !== identity?.peerId) {
        return reply.code(403).send({ error: 'Only the owner can update this content' });
      }

      const { title, description, repoUrl, liveUrl, tags, status, manifest } = request.body || {};
      const updated = registry.update(request.params.id, {
        title, description, repoUrl, liveUrl, tags, status, manifest,
      });

      if (!updated) return reply.code(500).send({ error: 'Update failed' });
      return { success: true, record: updated };
    });

    // DELETE /content/:id — archive content (owner check)
    fastify.delete('/content/:id', async (request: any, reply: any) => {
      const registry = node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const existing = registry.get(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Content not found' });

      const identity = node.getIdentity();
      if (existing.ownerPeerId !== identity?.peerId) {
        return reply.code(403).send({ error: 'Only the owner can archive this content' });
      }

      const archived = registry.archive(request.params.id);
      if (!archived) return reply.code(500).send({ error: 'Archive failed' });
      return { success: true, archived: true };
    });

    // POST /content/:id/publish — trigger publish flow
    fastify.post('/content/:id/publish', async (request: any, reply: any) => {
      const registry = node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const existing = registry.get(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Content not found' });

      const identity = node.getIdentity();
      if (existing.ownerPeerId !== identity?.peerId) {
        return reply.code(403).send({ error: 'Only the owner can publish this content' });
      }

      // Set status to live
      const updated = registry.update(request.params.id, { status: 'live' });
      if (!updated) return reply.code(500).send({ error: 'Publish failed' });
      return { success: true, record: updated };
    });

    // ── Regression Suite API (Phase 17.6) ──────────────────────────

    // GET /regression — Regression suite status and test list
    fastify.get('/regression', async () => {
      const suite = node.getRegressionSuite();
      if (!suite) return { available: false, tests: [], stats: null };
      return {
        available: true,
        stats: suite.getStats(),
        tests: suite.getTests(),
        lastResult: suite.getLastResult(),
      };
    });

    // POST /regression/run — Run full regression suite (requires auth)
    fastify.post('/regression/run', async (request: any) => {
      const suite = node.getRegressionSuite();
      if (!suite) return { error: 'Regression suite not available' };
      const { category, apiUrl } = (request.body || {}) as { category?: string; apiUrl?: string };
      const result = category
        ? await suite.runCategory(category, apiUrl)
        : await suite.runAll(apiUrl);
      return result;
    });

    // GET /regression/results — Last regression run results
    fastify.get('/regression/results', async () => {
      const suite = node.getRegressionSuite();
      if (!suite) return { available: false, result: null };
      return { available: true, result: suite.getLastResult() };
    });

    // GET /gateways — Gateway hosting pool removed (gateway is managed on Vercel separately)
    fastify.get('/gateways', async () => {
      return { gateways: [], total: 0, live: 0, note: 'Gateway hosting pool removed — use AppManager for app deployments' };
    });

    // ── Payment Gate API (Phase 18.6) ──────────────────────────────

    // POST /payment/estimate — Estimate cost for a task description
    fastify.post('/payment/estimate', async (request: any, reply: any) => {
      const gate = node.getPaymentGate();
      if (!gate) return reply.code(503).send({ error: 'Payment gate not available' });
      const { complexity, category } = (request.body || {}) as { complexity?: string; category?: string };
      if (!complexity) {
        return reply.code(400).send({ error: '"complexity" is required (trivial|simple|moderate|complex|project)' });
      }
      const estimate = gate.estimateCost(complexity, category || 'task');
      return estimate;
    });

    // POST /payment/hold — Create payment hold for a task (requires auth)
    fastify.post('/payment/hold', async (request: any, reply: any) => {
      const gate = node.getPaymentGate();
      if (!gate) return reply.code(503).send({ error: 'Payment gate not available' });
      const { peerId, taskId, amount } = (request.body || {}) as { peerId?: string; taskId?: string; amount?: number };
      if (!peerId || !taskId || amount === undefined) {
        return reply.code(400).send({ error: '"peerId", "taskId", and "amount" are required' });
      }
      const hold = gate.holdPayment(peerId, taskId, amount);
      if (!hold) {
        return reply.code(402).send({ error: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE' });
      }
      return hold;
    });

    // GET /payment/history — Payment history (optional peerId filter)
    fastify.get('/payment/history', async (request: any) => {
      const gate = node.getPaymentGate();
      if (!gate) return { history: [] };
      const peerId = (request.query as any)?.peerId;
      return { history: gate.getPaymentHistory(peerId) };
    });

    // GET /payment/stats — Payment statistics
    fastify.get('/payment/stats', async () => {
      const gate = node.getPaymentGate();
      if (!gate) return { stats: null };
      return { stats: gate.getStats() };
    });

    // ── Unified Identity Auth API ──────────────────────────────────────

    // POST /auth/guest — Create a guest identity + issue JWT.
    // Phase 41: Accepts browser-generated { publicKey } so private key never leaves the browser.
    // Phase 86: Returns a JWT instead of a session token.
    fastify.post('/auth/guest', async (request: any, reply: any) => {
      const store = node.getUserAccountStore();
      if (!store) return reply.code(503).send({ error: 'User accounts not available' });

      const body = (request.body || {}) as { peerId?: string; publicKey?: string };

      let result: any;

      if (body.publicKey) {
        // Phase 41: Browser-generated keypair — derive peerId from public key, register
        const { peerIdFromPublicKey } = await import('@libp2p/peer-id');
        const rawPub = uint8ArrayFromString(body.publicKey, 'base64');
        const proto = new Uint8Array(4 + rawPub.length);
        proto[0] = 0x08; proto[1] = 0x01; proto[2] = 0x12; proto[3] = rawPub.length;
        proto.set(rawPub, 4);
        const pk = publicKeyFromProtobuf(proto);
        const derivedPeerId = peerIdFromPublicKey(pk).toString();

        result = await store.createGuestFromBrowserKey({
          peerId: derivedPeerId,
          publicKey: body.publicKey,
        });
      } else {
        // Legacy: server-side key generation (no encryption support)
        result = await store.createGuest();
      }

      if (!result.success) {
        return reply.code(500).send({ error: result.error });
      }

      // Phase 86: Issue JWT instead of returning the session token from UserAccountStore
      const jwt = await deps.issueJwt(result.peerId);
      return {
        success: true,
        token: jwt.token,
        expiresAt: jwt.expiresAt,
        peerId: result.peerId,
        publicKey: result.publicKey,
        isClaimed: false,
        isNewAccount: result.isNewAccount,
      };
    });

    // POST /auth/claim — Upgrade a guest account to a claimed account (set password + optional username)
    // Phase 86: Uses JWT to identify the user, issues a new JWT on success.
    fastify.post('/auth/claim', async (request: any, reply: any) => {
      const store = node.getUserAccountStore();
      if (!store) return reply.code(503).send({ error: 'User accounts not available' });

      // Phase 86: Verify JWT to get the user's peerId
      const userPeerId = await deps.verifyUserJwt(request);
      if (!userPeerId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      const { password, username } = (request.body || {}) as {
        password?: string;
        username?: string;
      };

      if (!password) {
        return reply.code(400).send({ error: 'password is required' });
      }

      // Phase 86: claim() now takes peerId directly instead of a session token
      const result = await store.claimByPeerId(userPeerId, password, username);

      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }

      // Phase 56: ledger account already exists (created during guest creation)

      // Phase 57 FIX: Welcome bonus moved here from POST /auth/guest.
      // Only mint GUEST_WELCOME when a guest CLAIMS an account (registers).
      // This is a one-time event — the claim() method already rejects if already claimed.
      // Extra safety: check ledger balance to avoid double-granting if claim is replayed.
      const ledger = node.getLedger();
      if (ledger && result.peerId) {
        try {
          const currentBalance = ledger.accounts.getBalance(result.peerId);
          if (currentBalance <= 0) {
            const { WorkType } = await import('@pando/shared');
            const tx = ledger.rewardWork(result.peerId, WorkType.GUEST_WELCOME, 'welcome: account registration');
            console.log(`[faucet] New user ${result.username || result.peerId.slice(0, 16) + '...'} granted ${tx.amount} Lux (welcome)`);
            // Broadcast so other nodes see the emission
            const sync = node.getSync();
            if (sync) sync.broadcastTransaction(tx).catch(() => {});
          }
        } catch (err: any) {
          // Non-fatal — claim succeeded, just no welcome Lux
          console.error(`[faucet] Welcome grant on claim failed: ${err.message}`);
        }
      }

      // Broadcast account claim with current balance AFTER welcome bonus is minted.
      if (result.peerId && ledger) {
        const sync = node.getSync();
        if (sync) {
          const authFields = ledger.accounts.getAuthFields(result.peerId);
          const finalBalance = ledger.accounts.getBalance(result.peerId);
          sync.broadcastClaim({
            peerId: result.peerId,
            username: result.username || null,
            displayName: null,
            passwordHash: authFields?.passwordHash || '',
            claimedAt: Date.now(),
            balance: finalBalance,
          }).catch(() => {});
        }
      }

      // Phase 86: Issue fresh JWT for the now-claimed account
      const jwt = await deps.issueJwt(result.peerId!);
      return { ...result, token: jwt.token, expiresAt: jwt.expiresAt };
    });

    // POST /auth/login — Login with username or peerId + password
    // Phase 86: Returns a JWT instead of a session token.
    fastify.post('/auth/login', async (request: any, reply: any) => {
      const store = node.getUserAccountStore();
      if (!store) return reply.code(503).send({ error: 'User accounts not available' });

      const { identifier, password } = (request.body || {}) as {
        identifier?: string;
        password?: string;
      };

      if (!identifier || !password) {
        return reply.code(400).send({ error: 'identifier and password are required' });
      }

      try {
        const result = await store.login(identifier, password);

        if (!result.success) {
          return reply.code(401).send({ error: result.error });
        }

        // Phase 86: Issue JWT instead of returning session token from UserAccountStore
        const jwt = await deps.issueJwt(result.peerId!);
        return { ...result, token: jwt.token, expiresAt: jwt.expiresAt };
      } catch (err: any) {
        console.error('[api] Login error:', err.message);
        return reply.code(500).send({ error: err.message || 'Login failed' });
      }
    });

    // POST /auth/logout — Phase 86: Server-side no-op. JWT is stateless — client discards it.
    fastify.post('/auth/logout', async () => {
      return { success: true };
    });

    // POST /auth/backup-key — Store encrypted private key backup (Phase 41.5: multi-device)
    fastify.post('/auth/backup-key', async (request: any, reply: any) => {
      const store = node.getUserAccountStore();
      if (!store) return reply.code(503).send({ error: 'User accounts not available' });

      const peerId = await deps.verifyUserJwt(request);
      if (!peerId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      const { encryptedKey } = (request.body || {}) as { encryptedKey?: string };
      if (!encryptedKey || typeof encryptedKey !== 'string') {
        return reply.code(400).send({ error: 'encryptedKey is required' });
      }

      await store.storeEncryptedKey(peerId, encryptedKey);
      return { success: true };
    });

    // GET /auth/backup-key — Retrieve encrypted private key backup (Phase 41.5: multi-device)
    fastify.get('/auth/backup-key', async (request: any, reply: any) => {
      const store = node.getUserAccountStore();
      if (!store) return reply.code(503).send({ error: 'User accounts not available' });

      const peerId = await deps.verifyUserJwt(request);
      if (!peerId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      const encryptedKey = await store.getEncryptedKey(peerId);
      return { encryptedKey: encryptedKey || null };
    });

    // GET /auth/me — Get current user profile + Lux balance (requires valid JWT)
    // Phase 86: Simple JWT decode — fully stateless, no DB lookup.
    fastify.get('/auth/me', async (request: any, reply: any) => {
      const peerId = await deps.verifyUserJwt(request);
      if (!peerId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      const ledger = node.getLedger();
      let balance = 0;
      let publicKey = '';
      let username: string | undefined;
      let isClaimed = false;
      if (ledger) {
        balance = ledger.accounts.getBalance(peerId);
        const account = ledger.accounts.get(peerId);
        if (account) publicKey = account.publicKey;
        // Fallback: if publicKey is the placeholder 'remote-peer', extract real key from peerId
        if (!publicKey || publicKey === 'remote-peer') {
          try {
            const { peerIdFromString } = await import('@libp2p/peer-id');
            const peerIdObj = peerIdFromString(peerId);
            if (peerIdObj.publicKey?.raw) {
              publicKey = Buffer.from(peerIdObj.publicKey.raw).toString('base64');
            }
          } catch {
            // Leave as-is if extraction fails
          }
        }
        const authFields = ledger.accounts.getAuthFields(peerId);
        if (authFields) {
          username = authFields.username || undefined;
          isClaimed = authFields.isClaimed;
        }
      }
      return {
        user: { peerId, publicKey, username, isClaimed, balance, authMethod: 'jwt' },
      };
    });

    // POST /auth/refresh — Phase 86: Issue a fresh JWT if the current one is still valid.
    fastify.post('/auth/refresh', async (request: any, reply: any) => {
      const peerId = await deps.verifyUserJwt(request);
      if (!peerId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }
      const jwt = await deps.issueJwt(peerId);
      return { success: true, token: jwt.token, expiresAt: jwt.expiresAt, peerId };
    });

    // GET /auth/stats — Identity statistics (public)
    fastify.get('/auth/stats', async () => {
      const store = node.getUserAccountStore();
      if (!store) return { stats: null };
      return { stats: store.getStats() };
    });

    // ── Phase 86: Stateless JWT Auth (Challenge-Response) ──────────────

    // POST /auth/challenge — Issue a signed challenge token (stateless, no in-memory store)
    fastify.post('/auth/challenge', async (request: any, reply: any) => {
      const { peerId } = (request.body || {}) as { peerId?: string };
      if (!peerId || typeof peerId !== 'string') {
        return reply.code(400).send({ error: 'peerId is required' });
      }

      const identity = node.getIdentity();
      if (!identity) {
        return reply.code(503).send({ error: 'Node identity not available' });
      }

      const nonce = randomBytes(32).toString('hex');
      const challengePayload = {
        nonce,
        sub: peerId,
        iss: identity.peerId,
        exp: Date.now() + 60_000, // 60-second TTL
        typ: 'challenge',
      };

      const payloadB64 = Buffer.from(JSON.stringify(challengePayload)).toString('base64url');
      const payloadBytes = new TextEncoder().encode(payloadB64);

      const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
      const pk = privateKeyFromProtobuf(identity.privateKey);
      const sig = await pk.sign(payloadBytes);
      const signatureHex = uint8ArrayToString(sig, 'base16');

      const challengeToken = payloadB64 + '.' + signatureHex;
      return { challengeToken, nonce, expiresAt: challengePayload.exp };
    });

    // POST /auth/verify — Verify a signed challenge + user signature, issue JWT
    // Fully stateless: challenge token is self-verifying, can hit ANY node
    fastify.post('/auth/verify', async (request: any, reply: any) => {
      const { peerId, challengeToken, signature } = (request.body || {}) as {
        peerId?: string;
        challengeToken?: string;
        signature?: string;
      };

      if (!peerId || !challengeToken || !signature) {
        return reply.code(400).send({ error: 'peerId, challengeToken, and signature are required' });
      }

      // 1. Parse and verify the challenge token
      const dotIdx = challengeToken.indexOf('.');
      if (dotIdx === -1) return reply.code(400).send({ error: 'Invalid challenge token format' });

      const cPayloadB64 = challengeToken.substring(0, dotIdx);
      const cSigHex = challengeToken.substring(dotIdx + 1);

      let challengePayload: any;
      try {
        challengePayload = JSON.parse(Buffer.from(cPayloadB64, 'base64url').toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'Invalid challenge token payload' });
      }

      if (!challengePayload.exp || challengePayload.exp <= Date.now()) {
        return reply.code(401).send({ error: 'Challenge expired' });
      }
      if (challengePayload.typ !== 'challenge') {
        return reply.code(400).send({ error: 'Invalid token type' });
      }
      if (challengePayload.sub !== peerId) {
        return reply.code(401).send({ error: 'Challenge was issued for a different peerId' });
      }

      // Verify challenge token signature — extract issuer's public key from peerId
      // (Ed25519 peerIds embed the full public key, no ledger lookup needed)
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const issuerPeerIdObj = peerIdFromString(challengePayload.iss);
        const issuerPubKey = issuerPeerIdObj.publicKey;
        if (!issuerPubKey) {
          return reply.code(401).send({ error: 'Cannot extract public key from challenge issuer peerId' });
        }

        const cPayloadBytes = new TextEncoder().encode(cPayloadB64);
        const cSigBytes = uint8ArrayFromString(cSigHex, 'base16');
        const challengeValid = await issuerPubKey.verify(cPayloadBytes, cSigBytes);
        if (!challengeValid) {
          return reply.code(401).send({ error: 'Challenge token signature invalid' });
        }
      } catch (err: any) {
        return reply.code(401).send({ error: 'Challenge verification error', detail: err?.message });
      }

      // 2. Verify the user's signature over the nonce
      // Extract user's public key from their peerId (Ed25519 peerIds embed the full public key)
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const userPeerIdObj = peerIdFromString(peerId);
        const userPubKey = userPeerIdObj.publicKey;
        if (!userPubKey) {
          return reply.code(401).send({ error: 'Cannot extract public key from user peerId' });
        }

        const nonceBytes = uint8ArrayFromString(challengePayload.nonce, 'base16');
        const sigBytes = uint8ArrayFromString(signature, 'base16');
        const userValid = await userPubKey.verify(nonceBytes, sigBytes);
        if (!userValid) {
          return reply.code(401).send({ error: 'Signature verification failed' });
        }
      } catch (err: any) {
        return reply.code(401).send({ error: 'Signature verification error', detail: err?.message });
      }

      // 3. Issue a JWT signed by THIS node
      const jwt = await deps.issueJwt(peerId);
      return jwt;
    });

    // ── Project Economy (Phase 31.1) ─────────────────────────────────────

    // GET /projects — List user's projects (owned + collaborating)
    fastify.get('/projects', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (userId) {
        const owned = await ps.getProjectsByOwnerAsync(userId);
        const collab = await ps.getProjectsByCollaboratorAsync(userId);
        return { projects: [...owned, ...collab] };
      }

      // No valid user token — return listed/featured public projects
      const query = request.query as any;
      const projects = await ps.listProjectsAsync({
        visibility: query.visibility || 'listed',
        status: 'active',
        limit: parseInt(query.limit) || 50,
        offset: parseInt(query.offset) || 0,
      });
      return { projects };
    });

    // GET /projects/stats — Public project statistics
    fastify.get('/projects/stats', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });
      return { stats: await ps.getStatsAsync() };
    });

    // GET /projects/:id — Get project detail
    fastify.get('/projects/:id', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      let project;
      try {
        project = await ps.getProjectAsync(id);
      } catch (err: any) {
        return reply.code(503).send({ error: 'Storage backend unavailable' });
      }
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Check access
      const userId = await deps.verifyUserJwt(request);

      // Public projects are visible to all; private projects require access
      if (project.type !== 'public' && project.visibility === 'owner_only') {
        if (!userId || !(await ps.hasAccessAsync(id, userId))) {
          return reply.code(403).send({ error: 'Access denied' });
        }
      }

      let collaborators: any[] = [];
      try {
        collaborators = await ps.getCollaboratorsAsync(id);
      } catch {}
      return { project, collaborators };
    });

    // POST /projects — Create a new project
    // Auth: user session token OR node Bearer token (Phase 66: agents can create projects)
    fastify.post('/projects', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Phase 66: dual-auth — user session OR node Bearer token (same pattern as /projects/:id/resources/assign)
      let ownerId = await deps.verifyUserJwt(request);
      if (!ownerId) {
        const authHeader = request.headers?.authorization || '';
        const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === deps.apiToken;
        if (hasBearerToken) {
          ownerId = node.getIdentity()?.peerId || '';
        }
        if (!ownerId) return reply.code(401).send({ error: 'Authentication required (user session or Bearer token)' });
      }

      const body = (request.body || {}) as {
        name?: string;
        description?: string;
        type?: string;
        visibility?: string;
        budgetLimit?: number;
        tier?: number;
      };

      if (!body.name || body.name.trim().length === 0) {
        return reply.code(400).send({ error: 'Project name is required' });
      }

      const project = await ps.createProject({
        name: body.name.trim(),
        description: body.description || '',
        ownerId,
        type: (body.type as any) || 'private',
        visibility: (body.visibility as any) || 'owner_only',
        budgetLimit: body.budgetLimit || 0,
        ...(body.tier ? { tier: body.tier as 1 | 2 } : {}),
      });

      return reply.code(201).send({ project });
    });

    // PATCH /projects/:id — Update project (owner/admin only)
    fastify.patch('/projects/:id', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can update project' });
      }

      const body = (request.body || {}) as {
        name?: string;
        description?: string;
        type?: string;
        visibility?: string;
        budgetLimit?: number;
        tier?: number;
        repoUrl?: string;
      };

      const updates: any = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.type !== undefined) updates.type = body.type;
      if (body.visibility !== undefined) updates.visibility = body.visibility;
      if (body.budgetLimit !== undefined) updates.budgetLimit = body.budgetLimit;
      if (body.tier !== undefined) updates.tier = body.tier;
      if (body.repoUrl !== undefined) updates.repoUrl = body.repoUrl;

      const project = await ps.updateProject(id, updates);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      return { project };
    });

    // POST /projects/:id/collaborators — Add collaborator (owner/admin only)
    fastify.post('/projects/:id/collaborators', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can add collaborators' });
      }

      const body = (request.body || {}) as { userId?: string; role?: string };
      if (!body.userId) {
        return reply.code(400).send({ error: 'userId is required' });
      }

      const collabRole = (body.role || 'collaborator') as any;
      const validRoles = ['admin', 'collaborator', 'viewer', 'qa_lead'];
      if (!validRoles.includes(collabRole)) {
        return reply.code(400).send({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
      }

      await ps.addCollaborator(id, body.userId, collabRole, userId);
      return { success: true };
    });

    // DELETE /projects/:id/collaborators/:userId — Remove collaborator (owner/admin only)
    fastify.delete('/projects/:id/collaborators/:userId', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const authUserId = await deps.verifyUserJwt(request);
      if (!authUserId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id, userId: targetUserId } = request.params as { id: string; userId: string };
      const role = await ps.getUserRoleAsync(id, authUserId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can remove collaborators' });
      }

      // Cannot remove the owner
      const project = await ps.getProjectAsync(id);
      if (project && targetUserId === project.ownerId) {
        return reply.code(400).send({ error: 'Cannot remove the project owner' });
      }

      await ps.removeCollaborator(id, targetUserId);
      return { success: true };
    });

    // GET /projects/:id/collaborators — List collaborators
    fastify.get('/projects/:id/collaborators', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const collaborators = await ps.getCollaboratorsAsync(id);
      return { collaborators };
    });

    // ── Phase 31.5: Collaboration Enhancement (Invites) ──────────────────

    // POST /projects/:id/invite — Generate an invite link/code (owner/admin only)
    fastify.post('/projects/:id/invite', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can create invites' });
      }

      const body = (request.body || {}) as {
        role?: string;
        expiresInHours?: number;
        maxUses?: number;
      };

      const inviteRole = (body.role || 'collaborator') as any;
      const validRoles = ['admin', 'collaborator', 'viewer', 'qa_lead'];
      if (!validRoles.includes(inviteRole)) {
        return reply.code(400).send({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
      }

      const invite = await ps.createInvite(id, inviteRole, userId, {
        expiresInHours: body.expiresInHours,
        maxUses: body.maxUses,
      });

      return reply.code(201).send({ invite });
    });

    // POST /projects/join/:code — Join a project via invite code
    fastify.post('/projects/join/:code', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { code } = request.params as { code: string };
      const result = await ps.useInvite(code, userId);

      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }

      return { success: true, projectId: result.projectId, role: result.role };
    });

    // GET /projects/:id/invites — List active invites (owner/admin only)
    fastify.get('/projects/:id/invites', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can view invites' });
      }

      const invites = await ps.getProjectInvitesAsync(id);
      return { invites };
    });

    // DELETE /projects/:id/invites/:inviteId — Revoke an invite (owner/admin only)
    fastify.delete('/projects/:id/invites/:inviteId', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id, inviteId } = request.params as { id: string; inviteId: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can revoke invites' });
      }

      const success = await ps.revokeInvite(inviteId);
      if (!success) return reply.code(404).send({ error: 'Invite not found' });

      return { success: true };
    });

    // ── Phase 31.6: Ownership Transfer ───────────────────────────────────

    // POST /projects/:id/transfer — Initiate ownership transfer (owner only)
    fastify.post('/projects/:id/transfer', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (role !== 'owner') {
        return reply.code(403).send({ error: 'Only the project owner can initiate a transfer' });
      }

      const body = (request.body || {}) as {
        toUserId?: string;
        type?: string;
        salePrice?: number;
      };

      if (!body.toUserId) {
        return reply.code(400).send({ error: 'toUserId is required' });
      }

      const transferType = (body.type || 'direct') as any;
      const validTypes = ['direct', 'sale', 'network'];
      if (!validTypes.includes(transferType)) {
        return reply.code(400).send({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
      }

      // For direct transfers, validate the target user exists
      if (transferType === 'direct') {
        const accountStore = node.getUserAccountStore();
        const targetUser = accountStore ? await accountStore.getIdentityByPeerId(body.toUserId) : null;
        if (!targetUser) {
          return reply.code(404).send({ error: 'Target user not found' });
        }
      }

      // For sales, create an escrow hold if PaymentGate is available
      let escrowHoldId = '';
      if (transferType === 'sale' && body.salePrice && body.salePrice > 0) {
        const paymentGate = node.getPaymentGate();
        if (paymentGate) {
          const hold = paymentGate.holdPayment(body.toUserId, `transfer-${id}`, body.salePrice);
          if (!hold) {
            return reply.code(402).send({ error: 'Buyer has insufficient Lux balance for this sale' });
          }
          escrowHoldId = hold.holdId;
        }
      }

      const transfer = await ps.initiateTransfer(
        id,
        userId,
        body.toUserId,
        transferType,
        body.salePrice,
        escrowHoldId,
      );

      return reply.code(201).send({ transfer });
    });

    // POST /projects/transfers/:id/complete — Complete a transfer (buyer confirms for sales)
    fastify.post('/projects/transfers/:id/complete', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id: transferId } = request.params as { id: string };
      const transfer = await ps.getTransferAsync(transferId);
      if (!transfer) return reply.code(404).send({ error: 'Transfer not found' });

      // For sales, only the buyer (toUser) can complete; for direct, either party
      if (transfer.transferType === 'sale') {
        if (userId !== transfer.toUser) {
          return reply.code(403).send({ error: 'Only the buyer can confirm a sale transfer' });
        }
      } else {
        if (userId !== transfer.fromUser && userId !== transfer.toUser) {
          return reply.code(403).send({ error: 'Only the sender or recipient can complete this transfer' });
        }
      }

      // Release escrow if this was a sale
      if (transfer.escrowHoldId) {
        const paymentGate = node.getPaymentGate();
        if (paymentGate) {
          paymentGate.releasePayment(transfer.escrowHoldId, transfer.fromUser);
        }
      }

      const completed = await ps.completeTransfer(transferId);
      if (!completed) return reply.code(400).send({ error: 'Transfer cannot be completed (not pending)' });

      return { transfer: completed };
    });

    // POST /projects/transfers/:id/cancel — Cancel a transfer
    fastify.post('/projects/transfers/:id/cancel', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id: transferId } = request.params as { id: string };
      const transfer = await ps.getTransferAsync(transferId);
      if (!transfer) return reply.code(404).send({ error: 'Transfer not found' });

      // Only the initiator (fromUser) can cancel
      if (userId !== transfer.fromUser) {
        return reply.code(403).send({ error: 'Only the transfer initiator can cancel' });
      }

      // Refund escrow if this was a sale
      if (transfer.escrowHoldId) {
        const paymentGate = node.getPaymentGate();
        if (paymentGate) {
          paymentGate.refundPayment(transfer.escrowHoldId);
        }
      }

      const cancelled = await ps.cancelTransfer(transferId);
      if (!cancelled) return reply.code(400).send({ error: 'Transfer cannot be cancelled (not pending)' });

      return { transfer: cancelled };
    });

    // GET /projects/:id/transfers — Transfer history
    fastify.get('/projects/:id/transfers', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const transfers = await ps.getProjectTransfersAsync(id);
      return { transfers };
    });

    // ── Phase 31.4: Revenue Engine Routes ────────────────────────────────

    // GET /projects/:id/revenue — Revenue summary
    fastify.get('/projects/:id/revenue', async (request: any, reply: any) => {
      const engine = node.getRevenueEngine();
      if (!engine) return reply.code(503).send({ error: 'Revenue engine not available' });

      const { id } = request.params as { id: string };
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const summary = await engine.getRevenueSummaryAsync(id);
      return { summary };
    });

    // GET /projects/:id/revenue/history — Revenue event history
    fastify.get('/projects/:id/revenue/history', async (request: any, reply: any) => {
      const engine = node.getRevenueEngine();
      if (!engine) return reply.code(503).send({ error: 'Revenue engine not available' });

      const { id } = request.params as { id: string };
      const query = request.query as any;

      const records = await engine.getProjectRevenueAsync(id, {
        since: query.since ? parseInt(query.since) : undefined,
        until: query.until ? parseInt(query.until) : undefined,
      });
      return { records };
    });

    // POST /projects/:id/revenue/distribute — Trigger revenue distribution (owner/admin only)
    fastify.post('/projects/:id/revenue/distribute', async (request: any, reply: any) => {
      const engine = node.getRevenueEngine();
      if (!engine) return reply.code(503).send({ error: 'Revenue engine not available' });

      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can distribute revenue' });
      }

      const result = await engine.distributeRevenue(id, ps);
      return { result };
    });

    // GET /projects/:id/revenue/distributions — Distribution history
    fastify.get('/projects/:id/revenue/distributions', async (request: any, reply: any) => {
      const engine = node.getRevenueEngine();
      if (!engine) return reply.code(503).send({ error: 'Revenue engine not available' });

      const { id } = request.params as { id: string };
      const distributions = await engine.getDistributionHistoryAsync(id);
      return { distributions };
    });

    // ── Phase 31.7: Deployment Automation ─────────────────────────────────
    // NOTE: POST /projects/:id/deploy moved to Phase 70 unified deploy section (near preflight).
    // Old endpoint created a deployment record — new endpoint actually deploys.

    // GET /projects/:id/deployments — List deployment history
    fastify.get('/projects/:id/deployments', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const deployments = await ps.getDeploymentsAsync(id);
      return { deployments };
    });

    // POST /projects/:id/deployments/:deployId/status — Update deployment status (for agents)
    fastify.post('/projects/:id/deployments/:deployId/status', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id, deployId } = request.params as { id: string; deployId: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can update deployment status' });
      }

      const body = (request.body || {}) as {
        status?: string;
        url?: string;
        error?: string;
      };

      if (!body.status) {
        return reply.code(400).send({ error: 'status is required' });
      }

      const validStatuses = ['pending', 'deploying', 'live', 'failed', 'rolled_back'];
      if (!validStatuses.includes(body.status)) {
        return reply.code(400).send({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      }

      await ps.updateDeploymentStatus(deployId, body.status as any, body.url, body.error);
      return { success: true };
    });

    // ── Phase 31.8: Project Marketplace ───────────────────────────────────

    // GET /marketplace — Public marketplace listing (enriched with deployment info)
    fastify.get('/marketplace', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const query = request.query as any;
      const result = await ps.getMarketplaceAsync({
        category: query.category || undefined,
        sortBy: query.sort || undefined,
        search: query.search || undefined,
        limit: query.limit ? parseInt(query.limit) : undefined,
        offset: query.offset ? parseInt(query.offset) : undefined,
      });

      // Enrich with AppManager deployment data (deploy_url, status, tier)
      const appMgr = node.getAppManager?.();
      if (appMgr && result.projects) {
        for (const proj of result.projects) {
          const app = appMgr.get(proj.id);
          if (app) {
            (proj as any).deployment = {
              status: app.status,
              url: app.deploy_url,
              port: app.port,
              tier: app.tier,
              commit: app.current_commit,
              deployedAt: app.deployed_at,
            };
          }
        }
      }

      return result;
    });

    // GET /marketplace/:id — Public project detail (only if listed/featured)
    fastify.get('/marketplace/:id', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      if (project.visibility !== 'listed' && project.visibility !== 'featured') {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const collaborators = await ps.getCollaboratorsAsync(id);
      const ratingsSummary = await ps.getProjectRatingsAsync(id);

      // Enrich with AppManager deployment data
      const appMgr = node.getAppManager?.();
      const app = appMgr?.get(id);
      const deployment = app ? {
        status: app.status,
        url: app.deploy_url,
        port: app.port,
        tier: app.tier,
        commit: app.current_commit,
        deployedAt: app.deployed_at,
      } : undefined;

      return { project, collaborators, ratings: ratingsSummary, deployment };
    });

    // POST /projects/:id/rate — Rate a project (user token required)
    fastify.post('/projects/:id/rate', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const body = (request.body || {}) as { rating?: number; review?: string };
      if (!body.rating || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
        return reply.code(400).send({ error: 'Rating must be an integer between 1 and 5' });
      }

      await ps.rateProject(id, userId, body.rating, body.review);
      return { success: true };
    });

    // GET /projects/:id/ratings — Get ratings for a project
    fastify.get('/projects/:id/ratings', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const ratingsSummary = await ps.getProjectRatingsAsync(id);
      return ratingsSummary;
    });

    // ── Phase 31.9: Contribution Tracking ─────────────────────────────────

    // GET /projects/:id/contributions — List contributions
    fastify.get('/projects/:id/contributions', async (request: any, reply: any) => {
      const tracker = node.getContributionTracker();
      if (!tracker) return reply.code(503).send({ error: 'Contribution tracker not available' });

      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const query = request.query as any;
      const contributions = await tracker.getContributionsAsync(id, {
        userId: query.userId || undefined,
        verified: query.verified !== undefined ? query.verified === 'true' : undefined,
      });

      return { contributions };
    });

    // POST /projects/:id/contributions — Record a contribution (owner/admin/collaborator)
    fastify.post('/projects/:id/contributions', async (request: any, reply: any) => {
      const tracker = node.getContributionTracker();
      if (!tracker) return reply.code(503).send({ error: 'Contribution tracker not available' });

      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role) {
        return reply.code(403).send({ error: 'Must be a project collaborator to record contributions' });
      }

      const body = (request.body || {}) as {
        type?: string;
        description?: string;
        weight?: number;
        agentId?: string;
        userId?: string;
      };

      if (!body.type) {
        return reply.code(400).send({ error: 'Contribution type is required' });
      }

      const validTypes = ['code', 'review', 'test', 'design', 'management', 'documentation'];
      if (!validTypes.includes(body.type)) {
        return reply.code(400).send({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
      }

      // Allow owner/admin to record contributions on behalf of other users
      const contributorId = (role === 'owner' || role === 'admin') && body.userId ? body.userId : userId;

      const contribution = await tracker.recordContribution(
        id,
        contributorId,
        body.type as any,
        body.description,
        body.weight,
        body.agentId,
      );

      return reply.code(201).send({ contribution });
    });

    // POST /projects/:id/contributions/:contribId/verify — Verify (owner/admin only)
    fastify.post('/projects/:id/contributions/:contribId/verify', async (request: any, reply: any) => {
      const tracker = node.getContributionTracker();
      if (!tracker) return reply.code(503).send({ error: 'Contribution tracker not available' });

      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id, contribId } = request.params as { id: string; contribId: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can verify contributions' });
      }

      await tracker.verifyContribution(contribId, userId);
      return { success: true };
    });

    // GET /projects/:id/contributions/scores — Get contribution scores
    fastify.get('/projects/:id/contributions/scores', async (request: any, reply: any) => {
      const tracker = node.getContributionTracker();
      if (!tracker) return reply.code(503).send({ error: 'Contribution tracker not available' });

      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const query = request.query as any;
      // Optionally recalculate scores
      if (query.recalculate === 'true') {
        await tracker.calculateScores(id);
      }

      const scores = await tracker.getScoresAsync(id);
      const shares = await tracker.getRevenueSharesAsync(id);
      return { scores, shares };
    });

    // ── Phase 31.10: Content Safety — Reporting ────────────────────────────

    // In-memory rate limiter for reports: max 3 per user per hour
    const reportRateMap = new Map<string, number[]>();

    const checkReportRateLimit = (userId: string): boolean => {
      const now = Date.now();
      const windowMs = 60 * 60 * 1000; // 1 hour
      const maxReports = 3;
      const cutoff = now - windowMs;

      let timestamps = reportRateMap.get(userId);
      if (!timestamps) {
        timestamps = [];
        reportRateMap.set(userId, timestamps);
      }
      // Prune old entries
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length >= maxReports) {
        return false;
      }
      timestamps.push(now);
      return true;
    };

    // Periodic cleanup for report rate limiter (every 10 minutes)
    setInterval(() => {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const [key, timestamps] of reportRateMap) {
        while (timestamps.length > 0 && timestamps[0] <= cutoff) {
          timestamps.shift();
        }
        if (timestamps.length === 0) {
          reportRateMap.delete(key);
        }
      }
    }, 10 * 60 * 1000);

    // POST /projects/:id/report — Report a project (user token required)
    fastify.post('/projects/:id/report', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Rate limit: max 3 reports per user per hour
      if (!checkReportRateLimit(userId)) {
        return reply.code(429).send({ error: 'Rate limit exceeded: max 3 reports per hour' });
      }

      const body = (request.body || {}) as { reason?: string; description?: string };
      const validReasons = ['spam', 'malicious', 'inappropriate', 'copyright', 'other'];
      if (!body.reason || !validReasons.includes(body.reason)) {
        return reply.code(400).send({ error: `Reason must be one of: ${validReasons.join(', ')}` });
      }

      const report = await ps.createReport(id, userId, body.reason as any, body.description);
      return reply.code(201).send({ report });
    });

    // GET /projects/:id/reports — List reports for a project (owner/admin only)
    fastify.get('/projects/:id/reports', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only project owner or admin can view reports' });
      }

      const query = request.query as any;
      const reports = await ps.getProjectReportsAsync(id, {
        status: query.status || undefined,
      });
      return { reports };
    });

    // GET /admin/reports — List all pending reports (admin/node token only)
    fastify.get('/admin/reports', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Require node-level API token for admin endpoints
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== deps.apiToken) {
        return reply.code(403).send({ error: 'Admin access required (node API token)' });
      }

      const query = request.query as any;
      const limit = parseInt(query.limit) || 50;
      const reports = await ps.getPendingReportsAsync(limit);
      return { reports };
    });

    // POST /admin/reports/:id/review — Update report status (admin/node token only)
    fastify.post('/admin/reports/:id/review', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Require node-level API token for admin endpoints
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== deps.apiToken) {
        return reply.code(403).send({ error: 'Admin access required (node API token)' });
      }

      const { id } = request.params as { id: string };
      const report = await ps.getReportAsync(id);
      if (!report) return reply.code(404).send({ error: 'Report not found' });

      const body = (request.body || {}) as { status?: string; action?: string };
      const validStatuses = ['pending', 'reviewing', 'resolved', 'dismissed'];
      if (!body.status || !validStatuses.includes(body.status)) {
        return reply.code(400).send({ error: `Status must be one of: ${validStatuses.join(', ')}` });
      }

      if (body.status === 'dismissed') {
        await ps.dismissReport(id, 'admin');
      } else if (body.status === 'resolved') {
        const validActions = ['archive', 'delist', 'none'];
        const action = body.action || 'none';
        if (!validActions.includes(action)) {
          return reply.code(400).send({ error: `Action must be one of: ${validActions.join(', ')}` });
        }
        await ps.resolveReport(id, 'admin', action as any);
      } else {
        await ps.updateReportStatus(id, body.status as any, 'admin');
      }

      const updated = await ps.getReportAsync(id);
      return { report: updated };
    });

    // GET /admin/reports/stats — Report statistics (admin/node token only)
    fastify.get('/admin/reports/stats', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Require node-level API token for admin endpoints
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== deps.apiToken) {
        return reply.code(403).send({ error: 'Admin access required (node API token)' });
      }

      const stats = await ps.getReportStatsAsync();
      return { stats };
    });

    // ── Phase 53: Project Resource Assignment ──────────────────────────────

    // POST /projects/:id/resources/assign — Assign a resource to a project
    fastify.post('/projects/:id/resources/assign', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Allow access if: (1) user session owner/admin, or (2) node Bearer token + project owned by this node
      const userId = await deps.verifyUserJwt(request);
      const nodeId = node.getIdentity()?.peerId;
      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === deps.apiToken;
      const isNodeAdmin = !userId && hasBearerToken && project.ownerId === nodeId;

      if (userId) {
        const role = await ps.getUserRoleAsync(id, userId);
        if (!role || (role !== 'owner' && role !== 'admin')) {
          return reply.code(403).send({ error: 'Only owner or admin can assign resources' });
        }
      } else if (!isNodeAdmin) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const body = (request.body || {}) as { type?: string; resourceId?: string };
      if (!body.type || !body.resourceId) {
        return reply.code(400).send({ error: 'Missing required fields: type, resourceId' });
      }

      const validTypes = ['mongodb', 's3', 'github', 'compute'];
      if (!validTypes.includes(body.type)) {
        return reply.code(400).send({ error: `Invalid resource type. Must be one of: ${validTypes.join(', ')}` });
      }

      // Verify the resource exists in ResourceRegistry and is active
      const registry = node.getResourceRegistry();
      if (registry) {
        const resource = registry.getResource(body.resourceId);
        if (!resource) return reply.code(404).send({ error: 'Resource not found in ResourceRegistry' });
        if (resource.status !== 'active') return reply.code(400).send({ error: `Resource is not active (status: ${resource.status})` });
      }

      try {
        await ps.assignResource(id, { type: body.type, resourceId: body.resourceId });
        const resources = ps.getProjectResources(id);
        return { resources };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // DELETE /projects/:id/resources/:resourceId — Remove a resource assignment
    fastify.delete('/projects/:id/resources/:resourceId', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id, resourceId } = request.params as { id: string; resourceId: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Verify user is owner or admin
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can remove resources' });
      }

      try {
        await ps.removeResource(id, resourceId);
        const resources = ps.getProjectResources(id);
        return { resources };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // GET /projects/:id/resources — Get all resources assigned to a project
    fastify.get('/projects/:id/resources', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Check access — owner, collaborator, or public
      const userId = await deps.verifyUserJwt(request);
      let isOwner = false;

      if (userId) {
        const role = await ps.getUserRoleAsync(id, userId);
        if (role === 'owner') isOwner = true;
        if (!role && project.type !== 'public') {
          return reply.code(403).send({ error: 'Access denied' });
        }
      } else if (project.type !== 'public') {
        return reply.code(403).send({ error: 'Access denied' });
      }

      const resources = ps.getProjectResources(id);
      const result: Record<string, any> = { resources };

      // Only include apiKey if user is the owner
      if (isOwner && project.apiKey) {
        result.apiKey = project.apiKey;
      }

      return result;
    });

    // POST /projects/:id/api-key — Generate a project API key
    fastify.post('/projects/:id/api-key', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Allow access if: (1) user session owner, or (2) node Bearer token + project owned by this node
      const userId = await deps.verifyUserJwt(request);
      const nodeId = node.getIdentity()?.peerId;
      // If Bearer auth passed the onRequest hook and no user token, this is a node-level request
      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === deps.apiToken;
      const isNodeAdmin = !userId && hasBearerToken && project.ownerId === nodeId;

      if (userId) {
        const role = await ps.getUserRoleAsync(id, userId);
        if (role !== 'owner') {
          return reply.code(403).send({ error: 'Only project owner can generate API keys' });
        }
      } else if (!isNodeAdmin) {
        return reply.code(401).send({ error: 'Authentication required (user session or node API token for node-owned projects)' });
      }

      // Don't generate if one already exists — use regenerate endpoint instead
      if (project.apiKey) {
        return reply.code(409).send({ error: 'API key already exists. Use POST /projects/:id/api-key/regenerate to replace it.' });
      }

      try {
        const apiKey = await ps.generateApiKey(id);
        return { apiKey };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // POST /projects/:id/api-key/regenerate — Regenerate a project API key
    fastify.post('/projects/:id/api-key/regenerate', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await deps.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Owner only
      const role = await ps.getUserRoleAsync(id, userId);
      if (role !== 'owner') {
        return reply.code(403).send({ error: 'Only project owner can regenerate API keys' });
      }

      try {
        const apiKey = await ps.generateApiKey(id);
        return { apiKey };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // GET /projects/by-api-key/:key — Look up project by API key (node-internal, for Resource Proxy)
    fastify.get('/projects/by-api-key/:key', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { key } = request.params as { key: string };
      if (!key || key.length < 32) {
        return reply.code(400).send({ error: 'Invalid API key' });
      }

      const project = ps.getProjectByApiKey(key);
      if (!project) return reply.code(404).send({ error: 'Project not found for this API key' });

      return { project };
    });

    // ── Phase 66: Preflight & Deploy Validation ──────────────────────────────

    // GET /projects/:id/preflight — check if project is ready for app deployment
    // POST /projects/:id/preflight — same check but auto-fixes what it can
    fastify.route({
      method: ['GET', 'POST'],
      url: '/projects/:id/preflight',
      handler: async (request: any, reply: any) => {
        const ps = node.getProjectStore();
        if (!ps) return reply.code(503).send({ error: 'Project store not available' });

        // Auth: user session OR node Bearer token
        let userId = await deps.verifyUserJwt(request);
        const authHeader = request.headers?.authorization || '';
        const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === deps.apiToken;
        if (!userId && !hasBearerToken) {
          return reply.code(401).send({ error: 'Authentication required' });
        }

        const { id } = request.params as { id: string };
        const autoFix = request.method === 'POST';

        // Check 1: Project exists
        let project: any = null;
        try { project = await ps.getProjectAsync(id); } catch (err: any) { console.log(`[preflight] Project lookup failed for ${id}: ${err.message}`); }
        const projectExists = !!project;

        // Check 2: API key exists
        let apiKeyExists = !!(project?.apiKey);
        const autoFixed: string[] = [];

        if (!apiKeyExists && autoFix && project) {
          // Auto-generate API key
          try {
            const { randomBytes: rb } = await import('node:crypto');
            const apiKey = rb(32).toString('hex');
            await ps.updateProject(id, { apiKey });
            project = await ps.getProjectAsync(id);
            apiKeyExists = true;
            autoFixed.push('Generated API key');

            // Sync to P2P ProjectRegistry
            const pr = node.getProjectRegistry?.();
            if (pr && project) {
              pr.registerProject(project.id, project.name, apiKey, project.ownerId, project.resources || []);
            }
          } catch {}
        }

        // Check 3: MongoDB assigned
        const resources = project ? (ps.getProjectResources(id) || []) : [];
        let mongodbAssigned = resources.some((r: any) => r.type === 'mongodb');

        if (!mongodbAssigned && autoFix && project) {
          // Auto-assign first available storage_db resource
          const registry = node.getResourceRegistry();
          if (registry) {
            const dbResources = registry.findResources('storage_db' as any);
            if (dbResources.length > 0) {
              try {
                await ps.assignResource(id, { type: 'mongodb', resourceId: dbResources[0].resourceId });
                mongodbAssigned = true;
                autoFixed.push(`Assigned MongoDB resource ${dbResources[0].resourceId}`);
              } catch {}
            }
          }
        }

        // Check 4: GitHub assigned (Phase 70: auto-assign code_repository)
        const currentResources = project ? (ps.getProjectResources(id) || []) : [];
        let githubAssigned = currentResources.some((r: any) => r.type === 'github');

        if (!githubAssigned && autoFix && project) {
          const registry2 = node.getResourceRegistry();
          if (registry2) {
            const codeResources = registry2.findResources('code_repository' as any);
            if (codeResources.length > 0) {
              try {
                await ps.assignResource(id, { type: 'github', resourceId: codeResources[0].resourceId });
                githubAssigned = true;
                autoFixed.push(`Assigned GitHub resource ${codeResources[0].resourceId}`);
              } catch {}
            }
          }
        }

        // Check 5: Gateway URL configured
        const gatewayUrl = process.env.GATEWAY_PUBLIC_URL || process.env.GATEWAY_URL || '';
        const gatewayReachable = gatewayUrl.length > 0;

        // Check 6: Resource Proxy available (gateway URL set = proxy available)
        const resourceProxyAvailable = gatewayReachable;

        const checks = { projectExists, apiKeyExists, mongodbAssigned, githubAssigned, gatewayReachable, resourceProxyAvailable };
        const ready = Object.values(checks).every(Boolean);
        const missing: string[] = [];
        if (!projectExists) missing.push('Project does not exist');
        if (!apiKeyExists) missing.push('No API key — POST /projects/:id/api-key or use preflight auto-fix');
        if (!mongodbAssigned) missing.push('No MongoDB resource assigned');
        if (!githubAssigned) missing.push('No GitHub resource assigned');
        if (!gatewayReachable) missing.push('GATEWAY_PUBLIC_URL not set on node');
        if (!resourceProxyAvailable) missing.push('Resource Proxy unavailable (no gateway URL)');

        return { ready, checks, missing, autoFixed };
      }
    });

    // ── Phase 70: GitHub Integration & Unified Deploy ──────────────────────

    // POST /projects/:id/github — Create a GitHub repo for the project
    fastify.post('/projects/:id/github', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === deps.apiToken;
      const userId = await deps.verifyUserJwt(request);
      if (!userId && !hasBearerToken) return reply.code(401).send({ error: 'Authentication required' });

      const { id } = request.params as { id: string };
      let project: any;
      try { project = await ps.getProjectAsync(id); } catch {}
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Already has a repo?
      if (project.githubRepo) {
        return { repoUrl: `https://github.com/${project.githubRepo}`, cloneUrl: `https://github.com/${project.githubRepo}.git`, existing: true };
      }

      // Get GitHub token from contributed code_repository resource
      const registry = node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'ResourceRegistry not available' });

      const githubResources = registry.findResources('code_repository' as any);
      if (!githubResources.length) return reply.code(503).send({ error: 'No code_repository resource contributed' });

      const githubToken = await registry.getCredential(githubResources[0].resourceId);
      if (!githubToken) return reply.code(503).send({ error: 'Could not decrypt GitHub credential' });

      const ghMeta = (githubResources[0] as any).metadata || {};
      const explicitOrg = ghMeta.org || 'pando-lux';
      const accountType = ghMeta.accountType || 'user'; // 'user' or 'org'
      const safeName = (project.name || id).replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40);
      const repoName = `app-${id.slice(0, 8)}-${safeName}`;

      // Create repo via GitHub API
      const apiHeaders: Record<string, string> = {
        'Authorization': `token ${githubToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      };

      // App repos are always public — EC2 needs unauthenticated clone access
      const repoBody = JSON.stringify({
        name: repoName,
        description: `Pando app: ${project.name || id}`,
        private: false,
        auto_init: true,
      });

      try {
        // Use /user/repos for user accounts, /orgs/{org}/repos for org accounts
        const createUrl = accountType === 'org'
          ? `https://api.github.com/orgs/${explicitOrg}/repos`
          : `https://api.github.com/user/repos`;
        console.log(`[github] Creating repo via ${accountType === 'org' ? 'org' : 'user'} endpoint: ${repoName}`);

        const createResp = await fetch(createUrl, {
          method: 'POST', headers: apiHeaders, body: repoBody,
          signal: AbortSignal.timeout(15000),
        });

        let fullRepoName = `${explicitOrg}/${repoName}`;
        if (createResp.status === 201) {
          const data = await createResp.json() as any;
          fullRepoName = data.full_name || fullRepoName;
          console.log(`[github] Created repo: ${fullRepoName}`);
        } else if (createResp.status === 422) {
          console.log(`[github] Repo already exists: ${fullRepoName}`);
        } else {
          const errText = await createResp.text();
          console.log(`[github] Repo create failed (${createResp.status}): ${errText}`);
          return reply.code(502).send({ error: `GitHub API error: ${createResp.status}`, details: errText });
        }

        // Update project record
        await ps.updateProject(id, { githubRepo: fullRepoName, repoUrl: `https://github.com/${fullRepoName}` });

        return {
          repoUrl: `https://github.com/${fullRepoName}`,
          cloneUrl: `https://github.com/${fullRepoName}.git`,
          githubRepo: fullRepoName,
        };
      } catch (err: any) {
        console.log(`[github] Create repo error: ${err.message}`);
        return reply.code(502).send({ error: err.message });
      }
    });

    // POST /projects/:id/github/push — Push workspace code to GitHub
    fastify.post('/projects/:id/github/push', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === deps.apiToken;
      const userId = await deps.verifyUserJwt(request);
      if (!userId && !hasBearerToken) return reply.code(401).send({ error: 'Authentication required' });

      const { id } = request.params as { id: string };
      const body = (request.body || {}) as { workspaceDir?: string };
      if (!body.workspaceDir) return reply.code(400).send({ error: 'workspaceDir required' });

      let project: any;
      try { project = await ps.getProjectAsync(id); } catch {}
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Ensure repo exists — create if needed
      if (!project.githubRepo) {
        try {
          const createUrl = `http://127.0.0.1:${(fastify.server.address() as any)?.port || 4000}/v1/projects/${id}/github`;
          const createRes = await fetch(createUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${deps.apiToken}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(45000),
          });
          if (createRes.ok) {
            const data = await createRes.json() as any;
            project.githubRepo = data.githubRepo;
          } else {
            return reply.code(502).send({ error: 'Failed to create GitHub repo' });
          }
        } catch (err: any) {
          return reply.code(502).send({ error: `GitHub repo creation failed: ${err.message}` });
        }
      }

      // Get GitHub token
      const registry = node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'ResourceRegistry not available' });
      const githubResources = registry.findResources('code_repository' as any);
      if (!githubResources.length) return reply.code(503).send({ error: 'No code_repository resource' });
      const githubToken = await registry.getCredential(githubResources[0].resourceId);
      if (!githubToken) return reply.code(503).send({ error: 'Could not decrypt GitHub credential' });

      const { execSync } = await import('node:child_process');
      const { existsSync: fsExists } = await import('node:fs');
      const workDir = body.workspaceDir;

      if (!fsExists(workDir)) return reply.code(400).send({ error: `Workspace not found: ${workDir}` });

      try {
        const pushUrl = `https://x-access-token:${githubToken}@github.com/${project.githubRepo}.git`;

        // Init git if needed
        if (!fsExists(`${workDir}/.git`)) {
          execSync('git init', { cwd: workDir, stdio: 'pipe' });
        }
        execSync('git config user.email "deploy@pando.network"', { cwd: workDir, stdio: 'pipe' });
        execSync('git config user.name "Pando Deploy"', { cwd: workDir, stdio: 'pipe' });
        execSync('git add -A', { cwd: workDir, stdio: 'pipe' });

        const commitMsg = `Deploy ${new Date().toISOString().slice(0, 19)}`;
        try { execSync(`git commit -m "${commitMsg}"`, { cwd: workDir, stdio: 'pipe' }); } catch {}

        try { execSync('git remote remove origin', { cwd: workDir, stdio: 'pipe' }); } catch {}
        execSync(`git remote add origin ${pushUrl}`, { cwd: workDir, stdio: 'pipe' });
        execSync('git push -u origin HEAD:main --force', { cwd: workDir, stdio: 'pipe', timeout: 30000 });

        const commitSha = execSync('git rev-parse HEAD', { cwd: workDir, encoding: 'utf-8' }).trim();
        console.log(`[github] Pushed to ${project.githubRepo} (${commitSha.slice(0, 8)})`);

        return {
          pushed: true,
          commitSha,
          repoUrl: `https://github.com/${project.githubRepo}`,
          githubRepo: project.githubRepo,
        };
      } catch (err: any) {
        console.log(`[github] Push failed: ${err.message}`);
        return reply.code(502).send({ error: `GitHub push failed: ${err.message}` });
      }
    });

    // POST /projects/:id/deploy — REMOVED (replaced by POST /v1/apps/:id/deploy via AppManager)


    // POST /projects/:id/undeploy — REMOVED (replaced by DELETE /v1/apps/:id via AppManager)

    // POST /projects/:id/validate-deploy — lightweight deploy health check
    fastify.post('/projects/:id/validate-deploy', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Auth: user session OR node Bearer token
      const userId = await deps.verifyUserJwt(request);
      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === deps.apiToken;
      if (!userId && !hasBearerToken) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const errors: string[] = [];

      // Determine validation URL based on project tier
      const projectTier = (project as any).tier || 1;
      let url: string;
      if (projectTier === 2 && project.deploymentUrl) {
        // Tier 2: PM2+nginx — use the stored deployment URL directly
        url = project.deploymentUrl;
      } else {
        // Tier 1: S3 static — construct the S3 website URL
        const s3Bucket = process.env.PANDO_S3_BUCKET || 'pando-deployments';
        const s3Region = 'us-east-1';
        url = `http://${s3Bucket}.s3-website-${s3Region}.amazonaws.com/public/${id}/index.html`;
      }

      // Check 1: URL responds
      let urlResponds = false;
      let htmlContent = '';
      if (url) {
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
          urlResponds = resp.ok;
          if (resp.ok) htmlContent = await resp.text();
          else errors.push(`URL returned ${resp.status}`);
        } catch (err: any) {
          errors.push(`URL fetch failed: ${err.message}`);
        }
      } else {
        errors.push('No deployment URL found');
      }

      // Check 2: Gateway URL injected
      const gatewayInjected = htmlContent.includes('PANDO_GATEWAY_URL');

      // Check 3: API key injected
      const apiKeyInjected = htmlContent.includes('PANDO_PROJECT_API_KEY');

      // Check 4: Resource Proxy responds (test with count on __preflight_test collection)
      let resourceProxyWorks = false;
      if (project.apiKey) {
        const gatewayUrl = process.env.GATEWAY_PUBLIC_URL || process.env.GATEWAY_URL || '';
        if (gatewayUrl) {
          try {
            const proxyResp = await fetch(`${gatewayUrl}/api/resource-proxy/db`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Project-Key': project.apiKey },
              body: JSON.stringify({ collection: 'pando_health', operation: 'count', filter: {} }),
              signal: AbortSignal.timeout(10000),
            });
            resourceProxyWorks = proxyResp.ok;
            if (!proxyResp.ok) errors.push(`Resource Proxy returned ${proxyResp.status}`);
          } catch (err: any) {
            errors.push(`Resource Proxy test failed: ${err.message}`);
          }
        }
      }

      // Gateway/API key injection only expected for Tier 1 static sites (HTML served from S3)
      // Tier 2 server apps handle their own responses — injection checks don't apply
      if (projectTier === 1) {
        if (!gatewayInjected && urlResponds) errors.push('PANDO_GATEWAY_URL not found in HTML');
        if (!apiKeyInjected && urlResponds) errors.push('PANDO_PROJECT_API_KEY not found in HTML');
      }

      const checks = { urlResponds, gatewayInjected, apiKeyInjected, resourceProxyWorks };
      // Tier 1: all checks must pass. Tier 2: only URL + resource proxy matter.
      const healthy = projectTier === 2
        ? urlResponds && resourceProxyWorks
        : Object.values(checks).every(Boolean);

      return { healthy, url, checks, errors };
    });

    // ── Per-Project Board API ─────────────────────────────────────────────

    // GET /projects/:id/board — Public view of a project's board (pending/in_progress tasks)
    fastify.get('/projects/:id/board', async (request: any) => {
      const { id } = request.params as { id: string };
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) return { tasks: [], error: 'Engine not available' };
      return { tasks: adapter.getProjectBoard(id) };
    });

    // POST /projects/:id/request — Submit a bug report or feature request to a project's board
    fastify.post('/projects/:id/request', async (request: any, reply: any) => {
      const { id } = request.params as { id: string };
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
        return reply.code(403).send({ error: lawViolation });
      }
      const adapter = node.getEngineAdapter();
      if (!adapter?.available) {
        return reply.code(503).send({ error: 'Engine not available' });
      }
      const severity = /\b(crash(es|ed|ing)?|critical|down|outage|broken|bug|error|fail(s|ed|ing)?)\b/i.test(message) ? 'BUG' : 'FEATURE';
      const taskTitle = `[${severity}:user] ${message.slice(0, 120)}`;
      const taskId = adapter.addProjectBoardTask(id, taskTitle, message.slice(0, 500));
      if (!taskId) {
        return reply.code(404).send({ error: 'Project board not found (project may not have been built yet)' });
      }
      return { status: 'ok', taskId, projectId: id, message: 'Report submitted to project board.' };
    });

    // ── Governance Helpers ──────────────────────────────────────────────────

    // ── Auth guard helpers ──────────────────────────────────────────────────
    function requireAuth(request: any, reply: any): boolean {
      const actor = (request as any).actor;
      if (!actor || actor.type === 'anonymous') {
        reply.code(401).send({ error: 'Authentication required' });
        return false;
      }
      return true;
    }

    function requireOperator(request: any, reply: any): boolean {
      const actor = (request as any).actor;
      if (!actor || (actor.type !== 'operator' && actor.type !== 'system')) {
        reply.code(403).send({ error: 'Operator access required' });
        return false;
      }
      return true;
    }

    function requireOperatorOrAgent(request: any, reply: any): boolean {
      const actor = (request as any).actor;
      if (!actor || (actor.type !== 'operator' && actor.type !== 'agent' && actor.type !== 'system')) {
        reply.code(403).send({ error: 'Operator or agent access required' });
        return false;
      }
      return true;
    }

    // POST /council/veto/:id — veto a governance proposal (legacy route, kept for compatibility)
    fastify.post('/council/veto/:id', async (request: any, reply: any) => {
      if (!requireOperator(request, reply)) return;
      const governance = node.getGovernance();
      if (!governance) return reply.code(503).send({ error: 'Governance not initialized' });
      const { id } = request.params || {};
      const { reason } = request.body || {};
      try {
        await governance.castVote(id, 'reject', reason || 'Operator veto');
        return { status: 'vetoed', proposalId: id };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });


    // ── Phase 51: Infrastructure Awareness ──────────────────────────────────

    // GET /capabilities/infrastructure — what infrastructure agents/apps can use
    fastify.get('/capabilities/infrastructure', async () => {
      const network = node.getNetwork();
      const capabilities = node.getCapabilities();

      // Extract public-facing addresses from P2P listen addresses
      const listenAddrs = network?.getListenAddresses() || [];
      const ips = listenAddrs
        .map((a: string) => {
          const match = a.match(/\/ip4\/([\d.]+)\/tcp\/(\d+)/);
          return match ? { ip: match[1], port: match[2] } : null;
        })
        .filter((x: any) => x && x.ip !== '127.0.0.1');

      // Determine public URLs for this node and gateway
      const nodePublicUrl = process.env.PANDO_PUBLIC_URL
        || (ips.length > 0 ? `http://${ips[0]!.ip}:${node.getApiPort() || 4000}` : null);

      const gatewayPublicUrl = process.env.GATEWAY_PUBLIC_URL
        || process.env.GATEWAY_URL
        || null;

      return {
        hosting: {
          static: {
            available: true,
            type: 's3',
            deployEndpoint: 'POST /agents/:id/deploy',
            note: 'Deploy static web content (HTML/CSS/JS). Apps deploy to contributed hosting resources.',
          },
        },
        databases: {
          mongodb: {
            available: node.getStorageBackendType() === 'mongodb',
            note: 'User data storage via StorageBackend. Apps have their own backends with own database schemas.',
          },
          sqlite: { available: true, note: 'Local node storage. Used internally.' },
        },
        compute: {
          claudeCode: capabilities.includes('claude-code'),
          docker: capabilities.includes('docker'),
          python: capabilities.includes('python'),
          nodeJs: true,
        },
        apiKeys: deps.getAvailableApiKeys(),
        gateway: {
          url: process.env.GATEWAY_URL || 'http://127.0.0.1:3222',
          note: 'Web UI directory. Apps have their own URLs after deployment.',
        },
        network: {
          peers: network?.getPeerCount() ?? 0,
          relayAvailable: true,
        },
        // Phase 53: Resource Proxy — project-scoped database access without credential exposure
        resourceProxy: {
          available: true,
          url: gatewayPublicUrl ? `${gatewayPublicUrl}/api/resource-proxy` : '/api/resource-proxy',
          auth: 'X-Project-Key header with project API key',
          operations: ['find', 'findOne', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'count'],
          note: 'Database access without exposing credentials. Get project API key via POST /projects/:id/api-key.',
        },
        // Public-facing URLs for zero-config app access
        nodePublicUrl,
        gatewayPublicUrl,
      };
    });

    // Phase 53.1/65: Legacy /apps/data + deploy + static serving routes REMOVED.
    // All app lifecycle is now managed by AppManager (see app-api.ts).

  // ==========================================================================
  // Phase 105: Agent Template CRUD — removed (brain now in @pando-code/core)
  // ==========================================================================

  fastify.get('/templates', async (_request: any, reply: any) => {
    return reply.code(503).send({ error: 'Template registry removed — brain now in @pando-code/core' });
  });

  fastify.get('/templates/:id', async (_request: any, reply: any) => {
    return reply.code(503).send({ error: 'Template registry removed — brain now in @pando-code/core' });
  });

  fastify.post('/templates', async (_request: any, reply: any) => {
    return reply.code(503).send({ error: 'Template registry removed — brain now in @pando-code/core' });
  });

  fastify.put('/templates/:id', async (_request: any, reply: any) => {
    return reply.code(503).send({ error: 'Template registry removed — brain now in @pando-code/core' });
  });

  fastify.delete('/templates/:id', async (_request: any, reply: any) => {
    return reply.code(503).send({ error: 'Template registry removed — brain now in @pando-code/core' });
  });

}
