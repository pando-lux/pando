---
id: chat-to-project
components: [message-bus, orchestrator, org-manager, payment-gate, governance]
rules: [project-types, authority-model, budget-enforcement]
trigger: user_task_intent
---

# Chat to Project Flow

How a user's natural language request becomes a managed project with a persistent AI partner.

## The User Experience

The user just talks. The system figures out whether they want discussion or work done.

```
User: "build me a chess game"
  → Intent detected: TASK (not conversation)
  → Project created: chess-game-1739900000
  → Claude Code session starts with enriched context
  → Claude Code asks: "Where should it be hosted? What features? Public or personal?"

User: "public, gateway, with P2P multiplayer"
  → Same session (--continue)
  → Claude Code proposes to governance (it's a public project)
  → Governance votes...
  → Approved → Claude Code creates tasks → Manager orchestrates

User (weeks later): "add a leaderboard"
  → Same session, full history
  → Claude Code remembers everything, creates new task
```

## Intent Detection

Before dispatch, the Manager determines whether the user wants work done (TASK) or information (CONVERSATION).

```
detectTaskIntent(message, history)
  │
  ├─ TASK patterns (imperative + object):
  │   "build me...", "create a...", "implement...", "deploy..."
  │   "fix the...", "add a feature...", "make a...", "set up..."
  │   "write a...", "update the..."
  │
  ├─ Confirmation (context-aware):
  │   "ok do it", "yes build it", "go ahead", "start building"
  │   → only if recent history discussed a plan/feature
  │
  ├─ CONVERSATION patterns (safe default):
  │   "how does...", "what is...", "explain...", "why..."
  │   "analyze...", "review...", "how would you..."
  │
  └─ Default: CONVERSATION (never accidentally creates projects)
```

## Full Flow

```
1. USER MESSAGE arrives at POST /chat/message

2. INTENT DETECTION
   detectTaskIntent(message, conversationHistory)
   → 'task' or 'conversation'

   If 'conversation': proceed to existing 3-tier system (unchanged)
   If 'task': continue to step 3

3. PROJECT SESSION CREATION
   Generate projectId from message (slugify + timestamp)
   Manager creates project via POST /projects, spawns project-specific manager agent
   Agent gets its own workspace: ~/.pando/agents/{agentId}/workspace/
   CLAUDE.md built via 4-layer template (role principles + project context + lessons + task)

   Thread metadata stores projectId for routing continuity
   → Manager now has full project context

4. MANAGER AS PROJECT PARTNER
   The Manager agent IS the project's AI partner. It:
   - Asks clarifying questions (scope, hosting, features)
   - Checks user's balance via GET /status
   - Determines project type (personal/public/admin)
   - For public projects: POST /governance/propose → wait for approval
   - For personal projects: checks balance, warns if insufficient
   - For admin projects: proceeds directly (own resources)

5. TASK CREATION (by Claude Code)
   When ready to build:
   POST /tasks { title, description, priority, createdBy: 'project-chat' }
   → Manager automatically notified via task_created event
   → Manager designs workflow, approves, dispatches to Scheduler
   → Workers build in isolated workspaces

6. ONGOING CONVERSATION
   User's subsequent messages route to same project manager via thread's projectId:
   POST /chat/threads/:id/message { message }
   → Thread lookup finds projectId → routes to project-<projectId> manager
   → --continue --resume maintains full context
   → Manager tracks progress, handles follow-ups

7. PROJECT COMPLETION
   Tasks complete → pipeline commits → deploy
   Claude Code reports back to user in the same conversation
   Project workspace and session persist for future enhancements
```

## Payment Integration Points

```
PERSONAL PROJECT:
  Intent detected → Claude Code checks balance → estimates cost
  → Sufficient: "This will cost ~20 Lux. I'll hold that from your balance."
     PaymentGate.holdPayment(peerId, projectId, amount)
  → Insufficient: "This costs ~20 Lux. You have 5 Lux. Earn more by..."
     No task created. User can continue discussion.

PUBLIC PROJECT:
  Intent detected → Claude Code proposes to governance
  → Approved: budget allocated from NETWORK account
  → Rejected: Claude Code informs user, suggests alternatives

ADMIN PROJECT:
  Intent detected → no payment check (own resources)
  → Tasks created directly
```

## Conversation Continuity

All messages stored in ThreadStore (persistent, MongoDB or local filesystem).

When project session is created:
- Thread metadata stores projectId and type='project'
- Manager agent gets project context via 4-layer template

When project session continues:
- --continue --resume preserves Claude Code's in-session memory
- Thread routing uses projectId to find the correct project manager

## Graceful Degradation

- **Scheduler not running** (`--scheduler` flag not set): AgentManager not started, chat returns error
- **Claude Code not available**: Node forwards to Claude-capable peer via P2P (Phase 45)
- **No Claude-capable peers**: Returns "No AI-capable nodes available on the network"
- **Node offline**: Chat returns error, suggests checking node status
