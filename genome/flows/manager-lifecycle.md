---
id: manager-lifecycle
components: [manager, agent, agent-manager, bridge-queue]
rules: [workflow-pipeline, budget-enforcement]
trigger: node_boot
---

# Manager Lifecycle Flow

How a manager session starts, runs, and recovers from crashes. Driven by the Bridge Queue — no timers, no polling.

## Steps

```
1. NODE BOOT
   PandoNode.start() → AgentManager.start()
   → AgentManager creates pando-node-mgr Agent (role=manager)
   → AgentManager starts Bridge Watcher (event-driven, no timer)

2. CONTEXT ASSEMBLY
   Agent.buildClaudeMd() generates CLAUDE.md (4-layer template):
     - Layer 1: Role principles (genome/templates/manager.md)
     - Layer 2: Project context (project-state.md, relevant genome components)
     - Layer 3: Learned lessons (auto-updated from experience)
     - Layer 4: Current task
   Writes CLAUDE.md to ~/.pando/agents/{id}/workspace/
   Creates project-state.md if not exists
   → Workspace ready

3. SESSION INIT
   Agent ready to receive events. No process spawned yet.
   → Session ready to receive bridge items

4. BRIDGE ITEM ARRIVES
   Any source enqueues item to bridge:
   - User via API → user_request
   - Scheduler → task_completed / task_failed
   - Worker → worker_message (mid-task)
   - HealthMonitor → health_alert
   - Governance → governance_decision

5. BRIDGE WATCHER SPAWNS MANAGER
   If Manager is idle:
     item = bridge.next(managerId)
     spawn: claude -p "<prompt>" --output-format stream-json --verbose
            --dangerously-skip-permissions --model claude-sonnet-4-6
     If sessionId exists: --continue --resume <sessionId>
   If Manager is busy:
     Item waits in queue. FIFO within priority tier.

6. MANAGER PROCESSES ONE ITEM
   Manager receives single-item event prompt.
   Follows todo list workflow (dynamic per item type).
   For code tasks: includes commit + genome DOCS step.
   Process runs, responds, exits.
   Session ID captured from first spawn.
   → Full context preserved via session ID

7. MANAGER EXITS → WATCHER CHECKS
   Bridge watcher detects Manager process exit.
   Sets manager status to idle.
   If bridge queue has more items → spawn again with next item.
   If bridge queue empty → do nothing. Zero cost.

8. CRASH RECOVERY
   If Claude CLI not found → status = 'failed', items stay in queue.
   If spawn times out (5 min) → process killed, item re-queued (max 3 retries).
   If spawn exits non-zero → warning logged, in-flight item re-queued.
   Session ID cleared on hard failure → new conversation starts.
   → Degraded but items preserved

9. NODE SHUTDOWN
   AgentManager.stopAll() → SIGTERM all child processes, wait 10s, SIGKILL remaining.
   AgentManager.stop() → stops bridge watcher, persists agent state.
   Bridge queue persisted to disk (items survive restart).
   → Clean exit, queue preserved
```

## State Persistence

Agent state saved to `~/.pando/agents/{id}/state.json` after every event:
- Running tasks, recent outcomes, known patterns, failed approaches
- Budget tracking (spent, limit, period)
- Daily reviews (last 7 days)
- Lifecycle state (planning/building/testing/deployed/maintaining/archived)

Bridge queue saved per-manager:
- Pending items (re-processed on restart)
- In-flight item (re-queued if Manager crashed before completing)
