# Phase 51: Infrastructure Awareness — Issue Tracker

## Issues Found During E2E Game Test (2026-02-22)

### MUST FIX (blocking real usage)

| # | Issue | Why It Matters | Fix |
|---|-------|---------------|-----|
| I1 | **Data store is in-memory (ephemeral)** | Node restart = all app data gone. No real app can rely on this. | Back with SQLite instead of Map. Simple migration — SQLite is already used everywhere. |
| I2 | **Infrastructure endpoint missing public URLs** | Agents don't know the node's external address. Builder hardcoded `192.168.1.167:4100`. Other nodes would have different IPs. | Add `nodePublicUrl` (from listen addresses or env var `PANDO_PUBLIC_URL`) and `gatewayPublicUrl` (env var `GATEWAY_PUBLIC_URL`) to infrastructure endpoint. |
| I3 | **User must manually enter node IP** | Normal users don't know IPs. The game should "just work" from the URL. | Gateway proxy: apps call `/api/apps/data/*` on the gateway → gateway proxies to node. Same origin = no IP needed. Deploy games as gateway pages, not just S3. |
| I4 | **Scheduler requires --scheduler flag** | Node operators have to know about this flag. Should auto-detect Claude Code. | Check for `claude` binary at startup. If found, auto-enable scheduler. Add `--no-scheduler` for opt-out. |
| I5 | **Infrastructure info compressed out of manager context** | After 100+ tasks, manager forgets infrastructure exists. | Inject infrastructure summary into EVERY event prompt (same pattern as deployment reminders). |

### SHOULD FIX (improves quality)

| # | Issue | Why It Matters | Fix |
|---|-------|---------------|-----|
| I6 | **No auth on data store writes** | Anyone with namespace/key can overwrite data. Game state can be corrupted by third party. | Generate write token on first PUT per namespace. Require token header for subsequent writes. |
| I7 | **S3 URLs are ugly/not shareable** | `http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/pando-node/index.html` — nobody shares this. | Serve deployed apps through gateway at `/apps/:projectId` or use a short URL service. |
| I8 | **Governance UI shows manual approve/reject on AI network** | On an AI-run network, voting should be AI-first with human override option. | Redesign governance UI: show AI council votes prominently, "Add your vote" as secondary action. |

### DEFER (future work)

| # | Issue | Why It Matters | Fix |
|---|-------|---------------|-----|
| I9 | S3 is static only — no server-side logic | Apps needing WebSockets, scheduled jobs, or server-side validation can't deploy. Data store covers basic CRUD but not compute. | Compute hosting (containers/serverless). Major infra piece. Data store handles 80% of cases. |
| I10 | No app monitoring | Once deployed to S3, zero visibility into usage, errors, or health. | Analytics/error tracking for deployed apps. |
| I11 | Single-node data store | Data lives on one node. Node down = all apps lose backend. | Replicate data store across peers, or use MongoDB (built-in replication). |

### NOT AN ISSUE (addressed by design)

| Question | Answer |
|----------|--------|
| Node serving HTML files — increases complexity? | NO. The gateway is the web server. Node stays API-only. Apps served through gateway pages (already built: `/games` page exists). No need for node to serve HTML. |
| Did agents use any hacks? | The PROCESS was clean (chat→manager→builder→deploy). The CONTENT had one hack: hardcoded IP. Root cause is I2 (missing public URL in infrastructure endpoint). |
