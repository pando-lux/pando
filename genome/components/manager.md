---
id: manager
type: service
domain: core
entry: packages/node/src/agent.ts (manager role)
depends_on: [agent, agent-manager, bridge-queue, task-queue]
depended_by: [agent-manager]
exposes:
  - "(All Agent methods — Manager is an Agent instance with role='manager')"
  - processEvent(prompt) — handle one bridge item (user request, task result, worker message, health alert)
  - spawn_agent() — create child agents (builders, testers, reviewers) via Agent tools
  - message_child() — instruct a child agent
  - broadcast() — announce to all children
  - send_to_user() — relay message to user's chat thread
  - ask_user() — escalate question to user
  - user_question() — fast path for urgent user input from any depth
rules: [authority-model, workflow-pipeline]
last_verified: 2026-02-20
---

# Manager (Agent with 'manager' role)

## What It Does

A Manager is an Agent with the `manager` role and `genome/templates/manager.md` as its template. It coordinates a team of child agents to deliver a project. It talks to users directly -- there is no CommunicationAgent, SmartRouter, or ChatSessionManager. The Manager IS the user's AI partner.

**Phase 27 change:** Manager is no longer a separate ManagerAgent class. It is an instance of the universal Agent class with `role: 'manager'`. Same code, same lifecycle, same tools as every other agent. The template guides its behavior.

## How It Works

### User Conversation

```
Gateway chat → API Server → Bridge Queue → Manager Agent (Claude Code)
```

Three hops. No classification. No routing logic. No middleman. The Manager handles every user message -- questions, requests, interrupts, status checks. Its Claude Code brain naturally understands intent without coded patterns.

### Event Processing (one bridge item at a time)

The Bridge Watcher in AgentManager dispatches one item at a time to the Manager:

**For `user_request`:**
1. Assess what the user wants
2. If trivial (balance check, status) -- handle directly using tools
3. If project work -- design workflow, spawn builders/testers, track progress
4. Report back to user

**For `task_completed` (child agent finished):**
1. Review output
2. Apply changes to repo (if code task)
3. Build verification
4. Commit code
5. Update genome docs (verify child's genome updates)
6. Report completion to user

**For `worker_message` (child needs help):**
1. If question -- answer or relay to user
2. If stuck -- investigate, fix, or reassign
3. If progress update -- acknowledge

**For `health_alert`:**
1. Assess severity
2. Take action (restart, investigate, or note for later)

### Team Scaling

Manager decides team size based on workload (guided by template):
- 1 feature, simple -- do it yourself or spawn 1 builder
- 2-5 features -- spawn specialized builders + 1 tester
- 5-20 features -- spawn builders + testers + reviewer
- 20+ features -- spawn module managers who manage their own teams

### Direct User-to-Agent Connection

Manager can delegate conversation to a specific child agent:
```
User: "I want to talk to the auth builder directly"
Manager: connect_user_to_agent(userId, "builder-auth")
  → User's messages go directly to builder-auth's bridge queue
  → Manager stays informed via audit trail
  → Connection is temporary
```

### user_question Escalation

Deep child agents can send `user_question` messages that bubble up through the tree to reach the user. Each parent can answer or forward. This gives any agent at any depth access to the human when genuinely needed.

## What Was Removed (Phase 27)

| Removed | Replaced By |
|---|---|
| ManagerAgent class (manager-agent.ts) | Agent class with role='manager' |
| ManagerContextAssembler (manager-context.ts) | Agent.buildClaudeMd() with 4-layer template |
| ManagerOrchestrator (domain-managers.ts) | AgentManager with bridge watcher |
| CommunicationAgent | Manager handles user conversation directly |
| SmartRouter | No classification needed -- everything goes to Manager |
| ChatSessionManager | Agent session management (per-agent sessionId + --continue) |
| Dynamic workflows (declareWorkflow, updateWorkflowStep) | Manager's todo list is the workflow (implicit, not declared) |
| Progress callback + emoji relay | Manager uses send_to_user() tool directly |
| Lease-based failover | Agent lifecycle (ACTIVE/IDLE/ARCHIVED/DEAD) |

## Key Files

- `packages/node/src/agent.ts` -- Agent class (Manager is an instance)
- `packages/node/src/agent-manager.ts` -- AgentManager (creates pando-node-mgr, runs bridge watcher)
- `genome/templates/manager.md` -- Manager role template (principles, workflow, team scaling)
- `~/.pando/agents/<managerId>/state.json` -- persisted state
- `~/.pando/agents/<managerId>/workspace/CLAUDE.md` -- 4-layer template
- `~/.pando/agents/<managerId>/workspace/project-state.md` -- living project doc
