---
id: resource-meter
type: service
domain: resources
entry: packages/node/src/resource-meter.ts
depends_on: []
depended_by: [scheduler]
exposes:
  - recordUsage(peerId, resourceType, usage) — record a resource usage entry for a peer
  - getUsage(peerId, period?) — get metering readings for a specific peer
  - getNetworkUsage(period?) — get network-wide metering readings
  - calculateRewards(peerId, period?) — calculate Lux rewards based on resource usage
  - startMeteringLoop(intervalMs?) — start periodic pruning of old records
  - stop() — stop the metering loop
rules: []
last_verified: 2026-02-18
---

# Resource Meter

## What It Does
Tracks per-capability resource usage for all nodes. Persists usage records to disk. Calculates Lux rewards based on per-capability rates. Runs a periodic metering loop that prunes old records beyond a 30-day retention window.

## How It Works
- Maintains an in-memory `Map<string, ResourceUsage[]>` keyed by peerId. Each usage record has a `resourceType`, `quantity`, `unit`, and `timestamp`.
- Per-capability reward rates: relay=0.001 Lux/MB, api_keys=0.01/call, compute_cpu=0.1/minute, compute_gpu=0.5/minute, storage=0.001/GB-hour, gateway=0.01/1000 requests, validator=0.05/validation, index=0.005/query.
- `calculateRewards()` aggregates usage by type within a time window (hour/day/week/month), applies normalization divisors (relay: bytes to MB, gateway: per 1000 requests), and multiplies by the reward rate.
- `getNetworkUsage()` iterates all peers to produce aggregate readings with contributing node counts per resource type.
- Persists to `~/.pando/resource-metering.json`. Records older than 30 days are pruned during the metering loop.

## Gotchas
- Reward rates are hardcoded constants, not configurable at runtime. Changing rates requires a code change and rebuild.
- The normalization divisors map only covers `relay` (1,048,576 for bytes-to-MB) and `gateway` (1000). Other resource types have an implicit divisor of 1.
- Persistence is a full JSON dump of all records — for nodes with high throughput, the file can grow large before the 30-day prune kicks in.
- No dedup on `recordUsage()` — calling it multiple times with the same data creates duplicate entries.

## Key Files
- `packages/node/src/resource-meter.ts` — ResourceMeter class
- `packages/shared/src/types.ts` — ResourceUsage, MeterReading, NetworkMeterReading, RewardCalculation types
