---
id: phase-83-hardening
type: plan
domain: infrastructure
status: PLANNED
created: 2026-02-25
---

# Phase 83: Network Hardening & Compute Failover

## Goal

Transform the network from "dev mode where everybody has everything" to the actual two-tier trust architecture. Every user-facing feature must work from an untrusted node — including chat, projects, AI search, and active agent work with Claude Code.

---

## Current State (Dev Mode)

| Node | Master Key | MongoDB | Credential Access | Claude Code | Role |
|------|-----------|---------|-------------------|-------------|------|
| Lightsail | YES | YES | YES | NO | Relay |
| Windows | YES | YES | YES | YES | Dev |
| EC2 dev | YES | YES | YES | YES | Compute |

**Problem:** All 3 nodes have full access. No node is actually untrusted. We've never tested the real architecture.

## Target State

| Node | Master Key | MongoDB | Credential Access | Claude Code | Role |
|------|-----------|---------|-------------------|-------------|------|
| Lightsail | NO | NO | NO | NO | Relay + routing |
| Windows | NO | NO | NO | YES | User node (agent work) |
| EC2-A (existing) | YES | YES | YES | YES | Compute (dev, SSH on) |
| EC2-B (new) | YES | YES | YES | YES | Compute (tripwired) |

---

## The Core Architecture Problem

### Where Things Happen vs Where Data Lives

```
┌─────────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED NODE                               │
│                    (User's PC, has Claude Code)                      │
│                                                                     │
│   Agent Work Happens HERE          Data Lives on EC2 (MongoDB)      │
│   ┌──────────────────┐            ┌──────────────────────────┐     │
│   │ Manager Agent     │──writes──►│ P2PStorageBackend        │     │
│   │ Builder Agent     │           │ (implements StorageBackend│     │
│   │ Tester Agent      │◄──reads── │  but forwards everything │     │
│   │ Claude Code       │           │  via P2P to EC2)         │     │
│   │ BridgeQueue       │           └──────────┬───────────────┘     │
│   │ Workspace (temp)  │                      │ P2P request-reply   │
│   └──────────────────┘                      │                     │
│                                              ▼                     │
│                                   ┌──────────────────────┐         │
│                                   │ EC2 Compute Node     │         │
│                                   │ ┌──────────────────┐ │         │
│                                   │ │ MongoStorageBack │ │         │
│                                   │ │ (real MongoDB)   │ │         │
│                                   │ └──────────────────┘ │         │
│                                   │ CredentialStore      │         │
│                                   │ ThreadStore          │         │
│                                   │ ProjectStore         │         │
│                                   └──────────────────────┘         │
└─────────────────────────────────────────────────────────────────────┘
```

### The Problem with Current Code

When an agent runs on an untrusted node (no MongoDB):

1. `threadStore = null` → agent messages delivered in real-time via BridgeQueue BUT **never persisted**
2. `projectStore = null` → project records **never created**
3. User refreshes page → chat history **gone**
4. User returns days later → no record of their conversation or project

The real-time delivery works (BridgeQueue → HTTP → Gateway → User). But persistence is broken because the **writes** never happen.

### The Solution: P2PStorageBackend

Instead of proxying individual HTTP endpoints, we create a new StorageBackend implementation that forwards all operations to a compute node via P2P:

```typescript
class P2PStorageBackend implements StorageBackend {
  // Same 6-method interface as MongoStorageBackend
  // But every operation goes via P2P to a node with MongoDB

  async putRecord(collection, key, data) {
    return this.proxyToCompute('putRecord', { collection, key, data });
  }

  async getRecord(collection, key) {
    return this.proxyToCompute('getRecord', { collection, key });
  }

  async queryRecords(collection, filter, options?) {
    return this.proxyToCompute('queryRecords', { collection, filter, options });
  }

  async deleteRecord(collection, key) {
    return this.proxyToCompute('deleteRecord', { collection, key });
  }

  async listRecords(collection, filter?) {
    return this.proxyToCompute('listRecords', { collection, filter });
  }

  async pushToArray(collection, key, field, value) {
    return this.proxyToCompute('pushToArray', { collection, key, field, value });
  }

  private async proxyToCompute(method, args) {
    // Find peer with storageBackend: 'mongodb' via CapabilityRegistry
    // Send P2P request: pando/storage-proxy { method, args }
    // Return response
    // On failure: try next compute peer
    // On all fail: throw (caller handles gracefully)
  }
}
```

**Why this is the right approach:**
- ThreadStore, ProjectStore, etc. don't change at all — they just get a different StorageBackend
- All existing code works as-is
- Agent message persistence works because `threadStore` is no longer null
- The `StorageBackend` interface already exists (Phase 42) — we just add a new implementation
- Clean separation: untrusted nodes never see MongoDB, never have credentials

### What Changes in Node Startup

