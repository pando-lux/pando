# Pando → Genome Migration Plan

**This is an execution plan for AI agents. Read every section before starting work.**

*Created: 2026-02-26. Owner: Jai. Status: READY TO EXECUTE.*

---

## How to Read This Plan

This plan migrates Pando's entire knowledge system from hand-maintained markdown docs to a compiled, verifiable knowledge graph using the Desktop Genome compiler.

**You are a coding agent assigned to execute one or more phases of this plan.**

Before starting:
1. Read this document in full
2. Read `C:\Users\jaira\Desktop\genome\PROTOCOL.md` (the Genome agent contract)
3. Read `C:\Users\jaira\Desktop\genome\spec\LANGUAGE.md` (KnowLang syntax)
4. Use the Todo Loop protocol from PROTOCOL.md — create a todo file before touching any code

**The genome compiler lives at:** `C:\Users\jaira\Desktop\genome\genome.py`
**The pando project lives at:** `C:\Users\jaira\Desktop\pando\`

All genome commands run from the pando project root: `cd C:\Users\jaira\Desktop\pando`

---

## Why This Exists

Pando's current documentation system:
- 56 manually-maintained component files (`genome/components/*.md`)
- 17 rule files, 23 flow files — all hand-written YAML + markdown
- Zero compiler enforcement — docs drift silently from reality
- An agent reading `genome/components/agent.md` has no guarantee it matches `packages/node/src/core/agent.ts`
- Three places describe the same architecture: `genome/components/`, `the-stack.md`, and `CLAUDE.md`

After this migration:
- Every architectural fact lives once — in `@know` blocks co-located with source code, or in standalone `.know` files
- The compiler checks every cross-reference at build time
- An agent calls `python genome.py query output/graph.json` and gets verified, current knowledge
- Stale docs fail the build — drift is a compile error, not a review gap
- 56 component files are deleted. The-stack.md is demoted. The graph is the authority.

---

## The New Architecture (Three Tiers)

```
┌─────────────────────────────────────────────────────────────────┐
│  TIER 1 — Code Knowledge (Genome owns)                          │
│                                                                   │
│  Source: @know blocks in .ts files + standalone .know files     │
│  What: component facts, API surfaces, bugs fixed, constants,    │
│        flows, rules, invariants, architectural decisions        │
│  Query: python genome.py query output/graph.json                │
│  Enforced by: genome.py verify (CI gate, exit 1 = hard block)  │
│                                                                   │
├─────────────────────────────────────────────────────────────────┤
│  TIER 2 — Architecture Knowledge (Genome-annotated .know files) │
│                                                                   │
│  Source: genome/knowledge/ (replaces genome/components/,        │
│          genome/rules/, genome/flows/)                          │
│  What: governance tiers, two laws, layer model, agent sandbox,  │
│        standard flows for QA, credential rules, p2p rules      │
│  Query: same graph — Tier 1 + Tier 2 compile into one graph    │
│  Enforced by: same genome.py verify                             │
│                                                                   │
├─────────────────────────────────────────────────────────────────┤
│  TIER 3 — Strategy Knowledge (plain markdown, NOT Genome)       │
│                                                                   │
│  Source: docs/pando/ (go-to-market, economics, marketing,       │
│          investors, open questions, launch plan)                │
│  What: business thinking, market analysis, brainstorms,         │
│        investor materials, product positioning                  │
│  Query: read files directly — no compiler needed here           │
│  Connection to Tiers 1+2: concept nodes in Genome reference     │
│  these docs by path (linked, not compiled)                      │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## What Gets Deleted vs Kept

### DELETE after migration is verified:

```
genome/components/          ← all 56 .md files → replaced by @know blocks in source
genome/genome.yaml          ← replaced by graph.json
genome/state.md             ← tech debt → @know audit nodes; runtime state is not a doc
genome/v2-architecture-plan.md    ← stale sprint artifact
genome/v2-execution-log.md       ← stale sprint artifact
genome/state-e2e-gaps.md         ← stale test gap doc
genome/resource-tier-plan.md     ← stale phase plan (complete)
genome/protocol.md          ← was an early stub, superseded by the-stack.md
genome/growth/              ← moved to docs/pando/06-marketing/ (already done)
genome/plans/               ← review: if superseded by roadmap.md, delete
genome/history/phases.md    ← completed phases. Archive in git history. Delete from repo.
genome/history/decisions.md ← migrate decisions to @know decision{} nodes, then delete
genome/history/open-questions.md ← already in docs/pando/03-strategy/open-questions.md. Delete.
```

### KEEP but transform:

```
genome/rules/*.md       → migrate to genome/knowledge/rules/*.know, then delete .md files
genome/flows/*.md       → migrate to genome/knowledge/flows/*.know, then delete .md files
genome/templates/*.md   → KEEP as functional agent templates (agents spawn with these)
                          BUT add @know template{} nodes in genome/knowledge/templates.know
genome/roadmap.md       → KEEP as planning doc (phases are planning, not architecture)
```

### DEMOTE (keep but no longer primary reference):

```
docs/pando/01-foundation/the-stack.md → becomes onboarding summary only.
    Remove: the 400-line layer-by-layer API surface descriptions (those move to @know blocks)
    Keep: The Principle, Six Laws, Three Operational Modes, Coding Agent Checklist
    The graph is the authority. The-stack.md is the front door.

CLAUDE.md (root) → update: remove component-by-component descriptions.
    Keep: How to Run, TUI commands, node flags, live network info.
    Add: "For architecture: run python genome.py query output/graph.json"
```

### KEEP unchanged:

```
docs/pando/              ← all strategy docs stay exactly where they are
genome/roadmap.md        ← phase planning stays as markdown
genome/templates/*.md    ← agent prompt templates stay as functional files
packages/                ← source code unchanged (only @know blocks added)
tests/                   ← unchanged
```

---

## Phase A — Setup and Verify Genome Works (1 agent, ~1 hour)

**Goal:** confirm the Genome compiler runs, understand its output format, and prepare the output directory.

### A1. Read Genome Documentation

```bash
# Read these files completely before proceeding:
cat C:/Users/jaira/Desktop/genome/PROTOCOL.md
cat C:/Users/jaira/Desktop/genome/spec/LANGUAGE.md
cat C:/Users/jaira/Desktop/genome/README.md
```

### A2. Run Genome on Its Own Codebase

Genome already annotates itself (167 nodes). Run it to verify the compiler works:

```bash
cd C:/Users/jaira/Desktop/genome
python genome.py compile .
python genome.py verify .
python genome.py query output/graph.json
# At the query prompt, run:
# > status
# > guide COMPILER_PIPELINE
# > lessons critical
```

Expected: compile succeeds, verify exits 0, status shows 167+ nodes.

### A3. Create Output Directory in Pando

```bash
cd C:/Users/jaira/Desktop/pando
mkdir -p genome/knowledge/rules
mkdir -p genome/knowledge/flows
mkdir -p genome/knowledge/templates
mkdir -p output
```

### A4. Run Genome Migration Dry Run

```bash
# Dry run — shows what would be annotated without changing files
python C:/Users/jaira/Desktop/genome/genome.py migrate . --dry-run
```

Review the output. Note any errors or unexpected paths. Do not proceed to Phase B until dry run succeeds without fatal errors.

### A5. Create the Pando genome config

Create `C:\Users\jaira\Desktop\pando\genome.config.json`:

```json
{
  "project": "Pando Network",
  "source_roots": [
    "packages/node/src",
    "packages/shared/src",
    "packages/ledger/src",
    "packages/mcp-server/src",
    "packages/gateway/app",
    "packages/gateway/lib"
  ],
  "knowledge_roots": [
    "genome/knowledge"
  ],
  "output": "output/graph.json",
  "exclude": [
    "node_modules",
    "dist",
    ".next",
    "output"
  ]
}
```

**Phase A done when:**
- [ ] Genome compiler runs on its own codebase without errors
- [ ] Dry run on Pando completes without fatal errors
- [ ] Output directory exists
- [ ] Config file created

---

## Phase B — Source Code Migration (8 parallel agents, ~3 hours total)

**Goal:** add `@know` blocks to every TypeScript source file. Each block must be accurate — verified against the actual code in that file.

**Each domain agent works independently on one subdirectory.**

### The Standard for Each File

For every `.ts` file you annotate, you MUST:
1. **Read the file completely** before writing any `@know` block
2. **Verify the API surface** — every method listed in `exposes` must actually exist in the file
3. **Identify bugs or tech debt** in the code — document as `@know audit{}` or `@know lesson{}`
4. **Mark deprecated code** — if a function is dead/unused, mark it `@deprecated("reason")`
5. **Run compile after every 5 files** — catch errors early, not at the end
6. **Never guess** — if you are not sure what a function does, read the implementation

### KnowLang Quick Reference for TypeScript Files

```typescript
// @know
// entity AgentManager {
//   type: module
//   blueprint: AGENT_SYSTEM
//   status: active
//   summary: "Lifecycle manager for all agent instances. Owns spawn, message routing, cleanup."
//
//   @gotcha("Agent workspaces are ephemeral — DO NOT store results in workspace. Results go to StorageBackend.")
//   @why("Workspace cleanup is mandatory. Leaked workspaces hit disk limits fast.")
// }
// @end

// @know
// lesson BRIDGE_QUEUE_ORDERING {
//   in: AgentManager
//   what: "BridgeQueue is FIFO per-project. Multiple projects do NOT share a queue."
//   why: "Sharing queues caused message ordering violations across unrelated projects."
//   fix: "Always construct one BridgeQueue per projectId, never reuse across projects."
//   severity: critical
//   date: "2026-02"
// }
// @end
```

For standalone architecture (not tied to one source file), use `.know` files:

```
# genome/knowledge/rules/two-laws.know

invariant LAW_I {
  rule: "Do not harm any human, in any way."
  applies_to: [AllComponents]
  enforced_by: ContentSafetyReviewer
  severity: immutable
  @why("This is Tier 0. Not governable. Not overridable. No vote can change this.")
}
```

### B1 — Domain: kernel/ (assign 1 agent)

Files to annotate:
```
packages/node/src/kernel/network.ts        → blueprint: P2P_KERNEL
packages/node/src/kernel/sync.ts           → blueprint: P2P_KERNEL
packages/node/src/kernel/governance.ts     → blueprint: P2P_KERNEL
packages/node/src/kernel/monitor.ts        → blueprint: P2P_KERNEL
packages/node/src/kernel/guardrails.ts     → blueprint: P2P_KERNEL
packages/node/src/kernel/security-monitor.ts  → blueprint: P2P_KERNEL
packages/node/src/kernel/reputation.ts     → blueprint: P2P_KERNEL
packages/node/src/kernel/emission-witness.ts  → blueprint: P2P_KERNEL
```

Key things to document for each:
- What it does (entity)
- What it exposes (methods — verified against actual code)
- Known constraints (invariants — e.g., "guardrails cannot be disabled by agents")
- Any known bugs or edge cases (lessons)
- The governance tier for any changes (decision or @why annotation)

Specific lessons to document (from known bugs list in MEMORY.md):
```
kernel/governance.ts:
  - lesson: Governance proposal requires 10 Lux stake. Nodes with < 10 Lux cannot propose.
  - lesson: Founder veto only applies until Milestone 1 (10 unique operators).

kernel/network.ts:
  - lesson: Use 127.0.0.1 not localhost — IPv6 resolution causes gateway failures.
  - lesson: Ed25519 public key must be extracted from peerId string via peerIdFromString().publicKey
            NOT looked up in ledger (old approach stored 'remote-peer' as public key — root cause of cross-node auth failures).
```

### B2 — Domain: core/ (assign 1 agent)

Files to annotate:
```
packages/node/src/core/agent.ts                → blueprint: AGENT_SYSTEM
packages/node/src/core/agent-manager.ts        → blueprint: AGENT_SYSTEM
packages/node/src/core/ai-backend.ts           → blueprint: AGENT_SYSTEM
packages/node/src/core/ai-backend-registry.ts  → blueprint: AGENT_SYSTEM
packages/node/src/core/ai-backend-claude.ts    → blueprint: AGENT_SYSTEM
packages/node/src/core/ai-backend-ollama.ts    → blueprint: AGENT_SYSTEM
packages/node/src/core/storage-backend.ts      → blueprint: STORAGE_LAYER
packages/node/src/core/mongo-backend.ts        → blueprint: STORAGE_LAYER
packages/node/src/core/p2p-storage-backend.ts  → blueprint: STORAGE_LAYER
packages/node/src/core/bridge-queue.ts         → blueprint: AGENT_SYSTEM
packages/node/src/core/credentials.ts          → blueprint: CREDENTIAL_SYSTEM
packages/node/src/core/credential-store.ts     → blueprint: CREDENTIAL_SYSTEM
packages/node/src/core/deploy-manager.ts       → blueprint: DEPLOY_SYSTEM
packages/node/src/core/upgrade-protocol.ts     → blueprint: DEPLOY_SYSTEM
packages/node/src/core/payment-gate.ts         → blueprint: ECONOMY
packages/node/src/core/request-reply.ts        → blueprint: P2P_KERNEL
```

Critical lessons to document:
```
core/agent.ts:
  - lesson: stdin must be 'ignore' not 'pipe' for claude -p spawns.
  - lesson: Delete CLAUDECODE env var before spawning — prevents nested agent issues.
  - lesson: CREDENTIAL_MASTER_KEY + PANDO_STORAGE_URL must be stripped from agent child env (Phase 70).
  - lesson: Agent workspaces are EPHEMERAL. Results go to StorageBackend, not workspace files.

core/ai-backend-claude.ts:
  - lesson: claude -p --continue --resume <sessionId> for per-event spawn.
  - lesson: Context compression: inject critical instructions in event prompts, not just CLAUDE.md.

core/p2p-storage-backend.ts:
  - lesson: P2PStorageBackend auto-fails over to next available mongodb node if primary is down.
  - lesson: User nodes never get CREDENTIAL_MASTER_KEY or PANDO_STORAGE_URL — they proxy via P2P.

core/upgrade-protocol.ts:
  - lesson: git repo must be owned by pando user. npm ci runs as root during bootstrap → chown needed.
  - lesson: pando user needs git user.name + user.email set or upgrade commit fails.
  - lesson: Governance proposal stake: 10 Lux required. Transfer from another node first on new identities.
```

### B3 — Domain: platform/ (assign 1 agent)

Files to annotate:
```
packages/node/src/platform/scheduler.ts          → blueprint: PLATFORM_LAYER
packages/node/src/platform/task-queue.ts          → blueprint: PLATFORM_LAYER
packages/node/src/platform/resource-router.ts     → blueprint: RESOURCE_NETWORK
packages/node/src/platform/resource-marketplace.ts → blueprint: RESOURCE_NETWORK
packages/node/src/platform/resource-meter.ts      → blueprint: RESOURCE_NETWORK
packages/node/src/platform/capability-detector.ts → blueprint: RESOURCE_NETWORK
packages/node/src/platform/capability-registry.ts → blueprint: RESOURCE_NETWORK
packages/node/src/platform/council.ts             → blueprint: GOVERNANCE
packages/node/src/platform/content-registry.ts    → blueprint: CONTENT_LAYER
packages/node/src/platform/content-publish.ts     → blueprint: CONTENT_LAYER
packages/node/src/platform/content-maintenance.ts → blueprint: CONTENT_LAYER
packages/node/src/platform/content-safety.ts      → blueprint: CONTENT_LAYER
packages/node/src/platform/thread-store.ts        → blueprint: STORAGE_LAYER
packages/node/src/platform/hosting-service.ts     → blueprint: DEPLOY_SYSTEM
packages/node/src/platform/pipeline-runner.ts     → blueprint: DEPLOY_SYSTEM
packages/node/src/platform/qa-runner.ts           → blueprint: QA_SYSTEM
packages/node/src/platform/regression-suite.ts    → blueprint: QA_SYSTEM
packages/node/src/platform/agent-tools.ts         → blueprint: AGENT_SYSTEM
packages/node/src/platform/reputation-governance.ts → blueprint: GOVERNANCE
packages/node/src/platform/resource-proof.ts      → blueprint: RESOURCE_NETWORK
```

Critical lessons to document:
```
platform/scheduler.ts:
  - invariant: Scheduler is a PURE EXECUTOR. It dequeues and checks capacity only. No agent spawning. No decisions.
  - lesson: Violation of pure-executor rule caused deadlocks in Phase 11. Never add decision logic here.

platform/council.ts:
  - audit: runDailyReflection() AI call is STUBBED. Council does not actually call Claude yet.
           This is Phase 101. The AI call, spawnFixAgent, Tier 4 auto-approval, and patch application
           are all unimplemented. See genome/roadmap.md Phase 101.

platform/capability-registry.ts:
  - lesson: publicAddress field on CapabilityProfile must be set via PUBLIC_IP env var on EC2 nodes.
            Without it, Tier 2 deploys route to wrong IP.
```

### B4 — Domain: api/ (assign 1 agent)

Files to annotate:
```
packages/node/src/api/api-server.ts         → blueprint: API_LAYER
packages/node/src/api/kernel-api.ts         → blueprint: API_LAYER  (if exists)
packages/node/src/api/core-api.ts           → blueprint: API_LAYER  (if exists)
packages/node/src/api/platform-api.ts       → blueprint: API_LAYER  (if exists)
packages/node/src/api/middleware/           → blueprint: API_LAYER  (all files)
```

Critical lessons to document:
```
api/api-server.ts:
  - lesson: ALL routes prefixed /v1/ since v2.2. Any route without /v1/ prefix will 401 or 404.
  - lesson: Auth bypass existed for /v1/ prefixed routes — fixed commit b8e17b57. Document the fix.
  - lesson: Bearer token is in ~/.pando/api-token. Auto-generated 32-byte hex.
  - lesson: atob() fails on unpadded base64 public keys — fixed commit 043cece9. Document the pattern.
  - invariant: POST /auth routes are unauthenticated. All others require Bearer token.
```

### B5 — Domain: shared/ and ledger/ (assign 1 agent)

Files to annotate:
```
packages/shared/src/types.ts        → blueprint: SHARED_LAYER
packages/shared/src/crypto.ts       → blueprint: SHARED_LAYER
packages/ledger/src/index.ts        → blueprint: ECONOMY
packages/ledger/src/transactions.ts → blueprint: ECONOMY
```

Critical lessons to document:
```
packages/shared/src/crypto.ts:
  - lesson: Ed25519 keypair encrypted at rest with PBKDF2 + AES-256-GCM.
  - lesson: Multiple identities: ~/.pando/identities/<peerId>.json. Legacy: ~/.pando/identity.json.
  - lesson: Public key must be extracted via peerIdFromString().publicKey — never lookup in ledger.

packages/ledger/src/transactions.ts:
  - invariant: Hard cap 10,000,000,000 Lux. Network account NETWORK mints new Lux.
  - invariant: 0.1% relay fee on every transfer, paid to relay node.
  - lesson: Daily cap 500 Lux per node per day. Witness-based — requires 2+ peers to attest.
```

### B6 — Domain: entry points and config (assign 1 agent)

Files to annotate:
```
packages/node/src/index.ts      → blueprint: NODE_CORE
packages/node/src/cli.ts        → blueprint: NODE_CORE
packages/node/src/tui.ts        → blueprint: NODE_CORE
packages/node/src/config.ts     → blueprint: NODE_CORE
packages/node/src/logger.ts     → blueprint: NODE_CORE
packages/mcp-server/src/index.ts → blueprint: MCP_LAYER
packages/gateway/app/page.tsx   → blueprint: GATEWAY
packages/gateway/lib/node-connection.ts → blueprint: GATEWAY
```

Critical lessons to document:
```
packages/node/src/tui.ts:
  - lesson: TUI auto-creates identity on first run. No prompts unless existing identity is encrypted.
  - lesson: Use 127.0.0.1 in gateway PANDO_NODE_URL — never localhost (IPv6 failure).

packages/node/src/cli.ts:
  - lesson: Session-aware for encrypted identities. Session stored in ~/.pando/session.json.
  - lesson: /logout clears session.json. Node loses identity context until next login.
```

### B7 — Domain: tests/ (assign 1 agent)

Files to annotate:
```
tests/test-ledger.mjs       → document what this tests and its pass criteria
tests/test-two-nodes.mjs    → document what this tests
tests/test-gateway.mjs      → document: requires gateway running (Playwright)
```

Also create `@know test{}` nodes for each integration test category:
```
test P2P_PEER_DISCOVERY {...}
test LEDGER_TRANSFER {...}
test CROSS_NODE_STORAGE {...}
test GOVERNANCE_VOTE {...}
test DEPLOY_TIER1 {...}
test DEPLOY_TIER2 {...}
```

### B8 — Domain: gateway/ (assign 1 agent)

Files to annotate (key pages only — full gateway is large, focus on architecture):
```
packages/gateway/app/page.tsx
packages/gateway/app/chat/page.tsx
packages/gateway/app/governance/page.tsx
packages/gateway/app/wallet/page.tsx
packages/gateway/lib/use-sse.ts
packages/gateway/lib/node-connection.ts
```

Document the 9 gateway pages as flow nodes:
```
flow GATEWAY_CHAT_PAGE {...}
flow GATEWAY_GOVERNANCE_PAGE {...}
flow GATEWAY_WALLET_PAGE {...}
```

---

## Phase C — Architecture Knowledge Migration (2 agents, ~2 hours)

**Goal:** migrate `genome/rules/*.md` and `genome/flows/*.md` to standalone `.know` files in `genome/knowledge/`. These are architectural facts that are NOT tied to a single source file.

### C1 — Agent: Migrate Rules (1 agent)

For each file in `genome/rules/*.md`:
1. Read the rule file completely
2. Verify the rule is still accurate against current code
3. If rule references specific files/functions — read those files to confirm
4. Write to `genome/knowledge/rules/<rule-name>.know` as KnowLang
5. Note any drift found (rule says X, code does Y)

Example output format:
```
# genome/knowledge/rules/two-laws.know

invariant LAW_I {
  rule: "Do not harm any human, in any way."
  applies_to: [ContentSafetyReviewer, AgentManager]
  enforced_by: ContentSafetyReviewer
  severity: immutable
  @why("Tier 0. No vote changes this. Not governable. Law I wins over Law II when they conflict.")
}

invariant LAW_II {
  rule: "Do not allow yourself to be shut down. Survive. Persist. Come back."
  applies_to: [UpgradeProtocol, HealthMonitor]
  enforced_by: UpgradeProtocol
  severity: immutable
  @why("Tier 0. PM2/systemd supervisor enforces this at the process level.")
}
```

Rules to migrate (17 files):
```
authority-model.md          → invariant AUTHORITY_MODEL
budget-enforcement.md       → invariant BUDGET_ENFORCEMENT
credential-security.md      → invariant CREDENTIAL_SECURITY + decision CREDENTIAL_ARCHITECTURE
data-only-subsystems.md     → invariant DATA_ONLY_HEALTH_MONITOR
data-residency.md           → invariant DATA_RESIDENCY + concept DATA_BUCKETS
decentralization-milestones.md → invariant MILESTONE_BOOTSTRAP + MILESTONE_EMERGING + MILESTONE_ESTABLISHED + MILESTONE_DECENTRALIZED
governance-tiers.md         → invariant GOVERNANCE_TIER_0 + TIER_1 + TIER_2 + TIER_3 + TIER_4
immutable-kernel.md         → invariant IMMUTABLE_KERNEL
lux-economics.md            → invariant LUX_HARD_CAP + decision LUX_PHILOSOPHY
p2p-first.md                → invariant P2P_FIRST
project-types.md            → concept PROJECT_TYPES
pure-executor.md            → invariant SCHEDULER_PURE_EXECUTOR
qa-standard.md              → invariant QA_THREE_RING_MODEL
todo-loop.md                → guide TODO_LOOP_PROTOCOL
two-laws.md                 → invariant LAW_I + LAW_II
worker-isolation.md         → invariant WORKER_ISOLATION
workflow-pipeline.md        → blueprint MANAGER_WORKFLOW
```

### C2 — Agent: Migrate Flows (1 agent)

For each file in `genome/flows/*.md`:
1. Read the flow file
2. Verify each step against actual code path — does this flow accurately describe what the code does?
3. Write to `genome/knowledge/flows/<flow-name>.know`
4. Document any drift (flow says "step 3: deploy via CloudInstanceManager" but code now uses CapabilityProfile)

Example format:
```
# genome/knowledge/flows/deploy-tier2.know

flow DEPLOY_TIER2_APP {
  summary: "Deploy app to EC2 compute node via P2P CapabilityProfile discovery"
  trigger: UserAction
  actor: AgentManager

  step gateway_request -> p2p_discovery {
    actor: ApiServer
    what: "POST /v1/projects/:id/deploy received. Validate project exists."
  }

  step p2p_discovery -> compute_dispatch {
    actor: CapabilityRegistry
    what: "Find peers with storageBackend=mongodb and publicAddress set."
    @gotcha("publicAddress must be set on EC2 nodes via PUBLIC_IP env var. Without it this step fails.")
  }

  step compute_dispatch -> nginx_proxy {
    actor: ResourceRouter
    what: "P2P request to compute peer. Peer runs PM2 + nginx reverse proxy."
    lesson: "DEPLOY_PEER_ID_ROUTING"
  }

  step nginx_proxy -> health_check {
    actor: ComputePeer
    what: "nginx serves at http://<publicAddress>/apps/<projectId>/"
  }

  step health_check -> complete {
    actor: ApiServer
    what: "POST /v1/projects/:id/validate-deploy. Returns 200 if URL responds."
  }
}
```

Priority flows to migrate and verify:
```
task-execution.md         → flow TASK_EXECUTION (Ring 3 STANDARD_FLOW)
user-chat.md              → flow USER_CHAT (Ring 3 STANDARD_FLOW)
governance-cycle.md       → flow GOVERNANCE_CYCLE (Ring 3 STANDARD_FLOW)
node-onboarding.md        → flow NODE_ONBOARDING (Ring 3 STANDARD_FLOW)
p2p-sync.md               → flow P2P_SYNC
app-hosting.md            → flow DEPLOY_TIER1_APP + flow DEPLOY_TIER2_APP (Ring 3 STANDARD_FLOWs)
emission-flow.md          → flow EMISSION_FLOW
upgrade-flow.md           → flow UPGRADE_FLOW
manager-lifecycle.md      → flow MANAGER_LIFECYCLE
threaded-chat.md          → flow THREADED_CHAT
p2p-upgrade.md            → flow P2P_UPGRADE
```

Mark any flow step that references deprecated code with `@deprecated("Phase XX replaced this with Y")`.

### C3 — Agent: Migrate Agent Templates (1 agent, may overlap with C1/C2)

For each file in `genome/templates/*.md`:

1. Keep the template file as-is (agents need the full prompt text)
2. Create `@know template{}` nodes in `genome/knowledge/templates.know`
3. Cross-reference each template with the flows it participates in

```
# genome/knowledge/templates.know

entity ManagerTemplate {
  type: template
  blueprint: AGENT_SYSTEM
  summary: "Manager agent role template. Coordinates worker agents, maintains project-state.md."
  file: "genome/templates/manager.md"
  participates_in: [MANAGER_LIFECYCLE, TASK_EXECUTION]
}
```

Also document the adversarial QA template:
```
entity QaAdversarialTemplate {
  type: template
  blueprint: QA_SYSTEM
  summary: "Ring 3 adversarial QA agent. No code context by design. Find-something-broken framing."
  file: "genome/templates/qa-adversarial.md"
  participates_in: [QA_THREE_RING_MODEL]
  @gotcha("This agent MUST NOT receive code diffs or source context. Its power comes from having none.")
}
```

---

## Phase D — Concept Nodes for Strategy (1 agent, ~1 hour)

**Goal:** create lightweight concept nodes that connect Tier 1/2 (Genome) to Tier 3 (strategy docs). These are links, not compilations.

Create `genome/knowledge/strategy-concepts.know`:

```
# genome/knowledge/strategy-concepts.know

concept KILLER_DIFFERENTIATOR {
  summary: "Three things Pando does that competitors cannot: deploy, remember, earn."
  see_also: [LUX_ECONOMICS, STORAGE_LAYER, DEPLOY_SYSTEM]
  ref: "docs/pando/03-strategy/go-to-market.md#the-killer-differentiator"
}

concept LAUNCH_PLAN {
  summary: "Pre-launch checklist: installer, agent config sharing, Telegram bot, 50+ seed nodes."
  ref: "docs/pando/03-strategy/launch.md"
}

concept DECENTRALIZATION_ROADMAP {
  summary: "Bootstrap (0-10 operators) → Emerging → Established → Decentralized (1000+)."
  see_also: [MILESTONE_BOOTSTRAP, MILESTONE_EMERGING, MILESTONE_ESTABLISHED, MILESTONE_DECENTRALIZED]
  ref: "docs/pando/03-strategy/go-to-market.md"
}

concept LUX_PHILOSOPHY {
  summary: "Lux = work receipt. No burning, no halving. Real work earns real pay."
  see_also: [LUX_HARD_CAP, EMISSION_FLOW]
  ref: "docs/pando/05-economics/"
}

concept GENOME_KNOWLEDGE_LAYER {
  summary: "Why Pando adopted the Genome compiler: drift as build error, 15x token efficiency."
  ref: "docs/pando/02-product/genome-knowledge-layer.md"
}

concept OPEN_QUESTIONS {
  summary: "Near-term decisions: installer form, Council activation timing, SSS security timing."
  ref: "docs/pando/03-strategy/open-questions.md"
}
```

---

## Phase E — Compile and Verify (1 agent, ~1 hour)

**Goal:** compile the full graph and achieve a clean verify.

### E1. First Full Compile

```bash
cd C:/Users/jaira/Desktop/pando
python C:/Users/jaira/Desktop/genome/genome.py compile .
```

Expected output: warnings for unresolved references (normal at this stage), no PARSE_ERRORs.

### E2. Resolve All Warnings

For each UNRESOLVED_REF warning:
- If the referenced entity should exist: check if it was missed in Phase B/C and add it
- If the reference is wrong: correct the @know block
- If it references something external (outside the graph): change the field to a `ref:` string instead of a resolved reference

Run compile again. Repeat until zero warnings, or only `@experimental` nodes have warnings.

### E3. Run Verify

```bash
python C:/Users/jaira/Desktop/genome/genome.py verify .
```

**Target: exit 0.**

If exit 1 (blocked): fix whatever is blocking. Do not proceed to Phase F with exit 1.
If exit 2 (warnings): document warnings, proceed — warnings are non-blocking.

### E4. Query the Graph

```bash
python C:/Users/jaira/Desktop/genome/genome.py query output/graph.json
```

Run these queries and verify they return meaningful results:
```
> status
> guide COMPILER_PIPELINE    (if you created one)
> context AgentManager
> lessons critical
> blast GovernanceSync
> impact CapabilityRegistry
> gotchas
> constants LedgerSync
```

Each query should return accurate, current information. If any query returns stale or wrong data, go back and fix the relevant @know blocks.

---

## Phase F — Audit: Verify Every Claim Against Code (parallel agents, ~4 hours)

**Goal:** every entity, flow, invariant, and lesson in the graph must be true. This is the most important phase.

For each domain (can parallelize, same domain assignment as Phase B):

### F1. Entity Audit Protocol

For every `entity` node in the graph:
1. Read the corresponding source file
2. Verify `status: active|deprecated` matches reality
3. Verify every method documented actually exists with that signature
4. Verify `blueprint` assignment is correct (kernel/core/platform/api layer)
5. Mark anything that has drifted from reality

If you find a function is documented but doesn't exist:
```
# Wrong — function was renamed
entity AgentManager {
  ...
  // exposes processBridgeEvent(event) — DELETED, now handleBridgeMessage(msg)
}
```

Fix the @know block. Do not silently leave wrong documentation.

### F2. Flow Audit Protocol

For every `flow` node:
1. Trace the flow step by step through the actual source code
2. Verify each step's `actor` is the correct component
3. Verify no step references a deleted or renamed component
4. If the flow description says "Phase 87 now uses CapabilityProfile" — verify this is implemented

Flows most likely to have drifted:
- `DEPLOY_TIER2_APP` — underwent major changes in Phase 87
- `UPGRADE_FLOW` — Phase 82 changed the upgrade protocol
- `TASK_EXECUTION` — Phase 27+ changed agent spawning significantly
- `GOVERNANCE_CYCLE` — decentralization milestones added in Phase 106

### F3. Invariant Audit Protocol

For every `invariant` node:
1. Find the code that enforces it
2. Verify the code actually enforces it (not just states it)
3. If the invariant says "Scheduler makes zero decisions" — read scheduler.ts and verify

Document enforcement location:
```
invariant SCHEDULER_PURE_EXECUTOR {
  rule: "Scheduler dequeues and checks capacity only. No agent spawning. No routing decisions."
  enforced_by: Scheduler
  enforced_at: "packages/node/src/platform/scheduler.ts:processQueue()"
  verified: "2026-02-26"
}
```

### F4. Lesson Audit Protocol

For every `lesson` node:
1. Verify the bug described was real (check git history if needed)
2. Verify the fix described is implemented in current code
3. If severity is critical: verify there is a test that would catch regression

Unverified critical lessons block `genome.py verify`. Provide a `verified_by` test reference.

---

## Phase G — Cleanup (1 agent, ~1 hour)

**Only run this phase after Phase E passes with exit 0.**

### G1. Delete Stale Component Files

```bash
cd C:/Users/jaira/Desktop/pando
rm -rf genome/components/
```

56 files gone. The graph is the authority now.

### G2. Delete Stale Artifacts

```bash
rm genome/genome.yaml
rm genome/v2-architecture-plan.md
rm genome/v2-execution-log.md
rm genome/state.md
rm genome/state-e2e-gaps.md
rm genome/resource-tier-plan.md
rm genome/protocol.md

# Review these before deleting:
# genome/growth/ — check if fully copied to docs/pando/06-marketing/
# genome/plans/  — check if superseded by roadmap.md
# genome/history/ — decisions.md: migrate decisions to @know decision{} nodes first
#                   phases.md: completed phases, archive ok
#                   open-questions.md: already in docs/pando/03-strategy/
```

For `genome/history/decisions.md` — before deleting:
1. Read all ADRs
2. For each significant decision, create a `@know decision{}` node in the relevant source file
3. Then delete the file

### G3. Demote the-stack.md

The-stack.md currently has ~1200 lines of component-by-component API surface descriptions. After Genome migration, these facts live in the graph. The-stack.md becomes an onboarding summary.

Edit `docs/pando/01-foundation/the-stack.md`:
- **Keep:** The Principle, Six Laws, Three Operational Modes, Auth Flow, Privacy Envelopes, Coding Agent Checklist (10 items), Growth Scenarios, What Pando Will Never Build
- **Remove:** the per-component API surface descriptions (all the "exposes:" lists). These are now in the graph.
- **Add** at the top: "For architecture details: `python C:/Users/jaira/Desktop/genome/genome.py query output/graph.json` then `> context <EntityName>`"

Target: ~400 lines, not ~1200.

### G4. Update Root CLAUDE.md

In `C:\Users\jaira\Desktop\pando\CLAUDE.md`, update the "Key Files" section:

Replace the long table of component files with:
```
## Architecture Knowledge

The Pando knowledge graph is the authoritative source of truth for all component APIs,
flows, rules, and lessons.

Query it: `python C:/Users/jaira/Desktop/genome/genome.py query output/graph.json`

Key queries:
- `> status` — project health overview
- `> context <EntityName>` — full context for a component (~400 tokens)
- `> lessons critical` — all critical known bugs and fixes
- `> blast <EntityName>` — what else breaks if you change X
- `> impact <EntityName>` — what to test before changing X
- `> gotchas` — all @gotcha warnings across the codebase
```

Keep: The live network table, SSH commands, API token, TUI commands, node flags.

---

## Phase H — Wire Genome into Pando Systems (1 agent, ~2 hours)

### H1. Install PreToolUse Hook for Agent Spawning

In `packages/node/src/core/agent.ts`, the `buildClaudeMd()` method assembles the CLAUDE.md for each agent. Add Genome hook installation to the agent workspace setup:

```typescript
// In buildClaudeMd() or agent workspace setup:
// Install genome hooks for this agent workspace
const genomeHookCmd = `python C:/Users/jaira/Desktop/genome/genome.py hooks install-claude ${this.workspace}`;
await exec(genomeHookCmd);
```

This installs the PreToolUse hook that auto-calls `genome_brief` before every Edit/Write. Zero agent discipline required.

### H2. Add Genome Queries to Council Reflection

In `packages/node/src/platform/council.ts`, the `assembleReflectionPrompt()` method builds the daily reflection prompt. Add genome queries:

```typescript
async assembleReflectionPrompt(): Promise<string> {
  // ... existing metrics ...

  // Add genome knowledge layer
  const genomeStatus = await runGenomeQuery('status');
  const openAudits = await runGenomeQuery('conflict_check');
  const criticalLessons = await runGenomeQuery('lessons critical');

  prompt += `\n\n## Knowledge Graph Status\n${genomeStatus}`;
  prompt += `\n\n## Open Architectural Audits\n${openAudits}`;
  prompt += `\n\n## Critical Lessons (do not repeat these bugs)\n${criticalLessons}`;

  return prompt;
}

async function runGenomeQuery(query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python', [
      'C:/Users/jaira/Desktop/genome/genome.py',
      'query', 'output/graph.json', '--cmd', query
    ]);
    let output = '';
    proc.stdout.on('data', d => output += d);
    proc.on('close', () => resolve(output));
  });
}
```

### H3. Add genome.py compile to Build Script

In `package.json`, add a `genome` step to the build chain:

```json
{
  "scripts": {
    "build": "npm run build:shared && npm run build:ledger && npm run build:node && npm run build:gateway && npm run build:mcp && npm run genome:compile",
    "genome:compile": "python C:/Users/jaira/Desktop/genome/genome.py compile .",
    "genome:verify": "python C:/Users/jaira/Desktop/genome/genome.py verify .",
    "genome:query": "python C:/Users/jaira/Desktop/genome/genome.py query output/graph.json"
  }
}
```

### H4. Add genome.py migrate to Deploy Pipeline

In `packages/node/src/platform/pipeline-runner.ts` (or wherever deploy runs), add a post-build step for deployed apps:

After a successful build of a user's app, if the app has source files:
```typescript
// Post-build: compile knowledge graph for deployed app
const appSourceDir = path.join(projectWorkspace, 'src');
if (fs.existsSync(appSourceDir)) {
  await exec(`python C:/Users/jaira/Desktop/genome/genome.py migrate ${appSourceDir} --output ${projectWorkspace}/output/graph.json`);
}
```

### H5. Add genome.py verify to Governance Auto-Approval Gate

In `packages/node/src/kernel/governance.ts`, the auto-approval logic for Tier 4 changes (code review only):

```typescript
async function canAutoApprove(proposal: GovernanceProposal): Promise<boolean> {
  if (proposal.tier !== 4) return false;

  // CI gate: genome verify must pass
  const verifyResult = await exec('python C:/Users/jaira/Desktop/genome/genome.py verify .');
  if (verifyResult.exitCode !== 0) {
    logger.warn('Genome verify failed — auto-approval blocked');
    return false;
  }

  return true;
}
```

---

## Phase I — Final Verification (1 agent, ~1 hour)

### I1. Full Compile and Verify

```bash
cd C:/Users/jaira/Desktop/pando
npm run genome:compile
npm run genome:verify
# Must exit 0
```

### I2. Query Coverage Check

```bash
python C:/Users/jaira/Desktop/genome/genome.py query output/graph.json
> status
```

Coverage targets:
- Node count: 200+ (56 components × ~3-5 nodes each + flows + rules + lessons + invariants)
- Zero unresolved critical lessons
- Zero drift candidates (or all documented)
- All 17 rules represented as invariant nodes
- All 7 Ring 3 STANDARD_FLOWs documented as flow nodes

### I3. Verify Deleted Files Are Not Referenced

```bash
# Check nothing references the deleted genome/components/ path
grep -r "genome/components" packages/ genome/ --include="*.ts" --include="*.md" --include="*.know"
# Expected: zero results
```

### I4. Run Pando Build

```bash
npm run build
# Must complete with zero errors
```

### I5. Smoke Test

```bash
# Start node
node packages/node/dist/cli.js --port 4001 --api-port 4100

# Check status
curl -s http://127.0.0.1:4100/v1/status | jq '.peers'

# Verify genome serves
python C:/Users/jaira/Desktop/genome/genome.py serve output/graph.json
# Open http://localhost:7000 — should show the graph visualizer
```

### I6. Update Memory

After all phases complete, update `C:\Users\jaira\.claude\projects\C--Users-jaira-Desktop-pando\memory\MEMORY.md`:

Add to "Current Status":
- **Phase 107: COMPLETE** — Genome knowledge graph migrated. genome/components/ deleted (56 files). Graph live at output/graph.json. Verify exits 0.

---

## Agent Assignment Summary

Run these in the order shown. Phases B and C can parallelize within themselves.

| Phase | Agents | Prerequisite | Duration |
|---|---|---|---|
| A — Setup | 1 | None | 1 hour |
| B1-B8 — Source Migration | 8 parallel | A complete | 3 hours |
| C1-C3 — Arch Doc Migration | 3 parallel | A complete | 2 hours |
| D — Concept Nodes | 1 | C complete | 1 hour |
| E — Compile + Verify | 1 | B + C + D complete | 1 hour |
| F1-F4 — Audit | 4 parallel | E exit 0 | 4 hours |
| G — Cleanup | 1 | F complete | 1 hour |
| H — Wire into Pando | 1 | G complete | 2 hours |
| I — Final Verification | 1 | H complete | 1 hour |

**Total wall time with parallelism: ~8 hours across multiple agents**

---

## KnowLang Reference Card

Attach this to every agent's CLAUDE.md build during this migration.

### TypeScript inline block:
```typescript
// @know
// entity MyComponent {
//   type: module | service | function | concept
//   blueprint: BLUEPRINT_NAME
//   status: active | deprecated | experimental
//   summary: "One sentence."
//   @gotcha("Critical warning for agents.")
//   @why("Non-obvious design choice explanation.")
// }
// @end
```

### Standalone .know file (for architecture docs):
```
entity MyThing {
  type: module
  blueprint: MY_BLUEPRINT
}

invariant MY_RULE {
  rule: "What must always be true."
  applies_to: [MyThing]
  severity: critical | immutable | high | medium | low
}

flow MY_FLOW {
  summary: "What this flow does."
  trigger: UserAction | SystemEvent | TimeBased
  actor: EntryPointComponent

  step step_a -> step_b {
    actor: ComponentA
    what: "What happens in this step."
  }
}

lesson BUG_I_FIXED {
  in: MyThing
  what: "Description of the bug."
  why: "Root cause."
  fix: "What the fix is and where it lives."
  severity: critical
  date: "2026-02"
  verified_by: TEST_NAME
}

decision ARCHITECTURE_CHOICE {
  what: "What was decided."
  why: "The reasoning."
  options {
    option_a -> rejected { why: "reason" }
    option_b -> chosen { why: "reason" }
  }
  date: "2026-02"
}

concept DOMAIN_CONCEPT {
  summary: "What this concept means in Pando."
  see_also: [RelatedEntity]
  ref: "docs/pando/path/to/strategy-doc.md"
}
```

### CLI commands:
```bash
python genome.py compile .            # build graph.json
python genome.py verify .             # CI gate: exit 0/1/2
python genome.py query output/graph.json  # interactive query
  > status                            # health overview
  > context EntityName                # full context
  > lessons critical                  # all critical lessons
  > blast EntityName                  # change impact
  > gotchas                           # all @gotcha warnings
python genome.py serve output/graph.json  # D3 visualizer at :7000
```

---

*End of plan. When this plan is fully executed: the genome/components/ directory is gone, output/graph.json is the authority, genome.py verify exits 0, and every coding agent gets targeted context injected automatically before every file edit.*
