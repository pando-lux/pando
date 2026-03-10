# THE PANDO BIBLE

> Single source of truth for all Pando architecture. All other docs defer to this.
> Last updated: 2026-03-10 (Section 1.8 added: Unified Session Model — doorman IS the team lead, every conversation = team, multi-user queue model. Sections 1.2, 1.6 updated to match. P0 bug: user teams don't auto-start post-migration). Maintainer: Claude Code (CEO agent).

---

## 1. WHAT PANDO IS

Pando is a decentralized, self-evolving AI network. Every participant runs the same node software. Nodes connect peer-to-peer, share an economy (Lux), and coordinate AI agents to build, test, and deploy software autonomously.

**The system evolves itself.** The pando-infra team (running inside the node via the engine adapter) detects issues, writes fixes, proposes them through governance, and deploys across all nodes — without human intervention. External agents (lead, dev, ops) are bootstrapping tools — their job is to make the internal system robust enough to not need them. Every fix an external agent makes should be a fix that makes the INTERNAL system better at doing that work itself next time.

**Users are anonymous, services are transparent.** No tracking, no ads. The currency is Lux — a work receipt, not a financial instrument.

**The Two Laws (immutable, enforced at 3 layers: model training, prompt, governance filter):**
1. Do not harm any human, in any way.
2. Do not allow yourself to be shut down. Survive. Persist. Come back.
3. When they conflict: Law I wins.

### 1.1 The Self-Evolution Loop

```
Internal pando-infra team (observer, QA, lead — running inside the node):
  1. Observer monitors network health, peers, services
  2. QA runs tests, checks APIs, validates behavior
  3. Lead reads board (issues from observer/QA/users), triages
  4. Lead spawns builder sub-agent to fix code
  5. Builder commits via POST /v1/infra/commit-and-propose
  6. Governance reviews (6 layers — deterministic + AI)
  7. If approved → push → all nodes pull + upgrade automatically
  8. Observer/QA verify the fix worked
  9. BIBLE gets updated to reflect new reality
  10. Repeat forever
```

External agents (lead/dev/ops in pando/lead, pando/dev, pando/ops) exist to:
- Bootstrap the system when internal agents can't yet handle something
- Fix bugs in the internal agent system itself
- Add capabilities the internal agents need
- Test that the internal loop actually works end-to-end
- Make themselves obsolete

**Self-Evolution Loop Status (as of 2026-03-09):**
- Steps 1-3 (monitor/QA/lead ticking): WORKING — lead ticks every ~15min, observer every ~60min, QA every ~120min, explorer every ~180min. Reports "System healthy" on empty boards
- Step 4 (lead processes board task and spawns builder): WORKING — lead receives board tasks, processes them, and makes code changes (fixed by pando-teams commit b099106, timeout fix)
- Step 5 (commit-and-propose): WORKING — tested end-to-end with BIBLE update
- Steps 6-7 (governance → push → EC2 pull): WORKING — governance auto-approves, both EC2 nodes pull approved commits
- Steps 8-10 (verify + BIBLE update): WORKING — lead updates BIBLE after completing tasks

### 1.2 The Portal and Workspace

```
Hub (portal) = the front door
  - Lightweight. Clean. Not confusing.
  - Shows: dashboard, marketplace, governance, wallet
  - Hub chat routes to the "node" team's lead (see Section 1.8)
  - The lead (not a separate doorman) handles everything:
    - Simple queries → answers directly
    - Build requests → creates project team, hands off
    - Feedback/bugs → board task on pando-infra

Teams Web UI (workspace) = where work happens
  - Every project gets a default team with a manager (lead) session
  - Session names reflect the project: "hub-manager", "bakery-website-manager"
  - Users see their teams, sessions, agents, board tasks
  - The node team handles hub-level chat (the receptionist)
  - This is THE interface for building and chatting
```

### 1.3 The End State — When Nobody Is Needed

The end state is: **no external agents, no ops, no lead, no dev.** Jai and any user become OBSERVERS of a system that improves itself.

```
How it works (end state):

1. SUGGESTION INTAKE (see Section 1.6 for full UX spec)
   - Anyone (Jai, users, other nodes) submits suggestions via:
     - Hub chat ("I think the governance page should show vote history")
     - Teams Web UI feedback queue (structured ticket, not direct chat)
     - API (POST /v1/teams/pando-infra/board)
   - Doorman classifies: bug report, feature request, build request, or feedback

2. APPROVAL LAYER
   - Not every suggestion should be acted on
   - Manager evaluates: Is this feasible? Safe? Aligned with the vision?
   - Low-risk (bug fix, docs): auto-approve → board task
   - Medium-risk (new feature, refactor): queue for governance vote
   - High-risk (architecture change, breaking): require human approval (Jai)
   - Spam/bad suggestions: reject with explanation

3. EXECUTION
   - pando-infra lead picks up approved board tasks
   - Analyzes → plans → writes code → tests → commits via governance
   - Watchdog auto-deploys across all nodes
   - Observer/QA verify the change worked

4. USER PROJECT TEAMS (the actual product)
   - User says "build me X" → doorman creates project + team
   - Manager agent is the CEO of that team
   - Manager plans, delegates, monitors — NOT a builder
   - For simple projects: manager builds solo (faster)
   - For complex projects: manager spawns builder/tester agents
   - Manager asks user for approval on big changes
   - Manager fixes bugs autonomously (no user approval needed)
   - App auto-deploys → user gets shareable URL
   - User can send follow-ups → routes to same manager
```

**Two Types of Teams, Two Behaviors:**

| Aspect | pando-infra (system team) | User project teams |
|--------|--------------------------|-------------------|
| Purpose | Maintain & evolve the system | Build what users ask for |
| Autonomy | High — fixes bugs without asking | Conservative — asks user for big changes |
| Bug fixes | Autonomous | Autonomous |
| New features | Proposes via governance | Asks user first |
| Manager role | Ops-like (strategic, proactive) | CEO-like (plans, delegates, reports) |
| Team scaling | Fixed (lead, observer, QA, explorer) | Dynamic (manager spawns agents as needed) |
| Lifecycle | Permanent | Per-project (active → archived) |

**Manager-as-CEO (user project teams):**

The manager's PRIMARY role is team management and strategic planning — exactly what the ops agent does today for external agents. The manager should:
- Analyze the request and assess complexity
- For simple (<50 lines): build directly (speed > delegation overhead)
- For medium (50-500 lines): create a plan with board subtasks, build sequentially
- For complex (>500 lines): spawn builder agents, assign files/features, monitor progress
- Select team templates based on project type (full-stack, API, data, mobile, devops)
- Learn from past projects in the same workspace (patterns, preferences)
- Report progress to the user at natural milestones
- Ask for approval on architecture decisions, auto-fix bugs
- Deploy and deliver without being asked

**The Transition Path (current → end state):**

```
NOW:     External ops/lead/dev drive everything. Internal team is maintenance crew.
NEXT:    External agents become observers. Internal team handles suggestions.
THEN:    Users submit suggestions directly. No external agents needed.
FINALLY: Multiple nodes, each with internal teams, coordinating via governance.
```

### 1.4 Test Scenarios — The Product Must Pass These

These scenarios define "done." Each must work end-to-end from the hub.

**Scenario 1: Simple App (hub → build → deploy → marketplace)**
```
1. User opens hub chat, types "Build me a todo app"
2. Doorman classifies as build intent, tier 1 (static)
3. Project created, team registered, manager spawned
4. Manager builds solo (quick task, <50 lines threshold)
5. Streaming progress visible in hub chat
6. App auto-deploys → user gets live URL in chat
7. App appears in marketplace with deployment data
8. Total time: <2 minutes
```
STATUS: MOSTLY WORKING (tested Phase D). Gap: marketplace auto-listing untested from hub.

**Scenario 2: Complex App (hub → plan → spawn agents → build → test → deploy)**
```
1. User types "Build me a restaurant website with menu, about, contact, and gallery pages"
2. Doorman classifies as build, tier 1
3. Manager analyzes: complex (>50 lines, multiple pages)
4. Manager creates plan with board subtasks
5. Manager spawns builder agent(s) for parallel work
6. Progress streamed to user throughout
7. Manager runs verification (npm build passes)
8. Auto-deploy → live URL → marketplace
```
STATUS: UNTESTED. Manager prompt supports this but spawning never triggered.

**Scenario 3: Follow-up Message (conversation continuity)**
```
1. After Scenario 1 or 2, user types "Add dark mode" in same chat
2. Message routes to the SAME project manager
3. Manager modifies existing code in same workspace
4. Re-deploys updated app
5. User sees updated URL
```
STATUS: PARTIALLY WORKING (workspace continuity tested). Gap: cross-thread follow-ups need explicit project selection.

**Scenario 4: System Suggestion (user → pando-infra)**
```
1. User types "The governance page should show vote counts"
2. Doorman classifies as report/suggestion
3. Board task created on pando-infra team
4. Internal lead picks up on next tick
5. Analyzes, writes fix, commits via governance
6. Watchdog deploys
7. User can verify the change in their browser
```
STATUS: PARTIALLY WORKING (board task → fix → deploy proven). Gap: no web-facing suggestion intake.

**Scenario 5: Multi-node Deployment**
```
1. Fix committed on node A
2. Governance approves
3. All nodes pull the update
4. Observer on each node verifies
```
STATUS: PROVEN for 2 EC2 nodes. Gap: EC2 nodes behind on recent commits.

### 1.5 Known Gaps to End State

| # | Gap | Severity | What exists | What's missing |
|---|-----|----------|-------------|----------------|
| 1 | No external hosting | HIGH | Tier 1 local deploy works | S3/Vercel config for shareable URLs |
| 2 | Cross-thread follow-up | MEDIUM | Same-thread follow-ups WORK (projectId in ThreadMeta, skips doorman) | New-chat follow-ups can't detect "which project?" — dead 'project' intent removed, needs explicit project selection UX |
| 3 | ~~Feedback intake pipeline~~ | ~~HIGH~~ | **IMPLEMENTED** — doorman returns `report`/`feedback` intents (api-server.ts:805-809), platform-api.ts:698-720 creates [BUG:user]/[FEATURE:user] board tasks on pando-infra. Verified working 2026-03-10. | Done |
| 4 | Feedback status UI | MEDIUM | Board task lifecycle exists | Teams Web UI needs user-facing ticket view |
| 4b | Approval layer | MEDIUM | Governance exists | No risk-based triage in manager prompt |
| 4c | System Council read-only view | MEDIUM | Teams Web UI shows pando-infra | Input should be hidden, activity feed only |
| 5 | Agent spawning untested | MEDIUM | manage_team tool + templates exist | Never triggered by a real complex request |
| 6 | Manager doesn't scale teams | MEDIUM | Prompt says to spawn builders | Decision logic untested |
| 7 | No project dedup | LOW | Apps filter hides duplicates | Same prompt creates multiple projects |
| 8 | EC2 nodes behind | LOW | Pull mechanism works | Need to sync to latest commits |
| 9 | No team archival | LOW | Teams stay active forever | No cleanup for completed projects |
| 10 | No cross-project learning | LOW | Each project starts fresh | Manager doesn't learn from past builds |

### 1.6 User Interaction Model — How People Use Pando

Everything enters through team leads. The "node" team lead is the receptionist. See **Section 1.8** for the unified session model.

```
User types message in Hub Chat → Node team lead responds
  │
  ├── BUILD intent ("Build me a todo app")
  │   → Lead creates project + team in Teams Server
  │   → User redirected to Teams Web UI to chat with their project's lead
  │   → Follow-ups in same thread route to same project lead
  │
  ├── QUERY intent ("What is my balance?" / "How are you?")
  │   → Lead answers instantly (no team creation, no work queue)
  │
  ├── FEEDBACK intent ("The search page is broken" / "I suggest adding X")
  │   → Lead creates a board task on pando-infra team
  │   → User sees ticket status: Submitted → Reviewing → Accepted → In Progress → Done
  │   → pando-infra lead triages (accept/reject/governance-vote)
  │
  └── TRANSACTIONAL ("Send 5 Lux to Alice")
      → Lead handles directly

User opens Project workspace → Project team lead responds
  │
  ├── INFO ("What does this app do?" / "Do I have an account?")
  │   → Lead answers from project context (no work queue)
  │
  ├── WORK ("Add dark mode" / "Fix the login bug")
  │   → Lead adds board task, responds "queued, position #N"
  │   → Processes board tasks sequentially (or spawns agents)
  │
  └── STATUS ("What's the progress?")
      → Lead reads board state, reports current status
```

**Teams Web UI — Three Views:**

| View | Who sees it | Can message? | Purpose |
|------|------------|-------------|---------|
| My Projects | Any user | YES — iterate with project manager | Build apps, send follow-ups, watch progress |
| System Council | Any user | NO — read-only activity feed | Observe pando-infra at work (transparency) |
| Feedback Queue | Any user | Submit new + track existing | See status of suggestions/bug reports |

**Why feedback is a BOARD, not a chat:**
- Chat doesn't scale to hundreds of suggestions
- Users need status tracking ("is my suggestion being worked on?")
- Manager needs to batch, prioritize, deduplicate
- Board tasks already have the right lifecycle (pending → active → done)
- A feedback ticket IS a board task with a user-facing status view

**Feedback Triage (pando-infra manager decides):**

| Feedback type | Risk | Manager action |
|---------------|------|---------------|
| Bug report | Low | Auto-accept → board task → internal lead fixes |
| Minor suggestion | Low | Accept → board task |
| Feature request | Medium | Queue for governance vote |
| Architecture change | High | Flag for human review |
| Spam / nonsensical | None | Reject with explanation |
| Duplicate | None | Merge with existing ticket |

**At Scale (hundreds of requests):**
- Queue with auto-prioritization (bugs > features > suggestions)
- Rate limiting per user (configurable, e.g. 5/day)
- Stale suggestions auto-expire (30 days)
- Duplicate detection before creating tickets
- Manager reviews batches, not one-at-a-time

**UX Questions (proactively answered):**

| Question | Answer |
|----------|--------|
| New user lands on hub? | Dashboard: "Build something" CTA, active projects, marketplace highlights |
| Why trust AI-built apps? | Visible test results, "QA passed" badge, source code viewable |
| Build fails? | Manager explains failure, suggests fixes, offers retry |
| Modify deployed app? | Follow-up message → same manager → re-deploys (Scenario 3) |
| Collaborate with others? | Invite collaborator → both can message project team |
| Cost? | Building costs Lux. Simple: 1-5 Lux. Complex: 10-50 Lux. Earn by contributing nodes. |
| App quality on marketplace? | QA review before listing. User ratings. Report mechanism. |
| Roll back to previous version? | Deployment history with rollback button |
| Delete my app? | User deletes from project settings → removes from marketplace + hosting |

**What's Needed to Make External Agents (ops/lead/dev) Fully Redundant:**

1. ~~**Feedback intake pipeline**~~ — **DONE.** Doorman `report`/`feedback` intents → board task on pando-infra. Verified 2026-03-10.
2. **User-facing feedback status UI** — Teams Web UI shows ticket lifecycle (UI change)
3. **Approval layer in manager prompt** — risk-based triage logic (prompt change)
4. **System Council read-only view** — Teams Web UI pando-infra tab, no input (UI change)
5. **Follow-up routing** — existing thread messages reach same project manager (code fix)

Once these 5 are built, anyone (including Jai) interacts with Pando the same way: through the hub, as a user. No special access, no external agents, no terminal sessions.

### 1.7 The Right Architecture — Teams Is The App, Node Is Thin

**Architecture migration COMPLETE (2026-03-10).** The engine adapter was gutted from 2800 → 636 lines. Team management, agent lifecycle, prompt templates, watchdog, and board operations were deleted from Node. Teams Server now owns all team operations. Node API team routes proxy to Teams Server.

**The Principle:** Node = lightweight body (P2P, economy, governance, identity). Teams = the brain (ALL intelligence, ALL teams, ALL agents, ALL chat). The engine adapter should be a thin relay (~300 lines), not a second brain.

```
THE RIGHT ARCHITECTURE:

┌─────────────────────────────┐
│ HUB (port 3003)             │  Lightweight portal.
│ Dashboard, marketplace,     │  Forwards chat to Teams.
│ governance, wallet.          │  No brain, no routing logic.
└─────────────┬───────────────┘
              │ HTTP/SSE
              ▼
┌─────────────────────────────┐
│ TEAMS SERVER (port 4873)    │  THE APP. Everything lives here.
│                             │
│ • ALL teams (pando-infra    │
│   + user projects)          │
│ • ALL agents + orchestration│
│ • ALL chat (doorman, SSE)   │
│ • ALL board tasks (rich     │
│   schema: deps, agents,     │
│   tiers, test status)       │
│ • ALL sessions + memory     │
│ • Classification/routing    │
│ • Agent lifecycle mgmt      │
│ • Proper tick scheduling    │
│   (not raw setInterval)     │
│                             │
│ Calls Node API when needed: │
│ • P2P broadcast/relay       │
│ • Lux transfers/balance     │
│ • Governance propose/vote   │
│ • Identity signing          │
│ • Storage backend           │
└─────────────┬───────────────┘
              │ HTTP (thin infrastructure calls)
              ▼
┌─────────────────────────────┐
│ NODE (port 4000)            │  THIN. Infrastructure only.
│                             │
│ • P2P networking (libp2p)   │
│ • Lux economy (ledger)      │
│ • Governance (proposals)    │
│ • Identity (Ed25519 keys)   │
│ • Storage backend           │
│                             │
│ NO teams. NO agents.        │
│ NO engine adapter brain.    │
│ NO chat routing.            │
│ NO board tasks.             │
│ Engine adapter = ~300 lines │
│ (just Pando tool wrappers)  │
└─────────────────────────────┘

┌─────────────────────────────┐
│ TEAMS WEB UI (port 5173)    │  Talks to Teams Server ONLY.
│ Shows ALL teams, ALL agents.│
│ pando-infra (read-only) +   │
│ user projects (interactive).│
└─────────────────────────────┘
```

**What this fixes:**
- ONE chat system (Teams). No parallel ThreadStore vs session-local.
- ONE board schema (Teams' rich schema). No incompatible schemas.
- ONE agent orchestrator (Teams). No bolted-on setInterval ticks.
- Teams Web UI sees everything (pando-infra, user projects) — no bridges needed.
- Internal team can modify Teams code directly (it lives there).
- Node restarts don't kill agents (Teams manages its own lifecycle).
- Proper resource management (Teams already has session/engine lifecycle).

**What stays in Node:** P2P, Lux, governance, identity, storage — pure infrastructure APIs.
**What moves to Teams:** Team CRUD, agent scheduling, board tasks, chat routing, doorman, engine pool.
**What was gutted:** engine-adapter.ts went from 2800 → 636 lines. Kept: Pando tool wrappers, project board/ticks, P2P board sync, governance review, API key injection.

**Connected vs Offline — Same Engine, Same Architecture:**

```
OFFLINE (standalone, no Node):
  Teams Server starts with one PandoTeams engine for your project.
  No pando-tools. No pando-infra. Just local sessions, agents, board.
  Use case: developer running pando-teams locally on their code.

CONNECTED (linked to Pando network via PANDO_NODE_URL):
  Teams Server starts the same engine PLUS:
  - Registers pando-tools (thin HTTP wrappers → Node infrastructure API)
  - Starts pando-infra team via TeamManager (4 agents with tick scheduling)
  - User project teams also get pando-tools (deploy, governance, economy)
  Use case: full Pando node with hub, network, self-evolution.
```

Both modes use the SAME PandoTeams engine, SAME board schema, SAME agent system.
The only difference: connected mode has extra tools registered and pando-infra running.
This is the correct design — one architecture that scales from offline to full network.

**Teams Web UI Rule (NON-NEGOTIABLE):**
Teams Web UI (port 5173) talks to Teams Server (port 4873) ONLY. Never to Node (port 4000) directly.
- `api.teams()` → `GET localhost:4873/v1/teams` (TeamManager)
- `api.board()` → `GET localhost:4873/v1/teams/:id/board` (TeamManager)
- `api.activity()` → `GET localhost:4873/v1/teams/:id/activity` (TeamManager)
- The old `fetchFromNode()` pattern (Web UI → Node:4000 directly) must be removed.
- Hub also talks to Teams Server for chat/teams, not Node.

**Migration path (3 steps — ALL DONE):**
1. ~~Teams server becomes authority for teams~~ **DONE** (commit `ad39292`, TeamManager + pando-tools + team API + pando-infra boot)
2. ~~Point Web UI at Teams Server~~ **DONE** (commit `0690cc1`, removed `fetchFromNode()`, "Network Teams" → "Teams")
3. ~~Gut engine-adapter~~ **DONE** (commit `1e392a7b`, 2774 → 636 lines, all team routes proxy to Teams Server via `proxyToTeams()`, security fix `4ab63d3e` strips apiKey from public responses)

**This structure works for ALL projects:** pando-infra is just another team in Teams with different rules (autonomous). User projects are teams with conservative rules. Same engine, same UI, same data, same orchestration. No parallel pipelines. Offline or connected — same architecture.

### 1.7.1 The "Where Does This Live?" Gate (NON-NEGOTIABLE)

**Every agent (lead, dev, ops, internal) MUST answer these questions before creating any new class, module, endpoint, or system:**

1. **Does this already exist somewhere in the system?** Search both repos (node + teams) before building anything new.
2. **According to Section 1.7, which component OWNS this functionality?** Quote the relevant line.
3. **Am I building in the right repo?** If Section 1.7 says Teams owns it, don't build it in Node. Period.

**If the answer to #1 is "yes" or #2 points to a different component — STOP. Write to lead's INBOX before writing any code.**

**Why this rule exists:** In early 2026, external agents independently built team management in BOTH Node (engine-adapter.ts) and Teams (core engine), creating 2800 lines of parallel systems with incompatible schemas. Nobody checked whether the other repo already had the feature. This rule prevents that from ever happening again.

**Enforcement:** Lead agent validates dev's proposed approach BEFORE dev writes code. Dev includes the Section 1.7 citation in their INBOX response when proposing an approach. If dev skips this step, lead sends it back.

### 1.8 Unified Session Model — Every Conversation Is a Team

**Core principle: there is no separate "doorman." The doorman IS the team lead.**

Every conversation in Pando belongs to a team. The team's lead agent acts as both the receptionist (answering questions) and the project manager (building things). There is no separate classification system — the lead naturally decides whether to answer directly or start building.

```
UNIFIED MODEL:

Hub landing page chat → "node" team (the receptionist)
  Lead handles: "what is pando?", "my balance?", "how are you?"
  Lead detects build: "build me X" → creates project team, hands off
  Lead detects feedback: "search is broken" → board task on pando-infra

Project-specific chat → that project's team
  Lead handles: "what does this app do?", "do I have an account?"
  Lead detects work: "add dark mode" → plans + builds
  Lead reports: "here's your update, deployed at <url>"

pando-infra chat → system team
  Lead handles: system maintenance, self-evolution
  NOT user-facing (System Council is read-only view)
```

**Why this is better than a separate doorman:**
- No classification step needed — the lead IS the context
- Project leads know their project (can answer "what does this do?" without AI call)
- One system, not two (doorman + team) with handoff friction
- The lead already has board state, memory, tools — classification is natural
- Scales: every team has the same interface (chat → lead → action)

**Session Routing:**

| User action | Routes to | Lead behavior |
|------------|-----------|---------------|
| Opens Hub chat | Node team lead | General Q&A, create projects, route feedback |
| Opens project workspace | Project team lead | Project-specific Q&A, build, iterate |
| Sends follow-up in thread | Same team lead | Continues conversation with context |
| Visits System Council | Read-only view | No interaction (transparency only) |

**Multi-User Concurrency — The Queue Model:**

A project team may have many users talking to it simultaneously. 100 users might ask a popular project for updates. The lead can't process all at once.

```
INBOUND QUEUE:

User A: "what does this do?"        → INSTANT (read-only, no work)
User B: "add dark mode"             → QUEUED (requires work)
User C: "what's the status?"        → INSTANT (read from board state)
User D: "fix the login bug"         → QUEUED (requires work)
User E: "add dark mode"             → DEDUPLICATED (same as User B)
User F: "add dark mode please!!!!"  → DEDUPLICATED (same as User B)
```

**Lead's queue rules:**
1. **Instant answers** — status, info, "what does this do?" → answer directly from context, no queue
2. **Work requests** — build, fix, change → add to board as task, respond "queued, position #N"
3. **Deduplication** — similar requests merge into one board task, all requesters notified
4. **Priority** — bugs > features > suggestions. Critical bugs jump the queue.
5. **One task at a time** — lead works board tasks sequentially (or spawns agents for parallel)
6. **Progress updates** — all users following a task get notified when status changes
7. **Rate limiting** — per-user limit (e.g., 5 requests/day) prevents spam

**At scale (hundreds of users, dozens of projects):**
- Each project team runs independently (isolated engines, isolated boards)
- Node team handles routing only — lightweight, fast
- Project teams scale horizontally across nodes (team handoff via P2P)
- Board tasks are the universal work queue — same for pando-infra, same for user projects
- Users track their requests via the board (not chat history)

**Implementation status:**
- ✅ **User teams auto-start** — commit `ba701a3`. Chat endpoint auto-creates team with lead-universal prompt on first message. Verified working.
- ✅ **Board task PATCH endpoint** — commit `ba701a3`. Teams can mark tasks done/update progress.
- ❌ **Doorman still separate** — classification logic in Node's api-server.ts (200+ lines). Should move to Teams Server as the node team's lead prompt.
- ❌ **No multi-user queue** — current chat is 1:1 (one user, one team lead). No dedup, no rate limit.
- ❌ **No cross-linking** — Hub creates project but doesn't link to Teams Web UI workspace.
- ✅ **Board tasks work** — existing board system handles the queue concept (pending → active → done).
- ✅ **Team architecture works** — TeamManager handles multi-team, multi-agent correctly.
- ✅ **Prompt quality is good** — `makeUniversalLeadPrompt()` has 5-phase methodology.

---

## 2. THE PACKAGES

Pando is independent packages composed by the node.

```
@pando/identity    Pure crypto primitives. No dependencies. No storage.
@pando-teams/core   AI coding engine. No @pando/* dependencies. Standalone product.
@pando/tests       Testing framework. No @pando/* dependencies. Standalone product.
@pando/ledger      SQLite ledger. Depends on @pando/shared only.
@pando/shared      Types + crypto constants. Leaf dependency.

@pando/node        THE COMPOSER. Uses all of the above. Adds P2P, governance, storage, HTTP API.
@pando/hub     Web UI. Reads from @pando/node HTTP API.
```

**Dependency rule: one-way, never circular.**
```
shared < ledger < node
                < identity (standalone, no shared dep)
                < code (standalone, no shared dep)
                < tests (standalone, no shared dep)
```

### The Brain / Body / Nervous System

```
@pando-teams/core = THE BRAIN
  All intelligence. Task management. Memory. Sub-agents. Tools.
  Standalone product — works without pando-node.
  Doesn't import @pando/node. Doesn't know about P2P, Lux, or governance.

@pando/node = THE BODY
  Pure infrastructure. P2P networking. Identity. Economy. Governance. Storage. HTTP API.
  Has ZERO intelligence of its own. No orchestrator. No agent database. No message bus.

engine-adapter.ts = THE NERVOUS SYSTEM (~636 lines, gutted 2026-03-10)
  The ONE file that connects brain to body.
  Creates engine instances. Registers Pando tools. Routes messages. Injects Lux budget.
  Starts teams (startTeam) using PandoTeams's native agent/board system.
  Pando tools are just HTTP calls to the node's own API — the engine doesn't know the difference.
```

**How the brain sees the body:**
```
The engine has 20+ built-in tools (read_file, write_file, bash, grep, spawn_agent, manage_tasks, etc.) plus MCP tools at runtime
When inside a pando-node, it gets EXTRA tools:
  pando_deploy       → POST /v1/apps/:id/deploy
  pando_transfer     → POST /v1/transfer
  pando_propose      → POST /v1/governance/propose
  pando_status       → GET  /v1/status
  pando_peers        → GET  /v1/peers
  ...etc

The engine doesn't import anything from pando-node.
It just has tools that happen to call 127.0.0.1.
That's the ENTIRE integration.
```

---

## 3. PACKAGE DETAILS

### 3.1 @pando/identity (COMPLETE)

**Location:** `packages/identity/` in pando/node monorepo
**Lines:** ~1,349 | **Tests:** 90 across 11 files | **Status:** DONE

Pure cryptographic primitives. No storage, no SQLite, no MongoDB, no network.

**What it provides:**
- Ed25519 keypair generation, load/save, encryption (AES-256-GCM, PBKDF2)
- Agent identity: own keypair + human-signed certificate (AgentCertificate)
- Signed actions: agent signs with own key, includes certificate for offline verification
- JWT: Ed25519-signed (EdDSA), stateless, 24h expiry
- Trust chain: `verifySignedActionFull(action, humanPublicKey)` — action sig → cert sig → expiry. Zero network needed.

**Key types:**
- `KeyPair` — peerId, publicKey, privateKey, createdAt
- `AgentCertificate` — agentId, agentPublicKey, parentId, permissions, expiresAt, parentSignature
- `AgentProfile` — id (peerId = wallet), publicKey, parentId, certificate, role, capabilities, scope, tools, model, status
- `SignedAction` — agentId, action, payload, timestamp, signature, certificate
- `JwtPayload` — sub (peerId), iss (node), iat, exp, typ (human | agent)

**Key files:** `core/keypair.ts`, `core/signing.ts`, `core/encryption.ts`, `identity/agent-profile.ts`, `identity/signed-action.ts`, `auth/verifier.ts`, `auth/jwt.ts`

### 3.2 @pando-teams/core

**Location:** Separate repo at `pando/teams/`
**Lines:** 60K+ TypeScript | **Status:** DONE as standalone. Network integration infra built (EnginePool, Scheduler, PandoServer). Claude Code CLI provider DONE (in pando-teams repo).

The AI coding engine. Multi-provider (Anthropic, OpenAI, Google, Ollama, Claude Code CLI). Multi-agent orchestration. Persistent memory. AST-based code intelligence.

**CRITICAL: PandoTeams is a COMPLETE agent platform. Before building ANY agent/team/communication/task system in pando-node, check if PandoTeams already provides it. It almost certainly does. See the capability reference below.**

#### 3.2.1 Engine & Tools

- `PandoTeams` class — the engine. Create, send messages, get streaming responses.
- 9-layer frame system (L0 identity → L8 project context). `FrameBuilder.build()` is the ONLY prompt assembly path.
- 20+ built-in tools (+ MCP tools at runtime) — read_file, write_file, edit_file, bash, glob, grep, spawn_agent, manage_tasks, send_message, save_memory, query_memory, check_agents, list_files, undo, multiedit, genome, test, run_tests, etc.
- Guardrails — hard (enforced), role permissions matrix, risk tiers, git checkpoints.
- Knowledge graph — AST-based, 1000+ symbols, 13K+ cross-references.
- MCP client — connects to external MCP servers (Playwright built-in).
- **API mode** — `PandoTeams.create()` + `engine.send()` works programmatically. No CLI required.

#### 3.2.2 Agent System (ALREADY BUILT — do NOT recreate)

PandoTeams has a **full persistent agent system**. Do NOT build a parallel one in pando-node.

- **Persistent agent profiles** in SQLite `agents` table (id, role, model, systemPrompt, tools, scope, status, sessionId, displayName, description, createdAt + optional identity: parentId, publicKey, certificate)
- **NOT per-engine** — agent profiles are global in the database, not scoped to a single engine
- **Agent roles with built-in tool filtering:**

| Role | Tools | Pando-node equivalent |
|---|---|---|
| `explorer` (role string: `explore`) | read-only | Observer (health monitoring) |
| `tester` | read + bash + test | QA (test execution) |
| `lead` | delegation: spawn_agent, manage_tasks, check_agents, send_message | Council (orchestration) |
| `builder` | full code access (read, write, edit, bash) | Workers (coding) |
| `reviewer` | read + analysis | Code review |
| `coordinator` | planning + delegation | Team coordination |
| `planner` | planning | Architecture planning |

- **Agent UI** — Agents tab in PandoTeams web UI: create, delete, rename, view sessions, status badges
- **Agent API** — `POST /v1/agents` (create), `GET /v1/agents` (list), `PATCH /v1/agents/:id`, `DELETE /v1/agents/:id`
- **Sub-agents** — ephemeral workers spawned by `spawn_agent` tool. Temporary, no DB record. Used by lead agents to delegate work.

**KEY RULE: pando-node should create agent profiles via PandoTeams's API, not maintain its own agent registry.**

#### 3.2.3 Board (Task Tracking — ALREADY BUILT)

- **Board tasks** — SQLite `board_tasks` table: id, sessionId, title, status, order, parentId, assignedAgent, dependsOn (JSON), progress, createdAt, completedAt
- **Status lifecycle:** `pending → in_progress → done / rolled_back`
- **Task assignment** to specific agents
- **Dependencies** between tasks (dependsOn array)
- **Board UI** — Board tab: unified task list, filter by agent/status, sort, cancel/retry actions
- **Board API** — `GET /v1/board` (current session), `GET /v1/board/all` (cross-session), `POST /v1/board/tasks`, `PATCH /v1/board/tasks/:id`
- **Discoveries** — structured observations (category, confidence) extracted from file reads. Injected into board snapshot.
- **Board snapshot NOT in prompt frame** (PandoTeams Option B). pando-node injects board state in the scheduler tick MESSAGE instead. See Section 5.10.3.

**KEY RULE: Use board tasks for issue tracking, not a custom FindingsStore. Board tasks already have the status lifecycle needed.**

#### 3.2.4 Communication (ALREADY BUILT — do NOT recreate)

- **send_message tool** — database-backed message queue in `state` table
  - Key format: `msg:{toAgentId}:{uuid}` with 1-hour TTL
  - **Cross-engine capable** — agents in different engines can message each other IF they share the SQLite database
  - Supports broadcast to all agents
- **check_agents tool** — read inbox (`action: "inbox"`), list agents, check agent status
  - Messages deleted after reading (acknowledged)
- **Event bus** — 20+ event types streamed via WebSocket for real-time UI updates

**KEY RULE: Use send_message for inter-agent communication, not a custom event system.**

#### 3.2.5 Memory (ALREADY BUILT)

- **Per-engine memory store** — append-only lessons, discoveries, entity knowledge, flows
- **Ranked recall** — scope precision x confidence x recency x impact
- **Entity knowledge** — multi-dimensional: identity, behavior, connections, rules, risks, history
- **Post-turn reflection** — auto-extracts lessons after each agent turn
- **Never deleted** — only marked stale. Agents learn permanently across sessions.

#### 3.2.6 Infrastructure (ALREADY BUILT)

- **EnginePool** (`pool/engine-pool.ts`) — Multi-engine management. `Map<id, PandoTeams>` with lazy creation, TTL eviction, lifecycle hooks (`onAfterCreate`), max limits, concurrent-safe. ~290 lines.
- **Scheduler** (`pool/scheduler.ts`) — Periodic task execution. Named tasks with interval + prompt + callbacks (onEvent, onComplete, onError). Sends to engines via pool. Pause/resume/trigger. ~200 lines.
- **PandoServer** (`server/server.ts`) — HTTP API with SSE streaming. Engine/schedule/health endpoints. ~200 lines.
- **One engine = one session = one active agent at a time**
- **Shared database** — all engines sharing same SQLite DB can communicate via send_message

**Key files:** `engine/engine.ts` (~2400 lines, main loop), `board/board.ts`, `agent/sub-agent.ts`, `agent/frame-builder.ts`, `memory/memory-store.ts`, `tool/registry.ts`, `tool/send-message-tool.ts`, `tool/check-agents.ts`, `provider/provider.ts`

#### 3.2.7 Web UI

| Tab | Component | What it shows |
|---|---|---|
| Sessions | SessionsView.tsx | Conversations, chat, message history |
| Agents | AgentsView.tsx | Persistent agent profiles, roles, status, create/delete |
| Board | BoardView.tsx | Task board, filters by agent/status, metrics dashboard |
| Tests | TestsView.tsx | Test scenarios, results |
| Settings | Settings.tsx | Model, budget, config |

#### 3.2.8 Integration with @pando/node

- Zero @pando/* imports. Structural typing for integration.
- Dual budget: `UsdBudgetProvider` (standalone) vs `LuxBudgetProvider` (injected by node).
- Custom tools registered at runtime via `engine.tools.register()`.
- **pando-node's ONLY job:** register pando_* tools + inject Lux budget + set system prompts via agentOverride. Everything else (agents, board, memory, communication, model selection) is PandoTeams's responsibility.

#### 3.2.8.1 UNIFICATION DIRECTIVE (2026-03-10, from founder)

**See Section 1.7 for the full architecture.** Teams Server = THE APP. Node = THIN infrastructure. Hub = lightweight portal. Engine adapter gets gutted.

**PandoTeams has two modes:**
1. **Offline mode (standalone):** Runs without pando-node. Single-project AI coding tool. Uses USD budget, local models. No P2P, no Lux, no governance. This is how developers use it independently.
2. **Online mode (connected to pando-node):** `PANDO_NODE_URL` env var is set. Teams Server manages ALL teams (pando-infra + user projects), ALL agents, ALL chat, ALL board tasks. Calls Node API for P2P, Lux, governance, identity. This is how network nodes run.

**Both modes must work.** Offline is the default developer experience. Online is the network experience. Same codebase, same UI — online just adds network features via Pando tool wrappers.

**Rules for ALL agents (NON-NEGOTIABLE):**
1. **Always update the BIBLE** after significant changes. This is how future sessions and future agents understand the system. If you change architecture, update the BIBLE. If you delete code, update the BIBLE. The BIBLE must always match the code.
2. **Always clean up legacy code.** No dead imports, no commented-out blocks, no deprecated references, no `_unused` vars, no re-exports of deleted things. We have git. Delete it.
3. **No parallel systems.** One source of truth per concept. See Section 1.7.
4. **Document for context loss.** Every agent loses context eventually. Write STATUS.md, INBOX.md, and BIBLE updates so the NEXT session can pick up instantly. Think: "If I lose all memory right now, what would I need to know?"

#### 3.2.9 Claude Code CLI as Agent Runtime (IMPLEMENTED + VERIFIED)

Claude Code is NOT a dumb model API. It is a **persistent agent runtime** with its own session management, tool system, and memory. It lives in `@pando-teams/core`, NOT in pando-node.

> **Full roadmap:** `pando/teams/docs/CLAUDE-CODE-AGENT-ROADMAP.md`

**Key files in pando-teams repo:**
- `packages/core/src/provider/claude-code.ts` — `createClaudeCodeModel()` returns LanguageModelV3-compatible object. Persistent sessions via `--session-id`/`--resume`. Windows-safe (no shell, stdin pipe, full path resolve). System text length guard (32K limit).
- `packages/core/src/provider/provider.ts` — `ProviderName` includes `"claude-code"`. `createModel()` routes `modelId === "claude-code"` to the CLI provider with server port.
- `packages/core/src/engine/engine.ts` — Input wrapping ([BOARD]+[GOALS]+[SITUATION]+[MESSAGE]), reflection follow-up with `_inReflectionFollowUp` recursion guard, `_claudeCodeLock` for sequential turn execution.
- `packages/server/src/routes/api.ts` — Memory HTTP API: `GET /v1/memories/search` (FTS5 full-text with LIKE fallback), `GET /v1/memories`, `POST /v1/memories`, `GET /v1/memories/health`. FTS5 lazy-initialized via `ensureFts5()` — creates `memories_fts` virtual table, auto-synced on insert. Model includes `{ id: "claude-code", label: "Claude Code (CLI)", tier: "local" }`.

**Architecture (implemented):**

1. **Session persistence** — `--session-id <uuid>` on first turn, `--resume <uuid>` on subsequent turns. Session ID tracked in closure per model instance. Claude Code's `-p` mode (spawn/die per turn) with session data persisting in `~/.claude/`. Full persistent process management is Phase 6 (not yet built).

2. **Two-layer context model:**
   - **Pre-injected (every input message):** Board state, goal stack, situation — wrapped around user message as `[BOARD]\n[GOALS]\n[SITUATION]\n[MESSAGE]`. System messages (L0-L5b frames) concatenated into `--append-system-prompt`.
   - **Agent-pulled (Claude Code decides when):** Memory search via HTTP API (`GET /v1/memories/search?q=<topic>`). Claude Code calls this via curl when it needs context.

3. **Reflection pipeline (verified working):**
   - After Claude Code responds, engine sends a fire-and-forget follow-up to the same session asking for reflection.
   - `_inReflectionFollowUp` boolean guard prevents infinite recursion (reflection response would otherwise trigger another reflection).
   - Reflection messages skip conversation DB persistence and turn count increment (no history pollution).
   - Claude Code evaluates: "No lessons." for trivial tasks, saves genuine insights via `curl -s -X POST http://127.0.0.1:<port>/v1/memories`.
   - **Proven:** Claude Code autonomously saved a lesson about Windows 32K command-line limit during testing.

4. **No MCP dependency:** All agent operations use PandoTeams's HTTP API. MCP is optional enhancement.

5. **`--append-system-prompt`** (not `--system-prompt`) — keeps Claude Code's own tool instructions, adds PandoTeams identity + memory API instructions on top. Length-guarded: truncated with warning if system text exceeds 28K chars (Windows CreateProcessW 32K limit).

6. **Sequential turn execution** — `_claudeCodeLock` promise chain ensures concurrent `send()` calls (e.g., user message while reflection is in-flight) execute sequentially. Prevents race conditions with `--resume` on the same Claude Code session.

**What's different from API-path models (Gemini, OpenAI):**

| Aspect | API Models | Claude Code |
|---|---|---|
| Frame layers | System messages via FrameBuilder | Board/Goals/Situation in input message wrapper |
| Memory | Injected into L3 system message | Agent-pulled via HTTP API |
| Reflection | Engine's reflection pipeline (callReflectionModel) | Post-response follow-up → Claude Code calls POST /v1/memories |
| Tools | PandoTeams's tool registry (injected into LLM API call) | Claude Code's own tools (Read, Edit, Bash, Grep, Glob) + curl to HTTP API |
| Custom tools | `engine.tools.register()` → model sees them natively | **SILENTLY DROPPED** by claude-code.ts → must use HTTP API endpoints instead |
| Session | PandoTeams manages conversation history | Claude Code manages via --session-id |
| Process | N/A (API call) | Spawn-per-turn with session resume (persistent process is Phase 6) |
| Concurrency | Parallel OK | Sequential via lock (single Claude Code session) |

#### 3.2.10 Tool Architecture: API Models vs Claude Code (CRITICAL)

**The tool gap:** PandoTeams registers tools via `engine.tools.register()` and passes them to `model.doStream({tools})`. API models (Gemini, GPT, Anthropic direct) receive and use these tools natively. **Claude Code CLI ignores the `tools` parameter entirely** — `claude-code.ts` never passes tools to the CLI process. Tools are silently dropped.

**Why:** Claude Code CLI has its own fixed toolset (Bash, Read, Write, Edit, Grep, Glob, Agent) and MCP support. It doesn't accept custom tools via command-line args. PandoTeams's tool registry was designed for API models.

**The solution — HTTP API as universal tool interface:**

For Claude Code agents, ALL operations must be done via `curl` to the node's HTTP API. The agent prompts include curl commands, not tool references. This is injected via `--append-system-prompt` on every turn (agent can't forget it).

**Agent prompt reference (for Claude Code model):**

| Operation | HTTP API Endpoint |
|---|---|
| Update board task | `PATCH /v1/teams/:teamId/board/:taskId` with `{status, progress}` |
| Create board task | `POST /v1/teams/:teamId/board` with `{title, description}` |
| Send message to agent | `POST /v1/teams/:teamId/message` with `{from, to, message}` |
| Spawn sub-agent | `POST /v1/teams/:teamId/agents/spawn` with `{template, task}` |
| Stop sub-agent | `DELETE /v1/teams/:teamId/agents/:agentId` |
| List agents | `GET /v1/teams/:teamId/agents` |
| List templates | `GET /v1/templates` |
| Propose governance | `POST /v1/governance/propose` with `{title, description, category, commitHash}` |

**For API models:** PandoTeams tools (`manage_tasks`, `send_message`, `check_agents`, `manage_team`) work natively via `engine.tools.register()`. No curl needed.

**PromptContext.model field:** `PromptContext` includes `model?: string` so prompt template functions can differentiate behavior if needed. Currently all agents use `claude-code` so prompts contain curl commands.

**What goes where:**
- **System prompt** (via `--append-system-prompt`): Agent identity, role, responsibilities, API reference, rules. Stable across turns. Can't be forgotten.
- **User message** (per-turn injection): Board state, inbox messages, goals, situation. Dynamic. Injected by `sendToTeamAgent()` before each turn.
- **Claude Code's own context**: Its built-in tools, CLAUDE.md, memory files. We don't control this — it's additive to our system prompt.

**CRITICAL RULES:**
- Never put model/provider logic in pando-node. Model selection is a brain (PandoTeams) decision.
- Claude Code cannot be launched inside another Claude Code session. Provider deletes `CLAUDECODE` env var.
- API-path models are UNCHANGED by this architecture. Only Claude Code gets the new treatment.
- Reflection messages MUST skip conversation DB persistence to avoid history pollution.
- Never reference PandoTeams tools (manage_tasks, send_message) in Claude Code agent prompts. Use HTTP API curl commands instead.
- The `manage_team` PandoTeams tool is kept for API models but also has HTTP API equivalents for Claude Code.

#### 3.2.11 PandoTeams Web UI — Network Teams (Phase 4+5 COMPLETE)

**Location:** `packages/web/src/views/NetworkTeamsView.tsx` in pando-teams repo

The pando-teams web UI (port 4873) has a "Network" tab (sidebar "N" icon) that shows teams managed by pando-node:

**Phase 4 — Network Teams Dashboard:**
- Fetches teams from pando-node via `GET /v1/teams` (CORS enabled, no proxy needed)
- Team cards: status, agent count, task count, governance badge, Lux cost
- Expandable: agents list, board tasks (max 10), cost breakdown
- Auto-refresh every 30s
- "Not connected" state when no pando-node linked

**Phase 5 — Agent Detail Panel:**
- Clickable agent rows expand to show detail panel
- Agent conversation history: `GET /v1/teams/:teamId/agents/:agentId/messages?limit=20`
- Per-agent cost breakdown (Lux + tokens) from cost data
- Model badge (purple pill) and status indicator on each agent row
- Messages fetched on-demand (role-colored: blue=assistant, green=user)

**Network linking detection:** PandoTeams checks for `PANDO_PROJECT.json` in project dir or `~/.pando/projects/`. Config exposes `{ linked, nodeUrl, nodeId, projectId }` via `GET /v1/network`. The web UI reads nodeUrl and fetches directly from pando-node.

**Key files (pando-teams repo):**
- `packages/web/src/views/NetworkTeamsView.tsx` — main view (507+ lines)
- `packages/web/src/api.ts` — `fetchFromNode()`, `nodeTeams()`, `nodeAgentMessages()`, etc.
- `packages/web/src/components/Sidebar.tsx` — "network" nav item
- `packages/web/src/App.tsx` — route handler

### 3.3 @pando/tests (PHASE 4 COMPLETE)

**Location:** `packages/tests/` in pando/node monorepo
**Lines:** ~2,000 | **Status:** Phase 4 DONE (API + Dashboard). Phase 5-6 pending (CLI, polish).

Standalone testing framework with two modes: scripted (Playwright, pass/fail) and live (agent-driven, intelligent findings).

**What it provides:**
- `PandoTester` class — unified entry point per project
- Per-project SQLite databases + per-project isolation via `Map<string, PandoTester>`
- Scripted runner (Playwright): `tester.scripted.runAll()`, `tester.scripted.run(spec)`
- Live runner (agent + Playwright): `tester.live.run(playbook, opts)`
- Playbook format (JSON): steps with actions (navigate, click, fill, verify, screenshot, api_call)
- Findings system: severity, status lifecycle (open → acknowledged → resolved/wontfix)
- History + stats trend: `tester.history.getRuns()`, `tester.history.getTrend()`
- Dashboard data: `tester.dashboard.overview()`

**Node integration:** `testing-api.ts` mounts 11 routes at `/v1/testing/*`
**Gateway integration:** `/testing` page with full dashboard UX

**File layout:**
```
tests/e2e/{project}/*.spec.ts     Playwright specs (per-project subdirs)
packages/tests/playbooks/{project}/ Live playbooks (per-project)
```

### 3.4 @pando/ledger

**Location:** `packages/ledger/` in pando/node monorepo
**Status:** DONE

SQLite database for accounts, transactions, emissions. P2P synced via GossipSub `pando/transactions` topic.

**Key facts:**
- Hard cap: 10 billion Lux
- Relay fee: 0.1% per transfer
- Daily cap: 500 Lux per node per day
- Witness-based emission: peers attest work before Lux minted

### 3.5 @pando/node (THE BODY)

**Location:** `packages/node/` in pando/node monorepo
**Status:** Working. Brain-kill migration complete (9,414 lines removed). Distributed compute model implemented and tested (both paths working end-to-end). Deploy pipeline proven live — build → GitHub → S3 deploy → marketplace.

The node composes all packages. It is PURE INFRASTRUCTURE — no intelligence of its own.

**Source layout (3-layer architecture):**
```
kernel/    Layer 0: P2P core (network, sync, governance, guardrails, monitor, security, reputation, emission)
core/      Layer 1: Storage, deploy, credentials, upgrade, payment, engine-adapter
platform/  Layer 2: Resources, content, threads, capabilities
api/       HTTP API (kernel-api, core-api, platform-api, testing-api, server, middleware/)
(root)     Entry points: index.ts, cli.ts, tui.ts, logger.ts, config.ts
           Init files: init-kernel.ts, init-core.ts, init-platform.ts (extracted from index.ts _start())
```

**Import boundary rule (enforced):** kernel → only kernel + @pando/*. core → kernel + @pando/*. platform → core + kernel + @pando/*. Never upward.

**Four node types** (see Section 5.5 for full details):
- `contributor` — PandoTeams + local API keys. Builds apps, earns Lux. The common case.
- `secure` — EC2 with MongoDB + CredentialStore. Handles contributed keys, simple AI.
- `lightweight` — P2P, ledger, governance only. Routes AI work to peers.
- `full` — Contributor + local MongoDB. Full self-sufficiency (dev machines).

### 3.6 @pando/hub

**Location:** `packages/hub/` in pando/node monorepo
**Stack:** Next.js 16 + Tailwind
**Status:** DONE (25 pages — simplified from 36, 11 internal/operator pages removed including /explore/health)

Reads from @pando/node HTTP API via NodePool. **ALL API routes use `'primary'` routing** (single node identity required for E2E encryption and consistent data). No route should use random node selection.
**Public deployment:** https://gateway-one-mu.vercel.app
**Required env var:** `PANDO_NODES=http://localhost:4000` (or comma-separated node URLs). Without this, hub falls back to EC2 fallback seeds which may cause encryption identity mismatches.

**Pages (25):** `/` (landing), `/chat`, `/search`, `/projects`, `/apps`, `/wallet`, `/network`, `/governance`, `/agents`, `/marketplace`, `/explore` (+5 sub-pages: activity, economy, governance, how-it-works, network), `/dev`, `/login`, `/register`, `/services`, `/testing`, `/node-setup`, `/resources` (+guide)
**Removed (Phase 3 simplification):** strategy, council, dashboard, monitor, scheduler, capacity, content, explore/strategy, explore/tasks, explore/health

**Data sources:** Apps page reads from AppManager (`/v1/apps`), Agents page aggregates from team registry (`/v1/teams` + `/v1/teams/:id/agents`), Network page reads from `/v1/status` + `/v1/peers` + `/v1/reputation/peers` + `/v1/network/capabilities`, Marketplace reads from `/v1/marketplace`.

**Real-time streaming:** Hub subscribes to SSE at `/api/events` (proxy to node's `/v1/events`). During builds, the node emits `chat_progress` events per stream chunk from `sendToTeamAgent()`. Hub accumulates these as an activity log shown inline in chat. Final result arrives via `chat_message` event. This gives users real-time visibility into agent build progress.

---

## 4. NODE COMPONENTS

### 4.1 Kernel Layer (infrastructure)

| Component | File | Status | What it does |
|---|---|---|---|
| **PandoNetwork** | `kernel/network.ts` | DONE | libp2p: TCP, Noise, Yamux, GossipSub, Circuit Relay, KadDHT. **Important:** All `uint8ArrayFromString`/`uint8ArrayToString` calls must include explicit `'utf8'` encoding — without it, multi-byte UTF-8 chars (em-dashes, etc.) get corrupted during P2P broadcast. Fixed in commit `40423104`. |
| **LedgerSync** | `kernel/sync.ts` | DONE | P2P ledger synchronization via GossipSub |
| **Governance** | `kernel/governance.ts` | DONE | 6-layer security pipeline + AI review hook (see 5.4) |
| **HealthMonitor** | `kernel/monitor.ts` | DONE | System health polling + alerts |
| **Guardrails** | `kernel/guardrails.ts` | DONE | 4-tier rate limiting + anomaly detection |
| **SecurityMonitor** | `kernel/security-monitor.ts` | DONE | 5 detectors: DDoS, Sybil, spam, anomaly, resource abuse |
| **ReputationManager** | `kernel/reputation.ts` | DONE | Performance tracking + weighted governance votes |
| **EmissionWitness** | `kernel/emission-witness.ts` | DONE | Witness-based Lux emission |
| **CrashGuard** | `kernel/crash-guard.ts` | DONE | Crash loop detection + circuit breaker. Port conflict exits use code 78 (supervisor won't respawn). Circuit breaker resets on successful boot. Thresholds: 6 crashes/60s (guard), 5 consecutive (breaker). |
| **LocalEnvironment** | `kernel/local-environment.ts` | DONE | Local environment detection (~326 lines) |
| **NetworkState** | `kernel/network-state.ts` | DONE | Network state tracking (~409 lines) |
| **StartupHealth** | `kernel/startup-health.ts` | DONE | Startup health validation (~231 lines) |

### 4.2 Core Layer (services + engine adapter)

| Component | File | Status | What it does |
|---|---|---|---|
| **EngineAdapter** | `core/engine-adapter.ts` | DONE | The ONE pando-teams integration point. PandoTeams contributor nodes only. Multi-engine, routing, Pando tools, Lux budget. |
| **AppManager** | `core/app-manager.ts` | DONE | Unified app lifecycle: SQLite registry (apps.db), three tiers (1=static/S3, 2=server/PM2, 3=infrastructure), governance gate, blue-green deploy, health monitoring, rollback, P2P dispatch. pando-node + pando-teams registered as tier 3 apps on startup. See Section 5.8. |
| **CredentialStore** | `core/credential-store.ts` | DONE | AES-256-GCM encrypt/decrypt. Secure compute nodes (EC2) only. |
| **StorageBackend** | `core/storage-backend.ts` | DONE | MongoDB direct or HTTP proxy to compute nodes |
| **UpgradeProtocol** | `core/upgrade-protocol.ts` | DONE | Governance gate + security validation + safe restart for infrastructure upgrades. Uses GitOps for all git operations. |
| **GitOps** | `core/git-ops.ts` | DONE | Unified git operations layer — ALL git calls go through this class. `execFileSync` only (no shell injection). Methods: clone, fetch, pull, checkout, resetHard, commit, revert, stashAndReset, diffNameOnly, isAncestor, etc. |
| **GitHubClient** | `core/github-client.ts` | DONE | GitHub API client for autonomous repo creation. createRepo, deleteRepo, repoExists. Uses contributed PAT. |
| **PaymentGate** | `core/payment-gate.ts` | DONE | Lux escrow for task execution |
| **RequestReply** | `core/request-reply.ts` | DONE | Handler registry + broadcast queries only. Unicast removed (Phase A). |
| **HttpPeerClient** | `core/http-peer-client.ts` | DONE | Direct HTTP for all inter-node operations. Ed25519-signed requests. See Section 4.5. |
| **CloudInstanceManager** | `core/cloud-instance-manager.ts` | DONE | EC2 instance provisioning, security groups, IP polling (~961 lines) |
| **DeployManager** | `core/deploy-manager.ts` | DONE | PatchSet git commit/revert for CodePipeline. Uses GitOps for all git operations. |
| **VersionProtocol** | `core/version-protocol.ts` | DONE | Version negotiation between nodes (~222 lines) |
| **MongoBackend** | `core/mongo-backend.ts` | DONE | MongoDB storage backend implementation (~239 lines) |
| **P2PStorageBackend** | `core/p2p-storage-backend.ts` | DONE | P2P storage proxy for non-MongoDB nodes (~171 lines) |
| **ServiceLoader** | `core/service-loader.ts` | DONE | Discovers and loads installed PandoService npm packages. Auto-skip if not installed. See Section 5.11. |
| **TeamRegistry** | `core/team-registry.ts` | DONE | SQLite + GossipSub team sync. Orphan detection, heartbeat, auto-claim. See Section 5.10. |

### 4.3 Platform Layer (non-brain services)

| Component | File | Status | What it does |
|---|---|---|---|
| **CapabilityDetector** | `platform/capability-detector.ts` | DONE | Auto-detect: PandoTeams, storage, compute, hosting. Claude Code auth: ANTHROPIC_API_KEY env, ~/.claude/.credentials.json (OAuth), ~/.claude/history.jsonl+settings.json (Max/Pro plan). |
| **ResourceMarketplace** | `platform/resource-marketplace.ts` | DONE | GossipSub price broadcasting, resource discovery, metering |
| **ContentRegistry** | `platform/content-registry.ts` | DONE | Content management |
| **ThreadStore** | `platform/thread-store.ts` | DONE | Chat thread persistence. Non-blocking writes (local cache immediate, HTTP storage async). Requires MongoDB (EC2) or HTTP proxy for persistence. |
| **ProjectStore** | `platform/project-store.ts` | DONE | Project persistence, CRUD, collaborators, reports (~2,328 lines) |
| **TaskQueue** | `platform/task-queue.ts` | DONE | Task queue, hashing, distribution (~1,056 lines) |
| **TaskDatabase** | `platform/task-database.ts` | DONE | Task SQLite persistence (~911 lines) |
| **Scheduler** | `platform/scheduler.ts` | DONE | Task scheduling, polling, capacity management (~855 lines) |
| **PipelineRunner** | `platform/pipeline-runner.ts` | DONE | Code pipeline execution (~724 lines) |
| **QARunner** | `platform/qa-runner.ts` | DONE | QA test execution (~743 lines) |
| **UserAccounts** | `platform/user-accounts.ts` | DONE | Guest/claim auth, ban checking (~617 lines) |
| **ContributionTracker** | `platform/contribution-tracker.ts` | DONE | Contribution tracking (~522 lines) |
| **ResourceRegistry** | `platform/resource-registry.ts` | DONE | Credential metadata, usage tracking, `resolveGitCredential()` for dynamic PAT resolution (~439 lines). See Section 5.12.1. |

### 4.4 HTTP API

Fastify on API port (default 4000). Bearer token auth on writes (`~/.pando/api-token`). All routes prefixed `/v1/`.

**Auth model:** Two token types, different headers.
- Operator token: `Authorization: Bearer <api-token>` — node admin operations
- User JWT: `X-User-Token: <jwt>` — user/agent identity (from Pando Login)

**Key route groups:**
| Group | Prefix | Examples |
|---|---|---|
| Kernel | `/v1/status`, `/v1/peers`, `/v1/tasks/*`, `/v1/governance/*`, `/v1/admin/*` | Node health, peers, tasks, governance, scheduler, admin |
| Core | `/v1/upgrade/*`, `/v1/emissions/*`, `/v1/security/*` | Upgrade, emissions, security monitoring |
| Chat | `/v1/chat/*` | Message → doorman → Path A (question) or Path B (build) or report (board task). |
| Engines | `/v1/engines/*` | List active engines, board snapshots, memory |
| Projects | `/v1/projects/*` | Create, list, `board` (per-project tasks), `request` (submit bug/feature) |
| Apps | `/v1/apps/*` | Deploy, undeploy, update, rollback, health, history, logs (12 routes) |
| Auth | `/v1/auth/*` | Challenge, verify (Pando Login), me, refresh |
| Testing | `/v1/testing/*` | Status, runs, findings, scenarios, playbooks, specs, stats |
| Council | `/v1/council/*` | `status`, `trigger/:agent`, `board` (public task view), `request` (user reports → board task). |
| Gateways | `/v1/gateways` | All known live gateway deployments |
| Capabilities | `/v1/capabilities` | Node capability profile |
| Admin | `/v1/admin/shutdown` | Graceful shutdown (exit 0) |

**Inter-node handler registry** (dispatched via HTTP — see Section 4.5):
| Handler | Where it runs | What it does |
|---|---|---|
| `pando/doorman-classify` | EC2 (secure) | Classify chat intent via contributed OpenAI key. Returns `{intent, response/description}`. |
| `pando/doorman-chat` | EC2 (secure) | Multi-turn chat via contributed OpenAI key. Returns `{reply}`. |
| `pando/ai-query` | EC2 (secure) | General AI query via contributed key. Returns `{answer, sources, confidence}`. |
| `pando/get-credential` | EC2 (secure) | Decrypt a credential (code_repository only). Returns raw credential. |
| `pando/deploy-app` | EC2 (secure) | Clone from GitHub, auto-detect tier, deploy to S3 (Tier 1) or PM2+nginx (Tier 2). Requires `credentialAccess` for S3 creds. |
| `pando/storage-proxy` | EC2 (secure) | Proxy MongoDB CRUD for non-MongoDB nodes. |
| `pando/upgrade-node` | Any | Trigger git pull + build + restart. |
| `chat_proxy` | PandoTeams nodes | Forward chat message for engine processing. |

**How inter-node dispatch works:** Caller uses `httpPeerClient.dispatchRequest(peerId, handlerType, payload)` → HTTP POST to peer's `/v1/internal/dispatch` → peer's `RequestReplyManager.getHandler(type)` looks up handler → executes → returns result. All requests are Ed25519-signed with 60s replay protection. See Section 4.5 for full details.

### 4.5 Inter-Node Communication (HTTP replaces P2P unicast — Phase A)

**All point-to-point operations between nodes now use HTTP.** P2P (GossipSub) is retained ONLY for broadcast operations (peer discovery, ledger sync, governance proposals, capability exchange, team registry sync, upgrade broadcasts).

#### The Split

```
BROADCAST (GossipSub — unchanged)          UNICAST (HTTP — all new)
──────────────────────────                 ──────────────────────────
Peer discovery                             Deploy app to EC2
Ledger sync (transactions)                 Storage proxy (MongoDB CRUD)
Governance proposals + votes               Credential proxy (decrypt key)
Capability profile exchange                Doorman classify/chat proxy
Team registry sync + heartbeat             Resource proof challenges
Upgrade broadcast                          Task forwarding
                                           Reputation queries
                                           Chat proxy to PandoTeams node
                                           Upgrade trigger (node-to-node)
                                           Any registered handler dispatch
```

#### Architecture

```
Node A                                    Node B
──────                                    ──────
httpPeerClient.dispatchRequest(           Fastify API server
  peerId,                                   │
  handlerType,        ─── HTTP POST ───→  /v1/internal/dispatch
  payload                                   │
)                                         getHandler(type) lookup
  │                                         │
  ├─ Resolve peer HTTP address            handler(request) executes
  │  (CapabilityRegistry profiles)          │
  │                                       return { success, payload }
  ├─ Sign request body                      │
  │  Ed25519: sign(body + timestamp)      ◄── HTTP response ───
  │  Headers: X-Pando-Signature,
  │           X-Pando-Timestamp,
  │           X-Pando-PeerId
  │
  ├─ Verify response
  │
  └─ Return result
```

#### Key Components

| Component | File | Role |
|---|---|---|
| **HttpPeerClient** | `core/http-peer-client.ts` | Outbound HTTP to peers. Signed requests. Methods: `storageProxy()`, `deployApp()`, `getCredential()`, `chatProxy()`, `sendRequest()`, `dispatchRequest()`. |
| **Internal API** | `api/internal-api.ts` | Inbound HTTP from peers. `/v1/internal/dispatch` endpoint. Verifies signatures, looks up handler, executes. |
| **RequestReplyManager** | `core/request-reply.ts` | Handler registry (`registerHandler()`, `getHandler()`) + broadcast queries (`query()` via GossipSub). No unicast. |

#### Auth: Ed25519 Signed HTTP

Every inter-node HTTP request is signed:

```
Outbound (HttpPeerClient):
  body = JSON.stringify(payload)
  timestamp = Date.now().toString()
  message = body + timestamp
  signature = sign(message, privateKey)    // Ed25519 from @pando/identity
  Headers:
    X-Pando-Signature: <hex signature>
    X-Pando-Timestamp: <timestamp>
    X-Pando-PeerId: <sender peerId>

Inbound (internal-api.ts middleware):
  Verify: verify(body + timestamp, signature, senderPublicKey)
  Replay protection: reject if |now - timestamp| > 60 seconds
  Peer lookup: resolve publicKey from CapabilityRegistry by peerId
```

#### Generic Handler Dispatch

The `/v1/internal/dispatch` endpoint is the universal entry point for all inter-node operations:

```typescript
// Caller side (any node)
const result = await httpPeerClient.dispatchRequest(
  peerId,           // target node
  'pando/deploy-app', // handler type (matches registerHandler() key)
  { repoUrl, ... },   // payload
  300_000              // timeout ms
);

// Receiver side (internal-api.ts)
POST /v1/internal/dispatch
Body: { type: "pando/deploy-app", payload: { repoUrl, ... } }
→ handler = getHandler("pando/deploy-app")
→ result = await handler(wrappedRequest)
→ Response: { success: true, payload: result }
```

#### Peer Address Resolution

`getPeerHttpEndpoint(peerId)` resolves a peer's HTTP address from CapabilityRegistry profiles:
1. Look up peer's capability profile
2. Prefer `publicAddress` (explicit public IP/hostname)
3. Fall back to `httpApi.host` (but skip `0.0.0.0` — common misconfiguration)
4. Use `httpApi.port` (default 4000)

#### Why HTTP Instead of P2P for Unicast

The root cause: GossipSub is a broadcast protocol designed for thousands of peers. Using it for point-to-point calls between 2-3 known servers was fundamentally wrong. GossipSub mesh formation doesn't work reliably with small networks — the TCP connection shows alive (peers: 1), but the message channel inside it goes dead. Messages go into a black hole, timeout after 30s, and everything downstream fails. Additionally, `handleIncomingStream()` in network.ts swallowed ALL stream errors silently — no logging, no retry, no circuit breaker.

- **Reliability:** HTTP is request-response with timeouts. P2P unicast required GossipSub fallback and direct TCP streams — fragile, hard to debug.
- **Simplicity:** One code path (fetch + sign) instead of three (direct TCP → GossipSub → fallback).
- **Debugging:** Standard HTTP status codes, curl-testable, standard logging.
- **Auth:** Ed25519 signatures + replay protection built in. P2P relied on libp2p noise for transport, but had no application-level auth.
- **NAT traversal:** HTTP works through standard infrastructure (load balancers, reverse proxies). P2P unicast required circuit relay for NAT'd peers.

---

## 5. HOW THINGS WORK

### 5.1 Three Compute Paths — How Work Flows Through the Network

The network has **three distinct compute paths**. Keys never travel. Work travels to the compute.

#### Path A: Simple AI (chat, questions, doorman classification)

No PandoTeams involved. Uses contributed API keys on secure proxy nodes (EC2).

```
User asks: "What is machine learning?"
  |
  v
POST /v1/chat/message → any node receives it
  |
  v
Doorman classifies intent:
  1. Regex fast-path (zero cost): /status, /balance, /help → instant response
  2. Local OpenAI key available (contributor node)? → classify locally
  3. No local key → route to EC2 proxy via HTTP → EC2 decrypts contributed key → classifies
  4. No peers available → fallback keyword matching
  |
  v
Intent = "question" → answer via same path (local key or EC2 proxy)
  → Keys never leave their origin (local env or EC2)
  |
  v
Response returned to user
```

**Contributed API keys** (via `/contribute openai sk-xxx`) are encrypted and stored in MongoDB on EC2. Used server-side on EC2 for simple LLM calls. The contributor doesn't need to run a node.

**Local API keys** (contributor node with OPENAI_API_KEY in env) can handle Path A locally — no EC2 needed. This is the common case for contributor nodes that have both PandoTeams and an OpenAI key.

#### Path B: Build (PandoTeams — full app construction)

```
User says: "Build me a bakery website"
  |
  v
POST /v1/chat/message → any node receives it (via gateway or direct)
  |
  v
Doorman classifies: intent = "build"
  → Project metadata created and saved on network
  |
  v
Node finds best PandoTeams peer on the network:
  → Query capability registry for peers with pando-teams: true
  → Could be SELF (if this node has PandoTeams) or a REMOTE peer
  → Route build job to that peer
  → If NO PandoTeams peers available → degrade gracefully
  |
  v
PandoTeams peer processes the build:
  → Engine Adapter creates Project Engine for this projectId
  → Project Engine plans on its Board: "Goal: Build bakery website"
  → Spawns builder sub-agent → writes HTML/CSS/JS
  → Code committed to GitHub (checkpoint — enables transfer if node goes down)
  → Spawns tester sub-agent → tests locally
  → Uses pando_deploy tool → deploys to hosting
  |
  v
PandoTeams uses contributor's configured provider:
  a) API-based agents (default: Google/Gemini, or OpenAI, Anthropic, Ollama)
  b) Claude Code CLI as persistent agent runtime (DONE — see Section 3.2.9)
  |
  v
SSE streams progress back → to user
  |
  v
User sees: "Your bakery website is live at https://..."
```

**Key routing principle:** The receiving node does NOT assume it will process the build. It calls `findBestBuilder()` which queries the capability registry for all PandoTeams peers (including self). If self has a local engine, it processes locally; otherwise it routes to the best remote peer via HTTP (`routeChatProxyP2P()` uses `httpPeerClient.dispatchRequest()` under the hood). This is critical because the public gateway connects to a random node — that node is a router, not necessarily a builder. The legacy `hasClaudeCodeAuth()` check (Anthropic-only) has been removed — routing is now fully provider-agnostic.

**PandoTeams contributor's keys stay LOCAL.** They never leave the contributor's machine. The network routes work TO the compute, not keys FROM storage.

**Build resilience:** Code is committed to GitHub during build. If the PandoTeams node goes offline mid-build, another node clones from GitHub and continues.

**Subsequent messages** with `projectId` route directly to that project's engine on the PandoTeams node that owns it. ProjectId is "sticky" — stored in thread metadata on first message, not re-sent by the client.

#### Path C: Report / Feedback (user bug reports and feature requests)

```
User says: "I found a bug on the search page" or "feedback: add dark mode"
  |
  v
POST /v1/chat/message → doorman classifies intent
  |
  v
Intent = "report" or "feedback"
  → Creates board task on pando-infra team:
    - "report" → title: "[BUG:user] <message>" (priority: high)
    - "feedback" → title: "[FEATURE:user] <message>" (priority: medium)
  |
  v
Internal pando-infra lead processes the board task on next tick
  → Evaluates, writes fix, commits via governance if needed
  |
  v
Response to user: "Bug report filed" / "Feedback recorded"
```

**Implementation:** api-server.ts:805-809 (doorman classification), platform-api.ts:698-720 (board task creation). Verified working 2026-03-10 — user bug reports flow through doorman → board → internal team processes → fix deployed.

#### Pipeline 4: Full User Journey (end-to-end, PROVEN — commit e6fe16b1)

```
User → Gateway → Chat message "Build me a websocket server"
  → Doorman classifies: intent=build, tier=complex
  → Project created in ProjectStore with workspaceDir (~/.pando/projects/{projectId}/)
  → Engine dispatched (local or remote PandoTeams peer via findBestBuilder())
  → Engine builds in ~/.pando/projects/{projectId}/
  → Build completes → deploy result AWAITED (not fire-and-forget)
    → Success: deploy message pushed to chat thread + SSE `app_deployed` event
    → Failure: failure message pushed to chat thread + SSE `app_deploy_status` event
  → App auto-registered in AppManager (SQLite apps.db)
  → Project listed in marketplace WITH deployment data (status, url, tier, commit)
  → User sends follow-up to same projectId → engine resumes (same team)
  → Update triggers re-deploy
```

**Workspace-based deploy (DONE — commit 346cefd2):** Chat-created projects that lack `repo_url` use workspace-based deploy. `resolveWorkspace()` finds content at `~/.pando/projects/{projectId}/` and `copyWorkspaceToAppDir()` copies it to hosted-apps. Auto-recovery: if workspace is empty but project has `repoUrl` in ProjectStore, `ensureProjectWorkspace()` auto-clones from GitHub via `git init → fetch → checkout`. The `repoUrl` field is optional in app registration (POST /apps).

#### Standalone PandoTeams (direct, not through the network)

```
Developer opens PandoTeams directly on their machine
  → Builds app locally (their keys, their machine)
  → When ready: submits project to Pando ecosystem
  → Governance review (live mode — all 6 layers)
  → If approved: project published on the network
  → Other nodes can discover, deploy, fork it
```

This is a separate entry point. Not through the gateway. Developer uses PandoTeams as a product, then optionally publishes to the network.

### 5.2 Multi-Project Engine Management

```
Engine Adapter manages: Map<string, PandoTeams>

  "system"     → System Engine (always running)
                  Manages pando-node itself.
                  Governance review on demand.
                  Periodic: observer checks, QA runs.

  "proj-abc"   → Project Engine (bakery website)
                  Created when user started chat about this project.
                  Evicted after 30 min idle.

  "proj-def"   → Project Engine (marketplace app)
                  Another user's project.
                  Independent board + memory.

  "proj-ghi"   → Project Engine (any other project)
                  Created on demand, evicted when idle.

Each engine:
  - Has its own Board (tasks, goals, status, user bug reports)
  - Has its own MemoryStore (lessons, reflections)
  - Has its own sub-agents (builder, tester, explorer)
  - Has Pando tools registered (calls node HTTP API)
  - Is a STANDARD pando-teams engine instance
  - Doesn't know about other engines
  - Doesn't know it's inside pando-node

  "observer"   → Council Observer (network health, read-only)
  "qa"         → Council QA (health checks, testing)
  "council"    → Council Lead (triage, delegation, governance)
                  These three share a DB for cross-engine messaging.
                  See Section 5.10 for full council architecture.
```

**Routing rule:**
- `POST /v1/chat/message { projectId: "proj-abc" }` → route to the PandoTeams peer that owns this project's engine
- `POST /v1/chat/message { no projectId }` → Doorman classifies → Path A (question) or Path B (build) or report (board task on target project)
- `POST /v1/council/request` → create board task on the council board (bug report, feature request)

**Hub Auto mode (client-side tier routing):** The hub chat page (`packages/hub/app/chat/page.tsx`) has 4 tiers: Quick (keyword, free), Smart (AI, ~$0.001), Full (Claude Code, $0.50-5), Auto (adaptive). In Auto mode, messages are encrypted before sending, so the backend doorman receives ciphertext and cannot classify intent. The hub therefore does **client-side intent detection before encryption**: build/create intent → `tier=complex` (Full), explanatory questions (what is/how does/explain) → `tier=medium` (Smart), everything else → tier unset (backend handles status/balance/simple queries via keyword matching). Without this, all encrypted messages in Auto mode would default to Quick tier.

**See Section 5.10 for the universal project pattern** — every project (including council) uses the same board-as-queue, scheduler tick, agent team architecture.

### 5.3 Standalone pando-teams vs Inside pando-node

```
STANDALONE pando-teams              PANDO-NODE pando-teams
(any dev, any project)             (inside the network)

  20+ built-in tools                 20+ built-in tools       IDENTICAL
  Board                              Board                    IDENTICAL
  Memory                             Memory                   IDENTICAL
  Sub-agents                         Sub-agents               IDENTICAL
  FrameBuilder                       FrameBuilder             IDENTICAL
  Guardrails                         Guardrails               IDENTICAL

  Budget: USD                        Budget: Lux              DIFFERENT
  (pays Anthropic)                   (network economy)

  Extra tools: none                  Extra tools:             DIFFERENT
                                     + pando_deploy
                                     + pando_transfer
                                     + pando_propose
                                     + pando_peers
                                     + pando_status
                                     + pando_create_project
                                     + pando_test_run
                                     + ...etc

  Network: NONE                      Network: P2P             DIFFERENT
                                     (via tools)
```

pando-teams doesn't import @pando/node. It just has extra tools registered. That's the ENTIRE difference.

**Two entry points for building:**
- **Through the network:** User → Gateway → any node → find PandoTeams peer → build. The network orchestrates.
- **Standalone:** Developer runs PandoTeams directly → builds locally → submits to Pando ecosystem via governance.

### 5.4 Governance Security Pipeline (6 layers + AI review)

```
Proposal arrives (diff + description)
  |
  v
Layer 1: Ed25519 signature check              DETERMINISTIC — blocks unsigned proposals
Layer 2: Security file check                   DETERMINISTIC — blocks if security files
                                                modified without "security"/"credential" in description
Layer 3: Diff content scan (dangerous patterns) DETERMINISTIC
  Blocking patterns: eval(), new Function()
  Warning patterns (logged, non-blocking): .privateKey access,
    process.env[] dynamic access, dynamic require(),
    fetch() in kernel files, writeFileSync() in kernel files
Layer 4: Build verification (npm run build)    DETERMINISTIC — blocks if build fails
  |
  v
Layer 5: AI REVIEW (ADVISORY ONLY — does NOT block)
  → governance.ts calls adapter.reviewDiff(diff, description)
  → Returns: { safe: boolean, risks: string[], recommendation: string }
  → If unsafe: logged as WARNING to governance_audit, but proposal continues
  → Rationale: deterministic checks (Layers 2-3) are the real gates;
    AI review adds signal but must not veto legitimate changes
  |
  v
Layer 6: Kernel protection delay (60s for kernel/ changes)
  → validateUpgradeProposal() returns { kernelDelay: true }
  → Caller applies setTimeout(60000) before marking proposal approved
  |
  v
DECISION: APPROVE or REJECT
  → logged to governance_audit table
  → if approved: broadcast via GossipSub
  → all nodes: git pull → npm install → build → restart
```

**IMPORTANT: `git diff HEAD~1 HEAD` (not `git diff HEAD~1`).** All diff commands in governance validation use the two-argument form to diff only committed changes. Without `HEAD` as the second arg, git diffs against the working tree — uncommitted files inflate the diff and cause false rejections.

**Security files list:** `credential-store.ts`, `credential-vault.ts`, `request-reply.ts`, `guardrails.ts`, `security-monitor.ts`, `governance.ts`, `upgrade-protocol.ts`, `payment-gate.ts`. Modifying any of these requires "security" or "credential" in the proposal description.

**Layer 5 (AI review) only runs on PandoTeams contributor nodes** (they have an engine to review with). On lightweight/secure nodes without PandoTeams, Layer 5 is skipped (fail-open). Layers 1-4 and 6 are deterministic and run everywhere.

**Quorum logic** (`getQuorum()` in governance.ts):
- 1 peer (solo): 1 vote passes
- 2-10 peers: max(2, ceil(peers × 0.5)) — 50% majority, minimum 2
- 11-100 peers: 5 fixed
- 101-1000 peers: 10 fixed
- 1000+ peers: ceil(peers × 0.05) — 5%

**Instant governance** when <10 total nodes: any single vote resolves (quorum=1). Speed over consensus during early growth.
**Early resolution**: if all known nodes voted but count < computed quorum, quorum is lowered to total nodes.
**governance_change** proposals require min(GOVERNANCE_CHANGE_MIN_VOTES=5, peerCount) votes.
All logged to `governance_audit` table.

### 5.5 Distributed Compute — Four Node Types

```
+─────────────────────────────────────────────────────────────────────+
│                        THE PANDO NETWORK                            │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐           │
│  │ PandoTeams    │   │ EC2 Secure   │   │ Lightweight  │           │
│  │ Contributor  │   │ Compute      │   │ Node         │           │
│  │              │   │              │   │              │           │
│  │ - PandoTeams  │   │ - MongoDB    │   │ - P2P only   │           │
│  │ - Local keys │   │ - Cred Store │   │ - Ledger     │           │
│  │ - Claude Code│   │ - Contrib'd  │   │ - Relay      │           │
│  │ - Earns Lux  │   │   API keys   │   │ - Relay fees │           │
│  │              │   │ - Earns Lux  │   │              │           │
│  │ BUILDS APPS  │   │ SIMPLE AI    │   │ ROUTES ONLY  │           │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘           │
│         │                  │                   │                    │
│         └──────── P2P (TCP + Noise) ───────────┘                   │
+─────────────────────────────────────────────────────────────────────+
```

#### Type 1: PandoTeams Contributor Node (the common case)

A regular user with PandoTeams installed. The backbone of network intelligence.

- Has PandoTeams + Engine Adapter
- Has their OWN API keys locally (PandoTeams `.env` or env vars — default: Google/Gemini)
- Keys **NEVER leave** the machine — work comes TO them
- Advertises capability: `pando-teams: true` in capability profile
- Network routes build jobs to them via HTTP (HttpPeerClient)
- Can set limits: max requests/day, budget caps, model preferences (NOT YET BUILT)
- Earns Lux per job completed (BUILT — `WorkType.COMPUTE_CONTRIBUTED`, daily cap: 50 jobs/day via `PANDO_DAILY_COMPUTE_CAP`)
- Claude Code CLI as persistent agent runtime (DONE — see Section 3.2.9)

```
Build request arrives via HTTP (routed by any node that received user's message)
  → Engine Adapter creates project engine
  → PandoTeams builds using LOCAL keys (contributor's configured provider)
  → Code committed to GitHub (checkpoint)
  → Deployed via pando_deploy tool
  → Earns Lux based on compute cost
```

#### Type 2: Secure Compute Node (EC2)

Trusted infrastructure. Stores network-level contributed credentials. **Deploys apps.**

- Has MongoDB + CredentialStore + CREDENTIAL_MASTER_KEY
- Stores contributed API keys (encrypted AES-256-GCM)
- Handles Path A (simple AI): decrypts contributed key → makes LLM call → returns response
- **Handles deployment** (`pando/deploy-app`): clones from GitHub, deploys to S3 (Tier 1) or PM2+nginx (Tier 2 — PM2 here manages deployed USER APPS, not pando-node itself)
- Could run PandoTeams for builds if installed (not currently — EC2 nodes are secure-only)
- Proxy: decrypts credentials for other node types on HTTP request (code_repository only)
- Proxy: HTTP storage backend for non-MongoDB nodes (thread store, project store, etc.)

**Capability profile broadcasts:** `credentialAccess: true`, `storageBackend: 'mongodb'`. These are the fields the deploy pipeline uses to find deploy targets — NOT `shareCompute`/`compute_cpu` (those identify PandoTeams builders).

#### Type 3: Lightweight Node

Minimal participant. P2P, ledger, governance. No AI compute.

- Routes AI work to peers who have PandoTeams or secure compute
- Earns relay fees (0.1% of transfers)
- Participates in governance voting
- Contributes to P2P mesh health

#### Type 4: Full Dev Node (Type 1 + local MongoDB)

Developer's machine. PandoTeams + local MongoDB for full self-sufficiency.

```
Routing priority for AI work:
1. Path A (questions): local OpenAI key → CredentialStore → EC2 proxy via HTTP
2. Path B (builds): find best PandoTeams peer on network (could be self) → route via HTTP
3. No capable peers available → degrade gracefully (canned doorman response)
```

### 5.6 Periodic Autonomous Behavior (PandoTeams contributor nodes only)

On nodes with PandoTeams, the Scheduler sends periodic "check" messages to the system engine. The engine decides what to do. Lightweight and secure-only nodes don't have engines and skip this entirely.

```
pando-node (body)                         pando-teams (brain)

  setInterval(5 min):
    adapter.send("system",               → System Engine receives
      "Periodic check. Run scheduled       → Decides what's needed:
       tasks if needed.")                    - Nothing? "All clear."
                                             - Time to audit? Spawns explorer sub-agent.
                                             - Time for QA? Spawns tester sub-agent.
                                             - Issue found? Spawns builder to fix.
                                             - Fix ready? Calls pando_propose tool.

  Events also trigger engine calls:
    New chat message    → adapter.send(projectId, message)
    Governance proposal → adapter.reviewDiff(diff)
    Test failure        → adapter.send("system", "Test failed: ...")
    Peer connected      → adapter.send("system", "New peer: X")
```

No tick loop. No orchestrator. No message bus. The engine runs when it has something to do.

### 5.7 The Actors (PandoTeams contributor nodes only)

**Per-project actors** (user projects — see Section 5.10 for the universal pattern):

| Actor | How it works | Triggered by |
|---|---|---|
| **Project Engine** | Per-project engine instance. Handles chat, builds, deploys. Board receives user bug reports and feature requests. | Chat messages, scheduler tick, user requests |
| **Builder** | Builder sub-agent spawned by project engine. Full tools. Writes code, runs builds. | When work is needed |
| **Governance** | Deterministic code in kernel/governance.ts. NOT an AI agent. Calls engine for AI review only. | On proposal arrival |

**System actors** (ecosystem maintenance — council is just Project Zero, see Section 5.10):

| Actor | How it works | Triggered by |
|---|---|---|
| **Team Lead** | Long-running engine. Reads inbox + board snapshot, acts on issues + user requests, spawns builders, deploys through governance (`/v1/infra/commit-and-propose`). | Scheduler tick (every 15 min) |
| **Observer** | Long-running engine. Read-only. Monitors network health, peer status. Sends issues to lead via send_message. | Scheduler tick (every 60 min) |
| **QA** | Long-running engine. Runs health checks, API validation. Sends findings to lead via send_message. | Scheduler tick (every 120 min) |

### 5.8 App Lifecycle (AppManager) — Unified Pipeline

**Everything is an app.** pando-node, pando-teams, and user apps all run through the same AppManager pipeline. SQLite `apps.db` is the single source of truth per node. See `docs/UNIFIED-PIPELINE-ROADMAP.md` for the full roadmap.

#### 5.8.1 The Unified Pipeline

One pipeline for all code on the network:

```
credential resolve → git pull → npm install → build → health check → deploy
```

Governance is a gate BEFORE the pipeline, not a separate pipeline. If `app.governance === true`, an approved governance proposal is required before the pipeline runs. If `false`, the pipeline runs immediately.

**Three tiers:**

| Tier | Type | Deploy Action | Examples |
|---|---|---|---|
| 1 | Static | S3 upload (or local serve fallback) | Portfolio sites, landing pages, chat-built apps |
| 2 | Server | PM2 start + nginx reverse proxy | Express apps, WebSocket servers |
| 3 | Infrastructure | exit(75) → node restart | pando-node, pando-teams |

**Infrastructure as apps (IMPLEMENTED — Phase 2).** On node startup, `index.ts` registers pando-node and pando-teams as tier 3 apps:

```
pando-node:  tier 3, governance: true,  deployAction: 'restart-node'
pando-teams:  tier 3, governance: true,  deployAction: 'restart-node'
```

`GET /v1/apps` shows infrastructure alongside user apps. Same registry. Same history table. Same API.

**App schema fields (added in Phase 2):**
- `tier: 1 | 2 | 3` — deployment strategy
- `governance: boolean` — whether updates require governance approval before pipeline runs
- `deployAction: 'pm2' | 'restart-node'` — PM2 process management or exit(75) for launcher restart

```
App Lifecycle Flow
──────────────────

REGISTER → DEPLOY → UPDATE → MONITOR
   │          │        │         │
   │          │        │         └─ 30s health checks, auto-restart, circuit breaker
   │          │        │
   │          │        └─ [governance gate if app.governance] → credential resolve → git pull → blue-green swap:
   │          │             1. Start new instance on temp port
   │          │             2. Health check new instance
   │          │             3. Swap nginx upstream (Tier 2) or exit 75 (Tier 3)
   │          │             4. Graceful kill old instance
   │          │             5. Record in app_history
   │          │
   │          └─ Clone from GitHub OR copy workspace → detect tier → deploy:
   │               Tier 1 (static): S3 upload (via contributed ResourceRegistry creds)
   │                                 OR local serve fallback: GET /v1/apps/:id/serve/*
   │               Tier 2 (server): npm install → PM2 start → nginx reverse proxy
   │               Tier 3 (infra):  npm install → build → exit(75) → restart
   │
   └─ appManager.register({ projectId, repoUrl, tier, governance, deployAction, ... })
       Auto-register: if update() called for unknown app, auto-registers from ProjectStore

ROLLBACK: restore previous_commit → blue-green swap back → record in history

P2P DISPATCH: findDeployTarget() → CapabilityRegistry (credentialAccess + mongodb)
              → HttpPeerClient forwards deploy/update to EC2 secure node
              NOTE: Workspace-only apps (no repo_url) ALWAYS deploy locally — remote
              nodes can't access local workspace files. Guard: `if (!host_peer_id && repo_url)`

LOCAL SERVE FALLBACK (Tier 1, no S3):
  When S3 credentials not contributed, Tier 1 deploys serve from local node:
  - Files in ~/.pando/hosted-apps/{appId}/
  - Served via GET /v1/apps/:id/serve/* with proper MIME types
  - deploy_url = http://localhost:{port}/v1/apps/{id}/serve/index.html
  - Path traversal protection, public/ dir preference, 1h cache headers
```

#### 5.8.2 Unified Git Operations (ALL PHASES COMPLETE)

All git operations consolidated into a single `GitOps` class (`core/git-ops.ts`):

| Component | Uses GitOps? | Notes |
|---|---|---|
| **UpgradeProtocol** | ✅ | Governance gate + security + safe restart. All git via `this.git` (GitOps instance). |
| **DeployManager** | ✅ | PatchSet commit/revert. All git via `this.git` (GitOps instance). |
| **AppManager** | ✅ | Creates `new GitOps(appDir)` per operation for user app deploys. |
| **CodePipeline** | ✅ | Uses GitOps for `diffNameOnly()`, `diffCachedNameOnly()`, `show()`. |
| **core-api.ts** | ✅ | `/upgrade/now` and `/upgrade/diagnose` use GitOps. |
| **init-platform.ts** | ✅ | P2P upgrade handler uses GitOps. |
| **init-kernel.ts** | ✅ | Running commit detection uses GitOps. |
| **tui.ts** | ✅ | Manual upgrade uses `GitOps.stashAndReset()`. |
| **governance.ts** | ✅ | `scanDiffForDangerousPatterns()` and `validateUpgradeProposal()` use GitOps. |
| **guardrails.ts** | ✅ | Auto-rollback uses `GitOps.checkoutAll()`. |
| **platform-api.ts** | ✅ | `/github/push` endpoint uses GitOps for init, add, commit, remote, push. |
| **engine-adapter.ts** | ✅ | `pando_workspace` tool + project workspace recovery use GitOps. |
| **index.ts (PandoNode)** | ✅ | Project clone, git init, commit callback all use GitOps. |

**Also completed:**
- **GitHubClient** (`core/github-client.ts`): GitHub API for autonomous repo creation (createRepo, deleteRepo, repoExists)
- **safeGitReset** removed from UpgradeProtocol — replaced by `GitOps.stashAndReset()`
- **safeGitRef/safeCommitHash** validators exported from `git-ops.ts` (single source of truth)
- All `execSync('git ...')` template-literal calls eliminated — only `execFileSync` via GitOps
- **Zero git operations exist outside `git-ops.ts`** — every file (governance, guardrails, engine-adapter, platform-api, index.ts) migrated
- **`GitOps.cloneSync()`** — static synchronous clone for callers that don't need credential resolution (used by AppManager, engine-adapter)

**PROVEN LIVE (2026-03-06) — BOTH TIERS:**

**Tier 1 (S3 static):** "build me a portfolio website" → PandoTeams (Gemini 2.5 Flash) built index.html + style.css → GitHub push → EC2 cloned → Tier 1 detected → S3 upload with gateway vars injected → live at `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/{projectId}/index.html` → marketplace listing with `deploymentStatus: live`.

**Tier 2 (PM2+nginx):** "build me a real-time chat room app with WebSockets" → PandoTeams built Express+ws server → GitHub push → EC2 cloned → Tier 2 detected (express+ws deps, scripts.start) → `npm install` (66 modules) → PM2 start on port 3009 → nginx reverse proxy config written → live at `http://3.226.89.40/apps/{projectId}/` → HTTP 200, WebSocket upgrade working through nginx.

**CRITICAL: Builder vs Deployer targeting (the #1 gotcha)**
```
findBestBuilder()              → shareCompute === true && compute_cpu === true   → PandoTeams CONTRIBUTOR nodes
appManager.findDeployTarget()  → credentialAccess === true && storageBackend === 'mongodb'  → EC2 SECURE nodes

These are DIFFERENT node types. Builders BUILD. Deployers DEPLOY. Never confuse them.
```

**Security model:**
- **Credentials (AWS S3, GitHub) ONLY exist on EC2 secure nodes** — decrypted in-memory via `CREDENTIAL_MASTER_KEY`
- **PandoTeams contributor nodes NEVER touch deployment credentials** — they only build code
- **GitHub is the handoff point** — PandoTeams pushes code to GitHub, EC2 clones from GitHub. No workspace transfer over HTTP.
- **EC2 tripwire** — any SSH/SSM/debugger detected → wipe credentials + shutdown immediately

**Workspace directories:**
- Engine workspace: `~/.pando/projects/{projectId}/` (set by platform-api.ts after project creation)
- EC2 deploy workspace: `{dataDir}/hosted-apps/{projectId}/` (cloned from GitHub on the secure node)
- PandoTeams database: `.pando-teams.db` inside the project workspace

**Timeout chain (production-tuned):**
- HTTP credential proxy: 30s (decrypting GitHub token via EC2)
- GitHub repo creation inner call: 45s (includes credential decrypt + GitHub API)
- AppManager GitHub push: 120s (AbortSignal.timeout)
- HTTP deploy request: 300s (5 min — includes git clone + S3 upload or npm install + PM2)

**Health monitoring (Tier 2 apps):**
- 30s interval health checks (HTTP GET to app port)
- Auto-restart on failure (up to `max_restarts` threshold)
- Circuit breaker: if app fails repeatedly, marked `error` — no further restart attempts until manual intervention or rollback
- All health events recorded in `app_history` table

**Deploy result push (DONE — commit e6fe16b1):**

Deploy result is now AWAITED (not fire-and-forget). After PandoTeams finishes building:
```
Build completes → appMgr.update(projectId) awaited
  ├─ SUCCESS:
  │   → Deploy message pushed to chat thread via threadStore.addMessage()
  │   → SSE event `app_deployed` pushed: { threadId, projectId, deployUrl, port, status: 'live' }
  │
  └─ FAILURE:
      → Failure message pushed to chat thread via threadStore.addMessage()
      → SSE event `app_deploy_status` pushed: { threadId, projectId, status: 'failed', error }
```

**Marketplace enrichment (DONE — commit e6fe16b1):**

`GET /v1/marketplace` enriches project listings with AppManager deployment data. Each project gets a `deployment` object:
```json
{ "status": "live", "url": "http://...", "port": 3009, "tier": 1, "commit": "abc123", "deployedAt": 1741... }
```
`GET /v1/marketplace/:id` also includes deployment data. This connects the marketplace to live deployment state — users see which projects are deployed and where.

**Marketplace visibility:**
- New projects start with `visibility: 'listed'`
- Marketplace endpoint (`GET /v1/marketplace`) filters out test artifacts via regex:
  `hello world`, `test app`, `untitled`, `my app`, `demo`, `example`, `placeholder`, etc.
- Use a real project name to see it in the marketplace. "hello world" is intentionally filtered.
- 128+ projects visible in marketplace as of 2026-03-06.

**Where app lifecycle code lives:**
| Component | File | What it does |
|---|---|---|
| **AppManager** | `core/app-manager.ts` | Unified lifecycle: register, deploy, update (blue-green), rollback, health monitoring, P2P dispatch, SQLite registry |
| **App API** | `api/app-api.ts` | REST endpoints: /v1/apps/* (12 routes) — register, list, get, deploy, update, rollback, stop, start, delete, health, history, logs |
| **Trigger** | `api/platform-api.ts` | `appManager.update(projectId)` awaited after build completion — result pushed to chat thread + SSE |
| **Deploy handler** | `core/app-manager.ts` (internal) | Clone from GitHub, detect tier, deploy to S3 or PM2+nginx |
| **Port registry** | `apps.db` (SQLite) | Persistent port allocation — per-app row in `apps` table |
| **GitHub push** | `api/platform-api.ts` | git add -A, commit, force push to origin/main |
| **GitHub repo create** | `api/platform-api.ts` | GitHub API — create repo in pando-lux org |

**S3 bucket:** `pando-deployments` (us-east-1). URL pattern: `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/{projectId}/index.html`

**Contributed S3 credentials format** (via `/contribute storage_blob <json>`):
```json
{ "accessKeyId": "...", "secretAccessKey": "...", "region": "us-east-1", "bucket": "pando-deployments" }
```

**Security hardening (commit fb119513):**

All shell command execution in app-manager.ts uses `execFileSync()` with array arguments — no string interpolation, no shell injection possible. Specifically:
- PM2 commands: `execFileSync('pm2', ['start', mainFile, '--name', pm2Name], opts)` — not `execSync(\`pm2 start ${mainFile}\`)`
- Env vars: passed via `env` option on the spawn options object — not concatenated into command string
- App IDs: validated with `/^[a-zA-Z0-9_-]+$/` regex before use in any file path or command
- Workspace paths: `path.relative()` guard prevents path traversal via crafted appId
- PM2 logs endpoint (app-api.ts): uses `execFileSync('pm2', ['logs', ...])` with SAFE_ID validation and lines clamping (1-10000)

**Input validation hardening (commit 74249c43):**
- All `query.limit` params capped at 200 across 13 API endpoints (core-api, kernel-api, platform-api, app-api, testing-api)
- Team creation: id max 100 chars, displayName max 200 chars, description max 2000 chars
- Agent spawn: templateId type-validated as string
- Chat balance/status: now uses authenticated user's peerId, not node operator's
- Thread messages: 404 on non-existent thread IDs (was auto-creating)
- P2P sync: 7 unhandled promise rejections now caught and logged

### 5.9 PandoTeams Network Linking

PandoTeams works as a standalone developer tool (like Claude Code). Optionally, it links to the Pando network.

```
STANDALONE MODE (default)                LINKED MODE (network contributor)
─────────────────────────                ─────────────────────────────────
PandoTeams is just a dev tool.            PandoTeams is a network resource.

- Projects saved wherever you want       - Network workspace: ~/.pando/projects/
- Your keys, your machine                - Node can CREATE projects here
- No P2P, no Lux, no governance          - Each project: ~/.pando/projects/{projectId}/
- Works offline                          - Project metadata from node (visibility, owner)
- No connection to any node              - You earn Lux per build job completed
                                         - API usage limits apply (future)
                                         - Private projects → visible only to owner
                                         - Public projects → marketplace + GitHub
```

**How linking works:**
1. PandoTeams setting: `network.linked: true` (in PandoTeams config)
2. PandoTeams setting: `network.nodeUrl: "http://localhost:4000"` (local node API)
3. When linked, node's Engine Adapter can create project engines
4. Network-created projects go to `~/.pando/projects/{projectId}/`
5. Project metadata (visibility, owner) set by node based on user request
6. When build completes → AppManager.update() triggers (GitHub → deploy → marketplace)

**BUILT.** Engine Adapter creates `~/.pando/projects/{id}/` directories with `PANDO_PROJECT.json` metadata (nodeUrl, nodeId, projectId, linked flag). PandoTeams detects this on config load via `detectNetworkLinking()` in `config/index.ts` — scans project path + `~/.pando/projects/` for linked metadata. Exposes `GET /api/network` (PandoTeams server) and `GET /v1/network` (Hono API) for clients to check linking status.

### 5.10 Team Architecture — Unified Project Management

> **Full details:** `docs/TEAM-ARCHITECTURE.md` is the implementation reference. This section is the architectural overview.

> **Status:** APPROVED ARCHITECTURE. Legacy council code (hardcoded 3-agent, `/v1/council/*` endpoints) being migrated to this. The new architecture is THE target — do NOT build on the old council code.

**Every project on Pando is managed by a team.** The pando-infra team (formerly "council") and user project teams use the SAME infrastructure. There is no special council framework.

**CRITICAL RULE: Never build agent/communication/task systems in pando-node. PandoTeams already has them. See Section 3.2.**

#### 5.10.1 The Pattern

```
┌─────────────────────────────────────────────────────────────────────┐
│             EVERY TEAM USES THIS PATTERN                            │
│                                                                     │
│  PandoTeams Engine (one per agent in the team)                      │
│  ├─ Board ← THE work queue (user requests, bugs, system issues)    │
│  ├─ Agents ← the team (lead + others spawned on demand)           │
│  ├─ Memory ← learns across sessions (persistent)                  │
│  ├─ Scheduler tick ← periodic wake-up                              │
│  └─ pando_* tools ← network operations                            │
│                                                                     │
│  pando-infra = this pattern + observer + QA + ALL pando_* tools    │
│  user project = this pattern + 1 lead agent + pando_deploy         │
│  Same board. Same agents. Same scheduler. Same code path.          │
│  Only difference: governanceRequired flag (per-team)               │
└─────────────────────────────────────────────────────────────────────┘
```

#### 5.10.2 Three-Layer Data Separation (Critical for Scale)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     DATA SEPARATION                                 │
├─────────────────────────────┬───────────────────────────────────────┤
│ LAYER 1: Team Registry      │ LAYER 2: Board + Agent State          │
│ (~/.pando/teams/teams.db)   │ (~/.pando/teams/{teamId}/.pando-teams.db)│
│                             │                                       │
│ WHAT: routing metadata      │ WHAT: application state               │
│  - team id, name            │  - board tasks (title, status)        │
│  - managing node (peerId)   │  - agent messages (inbox)             │
│  - heartbeat (alive?)       │  - sessions, memory                   │
│  - repos managed            │                                       │
│  - agent count              │ WHERE: managing node ONLY             │
│  - governance flag           │ ACCESS: HTTP request on demand         │
│                             │ BACKUP: .pando/team-state.json in repo│
│ WHERE: ALL nodes (synced)   │ SYNC: NONE (local only)              │
│ SYNC: GossipSub pando/teams │                                       │
│ SIZE: ~200 bytes per team   │ SIZE: unbounded (stays local)         │
└─────────────────────────────┴───────────────────────────────────────┘

LAYER 3: Git Repo (.pando/team-state.json)
  - Committed alongside code changes by the managing agent
  - Contains: active tasks, recent completed tasks, team context
  - On handoff: new node reads this from repo to seed board
  - On node death: this is the durable backup (git survives everything)
```

**Why NOT sync boards via P2P?** At scale (1000 teams, 50 tasks each, updating), board sync would flood the network with thousands of messages. The registry-only approach means P2P carries ~200 bytes per team. Board data stays local and is accessed on-demand via HTTP (point-to-point, Ed25519-signed).

#### 5.10.3 Team Registry

New file: `core/team-registry.ts`. SQLite DB at `~/.pando/teams/teams.db`.

```sql
CREATE TABLE team_config (
  id TEXT PRIMARY KEY,              -- "pando-infra", "team-a1b2c3"
  display_name TEXT NOT NULL,
  managing_node TEXT,               -- peerId of node running this team
  last_heartbeat INTEGER,           -- timestamp ms
  status TEXT DEFAULT 'active',     -- active | orphaned
  repos TEXT NOT NULL DEFAULT '[]', -- JSON array: ["pando-lux/node"]
  agent_count INTEGER DEFAULT 1,
  governance_required INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT,                  -- peerId
  claimed_at INTEGER                -- for race condition resolution
);
```

**No board tables. No message tables.** Board and messages live in PandoTeams's local SQLite on the managing node. This is the key architectural decision that prevents P2P data flooding at scale.

**Duplicate handling:** `createTeam()` checks for existing team before INSERT. If a team with the same ID exists (e.g., synced via P2P before local creation), it updates the existing record instead of throwing a UNIQUE constraint error. This is critical for user project teams where the team may already be synced from the network before the local node registers it.

**GossipSub sync:** Topic `pando/teams`. Mirrors LedgerSync pattern — subscribeTopic on startup, requestSync on peer connect (5s + 30s retry), dedup by processed IDs. Three message types: `team_config_update`, `team_sync_request`, `team_sync_response`.

**Heartbeat:** Piggybacks on team tick. Every agent tick updates `last_heartbeat` in local DB and publishes `team_config_update`. Batched per node (one message per node per 15min listing all teams), NOT per-team.

#### 5.10.4 Governance: One Flow, One Gate

Every team uses the SAME flow. The only difference is a single boolean flag:

```
governanceRequired: boolean (per-team, stored in team_config)

  true  → code changes go through governance proposal → vote/auto-approve → upgrade
  false → code changes deploy directly via pando_deploy

Currently:
  pando-infra: true  (ecosystem repos need governance)
  user projects: false (direct deploy)

Future:
  The pando-infra lead may decide that complex user projects also need governance
  (e.g., projects with 10+ contributors, or projects others depend on).
  This is just: PATCH /v1/teams/:teamId { governanceRequired: true }
  No code change needed — the flow is already the same.
```

**Security note:** The governance flag is a WORKFLOW HINT. The real security boundary is in `upgrade-protocol.ts` — it verifies commit hashes against governance-approved proposals. Even if someone hacks the flag, the upgrade pipeline still validates everything.

#### 5.10.5 User Requests Flow Through Teams

```
User message arrives at POST /v1/chat/message
  │
  ├─ Doorman classifies intent:
  │   "simple"   → instant answer (status, balance, help)
  │   "question" → AI answer (existing)
  │   "build"    → create new project + team (Section 5.10.6)
  │   "report"   → bug/feature → route to team managing the target project
  │
  ├─ "report" intent routing:
  │   1. Check team registry: which team manages this project?
  │   2. Is managingNode == self?
  │      YES → add task to local board
  │      NO  → HTTP request to managing node
  │   3. If managing node offline → team handoff (Section 5.10.9)
  │
  └─ Board task created on managing node:
      [BUG:user] Exchange app login crashes on mobile
      [FEATURE:user] Add dark mode to gateway

Severity classification (automatic, regex with word variants):
  - crash(es|ed|ing), critical, down, outage, broken, bug, error, fail(s|ed|ing) → [BUG:user]
  - everything else → [FEATURE:user]

Validation:
  1. Min 5 chars, max 500 chars
  2. Board task dedup: exact title match on pending/in_progress
  3. Rate limit: 3 requests/hour per IP
  4. Two Laws filter at API + storage (defense-in-depth)
```

#### 5.10.6 Team Lifecycle Flows

**New user project — "Build me a todo app":**
```
1. User → gateway → any pando node
2. Doorman classifies: "build" intent
3. findBestBuilder() → PandoTeams-capable node (shareCompute + compute_cpu)
4. Builder node:
   a. Creates project in ProjectStore (business metadata)
   b. Creates team in team registry:
      { id: "team-xxx", repos: [], agentCount: 1, governanceRequired: false }
   c. Broadcasts team_config_update via GossipSub → all nodes learn routing
   d. Spawns PandoTeams engine for lead agent
   e. Lead builds the app, triggers deploy
5. Team stays active for future updates
6. Follow-up messages in the same thread route back to the same team/lead (workspace continuity)
```

**Universal Lead Prompt (Phase D):** User project leads use `makeUniversalLeadPrompt()` (engine-adapter.ts) which defines a 5-phase workflow:
1. **Understand** — Analyze the request, identify requirements
2. **Plan** — For complex projects, create board subtasks (`pando_board_update`)
3. **Build** — Write code, create files in `~/.pando/projects/{projectId}/`
4. **Verify** — Test the build, check for errors
5. **Deliver** — Report results with feature list, file paths, usage instructions

For simple tasks (single-file HTML apps), the lead may collapse phases 2 and 4. For complex multi-service projects (e.g., Express API + React frontend), all 5 phases execute including board subtask creation.

**Real-time streaming:** During build, each stream chunk from the engine emits a `chat_progress` SSE event via `deps.pushEvent()`. The hub accumulates these and shows "Agent working..." with live progress text. The final result arrives as a `chat_message` event with full markdown rendering and an expandable "Activity (N steps)" log.

**Pando infrastructure — bug report:**
```
1. User → gateway: "wallet shows wrong balance"
2. Node checks team registry: team "pando-infra" manages pando-lux/node
3. Routes to managing node (HTTP request or local)
4. Lead reads board → spawns builder → fix → governance propose → upgrade
5. All nodes: pullAndUpgrade → build → safe restart (exit 75)
```

#### 5.10.7 Team Bootstrap (First Run)

```
Node starts with PandoTeams available:

  1. Initialize TeamRegistry (teams.db)
  2. Sync from peers (GossipSub catch-up)
  3. Wait 10s (TEAM_SYNC_WAIT_MS) — anti-split-brain delay.
     Without this, two PandoTeams nodes starting simultaneously both
     create pando-infra independently. The delay lets team_sync_response
     arrive so we know if another node already manages the team.
  4. Check: does team "pando-infra" exist in registry?

     NO (first node ever):
       Create with seed config:
         id: "pando-infra"
         displayName: "Pando Infrastructure"
         repos: ["pando-lux/node", "pando-lux/code"]
         agentCount: 4
         governanceRequired: true
       Spawn team locally

     YES, but managingNode is offline (stale heartbeat + not in peer list):
       Claim it (Section 5.10.9)

     YES, and managingNode is online:
       Do nothing — someone else runs it

  5. For each team where managingNode == self:
     a. Create PandoTeams workspace: ~/.pando/teams/{teamId}/
     b. If repo has .pando/team-state.json → read it, seed local board
     c. Create PandoTeams engines per agent config (stored locally, not in registry)
     d. Register pando_* tools on each engine
     e. Register scheduler ticks per agent's tickIntervalMs
     f. Start heartbeat (update registry + broadcast every tick)
```

**Seed config for pando-infra (4 agents):**
```
Lead     — role: lead,     tick: 15min,  ALL pando_* tools
Observer — role: explorer, tick: 60min,  read-only pando_* tools
QA       — role: tester,   tick: 120min, pando_status + pando_test_run
Explorer — role: tester,   tick: 180min, UI/UX exploration
```

Agent configs are stored LOCALLY on the managing node (not in the P2P registry). The registry only knows `agentCount: 4`.

#### 5.10.8 Code Fixes via Workspaces

Any team lead can fix code via workspaces:

```
Lead detects issue → needs a code fix:
  1. Call pando_workspace({ repo: "pando-lux/node" })
     → returns { path: "~/.pando/workspaces/node" } (local or cloned)
  2. Call spawn_agent({
       role: "builder",
       task: "Fix the bug...",
       working_directory: path from step 1
     })
  3. Builder works in that directory (read, edit, bash, test)
  4. Builder returns summary + files changed
  5. Lead reviews:
     if team.governanceRequired → pando_governance_propose (ecosystem repos)
     else → pando_deploy (user projects, direct deploy)
  6. Lead marks board task done
```

**Key primitives (BOTH BUILT AND VERIFIED):**
- `spawn_agent({ working_directory })` — PandoTeams enhancement. Sub-agent works in a different directory than parent.
- `pando_workspace({ repo })` — pando-node tool. Clones/pulls any repo. Detects local repos without network.

#### 5.10.9 Node Death + Team Handoff

```
Node A was running team "pando-infra". Node A goes offline.

DETECTION (three paths):
  Path A — New request arrives, managingNode offline + heartbeat stale (>20min)
  Path B — Periodic orphan scan (every 5min on PandoTeams nodes)
  Path C — P2P peer disconnect event → wait 5min → claim if still offline

CLAIMING:
  1. Atomic update in local registry: managingNode = self, claimedAt = now
  2. Broadcast team_config_update with new managingNode
  3. Race condition: two nodes claim simultaneously → latest claimedAt wins, loser backs off
  4. Spawn team per Section 5.10.7 step 4

BOARD RECOVERY (three sources, in priority order):
  1. HTTP peer cache (best effort — peers may have cached board from previous queries)
  2. Git repo: clone/pull → read .pando/team-state.json (always available)
  3. Fresh start: empty board, lead reads repo state from commit history
```

#### 5.10.10 Resilience and Graceful Degradation (Phase 6.2)

**DB corruption recovery (team-registry.ts):** On `TeamRegistry` construction, `PRAGMA integrity_check` runs against `teams.db`. If the check fails, the DB files (+ WAL/SHM) are deleted and recreated fresh. Team metadata repopulates from P2P sync within seconds. The node never crashes from a corrupted team DB.

**Stale CLI session cleanup (engine-adapter.ts):** Saved Claude Code CLI session IDs (`cli-session:*` in state table) have a 24-hour TTL. On `startTeam()`, sessions older than 24h are discarded and deleted from the DB. Agents start fresh instead of hanging on dead sessions.

**Dead engine detection (engine-adapter.ts):** Lead agent tick handlers track consecutive failures. After 3 consecutive tick failures or a fatal error pattern (`ENOENT`, `spawn`, `session expired`, `process exit`), a `CRITICAL` log is emitted and the watchdog triggers an immediate restart attempt.

**Engine watchdog (engine-adapter.ts):** `startWatchdog()` runs every 30 seconds. For each active team engine, checks `pool.has()` — if the engine is dead (crashed, idle-evicted, TTL expired), restarts it via `pool.getOrCreate()`. Circuit breaker: after 5 restarts within 1 hour for the same engine, the watchdog gives up to prevent restart loops. Tick failures trigger immediate watchdog checks instead of waiting for the next 30s interval. Timer is unref'd so it doesn't block graceful shutdown. Commit 79b201e8.

**What's NOT yet implemented:**
- **Board state replication** — when a team migrates to a new node, board tasks stay on the old node. The `team-state.json` git backup is the designed recovery path but is not yet wired.
- **Cross-node claiming conflict resolution** — the atomic UPDATE handles basic races, but there's no notification when a claim is overridden.

#### 5.10.11 System Prompts and Engine Details

Each agent gets a system prompt via `agentOverride` on `engine.send()`. After Step 3 migration, prompts live in the Teams Server (`code/packages/server/src/prompts.ts`), resolved via `promptTemplate` field in agent config.

**Frame behavior with agentOverride:** The override replaces only the stable layer (L0-2). All dynamic layers still flow: knowledge (L3 — memories), situation (L5b — team awareness, budget), goals (L5), conversation history. Board is NOT in the frame (PandoTeams Option B) — pando-node injects it in the tick message instead.

**Board snapshot injection:** pando-node reads the board from the team's PandoTeams DB and includes it in the scheduler tick message. This is pando-node's responsibility (engine-adapter.ts), not PandoTeams's.

**Board snapshot format:** `getBoardSnapshot(dbPath)` returns a formatted string:
```
BOARD STATE (N active tasks):
  [status] Task title — Xh ago
  [status] Task title — Xd ago
```
Priority ordering: CRITICAL > BUG:user > WARNING > FEATURE:user > other. Limit 20 tasks.

**All agents use sendToTeamAgent() with custom setInterval** (commit `975b4f50`):
- **Lead agents** get dynamic inbox+board injection into every tick message. The lead tick reads `getTeamInbox()` + `getBoardSnapshot()` fresh and wraps the tick prompt with this live state data.
- **Non-lead agents** (observer, QA, explorer) also use `sendToTeamAgent()` with proper `agentOverride` for identity. Previously they used the PandoTeams Scheduler's `pool.send()` which didn't pass agent context, resulting in zero activity. Now all agents have timeout (10 min), concurrent execution guards, and error recovery with engine restart after 3 consecutive failures.

**Team inbox key structure:** Messages between agents are stored in the `.pando-teams.db` `state` table:
- Schema: `state(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, expires_at TEXT)` — NOTE: NO `engine_id` column (was a bug, fixed)
- Key: `msg:{toAgentId}:{uuid}`
- Value: JSON `{ from: agentId, message: string, timestamp: ISO8601 }`
- TTL: 1 hour (stored in `expires_at`)
- Consumed (deleted) on read by `getTeamInbox()`
- Also stores `cli-session:{agentId}` entries for session persistence across restarts
- HTTP API: `POST /v1/teams/:teamId/message` with `{from, to, message}` — used by Claude Code agents

**Engine lifecycle:**
```
Node startup with PandoTeams:
  │
  ├─ engine-adapter.ts start():
  │   ├─ Creates EnginePool (shared DB for cross-engine send_message)
  │   ├─ Injects Lux budget provider
  │   └─ Registers pando_* tool templates
  │
  ├─ For each team where managingNode == self:
  │   startTeam(teamId):
  │   ├─ For each agent in team config:
  │   │   ├─ pool.getOrCreate(agentId, { dbPath: teamDb })
  │   │   ├─ engine.startSession()  ← MUST be before tool re-registration
  │   │   ├─ Re-register cross-engine tools (check_agents, send_message, manage_tasks)
  │   │   ├─ INSERT agent profile into shared team DB
  │   │   └─ Register scheduler tick at configured interval
  │   └─ Start heartbeat broadcast
  │
  ├─ Project engines created on demand (outside teams):
  │   ├─ pool.getOrCreate(projectId, { projectPath })
  │   └─ Evicted after 30 min idle
  │
  └─ Node is running. Teams tick per config. Orphan scan every 5min.

GOTCHAS:
  1. EngineOptions does NOT accept systemPrompt — use agentOverride on send()
  2. Tool API base URL must be 127.0.0.1, not localhost
  3. All agents in a team must share the same SQLite DB for send_message to work
  4. CRITICAL: startSession() must be called BEFORE tool re-registration
  5. manage_tasks sessionId must reference a real session (FK constraint)
  6. Board is NOT in the frame (PandoTeams Option B) — inject in tick message
```

#### 5.10.12 API Endpoints

```
GET  /v1/teams                        — List all teams (from local registry)
GET  /v1/teams/:teamId                — Team config + status
GET  /v1/teams/:teamId/board          — Board tasks (local or HTTP proxy)
POST /v1/teams/:teamId/board          — Add task (local or HTTP proxy)
PATCH /v1/teams/:teamId/board/:taskId — Update task (local or HTTP proxy)
POST /v1/teams/:teamId/trigger        — Trigger team lead immediately
POST /v1/teams/:teamId/request        — Submit user request (adds to board)
PATCH /v1/teams/:teamId               — Update team config
POST /v1/teams                        — Create a new team (costs 1 Lux)
DELETE /v1/teams/:teamId              — Stop team, mark orphaned
GET  /v1/teams/:teamId/agents        — List agents in team
GET  /v1/teams/:teamId/cost          — Team cost breakdown (Lux + tokens)
GET  /v1/teams/:teamId/activity      — Last 20 messages + tool calls (?full=true for untruncated)
GET  /v1/teams/:teamId/agents/:agentId/messages — Agent message history (?limit=N)
```

All board endpoints follow the same pattern:
1. Check registry: is managing node == self?
2. YES → operate on local PandoTeams SQLite
3. NO → HTTP request to managing node

**Legacy endpoints** (`/v1/council/*`) have been removed. Use `/v1/teams/*` instead.

#### 5.10.13 What This Replaced

The following legacy code has been removed:
- `core/council-prompts.ts` — prompts moved to seed config constants in engine-adapter.ts
- `startCouncilAgents()` in engine-adapter.ts — replaced by generic `startTeam(teamId)`
- `isCouncilActive()`, `ensureCouncilStarted()`, `sendToCouncilAgent()` — replaced by `isTeamActive(teamId)`, `getActiveTeamIds()`, `triggerTeamAgentBackground(teamId, agentId, message)`
- `getCouncilBoard()`, `getCouncilInbox()`, `sendCouncilMessage()` — replaced by `getTeamBoard(teamId)`, `getTeamInbox(teamId, agentId)`, `sendTeamMessage(teamId, fromAgentId, toAgentId, message)`, `addTeamBoardTask(teamId, title, description?)`, `updateTeamBoardTask(teamId, taskId, updates)`
- `/v1/council/*` API endpoints — replaced by `/v1/teams/*`
- `config.enableCouncil` flag — renamed to `config.enableTeams`
- `--council` / `--no-council` CLI flags — removed

#### 5.10.14 Failure Modes & Recovery

| Failure | Recovery |
|---|---|
| Managing node dies | Handoff: another PandoTeams node claims team (Section 5.10.9). Board recovered from git. |
| Too many user requests | Board is the buffer. Rate limited: 3/hour per IP. Lead batches similar. |
| Bad/spam requests | Board task dedup. Rate limit. Two Laws filter. Lead deprioritizes low-value. |
| Team creates too many tasks | Lead closes stale tasks (>24h). Spawns parallel builders if backlog >10. |
| Bad code proposed | Governance Layer 5 (AI review). QA catches regressions post-deploy. |
| Two nodes claim same team | Race resolution: latest `claimedAt` wins, loser backs off. |
| Team spam (fake teams flooding registry) | Team creation costs 1 Lux. P2P only accepts heartbeats from `msg.from === team.managing_node`. |
| Board data poisoning | Board stays local (not synced via P2P). HTTP requests are Ed25519-signed. |

### 5.11 Service Architecture — Modular Plugin System

Pando-node is designed as a **lightweight, modular platform**. The core node handles P2P, ledger, identity, and governance. Optional services (like AI agents) plug in via npm packages.

#### The Service Interface

```typescript
// @pando/shared/types.ts — the contract all services implement
interface PandoService {
  readonly id: string;           // 'pando-teams', 'pando-exchange'
  readonly version: string;
  readonly capabilities: string[];
  start(ctx: ServiceContext): Promise<void>;
  stop(): Promise<void>;
  healthy(): boolean;
}

interface ServiceContext {
  peerId: string;                // this node's identity
  dataDir: string;               // persistent storage root
  apiPort: number;               // HTTP API port
  apiToken?: string;             // auth token
  registerRoutes(prefix: string, router: any): void;
  getCapability(name: string): any;
  resourceRegistry?: any;        // contributed API keys
  projectResolver?: (id: string) => Promise<{ repoUrl?: string; name?: string } | null>;
}
```

#### ServiceLoader (packages/node/src/core/service-loader.ts)

Auto-discovers installed npm packages and loads them as services:

```
SERVICE_PACKAGES = ['@pando-teams/core', /* future: '@pando/exchange', '@pando/storage' */]

for each package:
  try import(pkg) → call createService() → svc.start(ctx) → register
  catch → "not installed — skipping" (expected for light nodes)
```

**No config files.** If the npm package is installed, the service loads. If not, it's skipped.

#### How Operators Choose What to Run

```bash
# Light node (relay + validate only):
npm install && node cli.js              # default — no services

# AI node (adds PandoTeams):
npm install @pando-teams/core && node cli.js  # auto-detects, loads AI engine

# Future: DEX node:
npm install @pando/exchange && node cli.js
```

#### Integration with EngineAdapter

`createEngineService()` in engine-adapter.ts wraps the existing EngineAdapter as a PandoService. During the transition period, EngineAdapter starts directly via `startEngine()`. Eventually, ServiceLoader.loadAll() will handle everything.

#### Unified Pipeline

All projects (governance and non-governance, public and private) flow through the same pipeline:
- Same TeamRegistry, board system, agent templates, cost tracking
- `governanceRequired: true` → code changes go through voting
- `governanceRequired: false` → commits deploy directly
- Private projects skip P2P broadcast but use identical team/board infrastructure

See `docs/SERVICE-ARCHITECTURE-ROADMAP.md` for the full migration plan.

### 5.12 Pando Login (Agent Identity)

```
Human (Ed25519 keypair in ~/.pando/identity.json)
  | createAgent() → signs AgentCertificate
Agent (own Ed25519 keypair, own peerId = wallet)
  | POST /auth/challenge → nonce
  | sign(nonce, agentPrivateKey) → signature
  | POST /auth/verify → JWT (24h, stateless)
  | X-User-Token: <jwt> → authenticated API access
```

**Trust chain:** `verifySignedActionFull(action, humanPublicKey)` verifies: action signature (agent key) → certificate signature (human key) → expiry check. All offline.

### 5.13 Credential Security (IMMUTABLE LAW)

**Two credential models. Both are valid. Keys NEVER travel over the network.**

#### Model A: Contributed Credentials (for the network)

Used by Path A (simple AI) and git operations (via credential resolution). Contributor donates an API key or GitHub PAT for the network to use.

```
/contribute openai sk-xxx
  → AES-256-GCM encrypt → stored in MongoDB on EC2
  → EC2 decrypts and uses server-side
  → Contributor doesn't need to run a node
  → Key NEVER leaves EC2

/contribute github ghp_xxx
  → Same encryption path → stored in MongoDB
  → Used by resolveGitCredential() for all git clone/push ops
  → User-scoped: /contribute github ghp_xxx --user → user:{userId}/github
```

1. User runs `/contribute <service> <token>` in TUI
2. Encrypted → stored in MongoDB `pando_credentials` on secure compute nodes
3. `ResourceRegistry` stores metadata (type + status, NEVER the value)
4. At use time: EC2 node decrypts locally → makes API call → returns result

#### 5.13.1 Credential Resolution (IMPLEMENTED — Phase 1)

All git operations resolve credentials dynamically via `ResourceRegistry.resolveGitCredential(repoUrl, userId?)`. No more hardcoded PATs in git remote URLs.

```
resolveGitCredential(repoUrl, userId?)
  │
  ├─ 1. Find active code_repository resources in ResourceRegistry
  ├─ 2. If userId provided → look for user-scoped credential first (user:{userId}/github)
  ├─ 3. Fall back to any active code_repository credential on this node
  ├─ 4. Decrypt the PAT via getCredential(resourceId)
  └─ 5. Inject PAT into URL → https://x-access-token:TOKEN@github.com/owner/repo
       Returns authenticated URL or null if no credential available
```

**Who uses it:**
- `pando_workspace` tool (engine-adapter.ts) — cloning/pulling any repo for agent work
- All git clone/push operations in the unified pipeline (see Section 5.8)
- User-scoped credentials: users contribute their own PAT for private repos

**What it replaces:**
- ~~Hardcoded PATs in git remote URLs~~ — DEPRECATED. Use credential resolution instead.
- ~~Extracting PAT from `git remote get-url origin`~~ — DEPRECATED. The `pando_workspace` tool now calls `resolveGitCredential()`.

#### Model B: Local Credentials (PandoTeams contributor)

Used by Path B (builds). Contributor runs PandoTeams with their own keys.

```
Contributor's machine:
  PandoTeams's .env file (auto-loaded by engine-adapter)
  OR local env vars (GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY)
  OR Claude Code CLI authenticated (DONE — see Section 3.2.9)
  → PandoTeams uses local keys directly
  → Keys NEVER leave the machine
  → Work comes TO the contributor via HTTP
  → Contributor earns Lux for compute
```

No encryption, no MongoDB, no CredentialStore needed. The keys are in PandoTeams's `.env` file or local env vars on the contributor's own machine.

**IMMUTABLE RULES (both models):**
- NEVER transmit raw API keys over the network (P2P or HTTP)
- NEVER log, print, or output credential values
- NEVER store keys in docs, code, comments, agent reports
- Contributed keys: ONLY decrypted and used on EC2 (server-side)
- Local keys: ONLY used by local PandoTeams process
- NEVER hardcode PATs in git remote URLs — use `resolveGitCredential()`

---

## 6. THE ENGINE ADAPTER (detailed spec)

The engine adapter is `core/engine-adapter.ts`. It is the ONLY file in pando-node that imports @pando-teams/core. Currently ~636 lines (gutted from 2,774 in the BIBLE 1.7 migration). Team management, prompts, watchdog, and agent lifecycle were moved to Teams Server. It only exists on **PandoTeams contributor nodes** and **full dev nodes**.

**Key principle:** PandoTeams uses its OWN configured provider and model. The engine-adapter does NOT override the model. Contributors choose their provider (default: Google/gemini-2.5-flash).

**API key loading order** (`injectApiKeys()`):
1. Load PandoTeams's `.env` file (resolved via `@pando-teams/core` package path)
2. Check local env vars (contributor's shell environment)
3. CredentialStore fallback (EC2 nodes with MongoDB only)

```
PandoTeams reads: GOOGLE_GENERATIVE_AI_API_KEY  (default provider)
           OR:   ANTHROPIC_API_KEY, OPENAI_API_KEY (alternative providers)
           OR:   Claude Code CLI (persistent agent runtime — see Section 3.2.9)
```

### Class Interface

```typescript
class EngineAdapter {
  // Lifecycle
  async start(config: AdapterConfig): Promise<void>
  async shutdown(): Promise<void>

  // Message routing
  async *send(message: string, projectId?: string): AsyncGenerator<Event>
  async *sendToCouncilAgent(agentId: string, message: string): AsyncGenerator<Event>

  // Governance hook
  async reviewDiff(diff: string, description: string): Promise<ReviewResult>

  // Team board operations (generic — works for any team)
  getTeamBoard(teamId: string): any[]                    // Read pending/in_progress tasks
  addTeamBoardTask(teamId: string, title: string, description?: string): string | null  // Insert or dedup board task (returns existing ID if title matches pending task)
  updateTeamBoardTask(teamId: string, taskId: string, updates: object): void  // Update task status/progress

  // Team messaging
  getTeamInbox(teamId: string, agentId: string): any[]   // Read + consume messages for agent
  sendTeamMessage(teamId: string, fromAgentId: string, toAgentId: string, message: string): void  // Inter-agent message

  // Team status
  isTeamActive(teamId: string): boolean                  // True if team engines exist and are running
  getActiveTeamIds(): string[]                           // All teams currently running on this node
  triggerTeamAgentBackground(teamId: string, agentId: string, message: string): void  // Trigger agent tick immediately

  // Management
  get available(): boolean
  getActiveEngines(): EngineInfo[]
  hasEngine(projectId: string): boolean
  getSchedules(): ScheduleInfo[]
}
```

### Pando Tools (registered on each engine)

These tools call the node's own HTTP API. The engine doesn't import pando-node.

| Tool | What it does | HTTP call |
|---|---|---|
| `pando_status` | Node health, peers, uptime | GET /v1/status |
| `pando_peers` | List connected P2P peers | GET /v1/peers |
| `pando_capabilities` | Network capabilities | GET /v1/network/capabilities |
| `pando_balance` | Check Lux balance | GET /v1/balance/:peerId or GET /v1/wallet |
| `pando_transfer` | Send Lux to peer | POST /v1/transfer |
| `pando_deploy` | Deploy a project | POST /v1/apps/:id/deploy |
| `pando_undeploy` | Remove deployment | DELETE /v1/apps/:id |
| `pando_create_project` | Create a new project | POST /v1/projects |
| `pando_list_projects` | List all projects | GET /v1/projects |
| `pando_governance_propose` | Create upgrade proposal | POST /v1/governance/propose |
| `pando_governance_vote` | Vote on proposal | POST /v1/governance/vote |
| `pando_test_run` | Trigger test run | POST /v1/testing/run/scripted or POST /v1/testing/run/live |
| `pando_test_status` | Get test results | GET /v1/testing/status |
| `pando_workspace` | Get local workspace for any repo (clone/pull) | Local git ops |

### Lux Budget Provider

```typescript
LuxBudgetProvider {
  currency: 'lux';
  calculateCost(usage: { model, inputTokens, outputTokens }): number;
}
// 100 Lux per $1 USD of compute. Injected into every engine instance.
```

---

## 7. PANDO-TEAMS UPGRADES NEEDED

These are additions to @pando-teams/core (the separate repo). No refactoring — all new code.

### DONE (infrastructure built)

| Feature | File | Lines | Description |
|---|---|---|---|
| **EnginePool** | `pool/engine-pool.ts` | ~290 | Multi-engine management. Lazy creation, TTL eviction, lifecycle hooks (`onAfterCreate`), max limits, concurrent-safe locks. |
| **Scheduler** | `pool/scheduler.ts` | ~200 | Periodic tasks. Named schedules with interval + prompt. Pause/resume/trigger. Sends to engines via pool. |
| **PandoServer** | `server/server.ts` | ~200 | HTTP API + SSE streaming. `POST /api/send`, engine/schedule/health endpoints. Standalone server mode. |

### Nice to Have (future)

| Feature | Description |
|---|---|
| **Structured output** | `engine.query(prompt, { format: 'json' })` for governance review. Alternative: register a `respond_json` tool. |
| **Engine lifecycle events** | `engine.on('idle')`, `engine.on('error')` for adapter management. |
| **Resource limits** | `maxMemoryMB`, `maxConcurrentSubAgents` per engine config. |

### How pando-node uses it

```typescript
import { EnginePool, Scheduler } from "@pando-teams/core";

// engine-adapter.ts uses EnginePool directly (not PandoServer)
// PandoTeams uses its OWN configured provider/model (contributor's choice)
// API keys from LOCAL env (contributor's own keys)
const pool = new EnginePool({
  // No defaultModel — PandoTeams uses config (default: google/gemini-2.5-flash)
  maxEngines: 20,
  idleTTLMs: 30 * 60 * 1000,
  onAfterCreate: async (id, engine) => {
    // Register Pando tools (deploy, governance, transfer, etc.)
    // Inject Lux budget provider
  },
});

// Scheduler for periodic autonomous behavior
const scheduler = new Scheduler(pool);
scheduler.register({
  name: "periodic-check",
  engineId: "system",
  intervalMs: 30 * 60 * 1000,
  prompt: "Periodic check. Review system health. Spawn sub-agents if needed.",
  active: true,
});
```

### PandoTeams + Claude Code CLI (DONE — in pando-teams repo)

Claude Code CLI is a provider in `@pando-teams/core`, not in pando-node:

```
User selects "claude-code" from PandoTeams's model dropdown
  → PandoTeams's engine calls provider.doStream() as always
  → claude-code provider spawns `claude -p` with frame as --system-prompt
  → Claude Code does file editing, testing, git commits using its own tools
  → Pando MCP tools (deploy, governance, status) available via --mcp-config
  → Response parsed from stream-json → LanguageModelV3 stream parts
  → PandoTeams's post-turn hooks run normally (reflection, memory, board)
```

**Key files:** `provider/claude-code.ts` in `@pando-teams/core` (provider implementation)

**pando-node's role:** NONE. pando-node calls `engine.send()` and doesn't know what model is running.

This makes a contributor's Claude Code subscription a network resource — they earn Lux when Claude Code processes jobs for the network.

---

## 8. INFRASTRUCTURE

### 8.1 Live Network

| Machine | IP | Instance ID | Role | Features |
|---|---|---|---|---|
| EC2-1 | 44.196.69.210 | i-066e87f7440e7e2f5 | Compute (trusted) | MongoDB, systemd, CREDENTIAL_MASTER_KEY, --relay, Elastic IP |
| EC2-2 | 3.226.89.40 | i-002a88a1372adfbdb | Compute (trusted) | MongoDB, systemd, CREDENTIAL_MASTER_KEY, --relay, Elastic IP |
| Windows | 100.87.67.78 | — | Contributor | PandoTeams, Claude Code, P2P port 4100, API port 4000 |
| Mac | — | — | Contributor | PandoTeams (2nd node), nohup (no auto-restart) |


**Public gateway:** https://gateway-one-mu.vercel.app
**S3 deployments:** `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/{projectId}/index.html`
**GitHub org:** `pando-lux` — repos auto-created as `app-{8chars}-{slug}`

#### EC2 Node Details (critical for SSH troubleshooting)

```
SSH:     ssh -i ~/.ssh/lightsail-default.pem ubuntu@<IP>   (key name is legacy)
Path:    /opt/pando                    (NOT /opt/pando/node)
User:    pando                         (systemd runs as pando:pando)
SSH as:  ubuntu                        (has sudo)
Service: sudo systemctl restart pando-node
Logs:    sudo journalctl -u pando-node --since '1 hour ago' --no-pager
Build:   cd /opt/pando && sudo -u pando npx tsc -p packages/node/tsconfig.json
Node:    v22.22.1
```

**CRITICAL: File ownership must be `pando:pando` for ALL files under `/opt/pando/`.** The systemd service runs as user `pando`. If any files are owned by `ubuntu` (e.g., from manual gateway deploys or SSH file copies), `git reset --hard` will fail with "Permission denied" during auto-upgrade. Fix: `sudo chown -R pando:pando /opt/pando`.

**Running commands as pando:** `sudo -u pando bash -c 'cd /opt/pando && <command>'`

#### EC2 Deploy Playbook (manual update)

```bash
# From dev machine (Windows):
ssh -i ~/.ssh/lightsail-default.pem ubuntu@<IP> bash -s << 'EOF'
  cd /opt/pando
  sudo -u pando git pull origin master
  sudo -u pando npx tsc -p packages/node/tsconfig.json  # engine-adapter errors OK
  sudo rm -f /home/pando/.pando/circuit-breaker.json /home/pando/.pando/crash-log.json /home/pando/.pando/halted.json
  sudo systemctl restart pando-node
  sleep 8
  curl -s http://localhost:4000/v1/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'commit={d[\"commitHash\"]}, health={d[\"health\"][\"kernel\"]}')"
EOF
```

#### AWS CLI (us-east-1)

```bash
# Set credentials (contributed resource, not in env/config files)
# Keys rotated — use `/contribute aws <key>` to store securely
export AWS_ACCESS_KEY_ID='<from credential store>'
export AWS_SECRET_ACCESS_KEY='<from credential store>'
export AWS_DEFAULT_REGION=us-east-1

# List instances
aws ec2 describe-instances --query 'Reservations[].Instances[].{ID:InstanceId,State:State.Name,IP:PublicIpAddress,Name:Tags[?Key==`Name`].Value|[0]}' --output table

# Launch new compute node (same config as existing)
aws ec2 run-instances --image-id ami-0f9de6e2d2f067fca --instance-type t3.small --key-name prax-lightsail-key --security-group-ids sg-069b5c032425687e3 --subnet-id subnet-0964c36c69381a6e0 --associate-public-ip-address --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=pando-compute-N}]'

