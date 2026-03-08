# Council & Team Architecture Roadmap

> Generated: 2026-03-08 | Status: ACTIVE
> This is the working plan for making the council/team system functional.

---

## Current State (Broken)

- Council runs 3 agents: lead (claude-code), observer (gemini), qa (gemini)
- **Lead has 0 tool calls ever** — may not be spawning Claude Code CLI correctly
- **Observer always reports false positives** — threshold expects >2 peers, only 3 nodes exist
- **QA runs 3 API checks** that a shell script could do — never runs actual tests
- **$60/day burn for zero actionable output**
- Total: 49 sessions, 444 messages, 0 code changes, 0 governance proposals by agents

---

## Phase 1: Fix Council to Actually Work

### 1.1 Verify Claude Code CLI Spawns for Lead
- **Problem**: Lead is configured as `model: 'claude-code'` but audit shows budget entries with `model: "google"`. Either CLI isn't available or model routing fails silently.
- **Investigation**: Check `isClaudeCodeAvailable()` on Windows. Check if `claude` CLI is on PATH. Check if the provider fallback silently drops to Gemini.
- **Fix**: Add logging when Claude Code CLI spawn succeeds/fails. If CLI not available, log CRITICAL error instead of silently falling back. Ensure `claude -p` works from the engine-adapter context.

### 1.2 All 3 Agents Should Use Claude Code CLI (Default)
- **Current**: Only lead has `model: 'claude-code'`. Observer/QA default to `gemini-2.5-flash`.
- **Change**: Set `model: 'claude-code'` on ALL three agents in `PANDO_INFRA_AGENTS`.
- **Why**: Claude Code CLI has bash, read, write, edit access. Observer can actually inspect files. QA can actually run tests. Gemini can only call PandoCode tools (which are just HTTP calls).
- **Future**: Model selection will be configurable per-team from the gateway UI.

### 1.3 Fix Observer Threshold
- **Current prompt**: Reports warning when peer count < 3. But network only has 3 nodes.
- **Fix**: Change threshold to report CRITICAL at 0 peers, WARNING at 1 peer, HEALTHY at 2+.
- **Also**: Observer should check actual node health indicators (CPU, memory, disk) not just peer count.

### 1.4 Make QA Run Actual Tests
- **Current**: Calls `pando_status`, `pando_peers`, `pando_list_projects` and analyzes JSON.
- **Fix**: QA prompt should instruct it to run `npx playwright test --project pando-node` and report results. Since it will run on Claude Code CLI, it has bash access.
- **Also**: QA should run `npm run build` to verify compilation. This is real QA, not API polling.

### 1.5 Lead Must Actually Execute Actions
- **Problem**: Lead prompt says "you ARE Claude Code, fix directly" but if it's running on Gemini, it can't.
- **Fix**: Once 1.1/1.2 are done, the lead will have full Claude Code capabilities. Verify by triggering it with a real task and confirming tool calls appear.
- **Test**: Create a board task "[BUG:user] Fix typo in README" and verify the lead actually edits the file, builds, commits, and proposes governance.

---

## Phase 2: PandoCode Web UI — Network Projects

### 2.1 Linked Workspaces Config
- **In pando-code repo**: Add to `PandoCodeConfig`:
  ```typescript
  network?: {
    enabled: boolean;           // toggle for pando-node link
    autoDiscover: boolean;      // scan ~/.pando/teams/ for team DBs
    workspaces?: Array<{
      path: string;             // path to .pando-code.db
      label: string;            // display name
    }>;
  }
  ```
- **pando-code stays standalone** — if network.enabled is false (default), nothing changes.
- **Auto-discovery**: When enabled, scan `~/.pando/teams/*/` for `.pando-code.db` files. Read `~/.pando/teams/teams.db` for team metadata (name, repos, status).

