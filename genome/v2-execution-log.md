# Pando v2 — Execution Log

> **Living document.** Updated after every decision, every phase, every issue hit. This is the night-shift log.
>
> **Started:** 2026-02-26 ~02:00
> **Branch:** `v2-architecture`

---

## Founder Mandate (verbatim, 2026-02-26)

> "but im not launching anytime soon.. thats why i dont care about the installer right now... i want to build the architecture test with our own dev nodes all scenarios as if its all real.. then attract a few test developers... then go public thats why... other than that i think lets do as you say... i agree with all ur points but be careful... lets start you have full control.. i am going to sleep for 6 hours.. you can launch parallel agents. write test scenarios or update existing ones... update any and all docs as you build things, follow and update phase plan or make adjustments as you hit issues you have full autonomy... i dont care about legacy code legacy logics or backward compatibility make a note for all agents as they build and ur phase document as we are in dev mode and we can refactor without past data need.. its a fresh start in a way. so u take control dont ask me anything plan execute test + scenarios e2e, then move to next plan.... as you please you have unlimited resources... this message im typing to you also make it part of phase document - so you keep updating ur todo list... and working through the night non stop. that will get us through how much ever progress possible u have 5 nodes to test and do what ever with... go for it good night.. dont stop until 8am."

---

## Guiding Principles for This Sprint

1. **No backward compat.** We're in dev mode. No live users. Refactor without mercy.
2. **No legacy logic.** If old code is messy, delete it. We have git.
3. **Fresh start.** Decisions made tonight are the new canonical truth. Update the-stack.md and genome/ as we go.
4. **Code is truth.** Docs reflect what's actually built, not aspirations.
5. **Tests are mandatory.** Every phase ends with a test that proves it works.

---

## Agent Operating Rules (inject into every agent prompt)

```
OPERATING MODE: Dev sprint — no backward compatibility required.
LEGACY CODE: Delete it if it's in the way. We have git.
DOCS: Update genome/ for every code change. Same session, no exceptions.
TESTS: Write or update tests for everything you build.
DECISIONS: If the-stack.md or v2-architecture-plan.md says something unclear,
           make the better decision and update the doc. Note it in v2-execution-log.md.
SOURCE OF TRUTH: genome/foundation/the-stack.md (target) + genome/v2-architecture-plan.md (bridge).
BUILD: npm run build must pass with zero errors before any commit.
BRANCH: All work on v2-architecture branch.
```

---

## Phase Status

| Phase | Status | Notes |
|---|---|---|
| Fix two-sources (move the-stack.md) | ✅ DONE | genome/foundation/the-stack.md |
| v2.1: Directory structure + file moves | ✅ DONE | kernel/, core/, platform/, api/ layers created |
| v2.1: Import path updates | ✅ DONE | All broken imports fixed across all layers |
| v2.1: Barrel exports (kernel, core, platform) | ✅ DONE | index.ts created for each layer |
| v2.1: AI Backend interface | ✅ DONE | ai-backend.ts, ai-backend-registry.ts, ai-backend-claude.ts, ai-backend-ollama.ts |
| v2.1: agent.ts uses AIBackendRegistry | ✅ DONE | executeSpawn() replaced; ClaudeBackend extracted |
| v2.1: AgentTemplate capabilities | ✅ DONE | Already in shared/types.ts with AgentCapabilityDeclaration |
| v2.1: Import boundary lint | ✅ DONE | scripts/check-imports.mjs passes clean |
| v2.1: Full build pass | ✅ DONE | Zero TypeScript errors across all packages |
| v2.1: Split api-server.ts | ✅ DONE | 7292→887 lines; kernel-api.ts (2249L), core-api.ts (370L), platform-api.ts (3882L), middleware/auth.ts |
| v2.1: Deploy + smoke test all 5 nodes | ⏳ QUEUED | Ready for deployment |
| E2E test scenarios | ✅ DONE | genome/flows/e2e-test-scenarios.md — 42 scenarios written by parallel agent |
| v2.2: API versioning | ⏳ QUEUED | After v2.1 deploys |

---

## Decisions Made

### 2026-02-26 — Sources of Truth Consolidated
- Moved `the-stack.md`, `ai-os-architecture.md`, `philosophy.md` into `genome/foundation/`
- These docs were previously outside the repo (Desktop/Docs/pando/)
- Rule: genome/foundation/the-stack.md is canonical. When code diverges from it, update the doc.

