---
id: agent-manager
type: service
domain: core
entry: packages/node/src/agent-manager.ts
depends_on: [agent, bridge-queue, task-queue]
depended_by: [api-server, tui]
exposes:
  - start() — create pando-node-mgr, start bridge watcher, begin cleanup sweep, start directive watchdog (Phase 29)
  - stop() — stop all agents, clear bridge watcher, clear watchdog timer
  - spawnAgent(role, template, context, parentId, projectId) — create Agent, persist, return id
  - resumeAgent(agentId, prompt) — load state, resume session with --continue
  - rotateAgent(agentId) — summarize, knowledge transfer, fresh session
  - getAgent(id) — get Agent by ID
  - getAgentTree(projectId) — full hierarchy with status/cost per agent
  - getProjectRegistry() — all known projects with access control
  - addCollaborator(projectId, userId, role) — grant project access
  - removeCollaborator(projectId, userId) — revoke project access
  - connectUserToAgent(userId, agentId) — direct user-to-agent conversation
  - disconnectUser(userId) — end direct connection, resume normal routing
  - routeUserMessage(message, userId, projectId) — route to correct agent's bridge queue
  - deployAgentWorkspace(agentId) — deploy agent's workspace to S3 via HostingService, returns structured JSON with URL
  - resetAgentSession(agentId) — clear agent's sessionId for a fresh Claude Code session
  - getApiToken() — (private) read Bearer token from ~/.pando/api-token for agent CLAUDE.md injection
rules: [authority-model]
last_verified: 2026-02-22
---

# AgentManager

## What It Does

