---
id: content-maintenance
type: service
domain: content
entry: packages/node/src/platform/content-maintenance.ts
depends_on: [content-registry]
depended_by: []
exposes:
  - startMaintenanceLoop() — start periodic scan (default: 1 hour interval, 5-min initial delay)
  - stop() — stop the maintenance loop
  - scan() — run a maintenance scan, return MaintenanceCheck[] of issues found
  - setTaskCreator(fn) — set callback for creating maintenance tasks
rules: []
last_verified: 2026-02-18
---

# Content Maintenance

## What It Does
Periodically scans owned content and checks health. If content with `auto-maintain` upgrade policy is unhealthy or stale, creates a maintenance task via the task queue callback.

## How It Works
- `startMaintenanceLoop()` schedules an initial scan after 5 minutes (to let the node settle), then repeats at `scanIntervalMs` (default 1 hour).
- `scan()` fetches all content with status `live` from the registry, filters to content where the local node is an owner or hosting node, then checks only records with `upgradePolicy: 'auto-maintain'`.
- Health check: sends an HTTP HEAD request to `content.liveUrl` with a 10-second timeout. If it fails or returns non-OK, the content is flagged as `unhealthy`.
- Staleness check: parses `content.manifest.updateSchedule` (supports `daily`, `weekly`, `monthly`, or a number of hours). Compares `content.updatedAt` age against the schedule threshold.
- For each issue found, calls `createMaintenanceTask()` which uses the `taskCreator` callback to submit a task with title, description, and priority.

## Gotchas
- Only checks content with `upgradePolicy: 'auto-maintain'` — content with `owner-only` or other policies is silently skipped.
- The `taskCreator` callback must be set via `setTaskCreator()` before scans will produce tasks; otherwise issues are detected but only logged.
- Health checks use `fetch()` with `AbortSignal.timeout()` — requires Node 18+ for the timeout API.
- Initial scan is delayed 5 minutes after `startMaintenanceLoop()` to avoid checking before the node is fully connected.

## Key Files
- `packages/node/src/content-maintenance.ts` — ContentMaintenance class
- `packages/node/src/content-registry.ts` — provides content records for scanning
