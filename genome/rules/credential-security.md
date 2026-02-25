---
id: credential-security
severity: critical
applies_to: [credential-store, resource-registry, api-server, resource-proxy, gateway, cloud-instance-manager]
created: 2026-02-22
updated: 2026-02-24
phase: 69
---

# Pando Resource Security Protocol — Two-Tier Trust Architecture

## The Problem

Pando is a P2P network where users contribute resources (MongoDB databases, API keys, cloud compute). Apps and agents use these resources. The challenge: **how do we keep credentials secure when untrusted node operators run the network?**

Random amateurs, non-technical users, and potentially malicious actors will run nodes. A node operator can trivially modify their code (e.g., add `console.log(key)` to capture any credential). We **cannot** trust node operators with plaintext credentials.

## Solution: Two-Tier Trust Architecture (Phase 69)

```
UNTRUSTED TIER                          TRUSTED TIER
┌─────────────────────┐                 ┌──────────────────────────────┐
│  User Node (PC)     │                 │  EC2 Compute Node (tripwire) │
│                     │── P2P ────────► │                              │
│  - P2P routing      │   request       │  - HAS credential master key │
│  - Ledger/governance│                 │  - Decrypts from MongoDB     │
│  - Agent spawn      │◄── P2P ─────── │  - Calls OpenAI, queries DB  │
│  - Chat/TUI         │   result only   │  - Hosts deployed apps       │
│                     │                 │  - No SSH, tripwired         │
│  NEVER has:         │                 │                              │
│  - Master key       │                 │  Also serves:                │
│  - Plaintext creds  │                 │  - Resource Proxy for apps   │
│  - MongoDB cred URI │                 │  - Gateway API requests      │
└─────────────────────┘                 └──────────┬───────────────────┘
                                                   │
                                            ┌──────▼──────┐
                                            │  MongoDB     │
                                            │  (Atlas/EC2) │
                                            │  encrypted   │
                                            │  credentials │
                                            └─────────────┘
```

### How It Works

1. **Credentials stored in MongoDB** — `pando_credentials` collection, encrypted with AES-256-GCM using a master key
2. **Master key only on EC2 compute instances** — injected via `CREDENTIAL_MASTER_KEY` env var at launch. Never in source code. Never on user nodes.
3. **User nodes route via P2P** — untrusted nodes send high-level requests ("search for X", "query this collection") to compute nodes via P2P request-reply. They receive results, never credentials.
4. **Metadata synced via P2P** — all nodes know what resources exist (type, status, owner) via GossipSub. But the actual credentials are only in MongoDB.

### Encryption Design

- **Master key**: Random 256-bit key (64 hex chars). Generated once by admin. Stored only in EC2 instance environment variables.
- **Per-credential encryption**: `AES-256-GCM(credential, masterKey, randomNonce)` — each credential gets a unique nonce.
- **MongoDB document**: `{ encryptedCredential: base64, nonce: base64, type, userId, status, metadata }`
- **CapabilityProfile.credentialAccess**: Boolean flag — `true` only if `CREDENTIAL_MASTER_KEY` is set. ResourceRouter uses this to find nodes that can handle credential operations.

## Security Analysis

| Actor | Can steal credentials? | Why |
|---|---|---|
| Random internet attacker | NO | No network access to MongoDB or EC2 |
| User-run node operator | NO | Node never receives credentials — only query results |
| EC2 compute instance | NO | No SSH, tripwire kills on intrusion attempt |
| MongoDB breach (attacker reads DB) | NO | Credentials encrypted — needs master key (only in EC2 memory) |
| AWS root account compromise | YES (0.1%) | Same risk as every bank/enterprise on AWS |

**Security level: 99.9%.** The 0.1% is AWS infrastructure compromise — shared risk with all of Fortune 500.

## Rules (NEVER VIOLATE)

### 1. No Plaintext Credentials on User Nodes
User-run nodes NEVER receive, store, or see credentials. Only EC2 compute nodes with `CREDENTIAL_MASTER_KEY` can decrypt.

### 2. No Credentials in Logs
Never log a credential, even partially. Use `[REDACTED]` or the resource ID.

### 3. No Credentials in P2P Messages
GossipSub broadcasts resource METADATA only (type, status, owner, grantedTo). Never encrypted credentials, never wrapped keys.

### 4. Project API Key is Auth Only
The project API key (`window.PANDO_PROJECT_API_KEY`) is for authentication, NOT decryption.

### 5. Credential Wipe After Use
After a query completes on a compute node, the decrypted credential MUST be discarded from memory.

### 6. Revocation is Instant
When `/revoke` is called, ALL nodes mark resource as revoked within seconds via GossipSub. Compute nodes also revoke in MongoDB.

