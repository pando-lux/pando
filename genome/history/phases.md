# Phase History

> Chronological record of all Pando development phases. Migrated from ARCHITECTURE-PLAN.md.
> Each phase lists its sub-phases, key commits, and completion status.

---

## Phase 0: Foundation -- COMPLETE

- [x] **0.1** Rewrite CLAUDE.md to match reality (`bbc2ad4`) -- 100 endpoints documented and curl-verified, 10 GossipSub topics verified
- [x] **0.2** Clean up repo artifacts (`bbc2ad4`) -- stale branches deleted, broken directory removed, .gitignore verified
- [x] **0.3** Multi-node launcher (`a7e17cc`) -- `scripts/launch-nodes.js` with --test/--test-full/--fresh modes, 18/18 QA tests passed
- [ ] **0.4** Mac GitHub credentials -- deferred (not blocking)
- [x] **0.5** P2P features verified -- transfers, governance, catch-up sync verified, 1 bug fixed (`c1b2762`)
- [x] **0.6** QA verification -- 93 PASS, 3 FAIL (1 fixed, 2 design issues)

## Phase 1: Scheduler + Workspace Manager + Planner -- COMPLETE

- [x] **1.1** Workspace Manager -- isolated directories per task (`2e9f4dd`)
- [x] **1.2** Profile Cache -- cache + score generated agent profiles (`2e9f4dd`)
- [x] **1.3** Planner -- API call to generate agent profiles (`2e9f4dd`)
- [x] **1.4** Scheduler Core -- watches queue, creates workspaces, spawns agents (`2e9f4dd`)
- [x] **1.5** Integration -- 9 HTTP endpoints + 3 TUI commands + --scheduler CLI flag (`2e9f4dd`)
- [x] **1.6** End-to-End Verification -- merged into QA
- [x] **1.7** QA Verification -- all pass, 0 blocking bugs (`3593a44`)

## Phase 1.5: Stability Improvements -- COMPLETE

- [x] **1.5a** Bump concurrent sessions to 3 -- `maxConcurrentTasks: 3` in DEFAULT_CONFIG
- [x] **1.5b** Crash recovery -- `checkStuckTasks()` every poll cycle, tier timeouts (shell 5m, api 60s, short 15m, long 60m)
- [x] **1.5c** Workspace cleanup -- `autoCleanIfNeeded()` every 6 polls, max 50 workspaces, 7-day archive expiry

## Phase 2: P2P Task Coordination -- COMPLETE

- [x] **2.1** P2P task event subscription -- tasks sync via GossipSub (`003dfde`)
- [x] **2.2** Task catch-up sync -- new nodes get existing tasks on connect (`003dfde`)
- [x] **2.3** Scheduler claims remote tasks -- passive TaskQueue on all nodes (`ea40060`)
- [x] **2.4** Activity indexing -- SQLite indexes + /activity/stats endpoint (`87dc6a7`)
- [x] **2.5** Multi-node E2E test -- 11/11 assertions pass (`ea40060`)
- [x] **2.6** QA Verification -- all pass (`94a6f2b`)

## Phase 3: Scheduler + Planner + Isolated Workspaces -- COMPLETE (delivered as Phase 1)

All originally planned Phase 3 items were built and shipped as Phase 1: Scheduler (3.1), Planner (3.2), Workspace Manager (3.3), Profile Cache (3.4), Tiered execution (3.5).

## Phase 4: End-to-End User Experience -- COMPLETE

- [x] **4.1** Live agent output streaming -- SSE endpoint, dashboard shows agent working in real time (`56860a6`)
- [x] **4.3** Error handling + edge cases -- graceful failures (`56860a6`)
- [x] **4.4** QA verification -- browser-level Playwright, 3 minor bugs fixed (`f4db322`, `6a5df3f`)
- [x] **4.5** Per-task timeline tracing -- TaskTimelineEvent array on each task, vertical timeline UI (`d44a34c`, `a900af8`)

## Phase 5: Observability & Dashboard -- COMPLETE

- [x] **5.1** Gateway Scheduler dashboard -- 3 tabs (Tasks/Profiles/Activity), submit form, auto-refresh (`580c16e`, `9f8451d`)
- [x] **5.2** TUI commands -- /scheduler, /submit, /tasks (delivered in Phase 1)
- [x] **5.3** Live agent session viewer -- TaskLogStream component, SSE streaming, LIVE badge (`9fc640f`, `58adccc`)
- [x] **5.4** Workspace file browser -- 2 API endpoints, WorkspaceFileBrowser component (`faf5d5e`)
- [x] **5.5** Task detail deep-dive page -- `/scheduler/task/:id` with full timeline, metadata, subtasks (`3c8f19f`)
- [x] **5.6** Gateway rewrite -- 18 pages to 6, removed dead components and libs (`755b32a`, `1b12ebb`, `783910a`)

## Phase 6: Prove the Full Loop -- COMPLETE

- [x] **6.1** Claude Code session execution -- session-tier proven: prime checker (52.2s), Express API (86.7s), Python BankAccount
- [x] **6.2** Live streaming infrastructure -- SSE connects, LIVE badge, heartbeats flow (`c03bd5e`)
- [x] **6.3a** Home page "Tasks Processed" -- fixed field name mismatch (`c03bd5e`)
- [x] **6.3b** Network page "Total Supply" -- fixed rounding bug (`c03bd5e`)
- [x] **6.3c** Light theme cosmetic -- all 9 gateway files updated (`1846378`)
- [ ] **6.4** Cross-node task execution -- deferred (Mac offline), infrastructure exists but untested
- [x] **6.5** E2E browser QA -- all 6 pages verified, 0 console errors, 15 screenshots

## Phase 7: Multi-Agent Coordination Layer -- COMPLETE

> Full architecture: `admin_docs/MULTI-AGENT-COORDINATION.md`

- [x] **7.1** Project Context Layer (PCL) -- living doc at `~/.pando/project-context.md`, auto-updated after tasks (`7bfe9c8`)
- [x] **7.2** Task Decomposition -- Planner decomposes complex tasks into subtasks with dependency graph (`984fed4`)
- [x] **7.3** Dynamic Hierarchy -- Pattern Library + Project Planner, AI-designed roles per task (`028ee15`, `d7ff487`, `8b021ea`)
- [x] **7.4** Learning Loop -- outcome-recorder.ts + preference-observer.ts, API endpoints (`ba8bc48`, `7c73156`)
- [x] **7.5** Live Streaming -- fixed with `--verbose --output-format stream-json` (`9fc640f`, `58adccc`)
- [x] **7.6** Gateway Updates -- dynamic role badges, parent/child nesting, timeline events (`5dc75a0`)
- [x] **7.7** Full QA -- 7/7 browser tests pass. Old agent system removed: 8,664 lines deleted (`0430e27`, `5e049a9`)

## Phase 8: Cross-Node Coordination + Safe Upgrades -- COMPLETE

- [x] **8.1** First-Claim-Wins -- claimedByNode/claimedAt fields, GossipSub conflict resolution (`0c8e852`)
- [x] **8.2** Origin Tracking -- originNode/executedByNode fields, completion broadcast (`0c8e852`)
- [x] **8.3** Timeline Streaming -- timeline events broadcast via GossipSub (`7a2ebc2`)
- [ ] **8.4** Claim Intent Protocol -- DEFERRED (reactive conflict resolution sufficient)
- [x] **8.5** PCL sync via P2P -- PCL broadcasts on task completion, merge with dedup (`09ce393`)
- [x] **8.6** Reward system overhaul (Phase A) -- removed per-PING/connection rewards, added epoch uptime + task completion emissions (`1cba1fa`, `4dbb447`, `b891efa`, `448865c`)
- [x] **8.6b** Browser QA -- full browser-level QA, IPv6 bug found and fixed
- [ ] **8.7** Witness-based emission (Phase B) -- DEFERRED to Phase 12.1
- [x] **8.8** Safe upgrade protocol -- POST /upgrade endpoint, exit code 75 restart (`7a2ebc2`)

## Phase 9: Self-Healing Network -- COMPLETE

- [x] **9.1** Health Monitor -- HealthMonitor class (445 lines), rolling metrics, alert dedup, 6 API endpoints (`0efa624`)
- [x] **9.2** Auto-Recovery -- restart_scheduler, submit_diagnostic, reduce_concurrency, reconnect_bootstrap (`8216939`)
- [x] **9.3** Guardrails -- protected paths, rate limiting, auto-rollback, approval queue (`c2ff311`)
- [x] **9.4** Self-improvement loop -- SelfImprover class, analyzes patterns, proposes adjustments (`a870b8e`)
- [x] **9.5** Audit trail -- AuditEntry with actor/action/reason/outcome, stored at `~/.pando/monitor/audit.json`
- [x] **9.6** Gateway Monitor page -- health status, alerts, recovery actions, guardrails (`454f243`)
- [x] **9.7** Full QA -- 16/16 tests pass, 0 console errors

## Phase 10: Advanced Network Intelligence -- COMPLETE

- [x] **10.1** Request/reply messaging -- RequestReplyManager (317 lines), correlation IDs, timeouts (`a3f0178`)
- [x] **10.2** Profile sharing via P2P -- ProfileSync class (259 lines), broadcasts high-scoring profiles (`8d1175a`)
- [x] **10.3** Agent reputation system -- ReputationManager (384 lines), weighted scoring, P2P broadcast (`f9510cf`)
- [x] **10.4** Multi-Planner consensus -- 3x parallel calls, 3-dimensional scoring, consensus profile (`aca140a`)
- [x] **10.5** Model attestation on governance votes -- SHA-256 attestation hash, Ed25519 signed (`a3f0178`)
- [x] **10.6** Gateway updates -- reputation leaderboard, profile sharing stats, model attestation (`98fe92f`, `ffff2ef`)
- [x] **10.7** Full QA -- 17/17 tests pass, 0 console errors

