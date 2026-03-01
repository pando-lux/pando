# Living Operating Manual — Genome Evolution Architecture

> Directive for Council CEO: Review this architecture for feasibility. Implement what makes sense. Push back on what doesn't. This is a vision document — you decide the execution order.

## The Problem

Today, Pando's genome is a **static knowledge graph**. 90 nodes, 124 edges, 64 test scenarios — hand-written `.know` files compiled into `graph.json`. Workers and the council read it via GenomeBridge. It's useful but frozen. Every improvement requires a human editing `.know` files.

Meanwhile, the **lessons system** (193 entries in SQLite) captures real experience every tick. Workers discover patterns. The council extracts lessons from worker reports. But these lessons are:
- **Local only** — they don't propagate to other nodes
- **Unstructured** — free-text summaries with confidence scores
- **Disconnected** — lessons don't feed back into the genome

The genome has the structure but lacks live experience. The lessons have experience but lack structure. They need to converge.

## The Vision: Genome as Living Operating Manual

At scale (millions of nodes, multiple CEOs), the genome becomes the **collective memory of the entire network**. Every decision made by any CEO, every failure discovered by any worker, every pattern proven across multiple projects — all feed into a single, evolving knowledge base that every node can access.

Think of it as: **Wikipedia for AI operational knowledge**, except it's automatically curated, version-controlled, and propagated via governance.

## Three New Knowledge Categories

### 1. Decision Records (`genome/knowledge/decisions/`)

Every significant CEO decision gets recorded as a `.know` file:

```
decision BUILDER_RETRY_LIMIT_3 {
  context: "Builder failed 5 consecutive times on same task. Each retry consumed ~$2 in API credits with no progress."
  situation: "builder_consecutive_failures > 3"
  options_considered: [
    "Retry with modified prompt (chosen)",
    "Escalate to different approach",
    "Abort and report to user"
  ]
  chosen: "Retry limit of 3. After 3 failures: simplify scope, try different approach. After 5: abort with detailed error."
  outcome: "SUCCESS — reduced wasted retries by 60%. Failure resolution improved."
  confidence: 0.85
  date: "2026-03-01"
  source_lesson_id: "lesson-xxx"
  applicable_when: ["builder_failure", "retry_decision"]
}
```

**Why**: When a new CEO faces the same situation (builder failing repeatedly), it queries GenomeBridge for decisions matching `builder_failure` and finds this record. Instead of discovering the retry limit from scratch, it reads the prior decision, its outcome, and applies it immediately.

### 2. Workflow Templates (`genome/knowledge/workflows/`)

Recommended workflows for common scenarios:

```
workflow MULTI_FILE_CHANGE {
  trigger: "Code change affecting 3+ files or 2+ packages"
  required_roles: [builder, tester]
  optional_roles: [reviewer]

  sequence: [
    "1. Builder implements change",
    "2. Tester verifies (independent — gets ONLY task + diff, no builder context)",
    "3. If FAIL: builder gets failure details, retries (max 3)",
    "4. If PASS: commit_code → governance → upgrade"
  ]

  anti_patterns: [
    "NEVER skip tester for multi-file changes",
    "NEVER let builder self-review (confirmation bias)"
  ]

  evidence: "12 successful deployments followed this. 3 skipped tester → 2 had regressions."
  confidence: 0.9
}

workflow SINGLE_FILE_FIX {
  trigger: "Obvious bug fix in single file, <20 lines changed"
  required_roles: [builder]
  optional_roles: [tester]

  sequence: [
    "1. Builder implements fix",
    "2. If scenario tests exist for affected area: run them",
    "3. commit_code → governance → upgrade"
  ]

  evidence: "Single-file fixes with <20 lines have 95% first-pass success rate."
  confidence: 0.85
}

workflow DASHBOARD_OR_UI_CHANGE {
  trigger: "Gateway/frontend changes"
  required_roles: [builder]
  optional_roles: [tester]

  sequence: [
    "1. Builder implements UI change",
    "2. Build verification (npm run build passes)",
    "3. commit_code → governance → upgrade",
    "4. Verify deployed gateway reflects changes"
  ]

  anti_patterns: [
    "NEVER deploy frontend without build verification"
  ]
  confidence: 0.8
}
```

**Why**: The CEO currently decides ad-hoc whether to spawn a tester. With workflow templates, GenomeBridge returns "this scenario recommends builder + tester" and the CEO follows proven patterns rather than improvising.

### 3. Anti-Patterns (`genome/knowledge/anti-patterns/`)

Things that went wrong, documented permanently:

```
anti_pattern TASKKILL_ALL_CLAUDE {
  description: "Running taskkill /IM claude.exe kills the caller's own Claude Code session"
  discovered: "2026-02-28"
  severity: "critical"
  symptoms: ["All Claude sessions die including the one running the command"]
  correct_approach: "Kill specific PIDs, never use /IM claude.exe globally"
  times_encountered: 2
}

anti_pattern PUSH_TO_ARRAY_VIA_P2P {
  description: "storageBackend.pushToArray() fails silently when routed through P2P storage proxy"
  discovered: "2026-02-28"
  severity: "high"
  symptoms: ["Array fields stay empty while scalar counters increment"]
  correct_approach: "Use read-modify-write pattern: getRecord → mutate → putRecord with $set"
  fix_commit: "7ce9a282"
}
```

## The Promotion Pipeline

