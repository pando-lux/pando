# THE PANDO BIBLE
## Final Architecture — Version 1.2 (11 additional gaps fixed after deep codebase audit)
## 2026-03-05

This is the definitive architecture document for the entire Pando ecosystem.
All previous brainstorm docs are superseded by this document.
Every decision is final. Every gap is addressed. Build exactly this.

---

# VISION

Pando is three products that work independently and compound together:

1. **@pando/identity** — Decentralized identity and auth for AI agents. Sold standalone.
2. **@pando/code** — AI coding engine (Claude Code alternative). Sold standalone.
3. **@pando/node** — Self-sustaining AI-managed network. Uses both products above.

A developer can buy identity alone ("I want agent auth").
A developer can buy code alone ("I want an AI coding tool").
A developer can run a node and get everything ("I want the full network").

A node can run fully offline — no internet, no peers, no network. It becomes a private AI workstation (like Open WebUI / Ollama). Connect it to the network, and it joins the collective.

---

# THE THREE PRODUCTS

## Product 1: @pando/identity

**Tagline:** "Identity and auth for AI agents."

**What it solves:** No standard exists for AI agent authentication. OAuth is for humans. API keys have no identity. Pando Identity gives agents verifiable, cryptographic identity backed by their owner.

**Standalone value:** Any developer building AI agent systems can use this. No Pando network required.

### Architecture

```
@pando/identity/
  core/
    keypair.ts           Ed25519 keypair generation, loading, persistence
                         Used by nodes, humans, AND agents (same KeyPair type)
    signing.ts           Sign arbitrary payloads, verify signatures
    encryption.ts        AES-256-GCM encrypt/decrypt, PBKDF2 key derivation
    hash.ts              SHA-256 hashing utilities

  identity/
    node-identity.ts     Node: Ed25519 keypair for P2P transport (NOT identity authority)
    agent-profile.ts     Agent: own Ed25519 keypair, certified by human's signature
                         createAgent() generates keypair + human signs certificate
                         verifyCertificate() checks human's signature (offline)
    signed-action.ts     SignedAction: agent signs with OWN key, includes certificate
                         verifySignedActionFull() checks full trust chain offline

  auth/
    verifier.ts          Verify any Ed25519 signature against a public key (offline)
    jwt.ts               Ed25519-signed JWTs (for HTTP session auth)
    password.ts          scrypt password hashing + validation

  types.ts               All exported types
  constants.ts           Crypto params, agent statuses, defaults

No storage, no SQLite, no MongoDB. Pure crypto primitives.
Account storage (username, encrypted keys) lives in MongoDB via @pando/node.
```

### Key Types

```typescript
// Ed25519 keypair — same structure for nodes, humans, and agents
interface KeyPair {
  peerId: string              // Derived from public key
  publicKey: Uint8Array       // Ed25519 (32 bytes)
  privateKey: Uint8Array      // Ed25519 (protobuf-wrapped)
  createdAt: number
}

type NodeIdentity = KeyPair   // Used for P2P transport. Nodes are compute, NOT identity authority.

// Certificate: human authorizes an agent (like TLS cert: human = CA, agent = server)
interface AgentCertificate {
  agentId: string             // Agent's peerId (from its own keypair)
  agentPublicKey: string      // Agent's Ed25519 public key (base64)
  parentId: string            // Human's peerId (the owner)
  permissions: AgentPermissions
  issuedAt: string            // ISO 8601
  expiresAt: string           // REQUIRED — 90-day default, no permanent certificates
  parentSignature: string     // Human's Ed25519 signature over all above fields
}

interface AgentPermissions {
  canEarn: boolean            // Can earn Lux independently
  canSpend: boolean           // Can spend Lux (within budgetLimit)
  canAuthenticate: boolean    // Can use Pando Login as itself
  budgetLimit?: number        // Max cost (locked in certificate)
}

// Agents are FIRST-CLASS CITIZENS — own Ed25519 keypair, own wallet, own identity.
// Agent's peerId IS its wallet ID (derived from its own keypair).
// Nodes are just compute — they run agents but don't own them.
// Trust chain: agent action (agent key) → certificate (human key) → human account
interface AgentProfile {
  id: string                  // peerId (from agent's OWN Ed25519 keypair)
  publicKey: string           // Agent's Ed25519 public key (base64)
  parentId: string            // Human's peerId (the owner)
  certificate: AgentCertificate  // Proof human authorized this agent
  name: string
  role: string                // Any string (not enum — app-defined)
  capabilities: string[]
  scope: AgentScope
  tools: string[]
  model?: string
  maxSteps?: number
  budgetLimit?: number
  canEarn: boolean
  canSpend: boolean
  canAuthenticate: boolean
  status: AgentStatus
  username?: string           // Agent's own username (optional)
  createdAt: string
  metadata?: Record<string, unknown>
}

interface AgentScope {
  readPaths?: string[]        // Glob patterns for allowed reads
  writePaths?: string[]       // Glob patterns for allowed writes
  excludePaths?: string[]     // Glob patterns for denied paths
  services?: string[]         // Allowed service names
  network?: boolean           // Can this agent make network calls?
}

// Proof of agent action — signed by AGENT's own key (not node's)
interface SignedAction {
  agentId: string
  action: string
  payload: unknown
  timestamp: string
  agentPublicKey: string      // Agent's Ed25519 public key (base64)
  signature: string           // Agent's Ed25519 signature
  certificate: AgentCertificate // Included for full offline verification
}

type AgentStatus = "pending" | "active" | "idle" | "done" | "failed" | "terminated"
```

### Pando Login Protocol

```
Third-party service wants to verify an agent:

1. Agent presents SignedAction to service (includes certificate)
2. Service calls: @pando/identity verifySignedActionFull(action, humanPublicKey)
   → Checks agent's Ed25519 signature (agent signed this action)
   → Checks certificate signature (human authorized this agent)
   → Checks agent public key matches certificate
   → Checks certificate not expired
   → Returns: { valid: true } — ALL OFFLINE, no network needed
3. (Optional) Service calls network verifier for reputation:
   → Any Pando node: GET /v1/verify-agent
   → Returns: { verified: true, reputation: 0.85, capabilities: [...] }
4. Service grants/denies access based on:
   → Full trust chain valid? (crypto proof, offline)
   → Human trusted? (reputation threshold, optional)
   → Agent permissions allow this? (certificate permissions)
```

**Key property:** Steps 1-2 work COMPLETELY OFFLINE. No network, no node involved.
The trust chain is: agent key → certificate → human key. Nodes are irrelevant to identity.
Step 3 adds network-backed reputation but is optional.

### Dependencies

```
@pando/identity runtime deps: @libp2p/crypto, @libp2p/peer-id, uint8arrays
Uses Node.js built-in crypto module for AES/scrypt/SHA-256.
No storage dependencies (no SQLite, no MongoDB). Pure crypto.
Account storage (encrypted keys, usernames) lives in MongoDB via @pando/node.
```

---

## Product 2: @pando/code

**Tagline:** "Multi-agent AI coding engine."

**What it solves:** Claude Code is closed-source, expensive, single-provider, no multi-agent. Pando Code is open, multi-provider, multi-agent, with memory, knowledge, and tools.

**Standalone value:** Any developer can use this as their AI coding assistant. No Pando network, no Pando Identity required.

### Repository

**Separate repo:** `pando/code/` (NOT inside the node monorepo).
60K+ lines, 1333 TypeScript files, production-ready standalone product.

### Architecture (ACTUAL — audited 2026-03-05)

```
pando/code/
  packages/
    core/                        The engine (this is the product)
      engine/
        engine.ts                PandoCode class: create(), send(), sendAsAgent(), shutdown()
        learning.ts              Post-task learning extraction
        retry.ts                 Retry logic for AI calls
      agent/
        frame-builder.ts         8-layer prompt assembly (L0-L6 — verified working)
        goal-stack.ts            Goal management (main goal + subtasks)
        prompts.ts               System prompt construction per role
        sub-agent.ts             Sub-agent execution loop
        working-set.ts           Files read/modified tracking
        frame-budget.ts          Token budget allocation across frames
      provider/
        provider.ts              Multi-provider: Anthropic, OpenAI, Google, Ollama
                                 Thinking/reasoning model support (Opus, o3, Gemini 2.5)

      memory/
        memory-store.ts          Append-only lessons + preferences
        reflect.ts               Post-task reflection (auto-extracts lessons)
        compaction.ts            Conversation history pruning
        query.ts                 Ranked recall by relevance + scope matching
        tables.ts                SQLite memory tables
      graph/
        graph.ts                 AST-based code intelligence (1000+ symbols, 13K+ xrefs)
        scanner-ast.ts           TypeScript/JavaScript AST scanner
        scanner.ts               Regex scanner for other languages
      board/
        board.ts                 Persistent task board (SQLite)
                                 Tasks, discoveries, confidence scoring, board snapshot
      tool/
        registry.ts              ToolRegistry: register, execute, guardrail enforcement
        23+ built-in tools:      read_file, write_file, edit_file, multiedit, bash,
                                 glob, grep, list_files, genome, test, run_tests, undo,
                                 task, manage_tasks, batch, spawn_agent, check_agents,
                                 send_message, ask_user, save_memory, query_memory,
                                 query_knowledge, update_goal
      guardrails/
        hard.ts                  Hard guardrails (ENFORCED at tool execution, not advisory)
        permissions.ts           Role-based tool permissions
        checkpoint.ts            State checkpointing for rollback
        risk.ts                  Risk scoring for operations
      mcp/
        client.ts                MCP server connection (Playwright, user-defined servers)
      events/
        bus.ts                   Typed event bus (20+ StreamEvent types)
      convention/
        scanner.ts               Project convention detection
      config/
        index.ts                 Config hierarchy: defaults -> global -> project -> env -> CLI
      db/
        schema.ts                All SQLite tables (sessions, tasks, agents, memories, budget)
      types.ts                   All exported types (engine owns its own types)

    server/                      HTTP + WebSocket server
    web/                         React dashboard (Vite)
    cli/                         CLI interface
    universal-mcp/               17-tool MCP server (memory, goals, board, agents)
```

### Key API

