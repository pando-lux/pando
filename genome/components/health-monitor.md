---
id: health-monitor
type: data-source
domain: observability
entry: packages/node/src/monitor.ts
depends_on: [scheduler, network]
depended_by: [upgrade-protocol, pando-node]
exposes:
  - start() / stop() — lifecycle control
  - getMetricsHistory() — rolling history of HealthMetrics snapshots (max 100)
  - getAlerts() — all MonitorAlert records (resolved and unresolved)
  - getConfig() / updateConfig(partial) — read/write MonitorConfig thresholds
  - getAuditLog() — audit trail of all events
  - getRecoveryActions() / updateRecoveryActions(updates) — read/write recovery action config
  - onAlert(callback) — subscribe to alert events (Phase 19.2)
  - attachScheduler(scheduler) — wire task/spawn event listeners
  - recordSpawnFailure() — external spawn failure recording
  - recordLedgerSync() — external ledger sync activity recording
rules: [data-only-subsystems]
last_verified: 2026-02-20
---

# Health Monitor

## What It Does
DATA-ONLY node health monitoring and alert generation. Detects scheduler crashes, peer loss, failure rate spikes, memory pressure, event loop lag, agent spawn failures, and ledger sync lag. Stores rolling metrics and persistent alerts but NEVER takes recovery actions -- the manager decides what to act on.

## How It Works
- Runs periodic health checks every 30 seconds (configurable via `checkIntervalMs`).
- Each check cycle: collects metrics (peer count, scheduler state, task success/failure rates, memory usage, event loop lag, ledger sync lag), evaluates alert rules, resolves stale alerts, computes overall health status.
- Maintains rolling metrics history (max 100 entries), alert list (max 200), and audit log (max 500 entries), all persisted to `~/.pando/monitor/`.
- Alert types: `scheduler_down`, `no_peers`, `high_failure_rate`, `consecutive_failures`, `high_memory_usage`, `event_loop_lag`, `agent_spawn_failures`, `ledger_sync_lag`.
- Alert deduplication: recently-resolved alerts are reopened instead of creating new entries (30-minute reopen window). Prevents oscillating conditions (e.g., peer count flapping) from flooding the alert list with duplicate entries.
- Event loop lag measured via 1-second interval timer comparing actual vs expected delay.
- Extends `EventEmitter` -- emits `metrics` on each check, fires alert callbacks for external consumers (manager agents).
- Recovery actions table is stored but only defines WHAT actions could be taken -- the monitor itself does NOT execute them.

## Gotchas
- This is DATA-ONLY. It collects and reports but never acts. The manager reads this data and decides on recovery.
- Recovery config persisted to `~/.pando/monitor/recovery-config.json` but runtime updates via API are also stored in memory. Config loaded from file on startup.
- Scheduler and Network references are set via setter functions (not constructor injection) to avoid circular imports.
- `consecutiveFailures` counter is independent of the scheduler's own counters and tracks only what the monitor observes.
- Alert callbacks (Phase 19.2) fire on both new and updated alerts.

## Key Files
- `packages/node/src/monitor.ts` -- HealthMonitor class (extends EventEmitter)
- `~/.pando/monitor/metrics.json` -- persisted metrics history
- `~/.pando/monitor/alerts.json` -- persisted alert records
- `~/.pando/monitor/audit.json` -- audit trail
- `~/.pando/monitor/recovery-config.json` -- recovery action configuration
- `packages/shared/src/types.ts` -- MonitorConfig, HealthMetrics, MonitorAlert, RecoveryAction types