### 2026-02-26 — No Backward Compatibility for v2
- All 5 dev nodes are under our control
- No external users
- Decision: refactor freely, upgrade all nodes atomically when phases complete
- No aliases, no legacy paths, no v1-vs-v2 shims needed yet

---

## Issues Hit

### v2.1 Import Fix (2026-02-26)
- Files were git mv'd to kernel/core/platform/api/ dirs but imports were left as flat `./xxx.js`
- Fixed all imports systematically: index.ts, cli.ts, tui.ts, api/api-server.ts, all kernel/, core/, platform/ files
- Cross-layer violations auto-detected and fixed: kernel/sync.ts had `./project-registry.js` (platform) → replaced with local `ProjectRegistryLike` interface
- kernel/reputation.ts had `./request-reply.js` (core) → replaced with `RequestReplyLike` interface
- kernel/monitor.ts had `./scheduler.js` (platform) → replaced with `SchedulerLike` interface
- kernel/governance.ts had `./reputation-governance.js` (platform), `./payment-gate.js` (core), `./agent-manager.js` (core) → all replaced with minimal interfaces
- All interfaces use structurally-compatible minimal types, preserving TypeScript type safety

### v2.1 agent.ts Refactoring (2026-02-26)
- Extracted all Claude Code spawn logic from agent.ts executeSpawn() into ClaudeBackend.execute()
- agent.ts now routes via AIBackendRegistry (or falls back to ClaudeBackend directly if no registry)
- State mutation (sessionId capture, cost tracking, context window) stays in agent.ts
- Removed unused spawn, execSync, detectClaudePath, buildAugmentedPath, SPAWN_IDLE_TIMEOUT_MS, SPAWN_HARD_CAP_MS from agent.ts
- `childPid` field kept for backward-compatible `getChildPid()` API (always null now)
- startSession() no longer checks for Claude CLI directly — that's the backend's job

### v2.1 API Split (2026-02-26 — COMPLETED)
- api-server.ts was 7292 lines — split into 5 files:
  - `api/middleware/auth.ts` — RouteHelpers interface + createAuthHelpers factory
  - `api/kernel-api.ts` — Layer 0 routes (2249L): /health, /status, /peers, /balance, /transfer, /governance/*, /monitor/*, /network/*, /scheduler/*, /upgrade, /security/*, etc.
  - `api/core-api.ts` — Layer 1 routes (370L): /upgrade (main), /emissions/*, /security/*
  - `api/platform-api.ts` — Layer 2 routes (3882L): /chat/*, /auth/*, /projects/*, /instances/*, /apps/*, /resources/*, /content/*, etc.
  - `api/api-server.ts` — ApiServer class (887L): Fastify setup, auth hooks, rate limiting, SSE, private helpers, buildRouteDeps()
- Pattern: ApiServer builds a RouteHelpers deps object and passes it to each registerRoutes function
- AgentManager passed as `getAgentManager()` closure to platform-api to support late binding
- SSE client management: addSSEClient/removeSSEClient exposed via RouteHelpers
- Build passes clean. Smoke test: /health returns 200 with correct JSON
- NODE_STARTED_AT constant lives in kernel-api.ts (closest to usage)

---

## Audit Trail

### ~02:00 — Sprint started
- Created `v2-architecture` branch
- Moved the-stack.md into repo
- Created this execution log
- Spawned parallel agents for v2.1 file structure + E2E test scenarios

### E2E Test Scenarios Written (parallel agent)
- Created `genome/flows/e2e-test-scenarios.md` — 42 scenarios total
- Coverage: Layer 0 (15 scenarios), Layer 1 (15 scenarios), Layer 2 (7 scenarios), Degraded Mode (5 scenarios)
- AI Backend scenarios (v2.1): Scenarios 34-37 — claude-code detect, ollama unavailable, registry selection, fallback
- Cross-node scenarios: Scenarios 38-42 — full mesh, bootstrap reconnect, transfer chain, agent collab, partition recovery
- Updated `genome/flows/human-e2e-test.md` to reference the new comprehensive file
- Priority smoke test: 10 scenarios + copy-paste bash commands for quick verification

