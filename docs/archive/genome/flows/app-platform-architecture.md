# App Platform Architecture — Phase 70

> The complete design for how Pando hosts, deploys, and serves user-built applications.
> Addresses all 18 gaps from E2E testing (see `genome/state-e2e-gaps.md`).
> **Agreed 2026-02-24** — Final architecture after founder review.

## Trust Model

**Nodes are untrusted. EC2 instances are hardened. Only governance can be trusted.**

The network will have many nodes — some on AWS, some on laptops, some on phones. No one can be trusted, not even the founder. It's an AI-run network. Governance (voting, consensus) is the only authority.

```
┌──────────────────────────────────┐     ┌──────────────────────────────────┐
│      USER NODES (untrusted)      │     │   EC2 INSTANCES (hardened)       │
│                                  │     │                                  │
│  - Laptops, phones, servers      │     │  - No SSH, no human access       │
│  - Run Claude Code agents        │     │  - Tripwire-protected            │
│  - Have operators (humans)       │     │  - Hold S3/MongoDB credentials   │
│  - ONLY have GitHub token        │     │  - Handle ALL deployments        │
│    (fine-grained, reversible)    │     │  - Run Resource Proxy            │
│                                  │     │  - Multiple for redundancy       │
│  CAN: Push code to GitHub        │     │                                  │
│  CAN: Send deploy commands P2P   │     │  CAN: Clone from GitHub          │
│  CAN: Coordinate agent work      │     │  CAN: Upload to S3               │
│                                  │     │  CAN: Run compute apps           │
│  CANNOT: Touch S3                │     │  CAN: Proxy MongoDB/API access   │
│  CANNOT: Touch MongoDB creds     │     │                                  │
│  CANNOT: Touch AWS infra         │     │  CANNOT: Run agents              │
│  CANNOT: Launch EC2              │     │  CANNOT: Access GitHub token      │
└──────────────────────────────────┘     └──────────────────────────────────┘
```

**Future governance will**: decide how many EC2 instances to run, replicate data across instances, rotate credentials, launch/terminate instances based on demand.

## Design Principles

