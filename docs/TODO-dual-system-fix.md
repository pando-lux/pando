# TODO: Kill the Dual System — Clean Architecture

> Brainstorm doc. Delete when done.

## DONE so far:
- [x] EnginePool built in pando-code (`pool/engine-pool.ts` ~230 lines)
- [x] Scheduler built in pando-code (`pool/scheduler.ts` ~200 lines)
- [x] PandoServer built in pando-code (`server/server.ts` ~200 lines)
- [x] All three exported from @pando-code/core index.ts
- [x] Build passes clean
- [x] BIBLE.md updated with target architecture
- [ ] Create engine-adapter.ts in pando-node (uses EnginePool)
- [ ] Rewire chat API to use adapter
- [ ] Remove brain from index.ts
- [ ] Delete brain files (~6,834 lines)
- [ ] Fix imports + build
- [ ] Add governance AI review hook
- [ ] Update tests

---

## The Problem

pando-node built its own brain (orchestrator, message bus, agent database, worker pool, org manager, template registry) AND uses pando-code as a dumb text-in/text-out AI backend. Two brains, two memories, two agent systems. ~6,500 lines of duplicate code.

pando-code already has: Board (task tracking), Sub-agents (4 types), MemoryStore (lessons + reflections), FrameBuilder (prompt assembly), 23+ built-in tools, guardrails, event bus.

pando-node duplicated all of it instead of using it.

---

## The Goal

```
pando-node = pure body (P2P, identity, economy, governance, storage, API)
pando-code = the brain (all intelligence, task management, memory, agents)
engine adapter = thin glue (~200 lines) that connects them
```

pando-code doesn't know it's inside pando-node. It just has tools.
pando-node doesn't know how AI works. It just routes messages to engines.

---

## The New Architecture

```
                      Gateway (browser)
                          |
                      HTTP API (/v1/*)
                          |
    ┌─────────────────────┼─────────────────────────┐
    |              PANDO NODE (body)                 |
    |                                                |
    |  Kernel          Core           Platform       |
    |  - P2P           - Storage      - Content      |
    |  - Governance    - Credentials  - Threads      |
    |  - Sync          - Upgrade      - Resources    |
    |  - Security      - Payment      - Capabilities |
    |  - Reputation    - Deploy                      |
    |  - Emission      - Hosting                     |
    |                                                |
    |  ┌────────────────────────────────────────┐    |
    |  |        Engine Adapter (~200 lines)     |    |
    |  |  The ONLY file that knows pando-code   |    |
    |  |                                        |    |
    |  |  - Map<projectId, engine>              |    |
    |  |  - Creates engines on demand           |    |
    |  |  - Registers Pando tools per engine    |    |
    |  |  - Routes messages to right engine     |    |
    |  |  - Injects Lux budget                  |    |
    |  |  - Pushes events (governance, P2P)     |    |
    |  |  - Evicts idle engines (TTL)           |    |
    |  └──────────────┬─────────────────────────┘    |
    └─────────────────┼──────────────────────────────┘
                      |
        engine.send() | engine.registerTool()
                      |
    ┌─────────────────┼──────────────────────────────┐
    |          PANDO CODE (brain - standalone)        |
    |                                                 |
    |  System Engine         Project Engine(s)        |
    |  (manages node)        (user projects)          |
    |  ┌──────────┐          ┌──────────┐             |
    |  | Board    |          | Board    |             |
    |  | Memory   |          | Memory   |             |
    |  | Frames   |          | Frames   |             |
    |  | Tools:   |          | Tools:   |             |
    |  |  23 base |          |  23 base |             |
    |  |  +pando  |          |  +pando  |             |
    |  └────┬─────┘          └────┬─────┘             |
    |       |                     |                   |
    |  Sub-agents:           Sub-agents:              |
    |  - Observer (explore)  - Builder (full tools)   |
    |  - QA (tester)         - Tester (read+bash)     |
    |  - Builder (full)      - Explorer (read-only)   |
    └─────────────────────────────────────────────────┘
```

---

## Multi-Project: Who Manages What

This is the key architectural decision. pando-code is standalone — it manages ANY project. Within pando-node:

### Engine Instances

| Engine | What it manages | Created when | Destroyed when |
|---|---|---|---|
| **System engine** | pando-node itself. Self-improvement, governance review, node health. | Node boot (if pando-code available) | Node shutdown |
| **Project engine** | A user's project (bakery website, marketplace app, etc.) | User creates/opens project via chat | Idle timeout (30 min) |

The adapter manages a `Map<projectId, engine>`. Each engine is independent — own Board, own MemoryStore, own sub-agents. They interact with each other ONLY through Pando tools (which call node HTTP API).

### Message Routing

