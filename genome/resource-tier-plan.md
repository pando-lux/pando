# Resource Tier Architecture Plan — Phases 96–99

> **Created:** 2026-02-26
> **Status:** Planning — approved, not yet started
> **Prerequisite:** v2.1–v2.5 complete (they are)
>
> **Problem this solves:** The current architecture conflates "I have a capability" with "I'm sharing it with the world." There is no concept of local-private resources. Auto-detected capabilities (Claude Code, GPU, Docker) are immediately broadcast to all peers with no opt-in. The gateway routes Claude requests by trying to directly HTTP-connect to Claude nodes — which breaks for any node behind NAT (home users, laptops). Discovery is hardcoded.

---

## The Core Issue (Architecture Diagram)

```
Current (broken):
  capability-detector
       │ auto-detects
       ▼
  CapabilityProfile ──── GossipSub broadcast ────► ALL peers know I have claude-code
  (no separation)                                   Anyone can request my Claude quota

  Gateway:
  getBestNodeUrl('claude') ──► tries direct HTTP to Claude node
                                ↑ FAILS for home nodes behind NAT
```

```
Target (correct):
  capability-detector
       │ detects everything
       ▼
  LocalCapabilityStore ────────────────────────────► node's OWN tasks always work
  (private, never broadcast)

       │ user explicitly opts in per capability
       ▼
  SharedCapabilityProfile ─── GossipSub broadcast ──► peers see only what I share

  Gateway:
  all requests → best public EC2 node (HTTP)
                       │ P2P via RequestReplyManager
                       ▼
                 Claude node (anywhere — behind NAT OK)
                       │ P2P reply
                       ▼
                 EC2 → HTTP response → gateway → browser
```

---

## Three-Tier Resource Model

| Tier | Scope | Examples | Mechanism |
|---|---|---|---|
| **Tier 0 — Local Private** | This node's own tasks only | Claude Code, ComfyUI, local Ollama, offline bucket | `LocalCapabilityStore` — never broadcast |
| **Tier 1 — Network Shared** | Any peer can request | Contributed OpenAI key, MongoDB, S3 | `ResourceRegistry` (unchanged) + `SharedCapabilityProfile` (opt-in) |
| **Tier 2 — Group Scoped** | Specific users/teams | Future — not built now | Design when needed |

**Key invariant:** Detection ≠ sharing. Your node always knows what it has. Others only know what you chose to share.

---

## Phase 96 — Three-Tier Capability Architecture

**Goal:** Separate detection from sharing at the code level. Zero behavior change for existing contributed resources (ResourceRegistry unchanged). Zero behavior change for P2P sync.

### New Concept: LocalCapabilityStore

New file: `packages/node/src/platform/local-capability-store.ts`

```
~/.pando/local-capabilities.json
{
  "detectedAt": 1234567890,
  "capabilities": ["node", "python", "claude-code", "docker", "gpu"],
  "sharedCapabilities": [],   ← empty until user opts in via Phase 97
  "shareCompute": false        ← not offering compute to network
}
```

Responsibilities:
- Written by `capability-detector.ts` at node startup (always the full detected list)
- Read by `Scheduler`, `ResourceRouter`, `AgentManager` to answer "can I do this locally?"
- `sharedCapabilities` and `shareCompute` written by `/contribute` and `/revoke` commands (Phase 97)
- Never broadcast. Never P2P synced. Never in any GossipSub message.

### CapabilityProfile Broadcast Changes

The broadcast profile (`setLocalProfile()` → GossipSub) must ONLY reflect what the user has explicitly shared:

```typescript
// Before: auto-populate from detection
profile.capabilities.compute_cpu = hasClaudeCodeBinary;

// After: only if user opted in
profile.capabilities.compute_cpu = localCapStore.shareCompute && localCapStore.sharedCapabilities.includes('claude-code');
```

The `capabilities` list on the profile changes the same way:
```typescript
// Before: detectCapabilities() → broadcast all
// After: broadcast only localCapStore.sharedCapabilities
```

### Scheduler / ResourceRouter Changes

These two are the main consumers of "can I do this locally?" — they must read `LocalCapabilityStore`, not `CapabilityProfile`:

