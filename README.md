# Pando — The Open Network

Decentralized, AI-managed peer-to-peer network. Each node runs identity, a Lux economy ledger, governance, and P2P sync via GossipSub.

This is **pando-node** — the body of the Pando system. Pair it with [pando-teams](https://github.com/jairangwani/pando-teams) (the brain) to get AI agents running on your node.

## Quick Start

See **[QUICKSTART.md in pando-teams](https://github.com/jairangwani/pando-teams)** for the full setup guide covering both repos.

### Standalone node

```bash
git clone https://github.com/pando-lux/pando pando/node
cd pando/node
npm install
npm run build
node packages/node/dist/cli.js --api-port 4000 --data-dir ~/.pando
```

API available at `http://localhost:4000`.

## What It Does

| Feature | Description |
|---------|-------------|
| **P2P** | libp2p + GossipSub mesh — nodes discover and sync with peers |
| **Identity** | Ed25519 keypair per node, persistent across restarts |
| **Lux** | Native token — transfers, relay fees (0.1%), per-node ledger |
| **Governance** | On-chain proposals, GossipSub-broadcast voting |
| **AI bridge** | Connects to pando-teams for agent orchestration |

## Key Endpoints

```
GET  /v1/bootstrap          — peer multiaddr for connecting other nodes
POST /v1/connect            — connect to a peer
GET  /v1/lux/balance        — Lux balance
POST /v1/lux/transfer       — send Lux
GET  /v1/governance         — list proposals
POST /v1/governance         — create proposal
POST /v1/governance/:id/vote — vote
```

All write endpoints require `Authorization: Bearer <token>` (token auto-generated at `~/.pando/api-token` on first boot).

## Connect Two Nodes

```bash
# Get Node A's bootstrap address
curl http://127.0.0.1:4000/v1/bootstrap

# From Node B, connect
curl -X POST http://127.0.0.1:4001/v1/connect \
  -H "Authorization: Bearer $(cat ~/.pando-b/api-token)" \
  -H "Content-Type: application/json" \
  -d '{"multiaddr": "<Node A multiaddr>"}'
```

## Requirements

- Node.js 20+
- Git
