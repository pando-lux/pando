---
id: agent-hierarchy
type: flow
domain: agents
entry: packages/node/src/core/agent-manager.ts
depends_on: [agent, agent-manager, council, governance, bridge-queue, upgrade-protocol]
last_verified: 2026-02-26
---

# Agent Hierarchy & Execution Pipelines

## Overview

Pando has two distinct pipelines for AI-driven work, unified by the same Agent primitive:

1. **Node Infrastructure Pipeline** — council detects issues → builder fixes → QA validates → governance approves → upgrade deploys
2. **App Development Pipeline** — user requests app → doorman routes → app manager coordinates → builders implement → deploy

Both use the same `Agent` class, `BridgeQueue` for communication, and `AgentManager` for lifecycle management.

## Intent Routing (Phase 102c)

```
User sends message via Gateway / TUI / API
  │
  ▼
POST /v1/chat/message
  │
  ├─ Has projectId? → Route directly to project manager
  │
  └─ No projectId → Doorman classification
     │
     ├─ 'simple' → Instant answer (status, balance, peers, help)
     ├─ 'question' → OpenAI answers directly
     ├─ 'council' → Council handles (node infrastructure work)
     └─ 'build' → Create project + spawn app manager
```

**Council intent detection:** Messages with infrastructure keywords (node, API, gateway, governance, P2P, ledger, etc.) AND action verbs (fix, improve, update, etc.) route to the council.

## Pipeline 1: Node Infrastructure (Council)

```
Council Reflection (hourly in dev)
  │
  ├─ Reads: network-state, minutes, health alerts, directives
  ├─ AI generates: summary, proposals, fix actions
  │
  ├─ Proposals → governance.createProposal('council_action')
  │               └─ Dev mode: auto-approved (quorum=1, auto-vote)
  │
  └─ Fix Actions → spawnFixAgent(description, files)
                    │
                    ├─ Spawn builder with workDir = repo root
                    ├─ parentId = councilAgentId
                    ├─ Builder works on REAL codebase
                    ├─ Builder commits + pushes to branch
                    └─ Builder calls POST /agents/:id/report
                       │
                       ▼
                    Council bridge watcher receives task_completed
                       │
                       ▼
                    Adversarial QA (zero-context flow testing)
                       │
                       ├─ PASS → Create governance proposal
                       │         └─ Auto-approved → UpgradeProtocol.pullAndUpgrade()
                       │                            └─ Build + restart
                       │
                       └─ FAIL → Block proposal, log in minutes
```

## Pipeline 2: App Development (Manager)

```
User: "build me a todo app"
  │
  ▼
Doorman classifies as 'build'
  │
  ▼
Create project in ProjectStore
  │
  ▼
Spawn Manager agent (project-<id>)
  │
  ├─ Manager reads project-state.md
  ├─ Manager plans 3-7 steps
  ├─ Manager spawns builders/testers/reviewers as needed
  │
  ▼
Builders work in project workspace
  │
  ▼
Manager reviews, iterates, deploys
  │
  ▼
POST /v1/projects/:id/deploy
```

## Agent Tiers (From Brainstorm)

| Tier | Name | Purpose | Lifespan | Cost | Backend |
|---|---|---|---|---|---|
| 3 | Builder | Write code, test, deploy | Task duration | 5-50 Lux/task | Claude Code CLI |
| 2 | Runner (Session) | Serve users with memory | App lifetime | 0.5-5 Lux/session | LLM API (future) |
| 1 | Runner (Stateless) | Single-call compute | Per-call | 0.01-0.1 Lux/call | LLM API (future) |

Currently only Tier 3 (Builder) agents are implemented. Tier 1/2 Runner agents are planned for Phase 103+.

## Council as Virtual Agent (Phase 102b)

The council registers a lightweight agent in AgentManager so builders can report completion to it via the standard bridge queue mechanism:

1. On `agentManager.start()`, council calls `registerCouncilAgent()`
2. A researcher-role agent is created (never starts Claude Code session)
3. Council listens on the bridge queue for `task_completed` / `task_failed` events
4. Builder agents spawned by council have `parentId: councilAgentId`
5. When builder reports done → council processes the completion (QA → governance)

## Governance Integration

- **council_action** proposals: auto-approved in dev mode (governance auto-votes approve within 100ms)
- **council_action approved** → triggers `onCouncilActionApproved` callback → UpgradeProtocol pulls + builds + restarts
- **Founder veto**: can reject any proposal via API, TUI, or gateway

## Key Files

| Component | File |
|---|---|
| Agent primitive | `packages/node/src/core/agent.ts` |
| Agent lifecycle | `packages/node/src/core/agent-manager.ts` |
| Bridge queue | `packages/node/src/core/bridge-queue.ts` |
| Council | `packages/node/src/platform/council.ts` |
| Governance | `packages/node/src/kernel/governance.ts` |
| Upgrade protocol | `packages/node/src/core/upgrade-protocol.ts` |
| Doorman | `packages/node/src/api/api-server.ts` |
| Chat routing | `packages/node/src/api/platform-api.ts` |
| Agent API | `packages/node/src/platform/agent-tools.ts` |
| SmartRouter | `packages/node/src/smart-router.ts` |