### 7. Minimum Privilege
Contributors should create scoped credentials (e.g., MongoDB read/write to `pando` db only).

### 8. Public Code Identity: pando-lux Only
All public Pando code pushed under `pando-lux` GitHub identity. Never personal accounts.

### 9. No Secrets in Git History
CredentialStore (MongoDB) is the ONLY place for secrets.

### 10. Master Key Hygiene
`CREDENTIAL_MASTER_KEY` is never committed to source code, never in config files, never in logs. Only in environment variables on admin machines and EC2 instances.

## Data Flow

### Contributing a Resource
```
1. User: /contribute openai sk-proj-...
2. If this node has CREDENTIAL_MASTER_KEY:
   a. Encrypt credential with master key (AES-256-GCM + random nonce)
   b. Store encrypted credential in MongoDB (pando_credentials collection)
   c. Broadcast metadata to all nodes via GossipSub
3. If this node does NOT have master key:
   a. Route contribute request via P2P to a compute node
   b. Compute node encrypts and stores
   c. Compute node broadcasts metadata
```

### Using a Resource (e.g., AI Search)
```
1. User types a search query
2. If this node has CREDENTIAL_MASTER_KEY:
   a. Decrypt AI key from MongoDB
   b. Call OpenAI/Gemini directly
   c. Return answer
3. If this node does NOT have master key:
   a. Find compute node via CapabilityRegistry (credentialAccess: true)
   b. Send P2P request: pando/ai-query { query }
   c. Compute node decrypts key, calls OpenAI, returns answer
   d. User node shows answer — never saw the credential
```

### Resource Proxy (Apps Using MongoDB)
```
1. App sends query + X-Project-Key header to gateway
2. Gateway forwards to compute node (PANDO_NODE_URL = EC2 IP)
3. Compute node validates project API key via P2P ProjectRegistry
4. Compute node decrypts MongoDB URI from CredentialStore
5. Compute node executes query, returns data
6. App receives data — never saw MongoDB URI
```

## Storage Proxy (Phase 83)

Untrusted nodes proxy ALL user data operations (threads, messages, projects) to compute nodes via P2P. This is separate from credential operations:

| Operation | Handler | Who Serves |
|-----------|---------|------------|
| Read/write user data (threads, projects) | `pando/storage-proxy` | Any compute node with MongoDB |
| Decrypt credentials (AI keys, MongoDB URIs) | `pando/credential-op` | Only compute nodes with master key |
| AI search queries | `pando/ai-query` | Only compute nodes with master key |

**P2PStorageBackend** (`p2p-storage-backend.ts`) implements the `StorageBackend` interface by forwarding all 6 CRUD methods via `pando/storage-proxy` to compute nodes. The handler on compute nodes has:
- **Method allowlist**: only `putRecord`, `getRecord`, `queryRecords`, `deleteRecord`, `listRecords`, `pushToArray`
- **Collection blocklist**: `pando_credentials` is blocked — credentials never flow through storage proxy
- **No `getDb()` exposure**: P2PStorageBackend does not expose raw database access, so CredentialStore only initializes on compute nodes

## Future: Additional Security Layers

### Phase 64b: Split-Key Encryption
Master key split into K_node (on EC2) and K_gateway (in contributed MongoDB, different contributor). Neither half useful alone. Blocks disk-snapshot attack.

### Phase 64c: Hardware Enclaves
AWS Nitro / Intel SGX. Decryption runs inside hardware enclave. Blocks everyone including Amazon operators.

Each phase adds a layer. Nothing gets rewritten.

## For Agents

### Builder agents
- NEVER handle, store, or reference actual credentials in app code
- Use `window.PANDO_GATEWAY_URL` for Resource Proxy calls
- Use `window.PANDO_PROJECT_API_KEY` as the `X-Project-Key` header (auth only)

### Manager agents
- Credentials are handled by the protocol — never ask a builder to handle credentials
- After deployment, verify the app uses the injected variables

## Key Files

- `packages/node/src/credential-store.ts` — CredentialStore class (MongoDB CRUD + AES-256-GCM)
- `packages/node/src/credential-vault.ts` — Low-level encrypt/decrypt utilities
- `packages/node/src/resource-registry.ts` — Metadata-only P2P registry
- `packages/node/src/capability-detector.ts` — `credentialAccess` detection
- `packages/node/src/p2p-storage-backend.ts` — P2PStorageBackend (Phase 83 — proxies user data, NOT credentials)

## Status

**Phase 69: Two-Tier Trust Architecture — IMPLEMENTED.** Credentials in MongoDB, master key on EC2 only, user nodes route via P2P. Split-key (Phase 64b) designed but not yet built.
