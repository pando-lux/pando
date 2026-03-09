# Self-Upgrade Roadmap — Autonomous Self-Modification Pipeline

> **STATUS: PHASE 1 (commit-and-propose) DONE, PHASE 2 (Mac as 2nd PandoTeams node) DONE** — Phases 3-7 remain TODO.
> **Created:** 2026-03-09 after full live testing session
> **Goal:** Make pando-infra council fully autonomous: detect → edit → build → commit → push → propose → upgrade all nodes

## Current State (Verified 2026-03-09)

### What WORKS (proven with live tests)

- **3-node mesh**: Windows (12D3KooWFR7A) + EC2-1 (54.160.217.16) + EC2-2 (34.201.82.126)
- **Governance auto-upgrade pipeline**: push → propose → auto-approve → GossipSub propagation → EC2 pulls + builds + restarts
- **Unified GitOps**: ALL git operations through `core/git-ops.ts`, zero legacy calls
- **Council receives tasks**: lead agent picks up board tasks, edits files in the real pando repo
- **Gateway web UI**: 15/15 Playwright tests pass, all pages render (council, network, agents, governance, projects, etc.)
- **API pipeline**: 9/9 E2E tests pass (apps, governance, teams, templates, board CRUD, agent spawn/stop)
- **pando-teams + pando-node same upgrade**: `npm run build` compiles entire monorepo

### What DOESN'T WORK (the gaps to fix)

| Gap | Severity | Description |
|-----|----------|-------------|
| **Commit→push loop unreliable** | CRITICAL | Lead agent edits files but doesn't reliably commit+push+propose. Task stays "pending". |
| **Single PandoTeams node** | CRITICAL | Only Windows has Claude Code. EC2 nodes are compute-only. Single point of failure for ALL AI. |
| **Board state lost on migration** | HIGH | Board tasks are local SQLite. `team-state.json` git backup designed but NOT wired. |
| **No engine restart** | HIGH | If Claude Code CLI process dies, agent is gone. No watchdog. Requires node restart. |
| **governanceRequired not enforced** | MEDIUM | Code pushed to GitHub BEFORE governance approval. Flag stored but never checked. |
| **AppManager ignores tier-3** | LOW | `deploy()` and `update()` only handle tier 1-2. Infra upgrades bypass AppManager entirely. |

---

## Phase 1: Fix the Commit→Push Loop (CRITICAL)

**Problem:** The lead agent's prompt tells it to `git add && git commit && git push`, but in practice the Claude Code CLI session either exits mid-chain or doesn't complete all steps.

**Root cause options to investigate:**
1. Claude Code CLI session ends after first tool call (edit), doesn't continue to bash (commit)
2. The agent prompt is too long/complex and the model doesn't follow through
3. No feedback mechanism — agent doesn't know if commit succeeded or failed
4. Task status never updated to "done" (no automatic task completion)

**Possible solutions:**
- **Option A: Atomic commit endpoint** — New `POST /v1/infra/commit-and-propose` that does: git add → build check → git commit → git push → governance propose → update task. One curl call from the agent.
- **Option B: onCommit callback for pando-infra** — Like project workspaces have `makeProjectCommitCallback()`, add one for the infra team that auto-commits and proposes.
- **Option C: Fix agent prompt reliability** — Simplify the prompt, break into smaller steps, add explicit "after editing, you MUST commit" reinforcement.
- **Option D: Post-edit hook** — After any file edit in the pando repo, automatically stage+commit+push (dangerous but reliable).

**Testing:**
1. Send a simple task to council: "Add a comment to file X"
2. Verify: file edited → committed → pushed → governance proposed → all nodes upgrade
3. Must work 3/3 times without human intervention

**Key files:**
- `packages/node/src/core/engine-adapter.ts` — lead agent prompt (lines 560-620), working directory (line 1476)
- `packages/node/src/index.ts` — `makeProjectCommitCallback()` (line 889) — pattern to follow
- `packages/node/src/api/core-api.ts` — where to add new endpoint

---

## Phase 2: Install PandoTeams on EC2 (CRITICAL)

**Problem:** Only Windows has Claude Code binary + @pando-teams/core. If Windows goes down, ALL team automation stops. EC2 orphan detection fires but can't claim teams (no engine).

**Steps:**
1. SSH to EC2-1 (54.160.217.16): install Claude Code CLI binary
2. Set up `ANTHROPIC_API_KEY` env var (or credentials file)
3. Install @pando-teams/core as dependency
4. Change node mode from `compute` to default (so EngineAdapter starts)
5. Restart pando-node on EC2-1
6. Verify: `GET /v1/engines` shows engines on EC2-1

