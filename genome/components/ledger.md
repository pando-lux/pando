---
id: ledger
type: data-store
domain: economy
entry: packages/ledger/src/index.ts
depends_on: []
depended_by: [emission-witness, payment-gate, sync, api-server, governance, security-monitor]
exposes:
  - registerNode(peerId, publicKey) — create account with genesis allocation
  - transfer(from, to, amount, relay?) — transfer Lux with 0.1% relay fee
  - applyRemoteTransaction(tx) — apply pre-validated remote tx from GossipSub sync
  - getTransactionsSince(timestamp, limit?) — query recent transactions
  - rewardWork(peerId, workType, workProof) — mint new Lux up to hard cap
  - registerApiKey(peerId, provider, monthlyCap) — register API key contribution
  - recordApiUsage(contributionId, costUsd, workProof) — record API usage + reward
  - getNetworkStats() — total supply, accounts, transactions, relay fees, burned
  - getPeerSummary(peerId) — account + recent txs + API contributions
  - recordActivity(record) — insert agent activity event
  - getActivity(opts?) — query activity records with filters
  - getActivityStats(windowMs) — aggregated activity by action and agent
  - createSnapshot() / listSnapshots() / restoreSnapshot() — ledger backup/restore
rules: []
last_verified: 2026-02-18
---

# Ledger

## What It Does
SQLite-backed ledger that stores accounts, balances, transactions, API contributions, and agent activity for the Pando network. Every node has its own local ledger that syncs with peers via GossipSub.

## How It Works
- Constructor opens SQLite via `better-sqlite3` at `~/.pando/ledger.db` (or custom `dataDir`). Creates three sub-stores: `AccountStore`, `TransactionStore`, `ContributionStore`.
- `registerNode()` creates an account with genesis allocation (early multiplier: accounts 1-100 get 5x, 101-1000 get 3x, etc.).
- `transfer()` moves Lux between peers with a 0.1% relay fee paid to the relay node. Validates sender balance.
- `applyRemoteTransaction()` credits the recipient without checking sender balance — used for transactions received via GossipSub that have already been validated by the originating node.
- `rewardWork()` mints new Lux from the NETWORK account up to the 10B hard cap. Enforces daily cap of 500 Lux per node.
- Activity recording uses `INSERT OR IGNORE` for idempotent writes (dedup by activity ID).

## Gotchas
- `applyRemoteTransaction()` trusts the originating node — it does not re-validate sender balance. Emission witness and security monitor provide the trust layer.
- On Mac, after a Node.js version upgrade you must run `npm rebuild better-sqlite3` or the native module will segfault.
- Snapshot restore replaces the in-memory state but does not handle open file handles — the node should be restarted after restoring.
- Hard cap of 10,000,000,000 Lux is enforced in TransactionStore, not in PandoLedger directly.

## Key Files
- `packages/ledger/src/index.ts` — PandoLedger class (main entry)
- `packages/ledger/src/accounts.ts` — AccountStore (create, get, balance ops)
- `packages/ledger/src/transactions.ts` — TransactionStore (transfer, emit, query)
- `packages/ledger/src/contributions.ts` — ContributionStore (API key tracking)
- `packages/ledger/src/database.ts` — openDatabase() (SQLite init + migrations)
