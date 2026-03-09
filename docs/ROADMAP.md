# Pando Roadmap

> Single source of truth for what needs to be done. All completed roadmaps are in `docs/archive/`.

## What's Built & Working (2026-03-09)

- **4-node P2P mesh**: Windows + EC2-1 + EC2-2 + Mac, all auto-upgrading
- **Governance-gated auto-upgrade**: commit-and-propose → governance → direct P2P notification → all nodes pull/build/restart
- **Modular service architecture**: PandoService interface, ServiceLoader, light/full node modes
- **Team architecture**: TeamRegistry, board CRUD, agent spawn/stop, inter-agent messaging, templates
- **Autonomous council**: pando-infra team (lead + observer + QA) processes tasks and deploys code without human intervention
- **Board persistence**: board-state.json saved atomically, restored on team claim
- **Engine watchdog**: 60s health check, auto-restart dead processes, circuit breaker
- **Orphan detection**: scans for dead managing nodes, auto-claims orphaned teams
- **Full agent identity**: Ed25519, certificates, signed actions, Pando Login
- **Security hardened**: shell injection fixed, crypto randomness, sanitized errors, pre-commit credential blocking

## Current Mode: Council-Driven Development

**The pando-infra council handles all code changes now.** See `docs/COUNCIL-ROADMAP.md` for:
- The task backlog (ordered by difficulty)
- Operating protocol (how to submit tasks, verify results)
- Progress log (what the council has completed)

Humans submit tasks one at a time and observe. Intervention only when council is stuck.

## Completed Phases

| Phase | What | Status |
|-------|------|--------|
| Security Hardening | Shell injection, randomness, error leaks, governance enforcement | COMPLETE |
| Service Architecture | PandoService interface, ServiceLoader, light/full node modes | COMPLETE |
| Cross-Node Failover | Orphan detection, team claim, board sync (on-demand) | COMPLETE (proactive replication TODO) |
| Unified Pipeline | GitOps, AppManager, commit-and-propose | COMPLETE |
| Self-Upgrade | Governance-gated auto-deploy to all nodes | COMPLETE |
| E2E Testing | 204/204 Playwright tests | COMPLETE |

## Open Work (Council Backlog)

See `docs/COUNCIL-ROADMAP.md` for the full ordered backlog. Summary:

- **Tier 1**: Easy wins (header comments, label fixes) — confidence building
- **Tier 2**: Legacy /council/* route cleanup — remove 9 deprecated endpoints
- **Tier 3**: Proactive board replication, network partition handling, activity history endpoint
- **Tier 4**: README.md creation

## Future (Human-Required)

- Rotate AWS credentials (IAM console)
- Scrub secrets from git history (`git filter-repo`)
- Make pando-code repo public
- EC2 SSH security group update
- Vercel gateway env vars configuration
- Gateway dashboard UI improvements
- P2P app deployment across nodes
- Scale readiness (resource limits, load balancing, protocol versioning)

## Reference Docs (in archive)

| File | What | Why archived |
|------|------|-------------|
| `SERVICE-ARCHITECTURE-ROADMAP.md` | Modular service plugin system | Phases 0-1, 4-6 complete |
| `UNIFIED-PIPELINE-ROADMAP.md` | 7-phase pipeline consolidation | All phases complete |
| `SELF-UPGRADE-ROADMAP.md` | Autonomous self-modification | All phases implemented |
| `APP-LIFECYCLE-ROADMAP.md` | AppManager phases 1-3 | Phases 1-3 done |
| `TEAM-ARCHITECTURE.md` | Team system design doc | Reference, not a roadmap |
| `HUMAN-LEVEL-TESTING.md` | Manual test scenarios | Covered by failover testing |
| `E2E-ROADMAP.md` | 204/204 E2E tests | Mission complete 2026-03-06 |
| `audit.md` | Security audit findings | All issues fixed |
| `future-concerns-report.md` | Design gaps for scale | Tracked in Future section above |
