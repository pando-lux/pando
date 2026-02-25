---
id: revenue-engine
type: service
domain: economy
entry: packages/node/src/revenue-engine.ts
depends_on: [ledger, project-store, storage-backend]
depended_by: [api-server]
exposes:
  - init() — create tables and indexes
  - recordRevenue(projectId, source, amount, payerId) — record a revenue event
  - getProjectRevenue(projectId, opts?) — query revenue with optional time range
  - getRevenueSummary(projectId) — total, this month, last month, by source
  - distributeRevenue(projectId, projectStore) — distribute undistributed revenue to stakeholders
  - createSubscription(projectId, userId, tier, priceLux, durationDays) — create/update subscription
  - getSubscription(projectId, userId) — get user's subscription
  - processSubscriptionRenewals() — auto-renew expired subscriptions
  - chargeUsageFee(projectId, userId, amount, description?) — immediate usage charge
  - getDistributionHistory(projectId) — past distribution records
rules: [data-residency]
last_verified: 2026-02-22
---

# Revenue Engine (Phase 31.4 + Phase 44 Data Residency + Phase 57 Clean Data)

## What It Does

Usage metering, revenue collection, and automatic Lux distribution for projects. Handles all money flows: recording revenue events, calculating summaries, distributing earnings to stakeholders, managing subscriptions, and charging usage fees.

## MongoDB-Primary Storage (Phase 57)

RevenueEngine uses MongoDB as single source of truth, following the same pattern as ProjectStore and ThreadStore.

- **Writes**: MongoDB first (awaited), then SQLite cache update. If MongoDB fails, the operation fails — no silent data loss.
- **Reads**: Async methods read from MongoDB. Sync methods read from SQLite cache.
- **StorageBackend required**: RevenueEngine cannot be instantiated without a StorageBackend.

```
Constructor: new RevenueEngine(db, ledger, storageBackend)
  - db: SQLite database (cache)
  - ledger: PandoLedger (for Lux transfers — stays P2P)
  - storageBackend: StorageBackend (required — MongoDB)
```

### MongoDB Collections (3)

| Collection | `_id` Strategy | Notes |
|---|---|---|
| `project_revenue` | revenue ID | Revenue event records |
| `revenue_distributions` | distribution ID | Distribution payout records |
| `project_subscriptions` | `{projectId}:{userId}` | Active subscriptions |

**Important split:** Revenue RECORDING goes to MongoDB (user data). Lux DISTRIBUTION (actual transfers) uses the P2P ledger. Economy is network state, not user data.

## How It Works

- **Storage:** MongoDB-primary. SQLite as read cache. See `genome/rules/data-residency.md`. Three tables/collections: `project_revenue`, `revenue_distributions`, `project_subscriptions`.
- **Revenue sources:** `usage_fee`, `subscription`, `tip`, `one_time`.
- **Distribution splits by project type:**
  - **Private:** 85% owner, 10% compute (NETWORK), 5% relay (NETWORK)
  - **Shared:** Configurable via `project.revenueConfig.shares` (custom per-user fractions), falls back to equal split among all collaborators
  - **Public:** 50% contributors, 30% network treasury, 15% compute, 5% relay
- **Distribution mechanics:** `distributeRevenue()` finds all revenue since the last distribution, calculates shares, executes actual Lux transfers via the ledger, and records the distribution. If a public project has no non-owner contributors, the owner receives the contributor share.
- **Subscriptions:** `createSubscription()` records payment as revenue immediately. `processSubscriptionRenewals()` auto-renews expired subscriptions if the user has sufficient balance; disables auto-renew if they can't afford it.
- **Usage fees:** `chargeUsageFee()` deducts from user balance and records as revenue in one step.
- **Precision:** All Lux amounts rounded to 8 decimal places to avoid floating-point drift.

## API Routes (in api-server.ts)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /projects/:id/revenue | User token | Revenue summary |
| GET | /projects/:id/revenue/history | User token | Revenue event history (?since=&until=) |
| POST | /projects/:id/revenue/distribute | Owner/admin token | Trigger distribution |
| GET | /projects/:id/revenue/distributions | User token | Distribution history |

## Key Files
- `packages/node/src/revenue-engine.ts` — RevenueEngine class (522 lines)
- `packages/node/src/api-server.ts` — Revenue API routes
- `packages/node/src/index.ts` — Init + wiring
- `packages/shared/src/types.ts` — RevenueSource, ProjectRevenue, RevenueSummary, DistributionResult, ProjectSubscription types