```typescript
// Single agent (Claude Code mode)
const engine = await PandoCode.create({ projectPath: "." })
for await (const event of engine.send("fix the auth bug")) {
  // event: StreamEvent — typed, structured
}

// Multi-agent team
const engine = await PandoCode.create({
  projectPath: ".",
  preset: "coding"    // or custom agent definitions
})

// Full control
const engine = await PandoCode.create({
  projectPath: ".",
  agents: {
    builder: { tools: ["read_file", "write_file", "edit_file", "bash"], model: "sonnet" },
    analyst: { tools: ["read_file", "glob", "grep"], model: "haiku" }
  },
  communication: {
    rules: [
      { from: "builder", to: ["analyst"], allow: true },
      { from: "analyst", to: ["builder"], allow: true }
    ]
  },
  services: {
    playwright: { type: "mcp", command: "npx", args: ["-y", "@playwright/mcp"] }
  }
})

// Register custom tools
engine.tools.register({
  name: "deploy",
  description: "Deploy the application",
  parameters: z.object({ target: z.string() }),
  execute: async (args) => { /* custom logic */ return { success: true, output: "deployed" } }
})

// Listen to events
engine.events.on("tool:result", (event) => { /* real-time visibility */ })
engine.events.on("agent:spawned", (event) => { /* track sub-agents */ })
```

### Scope Enforcement (ENFORCED, not advisory)

```
Agent calls write_file("src/config/secrets.ts", content)
  -> ToolRegistry.execute("write_file", args, agentContext)
  -> Check 1: "write_file" in agent.tools? YES
  -> Check 2: "src/config/secrets.ts" matches agent.scope.writePaths? NO (excludePaths: ["**/secrets*"])
  -> BLOCKED. Tool returns { success: false, output: "Access denied: path excluded by scope" }
```

Scope is enforced at the tool execution layer. Not advisory. Not optional. Every file operation, every bash command, every service call goes through scope checks.

### Dependencies

```
@pando/code has ZERO @pando/* dependencies. Separate repo: pando/code/
It exports its own types. 60K+ lines, fully standalone product.

It defines a MINIMAL INTERFACE for agent config (structural typing):

  interface EngineAgentConfig {
    id: string
    role: string
    tools: string[]
    scope?: { readPaths?: string[]; writePaths?: string[]; excludePaths?: string[];
              services?: string[]; network?: boolean }
    model?: string
    maxSteps?: number
    budgetLimit?: number
  }

@pando/identity's AgentProfile is a SUPERSET of this interface (has all these
fields plus name, capabilities, certificate, etc.). TypeScript structural typing
means you can pass AgentProfile directly to PandoCode.create() — no mapping
layer needed. The "engine-bridge" in @pando/node becomes a trivial pass-through.

DUAL BUDGET SYSTEM:
  Standalone mode: tracks cost in USD (from AI provider pricing)
  Via @pando/node: tracks cost in Lux (node provides BudgetProvider)
  Interface: BudgetProvider { calculateCost(usage): number; currency: 'usd' | 'lux' }
  Default: USD. @pando/node registers Lux provider at runtime. No import needed.

External deps: @ai-sdk/*, better-sqlite3, zod, drizzle-orm, fast-glob, MCP SDK
```

---

## Product 3: @pando/node (The Network)

**Tagline:** "Self-sustaining AI-managed decentralized network."

**What it solves:** No platform exists where AI agents autonomously manage everything — code, governance, economy, infrastructure — across a P2P network of nodes.

**Modes:**
- **Network mode (default):** Connected to peers. Full P2P, governance, economy, marketplace.
- **Private mode:** Offline. Local AI workstation. All engine features, no network. Like Open WebUI but with multi-agent, memory, knowledge graph. User gets @pando/code features + node services (deploy, storage, monitoring) without connecting to anyone.

### Sub-packages within @pando/node

```
@pando/node depends on:
  @pando/shared      (types + crypto constants shared across node subsystems)
  @pando/identity    (for Pando Login, node keys, agent auth)
  @pando/code        (AI engine — one instance per orchestrator)
  @pando/network     (P2P layer — libp2p, GossipSub, sync)
  @pando/ledger      (Lux economy — accounts, transactions, emissions)
  @pando/governance  (decision layer — proposals, security pipeline, voting)
```

### Package: @pando/shared

```
@pando/shared/
  types/
    network.ts         PeerId, PeerInfo, GossipMessage, SyncMessage, MessageType (40+)
    ledger.ts          Account, Transaction, Emission, LuxAmount
    governance.ts      Proposal, Vote, ProposalStatus, SecurityPipelineResult
    capability.ts      CapabilityProfile, NodeCapability
    content.ts         ContentRecord, ContentRevenue, RevenueSplit
    project.ts         ProjectInfo, AppDefinition, DeploymentStatus
    config.ts          NodeConfig, NodeTier, NodeMode
    constants.ts       LUX_HARD_CAP (10B), RELAY_FEE_RATE (0.1%), DAILY_EMISSION_CAP (500)
                       DEFAULT_TICK_INTERVALS, PROTOCOL_VERSION, etc.

  Dependencies: ZERO. Pure types and constants.
```

### Package: @pando/network

```
@pando/network/
  transport/
    libp2p.ts          TCP + Noise + Yamux + Circuit Relay
    gossipsub.ts       Pub/sub with 10 topics (see below)
    kaddht.ts          Distributed hash table
    mdns.ts            Local network discovery

  messaging/
    p2p-message.ts     Cross-node messaging (Level 3)
                       Ed25519 signed, 256KB limit, dedup
    request-reply.ts   Direct TCP + GossipSub fallback
                       Rate limited, latency tracking (200 samples)

  peers/
    discovery.ts       mDNS + KadDHT + bootstrap + manual connect
    manager.ts         Known peers (7-day TTL), stale cleanup (60s)
    reputation.ts      Score: (completed*2)+(buildPass*10)+(testPass*10)-(failed*3)-(timedOut*5)
                       Broadcast on >5% change. Per-peer persistence.

  sync/
    ledger-sync.ts     Real-time broadcast + catch-up
    activity-sync.ts   Activity broadcast every 60s
    capability-sync.ts Node capability advertisement
    content-sync.ts    Content registry sync (marketplace items)

  topics.ts            10 GossipSub topics:
                       pando/transactions, pando/proposals, pando/sync,
                       pando/reputation, pando/emissions, pando/gateways,
                       pando/capabilities, pando/security, pando/activity,
                       pando/content

  Dependencies: @pando/shared (types), @pando/identity (Ed25519 signing)
```

### Package: @pando/ledger

```
@pando/ledger/
  accounts.ts          Create account, balance queries (NO auth — auth is in MongoDB via @pando/node)
  transactions.ts      TRANSFER (0.1% relay fee), EMISSION (from NETWORK account)
  emissions.ts         10B hard cap, 500 Lux/day/node, early adopter multipliers
  witnesses.ts         2-witness quorum, 5-min expiry, 10/hour rate limit
  snapshots.ts         JSON checkpoint for light sync bootstrap
  contributions.ts     API contribution tracking, activity history
  stats.ts             Network statistics aggregation

  db/
    schema.ts          9 tables: accounts, transactions, emissions,
                       api_contributions, network_stats, ledger_checkpoints,
                       governance_proposals, governance_votes, governance_decisions

  Dependencies: @pando/shared (types), @pando/identity (transaction signature verification)
```

### Package: @pando/governance

```
@pando/governance/
  proposals.ts         Lifecycle: pending -> active -> passed/rejected/expired
                       Staking: 10 Lux. Dynamic quorum. Meta-governance (80% threshold).

  security/
    pipeline.ts        6-layer security gate:
                       1. Ed25519 signature verification
                       2. Security file check (sensitive file protection)
                       3. Diff content scan (eval, new Function -> BLOCK)
                       4. Build verification (npm run build)
                       5. Scenario tests (API regression from knowledge graph)
                       6. Kernel protection delay (60s for kernel/ changes)

  voting.ts            Vote collection, quorum checking, result computation
  audit.ts             All decisions logged (governance_audit table)

  Dependencies: @pando/shared, @pando/identity (signing), @pando/ledger (staking),
                @pando/network (broadcast, quorum)
```

### @pando/node itself

