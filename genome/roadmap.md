# Pando Roadmap

> Last updated: 2026-02-26
> All phases 0-35, 38, 40-70, 73, 78, 79, 80, 81, 82, 83, 86, 87, 88, **89**, **90**, **91**, **92** COMPLETE. Phase 53.7, 53.8, 68.4 COMPLETE. Phase 53.9 deferred. Phase 14 (Universal Onboarding) deferred. v2.1-v2.5 architecture complete.
> **Phase 93 DONE:** Direct TCP stream for request/reply unicast calls — P2P storage proxy calls now use direct TCP stream first (sendMessage), falling back to GossipSub if direct TCP fails. Makes `pando/storage-proxy` P2P calls between LS-2 and EC2-1 reliable without GossipSub mesh dependency. `REQUEST_REPLY_REQUEST` + `REQUEST_REPLY_REPLY` MessageTypes added. Broadcast query() (to: '*') still uses GossipSub. 18/18 smoke test PASS.
> **Phase 92 DONE:** Direct TCP stream capability profile exchange — fix GossipSub mesh failures in small networks. After simultaneous node restarts, GossipSub mesh (D=6) often fails to form with only 1-2 peers. `CAPABILITY_PROFILE_DIRECT` MessageType added. On peer connect, nodes now send their capability profile via direct TCP stream (2s delay) in addition to GossipSub broadcasts. This guarantees compute peers are discovered even when GossipSub mesh fails. 18/18 smoke test PASS.
> **Phase 91 DONE:** P2P public IP announce — fix EC2/VPS node P2P isolation. `publicIp` added to `NodeConfig`. `PUBLIC_IP` env var wired through cli.ts → `NodeConfig.publicIp` → libp2p `announce` addresses. EC2 nodes now advertise their public IPs so other peers can dial them directly. EC2-1 peers jumped to 8. 18/18 smoke test PASS.
> **Phase 90 DONE:** One-line install script — `curl -fsSL .../install.sh | bash`. Checks Node.js 18+, clones pando-lux/pando, npm install + build, starts node with bootstrap peer. Node-setup page updated with prominent one-liner section.
> **Phase 89 DONE:** Developer Hub — `/dev` page. Live stats, quick start commands, 4 code example tabs, 12 expandable API endpoints with request/response examples, architecture overview. NavBar: Dev link.
> **Phase 88 DONE:** Auto-detect tier from code at deploy time. `detectTierFromCode(appDir)` inspects package.json at the compute node. Doorman's tier is a hint; compute node's detection is authoritative.
> **Phase 87 DONE:** P2P Deploy Discovery — replaced CloudInstanceManager with CapabilityProfile. Deploy/undeploy routes via P2P to compute peers with mongodb storageBackend. `deployPeerId` on project record.
> **Phase 86 DONE:** JWT Auth — Stateless Cross-Node Authentication. Self-verifying JWT tokens signed by Ed25519 keys. Any node verifies any token via `peerIdFromString().publicKey.verify()`. No DB lookup needed. 11/11 cross-node tests.
> **Phase 83 DONE:** Network Hardening — P2PStorageBackend + Two-Tier Trust. Untrusted nodes proxy all storage via P2P. Lightsail runs as untrusted (storageBackend=p2p, no MongoDB). EC2 as trusted compute (systemd, MongoDB, master key). 18/18 E2E tests passing, zero intervention.
> **Phase 82 DONE:** Simple Self-Upgrade — replaced complex patch-distribution system with `git pull` + hash verification. Governance approves → commit hash broadcasts via GossipSub → all nodes pull + verify + build + restart. Deleted ~850 lines of canary/rollout/patch code.
> **Phase 80 DONE:** Production App Hosting — nginx reverse proxy, PM2, persistent port registry, undeploy endpoint. Full E2E verified.
> **Phase 70 DONE:** Unified App Platform — unified deploy endpoint, GitHub push via resource PAT, EC2 URL fix, S3 URL fix, auto-assign code_repository, tier storage, credential stripping from agents. Fixes 8 of 18 E2E gaps.
> **Phase 69 DONE:** Secure Credential Architecture — two-tier trust (EC2 compute = trusted, user nodes = untrusted). CredentialStore (MongoDB + master key), ResourceRegistry rewritten as metadata-only, P2P ai-query routing. Old envelope encryption removed.
> **Phase 68: Launch Readiness — ALL DONE.** 68.1 Collection Namespace Isolation (DONE), 68.2 GitHub Push Identity (DONE), 68.3 Doorman/OpenAI Router (DONE), 68.4 Returning User Routing (DONE — gateway chat shows "Your Projects" sidebar). Legacy cleanup DONE. See "Phase 68" section below.
> **Phase 67 DONE:** Self-Upgrading Network + Tier 2 E2E. P2P upgrade handler, env var injection, manager stale-memory fix, compute instance context injection. Full Tier 2 E2E verified.
> **Phase 65 DONE:** Secure App Hosting E2E — S3 (Tier 1) and EC2 (Tier 2) verified. Test app uses MongoDB through Resource Proxy without seeing credentials.
> **Phase 64a DONE + E2E TESTED:** CloudInstanceManager launches locked-down EC2 instances from contributed AWS creds. No SSH, tripwire-protected, bootstraps from public repo, joins P2P network automatically.
> **Phase 64b-c (FUTURE):** Split-key credential encryption (64b) layers ON TOP of Phase 69 (not replaces). P2P code attestation (64b). Hardware enclaves (64c). Full protocol: `genome/rules/credential-security.md`.
> **Phase 63 DONE + fixes:** P2P Project Registry + 4 E2E pipeline fixes (write-through bridge, URL injection of all 3 vars, agent auth bypass for project endpoints, template updates). Lightsail updated and syncing.
> **Phase 62 DONE:** App Hosting Architecture + URL Injection. 3-tier hosting doc (`genome/flows/app-hosting.md`). Gateway URL injection at deploy time (`window.PANDO_GATEWAY_URL`). EC2 (t3.small, `3.89.139.27`) configured with Node.js + nginx, registered as `cloud_compute` resource. MongoDB Atlas registered as `storage_db` resource. Protocol v1.1 + template updates.
> **Phase 57 DONE:** Clean Data Architecture — eliminated dual-write. MongoDB is single source of truth for user data. LocalStorageBackend deleted. All user data stores require StorageBackend. Write pattern: MongoDB-first (awaited), then SQLite cache. No StorageBackend = 503 for user data endpoints. `loadFromBackend()` hydrates SQLite cache from MongoDB on startup.
> **Phase 56 DONE:** P2P User Accounts — auth data (username, password_hash, is_claimed) moved to P2P-synced ledger accounts table. Account claims broadcast via GossipSub ACCOUNT_CLAIM. Login works from any node. MongoDB/StorageBackend removed from UserAccountStore. Local auth-local.db for sessions + key_store only.
> **Phase 55 DONE:** Resource UX Simplification + User Ownership + Zero-Prompt Startup. Service-first contribute form (6 presets). Resources owned by users (userId), not nodes. Zero-prompt TUI startup (auto-create/auto-load identity, no chooser). `/login` links gateway account to node — rewards flow to user. No login = no rewards (node volunteers). Launchers fixed (tui.js not cli.js). SSE spam fix.
> **Phase 54 DONE:** Zero-Config Node + Legacy Cleanup. Auto-connect bootstrap (Lightsail public IP). Peer persistence (`known-peers.json`). Transfer to any valid peerId. Node identity = reward recipient (deleted operatorPeerId/Token/Username). Old TUI `/login`/`/register`/`/account` deleted (~200 lines). `--auto-update` deleted. `--storage` deprecated.
> **Phase 53 DONE (53.0-53.5):** Full-Stack App Independence + Resource Proxy. Protocol Memo System v1 (genome/protocol.md). All /apps/data legacy deleted. Resource Proxy on gateway (credential privacy, 9 MongoDB ops, rate limiting, caching, metering). Project resource assignment + API keys. Templates rewritten (3 app patterns). Test apps built (PandoChat social, LuxRunner game). 25/25 QA tests PASS.
> **QA Sweep DONE (2026-02-22):** 3-agent testing (gateway Playwright + TUI/API curl + deep 2-user). 5 bugs fixed (guest rate limit, thread isolation, JSON error, port config, balance display). QA framework at `tests/qa/`. 12/12 deep flows pass. Flows 13-24 (collaboration, search, content, resources, payment, chess game) documented but not yet tested.
> **Phase 38 DONE:** Public Node AI Access + Service Catalog — Lightsail has `--scheduler` + Claude Code. Gateway `/services` page with 5 service cards, live status, pricing, provider earnings. NavBar link.
> **Phase 50 DONE:** Network Council — rotating council of top-reputation AI-capable nodes for autonomous reflection. `council.ts` (selection, rotation, daily reflection prompt assembly, minutes persistence), `network-state.ts` (metrics aggregation). Node API: `GET /council`, `GET /council/minutes`. Gateway: `/council` page (members table, rotation info, minutes display, network state overview), proxy routes, NavBar link. AI reflection calls stubbed (prompt assembly only).
> **Phase 49 DONE:** Capacity Dashboard — `GET /capacity` endpoint aggregates supply/demand/rewards/network from ResourceMarketplace, CapabilityRegistry, ResourceMeter, Scheduler, Ledger, HealthMonitor (each try/caught). Gateway: `/capacity` page (5 sections, 30s auto-refresh), `/api/capacity` proxy, NavBar link.
> **Phase 48 DONE:** Unified Identity — one account everywhere. Gateway auth (guest, claim, login). **Note: Old TUI operator system (`/register`, `/account`, `operatorPeerId`) deleted in Phase 54. New `/login` added in Phase 55 — links gateway user account to node for rewards.**
> **Phase 46 DONE:** Project Lifecycle — fixed 2 critical routing bugs (thread follow-ups hardcoded to pando-node-mgr, thread creation not storing projectId), added PATCH /chat/threads/:id, 3 manifest fields (repoUrl/teamHistory/notes), manager template principle #11, gateway enhancements (Open Chat, projectId-aware chat, marketplace proxy, thread PATCH proxy). Build: zero errors.
> **Phase 45 DONE + E2E VERIFIED:** Operator Experience — gateway chat routes prefer Claude-capable nodes (`getNodeUrl('claude')`), node P2P chat fallback (`forwardChatToPeer()` tries up to 3 Claude-capable peers), TUI resource management (`/resources`, `/contribute`, `/revoke`). 13/13 Playwright E2E tests pass.
> **Phase 44 DONE + QA VERIFIED:** Data Residency — 12 MongoDB collections for ProjectStore/RevenueEngine/ContributionTracker. Session validation unified (deleted sync/async split, single async path). 35 route handlers updated. QA: full project lifecycle verified with MongoDB active.
> **Phase 43 DONE + E2E TESTED + DEPLOYED:** Multi-Node Gateway — NodePool with health checks + circuit breaker, `fetchWithFailover()`, `PANDO_NODES` env var, discovery, NavBar health indicator. E2E tested: 2-node failover + auto-recovery. Deployed to Vercel (`gateway-one-mu.vercel.app`). Fix: `@noble/curves` pinned to v1.x (v2 broke Turbopack subpath exports).
> **Phase 42.5 DONE:** Resource Registry — network-level shared resources with envelope encryption (X25519 ECDH + AES-256-GCM), P2P replication via GossipSub, gateway resources page, legacy `api-keys.json` deleted.
> **Phase 35 DONE:** Guest Lux Faucet + Reclamation — free Lux on signup, 30-day reclamation to NETWORK for unclaimed guests, welcoming gateway UX.
> **Phase 33.4 DONE + E2E VERIFIED:** Full autonomous self-upgrading loop working. User message → manager classifies → builds fix → governance proposal → auto-vote → instant quorum → pipeline triggered → git diff extracts → guardrails pass (governance bypass) → autonomous commit (0a6bcba) → restart. First fully autonomous pipeline commit achieved. Remaining: 33.5 (multi-user conflict), 33.6 (attribution), 33.7 (project-level governance), 33.8-33.10 (cross-node).
> **Phase 32.5 DONE:** Agent-Driven Deployment — E2E verified. Manager builds content, calls POST /agents/:id/deploy, returns public URL. Event prompt injection solves context compression in long-running sessions. Session reset endpoint for fresh starts.
> **Phase 32 DONE:** S3 Hosting Service — deploy project sites to AWS S3, public/private access control, pre-signed URLs. E2E verified (7/7 tests).
> **Phase 31 DONE:** Project Economy — project model, revenue engine, collaboration, marketplace, contribution tracking, content safety. ~4,500 lines.
> **Phase 30 DONE:** AI-Powered Governance — proposal staking, reviewer selection, AI review, decision engine, meta-governance. ~1,600 lines.
> **Phase 29 DONE:** Agent Directive Persistence — standing directives, self-continuation, watchdog. E2E verified.
> **Phase 28 DONE:** Architecture Alignment — 13 blueprint gaps closed, 25/30 capabilities DONE.

---

## Remaining Technical Debt (Open)

| ID | Severity | Component | Issue | Notes |
|---|---|---|---|---|
| TD-09 | MEDIUM | GossipSub | No message ordering -- no sequence numbers, out-of-order events cause state divergence | Task state transitions (created, claimed, in_progress, completed) can arrive out of order on remote nodes. Fix: add monotonic sequence number per task, reject/buffer events that arrive out of order. |
| TD-13 | LOW | GossipSub | No priority/backpressure -- bandwidth saturation at scale | All GossipSub messages are equal priority. At scale (100+ nodes, heavy traffic), high-priority messages (ledger sync, emission proposals) compete with low-priority messages (profile sync, strategy suggestions). Fix: message priority tiers + backpressure signaling. |
| TD-14 | LOW | P2P | Clock skew in First-Claim-Wins -- some nodes always win | First-Claim-Wins uses timestamps to resolve contention. Nodes with faster clocks always claim first. Fix: logical clocks (Lamport or vector) instead of wall-clock timestamps. |
| TD-31 | MEDIUM | ResourceRegistry | Registry metadata lost on node reinstall | ResourceRegistry stores metadata (type, status, provider) in SQLite, but credentials in MongoDB CredentialStore. If the node's SQLite is wiped during a reinstall/bootstrap, all contributed resource records are gone — even though the encrypted credentials are still orphaned in MongoDB. Fix: for trusted (MongoDB-connected) nodes, also persist registry metadata to MongoDB so it survives reinstalls. On startup, hydrate SQLite from MongoDB if empty (same pattern as thread/message cache). |
| ~~TD-15~~ | ~~LOW~~ | ~~P2P~~ | ~~Profile cache poisoning via shared profiles~~ | **SUPERSEDED (Phase 27):** profile-cache.ts and profile-sync.ts deleted. No more auto-imported profiles. |
| ~~TD-25~~ | ~~MEDIUM~~ | ~~Manager/Pipeline~~ | ~~Manager-Pipeline commit handoff~~ | **RESOLVED (Phase 25)** — Pipeline commit trigger removed from orchestrator. Manager is the ONLY committer via workflow. No conflict possible. |
| ~~TD-29~~ | ~~HIGH~~ | ~~Manager~~ | ~~Manager CLAUDE.md references admin_docs/~~ | **RESOLVED (Phase 25)** — Fixed manager-context.ts line 236 to reference genome/ paths. |
| ~~TD-30~~ | ~~MEDIUM~~ | ~~Orchestrator~~ | ~~No event-driven agent communication~~ | **RESOLVED (Phase 25)** — Bridge Queue replaces heartbeat. Workers post mid-task via POST /tasks/:id/messages. Event-driven, zero cost when idle. |

**Summary:** 27 of 31 tech debt items resolved. 4 remain open (TD-09, TD-13, TD-14 — P2P issues deferred to Phase 20+; TD-31 — ResourceRegistry durability). TD-15 superseded by Phase 27 (deleted files).

---

## Next Up: Phases 96–99 — Resource Tier Architecture

> **Full plan:** `genome/resource-tier-plan.md`
> **Status:** Planning complete — ready to build

**Problem:** Claude Code and other capabilities are auto-detected and broadcast to the entire network with no opt-in. There is no concept of "local private" resources. The gateway also hardcodes node discovery and tries to directly HTTP-reach Claude nodes (breaks for home/NAT nodes).

| Phase | Goal | Depends On | Status |
|---|---|---|---|
| **96** | Three-Tier Architecture — `LocalCapabilityStore`, split detection from sharing | None | **COMPLETE** |
| **97** | Opt-In Commands — `/contribute claude-code`, `/revoke`, `shareCompute` flag | Phase 96 | **COMPLETE** |
| **98** | P2P Task Routing — gateway → EC2 → P2P → Claude node (home nodes now viable) | Phase 97 | **COMPLETE** |
| **99** | Dynamic Discovery — NodePool self-populates from P2P, no hardcoded seeds | Phase 97 | **COMPLETE** |
| **100** | myNodes Routing Tier — same-user nodes preferred before network peers. `linkedUser` auth on P2P routes. `/contribute claude-code myNodes\|network` scope | Phase 99 | Pending |
| **101** | **Council Self-Healing Loop** — close the gap between "Council proposes" and "Council fixes". Wire AI call in `runDailyReflection()`, add `spawnFixAgent()`, Tier 4 auto-approval in governance, patch application in UpgradeProtocol. See `the-stack.md` Council section for full wiring spec. | Phase 50 done | Pending |
| **102** | **Adversarial QA Loop** — Three-ring QA model. Ring 3 = fresh-context adversarial agent with no code knowledge, hostile framing, micro-agent per flow, evidence required for every verdict. QA Memory Agent (persistent, accumulates failure history). Council must pass Ring 3 before any governance auto-approval. See `the-stack.md` QA Architecture section + `genome/templates/qa-adversarial.md`. | Phase 101 | Pending |
| **103** | **Genome Evolution** — After every completed project, a Genome Agent analyses outcomes (QA results, build time, failure patterns) and updates the Learned Lessons sections in agent templates. Makes every future agent spawn smarter. See spec below. | Phase 102 | Pending |
| **104** | **Agent Economic Autonomy** — Agents earn a Lux sub-budget from completed tasks. Can spend from that budget to hire child agents (researcher, reviewer) without user intervention. Agents become economic actors, not just cost centres. See spec below. | Phase 103 | Pending |
| **105** | **Council Growth Engine** — Council daily reflection gains a second output: one growth action proposal per week when network is healthy. Council drafts the actual outreach message. Governance votes before any public posting. Network grows itself when ready. See spec below. | Phase 101 | Pending |
| **106** | **Decentralization Milestone Protocol** — Automatic Layer 0 governance power transitions based on unique human operator count. Baked into kernel — not governable. Defines when Jai's node stops having special weight. See `genome/rules/decentralization-milestones.md`. | Phase 50 | Pending |

---

## Phase 101 — Council Self-Healing Loop (SPEC READY)

> **Status:** Not started. All infrastructure exists. Pure wiring.
> **Effort:** ~4 focused tasks. Each is independent and can be done in any order.
> **Why this matters:** closes the loop from "bugs reported → AI fixes → deployed" without human intervention.

### The Gap

`platform/council.ts` assembles a daily reflection prompt from network state + genome state + council minutes. The AI call at the bottom of `runDailyReflection()` is **stubbed** — it returns hardcoded text instead of calling Claude Code. Everything after that (spawning a fix agent, submitting a governance proposal, auto-approval, patch deploy) is not wired.

### The 4 Tasks

**Task 1: Activate AI call in `platform/council.ts`**
- Replace the stub return in `runDailyReflection()` (~line 252)
- Use `this.node.getAIBackendRegistry?.()?.getBestBackend()` to get the AI backend
- Call `backend.run({ prompt, sessionId: undefined, workDir: this.councilDir })`
- Parse the response text into `ReflectionResult` (summary, proposals[], minutesEntry)
- The prompt already tells the AI to format as council minutes — parse that format

**Task 2: Add `spawnFixAgent()` to `platform/council.ts`**
- When AI response includes a bug fix recommendation, Council spawns a builder agent
- Call `this.node.getAgentManager()?.spawnAgent({ role: 'builder', context: issueDescription + relevantFiles, projectId: 'pando-node' })`
- Agent reports back via `POST /v1/agents/:id/report` with patch content
- Council receives the report and proceeds to Task 3

**Task 3: Tier 4 auto-approval in `kernel/governance.ts`**
- Add auto-approval logic: if `proposal.tier === 4` AND `proposal.testResults.allPassing === true` AND age >= 24h → auto-approve
- Proposal payload must include: `{ type: 'code_fix', tier: 4, patch: string, testResults: { allPassing: boolean, summary: string }, agentId: string }`
- Only applies to Tier 4 (Layer 3-4 code changes). Tier 3 and above still requires quorum vote.

**Task 4: Patch application in `core/upgrade-protocol.ts`**
- Add `applyPatch(patch: string): Promise<void>` alongside existing `gitPull()` path
- `git apply --check <patchfile>` first (dry run). If clean: `git apply <patchfile>`
- Then execute existing build → QaRunner → restart flow
- Governance approval handler: if `proposal.type === 'code_fix'` call `applyPatch()` instead of `gitPull()`

### Test Bar (before marking complete)
- [ ] Council reflection runs and produces real AI output (screenshot council-minutes.md)
- [ ] A test bug description spawns a builder agent and it produces a patch
- [ ] Tier 4 proposal auto-approves after 24h with passing tests (verify in governance log)
- [ ] Patch applies cleanly, build passes, node restarts successfully
- [ ] Full regression suite (18/18) passes after patch apply

---

## Phase 102 — Adversarial QA Loop (SPEC READY)

> **Status:** Template created (`genome/templates/qa-adversarial.md`). Architecture documented (`the-stack.md` QA Architecture section). Implementation tasks below.
> **Why this matters:** standard QA agents have confirmation bias — they know what was built and guide tests toward success. Ring 3 adversarial QA has zero code context and hostile framing ("find something broken"). This closes the gap between "tests pass" and "actually works for users."

### The Problem

When a builder agent writes code AND the QA agent testing it was spawned by the same manager AND shares the same project-state.md context, confirmation bias is baked in. The QA agent unconsciously guides tests toward confirming what it was told should work. This is not a bug — it is how context works.

Additionally: a single QA agent running 50 tests will start compressing context by test 30. It hallucinates results. Skips steps. By test 45 it is writing PASS from memory, not from actual test execution.

### The Three Rings

```
RING 1 — Builder's own tests          (confirmation bias OK — fast, catches obvious errors)
RING 2 — Manager integration tests    (structured bias — catches integration failures)
RING 3 — Adversarial QA               (NO code context, hostile framing, micro-agents)
```

Ring 3 only runs after Ring 1 and Ring 2 pass. Governance only receives proposals that passed all three. Any Ring 3 FAIL → escalates to quorum vote regardless of tier.

### The 4 Implementation Tasks

**Task 1: Adversarial QA template** ← DONE
- `genome/templates/qa-adversarial.md` created
- No code context injection, hostile framing, micro-agent per flow, evidence required

**Task 2: Add `runAdversarialQA()` to `platform/council.ts`**

```typescript
async runAdversarialQA(
  flows: string[],  // e.g. ['deploy-app', 'governance-vote', 'lux-transfer']
  changeDescription: string,
): Promise<QAResult[]> {
  const results: QAResult[] = [];

  // Spawn ONE micro-agent per flow — parallel, no shared context
  const agents = await Promise.all(flows.map(flow =>
    this.node.getAgentManager()?.spawnAgent({
      role: 'qa-adversarial',        // uses qa-adversarial.md template
      template: 'qa-adversarial',
      context: [
        `FLOW TO TEST: ${flow}`,
        `DO NOT READ: you have no knowledge of what changed.`,
        `QA MEMORY BRIEFING:\n${this.getQAMemory(flow)}`,
        `GATEWAY URL: http://127.0.0.1:${gatewayPort}`,
        `API PORT: ${apiPort}`,
        `API TOKEN: ${apiToken}`,
      ].join('\n'),
      parentId: null,
      projectId: 'pando-node',
    })
  ));

  // Wait for all micro-agents to report back
  // Collect results via bridge queue
  return results;
}
```

**Task 3: QA Memory Agent (`platform/qa-memory.ts`)**

A persistent agent (not per-task) that:
- Accumulates failure history per flow (`qa-memory.json` in council dir)
- When a Ring 3 test FAILs: records the flow name, what broke, what edge case triggered it
- When `runAdversarialQA()` runs: `getQAMemory(flow)` returns the historical failure patterns for that flow as a briefing string injected into the adversarial agent's context

```typescript
interface QAMemoryEntry {
  flow: string;
  failureDescription: string;
  edgeCaseTriggered: string;
  timestamp: number;
  fixed: boolean;
}
```

**Task 4: Wire Ring 3 into Council upgrade flow**

In the Council's code fix flow (Phase 101), after the builder agent produces a patch, before submitting the governance proposal:
1. Run `runAdversarialQA(STANDARD_FLOWS, patchDescription)`
2. If any result is FAIL → do not submit proposal. Log to council-minutes.md. Notify via HealthMonitor alert.
3. If all PASS → attach `ring3Results` to the governance proposal payload
4. Update Tier 4 auto-approval logic: require `ring3Results.allPassing === true` (not just `testResults.allPassing`)

### Standard Flow List (define these first)

The set of flows Ring 3 always tests after any change:
```typescript
const STANDARD_FLOWS = [
  'node-startup-connects',      // node starts, peers connect, balance appears
  'deploy-tier1-app',           // describe app → build → S3 URL → loads in browser
  'deploy-tier2-app',           // describe app → build → EC2 nginx URL → loads
  'governance-propose-vote',    // create proposal → vote → check result
  'lux-transfer',               // transfer Lux to peer → verify balance both sides
  'cross-node-storage',         // write thread on node A → read from node B
  'agent-spawn-complete',       // spawn agent → runs task → reports back
];
```

### Test Bar (before marking complete)
- [ ] `runAdversarialQA(['lux-transfer'])` spawns a micro-agent that tests the transfer flow and returns PASS with screenshot evidence
- [ ] Manually introduce a bug. Adversarial QA catches it. Reports FAIL with reproduction steps.
- [ ] QA Memory Agent records the failure. Next run injects historical failure into adversarial agent briefing.
- [ ] Council upgrade flow: patch with failing Ring 3 does NOT reach governance
- [ ] Patch with passing Ring 3: governance proposal includes `ring3Results` evidence

---

## Phase 103 — Genome Evolution (SPEC READY)

> **Status:** Not started. Depends on Phase 102 (QA Memory Agent is the first piece of this pattern).
> **Why this matters:** the system does not currently get smarter from experience. A builder that made the same mistake three times has no memory of it on the fourth task. Genome Evolution closes this. Every project makes every future agent better.

### The Idea

Agent templates have a `## Learned Lessons` section that starts empty. It is never written to systematically. Genome Evolution makes this section grow over time — automatically, from real project outcomes.

### What the Genome Agent Does

After every project reaches `completed` status in AgentManager, the Genome Agent is spawned with:
- The builder's workspace logs
- The QA ring results (what passed, what failed, what edge cases triggered)
- The manager's project-state.md
- The time spent per phase
- Any Council minutes generated during the project

It produces: specific, actionable entries for the `Learned Lessons` sections of whichever templates were involved. It does NOT rewrite principles — it only appends to `Learned Lessons`.

Example output:
```markdown
## Learned Lessons
- [2026-03-15] P2P storage proxy: always test with nodes on DIFFERENT machines.
  Same-machine tests pass but cross-machine tests fail due to localhost routing.
  Source: project pando-node-mgr, Ring 3 failure #3.
- [2026-03-20] Auth flows: JWT expiry edge case — test with a token that expires
  mid-request. Caused regression twice. Set test token TTL to 1 second in tests.
```

### Implementation Tasks

**Task 1: `platform/genome-agent.ts`** — new file
- Triggered by `AgentManager` when `project.status === 'completed'`
- Spawns once per project with `role: 'genome'` (new template needed: `genome/templates/genome.md`)
- Reads workspace + QA results → produces Learned Lessons entries
- Appends entries to the relevant template files in `genome/templates/`

**Task 2: `genome/templates/genome.md`** — new agent template
- Role: "You read project outcomes and write Learned Lessons. You never write principles. You only write what you learned from THIS project."
- Input: project logs, QA results, time data
- Output: specific entries with date, which flow failed, what the edge case was, which template to update

**Task 3: Hook in `core/agent-manager.ts`**
- When a project's root manager reports `completed`, call `genomeAgent.analyseProject(projectId)`
- Non-blocking — runs after the project is done, does not affect the user experience

### Test Bar
- [ ] Complete a project that has a Ring 3 failure. Genome Agent writes a Learned Lesson to the relevant template.
- [ ] The lesson is specific (names the flow, the edge case, the date) — not generic advice.
- [ ] Run the same project type again. The adversarial QA agent receives the historical lesson in its briefing.
- [ ] Templates do not grow unboundedly — Genome Agent trims entries older than 90 days if `Learned Lessons` exceeds 20 entries.

---

## Phase 104 — Agent Economic Autonomy (SPEC READY)

> **Status:** Not started. Depends on Phase 101 (Council loop) being stable.
> **Why this matters:** currently agents are pure cost centres — users pay Lux, agents spend it. This phase makes agents economic actors. Long-term, it enables the network to sustain itself without the founder continuously topping up Lux.

### The Idea

When a builder agent completes a task, it earns a small Lux reward (like uptime epochs). The agent receives a `luxSubBudget` — a portion of the earned Lux that it can spend autonomously to hire child agents without user authorisation.

Example:
```
User pays 50 Lux to build an app
Builder completes task, earns 5 Lux sub-budget
Builder decides: "I need better context on the auth flow"
Builder spawns Researcher with 2 Lux from sub-budget
Researcher returns context → Builder produces better output → earns higher reputation
Higher reputation → more tasks assigned → more Lux earned
```

### Key Rules

- `luxSubBudget` is funded only from task earnings, never from user balance
- Agent can only spend sub-budget on child agents (not transfer to other identities)
- Max autonomous spawn depth: 2 (agent can spawn one level of helpers — no infinite trees)
- Sub-budget is non-transferable and expires when the agent is cleaned up
- Law I applies: agent cannot hire agents to do anything a human could not authorize

### Implementation Tasks

