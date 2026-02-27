# Agent System Integration — How the New Architecture Fits Into Pando

**Date**: 2026-02-27
**Status**: BRAINSTORM — mapping complete, build plan TBD
**Companion doc**: `docs/orchestrator-architecture.md` (the hierarchy & orchestrator design)

---

## FOR IMPLEMENTING AGENTS: READ THIS FIRST

### What this document is
A complete mapping of how the brainstormed orchestrator architecture (from `orchestrator-architecture.md`) integrates into the existing Pando codebase. It answers: what stays, what changes, what's new, what gets deleted, and where files go.

### Table of contents
- **Part 1** (line ~50): Current system audit — every existing component, what it does, what's wrong with it
- **Part 2** (line ~220): What stays untouched — solid infrastructure that doesn't need changing
- **Part 3** (line ~310): What changes — existing code that gets refactored
- **Part 4** (line ~480): What's new — components that don't exist yet
- **Part 5** (line ~650): The split — how agent-manager.ts (2,097 lines) becomes 3 focused modules
- **Part 6** (line ~780): Private vs public agents — user projects vs network council
- **Part 7** (line ~880): Gateway integration — how the user-facing flow changes
- **Part 8** (line ~950): P2P distribution — which node runs which orchestrator
- **Part 9** (line ~1050): Migration path — how to transition without breaking the live network
- **Part 10** (line ~1130): Open questions for further brainstorming

### The one-paragraph summary
Pando already has 80% of what's needed — P2P networking, governance, task database, agent primitives, AI backend, capability profiles. The problem is a single 1,234-line file (council.ts) that puts orchestration logic inside an AI conversation, and a 2,097-line file (agent-manager.ts) that tries to be 6 systems at once. The fix: add an Orchestrator layer on top (from the companion doc), split agent-manager into 3 focused modules (WorkerPool, OrgManager, MessageBus), and replace council.ts with a deterministic tick loop that calls AI in short bursts. Everything below the orchestration layer — networking, governance, storage, the worker primitive — stays.

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
    type TEXT NOT NULL,              -- 'worker_report', 'health_alert', 'cross_team', 'user_request', 'directive'
    payload TEXT NOT NULL,           -- JSON
    priority INTEGER DEFAULT 1,     -- 0=critical, 1=normal, 2=low
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
├── MCP tool server (get_my_task, report_progress)
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

**New tables added to existing SQLite database:**

