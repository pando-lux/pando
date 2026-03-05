# Pando Resource Network — Heterogeneous Node Architecture

> Created: 2026-02-17
> Updated: 2026-02-18 (Architecture cleanup complete, ready for Phase A implementation)
> Status: Phase A-D — DONE (capability detection, resource routing, marketplace pricing, resource metering all implemented)
> Depends on: Phase 19 (Managers), Phase 12.1 (Witness Emission), Phase 8 (Cross-Node Coordination)
> Implements: The economic vision — "anyone can contribute what they have and earn Lux"
> Priority: HIGH — BUG-14 (Lightsail task-stealing, 100% failure) was the #1 source of failures. Phase A fixes this architecturally.

---

## Problem Statement

Today every Pando node runs identical code, but nodes have wildly different capabilities:

- **Lightsail** has a public IP and 24/7 uptime but NO Claude Code — it fails 100% of tasks
- **Windows** has Claude Code + OpenAI keys + GPU — it can do everything
- **A future Raspberry Pi node** might only relay traffic
- **A gamer's PC** might offer GPU compute when idle

The scheduler doesn't know what any node can do. It tries tasks blindly and fails. There's no way to contribute "just bandwidth" or "just a GPU" and earn Lux for it.

**Goal:** Nodes declare capabilities. The network routes work to the right node. Everyone earns for what they contribute. No wasted work.

---

## Design Principles

1. **Capabilities, not categories.** A node isn't "a relay node" or "a compute node" — it has a SET of capabilities. A node with Claude Code + GPU + storage contributes all three simultaneously.

2. **Self-declaration + verification.** Nodes declare what they offer. Peers verify claims through witnessed work. Lying about capabilities gets caught (tasks fail → reputation drops → routing deprioritized).

3. **Market-driven pricing.** Nodes set their own prices. The network finds the cheapest node that meets the requirement. No central price authority.

4. **Backward compatible.** Existing nodes with no capability declaration default to "full capability" (current behavior). The system degrades gracefully — no capability info means the old blind-claim approach.

5. **Rewards proportional to value.** GPU compute is harder to provide than relay bandwidth. Pricing reflects this naturally through supply/demand.

---

## Capability Taxonomy

### Resource Types

| ID | Resource | What It Provides | Example Hardware | Passive/Active |
|---|---|---|---|---|
| `relay` | P2P traffic routing, bootstrap, NAT traversal | Any always-on device | Passive |
| `api_keys` | AI model access (OpenAI, Anthropic, Google, etc.) | Developer with API subscription | Active (per-call) |
| `compute_cpu` | Claude Code agent execution, task processing | Machine with Claude Code installed + authenticated | Active (per-task) |
| `compute_gpu` | ML inference, image gen, training, video processing | Gaming PC, ML workstation, cloud GPU | Active (per-compute-minute) |
| `storage` | File hosting, content CDN, backup | Any machine with spare disk | Passive + Active |
| `gateway` | Public HTTP API proxy, web UI serving | Server with public IP + domain | Passive (per-request) |
| `validator` | Witness emissions, verify task results, attestation | Any node (lightweight) | Active (per-attestation) |
| `index` | Search index, content discovery, metadata queries | Node with RAM + decent CPU | Active (per-query) |

### Capability Profile Schema

