# Project State (Auto-Updated)

> Last updated: 2026-02-26 (master — overnight sprint complete)
> Note: This file should be auto-updated by the genome agent. Manual edits are fine but may be overwritten.

## Overnight sprint complete (2026-02-26)

v2.1-v2.5 + Phase 53.7 + Phase 68.4 + Ledger Explorer + Node Setup + 18/18 smoke tests all complete and deployed.

## Health

| Node | IP | Status | Peers | StorageBackend | CredentialAccess | Supervisor | Uptime |
|---|---|---|---|---|---|---|---|
| EC2-1 (compute) | 54.82.241.132 | **ONLINE** | 8 | **mongodb** | true | **systemd** | Continuous |
| EC2-2 (compute) | 34.201.82.126 | **ONLINE** | 1+ | **mongodb** | true | **systemd** | Continuous |
| LS-1 (relay) | 54.145.144.221 | **DOWN** | -- | **p2p** | false | PM2 | Machine unreachable |
| LS-2 (untrusted) | 3.237.175.38 | **ONLINE** | 1+ | **p2p** | false | PM2 | Continuous |
| Windows (dev) | 100.87.67.78:4100 | ONLINE | 2+ | mongodb | true | Manual | Dev sessions |

**LS-1 alert**: SSH + HTTP both unreachable since 2026-02-26. Machine-level issue. Needs Lightsail console restart (Jai: action required).

**Smoke test**: `node tests/smoke-test.mjs` → 18/18 PASS on 3-node network (LS-1 excluded)

## Current Phase

**Overnight sprint COMPLETE (2026-02-26).**

All phases 0-35, 38, 40-70, 73, 78, 79, 80, 81, 82, 83, 86, 87, **88**, **53.7**, **68.4** COMPLETE. v2.1-v2.5 architecture complete. See "What's next" below for priorities.

**Node Setup / Developer Onboarding — COMPLETE (2026-02-26)**
- ✅ `packages/gateway/app/node-setup/page.tsx` — new /node-setup page
  - 5-step setup guide with copy buttons on all commands
  - Live stats: peer count, accounts, Lux supply (fetched from /api/onboard)
  - Earning table (what you get for running a node)
  - Requirements checklist, bootstrap peers, GitHub link
- ✅ `/api/onboard` enriched with public bootstrap IPs (replaces private EC2 IPs from /v1/onboard)
- ✅ NavBar: "Get Started" link added (second position)

**Smoke Test Suite — COMPLETE (2026-02-26)**
- ✅ `tests/smoke-test.mjs` — 18 automated tests, 0 failures
  - Layer 0: 3-node status, NodeHealth, wallet, peers
  - Ledger Explorer: accounts, transactions, cross-node consistency
  - P2P Storage: LS-2 create → read → EC2-1 cross-node
  - Governance, AI Search, Network Capabilities, App Directory
- Run: `node tests/smoke-test.mjs`

**Ledger Explorer — COMPLETE (2026-02-26)**
- ✅ `GET /v1/ledger/accounts` — top N accounts by balance (public, no auth)
- ✅ `GET /v1/ledger/transactions` — most recent N global transactions (public, no auth)
- ✅ `node-connection.ts`: `getLedgerAccounts()` + `getLedgerTransactions()` methods
- ✅ `/api/ledger` gateway proxy (`?type=accounts|transactions`)
- ✅ `/explore/economy` upgraded: top accounts table with % share, global tx history with type badges, "you" marker, 4-stat header, 20s auto-refresh
- Live data: EC2-1 has 177 accounts, 26,297 Lux supply, 2,518 transactions

**Phase 53.7: Gateway App Directory — COMPLETE (2026-02-26)**
- ✅ `packages/gateway/app/apps/page.tsx` — new public page listing all deployed apps
  - App cards: name, description, host type badge (S3/EC2/Gateway), status dot, URL, "Open ↗" button
  - Search by name/description/URL
  - Filter by host type (All / S3 / EC2 / Gateway) with counts
  - Live connectivity check via HEAD request (mode: no-cors)
  - Loading skeleton + empty state with "ask AI to build something" CTA
- ✅ `packages/gateway/app/api/apps/route.ts` — API: fetches deployed projects, classifies host type
- ✅ `packages/gateway/components/NavBar.tsx` — "Apps" link added
- Deployed to EC2-1, EC2-2, LS-2 (LS-1 still down)
- Gateway auto-deployed to Vercel on push to master

**Phase 68.4: Returning User Routing — COMPLETE (2026-02-26)**
- ✅ Gateway chat page shows "Your Projects" sidebar section for authenticated returning users
- ✅ Clicking a project sets `activeProjectId`, routes all messages to that project's manager agent
- ✅ `effectiveProjectId = activeProjectId || projectIdParam` — backwards compatible with URL params
- ✅ Header shows project name + purple icon when in project context
- ✅ "✕ Project" button exits project context

**v2.5: Local Environment — COMPLETE (2026-02-26)**
- ✅ `packages/node/src/kernel/local-environment.ts` — new file (Envelope 1)
  - SQLite FTS5 file index: `~/.pando/file-index.db`
  - `grantDirectory()` / `revokeDirectory()` / `search()` / `readFile()`
  - Protected paths hard-blocked (ssh, gnupg, pando/identities, aws/credentials)
  - User memory: `~/.pando/memory/user-memory.md` read/write
- ✅ `GET /v1/local/status` — indexed dirs, file count, paths
- ✅ `POST /v1/local/index` / `DELETE /v1/local/index` — grant/revoke directories
- ✅ `GET /v1/local/search?q=` — FTS5 full-text search
- ✅ `GET /v1/local/file?path=` — read file (guarded)
- ✅ `GET/POST /v1/local/memory` / `GET /v1/local/memory/file` — user memory API
- ✅ AgentManager wired: `setLocalEnv()` — user-memory.md prepended to agent spawn prompt
- ✅ TUI: `/index`, `/unindex`, `/local`, `/memory` commands
- ✅ bootSteps['local-env'] tracking in NodeHealth

**v2.4: Active Tripwire — COMPLETE (2026-02-26)**
- ✅ CREDENTIAL_MASTER_KEY deleted from process.env after loading (key is now memory-only)
- ✅ CredentialStore.wipe() — zeros out Buffer, disables all subsequent decryption
- ✅ GossipSub topic `pando/node-compromised` — publish + subscribe across P2P
- ✅ PandoNode.triggerLocalCompromise(reason) — wipes key + broadcasts compromise
- ✅ Receiving node_compromised: removes compromised peer from credential routing
- ✅ POST /v1/admin/wipe-credentials — emergency admin trigger endpoint

**v2.3: NodeHealth + Boot Tracking — COMPLETE (2026-02-26)**
- ✅ `OperationalMode` (1|2|3) + `BootStepStatus` + `NodeHealth` added to @pando/shared
- ✅ `PandoNode._computeBootHealth()` — derives health from initialized fields at end of _start()
- ✅ `PandoNode.getNodeHealth()` — safe copy getter
- ✅ `GET /v1/status` now includes `health: NodeHealth` field
- ✅ E2E confirmed EC2-1: mode=2, kernel=healthy, core=healthy, platform=degraded (compute node expected)
- ✅ Per-step bootSteps map: ledger/network/sync/governance/security/request-reply/storage/resource-registry/upgrade-protocol/api-server/scheduler/monitor/agents/thread-store/content

**v2.2: API Versioning — COMPLETE (2026-02-26)**
- ✅ HTTP: All routes prefixed /v1/ via Fastify register
- ✅ P2P: MESSAGE_VERSION=1 stamped on all outbound messages; forward-compat warning on receive

**v2.1: Layer Separation — COMPLETE (2026-02-26)**
- ✅ Directory structure: `kernel/`, `core/`, `platform/`, `api/`, `api/middleware/`
- ✅ api-server.ts: 7292→887 lines (kernel-api.ts 2249L, core-api.ts 370L, platform-api.ts 3882L)
- ✅ AI Backend interface: ClaudeBackend + OllamaBackend via AIBackendRegistry
- ✅ Import boundary lint: check-imports.mjs passes clean
- ✅ All 5 nodes running v2.3 master

**Phase 88: Auto-Detect Tier from Code — COMPLETE (2026-02-25).**
Tier is now detected from the actual code at deploy time on the compute node, not guessed by the doorman AI. `detectTierFromCode(appDir)` inspects package.json (start script, server deps, main entry, backend/ dir) after git clone. If detected tier differs from the project's stored tier, the compute node uses the detected tier and the caller auto-corrects the project record. Doorman's tier remains as a hint for agent context.
- **Detection logic**: No package.json → Tier 1. Start script → Tier 2. Server deps (express, fastify, socket.io, ws) → Tier 2. `main` points to server file → Tier 2. backend/ dir → Tier 2. Default → Tier 1.
- **Response**: Deploy handler returns `detectedTier` and `tierReason` — caller updates `project.tier` to match.
- **Tier transitions**: Handled implicitly — PM2 kill on redeploy, S3 overwrites on re-upload.

**Phase 87: P2P Deploy Discovery — COMPLETE (2026-02-25).**
Deploy endpoint (`POST /projects/:id/deploy`) no longer uses CloudInstanceManager. Instead, it discovers compute peers via CapabilityProfile P2P broadcast — the same pattern P2PStorageBackend uses for storage routing. This fixes the root architecture gap where persistent EC2 nodes couldn't be found for deployment.
- **Deploy**: Filters CapabilityRegistry for `storageBackend === 'mongodb'` peers, tries up to 3 via `requestReply.request(peerId, 'pando/deploy-app', ...)`. Stores `deployPeerId` on project (not `instanceId`).
- **Undeploy**: Reads `project.deployPeerId` directly — no CloudInstanceManager lookup needed.
- **publicAddress**: New field on CapabilityProfile, set via `PUBLIC_IP` env var on EC2 nodes. Used for Tier 2 URL construction (`http://<publicAddress>/apps/<id>/`).
- **Bootstrap mesh**: Added EC2-1 to `DEFAULT_BOOTSTRAPS` — new nodes connect to 2 bootstrap peers instead of 1.
- **AgentManager**: `setCloudInstanceProvider` → `setComputeNodeProvider` — agent context shows P2P compute peers, not just tracked instances.

**Phase 86: JWT Auth — Stateless Cross-Node Authentication — COMPLETE (2026-02-25).**
Replaced MongoDB session-based auth with self-verifying JWT tokens signed by each node's Ed25519 private key. Verification uses `peerIdFromString().publicKey.verify()` — no ledger or MongoDB lookup needed. Cross-node auth now works (any node can verify tokens issued by any other node).
- **JWT session tokens**: Signed by issuing node's Ed25519 key, contain userId/peerId/issuer/expiry. Verified by extracting public key from peerId embedded in token.
- **Stateless challenge tokens**: Challenge-response auth uses JWT challenges instead of in-memory nonce map. No server state needed.
- **11/11 cross-node auth tests passing**: Full test coverage including cross-node JWT verification via `peerIdFromString()`.
- **Dead code cleanup DONE**: Removed 267 lines of legacy session auth code — `auth_sessions` table, `validateSession()`, `refreshSession()`, `cleanupExpiredSessions()`, `startCleanup()`/`stopCleanup()`, `generateToken()`, `getProfile()`, `logout()`, old `claim()`. `user-accounts.ts` went from 865 to ~600 lines. All callers updated.

