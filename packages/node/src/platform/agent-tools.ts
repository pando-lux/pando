/**
 * agent-tools.ts -- HTTP API endpoints for agent tools (Phase 27-A)
 *
 * Registers Fastify routes that agents call via curl from their Claude Code
 * sessions. Also used by the gateway and external tooling.
 *
 * Auth model (matches api-server.ts):
 *   - GET endpoints are public (read-only)
 *   - POST/PUT/DELETE require Authorization: Bearer <token>
 *   (Auth is enforced by the global onRequest hook in api-server.ts,
 *    so these routes do NOT need per-route auth checks.)
 *
 * All routes check for AgentManager availability and return 503 if the
 * agent system is not started.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AgentManager, ProjectAccessLevel } from '../core/agent-manager.js';
import type { AgentRole } from '../core/agent.js';
import type { BridgeItemType } from '../core/bridge-queue.js';

// ── Route Registration ────────────────────────────────────────────────────────

export function registerAgentRoutes(
  fastify: FastifyInstance,
  getAgentManager: () => AgentManager | null,
  getApiToken: () => string,
): void {

  // ── Helper: get AgentManager or 503 ────────────────────────────────────────

  function requireAgentManager(reply: FastifyReply): AgentManager | null {
    const mgr = getAgentManager();
    if (!mgr) {
      reply.code(503).send({ error: 'Agent system not started' });
      return null;
    }
    return mgr;
  }

  // ── Agent Management (POST — auth required) ────────────────────────────────

  /**
   * POST /agents/spawn
   * Spawn a new agent in the agent tree.
   * Body: { role, template?, parentId, projectId, description, taskContext? }
   */
  fastify.post('/agents/spawn', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { role, template, parentId, projectId, description, taskContext } = request.body || {};

    // Validate required fields
    if (!role || typeof role !== 'string') {
      return reply.code(400).send({ error: 'role is required (manager|builder|tester|reviewer|researcher|devops)' });
    }
    const validRoles: AgentRole[] = ['manager', 'builder', 'tester', 'reviewer', 'researcher', 'devops'];
    if (!validRoles.includes(role as AgentRole)) {
      return reply.code(400).send({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }
    if (!projectId || typeof projectId !== 'string') {
      return reply.code(400).send({ error: 'projectId is required' });
    }
    if (!description || typeof description !== 'string') {
      return reply.code(400).send({ error: 'description is required' });
    }

    try {
      const requestedBy = (request as any).actor?.id;
      const agentId = await agentManager.spawnAgent({
        role: role as AgentRole,
        template: template || undefined,
        parentId: parentId || null,
        projectId,
        description,
        taskContext: taskContext || undefined,
        requestedBy,
      });

      if (!agentId) {
        return reply.code(409).send({ error: 'Spawn denied — hard limits exceeded (depth, count, or budget)' });
      }

      return { agentId };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to spawn agent' });
    }
  });

  /**
   * POST /agents/:id/message
   * Enqueue a message to an agent's bridge queue.
   * Body: { prompt, priority?, source? }
   */
  fastify.post('/agents/:id/message', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { id } = request.params || {};
    const { prompt, priority, source } = request.body || {};

    if (!id) {
      return reply.code(400).send({ error: 'Agent ID is required' });
    }
    if (!prompt || typeof prompt !== 'string') {
      return reply.code(400).send({ error: 'prompt is required' });
    }

    const validPriorities = ['critical', 'normal', 'low'];
    const resolvedPriority = priority && validPriorities.includes(priority) ? priority : 'normal';

    try {
      agentManager.getBridge().enqueue(id, {
        type: 'worker_message' as BridgeItemType,
        source: source || 'api',
        payload: { message: prompt },
        priority: resolvedPriority,
      });

      return { queued: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to enqueue message' });
    }
  });

  /**
   * POST /agents/:id/report
   * Report task status from a child agent to its parent's bridge queue.
   * Body: { status: 'complete'|'failed'|'progress', summary, details? }
   */
  fastify.post('/agents/:id/report', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { id } = request.params || {};
    const { status, summary, details } = request.body || {};

    if (!id) {
      return reply.code(400).send({ error: 'Agent ID is required' });
    }
    if (!status || typeof status !== 'string') {
      return reply.code(400).send({ error: 'status is required (complete|failed|progress)' });
    }
    const validStatuses = ['complete', 'failed', 'progress'];
    if (!validStatuses.includes(status)) {
      return reply.code(400).send({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }
    if (!summary || typeof summary !== 'string') {
      return reply.code(400).send({ error: 'summary is required' });
    }

    // Look up the reporting agent to find its parent
    const agent = agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: `Agent ${id} not found` });
    }

    const state = agent.getState();
    const parentId = state.parentId;

    if (!parentId) {
      // Top-level agent with no parent — log the report but still acknowledge
      console.log(`[agent-tools] Top-level agent ${id} reported: ${status} — ${summary}`);
      return { received: true, note: 'No parent agent — report logged' };
    }

    // Map status to bridge event type
    const typeMap: Record<string, BridgeItemType> = {
      complete: 'task_completed',
      failed: 'task_failed',
      progress: 'progress',
    };

    const priorityMap: Record<string, 'critical' | 'normal' | 'low'> = {
      complete: 'normal',
      failed: 'critical',
      progress: 'low',
    };

    try {
      agentManager.getBridge().enqueue(parentId, {
        type: typeMap[status],
        source: id,
        payload: {
          agentId: id,
          status,
          summary,
          details: details || undefined,
        },
        priority: priorityMap[status],
      });

      return { received: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to enqueue report' });
    }
  });

  /**
   * POST /agents/:id/resume
   * Resume an existing agent with a new prompt.
   * Body: { prompt }
   */
  fastify.post('/agents/:id/resume', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { id } = request.params || {};
    const { prompt } = request.body || {};

    if (!id) {
      return reply.code(400).send({ error: 'Agent ID is required' });
    }
    if (!prompt || typeof prompt !== 'string') {
      return reply.code(400).send({ error: 'prompt is required' });
    }

    const agent = agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: `Agent ${id} not found` });
    }

    try {
      // Fire and forget — resume is async but we don't wait for the Claude Code
      // spawn to complete. The caller gets an immediate acknowledgement.
      agentManager.resumeAgent(id, prompt).catch((err: any) => {
        console.error(`[agent-tools] Resume failed for ${id}: ${err.message}`);
      });

      return { resumed: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to resume agent' });
    }
  });

  /**
   * POST /agents/:id/rotate
   * Rotate an agent's session (knowledge dump → fresh session).
   */
  fastify.post('/agents/:id/rotate', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { id } = request.params || {};

    if (!id) {
      return reply.code(400).send({ error: 'Agent ID is required' });
    }

    const agent = agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: `Agent ${id} not found` });
    }

    try {
      // Fire and forget — rotation involves two Claude Code spawns and takes
      // a long time. Return immediately and let it run in the background.
      agentManager.rotateAgent(id).catch((err: any) => {
        console.error(`[agent-tools] Rotation failed for ${id}: ${err.message}`);
      });

      return { rotated: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to rotate agent' });
    }
  });

  /**
   * POST /agents/:id/reset-session
   * Reset an agent's session — forces a fresh CLAUDE.md read on the next event.
   * Use this when context compression has caused the agent to lose its
   * CLAUDE.md instructions (e.g., forgetting to deploy after 100+ tasks).
   */
  fastify.post('/agents/:id/reset-session', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { id } = request.params || {};

    if (!id) {
      return reply.code(400).send({ error: 'Agent ID is required' });
    }

    const agent = agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: `Agent ${id} not found` });
    }

    try {
      agent.resetSession();
      return { success: true, message: `Session reset for ${id}. Next event will start fresh.` };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to reset session' });
    }
  });

  /**
   * POST /agents/:id/resurrect
   * Resurrect an archived agent.
   */
  fastify.post('/agents/:id/resurrect', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { id } = request.params || {};

    if (!id) {
      return reply.code(400).send({ error: 'Agent ID is required' });
    }

    const agent = agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: `Agent ${id} not found` });
    }

    try {
      const success = await agentManager.resurrectAgent(id);
      if (!success) {
        return reply.code(409).send({ error: `Agent ${id} cannot be resurrected (not archived)` });
      }
      return { resurrected: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to resurrect agent' });
    }
  });

  // ── Agent Queries (GET — no auth) ──────────────────────────────────────────

  /**
   * GET /agents/tree
   * Get the hierarchical agent tree. Optional ?projectId= filter.
   */
  fastify.get('/agents/tree', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const projectId = (request.query as any)?.projectId as string | undefined;

    try {
      const tree = agentManager.getAgentTree(projectId || undefined);
      return tree;
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to get agent tree' });
    }
  });

  /**
   * GET /agents/list
   * List all agents (flat). Optional ?projectId= filter.
   */
  fastify.get('/agents/list', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const projectId = (request.query as any)?.projectId as string | undefined;

    try {
      const agents = agentManager.listAgents(projectId || undefined);
      return agents;
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to list agents' });
    }
  });

  /**
   * GET /agents/:id/status
   * Get the state of a single agent.
   */
  fastify.get('/agents/:id/status', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { id } = request.params || {};

    if (!id) {
      return reply.code(400).send({ error: 'Agent ID is required' });
    }

    const agent = agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: `Agent ${id} not found` });
    }

    try {
      return agent.getState();
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to get agent status' });
    }
  });

  /**
   * GET /agents/:parentId/children
   * List child agents of a parent, optionally filtered by role.
   * Query params: ?role=tester (optional)
   */
  fastify.get('/agents/:parentId/children', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { parentId } = request.params || {};
    const { role } = request.query || {};

    if (!parentId) {
      return reply.code(400).send({ error: 'parentId is required' });
    }

    const parent = agentManager.getAgent(parentId);
    if (!parent) {
      return reply.code(404).send({ error: 'Agent not found' });
    }

    try {
      const children = parent.getChildren()
        .map((id: string) => agentManager.getAgent(id))
        .filter((c: any) => c && (!role || c.getState().role === role))
        .map((c: any) => ({
          id: c.id,
          role: c.getState().role,
          status: c.getStatus(),
          taskCount: c.getState().taskCount || 0,
          description: c.getState().description || '',
        }));

      return { children };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to list children' });
    }
  });

  // ── Project Management ──────────────────────────
  // All /projects routes moved to api-server.ts (Phase 31.2) with proper
  // user-token auth and ProjectStore persistence. Only agent-specific
  // routes remain here.

  /**
   * POST /agents/:id/connect
   * Connect a user directly to an agent (bypass manager routing).
   * Body: { userId }
   */
  fastify.post('/agents/:id/connect', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { id: agentId } = request.params || {};
    const { userId } = request.body || {};

    if (!agentId) return reply.code(400).send({ error: 'Agent ID is required' });
    if (!userId) return reply.code(400).send({ error: 'userId is required' });

    const success = agentManager.connectUserToAgent(userId, agentId);
    if (!success) return reply.code(404).send({ error: `Agent ${agentId} not found` });

    return { connected: true, userId, agentId };
  });

  /**
   * POST /agents/:id/disconnect
   * Disconnect a user from direct agent connection.
   * Body: { userId }
   */
  fastify.post('/agents/:id/disconnect', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { userId } = request.body || {};
    if (!userId) return reply.code(400).send({ error: 'userId is required' });

    agentManager.disconnectUser(userId);
    return { disconnected: true, userId };
  });

  // ── Standing Directive Management (Phase 29 — auth required) ──────────────

  /**
   * POST /agents/:id/directive
   * Set a standing directive on an agent for self-continuation.
   * Body: { instruction, completionCondition, maxDuration?, maxCost?, createdBy? }
   */
  fastify.post('/agents/:id/directive', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { id } = request.params || {};
    const agent = agentManager.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const { instruction, completionCondition, maxDuration, maxCost, createdBy } = request.body || {};
    if (!instruction) return reply.code(400).send({ error: 'Missing instruction' });
    if (!completionCondition) return reply.code(400).send({ error: 'Missing completionCondition' });

    agent.setStandingDirective({
      instruction,
      completionCondition,
      createdAt: Date.now(),
      createdBy: createdBy || 'user',
      progress: '',
      maxDuration: maxDuration || 86400000,  // 24h default
      maxCost: maxCost || 50,  // $50 default
    });

    return { success: true, directive: agent.getStandingDirective() };
  });

  /**
   * DELETE /agents/:id/directive
   * Clear a standing directive from an agent.
   */
  fastify.delete('/agents/:id/directive', async (request: any, reply: any) => {
    const agentManager = requireAgentManager(reply);
    if (!agentManager) return;

    const { id } = request.params || {};
    const agent = agentManager.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    agent.clearStandingDirective();
    return { success: true };
  });

  // Phase 70: POST /agents/:id/deploy removed.
  // Deployment now uses unified POST /projects/:id/deploy (see api-server.ts).
}