```typescript
interface CapabilityProfile {
  /** Node's peer ID */
  peerId: string;

  /** Version of the capability schema */
  schemaVersion: 1;

  /** When this profile was last updated */
  updatedAt: number;

  /** Individual capability declarations */
  capabilities: {
    relay?: {
      enabled: true;
      bandwidthMbps?: number;       // Self-reported upload bandwidth
      publicIp?: boolean;            // Has a public IP (can bootstrap)
      maxConnections?: number;       // Max simultaneous peer connections
    };

    api_keys?: {
      enabled: true;
      providers: string[];           // ["openai", "anthropic", "google"]
      models: string[];              // ["gpt-4o", "claude-sonnet-4-5", "gemini-2.0"]
      rateLimit?: number;            // Max calls per hour willing to serve
    };

    compute_cpu?: {
      enabled: true;
      claudeCode: boolean;           // Has Claude Code installed + authenticated
      maxConcurrent: number;         // Max concurrent agent sessions
      memoryMb?: number;             // Available RAM
      os: string;                    // "windows" | "mac" | "linux"
    };

    compute_gpu?: {
      enabled: true;
      gpuModel: string;              // "RTX 4090", "A100", etc.
      vramMb: number;                // GPU VRAM in MB
      frameworks: string[];          // ["cuda", "rocm", "metal"]
      models: string[];              // Models the GPU can run
    };

    storage?: {
      enabled: true;
      availableMb: number;           // Available disk space
      serving: boolean;              // Willing to serve stored content via HTTP
      maxFileSizeMb?: number;        // Max single file size
      persistence: string;           // "ephemeral" | "persistent" | "replicated"
    };

    gateway?: {
      enabled: true;
      publicUrl?: string;            // e.g., "https://gateway.example.com"
      https: boolean;                // Has TLS
      maxRequestsPerHour?: number;   // Rate limit
    };

    validator?: {
      enabled: true;
      maxAttestationsPerHour?: number;
    };

    index?: {
      enabled: true;
      indexedContent: number;        // Number of content items indexed
      searchCapable: boolean;
    };
  };

  /** Pricing in Lux (what this node charges) */
  pricing: {
    compute_cpu_per_task?: number;      // Lux per completed task
    compute_gpu_per_minute?: number;    // Lux per GPU-minute
    storage_per_gb_day?: number;        // Lux per GB per day
    api_call_per_request?: number;      // Lux per API call routed
    gateway_per_1k_requests?: number;   // Lux per 1000 HTTP requests
    index_per_query?: number;           // Lux per search query
  };
}
```

### Task Requirement Schema

The Planner already generates agent profiles. We extend with:

```typescript
interface TaskRequirements {
  /** Required capabilities (ALL must be present on the executing node) */
  requiredCapabilities: {
    compute_cpu?: boolean | { claudeCode: boolean; minMemoryMb?: number };
    compute_gpu?: boolean | { minVramMb: number; frameworks?: string[] };
    api_keys?: boolean | { providers: string[]; models?: string[] };
    storage?: boolean | { minMb: number };
  };

  /** Preferred capabilities (nice to have, improve routing score) */
  preferredCapabilities?: {
    publicIp?: boolean;
    os?: string;
    minReputationScore?: number;
  };

  /** Maximum Lux budget for this task */
  maxBudgetLux?: number;

  /** Locality preference */
  locality?: 'local' | 'any' | 'remote_preferred';
}
```

---

## Architecture Components

### 1. Capability Registry (`capability-registry.ts`)

**Purpose:** Network-wide map of what every node offers. Like DNS but for capabilities.

**How it works:**
- Each node computes its own CapabilityProfile on startup (auto-detect hardware, check for Claude Code, check for API keys)
- Broadcasts profile on `pando/capabilities` GossipSub topic
- Re-broadcasts on change (e.g., API key added, disk space changes)
- Heartbeat every 5 minutes to confirm still available
- Peers store received profiles with TTL (expire after 15 min without heartbeat)
- Queryable: "find all nodes with compute_gpu and vram >= 8GB"

**Storage:** SQLite table `capabilities` with columns: peerId, capability, details (JSON), pricing, lastSeen, reputation.

**Extends:** Current ManagerRegistry pattern (already has register/deregister/query).

### 2. Resource Router (`resource-router.ts`)

**Purpose:** Given a task with requirements, find the best node to execute it.

**Routing algorithm:**

```
1. Filter: remove nodes that don't meet requiredCapabilities
2. Filter: remove nodes over budget (their price > task's maxBudgetLux)
3. Filter: remove quarantined nodes (SecurityMonitor)
4. Score remaining nodes:
   - reputation_score * 0.4     (trust)
   - availability_score * 0.3   (not overloaded)
   - price_score * 0.2          (cheaper is better)
   - latency_score * 0.1        (closer is faster)
5. Select highest-scoring node
6. If local node qualifies and scores within 20% of best: prefer local (avoid network latency)
```

**Integration with existing scheduler:**
- Before claiming a task, scheduler calls `resourceRouter.canExecuteLocally(task)` → returns true/false
- If false, scheduler calls `resourceRouter.findBestNode(task)` → returns peerId
- Task is forwarded to that node via existing P2P task routing (Phase 8)
- The remote node's scheduler picks it up (it already knows it can handle it)

### 3. Resource Meter (`resource-meter.ts`)

**Purpose:** Accurately measure what resources each node actually used/provided.

**What gets metered:**

| Resource | How Measured | Granularity |
|---|---|---|
| Relay bandwidth | libp2p transport byte counters | Per-peer, per-minute |
| API key calls | Intercept at Planner/search call sites | Per-call |
| CPU compute | Task duration + token count from Claude stream-json | Per-task |
| GPU compute | GPU utilization * time (nvidia-smi / metal-perf) | Per-minute |
| Storage | Disk usage of `~/.pando/content/` directory | Hourly scan |
| Gateway | Fastify request count from API server | Per-request |
| Validation | Count of witness attestations signed | Per-attestation |