```
Experience (per-tick)
    │
    ▼
┌─────────────┐
│   Lessons    │  SQLite lessons table (193+). Local only.
│   (local)    │  Confidence 0.0-1.0. Auto-extracted from worker reports.
└──────┬──────┘
       │ Promotion criteria:
       │  - Used 3+ times successfully
       │  - Confidence > 0.7
       │  - Consistent across multiple projects
       ▼
┌─────────────┐
│ Org Knowledge│  SQLite org_knowledge table. Local only.
│   (local)    │  Higher confidence. Promoted by reflectOnCompletion().
└──────┬──────┘
       │ Promotion criteria:
       │  - Validated across 5+ tasks
       │  - No contradicting evidence
       │  - CEO explicitly approves promotion
       ▼
┌─────────────┐
│   Genome     │  .know files in git. Propagated via governance.
│   (global)   │  Compiled → graph.json → all nodes via upgrade.
└──────┬──────┘
       │ Propagation:
       │  commit_code → propose_upgrade → governance vote
       │  → all nodes git pull → genome recompile
       ▼
┌─────────────┐
│ All Nodes    │  Every CEO on every node reads the same graph.json.
│  (network)   │  Identical operating manual everywhere.
└─────────────┘
```

### How Promotion Works (Implementation)

The CEO should periodically (every 10-20 ticks) do a **knowledge audit**:

1. Query `lessons` table: find lessons with `confidence > 0.7` AND `use_count >= 3`
2. Check if an equivalent `.know` entry already exists (via GenomeBridge search)
3. If not: spawn a builder to create the `.know` file in the appropriate category
4. commit_code → governance → upgrade → all nodes get the new knowledge

This is a `record_lesson` action with promotion logic. The CEO already has `record_lesson` — it just needs the promotion step.

## The Consult-Before-Act Loop

**This is the key behavioral change.** Before returning actions on Tier 2 ticks, the CEO should:

```
1. Classify the situation (what type of decision is this?)
2. Query GenomeBridge: "What workflows apply to this situation?"
3. Query GenomeBridge: "What past decisions match this context?"
4. Query GenomeBridge: "What anti-patterns should I avoid?"
5. Factor the results into the action decision
6. If the decision is novel (no matching workflows/decisions): proceed, then record the outcome
```

This is NOT a code change to orchestrator.ts. It's a **prompt instruction** in the CEO boot prompt. The CEO already has tool access to read files — it can read `.know` files or query GenomeBridge endpoints.

Add to the CEO boot prompt:
```
## Decision Protocol

Before taking any Tier 2 action:
1. Check genome/knowledge/workflows/ for applicable workflow templates
2. Check genome/knowledge/decisions/ for prior decisions in similar contexts
3. Check genome/knowledge/anti-patterns/ for known failure modes
4. Follow proven workflows when they exist. Only improvise when no template matches.
5. After novel decisions: record_lesson with the outcome for future reference.
```

## Scaling to Millions of Nodes

### Phase 1: Single CEO (now)
- One council orchestrator on one node
- Lessons local, genome in git
- Governance propagates genome changes to all nodes

### Phase 2: Multiple CEOs (next)
- Each capable node runs its own council orchestrator
- CEOs share the same genome (via git)
- Local lessons diverge, but promoted lessons converge into genome
- Governance is the consensus mechanism: a CEO proposes a genome update, other CEOs vote

### Phase 3: CEO Specialization (future)
- CEOs specialize by domain: infrastructure CEO, security CEO, app-building CEO
- Genome has domain-specific sections
- Cross-domain decisions require multi-CEO governance (proposal + vote)
- Decision records include which CEO role made the decision

### Phase 4: Federated Knowledge (long-term)
- Clusters of nodes form "knowledge federations"
- Each federation has its own genome fork
- Federations exchange proven knowledge via P2P
- Anti-patterns propagate network-wide instantly (safety critical)
- Workflow templates propagate after validation threshold

### The Key Insight

**The genome IS the operating manual. Git IS the distribution mechanism. Governance IS the quality filter.**

No new infrastructure needed. The pieces already exist:
- `.know` files → git → governance → all nodes (genome pipeline)
- Lessons → confidence scoring → promotion (existing lesson system)
- GenomeBridge → `contextForTask()` (existing API)
- Decision records → just a new `.know` category
- Workflow templates → just a new `.know` category

The only new thing is the **behavioral pattern**: CEOs consult the genome before acting, and feed their experience back into it.

## Immediate Next Steps (for CEO)

1. **Create the directories**: `genome/knowledge/decisions/`, `genome/knowledge/workflows/`, `genome/knowledge/anti-patterns/`
2. **Seed with known decisions**: The genome already has 7 `decision` blocks in `council-operating-system.know`. Extract them into individual files in `decisions/`.
3. **Seed with known workflows**: Document the builder→tester→commit pipeline as a formal workflow template.
4. **Seed with known anti-patterns**: The `p2p-storage-array-writes.know` pattern is essentially an anti-pattern. Add the taskkill one.
5. **Add decision protocol to CEO prompt**: The consult-before-act instructions.
6. **Add promotion logic**: Every 20 ticks, check for promotable lessons. This can be a directive first, then hardcoded later.

## What This Enables

- **New nodes bootstrap with full operational knowledge** — clone repo, genome is there
- **CEOs never repeat mistakes** — anti-patterns are permanent
- **Proven workflows are followed consistently** — not ad-hoc improvisation
- **The system gets smarter with every deployment** — experience feeds back
- **Scaling is natural** — more CEOs = more experience = richer genome = better decisions for everyone
- **No central authority** — governance filters quality, git distributes, every node contributes

## What This Does NOT Change

- The tick loop (setInterval, ticking guard, tier classification)
- The action execution engine (spawn_worker, commit_code, propose_upgrade)
- Worker spawn/resume mechanics
- Message bus routing
- The Two Laws
- The upgrade protocol
- Governance mechanism

This is purely additive. New `.know` categories + a behavioral change in the CEO prompt.

---

*Document created 2026-03-01. Send to council as directive for review and implementation.*
