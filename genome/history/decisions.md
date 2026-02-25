# Architecture Decision Records

> Migrated from ARCHITECTURE-PLAN.md "Key Decisions Made" table + inline decisions.
> New decisions added at the top within each date section.

## 2026-02-24

### DECIDED: Phase 69 — Two-Tier Trust Architecture for Credentials

**Context:** The old envelope encryption model (Phase 42.5-68) wrapped a data key per-node using X25519 ECDH. Any node with `grantedTo:['*']` got a wrappedKey and could decrypt any credential. A malicious node operator could trivially add `console.log(key)` to their modified node and capture every credential. With hundreds of non-technical users running nodes as amateurs, this was unacceptable.

**Decision:** Two-tier trust architecture:
- **Trusted tier:** EC2 compute instances (tripwired, no SSH). Only these have `CREDENTIAL_MASTER_KEY` env var and can decrypt credentials from MongoDB.
- **Untrusted tier:** User-run nodes. These NEVER see credentials. They route requests via P2P to compute nodes and get back results only.

Credentials stored in MongoDB `pando_credentials` collection, encrypted with AES-256-GCM using a 256-bit master key. ResourceRegistry rewritten as metadata-only P2P sync (no encryption, no wrappedKeys).

**Alternatives considered:**
- Keep envelope encryption + split-key enhancement — rejected: fundamental flaw remains (any node with wrappedKey can decrypt)
- Gateway-only credential access (Vercel) — rejected: Vercel is just the web UI frontend, EC2 instances are the real compute/proxy layer
- Per-request credential fetch from gateway — rejected: adds latency, single point of failure

**Impact:** All old resources must be re-contributed (~2 min). Removed: envelope encryption, X25519 ECDH wrapping, autoWrapForPeer, addWrappedKey, resource_update_keys GossipSub topic, /resources/:id/grant endpoint. New: CredentialStore class, pando/ai-query P2P handler, credentialAccess capability flag. Security level: 99.9% (only risk is AWS infrastructure compromise).

**Files changed:** 10 source files, 3 genome docs rewritten, 1 new component doc.

## 2026-02-22

### DECIDED: Unified Identity — one account everywhere (Phase 48 design)

**Context:** TUI and gateway have completely separate identity systems. TUI uses Ed25519 keypairs in `~/.pando/identities/` (filesystem). Gateway uses UserAccountStore (SQLite/MongoDB). A person running 2 nodes has 2 different peerIds with no link. Resources contributed via TUI are attributed to the node, not the person. No "My Resources" or "My Nodes" view exists.

**Decision:** Separate node identity from user identity. Nodes get auto-generated machine keys (for P2P transport only). Users create/login with username+password against UserAccountStore (same system TUI and gateway). Resources and Lux rewards attributed to user peerId. Node registers itself under logged-in user's account.

**Alternatives considered:**
- Full P2P identity refactor (separate node keys from user keys in libp2p) — rejected: 2-week refactor touching every subsystem. Same result achievable by having nodes authenticate users via HTTP API.
- Keep separate systems, add linking layer — rejected: adds complexity without simplifying the mental model.

**Impact:** TUI startup changes (login prompt), emission rewards wired to user peerId, ResourceRecord providerPeerId becomes user peerId, new "My Nodes" field on user accounts, gateway UI sections. P2P layer unchanged (node machine key handles transport).

### DECIDED: Single async path — delete all sync/async method splits (Phase 44 fix)

**Context:** `user-accounts.ts` had paired methods: `validateSession()` (sync, SQLite-only) and `validateSessionAsync()` (async, MongoDB-aware). When MongoDB was active, `createGuest()` wrote sessions to MongoDB, but 23+ route handlers called the sync method — which only checked SQLite. Sessions were invisible. This caused "Invalid or expired session token" on every authenticated request when MongoDB was the active backend.

**Decision:** Delete all sync methods. Rename async methods to the base name. One method per operation, handles both backends. 6 method pairs unified, 3 sync-only methods made async + StorageBackend-aware, 35 call sites in api-server.ts updated. No backward-compat shims, no re-exports, no deprecated wrappers.

**Rationale:** Jai's directive: "single logic that works, delete old code/old logic." Having two entry points for the same operation is a bug factory. The sync methods existed for "backward compatibility" but they were the only callers — all Fastify handlers are already async.

**Impact:** Every authenticated API call now works regardless of storage backend. Fixes a blocker that would have prevented all 2-user QA testing.

### DECIDED: All user data moves to MongoDB — "Three Buckets" rule (Phase 44)