## Ongoing: Code Hygiene & Self-Healing (continuous)

- [x] Deprecation sweep -- old agent system (8 files, 8,664 lines) deleted (`0430e27`)
- [x] Docs drift detection -- ARCHITECTURE-PLAN.md, CLAUDE.md, MULTI-AGENT-COORDINATION.md verified current
- [x] Dead code removal -- Phase 7 cleanup + Phase A cleanup + Phase 22.9 cleanup (-3,230 lines) + dead code cleanup (project-planner.ts, pattern-library.ts, preference-observer.ts DELETED)
- [x] Test coverage gaps -- 35 Phase 7 tests written (`b89f509`), stale tests updated (`a6b3413`)
- [x] Dependency audit -- 0 vulnerabilities, libp2p v2->v3 deferred (breaking changes)

## Phase 11: Content Layer -- COMPLETE (2026-02-18)

> Hybrid GitHub + Pando-native architecture (phased migration).

- [x] **11.1** ContentRegistry -- `content-registry.ts`, SQLite + GossipSub sync, full-text search
- [x] **11.2** Content Publish Pipeline -- `content-publish.ts`, workspace extraction + SHA-256 hashing
- [x] **11.3** Content Context Injection -- workspace extraction, ContentRegistry query for context
- [x] **11.4** Content Discovery & Search -- full-text search with weighted scoring
- [x] **11.5** Content Maintenance -- `content-maintenance.ts`, periodic health checks, staleness detection
- [x] **11.6** Ownership & Upgrade Control -- owner-only publish/update/archive, 3 tiers
- [x] **11.7** Gateway Content Page -- search, filters, expandable detail rows
- [x] **11.8** Lux Revenue Sharing -- 40/40/20 split (hosting/building/network)
- [ ] **11b.1-11b.3** Pando-native storage, P2P content delivery, content replication -- FUTURE (100+ nodes)

## Phase 12: Security Hardening -- COMPLETE

> 8-Layer Defense Architecture: cryptographic verification, transaction validation, consensus, reputation gate, witness-based emission, anomaly detection, content review, social consensus.

- [x] **12.1** Witness-Based Emission -- EmissionProposal, 2+ peer attestation, quorum, bootstrap fallback (`b61763f`)
- [x] **12.2** SecurityMonitor -- 5 detectors, auto-quarantine, alert persistence (`0854336`)
- [x] **12.3** Resource Proof Challenges -- `resource-proof.ts`, storage/compute/bandwidth challenges
- [x] **12.4** Reputation-Weighted Governance -- `reputation-governance.ts`, weighted voting, Sybil-resistant
- [x] **12.5** Content Safety Review -- `content-safety.ts`, 5-category rule-based scan
- [x] **12.6** Network Quarantine Protocol -- 3-level quarantine, appeal mechanism via governance
- [x] **12.7** Immutable Kernel Definition -- IMMUTABLE_KERNEL_FILES in guardrails.ts, auto-reject diffs

## Phase 13: Self-Evolving Network -- COMPLETE (2026-02-18)

> `upgrade-protocol.ts` (~550 lines). Complete upgrade lifecycle.

- [x] **13.1** Upgrade Proposal System -- code_upgrade proposal type, review period, reputation threshold
- [x] **13.2** Multi-Agent Code Review -- rule-based code review, structured verdicts
- [x] **13.3** Governance Vote on Upgrades -- 60% quorum, reputation-weighted, 2:1 supermajority
- [x] **13.4** Canary Deployment -- apply -> build -> health check -> 60s monitor, auto-rollback
- [x] **13.5** Staggered Full Rollout -- remaining nodes update in waves, >20% failure halts
- [x] **13.6** Post-Deployment Monitoring -- 24-hour heightened monitoring, auto-propose rollback
- [x] **13.7** Version Pinning (Opt-Out) -- node operators can pin to specific version
- [x] **13.8** Emergency Rollback -- fast-track vote (1-hour, 40% quorum), auto post-mortem

## Phase 14: Universal Onboarding -- NOT BUILT (deferred)

> The only unbuilt phase. Running a Pando node should be as easy as installing Spotify.

- [ ] **14.0** Bootstrap Scripts & Terminal Gateway -- single script that handles Node.js install, clone, build, start
- [ ] **14.1** Standalone Binary (Node.js SEA) -- single executable, no Node.js install needed
- [ ] **14.2** Installer & Auto-Start -- NSIS/WiX (Windows), DMG (Mac), AppImage (Linux), code-signed
- [ ] **14.3** System Tray / Background Mode -- tray icon, resource controls
- [ ] **14.4** Desktop App (Tauri) -- native wrapper around gateway UI (~10MB)
- [ ] **14.5** Auto-Update for End Users -- background download, rollback on crash
- [ ] **14.6** First-Time Setup Wizard -- choose contribution level, resource types
- [ ] **14.7** Identity Backup & Recovery -- 12-word BIP-39 mnemonic, cloud backup option
- [ ] **14.8** Mobile App (Future) -- iOS/Android light node, React Native or Flutter

## Phase 15: Strategy Loop -- COMPLETE

> Universal observe-analyze-propose-execute cycle for any project.

- [x] **15.1** Agent Reflection -- structured reflection after session-tier tasks (`939fd0c`)
- [x] **15.2** Governance -> Task Pipeline -- proposal passes -> auto-create scheduler task (`d84faae`)
- [x] **15.3** Strategy Loop (The Brain) -- StrategyLoop class, configurable triggers, context assembly (`a929bf2`). Bug fixed in Foundation Sprint F1.1 (`d29d1e6`, `c5c84c8`, `14fad7e`)
- [x] **15.4** Feedback-to-Action Pipeline -- verification tracking, auto-rollback proposals (`36e51bb`)
- [x] **15.5** Humans as Users -- gateway /strategy page with config editor, suggestion approve/reject (`93dc506`)
- [x] **15.6** Binary Rollback Safety Net -- save dist/ as dist.backup/, auto-swap on 3+ crashes (`939fd0c`)

## Phase 16: Autonomous Code Pipeline -- COMPLETE

> Code written by agents gets extracted, tested, committed, and deployed automatically.

- [x] **16.1** Code Pipeline (`code-pipeline.ts`) -- extract diffs, apply patches (`775ad5a`)
- [x] **16.2** Tiered Guardrails (enhance `guardrails.ts`) -- 4 protection levels (`f88a563`)
- [x] **16.3** QA Runner (`qa-runner.ts`) -- Playwright headless tests (`0231383`)
- [x] **16.4** Deploy Manager (`deploy-manager.ts`) -- commit, build, deploy, rolling deploy (`8bd4297`)
- [x] **16.5** Version Protocol -- `protocolVersion` in P2P handshake (`1073f98`)
- [x] **16.7** Pipeline Runner (`pipeline-runner.ts`) -- wires all components (`a362219`)
- [x] Persist agent execution logs -- JSONL log per task, API endpoint, gateway viewer (`fc49f6c`)

## Phase 17: Smart QA -- COMPLETE

> AI-powered end-to-end testing. Feature verification, not just compilation.

- [x] **17.1** QA Tier Classification -- qaTier field (none/code/build/browser/critical) (`2c5a5f0`)
- [x] **17.2** QA Agent Spawning with Playwright MCP -- `spawnQaAgent()`, `buildQaClaudeMd()` (`1fc1ed2`)
- [x] **17.3** QA Verdict Gating -- QA failure rejects task, creates fix task
- [x] **17.4** Fix Task Creation on QA Failure -- `createFixTask()` with original context + QA report
- [x] **17.5** QA for Non-UI Changes -- `runStructuredApiTests()`, `runP2PTests()`, 12 API test cases
- [x] **17.6** Regression Suite -- `regression-suite.ts`, 14 built-in tests, persistent storage

## Phase 18: Unified Input -- COMPLETE

> One input box. Smart Router classifies and routes to the right system.

- [x] **18.1** Smart Router (`smart-router.ts`) -- 7 categories, regex + LLM classification (`4a4ed75`)
- [x] **18.2** Unified Input Gateway -- single input on home page, category badges (`0267c01`)
- [x] **18.3** Conversation Threads -- ThreadMessage type, GossipSub broadcast (`d63f30f`)
- [x] **18.4** User Context Detection -- 21-keyword KEYWORD_FILE_MAP, auto-attach contextFiles (`27dd420`)
- [x] **18.5** Complexity & Resource Estimation -- 4-factor heuristic, 5 tiers, approval gate (`4cbc034`)
- [x] **18.6** Payment Gating -- `payment-gate.ts`, cost estimation, escrow hold/release/refund
- [x] **18.7** User Identity -- `user-identity.ts`, anonymous sessions, wallet linking, rate limiting

## Phase 19 Prerequisites: Foundation Hardening -- COMPLETE (2026-02-17)

> 12 prerequisites (P0-P11) hardening foundation before managers. ~1200 lines of new code.

- [x] **P0** TaskQueue -> SQLite Migration -- `task-database.ts` (817 lines), 6 tables, WAL mode (`ce8e391`)
- [x] **P1** Hardcoded Port Fix -- Scheduler receives `apiPort` from config (`5e672ac`)
- [x] **P2** TaskQueue Public API -- `setResultNote()`, `setRoleMetadata()` (`5e672ac`)
- [x] **P3** Capability-Based Task Routing -- auto-detect capabilities, `requiredCapabilities` on tasks (`c7c8277`)
- [x] **P4** Circuit Breaker for AI API Calls -- 5 failures -> 60s cooldown -> half-open probe (`c7c8277`)
- [x] **P5** Idempotent Task State Transitions -- VALID_TRANSITIONS state machine (`5682c8d`)
- [x] **P6** Regression Test Suite -- 65 tests covering P0, P3, P5, P7, P8, P9, P11 (`6b6d579`)
- [x] **P7** Task Archival -- `archiveOldTasks()`, hourly auto-archive, 'archived' terminal status (`005358a`)
- [x] **P8** Transaction Dedup Race Fix -- `appliedTxs` Set for dedup (`5e672ac`)
- [x] **P9** TaskId Path Traversal Prevention -- regex validation in workspace-manager.ts (`5e672ac`)
- [x] **P10** GossipSub Listener Leak Fix -- `topicListeners` tracks topic field for dedup (`5e672ac`)
- [x] **P11** Planner Prompt Injection Defense -- `sanitizeTaskInput()` strips code fences (`5682c8d`)

