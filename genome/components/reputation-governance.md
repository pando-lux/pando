---
id: reputation-governance
type: safety
entry: packages/node/src/reputation-governance.ts
depends_on: [reputation]
depended_by: [governance, pando-node]
exposes:
  - calculateVoteWeight(peerId)
  - canPropose(peerId)
  - canVote(peerId)
  - checkWeightedQuorum(votes, peerCount)
  - applyWeighting(votes, peerCount)
rules: []
last_verified: 2026-02-18
---

# Reputation-Weighted Governance

## What It Does
Enhances the governance voting system with reputation-based vote weighting. Prevents Sybil attacks by weighting votes on quality (reputation, uptime, resource contribution) rather than quantity of nodes.

## How It Works
- Vote weight formula: `base_reputation * uptime_factor * resource_factor * MAX_VOTE_WEIGHT`, clamped between 0.1 and 10.0.
  - Reputation factor: base 0.3 + 0.7 scaled by normalized reputation score (score/100).
  - Uptime factor: base 0.5 + 0.5 ramping up over 48 hours.
  - Resource factor: base 0.5 + 0.5 scaled by tasks completed (up to 10).
- `canPropose()` requires reputation score >= 30% and uptime >= 24 hours.
- `canVote()` requires reputation score >= 10%.
- `checkWeightedQuorum()` uses dynamic quorum thresholds based on network size: solo mode (0.1), small network <=5 peers (2.0), medium <=20 peers (3.0), large networks (min(10, peerCount * 0.3)).
- `applyWeighting()` returns per-voter weights alongside aggregate approve/reject/abstain weights and a majority/tie/minority decision.

## Gotchas
- Reputation scores are expected in the 0--100 range and normalized internally. If `ReputationManager` returns scores outside this range, weights will be clamped but may produce unexpected results.
- The `getUptime()` callback returns the local node's uptime, not the target peer's uptime -- all vote weight calculations use the local node's uptime for the uptime factor, regardless of which peer is being evaluated.
- No persistence -- this is a pure computation class. State lives in `ReputationManager`.
- The quorum threshold scales linearly with peer count for large networks, which could make quorum very hard to reach in networks with 30+ peers.

## Key Files
- `packages/node/src/reputation-governance.ts` -- ReputationWeightedGovernance class
- `packages/node/src/reputation.ts` -- ReputationManager (provides score data)
- `packages/shared/src/types.ts` -- GovernanceVote, QuorumResult, WeightedVoteResult types