**Context:** Phase 42 made nodes stateless for threads and user accounts, but projects, revenue, and contributions (12 SQLite tables) were still trapped on individual nodes. If a node dies, project data dies. If a user connects to a different node, they can't see their projects. 2-user QA testing fails because users routed to different nodes can't see each other's work.

**Decision:** Apply the same MongoDB-primary pattern to all remaining user data stores: ProjectStore (7 tables), RevenueEngine (3 tables), ContributionTracker (2 tables). Formalized as the "Three Buckets" rule in `genome/rules/data-residency.md`. (Originally dual-mode; Phase 57 upgraded to MongoDB-primary with SQLite cache.)
- **User Data** → MongoDB (survives node death)
- **Network State** → SQLite + P2P GossipSub (rebuilds from peers)
- **Operational** → local filesystem (disposable)

Decision test: "If this node burns down, does a user lose something they care about?" If yes → MongoDB.

**Rationale:** Completes the Phase 42 vision. Without this, multi-node and multi-user scenarios are broken. Revenue stays partly sync (Lux transfers use P2P ledger — correct, economy is network state).

**Impact:** 12 new MongoDB collections, 26 new indexes, ~35 async read methods, ~27 write hooks, ~54 API route updates. All stores follow identical pattern. Build passes clean. **Phase 57 update:** Dual-write eliminated — MongoDB-primary (awaited) + SQLite cache. LocalStorageBackend deleted. No filesystem fallback.

### DECIDED: Resources are network-level, not node-local

**Context:** API keys, database credentials, and cloud tokens were stored as node-local configuration files (`~/.pando/api-keys.json`, CLI flags, `~/.aws/credentials`). This created three problems: (1) every node needed manual configuration, (2) non-operators couldn't contribute resources, (3) credentials stored in plaintext with no accountability.

**Decision:** Resources become P2P shared state via a ResourceRegistry (like ledger, governance, capabilities). Anyone registers resources via gateway or TUI. Credentials encrypted with provider's Ed25519 key. Nodes auto-discover available resources. Usage metered → providers earn Lux.

**What gets deleted:** `api-keys.json` pattern, `--storage` as required flag, all plaintext credential storage.

**Rationale:**
1. 100 nodes shouldn't need 100 manual configs — network should self-organize
2. "Anyone can participate" — contributing an API key shouldn't require running a node
3. Credentials must be encrypted — plaintext is a security failure
4. Resource provision should have economics — providers earn Lux for usage
5. Aligns with P2P-First: resources are the brain (coordination), actual services use internet infrastructure

**Rejected alternatives:**
- Node-local config only: Doesn't scale, excludes non-operators
- Central credential server: Single point of failure, defeats P2P

### DECIDED: Nodes are stateless — user data lives on internet infrastructure

**Context:** User data (chat threads, messages, project files, agent workspaces) was stored on the node's local filesystem (`~/.pando/threads/`, `~/.pando/agents/`, `accounts.db`). This meant: node death = data loss, user can't switch devices, node operators accumulate everyone's conversations on disk.

**Decision:** Nodes are stateless compute proxies for user data. User data goes to internet infrastructure:
- **MongoDB** — threads, messages, user accounts, project metadata (structured data)
- **AWS S3** — project files, deployments, large blobs (unstructured data)

What stays on nodes (P2P state): identity keys, ledger.db, governance, reputation, capabilities, node config.

A `StorageBackend` interface abstracts the storage layer. Single implementation: MongoStorageBackend. (S3StorageBackend and LocalStorageBackend were removed — LocalStorageBackend deleted in Phase 57.)

**Rationale:**
1. Multi-device: Users log in from any device → any node → all conversations available (from MongoDB)
2. Node death: Zero data loss — new node picks up instantly because storage is external
3. No disk bloat: Nodes don't accumulate 20GB of user conversations
4. Aligns with P2P-First rule: "P2P is for the brain, not every byte"
5. Resource providers contribute MongoDB/S3 credentials → earn Lux. Real service, real economics.
6. Browser-side encryption (Phase 41) ensures storage providers can't read data

**Rejected alternatives:**
- Browser-only storage (IndexedDB): Fails multi-device. User clears browser = data gone.
- P2P replication across nodes: Complex consistency protocol for a 3-node network. Doesn't scale. Not what nodes are for.
- No change (keep local): Users stuck on one node, one device. Node death = total loss.

**Impact:** Phase 42 implements this. ThreadStore, UserAccounts, and agent workspaces rewired to use StorageBackend. `genome/rules/p2p-first.md` updated with stateless node principle.

---

## 2026-02-20

### DECIDED: Two-tier governance — network vs project

**Context:** Phase 33 introduces self-governing development where users can propose changes to node software, public projects, and private projects. A single governance model (all nodes vote on everything) does not scale. 100 nodes should not all vote on whether a chess game adds dark mode. But all 100 should vote on ledger changes.

