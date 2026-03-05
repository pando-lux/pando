---
id: economy
components: [ledger, emission-witness, payment-gate, resource-meter, resource-marketplace]
rules: [budget-enforcement]
trigger: network_operation
---

# Economy Flow

> How Lux flows through the network. The three operational modes, user interaction model, scaling milestones, and known failure modes at each scale.

---

## The Three Operational Modes

Everything the network does falls into one of these three modes.

### Mode 1: Pando Managing Itself

Pando is a living system. It is not software that gets "shipped" -- it is an organism that grows, heals, and improves forever. No human runs it. The AI manages the network the way a nervous system manages a body.

**How it works:**

The system is **event-driven, not poll-driven**. It does not check every hour like a watchman doing rounds. It sleeps until something happens, then wakes up, handles it, and goes back to sleep. The cost of sleeping is near zero.

```
Always listening (near-zero cost):
  |-- Health monitors (error rates, node metrics, uptime)
  |-- User inputs (unified input, governance proposals)
  |-- Network events (new peers, sync failures, P2P alerts)
  |-- Scheduled triggers (daily review, weekly audit)
  |-- External signals (security advisories, dependency updates)
         |
         v
   Wake Manager (cheap LLM call, ~$0.01)
   "Is this worth waking up for?"
         |
    +----+----+
    No        Yes
    |         |
  Sleep    Triage -> Create tasks -> Scheduler handles -> Sleep
```

**The daily rhythm:**
- **Always listening** (health monitors, events): ~zero cost
- **Light daily review** (scan logs, check metrics, review open tasks): ~$0.05
- **Weekly deeper review** (performance trends, dependency updates, security): ~$0.50
- **Monthly audit** (full system review, architecture assessment, roadmap): ~$2-5

**Who decides what gets built?** Governance. The AI proposes improvements, the network votes. No single entity controls it. The AI is the manager, not the owner.

### Mode 2: User-Owned Projects

Someone pays Lux and says: "Build me a chess game" or "Manage my restaurant website" or "Create a blog about cooking." They do not need to run a node. They do not need to know how Pando works. They just say what they want.

**The lifecycle:**

```
1. CREATE  -- User describes what they want, pays Lux upfront
2. BUILD   -- Network breaks it down, builds it phase by phase
3. DEPLOY  -- Network hosts it (nodes provide compute/storage/bandwidth)
4. MAINTAIN -- Enters maintenance mode:
              |-- Monitor uptime, errors, performance (always-on, cheap)
              |-- Auto-fix critical issues (site crashes, broken links)
              |-- Propose improvements to owner (owner approves/rejects)
5. EVOLVE  -- Owner requests changes (costs more Lux each time)
```

**Key difference from Mode 1:** The AI does not make changes without the owner's approval. For Pando itself, governance decides. For user projects, the **owner** decides.

**The owner controls:**
- **Autonomy level** -- "auto-fix anything" vs "ask me for everything"
- **Budget** -- "spend up to 50 Lux/month on maintenance"
- **What gets changed** -- approve or reject proposed improvements
- **Ownership transfer** -- can sell or give the project to someone else

**The network provides:**
- Hosting (distributed across nodes providing compute/storage)
- Monitoring (health checks, uptime, error detection)
- Maintenance AI (lightweight agent watching over the project)
- Build capacity (agents that can make changes when requested)

### Mode 3: Network Public Services

Beyond managing itself (Mode 1) and user projects (Mode 2), Pando provides **public services** that nobody specifically owns -- they belong to the network:

- **Search** -- AI-powered search across all content on Pando
- **Content delivery** -- hosting, caching, distribution of files and media
- **AI services** -- classification, generation, analysis available to all users
- **Security** -- threat detection, content moderation, anti-abuse (The Two Laws)
- **Discovery** -- finding services, projects, and peers on the network

These are like **public utilities**. The network collectively decides to run them, funded by Lux fees from users who use them. Node operators earn Lux for providing the compute, storage, and bandwidth that powers these services.

**Background agents for network health:**
- **Crawlers** periodically index content hosted on Pando
- **Quality agents** spot-check hosted services for issues
- **Security agents** scan for vulnerabilities and Law I violations
- **Optimization agents** identify bottlenecks and propose improvements via governance

---

## The Economy

```
Users ---- pay Lux ----> Network Services
  |                          |
  |                      Node Operators
  |                     earn Lux for providing:
  |                      |-- Compute (CPU/GPU)
  |                      |-- Storage (disk space)
  |                      |-- Bandwidth (network)
  |                      |-- Uptime (availability)
  |
  +-- buy Lux from --> Exchanges / Other Users
```

**Anyone can use Pando.** You do NOT need to run a node. You just need Lux.
**Node operators provide the infrastructure.** They earn Lux for their resources.
**The AI manages everything.** No human administrators needed.

