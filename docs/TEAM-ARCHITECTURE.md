# Team Architecture — Unified Project Management

> **STATUS: IMPLEMENTED** — Core team architecture is live (TeamRegistry, board, agents, templates, HTTP API). See COUNCIL-ROADMAP.md for phase-by-phase details.
> Single source of truth for how teams, projects, boards, and agent management work.
> Revised: 2026-03-08.
> Read this FIRST before touching any team/project/board code.

---

## 1. The One Rule

**Council is just a team.** Not a special system. Same infrastructure manages
a todo app and the Pando network itself. The only differences:
- **pando-infra** starts with 3 agents and goes through governance for code changes
- **user projects** start with 1 agent and deploy directly (no governance)
- Team leads decide how many agents they need. They can grow or shrink.

---

## 2. The Three Running Modes

The team architecture must work in ALL of them.

```
MODE 1: Standalone PandoCode (offline, no pando-node)
  - User runs PandoCode CLI on their laptop
  - Local SQLite (.pando-code.db) for everything
  - Board, agents, sessions, memory — all local
  - No P2P, no sync, no teams, no network
  - This ALREADY WORKS and must NOT break

MODE 2: PandoCode inside pando-node (networked)
  - PandoCode runs as usual (local SQLite for board/sessions)
  - pando-node ADDS: team registry (routing), governance, upgrade, deploy
  - Team registry synced via GossipSub (lightweight metadata only)
  - Board stays LOCAL to managing node (not synced via P2P)
  - Board accessed remotely via P2P request-reply on demand
  - Board backed up to git repo for durability across handoffs

MODE 3: pando-node WITHOUT PandoCode (EC2 secure, lightweight nodes)
  - No local PandoCode, no agents, no team execution
  - Receives team registry via P2P (knows who manages what)
  - Routes requests to the correct managing node
  - EC2 has MongoDB for credentials/marketplace (separate concern)
```

**Critical constraints:**
- NO MongoDB dependency for teams (only EC2 has MongoDB)
- NO board sync via P2P (too much data at scale)
- Team registry is ROUTING METADATA only (~200 bytes per team)

---

## 3. What Gets Stored Where

### Data Separation (critical for scale)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     DATA SEPARATION                                 │
├─────────────────────────────┬───────────────────────────────────────┤
│ LAYER 1: Team Registry      │ LAYER 2: Board + Agent State          │
│ (~/.pando/teams/teams.db)   │ (~/.pando/teams/{teamId}/.pando-code.db)│
│                             │                                       │
│ WHAT: routing metadata      │ WHAT: application state               │
│  - team id, name            │  - board tasks (title, status, progress)│
│  - managing node (peerId)   │  - agent messages (inbox)             │
│  - heartbeat (alive?)       │  - sessions, memory                   │
│  - repos managed            │  - sub-agent state                    │
│  - agent count              │                                       │
│  - governance flag           │ WHERE: managing node ONLY             │
│                             │ ACCESS: P2P request-reply on demand   │
│ WHERE: ALL nodes (synced)   │ BACKUP: .pando/team-state.json in repo│
│ SYNC: GossipSub pando/teams │ SYNC: NONE (local only)              │
│ SIZE: ~200 bytes per team   │ SIZE: unbounded (stays local)         │
│ UPDATES: rare (claim,       │ UPDATES: frequent (every task change) │
│   heartbeat, config change) │                                       │
└─────────────────────────────┴───────────────────────────────────────┘

LAYER 3: Git Repo (.pando/team-state.json)
  - Committed alongside code changes by the managing agent
  - Contains: active tasks, recent completed tasks, team context
  - On handoff: new node reads this from repo to seed board
  - On node death: this is the durable backup (git survives everything)

EXISTING (unchanged):
  ledger.db         — governance proposals, votes, balances (GossipSub synced)
  MongoDB (EC2)     — project marketplace metadata, credentials
  ProjectStore      — project business data (name, owner, deploy URL, budget)
```

### Why NOT sync boards via P2P?

| Scale scenario | Board sync (old plan) | Registry-only (new plan) |
|---|---|---|
| 100 teams, 50 tasks each, updating | 5000+ messages flooding network | Zero board traffic on P2P |
| 100-person team, active sprint | Every status change → every node | Board stays local, on-demand |
| New node joins network | Downloads ALL boards (MB of data) | Downloads registry only (~20KB) |
| EC2 headless node | Stores board data it never uses | Only stores routing metadata |

### Team Registry vs ProjectStore

These are DIFFERENT things. Do NOT merge them.

| | Team Registry (NEW) | ProjectStore (EXISTS) |
|---|---|---|
| Purpose | Who RUNS the agents | Project BUSINESS metadata |
| Data | managingNode, heartbeat, agents | name, owner, budget, deploy URL |
| Storage | SQLite (teams.db) | MongoDB + SQLite cache |
| Sync | GossipSub (all nodes) | P2P storage proxy |
| Scope | Agent management, routing | Marketplace, billing, deployment |

A project can exist in ProjectStore without having a team (archived, deployed but no active work).
A team always corresponds to one or more projects, but team = operational, project = business.

---

## 4. Core Concepts

### Team

A group of PandoCode agents running on one node, managing one or more repos.

```
TeamConfig {
  id: string                     // "pando-infra", "team-a1b2c3"
  displayName: string            // "Pando Infrastructure", "Todo App"
  managingNode: string           // peerId of node running this team
  lastHeartbeat: number          // timestamp ms, updated every tick
  status: "active" | "orphaned"  // orphaned = heartbeat stale + node offline
  repos: string[]                // GitHub repos: ["pando-lux/node", "pando-lux/code"]
  agentCount: number             // how many agents (for display, not full config)
  governanceRequired: boolean    // true = code changes go through governance proposals
  createdAt: number
  createdBy: string              // peerId
  claimedAt: number              // for race condition resolution on handoff
}
```

**What is NOT in the registry:** agent configs, system prompts, board tasks, messages.
Those live locally on the managing node in PandoCode's SQLite.

### Team Size is Dynamic

- **User project (default):** 1 agent (lead/manager). Can grow.
- **Complex user app:** lead + builders + testers (lead decides when to grow)
- **pando-infra:** lead + observer + QA (3 agents, lead can add more)
- A team can manage multiple repos — lead's prompt lists them all

The lead agent decides team composition. Users can also configure via PandoCode UI.
pando-node doesn't care about team internals — it only knows the team exists and who runs it.

### Governance: One Flow, One Gate

Every team uses the SAME flow. The only difference is a single flag:

```
governanceRequired: boolean (per-team, in team config)

  true  → code changes go through governance proposal → vote/auto-approve → upgrade
  false → code changes deploy directly via pando_deploy

