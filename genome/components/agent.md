---
id: agent
type: service
domain: core
entry: packages/node/src/core/agent.ts
depends_on: [bridge-queue]
depended_by: [agent-manager]
exposes:
  - constructor(config) — create agent with id, role, template, parent, project, workspace
  - processEvent(prompt) — spawn Claude Code session with prompt, persist state after
  - persistState() — save state.json to ~/.pando/agents/<id>/
  - loadState() — restore from state.json
  - buildClaudeMd() — assemble 4-layer CLAUDE.md (role + project + lessons + task) + standing directive injection + auto-create project-state.md + inject parent context for children
  - getState() — return full AgentState snapshot
  - getStatus() — ACTIVE | IDLE | ARCHIVED | DEAD
  - getCost() — total estimated cost for this agent
  - isBudgetExceeded() — true if budgetSpent >= budgetLimit
  - getBudgetInfo() — { spent, limit, remaining }
  - setBudgetLimit(limit) — update budget ceiling
  - onProgress — optional callback, receives real-time tool use from stream-json stdout
  - addChild(agentId) — register a child agent
  - removeChild(agentId) — unregister a child agent
  - resetSession() — clear sessionId so next processEvent() starts a fresh Claude Code session
  - setStandingDirective(directive) — set persistent directive that survives context compression (Phase 29)
  - clearStandingDirective() — remove active directive
  - getStandingDirective() — return current directive or undefined
  - updateDirectiveProgress(progress) — update progress field on active directive
rules: [authority-model, budget-enforcement]
last_verified: 2026-02-22
---

# Agent (Universal Agent Primitive)

## What It Does

The single class behind every agent in the system. Manager, builder, tester, reviewer, researcher, devops -- all are instances of Agent with different roles and templates. One class, one set of tools, one lifecycle. The role template guides behavior; the code is identical.

## Roles

| Role | Template | Typical Use |
|---|---|---|
| manager | genome/templates/manager.md | Coordinates team, talks to users, makes decisions |
| builder | genome/templates/builder.md | Writes code, tests, reports to parent |
| tester | genome/templates/tester.md | Playwright QA, headed mode, screenshot evidence |
| reviewer | genome/templates/reviewer.md | Code review, security, quality |
| researcher | genome/templates/researcher.md | Investigation, analysis, reporting |
| devops | genome/templates/devops.md | Deployment, monitoring, infrastructure |

## CLAUDE.md Assembly (5 Layers)

Every agent's workspace gets a CLAUDE.md assembled from five layers:

0. **Protocol memo (Phase 53)** -- from `genome/protocol.md`. Versioned network-wide rules (architecture, app patterns, resource usage, communication, safety). Injected first so all agents get consistent architecture knowledge. Version stored in `AgentState.protocolVersion`.
1. **Role principles** -- from `genome/templates/<role>.md`. Identity, principles (NEVER VIOLATE), workflow. Template placeholders (`${API_PORT}`, `${AGENT_ID}`, `${PARENT_ID}`) are substituted with real values during `loadTemplate()`.
2. **Project context** -- project-state.md, relevant genome components for the project.
3. **Learned lessons** -- auto-updated from experience. Grows over time via Manager REFLECT step.
4. **Current task** -- the specific assignment or event being processed.

## Project State — External Brain (Phase 28)

`buildClaudeMd()` auto-creates `project-state.md` in the agent's workspace on first run. Template includes: Architecture Decisions, Current Status, Known Issues, Worker Registry, Budget, Manager Workflow Template.

Every agent's CLAUDE.md includes a "Project State Protocol" with mandatory instructions:
1. At START: Read project-state.md
2. During work: Update on decisions, issues, worker spawns
3. At END: Write session summary to "Current Status"

**Parent context injection (Layer 2b):** Child agents get their parent's project-state.md injected into CLAUDE.md (truncated at 2000 chars). This gives workers project-wide context without duplicating the full state.

## Budget Tracking (Phase 28)

AgentState includes `budgetSpent` and `budgetLimit` (default 50 Lux). `budgetSpent` accumulates `costUsd` after every `sendEvent()`. AgentManager checks `isBudgetExceeded()` after each event and pauses work + notifies user via SSE when the budget is exceeded.

## Communication Endpoints (Phase 27-I)

Every agent's CLAUDE.md includes the full HTTP API for team communication:

- **POST /agents/spawn** — spawn a child agent (role, parentId, projectId, description, taskContext)
- **POST /agents/:id/message** — send instructions to a child or report to parent
- **GET /agents/tree** — view the full agent hierarchy
- **GET /agents/:id/status** — check a specific agent's status
- **API token** — read from `~/.pando/api-token` and injected into CLAUDE.md so agents can authenticate POST calls

`buildClaudeMd()` is called at the start of every `sendEvent()` to ensure agents always have fresh endpoints, project context, and API token.

## Session Management

- First spawn: `claude -p` creates a new session. Session ID captured and saved to state.json.
- Subsequent events: `claude -p --continue --resume <sessionId>` preserves full conversation context.
- Session reset: `resetSession()` clears the sessionId so the next `processEvent()` creates a fresh session. Exposed via `POST /agents/:id/reset-session`. Useful when context has grown too large or when the agent needs a clean start.
- Session rotation: when context gets large, agent summarizes to KNOWLEDGE-TRANSFER.md, fresh session created with knowledge as Layer 2.
- All sessions use `--model claude-sonnet-4-6` (via `DEFAULT_CLAUDE_MODEL`).
- `stdin: 'ignore'`, `--dangerously-skip-permissions`, `CLAUDECODE` env var deleted from spawn.