```sql
-- Orchestrator registry
CREATE TABLE orchestrators (
    id TEXT PRIMARY KEY,
    parent_id TEXT,                   -- NULL = top-level (council)
    role TEXT NOT NULL,               -- 'council', 'engineering', 'qa', 'user_project'
    level INTEGER NOT NULL,           -- 0=council, 1=dept, 2=team
    status TEXT DEFAULT 'active',     -- 'active', 'idle', 'dissolved'
    config TEXT,                      -- JSON: tick_interval, max_workers, role_prompt
    last_tick_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES orchestrators(id)
);

-- Task board (extends existing tasks table with orchestrator_id)
-- ALTER TABLE tasks ADD COLUMN orchestrator_id TEXT REFERENCES orchestrators(id);
-- ALTER TABLE tasks ADD COLUMN worker_id TEXT;
-- ALTER TABLE tasks ADD COLUMN file_scope TEXT;  -- assigned files (prevent overlap)

-- Message inbox (replaces bridge-queue.ts)
CREATE TABLE message_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    priority INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    read_at TEXT
);

-- Tick log (replaces council-minutes.md)
CREATE TABLE tick_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestrator_id TEXT NOT NULL,
    tick_number INTEGER NOT NULL,
    tier INTEGER NOT NULL,           -- 1=deterministic, 2=AI judgment
    board_snapshot TEXT,             -- JSON: what the board looked like
    ai_input TEXT,                   -- what was sent to AI (if tier 2)
    ai_output TEXT,                  -- what AI returned (if tier 2)
    actions_taken TEXT,              -- JSON: actions executed
    duration_ms INTEGER,
    created_at TEXT NOT NULL
);

-- Lessons (institutional memory)
CREATE TABLE lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestrator_id TEXT NOT NULL,
    lesson TEXT NOT NULL,
    source TEXT,                     -- 'qa_failure', 'build_error', 'timeout', etc.
    created_at TEXT NOT NULL
);

-- Org knowledge (cross-team learnings)
CREATE TABLE org_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,          -- 'architecture', 'debugging', 'patterns'
    knowledge TEXT NOT NULL,
    source TEXT,
    created_at TEXT NOT NULL
);

-- Worker registry (replaces in-memory agent registry)
CREATE TABLE workers (
    id TEXT PRIMARY KEY,
    orchestrator_id TEXT NOT NULL,
    role TEXT NOT NULL,              -- 'builder', 'tester', 'reviewer'
    status TEXT DEFAULT 'spawning',  -- 'spawning', 'active', 'idle', 'done', 'failed'
    pid INTEGER,                     -- OS process ID
    session_id TEXT,                 -- Claude Code session ID
    workspace_dir TEXT,
    task_id TEXT,                    -- current task assignment
    budget_spent REAL DEFAULT 0,
    budget_limit REAL DEFAULT 50,
    last_report_at TEXT,
    spawned_at TEXT NOT NULL,
    FOREIGN KEY (orchestrator_id) REFERENCES orchestrators(id)
);

-- Founder directives (replaces directives.json)
CREATE TABLE directives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    added_by TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
);
```

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
│   ├── Write CLAUDE.md (simplified — just role template + MCP config)
│   ├── Start Claude Code process
│   ├── Start MCP tool server (get_my_task, report_progress)
│   ├── Register in SQLite workers table
│   └── Return worker ID
│
├── kill(workerId: string): void
│   ├── SIGTERM the Claude Code process
│   ├── Update workers table: status = 'done' or 'failed'
│   └── Archive workspace (if configured)
│
├── getStatus(workerId: string): WorkerStatus
│   └── Read from workers table
│
├── listActive(): WorkerStatus[]
│   └── SELECT * FROM workers WHERE status IN ('active', 'spawning')
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
│   ├── Insert into orchestrators table
│   ├── Create tick interval (setInterval)
│   ├── Return orchestrator ID
│   └── Wire health alert routing
│
├── dissolve(orchestratorId): void
│   ├── Stop tick interval
│   ├── Kill all workers owned by this orchestrator
│   ├── Move lessons to org_knowledge (institutional memory)
│   ├── Update orchestrators table: status = 'dissolved'
│   └── Reassign orphaned tasks to parent
│
├── getTree(): OrgTree
│   └── SELECT with recursive CTE for full hierarchy
│
├── routeMessage(from, to, message): void
│   ├── If same orchestrator: direct insert to inbox
│   ├── If parent/child: direct insert to inbox
│   ├── If cross-team: route through common ancestor
│   └── If cross-node: P2P via RequestReplyManager
│
├── selectCouncil(): string[]
│   └── Same logic as current council.ts: top 3 reputation nodes with Claude Code
│
└── getOrchestratorForProject(projectId): string
    └── Find or create user project orchestrator
```

### 4.4 Worker MCP Tools (new file)

**Location:** `packages/node/src/core/worker-mcp.ts`

The worker's lifeline. 2 tools that survive any context compaction.

```
MCP Server (per worker)
├── get_my_task()
│   ├── Read current assignment from workers table
│   ├── Read task details from tasks table
│   ├── Return: { taskId, description, files, deadline, orchestratorNotes }
│   └── Worker calls this whenever it's confused or context-compacted
│
└── report_progress(status, summary, files_changed?)
    ├── Insert into message_inbox for worker's orchestrator
    ├── Update workers.last_report_at
    ├── If status == 'done': update task status, trigger orchestrator tick
    ├── If status == 'stuck': orchestrator sees this on next tick, decides action
    └── If status == 'question': orchestrator reads question, AI decides answer
