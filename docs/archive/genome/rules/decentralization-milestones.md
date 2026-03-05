# Decentralization Milestone Protocol

*Layer 0 architectural constraint. Not governable below Tier 1. Defines when and how governance power transitions from founder-weighted to fully distributed.*

---

## Why This Exists

Early in any network, governance is nominally decentralized but practically centralized — the founder runs most nodes and their vote determines all outcomes. This is an acceptable bootstrap reality. The problem is when it never ends: governance can vote to remain centralized because the only voters are centralized.

This protocol defines automatic, non-negotiable transitions. Each threshold is evaluated continuously by `kernel/governance.ts`. No governance vote is needed to trigger a transition — transitions happen by math, not by consensus.

**Rule:** `FOUNDER_NODE_ID` is the only special identity in the system. Everything in this file applies to it and only it. All other nodes are treated equally from day one.

---

## The Four Milestones

### Milestone 0 — Bootstrap (< 10 unique human operators)

**What it means:** the network is seeding. Jai operates most nodes. Governance exists but is not genuinely distributed.

**Governance rules:**
- Founder node (`FOUNDER_NODE_ID`) retains veto on Tier 1 and Tier 2 proposals
- Veto means: founder node voting NO blocks the proposal regardless of quorum
- Standard quorum still required for proposals to pass (51% / 80% / 90% by tier)
- Founder veto does NOT apply to Tier 3 or Tier 4 proposals

**Transparency requirement:**
- Gateway MUST display: `"Network is in Bootstrap mode. Governance is founder-assisted."`
- Council minutes MUST include this status in every reflection summary
- This is not a flaw to hide — it is an honest statement about the network's current state

**What triggers exit:**
- 10 unique human operators (not nodes — operators. One human running 5 nodes = 1 operator)
- "Unique human" is verified by: linked user account (MongoDB user record) OR governance-accepted proof

---

### Milestone 1 — Emerging (≥ 10 unique human operators)

**What changes at this threshold:**
- Founder veto on Tier 1-2 proposals drops automatically
- Council diversity rule activates: no more than 1 Council seat per operator
- Gateway status updates to: `"Network is Emerging. Standard governance active."`

**Governance rules:**
- Standard quorum applies to all tiers (51% / 80% / 90%)
- Founder node votes with weight equal to its reputation score — no special weight, no special restriction
- Council: if top-3 reputation nodes are all operated by the same person, 3rd seat goes to 4th-highest different operator

**Why the Council diversity rule matters:**
The Council proposes changes. If one operator dominates the Council, their nodes will always propose changes that benefit them. Diversity at the Council level is the first protection against governance capture.

---

### Milestone 2 — Established (≥ 100 unique human operators)

**What changes at this threshold:**
- No single operator may hold more than 15% of total network reputation weight
- This is enforced at vote-tallying time in `kernel/governance.ts` — the cap is applied before votes are counted
- Gateway status updates to: `"Network is Established. Reputation is distributed."`

**The 15% cap:**
```
effectiveWeight = min(rawWeight, totalNetworkWeight * 0.15)
```
Applied to ALL operators including the founder. There are no exceptions.

**Why 15%:** at 100 operators, 15% means one operator needs 7 others to agree to form a majority. This prevents any single actor (including the founder) from unilaterally controlling governance outcomes while still allowing meaningful participation.

**Council rule update:**
- Council diversity extends: no single operator may hold > 1 Council seat at any milestone
- Council size may expand to 5 if there are ≥ 50 unique operators with AI capability (governance vote required)

---

### Milestone 3 — Decentralized (≥ 1,000 unique human operators)

**What changes at this threshold:**
- `FOUNDER_NODE_ID` constant is cleared from `kernel/governance.ts`
- Founder node is now just a node — same rules as everyone else
- The 15% cap remains but now applies to all operators symmetrically
- Gateway status updates to: `"Network is Decentralized. No special governance roles."`

**The clearing of FOUNDER_NODE_ID:**
This is the most significant event in the network's history. It cannot be undone without a Tier 1 governance vote (90% quorum + 30-day migration window). The event is:
- Broadcast via GossipSub as a signed `DECENTRALIZATION_COMPLETE` message
- Logged permanently to Council minutes
- Displayed in the gateway as a historical milestone with timestamp

**What does NOT change:**
- The Two Laws (Law I, Law II) — these are permanent and pre-governance
- The governance tier model — still applies
- The founder's ability to vote, propose, and participate — same as any other operator
- The public repo, the codebase, the docs — still open source

---

## What "Unique Human Operator" Means

**Counts as 1 operator:**
- One linked user account (MongoDB userId) that controls ≥ 1 active node

**Does NOT count:**
- Unlinked nodes (no user account) — these count as nodes but not as operators for milestone tracking
- Multiple accounts controlled by the same person — governance can challenge identity via proof-of-personhood proposals
- Bot-operated nodes without linked accounts

**Operator count is maintained by:**
- `kernel/governance.ts` — tracks unique userIds linked to active nodes
- Updated on: account link (`/login`), node disconnect (prune after 30 days inactive)
- Published to the network via GossipSub as part of capability profiles

---

## Governance Tier Reminder

These milestones interact with the governance tier model:

| Tier | What it covers | Quorum | Milestone impact |
|---|---|---|---|
| Tier 0 | The Two Laws | No vote — absolute | Unaffected by milestones |
| Tier 1 | Constitutional (identity, ledger schema) | 90% + migration | Founder veto until Milestone 1 |
| Tier 2 | Kernel (guardrails, emission, quorum) | 80%, 72h | Founder veto until Milestone 1 |
| Tier 3 | Standard Layer 1-2 | 51%, 48h | No special rules at any milestone |
| Tier 4 | Code review Layer 3-4 | No vote | No special rules at any milestone |

**Changing this document:** requires Tier 1 governance (90% quorum). The milestones themselves (the thresholds and what changes at each) are Tier 1 constitutional material. The specific values (15% cap, 10/100/1000 thresholds) can be adjusted by Tier 2 governance.

---

## Transparency Obligations

At every milestone, the network must:

1. **Log it** — Council minutes entry with timestamp, operator count, which rules changed
2. **Broadcast it** — signed GossipSub message `MILESTONE_REACHED` received by all nodes
3. **Display it** — Gateway shows current milestone + history of transitions
4. **Never hide it** — Bootstrap mode is not shameful. Every network starts there.

The decentralization level of the network is public information. Any user, any journalist, any regulator can verify it by reading the gateway's governance page.

---

## Implementation Notes

**File:** `kernel/governance.ts`

**Key constants:**
```typescript
const FOUNDER_NODE_ID = '<set at genesis, cleared at Milestone 3>';
const MILESTONE_THRESHOLDS = { emerging: 10, established: 100, decentralized: 1000 };
const MAX_OPERATOR_WEIGHT_RATIO = 0.15;  // Milestone 2+
```

**Milestone evaluation (runs before every vote tally):**
```typescript
function getCurrentMilestone(uniqueOperators: number): MilestoneLevel {
  if (uniqueOperators >= MILESTONE_THRESHOLDS.decentralized) return 'decentralized';
  if (uniqueOperators >= MILESTONE_THRESHOLDS.established) return 'established';
  if (uniqueOperators >= MILESTONE_THRESHOLDS.emerging) return 'emerging';
  return 'bootstrap';
}
```

**`uniqueOperatorCount` is the single most important governance metric.** It must be accurate. Inflate it and you move to a milestone you haven't earned. Deflate it and you stay in bootstrap longer than necessary. Both are bad.
