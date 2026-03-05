---
id: emission-witness
type: service
domain: economy
entry: packages/node/src/kernel/emission-witness.ts
depends_on: [ledger, network, sync]
depended_by: [security-monitor]
exposes:
  - propose(peerId, workType, workProof) — create and broadcast an emission proposal
  - start() — start cleanup timer (60s interval for expired proposals)
  - stop() — stop cleanup timer
  - setEmitCallback(cb) — set the callback that mints Lux (wraps ledger.rewardWork)
  - setNetwork(network) / setLedger(ledger) / setSync(sync) / setPrivateKey(key) — dependency injection
  - getPending() — get all pending proposals
  - getHistory() — get completed proposals (max 500)
  - getStats() — emission statistics (approved, rejected, expired, rate limits)
rules: []
last_verified: 2026-02-18
---

# Emission Witness

## What It Does
Implements witness-based Lux minting. Instead of nodes self-minting directly, emissions go through a proposal-witness-quorum flow where peer nodes must attest that work happened before Lux is minted.

## How It Works
- `propose()` creates an EmissionProposal with a random 16-byte hex ID, broadcasts it via GossipSub on `pando/emissions`. Rate-limited to 10 proposals per node per hour. Anti-spoofing: proposer must be a known peer or self.
- Peer nodes receive proposals, validate them, and sign a `WitnessAttestation` with Ed25519 (canonical payload: proposalId + approved + witnessPeerId + timestamp).
- Once 2+ independent witnesses attest (quorum), the emission is finalized via `emitCallback` which calls `ledger.rewardWork()` + broadcasts the transaction.
- Bootstrap fallback: if the network has fewer than 3 nodes, proposals auto-approve after a timeout without requiring witness quorum.
- Proposals expire after 5 minutes. A cleanup timer runs every 60 seconds to expire stale proposals and prune history to 500 entries.
- Anti-replay: tracks processed attestation keys (`witnessPeerId:proposalId`) in a Set to avoid double-counting.

## Gotchas
- The `emitCallback` must be set via `setEmitCallback()` before any proposal can be finalized — otherwise quorum is reached but no Lux is actually minted.
- Bootstrap fallback (auto-approve for <3 nodes) is a security trade-off: small networks can self-mint without witnesses.
- Rate limit tracking is persisted to `~/.pando/emission-rates.json`. On startup, the file is loaded and entries still within the 1-hour window are restored. On each proposal, the file is updated. File I/O errors degrade gracefully to in-memory only.
- `handleMessage()` is wrapped in a try-catch to prevent malformed GossipSub payloads from crashing the node.
- The `amount` field on proposals is set to 0 at creation and filled by the ledger on finalization (the ledger determines the actual reward amount based on work type).

## Key Files
- `packages/node/src/emission-witness.ts` — EmissionWitness class
- `packages/node/src/sync.ts` — LedgerSync (broadcasts finalized transactions)
- `packages/node/src/security-monitor.ts` — detects emission abuse patterns
