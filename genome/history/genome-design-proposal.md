# Project Genome — Design Document

> Created: 2026-02-18
> Status: DESIGN PHASE — Not yet implemented
> Author: Jai + CEO brainstorm
> Goal: Universal, AI-maintained, living knowledge system for any project

---

## The Problem

Every documentation system fails because it's disconnected from the thing it documents. The moment you write a doc, it starts dying.

| System | What it captures | Why it fails |
|---|---|---|
| README/Wiki | Architecture overview | Goes stale in days. Nobody updates it. |
| Code comments | Implementation details | Coupled to code, incomplete, lies after refactors |
| Swagger/OpenAPI | API surface | Only covers endpoints, misses WHY |
| Jira/Linear | Tasks | Tracks WORK, not KNOWLEDGE |
| Confluence/Notion | Everything | Human-maintained = guaranteed drift |
| Architecture diagrams | Structure | Static snapshot, never updated |
| ADRs | Decisions | Captures WHY but not WHAT or current STATE |

Root cause: humans hate updating docs. And even if they did, they can't keep up when 10+ agents modify code simultaneously.

---

## The Solution: Project Genome

A **living, structured, AI-maintained knowledge graph** that IS the single source of truth for any project. Not a document — a **model** of the project that generates documents.

### What Makes It Different

1. **AI-maintained** — a dedicated agent watches code changes and updates the genome
2. **Structured + freeform** — machine-parseable metadata (for agents to query) + human-readable content (for people to understand)
3. **Cross-referenced** — components link to each other. When A changes, everything that depends on A gets flagged.
4. **Scoped views** — an agent working on the Scheduler gets ONLY relevant context, not the whole project
5. **Living state** — not just "how it was designed" but "what's happening right now"
6. **Universal** — same structure works for code, buildings, businesses, anything

### The Five Primitives

Every project can be described with 5 things:

```
GENOME
├── COMPONENTS — What exists (services, files, teams, rooms, machines)
├── FLOWS — What happens (pipelines, workflows, data paths, user journeys)
├── RULES — What must hold (constraints, invariants, gotchas, laws)
├── STATE — What's true right now (health, active work, issues, versions)
└── HISTORY — What changed (decisions, commits, events, who did what)
```

**A calculator app:**
- Components: UI, Calculator Engine, Display
- Flows: User presses button → Engine computes → Display updates
- Rules: Division by zero shows "Error"
- State: Version 1.2, 100% test coverage
- History: v1.1 added scientific mode

**Apple's iPhone division:**
- Components: Hardware team, iOS team, App Store, Supply chain, 500 sub-teams...
- Flows: Product spec → Design → Engineering → QA → Manufacturing → Launch
- Rules: Privacy first, no sideloading, accessibility required
- State: iPhone 17 in engineering phase, 2,400 active tasks
- History: Decision log, org changes, architecture pivots

Same five primitives. Just different depth.

---

## The Format

```
project-genome/
├── genome.yaml              ← Root: project identity + component registry
├── components/
│   ├── manager.md           ← Structured frontmatter + freeform details
│   ├── scheduler.md
│   ├── gateway.md
│   └── ...
├── flows/
│   ├── task-execution.md    ← Step-by-step with component references
│   ├── user-onboarding.md
│   └── ...
├── rules/
│   ├── authority-model.md   ← Invariants that must NEVER be violated
│   ├── two-laws.md
│   └── ...
├── state.md                 ← Auto-updated: health, tasks, issues, versions
└── history/
    ├── decisions.md         ← Architecture Decision Records
    └── changelog.md         ← Auto-generated from git
```

### Component File Example

```markdown
---
id: scheduler
type: service
entry: packages/node/src/scheduler.ts
depends_on: [task-queue, workspace-manager, profile-cache]
depended_by: [manager, orchestrator]
exposes:
  - receiveApprovedTask()
  - getStatus()
  - onTaskResult()
rules: [authority-model, worker-isolation]
last_verified: 2026-02-18
verified_by: genome-agent
test_ids: [S1, S2, S3, S4, S5, S6, S7, S8]
---

# Scheduler

## What It Does
Pure executor. Receives approved tasks, spawns workers, collects results.

## How It Works
1. Manager calls receiveApprovedTask(taskId, managerId)
2. Scheduler dequeues, creates workspace, spawns Claude Code worker
3. Worker writes output to workspace
4. Scheduler emits task_completed/task_failed event
5. Manager receives event, decides next step

## Gotchas
- NEVER calls Planner (Manager does planning)
- NEVER auto-approves siblings
- Workers MUST have --dangerously-skip-permissions flag

## Tests
| ID | Test | Status | Last Run |
|---|---|---|---|
| S1 | Receives approved task | UNTESTED | — |
| S2 | Spawns worker correctly | UNTESTED | — |
```

