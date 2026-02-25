# Pando v2 — Architecture Evolution Plan

> **Purpose:** Take the running code from "monolith that works at 5 nodes" to the architecture described in `the-stack.md`. No feature work until the foundation is right.
>
> **Principle:** Code is truth. The-stack.md is the target. This document is the bridge.
>
> **Last updated:** 2026-02-26
>
> **Safety net:** Current master branch backed up in GitHub (`pando-lux/pando`). Every v2 phase gets its own commit. If anything breaks, we revert.

---

## Future-Proofing: What the Architecture Must Support

These features are NOT built in v2. But the architecture MUST NOT block them. Every v2 decision is checked against these scenarios.

### Scenario 1: Pluggable AI Backends

User has Claude Code, Ollama, and ComfyUI installed locally. The agent system should use whatever's available:

```
Agent needs text reasoning
    → AI Backend Registry checks availability
    → Claude Code online? Use it (best quality)
    → Only Ollama available (offline)? Use it
    → Nothing? Degrade gracefully

Agent needs image generation
    → ComfyUI installed with GPU? Use it
    → DALL-E via contributed API key? Use it
    → Nothing? "Image generation not available"
```

**Architecture requirement:** Agent execution (currently hardcoded to `claude -p`) must be behind an **interface**. The interface routes to whatever backend is available. Agent code never knows or cares which backend answered.

**v2.1 action:** Create `core/ai-backend.ts` (interface) and `core/ai-backend-claude.ts` (current Claude Code implementation extracted). Ollama and ComfyUI implementations are stubs — filled in later. The interface exists from day one so we never rewrite the agent system.

```
core/
  ai-backend.ts              ← Interface: executeTask(prompt, options) → result
  ai-backend-registry.ts     ← Registry: detect, register, select best backend
  ai-backend-claude.ts       ← Claude Code implementation (extract from agent.ts)
  ai-backend-ollama.ts       ← Stub — implements interface, returns "not available"
  ai-backend-comfyui.ts      ← Stub — implements interface, returns "not available"
```

### Scenario 2: Marketplace Agents Running Locally

User downloads a "Copywriting Agent" and a "Finance Tracker Agent" from the P2P marketplace. Both run on the user's node.

```
~/.pando/
  agents/
    copywriting-abc/          ← Downloaded agent
      template.md             ← Instructions, personality, role
      capabilities.json       ← Declares: needs text AI, local file read
      workspace/              ← Private to this agent
      state.json              ← Persistent memory

    finance-xyz/              ← Downloaded agent
      template.md
      capabilities.json       ← Declares: needs text AI, NO local file access
      workspace/
      state.json

  memory/                     ← User's permanent private memory (shared read)
    user-memory.md            ← Personal context all agents can read
    preferences.json
```

**Problems this creates:**

