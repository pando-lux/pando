# Phase: Agent Architecture Refactor — Work Plan

**Date**: 2026-02-27
**Status**: READY FOR REVIEW
**Prerequisites**: `docs/orchestrator-architecture.md` (design) + `docs/agent-system-integration.md` (integration mapping)

---

## Objective

Replace Pando's scattered agent orchestration system (~7,200 lines across 4 core files + templates) with a clean, unified architecture (~1,200 lines across 5 focused modules). No fallbacks. No legacy hacks. Clean break — things that break get fixed during testing.

### What we're building
1. **Orchestrator** — deterministic tick loop that calls AI in short stateless bursts
2. **WorkerPool** — spawn/kill Claude Code workers, nothing else
3. **Worker MCP** — 3 tools (get_my_task, report_progress, get_my_identity) that survive context compaction
4. **MessageBus** — SQLite-backed persistent message routing
5. **OrgManager** — hierarchy management, orchestrator lifecycle

### What we're deleting
1. `council.ts` (1,346 lines) — replaced by Orchestrator
2. `agent-manager.ts` (2,096 lines) — split into WorkerPool + OrgManager
3. `bridge-queue.ts` (266 lines) — replaced by MessageBus
4. `scheduler.ts` (851 lines) — merged into Orchestrator
5. `agent.ts` (1,279 lines) — simplified into thin Worker wrapper
6. All 8 template files in `genome/templates/` (1,209 lines) — replaced by short role prompts
7. Backup files: `council.ts.backup-original`, `council.ts.bak`, `council.ts.qa_backup`
8. Leftover scripts: `apply-council-changes.py`, `scripts/apply-council-changes.js`, `scripts/update-council-genome.py`, `scripts/write-and-commit-tests.py`, `scripts/write-council-final.js`

### Guiding principles
- **No dual-write, no parallel-run.** Old system gets deleted. New system takes over.
- **Let things break.** We fix during testing. No compatibility shims.
- **No stale logic.** If code references the old system, rewrite it or delete it.
- **Build must pass.** `npm run build` zero errors after every step.
- **Commit after every step.** Small, reviewable increments.

---

## Step 0: Pre-Work — Clean the Slate

### 0.1 Delete all legacy backup and script files
```
DELETE:
  packages/node/src/platform/council.ts.backup-original
  packages/node/src/platform/council.ts.bak
  packages/node/src/platform/council.ts.qa_backup  (if exists)
  apply-council-changes.py
  scripts/apply-council-changes.js
  scripts/update-council-genome.py
  scripts/write-and-commit-tests.py
  scripts/write-council-final.js
```

### 0.2 Delete old genome template files
```
DELETE:
  genome/templates/manager.md      (364 lines — replaced by short role prompts in DB)
  genome/templates/builder.md      (279 lines)
  genome/templates/tester.md       (92 lines)
  genome/templates/qa-adversarial.md (187 lines)
  genome/templates/reviewer.md     (68 lines)
  genome/templates/researcher.md   (66 lines)
  genome/templates/devops.md       (66 lines)
  genome/templates/council.md      (87 lines)
```

### 0.3 Identify and document ALL import chains
Before deleting anything, map every file that imports from the 4 core files:

| File to delete | Imported by |
|---|---|
| `agent-manager.ts` | `index.ts`, `platform-api.ts`, `agent-tools.ts`, `api-server.ts`, `core/index.ts` |
| `council.ts` | `index.ts`, `qa-memory.ts`, `platform/index.ts` |
| `bridge-queue.ts` | `agent-manager.ts`, `agent-tools.ts`, `scheduler.ts`, `core/index.ts` |
| `scheduler.ts` | `index.ts`, `platform-api.ts`, `monitor.ts` |
| `agent.ts` | `agent-manager.ts`, `core/index.ts` |

**Commit**: "Phase 0: Delete backup files, legacy scripts, old templates"

---

## Step 1: Build the Unified SQLite Schema

### 1.1 Create new schema file
**New file:** `packages/node/src/platform/agent-database.ts`

Tables to create:
- `agent_identity` — unified agent record (see integration doc Part 9)
- `message_inbox` — persistent message routing (see integration doc Part 3.3)
- `tick_log` — orchestrator decision audit trail
- `lessons` — per-orchestrator learning with confidence scoring
- `org_knowledge` — cross-team institutional memory
- `directives` — admin/founder instructions
- `reflections` — self-healing growth records

