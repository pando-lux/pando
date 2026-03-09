# Team Architecture Roadmap

> **STATUS: PHASES 1-3, 4-5, 6.1, 7 COMPLETE** — Phases 6.2+, 8 remain TODO.
> Updated: 2026-03-09
> Master plan for the team/agent/template system.

---

## Core Design Principle: Lead-First Teams

Every team starts with **1 lead agent**. The lead:
1. Assesses the project/task scope
2. Decides what sub-agents it needs
3. Spawns agents from templates via HTTP API (or creates new ones)
4. Manages agent lifecycle (start, stop, reassign)
5. Is the brain — workers are hands

**pando-infra (council) is a special case**: jumpstarted with 3 pre-seeded agents
(lead + observer + qa) because we know exactly what infrastructure management needs.
Same pipeline, just pre-populated. All other teams start with 1 lead.

```
Default team:     [Lead] → lead assesses → spawns worker/tester/observer as needed
Council team:     [Lead + Observer + QA] → pre-seeded, same pipeline, jumpstarted once
Future user team: [Lead] → user picks template → lead fills in the gaps
```

**Tool architecture:** PandoCode tools (manage_tasks, send_message, etc.) work for API
models (Gemini, GPT) but are silently dropped for Claude Code CLI. All agent operations
are exposed as HTTP API endpoints. Claude Code agents use curl. See BIBLE.md Section 3.2.10.

---

## Current State (2026-03-09)

### Completed
- **Phase 1** (dee3933c): Prompts parameterized, BIBLE synced, shared constants, universal lead prompt, scheduler cleanup
- **Phase 2** (dee3933c): 5 built-in templates, `manage_team` tool, `spawnTeamAgent`/`stopTeamAgent`, 10-agent cap
- **Phase 3** (ea2559bc): Custom JSON templates on disk, template CRUD API, `getTemplates()` merges built-in+custom
- **Phase 6.1** (3ae904f3): Session persistence — save/restore Claude CLI session IDs across restarts
- **Phase 7** (ea2559bc + e622e1f4): All team API endpoints complete (status, tasks, agents, cost, spawn, stop, message)
- **Claude Code tool fix** (e622e1f4): HTTP API for all agent operations, prompts use curl not PandoCode tools, state table schema fixed
- **pando-code** (d948ed6): `createClaudeCodeModel()` accepts `initialSessionId`, exposes `getSessionId()`

### Live Tested ✅
- Lead processes board tasks autonomously ✅
- Lead spawns workers via HTTP API (curl to /v1/teams/:id/agents/spawn) ✅
- Stop agents via HTTP API ✅
- Inter-agent messaging via HTTP API ✅
- Template CRUD (list, create, delete) ✅
- Board task CRUD (create, update via PATCH) ✅
- `manage_team` PandoCode tool: NOT usable with Claude Code CLI (by design — use HTTP API instead) ✅

- **Phase 4** (pando-code 0120cd2): Network Teams view — dashboard, team cards, agents, board, cost
- **Phase 5** (pando-code 8c820cd, pando-node f8d0c5dd): Agent detail panel — messages, per-agent cost, model badges

### Still TODO
- **Phase 6.2+**: Cross-node migration, graceful degradation
- **Phase 8**: Gateway integration (full dashboard)
- **E2E**: Playwright headed test run to verify all flows work as a user

---

## Phase 1: Foundation Cleanup (NOW)

### 1.1 Parameterize Prompts
- **Problem**: QA prompt has `/c/Users/jaira/Desktop/Code/pando/node` — won't work on EC2
- **Fix**: Convert `OBSERVER_PROMPT`, `QA_PROMPT`, `LEAD_PROMPT` from const strings to
  template functions that take `{ projectDir, apiPort, repos }` context
- **Where**: engine-adapter.ts — prompts become `makeQAPrompt(ctx)` etc.
- **When called**: In `startTeam()`, where `nodeRepoRoot` and `apiPort` are already known

### 1.2 BIBLE.md Sync
Fix 7 stale items:
1. Observer/QA model: `gemini-2.5-flash` → `claude-code`
2. Tick intervals: 30min → 60min (observer), 120min (QA)
3. Method names: `getCouncilBoard()` → `getTeamBoard()`
4. `enableCouncil` flag: not removed, still checked in init-platform.ts
5. Lead vs non-lead tick asymmetry: document custom interval + inbox injection
6. Board snapshot format: document the `getBoardSnapshot()` output
7. Team inbox key structure: `msg:{agentId}:{uuid}` in state table

### 1.3 Legacy Cleanup
- Extract `HARM_PATTERNS`/`SHUTDOWN_PATTERNS` to shared constants (duplicated in api-server.ts + engine-adapter.ts)
- Remove unused `claudePath` parameter from Scheduler constructor
- Clean up stale index.ts exports from deleted ai-backend files

