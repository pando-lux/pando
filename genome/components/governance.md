---
id: governance
type: service
domain: governance
entry: packages/node/src/kernel/governance.ts
depends_on: [network, ledger, payment-gate, agent-manager]
depended_by: [upgrade-protocol]
exposes:
  - start() — run migrations, prepare statements, load from DB, subscribe GossipSub
  - propose(title, description) — create and broadcast a governance proposal
  - createProposal(title, description, opts?) — Phase 30: create proposal with staking, category, emergency flag
  - comment(proposalId, content) — add a comment to a proposal
  - vote(proposalId, choice, reasoning, attestation?) — cast a vote (approve/reject/abstain)
  - checkAndDecide(proposalId) — tally votes, create decision if voting period ended (includes reviewSummary)
  - submitReview(proposalId, peerId, review) — AI reviewer submits review (riskScore, reasoning, recommendation)
  - getProposals() — list all proposals
  - getVotes(proposalId) — get votes for a proposal
  - getDecisions() — list all decisions (with reviewSummary if applicable)
  - getProposalReviews(proposalId) — get all AI reviews for a proposal
  - getReviewerAssignments(proposalId) — get reviewer assignments and status
  - getWeightedVoteResult(proposalId) — reputation-weighted vote result (Phase 12.4)
  - createAttestation(proposalId, choice, modelId, modelProvider, privateKeyBytes) — model attestation
  - broadcastCandidacy(proposalId) — broadcast reviewer candidacy via GossipSub
  - resolveProposalStake(proposalId, outcome) — refund/burn/hold stake based on outcome
  - setPaymentGate(pg) — wire PaymentGate for proposal staking
  - setAgentManager(am) — wire AgentManager for reviewer agent spawning
  - setRewardCallback(fn) — set callback for Lux rewards on governance activity
  - setReputationGovernance(rg) — enable reputation-weighted governance
  - setUpgradeAutoApproveThreshold(threshold) — set peer count below which upgrade proposals auto-approve
  - getUpgradeAutoApproveThreshold() — get current auto-approve threshold (default 8)
  - onUpgradeApproved(callback) — register callback invoked when an upgrade proposal is approved (either via auto-approve or voting quorum)
rules: [governance-tiers]
last_verified: 2026-02-26
---

# Governance

## What It Does
Decentralized governance with AI-powered proposal review. Agents and users propose changes, AI reviewers on randomly selected nodes evaluate proposals, then community votes. Proposals cost Lux (anti-spam). All messages broadcast via GossipSub. Persisted to SQLite.

## How It Works

### Core Flow (Phase 30)
1. **Propose**: User/agent creates proposal → Lux stake deducted (10 standard, 50 emergency) → broadcast via GossipSub
2. **Candidacy Window** (5 min): Eligible nodes compute hash-based score, broadcast candidacy
3. **Reviewer Selection**: Deterministic selection of top-N candidates (1-3 based on network size), IP dedup
4. **AI Review** (30 min): Selected nodes spawn reviewer agents → analyze proposal → submit review (risk score 1-5, reasoning, recommendation)
5. **Review Aggregation**: Majority reject → auto-reject + burn stake. Majority revise → hold stake. Majority approve → open community vote.
6. **Community Vote** (24h): Existing vote mechanism with reputation weighting. Decision includes reviewSummary.

### Proposal Staking
| Action | Cost | Refund |
|---|---|---|
| Standard proposal | 10 Lux | Refunded if passes, burned if rejected |
| Emergency proposal | 50 Lux | Refunded if passes |
| Amendment | 2 Lux | Non-refundable |
| Free tier | 0 Lux | First proposal from accounts < 100 Lux |

### Reviewer Selection
- Score: `SHA256(proposalId + peerId + createdAt)` first 4 bytes as uint32 mod 10000
- Candidates must have: Claude Code capability, reputation >= 0.5, not be the proposer
- IP dedup prevents multi-node-per-machine gaming
- Required reviewers: 1-9 nodes → 1, 10-99 → 2, 100+ → 3

### SQLite Tables
- `governance_proposals` — proposals with staking columns (stake_amount, stake_hold_id, category, reviewer_count, human_only, upgrade_payload)
- `governance_comments` — discussion
- `governance_votes` — votes with model_attestation
- `governance_decisions` — final decisions with reviewSummary
- `governance_reviewers` — reviewer assignments (proposal_id, peer_id, agent_id, status, review_text, risk_score)
- `governance_reviews` — submitted reviews (id, proposal_id, reviewer_peer_id, risk_score, reasoning, recommendation, model_attestation)

### Migration Order (CRITICAL)
All `ALTER TABLE` and `CREATE TABLE IF NOT EXISTS` statements run BEFORE any `db.prepare()` calls in `start()`. Violating this crashes nodes with existing databases (discovered 2026-02-22, fixed same day).

## Phase 33 Additions: Self-Governing Development