**Failover test:**
1. Stop Windows node
2. Wait for orphan scan (5 min timeout, configurable)
3. Verify EC2-1 claims pando-infra team
4. Submit a task via API to EC2-1
5. Verify lead agent picks it up and processes it
6. Restart Windows — verify no split-brain (latest claimedAt wins)

**Key files:**
- `packages/node/src/platform/capability-detector.ts` — Claude Code detection (lines 46-114)
- `packages/node/src/core/engine-adapter.ts` — EngineAdapter conditional start
- `packages/node/src/init-platform.ts` — node mode check (lines 652-657), orphan scan (lines 660-741)
- `packages/node/src/core/team-registry.ts` — orphan detection, `claimTeam()`, conflict resolution (latest claimedAt wins)

**SSH access:**
```bash
ssh -i ~/.ssh/lightsail-default.pem ubuntu@54.160.217.16
ssh -i ~/.ssh/lightsail-default.pem ubuntu@34.201.82.126
```
**EC2 pando path:** `/opt/pando`
**EC2 process manager:** `sudo systemctl restart pando-node`

---

## Phase 3: Wire Board State Recovery (HIGH)

**Problem:** Board tasks live in local SQLite (~/.pando/teams/{teamId}/.pando-teams.db). If managing node crashes, pending tasks are lost. Recovery path designed but not implemented.

**Design (already in BIBLE.md 5.10.10):**
- After each task update, write `team-state.json` to git in team's workspace
- On team claim by new node: pull repo → read team-state.json → restore board
- Three recovery sources (priority order):
  1. HTTP peer cache (ask old managing node if still alive)
  2. Git team-state.json (durable, versioned)
  3. Fresh start (lose tasks, agents create new ones)

**Implementation plan:**
1. After each board task create/update, serialize board to `~/.pando/teams/{teamId}/team-state.json`
2. In `TeamRegistry.claimTeam()`, after claiming, check for team-state.json and import tasks
3. Add board serialization to the existing `exportTeamState()` pattern (currently removed, needs re-adding)

**Key files:**
- `packages/node/src/core/team-registry.ts` — `claimTeam()` method
- `packages/node/src/core/engine-adapter.ts` — board task operations, `startTeam()`
- `packages/node/src/init-platform.ts` — orphan callback (line 668+)

---

## Phase 4: Engine Watchdog (HIGH)

**Problem:** If a Claude Code CLI process dies, the agent is permanently gone until node restart. No auto-respawn.

**Design:**
1. Add health check timer in EngineAdapter: every 60s, check if each team's lead engine is alive
2. If engine is dead (process exited, no heartbeat for 3 cycles): restart it
3. Preserve session ID if available (24-hour TTL from state table)
4. Log restart event + push activity event

**Implementation:**
- In `engine-adapter.ts`: add `watchdogTimer` that calls `pool.getOrCreate()` for any dead engine
- Track "last activity" timestamp per engine — if no tool calls for 10 min + process dead = restart
- Cap restarts at 3 per hour per engine (circuit breaker to prevent infinite restart loops)

**Current state (from BIBLE.md 5.10.10):**
> "Automatic engine restart — when a CLI process dies, the engine is not restarted. Requires node restart."

**Key files:**
- `packages/node/src/core/engine-adapter.ts` — engine lifecycle, `startTeam()`

---

## Phase 5: Enforce Governance Gate (MEDIUM)

**Problem:** `governanceRequired: true` is stored on pando-infra but never enforced. Code goes to GitHub BEFORE governance vote. Governance only controls deployment to other nodes.

**Options:**
- **Option A (conservative):** Pre-push hook that requires a governance proposal ID before allowing push. Agent creates proposal first, gets approval, then pushes.
- **Option B (current model, documented):** Accept push-before-approval. Governance controls DEPLOYMENT not code. Document this clearly as intentional design choice.
- **Option C (compromise):** Agent pushes to a branch (not master), creates PR. Governance approval merges PR to master. Other nodes only pull from master.

**Recommendation:** Option C is safest. Agents push to `agent/{taskId}` branch, governance merge to master triggers upgrades.

---

## Phase 6: BIBLE.md Updates Needed

| Section | What to add/fix |
|---------|----------------|
| **NEW: 5.10.9b** | "When PandoTeams Process Crashes" — engine pool failure, CLI death detection, board preservation |
| **5.10.10** | Update board replication status when Phase 3 is done |
| **5.8.2** | Note that `governanceRequired` flag is stored but not enforced (honest docs) |
| **10 (Tech Debt)** | Add: commit→push reliability, single PandoTeams node, board recovery, engine watchdog |
| **3.2.9** | Add: Claude Code session failure modes and recovery |
| **Cleanup** | Remove legacy `/v1/council/*` references (7 locations identified) |

