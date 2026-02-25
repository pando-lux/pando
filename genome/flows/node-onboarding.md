---
id: node-onboarding
components: [network, ledger, ledger-sync, tui, user-accounts]
rules: [p2p-first]
trigger: node_start
---

# Node Onboarding Flow

How a new node joins the Pando network.

## Steps

```
1. INSTALL
   Clone repo, npm install, npm run build.
   Or use launcher: start-node.command (Mac) / start-node.bat (Windows)
   → Binary ready

2. START
   node packages/node/dist/cli.js --port 4001
   Or double-click launcher
   → Node process running

3. IDENTITY
   TUI prompts: Create new identity or select existing.
   Ed25519 keypair generated, encrypted with password (PBKDF2 + AES-256-GCM).
   Stored in ~/.pando/identities/{peerId}.json
   Session cached in ~/.pando/session.json after login.
   → Node identity established ("Node #XXXX running")

4. OPERATOR LOGIN (Phase 48)
   TUI checks for ~/.pando/operator-session.json (auto-login).
   If found + valid: restores operator state (setOperator).
   If not found: node runs as relay-only (no rewards).
   Operator can use /login or /register at any time.
   /login: username+password → calls /auth/login → setOperator + save session.
   /register: create account → claim with credentials → setOperator + save session.
   On login, node registers itself under the user's account (POST /auth/me/nodes).
   → Operator bound to node (or relay-only if anonymous)

5. CONNECT
   If --bootstrap provided: connect to known peer.
   If no bootstrap: mDNS discovers local peers automatically.
   Get bootstrap info: curl http://<known-node>:4000/onboard
   → Connected to at least 1 peer

6. LEDGER SYNC
   LedgerSync requests missing transactions from peers.
   GossipSub subscribes to all topics.
   Transactions applied in order until consistent.
   → Ledger matches network state

7. GENESIS ALLOCATION
   First-time node registration: receives genesis Lux.
   Early multiplier: accounts 1-100 get 5x, 101-1000 get 3x.
   → Node has initial Lux balance

8. READY
   API server listening on --api-port (default 4000).
   P2P listening on --port.
   Optional: start gateway (npx next dev --port 3222).
   Optional: start scheduler (--scheduler flag).
   Optional: start monitor (--monitor flag).
   → Full node operational
```

## Emission Attribution (Phase 48)

Lux rewards (uptime epochs, task completion, etc.) are credited to the **operator's peerId** via `node.getRewardRecipient()`. If no operator is logged in, the node earns no rewards — it operates as a relay only. This incentivizes node operators to claim their nodes with `/login` or `/register`.