### 1.2 Migration from existing task tables
The existing `task-database.ts` has task tables. Either:
- **Option A:** Extend `task-database.ts` with new tables (simpler)
- **Option B:** Create separate `agent-database.ts` that manages agent-specific tables (cleaner separation)

**Decision needed during implementation.** Leaning toward Option A since both need to be in the same SQLite file for cross-table queries.

### 1.3 Write and test schema
- Create tables with proper indexes
- Write basic CRUD functions for each table
- Unit test: insert, read, update, delete for each table
- Verify foreign key constraints work

**Commit**: "Step 1: Unified agent SQLite schema"

---

## Step 2: Build MessageBus

### 2.1 Create MessageBus class
**New file:** `packages/node/src/core/message-bus.ts`

```
MessageBus
├── send(recipientId, senderId, senderType, type, payload, priority?)
├── read(recipientId, limit?)
├── markRead(messageIds[])
├── broadcast(type, payload)
├── cleanup(olderThanDays)
└── validateSender(senderId, recipientId)  ← communication boundary enforcement
```

### 2.2 Key requirements
- All messages persisted to SQLite `message_inbox` table
- Sender validation: workers can only message parent (see integration doc Part 12, Layer 1)
- Priority ordering: critical > normal > low, then FIFO within priority
- Ed25519 signature field for future cross-node messages
- No EventEmitter — orchestrators poll on tick, not event-driven

### 2.3 Tests
- Send message, read it back
- Priority ordering correct
- Sender validation: worker→parent ✓, worker→non-parent ✗
- markRead removes from unread query
- cleanup deletes old read messages

**Commit**: "Step 2: SQLite-backed MessageBus"

---

## Step 3: Build Worker MCP Tools

### 3.1 Create Worker MCP server
**New file:** `packages/node/src/core/worker-mcp.ts`

3 tools:
- `get_my_task()` — read current task from agent_identity + tasks tables
- `report_progress(status, summary, files_changed?, difficulties?, suggestions?)` — insert into message_inbox
- `get_my_identity()` — read agent_identity row, return role, authority, scope, budget

### 3.2 MCP server per worker
Each worker gets its own MCP server instance (different port or multiplexed).
The MCP server reads directly from SQLite — no in-memory state.

### 3.3 Tests
- Start MCP server for a test worker
- Call get_my_task() — returns correct task
- Call report_progress('done', 'test') — message appears in inbox
- Call get_my_identity() — returns correct authority/scope
- Worker with no task — get_my_task() returns helpful "no task assigned" message
- Context compaction simulation: call get_my_task() after clearing conversation — still works

**Commit**: "Step 3: Worker MCP tools"

---

## Step 4: Build WorkerPool

### 4.1 Create WorkerPool class
**New file:** `packages/node/src/core/worker-pool.ts`

```
WorkerPool
├── spawn(config: WorkerConfig): Promise<string>
│   ├── Create workspace directory
│   ├── Run assembleContext() to build CLAUDE.md
│   ├── Start Claude Code process (via ai-backend-claude.ts)
│   ├── Start Worker MCP server for this worker
│   ├── Insert into agent_identity table
│   └── Return worker ID
├── kill(workerId): void
├── getStatus(workerId): WorkerStatus
├── listActive(): WorkerStatus[]
└── cleanup(): void
```

### 4.2 Context assembly function
**In same file or separate:** `assembleContext(agentId)`

Builds CLAUDE.md from 5 layers:
1. Role prompt (short — ~50 lines, stored in agent_identity.role_prompt)
2. Project context (from tasks table + project metadata)
3. Current task (from tasks table)
4. Lessons + org_knowledge (relevant to this role/project)
5. Authority summary (what this agent can/cannot do)

### 4.3 Session strategy
`determineSessionStrategy(identity)` — returns `'fresh' | 'resume' | 'rotate'`
- Fresh: new session, new workspace
- Resume: same session ID, same workspace (for continuing same task)
- Rotate: new session, same workspace (different task, same project)

### 4.4 Tests
- Spawn a worker, verify agent_identity row created
- Verify CLAUDE.md written to workspace
- Verify MCP server started for worker
- Kill worker, verify status updated
- Session strategy: correct decision for fresh/resume/rotate
- assembleContext: correct output with lessons injected

**Commit**: "Step 4: WorkerPool + context assembly"

---

## Step 5: Build OrgManager

### 5.1 Create OrgManager class
**New file:** `packages/node/src/platform/org-manager.ts`