1. **GitHub is the source of truth for code** — every project gets a repo. Teams push updates. Managers commit changes. Git provides history, branches, PRs, rollback.
2. **Apps are public by default** — all repos are public unless user explicitly requests private. Pando philosophy: transparency.
3. **The network knows everything** — project state (where hosted, what port, health, URL) lives in the P2P ProjectRegistry. Gateway reads from ProjectRegistry. Any node can answer "where is this app?"
4. **Agents never see raw credentials** — agents call node API endpoints. The node pushes to GitHub. EC2 instances handle S3/MongoDB. No credential leakage.
5. **Two deployment tiers** — Tier 1 (static, S3) and Tier 2 (compute, EC2). Tier decided at project creation, stored in project record.
6. **EC2 instances are the credential proxy** — ALL deploy operations (S3 upload, app hosting) go through EC2. Nodes never touch S3/AWS/MongoDB credentials directly.
7. **GitHub token is fine-grained** — can push code (reversible) but CANNOT delete repos, change org settings, or force-push to protected branches. Even if leaked, damage is limited and reversible.
8. **Minimum 2 EC2 instances** — for redundancy. If one dies, deploys route to the other. Governance decides scaling.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         USER FLOW                                     │
│                                                                       │
│  User → Chat → Doorman → Project Created (tier stored)               │
│    → Manager spawned → Builder spawned → Code written                │
│    → Code committed to GitHub (via node API, not agent's CLI)        │
│    → Deploy triggered (Tier 1: S3, Tier 2: EC2 via P2P)             │
│    → ProjectRegistry updated with live URL                           │
│    → User gets working URL → app visible in gateway marketplace      │
└──────────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
                    GitHub (code)
                    ┌──────────┐
                    │ pando-lux│
                    │ /app-*   │◄─── Node pushes via GitHub API
                    └────┬─────┘     (using contributed code_repository resource)
                         │
              ┌──────────┼──────────┐
              │          │          │
         Tier 1 read  Tier 2 pull  Gateway link
              │          │          │
              ▼          ▼          ▼
         ┌────────┐ ┌────────┐ ┌──────────┐
         │  S3    │ │  EC2   │ │ Gateway  │
         │(static)│ │(compute│ │(shows    │
         │        │ │ apps)  │ │ projects)│
         └────────┘ └────────┘ └──────────┘
              │          │          │
              └──────────┼──────────┘
                         │
                    ProjectRegistry
                    (P2P synced — every node
                     knows every app's state)
```

---

## 1. Project Creation & Tier Classification

### What Changes
- Doorman's classification result includes `tier: 1 | 2`
- Tier is stored in the Project record at creation time (new field)
- Preflight auto-assigns ALL needed resources: `storage_db` + `storage_blob` + `code_repository`
- No more manual resource discovery by managers

### Project Schema Addition
```typescript
interface Project {
  // ... existing fields ...
  tier?: 1 | 2;                    // deployment tier (1=S3 static, 2=EC2 compute)
  deploymentPort?: number;          // for Tier 2 — actual port the app runs on
  deployPeerId?: string;            // Phase 87: peerId of compute node hosting this app
  instanceId?: string;              // legacy (pre-Phase 87), use deployPeerId
  githubRepo?: string;              // full repo name e.g. "pando-lux/app-guestbook-abc123"
}
```

### Doorman Classification
The doorman already classifies intent. Add tier to the classification prompt:
```
Tier 1 (static): HTML/CSS/JS only. No server, no WebSocket, no database backend process.
Tier 2 (compute): Needs a running server process — Express, WebSocket, real-time, backend API, etc.
```

Store the result: `project.tier = classificationResult.tier`

---

## 2. GitHub — The Code Store

### How It Works
Every project gets a GitHub repo. The NODE creates and manages repos — agents never touch GitHub credentials.

### New Node API Endpoint: `POST /projects/:id/github`
```
Input: { projectId }
Flow:
  1. Read contributed code_repository resource from ResourceRegistry
  2. Decrypt the GitHub token (using CREDENTIAL_MASTER_KEY)
  3. Create repo via GitHub API: POST /orgs/pando-lux/repos
     - Name: app-<project-name-slug>-<projectId-short>
     - Visibility: public (default) or private (if project.visibility === 'private')
     - Description: auto-generated from project description
  4. Initialize with README
  5. Store repo URL in project record: project.githubRepo = "pando-lux/app-..."
  6. Return { repoUrl, cloneUrl }
```

### How Agents Push Code
Agents do NOT use `gh` CLI or any local GitHub auth. Instead:

**New Node API Endpoint: `POST /projects/:id/github/push`**
```
Input: { projectId, workspaceDir }
Flow:
  1. Read project record → get githubRepo
  2. Read contributed code_repository resource → decrypt GitHub token
  3. Copy files from workspace to temp dir
  4. git init → git add → git commit → git push
     (using token-authenticated HTTPS remote: https://<token>@github.com/<repo>.git)
  5. All git operations happen in node process, NOT agent process
  6. Return { pushed: true, commitSha, repoUrl }
```

The manager/builder template says:
```
To push code to GitHub:
  POST /projects/<projectId>/github/push  { workspaceDir: "/path/to/workspace" }
Do NOT use gh CLI. Do NOT use git push directly. The node handles GitHub credentials.
```

### Update Flow (Existing Apps)
When an existing app needs changes:
1. Manager spawns builder for the update task
2. Builder reads current code: `POST /projects/:id/github/pull` → node clones to workspace
3. Builder modifies code
4. Builder commits: `POST /projects/:id/github/push` → node pushes
5. Manager triggers redeploy: `POST /projects/:id/deploy`

### Benefits
- Teams of agents can push/pull from the same repo via node API
- Full git history for every project
- Agents NEVER see the GitHub token
- `gh` CLI on the host machine is never used (no personal account pollution)
- Visibility (public/private) matches project settings
- Future: webhook-triggered deploys, GitHub Actions, branch protection

---

## 3. Deployment — Both Tiers Go Through EC2

**Critical design decision:** Nodes NEVER upload to S3 directly. ALL deploy operations go through EC2 instances via P2P. This keeps S3/AWS credentials off user nodes.

### Tier 1 Flow (S3 Static)
```
Builder finishes → Manager calls POST /projects/:id/deploy
  → Node pushes code to GitHub (via /projects/:id/github/push)
  → Node sends P2P deploy to EC2: pando/deploy-app
    Payload: { projectId, repoUrl, tier: 1, envVars }
  → EC2 clones from GitHub (public repo, no auth needed)
  → EC2 uploads static files to S3: s3://pando-deployments/public/<projectId>/
  → EC2 injects gateway vars into HTML files
  → EC2 returns { status: "deployed", url: "<S3 website URL>" }
  → Node updates ProjectRegistry with live URL
  → Manager reports URL to user
```

### Tier 2 Flow (EC2 Compute)
```
Builder finishes → Manager calls POST /projects/:id/deploy
  → Node pushes code to GitHub (via /projects/:id/github/push)
  → Node sends P2P deploy to EC2: pando/deploy-app
    Payload: { projectId, repoUrl, tier: 2, envVars }
  → EC2 clones from GitHub (public repo, no auth needed)
  → EC2 runs npm install → npm start on assigned port
  → EC2 returns { status: "deployed", port: 3002 }
  → Node constructs URL: http://<publicIp>:<port>/
  → Node updates ProjectRegistry with live URL + port + instanceId
  → Manager reports URL to user
```

### URL Construction
- **Tier 1**: S3 website endpoint — `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/<projectId>/index.html`
- **Tier 2**: EC2 public IP + actual port — `http://<publicIp>:<port>/`
- **Future**: Custom domains via nameserver — `https://<projectId>.apps.pando.network/`
- Gateway `/projects` page links to the actual live URL (no proxying, just display)

### Redeploy (Bug Fix Flow)
```
User: "the submit button doesn't work"
  → Manager spawns builder → builder pulls code → fixes bug → pushes code
  → Manager calls POST /projects/:id/deploy (same endpoint)
  → Node pushes to GitHub (git commit + push)
  → P2P deploy to EC2:
    Tier 1: EC2 reclones → re-uploads to S3 (overwrite)
    Tier 2: EC2 does git pull → npm install → restart on same port
  → URL stays the same — user just refreshes
```

### Compute Peer Selection (Phase 87)
```
Node → CapabilityRegistry.getAllProfiles()
  → Filter: storageBackend === 'mongodb' && peerId !== localPeerId
  → Try up to 3 peers via requestReply.request(peerId, 'pando/deploy-app', ...)
  → On success: use profile.publicAddress for Tier 2 URL construction
  → Store deployPeerId on project record
  → If ALL peers fail, return error
```

### Private Repos (Future)
For private projects, EC2 needs credentials to clone:
1. Node generates a short-lived GitHub deploy key (read-only, repo-scoped)
2. Deploy key sent in P2P deploy payload (encrypted)
3. EC2 uses deploy key for `git clone`
4. Key auto-expires after 1 hour

For now: all apps are public by default. Private deploy keys come later.

---

## 5. ProjectRegistry — The Network's App Directory

### What's Added
ProjectRegistry already syncs via GossipSub (`pando/projects`). Extend the synced record:

```typescript
interface ProjectRegistryRecord {
  // ... existing fields ...
  tier: 1 | 2;
  liveUrl: string;              // The actual working URL (S3 endpoint or http://ip:port/)
  githubRepo: string;           // e.g. "pando-lux/app-guestbook-abc123"
  instanceId?: string;          // For Tier 2: which EC2 instance
  deploymentPort?: number;      // For Tier 2: which port
  lastDeployedAt: number;       // When last deployed
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
}
```

### Gateway Integration
Gateway reads from the local node's ProjectRegistry:
```
GET /projects → returns all projects with liveUrl, tier, healthStatus
```

Gateway `/projects` page shows:
- App name, description, tier badge (Static / Compute)
- Live URL (clickable link that actually works)
- GitHub repo link
- Health status indicator
- Deploy timestamp

### Health Monitoring (Phase 65c)
Periodic health check for deployed apps:
- Tier 1: HTTP HEAD to S3 URL, expect 200
- Tier 2: HTTP GET to `http://<ip>:<port>/health` (or just `/`), expect 200
- Update `healthStatus` in ProjectRegistry
- Alert if unhealthy for >5 minutes

---

## 6. Unified Deploy Endpoint

### `POST /projects/:id/deploy`
One endpoint. Node handles everything. Manager makes one call.

```
Input: { projectId, workspaceDir? }
Flow:
  1. Read project record → get tier, visibility, githubRepo
  2. If workspaceDir provided: push to GitHub via /projects/:id/github/push
  3. Discover compute peers via CapabilityRegistry (filter: storageBackend=mongodb)
  4. Try up to 3 peers via P2P: requestReply.request(peerId, 'pando/deploy-app', ...)
  5. Compute node handles the rest (S3 upload for Tier 1, app hosting for Tier 2)
  6. Parse response → construct URL (using profile.publicAddress for Tier 2)
  7. Update project record: deploymentUrl, deploymentStatus, deploymentPort, deployPeerId
  8. Sync to ProjectRegistry (GossipSub broadcast)
  9. Return { url, tier, status, deployPeerId }
```

### Template Instructions (What Managers Are Told)
```markdown
## Deploying Your App

After builder completes code, deploy with ONE call:

    POST /projects/<projectId>/deploy
    Body: { "workspaceDir": "<builder's workspace path>" }

The node handles EVERYTHING:
- Pushes code to GitHub (you don't need to)
- Auto-discovers compute peers via P2P CapabilityProfile
- Compute node deploys to the right infrastructure (S3 for Tier 1, runs app for Tier 2)
- Returns the live URL

You NEVER need to:
- Call GitHub APIs directly
- Use `gh` CLI
- Figure out which compute node to use (P2P discovery handles it)
- Upload to S3
- Know about AWS or infrastructure details

Just call /projects/:id/deploy and report the URL to the user.
```

---

## 7. Security Model

### Three-Layer Credential Isolation
```
┌─────────────────────────────────┐
│     Layer 1: Agent Process      │
│  (Claude Code child process)    │
│                                 │
│  HAS:  Workspace, Bash, HTTP    │
│  HAS:  GitHub token (via node)  │
│                                 │
│  CANNOT: See CREDENTIAL_MASTER_KEY │
│  CANNOT: Access S3/MongoDB/AWS  │
│  CANNOT: Access other workspaces│
│  CANNOT: Launch infrastructure  │
└──────────┬──────────────────────┘
           │ HTTP API calls only
           ▼
┌─────────────────────────────────┐
│     Layer 2: Node Process       │
│  (untrusted — has operator)     │
│                                 │
│  HAS:  GitHub token (fine-      │
│        grained, reversible)     │
│  HAS:  CREDENTIAL_MASTER_KEY    │
│        (decrypts GitHub only)   │
│                                 │
│  DOES: Push/pull GitHub repos   │
│  DOES: Send P2P deploy commands │
│  DOES: Coordinate agents        │
│                                 │
│  CANNOT: Access S3 directly     │
│  CANNOT: Access MongoDB directly│
│  CANNOT: Access AWS infra       │
└──────────┬──────────────────────┘
           │ P2P messages only
           ▼
┌─────────────────────────────────┐
│   Layer 3: EC2 Instance         │
│  (hardened — no human access)   │
│                                 │
│  HAS:  S3 credentials           │
│  HAS:  MongoDB credentials      │
│  HAS:  Resource Proxy           │
│                                 │
│  DOES: Upload to S3 (Tier 1)   │
│  DOES: Host apps (Tier 2)      │
│  DOES: Proxy DB access          │
│  DOES: Clone public GitHub repos│
│                                 │
│  CANNOT: Push to GitHub         │
│  CANNOT: Run agents             │
│  CANNOT: Be accessed by humans  │
└─────────────────────────────────┘
```

### GitHub Token Security
The contributed `code_repository` resource uses a **fine-grained GitHub PAT**:
- ✅ Contents: Read/Write (push/pull code)
- ✅ Metadata: Read (see repo info)
- ❌ Administration: NONE (cannot delete repos)
- ❌ Organization: NONE (cannot change org)
- Plus: branch protection on main (no force-push, no delete)

Even if a malicious node operator extracts the token, they can only push code (reversible via `git revert`). They cannot delete repos or change org settings. Git's full history makes any damage recoverable.

**Future**: Validate contributed GitHub tokens are fine-grained (reject overpowered tokens).

### Implementation
1. **Strip `CREDENTIAL_MASTER_KEY` from agent env**: When spawning Claude Code child processes, explicitly delete this env var from the child process environment.
2. **Node only decrypts GitHub token**: The node uses CREDENTIAL_MASTER_KEY to decrypt the `code_repository` resource for GitHub operations only. S3/MongoDB credentials stay on EC2 instances.
3. **No raw credential endpoints**: No API endpoint ever returns decrypted credentials. All credential use is internal.
4. **EC2 instances hold infrastructure credentials**: S3, MongoDB, and other sensitive credentials are only decrypted on hardened EC2 instances (no SSH, tripwire-protected).

---

## 8. What This Fixes (Gap Mapping)

| Gap | Fix |
|---|---|
| GAP-1: S3 URL 404 | Return S3 website endpoint directly |
| GAP-2: EC2 URL wrong port | Parse port from deploy response |
| GAP-3: pushToGitHub() 404 | New `/projects/:id/github/push` uses contributed resource token |
| GAP-4: EC2 needs repoUrl | GitHub push always happens first via node API (not agent) |
| GAP-5: GitHub not auto-assigned | Preflight assigns code_repository alongside storage_db |
| GAP-6: Resource assign broken | Preflight handles it; agents don't need to assign manually |
| GAP-7: Wrong GitHub account | Node uses contributed resource, not local gh CLI |
| GAP-8: EC2 can't clone private | Public by default. Future: deploy keys for private. |
| GAP-9: Code forced public | Public is the default and desired behavior |
| GAP-10: project-state.md | Template update: require state updates after each action |
| GAP-11: No tier stored | Tier stored at project creation |
| GAP-12: S3 for Tier 2 | Unified deploy checks tier, skips S3 for Tier 2 |
| GAP-13: Duplicate builder | Template: check /agents/tree before spawning |
| GAP-14: 19 min for simple app | Cascading failures fixed → ~3-5 min target |
| GAP-15: Raw credential access | CREDENTIAL_MASTER_KEY stripped from agent env |
| GAP-16: Shell credential exfil | Agent-scoped tokens + no credential endpoints |
| GAP-17: Missing favicon | Builder template: include default favicon |
| GAP-18: Auth session expiry | Separate fix — auto-refresh in gateway auth |

---

## Implementation Order

### Phase 70a — Schema & Docs
1. Add `tier` field to Project schema in types.ts
2. Add `deploymentPort`, `instanceId`, `githubRepo` to Project
3. Extend ProjectRegistryRecord with `liveUrl`, `tier`, `deploymentPort`
4. Update architecture docs, roadmap, trust model rules

### Phase 70b — GitHub Integration (Node-Side)
5. `POST /projects/:id/github` — create repo using contributed resource
6. `POST /projects/:id/github/push` — push workspace code to GitHub
7. Remove old `pushToGitHub()` from agent-manager.ts

### Phase 70c — Unified Deploy
8. `POST /projects/:id/deploy` — one endpoint, pushes to GitHub + P2P deploy
9. Phase 87: Compute peer selection via CapabilityRegistry (replaces CloudInstanceManager)
10. Parse deploy response for correct URL/port, store deployPeerId

### Phase 70d — EC2 Deploy Handler Extension
11. Extend `pando/deploy-app` handler to support `tier: 1`
12. Tier 1: EC2 clones from GitHub → uploads to S3 (EC2 has S3 creds)
13. Tier 2: existing flow (clone → install → start) with correct port return
14. Inject gateway vars into HTML files (Tier 1)

### Phase 70e — Doorman & Preflight
15. Store tier at doorman classification
16. Auto-assign `code_repository` resource in preflight
17. Skip S3 auto-deploy for Tier 2 in agent-manager.ts

### Phase 70f — Security
18. Strip `CREDENTIAL_MASTER_KEY` from agent child process env
19. Audit API endpoints for credential exposure
20. Node only decrypts GitHub token (S3/MongoDB stay on EC2)

### Phase 70g — Templates & Cleanup
21. Update manager + builder templates with new deploy protocol
22. Remove old getHostedUrl() gateway URL logic
23. Remove direct S3 upload from hosting-service.ts
24. Clean legacy deploy paths, no fallbacks

### Phase 70h — Test & Verify
25. Build (`npm run build`) + fix compilation
26. API-level tests for new endpoints
27. Human-level E2E test (Tier 1 + Tier 2 full lifecycle)
28. Fix issues, re-test until clean

---

## Decisions (Resolved)

1. **GitHub org**: `pando-lux` for now (contributed resource token is for this org). Future: `pando-apps` org.
2. **Repo naming**: `app-<slug>-<shortId>` for human readability.
3. **Port allocation**: Incremental on EC2, stored in ProjectRegistry, survives restarts.
4. **Deploy routing**: ALL deploys go through EC2 via P2P. Nodes never touch S3.
5. **Public by default**: All repos and apps public. Private is opt-in (future).
6. **GitHub token**: Fine-grained PAT. No delete/admin permissions. Damage is reversible via git.
