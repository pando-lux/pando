# E2E Test Gaps — Found 2026-02-23

> Issues discovered during human-level E2E testing (Tier 1 guestbook + Tier 2 WebSocket chat).
> These must be fixed before the next E2E round.
> Document: `genome/state-e2e-gaps.md`

---

## E2E Test Results Summary

### Test 1: Tier 1 — Guestbook App (S3 Deployment) — PASS with bugs

- **What**: User asked "Build me a simple guestbook app with dark theme"
- **Doorman**: Correctly classified as `intent: build`, routed to Full tier
- **Project created**: `235b1b5d1971f501442fc80b` with MongoDB resource auto-assigned
- **Manager**: Built app directly (no separate builder), 18 steps, ~90 seconds
- **App quality**: Excellent — dark theme, purple accent, form validation, avatar initials, relative timestamps
- **S3 deploy**: File uploaded successfully to `public/235b1b5d1971f501442fc80b/index.html`
- **Working URL**: `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/235b1b5d1971f501442fc80b/index.html`
- **Broken URL (reported to user)**: `https://gateway-one-mu.vercel.app/apps/235b1b5d1971f501442fc80b/index.html` → 404
- **MongoDB persistence**: WORKS — submitted guestbook entry, reloaded page, entry still there
- **GitHub push**: Failed silently (org 404), `repoUrl` empty in project record

### Test 2: Tier 2 — WebSocket Chat App (EC2 Deployment) — PARTIAL PASS

- **What**: User asked "Build me a real-time chat room app using WebSockets with Express and Socket.io"
- **Doorman**: Correctly classified as `intent: build`, routed to Full tier
- **Project created**: `a51d261f618c1136bd583870` with MongoDB resource auto-assigned
- **Manager**: Correctly identified Tier 2 ("real-time WebSockets require a persistent server"), found running EC2 instance `i-0bcb0d84eeccef128`
- **Builder spawned**: `builder-2d694aeb` — created server.js, package.json, public/{index.html, style.css, client.js}
- **Builder quality**: Excellent — Express + Socket.io, username validation, sanitization, join/leave notifications, dark theme
- **S3 deploy**: Auto-ran (shouldn't have for Tier 2) — deployed all 5 files including server.js to S3 (useless)
- **GitHub push via `pushToGitHub()`**: Failed (org 404) — same as Test 1
- **Manager workaround**: Used `gh` CLI to create PUBLIC repo at `jairangwani/app-a51d261f618c1136bd583870-chat-room`
- **EC2 deploy**: Succeeded via P2P — app running on `http://100.53.198.66:3002/`
- **Broken URL (reported to user)**: `http://100.53.198.66/apps/a51d261f618c1136bd583870/index.html` → wrong port + wrong path
- **App works**: WebSocket chat loads, username picker shows, dark theme renders
- **Duration**: ~19 minutes (should be ~3 min — most time wasted on GitHub/deploy workarounds)
- **Duplicate builder**: Manager spawned second builder `builder-e5ddd251` unnecessarily

---

## Critical — Blocking Deployment

### GAP-1: Deployment URL points to non-existent gateway route (Tier 1)
- **Where**: `packages/node/src/hosting-service.ts:107-110` (`getHostedUrl`)
- **What**: For public S3 deployments, `getHostedUrl()` returns `${gatewayUrl}/apps/${projectId}/${entryFile}` — but the gateway (Next.js on Vercel) has NO `/apps/` route. The URL 404s.
- **Actual working URL**: `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/${projectId}/index.html`
- **Impact**: Users get a dead link. Manager reports "deployed" but user can't access the app.
- **Fix options**:
  - A) Add `/apps/[projectId]/[...path]` route to gateway that proxies S3 — nice URLs but adds latency
  - B) Return the S3 website endpoint URL directly — works immediately, no gateway dependency
  - C) Both — gateway route for nice URLs, S3 direct as fallback
- **Recommended**: Option B now (immediate fix), Option A later for nice URLs

