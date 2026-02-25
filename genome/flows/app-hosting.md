---
id: app-hosting
type: flow
domain: deployment
depends_on: [hosting-service, resource-registry, agent-manager]
created: 2026-02-22
updated: 2026-02-23
---

# App Hosting Architecture — 3-Tier Deployment

## Overview

Pando apps are deployed to contributed infrastructure. Nodes BUILD apps but have ZERO runtime involvement after deployment. Three hosting tiers, ordered by priority:

## Tier 1: S3 Static Hosting + Gateway API Proxy (PRIMARY — NOW)

**What it is:** App files (HTML/CSS/JS) deployed to AWS S3 static hosting. API calls route through the Pando gateway's Resource Proxy for database access.

**Best for:** Static apps, data apps (CRUD), anything that doesn't need a persistent backend server or WebSockets.

**How it works:**
1. Builder agent creates frontend code (HTML/CSS/JS)
2. At deploy time, the gateway's public URL is injected into the app's HTML as `window.PANDO_GATEWAY_URL`
3. App code uses this URL to call the Resource Proxy: `${window.PANDO_GATEWAY_URL}/api/resource-proxy/db`
4. Files uploaded to S3 (`s3://pando-deployments/public/<projectId>/`)
5. User gets direct S3 website URL: `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/<projectId>/index.html`
6. Resource Proxy handles database ops server-side (MongoDB credentials never touch the browser)

**URL injection (Phase 62):**
During `deployAgentWorkspace()`, before uploading HTML files to S3, the hosting service injects a `<script>` tag into every HTML file:
```html
<script>window.PANDO_GATEWAY_URL="https://gateway-one-mu.vercel.app";</script>
```
This means:
- Builders write `fetch(window.PANDO_GATEWAY_URL + '/api/resource-proxy/db', ...)` — no hardcoded URLs
- If the gateway URL changes (e.g. custom domain `pandogateway.com`), just re-deploy with the new URL
- S3 serves the static files, gateway handles API calls — clean separation

**Cost:** Near-zero (S3 bandwidth only). Resource Proxy metering covers DB usage.

**Limitations:** No WebSockets, no server-sent events, no persistent backend processes. Request/response only via Resource Proxy.

## Tier 2: EC2 Compute Instance (SECONDARY — NOW)

**What it is:** Full server deployment on AWS EC2. For apps that need a persistent backend (WebSockets, real-time games, long-running processes).

**Best for:** Real-time apps (chat, games, collaborative editing), apps with custom backend logic, WebSocket-based apps.

**How it works:**
1. Builder agent creates frontend + backend code (Express/Fastify server)
2. Manager detects Pattern 3 (full-stack) and chooses EC2 deployment
3. App code uploaded to EC2 instance via SCP/rsync
4. Backend process started (Node.js, Python, etc.) behind nginx reverse proxy
5. Environment variables injected at deploy time: `MONGODB_URI`, `S3_BUCKET`, `PORT`, etc.
6. User gets EC2 URL (via ALB or direct IP)

**Current Tier 2 Infrastructure (Phase 87):**
- Persistent EC2 compute nodes discovered via P2P CapabilityProfile (storageBackend=mongodb)
- Deploy endpoint auto-discovers compute peers — no manual instance management needed
- Apps served via nginx reverse proxy at `http://<publicAddress>/apps/<projectId>/`
- `deployPeerId` stored on project record for undeploy routing

**Cost:** EC2 instance runtime + bandwidth. Billed to resource contributor.

**Limitations:** Single instance per launch for now. No auto-scaling.

## Tier 3: Node-Hosted Apps (FUTURE — NOT YET)

**What it is:** Serve apps directly from a Pando node's Fastify HTTP server. The node handles both P2P operations AND app serving.

**Best for:** Critical internal tools, admin dashboards, apps that need direct access to P2P state (ledger, governance, capabilities).

**How it works (design only — not implemented):**
1. Builder creates app code
2. App files served from `GET /hosted-apps/<projectId>/*` route on the node's Fastify server
3. App can call node API endpoints directly (same origin)
4. No external infrastructure needed

