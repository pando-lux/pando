---
id: p2p-sync
components: [network, ledger-sync, governance, content-registry, capability-registry]
rules: [p2p-first]
trigger: state_change
---

# P2P Sync Flow

How state replicates across all nodes in the network.

## GossipSub Topics

| Topic | What Syncs | Merge Strategy |
|---|---|---|
| pando/transactions | Lux transfers, emissions | Dedup by tx hash, apply in order |
| pando/tasks | Task creation, status changes | First-Claim-Wins for claiming |
| pando/governance | Proposals, votes, decisions | Version-wins merge |
| pando/resources | Shared resource registry entries | Latest-wins per resource |
| pando/reputation | Node reputation scores | Threshold-based broadcast |
| pando/content | Content records | Version-wins merge |
| pando/capabilities | Node capability declarations | 15-min TTL refresh |
| pando/prices | Resource marketplace pricing | Latest-wins per resource |

## Transaction Sync Flow

```
1. Node A creates transaction (transfer, emission)
   → LedgerSync publishes to pando/transactions topic

2. All connected nodes receive via GossipSub
   → Each node validates: signature, balance, dedup check

3. Valid transaction applied to local ledger
   → Account balances updated

4. Catch-up on reconnect
   → Nodes request missing transactions since last sync
```

## Conflict Resolution

- **Transactions**: Dedup by hash. Duplicate = silently skip.
- **Task claiming**: First-Claim-Wins. Timestamp tie-break.
- **Governance**: Vote counts are additive. No conflict possible.
- **Capabilities**: Latest-wins per node. 15-min TTL refresh.
- **Content**: Version number wins. Higher version replaces lower.
