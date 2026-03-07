# THE PANDO BIBLE

> Single source of truth for all Pando architecture. All other docs defer to this.
> Last updated: 2026-03-07 (deploy pipeline proven E2E + Council/Observer/QA built and live). Maintainer: Claude Code (CEO agent).

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

engine-adapter.ts = THE NERVOUS SYSTEM (~700 lines)
  The ONE file that connects brain to body.
  Creates engine instances. Registers Pando tools. Routes messages. Injects Lux budget.
  Manages Council agents (observer/qa/council) with tool filtering and event-driven wake.
  Pando tools are just HTTP calls to the node's own API — the engine doesn't know the difference.
```

**How the brain sees the body:**
```
The engine has 35+ built-in tools (read_file, write_file, bash, grep, spawn_agent, manage_tasks, MCP tools, etc.)
When inside a pando-node, it gets EXTRA tools:
  pando_deploy       → POST /v1/projects/:id/deploy
  pando_transfer     → POST /v1/ledger/transfer
  pando_propose      → POST /v1/governance/propose
  pando_status       → GET  /v1/status
  pando_peers        → GET  /v1/peers
  ...etc

The engine doesn't import anything from pando-node.
It just has tools that happen to call 127.0.0.1.
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
**Lines:** 60K+ TypeScript | **Status:** DONE as standalone. Network integration infra built (EnginePool, Scheduler, PandoServer). Claude Code CLI integration pending.

The AI coding engine. Multi-provider (Anthropic, OpenAI, Google, Ollama). Multi-agent orchestration. Persistent memory. AST-based code intelligence.

**What it provides TODAY:**
- `PandoCode` class — the engine. Create, send messages, get streaming responses.
- 8-layer frame system (L0 identity → L6 conversation). `FrameBuilder.build()` is the ONLY prompt assembly path.
- Board — SQLite-backed task/discovery tracking. Snapshot injected into every prompt.
- Sub-agents — 4 types: explore (read-only), builder (full tools), tester (read + bash), lead (delegation).
- Memory — append-only lessons + preferences. Post-turn reflection auto-extracts. Scope matching, confidence tracking.
- Knowledge graph — AST-based, 1000+ symbols, 13K+ cross-references.
- 35+ built-in tools — read_file, write_file, edit_file, bash, glob, grep, spawn_agent, manage_tasks, send_message, save_memory, query_memory, MCP tools, etc.
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
**Status:** Working. Brain-kill migration complete (9,414 lines removed). Distributed compute model implemented and tested (both paths working end-to-end). Deploy pipeline proven live — build → GitHub → S3 deploy → marketplace.

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

