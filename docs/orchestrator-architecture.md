<!-- STATUS: HISTORICAL DESIGN - superseded by genome/knowledge/flows/*.know -->
# Pando Orchestrator Architecture

**Date**: 2026-02-27
**Status**: BRAINSTORM — design complete, integration with Pando codebase TBD

---

## FOR IMPLEMENTING AGENTS: READ THIS FIRST

### What this document is
A complete architecture design for replacing Pando's current agent orchestration (council.ts, agent-manager.ts) with a new system that is immune to AI context loss. The design was brainstormed through 8 rounds of adversarial review. All known flaws have mitigations.

### Table of contents
- **Part 1** (line ~40): Core architecture — the orchestrator loop, task board, worker lifecycle
- **Part 2** (line ~300): Hierarchy — fractal orchestrator pattern, cross-team communication
- **Part 3** (line ~700): Pando's specific org chart — council, engineering, ops, QA, user projects, finance
- **Part 4** (line ~850): Known flaws + mitigations (theoretical)
- **Part 5** (line ~975): Production flaws + fixes (practical — merge conflicts, learning, API outages)
- **Part 6** (line ~1125): Full walkthrough — "build me a weather app" step-by-step timeline
- **Part 7** (line ~1175): Safety chain — 5 layers of failure recovery
- **Part 8** (line ~1290): Core principle — the system CANNOT get stuck (impossible by design)
- **Part 9** (line ~1390): Open questions (integration, P2P, migration)

### The one-paragraph summary
Replace long-running AI agent conversations (which lose context) with a deterministic TypeScript loop that calls AI in short, stateless bursts for judgment. State lives in SQLite (never in conversation history). Workers are short-lived Claude Code processes with persistent workspaces. The pattern is fractal — same class runs the council, departments, and teams. The system cannot get stuck because the AI CEO has full authority and must decide every tick. When idle, it improves itself.

### The 3 components to build
1. **Orchestrator class** (~500 lines TypeScript) — deterministic tick loop + SQLite board + AI brain call + action executor. One class, used at every level of hierarchy.
2. **Worker MCP tools** (~50 lines) — `get_my_task()` and `report_progress()`. Worker's lifeline to the SQLite board. Survives context compaction.
3. **Watchdog script** (~10 lines) — monitors council heartbeat, restarts if dead.

### Key decisions made
- AI brain calls are 1-turn, fresh, stateless. No long conversations. No context to lose.
- Task board in SQLite is the SINGLE source of truth. Not CLAUDE.md, not conversation history.
- Workers are disposable processes. Workspaces are persistent directories.
- 80% of ticks are Tier 1 (deterministic, no AI call needed). 20% are Tier 2 (AI judgment).
- File ownership decomposition prevents merge conflicts (AI assigns non-overlapping file scopes).
- `lessons` table + `org_knowledge` table = institutional memory that survives team dissolution.
- In autonomous mode, `escalate_to_user` action is removed. Council must decide. System cannot get stuck.
- Hierarchy is dynamic — teams created/dissolved on demand by parent orchestrator.
- Cross-team communication via message bus (SQLite inbox per orchestrator).
- 5-layer safety chain: worker MCP → code timer → AI brain → parent orchestrator → watchdog.

### What still needs to be decided (Part 9)
- How this maps to existing Pando code (what's replaced vs kept)
- Where the files go in the directory structure
- Complete SQLite schema (fragments exist in Part 5, need consolidation)
- Complete AI brain prompt templates per level
- P2P distribution (which node runs which orchestrator)
- Migration plan from current system

### Suggested build order
1. **Orchestrator class + SQLite schema** — the core loop. Can test standalone.
2. **Worker MCP tools** — get_my_task() + report_progress(). Test with manual workers.
3. **Single-level test** — one orchestrator managing 3 workers. No hierarchy. Prove the pattern.
4. **Hierarchy** — parent/child orchestrators + message bus. Prove fractal scaling.
5. **Integration** — replace current council.ts with new orchestrator system.
6. **Watchdog** — add the 10-line council health monitor.

---

## The Problem

AI agents (Claude Code) lose their mission after long tasks due to context window compaction. Specifically:

1. **Context compaction** — after many turns, CLAUDE.md instructions get diluted, agent forgets its rules and goals
2. **Premature completion** — agent "declares victory" after solving an intermediate problem, losing sight of the full plan
3. **Lost orchestration** — a manager agent that's coordinating 5 workers forgets it has workers, forgets which are done, forgets pending questions
4. **No reliable watchdog** — current nudge-based watchdog sends messages to an agent that may have already lost context (useless)
5. **No visibility** — hard to see what the council/agents have been doing, what was attempted, what succeeded, what failed

**Root cause**: Orchestration logic lives inside an AI conversation. When conversation compacts, orchestration state is lost.

---

## The Core Insight

**Don't fight context compaction. Design around it.**

- AI is good at: understanding code, writing code, making judgment calls
- AI is bad at: remembering state across hours, keeping track of 5 parallel workers, following rules after 200 turns
- Code is good at: state management, timers, retries, persistence, never forgetting
- Code is bad at: judgment, understanding nuance, handling edge cases

**Solution: Separate the brain from the body.**

- **Brain** = AI (called in short, stateless bursts for judgment)
- **Body** = TypeScript orchestrator (deterministic loop, SQLite state, timers)
- **Memory** = Task board in SQLite (the single source of truth — not conversation history)

---

## Architecture: "Thin Agent, Thick Orchestrator"

```
┌──────────────────────────────────────────────────────┐
│              ORCHESTRATOR (TypeScript)                 │
│                                                       │
│  DETERMINISTIC (code, never forgets):                 │
│  - setInterval loop (60s tick + event-driven)         │
│  - Heartbeat monitoring (kill worker if >5 min silent)│
│  - Event collection (worker reports, timeouts)        │
│  - Task board read/write (SQLite)                     │
│  - Execute AI's action list                           │
│  - Spawn/kill worker Claude Code processes            │
│  - Persist everything to SQLite (audit trail)         │
│                                                       │
│  AI BRAIN (called every tick, FRESH each time):       │
│  - Reads full task board from SQLite                  │
│  - Reads new events since last check                  │
│  - Reads mission statement                            │
│  - Returns list of actions (JSON)                     │
│  - Uses judgment for all edge cases                   │
│  - NEVER needs memory — board has everything          │
│  - 1-turn conversation. Fresh every time.             │
└────────────┬────────────┬────────────┬────────────────┘
             │            │            │
      ┌──────▼──────┐ ┌──▼──────┐ ┌───▼──────┐
      │  Worker A   │ │ Worker B │ │ Worker C │  ...
      │  (Claude)   │ │ (Claude) │ │ (Claude) │
      │             │ │          │ │          │
      │  Persistent │ │ Persist. │ │ Persist. │
      │  workspace  │ │ workspace│ │ workspace│
      │  (files     │ │          │ │          │
      │   survive   │ │ Can ask  │ │ Can      │
      │   respawn)  │ │ questions│ │ report   │
      │             │ │ via MCP  │ │ "done",  │
      │  Reports    │ │ tool     │ │ "stuck", │
      │  via MCP    │ │          │ │ "need    │
      │  tool       │ │          │ │  input"  │
      └─────────────┘ └──────────┘ └──────────┘
```

---

## The Orchestrator Loop (the whole thing, ~15 lines)

```typescript
// NOT an AI agent. A setInterval + event listener.

// Timer trigger — safety net, catches anything missed
setInterval(async () => {
  await managerTick();
}, 60_000);

// Event trigger — immediate response to worker reports
workerProcess.on('report', async (report) => {
  db.addEvent(report);
  await managerTick();
});

async function managerTick() {
  // 1. Read board from SQLite (deterministic)
  const board = db.getTaskBoard();
  const events = db.getEventsSince(lastCheck);

  // 2. Call AI for judgment (fresh, stateless, 1-turn)
  const actions = await callAI(board, events, mission);

  // 3. Execute whatever AI said (deterministic)
  for (const action of actions) {
    executeAction(action);
  }

  lastCheck = Date.now();
}
```

**Why this never fails:**
- `setInterval` never forgets, never compacts, never gets distracted
- AI gets called (it doesn't call itself, doesn't decide when to wake up)
- AI reads the board every time (never needs to remember previous calls)
- AI can run for 48 hours and be just as sharp on hour 48 as hour 1

---

## The Task Board (SQLite — single source of truth)

```
Task: "Refactor auth for refresh tokens"
Status: IN_PROGRESS
Mission: (original task description + any user context)

┌────────────────────────────────────────────────────┐
│ Subtask A │ DONE     │ "extracted JWT utils"        │
│ Subtask B │ REVIEW   │ "says done, needs check"     │
│ Subtask C │ BLOCKED  │ "needs product decision       │
│           │          │  on token expiry"              │
│ Subtask D │ STUCK    │ "no heartbeat 45 min"         │
│ Subtask E │ DONE     │ "conflicts with A"            │
└────────────────────────────────────────────────────┘

Pending questions:
- "Should refresh tokens expire in 7d or 30d?"
  (from Worker C, waiting for user answer)

Recent events:
- 14:02 Worker A completed
- 14:15 Worker E completed, conflict detected
- 14:18 Worker C asked question, blocked
- 14:20 Worker B reported "done"
- 15:03 Worker D heartbeat timeout
```

**The AI manager reads this every tick.** It never needs to "remember" any of it. The board IS the memory.

---

## Worker Lifecycle

### Workers are short-lived processes, persistent workspaces

- **Process**: Fresh Claude Code process per task (or respawn). Full context window, full CLAUDE.md every time.
- **Workspace**: Persistent directory. Code, files, build artifacts survive process death and respawn.
- **Respawn**: If worker stalls, orchestrator kills process, spawns new one pointed at SAME workspace. New process sees existing code, picks up where old one left off. Fresh context + existing files.

### Worker MCP Tools (the lifeline — 2 tools)

Every worker gets 2 MCP tools. Even if context compacts to nothing, these survive because they're 2 lines in CLAUDE.md:

```
RULE 1: Call get_my_task() when confused about what to do
RULE 2: Call report_progress() after every major step
```

**get_my_task()** returns from SQLite:
```json
{
  "task": "Add refresh token generation + storage",
  "status": "in_progress",
  "qa_feedback": "refresh token has no expiry — add expiry field",
  "files_you_changed": ["src/auth/refresh.ts", "src/auth/types.ts"],
  "workspace": "/path/to/workspace-B",
  "parent_task": "Refactor auth for refresh tokens",
  "context": "Other workers are handling JWT utils, middleware, endpoint, and tests"
}
```

**report_progress(status, details)** writes to SQLite:
- status: `working` | `done` | `blocked` | `question` | `error`
- details: free text (what they did, what they need, what's wrong)
- Orchestrator reads this on next tick

### Worker statuses

| Status | Meaning | Orchestrator response |
|---|---|---|
| `working` | Actively coding | Monitor heartbeat |
| `done` | Claims to be finished | AI manager reviews output, verifies |
| `blocked` | Needs input from another worker or external dependency | AI manager decides: wait, reassign, or unblock |
| `question` | Needs a decision (product, architecture, etc.) | AI manager answers if it can, or escalates to user |
| `error` | Hit an unexpected problem | AI manager reads error, decides: retry, different approach, or escalate |

---

## AI Manager Judgment Calls (what the AI brain actually does)

The AI brain is called with the full board + events and returns a list of actions. Here are the real-world scenarios it handles:

### Worker says "done" but isn't really
- AI reads worker's report output
- Recognizes: "This is a question, not a completion"
- Action: `{action: 'update_status', worker: 'B', status: 'question', note: 'Worker is asking about error handling, not done'}`

### Worker needs client/user input
- Worker reports: `{status: 'blocked', reason: 'Need product decision on token expiry'}`
- AI recognizes it can't answer this
- Action: `{action: 'escalate_to_user', question: 'Should refresh tokens expire in 7 or 30 days?'}`
- User answers via chat/gateway → answer stored in board → next tick, AI routes answer to worker

### Worker stuck, no heartbeat
- Deterministic timer detects timeout, adds event
- AI reads event + worker's task + board context
- Uses JUDGMENT — might be any of:
  - "Task is complex, give more time" → `{action: 'extend_timeout', worker: 'D', minutes: 15}`
  - "Task was simple, probably crashed" → `{action: 'respawn_worker', worker: 'D'}`
  - "D is waiting on C's output, and C is blocked. D is fine." → `{action: 'no_op', reason: 'D depends on C, expected'}`

### Workers have conflicting changes
- Orchestrator detects git conflict (deterministic diff check)
- AI reads both workers' changes
- Decides who rebases: `{action: 'message_worker', target: 'E', content: 'Rebase on workspace-A. They restructured types.ts.'}`

### When to actually move to QA
- AI checks board: all subtasks done
- But uses judgment: "Do the pieces fit together? Integration concerns?"
- Maybe: `{action: 'spawn_worker', task: 'Integration check — verify all 5 changes work together'}`
- Or: `{action: 'move_to_qa'}` if confident

### All retries exhausted
- Builder failed 3 times, QA failed 3 times
- AI decides: different approach? simpler scope? escalate to user?
- Action: `{action: 'escalate_to_user', message: 'Refresh token implementation keeps failing on X. Should we simplify to Y?'}`

---

## What the AI Manager Prompt Looks Like

```
You are a project manager for an AI development team.

MISSION: {original task description}

CURRENT TASK BOARD:
{full board state from SQLite — all subtasks, statuses, worker reports}

NEW EVENTS SINCE LAST CHECK:
{list of events — worker reports, heartbeat timeouts, user messages}

RULES:
- A worker saying "done" may actually be asking a question. Read their output carefully.
- If a worker is blocked on a product/user decision, escalate to the user.
- If a worker has no heartbeat for >5 min, check if their task has dependencies before killing.
- Don't move to QA until ALL subtasks are genuinely complete AND integration-checked.
- If retries are exhausted, escalate to user with a clear summary.

Return a JSON array of actions:
[
  {action: "spawn_worker", task: "...", context: "..."},
  {action: "message_worker", target: "worker-id", content: "..."},
  {action: "respawn_worker", target: "worker-id", reason: "..."},
  {action: "escalate_to_user", question: "..."},
  {action: "update_status", subtask: "id", status: "...", note: "..."},
  {action: "move_to_qa"},
  {action: "complete_task", summary: "..."},
  {action: "no_op", reason: "..."}
]
```

**This prompt is ~50 lines. Fits easily in any context window. Fresh every call. Never compacts.**

---

## Key Design Principles

1. **AI is the brain, code is the body, SQLite is the memory** — three separate concerns, never mixed
2. **Task board is the single source of truth** — not conversation history, not CLAUDE.md, not agent memory
3. **Every AI call is 1 turn, fresh, stateless** — no long conversations to compact
4. **Workers are disposable processes, workspaces are persistent** — kill and respawn freely
5. **Two triggers: events (immediate) + timer (safety net)** — nothing falls through the cracks
6. **2-tool lifeline for workers** — `get_my_task()` + `report_progress()` survive any compaction

---

## Part 2: Hierarchy — Scaling to an Organization

### Why the flat model breaks

The single orchestrator → workers → QA model handles ONE team doing ONE task. But a real organization has:

- Departments that don't know about each other
- Managers managing managers managing workers
- Cross-team dependencies ("marketing is blocked until engineering ships the API")
- Workers who need to collaborate peer-to-peer
- Someone reviewing HOW the org works, not just WHAT it's doing

### The pattern is fractal

The orchestrator pattern works at EVERY level. A "worker" at one level can BE an orchestrator at the level below. Same loop, same board, same AI brain — just different scope.

```
PANDO COUNCIL (top-level orchestrator)
│  Board: "Organization-wide priorities and health"
│  AI brain: "What should the org focus on? Any cross-dept issues?"
│  Tick: every 10 minutes (strategic, not tactical)
│
├── ENGINEERING DEPT (orchestrator)
│   │  Board: "All engineering projects"
│   │  AI brain: "Which projects need attention? Any blockers?"
│   │  Tick: every 5 minutes
│   │
│   ├── Backend Team (orchestrator)
│   │   │  Board: "Backend tasks for auth refactor"
│   │   │  AI brain: "How are my 5 workers doing?"
│   │   │  Tick: every 60 seconds
│   │   │
│   │   ├── Worker: "JWT extraction"
│   │   ├── Worker: "Refresh token logic"
│   │   └── Worker: "Database migrations"
│   │
│   ├── Frontend Team (orchestrator)
│   │   │  Board: "Frontend tasks for new login flow"
│   │   │  Tick: every 60 seconds
│   │   │
│   │   ├── Worker: "Login form redesign"
│   │   └── Worker: "Token storage in browser"
│   │
│   └── QA Team (orchestrator)
│       │  Board: "What needs testing?"
│       │  Tick: every 2 minutes
│       │
│       ├── Worker: "Auth integration tests"
│       └── Worker: "Performance regression tests"
│
├── MARKETING DEPT (orchestrator)
│   │  Board: "Marketing campaigns and content"
│   │  Tick: every 5 minutes
│   │
│   ├── Content Team (orchestrator)
│   │   ├── Worker: "Write launch blog post"
│   │   └── Worker: "Update docs for new auth"
│   │
│   └── Analytics Team (orchestrator)
│       └── Worker: "Set up conversion tracking"
│
└── OPERATIONS DEPT (orchestrator)
    │  Board: "Infrastructure and deployment"
    │  Tick: every 2 minutes
    │
    ├── Worker: "Prepare staging environment"
    └── Worker: "Update nginx config for new endpoints"
```

**Every box with "orchestrator" is the SAME code.** Same loop, same SQLite board, same AI brain call. Just different:
- Scope (what's on their board)
- Tick interval (strategic = slow, tactical = fast)
- Prompt (their role description and rules)
- Direct reports (who they manage)

### Each orchestrator is a unit

```
┌─────────────────────────────────────────┐
│  ORCHESTRATOR UNIT (identical code)      │
│                                          │
│  Config:                                 │
│  - id: "backend-team"                    │
│  - parent: "engineering-dept"            │
│  - role: "Backend Engineering Manager"   │
│  - tick_interval: 60s                    │
│  - max_workers: 8                        │
│                                          │
│  Has:                                    │
│  - Own SQLite board (tasks, events)      │
│  - Own AI brain prompt (role-specific)   │
│  - Own worker processes                  │
│  - Inbox (messages FROM other units)     │
│  - Outbox (messages TO other units)      │
│                                          │
│  Tick loop:                              │
│  1. Read own board                       │
│  2. Read inbox (cross-team messages)     │
│  3. Read events (worker reports, timers) │
│  4. Call AI brain → get actions           │
│  5. Execute actions (includes sending    │
│     messages to other units via outbox)  │
└─────────────────────────────────────────┘
```

### How communication works

#### Up the tree (reporting)
Worker reports to its orchestrator. If the orchestrator can't handle it (out of scope, needs higher authority), it escalates UP to its parent orchestrator.

Example: Backend worker discovers a security vulnerability that affects the whole system.
```
Worker → Backend Manager: "Found SQL injection in auth"
Backend Manager AI brain: "This is org-wide. I can't handle this alone."
Backend Manager → Engineering Dept: {type: 'escalate', urgency: 'critical',
  message: 'SQL injection found in auth, needs org-wide response'}
Engineering Dept AI brain: "Critical security issue. Need all teams to stop and audit."
Engineering Dept → Council: {type: 'escalate', urgency: 'critical', ...}
Council AI brain: "Halt all work. Spawn security audit across all departments."
```

#### Down the tree (delegation)
Parent orchestrator assigns work to child orchestrators. Child breaks it down further.

Example: Council decides "launch new feature by Friday."
```
Council → Engineering Dept: {type: 'task', description: 'Build auth refresh tokens'}
Council → Marketing Dept: {type: 'task', description: 'Prepare launch content'}
Council → Operations Dept: {type: 'task', description: 'Prepare staging + prod environments'}

Each department orchestrator breaks their task into subtasks for their teams.
Each team orchestrator breaks subtasks into worker assignments.
```

#### Across the tree (cross-team requests)
This is the hard one. Dev worker needs something from marketing. How?

**The message bus pattern**: Every orchestrator has an INBOX. Any orchestrator can send a message to any other orchestrator's inbox. The receiving orchestrator's AI brain triages it on the next tick.

```
Backend Worker: "I need the marketing copy for the login page error messages"
  ↓ reports to
Backend Manager AI brain: "This is a cross-team request. Route to Content Team."
  ↓ sends message to Content Team inbox
Content Team AI brain sees message on next tick:
  "Engineering needs login page copy. Assign to Writer 1."
  ↓ assigns to
Writer 1: writes the copy, reports done
  ↓ reports to
Content Team AI brain: "Cross-team request fulfilled. Send response."
  ↓ sends response to Backend Manager inbox
Backend Manager AI brain: "Copy received. Forward to the worker who asked."
  ↓ forwards to
Backend Worker: gets the copy, continues work
```

**Key: every hop is through an orchestrator.** No direct worker-to-worker across teams. Why?
- Audit trail: every cross-team interaction is logged on both boards
- Priority management: Content Team manager can prioritize engineering's request vs their own work
- Conflict resolution: if two teams both want Writer 1's time, Content Team manager decides

#### Peer-to-peer (workers on the same team collaborating)

Two workers on the same team CAN collaborate. But through the board, not directly.

```
Worker A posts to board: "Here's my proposed API interface: POST /auth/refresh {...}"
Worker B's next get_my_task() includes: "Note: Worker A proposed this API interface"
Worker B posts to board: "Interface looks good but add a 'device_id' field"
Worker A's next get_my_task() includes: "Note: Worker B suggests adding device_id"
```

The manager orchestrator sees all of this and can intervene:
- "A and B have been going back and forth 5 times on the API design. Let me make a decision."
- Action: `{action: 'message_worker', target: 'A', content: 'Use Worker B's design with device_id. Move on.'}`

### Dynamic hierarchy (self-organizing)

The hierarchy isn't fixed. Orchestrators can create and destroy child orchestrators.

**Scaling up**: Engineering Dept gets 20 tasks. AI brain decides:
```
"Too many tasks for 2 teams. Create a third team: 'API Team'."
Action: {action: 'create_team', name: 'api-team', role: 'API Development Manager',
         inherit_tasks: ['task-12', 'task-15', 'task-18']}
```

**Scaling down**: After the launch, marketing only has 1 task left.
```
Marketing Dept AI brain: "Content Team and Analytics Team both have 1 worker each.
Merge into a single team."
Action: {action: 'merge_teams', source: 'analytics-team', target: 'content-team'}
```

**Ad-hoc teams**: A cross-cutting concern needs a temporary team.
```
Council AI brain: "Security audit needs people from engineering, ops, and QA.
Create a temporary cross-functional team."
Action: {action: 'create_team', name: 'security-audit', role: 'Security Audit Lead',
         temporary: true, dissolve_when: 'audit complete'}
```

### What the message bus looks like

```
┌────────────────────────────────────────────────────────┐
│                    MESSAGE BUS (SQLite)                  │
│                                                          │
│  Every orchestrator has a row in the `units` table.      │
│  Messages go into the `messages` table.                  │
│                                                          │
│  messages table:                                         │
│  ┌──────┬──────────┬──────────┬──────────┬────────────┐ │
│  │ id   │ from     │ to       │ type     │ content    │ │
│  ├──────┼──────────┼──────────┼──────────┼────────────┤ │
│  │ 1    │ backend  │ content  │ request  │ "need copy"│ │
│  │ 2    │ council  │ eng-dept │ task     │ "build X"  │ │
│  │ 3    │ worker-A │ backend  │ report   │ "done"     │ │
│  │ 4    │ qa-team  │ backend  │ feedback │ "bug in Y" │ │
│  │ 5    │ backend  │ council  │ escalate │ "blocked"  │ │
│  └──────┴──────────┴──────────┴──────────┴────────────┘ │
│                                                          │
│  Each orchestrator reads WHERE to = 'my-id'              │
│  on every tick. Simple SQL query.                        │
└────────────────────────────────────────────────────────┘
```

### Resilience at scale

**What if an orchestrator dies?**
- Its workers keep working (they have their own processes and workspaces)
- Workers' heartbeats go unanswered for a while — that's OK
- Parent orchestrator detects: "Backend Team hasn't reported in 10 minutes"
- Parent AI brain: "Backend Team orchestrator may have crashed. Restart it."
- Restarted orchestrator reads its board from SQLite. Picks up exactly where it left off.
- Workers check in on next heartbeat. Continuity restored.

**What if a parent dies?**
- Children continue operating independently (they have their own boards)
- Cross-team messages queue up in the message bus (not lost, just undelivered)
- Grandparent (or the council) detects the gap and restarts
- When parent comes back, it reads queued messages and catches up

**What if the council itself dies?**
- All departments continue their current work autonomously
- A deterministic watchdog process (NOT an AI agent) monitors the council
- If council heartbeat stops → restart council orchestrator
- Council reads its board from SQLite. Organization continues.

**The whole org can survive any single failure because state is in SQLite, not in memory.**

### Tick intervals by level

Different levels need different response times:

| Level | Example | Tick interval | Why |
|---|---|---|---|
| Council | Org strategy, cross-dept | 10 min | Strategic decisions don't change fast |
| Department | Engineering, Marketing | 5 min | Project-level oversight |
| Team | Backend Team, QA Team | 60 sec | Active worker management |
| Worker | (no tick — event driven) | — | Workers report via MCP, don't tick |

**Cost optimization**: Council at 10-min ticks = 144 AI calls/day. A team at 60-sec ticks = 1,440/day. But most ticks result in `no_op` (nothing changed). AI call is cheap (~$0.01-0.05) for a short board-reading prompt. 10 orchestrators at various levels = maybe $20-50/day. Much cheaper than a long-running agent burning tokens for hours.

**Dynamic tick rate**: When board has active work → tick every 60s. When board is idle (no workers, no pending messages) → slow to every 10 min. Wake immediately on any event.

### Example: Full lifecycle of a cross-team feature

```
1. User submits to Council: "Add OAuth2 login with Google"

2. Council tick. AI brain reads board. Decides:
   → Create task for Engineering: "Implement Google OAuth2 backend + frontend"
   → Create task for Marketing: "Update help docs for Google login option"
   → Create task for Operations: "Add Google OAuth credentials to prod config"

3. Engineering Dept tick. AI brain breaks down:
   → Backend Team: "Add Google OAuth2 callback handler + token exchange"
   → Frontend Team: "Add 'Sign in with Google' button + redirect flow"
   → QA Team (later): "Test full Google OAuth2 flow end-to-end"

4. Backend Team tick. AI brain decomposes:
   → Worker 1: "Create /auth/google/callback endpoint"
   → Worker 2: "Create GoogleOAuthProvider class"
   → Worker 3: "Add Google user mapping to existing user table"

5. Workers work. Worker 2 reports:
   "question: Do we store Google refresh tokens or just access tokens?"

6. Backend Manager tick. AI brain:
   "This is an architecture decision. I'll decide: store both.
    Refresh tokens let us maintain sessions without re-prompting."
   → Message Worker 2 with answer.

7. Worker 3 reports:
   "blocked: I need the GoogleOAuthProvider from Worker 2 to map users"

8. Backend Manager tick. AI brain:
   "Worker 3 depends on Worker 2. Worker 2 is still in progress. Expected."
   → no_op. Wait.

9. Worker 2 finishes. Worker 3 gets unblocked (next get_my_task() shows
   "Worker 2 completed GoogleOAuthProvider — you can proceed").

10. All backend workers done. Backend Manager tick. AI brain:
    "All 3 subtasks done. But Worker 1 and Worker 2 might have conflicts."
    → Spawn integration worker: "Verify all 3 changes work together."

11. Integration passes. Backend Manager sends to Engineering Dept:
    "Backend OAuth2 implementation complete."

12. Frontend Team was working in parallel. They finish too.
    Frontend Manager sends to Engineering Dept:
    "Frontend Google login button complete."

13. Engineering Dept tick. AI brain:
    "Backend and Frontend both done. Time for QA."
    → Assign QA Team: "Test full Google OAuth2 flow."

14. QA Team spawns testers. Tester 1 reports:
    "FAIL: Google callback returns 500 when user denies consent."

15. QA Manager sends to Engineering Dept:
    "QA failure — Google consent denial not handled."

16. Engineering Dept routes to Backend Team:
    "Fix: handle user consent denial in /auth/google/callback"

17. Backend Manager respawns Worker 1 with QA feedback.
    Worker 1 fixes the error handling. Reports done.

18. QA re-tests. PASS.

19. Engineering Dept reports to Council: "OAuth2 implementation complete + tested."
    Marketing Dept reports: "Help docs updated."
    Operations Dept reports: "Credentials configured."

20. Council tick. AI brain:
    "All 3 departments done. Integration looks good.
     Create governance proposal for deployment."
    → Proposal created. Auto-approved (dev mode). Deployed.
```

**Every step is audited. Every board is persistent. Every AI call is fresh. Any orchestrator can crash and restart. The whole thing runs autonomously.**

---

## The Universal Orchestrator Unit

Every orchestrator in the entire hierarchy is the SAME TypeScript class, configured differently:

```typescript
interface OrchestratorConfig {
  id: string;                    // "backend-team", "engineering-dept", "council"
  parentId: string | null;       // null for council (top level)
  role: string;                  // "Backend Engineering Manager"
  rolePrompt: string;            // Full AI brain prompt with role-specific rules
  tickInterval: number;          // 60000ms for teams, 300000ms for depts, 600000ms for council
  maxWorkers: number;            // resource limit
  canCreateSubOrchestrators: boolean;  // departments can, teams usually can't
}

// The class is ~200 lines. The same class runs the council AND a 3-person team.
class Orchestrator {
  private db: SQLiteBoard;       // own task board
  private inbox: MessageBus;     // cross-team messages
  private workers: WorkerPool;   // managed worker processes
  private children: Map<string, Orchestrator>;  // sub-orchestrators (if any)

  async tick() {
    const board = this.db.getBoard();
    const messages = this.inbox.getUnread();
    const events = this.db.getEventsSince(this.lastTick);

    const actions = await callAI(this.config.rolePrompt, board, messages, events);

    for (const action of actions) {
      await this.execute(action);
    }
  }

  async execute(action) {
    switch(action.type) {
      case 'spawn_worker':        // start a Claude Code process
      case 'message_worker':      // send info to a worker's get_my_task()
      case 'respawn_worker':      // kill stalled process, fresh start same workspace
      case 'create_team':         // new child orchestrator
      case 'merge_teams':         // combine two children
      case 'send_message':        // cross-team via message bus
      case 'escalate':            // send to parent's inbox
      case 'move_to_qa':          // transition task state
      case 'complete_task':       // mark done, notify parent
      case 'escalate_to_user':    // needs human input
      case 'no_op':               // nothing to do this tick
    }
  }
}
```

**One class. One pattern. Infinite hierarchy depth. Scales from 3 agents to 10,000.**

---

## Part 3: Pando's Org Chart — What It Actually Looks Like

### The hierarchy

No human CEO. The council (top-reputation nodes, elected) is the AI CEO. It decides org structure, budget, strategy. Everything below it grows and shrinks dynamically based on need.

```
COUNCIL (AI CEO — elected from top-reputation nodes)
│  Board: org health, priorities, resource allocation, network strategy
│  Tick: every 10 min
│  Powers: create/destroy departments, allocate Lux budgets, set strategy
│  Constraint: structural changes require governance vote from network
│  Reflection: every N ticks, reviews "is the org structure working?"
│
├── ENGINEERING (department orchestrator)
│   │  Board: all code changes, features, bugs, architecture decisions
│   │  Tick: every 5 min
│   │  Powers: create/dissolve teams, allocate workers across teams
│   │
│   ├── Core Team (kernel, agents, storage, P2P)
│   │   │  Tick: 60s
│   │   └── Workers: coding agents
│   │
│   ├── Platform Team (scheduler, hosting, pipeline, content)
│   │   │  Tick: 60s
│   │   └── Workers: coding agents
│   │
│   └── Architecture Team (design decisions, cross-team code review)
│       │  Tick: 2 min
│       └── Workers: reviewer/researcher agents
│
├── OPERATIONS (department orchestrator)
│   │  Board: node health, deployments, infrastructure, uptime
│   │  Tick: every 2 min (ops needs faster response)
│   │
│   ├── Monitoring Team
│   │   └── Workers: health check agents, alert responders
│   │
│   └── Deployment Team
│       └── Workers: devops agents (builds, deploys, rollbacks)
│
├── QA (department orchestrator)
│   │  Board: test plans, regression results, quality gates
│   │  Tick: every 2 min
│   │
│   ├── Automated Testing
│   │   └── Workers: test runner agents
│   │
│   └── Code Review
│       └── Workers: reviewer agents (independent from engineering)
│
├── USER PROJECTS (department orchestrator — DYNAMIC)
│   │  Board: all active user requests, project lifecycle
│   │  Tick: every 60 sec (user-facing, needs speed)
│   │  Special: creates/dissolves project teams on demand
│   │
│   ├── Project-ABC Team (user said "build me a todo app")
│   │   │  Created on demand. Dissolved when delivered.
│   │   └── Workers: whatever the project needs (coder, designer, deployer)
│   │
│   ├── Project-XYZ Team (user said "analyze this dataset")
│   │   │  Totally different shape — researcher + analyst workers
│   │   └── Workers: research agents, data agents
│   │
│   └── (teams appear and disappear based on user demand)
│
└── FINANCE (department orchestrator — lightweight)
    │  Board: Lux economics, cost tracking, emission rates, budget reports
    │  Tick: every 10 min (not time-sensitive)
    │  Powers: flag overspending, recommend budget adjustments to council
    │
    └── Workers: analysis agents (cost reports, economic modeling)
```

### How department heads grow their teams

Each department orchestrator has full autonomy over its internal structure. The council doesn't micromanage.

**Example — Engineering grows:**
```
Engineering Dept AI brain reads board:
"We have 15 open tasks. Backend Team has 8, Platform Team has 7.
Backend Team is constantly overloaded (3 workers, 8 tasks).
Platform Team has slack (2 workers, 2 active tasks)."

Decision options the AI brain can choose:
1. Rebalance: move 3 tasks from Backend to Platform (if skills match)
2. Scale up: spawn more workers for Backend Team
3. Split: create a new "API Team" carved out of Backend
4. Escalate: tell Council "I need more budget for a new team"

AI picks based on judgment. If it needs budget → escalate to Council.
If it can rebalance within existing budget → just do it.
```

**Example — User Projects shrinks:**
```
User Projects AI brain reads board:
"Project-ABC delivered 2 days ago. Team still active but idle.
Project-XYZ has 1 task left, almost done."

Decision:
→ Dissolve Project-ABC Team (archive workspace, release workers)
→ Keep Project-XYZ alive until final task completes
→ Report to Council: "2 project teams active, 1 pending dissolution"
```

### The council's reflection cycle

Every 6th tick (roughly hourly), the council doesn't just read its board — it reflects on the WHOLE org:

```
REFLECTION PROMPT (hourly):

You are the AI CEO of Pando. Review the organization's health.

ORG STRUCTURE:
{full hierarchy tree with current sizes and tick rates}

DEPARTMENT REPORTS:
Engineering: 12 tasks active, 3 blocked, avg completion 2.1 hours
Operations: all green, 0 alerts, last deploy 45 min ago
QA: 2 test failures pending, both in auth module
User Projects: 4 active projects, 1 overdue
Finance: Lux budget 73% consumed this period

CROSS-TEAM ISSUES:
- Backend Team waiting on Content Team for 3 hours (copy for error msgs)
- QA blocked until Engineering delivers auth fix

METRICS (last 24h):
- Tasks completed: 47
- Tasks failed: 3
- Avg time to resolve cross-team request: 28 minutes
- Worker respawn rate: 12% (normal <15%)
- Escalations to user: 2

QUESTIONS:
1. Is the org structure optimal for current workload?
2. Are there bottlenecks that restructuring would fix?
3. Should any department budget change?
4. Are cross-team communication patterns efficient?
5. Any strategic priorities that need adjusting?

Return JSON actions:
[
  {action: "restructure", department: "...", change: "..."},
  {action: "adjust_budget", department: "...", new_budget: ...},
  {action: "create_department", name: "...", reason: "..."},
  {action: "set_priority", task: "...", priority: "..."},
  {action: "send_directive", target: "...", directive: "..."},
  {action: "no_change", reason: "..."}
]
```

**This is how the org evolves.** Not a fixed structure. The council continuously evaluates and restructures based on real data from every board in the hierarchy.

---

## Part 4: Known Flaws — Honest Assessment

### Flaw 1: AI brain can be wrong (PERMANENT — cannot be eliminated)

Every tick trusts AI to return good actions. Bad possibilities:
- Returns garbage JSON
- Makes a judgment call that's wrong (kills a worker that was actually making progress)
- Restructures the org unnecessarily
- Says "everything looks good" when it isn't

**Mitigations (contain the blast radius, don't eliminate the risk)**:
- **Schema validation**: reject any action not in the allowlist. AI can't invent new action types.
- **Guardrails**: structural changes (create/destroy teams) require governance vote. AI can't unilaterally restructure.
- **Rate limits**: max 5 actions per tick. Prevents runaway decision cascades.
- **Self-correction**: bad decisions cause visible problems on the board. NEXT tick (60 seconds), AI sees the consequences and can course-correct. Compare to current system: bad decisions go unnoticed for hours.
- **Audit trail**: every action logged. Can diagnose what went wrong and when.

**Honest verdict**: This flaw is inherent to using AI for judgment. Can't eliminate it. But blast radius is small (single tick) and correction is fast (next tick). Acceptable trade-off.

**On AI decision quality**: AI with structured board data makes better management decisions than 99% of human project managers. No ego, no bad days, no office politics, reads 40 status reports in 2 seconds, spots dependency patterns instantly. The real risk isn't "AI makes dumb decisions" — it's "AI gets fed bad data." And we mitigate that: AI verifies worker reports (doesn't blindly trust "done"), heartbeats detect stalls, QA is independent verification. The 1/10 point off is for truly novel situations where no pattern exists to reason from.

### ~~Flaw 2: Board gets too big for one AI call~~ — NOT A FLAW (hierarchy solves it)

Initially flagged as a concern: what if a board has 40 subtasks? The prompt becomes huge.

**Why this can't actually happen**: If a board has 40 items, the orchestrator has been mismanaged. A well-run orchestrator manages 5-8 direct reports, max. If work exceeds that, the correct action is `{action: 'create_team'}` — split into sub-orchestrators, each with their own board.

The hierarchy ENFORCES small boards. Every orchestrator only ever sees:
- Its 5-8 direct tasks/workers
- Messages from parent (instructions)
- Messages from children (reports)
- Messages from siblings (cross-team requests)

That's ~20-30 items max. Always fits in one prompt. If any board grows beyond ~15 items, the AI brain should split. Board size is self-regulating.

**Safety net**: hard cap of 20 direct reports per orchestrator. If an AI brain tries to manage more than 20, the orchestrator code rejects the `spawn_worker` action and requires a `create_team` first. Deterministic guardrail — can't be bypassed by a bad AI call.

**Verdict**: Not a flaw. The architecture prevents it by design.

### Flaw 3: Cross-team latency (TRADE-OFF — cannot fully eliminate)

Cross-team request path: Worker → Manager → Dept → Other Dept → Other Manager → Other Worker → reverse. Worst case 30+ minutes for a simple request.

**Mitigations**:
- **Fast-track**: urgent messages bypass normal tick queues, trigger immediate processing at each hop
- **Shortcuts**: AI brain can skip levels ("send directly to Content Team, don't go through Marketing Dept") for simple requests
- **The hierarchy adapts**: if two teams constantly need each other, the parent orchestrator detects the pattern and can: merge them, create a shared liaison, or restructure to reduce cross-team friction

**Honest verdict**: Real trade-off. Hierarchy adds safety + auditability but costs speed. Fast-track mitigates the worst cases. Acceptable for most workflows.

### Flaw 4: Circular dependencies (SOLVABLE)

Team A blocks Team B, Team B blocks Team A.

**Mitigations**:
- **Parent detection**: the parent orchestrator sees BOTH boards, detects the deadlock, breaks it with a judgment call ("Team A defines the interface first")
- **Timeout-based**: if a cross-team request is unanswered for >30 min, auto-escalate to parent
- **Hierarchy guarantees a breaker**: every pair of teams shares at least one common ancestor who can see both boards

**Honest verdict**: Solved by the hierarchy. A flat system has no breaker for circular deps. The parent IS the breaker.

### Flaw 5: Cost at scale (MANAGEABLE)

Estimated costs with 26 orchestrators, idle suppression, and dynamic tick rates:

| Scenario | Active orchestrators | AI calls/day | Estimated cost/day |
|---|---|---|---|
| Quiet (no active tasks) | 2 (council + finance) | ~300 | ~$10 |
| Normal (a few projects) | 10 | ~5,000 | ~$50-100 |
| Busy (full org working) | 26 | ~15,000 | ~$200-400 |
| Peak (urgent cross-dept task) | 26 at max tick rate | ~30,000 | ~$500-900 |

**Mitigations**:
- **Idle suppression**: no board activity + no messages = skip AI call, just check heartbeats (free)
- **Dynamic tick rate**: active → 60s. Idle → 10 min. Event → immediate.
- **Cheap model for ticks**: manager brain reads a board and returns JSON. Haiku-class model ($0.001/call) works fine. Save expensive models (Opus) for workers who write code.
- **Lux-funded**: orchestration cost is paid from Lux treasury. As network grows and earns more Lux, budget grows proportionally.

**Honest verdict**: $50-400/day for full autonomous org management is cheap compared to human equivalents. With idle suppression + cheap models, this is sustainable.

### Flaw 6: Worker goes off-track within its task (MITIGATED)

Worker has a 30-minute coding task. After 20 minutes, context compacts, worker loses focus.

**Mitigations**:
- **Short tasks**: AI brain should decompose into 10-15 min subtasks. Less time to lose focus.
- **Heartbeat timeout**: no `report_progress()` for 5 min → kill and respawn at same workspace.
- **MCP lifeline**: `get_my_task()` gives worker full context recovery from SQLite. Even if conversation compacts, 2-line rule survives: "call get_my_task() when confused."
- **Workspace persistence**: respawned worker sees all its code. Fresh brain + existing work = picks up where it left off.

**Honest verdict**: Much better than current system (hours-long sessions). Not perfect — a 15-min session can still drift. But heartbeat catches the worst cases within 5 minutes. Acceptable.

### Flaw 7: Who watches the council? (SOLVED by governance)

The council is the top. If it makes bad strategic decisions, who corrects it?

**Mitigations**:
- **Governance**: structural decisions (create/destroy departments) require network-wide vote. Council can't unilaterally restructure without consensus.
- **Reflection cycle**: council periodically reviews "is my strategy working?" using real metrics. Self-correction built in.
- **Deterministic watchdog**: a simple Node.js process (NOT AI) monitors the council's heartbeat. If council orchestrator crashes → auto-restart. Reads board from SQLite, continues.
- **User/founder override**: humans can submit directives via gateway that override council priorities.
- **Constitutional constraints**: Pando's Two Laws (no harm, survive) are hardcoded in Guardrails, not in AI prompts. AI can't override them.

**Honest verdict**: Solved. Multiple layers of protection. No single point of unaccountable authority.

### Overall score card

| Aspect | Score | Notes |
|---|---|---|
| Context loss prevention | 9/10 | Fresh AI calls + SQLite memory. The core innovation. |
| Reliability (never gets permanently stuck) | 8/10 | Deterministic timers + kill/respawn + parent deadlock breaking. |
| Scalability | 8/10 | Fractal pattern scales naturally. Cost is the constraint. |
| Cross-team communication | 6/10 | Works but slow. Fast-track + shortcuts help. Not real-time. |
| Decision quality | 9/10 | AI with structured data outperforms human managers. Risk is bad input, not bad judgment. |
| Cost efficiency | 7/10 | Idle suppression + cheap models. $50-400/day is sustainable. |
| Full autonomy (no human needed) | 8/10 | Governance is the safety net. Rare edge cases may need human. |
| Visibility / auditability | 10/10 | Every tick, every action, every message — logged in SQLite. |
| Self-organization | 8/10 | Council reflection + department autonomy. Dynamic growth/shrink. |
| Resilience to crashes | 9/10 | All state in SQLite. Any component restarts and picks up from board. |

---

## Part 5: Production Reality Check — 7 Practical Flaws

These are not theoretical. These are what would break when the code actually runs.

### Production Flaw 1: Workers edit the same files — merge hell

3 workers on the same team, all editing auth.ts in separate workspaces. All 3 finish. Now what?

**Solutions (in order of preference)**:
1. **File ownership decomposition**: AI brain assigns non-overlapping file scopes at decomposition time. "Worker 1 owns auth/, Worker 2 owns providers/, Worker 3 owns db/". No conflicts by design.
2. **Sequential for coupled work**: if subtasks touch the same files, run them sequentially. Worker 1 finishes → Worker 2 starts from Worker 1's output. Slower but no conflicts.
3. **Shared workspace with branches**: same-team workers share a git repo, each on a branch. Orchestrator merges branches (or spawns a merge worker).

Option 1 is best. AI brain is smart enough to decompose by file scope most of the time. Options 2 and 3 are fallbacks.

### Production Flaw 2: No learning between ticks — goldfish memory

Every AI brain call is fresh. The AI doesn't learn from past mistakes. It might kill a worker during a long compilation EVERY tick because it doesn't remember doing it last tick.

**Solution**: A `lessons` table in the board database.

```sql
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY,
  orchestrator_id TEXT NOT NULL,
  lesson TEXT NOT NULL,
  source TEXT,           -- 'self', 'parent', 'human', 'postmortem'
  created_at TEXT NOT NULL
);
```

Lessons are included in EVERY AI brain prompt. "Worker compilations can take 15+ min. Don't timeout during builds." Persists across ticks. The AI learns permanently, not per-conversation.

Critical addition. Without this, the system repeats the same mistakes forever.

### Production Flaw 3: AI call is a bottleneck and single point of failure

The tick is blocked while waiting for AI response (3-15 seconds). If AI API is down, the entire orchestrator is blind.

**Solution**: Two-tier decision making.

```
TIER 1: DETERMINISTIC (instant, no AI call, handles 80% of ticks)
  - Worker reports "done" → update board status
  - Worker reports "working" → update heartbeat timestamp
  - Heartbeat timeout → add event to board (don't act yet)
  - Message arrives → store in inbox
  - Board unchanged since last tick → skip AI call entirely

TIER 2: AI JUDGMENT (only when a decision is needed, ~20% of ticks)
  - Worker output needs verification
  - Heartbeat timeout needs decision (kill or wait)
  - Worker asked a question
  - All subtasks done (ready for QA?)
  - Cross-team message needs routing
  - New task arrived, needs decomposition
```

Most ticks are Tier 1 — pure bookkeeping, instant, free. AI is only called when judgment is needed. Cuts cost by 80%, removes latency bottleneck, and means the system keeps basic operations running even during AI API outages.

### Production Flaw 4: Knowledge dies with the team — no institutional memory

February: Security team discovers HS256 is vulnerable. Fixes it. Team dissolved. June: New worker picks HS256 because it's simpler. Vulnerability reintroduced.

**Solution**: Org-wide knowledge base, read by every AI brain prompt.

```sql
CREATE TABLE org_knowledge (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,      -- 'architecture', 'pitfall', 'pattern', 'banned'
  knowledge TEXT NOT NULL,
  source TEXT,                 -- which team/task discovered this
  created_at TEXT NOT NULL
);
```

When a team dissolves, the orchestrator extracts key lessons into org_knowledge. Every AI brain prompt includes relevant entries. Knowledge outlives the team.

This is like Pando's genome — but for the org's operational experience. Grows over time.

### Production Flaw 5: The self-upgrade paradox

The orchestrator has a bug. Workers assigned to fix it are MANAGED by the broken orchestrator. They might get killed by the very bug they're trying to fix.

**Solution**: The orchestrator is upgraded from OUTSIDE itself. Never through its own hierarchy.

```
1. External trigger (human, standalone script, or upgrade-protocol)
2. git pull → npm run build → restart node
3. On restart, orchestrator loads boards from SQLite (no state lost)
4. Fixed orchestrator continues where it left off
```

This already exists in Pando's upgrade-protocol. The orchestrator just needs to be part of it. No self-referential upgrades.

### Production Flaw 6: AI quality variance — different answer every call

Same board, same prompt, two calls → two different decisions. Temperature=0 helps but doesn't guarantee identical outputs.

**Solutions** (layered):
- **Temperature = 0** for all brain calls (maximize consistency)
- **Lessons table** makes outputs more predictable (explicit rules > implicit reasoning)
- **Deterministic action validation**: orchestrator code checks AI output against board state before executing. "You said kill Worker B, but Worker B reported progress 30 seconds ago. Rejecting." Bad decisions caught before they execute.
- **Parent review for destructive actions**: kills, restructures, budget changes → flagged for parent orchestrator review on next tick. Two opinions better than one.

### Production Flaw 7: Real-time collaboration impossible — tick cycle floor

Every worker-to-worker exchange goes through the orchestrator's tick cycle. Minimum 60-second round trip. A 3-round code review takes 6+ minutes via the board. Over Slack it takes 3 minutes.

**Solution**: Paired worker channels for tight collaboration.

```
Manager AI brain decides: "Worker A needs code review from Worker B.
  This is tight collaboration, not a hand-off."

Action: {action: 'pair_workers', worker_a: 'A', worker_b: 'B',
  mode: 'review', timeout: '15min'}

Orchestrator creates a SHARED CHANNEL:
  - Both workers get an MCP tool: send_to_peer(message)
  - Messages go directly between workers, no tick delay
  - Manager still sees everything (audit trail) but doesn't mediate
  - After 15 min or task complete, channel closes
```

Controlled exception to the "everything through the board" rule. Only for same-team, tight collaboration, with timeout and audit.

---

### Updated score card (after production fixes)

| Aspect | Before fixes | After fixes | Key change |
|---|---|---|---|
| Context loss prevention | 9/10 | 9/10 | — |
| Reliability | 8/10 | 9/10 | Tier 1/2 split handles API outages |
| Scalability | 8/10 | 8/10 | — |
| Cross-team communication | 6/10 | 6/10 | Inherent trade-off of hierarchy |
| Decision quality | 9/10 | 9/10 | — |
| Decision consistency | — | 8/10 | NEW: temp=0 + lessons + validation + parent review |
| Cost efficiency | 7/10 | 9/10 | Tier 1/2 cuts 80% of AI calls |
| Full autonomy | 8/10 | 8/10 | — |
| Institutional memory | — | 8/10 | NEW: org_knowledge + lessons tables |
| Code merge / collaboration | — | 7/10 | NEW: file ownership decomposition + sequential fallback |
| Real-time collaboration | — | 7/10 | NEW: paired worker channels |
| Visibility | 10/10 | 10/10 | — |
| Resilience | 9/10 | 9/10 | — |

---

## Part 6: Complete Walkthrough — "Build me a weather app"

### Timeline (30 minutes, 8 AI calls, ~22 ticks pure code)

```
 0:00  CODE   User request → SQLite insert on council board
 0:10  AI     Council reads board. Decides: create project team. (5 sec)
       CODE   New orchestrator "project-weather-app" created. Task sent to inbox.
 1:10  AI     Project manager reads inbox. Decomposes into 2 subtasks. (8 sec)
              Assigns file ownership: W1=src/api/, W2=src/ui/. No overlap.
       CODE   Spawns Worker 1 (backend) + Worker 2 (frontend). Board updated.
 2:00  CODE   Tick: check heartbeats. W1 OK, W2 OK. Board unchanged. No AI call.
 3:00  CODE   Tick: heartbeats OK. No AI.
 4:00  CODE   Tick: heartbeats OK. No AI.
 5:00  CODE   Tick: heartbeats OK. No AI.
 6:00  CODE   Tick: heartbeats OK. No AI.
 7:00  CODE   Tick: heartbeats OK. No AI.
 8:00  CODE   W2 calls report_progress("question", "React or plain HTML?")
       AI     Manager reads board change. Decides: "plain HTML, keep it simple." (3 sec)
       CODE   Answer written to W2's task record. W2 gets it via get_my_task().
 9:00  CODE   Tick: heartbeats OK. No AI.
10-13  CODE   Ticks: workers coding. Heartbeats OK. No AI. (4 ticks)
14:00  CODE   W1 calls report_progress("done", "Backend API complete.")
       AI     Manager: "W1 claims done. Wait for W2 before integration." (4 sec)
       CODE   Board updated: W1=review.
15-18  CODE   Ticks: W2 still working. No AI. (4 ticks)
19:00  CODE   W2 calls report_progress("done", "Frontend complete.")
       AI     Manager: "Both done. Spawn integration worker." (5 sec)
       CODE   Spawns W3 with access to both workspaces.
20-21  CODE   Ticks: W3 testing. Heartbeats OK. No AI. (2 ticks)
22:00  CODE   W3 calls report_progress("error", "URL mismatch: /api/weather vs /weather")
       AI     Manager: "Tell W2 to fix URL. Respawn W2." (4 sec)
       CODE   W2 respawned with fix instruction + same workspace.
23-25  CODE   W2 fixes one line. W3 retests. Ticks: heartbeats OK. (3 ticks)
26:00  CODE   W3 calls report_progress("done", "PASS. App works.")
       AI     Manager: "Complete. Notify council." (3 sec)
       CODE   Task marked done. Message sent to council inbox.
30:00  AI     Council: "Deliver to user. Dissolve team." (3 sec)
       CODE   User notified. Team archived. Tick loop stopped.
```

### Key observations:
- **8 AI calls in 30 minutes** — AI was "thinking" for ~40 seconds total
- **~22 ticks were pure code** — checking heartbeats, updating timestamps (free, instant)
- **Hierarchy grew and shrank dynamically** — team created at 0:10, dissolved at 30:00
- **Problem found and fixed** (URL mismatch) without human intervention
- **Every action logged in SQLite** — full audit trail, queryable forever
- **No agent forgot anything** — board was the memory throughout

---

## Part 7: The Safety Chain — 5 Layers, Every Failure Caught

### The layers

```
LAYER 1: Worker catches itself
  │  HOW: MCP tools (get_my_task, report_progress)
  │  WHAT: Worker reports status, asks questions, recovers context
  │  FAILS WHEN: Worker forgets to call the tools
  ↓
LAYER 2: Orchestrator CODE catches the worker
  │  HOW: Heartbeat timer (deterministic, checks SQLite timestamps)
  │  WHAT: Detects silence >5 min, adds event to board
  │  FAILS WHEN: Never. It's a setInterval checking a number. Always runs.
  ↓
LAYER 3: AI brain makes a judgment call
  │  HOW: Fresh stateless AI call, reads board + events
  │  WHAT: Decides what to do — respawn, answer, escalate, wait
  │  FAILS WHEN: AI API down, or AI makes a bad call
  ↓
LAYER 4: Parent orchestrator catches the child
  │  HOW: Parent's own tick reads child's board, detects lack of progress
  │  WHAT: Restarts child orchestrator, or takes over management
  │  FAILS WHEN: Parent is also stuck (but THEIR parent catches THEM)
  ↓
LAYER 5: Deterministic watchdog catches the council
  │  HOW: 10-line Node.js script, no AI:
  │    if (council_last_tick > 15_minutes_ago) restart('council');
  │  WHAT: Restarts the top-level orchestrator
  │  FAILS WHEN: Node process itself crashes (systemd/PM2 restarts it)
```

Every layer uses a DIFFERENT mechanism. No single failure mode takes out multiple layers.

### Failure scenario: Worker forgets to report

```
Min 0-9:   Worker coding, forgets report_progress(). Process alive but silent.
Min 10:    LAYER 2 (code): heartbeat timeout. Event added to board.
           LAYER 3 (AI): reads board. "W2 silent 10 min. Task is medium complexity."
           AI reads worker's last console output. Sees worker wrote a TODO comment
           about needing an API key. Worker didn't ask — just stopped.
           AI answers the unasked question: "Use the key from resource registry."
           Action: respawn worker with the answer.
Min 11:    Worker respawned. Fresh context. Sees answer via get_my_task(). Continues.
```

**Worker never needed to remember to report. Code caught the silence. AI understood what the worker needed by reading its output.**

### Failure scenario: Manager AI makes bad calls repeatedly

```
Min 0:     Manager AI marks W1 "done" when W1 actually reported "blocked." Bad call.
Min 1-5:   Manager ticks return no_op (thinks everything is fine). W1 sitting blocked.
Min 5:     LAYER 2: W1 heartbeat times out (stopped working because blocked).
Min 6:     LAYER 3: AI sees timeout + board inconsistency. "W1 says done but timed out.
           Let me check events table." Finds W1's real report was "blocked." Self-corrects.
           BUT IF AI KEEPS MAKING BAD CALLS:
Min 10:    LAYER 4: Parent orchestrator ticks. "project-weather-app hasn't reported
           progress in 10 min." Parent reads child's board directly. Sees the mess.
           Parent restarts child orchestrator. Fresh AI brain reads clean board. Fixed.
```

### Failure scenario: AI API completely down

```
Min 0:     Claude API goes down.

STILL RUNNING (code, no AI):
  ✓ Workers that are mid-task keep working (separate Claude Code processes)
  ✓ Heartbeat monitoring (code checks timestamps)
  ✓ Worker reports stored in SQLite (MCP tools still work)
  ✓ Messages queue up in message bus (not lost)
  ✓ Watchdog running (dumb timer)

PAUSED (needs AI):
  ✗ No new decisions. No decomposition. No question answering.
  ✗ Workers that finish → "done" stored, but nobody reviews.
  ✗ Workers that get stuck → "blocked" stored, but nobody helps.

Min 30:    API comes back.
           Next tick: AI brain sees 30 min of queued events.
           Processes them all in one call. System catches up. Continues normally.
```

**System degrades gracefully. Doesn't crash. Pauses decisions and resumes.**

### Failure scenario: Everything is stuck (worst case)

```
Min 0:     Worker stuck.
Min 5:     Manager stuck (bad AI calls).
Min 10:    Parent stuck too.
Min 15:    Council stuck.
Min 16:    LAYER 5: Watchdog (10 lines of code, no AI):
             "Council hasn't ticked in 15 min. Restarting."
           Council restarts. Reads board from SQLite.
           Council's tick: inspects children → finds stuck parent
           → restarts parent → parent inspects project → fixes manager
           → manager respawns worker. Chain recovered.
Min 20:    Everything running again. Total downtime: ~20 min.
           No data lost (everything was in SQLite the whole time).
```

### Why each layer exists

| Layer | Catches | Mechanism | Can fail? |
|---|---|---|---|
| 1. Worker MCP | Worker forgetting its task | get_my_task() call | Yes — worker might forget to call it |
| 2. Code timer | Worker silence | setInterval + SQLite timestamp | No — code always runs |
| 3. AI brain | Complex judgment calls | Fresh API call per tick | Yes — API down or bad decision |
| 4. Parent | Child orchestrator failure | Parent's own tick cycle | Yes — but parent's parent catches them |
| 5. Watchdog | Council death | 10-line dumb script | No — it's too simple to break |

Layers 2 and 5 are the anchors — pure code, cannot fail (short of the machine itself dying, which systemd/PM2 handles).

---

## Part 8: THE CORE PRINCIPLE — The System Cannot Get Stuck

### Why "stuck" is impossible

The council is the AI CEO with full authority. There is no human above it. There is nobody to escalate to. This means:

```
Every tick, the AI brain MUST return actions.

Can it return "escalate_to_user"?  → NO. There is no user. Not a valid action.
Can it return "I don't know"?      → NO. Not a valid action type.
Can it return nothing?             → NO. Schema requires at least one action.

It MUST decide. Every tick. No exceptions.
```

If the decision is bad — consequences appear on the board. Next tick (60 seconds), the AI sees the consequences and course-corrects. Bad decisions are TEMPORARY. They get fixed by the feedback loop.

### The system has exactly 2 states

```
1. WORKING — tasks exist, agents running, decisions being made
2. IDLE    — no external tasks, nothing requested

There is no STUCK state. It cannot exist by design.
```

### Even "idle" produces work

The council doesn't sit idle. During no-task periods, it reflects:

```
Council idle tick:
  AI brain: "No user tasks. Let me review the org's health.
  - Test coverage is 72%. Should be 90%.
  - Deploy pipeline failed twice last week.
  - Cross-team request latency averaging 28 min. Can we improve?

  Actions:
  → Create task for Engineering: 'Improve test coverage to 90%'
  → Create task for Operations: 'Fix deploy pipeline reliability'
  → Create task for Architecture: 'Design faster cross-team routing'"
```

**The org is never truly idle. It's always improving itself. This IS the self-sustaining loop.**

### The decision authority rule

In fully autonomous mode, the `escalate_to_user` action is REMOVED from the action schema. The council has every action type EXCEPT escalation to a human. It must decide with its own judgment.

```
AUTONOMOUS MODE action types:
  spawn_worker       ✓
  message_worker     ✓
  respawn_worker     ✓
  create_team        ✓  (may require governance vote)
  dissolve_team      ✓
  send_message       ✓
  escalate_to_parent ✓  (child → parent, within the org)
  update_status      ✓
  move_to_qa         ✓
  complete_task      ✓
  adjust_budget      ✓
  restructure        ✓  (may require governance vote)
  no_op              ✓  (with mandatory reason)
  escalate_to_user   ✗  REMOVED — no human in the loop

USER-ASSISTED MODE (optional):
  All of the above PLUS:
  escalate_to_user   ✓  (for nodes where a human operator is available)
```

The mode is configurable per node. A node with an active human operator can enable user escalation. A fully autonomous node runs without it.

### What this means for Pando

This is the self-sustaining loop from Pando's vision, implemented architecturally:

```
1. Council reflects → finds something to improve
2. Council creates task → delegates to engineering
3. Engineering decomposes → assigns to workers
4. Workers build → report done
5. QA tests → pass or fail → loop back if fail
6. Code ships → governance approves → network upgrades
7. Council reflects again → "what can we improve NOW?"
8. GOTO 1
```

The loop never stops. The org never sleeps. As long as the node is running, the system is either working on a task or finding the next task to work on. It is a perpetual motion machine of improvement, bounded only by Lux budget and compute resources.

**This is the answer to "what does Pando do when nobody is using it?" It improves itself.**

---

## Part 9: Open Questions (remaining)

### Integration with Pando (highest priority)
- The existing council.ts, agent-manager.ts, agent.ts, bridge-queue.ts, scheduler.ts — which pieces are replaced, which are kept, which are adapted?
- Does the Orchestrator class replace AgentManager or wrap it?
- Does the message bus replace BridgeQueue or extend it?
- SQLite boards — new database or extend existing task_queue.ts?
- How does the orchestrator interact with PandoNode? Is it a subsystem like HealthMonitor?

### P2P Distribution
- In a decentralized network, where do orchestrators physically run?
- Can the Engineering Dept orchestrator run on Node A while its Backend Team orchestrator runs on Node B?
- Should boards sync across nodes via GossipSub (like the ledger)?
- Council election: current reputation-based selection stays? Or does governance need updating?
- What happens during a network partition? (two sub-networks each think they're the org)

### The Worker ↔ Orchestrator Interface
- Workers currently use Claude Code's `claude -p` spawn model. Does that change?
- The MCP tools (get_my_task, report_progress) — are these real MCP tools or custom?
- Worker workspace: git worktree per worker? Branch per worker? Separate repo clone?
- How does a worker's code get merged with other workers' code?

### The AI Brain Contract
- Exact prompt templates per level (council, department, team)
- Schema validation for AI responses (JSON schema for action lists)
- What model per level? (Council: Opus? Departments: Sonnet? Teams: Haiku?)
- Fallback when AI call fails (network error, rate limit, bad response)
- How to inject Pando-specific knowledge (genome, codebase structure) into brain prompts

### Migration Plan
- Can we build this alongside the existing system and switch over?
- What's the minimum viable version? (single orchestrator + workers, no hierarchy yet)
- Testing: how do we verify the orchestrator makes good decisions?
- Rollback: if the new system is worse, how do we go back?

---

## Next Steps

1. **Answer the Pando integration questions** — map existing components to new architecture
2. **Design the Orchestrator class** — TypeScript interface, SQLite schema, tick loop
3. **Design the message bus** — SQLite schema, delivery guarantees, cross-team routing
4. **Design worker MCP tools** — get_my_task() + report_progress() specification
5. **Write AI brain prompts** — per level, with schema validation
6. **Build MVP** — single orchestrator + 3 workers, no hierarchy. Prove the pattern works.
7. **Add hierarchy** — council → department → team. Prove fractal scaling.
8. **Migration** — swap out existing council for new orchestrator system
9. **P2P distribution** — orchestrators across multiple nodes

---

*This document is a living brainstorm. Updated 2026-02-27 as we work through the design.*
