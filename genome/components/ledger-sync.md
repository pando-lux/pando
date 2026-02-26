---
id: ledger-sync
type: infrastructure
entry: packages/node/src/kernel/sync.ts
depends_on: [network, ledger]
depended_by: [emission-witness, pando-node]
exposes:
  - start()
  - broadcastTransaction(tx)
  - onTransaction(callback)
  - onActivity(callback)
  - broadcastActivity(record)
rules: []
last_verified: 2026-02-18
---

# Ledger Sync

## What It Does
Distributed ledger synchronization via GossipSub. Ensures all nodes eventually converge on the same transaction history through real-time broadcasting and catch-up sync on peer connect.

## How It Works
- Subscribes to three GossipSub topics on start: `pando/transactions` (real-time tx broadcasts), `pando/sync` (catch-up request/response), `pando/activity` (agent activity records).
- When a local transaction occurs, `broadcastTransaction()` publishes it to all peers. The local tx ID is pre-marked as processed to prevent re-application.
- On new peer connect, sends a sync request after 5-second delay (with a 30-second retry to handle GossipSub mesh forming delay). The request includes the local transaction count so responders can detect large gaps.
- Sync responders compare the requester's tx count to their own. Any gap triggers a full-history response (up to 2000 transactions from genesis). Otherwise, sends recent transactions only (up to 500).
- Incoming transactions are deduplicated by ID (`processedTxs` Set), validated for basic fields, signature-verified if signed, and applied via `ledger.applyRemoteTransaction()`. Unknown accounts are auto-registered.
- Activity records follow the same broadcast/sync pattern on the `pando/activity` topic.

## Gotchas
- Dedup is in-memory only (`processedTxs` Set). On node restart, recently-seen transactions will be re-processed (idempotent via ledger's own dedup).
- If the local ledger has <= 1 transaction at startup, `lastSyncTimestamp` is set to 0 (epoch), triggering a full history request on first peer connect. This handles imported-identity scenarios.
- Sync responses are broadcast to the entire topic, not targeted to the requester -- all peers receive the response, which can cause redundant processing.
- Unsigned/unverifiable TRANSFER transactions are now REJECTED (both in real-time and catch-up sync). Only EMISSION transactions are accepted without signature verification (they use witness-based verification instead). This prevents forged or replayed transfers from being applied to the local ledger.

## Key Files
- `packages/node/src/sync.ts` -- LedgerSync class
- `packages/node/src/network.ts` -- PandoNetwork (GossipSub transport)
- `packages/ledger/src/index.ts` -- PandoLedger (applyRemoteTransaction)
- `packages/shared/src/types.ts` -- Transaction, ActivityRecord, MessageType