---

## Phase 7: Full Autonomous Loop Test (VALIDATION)

After Phases 1-4, run this end-to-end test:

1. **Submit task via gateway UI:** "Fix: add input validation to [some endpoint]"
2. **Verify observer detects** the task and triages it
3. **Verify lead picks up task**, reads relevant code, makes the fix
4. **Verify lead commits and pushes** to GitHub (or branch)
5. **Verify governance proposal created** automatically
6. **Verify proposal auto-approved** (or voted on by other nodes)
7. **Verify all 3 nodes upgrade** to new commit
8. **Kill Windows node** mid-task
9. **Verify EC2-1 claims pando-infra** team within 5 minutes
10. **Verify EC2-1 lead continues processing** queued tasks
11. **Restart Windows** — verify graceful handback (no split-brain)

---

## Architecture Reference

### Self-Modification Flow (target state)
```
User/Observer detects issue
        ↓
Board task created (local SQLite + team-state.json backup)
        ↓
Lead agent picks up task
        ↓
Lead edits code (working dir = pando repo root)
        ↓
Lead runs: npm run build (must pass)
        ↓
Lead calls: POST /v1/infra/commit-and-propose  ← NEW (Phase 1)
  ├── git add <files>
  ├── git commit -m "fix: description"
  ├── git push origin master (or agent branch)
  ├── POST /v1/governance/propose {commitHash, description}
  └── PATCH /v1/teams/pando-infra/board/{taskId} {status: done}
        ↓
Governance auto-approve (single node) or vote (multi-node)
        ↓
GossipSub broadcasts approved proposal to all peers
        ↓
Each node: UpgradeProtocol.pullAndUpgrade()
  ├── git fetch origin
  ├── git reset --hard origin/master
  ├── npm run build
  └── safe restart (waits for active workers to finish)
        ↓
All nodes running new code ✅
```

### Key Files Quick Reference
```
engine-adapter.ts    — Agent prompts, working dirs, startTeam(), templates
team-registry.ts     — P2P team sync, orphan scan, claimTeam()
upgrade-protocol.ts  — pullAndUpgrade(), governance gate, safe restart
init-platform.ts     — Bootstrap, orphan callback, P2P upgrade handler
core-api.ts          — /v1/teams/*, /v1/upgrade/*, /v1/governance/*
kernel-api.ts        — /v1/governance/propose (no auth check — see Phase 5)
git-ops.ts           — ALL git operations, safeGitRef/safeCommitHash
index.ts (PandoNode) — God object, subsystem init, pando-teams registration
capability-detector  — Claude Code binary detection
node-pool.ts         — Gateway multi-node failover
```

### Infrastructure
```
Windows (dev):   P2P 4100, API 4000, PandoTeams ✅, manages pando-infra
EC2-1:           54.160.217.16, P2P 4001, API 4000, compute-only (no PandoTeams)
EC2-2:           34.201.82.126, P2P 4001, API 4000, compute-only (no PandoTeams)
Gateway:         https://gateway-one-mu.vercel.app (Vercel auto-deploy from master)
SSH:             ssh -i ~/.ssh/lightsail-default.pem ubuntu@<IP>
EC2 path:        /opt/pando
EC2 service:     sudo systemctl restart pando-node
```

### Test Suites
```
npx playwright test --project pando-node                           # ALL tests (24 total)
npx playwright test tests/e2e/pando-node/pando-e2e.spec.ts        # API pipeline (9 tests)
npx playwright test tests/e2e/pando-node/gateway-ui.spec.ts       # Gateway UI (15 tests)
```

### Current Commit
```
2e52e42a — Fix gateway UI test: resilient network page assertion (15/15 pass)
```

---

## Session Context (2026-03-09)

### What was done this session:
1. Unified Pipeline Phases 3-7 completed — GitOps class, GitHubClient, ALL files migrated
2. Fixed 3 build errors (governance valGit scope, tui duplicate import, network.ts deprecated config)
3. Fixed gateway stale EC2-1 IP (54.82→54.160)
4. Full live test: 3 nodes upgraded via governance pipeline
5. Created gateway-ui.spec.ts — 15 Playwright tests for web UI
6. Total: 24/24 tests pass, 5 commits pushed

### BIBLE.md was updated with:
- Section 5.8.2: Complete GitOps consumer table (all 13 files)
- `cloneSync()` static method documented
- "Zero git operations outside git-ops.ts" explicit statement
- But still needs Phase 6 updates (above)
