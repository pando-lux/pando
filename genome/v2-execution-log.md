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
| v2.1: Directory structure + file moves | 🔄 IN PROGRESS | |
| v2.1: Import path updates | ⏳ QUEUED | |
| v2.1: Split api-server.ts | ⏳ QUEUED | |
| v2.1: AI Backend interface | ⏳ QUEUED | |
| v2.1: AgentTemplate capabilities | ⏳ QUEUED | |
| v2.1: Import boundary lint | ⏳ QUEUED | |
| v2.1: Full build pass | ⏳ QUEUED | |
| v2.1: Deploy + smoke test all 5 nodes | ⏳ QUEUED | |
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

*(fill as they arise)*

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

