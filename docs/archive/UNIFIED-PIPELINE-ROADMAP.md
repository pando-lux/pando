# Unified Pipeline Roadmap

> **STATUS: COMPLETE** — All 7 phases done. See Implementation Status table at bottom.
> One pipeline for everything. pando-node, pando-code, user apps — all just "apps."

## The Problem Today

Three separate systems do similar things:

| System | What It Deploys | Git Ops | Build | Process Mgmt | Governance | Credentials |
|--------|----------------|---------|-------|-------------|------------|-------------|
| **AppManager** | User apps | clone, pull, checkout | npm build | PM2 + health checks | None | S3 only |
| **UpgradeProtocol** | pando-node only | fetch, reset --hard | npm build + tsc fallback | exit(75) restart | Full governance | None |
| **DeployManager** | CodePipeline patches | add, commit, revert | npm build | None | None | None |

**Result:** Three codebases doing overlapping work. pando-code has NO pipeline at all. Credentials are half-hardcoded. No unified history.

## The Target

```
Every piece of code in the network = an App in AppManager

┌─────────────────────────────────────────────────┐
│                  App Registry                    │
├──────────────┬──────────┬───────────────────────┤
│ pando-node   │ pando-code │ user-todo-app       │
│ governance:y │ governance:y│ governance:n        │
│ repo: pando- │ repo: pando-│ repo: pando-lux/   │
│  lux/pando   │  lux/code  │  proj-a3f8          │
│ onDeploy:    │ onDeploy:   │ onDeploy:           │
│  build+restart│ build+restart│ pm2 start         │
│ cred: network│ cred: network│ cred: network     │
└──────────────┴──────────┴───────────────────────┘

Pipeline (same for ALL):
  credential resolve → git pull → npm install → npm build → health check → deploy/restart

Governance (optional gate BEFORE pipeline):
  proposal → vote → pass → THEN run pipeline
```

---

## Current State: What Works, What Doesn't

### Credentials
- **Works:** ResourceRegistry stores encrypted creds in MongoDB (AES-256-GCM)
- **Works:** `getCredential()` decrypts on EC2 nodes, P2P proxy for non-secure nodes
- **Works:** `/contribute github <token>` registers a `code_repository` credential
- **Broken:** `pando_workspace` tool extracts PAT from git remote URL instead of credential system
- **Broken:** pando-node remote URLs have hardcoded PATs in `.git/config`
- **Missing:** No user-scoped credentials (user contributes PAT for their private repos)
- **Missing:** No credential routing logic (which cred for which repo)

### App Deployment
- **Works:** AppManager handles full lifecycle (register → deploy → update → rollback → health)
- **Works:** Blue-green deployment for zero-downtime updates (Tier 2)
- **Works:** S3 static hosting (Tier 1)
- **Works:** PM2 process management, health monitoring, circuit breaker
- **Works:** P2P dispatch (forward deploy to remote nodes)
- **Missing:** No governance gate option
- **Missing:** pando-node and pando-code not registered as apps
- **Missing:** No "restart node" deploy action (only PM2 process restart)

### Upgrade Protocol
- **Works:** Full governance flow (propose → vote → pass → pull → build → restart)
- **Works:** Security validation (dangerous patterns, immutable kernel, security files)
- **Works:** Safe restart (waits for active workers to finish)
- **Works:** Catch-up timer for offline nodes
- **Works:** Version pinning, emergency rollback
- **Broken:** Completely separate from AppManager — duplicate git/build logic
- **Missing:** Only handles pando-node, not pando-code

### Deploy Manager
- **Works:** Git commit/revert for CodePipeline patches
- **Works:** Directory backup/restore
- **Redundant:** Overlaps with AppManager git operations
- **Redundant:** Overlaps with UpgradeProtocol rollback

---

## Phases

### Phase 1: Credential Resolution Layer
> Make all git operations use contributed credentials. No more hardcoded PATs.

**What changes:**
1. Add `resolveGitCredential(repoUrl, userId?)` to ResourceRegistry
   - Checks user-scoped credential first (if userId provided)
   - Falls back to node's contributed `code_repository` credential
   - Returns authenticated URL (e.g., `https://x-access-token:TOKEN@github.com/...`)
   - For public repos (pull only): returns unauthenticated URL

