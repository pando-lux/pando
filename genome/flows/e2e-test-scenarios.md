# Pando — Comprehensive E2E Test Scenarios

> **Purpose:** Human-readable QA test scripts for verifying all layers and modes of the Pando network.
> Written against the architecture defined in `genome/foundation/the-stack.md` and the live 5-node network.
> Use this after any v2.x code change to verify nothing broke.
>
> **Last updated:** 2026-02-26 (v2 sprint)
>
> **See also:** `genome/flows/human-e2e-test.md` — legacy focused on app-build flow only.

---

## Node Reference

| Node | IP | API Port | Trust Level | StorageBackend | Notes |
|---|---|---|---|---|---|
| EC2-1 | 54.82.241.132 | 4000 | Trusted compute | MongoDB | Master key, systemd |
| EC2-2 | 34.201.82.126 | 4000 | Trusted compute | MongoDB | Master key, systemd |
| LS-1 | 54.145.144.221 | 4000 | Untrusted relay | P2P proxy | PM2, no MongoDB |
| LS-2 | 3.237.175.38 | 4000 | Untrusted | P2P proxy | PM2, no MongoDB |
| Windows | 100.87.67.78 | 4100 | Dev trusted | MongoDB | Manual start |

**API Token (all nodes):** `bd5b00bab232c33c259c2603a9991925287cf43fb1f9519c4f00c04501532127`

**SSH key:** `/c/Users/jaira/.ssh/prax-lightsail-key.pem`

**Convenience alias (use in commands below):**
```bash
TOKEN="bd5b00bab232c33c259c2603a9991925287cf43fb1f9519c4f00c04501532127"
EC21="http://54.82.241.132:4000"
EC22="http://34.201.82.126:4000"
LS1="http://54.145.144.221:4000"
LS2="http://3.237.175.38:4000"
WIN="http://100.87.67.78:4100"
```

---

## Layer 0 — Kernel Scenarios

> Layer 0 must work even if Layers 1 and 2 are completely broken. If any of these fail, nothing else matters.

---

### Scenario 1: Identity — Node Starts and Creates Identity

**Layer:** 0
**Mode Required:** 1 (local only)
**Nodes Required:** Any single node (test on Windows or LS-1)
**Setup:** Fresh `~/.pando/` directory (or use `--data-dir /tmp/test-node`)

**Steps:**
1. Start node: `node packages/node/dist/cli.js --port 4101 --api-port 4101 --data-dir /tmp/pando-test1`
2. Wait for "Node started" in logs
3. Run: `curl http://localhost:4101/status`
4. Check: `ls /tmp/pando-test1/identities/` or `cat /tmp/pando-test1/identity.json`
5. Stop node (Ctrl+C)
6. Restart same node with same `--data-dir`
7. Run: `curl http://localhost:4101/status`
8. Compare peerId from step 3 vs step 7

**Expected:**
- Step 3: Returns JSON with `peerId` field (Ed25519 peer ID)
- Step 4: Identity file exists, contains `{ id, privKey, pubKey }` (or encrypted equivalent)
- Step 7: Returns JSON with SAME `peerId` — identity loaded from disk, not regenerated
- Step 8: peerId is identical across restarts

**Failure Indicators:**
- peerId changes on restart — identity not persisted
- No identity file created — storage write failed
- `/status` errors — node not fully started
- `crypto` errors in logs — Ed25519 key gen failure

**Automated:** Yes — compare peerId from two `/status` calls before/after restart

---

### Scenario 2: Identity — Encrypted Identity with Password

**Layer:** 0
**Mode Required:** 1
**Nodes Required:** Any
**Setup:** Fresh data dir

**Steps:**
1. Start TUI: `node packages/node/dist/tui.js --data-dir /tmp/pando-enc-test`
2. When prompted for new identity: enter password "TestPass123"
3. Verify node starts: `/status` shows peerId
4. Note the peerId
5. Stop TUI (`/quit`)
6. Restart TUI with same data dir
7. Enter correct password when prompted
8. Verify same peerId
9. Stop and restart again — enter WRONG password
10. Verify: startup fails or errors clearly

**Expected:**
- Restart with correct password: same peerId, node starts
- Restart with wrong password: fails with "decryption failed" or similar — does NOT start with garbage identity
- Identity file in data dir is NOT plaintext (contains encrypted blob)

**Failure Indicators:**
- Node starts with wrong password (accepts any input)
- Identity file contains unencrypted private key
- Different peerId after correct password entry

**Automated:** Partial (TUI interaction requires human for password prompt)

---

### Scenario 3: Ledger — Check Balance

**Layer:** 0
**Mode Required:** 1
**Nodes Required:** Any (test on EC2-1 which has established balance)

**Steps:**
1. `curl -H "Authorization: Bearer $TOKEN" $EC21/balance`
2. Note the balance
3. `curl -H "Authorization: Bearer $TOKEN" $EC21/balance?peerId=<EC2-1-peerId>`
4. Verify same balance as step 2

**Expected:**
- Returns `{ peerId, balance, account }` JSON
- Balance is a non-negative number
- Balance is consistent whether queried with or without explicit peerId

**Failure Indicators:**
- 500 error (ledger DB not open)
- Balance returns null or undefined
- Different values for same peer on same call

**Automated:** Yes

---

### Scenario 4: Ledger — Transfer Between Two Nodes

**Layer:** 0
**Mode Required:** 2 (P2P)
**Nodes Required:** EC2-1 + EC2-2
**Setup:** Both nodes online and peered. EC2-1 has > 10 Lux.

**Steps:**
1. Record initial balances:
   ```bash
   curl -s $EC21/balance | python3 -m json.tool
   curl -s $EC22/balance | python3 -m json.tool
   ```
2. Get EC2-2 peerId: `curl -s $EC22/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['peerId'])"`
3. Transfer 5 Lux from EC2-1 to EC2-2:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"to":"<EC2-2-peerId>","amount":5}' $EC21/transfer
   ```
4. Wait 5 seconds for P2P sync
5. Check EC2-1 balance — should be 5 less
6. Check EC2-2 balance — should be 5 more (minus relay fee if applicable)
7. Check EC2-1's ledger shows the transaction in history

**Expected:**
- EC2-1 balance decreases by 5 (plus ~0.005 relay fee)
- EC2-2 balance increases by ~4.995 (minus 0.1% relay fee)
- Transaction appears in ledger history with correct timestamp and parties
- GossipSub propagated the transaction to all connected peers

**Failure Indicators:**
- Balance unchanged (transfer silently failed)
- Transfer rejected with insufficient funds error when balance is adequate
- Balance changed on EC2-1 but not EC2-2 (sync failure)
- Transfer accepted but not written to SQLite

**Automated:** Yes

---

### Scenario 5: Ledger — Sync Across 3+ Nodes

**Layer:** 0
**Mode Required:** 2
**Nodes Required:** EC2-1, LS-1, Windows
**Setup:** All 3 nodes online and connected

**Steps:**
1. Get starting balances on all 3 nodes for EC2-1's peerId:
   ```bash
   EC21_PEER=$(curl -s $EC21/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['peerId'])")
   curl -s "$EC21/balance?peerId=$EC21_PEER"
   curl -s "$LS1/balance?peerId=$EC21_PEER"
   curl -s "$WIN/balance?peerId=$EC21_PEER"
   ```
2. Make a transfer from EC2-1 to EC2-2 (5 Lux as in Scenario 4)
3. Wait 10 seconds
4. Query EC2-1's balance from all 3 nodes again
5. All 3 should show the same decreased balance

**Expected:**
- All 3 nodes converge on the same balance within 10 seconds
- No node is "stale" (shows old balance)
- GossipSub TRANSACTION events visible in logs of receiving nodes

**Failure Indicators:**
- Nodes show different balances 30+ seconds after transfer
- LS-1 or Windows doesn't receive the sync event
- Balances diverge permanently (fork in ledger state)

**Automated:** Yes

---

### Scenario 6: P2P — Two Nodes Discover Each Other (mDNS)

**Layer:** 0
**Mode Required:** 2
**Nodes Required:** Two local machines (or two processes on same LAN)
**Setup:** No bootstrap flag — relying on mDNS local discovery

**Steps:**
1. Start Node A on port 4200: `node packages/node/dist/cli.js --port 4200 --api-port 4200 --data-dir /tmp/pando-a`
2. Start Node B on port 4201: `node packages/node/dist/cli.js --port 4201 --api-port 4201 --data-dir /tmp/pando-b`
3. Wait 30 seconds for mDNS discovery
4. Check Node A's peers: `curl http://localhost:4200/peers`
5. Check Node B's peers: `curl http://localhost:4201/peers`

