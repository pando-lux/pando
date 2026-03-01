# Orchestrator Process Isolation — COMPLETED

> Implemented 2026-03-01. All phases complete. Verified working.

## Architecture

Every system orchestrator (council, observer, qa-user) runs in its own child process via `fork()`. The main Node.js process handles only infrastructure — API, P2P, SQLite coordination, process lifecycle. No AI thinking on the main thread.

```
Main Process
├── HTTP API (Fastify on port 4000)
├── P2P Network (libp2p)
├── WorkerPool (spawn/kill workers)
├── Governance (deterministic checks)
├── OrchestratorProcessManager
│   ├── Forks child processes
│   ├── Handles IPC action requests
│   ├── Auto-restart on crash (up to 5 attempts)
│   └── Graceful shutdown
└── SQLite (WAL mode — concurrent access)

Child Processes
├── Council (PID X) — CEO brain, 60s tick, commit/propose via IPC
├── Observer (PID Y) — architecture audit, 5min tick, read-only
└── QA Agent (PID Z) — UX testing, 5min tick, spawns Playwright workers
```

## IPC Protocol

```
Parent → Child:
  { type: 'start', config: { orchestratorId, dataDir, apiPort, repoDir, ... } }
  { type: 'stop' }
  { type: 'result', requestId, success, data/error }
  { type: 'peer_count', count }

Child → Parent:
  { type: 'ready', orchestratorId, pid }
  { type: 'action', requestId, action, data }  // spawn_worker, commit_code, etc.
  { type: 'fire', action, data }               // push_event, thread_store_add (no response)
  { type: 'error', message }
```

## Files

| File | Purpose |
|---|---|
| `platform/orchestrator-manager.ts` | Main process — fork, IPC handler, restart, shutdown |
| `platform/orchestrator-process.ts` | Child process — own DB/MessageBus/AI, IPC bridge |
| `index.ts` | Wires OrchestratorProcessManager for system orchestrators |

## Key Design Decisions

1. **Each child has its own DB connection** — WAL mode allows concurrent reads + single writer
2. **IPC for main-process resources only** — spawn_worker, commit_code, push_event, send_chat_result
3. **Self-contained deps in child** — AgentDatabase, MessageBus, AIBackendRegistry, GenomeBridge, ScenarioRunner
4. **Project orchestrators still in-process** — system orchestrators (council, observer, qa-user) isolated first
5. **Exit code 75 = safe restart** — only council's exit 75 propagates to main process
6. **ESM compatibility** — uses `fileURLToPath(import.meta.url)` for `__dirname` (not CJS)

## Verification Results

- All 3 orchestrators fork successfully with separate PIDs
- API responds in <10ms during active AI calls (was 30-180s frozen)
- IPC spawn_worker works: QA agent spawns Playwright workers through IPC bridge
- IPC commit_code works: CEO commits code through IPC bridge
- Auto-restart: crashed children restart with exponential backoff
- Graceful shutdown: stopAll() sends stop signal, force-kills after 5s timeout