```
OrgManager
├── createOrchestrator(config): string
├── dissolve(orchestratorId): void
├── getTree(): OrgTree (recursive CTE)
├── routeMessage(from, to, message): void (with authority validation)
├── selectCouncil(): string[]
└── getOrchestratorForProject(projectId): string
```

### 5.2 Authority inheritance
`narrowAuthority(parentAuth, childAuth)` — child can never exceed parent's authority.

### 5.3 Tests
- Create orchestrator, verify agent_identity row
- Create child orchestrator, verify hierarchy
- dissolve: lessons promoted to org_knowledge, workers killed
- getTree: correct recursive hierarchy
- routeMessage: validates communication boundaries
- Authority: child cannot widen parent's restrictions

**Commit**: "Step 5: OrgManager + authority inheritance"

---

## Step 6: Build Orchestrator

### 6.1 Create Orchestrator class
**New file:** `packages/node/src/platform/orchestrator.ts`

This is the core — the deterministic tick loop.

```
Orchestrator
├── constructor(id, db, workerPool, orgManager, messageBus, aiBackend)
├── start(): void (setInterval)
├── stop(): void (clearInterval)
├── tick(): Promise<void>
│   ├── readBoard()    — get tasks for this orchestrator
│   ├── readInbox()    — get unread messages
│   ├── classify()     — tier 1 (deterministic) or tier 2 (AI)?
│   ├── callAI()       — if tier 2: short, 1-turn AI call
│   ├── execute()      — run actions from AI or deterministic logic
│   └── log()          — write tick_log entry
├── execute(action): Promise<void>
│   ├── spawn_worker, kill_worker
│   ├── assign_task, create_task
│   ├── send_message, escalate
│   ├── create_team, dissolve_team
│   ├── propose_upgrade, commit_code, deploy
│   └── record_lesson
└── readBoard(), readInbox(), markRead()
```

### 6.2 Tier classification
Most ticks are Tier 1 (deterministic):
- Worker reported 'done' → mark task done, check if more tasks
- Worker reported 'stuck' → retry or escalate (rule-based)
- All tasks done → report to parent

Tier 2 (needs AI judgment):
- New user request → plan tasks
- Worker failed multiple times → decide strategy
- Conflicting reports → resolve
- Idle with no tasks → self-improvement

### 6.3 AI brain prompt
The AI prompt is role-specific (council vs project vs QA). Short and focused:
- Current board state (JSON)
- Current inbox (JSON)
- Available actions (list)
- "What should I do? Return a JSON array of actions."

### 6.4 Tests
- Create orchestrator, start ticking
- Tier 1: worker done → task marked complete
- Tier 1: all tasks done → orchestrator goes idle
- Tier 2: new user request → AI returns task plan
- Tick log entries created
- Lesson recording after task completion (reflection)

**Commit**: "Step 6: Orchestrator — deterministic tick loop"

---

## Step 7: Wire Into PandoNode

### 7.1 Update index.ts
Replace the old wiring:

**Remove:**
```typescript
// OLD — delete these
this.agentManager = new AgentManager({...});
this.agentManager.start();
this.council = new Council({...});
this.council.start();
this.scheduler = new Scheduler({...});
this.scheduler.start();
```

**Add:**
```typescript
// NEW — the unified system
this.agentDb = new AgentDatabase(this.dataDir);
this.messageBus = new MessageBus(this.agentDb);
this.workerPool = new WorkerPool(this.agentDb, this.aiBackendRegistry, this.messageBus);
this.orgManager = new OrgManager(this.agentDb, this.workerPool, this.messageBus);

// Council orchestrator (if this node is a council member)
if (shouldRunCouncil) {
    this.councilOrchestrator = this.orgManager.createOrchestrator({
        role: 'council',
        level: 0,
        tickInterval: 60000,
        rolePrompt: COUNCIL_ROLE_PROMPT,
    });
}
```

### 7.2 Update barrel exports
- `core/index.ts` — export WorkerPool, MessageBus, worker-mcp
- `platform/index.ts` — export Orchestrator, OrgManager
- Remove exports for deleted files

### 7.3 Tests
- Node starts cleanly with new system
- `npm run build` passes
- No references to deleted modules remain

**Commit**: "Step 7: Wire new agent system into PandoNode"

---

## Step 8: Update HTTP API Routes

### 8.1 Update agent-tools.ts
Replace all agent-manager references with WorkerPool/OrgManager/MessageBus:

| Old route | New implementation |
|---|---|
| `POST /agents/spawn` | → `workerPool.spawn()` or `orgManager.createOrchestrator()` |
| `POST /agents/:id/message` | → `messageBus.send()` |
| `POST /agents/:id/report` | → `messageBus.send()` (worker report) |
| `GET /agents/tree` | → `orgManager.getTree()` |
| `GET /agents/:id/status` | → `db.get('SELECT * FROM agent_identity WHERE id = ?')` |
| `POST /agents/:id/directive` | → `db.run('INSERT INTO directives ...')` |

### 8.2 Update platform-api.ts
- `POST /v1/chat/message` → `messageBus.send()` to project orchestrator
- `GET /v1/scheduler/tasks` → direct SQLite query on tasks table
- Council routes → orchestrator queries

### 8.3 Update core-api.ts
- Remove agent-manager dependency
- Wire to WorkerPool/OrgManager

### 8.4 Add new org routes
```
GET  /v1/org/tree          — full hierarchy
GET  /v1/org/:id/board     — task board for orchestrator
GET  /v1/org/:id/inbox     — message inbox
GET  /v1/org/:id/log       — tick log
GET  /v1/org/:id/lessons   — lessons learned
POST /v1/org/:id/directive — add directive
```

### 8.5 Tests
- All existing API tests pass (adapted)
- New org routes return correct data
- Chat message reaches project orchestrator

**Commit**: "Step 8: Update HTTP API routes for new agent system"

---

## Step 9: Delete Legacy Code

### 9.1 Delete the old files
```
DELETE:
  packages/node/src/platform/council.ts
  packages/node/src/platform/scheduler.ts
  packages/node/src/core/agent-manager.ts
  packages/node/src/core/bridge-queue.ts
  packages/node/src/core/agent.ts
```

### 9.2 Clean up all references
Grep for any remaining imports/references to deleted modules. Fix every one:
- `import { AgentManager }` → gone
- `import { BridgeQueue }` → gone
- `import { Council }` → gone
- `import { Scheduler }` → gone
- `import { Agent }` → gone
- `this.agentManager` → `this.workerPool` / `this.orgManager`
- `this.council` → `this.councilOrchestrator`
- `this.scheduler` → (removed, orchestrator handles)

### 9.3 Clean up standing directive references
- `StandingDirective` interface → deleted (replaced by directives table)
- `project-state.md` pattern → deleted (replaced by tasks table + lessons)
- Watchdog timer → deleted (orchestrator tick handles)
- `AgentMemory`, `AgentState` → deleted (agent_identity table)

### 9.4 Verify build
```bash
npm run build  # MUST pass with zero errors
```

**Commit**: "Step 9: Delete legacy agent code — council, agent-manager, bridge-queue, scheduler, agent"

---

## Step 10: Update Documentation

### 10.1 Update genome knowledge files
Update any `.know` files that reference the old agent system:
- council component docs → describe Orchestrator
- agent-manager component docs → describe WorkerPool + OrgManager
- scheduler component docs → describe Orchestrator.tick()
- bridge-queue docs → describe MessageBus

### 10.2 Update CLAUDE.md
The root CLAUDE.md references many deleted files. Update:
- Key Files table → new file locations
- Architecture description → new system
- TUI commands → any agent-related commands
- Node HTTP API → new/changed endpoints

### 10.3 Update docs/
- `agent-system-integration.md` → mark as IMPLEMENTED, update status
- `orchestrator-architecture.md` → mark as IMPLEMENTED

### 10.4 Remove stale genome templates directory
If `genome/templates/` was deleted in Step 0, verify it's gone and no references remain.

**Commit**: "Step 10: Update documentation for new agent architecture"

---

## Step 11: Integration Testing

### 11.1 Unit tests for each new module
Already written per-step. Verify all pass together.

### 11.2 Integration test: single orchestrator + workers
1. Create project orchestrator
2. Send user message → orchestrator receives
3. Orchestrator creates tasks + spawns builder worker
4. Worker builds, reports done via MCP
5. Orchestrator reads report, spawns QA worker
6. QA tests, reports pass
7. Orchestrator marks project done

### 11.3 Integration test: hierarchy
1. Create council orchestrator
2. Council creates engineering sub-orchestrator
3. Engineering spawns builder
4. Builder reports → Engineering → Council
5. Verify message routing through hierarchy

### 11.4 Integration test: persistence
1. Start orchestrator + workers
2. Simulate node restart (stop all, restart from SQLite)
3. Verify orchestrators resume ticking
4. Verify workers re-discovered from agent_identity table
5. Verify no messages lost (SQLite MessageBus)

