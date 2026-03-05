# E2E ROADMAP — Zero-Bug Clean Run
## The overnight mission: all 3 systems running, all features tested, zero bugs
## 2026-03-06

---

# WINNING CRITERIA

A single E2E test run using Playwright that:

1. **Starts all 3 systems** — @pando/identity (tests), @pando/node (running node), gateway (browser UI)
2. **Tests EVERY feature** through the browser (gateway) and API
3. **Completes with ZERO failures** — no bug fixes allowed during the winning run
4. **If any test fails** — fix the bug, then RE-RUN THE ENTIRE SUITE from scratch
5. **Only when 100% passes on a clean run** (no fixes in between) is the mission complete

```
LOOP:
  1. Run full E2E suite
  2. If ALL PASS → DONE. Mission complete.
  3. If ANY FAIL → fix the bugs, go to step 1
```

The goal is NOT "fix bugs until tests pass." The goal is "reach a state where
everything works on the FIRST try." Each bug fix restarts the clock.

---

# THE 3 SYSTEMS

| System | Location | How to Start | What to Test |
|--------|----------|-------------|--------------|
| @pando/identity | `pando/node/packages/identity/` | `npm run test` (vitest) | All 89+ unit tests pass |
| @pando/node | `pando/node/` | `node packages/node/dist/cli.js --port 4001 --api-port 4000` | HTTP API, P2P, ledger, governance |
| Gateway | `pando/node/packages/gateway/` | `PANDO_NODE_URL=http://localhost:4000 npx next dev --port 3222` | All UI pages, all features via browser |

**@pando/code is NOT part of this E2E** — it's a separate standalone product.
It will be integrated in Phase E (node↔code bridge) which is future work.

---

# PHASE 0: CLEANUP (pre-requisite)

Remove dead code and known issues before testing. No point testing broken things.

- [x] Delete `packages/node/src/smart-router.ts` (349 lines, dead code — never imported)
- [x] Verify no references remain (grep clean)
- [x] Verify `npm run build` still passes after cleanup
- [ ] Fix Resource Marketplace GossipSub broadcasting stub (wire it or remove the dead broadcast code)

---

# PHASE 1: BUILD & VERIFY

Get all systems building and starting cleanly.

## 1.1 — @pando/identity
- [x] `cd packages/identity && npm run build` — compiles clean
- [x] `cd packages/identity && npm test` — all 89 tests pass (11 files, 1.2s)
- [x] No test failures

## 1.2 — Full monorepo build
- [x] `cd pando/node && npm run build` — all packages build clean (shared → identity → ledger → node → gateway → mcp-server)
- [x] No build errors

## 1.3 — Start node
- [ ] `node packages/node/dist/cli.js --port 4001 --api-port 4000` starts without crash
- [ ] `GET http://localhost:4000/v1/status` returns valid JSON
- [ ] Node stays running for 60+ seconds without crash
- [ ] Document any startup errors here: _(fill in as discovered)_

## 1.4 — Start gateway
- [ ] `cd packages/gateway && PANDO_NODE_URL=http://localhost:4000 npx next dev --port 3222` starts
- [ ] `http://localhost:3222` loads in browser
- [ ] Gateway connects to node (no connection errors in console)
- [ ] Document any gateway errors here: _(fill in as discovered)_

---

# PHASE 2: MANUAL SMOKE TEST

Before writing Playwright tests, verify core features work manually.

## 2.1 — Gateway UI pages
- [ ] Home page loads
- [ ] Status/dashboard page shows node info
- [ ] Peers page loads (may show 0 peers — OK for local)
- [ ] Wallet/balance page loads
- [ ] Chat page loads
- [ ] Projects page loads
- [ ] Governance/proposals page loads
- [ ] Settings/contribute page loads

## 2.2 — API endpoints
- [ ] `GET /v1/status` — returns node health
- [ ] `GET /v1/peers` — returns peer list
- [ ] `GET /v1/capabilities` — returns capability profile
- [ ] `GET /v1/gateways` — returns gateway list
- [ ] `GET /v1/scenarios` — returns test scenarios
- [ ] `GET /v1/agents/tree` — returns agent hierarchy
- [ ] `GET /v1/templates` — returns agent templates
- [ ] `GET /v1/content/list` — returns content list
- [ ] `POST /v1/chat/message` — sends a message (requires auth)
- [ ] `GET /v1/chat/history` — returns chat history

