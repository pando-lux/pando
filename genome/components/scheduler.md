---
id: scheduler
type: service
domain: core
entry: packages/node/src/scheduler.ts
depends_on: [task-queue, agent-manager, bridge-queue]
depended_by: []
exposes:
  - start() — begin polling task queue, recover orphans
  - stop() — graceful shutdown
  - getStatus() — running state, active tasks, config, stats, approved queue length
  - getTaskQueue() — return task queue reference
  - receiveApprovedTask(taskId, managerId) — queue manager-approved task for execution
  - onTaskResult(taskId, callback) — register callback fired when task finishes
rules: [pure-executor, authority-model]
last_verified: 2026-02-20
---

# Scheduler

## What It Does

Pure executor that dequeues approved tasks and routes them to AgentManager for worker agent spawning. On completion, enqueues result to Bridge Queue for the Manager to review and commit. Does NOT commit code, update genome, spawn workers directly, or make decisions -- that is the Manager's and AgentManager's job.

## How It Works

- Polls the task queue every 10 seconds. Only executes tasks from the `approvedQueue` (populated by `receiveApprovedTask()`).
- For each task: claims it, routes to AgentManager for worker agent creation.
- On completion: enqueues `task_completed` or `task_failed` to Bridge Queue for Manager review.
- Manages task lifecycle tracking (claimed, in_progress, completed, failed).

## What Changed (Phase 27)

| Before (Pre-Phase 27) | After (Phase 27) |
|---|---|
| Scheduler spawned Claude Code workers directly | AgentManager spawns worker Agents |
| Depended on WorkspaceManager for isolated workspaces | Agent class manages its own workspace |
| Depended on ProfileCache for agent profiles | Deleted -- Manager plans, Agent uses templates |
| Depended on ProjectContext for context assembly | Deleted -- Agent.buildClaudeMd() handles context |
| Depended on OutcomeRecorder for task outcomes | Deleted -- Agent state.json tracks outcomes |
| Depended on SessionRegistry for session reuse | Deleted -- Agent manages its own sessionId |
| Execution tiers: shell, api, short/long-session | Agent handles all execution via Claude Code |

The Scheduler is now purely: **receive approved task -> route to AgentManager -> collect result -> enqueue to bridge**. Zero worker spawning logic. Zero workspace logic.

### Task Completion via Bridge Route

`reportTaskCompleted()` and `reportTaskFailed()` are now called by AgentManager via a `taskCompletionCallback` when tasks complete through the bridge→agent route. This means completion tracking works for both Scheduler-initiated tasks and bridge-routed tasks -- the Scheduler's counters stay accurate regardless of which path the task took.

## Gotchas

- The `approvedQueue` is in-memory only. If node crashes between approval and execution, approved tasks are lost (recovered as orphaned tasks on restart).
- Deploy gating: `pendingDeploy` defers build+restart until task queue is quiet.
- Result callbacks (`onTaskResult`) are one-shot.

## Key Files

- `packages/node/src/scheduler.ts` -- Scheduler class
- `packages/node/src/task-queue.ts` -- TaskQueue (polled by scheduler)
- `packages/node/src/agent-manager.ts` -- AgentManager (spawns worker agents)
- `packages/node/src/bridge-queue.ts` -- Bridge Queue (Scheduler enqueues results here)
