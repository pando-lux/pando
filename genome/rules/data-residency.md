---
id: data-residency
type: rule
domain: architecture
created: 2026-02-22
last_verified: 2026-02-25
---

# Data Residency — The Three Buckets Rule

## The Rule

Every piece of data in Pando belongs to exactly one of three buckets. No exceptions.

| Bucket | Where | Syncs How | Survives Node Death? | Examples |
|---|---|---|---|---|
| **User Data** | MongoDB (StorageBackend) | Any node reads/writes via StorageBackend interface | Yes | Projects, threads, messages, collaborators, invites, transfers, deployments, ratings, reports, revenue, distributions, subscriptions, contributions, scores |
| **Network State** | SQLite + P2P GossipSub | Replicated to all nodes automatically | Yes (rebuilds from peers) | Ledger (accounts, auth/username/password_hash, balances, transactions), governance (proposals, votes), capabilities, content registry, reputation, resources |
| **Node-Local** | Local SQLite/filesystem | Doesn't sync | No (disposable) | Key store (`auth-local.db`), identity keys, agent workspaces, logs, metrics, monitor audit trail, guardrails config, task file locks, known-peers cache |

## The Decision Test

> "If this node burns down, does a user lose something they care about?"

- **Yes** -> MongoDB (User Data bucket)
- **No, but other nodes need it** -> P2P GossipSub (Network State bucket)
- **No, and nobody else needs it** -> Local (Operational bucket)

## Why This Matters

Without this rule, user data gets trapped on individual nodes. This breaks three critical properties:

1. **Durability** — Node dies, user data dies with it
2. **Portability** — User connects to different node, can't see their projects
3. **Multi-user** — Two users on different nodes can't see each other's shared projects

## Scenarios

### Node death
A Lightsail node crashes and its disk is wiped.
- **User Data**: Safe in MongoDB. User reconnects via any other node, sees all projects, threads, messages.
- **Network State**: Rebuilds from peers via GossipSub. Ledger, governance, capabilities all re-sync.
- **Operational**: Lost. Agent workspaces, logs, metrics gone. Acceptable — these are ephemeral.

### User switches nodes
A user who was using the Windows node now connects via the Mac node.
- All their projects, threads, collaborations visible immediately (read from MongoDB).
- Their Lux balance visible (ledger synced via P2P).
- Agent workspaces from previous node not visible (operational, disposable).

### Scale to 10K users
10,000 users across 50 nodes.
- MongoDB handles all user data reads/writes. Nodes are stateless proxies.
- Each node has the full ledger (P2P replicated). Small: ~10K accounts, ~100K transactions.
- No node stores any user data locally. Adding/removing nodes doesn't affect data availability.

### MongoDB goes down
MongoDB Atlas has a temporary outage.
- **Writes**: Fail. API routes for user data return 503. Users see "storage unavailable".
- **Reads**: Fail for user data. P2P data (balance, governance) still works.
- **No fallback**: There is no local-only mode. Nodes without StorageBackend cannot serve user data — they return 503 for those endpoints. P2P features (ledger, governance, resources) still work.
- **Recovery**: When MongoDB comes back, all writes resume. No data loss (writes were rejected, not silently dropped).

## What Goes Where (Complete List)

### User Data (MongoDB — single source of truth)

| Collection | Source | Phase |
|---|---|---|
| `threads` | ThreadStore | 42 |
| `messages` | ThreadStore | 42 |
| `projects` | ProjectStore | 44 |
| `project_collaborators` | ProjectStore | 44 |
| `project_invites` | ProjectStore | 44 |
| `project_transfers` | ProjectStore | 44 |
| `project_deployments` | ProjectStore | 44 |
| `project_ratings` | ProjectStore | 44 |
| `content_reports` | ProjectStore | 44 |
| `project_revenue` | RevenueEngine | 44 |
| `revenue_distributions` | RevenueEngine | 44 |
| `project_subscriptions` | RevenueEngine | 44 |
| `project_contributions` | ContributionTracker | 44 |
| `contribution_scores` | ContributionTracker | 44 |