### Lux Earning Rates

| Work Type | Base Reward | Daily Cap | With 5x early multiplier |
|---|---|---|---|
| Uptime epoch (10 min) | 0.05 Lux | 7.2 Lux/day (144 epochs) | 0.25 Lux |
| Task completed (Scheduler) | 5.0 Lux | -- | 25.0 Lux |
| API key contributed | 2.0 Lux | -- | 10.0 Lux |
| Proposal accepted | 5.0 Lux | -- | 25.0 Lux |
| Vote cast | 0.1 Lux | -- | 0.5 Lux |

**Early multiplier:** accounts 1-100 get 5x, 101-1000 get 3x, 1001-10000 get 2x, then 1x.

**Removed rewards:** Per-PING/QUERY message rewards (infinite farming vector), per-connection peer rewards (replay on restart).

### Key Economic Parameters

| Parameter | Value |
|---|---|
| Hard cap | 10,000,000,000 Lux |
| Relay fee | 0.1% per transfer (paid to relay node) |
| Network account | `NETWORK` (mints new Lux for verified work) |
| Daily cap | 500 Lux max per node per day |

### Content Revenue Sharing

| Recipient | Share | Rationale |
|---|---|---|
| Hosting node | 40% | Provides compute/storage/bandwidth |
| Building node | 40% | Created the content |
| Network treasury | 20% | Funds public services |

### Verification

Witness-based emission (Phase 12.1) -- peers must attest that work happened before Lux is minted. Requires 2+ witnesses for quorum. Bootstrap fallback for networks with fewer than 3 nodes.

### Payment Gating

`payment-gate.ts` implements cost estimation by tier:
- **Free tier:** Simple queries (search, status, balance checks)
- **Paid tier:** Task execution, project creation, compute-intensive queries
- **Escrow:** Lux held during execution, released on completion, refunded on failure

---

## How Users Interact

Users do not need to run a node. They connect via any gateway:

```
User (browser) -> Any Pando Gateway (web UI on any node)
  -> "Build me a portfolio website"
  -> Gateway creates task in P2P queue
  -> Some node claims it, spawns agent, does the work
  -> Result returned to user
  -> User pays Lux

User doesn't know or care:
  - Which node handled it
  - What agent type was used
  - Whether it was generated on the fly or cached
  - Whether it took 1 API call or 3 coordinated agents
```

### User Identity

`user-accounts.ts` provides:
- **Guest auto-creation** -- auto-generate Ed25519 keypair, no password required
- **Claimed accounts** -- username + password + encrypted private key backup
- **Session management** -- 7-day TTL, per-node tracking, async MongoDB-aware
- **Lux faucet** -- new guests receive welcome Lux (25 base x early multiplier)

### Big Task Decomposition (Projects)

For tasks like "Build me a social network":

```
1. Task enters queue: { description: "Build a social network", budget: 5000 Lux }

2. Manager sees: big task, vague -> designs multi-phase plan

3. Manager creates a PROJECT:
   Phase 1: Architecture
     - Task: "Design database schema" -> needs: database architect
     - Task: "Design API endpoints" -> needs: API architect

   Phase 2: Implementation (blocked by Phase 1)
     - Task: "Build user auth" -> needs: backend builder
     - Task: "Build news feed" -> needs: backend + algorithm specialist
     - Task: "Build frontend" -> needs: frontend builder

   Phase 3: NOT DEFINED YET
     - Manager notes: "Testing phase needed after implementation.
       Agent types TBD based on what gets built."

4. Phase 1 tasks enter queue -> nodes claim -> agents spawned dynamically

5. During Phase 2, manager evaluates results and creates follow-up tasks

6. Project adapts as it goes. Manager generates agent types
   that don't exist yet. System generates them on demand.
```

---

## Scaling Milestones

| Scale | What Breaks | What's Needed | Status |
|---|---|---|---|
| **2-5 nodes** | Nothing (works today for basic agent ops) | Fix docs, Scheduler + Planner, isolated workspaces | DONE |
| **3-5 nodes** | Rogue agent task floods, no authority model, race conditions | Manager architecture, worker lockdown, SQLite task queue, capability routing | DONE (Phase 19 prereqs) |
| **10 nodes** | JSON task queue I/O bottleneck, no task archival, GossipSub ordering | SQLite migration, task archival, logical timestamps, circuit breaker | DONE (Phase 19 prereqs + 19) |
| **50 nodes** | Manager split-brain on partition, no API auth, memory leaks | Manager lease model, signed API requests, Map size monitoring | DONE (Phase 19.8 + ongoing) |
| **100 nodes** | Planner bottleneck, GossipSub bandwidth saturation, clock skew | Profile scoring, topic priority, NTP enforcement, capability-based routing | DONE (Phase 19 + 20) |
| **500 nodes** | Manager registry too large, task queue grows unbounded, profile poisoning | SQLite task store, manager sharding, profile trust scoring | Phase 20+ |
| **1000+ nodes** | Governance cost, message volume, single-owner bottleneck per domain | Delegated voting, topic sharding, manager hierarchies, market-based routing | Future |