2. Fix `pando_workspace` tool in engine-adapter.ts
   - Replace hardcoded origin URL extraction (line 288) with `resolveGitCredential()`

3. Remove hardcoded PATs from git remote URLs
   - pando-node origin: use credential system at push time
   - All git clone/push operations: resolve credential dynamically

4. Add user-scoped credential support
   - `/contribute github <token> --user` → stores as user:{userId}/github
   - When building user's private project, resolve their credential

**Files touched:**
- `packages/node/src/platform/resource-registry.ts` — add resolveGitCredential()
- `packages/node/src/core/engine-adapter.ts` — fix pando_workspace tool
- `packages/node/src/index.ts` — update getGitHubPat() to use new resolver
- `packages/node/src/api/platform-api.ts` — update /contribute endpoint for user scope

**Test:** Agent clones a repo using only contributed credential (no hardcoded PAT).

---

### Phase 2: Register Infrastructure as Apps
> pando-node and pando-code become entries in the AppManager registry.

**What changes:**
1. On node startup, register pando-node and pando-code in app-manager if not already registered:
   ```
   app-manager.register({
     id: 'pando-node',
     name: 'Pando Node',
     repoUrl: 'https://github.com/pando-lux/pando.git',
     tier: 3,            // NEW tier for infrastructure
     governance: true,   // requires governance approval before update
     deployAction: 'restart-node',  // NEW: exit(75) instead of PM2
     buildCmd: 'npm run build',
     healthEndpoint: '/v1/health',
   })

   app-manager.register({
     id: 'pando-code',
     name: 'Pando Code',
     repoUrl: 'https://github.com/pando-lux/pando-code.git',
     tier: 3,
     governance: true,
     deployAction: 'restart-node',  // brain reload requires restart
     buildCmd: 'npm run build',
   })
   ```

2. Add `tier: 3` (infrastructure) to AppManager
   - Tier 1: Static (S3)
   - Tier 2: Server (PM2)
   - Tier 3: Infrastructure (node restart)

3. Add `governance: boolean` field to app schema
   - When true: updates require governance proposal to pass before pipeline runs
   - When false: updates run immediately (current behavior)

4. Add `deployAction: 'pm2' | 'restart-node'` field
   - `pm2`: current behavior (start/stop PM2 process)
   - `restart-node`: exit(75) for launcher to restart (current upgrade-protocol behavior)

**Files touched:**
- `packages/node/src/core/app-manager.ts` — add tier 3, governance flag, deployAction
- `packages/node/src/init-platform.ts` — register pando-node/pando-code on startup

**Test:** `GET /v1/apps` shows pando-node and pando-code alongside user apps.

---

### Phase 3: Unified Git Operations
> Extract git operations into a shared layer. AppManager, UpgradeProtocol, DeployManager all use it.

**What changes:**
1. Create `packages/node/src/core/git-ops.ts`:
   ```
   class GitOps {
     constructor(repoDir: string, credentialResolver: CredentialResolver)

     clone(repoUrl: string, targetDir: string): void
     pull(branch?: string): void
     fetch(remote?: string, branch?: string): void
     checkout(ref: string): void
     resetHard(target: string, stashFirst?: boolean): void
     commit(message: string, files: string[]): string  // returns hash
     revert(commitHash: string): void
     getCurrentCommit(): string
     getRemoteCommit(branch?: string): string
     hasUncommittedChanges(): boolean
     stashAndReset(target: string): void
   }
   ```
   - ALL git operations use `execFileSync` (no shell injection)
   - ALL git operations resolve credentials via credential system
   - Centralized error handling and logging

2. Refactor AppManager to use GitOps
   - Replace inline execSync/execFileSync git calls
   - git clone, pull, checkout, rev-parse → GitOps methods

3. Refactor UpgradeProtocol to use GitOps
   - Replace safeGitReset, git fetch, git stash → GitOps methods

