# Human-Level E2E Test — Full Project Lifecycle

> **Note:** This file covers the manual app-build flow only (Tier 1 + Tier 2 deploy).
> For comprehensive E2E coverage across all layers and modes, see the genome knowledge graph:
> **`genome/knowledge/scenarios/*.know`** — 64 test nodes covering kernel, core, platform, security, and API regression.
> These are compiled into `output/graph.json` and consumed by GenomeBridge + ScenarioRunner at runtime.
>
> Reusable test scenario for verifying the complete user experience.
> Run after any major code change to ensure nothing is broken.

## Pre-requisites

1. Node running with `CREDENTIAL_MASTER_KEY` + `PANDO_STORAGE_URL` env vars
2. Gateway running on port 3222 (`PANDO_NODE_URL=http://127.0.0.1:4100`)
3. Node has 2+ peers, resources available (OpenAI key, MongoDB, S3, GitHub, EC2)
4. User account exists (e.g., `pando` / `KalaJi99@`)

## Test 1: Tier 1 — Static App (S3 Deployment)

### Scenario
User asks to build a simple guestbook app. Tests the full doorman → manager → builder → S3 deploy flow.

### Steps

1. Navigate to `http://127.0.0.1:3222/chat`
2. Login as `pando` / `KalaJi99@`
3. Send message: **"Build me a simple guestbook app where visitors can leave messages. Use a dark theme."**
4. Verify doorman instant response ("Setting up your project...")
5. Monitor backend every 30-60s:
   - `GET /agents/tree` — watch for project manager + builder
   - `GET /projects` — verify project created
   - Chat thread updates via SSE
6. Wait for completion (5-15 min)
7. Verify deployment:
   - Navigate to deployment URL
   - App renders (dark theme, guestbook form)
   - Submit a guestbook entry → verify it persists on reload
8. Verify in gateway:
   - `/projects` shows the app with status "deployed"
   - Chat thread has full conversation history

### Success Criteria
- [ ] Doorman classifies as `intent: build, tier: 1`
- [ ] Project created in ProjectStore
- [ ] Manager agent spawned and working
- [ ] Builder agent spawned by manager
- [ ] App deployed to S3 with live URL
- [ ] App works (renders, can submit entries, data persists)
- [ ] Source pushed to GitHub
- [ ] Project visible in gateway `/projects`
- [ ] Chat thread shows full conversation

### Monitoring Commands
```bash
# Agent hierarchy
curl -s -H "Authorization: Bearer $(cat ~/.pando/api-token)" http://127.0.0.1:4100/agents/tree | python3 -m json.tool

# Projects
curl -s -H "Authorization: Bearer $(cat ~/.pando/api-token)" http://127.0.0.1:4100/projects | python3 -m json.tool

# Node status
curl -s http://127.0.0.1:4100/status | python3 -m json.tool
```

---

## Test 2: Tier 2 — WebSocket App (EC2 Deployment)

### Scenario
User asks to build a real-time chat app using WebSockets. Tests Tier 2 flow: doorman → manager → builder → EC2 deploy.

### Steps

1. In same browser session, click "New Chat"
2. Send message: **"Build me a real-time chat room app using WebSockets. Users should be able to pick a username and see messages from others in real-time. Use Express and Socket.io."**
3. Verify doorman classifies as Tier 2 (WebSocket keyword)
4. Monitor backend:
   - `GET /agents/tree` — new project manager
   - `GET /instances` — EC2 instance launch (if not already running)
   - Manager should detect Tier 2 and use compute instance
5. Wait for completion (10-20 min)
6. Verify deployment:
   - Navigate to EC2 URL (e.g., `http://3.89.139.27:3001`)
   - Chat room loads
   - Open second browser tab to same URL
   - Send messages from both tabs → verify real-time delivery
7. Verify infrastructure:
   - `GET /instances` shows instance with deployment

### Success Criteria
- [ ] Doorman classifies as `intent: build, tier: 2`
- [ ] Manager detects Tier 2 requirement
- [ ] Builder creates Express + Socket.io app
- [ ] App deployed to EC2 (not S3)
- [ ] WebSocket connection works
- [ ] Multi-user chat works (two tabs)

### Monitoring Commands
```bash
# EC2 instances
curl -s -H "Authorization: Bearer $(cat ~/.pando/api-token)" http://127.0.0.1:4100/instances | python3 -m json.tool

# Instance health
curl -s -H "Authorization: Bearer $(cat ~/.pando/api-token)" http://127.0.0.1:4100/instances/<id>/health | python3 -m json.tool
```

---

## Flow Diagram

```
User "build me an app"
  ↓
POST /api/chat/threads/{id}/message
  ↓
doormanClassify() → intent=build, tier=1|2
  ↓
createProject() + runPreflight() (auto API key + MongoDB)
  ↓
bridge.enqueue('project-{id}', userRequest)
  ↓
AgentManager.processNextBridgeItem()
  ↓
Create/resume manager agent (Claude Code session)
  ↓
Manager → spawn builder → builder writes code
  ↓
Manager → deploy via POST /projects/:id/deploy:
  Auto-discovers compute peer via P2P CapabilityProfile
  Tier 1: S3 upload | Tier 2: PM2 app hosting
  ↓
Manager → relay URL to user via SSE
  ↓
User clicks URL → live app
```

## Key Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /agents/tree` | Agent hierarchy with status/cost |
| `GET /projects` | All projects with deployment status |
| `GET /status` | Node health, peers, balance |
| `GET /network/capabilities` | All compute peer profiles |
| `POST /projects/:id/deploy` | Unified deploy (P2P discovery, Tier 1 + 2) |

## Known Considerations

- JWT auth is stateless — tokens last 24h, no session expiry concerns
- Tier classification is inferred by manager from message text
- Manager may take 1-2 min to start (Claude Code session cold start)
- Builder may take 5-10 min for complex apps
- Deploy auto-discovers compute peers via P2P — no instance launch needed
