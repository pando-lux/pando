# E2E ROADMAP — Zero-Bug Clean Run
## The mission: all systems running, all features tested, zero bugs
## 2026-03-06

---

# EXECUTIVE AUTHORITY

The AI agent (Claude) executing this roadmap has **CEO-level technical authority**.
- Make ANY technical decisions needed to reach the goal
- NO hacks, NO test-scenario bypasses, NO fake data — real-world production only
- Launch ANY number of team agents in parallel to speed up work
- Use ANY amount of credits needed
- Delete legacy code without hesitation — we have git
- The 4 bibles are the ONLY source of truth (no other docs needed)
- This document persists across conversation compactions via CLAUDE.md instructions

---

# WINNING CRITERIA

A single E2E test run using Playwright (HEADED MODE — visible browser) that:

1. **Starts all systems** — @pando/identity (tests), @pando/node (running), gateway (via public Vercel URL)
2. **Tests EVERY feature** through the real public gateway + API
3. **Completes with ZERO failures** — no bug fixes allowed during the winning run
4. **If any test fails** — fix the bug, then RE-RUN THE ENTIRE SUITE from scratch
5. **Only when 100% passes on a clean run** (no fixes in between) is the mission complete

```
LOOP:
  1. Run full E2E suite (headed Playwright)
  2. If ALL PASS -> DONE. Mission complete.
  3. If ANY FAIL -> fix the bugs, go to step 1
```

---

# INFRASTRUCTURE

## Live Network

| Machine | IP | Role | Access |
|---------|------|------|--------|
| EC2-1 | 54.82.241.132 | Secure compute (trusted, MongoDB, systemd) | SSH via AWS |
| EC2-2 | 34.201.82.126 | Secure compute (trusted, MongoDB, systemd) | SSH via AWS |
| LS-1 | 54.145.144.221 | Relay (untrusted, P2P storage, PM2) | SSH via AWS |
| LS-2 | 3.237.175.38 | Untrusted (P2P storage, PM2) | SSH via AWS |
| Windows | This machine | Dev node (non-secure, Claude Code) | Local |

**Public gateway:** https://gateway-one-mu.vercel.app
**All E2E tests run against the public Vercel gateway** — the real deal, not localhost.

## Test Topology (Real World)

```
Windows (this machine)          EC2-1 / EC2-2
  - Non-secure node               - Secure proxy nodes
  - Claude Code available          - MongoDB (trusted)
  - Dev/test workstation           - No tripwire during dev
  - Untrusted (no MongoDB)         - P2P storage providers
       |                                |
       +---- TCP+Noise P2P -----+------+
                                |
                          Public Gateway
                    (Vercel: gateway-one-mu.vercel.app)
                    Token already contributed
```

## Credentials Location (DO NOT put actual values in this doc)

| Credential | Location |
|------------|----------|
| Node identity (Ed25519) | `~/.pando/identity.json` |
| API auth token | `~/.pando/api-token` |
| Linked user account | `~/.pando/linked-user.json` (username: "pando") |
| MongoDB connection string | `pando/node/start-service.bat` (line 14) |
| Credential master key | `pando/node/start-service.bat` (line 13) |
| Vercel deploy token | `pando/node/secrets/local.env.bat` |
| Guest secret | `~/.pando/guest-secret` |

## User Account for Testing

- Username: `pando` (already linked in `~/.pando/linked-user.json`)
- If a fresh account is needed: sign up via Playwright on the gateway, save details to `C:\Users\jaira\Desktop\pando-test-account.txt`
- Can contribute resources (API keys, hosting tokens) via `/contribute` TUI command or API

---

# PHASE 0: CLEANUP & ARCHIVAL

## 0.1 — Dead code removal
- [x] Delete `packages/node/src/smart-router.ts` (349 lines, dead code)
- [x] Verify build passes

## 0.2 — Archive legacy docs
Move ALL docs except bibles and this roadmap to `docs/archive/`.
The 4 bibles are the ONLY documentation we maintain going forward.

- [ ] Create `docs/archive/` directory
- [ ] Move all files from `docs/` (except `bible/` and `E2E-ROADMAP.md`) to `docs/archive/`
- [ ] Move `docs/architecture/` to `docs/archive/architecture/`
- [ ] Move `docs/economics/` to `docs/archive/economics/`
- [ ] Move `docs/governance/` to `docs/archive/governance/`
- [ ] Move `docs/roadmap/` to `docs/archive/roadmap/`
- [ ] Move `docs/vision/` to `docs/archive/vision/`
- [ ] Delete genome documentation if any exists outside `pando/genome/`
- [ ] Verify: `docs/` contains ONLY `bible/`, `archive/`, and `E2E-ROADMAP.md`

## 0.3 — Fix Resource Marketplace P2P stub
- [ ] Either wire GossipSub broadcasting properly OR strip dead broadcast code
- [ ] Verify build passes

---

# PHASE 1: ARCHITECTURE CLEANUP

Make the current codebase match what the bibles describe. Remove legacy patterns,
dead features, and anything that doesn't serve the current architecture.

## 1.1 — Audit node for legacy patterns
- [ ] Identify features in code that don't match any bible description
- [ ] Identify imports/exports that reference non-existent or deprecated modules
- [ ] List all TODO/FIXME/HACK comments — resolve or delete
- [ ] Check for unused dependencies in package.json

## 1.2 — Clean up the monolith (index.ts — 4,514 lines)
- [ ] Extract kernel initialization into `kernel/init.ts`
- [ ] Extract core initialization into `core/init.ts`
- [ ] Extract platform initialization into `platform/init.ts`
- [ ] PandoNode class delegates to these, stays as orchestrator
- [ ] Build passes, no behavior change