### 1.4 Default Team = 1 Lead
- **Current**: Non-infra teams get useless stub: `{ prompt: 'You manage the X team.' }`
- **Fix**: Give the default lead a real prompt — a **universal lead template** that:
  - Reads its project context (what repo, what stack)
  - Checks its board for pending tasks
  - Decides if it needs sub-agents for the current workload
  - Has access to `manage_team` tool for spawning agents
- **pando-infra**: Unchanged — still jumpstarted with 3 agents

### TEST MILESTONE 1
```
✓ npm run build passes
✓ Start node on Windows → prompts use correct dynamic paths
✓ Start node on EC2 → prompts use EC2 paths (no /c/Users/jaira)
✓ Create a non-infra team → lead gets real universal prompt, not stub
✓ E2E: existing 71 tests still pass
```

---

## Phase 2: Template System

### 2.1 Built-in Templates (TypeScript)
Templates are just data — role + prompt skeleton + defaults:

```typescript
// Built-in templates (ship with code, versioned)
const BUILT_IN_TEMPLATES: AgentTemplate[] = [
  {
    id: 'worker',
    displayName: 'Worker',
    description: 'Simple task executor. Does what the lead tells it.',
    role: 'worker',
    promptSkeleton: 'You are a worker agent. Execute the task given to you. Use bash, read, write, edit tools. Report results back to lead via send_message. Be brief. Act, don\'t narrate.',
    model: 'claude-code',
    tickIntervalMs: 0,   // no tick — runs on demand only
  },
  {
    id: 'builder',
    displayName: 'Builder',
    description: 'Code writer with git access. Builds features, fixes bugs.',
    role: 'builder',
    promptSkeleton: 'You are a builder agent. You write code, fix bugs, and build features. Always: read before edit, npm run build after changes, git commit with descriptive message. Report results to lead.',
    model: 'claude-code',
    tickIntervalMs: 0,
  },
  {
    id: 'tester',
    displayName: 'Tester',
    description: 'Runs tests and reports failures. Read-only codebase access.',
    role: 'tester',
    promptSkeleton: 'You are a tester agent. Run tests: npm run build, npx playwright test. Report failures to lead with specific error messages and file:line locations. Do NOT modify code.',
    model: 'claude-code',
    tickIntervalMs: 0,
  },
  {
    id: 'observer',
    displayName: 'Observer',
    description: 'Monitors health. Reports anomalies. Read-only.',
    role: 'explorer',
    promptSkeleton: 'You are an observer agent. Monitor system health via pando_status and pando_peers. Report anomalies to lead. You are READ-ONLY. Never modify code or files.',
    model: 'claude-code',
    tickIntervalMs: 60 * 60_000, // 1 hour default
  },
  {
    id: 'reviewer',
    displayName: 'Code Reviewer',
    description: 'Reviews code changes for quality, security, and architecture.',
    role: 'reviewer',
    promptSkeleton: 'You are a code reviewer. Review diffs for: security vulnerabilities, architectural violations, code quality issues. Report findings to lead.',
    model: 'claude-code',
    tickIntervalMs: 0,
  },
];
```

**Key design**: Templates are intentionally simple. The lead customizes them per-task
by appending context when spawning: `spawn_agent(template: 'builder', task: 'Fix the login bug in auth.ts')`.

### 2.2 Template Interface
```typescript
interface AgentTemplate {
  id: string;
  displayName: string;
  description: string;
  role: string;
  promptSkeleton: string;       // base prompt — lead appends task-specific context
  model: string;                // default model
  tickIntervalMs: number;       // 0 = on-demand only (no periodic tick)
  // Future:
  // tools?: string[];          // restrict which tools this agent can use
  // maxTokens?: number;        // budget cap per invocation
  // scope?: string[];          // file/dir access restrictions
}
```

### 2.3 `manage_team` Tool for Leads
Give lead agents a tool to manage their team:

```typescript
manage_team({
  action: 'spawn',              // spawn | stop | list | update
  template: 'builder',          // template ID
  task: 'Fix the login bug',    // task context (appended to template prompt)
  agentId: 'builder-1',         // optional custom ID (auto-generated if omitted)
})
// → Creates persistent agent in team, registers in shared DB
// → Returns { agentId, status: 'spawned' }

manage_team({
  action: 'list',               // list all agents in this team
})
// → Returns [{ id, role, status, lastActive }]

manage_team({
  action: 'stop',
  agentId: 'builder-1',
})
// → Stops agent, removes from active team, keeps history in DB
```

