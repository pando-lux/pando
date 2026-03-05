---
id: worker-isolation
severity: critical
applies_to: [scheduler, agent-manager]
created: 2026-02-17
---

# Worker Isolation

## The Rule

Workers execute their assigned task and exit. They cannot escape their workspace, create tasks, spawn agents, or access anything outside their scope.

## What Workers CANNOT Do

- Create tasks (POST /tasks blocked)
- Approve tasks (POST /tasks/:id/approve blocked)
- Access other workspaces
- Read files outside their workspace (unless specified in context)
- Spawn other agents
- Modify the node's configuration
- Access the node's API for write operations

## What Workers CAN Do

- Read/write files in their workspace
- Run build commands (npm run build, tsc, etc.)
- Run tests
- Read specified source files (injected via CLAUDE.md context)
- Write output to workspace/output/RESULT.md

## Enforcement

- Agent template (genome/templates/builder.md) restricts worker behavior via principles
- Agent class creates isolated workspace per agent (~/.pando/agents/{id}/workspace/)
- API Bearer token not provided to workers