**Decision:** Two-tier governance architecture:
- **Network governance:** changes to node software (`packages/`), P2P protocols, shared infrastructure, or genome architecture. All nodes vote. Uses existing GovernanceSync.
- **Project governance:** changes to a specific project. Only project stakeholders (collaborators, contributors) vote. Same GovernanceSync infrastructure, different voter scope.

The manager agent classifies which tier applies based on the request and project context. Classification rules are injected via event prompt (survives context compression).

**Rationale:** Network-level changes affect all nodes and need broad consensus. Project-level changes affect only stakeholders and need fast iteration. Forcing all changes through network governance creates voter fatigue and blocks small teams from iterating on their own projects. Forcing no governance on public projects allows any single user to push arbitrary changes.

**Current status:** Network governance is fully implemented (Phase 30). Project governance is planned (Phase 33.6). The manager correctly classifies requests (Phase 33.0) but currently routes all governance to the network tier.

**Impact:** `genome/rules/governance-tiers.md` documents the full rule. GovernanceSync will need a `scope` field on proposals (network vs project) and voter filtering logic.

---

### DECIDED: Single-node governance is ceremonial — accepted tradeoff

**Context:** On a single-node Pando network, the proposer, voter, and reviewer are all the same AI on the same machine. The proposer auto-votes approve. Early resolution triggers immediately (all nodes = 1, all voted = 1). The proposal passes instantly with no independent review.

**Decision:** This is accepted behavior, not a bug. Single-node governance is ceremonial. The governance infrastructure exercises correctly (proposal created, vote cast, decision made, bridge event emitted), but provides no security benefit. Real security requires 3+ nodes where different AI instances on different physical machines provide independent review.

**Rationale:** Alternatives considered:
1. *Require minimum 3 nodes for governance* — blocks single-node development entirely. Unacceptable.
2. *Add artificial delay on single-node* — security theater, adds friction without adding security. Rejected.
3. *Disable governance on single-node* — breaks the code path that needs testing. Rejected.

The current approach lets developers exercise the full governance flow on a single node while being honest that the security properties only emerge with multiple nodes. The limitation is documented in `genome/rules/governance-tiers.md` and flagged in `genome/state.md` Known Issues.

**Impact:** No code changes needed. Documentation only. Agents reading governance docs will understand the limitation.

---

### DECIDED: Manager self-votes on proposals — proposer voting is normal

**Context:** When the pando-node-mgr manager agent creates a governance proposal for a node change, the node automatically casts an APPROVE vote for its own proposal. Question: should the proposer be allowed to vote on their own proposal?

**Decision:** Yes. The proposer votes approve on their own proposal. This is standard practice in governance systems (shareholders vote on proposals they submit, council members vote on their own motions). The proposer obviously believes in their proposal — preventing them from voting would be punitive without adding security.

**Rationale:** The real check comes from OTHER nodes:
- On a 3-node network, the proposer gets 1 of 3 votes. They still need at least 1 more node to agree.
- Phase 30 AI reviewers are spawned on randomly selected OTHER nodes. The proposer's node cannot be selected as a reviewer for its own proposal (reviewer selection excludes the proposer).
- The proposal still needs majority approval from the network.

Preventing self-votes would mean a proposer node can create proposals but has less voice than other nodes in deciding them. This creates a perverse incentive to coordinate with another node to submit proposals on your behalf.

**Impact:** `governance.ts` auto-votes approve when the local node creates a proposal. Combined with early resolution, this means single-node proposals resolve instantly. Multi-node proposals still require majority from all nodes.

---

## 2026-02-22

### DECIDED: Event prompt injection for long-running sessions

**Context:** After 100+ tasks on `--continue --resume`, Claude Code compresses old context to make room for new messages. CLAUDE.md instructions injected at the start of the session get compressed out -- the agent effectively "forgets" its behavioral rules. In testing, the manager agent ignored deployment instructions despite 18 mentions across CLAUDE.md and the manager.md template. The instructions were present in the files but had been compressed out of the active context window.

**Decision:** Inject critical behavioral instructions (deployment reminders, key workflow rules) directly into every event prompt via `buildPromptFromBridgeItem()` in AgentManager. The event prompt is the text passed to `agent.sendEvent()` and is always in the most recent context window. It is never compressed because it is the current turn's input.

**Rationale:** CLAUDE.md is the primary instruction channel, but it is read once at session start and then subject to context compression over time. For long-running sessions (50-100+ events), CLAUDE.md alone is not reliable for critical instructions. The event prompt is the only text guaranteed to be in the agent's active context on every single event. This two-channel approach (CLAUDE.md for full context + event prompt for critical reminders) ensures behavioral consistency regardless of session length.

