<!-- STATUS: HISTORICAL DESIGN - superseded by genome/knowledge/flows/*.know -->
# Agent System Integration — How the New Architecture Fits Into Pando

**Date**: 2026-02-27
**Status**: BRAINSTORM — mapping complete, build plan TBD
**Companion doc**: `docs/orchestrator-architecture.md` (the hierarchy & orchestrator design)

---

## FOR IMPLEMENTING AGENTS: READ THIS FIRST

### What this document is
A complete mapping of how the brainstormed orchestrator architecture (from `orchestrator-architecture.md`) integrates into the existing Pando codebase. It answers: what stays, what changes, what's new, what gets deleted, and where files go. It also defines the Unified Agent Identity model, context assembly, session persistence, security model, communication patterns, and self-healing growth loop.

### Table of contents
- **Part 1** (line ~60): Current system audit — every existing component, what it does, what's wrong with it
- **Part 2** (line ~230): What stays untouched — solid infrastructure that doesn't need changing
- **Part 3** (line ~320): What changes — existing code that gets refactored
- **Part 4** (line ~490): What's new — components that don't exist yet
- **Part 5** (line ~650): The split — how agent-manager.ts (2,097 lines) becomes 3 focused modules
- **Part 6** (line ~770): Private vs public agents — user projects vs network council
- **Part 7** (line ~900): Gateway integration — how the user-facing flow changes
- **Part 8** (line ~990): P2P distribution — which node runs which orchestrator
- **Part 9** (line ~1100): Unified Agent Identity — one record per agent, single source of truth
- **Part 10** (line ~1310): Context Assembly & Session Persistence — how workers get their brain
- **Part 11** (line ~1550): The Agent Spectrum — from single worker to organizational scale
- **Part 12** (line ~1670): Security Model — 3-layer defense, authority enforcement, message signing
- **Part 13** (line ~1890): Communication Patterns — the only 4 allowed communication paths
- **Part 14** (line ~2010): Self-Healing & Growth — reflection, lessons, institutional memory
- **Part 15** (line ~2240): Migration path — how to transition without breaking the live network
- **Part 16** (line ~2340): Resolved decisions & remaining open questions

### The one-paragraph summary
Pando already has 80% of what's needed — P2P networking, governance, task database, agent primitives, AI backend, capability profiles. The problem is a single 1,234-line file (council.ts) that puts orchestration logic inside an AI conversation, and a 2,097-line file (agent-manager.ts) that tries to be 6 systems at once. The fix: add an Orchestrator layer on top (from the companion doc), split agent-manager into 3 focused modules (WorkerPool, OrgManager, MessageBus), replace council.ts with a deterministic tick loop that calls AI in short bursts, and unify all agent identity/context/lifecycle under a single SQLite-backed system. Everything below the orchestration layer — networking, governance, storage, the worker primitive — stays.

---

## Part 1: Current System Audit

### Every component that touches agents, with honest assessment

#### KERNEL LAYER (packages/node/src/kernel/)

| File | Lines | What It Does | Verdict |
|---|---|---|---|
| `network.ts` | ~1,100 | libp2p, GossipSub, TCP, message signing, 10 pub/sub topics | KEEP. Rock solid. Battle-tested across 5 nodes. |
| `governance.ts` | ~1,900 | Proposals, voting, AI review, staking, auto-approve | KEEP. Democratic backbone. Only touch to wire new orchestrator's proposals. |
| `monitor.ts` | ~600 | Health metrics, alert detection (data-only, no recovery) | KEEP. Feeds alerts to orchestrator instead of council. |
| `guardrails.ts` | ~400 | Protected paths, rate limits, immutable kernel | KEEP. Safety net stays. |
| `sync.ts` | ~300 | GossipSub ledger sync | KEEP. Unrelated to agents. |
| `security-monitor.ts` | ~200 | Threat detection, peer quarantine | KEEP. |
| `reputation.ts` | ~300 | Node reputation tracking | KEEP. Orchestrator uses reputation for council selection. |
| `emission-witness.ts` | ~250 | Witness-based Lux minting | KEEP. |

**Kernel verdict: 0 changes needed.** The kernel is clean.

#### CORE LAYER (packages/node/src/core/)

| File | Lines | What It Does | Verdict |
|---|---|---|---|
| `agent.ts` | 1,280 | Universal agent primitive — workspace, Claude spawn, session mgmt, 4-layer CLAUDE.md | REFACTOR. Good foundation. Simplify: remove orchestration responsibility, add MCP tool support. Worker becomes a thinner wrapper around Claude Code + MCP. |
| `agent-manager.ts` | 2,097 | Agent registry + bridge watcher + project registry + cleanup + watchdog + session mgmt | SPLIT into 3 modules (WorkerPool, OrgManager, lifecycle). This is the biggest change. |
| `bridge-queue.ts` | 267 | Per-manager FIFO event queue, in-memory, priority sorting | REPLACE with SQLite MessageBus. Current version loses events on restart. |
| `ai-backend.ts` | 37 | AIBackend interface | KEEP. |
| `ai-backend-registry.ts` | 37 | Detect/select best AI backend | KEEP. |
| `ai-backend-claude.ts` | 210 | Claude Code spawn implementation | KEEP. Workers still use Claude Code. Orchestrator AI calls use this too. |
| `request-reply.ts` | ~200 | P2P request-reply with correlation IDs | KEEP. Used by P2P storage, credentials. |
| `storage-backend.ts` | ~100 | StorageBackend interface + MongoDB/P2P implementations | KEEP. |
| `deploy-manager.ts` | ~400 | Backup, build, commit, rollback | KEEP. Orchestrator calls this for deployments. |
| `upgrade-protocol.ts` | ~300 | Git pull upgrade: propose/build/restart | KEEP. Orchestrator uses this instead of council. |
| `payment-gate.ts` | ~200 | Cost estimation, escrow | KEEP. Budget enforcement stays. |
| `version-protocol.ts` | ~100 | Version compatibility | KEEP. |

#### PLATFORM LAYER (packages/node/src/platform/)

| File | Lines | What It Does | Verdict |
|---|---|---|---|
| `council.ts` | 1,234 | AI CEO — reflection cycles, spawn builders/QA, ActiveTask state machine, audit trail | REPLACE. This is the core problem. Replaced by top-level Orchestrator with deterministic tick loop. |
| `scheduler.ts` | 852 | Task queue, approval gate, polling, resource routing | MERGE into Orchestrator. Each orchestrator IS the scheduler for its level. Scheduler's gates (dependency, capability, dedup) move into Orchestrator.tick(). |
| `task-queue.ts` | ~400 | TaskQueue interface, dedup, P2P sync | EXTEND. Becomes the "board" that orchestrators read. Add orchestrator_id column, message bus tables. |
| `task-database.ts` | ~500 | SQLite schema for tasks | EXTEND. Add new tables for orchestrator state, lessons, org_knowledge, message inbox. |
| `agent-tools.ts` | 523 | HTTP API routes for agent CRUD | REFACTOR. Add orchestrator endpoints, keep worker endpoints. |
| `pipeline-runner.ts` | ~400 | 7-stage autonomous code pipeline | KEEP. Orchestrator calls pipeline instead of council. |
| `qa-runner.ts` | ~200 | Page and API tests | KEEP. Workers use this. |
| `regression-suite.ts` | ~300 | 14 built-in regression tests | KEEP. QA orchestrator runs these. |
| `resource-router.ts` | ~300 | Smart task routing, auto-degrade | KEEP. Orchestrator uses for cross-node routing. |
| `capability-detector.ts` | ~200 | Auto-detect node capabilities | KEEP. |
| `capability-registry.ts` | ~300 | Network-wide capability map | KEEP. |
| `content-registry.ts` | ~400 | Content records, search | KEEP. Unrelated. |
| `thread-store.ts` | ~200 | Chat thread storage | KEEP. Gateway uses this. |

#### API LAYER (packages/node/src/api/)

| File | What It Does | Verdict |
|---|---|---|
| `api-server.ts` | Fastify server, SSE, auth | KEEP. Add orchestrator routes. |
| `kernel-api.ts` | Governance, health, network routes | KEEP. |
| `core-api.ts` | Agent spawn/message/report routes | REFACTOR. Update to use new WorkerPool/OrgManager. |
| `platform-api.ts` | Chat, projects, scheduler routes | REFACTOR. Wire to orchestrator instead of council/scheduler. |

---

## Part 2: What Stays Untouched

These systems are solid. Don't touch them.

### P2P Networking Stack
```
kernel/network.ts          — libp2p, GossipSub, TCP, signing
core/request-reply.ts      — P2P RPC with correlation IDs
core/p2p-storage-backend.ts — untrusted node storage proxy
core/storage-backend.ts    — StorageBackend interface
core/mongo-backend.ts      — MongoDB direct access
```
**Why:** 5 nodes in production, battle-tested. Agent changes don't affect networking.

### Governance System
```
kernel/governance.ts       — proposals, votes, AI review, staking
kernel/reputation.ts       — node reputation tracking
kernel/emission-witness.ts — witness-based Lux minting
```
**Why:** Democratic backbone. Orchestrator USES governance (creates proposals), doesn't change it.

### Security & Safety
```
kernel/guardrails.ts       — protected paths, rate limits
kernel/security-monitor.ts — threat detection
kernel/monitor.ts          — health metrics, alerts
```
**Why:** Safety nets stay. Orchestrator receives health alerts instead of council.

### AI Backend
```
core/ai-backend.ts         — interface
core/ai-backend-registry.ts — detect/select
core/ai-backend-claude.ts  — Claude Code spawn
```
**Why:** Workers still use Claude Code. Orchestrator's short AI calls use the same backend.

### Infrastructure
```
core/deploy-manager.ts     — backup, build, commit, rollback
core/upgrade-protocol.ts   — git pull upgrade protocol
core/payment-gate.ts       — cost estimation, escrow
platform/pipeline-runner.ts — 7-stage code pipeline
platform/regression-suite.ts — built-in regression tests
platform/resource-router.ts — cross-node task routing
platform/capability-*.ts   — node capability discovery
platform/content-*.ts      — content registry
platform/thread-store.ts   — chat threads
```
**Why:** All called BY the orchestrator, not changed.

---

## Part 3: What Changes

### 3.1 council.ts (1,234 lines) → DELETED, replaced by Orchestrator

**Current council.ts does:**
1. Select top 3 reputation nodes as council members
2. Run reflection cycles (1h/4h/24h) — long AI call
3. Parse AI output for proposals and fix actions
4. Spawn builder agents via HTTP API
5. Track ActiveTask state machine (builder → qa → governance → done)
6. Spawn QA tester agents independently
7. Handle bridge queue events (task_completed, task_failed)
8. Commit & push code changes
9. Create governance proposals
10. Chat interface (POST /council/message)
11. Founder directives
12. Audit trail (minutes, request log, chat history)
13. Health alert classification

**What replaces each:**

| Council responsibility | New owner |
|---|---|
| Council member selection | OrgManager (same logic — top 3 reputation nodes) |
| Reflection cycles | Orchestrator.tick() — deterministic, runs every 60s |
| AI judgment calls | Orchestrator.callAI() — short, stateless, reads board |
| Spawn builders | Orchestrator executes `spawn_worker` action via WorkerPool |
| ActiveTask tracking | SQLite board (task status lives in DB, not in-memory) |
| Spawn QA testers | QA department orchestrator spawns testers |
| Bridge events | SQLite MessageBus (persistent, not in-memory) |
| Commit & push | Orchestrator executes `commit` action via DeployManager |
| Governance proposals | Orchestrator executes `propose_upgrade` action via governance |
| Chat interface | Stays as API route, but messages go to orchestrator's inbox |
| Founder directives | Stored in SQLite, read by orchestrator on each tick |
| Audit trail | SQLite tables: `tick_log`, `decisions`, `lessons` |
| Health alerts | Pushed to council orchestrator's SQLite inbox |

### 3.2 agent-manager.ts (2,097 lines) → SPLIT into 3 modules

See Part 5 for the detailed split.

### 3.3 bridge-queue.ts (267 lines) → REPLACED by SQLite MessageBus

**Current problems:**
- In-memory only — node restart loses all events
- Per-manager queues — no cross-team routing
- Priority sorting is naive (just 3 levels)
- No persistence, no queryability

**New MessageBus (SQLite):**
```sql
CREATE TABLE message_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_id TEXT NOT NULL,      -- orchestrator ID
    sender_id TEXT NOT NULL,         -- who sent it
    sender_type TEXT NOT NULL,       -- 'worker', 'orchestrator', 'user', 'system'
    type TEXT NOT NULL,              -- 'worker_report', 'health_alert', 'cross_team', 'user_request', 'directive'
    payload TEXT NOT NULL,           -- JSON
    priority INTEGER DEFAULT 1,     -- 0=critical, 1=normal, 2=low
    signature TEXT,                  -- Ed25519 signature (required for cross-node messages)
    created_at TEXT NOT NULL,
    read_at TEXT,                    -- NULL = unread
    INDEX idx_inbox_recipient (recipient_id, read_at, priority)
);
```

**Key changes:**
- Persistent — survives restart
- Per-orchestrator inbox (not per-agent)
- Cross-team messages routed through OrgManager
- Queryable — "show me all unread messages for QA dept"
- Read receipts — orchestrator marks as read after processing
- Signed messages for cross-node communication

### 3.4 agent.ts (1,280 lines) → SIMPLIFIED

**Current agent.ts has too many responsibilities:**
- Workspace management (good, keep)
- Claude Code spawn (good, keep)
- Session management (good, keep)
- 4-layer CLAUDE.md assembly (simplify — MCP replaces layers 2-3)
- Standing directives (remove — orchestrator handles this now)
- Budget tracking (keep)
- Child registry (remove — orchestrator handles hierarchy)
- Event queuing (remove — orchestrator handles sequencing)

**Simplified agent.ts becomes a "Worker":**
```
Worker (refactored from agent.ts)
├── id, role, workspace
├── Claude Code process management (spawn, kill, resume)
├── MCP tool server (get_my_task, report_progress, get_my_identity)
├── Budget tracking
└── That's it. No orchestration logic.
```

### 3.5 scheduler.ts (852 lines) → MERGED into Orchestrator

**Current scheduler has:**
- Approved queue (bridge between manager and agent-manager)
- Gates: dependency, capability, parent-done, dedup
- Poll cycle (10s maintenance)
- Task cost tracking
- Cross-node task sync

**What happens to each:**

| Scheduler piece | New home |
|---|---|
| Approved queue | Orchestrator.tick() reads its board directly |
| Dependency gate | Orchestrator.tick() checks deps before assigning |
| Capability gate | OrgManager checks before routing to node |
| Parent-done gate | Orchestrator checks parent status |
| Dedup gate | SQLite dedup at task creation time |
| Poll maintenance | Orchestrator.tick() does cleanup each cycle |
| Cost tracking | SQLite `worker_costs` table |
| Cross-node sync | GossipSub task events (stays in task-queue.ts) |

### 3.6 task-queue.ts / task-database.ts → EXTENDED

See Part 9 for the unified schema that replaces scattered tables.

---

## Part 4: What's New

### 4.1 Orchestrator Class (new file)

**Location:** `packages/node/src/platform/orchestrator.ts`

The core of the new system. One class, used at every level.

```
Orchestrator
├── id: string
├── parentId: string | null
├── role: string (council | engineering | qa | user_project | ...)
├── level: number (0=council, 1=dept, 2=team)
├── config: OrchestratorConfig
│   ├── tickInterval: number (ms)
│   ├── maxWorkers: number
│   ├── maxChildren: number
│   ├── rolePrompt: string (AI brain prompt for this level)
│   └── canCreateSubOrchestrators: boolean
├── db: SQLiteDatabase (shared)
│
├── tick()           — main loop, called by setInterval
│   ├── readBoard()  — get all tasks for this orchestrator
│   ├── readInbox()  — get unread messages
│   ├── classify()   — tier 1 (deterministic) or tier 2 (needs AI)?
│   ├── callAI()     — if tier 2: short, stateless AI call
│   ├── execute()    — run actions returned by AI or determined by code
│   └── log()        — write tick_log entry
│
├── execute(action)  — action dispatcher
│   ├── spawn_worker     → WorkerPool.spawn(role, task, workspace)
│   ├── kill_worker      → WorkerPool.kill(workerId)
│   ├── assign_task      → update task.worker_id in SQLite
│   ├── create_task      → insert into tasks table
│   ├── send_message     → insert into message_inbox
│   ├── create_team      → OrgManager.createOrchestrator(...)
│   ├── dissolve_team    → OrgManager.dissolve(orchestratorId)
│   ├── propose_upgrade  → governance.createProposal(...)
│   ├── commit_code      → DeployManager.commit(...)
│   ├── deploy           → DeployManager.deploy(...)
│   ├── record_lesson    → insert into lessons table
│   └── escalate         → insert message to parent's inbox
│
├── readBoard()      — SELECT * FROM tasks WHERE orchestrator_id = ?
├── readInbox()      — SELECT * FROM message_inbox WHERE recipient_id = ? AND read_at IS NULL
├── markRead(ids)    — UPDATE message_inbox SET read_at = ? WHERE id IN (?)
└── stop()           — clearInterval, cleanup
```

**What makes this different from council.ts:**
1. **No long AI conversations.** Each tick is a fresh, 1-turn AI call.
2. **All state in SQLite.** Nothing in memory except the timer handle.
3. **Deterministic loop.** setInterval fires. Code reads board. Code decides tier. Code calls AI if needed. Code executes actions. Repeat.
4. **Same class at all levels.** Council, departments, teams — all use Orchestrator. Only the config and rolePrompt differ.

### 4.2 WorkerPool (new file)

**Location:** `packages/node/src/core/worker-pool.ts`

Extracted from agent-manager.ts. Does ONE thing: manage Claude Code processes.

```
WorkerPool
├── spawn(config: WorkerConfig): Promise<string>
│   ├── Create workspace directory
│   ├── Write CLAUDE.md (simplified — assembled by assembleContext())
│   ├── Start Claude Code process
│   ├── Start MCP tool server (get_my_task, report_progress, get_my_identity)
│   ├── Register in SQLite agent_identity table
│   └── Return worker ID
│
├── kill(workerId: string): void
│   ├── SIGTERM the Claude Code process
│   ├── Update agent_identity table: status = 'done' or 'failed'
│   └── Archive workspace (if configured)
│
├── getStatus(workerId: string): WorkerStatus
│   └── Read from agent_identity table
│
├── listActive(): WorkerStatus[]
│   └── SELECT * FROM agent_identity WHERE status IN ('active', 'spawning') AND type = 'worker'
│
└── cleanup(): void
    └── Kill orphaned processes, archive old workspaces
```

**What it does NOT do (compared to agent-manager.ts):**
- No bridge queue watching
- No event dispatching
- No project registry
- No hierarchy management
- No standing directives
- No cleanup sweep lifecycle (active → idle → archived → dead)

All that logic moves to the Orchestrator.

### 4.3 OrgManager (new file)

**Location:** `packages/node/src/platform/org-manager.ts`

Manages the hierarchy tree. Creates/dissolves orchestrators.

```
OrgManager
├── createOrchestrator(config): string
│   ├── Insert into agent_identity table (type='orchestrator')
│   ├── Create tick interval (setInterval)
│   ├── Return orchestrator ID
│   └── Wire health alert routing
│
├── dissolve(orchestratorId): void
│   ├── Stop tick interval
│   ├── Kill all workers owned by this orchestrator
│   ├── Move lessons to org_knowledge (institutional memory)
│   ├── Update agent_identity table: status = 'dissolved'
│   └── Reassign orphaned tasks to parent
│
├── getTree(): OrgTree
│   └── SELECT with recursive CTE for full hierarchy
│
├── routeMessage(from, to, message): void
│   ├── Validate sender has authority to message recipient
│   ├── If same orchestrator: direct insert to inbox
│   ├── If parent/child: direct insert to inbox
│   ├── If cross-team: route through common ancestor
│   └── If cross-node: P2P via RequestReplyManager (signed)
│
├── selectCouncil(): string[]
│   └── Same logic as current council.ts: top 3 reputation nodes with Claude Code
│
└── getOrchestratorForProject(projectId): string
    └── Find or create user project orchestrator
```

### 4.4 Worker MCP Tools (new file)

**Location:** `packages/node/src/core/worker-mcp.ts`

The worker's lifeline. 3 tools that survive any context compaction.

```
MCP Server (per worker)
├── get_my_task()
│   ├── Read current assignment from agent_identity table
│   ├── Read task details from tasks table
│   ├── Return: { taskId, description, files, deadline, orchestratorNotes }
│   └── Worker calls this whenever it's confused or context-compacted
│
├── report_progress(status, summary, files_changed?, difficulties?, suggestions?)
│   ├── Insert into message_inbox for worker's orchestrator
│   ├── Update agent_identity.last_report_at
│   ├── If status == 'done': update task status, trigger orchestrator tick
│   ├── If status == 'stuck': orchestrator sees this on next tick, decides action
│   └── If status == 'question': orchestrator reads question, AI decides answer
│
└── get_my_identity()
    ├── Read from agent_identity table
    ├── Return: { id, role, scope, parentId, authority, projectId, budget }
    └── Worker calls this to understand who it is and what it's allowed to do
```

**Why this is critical:**
Even if a worker's Claude Code session gets fully context-compacted and forgets everything — it still has MCP tools. When it calls `get_my_task()`, it gets its full task description back. When it calls `get_my_identity()`, it knows exactly who it is, what it can do, and who it reports to. It can continue working without any conversation history.

### 4.5 SQLite MessageBus (new, replaces bridge-queue.ts)

**Location:** `packages/node/src/core/message-bus.ts`

Persistent message routing. Replaces in-memory bridge queue.

```
MessageBus
├── send(recipientId, senderId, senderType, type, payload, priority?): void
│   ├── Validate sender authority (see Part 12)
│   └── INSERT INTO message_inbox
│
├── read(recipientId, limit?): Message[]
│   └── SELECT ... WHERE recipient_id = ? AND read_at IS NULL ORDER BY priority, created_at
│
├── markRead(messageIds: number[]): void
│   └── UPDATE ... SET read_at = datetime('now')
│
├── broadcast(type, payload): void
│   └── Insert one message per active orchestrator
│
└── cleanup(olderThanDays): void
    └── DELETE ... WHERE read_at IS NOT NULL AND created_at < ?
```

---

## Part 5: The Split — agent-manager.ts → 3 Modules

The current agent-manager.ts has 2,097 lines doing 6 things. Here's exactly how it splits:

### Current Responsibility → New Home

| Responsibility | Current (agent-manager.ts) | New Home | Why |
|---|---|---|---|
| **Agent registry** (spawn, track, lookup) | Lines ~100-400 | **WorkerPool** (worker-pool.ts) + **SQLite agent_identity table** | Registry moves to DB. WorkerPool just manages processes. |
| **Bridge queue watcher** (event dispatch) | Lines ~400-900 | **Orchestrator.tick()** reads inbox from SQLite | No more event-driven dispatch. Orchestrator polls its board/inbox each tick. |
| **Project registry** (access control) | Lines ~900-1100 | **OrgManager** | Project orchestrators replace project agents. Access control on orchestrator level. |
| **Cleanup sweep** (lifecycle: active→idle→archived→dead) | Lines ~1100-1400 | **Orchestrator.tick()** manages worker lifecycle | Orchestrator knows when workers are done. No need for separate sweep. |
| **Watchdog** (5-min nudge for idle agents) | Lines ~1400-1600 | **Orchestrator.tick()** + **Worker MCP** | Orchestrator checks last_report_at. If stale, decides action. Worker MCP prevents "lost" workers. |
| **Session management** (Claude spawn, resume, rotate) | Lines ~1600-2097 | **WorkerPool** | Process management only. No orchestration logic. |

### What gets deleted entirely

These patterns from agent-manager.ts are unnecessary with the new architecture:

1. **Bridge watcher with nested timeouts** (30min idle, 2h hard cap, 2.5h stale detection) — Orchestrator's deterministic tick replaces all of this
2. **Standing directives** (Phase 29) — Orchestrator manages worker lifecycle directly
3. **Manager busy/idle tracking** — No managers. Orchestrators are code, always available
4. **On-demand project agent creation** — OrgManager creates project orchestrators
5. **SSE relay in event processing** — Gateway reads from SQLite/MessageBus directly
6. **Agent state machine** (ACTIVE → IDLE → ARCHIVED → DEAD) — Workers are short-lived. Orchestrator spawns/kills as needed

---

## Part 6: Private vs Public Agents

### Private agents (user projects via gateway)

**Current flow:**
```
User chat → POST /v1/chat/message → BridgeQueue → project agent (on-demand) → builder/tester agents
```

**New flow:**
```
User chat → POST /v1/chat/message → MessageBus (inbox for project orchestrator)
→ Project Orchestrator tick()
→ reads message from inbox
→ calls AI: "user wants a todo app, what's the plan?"
→ AI returns: [create_task("build UI"), create_task("add tests"), spawn_worker("builder")]
→ Orchestrator executes actions
→ Worker builds, reports via MCP
→ Orchestrator reads report on next tick
→ Orchestrator spawns QA worker
→ QA tests, reports
→ Orchestrator deploys
→ Orchestrator sends response to user via MessageBus → SSE
```

**Key difference:** No long-running manager agent. A deterministic orchestrator manages the project. If the node restarts, the orchestrator resumes from SQLite state. Nothing is lost.

**One orchestrator per project.** Created when first user message arrives. Dissolved after project completes (lessons saved to org_knowledge).

### Public agents (network council)

**Current flow:**
```
HealthMonitor alert → council.handleHealthAlert() → next reflection cycle → AI decides → spawn builder
```

**New flow:**
```
HealthMonitor alert → MessageBus (inbox for council orchestrator)
→ Council Orchestrator tick() (every 60s)
→ reads alert from inbox + board state
→ Tier 2: calls AI: "network alert: API crash. Board: 2 tasks in progress. What do?"
→ AI returns: [create_task("fix API crash"), spawn_worker("builder", task_id)]
→ Orchestrator creates Engineering sub-orchestrator if doesn't exist
→ Engineering orchestrator picks up task on its next tick
→ Engineering spawns builder worker
→ Builder fixes, reports via MCP
→ Engineering orchestrator reads report, spawns QA worker
→ QA passes → Engineering reports to Council via MessageBus
→ Council orchestrator reads report → propose_upgrade via governance
→ All nodes vote → pull → rebuild → restart
```

**Key difference:** Council doesn't spawn builders directly. It delegates to department orchestrators. Hierarchy in action.

### Comparison

| Aspect | Private (user project) | Public (network council) |
|---|---|---|
| Trigger | User message via gateway | Health alert, reflection, governance |
| Orchestrator level | Team (level 2) | Council (level 0) → Dept (level 1) → Team (level 2) |
| Hierarchy depth | 1 (project orchestrator → workers) | 3 (council → dept → team → workers) |
| Lifecycle | Created on demand, dissolved on completion | Persistent (council always running) |
| Governance | None (private work) | Full governance for code changes |
| Cross-team | No (single project) | Yes (engineering talks to QA via message bus) |

---

## Part 7: Gateway Integration

### What changes for the gateway

**Almost nothing.** The gateway talks to the node via HTTP API. The node's internal architecture changes, but the API surface stays the same.

### Updated API routes

| Route | Current Handler | New Handler |
|---|---|---|
| `POST /v1/chat/message` | → BridgeQueue → project agent | → MessageBus → project orchestrator |
| `GET /v1/chat/history` | → ThreadStore (unchanged) | → ThreadStore (unchanged) |
| `GET /v1/agents/tree` | → agent-manager in-memory registry | → SQLite `SELECT * FROM agent_identity` |
| `POST /v1/agents/spawn` | → agent-manager.spawnAgent() | → OrgManager.createOrchestrator() or WorkerPool.spawn() |
| `POST /v1/agents/:id/report` | → BridgeQueue event | → MessageBus insert |
| `GET /v1/scheduler/tasks` | → scheduler.getStatus() | → SQLite `SELECT * FROM tasks` |
| `GET /v1/council` | → council.getState() | → SQLite `SELECT * FROM agent_identity WHERE role='council'` |
| `POST /v1/council/message` | → council.handleMessage() | → MessageBus insert (council inbox) |
| `GET /v1/events` (SSE) | → api-server pushEvent() | → Same mechanism, but fed by orchestrator actions |

### New API routes (optional)

| Route | Purpose |
|---|---|
| `GET /v1/org/tree` | Full hierarchy: orchestrators + workers + tasks |
| `GET /v1/org/:id/board` | Task board for a specific orchestrator |
| `GET /v1/org/:id/inbox` | Message inbox for a specific orchestrator |
| `GET /v1/org/:id/log` | Tick log (decision history) |
| `GET /v1/org/:id/lessons` | Lessons learned |
| `POST /v1/org/:id/directive` | Add directive to orchestrator |

---

## Part 8: P2P Distribution

### Which node runs which orchestrator?

**Rule: Orchestrators run on Claude Code-capable nodes only.**

| Orchestrator | Node Selection | Why |
|---|---|---|
| Council (top-level) | Top 3 reputation nodes with Claude Code | Same as current council selection |
| Engineering dept | Node with most compute capability | Builders need CPU/disk |
| QA dept | Any Claude Code node | Testers need browser access (Playwright) |
| User project | Node that received the user message | Locality — minimize latency |
| Finance/Operations | Council node (shared) | Lightweight, no heavy compute |

### Cross-node orchestrator communication

When orchestrators are on different nodes:

```
Engineering Orchestrator (EC2-1)
  → MessageBus.send(recipient='qa-dept', ...)
  → OrgManager detects: recipient is on different node
  → RequestReplyManager.request(EC2-2, 'pando/org-message', payload)
  → EC2-2 receives → inserts into local MessageBus
  → QA Orchestrator reads on next tick
```

**Same mechanism as current P2P storage proxy.** Just a new handler type: `pando/org-message`.

### Council redundancy

All 3 council nodes run the council orchestrator independently. They share the same SQLite state via GossipSub sync (same pattern as task_queue sync). Only one acts as "primary" (highest reputation). Others are hot standby.

If primary goes down:
1. Other council nodes detect via heartbeat (GossipSub)
2. Next highest reputation becomes primary
3. Reads same board from SQLite (synced)
4. Continues ticking without interruption

---

## Part 9: Unified Agent Identity

### The problem with 15 scattered systems

Today, an agent's identity is assembled from 15 different sources:

1. `agent-manager.ts` in-memory registry (who exists)
2. `agent.ts` class fields (state, budget, workspace)
3. `bridge-queue.ts` subscriptions (who gets messages)
4. `CLAUDE.md` Layer 1: system rules
5. `CLAUDE.md` Layer 2: project context
6. `CLAUDE.md` Layer 3: standing directives
7. `CLAUDE.md` Layer 4: immediate task
8. Template files (`genome/templates/*.md`) — role definitions
9. `project-state.md` in workspace — project memory
10. `.claude/settings.json` — tool permissions
11. `session.json` — Claude Code session ID
12. `scheduler.ts` task assignments
13. `directives.json` — standing directives
14. `council.ts` active task state machine
15. Genome knowledge files — architectural knowledge

No single place to answer: "Who is this agent? What does it know? What's it doing? Who does it report to?"

### The solution: one table, one record, one truth

**Every agent — worker or orchestrator — gets a single row in the `agent_identity` table.**

```sql
CREATE TABLE agent_identity (
    -- Core identity
    id TEXT PRIMARY KEY,                  -- unique agent ID
    role TEXT NOT NULL,                   -- 'builder', 'tester', 'council', 'engineering', etc.
    type TEXT NOT NULL,                   -- 'worker' or 'orchestrator'
    scope TEXT NOT NULL DEFAULT 'private', -- 'private' (user only) or 'public' (network)
    parent_id TEXT,                       -- who this agent reports to (NULL = top-level)
    node_id TEXT,                         -- which node runs this agent
    status TEXT DEFAULT 'pending',        -- 'pending', 'spawning', 'active', 'idle', 'done', 'failed', 'dissolved'

    -- Authority & security
    authority TEXT,                       -- JSON: what this agent can do (see Part 12)
    file_scope TEXT,                      -- assigned files (prevent merge conflicts)
    budget_spent REAL DEFAULT 0,
    budget_limit REAL DEFAULT 50,

    -- Context
    project_id TEXT,                      -- which project this agent works on
    workspace_dir TEXT,                   -- filesystem path to workspace
    current_task_id TEXT,                 -- what task is currently assigned
    role_prompt TEXT,                     -- the AI prompt that defines this agent's behavior
    context_version TEXT,                 -- hash of last assembled context (for cache invalidation)

    -- Session & process
    session_id TEXT,                      -- Claude Code session ID (for resume/rotate)
    pid INTEGER,                         -- OS process ID (workers only)
    persistent INTEGER DEFAULT 0,        -- 1 = survive across tasks (orchestrators)

    -- Orchestrator-specific
    tick_interval_ms INTEGER,            -- how often to tick (orchestrators only)
    last_tick_at TEXT,
    max_workers INTEGER DEFAULT 10,
    max_children INTEGER DEFAULT 5,

    -- Worker-specific
    last_report_at TEXT,

    -- Timestamps
    created_at TEXT NOT NULL,
    updated_at TEXT,
    FOREIGN KEY (parent_id) REFERENCES agent_identity(id)
);

-- Indexes
CREATE INDEX idx_identity_parent ON agent_identity(parent_id);
CREATE INDEX idx_identity_project ON agent_identity(project_id);
CREATE INDEX idx_identity_status ON agent_identity(status, type);
CREATE INDEX idx_identity_node ON agent_identity(node_id);
```

### What this replaces

| Old source | Now lives in |
|---|---|
| agent-manager in-memory registry | `agent_identity` table |
| agent.ts class fields | `agent_identity` table |
| bridge-queue subscriptions | `message_inbox.recipient_id` → `agent_identity.id` |
| CLAUDE.md layers 1-4 | `assembleContext()` reads from agent_identity + tasks + lessons |
| Template files | `agent_identity.role_prompt` (short version — not 365 lines) |
| project-state.md | Tasks table + lessons table (queryable, not a markdown file) |
| session.json | `agent_identity.session_id` |
| scheduler task assignments | `agent_identity.current_task_id` |
| directives.json | `directives` table |
| council active tasks | Tasks table with `orchestrator_id` |

### The full unified schema

```sql
-- Agent identity (replaces 15 scattered sources)
-- See above

-- Tasks (extends existing, adds orchestrator ownership)
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    orchestrator_id TEXT REFERENCES agent_identity(id),
    worker_id TEXT REFERENCES agent_identity(id),
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',       -- 'pending', 'assigned', 'in_progress', 'qa', 'done', 'failed'
    priority INTEGER DEFAULT 1,
    file_scope TEXT,                      -- JSON array of assigned files
    parent_task_id TEXT,
    attempt_number INTEGER DEFAULT 1,
    max_attempts INTEGER DEFAULT 3,
    created_at TEXT NOT NULL,
    updated_at TEXT
);

-- Message inbox (replaces bridge-queue.ts)
CREATE TABLE message_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_id TEXT NOT NULL REFERENCES agent_identity(id),
    sender_id TEXT NOT NULL,
    sender_type TEXT NOT NULL,           -- 'worker', 'orchestrator', 'user', 'system'
    type TEXT NOT NULL,
    payload TEXT NOT NULL,               -- JSON
    priority INTEGER DEFAULT 1,
    signature TEXT,                       -- Ed25519 for cross-node
    created_at TEXT NOT NULL,
    read_at TEXT
);
CREATE INDEX idx_inbox_recipient ON message_inbox(recipient_id, read_at, priority);

-- Tick log (replaces council-minutes.md)
CREATE TABLE tick_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestrator_id TEXT NOT NULL REFERENCES agent_identity(id),
    tick_number INTEGER NOT NULL,
    tier INTEGER NOT NULL,               -- 1=deterministic, 2=AI judgment
    board_snapshot TEXT,                  -- JSON
    ai_input TEXT,
    ai_output TEXT,
    actions_taken TEXT,                   -- JSON
    duration_ms INTEGER,
    created_at TEXT NOT NULL
);

-- Lessons (per-orchestrator learning)
CREATE TABLE lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestrator_id TEXT NOT NULL REFERENCES agent_identity(id),
    project_id TEXT,
    lesson TEXT NOT NULL,
    source TEXT,                          -- 'qa_failure', 'build_error', 'timeout', 'worker_suggestion'
    relevance_tags TEXT,                  -- JSON array: ['builder', 'testing', 'deployment']
    times_used INTEGER DEFAULT 0,
    confidence REAL DEFAULT 1.0,         -- 0.0-1.0, decreases if lesson leads to failures
    created_at TEXT NOT NULL,
    last_used_at TEXT
);
CREATE INDEX idx_lessons_orch ON lessons(orchestrator_id);
CREATE INDEX idx_lessons_project ON lessons(project_id);

-- Org knowledge (cross-team, institutional memory)
CREATE TABLE org_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,              -- 'architecture', 'debugging', 'patterns', 'deployment'
    knowledge TEXT NOT NULL,
    source TEXT,                          -- which orchestrator/project produced this
    relevance_tags TEXT,                  -- JSON array
    times_used INTEGER DEFAULT 0,
    confidence REAL DEFAULT 1.0,
    created_at TEXT NOT NULL,
    last_used_at TEXT
);

-- Directives (founder/admin instructions to orchestrators)
CREATE TABLE directives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT,                       -- orchestrator ID, or NULL for all
    content TEXT NOT NULL,
    added_by TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
);

-- Reflection log (self-healing growth records)
CREATE TABLE reflections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestrator_id TEXT NOT NULL REFERENCES agent_identity(id),
    level TEXT NOT NULL,                 -- 'task', 'project', 'pattern', 'organization'
    trigger TEXT NOT NULL,               -- 'task_complete', 'task_failed', 'project_complete', 'weekly_review'
    input_summary TEXT,                  -- what was analyzed
    output TEXT NOT NULL,                -- AI reflection output (lessons extracted)
    lessons_created INTEGER DEFAULT 0,   -- how many lessons were recorded
    created_at TEXT NOT NULL
);
```

---

## Part 10: Context Assembly & Session Persistence

### The problem

Today, a worker's context is assembled from many scattered places, and the assembly logic is spread across agent.ts, agent-manager.ts, and template files. There's no single function that answers: "Given this agent, what CLAUDE.md should it get?"

### The solution: assembleContext()

One function. Takes an agent ID. Returns everything needed to start (or resume) a worker.

```typescript
async function assembleContext(agentId: string): Promise<AssembledContext> {
    const identity = db.get('SELECT * FROM agent_identity WHERE id = ?', agentId);

    // Layer 1: Role template (now ~50 lines, not 365)
    const template = loadTemplate(identity.role);
    // Templates are short — just the role description and behavioral rules.
    // No project context, no task details, no instructions about other agents.

    // Layer 2: Project context (if applicable)
    let projectContext = '';
    if (identity.project_id) {
        const project = db.get('SELECT * FROM projects WHERE id = ?', identity.project_id);
        const recentTasks = db.all(
            'SELECT * FROM tasks WHERE project_id = ? ORDER BY updated_at DESC LIMIT 10',
            identity.project_id
        );
        projectContext = formatProjectState(project, recentTasks);
    }

    // Layer 3: Task context (current assignment + previous attempts)
    let taskContext = '';
    if (identity.current_task_id) {
        const task = db.get('SELECT * FROM tasks WHERE id = ?', identity.current_task_id);
        const previousAttempts = db.all(
            'SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_number',
            identity.current_task_id
        );
        taskContext = formatTaskContext(task, previousAttempts);
    }

    // Layer 4: Memory + directives (institutional knowledge)
    const lessons = db.all(
        `SELECT * FROM lessons
         WHERE (orchestrator_id = ? OR project_id = ?)
         AND confidence > 0.5
         ORDER BY times_used DESC, created_at DESC LIMIT 10`,
        identity.parent_id, identity.project_id
    );
    const orgKnowledge = db.all(
        `SELECT * FROM org_knowledge
         WHERE relevance_tags LIKE ?
         ORDER BY times_used DESC LIMIT 5`,
        `%${identity.role}%`
    );
    const directives = db.all(
        `SELECT * FROM directives
         WHERE active = 1 AND (target_id = ? OR target_id IS NULL)`,
        agentId
    );

    // Layer 5: Authority (what this agent can and cannot do)
    const authority = JSON.parse(identity.authority || '{}');

    // Assemble final CLAUDE.md
    const claudeMd = [
        `# You are a Pando ${identity.role}`,
        `Agent ID: ${identity.id}`,
        `Scope: ${identity.scope}`,
        `Reports to: ${identity.parent_id}`,
        '',
        '## Your Role',
        template,
        '',
        '## Authority',
        formatAuthority(authority),
        '',
        projectContext ? `## Project State\n${projectContext}` : '',
        taskContext ? `## Current Task\n${taskContext}` : '',
        '',
        '## Lessons from Previous Work',
        formatLessons(lessons, orgKnowledge),
        '',
        directives.length ? `## Directives\n${formatDirectives(directives)}` : '',
        '',
        '## Tools Available',
        '- `get_my_task()` — get your current task assignment (call this if you forget what you\'re doing)',
        '- `report_progress(status, summary)` — report to your orchestrator',
        '- `get_my_identity()` — see who you are and what you can do',
    ].filter(Boolean).join('\n');

    // Determine session strategy
    const sessionStrategy = determineSessionStrategy(identity);

    // MCP config for this worker
    const mcpConfig = {
        tools: ['get_my_task', 'report_progress', 'get_my_identity'],
        endpoint: `http://localhost:${mcpPort}/worker/${identity.id}`,
    };

    return { claudeMd, mcpConfig, sessionStrategy };
}
```

### Session persistence strategy

The orchestrator decides the session strategy for each worker. Three options:

```
┌─────────────────────────────────────────────────────────┐
│                SESSION STRATEGY TREE                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Is this the same project as last time?                │
│  ├── NO → FRESH START                                   │
│  │   New session, new workspace, clean slate            │
│  │                                                      │
│  └── YES → Is the worker continuing the same task?     │
│       ├── YES → RESUME                                  │
│       │   Same session ID, same workspace               │
│       │   claude -p --continue --resume <sessionId>     │
│       │   Context might be partially compacted           │
│       │   MCP tools provide safety net                  │
│       │                                                  │
│       └── NO (new task, same project) → ROTATE          │
│           New session, SAME workspace                    │
│           Fresh context but all project files present    │
│           Worker reads project state via MCP tools       │
└─────────────────────────────────────────────────────────┘
```

**Decision logic:**
```typescript
function determineSessionStrategy(identity: AgentIdentity): SessionStrategy {
    if (!identity.session_id) return 'fresh';

    const lastTask = db.get(
        'SELECT * FROM tasks WHERE worker_id = ? ORDER BY updated_at DESC LIMIT 1',
        identity.id
    );

    // Same task, still in progress → resume
    if (lastTask && lastTask.id === identity.current_task_id && lastTask.status === 'in_progress') {
        return 'resume';
    }

    // Different task but same project → rotate (new session, keep workspace)
    if (lastTask && lastTask.project_id === identity.project_id) {
        return 'rotate';
    }

    // Different project entirely → fresh start
    return 'fresh';
}
```

### Private user scenario walkthrough

**Day 1: User wants a bakery website**

```
1. User sends "build me a bakery website" via gateway
2. POST /v1/chat/message → MessageBus (no orchestrator exists yet)
3. OrgManager creates project orchestrator:
   INSERT INTO agent_identity (id, role, type, scope, project_id, ...)
   VALUES ('orch-bakery-123', 'user_project', 'orchestrator', 'private', 'proj-bakery', ...)
4. Orchestrator tick #1:
   - Reads inbox: "user wants a bakery website"
   - Tier 2 (needs AI): calls AI with user request
   - AI returns: [create_task("design homepage"), create_task("build menu page"), spawn_worker("builder")]
   - Executes actions
5. WorkerPool.spawn() called:
   - Creates workspace: ~/.pando/agents/worker-builder-456/
   - assembleContext('worker-builder-456') builds CLAUDE.md
   - Starts Claude Code with MCP tools
   - Worker starts building
6. Worker builds, calls report_progress('in_progress', 'homepage done, starting menu page')
7. Worker calls report_progress('done', 'bakery site complete', ['index.html', 'menu.html'])
8. Orchestrator tick #N:
   - Reads inbox: worker reported done
   - Tier 2: calls AI: "builder says done. What next?"
   - AI returns: [spawn_worker("tester"), assign_task("test bakery site")]
   - QA worker tests, reports pass
   - Orchestrator deploys via DeployManager
   - Sends result to user via MessageBus → SSE
```

**Day 2: User comes back, wants to add online ordering**

```
1. User sends "add online ordering to my bakery site" via gateway
2. MessageBus routes to existing project orchestrator (orch-bakery-123)
3. Orchestrator tick:
   - Reads inbox: "add online ordering"
   - Reads board: project tasks from yesterday, lessons from yesterday's build
   - Tier 2: AI plans the addition, aware of existing codebase via project context
   - Spawns builder worker with ROTATE session strategy
     (new session, same workspace — all yesterday's files still there)
4. Worker gets CLAUDE.md with:
   - Project state: "Bakery site deployed. Pages: index.html, menu.html"
   - Lessons: "Used Tailwind for styling, vanilla JS for interactivity"
   - Task: "Add online ordering system"
5. Worker builds on existing code seamlessly
6. Same test → deploy cycle
```

**The key insight:** The workspace persists. The project context is in SQLite. The lessons are queryable. Even though the Claude Code session from yesterday is gone, the worker has everything it needs to continue.

---

## Part 11: The Agent Spectrum

### Same primitives, any scale

The architecture supports everything from a single inline task to a full organizational hierarchy. Here's the spectrum:

```
SCALE 0: Inline Task
────────────────────
One AI call. No worker. No orchestrator.
Example: "What's 2+2?"
Implementation: Direct AI call, return result.
Components used: ai-backend-claude.ts only.

SCALE 1: Single Worker
──────────────────────
One worker, no orchestrator overhead.
Example: "Fix this typo in index.html"
Implementation: WorkerPool.spawn() directly.
No tick loop needed — simple fire-and-forget.
Components used: WorkerPool + Worker MCP.

SCALE 2: Orchestrator + Workers
───────────────────────────────
One orchestrator managing 2-5 workers.
Example: "Build me a todo app"
Implementation: Project orchestrator with builder + tester workers.
Components used: Orchestrator + WorkerPool + Worker MCP + MessageBus.

SCALE 3: Department Hierarchy
─────────────────────────────
Parent orchestrator with child orchestrators.
Example: "Refactor the authentication system"
Implementation: Engineering orchestrator → frontend team + backend team + QA team.
Components used: All of the above + OrgManager.

SCALE 4: Full Organization
──────────────────────────
Council → departments → teams → workers.
Example: Pando self-maintenance (the current council use case).
Implementation: Council orchestrator → Engineering + QA + Operations + Finance.
Components used: Everything.

SCALE 5: Multi-Organization
───────────────────────────
Multiple independent organizations, potentially across nodes.
Example: Future — multiple projects with dedicated teams, CEO spawning a consulting org for a complex task.
Implementation: Multiple org trees, P2P coordination.
Components used: Everything + P2P org-message handler.
```

### What makes this work

**Same primitives at every scale.** An Orchestrator is an Orchestrator whether it's managing the entire network or building a landing page. A Worker is a Worker whether it's fixing a typo or implementing a payment system. The `assembleContext()` function, the `agent_identity` table, the `message_inbox`, the `tasks` table — all reused.

**Scale emerges from composition, not new code.** You don't need different systems for different scales. You just compose more orchestrators and workers.

### Net code impact

```
NEW CODE:
  orchestrator.ts          ~500 lines
  worker-pool.ts           ~200 lines
  worker-mcp.ts            ~100 lines
  message-bus.ts           ~150 lines
  org-manager.ts           ~250 lines
  ─────────────────────────────────
  Total new:             ~1,200 lines

DELETED CODE:
  council.ts             -1,234 lines
  agent-manager.ts       -2,097 lines
  bridge-queue.ts          -267 lines
  scheduler.ts             -852 lines
  ─────────────────────────────────
  Total deleted:         -4,450 lines

NET CHANGE:              -3,250 lines
```

**We're deleting 3x more than we're writing.** That's how you know the design is right.

---

## Part 12: Security Model — 3-Layer Defense

### The threat model

Agents are AI processes with real capabilities — they can read/write files, execute commands, access APIs, and communicate with other agents. A compromised or misbehaving agent could:
- Access data it shouldn't see (other users' projects, credentials)
- Manipulate other agents into doing unauthorized work
- Escalate its own privileges by talking to a higher-level agent
- Poison the institutional memory (lessons) to corrupt future work

### Layer 1: Communication Boundaries

**Who can talk to whom — enforced by MessageBus before message insertion.**

```
┌──────────────────────────────────────────────────────┐
│              ALLOWED COMMUNICATION PATHS              │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Worker → Parent Orchestrator     ✓  ALWAYS          │
│  (via MCP report_progress)                           │
│                                                      │
│  Orchestrator → Own Workers       ✓  ALWAYS          │
│  (via task assignment, kill)                         │
│                                                      │
│  Orchestrator → Parent Orch       ✓  ALWAYS          │
│  (escalation, reporting)                             │
│                                                      │
│  Orchestrator → Child Orch        ✓  ALWAYS          │
│  (delegation, directives)                            │
│                                                      │
│  Orchestrator → Sibling Orch      ✓  WITH REASON     │
│  (cross-team: routed through common parent)          │
│                                                      │
│  User → Project Orchestrator      ✓  IF AUTHORIZED   │
│  (owner of project only)                             │
│                                                      │
│  Worker → Worker                  ✗  NEVER           │
│  Worker → Non-parent Orch         ✗  NEVER           │
│  Worker → User                    ✗  NEVER (via orch)│
│  External → Any Agent             ✗  NEVER           │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Enforcement:** The `MessageBus.send()` function validates every message before insertion:

```typescript
function validateMessage(senderId: string, recipientId: string, senderType: string): boolean {
    const sender = db.get('SELECT * FROM agent_identity WHERE id = ?', senderId);
    const recipient = db.get('SELECT * FROM agent_identity WHERE id = ?', recipientId);

    // Workers can ONLY talk to their parent orchestrator
    if (sender.type === 'worker') {
        return recipient.id === sender.parent_id;
    }

    // Orchestrators can talk to: parent, children, siblings (same parent)
    if (sender.type === 'orchestrator') {
        if (recipient.id === sender.parent_id) return true;    // parent
        if (recipient.parent_id === sender.id) return true;    // child
        if (recipient.parent_id === sender.parent_id) return true;  // sibling
        return false;
    }

    // Users can only message their own project orchestrator
    if (senderType === 'user') {
        return recipient.project_id && recipient.scope === 'private';
    }

    return false;
}
```

### Layer 2: Authority Enforcement

**What each agent can do — defined in the `authority` JSON field.**

Every agent has an `authority` field that defines its capabilities. Authority inherits downward and can only **narrow**, never **widen**.

```typescript
interface AgentAuthority {
    // File system access
    files: {
        read: string[];      // glob patterns: ['src/components/**', 'package.json']
        write: string[];     // glob patterns: ['src/components/**']
        forbidden: string[]; // absolute deny: ['**/.env', '**/credentials*', 'kernel/**']
    };

    // Command execution
    commands: {
        allowed: string[];   // ['npm test', 'npm run build', 'npx playwright*']
        forbidden: string[]; // ['rm -rf', 'sudo*', 'curl*', 'wget*']
    };

    // API access
    api: {
        endpoints: string[]; // which node API endpoints this agent can call
        external: boolean;   // can it make external HTTP requests?
    };

    // Agent management
    agents: {
        canSpawn: boolean;       // can create child agents?
        canKill: boolean;        // can kill workers?
        maxWorkers: number;
        maxBudget: number;       // total Lux this agent can spend
    };

    // Data access
    data: {
        projects: string[];      // which project IDs this agent can access
        credentials: boolean;    // can access credential store? (almost always false)
    };
}
```

**Authority inheritance:**

```
Council Orchestrator
  authority: { files: { write: ['**'] }, agents: { canSpawn: true, maxBudget: 1000 } }
    │
    ├── Engineering Orchestrator
    │   authority: { files: { write: ['packages/**'] }, agents: { canSpawn: true, maxBudget: 500 } }
    │     │
    │     └── Builder Worker
    │         authority: { files: { write: ['packages/node/src/api/**'] }, agents: { canSpawn: false } }
    │         (further narrowed: only the specific files for this task)
    │
    └── QA Orchestrator
        authority: { files: { write: [] }, commands: { allowed: ['npm test*'] } }
          │
          └── Tester Worker
              authority: { files: { read: ['**'], write: [] }, commands: { allowed: ['npm test'] } }
              (read-only — testers don't modify code)
```

**Key rule:** A parent can NEVER grant a child more authority than it has itself. The `createOrchestrator()` and `spawn()` functions enforce this:

```typescript
function narrowAuthority(parentAuth: AgentAuthority, childAuth: Partial<AgentAuthority>): AgentAuthority {
    return {
        files: {
            read: intersectGlobs(parentAuth.files.read, childAuth.files?.read || parentAuth.files.read),
            write: intersectGlobs(parentAuth.files.write, childAuth.files?.write || parentAuth.files.write),
            forbidden: [...parentAuth.files.forbidden, ...(childAuth.files?.forbidden || [])],
        },
        commands: {
            allowed: intersect(parentAuth.commands.allowed, childAuth.commands?.allowed || parentAuth.commands.allowed),
            forbidden: [...parentAuth.commands.forbidden, ...(childAuth.commands?.forbidden || [])],
        },
        agents: {
            canSpawn: parentAuth.agents.canSpawn && (childAuth.agents?.canSpawn ?? false),
            maxBudget: Math.min(parentAuth.agents.maxBudget, childAuth.agents?.maxBudget || parentAuth.agents.maxBudget),
            maxWorkers: Math.min(parentAuth.agents.maxWorkers, childAuth.agents?.maxWorkers || parentAuth.agents.maxWorkers),
        },
        // ... similar for api, data
    };
}
```

### Layer 3: Message Signing (Cross-Node)

For messages that cross node boundaries (P2P), Ed25519 signatures are required.

```
Sending node:
1. Serialize message payload
2. Sign with node's Ed25519 private key
3. Include signature in message_inbox.signature field
4. Send via P2P handler 'pando/org-message'

Receiving node:
1. Extract sender's public key from peerId
2. Verify signature against payload
3. Reject if invalid
4. Insert into local message_inbox if valid
```

**Same mechanism as existing P2P message signing in `network.ts`.** No new crypto needed.

### Poisoned lessons defense

The institutional memory (lessons table) is a potential attack vector. A malicious agent could insert bad lessons that corrupt future workers.

**Defense:**
1. **Only orchestrators write to the lessons table.** Workers suggest lessons via `report_progress(suggestions: [...])`, but the orchestrator's AI reviews them before recording.
2. **Confidence scoring.** Each lesson has a `confidence` field (0.0-1.0). If a lesson is used and the resulting task fails, confidence drops. Low-confidence lessons are excluded from `assembleContext()`.
3. **Source tracking.** Every lesson records which orchestrator/project created it. If a pattern of bad lessons traces to one source, the entire source can be quarantined.
4. **Human review gate.** Lessons promoted to `org_knowledge` (cross-team) require a reflection review by a higher-level orchestrator before becoming broadly available.

---

## Part 13: Communication Patterns — The Only 4 Paths

### Why only 4 patterns

Unrestricted agent-to-agent communication is chaos. Every agent can message every other agent? That's how you get:
- Workers going rogue (asking other workers to help, bypassing orchestrator)
- Orchestrators stepping on each other (two orchestrators assigning the same file)
- Message storms (broadcast to 100 agents = 100 responses = 10,000 follow-ups)
- Lost accountability (who authorized this action?)

### The 4 allowed patterns

```
PATTERN 1: Worker → Parent Orchestrator (REPORTING)
────────────────────────────────────────────────────
How: MCP tool report_progress()
What: Status updates, completion reports, questions, difficulties, suggestions
When: Worker decides (on progress, on completion, when stuck)
Direction: Always upward
Example: Builder calls report_progress('done', 'homepage complete', files: ['index.html'])

PATTERN 2: Orchestrator → Own Worker (DIRECTING)
────────────────────────────────────────────────
How: Task assignment via SQLite + kill signal via WorkerPool
What: Task assignments, context updates, termination
When: Orchestrator decides during tick()
Direction: Always downward
Example: Orchestrator assigns new task, or kills worker that's over budget

PATTERN 3: Orchestrator → Orchestrator (COORDINATING)
─────────────────────────────────────────────────────
How: MessageBus.send() (parent↔child, sibling↔sibling via common parent)
What: Task delegation, status reports, cross-team requests, escalations
When: Orchestrator decides during tick()
Direction: Up (escalate), down (delegate), or sideways (cross-team via parent)
Example: Engineering orch tells QA orch "build ready for testing"

PATTERN 4: User → Project Orchestrator (REQUESTING)
───────────────────────────────────────────────────
How: HTTP API → MessageBus insert
What: New requests, feedback on results, project modifications
When: User sends via gateway
Direction: Inward (external → system boundary)
Example: User sends "add a contact page" via chat
```

### What's explicitly NOT allowed

| Pattern | Why Blocked |
|---|---|
| Worker → Worker | No coordination without orchestrator knowledge. Prevents rogue collaboration. |
| Worker → Non-parent Orch | Workers don't know about other orchestrators. Prevents privilege escalation. |
| Worker → User directly | All user communication goes through the project orchestrator. Prevents unfiltered output. |
| External → Any Agent | All external input enters through HTTP API → MessageBus. No direct agent access. |
| Orchestrator → Unrelated Orch | Cross-team messages must route through common ancestor. Prevents shadow hierarchies. |

### Message format

All messages through the system use a consistent format:

```typescript
interface AgentMessage {
    id: number;                  // auto-increment
    sender_id: string;           // agent_identity.id
    sender_type: 'worker' | 'orchestrator' | 'user' | 'system';
    recipient_id: string;        // agent_identity.id
    type: string;                // categorizes the message
    payload: {
        // Pattern 1 (worker reports):
        status?: 'in_progress' | 'done' | 'stuck' | 'question' | 'failed';
        summary?: string;
        files_changed?: string[];
        difficulties?: string[];  // what was hard
        suggestions?: string[];   // ideas for improvement
        error?: string;

        // Pattern 2 (orchestrator directives):
        task_id?: string;
        action?: 'assign' | 'reassign' | 'cancel';
        notes?: string;

        // Pattern 3 (cross-team):
        request_type?: 'delegate' | 'escalate' | 'inform' | 'request_review';
        context?: string;

        // Pattern 4 (user):
        message?: string;
        project_id?: string;
    };
    priority: 0 | 1 | 2;        // 0=critical, 1=normal, 2=low
    signature?: string;          // Ed25519 (cross-node only)
    created_at: string;
    read_at?: string;
}
```

---

## Part 14: Self-Healing & Growth — The Learning Loop

### How the system gets smarter over time

This is the core differentiator. Most AI agent systems are stateless — every new task starts from zero. Pando's orchestrator system accumulates institutional knowledge:

```
┌─────────────────────────────────────────────────────────┐
│                   THE GROWTH LOOP                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  1. Worker does task                                    │
│     └── Reports difficulties + suggestions via MCP      │
│                                                         │
│  2. Orchestrator reflects on completion                 │
│     └── AI extracts lessons from worker report           │
│     └── Stores in lessons table with relevance tags      │
│                                                         │
│  3. Next worker gets context from assembleContext()     │
│     └── Relevant lessons injected into CLAUDE.md         │
│     └── Worker starts smarter than predecessor           │
│                                                         │
│  4. That worker reports back                            │
│     └── Confirms/contradicts previous lessons            │
│     └── Orchestrator updates confidence scores           │
│                                                         │
│  5. Over time: high-confidence lessons promoted          │
│     └── lessons → org_knowledge (cross-team)             │
│     └── Available to ALL workers across all projects     │
│                                                         │
│  6. System gets smarter without any human intervention  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Workers report naturally (not forms)

Workers don't fill out structured forms. They report through `report_progress()` with optional fields:

```typescript
// Worker calls this when done:
report_progress({
    status: 'done',
    summary: 'Built the contact form with email validation',
    files_changed: ['src/contact.html', 'src/validate.js'],
    difficulties: [
        'Email regex was tricky — used RFC 5322 compliant pattern',
        'Had to install nodemailer for SMTP — added to package.json'
    ],
    suggestions: [
        'Consider adding a CAPTCHA for spam prevention',
        'The SMTP config should be in environment variables, not hardcoded'
    ]
});
```

The worker reports what it naturally noticed. No forced structure. The orchestrator's AI extracts lessons from this unstructured feedback.

### Reflection hierarchy

Reflections happen at four levels, triggered at different frequencies:

```
Level 1: TASK REFLECTION (after every task completion)
──────────────────────────────────────────────────────
Trigger: Worker reports 'done' or 'failed'
Who reflects: The worker's orchestrator
Input: Worker report + task description + outcome
AI prompt: "This worker just completed/failed task X. What can we learn?"
Output: 0-3 lessons stored in lessons table
Cost: Very cheap (1 short AI call per task)
Example lesson: "When building forms, always add client-side validation first"

Level 2: PROJECT REFLECTION (when project milestone completes)
─────────────────────────────────────────────────────────────
Trigger: All tasks in a project phase done, or project complete
Who reflects: The project orchestrator
Input: All task results + all worker reports + all lessons so far
AI prompt: "This project phase is done. What patterns do you see?"
Output: 2-5 lessons, some promoted to org_knowledge
Cost: Moderate (1 medium AI call per project milestone)
Example lesson: "For e-commerce projects, always set up payment testing early"

Level 3: PATTERN REFLECTION (weekly, or after 10+ tasks)
────────────────────────────────────────────────────────
Trigger: Time-based (weekly) or count-based (every 10 tasks)
Who reflects: Department orchestrator (engineering, QA)
Input: All lessons from the period, grouped by theme
AI prompt: "Here are 10 lessons from last week. What patterns emerge?"
Output: 1-3 high-level patterns for org_knowledge
Cost: Moderate (1 medium AI call per week per department)
Example pattern: "TypeScript strict mode catches 40% of bugs before testing"

Level 4: ORGANIZATIONAL REFLECTION (monthly, or on major events)
───────────────────────────────────────────────────────────────
Trigger: Monthly review, or after major incident
Who reflects: Council orchestrator
Input: All org_knowledge entries, all department reports, system health metrics
AI prompt: "Review the organization's knowledge base. What should change?"
Output: Strategic directives, architecture decisions, process improvements
Cost: Expensive (1 long AI call per month)
Example output: "We should standardize on Playwright for all testing — QA failures dropped 60% after switching"
```

### Failed tasks produce the most valuable lessons

When a task fails, the orchestrator does a deeper analysis:

```typescript
async function reflectOnFailure(orchestratorId: string, task: Task, workerReport: any) {
    const previousAttempts = db.all(
        'SELECT * FROM task_attempts WHERE task_id = ?',
        task.id
    );
    const existingLessons = db.all(
        'SELECT * FROM lessons WHERE orchestrator_id = ?',
        orchestratorId
    );

    const aiInput = {
        task: task.description,
        workerReport: workerReport,
        previousAttempts: previousAttempts,
        existingLessons: existingLessons.map(l => l.lesson),
        question: `This task failed ${previousAttempts.length} time(s). Analyze:
            1. What went wrong?
            2. Was the task description clear enough?
            3. Did the worker have the right tools/access?
            4. Is there a lesson we should record for future workers?
            5. Should we change our approach or escalate?`
    };

    const reflection = await callAI(aiInput);

    // Record lessons with high relevance
    for (const lesson of reflection.lessons) {
        db.run(
            'INSERT INTO lessons (orchestrator_id, lesson, source, relevance_tags, confidence) VALUES (?, ?, ?, ?, ?)',
            orchestratorId, lesson.text, 'task_failure', JSON.stringify(lesson.tags), 0.8
        );
    }

    // Record the reflection itself
    db.run(
        'INSERT INTO reflections (orchestrator_id, level, trigger, input_summary, output, lessons_created) VALUES (?, ?, ?, ?, ?, ?)',
        orchestratorId, 'task', 'task_failed',
        `Task "${task.title}" failed after ${previousAttempts.length} attempts`,
        JSON.stringify(reflection), reflection.lessons.length
    );

    return reflection;
}
```

### Lesson lifecycle

```
Created → Active (injected into workers) → Confirmed/Contradicted → Matured/Deprecated

1. CREATED: Orchestrator AI extracts lesson from worker report
   confidence: 1.0, times_used: 0

2. ACTIVE: Lesson included in assembleContext() for relevant workers
   confidence: 1.0, times_used: 1+

3. CONFIRMED: Worker using lesson succeeds → confidence stays high
   confidence: 1.0, times_used: N+1

4. CONTRADICTED: Worker using lesson fails → confidence drops
   confidence: 0.6 (drop by 0.2 per failure)

5. MATURED: Lesson used 10+ times with high confidence → promoted to org_knowledge
   Becomes available to ALL workers across projects

6. DEPRECATED: Confidence drops below 0.3 → excluded from assembleContext()
   Still in DB (never deleted) but no longer injected
```

### What this means in practice

After 100 tasks:
- The system has ~200 lessons in the lessons table
- ~30 have been promoted to org_knowledge
- ~15 have been deprecated (bad lessons auto-filter out)
- New workers start with 10-15 relevant lessons injected
- Build times decrease, error rates drop, QA pass rates increase
- All without any human writing documentation or training materials

After 1,000 tasks:
- The system effectively has "institutional expertise"
- Common patterns are well-understood and automatically communicated
- Rare edge cases have specific lessons that surface when relevant
- The org_knowledge table becomes a living, self-curating knowledge base

---

## Part 15: Migration Path

### Phase 1: Build Orchestrator standalone (no integration)
- New files: `orchestrator.ts`, `worker-pool.ts`, `worker-mcp.ts`, `message-bus.ts`, `org-manager.ts`
- New SQLite tables added to existing task-database.ts
- Test: single orchestrator + 3 workers, prove the tick loop works
- **Zero impact on existing system.** New files only.

### Phase 2: Wire gateway to new system
- Add new API routes (`/v1/org/*`)
- Route `POST /v1/chat/message` to MessageBus (new path) alongside existing BridgeQueue (dual-write)
- Gateway can query both old and new systems
- **Both systems running in parallel.** Compare results.

### Phase 3: Replace council
- Create council orchestrator that does what council.ts does: read health alerts, call AI, spawn builders
- Run both council.ts AND council orchestrator for 1 week
- Compare decisions (audit both tick_log and council-minutes.md)
- When confident: disable council.ts, enable orchestrator as primary
- **Gradual cutover.** No big bang.

### Phase 4: Replace agent-manager
- Route all agent spawning through WorkerPool + OrgManager
- Route all events through MessageBus
- Disable bridge-queue.ts
- Delete agent-manager.ts
- **Final cutover.** Old system removed.

### Phase 5: Cleanup
- Delete: council.ts, bridge-queue.ts, agent-manager.ts (old versions)
- Delete: scheduler.ts (merged into orchestrator)
- Delete: `~/.pando/council/` (state now in SQLite)
- Update genome docs
- **Clean codebase.** Single source of truth.

---

## Part 16: Resolved Decisions & Remaining Open Questions

### Resolved (from brainstorming)

| Question | Decision | Rationale |
|---|---|---|
| Worker MCP — how much state? | Task + identity + recent lessons. No conversation history. | MCP is a safety net, not a memory system. assembleContext() handles initial context. |
| Worker lifetime | Configurable per-orchestrator. Default: one task = one worker. Can persist for multiple tasks in same project. | Session strategy (resume/rotate/fresh) handles this. |
| SQLite vs separate database | Same SQLite file. agent_identity, tasks, lessons, messages all in one DB. | One transaction can span all tables. Simpler. |
| Forms vs natural reporting | Natural reporting with optional fields. Orchestrator AI extracts structured lessons. | Workers shouldn't have reporting overhead. Let AI do the analysis. |
| Single agent manager? | Yes: the OrgManager + Orchestrator + WorkerPool triad is the "single source of agent management." | 3 focused modules > 1 monolith. But they share the same SQLite DB = single source of truth. |
| Security model | 3-layer: communication boundaries + authority enforcement + message signing. | Each layer is independent. Compromise one, the others still hold. |
| Communication patterns | Only 4 paths allowed: worker↑orch, orch↓worker, orch↔orch, user→orch. | Minimizes attack surface. All paths auditable. |
| How system learns | Reflection hierarchy: task → project → pattern → organization. Natural reporting by workers, AI extraction by orchestrators. | No overhead for workers. Learning happens automatically. |
| Poisoned lessons | Only orchestrators write lessons. Confidence scoring. Source tracking. Human review for org_knowledge promotion. | Multiple independent defenses. |

### Still open

| # | Question | Context | Options |
|---|---|---|---|
| 1 | Tick interval tuning | How aggressive should each level tick? | Council: 60s vs 5min. Dept: 30s. Team: 10s. Needs testing. |
| 2 | Orchestrator AI prompt templates | What exactly does the council-level AI prompt look like vs team-level? | Need to design exact prompts. Will emerge during Phase 1 testing. |
| 3 | Cost control | Each Tier 2 tick = AI call. Council at 60s = 1,440/day. | Tier 1/2 classification crucial. Expected: ~80% Tier 1 (free). |
| 4 | Observability UX | What does the gateway dashboard show? | Real-time tick log, worker activity, message flow, lesson count. Design during gateway phase. |
| 5 | Template size | How short can role templates be with MCP? | Current: 365 lines. Target: ~50 lines. Test during Phase 1. |
| 6 | Council hot standby sync | How do 3 council nodes stay in sync? | GossipSub (same as task sync). Need to verify latency acceptable. |
| 7 | Cross-node orchestrator migration | What if a node goes down with active orchestrators? | Parent detects via heartbeat, recreates on different node. Tasks in SQLite survive. |

---

## File Structure Summary

### New files to create:
```
packages/node/src/
  platform/
    orchestrator.ts          ← Core: tick loop + AI brain + action executor
    org-manager.ts           ← Hierarchy: create/dissolve orchestrators, route messages
  core/
    worker-pool.ts           ← Process mgmt: spawn/kill Claude Code workers
    worker-mcp.ts            ← MCP tools: get_my_task() + report_progress() + get_my_identity()
    message-bus.ts           ← SQLite-backed persistent message routing
```

### Files to modify:
```
packages/node/src/
  platform/
    task-database.ts         ← Add unified schema (agent_identity, message_inbox, tick_log, etc.)
    agent-tools.ts           ← Add orchestrator API routes
  api/
    platform-api.ts          ← Wire chat/projects to orchestrator
    core-api.ts              ← Wire agent routes to WorkerPool/OrgManager
  index.ts                   ← Wire orchestrator startup
```

### Files to delete (after migration):
```
packages/node/src/
  platform/
    council.ts               ← Replaced by orchestrator.ts
    scheduler.ts             ← Merged into orchestrator.ts
  core/
    bridge-queue.ts          ← Replaced by message-bus.ts
    agent-manager.ts         ← Split into worker-pool.ts + org-manager.ts
```