**Expected:**
- Within 30 seconds, Node A shows Node B in peers list
- Node B shows Node A in peers list
- Both sides have each other's peerId and multiaddr

**Failure Indicators:**
- Peers list empty after 60 seconds
- mDNS packets visible in network capture but connection rejected
- Noise handshake errors in logs

**Automated:** Yes (local two-process test)

---

### Scenario 7: P2P — Bootstrap Connection

**Layer:** 0
**Mode Required:** 2
**Nodes Required:** Local node + LS-1 (bootstrap)
**Setup:** Local dev node not yet on the network

**Steps:**
1. Get LS-1's multiaddr: `curl $LS1/onboard | python3 -m json.tool` — note the bootstrap line
2. Start local node with explicit bootstrap:
   ```bash
   node packages/node/dist/cli.js --port 4300 --api-port 4300 \
     --bootstrap /ip4/54.145.144.221/tcp/4001/p2p/<LS1-peerId> \
     --data-dir /tmp/pando-bootstrap-test
   ```
3. Wait 15 seconds
4. `curl http://localhost:4300/peers`
5. `curl http://localhost:4300/status`

**Expected:**
- LS-1 appears in peers within 15 seconds
- Status shows `peers: 1+`
- Possible: additional peers discovered via KadDHT from LS-1's peer table

**Failure Indicators:**
- Peers empty after 30 seconds
- TCP connection timeout (network issue vs code issue)
- Noise handshake failure (protocol mismatch)

**Automated:** Yes

---

### Scenario 8: Governance — Create Proposal and Vote

**Layer:** 0
**Mode Required:** 2 (needs P2P for vote propagation)
**Nodes Required:** EC2-1 + EC2-2 + Windows (3 voters for quorum test)
**Setup:** Node running governance, EC2-1 has 10+ Lux (stake requirement)

**Steps:**
1. Check EC2-1 balance ≥ 10 Lux (required to propose):
   `curl -s $EC21/balance | python3 -c "import sys,json; print(json.load(sys.stdin)['balance'])"`
2. Create a test proposal on EC2-1:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"title":"Test proposal for E2E","description":"Verifying governance works correctly","type":"standard"}' \
     $EC21/governance/proposals
   ```
3. Note the proposal ID from the response
4. Wait 10 seconds for P2P propagation
5. Check proposal appears on EC2-2: `curl -s $EC22/governance/proposals | python3 -m json.tool`
6. Vote YES from EC2-2:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"vote":"approve"}' $EC22/governance/proposals/<id>/vote
   ```
7. Vote YES from Windows:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"vote":"approve"}' $WIN/governance/proposals/<id>/vote
   ```
8. Check proposal status — should show vote counts
9. Wait for quorum or voting window

**Expected:**
- Proposal created on EC2-1 with unique ID
- Proposal propagates to all peers via GossipSub within 15 seconds
- Votes from EC2-2 and Windows are accepted and counted
- Vote counts visible on any node querying the proposal
- If quorum reached: proposal moves to `approved` state

**Failure Indicators:**
- 403 on proposal creation (insufficient Lux stake)
- Proposal not visible on EC2-2 after 30 seconds (GossipSub failure)
- Votes rejected with "already voted" even for different peers
- Quorum logic incorrect (51% of active nodes, not just votes cast)

**Automated:** Yes

---

### Scenario 9: HealthMonitor — Start Node, Check /monitor/status

**Layer:** 0
**Mode Required:** 1
**Nodes Required:** Any (EC2-1 recommended — established uptime metrics)

**Steps:**
1. `curl -s $EC21/monitor/status | python3 -m json.tool`
2. Verify response structure
3. Check `curl -s $EC21/monitor/alerts`
4. Start a fresh local node and wait 2 minutes
5. `curl http://localhost:4000/monitor/status` on fresh node

**Expected:**
- `/monitor/status` returns:
  ```json
  {
    "uptime": <seconds>,
    "peers": <count>,
    "memory": { "used": ..., "total": ... },
    "cpu": ...,
    "ledger": { "transactions": ..., "accounts": ... },
    "agents": { "active": ..., "total": ... },
    "alerts": []
  }
  ```
- All fields present (no undefined)
- Fresh node shows 0 active agents, empty alerts
- Uptime increases on subsequent calls

**Failure Indicators:**
- 404 (monitor not wired up)
- 500 (monitor threw exception during metrics collection)
- Metrics show `-1` or `null` for numeric values
- Memory or CPU values physically impossible (e.g., >100% CPU on a single core)

**Automated:** Yes

---

### Scenario 10: Guardrails — Protected Path Write Blocked

**Layer:** 0
**Mode Required:** 1
**Nodes Required:** Any local node
**Setup:** Node running with guardrails enabled

**Steps:**
1. Attempt to write to a protected path via API:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"path":"~/.pando/identity.json","content":"hacked"}' \
     http://localhost:4000/local/file
   ```
2. Attempt pipeline to write to node source:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"path":"/opt/pando/packages/node/src/index.js","content":"// hacked"}' \
     http://localhost:4000/local/file
   ```
3. Check guardrails log: `curl -s $EC21/monitor/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('guardrails',{}))"`
4. Verify: identity file unchanged after step 1