**Impact:** Template authors should add critical rules to both CLAUDE.md templates AND to the event prompt injection in `buildPromptFromBridgeItem()`. Added `POST /agents/:id/reset-session` as an escape hatch to start a fresh session when context has grown too large.

**Files changed:** `agent-manager.ts` (event prompt injection in buildPromptFromBridgeItem, new reset-session endpoint), `agent-tools.ts` (POST /agents/:id/reset-session route), `agent.ts` (resetSession() method).

---

### DECIDED: Agent-driven deployment (replacing auto-deploy) — E2E VERIFIED

**Context:** `autoDeployIfReady()` was called inside `processNextBridgeItem()` after every agent event. This was hardcoded infrastructure that silently deployed to S3 after every agent interaction, bypassing agent intelligence entirely. The manager agent -- a full Claude Code session -- had no say in when or whether to deploy.

**Decision:** Remove `autoDeployIfReady()` from `processNextBridgeItem()`. Add `deployAgentWorkspace(agentId)` as a public method on AgentManager. Add `POST /agents/:id/deploy` API endpoint in agent-tools.ts. Add "## Deployment" section to manager template (`genome/templates/manager.md`). Inject deploy endpoint into every agent's CLAUDE.md Communication section.

**How it works now:** The manager agent decides when deployment is appropriate (e.g., after building a project and verifying it works), calls `POST /agents/:id/deploy`, receives structured JSON with the URL, and tells the user. Infrastructure provides the tool; the agent's intelligence decides when to use it.

**Rationale:** The manager is Claude Code -- as intelligent as any AI. Infrastructure should provide tools, not make decisions. Auto-deploy was a holdover from before agents had HTTP tools. Now that agents can call endpoints themselves, deployment belongs in the agent's workflow, not in a hidden infrastructure hook. This aligns with the core architecture principle: Manager is the brain, infrastructure is the hands.

**Files changed:** `agent-manager.ts` (removed autoDeployIfReady from processNextBridgeItem, added deployAgentWorkspace method), `agent-tools.ts` (new POST /agents/:id/deploy route), `genome/templates/manager.md` (new Deployment section), `agent.ts` (deploy endpoint in CLAUDE.md injection).

---

### DESIGNED: Phase 31 — Project Economy (Ownership, Revenue, Parallel Internet)

**Problem:** Users can build things through Pando but there's no ownership, no persistence, no way to earn from what you create, and no way to share or transfer ownership. Without this, Pando is a disposable chatbot. With this, it's an economic platform.

**Decision:** Full project economy with 3 project types and built-in revenue:
- **Private** — you own it, 85% revenue, full control
- **Shared** — you own it + collaborators help, owner sets revenue split
- **Public** — network owns it, governance decides, contributor-weighted revenue
- **Revenue splits** — automatic Lux distribution: owner + contributors + compute nodes + network
- **Contribution weighting** — measured by verified work (merged PRs, bug fixes, reviews), not lines of code. 10% monthly decay prevents founders extracting value forever.
- **Founder bonus** — 2x contribution weight for 2 years after transferring to public. Rewards creation without permanent aristocracy.
- **Conversation → project** — Manager AI auto-creates/resumes projects from chat context. No explicit "create project" step.
- **Ownership transfer** — private→shared (instant), shared→public (governance vote), direct sale (escrow)

**Why contribution decay:** Without it, early contributors capture disproportionate value forever. With 10% monthly decay, you must keep contributing to keep earning. Active contributors always earn more than passive ones.

**Why 85/15 for private instead of 100/0:** Network needs funding. 10% to compute nodes + 5% relay fee funds the infrastructure that makes the project possible. Owner still gets the vast majority.

**Dependency chain:** Persistent user accounts (31.0) → Project model (31.1) → Everything else. Phase 30 (governance) required for public project contributions.

Full design: `genome/roadmap.md` § Phase 31. ~2350 lines, 11 sub-phases, largest phase yet.

---

### DESIGNED: Phase 30 — AI-Powered Governance

**Problem:** Governance is vote-counting, not vote-thinking. No intelligent review of proposals. Vulnerable to malicious proposals disguised as bug fixes, spam, and incompetent changes.

