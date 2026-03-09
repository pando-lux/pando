# Unified App Lifecycle — Architecture Roadmap

> **STATUS: PHASES 1-3 COMPLETE** — AppManager built, API mounted, legacy removed. Phase 4 (P2P deploy dispatch) remains TODO.
> **Created:** 2026-03-08
> **Goal:** One system to deploy, update, monitor, and rollback ALL running processes — pando-node and user apps alike.

---

## 1. Why This Exists

Pando currently has **three separate, unrelated systems** doing the same fundamental job — "run code from a git repo, keep it updated":

| What | Deploy | Update | Health | Rollback |
|------|--------|--------|--------|----------|
| pando-node | systemd/supervisor | governance → pull → build → exit(75) | `/v1/status` | git reset |
| User app (static) | S3 upload | rebuild → re-upload | none | none |
| User app (server) | PM2 + nginx | kill → clone → start | none | none |

**Problems at scale (hundreds of users):**
- No auto-update from GitHub pushes (no webhook)
- Port registry is a flat JSON file (`~/.pando/app-ports.json`) — one corrupt write loses everything
- No health checks — crashed apps stay crashed
- No rollback — broken deploy = broken app until manually fixed
- Kill-then-start = downtime on every update
- No node failover — if EC2 dies, all its apps are gone
- Zero shared code between node upgrade and app deploy

**This roadmap replaces all of it with ONE unified system.**

---

## 2. New Architecture: AppManager

### 2.1 Core Concept

Everything that runs is an **App**. pando-node is `app[0]`. User projects are `app[1..N]`. Same lifecycle, same registry, same health checks.

```
┌──────────────────────────────────────────────────────┐
│                    AppManager                         │
│         (SQLite — single source of truth)             │
├──────────────────────────────────────────────────────┤
│                                                       │
│  register(app)  → record in DB with full config       │
│  deploy(app)    → clone → build → start → health → OK │
│  update(app)    → pull → build new → blue-green swap   │
│  monitor(app)   → periodic health probe → auto-heal    │
│  migrate(app)   → host died → redeploy on new node     │
│  rollback(app)  → revert to previous commit            │
│  undeploy(app)  → stop → cleanup → deregister          │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### 2.2 App Registry Schema (SQLite)

**File:** `~/.pando/apps.db`

```sql
CREATE TABLE apps (
  id              TEXT PRIMARY KEY,    -- projectId or 'pando-node'
  name            TEXT NOT NULL,       -- human-readable
  repo_url        TEXT,                -- GitHub clone URL
  current_commit  TEXT,                -- commit hash running now
  target_commit   TEXT,                -- desired commit (null = track HEAD)
  build_cmd       TEXT DEFAULT 'npm run build',
  start_cmd       TEXT DEFAULT 'npm start',
  health_endpoint TEXT DEFAULT '/health',
  health_timeout  INTEGER DEFAULT 10000,   -- ms
  process_manager TEXT DEFAULT 'pm2',       -- 'pm2' | 'systemd' | 'supervisor'
  port            INTEGER,                  -- allocated port (null for pando-node)
  previous_port   INTEGER,                  -- for blue-green rollback
  host_peer_id    TEXT,                     -- which node runs this app
  host_address    TEXT,                     -- public IP of host
  tier            INTEGER DEFAULT 2,        -- 1=static(S3), 2=server(PM2)
  status          TEXT DEFAULT 'registered', -- see status enum below
  env_json        TEXT DEFAULT '{}',        -- JSON: env vars for the app
  deploy_url      TEXT,                     -- live URL after deploy
  previous_commit TEXT,                     -- for rollback
  error_message   TEXT,                     -- last error (null if healthy)
  created_at      INTEGER NOT NULL,
  deployed_at     INTEGER,
  updated_at      INTEGER,
  last_health_at  INTEGER,                  -- last successful health probe
  restart_count   INTEGER DEFAULT 0,
  max_restarts    INTEGER DEFAULT 10        -- circuit breaker
);

