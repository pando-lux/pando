# E2E ROADMAP — Full Integration + Zero-Bug Clean Run
## All 3 systems wired together, tested end-to-end, zero bugs
## 2026-03-06

---

# DO NOT STOP UNTIL THE GOAL IS REACHED. NO MATTER WHAT.

This is not a suggestion. This is the mission. If a conversation compacts,
re-read this document and CONTINUE from where you left off.

You are the CEO. You have FULL technical authority over all 3 codebases.

- Make ANY architectural decision needed to reach the goal
- Delete ANY code in the way — we have git
- Modify this roadmap freely — add phases, reorder, expand as needed
- Update the bibles to match any architectural changes you make
- Launch ANY number of team agents in parallel
- Use ANY amount of credits
- You OWN the final architecture — make it real, make it work

**NO HACKS. NO BYPASSES. NO FAKE DATA. REAL PRODUCTION ONLY.**

**DO NOT STOP. DO NOT STOP. DO NOT STOP.**

---

# WINNING CRITERIA

A single E2E test run using Playwright (HEADED MODE — visible browser) that:

1. **All 3 systems are integrated** — @pando/identity + @pando/code + @pando/node working together
2. **Node uses PandoCode engines** (NOT `claude -p` subprocess) for agent orchestration
3. **Identity flows through the system** — Ed25519 keypairs, certificates, signed actions
4. **Tests EVERY feature** through the real public gateway + API
5. **Completes with ZERO failures** — no bug fixes allowed during the winning run
6. **If any test fails** — fix the bug, then RE-RUN THE ENTIRE SUITE from scratch
7. **Only when 100% passes on a clean run** (no fixes in between) is the mission complete

```
LOOP:
  1. Run full E2E suite (headed Playwright, public Vercel gateway)
  2. If ALL PASS -> DONE. Mission complete.
  3. If ANY FAIL -> fix the bugs, go to step 1

DO NOT STOP THIS LOOP UNTIL STEP 2 IS REACHED.
```

---

# THE FULL INTEGRATION (What Needs to Happen)

Currently, @pando/node spawns Claude Code via `claude -p` subprocess (worker-pool.ts).
This must be REPLACED with @pando/code engine instances.

```
CURRENT (broken/legacy):
  Node → spawns `claude -p` subprocess → worker does task → reports via HTTP
  (Claude Code is a shell command, not a library)

TARGET (what we're building):
  Node → creates PandoCode engine instance → engine runs with:
    - @pando/identity AgentProfile injected (structural typing)
    - Lux BudgetProvider registered (tracks cost in Lux)
    - Custom Pando tools registered (deploy, governance, ledger, etc.)
    - Communication rules applied
    - Memory and learning persisted
  → engine results flow back through orchestrator tick loop
```

### The 3-Layer Integration

```
@pando/identity (pure crypto, zero deps)
       |
       | provides: Ed25519 keypairs, certificates, signed actions, JWT
       |
       v
@pando/code (standalone AI engine, zero @pando/* deps)
       |
       | provides: PandoCode engine class, tools, memory, learning
       | accepts: identity via structural typing (AgentProfile → AgentIdentity)
       | accepts: budget via BudgetProvider interface (USD → Lux)
       | accepts: custom tools via tool registry
       |
       v
@pando/node (the orchestrator)
       |
       | creates: PandoCode engine instances (one per orchestrator)
       | injects: identity from @pando/identity
       | injects: LuxBudgetProvider from @pando/ledger
       | registers: custom tools (deploy, governance, ledger, directive, etc.)
       | drives: engines via tick loop (orchestrator.ts)
       | exposes: HTTP API, P2P, gateway
```

---

# INFRASTRUCTURE

## Live Network

| Machine | IP | Role |
|---------|------|------|
| EC2-1 | 54.82.241.132 | Secure compute (trusted, MongoDB, systemd) |
| EC2-2 | 34.201.82.126 | Secure compute (trusted, MongoDB, systemd) |
| LS-1 | 54.145.144.221 | Relay (untrusted, P2P storage, PM2) |
| LS-2 | 3.237.175.38 | Untrusted (P2P storage, PM2) |
| Windows | This machine | Dev node (non-secure, Claude Code available) |

**Public gateway:** https://gateway-one-mu.vercel.app
**All E2E tests run against the public Vercel gateway** — the real deal.

