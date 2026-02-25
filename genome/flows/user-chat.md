---
id: user-chat
components: [bridge-queue, agent-manager, manager, payment-gate, governance]
rules: [authority-model, project-types, budget-enforcement]
trigger: user_message
---

# User Chat Flow

How users interact with the node via natural language. The Doorman (OpenAI gpt-4o-mini) classifies intent and routes messages. Simple queries get instant answers (~$0.001). Build requests create projects and spawn per-project managers (Claude Code). Returning users with a projectId skip the doorman entirely.

## Routing (Phase 68.3 — Doorman)

**Gateway → Node:** Gateway chat routes use `getNodeUrl('claude')` to preferentially route to nodes with Claude Code. NodePool filters by `hasClaudeCode === true` (set during health checks from `/status` capabilities). Falls back to any healthy node if no Claude node is available.

**Doorman classification:** `doormanClassify(message)` in api-server.ts handles first contact:
- Deterministic keyword matching first (balance, status, peers, help, etc.)
- If no keyword match → OpenAI gpt-4o-mini classifies intent (~$0.001, <2s)
- Returns intent: `simple` | `question` | `build` | `project`

**Returning users:** If the request includes a `projectId`, the message routes directly to the project's manager (`project-<projectId>`). No doorman involved.

## Classification & Routing

```
Message arrives at POST /chat/message or POST /chat/threads/:id/message
  ↓
HAS projectId? ─── YES ──→ Route to project-<projectId> manager (skip doorman)
  │
  NO
  ↓
doormanClassify(message)
  ├─ SIMPLE (keyword match — free, instant)
  │   "balance" → reads ledger, returns number
  │   "status" → reads node status, returns summary
  │   "peers" → lists connected peers
  │   "tasks" → lists task queue
  │   "proposals" → lists governance proposals
  │   "help" → returns help text
  │   Doorman answers directly — no AI cost
  │
  ├─ QUESTION (AI classification — ~$0.001)
  │   General questions → doorman answers via OpenAI
  │   No project created, no Claude Code
  │
  ├─ BUILD ("build me X", "create X", "I want X")
  │   → Create project + preflight (API key, MongoDB assigned)
  │   → Spawn per-project manager (Claude Code)
  │   → Enqueue to bridge → return instant response
  │   → Manager works asynchronously
  │
  └─ PROJECT (existing project context detected)
      → Route to appropriate project manager
```

## Conversation Steps

```
1. USER MESSAGE
   Gateway POST /chat/message or /chat/threads/:id/message
   → API server receives, validates auth

2. DOORMAN CLASSIFICATION
   doormanClassify(message) — keyword match or OpenAI gpt-4o-mini
   Simple/question → doorman answers directly, returns response
   Build → continue to step 3

3. PROJECT CREATION
   Create project via POST /projects
   Run preflight (auto-generates API key, assigns MongoDB)
   Spawn per-project manager: project-<projectId>

4. BRIDGE QUEUE DISPATCH
   Message enqueued as user_request to project manager's bridge queue
   AgentManager bridge watcher picks it up
   PaymentGate checks escrow (if enabled)

5. MANAGER PROCESSING
   Agent.sendEvent(prompt) → claude -p --continue --resume
   Manager reads message, decides action:
   - Conversation → responds directly
   - Task request → designs workflow, spawns workers
   - Status query → reads node APIs, responds
   Real-time progress via onProgress → SSE chat_progress

6. RESPONSE RELAY
   relayOutputToUser(output, threadId)
   → SSE chat_message event → browser
   → ThreadStore saves message
```

## Thread Follow-Up Routing (Phase 46)

When a user sends a follow-up message to an existing thread (`POST /chat/threads/:id/message`), the node looks up the thread's `projectId` from ThreadMeta. If the thread has a `projectId`, the message routes directly to the project-specific manager (`project-<projectId>`) — no doorman. Otherwise the doorman classifies the message.

Thread creation stores `projectId` on the thread when provided, setting the thread type to `'project'` instead of `'conversation'`. This works via both endpoints: `POST /chat/message` (direct API) and `POST /chat/threads` (gateway chat flow).

## Project Chat

When task intent is detected, a project session is created with a persistent AI partner:
- Claude Code asks questions, checks balance, proposes to governance
- All via API calls from within the Claude Code session
- Conversation continues via `--continue --resume` indefinitely
- Memory graduation at 40+ messages (summarize + fresh session with memory)
- See `flows/chat-to-project.md` for the complete project lifecycle flow

## History & Continuity

- All messages stored in ThreadStore (persistent, MongoDB-backed)
- Manager sessions use `--continue --resume <sessionId>` for full conversation continuity
- Activity logs saved alongside messages for audit trail
- Thread metadata (projectId, type) persisted for routing continuity
