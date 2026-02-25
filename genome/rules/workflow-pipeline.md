---
id: workflow-pipeline
severity: high
applies_to: [manager]
created: 2026-02-18
updated: 2026-02-19
---

# Manager Workflow Pipeline

## The Rule

Every manager designs a **dynamic workflow per task**. There is no hardcoded pipeline. The manager declares a workflow (3-7 steps) appropriate to the task type, tracks progress via a todo list that survives context compaction, and reports each step via the workflow API.

**Every code task MUST include a DOCS step.** After committing code, the Manager checks genome drift and updates affected genome files. This is not optional.

## How It Works

1. **Manager receives a task** (via event)
2. **Manager designs a workflow** based on the task type:
   - Code: plan, code, test, review, commit, **docs**, deploy
   - Research: scope, search, analyze, report, deliver
   - Writing: research, outline, draft, edit, deliver
   - Infrastructure: assess, plan, execute, verify, **docs**
3. **Manager declares the workflow** via `POST /managers/:id/workflow`
4. **Manager creates todo items** for each step (todo list IS the workflow)
5. **Manager works through steps**, calling `POST /managers/:id/step` for each
6. **If context compacts**: manager checks todo list to know where it left off

## The DOCS Step (Mandatory for Code Tasks)

After committing code changes, the Manager:
1. Reads `genome/genome.yaml` to identify which components map to the changed files
2. Reads and updates affected `genome/components/*.md` files
3. Updates `genome/state.md` if active work or known issues changed
4. Updates `genome/flows/*.md` if system flows changed
5. Commits genome updates in the same session

The Manager is a Claude Code session — reading genome.yaml and editing markdown is what it does naturally. No separate agent or tooling needed.

**Why this matters:** Without the DOCS step, genome drift accumulates. The genome becomes stale.

**What the Manager's CLAUDE.md should say:**
```
## Doc Updates (Part of Every Code Task)
After every code change, update the genome (NOT admin_docs/).
Key files: genome/state.md, genome/components/*.md, genome/flows/*.md, genome/rules/*.md
Read genome/genome.yaml to find which component docs map to the files you changed.
```

## Todo List = Workflow

The Claude Code todo list is the single source of truth for workflow state. It survives context compaction, which means the manager never loses track of where it is — even across multiple `--continue --resume` events.

The API (`POST /managers/:id/workflow` and `POST /managers/:id/step`) provides external visibility for the gateway and monitoring, but the todo list is what the manager actually follows.

## Why Dynamic (Not Hardcoded)

The previous hardcoded 7-step pipeline (PLAN/SPAWN/REVIEW/QA/COMMIT/DOCS/REPORT) was code-biased. Not every task involves code, QA, or commits. The manager is a Claude Code session — a general-purpose brain. It should design the workflow to fit the task, not follow a rigid checklist.

## Constraints

- Workflows must have 3-7 steps (too few = not tracking, too many = overhead)
- Every workflow must end with a report/deliver step
- Every code workflow must include a DOCS step (genome update)
- Manager must check its todo list at the start of each event
- Manager must call the workflow API for external visibility

## Shared State

Manager maintains `project-state.md` in its workspace as the single source of truth. Updated after every significant action.