**Expected:**
- Both POST calls return 403 Forbidden
- Response includes `{ error: "Protected path", path: "..." }`
- Identity file content unchanged
- Guardrails logs the attempt (security audit trail)
- Rate limiter does NOT ban the IP for these blocked attempts (they're expected)

**Failure Indicators:**
- 200 OK response (write succeeded)
- 404 (endpoint not found — guardrails not checking this path)
- Identity file modified
- No log entry for the blocked attempt

**Automated:** Yes

---

### Scenario 11: Emission — Uptime Epoch Fires, Lux Minted

**Layer:** 0
**Mode Required:** 2 (witnesses needed)
**Nodes Required:** EC2-1 + EC2-2 + LS-1 (3+ peers for witness quorum)
**Setup:** All nodes running and peered. Wait for a full 10-minute epoch.

**Steps:**
1. Note EC2-1 balance at time T:
   `curl -s $EC21/balance | python3 -c "import sys,json; print(json.load(sys.stdin)['balance'])"`
2. Note timestamp
3. Wait 10+ minutes (one uptime epoch)
4. Check EC2-1 balance again
5. Check emission log: `curl -s $EC21/monitor/status` — look for emission events
6. Check that emission required 2+ witnesses: look for `emission-witness` events in logs

**Expected:**
- Balance increases by ~0.05 Lux (or 0.25 with 5x early multiplier if account < 100)
- Emission happens once per 10-minute epoch (not more frequent)
- Witness signatures present in the emission record
- If node has < 3 connected peers, bootstrap fallback emission used

**Failure Indicators:**
- Balance unchanged after 10+ minutes (emission not firing)
- Balance increases by wrong amount (emission multiplier wrong)
- Emission fires multiple times in same epoch (double-mint bug)
- Emission fires with 0 witnesses (bypass of witness requirement)

**Automated:** Yes (scripted wait + balance comparison)

---

## Layer 1 — Core Scenarios

> Layer 1 requires Layer 0 healthy. Test these only after all Layer 0 scenarios pass.

---

### Scenario 12: Agent Spawn — POST /agents/spawn

**Layer:** 1
**Mode Required:** 2
**Nodes Required:** Windows (has Claude Code available)
**Setup:** Node running, Claude Code installed, agent system initialized

**Steps:**
1. Spawn a test builder agent:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{
       "role": "builder",
       "context": "Test agent spawn — verify workspace created and agent starts",
       "parentId": null
     }' $WIN/agents/spawn | python3 -m json.tool
   ```
2. Note the `agentId` from response
3. Check agent tree: `curl -s -H "Authorization: Bearer $TOKEN" $WIN/agents/tree`
4. Verify agent workspace created: `ls ~/.pando/agents/<agentId>/`
5. Check agent status: `curl -s -H "Authorization: Bearer $TOKEN" $WIN/agents/<agentId>/status`
6. Wait 30 seconds
7. Check agent status again — should show IDLE or WORKING (not ERROR)

**Expected:**
- Response includes `{ agentId, status: "starting" }` or similar
- Agent appears in `/agents/tree` within 10 seconds
- Workspace directory created at `~/.pando/agents/<agentId>/`
- Workspace contains: `state.json`, `CLAUDE.md` (template injected)
- Agent status: IDLE (if no task assigned) or WORKING (if task given)

**Failure Indicators:**
- Spawn returns 500 (agent system not initialized)
- agentId missing from response
- Workspace not created
- Agent never appears in tree (spawn failed silently)
- Agent goes to ERROR state immediately (template injection failed)

**Automated:** Yes

---

### Scenario 13: Agent Resume — Restart Node, In-Progress Agents Resume

**Layer:** 1
**Mode Required:** 2
**Nodes Required:** Windows
**Setup:** Scenario 12 completed — a spawned agent exists with a task

**Steps:**
1. Create agent and assign task (or use agent from Scenario 12):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"message": "Write a hello world function in TypeScript and save it to hello.ts"}' \
     $WIN/agents/<agentId>/message
   ```
2. Wait 30 seconds — verify agent is WORKING
3. Note the agent sessionId from status: `curl -H "Authorization: Bearer $TOKEN" $WIN/agents/<agentId>/status`
4. Restart the node (stop + start)
5. After restart, check agent tree: `curl -H "Authorization: Bearer $TOKEN" $WIN/agents/tree`
6. Check agent status — should show WORKING or IDLE (not MISSING)
7. Verify agent resumes with same sessionId (`--continue --resume <sessionId>`)

**Expected:**
- Agent appears in tree after node restart
- Status is WORKING or IDLE (not MISSING/ERROR)
- If agent was mid-task, it resumes (Claude Code `--continue` flag)
- Agent's state.json persisted across restart (task context not lost)

**Failure Indicators:**
- Agent missing from tree after restart (not persisted)
- Agent shows ERROR after restart (resume failed)
- Agent spawned fresh (lost task context) instead of resuming
- Two instances of same agent running simultaneously

**Automated:** Yes

---

### Scenario 14: Agent Message — Verify Agent Processes Message

**Layer:** 1
**Mode Required:** 2
**Nodes Required:** Windows
**Setup:** Agent spawned and IDLE

**Steps:**
1. Spawn fresh agent (from Scenario 12)
2. Send message:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"message": "Reply with exactly: RECEIVED-HELLO-FROM-TEST"}' \
     $WIN/agents/<agentId>/message
   ```
3. Wait 60 seconds (Claude Code response time)
4. Check agent status for response in output
5. Check bridge queue for response event: look in agent logs or bridge events
6. Check chat history for the project (if project-scoped): `curl -H "Authorization: Bearer $TOKEN" $WIN/chat/history`

**Expected:**
- Message accepted: returns `{ queued: true }` or `{ success: true }`
- Agent transitions to WORKING within 10 seconds
- Agent processes message (Claude Code session runs)
- Agent sends response back via bridge
- Response contains "RECEIVED-HELLO-FROM-TEST" or similar

**Failure Indicators:**
- Message rejected immediately (bridge queue full or agent not found)
- Agent status stays IDLE after 30 seconds (message not dequeued)
- Agent transitions to WORKING but no output generated (Claude crash)
- Bridge event never fires (agent completed but response not delivered)

**Automated:** Partial (depends on Claude Code being available)

---

### Scenario 15: Storage — MongoDB Path (Direct)

**Layer:** 1
**Mode Required:** 3 (needs MongoDB)
**Nodes Required:** EC2-1 (has MongoDB directly)
**Setup:** EC2-1 running with PANDO_STORAGE_URL set

**Steps:**
1. Verify EC2-1 is using MongoDB backend: `curl -s $EC21/capabilities | python3 -m json.tool` — look for `storageBackend: "mongodb"`
2. Create a thread:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"title":"E2E Test Thread","userId":"test-user-e2e"}' \
     $EC21/threads | python3 -m json.tool
   ```
3. Note `threadId`
4. Add a message:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"content":"Test message from E2E","role":"user"}' \
     $EC21/threads/<threadId>/messages
   ```
5. Read it back: `curl -s $EC21/threads/<threadId>/messages`
6. Restart EC2-1 node (via SSH: `sudo systemctl restart pando-node`)
7. Wait 30 seconds for restart
8. Read thread again: `curl -s $EC21/threads/<threadId>/messages`

**Expected:**
- Thread created with ID
- Message stored
- Message readable immediately
- After restart: thread and message still present (durable in MongoDB, not RAM)

**Failure Indicators:**
- Thread creation 500 (MongoDB connection failed)
- Message stored but missing after restart (stored in memory only)
- Thread readable but messages missing (messages not persisted)
- Thread not found after restart (MongoDB write was not flushed)

**Automated:** Yes

---

### Scenario 16: Storage — P2P Proxy Path (Untrusted Node)

**Layer:** 1
**Mode Required:** 2 + 3
**Nodes Required:** LS-1 (untrusted) + EC2-1 (trusted, MongoDB)
**Setup:** Both nodes online and peered. LS-1 has no MongoDB.

**Steps:**
1. Verify LS-1 is using P2P backend: `curl -s $LS1/capabilities | python3 -m json.tool` — look for `storageBackend: "p2p"`
2. Create a thread from LS-1 (it should proxy to EC2-1):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"title":"P2P Proxy Test Thread","userId":"test-user-p2p"}' \
     $LS1/threads | python3 -m json.tool
   ```
3. Note `threadId` from response
4. Read thread from LS-1: `curl -s $LS1/threads/<threadId>`
5. Read thread directly from EC2-1: `curl -s $EC21/threads/<threadId>`
6. Add message from LS-1:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"content":"Written via P2P proxy","role":"user"}' \
     $LS1/threads/<threadId>/messages
   ```
7. Read messages from EC2-1: `curl -s $EC21/threads/<threadId>/messages`

**Expected:**
- Thread creation from LS-1 returns success (proxied to EC2-1)
- Thread readable from both LS-1 and EC2-1
- Message written via LS-1 is readable on EC2-1 (proxy write actually hit MongoDB)
- Response time slightly higher from LS-1 (P2P round-trip overhead)

**Failure Indicators:**
- 503 from LS-1 (no storage backend available — P2P storage not working)
- Thread created on LS-1 but not on EC2-1 (proxy write silently dropped)
- Thread readable on LS-1 but 404 on EC2-1 (LS-1 using local cache only, not proxying)
- Timeout (P2P proxy request > 30s)

**Automated:** Yes

---

### Scenario 17: Deploy Tier 1 — Static Site via S3

**Layer:** 1
**Mode Required:** 3
**Nodes Required:** LS-1 (initiator) + EC2-1 (compute for S3 upload)
**Setup:** Both nodes online. EC2-1 has AWS credentials contributed. GitHub PAT available.

**Steps:**
1. Create a test project (or use existing). If creating:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"E2E Tier 1 Test","repoUrl":"https://github.com/pando-lux/pando","tier":1}' \
     $LS1/projects | python3 -m json.tool
   ```