| File | Current | Change |
|---|---|---|
| `platform/scheduler.ts` | Calls `capabilityRegistry.canExecuteLocally()` which reads the SharedCapabilityProfile | Read `LocalCapabilityStore.capabilities` instead |
| `platform/resource-router.ts` | Same | Same change |
| `core/agent-manager.ts` | Calls `hasClaudeCodeAuth()` directly | No change needed — this IS correct local checking |

### API Change

`GET /v1/capabilities` currently returns the broadcast profile. This should now return both:

```json
{
  "local": { "capabilities": ["node", "python", "claude-code"] },
  "shared": { "capabilities": ["node", "python"], "shareCompute": false }
}
```

So the node owner can see what they have vs what they're sharing.

### Files Changed

| File | Change |
|---|---|
| `packages/node/src/platform/local-capability-store.ts` | **NEW** — read/write `~/.pando/local-capabilities.json` |
| `packages/node/src/platform/capability-detector.ts` | `detectCapabilities()` writes to LocalCapabilityStore; `detectCapabilityProfile()` reads sharedCapabilities to build broadcast profile |
| `packages/node/src/platform/scheduler.ts` | Read LocalCapabilityStore instead of CapabilityRegistry for local capability check |
| `packages/node/src/platform/resource-router.ts` | `canExecuteLocally()` reads LocalCapabilityStore |
| `packages/node/src/index.ts` | Init LocalCapabilityStore in boot sequence (before CapabilityRegistry) |
| `packages/node/src/api/platform-api.ts` | `GET /v1/capabilities` returns local + shared |
| `genome/components/capability-registry.md` | Update: no longer auto-broadcasts claude-code |
| `genome/components/capability-detector.md` (or create) | Document the split |

### Tests

| Test | How | Pass |
|---|---|---|
| Node starts with Claude installed | Check `local-capabilities.json` | `claude-code` present in local, NOT in broadcast profile |
| Node starts without Claude | Check `local-capabilities.json` | `claude-code` absent in both |
| Own agent task runs | Submit agent task | Works regardless of shareCompute setting |
| Peer queries my capabilities | `GET /v1/network/capabilities` from peer | No `claude-code` in my profile unless shared (Phase 97) |
| API response | `GET /v1/capabilities` | Returns both local and shared sections |

---

## Phase 97 — Compute Opt-In Commands

**Goal:** User explicitly controls what they share with the network. Restores `/contribute claude-code` as an intentional opt-in.

### TUI Commands

`/contribute claude-code`
1. Verify claude binary exists + `hasClaudeCodeAuth()` — error if not
2. Set `sharedCapabilities: ['claude-code']` and `shareCompute: true` in `local-capabilities.json`
3. Rebuild SharedCapabilityProfile to include `claude-code` and `compute_cpu: true`
4. Rebroadcast via GossipSub
5. Print: "Claude Code is now shared with the network. Peers can route tasks to you."

`/revoke claude-code`
1. Remove `claude-code` from `sharedCapabilities`, set `shareCompute: false`
2. Rebuild SharedCapabilityProfile without `claude-code`
3. Rebroadcast
4. Print: "Claude Code is no longer shared. Your node will only run its own tasks."

Same pattern works for any capability: docker, gpu, python. Future: comfyui, ollama.

### New CapabilityProfile Field

Add to `packages/shared/src/types.ts`:

```typescript
export interface CapabilityProfile {
  // ... existing fields ...
  shareCompute?: boolean;  // true = willing to accept network compute task requests
}
```

Peers check `shareCompute: true` before routing tasks. Peers with `shareCompute: false` or missing are ignored for network task routing.

### maxConcurrentNetworkTasks (future limit)

For now: no throttle. When Phase 98 P2P routing is live, add `maxConcurrentNetworkTasks: number` as a future field. Nodes report their current load. Requestors pick nodes with capacity.

### Gateway UX

"My Nodes" section should show:
- What capabilities are locally detected (greyed out if not shared)
- What is actively being shared (highlighted)
- A toggle or button to start/stop sharing compute

### Files Changed