```
POST /v1/chat/message { message, projectId? }
  |
  ├── projectId provided? → adapter.getEngine(projectId).send(message)
  |
  └── no projectId? → adapter.systemEngine.send(message)
      → system engine decides:
         - General question? Answer directly.
         - "Build me X"? Create project, create engine, delegate.
         - Node issue? Handle via pando tools.
```

### Example: User Creates a Website

```
1. User on gateway: "Build me a bakery website"
2. POST /v1/chat/message { message: "Build me a bakery website" }
3. Adapter routes to system engine (no projectId)
4. System engine:
   a. Uses pando_create_project tool → creates project in node
   b. Returns: "Created project bakery-website (id: abc123)"
5. Adapter creates project engine for abc123
6. System engine tells user: "Project created! Working on it..."
7. Next message with projectId=abc123 → routes to project engine
8. Project engine:
   a. Plans on its Board
   b. Spawns builder sub-agent → writes code
   c. Spawns tester sub-agent → tests
   d. Uses pando_deploy tool → deploys
   e. Responds: "Your bakery website is live at https://..."
```

### Example: Another Standalone Project

pando-code can also be used outside pando-node (standalone CLI). In that case:
- No Pando tools registered
- No Lux budget (uses USD)
- No P2P, no governance, no network
- Just a coding engine managing a local project

When used inside pando-node, the ONLY difference is: Pando tools are registered. The engine doesn't know or care about the distinction.

---

## Governance + AI: How Smart Review Works

Governance (kernel/governance.ts) stays deterministic. 6 layers of checks. But when it needs intelligence:

```
1. Proposal arrives (diff + description)
2. Layers 1-3 run (signature, file check, pattern scan) — deterministic, fast
3. Layer 4: BUILD CHECK — deterministic (npm run build)
4. Layer 5: AI REVIEW (NEW) — calls engine adapter
   a. Adapter routes to system engine
   b. System engine gets: "Review this diff for security issues: <diff>"
   c. Engine analyzes: architecture violations, injection risks, data leaks
   d. Returns: { safe: boolean, risks: string[], recommendation: string }
   e. Governance uses this as input (not final word — governance decides)
5. Layer 6: Kernel protection delay (60s for kernel/ changes)
6. Final decision logged to governance_audit table
```

The AI review is NOT a persistent agent. It's an on-demand engine.send() call. No tick loop, no child process. Just: "here's a diff, tell me if it's safe."

If system engine is busy? Queue the review. It's async.

---

## What We DELETE from pando-node

| File | Lines | Why it goes |
|---|---|---|
| `platform/orchestrator.ts` | ~2,200 | pando-code IS the orchestrator |
| `platform/orchestrator-manager.ts` | ~300 | No child process forking needed |
| `platform/orchestrator-process.ts` | ~400 | Same |
| `platform/org-manager.ts` | ~500 | pando-code has sub-agent hierarchy |
| `platform/agent-database.ts` | ~1,265 | pando-code has MemoryStore + Board |
| `platform/template-registry.ts` | ~200 | pando-code has FrameBuilder |
| `core/message-bus.ts` | ~400 | pando-code has Board for coordination |
| `core/worker-pool.ts` | ~500 | pando-code spawns its own sub-agents |
| `core/ai-backend-pandocode.ts` | ~245 | No wrapper — engine used directly |
| `core/ai-backend-registry.ts` | ~100 | No registry — adapter manages engines |
| `core/ai-backend.ts` | ~50 | No interface needed |
| `core/engine-bridge.ts` | ~300 | Replaced by engine-adapter.ts |
| `platform/agent-tools.ts` | ~374 | Agent routes replaced by simpler engine routes |
| **TOTAL** | **~6,834** | |

## What We KEEP in pando-node (unchanged)

### Kernel (Layer 0) — ALL stays
- `kernel/network.ts` — P2P (libp2p)
- `kernel/governance.ts` — 6-layer security pipeline (+ new AI review hook)
- `kernel/sync.ts` — ledger sync
- `kernel/monitor.ts` — health polling
- `kernel/guardrails.ts` — rate limiting
- `kernel/security-monitor.ts` — threat detection
- `kernel/reputation.ts` — peer scoring
- `kernel/emission-witness.ts` — Lux minting
- `kernel/crash-guard.ts` — crash loop detection

### Core (Layer 1) — infrastructure stays
- `core/storage-backend.ts` — MongoDB / P2P proxy
- `core/credential-store.ts` — AES-256-GCM
- `core/upgrade-protocol.ts` — git pull + build + restart
- `core/gateway-deploy-pool.ts` — multi-account deploy
- `core/hosting-adapters.ts` — Vercel/Netlify adapters
- `core/payment-gate.ts` — Lux escrow
- `core/request-reply.ts` — P2P unicast