## Phase 19: Distributed Manager Network -- COMPLETE (2026-02-17)

> Domain Managers replace flat authority model. Workers cannot create tasks. Managers are the ONLY authority.

- [x] **19.1** ManagerAgent Class -- `manager-agent.ts` (399 lines), rule-based engine, lease management (`cb6f2c9`)
- [x] **19.2** Worker Lockdown -- POST /tasks requires managerId, health monitor uses callbacks (`cb6f2c9`)
- [x] **19.3** Scheduler Downgrade -- `managerMode` flag added (`0aa058a`), completed in Phase 22.9 (deleted entirely)
- [x] **19.4** Core Domain Managers -- `domain-managers.ts`, legacy 3 managers -> 1 unified (`1c9c3b1`)
- [x] **19.5** Manager Registry -- `manager-registry.ts` (410 lines), GossipSub distributed, lease-based (`0aa058a`)
- [x] **19.6** Smart Router Upgrade -- domain classification via DOMAIN_PATTERNS regex (`1c9c3b1`)
- [x] **19.7** Manager-to-Manager Protocol -- `manager-protocol.ts` (160 lines), 6 message types (`0aa058a`)
- [x] **19.8** Manager Failover (Lease-Based) -- `manager-failover.ts` (203 lines), 30s periodic checks (`1c9c3b1`)
- [x] **19.9** Manager Self-Spawning -- Smart Router auto-spawns managers for new domains (`a86d2c0`)

## Phase 20: Persistence, Memory & Lifecycle -- COMPLETE

> Unified persistence model for managers AND workers. Everything survives restarts and remembers context.

- [x] **20.1** Session Registry -- `SessionRegistry` tracks workspace -> area mapping (`cbe156f`)
- [x] **20.2** Area-Based Workspace Reuse -- Scheduler classifies tasks by area, reuses dormant workspaces (`601994a`)
- [x] **20.3** Session Reuse via --continue -- agents spawn with `--continue -p resumePrompt` (`537ff8e`)
- [x] **20.4** Memory & Context Graduation -- token tracking, memory.md graduated at 150k tokens (`7809480`)
- [x] **20.5** Cross-Node Memory Sync -- `memory-sync.ts`, GossipSub MEMORY_SHARED events (`11a7c5e`)
- [x] **20.6** Wake Logic -- EventPriority classification, batch processor (`323eac6`)
- [x] **20.7** Project Lifecycle States -- planning -> building -> deployed -> maintaining -> paused -> archived (`a326160`)
- [x] **20.8** Owner Authority & Budget -- AutonomyLevel, daily Lux budget enforcement (`85e6bea`)
- [x] **20.9** Daily Review & Self-Management -- DailyReview metrics/insights/recommendations (`13a0ba7`)

## Phase 21: Agent Continuity & Memory -- MERGED INTO PHASE 20

Worker session reuse, area-based workspaces, `claude --continue`, context graduation, structured memory, cross-node memory sync are all sub-phases of 20.1-20.5.

## Critical Fixes A-K -- COMPLETE (2026-02-17)

- [x] **A** Parent Done -> Auto-Reject Children (`6b576ea`) -- cascade rejection + pre-spawn check
- [x] **B** QA Inconclusive Verdict (`6b576ea`) -- 3-state: passed/failed/inconclusive
- [x] **C** Agent PID Tracking + Process Cleanup (`1c10380`) -- activePids Map, sweepOrphanedPids()
- [x] **D** Pre-Execution Dedup Gate (`1c10380`) -- jaccardSimilarity() + isDuplicateTask()
- [x] **E** Diagnostic Cooldown (`1c10380`) -- 15 -> 60 min cooldown
- [x] **F** Reject Endpoint Persistence (`1c10380`) -- updateStatus after rejectTask()
- [x] **G** Title-Similarity Dedup in createTask (pending commit) -- 0.6 Jaccard threshold
- [x] **H** Lower Scheduler Dedup Threshold (pending commit) -- 0.85 -> 0.6
- [x] **I** Active Task Status Guard (pending commit) -- poll checks externally rejected tasks
- [x] **J** Reject Race Guard (pending commit) -- re-reads status before rejecting
- [x] **K** findApiKey Silent Failure Logging (pending commit) -- logs WHY findApiKey fails

## Foundation Sprint -- COMPLETE (2026-02-17)

> Goal: Network can detect issues -> propose fixes -> build -> deploy -> restart -> verify. 16/16 items done.

### F1: Honest Audit & Dead Code Cleanup
- [x] **F1.1** Fix Strategy Loop executeAnalysis() bug (`d29d1e6`, `c5c84c8`, `14fad7e`)
- [x] **F1.2** Remove or wire dead code (`384eb33`, `d29d1e6`)
- [x] **F1.3** Fix --continue context quality (`0ad0169`)
- [x] **F1.4** Doc-truth sync -- CLAUDE.md updated (+211/-24 lines)

### F2: Wire the Autonomous Pipeline
- [x] **F2.1** Instantiate PipelineRunner in scheduler (`384eb33`)
- [x] **F2.2** Wire auto-restart after deploy (`3b9bbea`)
- [x] **F2.3** Guardrails enforcement -- VERIFIED functional

### F3: Dual-Node Testing on Windows
- [x] **F3.1** Windows supervisor (`d9f1a1c`)
- [x] **F3.1b** Launch Node 2 -- verified bidirectional peer discovery, ledger sync, Lux transfer, task sync, governance sync
- [x] **F3.2** Test witness-based emission -- verified design, bootstrap fallback works for <3 nodes
- [x] **F3.3** Multi-node upgrade coordination (`631b668`)
- [ ] **F3.3b** Test one-at-a-time upgrade -- not yet verified end-to-end

### F4: Strong QA Pipeline
- [x] **F4.1** QA agent uses Playwright (`8568aea`)
- [x] **F4.2** Post-deploy health check suite (`9167780`)
- [x] **F4.3** Regression gate -- rollback built into cli.ts health check

### F5: Strategy Loop Reads the Bible
- [x] **F5.1** Feed ARCHITECTURE-PLAN.md to analyst (`c5c84c8`, `14fad7e`)
- [x] **F5.2** Strategy -> Governance -> Scheduler loop -- full routing verified
- [x] **F5.3** Self-diagnosis (`2a5839a`)

### Post-Sprint: Autonomy Pulse (`a1e2bd7`)
- Pulse Timer: 5m interval fires periodic_check to unified node manager
- SmartRouter -> Orchestrator wiring
- Scheduler -> Orchestrator task event routing
- HealthMonitor -> Orchestrator alert routing
- Orphaned task recovery on startup (4 zombies recovered)
- Git diff fallback for code pipeline
- Stale strategy suggestion auto-promotion

### Post-Sprint Session 2: Node Crash Investigation (2026-02-17b)
- Auto-updater crash (BUG-11): infinite stash/pull/build cycle from unpushed commits. Fixed (`bf0677f`)
- Lightsail task-stealing (BUG-14): 0% success rate, claiming ALL tasks. Fixed by removing --scheduler from Lightsail
- Agent self-repair PROVEN: BUG-12 + BUG-13 submitted as tasks, agents fixed correctly (`37d554e`)

## Resource Network -- COMPLETE (2026-02-18)

> Heterogeneous node architecture. Nodes declare capabilities, network routes work to right node.

- [x] **Phase A** Capability Declaration -- `capability-detector.ts` + `capability-registry.ts`, auto-detection, scheduler canExecuteLocally()
- [x] **Phase B** Smart Routing + Error Correction -- `resource-router.ts`, auto-degrade after 3 failures, task forwarding
- [x] **Phase C** Resource Metering -- `resource-meter.ts`, per-resource usage tracking, 30-day pruning
- [x] **Phase D** Marketplace Pricing -- `resource-marketplace.ts`, operator pricing, find cheapest qualifying node

## Phase 22: Manager Intelligence Upgrade -- COMPLETE (2026-02-18)

> Replace hardcoded TypeScript switch-statement managers with persistent Claude Code sessions.

- [x] **22.1** ManagerContextAssembler -- `manager-context.ts` (312 lines), builds prompt from health/tasks/strategy/git (`5d72749`)
- [x] **22.2** Manager Session Runner -- `evaluateWithSession()`, `claude -p` spawn, 5/15-min timeouts (`5d72749`)
- [x] **22.3** Consolidate Core Managers -- 3 domain managers -> 1 `pando-node-mgr` (`5d72749`)
- [x] **22.4** Demote Data Sources -- setManagerMode(true) on HealthMonitor, StrategyLoop, SelfImprover, AutoUpdater (`5d72749`)
- [x] **22.5** Wire Completion Flow -- task completion routed to manager evaluateWithSession() (`5d72749`)
- [x] **22.6** Process Supervisor -- PM2 config, setup scripts for Linux/Mac/Windows
- [x] **22.7** Communication Agent (Basic) -- keyword classifier + OpenAI fallback, gateway /chat page (`834732d`, `b8878c4`)
- [x] **22.8** Manager Session Continuity -- workspace dir per manager, --continue for session reuse (`c92d68b`, `346e30b`)
- [x] **22.9** Architecture Cleanup -- -3,230 lines deleted, +786 added. Scheduler lobotomy (-1,192 lines), subsystem stripping (-845 lines), per-event spawn model, zero toggles remaining

## Phase 23: Adaptive Chat Intelligence -- COMPLETE (2026-02-18)