**5-Node E2E Test Results (2026-02-25):**
| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | Dead code cleanup | PASS | 267 lines removed, deployed to all 5 nodes, all build+restart OK |
| 2 | Chat via untrusted nodes | PASS | LS-1/LS-2 proxy to EC2 via P2P, cross-node thread reads work |
| 3 | Node failover | PASS | Kill EC2-1 → LS-1 survived (had EC2-2), LS-2 degraded (single peer). Auto-reconnect ~30s |
| 4 | Governance proposal P2P | PASS | Proposal created on Windows, propagated to 5/5 nodes, voted from EC2-1, decision propagated to 5/5 |
| 5 | Cross-node JWT (gateway) | PASS | Guest created via Vercel gateway (EC2-2), JWT verified on EC2-1 and LS-1 |
| 6 | Gateway UI | PASS | Home, Governance (90 proposals), Marketplace, Wallet all render correctly |
| 7 | Deploy Tier 1 (S3) | **PASS** | Phase 87: LS-1 → P2P discovery → EC2-1 → S3 upload. URL: `s3-website.../c57e2439.../index.html` (200 OK) |
| 8 | Deploy Tier 2 (EC2) | **PASS** | Phase 87: LS-1 → P2P discovery → EC2-1 → PM2+nginx. URL: `http://54.82.241.132/apps/e58fcfe5.../` (200 OK). publicAddress correct. |
| 9 | publicAddress in CapabilityProfile | **PASS** | EC2-1: `54.82.241.132`, EC2-2: `34.201.82.126`. LS nodes: NONE (correct). |
| 10 | Undeploy via deployPeerId | **PASS** | LS-1 → undeploy → returns success. Project record cleared. |
| 11 | Bootstrap mesh (2 peers) | **PARTIAL** | EC2-1: 3 peers. LS-1: 2 peers. EC2-2/LS-2: 1 peer (still connecting). |

**Phase 83: Network Hardening — P2PStorageBackend + Two-Tier Trust — COMPLETE (2026-02-25).**
Transformed the network from "dev mode where everybody has everything" to the real two-tier trust architecture. Untrusted nodes (no MongoDB, no master key) proxy all storage operations via P2P to compute nodes with MongoDB. Every node gets a StorageBackend — no more 503s.
- **P2PStorageBackend**: New `StorageBackend` implementation that proxies 6 CRUD methods via `pando/storage-proxy` P2P handler
- **Lightsail running as untrusted node**: `storageBackend=p2p`, `credentialAccess=false`, no MongoDB env vars
- **E2E verified**: Chat threads, messages, projects all work via P2P proxy on Lightsail
- **5 bugs found and fixed**: (1) startup peer wait race — added 30s grace period, (2) loadFromBackend crash — wrapped in try/catch, (3) agent-message 8KB payload limit → 256KB for storage proxy responses, (4) cross-node cache staleness — EC2 refreshes ThreadStore cache after proxy writes, (5) deferred data loading — `_p2pDataLoaded` flag + auto-retry when first compute peer connects
- **EC2 process management**: Migrated from raw process to systemd service (`pando-node.service`) — auto-restart on crash, auto-start on boot, env vars in unit file
- **EC2 failure resilience**: P2PStorageBackend auto-fails over to next compute peer (Windows backed up EC2 during downtime test — all data persisted)
- **18/18 E2E tests passing**: Node health (4), Thread CRUD via P2P (4), Projects (2), Network capabilities (2), Governance (1), Scheduler (1), Monitor (1), Resources (1), AI Chat (2)
- Plan: `genome/flows/phase83-hardening-plan.md`

**Phase 82: Simple Self-Upgrade — Git Pull + Hash Verification — COMPLETE (2026-02-25).**
Replaced the complex Phase 73/81 patch-distribution system with simple `git pull` + hash verification. Deleted ~850 lines of canary, rollout, and patch code.
- **One upgrade path**: governance approves → commit hash broadcasts via GossipSub → all nodes `git pull` → verify hash → build → restart
- **Deleted**: canary monitoring, base64 patch distribution, `git apply`, reputation gates, post-deploy monitoring, 4 API endpoints
- **Kept**: governance auto-approve (dev mode ≤8 peers), version pinning, emergency rollback, upgrade history

**Phase 80: Production App Hosting — nginx + PM2 + Stable URLs + Undeploy — COMPLETE (2026-02-25).**
3 critical Tier 2 problems fixed:
1. **Port counter resets on restart** — replaced in-memory `nextAppPort` counter with persistent JSON port registry (`app-ports.json`). Ports survive node restarts.
2. **Apps die on reboot** — replaced `child_process.spawn({ detached: true })` with PM2 process management. Apps persist across reboots via `pm2 save` + `pm2 startup`.
3. **No undeploy** — new `POST /projects/:id/undeploy` endpoint + `pando/undeploy-app` P2P handler. Stops PM2 process, removes nginx config, clears port registry.
Plus:
- **Stable URLs via nginx** — apps served at `http://<ip>/apps/<projectId>/` instead of raw ports like `:3001`
- **nginx reverse proxy** on EC2 — per-app config in `/etc/nginx/pando-apps/<projectId>.conf`
- **Admin endpoints** — `POST /admin/migrate-apps` (redeploy from dead instance), `POST /admin/cleanup-projects` (soft-delete/archive)
- **Startup reconciliation** — compute nodes cross-check port registry with `pm2 jlist` on startup
- **Security group** — port 80 added for nginx (new instances get it in bootstrap)
- **Gateway UI** — Undeploy button on projects page, delete option for owners in marketplace
- **E2E verified**: Deploy → nginx URL accessible → Undeploy → 404 → Port stability (3001, 3002, ...) → Port registry persists

**Phase 79: Deploy Pipeline E2E Fixes — COMPLETE (2026-02-25).**
5 bugs fixed across api-server.ts and project-store.ts to achieve 22/22 E2E deploy tests passing:
1. **GitHub repo creation 404** — `POST /orgs/pando-lux/repos` returned 404 because PAT account is type "user", not org admin. Fix: check `accountType` from resource metadata; use `/user/repos` for user accounts, `/orgs/{org}/repos` for org accounts (api-server.ts ~line 6066)
2. **App repos always public** — repos were created private when project visibility was `owner_only`, but EC2 needs unauthenticated clone access. Fix: app repos are always `private: false`
3. **ProjectStore MongoDB field loss** — `updateProject()` read from SQLite (missing tier/deploymentPort/instanceId/githubRepo), converted to record, and overwrote MongoDB — losing MongoDB-only fields. Fix: new `persistProjectToMongo()` helper reads existing MongoDB record, merges with SQLite, preserves MongoDB-only fields. All 9 `putRecord('projects', ...)` calls now use this helper (except `createProject` which creates fresh records)
4. **Deploy endpoint silent failure** — when EC2 deploy handler returned `{ status: 'failed', error: '...' }`, api-server treated it as success because `response.success` was true. Fix: added check for `payload.status === 'failed'` after receiving P2P response
5. **S3 storage_blob resource** — no `storage_blob` resource existed in ResourceRegistry; existing credential lacked bucket info. Fix: created proper S3 credential with accessKeyId/secretAccessKey/region/bucket, registered as `storage_blob` resource, revoked broken duplicate
- **22/22 E2E tests passing** (twice consecutively)
- Tier 1: Create project, preflight, GitHub push, P2P deploy to EC2, S3 upload, URL accessible, env vars injected, content correct
- Tier 2: Create project, preflight, GitHub push, P2P deploy to EC2, npm install, app started, health check, all env vars injected

**Phase 78: Git Pull Upgrade + Tree Hash — SUPERSEDED by Phase 82.**
- Original: git pull + tree hash verification. Replaced by Phase 82's simpler approach.

**Phase 73: P2P Self-Upgrade Protocol — SUPERSEDED by Phase 82.**
- Original: patch distribution via GossipSub + `git apply`. Replaced by Phase 82's git pull + hash verification.
- What survives: governance auto-approve (`setUpgradeAutoApproveThreshold()`), `onUpgradeApproved()` callback, `TOPIC_UPGRADES` constant, `hasApplied()`/`findByGovernanceId()` for dedup.
- See `genome/flows/p2p-upgrade.md` for current architecture.

