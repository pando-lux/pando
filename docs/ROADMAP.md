# Pando Roadmap

> Single source of truth for what needs to be done. All completed roadmaps are in `docs/archive/`.

## What's Built & Working (2026-03-09)

- **4-node P2P mesh**: Windows + EC2-1 + EC2-2 + Mac, all auto-upgrading
- **Governance-gated auto-upgrade**: commit-and-propose → governance → direct P2P notification → all nodes pull/build/restart (proven E2E, zero SSH)
- **Team architecture**: TeamRegistry, board CRUD, agent spawn/stop, inter-agent messaging, templates
- **Board persistence**: board-state.json saved atomically, restored on team claim
- **Engine watchdog**: 60s health check, auto-restart dead Claude Code processes, circuit breaker
- **Orphan detection**: 5-min scan detects dead managing nodes, auto-claims orphaned teams
- **Unified pipeline**: All git ops via GitOps class, all deploys via AppManager
- **204 E2E tests passing** (Playwright, public gateway)
- **Full agent identity**: Ed25519, certificates, signed actions, Pando Login

## Phase 1: Security Hardening — COMPLETE (2026-03-09)

Priority: **CRITICAL** — can't ship with these.

Source: `docs/archive/audit.md`

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Shell injection in buildCmd (app-manager.ts) | CRITICAL | **FIXED** — allowlist regex + execFileSync (4ef3490) |
| 2 | Weak randomness (Math.random for DB keys) | CRITICAL | **FIXED** — crypto.randomBytes/randomUUID in 8 locations (4ef3490) |
| 3 | Error messages leak system internals | HIGH | **FIXED** — 83 catch blocks sanitized across 7 API files (4ef3490) |
| 4 | Lux budget cap math broken (100 Lux/USD vs 500 cap) | HIGH | **FIXED** — removed silent cost cap, fixed USD/Lux field, LUX_PER_USD constant (e161cf3) |
| 5 | Unbounded interval accumulation (memory leak) | HIGH | **FIXED** — 6 leaked intervals now stored + cleared on shutdown (e161cf3) |
| 6 | Stale governance proposals flood on first sync | MEDIUM | **FIXED** — 7-day max-age filter on sync receive (e161cf3) |
| 7 | governanceRequired not enforced before push | MEDIUM | **FIXED** — push deferred until governance passes, 3 bypass paths blocked (e161cf3) |

All issues verified fixed and deployed to network via governance pipeline.

## Phase 2: Cross-Node Failover (Test & Fix)

Priority: **HIGH** — needed for production reliability.

**Tested 2026-03-09:** Kill Mac (managing node) → Windows detects orphan (2 min) → claims team → starts 3 agents. Local board persisted. P2P board sync failed (dead node can't respond).

**P2P board sync IMPLEMENTED (06fce4d):** BOARD_STATE_REQUEST/RESPONSE messages. Claiming node broadcasts request, peers respond with board data, 5s delay before startTeam.

**Dev mode timings (≤8 peers):** 30s orphan scan interval, 2 min stale threshold, 30s heartbeat. Production: 5 min scan, 20 min threshold, 5 min heartbeat.

**Mechanics:** Conflict resolution: latest `claimedAt` wins. Claiming node must have PandoCode (@pando-code/core) capability.

| # | Test | Status |
|---|------|--------|
| 1 | Kill managing node → orphan detection triggers on another node | **PASS** (2026-03-09) — Mac killed, Windows detected orphan in ~2 min |
| 2 | New node claims team → agents started | **PASS** (2026-03-09) — Windows claimed, 3 agents running, local board persisted |
| 3 | Split-brain: two nodes both claim same team → latest claimedAt wins | **PASS** (2026-03-09) — observed during test: team sync correctly resolved to latest claimedAt |
| 4 | Network partition: node disconnects but comes back → graceful reconciliation | NOT TESTED |
| 5 | P2P board sync — transfer board-state.json to claiming node | **PARTIAL** — code works (06fce4d) but only if old managing node is alive to respond. Dead node = board data lost |

**Known limitation:** Board data created exclusively on the dead node is lost. Board state should be proactively replicated to survive sudden node death. Current sync is on-demand (request/response) which requires the source node to be alive.

**Done when:** Board state proactive replication implemented, network partition test (#4) completed.

## Phase 3: Gateway Dashboard Integration

Priority: **MEDIUM** — user-facing, but system works without it.

| # | Feature | Status |
|---|---------|--------|
| 1 | Infrastructure dashboard shows live team status | Gateway has basic page, needs real-time updates |
| 2 | Board task view (create, update, track progress) | API exists, no gateway UI |
| 3 | Agent activity feed (what agents are doing now) | API exists (`/v1/teams/:id/agents`), no gateway UI |
| 4 | Governance proposal viewer (approve/reject from UI) | API exists, no gateway UI |
| 5 | Deploy history timeline | AppManager tracks history, no gateway UI |

**Done when:** Gateway dashboard shows team status, board, agents, governance, and deploy history.

## Phase 4: P2P App Deployment

Priority: **MEDIUM** — enables user projects to deploy across the network.

| # | Feature | Status |
|---|---------|--------|
| 1 | `appManager.deploy(appId, targetPeerId)` dispatches to remote node | Designed, not implemented |
| 2 | Remote node receives deploy request via P2P | Not implemented |
| 3 | Health monitoring across nodes (not just local) | Not implemented |
| 4 | User project teams (governanceRequired: false) deploy without voting | Config exists, not tested |

**Done when:** A user project can be deployed from one node to run on another.

## Phase 5: Scale Readiness

Priority: **LOW** — design concerns for 100+ nodes. Not blocking.

Source: `docs/archive/future-concerns-report.md`

- No resource selection strategy (returns first active key, no load balancing)
- maxUsagePerDay field never enforced
- No per-agent resource limits (budget tracked but not capped)
- StreamEvents have no versioning (protocol breakage risk)
- Agent status enum mismatch between pando-code and pando-node

**Done when:** These are addressed before public launch.

## Reference Docs (in archive)

| File | What | Why archived |
|------|------|-------------|
| `UNIFIED-PIPELINE-ROADMAP.md` | 7-phase pipeline consolidation | All phases complete |
| `SELF-UPGRADE-ROADMAP.md` | Autonomous self-modification | All phases implemented |
| `APP-LIFECYCLE-ROADMAP.md` | AppManager phases 1-3 | Phases 1-3 done, Phase 4 moved here |
| `COUNCIL-ROADMAP.md` | Team architecture phases | Core phases done, remaining moved here |
| `TEAM-ARCHITECTURE.md` | Team system design doc | Reference, not a roadmap |
| `HUMAN-LEVEL-TESTING.md` | Manual test scenarios | Scenarios moved to Phase 2 above |
| `E2E-ROADMAP.md` | 204/204 E2E tests | Mission complete 2026-03-06 |
| `audit.md` | Security audit findings | Issues moved to Phase 1 above |
| `future-concerns-report.md` | Design gaps for scale | Issues moved to Phase 5 above |