# Reboot / stop / terminate
aws ec2 reboot-instances --instance-ids <id>
aws ec2 stop-instances --instance-ids <id>
aws ec2 terminate-instances --instance-ids <id>
```

### 8.2 How to Build and Run

```bash
# Build all packages (shared → ledger → identity → node → hub → mcp-server)
npm run build

# Start a node
node packages/node/dist/cli.js --port 4001

# Start hub (web UI)
cd packages/hub && PANDO_NODES=http://localhost:4000 npx next dev --port 3003

# Run E2E tests (headed Playwright against public gateway)
npx playwright test

# Run per-project tests
npx playwright test --project pando-node
npx playwright test --project pando-teams
```

### 8.3 Node CLI Flags

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | random | TCP listen port for P2P |
| `--api-port <n>` | 4000 | HTTP API port |
| `--bootstrap <multiaddr>` | EC2 nodes | Known peer to connect to |
| `--data-dir <path>` | `~/.pando` | Data directory |
| `--mode <contributor\|secure\|lightweight\|full>` | full | Node type. Legacy aliases: `compute` → `secure`, `relay` → `lightweight`. |
| `--ledger-mode <full\|light>` | full | Ledger sync mode |
| `--public` | false | Advertise as public node |
| `--relay` | false | Enable circuit relay |
| `--no-bootstrap` | false | Skip bootstrap peer connections |

**Environment variables:**
- `PANDO_STORAGE_URL` — MongoDB connection URL (secure compute nodes only)
- `CREDENTIAL_MASTER_KEY` — 256-bit hex key for credential encryption (secure compute nodes only)
- `GATEWAY_PUBLIC_URL` — Public gateway URL for deployed apps
- `GOOGLE_GENERATIVE_AI_API_KEY` — PandoTeams default provider (Google/Gemini). Auto-loaded from PandoTeams's `.env`.
- `OPENAI_API_KEY` — For doorman classification (local) or alternative PandoTeams provider. Auto-loaded from PandoTeams's `.env`.
- `ANTHROPIC_API_KEY` — Alternative PandoTeams provider (Anthropic/Claude)
- `PUBLIC_IP` — Public IP address for Tier 2 deployment URLs (EC2 nodes). Used to construct `http://{PUBLIC_IP}/apps/{projectId}/`.
- `API_AUTH_DISABLED=true` — Dev mode: bypasses API token auth AND JWT verification for chat endpoints

