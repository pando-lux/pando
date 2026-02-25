---
id: governance-cycle
components: [governance, reputation-governance, manager]
rules: [two-laws, authority-model]
trigger: proposal_created
---

# Governance Cycle Flow

How the network makes collective decisions.

## Steps

```
1. PROPOSE
   Any node creates a proposal:
   POST /governance/propose {title, description, type}
   Types: general, code_upgrade, parameter_change, budget
   → Proposal synced to all nodes via GossipSub

2. DISCUSSION
   Nodes can comment on proposals
   Discussion period: configurable (default varies by type)
   → Comments synced via P2P

3. VOTE
   Each node casts one vote: approve or reject
   POST /governance/vote {proposalId, vote: "approve"|"reject"}
   Votes weighted by reputation (reputation-governance.ts)
   Min reputation gate: low-rep nodes can't vote on critical proposals
   → Votes synced via GossipSub

4. DECISION
   Quorum reached OR time expires → proposal decided
   Standard: 51% majority with 30% quorum
   Emergency: 40% quorum, 1-hour vote period
   → Decision: approved or rejected

5. EXECUTION (if approved)
   code_upgrade → triggers upgrade-protocol flow
   parameter_change → manager applies change
   general → manager creates task from proposal
   budget → manager adjusts budget settings
   → Action taken

6. REWARD
   Proposer gets 5.0 Lux if approved
   Voters get 0.1 Lux each (via emission witness)
   → Lux minted for governance participation
```

## Sybil Resistance

- Reputation-weighted votes prevent low-quality nodes from dominating
- Witness-based emission prevents vote reward farming
- 30-day archival prevents unbounded growth
- 500 active proposal cap
