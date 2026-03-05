# Agent Architecture v2 — Unified Persistent Agents

> **For**: CEO (council orchestrator) to implement
> **Priority**: CRITICAL — CEO is currently brain-dead (ENAMETOOLONG)
> **Scope**: ai-backend-claude.ts, orchestrator.ts, worker-pool.ts
> **Phases**: 3 phases, each independently deployable

---

## The Problem

### 1. CEO is brain-dead right now

```
[Orchestrator orch-council-fee5437a] Boot tick — full prompt (41,875 chars)
[Orchestrator orch-council-fee5437a] AI call failed: spawn ENAMETOOLONG
```

The entire prompt is passed as a **command-line argument** to `claude -p`
(ai-backend-claude.ts line 96). Windows limits CLI args to 32,767 chars.
CEO's boot prompt is 41,875 chars. Every tick fails. CEO cannot think.

QA and Observer work because their prompts are ~17K (under the limit).

### 2. CEO prompt is bloated

41K chars broken down:

```
~15K  Static instructions (identity, rules, actions, pipeline)
      → Only needed on FIRST boot tick. Session remembers after that.
      → But session never establishes because first tick always fails.

~8K   16 directives × FULL TEXT dumped inline
      → CEO just needs: "D#93 [CRITICAL] Guest chat broken"
      → 40 chars instead of 500 per directive

~5K   23 workers listed with rolePrompt snippets
      → CEO just needs: "0 active, 7 done, 16 failed"

~5K   Genome architecture context
      → Workers can read code themselves. They're Opus.

~4K   Failed worker history with task descriptions
      → CEO just needs: "builders failed 4x, testers failed 5x"

~4K   Decision guide, lessons, org knowledge
      → Most is static, only needed once
```

### 3. Workers are disposable (wasteful)

Current flow:
```
CEO decides "fix chat bug"
  → Spawns FRESH builder (new Claude session)
  → Builder reads entire codebase from scratch (~5 min)
  → Builder fixes one bug
  → Builder marked "done" and ABANDONED forever
CEO decides "fix wallet bug"
  → Spawns ANOTHER fresh builder
  → New builder reads entire codebase from scratch AGAIN
  → Same 5 min wasted learning the same code
```

23 workers created. Each one used once. Each one rediscovered the same
codebase. That's 23× the research cost for work that could reuse context.

### 4. Architecture doesn't scale

With 100 workers:
- CEO prompt would be 200K+ chars (100 workers × 200 chars roster)
- Fresh spawn per task = 100× codebase research overhead
- No specialization — every builder starts from zero

---

## Core Insight

**Workers and orchestrators are the same thing.**

Both are Claude Opus sessions. Both can read files, think, and decide.
The only differences:

| | Orchestrator | Worker (current) |
|---|---|---|
| Trigger | Tick loop (every 60s) | One-shot (spawn, run, die) |
| Session | Persistent (200 ticks) | Disposable (cleared after each task) |
| Memory | Lessons, board state, inbox | Nothing persists |
| Communication | MessageBus (SQLite-backed) | HTTP report, then gone |

But WHY? A builder who fixed 3 bugs in thread-store.ts is an EXPERT
on that module. Why throw away that expertise after every task?

**The fix: workers become persistent agents.** Same communication pattern
as orchestrators (inbox, board, lessons). Spawned when needed, not on a
tick loop. Stay alive between tasks. Accumulate expertise.

CEO becomes a lean dispatcher — picks one problem, routes to the right
agent, waits for result. No 41K dumps. No genome injections.

---

## The New Architecture

### Mental Model

```
CEO (coordinator)
  │
  ├── "Fix chat encryption" → sends message to Builder-A
  │     Builder-A already knows core/ from last task
  │     Fixes it in 2 min (not 10)
  │     Reports done
  │
  ├── "Verify chat works" → sends message to Tester-A
  │     Tester-A already has Playwright set up
  │     Tests it, reports PASS
  │
  ├── CEO commits, proposes upgrade
  │
  └── "Fix wallet display" → sends message to Builder-A (same one!)
        Builder-A already knows the codebase
        Different module but same project — fast context switch
```

### Agent Lifecycle

```
SPAWNED → ACTIVE → IDLE → ACTIVE → IDLE → ... → KILLED

  Spawned: CEO creates agent for a role (builder, tester, etc.)
           Gets minimal boot prompt: identity + role template + "read inbox"
  Active:  Working on a task (CEO sent message to inbox)
  Idle:    Task done, waiting for next assignment
           Session preserved. Context retained. Expertise grows.
  Active:  CEO sends new task to inbox
           Resume session with: "New task in your inbox. Read it."
  Killed:  Idle too long (30 min) or CEO explicitly kills
```