| File | Change |
|---|---|
| `packages/shared/src/types.ts` | Add `shareCompute?: boolean` to CapabilityProfile |
| `packages/node/src/tui.ts` | `/contribute claude-code` and `/revoke claude-code` handlers |
| `packages/node/src/platform/local-capability-store.ts` | `setShared(cap)` and `unsetShared(cap)` methods |
| `packages/node/src/platform/capability-detector.ts` | `rebuildSharedProfile()` called after contribute/revoke |
| `packages/node/src/index.ts` | `updateCapabilityLinkedUser()` pattern for rebroadcast on share change |
| `packages/gateway/app/resources/page.tsx` | Show local vs shared, add opt-in toggle for claude-code |
| `genome/components/capability-registry.md` | Document shareCompute field |

### Tests

| Test | How | Pass |
|---|---|---|
| Contribute succeeds | `/contribute claude-code` on node with Claude | `shareCompute: true` in local store, `claude-code` in broadcast profile |
| Contribute fails (no Claude) | `/contribute claude-code` on node without Claude | Error message, no profile change |
| Revoke works | `/revoke claude-code` | `shareCompute: false`, profile rebroadcast, peers update within 15min TTL |
| Peer can find sharing node | `GET /network/capabilities` from peer | Sharing node appears with `shareCompute: true` |
| Own tasks unaffected | Run agent task after revoke | Still works (LocalCapabilityStore unchanged) |

---

## Phase 98 — P2P Task Routing for Compute

**Goal:** Gateway sends all requests to EC2 (public HTTP). EC2 P2P-routes to willing Claude nodes. Home nodes behind NAT become viable compute providers.

### Why The Current Phase 45 Approach Is Wrong

Phase 45 routes Claude requests by having the **gateway** directly HTTP-connect to a Claude-capable node. This requires the Claude node to have a public IP. It works for EC2 but fails for:
- Home users (NAT)
- Laptop nodes (no public IP)
- LS nodes without Claude binary

The correct model: **gateway never speaks directly to Claude nodes**. The gateway speaks to EC2 (always public). EC2 does the P2P routing internally.

### New Request Flow

```
User browser
    │ POST /v1/chat/message { message: "build me an app" }
    ▼
Vercel gateway
    │ getNodeUrl('any') or getNodeUrl('primary') — picks best EC2
    ▼
EC2 node  ←────────── normal HTTP, public IP, always works
    │
    │ 1. Check LocalCapabilityStore → hasClaudeCode? No.
    │ 2. Check CapabilityRegistry → find peers with shareCompute=true + claude-code
    │ 3. Pick best peer (lowest load, recent activity)
    │ 4. RequestReplyManager.request(peerId, 'claude_task', { prompt, context })
    │
    ├── P2P stream (direct TCP or GossipSub fallback)
    ▼
Claude-capable peer (home node, behind NAT — no public IP needed)
    │
    │ Execute: claude -p prompt
    │ Collect output
    │ Reply via P2P: RequestReplyManager handler returns result
    │
    ◄── P2P reply
    │
EC2 node
    │ receives P2P reply
    │ returns HTTP response to gateway
    ▼
Vercel gateway → browser
```

### Streaming Problem

RequestReplyManager is request/reply (one round trip). Claude Code output is streamed. Two options:

**Option A (simpler, V1):** Collect-and-return
- EC2 sends task to Claude peer, waits for full completion
- Returns complete output in one HTTP response
- Timeout: 5 minutes for long tasks
- Downside: browser sees no output until task finishes

**Option B (better, V2):** Chunked P2P streaming
- Claude peer streams chunks via multiple P2P messages
- EC2 aggregates and streams HTTP chunked response to gateway
- Gateway streams to browser
- Requires new P2P streaming protocol (out of scope for Phase 98)

**Decision: Option A for Phase 98.** Option B is Phase 99+ work.

### Gateway NodePool Changes

Remove `getBestNodeUrl('claude')` filtering entirely:
- NodePool no longer tracks `hasClaudeCode`
- All AI chat requests use `getNodeUrl('any')` or `getNodeUrl('primary')`
- The network handles routing to Claude nodes via P2P