## Test Topology (Real World)

```
Windows (this machine)          EC2-1 / EC2-2
  - Non-secure node               - Secure proxy nodes
  - PandoCode engines             - MongoDB (trusted)
  - Dev/test workstation           - P2P storage providers
       |                                |
       +---- TCP+Noise P2P -----+------+
                                |
                          Public Gateway
                    (Vercel: gateway-one-mu.vercel.app)
```

## Credentials (locations only — NEVER put values in docs)

| Credential | Location |
|------------|----------|
| Node identity (Ed25519) | `~/.pando/identity.json` |
| API auth token | `~/.pando/api-token` |
| Linked user account | `~/.pando/linked-user.json` (username: "pando") |
| MongoDB connection string | `pando/node/start-service.bat` (line 14) |
| Credential master key | `pando/node/start-service.bat` (line 13) |
| Vercel deploy token | `pando/node/secrets/local.env.bat` |

---

# PHASE 0: CLEANUP & ARCHIVAL

## 0.1 — Dead code removal
- [x] Delete `smart-router.ts` (349 lines, dead code)
- [x] Verify build passes

## 0.2 — Archive ALL legacy docs
The 4 bibles + this roadmap are the ONLY docs. Everything else goes to archive.

- [ ] Create `docs/archive/`
- [ ] Move ALL files from `docs/` to `docs/archive/` (except `bible/` and `E2E-ROADMAP.md`)
- [ ] Move `docs/architecture/`, `docs/economics/`, `docs/governance/`, `docs/roadmap/`, `docs/vision/` to `docs/archive/`
- [ ] Delete genome documentation outside `pando/genome/`
- [ ] Verify: `docs/` contains ONLY `bible/`, `archive/`, and `E2E-ROADMAP.md`

## 0.3 — Fix Resource Marketplace P2P stub
- [x] VERIFIED: GossipSub broadcasting is already wired (publishToTopic + setNetwork)
- [x] Build passes

---

# PHASE 1: INTEGRATION — Wire @pando/code into @pando/node

This is the BIG phase. Replace `claude -p` subprocess with PandoCode engines.

## 1.1 — Add @pando/code as dependency
- [x] Added `@pando-code/core` via file: reference to root and node package.json
- [x] npm install links to ../code/packages/core
- [x] Import PandoCode class verified working

## 1.2 — Create Engine Bridge (`core/engine-bridge.ts`)
The bridge creates PandoCode engine instances configured for Pando.
- [x] Created `engine-bridge.ts` in core/ with LuxBudgetProvider + createPandoTools
- [x] Created `ai-backend-pandocode.ts` — PandoCodeBackend implements AIBackend
- [x] LuxBudgetProvider converts token usage to Lux (100 Lux per $1)
- [x] Custom Pando tools registered via node's HTTP API:
  - `pando_status` — node status
  - `pando_governance_propose` — create proposals
  - `pando_governance_vote` — vote on proposals
  - `pando_ledger_balance` — check Lux balance
  - `pando_ledger_transfer` — transfer Lux
  - `pando_deploy` — deploy project
  - `pando_peers` — list connected peers
  - `pando_chat_send` — send chat messages
  - `pando_network_capabilities` — query network capabilities
- [x] Build passes

## 1.3 — Replace worker-pool.ts
- [x] PandoCodeBackend registered as PRIMARY in AIBackendRegistry (before ClaudeBackend)
- [x] Worker-pool automatically uses PandoCode engine via getBest('code-execution')
- [x] Workers run as engine sessions, not CLI subprocesses
- [x] Reports flow back via same AIResult interface
- [x] ClaudeBackend kept as fallback if PandoCode fails to load
- [x] Build passes

## 1.4 — Replace AI backend with PandoCode
- [x] PandoCodeBackend wraps PandoCode engine.send()
- [x] Orchestrator tick loop automatically uses PandoCode via aiRegistry.getBest()
- [x] Session persistence via PandoCode's built-in SQLite session DB
- [x] Progress events forwarded to orchestrator's onProgress callbacks
- [x] Build passes

