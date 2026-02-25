---
id: p2p-upgrade
type: flow
domain: infrastructure
depends_on: [governance, network, upgrade-protocol]
created: 2026-02-24
status: IMPLEMENTED (Phase 82)
last_verified: 2026-02-25
---

# P2P Self-Upgrade Protocol

## How It Works

```
Any Node                              All Other Nodes
    │                                       │
 AI writes fix                              │
 Commits locally                            │
 Pushes to GitHub                           │
    │                                       │
    ▼                                       │
 POST /upgrade/propose                      │
 { description: "Fix deploy URL" }          │
    │                                       │
    ▼                                       ▼
 ┌──────────────────────────────────────────────┐
 │            Governance System                  │
 │                                               │
 │  Dev mode (≤8 peers): auto-approve instantly  │
 │  Live mode (>8 peers): supermajority vote     │
 └──────────────────────────────────────────────┘
    │                                       │
    ▼                                       │
 Proposing node: git pull → build → restart │
    │                                       │
    ▼                                       ▼
 GossipSub: pando/upgrades
 { type: "upgrade_available",
   commitHash: "abc123",
   description: "Fix deploy URL" }
    │                                       │
    ▼                                       ▼
                                     ┌──────────────┐
                                     │ git pull      │
                                     │ verify hash   │
                                     │ npm run build │
                                     │ restart       │
                                     └──────────────┘

 If proposer goes offline before broadcasting:
                                     ┌──────────────────────┐
                                     │ Catch-up timer (5min) │
                                     │ Scans governance      │
                                     │ Finds passed upgrade  │
                                     │ → git pull + build    │
                                     └──────────────────────┘
```

## The Flow

1. **PROPOSE**: AI or human commits a fix, pushes to GitHub, then calls `POST /upgrade/propose { description }`. This creates a governance proposal with the current commit hash.

2. **APPROVE**: In dev mode (≤8 active peers), governance auto-approves instantly. In live mode (>8 peers), nodes vote. Supermajority (>66%) required.

3. **UPGRADE LOCALLY**: The proposing node runs `git pull → verify hash → npm run build → restart`.

4. **BROADCAST**: After successful local upgrade, broadcasts `upgrade_available` notification via GossipSub `pando/upgrades` topic to all peers.

5. **ALL PEERS PULL**: Each peer receives the notification, runs `git pull`, verifies the commit hash matches what governance approved, builds, and restarts.

6. **CATCH-UP (if broadcast missed)**: Every node runs a catch-up timer (every 5 minutes) that scans governance for passed upgrade proposals it hasn't applied. If the proposer went offline before broadcasting, peers still discover and apply the upgrade independently. No single point of failure.

7. **ROLLBACK**: If build fails on any node, it automatically rolls back to the previous commit. Emergency rollback available via `POST /upgrade/rollback`.

## Security

| Layer | What it does |
|---|---|
| Governance vote | Prevents rogue nodes from pushing bad code |
| Commit hash verification | Ensures nodes pull the exact code governance approved |
| Build check | Code that doesn't compile gets rolled back automatically |
| Version pinning | Nodes can opt out of auto-upgrades |

## Configuration

| Setting | Default | Description |
|---|---|---|
| Auto-approve threshold | 8 peers | Auto-approve if ≤ N active peers |
| Build timeout | 180s | Max time for `npm run build` |
| Restart exit code | 75 | PM2/launcher detects this and restarts |
| Catch-up interval | 5 min | How often nodes scan governance for missed upgrades |
| Catch-up startup delay | 30s | Initial delay before first catch-up scan after boot |

## Key Files

- `packages/node/src/upgrade-protocol.ts` — `pullAndUpgrade()`, `createUpgradeProposal()`
- `packages/node/src/index.ts` — GossipSub handler, governance callback
- `packages/node/src/api-server.ts` — `POST /upgrade`, `POST /upgrade/propose`
- `packages/node/src/governance.ts` — auto-approve threshold, `onUpgradeApproved`
