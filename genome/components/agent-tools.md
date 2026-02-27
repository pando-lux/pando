---
id: agent-tools
type: service
domain: platform
entry: packages/node/src/platform/agent-tools.ts
depends_on: [agent-database, worker-pool, message-bus, org-manager]
depended_by: [api-server]
exposes:
  - registerAgentRoutes(fastify, deps: AgentRouteDeps) — register all agent HTTP API routes
rules: []
last_verified: 2026-02-27
---

# Agent Tools

## What It Does

HTTP API route handlers for the agent system. Uses `AgentRouteDeps` interface to access AgentDatabase, WorkerPool, MessageBus, and OrgManager.

Registered on the Fastify server by `api-server.ts` during startup.

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /agents/spawn | Yes | Spawn a worker via WorkerPool. Body: `{role, parentId, projectId, context}` |
| POST | /agents/:id/message | Yes | Send message via MessageBus. Body: `{content, type, senderId}` |
| POST | /agents/:id/report | Yes | Worker reports completion. Body: `{status, output, cost}` |
| POST | /agents/:id/reset-session | Yes | Reset an agent's session ID |
| POST | /agents/:id/kill | Yes | Kill a worker via WorkerPool |
| GET | /agents/tree | No | Full org hierarchy via OrgManager.getTree() |
| GET | /agents/list | No | List all agents from AgentDatabase |
| GET | /agents/:id/status | No | Single agent status from AgentDatabase |
| GET | /agents/:parentId/children | No | List children of an agent |
| POST | /agents/:id/directive | Yes | Add directive to agent via AgentDatabase |
| DELETE | /agents/:id/directive | Yes | Deactivate all directives for agent |
| POST | /orchestrators/create | Yes | Create new orchestrator via OrgManager |
| POST | /orchestrators/:id/dissolve | Yes | Dissolve orchestrator and promote lessons |

## Worker Tool Endpoints (worker-mcp.ts)

Registered alongside agent routes. Workers call these from their Claude Code sessions:

| Method | Path | Description |
|---|---|---|
| GET | /worker/:id/task | Get assigned task for worker |
| POST | /worker/:id/report | Report progress/completion |
| GET | /worker/:id/identity | Get worker's identity and authority |

## Key Files

- `packages/node/src/platform/agent-tools.ts` — route handler implementations
- `packages/node/src/core/worker-mcp.ts` — worker HTTP tool endpoints
- `packages/node/src/api/api-server.ts` — registers routes on Fastify