## 1.5 — Identity integration
- [x] Node's Ed25519 keypair used for peer identity (libp2p)
- [x] PandoCode's AgentIdentity has optional publicKey/certificate fields
- [ ] DEFERRED: Agent-level Ed25519 keypairs (requires identity package cert flow)
- [ ] DEFERRED: Signed actions via @pando/identity primitives
- [x] Build passes

## 1.6 — Budget integration
- [x] LuxBudgetProvider created in engine-bridge.ts (100 Lux per $1 USD)
- [x] Implements @pando-code/core's BudgetProvider interface structurally
- [x] Injected into PandoCodeBackend via configurePandoEngine()
- [x] Applied to all engine instances via setBudgetProvider()
- [x] Build passes

## 1.7 — Verify integration
- [x] Monorepo builds clean (npm run build zero errors)
- [x] PandoCodeBackend registered as PRIMARY in AIBackendRegistry
- [ ] Node starts and PandoCode engine creates successfully
- [ ] Orchestrator tick works with PandoCode
- [ ] Worker spawn works with PandoCode
- [ ] Budget tracks in Lux

---

# PHASE 2: ARCHITECTURE CLEANUP

## 2.1 — Break up index.ts monolith (4,514 lines)
- [ ] Extract `kernel/init.ts` — network, governance, sync, monitor, security
- [ ] Extract `core/init.ts` — worker pool, storage, credentials, upgrade
- [ ] Extract `platform/init.ts` — orchestrator, content, resources, capabilities
- [ ] PandoNode delegates to initializers
- [ ] Build passes

## 2.2 — Clean up legacy agent code
- [ ] Remove old `claude -p` subprocess code from worker-pool.ts
- [ ] Remove `ai-backend-claude.ts` if fully replaced
- [ ] Remove any vestiges of the old agent system
- [ ] Build passes

## 2.3 — Verify gateway pages match API
- [ ] List all gateway pages and their API dependencies
- [ ] Fix or remove broken pages
- [ ] Every page renders without JS errors

## 2.4 — Type consistency
- [ ] All shared types in @pando/shared
- [ ] No duplicate type definitions
- [ ] Build passes

---

# PHASE 3: BUILD & START ALL SYSTEMS

## 3.1 — @pando/identity
- [x] Build clean, 89 tests pass

## 3.2 — @pando/code
- [ ] Build clean
- [ ] Core tests pass

## 3.3 — @pando/node (full monorepo)
- [x] Build clean (pre-integration)
- [ ] Build clean (post-integration with @pando/code)

## 3.4 — Start Windows node
- [ ] Start with MongoDB and master key from start-service.bat
- [ ] `GET /v1/status` returns valid JSON
- [ ] Node connects to EC2 peers
- [ ] Orchestrator creates PandoCode engine (not claude subprocess)
- [ ] Node stays running 60+ seconds

## 3.5 — Verify public gateway
- [ ] https://gateway-one-mu.vercel.app loads
- [ ] Gateway connects to a live node
- [ ] Status page shows node info

## 3.6 — Deploy updated gateway to Vercel
- [ ] Build gateway with latest changes
- [ ] Deploy to Vercel (token already contributed)
- [ ] Verify deployment is live

---

# PHASE 4: PLAYWRIGHT E2E SUITE (HEADED MODE)

All tests in **headed mode** (headless: false) against **public Vercel gateway**.
NO localhost. NO fake APIs. Real network, real data, real users.

