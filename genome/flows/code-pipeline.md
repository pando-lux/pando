---
id: code-pipeline
components: [manager, scheduler, agent, bridge-queue, guardrails]
rules: [immutable-kernel, qa-standard, workflow-pipeline]
trigger: task_completed (via bridge queue)
status: REWRITTEN — Manager workflow replaces standalone pipeline
---

# Code Commit Flow

How code changes move from worker output to committed, tested, documented code. This is now part of the **Manager's workflow** — not a separate pipeline system.

## How It Works

```
1. Worker completes task in sandbox (~/.pando/workspaces/{taskId}/)
   Worker writes structured report to output/RESULT.md
   Scheduler enqueues task_completed to Bridge Queue

2. Manager picks up task_completed from bridge
   Manager follows remaining todo list steps:

3. REVIEW
   Manager reads worker output (RESULT.md, changed files)
   Assesses quality: correct? complete? safe?
   If bad → create fix task or retry with feedback

4. APPLY
   Manager copies changed files from workspace to main repo
   (For trusted tasks, worker may have committed directly)

5. BUILD
   Manager runs: npm run build
   If build fails → investigate, fix, or create fix task

6. GUARDRAILS
   Guardrails enforce safety:
   - No immutable kernel files modified
   - No protected paths touched
   - No dangerous patterns
   (Guardrails are always active — not optional)

7. COMMIT
   Manager runs: git add <changed files> && git commit -m "descriptive message"
   Commit message includes task ID and summary

8. DOCS (genome update)
   Manager reads genome/genome.yaml to find affected component docs
   Updates affected genome/components/*.md, genome/state.md, etc.
   Commits genome changes

9. REPORT
   Manager reports: commit hash, files changed, genome updated
   If deploy needed: Manager requests graceful restart
```

## Rollback

If build or guardrails fail after changes are applied:
1. Manager uses `git checkout -- <files>` to revert changes
2. OR uses DeployManager.restoreFromBackup() for dist/ recovery
3. Creates fix task with the error details

## What Changed

| Before (standalone pipeline) | After (Manager workflow) |
|---|---|
| PipelineRunner orchestrated 7 stages | Manager follows todo list with same steps |
| Pipeline triggered separately by Scheduler | Manager handles commit as part of task workflow |
| Pipeline and Manager could fight over commits (TD-25) | Manager is the ONLY committer — no conflict |
| Pipeline was a black box to Manager | Manager has full visibility and control |
| No genome update step | DOCS step is mandatory for code tasks |

## Key Files

| File | Role |
|---|---|
| `packages/node/src/agent-manager.ts` | Manages agent lifecycle, processes bridge items |
| `packages/node/src/agent.ts` | Agent maintains CLAUDE.md, manages todo/workflow |
| `packages/node/src/guardrails.ts` | Safety enforcement on all changes |
| `packages/node/src/deploy-manager.ts` | Backup/restore utility (rollback) |
| `genome/genome.yaml` | Manager reads this to find which docs to update |
