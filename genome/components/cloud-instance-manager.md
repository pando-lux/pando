---
id: cloud-instance-manager
title: Cloud Instance Manager
owner: node
created: 2026-02-23
phase: 65
status: implemented
---

# Cloud Instance Manager

> **Phase 87 note:** Deploy/undeploy no longer use CloudInstanceManager. Compute peer discovery is now handled by P2P CapabilityProfile (same pattern as P2PStorageBackend). CloudInstanceManager is retained only for on-demand EC2 launch/terminate (`POST /instances/launch`, `POST /instances/:id/terminate`).

## Purpose

Launches and manages secure EC2 compute instances from contributed AWS credentials. Instances run Pando nodes in `compute` mode — no SSH access, tripwire-monitored, all management via P2P.

## Source

`packages/node/src/cloud-instance-manager.ts`

## Dependencies

- `@aws-sdk/client-ec2` — EC2 API (dynamic import, only loaded when launching)
- `ResourceRegistry` — decrypt contributed AWS credentials
- `PandoLedger` — SQLite persistence for instance records
- `PandoNetwork` — discover bootstrap peers for new instances

## API Surface

### Class: `CloudInstanceManager`

| Method | Description |
|---|---|
| `init()` | Create SQLite table, load existing records |
| `launchInstance(resourceId, options?)` | Launch a secure EC2 instance |
| `terminateInstance(instanceId)` | Terminate an instance |
| `checkInstanceHealth(instanceId)` | Check instance state via AWS API |
| `getInstances()` | List all tracked instances |
| `getInstance(instanceId)` | Get a single instance record |
| `linkPeer(instanceId, peerId)` | Associate a P2P peer with an instance |
| `addApp(instanceId, projectId)` | Track app deployment |
| `getConsoleOutput(instanceId)` | Get serial console output via AWS API (monitoring without SSH) |
| `autoGrantResources(peerId)` | Auto-grant wrapped resource keys to a compute instance on P2P connect |
| `deployTestApp(instanceId)` | Deploy test app from repo to a running instance |
| `upgradeInstance(instanceId)` | Upgrade node code on a running instance via P2P |

### HTTP Endpoints (via ApiServer)

| Endpoint | Method | Description |
|---|---|---|
| `/instances` | GET | List all managed instances |
| `/instances/:id` | GET | Get single instance details |
| `/instances/launch` | POST | Launch new instance `{ resourceId, instanceType?, region? }` |
| `/instances/:id/terminate` | POST | Terminate an instance |
| `/instances/:id/health` | GET | Check instance health via AWS |
| `/instances/:id/console` | GET | Get serial console output (cloud-init logs). `?lines=N` for last N lines |
| `/instances/:id/deploy` | POST | Deploy app to instance `{ projectId }` |
| `/instances/:id/upgrade` | POST | Upgrade node code via P2P (Phase 67) |
| `/apps/:appName/deploy` | POST | Deploy static files to local app hosting (auth required) |
| `/apps/:appName/*` | GET | Serve hosted app files with URL injection |

### TUI Commands

| Command | Description |
|---|---|
| `/launch <resourceId> [type] [region]` | Launch secure EC2 instance |
| `/instances` | List cloud instances |
| `/terminate <instanceId>` | Terminate a cloud instance |
| `/upgrade-instance <instanceId>` | Upgrade node code on a running compute instance |

## Launch Flow

1. Decrypt AWS credentials from ResourceRegistry
2. Create EC2Client with those credentials
3. Ensure security group exists (P2P + API + nginx port 80, NO SSH)
4. Generate user-data bootstrap script
5. RunInstances with Ubuntu 24.04 AMI, no KeyName (no SSH key)
6. Store InstanceRecord in SQLite
7. Poll for public IP (background, 5-min timeout)
8. Wipe credentials from memory

## User-Data Bootstrap Script

Cloud-init script that runs once at instance boot:

1. **Remove SSH + SSM agent** (FIRST — before anything else, so tripwire doesn't false-positive)
2. Disable swap (swapoff + remove from fstab)
3. Install Node.js 22 + build tools + **nginx** (Phase 80)
4. **Install PM2 globally** (Phase 80)
5. Clone Pando from public repo (`https://github.com/pando-lux/pando.git`)
6. Run `npm ci` (install dependencies)
7. Run `npm run build` (**REQUIRED** — `dist/` is gitignored, NOT in the repo)
8. Create `pando` user (no login shell)
9. **Configure nginx** (Phase 80) — base config with `/etc/nginx/pando-apps/*.conf` include, sudoers for `pando` to reload nginx
10. **PM2 startup systemd** (Phase 80) — `pm2 startup` for app persistence across reboots
11. Set git identity for `pando` user (name + email for upgrade-protocol commits)
12. Seed API token for remote management
13. Set `GATEWAY_PUBLIC_URL` env var for URL injection
14. Install security monitor (tripwire)
15. Create systemd services (pando-node + pando-monitor)
16. Start services
17. Deploy test app from repo (`tests/test-app/`)

Output goes to both `/var/log/pando-bootstrap.log` AND serial console (via `tee`) so we can monitor via `GetConsoleOutput` API.

**CRITICAL: `dist/` is NOT in the git repo.** The `.gitignore` excludes `dist/`. Every instance MUST run `npm run build` after cloning. If skipped, the node crashes with `MODULE_NOT_FOUND`.

## Credential Access (Phase 69)

EC2 compute instances receive `CREDENTIAL_MASTER_KEY` and `PANDO_STORAGE_URL` via environment variables injected in the user-data bootstrap script at launch time. This gives them direct access to decrypt credentials from MongoDB without any per-node key wrapping. When an instance connects to the P2P network, it is auto-linked by IP to its CloudInstanceRecord.

## Security Monitor (Tripwire)

Bash script running as root, checks every second:

1. Active login sessions (`who`)
2. sshd process running
3. SSM agent running
4. Debugger attached to pando process (TracerPid)
5. Unexpected root shells

On ANY detection: kill all processes, wipe all credential data, zero-fill, shutdown.

## SQLite Schema

```sql
CREATE TABLE cloud_instances (
  instance_id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  region TEXT NOT NULL,
  instance_type TEXT NOT NULL,
  public_ip TEXT,
  peer_id TEXT,
  status TEXT NOT NULL DEFAULT 'launching',
  launched_at INTEGER NOT NULL,
  terminated_at INTEGER,
  mode TEXT NOT NULL DEFAULT 'compute',
  apps TEXT NOT NULL DEFAULT '[]',
  error TEXT
);
```

## App Deployment (Tier 2 — P2P)

Deploying apps to a running compute instance uses P2P request-reply. **No SSH, no SSM, no S3 code transfer.**

### Deploy Flow
```
1. Managing node: POST /instances/:id/deploy { projectId, repoUrl }
2. CloudInstanceManager.deployApp() sends P2P request to compute node's peerId
3. Compute node's pando/deploy-app handler:
   a. git clone <repoUrl> (or git pull if already cloned)
   b. npm install --production (if package.json exists)
   c. Start backend process on assigned port (3001, 3002, ...)
   d. Static apps served via /apps/:appName/* endpoint (port 4000)
4. Response back to managing node: { status, port, pid }
```

### Upgrade Flow (Node Code Update)
```
1. Managing node: sends pando/upgrade-node P2P message
2. Compute node: git pull pando-lux/pando -> npm run build -> restart
3. All hosted apps survive the restart (separate processes)
```

### App Management
- One instance hosts MANY apps simultaneously
- Each backend app gets its own port (3001, 3002, ...)
- Static apps share port 4000 via /apps/:appName/* routes
- Re-deploying same projectId: kills old process, pulls latest, restarts
- Apps persist across node restarts (stored in ~/.pando/hosted-apps/)

## Security Group

Name: `pando-compute-node`
- Port 4001 TCP from 0.0.0.0/0 (P2P)
- Port 4000 TCP from 0.0.0.0/0 (API + static app hosting)
- Ports 3001-3100 TCP from 0.0.0.0/0 (Backend app ports)
- **No port 22** (SSH intentionally omitted)

## Node Modes (Phase 64)

| Mode | What runs | Use case |
|---|---|---|
| `full` (default) | Everything | Double-click users, dev nodes |
| `compute` | P2P + ledger + hosting + resource proxy | Cloud instances (no Claude Code) |
| `relay` | P2P + ledger sync only | Lightweight routing nodes |

## Rules

1. Never store plaintext AWS credentials on disk
2. Always wipe credentials from memory after use
3. No SSH on compute instances — management via P2P only
4. Tripwire must always run alongside the node
5. Security group must never include port 22
6. Security group description must be ASCII-only (AWS rejects Unicode)
7. Tripwire must wait for cloud-init to finish before arming (avoids false positives from root shells during bootstrap)
8. SSM agent must be removed in bootstrap (pre-installed on Ubuntu AMIs, triggers tripwire)
9. Use `npm ci` (not `--ignore-scripts`) — native modules like better-sqlite3 need compilation
10. `--public` is not a valid CLI flag — don't add it to ExecStart
11. `npm run build` is REQUIRED — `dist/` is gitignored and not in the repo. Never skip the build step.
12. Seed API token during bootstrap so the launching node can manage the instance remotely
13. Auto-grant resource keys to compute instances on P2P connect (solves cold-start key problem)
14. All public code pushes to `pando-lux/pando` only — never personal accounts. See `genome/rules/credential-security.md` Rule 9.
15. App deploy via P2P only — never SSH, SSM, or direct file transfer. `pando/deploy-app` request-reply handler.
16. Security group must include app port range (3001-3100) for Tier 2 backend apps
17. After rebuilding code locally, RESTART the node before launching new instances (user-data is generated at launch time from running code)

## Known Issues & Lessons

| Issue | Root Cause | Fix |
|---|---|---|
| Instance used default VPC security group | `ensureSecurityGroup()` returned null on failure | Throw on failure, always pass sgId |
| Bootstrap failed silently | GitHub repo was private, `git clone` failed | Made repo public at `pando-lux/pando` |
| Instance shut down immediately | Tripwire detected SSM agent (pre-installed on Ubuntu) | Remove SSM agent in bootstrap before tripwire arms |
| Tripwire false positive during cloud-init | Root bash shells from cloud-init | Added `cloud-init status --wait` before arming |
| Node not listening | `npm ci --ignore-scripts` skipped better-sqlite3 | Use `npm ci` without `--ignore-scripts` |
| AWS rejected SG creation | Unicode in description | Use ASCII-only descriptions |
| Console output invisible | `exec > file` hid serial output | Use `exec > >(tee file)` for both |
| `--public` flag not recognized | Not a valid CLI flag | Removed from ExecStart |
| EC2 not reachable as P2P peer | VPC NAT, no public IP announce | Need relay or public IP announcement |
| **Node crash: MODULE_NOT_FOUND** | **`dist/` is gitignored, build was skipped** | **Always run `npm run build` in bootstrap** |
| **SSM deploy failed** | **SSM violates security model (no remote shell)** | **Removed SSM. P2P request-reply only.** |
| **Push to pando-lux blocked** | **AWS secrets in old commits** | **Orphan branch push (clean snapshot). See `scripts/push-public.sh`** |
| **Apps unreachable on ports 3001+** | **SG only had 4000/4001** | **Added 3001-3100 range** |
| **Stale user-data after rebuild** | **Running node uses loaded code, not latest build** | **Restart node after rebuild, before launching instances** |