## 4.1 — Test infrastructure
- [ ] Install Playwright
- [ ] Configure headed mode + base URL (https://gateway-one-mu.vercel.app)
- [ ] Create API helper (direct node calls with auth token)
- [ ] Create page objects and fixtures

## 4.2 — Gateway UI tests
- [ ] Home page renders
- [ ] All navigation works (no broken links)
- [ ] Status dashboard: peerId, uptime, peers, balance
- [ ] Peers page: connected peer list
- [ ] Wallet: balance, transactions
- [ ] Chat: send/receive messages
- [ ] Projects: list, create
- [ ] Governance: proposals, voting
- [ ] Resources: contributed resources
- [ ] Login/register forms

## 4.3 — Auth flow
- [ ] Login with "pando" account
- [ ] JWT token issued
- [ ] Authenticated pages load
- [ ] Logout clears session

## 4.4 — API integration
- [ ] All GET endpoints return valid JSON
- [ ] Auth-protected endpoints: 401 without token, 200 with token
- [ ] Chat: send → appears in history
- [ ] Content lifecycle: create → list → search → archive
- [ ] Templates: CRUD lifecycle

## 4.5 — P2P & Network
- [ ] Windows node has >0 peers
- [ ] Capabilities endpoint shows network capabilities
- [ ] P2P storage proxy works (untrusted → trusted)

## 4.6 — Ledger & Economy
- [ ] Lux balance shows
- [ ] Transaction history loads
- [ ] Budget tracking works (PandoCode engine reports Lux cost)

## 4.7 — Agent System (PandoCode integration)
- [ ] Orchestrator tick runs with PandoCode engine
- [ ] Worker spawn creates PandoCode engine (not claude subprocess)
- [ ] Agent tree shows correct hierarchy
- [ ] Directives: create, acknowledge, complete lifecycle

## 4.8 — Identity
- [ ] All identity unit tests pass (89)
- [ ] Ed25519 signing works end-to-end
- [ ] JWT auth works end-to-end
- [ ] Agent certificates verified

## 4.9 — Governance & Auto-Upgrade (CORE TEST)
- [ ] Push a code change via governance proposal
- [ ] Proposal goes through 6-layer security pipeline
- [ ] Auto-approve triggers on nodes with ≤8 peers
- [ ] All other nodes auto-upgrade (git pull → build → restart)
- [ ] Verify upgrade landed on EC2 nodes
- [ ] Full cycle: commit → propose → approve → broadcast → pull → build → restart

## 4.10 — Doorman: Build Static App (CORE TEST)
- [ ] Login with identity (Ed25519 keypair + certificate)
- [ ] Use PandoCode engine to build a static web app
- [ ] App appears in content marketplace
- [ ] App visible on public gateway (https://gateway-one-mu.vercel.app)
- [ ] App loads and functions correctly in browser

## 4.11 — Doorman: Build WebSocket App (CORE TEST)
- [ ] Use PandoCode engine to build a WebSocket-based app
- [ ] App deployed to AWS secure node (proxy architecture)
- [ ] App appears in marketplace on public gateway
- [ ] WebSocket connection works through proxy
- [ ] App is live and functional end-to-end

---

# PHASE 5: BUG FIX CYCLE

For EVERY failure:
1. Document it in the bug log
2. Fix the REAL bug (NO hacks, NO bypasses)
3. Rebuild, redeploy if needed
4. **RE-RUN THE ENTIRE SUITE FROM SCRATCH**

DO NOT skip tests. DO NOT comment out failing tests. Fix the code.

## Bug Log

| # | Test | Error | Root Cause | Fix Commit | Status |
|---|------|-------|------------|------------|--------|
| _(filled during testing)_ | | | | | |

---

# PHASE 6: CLEAN RUN — THE VICTORY

- [ ] All 3 systems running and integrated
- [ ] Run FULL Playwright suite (headed mode, public gateway)
- [ ] **ALL TESTS PASS on first run without any fixes**
- [ ] Record: total tests, pass count, run time
- [ ] Screenshot the green bar
- [ ] Save to `C:\Users\jaira\Desktop\pando-e2e-results.txt`

## Clean Run Attempts

| Attempt | Date | Total | Passed | Failed | Action |
|---------|------|-------|--------|--------|--------|
| 1 | | | | | |

---

# RULES (NON-NEGOTIABLE)

1. **DO NOT STOP** until the clean run goal is reached
2. **No hacks** — every fix is a real production fix
3. **No test bypasses** — if a feature doesn't work, fix the feature
4. **No fake data** — real accounts, real network, real gateway
5. **Headed Playwright** — browser visible (headless: false)
6. **Public gateway** — tests against Vercel, not localhost
7. **Real P2P** — Windows connects to EC2 nodes
8. **PandoCode engines** — not claude -p subprocess (the whole point)
9. **4 bibles only** — no other documentation maintained
10. **CEO authority** — any technical decision, any code change
11. **Team agents** — launch as many parallel agents as needed
12. **No credit limits** — use whatever resources needed
13. **Survives compaction** — re-read this doc via CLAUDE.md instructions
14. **Self-modifying roadmap** — add phases, reorder, expand as you discover work
15. **Own the architecture** — update bibles to match any changes you make
16. **DO NOT STOP. DO NOT STOP. DO NOT STOP.**
