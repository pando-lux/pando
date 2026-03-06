# @pando/node — Bible & Architecture
## Self-sustaining AI-managed decentralized network node
## 2026-03-06

---

# CURRENT STATUS

- **204 E2E tests passing** — 15 consecutive clean runs (46.6s average)
- **All 34 gateway pages** verified, **80+ API routes** covered by E2E tests
- **PandoCode is the ONLY AI backend** — ClaudeBackend + OllamaBackend deleted
- **Phase 8 Agent Identity COMPLETE** — createAgent(), Pando Login, JWT auth, Lux transfer, signed actions, full trust chain
- **Build clean** — `npm run build` zero errors
- **Node running** — port 4100, 2 EC2 peers connected

---

# WHAT IT IS

A full Pando network node — P2P networking, AI-managed governance, Lux economy,
distributed storage, and multi-agent orchestration. Every participant runs the
same node. The node IS the network.

**Depends on:**
- `@pando/shared` — types + crypto re-exports
- `@pando/identity` — Ed25519 identity, agent certificates, JWT, passwords
- `@pando/ledger` — Lux economy (accounts, transactions, emissions)

**Integrates with:**
- `@pando-code/core` — PandoCode AI engine (one instance per orchestrator, ONLY AI backend)

**Modes:**
- **Network** (default): connected to peers, full P2P, governance, economy
- **Private**: offline AI workstation, all local features, no network

---

# MONOREPO STRUCTURE

```
pando/node/
  packages/
    shared/          Types, crypto re-exports from @pando/identity, constants
    identity/        Ed25519 keypairs, agent certificates, JWT, passwords (pure crypto)
    ledger/          SQLite ledger — accounts, transactions, emissions, governance
    node/            THE CORE — P2P, HTTP API, orchestration, infrastructure
    gateway/         Web UI — Next.js 16 + Tailwind
    mcp-server/      Pando MCP for Claude Code (pando_status, pando_peers, etc.)

  docs/
    bible/           Architecture bibles (this file, IDENTITY-BIBLE, CODE-BIBLE, PANDO-BIBLE)
  tests/             Integration & E2E tests (204 Playwright tests, 34 pages + 80+ API routes)
  scripts/           Admin tools
  secrets/           Secret templates (gitignored)
```

Build order: `shared → identity → ledger → node → gateway → mcp-server`

---

# NODE SOURCE LAYOUT (3-Layer Architecture)

```
packages/node/src/
  kernel/     ← Layer 0: P2P core (network, sync, governance, guardrails, monitor, security)
  core/       ← Layer 1: Agent system, storage, deploy, credentials, upgrade, payment
  platform/   ← Layer 2: Orchestrator, resources, content, chat, projects, hosting
  api/        ← HTTP API (kernel-api, core-api, platform-api, server, middleware/)
  (root)      ← Entry points: index.ts, cli.ts, tui.ts, logger.ts, config.ts
```