CREATE TABLE app_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT NOT NULL REFERENCES apps(id),
  action      TEXT NOT NULL,     -- 'deploy' | 'update' | 'rollback' | 'restart' | 'migrate'
  from_commit TEXT,
  to_commit   TEXT,
  from_port   INTEGER,
  to_port     INTEGER,
  status      TEXT NOT NULL,     -- 'success' | 'failed' | 'rolled_back'
  error       TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);
```

**Status enum:**
- `registered` — in DB but not deployed
- `deploying` — clone/build/start in progress
- `live` — running and healthy
- `unhealthy` — running but health checks failing
- `updating` — blue-green update in progress
- `failed` — deploy or update failed
- `stopped` — manually stopped
- `migrating` — moving to another node

### 2.3 AppManager Class

**File:** `packages/node/src/core/app-manager.ts` (NEW)

```typescript
export class AppManager {
  private db: Database;           // better-sqlite3
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(private node: PandoNode) {
    this.db = new Database(join(homedir(), '.pando', 'apps.db'));
    this.ensureSchema();
  }

  // ── Registration ──
  register(app: AppConfig): void;
  unregister(appId: string): void;
  get(appId: string): App | null;
  list(filter?: { status?: string; hostPeerId?: string }): App[];

  // ── Lifecycle ──
  async deploy(appId: string): Promise<DeployResult>;
  async update(appId: string, opts?: { targetCommit?: string }): Promise<UpdateResult>;
  async rollback(appId: string): Promise<RollbackResult>;
  async undeploy(appId: string): Promise<void>;

  // ── Health ──
  startMonitoring(intervalMs?: number): void;    // default 30s
  stopMonitoring(): void;
  async healthCheck(appId: string): Promise<boolean>;

  // ── Migration ──
  async migrate(appId: string, targetPeerId?: string): Promise<MigrateResult>;

  // ── Internal ──
  private async blueGreenSwap(app: App, newPort: number): Promise<void>;
  private allocatePort(): number;
  private releasePort(port: number): void;
  private updateNginx(appId: string, port: number): void;
  private removeNginx(appId: string): void;
  private recordHistory(appId: string, action: string, details: Partial<AppHistory>): void;
}
```

### 2.4 Deploy Flow (New App)

```
register(app) → deploy(app):
  1. git clone {repo_url} → ~/.pando/hosted-apps/{appId}/
  2. npm install --production
  3. Run build_cmd
  4. Allocate port from DB (start at 3001, skip used)
  5. PM2 start: PORT={port} pm2 start {start_cmd} --name app-{appId}
  6. Wait 5s, then health check: GET http://localhost:{port}{health_endpoint}
  7. If healthy:
     - Write nginx config → /etc/nginx/pando-apps/{appId}.conf
     - nginx reload
     - Update DB: status='live', port, current_commit, deployed_at
     - Record history: action='deploy', status='success'
  8. If unhealthy:
     - pm2 delete app-{appId}
     - Release port
     - Update DB: status='failed', error_message
     - Record history: action='deploy', status='failed'
```

### 2.5 Update Flow (Blue-Green)

```
update(app):
  1. git -C {appDir} fetch origin
  2. newCommit = git rev-parse origin/main
  3. If newCommit == current_commit → skip (already current)
  4. git -C {appDir} checkout {newCommit}
  5. npm install --production
  6. Run build_cmd
  7. Allocate TEMP port (different from current)
  8. PM2 start on temp port: app-{appId}-staging
  9. Health check temp port
  10. If healthy:
      - Update nginx to point to temp port
      - pm2 delete app-{appId} (old process)
      - pm2 rename app-{appId}-staging → app-{appId}
      - Update DB: previous_commit=old, current_commit=new, previous_port=old, port=temp
      - Release old port
      - Record history: action='update', status='success'
  11. If unhealthy:
      - pm2 delete app-{appId}-staging
      - Release temp port
      - git -C {appDir} checkout {current_commit} (restore)
      - App continues running on old port (zero downtime)
      - Update DB: error_message
      - Record history: action='update', status='failed'
