# @pando/code — Bible & Architecture
## Multi-agent AI coding engine
## 2026-03-06

---

# CURRENT STATUS (2026-03-06)

- **@pando-code/core is the ONLY AI backend in @pando/node.** ClaudeBackend and OllamaBackend have been deleted. All AI work routes through PandoCode engine instances.
- **Integration verified:** 204 E2E tests pass with PandoCode engine as the sole backend.

---

# WHAT IT IS

Open-source, multi-provider, multi-agent AI coding engine with persistent memory,
AST-based code intelligence, and self-improving learning. A standalone product —
zero @pando/* dependencies. Lives at `pando/code/` (separate repo from the node monorepo).

**Standalone value:** Any developer uses this as their AI coding assistant.
No Pando network, no Pando Identity required.

**Via @pando/node:** Node creates PandoCode engine instances, registers custom tools,
injects identity via structural typing, tracks cost in Lux instead of USD.

---

# REPOSITORY STRUCTURE

```
pando/code/
  packages/
    core/             THE ENGINE (this is the product)
      engine/         PandoCode class, learning extraction, retry logic
      agent/          Frame builder, prompts, sub-agents, goal stack, working set
      provider/       Multi-provider: Anthropic, OpenAI, Google, Ollama
      memory/         Append-only lessons, reflection, compaction, query
      graph/          AST-based code intelligence (symbols, cross-references)
      board/          Persistent task board (SQLite)
      tool/           23+ built-in tools + tool registry + guardrail enforcement
      guardrails/     Hard guardrails, role permissions, risk tiers, checkpoints
      mcp/            MCP client (Playwright on by default, user-defined servers)
      events/         Typed event bus (20+ StreamEvent types)
      convention/     Project convention detection
      config/         Hierarchical JSONC configuration
      db/             Drizzle ORM schema (all SQLite tables)
      types.ts        All exported types (engine owns its own types)

    server/           HTTP + WebSocket server (Hono)
    web/              React dashboard (Vite)
    cli/              CLI interface (drizzle-orm)
    universal-mcp/    17-tool MCP server (memory, goals, board, agents)

  tests/              Test playbook — human, bench, compare scenarios
  tools/              Dev scripts — benchmarks, integration tests, e2e
  docs/               User guide, developer guide
  docs/archive/       Historical phase plans (superseded by this bible)
```

---

# KEY API

```typescript
// Single agent mode (like Claude Code)
const engine = await PandoCode.create({ projectPath: "." });
for await (const event of engine.send("fix the auth bug")) {
  // event: StreamEvent — typed, structured
}

// Multi-agent team
const engine = await PandoCode.create({
  projectPath: ".",
  preset: "coding",    // built-in communication policy
});

// Register custom tools (e.g., from @pando/node)
engine.tools.register({
  name: "deploy",
  description: "Deploy the application",
  parameters: z.object({ target: z.string() }),
  execute: async (args) => { return { success: true, output: "deployed" }; },
});

// Listen to events
engine.events.on("tool:result", (event) => { /* real-time visibility */ });
engine.events.on("agent:spawned", (event) => { /* track sub-agents */ });

// Budget provider (standalone = USD, via @pando/node = Lux)
engine.setBudgetProvider({
  currency: "lux",
  calculateCost(usage) { return luxRate * (usage.inputTokens + usage.outputTokens); },
});
```

---

# THE ENGINE (PandoCode class)

`packages/core/src/engine/engine.ts` — the heart of the product.

## Class Structure

```typescript
class PandoCode {
  // Core state
  readonly config: PandoCodeConfig;
  readonly db: PandoDb;                 // SQLite via drizzle-orm (sync API)
  readonly tools: ToolRegistry;
  readonly board: Board;
  readonly events: EventBus;

  // AI model
  private model: LanguageModelV3;       // @ai-sdk provider instance
  private modelId: string;
  private role: string;                 // agent role (e.g., "lead", "builder")
  private maxSteps: number;

  // Session
  private sessionId: string | null;
  private messages: V3Message[];        // conversation history (in-memory)
  private currentAgentId: string | null;

  // Budget
  private budgetProvider: BudgetProvider;  // USD default, Lux via node
  private totalTokens: number;
  private totalCost: number;

  // Memory
  private knowledgeStore: KnowledgeStore;
  private memoryStore: MemoryStore;
  private knowledgeGraph: KnowledgeGraph;
  private workingSet: WorkingSetTracker;
  private goalStack: GoalStackManager;

