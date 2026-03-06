# TODO: Kill the Dual System — Clean Architecture

> Brainstorm doc. Delete when done.

## DONE:
- [x] EnginePool built in pando-code (`pool/engine-pool.ts` ~230 lines)
- [x] Scheduler built in pando-code (`pool/scheduler.ts` ~200 lines)
- [x] PandoServer built in pando-code (`server/server.ts` ~200 lines)
- [x] All three exported from @pando-code/core index.ts
- [x] Build passes clean
- [x] BIBLE.md updated with target architecture
- [x] Create engine-adapter.ts in pando-node (uses EnginePool)
- [x] Rewire chat API to use adapter
- [x] Remove brain from index.ts
- [x] Delete brain files (9,414 lines deleted — 15 files)
- [x] Fix imports + build — clean across all packages

## REMAINING:
- [ ] Add governance AI review hook (Layer 5 in kernel/governance.ts)
- [ ] Update E2E tests for new architecture
- [ ] Update BIBLE.md to reflect completion
- [ ] Gateway: update agent tree page (no more orchestrators)