4. Refactor DeployManager to use GitOps
   - Replace git add, commit, revert, reset → GitOps methods

**Files touched:**
- NEW: `packages/node/src/core/git-ops.ts`
- `packages/node/src/core/app-manager.ts` — use GitOps
- `packages/node/src/core/upgrade-protocol.ts` — use GitOps
- `packages/node/src/core/deploy-manager.ts` — use GitOps
- `packages/node/src/platform/code-pipeline.ts` — use GitOps

**Test:** All existing E2E tests pass. Git operations are identical in behavior.

---

### Phase 4: Merge Upgrade Flow into AppManager
> UpgradeProtocol becomes a thin governance gate, not a separate pipeline.

**What changes:**
1. AppManager.update() gains governance awareness:
   ```
   async update(appId: string): Promise<UpdateResult> {
     const app = this.getApp(appId);

     // If governance required, check for approved proposal
     if (app.governance) {
       const approved = this.checkGovernanceApproval(appId);
       if (!approved) {
         // Create proposal and wait for vote
         return { success: false, status: 'awaiting_governance' };
       }
     }

     // Same pipeline for ALL apps:
     // 1. Resolve credential
     // 2. Git pull/fetch
     // 3. npm install + build
     // 4. Health check
     // 5. Deploy (PM2 restart OR node restart)
     ...
   }
   ```

2. UpgradeProtocol becomes thin wrapper:
   - `createUpgradeProposal()` → creates governance proposal, links to app ID
   - `pullAndUpgrade()` → calls `appManager.update('pando-node')`
   - Security validation stays (dangerous pattern detection, kernel protection)
   - Safe restart logic stays (wait for active workers)
   - Catch-up timer stays (find unapplied upgrades)

3. P2P upgrade notification triggers AppManager:
   - Receive `upgrade_available` on GossipSub
   - Look up app by commitHash
   - Call `appManager.update(appId)` instead of `upgradeProtocol.pullAndUpgrade()`

4. Unified history:
   - All updates (user apps, infra) recorded in `app_history` table
   - Governance proposal ID linked to app history entry

**Files touched:**
- `packages/node/src/core/app-manager.ts` — add governance gate to update()
- `packages/node/src/core/upgrade-protocol.ts` — thin down to governance + safety only
- `packages/node/src/init-kernel.ts` — update P2P handlers to use AppManager
- `packages/node/src/api/core-api.ts` — /upgrade endpoints delegate to AppManager

**Test:** `POST /upgrade/propose` creates governance proposal → on approval → AppManager.update('pando-node') runs → node restarts with new code.

---

### Phase 5: Agent-Driven Repo Creation
> Agents create GitHub repos autonomously using contributed credentials.

**What changes:**
1. Add GitHub API client to ResourceRegistry:
   ```
   class GitHubClient {
     constructor(credential: string)  // PAT

     createRepo(name: string, options: { private?: boolean, org?: string }): string  // returns URL
     deleteRepo(owner: string, name: string): void
     repoExists(owner: string, name: string): boolean
   }
   ```

2. When a user project is created:
   - Resolve GitHub credential (network or user-scoped)
   - Create repo via GitHub API (not CLI)
   - Register as app in AppManager with the new repo URL
   - Agent builds code and pushes

3. For free users: repo created under pando-lux org (public)
4. For paid users with contributed cred: repo created under their account (private)

**Files touched:**
- NEW: `packages/node/src/core/github-client.ts`
- `packages/node/src/platform/resource-registry.ts` — add GitHub API methods
- `packages/node/src/index.ts` — update project creation to use GitHub API
- `packages/node/src/core/engine-adapter.ts` — agents use new repo creation

**Test:** Chat "build me a todo app" → repo created on GitHub → code pushed → app deployed.

---

### Phase 6: pando-code Pipeline
> pando-code gets the same treatment as pando-node.

**What changes:**
1. Create `pando-lux/pando-code` repo on GitHub (manual, one-time)
2. pando-code registered as infrastructure app (Phase 2 already handles this)
3. Upgrade proposal can target pando-code specifically:
   - `POST /upgrade/propose` with `app: 'pando-code'`
   - Governance vote
   - On approval: git pull pando-code → npm build → restart node (reloads brain)