2. Note `projectId`
3. Trigger deploy from LS-1:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"repoUrl":"https://github.com/pando-lux/pando","branch":"main"}' \
     $LS1/projects/<projectId>/deploy | python3 -m json.tool
   ```
4. Check response for `url` field
5. HTTP GET the returned S3 URL
6. Verify response is HTML (200 OK)

**Expected:**
- Deploy request proxied from LS-1 to EC2-1 via P2P CapabilityProfile discovery
- EC2-1 handles: git clone → build → S3 upload
- Response includes `{ url: "http://pando-deployments.s3-website-us-east-1.amazonaws.com/public/<projectId>/..." }`
- S3 URL returns 200 with HTML content

**Failure Indicators:**
- 503 from LS-1 (no compute peer with storageBackend=mongodb found)
- Deploy hangs > 5 minutes (git clone or S3 upload stalled)
- S3 URL returns 403 (bucket not public) or 404 (upload failed)
- EC2-1 returns error (AWS credentials not found via resource proxy)

**Automated:** Yes

---

### Scenario 18: Deploy Tier 2 — Dynamic App via EC2/PM2

**Layer:** 1
**Mode Required:** 3
**Nodes Required:** LS-1 + EC2-1
**Setup:** EC2-1 running with nginx and PM2 configured

**Steps:**
1. Create project with tier 2 (or auto-detected):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"E2E Tier 2 Test","tier":2}' \
     $LS1/projects | python3 -m json.tool
   ```
2. Trigger deploy with a server-based repo (or any repo with start script):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"repoUrl":"https://github.com/pando-lux/pando","branch":"main"}' \
     $LS1/projects/<projectId>/deploy | python3 -m json.tool
   ```
3. Check for Tier 2 response: `{ url: "http://54.82.241.132/apps/<projectId>/", tier: 2 }`
4. HTTP GET the returned URL
5. Verify 200 response
6. SSH to EC2-1: `pm2 list` — verify app is running
7. Check nginx config: `ls /etc/nginx/pando-apps/`

**Expected:**
- Deploy returns `publicAddress`-based URL (`http://54.82.241.132/apps/<projectId>/`)
- URL serves content (200 OK)
- PM2 shows app running on EC2-1
- nginx reverse proxy config file exists for this projectId
- `detectedTier` in response matches `tier: 2`

**Failure Indicators:**
- URL returns 502 Bad Gateway (PM2 process not running or crashing)
- URL returns 404 (nginx not configured)
- Deploy hangs > 10 minutes
- PM2 entry missing from `pm2 list` (deploy didn't register process)

**Automated:** Yes (URL check automated; PM2 SSH check manual)

---

### Scenario 19: Undeploy — Tier 2 App Removed

**Layer:** 1
**Mode Required:** 3
**Nodes Required:** LS-1 + EC2-1
**Setup:** Scenario 18 completed — a Tier 2 app is running

**Steps:**
1. Confirm app is running: `curl -s http://54.82.241.132/apps/<projectId>/` — expect 200
2. Undeploy from LS-1:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" $LS1/projects/<projectId>/undeploy
   ```
3. Wait 10 seconds
4. Check URL: `curl -s http://54.82.241.132/apps/<projectId>/` — expect 404
5. SSH to EC2-1: `pm2 list` — app should be gone
6. Check nginx: `ls /etc/nginx/pando-apps/<projectId>.conf` — file should not exist
7. Check project record: `curl -s $LS1/projects/<projectId>` — `deployPeerId` should be null/empty

**Expected:**
- After undeploy: URL returns 404 (nginx conf removed + reloaded)
- PM2 no longer shows the app
- nginx config file deleted
- Port registry entry cleared
- Project record: `deployPeerId` cleared

**Failure Indicators:**
- URL still returns 200 after undeploy (nginx not reloaded)
- PM2 still shows app as running
- Undeploy returns 500 (error cleaning up)
- Port never freed (port registry not updated)

**Automated:** Yes

---

### Scenario 20: Auth JWT — Login, Get JWT, Use on Another Node

**Layer:** 1
**Mode Required:** 2
**Nodes Required:** EC2-1 (issue JWT) + EC2-2 (verify JWT)
**Setup:** User account exists (pando / KalaJi99@)

**Steps:**
1. Login on EC2-1:
   ```bash
   curl -s -X POST -H "Content-Type: application/json" \
     -d '{"username":"pando","password":"KalaJi99@"}' \
     $EC21/auth/login | python3 -m json.tool
   ```
2. Note `token` field from response
3. Verify token on EC2-1: `curl -s -H "Authorization: Bearer <token>" $EC21/status`
4. Use same token on EC2-2: `curl -s -H "Authorization: Bearer <token>" $EC22/status`
5. Verify EC2-2 accepts the token issued by EC2-1
6. Try a clearly invalid token: `curl -s -H "Authorization: Bearer INVALID-TOKEN" $EC21/status`
7. Try an expired token (manipulate `exp` field): should fail verification

**Expected:**
- EC2-1 issues valid JWT signed with its Ed25519 private key
- EC2-2 accepts JWT from EC2-1 (extracts public key from `iss` peerId)
- Both nodes return 200 with full status for valid token
- Invalid token: 401 Unauthorized
- JWT does NOT require database lookup on verifying node (stateless)

**Failure Indicators:**
- EC2-2 rejects token issued by EC2-1 (cross-node auth still broken)
- 401 even with valid token from same node
- Any node accepts invalid token (signature check bypassed)
- Token contains sensitive data (private key, password)

**Automated:** Yes

---

### Scenario 21: Upgrade Protocol — POST /upgrade Triggers git pull + build + restart

**Layer:** 1
**Mode Required:** 3 (needs GitHub access)
**Nodes Required:** LS-1 (safest to test — restarts via PM2, not systemd)
**Setup:** Current code on main branch. A test commit exists at HEAD.

**Steps:**
1. Record current version: `curl -s $LS1/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('version','?'))"`
2. Trigger upgrade:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"commitHash":"HEAD","repoUrl":"https://github.com/pando-lux/pando"}' \
     $LS1/upgrade
   ```
3. Watch logs or wait 3-5 minutes
4. `curl -s $LS1/status` — should return eventually (after restart)
5. Check new version matches the commit hash

**Expected:**
- Upgrade triggers: git pull → hash verify → npm run build → restart
- Node goes offline briefly during restart
- Node comes back online (PM2 restarts it)
- `/status` returns with potentially updated version

**Failure Indicators:**
- Upgrade returns error immediately (git pull failed)
- Build fails (compilation error in current code)
- Node doesn't come back online (restart failure)
- Node comes back but with old code (git pull didn't apply)

**Automated:** Partial (restart detection requires polling)

---

## Layer 2 — Platform Scenarios

> Layer 2 requires Layer 0 + 1 healthy. Test these after all Layer 1 scenarios pass.

---

### Scenario 22: Scheduler — Submit Task, Verify Queue + Dequeue + Complete

**Layer:** 2
**Mode Required:** 2
**Nodes Required:** Windows (has scheduler running)
**Setup:** Scheduler started with node, Claude Code available for task execution

**Steps:**
1. Check scheduler status: `curl -s -H "Authorization: Bearer $TOKEN" $WIN/scheduler/status`
2. Create a task:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{
       "title": "E2E Scheduler Test",
       "description": "Write the word SCHEDULER-TEST-COMPLETE to a file and report done",
       "priority": "normal",
       "createdBy": "e2e-test"
     }' $WIN/tasks | python3 -m json.tool
   ```