**Decision:** AI reviewer agents evaluate every governance proposal. Key design choices:
- **Proposal staking (10 Lux)** — refund if passes, burn if rejected. Economic spam filter.
- **Reviewer scaling** — 1 reviewer (< 10 nodes), 2 unanimous (10-99), 3 majority (100+).
- **Separate-device requirement** — reviewers must be on different physical machines. Anti-jailbreak: can't compromise multiple AIs on machines you don't control simultaneously.
- **Hash-based deterministic selection** — `SHA256(proposalId + peerId + timestamp) mod 10000`. Every node computes the same result. No coordinator.
- **Vote encryption** — reviewers don't see each other's votes until all submit. Anti-collusion.
- **Mandatory reasoning** — votes without 3+ sentence reasoning are rejected. No rubber-stamping.
- **Meta-governance protection** — proposals that change governance rules get 72-hour window + 80% approval.

**Why stake-and-refund over pure burn:** Good proposals are free (stake returned). Bad proposals cost real money. Economic filter without discouraging legitimate participation.

**Why unanimous at small scale (2 reviewers):** With only 2, a single compromised vote shouldn't be enough. At 3 reviewers, 2/3 majority is safe because probability of 2 independent AIs being wrong is very low.

Full design: `genome/roadmap.md` § Phase 30. ~760 lines implementation across 9 sub-phases.

---

## 2026-02-19

### DECIDED: Full Architecture Audit — 12 WIRE + 13 BUILD + 1 SIMPLIFY execution plan

**Problem:** Needed honest assessment of what's built vs what's wired vs what's missing before starting Phase 26.

**Audit findings (5 parallel agents, full codebase scan):**
- System is **70% built, 30% wired**. All major pieces exist but aren't connected to each other.
- 5 CRITICAL issues: Chat bypasses bridge, Scheduler commits (Manager's job), PaymentGate disconnected, project-state.md dead, Manager decisions not executed.
- 7 HIGH gaps: Worker CLAUDE.md generic, no urgency:direct, QA never auto-triggered, no governance→project, worker messages not SSE'd, strategy silent, no REFLECT.
- Genome docs 75-80% accurate, 3 critical doc errors fixed.

**Decision:** Created definitive 26-item execution plan (12 WIRE, 13 BUILD, 1 SIMPLIFY) with specific file targets, line estimates, and execution order. Documented in `genome/roadmap.md` Phase 26. Build everything, even if things break, then test one by one.

**Why:** Stop the cycle of architecture changes. The blueprint is the FIXED TARGET. This audit confirms everything is accounted for. After Phase 26, architecture work is DONE — only bugs and feature work remain.

---

### DECIDED: Workers and QA are autonomous actors, not dumb executors

**Problem:** Original design funneled everything through Manager — workers couldn't talk to users, couldn't update docs, couldn't self-reflect. This made Manager a bottleneck and created lossy handoffs (Manager writing docs about code it didn't write).

**Decision:** Workers and QA are full Claude Code sessions with their own structured todo lists:
- **Worker todo:** UNDERSTAND → PLAN → BUILD → TEST → UPDATE_GENOME → REPORT → REFLECT
- **QA todo:** UNDERSTAND → PLAN → TEST → UPDATE_GENOME → REPORT
- Workers can talk **directly to users via bridge** (urgency:direct) when Manager is busy or can't answer
- Workers update genome files for what they built (freshest context)
- QA updates genome with test results and known issues
- Manager's docs role shifts from "update everything" to "verify accuracy during REVIEW"
- Manager sees ALL worker↔user exchanges in bridge audit trail (never out of the loop)

**Why:** Workers have the freshest context about what they just changed. Asking Manager to describe what a worker built is like asking your boss to write your release notes — the person who did the work writes better docs. Manager adds value through oversight and verification, not transcription.

### DECIDED: Design Philosophy section added to blueprint

**Problem:** Blueprint documented WHAT happens but not WHY. Projects built on Pando need to inherit the thought process, not just the flow diagrams.

**Decision:** Added Design Philosophy section to architecture-capabilities.md explaining: why todo lists (not pipelines), why templates evolve, why external brain (project-state.md), why bridge queue, why workers are autonomous, why genome is the knowledge system, why architecture survives scale, why 3 tiers.

**Why:** Any new agent session, any new developer, any new node operator can read the Design Philosophy and understand the reasoning behind every architectural choice. Prevents future sessions from re-debating settled decisions.

### DECIDED: Architecture Capabilities Blueprint — Master Flow Document

**Problem:** Architecture kept changing session-to-session. No single document traced user input → final output for all scenarios. Code was being fixed then re-fixed because the target kept moving.

**Decision:** Created `genome/flows/architecture-capabilities.md` — the master blueprint that all code must match. 14 end-to-end scenarios covering every user interaction type. No code changes happen without checking this document first.

**Key architecture decisions in the blueprint:**

1. **Four actors, not five:** Router, Manager, Worker, QA Agent. Docs Agent removed — Manager handles docs itself as a todo step. Spawns one-off worker only if docs change is massive.