**Four node types** (see Section 5.5 for full details):
- `contributor` — PandoCode + local API keys. Builds apps, earns Lux. The common case.
- `secure` — EC2 with MongoDB + CredentialStore. Handles contributed keys, simple AI.
- `lightweight` — P2P, ledger, governance only. Routes AI work to peers.
- `full` — Contributor + local MongoDB. Full self-sufficiency (dev machines).

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
| **CrashGuard** | `kernel/crash-guard.ts` | DONE | Crash loop detection + circuit breaker. Port conflict exits use code 78 (supervisor won't respawn). Circuit breaker resets on successful boot. Thresholds: 6 crashes/60s (guard), 5 consecutive (breaker). |

### 4.2 Core Layer (services + engine adapter)

| Component | File | Status | What it does |
|---|---|---|---|
| **EngineAdapter** | `core/engine-adapter.ts` | DONE | The ONE pando-code integration point. PandoCode contributor nodes only. Multi-engine, routing, Pando tools, Lux budget. |
| **DeployPipeline** | `core/deploy-pipeline.ts` | DONE | Auto-triggers after build: GitHub push → find EC2 secure node → P2P deploy → update metadata. |
| **CredentialStore** | `core/credential-store.ts` | DONE | AES-256-GCM encrypt/decrypt. Secure compute nodes (EC2) only. |
| **StorageBackend** | `core/storage-backend.ts` | DONE | MongoDB direct or P2P proxy to compute nodes |
| **UpgradeProtocol** | `core/upgrade-protocol.ts` | DONE | Git pull + build + restart. GossipSub broadcast. |
| **GatewayDeployPool** | `core/gateway-deploy-pool.ts` | DONE | Deploy gateway to all contributed hosting accounts |
| **PaymentGate** | `core/payment-gate.ts` | DONE | Lux escrow for task execution |
| **FindingsStore** | `core/findings-store.ts` | DONE | In-memory findings table. CRUD + onCreated callback for event-driven council wake. |
| **CouncilPrompts** | `core/council-prompts.ts` | DONE | System prompts + TOOL_SETS for observer/qa/council agents. Step-by-step tool-calling instructions tuned for Gemini Flash. |
| **RequestReply** | `core/request-reply.ts` | DONE | P2P unicast calls (TCP + GossipSub fallback) |
| **HostingAdapters** | `core/hosting-adapters.ts` | DONE | Provider-agnostic deployment (Vercel, Netlify) |

### 4.3 Platform Layer (non-brain services)

| Component | File | Status | What it does |
|---|---|---|---|
| **CapabilityDetector** | `platform/capability-detector.ts` | DONE | Auto-detect: PandoCode, storage, compute, hosting |
| **ResourceMarketplace** | `platform/resource-marketplace.ts` | DONE | GossipSub price broadcasting, resource discovery, metering |
| **ContentRegistry** | `platform/content-registry.ts` | DONE | Content management |
| **ThreadStore** | `platform/thread-store.ts` | DONE | Chat thread persistence. Non-blocking writes (local cache immediate, P2P storage async). Requires MongoDB (EC2) or P2P proxy for persistence. |

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
| Chat | `/v1/chat/*` | Message → doorman → Path A (EC2 proxy) or Path B (PandoCode). |
| Engines | `/v1/engines/*` | List active engines, board snapshots, memory |
| Projects | `/v1/projects/*` | Create, deploy, undeploy |
| Auth | `/v1/auth/*` | Challenge, verify (Pando Login), me, refresh |
| Testing | `/v1/testing/*` | Status, runs, findings, scenarios, playbooks, specs, stats |
| Findings | `/v1/findings/*` | Create, list, update, summary. Council communication channel. |
| Council | `/v1/council/*` | Status (health overview), trigger/:agent (manual agent run) |
| Gateways | `/v1/gateways` | All known live gateway deployments |
| Capabilities | `/v1/capabilities` | Node capability profile |
| Admin | `/v1/admin/shutdown` | Graceful shutdown (exit 0) |

**P2P request-reply handlers** (node-to-node, not HTTP):
| Handler | Where it runs | What it does |
|---|---|---|
| `pando/doorman-classify` | EC2 (secure) | Classify chat intent via contributed OpenAI key. Returns `{intent, response/description}`. |
| `pando/doorman-chat` | EC2 (secure) | Multi-turn chat via contributed OpenAI key. Returns `{reply}`. |
| `pando/ai-query` | EC2 (secure) | General AI query via contributed key. Returns `{answer, sources, confidence}`. |
| `pando/get-credential` | EC2 (secure) | Decrypt a credential (code_repository only). Returns raw credential. |
| `pando/deploy-app` | EC2 (secure) | Clone from GitHub, auto-detect tier, deploy to S3 (Tier 1) or PM2+nginx (Tier 2). Requires `credentialAccess` for S3 creds. |
| `pando/storage-proxy` | EC2 (secure) | Proxy MongoDB CRUD for non-MongoDB nodes. |
| `pando/upgrade-node` | Any | Trigger git pull + build + restart. |
| `chat_proxy` | PandoCode nodes | Forward chat message for engine processing. |

---

## 5. HOW THINGS WORK

### 5.1 Two Compute Paths — How Work Flows Through the Network

The network has **two distinct compute paths**. Keys never travel. Work travels to the compute.

#### Path A: Simple AI (chat, questions, doorman classification)

No PandoCode involved. Uses contributed API keys on secure proxy nodes (EC2).

```
User asks: "What is machine learning?"
  |
  v
POST /v1/chat/message → any node receives it
  |
  v
Doorman classifies intent:
  1. Regex fast-path (zero cost): /status, /balance, /help → instant response
  2. Local OpenAI key available (contributor node)? → classify locally
  3. No local key → route to EC2 proxy via P2P → EC2 decrypts contributed key → classifies
  4. No peers available → fallback keyword matching
  |
  v
Intent = "question" → answer via same path (local key or EC2 proxy)
  → Keys never leave their origin (local env or EC2)
  |
  v
Response returned to user
```

**Contributed API keys** (via `/contribute openai sk-xxx`) are encrypted and stored in MongoDB on EC2. Used server-side on EC2 for simple LLM calls. The contributor doesn't need to run a node.

**Local API keys** (contributor node with OPENAI_API_KEY in env) can handle Path A locally — no EC2 needed. This is the common case for contributor nodes that have both PandoCode and an OpenAI key.

#### Path B: Build (PandoCode — full app construction)

```
User says: "Build me a bakery website"
  |
  v
POST /v1/chat/message → any node receives it (via gateway or direct)
  |
  v
Doorman classifies: intent = "build"
  → Project metadata created and saved on network
  |
  v
Node finds best PandoCode peer on the network:
  → Query capability registry for peers with pando-code: true
  → Could be SELF (if this node has PandoCode) or a REMOTE peer
  → Route build job to that peer
  → If NO PandoCode peers available → degrade gracefully
  |
  v
PandoCode peer processes the build:
  → Engine Adapter creates Project Engine for this projectId
  → Project Engine plans on its Board: "Goal: Build bakery website"
  → Spawns builder sub-agent → writes HTML/CSS/JS
  → Code committed to GitHub (checkpoint — enables transfer if node goes down)
  → Spawns tester sub-agent → tests locally
  → Uses pando_deploy tool → deploys to hosting
  |
  v
PandoCode uses contributor's configured provider:
  a) API-based agents (default: Google/Gemini, or OpenAI, Anthropic, Ollama)
  b) Claude Code CLI as subprocess (FUTURE — not built yet, see Section 7)
  |
  v
SSE streams progress back → to user
  |
  v
User sees: "Your bakery website is live at https://..."
```

**Key routing principle:** The receiving node does NOT assume it will process the build. It calls `findBestBuilder()` which queries the capability registry for all PandoCode peers (including self). If self has a local engine, it processes locally; otherwise it routes to the best remote peer via `routeChatProxyP2P()`. This is critical because the public gateway connects to a random node — that node is a router, not necessarily a builder. The legacy `hasClaudeCodeAuth()` check (Anthropic-only) has been removed — routing is now fully provider-agnostic.

**PandoCode contributor's keys stay LOCAL.** They never leave the contributor's machine. The network routes work TO the compute, not keys FROM storage.

**Build resilience:** Code is committed to GitHub during build. If the PandoCode node goes offline mid-build, another node clones from GitHub and continues.

**Subsequent messages** with `projectId` route directly to that project's engine on the PandoCode node that owns it.

#### Standalone PandoCode (direct, not through the network)

```
Developer opens PandoCode directly on their machine
  → Builds app locally (their keys, their machine)
  → When ready: submits project to Pando ecosystem
  → Governance review (live mode — all 6 layers)
  → If approved: project published on the network
  → Other nodes can discover, deploy, fork it
```

This is a separate entry point. Not through the gateway. Developer uses PandoCode as a product, then optionally publishes to the network.

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
- `POST /v1/chat/message { projectId: "proj-abc" }` → route to the PandoCode peer that owns this project's engine
- `POST /v1/chat/message { no projectId }` → Doorman classifies → Path A (EC2 proxy for questions) or Path B (create project + find best PandoCode peer to build)

### 5.3 Standalone pando-code vs Inside pando-node

```
STANDALONE pando-code              PANDO-NODE pando-code
(any dev, any project)             (inside the network)

  35+ built-in tools                 35+ built-in tools       IDENTICAL
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

**Two entry points for building:**
- **Through the network:** User → Gateway → any node → find PandoCode peer → build. The network orchestrates.
- **Standalone:** Developer runs PandoCode directly → builds locally → submits to Pando ecosystem via governance.

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

**Layer 5 (AI review) only runs on PandoCode contributor nodes** (they have an engine to review with). On lightweight/secure nodes without PandoCode, Layer 5 is skipped (fail-open). Layers 1-4 and 6 are deterministic and run everywhere.

**Auto-approve** when <=8 peers (dev mode). All logged to `governance_audit` table.

### 5.5 Distributed Compute — Four Node Types

```
+─────────────────────────────────────────────────────────────────────+
│                        THE PANDO NETWORK                            │
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐           │
│  │ PandoCode    │   │ EC2 Secure   │   │ Lightweight  │           │
│  │ Contributor  │   │ Compute      │   │ Node         │           │
│  │              │   │              │   │              │           │
│  │ - PandoCode  │   │ - MongoDB    │   │ - P2P only   │           │
│  │ - Local keys │   │ - Cred Store │   │ - Ledger     │           │
│  │ - Claude Code│   │ - Contrib'd  │   │ - Relay      │           │
│  │ - Earns Lux  │   │   API keys   │   │ - Relay fees │           │
│  │              │   │ - Earns Lux  │   │              │           │
│  │ BUILDS APPS  │   │ SIMPLE AI    │   │ ROUTES ONLY  │           │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘           │
│         │                  │                   │                    │
│         └──────── P2P (TCP + Noise) ───────────┘                   │
+─────────────────────────────────────────────────────────────────────+
```

#### Type 1: PandoCode Contributor Node (the common case)

A regular user with PandoCode installed. The backbone of network intelligence.

- Has PandoCode + Engine Adapter
- Has their OWN API keys locally (PandoCode `.env` or env vars — default: Google/Gemini)
- Keys **NEVER leave** the machine — work comes TO them
- Advertises capability: `pando-code: true` in capability profile
- Network routes build jobs to them via P2P
- Can set limits: max requests/day, budget caps, model preferences (NOT YET BUILT)
- Earns Lux per job completed (EARNING MODEL NOT YET BUILT)
- Future: Claude Code CLI as subprocess for superior coding (NOT YET BUILT)

```
Build request arrives via P2P (routed by any node that received user's message)
  → Engine Adapter creates project engine
  → PandoCode builds using LOCAL keys (contributor's configured provider)
  → Code committed to GitHub (checkpoint)
  → Deployed via pando_deploy tool
  → Earns Lux based on compute cost
```

#### Type 2: Secure Compute Node (EC2)

Trusted infrastructure. Stores network-level contributed credentials. **Deploys apps.**

- Has MongoDB + CredentialStore + CREDENTIAL_MASTER_KEY
- Stores contributed API keys (encrypted AES-256-GCM)
- Handles Path A (simple AI): decrypts contributed key → makes LLM call → returns response
- **Handles deployment** (`pando/deploy-app`): clones from GitHub, deploys to S3 (Tier 1) or PM2+nginx (Tier 2)
- Could run PandoCode for builds if installed (not currently — EC2 nodes are secure-only)
- Proxy: decrypts credentials for other node types on P2P request (code_repository only)
- Proxy: P2P storage backend for non-MongoDB nodes (thread store, project store, etc.)

**Capability profile broadcasts:** `credentialAccess: true`, `storageBackend: 'mongodb'`. These are the fields the deploy pipeline uses to find deploy targets — NOT `shareCompute`/`compute_cpu` (those identify PandoCode builders).

#### Type 3: Lightweight Node

Minimal participant. P2P, ledger, governance. No AI compute.

- Routes AI work to peers who have PandoCode or secure compute
- Earns relay fees (0.1% of transfers)
- Participates in governance voting
- Contributes to P2P mesh health

#### Type 4: Full Dev Node (Type 1 + local MongoDB)

Developer's machine. PandoCode + local MongoDB for full self-sufficiency.

```
Routing priority for AI work:
1. Path A (questions): local OpenAI key → CredentialStore → EC2 proxy via P2P
2. Path B (builds): find best PandoCode peer on network (could be self) → route via P2P
3. No capable peers available → degrade gracefully (canned doorman response)
```

### 5.6 Periodic Autonomous Behavior (PandoCode contributor nodes only)

On nodes with PandoCode, the Scheduler sends periodic "check" messages to the system engine. The engine decides what to do. Lightweight and secure-only nodes don't have engines and skip this entirely.

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

### 5.7 The Actors (PandoCode contributor nodes only)

**Per-project actors** (user projects):

| Actor | How it works | Triggered by |
|---|---|---|
| **Project Engine** | Per-project engine instance. Handles chat, builds, deploys. | Chat messages, events |
| **Builder** | Builder sub-agent spawned by project engine. Full tools. Writes code, runs builds. | When work is needed |
| **Governance** | Deterministic code in kernel/governance.ts. NOT an AI agent. Calls engine for AI review only. | On proposal arrival |

**System actors** (ecosystem maintenance — see Section 5.10 for full design):

| Actor | How it works | Triggered by |
|---|---|---|
| **Council** | Long-running engine. Reads findings, spawns sub-agents to fix issues, submits through governance. CEO of the ecosystem. | Scheduler tick (every 15 min) |
| **Observer** | Long-running engine. Read-only. Monitors network health, peer status, deploy health. Creates findings. | Scheduler tick (every 30 min) |
| **QA** | Long-running engine. Runs Playwright tests, API health checks. Creates findings from failures. | Scheduler tick (every 30 min, offset 15 min) |

### 5.8 Deploy Pipeline (build → github → deploy → marketplace) — PROVEN E2E

The full lifecycle of a network-built project. **Tested live 2026-03-06.** PandoCode builds. Secure nodes deploy. Keys never travel.

```
PandoCode Contributor Node              EC2 Secure Node
───────────────────────────              ─────────────────
1. Engine builds code in workspace
   ~/.pando/projects/{projectId}/
                │
2. Build complete (sendToEngine stream ends)
                │
3. DeployPipeline auto-triggers (fire-and-forget from platform-api.ts):
                │
   Step 1: GitHub push
      POST /v1/projects/:id/github/push
      └─ git init (if needed)
      └─ git add -A
      └─ git commit "Deploy {ISO timestamp}"
      └─ git push -u origin HEAD:main --force
      └─ GitHub token decrypted via P2P credential proxy to EC2
      └─ Repo created if new: pando-lux/app-{8chars}-{slug}
                │
   Step 2: Find deploy target
      └─ Query CapabilityRegistry.getAllProfiles()
      └─ Filter: credentialAccess === true && storageBackend === 'mongodb'
      └─ This finds EC2 SECURE nodes (NOT PandoCode builders)
      └─ Self-deploy fallback only if local node has credentialAccess
                │
   Step 3: P2P deploy ──────────────────→ Receives pando/deploy-app
                                          │
                                          ├─ git clone {repoUrl} (from GitHub)
                                          │   OR git pull origin main (if re-deploy)
                                          │
                                          ├─ Auto-detect tier from package.json:
                                          │   Tier 2 if: scripts.start, express/fastify/ws deps,
                                          │              server.js/app.js main, backend/ dir
                                          │   Tier 1 otherwise (static HTML/CSS/JS)
                                          │
                                          ├─ Tier 1 (static):
                                          │   Decrypt S3 creds (CREDENTIAL_MASTER_KEY)
                                          │   Inject window.PANDO_GATEWAY_URL into HTML <head>
                                          │   Inject window.PANDO_PROJECT_ID into HTML <head>
                                          │   Upload all static files to S3
                                          │   Key format: public/{projectId}/{relPath}
                                          │   Return S3 website URL
                                          │
                                          └─ Tier 2 (server app):
                                              npm install --production
                                              PM2 start (persistent port registry)
                                              nginx reverse proxy: /apps/{projectId}/ → localhost:{port}
                                              Return http://{PUBLIC_IP}/apps/{projectId}/
                │
   Step 4: Update project metadata
      └─ repoUrl, deploymentUrl, deployPeerId
      └─ deploymentStatus → 'live'
      └─ Persisted to MongoDB via P2P storage proxy
                │
5. Project appears in marketplace (GET /v1/marketplace)
   User sees: "Your app is live at https://..."
```

**PROVEN LIVE (2026-03-06) — BOTH TIERS:**

**Tier 1 (S3 static):** "build me a portfolio website" → PandoCode (Gemini 2.5 Flash) built index.html + style.css → GitHub push → EC2 cloned → Tier 1 detected → S3 upload with gateway vars injected → live at `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/{projectId}/index.html` → marketplace listing with `deploymentStatus: live`.

**Tier 2 (PM2+nginx):** "build me a real-time chat room app with WebSockets" → PandoCode built Express+ws server → GitHub push → EC2 cloned → Tier 2 detected (express+ws deps, scripts.start) → `npm install` (66 modules) → PM2 start on port 3009 → nginx reverse proxy config written → live at `http://34.201.82.126/apps/{projectId}/` → HTTP 200, WebSocket upgrade working through nginx.

**CRITICAL: Builder vs Deployer targeting (the #1 gotcha)**
```
findBestBuilder()      → shareCompute === true && compute_cpu === true   → PandoCode CONTRIBUTOR nodes
stepFindDeployTarget() → credentialAccess === true && storageBackend === 'mongodb'  → EC2 SECURE nodes

These are DIFFERENT node types. Builders BUILD. Deployers DEPLOY. Never confuse them.
```

**Security model:**
- **Credentials (AWS S3, GitHub) ONLY exist on EC2 secure nodes** — decrypted in-memory via `CREDENTIAL_MASTER_KEY`
- **PandoCode contributor nodes NEVER touch deployment credentials** — they only build code
- **GitHub is the handoff point** — PandoCode pushes code to GitHub, EC2 clones from GitHub. No workspace transfer over P2P.
- **EC2 tripwire** — any SSH/SSM/debugger detected → wipe credentials + shutdown immediately

**Workspace directories:**
- Engine workspace: `~/.pando/projects/{projectId}/` (set by platform-api.ts after project creation)
- EC2 deploy workspace: `{dataDir}/hosted-apps/{projectId}/` (cloned from GitHub on the secure node)
- PandoCode database: `.pando-code.db` inside the project workspace

**Timeout chain (production-tuned):**
- P2P credential proxy: 30s (decrypting GitHub token via EC2)
- GitHub repo creation inner call: 45s (includes credential decrypt + GitHub API)
- Deploy pipeline GitHub push: 120s (AbortSignal.timeout)
- P2P deploy request: 300s (5 min — includes git clone + S3 upload or npm install + PM2)

**Marketplace visibility:**
- New projects start with `visibility: 'listed'`
- Marketplace endpoint (`GET /v1/marketplace`) filters out test artifacts via regex:
  `hello world`, `test app`, `untitled`, `my app`, `demo`, `example`, `placeholder`, etc.
- Use a real project name to see it in the marketplace. "hello world" is intentionally filtered.
- 128+ projects visible in marketplace as of 2026-03-06.

**Where deploy code lives (all working):**
| Component | File | What it does |
|---|---|---|
| **DeployPipeline** | `core/deploy-pipeline.ts` | Orchestrator — 4 steps: GitHub push → find EC2 → P2P deploy → update metadata |
| **Trigger** | `api/platform-api.ts` `triggerDeployPipeline()` | Fire-and-forget after every `sendToEngine()` completion (4 call sites) |
| **P2P handler** | `index.ts:1216` handler for `pando/deploy-app` | Clone from GitHub, detect tier, deploy to S3 or PM2+nginx |
| **Tier 1 (S3)** | `index.ts:1303-1408` | S3Client + PutObjectCommand, HTML injection, MIME types |
| **Tier 2 (PM2)** | `index.ts:1410-1473` | npm install, PM2, port registry, nginx config |
| **Port registry** | `{dataDir}/app-ports.json` | Persistent port allocation — survives node restarts |
| **S3 hosting service** | `platform/hosting-service.ts` | Standalone S3 service (pre-signed URLs for private projects) |
| **GitHub push** | `api/platform-api.ts:3417-3499` | git add -A, commit, force push to origin/main |
| **GitHub repo create** | `api/platform-api.ts:3326-3414` | GitHub API — create repo in pando-lux org |
| **Undeploy** | `index.ts:1498-1550` handler for `pando/undeploy-app` | PM2 delete, nginx cleanup, port registry removal |
| **Deploy route** | `api/platform-api.ts` POST /projects/:id/deploy | Manual trigger endpoint |

**S3 bucket:** `pando-deployments` (us-east-1). URL pattern: `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/{projectId}/index.html`

**Contributed S3 credentials format** (via `/contribute storage_blob <json>`):
```json
{ "accessKeyId": "...", "secretAccessKey": "...", "region": "us-east-1", "bucket": "pando-deployments" }
```

### 5.9 PandoCode Network Linking

PandoCode works as a standalone developer tool (like Claude Code). Optionally, it links to the Pando network.

```
STANDALONE MODE (default)                LINKED MODE (network contributor)
─────────────────────────                ─────────────────────────────────
PandoCode is just a dev tool.            PandoCode is a network resource.

- Projects saved wherever you want       - Network workspace: ~/.pando/projects/
- Your keys, your machine                - Node can CREATE projects here
- No P2P, no Lux, no governance          - Each project: ~/.pando/projects/{projectId}/
- Works offline                          - Project metadata from node (visibility, owner)
- No connection to any node              - You earn Lux per build job completed
                                         - API usage limits apply (future)
                                         - Private projects → visible only to owner
                                         - Public projects → marketplace + GitHub
```

**How linking works:**
1. PandoCode setting: `network.linked: true` (in PandoCode config)
2. PandoCode setting: `network.nodeUrl: "http://localhost:4000"` (local node API)
3. When linked, node's Engine Adapter can create project engines
4. Network-created projects go to `~/.pando/projects/{projectId}/`
5. Project metadata (visibility, owner) set by node based on user request
6. When build completes → DeployPipeline triggers (GitHub → deploy → marketplace)

**NOT YET BUILT.** PandoCode currently has no linking setting. Engine Adapter creates engines but doesn't manage a dedicated network workspace. This is the next architecture milestone.

### 5.10 The Council — AI-Managed Ecosystem (BUILT — LIVE)

The Council system makes Pando a **100% AI-maintained ecosystem**. Three specialized PandoCode engine instances — Council, Observer, and QA — run on contributed nodes and continuously maintain, improve, and heal the entire network. No human intervention required for routine operations.

**Core insight:** Council, Observer, and QA are NOT new infrastructure. They are PandoCode engine instances with different system prompts and tool permissions. PandoCode already has everything they need: Board (tasks/goals), Memory (lessons/reflections), Sub-agents (explore/builder/tester/lead), Tools, and Scheduler. The legacy orchestrator was 9,414 lines. This design is ~400 lines.

#### 5.10.1 The Three Agents

```
┌──────────────────────────────────────────────────────────────────────┐
│                    HOW THE THREE AGENTS WORK                        │
│                                                                     │
│  Observer Engine                                                    │
│  ├─ Runs every 30 min (scheduler tick) + event-driven wake         │
│  ├─ ONLY pando_* tools: pando_status, pando_peers, pando_balance,  │
│  │   pando_capabilities, pando_list_projects, pando_test_status,   │
│  │   pando_create_finding, pando_list_findings                     │
│  ├─ Inspects: network health, peer count, deploy status            │
│  ├─ Creates FINDINGS (severity: info/warning/critical)             │
│  └─ Never modifies code. Never proposes. Only observes + reports.  │
│                                                                     │
│  QA Engine                                                          │
│  ├─ Runs every 30 min (scheduler tick, offset 15 min from Observer)│
│  ├─ ONLY pando_* tools: same as Observer + pando_test_run          │
│  ├─ Checks API health, peer connectivity, project system           │
│  ├─ Creates FINDINGS from test failures                            │
│  └─ Reports: what failed, expected vs actual, probable cause       │
│                                                                     │
│  Council Engine (the CEO)                                           │
│  ├─ Runs every 15 min (scheduler tick) + event-driven wake         │
│  ├─ ALL pando_* tools (17 total, incl. pando_update_finding)       │
│  ├─ Reads FINDINGS from Observer and QA                            │
│  ├─ Investigates: calls pando_status, pando_peers to verify        │
│  ├─ Resolves: calls pando_update_finding for every open finding    │
│  ├─ Can propose changes through GOVERNANCE (pando_governance_*)    │
│  └─ Event-driven: wakes 3s after any new finding is created        │
│                                                                     │
│  Communication: HTTP API (pando_* tools → 127.0.0.1:apiPort)       │
│  No message bus. No IPC. No shared memory.                          │
│  FindingsStore (in-memory) = the communication channel.             │
└──────────────────────────────────────────────────────────────────────┘
```

#### 5.10.2 Council Scope — ANY Project

The Council is NOT limited to pando-node. It can update ANY project in the ecosystem:

| Target | What Council Does | Example |
|---|---|---|
| **@pando/node** | Fix bugs, add features, optimize | Observer finds memory leak → Council patches |
| **@pando-code/core** | Improve engine, fix tools | QA finds tool failure → Council fixes tool code |
| **@pando/identity** | Security patches, key rotation | Observer detects expired certs → Council patches |
| **@pando/ledger** | Fix accounting bugs | QA finds balance mismatch → Council fixes |
| **@pando/gateway** | UI fixes, new dashboard views | Observer notes missing metrics → Council adds |
| **User projects** | Heal broken deployments | Observer detects 502 → Council redeploys |

**Governance gate:** Every change goes through governance (Section 5.4). Council calls `pando_propose` → 6-layer pipeline → peer vote → approved/rejected. In **dev mode**, proposals auto-approve (no quorum needed). In **production mode**, real peer voting required.

```
Council decides to fix a bug in @pando/node (FUTURE — requires governance integration):
  1. Council reads findings → identifies issue
  2. Council calls pando_governance_propose(description, target_repo)
  3. Governance pipeline:
     Layer 1-4: Deterministic checks ✓
     Layer 5: AI review ✓
     Layer 6: Peer vote (auto-approve in dev mode) ✓
  4. Change merged → upgrade-protocol detects new HEAD → node restarts (exit code 75)

CURRENT REALITY: Council agents ONLY have pando_* tools (built-in tools stripped).
They can create/update findings, check status, and propose changes through governance.
They CANNOT spawn sub-agents (spawn_agent is stripped) or edit files directly.
```

#### 5.10.3 The Findings System

Findings replace the legacy "directives" system (which was ambiguous and had no priority). A finding is a structured observation from Observer or QA that Council acts on.

```typescript
// Findings table schema (in-memory Map, ~130 lines in findings-store.ts)
interface Finding {
  id: string;              // uuid
  source: 'observer' | 'qa' | 'council' | 'user';
  severity: 'info' | 'warning' | 'critical';
  category: 'health' | 'test_failure' | 'security' | 'performance' | 'suggestion';
  title: string;           // "Memory usage exceeds 80% on EC2-1"
  detail: string;          // Full diagnostic text
  target?: string;         // Which project/component affected
  status: 'open' | 'in_progress' | 'resolved' | 'wont_fix';
  createdAt: number;
  resolvedAt?: number;
  resolvedBy?: string;     // Which engine resolved it
  actionTaken?: string;    // "Patched worker-pool.ts, PR #47"
}
```

**API endpoints** (~50 lines in core-api.ts or a new findings-api.ts):
```
POST   /v1/findings          — Create a finding (Observer/QA call this)
GET    /v1/findings           — List findings (Council reads this)
PATCH  /v1/findings/:id       — Update status (Council marks resolved)
GET    /v1/findings/summary   — Counts by severity/status (dashboard)
```

**Pando tools** for engines (~30 lines in agent-tools.ts):
```
pando_create_finding  → POST /v1/findings       (Observer/QA use this)
pando_list_findings   → GET  /v1/findings        (Council reads this)
pando_update_finding  → PATCH /v1/findings/:id   (Council resolves this)
```

#### 5.10.4 System Prompts (the only "special" code)

Each agent is a PandoCode engine with a different system prompt. The prompt defines personality, scope, and behavior. ~40 lines each. **Source of truth: `core/council-prompts.ts`.**

**IMPORTANT:** Prompts use explicit step-by-step tool call instructions (STEP 1, STEP 2, etc.) because Gemini Flash needs direct action commands, not narrative descriptions. Each prompt starts with "IMPORTANT: You MUST call tools. Do not just describe what you would do."

**Observer prompt** (read-only, diagnostic):
- Calls: pando_status → pando_peers → pando_list_findings(observer) → analyzes → pando_create_finding if issues found
- Rules: no duplicates, no info findings for healthy state, read-only

**QA prompt** (test runner, diagnostic):
- Calls: pando_status → pando_peers → pando_list_projects → pando_list_findings(qa) → pando_create_finding for each failure
- Rules: no duplicates, include specific error details, read-only

**Council prompt** (CEO, finding resolver):
- Calls: pando_list_findings(open) → pando_list_findings(in_progress) → for each: pando_status/pando_peers to verify → pando_update_finding (resolved/wont_fix/in_progress)
- Rules: NEVER leave a finding in "open" after reviewing, every code change through governance
- Critical: Council ONLY has pando_* tools — cannot spawn sub-agents or edit files directly

#### 5.10.5 Engine Lifecycle & Scheduler Wiring

**CRITICAL GOTCHAS (learned the hard way):**

1. **PandoCode's `EngineOptions` does NOT accept `systemPrompt`.** Passing it to `pool.getOrCreate()` is silently ignored. You MUST use `engine.send(msg, { agentOverride: { agentId, role, systemPrompt } })` to inject system prompts per-send. For scheduler ticks (which use `pool.send()` directly), prepend the system prompt into the message string.

2. **PandoCode engines come with 35+ built-in tools** (read_file, edit_file, bash, spawn_agent, manage_tasks, etc.). Council agents MUST have these stripped in `onAfterCreate` — otherwise the model uses `spawn_agent` and `manage_tasks` instead of `pando_*` tools. Strip with: `engine.tools.list().filter(n => !n.startsWith('pando_')).forEach(n => engine.tools.unregister(n))`.

3. **Tool API base URL must be `127.0.0.1`**, not `localhost`. Node.js `fetch()` with `localhost` can fail silently on some platforms.

4. **Event-driven wake uses debounce.** `FindingsStore.onCreated()` fires a 3s debounced callback that sends a message to the council engine via `sendToCouncilAgent()`. This ensures the council responds within seconds of a new finding, not just on 15-min ticks.

```
Node startup (--council flag or auto-detected PandoCode):
  │
  ├─ engine-adapter.ts onAfterCreate hook:
  │   ├─ Strips ALL non-pando_* tools from council agents
  │   ├─ Registers pando_* tools filtered by TOOL_SETS[agentId]
  │   └─ Injects Lux budget provider
  │
  ├─ startCouncilAgents() creates 3 engines:
  │   ├─ engineId: "observer" → 8 pando_* tools (read-only + findings)
  │   ├─ engineId: "qa"       → 9 pando_* tools (+ pando_test_run)
  │   └─ engineId: "council"  → 17 pando_* tools (all, incl. update_finding)
  │
  ├─ Scheduler registers ticks (system prompt prepended to message):
  │   ├─ "observer-tick"  every 30 min
  │   ├─ "qa-tick"        every 30 min (offset by half)
  │   └─ "council-tick"   every 15 min
  │
  ├─ Event-driven wake:
  │   └─ FindingsStore.onCreated() → 3s debounce → sendToCouncilAgent()
  │
  └─ sendToCouncilAgent() uses engine.send() with agentOverride (NOT pool.send)

API endpoints:
  POST /v1/council/trigger/:agent  — manually trigger observer/qa/council
  GET  /v1/council/status          — council health, engines, schedules, findings summary
```

#### 5.10.6 What PandoCode Already Provides vs What We Build

| Capability | PandoCode has it? | Notes |
|---|---|---|
| Engine instances with isolated state | YES | `new PandoCode(config)` — each agent is an instance |
| Board (tasks, goals, priorities) | YES | `engine.board` — Council uses for long-term planning |
| Memory (lessons, reflections) | YES | `engine.memory` — Council learns from outcomes |
| Sub-agents (builder, tester, explorer, lead) | YES | `engine.spawnSubAgent()` — Council delegates work |
| Tool registration | YES | `engine.registerTool(name, fn)` — Pando tools added |
| System prompt customization | YES* | *NOT via EngineOptions — use `agentOverride` on `send()` |
| Session persistence (disk) | YES | Board + memory auto-save between sessions |
| Scheduler (periodic ticks) | YES | `Scheduler.register(name, interval, fn)` with onEvent callback |
| **Findings table + API** | **DONE** | `findings-store.ts` (~130 lines) + 4 REST endpoints in `core-api.ts` |
| **System prompts for 3 agents** | **DONE** | `council-prompts.ts` (~110 lines) + TOOL_SETS |
| **Engine lifecycle in adapter** | **DONE** | `startCouncilAgents()` + `sendToCouncilAgent()` in `engine-adapter.ts` |
| **Scheduler wiring + event wake** | **DONE** | 3 scheduler ticks + FindingsStore.onCreated debounced wake |
| **Built-in tool stripping** | **DONE** | `onAfterCreate` strips non-pando_* tools from council agents |

**Total new code: ~500 lines.** Replaces 9,414 lines of legacy orchestrator. Proven E2E live.

#### 5.10.7 Communication Flow

```
Observer/QA → Findings table → Council → Sub-agents → Governance → Network

Detailed:
  1. Observer runs checks, creates findings via pando_create_finding
  2. QA runs tests, creates findings via pando_create_finding
  3. FindingsStore.onCreated() fires → 3s debounce → sendToCouncilAgent() wakes council
  4. Council reads findings via pando_list_findings (open + in_progress)
  5. Council prioritizes (critical first, then warning)
  6. Council verifies each finding (calls pando_status, pando_peers)
  7. Council resolves via pando_update_finding (resolved/wont_fix/in_progress)
  8. FUTURE: Council calls pando_governance_propose for code changes
  9. FUTURE: Governance pipeline validates (6 layers) → peers vote → merge

No message bus. No IPC. No shared state between agents.
Each agent talks to the HTTP API via Pando tools.
The findings table IS the communication channel.
```

#### 5.10.8 Failure Modes & Recovery

| Failure | Recovery |
|---|---|
| Council host node dies | Governance elects new host. New host clones council state from GitHub (board + memory persisted as project). Resumes. |
| Observer creates too many findings | Council has rate awareness in prompt — batch similar findings, skip info-level if backlog is large |
| Council proposes bad code | Governance Layer 5 (AI review) catches it. If it passes review, QA catches it next cycle. Council learns from the test failure. |
| Council and Observer disagree | They can't — Observer only reports, Council decides. No conflict possible. |
| QA tests flaky | QA prompt says: "If a test has been failing for 3+ cycles, escalate to critical." Council investigates flaky tests as a code issue. |
| All three agents on same node, node overloaded | Stagger ticks (Observer at :00, QA at :15, Council at :30). Only one active at a time. Sub-agents are short-lived. |

#### 5.10.9 Implementation Status

All core steps complete and proven live:

1. **Findings table + API** — DONE. `findings-store.ts` (in-memory Map), 4 REST endpoints, 3 Pando tools
2. **System prompts** — DONE. `council-prompts.ts` with TOOL_SETS, step-by-step tool-calling instructions
3. **Engine lifecycle** — DONE. `startCouncilAgents()` + `sendToCouncilAgent()` with agentOverride
4. **Scheduler wiring** — DONE. 3 ticks with stagger + event-driven wake via FindingsStore.onCreated
5. **Tool-set filtering** — DONE. Built-in tools stripped in onAfterCreate, only pando_* tools remain
6. **E2E tests** — DONE. 7/7 pass (findings CRUD, council status, trigger validation)
7. **Governance integration** — TODO. Council can call pando_governance_propose but not yet tested live
8. **Memory persistence** — TODO. Board + memory persist via PandoCode but not verified across restarts

### 5.11 Pando Login (Agent Identity)

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

### 5.12 Credential Security (IMMUTABLE LAW)

**Two credential models. Both are valid. Keys NEVER travel over the network.**

#### Model A: Contributed Credentials (for the network)

Used by Path A (simple AI). Contributor donates an API key for the network to use.

```
/contribute openai sk-xxx
  → AES-256-GCM encrypt → stored in MongoDB on EC2
  → EC2 decrypts and uses server-side
  → Contributor doesn't need to run a node
  → Key NEVER leaves EC2
```

1. User runs `/contribute <service> <token>` in TUI
2. Encrypted → stored in MongoDB `pando_credentials` on secure compute nodes
3. `ResourceRegistry` stores metadata (type + status, NEVER the value)
4. At use time: EC2 node decrypts locally → makes API call → returns result

#### Model B: Local Credentials (PandoCode contributor)

Used by Path B (builds). Contributor runs PandoCode with their own keys.

```
Contributor's machine:
  PandoCode's .env file (auto-loaded by engine-adapter)
  OR local env vars (GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY)
  OR Claude Code CLI authenticated (FUTURE — not built yet)
  → PandoCode uses local keys directly
  → Keys NEVER leave the machine
  → Work comes TO the contributor via P2P
  → Contributor earns Lux for compute
```

No encryption, no MongoDB, no CredentialStore needed. The keys are in PandoCode's `.env` file or local env vars on the contributor's own machine.

**IMMUTABLE RULES (both models):**
- NEVER transmit raw API keys over P2P
- NEVER log, print, or output credential values
- NEVER store keys in docs, code, comments, agent reports
- Contributed keys: ONLY decrypted and used on EC2 (server-side)
- Local keys: ONLY used by local PandoCode process

---

## 6. THE ENGINE ADAPTER (detailed spec)

The engine adapter is `core/engine-adapter.ts`. It is the ONLY file in pando-node that imports @pando-code/core. ~700 lines (grew from ~280 after council agent lifecycle was added). It only exists on **PandoCode contributor nodes** and **full dev nodes**.

**Key principle:** PandoCode uses its OWN configured provider and model. The engine-adapter does NOT override the model. Contributors choose their provider (default: Google/gemini-2.5-flash).

**API key loading order** (`injectApiKeys()`):
1. Load PandoCode's `.env` file (resolved via `@pando-code/core` package path)
2. Check local env vars (contributor's shell environment)
3. CredentialStore fallback (EC2 nodes with MongoDB only)

```
PandoCode reads: GOOGLE_GENERATIVE_AI_API_KEY  (default provider)
           OR:   ANTHROPIC_API_KEY, OPENAI_API_KEY (alternative providers)
           OR:   Claude Code CLI (future — not built yet)
```

### Class Interface

```typescript
class EngineAdapter {
  // Lifecycle
  async start(config: AdapterConfig): Promise<void>
  async shutdown(): Promise<void>

  // Message routing
  async *send(message: string, projectId?: string): AsyncGenerator<Event>

  // Governance hook
  async reviewDiff(diff: string, description: string): Promise<ReviewResult>

  // Management
  get available(): boolean
  getActiveEngines(): EngineInfo[]
  hasEngine(projectId: string): boolean
  getSchedules(): ScheduleInfo[]
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
| `pando_create_finding` | Create a finding (Observer/QA) | POST /v1/findings |
| `pando_list_findings` | List/filter findings | GET /v1/findings |
| `pando_update_finding` | Update finding status (Council) | PATCH /v1/findings/:id |

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
// PandoCode uses its OWN configured provider/model (contributor's choice)
// API keys from LOCAL env (contributor's own keys)
const pool = new EnginePool({
  // No defaultModel — PandoCode uses config (default: google/gemini-2.5-flash)
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
  name: "periodic-check",
  engineId: "system",
  intervalMs: 30 * 60 * 1000,
  prompt: "Periodic check. Review system health. Spawn sub-agents if needed.",
  active: true,
});
```

### PandoCode + Claude Code CLI (future)

PandoCode can use Claude Code CLI as a subprocess for superior coding:

```
PandoCode receives build request
  → Breaks into tasks on its Board
  → For coding tasks: spawns `claude -p "implement feature X"` as subprocess
  → Claude Code does file editing, testing, git commits
  → PandoCode reviews output, continues orchestration
  → Result: better code quality than API-only agents
```

This makes a contributor's Claude Code subscription a network resource — they earn Lux when Claude Code processes jobs for the network.

---

## 8. INFRASTRUCTURE

### 8.1 Live Network

| Machine | IP | Role | Features |
|---|---|---|---|
| EC2-1 | 54.82.241.132 | Compute (trusted) | MongoDB, systemd, CREDENTIAL_MASTER_KEY |
| EC2-2 | 34.201.82.126 | Compute (trusted) | MongoDB, systemd, CREDENTIAL_MASTER_KEY |
| LS-1 | 54.145.144.221 | Relay (untrusted) | P2P storage, PM2 |
| LS-2 | 3.237.175.38 | Untrusted | P2P storage, PM2 |
| Windows | 100.87.67.78 | Contributor | PandoCode (gemini-2.5-flash), Claude Code, P2P port 4100, API port 4000 |

**Public gateway:** https://gateway-one-mu.vercel.app
**S3 deployments:** `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/{projectId}/index.html`
**GitHub org:** `pando-lux` — repos auto-created as `app-{8chars}-{slug}`

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
| `--mode <full\|compute\|relay>` | full | Node type (LEGACY — needs updating to `contributor\|secure\|lightweight\|full`, see Section 10) |

**Environment variables:**
- `PANDO_STORAGE_URL` — MongoDB connection URL (secure compute nodes only)
- `CREDENTIAL_MASTER_KEY` — 256-bit hex key for credential encryption (secure compute nodes only)
- `GATEWAY_PUBLIC_URL` — Public gateway URL for deployed apps
- `GOOGLE_GENERATIVE_AI_API_KEY` — PandoCode default provider (Google/Gemini). Auto-loaded from PandoCode's `.env`.
- `OPENAI_API_KEY` — For doorman classification (local) or alternative PandoCode provider. Auto-loaded from PandoCode's `.env`.
- `ANTHROPIC_API_KEY` — Alternative PandoCode provider (Anthropic/Claude)
- `PUBLIC_IP` — Public IP address for Tier 2 deployment URLs (EC2 nodes). Used to construct `http://{PUBLIC_IP}/apps/{projectId}/`.
- `API_AUTH_DISABLED=true` — Dev mode: bypasses API token auth AND JWT verification for chat endpoints

---

## 9. BRAIN-KILL MIGRATION (COMPLETED 2026-03-06)

**9,414 lines deleted. 15 brain files removed. engine-adapter.ts replaced everything (started at ~280 lines, now ~700 with council agent lifecycle).**

The dual coordination system is dead. pando-node no longer has any intelligence of its own. All AI flows through EngineAdapter → @pando-code/core.

### What was deleted
orchestrator.ts (2,529), agent-database.ts (1,265), worker-pool.ts (1,081), template-registry.ts (476), org-manager.ts (377), agent-tools.ts (373), orchestrator-manager.ts (333), engine-bridge.ts (283), worker-mcp.ts (274), orchestrator-process.ts (248), ai-backend-pandocode.ts (244), message-bus.ts (143), ai-backend-registry.ts (43), ai-backend.ts (37), context-api.ts (336).

### What replaced it
`core/engine-adapter.ts` (~700 lines) — uses EnginePool from @pando-code/core. Creates system engine at boot, project engines on demand, council agents (observer/qa/council) with tool filtering. Registers 17 Pando tools. Injects Lux budget. Evicts idle engines at 30min TTL.

### API changes
- **Removed:** `/v1/bridge/*`, `/v1/agents/*`, `/v1/context/*`
- **Added:** `/v1/engines`, `/v1/engines/schedules`, `/v1/findings/*`, `/v1/council/status`, `/v1/council/trigger/:agent`
- **Unchanged:** `/v1/chat/message` (same interface, different backend)

---

## 10. TECHNICAL DEBT (honest status)

### Done (Phase 2 progress)

| Issue | Location | Status |
|---|---|---|
| **engine-adapter injectApiKeys** | `core/engine-adapter.ts` | DONE — loads PandoCode's `.env` first, then checks local env, then CredentialStore fallback for EC2. Clear warning if no keys. |
| **Doorman AI classification** | `api/api-server.ts` | DONE — 3-level priority: local OPENAI_API_KEY → CredentialStore → P2P proxy to EC2 peer. |
| **Doorman P2P proxy** | `index.ts` + `api-server.ts` | DONE — `pando/doorman-classify` and `pando/doorman-chat` handlers on EC2. Windows routes to EC2 via requestReply. Tested live: "What is machine learning?" → AI answer via P2P. |
| **PandoCode provider-agnostic** | `core/engine-adapter.ts` | DONE — Adapter no longer forces `claude-sonnet-4-6`. PandoCode uses its own configured provider (default: Google/gemini-2.5-flash). Contributors choose their own provider+model. Gemini pricing added to Lux table. |
| **PandoCode .env auto-load** | `core/engine-adapter.ts` | DONE — Resolves `@pando-code/core` package path, loads `.env` from pando-code repo root. Handles Windows CRLF. Keys available to PandoCode engines without manual env setup. |
| **Thread store non-blocking** | `platform/thread-store.ts` | DONE — `addMessage()` updates local cache immediately, persists to P2P storage backend async. Eliminated 15s+ blocking on storage timeouts per chat message. |
| **Async build routing** | `api/platform-api.ts` | DONE — Build requests return immediately with project+thread ID. PandoCode engine runs in background. Results arrive via SSE + thread store. No more 120s HTTP timeouts. |
| **Dev auth bypass** | `api/api-server.ts` | DONE — `API_AUTH_DISABLED=true` now also bypasses JWT verification for chat endpoints (uses node's peerId as dev identity). |
| **Path B end-to-end** | Full pipeline | TESTED LIVE — "build me a portfolio website" → doorman classifies (P2P to EC2) → project created → PandoCode builds → DeployPipeline → GitHub push → P2P deploy to EC2 → S3 upload → live URL returned → marketplace listing. Full pipeline proven. |
| **Unified build routing** | `api/platform-api.ts` | DONE — `findBestBuilder()` replaces the split `hasClaudeCodeAuth` logic. All 4 build handlers use unified flow: create project → find best PandoCode peer (including self) → route. `hasClaudeCodeAuth()` removed from routing (was Anthropic-only, broken for Gemini). |
| **Circuit breaker fix** | `cli.ts`, `supervisor.ts`, `kernel/` | DONE — Port-conflict exits use code 78 (supervisor won't respawn). Immediate circuit breaker reset on successful boot. Thresholds raised (crash-guard 3→6, circuit-breaker 3→5). |
| **Deploy Pipeline** | `core/deploy-pipeline.ts` | DONE — Targets EC2 secure nodes (`credentialAccess + storageBackend='mongodb'`). GitHub push → P2P `pando/deploy-app` to EC2 → S3 (Tier 1) or PM2+nginx (Tier 2) → update project metadata. Auto-triggers after every build completion. |

### Needs Work

| Issue | Location | Problem |
|---|---|---|
| **PandoCode Network Linking** | PandoCode config | NOT BUILT — Standalone vs linked mode toggle. When linked, node can create projects in PandoCode. See Section 5.9. |
| **Claude Code CLI integration** | `@pando-code/core` | Not built yet. PandoCode needs a tool/subprocess to invoke `claude -p` for coding tasks. This would let contributors use their Claude Code subscription instead of a raw API key. |
| **Contributor limits/earning** | Not built | Contributors need to set max requests/day, budget caps. Earning model (Lux per job) not implemented. |
| **Node mode CLI flag** | `cli.ts` | Still uses old `--mode full|compute|relay`. Needs updating to `contributor|secure|lightweight|full` to match four node types. |
| **S3 upload awaiting** | `index.ts:1400` | S3 PutObjectCommand calls are fire-and-forget with a 2s sleep. Large projects with many files may have incomplete uploads. Need proper `await Promise.all()`. |
| **Tier 2 PM2 persistence** | `index.ts:1410-1473` | PM2 starts the app but may lose track after pando-node restarts (daemon context mismatch). Port registry persists but PM2 process list doesn't auto-reconcile. Consider using `pm2 save` + `pm2 resurrect` on node boot. |
| **Deploy pipeline logging** | `core/deploy-pipeline.ts` | Pipeline errors are fire-and-forget (`.catch(() => {})`). Should persist pipeline results to project metadata for debugging. |
| **deployPeerId not persisting** | `deploy-pipeline.ts` + `project-store.ts` | Code passes `deployPeerId` in step 4 but MongoDB record shows "NOT SET". Likely `updateProject()` filters unknown fields. Need to add `deployPeerId` to the project schema/whitelist. |

### Stubs

| Issue | Location | Problem |
|---|---|---|
| **Private/offline mode** | Various | Ollama provider exists in pando-code but not wired. SQLite fallback unclear. |
| **Governance fork resolution** | Designed only | 5-step resolution protocol, zero code. No conflict detection. |
| **Distributed tracing** | Designed only | traceId, correlation IDs — designed but not built. |

### Acceptable Trade-offs

| Issue | Why it's OK |
|---|---|
| index.ts is a monolith (~3,600 lines) | Shrunk by 783 lines after brain removal. Further decomposition possible but not urgent. |
| Agent identity is ephemeral | Ephemeral agents are sufficient for dev mode. |
| Governance auto-approves (<=8 peers) | Dev mode only. Real voting kicks in with more peers. |

---

## 11. KEY FILES REFERENCE

### Entry Points
| File | Purpose |
|---|---|
| `index.ts` | PandoNode class. Boot sequence, P2P, governance, shutdown. |
| `cli.ts` | Non-interactive entry. Supervisor, crash guard (exit 78 for port conflict), circuit breaker auto-reset on successful boot, port check. |
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
| `core/engine-adapter.ts` | THE integration point. Multi-engine, routing, Pando tools, Lux budget. Council agent lifecycle. ~700 lines. |
| `core/findings-store.ts` | In-memory findings table. CRUD + onCreated callback for event-driven council wake. |
| `core/council-prompts.ts` | System prompts + TOOL_SETS for observer/qa/council. Step-by-step instructions for Gemini Flash. |
| `core/deploy-pipeline.ts` | Build → GitHub → EC2 deploy → metadata. Auto-triggers after sendToEngine(). |
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
| `api/core-api.ts` | Tasks, upgrade, credentials, findings, council routes |
| `api/platform-api.ts` | Projects, auth, chat, engine routes. `findBestBuilder()` for unified PandoCode peer routing. |
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

## 13. WHAT EACH NODE TYPE NEEDS

**Every node (lightweight baseline):**
- Ed25519 identity (keypair)
- SQLite ledger
- P2P networking (libp2p)
- HTTP API (Fastify)
- Governance (security pipeline)

**PandoCode contributor (adds to baseline):**
- @pando-code/core + Engine Adapter (one file, one dependency)
- Local API keys (any provider — PandoCode's `.env` or local env vars. Default: Google/gemini-2.5-flash)
- That's it. Contributor earns Lux for processing build jobs.

**Secure compute / EC2 (adds to baseline):**
- MongoDB (PANDO_STORAGE_URL)
- CredentialStore (CREDENTIAL_MASTER_KEY)
- Handles contributed API keys for Path A (simple AI)

**Full dev node (contributor + secure):**
- Everything above. Full self-sufficiency.

**Optional (graceful degradation if missing):**
- GatewayDeployPool (only if hosting tokens contributed)
- ResourceMarketplace (operational, not critical path)
- SecurityMonitor, ReputationManager (enhance but don't block)

---

## 14. THINGS THAT WILL CONFUSE YOU

1. **Pando tools are just HTTP calls to 127.0.0.1.** The engine calls `pando_deploy` which does `POST http://127.0.0.1:4000/v1/projects/:id/deploy`. The engine doesn't import pando-node. The tools are the entire integration layer. (Must use `127.0.0.1`, not `localhost` — Node.js `fetch()` can fail silently with `localhost` on some platforms.)

2. **Each project gets its own engine instance.** The adapter manages `Map<projectId, PandoCode>`. Engines don't know about each other. They communicate only through Pando tools (which call the shared HTTP API).

3. **The system engine manages the node itself.** It's just another pando-code engine with Pando tools. It gets periodic "check for work" messages and decides what to do. Observer, QA, and Council are SEPARATE engine instances (not sub-agents of system) — each with their own system prompt and filtered tool set, managed by engine-adapter.ts.

4. **Governance is NOT an AI agent.** It's deterministic code in kernel/governance.ts. It only calls the AI (via adapter.reviewDiff) for Layer 5 smart analysis. The 6-layer pipeline is deterministic code, not an LLM.

5. **`X-User-Token` vs `Authorization: Bearer`.** Two different auth systems. Bearer = operator (node admin). X-User-Token = user/agent JWT (Pando Login). Both can be present. Agent JWT takes precedence.

6. **RESTART_EXIT_CODE = 75.** When stale code detected (git HEAD moved), node exits with 75. Supervisor restarts and picks up new code.

7. **Triple-broadcast on peer connect.** Capability profiles broadcast 3 times (immediate + 10s + 30s) because GossipSub mesh formation is slow.

8. **`createRequire` in testing-api.ts.** @pando/tests is CJS, node is ESM. `createRequire(import.meta.url)` bridges this. Not a bug.

9. **Standalone pando-code is identical to pando-node's engines.** The only difference is: inside pando-node, engines get Pando tools registered and Lux budget instead of USD. The engine code is the same.

10. **No process isolation needed.** The old orchestrator needed child processes because the tick loop blocked the event loop. `engine.send()` is async and non-blocking. All engines run in the main process (or a single worker thread if memory is a concern).

11. **Keys don't travel. Work travels.** Contributed API keys stay on EC2 (Path A — simple AI). PandoCode contributor keys stay on their machine (Path B — builds). The network routes WORK to where the keys are, never the other way around. `injectApiKeys()` loads: (1) PandoCode's `.env` file, (2) local env vars, (3) CredentialStore fallback (EC2 only). It does NOT pull keys over P2P.

12. **Two kinds of "contribute."** `/contribute openai sk-xxx` donates a key to the network (encrypted on EC2, used server-side for Path A). Running PandoCode on your node contributes your COMPUTE (your local keys, your machine, you earn Lux for builds).

13. **Builder targeting ≠ Deploy targeting.** `findBestBuilder()` looks for `shareCompute + compute_cpu` (PandoCode contributor nodes). `stepFindDeployTarget()` looks for `credentialAccess + storageBackend='mongodb'` (EC2 secure nodes). These are DIFFERENT node types. If you mix them up, deploys silently fail because PandoCode nodes can't decrypt S3 credentials.

14. **Deploy pipeline errors are silent.** `triggerDeployPipeline()` is fire-and-forget (`.catch(() => {})`). If it fails, the project still has its GitHub repo but `deploymentStatus` stays `none`. Check node logs for `[deploy-pipeline]` prefixed messages.

15. **Marketplace filters test artifacts.** `getMarketplaceAsync()` uses a regex to strip projects named "hello world", "test app", "demo", "example", etc. If your test project doesn't show up in the marketplace, that's why. Use a real project name.

16. **Project workspaces are `~/.pando/projects/{projectId}/`.** Engine adapter creates the directory and passes it as `projectPath` to PandoCode. The engine writes files there. The deploy pipeline reads `workspaceDir` from the project record to know where to git push from. If `workspaceDir` is missing, GitHub push fails with "workspaceDir required".

17. **P2P credential proxy has a timeout chain.** GitHub repo creation requires: P2P credential decrypt (30s timeout) + GitHub API call (45s inner timeout). If EC2 nodes are slow or offline, the credential proxy times out and GitHub operations fail. The timeouts were tuned for production latency on 2026-03-06.

18. **S3 uploads are fire-and-forget with a 2s wait.** The `pando/deploy-app` handler fires S3 PutObjectCommand calls then `await new Promise(r => setTimeout(r, 2000))`. For large projects with many files, some uploads may not complete. This is a known trade-off (see Section 10).