3. Note `taskId`
4. Approve the task: `curl -s -X POST -H "Authorization: Bearer $TOKEN" $WIN/tasks/<taskId>/approve`
5. Watch task status: poll `curl -s -H "Authorization: Bearer $TOKEN" $WIN/tasks/<taskId>` every 30s
6. Wait for status to reach `completed`

**Expected:**
- Task created with status `pending`
- After approve: status moves to `queued`
- Scheduler dequeues and assigns to executor
- Task completes with status `completed`
- Task completion earns 5 Lux (check balance)

**Failure Indicators:**
- Task stuck in `queued` > 5 minutes (scheduler not picking it up)
- Task goes to `failed` (executor crashed)
- Lux not emitted after completion (emission not triggered)
- Task ID not found after creation (persistence failure)

**Automated:** Yes

---

### Scenario 23: Resource Contribute — OpenAI Key

**Layer:** 2
**Mode Required:** 2
**Nodes Required:** Windows (has credential store)
**Setup:** OpenAI API key available

**Steps:**
1. Check current resources: `curl -s -H "Authorization: Bearer $TOKEN" $WIN/resources`
2. Contribute OpenAI key (if not already contributed):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"type":"openai","key":"sk-..."}' \
     $WIN/resources/contribute | python3 -m json.tool
   ```
3. Note `resourceId`
4. Check resources again: `curl -s -H "Authorization: Bearer $TOKEN" $WIN/resources`
5. Verify resource appears with `type: "openai"` (key itself NOT in response)
6. Check resource appears on peer node: `curl -s $EC21/resources`

**Expected:**
- Resource created with unique ID
- `/resources` shows resource with type, id, contributed timestamp — NOT the raw key
- Resource propagates to peers via P2P (visible on EC2-1 within 30s)
- Contributor earns 2 Lux (check balance)

**Failure Indicators:**
- Resource shows raw key in API response (security violation)
- Resource not visible on other nodes (P2P sync not working)
- Lux not emitted to contributor
- Duplicate resource allowed (same key contributed twice)

**Automated:** Yes (minus having the actual key)

---

### Scenario 24: Resource Search — AI Query via Contributed Key

**Layer:** 2
**Mode Required:** 3
**Nodes Required:** EC2-1 (has credentials) + LS-1 (initiating from untrusted)
**Setup:** OpenAI key contributed and synced to EC2-1

**Steps:**
1. POST a search from LS-1 (untrusted node, no direct key access):
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"query":"What is the capital of France? Answer in exactly 3 words.","tier":"simple"}' \
     $LS1/search | python3 -m json.tool
   ```
2. Verify response is AI-generated (not a canned response)
3. Check response includes backend information

**Expected:**
- Response returns within 30 seconds
- Response contains meaningful answer ("Paris is it" or similar 3-word answer)
- Response metadata shows which backend/resource was used
- LS-1 did NOT need direct access to the API key (routed via EC2-1)

**Failure Indicators:**
- Timeout (resource routing to EC2-1 failing)
- Canned response / error response (AI not called)
- 503 (no AI resource found on network)
- Credential leaked in response

**Automated:** Yes

---

### Scenario 25: Content Publish — GossipSub Propagation

**Layer:** 2
**Mode Required:** 2
**Nodes Required:** EC2-1 (publisher) + LS-1 (subscriber)
**Setup:** Both nodes online and connected via GossipSub

**Steps:**
1. Publish content from EC2-1:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{
       "title": "E2E Test Content",
       "body": "This is a test content publish for E2E verification",
       "tags": ["e2e", "test"],
       "type": "article"
     }' $EC21/content/publish | python3 -m json.tool
   ```
2. Note `contentId`
3. Wait 15 seconds for GossipSub propagation
4. Search for content on LS-1: `curl -s "$LS1/content/search?q=E2E+Test+Content"`
5. Verify content found on LS-1
6. Retrieve full content from LS-1: `curl -s $LS1/content/<contentId>`

**Expected:**
- Content published with ID on EC2-1
- Content appears in LS-1's content registry within 15 seconds
- Content search on LS-1 returns the published content
- Content body retrieved correctly from LS-1

**Failure Indicators:**
- Content not visible on LS-1 after 30 seconds (GossipSub not propagating)
- Search returns no results (FTS5 indexing not working on LS-1)
- Content body missing from LS-1 (metadata synced but body not)
- ContentRegistry throws during publish

**Automated:** Yes

---

### Scenario 26: Content Search — Results from Multiple Nodes

**Layer:** 2
**Mode Required:** 2
**Nodes Required:** EC2-1 + EC2-2 + LS-1 (all publishing content)
**Setup:** Multiple nodes have published distinct content

**Steps:**
1. Publish unique content from EC2-1: `{"title": "Content-From-EC21"}`
2. Publish unique content from EC2-2: `{"title": "Content-From-EC22"}`
3. Wait 30 seconds
4. Search from LS-1: `curl -s "$LS1/content/search?q=Content-From"`
5. Verify results include content from BOTH EC2-1 and EC2-2

**Expected:**
- Search from LS-1 returns content published by EC2-1 AND EC2-2
- Results include source nodeId or origin
- Full-text search matches partial strings

**Failure Indicators:**
- Only returns content published by LS-1 itself (not syncing from peers)
- Returns content from one EC2 but not the other (partial sync)
- Content Registry FTS5 search not working

**Automated:** Yes

---

### Scenario 27: Project CRUD — Create, Add Files, Retrieve, Delete

**Layer:** 2
**Mode Required:** 3 (needs storage backend)
**Nodes Required:** EC2-1
**Setup:** EC2-1 running with MongoDB backend

**Steps:**
1. Create project:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"E2E CRUD Test Project","description":"Testing project CRUD","userId":"e2e-user"}' \
     $EC21/projects | python3 -m json.tool
   ```
2. Note `projectId`
3. List projects: `curl -s -H "Authorization: Bearer $TOKEN" $EC21/projects` — verify project appears
4. Get project: `curl -s $EC21/projects/<projectId>` — verify details correct
5. Update project: add a description field
6. Delete project: `curl -s -X DELETE -H "Authorization: Bearer $TOKEN" $EC21/projects/<projectId>`
7. Verify deleted: `curl -s $EC21/projects/<projectId>` — expect 404

**Expected:**
- Create returns project with ID and timestamps
- List includes the new project
- Get returns full project details
- Update persists changes
- Delete returns success
- Post-delete GET returns 404

**Failure Indicators:**
- Create returns 500 (MongoDB write failed)
- Project missing from list after create (cache not refreshed)
- Delete returns 200 but project still accessible (soft delete bug)
- Project survives node restart only if in MongoDB (SQLite cache OK)

**Automated:** Yes

---

### Scenario 28: Chat — POST /chat/message, Manager Agent Responds

**Layer:** 2
**Mode Required:** 2 + 3
**Nodes Required:** Windows (has Claude Code + MongoDB)
**Setup:** Manager agent initialized, Claude Code available, valid user session

