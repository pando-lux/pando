# Council Architecture Roadmap — Fix It Right

> Created 2026-03-07. This is the execution plan for fixing the council architecture.
> The previous council implementation bypassed PandoCode's native systems. This roadmap corrects that.

---

## The Mistake We Made

We built a parallel agent system in pando-node instead of using PandoCode's existing agent infrastructure.

```
WHAT WE BUILT (wrong):                    WHAT PANDOCODE ALREADY HAS:
───────────────────────                    ─────────────────────────
findings-store.ts (130 lines)          →   Discoveries + Board tasks
council-prompts.ts TOOL_SETS           →   Agent roles (explorer/tester/lead/builder)
Tool stripping in onAfterCreate        →   Role-based tool permissions (built-in)
sendToCouncilAgent() w/ agentOverride  →   Agent profiles + sessions + engine routing
Event-driven wake via FindingsStore    →   send_message + check_agents (DB-backed inbox)
/v1/findings/* endpoints (4 routes)    →   /v1/board/* endpoints (already exist in PandoCode)
/v1/council/* endpoints (2 routes)     →   /v1/agents/* endpoints (already exist in PandoCode)
```

**Root cause:** The BIBLE didn't describe PandoCode's agent system clearly enough. The implementing agent (Claude) didn't know PandoCode already had persistent agents, board tasks, send_message, discoveries, and role-based tool filtering. So it rebuilt all of this from scratch in pando-node.

---

## What PandoCode Actually Provides (the agent must know this)

### Agent System
- **Persistent agent profiles** stored in SQLite `agents` table (not per-engine — global)
- **Agent types with built-in tool filtering:**
  - `explorer` — read-only tools (perfect for observer)
  - `tester` — read + bash + test tools (perfect for QA)
  - `lead` — delegation + planning tools: spawn_agent, manage_tasks, check_agents, send_message (perfect for council)
  - `builder` — full code tools (perfect for workers)
  - `reviewer`, `coordinator`, `planner` — additional roles
- **Agent UI** — Agents tab in PandoCode web UI: create, delete, rename, view sessions, status
- **Agent API** — `POST /v1/agents` (create), `GET /v1/agents` (list), `PATCH /v1/agents/:id`, `DELETE`

### Communication
- **send_message tool** — database-backed message queue in `state` table
  - Key format: `msg:{toAgentId}:{uuid}` with 1-hour TTL
  - Cross-engine capable (agents in different engines can message each other IF they share the DB)
  - Supports broadcast to all agents
- **check_agents tool** — read inbox (`action: "inbox"`), list agents, check status
  - Messages deleted after reading (acknowledged)

### Board (Task Tracking)
- **Board tasks** — SQLite table: id, title, status, assignedAgent, dependsOn, progress, timestamps
- **Status lifecycle:** pending → in_progress → done / failed / cancelled / rolled_back
- **Task assignment** to specific agents
- **Dependencies** between tasks
- **Board UI** — Board tab: unified task list, filter by agent/status, cancel/retry
- **Board API** — `GET /v1/board/all` (cross-session), `POST /v1/board/tasks`, `PATCH`

### Discoveries (Structured Observations)
- **Discovery categories:** framework, convention, pattern, gotcha, dependency
- **Confidence scoring:** 0.0-1.0
- **Auto-extraction** from file reads
- **Injected into board snapshot** for next agent iteration

### Memory
- **Per-engine memory store** — lessons, discoveries, entity knowledge, flows
- **Ranked recall** — scope precision x confidence x recency x impact
- **Append-only** — never deleted, only marked stale

### Scheduler
- **Periodic tasks** — name, engineId, intervalMs, prompt, active
- **Callbacks** — onEvent, onComplete, onError per task
- **API** — `GET /api/schedules`, `POST /api/schedules/:name/trigger`
- **NOT in web UI yet** — programmable only

### Engine Architecture
- **One engine = one session = one active agent at a time**
- **Sub-agents are ephemeral** — spawned by lead, do work, return results, die (no DB record)
- **EnginePool** — manages multiple engines with TTL eviction, lifecycle hooks
- **Shared database** — all engines sharing same SQLite DB can communicate via send_message

---

## How Council SHOULD Work (corrected architecture)

### On pando-node (contributor node with PandoCode):

