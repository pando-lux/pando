---
id: credential-store
type: service
domain: resources
entry: packages/node/src/credential-store.ts
depends_on: [storage-backend]
depended_by: [resource-registry, api-server, cloud-instance-manager]
created: 2026-02-24
phase: 69
---

# CredentialStore — Secure MongoDB Credential Storage

## Status

**Phase 69: NEW.** Central credential storage for the two-tier trust architecture.

## Why This Exists

In a P2P network, untrusted node operators cannot be given access to credentials. CredentialStore provides encrypted credential storage in MongoDB, where only EC2 compute instances with the `CREDENTIAL_MASTER_KEY` can decrypt.

## What It Does

- Encrypts credentials with AES-256-GCM using a master key + random per-credential nonce
- Stores encrypted credentials in MongoDB `pando_credentials` collection
- Provides CRUD operations: store, get, revoke, list metadata
- Reports whether this node has decryption capability (`hasDecryptionCapability()`)
- User nodes (without master key) can list metadata but cannot decrypt credentials

## How It Works

```
Admin generates master key:
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

EC2 compute instance user-data:
  Environment=CREDENTIAL_MASTER_KEY=<64-hex-chars>

CredentialStore constructor:
  if (CREDENTIAL_MASTER_KEY is set) → can encrypt/decrypt
  if (CREDENTIAL_MASTER_KEY is not set) → metadata-only access

Store: AES-256-GCM(credential, masterKey, randomNonce) → MongoDB
Get:   MongoDB → AES-256-GCM decrypt(encryptedCredential, masterKey, nonce) → plaintext
```

## MongoDB Document (`pando_credentials`)

```json
{
  "_id": "resource-uuid",
  "type": "ai_api_key",
  "userId": "user-peer-id",
  "encryptedCredential": "base64...",
  "nonce": "base64...",
  "status": "active",
  "grantedTo": ["*"],
  "maxUsagePerDay": 0,
  "pricePerUnit": 0,
  "registeredAt": 1708646400000,
  "expiresAt": null,
  "metadata": { "provider": "openai", "service": "OpenAI", "label": "my key" }
}
```

Indexes: `type`, `userId`, `status`.

## API Surface

### CredentialStore class methods

- `constructor(db: Db, masterKeyHex?: string)` — masterKeyHex from `CREDENTIAL_MASTER_KEY` env var. If not provided, store is metadata-only.
- `init()` — get `pando_credentials` collection, create indexes
- `hasDecryptionCapability(): boolean` — true only if master key is set
- `storeCredential(resourceId, type, credential, metadata)` — encrypt + upsert to MongoDB. Throws if no master key.
- `getCredential(resourceId): Promise<string | null>` — decrypt from MongoDB. Returns null if no master key or not found.
- `getActiveByType(type): Promise<{ credential, resourceId, metadata } | null>` — find first active credential of type, decrypt. Returns null if no master key.
- `revokeCredential(resourceId): Promise<boolean>` — update status to 'revoked' in MongoDB
- `listMetadata(filter?): Promise<CredentialMetadata[]>` — return metadata only (no decryption needed). Works on ANY node.

## Security Properties

| Property | Guarantee |
|---|---|
| At rest | AES-256-GCM encrypted in MongoDB |
| In transit (P2P) | Credentials never sent via P2P — only metadata |
| Master key exposure | Only in EC2 instance memory (env var). Never in source code, config files, or logs. |
| Node without key | Can list metadata. Cannot decrypt. |
| MongoDB breach | Attacker gets encrypted blobs. Needs master key (only on EC2). |

## Key Files

- `packages/node/src/credential-store.ts` — CredentialStore class
- `packages/node/src/credential-vault.ts` — Low-level AES-256-GCM encrypt/decrypt
- `packages/node/src/index.ts` — Wiring (creates CredentialStore after MongoDB connects)
- `packages/node/src/capability-detector.ts` — Reports `credentialAccess` in CapabilityProfile

## Dependencies

- `mongodb` — MongoDB Db/Collection from StorageBackend
- `credential-vault.ts` — `encryptCredential()`, `decryptCredential()` functions