### Auto-Vote on Own Proposals
When the manager creates a governance proposal for a node change, the proposing node automatically votes APPROVE on its own proposal. This is normal behavior -- the proposer believes in their change. The real check comes from OTHER nodes voting independently.

### Early Resolution
When all known nodes have cast their votes, the proposal resolves immediately instead of waiting for the full 24-hour voting period. On a single-node network, this means proposals resolve instantly after the auto-vote. On a 3-node network, the proposal resolves as soon as the 3rd vote arrives.

### Security Model (Reviewer Independence)
- **Multi-node (3+ nodes):** Reviewer agents are spawned on randomly selected nodes (Phase 30 hash-based selection). Different node = different AI instance, different context, potentially different configuration. This provides genuine independent review.
- **Single-node:** Reviewer and proposer are the same AI on the same machine. Governance is ceremonial. Accepted for dev. See `genome/rules/governance-tiers.md`.
- **Same-node reviewer:** Even on a multi-node network, if the reviewer happens to be on the same node as the proposer, independence is limited. IP dedup in reviewer selection mitigates this.

### Two-Tier Governance (Planned — Phase 33.6)
Currently, all governance proposals go to all nodes (network-level only). Phase 33.6 adds project-level governance where only project stakeholders vote. See `genome/rules/governance-tiers.md` for the full design.

### Cross-Node Gaps
- **Reviewer spawning on remote nodes:** Phase 30 has the mechanism (hash-based selection, candidacy broadcast), but it needs E2E testing on a real multi-node network with the Phase 33 proposal flow.
- **Code distribution after approval (Phase 82):** Governance approves → UpgradeProtocol does `git pull` + hash verification → broadcasts commit hash to peers via GossipSub. Simple and reliable.
- **Rollback:** If `npm run build` fails after `git pull`, UpgradeProtocol automatically rolls back to the previous commit. Emergency rollback available via governance fast-track vote.

## Upgrade Auto-Approve (Phase 73 → Phase 82)

### Auto-Approve for Upgrades
When `createProposal()` is called with `category: 'upgrade'` and the number of active peers is below the auto-approve threshold (default 8), the proposal is immediately marked as approved. This bypasses the normal AI review and community vote, allowing fast iteration during development while using the exact same code path as production governance.

The threshold is configurable via:
- `setUpgradeAutoApproveThreshold(n)` — programmatic
- `PANDO_UPGRADE_AUTO_APPROVE_THRESHOLD` env var — at startup
- A governance proposal itself — the network votes on its own rules

### Upgrade Approved Callback
`onUpgradeApproved(callback)` registers a callback that fires in two scenarios:
1. **Auto-approve path**: immediately in `createProposal()` when peers < threshold
2. **Voting path**: in `checkQuorum()` when an upgrade proposal passes the supermajority vote

The callback receives the proposal object. UpgradeProtocol then runs `pullAndUpgrade()` locally (git pull + build + restart) and broadcasts the commit hash to all peers via GossipSub.

## Gotchas
- **Migration before prepare**: All schema changes must run before prepared statements. See migration order section above.
- The `sanitizeText()` function only escapes `<` and `>` — additional XSS protection needed at display layer.
- Model attestation column added via live migration (`ALTER TABLE`). Safe for SQLite single-process.
- GossipSub dedup via `processedIds` Set prevents double-processing.
- Maximum 500 in-memory proposals before eviction. Archive interval cleans up.
- Rate-limits: max 1 active proposal per account with 0 votes.
- `archiveExpiredProposals()` and `enforceProposalCap()` skip `in_review` proposals.
- **Auto-vote + early resolution** can cause instant proposal approval on single-node networks. This is by design, not a bug.
- **Phase 73 auto-approve for upgrades** is distinct from the Phase 33 early resolution. Early resolution resolves when all known nodes have voted. Auto-approve skips voting entirely when the network is small enough that governance adds no security value.
- **upgradePayload MUST be persisted to SQLite** (commit `e886ffcb`): `stmtInsertProposal` includes `upgrade_payload` (JSON-stringified `{commitHash, description}`). `loadFromDatabase()` restores it on restart. `checkForMissedUpgrades` in UpgradeProtocol skips proposals without `commitHash` — if `upgradePayload` is not persisted, nodes can never catch up after a restart. Migration: `ALTER TABLE governance_proposals ADD COLUMN upgrade_payload TEXT DEFAULT ''`.

## Key Files
- `packages/node/src/governance.ts` — GovernanceSync class (all Phase 30 logic + Phase 33 auto-vote/early resolution)
- `packages/node/src/reputation-governance.ts` — ReputationWeightedGovernance (Phase 12.4)
- `packages/shared/src/types.ts` — GovernanceProposal, ProposalReview, ReviewSummary, ReviewerCandidacy types
- `packages/node/src/index.ts` — Wires PaymentGate + AgentManager to governance
- `genome/rules/governance-tiers.md` — Two-tier governance architecture rule