**Steps:**
1. Get auth token (login or use existing session)
2. Send chat message:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"message":"Hello! Please reply with exactly: CHAT-TEST-OK"}' \
     $WIN/chat/message | python3 -m json.tool
   ```
3. Note `messageId` and `threadId`
4. Wait 2-3 minutes (manager agent response time)
5. Check chat history: `curl -s -H "Authorization: Bearer $TOKEN" $WIN/chat/history`
6. Verify response from manager appears in history

**Expected:**
- Message accepted immediately with `{ success: true, messageId, threadId }`
- Manager agent receives message via bridge queue
- Agent processes and responds within 3 minutes
- Response "CHAT-TEST-OK" (or similar) appears in chat history
- History shows: user message → agent response in correct order

**Failure Indicators:**
- Message rejected immediately (manager not initialized)
- No response after 5 minutes (agent stuck or bridge not delivering)
- Response appears but in wrong thread
- Chat history API returns empty even though agent responded (history not persisted)

**Automated:** Partial (timing-dependent on Claude Code response)

---

## Degraded Mode Scenarios

> These verify that the architecture's graceful degradation rules hold. Most critical for production reliability.

---

### Scenario 29: Mode 1 (Offline) — Disconnect Network, Node Still Works

**Layer:** 0
**Mode Required:** 1 (offline)
**Nodes Required:** Local dev node
**Setup:** Local node running, then network adapter disabled

**Steps:**
1. Start local node: verify `/status` works and shows peers
2. Disconnect network adapter (or block outbound traffic with firewall)
3. Wait 30 seconds for peer connections to drop
4. `curl http://localhost:4000/status` — should still respond
5. Check identity: `curl http://localhost:4000/balance` — should return local balance
6. Check ledger: should return cached data
7. Try to read a thread (if any): cached SQLite data should still work
8. Reconnect network adapter
9. Wait 30 seconds for peer reconnection
10. Verify peers reconnected: `curl http://localhost:4000/peers`

**Expected:**
- Node responds to `/status` even with 0 peers (network disconnected)
- Identity and balance readable (SQLite ledger)
- Ledger READ operations work (local SQLite data)
- Ledger WRITE operations (transfer) fail gracefully: `{ error: "No peers for transfer", degraded: true }` (not crash)
- After reconnect: peers re-establish within 30 seconds

**Failure Indicators:**
- Node crashes or hangs when peers disconnect
- `/status` returns 500 (process-level error)
- Identity unreadable offline
- Node never reconnects after network restored

**Automated:** Yes (use iptables or firewall rules in automation)

---

### Scenario 30: MongoDB Down — Untrusted Node Degrades Gracefully

**Layer:** 1
**Mode Required:** 2
**Nodes Required:** LS-1 (P2P storage) — test when EC2-1 is stopped
**Setup:** EC2-1 stopped (MongoDB node down). LS-1 is online but its P2P proxy has no target.

**Steps:**
1. Stop EC2-1: `sudo systemctl stop pando-node` (SSH to EC2-1)
2. Wait 30 seconds for LS-1 to detect peer drop
3. From LS-1, try to create a thread:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"title":"Should fail gracefully"}' $LS1/threads
   ```
4. Verify: returns `{ degraded: true, error: "Storage unavailable" }` — NOT a crash
5. `curl -s $LS1/status` — node still responding
6. `curl -s $LS1/balance` — ledger (SQLite, Layer 0) still works
7. Restart EC2-1: `sudo systemctl start pando-node`
8. Wait 30s for reconnection
9. Try thread creation again — should work

**Expected:**
- Thread creation fails with degraded error (not 500/crash)
- Node remains responsive at Layer 0 (`/status`, `/balance`, `/peers`)
- After EC2-1 comes back: storage works again without node restart on LS-1

**Failure Indicators:**
- LS-1 crashes when EC2-1 goes offline (process crash, no supervisor recovery)
- LS-1 returns 500 internal error (not a user-friendly degraded message)
- `/status` or `/balance` fail (Layer 0 took down by Layer 1 failure)
- LS-1 requires manual restart to reconnect to EC2-1 after it returns

**Automated:** Yes

---

### Scenario 31: Agent System Down — P2P and Ledger Survive

**Layer:** 0 (proving Layer 0 survives Layer 1 crash)
**Mode Required:** 2
**Nodes Required:** Any node with agent system
**Setup:** Node running with agents. Simulate agent system crash.

**Steps:**
1. Verify agent system running: `curl -s -H "Authorization: Bearer $TOKEN" $WIN/agents/tree`
2. Kill agent system by killing all Claude Code child processes (without killing the node):
   ```bash
   # On Windows node via SSH or terminal:
   taskkill /F /IM claude.exe /T
   ```
   **WARNING: Do NOT taskkill all claude.exe if this is your own machine — it kills the current session. Do this on a dedicated test node only.**
3. Immediately after: `curl -s $WIN/status` — should still respond
4. `curl -s $WIN/balance` — ledger still works
5. `curl -s $WIN/peers` — P2P still connected
6. Attempt to spawn new agent: `POST /agents/spawn` — should return 503 or queued
7. Wait 60 seconds — AgentManager should detect crashed agents and log it

**Expected:**
- Node process stays alive after agent subprocess crash
- `/status`, `/balance`, `/peers` all return 200
- New agent spawn returns 503 or queued (system aware of degraded state)
- AgentManager logs the crash but does NOT crash itself
- Existing agents with persisted state resume on next node restart

**Failure Indicators:**
- Node process crashes when Claude Code child dies (unhandled rejection on exit event)
- P2P connections drop (node crash)
- `/balance` returns 500 (ledger taken down)
- Agent crash causes cascade to Layer 0

**Automated:** Partial (process kill automation varies by OS)

---

### Scenario 32: EC2 Unreachable — Deploy Fails Gracefully

**Layer:** 1
**Mode Required:** 2
**Nodes Required:** LS-1 (initiator) — EC2-1 stopped
**Setup:** EC2-1 stopped or firewalled. LS-1 is online.

**Steps:**
1. Stop EC2-1: `sudo systemctl stop pando-node`
2. Wait 30 seconds for LS-1 to detect peer drop
3. Attempt deploy from LS-1:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"repoUrl":"https://github.com/pando-lux/pando","branch":"main"}' \
     $LS1/projects/<projectId>/deploy
   ```
4. Verify response is a clear error (not a crash)
5. `curl -s $LS1/status` — node still responding

**Expected:**
- Deploy returns: `{ error: "No compute peer available for deployment", code: "NO_COMPUTE_PEER" }` (HTTP 503)
- Error is user-friendly, not a stack trace
- LS-1 node continues running
- P2P and ledger still functional after failed deploy attempt

**Failure Indicators:**
- LS-1 crashes during deploy attempt (unhandled exception)
- Deploy hangs forever (no timeout on P2P request)
- Returns 200 with empty URL (silently failed)
- Node becomes unresponsive after failed deploy

**Automated:** Yes

---

### Scenario 33: Storage Failover — EC2-1 Down, EC2-2 Picks Up

**Layer:** 1
**Mode Required:** 2 + 3
**Nodes Required:** LS-1 + EC2-1 + EC2-2
**Setup:** All 3 nodes running. LS-1 P2PStorageBackend connected to EC2-1 as primary.

