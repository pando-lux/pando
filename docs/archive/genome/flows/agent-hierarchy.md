---
id: agent-hierarchy
type: flow
domain: agents
entry: packages/node/src/platform/orchestrator.ts
depends_on: [orchestrator, org-manager, worker-pool, message-bus, agent-database, governance, upgrade-protocol]
last_verified: 2026-02-27
---

# Agent Hierarchy & Execution Pipelines

## Overview

Pando's agent system uses the "thin agent, thick orchestrator" pattern:

- **Orchestrators** — deterministic tick loops that manage workers. All state in SQLite.
- **Workers** — stateless Claude Code processes that do one task and die.

Two pipelines, same architecture:

1. **Node Infrastructure Pipeline** — council orchestrator detects issues → spawns builder → QA validates → governance approves → upgrade deploys
2. **App Development Pipeline** — user requests app → project orchestrator coordinates → builders implement → deploy

## Architecture

```
                    ┌──────────────────────┐
                    │   Council            │ Level 0 (persistent)
                    │   Orchestrator       │ tick: 60s
                    │   (Deterministic)    │
                    └──────┬──────┬────────┘
                           │      │
                  ┌────────┘      └────────┐
                  │                        │
         ┌────────▼────────┐     ┌─────────▼────────┐
         │ Project Orch    │     │  Builder Worker   │ Level 1+
         │ (user_project)  │     │  (stateless)      │
         │ tick: 30s       │     └──────────────────┘
         └────────┬────────┘
                  │
         ┌────────▼────────┐
         │ Builder/QA/etc  │
         │ Workers         │
         └─────────────────┘
```

## Intent Routing

```
User sends message via Gateway / TUI / API
  │
  ▼
POST /v1/chat/message
  │
  ├─ Has projectId? → MessageBus.send() to project orchestrator
  │
  └─ No projectId → Doorman classification
     │
     ├─ 'simple' → Instant answer (status, balance, peers, help)
     ├─ 'question' → AI answers directly
     ├─ 'council' → MessageBus.send() to council orchestrator
     └─ 'build' → Create project + OrgManager.createProjectOrchestrator()
```

## Pipeline 1: Node Infrastructure (Council Orchestrator)

```
Council orchestrator tick()
  │
  ├─ classify() — Tier 1 or Tier 2?
  │
  ├─ Tier 1 (deterministic): route task_results, ack health alerts
  │
  └─ Tier 2 (AI): callAI() with inbox messages as context
     │
     ├─ AI returns OrchestratorAction[]
     │   ├─ spawn_worker (builder for fix)
     │   ├─ propose_upgrade (governance proposal)
     │   ├─ commit_code (via DeployManager)
     │   └─ respond_to_user (chat response)
     │
     └─ execute(actions)
        │
        ├─ WorkerPool.spawn(builder) → builder works → reports via HTTP
        ├─ Worker completion arrives as message_inbox entry
        ├─ Next tick: spawn QA worker (independent, zero context about change)
        ├─ QA passes → onPropose(title, desc) → governance.createProposal()
        │              └─ Dev mode: auto-approved
        └─ QA fails → retry with failure details (max 3 attempts)
```

## Pipeline 2: App Development (Project Orchestrator)

```
User: "build me a todo app"
  │
  ▼
OrgManager.createProjectOrchestrator(projectId)
  │ (persistent: false — dissolves when project completes)
  │ (tick: 30s — faster than council)
  │
  ▼
Project orchestrator tick()
  │
  ├─ Reads user_request from inbox
  ├─ AI plans 3-7 steps
  ├─ Spawns builders/testers via WorkerPool
  │
  ▼
Workers work in project workspace
  │
  ▼
Orchestrator reviews, iterates
  │
  ▼
deploy action → POST /v1/projects/:id/deploy
```

## Tick Classification (Tier 1 vs Tier 2)

| Tier | Criteria | AI Call? | Examples |
|---|---|---|---|
| 1 | Deterministic, pattern-matched | No | Route task_result, ack health_alert, check worker timeout |
| 2 | Needs judgment | Yes | New user_request, complex escalation, reflection |

~80% of ticks are Tier 1 (zero tokens). Only ~20% need AI.

## Governance Integration

- Orchestrator's `onPropose` callback → `governance.createProposal(title, description)`
- Dev mode: council_action proposals auto-approve (quorum=1, auto-vote)
- Governance decisions arrive as `governance_decision` messages in orchestrator inbox
- Founder veto: POST /v1/council/veto/:id

## Key Files

| Component | File |
|---|---|
| Orchestrator (tick loop) | `packages/node/src/platform/orchestrator.ts` |
| OrgManager (hierarchy) | `packages/node/src/platform/org-manager.ts` |
| AgentDatabase (SQLite) | `packages/node/src/platform/agent-database.ts` |
| WorkerPool (spawn/resume) | `packages/node/src/core/worker-pool.ts` |
| MessageBus (routing) | `packages/node/src/core/message-bus.ts` |
| Worker HTTP tools | `packages/node/src/core/worker-mcp.ts` |
| Agent API routes | `packages/node/src/platform/agent-tools.ts` |
| Governance | `packages/node/src/kernel/governance.ts` |
| Upgrade protocol | `packages/node/src/core/upgrade-protocol.ts` |
| Chat routing | `packages/node/src/api/platform-api.ts` |