  // MCP
  private mcpManager: McpClientManager;

  // Approvals (ask_user flow)
  _pendingApprovals: Map<string, (response: string) => void>;
}
```

## Factory Method

```typescript
static async create(options: EngineOptions): Promise<PandoCode>
```

1. Load config (hierarchical: defaults → global → project → env → CLI)
2. Create SQLite database + initialize schema
3. Create AI model via provider factory
4. Initialize knowledge graph (AST scan of project)
5. Initialize memory stores (knowledge store + memory store)
6. Register all tools (built-in + MCP)
7. Register agent management tools if role is lead/coordinator
8. Return engine instance

## The Main Loop

`engine.send(prompt)` → `AsyncGenerator<StreamEvent>`

```
1. Start or resume session
2. Add user message to conversation
3. LOOP (until done or budget exhausted):
   a. Build prompt frame (FrameBuilder.build() — 8 layers)
   b. Call model.doStream() with messages + tools
   c. Stream text chunks → emit "stream:chunk" events
   d. Collect tool calls from response
   e. For each tool call:
      - Check guardrails (hard guardrails → permissions → risk tier)
      - Execute tool via ToolRegistry
      - Emit "tool:start" and "tool:result" events
      - Track cost (budgetProvider.calculateCost())
   f. Check budget (soft/hard limits)
   g. Check doom loop (repeated failures → abort)
   h. If no tool calls in response → done (model is finished)
   i. If tool calls present → add results to messages, continue loop
4. Post-turn reflection (extract lessons, memories)
5. Archive conversation if needed (compaction)
6. Yield "session:complete" event
```

## Budget Tracking

```typescript
// Model pricing table (per 1M tokens)
const MODEL_PRICING: Record<string, [input, output]> = {
  "claude-opus-4-6":     [15, 75],
  "claude-sonnet-4-6":   [3, 15],
  "gpt-5.2":             [1.75, 14],
  "gemini-2.5-flash":    [0.15, 0.6],
  "o3":                  [10, 40],
  // ... etc
};

// Default: UsdBudgetProvider
const UsdBudgetProvider: BudgetProvider = {
  currency: "usd",
  calculateCost(usage) {
    const [inputPrice, outputPrice] = getModelPricing(usage.model);
    return (usage.inputTokens * inputPrice) + (usage.outputTokens * outputPrice);
  },
};

// Via @pando/node: LuxBudgetProvider injected at runtime
engine.setBudgetProvider(luxProvider);
```

Budget limits:
- **Soft limit** ($5 / 5 Lux default): emits warning, continues
- **Hard limit** ($10 / 10 Lux default): stops execution
- Per-session, per-task, per-turn limits configurable

## Conversation Compaction

When conversation approaches context window limit:
1. Estimate token count (`charsPerToken` ratio, model-specific)
2. If > `compactionThreshold` (75% default): compact
3. Keep recent `pruneKeepFull` turns (5 default) in full detail
4. Compress older tool results to summary lines
5. Archive full conversation to `conversation_archive` table

## Doom Loop Detection

Detects repeated failures (same tool, same error) and aborts to prevent infinite loops.
Emits `"error:doom_loop"` event with the detected pattern.

---

# FRAME SYSTEM (8-Layer Prompt Assembly)

`packages/core/src/agent/frame-builder.ts` — the ONLY prompt assembly path.

```
Layer 0 — Identity        Who you are, your role, capabilities
Layer 1 — Constitution    Rules, constraints, safety boundaries
Layer 2 — Conventions     Project conventions (detected + learned)
Layer 3 — Knowledge       AST graph context, entity knowledge, code intelligence
Layer 4 — Working Set     Files recently read/modified (tracked automatically)
Layer 5 — Goal Stack      Current goals, subtasks, progress
Layer 5b — Situation      Board snapshot, agent status, recent events
Layer 6 — Conversation    Message history (compacted as needed)
```

**Layers 0-2 are stable** (same content across turns, cached with Anthropic `cache_control`).
**Layers 3-6 are dynamic** (change each turn based on context).

### Token Budget Allocation

`FrameBudget` allocates context window across layers:

```
Context window (e.g., 200K tokens)
  ├── L0-2 Stable:     ~2K tokens (fixed)
  ├── L3 Knowledge:    ~8K tokens (scaled to project size)
  ├── L4 Working Set:  ~4K tokens (files tracked this session)
  ├── L5 Goals:        ~1K tokens (current goal stack)
  ├── L5b Situation:   ~2K tokens (board + agent snapshot)
  └── L6 Conversation: remainder (~183K tokens)
