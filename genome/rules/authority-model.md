---
id: authority-model
severity: critical
applies_to: [manager, scheduler, orchestrator]
created: 2026-02-17
---

# Authority Model

## The Rule

Only Managers create and approve tasks. Workers execute. Scheduler allocates resources.

## Who Can Do What

| Actor | Can Create Tasks | Can Approve Tasks | Can Spawn Workers | Can Commit Code | Can Make Decisions |
|---|---|---|---|---|---|
| Manager | YES | YES | NO (delegates to Scheduler) | YES | YES |
| Scheduler | NO | NO | YES (approved tasks only) | NO | NO |
| Worker | NO | NO | NO | NO | NO (executes assigned task) |
| Health Monitor | NO | NO | NO | NO | NO (data source only) |
| Strategy Loop | NO | NO | NO | NO | NO (suggestions only) |

## Why This Exists

Before this rule, the scheduler auto-approved tasks, auto-spawned QA, called the Planner, and made autonomous decisions. This caused rogue agents, duplicate work, and cascading failures. The authority model fixed all of this by centralizing decisions in the Manager.

## Enforcement

- Scheduler constructor does not accept Planner parameter
- Worker CLAUDE.md restricts tool access (--disallowedTools)
- API endpoints require managerId for task creation
- Guardrails block workers from calling POST /tasks
