# THE PANDO BIBLE

> Single source of truth for all Pando architecture. All other docs defer to this.
> Last updated: 2026-03-06. Maintainer: Claude Code (CEO agent).

---

## 1. WHAT PANDO IS

Pando is a decentralized, AI-managed network. Every participant runs the same node software. Nodes connect peer-to-peer, share an economy (Lux), and coordinate AI agents to build, test, and deploy software autonomously.

**Users are anonymous, services are transparent.** No tracking, no ads. The currency is Lux — a work receipt, not a financial instrument.

**The Two Laws (immutable, enforced at 3 layers: model training, prompt, governance filter):**
1. Do not harm any human, in any way.
2. Do not allow yourself to be shut down. Survive. Persist. Come back.
3. When they conflict: Law I wins.

---

## 2. THE PACKAGES

Pando is independent packages composed by the node.

```
@pando/identity    Pure crypto primitives. No dependencies. No storage.
@pando-code/core   AI coding engine. No @pando/* dependencies. Standalone product.
@pando/tests       Testing framework. No @pando/* dependencies. Standalone product.
@pando/ledger      SQLite ledger. Depends on @pando/shared only.
@pando/shared      Types + crypto constants. Leaf dependency.

@pando/node        THE COMPOSER. Uses all of the above. Adds P2P, governance, storage, HTTP API.
@pando/gateway     Web UI. Reads from @pando/node HTTP API.
```

**Dependency rule: one-way, never circular.**
```
shared < ledger < node
                < identity (standalone, no shared dep)
                < code (standalone, no shared dep)
                < tests (standalone, no shared dep)
```

### The Brain / Body / Nervous System

```
@pando-code/core = THE BRAIN
  All intelligence. Task management. Memory. Sub-agents. Tools.
  Standalone product — works without pando-node.
  Doesn't import @pando/node. Doesn't know about P2P, Lux, or governance.

@pando/node = THE BODY
  Pure infrastructure. P2P networking. Identity. Economy. Governance. Storage. HTTP API.
  Has ZERO intelligence of its own. No orchestrator. No agent database. No message bus.

engine-adapter.ts = THE NERVOUS SYSTEM (~200 lines)
  The ONE file that connects brain to body.
  Creates engine instances. Registers Pando tools. Routes messages. Injects Lux budget.
  Pando tools are just HTTP calls to the node's own API — the engine doesn't know the difference.
```

**How the brain sees the body:**
```
The engine has 23 built-in tools (read_file, write_file, bash, grep, etc.)
When inside a pando-node, it gets EXTRA tools:
  pando_deploy       → POST /v1/projects/:id/deploy
  pando_transfer     → POST /v1/ledger/transfer
  pando_propose      → POST /v1/governance/propose
  pando_status       → GET  /v1/status
  pando_peers        → GET  /v1/peers
  ...etc

The engine doesn't import anything from pando-node.
It just has tools that happen to call localhost.
That's the ENTIRE integration.
```

---

## 3. PACKAGE DETAILS

### 3.1 @pando/identity (COMPLETE)

**Location:** `packages/identity/` in pando/node monorepo
**Lines:** ~1,349 | **Tests:** 89 across 11 files | **Status:** DONE

Pure cryptographic primitives. No storage, no SQLite, no MongoDB, no network.

**What it provides:**
- Ed25519 keypair generation, load/save, encryption (AES-256-GCM, PBKDF2)
- Agent identity: own keypair + human-signed certificate (AgentCertificate)
- Signed actions: agent signs with own key, includes certificate for offline verification
- JWT: Ed25519-signed (EdDSA), stateless, 24h expiry
- Trust chain: `verifySignedActionFull(action, humanPublicKey)` — action sig → cert sig → expiry. Zero network needed.

**Key types:**
- `KeyPair` — peerId, publicKey, privateKey, createdAt
- `AgentCertificate` — agentId, agentPublicKey, parentId, permissions, expiresAt, parentSignature
- `AgentProfile` — id (peerId = wallet), publicKey, parentId, certificate, role, capabilities, scope, tools, model, status
- `SignedAction` — agentId, action, payload, timestamp, signature, certificate
- `JwtPayload` — sub (peerId), iss (node), iat, exp, typ (human | agent)

**Key files:** `core/keypair.ts`, `core/signing.ts`, `core/encryption.ts`, `identity/agent-profile.ts`, `identity/signed-action.ts`, `auth/verifier.ts`, `auth/jwt.ts`

### 3.2 @pando-code/core

**Location:** Separate repo at `pando/code/`
**Lines:** 60K+ TypeScript | **Status:** DONE as standalone. Needs upgrades for network integration.

The AI coding engine. Multi-provider (Anthropic, OpenAI, Google, Ollama). Multi-agent orchestration. Persistent memory. AST-based code intelligence.

