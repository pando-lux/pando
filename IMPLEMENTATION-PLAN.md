# Agent Architecture v2 — Implementation Checklist

> Execute this plan top to bottom. Check off each item as you complete it.
> If conversation compacts, re-read this file to know where you left off.

## Pre-flight
- [x] Kill the running Pando node (taskkill node processes on port 4000/4100)
- [x] Verify git status is clean enough to work

## Phase 1A: stdin fix (ai-backend-claude.ts)

File: `packages/node/src/core/ai-backend-claude.ts`

Three changes:

1. **Remove prompt from CLI args (line 96)**
   - Find: `args.push('--', task.prompt);`
   - Remove this line entirely

2. **Change stdin from 'ignore' to 'pipe' (line 108)**
   - Find: `stdio: ['ignore', 'pipe', 'pipe'],`
   - Change to: `stdio: ['pipe', 'pipe', 'pipe'],`

3. **Write prompt to stdin after spawn (after line 110, before onPid)**
   - Add after `const child = spawn(claudePath, args, { ... });`:
   ```typescript
   // Pipe prompt via stdin (no CLI length limit — fixes ENAMETOOLONG on Windows)
   if (child.stdin) {
     child.stdin.write(task.prompt);
     child.stdin.end();
   }
   ```

- [x] Phase 1A done

## Phase 1B: Slim boot prompt (orchestrator.ts)

File: `packages/node/src/platform/orchestrator.ts`