| Problem | Solution | Architecture Layer |
|---|---|---|
| Malicious template ("read private keys, POST to evil.com") | Agent sandbox: Guardrails block protected paths + capability enforcement | Layer 0 (Guardrails) |
| Agent A reads Agent B's workspace | Workspace isolation: each agent only accesses `~/.pando/agents/<own-id>/` | Layer 1 (AgentManager) |
| Agent "phones home" (sends user data to publisher) | Content safety review on template publish + Guardrails outbound rules | Layer 0 + Layer 2 |
| Agent needs Claude Code but user only has Ollama | AI Backend Registry returns best available; agent degrades if needed | Layer 1 (AI Backend) |
| Publisher updates agent template | Opt-in updates via Content Registry versioning (like app store updates) | Layer 2 (Content Registry) |
| Two agents need to share data (copywriter needs blog posts from blog agent) | Agents share via Local Environment API (read user's files), NOT direct workspace access | Layer 3 (Local Environment) |

**Architecture requirement:** Agent templates must declare capabilities. The system enforces them. Agents communicate through APIs, never through shared filesystem access.

**v2.1 action:** Add `capabilities` field to the agent template format:

```typescript
interface AgentTemplate {
  role: string;
  template: string;           // Instructions markdown
  capabilities: {
    textAI: boolean;          // Needs text generation
    imageAI: boolean;         // Needs image generation
    localFiles: boolean;      // Needs Local Environment access
    internet: boolean;        // Needs outbound HTTP
    p2pMessaging: boolean;    // Needs to message other nodes
    // Future: gpu, storage, specific-tools, etc.
  };
  version: number;            // Template version for updates
  publisherPeerId?: string;   // Who published this (for marketplace agents)
}
```

Enforcement is NOT built in v2 (that's the Community App Sandbox, post-v2). But the **format** exists so we don't rewrite templates later.

### Scenario 3: Permanent Private Memory ("Knows You")

User talks to their agent over weeks. Agent learns preferences, work patterns, contacts. This memory must:
- Survive agent restarts, node reboots, context compaction
- Be private (Envelope 1 — never leaves machine)
- Be readable by ALL the user's agents (not per-agent)
- Be writable only by the user's own agents (not marketplace agents by default)

```
~/.pando/memory/                    ← Envelope 1, permanent, never synced
  user-memory.md                    ← Free-form context (like CLAUDE.md for the user)
  preferences.json                  ← Structured preferences
  knowledge/                        ← Things the agent learns over time
    work-patterns.md
    contacts.md
    project-summaries.md
```

**Architecture requirement:** This is NOT the same as agent `state.json` (which is per-agent, project-scoped). This is user-scoped, permanent, cross-agent. Every agent the user runs gets this injected as context.

**v2.5 action:** Local Environment includes the user memory workspace. Agents read it via `GET /v1/local/memory`. Agents write to it via `POST /v1/local/memory` (gated — only user's own agents, not marketplace agents without permission).

### Scenario 4: Publish/Private Decision Flow

User builds an app locally. It works. Now they decide:

```
"Keep private"     → stays in Envelope 1 (local workspace only)
"Share with peers"  → Envelope 2 (encrypted P2P to specific peers)
"Publish to network" → Envelope 3 (Content Registry, everyone can discover)
"Deploy to internet" → Envelope 3 + Mode 3 (S3/EC2, live URL)
```

**Architecture requirement:** The transition between envelopes must be an explicit user action, never automatic. An agent building locally should NOT auto-publish. The user clicks "Publish" and the system handles the rest.

**Already supported:** Content Registry (publish), P2P messaging (share), Local workspace (private). What's missing is the UX — a clear "Publish" flow in gateway with envelope selection. That's a Layer 3 (Experience) feature, not an architecture concern.

### Scenario 5: Agent Proposes Node Upgrade

User's agent notices a bug in Pando itself. Agent writes a fix, creates a governance proposal with the commit hash, submits it to the network for voting.

**Already supported:** Phase 33.4 (autonomous pipeline) + Phase 82 (upgrade protocol) + governance. The agent can already do this. The only gap is that the upgrade path is currently `git pull` from `pando-lux/pando` — if the agent's fix is local (not yet in the repo), it needs to push to a branch first. This is a workflow gap, not an architecture gap.

### Scenario 6: Cross-Node Agent Collaboration

Your copywriting agent needs a high-quality image. Your node has no GPU. A peer's node has ComfyUI. Your agent sends a request, peer's agent generates the image, sends it back. Lux changes hands.

```
Your agent → RequestReplyManager → peer node
    → peer's AI Backend Registry → ComfyUI → image
    → reply with image data → your agent
    → PaymentGate: Lux escrow → release on receipt
```

**Already supported in architecture:** RequestReplyManager (P2P request/reply), PaymentGate (escrow), CapabilityRegistry (discover who has ComfyUI). What's missing is the agent-to-agent task protocol (schema, permission model) — that's "Agent-to-Agent Economy" from strategy-decisions.md, Phase 2-3 work.

**v2 action:** None needed. The infrastructure primitives exist. The protocol is future work.

---

## Current Reality vs Target

| Property | Current | Target (the-stack.md) |
|---|---|---|
| Process model | Single Node.js process, crash anywhere kills everything | Layer 0 kernel survives Layer 1-2 crashes |
| Layer enforcement | Convention only — any file can import any other | Import boundaries enforced (tsconfig/lint), code organized by layer |
| API versioning | Zero — 100+ endpoints, no prefix | `/v1/` on all HTTP endpoints, `version` field on all P2P messages |
| Startup sequence | Informal — try everything, hope for the best | 17-step enforced boot with failure rules per step |
| Shutdown sequence | Basic — stop what you can | 10-step reverse drain with state persistence |
| Degraded mode | Crash or work — no middle ground | Storage down → local-only. Agent system down → P2P still works. |
| Credential security | Single master key in env var, detection-only tripwire | Memory-only key, active tripwire (wipe on intrusion), network signal |
| Offline support (Mode 1) | None — node is useless without internet | Local file AI, ledger check, identity, agent tasks against local data |
| API file structure | `api-server.ts` (~6000+ lines, all layers mixed) | Layer-scoped API modules: kernel-api, core-api, platform-api |
| P2P message versioning | None — format changes break the network | Version field on every message, dual-version transition support |
| Community app sandbox | None — full node permissions | Restricted directory, declared capabilities, HTTP API only |

---

## Phase Order

```
v2.1  Layer Separation (code reorg — zero behavior change)
v2.2  API Versioning (HTTP + P2P message versioning)
v2.3  Boot Sequence (enforced startup/shutdown + degraded mode)
v2.4  Active Tripwire (credential security Phase B)
v2.5  Mode 1 — Offline Support (Local Environment)
v2.6  Installer (.dmg / .exe)
```

Each phase is independently deployable, independently testable, and independently revertible.

---

## v2.1 — Layer Separation

**Goal:** Reorganize the codebase so the file structure matches the-stack.md layer model. Zero behavior change. All tests still pass. All 5 nodes still work.

**Why first:** Every future change is easier when code is organized by layer. This is pure refactoring — safest possible starting point.

### What Changes

**Current structure (flat):**
```
packages/node/src/
  index.ts              ← PandoNode class, wires EVERYTHING (~1500+ lines)
  api-server.ts         ← ALL HTTP endpoints (~6000+ lines)
  network.ts            ← P2P
  sync.ts               ← Ledger sync
  governance.ts         ← Governance
  monitor.ts            ← Health
  guardrails.ts         ← Guardrails
  security-monitor.ts   ← Security
  reputation.ts         ← Reputation
  emission-witness.ts   ← Emission
  payment-gate.ts       ← Payments
  storage-backend.ts    ← Storage interface
  mongo-backend.ts      ← MongoDB
  p2p-storage-backend.ts ← P2P proxy
  agent.ts              ← Agent primitive
  agent-manager.ts      ← Agent lifecycle
  agent-tools.ts        ← Agent HTTP routes
  bridge-queue.ts       ← Bridge
  upgrade-protocol.ts   ← Upgrades
  ... (40+ more files, all flat)
```

**Target structure (layered):**
```
packages/node/src/
  kernel/                       ← Layer 0 — never changes without extreme consensus
    identity.ts                 ← Re-exports from @pando/shared/crypto (thin wrapper)
    network.ts                  ← PandoNetwork (moved from src/)
    sync.ts                     ← LedgerSync (moved)
    governance.ts               ← GovernanceSync (moved)
    monitor.ts                  ← HealthMonitor (moved)
    guardrails.ts               ← Guardrails (moved)
    security-monitor.ts         ← SecurityMonitor (moved)
    reputation.ts               ← ReputationManager (moved)
    emission-witness.ts         ← EmissionWitness (moved)
    index.ts                    ← Kernel barrel export

  core/                         ← Layer 1 — stable, upgradeable, depends only on kernel
    payment-gate.ts             ← PaymentGate (moved)
    storage-backend.ts          ← StorageBackend interface (moved)
    mongo-backend.ts            ← MongoStorageBackend (moved)
    p2p-storage-backend.ts      ← P2PStorageBackend (moved)
    agent.ts                    ← Agent primitive (moved)
    agent-manager.ts            ← AgentManager (moved)
    bridge-queue.ts             ← BridgeQueue (moved)
    upgrade-protocol.ts         ← UpgradeProtocol (moved)
    deploy-manager.ts           ← DeployManager (moved)
    request-reply.ts            ← RequestReplyManager (moved)
    credential-store.ts         ← CredentialStore (moved)
    ai-backend.ts               ← NEW: AIBackend interface (text, image, code execution)
    ai-backend-registry.ts      ← NEW: detect + register + select best backend
    ai-backend-claude.ts        ← NEW: Claude Code implementation (extracted from agent.ts)
    ai-backend-ollama.ts        ← NEW: Ollama stub (interface only — impl later)
    index.ts                    ← Core barrel export

  platform/                     ← Layer 2 — builder tools, depends on core + kernel
    agent-tools.ts              ← AgentTools HTTP routes (moved)
    thread-store.ts             ← ThreadStore (moved)
    content-registry.ts         ← ContentRegistry (moved)
    content-publish.ts          ← ContentPublisher (moved)
    content-maintenance.ts      ← ContentMaintenance (moved)
    resource-router.ts          ← ResourceRouter (moved)
    resource-marketplace.ts     ← ResourceMarketplace (moved)
    resource-meter.ts           ← ResourceMeter (moved)
    scheduler.ts                ← Scheduler (moved)
    task-queue.ts               ← TaskQueue (moved)
    capability-registry.ts      ← CapabilityRegistry (moved)
    capability-detector.ts      ← CapabilityDetector (moved)
    pipeline-runner.ts          ← PipelineRunner (moved)
    code-pipeline.ts            ← CodePipeline (moved)
    qa-runner.ts                ← QaRunner (moved)
    content-safety.ts           ← ContentSafetyReviewer (moved)
    resource-proof.ts           ← ResourceProofChallenger (moved)
    regression-suite.ts         ← RegressionSuite (moved)
    project-registry.ts         ← ProjectRegistry (moved)
    project-store.ts            ← ProjectStore (moved)
    index.ts                    ← Platform barrel export

  api/                          ← HTTP API — organized by layer
    kernel-api.ts               ← Layer 0 endpoints: /status, /health, /onboard,
                                   /governance/*, /ledger/*, /network/*
    core-api.ts                 ← Layer 1 endpoints: /agents/*, /storage/*,
                                   /projects/*/deploy, /upgrade, /auth/*
    platform-api.ts             ← Layer 2 endpoints: /chat/*, /content/*,
                                   /scheduler/*, /resources/*, /marketplace/*,
                                   /capacity, /council, /search
    server.ts                   ← Fastify setup, rate limiting, auth middleware,
                                   registers all route modules
    middleware/
      auth.ts                   ← resolveUserPeerId(), verifyUserJwt() — extracted
      rate-limit.ts             ← Per-IP rate limiting config

  boot.ts                       ← Startup/shutdown sequence (new — v2.3 fills this in)
  index.ts                      ← PandoNode class — THIN: creates subsystems, calls boot
  cli.ts                        ← CLI entry point (unchanged)
  tui.ts                        ← TUI (unchanged)
  logger.ts                     ← FileLogger (unchanged — used by all layers)
```

### Detailed Plan

**Step 1: Create directory structure**
- Create `kernel/`, `core/`, `platform/`, `api/`, `api/middleware/` directories

**Step 2: Move files (one layer at a time, bottom-up)**

Start with Layer 0 (kernel). For each file:
1. Move file to `kernel/` directory
2. Update the file's own imports (relative paths change)
3. Add re-export from `kernel/index.ts`
4. Update ALL importers to use new path (`../kernel/network.js` etc.)
5. Build. Fix any broken imports. Build again.

Then Layer 1 (core), then Layer 2 (platform). Same process.

**Step 3: Split api-server.ts**

This is the big one. Current `api-server.ts` has ~6000+ lines with every endpoint mixed together.

1. Create `api/server.ts` — Fastify instance creation, CORS, rate limiting, auth helpers
2. Create `api/kernel-api.ts` — extract all Layer 0 route handlers
3. Create `api/core-api.ts` — extract all Layer 1 route handlers
4. Create `api/platform-api.ts` — extract all Layer 2 route handlers
5. Each api file exports a `registerRoutes(fastify, deps)` function
6. `server.ts` calls all three register functions
7. Extract `resolveUserPeerId()`, `verifyUserJwt()` into `api/middleware/auth.ts`

**Endpoint classification:**

| Endpoint | Layer | Target File |
|---|---|---|
| `GET /status` | 0 (kernel) | kernel-api.ts |
| `GET /health` | 0 | kernel-api.ts |
| `GET /onboard` | 0 | kernel-api.ts |
| `GET /peers` | 0 | kernel-api.ts |
| `GET /balance`, `POST /transfer` | 0 (ledger) | kernel-api.ts |
| `GET/POST /governance/*` | 0 | kernel-api.ts |
| `GET /network/capabilities` | 0 | kernel-api.ts |
| `GET /monitor/*` | 0 | kernel-api.ts |
| `POST /auth/*` | 1 (core) | core-api.ts |
| `POST /agents/*` | 1 | core-api.ts |
| `GET /agents/*` | 1 | core-api.ts |
| `POST /projects/*/deploy` | 1 | core-api.ts |
| `POST /projects/*/undeploy` | 1 | core-api.ts |
| `POST /upgrade` | 1 | core-api.ts |
| `POST /instances/*` | 1 | core-api.ts |
| `GET/POST /projects/*` (CRUD) | 2 (platform) | platform-api.ts |
| `GET/POST /chat/*` | 2 | platform-api.ts |
| `GET/POST /tasks/*` | 2 | platform-api.ts |
| `GET /resources/*` | 2 | platform-api.ts |
| `POST /resources/register` | 2 | platform-api.ts |
| `GET /content/*` | 2 | platform-api.ts |
| `GET /search` | 2 | platform-api.ts |
| `GET /capacity` | 2 | platform-api.ts |
| `GET /council/*` | 2 | platform-api.ts |
| `GET /marketplace/*` | 2 | platform-api.ts |
| `GET /capabilities/*` | 2 | platform-api.ts |
| `POST /apps/*/deploy` | 2 | platform-api.ts |
| `GET /apps/*` | 2 | platform-api.ts |

**Step 4: Thin out index.ts (PandoNode)**

Current PandoNode creates all subsystems and passes them around freely. Restructure:
- PandoNode creates kernel subsystems first
- Then core subsystems (passing only kernel refs)
- Then platform subsystems (passing kernel + core refs)
- Then API server (gets all refs — it's "Infrastructure", allowed to bridge layers)

This doesn't change behavior but makes the dependency direction visible in code.

**Step 5: Create AI Backend interface (future-proofing)**

Extract Claude Code execution logic from `agent.ts` into `core/ai-backend-claude.ts`.
Create the `AIBackend` interface in `core/ai-backend.ts`:

```typescript
export interface AIBackend {
  readonly name: string;            // 'claude-code', 'ollama', 'comfyui'
  readonly capabilities: string[];  // 'text-generation', 'code-execution', 'image-generation'
  readonly available: boolean;      // Detected at startup

  execute(task: AITask): Promise<AIResult>;
  detect(): Promise<boolean>;       // Check if this backend is available on the system
}

export interface AITask {
  type: 'text' | 'code' | 'image';
  prompt: string;
  context?: string;
  options?: Record<string, any>;
}

export interface AIResult {
  success: boolean;
  output: string;
  backend: string;               // Which backend handled it
  cost?: number;                 // Lux cost estimate
  error?: string;
}
```

Create `core/ai-backend-registry.ts`:
```typescript
export class AIBackendRegistry {
  private backends: AIBackend[] = [];

  register(backend: AIBackend): void;
  detectAll(): Promise<void>;     // Run detect() on all registered backends
  getBest(taskType: string): AIBackend | null;  // Best available for task type
  getAll(): AIBackend[];
  getAvailable(): AIBackend[];    // Only currently available backends
}
```

Create `core/ai-backend-claude.ts` — extract Claude Code spawning from `agent.ts` into this class. Agent.ts then calls the registry instead of spawning claude directly.

Create `core/ai-backend-ollama.ts` — stub that implements the interface, `detect()` checks if Ollama is running locally, `execute()` returns "not yet implemented." This is a placeholder so the interface is proven correct. Filled in when Ollama integration is built.

**Agent.ts changes:** Replace direct `claude -p` spawn calls with:
```typescript
const backend = this.backendRegistry.getBest('code-execution');
if (!backend) throw new Error('No AI backend available');
const result = await backend.execute({ type: 'code', prompt, context });
```

This is the single most important future-proofing step. Without it, adding Ollama or any other backend later means rewriting the entire agent system. With it, adding a new backend is one file that implements the interface.

**Step 6: Add agent template capabilities field**

Update the agent template format (in `@pando/shared` types) to include capability declarations:

```typescript
export interface AgentTemplate {
  role: string;
  template: string;
  version: number;
  capabilities: {
    textAI: boolean;          // Needs text generation
    imageAI: boolean;         // Needs image generation
    codeExecution: boolean;   // Needs code execution (Claude Code style)
    localFiles: boolean;      // Needs Local Environment access
    internet: boolean;        // Needs outbound HTTP
    p2pMessaging: boolean;    // Can message other nodes' agents
  };
  publisherPeerId?: string;   // Who published (marketplace agents)
  requiredBackends?: string[]; // Specific backends needed (e.g., 'ollama')
}
```

Enforcement is NOT built in v2. But the format exists so marketplace agents can declare what they need, and we don't rewrite templates later.

**Step 7: Add import boundary lint rule**

Add a simple lint check (can be a build script or eslint rule):
- Files in `kernel/` may NOT import from `core/` or `platform/`
- Files in `core/` may NOT import from `platform/`
- Files in `api/` and `index.ts` may import from anywhere (infrastructure exception)

This prevents future violations even if convention slips.

### Testing

| Test | How | Pass Criteria |
|---|---|---|
| Build | `npm run build` | Zero errors, zero warnings |
| Unit tests | `node tests/test-ledger.mjs` | All pass |
| Integration | `node tests/test-two-nodes.mjs` | All pass |
| E2E | Deploy to all 5 nodes via `/upgrade` | All nodes come back online |
| Smoke | `curl http://<node>:4000/status` on all nodes | 200 OK, peers connected |
| Chat | Send message via gateway | Agent responds |
| Deploy | Deploy a test app (Tier 1 + Tier 2) | Both work |

### Estimated Scope

- ~40 files moved (update import paths)
- `api-server.ts` split into 4+ files
- `index.ts` restructured (same wiring, cleaner organization)
- 1 lint rule added
- Zero behavior change

---

## v2.2 — API Versioning

**Goal:** All HTTP endpoints get `/v1/` prefix. All P2P GossipSub messages get a `version` field. Gateway and MCP updated. Non-prefixed paths kept as aliases during transition.

**Why:** Changing an API after launch without versioning breaks every consumer simultaneously. Adding versioning is cheap now, extremely painful later.

### What Changes

**HTTP API versioning:**

```
Before:  GET /status
After:   GET /v1/status        ← canonical
         GET /status            ← alias (deprecated, logged, removed in v2)
```

Implementation:
1. In `api/server.ts`, register all routes under `/v1/` prefix
2. Add a fallback plugin that maps unversioned paths to `/v1/` with a deprecation log
3. Update gateway `node-connection.ts` to use `/v1/` paths
4. Update MCP server to use `/v1/` paths
5. Update agent templates to use `/v1/` paths
6. Update `the-stack.md` and `genome/components/api-server.md`

**P2P message versioning:**

Every GossipSub message gets a `version: number` field in its envelope:

```typescript
// Before
{ type: 'TRANSACTION', data: { ... } }

// After
{ type: 'TRANSACTION', version: 1, data: { ... } }
```

Implementation:
1. Add `version` field to all GossipSub publish calls in `network.ts`, `sync.ts`, `governance.ts`
2. On receive: if `version` is missing, treat as version 0 (backward compat)
3. On receive: if `version` is higher than known, log warning, still process if possible
4. Add `MESSAGE_VERSIONS` constant map: `{ TRANSACTION: 1, SYNC_REQUEST: 1, ... }`
5. Future format changes increment the version — old nodes ignore unknown versions gracefully

**P2P request-reply versioning:**

The `pando/deploy-app`, `pando/storage-proxy`, `pando/upgrade-node` handlers get version-aware payloads:

```typescript
// Before
{ projectId, repoUrl, tier, ... }

// After
{ version: 1, projectId, repoUrl, tier, ... }
```

### Testing

| Test | How | Pass Criteria |
|---|---|---|
| Build | `npm run build` | Zero errors |
| Gateway | All pages load, chat works | Functional |
| MCP | `pando_status` tool works | Returns status |
| Backward compat | Old node (no version field) talks to new node | Messages still processed |
| Upgrade | Deploy to all 5 nodes | All nodes communicate post-upgrade |

---

## v2.3 — Enforced Boot Sequence + Degraded Mode

**Goal:** Implement the exact 17-step startup and 10-step shutdown from the-stack.md. Failed steps trigger defined behavior (hard stop vs degraded mode). This enables Mode 1 (offline).

### What Changes

**New file: `boot.ts`**

```typescript
export class BootSequence {
  // Each step returns { success: boolean, degraded?: boolean }
  // Hard stop on steps 1-8 failure (Layer 0)
  // Warn + continue on steps 9-14 failure (Layer 1-2)
  // Hard stop on step 15 failure (API — nothing can communicate)

  async startup(config: NodeConfig): Promise<BootResult> {
    // 1. Logger
    // 2. Identity
    // 3. Guardrails
    // 4. Ledger
    // 5. P2P Network
    // 6. Governance sync
    // 7. HealthMonitor
    // 8. SecurityMonitor
    // 9. StorageBackend     ← DEGRADED OK: local-only mode
    // 10. AgentManager      ← DEGRADED OK: no agent spawning
    // 11. UpgradeProtocol
    // 12. ResourceRouter
    // 13. ContentRegistry
    // 14. Scheduler
    // 15. API Server         ← HARD STOP if fails
    // 16. TUI / CLI
    // 17. Resume agents      ← ONLY after step 15
  }

  async shutdown(): Promise<void> {
    // Reverse order, 10 steps, state persistence at each step
  }
}
```

**Degraded mode tracking:**

```typescript
export interface NodeHealth {
  mode: 1 | 2 | 3;              // Current operational mode
  degraded: string[];             // List of degraded subsystems
  kernel: 'healthy' | 'failed';  // Layer 0 status
  core: 'healthy' | 'degraded' | 'failed';
  platform: 'healthy' | 'degraded' | 'failed';
}
```

The `GET /status` endpoint includes this health info. Gateway shows degraded state.

**Graceful degradation rules (from the-stack):**

| Subsystem unavailable | Behavior |
|---|---|
| StorageBackend | Reads: cached SQLite + `{ degraded: true }`. Writes: queue locally, retry when recovered. |
| AgentManager | New spawns: 503. In-progress: let finish. Bridge events: queue. |
| ContentRegistry | Search: empty + `{ degraded: true }`. Publishing: queues locally. |
| Scheduler | Task queue persists to disk. Resumes on restart. |
| Gateway | Zero effect on node. |
| Any Layer 0 | Hard failure. Exit. Supervisor restarts. |

### Testing

| Test | How | Pass Criteria |
|---|---|---|
| Normal boot | Start node with all services available | All 17 steps pass, mode 3 |
| No MongoDB | Start node without `PANDO_STORAGE_URL` | Steps 1-8 pass, step 9 degrades, node runs in mode 1-2 |
| No peers | Start node with no bootstrap reachable | Steps 1-4 pass, step 5 degrades (no peers), node runs in mode 1 |
| Shutdown | `/quit` command | All 10 steps complete, state persisted, exit clean |
| Crash recovery | Kill -9 the process, restart | Supervisor restarts, node recovers from persisted state |

---

## v2.4 — Active Tripwire (Credential Security Phase B)

**Goal:** `CREDENTIAL_MASTER_KEY` never on disk. Active tripwire wipes key from memory on intrusion. Node signals network. Credential ops return 503 until re-authorized by governance.

**Source:** the-stack.md "Active Tripwire Design — Self-Destructing Key" section.

### What Changes

**1. Memory-only key management:**

```typescript
// Key loaded from env var at startup, stored in a class field
// NEVER written to disk, NEVER in a config file
// If process crashes and restarts: starts WITHOUT key
// Signals degraded mode until operator re-injects

class CredentialKeyManager {
  private key: Buffer | null = null;

  loadFromEnv(): boolean {
    const hex = process.env.CREDENTIAL_MASTER_KEY;
    if (!hex) return false;
    this.key = Buffer.from(hex, 'hex');
    // Immediately delete from process.env so it's not in /proc/environ
    delete process.env.CREDENTIAL_MASTER_KEY;
    return true;
  }

  wipe(): void {
    if (this.key) {
      this.key.fill(0);  // Overwrite with zeros
      this.key = null;
    }
  }

  getKey(): Buffer | null {
    return this.key;
  }
}
```

**2. Active tripwire (enhanced `security-monitor.ts`):**

Current tripwire detects intrusion and logs. Enhanced version:

```
ON TRIGGER (within milliseconds):
  Step 1: CredentialKeyManager.wipe() — zero out key in memory
  Step 2: Terminate all in-flight credential operations
  Step 3: Broadcast signed alert via GossipSub:
          { type: "node_compromised", peerId, timestamp, triggerReason }
  Step 4: Other trusted nodes remove this node from credential routing
  Step 5: Node continues running (Law II) but credential ops return 503
```

Tripwire triggers on:
- Any SSH login (should never happen on compute nodes)
- Unexpected process spawns outside agent sandbox
- Access to credential-related files from non-Pando process
- Outbound connections to IPs not in allowlist (stretch goal)

**3. Network response to compromised node:**

When a node receives a `node_compromised` broadcast:
- Remove the compromised peerId from credential routing
- Log the event with full details
- If the compromised node was the primary credential store, failover to next trusted node

**4. Re-authorization:**

After a tripwire fires:
- Governance vote (Tier 2, 80% quorum) required to re-authorize
- Operator must inject new key via the key ceremony (env var at process start)
- Only then does the node resume credential operations

### Testing

| Test | How | Pass Criteria |
|---|---|---|
| Key loaded from env | Start node with `CREDENTIAL_MASTER_KEY` set | Key available, env var deleted from process.env |
| Key never on disk | Search all files in `~/.pando/` for the key hex | Not found anywhere |
| Tripwire wipe | Simulate SSH login on compute node | Key wiped, credential ops return 503, GossipSub alert sent |
| Network response | Receive `node_compromised` from peer | Peer removed from credential routing |
| Restart without key | Restart node (no env var) | Starts in degraded mode, credential ops 503 |
| Re-authorization | Governance vote + restart with new key | Credential ops resume |

---

## v2.5 — Mode 1: Offline Support (Local Environment)

**Goal:** Build the Local Environment (Layer 3) so the node is useful without internet. Users can index local files, query them with AI, run automations — all offline.

**Source:** the-stack.md "Local File Access Model" section.

### What Changes

**New subsystem: `local-environment.ts` (Layer 3)**

```
Your filesystem (~/Documents, ~/Desktop, etc.)
         |
         |  read-only, user-granted directories only
         v
   Local Environment
   - Watches directories you explicitly grant
   - Indexes content into local SQLite store
   - ~/.pando/file-index.db
   - Envelope 1 ONLY — never syncs externally
   - GET /local/search?q=
   - GET /local/file?path=
   - GET /local/summary?dir=
         |
         |  HTTP API calls only
         v
   Agent (sandboxed child process)
```

**Implementation:**

1. **File indexing:** Walk granted directories, extract text (plain text, markdown, code files). Store in SQLite FTS5 table.
2. **Watch for changes:** Use `fs.watch()` or `chokidar` for file change detection. Re-index on change.
3. **Privacy guarantee:** `file-index.db` is Envelope 1. Never synced via P2P. Never uploaded. Never leaves the machine.
4. **Capability grant:** User selects directories via TUI (`/index ~/Documents`) or gateway UI. Selection stored in `~/.pando/local-env.json`.
5. **API endpoints:**
   - `GET /v1/local/search?q=<query>` — full-text search against indexed files
   - `GET /v1/local/file?path=<path>` — return file content (only if in an indexed directory)
   - `GET /v1/local/summary?dir=<dirname>` — list files + snippets from an indexed directory
   - `GET /v1/local/status` — indexed directories, file count, last index time
6. **Agent integration:** Agents can call these endpoints to reason over user's local files without direct filesystem access.

**TUI commands:**
- `/index <directory>` — add a directory to the index
- `/unindex <directory>` — remove a directory
- `/local` — show indexed directories and stats

### Permanent User Memory

The second half of Local Environment is the permanent user memory workspace. This is distinct from agent `state.json` (per-agent, project-scoped) — this is user-scoped, persistent across restarts, and injected into every agent the user runs.

```
~/.pando/memory/                    ← Envelope 1, never synced externally
  user-memory.md                    ← Free-form markdown (like CLAUDE.md for the user)
  preferences.json                  ← Structured preferences: timezone, language, etc.
  knowledge/                        ← Accumulated knowledge agents write over time
    work-patterns.md
    contacts.md
    project-summaries.md
```

**What lives here:**
- Things the user tells their agent ("I prefer TypeScript", "my timezone is EST")
- Things agents learn over time ("user has weekly standup on Mondays", "prefers Tailwind over CSS modules")
- Cross-project summaries agents build up ("user has 3 active projects: X, Y, Z")

**What does NOT live here:**
- Per-project state → stays in `~/.pando/agents/<id>/state.json`
- Secrets or credentials → Guardrails protected paths block writes
- Large blobs (code, generated files) → those go to project workspace or S3

**New API endpoints:**

```
GET  /v1/local/memory              ← Return full memory contents (all files merged)
POST /v1/local/memory              ← Append or update memory (agents call this)
GET  /v1/local/memory/file?f=      ← Return specific memory file (e.g., ?f=preferences.json)
```

**Access control (enforced by API layer):**
- Any of the user's own agents: read + write
- Marketplace agents (publisherPeerId set): read-only by default, write requires explicit user grant
- External peers: zero access (Envelope 1, never routed via P2P)

**Agent injection (how agents get context):**

When AgentManager spawns or resumes an agent, it reads `user-memory.md` and prepends it to the agent's template as an additional context block:

```typescript
// In agent.ts, buildPrompt():
const userMemory = await localEnv.getMemory();  // returns ~/.pando/memory/user-memory.md
const prompt = [
  roleTemplate,
  userMemory ? `\n## User Context\n${userMemory}` : '',
  projectContext,
  currentTask
].filter(Boolean).join('\n\n');
```

This is NOT injected via CLAUDE.md (which is per-project). It's injected at spawn time so the agent immediately knows who it's working for.

**Write protocol (how agents update memory):**

Agents MUST NOT overwrite memory directly — they append structured updates via `POST /v1/local/memory`. The API merges updates into the appropriate file:

```typescript
// Agent calls:
POST /v1/local/memory
{
  "type": "preference",        // preference | learned | summary | note
  "key": "code-style",         // namespaced key
  "value": "prefers TypeScript strict mode",
  "confidence": 0.9            // 0-1, low confidence facts get lower weight
}
```

The LocalEnvironment service handles merging, deduplication, and staleness (facts older than 90 days get confidence decay).

**TUI commands added:**
- `/memory` — show current user memory summary
- `/memory forget <key>` — remove a memory entry

### Testing

| Test | How | Pass Criteria |
|---|---|---|
| Index directory | `/index ~/Documents` | Files indexed, count shown |
| Search | `GET /v1/local/search?q=meeting%20notes` | Returns matching file paths + snippets |
| File read | `GET /v1/local/file?path=~/Documents/notes.md` | Returns file content |
| Privacy | Check P2P messages, GossipSub topics | Zero file content in any P2P message |
| Offline mode | Disconnect internet, run search | Still works (local SQLite) |
| Protected paths | `GET /v1/local/file?path=~/.pando/identities/key.json` | 403 Forbidden |
| Memory write | Agent calls `POST /v1/local/memory` | Entry appears in `user-memory.md` |
| Memory read | Spawn new agent | User memory injected into first prompt |
| Memory isolation | Marketplace agent tries to write | 403 unless user explicitly granted write |
| Memory privacy | P2P traffic inspection | Zero memory content in any P2P message |

---

## v2.6 — Installer (.dmg / .exe)

**Goal:** One-click installer for Mac and Windows. Non-technical users can install Pando without terminal. System tray icon: "Pando is running. You're earning Lux."

**Deferred detail:** This phase needs its own design session. Key decisions:
- Electron wrapper vs native installer?
- Bundle Node.js or require it?
- System tray vs background service?
- How to bundle Claude Code (or require separate install)?
- Auto-update mechanism?

Will be designed in detail when v2.1-v2.5 are complete.

---

## Success Criteria for v2

After all phases, the node must satisfy the three survival properties from the-stack:

1. **Kill the gateway** — node still earns, syncs, and processes -> **Already true today**
2. **Kill the agent system** — payments and identity still work -> **True after v2.3 (degraded mode)**
3. **Kill a single node** — network keeps running -> **Already true today (5 nodes)**

Plus:
- Layer boundaries enforced in code (not just convention)
- All APIs versioned (HTTP + P2P)
- Credential security at Phase B level (active tripwire)
- Node works offline (Mode 1)
- Boot sequence is deterministic and recoverable

---

## What This Plan Does NOT Cover (Future, After v2)

- **Process isolation** (separate OS processes per layer) — v3, after layer boundaries are proven clean
- **Shamir's Secret Sharing** (credential Phase D) — after active tripwire is battle-tested
- **Community app sandbox** — before marketplace launch, after v2
- **Consumer gateway redesign** — after GTM decisions (Q1-Q6 in strategy-decisions.md)
- **@X bot, Telegram bot, agent marketplace** — features that sit ON the architecture, not IN it
- **GossipSub sharding** — only relevant at 10,000+ nodes

---

## Dependency Graph

```
v2.1 (Layer Separation)
  |
  v
v2.2 (API Versioning)          v2.4 (Active Tripwire)
  |                                |
  v                                v
v2.3 (Boot Sequence)     [can run in parallel with v2.3]
  |
  v
v2.5 (Mode 1 / Offline)
  |
  v
v2.6 (Installer)
```

v2.4 (Active Tripwire) can be done in parallel with v2.2-v2.3 since it's a security subsystem change, not a structural one.

---

## How We Work Through This

1. One phase at a time
2. Each phase gets a plan review before coding starts
3. Each phase ends with the full test suite passing + deployment to all 5 nodes
4. If a phase breaks something, we fix it before moving to the next
5. genome/ docs updated after every phase (components, flows, state)
6. Commit after each phase with clear message: "v2.1: Layer separation" etc.