```
engine-adapter.ts boot sequence:
  │
  ├─ Create EnginePool (shared SQLite DB at ~/.pando/council.db)
  │
  ├─ Create agent profiles via PandoCode agent API:
  │   POST /v1/agents → { name: "observer", role: "explorer" }
  │   POST /v1/agents → { name: "qa",       role: "tester" }
  │   POST /v1/agents → { name: "council",  role: "lead" }
  │
  ├─ Create engines in pool (one per agent):
  │   pool.getOrCreate("observer")  → PandoCode instance, role: explorer
  │   pool.getOrCreate("qa")        → PandoCode instance, role: tester
  │   pool.getOrCreate("council")   → PandoCode instance, role: lead
  │
  ├─ Register pando_* tools on each engine:
  │   observer: pando_status, pando_peers, pando_capabilities (read-only network tools)
  │   qa:       same + pando_test_run
  │   council:  ALL pando_* tools including pando_deploy, pando_governance_propose
  │
  ├─ Register scheduler ticks:
  │   "observer-tick"  every 30 min → sends message to observer engine
  │   "qa-tick"        every 30 min (offset 15 min) → sends message to qa engine
  │   "council-tick"   every 15 min → sends message to council engine
  │
  └─ System prompts injected via agentOverride on each send()

Communication flow:
  Observer checks health → creates board task: "API latency > 2s" (pending)
  Observer sends message to council: "New issue found, check board"
  Council reads inbox (check_agents) → reads board (pending tasks)
  Council investigates → spawns builder sub-agent to fix code
  Builder sub-agent: edits files, runs tests, commits to GitHub
  Council updates board task → done
  Council calls pando_governance_propose if code change needed
```

### For a standalone developer (same PandoCode, no pando-node):

```
Developer opens PandoCode UI:
  │
  ├─ Agents tab → creates agents:
  │   "CEO"       (lead)     — runs every 30 min, reviews team output
  │   "Monitor"   (explorer) — checks production health
  │   "Backend"   (builder)  — writes API code
  │   "QA"        (tester)   — runs tests
  │
  ├─ Each agent has: own session, own memory, own board
  │
  ├─ Communication: send_message between agents (same DB)
  │
  ├─ Board: shared task tracking (cross-session via /v1/board/all)
  │
  └─ Exact same architecture as pando-node council.
      Only difference: no pando_* tools, no Lux budget.
```

### The ONLY difference between standalone and pando-node:

```
PandoCode standalone:          PandoCode inside pando-node:
─────────────────────          ─────────────────────────────
Same agents                    Same agents
Same board                     Same board
Same memory                    Same memory
Same sub-agents                Same sub-agents
Same scheduler                 Same scheduler
Same send_message              Same send_message
No pando_* tools               + pando_* tools (network ops)
No Lux budget                  + Lux budget provider
No P2P                         + P2P network routing
USD budget                     Lux budget
```

---

## Phase Plan

### Phase 0: Documentation (BEFORE any code)

**Goal:** Make sure no future agent makes the same mistake.

1. **Update BIBLE.md Section 3.2** — Add full PandoCode capability inventory:
   - Agent system (profiles, roles, tool filtering, UI, API)
   - Board (tasks, assignment, dependencies, cross-session)
   - Communication (send_message, check_agents, DB-backed inbox)
   - Discoveries (structured observations)
   - Memory (lessons, entity knowledge, ranked recall)
   - Scheduler (periodic ticks, callbacks)
   - Engine architecture (one engine = one session, sub-agents ephemeral)
   - Key rule: "NEVER rebuild what PandoCode already provides"

2. **Update BIBLE.md Section 5.10** — Correct council architecture:
   - Remove all references to FindingsStore, tool stripping, sendToCouncilAgent
   - Document correct flow using PandoCode's native agent system
   - Document the agent roles mapping (observer=explorer, qa=tester, council=lead)

3. **Update BIBLE.md Section 6** — Correct engine adapter spec:
   - Remove findings tools from pando tools table
   - Remove ~700 line count (will shrink after cleanup)
   - Document the thin integration pattern

4. **This roadmap** — living doc for execution

### Phase 1: Remove Wrong Code from pando-node

**Goal:** Clean slate. Delete everything we built that duplicates PandoCode.

**Delete these files entirely:**
- `packages/node/src/core/findings-store.ts` — PandoCode has board + discoveries
- `packages/node/src/core/council-prompts.ts` — keep ONLY the system prompt strings, delete TOOL_SETS (roles handle this)

**Remove from engine-adapter.ts:**
- Tool stripping logic in `onAfterCreate` (the `builtinToRemove` loop)
- `sendToCouncilAgent()` method (use standard engine.send with agentOverride)
- `COUNCIL_AGENTS` constant and `COUNCIL_SYSTEM_PROMPTS` map
- FindingsStore.onCreated() event-driven wake setup
- Any references to TOOL_SETS