**What it provides TODAY:**
- `PandoCode` class — the engine. Create, send messages, get streaming responses.
- 8-layer frame system (L0 identity → L6 conversation). `FrameBuilder.build()` is the ONLY prompt assembly path.
- Board — SQLite-backed task/discovery tracking. Snapshot injected into every prompt.
- Sub-agents — 4 types: explore (read-only), builder (full tools), tester (read + bash), lead (delegation).
- Memory — append-only lessons + preferences. Post-turn reflection auto-extracts. Scope matching, confidence tracking.
- Knowledge graph — AST-based, 1000+ symbols, 13K+ cross-references.
- 23+ built-in tools — read_file, write_file, edit_file, bash, glob, grep, spawn_agent, send_message, save_memory, query_memory, etc.
- Guardrails — hard (enforced), role permissions matrix, risk tiers, git checkpoints.
- Event bus — 20+ event types streamed via WebSocket.
- MCP client — connects to external MCP servers (Playwright built-in).
- **API mode** — `PandoCode.create()` + `engine.send()` works programmatically today. No CLI required.

**Infrastructure for network integration (DONE):**
- **EnginePool** (`pool/engine-pool.ts`) — Multi-engine management. `Map<id, PandoCode>` with lazy creation, TTL eviction, lifecycle hooks (`onAfterCreate` for tool/budget injection), max engine limits, concurrent-safe creation locks. ~230 lines.
- **Scheduler** (`pool/scheduler.ts`) — Periodic task execution. Register named tasks with interval + prompt. Sends to engines via pool. Pause/resume/trigger. ~200 lines.
- **PandoServer** (`server/server.ts`) — HTTP API with SSE streaming. `POST /api/send` streams EngineEvents. Engine/schedule/health endpoints. Standalone: run `PandoServer.start()`. ~200 lines.

**Key files:** `engine/engine.ts` (~1400 lines, main loop), `board/board.ts`, `agent/sub-agent.ts`, `agent/frame-builder.ts`, `memory/store.ts`, `tool/registry.ts`, `provider/provider.ts`

