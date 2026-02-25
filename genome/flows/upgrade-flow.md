---
id: upgrade-flow
components: [upgrade-protocol, governance]
rules: [two-laws, immutable-kernel]
trigger: upgrade_proposal
last_verified: 2026-02-25
---

# Network Upgrade Flow (Phase 82)

How the network evolves its own code safely.

## Steps

```
1. PROPOSE
   Node commits code, pushes to GitHub.
   POST /upgrade/propose { description } → governance proposal with commit hash.
   → Proposal synced to network

2. APPROVE
   Dev mode (≤8 peers): auto-approve instantly.
   Live mode (>8 peers): supermajority vote.
   → Decision: approved or rejected

3. PULL + BUILD
   All nodes: git pull → verify commit hash → npm run build → restart.
   Proposing node goes first, broadcasts notification to peers.
   Version pinned nodes refuse upgrade.
   → Network-wide deployment

4. ROLLBACK (if build fails)
   Automatic: git reset --hard to previous commit.
   Emergency: POST /upgrade/rollback → fast-track governance vote.
   → Network restored
```
