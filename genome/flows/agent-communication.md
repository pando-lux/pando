---
id: agent-communication
components: [bridge-queue, agent-manager, manager, scheduler]
rules: [authority-model, workflow-pipeline]
trigger: any_event
---

# Agent Communication Flow

How all agents communicate with each other through the Bridge Queue. This is THE communication model for the entire system — every event, request, and message flows through the bridge.

**Replaces:** 5-minute heartbeat, batched event routing, pipeline commit trigger, one-way worker communication.

## The Pattern

```
  ┌──────────────────┐
  │ User (via API)   │──── user_request ────┐
  │                  │                      │
  └──────────────────┘                      │
  ┌──────────────────┐                      ▼
  │ Worker A         │── worker_message ─► BRIDGE ──► Manager
  │ (mid-task)       │                    QUEUE       (one item
  └──────────────────┘                    (FIFO)       at a time)
  ┌──────────────────┐                      ▲
  │ Scheduler        │── task_completed ────┘
  │                  │                      │
  └──────────────────┘                      │
  ┌──────────────────┐                      │
  │ HealthMonitor    │── health_alert ──────┘
  └──────────────────┘

  Manager processes ONE item → follows todo list → exits
  Bridge watcher: more items? spawn Manager again. Empty? Idle.
```

## Lifecycle

### 1. Something Happens

Any part of the system can create a bridge item:

| Source | Posts | Example |
|---|---|---|
| User via API (POST /chat/threads/:id/message) | `user_request` | "Build me a chess game" |
| User via API (POST /chat/message) | `user_request` | "What's the status of my project?" |
| Scheduler | `task_completed` | Worker finished task #123 |
| Scheduler | `task_failed` | Worker failed task #456 |
| Worker (mid-task) | `worker_message` | "I need access to design files" |
| Worker (mid-task) | `worker_message` | "Step 3 of 5 complete" |
| HealthMonitor | `health_alert` | CPU at 95%, disk full |
| Governance | `governance_decision` | Proposal XYZ approved |
| (Manager handles genome directly during DOCS step — no separate event) | | |

### 2. Item Enters Bridge Queue

```
bridge.enqueue(managerId, {
  type: 'user_request',
  source: 'api-server',
  payload: { message: 'Build me a chess game', userId: '...', projectId: '...' },
  priority: 'normal'
});
```

### 3. Bridge Watcher Triggers Manager

If Manager is idle → spawn immediately with this item.
If Manager is busy → item waits in queue. FIFO within priority tier.

### 4. Manager Processes Item

Manager receives ONE item as its event prompt. Follows todo list:

**For user_request "Build me a chess game":**
1. Assess: what kind of work? (code project)
2. Design workflow: plan → code → test → review → commit → docs
3. Create task via POST /tasks
4. Approve task
5. Report: "Created project chess-game, task submitted"
6. Exit

**For task_completed:**
1. Read worker output from workspace
2. Review changes
3. Apply to repo (if sandbox task)
4. Build (npm run build)
5. Commit code (git add + git commit)
6. Update genome docs (DOCS step)
7. Report: "Task #123 completed, committed as abc123"
8. Exit

**For worker_message "I need design files":**
1. Read message
2. Find design files
3. Copy to worker workspace (or post response)
4. Report: "Provided files to worker"
5. Exit