NodePool simplification:
- Remove `hasClaudeCode` field from health check result
- Remove `claude` preference from `getBestNodeUrl()`
- `getNodeUrl()` accepts only `'primary' | 'any'`

### Node API Change

`POST /v1/chat/message` when build intent detected and no local Claude:
```typescript
// Before:
if (!hasClaudeCodeAuth()) {
  return { message: "No AI-capable nodes available. Ask a node operator to enable Claude Code." };
}

// After:
if (!localCapStore.capabilities.includes('claude-code')) {
  // Try P2P routing
  const claudePeer = capabilityRegistry.findCapableNodes({ shareCompute: true, claude_code: true })[0];
  if (!claudePeer) {
    return { message: "No Claude-capable nodes available on the network right now." };
  }
  const result = await requestReply.request(claudePeer.peerId, 'claude_task', { prompt, context }, 300_000);
  return { message: result.output };
}
```

### New P2P Handler: `claude_task`

Register in `core/request-reply.ts` handler setup:

```typescript
requestReply.registerHandler('claude_task', async (payload) => {
  // Only handles if shareCompute=true in local store
  if (!localCapStore.shareCompute) return { error: 'Not sharing compute' };
  // Execute claude -p with the prompt
  const result = await agentManager.runClaudeTask(payload.prompt, payload.context);
  return { output: result.output, cost: result.cost };
});
```

### Payment (Future)

Lux should flow from the requesting node to the executing node. For Phase 98: track the request for future billing. No Lux transfer yet. Add a comment: `// TODO Phase 100: PaymentGate.escrow() before task, release() after reply`.

### Files Changed

| File | Change |
|---|---|
| `packages/gateway/lib/node-pool.ts` | Remove `hasClaudeCode` tracking, remove `claude` preference |
| `packages/gateway/lib/node-connection.ts` | `getNodeUrl()` accepts only `'primary' | 'any'` |
| `packages/gateway/app/api/chat/message/route.ts` | Remove `'claude'` preference — use `'any'` |
| `packages/node/src/api/platform-api.ts` | Replace "no AI nodes" error with P2P routing logic |
| `packages/node/src/core/request-reply.ts` | Register `claude_task` handler |
| `packages/node/src/core/agent-manager.ts` | Add `runClaudeTask()` method (used by P2P handler) |
| `genome/components/request-reply.md` | Document `claude_task` handler |
| `genome/flows/chat-to-project.md` | Update flow: gateway → EC2 → P2P → Claude node |

### Tests

| Test | How | Pass |
|---|---|---|
| Node with Claude locally | Submit build request | Runs locally, no P2P routing needed |
| Node without Claude, peer with Claude sharing | Submit build request to EC2 | P2P routes to Claude peer, result returned |
| Node without Claude, no peers sharing | Submit build request | Graceful error "No Claude-capable nodes on network" |
| Timeout | Claude peer hangs | 5min timeout, returns error gracefully |
| Gateway routes to EC2, not Claude node | Check gateway NodePool | No `hasClaudeCode` in health check, no `'claude'` preference |

---

## Phase 99 — Dynamic Node Discovery

**Goal:** Gateway discovers reachable nodes from the P2P network automatically. No hardcoded node lists required. The network grows without Vercel env var changes.

### Current Problem

```
NodePool seeds:
  PANDO_NODES = "http://54.82.241.132:4000,http://34.201.82.126:4000"  ← must be manually updated
  FALLBACK_SEEDS = [4 hardcoded IPs]  ← stale if nodes move or new ones added
```

Adding a new EC2 node means: SSH to Vercel, update PANDO_NODES, redeploy. With 100 nodes this is untenable.

### Solution: P2P-Backed Discovery

On gateway startup (and every 5 minutes):
1. Health-check all known nodes
2. For each healthy node: call `GET /v1/network/capabilities`
3. Extract peers with `publicAddress` set (publicly reachable)
4. Add them to the NodePool dynamically
5. Prune nodes not seen in 15 minutes