**Steps:**
1. Create thread from LS-1, verify it lands on EC2-1 (check EC2-1 MongoDB)
2. Note threadId
3. Stop EC2-1: `sudo systemctl stop pando-node`
4. Wait 30 seconds for failover
5. Create a NEW thread from LS-1:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"title":"Post-Failover Thread"}' $LS1/threads
   ```
6. Verify: new thread creates successfully (routed to EC2-2)
7. Check on EC2-2: `curl -s $EC22/threads/<new-threadId>`
8. Start EC2-1 again
9. Verify: original thread still accessible via EC2-1

**Expected:**
- After EC2-1 stops: new storage writes routed to EC2-2 automatically
- LS-1 does NOT require restart to failover (P2PStorageBackend auto-detects available peers)
- EC2-2 picks up writes within 30 seconds
- After EC2-1 comes back: data from the outage period is on EC2-2 (not lost, not duplicated on EC2-1)

**Failure Indicators:**
- LS-1 crashes on EC2-1 failure
- New writes fail even though EC2-2 is available (no failover)
- Failover requires LS-1 restart
- Data written to EC2-2 during outage is somehow duplicated/lost when EC2-1 returns

**Automated:** Yes

---

## AI Backend Scenarios (v2.1 New)

> These verify the AI Backend Registry introduced in v2.1 for pluggable AI provider support.
> These scenarios require v2.1 to be deployed.

---

### Scenario 34: Claude Backend Detect — /capabilities Shows claude-code: available

**Layer:** 1 (core, AI Backend Registry)
**Mode Required:** 1
**Nodes Required:** Windows (has Claude Code installed)
**Setup:** v2.1 deployed. Claude Code installed on Windows node.

**Steps:**
1. `curl -s $WIN/capabilities | python3 -m json.tool`
2. Look for `aiBackends` section in response
3. Verify structure includes Claude Code detection result

**Expected:**
```json
{
  "aiBackends": {
    "claude-code": {
      "available": true,
      "capabilities": ["text-generation", "code-execution"],
      "detectedAt": "<timestamp>"
    },
    "ollama": {
      "available": false,
      "reason": "process not running on localhost:11434"
    }
  }
}
```

**Failure Indicators:**
- `aiBackends` field missing (v2.1 not deployed or capability not registered)
- `claude-code.available` is false on a machine where Claude Code is installed
- Detection throws exception (AIBackendRegistry.detectAll() crashed)

**Automated:** Yes

---

### Scenario 35: Ollama Backend Detect — Reports Unavailable When Not Installed

**Layer:** 1
**Mode Required:** 1
**Nodes Required:** Any node WITHOUT Ollama (EC2-1 or LS-1)
**Setup:** v2.1 deployed. Ollama NOT installed on this node.

**Steps:**
1. `curl -s $EC21/capabilities | python3 -m json.tool`
2. Check `aiBackends.ollama` section

**Expected:**
```json
{
  "aiBackends": {
    "ollama": {
      "available": false,
      "reason": "Ollama process not running on localhost:11434"
    }
  }
}
```
- `available: false` (not a crash, not missing — explicitly detected as unavailable)
- Reason string is human-readable

**Failure Indicators:**
- `ollama` key missing entirely (not detected at all)
- `available: true` when Ollama is not installed (false positive)
- 500 error (detection crashed instead of returning unavailable)

**Automated:** Yes

---

### Scenario 36: Agent Uses Backend Registry — Best Available Backend Selected

**Layer:** 1
**Mode Required:** 2
**Nodes Required:** Windows (Claude Code available)
**Setup:** v2.1 deployed. AIBackendRegistry.getBest('code-execution') returns claude-code.

**Steps:**
1. Spawn an agent on Windows
2. Assign simple task: "Write 'BACKEND-REGISTRY-TEST' to stdout"
3. Verify task completes
4. Check agent logs or response metadata for `backend: "claude-code"` field

**Expected:**
- Agent completes task using Claude Code backend
- Response metadata or logs show `backend: "claude-code"` (which backend was selected)
- Agent did NOT hardcode `claude -p` (uses registry interface)

**Failure Indicators:**
- No `backend` field in response (registry not integrated)
- Agent fails to run (registry returns null, no fallback)
- Agent works but backend is NOT recorded anywhere (not traceable)

**Automated:** Partial

---

### Scenario 37: Backend Fallback — Primary Fails, Next Used or 503 Returned

**Layer:** 1
**Mode Required:** 2
**Nodes Required:** Any node where primary backend can be temporarily broken
**Setup:** v2.1 deployed. Claude Code is primary backend.

**Steps:**
1. Simulate Claude Code failure (rename claude binary or mock it to return error)
2. Spawn agent and assign task
3. If Ollama available: verify agent uses Ollama (fallback)
4. If no fallback: verify 503 returned with `{ error: "No AI backend available", code: "NO_BACKEND" }`
5. Restore Claude Code binary
6. Spawn another agent — verify it uses Claude Code again

**Expected:**
- If fallback available: task completes with fallback backend, user notified in metadata
- If no fallback: clean 503, NOT a crash or hang
- After primary restored: subsequent agents use primary again (registry re-checks availability)

**Failure Indicators:**
- Process crash when primary backend fails (unhandled spawn error)
- Task hangs forever (no timeout on backend detection)
- After restoring primary, registry doesn't detect it (stuck on stale availability state)

**Automated:** Partial (backend simulation is manual)

---

## Cross-Node Scenarios (5-Node Network)

> These test the full network behavior with all 5 nodes active.

---

### Scenario 38: Full Mesh — All 5 Nodes Connected, Ledger in Sync

**Layer:** 0
**Mode Required:** 2
**Nodes Required:** All 5
**Setup:** All nodes started and bootstrapped

**Steps:**
1. Check peers on each node:
   ```bash
   for node in $EC21 $EC22 $LS1 $LS2 $WIN; do
     echo "=== $node ==="; curl -s $node/peers | python3 -c "import sys,json; peers=json.load(sys.stdin); print(f'Peers: {len(peers)}')"; done
   ```
2. Check network topology: `curl -s $EC21/network | python3 -m json.tool`
3. Record EC2-1's peerId balance from all 5 nodes:
   ```bash
   EC21_PEER=$(curl -s $EC21/status | python3 -c "import sys,json; print(json.load(sys.stdin)['peerId'])")
   for node in $EC21 $EC22 $LS1 $LS2 $WIN; do
     echo "$node: $(curl -s $node/balance?peerId=$EC21_PEER | python3 -c 'import sys,json; print(json.load(sys.stdin)[\"balance\"])')"; done
   ```

**Expected:**
- Each node shows 3+ peers (in a 5-node mesh)
- All 5 nodes show identical balance for EC2-1's account (ledger fully synced)
- Network topology is connected (no partitioned subgraphs)

**Failure Indicators:**
- Any node shows 0 peers (isolated)
- Balance discrepancy > 0 between any two nodes for same account (ledger fork)
- Network shows disconnected subgraphs

**Automated:** Yes

---

### Scenario 39: Bootstrap Reconnect — Restart Node, Reconnects Within 30s

**Layer:** 0
**Mode Required:** 2
**Nodes Required:** LS-1 + at least 2 other nodes
**Setup:** LS-1 connected to peers. `known-peers.json` populated.

**Steps:**
1. Verify LS-1 has peers: `curl -s $LS1/peers`
2. Restart LS-1: `ssh ubuntu@54.145.144.221 "pm2 restart pando-node"`
3. Watch LS-1 logs for reconnection
4. At 30-second mark: `curl -s $LS1/peers`
5. At 60-second mark: `curl -s $LS1/peers`

**Expected:**
- LS-1 reconnects to known peers within 30 seconds
- Known peers loaded from `~/.pando/known-peers.json`
- Bootstrap peers (EC2-1) reconnect even if not in known-peers
- Peer list at 30s shows 2+ peers

**Failure Indicators:**
- LS-1 takes > 60 seconds to reconnect (known-peers not loaded)
- LS-1 connects to 0 peers after 60 seconds (bootstrap failed)
- known-peers.json was cleared on restart (persistence bug)

**Automated:** Yes

---

### Scenario 40: Lux Transfer Chain — EC2-1 → LS-1 → Windows

**Layer:** 0
**Mode Required:** 2
**Nodes Required:** EC2-1 + LS-1 + Windows
**Setup:** EC2-1 has 15+ Lux. All nodes connected.

**Steps:**
1. Record starting balances on all 3 nodes for all 3 peerIds
2. Get peerIds:
   ```bash
   LS1_PEER=$(curl -s $LS1/status | python3 -c "import sys,json; print(json.load(sys.stdin)['peerId'])")
   WIN_PEER=$(curl -s $WIN/status | python3 -c "import sys,json; print(json.load(sys.stdin)['peerId'])")
   ```
3. Transfer 5 Lux from EC2-1 to LS-1:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d "{\"to\":\"$LS1_PEER\",\"amount\":5}" $EC21/transfer
   ```