```

**Why this is critical:**
Even if a worker's Claude Code session gets fully context-compacted and forgets everything — it still has MCP tools. When it calls `get_my_task()`, it gets its full task description back. It can continue working without any conversation history.

### 4.5 SQLite MessageBus (new, replaces bridge-queue.ts)

**Location:** `packages/node/src/core/message-bus.ts`

Persistent message routing. Replaces in-memory bridge queue.

```
MessageBus
├── send(recipientId, type, payload, priority?): void
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
| **Agent registry** (spawn, track, lookup) | Lines ~100-400 | **WorkerPool** (worker-pool.ts) + **SQLite workers table** | Registry moves to DB. WorkerPool just manages processes. |
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
| `GET /v1/agents/tree` | → agent-manager in-memory registry | → SQLite `SELECT * FROM orchestrators` + `workers` |
| `POST /v1/agents/spawn` | → agent-manager.spawnAgent() | → OrgManager.createOrchestrator() or WorkerPool.spawn() |
| `POST /v1/agents/:id/report` | → BridgeQueue event | → MessageBus insert |
| `GET /v1/scheduler/tasks` | → scheduler.getStatus() | → SQLite `SELECT * FROM tasks` |
| `GET /v1/council` | → council.getState() | → SQLite `SELECT * FROM orchestrators WHERE role='council'` |
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

## Part 9: Migration Path

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

## Part 10: Open Questions for Further Brainstorming

### 10.1 Worker MCP — how much state?
Should `get_my_task()` return just the current task, or also recent conversation context? If a worker's context compacts, should MCP restore some history?

### 10.2 Orchestrator AI prompt templates
What exactly does the council-level AI prompt look like vs team-level? How much context is injected per tick? Need to design exact prompts to keep AI calls fast and focused.

### 10.3 Tick interval tuning
Council: 60s? 5 min? Department: 30s? Team: 10s? How aggressive should ticking be? More ticks = faster response but more AI calls = more cost.

### 10.4 Worker lifetime
Should workers be truly ephemeral (one task, then killed)? Or should a builder worker live for multiple tasks within a project? Session reuse saves cold-start time but risks stale context.

### 10.5 SQLite vs separate database
All orchestrator state in the same ledger.db? Or a separate orchestrator.db? Separate avoids schema conflicts but complicates transactions that span tasks + orchestrator state.

### 10.6 Orchestrator-to-orchestrator learning
When Engineering discovers a pattern (e.g., "always run lint before build"), how does that knowledge propagate to other departments? Via org_knowledge table? Via council directive?

### 10.7 Human-in-the-loop for user projects
For private user projects, should the user be able to "talk to" the orchestrator? Or only to workers? Current gateway chat goes to the project agent. Should it go to the project orchestrator's inbox?

### 10.8 Cost control
Each AI call in orchestrator.tick() costs money. If council ticks every 60s with tier 2 (AI call), that's 1,440 AI calls/day. How to budget? Tier 1/2 classification reduces this but needs tuning.

### 10.9 Observability
What does the gateway dashboard show? Real-time tick log? Worker activity? Message flow? Need to design the monitoring UX for the new system.

### 10.10 Agent templates in new system
Current templates are designed for long-running AI conversations (manager.md is 365 lines). New workers with MCP need much shorter templates. What's the minimum viable template for a builder worker?

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
    worker-mcp.ts            ← MCP tools: get_my_task() + report_progress()
    message-bus.ts           ← SQLite-backed persistent message routing
```

### Files to modify:
```
packages/node/src/
  platform/
    task-database.ts         ← Add new tables (orchestrators, message_inbox, tick_log, etc.)
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
