/**
 * Worker MCP — HTTP API endpoints that serve as the worker's lifeline.
 *
 * 3 endpoints per worker, backed by SQLite (AgentDatabase):
 *   GET  /v1/worker/:id/task      — get current task assignment
 *   POST /v1/worker/:id/report    — report progress/completion/failure
 *   GET  /v1/worker/:id/identity  — who am I, what can I do
 *
 * These are the worker's equivalent of MCP tools. They survive context
 * compaction because they read from SQLite, not conversation history.
 * Workers learn about these endpoints from their CLAUDE.md.
 *
 * Future: upgrade to proper MCP stdio server for tighter integration.
 */

import type { FastifyInstance } from 'fastify';
import type { AgentDatabase, InboxMessage } from '../platform/agent-database.js';

export interface WorkerTaskResponse {
  taskId: string | null;
  title: string;
  description: string;
  files: string[];
  orchestratorNotes: string | null;
  status: string;
}

export interface WorkerIdentityResponse {
  id: string;
  role: string;
  scope: string;
  parentId: string | null;
  projectId: string | null;
  authority: Record<string, unknown> | null;
  budgetSpent: number;
  budgetLimit: number;
  status: string;
}

export interface ReportProgressBody {
  status: 'in_progress' | 'done' | 'stuck' | 'question' | 'failed';
  summary: string;
  filesChanged?: string[];
  difficulties?: string[];
  suggestions?: string[];
  error?: string;
}

/**
 * Register worker tool HTTP routes on the Fastify server.
 * Called once during server setup.
 */