### 11.5 Integration test: security
1. Worker tries to message non-parent → rejected
2. Child orchestrator tries to exceed parent authority → narrowed
3. Cross-node message without signature → rejected

### 11.6 End-to-end: gateway chat
1. Start node with new system
2. Send chat message via HTTP API
3. Project orchestrator created automatically
4. Builder spawned, builds, QA passes
5. Result returned to user via SSE

**Commit**: "Step 11: Integration and E2E tests"

---

## Step 12: Live Network Deployment

### 12.1 Deploy to Windows dev node first
- Build, restart, verify
- Send test chat message
- Monitor tick_log table for issues

### 12.2 Deploy to Lightsail nodes
- SSH in, pull, build, restart
- Verify P2P connectivity maintained
- Verify MessageBus works across P2P (org-message handler)

### 12.3 Deploy to EC2 compute nodes
- Same process
- Verify council orchestrator starts on highest-reputation node
- Monitor for 24h

### 12.4 Monitor and fix
- Watch tick_log for errors
- Watch lessons table for growth
- Fix any issues discovered in production

**Commit**: "Step 12: Live network deployment"

---

## Legacy Code Removal Checklist

Every item must be verified deleted or replaced. No stale references allowed.

### Files to delete
- [ ] `packages/node/src/platform/council.ts`
- [ ] `packages/node/src/platform/council.ts.backup-original`
- [ ] `packages/node/src/platform/council.ts.bak`
- [ ] `packages/node/src/platform/council.ts.qa_backup` (if exists)
- [ ] `packages/node/src/platform/scheduler.ts`
- [ ] `packages/node/src/core/agent-manager.ts`
- [ ] `packages/node/src/core/bridge-queue.ts`
- [ ] `packages/node/src/core/agent.ts`
- [ ] `genome/templates/manager.md`
- [ ] `genome/templates/builder.md`
- [ ] `genome/templates/tester.md`
- [ ] `genome/templates/qa-adversarial.md`
- [ ] `genome/templates/reviewer.md`
- [ ] `genome/templates/researcher.md`
- [ ] `genome/templates/devops.md`
- [ ] `genome/templates/council.md`
- [ ] `apply-council-changes.py`
- [ ] `scripts/apply-council-changes.js`
- [ ] `scripts/update-council-genome.py`
- [ ] `scripts/write-and-commit-tests.py`
- [ ] `scripts/write-council-final.js`

### Interfaces/types to delete
- [ ] `AgentManager` class
- [ ] `AgentManagerConfig` interface
- [ ] `SpawnAgentConfig` interface
- [ ] `AgentTreeNode` interface
- [ ] `ProjectAccessLevel` type
- [ ] `ProjectEntry` interface
- [ ] `BridgeQueue` class
- [ ] `BridgeItemType` type
- [ ] `BridgePriority` type
- [ ] `BridgeItem` interface
- [ ] `BridgeEnqueueOpts` interface
- [ ] `Council` class
- [ ] `CouncilMember` interface
- [ ] `CouncilState` interface
- [ ] `ReflectionResult` interface
- [ ] `ActiveTask` interface (council version)
- [ ] `Scheduler` class (platform version)
- [ ] `SchedulerConfig` interface
- [ ] `TaskLifecycle` type
- [ ] `Agent` class
- [ ] `AgentRole` type
- [ ] `AgentStatus` type
- [ ] `AgentConfig` interface
- [ ] `StandingDirective` interface
- [ ] `AgentMemory` interface
- [ ] `AgentState` interface
- [ ] `AgentEventResult` interface

### Patterns to eliminate
- [ ] Bridge watcher pattern (event-driven agent dispatch)
- [ ] Standing directives (Phase 29 nudge system)
- [ ] project-state.md (replaced by tasks + lessons tables)
- [ ] Manager busy/idle tracking
- [ ] Agent state machine (ACTIVE → IDLE → ARCHIVED → DEAD)
- [ ] 4-layer CLAUDE.md assembly in agent.ts
- [ ] Council reflection cycles (1h/4h/24h)
- [ ] Council ActiveTask state machine
- [ ] council-minutes.md rolling log
- [ ] council-state.json
- [ ] directives.json (file-based, replaced by SQLite table)
- [ ] Watchdog 10-minute idle nudge timer
- [ ] Agent cleanup sweep (30min idle, 2h hard cap, 2.5h stale)

### Barrel exports to update
- [ ] `packages/node/src/core/index.ts` — remove Agent, AgentManager, BridgeQueue exports. Add WorkerPool, MessageBus.
- [ ] `packages/node/src/platform/index.ts` — remove Council, Scheduler exports. Add Orchestrator, OrgManager.