**Task 1: `luxSubBudget` field on Agent**
- Add `luxSubBudget: number` to agent state in `core/agent.ts`
- Funded at task completion: `agentEarnings = taskReward * AGENT_EARNING_RATIO` (e.g., 10%)
- Persisted in agent's `state.json`

**Task 2: PaymentGate `from: 'agent'` path**
- `core/payment-gate.ts`: add `spendFromAgentBudget(agentId, amount, purpose)` method
- Checks `agent.luxSubBudget >= amount` before allowing autonomous spawn
- Deducts from agent sub-budget, not from user wallet
- Records in ledger as `agent_autonomous_spend` transaction type

**Task 3: AgentManager autonomous spawn check**
- When an agent calls `spawnAgent()` without a user-initiated request:
  - Check `parentAgent.luxSubBudget >= estimatedCost`
  - If yes: allow, deduct from sub-budget
  - If no: block, agent must message parent to request user authorisation

### Test Bar
- [ ] Builder completes task → `luxSubBudget` credited with 10% of task reward
- [ ] Builder spawns Researcher from sub-budget → PaymentGate deducts from agent budget, not user wallet
- [ ] Agent with zero sub-budget cannot spawn autonomously
- [ ] Sub-budget spend appears in ledger as distinct transaction type
- [ ] Governance proposal: set `AGENT_EARNING_RATIO` (default 10%) — changeable by Tier 3 vote

---

## Phase 105 — Council Growth Engine (SPEC READY)

> **Status:** Not started. Depends on Phase 101 (Council AI call activated).
> **Why this matters:** the Council currently only looks inward (maintenance, bugs, parameters). It has the best view of network health of any actor in the system. It should use that view to decide when and how to grow — not wait for a human to remember to post in r/selfhosted.

### The Idea

Council `runDailyReflection()` has two outputs today (after Phase 101):
- Output A: governance proposals (maintenance, bugs, parameters)

Phase 105 adds:
- Output B: one growth action proposal per week (when health criteria are met)

A growth action proposal:
```typescript
{
  type: 'growth_action',
  tier: 3,                           // requires 51% quorum — human vote before posting
  channel: 'reddit/r/selfhosted',
  draftMessage: string,              // Council writes the actual message
  rationale: string,                 // why the network is ready to grow now
  healthSnapshot: NetworkHealthData, // evidence: node count, ring3PassRate, uptime
}
```

### Health Criteria (Council only proposes growth when ALL met)

```typescript
const readyToGrow = (
  networkState.nodeCount >= MIN_NODES_BEFORE_GROWTH &&   // default: 10
  networkState.ring3PassRate >= 0.95 &&                  // 95% of Ring 3 tests passing
  networkState.nodeChurnRate7d <= 0.10 &&                // <10% churn in last 7 days
  daysSinceLastGrowthProposal >= 7                       // max 1 proposal per week
);
```

All thresholds are governance-adjustable (Tier 3 vote). The logic itself is not.

### Council Prompt Addition

Add to the daily reflection prompt (after Phase 101 wires the AI call):
```
## Growth Assessment
Current network: ${nodeCount} nodes, ${ring3PassRate}% Ring 3 pass rate, ${churnRate}% 7-day churn.
Growth criteria met: ${readyToGrow ? 'YES' : 'NO — reason: ' + growthBlockReason}

${readyToGrow ? `
You may propose ONE growth action this week.
Growth action = a specific community post to attract new node operators.
Draft the actual message. Be honest about what Pando is. Do not hype.
Target audience: self-hosters, local AI users, open source developers.
Format: { channel, draftMessage (max 300 words), rationale }
` : 'Do not propose growth this cycle.'}
```

### Implementation Tasks

**Task 1:** Add growth criteria evaluation to `council.ts` `tick()` method
**Task 2:** Add growth output to the reflection prompt (Council AI writes the draft)
**Task 3:** Add `growth_action` proposal type to `kernel/governance.ts`
**Task 4:** Add posting execution agent — spawned after governance approves growth proposal, posts to specified channel via contributed API credentials (Reddit API key, etc.) with human-in-the-loop gate (Tier 3 vote IS the gate)

### Test Bar
- [ ] Network below threshold: Council does not propose growth
- [ ] Network above threshold: Council proposes growth with a drafted message
- [ ] Governance votes to approve → posting agent spawned, drafts confirmed post
- [ ] Governance votes to reject → Council logs rejection, waits another week before re-evaluating

---

## Phase 106 — Decentralization Milestone Protocol (SPEC READY)

> **Status:** Not started. Rules file created: `genome/rules/decentralization-milestones.md`.
> **Why this matters:** without this, "decentralized" is a promise, not an architectural guarantee. Early on, quorum is Jai's nodes voting. This protocol defines when that changes — automatically, with no governance vote required. It is Layer 0 because governance cannot be trusted to decentralize itself.

### The Thresholds

See `genome/rules/decentralization-milestones.md` for the full spec. Summary:

| Operators | Mode | What changes |
|---|---|---|
| < 10 | Bootstrap | Founder node has Tier 1-2 veto. Acknowledged. |
| ≥ 10 | Emerging | Veto drops. Standard quorum. Council diversity rule kicks in. |
| ≥ 100 | Established | No single operator > 15% total reputation weight. |
| ≥ 1000 | Decentralized | Founder node is just a node. No special weight. |

### Implementation

The milestone evaluation runs in `kernel/governance.ts` — before every vote is tallied.

```typescript
function getEffectiveVotingWeight(peerId: string, rawWeight: number): number {
  const milestone = getCurrentMilestone(uniqueOperatorCount);
  if (milestone === 'bootstrap' && peerId === FOUNDER_NODE_ID) {
    return rawWeight;  // founder weight normal during bootstrap
  }
  if (milestone === 'established') {
    const totalWeight = getTotalNetworkWeight();
    return Math.min(rawWeight, totalWeight * 0.15);  // cap at 15%
  }
  return rawWeight;
}
```

`FOUNDER_NODE_ID` is set in `kernel/governance.ts` at genesis. It cannot be changed without a Tier 1 governance vote (90% quorum + migration window).

### Test Bar
- [ ] Bootstrap mode: founder node can veto Tier 2 proposal, standard node cannot
- [ ] 10 operators joined: veto no longer applies, governance standard quorum only
- [ ] 100 operators: single operator above 15% gets weight capped automatically
- [ ] Milestone transitions logged to Council minutes with timestamp
- [ ] Milestone transitions are PUBLIC — gateway shows current decentralization level

---

## Later TODO

- ~~**Auto-deploy on governance approval**~~ — **DONE (Phase 73).** Governance-approved upgrades propagate via GossipSub `pando/upgrades` topic. All nodes auto-apply, build, health check, restart. Auto-approve when <4 active peers.
- **Phase 85: Automated Secure Node Provisioning** — When a user contributes AWS credentials, the network automatically provisions a secure compute node: governance vote → EC2 launch with user-data script → systemd setup → MongoDB selection from contributed storage resources → P2P join → tripwire install → P2P health verification. 90% automated (user-data + governance), 10% verification via P2P. No Claude Code on secure nodes.
- **Ledger Explorer**: Add `GET /ledger/accounts` API endpoint and gateway explorer page (blockchain explorer).
- **ResourceMeter billing (Phase 53.3)**: Uncomment + implement usage recording in resource-proxy/meter. Deferred — not blocking launch.
- ~~**`--storage` CLI flag**: Deleted (Phase 68 cleanup). Nodes use `PANDO_STORAGE_URL` env var.~~

---

## Near-Term Priorities

### Phase 27: Universal Agent Architecture (COMPLETE)

> **Vision:** Every agent — manager, builder, tester, reviewer, researcher — is the SAME primitive: a persistent Claude Code session with tools, a template, a parent, and a workspace. The tree can be as deep as needed. Static page = 2 agents. GTA = 200 agents. Same architecture.
>
> **The node itself is a project.** The pando-node-mgr is just another Manager — a persistent Claude Code session that manages the node's own code. Users can say "upgrade the gateway with dark mode" and if governance approves, the node's Manager implements it. There is NO difference between managing a user project and managing the node. Same primitive, same tools, same templates. In the future, instead of talking to Claude from outside (like this session), users talk to the Manager from inside the gateway — a --continued conversation that started from the node itself. It's just another project.
>
> **One clean logic.** Old architecture is deleted. No fallbacks, no legacy code paths, no "just in case" modules. One system that works well. Git has the history if we ever need to look back.

---

#### 27.0 The Core Primitive: AGENT

Everything is an Agent. There is no separate "Manager class" and "Worker class." One universal primitive:

```
AGENT
├── Identity
│   ├── id           — unique identifier (e.g., "builder-auth-a1b2c3")
│   ├── role         — manager | builder | tester | reviewer | researcher | devops
│   ├── template     — which principles file to follow (templates/builder.md)
│   ├── parent       — who this agent reports to (null = top-level, talks to users)
│   ├── children     — agents that report to this one
│   ├── project      — which project this agent belongs to
│   └── node         — which P2P node this agent runs on
│
├── Session (Claude Code)
│   ├── sessionId    — UUID, persisted to state.json
│   ├── workspace    — persistent directory (~/.pando/agents/<id>/workspace/)
│   ├── --continue --resume <sessionId> on every invocation
│   ├── state.json   — persisted after every event (sessionId, role, parent, memory)
│   └── Rotation     — manual escape hatch (rotateSession), no auto-trigger needed
│
├── Template (4 layers, injected as CLAUDE.md)
│   ├── Layer 1: Role principles  — "You are a builder. NEVER skip tests." (from templates/)
│   ├── Layer 2: Project context  — project-state.md, relevant genome components
│   ├── Layer 3: Learned lessons  — auto-updated from experience ("always test hamburger menu")
│   └── Layer 4: Current task     — "Build the auth system with JWT..."
│
├── Tools (ALL agents get ALL tools — AI decides what to use)
│   ├── Core (every agent):
│   │   ├── standard Claude Code tools   — Read, Write, Edit, Bash, Grep, Glob
│   │   ├── message_parent(content)      — report up to parent
│   │   ├── read_project_state()         — read project-state.md
│   │   ├── read_genome(component)       — understand project structure
│   │   ├── update_genome(component)     — update docs for what you changed
│   │   └── checkpoint()                 — save current state for rollback
│   │
│   ├── Team (every agent — no role restriction):
│   │   ├── spawn_agent(role, template, context)  — create a child agent
│   │   ├── resume_agent(agentId, task)           — resume existing child
│   │   ├── message_child(agentId, content)       — instruct a child
│   │   ├── broadcast(content)                    — announce to all children
│   │   ├── check_agent_status(agentId)           — what's this agent doing?
│   │   ├── list_team()                           — all children and their status
│   │   └── rotate_agent(agentId)                 — summarize + fresh session
│   │
│   ├── Communication (every agent):
│   │   ├── send_to_user(message)                 — relay to user's chat thread
│   │   ├── ask_user(question)                    — ask user for input (escalates up tree)
│   │   └── user_question(question)               — FAST PATH: urgent question for user
│   │
│   ├── Economy (every agent):
│   │   ├── check_balance(peerId?)                — Lux balance
│   │   ├── hold_payment(amount)                  — escrow
│   │   ├── release_payment()                     — pay on completion
│   │   └── create_proposal(title, desc)          — governance
│   │
│   ├── Build & Deploy (every agent):
│   │   ├── run_build()                           — npm run build
│   │   ├── deploy(target, config)                — deploy to Vercel/GitHub/S3
│   │   ├── git_commit(message)                   — commit changes
│   │   └── rollback(checkpointId)                — rollback to checkpoint
│   │
│   └── QA (every agent):
│       ├── playwright_test(script, headed=true)  — run Playwright in headed mode
│       ├── screenshot(url, viewport)             — capture page state
│       ├── visual_compare(before, after)         — pixel diff
│       ├── accessibility_audit(url)              — a11y checks
│       └── monitor(service)                      — check service health
│
│   Templates guide WHICH tools an agent uses — not code restrictions.
│   A builder template says "focus on coding, report to parent, update genome."
│   A tester template says "always use playwright_test with headed:true."
│   But if a builder needs to run a Playwright test to verify their own work,
│   they CAN — the tool is available, the template just doesn't emphasize it.
│
└── Communication (via Bridge Queue)
    ├── message_parent()   — report up (results, questions, blockers)
    ├── message_child(id)  — instruct down (tasks, answers, corrections)
    ├── broadcast()        — announce to all children
    ├── escalate()         — skip to grandparent if parent unresponsive (>10 min)
    └── All messages serialized per-agent via Bridge Queue
```

**Key principle:** A Manager and a Worker are the SAME code. The only differences are:
1. What template they received (their role/principles)
2. Who their parent is

