---
id: data-only-subsystems
severity: critical
applies_to: [health-monitor]
created: 2026-02-18
---

# Data-Only Subsystems

## The Rule

HealthMonitor collects data ONLY. It does NOT make autonomous decisions, execute recovery actions, or trigger any side effects.

## What Was Removed

| Subsystem | Deleted Methods | What They Did (WRONG) |
|---|---|---|
| HealthMonitor | executeRecoveryActions(), executeRecovery() | Auto-restarted services, auto-killed processes |

StrategyLoop, SelfImprover, and AutoUpdater were entirely deleted in Phase 27-C. Their responsibilities are now handled by the Manager agent (which reads HealthMonitor data and decides on actions) and the UpgradeProtocol (which handles governance-approved upgrades).

All `setManagerMode()` toggles were deleted. HealthMonitor is ALWAYS data-only. No toggle exists.

## What HealthMonitor Does Now

- **Collect metrics** (CPU, memory, disk, network)
- **Detect patterns** (failure rates, performance trends)
- **Generate alerts** (threshold breaches, anomalies)
- **Expose data via API** (manager reads this data and decides)

## Enforcement

The Manager reads HealthMonitor data and makes all decisions. This is enforced by architecture — the monitor literally doesn't have the code to take action anymore.