**Anti-gaming:** Metering alone isn't trustworthy (a node could lie). That's why metering is combined with...

### 4. Witnessed Resource Verification

**Purpose:** Peers verify that claimed resource usage actually happened.

**How it works (extends Phase 12.1 Witness Emission):**

```
1. Node claims: "I relayed 500MB of traffic this hour"
2. Node submits ResourceClaim with evidence:
   - Relay: peer connection logs (peers can confirm from their side)
   - Compute: task completion hash (already witnessed by Phase 12.1)
   - Storage: content served (requesters confirm they received it)
   - API: API response hashes (consumers confirm they got results)
3. 2+ peers must attest the claim before Lux is minted
4. If claim can't be verified → no reward (fail-safe)
```

**What's already built that helps:**
- `emission-witness.ts` — proposal → witness → quorum flow
- Ed25519 signatures on attestations
- Anti-spoofing + rate limiting (10/hour)

### 5. Pricing Engine (`pricing-engine.ts`)

**Purpose:** Match supply and demand to set fair prices.

**Phase 1 (simple):** Fixed prices per resource type, configurable per node.

```typescript
// Default pricing (overridable in ~/.pando/pricing.json)
const DEFAULT_PRICING = {
  compute_cpu_per_task: 5.0,        // Lux per task
  compute_gpu_per_minute: 0.5,      // Lux per GPU-minute
  storage_per_gb_day: 0.01,         // Lux per GB per day
  api_call_per_request: 0.05,       // Lux per API call
  gateway_per_1k_requests: 0.1,     // Lux per 1000 requests
  validator_per_attestation: 0.1,   // Lux per attestation
};
```

