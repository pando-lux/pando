---
id: agent-tools
type: service
domain: core
entry: packages/node/src/platform/agent-tools.ts
depends_on: [agent-manager, bridge-queue]
depended_by: [api-server]
exposes:
  - registerRoutes(fastify, agentManager) — register all agent HTTP API routes on the Fastify server
rules: []
last_verified: 2026-02-20
---

# Agent Tools

## What It Does

HTTP API route handlers that expose agent operations to the outside world. These are the endpoints that agents call via curl from their Claude Code sessions, and that the gateway calls for the agent tree view and project management.

Registered on the Fastify server by `api-server.ts` during startup.

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /agents/spawn | Yes | Spawn a new child agent. Body: `{role, template, context, parentId, projectId}` |
| POST | /agents/:id/message | Yes | Send message to an agent's bridge queue. Body: `{content, type, senderId}` |
| POST | /agents/:id/report | Yes | Agent reports completion or status. Body: `{status, output, cost}` |
| GET | /agents/tree | No | Full agent hierarchy for a project. Query: `?projectId=...` |
| GET | /agents/:id/status | No | Single agent status with cost and task info |
| GET | /agents | No | List all agents on this node |
| POST | /projects | Yes | Create a new project. Body: `{description, userId}` |
| GET | /projects | No | List all projects |
| POST | /projects/:id/collaborators | Yes | Add/remove collaborators. Body: `{userId, role, action}` |
| GET | /projects/:id/access | No | Check access level for a user. Query: `?userId=...` |
| POST | /agents/:id/connect | Yes | Connect user directly to agent. Body: `{userId}` |
| POST | /agents/:id/disconnect | Yes | End direct user-agent connection |

## How Agents Use These

Agents run as Claude Code sessions with full tool access. When an agent needs to spawn a child, message its parent, or report completion, it uses curl to call these endpoints:

```bash
# Agent spawns a child builder
curl -X POST http://localhost:4000/agents/spawn \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"builder","template":"builder","context":"Build auth system","parentId":"manager-xyz","projectId":"proj-001"}'

# Agent reports completion to parent
curl -X POST http://localhost:4000/agents/manager-xyz/report \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"completed","output":"Auth module done. 4 files created."}'
```

## Key Files

- `packages/node/src/agent-tools.ts` -- route handler implementations
- `packages/node/src/api-server.ts` -- registers routes on Fastify
- `packages/node/src/agent-manager.ts` -- AgentManager called by route handlers