### Communication (same as orchestrators)

```
CEO → MessageBus → Worker inbox
  "Fix encryption bug in thread-store.ts. Error: point expected."

Worker → MessageBus → CEO inbox
  "Fixed. Changed decryptMessage() to handle missing keys. 3 files changed."

Worker → Lessons DB
  "thread-store.ts uses AES-256-GCM with Ed25519-derived keys"
  → Next task in this module benefits from this knowledge
```

### What CEO Sees Each Tick

Instead of 41K chars:

```
--- TICK UPDATE (tick 2261, 2026-03-01T18:45:00Z) ---

## Active Agents
- Builder-A: ACTIVE on D#93 (chat encryption fix), 3 min elapsed
- Tester-A: IDLE (last task: wallet page test, 12 min ago)

## Inbox (1 new)
- Worker report from Builder-A: "Fixed. 2 files changed."

## Pending Directives (16 total, showing top 3)
- D#93 [CRITICAL] Guest chat encryption broken
- D#95 [HIGH] Wallet shows remote-peer as public key
- D#97 [HIGH] Credential proxy zero access control

Full directive text: GET /v1/directives/:id
```

That's ~500 chars. CEO is Opus — it knows what to do.

---

## Implementation

### Phase 1: Unblock CEO (IMMEDIATE — do this first)

**File: `packages/node/src/core/ai-backend-claude.ts`**

Problem: Prompt passed as CLI arg (line 96). Fix: pipe via stdin.

```typescript
// BEFORE (line 94-96):
args.push('--', task.prompt);

// AFTER:
// Don't put prompt in args. Pass via stdin after spawn.
// (remove line 96 entirely)
```

```typescript
// BEFORE (line 108):
stdio: ['ignore', 'pipe', 'pipe'],

// AFTER:
stdio: ['pipe', 'pipe', 'pipe'],  // stdin = pipe, not ignore
```

```typescript
// AFTER spawn (add after line 110, before the onPid call):
// Write prompt to stdin (no CLI length limit)
if (child.stdin) {
  child.stdin.write(task.prompt);
  child.stdin.end();
}
```

That's it. 3 lines changed. CEO can think again. No CLI length limits ever.

**Also in Phase 1 — slim the boot prompt while we're at it:**

**File: `packages/node/src/platform/orchestrator.ts`**

In `appendBoardState()` (line 1164), change directive rendering:

