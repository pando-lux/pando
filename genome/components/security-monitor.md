---
id: security-monitor
type: safety
entry: packages/node/src/security-monitor.ts
depends_on: [network, ledger, emission-witness]
depended_by: [pando-node]
exposes:
  - start()
  - stop()
  - isRunning()
  - recordMessage(peerId)
  - recordTransaction(peerId, tx)
  - recordPeerJoin(peerId)
  - recordProfile(peerId, profile)
  - recordEmissionProposal(peerId)
  - isQuarantined(peerId)
  - getQuarantineLevel(peerId)
  - quarantineLevel1(peerId, reason)
  - quarantineLevel2(peerId, reason)
  - quarantineLevel3(peerId, reason)
  - releasePeer(peerId)
  - appealQuarantine(peerId, appealReason)
  - getAlerts(limit?)
  - getActiveAlerts()
  - getQuarantine()
  - getStats()
rules: []
last_verified: 2026-02-18
---

# Security Monitor

## What It Does
Anomaly detection, alert management, and peer quarantine system. Detects security threats via 5 specialized detectors and auto-quarantines peers that trigger critical alerts.

## How It Works
- Extends `EventEmitter` and emits `security:alert` events for HealthMonitor integration.
- Runs a check loop every 30 seconds that iterates through all 5 detectors, each returning zero or more `SecurityAlert` objects.
- **MessageRateMonitor** -- flags peers sending over 100 messages/minute (critical at 200+).
- **TransactionConflictDetector** -- detects double-spend patterns: same sender, same amount, different recipients within 5 minutes (3+ conflicts = alert).
- **SybilDetector** -- detects join bursts (5+ peers in 30 seconds) and per-IP peer clustering (3+ peers/IP/hour).
- **ProfilePoisoningDetector** -- scans for XSS patterns, null bytes, oversized fields (>10KB) in profile payloads.
- **EmissionAbuseDetector** -- flags peers proposing >50 emission proposals per hour.
- Critical alerts auto-quarantine the offending peer. Three quarantine levels with escalating severity.
- Alerts and quarantine entries persist at `~/.pando/security/alerts.json` and `quarantine.json`.

## Gotchas
- External dependencies (`network`, `ledger`, `emissionWitness`) are set via setter methods after construction, not via constructor -- they can be null during early startup.
- Quarantine duration is fixed at 1 hour (`QUARANTINE_DURATION_MS`). Expired quarantines are auto-released during check cycles.
- Alert and quarantine stores are capped at 200 entries each; oldest are evicted.
- The SybilDetector tracks peer join timestamps but has no actual IP-address access -- it uses peer IDs only, so the per-IP threshold relies on external IP tracking that may not be wired.

## Key Files
- `packages/node/src/security-monitor.ts` -- SecurityMonitor class and all 5 detector classes
- `~/.pando/security/alerts.json` -- persisted alerts
- `~/.pando/security/quarantine.json` -- persisted quarantine entries