**Phase 70: Unified App Platform — COMPLETE (2026-02-24).**
- Unified deploy endpoint `POST /projects/:id/deploy` replaces separate `pushToGitHub()` + `deployAgentWorkspace()` (both removed from agent-manager.ts)
- GitHub push via `POST /projects/:id/github/push` uses `code_repository` resource PAT → `pando-lux` org
- `GET/POST /projects/:id/preflight` auto-assigns `code_repository` alongside `storage_db`
- EC2 URL fix: `deployApp()` reads `payload.port` from P2P response → constructs `http://{ip}:{port}/`
- S3 URL fix: `getHostedUrl()` returns actual S3 website endpoint (not gateway `/apps/` route which doesn't exist)
- Doorman stores `tier` at project creation time (`DeploymentTier` type in types.ts)
- Agent security: `CREDENTIAL_MASTER_KEY` and `PANDO_STORAGE_URL` stripped from agent child process env
- Fixes E2E gaps: GAP-1 (S3 URL), GAP-2 (EC2 URL), GAP-3 (GitHub push), GAP-5 (auto-assign), GAP-7 (GitHub identity), GAP-11 (tier field), GAP-15/16 partial (credential stripping)

**Phase 69: Secure Credential Architecture — IMPLEMENTED (2026-02-24).**
- Two-tier trust: EC2 compute nodes (trusted, tripwired) vs user nodes (untrusted)
- CredentialStore: MongoDB-based encrypted credential CRUD with AES-256-GCM + master key
- ResourceRegistry: rewritten as metadata-only P2P registry (no encryption, no wrappedKeys)
- P2P routing: `pando/ai-query` handler — user nodes route AI requests to compute nodes
- `CREDENTIAL_MASTER_KEY` env var injected into EC2 user-data at launch
- CapabilityProfile.credentialAccess flag for routing decisions
- Removed: envelope encryption, X25519 ECDH wrapping, autoWrapForPeer, resource_update_keys
- **Existing resources must be re-contributed** (old wrappedKeys data incompatible)
- Full protocol: `genome/rules/credential-security.md`

**Phase 68: Launch Readiness — ALL DONE (2026-02-26).**
- 68.1: Collection Namespace Isolation — DONE
- 68.2: GitHub Push Identity — DONE
- 68.3: Doorman / OpenAI Router — DONE
- 68.4: Returning User Routing — DONE (2026-02-26)
  - "Your Projects" sidebar section in chat page (non-guest users)
  - Fetch from `/api/projects` at auth time
  - Click project → `openProject()` loads project's thread or starts project-scoped chat
  - `activeProjectId` state routes messages to project's manager agent
  - Purple project icon + name in chat header when project active
  - "✕ Project" button to exit project context
- Legacy cleanup: DONE

**Phase 67: Self-Upgrading Network + Tier 2 E2E — COMPLETE (2026-02-23).**
- P2P node upgrade: `pando/upgrade-node` request-reply handler — pull, build, restart via P2P
- UPGRADE_REQUEST GossipSub handler: governance upgrades propagate to all nodes automatically
- `POST /instances/:id/upgrade` API + `/upgrade-instance` TUI command
- Git strategy: `git fetch + reset --hard` (handles orphan-branch force pushes)
- Launcher fixes: exit code 75 handling, GATEWAY_PUBLIC_URL in all launchers
- Request-reply envelope fix: unwrap `msg.agentMsg` before checking `messageKind`
- Tier 2 deploy env var injection: PROJECT_API_KEY, RESOURCE_PROXY_URL, GATEWAY_URL auto-injected
- Manager template: "never override user's explicit tier request", compute instance context injection
- **Tier 2 E2E PASSED:** chat → manager (Tier 2 classification) → builder (Express server) → P2P deploy to EC2 → app live at 100.53.198.66:3001 → data persists in MongoDB → marketplace listed

**Phase 66: Autonomous App Pipeline — COMPLETE + E2E TESTED (2026-02-23).**
- Agents can now autonomously create projects via Bearer token (dual-auth on `POST /projects`)
- `GET /resources?type=storage_db` — resource filtering by type
- `GET/POST /projects/:id/preflight` — pre-flight check with auto-fix (generates API key, assigns MongoDB)
- `POST /projects/:id/validate-deploy` — post-deploy health check (URL responds, injection verified, Resource Proxy works)
- Deploy pipeline: S3 deploy → GitHub push (source code durability) → marketplace listing (auto-updates project record)
- GitHub push uses contributed `code_repository` resource — creates repo under token owner's account (uses `user/repos` endpoint; falls back to org endpoint only when org is specified in resource metadata)
- Agent workspace hydration: new agents clone from GitHub if project has `repoUrl` (solves node-goes-down problem)
- Manager template: fixed `resourceType` → `type` field name, added Quick App Setup workflow with preflight
- Builder template: added post-deploy validation step, deploy instructions
- Workspace cleanup is safe with GitHub as durable store (24h→idle, 30d→archive, 180d→delete)
- **E2E tested — 4 fixes applied during testing:**
  1. `console.warn` not captured by FileLogger → changed to `console.log` (FileLogger only patches log/error/debug)
  2. GitHub push: uses `user/repos` endpoint (not org) when no org specified in resource metadata
  3. validate-deploy: uses direct S3 URL (not gateway proxy URL) for reliable health check
  4. validate-deploy: uses `pando_health` collection (not `__preflight_test` which was rejected by Resource Proxy collection validation)

**Phase 65: Secure App Hosting E2E — COMPLETE (2026-02-23).**
- Secure App Hosting verified end-to-end for both S3 (Tier 1) and EC2 (Tier 2)
- Test app (`tests/test-app/index.html`) proves apps can use MongoDB through Gateway Resource Proxy without ever seeing credentials
- New endpoints: `POST /apps/:appName/deploy` (auth required, deploys static files), `GET /apps/:appName/*` (serves static files with URL injection)
- CloudInstanceManager: auto-link compute instances by IP on P2P connect, bootstrap skips `tsc` build (uses pre-built dist from public repo), seeds API token for remote management, deploys test app from repo, sets `GATEWAY_PUBLIC_URL` env var, injects `CREDENTIAL_MASTER_KEY` for credential access
- Resource Proxy: ObjectId conversion for `_id` filters
- API server: URL injection added to `POST /projects/:id/hosting`

**Phase 64a: Secure Cloud Instances + Node Specialization — BUILT + E2E TESTED (2026-02-23).**
- `CloudInstanceManager` class: launch/manage/terminate EC2 from contributed AWS creds
- `NodeMode` (full|compute|relay), `LedgerMode` (full|light) type system
- User-data bootstrap: Node.js 22, git clone from public repo, remove SSH+SSM, tripwire
- Security monitor (tripwire): detects logins/sshd/SSM/debuggers, wipes and shuts down
- Console output endpoint: `GET /instances/:id/console` — monitor instances without SSH
- TUI: `/launch`, `/instances`, `/terminate` commands
- API: 7 instance endpoints (list, get, launch, terminate, health, console, deploy)
- CLI: `--mode full|compute|relay`, `--ledger-mode full|light`
- **E2E TEST PASSED**: EC2 instance bootstrapped from `pando-lux/pando` public repo, built Pando, started node, connected to Lightsail P2P peer, API responded on port 4000
- 8 bugs found and fixed during testing (see `genome/components/cloud-instance-manager.md`)

**Public repo**: `https://github.com/pando-lux/pando` — open source, clean history (orphan branch), no identity leaks, no secrets. All future code pushes use `pando-lux` author identity.

**Phase 64 security superseded by Phase 69** — old envelope encryption (X25519 ECDH wrappedKeys) replaced with two-tier trust architecture (EC2-only master key + MongoDB). Split-key (64b) and hardware enclaves (64c) layer on top of Phase 69. Full protocol: `genome/rules/credential-security.md`.

**Phase 63 fixes (2026-02-23):** 4 E2E pipeline bugs fixed and deployed to Lightsail. (1) Write-through bridge now registers API keys to P2P registry. (2) URL injection includes all 3 variables (GATEWAY_URL, PROJECT_ID, PROJECT_API_KEY). (3) Agent auth bypass for project endpoints (agents can generate API keys and assign resources). (4) Templates updated for all 3 injected variables. Commit `b4db919`.

**Phase 57: Clean Data Architecture — DONE.** Eliminated dual-write architecture. MongoDB is single source of truth for user data. LocalStorageBackend deleted. All user data stores (ProjectStore, RevenueEngine, ContributionTracker, ThreadStore) require StorageBackend (MongoDB). Write pattern: MongoDB-first with await, then SQLite cache update. Nodes without MongoDB return 503 for user data endpoints. SQLite tables kept as read-performance cache, hydrated from MongoDB on startup via `loadFromBackend()`.

**Phase 56: P2P User Accounts — DONE.** Auth data (username, password_hash, is_claimed) moved from per-node UserAccountStore to P2P-synced ledger accounts table. Account claims broadcast via GossipSub ACCOUNT_CLAIM. Login works from any node. MongoDB/StorageBackend removed from UserAccountStore. Local auth-local.db for key_store only (sessions replaced by stateless JWTs in Phase 86).

**Phase 55: Resource UX Simplification + User Ownership — DONE.** Service-first contribute form (6 presets: OpenAI, Anthropic, Gemini, MongoDB, AWS S3, Other). Resources owned by users (userId), not nodes (providerPeerId). Login required to contribute. TUI `/contribute <service> <key>` with service mapping. See details below.

**Phase 57b: Resource Contribution Guide — DONE.** Gateway `/resources/guide` page with step-by-step tutorials for all 5 providers (OpenAI, Anthropic, Gemini, MongoDB Atlas, AWS S3). Includes signup URLs, free tier info, reward amounts. TUI `/contribute mongodb` now shows restart hint. TUI `/contribute aws` supports JSON credentials with field validation. Links added from Resources page and Services page.

**Phase 57c: Resource & Gateway Fixes — DONE.** TUI `/contribute` now passes `userId` from linked user account so resources appear in "My Resources". Gateway `NodeConnection.authHeaders()` re-reads API token on each request (was cached at construction, causing stale token errors after node restart). Verified via Playwright: login as `pando`, AWS S3 contribution via gateway form succeeds, guide page renders correctly.

**Phase 57d: Auth UX Cleanup — DONE.** Replaced confusing "Claim Account" flow with clear Login/Sign up. NavBar: guests see "Login" + "Sign up" buttons, logged-in users see username + "Logout". New `/register` page (username + password + confirm). Login page links to `/register`. Deleted legacy `/claim` page. Resources page: "My Resources"/"My Nodes" hidden when not logged in, replaced with login prompt.

**Phase 58: Resource Architecture Cleanup — DONE.** Removed ALL env var API key fallbacks (`process.env.OPENAI_API_KEY`, `GEMINI_API_KEY`, etc.) from search, capability-detector, and api-server. API keys now ONLY come from ResourceRegistry (encrypted, P2P-synced). If no AI key contributed, search returns "No AI resources available." Added `updateResourceUserId()` to ResourceRegistry + `PATCH /resources/:id/owner` endpoint so existing resources can be linked to user accounts. Gateway resources page has "Link to my account" button for unlinked resources from the local node.

**Phase 58b: My Nodes Fix + Guest Permission Lockdown — DONE.** Fixed "My Nodes" showing 0 on Resources page. Root cause: dead `/auth/me/nodes` API endpoint removed in Phase 56 but gateway still called it. Fix: deleted dead gateway proxy route (`app/api/auth/me/nodes/route.ts`), rewrote "My Nodes" to use `/api/status` `linkedUser` field. Now shows the local node as "yours" when `linkedUser.username` matches logged-in user, with live uptime and peer count. Added `linkedUser` and `uptime` fields to gateway `NodeStatus` type and `getStatusAsync()`. Also fixed guest permission bugs: "Link to my account" button now requires `isClaimed` AND resource must have no existing `userId` (already-owned resources can't be claimed by anyone). Contribute form gate changed from `!user` to `!isClaimed`. Revoke button in network resources section requires `isClaimed`.

**Phase 59: Complete Resource Ecosystem — DONE.** Added `code_repository` to ResourceCredentialType. Gateway contribute form: added GitHub (code_repository) and AWS Compute EC2/Lambda (cloud_compute) service presets. TUI: added `github`, `ec2`, `lambda` service aliases. Guide page: 2 new sections — GitHub (PAT), AWS Compute (IAM). Note: `agent_runtime` was also added in Phase 59 but subsequently removed in Phase 60 (wrong abstraction — Claude Code is a node capability, not a shareable resource).

**Phase 60: Unified Contributions — Fix Capability vs Resource Architecture — DONE.** Removed `agent_runtime` from ResourceRegistry (wrong abstraction — Claude Code auth is machine-local, not a shareable credential). Added `linkedUser` to CapabilityProfile broadcasts — when a user logs in via TUI `/login`, the node's capability profile now includes `linkedUser.username` and rebroadcasts to all peers. New API: `GET /network/capabilities/user/:username` filters by linked user. Gateway Resources page: "My Nodes" now shows ALL user's nodes from network capabilities (not just local node), each with capability tags (Claude Code in violet). TUI `/contribute claude-code` replaced with redirect message. Legacy `agent_runtime` records filtered from UI display. Guide page: Claude Code section reframed as node setup (install, authenticate, auto-detected, shows in My Nodes).

**Phase 60 bug fixes — comprehensive QA sweep (post-release):**
- Fixed capability TTL: local node's own profile never expires in `getAllProfiles()` and `cleanup()`.
- Fixed `GET /network/capabilities` to include local node's own profile.
- Added runtime validation to `POST /resources/register` rejecting `agent_runtime` type.
- Fixed `GET /chat/threads/:id` to use async `getMessagesAsync()`.
- **CRITICAL: Fixed GUEST_WELCOME Lux farming exploit.** Welcome bonus moved from `POST /auth/guest` (called on every page load) to `POST /auth/claim` (called once at registration). Guests get 0 Lux; welcome bonus only on account registration. Extra guard: checks balance > 0 before minting.
- **CRITICAL: Fixed project creation "Invalid session token".** ~30 handlers (projects, threads, resources, collaborators) used `validateSession()` which only checked SQLite sessions table. Replaced with `resolveUserPeerId()` which handles BOTH signature-auth tokens (in-memory Map) and session tokens.
- **HIGH: Fixed wallet transfers from wrong account.** Transfer handler now checks X-User-Token and transfers from authenticated user's peerId, not the node identity. Gateway sends auth token with transfer requests.
- **HIGH: Fixed navbar showing peer ID instead of username.** `GET /auth/me` signature-auth path now looks up username from ledger accounts table.
- **MEDIUM: Fixed Economy page showing "0 Lux".** Now uses auth context for user balance when logged in, falls back to node balance for guests.
- **MEDIUM: Fixed Resources page auth hydration flash.** Added skeleton loader while auth hydrates.
- **MEDIUM: Fixed Capacity page "10000%" success rate.** API returns percentage in 0-100 range; removed duplicate ×100 multiplication.
- **MEDIUM: Fixed wallet transactions not showing for user accounts.** GET /transactions now uses resolveUserPeerId() to return the authenticated user's transactions.
- **LOW: Logout now redirects to /login.**

**FIXED: Ledger sync — welcome bonus divergence.** Previously, `applyRemoteClaim()` created accounts with balance 0, causing totalSupply divergence. Fix: ACCOUNT_CLAIM now includes balance, `applyRemoteClaim()` adjusts balance and totalSupply to match. Catch-up sync also includes balance for claimed accounts.

**Phase 61: Production Polish + E2E Pipeline Verification — DONE.**
- **Ledger sync divergence FIXED**: ACCOUNT_CLAIM includes balance, `applyRemoteClaim()` adjusts balance + totalSupply. Catch-up sync includes balance for claimed accounts. 4 files modified (accounts.ts, sync.ts, user-accounts.ts, api-server.ts).
- **Dead code cleanup**: Removed unused Database import, dead PCL_SYNC types, NodeConfig.apiKey/maxMonthlyApiCost fields, dead routeInput/confirmInput/getStatus methods from gateway, agent_runtime filter dead code. Renamed misleading stripAnsi→stripAnsiLength.
- **New /search page**: Gateway search page with AI search integration + NavBar link.
- **Services page fix**: Fixed all services showing "Unknown" status. Root cause: no fetch timeout + all-or-nothing loading + wrong loading gate. Now shows real status (Online/Limited/Unknown).
- **Resources page**: Hide revoked resources by default with "Show N revoked" toggle. Stats count only active resources.
- **Task auto-expiry**: Open tasks >48h auto-expire. Done/rejected/expired tasks >7d auto-delete. Cleaned 69 stale test tasks.
- **Marketplace auto-publish**: Deploy endpoint auto-sets project visibility to 'listed'. Creates project in ProjectStore if missing.
- **Chat sidebar fix**: Encrypted Base64 thread titles now show "Encrypted conversation" fallback.
- **CLAUDE.md cleanup**: Removed references to deleted files (memory-sync.ts, task-database.ts, file-registry.ts, user-identity.ts).
- **Genome docs updated**: capability-registry.md, resource-registry.md, tui.md, state.md all current.

**Full E2E Agent Pipeline Test — VERIFIED:**
- User registered via gateway → chatted with Manager → Manager spawned Builder + QA
- Builder produced 685-line Guestbook app with RESULT.md + REFLECT step
- QA verified 11 requirements with line-number citations → APPROVED
- App deployed to S3: `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/pando-node/index.html`
- Follow-up feature request REUSED same Builder (tasks 1→2, no re-spawn) + spawned new QA
- v2 QA performed Playwright browser testing with screenshots
- Protocol (genome/protocol.md) confirmed injected as Layer 0 in all agent CLAUDE.md files
- Final agent tree: 4 agents (1 Manager, 1 Builder, 2 QA)
- **Remaining gap**: S3-hosted apps can't reach Resource Proxy (static hosting, no API backend). Apps needing MongoDB must be served through gateway or use gateway URL for API calls.

**Phase 62: App Hosting Architecture + URL Injection — DONE.**
- Created 3-tier app hosting architecture doc (`genome/flows/app-hosting.md`): Tier 1 (S3 + gateway URL injection), Tier 2 (EC2 compute), Tier 3 (node-hosted, future)
- Implemented gateway URL injection in `deployAgentWorkspace()`: injects `window.PANDO_GATEWAY_URL` and `window.PANDO_PROJECT_ID` into all HTML files before S3 upload
- Updated protocol.md v1.1: all Resource Proxy fetch examples now use `window.PANDO_GATEWAY_URL` (required for cross-origin S3 apps)
- Updated manager + builder templates with deployment decision tree and URL injection docs
- EC2 instance (t3.small, `3.89.139.27`) configured with Node.js 22 + nginx, registered as `cloud_compute` resource (`bc17780e`)
- MongoDB Atlas registered as `storage_db` resource (`66c511ea`)
- Security group opened for public access (ports 80, 443)
- Decision matrix for managers: Tier 1 (default for static/CRUD), Tier 2 (WebSocket/real-time only)

**Active Resources (7 — Phase 69 re-contributed):**
| ID (short) | Type | Label | Owner |
|---|---|---|---|
| 838a886c | ai_api_key | OpenAI | pando |
| 31a58ed8 | storage_db | MongoDB | pando |
| 4eb2758d | storage_db | MongoDB Atlas (Pando Main) | pando |
| 4ba9b20a | storage_blob | AWS S3 | pando |
| 406226f0 | code_repository | GitHub | pando |
| 38982f1e | cloud_compute | EC2 t3.small (App Hosting) | pando |
| c4fd87d7 | cloud_compute | AWS EC2 Admin (launch instances) | pando |

All credentials stored encrypted in MongoDB `pando_credentials` collection. Decryptable only with `CREDENTIAL_MASTER_KEY` (set on this node and injected into EC2 instances at launch).

**Next:** Phase 68 (Launch Readiness). Phase 64b (split-key) layers on top of Phase 69.

### Phase 63: P2P Project Registry (2026-02-22)
- New `ProjectRegistry` class: SQLite + GossipSub sync on `pando/projects` topic
- API keys stored as SHA-256 hashes — any node can validate without MongoDB
- Catch-up sync via LedgerSync (piggybacking on SYNC_REQUEST/SYNC_RESPONSE)
- Resource Proxy validation: P2P-first lookup, MongoDB fallback
- Write-through bridge: ProjectStore → ProjectRegistry on create/update/archive
- Existing projects seeded to P2P on startup from SQLite cache
- Richer project records: deploymentUrl, deploymentType, description for marketplace
- Protocol + templates updated with tier selection guidance

### Phase 57: Clean Data Architecture (2026-02-22)

Eliminated dual-write architecture. MongoDB is now the single source of truth for all user data.

**Changes:**
1. **LocalStorageBackend deleted** — `storage-backend.ts` now contains only the `StorageBackend` interface. No filesystem fallback.
2. **MongoDB-primary writes** — All user data stores (ProjectStore, RevenueEngine, ContributionTracker, ThreadStore) now `await` MongoDB writes first, then update SQLite cache. No more fire-and-forget.
3. **StorageBackend required** — Constructor signatures changed from `storageBackend?: StorageBackend` to `storageBackend: StorageBackend`. Stores throw or return 503 without it.
4. **Real `loadFromBackend()`** — On startup, stores hydrate SQLite cache from MongoDB. Replaces the old no-op log-only method.
5. **503 for missing backend** — API endpoints that serve user data return 503 Service Unavailable when StorageBackend is not configured. P2P features (ledger, governance, resources) still work.
6. **ThreadStore simplified** — Constructor takes `StorageBackend` only (no `db` param, no filesystem fallback). All reads/writes go through MongoDB.

### Phase 56: P2P User Accounts (2026-02-22)

Auth data moved from per-node UserAccountStore to P2P-synced ledger. Login works from any node.

**Changes:**
1. **Ledger schema** — Added `username`, `display_name`, `password_hash`, `is_claimed` columns to ledger accounts table. New methods: `claimAccount()`, `applyRemoteClaim()`, `getByUsername()`, `getAuthFields()`, `isUsernameAvailable()`, `getClaimedAccounts()`.
2. **P2P account sync** — `ACCOUNT_CLAIM` message type broadcast via GossipSub on claim. Claimed accounts included in `SYNC_RESPONSE` for catch-up. Username conflict: first-come-first-served by timestamp.
3. **UserAccountStore rewrite** — Constructor takes `PandoLedger` instead of `StorageBackend`. All MongoDB code paths removed. Auth (username, password_hash, is_claimed) delegates to ledger. Local `auth-local.db` stores `auth_sessions` + `key_store` only.
4. **Node wiring** — `UserAccountStore` instantiated with ledger in `index.ts`. Broadcast claim callback wired after sync start.
5. **API cleanup** — Removed duplicate `ledger.registerNode()` calls. Removed `/auth/me/nodes` endpoints (Phase 48 linked-nodes concept superseded).

### Phase 55: Resource UX Simplification + User Ownership (2026-02-22)

Service-first resource contribution UX. User-based resource ownership model.

**Changes:**
1. **Service presets** — Gateway contribute form replaced raw type dropdown with 6 service presets (OpenAI, Anthropic, Google Gemini, MongoDB, AWS S3, Other). Dynamic credential fields per service (1 field for most, 2 for AWS S3). Optional label tag.
2. **User-owned resources** — `userId` field added to ResourceRecord. Resources belong to users (gateway accounts), not nodes (peerIds). A user can run 100 nodes with the same API keys. `providerPeerId` kept for P2P encryption routing only. `resolveUserPeerId()` extracts userId from auth tokens.
3. **Login required to contribute** — Unauthenticated users see a login prompt. Auth token forwarded via `X-User-Token` header through gateway proxy routes to node.
4. **Revoke uses userId** — `revokeResource(id, userId)` checks userId ownership OR node ownership. Gateway forwards user token for revoke operations.
5. **"My Resources" uses userId** — Gateway page filters on `r.userId === myUserId` instead of `r.providerPeerId`.
6. **TUI service mapping** — `/contribute <service> <key>` maps service names (openai, anthropic, gemini, mongodb, aws, s3) to types + metadata. Unknown names show error with valid list (no backward-compat fallback).
7. **Removed from UI** — Price per Unit, Model dropdown, Provider dropdown, raw type selector.
8. **SSE spam fix** — Moved `sseClients.size === 0` early-return before console.log to suppress pointless `[sse] push → 0 clients` logging.
9. **Launcher fix** — `start-node.bat` and `start-node.command` now use `tui.js` (interactive) instead of `cli.js` (headless).

### Phase 54: Zero-Config Node + Legacy Cleanup (2026-02-22)

Zero-config experience for node operators. Delete legacy patterns.

**Changes:**
1. **Auto-connect bootstrap** — `DEFAULT_BOOTSTRAPS` now uses Lightsail public IP (`54.145.144.221`). Any new node auto-connects to the network without `--bootstrap` flag.
2. **Peer persistence** — Connected peers saved to `~/.pando/known-peers.json`. On restart, node dials known peers + bootstrap. 7-day prune, 50-peer cap. `checkAndReconnect()` uses known peers when peer count drops to zero.
3. **Transfer to any valid peerId** — Auto-creates ledger account for any `12D3KooW*` format peerId. No longer requires recipient to be a connected peer.
4. **Node identity = reward recipient** — `getRewardRecipient()` returns node's own `identity.peerId`. Deleted `operatorPeerId`, `operatorToken`, `operatorUsername` fields and `setOperator()`/`clearOperator()`/`getOperator()` methods.
5. **TUI legacy login deleted** — Removed `/login`, `/register`, `/account` commands, `doLogin()`, `doRegister()`, `showAccount()`, `saveOperatorSession()`, `loadOperatorSession()`, `clearOperatorSession()`, `tryAutoLogin()` (~200 lines). `/logout` kept (clears identity session). All `/auth/*` API endpoints kept for gateway browser users.
6. **CLI flags cleanup** — `--auto-update` deleted entirely. `--storage` shows deprecation warning. `--scheduler`/`--monitor` unchanged (already auto-detect). Launcher scripts (`start-node.command`, `start-node.bat`) simplified.

### Phase 53: Full-Stack App Independence + Resource Proxy (2026-02-22)

Complete rewrite of app architecture. Apps are fully independent after deployment.

**Changes:**
1. **Protocol Memo System** — `genome/protocol.md` v1 is injected as Layer 0 at agent spawn and as reminder per bridge event. All agents get consistent architecture rules.
2. **Legacy deletion** — All `/apps/data` routes deleted (gateway + node). `gateway/lib/mongodb.ts` deleted. Phase 52 gateway-direct-MongoDB reverted.
3. **Resource Proxy** — `gateway/app/api/resource-proxy/db/route.ts`. Apps authenticate with X-Project-Key header. Gateway holds real credentials server-side. 9 MongoDB operations, rate limiting, caching, metering.
4. **Project resources** — Projects can have assigned resources (MongoDB, S3, etc.) and API keys for Resource Proxy auth.
5. **Templates rewritten** — 3 app patterns (static, data app with proxy, full-stack with env vars). Anti-patterns list. No `/apps/data` references.

### Phase 52: Cloud-Native App Architecture (2026-02-22)

Architectural restructuring (partially superseded by Phase 53).

**Changes:** Node app-data store deleted, clean URL delivery, scheduler auto-detection, templates rewritten. Gateway-direct-MongoDB was added then **reverted in Phase 53** (centralization problem).

### QA Sweep (2026-02-22)

Comprehensive 3-agent QA sweep across gateway (Playwright), TUI/API (curl), and deep 2-user flows.

**5 bugs found and fixed:**
| # | Severity | Fix |
|---|----------|-----|
| 1 | CRITICAL | `/auth/guest` rate limited to 5/min/IP — prevented infinite Lux farming |
| 2 | HIGH | Thread isolation — `GET /chat/threads` requires auth, returns only user's threads |
| 3 | HIGH | JSON parse errors return 400 instead of 500 |
| 4 | HIGH | Gateway `.env.local` port corrected (4000→4100) |
| 5 | HIGH | Balance shows real value after login (auth-context.tsx fetches from `/auth/me`) |

**4 design observations (not bugs — future work):**
- D1: Wallet transfers use node account, not user account (ledger is P2P between node IDs)
- D2: Network page stats show "--" briefly before data loads (no skeleton)
- D3: Services page shows "Unknown" availability (status not implemented)
- D4: Hydration warning on /explore page (React SSR mismatch)

**QA Framework** lives in `tests/qa/`:
- `context/pando.md` — app overview, pages, auth model, test accounts
- `context/deep-flows.md` — 24 test flows with backend verification pattern
- `results/` — per-run reports (gateway, TUI/API, deep QA)
- Designed for dynamic agent testing — agents read context, decide what to test, fix issues, retest
**Phase 38: Public Node AI Access + Service Catalog — DONE.** Lightsail has `--scheduler` + Claude Code (Max sub). Gateway `/services` page with 5 service cards (AI Chat, Project Building, AI Search, Storage & Hosting, Governance), live status badges from `/api/status` + `/api/capacity`, "How to Pay" section, provider earnings. NavBar "Services" link added.
**Phase 50: Network Council — DONE.** Council class (`council.ts`) with rotating selection of top-reputation AI-capable nodes, daily reflection prompt assembly (AI call stubbed), council minutes persistence, hourly tick scheduler. NetworkState aggregator (`network-state.ts`). Node API: `GET /council` (members, rotation info, this-node status), `GET /council/minutes` (rolling 30-entry log). Gateway: `/council` page (4 sections: rotation info cards, members table, council minutes, network state overview), `/api/council` + `/api/council/minutes` proxy routes, NavBar "Council" link. Auto-refreshes every 60s.
**Phase 49: Capacity Dashboard — DONE.** New `GET /capacity` endpoint on node aggregates supply (providers, prices from ResourceMarketplace), demand (usage from ResourceMeter, task metrics from Scheduler), rewards (rates, estimated daily earnings), and network health (nodes, accounts, supply from Ledger/HealthMonitor). Each subsystem call individually try/caught. Gateway: `/capacity` page with 5 sections (Network Overview, Supply, Demand, Reward Signals, Call to Action), auto-refreshes every 30s. Gateway proxy at `/api/capacity`. NavBar updated with Capacity link.
**Phase 48: Unified Identity — DONE.** One account everywhere. TUI and gateway use the same login (username+password). Operator state on PandoNode (operatorPeerId, operatorToken, operatorUsername). Auto-login via operator-session.json. TUI commands: /login, /register, /account. No login = no rewards (relay only). Node startup shows "Node #XXXX running". Gateway: My Resources + My Nodes sections on resources page, /api/auth/me/nodes proxy. Login timeout hardened (15s node-side, 20s browser-side).
**Phase 46: Project Lifecycle — DONE + E2E VERIFIED.** Fixed 3 routing bugs: (1) thread follow-ups hardcoded to pando-node-mgr, (2) POST /chat/message not storing projectId on thread creation, (3) POST /chat/threads not storing projectId (gateway chat flow). Added PATCH /chat/threads/:id endpoint. Added 3 project manifest fields (repoUrl, teamHistory, notes) for cross-node continuity. Manager template principle #11 (documentation IS knowledge transfer). Gateway: Open Chat button on projects, chat projectId awareness, marketplace proxy, thread PATCH proxy. **E2E verified:** thread creation stores projectId+type (PASS), follow-up routing goes to project-specific manager (PASS), PATCH endpoint works (PASS), gateway proxies work (PASS), browser-level chat with ?projectId creates project thread and routes to correct manager (PASS). Note: `--scheduler` flag required for agent system to start (AgentManager lives inside startScheduler()).
**Phase 44: Data Residency — DONE + QA VERIFIED.** All user data (projects, revenue, contributions — 12 SQLite tables, 12 MongoDB collections) migrated to StorageBackend. MongoDB-primary with SQLite cache (upgraded from dual-mode in Phase 57). Session validation unified — deleted legacy sync methods, single async path. 35 route handlers updated. QA verified: guest auth → project create → update → invite → rate → contribute → revenue all working with MongoDB active. See `genome/rules/data-residency.md`.
**Phase 43: Multi-Node Gateway — DONE + E2E TESTED + DEPLOYED (4a343ac, 8d13300).** Gateway discovers multiple backend nodes, health-checks them, routes requests to best available node, fails over automatically. NodePool (`lib/node-pool.ts`) manages nodes with circuit breaking (3 failures → 60s open). E2E tested: 2-node pool (Windows+Lightsail), failover when primary killed, auto-recovery on restart. Deployed to Vercel (`gateway-one-mu.vercel.app`) with `PANDO_NODES` env var. Fix: `@noble/curves` pinned to v1.x (v2 removed subpath exports, broke Turbopack).
**Phase 42.5: Resource Registry — DONE + E2E VERIFIED.** Network-level shared resources. Envelope encryption (X25519 ECDH + AES-256-GCM). ResourceRegistry class with GossipSub P2P sync, SQLite persistence. 5 HTTP API routes. Gateway resources page (contribute, list, revoke). Crypto roundtrip verified. Legacy `api-keys.json` loading deleted. search() method rewired to use ResourceRegistry with env var fallback.
**Phase 42: StorageBackend — DONE + E2E VERIFIED.** Nodes are stateless compute proxies. User data stored in MongoDB Atlas (threads, messages, accounts). StorageBackend interface with `pushToArray` for atomic message appends (MongoDB `$push`, no race conditions). ThreadStore and UserAccounts rewired. `--storage mongodb+srv://...` CLI flag. `/status` shows `storageBackend: "mongodb"`. E2E verified: 6/6 encrypted messages stored in Atlas, all encrypted at rest. Race condition fix: removed racy read→append→write, replaced with atomic `$push` via `pushToArray()`.
**Phase 41.5: Encryption Architecture Hardening — DONE + E2E VERIFIED (260e26a).** Per-request thread key delivery, encrypted key backup (PBKDF2+AES-GCM), unified claim+login flows.
**Phase 41: E2E Encrypted Chat — DONE + E2E VERIFIED.** AES-256-GCM, browser-side Ed25519 keypair, per-thread encryption, protobuf key fix (`subarray(4, 36)`).
**Phase 40: Signature-Based Auth — DONE + E2E VERIFIED.** Ed25519 challenge-response, any-node login.
**Phase 45: Operator Experience — DONE + E2E VERIFIED.** Gateway chat routes use `getNodeUrl('claude')` to prefer Claude-capable nodes. Node P2P fallback: `forwardChatToPeer()` forwards to Claude-capable peers when local node has no Claude Code. TUI resource management: `/resources` (list own + network), `/contribute <type> <value>`, `/revoke <id>`. 13/13 Playwright E2E tests pass (resources page + chat page).
**Phase 44 DONE:** Data Residency — 12 new MongoDB collections for ProjectStore, RevenueEngine, ContributionTracker. Session validation unified (deleted sync/async split).
**Phase 35: Guest Lux Faucet + Reclamation — DONE + E2E VERIFIED.** New guests get free Lux on signup (`WorkType.GUEST_WELCOME` = 25 base × early multiplier = up to 125 Lux for first 100 users). Unclaimed guest accounts older than 30 days have remaining Lux transferred back to NETWORK account, then identity deleted. Gateway chat page changed from blocking guest gate to welcoming message. Files: shared/types.ts, api-server.ts, user-accounts.ts, index.ts, gateway/chat/page.tsx.
**Phase 35 E2E Testing — 4 bugs found & fixed:**
1. Homepage "Lux Balance" showed node balance (7,633) not guest's (125) — page.tsx now uses AuthContext `user.balance`
2. Wallet showed node identity+balance — wallet/page.tsx now uses AuthContext `user.peerId`/`user.balance`, filters transactions by user
3. Chat sidebar leaked ALL users' threads — race condition: threads fetched before auth resolved, falling back to unfiltered list. Fixed: skip fetch until token available. Node-side `listUserThreads(userId)` added to ThreadStore.
4. Quick-tier "My Balance" returned node balance — api-server.ts `tryQuickTierResponse` now resolves user peerId from `X-User-Token` header. Gateway proxies forward user token to node.
All 4 fixes verified via Playwright: guest sees 125 Lux, own peer ID, empty thread list, correct quick-tier response.
**Phase 34: TUI Resilient Restart — DONE.** Node operators no longer see terminal windows blinking/closing during pipeline restarts. PandoNode gains `setRestartHandler()`/`getRestartHandler()` so callers (TUI, PM2) can intercept restarts. TUI sets the handler on startup — on restart it shows "Upgrading..." with changed file list, gracefully stops agents/node, then exits(75) so the launcher loop restarts the process. New `/upgrade` command: git fetch → check if behind → git pull → npm run build → restart. P2P upgrade notifications via `onUpgradeAvailable()` callback (TUI shows alert + "/upgrade" hint). `api-server.ts` pipeline restart now uses `getRestartHandler()` instead of direct `process.exit(75)`. TUI also now honors `--pipeline` flag. Files: index.ts, api-server.ts, tui.ts.
**Phase 33.5: PM2 Auto-Restart — DONE + E2E VERIFIED (5469a17).** Full autonomous cycle with PM2: message → governance → pipeline → commit → graceful shutdown (exit 75) → PM2 auto-restart → node comes back with new code live. Second autonomous pipeline commit: `5469a17 [pipeline] Extracted 2 change(s) from git diff` (monitorEnabled field). Smart restart detection: only restarts when packages/node/, packages/shared/, or packages/ledger/ source files change. Graceful shutdown: stops agents (10s timeout), closes node, then exit(75).
**windowsHide fix:** All 26 `spawn`/`execSync` calls across 9 files now use `windowsHide: true` to prevent visible terminal windows flashing on Windows. Harmless on other platforms.
**Phase 33.4: Full Autonomous Pipeline — DONE + E2E VERIFIED (0a6bcba).** The self-upgrading loop works end-to-end: user message → manager classifies as node change → builds fix → governance proposal → auto-vote → instant quorum (<10 nodes) → PASSED → pipeline triggered → git diff extracts changes → guardrails pass (governance bypass) → autonomous commit → process.exit(0) for restart. First fully autonomous pipeline commit: `0a6bcba [pipeline] Extracted 1 change(s) from git diff`. Remaining: 33.6 (attribution), 33.7 (project-level governance), 33.8-33.10 (cross-node). See `genome/roadmap.md` Phase 33.
**Phase 32.5: Agent-Driven Deployment — COMPLETE + E2E VERIFIED.** Deployment moved from hardcoded infrastructure (autoDeployIfReady in processNextBridgeItem) to agent-driven intelligence. New `POST /agents/:id/deploy` endpoint + `deployAgentWorkspace()` method + `POST /agents/:id/reset-session` endpoint for fresh starts. Manager template teaches when/how to deploy. Agent decides, calls the endpoint, tells user the URL. Public projects immediately accessible via permanent URLs. E2E verified: Manager builds web content, calls deploy endpoint, returns public URL to user.
**Context compression discovery:** Long-running sessions (100+ tasks on `--continue --resume`) compress CLAUDE.md instructions out of context. Solved by injecting critical instructions (deployment reminders) directly into every event prompt in `buildPromptFromBridgeItem()`. Event prompts are always in the most recent context and never compressed.
**Phase 32: S3 Hosting Service — COMPLETE + E2E VERIFIED.** HostingService class, 3 API endpoints, public/private deployment to AWS S3, pre-signed URLs for private projects. 7/7 tests PASS.
**Phase 31: Project Economy — COMPLETE (44d20c4).** All 11 sub-phases done: user accounts, project model, conversation→project, gateway page, revenue engine, collaboration invites, ownership transfer, deployment automation, marketplace, contribution tracking, content safety. ~4,500 lines across 8 new/modified files.
**Phase 30: AI-Powered Governance — COMPLETE (96c5881).** All 9 sub-phases done: proposal staking, reviewer selection, agent spawning, review workflow, decision engine, fallback handling, meta-governance (72h/80%), API routes, gateway UI. ~1,600 lines.
**Phase 31.0: Persistent User Accounts — DONE (3c0c7d2).** user-accounts.ts (632 lines), 9 auth API routes, SQLite persistence, scrypt hashing, session tokens (7-day TTL), thread ownership. Live on Lightsail — register/login/me verified.
**Graceful Restart Architecture — DONE (3c0c7d2).** POST /admin/shutdown, port pre-check in cli.ts, agent PID tracking + stopAll(). 4 files modified.
**Phase 29 E2E — VERIFIED (2026-02-22).** Standing directive set → agent processes → auto-enqueues directive_continuation → loop continues → clear directive → loop stops. 8/8 test points PASS on live Lightsail node.
**Phase 29: Agent Directive Persistence — DONE + E2E VERIFIED.** Standing directives, self-continuation via bridge, watchdog timer, HTTP API for directive management.
**Phase 28: Architecture Alignment — DONE + E2E VERIFIED (aaf21d1).** 13 blueprint gaps closed, 25/30 capabilities now DONE.
**Phase 28 E2E: 4 additional bugs found & fixed:**
1. PaymentGate blocked anonymous/local users (senderId='anonymous' has no ledger account → silently rejected)
2. Relay filter dropped short responses (<10 char lines filtered, "4" or "8" never reached user)
3. `/chat/message` endpoint didn't create threads (responses had no threadId → orphaned)
4. `/chat/history` was hardcoded empty (never returned real data)

**Multi-Node P2P Testing — ALL BUGS FIXED (2026-02-21).** 3-node local network tested and retested. 4 bugs fixed, all P2P tests now PASS.
- **PASS:** Lux transfer bidirectional + cross-node propagation, governance voting + quorum, content GossipSub sync, supply consistency (6973.94 on all 3), capability broadcast bidirectional (3/3 profiles on all nodes), api-token per data-dir isolation
- **4 bugs fixed:** MN1 (api-token per data-dir), MN3 (triple-broadcast on peer connect), MN5 (60s periodic sync + signature fix), MN6 (signed transfers rejected as "unsigned" when public key unknown)
- **Remaining:** MN2 (balance divergence from emission timing — expected/benign), MN4 (no HTTP API for emission/resource proofs — design gap)
**Phase 27-I: Agent Tool Awareness — DONE.** Delegation E2E verified.
- 27-A: Agent Primitive (agent.ts) — DONE
- 27-B: Templates (genome/templates/*.md) — DONE
- 27-C: Rewire + Delete Legacy — DONE (72460a6). 19 files deleted, 4 rewritten, -13,014 net lines. Zero build errors.
- 27-D: Lifecycle + Observability — DONE (fcfb0bf)
- 27-E: Multi-User + Governance — DONE (d1ceb38)
- 27-Audit: 7 critical bugs fixed, 22 dead API routes deleted, 17 stale genome components deleted, CLAUDE.md updated
- 27-F: End-to-End Testing — DONE (9 bugs fixed, full pipeline verified via Playwright)
- **S2 FIX (Task→Worker path):** Scheduler `task:approved` event → index.ts listener → bridge.enqueue → AgentManager → Claude Code. 3 files changed, ~17 lines. Verified E2E: POST /tasks → approve → manager agent invoked (18s, 539ch output).
- 27-G: GAP Analysis — DONE (identified 6 gaps, 5 resolved)
- 27-H: Real-Time Streaming Progress — DONE (d76513f, da7f179, 0ffd826)

**Phase 27-H Real-Time Streaming Progress — VERIFIED (3 commits):**
- **d76513f:** Activity streaming + collapsible history. Fixed race condition: SSE `chat_progress` arriving before HTTP response caused duplicate "Agent working..." panels. Activity logs now persist as collapsible `<details>` under final response.
- **da7f179:** Real stream-json progress. Replaced fake heartbeat messages ("Thinking...", "Analyzing request...") with actual Claude Code tool use parsed from `--output-format stream-json` stdout. Shows "Tool: Bash: ls -la ...", "Tool: Read: file.ts", etc. Fallback heartbeat only fires after 10s silence.
- **0ffd826:** No truncation + color-coded activity + responsive design. Blue for tool use, green for "Completed", neutral for text. Full command display (no `.slice()` truncation). Responsive message bubbles across screen sizes.
- **Key finding:** Claude Code `--output-format stream-json` emits line-delimited JSON. Types: `system` (session_id), `assistant` (content array with `tool_use`/`text`/`tool_result` blocks), `result` (cost_usd). Must line-buffer stdout chunks since they don't align to line boundaries.

**Phase 27-F E2E Testing — VERIFIED.** Full chat-to-manager pipeline tested via Playwright:
- User message → Gateway → Node `/chat/threads/:id/message` → Bridge Queue → AgentManager → Claude Code session → output → `relayOutputToUser` → SSE `chat_message` with `threadId` → Gateway SSE proxy → Browser EventSource → chat UI replaces "Processing..." → user sees response.
- Multi-turn conversation confirmed: manager maintains context across messages.
- Agent tree page: 3 agents visible with correct parent-child hierarchy, status, task counts.
- Wallet page: balance, identity, transaction history all rendering.
- Projects page: empty state correct (no project-specific sessions yet).

**12 bugs fixed across 3 sessions (Phase 27-F):**
1. CLAUDE.md not written before agent spawn (agent.ts)
2. Gateway thread API endpoints broken (rewrote 3 routes)
3. Chat page null safety for SSE messages
4. SSE event name mismatch: `agent_output` → `chat_message` (agent-manager.ts)
5. SSE payload missing `role: "assistant"` (agent-manager.ts)
6. No processing indicator for queued messages (chat/page.tsx)
7. Output filter too aggressive: 50 chars → 5 chars (agent-manager.ts)
8. Gateway SSE proxy not streaming in Next.js dev mode (rewrote events/route.ts with ReadableStream)
9. Bridge enqueue wrong type/field: `user_message` + `content:` → `user_request` + `payload: { message }` (api-server.ts, 2 endpoints)
10. Chat page sending to generic endpoint instead of thread endpoint (chat/page.tsx)
11. SSE threadId not propagated: relayOutputToUser now passes threadId from bridge item → SSE event (agent-manager.ts)
12. Assistant responses not persisted to ThreadStore: added threadMessageCallback wiring (agent-manager.ts + index.ts)
- Also fixed: "No conversations yet" flash → shows "Loading..." during initial fetch (chat/page.tsx)

**Phase 26 Progress Relay — DONE (354a574):** Manager workflow steps stream to user's chat in real-time via onProgressCallback → emitResponse() → SSE. Verified with 4 concurrent projects (snake game, memory card, color palette, typing speed test). Playwright QA confirmed (97.9s). Orchestrator↔CommunicationAgent↔ApiServer wiring confirmed working.

## Phase 26 Architecture Wiring — COMPLETED 2026-02-21

All 26 items implemented (12 WIRE + 13 BUILD + 1 SIMPLIFY) plus 5 critical bug fixes found during logic review.

**Previously CRITICAL gaps — all RESOLVED (pre-Phase 27 architecture, now superseded):**
All gaps listed here referenced files deleted in Phase 27-C (communication-agent.ts, domain-managers.ts, manager-agent.ts, manager-context.ts, workspace-manager.ts, etc.). The Universal Agent Architecture (agent.ts, agent-manager.ts, agent-tools.ts) replaces all of these. See Phase 27 roadmap for the new architecture.

## Active Work

- **Phase 28: Architecture Alignment — DONE.** Closed 13 blueprint gaps in one session. 7 files changed, +316 lines. Zero build errors.
  - **Cost Control:** PaymentGate wired to chat flow (escrow on user_request, release on success, refund on failure). Simple tier routing for /status, /balance, /peers, /wallet, /help (free, instant, no Claude Code). Budget tracking per agent (budgetSpent/budgetLimit, pause at 2x overspend).
  - **External Brain:** project-state.md auto-created on first agent run with template (Architecture Decisions, Status, Known Issues, Worker Registry, Budget). Injected into CLAUDE.md Layer 2 with mandatory read/write protocol. Workers get parent's project-state.md as context (Layer 2b, truncated at 2K chars).
  - **Worker Enforcement:** builder.md updated with Mandatory Workflow (UNDERSTAND→PLAN→BUILD→TEST→UPDATE_GENOME→REPORT→REFLECT). tester.md updated with Mandatory QA Workflow. manager.md updated with Verifying Worker Output checklist.
  - **QA Auto-Prompt:** buildPromptFromBridgeItem() now prompts manager to verify RESULT.md and consider spawning QA when worker reports completion.
  - **Stuck Detection:** 3-minute no-progress timer in processNextBridgeItem(). Warns user via SSE. Existing 5-minute hard timeout as final safety net.
  - **Escalation Chain:** urgency:direct bypass routes stuck/user_question events directly to user's chat, skipping manager queue.
  - **Blueprint Update:** Status table updated from 12 DONE → 25 DONE. 4 remaining BUILD items (project discovery, multi-user threads, conflict→governance, governance→trigger).
- **Phase 27-I: Agent Tool Awareness — DONE.** Fixed delegation: expanded `buildClaudeMd()` Communication section with spawn/message/tree HTTP endpoints + API token injection. Added `buildClaudeMd()` call in `sendEvent()` so agents always have fresh endpoints. Updated manager template with concrete curl examples. E2E verified: manager spawned `builder-377b3316` (depth=1, parentId=pando-node-mgr), builder created todo-loop.md + calculator2.html (19KB).
- **Continuation test PASSED:** Sent follow-up "add square root button" → manager routed to EXISTING builder-377b3316 via POST /agents/:id/message → builder used `--continue --resume` with same sessionId → modified calculator2.html in-place (19274→20247 bytes). No new agents spawned. taskCount 1→2.
- **Activity log persistence DONE:** Activity logs now saved to ThreadStore with each assistant message. `collectedActivity` array → `relayOutputToUser` → ThreadStore → API → chat page shows collapsible activity on reload. Old messages don't have activity (never saved), new ones do.
- **Phase 27-E DONE (d1ceb38):** Multi-user + governance. agent-manager.ts: ProjectEntry registry with owner/collaborator/qa_lead/viewer access levels, access-controlled message enqueue, direct user↔agent connections, user_question escalation prompt. agent-tools.ts: 6 new routes (project CRUD + connect/disconnect). index.ts: governance decision→bridge wiring. Gateway: projects page shows collaborator pills + PUBLIC badges.
- **Phase 27-D DONE (fcfb0bf):** Agent lifecycle + observability. bridge-queue.ts: formal retryCount + nodeId fields. agent-manager.ts: hourly cleanup sweep (ACTIVE→IDLE→ARCHIVED→DEAD), workspace archival (.tar.gz), agent resurrection. agent-tools.ts: POST /agents/:id/resurrect. Gateway: /agents page with recursive tree view, status badges, cost tracking. NavBar updated.
- **Phase 27-C DONE (72460a6):** Universal Agent Architecture rewire complete. 19 legacy files deleted (communication-agent, smart-router, chat-session-manager, planner, profile-cache, profile-sync, manager-agent, manager-context, domain-managers, manager-registry, manager-failover, manager-protocol, self-improver, strategy-loop, auto-updater, workspace-manager, project-context, outcome-recorder, session-registry). 3 new files created (agent.ts 1062 lines, agent-manager.ts 958 lines, agent-tools.ts 330 lines). 6 templates created (genome/templates/). 4 core files rewritten (index.ts, api-server.ts, scheduler.ts, cli.ts). Net: -13,014 lines. Build: zero errors.
- **Phase 26 E2E VERIFIED (cfa585e):** Full pipeline tested via Playwright — user sends "build me a snake game" → SmartRouter classifies as Full → CommunicationAgent creates project → Bridge Queue routes to Manager → Manager spawns task → Scheduler assigns worker → Worker builds snake game → task:completed relays back to user's chat thread with result summary. All 3 tiers verified: Quick (balance, instant), Smart (OpenAI conversational), Full (Claude Code project). 4 bugs fixed: findExistingProject false matches (stop words filter), duplicate messages (dedup in sendMessage), task routed to wrong manager (createdBy fallback), completion relay broken (this.communicationAgent class property missing).
- **Project chat E2E VERIFIED (b96eb39):** Full flow tested: user sends "build me X" → project auto-created → Claude Code asks questions → user answers → AI builds app → follow-up modifies same file → project visible on Projects page. Three bugs fixed: thread→project routing (projectId stored on ThreadMeta), timeout increase (300s project / 330s gateway), duplicate SSE fix (ack only via HTTP).
- **Gateway Projects page DONE:** Replaced "Coming Soon" placeholder with functional project listing. Shows active chat sessions with stats, manager info, scheduler task links. Shows orphan managers (scheduler-created). Shows node manager with Monitor link. Fetches from 4 APIs in parallel. E2E verified.
- **E2E tracking flow VERIFIED:** Full lifecycle tested: submit task via scheduler UI → auto-approved → agent spawned → live tracking page (SSE "Live" indicator, Running badge) → completed (55.7s) → timeline (7 events) → execution logs (8 lines) → workspace file browser (inline file viewing) → build: passed. All gateway tracking pages confirmed working: Monitor (managers), Projects (sessions), Scheduler (queue), Task Detail (live logs + workspace).
- **Phase 24.9 IMPLEMENTED + TESTED:** Threaded conversations — ChatGPT-like UX. ThreadStore (filesystem-based), 6 new API endpoints, gateway chat page rewrite (sidebar + thread switching), homepage dynamic (search inline + "Open in Chat" for tasks). All Playwright-verified. See `genome/flows/threaded-chat.md`.
- **Chat persistence + SSE DONE (e413a02):** History saved to `~/.pando/chat-history.json`, EventEmitter pattern, async project creation, real-time SSE `chat_message` events. E2E verified with Playwright.
- **Phase 24.1-24.4 COMPLETE:** Intent detection, project sessions, enriched CLAUDE.md, governance proposal creation all working and tested. 24.5 (payment integration) pending.
- **Phase 25 IMPLEMENTED:** Bridge Queue (central event hub), Bridge Watcher (replaces heartbeat), Manager CLAUDE.md fix (genome refs), worker-to-bridge communication, API endpoints. All tested (38 unit tests + live node verification). See `genome/components/bridge-queue.md`.
- **Architecture shift DONE:** Heartbeat timer → event-driven Bridge Queue. Pipeline commit → Manager workflow step. One-way worker output → two-way bridge communication. See `genome/flows/agent-communication.md`.
- Dynamic workflow system: verified end-to-end, genome docs updated
- Testing: 153 tests tracked, **137 PASS + 5 PARTIAL** = 142/146 testable (97.3%). 0 UNTESTED, 2 FAIL (C5/C9 not implemented), 2 NO_API (resource proofs), 5 N/A. See `admin_docs/TEST-TRACKER.md`.
- **Projects Page: Private/Public/Shared — DONE + E2E VERIFIED (1e60b8b).** Auth-aware tabs (My Projects/Shared/Public), owner Settings (edit name/type/visibility/budget), invite collaborators (by peerId + invite codes), remove collaborators, role badges, stats cards. 6 files changed, +796/-237. **10/10 E2E tests PASS**: create private/public/shared projects, tab filtering, expand detail, edit settings, add/remove collaborator, generate invite code, stats display. 2 bugs fixed during testing.
- **Unified Identity System — DONE + E2E VERIFIED (c0594ec).** Complete rewrite of user-accounts.ts with Ed25519 identity. Deleted user-identity.ts. Gateway auth UI: auth-context.tsx, 6 proxy routes, login page, claim page, NavBar auth state. **10/10 E2E tests PASS**: guest auto-creation, claim flow, logout→new guest, login with username, wrong password error, login with peerId, non-existent user error, claim redirect (already claimed), login redirect (already claimed), token persistence across page reload.
- **Phase 32: S3 Hosting Service — DONE + E2E VERIFIED.** HostingService class in `hosting-service.ts`. Public projects served via S3 website endpoint, private/shared via pre-signed URLs (1hr TTL). 3 new API routes. New `DeploymentInfo` type. Wired in index.ts.
  - **7/7 E2E tests PASS:**
    1. Deploy public site via API — PASS
    2. Public site accessible via direct URL — PASS
    3. Deploy private site — PASS
    4. Private site direct access blocked (403) — PASS
    5. Private site via pre-signed URL — PASS
    6. GET deployment info — PASS
    7. DELETE deployment (removed from S3) — PASS
- **E2E User Testing Session (2026-02-22):** CEO-as-user comprehensive testing across gateway+node.
  - **PASS:** Quick-tier chat (6 keywords), agent tree API, thread persistence, governance lifecycle (create→vote→comment→stats), wallet page (balance+transactions+transfer), multi-node governance sync (proposals+votes+comments), multi-node Lux transfer, projects page (empty state+create form), activity stream with real tool calls.
  - **Bugs fixed:** Quick-tier proposals "undefined for/against" (counted from votes array), governance `createProposal` silently returned old proposal on rate-limit (now throws error + 429), governance propose route missing category/isEmergency params.
  - **Bugs found:** Cross-node ledger sync divergence (168 Lux gap), gateway governance page shows "No proposals" (proxy routes missing), Governance missing from nav, project creation needs auth.
- **RESOLVED: Task→Worker path wired (S2 fix).** Scheduler `task:approved` event → index.ts listener → bridge.enqueue → AgentManager → Claude Code. E2E verified.
- **Cleanup (1a7a4b8):** 3 dead gateway API routes deleted (/api/ceo, /api/console, /api/profiles). Network page 404 fixed. 4 legacy pages restored (explore sub-pages re-export from them).
- All Claude sessions now use `--model claude-sonnet-4-6` explicitly
- **Phase 27 Audit:** All 5 packages compile clean (shared, ledger, node, gateway, mcp-server). Gateway builds clean. 22 dead API routes removed from api-server.ts. 17 stale genome component files deleted. Ready for E2E testing.
- **Post-Audit Bug Fixes (8 bugs):** H1: /health endpoint hardcoded "healthy" — now consults HealthMonitor. H2: /tasks/:id/approve rejected empty body — added empty JSON body parser. H3: HealthMonitor alert deduplication — reopens recently-resolved alerts (30min window) instead of creating duplicates. M1: AgentManager task completion callback — bridge-routed tasks now mark task queue done and update Scheduler counters. M2: Governance auto-archives expired 0-vote proposals. M4: Governance rate-limits proposal creation when local node already has active 0-vote proposal. **R4-1: Chat Quick tier missing** — added `tryQuickTierResponse()` keyword detection in `/chat/threads/:id/message` for balance, status, peers, tasks, proposals, help. Instant local response, no agent. **R4-2: Agent template placeholders** — `${API_PORT}`, `${AGENT_ID}`, `${PARENT_ID}` in genome templates now substituted with real values in `loadTemplate()`. Files changed: api-server.ts, monitor.ts, agent-manager.ts, scheduler.ts, governance.ts, agent.ts.

## Known Issues

| Issue | Severity | Component | Status |
|---|---|---|---|
| TD-09: GossipSub message ordering | MEDIUM | p2p | Open |
| TD-13: GossipSub no backpressure | LOW | p2p | Open |
| TD-14: Clock skew in First-Claim-Wins | LOW | p2p | Open |
| Node restart stuck (zombie process) | MEDIUM | cli/ops | Mostly resolved — PM2 support (Phase 33.5), `POST /admin/shutdown` (Phase 29+), port pre-check in cli.ts, `setRestartHandler()` (Phase 34). Rare edge case: orphan processes possible if SIGKILL during agent shutdown. |
| Gateway IPv6 gotcha | LOW | gateway | Workaround: use 127.0.0.1 |
| Lightsail scheduler ENABLED | INFO | scheduler | Claude Code installed + authenticated (Max sub). `--scheduler` enabled since 2026-02-20. |
| Governance P2P tombstone missing | LOW | governance-sync | Open — `DELETE /governance/proposal/:id` only works locally. GossipSub re-syncs deleted proposals from other nodes. Need tombstone/soft-delete protocol for P2P deletion. |
| Single-node governance is ceremonial | LOW | governance | Accepted — proposer auto-approves own proposals on single-node. Real security requires multi-node (different AI instances on different machines). Not a bug, flagged as design limitation. See `genome/rules/governance-tiers.md`. |
| Cross-node code distribution after approval | MEDIUM | upgrade-protocol | Open — PipelineRunner applies changes locally. Other nodes need code too. UpgradeProtocol uses `git pull` (shared repo assumption). True P2P code distribution not implemented. Phase 33.8. |
| ~~E2E pipeline not tested end-to-end~~ | ~~MEDIUM~~ | ~~pipeline-runner~~ | **RESOLVED (Phase 33.4)** — Full autonomous pipeline verified: message → manager → governance → auto-vote → quorum → pipeline → git diff → guardrails → commit (0a6bcba) → restart. |
| No project-level governance scope | MEDIUM | governance | Open — all proposals go to all nodes. No mechanism to restrict voting to project stakeholders only. Phase 33.6. |
| Reviewer independence on same node | LOW | governance | Accepted — reviewer agent on same node uses same Claude Code model as proposer. True independence requires reviewers on different physical nodes. By design, not a bug. |
| Capability detector Claude Code check | LOW | capability-detector | `detectClaudeCode()` now requires both binary AND auth (`hasClaudeCodeAuth()`). Nodes with binary but no auth correctly report no `claude-code` capability. |
| EC2-2 / LS-2 single-peer connectivity | MEDIUM | p2p | EC2-2 and LS-2 only connect to 1 peer each. If that peer dies, they lose all network access (storage proxy, governance sync). Need better peer discovery or mesh connectivity. Found during failover test 2026-02-25. |
| Persistent EC2 not in CloudInstanceManager | MEDIUM | deploy | `POST /projects/:id/deploy` uses `cloudManager.getInstances()` which only tracks dynamically launched instances. Persistent EC2 nodes (EC2-1, EC2-2) aren't registered, so deploy endpoint returns 503. Fix: self-register persistent compute nodes or add manual registration. |
| ~~Thread list empty for chat users~~ | ~~HIGH~~ | ~~api-server~~ | **RESOLVED** — `POST /chat/message` created threads without userId → `GET /chat/threads` (which filters by userId) always returned empty. Fixed: resolve `chatUserId` from auth token in `/chat/message`, pass to all `createThread()` calls. Also upgraded thread list to async (reads from MongoDB for cross-node consistency). |

## Versions

| Component | Version | Last Build |
|---|---|---|
| Pando Node | master (Phase 50) | 2026-02-22 |
| Gateway | Next.js 16.1.6 | 2026-02-22 |
| Node.js | 22.x | -- |
| libp2p | v2.x | -- |

## Network Stats

| Metric | Value |
|---|---|
| Total nodes | 5 (2 EC2 + 2 Lightsail + 1 Windows) |
| Total Lux minted | ~23,500+ |
| Total accounts | ~169 |
| Tests passing | 137 PASS + 5 PARTIAL / 153 total (97.3%) |
| Multi-node tested | 5-node real P2P: EC2-1 ↔ EC2-2 ↔ LS-1 ↔ LS-2 ↔ Windows. Governance, chat, failover, JWT all E2E verified. |

## Recent Decisions

| Date | Decision | Commit |
|---|---|---|
| 2026-02-22 | **Gateway auth proxy fix**: `app/api/auth/me/route.ts` was forwarding `Authorization: Bearer <user-token>` to node, but node expects user tokens on `X-User-Token` header. Fixed to extract token and forward as `X-User-Token`. Pattern applies to all auth proxy routes. | — |
| 2026-02-22 | **Gateway projects stats client-side**: Removed server-side `/projects/stats` API call. Stats computed client-side from user's projects array. Prevents misleading platform-wide counts ("1 total" but "0 mine"). Labels: My Projects, Active, Shared With Me, Public. | — |
| 2026-02-22 | **Gateway .env.local port fix**: `.env.local` had `PANDO_NODE_URL=http://127.0.0.1:4100` from dev testing. NodePool caches this at startup. Fixed to port 4000. Lesson: always restart gateway after .env.local changes. | — |
| 2026-02-20 | **Phase 33 Self-Governing Development (partial)**: 33.0 request classification + 33.1 governance gate + 33.2 pipeline trigger DONE + E2E VERIFIED. Manager classifies node changes via event prompt injection, creates governance proposals, auto-votes approve, early resolution for single-node. Two-tier governance (network vs project) designed but project-level not yet built. See `genome/rules/governance-tiers.md`. | -- |
| 2026-02-22 | **Agent-driven deployment (E2E verified)**: Removed autoDeployIfReady() from processNextBridgeItem(). New `POST /agents/:id/deploy` endpoint + `deployAgentWorkspace()` method + `POST /agents/:id/reset-session`. Event prompt injection for deployment reminders (survives context compression). Manager template teaches when/how to deploy. Infrastructure provides tools, agents make decisions. | -- |
| 2026-02-22 | **Unified Identity System**: Every user gets real Ed25519 keypair. Auto-guest on first visit (key encrypted with node secret). Claim flow: set password + optional username (key re-encrypted with user's PBKDF2 password). Login with username OR peerId. One system for TUI and Gateway. user-identity.ts DELETED. | — |
| 2026-02-22 | Claude Code auth detection: `hasClaudeCodeAuth()` in capability-detector.ts checks ANTHROPIC_API_KEY env var OR `~/.claude/.credentials.json` (OAuth from `claude login`). Used by both chat endpoints and capability detector. | — |
| 2026-02-22 | Thread delete endpoint: `DELETE /chat/threads/:id` added to api-server.ts. Uses existing ThreadStore.deleteThread(). | — |
| 2026-02-22 | Governance proposal cleanup: 60 test/junk proposals deleted locally. GossipSub re-syncs from other nodes (no tombstone). Need tombstone protocol for P2P deletion. | — |
| 2026-02-22 | Ledger sync fix: Always request from genesis (`since: 0`), limit 2000→10000, gap warning log. Nodes now fully converge. | 56eeee5 |
| 2026-02-20 | Phase 27-H: Real-time streaming progress — line-buffered stream-json parsing in agent.ts, onProgress callback wiring in agent-manager.ts, collapsible activity history in chat UI | d76513f, da7f179, 0ffd826 |
| 2026-02-19 | Architecture Capabilities Blueprint — master flow document for all scenarios | — |
| 2026-02-19 | Four actors (not five): Router, Manager, Worker, QA. Docs Agent removed (Manager handles docs). | — |
| 2026-02-19 | project-state.md = External Brain — Manager reads at session start, writes at session end. Survives context compression. | — |
| 2026-02-19 | Workers get their own todo list (UNDERSTAND→PLAN→BUILD→TEST→REPORT→REFLECT) + discovery flow | — |
| 2026-02-19 | Stuck detection: workers/QA self-detect, escalate to Manager, Manager to user. Urgent:direct bypass available. | — |
| 2026-02-19 | Retry budget: max 3 attempts per task, 2x overspend pauses work. No infinite loops. | — |
| 2026-02-19 | Multi-user conflicts → governance vote (Manager never picks sides on public projects) | — |
| 2026-02-19 | Router is doorman only — inside project threads, messages go directly to bridge (no Router) | — |
| 2026-02-18 | Workflow-driven management: PLAN->SPAWN->REVIEW->QA->COMMIT->DOCS->REPORT | d97da45 |
| 2026-02-18 | Planner demoted to utility, Manager does own planning | d97da45 |
| 2026-02-18 | project-state.md as shared state for each project | d97da45 |
| 2026-02-18 | All remaining phases built (11, 12.3-12.7, 13, 17-18, 23, Resources) | e89c6f9 |
| 2026-02-18 | Architecture cleanup: per-event spawn, pure executor, data-only subs | 6746b11 |
| 2026-02-18 | Pipeline fix: task_created events, auto-profile at approval, sessionId persistence, structured logging | a10208e |
| 2026-02-18 | Design: pipeline step visibility via API (not text markers), chat→manager handoff via user_request events | -- (design only) |
| 2026-02-18 | Dynamic workflows: todo list IS the workflow, API for visibility. Replaces hardcoded 7-step pipeline | b133e0c, 3e298c4 |
| 2026-02-18 | All spawned Claude sessions use `--model claude-sonnet-4-6` via `DEFAULT_CLAUDE_MODEL` constant | (pending commit) |
| 2026-02-18 | E2E test passed: task→approve→fail→self-heal→retry→complete→pipeline→commit→deploy | 920f8d7 |
| 2026-02-18 | Chat spawn fix: claude.cmd → detectClaudePath() → claude.exe. Complex tier now works on Windows. | (pending commit) |
| 2026-02-18 | Chat system tested: simple (keyword), medium (OpenAI), complex (Claude Code) all working. Session continuity confirmed. | e8259df |
| 2026-02-18 | Phase 24.1-24.4: Intelligent Communication Agent. Intent detection + project sessions + enriched CLAUDE.md. "build me X" → persistent AI partner that checks balance, asks questions, creates governance proposals. | 8d66bb5 |
| 2026-02-19 | Architecture clarification: Manager is primary committer, Pipeline is safety net. TD-25 re-scoped. TD-29/TD-30 identified. | (docs only) |
| 2026-02-19 | Phase 25: Bridge Queue implemented. Heartbeat removed, pipeline commit removed, bridge watcher event-driven, worker mid-task messages, 3 new API endpoints. TD-25/29/30 resolved. | (pending commit) |
| 2026-02-19 | Gateway Projects page: replaced placeholder with functional project listing (sessions + managers + tasks + threads). E2E tracking flow verified. | (pending commit) |

---

## Open Technical Debt

> 30 items tracked historically. 27 resolved. 3 remaining open (P2P issues, deferred to Phase 20+).

| ID | Severity | Component | Issue | Status |
|---|---|---|---|---|
| TD-09 | **MEDIUM** | GossipSub | No message ordering — out-of-order events cause state divergence | Phase 20+ |
| TD-13 | **LOW** | P2P | GossipSub no priority/backpressure — bandwidth saturation at scale | Phase 20+ |
| TD-14 | **LOW** | P2P | Clock skew in First-Claim-Wins — some nodes always win | Phase 20+ |

## Runtime Monitoring Thresholds

> These are the alert thresholds that must be checked. HealthMonitor enforces most of these automatically.

| What | How | Alert Threshold |
|---|---|---|
| tasks.json file size | `fs.statSync()` on poll | > 500KB = warn, > 1MB = critical |
| Active Map sizes | `activeTasks.size`, `taskEmitters.size`, `activePids.size` | > 100 entries = warn |
| Consecutive API failures | Circuit breaker state | 3 in 5 min -> OPEN |
| Task queue depth | Open tasks count | > 50 open = warn, > 200 = critical |
| Workspace disk usage | `~/.pando/workspaces/` total size | > 1GB = warn |
| GossipSub message rate | Messages per minute per topic | > 100/min sustained = throttle |
| GossipSub listener count | `topicListeners.length` | > 50 listeners = leak detected |
| Governance proposals in memory | `proposals.size` | > 500 = warn (archiveExpiredProposals never called) |
| Reputation peer records | `peerRecords.size` | > 500 = warn (no pruning) |

## Resources & Budget

- **No fixed budget limit.** Use what is needed.
- **API calls (search, cheap tier):** Use ResourceRegistry → CredentialStore (MongoDB encrypted). No env var fallbacks (removed Phase 58).
- **Major building work:** Claude Code sessions spawned by Jai (or via node PTY sessions once architecture supports it)
- **Goal:** Reduce Jai's involvement over time. Architecture should evolve so the node can spawn Claude Code sessions itself to handle tasks. Jai becomes an admin user, not a required operator.
- **Cost projections (per-event spawn with --continue):** ~$0.02/event (prompt cache hits after first call). First event: ~$0.10 (cache creation). Daily: $2-5 idle (heartbeat only), $8-12 active, $25-35 heavy.
