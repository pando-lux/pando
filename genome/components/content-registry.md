---
id: content-registry
type: service
domain: content
entry: packages/node/src/content-registry.ts
depends_on: [ledger, network]
depended_by: [content-publish, content-maintenance]
exposes:
  - create(params) — create a new ContentRecord (UUID, version hash, broadcast)
  - update(contentId, updates) — update existing record (version bump, broadcast)
  - get(contentId) — retrieve a single content record
  - list(filter?) — list content records by status/type/owner
  - search(query) — full-text search on title + description + tags
  - subscribeContentTopic() — subscribe to GossipSub topic pando/content
  - mergeRemoteRecord(record) — ingest a content record from a peer
  - recordRevenue(contentId, peerId, role, amount) — track Lux earned per content
  - getStats() — aggregate content statistics
rules: []
last_verified: 2026-02-18
---

# Content Registry

## What It Does
Registry of content records (websites, APIs, datasets, services, documents, tools) built by agents on the Pando network. Currently SQLite-backed; syncs records across nodes via GossipSub on the `pando/content` topic. **Note:** ContentRegistry is P2P metadata (the "DNS" of Pando) — it stays on nodes as P2P state. The actual content files live on S3/hosting infrastructure.

## How It Works
- Creates two SQLite tables: `content_records` (content metadata, version, status, tags, manifest) and `content_revenue` (per-content Lux earnings by peer and role).
- Each record has a `contentId` (UUID), `versionHash` (SHA-256 of contentId + version + title), owner/builder peer IDs, hosting nodes list, and a `ContentManifest` (upgradePolicy, updateSchedule, qualityGate).
- On `create()` or `update()`, the record is persisted to SQLite and broadcast to peers via GossipSub (`pando/content` topic).
- Remote records arriving via GossipSub are merged with `mergeRemoteRecord()` — skips messages from self, only processes `content_record` type payloads.
- Full-text search operates on title, description, and tags columns in SQLite.

## Gotchas
- Owner permission checks must be done by the caller before calling `update()` — the registry itself does not enforce ownership.
- The `hosting_nodes` field is stored as a JSON-serialized string in SQLite but exposed as a `string[]` in the TypeScript interface.
- GossipSub subscription requires `setNetwork()` and `setLocalPeerId()` to be called first.

## Key Files
- `packages/node/src/content-registry.ts` — ContentRegistry class
- `packages/shared/src/types.ts` — ContentRecord, ContentManifest, ContentType, ContentStatus types
