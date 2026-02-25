---
id: resource-router
type: service
domain: resources
entry: packages/node/src/resource-router.ts
depends_on: [capability-registry, request-reply, reputation]
depended_by: [scheduler]
exposes:
  - findBestNode(requirements) — score and rank nodes by capability, reputation, health
  - routeTask(task, requirements) — route a task to the best node (local or remote via P2P)
  - forwardTask(task, targetPeerId) — forward a task to a specific remote node via RequestReply
  - reassignTask(task, requirements, excludeNodes) — reassign a failed task to next-best node
  - recordFailure(peerId, resourceType, error) — track resource failures for auto-degradation
  - getStats() — routing statistics (total routed, local, remote, reassigned, failures)
rules: []
last_verified: 2026-02-18
---

# Resource Router

## What It Does
Smart task routing with error correction. Finds the best node for a task based on capability match, reputation, latency, and current load. Forwards tasks to remote nodes via P2P (RequestReplyManager). Tracks resource failures and auto-disables degraded resources.

## How It Works
- `findBestNode()` queries the CapabilityRegistry for all capable nodes, scores each using `scoreNode()` (factors: capability match, reputation score, resource health status, preferred node bonus), sorts by score descending, and returns the top candidate with up to 5 alternatives.
- `routeTask()` calls `findBestNode()`, then either returns for local execution (if the local node scores highest) or forwards to the remote node via `forwardTask()`.
- `forwardTask()` sends the task to a remote node using `RequestReplyManager.request()` with a 30-second timeout and `task_forward` message type.
- Failure tracking: maintains a `Map<peerId, Map<resourceType, FailureRecord>>`. After 3 consecutive failures a resource is marked `degraded`; after 5 it is `disabled`. Disabled resources are excluded from scoring.
- `reassignTask()` re-routes a failed task while excluding the previously assigned node(s), enabling automatic failover.

## Gotchas
- Reputation manager is optional (`setReputationManager()`). If not set, all nodes score equally on the reputation component — routing is based solely on capability match and resource health.
- P2P forwarding requires the target node to have a running scheduler that handles `task_forward` messages; if the remote node's scheduler is off, the forward will timeout after 30s.
- Failure records are in-memory only — they reset on node restart, meaning previously degraded resources will be retried.
- The scoring function does not account for network latency directly — it only uses static factors (capability, reputation, health).

## Key Files
- `packages/node/src/resource-router.ts` — ResourceRouter class
- `packages/node/src/capability-registry.ts` — provides capability data for routing
- `packages/node/src/request-reply.ts` — P2P request/response for task forwarding
- `packages/node/src/reputation.ts` — optional reputation scoring