```

Each layer is built, token-counted, and trimmed to its budget.
Frame history is stored in `frame_history` table for debugging/visibility.

---

# AGENT SYSTEM

## Sub-Agent Types

`packages/core/src/agent/sub-agent.ts`

| Type | Role | Tools | Purpose |
|------|------|-------|---------|
| `explore` | explorer | read, glob, grep, list, genome, run_tests | Read-only code exploration |
| `builder` | builder | ALL file tools + bash + test | Write code, edit files |
| `tester` | tester | read, glob, grep, bash, test, run_tests | Run tests, no file writes |
| `lead` | coordinator | read + spawn_agent, manage_tasks, check_agents, ask_user, send_message | Delegate work, don't edit |

## Sub-Agent Lifecycle

```
1. Parent calls spawn_agent tool with type + prompt
2. runSubAgent() creates fresh agent:
   a. Generate UUID for agentId
   b. Create ToolRegistry with type-appropriate tools
   c. Register agent in DB (role, model, status="active")
   d. Build system prompt via buildSystemPromptParts()
   e. Enter loop: doStream() → process tool calls → repeat
3. Agent runs to completion or max steps
4. Return SubAgentResult: { success, summary, toolCalls, filesWritten, totalTokens, totalCostUSD }
5. Parent receives result, decides next action
```

## Goal Stack

`packages/core/src/agent/goal-stack.ts`

- Main goal set from user's initial prompt
- Sub-goals pushed as agent decomposes work
- Progress tracked per goal
- Goal stack injected into L5 frame layer
- `update_goal` tool lets agent manipulate the stack

## Working Set

`packages/core/src/agent/working-set.ts`

- Tracks files read and modified during session
- Injected into L4 frame layer (with timestamps and sizes)
- Helps agent maintain awareness of what it has seen
- Auto-populated by `read_file`, `write_file`, `edit_file` tool calls

## System Prompts

`packages/core/src/agent/prompts.ts`

Role-specific prompt construction:
- **Builder**: "You are a code builder. Write clean, tested code..."
- **Tester**: "You are a test engineer. Write and run tests..."
- **Explorer**: "You are a code explorer. Read and analyze code..."
- **Lead**: "You are a lead agent. Delegate tasks to sub-agents..."

Includes anti-patterns section (avoid doom loops, verify before declaring done).
Model-aware tuning (Claude, GPT, Gemini, o-series each get optimized instructions).

---

# TOOL SYSTEM

## Tool Registry

`packages/core/src/tool/registry.ts`

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodType;
  execute: (args: unknown) => Promise<ToolResult>;
}

class ToolRegistry {
  register(tool: ToolDefinition): void;
  execute(name: string, args: unknown, context?: AgentContext): Promise<ToolResult>;
  list(): ToolDefinition[];
}
```

