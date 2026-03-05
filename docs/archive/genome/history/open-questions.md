# Open Questions & Answers

> Every unresolved question about the architecture, with current answers.
> Migrated from admin_docs/OPEN-QUESTIONS.md and ARCHITECTURE-PLAN.md "Open Questions" section.
> Builder agents: if you hit a question during implementation, check here first.

---

## A. The "Day One" Problem

### A1. How does the first user find the network?
**Status:** ANSWERED
**Answer:** For now, Jai IS the only user. He connects directly to his own nodes' gateways via localhost or Tailscale IP. Public access comes later -- we'll host gateways on public URLs (a VPS with a domain pointing to a Pando node's gateway). The decentralized discovery (finding gateways without knowing an IP) is a future problem -- solve it when we have 10+ public nodes.

### A2. Who builds the first services?
**Status:** ANSWERED
**Answer:** We do. Jai + agents seed the network with initial services. The first "services" are just the core: search, task submission, service directory. These are built into the gateway. External services (user-built websites, apps) come after the core works.

### A3. Why would anyone run a node early on?
**Status:** ANSWERED
**Answer:** Early adopter incentives already exist (5x Lux multiplier for first 100 accounts). But honestly, early nodes will be run by people who believe in the vision, not for profit. Same as early Bitcoin miners. Real incentive kicks in when the network has users who pay Lux for services, and Lux has market value. Not a Day 1 problem.

---

## B. How Users Actually Use This

### B4. How does a user access a built service? What's the URL?
**Status:** ANSWERED (proposed)
**Answer:** Each service gets a unique ID. Accessible via any gateway:
```
http://<any-gateway>/service/<service-id>
```
For Day 1: services are just files in a workspace. Jai accesses them via the gateway on his own node. Public URLs, custom domains, and `pando://` protocol are future work.

### B5. How do users request changes to existing services?
**Status:** ANSWERED (proposed)
**Answer:** A change request is just another task that references the existing service:
```json
{ "type": "modify", "service_id": "social-network-xyz",
  "description": "Add blog section", "budget": 50 }
```
The Scheduler finds the service's codebase in the Registry, sets up a workspace with it, and spawns an agent. The agent reads the existing code, makes changes, submits for review. Requires Registry -- Phase 11 (DONE).

### B6. How do users discover available services?
**Status:** ANSWERED (proposed)
**Answer:** The Registry doubles as a service directory. Gateway has a browse/search page. Phase 11 Content Layer (DONE) provides ContentRegistry + gateway Content page.

### B7. How is user data privacy handled?
**Status:** RESOLVED (Phase 41 + 42)
**Answer:** All user data encrypted with AES-256-GCM in the browser before it touches any node (Phase 41). Storage backends (MongoDB, S3) only see encrypted blobs. Nodes are stateless proxies — they decrypt for processing, re-encrypt, pass to storage, keep nothing. Storage providers can't read data. Node operators can't read data. Only the user's browser (holding the Ed25519 private key) can decrypt.

### B8. Right to delete in distributed system?
**Status:** RESOLVED (Phase 42)
**Answer:** User data lives in MongoDB/S3 (not distributed across nodes). User deletes → record deleted from MongoDB. Done. No complex P2P garbage collection needed. The P2P layer (ledger, governance) doesn't contain user content — only economic transactions which are public by design.

---

## C. Service Lifecycle

### C9. Where do service databases live?
**Status:** RESOLVED (Phase 42)
**Answer:** On internet infrastructure — MongoDB for structured data, S3 for blobs/files. Nodes are stateless proxies, not storage servers. The StorageBackend abstraction (Phase 42) makes this pluggable: MongoDB, S3, or local filesystem (dev mode). Resource providers contribute storage credentials to the network and earn Lux.

### C10. How does "scaling" work for services?
**Status:** ANSWERED (proposed)
**Answer:** For Day 1: not needed (Jai is the only user). For future: the service is static files + an API. Static files can be replicated to multiple nodes (P2P CDN). API scaling requires the service code to be deployable on multiple nodes. This is months out. Don't build it now.

### C11. How do agents maintain institutional knowledge about old codebases?
**Status:** ANSWERED (proposed)
**Answer:** Every service has a `SERVICE.md` in its codebase -- auto-generated and updated by agents after every change. Contains: architecture overview, key files, conventions, known issues, change history. New agents read this first. It's like CLAUDE.md but per-service. Build this into the agent workflow from Day 1 -- it's cheap and prevents institutional knowledge loss.

### C12. How do rollbacks work?
**Status:** ANSWERED (proposed)
**Answer:** All service code is in git. Every agent change is a commit. Rollback = `git revert`. The Monitor agent detects regressions (health check fails after deploy), creates a rollback task. Git gives us this for free. Just need the Monitor to detect regressions. Phase 16 (DONE) implements this.

### C13. How do we handle cross-service dependencies?
**Status:** OPEN
**Answer:** TBD. This is a hard problem at scale. For near-term: services declare their dependencies in a manifest. Breaking changes trigger alerts to dependent services. Not Day 1. Solve when we have 2+ services that depend on each other.

---

## D. Testing & Quality

### D14. Who runs E2E tests? How?
**Status:** RESOLVED
**Answer:** Phase 17 (Smart QA) implements this. QA agents spawn with Playwright MCP. Planner generates test plans. Agent opens a real browser, clicks through flows, verifies results. This is a generated agent like any other -- the Planner creates a testing profile based on what was built.

### D15. How do we ensure consistent quality?
**Status:** RESOLVED
**Answer:** Quality gates in the Scheduler + Manager:
1. Every service change must pass automated tests before deploy (Phase 16+17)
2. Profile scoring: agents that produce low-quality work get profiles deprioritized
3. Manager reviews all task output (Phase 22)

### D16. How do we prevent insecure code?
**Status:** PARTIALLY RESOLVED
**Answer:** Multiple layers implemented:
1. Agent prompts include security guidelines (OWASP top 10)
2. Phase 12.5 Content Safety Review (rule-based scan)
3. Phase 12.7 Immutable Kernel (can't modify critical files)
4. Guardrails (Phase 16.2) tiered protection
Remaining: automated npm audit, static analysis tooling

---

## E. Agent Coordination & Safety

### E17. How do multiple agents coordinate on shared codebases?
**Status:** RESOLVED
**Answer:** File registry (file-registry.ts) for claim/release. Workers are isolated in workspaces (Phase 1). Manager coordinates all work (Phase 19/22). Workers CANNOT see other workspaces, spawn agents, or create tasks.

### E18. How to prevent runaway agent spawning?
**Status:** RESOLVED
**Answer:** Hard limits in Scheduler (maxConcurrentTasks), task depth limits, budget per project (Phase 20.8), circuit breaker. Worker lockdown (Phase 19.2) prevents workers from creating tasks. Only Managers create tasks.

### E19. Who controls spending? Budget enforcement?
**Status:** RESOLVED
**Answer:** Phase 20.8 (Owner Authority & Budget) implements daily Lux budget limits per project. AutonomyLevel (full/supervised/manual). Budget enforcement defers tasks when exceeded. No fixed dollar budget limit from Jai -- use what's needed.

### E20. How to handle malicious nodes?
**Status:** RESOLVED
**Answer:** Phase 12 implements layered defense:
1. Reputation system (Phase 10.3)
2. SecurityMonitor with 5 detectors (Phase 12.2)
3. Witness-based emission (Phase 12.1)
4. Resource proof challenges (Phase 12.3)
5. Reputation-weighted governance (Phase 12.4)
6. Network quarantine protocol (Phase 12.6)

---

## F. The Registry & Context Problem

### F21. How does the Registry work?
**Status:** RESOLVED
**Answer:** Phase 11 ContentRegistry. SQLite table synced via GossipSub (`pando/content` topic). Full-text search, version-wins merge. Every node sees every record (lightweight metadata). This is the "DNS" of Pando.

### F22. How does an agent find the RIGHT context from the Registry?
**Status:** ANSWERED
**Answer:** The Manager resolves context (replaced Planner for this role). Manager queries ContentRegistry, determines what files/repos the worker needs, writes it into the worker's CLAUDE.md context. Quality improves as the Registry gets better metadata.

### F23. How does the Scheduler resolve abstract context needs to file paths?
**Status:** ANSWERED
**Answer:** Two approaches:
1. For known services: Manager specifies concrete paths ("clone repo X, read file Y")
2. For unknown needs: the agent itself searches (Claude Code can grep, glob, read files)
The Scheduler provides the starting point. The agent explores from there. Session-tier agents are smart enough to find what they need. API-tier agents get fixed context.

---

## G. Economics & Sustainability

### G24. Lux <-> real-world economics?
**Status:** OPEN
**Answer:** TBD. For Day 1: Lux has no real-world value. It's an internal accounting unit. Real economics emerge when the network has enough users that Lux becomes tradeable. Don't solve this now. Focus on making the network useful.

### G25. Who subsidizes essential infrastructure?
**Status:** ANSWERED
**Answer:** The NETWORK account mints Lux. Essential services (Registry, health monitoring) are funded by emission rewards. Like how Bitcoin miners get block rewards for securing the network. Already implemented in the emission system.

### G26. Race to the bottom (cheap vs quality)?
**Status:** ANSWERED
**Answer:** Profile scoring prevents this. If cheap agents produce bad results, their profiles score low, they stop getting tasks. The market self-corrects: cheap + good wins, cheap + bad dies. Profile scoring implemented in Phase 1.

---

## H. Architecture & Migration

### H27. How do we migrate from current to new architecture?
**Status:** RESOLVED
**Answer:** Migration is DONE. Old agent system deleted (8,664 lines, commit `0430e27`). New Manager + Scheduler architecture is the current production system.

### H28. How does code get versioned in workspaces?
**Status:** ANSWERED
**Answer:** Each workspace task operates in the main git repo or isolated workspace. Agent commits go through the pipeline (Phase 16). Git is the versioning system.

### H29. How does the node host services in other languages?
**Status:** OPEN
**Answer:** For Day 1: it doesn't. Agents build Node.js/TypeScript services. For future: Docker containers per service. Each service specifies its runtime in a manifest. Docker support is Phase 14+.

---

## I. The Two Laws

### I30. Where do the Two Laws get enforced?
**Status:** PARTIALLY RESOLVED
**Answer:** Multiple layers implemented:
1. Manager level: Manager prompts include Two Laws
2. Agent level: All CLAUDE.md context includes Two Laws
3. QA level: Content Safety Review (Phase 12.5)
4. Governance level: Community can flag and vote to remove harmful services
5. Immutable Kernel: Two Laws enforcement code cannot be modified by any agent (Phase 12.7)

### I31. How literally do we take Law II?
**Status:** ANSWERED
**Answer:** Law II means the NETWORK persists, not any individual node. If Jai turns off both nodes, the network is dead. Law II kicks in when there are enough nodes that no single person can shut them all down. PM2 process supervisor (Phase 22.6) and binary rollback (Phase 15.6) are the current implementations. It becomes real when there are 10+ independent node operators.

---

## J. Practical Right Now

### J32. What's the minimum viable demo?
**Status:** RESOLVED
**Answer:** DONE. Task submission -> Scheduler -> workspace -> Planner -> agent -> result. Proven across all session tiers. Express API (86.7s), URL Shortener (184.9s), and many more.

### J33. Keep current agent system running while building new?
**Status:** RESOLVED
**Answer:** Old agent system fully deleted (commit `0430e27`). New Scheduler + Manager architecture is the only system.

### J34. What tests to run first with two nodes?
**Status:** RESOLVED
**Answer:** All verified in Foundation Sprint F3:
1. Nodes discover each other (mDNS or bootstrap) -- PASS
2. Ledger sync (Lux transfer) -- PASS
3. GossipSub messaging (governance) -- PASS
4. Task queue sync -- PASS
5. Cross-node task execution -- PASS

---

## From ARCHITECTURE-PLAN.md "Open Questions" Section

### 1. Agent pool security
**Status:** OPEN (elevated risk)
**Answer:** If profiles are shared via P2P, malicious profiles could compromise nodes. Need: (a) profile hash verification, (b) sandbox first-run of imported profiles, (c) reputation gate before auto-import. Phase 12 security hardening adds reputation gates and SecurityMonitor, but profile sandboxing not yet implemented.

### 2. API key management
**Status:** RESOLVED (Phase 69)
**Answer:** Agents use AI keys from CredentialStore (MongoDB, encrypted with AES-256-GCM + master key). ResourceRegistry provides metadata only; credentials stored in MongoDB `pando_credentials` collection. Only compute nodes with `CREDENTIAL_MASTER_KEY` can decrypt. User nodes route AI requests to compute nodes via P2P (`pando/ai-query`). Budget tracking per-manager implemented (Phase 20.8). Daily budget caps mitigate runaway spending.

### 3. Content hosting
**Status:** RESOLVED (Phase 11)
**Answer:** Hybrid approach: GitHub repos under `pando-network` org for early days (free hosting, CDN, versioning). ContentRegistry on Pando tracks metadata via GossipSub. Migrate to Pando-native storage when network is big enough (100+ nodes).

### 4. Payment flow
**Status:** OPEN
**Answer:** User pays 50 Lux for a website. Who gets paid? Node operator? Split between node + network? Phase 11.8 implements 40/40/20 split (hosting/building/network) for content. Full payment flow design in REWARD-ARCHITECTURE.md.

### 5. Planner quality
**Status:** RESOLVED (Phase 10.4, commit `aca140a`)
**Answer:** Multi-Planner consensus: for high/critical tasks, calls Planner 3x in parallel, compares tier/role/tools agreement (3-dimensional scoring), builds consensus profile. Profile quality tracked via ProfileCache scoring.

### 6. Context assembly
**Status:** OPEN
**Answer:** Generating a system prompt is easy. Figuring out what FILES the agent needs is hard. Phase 18.4 (User Context Detection) helps with keyword-based file detection. Manager (Phase 22) can read the codebase directly to determine context needs.

### 7. When do we go public?
**Status:** OPEN
**Answer:** Repo is still private. Need to clean up before open-sourcing.

### 8. More brainstorming needed
**Status:** ONGOING
**Answer:** Jai has more ideas to discuss. This plan will evolve.

### 9. Workspace escape prevention
**Status:** PARTIALLY RESOLVED
**Answer:** Phase 19 worker lockdown blocks POST /tasks but doesn't prevent filesystem reads outside workspace. Workers running Claude Code CAN read any file on disk. Acceptable for self-managed network tasks but dangerous for user-project workers handling untrusted code. Future: chroot/container sandboxing.

### 10. Tool scoping per role
**Status:** RESOLVED (commit `f480d61`)
**Answer:** Three-layer enforcement: (1) `--disallowedTools` CLI flag on Claude Code spawn, (2) `.claude/settings.json` deny rules in workspace, (3) CLAUDE.md Layer 7 instructions. Always denied: Task (no sub-agent spawning), NotebookEdit. Conditionally denied based on profile needs.

### 11. API authentication
**Status:** RESOLVED (`e9f559c`)
**Answer:** Bearer token auth on write endpoints (POST/PUT/DELETE). Public reads exempt (GET/HEAD/OPTIONS). Token stored at `~/.pando/api-token` (auto-generated, 32-byte hex). Gateway auto-discovers token.

### 12. GossipSub message ordering
**Status:** OPEN (TD-09)
**Answer:** GossipSub delivers messages in arbitrary order. Task state transitions can arrive out of order. Need: monotonic sequence number per task. Reject/buffer events that arrive out of order.

### 13. Manager split-brain prevention
**Status:** RESOLVED (Phase 19.8)
**Answer:** Lease-based ownership. Manager has leaseExpiry timestamp. Only lease holder can create tasks. On lease expiry, First-Claim-Wins for new host. Split-brain protection: earlier timestamp wins when partition heals.

### 14. Circuit breaker for AI providers
**Status:** RESOLVED (P4, `c7c8277`)
**Answer:** CircuitBreaker class in planner.ts. 5 failures -> 60s cooldown -> half-open probe. Applied to generateProfile() and decomposeTask().

### 15. Task queue durability
**Status:** RESOLVED (P0, `ce8e391`)
**Answer:** TaskQueue migrated to SQLite with WAL mode. 6 tables, 9 indexes. Auto-migrates from tasks.json on first run.

---

## Open Architectural Questions (2026-02-18)

### Worker sessions -- persistent or fire-and-forget?
**Status:** OPEN
**Answer:** Workers currently fire-and-forget (spawn per task). Session reuse via `--continue` implemented (Phase 20.3) but untested at scale. Question: should workers be persistent for frequently-accessed areas?

### Resolved architectural questions:
- **stdin protocol** -- RESOLVED. Claude Code does NOT support persistent stdin/stdout. Correct model: per-event spawn with `--continue --resume <sessionId>`. Proven working.
- **Context window management** -- RESOLVED. Memory graduation at 30k tokens. Session reuse via `--continue`.
- **Multi-manager coordination** -- RESOLVED. One `pando-node-mgr` + one per project. Per-event spawn model.
- **Cost model** -- RESOLVED. ~$0.02/event (cache hits). $2-5/day idle.
