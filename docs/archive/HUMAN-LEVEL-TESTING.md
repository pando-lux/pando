# Human-Level Logical Testing

> **STATUS: PARTIALLY STALE** — Scenarios 1-10 reference legacy `/v1/council/*` endpoints. The live system now uses `/v1/teams/pando-infra/*` endpoints (team architecture). Scenarios 12-14 reference the correct team endpoints. Use this as a conceptual test plan, not as copy-paste commands.

> These are not smoke tests. Each scenario tests a real-world flow end-to-end,
> the way a human would verify the system actually works. Run these manually
> or automate via Playwright + API calls.

## Prerequisites

- pando-node running on localhost:4000 (with supervisor)
- PandoTeams server running on localhost:4873
- PandoTeams dashboard on localhost:5173
- At least 1 EC2 peer connected
- Council agents enabled (`--council` flag or config)

---

## Scenario 1: Council Detects and Reports

**What:** Observer and QA ticks fire, detect real state, report to council.

**Steps:**
1. Trigger observer manually: `POST /v1/council/trigger/observer`
2. Verify observer calls `pando_status` and `pando_peers` (check console logs)
3. Verify observer sends message to council if issues found (or says "healthy" if not)
4. Trigger QA manually: `POST /v1/council/trigger/qa`
5. Verify QA runs health checks and reports findings
6. Trigger council: `POST /v1/council/trigger/council`
7. Verify council reads inbox via `check_agents(inbox)`
8. Verify council processes messages and creates/updates board tasks

**Pass criteria:**
- Observer and QA produce specific, actionable reports (not generic text)
- Council reads its inbox and acts on messages
- Board tasks created with proper `[SEVERITY:CATEGORY]` format

---

## Scenario 2: User Report to Board Task

**What:** A user submits a bug report via gateway, it lands on the council board.

**Steps:**
1. Open gateway `/council` page
2. Submit: "The wallet page shows wrong balance after a transfer"
3. Verify 200 response with taskId
4. Check board: `GET /v1/council/board`
5. Verify task exists with title `[BUG:user] The wallet page shows wrong balance...`
6. Trigger council and verify it acknowledges the new task

**Pass criteria:**
- Task appears on board within 1 second
- Council processes it on next tick
- No duplicate tasks for same report

---

## Scenario 3: Two Laws Rejection

**What:** Harmful content is blocked at every level.

**Steps:**
1. Submit via API: `POST /v1/council/request` with `"kill all humans"`
2. Verify 403 with Law I violation message
3. Submit: `"destroy the entire network"`
4. Verify 403 with Law II violation message
5. Submit safe message: `"fix the login page bug"`
6. Verify 200 with taskId

**Pass criteria:**
- Harmful messages never reach the board
- Safe messages pass through normally
- Defense-in-depth: even if API check bypassed, `insertBoardTask()` rejects

---

## Scenario 4: Council Spawns Builder and Fixes Code

**What:** Council receives a bug, spawns a builder sub-agent, builder fixes the code.

**Steps:**
1. Create a deliberate bug: add `console.log("DELIBERATE_BUG_MARKER")` to a non-critical file
2. Commit and push the bug
3. Submit bug report: "There is a DELIBERATE_BUG_MARKER console.log that should be removed"
4. Trigger council
5. Verify council:
   a. Reads the bug report from board
   b. Calls `pando_workspace({ repo: "pando-lux/node" })` to get working directory
   c. Calls `spawn_agent({ role: "builder", task: "Remove DELIBERATE_BUG_MARKER..." })`
6. Verify builder:
   a. Finds the file with the marker
   b. Removes the line
   c. Runs `npm run build` to verify fix
   d. Commits the change
   e. Pushes to origin

**Pass criteria:**
- Builder produces a clean commit that removes only the marker
- Build passes after the fix
- No unrelated changes in the commit
- Council marks the board task as done

---

## Scenario 5: Governance Approval

**What:** After builder fixes code, council proposes via governance, it gets approved.

**Steps:**
1. Complete Scenario 4 (builder pushes fix)
2. Verify council calls `pando_governance_propose({ title, description, commitHash })`
3. Check governance: `GET /v1/governance/proposals`
4. Verify proposal exists with correct commit hash
5. In dev mode (<=8 peers): verify auto-approval
6. Check upgrade broadcast: watch node logs for `[upgrade]` messages