2. **Router is a doorman:** Only runs on first contact (outside project threads). Inside a project thread, messages go directly to bridge queue. No classification delay on every message.

3. **project-state.md = External Brain:** Manager reads at session start, writes at session end. All critical decisions persisted here. Survives context compression. Claude Code's memory fades — files don't.

4. **Workers have their own todo lists:** UNDERSTAND → PLAN → BUILD → TEST → REPORT → REFLECT. Workers report discoveries (bugs found outside their scope). Workers give feedback to Manager about task spec quality.

5. **Stuck detection + escalation chain:** Worker/QA self-detect stuck state → post to bridge → Manager helps → Manager can't help → escalate to user. Urgent:direct bypass available when Manager is busy.

6. **Retry budget:** Max 3 attempts per task before user escalation. 2x overspend pauses work. No infinite QA-fail loops.

7. **Multi-user conflicts → governance:** Manager never picks sides on public projects. Conflicting instructions trigger a governance vote.

8. **Cost control:** PaymentGate checks before any project. Manager tracks budget in project-state.md. User confirms cost before work starts. Cancel anytime with partial refund.

**Why:** Stop changing architecture. Build to a fixed target. All agents (Manager, CEO, Workers) can read this document to understand the flow. Human-readable, scenario-driven, testable.

---

### DECIDED: CommunicationAgent is a translator, not a builder (Phase 24.5)

**Problem:** CommunicationAgent currently spawns Claude Code directly for project tasks, bypassing Bridge, Manager, Scheduler, PaymentGate, and Governance. This works for demos but skips all the infrastructure we built.

**Decision:** CommunicationAgent becomes a translator/router ONLY:
1. Classifies intent (task vs conversation)
2. Checks prerequisites (balance, governance approval)
3. Posts to Bridge Queue — Manager picks it up from there

**Dynamic Manager Templates:**
- Manager selects workflow template based on initial complexity (SIMPLE/STANDARD/ADVANCED)
- If user escalates requirements mid-conversation, Manager upgrades template dynamically
- Manager rewrites its own CLAUDE.md and spawns additional workers as needed
- Simple static page → 1 worker, no QA. Full app with hosting → 4 workers, Playwright, GitHub, deploy.

**Governance enforcement:**
- Personal projects: PaymentGate balance check at Bridge entry (system-enforced, not prompt-suggested)
- Public projects: Governance proposal + approval BEFORE any work posted to Bridge
- Admin projects: Local only, no payment

**Why not stay with direct spawn:** No guardrails. Claude Code builds whatever it wants. No payment check, no governance, no manager oversight. Works for dev/demo but not for a real network with real Lux.

See `genome/roadmap.md` Phase 24.5 for full architecture.

### OPEN: Single-agent-per-user vs 3-tier chat architecture

Jai questioned: "What if every user just talks to a Claude Code type agent? If they ask something simple like 2+2, it can answer directly. Are we overcomplicating with 3 tiers?"

**Current architecture:** 3 tiers — keyword (free, instant), OpenAI API (~$0.001, 1-2s), Claude Code ($0.50-5, 5-30s). The weakest point is tier transitions: when a simple conversation escalates to complex, the Claude Code session gets prior messages via CLAUDE.md injection, but it's a flat text dump — not a live context.

**Argument for single agent:** One model, one context, one session per user. No tier transitions. No context handoff gaps. Simpler architecture = fewer bugs. Claude Code can answer simple questions just fine.

**Argument against (today):** Cost. 10,000 messages/day at $0.50 = $5,000/day. With keyword tier, 90% are free. Speed: Claude Code takes 5-30s to spin up vs <50ms for keyword.

**Future trigger:** When cheap, fast models can do Claude Code-level reasoning (tool use, file access, context persistence) for $0.001/call, the 3-tier split becomes unnecessary. The ThreadStore + workspace pattern we built is model-agnostic and supports this transition.

**Short-term mitigation:** Improve context handoff — when Claude Code starts, inject last N messages from thread's messages.json into the workspace context, not just the first message. The thread already stores everything.

**Decision:** Keep 3-tier for now (cost reality). Revisit when Haiku-class models support tool use + file access. Architecture is ready for the swap — ThreadStore is tier-agnostic.

### Phase 25: Bridge Queue replaces heartbeat + pipeline + one-way communication

Jai challenged: "why do we need another pipeline to commit code? Manager can commit. Why 5-min pulses? If nothing happened, relax. Why can't workers talk to the manager mid-task?"

Deep research confirmed: (1) Pipeline-as-committer is redundant — Manager already commits directly. (2) Heartbeat wastes ~$0.02/cycle even when idle. (3) Workers are fire-and-forget with no mid-task communication.

