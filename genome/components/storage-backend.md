---
id: storage-backend
type: service
domain: infrastructure
entry: packages/node/src/storage-backend.ts
dependencies: [thread-store, user-accounts, project-store, revenue-engine, contribution-tracker]
created: 2026-02-22
last_verified: 2026-02-22
---

# StorageBackend — Stateless Nodes, Durable Data

## Why This Exists

Nodes are stateless compute proxies. They process requests, run AI agents, and coordinate the P2P network. They do NOT permanently store user data. User data (threads, messages, accounts, projects, revenue, contributions) lives on internet infrastructure — encrypted, durable, accessible from any device via any node.

This is the architectural implementation of the P2P-First rule: "P2P is for the brain, not every byte." See `genome/rules/p2p-first.md`. For the full data classification, see `genome/rules/data-residency.md`.

## What It Does

Provides the storage abstraction for all user data. Two implementations:

1. **MongoStorageBackend** (`mongo-backend.ts`) — Direct MongoDB connection. Used on compute nodes (EC2) that have `PANDO_STORAGE_URL`.
2. **P2PStorageBackend** (`p2p-storage-backend.ts`) — Proxies all storage operations via P2P request-reply to a compute node with MongoDB. Used on untrusted nodes (user PCs, relay nodes) that do NOT have MongoDB.

**Every node gets a StorageBackend.** Compute nodes get MongoStorageBackend (direct). User nodes get P2PStorageBackend (proxied). ThreadStore, ProjectStore, etc. always initialize — no node is without storage.

**LocalStorageBackend was deleted in Phase 57.** The file `storage-backend.ts` contains only the `StorageBackend` interface.

## Interface

```typescript
interface StorageBackend {
  init(): Promise<void>
  close(): Promise<void>
  putRecord(collection: string, key: string, data: Record<string, any>): Promise<void>
  getRecord(collection: string, key: string): Promise<Record<string, any> | null>
  queryRecords(collection: string, filter: Record<string, any>, options?: { limit?: number; sort?: Record<string, 1 | -1> }): Promise<Record<string, any>[]>
  deleteRecord(collection: string, key: string): Promise<void>
  listRecords(collection: string, filter?: Record<string, any>): Promise<Record<string, any>[]>
  pushToArray(collection: string, key: string, field: string, value: any): Promise<void>
}
```

## Key Method: pushToArray

Atomically appends a value to an array field in a document. MongoDB uses `$push` with `upsert: true`. This replaced the racy read-modify-write pattern that caused message loss.

## What Uses It

| Consumer | Collections | Data Type | Phase |
|---|---|---|---|
| ThreadStore | `threads`, `messages` | Chat threads and messages | 42 |
| ProjectStore | `projects`, `project_collaborators`, `project_invites`, `project_transfers`, `project_deployments`, `project_ratings`, `content_reports` | Project metadata and collaboration | 44 |
| RevenueEngine | `project_revenue`, `revenue_distributions`, `project_subscriptions` | Revenue recording and billing | 44 |
| ContributionTracker | `project_contributions`, `contribution_scores` | Contributor tracking and scoring | 44 |

### Phase 44 Collections Detail

| Collection | `_id` Strategy | Source | Indexes |
|---|---|---|---|
| `projects` | project ID | ProjectStore | owner_id, status, visibility, updated_at, compound (visibility+status) |
| `project_collaborators` | `{projectId}:{userId}` | ProjectStore | project_id, user_id |
| `project_invites` | invite ID | ProjectStore | code (unique), project_id |
| `project_transfers` | transfer ID | ProjectStore | project_id, status |
| `project_deployments` | deployment ID | ProjectStore | project_id |
| `project_ratings` | `{projectId}:{userId}` | ProjectStore | project_id |
| `content_reports` | report ID | ProjectStore | project_id, status, reporter_id |
| `project_revenue` | revenue ID | RevenueEngine | project_id, created_at |
| `revenue_distributions` | distribution ID | RevenueEngine | project_id |
| `project_subscriptions` | `{projectId}:{userId}` | RevenueEngine | project_id, user_id, expires_at |
| `project_contributions` | contribution ID | ContributionTracker | project_id, user_id, verified |
| `contribution_scores` | `{projectId}:{userId}` | ContributionTracker | project_id |

## What Does NOT Use It (stays on node)

| Data | Why |
|---|---|
| Identity keys (`~/.pando/identities/`) | P2P state — must be local for signing |
| Ledger (`~/.pando/ledger.db`) | P2P state — synced via GossipSub |
| Governance (proposals, votes) | P2P state — synced via GossipSub |
| Node config (api-keys, guardrails) | Node-local configuration |
| Reputation | P2P broadcast — aggregated from network |

## Two-Tier Storage Architecture (Phase 83)

```
COMPUTE NODE (EC2)                    USER NODE (PC / Relay)
┌──────────────────────┐              ┌──────────────────────┐
│ MongoStorageBackend   │◄── P2P ────│ P2PStorageBackend     │
│ (direct MongoDB)      │  storage   │ (proxies to compute)  │
│                       │  proxy     │                       │
│ Also serves:          │            │ ThreadStore           │
│ pando/storage-proxy   │            │ ProjectStore          │
│ P2P handler           │            │ RevenueEngine         │
│                       │            │ ContributionTracker   │
└───────┬──────────────┘              └──────────────────────┘
        │
   ┌────▼────┐
   │ MongoDB │
   └─────────┘
```

**P2PStorageBackend** finds compute peers via `CapabilityRegistry` (`storageBackend: 'mongodb'`), sends `pando/storage-proxy` requests with method + args, returns results. Sticky peer affinity for consistent routing. Failover to next peer on timeout (15s, up to 3 attempts).

**Security:**
- P2PStorageBackend does NOT expose `getDb()` — CredentialStore only initializes on compute nodes
- Collection blocklist: `pando_credentials` blocked at handler level
- Method allowlist: only the 6 StorageBackend CRUD methods allowed through proxy

## Configuration

```bash
# Compute nodes: set PANDO_STORAGE_URL → MongoStorageBackend (direct)
PANDO_STORAGE_URL=mongodb+srv://user:pass@cluster.mongodb.net/pando

# User nodes: no PANDO_STORAGE_URL → P2PStorageBackend (auto, proxies to compute)
```

## Privacy

All data is AES-256-GCM encrypted before it reaches any StorageBackend (Phase 41). The storage backend only sees encrypted blobs with opaque keys.

## Status

**Phase 42: DONE + E2E VERIFIED.** ThreadStore + UserAccounts rewired.
**Phase 44: Data Residency.** ProjectStore + RevenueEngine + ContributionTracker rewired. 12 new collections, all with MongoDB indexes.
**Phase 57: Clean Data Architecture.** LocalStorageBackend deleted. MongoDB is single source of truth.
**Phase 83: P2PStorageBackend.** Every node gets a StorageBackend. User nodes proxy to compute nodes via P2P. No more 503s for missing storage.

## Key Files

- `packages/node/src/storage-backend.ts` — StorageBackend interface
- `packages/node/src/mongo-backend.ts` — MongoStorageBackend (direct MongoDB, includes `createIndexes()` for all 16 collections)
- `packages/node/src/p2p-storage-backend.ts` — P2PStorageBackend (proxies to compute nodes via P2P)
