---
id: reputation
type: infrastructure
entry: packages/node/src/kernel/reputation.ts
depends_on: [network, request-reply]
depended_by: [reputation-governance, resource-router, upgrade-protocol, pando-node]
exposes:
  - start()
  - recordEvent(type, detail, metadata?)
  - getLocalReputation()
  - getReputation(peerId)
  - getAllReputations()
  - getStats()
rules: []
last_verified: 2026-02-18
---

# Reputation Manager

## What It Does
Tracks agent performance across the network. Nodes with better track records get priority for task claiming. Builds reputation from tasks completed, build/test pass rates, completion speed, and peer endorsements.

## How It Works
- Maintains a local `ReputationRecord` with counters for tasks completed, failed, timed out, average completion time, build/test pass rates, profiles contributed, and an overall reputation score.
- `recordEvent()` updates counters and recomputes the weighted score. Five event types: `task_completed`, `task_failed`, `task_timed_out`, `profile_shared`, `peer_endorsement`.
- Score computation is a weighted sum of: completion rate, build pass rate, test pass rate, speed factor, and profile contributions.
- **P2P sync**: subscribes to `REPUTATION_UPDATE` events on `pando/agent-events`. Only broadcasts when the local score changes by more than 5% (`BROADCAST_THRESHOLD = 0.05`) to prevent spam.
- Registers a `reputation_query` handler on the RequestReplyManager. On peer connect, requests the peer's reputation (5-second delay for protocol setup).
- Remote peer records are stored in a separate Map (up to 1000 entries). Stale records older than 7 days are pruned every 6 hours.
- Local record persisted at `~/.pando/reputation.json`, peer records at `~/.pando/reputation-peers.json`.
- Event history is capped at 100 entries per record.

## Gotchas
- The `handleRemoteUpdate()` method accepts reputation records from peers at face value -- there is no independent verification of claimed task counts or pass rates.
- Rolling average for completion time uses a naive formula that can drift over many events due to floating-point precision.
- The 5% broadcast threshold is relative to the last broadcast score, not absolute -- small incremental changes that individually stay under 5% will never trigger a broadcast until the cumulative change exceeds the threshold.
- The `pruneInterval` timer is not cleared on any `stop()` method -- there is no explicit stop method on ReputationManager.

## Key Files
- `packages/node/src/reputation.ts` -- ReputationManager class
- `~/.pando/reputation.json` -- local reputation record
- `~/.pando/reputation-peers.json` -- peer reputation records