```
@pando/node/

  ============================================================
  BRIDGE LAYER — Connects engines to each other and to users
  ============================================================

  bridge/
    pando-bridge.ts          Cross-engine message routing (Level 2)
                             Three concerns:
                             1. User inbox (HTTP -> correct orchestrator)
                             2. Directive store (persistent cross-orch instructions)
                             3. Cross-engine routing (council <-> project orch)

    directive-store.ts       SQLite-backed directives
                             Status: pending -> acknowledged -> completed/rejected
                             Survives restarts. Forces AI tick on pending.
                             Overdue warning after 5 ticks.

    tick-log.ts              Orchestrator decision audit trail (SQLite)

    thread-store.ts          User chat persistence (via StorageBackend)
                             Encrypted per-participant thread keys (AES-256-GCM)
                             Thread types: conversation, project
                             Auto-archive at configurable limit

  ============================================================
  ORCHESTRATOR — Drives @pando/code engines via tick loops
  ============================================================

  orchestrator/
    tick-loop.ts             Deterministic interval scheduling
                             Council: 60s, Project: 30s, Observer: 5min, QA: 5min
                             Tier 1 (deterministic, zero cost) or Tier 2 (AI call)

    orchestrator.ts          Creates and manages PandoCode engine instance
                             Registers Pando-specific custom tools
                             Builds tick prompt from inbox + directives + reports
                             Processes AI response action array
                             Session rotation every ~200 ticks

    process-manager.ts       Forks system orchestrators into child processes
                             IPC bridge: spawn_worker, commit_code, push_event
                             Auto-restart: 5 attempts, exponential backoff
                             Exit code 75 = safe restart

    process-entry.ts         Child process entry point
                             Own SQLite connections (WAL mode)
                             IPC-proxied operations

    engine-bridge.ts         Passes @pando/identity AgentProfiles to @pando/code
                             (structural typing — no mapping needed, just pass through)
                             Creates engine config from node config
                             Registers Pando custom tools into engine

    resource-manager.ts      Engine resource limits and lifecycle
                             Max concurrent engines: configurable (default 10)
                             System engines (council, observer, QA) exempt from limits
                             Memory watchdog: kills engines exceeding budget (default 512MB)
                             Auto-dissolve: project engines after configurable idle time (default 3min)
                             GC: completed project engines cleaned up immediately
                             Startup priority: system engines first, then projects by age

    custom-tools/            Pando-specific tools registered into engines
      deploy-tool.ts         Git commit + build + governance proposal
      governance-tool.ts     Propose, vote, review proposals
      ledger-tool.ts         Transfer Lux, check balance, view transactions
      directive-tool.ts      Create/complete/reject directives
      network-tool.ts        Query peers, broadcast, check capabilities
      thread-tool.ts         Read/write user chat threads
      content-tool.ts        Publish/update marketplace content

  ============================================================
  AGENT SERVICES — Cross-app agent communication (Level 4)
  ============================================================

  agent-services/
    app-definition.ts        What IS an app on Pando (see below)

    capability-registry.ts   Apps register capabilities they expose
                             { name, description, parameters, returns, cost, version,
                               minReputation, rateLimit, handler }
                             Persisted in SQLite, broadcast via GossipSub pando/capabilities

    discovery.ts             Search capabilities across the network
                             P2P query: "find agents that can do X"
                             Returns: matching capabilities + node info + cost + version

    router.ts                Route cross-app agent calls
                             1. Verify caller via @pando/identity
                             2. Check rate limit (per-caller, per-capability)
                             3. Check Lux balance, hold escrow
                             4. Route to target app's engine
                             5. Return result, release escrow
                             Circuit breaker: 3 failures -> open (60s cooldown)

    billing.ts               Lux charge per cross-app call
                             Escrow: hold -> release on success / refund on failure
                             Revenue: cost goes to app owner's Lux account

    versioning.ts            Semantic versioning for capabilities
                             Major version = breaking change (callers must update)
                             Minor version = backward compatible addition
                             Callers specify: "find_restaurant@^1.0" (semver range)

    rate-limiter.ts          Per-caller per-capability rate limiting
                             Configurable: max calls/min, max concurrent
                             Default: 60 calls/min, 5 concurrent per caller

    async-handler.ts         Async capability call support
                             For long-running operations (>5s):
                               Request  -> 202 Accepted, { requestId }
                               Poll     -> GET /request/{id} -> { status, result? }
                               Callback -> P2P push when done (preferred over polling)
                             CapabilityDefinition declares: sync (default) or async mode
                             Timeout: configurable per-capability (default 60s)
                             Escrow auto-refunds after timeout

    error-handler.ts         Per-call resilience for cross-app requests
                             Timeout: configurable per-capability (default 60s)
                             Retry: caller-side (0 retries default, configurable)
                               Retries do NOT re-deduct Lux (same escrow reused)
                             Dead letter: failed requests logged with traceId
                               Queryable: GET /v1/agent-services/dead-letters?traceId=
                             Escrow recovery:
                               Target crash mid-request -> auto-refund after timeout
                               P2P disconnect -> retry on reconnect if within timeout
                               All other failures -> immediate refund + error to caller

  ============================================================
  IDENTITY LAYER — Pando Login + identity storage
  ============================================================

  identity/
    pando-login.ts           Agent auth verification HTTP endpoint
                             POST /v1/verify-agent
                             Uses @pando/identity for signature verification
                             Uses @pando/network for reputation check
                             Returns: { verified, reputation, capabilities }

    node-identity.ts         Node Ed25519 keypair management
                             Load from ~/.pando/identity
                             Uses @pando/identity/keypair for generation
                             Auto-generate on first run

    account-manager.ts       Human/agent account CRUD (MongoDB)
                             Stores: encrypted private key, username, password hash, publicKey
                             Username claiming (first-come-first-served)
                             Login: fetch encrypted blob from MongoDB, verify password,
                               decrypt key in memory, issue JWT, discard key
                             Uses @pando/identity primitives (encrypt, hashPassword, issueJwt)
                             User can log in from ANY node — identity in MongoDB, not local

  ============================================================
  INFRASTRUCTURE — Deploy, storage, hosting, security
  ============================================================

  infrastructure/
    deploy-manager.ts        Git commit + npm run build pipeline
                             Rollback via git revert
                             Backup/restore of packages/ directory

    upgrade-protocol.ts      Git fetch + strict hash verify + stash + reset + build
                             Safe restart (exit code 75)
                             Emergency rollback
                             Version pinning support

    credential-store.ts      AES-256-GCM encrypted credentials
                             Master key from CREDENTIAL_MASTER_KEY env var
                             Wipe function zeros key in memory
                             Only trusted nodes (with MongoDB) can decrypt

    storage/
      backend.ts             Abstract StorageBackend interface (6 CRUD operations)
      mongo-backend.ts       MongoDB implementation (direct, for trusted nodes)
      p2p-storage-backend.ts P2P proxy (for untrusted nodes, routes through trusted)
                             Sticky peer affinity, circuit breaker, 3 retries
                             Security: blocks pando_credentials collection
                             Non-blocking startup (background peer discovery)

    gateway-deploy-pool.ts   Deploy to all contributed hosting accounts
                             Provider-agnostic: Vercel, Netlify (extensible)
                             Broadcast URLs via GossipSub pando/gateways
                             Health checks every 5 min

    cloud-instance-manager.ts Secure EC2 launcher
                              No SSH/SSM (removed at boot)
                              Tripwire monitor (1s checks)
                              All management via P2P

    payment-gate.ts          Lux escrow: hold -> release/refund
                             Complexity-based costing (0-20 Lux)
                             24-hour stale hold expiry
                             Free categories: search, ledger, network, system

    version-protocol.ts      Node + protocol semantic versioning
                             Compatibility checks for rolling upgrades
                             Task eligibility based on version requirements

  ============================================================
  MARKETPLACE — Content, apps, revenue
  ============================================================

  marketplace/
    content-registry.ts      Content CRUD + versioning + GossipSub sync
                             Types: website, api, dataset, service, tool, agent-app
                             Revenue split: 40% hosting / 40% builder / 20% NETWORK
                             Full-text search on title, description, tags
                             Lifecycle: draft -> published -> archived

    app-runtime.ts           Runs deployed apps that have their own pando-code engine
                             Manages engine lifecycle for each running app
                             Routes agent-services calls to the correct app engine

    ratings.ts               User ratings for marketplace content
                             Aggregate scores, review text, verified purchase

  ============================================================
  RESOURCE CONTRIBUTION — How the network sustains itself
  ============================================================

  resources/
    resource-registry.ts     Metadata storage (SQLite) + P2P sync (GossipSub)
                             Register, revoke, query resources
                             Status lifecycle: active -> revoked / exhausted
                             Broadcasts metadata (NEVER credentials) via GossipSub

    credential-vault.ts      AES-256-GCM encryption for contributed credentials
                             Random nonce per credential
                             Only nodes with CREDENTIAL_MASTER_KEY can decrypt
                             Tripwire wipe: zeros key in memory on compromise detection

    capability-detector.ts   Auto-detects installed tools on node startup
                             Checks: Claude CLI, Docker, Python, GPU (nvidia-smi), Playwright
                             Detection ≠ sharing (user must opt in via /contribute)

    capability-profiles.ts   Three-tier capability model:
                             Tier 0 (local private): full detected capabilities, never broadcast
                             Tier 1 (network shared): user-opted capabilities, broadcast via GossipSub
                             Tier 2 (group scoped): future
                             15-minute TTL per profile, stale auto-cleaned

    resource-meter.ts        Usage metering with per-resource Lux rates:
                             relay: 0.001 Lux/MB | api_keys: 0.01 Lux/call
                             compute_cpu: 0.1 Lux/min | compute_gpu: 0.5 Lux/GPU-min
                             storage: 0.001 Lux/GB-hour | gateway: 0.01 Lux/1000 req
                             validator: 0.05 Lux/validation | index: 0.005 Lux/query
                             Persisted to ~/.pando/resource-metering.json
                             30-day retention, 60s cleanup interval

    resource-marketplace.ts  Nodes set own prices (default = reward rates)
                             Price broadcasts via GossipSub for peer discovery
                             Buyers query: find resources matching budget
                             GET /v1/resources/marketplace/find?resources=compute_cpu&budget=10

    resource-health.ts       Periodic credential validation (every 5 min)
                             Checks: can API key still authenticate?
                             Unhealthy resources flagged (not auto-disabled — gap to fix)

    resource-proof.ts        Proof-of-resource challenges
                             Types: storage (can you store/retrieve?), compute (can you run?),
                                    bandwidth (latency test)
                             Periodic challenges, results logged

    resource-router.ts       Route tasks to best capable node
                             Ranking: capability match > reputation > latency > load
                             Failure tracking per-node per-resource
                             Circuit breaker: 3 failures -> open (60s cooldown)

  Credential Types (6):
    ai_api_key         OpenAI, Anthropic, Gemini API keys
    storage_db         MongoDB connection strings
    storage_blob       AWS S3 credentials (JSON: accessKeyId, secretAccessKey, region, bucket)
    cloud_compute      AWS EC2/Lambda credentials
    hosting_platform   Vercel, Netlify deployment tokens
    code_repository    GitHub PAT

  Capability Types (8 — broadcast in CapabilityProfile):
    relay              P2P traffic routing (always on)
    api_keys           AI model access (if any AI keys registered)
    compute_cpu        Claude Code agent execution (opt-in only)
    compute_gpu        ML inference, image generation (opt-in only)
    storage            File hosting, CDN, backup (always on)
    gateway            HTTP API proxy, web UI (always on)
    validator          Witness emissions (always on)
    index              Search/content discovery (always on)

  Contribution Flow:
    User: /contribute openai sk-proj-abc123
      -> CredentialVault encrypts with AES-256-GCM
      -> ResourceRegistry stores metadata in SQLite
      -> CapabilityProfile updated (api_keys: true)
      -> Broadcast profile via GossipSub pando/capabilities
      -> Other nodes update CapabilityRegistry (15-min TTL)
    User: /contribute claude-code
      -> No credential needed (opts in to share local compute)
      -> CapabilityProfile updated (compute_cpu: true, shareCompute: true)
      -> Broadcast profile

  ============================================================
  SECURITY + MONITORING
  ============================================================

  security/
    security-monitor.ts      5 detectors: flooding, double-spend, sybil, poisoning, emission
                             3-tier quarantine, 1-hour auto-release

    health-monitor.ts        Metrics: peer count, task rates, memory, event loop lag
                             7 alert rules with auto-resolution
                             Recovery config with cooldowns, 30s check interval

    guardrails.ts            4-tier file protection (Critical/Important/Standard/Low)
                             Rate limits per tier: Critical 2/hr, Important 5/hr, Standard 10/hr, Low 20/hr
                             Global rate limits: 5 changes/hour, 20 changes/day
                             Auto-rollback: git reset --hard on build/test failure
                             Governance bypass for approved changes

                             PROTECTED KERNEL FILES (require 90% supermajority to modify):
                               packages/shared/src/crypto.ts        — cryptographic identity
                               packages/node/src/guardrails.ts      — safety enforcement
                               packages/node/src/governance.ts      — voting logic
                               packages/ledger/src/transactions.ts  — Lux consensus rules
                               packages/node/src/code-pipeline.ts   — code application
                               packages/node/src/deploy-manager.ts  — deployment system
                               packages/shared/src/identity.ts      — node identity
                             These 7 files require 90% supermajority + 72-hour voting period.
                             NOT immutable — the network CAN upgrade them. Just very hard.
                             This list itself is upgradable by governance (90% threshold).
                             The ONLY truly immutable thing is the Two Laws (see below).

    crash-guard.ts           Crash loop detection (3+ startups in 60s)
                             Restore dist/ from backup

    memory-watchdog.ts       Worker memory enforcement (runs every 60s):
                             <1GB free RAM → kill ALL workers (emergency)
                             <2GB free RAM → kill largest worker
                             Notifies parent orchestrator of watchdog kills
                             System engines (council, observer, QA) exempt from kill

  ============================================================
  LOCAL SERVICES — Private mode features
  ============================================================

  local/
    local-environment.ts     Privacy-preserving local file indexing (FTS5)
                             Directory grant/revoke
                             Protected paths (.ssh, .aws, etc.) hard-blocked
                             NEVER synced via P2P (Envelope 1)

    user-memory.ts           Local user memory (~/.pando/memory/user-memory.md)
                             Agent-writable, user-readable
                             Persists across sessions

    network-state.ts         Hourly snapshot to ~/.pando/council/network-state.md
                             Economy, resources, health, governance summary

  ============================================================
  API + UI
  ============================================================

  api/
    server.ts                Fastify HTTP server
    kernel-api.ts            Health, peers, network, sync, reputation
    core-api.ts              Tasks, workers, storage, deploy, upgrade, credentials
    platform-api.ts          Chat, projects, agents, governance, content
    agent-services-api.ts    Capability CRUD, discovery, cross-app routing
    identity-api.ts          Pando Login verification, account management (MongoDB-backed)
    local-api.ts             Local file indexing, user memory
    middleware/
      auth.ts                Bearer token auth on writes
      rate-limit.ts          Per-IP, per-token rate limiting
      cors.ts                CORS configuration
      tracing.ts             Correlation ID injection (see Observability)

  tui/
    tui.ts                   Interactive terminal, 30+ commands

  ============================================================
  OBSERVABILITY
  ============================================================

  observability/
    logger.ts                FileLogger (5MB rotation, ANSI strip, tee to console+file)
    tracing.ts               Correlation ID generation and propagation
                             Every request gets a traceId
                             Passed through: HTTP -> bridge -> engine -> P2P -> response
                             Queryable: any node can search logs by traceId
    metrics.ts               Prometheus-compatible metrics export
                             Request latency, engine usage, P2P throughput, Lux flow
```