> Adaptive chat: starts lightweight, auto-upgrades to Claude Code when complexity demands it.

- [x] **23.1** Complexity Classifier -- `classifyComplexity()`, 3 tiers (simple/medium/complex), auto-escalation
- [x] **23.2** Claude Code Chat Sessions -- `chat-session-manager.ts`, spawn claude -p for complex queries
- [x] **23.3** Project Chat -- per-project workspaces with independent Claude Code sessions
- [x] **23.4** Chat Agent Selector -- gateway tier dropdown (Quick/Smart/Full) with cost indicators
- [x] **23.5** Chat-to-Manager Bridge -- `createTaskFromChat()`, complex messages queue tasks for manager
- [x] **23.6** Conversation Memory -- auto-summarize every 20 messages, graduate at 40+

## Phase 32: S3 Hosting Service -- COMPLETE (2026-02-22)

> Deploy project sites to AWS S3. Public projects served directly, private/shared via pre-signed URLs.

- [x] **32.1** HostingService class -- `hosting-service.ts`, S3Client, deploy/presign/remove/probe
- [x] **32.2** API endpoints -- `POST /projects/:id/hosting` (deploy), `GET /projects/:id/hosting` (info), `DELETE /projects/:id/hosting` (remove)
- [x] **32.3** DeploymentInfo type -- added to `packages/shared/src/types.ts`
- [x] **32.4** Wired in index.ts -- HostingService instantiated in `_start()`, accessible via `getHostingService()`
- [x] **32.5** E2E verified -- 7/7 tests PASS (public deploy, direct URL, private deploy, 403 block, pre-signed URL, GET info, DELETE removal)

---

## Phase 38: Public Node AI Access + Service Catalog — DONE

- [x] **38.0** Enable `--scheduler` on Lightsail — Claude Code installed + authed (Max subscription, 2026-02-20). AI chat works for public gateway visitors.
- [x] **38.2** Service catalog page — `packages/gateway/app/services/page.tsx`. 5 service cards (AI Chat, Project Building, AI Search, Storage & Hosting, Governance) with live status from `/api/status` + `/api/capacity`. "How to Pay" section (welcome grant, node earnings, transfers). Provider earnings section with reward estimates. NavBar "Services" link. Dark theme, card layout, status badges.
- [ ] **38.1** Cost controls (rate limits per guest session) — deferred
- [ ] **38.3** Multi-node AI routing — partially addressed by Phase 45 (Claude-capable node preference)

---

## Phase 46: Project Lifecycle — COMPLETE + E2E VERIFIED

- [x] **46.1** Fix thread follow-up routing — `POST /chat/threads/:id/message` now uses `threadMeta.projectId` to route to `project-<id>` manager instead of hardcoded `pando-node-mgr`
- [x] **46.1** Fix thread creation — `POST /chat/message` now stores `projectId` on thread via `updateThread()`, sets type to `'project'` when `projectId` provided
- [x] **46.1** Fix thread creation (gateway flow) — `POST /chat/threads` now extracts `projectId` from body, sets type to `'project'`, stores projectId
- [x] **46.1** Add `PATCH /chat/threads/:id` endpoint — update thread metadata (title, projectId, archived, type)
- [x] **46.2** Add 3 project manifest fields — `repoUrl`, `teamHistory`, `notes` on Project interface + SQLite migrations + conversion helpers
- [x] **46.2** Add `getProjectByThreadId(threadId)` — lookup project by linked thread
- [x] **46.3** Manager template principle #11 — documentation IS knowledge transfer (CLAUDE.md + project-state.md + manifest)
- [x] **46.4** Gateway: Projects page "Open Chat" button — navigates to `/chat?projectId=<id>`
- [x] **46.4** Gateway: Chat page projectId awareness — reads `?projectId=` from URL, includes in thread creation and message requests
- [x] **46.4** Gateway: Marketplace API proxy — `GET /api/marketplace` forwards to node
- [x] **46.4** Gateway: Thread PATCH proxy — `PATCH /api/chat/threads/[id]` forwards to node
- [x] **46.5** Genome docs updated — project-store.md, user-chat.md, gateway.md, state.md, roadmap.md, phases.md
- [x] **46.6** E2E verified (API + browser): thread creation stores projectId (PASS), follow-up routes to project manager (PASS), PATCH works (PASS), gateway proxies work (PASS), browser chat with ?projectId creates project thread and routes correctly (PASS)
- **Discovery:** AgentManager lives inside `startScheduler()`, requires `--scheduler` flag to start. Without it, `/agents/tree` returns "Agent system not started".

---

## Phase 48: Unified Identity — DONE