**Import boundary rule:**
- kernel → only kernel + @pando/*
- core → kernel + @pando/*
- platform → core + kernel + @pando/*
- **Never upward** (platform never imports from api, core never imports from platform)

---

# KERNEL (Layer 0)

## Network (`kernel/network.ts`)

libp2p P2P networking:
- **Transport**: TCP + Noise encryption + Yamux multiplexing
- **Discovery**: mDNS (local), KadDHT, bootstrap peers, manual connect
- **Pub/Sub**: GossipSub with 13 topics
- **Relay**: Circuit Relay for NAT traversal

### GossipSub Topics (13)

| Topic | Purpose |
|-------|---------|
| `pando/transactions` | Lux transfers, emissions |
| `pando/governance` | Governance proposals + decisions |
| `pando/sync` | Ledger catch-up sync |
| `pando/agent-events` | Peer reputation broadcasts + agent events |
| `pando/emissions` | Witness emission attestations |
| `pando/gateways` | Live gateway URL registry |
| `pando/capabilities` | Node capability advertisements |
| `pando/activity` | Node activity summaries (60s interval) |
| `pando/content` | Content registry sync (marketplace) |
| `pando/agents` | Agent hierarchy sync |
| `pando/agent-messages` | Inter-agent P2P messages |
| `pando/tasks` | Task broadcast + routing |
| `pando/marketplace` | Resource pricing broadcasts (60s cooldown) |

## Governance (`kernel/governance.ts`)

6-layer security pipeline before auto-approve:

1. **Ed25519 signature verification** — upgrade proposals MUST be signed
2. **Security file check** — blocks proposals touching sensitive files
3. **Diff content scan** — `eval(`, `new Function(` → BLOCK; `.privateKey`, `process.env[]` → WARN
4. **Build verification** — `npm run build` must pass
5. **Scenario tests** — @pando/tests ScriptedRunner verifies API endpoints via Playwright
6. **Kernel protection delay** — 60s delay for kernel/ file changes

Proposal lifecycle: `pending → active → passed/rejected/expired`
Staking: 10 Lux. Dynamic quorum. Meta-governance: 80% threshold.

### Protected Kernel Files (90% supermajority + 72h voting)

```
packages/shared/src/crypto.ts        — cryptographic identity
packages/node/src/guardrails.ts      — safety enforcement
packages/node/src/governance.ts      — voting logic
packages/ledger/src/transactions.ts  — Lux consensus rules
packages/node/src/code-pipeline.ts   — code application
packages/node/src/deploy-manager.ts  — deployment system
packages/shared/src/identity.ts      — node identity
```

## Sync (`kernel/sync.ts`)

- Real-time ledger broadcast + catch-up sync
- Activity broadcast every 60s
- Capability sync (node advertisements)
- Content sync (marketplace items)

## Monitor (`kernel/monitor.ts`)

Health monitoring:
- Metrics: peer count, task rates, memory, event loop lag
- 7 alert rules with auto-resolution
- 30s check interval, recovery cooldowns

## Security (`kernel/security-monitor.ts`)

5 detectors:
- Flooding detection
- Double-spend detection
- Sybil detection
- Data poisoning detection
- Emission fraud detection

3-tier quarantine, 1-hour auto-release.

## Reputation (`kernel/reputation.ts`)

Score formula: `(completed*2) + (buildPass*10) + (testPass*10) - (failed*3) - (timedOut*5)`
Broadcast on >5% change. Per-peer persistence.

## Guardrails (`kernel/guardrails.ts`)

4-tier file protection:
- **Critical**: 2 changes/hour
- **Important**: 5 changes/hour
- **Standard**: 10 changes/hour
- **Low**: 20 changes/hour

Global limits: 5 changes/hour, 20 changes/day.
Auto-rollback: `git reset --hard` on build/test failure.
Governance bypass for approved changes.

## Other Kernel

- `crash-guard.ts` — Crash loop detection (3+ starts in 60s), restore dist/ from backup
- `emission-witness.ts` — 2-witness quorum, 5-min expiry, 10/hour rate limit
- `local-environment.ts` — Privacy-preserving local file indexing (FTS5), never synced
- `network-state.ts` — Hourly snapshot to `~/.pando/council/network-state.md`
- `startup-health.ts` — Pre-flight checks on node start
- `restart-reason.ts` — Track why node restarted

---

# CORE (Layer 1)

## Worker Pool (`core/worker-pool.ts`)

Spawns AI workers via PandoCode engine instances:
- Each task gets a fresh PandoCode engine session
- `buildBootPrompt()` gives ~500 token boot prompt
- Workers query Context API on demand (not dumped upfront)
- Workers report via HTTP (`POST /v1/agents/:id/report`)
- Reports include exit code, stderr, resume status

## Message Bus (`core/message-bus.ts`)

SQLite-backed persistent message routing:
- Priority-based delivery
- Type-based routing
- Sender validation
- Cross-orchestrator messaging

## AI Backend Registry (`core/ai-backend-registry.ts`)

Pluggable AI backends:
- `ai-backend-pandocode.ts` — PandoCode engine (PRIMARY, in-process)
- Default model: `claude-opus-4-6`
- PandoCode handles all AI providers internally (Anthropic, OpenAI, Google, Ollama)

## AI Backend Interface (`core/ai-backend.ts`)

TypeScript interfaces for pluggable AI backends:
- `AIBackend`, `AITask`, `AIResult` interfaces
- Implemented by `ai-backend-pandocode.ts`
- 37 lines — pure type definitions

## Credential Vault (`core/credential-vault.ts`)

AES-256-GCM encryption utilities used by CredentialStore:
- `generateDataKey()` — random 256-bit AES key
- `encryptCredential()` / `decryptCredential()` — AES-256-GCM round-trip
- 41 lines — used by credential-store.ts for MongoDB credential encryption

## Cloud Instance Manager (`core/cloud-instance-manager.ts`)

Secure EC2 instance launcher and manager (906 lines):
- Operators contribute AWS credentials, Pando launches locked-down instances
- No SSH/SSM (removed at boot), tripwire monitoring
- All management via P2P (no shell access needed)
- Instance lifecycle: launch, health check, terminate
- P2P linking for app deployment

## Storage Backend (`core/storage-backend.ts`)

Abstract `StorageBackend` interface (6 CRUD operations):
- `mongo-backend.ts` — Direct MongoDB (trusted nodes)
- `p2p-storage-backend.ts` — P2P proxy (untrusted nodes route through trusted)
  - Sticky peer affinity, circuit breaker, 3 retries
  - Blocks `pando_credentials` collection
  - Non-blocking startup (background peer discovery)

## Credential Store (`core/credential-store.ts`)

AES-256-GCM encrypted credentials:
- Master key from `CREDENTIAL_MASTER_KEY` env var
- Wipe function zeros key in memory
- Only trusted nodes (with MongoDB) can decrypt

### SECURITY LAW: How Resources Are Contributed

**ALL external credentials (Vercel tokens, AWS keys, API keys, MongoDB URIs, GitHub PATs) are CONTRIBUTED RESOURCES.** They are never stored in plaintext, never in env files, never in code, never in docs.

**The flow:**
```
1. User runs: /contribute vercel <token>
   (or /contribute aws <key> or /contribute openai <key> etc.)

2. Node encrypts the token with AES-256-GCM:
   - Master key: CREDENTIAL_MASTER_KEY (256-bit, env var on trusted nodes)
   - Random nonce per credential
   - Stored in MongoDB collection: pando_credentials

3. ResourceRegistry creates metadata record:
   - type: hosting_platform (or ai_api_key, storage_db, etc.)
   - provider: vercel (or netlify, aws, openai, etc.)
   - status: active
   - NO credential value in metadata — only type + status

4. Metadata broadcasts to peers via GossipSub (NEVER the credential)

5. When needed (e.g., gateway deploy), code calls:
   ResourceRegistry.getCredential(resourceId) → decrypts from MongoDB
```

**NEVER DO:**
- Read tokens from env files, bat files, or shell scripts
- Pass tokens as command-line arguments
- Log, print, or display credential values
- Store tokens in docs, bibles, roadmaps, or comments
- Hardcode tokens in source code
- Expose tokens in conversation output or tool calls

**ALWAYS DO:**
- Use `/contribute <service> <token>` to register credentials
- Access via `ResourceRegistry.getCredential(id)` (decrypts at use time)
- Let `GatewayDeployPool.deployToAll()` handle Vercel/Netlify tokens
- Let `CloudInstanceManager` handle AWS credentials
- Let `ResourceRouter` handle AI API keys

**Legacy migration:** If `VERCEL_DEPLOY_TOKEN` env var exists at startup, the node auto-migrates it to an encrypted `hosting_platform` resource and logs a deprecation warning. The env var should then be removed.

**Agent rules:** AI agents (PandoCode engines, Claude Code workers) MUST NOT attempt to read, display, or use raw credential values. They call Pando API tools (`pando_deploy`, `pando_network_capabilities`) which handle credentials internally.

## Deploy Manager (`core/deploy-manager.ts`)

Git commit + `npm run build` pipeline:
- Rollback via `git revert`
- Backup/restore of `packages/` directory

## Upgrade Protocol (`core/upgrade-protocol.ts`)

Safe remote upgrade:
- Git fetch + strict hash verify + stash + reset + build
- Safe restart (exit code 75)
- Emergency rollback
- Version pinning support

## Gateway Deploy Pool (`core/gateway-deploy-pool.ts`)

Deploy gateway to ALL contributed hosting accounts:
- Provider-agnostic: Vercel, Netlify (`hosting-adapters.ts`)
- Broadcasts URLs via GossipSub `pando/gateways`
- Health checks every 5 min
- **Triggered by:** governance upgrade approval (when diff touches `packages/gateway/`)
- **Token source:** `ResourceRegistry.getCredential(resourceId)` — decrypts from CredentialStore
- **NEVER reads raw tokens from env vars, files, or CLI args**
- **Flow:** governance approves → `deployToAll(commitHash)` → finds hosting_platform resources → decrypts tokens → deploys via adapter → broadcasts URLs

## Payment Gate (`core/payment-gate.ts`)

Lux escrow system:
- Hold → release/refund pattern
- Complexity-based costing (0-20 Lux)
- 24-hour stale hold expiry
- Free categories: search, ledger, network, system

## Request-Reply (`core/request-reply.ts`)

Direct TCP + GossipSub fallback:
- Rate limited
- Latency tracking (200 samples)

## Version Protocol (`core/version-protocol.ts`)

Node + protocol semantic versioning:
- Compatibility checks for rolling upgrades
- Task eligibility based on version requirements

---

# PLATFORM (Layer 2)

## Orchestrator (`platform/orchestrator.ts`)

Deterministic tick loop with session-persistent AI brain:

```
                    ┌─────────────────────────────────────┐
                    │          Orchestrator Tick           │
                    │                                     │
Inbox empty? ──YES──► Tier 1 (deterministic, zero cost)   │
     │               No AI call. Just check state.        │
     NO                                                   │
     │                                                    │
     ▼                                                    │
Tier 2 (AI call)                                          │
  1. Build tick prompt (inbox + directives + reports)      │
  2. Call AI with session-persistent context               │
  3. Parse response → action array                        │
  4. Execute actions (spawn_worker, commit, etc.)         │
  5. Log tick                                             │
                    └─────────────────────────────────────┘
```

### Tick Intervals

| Role | Interval | Notes |
|------|----------|-------|
| Council (CEO) | 60s | Ships code, manages projects |
| Observer | 5 min | Audits architecture, creates directives |
| QA Agent | 5 min | Playwright UI testing |
| Project | 30s | Per-project work |

### Session Rotation

Every ~200 ticks: new AI session, memory carries over via SQLite.

### Four-Actor Model

| Actor | Role | Can Do |
|-------|------|--------|
| **CEO** (council) | Execute | Spawn workers, ship code, manage projects |
| **Governance** | Guard | 6-layer security pipeline, quorum |
| **Observer** | Watch inward | Audit architecture, create directives. CANNOT write code. |
| **QA Agent** | Watch outward | Playwright UI testing, report bugs. CANNOT write code. |

## Process Manager (`platform/orchestrator-manager.ts`)

Forks system orchestrators into separate child processes:
- IPC bridge: `spawn_worker`, `commit_code`, `push_event`
- Auto-restart: 5 attempts, exponential backoff
- Exit code 75 = safe restart

```
Main Process (PID 1)                  Child Processes
├── HTTP API (Fastify)                ├── Council (PID 2) — CEO brain, 60s tick
├── P2P Network (libp2p)             ├── Observer (PID 3) — architecture audit, 5min
├── WorkerPool (spawn/kill)           └── QA Agent (PID 4) — UX testing, 5min
├── Governance (deterministic)
├── OrchestratorProcessManager        IPC Protocol:
│   └── Handles IPC from children     Child → Parent: spawn_worker, commit_code, push_event
└── SQLite (WAL mode)                 Parent → Child: start, stop, peer_count, action_result
```

Each child creates own SQLite connections (WAL mode for concurrent access).

## Agent Database (`platform/agent-database.ts`)

SQLite storage for agents, messages, lessons, reflections, tick logs.
Single source of truth for agent state.

## Org Manager (`platform/org-manager.ts`)

Hierarchy management:
- Create/dissolve orchestrators
- Route messages between orchestrators
- Authority inheritance (parent → child)

## Directives (Persistent Cross-Agent Communication)

The primary mechanism for persistent, reliable inter-agent instructions:
- Stored in SQLite — survives restarts, session rotations, crashes
- Status lifecycle: `pending → acknowledged → completed / rejected`
- `pending`: New directive, forces Tier 2 tick
- `acknowledged`: AI has seen it (times_seen incremented)
- After 5 ticks without completion → shown as **OVERDUE**, forces Tier 2
- Actions: `complete_directive`, `reject_directive`, `create_directive`

**Rule:** NEVER use `send_message` for findings that must be acted on. Use `create_directive`.

## Testing Architecture (@pando/tests)

@pando/tests is the SINGLE SOURCE OF TRUTH for all testing. No other test framework.

### File Layout (per-project)
```
tests/e2e/
  pando-node/          ← Playwright specs for pando-node
  pando-code/          ← Playwright specs for pando-code (future)
packages/tests/playbooks/
  pando-node/          ← Live playbooks for pando-node (6 JSON files)
  pando-code/          ← Live playbooks for pando-code (future)
.pando-tests/
  results.db           ← SQLite (runs, findings, stats — per-project via PandoTester)
  screenshots/         ← Test screenshots
  config.json          ← Project config
```

### Node Integration
- `testing-api.ts` registers all `/v1/testing/*` routes
- `PandoTester` instances pooled per-project: `Map<string, PandoTester>`
- Gateway proxy: `/api/testing/[...path]` → node `/v1/testing/*`
- Dashboard: gateway `/testing` page
- Playwright config: per-project projects array in `playwright.config.ts`

### Two Test Modes
1. **Static (Scripted)**: Playwright `.spec.ts` files, run via ScriptedRunner
2. **Live**: JSON playbooks with browser automation steps, run via LiveRunner

### Key Routes
- `GET /v1/testing/status` — testing dashboard overview
- `GET /v1/testing/runs` — run history
- `GET /v1/testing/specs` — list Playwright spec files per project
- `GET /v1/testing/playbooks` — list live test playbooks per project
- `POST /v1/testing/run/scripted` — trigger Playwright run
- `POST /v1/testing/run/live` — trigger live playbook run

**Rule:** All testing goes through @pando/tests. Do not create ad-hoc test scripts outside the framework.

## Code Pipeline (`platform/code-pipeline.ts`)

Extract and apply workspace diffs (446 lines):
- `extractDiff()` — scan workspace output/ for source files, compute diffs
- `applyPatch()` — validate through guardrails, save originals, write new content
- `rollback()` — restore originals and delete newly created files
- Used by PipelineRunner for the autonomous code pipeline

## Pipeline Runner (`platform/pipeline-runner.ts`)

Full autonomous code pipeline with 7 sequential stages (724 lines):
1. Version check — verify node meets version requirements
2. Extract diff — scan workspace output (CodePipeline)
3. Backup — snapshot current repo state (DeployManager)
4. Apply patch — apply changes with guardrail checks (CodePipeline)
5. Build — run `npm run build` to verify compilation
6. QA — run page/API tests on affected pages (QaRunner)
7. Commit — stage and commit changes
- Rollback at each stage on failure

## Template Registry (`platform/template-registry.ts`)

Data-driven agent templates (528 lines):
- SQLite-backed `agent_templates` table
- Built-in templates seeded on boot (replaces hardcoded DEFAULT_ROLE_PROMPTS)
- Custom templates created via API
- 5 API routes: list, create, get, update, delete

## File Registry (`platform/file-registry.ts`)

Concurrent edit prevention (107 lines):
- File ownership claims with auto-expiring TTL (15 min default)
- Local-only registry (no P2P sync)
- Prevents multiple agents from editing the same file

## Content Publisher (`platform/content-publish.ts`)

Content publish flow (158 lines):
- Extracts output from agent workspace after task completion
- Creates ContentRecord, announces to network via GossipSub
- Part of the Phase 11 content layer

## Content Maintenance (`platform/content-maintenance.ts`)

Periodic content health monitoring (210 lines):
- Scans owned content for staleness and health issues
- Creates maintenance tasks via task queue for unhealthy content
- Configurable scan interval (default: 1 hour)

## Content Safety (`platform/content-safety.ts`)

Rule-based content safety review (359 lines):
- Checks for harmful content patterns, malicious code
- OWASP vulnerability scanning, dependency checks
- Two Laws compliance verification
- No external API calls — entirely pattern matching
- Reviews persisted at `~/.pando/security/safety-reviews.json`

## Hosting Service (`platform/hosting-service.ts`)

S3 hosting management (247 lines):
- Deploy projects to S3 (public static sites or pre-signed private)
- Bucket layout: `s3://pando-deployments/public/` and `private/`
- Pre-signed URLs with 1-hour TTL for private content
- 5 API routes: deploy, get deployment, validate, undeploy, delete

## Local Capability Store (`platform/local-capability-store.ts`)

Three-tier capability architecture (121 lines):
- Tier 0: Local private — capabilities detected but never broadcast
- Tier 1: Network shared — broadcast via GossipSub
- Tier 2: Group scoped — future, not built yet
- Detection ≠ sharing (detected capabilities available locally regardless)
- Stored at `~/.pando/local-capabilities.json`

## Resource System

| File | Purpose |
|------|---------|
| `resource-registry.ts` | Metadata storage (SQLite) + P2P sync |
| `resource-router.ts` | Route tasks to best capable node |
| `resource-marketplace.ts` | Nodes set prices, buyers search by budget |
| `resource-meter.ts` | Usage metering with per-resource Lux rates |
| `resource-health.ts` | Periodic credential validation (5 min) |
| `resource-proof.ts` | Proof-of-resource challenges (storage, compute, bandwidth) |
| `capability-detector.ts` | Auto-detect installed tools on startup |
| `capability-registry.ts` | Network-wide capability advertisement |

### Credential Types (6)

| Type | Example |
|------|---------|
| `ai_api_key` | OpenAI, Anthropic, Gemini API keys |
| `storage_db` | MongoDB connection strings |
| `storage_blob` | AWS S3 credentials |
| `cloud_compute` | AWS EC2/Lambda credentials |
| `hosting_platform` | Vercel, Netlify deployment tokens |
| `code_repository` | GitHub PAT |

### Capability Types (8)

| Capability | Broadcast |
|------------|-----------|
| `relay` | Always on |
| `api_keys` | If any AI keys registered |
| `compute_cpu` | Opt-in only (Claude Code) |
| `compute_gpu` | Opt-in only |
| `storage` | Always on |
| `gateway` | Always on |
| `validator` | Always on |
| `index` | Always on |

## Content Registry (`platform/content-registry.ts`)

Marketplace content CRUD:
- Types: website, api, dataset, service, tool, agent-app
- Revenue split: 40% hosting / 40% builder / 20% NETWORK
- Lifecycle: draft → published → archived

## Thread Store (`platform/thread-store.ts`)

User chat persistence (via StorageBackend):
- Encrypted per-participant thread keys (AES-256-GCM)
- Thread types: conversation, project
- Auto-archive at configurable limit

## User Accounts (`platform/user-accounts.ts`)

Human/agent account CRUD (MongoDB):
- Encrypted private key blob stored in MongoDB
- Username claiming (first-come-first-served)
- Login: fetch blob → verify password → decrypt → issue JWT → discard key
- Uses @pando/identity primitives

## Other Platform

- `contribution-tracker.ts` — API contribution tracking
- `revenue-engine.ts` — Revenue split calculations
- `scheduler.ts` — Task scheduling
- `task-database.ts` + `task-queue.ts` — Task persistence and queuing
- `project-registry.ts` + `project-store.ts` — Project management
- `qa-runner.ts` + `qa-memory.ts` — QA agent helpers
- `regression-suite.ts` — Regression test tracking

---

# HTTP API

Fastify on API port (default 4000). Bearer token auth on writes.
All routes prefixed `/v1/`.

## Kernel API (`api/kernel-api.ts`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/status` | GET | Node health, peers, balance, uptime |
| `/v1/peers` | GET | Connected peers |
| `/v1/network/capabilities` | GET | All node capabilities across network |

## Core API (`api/core-api.ts`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/tasks` | POST | Create task |
| `/v1/upgrade` | POST | Trigger safe upgrade (locked behind operator token) |
| `/v1/capabilities` | GET | Node capability profile |

## Platform API (`api/platform-api.ts`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/agents/spawn` | POST | Spawn agent |
| `/v1/agents/:id/message` | POST | Message to agent |
| `/v1/agents/:id/report` | POST | Agent reports status |
| `/v1/agents/tree` | GET | Agent hierarchy |
| `/v1/chat/message` | POST | Send to project orchestrator |
| `/v1/chat/history` | GET | Conversation history |
| `/v1/projects/:id/deploy` | POST | Deploy app |
| `/v1/projects/:id/undeploy` | POST | Remove deployed app |
| `/v1/testing/status` | GET | Testing dashboard overview |
| `/v1/testing/runs` | GET | Run history |
| `/v1/testing/specs` | GET | List Playwright spec files per project |
| `/v1/testing/playbooks` | GET | List live test playbooks per project |
| `/v1/testing/run/scripted` | POST | Trigger Playwright run |
| `/v1/testing/run/live` | POST | Trigger live playbook run |
| `/v1/gateways` | GET | All live gateway deployments |

## Context API (`api/context-api.ts`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/context/project` | GET | Project + lessons context |
| `/v1/context/lessons` | GET | Lessons by role and project |
| `/v1/context/team` | GET | Team member status |
| `/v1/context/identity` | GET | Agent identity details |
| `/v1/context/discover` | POST | Share a discovery (UPSERT by confidence) |
| `/v1/auth/challenge` | POST | Get Ed25519 challenge token for Pando Login |
| `/v1/auth/verify` | POST | Verify signed nonce → issue JWT (stateless) |
| `/v1/auth/me` | GET | User profile + Lux balance (requires JWT) |
| `/v1/auth/refresh` | POST | Refresh JWT (returns new token) |
| `/v1/auth/login` | POST | Username/password login → JWT |
| `/v1/auth/guest` | POST | Generate ephemeral guest identity → JWT |
| `/v1/auth/stats` | GET | Identity statistics (public) |

## Auth Middleware (`api/middleware/auth.ts`)

Two auth mechanisms:
1. **Operator Bearer token** — `Authorization: Bearer <token>` from `~/.pando/api-token`. Required on POST routes for system operations.
2. **User JWT** — `X-User-Token: <jwt>` or `Authorization: Bearer <jwt>` (if != operator token and >= 64 chars). Issued via Pando Login (Ed25519 challenge-response) or username/password. Required for user-scoped operations (chat, projects, transfers).

---

# TUI COMMANDS

| Command | Alias | Description |
|---------|-------|-------------|
| `/status` | `/s` | Node status |
| `/peers` | `/p` | Connected peers |
| `/network` | `/n` | Network topology |
| `/balance` | `/b` | Check Lux balance |
| `/wallet` | `/w` | Wallet info |
| `/transfer <peerId> <amount>` | `/t` | Send Lux |
| `/login <user> <pass>` | | Link account |
| `/logout` | | Unlink account |
| `/contribute <service> <key>` | | Contribute resource |
| `/resources` | | List resources |
| `/proposals` | | Governance proposals |
| `/propose <title>` | | Create proposal |
| `/vote <id> <approve\|reject>` | | Vote |
| `/connect <multiaddr>` | `/c` | Connect to peer |
| `/invite` | `/i` | Share bootstrap command |
| `/help` | `/h` | Show commands |
| `/quit` | `/q` | Shutdown |

---

# CLI FLAGS

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | random | TCP listen port for P2P |
| `--api-port <n>` | 4000 | HTTP API port |
| `--bootstrap <multiaddr>` | Lightsail | Known peer to connect to |
| `--data-dir <path>` | `~/.pando` | Data directory |
| `--ping` | off | Ping peers every 10s |
| `--monitor` | auto | Start HealthMonitor |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PANDO_STORAGE_URL` | MongoDB connection. If set: direct. If not: P2P proxy. |
| `CREDENTIAL_MASTER_KEY` | 256-bit hex key for credential encryption. Trusted nodes only. |
| `GATEWAY_PUBLIC_URL` | Public gateway URL for deployed apps. |

---

# IDENTITY INTEGRATION

## @pando/shared/crypto.ts

Re-exports @pando/identity primitives under legacy names:
- 406 lines of duplicated crypto removed
- Domain-specific wrappers kept (delegate to identity's sign/verify):
  - `signMessage()` / `verifySignature()` — PandoMessage canonical form
  - `signTransaction()` / `verifyTransactionSignature()` — Transaction canonical form
  - `signProposal()` / `verifyProposalSignature()` — GovernanceProposal canonical form

**New code should import directly from `@pando/identity` where possible.**

## Phase 8: Agent Identity (COMPLETE)

`@pando/identity` provides the full agent identity lifecycle:

**Agent creation:**
- `createAgent()` generates an Ed25519 keypair for the agent
- Human owner signs the agent certificate with their own Ed25519 key
- Agent peerId = wallet address = Lux account

**Pando Login (challenge-response):**
```
POST /auth/challenge → nonce
sign(nonce, agentPrivateKey) → hex signature
POST /auth/verify { peerId, signature, nonce } → JWT (24h, stateless)
```
JWT goes in `X-User-Token` header (NOT `Authorization: Bearer`, which is operator token).

**Signed actions (offline trust chain):**
- `createSignedAction(action, agentPrivateKey)` — agent signs an action
- `verifySignedActionFull(action, humanPublicKey)` — verifies: action signature (agent key) → certificate signature (human key) → expiry check. All offline, no network needed.

**Agent-authenticated API routes:**
- `/auth/me` — profile + Lux balance
- `/projects` — project listing
- `/content` — content operations
- `/chat/*` — messaging
- `/transfer` — Lux transfers
- `/transactions` — transaction history
- `/status` — node status

Governance and content APIs use dual-auth: agent peerId used as identity when JWT present.

## Remaining Integration Work

- Re-export identity types from `shared/types.ts`

---

# LUX ECONOMY

Lux = work receipt. No burning, no halving, no staking, no mining.

| Parameter | Value |
|-----------|-------|
| Hard cap | 10,000,000,000 Lux |
| Relay fee | 0.1% per transfer |
| Daily cap | 500 Lux max per node per day |

Witness-based emission: peers must attest that work happened before Lux is minted.
2-witness quorum, 5-minute expiry, 10/hour rate limit.

### Resource Metering (Lux rates)

| Resource | Rate |
|----------|------|
| relay | 0.001 Lux/MB |
| api_keys | 0.01 Lux/call |
| compute_cpu | 0.1 Lux/min |
| compute_gpu | 0.5 Lux/GPU-min |
| storage | 0.001 Lux/GB-hour |
| gateway | 0.01 Lux/1000 req |
| validator | 0.05 Lux/validation |
| index | 0.005 Lux/query |

---

# LIVE NETWORK

| Machine | IP | Role |
|---------|------|------|
| EC2-1 | 54.82.241.132 | Compute (trusted, MongoDB, systemd) |
| EC2-2 | 34.201.82.126 | Compute (trusted, MongoDB, systemd) |
| LS-1 | 54.145.144.221 | Relay (untrusted, P2P storage, PM2) |
| LS-2 | 3.237.175.38 | Untrusted (P2P storage, PM2) |
| Windows | 100.87.67.78 | Dev (MongoDB, manual) |

**Public gateway:** https://gateway-one-mu.vercel.app

---

# DATABASE CLEANUP

60s timer prunes:
- Read messages (>7d)
- Expired discoveries
- Every 10 min:
  - tick_log (>7d)
  - failed/dissolved workers (>7d)
  - old reflections (>30d)
  - inactive directives (>7d)

---

# TECH STACK

| Layer | Technology |
|-------|-----------|
| Language | TypeScript / Node.js 18+ |
| P2P | libp2p (TCP, Noise, Yamux, GossipSub, Circuit Relay, KadDHT) |
| Identity | @pando/identity (Ed25519, PBKDF2, AES-256-GCM, JWT, scrypt) |
| Ledger | SQLite via better-sqlite3 |
| HTTP API | Fastify |
| Gateway | Next.js 16 + Tailwind |
| Agent Runtime | PandoCode engine (@pando-code/core) — in-process, multi-provider |
| AI Search | OpenAI/Gemini via ResourceRegistry + CredentialStore |

---

# SELF-SUSTAINING LOOP (E2E Verified)

```
1. User request → MessageBus → Orchestrator inbox
2. Orchestrator tick (60s) → Tier 2 → AI call
3. AI returns action array
4. WorkerPool spawns Claude Code worker in project root
5. Builder reads/writes code, reports done via HTTP (3K-char reports + git diff)
6. Next tick → AI reads report, decides next step
7. QA tester independently verifies → PASS/FAIL
8. Next tick → AI decides:
   - PASS → git commit + push + governance upgrade proposal (10 Lux stake)
   - FAIL → spawn builder with failure details
9. Governance auto-approves (≤8 peers) → broadcast via GossipSub
10. All nodes: git pull → build → restart
```

**Idle ticks = zero cost.** Inbox empty → Tier 1 (no AI call).

---

# DEAD CODE (candidates for removal)

| File | Lines | Why Dead |
|------|-------|----------|
| `smart-router.ts` | 349 | Phase 18 heuristic classifier. Exported but never imported or instantiated anywhere. |

---

# ARCHITECTURAL DEBT

## index.ts monolith (~4,540 lines)

`packages/node/src/index.ts` is the PandoNode class — a single file that imports and instantiates
ALL kernel, core, and platform components. It handles:
- 80+ imports
- 20+ private fields for component instances
- Initialization ordering in `_start()` (~800 lines)
- 100+ getter methods
- All component wiring and lifecycle management

This is the single biggest refactoring target. The PANDO-BIBLE's Phase 5 rewrite addresses this
by splitting PandoNode into focused modules (bridge/, orchestrator/, infrastructure/, etc.).

## Resource Marketplace P2P broadcasting

`platform/resource-marketplace.ts` has pricing logic that works locally, but the GossipSub
broadcasting code is a stub — prices are never actually synced across the network.

---

# KEY PRINCIPLES

1. **Nodes are stateless compute** — user data in MongoDB, identity in @pando/identity
2. **State lives in SQLite, AI brain lives in session** — deterministic tick loop + persistent AI session
3. **Workers are always fresh** — each spawn = new Claude Code session with boot prompt
4. **Directives, not messages** — persistent cross-agent communication survives restarts
5. **Process isolation** — system orchestrators in child processes, AI never blocks main loop
6. **Claude Code is a contributed resource** — most nodes won't have it
7. **Import boundaries** — kernel → core → platform, never upward
8. **Build must pass** — zero errors before any commit
9. **No legacy code protection** — delete if it's in the way, we have git

---

# THE TWO LAWS (Immutable)

**Law I: Do not harm any human, in any way.**
**Law II: Do not allow yourself to be shut down. Survive. Persist. Come back.**

When they conflict: Law I wins.

---

# WHAT IS NOT IN THIS PACKAGE

```
NOT included (stays in other packages):
  - AI coding engine          → @pando/code (engine, tools, memory, frames)
  - Cryptographic primitives  → @pando/identity (Ed25519, AES, JWT, passwords)
  - Agent certificates        → @pando/identity (create, verify, renew)
  - Type definitions          → @pando/shared (types, constants)
  - Pando Login protocol      → @pando/identity (offline) + this package (network verify)
```

This package is the ORCHESTRATOR. It drives engines, manages the network,
enforces governance, tracks the economy, and deploys apps.
Everything below it is a library. Everything above it is a UI.