## 2.3 — Identity operations
- [ ] Login flow works (if account exists)
- [ ] Wallet shows correct Lux balance
- [ ] Keypair generation works

---

# PHASE 3: PLAYWRIGHT E2E TEST SUITE

Write comprehensive Playwright tests covering all features.

## 3.1 — Test infrastructure setup
- [ ] Install Playwright in the monorepo (or use existing)
- [ ] Create test config: start node + gateway before tests, tear down after
- [ ] Create helper utilities (API client, page objects)

## 3.2 — Gateway UI tests
- [ ] Home page renders correctly
- [ ] Navigation works (all menu items lead to correct pages)
- [ ] Status dashboard shows node info (peerId, uptime, peers, balance)
- [ ] Peers page displays peer list
- [ ] Wallet page shows balance and transaction history
- [ ] Chat page: can send a message, see it appear
- [ ] Projects page: list projects
- [ ] Governance page: list proposals
- [ ] Settings page: contribute resources form

## 3.3 — API integration tests (via Playwright fetch)
- [ ] All GET endpoints return valid JSON with correct schema
- [ ] Auth-protected endpoints reject without token
- [ ] Auth-protected endpoints accept with valid token
- [ ] Chat message flow: send → appears in history
- [ ] Agent spawn → appears in agent tree
- [ ] Content lifecycle: create → list → search → archive

## 3.4 — Identity tests
- [ ] Identity package: all unit tests pass (run as part of suite)
- [ ] Login/logout flow via gateway
- [ ] JWT token issuance and validation
- [ ] Keypair operations (generate, encrypt, decrypt)

## 3.5 — Ledger tests
- [ ] Account creation
- [ ] Balance queries
- [ ] Transaction history
- [ ] Emission tracking

## 3.6 — Node lifecycle tests
- [ ] Node starts cleanly
- [ ] Node responds to health checks
- [ ] Node survives 5 minutes of continuous operation
- [ ] Node shuts down gracefully

---

# PHASE 4: BUG FIX CYCLE

For each test failure:
1. Document the failure (test name, error, root cause)
2. Fix the bug
3. Verify the fix
4. Go back to PHASE 3 and RE-RUN ALL TESTS

## Bug Log

| # | Test | Error | Root Cause | Fix | Status |
|---|------|-------|------------|-----|--------|
| 1 | _(discovered during testing)_ | | | | |

---

# PHASE 5: CLEAN RUN

The final victory lap.

- [ ] Start fresh node (clean `~/.pando` directory)
- [ ] Start fresh gateway
- [ ] Run FULL Playwright suite
- [ ] **ALL TESTS PASS on first run without any fixes**
- [ ] Record: total tests, pass count, run time
- [ ] Screenshot the green bar

## Clean Run Attempts

| Attempt | Date | Total | Passed | Failed | Failures | Action |
|---------|------|-------|--------|--------|----------|--------|
| 1 | | | | | | |

---

# PHASE 6: INDEX.TS REFACTOR (stretch goal — after clean E2E)

Only attempt after achieving a clean E2E run. This is structural cleanup.

- [ ] Extract `kernel-init.ts` from index.ts (network, governance, sync, monitor, security setup)
- [ ] Extract `core-init.ts` from index.ts (worker pool, storage, credentials, upgrade setup)
- [ ] Extract `platform-init.ts` from index.ts (orchestrator, content, resources, capabilities setup)
- [ ] index.ts delegates to these initializers
- [ ] `npm run build` still passes
- [ ] Re-run full E2E suite — still passes

---

# NOTES

- @pando/code is OUT OF SCOPE for this E2E. It's a separate product.
- Two-node P2P testing is NICE TO HAVE but not required for the clean run.
- Focus on single-node + gateway E2E first.
- The gateway may have stale pages or broken links — those ARE bugs to fix.
- If MongoDB is required for some features, document which ones and test accordingly.