**For worker_message "I'm confused about the task, ask user":**
1. Read message
2. Relay to user via Communication Agent
3. Wait for user response (next bridge item will be user's reply)
4. Exit

### 5. Manager Exits → Bridge Watcher Checks Queue

```
Manager process exits
  → bridge.setManagerIdle(managerId)
  → bridge.isEmpty(managerId)?
     YES → do nothing. Manager stays idle. Zero cost.
     NO  → spawn Manager with next item.
```

## Worker Communication

### Worker → Manager (mid-task)

Workers can post messages during execution via HTTP:

```
POST /tasks/abc123/messages
{ "type": "progress", "content": "Step 3 of 5 complete" }

POST /tasks/abc123/messages
{ "type": "help_request", "content": "Need access to /assets/design.figma" }

POST /tasks/abc123/messages
{ "type": "clarification", "content": "Is this a web app or mobile app?" }

POST /tasks/abc123/messages
{ "type": "blocked", "content": "Dependency X not installed, can't proceed" }
```

Each message routes to the bridge queue of the task's manager.

### Manager → Worker (response)

Manager can respond by writing to the worker's workspace:
- `~/.pando/workspaces/{taskId}/manager-response.md`
- Worker's CLAUDE.md tells it to check this file periodically
- OR: Manager kills stuck worker and creates new task with additional context

### Worker → User Direct (Urgent Bypass)

When Manager is busy and worker has a blocking question that only the user can answer:

```
Worker → POST /tasks/{taskId}/messages {
  type: "stuck",
  urgency: "direct",        ← bypasses Manager queue
  content: "Need database credentials. Can't proceed."
}
  │
  ▼
Bridge: Sees urgency: "direct" → skips Manager queue → SSE to user immediately
  │
  ▼
User responds → Bridge → Worker picks it up directly
  │
  ▼
Manager sees the exchange in bridge audit trail (informed, not bottleneck)
```

**Rules for urgency:direct:**
- Only for truly blocking issues (can't continue AT ALL)
- Normal questions still go through Manager (filter noise)
- Manager sees the exchange in bridge audit trail
- Max 1 direct message per worker per task (prevents spam)

### Manager → User (relay via Communication Agent)

When Manager needs user input (worker asked for clarification):
1. Manager calls Communication Agent API to relay the question
2. User sees the question in their chat
3. User responds → Communication Agent enqueues response as `user_request` to bridge
4. Manager picks it up on next cycle

### Timeout Detection

When a worker is spawned, a 30-minute timer starts. If no worker_message or task completion arrives:
- Bridge creates a `worker_message` with type `timeout`
- Manager investigates: check PID, check workspace, decide to extend or kill

## What This Eliminates

| Old | New | Why |
|---|---|---|
| 5-min heartbeat | Bridge watcher events | Zero cost when idle |
| periodic_check event type | Eliminated | Manager only runs when there's work |
| Batched event prompts | One item at a time | Clear, focused processing |
| Pipeline commit trigger | Manager workflow step | Manager commits as part of todo list |
| One-way worker output | Two-way via bridge | Workers can ask for help mid-task |
| No user relay | Manager → Communication Agent | Manager can ask user questions |

## Real-Time Progress Relay (Phase 27-H)

The bridge flow above covers agent→manager communication. Phase 26 adds the **return path** — manager→user real-time visibility:

```
User sends "build me a snake game"
  │
  ▼
API Server → Bridge Queue → AgentManager → Manager Agent
  │
  ├─ AgentManager wires agent.onProgress callback before sendEvent()
  ├─ Agent.sendEvent() → claude -p --continue --resume
  │
  ├─ Tool use detected (stream-json line-buffer parsing)
  │   → onProgress fires → SSE chat_progress event → browser
  │   → Shows "Tool: Bash: ls -la ...", "Tool: Read: file.ts", etc.
  │
  ├─ Agent completes → relayOutputToUser()
  │   → SSE chat_message event with threadId → browser
  │   → ThreadStore saves message with activity logs
  │
  └─ If no progress in 10s → heartbeat fires ("Still working...")
```

### Relay Chain (Who Calls What)

```
AgentManager.processNextBridgeItem()
  → agent.onProgress = (text) => pushActivity(threadId, agentId, text)
    → ssePushCallback('chat_progress', { threadId, agentId, content })
      → SSE to all connected gateways
  → agent.sendEvent(prompt)
    → Claude Code runs → stream-json parsed → onProgress fires for tool use
  → relayOutputToUser(output, threadId)
    → ssePushCallback('chat_message', { threadId, role: 'assistant', content })
    → ThreadStore saves message with collected activity
```

### Gateway Side

- `use-sse.ts` listens for `chat_message`, `chat_progress` events
- Dispatches as `pando-chat-message` CustomEvent on window
- `chat/page.tsx` listens for CustomEvent, adds message to correct thread
- Activity logs rendered as collapsible `<details>` with color-coded tool use (blue=tool, green=completed)

## Key Files

- `packages/node/src/bridge-queue.ts` — BridgeQueue class, per-project FIFO
- `packages/node/src/agent-manager.ts` — Bridge watcher, spawns/resumes agents, routes items
- `packages/node/src/api-server.ts` — Bridge endpoints + SSE push
- `packages/node/src/scheduler.ts` — Posts task_completed/failed to bridge
- `packages/node/src/monitor.ts` — Posts health_alert to bridge
- `packages/node/src/agent.ts` — Universal agent primitive, progress callbacks
- `packages/node/src/index.ts` — Wires api-server ↔ bridge-queue ↔ agent-manager
- `packages/gateway/lib/use-sse.ts` — SSE listener, dispatches CustomEvent
- `packages/gateway/app/chat/page.tsx` — Receives CustomEvent, updates thread messages