### 2.4 Lead Decides, Not Humans
The universal lead prompt includes:
```
You have access to `manage_team` tool. When you need help:
- For code fixes: spawn a 'builder' agent
- For test verification: spawn a 'tester' agent
- For code review: spawn a 'reviewer' agent
- For monitoring: spawn an 'observer' agent
- For simple tasks: spawn a 'worker' agent

You can also create CUSTOM agents by providing a full prompt instead of a template.
Agents you spawn share your team's database. Communicate via send_message.

Rules:
- Don't spawn agents you don't need. A simple task doesn't need a team.
- Stop agents when their work is done. Don't leave idle agents running.
- Workers are disposable. Spawn for a task, get result, stop.
```

### TEST MILESTONE 2
```
✓ Lead agent can call manage_team(action: 'list') and see team members
✓ Lead agent spawns a 'worker' for a simple task → worker executes → lead gets result
✓ Lead agent spawns a 'builder' for a code fix → builder edits file → build passes
✓ Lead agent stops a worker after task completion
✓ Council lead (pando-infra) still works with pre-seeded 3 agents
✓ Template catalog accessible via GET /v1/templates
```

---

## Phase 3: Custom Templates

### 3.1 JSON Template Files
```
~/.pando/teams/templates/
  worker.json        → built-in (shipped with code, can be overridden)
  builder.json       → built-in
  council.json       → pre-seeded 3-agent team template
  my-custom.json     → user-created
```

### 3.2 Lead Creates Templates
When a lead creates a custom agent with a novel prompt, it can save it as a template:
```
manage_team({
  action: 'spawn',
  customPrompt: 'You are a documentation agent. Read code, generate JSDoc comments...',
  saveAsTemplate: 'doc-writer',  // optional: saves for reuse
})
```

### 3.3 Template API
```
GET    /v1/templates                    → list all templates (built-in + custom)
GET    /v1/templates/:id               → get template details
POST   /v1/templates                    → create custom template
PATCH  /v1/templates/:id               → update template
DELETE /v1/templates/:id               → delete custom template (can't delete built-in)
```

### 3.4 User-Submitted Templates (FUTURE)
- Users submit templates via gateway UI
- Templates reviewed (governance? lead review?)
- Approved templates available to all teams on the network
- Versioned: v1.0, v1.1, etc.

### TEST MILESTONE 3
```
✓ Custom template JSON file created → lead can spawn agent from it
✓ Lead creates agent with custom prompt → template saved to disk
✓ GET /v1/templates returns built-in + custom templates
✓ Custom template overrides built-in (same ID)
```

---

## Phase 4: PandoCode Web UI — Network Projects

### 4.1 Linked Workspaces Config
- **In pando-code repo**: `PandoCodeConfig.network` option
- `network.enabled: boolean` — toggle pando-node link
- `network.autoDiscover: boolean` — scan `~/.pando/teams/` for team DBs
- pando-code stays standalone when disabled (default)

### 4.2 Project Hub — Network Projects Section
- "Network Projects" section below local projects
- Each card: project name, team name, agent count, status
- Click: opens team's `.pando-code.db` as active project

### 4.3 Settings — Network Toggle
- Settings page "Pando Node" section
- On/Off toggle, node URL, connection status

### TEST MILESTONE 4
```
✓ pando-code web UI shows network projects when enabled
✓ Click project → loads team DB → shows agents, board, history
✓ Settings toggle ON/OFF works
✓ Auto-discovery finds team DBs in ~/.pando/teams/
```

---

## Phase 5: Agent Visibility & Cost

### 5.1 Per-Agent Conversation History
- API: `GET /v1/agents/:id/messages?limit=100`
- Web UI: Agent detail "History" tab

### 5.2 Per-Agent Cost Breakdown
- Aggregate cost per agent across sessions from `budget_usage` table
- Web UI: cost badge on agent cards

### 5.3 Model Indicator
- Show model badge on agent cards

### 5.4 Team Hierarchy View
- Team name as header, agents as children
- Click agent: full detail with history/sessions tabs

### TEST MILESTONE 5
```
✓ GET /v1/agents/:id/messages returns conversation history
✓ Per-agent cost calculation works
✓ Team hierarchy visible in web UI
```

---

## Phase 6: Session Persistence & Recovery

### Research Findings (Completed 2026-03-08)

**Where sessions live:**
- Claude Code CLI sessions: `~/.claude/` (filesystem, managed by Claude)
- PandoCode sessions: `.pando-code.db` `sessions` table
- Claude CLI session ID: **closure variable** in `createClaudeCodeModel()` — NOT persisted

**What survives restart:**
- `.pando-code.db`: board_tasks, memories, messages, agent profiles ✓
- Claude CLI session files in `~/.claude/` ✓
- **LOST**: Closure variable linking engine to CLI session → every restart = fresh session

**Cross-node migration:**
- Team metadata synced via GossipSub `pando:teams` topic
- `.pando-code.db` local-only → new node starts fresh
- Acceptable: board + memories provide enough context to continue