```typescript
// BEFORE (line 1303):
sections.push(`- [D#${d.id}]${seen}${overdue}: ${d.content}`);

// AFTER — one-line summary only:
const summary = d.content.replace(/\n/g, ' ').slice(0, 120);
sections.push(`- [D#${d.id}]${seen}${overdue}: ${summary}...`);
sections.push(`  Full text: GET /v1/directives/${d.id}`);
```

In team roster (line 1191), cap to active + recent only:

```typescript
// BEFORE: shows all workers from last 2 hours
const rosterWorkers = allTeamWorkers.filter(w => {
  if (w.status === 'active') return true;
  if ((w.updatedAt || w.createdAt || '') >= fifteenMinAgo2) return true;
  return (w.createdAt || '') >= twoHoursAgo;
});

// AFTER: active workers + summary counts only
const activeWorkers = allTeamWorkers.filter(w => w.status === 'active');
const idleWorkers = allTeamWorkers.filter(w => w.status === 'idle');
const recentDone = allTeamWorkers.filter(w =>
  w.status === 'done' && (w.updatedAt || '') >= fifteenMinAgo2
);
const failedCount = allTeamWorkers.filter(w => w.status === 'failed').length;

if (activeWorkers.length > 0 || idleWorkers.length > 0) {
  sections.push('## Your Agents');
  sections.push(`Active: ${activeWorkers.length}, Idle: ${idleWorkers.length}, Recently done: ${recentDone.length}, Failed: ${failedCount}`);
  for (const w of activeWorkers) {
    sections.push(`- ${w.role} ${w.id}: ACTIVE — ${(w.rolePrompt || '').slice(0, 80)}`);
  }
  for (const w of idleWorkers) {
    sections.push(`- ${w.role} ${w.id}: IDLE (available for new task)`);
  }
}
```

In genome context injection (line 1349), skip for council/observer:

```typescript
// BEFORE: always injects genome context
if (activeGenomeBridge?.isLoaded()) {

// AFTER: skip for system orchestrators (they don't need architecture dumps)
if (activeGenomeBridge?.isLoaded() && agent.projectId) {
```

**Expected result:** CEO boot prompt drops from 41K → ~12K. Tick updates
stay at ~2K. Both well under any limit. And stdin piping means no limit
even if it grows.

---

### Phase 2: Persistent Workers

Workers don't die after one task. They go idle and wait for the next assignment.

**File: `packages/node/src/core/worker-pool.ts`**

**a) Don't clear sessionId on completion (line 345):**

```typescript
// BEFORE:
this.db.updateAgent(workerId, { sessionId: null });

// AFTER:
// Keep sessionId — worker can be resumed for next task
this.db.updateAgent(workerId, { status: 'idle' });
// Don't clear sessionId
```

**b) Add `assignTask()` method — send task to idle worker:**

```typescript
/**
 * Assign a new task to an idle worker by resuming its session.
 * The worker already has codebase context from previous tasks.
 */
async assignTask(workerId: string, task: string): Promise<void> {
  const worker = this.db.getAgent(workerId);
  if (!worker || worker.status !== 'idle') {
    throw new Error(`Worker ${workerId} is not idle (status: ${worker?.status})`);
  }

  // Update status
  this.db.updateAgent(workerId, { status: 'active', rolePrompt: task });

  // Resume worker session with short task prompt
  const prompt = `New task assigned. Here are your instructions:\n\n${task}\n\nWhen done, report via POST /v1/worker/${workerId}/report`;

  const backend = this.deps.aiRegistry.getBest('code-execution');
  const result = await backend.execute({
    type: 'code',
    prompt,
    sessionId: worker.sessionId,  // Resume existing session!
    options: {
      cwd: worker.workspaceDir || this.repoDir,
      model: 'claude-opus-4-6',
    },
  });

  // Handle completion same as fresh spawn
  this.handleWorkerCompletion(workerId, result);
}
```

**c) Add `findIdleWorker()` — find reusable worker:**

```typescript
/**
 * Find an idle worker matching the requested role.
 * Prefers workers that have worked on similar modules before.
 */
findIdleWorker(role: string, orchestratorId: string): AgentIdentity | null {
  const workers = this.db.listAgents({
    type: 'worker',
    role,
    parentId: orchestratorId,
    status: 'idle',
  });
  if (workers.length === 0) return null;

  // Sort by most recently active (freshest context)
  workers.sort((a, b) =>
    (b.updatedAt || '').localeCompare(a.updatedAt || '')
  );
  return workers[0];
}
```

**d) Idle timeout reaper — kill workers idle too long:**

```typescript
// In the existing reaper (line 103), add:
const idleTimeout = 30 * 60 * 1000; // 30 min
const idleWorkers = this.db.listAgents({ type: 'worker', status: 'idle' });
for (const w of idleWorkers) {
  const idleSince = new Date(w.updatedAt || w.createdAt || 0).getTime();
  if (Date.now() - idleSince > idleTimeout) {
    this.db.updateAgent(w.id, { status: 'done' });
    console.log(`[WorkerPool] Retired idle worker ${w.id} (idle ${Math.round((Date.now() - idleSince) / 60000)}min)`);
  }
}
```

**File: `packages/node/src/platform/orchestrator.ts`**

**e) Add `assign_task` action for CEO:**

```typescript
// In OrchestratorAction union type, add:
| { type: 'assign_task'; workerId: string; task: string }

// In executeActions(), add case:
case 'assign_task': {
  await this.deps.workerPool.assignTask(action.workerId, action.task);
  break;
}
```

**f) Update CEO boot prompt to explain persistent workers:**

Add to the council section of buildBootPrompt():

```
## WORKER MANAGEMENT

Workers are PERSISTENT. They don't die after one task.

REUSE first, spawn only if needed:
1. Check "Your Agents" for IDLE workers matching the role you need
2. If idle worker exists: assign_task to reuse their session + context
3. If no idle worker: spawn_worker (creates fresh session)

Workers accumulate expertise. A builder who fixed thread-store.ts
already understands that module. Reuse it for the next thread-store task.

One problem at a time:
- Pick highest priority directive
- Assign to ONE worker
- Wait for result
- Commit if good, retry if bad
- THEN pick next directive
```

**g) Update board state to show idle workers (already done in Phase 1 slim).**

---

### Phase 3: Workers Save Expertise (Continuous Improvement)

Workers record lessons about the modules they work on. Future tasks in the
same module benefit from accumulated knowledge.

**File: `packages/node/src/core/worker-pool.ts`**

**a) Worker boot prompt tells workers to save lessons:**

In `buildBootPrompt()`, add:

```
## LEARNING

After completing each task, record what you learned about the code:
- POST /v1/context/discover with category, content, confidence
- Focus on: file purposes, design patterns, gotchas, dependencies
- This knowledge helps you (and other workers) on future tasks

Example: POST /v1/context/discover
{
  "projectId": "__pando__",
  "category": "module:thread-store",
  "content": "thread-store.ts uses AES-256-GCM. Keys derived from Ed25519 via X25519 DH. Guest threads have no encryption.",
  "confidence": 0.9
}
```

**b) Worker resume prompt includes relevant lessons:**

When resuming an idle worker via `assignTask()`, include recent lessons:

```typescript
// In assignTask(), before building the resume prompt:
const lessons = this.db.getLessons({
  orchestratorId: worker.parentId,
  limit: 5,
});
const lessonText = lessons.length > 0
  ? '\n\nRelevant lessons from past tasks:\n' +
    lessons.map(l => `- ${l.lesson}`).join('\n')
  : '';

const prompt = `New task assigned.${lessonText}\n\n${task}\n\nWhen done, report via POST /v1/worker/${workerId}/report`;
```

**c) Template evolution — workers can suggest improvements:**

Workers can update their role template based on experience. Add to boot prompt:

```
## TEMPLATE UPDATES

If you discover something that ALL future workers in your role should know,
report it as a template suggestion:

POST /v1/worker/{workerId}/report
{
  "status": "done",
  "summary": "Fixed encryption bug",
  "templateSuggestion": "Always check for null encryption keys before calling decrypt()"
}
```

CEO reads template suggestions and decides whether to update the role
template in template-registry.ts. This makes future workers smarter
without needing code changes.

---

## What Changes, What Stays

| Component | Change |
|---|---|
| **ai-backend-claude.ts** | Pipe prompt via stdin (3 lines) |
| **orchestrator.ts boot prompt** | Slim to ~12K: summary counts, one-line directives, no genome dump |
| **orchestrator.ts actions** | Add `assign_task` action |
| **orchestrator.ts board state** | Show active + idle workers, not full 2hr roster |
| **worker-pool.ts lifecycle** | Workers go idle instead of dying. `assignTask()` resumes session. |
| **worker-pool.ts boot prompt** | Add learning instructions |
| **worker-pool.ts reaper** | Add 30min idle timeout |
| **MessageBus** | No change — already supports worker ↔ orchestrator messaging |
| **AgentDatabase** | No schema change — `status: 'idle'` is a new value but same column |
| **OrchestratorProcessManager** | No change — IPC `spawn_worker` still works, just add `assign_task` |
| **Orchestrator class** | No structural change — same tick loop, same AI call pattern |

---

## Expected Outcomes

### Immediate (Phase 1)
- CEO can think again (stdin piping, no CLI limit)
- Boot prompt: 41K → ~12K chars
- Tick updates: ~2K chars (unchanged)
- CEO starts processing the 16 pending directives

### Short-term (Phase 2)
- Workers reused across tasks (2-3 persistent workers instead of 23 disposable)
- Codebase research done once per worker, not once per task
- CEO assigns tasks with short messages, not full context dumps
- One problem at a time — sequential, focused, no merge conflicts

### Long-term (Phase 3)
- Workers accumulate module expertise via lessons
- Templates evolve based on worker experience
- New workers start smarter (lessons from past workers)
- System gets better at every module over time
- Scales to 100 workers without prompt bloat

### The ENAMETOOLONG problem
**Solved permanently by design.** Prompts are always small because:
- Boot prompts are lean (identity + role + "read inbox")
- Tasks come via database messages (not CLI args)
- Context accumulates in session (not dumped every tick)
- Stdin piping as safety net (no OS limit on pipe size)

---

## Verification

After each phase, verify:

**Phase 1:**
- `npm run build` — zero errors
- Start node — CEO prompt logged as <15K chars
- CEO tick succeeds (no ENAMETOOLONG)
- CEO starts processing directives
- QA and Observer unaffected

**Phase 2:**
- Spawn a builder — does task — goes idle (not done)
- CEO assigns new task to same idle builder — builder resumes
- Builder completes second task faster (already has context)
- Idle worker killed after 30 min of no tasks
- Worker count stays low (2-3 persistent, not 23 disposable)

**Phase 3:**
- Worker records lesson after completing task
- Same worker receives task in same module — lesson is in context
- New worker in same role gets lessons from previous workers
- Template suggestion appears in CEO's board state

---

## Implementation Order

1. **Phase 1A**: stdin fix in ai-backend-claude.ts (3 lines — unblocks everything)
2. **Phase 1B**: Slim boot prompt (directive summaries, roster counts, skip genome)
3. **Phase 2A**: Worker idle state (don't clear sessionId, add idle status)
4. **Phase 2B**: assign_task action + findIdleWorker
5. **Phase 2C**: CEO prompt update (explain persistent workers, reuse-first)
6. **Phase 3A**: Worker learning instructions in boot prompt
7. **Phase 3B**: Lessons injection on task resume
8. **Phase 3C**: Template suggestion mechanism
9. Build, test, commit, propose, governance → all nodes