**Why later:**
- Nodes should stay lightweight (compute proxies, not web servers)
- Scales poorly (node capacity = hosting capacity)
- At launch, limited nodes means limited hosting capacity
- AWS/S3 scales instantly if user count spikes overnight

**When we'll build it:**
- After Tier 1 and Tier 2 are battle-tested
- For internal-only tools (admin, monitoring, debugging)
- When we have clear use cases that can't work with Tier 1 or 2

## Decision Matrix: How Managers Choose

Managers MUST check this matrix when deciding deployment target:

| App Needs | Tier | Why |
|---|---|---|
| Static content only (portfolio, landing page) | Tier 1 (S3) | Cheapest, fastest, most reliable |
| CRUD database access (todo app, blog, polls) | Tier 1 (S3 + Resource Proxy) | Resource Proxy handles all DB ops |
| Read-heavy dashboard (analytics, status) | Tier 1 (S3 + Resource Proxy) | Polling is fine for dashboards |
| Real-time updates (chat, notifications) | Tier 2 (EC2) | Needs WebSockets or SSE |
| Multiplayer game (turn-based is OK for Tier 1) | Tier 2 (EC2) | Needs persistent connections |
| Custom backend logic (auth, file processing) | Tier 2 (EC2) | Needs server-side compute |
| Admin/monitoring tools | Tier 3 (Node — future) | Needs direct P2P access |

**Default: Tier 1.** Only use Tier 2 when the app genuinely requires real-time or custom backend. Never use Tier 3 until it's implemented.

**Manager protocol for deployment decision:**
1. Analyze app requirements (real-time? WebSocket? Custom backend?)
2. If NO to all → Tier 1 (S3 + Resource Proxy)
3. If YES to any → Check if `cloud_compute` resource available via `GET /resources?type=cloud_compute`
4. If available → Tier 2 (EC2)
5. If not available → Build as Tier 1 with polling fallback (degrade gracefully)

## URL Strategy

| Tier | URL Pattern | Example |
|---|---|---|
| Tier 1 (S3) | `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/<projectId>/index.html` | Direct S3 |
| Tier 1 (Gateway) | `https://gateway-one-mu.vercel.app/apps/<projectId>/index.html` | If gateway proxy exists |
| Tier 2 (EC2) | `http://<ec2-ip>:<port>/` or via ALB | `http://3.89.139.27:3001/` |
| Tier 3 (Node) | `http://<node-ip>:<api-port>/hosted-apps/<projectId>/` | Future |

**Custom domain plan:** When we get `pandogateway.com` or similar:
- Tier 1 apps: `https://pandogateway.com/apps/<projectId>/`
- Tier 2 apps: `https://<projectId>.pandogateway.com/`
- Just update `GATEWAY_PUBLIC_URL` env var and re-deploy apps (URL injection means apps auto-adapt)

## Nice-to-Have Ideas (Future)

1. **Auto-scaling EC2**: Launch new instances when existing ones hit capacity. Resource Marketplace handles pricing.
2. **Container deployment**: Docker images built by agents, deployed to ECS/EKR. Better isolation than shared EC2.
3. **Serverless functions**: Lambda/Cloudflare Workers for lightweight backends. No persistent server needed.
4. **CDN integration**: CloudFront in front of S3 for global distribution.
5. **SSL certificates**: Auto-provision via Let's Encrypt for custom domains.
6. **Blue-green deployment**: Zero-downtime updates by deploying to new EC2 instance, then switching.
7. **App marketplace hosting**: Users browse & install apps with one click. App runs on contributed infrastructure.
8. **Per-app cost tracking**: Lux billing per deployment (S3 storage, EC2 compute, bandwidth).
9. **Health monitoring**: Per-app uptime checks. Auto-restart backends that crash. Alert contributors if resources go down.
10. **Multi-region**: Deploy to closest AWS region for lower latency.

## Resource Proxy Validation (Phase 63)

Resource Proxy validates project API keys using a P2P-first strategy:

