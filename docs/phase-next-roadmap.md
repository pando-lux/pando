# Phase Next — Architecture Fixes Roadmap

> Generated 2026-03-01 after deep E2E analysis. These are real bugs found in production, not theoretical.

## Status Key
- [ ] Not started
- [~] Directive sent to council
- [x] Fixed

---

## P1 — Worker Lifecycle State Machine (CORRUPTS COUNCIL DECISIONS)

**Bug**: 31 of 43 "failed" workers actually completed their work. `kill()` in worker-pool.ts doesn't protect `'idle'` status, overwrites to `'failed'`.

**Fix**: Add `'idle'` to protected status list in `kill()` and `cleanup()`. Two lines.

**Status**: [x] Fixed (commit d5b7a471) — `idle` added to protected status list in `kill()` and `cleanup()`

**Deeper fix (optional)**: Define a formal state machine for workers:
- `spawning` → `active` → `idle` (reported done, available for reuse) → `done` (final)
- `spawning` → `active` → `failed` (process died or reported failure) → (prunable)
- Only `kill()` and `cleanup()` can set `failed`. Only the report endpoint can set `idle`. Only orchestrator dissolution can set `done`.

---

## P2 — Separate Operational State from User Data

**Bug**: `chat_proxy` handler creates projects via P2P storage proxy → circular timeout. `ThreadStore.addMessage()` fails because P2P storage backend is unavailable.

**Root cause**: No separation between local operational state and synced user data. Everything goes through one StorageBackend.

**Fix**: Two-tier storage:
- **Local SQLite** (always available, no network): active builds, worker state, tick logs, ephemeral project records during builds
- **StorageBackend** (MongoDB/P2P): user threads, persistent project data, account info

The `chat_proxy` handler should create a local-only project record. ThreadStore should write to local SQLite first, sync to MongoDB async.

**Status**: [~] Council patched chat_proxy with crypto.randomUUID() (commit 25d82c24) — band-aid, not architectural fix

---

## P3 — Cross-Node Results Delivery

**Bug**: User on EC2 gateway sends build request → proxied to Windows → Windows builds and deploys → SSE fires on Windows → user on EC2 never sees it.

**Root cause**: No mechanism to push results from the building node back to the originating node.

**Fix options**:
- A: Building node sends P2P message back to originating node with the result → originating node fires SSE
- B: ThreadStore write-through syncs to MongoDB → originating node polls thread for new messages
- C: SSE relay via P2P (originating node subscribes to remote node's events for that thread)

Option A is simplest. The `chat_proxy` response already returns `{ status: 'queued', projectId }`. When the build completes, the building node should send a P2P `chat_result` message back.

**Status**: [x] Fixed (commit 65b2ed2f) — Option A implemented: `chat_proxy` passes `originPeerId`, building node sends `chat_result` P2P message back, originating node fires SSE + writes to ThreadStore

---

## P4 — ResourceRegistry Initialization

**Bug**: `resource-registry.db` is 0 bytes, no tables. ResourceRegistry never initialized or table creation silently failed.

**Impact**: Resource metadata doesn't sync across nodes. Only ProjectRegistry works.

**Fix**: Debug ResourceRegistry startup. Check if `start()` is called. Check if the DB path is correct.

**Status**: [x] Not a bug — ResourceRegistry uses shared ledger DB (`this.ledger.getDatabase()`), not a separate file. The 0-byte `resource-registry.db` is a pre-Phase 69 leftover.

---

## P5 — Worker Record Pruning (Council Noise)

**Bug**: 50 worker records under one council session. Board state grows, AI tokens wasted, decision-making slowed.

**Fix**: `pruneOldData()` exists but only prunes workers older than 7 days. Add: after dissolution or when worker count > 20, prune `done`/`failed` workers older than 24h. Keep last 5 per role for context.

**Status**: [x] Fixed (commit 8be757ad) — 24h threshold (was 7d), aggressive pruning when >20 workers, keeps last 5 per role per orchestrator

---

## P6 — Council Data Integrity

**Bug**: Council AI reads board state with 86% failure rate (phantom). Makes decisions based on corrupted data.

**Fix**: P1 fixes the source. Additionally: board state summary in orchestrator.ts should separate "workers that reported done" from "workers marked failed by system." The AI prompt should say "12 real failures, 31 phantom (status bug)" not "43 failures."

**Status**: [ ] Blocked by P1

---

## P7 — Gateway in Governance Loop

**Gap**: Vercel gateway deploys are manual. Not part of self-sustaining loop.

**Fix**: Either move gateway to EC2 (nginx) or add Vercel deploy API to the upgrade protocol.

**Status**: [ ] Not started (documented as Core Issue 5)

---

## Dependencies

```
P1 (worker status) ← P6 (council data integrity)
P2 (storage separation) ← P3 (cross-node delivery)
P4 (resource registry) — independent
P5 (worker pruning) — independent
P7 (gateway governance) — independent
```

P1 is highest priority — everything else works better once council sees accurate data.
