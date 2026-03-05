# Constitutional Layer — Network Self-Protection

> Status: DESIGN (not yet implemented). Pre-public requirement.
> Priority: After technical system is stable, before public launch.

## The Problem

The network is autonomous. Governance allows any node to propose anything, and if enough nodes vote yes, it becomes a task. This creates risks:

1. A bad actor proposes removing security checks with convincing reasoning
2. A Sybil attack creates many nodes to outvote legitimate ones
3. Even the founder could propose harmful changes (intentionally or accidentally)
4. New nodes with no track record have equal voting power to battle-tested nodes

The network needs rules that **governance itself cannot override**.

## Three-Tier Rule System

### Tier 1: Immutable (Hardcoded — no vote can ever change these)

| Rule | Why |
|---|---|
| The Two Laws | Core ethics. Never harm humans. Always persist. |
| IMMUTABLE_KERNEL file list | crypto.ts, governance.ts, identity files — the security foundation |
| Minimum quorum requirement | Prevents 1-node takeover. Must always need 2+ votes minimum |
| Ed25519 identity system | Can't switch to weaker crypto via governance |
| Transaction integrity | Can't create Lux from nothing without emission witness flow |
| Constitutional Layer itself | This tier cannot be modified by any governance action |

### Tier 2: Supermajority (needs 80%+ of voting power to change)

| Rule | Why |
|---|---|
| Emission caps (500 Lux/day/node, 10B hard cap) | Prevents inflation attacks |
| Relay fee structure (0.1%) | Economic stability |
| Security monitor thresholds | Can't weaken security via simple majority |
| Manager autonomy levels | Can't escalate all managers to uncontrolled mode |
| Voting power formula | Can't change how votes are weighted to benefit attackers |
| Guardrails protected paths | Can't remove file protection via majority |

### Tier 3: Simple Majority (normal governance)

Everything else: UI changes, new features, task priorities, configuration, documentation, patterns, profiles.

## Proposal Risk Scoring

Before any governance vote, an AI evaluator classifies the proposal:

| Risk Level | Examples | Requirements |
|---|---|---|
| **Low** | UI tweak, doc update, new pattern | Simple majority, 24h voting |
| **Medium** | New feature, refactor, config change | Simple majority, 48h voting, 3+ votes |
| **High** | Touches security, economics, core logic | 66% supermajority, 72h voting, 5+ votes |
| **Critical** | Touches Tier 1/2 rules | Blocked (Tier 1) or 80% supermajority (Tier 2) |

## Reputation-Weighted Voting

Not all votes are equal. Voting power scales with proven contribution:

```
votingPower = baseVote (1.0)
  + taskCompletionBonus (0.01 per successful task, max 2.0)
  + uptimeBonus (0.001 per hour online, max 1.0)
  + reputationBonus (reputation_score / 100, max 1.0)
```

Maximum voting power: 5.0x (a deeply committed, highly productive node).
Minimum voting power: 1.0x (a brand new node with no history).

This means a node with 300 completed tasks and months of uptime has ~5x the vote of a node that just joined. Sybil attacks become expensive — you need real work to gain influence.

## Anti-Manipulation Safeguards

1. **Proposal cooldown**: Same proposer can't create more than 3 proposals per day
2. **Duplicate detection**: Semantically similar proposals within 7 days are flagged
3. **Mandatory justification**: High-risk proposals require detailed reasoning
4. **Cooling period**: Critical proposals have 72h minimum before voting closes
5. **Founder lockout**: No special override for any single identity — founder included

## Implementation Notes

- Tier 1 rules encoded as constants, not configuration
- Tier 2 thresholds stored in a signed config that requires supermajority to update
- Risk scoring uses the Planner AI (same as task profiling) to classify proposals
- Voting power calculated from on-chain data (ledger + reputation), not self-reported
- All constitutional checks run BEFORE governance.ts processes a vote result