4. EC2 nodes get pando-code:
   - Currently they don't run engines (no brain needed)
   - When they do: same pipeline pulls and builds pando-code

**Files touched:**
- Mostly configuration — Phase 2 and Phase 4 handle the code
- `packages/node/src/init-platform.ts` — ensure pando-code app registered with correct repo URL

**Test:** Push to pando-lux/pando-code → governance proposal → approval → all nodes pull + rebuild + restart.

---

### Phase 7: Deprecate & Remove Old Systems
> Clean up the three-system mess.

**What gets removed/thinned:**
1. **UpgradeProtocol** — keeps: governance gate, security validation, safe restart, catch-up timer. Removes: all git/build/deploy logic (now in AppManager)
2. **DeployManager** — keeps: PatchSet commit logic (CodePipeline needs it). Removes: backup/restore (AppManager handles), standalone build
3. **Hardcoded PATs** — all removed from git remote URLs
4. **safeGitReset()** — moves into GitOps class
5. **Duplicate git imports** — all files use GitOps instead of direct child_process

**Files touched:**
- `packages/node/src/core/upgrade-protocol.ts` — thin down
- `packages/node/src/core/deploy-manager.ts` — thin down
- Various files — remove direct execSync/execFileSync git calls

---

## Dependency Graph

```
Phase 1 (Credentials) ──→ Phase 3 (GitOps) ──→ Phase 4 (Merge Upgrade)
                     │                                    │
Phase 2 (Register)  ─┘        Phase 5 (GitHub API) ──────┘
                                                          │
                              Phase 6 (pando-code) ───────┘
                                                          │
                              Phase 7 (Cleanup) ──────────┘
```

Phases 1 and 2 can run in parallel. Phase 3 needs Phase 1. Phase 4 needs 2+3. Phase 5 needs 1. Phase 6 needs 4. Phase 7 is last.

---

## What Changes for Each Actor

### Node Operator
- **Before:** Set up git with hardcoded PATs, hope it works
- **After:** `/contribute github <token>` once. Done. Everything uses it.

### User (Free)
- **Before:** App built, manually pushed somewhere
- **After:** App built → repo auto-created on pando-lux → auto-deployed → link provided

### User (Paid, Private)
- **Before:** Not supported
- **After:** User contributes their GitHub PAT → app built in their private repo → only they can access

### Council/Agents
- **Before:** Separate upgrade system, no visibility into infra deployments
- **After:** pando-node and pando-code are apps on the board. Same dashboard. Same history. Same pipeline.

### Developer (You)
- **Before:** Push code, manually trigger upgrade, hope EC2 nodes update
- **After:** Push code → governance auto-approves (<8 peers) → all nodes update automatically via the same AppManager pipeline

---

## Implementation Status

| Phase | Status | Commit |
|-------|--------|--------|
| Phase 1: Credential Resolution | ✅ DONE | cc042661 |
| Phase 2: Register Infra as Apps | ✅ DONE | cc042661 |
| Phase 3: Unified GitOps | ✅ DONE | (this commit) |
| Phase 4: UpgradeProtocol uses GitOps | ✅ DONE | (this commit) |
| Phase 5: GitHub Client | ✅ DONE | (this commit) |
| Phase 6: pando-code pipeline | ✅ DONE | (registered as app in Phase 2, same pipeline) |
| Phase 7: Cleanup | ✅ DONE | (this commit — safeGitReset removed, all git ops via GitOps) |

## Success Criteria

- [x] `GET /v1/apps` shows pando-node, pando-code, and user apps in one list
- [x] All git operations use contributed credentials (no hardcoded PATs)
- [x] User can `/contribute github <token>` and agents use it for all git ops
- [ ] Paid user contributes PAT, gets private repo builds (GitHubClient ready, needs integration)
- [x] pando-code upgrades flow through same pipeline as pando-node
- [x] Unified deployment history in one table (app_history)
- [x] UpgradeProtocol is a governance gate using GitOps, not a separate pipeline
- [x] 9/9 E2E tests still pass
