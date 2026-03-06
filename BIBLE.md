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

## 2. THE FOUR PACKAGES

Pando is four independent packages composed by a fifth (the node).

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
shared ← ledger ← node
                ← identity (standalone, no shared dep)
                ← code (standalone, no shared dep)
                ← tests (standalone, no shared dep)
```

**The brain/body split:**
- **@pando-code/core** = the brain. ALL intelligence, task management, memory, sub-agents, tools.
- **@pando/node** = the body. P2P networking, identity, economy, governance, storage, HTTP API.
- **engine-bridge.ts** = the nervous system. Injects identity, economy, and custom tools into the brain.

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

### 3.2 @pando-code/core (COMPLETE)

**Location:** Separate repo at `pando/code/`
**Lines:** 60K+ TypeScript | **Status:** DONE, standalone product

The AI coding engine. Multi-provider (Anthropic, OpenAI, Google, Ollama). Multi-agent orchestration. Persistent memory. AST-based code intelligence.

**What it provides:**
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

### 3.5 @pando/node (THE COMPOSER)

**Location:** `packages/node/` in pando/node monorepo
**Lines:** ~15,000+ | **Status:** Working but has architectural debt

The node composes all packages and adds: P2P networking, governance, storage, HTTP API, agent orchestration.

**Source layout (3-layer architecture):**
```
kernel/    Layer 0: P2P core (network, sync, governance, guardrails, monitor, security, reputation, emission)
core/      Layer 1: Agent system, storage, deploy, credentials, upgrade, payment
platform/  Layer 2: Orchestrator, resources, content, chat, projects, hosting
api/       HTTP API (kernel-api, core-api, platform-api, testing-api, server, middleware/)
(root)     Entry points: index.ts, cli.ts, tui.ts, logger.ts, config.ts
```

**Import boundary rule (enforced):** kernel → only kernel + @pando/*. core → kernel + @pando/*. platform → core + kernel + @pando/*. Never upward.

**Three node modes:**
- `full` — everything (dev machines with PandoCode available)
- `compute` — no agent system (EC2 nodes without AI)
- `relay` — P2P only (lightweight relay nodes)

Detailed component breakdown in Section 4.

### 3.6 @pando/gateway

**Location:** `packages/gateway/` in pando/node monorepo
**Stack:** Next.js 16 + Tailwind
**Status:** DONE (34 pages verified, all loading)

Reads from @pando/node HTTP API. No direct database access.
**Public deployment:** https://gateway-one-mu.vercel.app

---

## 4. NODE COMPONENTS (detailed)

### 4.1 Kernel Layer (infrastructure — KEEP ALL)

| Component | File | Status | What it does |
|---|---|---|---|
| **PandoNetwork** | `kernel/network.ts` | DONE | libp2p: TCP, Noise, Yamux, GossipSub, Circuit Relay, KadDHT |
| **LedgerSync** | `kernel/sync.ts` | DONE | P2P ledger synchronization via GossipSub |
| **Governance** | `kernel/governance.ts` | DONE | 6-layer security pipeline (see 5.5) |
| **HealthMonitor** | `kernel/monitor.ts` | DONE | System health polling + alerts |
| **Guardrails** | `kernel/guardrails.ts` | DONE | 4-tier rate limiting + anomaly detection |
| **SecurityMonitor** | `kernel/security-monitor.ts` | DONE | 5 detectors: DDoS, Sybil, spam, anomaly, resource abuse |
| **ReputationManager** | `kernel/reputation.ts` | DONE | Performance tracking + weighted governance votes |
| **EmissionWitness** | `kernel/emission-witness.ts` | DONE | Witness-based Lux emission |
| **CrashGuard** | `kernel/crash-guard.ts` | DONE | Crash loop detection + circuit breaker |

### 4.2 Core Layer (services)

| Component | File | Status | What it does |
|---|---|---|---|
| **PandoCodeBackend** | `core/ai-backend-pandocode.ts` | DONE | Wraps @pando-code/core engine. Singleton. Per-project engine caching. |
| **AIBackendRegistry** | `core/ai-backend-registry.ts` | DONE | Registry pattern. PandoCode is the ONLY backend. |
| **EngineBridge** | `core/engine-bridge.ts` | DONE | Injects LuxBudgetProvider + 10 custom Pando tools into engines |
| **WorkerPool** | `core/worker-pool.ts` | DONE | Spawns fresh PandoCode engine instances per task. ~500 token boot prompt. Memory watchdog. |
| **MessageBus** | `core/message-bus.ts` | DONE | SQLite-backed message routing. Sender validation. |
| **CredentialStore** | `core/credential-store.ts` | DONE | AES-256-GCM encrypt/decrypt. Compute nodes only. |
| **StorageBackend** | `core/storage-backend.ts` | DONE | MongoDB direct or P2P proxy to compute nodes |
| **UpgradeProtocol** | `core/upgrade-protocol.ts` | DONE | Git pull + build + restart. GossipSub broadcast. |
| **GatewayDeployPool** | `core/gateway-deploy-pool.ts` | DONE | Deploy gateway to all contributed hosting accounts |
| **PaymentGate** | `core/payment-gate.ts` | DONE | Lux escrow for task execution |
| **RequestReply** | `core/request-reply.ts` | DONE | P2P unicast calls (TCP + GossipSub fallback) |

### 4.3 Platform Layer (orchestration)

| Component | File | Status | What it does |
|---|---|---|---|
| **Orchestrator** | `platform/orchestrator.ts` | DONE | Deterministic tick loop. Tier 1 (no AI) or Tier 2 (PandoCode). Session-persistent. |
| **OrchestratorProcessManager** | `platform/orchestrator-manager.ts` | DONE | Forks system orchestrators into child processes |
| **orchestrator-process** | `platform/orchestrator-process.ts` | DONE | Child process entry point. Own DB, MessageBus, AI registry. |
| **OrgManager** | `platform/org-manager.ts` | DONE | Orchestrator hierarchy. Create/dissolve. Authority narrowing. Max depth 5. |
| **AgentDatabase** | `platform/agent-database.ts` | DONE | SQLite: agent_identity, message_inbox, tick_log, lessons, directives, reflections, discoveries, governance_audit, qa_test_runs. WAL mode. |
| **TemplateRegistry** | `platform/template-registry.ts` | DONE | Role templates (builder, tester, reviewer prompts) |
| **CapabilityDetector** | `platform/capability-detector.ts` | DONE | Auto-detect: PandoCode, storage, compute, hosting |
| **ResourceMarketplace** | `platform/resource-marketplace.ts` | STUB | GossipSub price broadcasting. Prices never actually synced. |
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
| Agents | `/v1/agents/*` | Spawn, message, report, tree |
| Chat | `/v1/chat/*` | Message to orchestrator, history |
| Projects | `/v1/projects/*` | Create, deploy, undeploy |
| Context | `/v1/context/*` | Project context, lessons, team, identity, discoveries |
| Auth | `/v1/auth/*` | Challenge, verify (Pando Login), me, refresh |
| Testing | `/v1/testing/*` | Status, runs, findings, scenarios, playbooks, specs, stats |
| Gateways | `/v1/gateways` | All known live gateway deployments |
| Capabilities | `/v1/capabilities` | Node capability profile |

---

## 5. HOW THINGS WORK (composition)

### 5.1 Agent System — The Self-Sustaining Loop

```
1. User request → HTTP API → MessageBus → Orchestrator inbox
2. Orchestrator tick (60s) → classify Tier 1 or Tier 2
3. Tier 2 → session-persistent PandoCode AI call
4. AI returns action array (spawn_worker, commit_code, respond_to_user, etc.)
5. WorkerPool spawns fresh PandoCode engine in project root
6. Worker reads/writes code, runs build, reports via HTTP (3000-char + git diff)
7. Next tick → AI reads report (remembers context), decides next step
8. PASS → git commit + propose_upgrade (10 Lux stake)
9. Governance 6-layer check → auto-approve (dev mode, <=8 peers)
10. Broadcast via GossipSub → all nodes: git pull → build → restart
```

**Idle ticks = zero cost.** When inbox empty, tick is Tier 1 (deterministic, no AI call).

### 5.2 Orchestrator Tick Loop

The Orchestrator class (`platform/orchestrator.ts`) runs at every hierarchy level: council, observer, QA agent, project orchestrators. Same code, different roles.

**Each tick:**
1. Health guard (skip first 120s, skip if heap > 500MB)
2. `readBoard()` — fetch pending tasks, workers, inbox messages, directives
3. `classify()` — Tier 1 if idle/healthy, Tier 2 if inbox has items or directives pending
4. Tier 1: `deterministic(board)` — health checks, deploy URL broadcast, directive ack
5. Tier 2: `callAI(board)` — session-persistent PandoCode call. Boot prompt on first tick, short board-state update on subsequent ticks.
6. Execute returned actions
7. Log tick, mark messages read

**Session rotation:** Every ~200 ticks to keep context fresh. Lessons survive rotation.

### 5.3 Process Isolation (Phase 200)

System orchestrators run in separate child processes. Main process handles only infrastructure.

```
Main Process (PID 1)                  Child Processes
├── HTTP API (Fastify)                ├── Council (PID 2) — CEO brain, 60s tick
├── P2P Network (libp2p)             ├── Observer (PID 3) — architecture audit, 30min tick
├── WorkerPool (spawn/kill)           └── QA Agent (PID 4) — UX testing, 30min tick
├── Governance (deterministic)
├── OrchestratorProcessManager        IPC Protocol:
│   └── Handles IPC from children     Child → Parent: spawn_worker, commit_code, push_event
└── SQLite (WAL mode)                 Parent → Child: start, stop, peer_count, action_result
```

Each child creates own AgentDatabase, MessageBus, AIBackendRegistry (WAL mode allows concurrent access).

### 5.4 Pando Login (Agent Identity)

```
Human (Ed25519 keypair in ~/.pando/identity.json)
  ↓ createAgent() → signs AgentCertificate
Agent (own Ed25519 keypair, own peerId = wallet)
  ↓ POST /auth/challenge → nonce
  ↓ sign(nonce, agentPrivateKey) → signature
  ↓ POST /auth/verify → JWT (24h, stateless)
  ↓ X-User-Token: <jwt> → authenticated API access
```

**Trust chain verification:** `verifySignedActionFull(action, humanPublicKey)` verifies: action signature (agent key) → certificate signature (human key) → expiry check. All offline.

### 5.5 Governance Security Pipeline (6 layers)

1. **Ed25519 signature verification** — upgrade proposals MUST be signed by proposer's key
2. **Security file check** — blocks proposals modifying sensitive files unless description mentions 'security'
3. **Diff content scan** — parses git diff for dangerous patterns: `eval(`, `new Function(` → block; `.privateKey`, dynamic `require()` → warn
4. **Build verification** — `npm run build` must pass
5. **Scenario tests** — API regression tests must pass
6. **Kernel protection delay** — 60s delay for kernel/ changes

**Auto-approve** when <=8 peers (dev mode). All logged to `governance_audit` table.

### 5.6 Credential Security (IMMUTABLE LAW)

**The ONLY path for external credentials:**
1. User runs `/contribute <service> <token>` in TUI
2. Node encrypts with AES-256-GCM → stored in MongoDB `pando_credentials`
3. `ResourceRegistry` stores metadata (type + status, NEVER the value)
4. At use time: `ResourceRegistry.getCredential(id)` decrypts from MongoDB

**NEVER:** read from env files, secrets/, CLI args. NEVER log, print, output credential values. NEVER store in docs, code, comments, agent reports.

**One exception (documented):** Legacy `VERCEL_DEPLOY_TOKEN` env var auto-migrates to hosting_platform resource on startup with a deprecation warning. This is a migration path, not a pattern to follow.

### 5.7 Worker Lifecycle

**Workers are always fresh.** Each spawn creates a new PandoCode engine session with a ~500 token boot prompt. Workers do NOT resume previous sessions.

Workers query context on demand via HTTP:
- `/v1/context/project` — genome + lessons for current project
- `/v1/context/lessons` — lessons by role and project
- `/v1/context/team` — team member status
- `/v1/context/identity` — agent identity details
- `POST /v1/context/discover` — share a discovery (UPSERT by confidence)

### 5.8 Four-Actor Model

| Actor | Role | Tick | Can write code? |
|---|---|---|---|
| **Council** | CEO — executes, spawns workers, ships code | 60s | Yes (via workers) |
| **Observer** | Watches inward — audits architecture, verifies design | 30min | No. Sends directives to Council. |
| **QA Agent** | Watches outward — tests gateway UI from human perspective | 30min | No. Reports UX issues to Council. |
| **Governance** | Guards — 6-layer security pipeline | On proposal | No. Approves/rejects proposals. |

**Persistent orchestrators** (council, observer, qa-user) are exempt from stale-check dissolution. Only project orchestrators dissolve when idle.

### 5.9 Directives (Cross-Agent Communication)

Directives are the primary mechanism for persistent cross-agent tasks. They survive session rotations, node restarts, and crashes (stored in SQLite).

**Status lifecycle:** `pending` → `acknowledged` → `completed` / `rejected`
- `pending`: New, never seen by AI. Forces Tier 2 tick.
- `acknowledged`: AI has seen it (times_seen incremented). Rides along on natural Tier 2 ticks.
- After 5 ticks without completion → shown as OVERDUE, forces Tier 2.
- Actions: `complete_directive(id, summary)`, `reject_directive(id, reason)`, `create_directive(target, content)`

**Rule:** NEVER use send_message for findings that must be acted on. Use create_directive instead. Messages are fire-and-forget; directives persist.

---

## 6. INFRASTRUCTURE

### 6.1 Live Network

| Machine | IP | Role | Features |
|---|---|---|---|
| EC2-1 | 54.82.241.132 | Compute (trusted) | MongoDB, systemd, CREDENTIAL_MASTER_KEY |
| EC2-2 | 34.201.82.126 | Compute (trusted) | MongoDB, systemd, CREDENTIAL_MASTER_KEY |
| LS-1 | 54.145.144.221 | Relay (untrusted) | P2P storage, PM2 |
| LS-2 | 3.237.175.38 | Untrusted | P2P storage, PM2 |
| Windows | 100.87.67.78 | Dev (full mode) | MongoDB, PandoCode, Claude Code, manual |

**Public gateway:** https://gateway-one-mu.vercel.app

### 6.2 How to Build and Run

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

### 6.3 Node CLI Flags

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

## 7. TECHNICAL DEBT (honest status)

This section is the ground truth for what's broken, stubbed, or missing. Check this FIRST before assuming a feature works.

### BROKEN (code exists, doesn't work correctly)

| Issue | Location | Problem |
|---|---|---|
| **Dual coordination system** | orchestrator.ts + worker-pool.ts vs pando-code board + sub-agents | pando-node built its own task board (MessageBus + directives) AND uses pando-code as a dumb AI backend. Two brains, two boards. pando-code's board, memory, and sub-agent system are ignored by pando-node's orchestrator. |
| **Agent identity ephemeral** | agent-database.ts | Agents are created per session, not persisted to MongoDB. Can't port across nodes. System agents (council, observer, QA) use NODE's key, not their own. IDENTITY-BIBLE documents agents as "first-class citizens" but they're ephemeral. |
| **Memory threshold contradiction** | pando-code: 24h stale detection vs pando-node: 30d cold storage | Two different systems, two different thresholds, no reconciliation. |

### STUB (code exists, incomplete)

| Issue | Location | Problem |
|---|---|---|
| **Resource Marketplace** | `platform/resource-marketplace.ts` | GossipSub price broadcasting is scaffolded. Prices never actually synced across network. `GET /v1/resources/marketplace/find` may not exist. |
| **Private/offline mode** | Various | Documented as [TARGET]. Ollama provider exists in pando-code but not wired into pando-node. SQLite fallback for no-MongoDB unclear. |
| **Lux witness verification** | `kernel/emission-witness.ts` | "Peers must attest work happened before Lux minted" — but HOW a peer verifies work happened is not specified. Incentive to attest honestly not addressed. |

### DESIGNED (no code, only in docs/brainstorms)

| Issue | Location | Problem |
|---|---|---|
| **Governance fork resolution** | Was in PANDO-BIBLE | 5-step resolution protocol fully designed, zero code. Auto-approve for <=8 peers means forks CAN happen. No conflict detection. |
| **Distributed tracing** | Was in PANDO-BIBLE | traceId flowing through system, correlation IDs — designed but not built. Currently FileLogger with no correlation. |
| **@pando/network extraction** | Phase 3 migration plan | Extract network from kernel/ into own package. Not started. |
| **@pando/governance extraction** | Phase 4 migration plan | Extract governance from kernel/. Not started. |
| **index.ts decomposition** | Phase 5 migration plan | 4,388-line god object with 50+ private fields, 200+ methods. Works fine, risky to touch. |

### ACCEPTABLE TRADE-OFFS (known, not worth fixing now)

| Issue | Why it's OK |
|---|---|
| index.ts is a monolith | It works, 204 tests pass. Decompose only when we need to. |
| Agent storage is ephemeral | Ephemeral agents are sufficient for current dev mode. Persistent storage is Phase 8.6. |
| Governance auto-approves (<=8 peers) | Dev mode only. When network grows past 8 peers, real voting kicks in. |
| Smart-router.ts is dead code (349 lines) | Phase 18 heuristic classifier. Delete when doing cleanup. |

---

## 8. THE DUAL SYSTEM PROBLEM (most important debt)

This is the #1 architectural issue. Understanding it prevents you from making wrong decisions.

### What happened
pando-code was built as a standalone AI coding engine with its own Board, sub-agents, memory, and tools. pando-node was built as a network orchestrator with its own MessageBus, WorkerPool, Orchestrator, OrgManager, and AgentDatabase. When they were integrated, pando-node treats pando-code as a dumb text-in/text-out AI backend — completely ignoring pando-code's internal coordination systems.

### The duplication

| Concept | pando-code | pando-node | Should win |
|---|---|---|---|
| Task board | Board (goals, tasks, status) | MessageBus + directives | pando-code (it's the brain) |
| Sub-agents/workers | Sub-agent system (internal) | WorkerPool (spawns whole engines) | pando-code (but needs network awareness) |
| Memory/lessons | Reflection engine + SQLite | Agent database lessons table | pando-code (richer system) |
| Agent coordination | Board view + agent status | OrgManager + MessageBus | Merge: pando-code board + pando-node P2P |
| Identity | None (engine has no identity) | @pando/identity | pando-node (network concept) |
| Economy | BudgetProvider interface | Lux ledger + emissions | pando-node (network concept) |

### Target architecture
pando-code IS the brain. pando-node IS the body. One board, one memory, one agent system. pando-node only provides infrastructure (P2P, identity, economy, governance, storage). engine-bridge.ts grows from "inject budget + tools" to "pando-code runs the show, pando-node provides infrastructure callbacks."

### Migration plan (when we do this)
- **Phase A (non-breaking):** Read from pando-code's board/memory instead of agent database
- **Phase B (medium risk):** Replace orchestrator tick loop with pando-code engine as brain
- **Phase C (high risk):** Replace WorkerPool with pando-code sub-agent spawning
- **Phase D (cleanup):** Delete MessageBus, Agent Database duplication, OrgManager, TemplateRegistry

---

## 9. KEY FILES REFERENCE

### Entry Points
| File | Purpose |
|---|---|
| `index.ts` | PandoNode class — 4,388-line god object. Boot sequence, P2P handlers, governance wiring, agent system, shutdown. |
| `cli.ts` | Non-interactive entry. Supervisor bootstrap, crash guard, port check, MongoDB init, file logging, heartbeat. |
| `tui.ts` | Interactive terminal. 30+ slash commands. |

### Kernel (Layer 0)
| File | Purpose |
|---|---|
| `kernel/network.ts` | libp2p: TCP, Noise, Yamux, GossipSub, Circuit Relay, KadDHT |
| `kernel/governance.ts` | 6-layer security pipeline, proposal lifecycle, voting |
| `kernel/sync.ts` | Ledger P2P sync via GossipSub |
| `kernel/monitor.ts` | Health polling, alerting |
| `kernel/guardrails.ts` | 4-tier rate limiting |
| `kernel/security-monitor.ts` | 5 threat detectors |
| `kernel/reputation.ts` | Performance scoring, weighted votes |
| `kernel/emission-witness.ts` | Witness-based Lux minting |

### Core (Layer 1)
| File | Purpose |
|---|---|
| `core/ai-backend-pandocode.ts` | PandoCode engine wrapper. Per-project caching. |
| `core/ai-backend-registry.ts` | Backend selection (PandoCode only) |
| `core/engine-bridge.ts` | Integration: LuxBudgetProvider + 10 custom Pando tools |
| `core/worker-pool.ts` | Worker spawning, boot prompt, memory watchdog |
| `core/message-bus.ts` | SQLite message routing, sender validation |
| `core/credential-store.ts` | AES-256-GCM encrypt/decrypt |
| `core/storage-backend.ts` | MongoDB or P2P proxy |
| `core/upgrade-protocol.ts` | Git pull + build + restart + broadcast |
| `core/gateway-deploy-pool.ts` | Multi-account gateway deployment |
| `core/payment-gate.ts` | Lux escrow |

### Platform (Layer 2)
| File | Purpose |
|---|---|
| `platform/orchestrator.ts` | Tick loop, Tier 1/2 classification, session-persistent AI |
| `platform/orchestrator-manager.ts` | Fork system orchestrators into child processes |
| `platform/orchestrator-process.ts` | Child process entry, IPC bridge |
| `platform/org-manager.ts` | Hierarchy, authority narrowing, dissolution |
| `platform/agent-database.ts` | All agent SQLite tables (1,265 lines) |
| `platform/template-registry.ts` | Role templates |
| `platform/capability-detector.ts` | Auto-detect capabilities |
| `platform/resource-marketplace.ts` | Price broadcasting (STUB) |

### API
| File | Purpose |
|---|---|
| `api/api-server.ts` | Fastify server setup |
| `api/kernel-api.ts` | Status, peers, capabilities routes |
| `api/core-api.ts` | Tasks, upgrade, capabilities routes |
| `api/platform-api.ts` | Agents, chat, projects, auth routes |
| `api/testing-api.ts` | Testing dashboard routes (11 endpoints) |

---

## 10. RULES

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

### Database Cleanup Timers
- 60s: prune read messages (>7d), expired discoveries
- 10min: prune tick_log (>7d), failed/dissolved workers (>7d), old reflections (>30d), inactive directives (>7d)

### Governance Rate Limiting
- One active proposal per node at a time
- Tests must handle "already have active proposal" gracefully

### Token Economics
| Parameter | Value |
|---|---|
| Hard cap | 10,000,000,000 Lux |
| Relay fee | 0.1% per transfer |
| Daily cap | 500 Lux max per node per day |
| Exchange rate | 100 Lux per $1 USD (engine bridge) |

---

## 11. WHAT A MINIMAL NODE NEEDS

Not every subsystem is required. Here's what's essential vs optional:

**Essential (node won't function without):**
- Ed25519 identity (keypair)
- SQLite ledger
- P2P networking (libp2p)
- HTTP API (Fastify)
- Governance (security pipeline)

**Required for AI features:**
- PandoCode backend + engine bridge
- WorkerPool + Orchestrator
- AgentDatabase + MessageBus

**Optional (graceful degradation if missing):**
- MongoDB (falls back to P2P storage proxy)
- CredentialStore (only on compute nodes with CREDENTIAL_MASTER_KEY)
- GatewayDeployPool (only if hosting tokens contributed)
- ResourceMarketplace (stub anyway)
- SecurityMonitor, ReputationManager (enhance but don't block)
- Observer, QA Agent (monitoring, not core function)

---

## 12. THINGS THAT WILL CONFUSE YOU

These are patterns that look wrong but are intentional, or look right but are broken.

1. **PandoCodeBackend caches engines per project path.** If you see `Map<string, any>` in ai-backend-pandocode.ts, that's the engine cache. Each project gets one engine instance, reused across ticks. This is correct — it enables session persistence.

2. **The orchestrator builds a "BoardState" from MessageBus.** This looks like it should use pando-code's Board, but it doesn't. It reads from SQLite message_inbox and directives tables. This is the dual-system problem (Section 8).

3. **Workers report via HTTP, not via the engine.** When a worker finishes, it POSTs to `/v1/agents/:id/report`. The orchestrator reads this from MessageBus next tick. This indirection exists because workers run in separate processes.

4. **Three different "lesson" systems exist.** pando-code's memory (append-only lessons), pando-node's AgentDatabase lessons table, and pando-node's org_knowledge table. They don't talk to each other.

5. **`X-User-Token` vs `Authorization: Bearer`.** Two different auth systems. Bearer = operator (node admin). X-User-Token = user/agent JWT (Pando Login). Both can be present on the same request. Agent JWT takes precedence for identity resolution.

6. **Persistent vs non-persistent orchestrators.** Council, observer, qa-user are `persistent: true` — exempt from stale-check dissolution. Project orchestrators dissolve after 3 min idle. The persistence flag is checked in both the stale-check loop AND the OOM prevention loop.

7. **RESTART_EXIT_CODE = 75.** When an orchestrator detects stale code (git HEAD moved), it exits with code 75. The supervisor sees this and restarts the node, picking up new code.

8. **Auto-propose after commit.** `commit_code` action automatically triggers `propose_upgrade` in the same tick. This prevents governance gaps where committed code sits unproposed.

9. **Triple-broadcast on peer connect.** Capability profiles are broadcast 3 times (immediate + 10s + 30s) because GossipSub mesh formation is slow. Without this, new peers don't discover capabilities.

10. **`createRequire` in testing-api.ts.** The @pando/tests package is CJS but the node is ESM. `createRequire(import.meta.url)` bridges this gap. Not a bug, just the CJS/ESM interop pattern.