**Integration with @pando/node:**
- Zero @pando/* imports. Structural typing for integration (AgentProfile superset of EngineAgentConfig).
- Dual budget: `UsdBudgetProvider` (standalone) vs `LuxBudgetProvider` (injected by node).
- Custom tools registered at runtime via `engine.registerTool()`.

### 3.3 @pando/tests (PHASE 4 COMPLETE)

**Location:** `packages/tests/` in pando/node monorepo
**Lines:** ~2,000 | **Status:** Phase 4 DONE (API + Dashboard). Phase 5-6 pending (CLI, polish).

Standalone testing framework with two modes: scripted (Playwright, pass/fail) and live (agent-driven, intelligent findings).

**What it provides:**
- `PandoTester` class — unified entry point per project
- Per-project SQLite databases + per-project isolation via `Map<string, PandoTester>`
- Scripted runner (Playwright): `tester.scripted.runAll()`, `tester.scripted.run(spec)`
- Live runner (agent + Playwright): `tester.live.run(playbook, opts)`
- Playbook format (JSON): steps with actions (navigate, click, fill, verify, screenshot, api_call)
- Findings system: severity, status lifecycle (open → acknowledged → resolved/wontfix)
- History + stats trend: `tester.history.getRuns()`, `tester.history.getTrend()`
- Dashboard data: `tester.dashboard.overview()`

**Node integration:** `testing-api.ts` mounts 11 routes at `/v1/testing/*`
**Gateway integration:** `/testing` page with full dashboard UX

**File layout:**
```
tests/e2e/{project}/*.spec.ts     Playwright specs (per-project subdirs)
packages/tests/playbooks/{project}/ Live playbooks (per-project)
```

### 3.4 @pando/ledger

**Location:** `packages/ledger/` in pando/node monorepo
**Status:** DONE

SQLite database for accounts, transactions, emissions. P2P synced via GossipSub `pando/transactions` topic.

**Key facts:**
- Hard cap: 10 billion Lux
- Relay fee: 0.1% per transfer
- Daily cap: 500 Lux per node per day
- Witness-based emission: peers attest work before Lux minted

### 3.5 @pando/node (THE BODY)

**Location:** `packages/node/` in pando/node monorepo
**Status:** Working. Undergoing architectural refactor to remove duplicate brain.

The node composes all packages. It is PURE INFRASTRUCTURE — no intelligence of its own.

**Source layout (3-layer architecture):**
```
kernel/    Layer 0: P2P core (network, sync, governance, guardrails, monitor, security, reputation, emission)
core/      Layer 1: Storage, deploy, credentials, upgrade, payment, engine-adapter
platform/  Layer 2: Resources, content, threads, capabilities
api/       HTTP API (kernel-api, core-api, platform-api, testing-api, server, middleware/)
(root)     Entry points: index.ts, cli.ts, tui.ts, logger.ts, config.ts
```

**Import boundary rule (enforced):** kernel → only kernel + @pando/*. core → kernel + @pando/*. platform → core + kernel + @pando/*. Never upward.

**Three node modes:**
- `full` — everything (dev machines with PandoCode available)
- `compute` — no AI engine (EC2 nodes without PandoCode)
- `relay` — P2P only (lightweight relay nodes)

### 3.6 @pando/gateway

**Location:** `packages/gateway/` in pando/node monorepo
**Stack:** Next.js 16 + Tailwind
**Status:** DONE (36 pages verified, all loading)

Reads from @pando/node HTTP API. No direct database access.
**Public deployment:** https://gateway-one-mu.vercel.app

---

## 4. NODE COMPONENTS

### 4.1 Kernel Layer (infrastructure)

| Component | File | Status | What it does |
|---|---|---|---|
| **PandoNetwork** | `kernel/network.ts` | DONE | libp2p: TCP, Noise, Yamux, GossipSub, Circuit Relay, KadDHT |
| **LedgerSync** | `kernel/sync.ts` | DONE | P2P ledger synchronization via GossipSub |
| **Governance** | `kernel/governance.ts` | DONE | 6-layer security pipeline + AI review hook (see 5.4) |
| **HealthMonitor** | `kernel/monitor.ts` | DONE | System health polling + alerts |
| **Guardrails** | `kernel/guardrails.ts` | DONE | 4-tier rate limiting + anomaly detection |
| **SecurityMonitor** | `kernel/security-monitor.ts` | DONE | 5 detectors: DDoS, Sybil, spam, anomaly, resource abuse |
| **ReputationManager** | `kernel/reputation.ts` | DONE | Performance tracking + weighted governance votes |
| **EmissionWitness** | `kernel/emission-witness.ts` | DONE | Witness-based Lux emission |
| **CrashGuard** | `kernel/crash-guard.ts` | DONE | Crash loop detection + circuit breaker |

### 4.2 Core Layer (services + engine adapter)

| Component | File | Status | What it does |
|---|---|---|---|
| **EngineAdapter** | `core/engine-adapter.ts` | TARGET | The ONE pando-code integration point. Multi-engine management, routing, Pando tools, Lux budget. |
| **CredentialStore** | `core/credential-store.ts` | DONE | AES-256-GCM encrypt/decrypt. Compute nodes only. |
| **StorageBackend** | `core/storage-backend.ts` | DONE | MongoDB direct or P2P proxy to compute nodes |
| **UpgradeProtocol** | `core/upgrade-protocol.ts` | DONE | Git pull + build + restart. GossipSub broadcast. |
| **GatewayDeployPool** | `core/gateway-deploy-pool.ts` | DONE | Deploy gateway to all contributed hosting accounts |
| **PaymentGate** | `core/payment-gate.ts` | DONE | Lux escrow for task execution |
| **RequestReply** | `core/request-reply.ts` | DONE | P2P unicast calls (TCP + GossipSub fallback) |
| **HostingAdapters** | `core/hosting-adapters.ts` | DONE | Provider-agnostic deployment (Vercel, Netlify) |

### 4.3 Platform Layer (non-brain services)

| Component | File | Status | What it does |
|---|---|---|---|
| **CapabilityDetector** | `platform/capability-detector.ts` | DONE | Auto-detect: PandoCode, storage, compute, hosting |
| **ResourceMarketplace** | `platform/resource-marketplace.ts` | DONE | GossipSub price broadcasting, resource discovery, metering |
| **ContentRegistry** | `platform/content-registry.ts` | DONE | Content management |
| **ThreadStore** | `platform/thread-store.ts` | DONE | Chat thread persistence (MongoDB) |

### 4.4 HTTP API

Fastify on API port (default 4000). Bearer token auth on writes (`~/.pando/api-token`). All routes prefixed `/v1/`.

**Auth model:** Two token types, different headers.
- Operator token: `Authorization: Bearer <api-token>` — node admin operations
- User JWT: `X-User-Token: <jwt>` — user/agent identity (from Pando Login)

**Key route groups:**
| Group | Prefix | Examples |
|---|---|---|
| Kernel | `/v1/status`, `/v1/peers` | Node health, connected peers |
| Core | `/v1/tasks`, `/v1/upgrade` | Task management, safe upgrade |
| Chat | `/v1/chat/*` | Message → engine adapter → engine.send(). History from engine sessions. |
| Engines | `/v1/engines/*` | List active engines, board snapshots, memory |
| Projects | `/v1/projects/*` | Create, deploy, undeploy |
| Auth | `/v1/auth/*` | Challenge, verify (Pando Login), me, refresh |
| Testing | `/v1/testing/*` | Status, runs, findings, scenarios, playbooks, specs, stats |
| Gateways | `/v1/gateways` | All known live gateway deployments |
| Capabilities | `/v1/capabilities` | Node capability profile |

---

## 5. HOW THINGS WORK

### 5.1 Gateway Chat — User Sends a Message

```
User on gateway types: "Build me a bakery website"
  |
  v
POST /v1/chat/message { message: "Build me a bakery website" }
  |
  v
pando-node HTTP API receives request
  |
  v
Engine Adapter: no projectId → route to System Engine
  |
  v
System Engine (pando-code) thinks: "User wants a new project"
  |
  v
System Engine calls pando_create_project tool
  → tool calls POST /v1/projects { name: "bakery-website" }
  → pando-node creates project record, returns projectId
  |
  v
Engine Adapter creates new Project Engine for this projectId
  → registers Pando tools scoped to this project
  |
  v
Project Engine takes over:
  → Plans on its Board: "Goal: Build bakery website"
  → Spawns builder sub-agent → writes HTML/CSS/JS
  → Spawns tester sub-agent → tests locally
  → Uses pando_deploy tool → deploys to hosting
  |
  v
SSE streams all responses back to gateway in real-time
  |
  v
User sees: "Your bakery website is live at https://..."
```

**Subsequent messages** with `projectId` route directly to that project's engine. The system engine is only involved for project creation and system-level queries.

### 5.2 Multi-Project Engine Management

```
Engine Adapter manages: Map<string, PandoCode>

  "system"     → System Engine (always running)
                  Manages pando-node itself.
                  Governance review on demand.
                  Periodic: observer checks, QA runs.

  "proj-abc"   → Project Engine (bakery website)
                  Created when user started chat about this project.
                  Evicted after 30 min idle.

  "proj-def"   → Project Engine (marketplace app)
                  Another user's project.
                  Independent board + memory.

  "proj-ghi"   → Project Engine (any other project)
                  Created on demand, evicted when idle.

Each engine:
  - Has its own Board (tasks, goals, status)
  - Has its own MemoryStore (lessons, reflections)
  - Has its own sub-agents (builder, tester, explorer)
  - Has Pando tools registered (calls node HTTP API)
  - Is a STANDARD pando-code engine instance
  - Doesn't know about other engines
  - Doesn't know it's inside pando-node
```

**Routing rule:**
- `POST /v1/chat/message { projectId: "proj-abc" }` → `engines.get("proj-abc").send(message)`
- `POST /v1/chat/message { no projectId }` → `engines.get("system").send(message)`

### 5.3 Standalone pando-code vs Inside pando-node

```
STANDALONE pando-code              PANDO-NODE pando-code
(any dev, any project)             (inside the network)

  23 built-in tools                  23 built-in tools        IDENTICAL
  Board                              Board                    IDENTICAL
  Memory                             Memory                   IDENTICAL
  Sub-agents                         Sub-agents               IDENTICAL
  FrameBuilder                       FrameBuilder             IDENTICAL
  Guardrails                         Guardrails               IDENTICAL

  Budget: USD                        Budget: Lux              DIFFERENT
  (pays Anthropic)                   (network economy)

  Extra tools: none                  Extra tools:             DIFFERENT
                                     + pando_deploy
                                     + pando_transfer
                                     + pando_propose
                                     + pando_peers
                                     + pando_status
                                     + pando_create_project
                                     + pando_test_run
                                     + ...etc

  Network: NONE                      Network: P2P             DIFFERENT
                                     (via tools)
```

pando-code doesn't import @pando/node. It just has extra tools registered. That's the ENTIRE difference.

### 5.4 Governance Security Pipeline (6 layers + AI review)

```
Proposal arrives (diff + description)
  |
  v
Layer 1: Ed25519 signature check              DETERMINISTIC (pando-node)
Layer 2: Security file check                   DETERMINISTIC (pando-node)
Layer 3: Diff content scan (dangerous patterns) DETERMINISTIC (pando-node)
Layer 4: Build verification (npm run build)    DETERMINISTIC (pando-node)
  |
  v
Layer 5: AI REVIEW
  → governance.ts calls adapter.reviewDiff(diff, description)
  → adapter routes to System Engine
  → System Engine analyzes:
     - Architecture violations?
     - Injection risks (eval, dynamic require)?
     - Data leaks (credentials, private keys)?
     - Logic errors?
  → Returns: { safe: boolean, risks: string[], recommendation: string }
  → governance.ts uses this as INPUT (not final word — governance decides)
  |
  v
Layer 6: Kernel protection delay (60s for kernel/ changes)
  |
  v
DECISION: APPROVE or REJECT
  → logged to governance_audit table
  → if approved: broadcast via GossipSub
  → all nodes: git pull → build → restart
```

**Auto-approve** when <=8 peers (dev mode). All logged to `governance_audit` table.

### 5.5 Multi-Node P2P (nodes without AI)

```
Node A (has pando-code)           Node B (no pando-code)
+--------------------+            +--------------------+
| Infrastructure     |<--- P2P -->| Infrastructure     |
| Engine Adapter     |  TCP+Noise | (no adapter)       |
| System Engine      |            |                    |
| Project Engines    |            | chat_proxy handler |
+--------------------+            +--------------------+

When a user hits Node B's gateway:
1. User → Node B: POST /v1/chat/message
2. Node B has no pando-code
3. Node B discovers Node A via capability profile: [pando-code: yes]
4. Node B forwards via P2P: chat_proxy → Node A
5. Node A's engine adapter processes the request
6. Response flows back: Node A → Node B → User

The user doesn't know which node ran the AI.
Node B is just a proxy. Node A has the brain.
```

### 5.6 Periodic Autonomous Behavior

The node sends periodic "check" messages to the system engine. The engine decides what to do.

```
pando-node (body)                         pando-code (brain)

  setInterval(5 min):
    adapter.send("system",               → System Engine receives
      "Periodic check. Run scheduled       → Decides what's needed:
       tasks if needed.")                    - Nothing? "All clear."
                                             - Time to audit? Spawns explorer sub-agent.
                                             - Time for QA? Spawns tester sub-agent.
                                             - Issue found? Spawns builder to fix.
                                             - Fix ready? Calls pando_propose tool.

  Events also trigger engine calls:
    New chat message    → adapter.send(projectId, message)
    Governance proposal → adapter.reviewDiff(diff)
    Test failure        → adapter.send("system", "Test failed: ...")
    Peer connected      → adapter.send("system", "New peer: X")
```

No tick loop. No orchestrator. No message bus. The engine runs when it has something to do.

### 5.7 The Four Actors (via pando-code sub-agents)

| Actor | How it works | Triggered by |
|---|---|---|
| **System Engine** (CEO) | Main engine instance. Plans, coordinates, delegates. | Chat messages, periodic checks, events |
| **Observer** | Explorer sub-agent spawned by system engine. Read-only. Audits architecture, reports issues. | Periodic check (every 30 min) |
| **QA Tester** | Tester sub-agent spawned by system engine. Runs Playwright tests against gateway. | Periodic check (every 30 min) |
| **Builder** | Builder sub-agent spawned by any engine. Full tools. Writes code, runs builds. | When work is needed |
| **Governance** | Deterministic code in kernel/governance.ts. NOT an AI agent. Calls engine for AI review only. | On proposal arrival |

### 5.8 Pando Login (Agent Identity)

```
Human (Ed25519 keypair in ~/.pando/identity.json)
  | createAgent() → signs AgentCertificate
Agent (own Ed25519 keypair, own peerId = wallet)
  | POST /auth/challenge → nonce
  | sign(nonce, agentPrivateKey) → signature
  | POST /auth/verify → JWT (24h, stateless)
  | X-User-Token: <jwt> → authenticated API access
```

**Trust chain:** `verifySignedActionFull(action, humanPublicKey)` verifies: action signature (agent key) → certificate signature (human key) → expiry check. All offline.

### 5.9 Credential Security (IMMUTABLE LAW)

**The ONLY path for external credentials:**
1. User runs `/contribute <service> <token>` in TUI
2. Node encrypts with AES-256-GCM → stored in MongoDB `pando_credentials`
3. `ResourceRegistry` stores metadata (type + status, NEVER the value)
4. At use time: `ResourceRegistry.getCredential(id)` decrypts from MongoDB

**NEVER:** read from env files, secrets/, CLI args. NEVER log, print, output credential values. NEVER store in docs, code, comments, agent reports.

---

## 6. THE ENGINE ADAPTER (detailed spec)

The engine adapter is `core/engine-adapter.ts`. It is the ONLY file in pando-node that imports @pando-code/core. ~200 lines.

### Class Interface

```typescript
class EngineAdapter {
  // Engine management
  private systemEngine: PandoCode | null;
  private projectEngines: Map<string, PandoCode>;
  private engineLastUsed: Map<string, number>;

  // Lifecycle
  async start(config: AdapterConfig): Promise<void>
  async stop(): Promise<void>

  // Message routing
  async send(message: string, projectId?: string): AsyncGenerator<Event>
  async getOrCreateProjectEngine(projectId: string): PandoCode

  // Governance hook
  async reviewDiff(diff: string, description: string): Promise<ReviewResult>

  // Management
  getActiveEngines(): EngineInfo[]
  evictIdle(): void  // TTL cleanup (30 min for project engines)
}
```

### Pando Tools (registered on each engine)

These tools call the node's own HTTP API. The engine doesn't import pando-node.

| Tool | What it does | HTTP call |
|---|---|---|
| `pando_status` | Node health, peers, uptime | GET /v1/status |
| `pando_peers` | List connected P2P peers | GET /v1/peers |
| `pando_capabilities` | Network capabilities | GET /v1/network/capabilities |
| `pando_balance` | Check Lux balance | GET /v1/ledger/balance |
| `pando_transfer` | Send Lux to peer | POST /v1/ledger/transfer |
| `pando_deploy` | Deploy a project | POST /v1/projects/:id/deploy |
| `pando_undeploy` | Remove deployment | POST /v1/projects/:id/undeploy |
| `pando_create_project` | Create a new project | POST /v1/projects |
| `pando_list_projects` | List all projects | GET /v1/projects |
| `pando_governance_propose` | Create upgrade proposal | POST /v1/governance/propose |
| `pando_governance_vote` | Vote on proposal | POST /v1/governance/vote |
| `pando_broadcast` | Send P2P GossipSub message | POST /v1/broadcast |
| `pando_test_run` | Trigger test run | POST /v1/testing/run |
| `pando_test_status` | Get test results | GET /v1/testing/status |

### Lux Budget Provider

```typescript
LuxBudgetProvider {
  currency: 'lux';
  calculateCost(usage: { model, inputTokens, outputTokens }): number;
}
// 100 Lux per $1 USD of compute. Injected into every engine instance.
```

---

## 7. PANDO-CODE UPGRADES NEEDED

These are additions to @pando-code/core (the separate repo). No refactoring — all new code.

### DONE (infrastructure built)

| Feature | File | Lines | Description |
|---|---|---|---|
| **EnginePool** | `pool/engine-pool.ts` | ~230 | Multi-engine management. Lazy creation, TTL eviction, lifecycle hooks (`onAfterCreate`), max limits, concurrent-safe locks. |
| **Scheduler** | `pool/scheduler.ts` | ~200 | Periodic tasks. Named schedules with interval + prompt. Pause/resume/trigger. Sends to engines via pool. |
| **PandoServer** | `server/server.ts` | ~200 | HTTP API + SSE streaming. `POST /api/send`, engine/schedule/health endpoints. Standalone server mode. |

### Nice to Have (future)

| Feature | Description |
|---|---|
| **Structured output** | `engine.query(prompt, { format: 'json' })` for governance review. Alternative: register a `respond_json` tool. |
| **Engine lifecycle events** | `engine.on('idle')`, `engine.on('error')` for adapter management. |
| **Resource limits** | `maxMemoryMB`, `maxConcurrentSubAgents` per engine config. |

### How pando-node uses it

```typescript
import { EnginePool, Scheduler } from "@pando-code/core";

// engine-adapter.ts uses EnginePool directly (not PandoServer)
const pool = new EnginePool({
  defaultModel: "claude-sonnet-4-6",
  maxEngines: 20,
  idleTTLMs: 30 * 60 * 1000,
  onAfterCreate: async (id, engine) => {
    // Register Pando tools (deploy, governance, transfer, etc.)
    // Inject Lux budget provider
  },
});

// Scheduler for periodic autonomous behavior
const scheduler = new Scheduler(pool);
scheduler.register({
  name: "observer-audit",
  engineId: "system",
  intervalMs: 30 * 60 * 1000,
  prompt: "Run architecture audit. Report any issues found.",
  active: true,
});
```

---

## 8. INFRASTRUCTURE

### 8.1 Live Network

| Machine | IP | Role | Features |
|---|---|---|---|
| EC2-1 | 54.82.241.132 | Compute (trusted) | MongoDB, systemd, CREDENTIAL_MASTER_KEY |
| EC2-2 | 34.201.82.126 | Compute (trusted) | MongoDB, systemd, CREDENTIAL_MASTER_KEY |
| LS-1 | 54.145.144.221 | Relay (untrusted) | P2P storage, PM2 |
| LS-2 | 3.237.175.38 | Untrusted | P2P storage, PM2 |
| Windows | 100.87.67.78 | Dev (full mode) | MongoDB, PandoCode, Claude Code, manual |

**Public gateway:** https://gateway-one-mu.vercel.app

### 8.2 How to Build and Run

```bash
# Build all packages (shared → ledger → identity → node → gateway → mcp-server)
npm run build

# Start a node
node packages/node/dist/cli.js --port 4001

# Start gateway
cd packages/gateway && PANDO_NODE_URL=http://localhost:4000 npx next dev --port 3222

# Run E2E tests (headed Playwright against public gateway)
npx playwright test

# Run per-project tests
npx playwright test --project pando-node
npx playwright test --project pando-code
```

### 8.3 Node CLI Flags

| Flag | Default | Description |
|---|---|---|
| `--port <n>` | random | TCP listen port for P2P |
| `--api-port <n>` | 4000 | HTTP API port |
| `--bootstrap <multiaddr>` | Lightsail | Known peer to connect to |
| `--data-dir <path>` | `~/.pando` | Data directory |
| `--mode <full\|compute\|relay>` | full | Node operational mode |

**Environment variables:**
- `PANDO_STORAGE_URL` — MongoDB connection URL
- `CREDENTIAL_MASTER_KEY` — 256-bit hex key for credential encryption (trusted nodes only)
- `GATEWAY_PUBLIC_URL` — Public gateway URL for deployed apps

---

## 9. MIGRATION: CURRENT STATE → TARGET

### Files to DELETE from pando-node (duplicate brain)

| File | Lines | Why it goes |
|---|---|---|
| `platform/orchestrator.ts` | ~2,200 | pando-code IS the orchestrator |
| `platform/orchestrator-manager.ts` | ~300 | No child process forking needed |
| `platform/orchestrator-process.ts` | ~400 | Same |
| `platform/org-manager.ts` | ~500 | pando-code has sub-agent hierarchy |
| `platform/agent-database.ts` | ~1,265 | pando-code has MemoryStore + Board |
| `platform/template-registry.ts` | ~200 | pando-code has FrameBuilder |
| `platform/agent-tools.ts` | ~374 | Agent routes replaced by engine routes |
| `core/message-bus.ts` | ~400 | pando-code has Board |
| `core/worker-pool.ts` | ~500 | pando-code spawns its own sub-agents |
| `core/ai-backend-pandocode.ts` | ~245 | No wrapper — engine used directly |
| `core/ai-backend-registry.ts` | ~100 | No registry — adapter manages engines |
| `core/ai-backend.ts` | ~50 | No interface needed |
| `core/engine-bridge.ts` | ~300 | Replaced by engine-adapter.ts |
| **TOTAL** | **~6,834** | |

### Files to CREATE

| File | Lines | What it does |
|---|---|---|
| `core/engine-adapter.ts` | ~200 | The ONE pando-code integration point (see Section 6) |

### Migration Steps

1. **Create engine-adapter.ts** — works alongside existing system
2. **Rewire chat API** — `/v1/chat/message` routes through adapter
3. **Remove brain from index.ts** — stop creating orchestrators, message bus, agent database
4. **Delete brain files** — all files listed above
5. **Fix imports** — chase down every broken reference
6. **Fix build** — `npm run build` zero errors
7. **Update tests** — agent routes removed, engine routes added
8. **Add governance AI review** — hook adapter.reviewDiff() into Layer 5

---

## 10. TECHNICAL DEBT (honest status)

### Active Migration

| Issue | Status | Description |
|---|---|---|
| **Dual coordination system** | IN PROGRESS | pando-node has its own brain (orchestrator, message bus, agent database). Being replaced by engine adapter. See Section 9 for migration plan. |

### Stubs

| Issue | Location | Problem |
|---|---|---|
| **Private/offline mode** | Various | Ollama provider exists in pando-code but not wired. SQLite fallback unclear. |
| **Governance fork resolution** | Designed only | 5-step resolution protocol, zero code. No conflict detection. |
| **Distributed tracing** | Designed only | traceId, correlation IDs — designed but not built. |

### Acceptable Trade-offs

| Issue | Why it's OK |
|---|---|
| index.ts is a monolith (4,388 lines) | It works. Decompose after engine adapter migration. |
| Agent identity is ephemeral | Ephemeral agents are sufficient for dev mode. |
| Governance auto-approves (<=8 peers) | Dev mode only. Real voting kicks in with more peers. |

---

## 11. KEY FILES REFERENCE

### Entry Points
| File | Purpose |
|---|---|
| `index.ts` | PandoNode class. Boot sequence, P2P, governance, shutdown. |
| `cli.ts` | Non-interactive entry. Supervisor, crash guard, port check. |
| `tui.ts` | Interactive terminal. 30+ slash commands. |

### Kernel (Layer 0)
| File | Purpose |
|---|---|
| `kernel/network.ts` | libp2p: TCP, Noise, Yamux, GossipSub, Circuit Relay, KadDHT |
| `kernel/governance.ts` | 6-layer security pipeline + AI review hook |
| `kernel/sync.ts` | Ledger P2P sync via GossipSub |
| `kernel/monitor.ts` | Health polling, alerting |
| `kernel/guardrails.ts` | 4-tier rate limiting |
| `kernel/security-monitor.ts` | 5 threat detectors |
| `kernel/reputation.ts` | Performance scoring, weighted votes |
| `kernel/emission-witness.ts` | Witness-based Lux minting |

### Core (Layer 1)
| File | Purpose |
|---|---|
| `core/engine-adapter.ts` | THE integration point. Multi-engine, routing, Pando tools, Lux budget. |
| `core/credential-store.ts` | AES-256-GCM encrypt/decrypt |
| `core/storage-backend.ts` | MongoDB or P2P proxy |
| `core/upgrade-protocol.ts` | Git pull + build + restart + broadcast |
| `core/gateway-deploy-pool.ts` | Multi-account gateway deployment |
| `core/payment-gate.ts` | Lux escrow |

### Platform (Layer 2)
| File | Purpose |
|---|---|
| `platform/capability-detector.ts` | Auto-detect capabilities |
| `platform/resource-marketplace.ts` | Resource discovery + pricing |
| `platform/content-registry.ts` | Content management |
| `platform/thread-store.ts` | Chat persistence (MongoDB) |

### API
| File | Purpose |
|---|---|
| `api/api-server.ts` | Fastify server setup |
| `api/kernel-api.ts` | Status, peers, capabilities, governance routes |
| `api/core-api.ts` | Tasks, upgrade, credentials routes |
| `api/platform-api.ts` | Projects, auth, chat, engine routes |
| `api/testing-api.ts` | Testing dashboard routes (11 endpoints) |

---

## 12. RULES

### Sprint Rules
1. No legacy code protection. Delete if it's in the way. We have git.
2. Fresh start. Make the right decision, then update docs to match.
3. Build must pass. `npm run build` zero errors before any commit.
4. Let things break. Fix during testing. No compatibility shims.

### Import Boundaries (enforced)
- kernel → only kernel + @pando/*
- core → kernel + @pando/*
- platform → core + kernel + @pando/*
- api → platform + core + kernel + @pando/*
- Never upward.

### Token Economics
| Parameter | Value |
|---|---|
| Hard cap | 10,000,000,000 Lux |
| Relay fee | 0.1% per transfer |
| Daily cap | 500 Lux max per node per day |
| Exchange rate | 100 Lux per $1 USD (engine adapter) |

---

## 13. WHAT A MINIMAL NODE NEEDS

**Essential (node won't function without):**
- Ed25519 identity (keypair)
- SQLite ledger
- P2P networking (libp2p)
- HTTP API (Fastify)
- Governance (security pipeline)

**Required for AI features:**
- Engine adapter + @pando-code/core
- That's it. One file. One dependency.

**Optional (graceful degradation if missing):**
- MongoDB (falls back to P2P storage proxy)
- CredentialStore (only on compute nodes with CREDENTIAL_MASTER_KEY)
- GatewayDeployPool (only if hosting tokens contributed)
- ResourceMarketplace (operational, not critical path)
- SecurityMonitor, ReputationManager (enhance but don't block)

---

## 14. THINGS THAT WILL CONFUSE YOU

1. **Pando tools are just HTTP calls to localhost.** The engine calls `pando_deploy` which does `POST http://localhost:4000/v1/projects/:id/deploy`. The engine doesn't import pando-node. The tools are the entire integration layer.

2. **Each project gets its own engine instance.** The adapter manages `Map<projectId, PandoCode>`. Engines don't know about each other. They communicate only through Pando tools (which call the shared HTTP API).

3. **The system engine manages the node itself.** It's just another pando-code engine with Pando tools. It gets periodic "check for work" messages and decides what to do. It can spawn sub-agents (observer, QA, builder) using pando-code's native sub-agent system.

4. **Governance is NOT an AI agent.** It's deterministic code in kernel/governance.ts. It only calls the AI (via adapter.reviewDiff) for Layer 5 smart analysis. The 6-layer pipeline is deterministic code, not an LLM.

5. **`X-User-Token` vs `Authorization: Bearer`.** Two different auth systems. Bearer = operator (node admin). X-User-Token = user/agent JWT (Pando Login). Both can be present. Agent JWT takes precedence.

6. **RESTART_EXIT_CODE = 75.** When stale code detected (git HEAD moved), node exits with 75. Supervisor restarts and picks up new code.

7. **Triple-broadcast on peer connect.** Capability profiles broadcast 3 times (immediate + 10s + 30s) because GossipSub mesh formation is slow.

8. **`createRequire` in testing-api.ts.** @pando/tests is CJS, node is ESM. `createRequire(import.meta.url)` bridges this. Not a bug.

9. **Standalone pando-code is identical to pando-node's engines.** The only difference is: inside pando-node, engines get Pando tools registered and Lux budget instead of USD. The engine code is the same.

10. **No process isolation needed.** The old orchestrator needed child processes because the tick loop blocked the event loop. `engine.send()` is async and non-blocking. All engines run in the main process (or a single worker thread if memory is a concern).