### Platform (Layer 2) — non-brain stuff stays
- `platform/capability-detector.ts` — auto-detect capabilities
- `platform/resource-marketplace.ts` — resource discovery
- `platform/content-registry.ts` — content management
- `platform/thread-store.ts` — chat persistence (MongoDB)

### API — stays but simplifies
- `api/api-server.ts` — Fastify setup
- `api/kernel-api.ts` — status, peers, capabilities, governance
- `api/core-api.ts` — tasks, upgrade, credentials
- `api/platform-api.ts` — projects, auth, chat (simplified), engines (new)
- `api/testing-api.ts` — testing dashboard

### Entry points — stay but simplify
- `index.ts` — PandoNode class (remove orchestrator/agent setup, ~1500 lines lighter)
- `cli.ts` — CLI entry
- `tui.ts` — interactive terminal

---

## What We CREATE (new)

### `core/engine-adapter.ts` (~200 lines)

The ONE file that imports @pando-code/core. Responsibilities:

```typescript
class EngineAdapter {
  private systemEngine: PandoCode | null;
  private projectEngines: Map<string, PandoCode>;
  private engineLastUsed: Map<string, number>;

  // Lifecycle
  async start(config): Promise<void>       // Boot system engine + register tools
  async stop(): Promise<void>              // Shutdown all engines

  // Routing
  async send(message, projectId?): AsyncGenerator<Event>  // Route to right engine
  async getOrCreateProjectEngine(projectId): PandoCode    // Lazy project engines

  // Governance hook
  async reviewDiff(diff, description): Promise<ReviewResult>  // AI security review

  // Management
  getActiveEngines(): EngineInfo[]         // For API: list running engines
  evictIdle(): void                        // TTL cleanup (30 min)
}
```

### Pando Tools (registered on each engine)

These tools are the nervous system — they let the brain interact with the body.

| Tool | What it does | Calls |
|---|---|---|
| `pando_status` | Node health, peers, uptime | GET /v1/status |
| `pando_peers` | List connected P2P peers | GET /v1/peers |
| `pando_capabilities` | Network capabilities | GET /v1/network/capabilities |
| `pando_balance` | Check Lux balance | GET /v1/ledger/balance |
| `pando_transfer` | Send Lux to peer | POST /v1/ledger/transfer |
| `pando_deploy` | Deploy a project | POST /v1/projects/:id/deploy |
| `pando_undeploy` | Remove deployment | POST /v1/projects/:id/undeploy |
| `pando_governance_propose` | Create upgrade proposal | POST /v1/governance/propose |
| `pando_governance_vote` | Vote on proposal | POST /v1/governance/vote |
| `pando_create_project` | Create a new project | POST /v1/projects |
| `pando_list_projects` | List all projects | GET /v1/projects |
| `pando_broadcast` | Send P2P GossipSub message | POST /v1/broadcast |
| `pando_test_run` | Trigger test run | POST /v1/testing/run |
| `pando_test_status` | Get test results | GET /v1/testing/status |

Tools call the node's own HTTP API. This keeps them stateless and reuses all existing API validation/auth.

---

## API Route Changes

### NEW routes (engine management):
- `GET /v1/engines` — list active engine instances (system + projects)
- `GET /v1/engines/:projectId/board` — read an engine's Board snapshot
- `GET /v1/engines/:projectId/memory` — read an engine's lessons/memories

### SIMPLIFIED routes:
- `POST /v1/chat/message` — adapter.send(message, projectId) → engine.send() → SSE
- `GET /v1/chat/history` — read from engine's session history

### REMOVED routes (agent-tools.ts is deleted):
- `POST /v1/agents/spawn` — pando-code spawns its own sub-agents
- `POST /v1/agents/:id/message` — no more message bus
- `POST /v1/agents/:id/report` — sub-agents report internally
- `POST /v1/agents/:id/kill` — pando-code manages its own agents
- `POST /v1/agents/:id/directive` — Board replaces directives
- `POST /v1/orchestrators/create` — no more orchestrators
- `POST /v1/orchestrators/:id/dissolve` — same

### KEPT routes (unchanged):
- All kernel routes (status, peers, capabilities, governance)
- All core routes (tasks, upgrade, credentials)
- All auth routes (challenge, verify, me, refresh)
- All project routes (create, deploy, undeploy, list)
- All testing routes (specs, runs, findings, dashboard)
- All content routes
- Context routes (may simplify — engines query their own memory)

---

## What pando-code Might Need (upgrades to the separate repo)

These are potential changes to @pando-code/core to support the new architecture cleanly. We should evaluate each one — some might not be needed.