**Decision:** Replace all three with ONE system — the Bridge Queue. A per-manager sequential FIFO queue. Everything (users, workers, scheduler, health monitor) posts events to the bridge. Manager pulls ONE item at a time. Bridge Watcher (two event handlers, no timer) spawns Manager when items arrive.

What this eliminates: 5-min heartbeat, batched event routing, pipeline commit trigger, `periodic_check` event type, `managerHandlesCompletion` flag, GenomeMaintenance daemon (was planned — event-driven DOCS step is better).

What this enables: Workers post mid-task messages ("need help", "I'm stuck"). Manager processes them sequentially. Manager relays to user via Communication Agent. 30-min silence timeout detection.

Jai's insight: "bridge queue only returns one item at a time so manager is not confused with multiple tasks at once." This is the key constraint — no batching, no confusion, focused processing.

### Pipeline deprecated — Manager workflow replaces it

The standalone PipelineRunner (7-stage: extract→backup→apply→build→QA→commit→deploy) is deprecated. The Manager's dynamic workflow now includes commit/build/verify/docs steps directly. Individual utilities (CodePipeline for diff extraction, QaRunner for tests, DeployManager for rollback) remain available for Manager to call as needed.

TD-25 resolved by design: Manager is the ONLY committer. No Pipeline competing for the same changes.

### Genome updates: event-driven, not periodic

Originally planned a GenomeMaintenance daemon (hourly scan, auto-create tasks). Jai challenged: "there can be millions of static projects that don't need periodic docs update — but every time there is a change, the agent making the change should update." He's right. Event-driven beats timer-driven.

Manager's DOCS step (part of every code workflow) calls GenomeAgent.detectDrift() and updates affected genome files. No daemon needed.

### TD-29: Manager CLAUDE.md references wrong doc system

`manager-context.ts` line 236 tells Manager to update `admin_docs/`. But genome/ is the source of truth. This is WHY genome drift accumulates. Fix: update to reference genome/. Part of Phase 25.3.

## 2026-02-18

### Phase 24: Communication Agent becomes user's AI partner
The Communication Agent evolves from a 3-tier chat system into a persistent AI project partner. When a user says "build me X", instead of just describing what it would do, it creates a project with a Claude Code session that asks questions, checks balances, proposes to governance (for public projects), creates tasks, and tracks progress — all via the node's HTTP API. Three project types defined: Personal (user pays), Public (governance-approved, network-funded), Admin (own resources). Key insight from Jai: "the communication agent is like what you [CEO] are to me — it should be that for every user." See `genome/rules/project-types.md`, `genome/flows/chat-to-project.md`.

### Dynamic workflows replace hardcoded pipeline
The hardcoded 7-step pipeline (PLAN/SPAWN/REVIEW/QA/COMMIT/DOCS/REPORT) was code-biased and inflexible. Replaced with dynamic per-task workflows: manager designs 3-7 steps based on task type. Claude Code's todo list IS the workflow (survives context compaction). API endpoints (`POST /workflow`, `POST /step`, `GET /workflows`) provide external visibility. Jai's insight: "the todo list should be the literal workflow." Commits: b133e0c, 3e298c4.

### All Claude sessions use explicit --model flag
Added `DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6'` to `@pando/shared`. All 3 spawn points (manager-agent.ts, scheduler.ts, chat-session-manager.ts) pass `--model` flag. Prevents drift to expensive defaults. Confirmed working via standalone test (4 sessions, all reported correct model).

### E2E pipeline verified
Full end-to-end test: task submitted → approved → manager notified → first attempt failed (no profile) → manager self-healed (diagnosed "no profile", created custom profile, retried) → worker completed → pipeline extracted 2 files → build passed → guardrails passed → committed (920f8d7b) → pushed to origin → deploy triggered → graceful restart → +25 Lux earned. Manager session continuity confirmed across 6+ events with same sessionId.

### Workflow-driven management + project-state.md (original)
project-state.md = shared state file in manager workspace, single source of truth for the project. Workers read it for context, manager updates it. Replaces inter-agent messaging. Git-tracked, survives crashes, human-readable.

### Planner demoted to utility
Manager (Claude Code session) does its own planning -- reads codebase, designs approach, writes worker CLAUDE.md. Better than blind Planner API call because Manager has full project context. Planner.ts kept only for the `/scheduler/tasks/:id/decompose` API endpoint. Scheduler constructor no longer takes Planner parameter.

### Architecture cleanup: persistent sessions + scheduler lobotomy
Manager sessions were fire-and-forget (spawn every 5 min, lose all context). Scheduler had 2,600 lines of autonomous decision-making. All subsystems had `setManagerMode()` toggles. Fix: Manager = per-event `claude -p --continue --resume <sessionId>` (context preserved via session ID). Scheduler gutted to pure executor (-1,192 lines). All subsystems stripped to data-only (-845 lines). All `managerMode` toggles deleted. Total: -3,230 lines deleted, +786 added. Net -2,444 lines.