Manages the full lifecycle of all agents on a node. Creates the `pando-node-mgr` (the node's own manager) on startup, runs the Bridge Watcher that dispatches events to agents, handles agent cleanup and archival, and maintains the project registry with access control.

Replaces the old ManagerOrchestrator (domain-managers.ts), ManagerRegistry, ManagerFailover, and ManagerProtocol -- all consolidated into one system built on the universal Agent primitive.

## How It Works

### Startup

On `start()`:
1. Creates `pando-node-mgr` as an Agent with role `manager` and the node's project context
2. Starts the Bridge Watcher (event-driven dispatch, replaces the old 5-minute heartbeat)
3. Starts the cleanup sweep timer (hourly)

### Bridge Watcher (event-driven dispatch)

```
bridge.on('newItem', (agentId) => {
  if (!bridge.isManagerBusy(agentId)) {
    processNextBridgeItem(agentId);
  }
});

bridge.on('managerIdle', (agentId) => {
  if (!bridge.isEmpty(agentId)) {
    processNextBridgeItem(agentId);
  }
});
```

No timer. No polling. Zero cost when idle. Each event spawns `agent.processEvent(prompt)` which runs `claude -p --continue --resume`.

### Real-Time Progress Relay (Phase 27-H)

Before invoking `agent.sendEvent()`, the AgentManager wires the agent's `onProgress` callback to push real-time activity to the user's chat via SSE:

```
agent.onProgress = (text) => {
  pushActivity(threadId, agentId, text);  // → SSE chat_progress event → browser
  lastProgressTime = Date.now();
};

// Fallback heartbeat — only fires if no real progress in 10 seconds
const heartbeatTimer = setInterval(() => {
  if (Date.now() - lastProgressTime > 10000) {
    push('Still working...');
  }
}, 10000);

// After sendEvent completes:
clearInterval(heartbeatTimer);
agent.onProgress = undefined;
```

The `pushActivity()` call triggers `ssePushCallback('chat_progress', { threadId, agentId, content })` which broadcasts to all connected SSE clients. The gateway chat page picks up these events and renders them as a live activity panel with color-coded tool use.

### Agent Delegation (Phase 27-I)

Manager agents now delegate to child agents via HTTP. The CLAUDE.md injected into every agent's workspace includes the full spawn/message/tree API with Bearer token, so any agent can:
1. Call `POST /agents/spawn` to create a child (builder, tester, etc.)
2. The child starts immediately if `taskContext` is provided
3. The child creates files in its own workspace (`~/.pando/agents/<childId>/workspace/`)
4. Manager checks tree via `GET /agents/tree` to monitor team status

E2E verified: Manager spawned `builder-377b3316` for calculator task, builder created todo-loop.md + calculator2.html (19KB).

### Payment Gate Integration (Phase 28)

Before processing a `user_request` bridge item, AgentManager checks PaymentGate:
1. Estimate cost (moderate complexity, agent category)
2. If user can't afford → reject with "Insufficient Lux" message via SSE + ThreadStore
3. If affordable → hold escrow via `paymentGate.holdPayment()`
4. On success → release escrow to node operator
5. On failure/timeout → refund escrow to user

PaymentGate is injected via `setPaymentGate()` from index.ts during node startup.

### Budget Enforcement (Phase 28)

After each successful `sendEvent()`, AgentManager checks `agent.isBudgetExceeded()`. If the agent has spent more than its budget limit (default 50 Lux), it sends a warning to the user via SSE and pauses work.

### Stuck Detection (Phase 28)

A stuck timer runs every 60s during event processing. If no `onProgress` callback fires for 3 minutes, a warning is sent to the user via SSE. The existing 5-minute hard timeout remains as the final safety net.

### Urgency:Direct Escalation Bypass (Phase 28)

Bridge items with `payload.urgency === 'direct'` and type `stuck` or `user_question` bypass agent processing entirely. The message is routed directly to the user's chat thread via SSE and ThreadStore. This allows workers to reach the user when the manager is busy or unresponsive.

### Protocol Reminder Injection (Phase 53)

`buildPromptFromBridgeItem()` prepends a one-line protocol reminder to every bridge event prompt:

```
[PROTOCOL v1] Node=BUILD only. Apps independent after deploy. No /apps/data. No credentials in code. Use Resource Proxy or env var injection. Resources are contributed via ResourceRegistry.
```

This ensures critical architecture rules survive context compression — even if the full protocol.md (Layer 0 in CLAUDE.md) gets compressed out, the essential rules are always in the most recent context.

### QA Auto-Prompt (Phase 28)

When `buildPromptFromBridgeItem()` processes a `worker_message` with messageType `completion` or `report`, or a `task_completed` event, the prompt includes instructions for the manager to verify RESULT.md, consider spawning a QA agent, and update project-state.md.

### Task Completion Callback

When a bridge item contains a `taskId`, the AgentManager calls `taskCompletionCallback` after the agent finishes processing. This marks the task as "done" in the task queue and increments the Scheduler's completion counters, closing the loop for tasks routed through the bridge→agent path.

### Event Retry

If an agent times out or crashes while processing an event:
- Event re-queued with `retryCount++`
- `retryCount < 3` -- try again
- `retryCount >= 3` -- escalate to parent agent or user
- No event is silently dropped

### Cleanup Sweep (hourly)

Checks all agents:
- `lastActive` older than TTL (default 30 days) and status IDLE -- transition to ARCHIVED
- ARCHIVED agents compress workspace to `.tar.gz`, keep `state.json` readable
- ARCHIVED older than 180 days with no resurrection -- transition to DEAD (deleted)
- Top-level managers stay IDLE indefinitely (they ARE the project)

### Agent Resurrection

Archived agents can be brought back:
- Decompress workspace from `.tar.gz`
- Create fresh Claude Code session
- Inject KNOWLEDGE-TRANSFER.md as Layer 2 context
- Status returns to ACTIVE

### Project Registry

Maintains per-project metadata:
- Owner (userId who created the project)
- Collaborators with access levels: `owner | collaborator | qa_lead | viewer`
- Active agents for the project
- Budget tracking

### Direct User-to-Agent Connection

Manager can connect a user directly to a specific child agent:
- `connectUserToAgent(userId, agentId)` -- user's messages go to agent's bridge queue
- Agent responds directly to user's chat thread
- Manager stays informed via audit trail
- Connection is temporary -- Manager or user can disconnect

### user_question Escalation

When a deep child agent needs user input:
1. Agent posts `user_question` type message to parent
2. Each parent in chain can answer (if they know) or forward up (default)
3. Eventually reaches top-level Manager
4. Manager relays to user's chat thread
5. User's answer flows back down through the chain

## API Routes

Registered via `agent-tools.ts`:

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /agents/spawn | Yes | Spawn a new agent |
| POST | /agents/:id/message | Yes | Route message to agent's bridge queue |
| POST | /agents/:id/report | Yes | Agent reports completion/status |
| GET | /agents/tree | No | Full agent hierarchy for a project |
| GET | /agents/:id/status | No | Single agent status |
| POST | /projects/:id/collaborators | Yes | Add/remove project collaborators |
| GET | /projects/:id/access | No | Check user access level |
| POST | /agents/:id/connect | Yes | Connect user directly to agent |
| POST | /agents/:id/deploy | Yes | Deploy agent's workspace to S3 (agent-driven) |
| POST | /agents/:id/reset-session | Yes | Clear agent's sessionId so next event starts a fresh Claude Code session |

### Agent-Driven Deployment

Deployment is triggered by the agent, not by infrastructure. The manager template teaches agents when and how to deploy via `POST /agents/:id/deploy`. The `deployAgentWorkspace(agentId)` method on AgentManager reads the agent's workspace files, calls HostingService, and returns structured JSON (URL, file count, size) that the agent can relay to the user.

There is no `autoDeployIfReady()` or automatic deployment in `processNextBridgeItem()`. Infrastructure provides the deployment tool; the agent's intelligence decides when to use it.

### Session Reset

`POST /agents/:id/reset-session` clears the agent's `sessionId` so the next `processEvent()` starts a fresh Claude Code session instead of resuming the old one. Useful when a long-running session has accumulated too much context or when the agent needs a clean slate.

### Event Prompt Injection (Context Compression Mitigation)

`buildPromptFromBridgeItem()` injects critical behavioral instructions (e.g., deployment reminders) directly into the event prompt passed to `agent.sendEvent()`. This is separate from the CLAUDE.md template.

**Why this matters:** After 100+ tasks on `--continue --resume`, Claude Code compresses old context including CLAUDE.md instructions. The manager may ignore deployment instructions despite them being in CLAUDE.md because they've been compressed out. Event prompt text is always in the most recent context window and is never compressed — making it the reliable channel for instructions that must always be followed.

### Private Methods

- `getApiToken()` — reads the API Bearer token from `~/.pando/api-token` file. Used internally for injecting auth into agent CLAUDE.md Communication sections and for deployment API calls.

## Key Files

- `packages/node/src/agent-manager.ts` -- AgentManager class
- `packages/node/src/agent-tools.ts` -- HTTP API route handlers
- `packages/node/src/agent.ts` -- Agent class (created by AgentManager)
- `packages/node/src/bridge-queue.ts` -- Bridge Queue (feeds events to agents)
- `~/.pando/agents/` -- all agent state and workspaces