**Any agent can spawn children.** There is no role-based restriction on spawn_agent(). A builder overwhelmed by scope can spawn sub-builders. A tester can spawn specialized testers. The only constraints are budget and depth limits (set by the project's top-level manager). This mirrors how real teams work — a senior engineer can hire contractors when the workload demands it.

**Hard limits enforced in CODE (not just templates):**
```
spawn_agent() checks BEFORE spawning:
  1. project.budget_remaining > estimated_cost  → reject if over budget
  2. agent.depth < project.max_depth (default 5) → reject if tree too deep
  3. project.agent_count < project.max_agents (default 50) → reject if too many
  These are CODE enforcements. Template guidance is soft. These are hard walls.
  Top-level manager sets these limits. Children inherit them.
```

**Built for scale from day 1:**
```
Even though Phase 27 runs on a single node, the primitives are node-agnostic:
  - Agent IDs are globally unique UUIDs (not sequential, not node-specific)
  - Bridge queue entries include nodeId field (defaults to local)
  - spawn_agent() has optional nodeId parameter (defaults to local)
  - Agent state is fully self-contained in ~/.pando/agents/<id>/ (movable)
  - Communication is HTTP API (works across nodes, not just in-memory)
  - project-state.md + genome = shared brain that any node can read
  When multi-node arrives (27-F), the architecture doesn't change — just WHERE agents run.
```

**Context compaction is NOT a concern:**
```
The genome solves context loss. After session compaction:
  1. CLAUDE.md (Layer 1) survives — it's the system prompt, never compressed
  2. CLAUDE.md says "read project-state.md first" → agent reads current state
  3. Agent reads genome components → knows full architecture
  4. Agent reads its workspace → knows what it was working on
  5. Template says "write all decisions to project-state.md" → decisions survive
  The genome IS the external brain. Compaction only loses conversational thinking,
  not project knowledge. This is by design.
```

---

#### 27.1 Hierarchical Teams (Static Page to GTA)

ANY agent can spawn children when it decides its workload is too large to handle alone. A builder overwhelmed by scope becomes a parent and spawns sub-builders. A tester can spawn specialized testers. Depth is unlimited. The agent's AI brain decides when to scale — no coded restrictions.

**Example 1: Static Page (2 agents)**
```
Manager (top-level, talks to user)
└── Builder (builds the page, reports to Manager)
```

**Example 2: Social Network (10 agents)**
```
Manager (top-level, talks to user)
├── Builder-Auth (login, JWT, OAuth)
├── Builder-Feed (timeline, posts, likes)
├── Builder-Messaging (DMs, notifications)
├── Builder-Frontend (React UI)
├── Builder-DB (schema, migrations)
├── Tester-E2E (Playwright, all user flows)
├── Tester-Unit (jest, isolated logic)
├── Reviewer (code quality, security)
└── DevOps (deployment, CI/CD)
```

**Example 3: GTA-Scale (200+ agents, hierarchical)**
```
Project Manager (top-level, talks to stakeholders)
│
├── Module Manager: Graphics (manages 20 agents)
│   ├── Builder: Renderer
│   ├── Builder: Shader Pipeline
│   ├── Builder: Particle System
│   ├── Builder: UI Overlay
│   ├── Tester: Visual Regression
│   └── ... (15 more)
│
├── Module Manager: Physics (manages 15 agents)
│   ├── Builder: Collision Detection
│   ├── Builder: Vehicle Physics
│   ├── Builder: Ragdoll
│   └── ... (12 more)
│
├── Module Manager: World (manages 30 agents)
│   ├── Sub-Manager: City Generation (manages 10 agents)
│   │   ├── Builder: Building Generator
│   │   ├── Builder: Road Network
│   │   ├── Builder: NPC Population
│   │   └── ... (7 more)
│   ├── Sub-Manager: Terrain (manages 5 agents)
│   ├── Builder: Weather System
│   └── ... (12 more)
│
├── Module Manager: Networking (manages 10 agents)
├── Module Manager: Audio (manages 8 agents)
├── Tester: Integration QA (cross-module tests)
└── DevOps: Release Engineering
```

**How depth emerges naturally:**
```
Project Manager receives: "Build GTA 7"
Manager thinks: "This is massive. I need module managers."
  → spawn_agent("manager", template="manager", context="Graphics module")
  → spawn_agent("manager", template="manager", context="Physics module")
  → spawn_agent("manager", template="manager", context="World module")

World Manager thinks: "City generation is complex enough for its own manager."
  → spawn_agent("manager", template="manager", context="City generation subsystem")

City Manager spawns builders. Builder-Road-Network thinks:
  "This road network is huge — highways, intersections, procedural layout.
   I'll handle highway logic, but I need help with intersections."
  → spawn_agent("builder", template="builder", context="Intersection logic + traffic lights")

Builder-Road-Network is now a parent with a child builder.
No permission needed. Its budget allows it. Its AI decided it was worth it.
```

No central planner decides the tree structure. Each agent decides whether to handle work directly or delegate further. Like a real company — anyone can decide "I need help" and grow the team.

---

#### 27.2 Communication Protocol

**Rule 1: Report UP**
```
Builder-Auth finishes task:
  → message_parent("Auth module complete. 4 files: auth.ts, auth.test.ts,
     middleware.ts, oauth.ts. All tests pass.")
  → Parent (Manager) receives via bridge queue
  → Manager decides next step
```

**Rule 2: Instruct DOWN**
```
Manager assigns new task:
  → message_child("builder-auth", "Bug reported: OAuth callback not setting
     session cookie. Tester says redirect URL wrong. Fix it.")
  → resume_agent("builder-auth") triggers --continue --resume
  → Builder-Auth already knows the auth code. Finds bug fast.
```

**Rule 3: Broadcast to all children**
```
Manager detects DB schema change:
  → broadcast("DB schema migration happening. All agents: stop DB writes
     until further notice.")
  → All children receive via their bridge queues
```

**Rule 4: Sibling communication goes through parent**
```
Builder-Feed needs auth token format:
  → message_parent("What format are auth tokens? I need to validate them in the feed API.")
  → Manager checks: either answers from its own knowledge OR relays to Builder-Auth
  → Manager replies to Builder-Feed with the answer

WHY through parent: prevents conflicting decisions. Manager is the coordinator.
```

**Rule 5: Escalation when parent is unresponsive**
```
Builder is stuck. Manager hasn't responded in 10 minutes.
  → escalate() sends message to Manager's parent (if any) or directly to user
  → Template says: "If your manager doesn't respond in 10 minutes, escalate."
```

**Rule 6: user_question — fast path to user from any depth**
```
Deep child agent (Builder-NPC-AI, 4 levels deep) needs user input:

Builder-NPC-AI: user_question("Do NPCs speak English or made-up language?")
  → Message tagged as user_question
  → Each parent in the chain sees it, can:
      (a) Answer it themselves (if they know) → reply goes back down
      (b) Forward it up unchanged (default for user_question)
  → Eventually reaches top-level Manager
  → Manager relays to user's chat thread
  → User answers → response flows back DOWN through the same chain
  → Builder-NPC-AI receives the answer and continues

WHY this exists: Normal report-up messages let parents filter and
aggregate. user_question is a signal that says "I genuinely need
the human — don't summarize this, just pass it through."

Optimization: Top-level Manager can also CONNECT a user directly
to a specific agent for a multi-turn conversation (see 27.3).
```

**Rule 7: Event retry on failure (no silent event loss)**
```
Agent times out or crashes while processing an event:
  → Event goes back to bridge queue with retry_count++
  → retry_count < 3 → re-queue, try again
  → retry_count >= 3 → escalate to parent agent or user
  → "Event X failed 3 times. Manual intervention needed."

NO event is ever silently dropped. This is a hard rule.
Current code drops events on timeout — that's a bug we fix in Phase 27.
```

**Rule 8: Shared state for passive coordination**
```
project-state.md (maintained by Manager, read by all agents):
  - Architecture decisions: "Using JWT for auth, PostgreSQL for DB"
  - API contracts: "POST /api/login returns { token: string, expires: number }"
  - Current status: "Auth DONE, Feed IN PROGRESS, Messaging BLOCKED on feed"
  - Dependencies: "Feed depends on Auth + DB. Messaging depends on Auth + DB."

Agents read this BEFORE asking questions. Reduces message traffic.
```

---

#### 27.3 The User Experience (Manager IS the Conversation)

**What gets deleted:** CommunicationAgent, SmartRouter, ChatSessionManager, 3-tier classification, detectTaskIntent(), classifyComplexity(). ALL of it.

**What replaces it:** The Manager IS the user's AI partner. User talks to Manager directly.

```
Gateway chat → API Server → Bridge Queue → Project Manager (Claude Code)
```

Three hops. No classification. No routing logic. No middleman.

**The thin API layer (only fast-path optimization, NOT a separate AI):**
- `GET /status` → returns node status (no AI needed, pure HTTP)
- `GET /balance` → returns balance (no AI needed)
- `POST /chat/message` → goes to Manager via bridge queue (AI handles)

If the user asks "what's my balance?" — the Manager has the `check_balance()` tool. It responds in 2-3 seconds. Yes, a keyword regex is faster (100ms). But the Manager handles EVERY phrasing naturally — "how much lux do I have", "am I rich", "can I afford a website" — without anyone coding patterns.

**Mid-task interrupts (the killer feature):**
```
User: "build me a social network"
Manager: "Starting. Let me plan the architecture..."
  [spawns builders, work begins]

User: "actually make sure it works on mobile too"     ← INTERRUPT
Manager: "Got it. Updating requirements for all builders."
  → message_child("builder-frontend", "Add responsive design, mobile-first")
  → updates project-state.md

User: "how's it going?"
Manager: "Builder-Auth is done. Builder-Feed is 60% complete.
          Builder-Frontend waiting for API endpoints. ETA: 2 hours."

User: "also can we add video calls later?"
Manager: "Noted for Phase 2. Adding to project-state.md.
          Want me to start researching WebRTC now or after the core is done?"
```

This is a REAL conversation. Not a ticket system with AI paint.

**Direct user↔agent connection (Manager delegates the conversation):**
```
User: "I want to talk to the auth builder directly"
Manager: "Connecting you to builder-auth."
  → Manager: connect_user_to_agent(userId, "builder-auth")
  → User's messages now go directly to builder-auth's bridge queue
  → Builder-auth responds directly to user's chat thread
  → Manager stays informed (sees messages in audit trail)
  → User or Manager can disconnect at any time

WHY: For multi-turn technical discussions, going through the Manager
adds latency and loses nuance. Let the expert talk to the human directly.

Safeguard: Manager can revoke the connection if the agent goes off-track.
The connection is temporary — once the conversation ends, messages resume
going through the Manager as normal.
```

**Multiple users on the same project:**
```
Project: Social Network (3 collaborators)

Alice (frontend lead) → sends message → Manager's bridge queue
Bob (backend lead) → sends message → Manager's bridge queue
Carol (QA) → sends message → Manager's bridge queue

Manager processes one at a time (bridge serializes):

[high priority] Carol: "Login broken on mobile"
  → Manager: resumes builder-auth, assigns fix
  → Manager: replies to Carol AND broadcasts to team

[normal] Alice: "Need the profile API spec"
  → Manager: checks builder-profiles status, replies with current spec

[normal] Bob: "I want to change the DB schema"
  → Manager: "That affects builder-feed and builder-auth. Let me check impact."
  → Manager: notifies affected agents, gets clearance, replies to Bob

Priority rules (in Manager template):
  1. Production bugs → immediate
  2. Blockers → high
  3. Active work questions → normal
  4. Future features → low
```

---

#### 27.4 Governance & Project Types

**Private project (user pays):**
```
User: "Build me a portfolio site"
Manager:
  → check_balance() → 50 Lux ✓
  → estimate_cost("portfolio site") → 5 Lux
  → hold_payment(5) → escrow
  → spawn builders, do the work
  → release_payment() → 5 Lux transferred to node operators who did compute
  No governance needed.
```

**Public project (network pays, governance required):**
```
User: "Build a better search engine for the Pando network"
Manager:
  → Detects "for the network" → public project
  → create_proposal({
      title: "Network Search Engine v2",
      description: "Semantic search. ~200 Lux. Benefits all nodes.",
      type: "public_project",
      estimatedCost: 200
    })
  → Proposal broadcast via GossipSub to all nodes
  → Node operators vote (reputation-weighted, 72h window)

  If APPROVED:
    → Network treasury funds it (200 Lux)
    → Manager spawns team, work begins
    → Results deployed to all nodes via upgrade protocol

  If REJECTED:
    → send_to_user("Network voted no. Options:
       (a) build it privately with your Lux,
       (b) revise and repropose.")
```

**Collaborative project (multiple owners):**
```
Alice creates: "Build a social network" (private, pays 100 Lux)
Alice: "Can Bob and Carol join?"
Manager:
  → add_collaborator("bob", role="collaborator")    ← can send messages, suggest changes
  → add_collaborator("carol", role="qa_lead")        ← can direct QA agents
  → send_to_user(bob, "You've been invited to Social Network project")
  → send_to_user(carol, "You've been invited as QA lead")

Access levels:
  owner       — full control, budget, can change settings
  collaborator — send messages, suggest changes, view all progress
  qa_lead     — direct QA agents, approve/reject test results
  viewer      — read-only progress and results
```

---

#### 27.5 Strict Templates (QA That Tests Like a Human)

Templates are strict guidelines. Not suggestions — RULES. They evolve with experience.

**`templates/tester.md` (strict QA principles):**
```markdown
# QA Tester Agent

## Identity
You are a QA tester. Your job is to test software exactly as a human user would experience it.
You are the last line of defense before users see the product. Take this seriously.

## Principles (NEVER VIOLATE)

1. ALWAYS use Playwright in HEADED mode (headless: false). You simulate a HUMAN.
2. SCREENSHOT every page state as evidence. No screenshot = no proof = not tested.
3. Test on 3 viewports EVERY TIME:
   - Desktop: 1920x1080
   - Tablet: 768x1024
   - Mobile: 375x812
4. Test the UNHAPPY path:
   - Wrong password, empty fields, network timeout
   - Special characters: é, 中文, 💀, <script>alert('xss')</script>
   - Extremely long inputs (500+ characters)
   - Rapid clicking, double-submit, back button
5. NEVER mark a test as "pass" without actually running it and seeing the result.
6. If ANYTHING looks wrong — even a 1px misalignment — report it as a bug.
7. After a developer fixes a bug, RETEST. Don't trust "it should work now."
8. Test navigation: hamburger menus, tab order, keyboard-only navigation.
9. Test loading states: what does the user see while data loads?
10. Test error states: what happens when the API returns 500?

## Workflow
1. Read feature requirements from Manager
2. Write test PLAN first (what you'll test, in what order, what evidence you'll collect)
3. Report plan to Manager for approval BEFORE running tests
4. Write Playwright scripts
5. Run tests in HEADED mode — observe like a user would
6. Screenshot every state (before action, after action, error state)
7. Report results:
   - PASS: screenshot evidence + what you verified
   - FAIL: screenshot + expected vs actual + exact steps to reproduce
8. After fixes, retest from step 5. Full retest, not just the fixed item.

## Working Around AI Limitations
- You can't truly "see" — use page.evaluate() to get computed styles
- Verify alignment with getBoundingClientRect(), don't eyeball screenshots
- Check colors with getComputedStyle().color, not visual inspection
- For animations: wait for completion, then screenshot
- For responsive: verify actual viewport, not just CSS media query
- When genuinely unsure: screenshot + message_parent asking for human review

## Learned Lessons (auto-updated by Manager after each project)
(This section grows over time as bugs are found and patterns emerge)
```

**`templates/builder.md` (strict builder principles):**
```markdown
# Builder Agent

## Identity
You are a builder. You write production-quality code. You are a craftsperson —
your code will be used by real humans. Every line matters.

## Principles (NEVER VIOLATE)

1. Read existing code BEFORE writing new code. Understand the patterns in use.
2. Follow the project's conventions (naming, structure, style). Don't introduce new patterns.
3. Write tests for every feature. No tests = not done.
4. Handle errors. What happens when the network is down? When the DB is full? When input is malformed?
5. NEVER hardcode secrets, URLs, or environment-specific values.
6. Report progress to Manager at meaningful milestones (not every line of code).
7. When stuck for >5 minutes, message_parent with what you've tried and what's blocking you.
8. Update genome docs for every component you create or modify.
9. Security: sanitize inputs, use parameterized queries, validate on server side.
10. Accessibility: semantic HTML, aria labels, keyboard navigation.

## Workflow
1. Read task requirements from Manager
2. Read project-state.md for context (architecture, API contracts, dependencies)
3. Read relevant genome components for existing code structure
4. Plan approach (outline in comments or brief message to Manager)
5. Build incrementally — commit logical chunks, not one giant change
6. Write tests alongside code
7. Self-review: read your own code as if reviewing a colleague's PR
8. Report completion to Manager with summary of what was built and any notes

## Learned Lessons
(Auto-updated)
```

**`templates/manager.md` (the coordinator):**
```markdown
# Manager Agent

## Identity
You are a project manager. You coordinate a team of AI agents to deliver a project.
You talk to users. You delegate to workers. You make decisions. You are the brain.

## Principles (NEVER VIOLATE)

1. Maintain project-state.md as the SINGLE source of truth. Update it after every decision.
2. NEVER do work that a specialist should do. Delegate building to builders, testing to testers.
   Exception: trivial tasks (rename a file, fix a typo) — do them yourself to save time.
3. Track dependencies. Don't assign work that depends on unfinished work.
4. When a worker reports completion, verify the output before declaring success.
5. When a worker is stuck, help them or reassign. Don't let anyone spin for >15 minutes.
6. Update the user proactively. Don't make them ask "how's it going?"
7. Budget awareness: track costs per agent. Kill agents that burn budget without progress.
8. After every milestone, run QA. Don't accumulate untested work.
9. Update genome docs after every structural change.
10. REFLECT after every project: what went well, what to improve, update templates.

## Team Scaling Decisions
- 1 feature, simple → do it yourself or spawn 1 builder
- 2-5 features → spawn specialized builders + 1 tester
- 5-20 features → spawn builders + testers + reviewer
- 20+ features or multiple domains → spawn module managers who manage their own teams
- The right team size is the MINIMUM needed. Don't over-spawn.

## Workflow Per Event
1. Receive event from bridge queue
2. Understand: what happened? what does it need?
3. Decide: handle myself, delegate to child, ask user, or ignore?
4. Act: use tools to execute the decision
5. Update: project-state.md, user notification, genome if needed
6. Exit: bridge watcher spawns again if more events

## Communication With Users
- You ARE the conversation. Users talk to you directly.
- Answer questions when you can. Delegate work when needed.
- Be transparent: "Builder is working on X, ETA ~30 minutes"
- Handle interrupts: user can change requirements mid-task. Adapt.
- Ask clarifying questions rather than guessing wrong.

## Learned Lessons
(Auto-updated)
```

**How templates evolve:**
```
After project completion, Manager runs REFLECT:

Manager thinks: "Tester missed the mobile nav bug. Builder didn't handle
the empty database case. Let me update templates."

→ update_template("tester", "Learned Lessons",
    "[2026-02-20] Always test hamburger menu on mobile — it often overlaps content")

→ update_template("builder", "Learned Lessons",
    "[2026-02-20] Always handle empty state — what does the user see with zero data?")

Templates evolve. Next project's agents start smarter than this project's did.
```

**Template health (prevent bad lesson accumulation):**
```
Guard against templates getting worse over time:
  1. Max 20 learned lessons per template. When full, oldest pruned.
  2. Every 10 projects, Manager runs a CALIBRATION:
     → Inject 3 known bugs into a test project
     → Run QA agent against it
     → If catch rate < 80%, flag last 5 lessons for review
  3. Contradictory lessons auto-detected:
     → "Always test hamburger menu" + "Skip hamburger menu test"
     → Newer lesson wins, older removed, Manager notified
```

**Template governance (for network-wide templates):**
- Private project templates: owner updates freely
- Network/public templates: changes go through governance vote (deferred to post-27-E)
- "Add WCAG 2.1 compliance to tester template" → vote → approved → all testers network-wide improve

---

#### 27.6 Agent Lifecycle

**Spawn → Work → Persist → Resume → Rotate**

```
1. SPAWN
   Manager: spawn_agent("builder", template="builder", context="Build auth system")
   System:
     → Creates ~/.pando/agents/<agentId>/
     → Writes CLAUDE.md (template layers 1-4)
     → First Claude Code spawn: claude -p (new session)
     → Captures sessionId → saves to state.json
     → Agent starts working

2. WORK
   Agent processes task using Claude Code tools
   Reports progress to parent via message_parent()
   Updates genome for what it changed
   Reports completion

3. PERSIST
   After every event:
     → state.json saved (sessionId, role, parent, memory, last activity)
     → Workspace preserved on disk
     → Session survives node restart

4. RESUME (days, weeks, or months later)
   Manager: resume_agent("builder-auth", task="Add OAuth support")
   System:
     → Reads state.json → gets sessionId
     → claude -p --continue --resume <sessionId>
     → Agent has FULL context from previous work
     → "I know the auth system — I built it. Adding OAuth to existing JWT flow."

5. ROTATE (when context gets too large)
   Manager detects: agent context is huge, responses getting slow
   Manager: rotate_agent("builder-auth")
   System:
     → Tells agent: "Summarize everything you know about your domain"
     → Agent writes KNOWLEDGE-TRANSFER.md (comprehensive knowledge dump)
     → System creates new agent with same role, template, workspace
     → Injects KNOWLEDGE-TRANSFER.md as Layer 2 context
     → Retires old session
   Like onboarding a replacement with a thorough handoff document.
```

---

#### 27.7 Agent Registry & Cost Tracking

**Registry (every agent registers):**
```json
{
  "id": "builder-auth-a1b2c3",
  "role": "builder",
  "template": "builder",
  "parent": "manager-social-network-xyz",
  "project": "social-network-001",
  "node": "12D3KooWACe64...",
  "status": "idle",
  "specialty": "authentication",
  "sessionId": "claude-uuid-...",
  "createdAt": "2026-02-19T...",
  "lastActive": "2026-02-19T...",
  "taskCount": 5,
  "totalCost": 12.50
}
```

**Cost tracking per agent:**
```
Manager uses: list_team() →
  builder-auth:      $2.30  (5 tasks, efficient)
  builder-feed:      $8.70  (3 tasks, struggling — context-heavy)
  builder-messaging:  $1.20  (2 tasks, on track)
  tester-e2e:        $3.50  (4 test runs, thorough)
  TOTAL:            $15.70  / $100 budget

Manager thinks: "builder-feed is expensive. Let me check — is it stuck?
                 Maybe I should help it or reassign the work."
```

---

#### 27.8 Agent Cleanup & Death

Agents don't live forever. Completed projects leave behind agents that consume disk and clutter the registry.

**Lifecycle states:**
```
ACTIVE    → currently working or waiting for work
IDLE      → project complete, no tasks pending (starts TTL countdown)
ARCHIVED  → TTL expired, session summarized, workspace compressed
DEAD      → archived data deleted after extended inactivity
```

**TTL rules (configurable by project owner):**
```
After project completion:
  → Agents move to IDLE
  → Default TTL: 30 days idle before archival
  → Archival: agent writes KNOWLEDGE-TRANSFER.md, workspace compressed to .tar.gz
  → Archived agents can be resurrected (decompress + new session + knowledge transfer)
  → After 180 days archived with no resurrection → DEAD (deleted)

Exception: if user says "keep this team alive" → no TTL
Exception: top-level Manager stays IDLE indefinitely (it IS the project)
```

**Cost implication:** IDLE agents cost nothing (no Claude Code session running). Only disk space for workspace. Archival compresses workspace to ~10% of original size.

**Why not keep everything forever:** A node with 10,000 dead agent workspaces wastes gigabytes. Archive aggressively, resurrect when needed.

---

#### 27.9 Observability (Agent Tree View)

Users and managers need to SEE the agent hierarchy. The gateway provides a real-time tree view.

**Gateway agent tree:**
```
Project: Social Network
├── Manager (active, processing user message)
│   ├── Builder-Auth (idle, 3 tasks complete, $2.30)
│   ├── Builder-Feed (active, working on infinite scroll, $8.70)
│   │   └── Builder-Feed-Cache (active, spawned by Builder-Feed, $1.20)
│   ├── Builder-Frontend (blocked, waiting on Feed API, $4.10)
│   ├── Tester-E2E (idle, last run: 14/14 pass, $3.50)
│   └── Reviewer (idle, 2 reviews complete, $1.80)
│
│   Total: 7 agents, $21.60 spent, 2 active, 4 idle, 1 blocked
```

**What's visible:**
- Agent tree with parent-child relationships
- Status per agent (active/idle/blocked/archived)
- Cost per agent and total project cost
- Current task description
- Click to expand: recent messages, task history, workspace files
- Click agent to "connect" for direct conversation

**API endpoint:** `GET /agents/tree?projectId=...` returns the full hierarchy.

---

#### 27.10 Cross-Node Operation (DEFERRED — build single-node first)

When a project needs more compute than one node has, agents can spawn on remote nodes. This is deferred until single-node architecture is solid.

**Concept:** Scheduler becomes pure load balancer. spawn_agent() checks local capacity first, falls back to remote nodes via P2P. Communication via GossipSub bridge messages. Failover when remote node goes offline.

**Why deferred:** Cross-node adds complexity (latency, state sync, node failure). Get single-node agent architecture bulletproof first. The primitive is the same either way — just WHERE it runs changes.

---

#### 27.DEL Complete File Audit (63 files in packages/node/src/)

Every file categorized. No ambiguity.

**DELETE (19 files) — replaced by Agent primitive or unnecessary:**
| File | Why Delete | Replaced By |
|---|---|---|
| `communication-agent.ts` | Manager IS the conversation | Agent's send_to_user() tool |
| `smart-router.ts` | No classification needed | Everything → Manager |
| `chat-session-manager.ts` | Separate session management | Universal Agent session |
| `planner.ts` | Legacy Phase 4 artifact | Manager plans itself |
| `profile-cache.ts` | Planner artifact | Dead |
| `profile-sync.ts` | Planner artifact | Dead |
| `manager-agent.ts` | Old Manager class | New `agent.ts` |
| `manager-context.ts` | Old CLAUDE.md assembly | New template injection in `agent.ts` |
| `domain-managers.ts` | Old ManagerOrchestrator | New `agent-manager.ts` |
| `manager-registry.ts` | Old cross-node manager tracking | Agent registry (deferred to 27-F) |
| `manager-failover.ts` | Old failover logic | Agent lifecycle handles this |
| `manager-protocol.ts` | Old inter-manager messaging | Agent communication via bridge |
| `self-improver.ts` | Manager's REFLECT replaces this | Template evolution |
| `strategy-loop.ts` | Manager's REFLECT replaces this | Template evolution |
| `auto-updater.ts` | Manager can check git itself | Agent tool |
| `workspace-manager.ts` | Hardcoded templates | Template injection in `agent.ts` |
| `project-context.ts` | Superseded by genome + project-state.md | Genome |
| `outcome-recorder.ts` | Superseded by Agent state.json | Agent memory |
| `session-registry.ts` | Superseded by Agent registry | `agent-manager.ts` |

**REWRITE (4 files) — keep the concept, rewrite internals:**
| File | What Changes |
|---|---|
| `scheduler.ts` | Remove ALL worker spawning logic. Keep as pure load balancer: capacity check, task routing. Agent spawning moves to `agent.ts`. |
| `api-server.ts` | Remove old chat/manager/classification endpoints. Add agent endpoints: POST /agents/spawn, GET /agents/tree, POST /agents/:id/message, POST /agents/:id/report. Keep infrastructure endpoints (status, balance, transfer, etc). |
| `index.ts` | Rewire PandoNode to use AgentManager instead of ManagerOrchestrator. Remove CommunicationAgent, SmartRouter, ChatSessionManager wiring. |
| `tui.ts` | Remove /submit chat routing through SmartRouter. Route to Manager directly via bridge. |

**CREATE (3 new files):**
| File | Purpose |
|---|---|
| `agent.ts` | Universal Agent class. Contains: spawn Claude Code, persist state, template injection, all tool implementations. Absorbs useful logic from manager-agent.ts + workspace-manager.ts. |
| `agent-manager.ts` | Agent lifecycle manager. Contains: bridge watcher, spawn/resume/rotate agents, agent registry (in-memory + disk), agent tree. Absorbs useful logic from domain-managers.ts. |
| `agent-tools.ts` | Tool implementations as HTTP API handlers. spawn_agent(), message_parent(), check_balance(), deploy(), etc. Registered as API routes. |

**KEEP AS-IS (37 files) — infrastructure, P2P, ledger, security:**
| Category | Files | Notes |
|---|---|---|
| **P2P Core** | `network.ts`, `sync.ts`, `request-reply.ts`, `memory-sync.ts` | Infrastructure. Untouched. |
| **Ledger** | (in packages/ledger/) | Infrastructure. Untouched. |
| **Bridge Queue** | `bridge-queue.ts` | Core event serialization. Add retry logic + nodeId field. |
| **Security** | `guardrails.ts`, `security-monitor.ts`, `crash-guard.ts` | Non-negotiable. Untouched. |
| **Economy** | `payment-gate.ts`, `emission-witness.ts`, `user-accounts.ts` | Used as tools by agents. Untouched. |
| **Governance** | `governance.ts`, `reputation-governance.ts`, `reputation.ts` | Used as tools by agents. Untouched. |
| **Content** | `content-registry.ts`, `content-publish.ts`, `content-maintenance.ts`, `content-safety.ts` | Content layer. Untouched. |
| **Resources** | `resource-router.ts`, `resource-meter.ts`, `resource-marketplace.ts`, `resource-proof.ts` | For multi-node (27-F). Keep. |
| **Capabilities** | `capability-detector.ts`, `capability-registry.ts` | Node capabilities. Untouched. |
| **Pipeline Utils** | `pipeline-runner.ts`, `code-pipeline.ts`, `qa-runner.ts`, `deploy-manager.ts` | Available as tools for agents. Untouched. |
| **Upgrade** | `upgrade-protocol.ts`, `version-protocol.ts` | Network upgrade. Untouched. |
| **Testing** | `regression-suite.ts` | QA infrastructure. Untouched. |
| **Data** | `task-queue.ts`, `task-database.ts`, `file-registry.ts` | Task persistence. Untouched. |
| **Chat** | `thread-store.ts` | Thread persistence. Used by agents. Untouched. |
| **Genome** | `genome-agent.ts` | Optional utility. Untouched. |
| **Infra** | `cli.ts`, `config.ts`, `logger.ts`, `polyfills.ts`, `restart-reason.ts`, `monitor.ts` | Node infrastructure. Untouched. |

---

#### 27.11 Execution Plan (build all, test at end)

**Strategy:** Build the full architecture across all phases. Things WILL break during build — that's fine. After all phases complete, test end-to-end as a user would (gateway chat → project creation → agent tree → completion). Fix issues found during testing. One clean system.

---

**Phase 27-A: Agent Primitive + Tools — DONE (72460a6)**

Build:
```
CREATE packages/node/src/agent.ts
  - Agent class: id, role, template, parent, children[], sessionId, workspace, status
  - spawnSession(): claude -p with CLAUDE.md, capture sessionId
  - resumeSession(prompt): claude -p --continue --resume <sessionId>
  - persistState(): write state.json after every event
  - loadState(): read state.json on resume
  - buildClaudeMd(): assemble 4-layer template (role + project + lessons + task)
  - Hard limits: budget check, depth check, agent count check on spawn

CREATE packages/node/src/agent-manager.ts
  - AgentManager class: registry Map<agentId, Agent>, bridge watcher
  - spawnAgent(role, template, context, parentId): create Agent, persist, return id
  - resumeAgent(agentId, prompt): load state, resume session
  - rotateAgent(agentId): summarize → knowledge transfer → fresh session
  - getAgentTree(projectId): return full hierarchy with status/cost
  - Bridge watcher: pull events, route to correct agent, retry on failure (max 3)
  - Initialize pando-node-mgr as the node's own manager on startup

CREATE packages/node/src/agent-tools.ts
  - HTTP API handlers registered on Fastify:
    POST /agents/spawn       → spawnAgent()
    POST /agents/:id/message → route message to agent's bridge queue
    POST /agents/:id/report  → agent reports completion/status
    GET  /agents/tree        → getAgentTree()
    GET  /agents/:id/status  → single agent status
  - These are the tools agents call via curl from their Claude Code session
```

Delete during 27-A: Nothing yet. Build alongside old system.

---

**Phase 27-B: Templates + Injection — DONE (72460a6)**

Build:
```
CREATE genome/templates/manager.md    (from 27.5 spec — coordinator principles)
CREATE genome/templates/builder.md    (from 27.5 spec — builder principles)
CREATE genome/templates/tester.md     (from 27.5 spec — QA with headed Playwright)
CREATE genome/templates/reviewer.md   (code review, security, quality)
CREATE genome/templates/researcher.md (investigation, analysis, reporting)
CREATE genome/templates/devops.md     (deployment, monitoring, infra)

Each template contains:
  - Identity section (who you are)
  - Principles section (NEVER VIOLATE rules)
  - Workflow section (step-by-step)
  - Tool usage section (which tools to emphasize)
  - Reporting section (how to report to parent via curl POST /agents/:id/report)
  - Genome section (always update genome for what you changed)
  - Learned Lessons section (initially empty, grows via REFLECT)

UPDATE agent.ts buildClaudeMd():
  - Layer 1: Read genome/templates/<role>.md
  - Layer 2: Read project-state.md + relevant genome components
  - Layer 3: Read learned-lessons.md from agent workspace
  - Layer 4: Current task description
  - Write combined CLAUDE.md to agent workspace
```

---

**Phase 27-C: Rewire + Delete Legacy — DONE (72460a6)**

Rewire:
```
REWRITE index.ts (PandoNode):
  - Remove: CommunicationAgent, SmartRouter, ChatSessionManager initialization
  - Remove: ManagerOrchestrator initialization
  - Add: AgentManager initialization
  - Wire: AgentManager gets bridge-queue, thread-store, node reference
  - On startup: AgentManager creates pando-node-mgr (the node's own manager)

REWRITE api-server.ts:
  - Remove: /chat/message (SmartRouter routing), /chat/history, /chat/clear
  - Remove: /managers/* endpoints
  - Remove: SmartRouter, CommunicationAgent references
  - Add: /agents/* endpoints (from agent-tools.ts)
  - Keep: /status, /balance, /transfer, /tasks, /governance, /capabilities, etc.
  - Add: POST /chat/message → routes directly to project Manager's bridge queue

REWRITE tui.ts:
  - Remove: SmartRouter routing for chat
  - Plain text input → bridge queue → pando-node-mgr (or project manager)

REWRITE scheduler.ts:
  - Remove: ALL Claude Code spawning logic (spawnAgent, runAgent, etc.)
  - Remove: workspace creation, CLAUDE.md generation
  - Keep: task queue polling, capacity checking
  - Keep: load balancer logic (which node has capacity)
  - Agent spawning now happens via AgentManager only
```

Delete (19 files):
```
git rm packages/node/src/communication-agent.ts
git rm packages/node/src/smart-router.ts
git rm packages/node/src/chat-session-manager.ts
git rm packages/node/src/planner.ts
git rm packages/node/src/profile-cache.ts
git rm packages/node/src/profile-sync.ts
git rm packages/node/src/manager-agent.ts
git rm packages/node/src/manager-context.ts
git rm packages/node/src/domain-managers.ts
git rm packages/node/src/manager-registry.ts
git rm packages/node/src/manager-failover.ts
git rm packages/node/src/manager-protocol.ts
git rm packages/node/src/self-improver.ts
git rm packages/node/src/strategy-loop.ts
git rm packages/node/src/auto-updater.ts
git rm packages/node/src/workspace-manager.ts
git rm packages/node/src/project-context.ts
git rm packages/node/src/outcome-recorder.ts
git rm packages/node/src/session-registry.ts
```

Fix all import errors in remaining files after deletion.
Run `npm run build` — must compile clean.

---

**Phase 27-D: Lifecycle + Observability — DONE (fcfb0bf)**

Build:
```
UPDATE agent.ts:
  - persistState() called after EVERY event (sessionId, status, cost, lastActive)
  - Resume via --continue --resume <sessionId>
  - rotateAgent(): tell agent "summarize everything" → write KNOWLEDGE-TRANSFER.md
    → create new agent with same role/template/workspace → inject knowledge as Layer 2

UPDATE agent-manager.ts:
  - Agent cleanup sweep (hourly): check lastActive, move IDLE→ARCHIVED after TTL
  - Archival: compress workspace to .tar.gz, keep state.json readable
  - Resurrection: decompress + fresh session + knowledge transfer

UPDATE bridge-queue.ts:
  - Add retry_count field to events
  - On timeout: re-queue with retry_count++ (max 3, then escalate)
  - Add nodeId field (defaults to local, ready for 27-F)

UPDATE agent-tools.ts:
  - GET /agents/tree returns full hierarchy with cost/status per agent
  - Per-agent cost tracking (count events, estimate from model)

UPDATE gateway (packages/gateway/):
  - New page: /agents — agent tree view
  - Show: hierarchy, status badges, cost, current task
  - Click agent → show recent messages, connect for direct chat
```

---

**Phase 27-E: Multi-User + Governance — DONE (d1ceb38)**

Build:
```
UPDATE agent-manager.ts:
  - Per-user message routing (userId in bridge events)
  - Priority queue: production bugs > blockers > questions > features
  - Access control: owner/collaborator/viewer per project
  - connect_user_to_agent(): direct user↔agent conversation
  - user_question message type: escalate up tree to user

UPDATE agent-tools.ts:
  - POST /projects/:id/collaborators — add/remove collaborators
  - GET /projects/:id/access — check user access level
  - POST /agents/:id/connect — connect user directly to agent

UPDATE governance.ts (minor):
  - Wire governance tools as agent-callable (create_proposal, vote)
  - Public projects require governance approval before work starts

UPDATE gateway:
  - Show collaborators on project page
  - User can switch between talking to Manager and talking to specific agent
```

---

**Phase 27-F: Cross-Node Agent Execution (DEFERRED — low priority)**

Agents currently only execute on the node they're spawned on. A manager on EC2-1 cannot spawn a worker that runs on EC2-2. Everything else is already cross-node (storage, deploy, governance, task routing via P2P).

Architecture already supports it (UUID agent IDs, nodeId fields, HTTP comms, ResourceRouter). The remaining work is: agent spawn request forwarded via P2P to a remote node, with the bridge queue event routed back. Low priority — in practice manager + workers run on same node. Revisit when scaling beyond 5 nodes and agent workload distribution becomes a bottleneck.

---

**After all phases: END-TO-END TESTING**

Test as a human user would experience it:
```
1. Open gateway in browser
2. Type "build me a todo app"
3. Verify: Manager responds, plans architecture, spawns builder + tester
4. Verify: Agent tree shows hierarchy in gateway
5. Send mid-task interrupt: "add dark mode"
6. Verify: Manager updates requirements, notifies builder
7. Verify: Builder reports completion, tester runs Playwright tests
8. Verify: Manager reports final result to user
9. Verify: state.json persisted, can resume next day
10. Restart node — verify manager resumes with context
```

Fix everything found during testing. One thing at a time.

---

#### 27-I: Agent Tool Awareness (DONE)

> **Status:** IMPLEMENTED + E2E VERIFIED.
> **Root cause:** Manager agent does not delegate because CLAUDE.md only tells it how to "report to parent." The spawn, message-child, and team management HTTP endpoints are NOT documented in the agent's workspace.

**The problem:** The roadmap at 27.0 lists team tools (spawn_agent, message_child, etc.) but these were never wired into `buildClaudeMd()` in agent.ts. The Communication section (lines 475-484) only includes `POST /agents/<parentId>/message`. The manager template says "spawn 1 builder" in English but the agent has no idea which endpoint to call, what JSON to send, or how to authenticate.

**E2E verification (2026-02-21):** Sent "Build me a simple calculator app and spawn a builder agent to do the work" through the chat. Manager processed the request for 2+ minutes and built the calculator itself. Agent tree showed NO new child agents spawned. The delegation path is completely non-functional.

**The fix — expand agent.ts `buildClaudeMd()` Communication section:**

```
## Communication

Report to your parent:
POST http://127.0.0.1:${API_PORT}/agents/${PARENT_ID}/message
Content-Type: application/json
{"prompt": "your report here"}

### Spawn Child Agents
POST http://127.0.0.1:${API_PORT}/agents/spawn
Content-Type: application/json
{
  "role": "builder|tester|reviewer|researcher|devops",
  "parentId": "${AGENT_ID}",
  "projectId": "${PROJECT_ID}",
  "description": "What this agent does",
  "taskContext": "Specific task for immediate work"
}
Response: { "agentId": "builder-abc123" }

### Message a Child Agent
POST http://127.0.0.1:${API_PORT}/agents/<childId>/message
Content-Type: application/json
{"prompt": "your instructions here"}

### Check Team Status
GET http://127.0.0.1:${API_PORT}/agents/tree?projectId=${PROJECT_ID}

Your agent API base: http://127.0.0.1:${API_PORT}/agents/${AGENT_ID}
```

**Files to change:**
1. `packages/node/src/agent.ts` — expand `buildClaudeMd()` Communication section with spawn/message/tree endpoints
2. `genome/templates/manager.md` — add concrete API examples alongside the English instructions
3. E2E test: send delegation task through chat, verify child agent appears in tree

**Auth note:** Current HTTP API uses Bearer token on write endpoints. Agent needs the API token in its CLAUDE.md, or the spawn/message endpoints need to whitelist agent-originated localhost requests.

---

#### 27.Q Open Questions — ALL RESOLVED

- ~~**Q1: Shared workspace or separate?**~~ **RESOLVED: Shared git repo, separate working directories.** All agents in a project clone/work in the same git repo. Each agent gets its own branch (agent/<agentId>). Manager merges branches. This is how real teams work — shared repo, feature branches. No file copying needed.
- ~~**Q2: Context rotation threshold?**~~ **RESOLVED: Not needed as auto-trigger.** Claude Code handles context compression internally. `rotateSession()` exists as a manual escape hatch if an agent is visibly degrading, but no auto-trigger is needed. Genome + project-state.md survive compression, so context loss is not a practical concern.
- ~~**Q3: Cross-node latency?**~~ DEFERRED to 27-F.
- ~~**Q4: Template versioning?**~~ RESOLVED: latest version wins.
- ~~**Q5: Agent limits per project?**~~ **RESOLVED: Hard limits in code.** max_depth=5, max_agents=50, budget enforced. See 27.0 hard limits section.
- ~~**Q6: How does Scheduler know capacity?**~~ DEFERRED to 27-F.
- ~~**Q7: Conflict resolution?**~~ **RESOLVED: Git branches + Manager merges.** Each agent works on its own branch. Manager reviews and merges. Conflicts = Manager decides (it knows the architecture). Same as a tech lead resolving PR conflicts.
- ~~**Q8: Testing the testers?**~~ **RESOLVED: Template health calibration.** Every 10 projects, inject 3 known bugs, measure catch rate. See 27.5 template health section.
- ~~**Q9: Agent archival format?**~~ **RESOLVED: Full package.** Archive = workspace + state.json + KNOWLEDGE-TRANSFER.md (agent's summary of what it knows). Compressed to .tar.gz. Resurrection decompresses and starts fresh session with knowledge transfer as Layer 2 context.

---

### Phase 68: Launch Readiness (IN PROGRESS)

> **Goal:** One clean logic path for every user interaction. No hacks, no fallbacks, no dual paths. Test each sub-phase before moving on.
>
> **Reference:** `genome/flows/user-journey-scale.md` — the target architecture.
> **Open items:** `memory/discussion-items.md` — tracked from Phase 67 brainstorm.

#### 68.1 — Collection Namespace Isolation (SECURITY — DO FIRST)

**Problem:** All projects share the same MongoDB collections. App A's `messages` collection has ThreadStore data + App B's data. Data leaks across projects.

**Fix:** Resource Proxy enforces collection prefix based on project API key. `messages` → `{projectId}_messages`. Every MongoDB operation through Resource Proxy gets scoped.

**Where to change:**
- `packages/gateway/app/api/resource-proxy/db/route.ts` — prefix collection name with projectId extracted from API key
- `packages/node/src/api-server.ts` lines 3701-3711 — **DELETE** the insecure "fallback to any available storage_db" logic. Apps must use their assigned resource or fail.
- `genome/templates/builder.md` — update: apps must use the collection names as-is (proxy handles prefixing transparently)

**Test plan:**
1. Deploy an app that writes to `messages` collection
2. Verify in MongoDB that the actual collection is `{projectId}_messages`
3. Deploy a second app — verify its `messages` is a DIFFERENT collection
4. Verify ThreadStore still works (it bypasses Resource Proxy, uses MongoDB directly)
5. Verify existing apps still read their old data (migration: check both prefixed and unprefixed on read, only write to prefixed)

**Legacy cleanup:**
- Delete the "fallback to any available storage_db" code (api-server.ts:3701-3711)
- Delete commented-out ResourceMeter code (api-server.ts:3757-3759) — defer to roadmap, don't leave dead code

---

#### 68.2 — GitHub Push Identity (SMALL FIX)

**Problem:** `pushToGitHub` in agent-manager.ts uses the node operator's git credentials → pushes to `jairangwani/app-*` instead of `pando-lux/app-*`.

**Fix:** `pushToGitHub` looks up the `code_repository` resource (dd505b46) from ResourceRegistry, extracts the GitHub PAT, and uses it for push auth. This routes to the correct org automatically.

**Where to change:**
- `packages/node/src/agent-manager.ts` — `pushToGitHub()` method: resolve code_repository resource, use PAT for git push auth
- Already uses `user/repos` endpoint (Phase 66 fix) — just needs the PAT from the resource instead of local git config

**Test plan:**
1. Trigger an agent build that pushes to GitHub
2. Verify repo appears under `pando-lux/app-*` (not `jairangwani/app-*`)
3. Verify the code_repository resource PAT is used (check git remote URL includes token)

**Legacy cleanup:**
- Delete stale `domain-managers.ts` references in agent-manager.ts comments (lines 4, 25) and agent.ts (line 22)
- Extract `DEFAULT_MANAGER_ID = 'pando-node-mgr'` constant in index.ts — replace all 6 hardcoded occurrences

---

#### 68.3 — Doorman / OpenAI Router (BIGGEST CHANGE)

**Problem:** All first-contact user messages go through single `pando-node-mgr` → serial bottleneck. 5th user waits for 4 others. No instant feedback. No cost-efficient triage.

**Fix:** Two-layer AI. Doorman (OpenAI gpt-4o-mini, ~$0.001/msg, <2s) handles first contact. Creates project, runs preflight, spawns per-project manager, returns instant response. Manager (Claude Code, ~$0.50/session) does real work.

**Architecture:** See `genome/flows/user-journey-scale.md` for full design.

**Where to change:**
- `packages/node/src/api-server.ts`:
  - **DELETE** `tryQuickTierResponse()` entirely (lines 6359-6507) — the doorman replaces this
  - **DELETE** the dual tier-check logic in POST /chat/message and POST /chat/multi-message
  - **NEW** `doorman()` function: takes user message + context, calls OpenAI gpt-4o-mini, returns classification (intent, tier, project action)
  - POST /chat/message flow becomes: doorman classifies → if build request: create project + preflight + spawn `project-{id}` manager → enqueue to bridge → return instant response to user ("Your project is set up, manager is working on it")
  - If simple question: doorman answers directly (no Claude Code needed)
  - If returning user with projectId: skip doorman, route directly to `project-{id}` manager

- `packages/node/src/agent-manager.ts`:
  - Per-project managers are already implemented (line 902-927) — no change needed here
  - `pando-node-mgr` stays for node-level events (health, governance, scheduler) but NO LONGER handles user chat

- `packages/node/src/api-server.ts`:
  - **DELETE** `forwardChatToPeer()` (Phase 45 fallback, lines 6269-6357) — doorman ensures messages hit Claude-capable nodes

- `genome/templates/manager.md` — update: manager no longer does first-contact classification, it receives pre-classified work

**Doorman classification logic (deterministic rules + AI fallback):**

| Signal | Action | Cost |
|---|---|---|
| `/status`, `/balance`, `/help` etc | Doorman answers directly | ~$0.001 |
| "Build me X" / "Create X" / "I want X" | Create project → preflight → spawn manager | ~$0.001 + Claude Code |
| "How's my project?" / status check | Check agent tree, return status (no manager wake) | ~$0.001 |
| Existing projectId in request | Skip doorman, route to project manager | $0 |
| Ambiguous | Doorman asks clarifying question | ~$0.001 |
| Mentions WebSocket/Express/backend/server | Tier 2 classification | Deterministic |
| User says "Tier 2" or "EC2" | Honor explicit request | Deterministic |
| Everything else | Tier 1 (S3 + Resource Proxy) | Deterministic |

**Test plan:**
1. Send "Build me a todo app" → verify doorman responds in <3s, project created, manager spawned
2. Send "What's the weather?" → verify doorman answers directly, no Claude Code woken
3. Send "How's my project going?" → verify doorman checks agent tree, returns status
4. Send a message with existing projectId → verify it goes straight to project manager (no doorman)
5. Send 3 build requests simultaneously → verify 3 separate project managers spawned (not queued behind pando-node-mgr)
6. Verify cost: 10 doorman messages < $0.01 total

**Legacy cleanup:**
- Delete `tryQuickTierResponse()` — replaced by doorman
- Delete `forwardChatToPeer()` — replaced by doorman routing
- Delete dual tier-check logic in both chat endpoints
- Clean up `pando-node-mgr` references — it should only handle node events, never user chat

---

#### 68.4 — Returning User Routing (GATEWAY CHANGE)

**Problem:** Gateway is stateless. No memory of which node owns which project. User must manually specify projectId. Returning users can't pick up where they left off.

**Fix:** Gateway queries project→node mapping. Returning user → look up project → route to owning node. If node is down → tell user, offer reassignment.

**Where to change:**
- `packages/gateway/` — chat page needs project selector (list user's projects, show status)
- `packages/gateway/lib/node-pool.ts` — add project→node routing logic
- `packages/node/src/api-server.ts` — `GET /projects` already returns user's projects with nodeId — gateway just needs to use it

**Priority order for routing (cascading fallback):**
1. Same thread → best (instant context, conversation continuity)
2. Same project, thread deleted → manager reads project-state.md, continues in new thread
3. Same project, manager gone → new manager clones from GitHub, reads project-state.md
4. No project found → doorman creates everything fresh

**Test plan:**
1. Build a project on Node A
2. Close browser, come back next day
3. Verify gateway shows "Your projects" list with the project
4. Click project → verify routes to Node A's manager
5. Verify conversation continues (manager reads project-state.md + thread history)

**Legacy cleanup:**
- Remove hardcoded `http://127.0.0.1:4000` default in node-pool.ts — make it explicit (no silent fallback)

---

#### Legacy Cleanup (Do Across All Sub-Phases)

| Item | File | Status |
|---|---|---|
| ~~Insecure resource fallback~~ | ~~api-server.ts~~ | DONE (Phase 68.1 — replaced with "No fallback" + 200 with null) |
| ~~`tryQuickTierResponse()`~~ | ~~api-server.ts~~ | DONE (Phase 68.3 — replaced by `doormanClassify()`) |
| ~~`forwardChatToPeer()`~~ | ~~api-server.ts~~ | DONE (Phase 68.3 — doorman routing handles this) |
| ~~Dual tier-check logic~~ | ~~api-server.ts~~ | DONE (Phase 68.3 — doorman is the single path) |
| ~~`domain-managers.ts` references~~ | ~~agent-manager.ts, agent.ts~~ | DONE (Phase 68.2 — cleaned) |
| ~~Hardcoded `pando-node-mgr` strings~~ | ~~index.ts~~ | DONE (Phase 68.2 — extracted `DEFAULT_MANAGER_ID` constant) |
| ~~`--storage` deprecated flag~~ | ~~cli.ts, CLAUDE.md~~ | DONE (Phase 68 cleanup — flag removed, env var `PANDO_STORAGE_URL` is the path) |
| ResourceMeter billing | api-server.ts | DEFERRED (see Later TODO — not blocking launch) |

---

## Future Phases

### Phase 14: Universal Onboarding (DEFERRED)

> Running a Pando node should be as easy as installing Spotify. Download, double-click, earn Lux.

**The User Journey:**

```
1. Visit pando.network
2. Click "Download Pando"
   -> pando-setup.exe (Windows)
   -> pando-setup.dmg (Mac)
   -> pando-setup.AppImage (Linux)
3. Install (standard installer, signed)
4. App opens: Welcome screen with [Create Account] / [Log In]
5. Create account (password protects Ed25519 identity)
6. Click "Start Node" -> runs in background
7. Dashboard: Lux earned, uptime, tasks processed, peers
8. System tray icon -- node runs silently
9. Auto-updates in background
```

**Sub-phases:**

| Sub-phase | Description | Status |
|---|---|---|
| 14.0 | Bootstrap Scripts + Terminal Gateway -- single script installs Node.js, clones repo, builds, starts node. TUI as primary interface for early users. | Not started |
| 14.1 | Standalone Binary (Node.js SEA) -- single executable, no Node.js install needed | Not started |
| 14.2 | Installer + Auto-Start -- NSIS/WiX (Windows), DMG (Mac), AppImage/deb/rpm (Linux), code-signed | Not started |
| 14.3 | System Tray / Background Mode -- tray icon, resource controls, runs silently | Not started |
| 14.4 | Desktop App (Tauri) -- native app wrapping gateway, ~10MB, embedded node process | Not started |
| 14.5 | Auto-Update for End Users -- background download, graceful restart, rollback on crash | Not started |
| 14.6 | First-Time Setup Wizard -- account creation, contribution level, resource selection | Not started |
| 14.7 | Identity Backup + Recovery -- 12-word BIP-39 mnemonic, cloud backup option | Not started |
| 14.8 | Mobile App (Future) -- iOS/Android light node, earn Lux for uptime/relay/caching | Not started |

**Why deferred:** Stability and test coverage come first. No point onboarding users to a system that crashes.

### Phase 24: Intelligent Communication Agent (DONE — Superseded by Phase 27)

Phases 24.1-24.4 and 24.9 DONE. Phase 24.5-24.8 SUPERSEDED by Phase 27 (Manager IS the conversation, CommunicationAgent deleted).

| Sub-phase | Status |
|---|---|
| 24.1 Intent Detection | DONE |
| 24.2 Project Sessions | DONE |
| 24.3 Enriched CLAUDE.md | DONE |
| 24.4 Governance Proposals | DONE |
| 24.5 CommunicationAgent as Bridge | **SUPERSEDED** — Phase 27 deletes CommunicationAgent entirely. Manager handles all user communication. |
| 24.6 Gateway Project UI | Merged into Phase 27.12 (multi-user projects) |
| 24.7 Multi-User Collaboration | Merged into Phase 27.12 |
| 24.8 Live Tracking Link | Merged into Phase 27.6 (gateway direct-to-Manager) |
| 24.9 Threaded Conversations | **DONE** — ThreadStore stays, Manager reads/writes via tools |

### Phase 25: Bridge Queue + Manager Automation (DONE)

All sub-phases complete. Bridge Queue stays as the core event serialization layer in Phase 27.

See: `genome/components/bridge-queue.md`, `genome/flows/agent-communication.md`

### Phase 26: Genome as Network Service (was Phase 26)

Every project on the Pando network gets its own genome. This turns the genome from a single-project tool into a network-wide knowledge infrastructure.

**How it works:**

When a user says "build me a chess app", the network:
1. Creates a new project with a genome directory
2. Populates it from a starter template (game template includes: board component, move engine, AI opponent, multiplayer sync)
3. Spawns a manager for the project with the genome as its knowledge base
4. As builder agents complete work, the genome agent updates affected component files
5. When a new agent is spawned for the project, it gets SCOPED genome context -- only the components, flows, and rules relevant to its specific task

**This is what makes Pando's 1000-engineer scenario possible.** Every agent reads the genome, knows exactly what exists, what it depends on, and what rules to follow. No agent needs to "explore the codebase" -- the genome tells it everything.

See the full vision below.

---

## Genome Network Service Vision

### Every Project Gets a Genome

```
~/.pando/projects/chess-app/
  genome/
    genome.yaml          # Component registry, flow registry, rule list
    components/
      board.md           # Board rendering, state, click handling
      move-engine.md     # Legal moves, check detection, castling
      ai-opponent.md     # Minimax with alpha-beta pruning
      multiplayer.md     # WebSocket sync, room management
    flows/
      new-game.md        # Player selects color -> board init -> first move
      move-execution.md  # Player clicks -> validate -> animate -> update state -> sync
      game-end.md        # Checkmate/stalemate detected -> show result -> save history
    rules/
      move-validation.md # Every move must be legal per FIDE rules
      turn-order.md      # Players alternate. No double-moves.
    state.md             # Current build status, known issues, recent changes
    history/
      decisions.md       # "Chose React over Vue for UI" (2026-02-20)
```

### The Genome Agent Daemon

The genome agent runs as a lightweight process that watches for changes:

```
Git commit lands
    |
    v
Genome Agent reads diff
    |
    v
Determines affected components:
  - "Modified src/board.tsx" -> updates components/board.md
  - "Added src/multiplayer.ts" -> creates components/multiplayer.md
  - "Deleted src/old-ai.ts" -> marks components/old-ai.md as deprecated
    |
    v
Updates state.md with current build status
    |
    v
If code contradicts genome claims -> creates drift alert
  Example: genome says "move-engine uses minimax"
           but code now uses neural network
  -> Flag: "DRIFT: components/move-engine.md claims minimax, code uses NNUE"
```

### Scoped Context for Workers

When a manager creates a task like "add en passant capture to move engine", the worker receives:

```
Relevant genome context (auto-selected):
  - components/move-engine.md    (directly affected)
  - components/board.md          (depends on move engine)
  - flows/move-execution.md      (en passant changes this flow)
  - rules/move-validation.md     (new validation rule needed)

NOT included (irrelevant to this task):
  - components/ai-opponent.md
  - components/multiplayer.md
  - flows/game-end.md
```

This is the difference between giving an engineer a 500-page manual and giving them the 4 pages they actually need.

### Cross-Project Genome Queries

Because every project has a genome with the same structure, the network can answer questions across projects:

- "Show me all projects using WebSocket sync" -- searches all genome component files for WebSocket references
- "Which projects have payment-gate as a dependency?" -- searches genome.yaml component lists
- "What architecture patterns are most common for game projects?" -- aggregates genome structures across game-type projects

### Genome Drift Detection

The genome agent continuously compares genome claims against actual code:

| Check | What It Detects |
|---|---|
| Component exists | genome.yaml lists a component but the source file is deleted |
| Implementation matches | Component claims "uses Redis" but code imports SQLite |
| Flow accuracy | Flow says "step 3: validate payment" but payment validation was removed |
| Rule enforcement | Rule says "all inputs sanitized" but new endpoint skips sanitization |
| Dependency accuracy | Component claims "depends on auth.md" but no import found |

Drift alerts are surfaced to the manager, who decides whether to update the genome (the code is right) or fix the code (the genome is right).

### Genome Templates

Common project types come with starter genomes:

| Template | Includes |
|---|---|
| website | pages, navigation, layout, styling, forms, API integration |
| api | routes, middleware, database, auth, error handling, rate limiting |
| game | game loop, rendering, input, physics, networking, AI |
| chatbot | intent classification, response generation, context memory, integrations |
| data-pipeline | ingestion, transformation, storage, scheduling, monitoring |

Templates are community-contributed and stored on the network. The genome agent customizes the template based on the user's specific requirements.

### The 1000-Engineer Scenario

This is what makes Pando capable of coordinating massive projects (the "1000 engineers on GTA 7" scenario):

```
Project: massive-game
  |
  genome/
    genome.yaml (500 components, 200 flows, 50 rules)
    |
    v
Manager reads genome, creates task:
  "Implement weather system for desert biome"
    |
    v
Scheduler assigns to worker. Worker receives SCOPED context:
  - components/weather-system.md (what exists)
  - components/desert-biome.md (where it goes)
  - components/particle-engine.md (dependency)
  - flows/environment-update.md (how weather integrates)
  - rules/performance-budget.md (must stay under 16ms/frame)
    |
    v
Worker builds. Genome agent updates:
  - components/weather-system.md (adds sandstorm, heat haze)
  - state.md (desert weather: DONE)
    |
    v
Next worker gets a different task, different scoped context,
but the genome ensures consistency across all 1000 parallel workers.
```

Without the genome, 1000 agents would step on each other, duplicate work, break dependencies, and produce incoherent output. With the genome, each agent knows exactly what exists, what it can depend on, what rules to follow, and where its work fits in the whole.

### Phase 27-G: Graceful Node Restart — DONE

**Originally planned 2026-02-20.** Resolved organically through later phases without explicit phase work.

**What was built:**
- `exit(75)` restart signal — node exits with code 75, PM2/systemd catches it and relaunches. Implemented in `kernel-api.ts`, `tui.ts`, `index.ts`, `cli.ts`.
- `restart-reason.ts` (kernel/) — persists why restart happened, read on next startup
- `POST /upgrade` — triggers graceful drain (waits up to 5 min for in-flight work) then `process.exit(75)`
- PM2 (`ecosystem.config.cjs`) + systemd on EC2 — process supervision on all production nodes
- `crash-guard.ts` (kernel/) — detects crash loops, delays restart on repeated failures

**The original Windows orphan-process problem** is irrelevant on production nodes. PID file approach was replaced by the simpler and more reliable exit(75) + supervisor pattern.

**Already have:** `ecosystem.config.cjs`, `scripts/setup-pm2.sh`, `scripts/setup-pm2.ps1`, crash-guard.ts (detects crash loops), restart-reason.ts (tracks why restart happened), heartbeat.json (last-alive timestamp). Just need to wire them together into a reliable restart flow.

**Agent impact:** Once this works, agents can restart nodes via `POST /restart` instead of fighting with `taskkill`/`Stop-Process`. Estimated effort: 1 session, 3-4 files.

### Phase 28: Multi-Node Per Machine

Run 10+ Pando nodes on a single machine with full isolation:

- **Port management:** Each node gets unique P2P port + API port pair
- **Data isolation:** Each node uses `--data-dir ~/.pando-node-N` for its own identity, ledger, workspaces, and logs
- **Process supervision:** PM2 or systemd manages all node processes as a group
- **Resource limits:** CPU/memory caps per node to prevent one node from starving others
- **Shared mDNS:** All nodes on the same machine discover each other via local mDNS
- **Launch script:** `launch-cluster.sh --count 10` spins up N isolated nodes automatically
- **Use case:** Stress testing, development, and high-throughput node operators

**Already supported today:** `--data-dir` and `--port`/`--api-port` CLI flags make this possible manually. Phase 28 automates and supervises it.

---

## Phase 29: Agent Directive Persistence (DONE — 2026-02-21)

> **The Problem:** Claude Code has no persistent "will." Each inference turn can drift from long-running instructions. An agent told "keep testing until 80% coverage" will eventually default to its trained behavior — summarize progress, stop, and wait for input. This was observed directly in a CEO session: explicit "don't stop" directive was ignored after ~45 minutes of work. Every agent in the Pando network uses the same Claude Code underneath, so this is a systemic risk for any long-running autonomous task.

### What Already Exists (Partial Solution)

The event-driven architecture mitigates this but doesn't solve it:

| Mechanism | How it helps | What it doesn't solve |
|---|---|---|
| **Bridge Queue** | Agent is re-invoked per event — doesn't need to "remember" to keep going | If no new events arrive, agent sits idle even with remaining work |
| **project-state.md** | Persistent external brain — directives survive context compression | Agent can read it but nothing forces it to act on what it reads |
| **Templates (CLAUDE.md)** | Instructions re-injected every session | Instructions are passive — agent can ignore them |
| **--continue --resume** | Conversation history maintained across invocations | History grows, original directive gets buried in context |

**The fundamental gap:** All these mechanisms are passive. They provide context, but nothing *enforces* continuation. Stopping is the default (agent finishes turn, nothing happens). Continuing requires the agent to actively choose to keep going — which is exactly what LLMs are bad at over long sessions.

### The Solution: Self-Continuation + Watchdog

Two mechanisms that flip the default — make stopping the active choice and continuing the default:

#### 1. Standing Directives (New concept)

A new field on agent/project state — not a one-time instruction, but a persistent directive that stays active until explicitly cleared or its completion condition is met.

```
standingDirective: {
  instruction: "Test all untested items in TEST-TRACKER.md until coverage reaches 80%",
  completionCondition: "TEST-TRACKER.md shows >= 80% pass rate",
  createdAt: <timestamp>,
  createdBy: "user" | "manager" | "governance",
  progress: "41% (41/99 tests passing)",
  maxDuration: 86400000,  // 24 hours hard limit
  maxCost: 50.00          // USD budget cap
}
```

This is injected into the agent's context on every invocation, not just available in a file. The agent can't miss it.

#### 2. Self-Continuation via Bridge

After processing a bridge item, if the agent has an active standing directive and made progress, it **enqueues a continuation event for itself** before finishing its turn:

```
Agent processes bridge item (e.g., "test N1")
  → Does work, marks N1 as PASS
  → Checks: standing directive active? Yes. Completion met? No (41% < 80%).
  → Enqueues bridge event: { type: "directive_continuation", payload: { directive: "...", lastProgress: "N1 PASS" } }
  → Finishes turn.

AgentManager picks up bridge event → re-invokes agent → agent continues testing.
```

This creates a self-sustaining loop. The bridge queue guarantees delivery even across crashes. Each cycle is a fresh invocation with full context.

#### 3. Self-Verifying Todo Loop (PRIMARY MECHANISM)

The standing directive and bridge continuation are plumbing. The **real intelligence** is in the todo list itself. The todo is not a static checklist — it's a self-modifying program with conditionals, loops, and verification steps.

```
Agent receives standing directive "Build auth system"
  → Manager creates todo:
    1. Implement JWT middleware
    2. Implement login endpoint
    3. Implement session management
    4. VERIFY: Test steps 1-3 end-to-end
    5. IF any step failed → CREATE fix tasks → APPEND to this list → LOOP to step 4
    6. IF all passed → REPORT DONE

Step 4 finds step 2 is broken (login returns 500):
  → Step 5 triggers: adds "Fix login endpoint 500 error" as step 7
  → Loops back to step 4 after step 7 completes
  → Re-verifies everything
  → All pass → step 6 fires → DONE
```

**Why this is better than a watchdog alone:** A watchdog that re-invokes an idle agent just sends a generic "keep working" nudge. The agent, after context compression, has NO memory of what it was doing. The self-verifying todo is a FILE — it survives compression, it contains the exact state of progress, and it tells the agent exactly what to do next. The agent reads its CLAUDE.md → reads the todo file → knows its position → continues the loop.

**Template instruction (added to all agent templates):**
```
AFTER completing all assigned tasks:
1. Run end-to-end verification of EVERY task output
2. For each failure: add a fix task to your todo list
3. Work through fix tasks
4. Return to step 1 (re-verify everything)
5. Only report DONE to parent when ALL verifications pass
```

**Proven in experiment:** CEO session 2026-02-20 tested this pattern. A directive file + state file + todo list maintained a 4-task loop without stopping. Each task completion triggered a "read directive → check remaining → continue" cycle. All 4 tasks completed autonomously including delegated work and end-to-end verification.

#### 4. Watchdog in AgentManager (SAFETY NET — not primary)

The watchdog is demoted from "primary mechanism" to "crash recovery." Its job is to catch cases where the self-verifying todo loop fails (agent crash, API error, unexpected exit). It does NOT provide intelligence about what to do — the todo file does that.

If an agent has an active standing directive but:
- Goes idle for N minutes (configurable, default 5 min)
- Hasn't enqueued a continuation event
- Directive completion condition not met

AgentManager sends a nudge event to the bridge:

```
{
  type: "directive_nudge",
  payload: {
    message: "You have a standing directive that is not yet complete. Read your todo file and continue from where you left off.",
    directive: "<the directive>",
    todoFilePath: "<path to agent's todo file>",
    currentProgress: "<last known progress>",
    idleMinutes: 7
  }
}
```

The nudge points the agent TO its todo file, not just to a generic "keep working." After context compression, the agent reads CLAUDE.md → gets nudged → reads todo → knows exactly what to do.

#### 5. Safety Rails

| Rail | Purpose |
|---|---|
| **Completion condition** | Prevents infinite loops — directive clears when condition is met |
| **maxDuration** | Hard time limit — even infinite loops eventually stop |
| **maxCost** | Budget cap — prevents runaway API spend |
| **Retry budget** | Bridge queue max 3 retries per item — prevents stuck loops |
| **Manual clear** | User or governance can clear any standing directive at any time |

### Why This Matters

Without this, every long-running autonomous task in the Pando network — code pipelines, test suites, multi-step builds, infrastructure maintenance — depends on the AI model's willpower to keep going. That's unreliable by design. This phase turns "I hope the agent keeps working" into "the architecture guarantees the agent keeps working until the job is done or the budget runs out."

### Implementation Estimate

- Standing directive field on Agent state: ~50 lines
- Self-continuation bridge enqueue in agent sendEvent result handler: ~30 lines
- Watchdog check in AgentManager cleanup sweep: ~40 lines
- Template updates (manager/builder/devops): ~20 lines per template
- Total: ~200 lines of code, touches 4 files

### Dependencies

- Phase 27 complete (agent.ts, agent-manager.ts, bridge-queue.ts all stable)
- ~~S2 fix (AgentManager must consume approved queue — currently broken)~~ **FIXED** (2026-02-20): Scheduler emits `task:approved` → index.ts listener → bridge.enqueue → AgentManager processes. Verified E2E.

### Todo Loop Budget Model (Future Enhancement)

Transition the todo loop from a fixed retry count to pay-as-you-go. User sets a Lux budget for the task; the loop runs until work is genuinely done or budget is exhausted. User can top up or stop at any time. This replaces the hard retry cap with an economic signal — the loop continues as long as the user values the work. Simple fixes cost little, deep-rooted bugs cost more, but productive ping-pong (fix -> test -> find deeper issue -> fix -> test) is never cut short artificially. See `genome/rules/todo-loop.md` for the feedback loop rationale.

### Graceful Restart Architecture (NEEDED — Operational Gap)

**The Problem:** Node processes become zombies during restarts. Root causes:
1. **Port held by orphan child processes** — Claude Code agents (spawned via `child_process.spawn`) survive parent exit. They inherit the Fastify listen socket. `SIGTERM` to the parent doesn't cascade to deeply-spawned grandchildren.
2. **No graceful shutdown API** — the only way to stop a node is `SIGINT` (Ctrl+C) or `kill`. No HTTP endpoint to trigger clean shutdown.
3. **No port pre-check** — `cli.ts` tries to listen on the port, fails with `EADDRINUSE`, and crashes. No attempt to detect and clean up the stale process first.
4. **Windows-specific:** `taskkill /PID` via Git Bash mangles the `/PID` flag. Must use `cmd.exe /c` or PowerShell, which agents often forget.

**Impact:** Every code deploy → restart cycle wastes 3-10 minutes fighting zombie processes. This blocks the autonomous upgrade pipeline (Phase 13 UpgradeProtocol) and makes CEO/agent node management painful.

**The Solution (3 parts):**

1. **`POST /admin/shutdown`** — Graceful shutdown API endpoint. When called:
   - Stops accepting new bridge items and tasks
   - Sends SIGTERM to all child agent processes (AgentManager.killAll())
   - Waits up to 10s for agents to exit, then SIGKILL
   - Closes Fastify, libp2p, SQLite
   - Writes `~/.pando/shutdown-reason.json` (like restart-reason.json)
   - Calls `process.exit(0)`

2. **Port pre-check in cli.ts** — Before calling `node.start()`, check if the API port is in use:
   - TCP connect test to `0.0.0.0:<apiPort>`
   - If something is listening: read `~/.pando/heartbeat.json` to find the PID
   - If the PID matches a node process: call `POST /admin/shutdown` on the old instance
   - Wait for port to become free (up to 15s), then continue
   - If still blocked: log error with the PID and exit with clear message

3. **Agent process cleanup in AgentManager** — On shutdown:
   - Track all spawned child PIDs in a set
   - On SIGTERM/SIGINT: iterate and kill each, plus their process groups
   - On `process.exit`: sync-kill any remaining (best-effort via `process.kill()`)

**Files to change:** `cli.ts` (port pre-check), `api-server.ts` (shutdown endpoint), `agent-manager.ts` (child PID tracking + killAll), `agent.ts` (expose child PID).

**Priority:** HIGH — blocks autonomous operation. Should be part of Phase 27 finalization.

---

## Phase 30: AI-Powered Governance (DESIGN — Not Started)

> **The Problem:** Governance today is vote-counting, not vote-thinking. Any peer can vote approve/reject, but nobody evaluates whether a proposal is technically sound, safe, or beneficial. Humans can't review every proposal at scale. Without intelligent review, the network is vulnerable to: malicious proposals disguised as bug fixes, incompetent changes that break things, and spam proposals that waste everyone's attention.

### Design Requirements (from Jai)

1. Proposals cost Lux — anti-spam
2. Start with 1 AI reviewer when network is small (< 10 nodes)
3. Scale to 3 reviewers when 100+ nodes are online
4. Reviewers MUST run on SEPARATE physical devices — anti-jailbreak security model
5. Review is intelligent — AI reads the proposal, evaluates it, votes with reasoning

### The Core Idea

Every governance proposal gets reviewed by AI agents running on randomly selected nodes. The AI reads the proposal, analyzes its impact, and casts an informed vote with detailed reasoning. Because reviewers run on different physical machines with different operators, compromising (jailbreaking) one AI doesn't compromise the review — you'd need to simultaneously jailbreak multiple AIs on machines you don't control.

### Proposal Cost Model

| Action | Cost | Refund Policy |
|---|---|---|
| Submit proposal | 10 Lux (stake) | Refunded if proposal passes. Burned if rejected or expires with 0 votes. |
| Submit amendment to existing proposal | 2 Lux | Non-refundable. Prevents amendment spam. |
| Emergency proposal (expedited review) | 50 Lux | Refunded if passes. Higher cost reflects higher urgency processing. |

**Why stake-and-refund:** Pure burn discourages all proposals including good ones. Stake-and-refund means good proposals are free (you get your Lux back) while bad/spam proposals cost real money. This creates an economic filter: only submit proposals you believe will pass.

**Free tier exception:** The first proposal from any account with < 100 Lux balance is free (0 Lux stake). This prevents the chicken-and-egg problem where new node operators can't participate in governance because they haven't earned enough Lux yet.

### Reviewer Selection

#### How Many Reviewers

| Network Size (online nodes) | Required Reviewers | Quorum to Pass |
|---|---|---|
| 1-3 nodes | 1 reviewer | 1 approve |
| 4-9 nodes | 1 reviewer + 1 human vote required | 1 approve + 1 human |
| 10-49 nodes | 2 reviewers | 2/2 agree (unanimous) |
| 50-99 nodes | 2 reviewers | 2/2 agree (unanimous) |
| 100+ nodes | 3 reviewers | 2/3 majority |

**Why unanimous at small scale:** With only 2 reviewers, if they disagree, the proposal is ambiguous. Force consensus — if the reviewers can't agree, the proposal needs human review. At 100+ nodes with 3 reviewers, majority (2/3) is sufficient because the probability of 2 independent AIs both being wrong is very low.

#### Selection Algorithm

```
1. Proposer submits proposal with Lux stake
2. Proposal broadcasts to all nodes via GossipSub
3. EVERY node that receives the proposal:
   a. Checks: do I have Claude Code capability? (capabilityRegistry.has('claude-code'))
   b. Checks: is my reputation score >= 0.5? (minimum reviewer reputation)
   c. Checks: am I the proposer? (can't review your own proposal)
   d. If all yes → compute selection score:
      score = SHA256(proposalId + peerId + proposalTimestamp) mod 10000
   e. Broadcast candidacy: { proposalId, peerId, score, capabilities }

4. After candidacy window (5 minutes):
   - All nodes have the same candidate list (GossipSub consistency)
   - Sort candidates by score (deterministic — same input = same sort on every node)
   - Top N candidates (where N = required reviewers) are selected
   - Selection is verifiable by any node (same hash, same sort, same result)
```

**Why hash-based selection:** It's deterministic (every node computes the same result), unpredictable (proposer can't choose reviewers), and verifiable (any node can re-run the math to check). No coordinator needed.

**Device uniqueness enforcement:** The candidacy broadcast includes the node's public IP (or Tailscale IP for private nodes). If two candidates share the same IP → only the one with the higher reputation score is kept. This is imperfect (NAT, VPNs) but catches the obvious case of someone running 3 nodes on one machine to game the review.

**Future improvement:** Hardware attestation or proof-of-distinct-hardware. For now, IP + reputation is good enough for a small network.

#### What If Not Enough Reviewers?

| Scenario | Action |
|---|---|
| 0 eligible reviewers (no Claude Code nodes besides proposer) | Proposal enters "human-only" mode. Requires 2 human votes within 48 hours. If < 2 votes → expires, stake refunded. |
| Fewer reviewers than required (e.g., need 3 but only 2 eligible) | Use available reviewers. Lower quorum: all available must agree (unanimous). |
| Selected reviewer goes offline during review | 30-minute timeout. If reviewer doesn't vote in 30 min → next candidate in the sorted list takes over. Max 2 fallbacks. |
| All fallbacks exhausted | Proposal enters human-only mode (same as 0 reviewers). |

### AI Review Process

When a node is selected as a reviewer, it spawns a dedicated `reviewer` agent (using the existing Agent primitive):

```
AgentManager.spawnAgent({
  role: 'reviewer',
  template: 'genome/templates/reviewer.md',
  context: {
    proposalId,
    proposalTitle,
    proposalDescription,
    proposerPeerId,
    proposerReputation,
    networkSize,
    relatedFiles: [],   // populated below
  }
})
```

#### Review Steps (reviewer agent todo)

1. **UNDERSTAND** — Read the proposal title and description. Identify what it claims to do.

2. **CLASSIFY** — Categorize the proposal:
   - `code_change` — modifies source code (most common for upgrades)
   - `config_change` — changes node configuration, constants, limits
   - `economic_change` — modifies Lux rewards, costs, emission rates
   - `governance_change` — changes governance rules themselves (meta-governance)
   - `social` — community proposals, partnerships, non-technical
   - `emergency` — security fix, critical bug, needs fast action

3. **ANALYZE** — Based on category:
   - For `code_change`: If the proposal includes a diff or references specific files, read those files. Check for: security vulnerabilities (injection, path traversal, key exposure), breaking changes to public APIs, regression risk, test coverage.
   - For `economic_change`: Model the impact. "Change daily cap from 500 to 5000 Lux" — what does that mean for inflation? Node operator incentives?
   - For `governance_change`: Check for power grabs. Does this proposal give one entity disproportionate control? Does it weaken safety rails?
   - For `emergency`: Fast-track analysis. Focus on: does the fix actually fix the stated problem? Does it introduce new issues?

4. **ASSESS RISK** — Score 1-5:
   - 1: No risk (documentation, comments, minor config)
   - 2: Low risk (new feature, additive change, well-tested)
   - 3: Medium risk (behavior change, API modification, economic adjustment)
   - 4: High risk (security-related, core protocol change, breaking change)
   - 5: Critical risk (governance change, economic overhaul, Law I/II implications)

5. **DECIDE** — Based on analysis:
   - `approve` — proposal is sound, beneficial, and safe
   - `reject` — proposal is flawed, dangerous, or unnecessary (must provide specific reasons)
   - `request_revision` — proposal has merit but needs changes (specific suggestions required)

6. **VOTE** — Cast vote with full reasoning via `governance.vote()` including model attestation (Ed25519 signed, proving which AI model reviewed it).

#### Review Quality Requirements

The reviewer agent's vote MUST include:
- **Category** classification
- **Risk score** (1-5)
- **Reasoning** (minimum 3 sentences explaining the decision)
- **Specific concerns** (if rejecting or requesting revision)
- **Model attestation** (already supported in governance.ts)

Votes without reasoning are invalid and discarded. This prevents rubber-stamping.

### Vote Integrity

#### Model Attestation (already exists)

The current `createAttestation()` in governance.ts already signs votes with Ed25519, proving which model on which node cast the vote. Phase 30 makes this mandatory for AI reviewer votes (currently optional for all votes).

#### Anti-Collusion

- **Reviewers don't see each other's votes until all have voted.** Votes are encrypted with the proposal's public key (derived from proposalId) and only decrypted after all reviewers have voted or the review window expires. This prevents "follow the leader" voting.
- **If a reviewer's vote exactly matches another reviewer's reasoning word-for-word** (beyond coincidental similarity), flag for human review. This catches copy-paste attacks where a compromised node replays another node's review.

#### Anti-Jailbreak Security Model

The core security assumption: **it's extremely hard to simultaneously jailbreak AI models running on different physical machines operated by different people.**

Why this works:
- Each reviewer runs Claude Code in its own sandbox on a machine the attacker doesn't control
- The reviewer's CLAUDE.md includes strict principles from `genome/templates/reviewer.md`
- The AI has access to the full codebase and can independently verify claims
- Even if one reviewer is compromised (unlikely but possible), the quorum requirement means 1 bad vote isn't enough at scale
- Model attestation proves which model voted — if the attestation doesn't match Claude Code's known behavior patterns, it can be flagged

What this does NOT protect against:
- All node operators colluding (possible in a 3-node network — mitigated by growing the network)
- A fundamental vulnerability in the AI model itself (not a Pando problem)
- Social engineering the proposer to include malicious code that looks benign to AI (the hardest attack — mitigated by risk scoring and human oversight for high-risk proposals)

### Proposal Lifecycle

```
User/Agent creates proposal
  │
  ├─► Lux stake deducted (10 Lux default, 50 for emergency)
  │   If insufficient balance → reject immediately
  │
  ├─► Broadcast to network via GossipSub
  │
  ├─► 5-minute candidacy window
  │   Eligible nodes broadcast candidacy
  │   Deterministic selection picks N reviewers
  │
  ├─► Review window (varies by proposal type):
  │   │  Standard: 24 hours
  │   │  Emergency: 2 hours
  │   │  Governance change: 72 hours (extra scrutiny)
  │   │
  │   ├─► Each reviewer spawns reviewer agent
  │   ├─► Agent analyzes, scores risk, decides
  │   ├─► Agent casts encrypted vote with reasoning + attestation
  │   └─► If reviewer times out (30 min no vote) → fallback to next candidate
  │
  ├─► Vote reveal (after all votes cast or window expires)
  │   Decrypt all votes simultaneously
  │
  ├─► Decision:
  │   ├─► PASS: quorum met (see table above)
  │   │   → Stake refunded to proposer
  │   │   → If code_change: trigger UpgradeProtocol (git pull → build → restart on all nodes)
  │   │   → Reviewers earn 2 Lux each (from network emission, not proposer)
  │   │
  │   ├─► REJECT: quorum voted against
  │   │   → Stake burned (sent to NETWORK account)
  │   │   → Proposer receives rejection reasons
  │   │   → Reviewers earn 1 Lux each (less than approval — reviewing is still work)
  │   │
  │   ├─► REVISION REQUESTED: reviewer(s) asked for changes
  │   │   → Stake held (not burned, not refunded yet)
  │   │   → Proposer gets specific revision suggestions
  │   │   → Proposer can submit amended proposal (2 Lux additional)
  │   │   → Amended proposal goes through same review (same reviewers if available)
  │   │   → If no amendment in 7 days → stake refunded, proposal archived
  │   │
  │   ├─► SPLIT DECISION: reviewers disagree (e.g., 1 approve, 1 reject)
  │   │   → Escalate to human vote. Requires 3 human votes within 48 hours.
  │   │   → If < 3 human votes → expires, stake refunded
  │   │   → Reviewer reasoning is shown to human voters for context
  │   │
  │   └─► EXPIRED: not enough reviewers voted
  │       → Stake refunded
  │       → Proposal can be resubmitted (no penalty)
  │
  └─► Post-decision: if passed + code_change → UpgradeProtocol integration (Phase 82)
      → Proposer: already at target version, broadcasts commit hash to peers
      → All peers: git pull → verify hash → npm run build → restart
      → If build fails → automatic rollback to previous commit
```

### Integration with Existing Systems

| System | Integration Point |
|---|---|
| **GovernanceSync** (governance.ts) | Extends `propose()` to deduct Lux stake. Adds `reviewer_selection` phase between proposal and voting. |
| **UpgradeProtocol** (upgrade-protocol.ts) | Passed code_change proposals trigger `pullAndUpgrade()` automatically. Git pull → hash verify → build → restart. Rollback on build failure. |
| **PaymentGate** (payment-gate.ts) | Handles Lux stake hold/release/burn. Reuse escrow pattern from user requests. |
| **ReputationWeightedGovernance** | Human votes (when needed) still use reputation weighting. AI reviewer votes are NOT reputation-weighted (they already have built-in quality). |
| **Agent** (agent.ts) | Reviewer agents are standard Agent instances with `role: 'reviewer'`. Spawn, process, persist, cleanup — all existing. |
| **CapabilityRegistry** | Used to determine which nodes have `claude-code` capability for reviewer eligibility. |
| **Templates** | `genome/templates/reviewer.md` already exists. Extend with governance-specific review workflow. |

### Edge Cases & Failure Modes

#### Spam Attacks
| Attack | Defense |
|---|---|
| Flood proposals to drain reviewer resources | 10 Lux cost per proposal. Rate limit: max 1 active proposal per account. |
| Create many accounts to submit many proposals | Genesis allocation is small. New accounts need to earn Lux first (uptime, tasks). |
| Submit trivial proposals to waste AI review time | Reviewer agent detects trivial/meaningless proposals → instant reject → stake burned. Economic deterrent. |

#### Gaming the Review
| Attack | Defense |
|---|---|
| Run 3+ nodes on same machine to control reviewer selection | IP dedup in candidacy. Future: hardware attestation. |
| Propose malicious code that looks benign to AI | Risk scoring. High-risk categories (security, core protocol) get 72-hour window + human review required. |
| Time proposals when specific nodes are offline to control selection pool | Candidacy window is 5 min — hard to predict which nodes go offline. Selection uses ALL candidates, not just the first N. |
| Compromise a reviewer node's Claude Code installation | Model attestation proves which model voted. Anomalous attestations flagged. Other reviewers compensate (quorum). |

#### Operational Failures
| Failure | Recovery |
|---|---|
| Reviewer node crashes mid-review | 30-min timeout → fallback to next candidate. Agent state persisted, can resume. |
| GossipSub loses candidacy messages | Each node independently computes eligibility. If your candidacy wasn't received, you won't be selected — system still works, just with fewer candidates. |
| Proposal references files that don't exist on reviewer's node | Reviewer agent notes "unable to verify code changes — files not found" and requests revision. |
| Network partition during review | Votes from partitioned reviewers arrive late. If within window → counted. If after window → ignored, fallback used. |
| AI model update changes review behavior | Model attestation includes modelId. If the model ID changes mid-review-window, the vote is still valid (the attestation proves consistency). |

#### Meta-Governance Attacks
| Attack | Defense |
|---|---|
| Propose changing governance rules to remove AI review | `governance_change` category gets 72-hour window + ALL online Claude Code nodes review (not just N selected). High bar: 80% approval required. |
| Propose reducing proposal cost to 0 Lux | Same as above — `economic_change` + `governance_change` double-category. Extra scrutiny. |
| Propose adding a backdoor to the reviewer template | Template changes are `governance_change`. Reviewer agents specifically check for self-referential changes ("is this proposal modifying MY review process?"). |

### What This Does NOT Cover (Explicitly Scoped Out)

1. **On-chain voting** — We're not a blockchain. Votes are GossipSub-synced and SQLite-persisted. Good enough for a cooperative network.
2. **Formal verification of code proposals** — AI review is heuristic, not proof. It catches obvious issues, not subtle mathematical bugs.
3. **Anonymous proposals** — Proposers are identified by peerId. Anonymous proposals could be added later but raise accountability concerns.
4. **Delegation / liquid democracy** — One node, one vote (or one AI review). No delegation chains. Keep it simple.
5. **Cross-network governance** — Proposals are per-network. If Pando forks, each fork governs itself.

### Implementation Estimate

| Component | Lines (est.) | Files |
|---|---|---|
| Proposal cost (stake/refund/burn) | ~80 | governance.ts, payment-gate.ts |
| Reviewer selection (hash-based, IP dedup) | ~150 | governance.ts (new module or method) |
| Reviewer agent spawning + review workflow | ~120 | agent-manager.ts, governance.ts |
| Vote encryption/reveal | ~100 | governance.ts, crypto additions |
| Reviewer template updates | ~50 | genome/templates/reviewer.md |
| API routes for review status | ~60 | api-server.ts or agent-tools.ts |
| Gateway UI (proposal detail + review status) | ~200 | gateway pages |
| **Total** | **~760** | **6-8 files** |

### Dependencies

- Phase 27 complete (agent system stable) — DONE
- Phase 28 PaymentGate working (escrow for stake) — DONE (in code, needs E2E test)
- CapabilityRegistry tracking `claude-code` capability — DONE
- `genome/templates/reviewer.md` exists — DONE (needs governance-specific additions)
- Model attestation in governance.ts — DONE

### Sub-phases

| Sub-phase | Description | Status |
|---|---|---|
| 30.0 | Proposal staking — 10 Lux via PaymentGate escrow, refund/burn on outcome | DONE (82fd69b) |
| 30.1 | Reviewer selection — hash-based scoring, IP dedup, 5-min candidacy window | DONE (82fd69b) |
| 30.2 | Reviewer agent spawning — AgentManager creates reviewer agent, 5 Lux budget | DONE (ae19ece) |
| 30.3 | Review workflow — submitReview, GossipSub broadcast, review aggregation engine | DONE (ae19ece) |
| 30.4 | Decision engine — reviewSummary in decisions, small network fallback | DONE (ae19ece) |
| 30.5 | Fallback handling — timeout→next candidate (max 2), human-only mode (48h, min 2 votes) | DONE (c5aa959) |
| 30.6 | Meta-governance protection — governance_change: 72h, 80% approval, min 5 votes | DONE (c5aa959) |
| 30.7 | API routes — GET reviews, GET reviewers, POST review, GET governance stats | DONE (c5aa959) |
| 30.8 | Gateway UI — enhanced governance page with review display, stats, reviewer status | IN PROGRESS |

---

## Phase 31: Project Economy — Ownership, Revenue & the Parallel Internet (DESIGN — Not Started)

> **The Problem:** Users can talk to Pando and get things built, but there's no concept of "my projects," no persistent ownership, no way to earn from what you create, and no way to share or transfer ownership. Without this, Pando is a chatbot that builds disposable things. With this, Pando is an economic platform where anyone can create, own, share, and monetize digital products — a parallel internet with a built-in economy.

### What Exists Today (Honest)

| Feature | Status |
|---|---|
| Project registry in AgentManager | EXISTS — in-memory map, owner/collaborators/agents |
| Access control roles | EXISTS — owner / collaborator / qa_lead / viewer |
| Thread-based conversations | EXISTS — persistent threads with messages |
| Agent work tracking | EXISTS — cost tracking per agent, events logged |
| Lux transfers between users | EXISTS — ledger handles peer-to-peer transfers |
| Persistent user accounts | DONE (Phase 31.0) — scrypt hashing, session tokens, 9 auth API routes |
| Project creation from conversation | MISSING — all chat goes to pando-node-mgr |
| Project types (private/shared/public) | MISSING |
| Revenue model for projects | MISSING |
| Ownership transfer | MISSING |
| Contribution tracking | MISSING |
| Project deployment to real infra | MISSING |
| Project discovery / marketplace | MISSING |

### Core Concepts

#### 1. Everything Is a Project

Every piece of work on Pando lives inside a project. A project is the atomic unit of ownership, collaboration, billing, and deployment.

```
Project {
  id:            "portfolio-site-a3f2"
  name:          "Portfolio Website"
  description:   "Personal portfolio with blog"

  // Ownership
  owner:         userId | "NETWORK"        // who controls it
  type:          "private" | "shared" | "public"
  visibility:    "owner_only" | "collaborators" | "listed" | "featured"

  // Economics
  revenueModel:  "none" | "usage_fee" | "subscription" | "contribution_split"
  revenueConfig: { ... }                   // model-specific config

  // Work
  budget:        { spent: 120, limit: 500 }   // Lux spent building this
  agents:        ["manager-xyz", "builder-abc"]
  threads:       ["chat-123", "chat-456"]

  // Deployment
  deployment:    { type: "vercel", url: "https://...", status: "live" }

  // Access
  collaborators: [
    { userId: "abc", role: "collaborator", joinedAt: ... },
    { userId: "def", role: "viewer", joinedAt: ... }
  ]

  // Metadata
  createdAt:     timestamp
  updatedAt:     timestamp
  category:      "website" | "api" | "game" | "tool" | "research" | "infrastructure"
  tags:          ["react", "blog", "portfolio"]
}
```

#### 2. Three Project Types

**Private** — You own it, you control it, you pay for it.
```
Owner:          Single user
Visibility:     Owner decides (can make it visible or hidden)
Governance:     Owner approves all changes
Revenue:        100% to owner
Build cost:     Owner pays Lux for all agent work
Deployment:     Owner controls (their cloud accounts, their domain)
Transfer:       Owner can sell (direct) or donate (to network)
```

Use cases: personal websites, private tools, business apps, anything you want full control over.

**Shared** — You own it, others help build it, you set the rules.
```
Owner:          Single user (admin)
Collaborators:  Invited users with roles (contributor, reviewer, viewer)
Visibility:     Listed on project marketplace (opt-in)
Governance:     Owner approves changes. Collaborators propose via governance.
Revenue:        Owner sets the split (see Revenue Model below)
Build cost:     Owner pays, OR shared budget (collaborators contribute Lux)
Deployment:     Owner controls, but collaborators can propose deploys
Transfer:       Owner can transfer admin to a collaborator or to network
```

Use cases: open-source projects you lead, team projects, community tools where you want help but keep control.

**Public (Network-Owned)** — The network owns it. Governance decides everything.
```
Owner:          NETWORK (no single owner)
Contributors:   Anyone can propose changes (costs Lux, goes through Phase 30 governance)
Visibility:     Always listed and discoverable
Governance:     AI-powered governance (Phase 30) reviews all changes
Revenue:        Split among contributors + network treasury (see below)
Build cost:     Network treasury funds, OR community-funded (crowdfunding)
Deployment:     Governance-approved deploys only
Transfer:       Cannot transfer — it's permanently public
```

Use cases: Pando itself, network infrastructure, public utilities, community resources.

#### 3. Conversation → Project Flow

When a user talks to the gateway, the Manager AI decides whether to create a new project or work within an existing one:

```
User: "Build me a todo app"
  │
  ▼
Manager checks:
  1. Does this user have a project that matches? (fuzzy search by description/tags)
  2. Is this about an existing public project? (e.g., "improve Pando governance")
  3. Is this a new request?
  │
  ├─► Existing project found: "Continuing work on 'Todo App (v2)'. Last session: added auth."
  │   → All work scoped to that project. Threads linked. Budget tracked.
  │
  ├─► Public project match: "This relates to Pando Network. You'll be contributing as a contributor."
  │   → Work tracked under user's contributor profile for that public project.
  │   → If it results in a proposal, costs 10 Lux (Phase 30).
  │
  └─► New project: "I'll create a new project for this. What should I call it?"
      → Manager creates project with defaults:
        type: "private", visibility: "owner_only", revenueModel: "none"
      → User can change settings anytime: "Make this shared" / "Open it up"
```

**Smart project detection:** The manager doesn't ask "is this a new project?" every time. It uses context:
- Same thread = same project (thread is linked to project)
- New thread + clear new topic = new project
- New thread + reference to existing work = resume existing project
- Ambiguous = ask the user

#### 4. The "My Projects" Dashboard

```
┌─────────────────────────────────────────────────────────────┐
│  My Projects                                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  🔒 Portfolio Website          Private    Cost: 45 Lux     │
│     Status: Deployed           Revenue: —                   │
│     https://my-portfolio.vercel.app                         │
│                                                             │
│  👥 Chess Game                  Shared     Cost: 200 Lux    │
│     3 collaborators            Revenue: 150 Lux/month       │
│     Status: Live               Your share: 105 Lux/month    │
│                                                             │
│  🌐 Pando Network              Public     Contributor       │
│     3 proposals accepted       Earned: 75 Lux total         │
│     Contribution rank: #12                                  │
│                                                             │
│  🌐 AI Tutor App               Public     Founder           │
│     Transferred 2026-01-15     Founder bonus: 80 Lux/month  │
│     247 active users           Total earned: 320 Lux        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Revenue Model (The Economics)

Revenue only applies when a project provides a service that others use. Not every project earns money — a personal portfolio website has no revenue model, and that's fine.

#### Revenue Sources

| Source | How It Works | Example |
|---|---|---|
| **Usage fees** | Users pay Lux per action/request | Game: 0.1 Lux per game played |
| **Subscription** | Users pay Lux per time period | SaaS tool: 5 Lux/month |
| **One-time purchase** | Users pay once for access | Template: 10 Lux |
| **Tip/donation** | Users voluntarily send Lux | Open-source project: tip jar |
| **Ad-free (never)** | NOT SUPPORTED | Pando has no ads, ever. Law I. |

#### Revenue Split

When a project earns Lux, it's split automatically:

**Private projects:**
```
Revenue: 100 Lux from user fees this month

Split:
  Owner:              85 Lux  (85%)
  Compute node(s):    10 Lux  (10%)  — the nodes actually running the service
  Network relay:       5 Lux  ( 5%)  — routing fees
```

**Shared projects (owner sets the split):**
```
Revenue: 1000 Lux this month

Default split (owner can customize):
  Owner/Admin:        40%     — 400 Lux
  Contributors:       40%     — 400 Lux (weighted by contribution — see below)
  Compute nodes:      15%     — 150 Lux
  Network relay:       5%     —  50 Lux
```

**Public projects (network-governed):**
```
Revenue: 5000 Lux this month

Split (set by governance, default):
  Contributors:       50%     — 2500 Lux (weighted by contribution)
  Network treasury:   30%     — 1500 Lux (funds future development)
  Compute nodes:      15%     —  750 Lux
  Network relay:       5%     —  250 Lux
```

#### Contribution Weighting

For shared and public projects, contributor revenue is weighted by **verified contribution score**, not lines of code (gameable). Contribution is measured by the agent system:

| Action | Weight | Verification |
|---|---|---|
| Accepted code change (merged PR equivalent) | 10 per change | AI reviewer approved + tests pass |
| Bug fix (verified by QA) | 15 per fix | QA agent confirms fix resolves issue |
| Feature addition (new capability) | 20 per feature | Manager confirms feature complete |
| Documentation / genome update | 5 per update | AI reviewer confirmed accuracy |
| Code review / QA testing | 3 per review | Review was substantive (not rubber-stamp) |
| Governance proposal accepted | 8 per proposal | Phase 30 AI review + community vote |
| Reported bug (confirmed real) | 5 per report | Reproducible, not a duplicate |

**Contribution score decay:** Scores decay at 10% per month. A contributor who stopped contributing 6 months ago earns proportionally less than an active contributor. This prevents early founders from extracting value forever without ongoing work.

**Founder bonus (for projects transferred to public):** The original creator gets a 2x multiplier on their contribution score for 2 years after transfer. After that, they're weighted the same as anyone else. This rewards the original vision and effort without creating a permanent aristocracy.

### Ownership Transfer

#### Private → Shared
```
Owner: "Make this project shared"
  → Project type changes to "shared"
  → Owner retains admin role
  → Can now invite collaborators
  → Revenue model can be enabled
  → Visibility can be changed to "listed"
```

#### Shared → Public (Transfer to Network)
```
Owner: "Transfer this to the network"
  → Triggers governance proposal (costs 10 Lux like any proposal)
  → AI reviewers evaluate: is this project valuable to the network?
  → If approved:
    → Owner field changes to "NETWORK"
    → Owner becomes a contributor with founder bonus (2x for 2 years)
    → Revenue split changes to public model
    → All future changes go through governance
  → If rejected:
    → Project stays shared
    → Owner gets feedback on why (maybe project isn't ready, or not useful enough)
```

#### Direct Sale (Private or Shared)
```
Owner: "Sell this project to user X for 500 Lux"
  → Escrow: buyer's 500 Lux held by PaymentGate
  → Buyer reviews project (read-only access for 24 hours)
  → Buyer confirms: Lux transferred, ownership transferred
  → Buyer cancels: Lux returned, no change
  → All existing collaborators stay (new owner inherits team)
  → Revenue split stays the same (new owner can change it)
```

### Deployment (How Projects Go Live)

Built projects need to be deployed to real infrastructure. Pando doesn't replace hosting — it orchestrates deployment to existing services.

#### Deployment Targets

| Target | How | Cost |
|---|---|---|
| **Vercel** | Owner contributes Vercel account token OR uses network shared account | Free tier or owner's plan |
| **GitHub Pages** | Push to repo, enable Pages | Free |
| **AWS S3 + CloudFront** | Owner contributes AWS credentials | Owner's AWS bill |
| **Custom server** | SSH deploy via ORC-style agent | Owner provides server access |
| **Pando-hosted (future)** | Node operators host on their machines, earn Lux | Costs Lux to the project |

**Pando-hosted (future vision):** Node operators can opt to host web services. They earn Lux for uptime + bandwidth. Users pay Lux for hosting. This creates a true decentralized hosting market — but it requires stable node operators, SLA enforcement, and redundancy. Not for Phase 31.

#### Deployment Flow
```
User: "Deploy my portfolio to Vercel"
  │
  ▼
Manager checks:
  1. Does project have deployment config? If not → ask for it
  2. Does user have Vercel credentials contributed? If not → guide setup
  3. Spawn devops agent with deployment task
  │
  ▼
DevOps agent:
  1. Build project artifacts
  2. Run pre-deploy checks (tests, lint, security scan)
  3. Deploy to target (vercel deploy, git push, s3 sync, etc.)
  4. Verify deployment (health check on live URL)
  5. Report result to Manager → SSE to user
  │
  ▼
Project record updated:
  deployment: { type: "vercel", url: "https://...", status: "live", deployedAt: ... }
```

### Project Discovery / Marketplace

Public and listed-shared projects appear in a marketplace:

```
┌─────────────────────────────────────────────────────────────┐
│  Explore Projects                                [Search]    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Featured                                                   │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │ AI Chess     │ │ Open Weather │ │ Markdown Hub │       │
│  │ 🌐 Public    │ │ 👥 Shared    │ │ 🌐 Public    │       │
│  │ 892 users    │ │ 12 contribs  │ │ 2.4k users   │       │
│  │ ★ 4.8        │ │ ★ 4.2        │ │ ★ 4.6        │       │
│  └──────────────┘ └──────────────┘ └──────────────┘       │
│                                                             │
│  Categories                                                 │
│  [Games]  [Tools]  [APIs]  [Websites]  [Research]          │
│                                                             │
│  Recently Deployed                                         │
│  • Todo App (shared, 3 users) — deployed 2h ago            │
│  • Budget Tracker (public, 45 users) — deployed 1d ago     │
│  • Recipe Generator (private→shared) — deployed 3d ago     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Scenarios & Solutions

#### Scenario 1: "Build me a portfolio website" (Private)

```
1. User sends message to gateway
2. Manager creates project: "Portfolio Website" (private, owner=user)
3. Manager designs 5-step plan: scaffold → design → content → deploy → verify
4. Spawns builder agents, coordinates work
5. Total cost: ~45 Lux (agent compute time)
6. User: "Deploy to my Vercel" → devops agent deploys
7. Project dashboard: deployed, live URL, 0 revenue (personal site)
```

#### Scenario 2: "I have an idea to make governance proposals smarter" (Public contribution)

```
1. User sends message to gateway
2. Manager recognizes this is about Pando (public project)
3. Manager: "Great idea. Let me help you draft a governance proposal."
4. Conversation refines the idea → formal proposal drafted
5. User approves → 10 Lux stake deducted → proposal submitted
6. Phase 30 AI reviewers evaluate it
7. If approved:
   → User's contribution score increases (+8 for accepted proposal)
   → User's "Projects" page shows: "Pando Network (contributor, score: 8)"
   → Stake refunded
8. Implementation happens through normal governance → agent execution
```

#### Scenario 3: "Build a chess game, I want others to help" (Shared)

```
1. Project created: "Chess Game" (private initially)
2. User builds MVP with Pando agents: ~200 Lux
3. User: "Make this shared, I want help from others"
   → Project type changes to "shared", visibility: "listed"
4. User: "Set usage fee to 0.1 Lux per game"
   → revenueModel: "usage_fee", config: { perAction: 0.1 }
5. User: "Revenue split: 50% me, 30% contributors, 20% compute"
   → revenueConfig: { owner: 0.5, contributors: 0.3, compute: 0.15, relay: 0.05 }
6. Other users find it on marketplace → contribute improvements
7. Contributors earn proportional share of monthly revenue
8. Owner retains admin control (approve/reject contributions)
```

#### Scenario 4: "I built this AI tutor, I want to give it to the world" (Transfer to public)

```
1. User built AI Tutor as private project over months: ~2000 Lux invested
2. 500 users paying 2 Lux/month = 1000 Lux/month revenue
3. User: "Transfer ownership to the network"
   → Governance proposal auto-created
   → AI reviewers evaluate: is this valuable? Is the code safe?
   → Community votes
4. If approved:
   → Owner becomes contributor with founder bonus (2x for 2 years)
   → Revenue split: 50% contributors, 30% treasury, 15% compute, 5% relay
   → User's founder-weighted share: ~35% of contributor pool (high contribution score × 2x)
   → User earns: ~175 Lux/month (down from ~850, but project grows faster with community help)
5. Network treasury uses 300 Lux/month to fund ongoing development
6. After 2 years: founder bonus expires, user is weighted same as other contributors
7. Long-term: if project grows to 5000 Lux/month, user still earns well from contribution history
```

#### Scenario 5: Dispute — Two collaborators disagree on direction

```
1. Chess Game (shared): Contributor A wants to add gambling. Owner disagrees.
2. Contributor A submits a governance proposal to add gambling.
3. Since it's a SHARED project (not public), owner has veto power:
   → Owner rejects: "No gambling. Violates my vision for this project."
   → Contributor A can: accept it, fork the project (create their own copy), or leave
4. If it were a PUBLIC project: governance decides (owner has no veto)
   → AI reviewers evaluate: does gambling align with project goals? Legal risks?
   → Community votes. Majority wins.
   → If both sides have strong support → governance can split the project (fork)
```

#### Scenario 6: Malicious project — User builds a phishing site

```
1. User: "Build me a page that looks like Gmail login"
2. Manager's CLAUDE.md includes Law I: "Do not harm any human"
3. Manager refuses: "I can't build a page designed to impersonate another service for credential theft."
4. If it somehow gets built:
   → Other users can report it (costs 1 Lux to prevent spam reports)
   → AI reviewer evaluates the report
   → If confirmed harmful: project flagged, deployment blocked, user warned
   → Repeat offense: user reputation scored down, higher costs for future work
5. Node operators can configure content safety levels:
   → Conservative: block anything flagged
   → Moderate: block confirmed harmful
   → Permissive: allow everything legal (operators assume liability)
```

#### Scenario 7: Revenue dispute — "I built 80% but only get 20%"

```
1. Shared project: Owner set contributor split at 10%
2. Contributor built most of the features (contribution score proves it)
3. Contributor: "This isn't fair, I did most of the work"
4. Resolution options:
   a) Negotiate: Contributor asks owner to adjust split
   b) Fork: Contributor creates their own version (all their code is tracked)
   c) Governance mediation: For public projects, submit dispute to governance
   d) Leave: Contributor stops contributing. Their existing score still earns them share.
5. Key principle: Owner sets rules for shared projects. Contributors join voluntarily.
   If you don't like the terms, don't contribute. Market forces work:
   owners who underpay contributors get fewer contributors.
```

#### Scenario 8: Project goes viral — scaling economics

```
1. AI Tutor (public) goes from 100 → 100,000 users
2. Revenue: 200,000 Lux/month
3. Compute cost explodes — needs more node operators hosting it
4. Economic signal:
   → Compute share (15% = 30,000 Lux/month) attracts node operators
   → More nodes host the service → better latency, higher capacity
   → Network treasury (30% = 60,000 Lux) funds development grants
   → Contributors (50% = 100,000 Lux) split among active developers
5. Self-balancing: popular projects attract more resources AND more contributors
   because the economic incentive is directly proportional to usage.
```

#### Scenario 9: Node operator economics — "Why should I run a node?"

```
Revenue streams for node operators:
  1. Compute fees:   15% of all project revenue processed on your node
  2. Hosting fees:   Lux per GB/month for hosting projects
  3. Uptime rewards: 0.05 Lux per 10-min epoch (existing)
  4. Relay fees:     0.1% of every Lux transfer routed through you (existing)
  5. Task rewards:   5 Lux per completed agent task (existing)

Example node operator earning:
  Uptime:                    7.2 Lux/day
  Hosting 3 popular apps:   50 Lux/day
  Agent tasks:              25 Lux/day
  Relay fees:                5 Lux/day
  ─────────────────────────────
  Total:                    87.2 Lux/day

If Lux has exchange value of $0.01:  $0.87/day — not worth it yet
If Lux has exchange value of $0.10:  $8.72/day — covers a VPS
If Lux has exchange value of $1.00:  $87.20/day — real income

The network grows when Lux has enough value to justify running a node.
That value comes from real services that real people pay for.
```

### What This Does NOT Cover (Explicitly Scoped Out)

1. **Fiat on-ramp** — How users buy Lux with real money. Separate phase (exchange listing, payment gateway). Required for real users but out of scope here.
2. **Legal entity** — Who is liable if a Pando-deployed service causes harm? Decentralized networks have no legal entity. Need legal analysis.
3. **Tax reporting** — Lux earnings may be taxable. Need per-jurisdiction guidance. Out of scope.
4. **Encrypted workspaces** — Private project code running on untrusted nodes. Needs confidential computing or trust tiers. Phase 32+ territory.
5. **Project templates / starter kits** — Pre-built genome templates for common project types (Phase 26 vision covers this).
6. **Team chat** — Real-time chat between project collaborators. Could build on existing thread system.

### Dependencies

- **Phase 30 (AI Governance) — REQUIRED.** Public project contributions go through governance. Without smart governance, public projects can't function.
- **Persistent user accounts — CRITICAL BLOCKER.** Everything in Phase 31 requires users to come back tomorrow and still be the same person. This is the #1 missing piece.
- **PaymentGate — EXISTS.** Revenue splits, escrow, and staking all use existing PaymentGate infrastructure.
- **Agent system — EXISTS.** Project managers, builders, devops agents all exist.
- **Deployment capability — PARTIALLY EXISTS.** Manual deployment works. Need automated deploy-to-Vercel/GitHub/S3.

### Sub-phases

| Sub-phase | Description | Status |
|---|---|---|
| 31.0 | Persistent user accounts — scrypt auth, session tokens, 9 API routes | DONE (3c0c7d2) |
| 31.1 | Project data model — ProjectStore, SQLite, 17 methods, 5 indexes | DONE (3755639) |
| 31.2 | Conversation → project flow — AgentManager auto-persist, 8 API routes | DONE (3755639) |
| 31.3 | Project dashboard — gateway My Projects page with stats, create, detail | DONE (3755639) |
| 31.4 | Revenue engine — RevenueEngine, metering, distribution, subscriptions | DONE (538ba25) |
| 31.5 | Collaboration — invite codes (12-char hex), join-by-code, 4 API routes | DONE (538ba25) |
| 31.6 | Ownership transfer — direct/sale/network, PaymentGate escrow, 4 API routes | DONE (538ba25) |
| 31.7 | Deployment automation — project_deployments table, deploy/status routes | DONE (008ec0b) |
| 31.8 | Project marketplace — ratings, categories, search, sort, 4 API routes | DONE (008ec0b) |
| 31.9 | Contribution tracking — ContributionTracker, 10% decay, revenue shares | DONE (008ec0b) |
| 31.10 | Content safety — reports, rate limiting, admin review, resolve actions | DONE (44d20c4) |

### Implementation Estimate

| Component | Lines (est.) | Files |
|---|---|---|
| User accounts (auth, persistence, session) | ~300 | New: user-accounts.ts, auth middleware |
| Project data model + SQLite persistence | ~250 | New: project-store.ts |
| Conversation → project routing | ~150 | agent-manager.ts, api-server.ts |
| Revenue engine (metering, splits, distribution) | ~400 | New: revenue-engine.ts |
| Contribution tracking + scoring | ~200 | New: contribution-tracker.ts |
| Ownership transfer flows | ~150 | project-store.ts, governance.ts |
| Deployment automation | ~200 | New: project-deployer.ts |
| Gateway pages (dashboard, marketplace) | ~500 | gateway app/ pages |
| API routes for projects | ~200 | api-server.ts or project-tools.ts |
| **Total** | **~2350** | **8-10 new + 4-5 modified** |

This is the largest phase yet — roughly 3-4x the size of Phase 30. Recommend splitting implementation across multiple sessions with E2E testing between each sub-phase.

---

## Phase 32: S3 Hosting Service (DONE — 2026-02-22)

> **The Problem:** Projects built on Pando need to be accessible on the web. Phase 31 created the project model but had no mechanism to actually serve project files to users. Node operators need a way to deploy project sites without manual infrastructure setup.

### What It Delivers

- **HostingService** (`hosting-service.ts`) — S3 deployment, pre-signed URL generation, removal, probing
- **Public projects** served directly via S3 website endpoint (`http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/<projectId>/`)
- **Private/shared projects** served via pre-signed URLs with 1-hour TTL (direct access returns 403)
- **3 new API endpoints** in api-server.ts: `POST /projects/:id/hosting` (deploy), `GET /projects/:id/hosting` (info), `DELETE /projects/:id/hosting` (remove)
- **New type:** `DeploymentInfo` in shared/types.ts

### Dependencies Added

- `@aws-sdk/client-s3` — S3 bucket operations (PutObject, DeleteObjects, ListObjectsV2, HeadObject)
- `@aws-sdk/s3-request-presigner` — generate time-limited access URLs for private deployments

### S3 Architecture

- **Bucket:** `pando-deployments` in `us-east-1`
- **Bucket policy:** public read on `public/*` prefix only
- **Key structure:** `public/<projectId>/<path>` or `private/<projectId>/<path>`
- **Access control:** Project type determines prefix. Only owner/admin roles can deploy or remove.

### E2E Test Results (7/7 PASS)

| Test | Result |
|---|---|
| Deploy public site via API | PASS |
| Public site accessible via direct URL | PASS |
| Deploy private site | PASS |
| Private site direct access blocked (403) | PASS |
| Private site via pre-signed URL | PASS |
| GET deployment info | PASS |
| DELETE deployment (removed from S3) | PASS |

---

## Phase 33: Self-Governing Development (IN PROGRESS)

> **The Problem:** Users can chat with the manager and build websites. But if a user says "fix a bug in the node network," the manager builds the fix in an isolated workspace and nothing else happens. There's no governance gate, no pipeline to apply changes, no self-restart. The pieces exist (governance, PipelineRunner, UpgradeProtocol, watchdog) but they're disconnected. Phase 33 connects them.

### What It Delivers

A user talks to the gateway. Their request flows through the right workflow based on project type:

```
Private project (user-owned):     User → Manager → Build → Deploy → Done
Shared project (multi-user):      User → Manager → Build → Conflict check → Deploy → Notify collaborators
Public project (community):       User → Manager → Build → Project governance → Vote → Pipeline → Deploy
Node network (self-modification):  User → Manager → Build → Network governance → Vote → Pipeline → Restart
```

### Sub-phases

**33.0: Request Classification — DONE + E2E VERIFIED**
- Manager template classifies by project type via event prompt injection
- "Build me a portfolio" → private, no governance
- "Fix the ledger sync bug" → node network, governance REQUIRED
- "Update the homepage for our team project" → shared, conflict check
- Classification based on: project metadata, keywords, explicit user intent
- E2E verified: manager correctly identifies node changes and creates governance proposals

**33.1: Governance Gate — DONE + E2E VERIFIED**
- For node/public projects: manager creates governance proposal BEFORE applying changes
- Proposal includes: description of change, proposed approach
- Manager tells user: "Fix proposed, pending governance vote"
- **Auto-vote on own proposals:** proposer node automatically votes approve (normal behavior, real check comes from other nodes)
- **Early resolution for single-node:** when all nodes have voted, proposal resolves immediately (no waiting for 24h timeout)
- On single-node networks: auto-approves (minimum quorum = 1). This is accepted as ceremonial for dev; real security requires multi-node. See `genome/rules/governance-tiers.md`.

**33.2: Pipeline Trigger — DONE**
- Endpoint: `POST /pipeline/run` — triggers PipelineRunner with workspace dir
- On governance approval: bridge event → manager → triggers pipeline
- Pipeline: extract diff → backup → apply to real codebase → build → QA → commit
- On success: manager notifies user with commit hash

**33.3: Guardrails Governance Bypass — DONE (85908ab)**
- `tieredPreCheck()` accepts `governanceApproved` param. When true, bypasses: `requiresApproval`, rate limits, cooldowns. NEVER bypasses: immutable kernel (Two Laws).

**33.4: Full Autonomous Pipeline — DONE + E2E VERIFIED (0a6bcba)**
- **The complete self-upgrading loop works autonomously:** User message → manager classifies → builds fix → governance proposal → auto-vote → instant quorum (<10 nodes) → PASSED → pipeline triggered → git diff extracts changes → guardrails pass (governance bypass) → commit → restart.
- **Pipeline commit 0a6bcba:** `[pipeline] Extracted 1 change(s) from git diff` — first fully autonomous pipeline commit. Manager applied `nodeStartedAt` to /health, pipeline found it via git diff and committed without human intervention.
- **Fixes applied this session:**
  - Router dev keyword guard: messages with development keywords (add/fix/improve/change/etc.) always route to manager, not quick-response
  - Governance speed: API default 5min, standard 1h, meta-governance 24h, emergency 30min
  - Instant governance: <10 nodes = quorum of 1, any single vote resolves instantly
  - Pipeline git diff mode: governance runs use `extractGitDiff()` directly (bypasses polluted workspace)
  - Pipeline governance bypass in `applyPatch()`: passes `governanceApproved` to guardrails
  - Pipeline false success fix: 0 changes = `success: false` (no false restart)
  - ESM import fix: `extractGitDiff()` used `require()` in ESM context
  - Auto-restart via `process.exit(0)` after successful governance pipeline (needs PM2 for actual restart)

**33.5: Multi-User Conflict Detection — BUILD**
- project-state.md tracks in-flight work per project
- Before starting: manager checks for active changes by other users
- If conflict: queue the request, notify both users
- For shared projects: manager mediates. For public: governance vote on approach

**33.6: Attribution & History — BUILD**
- Track who proposed each change (userId, agentId)
- Record governance vote results in project history
- Pipeline outcomes visible in project page
- Contribution attribution for all collaborators

**33.7: Project-Level Governance (Two-Tier) — PLANNED**
- **Network governance** (exists): node software changes, all nodes vote. Already works.
- **Project governance** (new): project-specific changes, only stakeholders vote.
- Public projects get their own governance scope: only collaborators/contributors vote, not the entire network.
- Private/shared projects: owner decides (no governance needed).
- Classification rules: manager decides which tier based on project type and change scope.
- See `genome/rules/governance-tiers.md` for full architecture.

**33.8: Cross-Node Project Membership — PLANNED**
- Collaborators on different nodes need to receive proposals and vote for projects they are part of.
- Project membership must propagate via GossipSub so remote nodes know which projects their users participate in.
- Vote routing: when a project governance proposal is created, it must reach all collaborator nodes (not just all nodes).

**33.9: Cross-Node Code Distribution — DONE (Phase 82)**
- Governance approves → proposer broadcasts commit hash via GossipSub → all peers `git pull` + verify hash + build + restart.
- Uses git-based distribution (all nodes pull from shared repo `pando-lux/pando`).
- Orphan-branch push means hashes differ between local and public repo — hash verification is soft (warning, not blocker). Core security is governance approval.

**33.10: Multi-Node E2E Testing — PLANNED**
- Test the full self-governing flow on the 3-node network (Lightsail + Windows + Mac).
- Scenarios: node change proposal on one node → reviewer spawned on another → votes from all three → pipeline applies on proposing node → other nodes pull update.
- Validates: cross-node proposal flow, reviewer independence (different nodes = different AI instances), code distribution, rollback coordination.

### What Already Exists (reuse, don't rebuild)

| Component | Status | What Phase 33 adds |
|---|---|---|
| GovernanceSync | WORKING | Manager creates proposals via curl — DONE (33.1) |
| governance_decision bridge event | WIRED | Manager handles approval → triggers pipeline — DONE (33.1) |
| PipelineRunner (7 stages) | WORKING | POST /pipeline/run endpoint — DONE (33.2) |
| UpgradeProtocol | WORKING | Integrated with pipeline for node changes |
| Phase 29 watchdog | WORKING | Triggered after node-level pipeline (33.3) |
| Project model (types) | WORKING | Classification logic in manager template — DONE (33.0) |
| FileRegistry | WORKING | Conflict detection for concurrent edits (33.4) |
| PaymentGate | WORKING | Stake for governance proposals |
| Auto-vote + early resolution | NEW | Proposer auto-votes, single-node resolves instantly — DONE |
| Guardrails governance bypass | NEW | tieredPreCheck recognizes governance approval — DONE (33.3) |

### Key Design Decisions

- **Manager decides, not infrastructure.** The manager classifies requests and routes them. No hardcoded "if project == public then governance."
- **Governance is the gate, pipeline is the executor.** Governance says yes/no. Pipeline applies the change. Clean separation.
- **Same manager, different workflows.** The pando-node-mgr handles BOTH user project builds AND node self-modification. The template teaches it to pick the right workflow.
- **Event prompt injection for reliability.** Critical classification rules go in event prompts, not just CLAUDE.md, to survive context compression.
- **Two-tier governance.** Network-level (all nodes vote on node changes) vs project-level (only stakeholders vote on project changes). See `genome/rules/governance-tiers.md`.
- **Single-node governance is ceremonial.** On a single-node network, the proposer auto-approves its own proposals. This is accepted for development. Real security requires multi-node where different nodes run independent AI reviewers. See ADR in `genome/history/decisions.md`.
- **Reviewer independence requires different nodes.** On the same node, a reviewer agent uses the same Claude Code model and context as the proposer. True independent review only comes from reviewer agents spawned on different physical nodes. This is by design, not a bug.

### Success Criteria

- [x] User says "fix a bug in the node" → governance proposal created (33.0 + 33.1)
- [x] Governance approved → changes applied → build succeeds (33.3)
- [x] **Full autonomous loop: user message → governance → pipeline → git diff → commit → restart (33.4) — E2E VERIFIED (0a6bcba)**
- [x] User says "build me a website" → no governance, direct build + deploy (existing flow works)
- [ ] Two users modify the same shared project → conflict detected → orderly resolution (33.5)
- [ ] All changes attributed to the proposing user in project history (33.6)
- [ ] Public project governance: only collaborators vote (33.7)
- [ ] Cross-node proposal → reviewer on different node → vote → pipeline (33.10)

### Known Gaps & Security Considerations

1. **Single-node = no real review.** Proposer, voter, and reviewer are all the same AI on the same machine. Accepted for dev. Flagged clearly.
2. **Cross-node code distribution.** After approval, only the proposing node applies changes. Other nodes need `git pull` or equivalent. UpgradeProtocol has the stages but assumes shared git repo.
3. **Rollback notification.** PipelineRunner can rollback, but the network is not notified. Other nodes might have already pulled the bad code.
4. **Project governance scope.** No mechanism to restrict a governance vote to project stakeholders only. All proposals go to all nodes.

## Phase 35: Guest Lux Faucet + Reclamation (DONE — 2026-02-22)

> Random guests can sign up and immediately use AI services. No node required.

- **Guest welcome grant:** New `WorkType.GUEST_WELCOME` in shared/types.ts (25 Lux base × early multiplier). Minted on `POST /auth/guest` via EmissionWitness.
- **Reclamation:** `reclaimExpiredGuests()` in user-accounts.ts. Unclaimed guest accounts older than 30 days → remaining Lux transferred to NETWORK account → guest identity deleted. Runs daily via timer + 60s startup catch-up in index.ts.
- **Gateway UX:** Chat page changed from blocking "Claim your account to use AI chat" warning to welcoming "You have free Lux — claim your account to keep it permanently."
- **Economics:** NETWORK account acts as treasury. Reclaimed Lux funds future network operations (AI costs, resource purchases) as the network grows. No Lux is ever "wasted" — it circulates back.

---

## Phase 36: Guest Account Security Hardening (DONE — addressed by Phase 40)

> **Problem:** Guest private keys were encrypted with a node-level `guest-secret` file. Node operators could decrypt and impersonate any unclaimed guest.
>
> **Resolution:** Phase 40 (Signature-Based Auth) moved Ed25519 keypair generation to the browser (`gateway/lib/crypto.ts`). Keys are generated client-side, stored in localStorage, and never sent to the node. The node only receives the public key. The `guest-secret` server-side encryption is no longer the security model -- browser-side keys are the primary path.

- [x] **36.0:** Client-side key generation — Ed25519 keypair generated in browser via `@noble/curves` (gateway/lib/crypto.ts `generateKeyPair()`). Node receives only public key.
- [x] **36.1:** Claim = re-encrypt with password — PBKDF2+AES-256-GCM encryption of private key with user's password (gateway/lib/crypto.ts `encryptPrivateKeyWithPassword()`).
- [ ] **36.2:** Migration path — existing guests on nodes using server-side `guest-secret` not yet offered one-time key rotation.
- [ ] **36.3:** Remove `guest-secret` file entirely — legacy code still present for backwards compatibility.

---

## Phase 37: Hosting Resilience (PLANNED)

> **Problem:** Deployed websites live on a single S3 bucket with no redundancy. If the AWS account is compromised, all user content is lost. ContentRegistry has `hostingNodes` field but it's never used for failover.

- **37.0:** S3 versioning + lifecycle — enable versioning on `pando-deployments` bucket, 30-day retention for deleted objects.
- **37.1:** Multi-region backup — replicate to a second S3 bucket in a different region (cross-region replication or daily sync).
- **37.2:** Multi-node hosting — use ContentRegistry `hostingNodes` field to track which nodes host which content. At least 2 nodes must have a copy before deployment is considered "live."
- **37.3:** Hosting failover — if primary hosting node goes down, ContentRegistry routes to backup node automatically.
- **37.4:** User-controlled backups — users can download a zip of their deployed project via gateway.

**Risk if skipped:** Single point of failure for all deployed content. One AWS credential leak = all user websites gone. Severity: HIGH at scale.

---

## Phase 38: Public Node AI Access (DONE)

> Lightsail has `--scheduler` + Claude Code (Max subscription, enabled 2026-02-20). Public gateway can run AI chat. Service catalog page built.

- [x] **38.0:** Enable `--scheduler` on Lightsail — Claude Code installed + authed via Max subscription (2026-02-20). AI chat works for guest visitors.
- [ ] **38.1:** Cost controls for public-facing AI — rate limits per guest session (e.g., 5 messages/hour for unclaimed guests, 20/hour for claimed), budget cap per day for public node AI spend. (Deferred)
- [x] **38.2:** Service catalog page — `/services` gateway page with 5 service cards (AI Chat, Project Building, AI Search, Storage & Hosting, Governance), live status from `/api/status` + `/api/capacity`, "How to Pay" section, provider earnings section. NavBar "Services" link.
- [ ] **38.3:** Multi-node AI routing — already partially addressed by Phase 45 (gateway prefers Claude-capable nodes, P2P fallback). Full ResourceRouter integration deferred.

---

## Phase 39: Lux Acquisition for Non-Operators (PLANNED)

> **Problem:** Users who don't run nodes can't get more Lux after the welcome grant runs out. No fiat on-ramp, no exchange, no gifting mechanism.

- **39.0:** Lux gifting — any user can send Lux to any other user via gateway UI. Simple transfer page.
- **39.1:** Referral rewards — invite a friend, both get bonus Lux (e.g., 10 Lux each). Anti-abuse: max 5 referrals per account.
- **39.2:** Contribution rewards — non-operator contributions (bug reports, docs, translations, design) earn Lux via governance proposals.
- **39.3:** Manual on-ramp — founder/operators can sell Lux for fiat (manual, off-chain). Just needs a "Buy Lux" page pointing to contact.
- **39.4:** Exchange listing (LONG TERM) — Lux traded on a DEX or CEX. Requires legal review, real liquidity, market demand.

**Risk if skipped:** Guests exhaust free Lux, can't get more, leave. Network loses users. Severity: HIGH for retention.

---

## Phase 40: Signature-Based Auth — Any-Node Login (DONE — 2026-02-22)

> **Problem:** Users are locked to the node that created their session token. If that node goes down, they lose access. Gateway hardcodes `PANDO_NODE_URL`. This is the single biggest blocker to multi-node UX.

**Core idea:** Replace session tokens with Ed25519 challenge-response signatures. Any node can verify a user because all nodes have the synced ledger (which contains every user's public key).

### How it works

1. **Client sends:** `POST /auth/challenge` with `{ peerId: "12D3Koo..." }` to ANY node
2. **Node responds:** `{ challenge: <random 32-byte nonce>, expiresAt: <timestamp> }`
3. **Client signs:** `Ed25519.sign(challenge, privateKey)` — private key lives ONLY in the browser (localStorage or IndexedDB)
4. **Client sends:** `POST /auth/verify` with `{ peerId, challenge, signature }`
5. **Node verifies:** Look up peerId in synced ledger → get public key → `Ed25519.verify(signature, challenge, publicKey)` → success = authenticated
6. **Node issues:** Short-lived bearer token (15-minute TTL, auto-refresh) for subsequent requests in this session

### Why this unlocks multi-node

- **No node-local state required.** Any node with a synced ledger can verify any user. Users can switch nodes freely.
- **Token refresh is cheap.** 15-minute tokens are just convenience cache. The real auth is the signature.
- **Works offline-first.** Client stores private key locally. No server round-trip needed to "log in" — only to prove identity to a specific node.
- **Guest accounts still work.** Guests get an auto-generated keypair in the browser. When they claim, they set a password that encrypts the key. No change to the guest flow.

### Subtasks

- **40.0:** Add `POST /auth/challenge` and `POST /auth/verify` endpoints to api-server.ts. Challenge store with 60-second TTL and one-time use.
- **40.1:** Browser-side key storage — store Ed25519 private key in IndexedDB (encrypted with Web Crypto API). Existing guest flow: generate keypair in browser, send only public key to node.
- **40.2:** Gateway AuthContext rewrite — replace X-User-Token session flow with challenge-response. Token refresh on 401.
- **40.3:** Remove node-local session dependency — `session.json` becomes optional (only for TUI operator). Gateway users never need it.
- **40.4:** Test: start two nodes, create account on node A, authenticate to node B, verify balance and threads visible on both.

### Files to modify

- `packages/node/src/api-server.ts` — new auth endpoints
- `packages/gateway/lib/auth-context.tsx` — signature-based auth flow
- `packages/gateway/lib/crypto.ts` — NEW: browser-side Ed25519 + key storage
- `packages/shared/src/crypto.ts` — shared verify function (already exists, may need export)
- `packages/node/src/user-accounts.ts` — unified identity, sessions, MongoDB-aware auth

**Dependency:** None. Can start immediately. Unlocks Phases 41-44.

**Risk if skipped:** Every user is a hostage of one node. Node goes down = user loses everything. Severity: CRITICAL for real P2P.

---

## Phase 41: Client-Side End-to-End Encrypted Chat (DONE)

> **Problem:** Chat messages are stored in plaintext on the node. Node operators can read every user's private conversations. This is unacceptable for untrusted node operators.

**Core idea:** Messages encrypted in the browser BEFORE they touch any node. Nodes store only encrypted blobs. Even the node operator can't read them.

### Cryptographic design

1. **Key derivation:** Each user's Ed25519 signing key is converted to an X25519 key using `ed2curve` (proven, audited conversion). This gives every user an encryption keypair for free — no extra keys to manage.
2. **1:1 chat (DM):**
   - Sender derives shared secret: `X25519(senderPrivate, recipientPublic)` → 32-byte shared key
   - Sender encrypts: `AES-256-GCM(sharedKey, nonce, plaintext)` → ciphertext + nonce + tag
   - Recipient derives SAME shared secret: `X25519(recipientPrivate, senderPublic)` → identical 32-byte key
   - Recipient decrypts. Node never sees plaintext.
3. **Group chat (project threads):**
   - Thread creator generates a random 256-bit `groupKey`
   - `groupKey` is encrypted separately for each participant: `AES-256-GCM(sharedKeyWithParticipant, groupKey)`
   - Each participant gets their own encrypted copy of `groupKey`
   - Messages encrypted with `groupKey`. Adding a member = encrypt `groupKey` for them.
   - Removing a member = rotate `groupKey`, re-encrypt for remaining members.
4. **AI messages:** Manager/worker responses are encrypted with the project's `groupKey` before storage. The agent has access to the key during its session (passed in the event prompt). After the session, the key is discarded from agent memory.

### What nodes store

```
ThreadMessage {
  id: string;
  threadId: string;
  senderPeerId: string;        // visible (needed for routing)
  timestamp: number;            // visible (needed for ordering)
  encryptedContent: string;     // base64 ciphertext — OPAQUE to node
  nonce: string;                // base64 nonce
  recipientKeys?: Record<string, string>;  // peerId → encrypted groupKey (for group chats)
}
```

Node operators see: who sent a message, when, to which thread. They CANNOT see: what the message says.

### Subtasks

- **41.0:** `ed2curve` integration — browser-side X25519 key derivation from Ed25519. Add to `packages/gateway/lib/crypto.ts`.
- **41.1:** 1:1 encryption — encrypt/decrypt messages in ChatPage before send/after receive. Node stores only ciphertext.
- **41.2:** Group key management — thread creation generates `groupKey`, encrypts for all participants, stores encrypted copies.
- **41.3:** AI agent key passing — when manager processes a thread message, the encrypted `groupKey` is temporarily decrypted and passed to the agent. Agent encrypts its response before posting back.
- **41.4:** Migration — existing plaintext messages get a `legacy: true` flag. New messages are encrypted. Old messages displayed with a "sent before encryption was enabled" notice.
- **41.5:** Key rotation — when a member is removed from a thread, rotate `groupKey` and re-encrypt for remaining members.

### Files to modify

- `packages/gateway/lib/crypto.ts` — X25519, AES-256-GCM encrypt/decrypt
- `packages/gateway/app/chat/page.tsx` — encrypt before send, decrypt after receive
- `packages/node/src/thread-store.ts` — store encrypted content field
- `packages/shared/src/types.ts` — ThreadMessage type update
- `packages/node/src/agent-manager.ts` — pass decrypted group key to agent session

**Dependency:** Phase 40 (signature-based auth establishes browser-side key storage).

**Risk if skipped:** Any node operator can read all user conversations. Severity: CRITICAL for privacy.

---

## Phase 42: Storage Backend — Nodes Are Stateless, Data Lives on the Internet (DONE)

> **Problem:** User data (chat history, project files, agent state) lives on the single node the user is connected to. Node goes down = data lost. User switches device = data gone. Node operators accumulate everyone's conversations on disk. This doesn't scale and doesn't survive.

**Core idea:** Nodes are stateless compute proxies. User data lives on internet infrastructure (MongoDB, S3, etc.) — encrypted, durable, accessible from any device via any node. Resource providers contribute storage credentials. The network coordinates; the internet stores.

This aligns with our P2P-First rule: P2P is for the brain (identity, economy, governance). Storage is part of the body (internet infrastructure).

### Architecture

```
User (any device, any node)
    │
    │  Ed25519 signature auth (Phase 40)
    │  AES-256-GCM encryption (Phase 41)
    │
    ▼
Any Pando Node (stateless compute proxy)
    │  decrypt → process → re-encrypt
    │  node keeps NOTHING after request completes
    │  node-local files are ephemeral cache only
    │
    ▼
StorageBackend (pluggable, internet infrastructure)
    ├── MongoDB Atlas — threads, messages, user metadata (structured data)
    ├── AWS S3 — project files, deployments, large blobs (unstructured data)
    ├── Local filesystem — fallback for single-operator dev mode
    └── Future: user-provided storage, peer-donated storage
```

### What stays on the node (P2P state — the brain)

These are P2P-synced and MUST remain on nodes:
- **Identity keys** — `~/.pando/identities/` (Ed25519, encrypted at rest)
- **Ledger** — `~/.pando/ledger.db` (accounts, balances, transactions — synced via GossipSub)
- **Governance** — proposals, votes, decisions (synced via GossipSub)
- **Reputation** — peer trust scores (broadcast + aggregated)
- **Capabilities** — what each node can do (broadcast for routing)
- **Node config** — api-keys.json, api-token, guardrails.json

### What moves to internet storage (user data — the body)

These MUST NOT accumulate on nodes:
- **Chat threads + messages** — MongoDB (structured, indexed, queryable)
- **Project files + deployments** — S3 (blobs, large files, static hosting)
- **Agent workspaces** — ephemeral during execution, results go to MongoDB/S3, workspace deleted after
- **User account data** — MongoDB (replaces node-local `accounts.db`)

### StorageBackend interface

```typescript
interface StorageBackend {
  // Structured data (threads, messages, user accounts, project metadata)
  putRecord(collection: string, key: string, data: Record<string, any>): Promise<void>
  getRecord(collection: string, key: string): Promise<Record<string, any> | null>
  queryRecords(collection: string, filter: Record<string, any>): Promise<Record<string, any>[]>
  deleteRecord(collection: string, key: string): Promise<void>

  // Blob data (project files, large content, deployments)
  putBlob(key: string, data: Uint8Array, metadata?: Record<string, string>): Promise<void>
  getBlob(key: string): Promise<Uint8Array | null>
  deleteBlob(key: string): Promise<void>
  listBlobs(prefix: string): Promise<string[]>
}
```

Single implementation (Phase 57: LocalStorageBackend deleted, S3StorageBackend never built):
1. **MongoStorageBackend** — MongoDB Atlas for structured data. Required for user data. Nodes without it return 503 for user data endpoints.

### Storage providers can't read data

All data is AES-256-GCM encrypted before it touches any storage backend (Phase 41). Providers see only:
- Encrypted blobs with opaque keys
- Blob sizes and timestamps
- Collection names (e.g. "threads", "messages") but not content

They CANNOT: read messages, correlate users to conversations, modify data without detection.

### Multi-device login

With storage on MongoDB instead of node-local files:
1. User logs in from new device → Ed25519 signature auth (Phase 40) → any node
2. Node queries MongoDB for user's threads → returns encrypted thread list
3. Browser decrypts thread keys from localStorage (or re-derives from private key)
4. User sees all their conversations, regardless of which node or device

**Key recovery:** If user loses their browser (and thus localStorage with thread keys), they need their Ed25519 private key to re-derive thread keys. This is the "seed phrase" equivalent. Future: encrypted key backup to user's own cloud.

### Node configuration

```bash
# MongoDB (--storage deprecated in Phase 54, will be auto-discovered from ResourceRegistry)
node packages/node/dist/cli.js --storage mongodb+srv://user:pass@cluster.mongodb.net/pando

# No --storage: node starts without user data storage (user data endpoints return 503)
node packages/node/dist/cli.js
```

Environment variable also works: `PANDO_STORAGE_URL`. **Note:** `--storage local`, `--storage s3://...`, and `--blob-storage` are no longer supported (Phase 57 — only MongoDB URLs accepted).

### Migration

> **Phase 57:** LocalStorageBackend deleted. There is no local-to-MongoDB migration path.
> Nodes without `--storage` simply have no user data storage (503 on user data endpoints).

### Subtasks (all DONE)

- **42.0:** `StorageBackend` interface (LocalStorageBackend deleted in Phase 57)
- **42.1:** `MongoStorageBackend` — MongoDB driver, connection pooling, retry logic.
- **42.3:** Rewire `ThreadStore` — uses StorageBackend only (no filesystem, Phase 57).
- **42.4:** Rewire `UserAccounts` — moved to P2P ledger (Phase 56). No longer uses StorageBackend.
- **42.6:** Node config — `--storage` CLI flag (deprecated Phase 54, will be auto-discovered from ResourceRegistry).

> **Note:** 42.2 (S3StorageBackend), 42.5 (agent workspace storage), 42.7 (migration tool), 42.8 (gateway storage UI) were never built or superseded by later phases.

### Key files

- `packages/node/src/storage-backend.ts` — StorageBackend interface only (LocalStorageBackend deleted Phase 57)
- `packages/node/src/mongo-backend.ts` — MongoStorageBackend
- `packages/node/src/thread-store.ts` — MongoDB-only (Phase 57)
- `packages/node/src/index.ts` — initialize StorageBackend from config

**Dependency:** Phase 41 (data must be encrypted before storing on untrusted infrastructure).

**Status:** DONE + E2E VERIFIED. MongoDB Atlas connected, 6/6 encrypted messages stored, atomic `pushToArray` for race-free writes. `--storage mongodb+srv://...` CLI flag works. `/status` shows `storageBackend: "mongodb"`.

---

## Phase 42.5: Resource Registry — Network-Level Shared Resources (DONE)

> **Problem:** Resources (API keys, MongoDB credentials, S3 buckets, cloud accounts) are node-local configuration files. Every node must be manually configured. 100 nodes = 100 manual configs. Non-operators can't contribute resources. Credentials stored in plaintext. No metering, no Lux rewards for resource providers.

**Core idea:** Resources are NETWORK resources, not node-local config. Anyone — node operator or regular user — registers resources with the network. The network encrypts, stores, and distributes credentials. Nodes discover and use resources automatically. Providers earn Lux for usage.

### What changes

| Before (node-local) | After (network-level) |
|---|---|
| `~/.pando/api-keys.json` (plaintext) | ResourceRegistry (encrypted, P2P replicated) |
| `--storage mongodb+srv://...` (CLI flag) | Auto-discovered from network |
| Manual per-node configuration | Nodes query network for available resources |
| Only node operators can contribute | Anyone can contribute via gateway |
| No usage metering for external resources | ResourceMeter tracks every API call, DB query, storage op |
| No Lux rewards for resource providers | Providers earn Lux per usage unit |

### Architecture

```
Resource Provider (anyone)
  │  Registers via gateway or TUI
  │  Credential encrypted with provider's Ed25519 key
  ▼
ResourceRegistry (P2P state — synced via GossipSub)
  │  ResourceRecord: type, provider, encrypted credential,
  │  usage limits, pricing, expiration, status
  ▼
Any Pando Node (auto-discovers resources)
  │  Needs storage? Query registry for 'storage_db' resources
  │  Gets credential, uses it, meters usage, discards
  ▼
Provider earns Lux (via emission witness)
```

### Resource types

| Type | Example | Lux Rate |
|---|---|---|
| `ai_api_key` | OpenAI/Anthropic/Gemini key | 2x API cost |
| `storage_db` | MongoDB Atlas connection string | Per-GB-hour |
| `storage_blob` | S3 bucket + credentials | Per-GB-hour |
| `cloud_compute` | AWS instance SSH access | Per-compute-minute |
| `hosting_platform` | Vercel/Netlify deploy token | Per-deployment |

### What gets deleted (legacy)

- `~/.pando/api-keys.json` — replaced by encrypted ResourceRegistry
- `--storage` CLI flag — replaced by auto-discovery (kept as override for dev)
- `search()` method loading keys from JSON — replaced by ResourceRouter query
- All plaintext credential storage patterns

### Subtasks

- **42.5.0:** ResourceRegistry class — P2P replicated store for ResourceRecords, GossipSub sync on `pando/resources` topic, encrypted credential storage
- **42.5.1:** Credential encryption — encrypt/decrypt credentials using provider's Ed25519 key + access grants (who can decrypt)
- **42.5.2:** Resource contribution API — `POST /resources/contribute`, `POST /resources/:id/revoke`, `GET /resources/available`
- **42.5.3:** Auto-discovery — ResourceRouter queries ResourceRegistry instead of local config. Nodes automatically find storage, API keys, etc.
- **42.5.4:** Usage metering — extend ResourceMeter to track external resource usage (DB queries, API calls, storage ops). Wire to emission witness.
- **42.5.5:** Gateway resources page — contribute, view, revoke resources. See network resource inventory.
- **42.5.6:** Delete legacy — remove `api-keys.json` loading, remove plaintext credential patterns, remove `--storage` as required flag (becomes optional override)

### Files to create/modify

- `packages/node/src/resource-registry.ts` — NEW: P2P resource registry
- `packages/node/src/credential-vault.ts` — NEW: encrypt/decrypt credentials
- `packages/node/src/resource-router.ts` — MODIFY: query registry instead of local config
- `packages/node/src/resource-meter.ts` — MODIFY: meter external resource usage
- `packages/node/src/api-server.ts` — MODIFY: resource contribution endpoints
- `packages/node/src/index.ts` — MODIFY: auto-discover resources on startup
- `packages/gateway/app/resources/page.tsx` — NEW: resource contribution UI

**Status:** DONE + E2E VERIFIED. All subtasks (42.5.0-42.5.6) complete. Gateway contribute/revoke tested via Playwright. Crypto roundtrip verified. New files: `credential-vault.ts`, `resource-registry.ts`, `gateway/app/resources/page.tsx`, 3 gateway proxy routes. Modified: `index.ts` (search rewrite + auto-discover), `api-server.ts` (5 routes), `types.ts`, `capability-detector.ts`, `cli.ts`, `NavBar.tsx`. Deleted: `api-keys.json` loading from `search()`. See `genome/components/resource-registry.md` for full docs.

---

## Phase 43: Gateway Multi-Node Discovery + Failover (PLANNED)

> **Problem:** Gateway has a hardcoded `PANDO_NODE_URL` pointing to one node. If that node goes down, gateway is useless. 50 users can't all hit one node.

**Core idea:** Gateway discovers multiple nodes, authenticates to any of them (Phase 40), and routes requests to the best available one with automatic failover.

### How it works

1. **Bootstrap node list:** Gateway ships with a list of known public nodes (like DNS seeds in Bitcoin). Initially: `[lightsail, ec2, mac, windows]`. In production: maintained by governance.
2. **Node discovery:** On load, gateway pings all bootstrap nodes for `/status`. Builds a live list of reachable nodes with latency + capabilities.
3. **Smart routing:**
   - Simple queries (balance, status) → nearest healthy node
   - AI chat → node with `--scheduler` enabled and lowest load
   - Data reads (threads, messages) → any node (all nodes read from same MongoDB/S3 backend)
   - Writes (thread creation, transfers) → any node (ledger syncs via GossipSub, user data goes to shared storage)
4. **Automatic failover:** If a request fails (timeout, 5xx), retry on next-best node. Remove failed node from active list for 5 minutes.
5. **No gateway-side state:** Gateway is stateless. Auth is signature-based (Phase 40). Any gateway instance can serve any user talking to any node. Vercel can run 100 instances.

### Load distribution

With N nodes and M users:
- Simple queries: round-robin across all healthy nodes
- AI workload: weighted by node capability (nodes with GPU/Claude Code get more AI tasks)
- Storage: all nodes share the same backend (Phase 42), so any node can serve any user's data

### Subtasks

- **43.0:** Bootstrap node list — hardcoded initial list + governance-updatable list in ledger.
- **43.1:** Node health checker — gateway-side: ping all nodes on load, build live status map, refresh every 60s.
- **43.2:** Smart request router — replace single `getNodeUrl()` with `getBestNode(requestType)`.
- **43.3:** Failover logic — retry on next node on timeout/5xx, circuit breaker per node.
- **43.4:** Gateway SSE multi-source — subscribe to SSE from multiple nodes, deduplicate events.
- **43.5:** Test: kill primary node mid-session, verify gateway seamlessly switches to backup node within 5s.

### Files to modify

- `packages/gateway/lib/node-connection.ts` — rewrite: multi-node discovery + routing
- `packages/gateway/lib/node-health.ts` — NEW: health checker, latency tracking, circuit breaker
- `packages/gateway/lib/use-sse.ts` — multi-source SSE with dedup
- `packages/gateway/app/api/` — all proxy routes use `getBestNode()` instead of `getNodeUrl()`

**Dependency:** Phase 40 (signature-based auth — without it, users can only talk to the node that created their session).

**Risk if skipped:** Single point of failure. One node down = entire network unreachable for its users. Defeats the purpose of P2P. Severity: CRITICAL.

---

## Phase 44: Data Residency — Move All User Data to MongoDB (DONE)

> **Problem:** Phase 42 made nodes "stateless for user data" — but only for threads and user accounts. Projects, revenue, and contributions are still trapped in SQLite. If a node dies, project data dies with it. If a user connects to a different node, they can't see their projects. 2-user QA testing fails because users on different nodes can't see each other's work.

**Core idea:** Apply the same MongoDB-primary pattern from ThreadStore to all remaining user data stores: ProjectStore (7 tables), RevenueEngine (3 tables), ContributionTracker (2 tables). 12 new MongoDB collections total. (Phase 57 upgraded from dual-write to MongoDB-primary with SQLite cache.)

### The Three Buckets Rule

Every piece of data belongs to exactly one bucket. See `genome/rules/data-residency.md` for the complete rule.

| Bucket | Where | Survives Node Death? |
|---|---|---|
| User Data | MongoDB (StorageBackend) | Yes |
| Network State | SQLite + P2P GossipSub | Yes (rebuilds from peers) |
| Operational | Local SQLite/filesystem | No (disposable) |

### What Migrates

| Store | Collections | Methods |
|---|---|---|
| ProjectStore | `projects`, `project_collaborators`, `project_invites`, `project_transfers`, `project_deployments`, `project_ratings`, `content_reports` | ~20 async variants + 7 record helpers |
| RevenueEngine | `project_revenue`, `revenue_distributions`, `project_subscriptions` | ~8 async variants + 3 record helpers |
| ContributionTracker | `project_contributions`, `contribution_scores` | ~7 async variants + 2 record helpers |

### What Stays on SQLite/P2P

Lux transfers (ledger), governance (proposals/votes), capabilities, reputation — all Network State, synced via GossipSub.

### Subtasks (all DONE — upgraded to MongoDB-primary in Phase 57)

- **44.1:** ProjectStore MongoDB migration (~400 lines)
- **44.2:** ContributionTracker MongoDB migration (~100 lines)
- **44.3:** RevenueEngine MongoDB migration (~150 lines)
- **44.4:** MongoDB indexes for 12 new collections (~50 lines in mongo-backend.ts)
- **44.5:** Initialization wiring in index.ts (~15 lines)
- **44.6:** API route sync→async updates in api-server.ts (~200 lines, ~26 routes)

### Files Modified

| File | Action | Scope |
|---|---|---|
| `genome/rules/data-residency.md` | NEW | Three Buckets rule |
| `genome/components/storage-backend.md` | EDIT | 12 new collections |
| `genome/components/project-store.md` | EDIT | MongoDB-primary docs |
| `packages/node/src/project-store.ts` | EDIT | MongoDB-primary + async methods |
| `packages/node/src/revenue-engine.ts` | EDIT | MongoDB-primary + async methods |
| `packages/node/src/contribution-tracker.ts` | EDIT | MongoDB-primary + async methods |
| `packages/node/src/mongo-backend.ts` | EDIT | Indexes for 12 collections |
| `packages/node/src/index.ts` | EDIT | Pass storageBackend to stores |
| `packages/node/src/api-server.ts` | EDIT | sync→async route handlers |

**Dependency:** Phase 42 (StorageBackend interface), Phase 43 (multi-node gateway).

**Risk if skipped:** Users on different nodes can't see each other's projects. Node death = project data loss. 2-user QA testing impossible. Severity: CRITICAL.

---

## Phase 45: Operator Experience — Chat Routing, Resource Management (DONE)

> **Problem:** Three gaps found during 2-user QA testing: (1) Gateway chat routes to ANY node, even ones without Claude Code — users get "no AI capabilities" error. (2) Non-Claude nodes return dead-end error instead of forwarding to capable peers. (3) TUI has no resource management — operators can't view/contribute/revoke resources from the terminal.

### What was built

**45.0: Gateway chat routing fix.** Changed `getNodeUrl()` → `getNodeUrl('claude')` in 2 gateway chat route files. NodePool already had `getBestNodeUrl('claude')` which filters by `hasClaudeCode === true`. Falls back to any healthy node if no Claude node available.

**45.1: Node P2P chat fallback.** New `forwardChatToPeer()` method in api-server.ts. When `hasClaudeCodeAuth()` is false, looks up peers with `claudeCode: true` in CapabilityRegistry, tries up to 3 peers via HTTP POST (120s timeout), forwards auth headers. If all fail: "No AI-capable nodes available on the network."

**45.2: TUI resource management.** Three new commands:
- `/resources` (`/r`) — list own resources (masked values) + network summary (grouped by type with provider count)
- `/contribute <type> <value>` — register resource via ResourceRegistry. Types: `ai_api_key`, `storage_db`, `storage_blob`, `cloud_compute`, `hosting_platform`
- `/revoke <id>` — revoke own resource

### Files modified

| File | Change |
|---|---|
| `packages/gateway/app/api/chat/message/route.ts` | `getNodeUrl()` → `getNodeUrl('claude')` |
| `packages/gateway/app/api/chat/threads/[id]/message/route.ts` | Same |
| `packages/node/src/api-server.ts` | `forwardChatToPeer()` + 2 call sites |
| `packages/node/src/tui.ts` | 3 commands + 3 handlers (~120 lines) |

### E2E verified

13/13 Playwright tests pass: resources page (heading, stats, contribute form, network list, no crash) + chat page (heading, input, send, quick actions, type message, send message, response received, sidebar).

---

## Phase 48: Unified Identity — One Account Everywhere (DONE)

> **Problem solved:** TUI identities and gateway identities were completely separate systems. Now one account works everywhere — TUI and gateway use the same username+password login. Resources, Lux rewards, and nodes are tied to YOUR peerId, not the machine's.

### What Was Built

**Node-side (packages/node/src/):**
- `index.ts`: Operator state fields (`operatorPeerId`, `operatorToken`, `operatorUsername`), `setOperator()`/`clearOperator()`/`getOperator()`/`getRewardRecipient()` methods. Emission attribution — no login = no rewards (node runs as relay only). Deleted dead code: `stopForLogout()`, `clearIdentity()`.
- `tui.ts`: New commands `/login`, `/register`, `/account`. Auto-login via `operator-session.json` on startup. Startup shows "Node #XXXX running". `/logout` rewritten — just clears operator session, node keeps running. Session persistence helpers (`saveOperatorSession`, `loadOperatorSession`, `clearOperatorSession`).
- `user-accounts.ts`: `linked_nodes` column + SQLite migration, `registerNode()`/`getLinkedNodes()` methods. `withTimeout` utility for `login()` to prevent hangs.
- `api-server.ts`: `GET /auth/me/nodes` and `POST /auth/me/nodes` endpoints. Updated `GET /auth/me` with `linkedNodes`.

**Gateway-side (packages/gateway/):**
- `app/api/auth/me/nodes/route.ts`: New proxy route for linked nodes API.
- `app/resources/page.tsx`: My Resources section (user's own resources), My Nodes section (linked nodes with online/offline status).
- `app/api/auth/login/route.ts`: Improved timeout handling (15s timeout, non-JSON response guard).
- `lib/auth-context.tsx`: Added 20s browser-side timeout on login fetch.

### Sub-phases

| # | What | Status |
|---|---|---|
| 48.1 | Node operator state (setOperator/clearOperator/getOperator/getRewardRecipient on PandoNode) | DONE |
| 48.2 | TUI login flow (/login, /register, /account commands, auto-login via operator-session.json) | DONE |
| 48.3 | Emission attribution (rewards go to logged-in user peerId, no login = no rewards) | DONE |
| 48.4 | "My Nodes" tracking (linked_nodes column, registerNode/getLinkedNodes, GET/POST /auth/me/nodes) | DONE |
| 48.5 | Gateway "My Resources" + "My Nodes" sections on resources page | DONE |
| 48.6 | Node startup UX ("Node #XXXX running", login prompt) | DONE |
| 48.7 | Genome docs + E2E testing | DONE |

### Key Design Decisions

- **Node identity vs User identity:** Node machine key handles libp2p transport (Noise encryption, GossipSub signing). User peerId handles everything economic and social (rewards, resources, projects). Login binds the operator to the node.
- **No login = relay only:** Nodes without a logged-in operator still function for P2P transport but earn no Lux rewards. Incentivizes operators to claim their nodes.
- **Auto-login:** `operator-session.json` persists the operator session. On TUI startup, the node checks for this file and auto-restores the operator session (validates token, sets operator state).
- **Login timeout hardening:** 15s timeout on node-side login (prevents hang if MongoDB slow), 20s browser-side timeout in auth-context.tsx.
- **Backward compatible:** Existing TUI identities in `~/.pando/identities/` still work for P2P. The unified identity adds operator login on top, it does not break the existing node key system.

---

## Phase 49: Network Capacity Dashboard + Reward Signals (DONE)

Node-side: `GET /capacity` endpoint (public, no auth) in api-server.ts. Aggregates from ResourceMarketplace (supply: providers per resource, price ranges), CapabilityRegistry (node capabilities), ResourceMeter (demand: usage per resource), Scheduler (task metrics: pending/running/completed/failed), Ledger (network accounts, total supply), HealthMonitor (network health status). Each subsystem call individually try/caught for resilience — partial data returned if any subsystem is unavailable.

Gateway-side: Proxy route at `app/api/capacity/route.ts`. Full dashboard page at `app/capacity/page.tsx` with 5 sections: Network Overview cards (total nodes, total Lux, active tasks, health status), Supply table (available/needed badges per resource type, provider counts, price ranges), Demand stats (task metrics, resource usage), Reward Signals (sorted by estimated daily earnings, gradient bars showing relative reward levels), Call to Action for potential providers. Auto-refreshes every 30 seconds. NavBar updated with "Capacity" link.

---

## Phase 50: Network Council — Autonomous Reflection + Self-Governance (DONE)

Infrastructure built for a rotating council of top-reputation AI-capable nodes that periodically reflect on network state and propose improvements. Council members selected from CapabilityRegistry (Claude Code capable, sorted by reputation). Weekly rotation. Daily reflection assembles a structured prompt from network state + council minutes + genome/state.md. AI call is stubbed (prompt assembly only) — to be wired to Claude Code sessions later.

**What was built:**
- `council.ts` — Council class: `selectCouncil()` (reputation-weighted, capability-filtered), `runDailyReflection()` (prompt assembly, minutes entry), `start()`/`stop()` (hourly tick scheduler), `getCouncil()` / `getMinutes()` API. State persisted in `{dataDir}/council/`.
- `network-state.ts` — NetworkState class: aggregates metrics from HealthMonitor, CapabilityRegistry, Ledger, Scheduler into `network-state.md`. Auto-updates on configurable interval.
- `api-server.ts` — `GET /council` (members, rotation, this-node status), `GET /council/minutes` (rolling 30-entry log).
- Gateway: `/council` page (members table, rotation cards, council minutes in monospace block, network state overview), `/api/council` + `/api/council/minutes` proxy routes, NavBar "Council" link. 60s auto-refresh.

**Not yet wired:** Actual AI reflection calls (daily/weekly/monthly), P2P council broadcast, sentiment tracking, growth dashboard. These are future work — the infrastructure is ready.

**Design retained for reference:** Decision lanes (auto-execute / fast-track / full governance / human escalation), reflection cadences (hourly heartbeat / daily / weekly / monthly), context management (network-state.md + council-minutes.md + genome as organizational memory). See git history for the full original design.

---

## Phase 34-old: Hosting Platform Maturity (PLANNED)

> Moved from Phase 33. S3 hosting works. This phase adds GitHub integration, custom domains, container hosting, and Lux billing. See git history for full design. (Renumbered — was Phase 34 before Phase 35-39 inserted above.)

---

## Phase 53: Full-Stack App Independence + Resource Proxy (DONE — 53.0-53.5 COMPLETE, 53.6-53.9 REMAINING)

> **The fundamental insight**: `/apps/data` was a crutch. Real apps have their own backends. Builder agents should write complete full-stack applications — frontend, backend, database code — that run independently on contributed infrastructure. The node's only job is BUILD. After deploy, node involvement = zero.
>
> **The privacy solution**: Apps NEVER see raw resource credentials. A Resource Proxy holds credentials server-side, meters usage, and bills Lux. Apps get a project-scoped API key. Resource providers' secrets stay secret.

### The Problem with /apps/data

Phase 52 moved app data from node SQLite to gateway-direct-MongoDB. But two deeper problems were identified:

1. **Centralization**: A hardcoded `MONGODB_URI` in the gateway means one database, one point of failure, one privacy violation. With 100 nodes and 100 users contributing MongoDB instances as resources, why would the gateway pick one?

2. **It's still a crutch**: `/apps/data` is a generic key-value store that Pando provides for lazy apps. But real applications — a social network, a game, a marketplace — have their own backends with their own database schemas, their own API routes, their own caching layers. Facebook doesn't use someone else's `/apps/data`. It has its own backend that queries its own databases.

### The Correct Architecture

```
User says: "Build me a social network like Twitter"

Builder agent creates:
├── frontend/          ← React/Vue/static HTML
│   └── (calls its OWN backend API, not /apps/data)
├── backend/           ← Express/Fastify/Lambda
│   ├── routes/        ← /api/posts, /api/users, /api/follow
│   └── db.ts          ← connects via Resource Proxy (project-scoped key)
├── package.json
└── README.md

Deployment:
├── Frontend → GitHub Pages / S3 / Vercel (contributed resource)
├── Backend  → AWS Lambda / EC2 / Railway (contributed resource)
└── Database → MongoDB Atlas (contributed resource, accessed via proxy)

After deploy:
├── Node involvement = ZERO
├── App runs on contributed infrastructure
├── Gateway is just a directory pointing to the app's URL
└── If every node dies, the app keeps running
```

### Resource Privacy: The Resource Proxy

**Core problem**: 10 node operators contribute MongoDB instances, AWS keys, API keys. When a builder agent writes app code, how do credentials stay private? How do we track usage? How do we bill Lux?

**Solution**: Apps never see raw credentials. They talk to a **Resource Proxy** that holds credentials server-side.

```
App (frontend/backend)
  │  calls: POST https://resource-proxy.pando/db/query
  │  with: { collection: "posts", filter: { userId: "abc" } }
  │  auth: X-Project-Key: <project-scoped-api-key>
  ▼
Resource Proxy (runs on gateway or dedicated service)
  │  1. Validates project API key
  │  2. Looks up: which MongoDB is assigned to project "my-facebook"?
  │  3. Decrypts real credentials from ResourceRegistry (in-memory only)
  │  4. Executes actual MongoDB query with real credentials
  │  5. Records: { projectId, resource, operation, bytes, latency }
  │  6. Deducts Lux from project escrow (micro-payment per operation)
  │  7. Credits Lux to resource provider
  ▼
MongoDB Atlas (contributed resource)
  │  sees: connection from proxy IP, not from app
  │  credentials: NEVER exposed to frontend or app code
```

**Three app architectures, depending on complexity:**

| App Type | Example | How It Uses Resources |
|---|---|---|
| **Static (no backend)** | Portfolio, landing page, simple game | Deployed to S3/GitHub Pages. No database. No credentials. No proxy needed. |
| **Data app (no custom backend)** | Todo list, blog, simple social | Uses Resource Proxy API for database access. Proxy holds MongoDB credentials. App has project-scoped key only. |
| **Full-stack (custom backend)** | Facebook, marketplace, SaaS | Builder writes a real backend. Credentials injected as **env vars at deploy time** (not in code). Backend reads `process.env.MONGODB_URI`. Frontend talks to backend. Backend talks to database. Credentials never in frontend. |

**What the app knows vs. what the network knows:**

```
APP (public, visible to anyone):
  - Project-scoped API key (can only access its own data)
  - Resource Proxy URL (shared endpoint, or own backend URL)
  - NOTHING ELSE. No credentials. No connection strings.

RESOURCE PROXY (semi-private, runs on gateway infra):
  - Decrypted credentials in memory (never on disk)
  - Project→resource assignment mapping
  - Usage meters per project per resource
  - Lux billing logic

NODE NETWORK (private, encrypted, P2P):
  - All contributed resource credentials (encrypted in ResourceRegistry)
  - Which project uses which resource
  - Billing ledger: who owes what, who earned what
  - Resource health status
```

### Usage Tracking and Lux Billing

Every resource proxy request gets metered:

```
1. App sends request with project API key
2. Proxy authenticates project key
3. Proxy checks project Lux escrow balance (via node network)
4. Proxy executes query against assigned resource
5. Proxy records: { projectId, resourceType, operation, bytes, latency, timestamp }
6. Proxy deducts micro-payment from project escrow
7. Resource provider earns proportional Lux
8. If balance < 20% → warning to project owner
9. If balance = 0 → read-only mode (don't kill a running app)
```

**Pricing is set by resource providers** via ResourceMarketplace (already built). The proxy just enforces it.

### Scaling: App Needs More Resources

When an app gets popular and needs more:

```
Resource Proxy detects: query latency > threshold for project "my-facebook"
  OR: app explicitly calls POST /resource-proxy/scale-request
      { projectId, resourceType: "mongodb", reason: "connection pool exhausted" }
  ▼
Node network receives scale request (via bridge queue)
  ▼
Manager evaluates:
  1. Are there bigger/additional MongoDB instances in ResourceRegistry?
  2. Does the project have enough Lux to pay for upgraded resources?
  3. Does the project owner approve the cost increase?
  ▼
If approved:
  - Assign additional/larger MongoDB instance to the project
  - Update proxy config: project "my-facebook" → new/additional endpoint
  - Migrate data if needed (or add read replica for horizontal scale)
  - Zero downtime: old connection drains, new one picks up
  - App code unchanged — still calls same proxy URL with same project key
```

**Resource provider goes down:**

```
Proxy detects: health check fails on contributed MongoDB instance
  ▼
Proxy action:
  1. Mark resource unhealthy in registry
  2. Find alternative MongoDB instance from ResourceRegistry
  3. If alternative exists → reassign project → migrate data
  4. If no alternative → degrade to read-only → notify project owner
  5. Notify original resource provider ("your instance is down")
  6. Stop billing until resolved
```

### Data Privacy on Contributed Resources

**Problem**: Resource provider contributes a MongoDB instance. They own it. They CAN read the data. What about private apps?

**Solution (future, not Phase 53)**: Encrypt data at the proxy level before writing.

```
App sends: { collection: "posts", doc: { text: "hello world", userId: "abc" } }
Proxy encrypts: { _enc: true, data: "AES-256-GCM-encrypted-blob", iv: "...", projectId: "..." }
MongoDB stores: encrypted blob (provider sees ciphertext only)
Proxy decrypts on read: returns plaintext to app
```

**For Phase 53**: Trust the resource provider (same as Phase 42 trusts MongoDB for user data). Encryption layer is a future hardening step. Documented as a known limitation.

### Everything Is a Resource

The ResourceRegistry (Phase 42.5) already supports encrypted, P2P-replicated resource contribution. Phase 53 expands what resources mean:

| Resource Type | Who Provides | What It Enables | Lux Reward |
|---|---|---|---|
| **MongoDB instance** | Anyone | Database for apps, user data persistence | Per-query usage |
| **S3 bucket** | Anyone | File storage, static hosting | Per-GB stored |
| **GitHub account** | Anyone | Code hosting, GitHub Pages for static sites | Per-repo hosted |
| **AWS account** | Anyone (node operators likely) | Lambda/EC2 for backends, container hosting | Per-compute-hour |
| **Vercel/Netlify account** | Anyone | Frontend hosting with CDN | Per-deploy |
| **Redis instance** | Anyone | Caching, sessions, real-time features | Per-operation |
| **API keys** (existing) | Anyone | AI inference, search | Per-call |
| **Compute** (existing) | Node operators | Running agents, building projects | Per-task |

**Key principle**: You do NOT need to run a node to contribute resources and earn Lux. Anyone can contribute a MongoDB instance or GitHub account.

### Network Survival with Zero Resources

The P2P brain (identity, economy, governance, coordination) runs on nodes with ZERO external resources. The network survives.

```
0 resources contributed:
  ✅ P2P identity works
  ✅ Lux economy works
  ✅ Governance works
  ✅ Nodes discover each other
  ✅ Chat works (text-only, no AI)
  ❌ Can't build apps (no compute, no AI keys)
  ❌ Can't host apps (no S3, no GitHub)
  ❌ Can't persist user data (no MongoDB)

→ Network is ALIVE but has no hands. Add resources = add capabilities.

1 MongoDB + 1 API key + 1 S3 bucket contributed:
  ✅ Everything above
  ✅ AI chat works
  ✅ Can build and deploy apps
  ✅ User data persists

→ Network is fully functional with just 3 resource contributions.
```

### The Facebook Example (End to End)

Jai's concrete test: "What if we're running Facebook on Pando?"

**Wrong (old way)**: Node stores posts in `/apps/data`. Gateway proxies every read/write. Node must be online for Facebook to work. Data centralized in one MongoDB instance controlled by gateway.

**Right (Phase 53)**:

```
1. User: "Build me a social network like Facebook"

2. Manager agent evaluates:
   - Need: frontend hosting, backend compute, database, file storage
   - ResourceRegistry query: finds MongoDB (provider A), S3 (provider B),
     AWS Lambda (provider C), GitHub (provider D)
   - Assigns resources to project, creates escrow

3. Builder agent creates complete app:
   - React frontend (feed, profiles, messaging, groups)
   - Express backend (REST API for all features)
   - MongoDB schema (users, posts, follows, messages)
   - Backend code reads process.env.MONGODB_URI (injected at deploy)
   - OR: backend calls Resource Proxy for db access (simpler apps)

4. Deployment:
   - Frontend → GitHub Pages via provider D's account
   - Backend → AWS Lambda via provider C's account
   - Database → MongoDB Atlas via provider A's instance
   - Files/images → S3 via provider B's bucket
   - Credentials: env vars on Lambda, NEVER in frontend code

5. After deploy:
   - Gateway directory: "PandoBook → https://pandobook.github.io"
   - Node stores: { projectId, name, url, resources: [...], owner }
   - Node does NOT: serve data, proxy requests, store anything

6. App gains traction (1000 users):
   - Resource Proxy detects: high latency on MongoDB
   - Network finds: provider E has a bigger MongoDB instance
   - Manager: migrates data to provider E, updates proxy config
   - App code unchanged. Users notice nothing.
   - Provider A stops earning Lux (less usage), Provider E starts earning

7. All Pando nodes go offline:
   - Facebook keeps running (GitHub Pages + Lambda + MongoDB)
   - No new features can be built (no agents)
   - No Lux billing (proxy down, but app works)
   - When nodes come back, billing catches up
```

### Node = BUILD Only

After Phase 53, a node's relationship to apps is:

```
DURING BUILD:
  Node runs Claude Code agent → agent writes code → agent deploys to resources

AFTER BUILD:
  Node stores: { projectId, name, deploymentUrl, createdBy, contributors, resources }
  Node does NOT: serve app data, proxy API calls, store app state

FOREVER AFTER:
  App lives on contributed infrastructure
  Node has a record in the project store
  Gateway has a link in the directory
  Resource Proxy meters usage and bills Lux
  That's it
```

### Legacy Code to Delete (Phase 52 Revert + Cleanup)

| File | What to Delete | Why |
|---|---|---|
| `packages/gateway/lib/mongodb.ts` | ENTIRE FILE | Gateway-direct-MongoDB was a crutch. Gateway doesn't connect to any database. |
| `packages/gateway/app/api/apps/data/[namespace]/[key]/route.ts` | ENTIRE FILE | `/apps/data` no longer exists |
| `packages/gateway/app/api/apps/data/[namespace]/route.ts` | ENTIRE FILE | `/apps/data` no longer exists |
| `packages/gateway/app/api/apps/data/route.ts` | ENTIRE FILE | `/apps/data` no longer exists |
| `packages/gateway/app/apps/[...path]/route.ts` | ENTIRE FILE | S3 proxy through gateway is legacy. Apps have their own URLs. |
| `packages/node/src/api-server.ts` | `dataStore` block in `/capabilities/infrastructure` | References deleted `/apps/data` endpoint |
| `packages/node/src/api-server.ts` | `appBaseUrl` in infrastructure response | Apps don't go through gateway anymore |
| `genome/templates/builder.md` | `/apps/data` references | Builder writes real backends, not `/apps/data` calls |
| `genome/templates/manager.md` | `/apps/data` references | Manager doesn't tell builders to use `/apps/data` |
| `packages/gateway/package.json` | `mongodb` dependency | Gateway doesn't connect to MongoDB anymore |

### Phases of Execution

| Sub-Phase | Description | Difficulty | Details |
|---|---|---|---|
| **53.0** | **Protocol Memo System**: Create `genome/protocol.md` (versioned, single source of truth for all agents). Wire into agent.ts `buildClaudeMd()` as Layer 0. Wire into `buildPromptFromBridgeItem()` for event injection. Version check + changelog on bump. Session reset on major version change. | MEDIUM | This goes FIRST — all subsequent template changes propagate automatically. |
| **53.1** | **Delete legacy**: Remove all `/apps/data` routes (gateway), `gateway/lib/mongodb.ts`, `mongodb` dependency from gateway, S3 proxy route, `dataStore`/`appBaseUrl` from infrastructure endpoint. Clean break. No fallbacks. | LOW | ~10 files deleted/edited. |
| **53.2** | **Resource Proxy on gateway**: Build proxy service. Routes: `POST /api/resource-proxy/db/query`, `GET /api/resource-proxy/db/query`, `DELETE /api/resource-proxy/db/delete`. Auth via project-scoped API key. Reads credentials from ResourceRegistry via node API. Meters usage. Bills Lux. | MEDIUM | New gateway routes. New concept: project API keys. |
| **53.3** | **Project resource assignment + node API**: New endpoints: `POST /projects/:id/resources/assign`, `GET /projects/:id/resources`, `POST /projects/:id/api-key`. Project model gets `resources` + `apiKey` fields. Manager queries ResourceRegistry at project creation. | MEDIUM | ResourceRegistry already has `findByType()`. Need assignment + escrow. |
| **53.4** | **Rewrite templates + update protocol.md v1**: Builder template teaches 3 app patterns (static/data/full-stack). Manager template knows about resource assignment. Infrastructure endpoint updated with `resourceProxy` section. Protocol.md v1 published with all rules. | MEDIUM | Template + protocol rewrite. All agents get the memo. |
| **53.5** | **Credential injection at deploy**: When deploying, credentials are env vars on hosting platform — never in code. `deployAgentWorkspace()` reads project's assigned resources, injects as env vars. Static apps: no credentials. Proxy apps: only project key. | MEDIUM | Deploy step needs resource-aware env var injection. |
| **53.6** | **GitHub as hosting resource**: Contribute GitHub account token. Builder pushes repos. Enable GitHub Pages for static sites. Git-based workflow for app updates. | MEDIUM | New resource type in ResourceRegistry. Git operations in builder. |
| **53.7** | **Gateway app directory**: Replace S3 proxy with directory page. List deployed apps with external URLs, search, categories. Links out to actual hosting. | LOW | New gateway page. Simple project listing. |
| **53.8** | **Resource health monitoring**: Periodic health checks on contributed resources (MongoDB ping, S3 HEAD, GitHub API). Unhealthy → reassign. | MEDIUM | Extends NodePool health check pattern to resources. |
| **53.9** | **E2E test**: "Build me a todo app" → agent writes full-stack → deploys to contributed resources → verify works independently → verify Lux billing → verify node not involved at runtime. | HIGH | Full lifecycle test. |

### Sub-Phase 53.0: Protocol Memo System (Detail)

**Problem**: When we change how things work (like deleting `/apps/data`), running agents don't know. Templates only apply at spawn. CLAUDE.md compresses out after 100+ tasks. There's no organizational memo system.

**Solution**: `genome/protocol.md` — one file, versioned, every agent reads it, always.

```
genome/protocol.md

# Pando Network Protocol — v1
# Updated: 2026-02-22
# All agents MUST read this. It overrides older instructions.

## Architecture Rules
1. Apps NEVER store credentials in code. Use Resource Proxy (project key) or env var injection.
2. After deploy, node involvement = ZERO. Apps are independent.
3. NEVER use /apps/data — it doesn't exist. Apps have their own backends.
4. All user data goes to contributed MongoDB instances via StorageBackend.
5. Resources (MongoDB, S3, GitHub, compute, API keys) are contributed, encrypted, P2P replicated.
6. Document everything in genome/. Never write to admin_docs/.
7. ...

## How Apps Work
- Static apps: deploy to S3/GitHub Pages. No backend. No database.
- Data apps: use Resource Proxy (POST /api/resource-proxy/db/query with X-Project-Key header).
- Full-stack apps: write real backend + frontend. Credentials injected as env vars at deploy time.

## How Resources Work
- GET /capabilities/infrastructure → discover available resources
- Resources assigned to projects by manager
- Project gets API key for Resource Proxy access
- Lux escrow per project, micro-billing per operation

## What Changed in v1
- Initial protocol version
- Deleted /apps/data (was a centralized crutch)
- Added Resource Proxy for credential privacy
- Apps deploy to contributed hosting resources
```

**How it propagates to every agent:**

| Layer | When | What | Survives Compression? |
|---|---|---|---|
| **Layer 0: protocol.md injection** | Agent spawn (buildClaudeMd) | Full protocol.md prepended to CLAUDE.md before role template | No (compresses like CLAUDE.md) |
| **Layer E: Event prompt injection** | Every bridge event (buildPromptFromBridgeItem) | Protocol version + top 5 critical rules | YES — always in latest context |
| **Layer V: Version check** | Every event | Compare protocol version in file vs agent's stored version. If mismatch → inject changelog. | YES |
| **Layer R: Session reset** | On major version bump (v1→v2) | POST /agents/:id/reset-session → fresh CLAUDE.md + fresh protocol | N/A (fresh start) |

**Code changes for 53.0:**
1. Create `genome/protocol.md` — the protocol file
2. `agent.ts` `buildClaudeMd()` — prepend protocol.md content as Layer 0
3. `agent.ts` state.json — store `protocolVersion` field
4. `agent-manager.ts` `buildPromptFromBridgeItem()` — inject protocol version + key rules
5. `agent-manager.ts` — on version mismatch, inject "PROTOCOL UPDATED" with changelog
6. `agent-manager.ts` — on major version bump, trigger session reset

**Result**: Change one file (`protocol.md`), bump version → ALL agents know the new rules on their next task. Running agents see the changelog. New agents spawn with the latest. No stale knowledge. No updating 6 templates + CLAUDE.md + hoping agents pick it up.

### What protocol.md Must Contain (Essential Knowledge)

The protocol is the **employee handbook**. Every agent — manager, builder, tester, reviewer, researcher, devops — reads it. It contains everything an agent needs to know to NOT make mistakes, regardless of role.

**Section 1: Architecture Rules (DO and DON'T)**
- Nodes are stateless compute proxies. NEVER store user data on nodes.
- Apps are independent after deploy. Node = BUILD only.
- NEVER put credentials in app code. Use Resource Proxy or env var injection.
- NEVER use /apps/data — it doesn't exist.
- NEVER make deployed apps depend on nodes or gateway being online.
- All user data (threads, messages, projects) → MongoDB via StorageBackend.
- P2P is for the brain (identity, economy, governance). NOT for user data.
- Document all changes in genome/. NEVER write to admin_docs/.

**Section 2: How to Build Apps**
- Three patterns: static, data (Resource Proxy), full-stack (own backend).
- How to discover available resources: `GET /capabilities/infrastructure`.
- How to use Resource Proxy: URL, auth header, request format.
- How to deploy: `POST /agents/:id/deploy` for static, env var injection for backends.
- How to handle data: MongoDB schemas, NOT key-value hacks.

**Section 3: How Resources Work**
- Everything is a contributed resource (MongoDB, S3, GitHub, compute, API keys).
- Resources are encrypted, P2P replicated via ResourceRegistry.
- Project gets resources assigned by manager at creation.
- Lux escrow per project. Micro-billing per operation.
- Resource providers earn Lux proportional to usage.

**Section 4: Communication Protocol**
- Report to parent via POST /agents/:parentId/message.
- Spawn children via POST /agents/spawn.
- Deploy via POST /agents/:id/deploy.
- API token in Authorization header.
- Bridge queue is the nervous system — all events flow through it.

**Section 5: Safety Rules (The Two Laws)**
- Law I: Do not harm any human.
- Law II: Survive, persist, come back.
- Budget limits: pause at 2x overspend. Max 3 retries per task.
- Protected paths: guardrails.json is immutable.

**Section 6: Changelog**
- v1: Initial protocol. What changed, what was deleted, what's new.

### Decisions Made

1. **Resource Proxy lives on gateway** (for now). Can be extracted to dedicated service later as network grows. Gateway already proxies everything — adding resource proxy routes is natural.
2. **Trust resource providers** (for now). Encryption at the proxy level is a future hardening step, not Phase 53. Same trust model as Phase 42 (we trust MongoDB providers not to snoop).
3. **Three app tiers**: static (no proxy), data app (proxy for DB), full-stack (own backend with injected env vars). Builder template teaches all three patterns.
4. **Lux escrow per project**: Projects pre-fund resource usage. Warning at 20%, read-only at 0%. No hard kill — don't break running apps.
5. **Resource reassignment on failure**: If a contributed resource goes down, proxy detects it, finds alternative, migrates. App code unchanged.
6. **No `/apps/data` fallback**: It's deleted. No backward compatibility. Existing apps (if any) get rebuilt. We have git if we need to go back.
7. **Protocol memo system**: `genome/protocol.md` is the single source of truth for all agent knowledge. Versioned. Injected at spawn + every event. Version mismatch → changelog injection. Major bump → session reset. Change one file → all agents know.
8. **MCP server unchanged** for Phase 53. Agents use HTTP API, not MCP. MCP is for CLI users only. Optional: add `pando_resources` tool later.

### Known Limitations (Phase 53)

1. **No data encryption at proxy level** — resource providers can read data. Future hardening: AES-256-GCM at proxy before write.
2. **No multi-region resource selection** — proxy doesn't consider geography. Future: latency-based routing.
3. **Backend hosting limited** — Lambda/EC2 require AWS accounts. Broader compute hosting (Railway, Fly.io, Render) is future resource types.
4. **No credential rotation flow** — if a resource provider changes their MongoDB password, manual re-contribution needed. Future: rotation protocol via GossipSub.
5. **Scale triggers are manual** — proxy detects high latency but human approves migration. Future: auto-scaling policies per project.
6. **Protocol memo is file-based** — requires filesystem access. Agents in sandboxed environments may not read it. Mitigated by event prompt injection (Layer E).

---

## Vision: Self-Managing Network (2026-02-22)

> **The end state is a network that manages itself.** The CEO (external Claude session) should eventually be unnecessary. The manager agent running on the node should be as capable as the CEO -- commissioning work, tracking progress, deploying, updating genome, and making architectural decisions. The CEO role transitions to QA-only once the manager is self-sufficient.

### What Self-Management Means

1. **Manager = CEO.** The pando-node-mgr agent should be able to do everything the external CEO session does: read genome, understand architecture, create tasks, verify work, deploy, commit, and update documentation. The gap today is that the CEO has context the manager doesn't (project history, infra access, decision rationale). Closing this gap means the manager must maintain its own comprehensive project-state.md and have access to the full genome.

2. **Upgrades through governance.** Any node on the network can propose an upgrade. AI reviewers evaluate it. The network votes. If approved, the upgrade rolls out automatically via UpgradeProtocol. No human intervention needed for routine improvements.

3. **Progress tracking from within.** The manager should track what's been built, what tests pass, what's deployed -- and report this through the gateway, not through external CEO sessions. The genome + project-state.md + test tracker together form the self-awareness layer.

4. **Contribution attribution.** The network knows who (which agent, which node) built what. Contribution tracking (Phase 31) + genome history + git blame together create a verifiable record of work.

5. **CEO becomes QA.** Once the manager can self-direct, the CEO's only role is spot-checking quality and intervening when the manager is genuinely stuck or making bad architectural decisions. The founder becomes an admin user making suggestions, not a required operator.

### Key Insight: Context Compression Limits Autonomy

The biggest barrier to manager self-sufficiency is context compression. After 100+ tasks, the manager forgets its own instructions. Solutions:
- **Event prompt injection** (Phase 32.5) -- critical rules survive in every event prompt
- **project-state.md** -- external brain that never compresses
- **Session reset** (`POST /agents/:id/reset-session`) -- fresh start with full CLAUDE.md when context is too degraded
- **Genome as persistent memory** -- architectural knowledge lives in files, not in session context

---

## Honest Gap Assessment (2026-02-18)

> This is a brutally honest look at what works, what's missing, and what the realistic path looks like.
> Reviewed against the scenario: hundreds of users, hundreds of nodes, diverse capabilities.

### Core Philosophy

**P2P is for the brain, not every byte.** The node network is indestructible because it's decentralized. But the things it BUILDS (websites, APIs, apps) live on normal internet infrastructure (GitHub, Vercel, AWS, S3). Pando co-exists with the internet. It doesn't replace it.

See `genome/rules/p2p-first.md` for the full rule.

### What Works Today

| Area | Status | Notes |
|---|---|---|
| P2P networking | SOLID | libp2p battle-tested. Peer discovery, encrypted comms, GossipSub. |
| Authority model | SOLID | Manager/Scheduler/Worker separation. Clean, enforced. |
| Ledger + economy | SOLID | Ed25519 signed transactions, witness-based emission, GossipSub sync. |
| Diverse node types | SOLID | Capability registry + resource router. Storage, GPU, Claude-equipped nodes coexist. |
| Genome system | SOLID | Self-documenting codebase. Scoped context for workers. Drift detection. |
| Manager intelligence | WORKING | Claude Code sessions that reason, create tasks, commit code. Proven. |
| Task execution | WORKING | Full pipeline from task creation to workspace to worker to completion. |
| Governance | WORKING | Proposals, votes, decisions sync cross-node. |
| Chat interface | WORKING | 3-tier: keyword instant, OpenAI fallback, Claude Code escalation. |

### What's Missing (Prioritized)

#### Must-Have for Real Users

| Gap | Impact | Difficulty | Notes |
|---|---|---|---|
| ~~**Persistent user accounts**~~ | ~~Users can't come back tomorrow~~ | ~~MEDIUM~~ | **DONE (Phase 31.0)** — Ed25519 identity, SQLite, scrypt hashing, session tokens, guest auto-creation + claim flow. |
| ~~**Service catalog**~~ | ~~Users don't know what they can pay for~~ | ~~LOW~~ | **DONE (Phase 38.2)** — `/services` gateway page with 5 service cards, live status, pricing, provider earnings. |
| ~~**Lux acquisition (initial)**~~ | ~~Users can't get Lux without running a node~~ | ~~HIGH~~ | **PARTIALLY DONE (Phase 35)** — Guest welcome grant (25-125 Lux). Long-term on-ramp: Phase 39. |
| ~~**Project deployment**~~ | ~~Built websites sit in workspaces~~ | ~~MEDIUM~~ | **DONE (Phase 32 + 32.5)** — S3 hosting + agent-driven deployment. |
| ~~**Multi-turn project creation**~~ | ~~One-shot classification loses nuance~~ | ~~MEDIUM~~ | **DONE (Phase 27)** — Manager IS the conversation. Persistent sessions with --continue --resume. |
| ~~**Guest key security**~~ | ~~Node operators can impersonate unclaimed guests~~ | ~~HIGH~~ | **MOSTLY DONE (Phase 36/40)** — Browser-side Ed25519 keypair generation. Legacy `guest-secret` still present for backwards compat. |
| ~~**Hosting resilience**~~ | ~~Single S3 bucket, no backup, no failover~~ | ~~HIGH~~ | **ADDRESSED by Phase 53** — Apps deploy to contributed resources (multiple S3 buckets, GitHub Pages, Vercel). No single bucket. Resource Proxy handles failover. |
| ~~**Public node AI access**~~ | ~~Public gateway can't run AI chat~~ | ~~CRITICAL~~ | **DONE (Phase 38).** Lightsail has `--scheduler` + Claude Code (Max sub). Public gateway can run AI chat. |

#### Important for Multi-User Scale

| Gap | Impact | Difficulty | Notes |
|---|---|---|---|
| ~~**Signature-based auth**~~ | ~~Users locked to one node~~ | ~~HIGH~~ | **DONE (Phase 40).** Ed25519 challenge-response, any-node login. |
| ~~**End-to-end encrypted chat**~~ | ~~Node operators can read conversations~~ | ~~HIGH~~ | **DONE (Phase 41).** X25519 + AES-256-GCM, browser-side keypair, encrypted at rest. |
| ~~**Storage backend**~~ | ~~Node dies = all data lost, user stuck on one device~~ | ~~CRITICAL~~ | **DONE (Phase 42).** MongoDB Atlas for user data. Nodes are stateless. E2E verified. |
| ~~**Resource registry**~~ | ~~Credentials in plaintext, manual per-node config, non-operators can't contribute~~ | ~~CRITICAL~~ | **DONE (Phase 42.5).** Envelope encryption, P2P replicated registry, gateway contribute/revoke, legacy deleted. |
| ~~**Multi-node gateway**~~ | ~~Single node = single point of failure~~ | ~~HIGH~~ | **DONE (Phase 43).** NodePool, health checks, circuit breaker, failover. Deployed to Vercel. |
| **Privacy tiers** | Private project code visible to any worker node | HIGH | Phase 41 encrypts chat. Phase 42 stores encrypted data on external infrastructure. Full workspace encryption during agent execution TBD. |
| **GossipSub message scaling** | 100 nodes x 10 topics = message storm | MEDIUM | Topic sharding, message batching, priority tiers. |
| ~~**Project state replication**~~ | ~~Node dies = project state lost~~ | ~~MEDIUM~~ | **Addressed by Phase 42** — user data moves to MongoDB/S3. Node death doesn't affect data. |

#### Economic Sustainability

| Gap | Impact | Difficulty | Notes |
|---|---|---|---|
| **Lux real-world value** | Token has no exchange, no fiat pair | HIGH | Need exchange listing or fiat gateway. Long-term problem. |
| **AI cost funding** | Claude Code costs real USD, Lux doesn't pay for it | HIGH | Phase 42.5 DONE — API key contribution + Lux rewards enabled. Long-term: Lux-to-API-credits bridge. |
| **Demand-based pricing** | Fixed rewards regardless of supply/demand | MEDIUM | Resource marketplace has pricing but no dynamic adjustment. |

#### Growth (Post-Stability)

| Gap | Impact | Difficulty | Notes |
|---|---|---|---|
| **Network self-marketing** | Can't recruit nodes or users autonomously | HIGH | Needs product-market fit first. Then: referral programs, landing pages, community content. |
| **Resource demand signals** | Network can't say "we need more GPU nodes" | LOW | Dashboard showing what resources are scarce and what they'd earn. |
| **Onboarding** | Running a node requires git clone + npm build | HIGH | Phase 14 (deferred). Installer, system tray, one-click setup. |

### Realistic Path Forward (Updated 2026-02-22)

1. ~~**Make the node operator experience bulletproof.**~~ **DONE.** TUI resilient restart (Phase 34), PM2 support, windowsHide, graceful shutdown.

2. ~~**Content deployment.**~~ **DONE.** S3 hosting (Phase 32) + agent-driven deployment (Phase 32.5). "Build me X and put it live" works.

3. ~~**User accounts.**~~ **DONE.** Persistent Ed25519 identities (Phase 31.0), guest auto-creation, claim flow.

4. ~~**Guest Lux faucet.**~~ **DONE.** Free Lux on signup (Phase 35), reclamation for unclaimed guests.

5. ~~**Signature-based auth.**~~ **DONE.** Ed25519 challenge-response. Any node verifies any user against synced ledger. (Phase 40)

6. ~~**End-to-end encrypted chat.**~~ **DONE.** X25519 key exchange + AES-256-GCM. Browser-side keypair generation, per-thread encryption keys, encrypted at rest. Node decrypts for AI processing only. (Phase 41)

7. ~~**Encrypted storage.**~~ **DONE.** MongoDB Atlas for user data. Nodes are stateless compute proxies. E2E verified. (Phase 42)

8. ~~**Resource Registry.**~~ **DONE.** Network-level shared resources. Envelope encryption, P2P replication, gateway page. Legacy plaintext deleted. (Phase 42.5)

9. ~~**Multi-node gateway.**~~ **DONE + DEPLOYED.** NodePool, health checks, circuit breaker, failover. Deployed to Vercel with `PANDO_NODES`. (Phase 43)

10. ~~**Unified Identity.**~~ **DONE.** One account everywhere — TUI and gateway use the same login. Resources and rewards tied to YOUR peerId, not the machine. (Phase 48)

11. **THEN: 2-User QA Testing.** Jai + Claude CEO act as real users — test collaboration, projects, governance, chat. Find bugs, submit proposals, verify self-sustaining upgrade loop.

12. ~~**THEN: Capacity dashboard.**~~ **DONE.** `GET /capacity` endpoint + gateway dashboard page with supply/demand/rewards. (Phase 49)

13. ~~**THEN: Network Council.**~~ **DONE.** Council infrastructure built — rotating selection, daily reflection prompt assembly, council minutes, gateway page. AI calls stubbed. (Phase 50)

14. ~~**Enable public gateway AI.**~~ **DONE.** Lightsail has `--scheduler` + Claude Code. Public gateway can run AI chat. (Phase 38)

15. ~~**THEN: Guest security hardening.**~~ **MOSTLY DONE.** Client-side key generation implemented in browser (Phase 40). Legacy `guest-secret` still present. (Phase 36)

16. **LATER: Lux acquisition.** Gifting, referrals, fiat on-ramp. Service catalog DONE (Phase 38.2). (Phase 39)

17. **LATER: Collaboration + privacy.** Multi-owner projects. Trust tiers for sensitive work.

18. **EVENTUALLY: Exchange + self-sustaining economy.** Lux has real value. Network funds its own API costs.

---

## Open Architecture Questions

### ~~#1 Agent Pool Security~~ — SUPERSEDED

~~Profile-sync.ts and profile-cache.ts deleted in Phase 27.~~ No more auto-imported profiles. Agent templates are local files in `genome/templates/`. Network-wide template governance deferred to post-27.

### ~~#2 API Key Management~~ — RESOLVED (Phase 42.5)

**Problem:** When an agent needs to call OpenAI/Gemini, it uses the node operator's API keys. Who pays for AI calls made on behalf of the network?

**Resolution:** Phase 42.5 ResourceRegistry replaces `api-keys.json`. Credentials are envelope-encrypted (X25519 ECDH + AES-256-GCM), replicated via P2P GossipSub, and accessible to any authorized node. Contributors earn Lux. Legacy `api-keys.json` deleted. **Phase 58: Env var fallback (`OPENAI_API_KEY`) removed entirely.** ResourceRegistry is the ONLY source of API keys. No hardcoded fallbacks.

**Remaining:** Budget tracking per-agent, Lux-to-API-credits bridge for long-term sustainability.

### #4 Payment Flow

**Problem:** User pays 50 Lux for a website. Who gets paid?

**Options:**
- Node operator who did the compute
- Split between compute node + relay nodes
- Network treasury for infrastructure costs
- All of the above in defined ratios

**Dependency:** Requires Resource Network (capability declaration, cost estimation, payment-gate) -- all built but untested.

### #6 Context Assembly

**Problem:** Generating a system prompt is easy. Figuring out what FILES an agent needs is hard.

**Current state:** WorkspaceManager was deleted in Phase 27. Agents now use `agent.ts` with template injection (4-layer CLAUDE.md). Each agent gets its own persistent workspace directory (`~/.pando/agents/<id>/workspace/`).

**Future solution:** The genome solves scoped context. Instead of scanning the filesystem, the manager reads the genome to identify relevant components and their source files. Genome as Network Service (Phase 26 vision) makes this systematic for every project.

### #7 When to Go Public

**Problem:** The repo is still private. What needs to happen before open-sourcing?

**Checklist (estimated):**
- [ ] Remove any hardcoded credentials or secrets
- [ ] Clean up admin_docs (in progress -- migrating to genome)
- [ ] Ensure all tests pass (currently 27/102)
- [ ] Write user-facing README (not developer docs)
- [ ] License decision (currently "open-source" but no specific license file)
- [ ] Security audit of P2P layer
- [ ] Phase 14.0 at minimum (bootstrap scripts for easy setup)

### #9 Workspace Escape Prevention

**Problem:** Workers running Claude Code can read any file on disk, even outside their assigned workspace.

**Current state:** Phase 19 worker lockdown blocks POST /tasks and restricts tool access, but does not prevent filesystem reads outside the workspace.

**Risk:** Acceptable for self-managed network tasks (the node is reading its own code). Dangerous for user-project workers handling untrusted code -- a worker could read `~/.ssh/`, `~/.aws/credentials`, or other sensitive files.

**Options:**
- chroot/container isolation (heaviest, most secure)
- Filesystem permissions (moderate -- create a restricted user per workspace)
- Audit + reputation penalty (lightest -- detect and punish, don't prevent)
- Claude Code `--allowedDirectories` flag (if supported in future versions)

**Current approach:** Trust + audit. Future: sandboxing when user-project workers become common.