**Phase 2 (market):** Dynamic pricing based on supply/demand.
- Track: how many nodes offer each capability, how many requests are pending
- If demand > supply → price goes up (natural incentive to add more nodes)
- If supply > demand → price goes down (natural market efficiency)
- Nodes set their floor price (won't work below this)
- Router picks cheapest node above floor that meets requirements

---

## Reward Model

### Passive Rewards (Earned by Being Available)

| Resource | Base Rate | How Verified | Daily Cap |
|---|---|---|---|
| Relay uptime | 0.05 Lux per 10-min epoch | Peer heartbeat confirmation | 7.2 Lux |
| Storage serving | 0.01 Lux per GB per day | Content retrieval confirmed by requester | 50 Lux |
| Gateway uptime | 0.02 Lux per 1000 requests | Request logs cross-referenced with peers | 20 Lux |
| Validator availability | 0.05 Lux per 10-min epoch (when attesting) | Attestation signatures verifiable on-chain | 7.2 Lux |

### Active Rewards (Earned by Doing Work)

| Resource | Base Rate | How Verified | Notes |
|---|---|---|---|
| CPU task completion | 5.0 Lux per task | Witness emission (Phase 12.1) | Current system, unchanged |
| GPU compute | Market price per GPU-minute | Task output hash + duration attestation | Priced by node |
| API key usage | 0.05 Lux per call (or market price) | Response hash + latency attestation | Node sets rate |
| Index query served | 0.01 Lux per query | Query/response hash pair | Lightweight |

### Early Multipliers (Incentivize Capability Diversity)

```
Per capability type, independently:
  First 10 nodes offering this capability:  5x reward multiplier
  Nodes 11-100:                              3x reward multiplier
  Nodes 101-1000:                            2x reward multiplier
  After 1000:                                1x (base rate)
```

This means: if you're one of the first 10 GPU nodes, you earn 5x. But you're also the 500th relay node, so relay rewards are only 2x. **Each capability has its own adoption curve.**

---

## GossipSub Integration

### New Topic: `pando/capabilities`

| Message Type | Payload | When |
|---|---|---|
| `CAPABILITY_ANNOUNCE` | Full CapabilityProfile | On startup, on capability change |
| `CAPABILITY_HEARTBEAT` | { peerId, timestamp, load } | Every 5 minutes |
| `CAPABILITY_WITHDRAW` | { peerId, capability } | When a capability is removed |
| `RESOURCE_CLAIM` | { peerId, resource, amount, evidence } | When claiming reward |
| `RESOURCE_WITNESS` | { claimId, witnessId, signature, approved } | Witness attestation |

### Existing Topics (Changes)

| Topic | Change |
|---|---|
| `pando/tasks` | Add `requiredCapabilities` to task broadcast |
| `pando/agent-events` | Add `RESOURCE_USAGE` event type for metering |

---

## Migration Path (Backward Compatibility)

### Phase A: Capability Declaration

**Changes:** Add CapabilityProfile, broadcast on startup, scheduler checks before claiming.

**Backward compatible:** Nodes without capability declaration are treated as "full capability" (old behavior). They still blind-claim. New nodes that declare capabilities will only claim tasks they can handle.

**Immediate fix:** Lightsail declares `{ relay: true, gateway: true, validator: true }` — no compute_cpu. Scheduler stops trying to run Claude Code tasks on it. 480 failures → 0 failures.

### Phase B: Smart Routing

**Changes:** Add ResourceRouter, Planner outputs requiredCapabilities, cross-node task routing.

**Backward compatible:** Tasks without requiredCapabilities route to any node (old behavior). Tasks with requirements get smart routing. The router is an optimization layer, not a requirement.

### Phase C: Resource Metering

**Changes:** Add ResourceMeter, track actual usage per capability.

**Backward compatible:** Nodes without metering still earn current flat rewards (uptime epochs, task completion). Metered nodes earn more precise, potentially higher rewards. Metering is opt-in via the capabilities a node declares.

### Phase D: Marketplace Pricing

**Changes:** Add PricingEngine, dynamic supply/demand pricing.

**Backward compatible:** Default prices are the current flat rates. Market pricing is an optimization. If no pricing data exists, fall back to defaults.

---

## Security Considerations

### 1. Capability Lying
**Risk:** Node claims GPU capability but doesn't have one.
**Mitigation:** Task fails → reputation drops → eventually quarantined. Witness verification adds a second layer — peers confirm work actually happened.

### 2. Free-Riding
**Risk:** Node claims to relay but drops packets. Claims storage but doesn't serve content.
**Mitigation:** Periodic verification challenges. Peers randomly request stored content — if it's not there, storage reward stops. Relay is verified by peers confirming they received routed messages.

### 3. Sybil Resource Farming
**Risk:** Spin up 100 fake relay nodes to earn 100x uptime rewards.
**Mitigation:** Existing anti-Sybil in SecurityMonitor (Phase 12.2). Plus: resource rewards require witness attestation (can't self-attest). Plus: reputation takes time to build — new nodes earn less until proven.

### 4. Price Manipulation
**Risk:** Cartel of nodes sets artificially high prices.
**Mitigation:** Open market — anyone can undercut. Plus: the network has DEFAULT_PRICING as a ceiling for essential services. Nodes can charge LESS than default, not more (for essential tasks).

### 5. Resource Exhaustion
**Risk:** Node advertises 50GB storage but only has 5GB. Fills up and stops serving.
**Mitigation:** Periodic capability refresh (re-scan actual resources). If declared != actual, auto-downgrade the capability and notify peers.

---

## File Index (Planned)

| File | Purpose |
|---|---|
| `packages/shared/src/types.ts` | CapabilityProfile, TaskRequirements, ResourceClaim types |
| `packages/node/src/capability-registry.ts` | Network-wide capability tracking |
| `packages/node/src/resource-router.ts` | Smart task-to-node matching |
| `packages/node/src/resource-meter.ts` | Per-capability usage metering |
| `packages/node/src/pricing-engine.ts` | Supply/demand price discovery |
| `packages/node/src/capability-detector.ts` | Auto-detect local node capabilities on startup |

---

## Open Questions

1. **Should relay nodes earn more for routing cross-region traffic?** A node bridging US-Europe is more valuable than one relaying within the same data center.

2. **How do we handle GPU model compatibility?** A task needing Stable Diffusion XL won't run on a node with only 4GB VRAM. The capability declaration needs enough detail to prevent mismatches.

3. **What happens when a node's capabilities change mid-task?** E.g., a gamer starts gaming and their GPU becomes unavailable while processing a task. Need graceful task migration or timeout + reassignment.

4. **Should there be a minimum capability to join the network?** Even a validator-only node uses network bandwidth. Is there a floor below which a node costs the network more than it contributes?

5. **How do API key providers get compensated fairly?** If a node contributes a $20/month OpenAI key and the network uses $15 of it, the node is losing $15/month. The Lux earned must at minimum cover the dollar cost of the API usage. This implies a Lux-to-USD exchange rate, which we've avoided so far.