**Remove from core-api.ts:**
- `POST /v1/findings` endpoint
- `GET /v1/findings` endpoint
- `PATCH /v1/findings/:id` endpoint
- `GET /v1/findings/summary` endpoint
- `GET /v1/council/status` endpoint
- `POST /v1/council/trigger/:agent` endpoint

**Remove from agent-tools.ts:**
- `pando_create_finding` tool
- `pando_list_findings` tool
- `pando_update_finding` tool

**Remove from E2E tests:**
- Findings CRUD test
- Findings validation test
- Findings wont_fix test
- Council tools test
- Council status test
- Council trigger test

**Keep in engine-adapter.ts:**
- EnginePool usage (correct)
- Scheduler usage (correct)
- pando_* tool registration (correct — network-specific)
- Lux budget injection (correct)
- System prompt strings for observer/qa/council (correct — but simplify)

**Expected result:** engine-adapter.ts shrinks from ~700 lines back to ~300-400.

### Phase 2: PandoCode Enhancements (if needed)

**Goal:** Verify PandoCode's agent system supports the council use case. Fix gaps.

**Test and verify:**
1. Can we create agent profiles programmatically via PandoCode's API? (`POST /v1/agents`)
   - If not: add this to PandoCode core (should be trivial — the DB schema exists)
2. Can engines in a shared-DB EnginePool send_message to each other?
   - Test: engine A sends message to agent B, engine B reads inbox
   - If not: this is the critical gap to fix
3. Can board tasks be created and read cross-session?
   - `GET /v1/board/all` exists but may need verification
   - If not: add cross-session board queries
4. Does the scheduler work with agent-specific messages?
   - Scheduler sends to engine, not agent — is this sufficient?
   - Probably yes if each engine IS one agent