### GAP-2: EC2 deployment URL is wrong (Tier 2) — **FIXED (Phase 87)**
- **Status**: RESOLVED. Phase 87 rewrote deploy endpoint to use P2P CapabilityProfile discovery. Tier 2 URL is now constructed from `profile.publicAddress` + nginx reverse proxy path (`/apps/<id>/`). No more CloudInstanceManager URL construction.

### GAP-3: GitHub `pushToGitHub()` fails — org repo creation returns 404
- **Where**: `packages/node/src/agent-manager.ts:1697` (`pushToGitHub`)
- **What**: The code tries to create a repo via GitHub API and gets `404: Not Found`. The contributed GitHub resource (`dd505b46`, resource ID `b417bcb2-98dd-44f8-8711-5738406226f0`) has a token for `pando-lux` org, but the function may be using the wrong org name or the token lacks `repo:create` scope on that org.
- **Log evidence**: `[agent-manager] GitHub repo create returned 404: {"message":"Not Found","documentation_url":"https://docs.github.com/rest/repos/repos#create-an-organization-repository","status":"404"}`
- **Impact**: No code pushed to GitHub → EC2 deploy blocked (requires repoUrl) → GitHub push for Tier 1 also fails silently (repoUrl stays empty)
- **Fix**: Debug `pushToGitHub()` — check what org/user it's using, verify token scopes. Must read the contributed `code_repository` resource from ResourceRegistry and use THAT token, not any local config.

### GAP-4: Deploy requires GitHub repoUrl — no alternative code delivery path
- **Where**: `packages/node/src/api-server.ts` (deploy endpoint), `pando/deploy-app` handler in index.ts
- **What**: `POST /projects/:id/deploy` sends repoUrl to compute peer. Compute node does `git clone <repoUrl>`. If GitHub push fails, deploy is blocked.
- **Impact**: If GitHub push fails (GAP-3), deploy is completely blocked. No fallback.
- **Fix**: Future — use S3 as code delivery mechanism instead of GitHub.

### GAP-5: GitHub resource not automatically assigned to projects
- **Where**: `packages/node/src/api-server.ts` (doorman preflight, `runPreflight()`)
- **What**: Preflight auto-assigns `storage_db` (MongoDB) resource to projects but NOT `code_repository` (GitHub). Manager must manually discover and assign GitHub resource.
- **Impact**: Manager spends many turns trying to figure out how to push code. Wasted ~5 minutes of API budget on resource discovery alone.
- **Fix**: Add `code_repository` to preflight auto-assign list alongside `storage_db`

### GAP-6: Resource assignment endpoint broken or undiscoverable
- **Where**: `POST /projects/:id/resources/assign`
- **What**: Manager tried multiple payload formats (`{"type":"github","resourceId":"..."}`, `{"resourceType":"code_repository","resourceId":"..."}`) — all returned errors. Endpoint seems broken or has undocumented schema.
- **Impact**: Even if manager knows the resource ID, it can't assign it programmatically.
- **Fix**: Fix the endpoint schema, add clear error messages, document in API reference

---

## High — Degraded Experience

