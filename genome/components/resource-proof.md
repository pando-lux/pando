---
id: resource-proof
type: safety
entry: packages/node/src/resource-proof.ts
depends_on: [request-reply, network]
depended_by: [pando-node]
exposes:
  - challengeStorage(peerId)
  - challengeCompute(peerId)
  - challengeBandwidth(peerId)
rules: []
last_verified: 2026-02-18
---

# Resource Proof Challenger

## What It Does
Periodic challenge system that verifies nodes actually provide the resources they claim. Sends cryptographic proof challenges over the P2P network and scores peers based on their responses.

## How It Works
- Uses `RequestReplyManager` to send three types of challenges to peers:
  - **Storage challenge** -- sends a random 1KB payload, expects the SHA-256 hash back within 5 seconds.
  - **Compute challenge** -- sends a seed and asks for 1000 iterative SHA-256 hashes, expects the correct result within 10 seconds.
  - **Bandwidth challenge** -- sends a nonce, expects it echoed back within 5 seconds.
- Each challenge produces a `ProofResult` (pass/fail, response time, details). Results are accumulated per peer with a cap of 50 per peer.
- Peer scores (`ProofScore`) are computed using a decay factor of 0.95, giving more weight to recent challenges.
- Registers request handlers (`storage_challenge`, `compute_challenge`, `bandwidth_challenge`) so the local node can respond to incoming challenges from other peers.
- Scores are persisted at `~/.pando/security/proof-scores.json`, capped at 500 entries.

## Gotchas
- The challenge loop timer (`DEFAULT_CHALLENGE_INTERVAL_MS = 5 minutes`) must be explicitly started -- not auto-started on construction.
- Pre-computing the expected compute result (1000 iterative SHA-256 hashes) is done synchronously, which blocks the event loop briefly.
- Scores for peers who stop responding will decay over time but are never removed unless the cap is exceeded.
- The bandwidth challenge only measures round-trip latency, not actual throughput.

## Key Files
- `packages/node/src/resource-proof.ts` -- ResourceProofChallenger class
- `packages/shared/src/types.ts` -- ProofResult, ProofScore types
- `~/.pando/security/proof-scores.json` -- persisted peer scores