Note: `user_accounts` and `auth_sessions` removed from MongoDB in Phase 56 — auth data (username, password_hash, is_claimed) moved to P2P-synced ledger accounts table. Phase 86 replaced local `auth_sessions` table with stateless JWTs signed by each node's Ed25519 key — sessions are no longer stored anywhere (not MongoDB, not SQLite). Verification is purely cryptographic via `peerIdFromString().publicKey.verify()`. The `auth_sessions` table in `auth-local.db` is dead code.

### Network State (SQLite + P2P)

| Table | Source | Sync |
|---|---|---|
| `accounts` (incl. username, password_hash, is_claimed) | Ledger | GossipSub (ACCOUNT_CLAIM) |
| `transactions` | Ledger | GossipSub |
| `emissions` | Ledger | GossipSub |
| `governance_*` | GovernanceSync | GossipSub |
| `capabilities` | CapabilityRegistry | GossipSub |
| `content_registry` | ContentRegistry | GossipSub |
| `reputation` | ReputationManager | GossipSub |
| `resources` | ResourceRegistry | GossipSub |

### Operational (Local only)

| Location | Source | Purpose |
|---|---|---|
| `~/.pando/auth-local.db` | UserAccountStore | Key store only (Phase 86: `auth_sessions` table is dead code — sessions are stateless JWTs) |
| `~/.pando/agents/` | AgentManager | Ephemeral agent workspaces |
| `~/.pando/logs/` | FileLogger | Node console logs |
| `~/.pando/monitor/` | HealthMonitor | Metrics, audit trail |
| `~/.pando/guardrails.json` | Guardrails | Local safety config |
| `~/.pando/agent/tasks.json` | TaskQueue | Local task queue |
| `~/.pando/api-token` | ApiServer | Local auth token |

## Implementation Pattern (Phase 57 — MongoDB-Primary)

All stores that hold User Data follow the MongoDB-primary pattern (rewritten in Phase 57):

```typescript
class SomeStore {
  private db: Database.Database;
  private backend: StorageBackend;

  constructor(db: Database.Database, storageBackend: StorageBackend) {
    this.db = db;
    this.backend = storageBackend; // REQUIRED — no optional
  }

  // Write: MongoDB FIRST (awaited), then SQLite cache update
  async createThing(opts: ThingOpts): Promise<Thing> {
    // 1. MongoDB write (primary, awaited)
    await this.backend.putRecord('things', id, data);
    // 2. SQLite cache (sync, best-effort)
    try {
      this.db.prepare('INSERT OR REPLACE INTO ...').run(...);
    } catch (err) {
      console.error('[SomeStore] SQLite cache update failed:', err);
    }
    return thing;
  }

  // Read: SQLite cache for performance (hydrated from MongoDB on startup)
  getThing(id: string): Thing | null {
    return this.db.prepare('SELECT ...').get(id);
  }

  // Startup: hydrate SQLite cache from MongoDB
  async loadFromBackend(): Promise<void> {
    const records = await this.backend.listRecords('things');
    for (const record of records) {
      this.db.prepare('INSERT OR REPLACE INTO ...').run(...);
    }
  }
}
```

### Write-Order Rule

**MongoDB first, SQLite second.** This is the opposite of the old fire-and-forget pattern. MongoDB is the source of truth. SQLite is a read-performance cache. If MongoDB write fails, the operation fails — no silent data loss.

### No StorageBackend = No User Data

Nodes without MongoDB still participate in P2P features (ledger, governance, resources) but return **503 Service Unavailable** for all user data endpoints (projects, threads, chat).

## Related Rules

- `genome/rules/p2p-first.md` — P2P is for the brain, not every byte
- `genome/components/storage-backend.md` — StorageBackend interface and implementations