## 1.3 — Verify gateway pages match current API
- [ ] List all gateway pages and their API dependencies
- [ ] Identify pages that call non-existent or changed API endpoints
- [ ] Fix or remove broken gateway pages
- [ ] Verify every page renders without JS errors

## 1.4 — Verify shared types consistency
- [ ] All types used across packages are defined in @pando/shared
- [ ] No duplicate type definitions across packages
- [ ] Build passes after type cleanup

---

# PHASE 2: BUILD & START ALL SYSTEMS

## 2.1 — @pando/identity
- [x] Build compiles clean
- [x] All 89 tests pass

## 2.2 — Full monorepo build
- [x] `npm run build` — all packages build clean

## 2.3 — Start Windows node
- [ ] Start node with MongoDB: `set PANDO_STORAGE_URL=<from start-service.bat> && set CREDENTIAL_MASTER_KEY=<from start-service.bat> && node packages/node/dist/cli.js --port 4100 --api-port 4000`
- [ ] `GET http://localhost:4000/v1/status` returns valid JSON
- [ ] Node stays running for 60+ seconds without crash
- [ ] Node connects to EC2 peers via P2P

## 2.4 — Verify public gateway
- [ ] https://gateway-one-mu.vercel.app loads
- [ ] Gateway connects to a live node
- [ ] Status page shows node info

## 2.5 — Contribute resources (if not already done)
- [ ] Verify Vercel token is contributed (`/contribute vercel <token>`)
- [ ] Verify any needed API keys are contributed
- [ ] Verify resources show up in `/resources`

---

# PHASE 3: PLAYWRIGHT E2E SUITE (HEADED MODE)

All tests run in **headed mode** (visible browser window) against the
**public Vercel gateway** (https://gateway-one-mu.vercel.app).

NO localhost testing. NO fake APIs. Real network, real data, real users.

## 3.1 — Test infrastructure setup
- [ ] Install Playwright: `npm init playwright@latest` in test directory
- [ ] Configure headed mode (headless: false)
- [ ] Configure base URL: https://gateway-one-mu.vercel.app
- [ ] Create API helper for direct node API calls (localhost:4000 with auth token)
- [ ] Create test fixtures (login state, page objects)

## 3.2 — Gateway UI tests
- [ ] Home/landing page renders correctly
- [ ] Navigation: all menu items work, no broken links
- [ ] Status/dashboard: shows peerId, uptime, peers, balance
- [ ] Peers page: displays connected peers
- [ ] Wallet page: shows Lux balance, transaction history
- [ ] Chat page: send message, see response
- [ ] Projects page: list projects
- [ ] Governance page: list proposals, vote UI
- [ ] Resources page: list contributed resources
- [ ] Register/login page: form works

## 3.3 — Auth flow tests
- [ ] Register new account (or verify existing "pando" account)
- [ ] Login with credentials
- [ ] JWT token received and stored
- [ ] Authenticated pages load with user context
- [ ] Logout clears session

## 3.4 — API integration tests
- [ ] All GET endpoints return valid JSON
- [ ] Auth-protected endpoints reject without token (401)
- [ ] Auth-protected endpoints accept with valid token
- [ ] Chat: send message -> appears in history
- [ ] Content: create -> list -> search -> archive lifecycle
- [ ] Templates: list -> create -> update -> delete lifecycle

## 3.5 — P2P & Network tests
- [ ] Windows node sees EC2 peers in peer list
- [ ] Status endpoint shows >0 connected peers
- [ ] Capabilities endpoint shows network capabilities

## 3.6 — Ledger & Economy tests
- [ ] Account exists with Lux balance
- [ ] Transaction history loads
- [ ] Transfer Lux between accounts (if testable)

## 3.7 — Node lifecycle tests
- [ ] Node starts cleanly
- [ ] Health check endpoint responds
- [ ] Node survives 5 min continuous operation
- [ ] Graceful shutdown

---

# PHASE 4: BUG FIX CYCLE

For each test failure:
1. Document the failure (test name, error, root cause)
2. Fix the bug in the actual code (NO hacks, NO bypasses)
3. Rebuild and redeploy if needed
4. RE-RUN THE ENTIRE SUITE from scratch

## Bug Log

| # | Test | Error | Root Cause | Fix Commit | Status |
|---|------|-------|------------|------------|--------|
| _(discovered during testing)_ | | | | | |

---

# PHASE 5: CLEAN RUN

The victory condition.

- [ ] All systems running (node, gateway, P2P connected)
- [ ] Run FULL Playwright suite in headed mode
- [ ] **ALL TESTS PASS on first run without any fixes**
- [ ] Record: total tests, pass count, run time
- [ ] Screenshot the green bar
- [ ] Save results to `C:\Users\jaira\Desktop\pando-e2e-results.txt`

## Clean Run Attempts

| Attempt | Date | Total | Passed | Failed | Failures | Action |
|---------|------|-------|--------|--------|----------|--------|
| 1 | | | | | | |

---

# RULES (NON-NEGOTIABLE)

1. **No hacks** — Every fix must be a real production fix
2. **No test bypasses** — If a feature doesn't work, fix the feature, don't skip the test
3. **No fake data** — Real accounts, real network, real gateway
4. **Headed Playwright** — Browser must be visible (headless: false)
5. **Public gateway** — Tests run against Vercel deployment, not localhost
6. **Real P2P** — Windows node must connect to EC2 nodes
7. **4 bibles only** — No other documentation is maintained or referenced
8. **CEO authority** — Make any technical decision needed to reach the goal
9. **Team agents** — Launch as many parallel agents as needed
10. **No credit limits** — Use whatever resources needed
11. **Conversation survives compaction** — This doc is re-read via CLAUDE.md instructions