### 6.1 Session ID Persistence

**pando-code changes (claude-code.ts):**
1. `createClaudeCodeModel({ initialSessionId? })` — resume previous session
2. `model.getSessionId()` — expose current session ID
3. Validate session before `--resume` (may be cleaned up)

**pando-node changes (engine-adapter.ts):**
1. Save session ID to `state` table after first tick: `claude-cli-session:{agentId}`
2. Read saved session ID in `startTeam()` and pass to engine
3. If `--resume` fails → start fresh, log warning

### 6.2 Graceful Degradation
- Claude Code CLI not available → CRITICAL log, don't start agent
- Team DB corrupted → recreate from template, log what was lost
- Saved session stale → fresh start, log "[team] Session expired"

### 6.3 Recovery Priority
```
1. Board tasks     — always persisted
2. Memories        — always persisted
3. Agent profiles  — always persisted
4. CLI session     — resume if available, fresh if not
5. Conversation    — nice-to-have, not critical
```

### TEST MILESTONE 6
```
✓ Stop node → restart → agents resume previous Claude CLI sessions
✓ Delete ~/.claude/ sessions → agents start fresh without crashing
✓ Cross-node: team orphaned → new node claims → lead starts with board context
```

---

## Phase 7: User-Facing API Gaps

### 7.1 Task Progress Tracking (CRITICAL)
- `GET /v1/teams/:teamId/tasks` — list team tasks with status
- `GET /v1/teams/:teamId/tasks/:taskId` — detailed task with progress history
- Users can submit bugs and track resolution

### 7.2 Team Status Endpoint
- `GET /v1/teams/:teamId/status` — managing node, agent count, health, last active
- Shows which node is running the team

### 7.3 Cost Visibility
- `GET /v1/teams/:teamId/cost` — total Lux spent, per-agent breakdown
- Budget alerts when approaching limits

### 7.4 Team Configuration API
- `PATCH /v1/teams/:teamId/config` — model, tick intervals, active/paused
- Users can tune their team without code changes

### TEST MILESTONE 7
```
✓ Submit bug → GET tasks → see status updates over time
✓ GET /v1/teams/:teamId/status returns real health data
✓ PATCH config changes take effect on running team
```

---

## Phase 8: Future — Gateway Integration

### 8.1 Model Selection per Team
- Users select model from gateway UI
- Options depend on managing node capabilities

### 8.2 Team Creation from Gateway
- Create team, select template, assign to node
- Auto-provision workspace and lead agent

### 8.3 Team Dashboard
- Aggregate team data across all nodes
- Detail delegated to pando-code web UI

---

## BIBLE Updates Needed

### Section 5.10: Team Architecture
- All agents → `claude-code` model
- Correct tick intervals (15m / 60m / 120m)
- Lead-first design: default = 1 lead, council = jumpstarted 3
- Template system overview
- Lead agent's `manage_team` tool
- Lead vs non-lead tick asymmetry

### Section 3.2.10: Network Integration
- Linked workspaces concept
- Auto-discovery mechanism
- Settings toggle

### Section 6: Engine Adapter
- Correct method names: `getTeamBoard()`, `getTeamInbox()`, etc.
- Board snapshot format
- Team inbox key structure: `msg:{agentId}:{uuid}`

---

## Implementation Order

```
PHASE 1 — Foundation Cleanup (NOW):
  1.1  Parameterize prompts                    ← engine-adapter.ts
  1.2  BIBLE.md sync (7 items)                 ← BIBLE.md
  1.3  Legacy cleanup (shared constants, etc.) ← multiple files
  1.4  Universal lead prompt for non-infra     ← engine-adapter.ts
  → TEST MILESTONE 1

PHASE 2 — Template System:
  2.1  Built-in templates (TypeScript)         ← engine-adapter.ts
  2.2  AgentTemplate interface                 ← engine-adapter.ts
  2.3  manage_team tool for leads              ← engine-adapter.ts + pando-code
  2.4  Lead autonomous team management         ← prompt engineering
  → TEST MILESTONE 2

PHASE 3 — Custom Templates:
  3.1  JSON template files                     ← filesystem
  3.2  Lead creates templates                  ← manage_team tool
  3.3  Template CRUD API                       ← core-api.ts
  3.4  User-submitted templates (future)       ← gateway
  → TEST MILESTONE 3

PHASE 4 — PandoCode Web UI:                   ← pando-code repo
  → TEST MILESTONE 4

PHASE 5 — Agent Visibility:                   ← pando-code repo
  → TEST MILESTONE 5

PHASE 6 — Session Persistence:                ← both repos
  → TEST MILESTONE 6

PHASE 7 — User-Facing APIs:                   ← core-api.ts
  → TEST MILESTONE 7

PHASE 8 — Gateway Integration:                ← gateway + node
```