### Import references to clean
- [ ] `packages/node/src/index.ts` — all old agent wiring
- [ ] `packages/node/src/api/platform-api.ts` — scheduler, agent-manager references
- [ ] `packages/node/src/api/core-api.ts` — agent-manager references
- [ ] `packages/node/src/api/api-server.ts` — agent-manager references
- [ ] `packages/node/src/platform/agent-tools.ts` — bridge-queue, agent-manager references
- [ ] `packages/node/src/kernel/monitor.ts` — scheduler references
- [ ] `packages/node/src/platform/qa-memory.ts` — council references

---

## Estimated Scope

| Step | New Lines | Deleted Lines | Net |
|---|---|---|---|
| 0. Pre-work (delete backups/scripts/templates) | 0 | ~1,500 | -1,500 |
| 1. SQLite schema | ~200 | 0 | +200 |
| 2. MessageBus | ~150 | 0 | +150 |
| 3. Worker MCP | ~100 | 0 | +100 |
| 4. WorkerPool + context assembly | ~300 | 0 | +300 |
| 5. OrgManager | ~250 | 0 | +250 |
| 6. Orchestrator | ~500 | 0 | +500 |
| 7. Wire into PandoNode | ~100 | ~200 | -100 |
| 8. Update API routes | ~200 | ~300 | -100 |
| 9. Delete legacy code | 0 | ~5,500 | -5,500 |
| 10. Update docs | ~200 | ~500 | -300 |
| 11. Tests | ~400 | 0 | +400 |
| **Total** | **~2,400** | **~8,000** | **-5,600** |

We're deleting 3x more than we're writing. The codebase gets smaller AND more capable.

---

## Execution Order & Dependencies

```
Step 0: Clean slate (no deps)
  │
  ▼
Step 1: Schema (no deps)
  │
  ├──────────┬──────────┐
  ▼          ▼          ▼
Step 2:    Step 3:    Step 5:
MessageBus Worker MCP OrgManager
  │          │          │
  └──────────┤          │
             ▼          │
           Step 4:      │
           WorkerPool   │
             │          │
             └──────────┤
                        ▼
                      Step 6:
                      Orchestrator
                        │
                        ▼
                      Step 7:
                      Wire into Node
                        │
                        ▼
                      Step 8:
                      API routes
                        │
                        ▼
                      Step 9:
                      Delete legacy
                        │
                   ┌────┴────┐
                   ▼         ▼
                Step 10:   Step 11:
                Docs       Tests
                   │         │
                   └────┬────┘
                        ▼
                      Step 12:
                      Deploy
```

**Steps 2, 3, 5 can be built in parallel** (all depend only on Step 1).
**Step 4 depends on Steps 2 + 3** (WorkerPool uses MessageBus and starts MCP servers).
**Step 6 depends on Steps 4 + 5** (Orchestrator uses WorkerPool + OrgManager).
**Steps 7-9 are sequential** (each builds on previous).
**Steps 10 + 11 can be parallel** (docs and tests are independent).

---

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Build breaks during Step 9 (delete) | HIGH | Delete one file at a time, fix imports, build between each |
| AI brain prompt not effective | MEDIUM | Start with simple prompt, iterate. Test with real tasks. |
| Worker MCP latency | LOW | SQLite reads are <1ms. MCP overhead is minimal. |
| Orchestrator tick too slow | LOW | Most ticks are Tier 1 (no AI call). Tier 2 is short 1-turn. |
| Council orchestrator startup logic | MEDIUM | Council selection logic ported from existing council.ts. Well-understood. |
| P2P message routing for cross-node orchestrators | MEDIUM | Defer P2P cross-node to Step 12. Single-node first. |
| Gateway SSE breaks | LOW | SSE mechanism stays the same. Only the event source changes. |

---

## Success Criteria

After all steps complete:
1. `npm run build` passes with zero errors
2. Node starts cleanly with new agent system
3. Chat message via HTTP API → project orchestrator → builder worker → result
4. Council orchestrator ticks every 60s, makes decisions from board
5. Worker reports via MCP survive context compaction
6. All messages persist across node restart (SQLite)
7. Agent hierarchy visible via `GET /v1/org/tree`
8. Lessons accumulate in lessons table after tasks complete
9. Zero references to deleted files (AgentManager, Council, BridgeQueue, Scheduler)
10. Codebase is ~5,600 lines smaller than before
