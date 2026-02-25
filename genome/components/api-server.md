---
id: api-server
type: interface
domain: api
entry: packages/node/src/api-server.ts
depends_on: [ledger, network, scheduler, governance, monitor, agent-manager, content-registry, payment-gate, council]
depended_by: [gateway, mcp-server]
exposes:
  - GET /status — node status (peers, balance, identity, uptime, capabilities)
  - GET /health — node health (consults HealthMonitor)
  - GET /balance/:peerId — balance for a specific peer
  - GET /wallet — wallet info (identity, balance, ownership)
  - GET /peers — list connected peers
  - POST /connect — connect to a peer by multiaddr
  - POST /transfer — transfer Lux between peers
  - POST /search — AI search via ResourceRegistry or env var fallback
  - POST /chat/message — send message to Manager via bridge queue (resolves userId from auth token, associates threads with user)
  - GET /chat/history — get conversation history
  - POST /chat/clear — clear conversation history
  - GET /chat/threads — list threads filtered by authenticated user (async — reads from storage backend for cross-node consistency)
  - POST /chat/threads — create a new thread
  - GET /chat/threads/:id — get thread with messages (cache + async fallback for cross-node)
  - DELETE /chat/threads/:id — delete a thread and its messages
  - PATCH /chat/threads/:id — update thread metadata (projectId, type)
  - POST /chat/threads/:id/message — send message to thread (quick-tier detection + bridge routing)
  - POST /tasks — create task
  - POST /tasks/:id/approve — approve task
  - GET /tasks — list tasks
  - GET /tasks/:id — get task detail
  - GET /scheduler/tasks — scheduler task queue
  - GET /monitor/status — health metrics and alerts
  - POST /upgrade — trigger safe upgrade (git pull, build, restart)
  - POST /upgrade/propose — propose upgrade via governance (description only, commit hash auto-detected)
  - GET /upgrade/status — current upgrade status (version, pending proposals, pinned version)
  - GET /upgrade/history — upgrade history
  - POST /upgrade/rollback — emergency rollback via governance fast-track vote
  - POST /upgrade/pin — pin to current version (refuse auto-upgrades)
  - POST /upgrade/unpin — unpin version (accept auto-upgrades again)
  - GET /onboard — bootstrap info for new peers
  - POST /admin/shutdown — graceful shutdown
  - GET /capacity — aggregated supply/demand/rewards/network metrics
  - GET /network-state — network state snapshot for council
  - GET /council — council members, rotation info
  - GET /council/minutes — council minutes log
  - GET /capabilities — local node capability profile
  - GET /network/capabilities — all known node capabilities
  - GET /resources — list all resources in ResourceRegistry (supports ?type= filter)
  - POST /resources/register — register a resource (API key, etc.)
  - POST /resources/:id/revoke — revoke a resource
  - GET /resources/marketplace — resource marketplace listings
  - POST /resources/prices — set operator pricing
  - GET /resources/marketplace/find — find cheapest provider
  - POST /auth/guest — create guest account (auto Ed25519 keypair), returns JWT session token
  - POST /auth/claim — claim guest account with password+username
  - POST /auth/login — login with username or peerId, returns JWT session token
  - POST /auth/challenge — get a stateless JWT challenge token for Ed25519 signature auth (no in-memory nonce map)
  - POST /auth/verify — verify Ed25519 signature against JWT challenge, returns JWT session token
  - GET /auth/me — get current user info (JWT verified via peerIdFromString)
  - GET /projects — list projects
  - POST /projects — create project (user session OR Bearer token)
  - PATCH /projects/:id — update project
  - POST /projects/:id/collaborators — add collaborator
  - POST /projects/:id/hosting — deploy files to S3
  - GET /projects/:id/hosting — get deployment info + URL
  - DELETE /projects/:id/hosting — remove deployed files
  - GET/POST /projects/:id/preflight — pre-flight check + auto-fix (API key, MongoDB)
  - POST /projects/:id/validate-deploy — post-deploy health check (uses direct S3 URL, not gateway proxy)
  - POST /projects/:id/deploy — unified deploy endpoint (Phase 87: P2P discovery, Phase 88: returns `detectedTier`/`tierReason` from code inspection, auto-corrects project.tier)
  - POST /projects/:id/github/push — push workspace to GitHub via contributed PAT
  - POST /projects/:id/undeploy — stop and remove deployed app (Phase 87: uses deployPeerId directly, no CloudInstanceManager)
  - POST /admin/migrate-apps — redeploy Tier 2 apps from dead instance to running one
  - POST /admin/cleanup-projects — archive specified projects (soft delete)
  - GET /marketplace — browse public projects
rules: []
last_verified: 2026-02-25 (Phase 87)
---

# API Server

## What It Does
Fastify HTTP API server for the Pando node. Exposes node operations over HTTP so the gateway, MCP server, and external tools can interact with the node without direct database access. Provides per-IP rate limiting and Bearer token authentication on write endpoints.

