---
id: contribution-tracker
type: service
domain: economy
entry: packages/node/src/platform/contribution-tracker.ts
depends_on: [ledger, storage-backend]
depended_by: [api-server, revenue-engine]
exposes:
  - init() — create tables and indexes
  - recordContribution(projectId, userId, type, description?, weight?, agentId?) — record unverified contribution
  - verifyContribution(contributionId, verifiedBy) — mark as verified by manager/admin
  - getContributions(projectId, opts?) — query with optional userId and verified filters
  - calculateScores(projectId) — recalculate all scores with 10% monthly decay
  - getScores(projectId) — sorted by decayed_score descending
  - getScore(projectId, userId) — single user's score
  - getRevenueShares(projectId) — proportional shares based on decayed scores
rules: [data-residency]
last_verified: 2026-02-22
---

# Contribution Tracker (Phase 31.9 + Phase 44 Data Residency + Phase 57 Clean Data)

## What It Does

Tracks verified work contributions to projects — who did what, when, and how much it matters. Calculates time-decayed contribution scores and derives proportional revenue shares for fair compensation.

## MongoDB-Primary Storage (Phase 57)

ContributionTracker uses MongoDB as single source of truth, following the same pattern as ProjectStore.

- **Writes**: MongoDB first (awaited), then SQLite cache update. If MongoDB fails, the operation fails — no silent data loss.
- **Reads**: Async methods read from MongoDB. Sync methods read from SQLite cache.
- **StorageBackend required**: ContributionTracker cannot be instantiated without a StorageBackend.

```
Constructor: new ContributionTracker(db, storageBackend)
  - db: SQLite database (cache)
  - storageBackend: StorageBackend (required — MongoDB)
```

### MongoDB Collections (2)

| Collection | `_id` Strategy | Notes |
|---|---|---|
| `project_contributions` | contribution ID | Individual contribution records |
| `contribution_scores` | `{projectId}:{userId}` | Aggregated per-user scores |

## How It Works

- **Storage:** MongoDB-primary. SQLite as read cache. See `genome/rules/data-residency.md`. Two tables/collections: `project_contributions` and `contribution_scores`.
- **Contribution types:** `code`, `review`, `test`, `design`, `management`, `documentation`.
- **Verification:** Contributions start unverified. Owner/admin calls `verifyContribution()` to mark as verified. Only verified contributions count toward scores.
- **Decay formula:** `score = weight * 0.9^(monthsSinceContribution)` — 10% monthly decay. Recent work matters more than old work. Recalculated on demand via `calculateScores()`.
- **Weight:** Each contribution has a configurable weight (default 1.0). Higher weight = bigger impact on score.
- **Revenue shares:** `getRevenueShares()` converts decayed scores into proportional fractions (0-1) that sum to 1.0. Used by RevenueEngine for public project distributions.
- **Agent tracking:** Optional `agentId` field tracks which AI agent performed the work.

## API Routes (in api-server.ts)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /projects/:id/contributions | User token | List contributions (?userId=&verified=) |
| POST | /projects/:id/contributions | User token (collaborator) | Record contribution |
| POST | /projects/:id/contributions/:contribId/verify | Owner/admin token | Verify contribution |
| GET | /projects/:id/contributions/scores | User token | Get scores + revenue shares (?recalculate=true) |

## Key Files
- `packages/node/src/contribution-tracker.ts` — ContributionTracker class (286 lines)
- `packages/node/src/api-server.ts` — Contribution API routes
- `packages/node/src/index.ts` — Init + wiring
- `packages/shared/src/types.ts` — ContributionType, ProjectContribution, ContributionScore, RevenueShare types
