# THE PANDO BIBLE

> Single source of truth for all Pando architecture. All other docs defer to this.
> Last updated: 2026-03-06 (distributed compute model implemented + tested). Maintainer: Claude Code (CEO agent).

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

engine-adapter.ts = THE NERVOUS SYSTEM (~280 lines)
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
**Lines:** 60K+ TypeScript | **Status:** DONE as standalone. Network integration infra built (EnginePool, Scheduler, PandoServer). Claude Code CLI integration pending.

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
**Status:** Working. Brain-kill migration complete (9,414 lines removed). Distributed compute model implemented and tested (both paths working end-to-end).

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
| **CrashGuard** | `kernel/crash-guard.ts` | DONE | Crash loop detection + circuit breaker |

### 4.2 Core Layer (services + engine adapter)

| Component | File | Status | What it does |
|---|---|---|---|
| **EngineAdapter** | `core/engine-adapter.ts` | DONE | The ONE pando-code integration point. PandoCode contributor nodes only. Multi-engine, routing, Pando tools, Lux budget. |
| **CredentialStore** | `core/credential-store.ts` | DONE | AES-256-GCM encrypt/decrypt. Secure compute nodes (EC2) only. |
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
| `pando/deploy-app` | Any with hosting | Deploy project to hosting provider. |
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

**Key routing principle:** The receiving node does NOT assume it will process the build. It always finds the best PandoCode peer (which may be itself). This is critical because the public gateway connects to a random node — that node is a router, not necessarily a builder.

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

Trusted infrastructure. Stores network-level contributed credentials.

- Has MongoDB + CredentialStore + CREDENTIAL_MASTER_KEY
- Stores contributed API keys (encrypted AES-256-GCM)
- Handles Path A (simple AI): decrypts contributed key → makes LLM call → returns response
- Could run PandoCode for builds if installed (not currently — EC2 nodes are secure-only)
- Proxy: decrypts credentials for other node types on P2P request (code_repository only)
- Proxy: P2P storage backend for non-MongoDB nodes (thread store, project store, etc.)

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

### 5.7 The Four Actors (PandoCode contributor nodes only)

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

The engine adapter is `core/engine-adapter.ts`. It is the ONLY file in pando-node that imports @pando-code/core. ~280 lines. It only exists on **PandoCode contributor nodes** and **full dev nodes**.

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
- `API_AUTH_DISABLED=true` — Dev mode: bypasses API token auth AND JWT verification for chat endpoints

---

## 9. BRAIN-KILL MIGRATION (COMPLETED 2026-03-06)

**9,414 lines deleted. 15 brain files removed. 280 lines of engine-adapter.ts replaced everything.**

The dual coordination system is dead. pando-node no longer has any intelligence of its own. All AI flows through EngineAdapter → @pando-code/core.

### What was deleted
orchestrator.ts (2,529), agent-database.ts (1,265), worker-pool.ts (1,081), template-registry.ts (476), org-manager.ts (377), agent-tools.ts (373), orchestrator-manager.ts (333), engine-bridge.ts (283), worker-mcp.ts (274), orchestrator-process.ts (248), ai-backend-pandocode.ts (244), message-bus.ts (143), ai-backend-registry.ts (43), ai-backend.ts (37), context-api.ts (336).

### What replaced it
`core/engine-adapter.ts` (~280 lines) — uses EnginePool from @pando-code/core. Creates system engine at boot, project engines on demand. Registers 14 Pando tools. Injects Lux budget. Evicts idle engines at 30min TTL.

### API changes
- **Removed:** `/v1/council/*`, `/v1/bridge/*`, `/v1/agents/*`, `/v1/context/*`
- **Added:** `/v1/engines`, `/v1/engines/schedules`
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
| **Path B end-to-end** | Full pipeline | TESTED LIVE — "build me a hello world website" → doorman classifies (P2P to EC2) → project created → PandoCode engine (gemini-2.5-flash) builds → page.tsx created. Full pipeline works. |

### Needs Work

| Issue | Location | Problem |
|---|---|---|
| **Unified build routing** | `api/platform-api.ts` | Build requests should ALWAYS find best PandoCode peer (including self). Current code has split logic: local engine vs P2P fallback. Needs unification into single "find peer → route" flow. |
| **Claude Code CLI integration** | `@pando-code/core` | Not built yet. PandoCode needs a tool/subprocess to invoke `claude -p` for coding tasks. This would let contributors use their Claude Code subscription instead of a raw API key. |
| **Contributor limits/earning** | Not built | Contributors need to set max requests/day, budget caps. Earning model (Lux per job) not implemented. |
| **Node mode CLI flag** | `cli.ts` | Still uses old `--mode full|compute|relay`. Needs updating to `contributor|secure|lightweight|full` to match four node types. |

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

11. **Keys don't travel. Work travels.** Contributed API keys stay on EC2 (Path A — simple AI). PandoCode contributor keys stay on their machine (Path B — builds). The network routes WORK to where the keys are, never the other way around. `injectApiKeys()` loads: (1) PandoCode's `.env` file, (2) local env vars, (3) CredentialStore fallback (EC2 only). It does NOT pull keys over P2P.

12. **Two kinds of "contribute."** `/contribute openai sk-xxx` donates a key to the network (encrypted on EC2, used server-side for Path A). Running PandoCode on your node contributes your COMPUTE (your local keys, your machine, you earn Lux for builds).