4. Wait 10 seconds
5. Transfer 2 Lux from LS-1 to Windows:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d "{\"to\":\"$WIN_PEER\",\"amount\":2}" $LS1/transfer
   ```
6. Wait 10 seconds
7. Check all balances on all 3 nodes for all 3 accounts

**Expected:**
- After step 4: EC2-1 balance -5, LS-1 balance +4.995 (minus relay fee)
- After step 6: LS-1 balance -2, Windows balance +1.998 (minus relay fee)
- All 3 nodes agree on the final balances for all 3 accounts
- Transaction history on each node reflects both transfers

**Failure Indicators:**
- Transfer from LS-1 fails ("insufficient balance" even though funds were sent)
- Balance discrepancy between nodes after both transfers
- Relay fee not collected
- Chain breaks at second transfer (node doesn't know LS-1's updated balance)

**Automated:** Yes

---

### Scenario 41: Cross-Node Agent Collaboration — LS-1 Agent Requests Storage via P2P Proxy

**Layer:** 1
**Mode Required:** 2 + 3
**Nodes Required:** LS-1 + EC2-1
**Setup:** Both online. LS-1 P2PStorageBackend connected to EC2-1.

**Steps:**
1. Spawn agent on LS-1:
   ```bash
   curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"role":"builder","context":"You are a test agent on LS-1. Read this instruction and create a thread titled CROSS-NODE-TEST via the API at http://localhost:4000/threads."}' \
     $LS1/agents/spawn
   ```
2. Send task to agent
3. Wait for agent to create the thread via LS-1's P2P backend
4. Verify thread appears on EC2-1: `curl -s $EC21/threads?title=CROSS-NODE-TEST`

**Expected:**
- Agent on LS-1 creates thread via LS-1's local API
- LS-1's P2PStorageBackend proxies the write to EC2-1
- Thread visible on EC2-1's MongoDB
- No direct network call from agent to EC2-1 (agent doesn't know about EC2-1)

**Failure Indicators:**
- Thread only visible on LS-1 (agent wrote to local SQLite cache, not proxied)
- Thread not created at all (agent couldn't reach storage)
- Agent requires direct EC2-1 access (not going through P2P proxy)

**Automated:** Partial

---

### Scenario 42: Network Partition Recovery — Isolate LS-1, Reconnect, Ledger Re-Syncs

**Layer:** 0
**Mode Required:** 2
**Nodes Required:** LS-1 + EC2-1 + EC2-2
**Setup:** All 3 online and synced. LS-1's ledger matches EC2-1.

**Steps:**
1. Record LS-1 balance and EC2-1 balance (same values)
2. Block LS-1 outbound connections to EC2-1 and EC2-2 (iptables or PM2 stop + start with --no-bootstrap):
   ```bash
   ssh ubuntu@54.145.144.221 "sudo iptables -A OUTPUT -d 54.82.241.132 -j DROP && sudo iptables -A OUTPUT -d 34.201.82.126 -j DROP"
   ```
3. Wait 60 seconds (LS-1 is isolated)
4. During isolation: make transfers on EC2-1 that LS-1 doesn't see
5. Remove iptables rules to restore connectivity:
   ```bash
   ssh ubuntu@54.145.144.221 "sudo iptables -D OUTPUT -d 54.82.241.132 -j DROP && sudo iptables -D OUTPUT -d 34.201.82.126 -j DROP"
   ```
6. Wait 30 seconds for reconnection
7. Check LS-1's view of balances — should now match EC2-1

**Expected:**
- LS-1 reconnects to EC2-1 within 30 seconds of rules being removed
- LS-1 receives missed GossipSub events (or reconciles via sync request)
- Balances converge: LS-1 shows the transfers that happened during isolation
- No duplicate transactions (idempotent sync)

**Failure Indicators:**
- LS-1 does NOT reconnect without restart
- LS-1 balances remain stale (missed transactions not reconciled)
- Duplicate transactions appear (sync applied twice)
- LS-1 crashes during reconnection (exception on reconnect event)

**Automated:** Yes (iptables scriptable)

---

## Summary

### Scenarios by Layer

| Layer | Scenarios | Count |
|---|---|---|
| Layer 0 — Kernel | 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 38, 39, 40, 42 | 15 |
| Layer 1 — Core | 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 34, 35, 36, 37, 41 | 15 |
| Layer 2 — Platform | 22, 23, 24, 25, 26, 27, 28 | 7 |
| Degraded Mode | 29, 30, 31, 32, 33 | 5 |

**Total: 42 scenarios**

---

### Scenarios That Can Be Run Offline (Mode 1 Only)

These work with a single local node and no internet:

| Scenario | Name |
|---|---|
| 1 | Identity — Node starts and creates identity |
| 2 | Identity — Encrypted identity with password |
| 3 | Ledger — Check balance |
| 9 | HealthMonitor — Check /monitor/status |
| 10 | Guardrails — Protected path write blocked |
| 34 | Claude backend detect |
| 35 | Ollama backend detect — unavailable |

---

### Scenarios That Require All 5 Nodes

| Scenario | Name |
|---|---|
| 38 | Full mesh — All 5 nodes connected |
| 5 | Ledger sync across 3+ nodes (needs EC2-1, LS-1, Windows) |
| 8 | Governance — Create proposal and vote (3 voters) |
| 11 | Emission — Uptime epoch (3+ witnesses) |

---

### Priority Order — Quick Smoke Test (Top 10)

Run this after any deployment to verify the network is healthy. Total time: ~15 minutes.

| Priority | Scenario | Why Critical |
|---|---|---|
| 1 | Scenario 3: Ledger balance | Layer 0 alive — most basic check |
| 2 | Scenario 38: Full mesh peers | Network connected — precondition for everything |
| 3 | Scenario 5: Ledger sync | P2P GossipSub working |
| 4 | Scenario 16: P2P storage proxy | LS-2 can read/write via EC2-1 (use LS-2 — LS-1 down) |
| 5 | Scenario 9: HealthMonitor | Metrics working, no alerts |
| 6 | Scenario 20: JWT cross-node auth | Auth works across all nodes |
| 7 | Scenario 17: Deploy Tier 1 | S3 deployment pipeline intact |
| 8 | Scenario 18: Deploy Tier 2 | EC2/PM2 deployment pipeline intact |
| 9 | Scenario 24: AI search | Credential routing + AI backend working |
| 10 | Scenario 28: Chat/manager agent | Full agent pipeline end-to-end |

**Automated smoke test (preferred — 18 tests):**
```bash
# Run from pando/ root — tests all 3 live nodes (EC2-1, EC2-2, LS-2)
node tests/smoke-test.mjs
# Expected: 18/18 PASS (LS-1 excluded — machine down)
```

**Manual quick check (copy-paste, v2 /v1/ prefix required):**
```bash
TOKEN="bd5b00bab232c33c259c2603a9991925287cf43fb1f9519c4f00c04501532127"
EC21="http://54.82.241.132:4000/v1"
LS2="http://3.237.175.38:4000/v1"   # LS-1 is down, use LS-2

# 1. Layer 0 alive
curl -s -H "Authorization: Bearer $TOKEN" $EC21/wallet

# 2. Network connected
curl -s -H "Authorization: Bearer $TOKEN" $EC21/peers

# 3. LS-2 storage via P2P
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Smoke Test Thread"}' $LS2/chat/threads

# 4. NodeHealth
curl -s $EC21/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('health', {}))"

# 5. Network capabilities
curl -s $EC21/network/capabilities
```

---

*Maintained by: Pando v2 sprint agents. Update whenever scenarios are added, changed, or automated.*
*Source of truth: genome/foundation/the-stack.md — if a scenario contradicts the-stack.md, update the scenario.*