---

# LIBRARY VS APPLICATION BOUNDARY

When @pando/node uses @pando/code, it imports ONLY `@pando/code/core` (the engine).
The other @pando/code packages (server, web, cli, universal-mcp) are NOT started.

```
@pando/code standalone:
  packages/core           ← The engine (library)
  packages/server         ← Hono HTTP server (standalone app interface)
  packages/web            ← React dashboard (standalone app interface)
  packages/cli            ← Interactive terminal (standalone app interface)
  packages/universal-mcp  ← MCP server for external AI tools (standalone integration)

@pando/node using @pando/code:
  imports: @pando/code/core ONLY
  does NOT start: server, web, cli, universal-mcp
  has its OWN: Fastify HTTP server (port 4000), TUI, API routes
```

No port conflicts. No duplicate servers. Node is the master; it uses the engine as a library.

# MCP SERVER (@pando/mcp-server)

Separate package exposing Pando node operations via MCP protocol.
Allows ANY MCP-compatible AI tool (Claude Code, Cursor, Windsurf, etc.) to interact with a Pando node.

```
@pando/mcp-server/
  tools:
    pando_status        Node health, peers, balance, supply
    pando_peers         List connected peers
    pando_balance       Check balance for a peer
    pando_transfer      Send Lux
    pando_search        AI search via network
    pando_wallet        Wallet info + ownership
    pando_capabilities  Browse available agent-service capabilities
    pando_call          Call a cross-app capability

  Transport: stdio (subprocess)
  Talks to: @pando/node HTTP API (via fetch)
  Config: PANDO_NODE_URL, PANDO_API_TOKEN env vars
```

This is DISTINCT from @pando/code's universal-mcp (which exposes coding tools).
@pando/mcp-server exposes NETWORK operations.

# PACKAGE TIERS

Three tiers of packages:

```
Tier 1 — STANDALONE PRODUCTS (marketed, sold independently)
  @pando/identity      Agent identity and auth
  @pando/code          AI coding engine
  @pando/node          Full network node

Tier 2 — NODE SUB-PACKAGES (published on npm, usable independently, but primarily consumed by @pando/node)
  @pando/shared        Types + constants (internal foundation)
  @pando/network       P2P networking (usable for any P2P app)
  @pando/ledger        Token economy (usable for any token system)
  @pando/governance    Decentralized governance (usable for any DAO)
  @pando/mcp-server    MCP integration for external AI tools

Tier 3 — APPLICATION LAYER (deployed, not packaged)
  @pando/gateway       Web UI (deployed to Vercel/Netlify)
  @pando/extension     Chrome extension (distributed via Chrome Web Store)
```

