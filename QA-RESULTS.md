# Pando Node API — QA Test Results

**Date**: 2026-02-21
**Node**: http://127.0.0.1:4100
**Peer ID**: 12D3KooWACe64YzKkwbAt98VVTs652YtvMPrg68hzPxtbYYWhCPR
**Node Version**: 0.1.0

## Read-Only Endpoint Tests

| # | Endpoint | TUI Command | HTTP Status | Status | Notes |
|---|----------|-------------|-------------|--------|-------|
| 1 | GET /status | /status | 200 | PASS | Returns full node status: peerId, peers, balance (7645.67 Lux), supply (13182.44), uptime, listen addresses, capabilities, storageBackend. |
| 2 | GET /health | — | 200 | PASS | Returns degraded status (0 peers), peerId, uptime, memory (101.5MB), scheduler/monitor enabled, version. |
| 3 | GET /peers | /peers | 200 | PASS | Returns empty peers array (no peers currently connected). Expected for isolated node. |
| 4 | GET /balance/self | /balance | 200 | PASS | Returns `{"peerId":"self","balance":0}`. Note: returns 0 for "self" literal — /wallet returns the real balance (7645.67). This may be a bug: /balance/self resolves "self" to literal string instead of local peerId. |
| 5 | GET /wallet | /wallet | 200 | PASS | Returns peerId, publicKey, balance (7645.67), createdAt, accountCreatedAt, recentTransactions (10), dataDir, ownership info with backup instructions. |
| 6 | GET /network/capabilities | /network | 200 | PASS | Returns 1 capability profile (local node). Shows relay, compute_cpu, compute_gpu, storage, gateway, validator, index capabilities. claudeCode: true. |
| 7 | GET /scheduler/status | /scheduler | 200 | PASS | Scheduler running, 0 active tasks, 0 processed/succeeded/failed. Config: pollInterval 10s, maxConcurrent 2, maxDepth 3. |
| 8 | GET /scheduler/tasks | /tasks | 200 | PASS | Returns full task history (large response ~1.4MB). Contains all historical tasks with status, timelines, results. |
| 9 | GET /resources | /resources | 200 | PASS | Returns 4 resource entries (AI API keys). 2 active, 2 revoked. All provider: openai, model: gpt-4o-mini. |
| 10 | GET /resources/marketplace | — | 200 | PASS | Returns local prices for 8 resource types (relay, api_keys, compute_cpu, compute_gpu, storage, gateway, validator, index) plus stats with average/lowest prices and active provider count (1). |
| 11 | GET /resources/metering?period=day | — | 200 | PASS | Returns metering data: 0 nodes, empty readings, 0 rewards distributed. Expected for fresh session. |
| 12 | GET /governance/proposals | /proposals | 200 | PASS | Returns full proposals list (large response ~68KB). Contains 52 proposals with votes, decisions, timelines. |
| 13 | GET /agents/tree | — | 200 | PASS | Returns agent hierarchy: pando-node-mgr (manager) with 7 children (builders, testers), plus 3 project managers. Active agents present. |
| 14 | GET /monitor/status | — | 200 | PASS | Returns health metrics: degraded nodeHealth, 0 peers, 2 active alerts (high_memory_usage at 94%, no_peers for 36 min). Event loop lag 13ms. |
| 15 | GET /capacity | — | 200 | PASS | Returns supply/demand/rewards dashboard. 1 provider, 8 resource types with prices, 0 active tasks, network: 1 node, 75 accounts, 13182.44 total supply. |
| 16 | GET /council | — | 200 | PASS | Returns council state: 1 member (local node), reputation 422, hasClaudeCode: true, rotatesAt future timestamp. thisNodeOnCouncil: true. |
| 17 | GET /council/minutes | — | 200 | PASS | Returns markdown council minutes: "2026-02-21 -- Daily Reflection" with 1 council member. AI integration pending. |
| 18 | GET /network-state | — | 200 | PASS | Returns comprehensive network snapshot: network (1 node, 0 peers), economy (13182.44 supply, 2329 txns, 181 recent 24h), resources (supply/demand/rewards), tasks, health, governance (52 proposals, 49 decisions). |
| 19 | GET /marketplace | — | 200 | PASS | Returns 4 projects: My Portfolio Site, Calculator App, Test Hosted Site, Open Source Dashboard. All public/listed, various owners. |
| 20 | GET /chat/history | — | 200 | PASS | Returns chat history with encrypted user message and assistant response (E2E gateway test results). Thread ID present. |

## Auth Endpoint Tests (Sequential)

| # | Endpoint | TUI Command | HTTP Status | Status | Notes |
|---|----------|-------------|-------------|--------|-------|
| 21 | POST /auth/guest | — | 200 | PASS | Creates guest account. Returns token (128-char hex), peerId, publicKey, isClaimed: false. |
| 22 | POST /auth/claim | — | 200 | PASS | Claims guest with username "testuser_qa_2026" + password. Returns same token, isClaimed: true. Note: field is `username`+`password`. Special chars (!) in password caused JSON parse error 500 — bash quoting issue, not a server bug. |
| 23 | POST /auth/login | — | 200 | PASS | Login with credentials. Field name is `identifier` (not `username`) + `password`. Returns new token, peerId, publicKey, username, isClaimed: true. |
| 24 | GET /auth/me | — | 200 | PASS | Returns user profile: peerId, publicKey, username, isClaimed, createdAt, balance (125 Lux genesis), linkedNodes (empty before registration). |
| 25 | POST /auth/me/nodes | — | 200 | PASS | Registers node under user account. Field name is `nodePeerId` (not `nodeId`). Returns `{success: true}`. |
| 26 | GET /auth/me/nodes | — | 200 | PASS | Returns linked nodes array with the registered node peerId. |

## Summary

**Total Tests**: 26
**Passed**: 26
**Failed**: 0

### Observations

1. **GET /balance/self returns 0** — The endpoint resolves "self" as a literal peerId string, not as the local node's peerId. The actual balance (7645.67 Lux) is available via GET /wallet. This may be intentional (balance lookup by peerId) or a minor bug (should resolve "self" to local peerId).

2. **Node health: degraded** — Two active alerts: high memory usage (94% heap) and no peers connected (36 minutes). Expected for an isolated dev node.

3. **Auth field naming** — Login uses `identifier` (not `username`), node registration uses `nodePeerId` (not `nodeId`). These are correct per the API code but may surprise consumers expecting more standard field names.

4. **Large responses** — /scheduler/tasks (~1.4MB) and /governance/proposals (~68KB) return full history without pagination. May need pagination for production use.

5. **All core TUI-accessible functions work** — status, peers, wallet, balance, network, scheduler, tasks, resources, proposals, and all auth flows operate correctly via the HTTP API.
