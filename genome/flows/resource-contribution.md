---
id: resource-contribution
type: flow
created: 2026-02-22
---

# Resource Contribution Flow

## What This Is

How anyone — node operator or not — contributes resources (API keys, MongoDB accounts, S3 buckets, cloud accounts) to the Pando network and earns Lux for their usage.

## Architecture (Phase 69 — Two-Tier Trust)

Resources are **network-level shared resources** with a two-tier trust model:

```
Resource Provider (anyone — node operator or regular user)
  │  Registers resource via gateway or TUI
  │  Credential encrypted with master key (AES-256-GCM)
  │  Stored in MongoDB pando_credentials collection
  │  Metadata broadcast via GossipSub (no credentials in P2P)
  ▼
ResourceRegistry (P2P metadata — synced via GossipSub)
  │  Each resource: type, userId, grantedTo,
  │  usage limits, pricing, status
  │  NO credentials in P2P messages
  ▼
Compute Node (EC2, trusted — has CREDENTIAL_MASTER_KEY)
  │  Decrypts credentials from MongoDB
  │  Calls OpenAI, queries MongoDB, etc.
  │  Returns results (never credentials) via P2P
  ▼
User Node (untrusted — NO master key)
  │  Sees resource metadata only
  │  Routes requests to compute nodes via P2P
  │  Never sees credentials
  ▼
Resource Provider earns Lux
  │  2x API cost for API keys
  │  Per-GB-hour for storage
  │  Per-request for gateway/compute
```

## Resource Types

| Type | What's Contributed | Example | Lux Rate |
|---|---|---|---|
| `ai_api_key` | OpenAI, Anthropic, Gemini API key | `sk-proj-abc...` | 2x API cost |
| `storage_db` | MongoDB Atlas connection string | `mongodb+srv://...` | Per-GB-hour |
| `storage_blob` | S3 bucket credentials | AWS access key + bucket | Per-GB-hour |
| `cloud_compute` | AWS/GCP/Azure instance access | SSH key + IP | Per-compute-minute |
| `hosting_platform` | Vercel/Netlify deploy token | `vercel_token_abc` | Per-deployment |
| `dns_service` | Cloudflare API token | `cf_api_abc` | Per-domain-month |

## Flow: Contribute a Resource

1. **Provider registers** via gateway (`POST /resources/register`) or TUI (`/contribute`)
   - Provides: resource type, credential, usage limits (optional), pricing (optional)
   - Gateway sends to compute node (PANDO_NODE_URL = EC2 with CREDENTIAL_MASTER_KEY)

2. **Compute node stores credential in MongoDB** (CredentialStore):
   - Encrypted with AES-256-GCM + master key + random nonce
   - Stored in `pando_credentials` collection

3. **Node creates ResourceRecord (metadata only)**:
   ```
   {
     resourceId: UUID,
     type: 'storage_db',
     userId: 'user-peer-id',      // resource OWNER (not node)
     grantedTo: ['*'],             // who can use it
     maxUsagePerDay: 10000,        // optional limits
     pricePerUnit: 0.001,          // Lux per unit, or 0 for free
     registeredAt: timestamp,
     expiresAt: timestamp | null,
     status: 'active' | 'revoked' | 'exhausted',
     metadata: { provider, service, label }
   }
   ```

4. **Metadata broadcast** via GossipSub (`pando/resources` topic)
   - All nodes learn about available resources (type, status, limits)
   - NO credentials in P2P messages — credentials only in MongoDB

4. **Provider earns Lux** as usage is metered:
   - Each API call / DB query / storage operation recorded by ResourceMeter
   - Emission witness protocol verifies usage
   - Lux minted from NETWORK account to provider

## Flow: Node Uses a Resource

1. **Node needs an AI key** (e.g., user sends a search query)
2. **If compute node** (has CREDENTIAL_MASTER_KEY):
   - Decrypts credential from MongoDB via CredentialStore
   - Calls OpenAI/Gemini directly, returns result
3. **If user node** (no master key):
   - Finds compute node via CapabilityRegistry (`credentialAccess: true`)
   - Sends P2P request: `pando/ai-query { query }`
   - Compute node decrypts key, calls API, returns answer only
4. **ResourceMeter records** usage: `{ peerId, resourceId, type, units, timestamp }`
5. **Provider rewarded** via emission witness flow

## Flow: Revoke a Resource

1. Provider calls `POST /resources/:id/revoke` or `/revoke <resourceId>` in TUI
2. ResourceRecord status → `revoked`, broadcast via GossipSub
3. All nodes stop using this credential immediately
4. Outstanding usage metering finalized, final Lux payment issued

## Credential Security

See `genome/rules/credential-security.md` for full rules.

- Credentials encrypted at rest in MongoDB (AES-256-GCM + master key + random nonce per credential)
- Only EC2 compute nodes with `CREDENTIAL_MASTER_KEY` can decrypt
- User-run nodes NEVER see credentials — only results
- Credentials never in P2P messages, never in GossipSub, never in SQLite
- Credentials never logged, never included in error messages

## Non-Operator Contribution

A user who doesn't run a node CAN still contribute:
1. Log into gateway (Ed25519 auth, Phase 40)
2. Go to Resources page → "Contribute Resource"
3. Paste API key / connection string
4. Gateway sends to compute node (PANDO_NODE_URL = EC2)
5. Compute node encrypts credential in MongoDB, broadcasts metadata to all nodes
6. User earns Lux whenever their resource is used

This is critical for the vision: **anyone can participate in Pando's economy without running infrastructure.**

## Status

**Phase 69: REWRITTEN.** Two-tier trust architecture. ResourceRegistry is metadata-only (P2P sync). Credentials stored in MongoDB via CredentialStore (AES-256-GCM + master key). Only EC2 compute nodes can decrypt. User nodes route via P2P. Old envelope encryption (X25519 ECDH wrappedKeys) removed.

## Key Files

- `packages/node/src/resource-registry.ts` — ResourceRegistry (metadata-only P2P sync)
- `packages/node/src/credential-store.ts` — CredentialStore (MongoDB + master key encryption)
- `packages/node/src/credential-vault.ts` — Low-level AES-256-GCM encrypt/decrypt utilities
- `packages/gateway/app/resources/page.tsx` — Resource contribution UI
- `packages/gateway/app/api/resources/` — Gateway proxy routes (with auth headers)
- `packages/node/src/api-server.ts` — HTTP routes (GET/POST resources, revoke)
- `packages/node/src/resource-meter.ts` — Usage tracking (wired to search() for AI key usage)
- `packages/node/src/resource-router.ts` — Smart routing (queries ResourceRegistry)
