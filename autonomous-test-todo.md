# Autonomous Testing TODO — Night Session (Until 4 AM)

## INSTRUCTIONS FOR CLAUDE (READ THIS AFTER EVERY TASK)

You are the CEO/admin agent. The user is asleep. Do NOT ask questions. Fix everything autonomously.

**Rules:**
1. You are testing the council's ability to run the system WITHOUT human intervention
2. Only make code changes if the council/pipeline has a gap that prevents self-healing
3. After each task: update this file, mark completed, add new tasks discovered
4. If conversation compacts: re-read this file to remember what to do next
5. After every task completion: re-read `autonomous-test-todo.md` to check what's next
6. Run `npm run build` after any code change — zero errors required
7. Run tests after fixes — all must pass before moving on
8. If stuck on a task for >15 min, skip it and note the blocker

**TIMEOUT RULE (CRITICAL — never run anything that can hang forever):**
- ALWAYS use `timeout <seconds>` before any `node` command: `timeout 180 node tests/...`
- HTTP fetch calls: ALWAYS use `AbortSignal.timeout(15000)` (15s max)
- Node start: max 30s wait, then proceed
- Test suites: max 180s (3 min) timeout wrapper
- If a command times out: log the failure, move to next task, do NOT retry infinitely
- NEVER use `run_in_background` + `TaskOutput` with long waits — use `timeout` instead

## MASTER LOOP

```
1. Check this TODO file
2. Pick next uncompleted task
3. Execute it
4. Fix any failures found
5. Mark task done, note results
6. Go back to step 1
```

---

## PHASE A: Core Pipeline Verification (103d completion)

- [x] 103a: safeGitReset — protects uncommitted changes (DONE — 3 locations patched)
- [x] 103b: Council + identity rebuild (DONE — 580 lines, all features)
- [x] 103c: Builder pipeline wired (DONE — bridge watcher + governance proposals)
- [x] 103d-QA: QA gate in handleBridgeItem (DONE — regression suite runs before proposal)
- [x] 103d-Push: commitAndPush before governance proposal (DONE — pushes to origin/master)
- [x] **A1: Run live E2E test — 43/43 PASSED**
- [x] **A2: Run unit tests — 44/44 PASSED**
- [x] **A3: Run ledger regression — ALL PASSED**
- [x] **A4: Committed as 575f2fdb — Phase 103d: QA gate + commit/push**
- [x] **A5: Fixed commitAndPush side effect — unit test was committing to real repo (soft reset + clean commit)**

## PHASE B: Council Self-Healing Test

- [ ] **B1: Start a real node, send council a "fix" request via HTTP**
  - POST /council/message with "fix the upgrade protocol error handling"
  - Verify builder spawns
  - Verify builder completion flows through QA → governance
- [ ] **B2: Test council reflection cycle**
  - POST /council/reflect
  - Check minutes updated
  - Check if any proposals created from reflection
- [ ] **B3: Test health alert → council → self-heal loop**
  - Simulate a health alert
  - Verify council processes it during reflection
  - Verify builder spawned for fix

## PHASE C: Full Pipeline Flows (T1/T2 Apps)

- [ ] **C1: Verify T1 (S3) deployment pipeline exists and endpoints work**
  - GET /v1/projects — list projects
  - POST /v1/projects — create test project
  - Verify deploy endpoints respond correctly
- [ ] **C2: Verify T2 (peer-to-peer) deployment endpoints**
  - Check /v1/projects/:id/deploy exists
  - Check /v1/projects/:id/undeploy exists
  - Verify capability discovery works
- [ ] **C3: Test agent spawn → work → report → council receives**
  - Spawn agent via POST /v1/agents/spawn
  - Report completion via POST /v1/agents/:id/report
  - Verify bridge queue delivers to council
- [ ] **C4: Test upgrade broadcast to peers**
  - Verify upgrade notification GossipSub topic is wired
  - Verify catch-up timer scans governance for missed upgrades

## PHASE D: Security & Governance

- [ ] **D1: Auth gating — all write endpoints require auth**
  - Test POST /council/message without auth → 401
  - Test POST /council/directive without auth → 401
  - Test POST /agents/spawn without auth → 401
  - Test POST /upgrade without auth → 401
- [ ] **D2: Governance flow — proposal → vote → decision**
  - Create proposal, verify it appears
  - Cast vote, verify quorum logic
  - Check auto-approve in dev mode
- [ ] **D3: Guardrails — protected paths cannot be modified**
  - Verify guardrails.json loaded
  - Check rate limiting works

## PHASE E: Stress Test & Edge Cases

- [ ] **E1: Multiple rapid council messages — no crash**
  - Send 10 messages in quick succession
  - Verify all get responses
  - Check memory/CPU doesn't spike
- [ ] **E2: Builder failure → council handles gracefully**
  - Simulate task_failed bridge event
  - Verify minutes logged, no proposal created
- [ ] **E3: QA failure → proposal blocked**
  - Verify the QA gate blocks proposals when tests fail
  - Verify minutes show "QA Gate Blocked"
- [ ] **E4: Concurrent operations — node stays stable**
  - Multiple HTTP requests simultaneously
  - Check no deadlocks or crashes

## PHASE F: Multi-Node Upgrade Propagation

- [ ] **F1: Start 2 nodes, connect them**
  - Node A on port 4001, Node B on port 4002
  - Bootstrap B to A
  - Verify peer connection
- [ ] **F2: Trigger upgrade on Node A**
  - Create governance proposal on A
  - Verify auto-approve (dev mode)
  - Verify broadcast to B
  - Verify B receives and attempts pull
- [ ] **F3: Verify ledger sync between nodes**
  - Transfer Lux from A to B
  - Verify both ledgers reflect the transfer

## DISCOVERED ISSUES (add as you find them)

- [ ] (none yet)

---

## AFTER ALL PHASES: Final Report

Write a summary of:
1. What passed
2. What failed and was fixed
3. What gaps remain
4. Recommendations for production readiness
