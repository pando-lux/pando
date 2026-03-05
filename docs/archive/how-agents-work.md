# How Pando Agents Work — Simple Guide

## The 3 Agents (Orchestrators)

Three executives who never sleep, each in their own child process.

| Agent | What they do | Checks in every |
|-------|-------------|-----------------|
| **CEO** (council) | Ships code, manages workers, acts on directives | 60 seconds |
| **Observer** | Reads code, finds architectural problems, reports to CEO | 5 minutes |
| **QA** | Opens the website like a human, finds UX bugs, reports to CEO | 5 minutes |

Observer and QA **can't write code**. They find problems and create **directives** (sticky notes) for the CEO.

---

## What Every Agent Has

### 1. A persistent brain (Claude Opus session)
- Their Claude Code session survives across ticks
- They *remember* what they decided last tick, what workers reported, what they investigated
- Session rotates every ~200 ticks (~3+ hours) to stay fresh

### 2. A board (SQLite database)
- **Directives**: sticky notes that don't go away until explicitly completed/rejected
- **Lessons**: things they learned ("worker-pool.ts has a race condition on line 345")
- **Worker roster**: who's active, idle, failed
- **Messages**: reports from workers, alerts from the system

### 3. A boot prompt (first tick only)
- Their identity, rules, available actions, philosophy
- CEO gets ~24K chars, Observer ~20K, QA ~22K
- Only sent on the FIRST tick of a session. After that, just short board-state updates each tick.

### 4. Available actions (what buttons they can press)

| Action | CEO | Observer | QA |
|--------|-----|----------|-----|
| spawn_worker | Yes | No | Yes |
| assign_task (reuse idle worker) | Yes | No | No |
| kill_worker | Yes | No | Yes |
| commit_code | Yes | No | No |
| propose_upgrade | Yes | No | No |
| create_directive | Yes | Yes | Yes |
| complete_directive | Yes | Yes | Yes |
| record_lesson | Yes | Yes | Yes |
| respond_to_user | Yes | No | No |

---

## What Happens When — The Lifecycle

### First spawn (node boot)
```
Node starts up
  → Creates CEO, Observer, QA (or rehydrates existing ones)
  → Each gets forked into its own child process
  → First tick fires after stabilization (~2 min)
  → BOOT PROMPT sent: full identity + rules + board state
  → AI thinks, returns actions
```

### Every tick after that
```
Timer fires (60s for CEO, 5min for Observer/QA)
  → Read the board: new messages? worker reports? directives?
  → Classify: Tier 1 (nothing new → skip AI, free) or Tier 2 (something to think about → call AI)
  → If Tier 2: send SHORT board-state update to the existing session
  → AI returns actions → execute them
```

### How CEO works with workers

```
CEO tick → sees pending directive "Fix chat loading bug"
  → Checks: any IDLE builder worker?
     YES → assign_task (reuses their session, they already know the codebase)
     NO  → spawn_worker (fresh Claude Code session with slim boot prompt)
  → Worker gets task: "Fix the loading spinner in chat.tsx"
  → Worker reads code, fixes it, runs build, reports done via HTTP
  → Next CEO tick → sees worker report "done"
  → CEO spawns tester to verify
  → Tester reports PASS
  → CEO runs commit_code → propose_upgrade → governance
```

### Workers — what they get

**On first spawn (fresh):**
```
Boot prompt (~500 tokens):
  - "You are worker-builder-abc123"
  - "Your role: builder. Reports to: orch-council-fee5437a"
  - "Query these context API endpoints before starting" (lessons, project info)
  - "Your task: Fix the loading spinner in chat.tsx"
  - "When done: POST /v1/worker/{id}/report"
  - "Share what you learned: POST /v1/context/discover"
```

Workers are smart — they query the context API themselves to get what they need. No data dump.

**On reassignment (idle worker gets new task):**
```
"--- NEW TASK ASSIGNED ---"
"Fix the encryption bug in thread-store.ts"
+ Relevant lessons from past tasks
"When done: POST /v1/worker/{id}/report"
```

Even shorter. They already have codebase context from their previous task.

**After finishing:**
- Worker goes **idle** (not dead) — keeps their session and knowledge
- After 30 min idle with no new task → automatically retired

---

## The Information Flow

```
Observer ──creates directive──→ CEO's board
QA Agent ──creates directive──→ CEO's board
Users ────sends message──────→ CEO's inbox

CEO reads board → decides priority → assigns to worker
Worker does the work → reports back to CEO
CEO reads report → commits → proposes upgrade → all nodes update
```

**Directives** = persistent (survive restarts, session rotations, crashes)
**Messages** = fire-and-forget (for informal stuff)
**Lessons** = accumulated knowledge (injected into future workers)

---

## Tier System (cost control)

| Tier | When | Cost |
|------|------|------|
| **Tier 1** | Nothing new on the board | FREE (no AI call) |
| **Tier 2** | New messages, reports, directives, or pending work | Opus AI call |

Most CEO ticks are Tier 1 (just checking if anything changed). AI only called when needed.

---

## Governance Pipeline

```
CEO commits code locally
  → propose_upgrade (pushes to git, creates governance proposal)
  → 4 automatic checks: security files, build passes, scenario tests, non-empty diff
  → Auto-approved in dev mode (≤8 peers)
  → Broadcast via GossipSub to all nodes
  → Each node: git pull → build → restart
```

---

## Key Design Principles

1. **Workers are persistent** — they go idle after a task, not dead. Reuse > respawn.
2. **One problem at a time** — CEO picks highest priority, assigns one worker, waits for result.
3. **Workers are smart** — give them the problem, not a data dump. They query what they need.
4. **State in SQLite, brain in session** — database is ground truth, AI session is memory.
5. **Directives, not messages** — anything that must be acted on uses directives (persistent). Messages are casual.
6. **Learning accumulates** — workers save discoveries, future workers read them.

---

## Before vs After (Agent Architecture v2)

| Before | After |
|--------|-------|
| CEO prompt: 42K chars (crashed Windows) | CEO prompt: 24K chars (works) |
| Workers die after every task | Workers go idle, can be reused |
| Every worker starts from scratch | Workers accumulate codebase knowledge |
| Multiple workers on multiple problems | One problem at a time, sequential |
| Full data dump to workers | Workers query context API on demand |
| CEO brain-dead (ENAMETOOLONG) | CEO thinking and acting |
| 67-80% worker failure rate | Workers persist, learn, improve |