## How It Works
- Built on Fastify with `@fastify/cors` for cross-origin support. Starts on the configured API port (default 4000).
- Per-IP sliding window rate limiter: each endpoint has a configurable max requests per 60-second window (e.g., search=10, input=20, transfer=30, propose=5). Rate limits are overridable via environment variables (e.g., `PANDO_RATE_SEARCH`).
- Bearer token authentication: write endpoints require `Authorization: Bearer <token>` header. Token is auto-generated at `~/.pando/api-token` (32-byte hex). Read endpoints (GET) are open.
- **User auth (Phase 86 — JWT):** User session tokens are self-verifying JWTs signed by the issuing node's Ed25519 private key. Verification uses `peerIdFromString(issuer).publicKey.verify()` — no database lookup needed. Cross-node auth works: a token issued by Node A can be verified by Node B. Challenge tokens for signature-based auth (`/auth/challenge`, `/auth/verify`) are also stateless JWTs (no in-memory nonce map).
- AgentManager handles all AI chat via Bridge Queue dispatch to Manager agents.

## Gotchas
- NEVER use `localhost` in `PANDO_NODE_URL` — always use `127.0.0.1`. The IPv6 resolution of `localhost` causes connection failures on some systems (especially Windows/Mac gateway).
- Rate limiter `cleanup()` must be called periodically or stale keys accumulate. The server runs cleanup on an interval.
- Bearer token is stored as plain text in `~/.pando/api-token`. If the file is missing, a new token is generated on startup.
- The API server holds a reference to the full `PandoNode` instance — it has access to all subsystems, which means a bug in any endpoint handler could theoretically affect node state.
- `/health` endpoint now consults HealthMonitor for actual health state (peer count, alert severity) instead of hardcoding "healthy". Returns degraded/unhealthy when monitor detects problems.
- A custom content type parser accepts empty JSON bodies (`application/json` with zero-length payload). This fixes endpoints like `POST /tasks/:id/approve` that are called with no body.
- **Doorman (Phase 68.3)**: `doormanClassify(message)` handles first-contact routing. Keyword patterns (balance, status, peers, help) get instant local responses. Ambiguous messages go to OpenAI gpt-4o-mini for classification (~$0.001). Build requests create a project + spawn per-project manager. Messages with a `projectId` skip the doorman entirely and route to the project manager.
- **Phase 83 — 503 guards are defense-in-depth**: After P2PStorageBackend, every node has a StorageBackend (direct or proxied). The `if (!threadStore) return 503` and `if (!projectStore) return 503` guards remain as safety nets but should never trigger in normal operation.

## Graceful Shutdown (Phase 29+)

`POST /admin/shutdown` triggers a clean teardown:
1. Responds HTTP 200 immediately (so the caller can proceed)
2. `agentManager.stopAll()` — SIGTERM all child Claude Code processes, wait 10s, SIGKILL remaining
3. `agentManager.stop()` — stops bridge listeners, persists agent state
4. `node.stop()` — closes Fastify, libp2p, SQLite, scheduler, monitor
5. Writes `~/.pando/shutdown-reason.json` with `{ reason, timestamp, pid }`
6. `process.exit(0)`

Port pre-check in `cli.ts`: Before starting, TCP-probes the API port. If occupied, reads `~/.pando/api-token` and sends `POST /admin/shutdown` to the old instance. Waits up to 15s for port to free. If still blocked, exits with clear error.

## Governance Routes (Phase 30)

| Route | Method | Description |
|---|---|---|
| `/governance/proposals` | GET | List all proposals |
| `/governance/proposals/active` | GET | Active proposals only |
| `/governance/proposal/:id` | GET | Single proposal detail |
| `/governance/propose` | POST | Create proposal `{title, description, votingDurationMs?, category?, isEmergency?}` — 10 Lux stake |
| `/governance/vote` | POST | Cast vote `{proposalId, choice, reasoning?, modelAttestation?}` — choice: approve/reject/abstain |
| `/governance/proposals/:id/reviews` | GET | AI reviews for a proposal |
| `/governance/proposals/:id/reviewers` | GET | Reviewer candidates |
| `/governance/proposals/:id/review` | POST | Submit review `{summary, recommendation, score}` |
| `/governance/stats` | GET | Aggregate governance stats |
| `/governance/comment` | POST | Add comment to proposal `{proposalId, content}` |

## Hosting Routes (Phase 32)

| Route | Method | Auth | Description |
|---|---|---|---|
| `/projects/:id/hosting` | POST | Owner/admin token | Deploy files to S3 (base64 JSON body) |
| `/projects/:id/hosting` | GET | Optional user token | Get deployment info + URL (public: direct, private: pre-signed) |
| `/projects/:id/hosting` | DELETE | Owner/admin token | Remove all deployed files from S3 |

## Validate-Deploy Endpoint (Phase 66)

`POST /projects/:id/validate-deploy` performs a post-deploy health check. Key details:
- Uses the **direct S3 URL** (not the gateway proxy URL) to verify the deployed app is reachable. This avoids false negatives from gateway routing issues.
- Writes to the `pando_health` collection (not `__preflight_test`) for the Resource Proxy database check. Collections starting with `__` are rejected by Resource Proxy's collection validation rules.
- Checks three things: (1) URL responds with 200, (2) `window.PANDO_GATEWAY_URL` injection is present in HTML, (3) Resource Proxy database round-trip works via the app's API key.

## Key Files
- `packages/node/src/api-server.ts` — Fastify API server with all endpoint handlers