### 2.2 Project Hub — Network Projects Section
- **In pando-code web UI**: Add a "Network Projects" section below local projects on ProjectHub.
- **Each card shows**: Project name (from team repos), team name, agent count, status.
- **Click**: Opens that team's `.pando-code.db` as the active project context.
- **Two projects, one team**: pando-infra manages `pando-lux/node` and `pando-lux/code`. Show as 2 cards, both labeled "Council (pando-infra)".

### 2.3 Settings — Network Toggle
- **In pando-code web UI Settings page**: Add "Pando Node" section.
- **Controls**: On/Off toggle, node URL display, connection status indicator.
- **When ON**: Auto-discover teams, show network projects.
- **When OFF**: Hide network section, don't scan for team DBs.

---

## Phase 3: Agent History & Visibility

### 3.1 Per-Agent Conversation History
- **Data exists**: `.pando-code.db` `messages` table has `agent_id` column.
- **Need**: API endpoint `GET /v1/agents/:id/messages?limit=100` that returns full conversation history filtered by agent_id.
- **Web UI**: Agent detail → new "History" tab showing full conversation with tool calls inline.

### 3.2 Per-Agent Cost Breakdown
- **Data exists**: `budget_usage` table has per-call token/cost data. `sessions` table has agent linkage.
- **Need**: Aggregate cost per agent across sessions.
- **Web UI**: Show cost badge on each agent card (e.g., "$15.14 total").

### 3.3 Model Indicator
- **Data exists**: Each engine has a `modelId`. Agent profiles have `model` field.
- **Web UI**: Show model badge on agent cards (e.g., "claude-code" or "gemini-2.5-flash").

### 3.4 Team Hierarchy View
- **Extend Agents view**: Show team name as header, agents as children.
- **Show**: Team → Lead, Observer, QA with roles, models, costs, last active time.
- **Click agent**: See full detail with history/frames/sessions tabs.

---

## Phase 4: Future — User-Configurable Teams

### 4.1 Model Selection per Team
- Users can select which model their team agents use from the gateway.
- Options: Claude Code CLI (if available), or any LLM provider configured in PandoCode.
- Default: Claude Code CLI for lead, configurable for observer/QA.

### 4.2 Team Creation from Gateway
- Users can create new teams from the public gateway UI.
- Select projects to manage, configure agents (roles, models, prompts).
- Team gets assigned to a node with PandoCode capability.

### 4.3 Team Dashboard in Gateway
- Separate from pando-code web UI — the gateway shows aggregate team data across all nodes.
- Node-level detail delegated to pando-code web UI on the managing node.

---

## BIBLE Updates Needed

### Section 3.2.10: Network Integration (TODO)
Add to BIBLE documenting:
- Linked workspaces concept (generic, filesystem-based)
- Auto-discovery mechanism for team DBs
- Project Hub showing network-managed projects
- Settings toggle for network link
- No @pando/* imports — discovery is config-driven

### Section 5.10: Council/Team Updates
Update to reflect:
- All agents default to Claude Code CLI
- Observer/QA thresholds fixed
- QA runs real tests (Playwright + build)
- Lead executes real actions (edit, build, commit, govern)

---

## Implementation Priority

```
NOW (Phase 1):
  1.1  Verify Claude Code CLI spawning        ← diagnostic first
  1.2  All 3 agents → claude-code model       ← config change
  1.3  Fix observer threshold                 ← prompt fix
  1.4  QA runs real tests                     ← prompt fix
  1.5  Verify lead executes actions           ← integration test

NEXT (Phase 2):
  2.1  Linked workspaces config               ← pando-code repo
  2.2  Network projects in Project Hub        ← pando-code repo
  2.3  Settings network toggle                ← pando-code repo

LATER (Phase 3):
  3.1  Per-agent history API + UI             ← pando-code repo
  3.2  Per-agent cost breakdown               ← pando-code repo
  3.3  Model indicator in UI                  ← pando-code repo
  3.4  Team hierarchy view                    ← pando-code repo

FUTURE (Phase 4):
  4.1  Model selection per team               ← both repos
  4.2  Team creation from gateway             ← gateway + node
  4.3  Team dashboard in gateway              ← gateway
```