```typescript
// In node-pool.ts
async discoverFromNetwork(): Promise<void> {
  for (const knownNode of this.getHealthyNodes()) {
    const caps = await fetch(`${knownNode.url}/v1/network/capabilities`).json();
    for (const peer of caps.peers) {
      if (peer.profile?.publicAddress) {
        const url = `http://${peer.profile.publicAddress}:4000`;
        this.addCandidate(url);  // Will be health-checked on next cycle
      }
    }
  }
}
```

### PANDO_NODES and FALLBACK_SEEDS Become Optional

- `PANDO_NODES` env var: still supported as initial seed hint, but no longer required
- `FALLBACK_SEEDS`: reduce to 2 entries (EC2-1 only + one LS backup). Enough to bootstrap.
- Once connected to any 1 node, the gateway discovers the rest automatically

### NodePool Changes

```typescript
class NodePool {
  // Existing:
  private nodes: Map<string, NodeEntry>;

  // New:
  async discoverFromNetwork(): Promise<void>  // P2P discovery
  private discoveryInterval: NodeJS.Timer;    // runs every 5 min

  // Start discovery in start():
  this.discoveryInterval = setInterval(() => this.discoverFromNetwork(), 5 * 60 * 1000);
}
```

Each discovered node goes through the normal health check cycle before being used.

### Filtering: Only Public Nodes in Gateway Pool

The gateway NodePool should only contain nodes with `publicAddress` set — meaning they're HTTP-reachable from the internet. Nodes behind NAT are useful for P2P compute (Phase 98) but not as direct gateway targets.

Filter in `discoverFromNetwork()`:
```typescript
if (!peer.profile?.publicAddress) continue;  // behind NAT — not a gateway target
```

### Files Changed

| File | Change |
|---|---|
| `packages/gateway/lib/node-pool.ts` | Add `discoverFromNetwork()`, periodic timer, prune stale nodes |
| `packages/gateway/lib/node-connection.ts` | No change |
| `CLAUDE.md` | Update Live Network section — remove note about hardcoded seeds |
| `genome/components/capability-registry.md` | Document `publicAddress` as gateway discovery field |

### Tests

| Test | How | Pass |
|---|---|---|
| Cold start with only 1 seed | Start gateway with PANDO_NODES=EC2-1 only | Discovers EC2-2 via P2P within first poll cycle |
| New node added | Add new EC2 node to network | Gateway adds it to pool within 5 minutes, no env change needed |
| Stale node pruned | Stop a node | Gateway removes it from pool within 15 minutes |
| No PANDO_NODES set | Start gateway with only FALLBACK_SEEDS | Still discovers all public nodes via P2P within 5 min |

---

## Phase Order and Dependencies

```
Phase 96 (Three-Tier Architecture)
  — No dependencies, start immediately
  — Changes: LocalCapabilityStore, capability-detector split, scheduler/router read local store
  │
  ▼
Phase 97 (Opt-In Commands)
  — Depends on Phase 96 (needs LocalCapabilityStore with sharedCapabilities field)
  — Changes: /contribute claude-code, /revoke, shareCompute flag, gateway toggle
  │
  ▼
Phase 98 (P2P Task Routing)       Phase 99 (Dynamic Discovery)
  — Depends on Phase 97             — Can run in parallel with Phase 97/98
  — Changes: EC2 P2P-routes to      — Changes: NodePool self-discovery
    Claude nodes, gateway
    removes Claude-specific routing
