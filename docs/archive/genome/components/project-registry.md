# Project Registry

> Phase 63 — P2P project metadata registry. Enables any node to validate project API keys and discover projects without MongoDB dependency.

## Purpose

Syncs project metadata across the P2P network via GossipSub. Stores API key hashes (SHA-256, never plaintext) so any node can validate Resource Proxy requests. Eliminates MongoDB as a requirement for project validation.

## Source

`packages/node/src/project-registry.ts`

## Dependencies

- `PandoNetwork` — GossipSub pub/sub
- `better-sqlite3` — local persistence in shared ledger.db
- `LedgerSync` — catch-up sync for new peers (projects included in SYNC_REQUEST/SYNC_RESPONSE)

## GossipSub

- **Topic:** `pando/projects`
- **Message types:** `PROJECT_REGISTER`, `PROJECT_UPDATE`, `PROJECT_ARCHIVE`
- **Dedup:** `type:projectId:timestamp` in processedIds Set (capped at 10K entries)

## SQLite Schema

Table: `project_registry` in ledger.db

| Column | Type | Description |
|--------|------|-------------|
| project_id | TEXT PK | Unique project identifier |
| name | TEXT | Project name |
| owner_peer_id | TEXT | PeerId of the node that created the project |
| owner_username | TEXT | Username of the project owner |
| api_key_hash | TEXT | SHA-256 hash of the project API key |
| visibility | TEXT | owner_only, collaborators, listed, featured |
| resource_ids | TEXT (JSON) | Array of ResourceRegistry resource IDs assigned |
| deployment_url | TEXT | Where the app is hosted (S3 URL, EC2 URL) |
| deployment_type | TEXT | s3, ec2, github-pages |
| description | TEXT | For marketplace display |
| status | TEXT | active, paused, archived |
| registered_at | INTEGER | Creation timestamp |
| updated_at | INTEGER | Last update timestamp |

Indexes: `api_key_hash` (for validation lookups), `owner_peer_id` (for ownership queries)

## API Key Security

- API keys are **never** stored or synced in plaintext
- On registration: `SHA-256(apiKey)` → stored as `api_key_hash`
- On validation: `SHA-256(incoming_key) === stored_hash`
- Any node can validate without seeing the actual key

## Key Methods

| Method | Description |
|--------|-------------|
| `registerProject()` | Hash API key, persist, broadcast to network |
| `updateProject()` | Update metadata, broadcast change |
| `archiveProject()` | Soft-delete, broadcast archive |
| `validateApiKey(key)` | Hash incoming key, find matching project |
| `applyRemoteRecord()` | Apply record from GossipSub or catch-up sync |
| `getAllProjects()` | Return all records (used by LedgerSync for catch-up) |
| `getListedProjects()` | Return visible marketplace projects |

## Integration Points

- **ProjectStore** (write-through bridge): When MongoDB creates/updates a project, ProjectStore calls `broadcastToP2P()` → ProjectRegistry broadcasts to network
- **LedgerSync** (catch-up): New peers receive all project records via SYNC_RESPONSE alongside transactions and claimed accounts
- **Resource Proxy** (`POST /resource-proxy/validate`): Uses `validateApiKey()` as primary lookup (P2P first, MongoDB fallback)
- **Marketplace**: Uses `getListedProjects()` to display projects from any node

## Data Flow

```
ProjectStore (MongoDB write) → broadcastToP2P callback → ProjectRegistry.registerProject()
  → persist to SQLite + memory cache
  → GossipSub broadcast on pando/projects
  → all peers receive → dedup → persist locally

New peer connects → LedgerSync catch-up → SYNC_RESPONSE includes projects
  → applyRemoteRecord() for each → persist locally
```

## Rules

- API key hash is immutable — if a key changes, archive old project and register new
- Records use last-writer-wins by `updatedAt` timestamp
- Status transitions: active → paused → archived (one-way for archive)
- No encryption needed — project metadata is non-secret (unlike resource credentials)