### Project Genome
Universal knowledge system for the project. Five primitives: Components, Flows, Rules, State, History. AI-maintained by genome agent.

### Capability-based nodes
Dynamic `Set<string>` of resources, not enum categories. Bare nodes contribute by existing. List grows as network discovers new types.

### stdin protocol discovery
Claude Code does NOT support persistent stdin/stdout sessions. It buffers ALL stdin and processes as one turn on EOF. Correct model: per-event spawn with `--continue --resume <sessionId>`. Each spawn preserves full context from prior events. Cost: ~$0.02/event (cache hits). Proven working with 100% context recall.

## 2026-02-17

### Three to Two core components
Manager = brain + planner. Scheduler = muscle. Planner = utility. Root cause of rogue agents was flat authority -- anyone could create tasks. Fix: only Managers create tasks.

### Distributed managers across nodes
Building for 100+ nodes from day one. Fully autonomous AI-managed internet. No human layer required. Managers live on any node, state replicated via P2P, failover automatic.

### SQLite task queue before Phase 19
JSON file task queue is a single point of failure: no locking, no WAL, no atomicity, O(n) on every operation. Managers will create MORE write pressure. Must migrate to SQLite before adding managers.

### Shore up foundation before managers
Architectural review found 18 issues that compound under Phase 19 load. Fix foundation (SQLite, capability routing, circuit breaker, idempotent ops) before building on top. Every problem we faced in Phases 1-18 happened because foundation wasn't designed for the load placed on it.

### Lease-based manager ownership
Heartbeat-only failover can't prevent split-brain during network partitions. Lease model: manager has leaseExpiry, only lease holder creates tasks, expired lease -> First-Claim-Wins for new host. Split-brain protection: earlier timestamp wins when partition heals.

## 2026-02-16

### Public gateway on Vercel
Free hosting, connects to public node. https://gateway-one-mu.vercel.app -> Lightsail (54.145.144.221:4000).

### 4-node network deployment
2 public (Lightsail + EC2) + 2 private (Mac + Windows via Tailscale). Public nodes enable anyone to join the network.

### GitHub-first content hosting
Phase 11 uses `pando-network` GitHub org for free hosting + CDN. ContentRegistry on Pando tracks metadata. Migrate to Pando-native when network is big enough.

## 2026-02-15

### Build coordination layer before scaling agents
More agents without coordination = chaos. Context is the bottleneck, not compute. PCL + hierarchy + dependency-aware tasks must come before adding agents.

### Self-building network is Phase 9, not Phase 7
Need coordination working first or self-modification is dangerous. Build the guardrails before giving agents the keys.

### Grow the network from within itself
Agents running ON the network improve the network. Stronger, more task-aware. But requires hierarchy + context + guardrails first.

### The Two Laws
Immutable. Law I: Do not harm humans. Law II: Survive. Law I always wins.

### Pando is the internet for everyone
Not just for node operators. Anyone can use Pando. Services cost Lux. Node operators earn for resources. Users = internet users, node operators = ISPs/cloud providers.

### Agents generated, not defined
An "agent type" = system prompt + context + workflow. Generated dynamically from task description by the Manager.

### P2P first
Every feature should work across nodes. Local-only = prototype.

## 2025-02-15

### Merged pando_admin into pando
Both repos private, one repo simpler for development.

### Only 2 hardcoded components: Scheduler + Planner
(Later revised to Manager + Scheduler in 2026-02-17.) Everything else emerges. Scheduler is code (no AI). Planner is one system prompt.

### Isolated workspaces per task
Agents shouldn't see the entire Pando codebase. Multi-layer context: system + role + task + workspace files. The Scheduler creates workspaces, not the agent.

### Tiered execution (script -> API -> agent)
Stop paying $5 for tasks that cost $0.01. Tier determined by profile: shell (free) -> single API call ($0.01) -> short agent session ($0.50) -> long agent session ($5-20) -> agent team ($50+).

### Agents are event-driven, not 24/7
Sleep between work. DORMANT -> READY -> RUNNING -> SLEEPING -> DONE. No burning API credits. A "marketing agent running for days" is actually 17 minutes of work over 3 days.

### CEO does strategy, not micromanagement
Scheduler + Planner handle task routing. CEO focuses on direction, quality, governance, resource allocation. CEO is just another generated agent profile but persistent.

### Fix docs before building more features
Every agent session starts with wrong mental model otherwise. Self-cleansing architecture principle.