```typescript
// Current (index.ts):
if (process.env.PANDO_STORAGE_URL) {
  this.storageBackend = new MongoStorageBackend(url);
} else {
  // storageBackend stays null → everything breaks
}

// New:
if (process.env.PANDO_STORAGE_URL) {
  this.storageBackend = new MongoStorageBackend(url);
} else {
  // P2P proxy to compute nodes
  this.storageBackend = new P2PStorageBackend(this.network, this.capabilityRegistry);
}
```

**Every node gets a StorageBackend.** Compute nodes get MongoStorageBackend (direct). User nodes get P2PStorageBackend (proxied). ThreadStore, ProjectStore, etc. always initialize — no more `if (!threadStore) return 503`.

---

## User Scenarios (All Must Work)

### Scenario A: User Starts Building on Untrusted Node

1. User → Gateway → Node A (untrusted, has Claude Code, no MongoDB)
2. `POST /chat/message` → ThreadStore writes via P2PStorageBackend → EC2 persists to MongoDB
3. Manager agent spawns on Node A (has Claude Code)
4. Agent works in local workspace (`~/.pando/agents/<id>/`)
5. Agent messages: delivered in real-time via BridgeQueue AND persisted via P2PStorageBackend
6. Project created: ProjectStore writes via P2PStorageBackend → EC2 persists to MongoDB
7. Code pushed to GitHub (`pando-lux/app-<id>-<name>`)
8. App deployed to EC2 (S3 or compute)
9. Agent archived, workspace cleaned up

### Scenario B: User Returns Days Later, Different Node

1. User → Gateway → Node B (different untrusted node)
2. `GET /chat/threads` → ThreadStore reads via P2PStorageBackend → gets history from MongoDB
3. User sees ALL previous conversations (persisted in Scenario A)
4. User clicks project, wants to continue building
5. `GET /projects/:id` → ProjectStore reads via P2PStorageBackend → gets project record
6. Project has `repoUrl: 'https://github.com/pando-lux/app-<id>'`
7. User sends message to continue building
8. New manager agent spawns on Node B
9. **Phase 66 workspace hydration**: Agent's workspace cloned from GitHub (line 500-518 in agent-manager.ts — already built)
10. Manager has: code from GitHub + conversation history from MongoDB + project context
11. Work continues seamlessly

### Scenario C: User Returns to Same Node

1. Same as B, but workspace might still exist locally (faster — no clone needed)
2. If agent was archived, workspace compressed → decompress and resume
3. If agent was cleaned up, clone from GitHub (same as Scenario B)

### Scenario D: Node Crashes Mid-Build

1. Agent was running on Node A, Node A crashes
2. In-flight messages that were proxied to MongoDB → safe in MongoDB
3. Messages that were only in BridgeQueue (not yet proxied) → lost
4. Agent workspace → lost (ephemeral by design)
5. GitHub repo → safe (code was pushed before crash, or has last successful push)
6. User reconnects → may get Node B
7. From MongoDB: project record, conversation history all intact
8. Resume: clone from GitHub, spawn new manager, continue

### Scenario E: EC2 Compute Node Dies

