---
id: governance-tiers
type: rule
domain: governance
depends_on: [governance, agent-manager, project-types]
last_verified: 2026-02-20
---

# Rule: Two-Tier Governance

## The Rule

Governance operates at two tiers with different voting scopes:

1. **Network governance** — changes to node software, P2P protocols, or shared infrastructure. ALL nodes vote.
2. **Project governance** — changes to a specific project. Only project STAKEHOLDERS vote.

The manager agent classifies which tier applies based on the request and project context. Infrastructure enforces the scope.

## Why Two Tiers

A network of 100 nodes should not all vote on whether a chess game project should add dark mode. That is a project-level decision for the chess game's collaborators. But all 100 nodes SHOULD vote on whether to change the ledger sync algorithm, because that affects every node.

Without tier separation:
- Every project change becomes a network-wide vote (spam, voter fatigue)
- Small teams cannot iterate quickly on their own projects
- A node operator in Japan votes on a private team project in Brazil (irrelevant)

With tier separation:
- Network changes get full network scrutiny (high security)
- Project changes get fast stakeholder-only decisions (high velocity)
- Both use the same GovernanceSync infrastructure (consistent tooling)

## Classification Rules

The manager decides which tier based on:

| Signal | Tier | Reasoning |
|---|---|---|
| Change touches `packages/` code | Network | Node software affects all nodes |
| Change touches `genome/` | Network | Architecture docs affect all agents |
| Change modifies P2P, ledger, or sync | Network | Core protocol affects all nodes |
| Change is to a private project | None | Owner decides, no governance needed |
| Change is to a shared project | Project (or owner) | Owner decides, or collaborators if contentious |
| Change is to a public project | Project | Only collaborators/contributors vote |
| Conflicting instructions from multiple users | Project | Governance resolves the conflict |
| Budget expansion for public project | Network | Network funds are being requested |

**Edge cases:**
- A public project that requires a node software change (e.g., "add GPU support to the network so our ML project can run") needs BOTH tiers: network governance for the node change, project governance for the project decision.
- The manager handles this by creating two separate proposals.

## Security Model

### Why this prevents manipulation

**Compromised node scenario:** A malicious node proposes a backdoor in the ledger code.
- Network governance: ALL nodes vote. The malicious node is 1 of N. Majority honest nodes reject it.
- Phase 30 AI reviewers: randomly selected nodes spawn reviewer agents. A reviewer on a different machine is a different AI instance with no shared context. It evaluates the proposal independently.
- Proposal staking (10 Lux): creates economic cost for spam attacks.

**Compromised project scenario:** A malicious collaborator proposes harmful changes to a public project.
- Project governance: only collaborators vote. If the project has 5 collaborators and 4 are honest, the malicious change is rejected.
- Contribution-weighted voting (Phase 31): active contributors have more weight than passive ones. A new malicious joiner has low weight.

### Where security is weak (acknowledged)

**Single-node networks:** The proposer, voter, and reviewer are all the same AI on the same machine. Governance is ceremonial. This is accepted for development and single-operator deployments. It is NOT a bug -- it is the expected behavior when there is only one node. Real security requires 3+ nodes.

**Same-node reviewer:** On the same node, a reviewer agent uses the same Claude Code model and training as the proposer. It may have the same biases. True independence requires reviewers running on different physical nodes with potentially different AI configurations. Phase 33.9 tests this.

**Sybil attacks:** A single operator running 10 nodes from the same machine could dominate votes. Mitigated by: IP dedup in reviewer selection (Phase 30), resource proofs (Phase 12), reputation scoring. Not fully solved -- a well-funded attacker with 10 distinct machines could still accumulate votes.

## Current Status

| Aspect | Status |
|---|---|
| Network governance (all nodes vote) | DONE — GovernanceSync, Phase 30 |
| Manager classification (node vs project) | DONE — Phase 33.0 |
| Auto-vote on own proposals | DONE — Phase 33.1 |
| Early resolution (all voted) | DONE — Phase 33.1 |
| Project governance (stakeholders only) | PLANNED — Phase 33.6 |
| Cross-node project membership | PLANNED — Phase 33.7 |
| Two-tier proposal routing | PLANNED — Phase 33.6 |

## Related

- `genome/components/governance.md` — GovernanceSync implementation details
- `genome/rules/project-types.md` — project type definitions (private/shared/public)
- `genome/roadmap.md` Phase 33 — full sub-phase breakdown
- `genome/history/decisions.md` — ADRs for single-node governance and manager self-vote
