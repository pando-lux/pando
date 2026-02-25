---
id: bridge-queue
type: service
domain: core
entry: packages/node/src/bridge-queue.ts
depends_on: [task-queue]
depended_by: [agent-manager, manager, scheduler]
exposes:
  - enqueue(managerId, opts) — add item to manager's queue (returns BridgeItem)
  - dequeue(managerId) — dequeue ONE item (priority-weighted FIFO). Returns null if empty.
  - peek(managerId) — look at next item without dequeuing
  - length(managerId) — number of items in queue
  - isEmpty(managerId) — check if queue is empty
  - setManagerBusy(managerId, busy) — mark manager as processing or idle
  - isManagerBusy(managerId) — check if manager is processing
  - getQueueStatus(managerId) — full status (length, busy, items)
  - getAllStatuses() — summary for all known managers
  - "Events: 'newItem' (managerId, item), 'managerIdle' (managerId)"
rules: [authority-model]
status: IMPLEMENTED + TESTED (2026-02-20)
last_verified: 2026-02-20
---

# Bridge Queue

## What It Does

The central communication hub for ALL agent-to-agent and system-to-agent communication. Every event, user request, worker message, and health alert flows through the bridge queue. The Manager pulls ONE item at a time, processes it fully, then pulls the next.

**Replaces:** The 5-minute heartbeat timer, batched event routing, and the pipeline commit trigger.

## How It Works

### Queue Structure

Each manager gets its own independent queue. Items are processed FIFO within priority tiers.

```typescript
BridgeItem {
  id: string              // UUID
  managerId: string       // which agent this is for
  type: BridgeItemType    // 'user_request' | 'task_completed' | 'task_failed' |
                          // 'worker_message' | 'health_alert' | 'governance_decision'
  source: string          // who posted it
  payload: Record<string, any>
  priority: BridgePriority  // 'critical' | 'normal' | 'low'
  timestamp: number       // when enqueued
  retryCount: number      // Phase 27: incremented on timeout/crash, max 3 before escalation
  nodeId: string          // Phase 27: which node this event targets (defaults to local)
}
```

### Priority

| Priority | When | Examples |
|---|---|---|
| CRITICAL | Jump to front | Health emergency, blocked worker, security alert |
| NORMAL | FIFO order | User requests, task completions, progress messages |
| LOW | Process when nothing else | Strategy suggestions |

### One Item at a Time

`dequeue(managerId)` returns exactly ONE item. The Bridge Watcher (in AgentManager) calls `agent.processEvent()` with this item. When processEvent completes, the watcher checks for the next item.

The Manager is NEVER given multiple items at once.

### In-Memory Storage

Queue items are held in memory. On restart, items are re-generated naturally (scheduler re-discovers tasks, health monitor re-fires alerts, users re-send messages).

## Who Posts to the Bridge

| Source | Event Type | When |
|---|---|---|
| API Server (user message) | `user_request` | User asks for work or sends message |
| Scheduler (via index.ts event handler) | `task_completed` | Worker finished task |
| Scheduler (via index.ts event handler) | `task_failed` | Worker failed task |
| Worker (via POST /tasks/:id/messages) | `worker_message` | Worker needs help, reports progress, or is stuck |
| HealthMonitor (via index.ts onAlert) | `health_alert` | Critical health issue detected |
| Governance | `governance_decision` | Proposal approved/rejected |

## Bridge Watcher

Two EventEmitter handlers in AgentManager replace the old heartbeat timer:

```typescript
// In AgentManager.start():

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

async processNextBridgeItem(agentId) {
  const item = bridge.dequeue(agentId);
  bridge.setManagerBusy(agentId, true);
  try {
    await agent.processEvent(prompt);  // Spawns claude -p, waits for completion
  } finally {
    bridge.setManagerBusy(agentId, false);  // Emits 'managerIdle'
  }
}
```

No timer. No polling. Pure event-driven. Zero cost when idle.

### Event Retry (Phase 27)

If an agent times out or crashes during event processing:
- Event re-queued with `retryCount++`
- `retryCount < 3` -- re-queue, try again
- `retryCount >= 3` -- escalate to parent agent or user
- No event is silently dropped

## Convenience Methods (on AgentManager)

AgentManager exposes these for callers that don't interact with the bridge directly:

| Method | Enqueues |
|---|---|
| `routeUserMessage(message, userId, projectId)` | user_request |
| `routeTaskEvent(taskId, success, title, agentId?)` | task_completed or task_failed |
| `routeHealthAlert(alert)` | health_alert |

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /bridge | No | All bridge queue statuses |
| GET | /bridge/:managerId | No | Queue status for a specific manager |
| POST | /tasks/:id/messages | Yes | Worker posts message (routes to bridge) |

## What This Replaced

| Old System | Replaced By |
|---|---|
| 5-minute heartbeat timer | Bridge watcher (event-driven, zero-cost idle) |
| Batched event routing | One item at a time from queue |
| Pipeline commit trigger (routeTaskEvent → runPipelineCommit) | Manager's workflow includes commit step |
| No mid-task worker communication | Workers post to bridge via POST /tasks/:id/messages |
| Manager periodic_check event | Housekeeping now time-based (every 1h on any event) |

## Key Files

- `packages/node/src/bridge-queue.ts` — BridgeQueue class (EventEmitter)
- `packages/node/src/agent-manager.ts` — AgentManager with bridge watcher
- `packages/node/src/api-server.ts` — Bridge API endpoints + worker message endpoint
- `packages/node/src/index.ts` — BridgeQueue creation and wiring
- `tests/test-bridge-queue.mjs` — 38 unit tests

## Tests

| Test | Status |
|---|---|
| Basic enqueue/dequeue | PASS |
| Priority ordering (critical > normal > low) | PASS |
| FIFO within same priority | PASS |
| Manager busy/idle tracking | PASS |
| Event emissions (newItem, managerIdle) | PASS |
| Multi-manager isolation | PASS |
| Empty queue handling | PASS |
| Queue status reporting | PASS |
| Live node: GET /bridge | PASS |
| Live node: GET /bridge/:managerId | PASS |
| Live node: POST /tasks/:id/messages | PASS |
| Live node: Bridge watcher auto-dispatch | PASS |
