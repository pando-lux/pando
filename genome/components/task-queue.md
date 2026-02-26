---
id: task-queue
type: data-store
domain: core
entry: packages/node/src/platform/task-queue.ts
depends_on: [task-database, network]
depended_by: [scheduler, manager]
exposes:
  - createTask(opts) — create task with dedup (title similarity + proposalId), emit P2P event
  - getTask(id) — single task by ID
  - getTasks(opts?) — filtered list (status, priority, assignedTo, limit)
  - getNextClaimable(agentId?) — next open task by priority
  - getActiveTasks() — all open/claimed/in_progress tasks
  - getOpenTasksByPriority() — open tasks sorted by priority
  - claimTask(taskId, agentId) — atomic claim with file conflict + dependency checks
  - updateStatus(taskId, status, assignedTo?) — validated state machine transition
  - completeTask(taskId, result?, completionInfo?) — complete with cascade child rejection + sibling auto-approve
  - rejectTask(taskId, reason?) — return task to open
  - releaseTask(taskId, agentId) — release claimed task back to open
  - setParentChild(parentId, childIds) — set parent/child relationships
  - getChildTasks(parentId) — full Task objects for children
  - getParentTask(taskId) — parent Task object
  - areAllChildrenDone(parentId) — check if all children completed
  - setResultNote(taskId, note) — update result note
  - setQaTier(taskId, tier) — persist QA tier to SQLite
  - setNetwork(network) — wire P2P event publishing
  - setLocalPeerId(peerId) — set local peer ID for cross-node tracking
  - insertRemoteTask(task) — insert task from P2P peer (dedup by ID)
  - updateRemoteStatus(taskId, ...) — update status from P2P event
  - storeRemoteOutput(taskId, output, executedByNode?) — store remote result
  - requestSync(peerId) — P2P task sync request
  - handleSyncRequest(fromPeerId) — respond to P2P sync request
  - handleSyncResponse(tasks) — process P2P sync response
  - pushTimelineEvent(taskId, event) — append timeline event
  - getClaimedTasks(agentId) — tasks claimed by specific agent
rules: []
last_verified: 2026-02-18
---

# TaskQueue

## What It Does
SQLite-backed task management with priority ordering, atomic claims, file conflict detection, dependency tracking, and cross-node P2P synchronization via GossipSub.

## How It Works
- Backed by `TaskDatabase` (task-database.ts) using better-sqlite3. On construction, opens the SQLite DB in `~/.pando/agent/` and runs a one-time migration from legacy `tasks.json` if present.
- Task creation generates a SHA-256 ID (16 hex chars), validates ID safety, checks for duplicates by proposalId and title similarity (Jaccard threshold 0.6), inserts atomically with timeline event, and publishes a P2P task event via GossipSub.
- Claim validates state transition (must be `open`), checks file conflicts and unmet dependencies, then updates atomically.
- Completion cascades: rejects open/claimed child tasks, auto-approves siblings with resolved dependencies.
- Valid state transitions are enforced: `open -> claimed/rejected/done`, `claimed -> in_progress/open/done/rejected`, etc.
- Cross-node sync: tasks are published on creation/claim/completion. Remote tasks are inserted if not already present. Catch-up sync uses request/response pattern.

## Gotchas
- Title dedup is skipped for child tasks (decomposed by Project Planner) since they are intentionally similar to the parent.
- The Jaccard similarity threshold of 0.6 can produce false positives with very short titles. Tokens shorter than 3 chars are excluded.
- `completeTask()` performs sibling auto-approve in the same transaction scope -- complex logic that touches multiple tasks atomically.
- `insertRemoteTask()` does NOT validate the task data structure -- malformed tasks from peers could cause issues.
- The migration from JSON renames the old file to `.migrated` rather than deleting it (safety measure).

## Key Files
- `packages/node/src/task-queue.ts` — TaskQueue class, types (Task, TaskPriority, TaskStatus, TaskCost, etc.)
- `packages/node/src/task-database.ts` — TaskDatabase (SQLite wrapper)
- `~/.pando/agent/` — SQLite database directory