Currently:
  - pando-infra: true (ecosystem repos need governance)
  - user projects: false (direct deploy)

Future:
  - The council (pando-infra lead) may decide that complex user projects
    also need governance (e.g., projects with 10+ contributors, or projects
    that other projects depend on)
  - This is just flipping the flag: PATCH /v1/teams/:teamId { governanceRequired: true }
  - No code change needed — the flow is already the same
  - The network/council decides this dynamically, not the architecture
```

The flow is IDENTICAL for all teams. Same board, same agents, same tools,
same handoff. The governance gate is a single `if (team.governanceRequired)`
branch at the moment of deploying a code change. Everything else is shared.

---

## 5. The Flows (end-to-end)

### 5.1 New User Project — "Build me a todo app"

```
1. User → gateway → any pando node
2. Doorman classifies: "build" intent
3. Node calls findBestBuilder():
   - Checks capability registry for PandoCode-capable peers (shareCompute + compute_cpu)
   - Prefers self if capable, else picks best remote peer
4. Builder node (self or remote):
   a. Creates project in ProjectStore (business metadata)
   b. Creates team in team registry:
      { id: "team-xxx", repos: [], agentCount: 1, managingNode: self,
        governanceRequired: false }
   c. Broadcasts team_config_update via GossipSub → all nodes learn routing
   d. Spawns PandoCode engine for the lead agent
   e. Lead receives the build request, creates code, triggers deploy
5. Team stays active for future updates (lead handles subsequent requests)
```

### 5.2 Update Existing Project — "Add dark mode to my todo app"

```
1. User → gateway → any pando node
2. Node checks team registry: which team manages this project?
   - Found: team "team-xxx", managingNode = <peerId>
3. Is managingNode online?
   a. Check P2P peer list + lastHeartbeat (< 20 min stale)
   b. YES → P2P request-reply to managing node with the user message
   c. NO → claim the team (see Section 5.6 Handoff)