### GAP-7: Manager pushed code to wrong GitHub account
- **Where**: Manager's `gh` CLI workaround
- **What**: After `pushToGitHub()` failed (GAP-3), manager used local `gh` CLI which is authenticated as `jairangwani` (Jai's personal account). Created repo at `jairangwani/app-a51d261f618c1136bd583870-chat-room` instead of using the contributed `pando-lux` org resource.
- **Impact**: Code ends up in founder's personal GitHub. Personal account polluted. Contributed resource unused.
- **Fix**: Part of GAP-3 fix — once `pushToGitHub()` uses the contributed resource correctly, agents won't fall back to local CLI auth.

### GAP-8: EC2 can only clone PUBLIC repos — private repos fail
- **Where**: EC2 P2P deploy handler (`cloud-instance-manager.ts`, deploy handler on EC2 side)
- **What**: When EC2 receives a deploy command, it does `git clone <repoUrl>`. The EC2 instance has NO GitHub credentials. It can only clone public repos.
- **Proof**: Earlier deploy of `pando-lux/app-pong-game` (private) failed: `"fatal: could not read Username for 'https://github.com': No such device or address"`. The chat room only worked because manager created it as `--public`.
- **Jai's question**: "wont the node on ec2 fail to pull since its github would be using another resource?"
- **Answer**: YES — the EC2 node has a completely different identity with no GitHub token. It can't access private repos. The manager solved this by making the repo public, which is a security problem for user code.
- **Impact**: Either user code is forced public (privacy violation) or EC2 deploy fails.
- **Fix**: See "Proposed Architecture" — S3 tarball delivery eliminates this problem entirely.

### GAP-9: User project code exposed as PUBLIC GitHub repo by default
- **Where**: Manager's `gh` CLI workaround used `--public` flag
- **What**: The manager created a PUBLIC GitHub repo for the user's chat app. Anyone can see the source code. The manager chose `--public` because EC2 can't clone private repos (GAP-8).
- **Impact**: User code privacy violated. If someone builds a proprietary app, source code is publicly visible.
- **Fix**: Never default to public repos. Use S3 delivery path (no GitHub needed for deploy), and if GitHub is used for persistence, respect project visibility settings.

### GAP-10: Manager doesn't update project-state.md
- **Where**: Manager agent behavior (template compliance)
- **What**: `project-state.md` stayed at "Phase: Initial" with "No decisions recorded yet" even after builder completed, deploy happened, and manager wrapped up.
- **Impact**: No persistent memory. If manager is resumed, it has no project context. Worker registry shows "active" for agents that are done.
- **Fix**: Strengthen template enforcement — require project-state.md update after each major action (builder spawn, build complete, deploy, GitHub push).

### GAP-11: Tier classification not stored in project record
- **Where**: Doorman classify (`api-server.ts:6354`) → project creation
- **What**: Doorman detects "websocket" keywords and classifies as Tier 2, but the tier is NOT saved to the project record schema. Manager has to re-infer from the original user message text.
- **Impact**: Manager may misclassify. No audit trail. Added latency as manager re-analyzes.
- **Fix**: Add `tier: 1|2` field to project schema in `types.ts`, store at creation time in doorman.

---

## Medium — Quality / Efficiency Issues

### GAP-12: S3 deploy auto-runs for Tier 2 server apps
- **Where**: `packages/node/src/agent-manager.ts` (`deployAgentWorkspace`)
- **What**: The automatic post-build deploy ALWAYS runs S3 static hosting. For the WebSocket chat app, it uploaded server.js, package.json, and public/* to S3 — completely useless. S3 can't run Node.js.
- **Impact**: Wasted S3 upload. Confusing project state: `deploymentStatus: "deployed"` and `deploymentUrl` set to S3 URL, but app doesn't work at that URL. Manager has to then ALSO do EC2 deploy.
- **Fix**: Check project tier before auto-deploying. If Tier 2: skip S3 deploy entirely, OR only deploy `public/` directory (static assets that EC2 app might reference).

### GAP-13: Manager spawned duplicate builder
- **Where**: Manager agent behavior
- **What**: Manager spawned `builder-2d694aeb` (worked correctly), then later spawned `builder-e5ddd251` as a duplicate for the same task. Had to waste time cancelling the duplicate.
- **Impact**: Wasted API budget. ~4 extra minutes.
- **Fix**: Manager template should check `GET /agents/tree` before spawning to see if a builder already exists for the project.

### GAP-14: Manager ran ~19 minutes for a simple project
- **Where**: Manager session duration
- **What**: Total session: 1130 seconds (~19 min). Breakdown:
  - ~60s: Preflight, planning, builder spawn
  - ~270s: Builder working (4.5 min) — reasonable
  - ~900s: Fighting deployment infra (15 min!) — GitHub failures, resource discovery, EC2 deploy failures, retries, workarounds
- **Impact**: Terrible user experience. User waited 19 minutes for a chat app.
- **Root cause**: Cascading failures from GAP-3 through GAP-8. Fixing those reduces total to ~5 minutes.

---

## Security — Must Address Before Multi-Operator

### GAP-15: Agents/managers may access raw AWS/resource credentials
- **Where**: Resource decryption, CredentialStore, agent child processes
- **What**: Agents have Bash access and run as child processes of the node process. They COULD potentially:
  - Read env vars: `env | grep CREDENTIAL_MASTER_KEY`
  - Read `~/.pando/api-token` and call endpoints that return sensitive data
  - Read the node process environment from `/proc/<pid>/environ`
- **Note**: Phase 70 already strips `CREDENTIAL_MASTER_KEY` + `PANDO_STORAGE_URL` from agent child env. Phase 87 removed CloudInstanceManager from deploy flow — agents call `POST /projects/:id/deploy` which routes via P2P, no raw AWS creds involved.
- **Current flow**: Manager → `POST /projects/:id/deploy` → Node discovers compute peer via P2P → requestReply to peer → peer handles deploy. Agent never sees raw keys.
- **Impact**: CRITICAL for multi-operator networks. If Node A contributes AWS creds, Node B's agents MUST NOT see them.
- **Fix (phased)**:
  - Phase 1 (now): Audit all API endpoints — ensure none return raw credentials. Ensure `CREDENTIAL_MASTER_KEY` is not inherited by child processes (agent spawns).
  - Phase 2 (64b): Split-key encryption — K_node on instance, K_gateway in MongoDB. Even disk snapshot can't recover.
  - Phase 3 (future): Hardware enclaves (Nitro/SGX). Keys never leave enclave memory.

### GAP-16: Agent shell access = potential credential exfiltration vector
- **Where**: Claude Code agent sessions using `--dangerously-skip-permissions`
- **What**: Agents have FULL Bash access. They could read api-token, env vars, call internal endpoints, read process memory. Templates tell agents what to do but don't PREVENT malicious actions.
- **Impact**: Any agent template (even builder) could theoretically exfiltrate contributed resources.
- **Current mitigation**: Agents run in sandboxed workspace directories, but have unrestricted shell access.
- **Fix options** (in order of practicality):
  - A) Agent-specific API tokens with LIMITED scopes (no resource/credential access) — medium effort
  - B) Don't inherit `CREDENTIAL_MASTER_KEY` env var to agent child processes — easy, do now
  - C) Run agents in containers/VMs with no host filesystem access — high effort
  - D) Network-level isolation: agents can only reach node API on localhost, nothing else — medium effort
  - E) Behavior monitoring: detect anomalous agent actions (env reads, unusual curl calls) — medium effort

---

## Low — Polish

### GAP-17: Favicon 404 on S3 and EC2 hosted apps
- **Where**: S3 hosting, EC2 hosting
- **What**: Apps return 403/404 for `/favicon.ico` — browser console error.
- **Impact**: Minor console noise.
- **Fix**: Builder template should include a default favicon, or S3/nginx error handling should return empty 200.

### GAP-18: Auth session expiry not handled gracefully
- **Where**: Gateway auth (`packages/gateway/lib/auth-context.tsx`)
- **What**: 15-min signature tokens expire without auto-refresh. User sees stale data or gets logged out during long test runs.
- **Impact**: Requires manual re-login during long E2E tests.
- **Fix**: Implement token refresh in auth-context (check expiry, auto-refresh before it expires).

---

## How The EC2 Deploy Flow Actually Works (For Reference)

### Current Flow (with all the problems):
```
1. User → "build me a WebSocket chat app"
2. Doorman → classifies as build, tier inferred (NOT stored)
3. Project created → MongoDB auto-assigned, GitHub NOT assigned
4. Manager spawned → reads CLAUDE.md, identifies Tier 2
5. Manager → spawns Builder agent
6. Builder → writes server.js, package.json, public/*
7. Builder completes → triggers auto-deploy:
   a. deployAgentWorkspace() scans workspace
   b. Uploads ALL files to S3 (wrong for Tier 2 — server.js is useless on S3)
   c. pushToGitHub() → FAILS (org 404) → repoUrl stays empty
   d. Reports "deployed" with broken gateway URL
8. Manager → tries POST /instances/:id/deploy → FAILS ("repoUrl required")
9. Manager workaround → uses gh CLI → creates PUBLIC repo on personal GitHub
10. Manager → retries POST /instances/:id/deploy with repoUrl → SUCCEEDS
11. EC2 instance → git clone (public repo, no auth needed) → npm install → npm start
12. App runs on port 3002 → but reported URL uses wrong port (80) and wrong path (/apps/)
13. User gets broken URL → can't see the site
```

### What Actually Worked (manually discovered):
```
S3 (Tier 1): http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/235b1b5d1971f501442fc80b/index.html
EC2 (Tier 2): http://100.53.198.66:3002/
```

### How EC2 Got The Code (Jai's Question):
The manager created a PUBLIC GitHub repo (`jairangwani/app-a51d261f618c1136bd583870-chat-room`) using the local `gh` CLI. Since it was public, the EC2 instance could `git clone` it without any credentials. If the repo were private, the clone would have failed (proven by the earlier pong-game failure: `"fatal: could not read Username for 'https://github.com'"`)

### Why 100.53.198.66 Is Reachable:
`100.53.198.66` IS a public AWS IP (NOT Tailscale despite the 100.x range). It's reachable via HTTP but not ICMP (security group blocks ping). The confusion arose because 100.x.x.x looks like CGNAT/Tailscale range, but AWS owns this block. Anyone can access `http://100.53.198.66:3002/` — it's a public URL.

---

## Proposed Architecture Fix — S3 Code Delivery

Replace GitHub as the code delivery mechanism for EC2 deploys. GitHub becomes optional (code backup/persistence), not on the critical deploy path.

### New Flow (Phase 87 — partially implemented):
```
1. Builder finishes code in workspace
2. Manager calls POST /projects/:id/deploy with workspaceDir
3. Node pushes to GitHub (if possible)
4. Node discovers compute peer via P2P CapabilityProfile (storageBackend=mongodb)
5. Tries up to 3 peers via requestReply.request(peerId, 'pando/deploy-app', ...)
6. Compute node: git clone → npm install → npm start (Tier 2) or S3 upload (Tier 1)
7. Deploy response includes port + publicAddress → node constructs correct URL
8. deployPeerId stored on project record (not instanceId)
```

### Future improvement: S3 code delivery
- Replace GitHub as code delivery for deploys (S3 tarball with signed URL)
- GitHub push failures wouldn't block deployment

---

## Priority Fix Order (updated Phase 87)

| Priority | Gap(s) | Effort | Impact |
|---|---|---|---|
| 1 | ~~GAP-1, GAP-2~~ | DONE | Fixed by Phase 79+87 |
| 2 | GAP-3 — Fix pushToGitHub() | 1 hour | GitHub push works for code persistence |
| 3 | S3 code delivery | 2-3 hours | Removes GitHub from critical deploy path |
| 4 | GAP-5 — Auto-assign GitHub resource | 15 min | Manager doesn't waste time on resource discovery |
| 5 | GAP-11 — Store tier in project | 30 min | Manager knows tier without re-analyzing |
| 6 | GAP-12 — Skip S3 for Tier 2 | 15 min | No wasted S3 uploads for server apps |
| 7 | GAP-15/16 — Security audit | 2 hours | Ensure agents can't exfiltrate credentials |
| 8 | GAP-6, GAP-10, GAP-13, GAP-14 — Template improvements | 1 hour | Manager efficiency and memory |