1. **P2P lookup (primary):** `ProjectRegistry.validateApiKey(key)` hashes the incoming key with SHA-256 and looks it up in the local SQLite `project_registry` table. This works on ANY node — no MongoDB connection required.
2. **MongoDB fallback (secondary):** If the P2P lookup fails (project not yet synced, or registry miss), the Resource Proxy falls back to `ProjectStore` which queries MongoDB directly.
3. **Result:** The first successful validation returns the project metadata (projectId, assigned resources, visibility).

**Why this matters:**
- Before Phase 63, only nodes with a MongoDB connection could validate project API keys. This meant the Resource Proxy was effectively centralized.
- With P2P ProjectRegistry, ANY node in the network can serve as the validation backend for the Resource Proxy. A new node that has synced project records via GossipSub (or catch-up sync from LedgerSync) can validate keys without ever talking to MongoDB.
- This makes the Resource Proxy truly decentralized — if MongoDB goes down, existing projects with synced records still work.

**Data flow for validation:**
```
App request → Resource Proxy (gateway) → POST /resource-proxy/validate
  → ProjectRegistry.validateApiKey(SHA-256(key))  [P2P, local SQLite]
  → if miss: ProjectStore.validateApiKey(key)      [MongoDB]
  → return project metadata or 401 Unauthorized
```

## Phase 66: Autonomous App Pipeline

The full autonomous flow from user request to deployed app:

```
User → Gateway Chat → Node Bridge → Manager Agent
  1. Manager: POST /projects (create project, Bearer token auth)
  2. Manager: POST /projects/:id/preflight (auto-setup: API key + MongoDB)
  3. Manager: GET /projects/:id/preflight (verify ready: true)
  4. Manager: spawn builder with project context
  5. Builder: builds HTML/JS/CSS using Resource Proxy pattern
  6. Builder: POST /agents/:id/deploy (deploys to S3)
  7. System: URL injection (GATEWAY_URL, PROJECT_ID, API_KEY)
  8. System: GitHub push (source code to <token-owner>/app-<id>-<name>)
  9. System: Marketplace listing (project.deploymentUrl + deploymentStatus updated)
  10. Builder: POST /projects/:id/validate-deploy (health check)
  11. Builder: reports success to manager with URL
```

**Code persistence:** GitHub is the ONLY source of truth for all code. Source code pushed to GitHub → project record stores `repoUrl` → any node can clone and continue. No S3 source backup — code never flows through S3. Git is mandatory infrastructure (auto-installed if missing).

**GitHub push details:** Repos are created under the token owner's personal account using the `user/repos` API endpoint (not an org endpoint). The org endpoint (`orgs/<name>/repos`) is only used when an org name is explicitly specified in the `code_repository` resource metadata. This means if the contributed GitHub token belongs to user `pando-lux`, repos appear at `github.com/pando-lux/app-<id>-<name>`. If the token belongs to `someuser`, repos appear at `github.com/someuser/app-<id>-<name>`.

**Tier 2 deployment (EC2):** Uses P2P request-reply, NOT SSH/SSM. The managing node sends a `pando/deploy-app` message to the compute node's Pando instance. The compute node clones from GitHub, installs deps, and serves the app. This maintains the security model — no remote shell access to compute instances.

**Node resilience:** If creating node dies, another node spawns agent → clones from GitHub → has full source code → continues work.

**Compute instance upgrades:** Managing node sends `pando/upgrade-node` P2P message → instance pulls latest from `pando-lux/pando` → `npm run build` → restart. No SSH/SSM — P2P is the only management channel.

## Key Files

- `packages/node/src/hosting-service.ts` — S3 deployment, URL generation, pre-signed URLs
- `packages/node/src/agent-manager.ts` — `deployAgentWorkspace()` — workspace scanning, URL injection, deploy orchestration, GitHub push, marketplace listing
- `packages/node/src/agent-tools.ts` — `POST /agents/:id/deploy`, `POST /projects/:id/hosting` endpoints
- `packages/node/src/api-server.ts` — Hosting API routes, preflight, validate-deploy
- `genome/protocol.md` — 3 app patterns (Section 2)
- `genome/templates/manager.md` — Manager deployment instructions (Quick App Setup)
- `genome/templates/builder.md` — Builder app patterns (deploy + validate)
