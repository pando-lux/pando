---
id: pure-executor
severity: critical
applies_to: [scheduler]
created: 2026-02-18
---

# Pure Executor Scheduler

## The Rule

The Scheduler makes ZERO decisions about WHAT gets done. It only handles HOW: dequeue, claim, workspace, spawn, collect, report.

## What the Scheduler Does

1. Receive approved task (with profile already attached)
2. Claim the task
3. Create isolated workspace
4. Spawn agent at the right execution tier
5. Collect the result
6. Cascade parent/child completion
7. Report result back to manager

## What the Scheduler Does NOT Do

- Call the Planner (removed from constructor)
- Auto-approve sibling tasks
- Auto-spawn QA agents
- Auto-commit code
- Auto-retry failed tasks
- Decide task priority
- Choose which tasks to run

## Enforcement

- Planner parameter removed from Scheduler constructor (d97da45)
- No autoApproveSiblings() method exists
- No spawnQaAgent() method exists
- No auto-commit pipeline fallback
- managerMode toggle deleted — always pure executor