---

## Known Failure Modes at Each Scale

### 3-10 nodes (CURRENT)

- **AI API provider goes down** -> all tasks fail -> health monitor spam -> death spiral (no circuit breaker)
  - Mitigation: Circuit breaker (P4, DONE) pauses after 5 consecutive failures
- **Two nodes claim same task within clock-skew window** -> duplicate execution -> wasted credits
  - Mitigation: First-Claim-Wins (Phase 8.1, DONE) with timestamp tiebreak
- **Node crashes mid-write to tasks.json** -> total task state corruption (no WAL/journaling)
  - Mitigation: SQLite with WAL mode (P0, DONE)
- **Agent creates task via POST /tasks** -> bypasses all authority -> rogue agent cascade
  - Mitigation: Worker lockdown (Phase 19.2, DONE) blocks worker task creation

### 10-100 nodes

- **Manager on Node A goes down** -> Node B and C both try to host it -> split-brain -> duplicate tasks
  - Mitigation: Lease-based ownership (Phase 19.8, DONE) prevents dual hosting
- **GossipSub delivers "completed" before "claimed" to remote node** -> state machine confusion
  - Mitigation: TD-09 (OPEN) -- needs monotonic sequence numbers per task
- **500+ tasks in queue** -> every poll reads/writes entire file -> slow I/O blocks event loop
  - Mitigation: SQLite migration (P0, DONE)
- **Profile shared by malicious node with harmful system prompt** -> executes on trusting node
  - Mitigation: TD-15 (OPEN) -- needs profile sandboxing

### 100-1000 nodes

- **Every node subscribes to every GossipSub topic** -> bandwidth explosion
  - Mitigation: TD-13 (OPEN) -- needs topic priority/backpressure
- **Manager Registry replicated to all nodes** -> grows unbounded
  - Mitigation: Needs manager sharding (Future)
- **Governance votes from 1000 nodes** -> message storm on every proposal
  - Mitigation: Needs delegated voting (Future)
- **Clock skew >1s between nodes** -> some nodes always win First-Claim-Wins
  - Mitigation: TD-14 (OPEN) -- needs NTP enforcement

---

## Resource Types

Nodes declare capabilities as a dynamic `Set<string>`:

| Resource Type | Description | Earns Lux For |
|---|---|---|
| `relay` | Basic message relay + ledger sync | Uptime |
| `api_keys` | OpenAI/Gemini/etc API keys | AI task execution |
| `claude_code` | Claude Code runtime | Agent sessions |
| `compute_cpu` | CPU compute power | Task execution |
| `compute_gpu` | GPU compute power | ML/AI workloads |
| `storage` | Disk space for content hosting | Serving content |
| `gateway` | Web UI hosting | User access |
| `validator` | Transaction/emission validation | Verification work |
| `index` | Content/service indexing | Search queries |

**Key principle:** Capabilities are a bitmask, not a type. A node can offer multiple resource types simultaneously. A task may require capabilities from **multiple nodes** (e.g., API keys on node A, Claude Code on node B) -- the scheduler coordinates.

### Smart Error Correction

- **Auto-disable on failure:** If a resource fails (API rate limit, expired keys, Claude Code auth error, disk full), the scheduler automatically marks that capability as `degraded`. After N consecutive failures -> `disabled`.
- **Task reassignment:** When a task fails due to resource unavailability, the scheduler reassigns to the next capable node. Protocol: fail -> mark degraded -> find next capable -> reassign -> notify owner.
- **Owner notification:** When a resource is auto-disabled, the node operator sees it in TUI and Gateway.
- **User-declared vs verified:** Operator says "I have Claude Code" -- but if tasks keep failing, the system overrides to `disabled`. Trust but verify.

---

## The CEO's Role

The CEO is NOT a micromanager. It does not assign every task. The Manager + Scheduler handle that.

The CEO does strategic work:
- **Direction**: "We should focus on user growth this week"
- **Quality oversight**: "Too many failed tasks -- what's the pattern?"
- **Resource allocation**: "Node X is overloaded, rebalance"
- **Governance**: "Should we accept this new capability from the network?"
- **Network health**: "3 nodes went offline -- investigate"

The CEO is just another generated agent profile, but a persistent one that sleeps/wakes on events rather than being spawned per-task.
