---
id: payment-gate
type: service
domain: economy
entry: packages/node/src/core/payment-gate.ts
depends_on: [ledger]
depended_by: []
exposes:
  - estimateCost(complexity, category) — estimate Lux cost with breakdown (compute/storage/network)
  - canAfford(peerId, amount) — check if peer has sufficient balance
  - holdPayment(peerId, taskId, amount) — escrow Lux for a pending task
  - releasePayment(holdId, recipientPeerId) — pay executing node on completion
  - refundPayment(holdId) — return escrowed Lux on failure/cancellation
  - isFreeTier(category, complexity) — check if request is free
  - getPaymentHistory() — query payment records
rules: []
last_verified: 2026-02-18
---

# Payment Gate

## What It Does
Provides Lux payment gating for task execution. Users must have sufficient Lux to cover task costs. Payments are held in escrow during execution and released to the executing node on completion, or refunded on failure/cancellation.

## How It Works
- `estimateCost()` maps complexity levels to base costs: trivial=0, simple=0.1, moderate=1, complex=5, project=20 Lux. The cost is split into compute (70%), storage (10%), and network (20%). Categories in the free tier (`search`, `ledger`, `network`, `system`) always return 0.
- `holdPayment()` deducts from the peer's balance via `ledger.accounts.subtractBalance()` and creates a PaymentHold record with status `held`. Free tasks (amount <= 0) create zero-amount hold records.
- `releasePayment()` credits the recipient via `ledger.accounts.addBalance()` and marks the hold as `released`.
- `refundPayment()` credits the original payer back and marks the hold as `refunded`.
- Payment holds and history are persisted to `~/.pando/payment-holds.json` and `~/.pando/payment-history.json`.
- Uses the NETWORK escrow account conceptually, but actual balance operations go through the ledger's account store directly.

## Gotchas
- Uses a minimal `LedgerLike` interface (getBalance, subtractBalance, addBalance, exists) to stay decoupled from the full PandoLedger — but this means it bypasses transaction creation. Holds are not represented as ledger transactions.
- Payment holds file is loaded on construction; if the file is corrupted, holds are silently reset to empty.
- Payment holds now expire after 24 hours. Expiration is checked lazily on each `holdPayment()` and `getPaymentHistory()` call. Expired holds in `held` status are auto-refunded (Lux credited back to the original payer).
- The `generateId()` method uses `randomBytes(16).toString('hex')` for hold IDs.

## Key Files
- `packages/node/src/payment-gate.ts` — PaymentGate class
- `packages/shared/src/types.ts` — CostEstimate, PaymentHold, PaymentRecord types