export function registerWorkerRoutes(
  server: FastifyInstance,
  getDb: () => AgentDatabase,
  getTaskDb?: () => any,  // TaskDatabase, optional for task lookups
): void {

  // -------------------------------------------------------------------------
  // GET /v1/worker/:id/task — What should I be doing?
  // -------------------------------------------------------------------------
  server.get<{ Params: { id: string } }>('/worker/:id/task', async (request, reply) => {
    const db = getDb();
    const agent = db.getAgent(request.params.id);

    if (!agent) {
      return reply.status(404).send({ error: 'Worker not found' });
    }

    if (agent.type !== 'worker') {
      return reply.status(400).send({ error: 'Not a worker agent' });
    }

    // If no task assigned, return helpful message
    if (!agent.currentTaskId) {
      return reply.send({
        taskId: null,
        title: 'No task assigned',
        description: 'You have no task currently assigned. Your orchestrator will assign one when ready. Call report_progress with status "idle" if you want to signal availability.',
        files: [],
        orchestratorNotes: null,
        status: 'idle',
      } satisfies WorkerTaskResponse);
    }

    // Look up task details from task database if available
    let taskTitle = 'Task ' + agent.currentTaskId;
    let taskDescription = '';
    let taskFiles: string[] = [];
    let taskStatus = 'assigned';

    if (getTaskDb) {
      try {
        const taskDb = getTaskDb();
        const task = taskDb.getTask(agent.currentTaskId);
        if (task) {
          taskTitle = task.title || taskTitle;
          taskDescription = task.description || '';
          taskStatus = task.status || 'assigned';
          // File scope from agent identity or task
          if (agent.fileScope) {
            try { taskFiles = JSON.parse(agent.fileScope); } catch { /* ignore */ }
          }
        }
      } catch { /* task db not available, use basic info */ }
    }

    // Check for orchestrator notes (recent messages from parent)
    let orchestratorNotes: string | null = null;
    if (agent.parentId) {
      const recentMessages = db.readInbox(agent.id, 5);
      const fromParent = recentMessages.filter(m => m.senderId === agent.parentId);
      if (fromParent.length > 0) {
        const latest = fromParent[0];
        try {
          const payload = JSON.parse(latest.payload);
          orchestratorNotes = payload.notes || payload.message || null;
        } catch { /* ignore */ }
      }
    }

    return reply.send({
      taskId: agent.currentTaskId,
      title: taskTitle,
      description: taskDescription,
      files: taskFiles,
      orchestratorNotes,
      status: taskStatus,
    } satisfies WorkerTaskResponse);
  });

  // -------------------------------------------------------------------------
  // POST /v1/worker/:id/report — Report progress to orchestrator
  // -------------------------------------------------------------------------
  server.post<{ Params: { id: string }; Body: ReportProgressBody }>('/worker/:id/report', async (request, reply) => {
    const db = getDb();
    const agent = db.getAgent(request.params.id);

    if (!agent) {
      return reply.status(404).send({ error: 'Worker not found' });
    }

    if (agent.type !== 'worker') {
      return reply.status(400).send({ error: 'Not a worker agent' });
    }

    if (!agent.parentId) {
      return reply.status(400).send({ error: 'Worker has no parent orchestrator' });
    }

    const body = request.body;

    // Send message to parent orchestrator's inbox
    const messageId = db.sendMessage({
      recipientId: agent.parentId,
      senderId: agent.id,
      senderType: 'worker',
      type: 'worker_report',
      payload: JSON.stringify({
        status: body.status,
        summary: body.summary,
        filesChanged: body.filesChanged || [],
        difficulties: body.difficulties || [],
        suggestions: body.suggestions || [],
        error: body.error,
        taskId: agent.currentTaskId,
      }),
      priority: body.status === 'failed' ? 0 : 1,  // failures are critical
    });

    // Update worker's last report time
    db.updateAgent(agent.id, { lastReportAt: new Date().toISOString() });

    // If done or failed, update worker status
    // Done workers go 'idle' (persistent — available for reassignment) instead of 'done'
    if (body.status === 'done') {
      db.updateAgent(agent.id, { status: 'idle' });
    } else if (body.status === 'failed') {
      db.updateAgent(agent.id, { status: 'failed' });
    }

    return reply.send({
      ok: true,
      messageId,
      message: `Report sent to orchestrator ${agent.parentId}`,
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/worker/:id/identity — Who am I?
  // -------------------------------------------------------------------------
  server.get<{ Params: { id: string } }>('/worker/:id/identity', async (request, reply) => {
    const db = getDb();
    const agent = db.getAgent(request.params.id);

    if (!agent) {
      return reply.status(404).send({ error: 'Worker not found' });
    }

    let authority: Record<string, unknown> | null = null;
    if (agent.authority) {
      try { authority = JSON.parse(agent.authority); } catch { /* ignore */ }
    }

    return reply.send({
      id: agent.id,
      role: agent.role,
      scope: agent.scope,
      parentId: agent.parentId,
      projectId: agent.projectId,
      authority,
      budgetSpent: agent.budgetSpent,
      budgetLimit: agent.budgetLimit,
      status: agent.status,
    } satisfies WorkerIdentityResponse);
  });
}

/**
 * Generate tool endpoint documentation for workers.
 * Used in assembleContext() (legacy path). New boot prompt uses buildBootPrompt() instead.
 */
export function generateWorkerToolsDocs(workerId: string, apiPort: number): string {
  const base = `http://localhost:${apiPort}/v1`;
  return `
## Your Tools (call these HTTP endpoints anytime)

### Get your current task
\`\`\`bash
curl ${base}/worker/${workerId}/task
\`\`\`
Returns: { taskId, title, description, files, orchestratorNotes, status }
**Call this if you forget what you're doing** or if your context was compacted.

### Report progress
\`\`\`bash
curl -X POST ${base}/worker/${workerId}/report -H 'Content-Type: application/json' -d '{
  "status": "done|in_progress|stuck|question|failed",
  "summary": "What you did or what's wrong",
  "filesChanged": ["file1.ts", "file2.ts"],
  "difficulties": ["optional: what was hard"],
  "suggestions": ["optional: ideas for improvement"]
}'
\`\`\`
**Call this when you complete a task, make progress, get stuck, or fail.**

### Get your identity
\`\`\`bash
curl ${base}/worker/${workerId}/identity
\`\`\`
Returns: { id, role, scope, parentId, projectId, authority, budget }

### Get project context (architecture, genome, discoveries)
\`\`\`bash
curl "${base}/context/project?id=<projectId>&task=<taskDescription>&workspaceDir=<path>"
\`\`\`
Returns project architecture, framework conventions, and shared worker discoveries.

### Get lessons (what past workers learned)
\`\`\`bash
curl "${base}/context/lessons?role=<role>&projectId=<id>"
\`\`\`

### Share a discovery with the team
\`\`\`bash
curl -X POST ${base}/context/discover -H 'Content-Type: application/json' -d '{
  "agentId": "${workerId}",
  "projectId": "<id>",
  "category": "convention|gotcha|dependency|pattern|decision",
  "content": "What you discovered about this project"
}'
\`\`\`
`.trim();
}