---

## The Genome Agent

A dedicated Claude Code agent that maintains the genome.

### Watches
- Git diffs — what files changed?
- Maps changed files → affected genome components
- Checks: does the genome still match reality?

### Auto-fixes
- File renames → update `entry:` fields
- New exports → update `exposes:` lists
- Dependency changes → update `depends_on:` / `depended_by:`
- Test results → update test status tables
- Deployment events → update `state.md`

### Flags (can't auto-fix)
- "Scheduler.ts now calls Planner — but rule `authority-model` says it shouldn't."
- "Component `payment-gate` has no tests."
- "Flow `task-execution` references deprecated component `planner`."
- "3 components haven't been verified in 7 days."

### Generates Scoped Context
Agent assigned to work on Scheduler? Genome agent generates:
- Scheduler component doc
- TaskQueue component doc (dependency)
- WorkspaceManager component doc (dependency)
- Authority-model rule
- Worker-isolation rule
- Recent changes affecting these components
- Known issues
= Perfect context. No noise. No missing info.

---

## Solving the 1000-Agent Problem

When 1000 agents work on a massive project:

1. **Before work:** Agent reads scoped genome view (minutes, not hours)
2. **During work:** Agent follows documented flows (knows the pipeline)
3. **After work:** Genome agent detects diff, updates affected components, flags broken cross-references
4. **Conflict detection:** If Agent A changes X and Agent B changes Y (depends on X) — genome flags before it breaks
5. **Drift prevention:** Genome agent runs periodic verification: code vs genome. Mismatch → fix or flag.

---

## Pando Network Service

Not just for Pando's codebase — a service any project can use:

- **Node operators run genome agents** — earn Lux for maintenance
- **Project owners pay Lux** — for genome creation, maintenance, scoped context
- **Agents pay Lux** — for genome queries (paying for context)
- **New projects get genome scaffold** — AI analyzes codebase, generates initial genome
- **Cross-project genomes** — Project A depends on Project B's API → genome tracks that

The genome IS the context layer for the decentralized internet.

---

## Novel Features (Not Seen Elsewhere)

| Feature | Exists today? | Our version |
|---|---|---|
| Structured docs | Yes (Swagger, JSDoc) | Universal (not code-only) |
| Knowledge graphs | Yes (Neo4j, Obsidian) | AI-maintained, not human-curated |
| Living docs | Yes (Storybook, Docusaurus) | Auto-updated from code changes |
| Architecture models | Yes (C4, ArchiMate) | Includes LIVE STATE, not just design |
| Scoped context | No | Perfect context per-agent per-task |
| Cross-reference validation | Partial | Semantic: "rule violated by code change" |
| Drift detection | No | AI compares genome vs reality |
| Multi-agent coordination | No | 1000 agents, scoped views, conflict detection |

---

## Additional Ideas

1. **Genome versioning** — "what did this project look like 3 months ago?"
2. **Genome diff** — "what changed architecturally this week?"
3. **Onboarding score** — "how complete is this genome?" Percentage of components documented, tested, verified
4. **Genome templates** — "I'm starting a Next.js app" → pre-populated genome
5. **Dependency genome linking** — "My project uses Stripe" → link to Stripe's public genome
6. **Genome queries** — natural language: "What handles authentication?" → scoped view
7. **Genome-guided code review** — "This PR touches scheduler.ts. Genome says: depends_on [task-queue]. Checking... SAFE."

---

## Implementation Plan

### Phase 1: Pando Dogfood
Convert existing ARCHITECTURE-PLAN.md, CLAUDE.md, MANAGER-INTELLIGENCE.md, TEST-TRACKER.md into proper genome format. Use it ourselves. Fix rough edges.

### Phase 2: Genome Agent
Build the AI maintenance agent that watches diffs, updates genome, flags drift.

### Phase 3: Scoped Context Generator
Replace current context assembly (manager-context.ts) with genome-powered context generation.

### Phase 4: Network Service
Generalize into a Pando network service. Any project can create/maintain a genome. Agents query genomes for context.

---

## Open Questions (Jai's, 2026-02-18)

1. How does the current bible (ARCHITECTURE-PLAN.md) map into genome? Where do marketing, code updates, gotchas go?
2. Will this help CEO brainstorm better with better context?
3. Will genome get too heavy at top-level-only?
4. Will docs still drift, or does an agent update genome with every change?
5. Which module talks to what — genome captures that?

(Answers in conversation — to be added here after discussion)