### 1B-1: Truncate directives in board state
In `appendBoardState()`, find the directive rendering loop (~line 1303):
```typescript
sections.push(`- [D#${d.id}]${seen}${overdue}: ${d.content}`);
```
Replace with:
```typescript
const summary = d.content.replace(/\n/g, ' ').slice(0, 120);
sections.push(`- [D#${d.id}]${seen}${overdue}: ${summary}...`);
```

- [x] 1B-1 done

### 1B-2: Slim team roster to active + idle + counts
In `appendBoardState()`, find the team roster block (~line 1182-1207).
Replace the entire block (from `{ const twoHoursAgo` to the closing `}`) with:
```typescript
{
  const allTeamWorkers = this.deps.db.listAgents({ type: 'worker', parentId: this.orchestratorId });
  const activeWorkers = allTeamWorkers.filter(w => w.status === 'active');
  const idleWorkers = allTeamWorkers.filter(w => w.status === 'idle');
  const failedCount = allTeamWorkers.filter(w => w.status === 'failed').length;
  const doneCount = allTeamWorkers.filter(w => w.status === 'done').length;

  if (activeWorkers.length > 0 || idleWorkers.length > 0 || failedCount > 0) {
    sections.push('## Your Agents');
    sections.push(`Summary: ${activeWorkers.length} active, ${idleWorkers.length} idle, ${doneCount} done, ${failedCount} failed`);
    for (const w of activeWorkers) {
      const task = (w.rolePrompt || '').replace(/\n/g, ' ').slice(0, 80);
      sections.push(`- ${w.role} ${w.id}: ACTIVE — ${task}`);
    }
    for (const w of idleWorkers) {
      sections.push(`- ${w.role} ${w.id}: IDLE (available for new task)`);
    }
    sections.push('');
  }
}
```

- [x] 1B-2 done

### 1B-3: Slim recently failed workers to summary
In `appendBoardState()`, find the recently failed block (~line 1211-1226).
Replace the per-worker detail loop with a summary:
```typescript
if (board.recentlyFailed.length > 0) {
  sections.push('## Recently Failed Workers');
  const failCountByRole: Record<string, number> = {};
  for (const w of board.recentlyFailed) {
    failCountByRole[w.role] = (failCountByRole[w.role] || 0) + 1;
  }
  for (const [role, count] of Object.entries(failCountByRole)) {
    sections.push(`- ${role}: ${count} failures`);
    if (count >= 3) {
      sections.push(`  ⚠️ WARNING: ${role} has failed ${count} times. Consider different approach or simpler scope.`);
    }
  }
  sections.push('');
}
```

- [x] 1B-3 done

### 1B-4: Skip genome context for system orchestrators
In `appendBoardState()`, find genome injection (~line 1349):
```typescript
if (activeGenomeBridge?.isLoaded()) {
```
Change to:
```typescript
if (activeGenomeBridge?.isLoaded() && agent.projectId) {
```
This skips genome dumps for CEO, Observer, QA (they have no projectId).

- [x] 1B-4 done

## Phase 2A: Worker idle state (worker-pool.ts)

File: `packages/node/src/core/worker-pool.ts`

### 2A-1: Don't clear sessionId on successful completion
Find where sessionId is cleared after worker completes (search for `sessionId: null`).
Change worker completion to set status 'idle' instead of 'done' when worker reports success.
Keep 'failed' for failures. Keep 'done' only when worker is explicitly retired or idle-timed-out.

Note: The auto-report in WorkerPool (when process exits) should check if worker
reported success via HTTP first. If yes → idle. If no report → failed.

Look for the report endpoint handler and the auto-completion logic.
When status is 'done' from a successful report, change to 'idle' and KEEP sessionId.

- [x] 2A-1 done

### 2A-2: Add idle timeout to reaper
In the reaper interval (search for "reaper" or the 30s setInterval), add:
```typescript
// Retire workers idle > 30 min
const idleTimeout = 30 * 60 * 1000;
const idleWorkers = this.db.listAgents({ type: 'worker', status: 'idle' });
for (const w of idleWorkers) {
  const idleSince = new Date(w.updatedAt || w.createdAt || '0').getTime();
  if (Date.now() - idleSince > idleTimeout) {
    this.db.updateAgent(w.id, { status: 'done', sessionId: undefined });
    console.log(`[WorkerPool] Retired idle worker ${w.id} (idle ${Math.round((Date.now() - idleSince) / 60000)}min)`);
  }
}
```

- [x] 2A-2 done

## Phase 2B: assignTask + findIdleWorker (worker-pool.ts)

### 2B-1: Add findIdleWorker method
```typescript
findIdleWorker(role: string, orchestratorId: string): string | null {
  const workers = this.db.listAgents({
    type: 'worker',
    role,
    parentId: orchestratorId,
  }).filter(w => w.status === 'idle');
  if (workers.length === 0) return null;
  // Most recently active = freshest context
  workers.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return workers[0].id;
}
```

- [x] 2B-1 done

### 2B-2: Add assignTask method
```typescript
async assignTask(workerId: string, task: string): Promise<void> {
  const worker = this.db.getAgent(workerId);
  if (!worker) throw new Error(`Worker ${workerId} not found`);
  if (worker.status !== 'idle') throw new Error(`Worker ${workerId} is ${worker.status}, not idle`);
  if (!worker.sessionId) {
    // Session expired or cleared — can't resume, throw so CEO spawns fresh
    throw new Error(`Worker ${workerId} has no session to resume`);
  }

  this.db.updateAgent(workerId, { status: 'active', rolePrompt: task });

  const prompt = [
    `--- NEW TASK ASSIGNED ---`,
    ``,
    task,
    ``,
    `When done, report via POST http://127.0.0.1:${this.apiPort}/v1/worker/${workerId}/report`,
    `Include: { "status": "done"|"failed", "summary": "what you did" }`,
  ].join('\n');

  const backend = this.deps.aiRegistry.getBest('code-execution');
  if (!backend) throw new Error('No code-execution backend available');

  // Resume the worker's existing session
  const result = await backend.execute({
    type: 'code',
    prompt,
    sessionId: worker.sessionId,
    options: {
      cwd: worker.workspaceDir || this.repoDir,
      model: 'claude-opus-4-6',
    },
  });

  // Handle completion — same as fresh spawn
  // (the existing completion handler should handle this)
}
```

NOTE: assignTask runs the worker synchronously like spawn does. Need to check
how spawn() handles the async execution — it likely tracks the process and
handles completion via the exit handler. assignTask should follow the same
pattern. Study spawn() carefully and mirror the async pattern.

- [x] 2B-2 done

## Phase 2C: assign_task action in orchestrator + IPC

### 2C-1: Add assign_task to OrchestratorAction union type
In orchestrator.ts, find the OrchestratorAction type union and add:
```typescript
| { type: 'assign_task'; workerId: string; task: string }
```

- [x] 2C-1 done

### 2C-2: Add assign_task execution
In the executeActions switch/if chain, add:
```typescript
case 'assign_task': {
  try {
    await this.deps.workerPool.assignTask(action.workerId, action.task);
    console.log(`[Orchestrator ${this.orchestratorId}] Assigned task to idle worker: ${action.workerId}`);
  } catch (err: any) {
    console.warn(`[Orchestrator ${this.orchestratorId}] assign_task failed: ${err.message}, will spawn fresh`);
    // Fallback: spawn fresh worker if assign fails
  }
  break;
}
```

- [x] 2C-2 done

### 2C-3: Add assign_task to IPC bridge (orchestrator-manager.ts)
In `executeAction()` switch statement, add:
```typescript
case 'assign_task': {
  await this.deps.workerPool.assignTask(data.workerId, data.task);
  return true;
}
```

- [x] 2C-3 done

### 2C-4: Add assign_task to CEO available actions in boot prompt
In appendAvailableActions(), in the council section, add:
```typescript
sections.push('- assign_task: Send a new task to an IDLE worker (reuses their session + context)');
sections.push('  { "type": "assign_task", "workerId": "worker-builder-abc123", "task": "Fix the encryption bug in thread-store.ts" }');
sections.push('  PREFER this over spawn_worker when an idle worker exists — reuses their codebase knowledge.');
```

- [x] 2C-4 done

### 2C-5: Update CEO boot prompt — worker management philosophy
In the council section of buildBootPrompt(), add after the authority section:
```
## WORKER MANAGEMENT

Workers are PERSISTENT. They don't die after one task — they go idle.

REUSE first, spawn only if needed:
1. Check "Your Agents" section for IDLE workers matching the role you need
2. If idle worker exists: use assign_task to reuse their session and codebase knowledge
3. If no idle worker for that role: use spawn_worker to create a fresh one

One problem at a time:
- Pick the HIGHEST PRIORITY directive
- Assign to ONE worker (builder for code, tester for verification)
- Wait for their report before starting the next problem
- Commit after each fix, not in batches

Workers are as smart as you. Give them the specific problem, not a data dump.
GOOD: "Fix decryptMessage() in thread-store.ts — crashes on null encryption key for guest threads"
BAD: "Fix all the bugs in the system"
```

- [x] 2C-5 done

## Phase 3: Worker learning

### 3-1: Update worker boot prompt to include learning instructions
In worker-pool.ts buildBootPrompt(), add section:
```
## LEARNING

After completing each task, save what you learned about the module:
POST http://127.0.0.1:{apiPort}/v1/context/discover
{
  "projectId": "__pando__",
  "category": "module:{filename}",
  "content": "What you learned about this file/module",
  "confidence": 0.8
}

This helps you and future workers be more effective on similar tasks.
```

- [x] 3-1 done

### 3-2: Include relevant lessons when resuming worker
In assignTask(), before building the resume prompt, query recent lessons:
```typescript
let lessonText = '';
try {
  const lessons = this.db.getLessons({
    orchestratorId: worker.parentId || orchestratorId,
    limit: 5,
  });
  if (lessons.length > 0) {
    lessonText = '\n\nRelevant lessons from past tasks:\n' +
      lessons.map(l => `- ${l.lesson}`).join('\n');
  }
} catch { /* non-fatal */ }
```
Then include in the resume prompt.

- [x] 3-2 done

## Post-implementation

- [x] `npm run build` — ZERO errors
- [x] Start node: `nohup node packages/node/dist/cli.js --port 4100 --api-port 4000 > /c/Users/jaira/Desktop/pando-node.log 2>&1 &`
- [x] Verify CEO prompt size in logs: should be <15K chars
- [x] Verify CEO tick succeeds (no ENAMETOOLONG)
- [x] Verify QA and Observer still tick normally
- [x] Wait for CEO to process at least 1 directive
- [x] Commit: `git add <files> && git commit -m "Agent Architecture v2: stdin piping, slim prompts, persistent workers"`
- [x] Push: `git push backup-private master`
- [x] Trigger governance: ensure propose_upgrade happens (CEO should auto-propose after commit, or we manually trigger)

## Files modified (summary)
1. `packages/node/src/core/ai-backend-claude.ts` — stdin piping (3 lines)
2. `packages/node/src/platform/orchestrator.ts` — slim prompts + assign_task action + CEO prompt
3. `packages/node/src/core/worker-pool.ts` — persistent workers (idle state, assignTask, findIdleWorker, reaper, learning)
4. `packages/node/src/platform/orchestrator-manager.ts` — assign_task IPC action