1. Node A (untrusted) is mid-build, P2PStorageBackend was using EC2-A
2. EC2-A dies → P2P requests timeout
3. P2PStorageBackend fails over to EC2-B (next compute peer)
4. Agent work continues on Node A, writes now go to EC2-B
5. MongoDB is external (Atlas or shared) → same data accessible from either EC2
6. No data loss, no interruption (from user's perspective)

### Scenario F: All EC2 Nodes Down

1. P2PStorageBackend can't reach any compute peer
2. Agent work continues locally but messages aren't persisted
3. BridgeQueue still delivers messages in real-time to user
4. When EC2 comes back, next write succeeds
5. **Graceful degradation**: user sees real-time output, but chat history may have gaps

---

## Data Persistence Layers

| Data | Where It Lives | Survives Node Crash? | Survives EC2 Death? |
|------|---------------|---------------------|-------------------|
| Chat messages | MongoDB (via P2PStorageBackend) | YES | YES (MongoDB is external) |
| Project records | MongoDB (via P2PStorageBackend) | YES | YES |
| Agent workspace | Local filesystem (ephemeral) | NO | N/A (not on EC2) |
| Project code | GitHub (`pando-lux/app-*`) | YES | YES |
| Deployed apps | S3 (Tier 1) or EC2 (Tier 2) | N/A | Tier 1: YES, Tier 2: needs redeploy |
| Ledger/balances | SQLite, P2P-synced | YES (P2P) | YES (P2P) |
| Governance | P2P-synced | YES (P2P) | YES (P2P) |
| Resource metadata | P2P-synced GossipSub | YES (P2P) | YES (P2P) |
| Credentials | MongoDB + master key (EC2 only) | N/A | YES (MongoDB external) |

**Key principle:** The only thing that dies with a node is the agent workspace. Everything else is either in MongoDB, GitHub, S3, or P2P-synced. The workspace is reconstructable from GitHub.

---

## Gateway Session Routing

### The Problem

When a user is actively chatting with a manager agent on Node A, their next HTTP request might get routed to Node B (NodePool picks lowest latency). Node B has no running agent for this conversation.

### The Solution

Gateway NodePool (Phase 43) needs **session affinity** for active projects:

1. When user starts a chat that triggers agent work, gateway notes which node handled it
2. Subsequent messages for that thread/project route to the SAME node
3. If that node goes down, failover to another node (agent will need to be re-spawned)
4. Session affinity clears when agent completes (workspace archived)

**Implementation:** Gateway stores `threadId → nodeUrl` mapping in local memory. `POST /chat/message` checks if active mapping exists before calling `getBestNodeUrl()`.

---

## Phase 83 Steps (in order)

### Step 0: Build P2PStorageBackend (Code — MUST DO FIRST)

Create `packages/node/src/p2p-storage-backend.ts`:
- Implements `StorageBackend` interface (6 methods)
- Finds compute peers via CapabilityRegistry (`storageBackend: 'mongodb'`)
- Forwards operations via P2P request-reply (`pando/storage-proxy`)
- Failover: tries next compute peer on timeout
- Local SQLite cache for reads (optional, for performance)

Register P2P handler on compute nodes (`pando/storage-proxy`):
- Receives `{ method, args }` from untrusted peer
- Executes against local MongoStorageBackend
- Returns result

Wire in `index.ts`:
- No `PANDO_STORAGE_URL` → create P2PStorageBackend instead of leaving null
- All downstream code (ThreadStore, ProjectStore, etc.) works as-is

**Test:** Start a node with no `PANDO_STORAGE_URL`, create a thread, verify it's in MongoDB (via EC2).

### Step 1: Launch Second EC2 Instance (EC2-B)

- Tripwired (no SSH, pando-monitor active)
- `CREDENTIAL_MASTER_KEY` + `PANDO_STORAGE_URL` injected
- Verify: `GET /network/capabilities` shows 2 nodes with `credentialAccess: true`

### Step 2: Verify EC2-B Works

- [ ] AI search, deploy, credential ops all work via EC2-B
- [ ] `pando/storage-proxy` handler responds to P2P requests

### Step 3: Remove Master Key + MongoDB from Lightsail

- Remove `CREDENTIAL_MASTER_KEY` and `PANDO_STORAGE_URL`
- Restart → node uses P2PStorageBackend automatically
- Test ALL features (search, governance, chat threads, etc.)

### Step 4: Remove Master Key + MongoDB from Windows

- Same as Step 3
- Test: gateway pointed at Windows node → all pages work
- Test: start a project via chat → agent runs locally, messages persist to MongoDB via P2P

### Step 5: Full Agent Workflow E2E (Untrusted Node)

From Windows (untrusted, has Claude Code, no MongoDB):
1. Chat message → triggers project creation
2. Manager agent spawns locally
3. Agent builds something
4. Messages appear in real-time AND persist to MongoDB (via P2P proxy)
5. Close browser, reopen → chat history intact
6. Continue building → agent resumes (or new agent clones from GitHub)

### Step 6: Deploy Failover (Code Change)

- `POST /projects/:id/deploy` tries all running EC2 instances, not just `running[0]`
- On timeout/failure, tries next instance

### Step 7: EC2-A Death Test

1. Deploy app to EC2-A
2. Kill EC2-A
3. Verify: P2PStorageBackend routes to EC2-B
4. Verify: chat and project reads still work
5. Redeploy app → goes to EC2-B
6. Bring EC2-A back → network self-heals

### Step 8: Full Network E2E

All roles working, all scenarios tested:
- Untrusted nodes serve gateway (chat, projects, search — all via proxy)
- Agent work happens on untrusted nodes with Claude Code
- Data persists through node crashes and EC2 failovers
- Zero manual intervention

---

## What This DOESN'T Cover (Future)

- **Session affinity in gateway** — noted as needed, but can be a follow-up phase
- **Split-key encryption (Phase 64b)** — layers on top
- **Auto-scaling EC2** — launching new instances on demand
- **Custom domain** — not needed for testing
- **Tripwire on EC2-A** — stays dev mode until >8 nodes

---

## Infrastructure

| Resource | Status | Action |
|----------|--------|--------|
| EC2-A (54.82.241.132) | Running | Keep as dev compute (SSH on) |
| EC2-B (new) | Not launched | Launch via CloudInstanceManager |
| Lightsail (54.145.144.221) | Running | Remove master key + MongoDB |
| Windows (100.87.67.78) | Running | Remove master key + MongoDB |

## Cost

- EC2-B: t3.small ≈ $15/month

---

## Success Criteria

1. **P2PStorageBackend works**: untrusted nodes read/write user data via P2P
2. **Agent messages persist**: messages from agents on untrusted nodes are in MongoDB
3. **Returning user works**: close browser, reopen, chat history intact
4. **Different node works**: connect to Node B, see data from Node A
5. **Project resume works**: clone from GitHub, continue building
6. **EC2 failover works**: kill one EC2, everything routes to the other
7. **Zero 503s**: no "thread store not initialized" or "project store not available" from untrusted nodes