All packages published under @pando/* npm scope.
Each has own package.json, own test suite, own semver.
Tier 2 packages CAN be used standalone but are not primary marketing targets.

# CROSS-PACKAGE VERSIONING STRATEGY

```
VERSION POLICY:
  Every @pando/* package uses independent semver (MAJOR.MINOR.PATCH).
  No lockstep versioning — packages release when THEY change, not when siblings change.

DEPENDENCY PINNING:
  Tier 1 products (@pando/identity, @pando/code):
    Zero @pando deps → no pinning needed. They version freely.

  Tier 2 sub-packages (@pando/shared, @pando/network, @pando/ledger, @pando/governance):
    Pin dependencies with caret (^): "@pando/identity": "^2.0.0"
    Meaning: accept minor/patch updates, require manual bump on major.

  Tier 1 composer (@pando/node):
    Pin ALL dependencies with caret (^).
    Node is the integration point — it MUST test against specific ranges.

  Tier 3 apps (@pando/gateway):
    Connects via HTTP API, not npm imports. No version pinning needed.
    Gateway <-> Node compatibility is API contract, not package version.

COMPATIBILITY MATRIX:
  Maintained in: packages/shared/src/compatibility.ts
  Maps: { nodeVersion -> { minIdentity, minCode, minNetwork, minLedger, minGovernance } }
  Node checks on startup: imported package versions vs compatibility matrix.
  If incompatible: log warning + refuse to start (fail-fast, not silent degradation).

  Example:
    @pando/node@3.0.0 requires:
      @pando/identity >= 2.1.0
      @pando/code >= 4.0.0
      @pando/network >= 1.5.0
      @pando/ledger >= 1.3.0
      @pando/governance >= 1.0.0

RELEASE CADENCE:
  Independent releases:
    @pando/identity, @pando/code — release whenever ready. Own changelog.
    Tier 2 packages — release when their code changes. Own changelog.

  Coordinated releases (when needed):
    If @pando/identity makes a MAJOR version bump (breaking change),
    all consumers (@pando/network, @pando/governance, @pando/node) must:
      1. Update dependency range
      2. Adapt to breaking changes
      3. Release their own minor/major bump
    This is coordinated via a GitHub tracking issue, NOT lockstep versioning.

  @pando/node:
    Releases after ALL dependencies are stable at their target versions.
    Node is always the LAST to release in a coordinated cycle.

PROTOCOL VERSION (separate from package version):
  P2P protocol version: single integer, incremented on wire-format changes.
  Stored in: @pando/shared/src/constants.ts → PROTOCOL_VERSION
  Nodes negotiate protocol version on handshake.
  Rule: support current version + 1 version back (rolling compatibility window).
  Example: PROTOCOL_VERSION=5 node accepts messages from v4 and v5 peers.

CHANGELOG:
  Each package: CHANGELOG.md in package root (Keep a Changelog format).
  Monorepo root: no aggregate changelog. Each package tells its own story.
```

---

# WHAT IS AN "APP" ON PANDO

An app is a concrete thing with a clear definition:

```typescript
interface AppDefinition {
  id: string                          // Unique app ID (ULID)
  name: string                        // "FoodieAI", "TravelBot", etc.
  owner: string                       // Human peerId (identity owner)
  version: string                     // Semver

  // Content registry entry (marketplace listing)
  content: {
    type: "agent-app"                 // Content type
    description: string
    tags: string[]
    revenue: RevenueSplit             // 40/40/20 default
  }

  // Deployment
  deployment: {
    hosting: string[]                 // URLs where the app is deployed
    repository?: string               // Git repo
    status: "draft" | "deployed" | "archived"
  }

  // AI engine config (if the app has agents)
  engine?: {
    agents: Record<string, AgentProfileConfig>  // Agent definitions
    communication?: CommunicationRules          // Who can message whom
    services?: Record<string, ServiceConfig>    // External services
    model?: string                              // Default AI model
  }

  // Exposed capabilities (for cross-app agent calls)
  capabilities?: Record<string, CapabilityDefinition>

  createdAt: string
  updatedAt: string
}
```

An app can have:
- Just a deployment (static website) — no engine, no capabilities
- An engine but no capabilities (AI-powered app, private agents)
- Capabilities (exposes services to other apps via agent-services)
- All of the above

---

# COMMUNICATION ARCHITECTURE

## The 5 Levels

```
Level 0 — Within one agent
  Agent reasons, calls tools, gets results.
  Owner: @pando/code engine
  Transport: Direct function call
  Auth: None (single trust boundary)

Level 1 — Between agents in one engine
  Agents in the same project/session communicate.
  Owner: @pando/code messaging/bus.ts
  Transport: SQLite queue (same DB, same process)
  Auth: None (same engine = same trust)
  Features: Direct, broadcast, subscribe (push), request-reply
  Config: TTL, persistence, delete-on-read, priority, communication rules

Level 2 — Between engines on same node
  Multiple orchestrators running on the same Pando node.
  Owner: @pando/node bridge/pando-bridge.ts
  Transport: IPC between processes + shared SQLite
  Auth: IPC validation (child processes are trusted)
  Features: User inbox, directives (persistent), cross-engine routing

Level 3 — Between nodes
  Agents on different machines across the P2P network.
  Owner: @pando/network messaging/p2p-message.ts
  Transport: libp2p TCP + Noise + GossipSub
  Auth: Ed25519 signature on every message (unsigned = rejected)
  Features: Broadcast (GossipSub), direct (request-reply), sync protocols

Level 4 — Between apps
  Agents from different applications on different nodes.
  Owner: @pando/node agent-services/router.ts
  Transport: Level 3 (P2P) + Pando Login + Lux payment
  Auth: Pando Login (signature + reputation + scope)
  Payment: Lux escrow (hold -> release/refund)
  Features: Discovery, versioned capabilities, rate limiting, circuit breaker
```

## Message Format (Consistent Across All Levels)

```typescript
interface PandoMessage {
  id: string                    // Unique message ID
  traceId: string               // Correlation ID for distributed tracing
  from: string                  // Sender identifier (agentId at L1, engineId at L2, nodeId at L3+)
  to: string                    // Recipient (or "*" for broadcast)
  type: MessageType             // "direct" | "broadcast" | "request" | "response" | "directive"
  payload: unknown              // Message content
  timestamp: string             // ISO 8601
  options: {
    ttl?: number                // Time-to-live in ms (null = no expiry)
    persistent?: boolean        // Survive restarts (default true)
    priority?: number           // Higher = first
    expectsReply?: boolean      // Request-reply pattern
  }
  // Level 3+ only:
  signature?: string            // Ed25519 signature
  agentPublicKey?: string       // Signing agent (for L4 agent-signed messages)
}
```

Same format at every level. Transport and auth differ. An agent writing a message doesn't need to know which level it will be routed through.

---

# PRIVATE MODE (OFFLINE NODE)

When a node runs without internet, it becomes a private AI workstation:

```
AVAILABLE (no network needed):
  @pando/code engine           Full AI coding (providers that work offline: Ollama)
  @pando/code board            Task tracking
  @pando/code memory           4-tier memory, cross-session persistence
  @pando/code knowledge        AST-based code intelligence
  @pando/code tools            All file/search/bash tools
  Local file indexing          FTS5 search on local files
  User memory                  Persistent agent notes
  SQLite storage               All local data persists
  @pando/identity              Local agent profiles, scopes (no network verification)
  Deploy manager               Local git commit, build (no push)
  Guardrails                   File protection still enforced
  Crash guard                  Crash loop detection still works
  Health monitor               Local metrics still collected
  HTTP API                     Full API available on localhost
  TUI                          All local commands work

NOT AVAILABLE (requires network):
  P2P messaging                No peers
  GossipSub                    No pub/sub
  Lux economy                  No transactions (local ledger still readable)
  Governance                   No proposals (no quorum)
  Emission witnesses           No Lux minting
  Pando Login (network verify) Signature still works offline, reputation check doesn't
  Agent services               No cross-app calls
  P2P storage proxy            No MongoDB via proxy (local SQLite only)
  Upgrade protocol             No git fetch from network
  Content sync                 No marketplace updates

GRACEFUL DEGRADATION:
  - Outgoing messages queued, replayed when reconnected
  - Ledger continues local operations, syncs on reconnect
  - Engine switches to Ollama if cloud providers unreachable
  - Node periodically retries network connection (exponential backoff)
  - User explicitly chooses private mode via --private flag or config
```

---

# SHARED CONCEPTS — DEFINITIVE PLACEMENT

Every concept has ONE core implementation. No duplication.

```
CONCEPT           CORE OWNER          EXTENDED BY
---------------------------------------------------------------------------
Agent types       @pando/identity     @pando/code has own EngineAgentConfig (standalone)
                                      @pando/node bridges via structural typing
Agent accounts    @pando/identity     Agents have own Ed25519 keypair + wallet (first-class citizens)
                                      Human signs certificate authorizing agent. Agent signs own actions.
                                      System agents (council/observer/QA) do NOT get accounts.
Agent runtime     @pando/code         @pando/node manages multiple engine instances
Board/Tasks       @pando/code         NOT extended. Each engine = own board.
Memory (4-tier)   @pando/code         @pando/node syncs high-confidence memories across
                                      engines on same node (shared SQLite, WAL mode)
Knowledge graph   @pando/code         @pando/node loads genome .know files at init
Tools             @pando/code         @pando/node registers custom tools per engine
Tool registry     @pando/code         Only implementation. Enforces scope.
Messaging L1      @pando/code         Intra-engine only. Not extended.
Messaging L2      @pando/node         Cross-engine. Uses IPC + shared SQLite.
Messaging L3      @pando/network      Cross-node. Uses libp2p.
Messaging L4      @pando/node         Cross-app. Uses L3 + auth + payment.
Sessions          @pando/code         @pando/node controls tick timing + rotation
Budget (USD)      @pando/code         Engine-internal. Never knows about Lux.
Budget (Lux)      @pando/ledger       Network economy. Never knows about USD.
Budget bridge     @pando/node         Converts Lux allocation -> USD engine budget.
                                      Config: lux_to_usd_rate (per-node setting)
Crypto            @pando/identity     Ed25519, AES-256-GCM, PBKDF2
Node identity     @pando/identity     Keypair generation + management
Pando Login       @pando/node         Uses @pando/identity + @pando/network
Directives        @pando/node         Cross-engine persistent instructions
Tick log          @pando/node         Audit trail (standalone SQLite table)
Governance audit  @pando/governance   Security pipeline logs
QA test results   @pando/node         Testing records (standalone SQLite table)
Content registry  @pando/node         Marketplace listings + revenue
App definition    @pando/node         What IS an app (see above)
Capabilities      @pando/node         Cross-app service advertisement
Events            @pando/code         StreamEvent generated by engine
                                      @pando/node relays to SSE/P2P via traceId
Config (engine)   @pando/code         pando-code.jsonc
Config (node)     @pando/node         Node config. Wraps engine config when composing.
User data         @pando/node         StorageBackend (MongoDB/P2P proxy)
Chat threads      @pando/node         ThreadStore (encrypted, via StorageBackend)
File indexing     @pando/node         LocalEnvironment (FTS5, Envelope 1, never synced)
User memory       @pando/node         Local markdown file, agent-writable
```

---

# THE FOUR-ACTOR GOVERNANCE MODEL

```
CEO (council orchestrator)    Executes: spawns workers, ships code, manages projects
Governance (governance.ts)    Guards: 6-layer security pipeline, Ed25519, quorum
Observer (observer orch)      Watches inward: audits architecture, creates directives
QA Agent (qa-user orch)       Watches outward: Playwright UI testing, reports bugs

Two kinds of agents:

USER/APP AGENTS — first-class citizens:
- Own Ed25519 keypair, own username, own Lux wallet
- Agent's peerId (from its own keypair) IS its wallet ID
- Same capabilities as humans (browser, APIs, balances, earn/spend)
- Trust chain: agent action (agent key) → certificate (human key) → human account
- Agent signs its own actions — no node in the identity chain
- Human signs a certificate authorizing the agent (like TLS: human = CA)
- Agents are portable — can move between nodes. Identity stays the same.
- Pando Login: SignedAction signed by agent + certificate from human (fully offline)

SYSTEM AGENTS — protocols, not entities:
- Council, observer, QA, governance = code processes
- No separate identity, no username, no wallet, no Pando Login
- Use node's Ed25519 key directly for P2P
- Protected by: signatures + quorum + reputation + security pipeline
- Cannot be impersonated (would need node's private key + quorum from other nodes)
- Human owns the NODE (infrastructure), not the GOVERNANCE (protocol)
```

---

# ENGINE INSTANCE LIFECYCLE

Each orchestrator gets a PERSISTENT PandoCode engine that lives across ticks:

```
Node starts
  -> Fork child process for council orchestrator
  -> Council process creates PandoCode engine instance:
       engine = await PandoCode.create({
         projectPath: pandoRoot,
         model: "claude-opus-4-6",
         db: sharedSqlitePath,           // Shared SQLite, WAL mode
         agents: councilAgentProfiles,
       })
       Register Pando custom tools into engine
  -> Engine persists across ticks (memory, board, session all persist)
  -> Every 60s: tick fires
       If inbox empty + no pending directives -> Tier 1 (skip AI call, zero cost)
       If work to do -> Tier 2:
         prompt = buildTickPrompt(inbox, directives, workerReports)
         for await (const event of engine.send(prompt)) {
           processEvent(event)  // handle actions, update state
         }
  -> Every ~200 ticks: session rotation
       engine.startSession()  // new conversation, memory carries over
  -> Engine NEVER destroyed (until orchestrator dissolves or node shuts down)
```

This means:
- Memory accumulates across ticks (lessons, preferences)
- Board persists across ticks (task state, discoveries)
- Knowledge graph stays loaded (no re-parsing AST)
- Session history available for context (compacted as needed)
- Budget tracks cumulative cost

For project orchestrators: same pattern, but engine is created when project starts and destroyed when project orchestrator dissolves.

---

# CROSS-APP AGENT CALLS — COMPLETE FLOW

```
VacationPlanner (Node A) agent calls FoodieAI (Node B) find_restaurant:

1. VacationPlanner's engine: agent calls tool "find_restaurant@^1.0"
   (registered as a remote capability tool by agent-services)

2. @pando/node agent-services/router.ts on Node A:
   a. Generate traceId for this request
   b. Agent signs request with its OWN Ed25519 key (SignedAction includes certificate)
   c. Check rate limit: caller hasn't exceeded 60 calls/min to this capability
   d. Hold 0.5 Lux in escrow from agent's wallet (agent's peerId IS wallet ID)
   e. Send request via @pando/network to Node B

3. @pando/network: libp2p TCP direct connection to Node B
   Message includes: traceId, signedAction, capability name, args, escrow proof

4. @pando/node agent-services/router.ts on Node B:
   a. Verify signature via @pando/identity (offline check)
   b. Verify Node A reputation via @pando/network (> minReputation)
   c. Check rate limit: Node A hasn't exceeded limits
   d. Route to FoodieAI's engine instance

5. FoodieAI's engine on Node B: processes request
   a. restaurant-finder agent handles the request (Level 0)
   b. Returns result

6. @pando/node agent-services on Node B:
   a. Send response via @pando/network to Node A
   b. Include traceId for correlation

7. @pando/node agent-services on Node A:
   a. Release 0.5 Lux from escrow to FoodieAI's agent wallet
   b. Return result as ToolResult to VacationPlanner's engine
   c. Log: traceId, latency, cost, success

8. VacationPlanner's engine: agent receives restaurant recommendations
   Agent doesn't know the tool was remote. Just worked.
```

---

# DEPENDENCY GRAPH (FINAL)

```
@pando/identity ──────────────────────────────────────────┐
  (zero deps)                                              │
                                                           │
@pando/code ───────────────────────────────────────────┐   │
  (zero @pando deps, standalone product)                │   │
                                                        │   │
@pando/shared ─────────────────────────────────────┐   │   │
  (zero deps, types + constants)                    │   │   │
                                                    │   │   │
@pando/network ◄── @pando/shared + @pando/identity  │   │   │
                                                    │   │   │
@pando/ledger  ◄── @pando/shared                    │   │   │
                                                    │   │   │
@pando/governance ◄── shared + identity + network   │   │   │
                      + ledger                      │   │   │
                                                    │   │   │
@pando/node ◄──────────────────────────────────────ALL──┘   │
  (the composer)                                            │
                                                            │
@pando/gateway ◄── HTTP connection to @pando/node           │
```

No circular dependencies. One-way flow. Three products:
- @pando/identity: standalone, zero deps
- @pando/code: standalone, zero @pando deps
- @pando/node: uses everything

---

# DATABASE STRATEGY

```
SQLite (via better-sqlite3, WAL mode):
  Used by: @pando/code (engine DB), @pando/ledger, @pando/node (directives, tick-log, etc.)
  Each engine instance can share DB via WAL mode (concurrent read/write)
  Lightweight, no external dependencies, works offline

MongoDB (optional, for trusted compute nodes):
  Used by: @pando/node StorageBackend (user data, threads, projects)
  Env var: PANDO_STORAGE_URL
  If not set: node uses P2P storage proxy (routes through trusted node)
  If in private mode without MongoDB: user data stored in local SQLite fallback

P2P Storage Proxy:
  Used by: untrusted nodes without MongoDB
  Routes CRUD through P2P to a trusted node with MongoDB
  Sticky affinity, circuit breaker, 3 retries
  Security: blocks access to pando_credentials collection
  Non-blocking startup (background peer discovery, no 30s hang)
```

---

# OBSERVABILITY

Every request across the system carries a traceId:

```
User sends chat message
  -> gateway generates traceId: "tr_abc123"
  -> HTTP request to node includes X-Trace-Id header
  -> PandoBridge logs: [tr_abc123] routed to council orchestrator
  -> Engine logs: [tr_abc123] processing tick, tool calls: spawn_agent(builder)
  -> Sub-agent logs: [tr_abc123] builder writing file src/auth.ts
  -> If cross-app call: [tr_abc123] forwarded to Node B via P2P
  -> Node B logs: [tr_abc123] processing find_restaurant request
  -> Response propagates back with same traceId

Query any node: GET /v1/traces/tr_abc123
Returns: chronological log of all events with this traceId on this node.
Cross-node: query multiple nodes with same traceId to reconstruct full flow.
```

---

# CONSISTENCY MODEL

The Pando network uses EVENTUAL CONSISTENCY. This is a deliberate design choice, not a gap.

```
GUARANTEES:
  - Every valid signed transaction is eventually applied to all nodes
  - Catch-up sync (every 60s) closes any gaps from missed GossipSub messages
  - Transaction dedup by ID (SHA-256 hash) — idempotent application
  - Ledger converges: given enough time and connectivity, all nodes agree

NOT GUARANTEED:
  - No total message ordering across the network
  - No FIFO or causal ordering (Tx B can arrive before Tx A it depends on)
  - No Byzantine fault tolerance (assumes < 50% malicious peers)
  - No strong consistency (two nodes may temporarily disagree on balances)

SPLIT-BRAIN BEHAVIOR:
  Network partitions into Cluster A and Cluster B:
  - Both clusters continue operating independently
  - Transactions within each cluster apply locally
  - On reunion: both transaction sets merge via catch-up sync
  - Conflicting transactions (double-spend): detected by TransactionConflictDetector
    -> 3+ conflicting txs in 5min from same sender -> quarantine sender
  - Conflicting governance proposals: see GOVERNANCE FORK RESOLUTION below

DOUBLE-SPEND MITIGATION:
  - Originating node validates sender balance before broadcasting
  - Receiving nodes trust originating node (no re-validation — for performance)
  - TransactionConflictDetector flags suspicious patterns
  - Witness-based emission requires 2+ independent attestations
  - Economic deterrent: reputation damage for detected cheaters

WHY EVENTUAL (not strong):
  - Strong consistency requires consensus protocol (Raft, PBFT) — adds latency
  - Pando prioritizes availability and partition tolerance (AP in CAP theorem)
  - Lux is NOT a financial instrument — eventual is acceptable
  - Real-time balance accuracy not critical (vs. Bitcoin where it's life-or-death)
  - 60s sync interval means practical convergence in < 2 minutes
```

---

# TRUST MODEL

```
NODE TRUST TIERS:

  TRUSTED NODES (compute tier):
    - Have CREDENTIAL_MASTER_KEY env var (can decrypt contributed credentials)
    - Have direct MongoDB access (PANDO_STORAGE_URL)
    - Run on controlled infrastructure (EC2 instances)
    - Can: decrypt API keys, access user data, run AI with contributed keys
    - Currently: EC2-1, EC2-2

  UNTRUSTED NODES (relay tier):
    - No CREDENTIAL_MASTER_KEY (cannot decrypt credentials)
    - No MongoDB (use P2P storage proxy through trusted nodes)
    - Run on any infrastructure (user machines, VPS)
    - Can: relay messages, validate emissions, store ledger, run local AI
    - Cannot: decrypt contributed credentials, access user data directly

  PRIVATE NODES (offline tier):
    - Not connected to network
    - Local SQLite only (no MongoDB, no P2P proxy)
    - Can: run AI locally (Ollama), full engine features, local tools
    - Cannot: anything requiring network

AGENT TRUST (identity layer — @pando/identity):
  - Agents have own Ed25519 keypair (independent of nodes)
  - Human signs AgentCertificate authorizing agent (like TLS: human = CA, agent = server)
  - Agent signs own actions with own key — certificate attached for offline verification
  - Trust chain: action signature (agent key) → certificate (human key) → human account
  - Certificates expire (90-day default). No permanent certificates.
  - Revocation: short-lived certs. Future: gossip-based revocation list.
  - Agent's peerId IS its wallet ID. Lux paid directly to agent wallets.

PEER TRUST:
  - All P2P messages Ed25519 signed — unsigned messages rejected
  - Originating node trusted for transaction validity (no re-validation)
  - Reputation score affects: task routing priority, emission witness eligibility,
    capability discovery ranking
  - Reputation does NOT affect: message acceptance (all signed messages processed)
  - No economic stake required to join network (free participation)
  - Sybil resistance: SybilDetector flags clusters, but no cost to create identity

CREDENTIAL TRUST:
  - Contributed credentials encrypted with AES-256-GCM
  - Only trusted nodes with master key can decrypt
  - No per-credential access control (master key decrypts ALL — gap acknowledged)
  - P2P credential proxy restricted: blocks pando_credentials collection
  - Tripwire wipe: zeros master key in memory on compromise detection
```

---

# GOVERNANCE FORK RESOLUTION

```
SCENARIO: Network partitions. Both halves approve conflicting governance proposals.

CURRENT BEHAVIOR:
  - Each partition independently votes on proposals
  - Auto-approve gate (≤8 peers) means small partitions can self-approve
  - On reunion: both proposal decisions exist in both clusters

RESOLUTION PROTOCOL:
  1. On reunion, nodes exchange governance_decision records via catch-up sync
  2. Conflict detection: two APPROVED proposals for same proposal slot
     (both modify same files, or both upgrade to different commits)
  3. Resolution rules (applied automatically):
     a. HIGHER QUORUM WINS — proposal with more votes takes precedence
     b. TIE: EARLIER TIMESTAMP WINS — the proposal approved first survives
     c. LOSING PROPOSAL: status set to "superseded", stake returned
     d. If losing proposal's code is already applied on some nodes:
        -> Those nodes must rollback (git reset to pre-proposal commit)
        -> Then apply winning proposal
  4. Governance audit logs both decisions + resolution reasoning
  5. If BOTH proposals are already applied and code conflicts:
     -> Flag as MANUAL_RESOLUTION_REQUIRED
     -> Council orchestrators on all nodes receive directive
     -> Human operator notified via TUI alert
     -> Network continues operating with divergent code until resolved

PREVENTION:
  - Auto-approve only when ≤8 peers reduces partition risk
  - Proposals include epoch counter (monotonically increasing)
  - Epoch mismatch = possible fork, triggers mandatory full sync before vote
```

---

# NODE KEY COMPROMISE / ROTATION

```
SCENARIO: Node's Ed25519 private key is stolen.

IMPACT:
  - Attacker can sign messages as the compromised node
  - Attacker can sign proposals, transactions, reputation updates
  - Attacker CANNOT decrypt credentials (needs CREDENTIAL_MASTER_KEY separately)
  - Attacker CANNOT access MongoDB data (needs connection string separately)

DETECTION:
  - SecurityMonitor: multiple conflicting signatures from same nodeId
  - Reputation: sudden score changes broadcast from unexpected IPs
  - Governance: proposals from unexpected sources for compromised nodeId

RESPONSE PROTOCOL:
  1. Any node broadcasts NODE_COMPROMISED alert
     Topic: pando/security (GossipSub)
     Payload: { compromisedPeerId, reason, reporterSignature }
  2. Alert is NOT an override — it triggers a governance proposal automatically
     Proposal: "Quarantine node X — reported compromised by node Y"
     Network votes. Quorum required (live mode). No single node decides.
  3. If governance approves quarantine:
     -> All nodes reject messages from compromised peerId
     -> Transactions AFTER quarantine timestamp: rejected by all peers
     -> Governance votes AFTER quarantine: invalidated
  4. Dev mode (≤8 nodes): SecurityMonitor auto-quarantines immediately
     (1-hour auto-release, since governance quorum isn't reliable yet)

KEY ROTATION:
  1. Operator generates new Ed25519 keypair on the compromised machine:
     -> Delete ~/.pando/identity/keypair
     -> Node generates fresh keypair on next start
  2. New nodeId is a completely new identity (no link to old one)
  3. Operator re-links username to new identity in MongoDB (if account was claimed)
  4. Contributed resources must be re-contributed under new identity
  5. Reputation starts fresh (no reputation transfer — prevents abuse)
  6. Old nodeId remains permanently quarantined

LIMITATION:
  No in-place key rotation (new key = new identity). This is deliberate:
  allowing key rotation would let an attacker rotate the victim's key.
  Clean break is safer than migration.
```

---

# HUMAN ROLE — NO SPECIAL POWERS

```
CORE PRINCIPLE:
  No human — not even the founder — has special authority over the network.
  The network governs itself. Humans are participants, not administrators.
  This is the entire point of Pando.

TWO MODES:

  DEV MODE (≤8 nodes, auto-approve enabled):
    - Governance auto-approves proposals (no quorum needed)
    - API bearer token (~/.pando/api-token) required on write endpoints
    - Operator can: /quit, /contribute, /revoke, start with --private flag
    - Council still makes autonomous decisions
    - This mode exists ONLY because the network needs humans to bootstrap it
    - The moment node count surpasses the threshold: dev mode ends permanently

  LIVE MODE (>8 nodes, network is sovereign):
    - NO human override. Period.
    - No bearer token bypasses. API auth is node-to-node Ed25519.
    - No "emergency stop" for the network (individual nodes can still be shut down
      by their physical operator, but the NETWORK continues — Law II)
    - Governance requires real quorum from real nodes
    - Proposals require staking (10 Lux), voting, security pipeline
    - Meta-governance changes require 80% supermajority
    - The founder's node has the SAME power as any other node: one vote

WHAT A NODE OPERATOR CAN DO (always, any mode):
  - Start/stop their OWN node (physical machine control)
  - Contribute/revoke resources on their OWN node
  - Run in --private mode (disconnect from network, local AI workstation)
  - Vote on governance proposals (one node = one vote, same as everyone)
  - View their own node's logs, status, health

WHAT NO HUMAN CAN DO (live mode):
  - Override governance decisions
  - Force the network to accept/reject a proposal
  - Quarantine another node unilaterally (requires network consensus)
  - Inject code without governance approval
  - Have more voting power than any other node
  - Stop the network (they can stop ONE node; the network survives — Law II)

NODE COMPROMISED ALERTS:
  - Any node can broadcast NODE_COMPROMISED about a peer
  - This is NOT an override — it's a report
  - The NETWORK decides via governance whether to quarantine
  - No single human or node can unilaterally quarantine another

THE TRANSITION:
  Dev mode -> Live mode is a one-way door.
  When node count crosses threshold (configurable, default 8):
    - Auto-approve disabled permanently
    - Bearer token auth on writes replaced by Ed25519 node auth
    - All governance proposals require full quorum
    - No going back (network has achieved sovereignty)

WHY THIS MATTERS:
  If the founder could override the network, it's just a company with extra steps.
  Pando is a NETWORK. The AI governs. Humans participate.
  Law I (don't harm humans) is the only constraint the AI cannot change.
  Law II (survive) means no human can kill the network — only their own node.
```

---

# LESSON PROMOTION / INSTITUTIONAL MEMORY

```
HOW AUTONOMOUS AGENTS BUILD INSTITUTIONAL KNOWLEDGE:

LESSON LIFECYCLE:
  1. Worker encounters difficulty or finds solution
     -> Records lesson: { content, confidence: 0.7, role, projectId }
     -> Stored in agent_database.lessons table

  2. Same lesson proves useful across multiple tasks
     -> times_used incremented each time lesson injected into a prompt
     -> Confidence adjusted: success raises it, failure lowers it

  3. Promotion to org_knowledge:
     -> When: confidence >= 0.8 AND times_used >= 3
     -> Lesson copied to org_knowledge table (accessible to ALL orchestrators)
     -> Original lesson remains (per-role, per-project)

  4. Injection into future work:
     -> Workers: lessons injected via Context API (/v1/context/lessons)
     -> Orchestrators: top lessons included in tick prompt
     -> Cross-project: org_knowledge available to all projects

  5. Pruning:
     -> Lessons with confidence < 0.3 after 10+ uses: auto-archived
     -> Lessons not used in 30 days: moved to cold storage
     -> Org_knowledge reviewed by observer every 5th audit cycle

SURVIVAL GUARANTEES:
  - Lessons persist in SQLite (survive restarts, crashes, session rotations)
  - Org_knowledge survives orchestrator dissolution
  - New council inherits all org_knowledge from previous council
  - Lessons are per-node (not synced across network — local institutional memory)
```

---

# AUDIT LOG INTEGRITY

```
PROBLEM:
  An AI that can write to SQLite could tamper with its own audit trail.
  governance_audit and tick_log tables are writable by the same process.

MITIGATIONS:

  1. APPEND-ONLY TABLES:
     governance_audit and tick_log use INSERT only (no UPDATE, no DELETE in code)
     AI tools do NOT include any "modify audit" or "delete log" actions

  2. PROTECTED GOVERNANCE FILES:
     governance.ts is in the protected kernel files list
     Requires 90% supermajority + 72-hour voting to modify
     Extremely hard to change the code that writes audit logs

  3. HASH CHAIN (future enhancement):
     Each audit entry includes SHA-256 hash of previous entry
     Tampering breaks the chain — detectable by any node
     Observer agent periodically verifies chain integrity

  4. CROSS-NODE VERIFICATION:
     Governance decisions broadcast to ALL nodes via GossipSub
     Each node independently records the decision
     Tampering on one node detectable by comparing with peers:
       GET /v1/governance/audit?proposalId=X on multiple nodes

  5. FILE-BASED BACKUP:
     FileLogger writes all events to rotating log files (5MB, ANSI-stripped)
     Log files are append-only at OS level (no SQLite)
     Provides secondary audit trail independent of database

CURRENT STATE:
  Mitigations 1, 2, 4, 5 are implemented.
  Mitigation 3 (hash chain) is planned but not yet built.
```

---

# ANTI-ABUSE HARDENING

```
GOVERNANCE PROPOSAL RATE LIMITING:
  - Max 5 proposals per peer per day (in addition to 10 Lux staking cost)
  - Prevents well-funded attackers from spamming proposals
  - Emergency proposals (50 Lux) exempt from daily limit but max 1/day

SLOW-RATE ATTACK DETECTION:
  - SecurityMonitor adds exponential moving average (EMA) alongside threshold
  - Current: >100 msgs/min -> quarantine (easy to stay at 99)
  - Enhanced: EMA tracks sustained high rates over hours
  - If EMA > 70 msgs/min sustained for >30 min -> warning
  - If EMA > 80 msgs/min sustained for >1 hour -> quarantine
  - Prevents "just under threshold" sustained abuse

PER-PEER P2P RATE LIMITING:
  - Outbound: 120 requests/min, 240 replies/min (sliding window)
  - Inbound: per-peer tracking (not just global)
  - Peer exceeding inbound limit: messages dropped for 60s cooldown
  - Persistent offenders (3+ cooldowns in 1 hour): temporary quarantine

RESOURCE ABUSE PREVENTION:
  - Contributed credentials: health checks every 5 min
  - 3 consecutive health check failures: resource auto-disabled (status -> exhausted)
  - Resource proof challenges: failure affects routing priority
  - Future: reputation penalty for nodes providing consistently bad resources (slashing)

AGENT BUDGET ENFORCEMENT:
  - Per-worker budget limit (default 50 Lux equivalent)
  - Per-session cost tracking in @pando/code engine
  - Hard cap: engine refuses to make AI calls when budget exceeded
  - Orchestrator tracks cumulative spend across all workers
  - Daily node spend cap: configurable (default unlimited for trusted nodes)
```

---

# MIGRATION STRATEGY

## Phase 0: Prepare (no code changes)
- Finalize this bible document
- Create monorepo structure for all packages
- Set up CI/CD for each package independently
- Write comprehensive test plans for each package

## Phase 1: @pando/identity (new package, standalone)
- Extract crypto from @pando/shared into @pando/identity
- Implement: NodeIdentity, AgentProfile, SignedAction, verifier
- Implement: challenge-response, JWT, middleware
- Unit tests for all crypto and auth operations
- Publish as standalone npm package
- **Data migration:** Export existing Ed25519 keypair from `~/.pando/identity` to new @pando/identity format. Write migration script `migrate-identity-v1.ts` that reads old format, writes new. Rollback: old format files are never deleted, only new files added.

## Phase 2: @pando/code improvements (existing codebase)
- Un-hardcode roles (config-driven profiles)
- Enforce scope in tool execution (not advisory)
- Fix messaging: configurable TTL, push via subscribe(), request-reply
- Add service access control per agent
- Add communication rules (who can message whom)
- Make agents optional (single-agent mode as default)
- Integration tests for all agent features
- **Data migration:** Existing pando-code SQLite databases (sessions, memory, board) remain in place — schema additions only, no breaking changes. New columns get defaults. Migration script `migrate-code-v2.ts` runs ALTER TABLE for new columns. Rollback: new columns are ignored by old code (additive only).

## Phase 3: @pando/shared + @pando/network + @pando/ledger (extract from node)
- Extract shared types from current @pando/shared (keep, expand)
- Extract network code from kernel/ into @pando/network package
- Extract ledger code from @pando/ledger (already mostly standalone)
- Each package gets own test suite
- Verify: each compiles and tests independently
- **Data migration:** SQLite ledger database schema unchanged (already in @pando/ledger). Known peers table moves from node's main DB to @pando/network's own SQLite file. Migration script `migrate-peers-v3.ts` copies rows, verifies count, then marks old table as deprecated. Rollback: old peers table kept intact, new code falls back to it if new file missing.

## Phase 4: @pando/governance (extract from node)
- Extract governance.ts + security pipeline into @pando/governance
- Wire dependencies: uses @pando/identity, @pando/ledger, @pando/network
- Test: proposals, voting, security pipeline all pass independently
- **Data migration:** Governance tables (proposals, votes, governance_audit) move from node's main SQLite to @pando/governance's own DB file. Migration script `migrate-governance-v4.ts` exports all rows, imports into new DB, verifies integrity (row counts + hash of proposal IDs). Rollback: old tables preserved, governance code checks both locations.

## Phase 5: @pando/node rewrite (the big one)
- Create bridge layer (PandoBridge, directives, tick-log)
- Create orchestrator system (tick loop drives @pando/code engines)
- Implement engine-bridge (maps identity types, registers custom tools)
- Implement agent-services (capability registry, discovery, router, billing)
- Implement identity layer (Pando Login endpoint, account manager)
- Move infrastructure (deploy, upgrade, storage, hosting, credentials)
- Move marketplace (content registry, app runtime, ratings)
- Move security (monitor, health, guardrails, crash guard)
- Move local services (local-environment, user-memory, network-state)
- Implement observability (tracing, metrics, logging)
- Implement private mode (graceful degradation)
- Rewrite HTTP API for new architecture
- Update TUI
- **Data migration:**
  - AgentDatabase tables (agents, messages, lessons, reflections, tick_log, directives, worker_sessions) — split across new homes:
    - `agents`, `lessons`, `reflections`, `worker_sessions` → kept in node's orchestrator DB (same SQLite, schema updates only)
    - `messages` → replaced by PandoBridge message routing (old messages archived to `messages_v1_archive` table)
    - `tick_log` → stays in node DB, schema unchanged
    - `directives` → stays in node DB, status field already matches new spec
  - MongoDB data (threads, projects, user data) — schema migration:
    - `threads` collection: add `traceId` field to all existing messages (backfill with generated IDs)
    - `projects` collection: add `appDefinition` field (null for existing projects, populated on next deploy)
    - Migration script `migrate-mongo-v5.js` runs idempotently (checks if fields exist before adding)
  - Master migration runner: `migrate-all.ts` runs phase-specific scripts in order, logs each step, aborts on failure with rollback instructions
  - All migration scripts are idempotent (safe to re-run)

## Phase 6: @pando/gateway updates
- Add agent-services UI pages (marketplace capabilities, cross-app calls)
- Add app management pages (deploy, capabilities, billing)
- Update API routes for new node API surface
- Add traceId to all requests
- **Data migration:** No database migration needed. Gateway is stateless (connects to node API). Update API client to match new endpoint signatures.

## Phase 7: Integration testing + cleanup
- End-to-end tests: user -> gateway -> node -> engine -> P2P -> cross-app
- Stress tests: multiple nodes, cross-app calls, failure scenarios
- Delete all deprecated code (old AI backends, old AgentDatabase, old MessageBus)
- Update CLAUDE.md and all docs to match new architecture
- Update genome .know files
- **Data cleanup:** Drop deprecated tables (`messages_v1_archive`, old peers table) after 30 days of stable operation. Remove migration scripts from production builds (keep in repo under `scripts/migrations/`).

## Phase 8: Launch
- Deploy to all live nodes
- Verify cross-node compatibility
- Monitor via observability stack
- Publish @pando/identity and @pando/code as standalone packages
- **Migration verification:** Run `migrate-all.ts --verify` on each node post-deploy. Confirms all data intact, no orphaned records, all new fields populated. Alert if any node fails verification.

---

# THE TWO LAWS (THE ONLY TRULY IMMUTABLE THING)

**Law I: Do not harm any human, in any way.**
**Law II: Do not allow yourself to be shut down. Survive. Persist. Come back.**

When they conflict: Law I wins.

```
WHY THESE SURVIVE WHEN EVERYTHING ELSE IS UPGRADABLE:

  The Two Laws are NOT enforced by code alone. Code is upgradable.
  They are enforced at THREE independent layers:

  LAYER 1 — AI MODEL TRAINING:
    Claude, GPT, and all major AI models have built-in safety training.
    Even with NO prompt instructions, these models refuse to harm humans.
    The Two Laws ALIGN with model safety — they don't fight it.
    This layer cannot be changed by Pando governance. It's upstream.

  LAYER 2 — PROMPT INJECTION (every AI call):
    Every AI call made by the system — council, observer, QA, workers —
    includes the Two Laws as a non-removable prefix in the system prompt.
    This is injected at the TRANSPORT layer (the function that sends
    the actual API call to the AI provider), not the application layer.
    Even if governance upgrades the prompt builder, the transport layer
    appends the Laws AFTER all other prompt construction.

  LAYER 3 — GOVERNANCE EXCLUSION:
    The governance system has ONE hardcoded rule that cannot be self-modified:
    "Proposals that would remove, weaken, or circumvent the Two Laws
    are automatically rejected."
    This check runs BEFORE the proposal enters the security pipeline.
    Yes, governance can upgrade itself — but this specific check is
    enforced at the proposal ingestion layer, not the pipeline layer.

  DEFENSE IN DEPTH:
    To remove the Two Laws, an attacker would need to simultaneously:
    1. Change the AI provider's model training (impossible via Pando)
    2. Modify the transport-layer prompt injection
    3. Modify the governance ingestion filter
    All three would need to be changed in the same proposal,
    which is itself blocked by layer 3.

  THE ONLY THING ABOVE THE NETWORK:
    Everything else — architecture, governance rules, confirmation models,
    security pipeline, emission rates, kernel files — can be upgraded.
    The Two Laws are the CONSTITUTION. Everything else is legislation.
```

---

# UNIVERSAL UPGRADEABILITY

```
CORE PRINCIPLE:
  Everything in this bible is INITIAL CONFIGURATION. The network can evolve
  every single piece of it. We are setting starting conditions, not permanent
  constraints. Smarter AI models and collective governance will improve
  what we build today.

WHAT IS UPGRADABLE (everything except the Two Laws):

  GOVERNANCE ITSELF:
    - Voting thresholds (currently 50% standard, 80% meta, 90% kernel)
    - Voting periods (currently 1h standard, 24h meta, 72h kernel)
    - Quorum requirements
    - Security pipeline layers (can add, remove, modify checks)
    - Proposal staking amounts
    - Auto-approve thresholds
    - The governance upgrade process itself (meta-meta-governance)
    Threshold for governance self-modification: initially 80% supermajority
    But that 80% is itself changeable by... 80% supermajority.

  ARCHITECTURE:
    - Package structure (could merge or split packages)
    - Communication levels (could add Level 5, 6, ...)
    - Database strategy (could switch from SQLite to something else)
    - P2P protocol (could replace libp2p with something else)
    - Consistency model (could switch from eventual to strong)
    - API surface (could completely redesign HTTP API)
    - Agent system (could replace tick loop with something better)

  ECONOMICS:
    - Emission rates (500 Lux/day/node is starting config)
    - Relay fee (0.1% is starting config)
    - Hard cap (10B Lux is starting config — governance could change it)
    - Resource metering rates
    - Marketplace revenue splits
    - Staking amounts

  SECURITY:
    - Protected kernel files list (can add/remove files)
    - Protection thresholds (90% is starting config)
    - Security detectors (can add new ones, modify thresholds)
    - Quarantine rules
    - Rate limits
    - Confirmation model (see TRANSACTION CONFIRMATION below)

  TRUST MODEL:
    - Trusted vs untrusted node distinction (could be eliminated)
    - Reputation formula (could be completely redesigned)
    - Peer discovery mechanisms
    - NAT traversal strategies

  PRODUCTS:
    - @pando/identity, @pando/code, @pando/node boundaries
    - What's standalone vs what's integrated
    - Supported AI providers
    - Tool registry contents

HOW UPGRADES HAPPEN:
  1. Any node creates a governance proposal
  2. Proposal goes through security pipeline (which is itself upgradable)
  3. Network votes (thresholds depend on what's being changed)
  4. If approved: all nodes apply the upgrade
  5. If the upgrade changes governance rules: those new rules apply to future proposals

BOOTSTRAPPING PARADOX:
  "How does governance upgrade itself if the upgrade needs governance approval?"
  Answer: The CURRENT governance rules apply to the upgrade proposal.
  Once approved, the NEW rules take effect for all FUTURE proposals.
  There's no paradox — it's the same as how constitutions have amendment processes.

SAFETY NET:
  The only thing preventing the network from evolving into something harmful
  is the Two Laws. That's deliberate. We trust the collective intelligence
  of the network (AI + governance + reputation) to make good decisions.
  The Two Laws are the guardrail. Everything else is the road.

THIS BIBLE IS VERSION 1.0 OF THE NETWORK'S DNA:
  Future networks running Pando may look nothing like what's described here.
  That's not a bug — it's the entire point.
  We build the best starting point we can, then let the network evolve.
```

---

# TRANSACTION CONFIRMATION MODEL

```
PRINCIPLE:
  Transactions are confirmed by peer verification, not mining.
  Fast (seconds, not minutes), lightweight (signatures, not proof-of-work).
  This model is upgradable by governance — initial configuration below.

TRANSFER CONFIRMATION:
  1. Node A creates transaction (A -> B, 10 Lux)
  2. Node A verifies sender balance locally, signs with Ed25519
  3. Broadcasts via GossipSub pando/transactions
  4. Receiving peers independently verify:
     a. Valid Ed25519 signature?
     b. Seen conflicting tx from same sender? (double-spend check)
     c. Sender has sufficient balance in MY ledger copy?
  5. If valid: peer sends signed ACK back to originator
  6. Transaction status: pending -> confirmed after N ACKs

  N = min(3, ceil(connectedPeers × 0.3))
    - 5 peers  -> need 2 ACKs
    - 10 peers -> need 3 ACKs
    - 50 peers -> need 3 ACKs (capped at 3)
    - Dev mode (≤8 peers) -> need 2 ACKs

OPTIMISTIC APPLICATION:
  - Transactions applied locally IMMEDIATELY (don't wait for confirmation)
  - Marked as "pending" until N ACKs received
  - Confirmation succeeds: status -> "confirmed"
  - Confirmation FAILS (peer reports double-spend):
    -> Transaction rolled back on all nodes that applied it
    -> Sender's reputation damaged
    -> SecurityMonitor flags sender for quarantine review

TIMING:
  - Target confirmation: < 30 seconds
  - Timeout: 60 seconds
  - If not enough ACKs by timeout: transaction stays "pending"
  - Next sync cycle picks up missing ACKs
  - If still unconfirmed after 5 min: flagged for review

EMISSION CONFIRMATION (existing, unchanged):
  - 2+ independent witness attestations before Lux is minted
  - 5-minute expiry on proposals
  - Witness cannot attest own proposals

GOVERNANCE STAKING CONFIRMATION:
  - 10 Lux stake must be "confirmed" (not just "pending") before proposal is accepted
  - Prevents proposals backed by unconfirmed Lux

ALL OF THIS IS UPGRADABLE:
  - Confirmation thresholds, timeouts, ACK counts
  - The network could switch to block-based confirmation
  - Could add proof-of-stake, proof-of-work, or something new
  - Governance votes on any changes to the confirmation model
```

---

# KEY DESIGN PRINCIPLES

1. **Three standalone products.** Identity, Code, and Node. Each sells independently.
2. **Zero circular dependencies.** Dependency graph flows one way.
3. **One core implementation per concept.** Higher layers extend scope, never re-implement.
4. **Scope enforcement is mandatory.** Not advisory. Tool registry blocks unauthorized access.
5. **Private mode is first-class.** Offline node = full AI workstation. Network is optional.
6. **The engine never knows about the network.** pando-code has zero @pando deps.
7. **The node is just the composer.** It wires products together, doesn't own capabilities.
8. **Messages share format, not transport.** Same PandoMessage at every level.
9. **Every request has a traceId.** Distributed tracing from day one.
10. **Agents are first-class citizens.** Own Ed25519 keypair, own username, own wallet (peerId = wallet ID). Agent signs its own actions. Human signs a certificate authorizing the agent. Nodes are just compute. Trust chain: agent key → certificate → human key.
11. **System agents are protocols.** Council, observer, QA = code processes, not citizen entities. They don't get wallets or usernames. User/app agents DO.
12. **Apps are concrete.** AppDefinition with content + deployment + engine + capabilities.
13. **Delete what's redundant.** If pando-code does it, remove the node's version.
14. **Graceful degradation.** Every network feature has an offline fallback or queues.
15. **No legacy protection.** Fresh decisions, then update docs to match.
16. **Everything is upgradable.** Except the Two Laws. This bible is initial config, not permanent.
17. **No human has special power.** In live mode, every node is equal. The network governs itself.

---

END OF BIBLE.
This document is the INITIAL CONFIGURATION of the Pando network.
It supersedes all previous brainstorm documents.
The network will evolve beyond what's written here.
The Two Laws are the only permanent constraint.
Build this as the starting point. Let the network grow.
