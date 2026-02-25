---
id: gateway
type: interface
domain: ui
entry: packages/gateway/app/page.tsx
depends_on: [api-server]
depended_by: []
exposes:
  - Home page — node status, activity feed, smart input
  - Chat page — AI chat with threaded conversations
  - Content page — content registry browser
  - Projects page — project CRUD, collaborators, invites, stats (client-side computed)
  - Agents page — agent tree view, status, cost tracking
  - Wallet page — balance, transactions, transfers
  - Governance page — proposals, votes, decisions
  - Resources page — contribute/list/revoke shared resources, My Resources section, My Nodes section (fetches user's nodes from network capabilities via /api/capabilities/network/user/:username)
  - Capacity page — network supply/demand dashboard, reward signals, auto-refresh (Phase 49)
  - Explore page — network exploration
  - Login page — username/password sign in
  - Register page — create new account (username + password + confirm)
  - Legacy /claim page deleted — replaced by /register
  - Gateway status API — multi-node pool health
  - Marketplace API proxy — forwards to node /marketplace (Phase 46)
  - Thread PATCH proxy — update thread metadata (Phase 46)
  - Node status includes linkedUser + uptime (Phase 58b)
  - Network capabilities proxy — /api/capabilities/network and /api/capabilities/network/user/[username] (Phase 60) — My Nodes fetches all user's nodes from network capabilities
  - Capacity API proxy — forwards to node /capacity (Phase 49)
  - Resource Proxy — /api/resource-proxy/* for credential-safe database access (Phase 53)
  - Resource Contribution Guide — /resources/guide step-by-step tutorial for all 5 providers (Phase 57)
  - App directory — list deployed apps with external URLs (Phase 53)
rules: []
last_verified: 2026-02-22
---

# Gateway

## What It Does
Next.js 16 + Tailwind web UI that connects to Pando backend nodes via HTTP API. Provides a visual interface for node status, chat, task management, monitoring, wallet, network topology, search, and governance. Phase 43: Multi-node aware with automatic failover.

## How It Works
- Built with Next.js App Router (uses `app/` directory, NOT `src/pages/`). All pages are client components (`"use client"`).
- **Phase 43: Multi-Node Gateway.** `NodePool` class (`lib/node-pool.ts`) manages multiple backend nodes with health checking, circuit breaking, and smart selection.
  - **Config:** `PANDO_NODES` env var (comma-separated URLs) or `PANDO_NODE_URL` (single node, backward compatible).
  - **Health checks:** Every 30s, `GET /status` on each node. After 3 consecutive failures → circuit opens (skip for 60s). Half-open retry after expiry.
  - **Discovery:** Every 5 minutes, queries `/network/capabilities` on ALL known healthy nodes (not just primary). Peers with `details.httpApi` and public IPs are auto-added and verified. Stops after first successful discovery response.
  - **Selection:** `getBestNodeUrl('any')` returns lowest-latency healthy node. `'claude'` filters for nodes with Claude Code. `'primary'` always returns primary (for writes needing auth). On cold start (all latencies=0), randomizes selection to avoid always hitting a dead primary.
  - **Failover:** `fetchFromNode(path, options, preference)` exported from `node-connection.ts` — tries best node, then one fallback on failure. Used by all auth routes and chat routes. `NodeConnection` class methods also have built-in failover. Remaining ~40 API routes still use raw `getNodeUrl()` + single fetch (to be migrated).
  - **Auth strategy:** Writes (POST/DELETE) route to primary node (matching auth token). Reads (GET) go to any healthy node.
  - **Status endpoint:** `GET /api/gateway/status` returns pool health (node count, latencies, circuit state).
  - **NavBar indicator:** Shows green/amber/red dot with healthy/total node count.
- `NodeConnection` class (`lib/node-connection.ts`) handles all communication with node HTTP APIs. Uses `NodePool` for URL selection.
- **Token re-read per request (Phase 57c):** `authHeaders()` reads `PANDO_API_TOKEN` env var or `~/.pando/api-token` file on EVERY request. Previously cached at construction, causing stale token errors after node restart. Attaches `Authorization: Bearer <token>` header on authenticated requests.
- Home page polls `/api/status`, `/api/scheduler/status`, and `/api/activity/stream` every 10 seconds.
- API proxy routes in `app/api/` forward requests to nodes, adding auth headers. This keeps the Bearer token server-side.
- **Auth proxy pattern:** Browser sends `Authorization: Bearer <user-token>` to gateway API routes. Gateway proxy extracts the token and forwards it as `X-User-Token` header to the node (node expects user tokens on this header, separate from node-level API token auth). See `app/api/auth/me/route.ts` for the pattern.
- **Projects page "Open Chat" (Phase 46):** Projects without a linked thread show an "Open Chat" button that navigates to `/chat?projectId=<id>`, creating a project-linked thread.
- **Chat page projectId awareness (Phase 46):** `?projectId=` URL param is read from query string. When present, `projectId` is included in thread creation and message requests so new threads get linked to the project.
- **Projects page stats:** Computed client-side from the user's actual projects array. No server-side `/projects/stats` call — prevents misleading platform-wide counts. Stats: "My Projects", "Active", "Shared With Me", "Public".
- **Resources page (Phase 48, updated Phase 60):** Two main sections. "My Resources" shows the logged-in user's own contributed resources (filtered by user peerId from auth context). "My Nodes" fetches ALL of the user's nodes from network capabilities via `GET /api/capabilities/network/user/:username` — shows each node with capability tags (Claude Code in violet, uptime, peer count). Both sections require authentication — hidden when not logged in. Legacy `agent_runtime` resources filtered from display.
- **Capacity page (Phase 49):** Dashboard showing network supply vs demand and reward signals. Fetches from `GET /api/capacity` (proxy to node). 5 sections: Network Overview (cards: total nodes, Lux supply, active tasks, health), Supply (table with available/needed badges, provider counts, price ranges), Demand (task metrics, resource usage), Reward Signals (sorted by estimated daily earnings with gradient bars), Call to Action. Auto-refreshes every 30 seconds.
- **Login timeout (Phase 48):** `auth-context.tsx` wraps the login fetch with a 20s browser-side timeout (`AbortSignal.timeout(20000)`). Gateway login proxy (`app/api/auth/login/route.ts`) has 15s timeout and guards against non-JSON responses from the node.
- **App data store:** **DELETED in Phase 53.** Gateway no longer connects to MongoDB for app data. No `/api/apps/data/*` routes. No `lib/mongodb.ts`. Apps have their own backends that query their own databases. The Resource Proxy (Phase 53) handles credential privacy and usage metering.
- **App content serving:** **DELETED in Phase 53.** No `/apps/*` S3 proxy. Apps deploy to contributed hosting resources (GitHub Pages, Vercel, S3 direct) and have their own URLs. Gateway is a directory pointing to apps, not a proxy.
- **Resource Proxy (Phase 53):** Gateway hosts the Resource Proxy at `/api/resource-proxy/*`. Apps send queries with project-scoped API keys. Proxy decrypts real credentials from ResourceRegistry, executes queries, meters usage, bills Lux. Apps never see raw credentials.
- **`.env.local` configuration:** `PANDO_NODE_URL` (primary node), `PANDO_NODES` (comma-separated for multi-node), `PANDO_API_TOKEN` (node API Bearer token). The NodePool reads these at startup — restart gateway after changes. If neither `PANDO_NODES` nor `PANDO_NODE_URL` is set, falls back to hardcoded public seed nodes (LS-1, EC2-1, EC2-2, LS-2).
- Uses SSE (`lib/use-sse.ts`) for real-time updates. SSE reconnects naturally go to the next healthy node.
- NavBar component provides navigation across all pages + node health indicator.

## Gotchas
- Uses `app/` directory (Next.js App Router), NOT `src/pages/` (Pages Router).
- NEVER use `localhost` in `PANDO_NODE_URL` — always use `127.0.0.1`. IPv6 resolution of `localhost` causes connection failures.
- `getStatusSync()` in NodeConnection returns a default empty object — always use `getStatusAsync()` for actual data.
- The public gateway at `https://gateway-one-mu.vercel.app` connects to Lightsail. Vercel env vars: `PANDO_NODES`, `PANDO_API_TOKEN`.
- **`@noble/curves` must be pinned to v1.x (`^1.9.7`).** v2 removed subpath exports (`./ed25519`), breaking Turbopack resolution on Vercel. This is set in `package.json` and `next.config.ts` (`transpilePackages`).
- `fetch()` calls use `AbortSignal.timeout(5000)` — requires Node 18+.
- Private IPs (127.0.0.1, 100.x Tailscale, 10.x, 192.168.x) are skipped in auto-discovery — only public IPs added.
- `vercel.json` exists with custom `installCommand` for clean dependency resolution.

## Key Files
- `packages/gateway/app/page.tsx` — Home page (status, input, activity)
- `packages/gateway/app/projects/page.tsx` — Projects page (CRUD, stats, tabs)
- `packages/gateway/app/chat/page.tsx` — Chat page (threaded AI conversations)
- `packages/gateway/app/governance/page.tsx` — Governance page
- `packages/gateway/app/claim/page.tsx` — Claim account page
- `packages/gateway/app/login/page.tsx` — Login page
- `packages/gateway/lib/node-pool.ts` — NodePool class (multi-node management, health checks, circuit breaker)
- `packages/gateway/lib/node-connection.ts` — NodeConnection class (HTTP bridge with failover)
- `packages/gateway/lib/crypto.ts` — Browser-side Ed25519/X25519 crypto (auth + E2E encryption)
- `packages/gateway/lib/auth-context.tsx` — AuthContext provider (guest auto-create, claimed, signature auth)
- `packages/gateway/lib/use-sse.ts` — SSE hook for real-time updates
- `packages/gateway/components/NavBar.tsx` — Navigation + node health indicator
- `packages/gateway/app/api/auth/me/route.ts` — Auth proxy (X-User-Token forwarding pattern)
- `packages/gateway/app/api/resource-proxy/` — Resource Proxy routes (Phase 53, credential privacy + usage metering)
- `packages/gateway/app/api/projects/route.ts` — Projects proxy (GET + POST)
- `packages/gateway/app/api/gateway/status/route.ts` — Pool health endpoint
- `packages/gateway/app/api/marketplace/route.ts` — Marketplace proxy (Phase 46)
- `packages/gateway/app/api/capabilities/network/route.ts` — Network capabilities proxy (Phase 60)
- `packages/gateway/app/api/capabilities/network/user/[username]/route.ts` — User's nodes capabilities proxy (Phase 60)
- `packages/gateway/app/resources/page.tsx` — Resources page (My Resources, My Nodes, network resources, link to guide)
- `packages/gateway/app/resources/guide/page.tsx` — Resource Contribution Guide (step-by-step per provider + Claude Code node setup)
- `packages/gateway/app/capacity/page.tsx` — Capacity dashboard (supply, demand, rewards, CTA)
- `packages/gateway/app/api/capacity/route.ts` — Capacity proxy (forwards to node /capacity)
- `packages/gateway/app/api/` — API proxy routes (50+ files, all use getNodeUrl())
- `packages/gateway/.env.local` — Local config (PANDO_NODE_URL, PANDO_NODES, PANDO_API_TOKEN)
- `packages/gateway/next.config.ts` — transpilePackages for @noble/curves
- `packages/gateway/vercel.json` — Vercel deployment config (installCommand)