**Potential PandoCode enhancements (only if testing reveals gaps):**
- Severity/status fields on discoveries (to function like findings)
- Scheduler management in web UI (so developers can see/manage periodic tasks)
- Programmatic agent profile creation (if POST /v1/agents doesn't work from engine-adapter)
- Cross-engine board task visibility

**Rule: Only enhance PandoCode with features that help ALL developers, not just pando-node.**

### Phase 3: Rewire pando-node Council

**Goal:** Council agents use PandoCode's native systems properly.

**Implementation:**
1. engine-adapter.ts creates agent profiles (observer, qa, council) using PandoCode's agent API
2. EnginePool creates one engine per agent, all sharing a council DB
3. Register pando_* tools on each engine (filtered by role — observer gets read-only network tools, council gets all)
4. Scheduler ticks each engine with system prompt via agentOverride
5. Agents communicate via send_message (DB-backed, cross-engine)
6. Council uses board tasks to track issues and work
7. Council uses spawn_agent (sub-agents) to do actual coding work
8. Council has lead role — CAN spawn builder/tester sub-agents natively

**Council's actual power (with lead role):**
- spawn_agent → spawns ephemeral builder to fix code
- manage_tasks → creates/tracks board tasks
- check_agents → reads inbox, checks team status
- send_message → communicates with observer/qa
- pando_governance_propose → submits changes through governance
- pando_deploy → deploys projects
- pando_status, pando_peers → checks network health
- All read/write PandoCode tools (lead role has full access)

**System prompts (simplified):**
- Observer: "You are the network observer. Check health using pando_status and pando_peers. Report issues by creating board tasks and sending messages to council."
- QA: "You are the QA agent. Run health checks. Report failures by creating board tasks and sending messages to council."
- Council: "You are the council. Read your inbox (check_agents). Review board tasks. For code fixes, spawn a builder sub-agent. For governance changes, call pando_governance_propose."

### Phase 4: E2E Testing

**Goal:** Prove the full pipeline works.

**Test 1: Basic council loop**
- Start node with PandoCode
- Observer tick fires → checks health → creates board task
- Observer sends message to council
- Council tick fires → reads inbox → reads board → investigates
- Council resolves the task (marks done) or spawns builder

**Test 2: Council spawns builder**
- Council receives a task that requires code change
- Council spawns builder sub-agent with task description
- Builder edits code, runs tests
- Builder returns result to council
- Council reviews → calls pando_governance_propose

**Test 3: Full governance loop**
- Council proposes a change
- Governance runs 6-layer pipeline
- Layer 5 AI review on PandoCode node
- Proposal approved → upgrade-protocol → restart

**Test 4: Manual trigger**
- POST /v1/council/trigger/observer → manually fires observer
- POST /v1/council/trigger/council → manually fires council
- Verify tool calls and results in response

### Phase 5: Project Adoption + Governance Integration

**Goal:** Projects survive when creator node dies. Governance works end-to-end.

1. **Project adoption:** Any PandoCode node can clone from GitHub and continue work
2. **Governance AI review:** Layer 5 runs real diffs through PandoCode engine
3. **Council proposes to ecosystem repos:** @pando/node, @pando-code/core, etc.

### Phase 6: Contributor Economics

**Goal:** Make it worth running a PandoCode node.

1. Lux earning per build job
2. Contributor limits and budget caps
3. Reputation-weighted routing

---

## How Council Starts on a Contributing Node

```
Node boot (contributor node with PandoCode installed):
  │
  ├─ cli.ts → PandoNode.start()
  │
  ├─ Capability detector finds PandoCode (@pando-code/core resolvable)
  │   → Sets capability: pando-code: true
  │
  ├─ engine-adapter.ts start():
  │   ├─ Creates EnginePool with shared DB
  │   ├─ Loads PandoCode's .env for API keys
  │   ├─ Injects Lux budget provider
  │   └─ Registers pando_* tools template
  │
  ├─ startCouncilAgents() (only if PandoCode available):
  │   ├─ Creates agent profiles: observer (explorer), qa (tester), council (lead)
  │   ├─ Creates engines in pool (one per agent)
  │   ├─ Registers pando_* tools on each engine (filtered by role)
  │   ├─ Registers scheduler ticks
  │   └─ Logs: "[council] Started: observer (explorer), qa (tester), council (lead)"
  │
  └─ Node is running. Council agents tick on schedule.
      User can also interact with agents via gateway or API.

Key points:
  - Council is started by NODE, not by PandoCode
  - Node USES PandoCode's infrastructure (agents, board, scheduler)
  - Node only ADDS: pando_* tools + Lux budget + system prompts
  - If PandoCode is not installed: node runs as lightweight/relay, no council
```

---

## Decisions (all questions resolved)

### D1: Shared DB for council engines — YES, shared dbPath

All three council engines share one SQLite DB at `~/.pando/council/council.db`.

**Why it works:** All engines run in the same Node.js process. `better-sqlite3` is synchronous — writes are serialized by the event loop. No "database is locked" issues.

**How:** Pass `dbPath: '~/.pando/council/council.db'` to each engine's options when calling `pool.getOrCreate()`. PandoCode's EngineOptions accepts `dbPath`.

**Result:** send_message works cross-engine (all agents read/write to same `state` table). Board tasks visible across all agents (same `board_tasks` table).

### D2: Board tasks replace findings — title convention for severity

Board tasks already have the status lifecycle we need: `pending → in_progress → done / failed / cancelled`.

**Severity via title convention:** `[SEVERITY:CATEGORY] description`

```
Observer creates:  "[CRITICAL:health] API latency > 2s on /v1/status"
Observer creates:  "[WARNING:health] Only 1 peer connected"
QA creates:        "[CRITICAL:test_failure] /v1/status returned 503"
QA creates:        "[INFO:suggestion] Consider adding retry logic"
```

Council parses the prefix to prioritize: CRITICAL first, then WARNING, then INFO.

**No PandoCode changes needed.** If we later want proper severity fields on board_tasks, we enhance PandoCode then — but title convention works now and works for any developer (not just pando-node).

**The `progress` field** stores investigation notes: `"Observed by observer at 2026-03-07T10:30:00Z. Response time: 2.3s average over 5 calls."`

### D3: Sub-agent workspace — council engine's projectPath = node repo

When council spawns a builder sub-agent, the builder inherits the council engine's `projectPath`. For ecosystem fixes (@pando/node), set:

```
council engine projectPath = the pando/node repo root
  → builder sub-agent reads/writes files directly in the repo
  → builder runs tests directly (npm run build, npm test)
  → builder returns diff to council
  → council calls pando_governance_propose with the diff
```

**For user projects:** Council would create a separate engine with `projectPath` = that project's workspace (`~/.pando/projects/{projectId}/`). This is a Phase 5 concern.

**Risk in dev mode:** Builder has write access to the live repo. Acceptable because:
- Governance validates before broadcasting changes to other nodes
- Git is the safety net — `git reset --hard` recovers
- In production, we'd add git worktree isolation (Phase 5+)

### D4: Scaling — three agents now, more later

Three agents (observer, qa, council) for the current network. Period.

If we need 100 observers tomorrow, we create 100 engines in the pool. Each gets a different scope (region, node subset, etc.). PandoCode's EnginePool supports this via `maxEngines` config. The node decides how many. PandoCode just manages them. No architecture changes needed.

**Don't over-engineer now.** Three agents is enough for a network of 5 nodes.

### D5: Cross-node council coordination — none needed

Each contributor node runs its own independent council. No coordination between councils on different nodes.

- Each council monitors its own node's health
- If two councils propose fixes for the same issue, governance handles the conflict (first approved wins, second may get rejected for merge conflict)
- Project ownership: one node at a time. Transfer on offline detection via P2P heartbeat timeout.

### D6: Authority levels — none, governance is the gate

Council can propose anything. Governance decides. If governance rejects, council learns from memory.

No authority tiers. No permission levels. No complexity. Governance IS the control mechanism.

### D7: Rollback — natural feedback loop

```
Council approves fix → upgrade-protocol deploys → QA detects regression
  → QA creates board task "[CRITICAL:test_failure] Regression after last deploy"
  → Council reads it → proposes revert → governance approves → upgrade deploys revert
```

QA IS the safety net. No special rollback mechanism needed. The loop handles it.

### D8: Governance scope — ecosystem only

- **Ecosystem repos** (@pando/*, @pando-code/*): full governance (6-layer pipeline, peer vote)
- **User projects**: skip governance. Their code, their risk. Deploy pipeline runs directly.
- **Malicious apps on Pando infra**: future concern (Phase 6+). Deploy pipeline could add a security scan layer, but not blocking now.

### D9: Agent profile creation — programmatic via shared DB

PandoCode has `POST /v1/agents` in its server API. But engine-adapter doesn't use PandoCode's server — it uses the library directly (EnginePool).

**Solution:** Insert agent profiles directly into the shared SQLite DB using PandoCode's DB schema. The agent profiles are just rows in the `agents` table. engine-adapter can insert them at startup using the same DB connection the engines use.

If PandoCode's core exports an agent management API (like `db.insertAgent()`), use that. If not, insert directly — the schema is simple: `id, role, displayName, description, status, sessionId, model, createdAt, updatedAt`.

### D10: Scheduler addressing — one engine per agent is sufficient

Scheduler sends messages to engines by ID. One engine per agent means scheduler tick goes to the right agent automatically.

```
scheduler.register({ name: "observer-tick", engineId: "observer", ... })
scheduler.register({ name: "qa-tick", engineId: "qa", ... })
scheduler.register({ name: "council-tick", engineId: "council", ... })
```

Each engine IS one agent. No need for sub-addressing. System prompt injected via agentOverride on each send() call.

---

## Files That Change

### pando-node (packages/node/src/)
| File | Action | Details |
|---|---|---|
| `core/findings-store.ts` | DELETE | Replaced by PandoCode board + discoveries |
| `core/council-prompts.ts` | SIMPLIFY | Keep prompt strings, delete TOOL_SETS |
| `core/engine-adapter.ts` | REWRITE council section | Remove tool stripping, sendToCouncilAgent, FindingsStore refs. Use PandoCode agent API. ~700→~400 lines |
| `api/core-api.ts` | REMOVE findings/council routes | 6 endpoints deleted. Council status moves to PandoCode's /v1/agents |
| `platform/agent-tools.ts` | REMOVE findings tools | 3 tools deleted (pando_create/list/update_finding) |
| `tests/e2e/pando-e2e.spec.ts` | REWRITE council tests | Test against PandoCode's agent/board APIs instead |

### PandoCode (packages in pando/code/) — only if gaps found in Phase 2
| File | Action | Details |
|---|---|---|
| `pool/engine-pool.ts` | MAYBE | Shared DB support for council engines |
| `db/schema.ts` | MAYBE | Severity field on board_tasks or discoveries |
| `server/server.ts` | MAYBE | Agent creation API verification |
| `packages/web/` | MAYBE | Scheduler UI for managing periodic tasks |

### BIBLE.md
| Section | Action | Details |
|---|---|---|
| 3.2 @pando-code/core | EXPAND | Full capability inventory (agents, board, communication, memory) |
| 4.2 Core Layer | UPDATE | Remove FindingsStore, CouncilPrompts from table |
| 4.4 HTTP API | UPDATE | Remove /v1/findings/*, /v1/council/* routes |
| 5.10 Council | REWRITE | Correct architecture using PandoCode's native systems |
| 6. Engine Adapter | UPDATE | Remove findings tools, correct line count |
| 9. Brain Kill | UPDATE | Remove mention of /v1/council being re-added |
| NEW section | ADD | "PandoCode Capabilities Reference" — the section that prevents this mistake |
