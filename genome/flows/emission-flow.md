---
id: emission-flow
components: [emission-witness, ledger, network]
rules: [budget-enforcement, two-laws]
trigger: work_completed
---

# Lux Emission Flow

How new Lux is minted when work is verified.

## Steps

```
1. WORK DONE
   Node completes verifiable work:
   - Task completed by scheduler
   - Uptime epoch reached (10 min)
   - API key contributed
   - Governance proposal accepted
   - Vote cast
   → Work proof generated

2. PROPOSE EMISSION
   EmissionWitness.propose(peerId, workType, workProof)
   Creates emission proposal with Ed25519 signature.
   Rate limited: 10 proposals/hour per node.
   → Proposal broadcast to peers

3. PEER WITNESSES
   Connected peers receive proposal.
   Each peer validates: work proof is legitimate, not duplicate.
   If valid: peer signs attestation with own Ed25519 key.
   → Attestations collected

4. QUORUM CHECK
   Requires 2+ unique peer attestations for quorum.
   Bootstrap fallback: if network has < 3 nodes, single attestation accepted.
   5-minute timeout: if quorum not reached, proposal expires.
   Anti-spoofing: attestation includes peer ID + timestamp + signature.
   → Quorum reached or proposal expires

5. MINT LUX
   Recipient determined by node.getRewardRecipient() (Phase 48):
     - If operator logged in → operator's peerId receives Lux
     - If no operator → no emission (node is relay-only, no rewards)
   Emission applied to ledger: NETWORK account → recipient account.
   Transaction recorded with emission type and witnesses.
   Daily cap enforced: 500 Lux max per node per day.
   Early multiplier applied if applicable.
   → Lux in recipient's balance

6. SYNC
   Emission transaction broadcast via pando/transactions topic.
   All nodes apply the emission to their local ledger.
   → Network-wide consistency
```