```

### 2.6 Rollback Flow

```
rollback(app):
  1. If no previous_commit → error (nothing to rollback to)
  2. git -C {appDir} checkout {previous_commit}
  3. npm install --production
  4. Run build_cmd
  5. Blue-green swap (same as update steps 7-11)
  6. Update DB: current_commit=previous_commit, previous_commit=null
  7. Record history: action='rollback'
```

### 2.7 Health Monitor

```
startMonitoring(intervalMs = 30_000):
  Every 30s, for each app where status='live':
    1. GET http://localhost:{port}{health_endpoint} (timeout: health_timeout ms)
    2. If 2xx:
       - Update last_health_at
       - If status was 'unhealthy' → set 'live', reset restart_count
    3. If fails:
       - Increment restart_count
       - If restart_count < max_restarts:
         - pm2 restart app-{appId}
         - Update status='unhealthy'
         - Record history: action='restart'
       - If restart_count >= max_restarts:
         - Circuit breaker: stop restarting
         - Update status='failed', error_message='max restarts exceeded'
         - Record history: action='restart', status='failed'
         - (Future: trigger migrate to another node)
```

### 2.8 Tier 1 (Static/S3) — Simplified

Static apps don't need PM2, health checks, or blue-green. They upload to S3 and are done.

```
deploy(app) where tier=1:
  1. git clone → appDir
  2. Run build_cmd (if exists)
  3. Scan for static files (html, css, js, images)
  4. Upload to S3: s3://pando-deployments/public/{appId}/
  5. Update DB: status='live', deploy_url=s3Url
  6. No port, no PM2, no nginx, no health check

update(app) where tier=1:
  1. git pull
  2. Re-build (if exists)
  3. Re-upload to S3 (overwrites)
  4. Update DB: current_commit