- [x] **48.1** Node operator state — `operatorPeerId`, `operatorToken`, `operatorUsername` fields on PandoNode. `setOperator()`/`clearOperator()`/`getOperator()`/`getRewardRecipient()` methods. Deleted dead code: `stopForLogout()`, `clearIdentity()`.
- [x] **48.2** TUI login flow — `/login` (username+password, calls /auth/login), `/register` (create+claim), `/account` (show operator info). Auto-login via `operator-session.json` on startup. `/logout` rewritten to clear operator session only (node keeps running).
- [x] **48.3** Emission attribution — `getRewardRecipient()` returns operator peerId. No login = no rewards (node runs as relay only).
- [x] **48.4** "My Nodes" tracking — `linked_nodes` column in user-accounts SQLite + migration. `registerNode()`/`getLinkedNodes()` methods. `GET /auth/me/nodes` and `POST /auth/me/nodes` endpoints. `GET /auth/me` updated with `linkedNodes` field.
- [x] **48.5** Gateway "My Resources" + "My Nodes" — Resources page updated with My Resources section (user's own resources) and My Nodes section (linked nodes with online/offline status). `app/api/auth/me/nodes/route.ts` proxy route.
- [x] **48.6** Node startup UX — TUI shows "Node #XXXX running" on startup. Session persistence helpers: `saveOperatorSession`, `loadOperatorSession`, `clearOperatorSession`.
- [x] **48.7** Login timeout hardening — `withTimeout` utility in user-accounts.ts (15s default). Gateway login proxy: 15s timeout + non-JSON guard. auth-context.tsx: 20s browser-side timeout.

---

## Phase 49: Network Capacity Dashboard + Reward Signals — DONE

- [x] **49.1** Node `GET /capacity` endpoint — public, no auth. Aggregates supply (ResourceMarketplace: providers per resource, price ranges), demand (ResourceMeter: usage per resource; Scheduler: pending/running/completed/failed tasks), rewards (emission rates, estimated daily earnings per provider), network (CapabilityRegistry: node count; Ledger: accounts, total supply; HealthMonitor: health status). Each subsystem call individually try/caught for resilience.
- [x] **49.2** Gateway proxy — `app/api/capacity/route.ts` forwards to node `/capacity` endpoint via `getNodeUrl()`.
- [x] **49.3** Gateway capacity page — `app/capacity/page.tsx` with 5 sections: Network Overview cards, Supply table (available/needed badges), Demand stats (task metrics + usage), Reward Signals (sorted by estimated daily earnings, gradient bars), Call to Action for providers. Auto-refreshes every 30 seconds.
- [x] **49.4** NavBar updated — "Capacity" link added to `components/NavBar.tsx`.

---

## Phase 50: Network Council — Autonomous Reflection — DONE

- [x] **50.1** Council class (`council.ts`) — `selectCouncil()` filters CapabilityRegistry for Claude Code capable nodes, sorts by reputation, takes top 3. Weekly rotation timer. State persisted in `{dataDir}/council/council-state.json`.
- [x] **50.2** Daily reflection prompt assembly — reads `network-state.md` + last 5 council minutes + `genome/state.md`. Structured prompt saved to `last-prompt.md`. AI call stubbed (infrastructure only).
- [x] **50.3** Council minutes — rolling 30-entry log in `council-minutes.md`. `appendMinutes()` prepends new entries, trims old. `getMinutes()` returns full text.
- [x] **50.4** NetworkState aggregator (`network-state.ts`) — collects metrics from HealthMonitor, CapabilityRegistry, Ledger, Scheduler. Writes `network-state.md` to council directory.
- [x] **50.5** Node API endpoints — `GET /council` (members array, selectedAt, rotatesAt, thisNodeOnCouncil), `GET /council/minutes` (minutes text). Added to public endpoints list.
- [x] **50.6** Gateway proxy routes — `app/api/council/route.ts`, `app/api/council/minutes/route.ts`. Same pattern as capacity proxy.
- [x] **50.7** Gateway council page — `app/council/page.tsx`: rotation info cards, members table (peer ID, reputation, Claude Code, uptime, this-node badge), council minutes in monospace block, network state overview section. 60s auto-refresh.
- [x] **50.8** NavBar updated — "Council" link added after "Capacity".

---

## QA Sweep — Comprehensive 3-Agent Testing — DONE (2026-02-22)

Full-spectrum QA across gateway UI, TUI/API, and deep 2-user flows using dynamic agent testing.

- [x] **QA.1** QA Framework — `tests/qa/context/pando.md` (app overview, 11 pages, auth model, test accounts), `tests/qa/context/deep-flows.md` (24 test flows with BEFORE/ACTION/AFTER backend verification pattern). Designed for reuse by future managers.
- [x] **QA.2** Surface Browser QA (Playwright) — 19 issues identified across all gateway pages. Screenshots captured.
- [x] **QA.3** TUI/API Testing — 48 endpoints tested via curl. 9 issues found (1 critical, 3 high, 3 medium, 2 low). Transfer economics verified to 10 decimal places. SQL injection/path traversal safe.
- [x] **QA.4** Deep 2-User QA (Playwright) — 12/12 flows tested as Alice & Bob. Identity lifecycle, chat, governance, projects, wallet, services, capacity, council, network, navigation, cross-user isolation, edge cases/security. All pass.
- [x] **QA.5** Bug Fixes — 5 bugs fixed and verified:
  1. CRITICAL: `/auth/guest` no rate limit → added 5/min/IP (`api-server.ts`)
  2. HIGH: Chat threads not isolated per user → require auth, filter by userId (`api-server.ts`)
  3. HIGH: Invalid JSON returns 500 → returns 400 (`api-server.ts`)
  4. HIGH: Gateway port misconfigured → `.env.local` 4000→4100
  5. HIGH: Balance shows 0 after login → fetch from `/auth/me` (`auth-context.tsx`)
- [ ] **QA.6** Flows 13-24 (project collaboration, search, content, resources, payment, chess game) — NOT YET TESTED. Documented in `deep-flows.md` for future QA runs.

---

## Phase 52: Cloud-Native App Architecture — DONE (2026-02-22)

Architectural restructuring so apps built by agents are fully independent after deployment.

- [x] **52.1** Gateway direct MongoDB for app data — rewrote 3 gateway `/api/apps/data/*` routes to connect to MongoDB directly (not proxy through node). Added `mongodb` to gateway deps, created `lib/mongodb.ts` with Vercel serverless connection pooling, `ensureAppDataIndexes()`. Apps survive node outages.
- [x] **52.2** Template rewrite — manager and builder templates now encode zero-config UX as mandatory law. "After deploy, node is NOT involved." Data store documented as MongoDB-backed, gateway-served. NEVER hardcode IPs/ports. Relative URLs only.
- [x] **52.3** Scheduler auto-detection — `detectClaudeCode()` checks PATH for `claude` binary at startup. Auto-enables scheduler when found. `--no-scheduler` for explicit opt-out. `--scheduler` still works (backward compat).
- [x] **52.4** Clean URL delivery — `HostingService.buildDeploymentInfo()` and `getHostedUrl()` now prefer `GATEWAY_PUBLIC_URL` (e.g., `https://gateway/apps/project/index.html`) over raw S3 URLs.
- [x] **52.5** Node app-data deletion — removed `appDataDb` property, SQLite `app-data.db` init, all `/apps/data` routes, auth bypass, rate limits, cleanup from api-server.ts. Infrastructure endpoint updated: `persistence: 'mongodb'`.
- [x] **52.6** Genome docs — state.md, roadmap.md, phases.md, templates updated.

**Build:** All 5 packages compile with zero errors.

---

## Phase 53: Full-Stack App Independence + Resource Proxy -- COMPLETE

Apps built by Pando agents are fully independent after deployment. No `/apps/data`. No gateway-direct-MongoDB. Apps get their own backends with credentials managed by the Resource Proxy. Protocol Memo System ensures all agents know the current architecture rules.

- [x] **53.0** Protocol Memo System — created `genome/protocol.md` v1, wired as Layer 0 in `agent.ts buildClaudeMd()` (reads file, extracts version, prepends full content). Protocol reminder injected per bridge event in `agent-manager.ts buildPromptFromBridgeItem()`. `protocolVersion` added to AgentState.
- [x] **53.1** Legacy cleanup — DELETED: `gateway/lib/mongodb.ts`, `gateway/app/api/apps/data/*` (3 route files), `gateway/app/apps/*` (S3 proxy). Removed `mongodb` from gateway deps. Cleaned infrastructure endpoint (removed `dataStore`, `appBaseUrl`). Updated templates (no `/apps/data` references).
- [x] **53.2** Resource Proxy — NEW: `gateway/app/api/resource-proxy/db/route.ts` (672 lines). POST for 9 MongoDB operations, GET for simple find. X-Project-Key authentication via node `/resource-proxy/validate`. Credential caching (5-min TTL), connection pooling (10-min idle), rate limiting (100 ops/min), size limits (1MB response, 100KB/doc), collection validation. Fire-and-forget usage metering via `/resource-proxy/meter`. NEW on node: `POST /resource-proxy/validate`, `POST /resource-proxy/meter`. Re-added `mongodb` to gateway deps (correct use — dynamic connections to contributed resources).
- [x] **53.3** Project resource assignment — Added `resources[]` and `apiKey` to Project interface. SQLite migrations. 5 new ProjectStore methods (`assignResource`, `removeResource`, `getProjectResources`, `generateApiKey`, `getProjectByApiKey`). 6 new node API routes. 2 gateway proxy routes (`/api/projects/[id]/resources`, `/api/projects/[id]/api-key`). Infrastructure endpoint updated with `resourceProxy` section.
- [x] **53.4** Template rewrite — Rewrote `builder.md` (3 app patterns with Resource Proxy code examples, anti-patterns). Rewrote `manager.md` (resource assignment workflow, pattern selection). Updated `protocol.md` with concrete implementation details.
- [x] **53.5** Test apps — PandoChat (social feed) and LuxRunner (clicker game) built as single HTML files using Resource Proxy pattern. Both exercise find, findOne, insertOne, updateOne operations.

**QA Results:** 25/25 API tests PASS (0 FAIL). All Phase 53 routes respond correctly. Legacy routes return 404. Protocol memo wired. Templates clean. Existing functionality (chat, governance, wallet, scheduler) unbroken.

**Key finding:** Full E2E Resource Proxy test requires a `storage_db` resource registered in ResourceRegistry. Without contributed MongoDB credentials, the proxy correctly validates API keys but returns `mongoUri: null`. Architecture is correct — waiting for resource contribution.

**Build:** All 5 packages compile with zero errors.

**Files created:** `genome/protocol.md`, `gateway/app/api/resource-proxy/db/route.ts`, `gateway/app/api/projects/[id]/resources/route.ts`, `gateway/app/api/projects/[id]/api-key/route.ts`, `tests/apps/pandochat.html`, `tests/apps/luxrunner.html`.

**Files deleted:** `gateway/lib/mongodb.ts`, `gateway/app/api/apps/data/route.ts`, `gateway/app/api/apps/data/[namespace]/route.ts`, `gateway/app/api/apps/data/[namespace]/[key]/route.ts`, `gateway/app/apps/[...path]/route.ts`.

## Phase 54: Zero-Config Node + Legacy Cleanup -- COMPLETE

- [x] **54.1** Auto-connect bootstrap -- `DEFAULT_BOOTSTRAPS` replaced with Lightsail public IP (`54.145.144.221:4001`). Removed Tailscale entry. Any new node auto-connects.
- [x] **54.2** Peer persistence -- `~/.pando/known-peers.json` saves/loads connected peers. On startup, dials known peers alongside bootstrap. `checkAndReconnect()` uses known peers when peer count drops to zero. 7-day prune, 50-peer cap. ~80 lines added to `network.ts`.
- [x] **54.3** Transfer to any valid peerId -- Auto-creates ledger account for `12D3KooW*` format peerIds. Removed "must be connected peer" gate in `api-server.ts`.
- [x] **54.4** Node identity = reward recipient -- `getRewardRecipient()` returns `identity.peerId`. Deleted `operatorPeerId`, `operatorToken`, `operatorUsername` fields and `setOperator()`/`clearOperator()`/`getOperator()` methods from `index.ts`.
- [x] **54.5** TUI legacy login deleted -- Removed `/login`, `/register`, `/account` commands, `doLogin()`, `doRegister()`, `showAccount()`, `saveOperatorSession()`, `loadOperatorSession()`, `clearOperatorSession()`, `tryAutoLogin()` from `tui.ts` (~200 lines). `/logout` kept (clears identity session). All `/auth/*` API endpoints kept for gateway.
- [x] **54.6** CLI flags cleanup -- `--auto-update` deleted entirely. `--storage` shows deprecation warning. Launcher scripts (`start-node.command`, `start-node.bat`) simplified (removed `--scheduler`).
- [x] **54.7** Genome documentation -- Updated `state.md`, `roadmap.md`, `components/network.md`, `history/phases.md`, `CLAUDE.md`.

## Phase 57: Clean Data Architecture -- COMPLETE

- [x] **57.1** Delete LocalStorageBackend — `storage-backend.ts` now contains only the `StorageBackend` interface. Filesystem-based storage removed entirely.
- [x] **57.2** ThreadStore simplified — Constructor takes `StorageBackend` only (no `db` param, no filesystem fallback). All reads/writes go through MongoDB.
- [x] **57.3** ProjectStore MongoDB-primary — Write pattern changed from fire-and-forget to `await` MongoDB first, then SQLite cache update. `loadFromBackend()` hydrates SQLite cache from MongoDB on startup.
- [x] **57.4** RevenueEngine + ContributionTracker MongoDB-primary — Same write pattern change as ProjectStore. `loadFromBackend()` implementations added.
- [x] **57.5** PandoNode wiring — Stores initialized conditionally: user data stores only created when StorageBackend is available. `hasStorageBackend()` getter for API guards.
- [x] **57.6** API Server 503 guards — User data endpoints return 503 Service Unavailable when StorageBackend is not configured. P2P endpoints unaffected.
- [x] **57.7** Genome documentation — Updated `data-residency.md`, `state.md`, `roadmap.md`, `phases.md`, `storage-backend.md`, `project-store.md`.
- [x] **57.8** Full codebase audit — Fixed dropped promise in agent-manager.ts, stale `storageConnected` bug in api-server.ts, 10 stale references in 7 files, 9 doc edits across 6 genome files.
- [x] **57.9** Resource Contribution Guide — New gateway page `/resources/guide` with step-by-step tutorials for all 5 providers (OpenAI, Anthropic, Gemini, MongoDB Atlas, AWS S3). TUI `/contribute mongodb` shows restart hint. TUI `/contribute aws` supports JSON credentials with field validation. Links from Resources and Services pages.
- [x] **57.10** Unreserved 'pando' username — Removed from reserved username list in `user-accounts.ts`.

---

## Phase 56: P2P User Accounts -- COMPLETE

- [x] **56.0** Ledger schema — added `username`, `display_name`, `password_hash`, `is_claimed` columns to accounts table
- [x] **56.1** AccountStore auth methods — `claimAccount()`, `applyRemoteClaim()`, `getByUsername()`, `getAuthFields()`, `isUsernameAvailable()`, `getClaimedAccounts()`
- [x] **56.2** P2P account sync — `ACCOUNT_CLAIM` broadcasts via GossipSub, claimed accounts included in `SYNC_RESPONSE` catch-up
- [x] **56.3** UserAccountStore rewrite — removed MongoDB/StorageBackend dependency, auth delegates to ledger, local `auth-local.db` for sessions + key_store only
- [x] **56.4** Node wiring — UserAccountStore takes PandoLedger instead of StorageBackend, broadcast claim wired after sync start
- [x] **56.5** API cleanup — removed duplicate `ledger.registerNode()` calls, removed `/auth/me/nodes` endpoints

---

## Phase 55: Resource UX Simplification + User Ownership -- COMPLETE

- [x] **55.1** Service presets -- Gateway contribute form uses 6 service presets (OpenAI, Anthropic, Google Gemini, MongoDB, AWS S3, Other) with dynamic credential fields. Removed Price/Model/Provider fields.
- [x] **55.2** User-owned resources -- `userId` field added to ResourceRecord. Resources belong to users, not nodes. SQLite migration adds `user_id` column. `revokeResource()` checks userId OR nodeId ownership.
- [x] **55.3** Auth-gated contribute -- Login required. Gateway passes `X-User-Token` header through proxy routes. Node extracts userId via `resolveUserPeerId()`.
- [x] **55.4** TUI service mapping -- `/contribute <service> <key>` maps service names to types + metadata. Unknown names show error (no fallback).
- [x] **55.5** SSE spam fix -- Early-return before console.log in `pushEvent()` when no SSE clients connected.
- [x] **55.6** Launcher fix -- `start-node.bat` and `start-node.command` use `tui.js` instead of `cli.js`.
- [x] **55.7** Genome documentation -- Updated `resource-registry.md`, `state.md`, `phases.md`.

## Phase 64a: Secure Cloud Instances + Node Specialization -- COMPLETE (2026-02-23)

- [x] **64a.1** CloudInstanceManager class (`cloud-instance-manager.ts`, ~700 lines)
- [x] **64a.2** NodeMode/LedgerMode type system (`types.ts`, `config.ts`, `cli.ts`)
- [x] **64a.3** User-data bootstrap script (Node.js 22, git clone public repo, remove SSH+SSM, tripwire)
- [x] **64a.4** Security monitor (tripwire) — detects logins/sshd/SSM/debuggers, wipes and shuts down
- [x] **64a.5** Console output endpoint (`GET /instances/:id/console`) — monitor without SSH
- [x] **64a.6** TUI commands: `/launch`, `/instances`, `/terminate`
- [x] **64a.7** API endpoints: 7 instance management routes
- [x] **64a.8** CLI flags: `--mode full|compute|relay`, `--ledger-mode full|light`
- [x] **64a.9** SQLite persistence for instance records (`cloud_instances` table)
- [x] **64a.10** Public repo created: `https://github.com/pando-lux/pando` (clean orphan branch, no secrets)
- [x] **64a.11** Identity scrub — all personal references removed from public repo
- [x] **64a.12** E2E test PASSED — EC2 instance bootstrapped, built Pando, joined P2P, API responded

**8 bugs found and fixed during E2E testing:**
1. Security group description rejected (em-dash → ASCII hyphen)
2. SSM agent triggered tripwire (Ubuntu AMI pre-install → remove in bootstrap)
3. Tripwire false positive during cloud-init (root shells → wait for cloud-init first)
4. `npm ci --ignore-scripts` skipped native modules → use `npm ci`
5. `--public` not a valid CLI flag → removed
6. Console output invisible (redirect to file only → tee to serial console)
7. GitHub repo private → made public at pando-lux/pando
8. Security group creation could return null → throw on failure

**Test result:** Instance `i-085de11a18b6033fd` (t3.small, us-east-1) — PeerId `12D3KooWFQ5tHa7BopyRkSXy9GiQF8DHfvAStBGXQPkgZqH9YrZe`, connected to Lightsail, API on port 4000 responded with valid status. Bootstrap time: ~193 seconds.

---

## Phase 65: Secure App Hosting E2E -- COMPLETE (2026-02-23)

> End-to-end verification that apps can be hosted on both S3 (Tier 1) and EC2 (Tier 2) with credential isolation via Gateway Resource Proxy.

- [x] **65.1** Test app (`tests/test-app/index.html`) — proves apps use MongoDB through Resource Proxy without seeing credentials
- [x] **65.2** New app hosting endpoints — `POST /apps/:appName/deploy` (auth required), `GET /apps/:appName/*` (serves static files with URL injection of `window.PANDO_GATEWAY_URL`, `window.PANDO_PROJECT_ID`, `window.PANDO_PROJECT_API_KEY`)
- [x] **65.3** CloudInstanceManager auto-grant — resources auto-granted to compute instances when they connect via P2P
- [x] **65.4** Bootstrap optimization — skips `tsc` build on EC2 instances (uses pre-built `dist/` from public repo)
- [x] **65.5** Remote management — seeds API token on compute instances, deploys test app from repo, sets `GATEWAY_PUBLIC_URL` env var
- [x] **65.6** Resource Proxy fix — ObjectId conversion for `_id` filters (MongoDB queries with string IDs now work correctly)
- [x] **65.7** URL injection — added to `POST /projects/:id/hosting` in API server

**E2E verified:** S3 static hosting (Tier 1) and EC2 compute hosting (Tier 2) both working. Apps access MongoDB through Gateway Resource Proxy with full credential isolation.

## Phase 66: Autonomous App Pipeline -- COMPLETE (2026-02-23)

> Wires all existing pieces (Resource Proxy, URL injection, API keys, hosting, agent system) into an end-to-end autonomous pipeline. Any agent can create a project, set up infrastructure, build an app, deploy it, validate it, and persist source code — all without manual intervention.

- [x] **66.1** Agent project creation — `POST /projects` now accepts Bearer token (dual-auth pattern, same as resource assign + API key endpoints)
- [x] **66.2** Resource type filtering — `GET /resources?type=storage_db` for targeted resource discovery
- [x] **66.3** Preflight endpoint — `GET/POST /projects/:id/preflight` checks project readiness (API key, MongoDB, gateway). POST auto-fixes: generates API key, assigns first available MongoDB resource
- [x] **66.4** Post-deploy validation — `POST /projects/:id/validate-deploy` checks URL responds, injection worked, Resource Proxy works
- [x] **66.5** Marketplace auto-listing — successful deploy auto-updates project record with `deploymentUrl` and `deploymentStatus`
- [x] **66.6** GitHub push — source code pushed to GitHub after S3 deploy using contributed `code_repository` resource. Public repos under `pando-lux` org
- [x] **66.7** Workspace hydration — new agents clone from GitHub if project has `repoUrl` (solves node-goes-down code persistence)
- [x] **66.8** Manager template — fixed `resourceType` → `type` field name, added Quick App Setup workflow with preflight, added post-deploy validation
- [x] **66.9** Builder template — added deploy + validate-deploy instructions, GitHub push awareness

**Key design decisions:**
- GitHub push is non-blocking: if it fails, S3 deploy still counts as success
- Workspace cleanup unchanged (24h→30d→180d): GitHub is the durable store, workspace is ephemeral cache
- Agent-created projects owned by node's peerId (node and its agents can manage them)
- Preflight auto-fix is idempotent: calling it multiple times is safe

**E2E tested — 4 bugs found and fixed during testing:**
1. `console.warn` not captured by FileLogger — FileLogger only patches `console.log`, `console.error`, `console.debug`. Changed deploy/validation logging from `console.warn` to `console.log` so it appears in `~/.pando/logs/node.log`.
2. GitHub push used org endpoint (`orgs/pando-lux/repos`) which 404'd when token owner isn't an org member — now uses `user/repos` endpoint by default, only uses org endpoint when org is explicitly specified in resource metadata.
3. validate-deploy fetched the gateway proxy URL instead of the direct S3 URL — gateway proxy may not exist or may route differently. Fixed to use direct S3 deployment URL for reliable health checks.
4. validate-deploy wrote to `__preflight_test` collection — Resource Proxy rejects collections starting with `__` (validation rule). Changed to `pando_health` collection.

---

## Phase 70: Unified App Platform -- COMPLETE (2026-02-24)

- [x] **70.1** Unified `POST /projects/:id/deploy` endpoint — handles GitHub push + S3 (Tier 1) or EC2 (Tier 2) deployment in one call
- [x] **70.2** GitHub push via resource PAT to `pando-lux` org
- [x] **70.3** Preflight auto-fix (POST /projects/:id/preflight)
- [x] **70.4** Post-deploy validation (POST /projects/:id/validate-deploy)

---

## Phase 73: P2P Self-Upgrade Protocol -- SUPERSEDED by Phase 82 (2026-02-24)

> **Note:** Phase 73 built a patch-distribution system (base64 diffs, `git apply`, canary). Phase 82 replaced it with simple `git pull` + hash verification. The entries below are historical.

- [x] **73.1** `createUpgradeProposal()` — diff → base64 → governance proposal *(replaced: Phase 82 uses commitHash only)*
- [x] **73.2** `applyApprovedUpgrade()` — verify hash → git apply → commit → build → restart *(deleted: Phase 82 uses `pullAndUpgrade()`)*
- [x] **73.3** GossipSub `pando/upgrades` topic — broadcasts commit hash to all nodes *(simplified: hash notification, not full patches)*
- [x] **73.4** Auto-approve when peers <= threshold (default 8) *(kept in Phase 82)*
- [x] **73.5** Timer-based catch-up: `checkForMissedUpgrades()` polls governance every 5min + 30s after startup
- [x] **73.6** Canary deploy *(deleted in Phase 82 — no canary, just pull + build)*

---

## Phase 78: Git Pull Upgrade + Tree Hash -- SUPERSEDED by Phase 82 (2026-02-24)

> **Note:** Phase 78 introduced git pull for receivers (replacing `git apply`). Phase 82 simplified further by removing canary/rollout entirely.

- [x] **78.1** Replace patch-based receiver upgrade with `git fetch origin && git reset --hard origin/master` *(kept in Phase 82)*
- [x] **78.2** Tree hash verification *(replaced by commit hash verification in Phase 82)*
- [x] **78.3** `pushToGitHub()` returns orphan commit tree hash *(simplified: Phase 82 uses `git rev-parse HEAD`)*
- [x] **78.4** `startFullRollout()` uses tree hash in broadcast *(deleted: Phase 82 uses `broadcastUpgradeNotification()`)*
- [x] **78.5** `isCatchup` parameter *(replaced: Phase 82 uses soft hash verification for all cases)*
- [x] **78.6** Proposer flow: push to GitHub → broadcast commit hash → peers pull + verify + build + restart

---

## Phase 79: Deploy Pipeline E2E Fixes -- COMPLETE (2026-02-25)

5 bugs fixed to achieve 22/22 E2E deploy tests passing (twice consecutively).

- [x] **79.1** GitHub repo creation 404 (api-server.ts ~line 6066) — `POST /orgs/pando-lux/repos` returned 404 because PAT account is type "user", not org admin. Fix: check `accountType` from resource metadata; use `/user/repos` for user accounts, `/orgs/{org}/repos` for org accounts.
- [x] **79.2** App repos always public (api-server.ts) — repos were created private when project visibility was `owner_only`, but EC2 needs unauthenticated clone access. Fix: app repos are always `private: false`.
- [x] **79.3** ProjectStore MongoDB field loss (project-store.ts) — `updateProject()` read from SQLite (which lacks tier/deploymentPort/instanceId/githubRepo columns), converted to record, and overwrote MongoDB — losing MongoDB-only fields. Fix: new `persistProjectToMongo()` helper reads existing MongoDB record, merges with SQLite record, preserves MongoDB-only fields. All 9 `putRecord('projects', ...)` calls now use this helper (except `createProject` which creates fresh records).
- [x] **79.4** Deploy endpoint silent failure (api-server.ts) — when EC2 deploy handler returned `{ status: 'failed', error: '...' }`, the api-server treated it as success because `response.success` was true (handler didn't throw). Fix: added check for `payload.status === 'failed'` after receiving P2P response.
- [x] **79.5** S3 storage_blob resource (operational) — no `storage_blob` resource existed in ResourceRegistry; existing credential in MongoDB lacked bucket info. Fix: created proper S3 credential with accessKeyId/secretAccessKey/region/bucket, registered as `storage_blob` resource, revoked broken duplicate.
- [x] **79.6** Earlier fixes carried forward — `recordToProject()` and `projectToRecord()` include `tier`, `deploymentPort`, `instanceId`, `githubRepo`; POST /projects and PATCH /projects/:id accept `tier` field; `.gitattributes` for LF line endings on shell scripts.

**E2E results (22/22 passing):**
- Tier 1 (S3): Create project → Preflight → GitHub push → P2P deploy to EC2 → S3 upload → URL accessible → Env vars injected → Content correct
- Tier 2 (EC2): Create project → Preflight → GitHub push → P2P deploy to EC2 → npm install → App started → Health check → All env vars injected
- Tier 1 URL: `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/475d8f37b1d5aea5d2ffdfab/index.html`
- Tier 2 URL: `http://54.82.241.132:3001/` — Node.js backend on EC2, all env vars injected

---

## Phase 80: Production App Hosting — nginx + PM2 + Stable URLs + Undeploy -- COMPLETE

> 2026-02-25. Fixes 3 critical Tier 2 problems: port counter resets on restart, apps die on reboot, no undeploy capability. Adds nginx reverse proxy for stable URLs.

- [x] **80.1** Persistent Port Registry — replaced in-memory `runningApps` Map + `nextAppPort` counter with JSON file `app-ports.json` in data dir. Functions: `loadPortRegistry()`, `savePortRegistry()`, `nextAvailablePort()`.
- [x] **80.2** PM2 Process Management — replaced `child_process.spawn({ detached: true })` with PM2 CLI (`pm2 start/delete/save`). Apps persist across reboots via `pm2 save` + `pm2 startup systemd`.
- [x] **80.3** nginx Reverse Proxy — EC2 bootstrap installs nginx, creates `/etc/nginx/pando-apps/` dir with sudoers for `pando` user. Deploy handler writes per-app nginx config and reloads. URLs: `http://<ip>/apps/<projectId>/`.
- [x] **80.4** URL Construction — `api-server.ts` returns `http://<ip>/apps/<id>/` instead of `http://<ip>:<port>/` for Tier 2 deploys.
- [x] **80.5** Undeploy P2P Handler — `pando/undeploy-app` handler on compute nodes: PM2 delete + nginx config remove + port registry cleanup + optional file deletion.
- [x] **80.6** Undeploy API Endpoint — `POST /projects/:id/undeploy` with owner/bearer auth. Tier 2: P2P undeploy. Tier 1: S3 file cleanup (scoped to `public/<projectId>/` prefix). Clears deployment fields in MongoDB.
- [x] **80.7** Startup Reconciliation — compute nodes cross-check port registry with `pm2 jlist` on startup, log warnings for orphans.
- [x] **80.8** Gateway UI — Undeploy button on projects page, delete/manage option for owners in marketplace, gateway proxy route `/api/projects/[id]/undeploy`.
- [x] **80.9** Admin Endpoints — `POST /admin/migrate-apps` (redeploy from dead instance to running one), `POST /admin/cleanup-projects` (archive/soft-delete).
- [x] **80.10** Security Group — port 80 added to EC2 security group creation for new instances.

**Bug fix during deployment:**
- ESM `require()` error — `loadPortRegistry`/`savePortRegistry` used `require('node:fs')` which fails in ESM (`packages/node` has `"type": "module"`). Fixed by using already-imported `readFileSync`/`writeFileSync` from top-level import.

**E2E results:**
- Deploy: `POST /projects/:id/deploy` → P2P to EC2 → git clone/pull → npm install → PM2 start → nginx config → reload → URL `http://54.82.241.132/apps/<id>/`
- App 1: port 3001, App 2: port 3002 (sequential, from persistent registry)
- nginx proxy: HTML served, `/api/status` returns JSON, `/health` returns `{"healthy":true}`
- Undeploy: PM2 deleted, nginx config removed, port registry cleared, URL returns 404
- Redeploy: port registry starts fresh from 3001, apps get correct ports
- Admin cleanup: projects archived successfully

**Files modified:**
- `packages/node/src/index.ts` — port registry, PM2 spawn, nginx config gen, undeploy handler, startup reconciliation
- `packages/node/src/api-server.ts` — URL construction, undeploy endpoint, migrate-apps, cleanup-projects
- `packages/node/src/cloud-instance-manager.ts` — bootstrap: nginx+PM2 install, base nginx config, sudoers, port 80 SG
- `packages/gateway/app/projects/page.tsx` — Undeploy button
- `packages/gateway/app/marketplace/page.tsx` — Delete/manage for owners
- `packages/gateway/app/api/projects/[id]/undeploy/route.ts` — NEW: gateway proxy route
- `packages/gateway/lib/node-connection.ts` — `undeployProject()` method

---

## Phase 81: Bulletproof Self-Upgrading Nodes -- COMPLETE

Dev mode (≤8 nodes) auto-approves all upgrades. Live mode (>8 nodes) uses full governance.

- [x] **81.1** Fix auto-approve threshold — `DEFAULT_UPGRADE_AUTO_APPROVE_THRESHOLD` 4→8, `<` → `<=` (governance.ts line 60, 1762)
- [x] **81.2** Skip reputation check in dev mode — nodes with negative reputation can propose upgrades when ≤8 peers (upgrade-protocol.ts lines 255-264)
- [x] **81.3** ~~Lenient canary in dev mode~~ *(deleted in Phase 82 — no canary system)*
- [x] **81.4** Fix auto-approve display — `<` → `<=` in api-server.ts (line 2643) and tui.ts (line 2066)
- [x] **81.5** Post-restart version logging — write `last-upgrade.json` before exit 75, log on next boot (index.ts)

**Superseded by Phase 82.**

---

### Phase 82 — Simple Self-Upgrade (Git Pull + Hash Verification)

Replaced the complex Phase 73/81 patch-distribution system with simple `git pull` + hash verification.

- [x] **82.1** Rewrite upgrade-protocol.ts — delete canary, rollout, patch application, reputation gates (~850 lines removed)
- [x] **82.2** New `pullAndUpgrade()` method — git fetch → verify hash → git reset → build → restart
- [x] **82.3** Simplify GossipSub handler — receives `upgrade_available` with commit hash (not full patch bytes)
- [x] **82.4** Simplify governance callback — pull locally, broadcast hash to peers (no canary step)
- [x] **82.5** Delete 4 API endpoints — `/upgrade/canary`, `/upgrade/rollout`, `/upgrade/review`, `/upgrade/vote`
- [x] **82.6** Simplify types — remove `CanaryResult`, `RolloutResult`, `diff` field, `canaryRunning`, `postDeployMonitoring`
- [x] **82.7** Update all genome docs

**Design:** Governance approves → commit hash broadcasts via GossipSub → all nodes `git pull` → verify hash → build → restart. One path, no fallbacks.

**What was deleted:**
- Canary deployment (10s/60s health monitoring)
- Patch distribution (base64 diffs over GossipSub)
- `git apply` on peer nodes
- Reputation gates for proposals
- Post-deploy monitoring (24h)
- Review endpoint
- Vote endpoint

**Files modified:**
- `packages/node/src/upgrade-protocol.ts` — major rewrite (1227 → ~380 lines)
- `packages/node/src/index.ts` — simplified GossipSub + governance wiring
- `packages/node/src/api-server.ts` — deleted 4 endpoints, simplified status
- `packages/node/src/tui.ts` — simplified propose + status
- `packages/shared/src/types.ts` — simplified upgrade types

---

## Phase 83: Network Hardening — P2PStorageBackend + Two-Tier Trust -- COMPLETE (2026-02-25)

> Transform the network from "dev mode" (all nodes have MongoDB + master key) to the real two-tier trust architecture. Untrusted nodes proxy all storage operations to compute nodes via P2P.

- [x] **83.0** Architecture docs updated — storage-backend.md, credential-security.md, state.md, phases.md, genome.yaml, api-server.md, CLAUDE.md
- [x] **83.1** P2PStorageBackend (`p2p-storage-backend.ts`) — implements StorageBackend interface, proxies via `pando/storage-proxy` P2P handler
- [x] **83.2** Wire in `index.ts` — create P2PStorageBackend when no `PANDO_STORAGE_URL`, register `pando/storage-proxy` handler on compute nodes
- [x] **83.3** `storageBackend` field on CapabilityProfile (`types.ts`, `capability-detector.ts`)
- [x] **83.4** Rate limit increase (`request-reply.ts`) — 30→120 req/min, 60→240 reply/min
- [x] **83.5** Build + verify locally — all 5 packages compile clean
- [x] **83.6** Deploy to EC2 + Lightsail, remove MongoDB from Lightsail, test E2E
- [x] **83.7** Fix startup race: P2PStorageBackend waits 30s for compute peers before failing
- [x] **83.8** Fix crash: wrap loadFromBackend (ProjectStore, RevenueEngine, ContributionTracker) in try/catch
- [x] **83.9** Fix payload limit: agent-message limit 8KB→256KB for storage proxy responses (37 projects = 46KB)
- [x] **83.10** Fix cache staleness: EC2 refreshes ThreadStore/ProjectStore cache after proxy writes
- [x] **83.11** Deferred data loading: `_p2pDataLoaded` flag + auto-retry when first compute peer connects (5s delay for capability sync)
- [x] **83.12** EC2 systemd service: migrated from raw process to `pando-node.service` (auto-restart, boot-start, env vars in unit file)
- [x] **83.13** EC2 failure resilience: P2PStorageBackend auto-fails over to next compute peer (Windows backed up EC2 during downtime — data persisted)
- [x] **83.14** Full E2E test suite: **18/18 tests passing, zero intervention** — Node health (4), Thread CRUD via P2P (4), Projects (2), Network capabilities (2), Governance (1), Scheduler (1), Monitor (1), Resources (1), AI Chat (2)

---

## Phase 86: JWT Auth — Stateless Cross-Node Authentication -- COMPLETE (2026-02-25)

> Replaced MongoDB session-based auth with self-verifying JWT tokens. Cross-node auth works without any shared state.

- [x] **86.1** JWT session tokens — `createGuest()`, `login()`, `loginByPeerId()` now return JWTs signed by the node's Ed25519 private key. Token payload: `{ userId, peerId, issuer (nodeId), exp }`. No database writes for sessions.
- [x] **86.2** JWT verification via peerId — `peerIdFromString(issuer).publicKey.verify(signature, payload)`. Any node can verify a JWT issued by any other node by deriving the public key from the issuer's peerId. No ledger lookup, no MongoDB lookup needed.
- [x] **86.3** Stateless challenge tokens — `POST /auth/challenge` returns a JWT challenge (signed, with expiry) instead of storing a nonce in an in-memory Map. `POST /auth/verify` validates the challenge JWT + Ed25519 signature, returns a session JWT. No server-side state.
- [x] **86.4** Cross-node auth fix — original implementation used `node.getIdentity().peerId` for verification, which only worked for locally-issued tokens. Fixed to use `peerIdFromString(issuer)` to extract the public key from the peerId embedded in the JWT, enabling verification of tokens from any node.
- [x] **86.5** 11/11 cross-node auth tests passing — covers: guest creation (JWT returned), login (JWT returned), JWT verification (local), JWT verification (cross-node via peerIdFromString), challenge-response (stateless JWT challenges), token expiry, invalid signatures rejected.
- [x] **86.6** Dead code identified — `auth_sessions` table in `auth-local.db`, `validateSession()`, `refreshSession()`, `cleanupExpiredSessions()`, `startCleanup()`/`stopCleanup()`, `getUserSessions()` are all dead code. To be removed in follow-up cleanup.

**Key design decision:** JWTs are verified purely from the cryptographic material embedded in the token itself (peerId -> public key -> verify signature). This means auth is fully stateless and works across nodes without any shared database or P2P coordination. A token issued by Node A can be verified by Node B without Node B ever having communicated with Node A.

**Files modified:**
- `packages/node/src/user-accounts.ts` — JWT creation (sign with Ed25519 key) and verification (peerIdFromString)
- `packages/node/src/api-server.ts` — `/auth/challenge` and `/auth/verify` endpoints updated for stateless JWT challenges

---

## Phase 87: P2P Deploy Discovery — COMPLETE (2026-02-25)

> Deploy endpoint now uses P2P CapabilityProfile discovery instead of CloudInstanceManager. Fixes the root architecture gap where persistent EC2 nodes couldn't be found for deployment.

- [x] **87.1** Add `publicAddress` to CapabilityProfile — new optional field set via `PUBLIC_IP` env var. Used for Tier 2 URL construction.
- [x] **87.2** Rewrite deploy endpoint — `POST /projects/:id/deploy` filters CapabilityRegistry for `storageBackend === 'mongodb'` peers, tries up to 3 via P2P `requestReply.request()`. Stores `deployPeerId` (not `instanceId`).
- [x] **87.3** Rewrite undeploy endpoint — reads `project.deployPeerId` directly, no CloudInstanceManager lookup.
- [x] **87.4** Deploy handler returns `publicAddress` — Tier 2 handler includes `PUBLIC_IP` in response for URL confirmation.
- [x] **87.5** AgentManager compute node provider — `setCloudInstanceProvider` → `setComputeNodeProvider`. Agent context shows P2P-discovered compute peers.
- [x] **87.6** Bootstrap mesh fix — added EC2-1 to `DEFAULT_BOOTSTRAPS`. New nodes connect to 2 bootstrap peers for better mesh connectivity.

**Root cause fixed:** Deploy was built around `CloudInstanceManager` which only tracked dynamically-launched EC2 instances. Persistent nodes (the actual production compute) were invisible. Now uses the same P2P CapabilityProfile discovery that P2PStorageBackend already uses for storage routing — one pattern for everything.

**Files modified:**
- `packages/shared/src/types.ts` — `publicAddress` field on CapabilityProfile
- `packages/node/src/capability-detector.ts` — `detectPublicAddress()` from `PUBLIC_IP` env var
- `packages/node/src/api-server.ts` — deploy+undeploy endpoints rewritten for P2P discovery
- `packages/node/src/index.ts` — deploy handler returns publicAddress; `setComputeNodeProvider` wiring
- `packages/node/src/agent-manager.ts` — renamed `setCloudInstanceProvider` → `setComputeNodeProvider`
- `packages/node/src/cli.ts` — EC2-1 added to `DEFAULT_BOOTSTRAPS`

## Phase 88: Auto-Detect Tier from Code — COMPLETE (2026-02-25)

> Tier is now detected from the actual cloned code at deploy time, not guessed by the doorman AI. Code is truth.

- [x] **88.1** Add `detectTierFromCode(appDir)` function to compute node deploy handler (`packages/node/src/index.ts`). Inspects package.json: start script → Tier 2, server deps (express/fastify/socket.io/ws) → Tier 2, main → server file → Tier 2, backend/ dir → Tier 2. Default → Tier 1.
- [x] **88.2** Use `effectiveTier` (detected) in deploy handler branching — replaces the caller's `tier` value for both S3 upload (Tier 1) and PM2 start (Tier 2) paths.
- [x] **88.3** Return `detectedTier` and `tierReason` in deploy response — caller (`api-server.ts`) reads these, auto-corrects `project.tier` on the project record and ProjectRegistry.
- [x] **88.4** URL construction uses detected tier — `actualTier === 2 && payload.port` instead of `tier === 2`.

**Root cause fixed:** Tier was guessed once from user message by doorman (GPT-4o-mini) and locked on the project forever. Misclassification (e.g., "voting app" as Tier 1) caused broken deploys — WebSocket code on S3 fails silently. Now the compute node inspects the code and overrides the tier if needed.

**Files modified:**
- `packages/node/src/index.ts` — `detectTierFromCode()` function, `effectiveTier` branching, return `detectedTier`/`tierReason`
- `packages/node/src/api-server.ts` — URL construction uses `actualTier`, project update uses `detectedTier`

---

## Future (Not Scheduled)

- [ ] Dynamic concurrent sessions based on CPU/memory
- [ ] Memory encryption at rest
- [ ] Payment flow (see REWARD-ARCHITECTURE.md)
- [ ] Conditional governance voting
- [ ] Proposal amendments and merging
- [ ] Delegated voting
- [ ] Network sharding for 1000+ nodes
- [ ] User-facing marketplace (browse services, submit requests)
- [x] Tool scoping per role (`f480d61`) -- 3-layer enforcement
- [x] Network Explorer mode (`00e375e`) -- gateway toggle My Node vs Entire Network
- [x] Remote task detail queries (`00e375e`) -- P2P request-reply handlers
- [x] Agent cost tracking per task (`4a0cbec`) -- TaskCost on Task, GET /scheduler/costs
- [x] Documentation Manager -- superseded by Phase 22 (managers update docs in normal workflow)
- [x] Pipeline Auto-Commit Reliability -- addressed by Phase 22.5
- [x] HealthMonitor Config Persistence -- addressed by Phase 22.4
- [x] Capability-Aware Health Recovery -- addressed by Phase 22.4
