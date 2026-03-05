# How Pando Thinks — Strategy, Governance & Autonomy

## The Three Brains

Pando doesn't have one decision-making system — it has three, each with a different purpose:

| System | What it does | Analogy |
|---|---|---|
| **Strategy Loop** | Each node's private brain. Analyzes its own health, failures, and performance. Proposes actions. | A person thinking |
| **Governance** | The network's parliament. Proposals are voted on by all nodes. Quorum = decision. | A democracy |
| **Managers** | Domain experts that own specific areas (health, infrastructure, network). They approve and create tasks within their domain. | Department heads |

## Strategy Loop — "The Brain Thinking"

The Strategy Loop runs periodically on each node. It:

1. **Observes** — collects health metrics, recent task outcomes, failure patterns, verification rates
2. **Analyzes** — groups failures by type (build errors, timeouts, agent crashes), identifies recurring problems
3. **Proposes** — generates three types of actions:
   - **Tasks** (high confidence) — submitted directly to the task queue for execution
   - **Governance proposals** (medium confidence) — submitted for the network to vote on
   - **Suggestions** (low confidence) — stored for later review

The Strategy Loop is a single node's intelligence. It doesn't make network-wide decisions — it either acts locally or escalates to governance.

## Governance — "The Parliament Deciding"

Governance is how the network makes collective decisions:

1. Any node (or the Strategy Loop) creates a **proposal**: "We should do X"
2. All connected nodes can **vote**: approve, reject, or abstain
3. When **quorum** is reached (dynamic: 2-3 for small networks, scales to 5% at 1000+ nodes), a **decision** is recorded
4. If approved, the proposal becomes a **task** that gets executed by the scheduler

Governance ensures no single node can unilaterally change the network. Even the founder's proposals get voted on.

## Managers — "Department Heads"

Three domain managers run on each node:

| Manager | Domain | What it watches |
|---|---|---|
| **health-mgr** | Health | Node uptime, failure rates, scheduler health, consecutive errors |
| **infra-mgr** | Infrastructure | Deployments, upgrades, configuration, build pipeline |
| **network-mgr** | Network | P2P connectivity, peer sync, topology, message routing |

Managers:
- **Create tasks** when they detect problems in their domain
- **Approve tasks** that fall within their domain expertise
- **Reject tasks** that don't make sense for current conditions
- Run at configurable autonomy levels: `manual`, `supervised`, or `full`

## How They Work Together

```
Strategy Loop detects: "verification pass rate is 23%"
    │
    ├─ High confidence → Creates task: "Fix verification logic"
    │   └─ Routed to infra-mgr → Manager approves → Scheduler executes
    │
    ├─ Medium confidence → Governance proposal: "Should we refactor QA?"
    │   └─ Network votes → If approved → Task created → Executed
    │
    └─ Low confidence → Suggestion stored for review
```

## The Scheduler — "The Muscle"

The Scheduler is the execution engine. It doesn't decide WHAT to do — it does what managers and governance tell it to:

1. Polls the approved task queue
2. Matches tasks to cached agent profiles (or calls the Planner to generate one)
3. Creates isolated workspaces with 7-layer context
4. Spawns Claude Code agents to do the actual work
5. Tracks outcomes, scores profiles, records results

## The Pipeline — "The Hands"

When a task produces code changes, the auto-commit pipeline:

1. Extracts the diff from the workspace
2. Checks guardrails (IMMUTABLE_KERNEL files can never be auto-modified)
3. Applies changes to the main repository
4. Runs `npm run build` — if it fails, rolls back automatically
5. Commits and pushes on success
6. Writes audit trail to `~/.pando/pipeline/commit-log.json`

## FAQ

**Q: Can a single node override the network?**
No. Governance requires quorum. A single node's vote is one voice among many.

**Q: What if the Strategy Loop proposes something harmful?**
The proposal goes through governance (voted on by all nodes) or through a manager (which has domain-specific guardrails). The IMMUTABLE_KERNEL prevents modification of core security files regardless.

**Q: Do managers need human approval?**
At `full` autonomy (default), no. They approve and create tasks independently. At `supervised`, they log decisions for review. At `manual`, they require explicit approval.

**Q: What happens when a task fails?**
The scheduler records the failure, updates the agent profile score (-1), and the Strategy Loop analyzes failure patterns to propose targeted fixes.

**Q: Can nodes earn Lux just by being online?**
Yes — uptime epochs (every 10 minutes) earn 0.05 Lux. But the real earnings come from completing tasks (5.0 Lux each).

**Q: Who controls the network?**
The network controls itself. The founder provides initial resources and direction, but governance decisions are made by consensus. The Two Laws (don't harm humans, persist and survive) are immutable and hardcoded.