4. Managing node receives request:
   a. Add task to local board (PandoCode's SQLite)
   b. Lead reads board on next tick (or triggered immediately)
   c. Lead spawns builder if needed
   d. Builder makes changes, commits, pushes
   e. Deploy pipeline triggers (direct, no governance)
   f. Lead marks task done
```

### 5.3 Pando Infrastructure — Bug Report

```
1. User → gateway: "The wallet page shows wrong balance"
2. Any node receives → doorman classifies: "report" intent
3. Node checks team registry: team "pando-infra" manages pando-lux/node
   - managingNode = <peerId>
   - Route to managing node (or handle locally if self)
4. Managing node adds task to local board:
   { title: "[BUG:user] Wallet shows wrong balance" }
5. Lead agent reads board (15min tick or triggered):
   a. Reads task, decides it's a code fix
   b. Calls pando_workspace({ repo: "pando-lux/node" }) → local clone
   c. Spawns builder sub-agent in that workspace
   d. Builder: read code → write fix → npm run build → commit → push
   e. Lead: curl POST /v1/governance/propose (governance required for infra)
6. Governance auto-approves (<=8 peers) — 6-layer security pipeline
7. All nodes: pullAndUpgrade → build → safe restart (exit 75)
8. Lead marks task done
```

### 5.4 Team Bootstrap (First Run)

```
Node starts with PandoCode available:

  1. Initialize TeamRegistry (teams.db)
  2. Sync from peers (GossipSub catch-up)
  3. Check: does team "pando-infra" exist in registry?

     NO (first node ever, or no peers yet):
       Create with seed config:
         id: "pando-infra"
         displayName: "Pando Infrastructure"
         repos: ["pando-lux/node", "pando-lux/code"]
         agentCount: 3
         governanceRequired: true
         managingNode: self
       Broadcast team_config_update → peers learn about this team
       Spawn team locally (see step 4)

     YES, but managingNode is offline (stale heartbeat + not in peer list):
       Claim it (see Section 5.6)

     YES, and managingNode is online:
       Do nothing — someone else runs it

  4. For each team where managingNode == self:
     a. Create PandoCode workspace: ~/.pando/teams/{teamId}/
     b. If repo has .pando/team-state.json → read it, seed local board
     c. Create PandoCode engines per agent config (stored locally, not in registry)
     d. Register pando_* tools on each engine
     e. Register scheduler ticks per agent's tickIntervalMs
     f. Start heartbeat (update registry + broadcast every tick)
```

### 5.5 Team Lead Grows the Team

```
Team lead decides it needs more agents (e.g., backlog > 10 tasks):

1. Lead calls spawn_agent({ role: "builder", task: "..." })
   → PandoCode handles this natively (sub-agent in same workspace)
   → This is a TEMPORARY builder — lives for one task, then dies

2. If lead wants a PERMANENT team member:
   a. Lead calls manage_tasks to create a team config update
   b. EngineAdapter intercepts → updates agentCount in team registry
   c. Broadcasts team_config_update (other nodes see updated count)
   d. New permanent agent gets its own engine + scheduler tick

3. Team lead can also REMOVE agents:
   a. Kill the engine, unregister the tick
   b. Update agentCount in registry, broadcast

Note: Sub-agents (temporary builders) do NOT update the registry.
Only permanent team members (with their own ticks) are counted.
```

### 5.6 Node Death + Handoff

```
Node A was running team "pando-infra". Node A goes offline.

DETECTION (three paths, any can trigger):

  Path A — New request arrives:
    1. Any node receives request for pando-infra
    2. Checks registry: managingNode = A
    3. Checks P2P peers: A not connected
    4. Checks lastHeartbeat: stale (> 20 minutes)
    5. This node has PandoCode → claim the team

  Path B — Periodic orphan scan (every 5 min on PandoCode nodes):
    1. Scan registry: find teams where lastHeartbeat > 20min stale
    2. Verify managingNode not in P2P peer list
    3. Claim first orphaned team found

  Path C — P2P peer disconnect event:
    1. Node B detects Node A disconnected
    2. Queries registry: was A managing any teams?
    3. Wait 5 minutes (node might reconnect)
    4. If still offline and B has PandoCode → claim them

CLAIMING:
  1. Atomic update in local registry: managingNode = self, claimedAt = now
  2. Broadcast team_config_update with new managingNode
  3. Race condition: if two nodes claim simultaneously:
     - Compare claimedAt timestamps in broadcast
     - LATEST claimedAt wins (most recent claim)
     - Loser sees the broadcast, backs off, shuts down its copy
  4. Spawn team per Section 5.4 step 4

BOARD RECOVERY (three sources, in priority order):
  1. P2P request-reply to peers: "give me board for team X"
     → Peers that previously queried this board may have cached it
     → Best effort, may return nothing
  2. Git repo: clone/pull repo → read .pando/team-state.json
     → Contains active tasks and recent history
     → Always available (git is the durable store)
  3. Fresh start: empty board, lead reads repo state to understand context
     → Commit history, open issues, recent changes give enough context
     → Acceptable fallback — board is a convenience, git is truth

SESSION CONTINUITY:
  - PandoCode sessions (Claude Code --resume) are per-node, NOT transferred
  - New node starts fresh session — board + repo state give full context
  - This is acceptable: board IS the persistent memory, sessions are ephemeral
```

### 5.7 Board Access from Non-Managing Node

```
Gateway user wants to see the board for a project:

1. Gateway → any pando node: GET /v1/teams/:teamId/board
2. Node checks registry: managingNode = <peerId>
3. Is managingNode == self?
   YES → read local PandoCode SQLite, return board tasks
   NO → P2P request-reply to managing node:
        { action: "team_board", teamId: "pando-infra" }
        → Managing node reads its local board, responds with tasks
4. If managing node is offline:
   → Return { tasks: [], status: "team_orphaned", message: "Managing node offline" }
   → Gateway shows "team transferring..." status
```

### 5.8 Standalone PandoCode (no pando-node)

```
Nothing changes. PandoCode works exactly as it does today:
  - Local SQLite for board, sessions, agents, memory
  - No P2P, no team sync, no teams.db
  - User manages their project locally
  - spawn_agent, check_agents, send_message all work locally
  - Board tasks are local only

If user later connects to pando-node:
  - Their local project can optionally be "registered" as a team
  - pando-node creates team entry in registry
  - Other nodes can now route requests to this project
  - This is an UPGRADE path, not a requirement
```

---

## 6. Scope Boundary

### pando-code (brain) — NO CHANGES NEEDED

```
What it does:
  - Agent lifecycle: spawn, kill, configure
  - Board: task CRUD in local SQLite (.pando-code.db)
  - Messaging: send_message, check_agents (local, cross-engine if shared DB)
  - Sessions + memory: per-agent persistence
  - Tools: spawn_agent, check_agents, send_message, manage_tasks

What it does NOT know about:
  - P2P, network, peers, team registry
  - GossipSub, team sync, handoff
  - MongoDB, governance, upgrades

PandoCode is a standalone product. pando-node adds network capabilities on top.
```

### pando-node (body) — Changes

```
NEW file: core/team-registry.ts
  - SQLite DB: ~/.pando/teams/teams.db
  - ONE table: team_config (routing metadata only)
  - GossipSub subscribe/publish on "pando/teams" topic
  - Catch-up sync on peer connect (same as LedgerSync pattern)
  - Heartbeat broadcasting
  - Orphan detection + claiming
  - P2P request-reply handler for remote board access

CHANGES to: core/engine-adapter.ts
  - Generic startTeam(teamId) replaces startCouncilAgents()
  - Team agent configs stored locally (not in registry)
  - Board write happens in PandoCode's native SQLite (no interceptor needed)
  - Periodic .pando/team-state.json backup to git (on task completion)
  - Per-agent tick registration based on config
  - Heartbeat: update team-registry on every tick

CHANGES to: api/ endpoints
  - New /v1/teams/* endpoints replace /v1/council/*
  - Board endpoints: proxy to managing node via P2P if remote
  - Request routing: check team-registry → route to managing node

CHANGES to: init-platform.ts
  - Initialize team-registry on startup
  - Auto-bootstrap pando-infra if unclaimed
  - Wire peer disconnect → orphan check

NO CHANGES to: kernel/ layer
  - Governance stays as-is (proposals, voting, auto-approve)
  - Upgrade protocol stays as-is (git pull, hash verify, build, restart)
  - Network stays as-is (GossipSub, peer management)

NO CHANGES to: platform/project-store.ts
  - ProjectStore keeps handling business metadata (marketplace, billing)
  - Teams and projects are different layers (see Section 3)
```

---

## 7. SQLite Schema (teams.db)

Intentionally minimal. This is ROUTING METADATA only.

```sql
CREATE TABLE team_config (
  id TEXT PRIMARY KEY,              -- "pando-infra", "team-a1b2c3"
  display_name TEXT NOT NULL,
  managing_node TEXT,               -- peerId of node running this team
  last_heartbeat INTEGER,           -- timestamp ms
  status TEXT DEFAULT 'active',     -- active | orphaned
  repos TEXT NOT NULL DEFAULT '[]', -- JSON array: ["pando-lux/node"]
  agent_count INTEGER DEFAULT 1,    -- number of active agents
  governance_required INTEGER DEFAULT 0, -- 1 = code changes go through governance
  created_at INTEGER NOT NULL,
  created_by TEXT,                  -- peerId that created the team
  claimed_at INTEGER                -- for race condition resolution
);

CREATE INDEX idx_config_status ON team_config(status);
CREATE INDEX idx_config_managing ON team_config(managing_node);
```

**No board tables. No message tables.** Board and messages live in PandoCode's
local SQLite on the managing node. This is the key architectural decision
that prevents P2P data flooding at scale.

---

## 8. P2P Sync Protocol

### GossipSub Topic: `pando/teams`

```
Messages (all are PandoMessage envelopes):

  team_config_update:
    - When: team created, claimed, heartbeat, config changed
    - Payload: full TeamConfig object
    - All nodes update their local teams.db
    - Dedup: skip if from self, skip if claimedAt <= local claimedAt

  team_sync_request:
    - When: new peer connects (5s delay, like LedgerSync)
    - Payload: { since: timestamp }
    - Recipient responds with team_sync_response

  team_sync_response:
    - Payload: { teams: TeamConfig[] }
    - All teams updated since the requested timestamp
    - Receiver merges into local teams.db (latest claimedAt wins)
```

### Sync Pattern (mirrors LedgerSync exactly)

```
start():
  1. subscribeTopic("pando/teams", handleTeamMessage)
  2. network.onPeerConnect(peerId => {
       setTimeout(() => requestSync(peerId), 5000);   // after mesh forms
       setTimeout(() => requestSync(peerId), 30000);  // retry
     });

handleTeamMessage(msg):
  if msg.type == "team_config_update":
    mergeTeamConfig(msg.payload)  // latest claimedAt wins
  if msg.type == "team_sync_request":
    respondWithTeams(msg.from, msg.payload.since)
  if msg.type == "team_sync_response":
    for team in msg.payload.teams:
      mergeTeamConfig(team)

Heartbeat (piggyback on team tick):
  Every time a team agent tick fires:
    updateHeartbeat(teamId)  // updates last_heartbeat in local DB
    publishToTopic("pando/teams", { type: "team_config_update", payload: teamConfig })
```

### P2P Request-Reply for Board Access

```
handler: "pando/team-board"

  request:  { teamId: string, action: "get_board" | "add_task" | "update_task", ... }
  response: { tasks: BoardTask[] } | { taskId: string } | { ok: boolean }

Registered in RequestReplyManager alongside existing handlers
(pando/deploy-app, pando/doorman-classify, etc.)
```

---

## 9. API Endpoints

```
GET  /v1/teams                        — List all teams (from local registry)
GET  /v1/teams/:teamId                — Team config + status
GET  /v1/teams/:teamId/board          — Board tasks (local or P2P proxy to managing node)
POST /v1/teams/:teamId/board          — Add task (local or P2P proxy)
PATCH /v1/teams/:teamId/board/:taskId — Update task (local or P2P proxy)
POST /v1/teams/:teamId/trigger        — Trigger team lead immediately
POST /v1/teams/:teamId/request        — Submit user request (adds to board, may trigger)
PATCH /v1/teams/:teamId               — Update team config (agent count, repos)
POST /v1/teams                        — Create a new team
DELETE /v1/teams/:teamId              — Stop team, mark orphaned
```

All board endpoints follow the same pattern:
1. Check registry: is managing node == self?
2. YES → operate on local PandoCode SQLite
3. NO → P2P request-reply to managing node

---

## 10. Git-Based Board Backup (.pando/team-state.json)

When the managing agent completes a task or makes a commit, it also writes
a lightweight state file to the repo:

```json
{
  "teamId": "pando-infra",
  "updatedAt": "2026-03-08T15:30:00Z",
  "managingNode": "12D3KooW...",
  "activeTasks": [
    {
      "id": "task-1741400000-ab1",
      "title": "[BUG:user] wallet balance wrong",
      "status": "in_progress",
      "assignedAgent": "builder-1"
    }
  ],
  "recentlyCompleted": [
    {
      "id": "task-1741390000-cd2",
      "title": "[BUG:user] login page crash",
      "status": "done",
      "resolution": "Fixed in commit abc123"
    }
  ]
}
```

**When written:** After each task completion, during the same git commit.
**Where:** `.pando/team-state.json` in the repo root.
**On handoff:** New node clones/pulls repo → reads this file → seeds local board.
**Size:** Always small. Only active + last 10 completed tasks. Not a full history.

---

## 11. Seed Configs

### pando-infra (auto-created on first PandoCode node)

```javascript
// Registry entry (synced to all nodes)
{
  id: 'pando-infra',
  displayName: 'Pando Infrastructure',
  managingNode: selfPeerId,
  lastHeartbeat: Date.now(),
  status: 'active',
  repos: ['pando-lux/node', 'pando-lux/code'],
  agentCount: 3,
  governanceRequired: true,
  createdAt: Date.now(),
  createdBy: selfPeerId,
  claimedAt: Date.now(),
}

// Agent config (stored locally on managing node, NOT in registry)
const PANDO_INFRA_AGENTS = [
  {
    id: 'lead',
    role: 'lead',
    model: 'claude-code',
    systemPrompt: LEAD_PROMPT,
    tickIntervalMs: 15 * 60 * 1000,  // 15 min
  },
  {
    id: 'observer',
    role: 'explorer',
    model: 'gemini-2.5-flash',
    systemPrompt: OBSERVER_PROMPT,
    tickIntervalMs: 30 * 60 * 1000,  // 30 min
  },
  {
    id: 'qa',
    role: 'tester',
    model: 'gemini-2.5-flash',
    systemPrompt: QA_PROMPT,
    tickIntervalMs: 30 * 60 * 1000,  // 30 min
  },
];
```

### User project (created on "build" intent)

```javascript
// Registry entry
{
  id: 'team-' + randomId,
  displayName: projectName,
  managingNode: selfPeerId,
  lastHeartbeat: Date.now(),
  status: 'active',
  repos: [],  // populated after repo creation
  agentCount: 1,
  governanceRequired: false,
  createdAt: Date.now(),
  createdBy: selfPeerId,
  claimedAt: Date.now(),
}

// Agent config (stored locally)
// Just one lead agent. It can spawn temporary builders via spawn_agent.
// If it decides it needs permanent team members, it updates the config.
```

---

## 12. Code Changes

### NEW files

```
core/team-registry.ts
  - TeamRegistry class
  - SQLite teams.db (one table: team_config)
  - GossipSub sync (subscribe, publish, peer connect catch-up)
  - Heartbeat update + broadcast
  - Orphan detection (5 min scan)
  - Claiming (atomic update + broadcast + race resolution)
  - P2P request-reply handler for remote board access
  - CRUD: createTeam, getTeam, listTeams, updateTeam, claimTeam
```

### MODIFY files

```
core/engine-adapter.ts:
  DELETE: COUNCIL_AGENTS, startCouncilAgents(), isCouncilActive(),
          ensureCouncilStarted(), councilStarting,
          triggerCouncilBackground(), sendToCouncilAgent(),
          getCouncilBoard(), getCouncilInbox(), sendCouncilMessage(),
          councilDbPath, council scheduler ticks
  ADD:    startTeam(teamId, agentConfigs[])
          stopTeam(teamId)
          triggerTeam(teamId)
          sendToTeamAgent(teamId, agentId, message)
          getTeamBoard(teamId) — reads local PandoCode SQLite
          addTeamBoardTask(teamId, title, description)
          backupTeamState(teamId) — writes .pando/team-state.json
  KEEP:   getBoardTasks(), insertBoardTask(), getBoardSnapshot()
          (rename from council-specific to generic, reuse for any team)
          All Pando tools, Lux budget, API key injection, reviewDiff

core/index.ts:
  DELETE: export of council-prompts
  ADD:    export of TeamRegistry

api/core-api.ts:
  DELETE: all /v1/council/* endpoints
  ADD:    all /v1/teams/* endpoints (Section 9)
          Board proxy: check registry → local or P2P request-reply

init-platform.ts:
  ADD:    Initialize TeamRegistry
          Wire peer connect → team sync catch-up
          Wire peer disconnect → orphan check (5 min delay)
          Auto-bootstrap pando-infra if unclaimed
          Start teams where managingNode == self

index.ts (PandoNode class):
  DELETE: setCouncilEnabled(), config.enableCouncil
  ADD:    getTeamRegistry(): TeamRegistry
          Team bootstrap in startEngine() flow

cli.ts:
  DELETE: --council / --no-council flags
          detectClaudeCode() for council-specific logic
          enableCouncil wiring
  KEEP:   detectClaudeCode() for scheduler auto-detection (still useful)
```

### DELETE files

```
core/council-prompts.ts — prompts move to seed config in engine-adapter.ts
```

---

## 13. Implementation Phases

### Phase 1: TeamRegistry (foundation)
- New file: `core/team-registry.ts`
- SQLite DB with team_config table
- CRUD operations
- GossipSub subscribe/publish on `pando/teams`
- Peer connect catch-up sync
- Heartbeat + orphan detection
- Claiming with race condition handling
- P2P request-reply handler for board proxy

### Phase 2: EngineAdapter refactor (generic teams)
- `startTeam(teamId, agentConfigs[])` — creates engines per config
- Agent tool re-registration (same pattern as current startCouncilAgents)
- Per-agent tick registration from config
- Heartbeat wiring: tick → registry update → broadcast
- Board backup: task completion → .pando/team-state.json in repo
- Delete all council-specific methods

### Phase 3: API endpoints
- New `/v1/teams/*` endpoints
- Board proxy (local or P2P request-reply)
- Doorman integration: "report" → find team by repo → add to board
- "build" intent → create team + project (linked)

### Phase 4: Bootstrap + handoff
- init-platform.ts: team registry init, pando-infra bootstrap
- Peer disconnect → delayed orphan check
- Request routing when managing node offline → claim + process
- Handoff board recovery from .pando/team-state.json

### Phase 5: Delete legacy
- Remove council-prompts.ts
- Remove all /v1/council/* endpoints
- Remove enableCouncil config, CLI flags
- Update BIBLE.md, CLAUDE.md, HUMAN-LEVEL-TESTING.md

### Phase 6: E2E verification
- Full autonomous loop: request → team processes → fix → governance → upgrade
- Node death → handoff → team resumes with board from git
- Second request → board shows history
- Standalone PandoCode regression test

---

## 14. Edge Cases + Gotchas

### Race condition on claiming
Two PandoCode nodes both detect an orphaned team and try to claim it.
Resolution: compare `claimedAt` timestamps in the broadcast. Latest wins.
Loser receives the broadcast, backs off, shuts down its copy.

### Split brain (network partition)
Two nodes both think they manage the same team.
Resolution: when they reconnect and sync, compare `claimedAt`.
Newer claim wins. Losing node stops its team gracefully.
Acceptable data loss: losing node's recent board changes may be lost.

### In-progress tasks during handoff
Builder was mid-fix when node died. Task is "in_progress" in team-state.json.
Resolution: new lead sees in_progress tasks with no recent updates.
Checks repo (commit history shows partial work). Re-spawns builder.

### Team with no PandoCode nodes available
All PandoCode nodes go down. Team is "orphaned" everywhere.
Requests return: "No PandoCode nodes available — try later."
When a PandoCode node comes back, orphan scan claims the team.

### Board access when managing node is temporarily offline
P2P request-reply times out after 10s.
API returns cached team config (from registry) but empty board.
Gateway shows "Team temporarily unavailable."

### Large number of teams
100+ teams × 200 bytes each = ~20KB in registry. Negligible.
Heartbeats: if each team heartbeats every 15 min, 100 teams = ~7 messages/min.
GossipSub handles this easily (governance already does more).

### Team-state.json conflicts in git
Two commits from different agents could conflict on this file.
Resolution: .pando/team-state.json is always OVERWRITTEN (not merged).
Latest commit wins. The file is a snapshot, not append-only.

### Standalone PandoCode regression
Must not break. PandoCode has zero knowledge of teams.
pando-node only ADDS the team layer when present.
If EngineAdapter is not started, PandoCode works normally.

### detectClaudeCode() still needed
Even without council flags, we need to know if PandoCode is available
to determine if this node CAN run teams. detectClaudeCode() stays
but is used for team capability, not council-specific logic.

---

## 15. What This Replaces

| Old (legacy council) | New (team architecture) |
|---|---|
| COUNCIL_AGENTS hardcoded array | Agent config per team (stored locally) |
| startCouncilAgents() | startTeam(teamId) — generic |
| /v1/council/* endpoints | /v1/teams/:teamId/* endpoints |
| council-prompts.ts | Prompts in seed config (engine-adapter.ts) |
| enableCouncil CLI flag | Auto-bootstrap from team registry |
| Council-only board in shared SQLite | Per-team board in PandoCode's local SQLite |
| Board tasks synced via P2P (old plan) | Board stays local, git backup for durability |
| No cross-node routing | P2P request-reply for remote board access |
| No handoff on node death | Orphan detection + auto-claim + board recovery |
| Special-case council code | Generic team code — council is team "pando-infra" |

---

## 16. Security at Scale

### 16.1 Heartbeat Batching

One heartbeat per NODE per interval, not per team. Prevents N×N message explosion.

```javascript
// Every 15 min, managing node publishes ONE message:
{
  type: "team_heartbeat",
  from: "12D3KooW...",   // signed, verified
  payload: {
    teams: ["pando-infra", "team-abc", "team-def"],  // all teams this node manages
    timestamp: 1741400000000
  }
}

// Scale math:
// 100 nodes × 1 heartbeat / 15 min = ~0.11 messages/second
// Each message ~300 bytes
// Total: ~33 bytes/second on GossipSub mesh — negligible
```

### 16.2 Message Validation Rules

Every incoming `team_config_update` and `team_heartbeat` must be validated:

```
RULE 1: Heartbeat must come from managing_node
  if msg.from !== team.managing_node → REJECT
  (prevents fake heartbeats keeping orphaned teams "alive")

RULE 2: Config update must come from managing_node OR be a valid claim
  if msg.from === team.managing_node → ACCEPT (normal update)
  if msg.from !== team.managing_node:
    if team.last_heartbeat is stale (> 20 min) → ACCEPT (valid claim)
    else → REJECT (hostile takeover attempt)

RULE 3: New team creation from any PandoCode-capable node → ACCEPT
  (rate limited by Lux cost, see 16.3)

RULE 4: All messages are Ed25519 signed (existing network.publishToTopic)
  Unsigned messages → REJECT (existing protection in network.ts:951-958)
```

### 16.3 Team Creation Cost (Spam Prevention)

```
Team creation costs 1 Lux (deducted from creator's balance)
  - Prevents spam: flooding 10,000 fake teams costs 10,000 Lux
  - Daily emission cap is 500 Lux/node — natural rate limiter
  - Team deletion refunds the 1 Lux
  - pando-infra seed creation: free (bootstrap exception)
  - Free tier: first team free if balance < 100 Lux (same as governance)
```

### 16.4 Board Access Authorization

```
Board request via P2P request-reply:
  - Public teams (visibility: 'listed' or 'public'): anyone can read board
  - Private teams (visibility: 'owner_only'): only owner peerId
  - Collaborator access: owner + collaborators peerIds
  - Request includes msg.from (Ed25519 signed peerId) → verify against allowed list
  - Managing node checks before responding

Note: This mirrors ProjectStore's existing visibility model.
```

### 16.5 Governance Protection (Hardcoded, Not Per-Team)

```
The governanceRequired flag on team config is ADVISORY.
The REAL protection is in upgrade-protocol.ts:

  - upgrade-protocol only pulls from repos listed in governance-approved proposals
  - validateUpgradeProposal() runs 4 deterministic security checks
  - commit hash must match governance-approved hash (STRICT verification)
  - Even if a malicious team sets governanceRequired: false and pushes to pando-lux/node,
    other nodes will NOT upgrade because there's no approved governance proposal
  - The governance pipeline is the security gate, not the team flag

The team flag just tells the LEAD AGENT whether to call pando_governance_propose
or pando_deploy. It's a workflow hint, not a security boundary.
```

### 16.6 Scale Limits

```
Team registry:
  10,000 teams × 200 bytes = 2 MB in SQLite — negligible
  Peer connect sync: 2 MB one-time download — < 2 seconds
  Heartbeats: 100 nodes × 1 msg/15 min = 0.11 msg/sec — negligible

Board access:
  Point-to-point (P2P request-reply), NOT broadcast
  Latency: 100-500ms depending on network
  Payload: 50 tasks × 200 bytes = 10 KB per request

LLM compute (the REAL bottleneck):
  One node with 10 teams × 3 agents × 1 tick/15 min = 120 LLM calls/hour
  This is expensive and slow — natural load balancing across nodes
  findBestBuilder() already distributes to least-loaded PandoCode nodes
  Lux economy caps daily compute (500 Lux ≈ 50 tasks)
```

---

## 17. Legacy Code Audit (Complete Line-by-Line)

### Files to DELETE

```
core/council-prompts.ts (93 lines)
  - ENTIRE FILE — exports OBSERVER_PROMPT, QA_PROMPT, COUNCIL_PROMPT
  - Prompts move to seed config constants in engine-adapter.ts
```

### engine-adapter.ts — DELETE these sections (~250 lines)

```
Line 23:    import { OBSERVER_PROMPT, QA_PROMPT, COUNCIL_PROMPT }  → DELETE
Lines 290-296: COUNCIL_AGENTS const array                          → DELETE
Line 312:   enableCouncil?: boolean in AdapterConfig               → DELETE
Line 329:   private councilDbPath: string | null = null             → DELETE
Lines 403-406: if (config.enableCouncil) startCouncilAgents()      → DELETE
Lines 529-532: getCouncilBoard()                                   → DELETE
Lines 552-584: getCouncilInbox()                                   → DELETE
Lines 590-607: sendCouncilMessage()                                → DELETE
Lines 612-629: updateBoardTask() [council-specific version]         → REFACTOR to generic
Lines 635-650: triggerCouncilBackground()                           → DELETE
Line 816:   clearInterval(this._councilInterval)                   → DELETE
Lines 837-1003: startCouncilAgents() [170 lines]                   → DELETE ENTIRE METHOD
Lines 1010-1041: sendToCouncilAgent()                              → DELETE
Lines 1043-1047: isCouncilActive()                                 → DELETE
Line 1054:  private councilStarting = false                        → DELETE
Lines 1055-1078: ensureCouncilStarted()                            → DELETE

KEEP (refactor to generic):
  Lines 547-549: addBoardTask()         → becomes addTeamBoardTask(teamId, ...)
  Lines 678-693: getBoardTasks()        → stays generic (reads any PandoCode SQLite)
  Lines 696-738: insertBoardTask()      → stays generic
  Lines 781-812: getBoardSnapshot()     → stays generic
  Lines 745-775: ensureProjectTick()    → merged into startTeam() tick registration
```

### core-api.ts — DELETE all /council/* routes

```
Lines 444-457:  GET  /council/status           → REPLACED by GET  /v1/teams/:id
Lines 459-515:  POST /council/trigger/:agent   → REPLACED by POST /v1/teams/:id/trigger
Lines 520-524:  GET  /council/board            → REPLACED by GET  /v1/teams/:id/board
Lines 527-562:  POST /council/request          → REPLACED by POST /v1/teams/:id/request
Lines 567-572:  GET  /council/inbox/:agentId   → DELETE (inbox is local to PandoCode)
Lines 575-587:  POST /council/message          → DELETE (messaging is local to PandoCode)
Lines 590-601:  POST /council/tasks            → REPLACED by POST /v1/teams/:id/board
Lines 604-614:  PATCH /council/tasks/:taskId   → REPLACED by PATCH /v1/teams/:id/board/:taskId
```

### index.ts (PandoNode class)

```
Lines 644-647: setCouncilEnabled() method         → DELETE
Line 972:      enableCouncil: config.enableCouncil → DELETE from engine start config
```

### cli.ts

```
Lines 364-371: --council / --no-council flag parsing → DELETE
               node.setCouncilEnabled(true) call    → DELETE
KEEP: detectClaudeCode() function — used for scheduler + team capability detection
```

### core/index.ts

```
Lines 15-16: export { OBSERVER_PROMPT, QA_PROMPT, COUNCIL_PROMPT } → DELETE
```

### api-server.ts (doorman refactoring)

```
Line 102:    Rate limit for 'POST /council/request'        → DELETE
Line 299:    Auth bypass for /council/ routes               → DELETE
Lines 550+:  targetProject: 'council' in doorman classify   → REFACTOR to team routing
Lines 609-618: Doorman prompt references to "council"       → UPDATE prompt
Lines 644,679: Fallback classification to 'council'         → REFACTOR
```

### platform-api.ts

```
Lines 203-214: Chat route "report" → addBoardTask() for council  → REFACTOR to team routing
Line 3972:     Comment "Phase 50: Council Endpoints"              → UPDATE
Line ~4001:    POST /council/veto/:id                             → KEEP (governance, not council agents)
```

### Other files (comments only)

```
init-platform.ts lines 890,895: Council comments           → REMOVE
network-state.ts lines 5-6,104-108: council/ path refs     → REFACTOR path to teams/
```

---

## 18. E2E Test Plan

### Test A: Council as Team — Full Autonomous Loop

**What:** Submit a request to the network. Council (pando-infra team) spawns
on-demand, clones repos, makes a change, pushes, governance approves,
all 3 nodes upgrade. Second request proves persistent session.

**Prerequisites:**
- 3-node network: Windows (local) + EC2-1 (54.82.241.132) + EC2-2 (34.201.82.126)
- All 3 nodes connected (2+ peers each)
- Public gateway: https://gateway-one-mu.vercel.app
- Windows node has PandoCode available (claude CLI on PATH)
- Council/team is NOT running (simulating fresh Electron install)

**Phase 1: Verify Baseline**
```
1. Windows node running WITHOUT council (no --council flag)
2. GET /v1/status on all 3 nodes — verify connected, same commit
3. GET /v1/council/board → { error: 'Council not running' } or empty
4. Record git HEAD on all 3 nodes
```

**Phase 2: Submit Request — Team Spawns On-Demand**
```
1. POST /v1/council/request:
   { "message": "Add a comment to cli.ts: // Team E2E test marker — {timestamp}" }
2. Node detects: council not running, PandoCode IS available
3. ensureCouncilStarted() triggers → council agents spawn
4. Task appears on board: GET /v1/council/board shows the task
5. Council lead activates, reads board
```

**Phase 3: Council Makes the Change**
```
1. Council calls pando_workspace({ repo: "pando-lux/node" }) → local clone or pull
2. Council spawns builder sub-agent with working_directory = workspace
3. Builder:
   a. Reads packages/node/src/cli.ts
   b. Adds the comment line
   c. Runs npm run build — must pass
   d. git add + git commit -m "fix: Team E2E test marker"
   e. git push origin master
4. Council gets commit hash: git rev-parse HEAD
5. Council proposes governance:
   curl POST http://127.0.0.1:4000/v1/governance/propose
   { title: "[Upgrade] fix: Team E2E test marker", commitHash: "<hash>" }
6. Council marks board task as done
```

**Phase 4: All Nodes Auto-Upgrade**
```
1. Governance auto-approves (<=8 peers)
2. Windows node: pullAndUpgrade → detects proposer → safe restart (exit 75)
3. EC2 nodes: receive upgrade via GossipSub OR catchup timer (5 min)
   - git fetch origin master
   - Hash verification passes
   - git reset --hard origin/master
   - npm install + npm run build
   - Safe restart
4. Verify all 3 nodes at new commit:
   - GET /v1/status on each → check commitHash
```

**Phase 5: Second Request — Persistent Session**
```
1. Wait for Windows node to restart
2. Submit SECOND request:
   POST /v1/council/request:
   { "message": "Add another comment: // Persistent session proof — {timestamp}" }
3. Council should still be active (persistent session from Phase 2)
4. Council processes new task — board shows both tasks
5. Second commit + governance + all 3 nodes upgrade again
```

**Phase 6: Verify Final State**
```
1. GET /v1/council/board — both tasks visible (done)
2. GET /v1/governance/proposals — both upgrade proposals passed
3. cli.ts on all nodes — both comment markers present
4. All 3 nodes connected, same commit
```

### Test B: User Project — Build + Deploy + Update

**What:** User requests a project build via gateway. Team created with 1 agent.
Agent builds, deploys. User requests an update. Same team handles it.

**Phase 1: Build Request**
```
1. POST gateway chat: "Build me a simple landing page for a coffee shop"
2. Doorman classifies: intent "build", tier 1
3. findBestBuilder() → picks PandoCode-capable node (Windows)
4. Project created in ProjectStore
5. Team created in registry (1 agent, governanceRequired: false)
6. Agent builds the page, creates GitHub repo
7. Deploy pipeline: push to GitHub → EC2 clones → S3 upload
8. Verify: deployment URL accessible, page loads
```

**Phase 2: Update Request**
```
1. POST gateway chat (same thread): "Add a dark mode toggle"
2. Node finds existing team for this project
3. Routes to managing node
4. Agent reads board, makes the change, redeploys
5. Verify: dark mode toggle visible on deployed page
```

### Test C: Node Death + Handoff (Future — requires 2 PandoCode nodes)

**What:** PandoCode node managing a team goes offline. Another PandoCode node
detects orphaned team, claims it, resumes from board + git state.

(This test requires 2 PandoCode-capable nodes. Currently only Windows has
PandoCode. Defer until second PandoCode node is available.)
