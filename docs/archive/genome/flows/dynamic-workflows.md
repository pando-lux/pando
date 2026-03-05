---
id: dynamic-workflows
components: [manager, bridge-queue, orchestrator]
rules: [workflow-pipeline]
trigger: bridge_item
status: IMPLEMENTED + TESTED (2026-02-18), updated for Bridge Queue (2026-02-19)
---

# Dynamic Workflow System

## Why

Every task type needs its own workflow. The manager is a Claude Code session — a general-purpose brain. It designs the workflow per task, not follows a hardcoded checklist.

- Code: plan → code → test → review → commit → **docs**
- Research: scope → search → analyze → report → deliver
- Writing: research → outline → draft → edit → deliver
- Infrastructure: assess → plan → execute → verify → **docs**

Code and infrastructure workflows MUST include a **docs** step (genome update).

## How It Works

### 1. Bridge Item Arrives

Manager pulls ONE item from the Bridge Queue. Assesses it. Designs a workflow:

```
POST /managers/:id/workflow
{
  "taskId": "abc123",
  "type": "code-feature",
  "steps": [
    {"id": "plan", "name": "Plan approach"},
    {"id": "spawn", "name": "Create and assign task"},
    {"id": "review", "name": "Review worker output"},
    {"id": "commit", "name": "Build, test, commit code"},
    {"id": "docs", "name": "Update genome documentation"},
    {"id": "report", "name": "Report completion"}
  ]
}
```

### 2. Manager Works Through Todo List

Each step becomes a todo item. Manager checks its todo list at the start of each event. This survives context compaction across `--continue` events.

```
POST /managers/:id/step
{
  "taskId": "abc123",
  "stepId": "commit",
  "status": "completed",
  "detail": "Committed as abc1234. Build passes."
}
```

### 3. Gateway Shows Progress

```
Task: "Build me a landing page"
Workflow: plan → spawn → review → commit → docs → report
         done   done    done     active   pending  pending
```

## Architecture: Todo List = Workflow

The todo list is the SINGLE source of truth. The API is for external visibility.

```
Manager receives bridge item
  → Designs workflow (3-7 steps)
  → Declares via API: POST /managers/:id/workflow
  → Creates todo items for each step
  → Works through todos, calling POST /managers/:id/step for each
  → If context compacts: checks todo list to know where it left off
  → Last step completed → Manager exits → Bridge watcher checks for next item
```

## Bridge Queue Integration

In the old model, Manager woke up every 5 minutes and processed batched events. Now:
- Manager pulls ONE item from bridge → designs workflow → executes → exits
- Bridge watcher spawns Manager again if more items exist
- No timer, no polling, no wasted cycles

## The DOCS Step

For code and infrastructure tasks, the workflow MUST include a docs step:
1. Read `genome/genome.yaml` to find which components map to changed files
2. Read and update affected `genome/components/*.md`, `genome/state.md`, etc.
3. Commit genome changes together with code

The Manager is a Claude Code session — it reads and edits genome files directly. No separate agent needed. This is event-driven (runs when code changes), not periodic.

## Storage

Workflows stored in manager's `state.json` under `workflows` field, keyed by taskId.
Pruned after 24 hours by `periodicHousekeeping()` (runs during relevant item processing, not on a timer).

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /managers/:id/workflow | Yes | Declare a new workflow for a task |
| POST | /managers/:id/step | Yes | Report step progress |
| GET | /managers/:id/workflows | No | List all workflows |

## Future: Workflow Templates

Successful workflows become templates in the genome. New tasks start from proven templates.

## Files

- `agent.ts` — Agent todo list (workflow), 4-layer CLAUDE.md template
- `agent-manager.ts` — Agent lifecycle, bridge queue management, workflow routing
- `api-server.ts` — Agent API endpoints
- `bridge-queue.ts` — Bridge Queue feeds items to Manager