Execution pipeline:
1. Validate args against Zod schema
2. Check hard guardrails (protected files, dangerous patterns)
3. Check role permissions (role × tool matrix)
4. Check risk tier (role × file risk level)
5. Check scope (agent's readPaths/writePaths/excludePaths)
6. Execute tool
7. Track in working set (for file tools)
8. Return ToolResult

## Built-in Tools (23+)

| Tool | Purpose |
|------|---------|
| `read_file` | Read file contents (enriched with AST cross-references) |
| `write_file` | Create or overwrite a file |
| `edit_file` | Surgical string replacement in a file |
| `multiedit` | Batch multiple edits in one tool call |
| `bash` | Execute shell commands |
| `glob` | Find files by pattern |
| `grep` | Search file contents (regex) |
| `list_files` | List directory contents |
| `genome` | Query the genome knowledge graph |
| `test` | Run a specific test file |
| `run_tests` | Detect and run project test suite |
| `undo` | Undo last file change (git-based) |
| `task` | Create/update board tasks |
| `manage_tasks` | List, assign, complete board tasks |
| `batch` | Execute multiple tool calls in sequence |
| `spawn_agent` | Create a sub-agent (explore/builder/tester/lead) |
| `check_agents` | List agents, check status, read inbox |
| `send_message` | Send message to agent (with communication policy) |
| `ask_user` | Escalate question to human (with timeout) |
| `save_memory` | Save a lesson or preference to memory |
| `query_memory` | Recall memories by relevance |
| `query_knowledge` | Query the AST knowledge graph |
| `update_goal` | Push/pop/update goals on the stack |

## Communication Policy

Messages between agents are governed by configurable rules:

```typescript
interface CommunicationRule {
  from: string;    // sender role (or "*")
  to: string[];    // allowed recipient roles (or ["*"])
  allow: boolean;  // allow or deny
}
```

Rules evaluated top-down, first match wins. No matching rule = allow.

Built-in presets:
- **"open"** — no restrictions (default)
- **"minimal"** — agents only message lead/coordinator; leads can message anyone
- **"coding"** — role-based routing (builders↔testers, everyone→lead)

Configured in `PandoCodeConfig.communication.preset` or `.rules[]`.

---

# MEMORY SYSTEM

## Memories Table (V2 — Append-Only)

```sql
memories (
  id TEXT PRIMARY KEY,          -- ULID
  group_id TEXT,                -- groups similar memories (serve latest per group)
  content TEXT NOT NULL,        -- the memory itself, 1-3 sentences
  type TEXT NOT NULL,           -- lesson|procedure|fact|rule|discovery|goal|decision|relationship
  scope TEXT NOT NULL,          -- JSON array: ["src/auth/authService.ts", "auth", "global"]
  scope_type TEXT NOT NULL,     -- global|domain|file

  -- Type-specific fields
  steps TEXT,                   -- JSON array for procedures
  conditions TEXT,              -- JSON object for conditional rules
  relations TEXT,               -- JSON array for relationships

  -- Hierarchy
  parent_id TEXT,               -- parent memory/goal ID

  -- Provenance
  source_task TEXT,             -- what task created this
  source_session TEXT,          -- which session
  confidence REAL DEFAULT 0.5,
  impact TEXT DEFAULT 'medium', -- low|medium|high|critical

  -- Usage tracking
  serve_count INTEGER DEFAULT 0,
  helpful_count INTEGER DEFAULT 0,
  stale INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,     -- immutable (append-only)
  last_served_at TEXT           -- when last loaded into prompt
)
```

## State Table (Ephemeral Key-Value)

```sql
state (
  key TEXT PRIMARY KEY,         -- "msg:<agentId>:<uuid>", "goal:123:progress"
  value TEXT NOT NULL,          -- JSON blob
  updated_at TEXT NOT NULL,
  expires_at TEXT               -- optional auto-cleanup
)
```

Used for: agent messages (1-hour TTL), dynamic state, goal progress.

## Reflection Engine

`packages/core/src/memory/reflect.ts`

After each turn, automatically extracts:
- **Lessons**: What worked, what didn't, patterns discovered
- **Preferences**: User's coding style, tool preferences, naming conventions
- **Facts**: Project structure, framework details, API patterns

Extracted memories stored in `memories` table with appropriate scope and confidence.

## Memory Recall

`packages/core/src/memory/query.ts`

Memories recalled by relevance scoring:
- **Scope match**: file-scoped > domain-scoped > global
- **Confidence**: higher confidence = higher rank
- **Recency**: recently served memories slightly boosted
- **Hot limit**: top 10 memories (configurable)
- **Warm limit**: next 20 memories (configurable)
- **Stale threshold**: memories not served in 24h flagged stale

---

# KNOWLEDGE GRAPH (AST)

`packages/core/src/graph/graph.ts` + `scanner.ts`

## What It Does

Scans project source code and builds an AST-based symbol index:
- **Symbols**: functions, classes, types, interfaces, variables, methods, properties
- **Cross-references**: imports, calls, extends, implements
- **File dependencies**: source file → target file (import graph)

## Scale

- 1000+ symbols indexed per medium project
- 13000+ cross-references
- Full TypeScript/JavaScript AST scanning via `scanner-ast.ts`
- Regex-based scanning for other languages via `scanner.ts`

## How It's Used

1. **L3 frame layer**: relevant symbols injected into prompt based on working set
2. **`query_knowledge` tool**: agents query the graph mid-task
3. **`read_file` enrichment**: when reading a file, cross-references are appended
4. **`genome` tool**: query the knowledge graph directly

---

# DATABASE SCHEMA

All tables in `packages/core/src/db/schema.ts` + `memory/tables.ts`.
SQLite via `better-sqlite3` (synchronous API) + `drizzle-orm`.

| Table | Purpose |
|-------|---------|
| `projects` | Project registry (name, path, icon, last session) |
| `sessions` | Session state (status, tokens, cost, project) |
| `messages` | Conversation messages (role, content, tool refs) |
| `tool_calls` | Tool call log (args, result, duration) |
| `board_tasks` | Task board (status, order, dependencies, assignments) |
| `board_discoveries` | Project discoveries (framework, pattern, gotcha) |
| `agents` | Agent registry (role, model, tools, scope, identity fields) |
| `checkpoints` | Git-based state snapshots for rollback |
| `budget_usage` | Per-call cost tracking (model, tokens, cost) |
| `files` | File index (path, language, size, hash) |
| `symbols` | AST symbols (name, kind, file, line range, signature) |
| `symbol_references` | Cross-references (import, call, extends, implements) |
| `file_dependencies` | Import graph (source → target, import type) |
| `frame_history` | Per-turn frame snapshots (all layers, budgets, tokens) |
| `memories` | Append-only memory store (lessons, preferences, facts) |
| `state` | Ephemeral key-value (messages, goals, dynamic state) |
| `conversation_archive` | Archived conversation snapshots |

Identity fields on `agents` table (nullable, populated when running under @pando/node):
- `parent_id` — human owner's peerId
- `public_key` — agent's Ed25519 public key (base64)
- `certificate` — agent certificate JSON blob

---

# PROVIDER SYSTEM

`packages/core/src/provider/provider.ts`

## Supported Providers

| Provider | Models | Thinking Support |
|----------|--------|-----------------|
| Anthropic | Claude Opus 4.6, Sonnet 4.6, Haiku 4.5 | Adaptive thinking (budgetTokens) |
| OpenAI | GPT-5.2, GPT-5-mini, o1, o3, o4-mini | Reasoning (always-on for o-series) |
| Google | Gemini 2.5 Flash/Pro, 2.0 | Thinking config (thinkingBudget) |
| Ollama | LLaMA, Mistral, CodeLLaMA (local) | No thinking support |

## How It Works

```
config.provider.default = "google"     // provider name
config.provider.model = "gemini-2.5-flash"  // model ID

createModel(config) → LanguageModelV3 instance
  → Uses @ai-sdk/openai, @ai-sdk/anthropic, @ai-sdk/google
  → Ollama uses OpenAI-compatible API (different baseURL)
```

API keys via environment variables:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GOOGLE_GENERATIVE_AI_API_KEY`
- `OLLAMA_BASE_URL` (default: `http://localhost:11434/v1`)

## Extended Thinking

`buildThinkingOptions(modelId)` returns provider-specific config:
- Anthropic: `{ thinking: { type: "enabled", budgetTokens: 10000 } }`
- Google: `{ thinkingConfig: { thinkingBudget: 8192 } }`
- OpenAI o-series: reasoning always-on, just increase output budget
- Others: no thinking config, 16K max output

---

# GUARDRAILS

## Hard Guardrails

`packages/core/src/guardrails/hard.ts`

Enforced at tool execution (NOT advisory):
- Protected file patterns (`.env`, `*.key`, `node_modules/`, etc.)
- Dangerous shell patterns (`rm -rf /`, `chmod 777`, etc.)
- Configurable via `config.protectedFiles`

## Role Permissions

`packages/core/src/guardrails/permissions.ts`

| Role | Allowed Tools | Max Risk Tier |
|------|--------------|---------------|
| builder | read, write, edit, bash, glob, grep, genome, test, undo | Tier 1 (all) |
| tester | read, bash, glob, grep, genome, test | Tier 4 (tests only) |
| reviewer | read, glob, grep, genome | Tier 4 (read-only) |
| planner | read, glob, grep, genome | Tier 4 (read-only) |
| coordinator | read, glob, grep, genome | Tier 4 (delegates) |
| explorer | read, glob, grep, genome | Tier 4 (read-only) |
| lead | read, glob, grep, genome | Tier 4 (delegates) |
| **Custom** | explicit `tools[]` required | Tier 4 (conservative) |

Custom roles (from @pando/identity) must provide an explicit `tools[]` on the agent profile.
Without it, all tool calls are denied.

## Risk Tiers

```
Tier 1 — Critical: config, env, CI, deploy files
Tier 2 — High: core logic, auth, payments
Tier 3 — Standard: feature code, components
Tier 4 — Low: tests, docs, formatting
```

Configurable overrides via `config.riskTiers.overrides`.

## Git Checkpoints

`packages/core/src/guardrails/checkpoint.ts`

- Creates git tags before edit batches
- Supports rollback to any checkpoint
- `undo` tool restores files from checkpoint
- Non-destructive: uses `git stash create` + `git tag`

---

# CONFIGURATION

`packages/core/src/config/index.ts`

## Load Order (each overrides previous)

1. **Defaults** — built-in defaults
2. **Global** — `~/.pando-code/config.jsonc`
3. **Project** — `./pando-code.jsonc`
4. **Environment** — `PANDO_*` env vars
5. **CLI overrides** — passed programmatically

## Defaults

```typescript
{
  provider: { default: "google", model: "gemini-2.5-flash" },
  budget: {
    session: { maxCostUSD: 10.0, maxTokens: 500_000, warningThreshold: 0.8 },
    task: { maxCostUSD: 2.0, maxTokens: 200_000 },
    turn: { maxInputTokens: 128_000, maxOutputTokens: 16_000 },
    softLimitUSD: 5.0,
    hardLimitUSD: 10.0,
  },
  server: { port: 4873, host: "localhost" },
  engine: { compactionThreshold: 0.75, pruneKeepFull: 5 },
  orchestrator: { childMaxTicks: 10, sessionMaxAgeHours: 48 },
  memory: { recallHotLimit: 10, recallWarmLimit: 20, staleThresholdHours: 24 },
}
```

## Environment Variables

| Variable | Maps To |
|----------|---------|
| `PANDO_PROVIDER` | `provider.default` |
| `PANDO_MODEL` | `provider.model` |
| `PANDO_PORT` | `server.port` |
| `PANDO_BUDGET` | `budget.session.maxCostUSD` |
| `PANDO_BUDGET_SOFT` | `budget.softLimitUSD` |
| `PANDO_BUDGET_HARD` | `budget.hardLimitUSD` |
| `OPENAI_API_KEY` | OpenAI provider auth |
| `ANTHROPIC_API_KEY` | Anthropic provider auth |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google provider auth |
| `OLLAMA_BASE_URL` | Ollama server URL |

---

# EVENT SYSTEM

`packages/core/src/events/bus.ts`

```typescript
class EventBus {
  emit(event: EngineEvent): void;      // emit by type + wildcard "*"
  on(type, handler): void;             // listen for specific type
  onAny(handler): void;                // listen for all events (WebSocket forwarding)
}
```

## Event Types (20+)

| Event | When |
|-------|------|
| `stream:chunk` | Text streamed from AI model |
| `tool:start` | Tool execution begins |
| `tool:result` | Tool execution completes |
| `task:progress` | Board task status changes |
| `task:created` | New task added to board |
| `task:update` | Task status/assignment changes |
| `budget:warning` | Soft budget limit exceeded |
| `budget:exhausted` | Hard budget limit hit |
| `test:result` | Test run completes |
| `checkpoint:created` | Git checkpoint created |
| `session:complete` | Session finishes |
| `error:doom_loop` | Doom loop detected |
| `discovery:new` | New project discovery |
| `lesson:new` | New lesson extracted |
| `agent:spawned` | Sub-agent created |
| `agent:status` | Agent status changed |
| `agent:step` | Agent step progress |
| `reasoning:delta` | Extended thinking output |
| `ask_user` | Human approval requested |

---

# MCP INTEGRATION

`packages/core/src/mcp/client.ts`

## Built-in MCP Servers

- **Playwright**: `@playwright/mcp` — browser automation (always available)

## User-Defined MCP Servers

Configured in `pando-code.jsonc`:

```jsonc
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": { "API_KEY": "..." },
      "enabled": true
    }
  }
}
```

MCP tools are registered into the engine's ToolRegistry like built-in tools.
Agents use them transparently — no distinction between built-in and MCP tools.

---

# UNIVERSAL MCP SERVER

`packages/universal-mcp/`

17-tool MCP server that exposes pando-code's internal systems to external AI tools
(Claude Code, Cursor, Windsurf, etc.). Shares the same SQLite database as the engine.

**Capabilities exposed:** memory CRUD, goal stack, board tasks, agent status, knowledge queries.

```bash
npx tsx packages/universal-mcp/src/server.ts --project <path>
```

---

# PACKAGES (NON-CORE)

## Server (`packages/server/`)

HTTP + WebSocket server. Routes:
- `POST /v1/chat` — send message to engine (SSE streaming response)
- `GET /v1/sessions` — list/manage sessions
- `GET /v1/board` — board snapshot
- `GET /v1/frames` — frame history
- `GET /v1/agents` — agent tree
- `POST /v1/chat/approve` — respond to `ask_user` approval
- `PUT /v1/model` — switch AI model
- `GET /v1/tests/scenarios` — list test scenarios

Port 4873 (must match Vite proxy config).

## Web (`packages/web/`)

React + Vite dashboard:
- Chat interface (streaming)
- Frame inspector (all 8 layers, token budgets)
- Agent tree (hierarchy, status, tool calls)
- Board view (tasks, dependencies, discoveries)
- Test runner (scenarios, results)
- Settings (model, budget, provider)

## CLI (`packages/cli/`)

Terminal interface for interactive coding sessions.

---

# INTEGRATION WITH @pando/identity (Phase 8 COMPLETE)

pando-code has **ZERO @pando/* imports**. Integration is via **structural typing**.
Agent identity flows through PandoCode via structural typing — no adapters, no mapping code.
LuxBudgetProvider is injected at runtime; 35 custom Pando tools are registered per engine instance.

## How It Works

```
@pando/identity defines:         @pando/code defines:
  AgentProfile {                    AgentIdentitySchema {
    id: string                        id: string
    role: string                      role: AgentRoleSchema  (string)
    tools: string[]                   tools: string[]
    scope: AgentScope                 scope: AgentScopeSchema
    model?: string                    model: string
    ...                               status: AgentStatusSchema
    certificate: AgentCertificate     parentId?: string
    publicKey: string                 publicKey?: string
    parentId: string                  certificate?: string
  }                                 }
```

AgentProfile is a SUPERSET of AgentIdentity. TypeScript structural typing lets
@pando/node pass AgentProfile directly to the engine — zero mapping code.

**Proven by test:** `packages/identity/tests/structural-typing.test.ts` (6 tests).

## Dual Budget

- Standalone: `UsdBudgetProvider` (default) — uses model pricing tables
- Via @pando/node: `LuxBudgetProvider` — injected at runtime via `engine.setBudgetProvider()`

```typescript
interface BudgetProvider {
  currency: "usd" | "lux";
  calculateCost(usage: TokenUsage): number;
}
```

## Custom Roles

- Built-in roles (`lead`, `builder`, `tester`, etc.) get role-matrix permissions
- Custom roles (any string, e.g., from @pando/identity) must provide explicit `tools[]`
- `AgentRoleSchema = z.union([z.enum(BuiltInRoles), z.string().min(1)])`

## Identity Fields in Agent DB

Three nullable columns on `agents` table:
- `parent_id` — human owner's peerId (null in standalone)
- `public_key` — agent's Ed25519 public key, base64 (null in standalone)
- `certificate` — agent certificate JSON (null in standalone)

Populated by @pando/node when creating agents via the engine bridge.

---

# KEY TYPES

```typescript
// Agent roles
const BuiltInRoles = ["lead", "builder", "tester", "reviewer",
                       "coordinator", "planner", "explorer"] as const;
type BuiltInRole = (typeof BuiltInRoles)[number];
const AgentRoleSchema = z.union([z.enum(BuiltInRoles), z.string().min(1)]);

// Agent status
const AgentStatusSchema = z.enum([
  "pending", "active", "idle", "working", "done", "failed", "terminated"
]);

// Agent scope
const AgentScopeSchema = z.object({
  readPaths: z.array(z.string()),
  writePaths: z.array(z.string()),
  excludePaths: z.array(z.string()),
  services: z.array(z.string()).optional(),   // @pando/node: allowed services
  network: z.boolean().optional(),            // @pando/node: can make network requests
});

// Budget
type BudgetCurrency = "usd" | "lux";
interface TokenUsage { model: string; inputTokens: number; outputTokens: number; }
interface BudgetProvider { currency: BudgetCurrency; calculateCost(usage: TokenUsage): number; }

// Tool result
interface ToolResult {
  success: boolean;
  output: string;
  metadata?: { filesChanged?: string[]; bytesRead?: number; exitCode?: number; duration?: number; };
}

// Stream events
type StreamEvent =
  | { type: "stream:chunk"; content: string; agentId?: string }
  | { type: "tool:start"; toolName: string; args: unknown; agentId?: string }
  | { type: "tool:result"; toolName: string; result: ToolResult; agentId?: string }
  | { type: "task:progress"; taskId: string; status: TaskStatus; agentId?: string }
  | { type: "budget:warning"; state: BudgetState }
  | { type: "budget:exhausted"; state: BudgetState }
  | { type: "session:complete"; result: TaskResult }
  | { type: "agent:spawned"; agentId: string; role: string; model: string }
  | { type: "ask_user"; requestId: string; question: string; agentId?: string }
  // ... 20+ types total
```

---

# TESTING

Three test categories in `tests/`:

| ID | Scenario | Category | Features Covered |
|----|----------|----------|------------------|
| S1 | Express CRUD App | bench | tools, goals, frames, working set, budget, sessions |
| S2 | Greeting + Follow-up | bench | casual detection, goal skip/init, frame layer diffs |
| S3 | Find All Usages | bench | explore sub-agent, AST/knowledge, cross-refs |
| S4 | Write Tests + Fix Failures | bench | run_tests, goal push/pop, verify-fix loop, multiedit |
| S5 | Remember Preferences | bench | save_memory, memory recall in L3, preference application |
| S6 | Multi-Agent Feature Build | human | lead agent, spawn 3 agents, tasks, messaging, approval |
| S7 | Playwright Smoke Test | human | MCP/Playwright, browser tools, bash, web UI |

---

# DEPENDENCIES

```
Runtime:
  @ai-sdk/openai, @ai-sdk/anthropic, @ai-sdk/google   Provider SDKs
  better-sqlite3                                         Synchronous SQLite
  drizzle-orm                                            ORM (type-safe SQL)
  zod                                                    Schema validation
  fast-glob                                              File pattern matching
  @modelcontextprotocol/sdk                              MCP client
  @playwright/mcp                                        Browser automation (built-in MCP)

Dev:
  typescript ^5.5                                        Language
  tsx                                                    TypeScript execution
  vite                                                   Web frontend bundler

Zero @pando/* dependencies. Fully standalone.
```

---

# CRITICAL GOTCHAS

1. **Never let compiled `.js` files in `src/`** — tsx resolves `.js` imports to literal `.js` files first
2. **Use `model.doStream()` directly**, not `streamText()` — custom agent loop
3. **`better-sqlite3` is synchronous** — drizzle-orm `.all()` returns sync
4. **Always `rm -f tsconfig.tsbuildinfo`** before rebuild if dist is deleted
5. **Server port must be 4873** to match Vite proxy config
6. **Frame history can grow large** — frame_history table stores per-turn snapshots
7. **Conversation compaction is lossy** — older tool results compressed to summaries

---

# RUNTIME

- **Node.js 18+** — runtime for all packages
- **tsx** — TypeScript execution (no compile step for dev)
- **npm** — package manager (not pnpm/yarn)
- **SQLite** — `better-sqlite3` (synchronous API)
- **Windows** — use forward slashes in paths. MSYS paths must be converted before `node:path` resolve.

---

# KEY PRINCIPLES

1. **Engine owns its types** — pando-code defines its own types, never imports @pando/*
2. **Structural typing for integration** — @pando/node passes AgentProfile where engine expects AgentIdentity
3. **Frames are the ONLY prompt path** — FrameBuilder.build() assembles all 8 layers
4. **Memory is append-only** — lessons accumulate, never deleted (only flagged stale)
5. **Tools are the control surface** — all agent actions go through ToolRegistry → guardrails
6. **Budget is pluggable** — USD default, Lux via BudgetProvider injection
7. **Events are typed** — 20+ StreamEvent types, all through EventBus
8. **Config is hierarchical** — defaults → global → project → env → CLI
9. **Sub-agents are fresh** — each spawn gets clean context, no session resume
10. **MCP tools are first-class** — external tools indistinguishable from built-in

---

# WHAT IS NOT IN THIS PACKAGE

```
NOT included (stays in other packages):
  - P2P networking                → @pando/network
  - Lux economy                   → @pando/ledger
  - Governance proposals           → @pando/governance
  - Agent identity/certificates    → @pando/identity (structural typing bridge)
  - Account storage (MongoDB)      → @pando/node
  - Orchestrator tick loop         → @pando/node (drives engine via send())
  - Cross-engine messaging (L2+)   → @pando/node (bridge layer)
  - Deploy to hosting              → @pando/node (gateway deploy pool)
  - Credential storage             → @pando/node (AES-256-GCM vault)
```

This package is the ENGINE. It runs agents, manages memory, tracks tasks, enforces
guardrails, and streams events. Everything else is somebody else's problem.
