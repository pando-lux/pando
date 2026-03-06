/**
 * agent-tools.ts -- HTTP API endpoints for agent management.
 *
 * Registers Fastify routes for agent/orchestrator lifecycle.
 * Uses the new agent system: AgentDatabase, WorkerPool, MessageBus, OrgManager.
 *
 * Auth model (matches api-server.ts):
 *   - GET endpoints are public (read-only)
 *   - POST/PUT/DELETE require Authorization: Bearer <token>
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AgentDatabase } from './agent-database.js';
import type { WorkerPool } from '../core/worker-pool.js';
import type { MessageBus } from '../core/message-bus.js';
import type { OrgManager } from './org-manager.js';

// ── Deps interface ────────────────────────────────────────────────────────────

export interface AgentRouteDeps {
  getDb: () => AgentDatabase | null;
  getWorkerPool: () => WorkerPool | null;
  getMessageBus: () => MessageBus | null;
  getOrgManager: () => OrgManager | null;
  getApiToken: () => string;
}

// ── Route Registration ────────────────────────────────────────────────────────

export function registerAgentRoutes(
  fastify: FastifyInstance,
  deps: AgentRouteDeps,
): void {

  function requireDb(reply: FastifyReply): AgentDatabase | null {
    const db = deps.getDb();
    if (!db) {
      reply.code(503).send({ error: 'Agent system not started' });
      return null;
    }
    return db;
  }

  // ── Spawn worker (POST — auth required) ──────────────────────────────────

  fastify.post('/agents/spawn', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;
    const pool = deps.getWorkerPool();
    if (!pool) return reply.code(503).send({ error: 'Worker pool not started' });

    const { role, orchestratorId, taskId, projectId, fileScope } = request.body || {};

    if (!role || typeof role !== 'string') {
      return reply.code(400).send({ error: 'role is required (builder|tester|reviewer|researcher|devops)' });
    }
    // Phase 105: Validate role against template registry (data-driven) with fallback to known roles
    const knownRoles = ['builder', 'tester', 'reviewer', 'researcher', 'devops'];
    if (!knownRoles.includes(role)) {
      // Check if there's a custom template registered for this role
      const registry = deps.getWorkerPool()?.getTemplateRegistry?.();
      if (registry && !registry.resolveTemplate(role)) {
        return reply.code(400).send({ error: `No template found for role "${role}". Use GET /v1/templates to see available roles.` });
      }
    }

    // Resolve orchestratorId — use provided or find/create for project
    let parentId = orchestratorId;
    if (!parentId && projectId) {
      const org = deps.getOrgManager();
      if (org) parentId = org.getOrchestratorForProject(projectId);
    }
    if (!parentId) {
      return reply.code(400).send({ error: 'orchestratorId or projectId is required' });
    }

    // Validate orchestrator exists in agent_identity table
    const parentAgent = db.getAgent(parentId);
    if (!parentAgent) {
      return reply.code(400).send({ error: `Orchestrator "${parentId}" not found. Use GET /v1/agents/tree to see active orchestrators.` });
    }

    try {
      const workerId = await pool.spawn({
        role,
        orchestratorId: parentId,
        taskId,
        projectId,
        fileScope,
      });
      return { workerId };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to spawn worker' });
    }
  });

  // ── Send message to agent (POST — auth required) ─────────────────────────

  fastify.post('/agents/:id/message', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;
    const bus = deps.getMessageBus();
    if (!bus) return reply.code(503).send({ error: 'Message bus not started' });

    const { id } = request.params || {};
    const { prompt, message, priority, source } = request.body || {};
    const content = prompt || message;

    if (!id) return reply.code(400).send({ error: 'Agent ID is required' });
    if (!content || typeof content !== 'string') {
      return reply.code(400).send({ error: 'prompt or message is required' });
    }

    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `Agent ${id} not found` });

    try {
      // Route as user_request if from user/api, so orchestrators classify it as Tier 2
      const msgType = (source === 'worker') ? 'worker_message' : 'user_request';
      bus.send({
        recipientId: id,
        senderId: source || 'api',
        senderType: source === 'worker' ? 'worker' : 'system',
        type: msgType,
        payload: { message: content },
        priority: priority === 'critical' ? 0 : priority === 'low' ? 2 : 1,
      });
      return { queued: true };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to send message' });
    }
  });

  // ── Report from worker to parent (POST — auth required) ──────────────────

  fastify.post('/agents/:id/report', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;
    const bus = deps.getMessageBus();
    if (!bus) return reply.code(503).send({ error: 'Message bus not started' });

    const { id } = request.params || {};
    const { status, summary, details, difficulties, suggestions } = request.body || {};

    if (!id) return reply.code(400).send({ error: 'Agent ID is required' });
    if (!status) return reply.code(400).send({ error: 'status is required (done|failed|progress)' });
    if (!summary) return reply.code(400).send({ error: 'summary is required' });

    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `Agent ${id} not found` });

    // Update worker status
    // Done workers go 'idle' (persistent — available for reassignment) instead of 'done'
    if (status === 'done' || status === 'complete') {
      db.updateAgent(id, { status: 'idle' });
    } else if (status === 'failed') {
      db.updateAgent(id, { status: 'failed' });
    }

    // Send report to parent orchestrator
    if (agent.parentId) {
      try {
        bus.send({
          recipientId: agent.parentId,
          senderId: id,
          senderType: 'worker',
          type: 'worker_report',
          payload: { status, summary, details, difficulties, suggestions, taskId: agent.currentTaskId },
          priority: status === 'failed' ? 0 : 1,
        });
      } catch (err: any) {
        console.error(`[agent-tools] Report routing failed for ${id}: ${err.message}`);
      }
    }

    return { received: true };
  });

  // ── Reset session (POST — auth required) ─────────────────────────────────

  fastify.post('/agents/:id/reset-session', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;

    const { id } = request.params || {};
    if (!id) return reply.code(400).send({ error: 'Agent ID is required' });

    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `Agent ${id} not found` });

    db.updateAgent(id, { sessionId: null });
    return { success: true, message: `Session reset for ${id}. Next spawn will start fresh.` };
  });

  // ── Kill worker (POST — auth required) ───────────────────────────────────

  fastify.post('/agents/:id/kill', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;
    const pool = deps.getWorkerPool();
    if (!pool) return reply.code(503).send({ error: 'Worker pool not started' });

    const { id } = request.params || {};
    if (!id) return reply.code(400).send({ error: 'Agent ID is required' });

    pool.kill(id);
    return { killed: true };
  });

  // ── Agent Queries (GET — no auth) ────────────────────────────────────────

  /**
   * GET /agents/tree
   * Hierarchical tree of orchestrators and workers.
   */
  fastify.get('/agents/tree', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;
    const org = deps.getOrgManager();
    if (!org) return reply.code(503).send({ error: 'Org manager not started' });

    try {
      return org.getTree();
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to get agent tree' });
    }
  });

  /**
   * GET /agents/list
   * Flat list of all agents. Optional ?type=worker|orchestrator&status=active
   */
  fastify.get('/agents/list', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;

    const { type, status, projectId } = (request.query as any) || {};
    const filters: any = {};
    if (type) filters.type = type;
    if (status) filters.status = status;
    if (projectId) filters.projectId = projectId;

    try {
      return db.listAgents(filters);
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to list agents' });
    }
  });

  /**
   * GET /agents/:id/status
   * Single agent status.
   */
  fastify.get('/agents/:id/status', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;

    const { id } = request.params || {};
    if (!id) return reply.code(400).send({ error: 'Agent ID is required' });

    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `Agent ${id} not found` });

    return agent;
  });

  /**
   * GET /agents/:parentId/children
   * List children of an orchestrator. Optional ?role= filter.
   */
  fastify.get('/agents/:parentId/children', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;

    const { parentId } = request.params || {};
    const { role } = (request.query as any) || {};

    if (!parentId) return reply.code(400).send({ error: 'parentId is required' });

    const parent = db.getAgent(parentId);
    if (!parent) return reply.code(404).send({ error: 'Agent not found' });

    let children = db.getChildren(parentId);
    if (role) {
      children = children.filter(c => c.role === role);
    }

    return { children };
  });

  // ── Directive Management (POST — auth required) ──────────────────────────

  fastify.post('/agents/:id/directive', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;

    const { id } = request.params || {};
    const { content, issuedBy } = request.body || {};

    if (!id) return reply.code(400).send({ error: 'Agent ID is required' });
    if (!content) return reply.code(400).send({ error: 'content is required' });

    const agent = db.getAgent(id);
    if (!agent) return reply.code(404).send({ error: `Agent ${id} not found` });

    db.addDirective({
      targetId: id,
      content,
      addedBy: issuedBy || 'user',
    });

    return { success: true };
  });

  fastify.delete('/agents/:id/directive', async (request: any, reply: any) => {
    const db = requireDb(reply);
    if (!db) return;

    const { id } = request.params || {};
    if (!id) return reply.code(400).send({ error: 'Agent ID is required' });

    const directives = db.getDirectives(id);
    for (const d of directives) {
      db.deactivateDirective(d.id);
    }
    return { success: true, deactivated: directives.length };
  });

  // ── Orchestrator Management (POST — auth required) ───────────────────────

  /**
   * POST /orchestrators/create
   * Create a new orchestrator in the hierarchy.
   */
  fastify.post('/orchestrators/create', async (request: any, reply: any) => {
    const org = deps.getOrgManager();
    if (!org) return reply.code(503).send({ error: 'Org manager not started' });

    const { role, parentId, projectId, scope, rolePrompt, tickIntervalMs, maxWorkers } = request.body || {};

    if (!role) return reply.code(400).send({ error: 'role is required' });

    try {
      const orchestratorId = org.createOrchestrator({
        role,
        parentId,
        projectId,
        scope,
        rolePrompt,
        tickIntervalMs,
        maxWorkers,
      });
      return { orchestratorId };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message || 'Failed to create orchestrator' });
    }
  });

  /**
   * POST /orchestrators/:id/dissolve
   * Dissolve an orchestrator and all its children.
   */
  fastify.post('/orchestrators/:id/dissolve', async (request: any, reply: any) => {
    const org = deps.getOrgManager();
    if (!org) return reply.code(503).send({ error: 'Org manager not started' });

    const { id } = request.params || {};
    if (!id) return reply.code(400).send({ error: 'Orchestrator ID is required' });

    org.dissolve(id);
    return { dissolved: true };
  });
}
