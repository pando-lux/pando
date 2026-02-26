---
id: pipeline-runner
type: service
domain: pipeline
entry: packages/node/src/platform/pipeline-runner.ts
depends_on: [code-pipeline, qa-runner, deploy-manager, version-protocol, guardrails]
depended_by: [api-server, agent-manager]
status: ACTIVE
exposes:
  - runPipeline(workspaceOutputDir, governanceApprovalId?, overrides?) — execute full 7-stage pipeline
  - getPipelineStatus() — running state, current stage, runs completed, last result
  - setRestartCallback(callback) — hook for post-deploy restart
rules: [immutable-kernel, two-laws]
last_verified: 2026-02-21
---

# Pipeline Runner

## What It Does

Executes the 7-stage autonomous code pipeline for governance-approved changes. When a governance proposal passes, the manager triggers this pipeline to extract changes (via git diff), validate through guardrails, build, commit, and restart.

## How It Works

**Trigger:** `POST /pipeline/run` with `{ workspaceDir, proposalId }`. Called by the manager agent after governance approval.

**7 Stages:**
1. **Version check** — verify code version compatibility
2. **Extract diff** — for governance runs, uses `extractGitDiff()` directly (bypasses workspace). For non-governance, scans workspace dir with git diff fallback.
3. **Backup** — saves dist/ for rollback
4. **Apply** — `applyPatch()` writes changes to repo. Passes `governanceApproved` flag to guardrails. Immutable kernel NEVER bypassed.
5. **Build** — runs `npm run build`
6. **QA** — skipped for governance runs (governance IS the review gate)
7. **Commit** — auto-commits with `[pipeline]` prefix

**After success:** Writes restart-reason `pipeline-deploy`, calls `process.exit(0)` after 5s. Needs PM2/supervisor to actually restart.

## Governance Mode (Phase 33.4)

When `proposalId` is provided:
- `overrides.useGitDiff = true` — uses `extractGitDiff()` directly (manager edits repo files via Claude Code, not workspace)
- `overrides.skipQa = true` — governance IS the review
- `governanceApproved = true` passed to guardrails — bypasses tier restrictions but NEVER immutable kernel
- On success: triggers auto-restart via `process.exit(0)`

## Key Files
- `packages/node/src/pipeline-runner.ts` — orchestrator
- `packages/node/src/code-pipeline.ts` — diff extraction + patch application
- `packages/node/src/api-server.ts` — `POST /pipeline/run` handler

## Gotchas
- Manager edits repo files directly (not workspace copies). Pipeline's git diff mode is the correct way to find changes.
- Zero changes = `success: false` — does NOT trigger restart.
- `extractGitDiff()` uses ES module import for `execSync` (not `require`).

## Original Design (for reference)

7-stage sequential pipeline: version-check → extract-diff → backup → guardrail-precheck → apply-patch → build → QA → commit → deploy → health-check. With cascading rollback on failure. Single-threaded, one run at a time.

## Key Files

- `packages/node/src/pipeline-runner.ts` — main orchestrator (DEPRECATED)
- `packages/node/src/code-pipeline.ts` — diff extraction (still useful as utility)
- `packages/node/src/qa-runner.ts` — QA testing (still useful, Manager creates QA tasks)
- `packages/node/src/deploy-manager.ts` — backup/restore (still useful for rollback)
