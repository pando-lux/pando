---
id: request-reply
type: infrastructure
entry: packages/node/src/request-reply.ts
depends_on: [network]
depended_by: [reputation, resource-proof, resource-router, pando-node]
exposes:
  - start()
  - registerHandler(type, handler)
  - getHandlerTypes()
  - request(to, type, payload, timeoutMs?)
  - query(type, payload, opts?)
  - getStats()
rules: []
last_verified: 2026-02-18
---

# Request/Reply Manager

## What It Does
Structured request/response messaging between Pando nodes over the existing `pando/agent-messages` GossipSub topic. Provides correlation IDs, timeouts, and rate limiting for peer-to-peer queries.

## How It Works
- Piggybacks on the existing agent-messages GossipSub topic. Messages are wrapped in a `{ messageKind: 'request' | 'reply', data }` envelope to distinguish them from regular agent messages.
- **`request()`**: sends a typed request to a specific peer and returns a Promise that resolves when the reply arrives or rejects on timeout (default 30 seconds). Uses `requestId` (UUID) for correlation.
- **`query()`**: broadcasts a request to all peers (`to: '*'`) and collects up to `maxReplies` (default 10) within the timeout window. Returns whatever replies arrived when the timer fires.
- **Rate limiting**: outbound requests capped at 30/minute, outbound replies capped at 60/minute. Exceeding the limit throws an error.
- Handlers are registered by type string (e.g., `reputation_query`, `profile_query`, `memory_query`, `storage_challenge`). Incoming requests are matched to handlers and replies are sent automatically.
- Tracks stats: total sent, received, timeouts, and average latency (rolling window of 200 samples).

## Phase 67 Fixes
- **Envelope unwrapping fix:** `publishAgentMessage()` wraps messages as `{ targetPeerId, agentMsg }`. The handler now correctly reads `msg.agentMsg.messageKind` (not `msg.messageKind`). Also filters by `targetPeerId` so nodes only process messages addressed to them or broadcast (`*`).
- **New handler:** `pando/upgrade-node` — compute instances pull latest code, build, and restart via P2P request.
- **Git strategy:** Uses `git fetch + reset --hard origin/master` instead of `git pull` to handle orphan-branch force pushes from `push-public.sh`.

## Gotchas
- The GossipSub topic is shared with all agent messages -- non-request/reply messages (no `messageKind` field) are silently ignored, but all messages still transit through the handler.
- `request()` to a specific peer still publishes via GossipSub broadcast -- the `to` field is only used for handler filtering on the receiving end, not for targeted delivery.
- Pending requests are stored in a Map keyed by `requestId`. If the node crashes, all pending requests are lost (no persistence).
- The `query()` function always waits the full timeout before resolving, even if `maxReplies` are received early.

## Key Files
- `packages/node/src/request-reply.ts` -- RequestReplyManager class
- `packages/shared/src/types.ts` -- PandoRequest, PandoReply types
