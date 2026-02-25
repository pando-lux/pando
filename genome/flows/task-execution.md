---
id: task-execution
components: [manager, scheduler, agent, agent-manager, bridge-queue]
rules: [authority-model, worker-isolation, workflow-pipeline, qa-standard]
trigger: user_request | governance_decision | manager_initiative
---

# Task Execution Flow

The primary flow: how work gets done on the Pando network.

## Steps

```
1. TRIGGER
   Something needs to be done — user request, governance decision, or manager initiative.
   Source enqueues item to Bridge Queue.
   → Item waits for Manager

2. MANAGER PICKS UP ITEM
   Bridge Watcher spawns Manager with the single item.
   Manager assesses: what kind of work is this?
   Designs dynamic workflow (3-7 steps) based on task type.
   Declares workflow: POST /managers/:id/workflow
   Creates todo items (todo list IS the workflow).
   → Workflow declared, visible via API

3. CREATE + APPROVE (Manager → API)
   POST /tasks {title, description, priority, createdBy: managerId}
   POST /tasks/:id/approve
   Manager exits. Task enters approved queue.
   → Task ready for Scheduler

4. CLAIM + WORKSPACE (AgentManager)
   Scheduler polls approved queue, routes to AgentManager.
   AgentManager spawns worker Agent with its own workspace.
   Worker CLAUDE.md (4-layer template) includes:
     - Layer 1: Role principles (genome/templates/builder.md)
     - Layer 2: Project context (project-state.md, scoped genome components)
     - Layer 3: Learned lessons
     - Layer 4: Task description and requirements
   → Workspace ready at ~/.pando/agents/{agentId}/workspace/

5. SPAWN WORKER (AgentManager)
   Spawns `claude -p` with --model claude-sonnet-4-6 and workspace CLAUDE.md.
   Worker follows its own todo list:
     a. Understand the task
     b. Do the work
     c. Post progress messages to bridge (optional but encouraged)
     d. Write structured report to output/RESULT.md
     e. Exit
   → Worker process running

6. MID-TASK COMMUNICATION (via Bridge)
   Worker can post messages during execution:
     POST /tasks/:id/messages { type: "progress", content: "Step 2 of 4 done" }
     POST /tasks/:id/messages { type: "help_request", content: "Need X" }
     POST /tasks/:id/messages { type: "clarification", content: "Is it web or mobile?" }
   Messages route to bridge queue of task's Manager.
   Manager picks them up and responds (provide files, relay to user, etc.)
   → Two-way communication during task execution

7. COLLECT RESULT (Scheduler)
   Worker exits. Scheduler reads exit code + workspace output.
   Scheduler enqueues task_completed or task_failed to Bridge Queue.
   → Event in bridge, waiting for Manager

8. MANAGER REVIEWS + COMMITS
   Bridge Watcher spawns Manager with task_completed item.
   Manager follows remaining todo list steps:
     a. REVIEW: Read worker output, assess quality
     b. APPLY: Copy changed files from workspace to repo (if sandbox task)
     c. BUILD: Run npm run build, verify compilation
     d. COMMIT: git add + git commit with descriptive message
     e. DOCS: Check genome drift, update affected genome files, commit
     f. REPORT: Summary of what was done, commit hash, any issues
   Manager exits. If bridge has more items, watcher spawns again.
   → Code committed, genome updated, task complete
```

## Error Handling

- **Worker fails**: Manager gets `task_failed` in bridge. Retries with adjusted instructions. Self-heals.
- **Worker stuck**: 30-min timeout → bridge creates timeout alert → Manager investigates.
- **Worker needs help**: Worker posts to bridge → Manager provides files/info/clarification.
- **Build fails**: Manager investigates error, creates fix task.
- **Budget exhausted**: Manager defers non-critical work.
- **Manager crashes**: In-flight bridge item re-queued. Next spawn picks it up.

## Worker Communication Examples

```
Worker → Bridge: "I need the database schema to understand the data model"
Manager: copies schema file to workspace, or posts response to workspace/manager-response.md

Worker → Bridge: "The user's request is ambiguous — web app or CLI tool?"
Manager: relays to Communication Agent → user sees question in chat → user responds → answer queues back through bridge → Manager provides answer to next worker spawn or workspace file

Worker → Bridge: "Step 3 complete. Starting tests."
Manager: noted, no action. Progress visible via bridge status API.

Worker → Bridge: (silence for 30 minutes)
Bridge: creates timeout alert → Manager checks PID, checks workspace for partial output
```

## Cost

Typical task: ~$0.50-5 (Manager item processing + worker session + optional follow-up items).
All sessions use `--model claude-sonnet-4-6` (configurable via `DEFAULT_CLAUDE_MODEL`).
Bridge-driven model: zero cost when idle (no heartbeat waste).
