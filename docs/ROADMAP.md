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

## Phase 1: Security Hardening

Priority: **CRITICAL** — can't ship with these.

Source: `docs/archive/audit.md`

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | Shell injection in git branch params | CRITICAL | Likely fixed (execFileSync) — VERIFY |
| 2 | Weak randomness (Math.random for DB keys) | CRITICAL | TODO — use crypto.randomUUID() |
| 3 | Error messages leak system internals | HIGH | TODO — sanitize HTTP error responses |
| 4 | Lux budget cap math broken (100 Lux/USD vs 500 cap) | HIGH | TODO — fix budget logic |
| 5 | Unbounded interval accumulation (memory leak) | HIGH | TODO — audit all setInterval calls |
| 6 | Stale governance proposals flood on first sync | MEDIUM | TODO — add max-age filter |
| 7 | governanceRequired not enforced before push | MEDIUM | TODO — block push until approved |

**Done when:** All CRITICAL/HIGH issues verified fixed. `audit.md` findings resolved or documented as intentional.

## Phase 2: Cross-Node Failover (Test & Fix)

Priority: **HIGH** — needed for production reliability.

The code for team migration EXISTS but has **never been tested** under real conditions.

| # | Test | Status |
|---|------|--------|
| 1 | Kill managing node → orphan detection triggers on another node | NOT TESTED |
| 2 | New node claims team → board-state.json restored → agents resume | NOT TESTED |
| 3 | Split-brain: two nodes both claim same team → latest claimedAt wins | NOT TESTED |
| 4 | Network partition: node disconnects but comes back → graceful reconciliation | NOT TESTED |

**How to test:**
1. Submit a task to pando-infra team on Windows
2. Kill the Windows node process
3. Wait 5 min — Mac should detect orphan and claim the team
4. Verify board tasks are preserved
5. Submit a new task — Mac should process it
6. Restart Windows — verify no conflict

**Done when:** Full node-death-and-recovery cycle proven E2E.

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
