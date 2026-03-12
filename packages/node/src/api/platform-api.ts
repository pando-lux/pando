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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RouteHelpers } from './middleware/auth.js';
import { violatesTwoLaws } from './api-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Timing-safe Bearer token comparison (prevents timing attacks). */
function verifyBearerToken(authHeader: string, expectedToken: string): boolean {
  if (!authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  if (token.length !== expectedToken.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
}

export async function registerPlatformRoutes(
  fastify: any,
  deps: RouteHelpers,
): Promise<void> {
  const { node } = deps;

  // ── Teams Server proxy (BIBLE 1.7) ─────────────────────────────────
  // KB: 127.0.0.1 not localhost — Windows Node.js resolves localhost to ::1 (IPv6) but pando-teams only binds IPv4.
  const TEAMS_SERVER_URL = process.env.PANDO_TEAMS_URL || 'http://127.0.0.1:4873';
  // KB: PANDO_API_KEY may not be in the node's env (set only in teams .env via dotenv).
  // KB: Fall back to reading the teams .env file directly so the proxy auth matches.
  let TEAMS_API_KEY = process.env.PANDO_API_KEY || '';
  if (!TEAMS_API_KEY) {
    try {
      const nodeRepo = resolve(__dirname, '..', '..', '..', '..');
      for (const dir of ['teams', 'code']) {
        try {
          const envPath = join(nodeRepo, '..', dir, '.env');
          const envFile = readFileSync(envPath, 'utf-8');
          const match = envFile.match(/^PANDO_API_KEY=(.+)$/m);
          if (match) { TEAMS_API_KEY = match[1].trim(); break; }
        } catch { /* try next */ }
      }
    } catch { /* fs unavailable */ }
  }
  async function proxyToTeams(path: string, opts?: { method?: string; body?: any }): Promise<any> {
    try {
      const res = await fetch(`${TEAMS_SERVER_URL}/v1${path}`, {
        method: opts?.method || 'GET',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEAMS_API_KEY}` },
        ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
      });
      return res.json();
    } catch (err: any) {
      return { error: 'Teams Server unavailable', details: err.message };
    }
  }

  /**
   * Send a message to the EngineAdapter for a project (or system engine if no projectId).
   * Collects the streamed response and returns it.
   */
  async function sendToEngine(
    message: string,
    projectId?: string,
  ): Promise<{ sent: boolean; response?: string; error?: string }> {
    const adapter = node.getEngineAdapter();
    if (!adapter?.available) return { sent: false, error: 'Engine not available' };
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
      // #43: Return meaningful error message instead of silent failure
      const reason = err.message?.includes('budget') || err.message?.includes('Budget')
        ? 'Budget exhausted'
        : err.message || 'Engine error';
      return { sent: false, error: reason };
    }
  }

  /** Check if local PandoTeams engine is available (provider-agnostic). */
  function hasEngine(): boolean {
    return !!(node.getEngineAdapter()?.available);
  }

  /**
   * Unified build routing — find the best PandoTeams peer (including self).
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

    // Check if self is a candidate (has local PandoTeams engine)
    const selfHasEngine = hasEngine();
    if (selfHasEngine && selfPeerId) {
      // Self is the best candidate — no P2P overhead
      return { peerId: selfPeerId, isLocal: true };
    }

    // Find best remote peer — M-8/#12: Score by latency/load, fall back to random
    const remoteCandidates = candidates.filter((p: any) => p.peerId !== selfPeerId);
    if (remoteCandidates.length > 0) {
      // Sort by latency (lower is better) and active task count (lower is better)
      const scored = remoteCandidates.map((p: any) => ({
        ...p,
        score: (p.latencyMs ? 1000 / (p.latencyMs + 1) : 0.5) + (p.activeTasks ? 10 / (p.activeTasks + 1) : 5),
      }));
      // If scoring data is available, pick the best; otherwise random selection for load distribution
      const hasMetrics = scored.some((p: any) => p.latencyMs || p.activeTasks !== undefined);
      if (hasMetrics) {
        scored.sort((a: any, b: any) => b.score - a.score);
        return { peerId: scored[0].peerId, isLocal: false };
      }
      // Random selection from candidates to distribute load evenly
      const idx = Math.floor(Math.random() * remoteCandidates.length);
      return { peerId: remoteCandidates[idx].peerId, isLocal: false };
    }

    return null;
  }

    // NOTE: pando-node owns /v1/chat/message (user-facing chat via gateway).
    // @pando-teams/core owns /v1/chat (engine-level direct chat). Do not merge these routes.
    fastify.post('/chat/message', async (request: any, reply: any) => {
      const peerId = await deps.verifyUserJwt(request);
      if (!peerId) { reply.status(401).send({ error: 'Unauthorized' }); return; }
      const { message, projectId } = request.body || {};
      if (!message || typeof message !== 'string') {
        return reply.code(400).send({ error: 'message is required' });
      }
      const trimmed = (message as string).trim();
      if (!trimmed) return reply.code(400).send({ error: 'message cannot be empty' });
      if (trimmed.length > 10000) return reply.code(400).send({ error: 'Message too long (max 10000 chars)' });

      // Two Laws check — reject harmful messages before any routing
      const lawViolation = violatesTwoLaws(trimmed);
      if (lawViolation) {
        return { status: 'ok', threadId: '', reply: lawViolation, tier: 'simple' };
      }

      const threadStore = node.getThreadStore();
      let threadId: string | undefined;

      // Resolve user identity so threads are owned by the authenticated user
      const chatUserId = peerId || undefined;

      // If projectId is provided, route directly to project engine
      if (projectId && typeof projectId === 'string') {
        if (threadStore) {
          threadId = `chat-${Date.now()}-${randomBytes(4).toString('hex')}`;
          threadStore.createThread(threadId, trimmed.slice(0, 50), 'project', '', chatUserId);
          threadStore.updateThread(threadId, { projectId });
          await threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'complex' });
        }

        // Unified routing — find best PandoTeams peer (including self)
        const builder = findBestBuilder();
        if (!builder) {
          const noBuilderReply = 'No PandoTeams-capable nodes available on the network. Run /contribute claude-code on a node to enable builds.';
          if (threadStore && threadId) {
            await threadStore.addMessage(threadId, { role: 'assistant', content: noBuilderReply, timestamp: Date.now(), tier: 'simple' });
          }
          return { status: 'ok', threadId, reply: noBuilderReply, tier: 'simple' };
        }

        if (builder.isLocal) {
          // Local PandoTeams — async engine call
          (async () => {
            try {
              const result = await sendToEngine(trimmed, projectId);
              if (threadStore && threadId && result.response) {
                await threadStore.addMessage(threadId, { role: 'assistant', content: result.response, timestamp: Date.now(), tier: 'complex' });
              }
              const engineReply = result.error
                ? `Build failed: ${result.error}`
                : (result.response || 'Building your project...');
              deps.pushEvent('chat_message', { threadId, projectId, role: 'assistant', content: engineReply, timestamp: Date.now(), tier: 'complex' });
              // Trigger app-manager update after build — push deploy result back to thread
              const appMgr = node.getAppManager?.();
              if (appMgr && projectId) {
                try {
                  const deployResult = await appMgr.update(projectId);
                  if (deployResult.success) {
                    const app = appMgr.get(projectId);
                    const deployMsg = `App deployed successfully.${app?.deploy_url ? ` URL: ${app.deploy_url}` : ''}${app?.port ? ` Port: ${app.port}` : ''}`;
                    if (threadStore && threadId) {
                      await threadStore.addMessage(threadId, { role: 'assistant', content: deployMsg, timestamp: Date.now(), tier: 'complex' });
                    }
                    deps.pushEvent('app_deployed', { threadId, projectId, deployUrl: app?.deploy_url, port: app?.port, status: 'live' });
                    console.log(`[app-manager] Auto-deploy succeeded for ${projectId}`);
                  } else {
                    const failMsg = `Deploy attempted: ${deployResult.error || 'pending remote deployment'}`;
                    if (threadStore && threadId) {
                      await threadStore.addMessage(threadId, { role: 'assistant', content: failMsg, timestamp: Date.now(), tier: 'complex' });
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
                await threadStore.addMessage(threadId, { role: 'assistant', content: `Engine error: ${(err as Error).message}`, timestamp: Date.now(), tier: 'complex' });
              }
            }
          })();
          return { status: 'ok', threadId, projectId, reply: 'AI engine is processing — check the thread for updates.', tier: 'complex', routedTo: builder.peerId };
        }

        // Remote PandoTeams peer — route via P2P
        const p2pResult = await node.routeChatProxyP2P?.(trimmed, threadId);
        if (p2pResult) {
          return { status: 'queued', threadId, reply: 'Routed to PandoTeams peer. Building — check thread for updates.', tier: 'complex', routedTo: p2pResult.executedBy };
        }
        return { status: 'ok', threadId, reply: 'PandoTeams peer did not respond. Try again.', tier: 'simple' };
      }

      // No projectId — detect build intent server-side (bypasses doorman hallucination).
      // Build requests are handled deterministically; everything else goes to doorman.
      const BUILD_VERBS = /\b(build|create|make|deploy|develop|code|write|generate)\b/i;
      const APP_NOUNS = /\b(app|application|website|site|web|tool|dashboard|api|service|bot|game|page|calculator|todo|notes|counter|tracker|timer|clock|portfolio|blog|store|shop|chat|form|survey|quiz|poll|list|board|manager|widget|extension|plugin)\b/i;

      if (BUILD_VERBS.test(trimmed) && APP_NOUNS.test(trimmed)) {
        // Extract kebab-case project name from user message
        const projectName = trimmed.toLowerCase()
          .replace(/['']/g, '')
          .replace(/\b(build|create|make|deploy|develop|code|write|generate|me|a|an|the|please|can|could|you|i|want|need|like|would|simple|basic|small|quick|just|for|with|that|this|some|my)\b/g, '')
          .trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
          .slice(0, 50) || `project-${randomBytes(3).toString('hex')}`;

        const ps = node.getProjectStore();
        if (ps) {
          try {
            const ownerId = chatUserId || node.getIdentity()?.peerId || '';
            const project = await ps.createProject({
              id: projectName,
              name: projectName,
              description: trimmed,
              ownerId,
              type: 'private',
              visibility: 'owner_only',
              teamId: projectName,
            });

            if (threadStore) {
              threadId = `chat-${Date.now()}-${randomBytes(4).toString('hex')}`;
              threadStore.createThread(threadId, trimmed.slice(0, 50), 'project', '', chatUserId);
              threadStore.updateThread(threadId, { projectId: project.id });
              await threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'complex' });
            }

            // Route to Teams Server — auto-starts team with claude-code lead
            try {
              await fetch(`${TEAMS_SERVER_URL}/v1/teams/${projectName}/chat`, {
                method: 'POST',
                // KB: Authorization header required — pando-teams returns 401 without it, team never creates.
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEAMS_API_KEY}` },
                body: JSON.stringify({ agentId: 'lead', message: `Build this project: ${trimmed}` }),
                signal: AbortSignal.timeout(15000),
              });
            } catch {
              console.warn(`[chat] Teams Server unreachable for build "${projectName}" — team may start later`);
            }

            const buildReply = `Project "${projectName}" created! A build team has been assigned and is starting work. Check the project page for progress.`;
            if (threadStore && threadId) {
              await threadStore.addMessage(threadId, { role: 'assistant', content: buildReply, timestamp: Date.now(), tier: 'complex' });
            }
            console.log(`[chat] Build intent detected — created project "${projectName}" and routed to Teams Server`);
            return { status: 'ok', threadId, projectId: project.id, reply: buildReply, tier: 'complex' };
          } catch (err: any) {
            // Project creation failed (e.g., duplicate name) — fall through to doorman
            console.warn(`[chat] Build intent detected but project creation failed: ${err.message}`);
          }
        }
      }

      // KB: FEEDBACK intent — detect user complaints/bug reports, create board task best-effort, fall through to doorman.
      // KB: Fire-and-forget (.catch) so a slow/offline Teams Server never blocks the user reply.
      const FEEDBACK_SIGNALS = /\b(broken|bug|issue|doesn'?t work|not working|wrong|error|crash|fail|problem|glitch|fix)\b/i;
      if (FEEDBACK_SIGNALS.test(trimmed)) {
        fetch(`${TEAMS_SERVER_URL}/v1/teams/node-doorman/act`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEAMS_API_KEY}` },
          body: JSON.stringify({
            agentId: 'lead',
            actions: [{ do: 'create_task', title: `User feedback: ${trimmed.slice(0, 80)}`, description: trimmed, priority: 'high' }],
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => console.warn('[chat] FEEDBACK intent — Teams Server unreachable, task not created'));
        console.log('[chat] FEEDBACK intent detected — board task created (fire-and-forget)');
        // Fall through — doorman handles the user-facing reply unchanged
      }

      // Non-build messages — route to doorman for Q&A, status, etc.
      try {
        const doormanResp = await fetch(`${TEAMS_SERVER_URL}/v1/teams/node-doorman/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEAMS_API_KEY}` },
          body: JSON.stringify({ agentId: 'lead', message: trimmed }),
          signal: AbortSignal.timeout(120000),
        });
        if (doormanResp.ok) {
          const doormanResult = await doormanResp.json() as any;
          const doormanReply = doormanResult?.reply || doormanResult?.response || '';
          if (doormanReply) {
            if (threadStore) {
              threadId = `chat-${Date.now()}-${randomBytes(4).toString('hex')}`;
              threadStore.createThread(threadId, trimmed.slice(0, 50), 'conversation', '', chatUserId);
              await threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'simple' });
              await threadStore.addMessage(threadId, { role: 'assistant', content: doormanReply, timestamp: Date.now(), tier: 'simple' });
            }
            return { status: 'ok', threadId, reply: doormanReply, tier: 'simple' };
          }
        }
      } catch {
        console.log('[chat] node-doorman unreachable');
        const unavailableReply = 'AI service is temporarily unavailable. Please try again shortly.';
        if (threadStore) {
          threadId = `chat-${Date.now()}-${randomBytes(4).toString('hex')}`;
          threadStore.createThread(threadId, trimmed.slice(0, 50), 'conversation', '', chatUserId);
          await threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'simple' });
          await threadStore.addMessage(threadId, { role: 'assistant', content: unavailableReply, timestamp: Date.now(), tier: 'simple' });
        }
        return { status: 'ok', threadId, reply: unavailableReply, tier: 'simple' };
      }

      // Doorman returned OK but empty reply — generic fallback
      const fallbackReply = 'I can help you build apps, check your balance, or answer questions about Pando. Try "build me a todo app" to get started!';
      if (threadStore) {
        threadId = `chat-${Date.now()}-${randomBytes(4).toString('hex')}`;
        threadStore.createThread(threadId, trimmed.slice(0, 50), 'conversation', '', chatUserId);
        await threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'simple' });
        await threadStore.addMessage(threadId, { role: 'assistant', content: fallbackReply, timestamp: Date.now(), tier: 'simple' });
      }
      return { status: 'ok', threadId, reply: fallbackReply, tier: 'simple' };
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
      const threadId = `chat-${Date.now()}-${randomBytes(4).toString('hex')}`;

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

      // Ownership check: if thread has a userId, verify the requester matches
      if (meta.userId) {
        const requesterId = await deps.verifyUserJwt(request);
        if (requesterId && requesterId !== meta.userId) {
          return reply.code(403).send({ error: 'Not authorized to view this thread' });
        }
      }

      return { ...meta, messages: await threadStore.getMessagesAsync(id) };
    });

    // DELETE /chat/threads/:id — delete a thread
    fastify.delete('/chat/threads/:id', async (request: any, reply: any) => {
      const threadStore = node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });
      const { id } = request.params || {};
      const meta = threadStore.getThread(id);
      if (!meta) return reply.code(404).send({ error: 'Thread not found' });

      // Ownership check
      if (meta.userId) {
        const requesterId = await deps.verifyUserJwt(request);
        if (requesterId && requesterId !== meta.userId) {
          return reply.code(403).send({ error: 'Not authorized to delete this thread' });
        }
      }

      const deleted = threadStore.deleteThread(id);
      if (!deleted) return reply.code(404).send({ error: 'Thread not found' });
      return { success: true, deleted: id };
    });

    // PATCH /chat/threads/:id — update thread metadata
    fastify.patch('/chat/threads/:id', async (request: any, reply: any) => {
      const threadStore = node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });
      const { id } = request.params || {};

      // Ownership check
      const meta = threadStore.getThread(id);
      if (meta?.userId) {
        const requesterId = await deps.verifyUserJwt(request);
        if (requesterId && requesterId !== meta.userId) {
          return reply.code(403).send({ error: 'Not authorized to modify this thread' });
        }
      }

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
      const threadUserPeerId = await deps.verifyUserJwt(request);

      // Check thread exists before processing — don't auto-create on non-existent IDs
      // Use async fallback: sync cache may not be populated yet for newly created threads
      const existingThread = threadStore.getThread(id) || await threadStore.getThreadAsync(id);
      if (!existingThread) {
        return reply.code(404).send({ error: 'Thread not found' });
      }

      const { message, encrypted: isEncrypted, nonce, encryptedThreadKey } = request.body || {};
      if (!message || typeof message !== 'string') {
        return reply.code(400).send({ error: 'message is required' });
      }
      const trimmed = message.trim();
      if (!trimmed) return reply.code(400).send({ error: 'message cannot be empty' });
      if (trimmed.length > 10000) return reply.code(400).send({ error: 'message too long (max 10000 chars)' });

      // Two Laws check — reject harmful messages before processing
      const lawViolation = violatesTwoLaws(trimmed);
      if (lawViolation) {
        return { status: 'ok', threadId: id, reply: lawViolation, tier: 'simple' };
      }

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
        await threadStore.addMessage(id, { role: 'assistant', content: errReply, timestamp: Date.now(), tier: 'simple' });
        return { status: 'ok', threadId: id, reply: errReply, tier: 'simple' };
      }

      // Save user message to thread (encrypted form for at-rest protection)
      await threadStore.addMessage(id, {
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
        tier: 'simple',
        encrypted: isEncrypted || false,
        nonce: isEncrypted ? nonce : undefined,
      });

      // If thread has a projectId, route directly to project manager.
      // If no projectId, route to Teams Server node-doorman (BIBLE 1.8).
      if (threadMeta?.projectId) {
        // Existing project thread — unified routing to best PandoTeams peer
        const builder = findBestBuilder();
        if (!builder) {
          await threadStore.addMessage(id, { role: 'assistant', content: 'No PandoTeams-capable nodes available.', timestamp: Date.now(), tier: 'simple' });
          return { status: 'ok', threadId: id, reply: 'No PandoTeams-capable nodes available.', tier: 'simple' };
        }
        if (builder.isLocal) {
          // Local PandoTeams — proxy to Teams Server (BIBLE 1.7)
          (async () => {
            try {
              const chatResult = await proxyToTeams(`/teams/${threadMeta.projectId}/chat`, {
                method: 'POST',
                body: { agentId: 'lead', message: plaintextForProcessing },
              });
              const engineReply = chatResult?.error
                ? `Request failed: ${chatResult.error}`
                : (chatResult?.reply || chatResult?.response || 'Done.');
              await threadStore.addMessage(id, { role: 'assistant', content: engineReply, timestamp: Date.now(), tier: 'complex' });
              deps.pushEvent('chat_message', { threadId: id, projectId: threadMeta.projectId, role: 'assistant', content: engineReply, timestamp: Date.now(), tier: 'complex' });
              // Trigger app-manager update after build
              const appMgr = node.getAppManager?.();
              if (appMgr && threadMeta.projectId) {
                appMgr.update(threadMeta.projectId).catch((e: any) => console.warn('[app-manager] Auto-update failed:', e.message));
              }
            } catch (err) {
              console.error('[router] Teams Server routing failed:', (err as Error).message);
              await threadStore.addMessage(id, { role: 'assistant', content: `Routing error: ${(err as Error).message}`, timestamp: Date.now(), tier: 'complex' });
            }
          })();
          return { status: 'ok', threadId: id, reply: 'Processing — check thread for updates.', tier: 'complex', routedTo: builder.peerId };
        }
        // Remote peer — P2P proxy
        node.routeChatProxyP2P?.(plaintextForProcessing, id).catch(() => {
          threadStore.addMessage(id, { role: 'assistant', content: 'P2P routing failed.', timestamp: Date.now(), tier: 'simple' });
        });
        return { status: 'queued', threadId: id, reply: 'Routed to PandoTeams peer — check thread for updates.', tier: 'complex', routedTo: builder.peerId };
      }

      // No projectId — detect build intent server-side before doorman
      const T_BUILD_VERBS = /\b(build|create|make|deploy|develop|code|write|generate)\b/i;
      const T_APP_NOUNS = /\b(app|application|website|site|web|tool|dashboard|api|service|bot|game|page|calculator|todo|notes|counter|tracker|timer|clock|portfolio|blog|store|shop|chat|form|survey|quiz|poll|list|board|manager|widget|extension|plugin)\b/i;

      if (T_BUILD_VERBS.test(plaintextForProcessing) && T_APP_NOUNS.test(plaintextForProcessing)) {
        const tProjectName = plaintextForProcessing.toLowerCase()
          .replace(/['']/g, '')
          .replace(/\b(build|create|make|deploy|develop|code|write|generate|me|a|an|the|please|can|could|you|i|want|need|like|would|simple|basic|small|quick|just|for|with|that|this|some|my)\b/g, '')
          .trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
          .slice(0, 50) || `project-${randomBytes(3).toString('hex')}`;

        const tPs = node.getProjectStore();
        if (tPs) {
          try {
            const tOwnerId = threadUserPeerId || node.getIdentity()?.peerId || '';
            const tProject = await tPs.createProject({
              id: tProjectName,
              name: tProjectName,
              description: plaintextForProcessing,
              ownerId: tOwnerId,
              type: 'private',
              visibility: 'owner_only',
              teamId: tProjectName,
            });
            threadStore.updateThread(id, { projectId: tProject.id });

            try {
              await fetch(`${TEAMS_SERVER_URL}/v1/teams/${tProjectName}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEAMS_API_KEY}` },
                body: JSON.stringify({ agentId: 'lead', message: `Build this project: ${plaintextForProcessing}` }),
                signal: AbortSignal.timeout(15000),
              });
            } catch {
              console.warn(`[chat] Teams Server unreachable for thread build "${tProjectName}"`);
            }

            const tBuildReply = `Project "${tProjectName}" created! A build team has been assigned and is starting work.`;
            await threadStore.addMessage(id, { role: 'assistant', content: tBuildReply, timestamp: Date.now(), tier: 'complex' });
            console.log(`[chat] Build intent in thread — created project "${tProjectName}"`);
            return { status: 'ok', threadId: id, projectId: tProject.id, reply: tBuildReply, tier: 'complex' };
          } catch (err: any) {
            console.warn(`[chat] Thread build intent failed: ${err.message}`);
          }
        }
      }

      // Non-build — route to doorman for Q&A
      try {
        const doormanResp = await fetch(`${TEAMS_SERVER_URL}/v1/teams/node-doorman/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEAMS_API_KEY}` },
          body: JSON.stringify({ agentId: 'lead', message: plaintextForProcessing }),
          signal: AbortSignal.timeout(120000),
        });
        if (doormanResp.ok) {
          const doormanResult = await doormanResp.json() as any;
          const doormanReply = doormanResult?.reply || doormanResult?.response || '';
          if (doormanReply) {
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
        }
      } catch {
        console.log('[chat] node-doorman unreachable for thread message');
      }

      const unavailableReply = 'AI service is temporarily unavailable. Please try again shortly.';
      await threadStore.addMessage(id, { role: 'assistant', content: unavailableReply, timestamp: Date.now(), tier: 'simple' });
      return { status: 'ok', threadId: id, reply: unavailableReply, tier: 'simple' };
    });

    // ── Engine API ──────────────────────────────────────────────────────────

    // GET /engines — list active PandoTeams engines
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

    // ── Phase 16: AI Labor Market — Commission endpoint ──────────────

    // POST /network/commission — requester sends task spec + Lux budget; finds best agent_labor node, locks Lux, dispatches task
    // KB: Phase 16 — holdPayment locks Lux from requester immediately. releasePayment called when task completes.
    // KB: Uses ResourceRouter to find best agent_labor node by capability. Falls back to local if none found.
    fastify.post('/network/commission', async (request: any, reply: any) => {
      const { taskSpec, luxBudget } = (request.body || {}) as { taskSpec?: string; luxBudget?: number };
      if (!taskSpec || typeof taskSpec !== 'string') return reply.code(400).send({ error: 'taskSpec is required' });
      if (typeof luxBudget !== 'number' || luxBudget <= 0) return reply.code(400).send({ error: 'luxBudget must be a positive number' });

      const identity = node.getIdentity();
      const gate = node.getPaymentGate();
      if (!identity) return reply.code(503).send({ error: 'Node identity not ready' });
      if (!gate) return reply.code(503).send({ error: 'PaymentGate not initialized' });

      const taskId = `commission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const hold = gate.holdPayment(identity.peerId, taskId, luxBudget);
      if (!hold) return reply.code(402).send({ error: 'Insufficient Lux balance', required: luxBudget });

      // Find best agent_labor node via ResourceRouter (falls back gracefully if none found)
      const router = node.getResourceRouter();
      let targetNode: string | null = null;
      if (router) {
        try {
          const decision = router.findBestNode({ requiredResources: ['agent_labor'] });
          targetNode = decision?.targetNode || null;
        } catch { /* best-effort */ }
      }

      // Dispatch to Teams Server (local or remote)
      // KB: 127.0.0.1 not localhost — Windows Node.js resolves localhost to ::1 (IPv6) but pando-teams only binds IPv4.
  const TEAMS_SERVER_URL = process.env.PANDO_TEAMS_URL || 'http://127.0.0.1:4873';
      let TEAMS_API_KEY = process.env.PANDO_API_KEY || '';
      if (!TEAMS_API_KEY) {
        try {
          const { readFileSync } = await import('fs');
          const { join } = await import('path');
          const { homedir } = await import('os');
          const envContent = readFileSync(join(homedir(), 'Desktop', 'Code', 'pando', 'teams', '.env'), 'utf8');
          const match = envContent.match(/^PANDO_API_KEY=(.+)$/m);
          if (match) TEAMS_API_KEY = match[1].trim();
        } catch { /* best-effort */ }
      }

      let dispatched = false;
      try {
        const res = await fetch(`${TEAMS_SERVER_URL}/v1/teams/pando/act`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TEAMS_API_KEY}` },
          body: JSON.stringify({
            agentId: 'lead',
            actions: [{ do: 'create_task', title: `Commission: ${taskSpec.slice(0, 80)}`, description: `Budget: ${luxBudget} Lux | Task: ${taskSpec}`, assignee: 'lead', priority: 'high' }],
          }),
          signal: AbortSignal.timeout(10000),
        });
        dispatched = res.ok;
      } catch { /* log but don't fail — hold is already created */ }

      if (!dispatched) {
        // Refund on dispatch failure
        gate.refundPayment(hold.holdId);
        return reply.code(503).send({ error: 'Could not reach agent team to dispatch task — Lux refunded' });
      }

      return {
        ok: true,
        taskId,
        holdId: hold.holdId,
        luxLocked: luxBudget,
        targetNode,
        message: `Task commissioned. ${luxBudget} Lux locked. Agent team is on it.`,
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
        if (typeof pricePerUnit === 'number' && isFinite(pricePerUnit) && pricePerUnit >= 0) {
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
        if (!isNaN(budget) && isFinite(budget) && budget > 0) {
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

      // Validate optional numeric fields
      if (body.pricePerUnit !== undefined && (typeof body.pricePerUnit !== 'number' || !isFinite(body.pricePerUnit) || body.pricePerUnit < 0)) {
        return reply.code(400).send({ error: 'pricePerUnit must be a non-negative finite number' });
      }
      if (body.maxUsagePerDay !== undefined && (typeof body.maxUsagePerDay !== 'number' || !isFinite(body.maxUsagePerDay) || body.maxUsagePerDay < 0 || !Number.isInteger(body.maxUsagePerDay))) {
        return reply.code(400).send({ error: 'maxUsagePerDay must be a non-negative integer' });
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

    // POST /resource-proxy/meter — record usage event for Lux billing (Gap #114: requires auth)
    fastify.post('/resource-proxy/meter', async (request: any, reply: any) => {
      const authHeader = request.headers?.authorization || '';
      if (!verifyBearerToken(authHeader, deps.apiToken)) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
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
        console.error('[api] Instance launch failed:', err.message);
        return reply.code(500).send({ error: 'Instance launch failed' });
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
        console.error('[api] Instance terminate failed:', err.message);
        return reply.code(500).send({ error: 'Instance termination failed' });
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
        console.error('[api] Instance health check failed:', err.message);
        return reply.code(500).send({ error: 'Instance health check failed' });
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
        console.error('[api] Console output failed:', err.message);
        return reply.code(500).send({ error: 'Failed to get console output' });
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
        const gatewayUrl = process.env.HUB_PUBLIC_URL || process.env.HUB_URL || '';
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
          envVars.HUB_URL = gatewayUrl;
        }

        const result = await manager.deployApp(id, body.projectId, body.repoUrl, envVars);
        return result;
      } catch (err: any) {
        console.error('[api] P2P deploy failed:', err.message);
        return reply.code(500).send({ error: 'Deploy failed' });
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
        console.error('[api] Instance upgrade failed:', err.message);
        return reply.code(500).send({ error: 'Instance upgrade failed' });
      }
    });

    // KB: Content Layer Routes (Phase 11) deleted — content-registry stripped in Phase 6.

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
      if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
        return reply.code(400).send({ error: '"amount" must be a positive finite number' });
      }
      const hold = gate.holdPayment(peerId, taskId, amount);
      if (!hold) {
        return reply.code(402).send({ error: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE' });
      }
      return hold;
    });

    // GET /payment/history — Payment history (optional peerId filter) (Gap #115: requires auth)
    fastify.get('/payment/history', async (request: any, reply: any) => {
      const authHeader = request.headers?.authorization || '';
      if (!verifyBearerToken(authHeader, deps.apiToken)) {
        return reply.code(401).send({ error: 'Authentication required' });
      }
      const gate = node.getPaymentGate();
      if (!gate) return { history: [] };
      const peerId = (request.query as any)?.peerId;
      return { history: gate.getPaymentHistory(peerId) };
    });

    // GET /payment/holds — Active (status=held) payment holds
    // KB: Returns only held (unsettled) holds — distinct from /history which returns all transactions.
    fastify.get('/payment/holds', async () => {
      const gate = node.getPaymentGate();
      if (!gate) return { holds: [] };
      return { holds: gate.getActiveHolds() };
    });

    // GET /payment/stats — Payment statistics
    fastify.get('/payment/stats', async () => {
      const gate = node.getPaymentGate();
      if (!gate) return { stats: null };
      return { stats: gate.getStats() };
    });

    // POST /payment/release — Release escrowed Lux to contributor on task completion
    // KB: Completes the escrow cycle: hold -> release credits recipientPeerId, marks hold 'released'.
    fastify.post('/payment/release', async (request: any, reply: any) => {
      const gate = node.getPaymentGate();
      if (!gate) return reply.code(503).send({ error: 'Payment gate not available' });
      const { holdId, recipientPeerId } = (request.body || {}) as { holdId?: string; recipientPeerId?: string };
      if (!holdId || !recipientPeerId) {
        return reply.code(400).send({ error: '"holdId" and "recipientPeerId" are required' });
      }
      const ok = gate.releasePayment(holdId, recipientPeerId);
      if (!ok) {
        return reply.code(404).send({ error: 'Hold not found or already settled', holdId });
      }
      return { ok: true, holdId, recipientPeerId };
    });

    // POST /payment/refund — Refund escrowed Lux to creator on task rejection/cancellation
    // KB: Refund path: hold -> refund returns Lux to original peerId, marks hold 'refunded'.
    fastify.post('/payment/refund', async (request: any, reply: any) => {
      const gate = node.getPaymentGate();
      if (!gate) return reply.code(503).send({ error: 'Payment gate not available' });
      const { holdId } = (request.body || {}) as { holdId?: string };
      if (!holdId) {
        return reply.code(400).send({ error: '"holdId" is required' });
      }
      const ok = gate.refundPayment(holdId);
      if (!ok) {
        return reply.code(404).send({ error: 'Hold not found or already settled', holdId });
      }
      return { ok: true, holdId };
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
        return reply.code(500).send({ error: 'Login failed' });
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
        return reply.code(401).send({ error: 'Challenge verification failed' });
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
        return reply.code(401).send({ error: 'Signature verification failed' });
      }

      // 3. Issue a JWT signed by THIS node
      const jwt = await deps.issueJwt(peerId);
      return jwt;
    });

    // ── Project Economy (Phase 31.1) ─────────────────────────────────────

    // Strip apiKey from project objects — never expose secrets in public responses
    function stripApiKey<T extends Record<string, any>>(project: T): Omit<T, 'apiKey'> {
      const { apiKey, ...safe } = project;
      return safe;
    }

    // GET /projects — List user's projects (owned + collaborating)
    fastify.get('/projects', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const query = request.query as any;

      // ?teamId= filter: look up a project by its managing team
      if (query.teamId) {
        const project = ps.getProjectByTeamId(query.teamId);
        return { projects: project ? [stripApiKey(project)] : [] };
      }

      const userId = await deps.verifyUserJwt(request);
      if (userId) {
        const owned = await ps.getProjectsByOwnerAsync(userId);
        return { projects: owned.map(stripApiKey) };
      }

      // No valid user token — return listed/featured public projects
      const projects = await ps.listProjectsAsync({
        visibility: query.visibility || 'listed',
        status: 'active',
        limit: Math.min(parseInt(query.limit) || 50, 200),
        offset: parseInt(query.offset) || 0,
      });
      return { projects: projects.map(stripApiKey) };
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

      // Public projects are visible to all; private projects require ownership
      if (project.type !== 'public' && project.visibility === 'owner_only') {
        if (!userId || project.ownerId !== userId) {
          return reply.code(403).send({ error: 'Access denied' });
        }
      }

      // Only return apiKey to the project owner
      const isOwner = userId && project.ownerId === userId;
      return { project: isOwner ? project : stripApiKey(project) };
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
        const hasBearerToken = verifyBearerToken(authHeader, deps.apiToken);
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
        teamId?: string;
      };

      if (!body.name || body.name.trim().length === 0) {
        return reply.code(400).send({ error: 'Project name is required' });
      }
      const sanitizedName = body.name.trim().slice(0, 200);
      if (body.description && body.description.length > 2000) {
        return reply.code(400).send({ error: 'Description too long (max 2000 chars)' });
      }
      if (body.budgetLimit !== undefined && (typeof body.budgetLimit !== 'number' || !isFinite(body.budgetLimit) || body.budgetLimit < 0)) {
        return reply.code(400).send({ error: 'Budget limit must be a non-negative finite number' });
      }
      if (body.tier !== undefined && body.tier !== 1 && body.tier !== 2) {
        return reply.code(400).send({ error: 'Tier must be 1 (static) or 2 (server)' });
      }
      if (body.visibility !== undefined && !['public', 'private', 'listed', 'unlisted', 'owner_only'].includes(body.visibility)) {
        return reply.code(400).send({ error: 'Visibility must be one of: public, private, listed, unlisted, owner_only' });
      }

      const project = await ps.createProject({
        name: sanitizedName,
        description: body.description || '',
        ownerId,
        type: (body.type as any) || 'private',
        visibility: (body.visibility as any) || 'owner_only',
        budgetLimit: body.budgetLimit || 0,
        ...(body.tier ? { tier: body.tier as 1 | 2 } : {}),
        ...(body.teamId ? { teamId: body.teamId } : {}),
      });

      return reply.code(201).send({ project });
    });

    // PATCH /projects/:id — Update project (owner/admin only)
    // Auth: user session OR node Bearer token (agents that created a project can update it)
    fastify.patch('/projects/:id', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Dual-auth: user session OR node Bearer token (mirrors POST /projects)
      // KB: Bearer token = node admin; bypasses ownership check so agents can update any project.
      let userId = await deps.verifyUserJwt(request);
      let isBearerAuth = false;
      if (!userId) {
        const authHeader = request.headers?.authorization || '';
        const hasBearerToken = verifyBearerToken(authHeader, deps.apiToken);
        if (hasBearerToken) {
          userId = node.getIdentity()?.peerId || '';
          isBearerAuth = true;
        }
        if (!userId) return reply.code(401).send({ error: 'Authentication required (user session or Bearer token)' });
      }

      const { id } = request.params as { id: string };
      const project2 = await ps.getProjectAsync(id);
      if (!project2) return reply.code(404).send({ error: 'Project not found' });
      if (!isBearerAuth && project2.ownerId !== userId) {
        return reply.code(403).send({ error: 'Only owner can update project' });
      }

      const body = (request.body || {}) as {
        name?: string;
        description?: string;
        type?: string;
        visibility?: string;
        budgetLimit?: number;
        tier?: number;
        repoUrl?: string;
        teamId?: string;
      };

      // Validate update fields
      if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 200)) {
        return reply.code(400).send({ error: 'Name must be a string (max 200 chars)' });
      }
      if (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 2000)) {
        return reply.code(400).send({ error: 'Description must be a string (max 2000 chars)' });
      }
      if (body.budgetLimit !== undefined && (typeof body.budgetLimit !== 'number' || !isFinite(body.budgetLimit) || body.budgetLimit < 0)) {
        return reply.code(400).send({ error: 'Budget limit must be a non-negative finite number' });
      }
      if (body.visibility !== undefined && !['public', 'private', 'listed', 'unlisted'].includes(body.visibility)) {
        return reply.code(400).send({ error: 'Visibility must be one of: public, private, listed, unlisted' });
      }

      const updates: any = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.type !== undefined) updates.type = body.type;
      if (body.visibility !== undefined) updates.visibility = body.visibility;
      if (body.budgetLimit !== undefined) updates.budgetLimit = body.budgetLimit;
      if (body.tier !== undefined) updates.tier = body.tier;
      if (body.repoUrl !== undefined) updates.repoUrl = body.repoUrl;
      if (body.teamId !== undefined) updates.teamId = body.teamId;

      const project = await ps.updateProject(id, updates);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      return { project };
    });

    // KB: Revenue Engine Routes (Phase 31.4) deleted — revenue-engine stripped in Phase 6.
    // KB: Transfer routes (Phase 31.6) deleted — transfers table stripped.

    // KB: Deployment record routes (Phase 31.7) deleted — deployments table stripped.

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
        limit: query.limit ? Math.min(parseInt(query.limit) || 50, 200) : undefined,
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

      // Strip apiKey from public marketplace listings
      if (result.projects) {
        result.projects = result.projects.map(stripApiKey);
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

      return { project: stripApiKey(project), deployment };
    });

    // KB: Rating routes (Phase 31.8) deleted — ratings table stripped.
    // KB: Contribution Tracking Routes (Phase 31.9) deleted — contribution-tracker stripped in Phase 6.

    // KB: Report routes (Phase 31.10) deleted — reports table stripped.

    // ── Phase 53: Project Resource Assignment ──────────────────────────────

    // POST /projects/:id/resources/assign — Assign a resource to a project
    fastify.post('/projects/:id/resources/assign', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Allow access if: (1) user session owner, or (2) node Bearer token + project owned by this node
      const userId = await deps.verifyUserJwt(request);
      const nodeId = node.getIdentity()?.peerId;
      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = verifyBearerToken(authHeader, deps.apiToken);
      const isNodeAdmin = !userId && hasBearerToken && project.ownerId === nodeId;

      if (userId) {
        if (project.ownerId !== userId) {
          return reply.code(403).send({ error: 'Only owner can assign resources' });
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
        return reply.code(400).send({ error: 'Failed to assign resource' });
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

      // Verify user is owner
      if (project.ownerId !== userId) {
        return reply.code(403).send({ error: 'Only owner can remove resources' });
      }

      try {
        await ps.removeResource(id, resourceId);
        const resources = ps.getProjectResources(id);
        return { resources };
      } catch (err: any) {
        return reply.code(400).send({ error: 'Failed to remove resource' });
      }
    });

    // GET /projects/:id/resources — Get all resources assigned to a project
    fastify.get('/projects/:id/resources', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Check access — owner or public
      const userId = await deps.verifyUserJwt(request);
      const isOwner = !!(userId && project.ownerId === userId);

      if (!isOwner && project.type !== 'public') {
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
      const hasBearerToken = verifyBearerToken(authHeader, deps.apiToken);
      const isNodeAdmin = !userId && hasBearerToken && project.ownerId === nodeId;

      if (userId) {
        if (project.ownerId !== userId) {
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
        console.error('[api] API key generation failed:', err.message);
        return reply.code(500).send({ error: 'API key generation failed' });
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
      if (project.ownerId !== userId) {
        return reply.code(403).send({ error: 'Only project owner can regenerate API keys' });
      }

      try {
        const apiKey = await ps.generateApiKey(id);
        return { apiKey };
      } catch (err: any) {
        console.error('[api] API key regeneration failed:', err.message);
        return reply.code(500).send({ error: 'API key regeneration failed' });
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
        const hasBearerToken = verifyBearerToken(authHeader, deps.apiToken);
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
        const gatewayUrl = process.env.HUB_PUBLIC_URL || process.env.HUB_URL || '';
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
        if (!gatewayReachable) missing.push('HUB_PUBLIC_URL not set on node');
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
      const hasBearerToken = verifyBearerToken(authHeader, deps.apiToken);
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
          console.error(`[github] Repo create failed (${createResp.status}): ${errText}`);
          return reply.code(502).send({ error: 'GitHub repo creation failed' });
        }

        // Update project record
        await ps.updateProject(id, { githubRepo: fullRepoName, repoUrl: `https://github.com/${fullRepoName}` });

        return {
          repoUrl: `https://github.com/${fullRepoName}`,
          cloneUrl: `https://github.com/${fullRepoName}.git`,
          githubRepo: fullRepoName,
        };
      } catch (err: any) {
        console.error('[github] Create repo error:', err.message);
        return reply.code(502).send({ error: 'GitHub repo creation failed' });
      }
    });

    // POST /projects/:id/github/push — Push workspace code to GitHub
    // GOVERNANCE ENFORCEMENT: Blocks push if the workspace is a governance-required
    // repo (e.g., the pando node repo itself). User project repos are unaffected.
    fastify.post('/projects/:id/github/push', async (request: any, reply: any) => {
      const ps = node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = verifyBearerToken(authHeader, deps.apiToken);
      const userId = await deps.verifyUserJwt(request);
      if (!userId && !hasBearerToken) return reply.code(401).send({ error: 'Authentication required' });

      const { id } = request.params as { id: string };
      const body = (request.body || {}) as { workspaceDir?: string };
      if (!body.workspaceDir) return reply.code(400).send({ error: 'workspaceDir required' });

      // Governance guard: check if the workspace is a governance-required repo.
      // Teams with governanceRequired=true must go through commit-and-propose,
      // not this direct push endpoint.
      const teamRegistry = node.getTeamRegistry();
      if (teamRegistry) {
        const allTeams = teamRegistry.listTeams();
        const normalizedWorkDir = body.workspaceDir.replace(/\\/g, '/').toLowerCase();
        const cwd = process.cwd().replace(/\\/g, '/').toLowerCase();
        for (const team of allTeams) {
          if (!team.governanceRequired) continue;
          // Block if workspaceDir IS the node's own repo (governance-protected)
          if (normalizedWorkDir === cwd || normalizedWorkDir.startsWith(cwd + '/')) {
            console.warn(`[github] Push BLOCKED: workspace ${body.workspaceDir} is within governance-required repo (team: ${team.id})`);
            return reply.code(403).send({
              error: `Push blocked: this repository requires governance approval. Use POST /v1/infra/commit-and-propose instead.`,
              team: team.id,
              governanceRequired: true,
            });
          }
        }
      }

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
          console.error('[github] Repo creation failed during push:', err.message);
          return reply.code(502).send({ error: 'GitHub repo creation failed' });
        }
      }

      // Get GitHub token
      const registry = node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'ResourceRegistry not available' });
      const githubResources = registry.findResources('code_repository' as any);
      if (!githubResources.length) return reply.code(503).send({ error: 'No code_repository resource' });
      const githubToken = await registry.getCredential(githubResources[0].resourceId);
      if (!githubToken) return reply.code(503).send({ error: 'Could not decrypt GitHub credential' });

      const { existsSync: fsExists } = await import('node:fs');
      const { GitOps } = await import('../core/git-ops.js');
      const workDir = body.workspaceDir;

      if (!fsExists(workDir)) return reply.code(400).send({ error: 'Workspace directory not found' });

      try {
        const pushUrl = `https://x-access-token:${githubToken}@github.com/${project.githubRepo}.git`;
        const git = new GitOps(workDir);

        // Init git if needed
        if (!fsExists(`${workDir}/.git`)) {
          git.init();
        }
        git.config('user.email', 'deploy@pando.network');
        git.config('user.name', 'Pando Deploy');
        git.add(['-A']);

        const commitMsg = `Deploy ${new Date().toISOString().slice(0, 19)}`;
        try { git.commit(commitMsg); } catch {}

        git.remoteRemove('origin');
        git.remoteAdd('origin', pushUrl);
        git.exec(['push', '-u', 'origin', 'HEAD:main', '--force'], { timeout: 60_000 });

        const commitSha = git.getCurrentCommit();
        console.log(`[github] Pushed to ${project.githubRepo} (${commitSha.slice(0, 8)})`);

        return {
          pushed: true,
          commitSha,
          repoUrl: `https://github.com/${project.githubRepo}`,
          githubRepo: project.githubRepo,
        };
      } catch (err: any) {
        console.error('[github] Push failed:', err.message);
        return reply.code(502).send({ error: 'GitHub push failed' });
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
      const hasBearerToken = verifyBearerToken(authHeader, deps.apiToken);
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
          errors.push('URL fetch failed');
        }
      } else {
        errors.push('No deployment URL found');
      }

      // Check 2: Gateway URL injected
      const gatewayInjected = htmlContent.includes('PANDO_HUB_URL');

      // Check 3: API key injected
      const apiKeyInjected = htmlContent.includes('PANDO_PROJECT_API_KEY');

      // Check 4: Resource Proxy responds (test with count on __preflight_test collection)
      let resourceProxyWorks = false;
      if (project.apiKey) {
        const gatewayUrl = process.env.HUB_PUBLIC_URL || process.env.HUB_URL || '';
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
            errors.push('Resource Proxy test failed');
          }
        }
      }

      // Gateway/API key injection only expected for Tier 1 static sites (HTML served from S3)
      // Tier 2 server apps handle their own responses — injection checks don't apply
      if (projectTier === 1) {
        if (!gatewayInjected && urlResponds) errors.push('PANDO_HUB_URL not found in HTML');
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

      const gatewayPublicUrl = process.env.HUB_PUBLIC_URL
        || process.env.HUB_URL
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
          url: process.env.HUB_URL || 'http://127.0.0.1:3222',
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

}