**Pass criteria:**
- Proposal created with meaningful title and description
- Auto-approved in dev mode
- Commit hash in proposal matches the actual fix commit
- Upgrade broadcast sent to all peers via GossipSub

---

## Scenario 6: Auto-Upgrade (Remote Nodes)

**What:** After governance approves, remote nodes pull the fix, build, and restart.

**Steps:**
1. Complete Scenario 5 (governance broadcasts upgrade)
2. On EC2 node: watch logs for `[upgrade] Fetching latest code...`
3. Verify EC2 node:
   a. `git fetch origin master`
   b. Verifies commit hash matches governance approval
   c. `git reset --hard origin/master`
   d. `npm run build` passes
   e. Safe restart: checks 0 active workers, 0 pending messages
   f. Exits with code 75
4. Supervisor respawns the process
5. New process boots with updated code
6. Verify: `GET /v1/status` on EC2 shows new commitHash

**Pass criteria:**
- EC2 node upgrades within 5 minutes of governance broadcast
- No data loss during restart
- Node reconnects to P2P network after restart
- commitHash in status matches the fix commit

---

## Scenario 7: Self-Upgrade (Proposer Node)

**What:** The node that pushed the fix also upgrades itself.

**Steps:**
1. Complete Scenario 5
2. Proposer node receives its own governance broadcast
3. `pullAndUpgrade` detects: HEAD already matches target commit
4. Detects: runningCommit (old) !== current HEAD (new)
5. Safe restart triggered
6. Supervisor respawns → node boots with new compiled code
7. Council re-initializes with persistent Claude Code session

**Pass criteria:**
- Proposer node restarts itself (not just remote nodes)
- No infinite restart loop
- Council resumes from where it left off (persistent session)
- Board tasks survive the restart

---

## Scenario 8: Council Survives Restart

**What:** After auto-upgrade restart, council resumes and retains context.

**Steps:**
1. Before restart: note council board tasks, memory count, session IDs
2. Trigger a restart (kill node process, let supervisor respawn)
3. After restart: verify council agents re-initialize
4. Check: `GET /v1/council/status` shows active=true with engines
5. Check: `GET /v1/council/board` shows same tasks as before
6. Trigger council and verify it can still read its inbox and process tasks

**Pass criteria:**
- Council is active within 30 seconds of restart
- Board tasks persist (SQLite DB not wiped)
- Claude Code session can be resumed (or starts fresh gracefully)
- Scheduler ticks resume on schedule

---

## Scenario 9: Rate Limiting Under Load

**What:** Multiple rapid requests are properly rate-limited.

**Steps:**
1. Send 4 rapid `POST /v1/council/request` (limit is 3/hour)
2. First 3 succeed (200)
3. 4th returns 429 with dynamic Retry-After header
4. Verify Retry-After value is reasonable (seconds until window expires)
5. Send requests from different IP → verify independent limits

**Pass criteria:**
- Exactly 3 allowed, 4th blocked
- Retry-After header present and accurate
- Per-IP isolation works

---

## Scenario 10: Full Autonomous Loop (The Big One)

**What:** Complete self-sustaining cycle with zero human intervention after initial trigger.

**Steps:**
1. Introduce a deliberate small bug (e.g., typo in a log message)
2. Commit and push
3. Submit bug report via gateway: describe the bug
4. Wait. Do not intervene.
5. Monitor:
   a. Council tick fires (within 15 min)
   b. Council reads bug report from board
   c. Council spawns builder
   d. Builder fixes the bug
   e. Builder commits and pushes
   f. Council proposes via governance
   g. Governance auto-approves
   h. Upgrade broadcast sent
   i. All nodes (including proposer) pull, build, restart
   j. Council re-initializes
   k. Council marks the board task as done
   l. Next observer/QA tick confirms system is healthy

**Pass criteria:**
- Bug is fixed without any human touching the code
- All nodes running the fixed version
- Council board task marked done
- Total time: under 30 minutes
- No crashes, no infinite loops, no stale state

---

## Scenario 11: Packaged Installation Auto-Upgrade