```

### 2.9 pando-node as App Zero

pando-node registers itself on boot but has special handling:

```typescript
// On node startup (index.ts):
this.appManager.register({
  id: 'pando-node',
  name: 'Pando Node',
  repoUrl: 'https://github.com/pando-lux/node.git',
  buildCmd: 'npm run build',
  startCmd: 'node packages/node/dist/cli.js',
  healthEndpoint: '/v1/status',
  processManager: process.platform === 'win32' ? 'supervisor' : 'systemd',
  tier: 2,
  port: null,  // uses API port, managed externally
});
```

**pando-node does NOT use blue-green.** It can't — it IS the running process. It keeps its existing upgrade path: `exit(75)` → supervisor/systemd respawn. But it lives in the same DB, same history table, same monitoring.

The `upgrade-protocol.ts` calls `appManager.recordHistory('pando-node', 'update', ...)` after each upgrade so the history is unified.

### 2.10 Update Triggers

All triggers feed into the same `appManager.update(appId)`:

| Trigger | Source | Target |
|---------|--------|--------|
| Governance proposal | upgrade-protocol.ts | `update('pando-node')` |
| PandoCode build complete | platform-api.ts `sendToEngine()` callback (4 sites) + init-kernel.ts chat_proxy (1 site) | `update(projectId)` — **PRIMARY trigger for user apps** |
| Manual API | `POST /v1/apps/:id/update` | `update(appId)` |
| Health failure | AppManager monitor loop | `restart` or `rollback(appId)` |
| GitHub webhook (passive) | `POST /v1/webhooks/github` — available but NOT the primary flow | `update(projectId)` — lookup by repo_url |

### 2.11 API Endpoints (New)

Replace scattered deploy endpoints with unified app lifecycle API:

```
POST   /v1/apps                    — register new app
GET    /v1/apps                    — list all apps (with status filter)
GET    /v1/apps/:id                — get app details + recent history
POST   /v1/apps/:id/deploy         — deploy (first time)
POST   /v1/apps/:id/update         — trigger update (pull + blue-green)
POST   /v1/apps/:id/rollback       — rollback to previous commit
POST   /v1/apps/:id/stop           — stop app (pm2 stop)
POST   /v1/apps/:id/start          — start stopped app
DELETE /v1/apps/:id                — undeploy + deregister
GET    /v1/apps/:id/health         — on-demand health check
GET    /v1/apps/:id/history        — deployment history
GET    /v1/apps/:id/logs           — pm2 logs (last N lines)
POST   /v1/webhooks/github         — GitHub push webhook receiver
```

---

## 3. Legacy Code to DELETE

**No hacks. No fallbacks. No compatibility shims. Delete everything listed below.**

### 3.1 Files to Delete Entirely

| File | Lines | Why |
|------|-------|-----|
| `packages/node/src/core/deploy-pipeline.ts` | 359 | Replaced by `AppManager.deploy()` + `AppManager.update()` |
| `packages/node/src/core/hosting-adapters.ts` | 88 | Vercel/Netlify adapters — dead code, only imported by gateway-deploy-pool |
| `packages/node/src/core/gateway-deploy-pool.ts` | 189 | Gateway is on Vercel separately; this pool is unused in production |
| `packages/node/src/platform/hosting-service.ts` | ~250 | S3 upload logic absorbed into AppManager Tier 1 deploy. Used at platform-api.ts lines 2890, 2959, 2986, 3007, 3018, 3037, 3817, 3867 — all replaced by AppManager |

### 3.1b Files to KEEP (NOT deleted — verified still needed)

| File | Why it stays |
|------|-------------|
| `packages/node/src/core/deploy-manager.ts` | Used by **PipelineRunner** for pando-node's OWN code changes (patch → build → commit → rollback). NOT related to user app deployment. Imported at `index.ts:43`, wired into PipelineRunner at `index.ts:1220`. |
| `packages/node/src/platform/pipeline-runner.ts` | Code patch pipeline for pando-node. Uses DeployManager for backup/build/commit. Unrelated to user app lifecycle. |

### 3.2 Code Blocks to Delete (in files that survive)

| File | What to Remove | Why |
|------|----------------|-----|
| `init-platform.ts` | `pando/deploy-app` handler (lines 81-363) | Moves into AppManager.deploy() |
| `init-platform.ts` | `pando/undeploy-app` handler (lines 380-432) | Moves into AppManager.undeploy() |
| `init-platform.ts` | Startup reconciliation (lines 434-472) | AppManager.startMonitoring() replaces |
| `init-platform.ts` | Port registry JSON read/write logic | SQLite replaces app-ports.json |
| `platform-api.ts` | `triggerDeployPipeline()` function (line 89-121) | Replaced by `appManager.update(projectId)` |
| `platform-api.ts` | 4 `triggerDeployPipeline()` call sites (lines 168, 297, 485, 600) | Replace with `appManager.update(projectId)` |
| `platform-api.ts` | `POST /v1/projects/:id/deploy` endpoint (line ~3525) | Replaced by `POST /v1/apps/:id/deploy` |
| `platform-api.ts` | `POST /v1/projects/:id/undeploy` endpoint | Replaced by `DELETE /v1/apps/:id` |
| `platform-api.ts` | HostingService usage at 5 call sites (lines 2890, 2986, 3018, 3817, 3867) | Replaced by AppManager Tier 1 deploy |
| `index.ts` | `GatewayDeployPool` import (line 71), field (line 169), getter (line 670-672), cleanup (line 1522-1523) | Dead module |
| `index.ts` | `HostingService` import (line 69), field (line 190), getter (line 1442-1443) | Absorbed into AppManager |
| `core/index.ts` | Exports for DeployPipeline, HostingAdapters, GatewayDeployPool | Dead modules |
| `platform/index.ts` | Export for HostingService | Absorbed into AppManager |

**NOTE:** DeployManager exports in `index.ts` (line 1598-1599) and `core/index.ts` STAY — PipelineRunner depends on them.

### 3.3 Data Files to Delete

| File | Replacement |
|------|-------------|
| `~/.pando/app-ports.json` | `apps` table in `~/.pando/apps.db` |
| `~/.pando/.deploy-backups/` | Git history (no need for file-copy backups) |

### 3.4 Legacy Logic to NOT Carry Forward

- **Fire-and-forget deploy** — every deploy now has health check confirmation
- **Port registry as JSON file** — SQLite only
- **Backup-as-directory-copy** — git is the backup
- **Tier auto-detection at deploy time on EC2** — detect at registration, store in DB
- **Separate deploy+undeploy P2P handlers** — AppManager handles locally, P2P is just the transport
- **nginx config without health check** — nginx only written AFTER health check passes
- **`pm2 save` after every operation** — PM2 is ephemeral process manager, AppManager DB is truth

---

## 4. Files to Create

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `packages/node/src/core/app-manager.ts` | **THE** unified app lifecycle manager | ~600 |
| `packages/node/src/api/app-api.ts` | HTTP API routes for `/v1/apps/*` + webhook | ~250 |

**That's it. Two new files replace four deleted files + scattered handlers.**

---

## 5. Files to Modify

| File | Changes |
|------|---------|
| `packages/node/src/index.ts` | Remove GatewayDeployPool + HostingService (import, field, getter, cleanup). Add `AppManager` field + getter. Register pando-node as app[0] in `start()`. Start health monitoring. |
| `packages/node/src/init-platform.ts` | Remove `pando/deploy-app` handler (lines 81-363), `pando/undeploy-app` handler (lines 380-432), startup reconciliation (lines 434-472), port registry JSON logic (line 66+). Keep all non-deploy handlers. |
| `packages/node/src/api/platform-api.ts` | Remove `triggerDeployPipeline()` (line 89-121) + 4 call sites (168, 297, 485, 600) → replace with `appManager.update(projectId)`. Remove deploy/undeploy project endpoints. Remove HostingService call sites (5 places). Keep GitHub push endpoint (`/projects/:id/github/push` at line 3440). |
| `packages/node/src/api/api-server.ts` | Import + mount `registerAppRoutes()` at line ~400 (between platform and testing routes) |
| `packages/node/src/core/upgrade-protocol.ts` | After successful upgrade, call `appManager.recordHistory('pando-node', 'update', ...)` |
| `packages/node/src/core/index.ts` | Remove exports for DeployPipeline, HostingAdapters, GatewayDeployPool. Add AppManager export. Keep DeployManager exports. |
| `packages/node/src/platform/index.ts` | Remove HostingService export |

---

## 6. Implementation Phases

### Phase 1: AppManager Core (app-manager.ts)

**Build the foundation. No API, no integration yet.**

1. Create `~/.pando/apps.db` with schema (apps + app_history tables)
2. Implement `register()`, `get()`, `list()`, `unregister()`
3. Implement `deploy()` for Tier 2 (clone → build → PM2 → health check → nginx)
4. Implement `deploy()` for Tier 1 (clone → build → S3 upload)
5. Implement `update()` with blue-green swap
6. Implement `rollback()`
7. Implement `undeploy()`
8. Implement `healthCheck()` and `startMonitoring()`
9. Implement `recordHistory()` and history queries
10. Port allocation via DB (not JSON file)

**Test:** Unit test deploy/update/rollback with mock PM2 commands.

### Phase 2: API Layer (app-api.ts)

1. Create all `/v1/apps/*` endpoints
2. Create `POST /v1/webhooks/github` — parse GitHub push payload, lookup app by repo_url, trigger update
3. Mount in `api-server.ts` (line ~400, between platform and testing routes)

**Test:** curl endpoints, verify DB state changes.

### Phase 3: Integration + Legacy Removal

1. Wire `AppManager` into `PandoNode` (index.ts) — init on startup, register pando-node
2. Replace `triggerDeployPipeline()` calls in platform-api.ts with `appManager.update(projectId)`
3. Wire `upgrade-protocol.ts` to record history in AppManager
4. Delete: deploy-pipeline.ts, hosting-adapters.ts, gateway-deploy-pool.ts, hosting-service.ts (NOT deploy-manager.ts — PipelineRunner needs it)
5. Remove deploy handlers from init-platform.ts
6. Remove old deploy endpoints from platform-api.ts
7. Remove port registry JSON logic
8. Clean up index.ts exports

**Test:** Full deploy flow end-to-end. PandoCode builds app → auto-update triggers → blue-green deploy → health check passes.

### Phase 4: P2P Deploy Dispatch

1. When `deploy()` or `update()` is called and app's `host_peer_id` is a remote node:
   - Send P2P message to that node's AppManager
   - Remote AppManager handles locally
2. If host node is unreachable, `migrate()` finds new host

**Test:** Deploy from Windows dev machine → EC2 node handles deploy → app live.

### ~~Phase 5: GitHub Webhook Integration~~ — REMOVED

**Not needed.** The trigger is already in-code: PandoCode build completes → `appManager.update(projectId)` fires automatically (wired at 4 call sites in platform-api.ts + 1 in init-kernel.ts). GitHub is just storage — the node already knows when a build finishes because it ran the build. No webhook needed.

If GitHub is replaced with another git host (or self-hosted repos) in the future, zero code changes needed — AppManager pulls from whatever `repo_url` is registered. The `/v1/webhooks/github` endpoint in app-api.ts remains available as a passive receiver if ever needed, but is not part of the core flow.

---

## 7. Migration from Old Data

**We don't migrate. We start clean.**

- Old `app-ports.json` → ignored (delete it)
- Old PM2 processes → `pm2 delete all` on EC2 nodes
- Old deploy metadata in ProjectStore → stale, ignored by new system
- Any existing deployed apps → re-deploy through new system

**Rationale:** There are zero production user apps running right now. The only deployed things are pando-node instances (managed by systemd, unaffected) and test apps (disposable). Clean slate is correct.

---

## 8. What pando-node's Upgrade Protocol Keeps

`upgrade-protocol.ts` is NOT replaced. It handles pando-node's special case:

- Governance-triggered upgrades (P2P broadcast)
- Git pull with hash verification
- Build with npm→tsc fallback
- Safe restart: wait for workers + messages to drain
- exit(75) → supervisor/systemd respawn

The only change: after successful upgrade, it calls `appManager.recordHistory('pando-node', 'update', { fromCommit, toCommit })` so the history is unified.

**Why pando-node can't use blue-green:** It IS the running process. You can't start a second pando-node on a different port and swap — it owns the P2P identity, the libp2p listeners, the SQLite databases. The exit(75) path is correct for this case.

---

## 9. What DeployPipeline Currently Does (For Reference During Build)

The current `triggerDeployPipeline()` flow that we're replacing:

```
1. stepGithubPush()      → POST /v1/projects/{id}/github/push (create repo + push)
2. stepFindDeployTarget() → CapabilityRegistry filter (credentialAccess + mongodb)
3. stepP2PDeploy()        → pando/deploy-app handler (clone → detect tier → S3/PM2)
4. stepUpdateMetadata()   → ProjectStore (repoUrl, deployUrl, deployPeerId, status)
```

**AppManager replaces steps 2-4.** Step 1 (GitHub push) stays — it's called before `appManager.deploy()` or `appManager.update()` if the app has a GitHub repo.

The GitHub push logic in `platform-api.ts` (repo creation, force-push) remains as a utility. It's called by the PandoCode build completion handler before triggering `appManager.update()`.

---

## 10. Dependencies

### better-sqlite3
AppManager needs `better-sqlite3` (synchronous SQLite). Currently only in `@pando/ledger` (`packages/ledger/package.json` line 15: `"better-sqlite3": "^11.0.0"`). **Must add to `packages/node/package.json`** as a direct dependency — don't rely on hoisting from another package.

```bash
cd packages/node && npm install better-sqlite3 && npm install -D @types/better-sqlite3
```

### S3 Credentials for Tier 1 — Contributed Resources (DO NOT BREAK)

**Two S3 credential paths exist today — only ONE is correct:**

| File | How it gets S3 creds | Correct? |
|------|---------------------|----------|
| `hosting-service.ts` | `~/.aws/credentials` (AWS SDK auto-discovery) | **NO** — bypasses contributed resource system |
| `init-platform.ts` (deploy handler) | `ResourceRegistry.getCredential()` → decrypt via CREDENTIAL_MASTER_KEY | **YES** — uses contributed resources |

**AppManager MUST use the `init-platform.ts` approach:**
1. `ResourceRegistry.findResources('storage_blob')` → find contributed S3 resource
2. `ResourceRegistry.getCredential(resourceId)` → decrypt S3 access key
3. Parse as JSON (`{ accessKeyId, secretAccessKey, region, bucket }`)
4. Create `S3Client` with explicit credentials
5. Upload files

**The contributed resource system (`/contribute`, ResourceRegistry, CredentialVault) is NOT touched by this roadmap.** AppManager is a consumer of credentials, not a provider. The existing flow:
```
/contribute storage_blob <token> → AES-256-GCM encrypt → MongoDB →
ResourceRegistry.getCredential() → decrypt → S3Client
```
...remains exactly the same. AppManager just calls `getCredential()` where init-platform.ts used to.

Same applies to GitHub token: `ResourceRegistry.getCredential()` for `code_repository` resources. The GitHub push endpoint in platform-api.ts already does this correctly (line 3440+) and is NOT being deleted.

### @aws-sdk/client-s3
Already a dependency of `@pando/node`. No new install needed for S3.

---

## 11. Success Criteria

Before marking this roadmap COMPLETE, all of these must be true:

- [ ] `apps.db` created on node startup with correct schema
- [ ] pando-node registered as app[0] on boot
- [ ] `POST /v1/apps` registers a new app
- [ ] `POST /v1/apps/:id/deploy` clones, builds, starts, health-checks a Tier 2 app
- [ ] `POST /v1/apps/:id/update` does blue-green swap with zero downtime
- [ ] `POST /v1/apps/:id/rollback` reverts to previous commit
- [ ] Health monitor detects crashed app and restarts it
- [ ] Circuit breaker stops restart loop after max_restarts
- [ ] `DELETE /v1/apps/:id` stops process, removes nginx, cleans up
- [ ] `GET /v1/apps` returns all apps with correct status
- [ ] `GET /v1/apps/:id/history` returns deploy/update/rollback timeline
- [ ] PandoCode build completion triggers `appManager.update()` (not legacy pipeline)
- [ ] `POST /v1/webhooks/github` triggers update on matching app
- [ ] All 4 legacy files deleted (deploy-pipeline, hosting-adapters, gateway-deploy-pool, hosting-service)
- [ ] `app-ports.json` no longer read or written anywhere
- [ ] `pando/deploy-app` and `pando/undeploy-app` handlers removed from init-platform
- [ ] `npm run build` passes with zero errors
- [ ] E2E: deploy test app → update it → verify blue-green → rollback → verify old version restored

---

## 12. Non-Goals (Explicitly Out of Scope)

- **Custom domains** — future feature, not blocking
- **Database provisioning** — apps bring their own DB connections
- **Multi-region deployment** — single region (us-east-1) for now
- **Container/Docker support** — PM2 is sufficient for current scale
- **CI/CD pipeline** — AppManager IS the CI/CD
- **Log aggregation** — PM2 logs accessible via API, no centralized logging yet
- **Auto-scaling** — one instance per app, scale later
- **SSL/TLS for app URLs** — nginx handles at the EC2 level, not per-app

---

## 13. Scaling Analysis: Thousands of Nodes × Thousands of Apps

### Why This Architecture Scales

**Each node manages its OWN apps.** There's no central coordinator. The `apps.db` on each EC2 node only tracks apps running on THAT node. This is the same pattern as systemd — every machine manages its own services.

```
Node A (EC2-1):  apps.db → [pando-node, app-1, app-2, app-5]
Node B (EC2-2):  apps.db → [pando-node, app-3, app-4, app-6]
Node C (EC2-3):  apps.db → [pando-node, app-7, app-8]
```

**P2P discovery handles routing.** When a user deploys, `CapabilityRegistry` finds which node has capacity. The deploying node sends a P2P message to the target. The target's AppManager handles it locally. No central bottleneck.

**Health monitoring is local.** Each node monitors its own apps (30s interval). If an app crashes, the local AppManager restarts it. No cross-node health check traffic.

### What Scales Naturally

| Concern | Why it scales |
|---------|--------------|
| **App count** | Each node only monitors its own apps. 100 apps/node = 100 HTTP health checks every 30s = trivial. |
| **Deploy throughput** | Deploys are node-local. 10 nodes can deploy 10 apps simultaneously. No queue. |
| **Port allocation** | Each node manages its own port range (3001+). No cross-node port conflicts. |
| **SQLite** | `apps.db` is per-node, ~100 rows max. SQLite handles millions of rows — this is nothing. |
| **nginx** | Per-node config. Each node has its own `/etc/nginx/pando-apps/`. No shared state. |

### What Needs Attention at Scale

| Concern | Current | At 1000+ nodes |
|---------|---------|----------------|
| **App discovery** | `ProjectStore` has `deployPeerId` | Need a P2P app registry (GossipSub topic `pando/apps`) so any node can answer "where is app X running?" |
| **Load balancing** | First available EC2 node | Need capacity-aware placement: CPU, memory, port count, disk. `CapabilityRegistry` already has CPU/memory — just add `runningAppCount`. |
| **Node failure** | Apps lost when node dies | Need cross-node heartbeat. If node A doesn't heartbeat for 5 min, node B claims its apps and redeploys. Use governance for consensus on "node A is dead." |
| **App migration** | Manual `migrate()` | Should be automatic when node capacity is unbalanced. Governance can propose migrations. |
| **Networking** | All apps share EC2 public IP | Need DNS-based routing or a load balancer per region. Out of scope for now. |

### The Architecture Is Correct Because

1. **No single point of failure.** Every node is self-sufficient. Kill any node and the rest keep running.
2. **No central database.** Each node has its own `apps.db`. P2P sync handles cross-node awareness.
3. **Same protocol for everything.** pando-node upgrades and user app deploys use the same mental model (git repo → build → run → health check). One system to understand, one system to debug.
4. **Governance handles coordination.** Node failures, app migrations, capacity decisions — all go through the existing governance system. No new consensus mechanism needed.
5. **Blue-green is the default.** Zero-downtime deploys from day one. No "we'll add it later."

### What This Architecture Does NOT Try To Be

- **Not Kubernetes.** No containers, no pods, no orchestration layer. PM2 + nginx is sufficient for Node.js apps at this scale.
- **Not a CDN.** Static apps go to S3. No edge caching, no geo-distribution.
- **Not multi-tenant isolated.** Apps share the OS. Process isolation via PM2 is sufficient for now. Sandboxing is a future concern.

---

## 14. Architecture Diagram

```
                    ┌─────────────────────┐
                    │   Trigger Sources    │
                    ├─────────────────────┤
                    │ • Governance (node)  │
                    │ • PandoCode build    │
                    │ • GitHub webhook     │
                    │ • Manual API call    │
                    │ • Health failure     │
                    └────────┬────────────┘
                             │
                             ▼
                    ┌─────────────────────┐
                    │    AppManager        │
                    │  (app-manager.ts)    │
                    ├─────────────────────┤
                    │ register / deploy    │
                    │ update (blue-green)  │
                    │ rollback / undeploy  │
                    │ monitor / migrate    │
                    └────────┬────────────┘
                             │
                ┌────────────┼────────────┐
                │            │            │
                ▼            ▼            ▼
         ┌───────────┐ ┌──────────┐ ┌──────────┐
         │ apps.db   │ │   PM2    │ │  nginx   │
         │ (SQLite)  │ │ (procs)  │ │ (routes) │
         └───────────┘ └──────────┘ └──────────┘
              │
              ▼
         ┌───────────┐
         │app_history│
         │ (audit)   │
         └───────────┘
```

```
Blue-Green Update:

  ┌──────────┐    ┌──────────────┐    ┌──────────┐
  │  nginx   │───▶│ app (port A) │    │ staging  │
  │ :80/443  │    │   LIVE       │    │ (port B) │
  └──────────┘    └──────────────┘    └──────────┘
                                           │
       health check passes ───────────────▶│
                                           │
  ┌──────────┐    ┌──────────────┐    ┌──────────┐
  │  nginx   │───▶│ app (port B) │    │ old (A)  │
  │  SWAPPED │    │   NOW LIVE   │    │  KILLED  │
  └──────────┘    └──────────────┘    └──────────┘
```
