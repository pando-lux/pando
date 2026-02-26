---
id: code-pipeline
type: service
domain: pipeline
entry: packages/node/src/platform/code-pipeline.ts
depends_on: [guardrails]
depended_by: [pipeline-runner, scheduler, pando-node]
exposes:
  - extractDiff(workspaceOutputDir) — scan workspace output for source file changes vs repo
  - extractGitDiff() — fallback diff extraction from uncommitted git changes
  - applyPatch(patchSet) — validate through guardrails, write changes, return MergeResult with rollback info
  - rollback(rollbackInfo) — restore original files and delete newly created ones
rules: []
last_verified: 2026-02-18
---

# Code Pipeline

## What It Does
Extracts diffs from workspace output directories, applies patches to the repository with guardrail enforcement, and supports full rollback on failure. This is the core diff/patch engine used by PipelineRunner.

## How It Works
- `extractDiff()` recursively scans a workspace `output/` directory for source files (`.ts`, `.tsx`, `.js`, `.json`, `.css`, `.md`, etc.), computes content diffs against the repo, and returns a `PatchSet` with all detected changes.
- Skips non-source files and directories (`node_modules`, `dist`, `.git`, `.cache`, etc.) via `SKIP_PATTERNS`.
- If workspace scan finds no changes, falls back to `extractGitDiff()` which runs `git diff --name-only` (unstaged + staged) and reads content vs HEAD.
- `applyPatch()` validates every file path through Guardrails (`isImmutableKernel` + `tieredPreCheck`), saves originals for rollback, then writes new content. On any partial failure, automatically rolls back all changes.
- `rollback()` restores files that existed to their original content, and deletes files that were newly created.

## Gotchas
- BUG-16 fix: scans the entire `output/` directory, not just `output/packages/`, because agents produce results in various subdirectories.
- `extractGitDiff()` uses synchronous `execSync` for git commands, which blocks the event loop during extraction.
- The `computeSimpleDiff()` method produces a basic line-level diff (not a unified diff format), suitable for logging but not for applying as a patch externally.
- If guardrails block any file in a PatchSet, the entire PatchSet is rejected (no partial application).

## Key Files
- `packages/node/src/code-pipeline.ts` -- diff extraction, patch application, rollback
- `packages/node/src/guardrails.ts` -- immutable kernel and tiered pre-check validation
- `packages/shared/src/types.ts` -- PatchSet, FileChange, MergeResult, RollbackInfo types