### Context Compression and Long-Running Sessions

**Problem:** After 100+ tasks on `--continue --resume`, Claude Code compresses old context to fit new messages. This means CLAUDE.md instructions injected early in the session's life are compressed out -- the agent effectively "forgets" behavioral rules that were only present in CLAUDE.md.

**Symptoms observed:** Manager agent ignored deployment instructions despite 18 mentions across CLAUDE.md and manager.md template. The instructions were present in the file but had been compressed out of the active context window.

**Solution:** Critical instructions that must always be followed are injected directly into the event prompt by `buildPromptFromBridgeItem()` in AgentManager. The event prompt is always in the most recent context and is never compressed. CLAUDE.md remains the primary source of instructions, but any rule that must survive indefinitely long sessions should also appear in the event prompt.

**Guidance for template authors:** If an instruction is critical for agent behavior and the agent will run for many tasks, add it to both the template (CLAUDE.md) and to the event prompt injection in `buildPromptFromBridgeItem()`. CLAUDE.md alone is not reliable for sessions exceeding ~50-100 events.

## Real-Time Progress (Phase 27-H)

The Agent exposes an `onProgress?: (text: string) => void` callback. When set by AgentManager, it receives real-time activity parsed from Claude Code's `--output-format stream-json` stdout.

### Line-Buffered Stream-JSON Parsing

Claude Code stdout chunks don't align to line boundaries. The agent uses a `lineBuffer` that accumulates text, splits on `\n`, and keeps the last incomplete fragment for the next chunk:

```
stdout.on('data', (chunk) => {
  lineBuffer += chunk.toString();
  const lines = lineBuffer.split('\n');
  lineBuffer = lines.pop() || '';   // keep incomplete last line
  for (const line of lines) {
    const event = JSON.parse(line.trim());
    // ... extract progress info
  }
});
```

### Event Types Extracted

| stream-json type | What's extracted | Example progress text |
|---|---|---|
| `assistant` → `tool_use` block | Tool name + key input field | `Tool: Bash: npm test`, `Tool: Read: /path/to/file.ts` |
| `assistant` → `text` block | First line of agent's text response | `Here's what I found in the codebase:` |
| `result` | Completion signal | `Completed` |

Tool detail extraction maps: `Read/Write/Edit` → file_path, `Bash` → command, `Glob/Grep` → pattern, `WebFetch` → url.

No truncation is applied — full tool commands and file paths are shown to the user.

## Hard Limits (enforced in code, not just templates)

| Limit | Default | Enforced At |
|---|---|---|
| Spawn idle timeout | 30 minutes | No stdout/stderr for 30 min → kill process. Resets on every output chunk. |
| Spawn hard cap | 2 hours | Absolute maximum per spawn, regardless of activity. |
| Manager idle timeout | 30 minutes | No progress callback for 30 min → reject event. Resets on onProgress. |
| Manager hard cap | 2 hours | Absolute maximum for manager event processing. |
| Stale processing detection | 2.5 hours | Detect crashed/stuck manager, reset bridge state. |
| Max tree depth | 5 | spawn_agent() rejects if agent.depth >= max_depth |
| Max children per agent | 10 | spawn_agent() rejects if parent.children.length >= 10 |
| Max retry per event | 3 | Bridge queue escalates to parent after 3 failures |
| Budget | Per-project | spawn_agent() rejects if project budget exhausted |

## State Persistence

After every event, state.json is written to `~/.pando/agents/<id>/state.json`:

```json
{
  "id": "builder-auth-a1b2c3",
  "role": "builder",
  "parent": "manager-social-xyz",
  "children": [],
  "project": "social-network-001",
  "sessionId": "claude-uuid-...",
  "status": "active",
  "lastActive": "2026-02-20T...",
  "eventCount": 5,
  "estimatedCost": 2.30,
  "memory": { "patterns": [], "failedApproaches": [] }
}
```

## Lifecycle

```
ACTIVE    → currently processing events or waiting for work
IDLE      → project complete, no tasks pending (TTL countdown starts)
ARCHIVED  → TTL expired, results saved to StorageBackend, workspace deleted
```

Transitions: AgentManager manages lifecycle transitions via cleanup sweep (hourly).

**Phase 42 note:** Agent workspaces (`~/.pando/agents/<id>/`) are EPHEMERAL. During execution, agents use local disk for speed. After completion, meaningful results (project-state.md, reports, code changes) are persisted to StorageBackend (MongoDB). The local workspace is then deleted. Nodes should not accumulate old agent workspaces.

## Key Files

- `packages/node/src/agent.ts` -- Agent class
- `genome/templates/*.md` -- role templates (manager, builder, tester, reviewer, researcher, devops)
- `~/.pando/agents/<id>/state.json` -- persisted state
- `~/.pando/agents/<id>/workspace/CLAUDE.md` -- assembled 4-layer template
- `~/.pando/agents/<id>/workspace/project-state.md` -- living project doc (managers)
