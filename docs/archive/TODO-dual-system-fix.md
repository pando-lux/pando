# Dual System Kill — Status & Next Steps

## PHASE 1: Brain Kill (COMPLETE 2026-03-06)

- [x] EnginePool built in pando-code (`pool/engine-pool.ts` ~230 lines)
- [x] Scheduler built in pando-code (`pool/scheduler.ts` ~200 lines)
- [x] PandoServer built in pando-code (`server/server.ts` ~200 lines)
- [x] All three exported from @pando-code/core index.ts
- [x] Build passes clean
- [x] Create engine-adapter.ts in pando-node (uses EnginePool)
- [x] Rewire chat API to use adapter
- [x] Remove brain from index.ts
- [x] Delete brain files (9,414 lines deleted — 15 files)
- [x] Fix imports + build — clean across all packages
- [x] Add governance AI review hook (Layer 5 in kernel/governance.ts)
- [x] BIBLE.md updated with brain-kill completion

## PHASE 2: Distributed Compute Model (NEXT)

Architecture decided 2026-03-06. See BIBLE.md Sections 5.1, 5.5, 5.9.

**Core principle: Keys don't travel. Work travels.**

### Path A fixes (Simple AI — contributed keys on EC2):
- [ ] Fix doorman to use local OPENAI_API_KEY env var when available (no CredentialStore needed)
- [ ] Fix doorman fallback: route classification to PandoCode engine when no OpenAI key
- [ ] Verify Path A works on EC2 nodes (contributed keys decrypted server-side)

### Path B fixes (Builds — PandoCode contributor nodes):
- [ ] Remove `injectApiKeys()` MongoDB logic from engine-adapter (local env vars only)
- [ ] Fix engine adapter to just use whatever API keys are in local env
- [ ] P2P build routing: route "build" intent to pando-code capable peer when no local PandoCode
- [ ] Verify build flow end-to-end on a PandoCode contributor node

### Contributor model:
- [ ] Contributor limits: max requests/day, budget caps in capability profile
- [ ] Earning: Lux per job completed (compute cost → Lux conversion)
- [ ] Advertise pando-code capability with limits in capability profile

### Claude Code CLI integration (pando-code repo):
- [ ] PandoCode tool/subprocess to invoke `claude -p` for coding tasks
- [ ] PandoCode orchestrates Claude Code as sub-process for superior coding
- [ ] Contributor earns Lux when their Claude Code processes network jobs

### Gateway cleanup:
- [ ] Remove agent tree page (no more orchestrators)
- [ ] Remove council dashboard references
- [ ] Update chat UI for two-path model (simple AI vs build)
