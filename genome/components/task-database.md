---
id: task-database
type: infrastructure
domain: platform
entry: packages/node/src/platform/task-database.ts
depends_on: []
depended_by: [task-queue]
exposes:
  - new TaskDatabase(dataDir) — open/create SQLite at dataDir/tasks.db
  - init() — run schema migration, set WAL mode
  - insert(task) — write new task row
  - get(id) — fetch single task
  - list(opts?) — filtered query (status, priority, assignedTo, limit)
  - update(id, fields) — partial update (status, assignedTo, updatedAt, etc.)
  - delete(id) — hard delete
  - addTimelineEvent(taskId, event) — append to task_timeline table
  - getTimeline(taskId) — ordered timeline events
last_verified: 2026-02-26
---

# Task Database

## What It Does
SQLite-backed persistence layer for the task queue. Replaced the original JSON file (`tasks.json`) with a proper database in a later phase to support concurrent access, richer queries, and timeline event logging.

## How It Works
- Opens (or creates) `~/.pando/tasks.db` using better-sqlite3 in WAL mode for concurrent read performance.
- All SQL lives here — `task-queue.ts` delegates all reads/writes to TaskDatabase. No SQL in task-queue.ts.
- Schema: `tasks` table (id, title, description, status, priority, created_by, assigned_to, created_at, updated_at, + JSONB-ish columns for result, cost, role metadata) + `task_timeline` table (task_id, event_type, payload, timestamp).
- Uses prepared statements for all queries (no string interpolation).
- Follows the same pattern as `packages/ledger/src/database.ts`.

## Gotchas
- WAL mode requires the database file to be on a local filesystem (not a network mount).
- Schema migrations are additive only — never drop or rename columns without a migration step.
- The `task_timeline` table grows unbounded — no pruning yet (deferred).

## Key Files
- `packages/node/src/platform/task-database.ts` — TaskDatabase class (all SQL)
- `packages/node/src/platform/task-queue.ts` — TaskQueue (business logic, calls TaskDatabase)
