---
id: resource-registry
type: service
domain: resources
entry: packages/node/src/platform/resource-registry.ts
depends_on: [network, ledger, credential-store]
depended_by: [resource-router, resource-meter, api-server, gateway]
created: 2026-02-22
updated: 2026-02-24
---

# ResourceRegistry — Metadata-Only P2P Resource Registry

## Status

**Phase 69: REWRITTEN — metadata-only P2P registry.** Credential encryption/decryption moved to CredentialStore (MongoDB + master key). ResourceRegistry no longer handles any encryption, wrapping, or credential storage. GossipSub syncs metadata only.

## Why This Exists

Resources (API keys, database credentials, cloud accounts) need to be discoverable across the P2P network. All nodes need to know what resources exist, their type, status, and owner — but only trusted compute nodes should have access to the actual credentials.

## What It Does

P2P replicated metadata registry of external resources contributed by anyone. Each resource is a `ResourceRecord` with type, status, ownership, and metadata. Synced via GossipSub (`pando/resources` topic). **No encrypted credentials, no wrapped keys.** Credential operations delegate to CredentialStore.

## How It Works

1. Provider registers resource (via gateway/TUI/API)
2. If node has credential access (CREDENTIAL_MASTER_KEY): CredentialStore encrypts and stores credential in MongoDB
3. If node does NOT have credential access: routes to a compute node via P2P
4. Resource metadata broadcast to all nodes via GossipSub
5. All nodes see the resource in their local metadata Map + SQLite cache
6. When credential is needed: CredentialStore decrypts from MongoDB (compute nodes only)

## ResourceRecord

```typescript
type ResourceCredentialType = 'ai_api_key' | 'storage_db' | 'storage_blob' | 'cloud_compute' | 'hosting_platform' | 'code_repository';

interface ResourceRecord {
  resourceId: string;           // UUID
  type: ResourceCredentialType;
  userId?: string;              // Resource OWNER
  grantedTo: string[];          // ['*'] for all nodes
  maxUsagePerDay: number;       // Rate limit (0 = unlimited)
  pricePerUnit: number;         // Lux per unit
  registeredAt: number;
  expiresAt: number | null;
  status: 'active' | 'revoked' | 'exhausted';
  metadata?: Record<string, any>; // e.g. { provider: 'openai', service: 'OpenAI' }
}
```

**Removed in Phase 69:** `providerPeerId`, `encryptedCredential`, `wrappedKeys`, `senderPublicKey` — all related to the old per-node envelope encryption model.

## API Surface

### ResourceRegistry class methods

- `start()` — subscribe to GossipSub, load from SQLite
- `stop()` — cleanup
- `setCredentialStore(store)` — wire CredentialStore after MongoDB connects
- `registerResource(type, credential, options)` — store credential via CredentialStore, broadcast metadata via GossipSub
- `revokeResource(resourceId, userId?)` — mark revoked in metadata + CredentialStore. Broadcasts.
- `findResources(type)` — query active, non-expired resources by type from in-memory Map
- `getCredential(resourceId)` — delegates to CredentialStore (returns null if no master key)
- `getActiveAiKey()` — delegates to CredentialStore.getActiveByType('ai_api_key')
- `getResource(resourceId)` — single metadata record
- `getOwnerResources(userId)` — list resources by owner userId
- `getAllResources()` — all metadata records
- `updateResourceUserId(resourceId, newUserId, requesterId?)` — link resource to user account

### HTTP API routes (api-server.ts)

- `GET /resources` — list all resources (metadata only)
- `POST /resources/register` — register new resource. userId auto-extracted from auth token.
- `GET /resources/:id` — single resource details
- `POST /resources/:id/revoke` — revoke (owner userId or node)
- `PATCH /resources/:id/owner` — link resource to user account

**Removed in Phase 69:** `POST /resources/:id/grant` — per-node key granting no longer exists.

### Gateway routes

- `/resources` — resources page (list, contribute form, revoke, link-to-account)
- `/api/resources` — proxy GET/POST to node
- `/api/resources/[id]` — proxy GET/DELETE to node
- `/api/resources/[id]/owner` — proxy PATCH to node

**Removed in Phase 69:** `/api/resources/[id]/grant` — no longer exists.

## GossipSub Messages

| Type | Payload | Description |
|---|---|---|
| `resource_register` | ResourceRecord metadata | New resource contributed (no credential) |
| `resource_revoke` | `{ resourceId, userId }` | Resource revoked |

**Removed in Phase 69:** `resource_update_keys` — per-node key wrapping no longer exists.

## SQLite Table (metadata only)

```sql
CREATE TABLE IF NOT EXISTS resource_registry (
  resource_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  user_id TEXT,
  granted_to TEXT NOT NULL,    -- JSON array
  max_usage_per_day INTEGER DEFAULT 0,
  price_per_unit REAL DEFAULT 0,
  registered_at INTEGER NOT NULL,
  expires_at INTEGER,
  status TEXT DEFAULT 'active',
  metadata TEXT               -- JSON
);
```

**Removed columns in Phase 69:** `provider_peer_id`, `encrypted_credential`, `wrapped_keys`, `sender_public_key`.

Migration: drops and recreates table if old `encrypted_credential` column exists.

## What It Replaced (Phase 69 Changes)

| Old (Phase 42.5-68) | New (Phase 69) |
|---|---|
| Envelope encryption (per-node X25519 ECDH wrappedKeys) | Master key encryption (AES-256-GCM, key on EC2 only) |
| Credentials in SQLite + P2P messages | Credentials in MongoDB only |
| `wrappedKeys` per authorized node | `CREDENTIAL_MASTER_KEY` env var on compute nodes |
| `autoWrapForPeer()` on connect | No wrapping — compute nodes already have the key |
| `resource_update_keys` GossipSub | Deleted — no key distribution needed |
| Any node could decrypt with wrappedKey | Only nodes with master key can decrypt |

## Key Files

- `packages/node/src/resource-registry.ts` — ResourceRegistry class
- `packages/node/src/credential-store.ts` — CredentialStore (MongoDB + master key encryption)
- `packages/node/src/credential-vault.ts` — Low-level AES-256-GCM encrypt/decrypt utilities
- `packages/node/src/api-server.ts` — HTTP routes
- `packages/shared/src/types.ts` — ResourceRecord, ResourceCredentialType types
- `packages/gateway/app/resources/page.tsx` — Resources page