### Likely needed:
1. **Governance review mode** — A way to ask an engine to analyze a diff and return a structured verdict (not just chat text). Could be a tool, a special prompt template, or a new engine method like `engine.reviewDiff(diff)`.

2. **Engine event injection** — Currently engine.send() takes a user message string. For system events (governance proposal arrived, peer connected, scheduled check), we might want `engine.pushEvent({ type, data })` that gets formatted automatically. OR we just format it as a message string — simpler but less structured.

3. **Scheduled sub-agent tasks** — The observer needs to audit every 30 min. The QA agent needs to test every 30 min. Options:
   - (a) pando-node sends periodic "check" messages to the engine (simpler, keeps scheduling in the body)
   - (b) pando-code has a built-in scheduler (more self-contained)
   - Recommendation: (a) — keep the body as the scheduler, brain just responds

### Maybe needed:
4. **Multi-engine shared discoveries** — If the system engine discovers something about the network, should project engines know? Currently engines are fully isolated. Could add a shared discovery table, or engines can query via pando tools.

5. **Engine-to-engine messaging** — If the system engine wants to tell a project engine something, it goes through Pando tools (POST /v1/chat/message with projectId). Not through internal memory.

### Probably NOT needed:
6. **Process isolation for engines** — pando-code's engine.send() is async and non-blocking. The old orchestrator needed child processes because the tick loop could block the event loop. Engines don't have this problem. If memory is a concern, we can revisit.

7. **Custom FrameBuilder layers for Pando** — pando-code's 8-layer frame system already handles identity, project context, tools, conversation. Pando-specific context comes through tools (pando_status, etc.) and the system prompt, not through custom frame layers.

---

## Execution Order

### Phase 1: Create engine-adapter.ts (non-breaking)
Write the new adapter. Test it alongside the existing system. Both systems run.
- Create `core/engine-adapter.ts`
- Register Pando tools (port from engine-bridge.ts)
- Add `POST /v1/chat/v2/message` as a temporary new endpoint that uses the adapter
- Verify: send a message via v2, get a response from pando-code directly

### Phase 2: Rewire chat API (breaking for chat only)
- Make `POST /v1/chat/message` use the adapter instead of orchestrator
- Make `GET /v1/chat/history` read from engine sessions
- Add engine management routes (`GET /v1/engines`, etc.)
- SSE streaming works through the adapter

### Phase 3: Remove brain from index.ts (breaking)
- Stop creating: OrgManager, MessageBus, AgentDatabase, WorkerPool, TemplateRegistry
- Stop forking child processes (OrchestratorProcessManager)
- Stop creating orchestrators (council, observer, qa-user, project orchestrators)
- Use adapter.start() instead
- Add periodic "check" messages for observer/QA behavior

### Phase 4: Delete brain files
- Delete all files from "What We DELETE" list
- Delete agent-tools.ts and its route registration
- Fix every broken import
- `npm run build` — zero errors

### Phase 5: Update docs
- Rewrite BIBLE.md Section 4-8 to reflect new architecture
- Remove dual system problem section (it's fixed)
- Update CLAUDE.md agent architecture section

### Phase 6: Add governance AI review
- Add hook in kernel/governance.ts to call adapter.reviewDiff()
- System engine analyzes diffs when proposals arrive
- Wire into layer 5 of governance pipeline

### Phase 7: Test everything
- Node boots cleanly
- Chat works end-to-end via gateway
- Multi-project: create project, build, deploy
- Governance: propose upgrade, AI reviews diff
- P2P: nodes without pando-code forward to nodes with it
- Build passes, all routes respond

---

## Decisions to Make Together

1. **Scheduling**: Should pando-node send periodic "check for work" messages to the system engine? (Recommended: YES, simple setInterval in pando-node, engine responds if there's work, no-ops if not)

2. **Engine storage path**: Each engine stores its SQLite at the project path. System engine stores at node data dir (`~/.pando/`). OK?

3. **Session persistence**: When node restarts, do engines resume previous sessions or start fresh? (Recommendation: start fresh — lessons persist in MemoryStore, Board persists in SQLite, so context survives restart. But the conversation resets.)

4. **Agent identity**: Should each engine instance have its own @pando/identity keypair? (Recommendation: system engine uses node's key. Project engines get ephemeral keys.)

5. **Idle engine TTL**: 30 min for project engines? System engine never evicts? (Seems right.)

6. **pando-code changes**: Do we need any changes to @pando-code/core, or can we do everything with engine.send() + registerTool()? (Let's find out in Phase 1.)

7. **Gateway impact**: Does the gateway need changes? (Minimal — chat endpoint stays the same, just the backend changes. Agent tree page would need updating.)