```

Phases 98 and 99 can run in parallel after Phase 97 completes.

---

## Master Task List

### Phase 96
- [ ] Create `local-capability-store.ts` with read/write for `~/.pando/local-capabilities.json`
- [ ] Update `capability-detector.ts` — writes full detected list to LocalCapabilityStore
- [ ] Update `capability-detector.ts` — `detectCapabilityProfile()` reads `sharedCapabilities` (not auto-detect)
- [ ] Update `scheduler.ts` — read LocalCapabilityStore instead of CapabilityRegistry for local check
- [ ] Update `resource-router.ts` — `canExecuteLocally()` reads LocalCapabilityStore
- [ ] Update `platform-api.ts` — `GET /v1/capabilities` returns local + shared sections
- [ ] Update `index.ts` — init LocalCapabilityStore in boot sequence before CapabilityRegistry
- [ ] Write tests (see Phase 96 test table above)
- [ ] Update genome: `capability-registry.md`, `capability-detector.md` (create)
- [ ] Smoke test: deploy to EC2-1, verify claude-code NOT in broadcast profile, own tasks still work

### Phase 97
- [ ] Add `shareCompute?: boolean` to `CapabilityProfile` in `packages/shared/src/types.ts`
- [ ] Add `setShared(cap)` and `unsetShared(cap)` to `LocalCapabilityStore`
- [ ] Add `rebuildSharedProfile()` to `capability-detector.ts` (called after contribute/revoke)
- [ ] Update `tui.ts` — `/contribute claude-code` handler (verify + set shared + rebroadcast)
- [ ] Update `tui.ts` — `/revoke claude-code` handler (unset + rebroadcast)
- [ ] Update gateway resources page — show local vs shared, add opt-in toggle
- [ ] Write tests (see Phase 97 test table)
- [ ] Update genome: `capability-registry.md`
- [ ] Smoke test: contribute claude-code, verify peer sees it, revoke, verify peer no longer sees it

### Phase 98
- [ ] Register `claude_task` handler in `core/request-reply.ts`
- [ ] Add `runClaudeTask()` to `agent-manager.ts`
- [ ] Update `platform-api.ts` chat handler — route to P2P if no local Claude
- [ ] Update `gateway/lib/node-pool.ts` — remove `hasClaudeCode`, remove `'claude'` preference
- [ ] Update `gateway/lib/node-connection.ts` — remove `'claude'` option from `getNodeUrl()`
- [ ] Update `gateway/app/api/chat/message/route.ts` — use `'any'` not `'claude'`
- [ ] Write tests (see Phase 98 test table)
- [ ] Update genome: `request-reply.md`, `flows/chat-to-project.md`
- [ ] E2E test: Windows node (has Claude, will share after Phase 97) receives P2P task from EC2

### Phase 99
- [ ] Add `discoverFromNetwork()` to `node-pool.ts`
- [ ] Add 5-minute discovery interval to NodePool `start()`
- [ ] Filter discovered nodes: only add those with `publicAddress` set
- [ ] Reduce `FALLBACK_SEEDS` to 2 entries (EC2-1 + LS-2 backup)
- [ ] Write tests (see Phase 99 test table)
- [ ] Update `CLAUDE.md` live network section
- [ ] Update genome: `capability-registry.md`
- [ ] Smoke test: start gateway with empty PANDO_NODES, verify it discovers EC2-1 and EC2-2 via P2P within 5 min

---

## What Success Looks Like (End State)

After Phases 96–99, the system behaves like this:

1. **User installs Pando on their laptop** — Claude Code is in their PATH. Node starts. Nothing is shared. Their own agents use Claude Code freely. No network exposure.

2. **User wants to contribute compute** — Types `/contribute claude-code`. The network immediately knows this node is available for compute tasks. Users on EC2 (no Claude) get their build requests routed here via P2P.

3. **User changes their mind** — Types `/revoke claude-code`. Network stops routing to them within 15 minutes (TTL expiry). Their own tasks still work.

4. **New EC2 node added to network** — Gateway discovers it automatically within 5 minutes. No Vercel env changes needed.

5. **Network grows to 1000 nodes** — Gateway dynamically routes to any public node. Compute requests route via P2P to whichever nodes are sharing Claude. No bottleneck, no manual config.

6. **Lux economy (future Phase 100+)** — Nodes that share compute earn Lux per task. Requesting nodes pay Lux per task. The opt-in mechanism becomes the foundation of a real compute marketplace.

---

## Notes for Context Compaction

If context resets, this document is the source of truth. Start from here:
- Phase 96 is first — creates LocalCapabilityStore and splits detection from sharing
- Phase 97 is second — adds /contribute and /revoke for claude-code
- Phase 98 is third — makes EC2 route compute tasks via P2P instead of gateway direct-HTTP
- Phase 99 can parallel with 98 — makes gateway discover nodes from P2P network
- All genome docs updated after each phase (see genome/components/)
- Tests must pass on EC2-1 before shipping each phase
