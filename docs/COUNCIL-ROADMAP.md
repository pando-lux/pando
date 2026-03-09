# Council Roadmap — Autonomous Self-Improvement

> **The pando-infra council (lead + observer + QA agents) handles all upgrades from here.**
> Humans are observers. We submit tasks one at a time and watch. We only intervene when the council is stuck and it's absolutely necessary.

## Operating Protocol

### How It Works

1. **We pick a task** from the backlog below
2. **We submit it** via `POST /v1/teams/pando-infra/request` with clear instructions
3. **The lead agent** reads the task, writes code, calls `commit-and-propose`, deploys via governance
4. **We verify** the result (check commit, check `/v1/status`, check `/v1/services`)
5. **We mark the task** DONE or FAILED below
6. **If stuck:** we brainstorm a hint, submit a follow-up request. Only touch code ourselves as last resort.

### Rules for Us (Humans/CEO)

- **DO NOT** write code directly unless council has failed twice on the same task
- **DO NOT** run `commit-and-propose` ourselves — that's the council's job now
- **DO** verify results after each task
- **DO** give clear, specific task descriptions (the lead is good but needs clear instructions)
- **DO** give one task at a time — wait for completion before the next
- **DO** monitor token cost (`/v1/teams/pando-infra/cost`) to ensure efficiency

### How to Submit a Task

```bash
API_TOKEN=$(cat ~/.pando/api-token)
curl -s -X POST http://localhost:4000/v1/teams/pando-infra/request \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"message":"<clear task description with specific files and expected outcome>"}'
```

### How to Verify

```bash
# Check board (should show task processing or done)
curl -s http://localhost:4000/v1/teams/pando-infra/board -H "Authorization: Bearer $API_TOKEN"

# Check latest commit (should be the agent's work)
git log --oneline -3

# Check node health after deploy
curl -s http://localhost:4000/v1/status -H "Authorization: Bearer $API_TOKEN" | python3 -m json.tool

# Check cost
curl -s http://localhost:4000/v1/teams/pando-infra/cost -H "Authorization: Bearer $API_TOKEN"
```

---

## Task Backlog

Tasks are ordered by difficulty. Start easy to build confidence, then increase complexity.

### Tier 1: Easy Wins (single-file, low risk)

| # | Task | Description | Status |
|---|------|-------------|--------|
| 1.1 | Add header comment to team-registry.ts | Add `// TeamRegistry — SQLite + P2P gossip sync for team state. See BIBLE.md Section 4.2.` at top of `packages/node/src/core/team-registry.ts` | |
| 1.2 | Fix duplicate step label in upgrade-protocol.ts | There are two "Step 6b" labels — the build step at line ~333 should be "Step 7" since Steps 6a/6b/6c are the npm link logic. Fix in `packages/node/src/core/upgrade-protocol.ts` | |
| 1.3 | Add header comment to capability-detector.ts | Add `// CapabilityDetector — detects node capabilities (docker, python, gpu, playwright, pando-code).` at top of `packages/node/src/core/capability-detector.ts` | |

### Tier 2: Code Cleanup (multi-file, medium risk)

| # | Task | Description | Status |
|---|------|-------------|--------|
| 2.1 | Update gateway council/board proxy | In `packages/gateway/app/api/council/board/route.ts`, change the backend call from `/council/board` to `/v1/teams/pando-infra/board`. The gateway should call the new API, not the legacy route. | |
| 2.2 | Update gateway council/request proxy | In `packages/gateway/app/api/council/request/route.ts`, change the backend call from `/council/request` to `/v1/teams/pando-infra/request`. | |
| 2.3 | Update gateway council/trigger proxy | In `packages/gateway/app/api/council/trigger/route.ts`, change the backend call from `/council/trigger` to `/v1/teams/pando-infra/trigger`. | |
| 2.4 | Remove legacy /council/* routes from core-api.ts | After 2.1-2.3 are done and verified: delete the 9 legacy `/council/*` route handlers from `packages/node/src/api/core-api.ts` (lines ~997-1087). Also remove `/council/veto/:id` from `platform-api.ts`. Also remove the `/council/request` rate limit entry from `api-server.ts`. Build must pass. | |
| 2.5 | Update E2E tests to use /v1/teams/* | In `tests/e2e/pando-node/pando-e2e.spec.ts`, replace all `/council/status`, `/council/board`, `/council/request` calls with `/v1/teams/pando-infra/status`, `/v1/teams/pando-infra/board`, `/v1/teams/pando-infra/request`. | |

### Tier 3: Feature Improvements (complex, higher risk)

| # | Task | Description | Status |
|---|------|-------------|--------|
| 3.1 | Proactive board state replication | Currently board state only syncs on-demand (when a node claims a team). Add periodic board state broadcast — every 5 min, the managing node publishes its board state to `pando/board-sync` GossipSub topic. Other nodes cache it. On claim, use cached state instead of requesting from (possibly dead) node. Files: `packages/node/src/core/engine-adapter.ts`, `packages/node/src/kernel/network.ts`. | |
| 3.2 | Network partition graceful reconciliation | When a node disconnects and reconnects, verify it gracefully reconciles team ownership (latest `claimedAt` wins), board state (merge), and governance proposals (catch up). Currently NOT TESTED. | |
| 3.3 | Add /v1/teams/:id/history endpoint | New endpoint that returns the last N actions taken by team agents (commits, task updates, messages). Useful for observing council activity without reading git log. | |
| 3.4 | Gateway dashboard real-time updates | The gateway dashboard (`/council` page) should auto-refresh or use polling to show live team status, board tasks, and agent activity. Currently static on page load. | |

### Tier 4: Documentation (council can write docs too)

| # | Task | Description | Status |
|---|------|-------------|--------|
| 4.1 | Create README.md | Create a `README.md` at repo root. Brief: what Pando is, how to run a node (light vs full), link to BIBLE.md for architecture. Keep it under 50 lines. | |

### Tier 5: Deferred / Manual Only

These require human action or access to other repos. Not for the council.

| # | Task | Why Manual |
|---|------|-----------|
| 5.1 | Rotate AWS credentials (Phase 0.2) | Requires AWS IAM console access |
| 5.2 | Scrub AKIA from git history (Phase 0.4) | Requires `git filter-repo` — destructive, needs human oversight |
| 5.3 | Make pando-code repo public (Phase 2) | Requires pando-code repo access + GitHub settings |
| 5.4 | Add createService() to pando-code (Phase 2.4) | Requires pando-code repo changes |
| 5.5 | EC2 SSH security group update | Requires AWS console or CLI with admin profile |
| 5.6 | Vercel gateway env vars | Requires Vercel dashboard access |

---

## Progress Log

| Date | Task | Result | Commit | Notes |
|------|------|--------|--------|-------|
| 2026-03-09 | Proof of concept: add comment to service-loader.ts | PASS | 5a2f53b2 | Lead agent did it autonomously in <60s. First ever council self-modification. |

---

## Success Criteria

The council is "production ready" when:
1. All Tier 1 tasks completed without human intervention
2. All Tier 2 tasks completed (legacy cleanup done)
3. At least one Tier 3 task completed (proves complex work capability)
4. Zero failed deploys from council changes (build always passes)
5. Council can handle a bug report: user submits bug → lead investigates → fixes → deploys