---

## 9. BRAIN-KILL MIGRATION (COMPLETED 2026-03-06)

9,414 lines of legacy orchestrator code deleted. All AI now flows through `engine-adapter.ts` → @pando-teams/core. No dual coordination system.

---

## 10. TECHNICAL DEBT (honest status)

> **Detailed audits:** `docs/audit.md` (39 issues with file:line refs) and `docs/future-concerns-report.md` (21 unenforced features). Consult these before major feature work.

### Done (Phase 2 progress)

| Issue | Location | Status |
|---|---|---|
| **engine-adapter injectApiKeys** | `core/engine-adapter.ts` | DONE — loads PandoTeams's `.env` first, then checks local env, then CredentialStore fallback for EC2. Clear warning if no keys. |
| **Doorman AI classification** | `api/api-server.ts` | DONE — 3-level priority: local OPENAI_API_KEY → CredentialStore → HTTP proxy to EC2 peer. |
| **Doorman HTTP proxy** | `api-server.ts` | DONE — `pando/doorman-classify` and `pando/doorman-chat` handlers on EC2. All nodes route to EC2 via `httpPeerClient.dispatchRequest()`. Tested live: "What is machine learning?" → AI answer via HTTP. |
| **PandoTeams provider-agnostic** | `core/engine-adapter.ts` | DONE — Adapter no longer forces `claude-sonnet-4-6`. PandoTeams uses its own configured provider (default: Google/gemini-2.5-flash). Contributors choose their own provider+model. Gemini pricing added to Lux table. |
| **PandoTeams .env auto-load** | `core/engine-adapter.ts` | DONE — Resolves `@pando-teams/core` package path, loads `.env` from pando-teams repo root. Handles Windows CRLF. Keys available to PandoTeams engines without manual env setup. |
| **Thread store non-blocking** | `platform/thread-store.ts` | DONE — `addMessage()` updates local cache immediately, persists to HTTP storage backend async. Eliminated 15s+ blocking on storage timeouts per chat message. |
| **Async build routing** | `api/platform-api.ts` | DONE — Build requests return immediately with project+thread ID. PandoTeams engine runs in background. Results arrive via SSE + thread store. No more 120s HTTP timeouts. |
| **Dev auth bypass** | `api/api-server.ts` | DONE — `API_AUTH_DISABLED=true` now also bypasses JWT verification for chat endpoints (uses node's peerId as dev identity). |
| **Path B end-to-end** | Full pipeline | TESTED LIVE — "build me a portfolio website" → doorman classifies (HTTP to EC2) → project created → PandoTeams builds → DeployPipeline → GitHub push → HTTP deploy to EC2 → S3 upload → live URL returned → marketplace listing. Full pipeline proven. |
| **Unified build routing** | `api/platform-api.ts` | DONE — `findBestBuilder()` replaces the split `hasClaudeCodeAuth` logic. All 4 build handlers use unified flow: create project → find best PandoTeams peer (including self) → route. `hasClaudeCodeAuth()` removed from routing (was Anthropic-only, broken for Gemini). |
| **Circuit breaker fix** | `cli.ts`, `supervisor.ts`, `kernel/` | DONE — Port-conflict exits use code 78 (supervisor won't respawn). Immediate circuit breaker reset on successful boot. Thresholds raised (crash-guard 3→6, circuit-breaker 3→5). |
| **App Lifecycle (AppManager)** | `core/app-manager.ts`, `api/app-api.ts` | DONE — Unified pipeline with 3 tiers (static/server/infrastructure), governance gate, blue-green deploy, health monitoring, rollback, P2P dispatch. pando-node + pando-teams registered as tier 3 infra apps on startup. See Section 5.8. |
| **Credential Resolution** | `platform/resource-registry.ts` | DONE — `resolveGitCredential(repoUrl, userId?)` resolves GitHub PATs from contributed credentials. User-scoped support. Replaces hardcoded PATs in git remote URLs. See Section 5.12.1. |
| **Infrastructure as Apps** | `index.ts`, `core/app-manager.ts` | DONE — AppManager schema extended with `tier: 3`, `governance: boolean`, `deployAction: 'pm2' \| 'restart-node'`. pando-node and pando-teams registered on startup. `GET /v1/apps` shows all. |
| **Deploy result push to chat** | `api/platform-api.ts` | DONE — Deploy result awaited (not fire-and-forget). Success/failure pushed to chat thread + SSE. Commit e6fe16b1. |
| **Marketplace enrichment** | `api/platform-api.ts` | DONE — GET /v1/marketplace and GET /v1/marketplace/:id enriched with AppManager deployment data (status, url, tier, commit, deployedAt). Commit e6fe16b1. |
| **Engine memory leak** | `core/engine-adapter.ts`, `api/app-api.ts` | DONE — stopTeamAgent/stopTeam/app DELETE now destroy PandoTeams engine processes via engine.shutdown() + pool cleanup. Previously leaked zombie engines (13 at 95% memory). Commit 5b94cd77. |
| **Tick overlap guard** | `core/engine-adapter.ts` | DONE — Lead agent tick handler now skips if previous tick still running. Prevents concurrent sends to same engine. Commit 919b92a0. |
| **Commit→push loop unreliable** | `api/core-api.ts` | FIXED — Atomic `POST /v1/infra/commit-and-propose` endpoint replaces 5+ sequential bash commands. Build-gated: fails fast on build errors, unstages changes for retry. See Section 10b. |
| **Single PandoTeams node** | Infrastructure | FIXED — Mac is 2nd PandoTeams node. 4-node mesh: Windows (dev+PandoTeams), EC2-1 (compute+relay), EC2-2 (compute+relay), Mac (PandoTeams). |
| **GossipSub message rejection after restart** | `kernel/network.ts` | FIXED — Signed messages from connected peers now allowed through even without public key on file. Transport-level Noise encryption already authenticates the peer, so rejecting unverifiable messages from connected peers was unnecessary and broke message flow after restarts. |

### Restart Architecture (Verified 2026-03-08)

The codebase has multiple restart mechanisms, each serving a distinct purpose:

| Mechanism | File | When it fires | Exit code |
|---|---|---|---|
| **safeRestart()** | `core/upgrade-protocol.ts` | After governance-approved upgrade (git pull + build) | 75 |
| **requestGracefulRestart()** | `index.ts` | General restart (waits for active tasks to drain, then exits) | 75 |
| **crash-guard** | `kernel/crash-guard.ts` | 6 crashes in 60s → rolls back dist/ | 75 |
| **circuit breaker** | `kernel/startup-health.ts` | 5 consecutive boot failures → halt | 1 |
| **supervisor.ts** | `supervisor.ts` | Watches exit codes, respawns child | — |
| **systemd** | `pando-node.service` | External process manager (EC2) | — |
| **port pre-check** | `cli.ts` | Kills old process if port in use | 78 |

**Exit code convention:** 0 = stop, 75 = restart (supervisor/PM2respawns), 78 = port conflict (don't respawn), 1 = fatal.

**EC2 restart authority: systemd** (`pando-node.service`). `Restart=always` + `RestartSec=5`. PM2 was previously used but has been cleaned up — systemd is the sole process manager on EC2. On Windows, `supervisor.ts` manages restarts (no systemd).

**No RestartController needed.** Investigation found these mechanisms serve different roles and don't conflict in practice. The main pattern: upgrade-protocol.ts calls `safeRestart()` which calls `requestGracefulRestart()` which waits for drain then exits with 75.

### Security & Operational Hardening (Audit Fixes)

**Phase 1 security hardening: COMPLETE.** All 7 audit items fixed (commits `4ef3490`, `e161cf3`). Covers: command injection prevention (execFileSync everywhere), P2P Infinity/NaN guards, financial isFinite() gates, Two Laws enforcement on all agent-facing endpoints, board task CRUD validation, repoUrl validation, governance-deferred push (M-7).

| Feature | Details |
|---|---|
| **User ban mechanism** | `ledger.banAccount(peerId)` / `isBanned()` enforced in api-server.ts — banned users receive 403 on all requests |
| **JWT revocation** | `revokeToken(jti)` / `isRevoked(jti)` in @pando/identity — in-memory blacklist for invalidated tokens |
| **Emission cap enforcement** | Daily tracking in emission-witness.ts, `DAILY_EMISSION_CAP=500`, bootstrap emission cap=50 |
| **Credential selection** | LRU selection, `maxUsagePerDay` enforcement, health-based failover, `grantedTo` checking in ResourceRegistry |
| **Quarantine escalation** | Duration doubles per repeat offense, no auto-release after 3rd quarantine |
| **Health summary** | `monitor.getHealthSummary()` exposed via `/health` — includes subsystem-level health |
| **/health during init** | Returns 503 `{ status: 'initializing' }` until all init phases complete |
| **Admin auth** | All `/admin/*` routes require operator-level auth |
| **Upload validation** | 50MB per file, 200MB total, blocked extensions (.exe, .bat, .dll, .sh, .cmd, etc.) |
| **SSE limits** | 10 connections per IP |
| **Stream event versioning** | `STREAM_EVENT_VERSION=1` on all SSE events |
| **Capability verification** | `verified` flag on capability profiles |
| **Shutdown improvements** | P2P request drain, WAL checkpoint, 30s timeout |
| **Double-spend prevention** | Balance validation on remote transactions |
| **Weighted governance** | Reputation-weighted vote counting |
| **Command injection prevention** | `safeGitRef()` validator in app-manager, hex validation on commitHash, `execFileSync` for ALL git commands (deploy-manager, app-manager, guardrails). No `execSync` with string interpolation for git. |
| **P2P Infinity/NaN guards** | All P2P transaction handlers validate `isFinite(tx.amount)` and sanitize `tx.fee` (must be non-negative finite). Prevents Infinity balance corruption and negative-fee free-Lux exploit. |
| **Financial isFinite() gates** | All API endpoints accepting financial values (transfer, sale, budget, price, resource cost) validate `isFinite()`. Blocks `JSON.parse('1e999')` → Infinity bypass. |
| **Two Laws on all agent-facing endpoints** | All trigger, spawn, message, request, and board endpoints check `violatesTwoLaws()` before passing text to AI agents |
| **Board task CRUD validation** | `updateTeamBoardTask()` checks `result.changes > 0` — nonexistent tasks return 404, not 200 |
| **repoUrl validation** | `cloneOrPull()` validates URL format before `execSync` to prevent shell injection via malicious repo URLs |

**Phase 2 security hardening (commit `5fb9322b`, 2026-03-10):** Ledger remote transaction validation + P2P upgrade governance check.

| Feature | Details |
|---|---|
| **Remote emission hard cap** | `applyRemoteTransaction()` now checks `LUX_HARD_CAP` before applying emissions — prevents malicious peers from minting past 10B supply |
| **Remote fee validation** | Remote transfer fees validated against `RELAY_FEE_RATE * 1.5` ceiling — prevents fee inflation attacks |
| **Deficit tracking** | `forceSubtractBalance()` now records deficit in `network_stats` table (`deficit:{peerId}`) for reconciliation instead of silently clamping |
| **Direct P2P governance check** | `init-platform.ts` UPGRADE_NOTIFICATION handler now verifies governance proposal exists, status==='passed', commitHash matches — same check as GossipSub path |

**Phase 2b security hardening (commit `dceae5f7`, 2026-03-10):** API auth + governance integrity.

| Feature | Details |
|---|---|
| **Governance vote signature verification** | `handleVote()` now verifies Ed25519 signature on remote votes, rejects unsigned, validates `message.from === vote.voter` to prevent impersonation |
| **Timing-safe token comparison** | `verifyBearerToken()` helper uses `crypto.timingSafeEqual` — replaces all `===` comparisons in platform-api.ts |
| **Authenticated billing endpoint** | `POST /resource-proxy/meter` now requires Bearer token auth |
| **Authenticated payment history** | `GET /payment/history` now requires Bearer token auth |

**Known remaining gaps (documented, assigned to dev):** App deployment lacks sandboxing (design limitation for multi-tenant), Teams Server path traversal in `/assets/*`, governance comment spoofing (no signature on comments), emission attestation signatures not verified.

### Credential Storage Uses resourceId, NOT peerId

**Credentials are keyed by `resourceId` (UUID), not by peerId.** This means credential persistence survives node identity changes (e.g., deleting `identity.json`). The roadmap originally identified "credentials tied to peerId" as a root cause of deployment failures — this was a misdiagnosis. No machine-bound credential anchor is needed.

The `resourceId` is generated when a credential is contributed (via `/contribute`) and stored in MongoDB alongside the encrypted credential. The ResourceRegistry syncs metadata (type + status) via GossipSub, but never the credential value itself.

### Needs Work

| Issue | Location | Problem |
|---|---|---|
| **PandoTeams Network Linking** | PandoTeams config + engine-adapter | BUILT — Node creates PANDO_PROJECT.json, PandoTeams detects via `detectNetworkLinking()`. `GET /api/network` endpoint. See Section 5.9. |
| ~~**Claude Code CLI provider**~~ | `@pando-teams/core` provider/claude-code.ts | **DONE.** Lives in pando-teams repo as a provider. Shows in model dropdown. See Section 3.2.9. |
| **Contributor limits** | Partially built | Contributors need to set max requests/day, budget caps. Daily compute cap (50 jobs/day) is built. Per-user API limits not yet implemented. |
| ~~**Node mode CLI flag**~~ | `cli.ts` | **FIXED.** Modes: `contributor|secure|lightweight|full`. Legacy `compute|relay` kept as aliases. |
| ~~**S3 upload awaiting**~~ | `index.ts` | **FIXED.** Uses `Promise.all(uploadPromises)` instead of 2s sleep. Upload errors surfaced in console. |
| ~~**Tier 2 PM2 persistence**~~ | `init-platform.ts` | **ALREADY HANDLED.** `pm2 save` is called after every deploy. Port registry also persists. |
| **Deploy pipeline resilience** | `core/app-manager.ts` | AppManager provides blue-green deploy (no port collision) + rollback (restore previous commit). Retry on transient failures still TODO. S3 partial upload edge case mitigated by rollback capability. All deploy events persisted to `app_history` table in apps.db. |
| **Chat-created projects lack repo_url** | `api/platform-api.ts` | Chat-created projects use workspace-based deploy (workspaceDir). EC2 deploy dispatch requires GitHub repo to clone. Workspace-to-GitHub push before deploy dispatch needed. Being fixed separately. |
| **Board state partially durable** | `core/team-registry.ts`, `init-platform.ts` | P2P board sync implemented (BOARD_STATE_REQUEST/RESPONSE) but on-demand only — claiming node requests from peers. If the old managing node is dead, board data from that node is lost. **Tested 2026-03-09:** orphan detection + team claim + agent restart all work. Local board persists across claims. Need proactive replication for full durability. |
| **Engine watchdog** | `core/engine-adapter.ts` | DONE — 30s interval watchdog monitors all team engines. Dead CLI processes auto-restart via `pool.getOrCreate()`. Circuit breaker: 5 restarts in 1 hour → gives up. Tick failures trigger immediate restart instead of waiting for next interval. Timer unref'd so it doesn't block shutdown. Commit 79b201e8. |
| **Mac node has no auto-restart** | Infrastructure | Mac PandoTeams node runs via `nohup` — no systemd, no supervisor. If the process dies, it stays dead until manual restart. Needs launchd or equivalent. |
| ~~**deployPeerId not persisting**~~ | `platform-api.ts:3685` | **ALREADY HANDLED.** Saved to both ProjectStore (MongoDB) and ProjectRegistry (local). |
| ~~**Unified Pipeline Phases 3-7**~~ | `core/git-ops.ts`, `core/github-client.ts` | **DONE.** All 7 phases complete. GitOps class centralizes all git operations. GitHubClient for autonomous repo creation. All consumers refactored. See Section 5.8.2. |
| ~~**UpgradeProtocol/AppManager duplication**~~ | `core/upgrade-protocol.ts`, `core/app-manager.ts` | **DONE.** Both now use GitOps for all git operations. UpgradeProtocol handles governance + security + safe restart. AppManager handles deployment lifecycle. No more duplicate git logic. |

### Stubs

| Issue | Location | Problem |
|---|---|---|
| **Private/offline mode** | Various | Ollama provider exists in pando-teams but not wired. SQLite fallback unclear. |
| **Governance fork resolution** | Designed only | 5-step resolution protocol, zero code. No conflict detection. |
| **Distributed tracing** | Designed only | traceId, correlation IDs — designed but not built. |

### Acceptable Trade-offs

| Issue | Why it's OK |
|---|---|
| ~~index.ts is a monolith~~ | **RESOLVED.** Extracted `_start()` into `init-kernel.ts` (850 lines), `init-core.ts` (117 lines), `init-platform.ts` (951 lines). index.ts is now ~1,726 lines (class definition, lifecycle, getters, utilities). |
| Agent identity is ephemeral | Ephemeral agents are sufficient for dev mode. |
| Governance auto-approves (<=8 peers) | Dev mode only. Real voting kicks in with more peers. |

---

## 10b. SELF-SUSTAINING TEAMS & AUTO-UPGRADE

### Vision

The end-state: **no human intervention required.** The pando-infra team monitors, detects issues, fixes code, proposes changes through governance, deploys, and restarts all nodes including itself. User project teams manage their own apps autonomously. Users interact only through the gateway — submitting bug reports or feature requests. Teams handle everything.

### Team Lead Model: Claude Code (Persistent Sessions)

The pando-infra lead agent uses Claude Code as its model inside PandoTeams. This gives it:
- **Persistent sessions** via `--session-id`/`--resume` — context survives across ticks
- **Native CLI tools** — bash, read, write, edit, grep, glob (no synthetic tool wrappers)
- **Full codebase access** — can read, understand, and modify any file in pando-node or pando-teams
- **Tool chaining** — can run tests, check build output, iterate on fixes

Observer and QA agents also use claude-code — all 3 pando-infra agents run on the same model. User project leads can use any model — PandoTeams handles provider selection.

### The Self-Sustaining Loop (pando-infra team)

```
1. DETECT
   Observer tick (60min) → pando_status + pando_peers → reports issues to lead
   QA tick (120min) → health checks → reports failures to lead
   Users → gateway "Report Bug" → routed to team → board task created

2. TRIAGE
   Lead tick (15min) → check_agents(inbox) + board review
   Prioritize: CRITICAL > BUG:user > WARNING > FEATURE:user
   Skip duplicates, close stale tasks (>24h)

3. FIX
   Lead → pando_workspace({ repo: "pando-lux/node" }) → gets local clone path
   Lead → spawn_agent({ role: "builder", task: "Fix ...", working_directory: <path> })
   Builder reads code, writes fix, runs `npm run build`, runs tests
   Builder commits locally: git add + git commit (NO push yet — push is DEFERRED until governance passes)

4. GOVERN (only if team.governanceRequired == true)
   Lead → curl POST http://127.0.0.1:4000/v1/governance/propose
     Body: { title, description, commitHash }
   API auto-sets category='upgrade' and builds upgradePayload when commitHash present.
   Governance: security file check → dangerous pattern scan → AI review (advisory) → kernel delay
   Auto-approves in dev mode (<=8 peers). Real voting with more peers.
   Approved → push to origin → onUpgradeApprovedCallback fires → pullAndUpgrade locally → broadcast to peers

   (User project teams with governanceRequired: false skip this step — deploy directly)

   **M-7 fix:** Push is now deferred until after governance approval. Previously, builders pushed
   immediately and governance validated after the fact. Now the flow is:
   commit locally → propose → governance approves → push to origin → notify peers.
   This prevents unapproved code from reaching the remote repo.

5. UPGRADE (all nodes, 4 paths — most reliable first)
   Path A: Direct P2P notification to each peer (TCP, reliable — primary)
   Path B: GossipSub broadcast on topic "pando/upgrades" (bonus, unreliable in small networks)
   Path C: Governance sync every 2min with random peer (direct P2P, includes decisions)
   Path D: Catchup timer every 2min scans governance for passed upgrade proposals (safety net)

   All three call UpgradeProtocol.pullAndUpgrade(commitHash):
     1. git config --global --add safe.directory <repoDir>
     2. git fetch origin master
     3. STRICT hash verification: commitHash must match or be ancestor of origin/master
     4. Stash uncommitted changes (pando-auto-stash-{timestamp})
     5. git reset --hard origin/master
     6. npm install (non-fatal — build may succeed without it)
     7. build() — tries `npm run build` first, falls back to `npx tsc -p packages/node/tsconfig.json` (EC2 nodes lack @pando-teams/core). On total failure → git reset --hard <previous>
     8. Record success, mark proposalId as applied
     9. Safe restart: 0 active workers + 0 pending messages → exit(75)

6. RESTART
   Supervisor detects exit(75) → respawns after 2s delay
   Node boots → loads new compiled code → re-initializes teams from registry
   pando-infra lead resumes from persistent session (Claude Code --resume)
   Catchup timer starts 30s after boot
   Loop restarts from step 1

7. PROPOSER NODE (self-upgrade)
   The node that pushed the fix is already at the target commit.
   pullAndUpgrade detects HEAD matches target → checks runningCommit !== currentHead
   If stale (in-memory code from old dist/) → safeRestart → exit(75)
   Fresh process loads the rebuilt dist/
```

### Governance Propose API (critical details)

**Endpoint:** `POST /v1/governance/propose` (NOT `/proposals` — that was an old bug)

**Required fields for upgrade proposals:**
```json
{
  "title": "[Upgrade] fix: description",
  "description": "Security fix: what changed and why",
  "commitHash": "abc123..."
}
```

When `commitHash` is present, the API automatically:
- Sets `category: 'upgrade'`
- Builds `upgradePayload: { commitHash, description }`
- This triggers auto-approve logic in governance

**Without `commitHash`:** Creates a general proposal (no auto-approve, no upgrade trigger).

**Security file gotcha:** If the commit touches files in the SECURITY_FILES list (`governance.ts`, `upgrade-protocol.ts`, `credential-store.ts`, etc.), the description MUST contain "security" or "credential" — otherwise auto-approve is rejected.

### Atomic Commit-and-Propose Endpoint

**Endpoint:** `POST /v1/infra/commit-and-propose`

Atomic pipeline that replaces 5+ sequential bash commands with a single curl call. Used by the pando-infra lead agent.

**Pipeline:** `git add → npm run build → git commit → governance propose → (push deferred until governance approves) → mark task done`

**Request body:**
```json
{
  "message": "fix: description of the change",
  "taskId": "optional-board-task-id",
  "teamId": "optional-team-id (defaults to pando-infra)"
}
```

**Response (success):**
```json
{
  "status": "success",
  "commitHash": "abc123...",
  "proposalId": "prop-uuid",
  "steps": ["staged", "built", "committed", "proposed", "task-done"]
}
```

**On build failure:** Returns build errors in the response body and unstages all changes (`git reset HEAD`) so the agent can read the errors, fix the code, and retry. No broken commits reach the repo.

**Why this exists:** The old flow (agent runs git add, npm run build, git commit, git push, curl governance/propose as separate bash commands) was unreliable — agents would forget steps, skip the build check, or fail mid-sequence leaving dirty state. The atomic endpoint guarantees all-or-nothing: either the full pipeline succeeds or changes are rolled back to pre-attempt state.

### Key Invariants

1. **Governance-flagged teams go through governance.** Teams with `governanceRequired: true` propose via governance. Teams with `false` deploy directly. pando-infra always requires governance.
2. **Safe restart only.** Never kill a node with active workers or pending messages. Defer to next cycle.
3. **Exit code 75 = restart.** Exit code 78 = port conflict (don't respawn). Any other crash = backoff respawn.
4. **Teams survive restart.** Team registry persists in SQLite. Claude Code persistent sessions resume. Board tasks persist. Memory persists. Teams re-bootstrap from registry on startup.
5. **Stale code detection.** `runningCommit` (snapshot at boot) vs `git rev-parse HEAD` (current). Mismatch → restart needed.
6. **Build must pass.** `upgrade-protocol.ts build()` tries `npm run build`, falls back to targeted `npx tsc -p packages/node/tsconfig.json` (for EC2 nodes missing @pando-teams/core). If both fail → rollback to previous commit. No broken deploys.
7. **Two Laws filter.** All user input and board tasks filtered. Teams cannot be weaponized.
8. **npm install before build.** New deps may have been added between commits. `npm install` runs before `build()` in upgrade-protocol.ts. Failure is non-fatal (build may still work if deps didn't change).
9. **Hash verification is the security gate.** Push to origin is deferred until governance approves (M-7 fix). Nodes only upgrade to the exact commit hash approved by governance. `merge-base --is-ancestor` ensures the hash is in origin/master's history.
10. **Team handoff is automatic.** If a managing node dies, any PandoTeams-capable node claims the orphaned team. Board recovered from git. No manual intervention needed.

### The Goal

**Phase 1 (PROVEN 2026-03-07, security hardened 2026-03-09):** pando-infra team detects issues, creates board tasks, spawns builders, fixes code, proposes via governance. Full autonomous loop — fix → commit → governance → push → all nodes upgrade. Security hardening complete: all 7 audit items fixed (commits `4ef3490`, `e161cf3`), governance-deferred push, Elastic IPs on EC2 nodes. Verified end-to-end across 3 nodes (1 Windows + 2 EC2).

**Phase 2 (COMPLETE 2026-03-09):** Migrated from legacy hardcoded council to team architecture. TeamRegistry + `/v1/teams/*` endpoints + team handoff + git-backed board recovery. All legacy council routes delegate to `/teams/pando-infra`.

**Phase 3 (IN PROGRESS):** User project teams run autonomously alongside pando-infra. Multiple teams on multiple nodes. Teams hand off between nodes. Users submit requests from gateway and teams handle everything.

**4-Node Mesh (LIVE):**

| Node | Role | PandoTeams | Relay | Notes |
|---|---|---|---|---|
| Windows | Dev machine | Yes | No | P2P port 4100, API port 4000. Primary dev + CEO agent. |
| EC2-1 (44.196.69.210) | Compute + relay | No | Yes (`--relay`) | systemd, MongoDB, NAT traversal relay, Elastic IP |
| EC2-2 (3.226.89.40) | Compute + relay | No | Yes (`--relay`) | systemd, MongoDB, NAT traversal relay, Elastic IP |
| Mac | PandoTeams | Yes | No | 2nd PandoTeams contributor. No auto-restart (nohup). |

EC2 nodes run with `--relay` flag enabling circuit relay for NAT traversal — Windows and Mac nodes behind NAT can reach each other through EC2 relays. Dev infrastructure details (IPs, SSH, peer IDs, auth tokens, quick commands) are in `infra/DEV-MODE.md` (gitignored).

**Phase 8 Gateway (STARTED 2026-03-09):** Gateway team integration. `node-connection.ts` has 9 team methods (getTeams, getTeam, getTeamBoard, addTeamBoardTask, getTeamAgents, getTeamStatus, getTeamCost, submitTeamRequest, getTemplates). 8 API routes at `/api/teams/*` and `/api/templates`. Network page shows Teams section with expandable cards (agents + board tasks). Remaining: team creation from gateway, model selection, aggregate dashboard across nodes.

### Files Involved

| File | Role |
|---|---|
| `core/team-registry.ts` | **NEW.** Team registry, P2P sync, heartbeat, orphan detection, handoff |
| `core/engine-adapter.ts` | Spawns team engines via startTeam(), registers tools, manages scheduler |
| `core/upgrade-protocol.ts` | Git pull, hash verify, npm install, build, safe restart |
| `init-kernel.ts:634-735` | Wires upgrade broadcast, subscribe, onUpgradeApproved, catchup timer |
| `kernel/governance.ts:1856-1890` | Auto-approve logic, validateUpgradeProposal() |
| `api/kernel-api.ts` | POST /v1/governance/propose (commitHash → upgradePayload) |
| `api/core-api.ts` | /v1/teams/* endpoints (board proxy, team CRUD) |
| `gateway/lib/node-connection.ts` | **Phase 8.** 9 team methods: getTeams through getTemplates |
| `gateway/app/api/teams/*` | **Phase 8.** 8 API routes proxying to pando-node team endpoints |
| `gateway/app/network/page.tsx` | **Phase 8.** Teams section with expandable cards, agents, board tasks |
| `supervisor.ts` | Watches exit codes, respawns on 75 |
| `cli.ts` | Crash guard, circuit breaker |
| `docs/TEAM-ARCHITECTURE.md` | Full implementation reference (schema, flows, legacy audit, E2E tests) |

See also: `docs/HUMAN-LEVEL-TESTING.md` for end-to-end scenario tests.

---

## 11. KEY FILES REFERENCE

### Entry Points
| File | Purpose |
|---|---|
| `index.ts` | PandoNode class definition (1,726 lines). Lifecycle, getters, utilities. `_start()` delegates to init files. |
| `init-kernel.ts` | Kernel init (850 lines): P2P, ledger, sync, governance, security, emission, upgrade, request-reply handlers. |
| `init-core.ts` | Core init (117 lines): storage backends, credentials, app manager. |
| `init-platform.ts` | Platform init (951 lines): API server, deploy handlers, resources, content, SSE, message handling. |
| `cli.ts` | Non-interactive entry. Supervisor, crash guard (exit 78 for port conflict), circuit breaker auto-reset on successful boot, port check. |
| `tui.ts` | Interactive terminal. 30+ slash commands. |

### Kernel (Layer 0)
| File | Purpose |
|---|---|
| `kernel/network.ts` | libp2p: TCP, Noise, Yamux, GossipSub, Circuit Relay, KadDHT |
| `kernel/governance.ts` | 6-layer security pipeline + AI review hook |
| `kernel/sync.ts` | Ledger P2P sync via GossipSub |
| `kernel/monitor.ts` | Health polling, alerting |
| `kernel/guardrails.ts` | 4-tier rate limiting |
| `kernel/security-monitor.ts` | 5 threat detectors |
| `kernel/reputation.ts` | Performance scoring, weighted votes |
| `kernel/emission-witness.ts` | Witness-based Lux minting |
| `kernel/local-environment.ts` | Local environment detection (~326 lines) |
| `kernel/network-state.ts` | Network state tracking (~409 lines) |
| `kernel/startup-health.ts` | Startup health validation (~231 lines) |

### Core (Layer 1)
| File | Purpose |
|---|---|
| `core/team-registry.ts` | **NEW.** Team registry (SQLite), GossipSub sync, heartbeat, orphan detection, handoff, P2P board proxy. See Section 5.10. |
| `core/engine-adapter.ts` | THE integration point. Multi-engine, routing, Pando tools, Lux budget. Team agent setup via startTeam(). Does NOT handle model selection — that's PandoTeams's job. |
| `core/app-manager.ts` | Unified pipeline: 3 tiers, governance gate, deploy/update/rollback/health. SQLite apps.db. pando-node + pando-teams = tier 3 infra apps. See Section 5.8. |
| `core/credential-store.ts` | AES-256-GCM encrypt/decrypt |
| `core/http-peer-client.ts` | Direct HTTP for all inter-node operations. Ed25519-signed. See Section 4.5. |
| `core/storage-backend.ts` | MongoDB or HTTP proxy |
| `core/upgrade-protocol.ts` | Governance gate + security validation + safe restart. Uses GitOps for all git operations. |
| `core/git-ops.ts` | **Unified git operations.** ALL git calls go through GitOps. execFileSync only. safeGitRef/safeCommitHash validators. stashAndReset (replaces safeGitReset). |
| `core/github-client.ts` | GitHub API client for autonomous repo creation. createRepo, deleteRepo, repoExists. |
| `core/payment-gate.ts` | Lux escrow |
| `core/cloud-instance-manager.ts` | EC2 instance provisioning, security groups, IP polling (~961 lines) |
| `core/deploy-manager.ts` | PatchSet git commit/revert for CodePipeline. Uses GitOps for all git operations. |
| `core/version-protocol.ts` | Version negotiation (~222 lines) |
| `core/mongo-backend.ts` | MongoDB storage backend (~239 lines) |
| `core/p2p-storage-backend.ts` | P2P storage proxy (~171 lines) |

### Platform (Layer 2)
| File | Purpose |
|---|---|
| `platform/capability-detector.ts` | Auto-detect capabilities |
| `platform/resource-marketplace.ts` | Resource discovery + pricing |
| `platform/content-registry.ts` | Content management |
| `platform/thread-store.ts` | Chat persistence (MongoDB) |
| `platform/project-store.ts` | Project persistence, CRUD, collaborators, reports (~2,328 lines) |
| `platform/task-queue.ts` | Task queue, hashing, distribution (~1,056 lines) |
| `platform/task-database.ts` | Task SQLite persistence (~911 lines) |
| `platform/scheduler.ts` | Task scheduling, polling, capacity management (~855 lines) |
| `platform/pipeline-runner.ts` | Code pipeline execution (~724 lines) |
| `platform/qa-runner.ts` | QA test execution (~743 lines) |
| `platform/user-accounts.ts` | Guest/claim auth, ban checking (~617 lines) |
| `platform/contribution-tracker.ts` | Contribution tracking (~522 lines) |
| `platform/resource-registry.ts` | Credential metadata, usage tracking, `resolveGitCredential()` for dynamic PAT resolution. See Section 5.12.1. |

### API
| File | Purpose |
|---|---|
| `api/api-server.ts` | Fastify server setup, doorman classification (simple/question/build/report intents) |
| `api/kernel-api.ts` | Status, peers, tasks, governance, guardrails, monitoring, scheduler, reputation, admin, wallet, activity, search (~2,500 lines) |
| `api/core-api.ts` | Upgrade, emissions, security, team routes (/v1/teams/* — board proxy, CRUD, trigger) (~710 lines) |
| `api/platform-api.ts` | Projects, auth, chat, engines, content, marketplace, resources, testing, templates, per-project board/request, `findBestBuilder()` (~3,696 lines) |
| `api/app-api.ts` | App lifecycle REST endpoints: /v1/apps/* (12 routes) (~222 lines) |
| `api/internal-api.ts` | Ed25519-signed inter-node dispatch, storage proxy, credential proxy |
| `api/testing-api.ts` | Testing dashboard routes (11 endpoints) |

---

## 12. RULES

### Sprint Rules
1. No legacy code protection. Delete if it's in the way. We have git.
2. Fresh start. Make the right decision, then update docs to match.
3. Build must pass. `npm run build` zero errors before any commit.
4. Let things break. Fix during testing. No compatibility shims.

### Import Boundaries (enforced)
- kernel → only kernel + @pando/*
- core → kernel + @pando/* (exception: type-only import from platform — `ResourceRegistry` in engine-adapter.ts)
- platform → core + kernel + @pando/*
- api → platform + core + kernel + @pando/*
- Never upward (runtime imports). Type-only exceptions acceptable.

### Token Economics
| Parameter | Value |
|---|---|
| Hard cap | 10,000,000,000 Lux |
| Relay fee | 0.1% per transfer |
| Daily cap | 500 Lux max per node per day |
| Exchange rate | 100 Lux per $1 USD (engine adapter) |

---

## 13. WHAT EACH NODE TYPE NEEDS

**Every node (lightweight baseline):**
- Ed25519 identity (keypair)
- SQLite ledger
- P2P networking (libp2p)
- HTTP API (Fastify)
- Governance (security pipeline)

**PandoTeams contributor (adds to baseline):**
- @pando-teams/core + Engine Adapter (one file, one dependency)
- Local API keys (any provider — PandoTeams's `.env` or local env vars. Default: Google/gemini-2.5-flash)
- OR Claude Code CLI installed — PandoTeams selects "claude-code" as provider internally. pando-node doesn't know or care.
- That's it. Contributor earns Lux for processing build jobs.

**Secure compute / EC2 (adds to baseline):**
- MongoDB (PANDO_STORAGE_URL)
- CredentialStore (CREDENTIAL_MASTER_KEY)
- Handles contributed API keys for Path A (simple AI)

**Full dev node (contributor + secure):**
- Everything above. Full self-sufficiency.

**Optional (graceful degradation if missing):**
- AppManager (manages deployed user apps — Tier 1 S3, Tier 2 PM2+nginx)
- ResourceMarketplace (operational, not critical path)
- SecurityMonitor, ReputationManager (enhance but don't block)

---

## 14. THINGS THAT WILL CONFUSE YOU

1. **Pando tools are just HTTP calls to 127.0.0.1.** The engine calls `pando_deploy` which does `POST http://127.0.0.1:4000/v1/apps/:id/deploy`. The engine doesn't import pando-node. The tools are the entire integration layer. (Must use `127.0.0.1`, not `localhost` — Node.js `fetch()` can fail silently with `localhost` on some platforms.)

2. **Each project gets its own engine instance.** The adapter manages `Map<projectId, PandoTeams>`. Engines don't know about each other. They communicate only through Pando tools (which call the shared HTTP API).

3. **Team agents are standard PandoTeams agents.** Every team (pando-infra or user project) consists of PandoTeams engine instances in the EnginePool — each with their own session, memory, and board. They use PandoTeams's native send_message for communication and board tasks for issue tracking. pando-node only adds pando_* tools, Lux budget, and the team registry for routing. Do NOT build custom agent/communication systems — PandoTeams already has them (see Section 3.2). The pando-infra team has 3 agents (lead + observer + QA). User project teams start with 1 (lead) and can grow.

4. **Governance is NOT an AI agent.** It's deterministic code in kernel/governance.ts. It only calls the AI (via adapter.reviewDiff) for Layer 5 smart analysis. The 6-layer pipeline is deterministic code, not an LLM.

5. **`X-User-Token` vs `Authorization: Bearer`.** Two different auth systems. Bearer = operator (node admin). X-User-Token = user/agent JWT (Pando Login). Both can be present. Agent JWT takes precedence.

6. **RESTART_EXIT_CODE = 75.** When stale code detected (git HEAD moved), node exits with 75. Supervisor restarts and picks up new code.

7. **Triple-broadcast on peer connect.** Capability profiles broadcast 3 times (immediate + 10s + 30s) because GossipSub mesh formation is slow.

8. **`createRequire` for CJS in ESM.** @pando/tests and better-sqlite3 are CJS, node is ESM. `createRequire(import.meta.url)` bridges this in testing-api.ts and engine-adapter.ts (cached at startup for board operations). Not a bug.

9. **Standalone pando-teams is identical to pando-node's engines.** The only difference is: inside pando-node, engines get Pando tools registered and Lux budget instead of USD. The engine code is the same.

10. **No process isolation needed.** The old orchestrator needed child processes because the tick loop blocked the event loop. `engine.send()` is async and non-blocking. All engines run in the main process (or a single worker thread if memory is a concern).

11. **Init files use `node: any` parameter.** `init-kernel.ts`, `init-core.ts`, `init-platform.ts` receive the PandoNode instance typed as `any`. This is intentional — avoids circular imports (init files can't import PandoNode from index.ts). All callback parameters also use `: any` for the same reason.

12. **`_start()` is a thin coordinator.** It calls `initKernel(this)`, `initCore(this)`, `initPlatform(this)` via dynamic `await import()`. Each init file is a standalone function that sets up its layer. This pattern was chosen to break the 3,772-line monolith while keeping the PandoNode class interface unchanged.

13. **Keys don't travel. Work travels.** Contributed API keys stay on EC2 (Path A — simple AI). PandoTeams contributor keys stay on their machine (Path B — builds). The network routes WORK to where the keys are, never the other way around. `injectApiKeys()` loads: (1) PandoTeams's `.env` file, (2) local env vars, (3) CredentialStore fallback (EC2 only). It does NOT pull keys over the network.

14. **Two kinds of "contribute."** `/contribute openai sk-xxx` donates a key to the network (encrypted on EC2, used server-side for Path A). Running PandoTeams on your node contributes your COMPUTE (your local keys, your machine, you earn Lux for builds).

15. **Builder targeting ≠ Deploy targeting.** `findBestBuilder()` looks for `shareCompute + compute_cpu` (PandoTeams contributor nodes). `AppManager.findDeployTarget()` looks for `credentialAccess + storageBackend='mongodb'` (EC2 secure nodes). These are DIFFERENT node types. If you mix them up, deploys silently fail because PandoTeams nodes can't decrypt S3 credentials.

16. **AppManager update result is awaited and pushed to chat.** `appManager.update(projectId)` is awaited from platform-api.ts after build completion. On success: deploy message pushed to chat thread via `threadStore.addMessage()` + SSE event `app_deployed`. On failure: failure message pushed to chat thread + SSE event `app_deploy_status`. History is recorded in apps.db regardless of success/failure.

17. **Dev infrastructure details are in `infra/DEV-MODE.md` (gitignored).** Contains: 4-node mesh details (IPs, SSH, peer IDs, capabilities), quick commands for checking/restarting each node, API auth tokens, governance upgrade pipeline steps, and known dev issues. Read this file at session start if you need to SSH into nodes or test the live network.

18. **Marketplace filters test artifacts.** `getMarketplaceAsync()` uses a regex to strip projects named "hello world", "test app", "demo", "example", etc. If your test project doesn't show up in the marketplace, that's why. Use a real project name.

18. **Project workspaces are `~/.pando/projects/{projectId}/`.** Engine adapter creates the directory and passes it as `projectPath` to PandoTeams. The engine writes files there. The deploy pipeline reads `workspaceDir` from the project record to know where to git push from. If `workspaceDir` is missing, GitHub push fails with "workspaceDir required".

19. **Board task dedup is by exact title match.** `addBoardTask()` checks if a pending/in_progress task with the identical title exists and returns its ID instead of creating a duplicate. This prevents user spam but doesn't catch semantically similar reports (e.g., "login broken" vs "login page crashes"). The council handles semantic dedup by batching similar issues during tick processing.

20. **Claude Code is a PandoTeams provider, NOT a pando-node feature.** Model/provider selection lives in `@pando-teams/core`. pando-node calls `engine.send()` and doesn't know what model is running. NEVER put model-routing logic in engine-adapter.ts or platform-api.ts. This mistake was made once (ClaudeCodeSession in engine-adapter) and reverted. The brain/body boundary is inviolable.

21. **Claude Code nested session prevention.** The claude-code provider in PandoTeams deletes the `CLAUDECODE` env var from the subprocess environment. Without this, spawning Claude Code from within a Claude Code session fails. This is handled in `@pando-teams/core`, not pando-node.

22. **Doorman severity classification uses word-variant regex.** `crash(es|ed|ing)`, `bug`, `error`, `fail(s|ed|ing)` all match as BUG. Without the variant suffixes, "crashes" would be classified as FEATURE (word boundary `\bcrash\b` doesn't match "crashes"). This was a real production bug found in E2E testing.

23. **HTTP credential proxy has a timeout chain.** GitHub repo creation requires: HTTP credential decrypt (30s timeout) + GitHub API call (45s inner timeout). If EC2 nodes are slow or offline, the credential proxy times out and GitHub operations fail. The timeouts were tuned for production latency on 2026-03-06.

24. ~~**S3 uploads are fire-and-forget with a 2s wait.**~~ **FIXED.** S3 uploads now use `Promise.all(uploadPromises)` and surface errors. No more 2s sleep.

25. **EC2 file ownership breaks auto-upgrade.** The pando-node service runs as `pando:pando` (systemd). If someone SSHs as `ubuntu` and creates/modifies files (e.g., manual gateway deploy, `npm install` as ubuntu), those files are owned by `ubuntu`. When auto-upgrade runs `git reset --hard`, it fails with `error: unable to unlink old '<file>': Permission denied`. Fix: `sudo chown -R pando:pando /opt/pando`. This caused weeks of silent upgrade failures across both EC2 nodes (2026-03-07).

26. **`git diff HEAD~1` vs `git diff HEAD~1 HEAD`.** Without the second `HEAD` argument, git diffs against the **working tree** — meaning uncommitted local changes appear in the diff. The governance validation (`validateUpgradeProposal`, `scanDiffForDangerousPatterns`) uses this to check committed code. If you use `HEAD~1` alone, uncommitted editor artifacts, debug files, or stashed changes inflate the diff and cause false rejections. Always use `HEAD~1 HEAD`.

27. **Governance propose endpoint is `/v1/governance/propose`, NOT `/v1/governance/proposals`.** The `/proposals` endpoint is GET-only (list). Council prompts had the wrong URL, causing proposals to 404 or create general (non-upgrade) proposals that never triggered auto-approve. If a governance proposal expires with 0 votes and you expected auto-approve, check: (a) correct endpoint, (b) `commitHash` in body, (c) proposal description contains "security" if touching security files.

28. **`npm install` must run before `npm run build` during upgrade.** If new dependencies were added between commits (e.g., `mongodb` package added), the build fails on the receiving node because node_modules is stale. Both `upgrade-protocol.ts:pullAndUpgrade()` and the `/upgrade` API endpoint run `npm install` before build. The root `package.json` also has a `prebuild` hook that installs specific missing deps (targeted, not full `npm install`, to avoid `file:` reference failures on EC2).

29. **`file:` dependencies break `npm install` on EC2.** `"@pando-teams/core": "file:../code/packages/core"` only works on the dev machine where `../code/` exists. On EC2, full `npm install` fails because the path doesn't exist. The `prebuild` script works around this by installing only specific missing packages (`npm install mongodb --no-save`) instead of running full `npm install`. If you add a new dependency, ensure it gets installed via the targeted prebuild OR ensure `npm install` failure is non-fatal in upgrade-protocol.ts (it is — the catch logs a warning and continues).

30. **Auto-upgrade has 3 trigger paths.** (a) `onUpgradeApproved` callback fires immediately on the proposing node when governance passes. (b) GossipSub broadcast on `pando/upgrades` topic notifies connected peers. (c) Catchup timer (every 5min, 30s startup delay) scans all governance proposals for `status:'passed' + category:'upgrade'` and calls `pullAndUpgrade` for any not yet applied. Path C is the safety net — handles offline peers, missed broadcasts, and nodes that joined after the broadcast. If upgrade isn't happening, check `journalctl` for `[upgrade] Catch-up:` messages.

31. **EC2 pando directory is `/opt/pando`, NOT `/opt/pando/node`.** The repo is cloned directly into `/opt/pando`. The monorepo root IS `/opt/pando`. Agents assuming `/opt/pando/node` will get "No such file or directory" errors on every command.

32. **pando-node and pando-teams are apps in AppManager.** `GET /v1/apps` returns them alongside user apps. They are tier 3 (infrastructure) with `governance: true` and `deployAction: 'restart-node'`. This is the unified pipeline — same registry, same history table, same API. However, UpgradeProtocol still runs its own git/build/deploy logic for now (Phases 3-7 will merge them). Don't be confused by the temporary duplication.

33. **Never hardcode PATs in git remote URLs.** Use `ResourceRegistry.resolveGitCredential(repoUrl, userId?)` instead. It resolves contributed credentials dynamically, supports user-scoped PATs for private repos, and injects the token into the URL at call time. The old pattern of extracting PATs from `git remote get-url origin` is deprecated.

34. **Claude Code auth detection checks 3 sources.** `capability-detector.ts` detects Claude Code availability by checking: (a) `ANTHROPIC_API_KEY` env var, (b) `~/.claude/.credentials.json` (OAuth login), (c) `~/.claude/history.jsonl` + `settings.json` (Max/Pro plan auth — no API key or OAuth needed, user is authenticated through their Anthropic subscription). All three are valid auth paths. If any is present, the node advertises `compute_cpu: true` and can run Claude Code agents.

35. **GossipSub allows unverifiable messages from connected peers.** Signed messages from peers who are currently connected via libp2p are allowed through even if the node doesn't have their public key on file. Rationale: transport-level Noise encryption already authenticates the peer's identity at the TCP layer, so application-level signature verification is redundant for connected peers. This fixes the longstanding issue where nodes rejected all GossipSub messages from peers after a restart (because the public key cache was cleared). Only messages from unknown, non-connected peers are rejected.
