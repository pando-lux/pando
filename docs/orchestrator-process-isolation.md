# Orchestrator Process Isolation — Implementation Roadmap

## Vision

Every Claude Code instance (orchestrator or worker) is its own independent process.
The main node process is pure infrastructure — API, P2P, SQLite, process lifecycle.
No AI thinking on the main thread. Ever.

## Phase 0: Backup & Safety
- Stop the local node
- Commit all uncommitted changes
- Push to backup-private (jairangwani/pando)
- Verify EC2 nodes won't interfere (they pull from pando-lux/pando, not backup-private)

## Phase 1: Foundation — OrchestratorProcessManager
**New file: `platform/orchestrator-manager.ts`**

The process manager runs on the main Node.js process. It:
- Forks child processes for each orchestrator
- Maintains a registry of running orchestrator processes
- Handles IPC messages from children (action execution requests)
- Executes actions on behalf of children (spawn_worker, commit_code, etc.)
- Monitors health — restarts crashed orchestrator processes
- Graceful shutdown — signals children to stop on node shutdown

IPC Protocol (parent ↔ child):
```
Parent → Child:
  { type: 'start', orchestratorId, config }
  { type: 'stop' }
  { type: 'action_result', requestId, result }

Child → Parent:
  { type: 'ready' }
  { type: 'action_request', requestId, action }  // spawn_worker, commit_code, etc.
  { type: 'tick_complete', tickNumber, tier, duration }
  { type: 'error', message }
```

## Phase 2: Orchestrator Child Process Runner
**New file: `platform/orchestrator-process.ts`**

Standalone entry point that runs in a forked child process:
1. Receives orchestrator ID via process.argv or IPC
2. Opens its own SQLite connection to agents.db (WAL mode for concurrent access)
3. Creates AgentDatabase, MessageBus instances (own connections)
4. Creates Orchestrator instance with:
   - Direct deps: db, messageBus (own SQLite handles)
   - IPC-proxied deps: workerPool, onCommit, onPropose, onDeploy
5. Starts the tick loop (setInterval on its own event loop)
6. Sends action requests to parent via IPC
7. Receives action results from parent via IPC

Key: The Orchestrator class doesn't change. We provide different dep implementations.

## Phase 3: Wire It Up in index.ts
Replace in-process orchestrator instantiation with process manager:

Before:
```typescript
this.instantiateOrchestrator(this.councilOrchId);
this.instantiateOrchestrator(this.observerOrchId);
this.instantiateOrchestrator(this.qaUserOrchId);
```

After:
```typescript
this.orchestratorManager = new OrchestratorProcessManager({
  workerPool: this.workerPool,
  messageBus: this.messageBus,
  orgManager: this.orgManager,
  onCommit: (msg) => this.commitAndBuild(msg),
  onPropose: (desc) => this.proposeUpgrade(desc),
  // ... other callbacks
});
this.orchestratorManager.startOrchestrator(this.councilOrchId);
this.orchestratorManager.startOrchestrator(this.observerOrchId);
this.orchestratorManager.startOrchestrator(this.qaUserOrchId);
```

Keep `instantiateOrchestrator()` as fallback for project orchestrators initially.

## Phase 4: Async Shell Operations
Convert all execSync in orchestrator action execution to async:
- `git add -A` → async exec
- `git commit -m` → async exec
- `npm run build` → async exec
- `genome.py compile` → async exec

These run on the main process (via IPC action execution), so making them async
keeps the main event loop free for API/P2P.

## Phase 5: Tick State Preservation
On shutdown: save each orchestrator's `next_tick_due_at` to agent_identity table.
On startup: read it back, calculate initial delay = max(0, next_tick_due_at - now).
Result: QA at 3 min remaining → first tick in 3 min, not 15 min.

## Phase 6: Configuration & Quick Wins
- QA interval: 900000 → 300000 (5 min)
- Observer interval: already 300000 (5 min) ✓
- QA boot prompt: fix port 3000 → 3222
- QA boot prompt: add gateway startup autonomy
- Ensure WAL mode on SQLite for concurrent process access

## Phase 7: Build, Test, Verify
1. `npm run build` — zero errors
2. Start node
3. Verify: all 3 orchestrators running as separate processes (check PIDs)
4. Verify: API responds during CEO Tier 2 tick (curl /v1/status)
5. Verify: QA ticks at 5-min interval
6. Verify: Observer ticks at 5-min interval
7. Monitor 15+ min — all orchestrators ticking independently
8. Commit, push to backup-private

## Risk Mitigation
- Backup before any changes
- Keep instantiateOrchestrator() as fallback
- If child process approach fails: revert to in-process + async shell ops (still 60% improvement)
- SQLite WAL mode tested before multi-process access