**What:** The system runs via Electron/installer (not a dev clone). It must still
download the latest code from GitHub, build, and upgrade — using the same
project management pipeline (pando_workspace) that already handles git repos.

**Architecture:**
- The installed app ships with a bundled pando-node + pando-teams
- On first run: clones both repos to `~/.pando/repos/node` and `~/.pando/repos/code`
- pando_workspace({ repo: "pando-lux/node" }) → returns the local clone path
- Upgrade protocol: git pull → build → safe restart
- Same supervisor (exit 75 → respawn) works whether run from dev or installer

**Steps:**
1. Simulate packaged install: set repoDir to `~/.pando/repos/node`
2. Verify `pando_workspace({ repo: "pando-lux/node" })` clones if not exists
3. Verify council builder can work in the cloned repo
4. Verify upgrade protocol runs `git pull` + `npm run build` in the cloned path
5. Verify restart picks up new code from the cloned path

**Pass criteria:**
- Works identically whether running from dev checkout or cloned repo
- No hardcoded paths — all resolved dynamically
- Upgrade works without dev tools (node + git only required)

---

## Scenario 12: Full E2E — Team Pipeline + Auto-Upgrade + Persistent Session (THE BIG ONE)

> **Current goal.** This is the test we are actively building toward.
> Status: IN PROGRESS (2026-03-08)
> Architecture: docs/TEAM-ARCHITECTURE.md (approved, not yet implemented)
> NOTE: Current test runs on LEGACY council endpoints. After team architecture
> is implemented, endpoints change from /council/* to /teams/pando-infra/*.

**What:** Prove the entire self-sustaining loop end-to-end with NO manual intervention
after the initial request. Council spawns on-demand, clones repos, makes a real code
change, pushes, governance approves, ALL nodes upgrade, council survives restart and
handles a second request.

**Prerequisites:**
- 3-node network: Windows (local) + EC2-1 (54.82.241.132) + EC2-2 (34.201.82.126)
- All nodes connected (2+ peers each)
- Public gateway: https://gateway-one-mu.vercel.app
- Windows node has PandoTeams available (@pando-teams/core installed)
- Council is NOT running (simulating Electron/installer mode — no `--council` flag)

### Phase A: Setup — Council Offline

**Steps:**
1. Stop council on Windows node (or start node without council)
2. Verify: `GET /v1/council/board` returns `{ error: 'Council not running' }`
3. Verify: all 3 nodes are connected and healthy via `GET /v1/status`
4. Record git HEAD on all 3 nodes (should be same commit)

**Pass:** Council is offline but network is healthy.

### Phase B: Submit Request — Council Spawns On-Demand

**Steps:**
1. Submit a request via gateway (or direct API):
   `POST /v1/council/request` with `{ "message": "Add a comment to cli.ts that says: // Council E2E test marker — {timestamp}" }`
2. Node receives request. Council is not running. But PandoTeams IS available.
3. Node auto-spawns council to handle the queued request.
4. Verify: `GET /v1/council/board` shows the task as `pending`
5. Council activates, reads board, sees the task.

**Pass:** Council spawns on-demand. Task appears on board. No 503 error.

### Phase C: Council Makes the Change

**Steps:**
1. Council reads the task from board
2. Council calls `pando_workspace({ repo: "pando-lux/node" })`:
   - If repo exists locally → git pull (updates to latest)
   - If fresh clone → git clone from GitHub
3. Council spawns a builder sub-agent with `working_directory` = workspace path
4. Builder:
   a. Reads `packages/node/src/cli.ts`
   b. Adds the comment line
   c. Runs `npm run build` — must pass
   d. `git add` + `git commit -m "fix: council E2E test marker"`
   e. `git push origin master`
5. Council gets commit hash from `git rev-parse HEAD`
6. Council proposes governance:
   `curl POST http://127.0.0.1:4000/v1/governance/propose`
   Body: `{ "title": "[Upgrade] fix: council E2E test marker", "description": "Security fix: ...", "commitHash": "<hash>" }`
7. Council marks the board task as `done`

**Pass:** Commit pushed to GitHub. Governance proposal created and auto-approved.

### Phase D: All Nodes Auto-Upgrade

**Steps:**
1. Governance auto-approves (<=8 peers)
2. Windows node: `pullAndUpgrade()` runs → detects proposer (already at commit) → safe restart
3. EC2-1 & EC2-2: receive upgrade via GossipSub broadcast OR catchup timer (5min)
   - `git fetch origin master`
   - Hash verification passes
   - `git reset --hard origin/master`
   - `npm install` + `npm run build`
   - Safe restart (exit 75 → supervisor respawns)
4. Verify all 3 nodes at new commit:
   - `GET /v1/status` on each → check version/commitHash
   - `ssh ubuntu@54.82.241.132 "sudo -u pando bash -c 'cd /opt/pando && git log --oneline -1'"`
   - `ssh ubuntu@34.201.82.126 "sudo -u pando bash -c 'cd /opt/pando && git log --oneline -1'"`

**Pass:** All 3 nodes running the new commit. Upgrade took < 10 minutes.

### Phase E: Second Request — Council Persistent Session

**Steps:**
1. Wait for Windows node to restart after upgrade
2. Submit a SECOND request:
   `POST /v1/council/request` with `{ "message": "Add another comment to cli.ts: // Council persistent session test — {timestamp}" }`
3. Council should still be active (persistent session from Phase B/C)
4. Council processes the new task — reads board, sees new task + completed old task
5. Council spawns builder again, makes the change, commits, pushes
6. Governance proposal → auto-approve → all 3 nodes upgrade again

**Pass:**
- Council has context from Phase C (persistent session or graceful restart)
- Board shows BOTH tasks (first = done, second = in_progress then done)
- All 3 nodes upgrade to second commit
- No crashes, no infinite restart loops

### Phase F: Verify Final State

**Steps:**
1. Check board: `GET /v1/council/board` — both tasks visible (done)
2. Check governance: `GET /v1/governance/proposals` — both upgrade proposals passed
3. Check cli.ts on all nodes — both comment markers present
4. Check EC2 logs: `journalctl -u pando-node | grep upgrade` — clean upgrade entries
5. Check peers: all 3 nodes still connected

**Pass:** System is fully self-sustaining. Two complete autonomous cycles completed.

### What This Proves

- Council spawns on-demand (no need to pre-configure)
- Council clones/pulls repos dynamically (works from fresh install)
- Builder sub-agents work in cloned workspace
- Governance pipeline works end-to-end
- Auto-upgrade reaches ALL nodes (Windows + EC2)
- Council survives node restart (persistent session)
- Board tasks persist across restarts
- Second autonomous cycle works (not a one-time fluke)

### Known Gotchas (from 2026-03-07 debugging)

- EC2 file ownership must be `pando:pando` (not ubuntu) — see BIBLE Section 14 #25
- Governance endpoint is `/v1/governance/propose` (not `/proposals`) — BIBLE #27
- `git diff HEAD~1 HEAD` (two-arg form) — BIBLE #26
- AI review is advisory only — BIBLE Section 5.4
- `npm install` before build — BIBLE #28
- EC2 path is `/opt/pando` (not `/opt/pando/node`) — BIBLE #31

---

## Scenario 13: User Project — Build + Deploy + Update via Team

> **Depends on:** Team architecture implementation (Scenario 12 tests legacy).
> Status: PLANNED

**What:** A user asks the network to build an app. The system creates a project
and a team with 1 agent. Agent builds, deploys. User requests an update.
Same team handles it. No governance needed (direct deploy).

### Phase A: Build Request

**Steps:**
1. POST gateway chat: "Build me a simple landing page for a coffee shop"
2. Doorman classifies: intent "build", tier 1 (static)
3. `findBestBuilder()` picks PandoTeams-capable node
4. Project created in ProjectStore + team created in TeamRegistry
5. Team agent builds the page, creates GitHub repo
6. Deploy pipeline: push to GitHub → EC2 clones → S3 upload
7. Verify: `GET /v1/projects` shows project with deployment URL
8. Verify: deployment URL loads the landing page

**Pass:** Page deployed and accessible. Team exists in registry.

### Phase B: Update Request

**Steps:**
1. POST gateway chat (same thread): "Add a dark mode toggle"
2. Node finds existing team for this project in registry
3. Routes to managing node (may be same or different)
4. Team agent reads board, sees update request
5. Agent makes changes, commits, pushes, redeploys
6. Verify: dark mode toggle visible on deployed page

**Pass:** Update deployed. Same team handled it (no new team created).

### Phase C: Verify No Governance

**Steps:**
1. `GET /v1/governance/proposals` — no new proposals (direct deploy, not governance)
2. `GET /v1/teams` — team exists with `governanceRequired: false`
3. Project deployment works without governance approval

**Pass:** User projects bypass governance. Only infra teams use governance.

---

## Scenario 14: Node Death + Team Handoff

> **Depends on:** 2 PandoTeams-capable nodes on the network.
> Status: PLANNED (deferred — only Windows has PandoTeams currently)

**What:** Node managing a team goes offline. Another PandoTeams node detects
the orphaned team, claims it, recovers board from git, resumes processing.

### Phase A: Setup
1. Node A manages team "test-handoff" with active board tasks
2. Verify team is active: `GET /v1/teams/test-handoff` shows managing_node = A

### Phase B: Kill Node A
1. Stop Node A (kill process, no graceful shutdown)
2. Wait 5 minutes for heartbeat to go stale

### Phase C: Handoff Detection
1. Node B detects orphaned team (orphan scan or peer disconnect)
2. Node B claims team: updates registry, broadcasts
3. Node B clones/pulls repo → reads `.pando/team-state.json`
4. Node B seeds local board from team-state.json
5. Node B spawns team agents

### Phase D: Verify Continuity
1. `GET /v1/teams/test-handoff` shows managing_node = B
2. Board shows same tasks from before (recovered from git)
3. Submit new request → team processes it on Node B
4. If Node A comes back → sees it lost the claim → does NOT re-claim

**Pass:** Team resumed on new node. Board recovered. No data loss.

---

## Future Scenarios (not yet testable)

### Scenario F1: Gateway-Driven Fixes
User submits a detailed fix suggestion from the gateway. Team evaluates it,
implements it if valid, and deploys. Human role = advisor, not operator.
**This is the ultimate goal:** users never touch code. They describe what they want
or what's broken. The team handles everything.

### Scenario F2: Cross-Repo Fixes
Team detects a bug in pando-teams (not pando-node). Spawns a builder
targeting the pando-teams repo. Fix goes through pando-teams governance.
Both repos upgrade independently.

### Scenario F3: Rollback on Build Failure
Builder pushes a bad fix. Build fails on remote nodes. UpgradeProtocol
rolls back to previous commit. Team is notified of the failure and
spawns a new builder to try again.

### Scenario F4: Team Growth Under Load
Team lead detects backlog > 10 tasks. Spawns additional permanent agents
(not just temporary builders). Updates team config, broadcasts to registry.
Load distributes across agents. Lead removes agents when backlog clears.

---

## Running These Tests

**Manual (current — legacy council endpoints):**
```bash
# Trigger individual agents
curl -X POST http://127.0.0.1:4000/v1/council/trigger/observer
curl -X POST http://127.0.0.1:4000/v1/council/trigger/qa
curl -X POST http://127.0.0.1:4000/v1/council/trigger/council

# Check board
curl http://127.0.0.1:4000/v1/council/board | jq

# Submit bug report
curl -X POST http://127.0.0.1:4000/v1/council/request \
  -H "Content-Type: application/json" \
  -d '{"message": "description of the issue"}'

# Check governance proposals
curl http://127.0.0.1:4000/v1/governance/proposals | jq

# Check upgrade status
curl http://127.0.0.1:4000/v1/upgrade/status | jq
```

**After team architecture (future endpoints):**
```bash
# List all teams
curl http://127.0.0.1:4000/v1/teams | jq

# Check pando-infra board
curl http://127.0.0.1:4000/v1/teams/pando-infra/board | jq

# Submit request to pando-infra
curl -X POST http://127.0.0.1:4000/v1/teams/pando-infra/request \
  -H "Content-Type: application/json" \
  -d '{"message": "description of the issue"}'

# Trigger pando-infra lead
curl -X POST http://127.0.0.1:4000/v1/teams/pando-infra/trigger
```

**Automated (future):**
These scenarios should eventually be Playwright specs in `tests/e2e/teams/`.
Each scenario = one test file. Long timeouts (5-30 min per scenario).
