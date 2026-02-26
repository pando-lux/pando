---
id: deploy-manager
type: service
domain: pipeline
entry: packages/node/src/core/deploy-manager.ts
depends_on: []
depended_by: [pipeline-runner, scheduler, upgrade-protocol, pando-node]
exposes:
  - commitChanges(patchSet) — stage and commit files from a PatchSet, return CommitResult
  - runBuild() — execute `npm run build` with 3-minute timeout, return BuildResult
  - rollbackCommit() — revert the last pipeline commit via git revert or reset
  - createBackup(description?) — snapshot packages/ directory into timestamped backup
  - restoreBackup(backupId) — restore repo from active backup
  - getDeployStatus() — last commit hash, build status, backup state, pending rollback flag
rules: []
last_verified: 2026-02-18
---

# Deploy Manager

## What It Does
Manages the deployment lifecycle for changes produced by the autonomous code pipeline. Handles git staging/committing, build verification (`npm run build`), commit rollback on failure, and backup/restore of the working tree.

## How It Works
- `commitChanges()` stages each file individually (`git add` or `git rm --cached` for deletes), builds a commit message from PatchSet metadata (prefixed `[pipeline]`), and creates the commit. Does NOT push.
- `runBuild()` executes `npm run build` synchronously with a 3-minute timeout. On failure, sets `pendingRollback = true` to signal the caller.
- `rollbackCommit()` checks if HEAD matches the tracked `lastCommitHash`. If yes, uses `git reset --soft HEAD~1` + checkout. If HEAD has moved, uses `git revert --no-edit` to safely revert.
- `createBackup()` copies the `packages/` directory into a timestamped folder under `.deploy-backups/`. Only one active backup at a time -- creating a new backup removes the previous one.
- `restoreBackup()` copies the backup's `packages/` directory back to the repo, overwriting current source.
- All git operations run synchronously via `execSync` with the repo directory as cwd.

## Gotchas
- Only one backup is maintained at a time. Creating a new backup deletes the previous one.
- `rollbackCommit()` only reverts the single commit tracked by `lastCommitHash`. It will not roll back unrelated commits.
- Build timeout is 3 minutes (180,000ms). Large monorepo builds may exceed this on slow machines.
- The backup only copies `packages/` -- root-level files, tests, scripts, and docs are not backed up.
- All git commands use `execSync`, blocking the Node.js event loop during execution.

## Key Files
- `packages/node/src/deploy-manager.ts` -- all deploy lifecycle logic
- `packages/shared/src/types.ts` -- PatchSet type
