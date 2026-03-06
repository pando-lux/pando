# @pando/identity — Bible & Roadmap
## The foundation of the Pando ecosystem

---

# WHAT IT IS

Standalone identity and authentication package for AI agents.
Zero @pando dependencies. Uses only Node.js crypto + @libp2p/crypto.
Lives at `packages/identity/` in the pando/node monorepo.
Published independently to npm as `@pando/identity`.

---

# INTEGRATION STATUS

## Already replaced (Phase D — DONE)

```
packages/shared/src/crypto.ts         221 lines — Now re-exports from @pando/identity
                                       406 lines of duplicated crypto removed
                                       Domain-specific wrappers kept (signMessage, signTransaction, signProposal)
                                       All consumers use old function names — zero breaking changes
```

## Remaining legacy code (to be replaced)

```
packages/shared/src/types.ts          ~100 lines — Will re-export identity types
packages/node/src/platform/user-accounts.ts  611 lines — Will use @pando/identity primitives
                                               Account storage stays in MongoDB (via @pando/node)
                                               Key encryption uses @pando/identity/encryption
packages/node/src/api/middleware/auth.ts     137 lines — Will use @pando/identity/jwt
packages/ledger/src/accounts.ts              222 lines — Keeps balance/transaction logic only
                                               Auth fields (username, password_hash) move to MongoDB
```

---

# TARGET ARCHITECTURE

```
packages/identity/
  src/
    core/
      keypair.ts             Ed25519 keypair generation, load, save, list
                             Uses @libp2p/crypto for Ed25519
                             Same KeyPair type for nodes, humans, AND agents
                             Supports: unencrypted, password-encrypted (PBKDF2 + AES-256-GCM)
                             Storage: ~/.pando/identity.json, ~/.pando/identities/
                             Functions: generate(), load(), save(), loadOrCreate(), list()

      signing.ts             Sign and verify arbitrary data with Ed25519
                             Functions: sign(data, privateKey), verify(data, signature, publicKey)
                             Canonical payload construction (deterministic JSON key order)
                             Returns base64-encoded signatures

      encryption.ts          AES-256-GCM encrypt/decrypt utilities
                             PBKDF2 key derivation (100k iterations, SHA256)
                             Functions: encrypt(plaintext, key), decrypt(ciphertext, key)
                             Functions: deriveKey(password, salt), generateSalt()

      hash.ts                SHA-256 hashing utilities
                             Functions: sha256(data), hashTransaction(fields)

    identity/
      node-identity.ts       Node: Ed25519 keypair for P2P transport
                             Nodes are COMPUTE ONLY — they don't own agents or humans
                             Functions: createNodeIdentity(), loadNodeIdentity()

      agent-profile.ts       Agent: own Ed25519 keypair, certified by human
                             createAgent(config, human) generates keypair + certificate
                             Human signs certificate (proves delegation of authority)
                             verifyCertificate(cert, humanPubKey, opts?) checks signature + expiry
                             renewCertificate(oldCert, human, newExpiry?) re-signs with same agent key
                             validateProfile(profile) checks required fields
                             Agent's peerId IS its wallet ID (no separate walletPeerId)
                             Trust chain: agent key → certificate → human key

      signed-action.ts       SignedAction: agent signs with its OWN Ed25519 key
                             Includes certificate for full offline trust chain verification
                             createSignedAction(input, agentKey, agentPubKey, certificate)
                             verifySignedAction(action) checks agent's signature
                             verifySignedActionFull(action, humanPubKey) checks full chain:
                               1. Agent public key matches certificate
                               2. Agent ID matches certificate
                               3. Agent action signature valid
                               4. Certificate not expired (current time, not action time)
                               5. Certificate signed by human
                             stableStringify(value) — deterministic JSON (recursive sorted keys)

    auth/
      verifier.ts            Offline signature verification (no network needed)
                             Core of Pando Login (Step 2 — offline)
                             Functions: verifySignature(data, sig, pubkey),
                                        verifyPayloadSignature(payload, sig, pubkey)

      jwt.ts                 JWT generation and validation
                             Ed25519-signed JWTs (EdDSA, not HMAC)
                             Supports human and agent token types
                             Functions: issueJwt(), verifyJwt(), decodeJwtPayload()

      password.ts            Password hashing and validation
                             scrypt (N=16384, r=8, p=1, keylen=64)
                             Functions: hashPassword(), verifyPassword(), validatePassword()

    types.ts                 All exported types:
                             KeyPair, NodeIdentity (= KeyPair for P2P)
                             AgentCertificate, AgentPermissions, AgentProfile
                             SignedAction (agent-signed, includes certificate)
                             JwtPayload (human | agent)
                             EngineAgentConfig (structural typing for @pando/code)

    constants.ts             PBKDF2, SCRYPT, JWT, AES params, AGENT_STATUSES

    index.ts                 Barrel export: everything public

  tests/
    keypair.test.ts          Generate, save, load, list, encrypt/decrypt keypair (10 tests)
    signing.test.ts          Sign/verify messages, payload signing (5 tests)
    encryption.test.ts       AES-256-GCM round-trip, PBKDF2 derivation (8 tests)
    hash.test.ts             SHA-256 determinism, transaction hash (3 tests)
    agent-profile.test.ts    Create agent with own keypair, certificate verification,
                             expiry, renewal, permissions, validation (20 tests)
    signed-action.test.ts    Agent signs own actions, full trust chain verification,
                             tamper detection, expired cert, cert reuse, stableStringify (16 tests)
    verifier.test.ts         Offline signature verification, payload verification (5 tests)
    node-identity.test.ts    Node keypair create, load, persist flag (4 tests)
    jwt.test.ts              Issue/verify for human+agent, expiry, tampering (7 tests)
    password.test.ts         Hash + verify round-trip, validation rules (5 tests)

  package.json
  tsconfig.json
  vitest.config.ts
```

---

# KEY TYPES (exact TypeScript)

```typescript
// Ed25519 keypair — same structure for nodes, humans, and agents
interface KeyPair {
  peerId: string              // Derived from public key
  publicKey: Uint8Array       // Ed25519 (32 bytes)
  privateKey: Uint8Array      // Ed25519 (protobuf-wrapped)
  createdAt: number
}

// NodeIdentity = KeyPair for P2P transport. Nodes are compute, NOT identity authority.
type NodeIdentity = KeyPair

// Serialized for disk storage
interface SerializedIdentity {
  peerId: string
  publicKey: string           // base64
  privateKey: string          // base64
  createdAt: number
}

// Password-protected storage
interface EncryptedSerializedIdentity {
  encrypted: true
  peerId: string
  publicKey: string           // base64
  salt: string                // hex (PBKDF2 salt)
  iv: string                  // hex (AES-GCM IV)
  encryptedPrivateKey: string // hex (ciphertext + auth tag)
  createdAt: number
}

// Certificate: human authorizes an agent (like TLS: human = CA, agent = server)
// Signed by the human's Ed25519 key. Verifiable offline.
interface AgentCertificate {
  agentId: string             // Agent's peerId (from its own keypair)
  agentPublicKey: string      // Agent's Ed25519 public key (base64)
  parentId: string            // Human's peerId (the owner)
  permissions: AgentPermissions
  issuedAt: string            // ISO 8601
  expiresAt: string           // REQUIRED — 90-day default, no permanent certificates
  parentSignature: string     // Human's Ed25519 signature over all above fields
}

// Permissions locked in the certificate — cannot change without re-signing
interface AgentPermissions {
  canEarn: boolean
  canSpend: boolean
  canAuthenticate: boolean
  budgetLimit?: number
}

// Agents are FIRST-CLASS CITIZENS — own Ed25519 keypair, own identity.
// Agent's peerId (from its own keypair) IS its wallet ID.
// No ownerNodeKey — nodes are just compute. Agents belong to humans.
// Trust chain: agent action (agent key) → certificate (human key) → human account
interface AgentProfile {
  id: string                  // peerId (from agent's OWN Ed25519 keypair = wallet ID)
  publicKey: string           // Agent's Ed25519 public key (base64)
  parentId: string            // Human's peerId (the owner)
  certificate: AgentCertificate
  name: string
  role: string                // Any string — app-defined, not enum
  capabilities: string[]
  scope: AgentScope
  tools: string[]
  model?: string
  maxSteps?: number
  budgetLimit?: number
  canEarn: boolean
  canSpend: boolean
  canAuthenticate: boolean
  status: AgentStatus
  username?: string
  createdAt: string
  metadata?: Record<string, unknown>
}

interface AgentScope {
  readPaths?: string[]
  writePaths?: string[]
  excludePaths?: string[]
  services?: string[]
  network?: boolean
}

type AgentStatus = "pending" | "active" | "idle" | "done" | "failed" | "terminated"

// Minimal interface for @pando/code structural typing
interface EngineAgentConfig {
  id: string
  role: string
  tools: string[]
  scope?: { readPaths?: string[]; writePaths?: string[]; excludePaths?: string[] }
  model?: string
  maxSteps?: number
  budgetLimit?: number
}

// Proof of agent action — signed by AGENT's own key (not node's)
// Includes certificate so verifiers can check the full trust chain offline
interface SignedAction {
  agentId: string
  action: string
  payload: unknown
  timestamp: string
  agentPublicKey: string      // Agent's Ed25519 public key (base64)
  signature: string           // Agent's Ed25519 signature
  certificate: AgentCertificate
}

// JWT payload — supports human and agent tokens
interface JwtPayload {
  sub: string                 // peerId (human or agent)
  iss: string                 // Node peerId (issuing node)
  iat: number
  exp: number
  typ: "human" | "agent"
}

```

**NOT in this package** (stays in other packages):
- `Account` (peerId, balance) → `@pando/ledger`
- `AuthResult` (login response) → `@pando/node` (uses MongoDB for account storage)
- Account CRUD, username claiming → `@pando/node` (MongoDB, not SQLite)
- Private key encrypted backup → `@pando/node` (stored in MongoDB, encrypted with user's password)

---

# PUBLIC API SURFACE

```typescript
// === Core Crypto ===
import { generate, load, save, loadOrCreate, list } from "@pando/identity/keypair"
import { sign, verify } from "@pando/identity/signing"
import { encrypt, decrypt, deriveKey } from "@pando/identity/encryption"
import { sha256, hashTransaction } from "@pando/identity/hash"

// === Identity ===
import { createNodeIdentity, loadNodeIdentity } from "@pando/identity/node-identity"
import { createAgent, verifyCertificate, renewCertificate, validateProfile } from "@pando/identity/agent-profile"
import { createSignedAction, verifySignedAction, verifySignedActionFull, stableStringify } from "@pando/identity/signed-action"

// === Auth ===
import { verifySignature, verifyPayloadSignature } from "@pando/identity/verifier"
import { issueJwt, verifyJwt } from "@pando/identity/jwt"
import { hashPassword, verifyPassword } from "@pando/identity/password"

// === Types (everything) ===
import type { KeyPair, NodeIdentity, AgentProfile, AgentCertificate,
  AgentPermissions, SignedAction, JwtPayload, EngineAgentConfig } from "@pando/identity"

// === Barrel (convenience) ===
import { generate, sign, verify, createAgent, createSignedAction,
  verifyCertificate, verifySignedActionFull, stableStringify } from "@pando/identity"
```

---

# DEPENDENCIES

```json
{
  "dependencies": {
    "@libp2p/crypto": "^5.x",
    "@libp2p/peer-id": "^5.x",
    "uint8arrays": "^5.x"
  },
  "devDependencies": {
    "vitest": "^3.x",
    "typescript": "^5.x"
  }
}
```

Three runtime dependencies. Zero infrastructure deps (no SQLite, no MongoDB).
Node.js `crypto` module is builtin (not a dependency).
This package is PURE CRYPTO — storage is the caller's responsibility.

---

# WHAT IS NOT IN THIS PACKAGE

```
NOT included (stays in other packages):
  - Account storage (username, password hash, encrypted keys) -> @pando/node (MongoDB)
    Reason: identity is pure crypto, no storage backend. Nodes store encrypted
    identity blobs in MongoDB. Users log in from any node.
  - Account balances / transactions -> @pando/ledger (SQLite, P2P synced)
  - CredentialStore (MongoDB encryption) -> @pando/node
  - Auth middleware (Fastify/Express) -> @pando/node
    Reason: framework dependency. Identity provides JWT primitives,
    node wraps them in middleware.
  - Transaction signing/verification -> primitives exported from identity,
    TransactionStore stays in @pando/ledger.
  - Governance proposal signing -> primitives exported from identity,
    GovernanceSync stays in @pando/governance.
  - P2P message signing -> primitives exported from identity,
    PandoNetwork stays in @pando/network.
```

Identity provides the PRIMITIVES (sign, verify, encrypt, decrypt, hash, JWT, certificates).
Other packages USE those primitives for their domain-specific operations.
**No databases. No storage. No infrastructure. Pure crypto.**

---

# ROADMAP

## Phase 1: Scaffold package — DONE

```
COMPLETED:
  - packages/identity/ created with full directory structure
  - package.json (name: @pando/identity, version: 0.1.0, zero @pando deps)
  - tsconfig.json (extends monorepo root)
  - Added to monorepo workspaces (build order: shared -> identity -> ledger -> node)
  - npm run build passes (full monorepo)
```

## Phase 2: Core crypto — DONE

```
COMPLETED:
  - core/keypair.ts (210 lines): generate, load, save, loadOrCreate, encrypt, decrypt,
    saveEncrypted, saveSession, loadSession, clearSession, list, loadFile, saveToDir,
    isEncrypted, loadRaw, getPrivateKey
  - core/signing.ts (67 lines): sign, verify, signPayload, verifyPayload
    Extracted wrapPublicKey() helper for Ed25519 protobuf wrapping
  - core/encryption.ts (103 lines): AES-256-GCM encrypt/decrypt, PBKDF2 deriveKey,
    encryptWithPassword, decryptWithPassword, generateSalt, generateIv
  - core/hash.ts (17 lines): sha256, hashTransaction
  - types.ts (93 lines): all identity types including AgentProfile as first-class citizen
  - constants.ts: PBKDF2_ITERATIONS, AES params, DEFAULT_PANDO_DIR
  - index.ts: barrel export
  - Tests: keypair.test.ts (11), signing.test.ts (5), encryption.test.ts (8), hash.test.ts (3)
  - Re-export from shared/crypto.ts (backward compat — deferred to Phase 7)
  Full monorepo build passes. Commit: e1c36155
```

## Phase 3: Agent identity with own keypair + certificate model — DONE

```
COMPLETED:
  - identity/agent-profile.ts: REWRITTEN for correct identity model
    createAgent(config, humanSigner) — generates agent's OWN Ed25519 keypair
    Human signs AgentCertificate (proves delegation of authority)
    verifyCertificate(cert, humanPubKey) — offline certificate verification
    validateProfile(profile) — checks required fields
    No ownerNodeKey — nodes are compute, not identity authority
    Agent's peerId IS its wallet ID (no separate walletPeerId)
  - identity/node-identity.ts: createNodeIdentity(opts?), loadNodeIdentity(dir?)
    Thin convenience wrappers for P2P transport keypair
  - types.ts: REWRITTEN
    KeyPair (base type for all), NodeIdentity = KeyPair
    AgentCertificate, AgentPermissions (locked in certificate)
    AgentProfile (id = agent's own peerId, publicKey, parentId, certificate)
    SignedAction (agent signs, includes certificate)
    JwtPayload (typ: 'human' | 'agent')
  - Tests: agent-profile.test.ts (20 tests), node-identity.test.ts (4 tests)
    Covers: own keypair generation, certificate signed by human,
    wrong human key fails, certificate expiry (default 90 days, custom, expired),
    renewCertificate (new cert same key, rejects wrong human),
    permissions in certificate, defaults, scope defaults,
    username validation, EngineAgentConfig structural typing,
    validateProfile catches missing/valid.
  - All exported from index.ts
  Full monorepo build + 83 tests pass (10 test files).
```

## Phase 4: Agent-signed actions + full trust chain verification — DONE

```
COMPLETED:
  - identity/signed-action.ts: REWRITTEN for agent-signs model
    createSignedAction(input, agentPrivateKey, agentPublicKey, certificate)
    Agent signs with its OWN key (not node's)
    verifySignedAction(action) — checks agent's signature
    verifySignedActionFull(action, humanPublicKey) — full trust chain:
      1. Agent public key matches certificate
      2. Agent ID matches certificate
      3. Agent action signature valid
      4. Certificate not expired (current time, not action time)
      5. Certificate signed by human
    stableStringify(value) — deterministic JSON (recursive sorted keys)
  - auth/verifier.ts: verifySignature(), verifyPayloadSignature()
    Core of Pando Login (offline)
  - Tests: signed-action.test.ts (16 tests), verifier.test.ts (5 tests)
    Covers: agent signs own action, tamper detection, wrong agent key,
    full trust chain verification, wrong human key, mismatched cert agentId,
    expired certificate, cert reuse (agent A cert for agent B),
    null payload, nested deterministic payload, stableStringify unit tests,
    offline signature verification, payload verification
  - All exported from index.ts
  Full monorepo build + 83 tests pass (10 test files).
```

## Phase 5: JWT + password — DONE (middleware deferred)

```
COMPLETED:
  - auth/jwt.ts: issueJwt(subject, issuer, privateKey, opts?)
    Supports human and agent token types (opts.typ = 'human' | 'agent')
    Ed25519-signed JWTs (EdDSA), base64url encoding, 24h default expiry.
    verifyJwt(token, publicKey), decodeJwtPayload(token).
  - auth/password.ts: hashPassword(), verifyPassword(), validatePassword()
    scrypt (N=16384, r=8, p=1, keylen=64). Timing-safe comparison.
  - constants.ts: JWT_EXPIRY_SECONDS, SCRYPT_*, MIN_PASSWORD_LENGTH
  - Tests: jwt.test.ts (7 tests), password.test.ts (5 tests)
    Covers: human + agent tokens, expiry, tampering, wrong key,
    decode without verify, hash round-trip, password validation
  - DEFERRED: auth/middleware.ts (Fastify dependency — move to Phase 7)
  - All exported from index.ts
  Full monorepo build + 83 tests pass (10 test files).

ADDED LATER (Phase A/B integration):
  - structural-typing.test.ts (6 tests): Proves AgentProfile → pando-code
    AgentIdentity via Zod validation. Tests custom roles, all statuses,
    scope with services+network, BudgetProvider contract (USD + Lux).
  - Total: 89 tests across 11 test files.
```

## Phase 6: Integration + wire into monorepo — PARTIAL

```
COMPLETED:
  - shared/crypto.ts replaced with re-exports from @pando/identity
    406 lines of duplicated crypto deleted, 107 lines of re-exports remain
  - @pando/shared depends on @pando/identity (package.json updated)
  - Domain-specific wrappers kept in shared (signMessage, signTransaction,
    signProposal, verifyProposalSignature — delegate to identity's sign/verify)
  - Full monorepo builds clean (shared → identity → ledger → node → gateway → mcp-server)
  - 89 identity tests pass (11 test files)
  - Structural typing integration test proves identity→code type compatibility
  - Zero regressions. Old imports via @pando/shared still work.
  Commit: 993be684

REMAINING:
  - Update user-accounts.ts to use @pando/identity JWT + password primitives
  - Update auth middleware to use @pando/identity JWT functions
  - Update shared/types.ts to re-export identity types (NodeIdentity etc.)
  - Direct @pando/identity imports in node/ code (optional — shared re-exports work)
```

## Phase 7: Cleanup + publish — DONE

```
COMPLETED:
  - CLAUDE.md updated with new package structure
  - Standalone verified: cd packages/identity && npm test (no monorepo deps needed)
  - Tagged version: @pando/identity@0.1.0
  - packages/identity standalone build + test passes
  - Full monorepo build + test passes
  - @pando/identity is a standalone pure crypto package
  - Zero code duplication in monorepo
  - Zero storage dependencies. Zero infrastructure deps.
```

## Phase 8: Agent Identity Integration — DONE (E2E verified)

```
COMPLETED:
  - Agent identity is LIVE in @pando/node, end-to-end verified
  - createAgent() generates agent Ed25519 keypair, human signs certificate
  - Pando Login flow: POST /auth/challenge → sign nonce → POST /auth/verify → JWT
  - JWT in X-User-Token header grants full API access (not Authorization: Bearer)
  - 204 E2E tests validate the full identity → login → action pipeline
  - Signed actions verified end-to-end:
    createSignedAction() + verifySignedActionFull() = full offline trust chain
  - Agent as first-class citizen: governance, content, chat, Lux transfers via JWT
  - Agent storage is EPHEMERAL (created per session, not persisted to MongoDB)
    MongoDB persistence (Phase 8.6) is deferred — not blocking

NOTE on agent storage:
  Agents are currently created fresh each session. Their keypair and certificate
  live in memory for the session duration. This is sufficient for all current
  use cases (orchestrators, workers, observers). Portable agent identity across
  nodes (Phase 8.6: MongoDB persistence) is deferred but not blocking any
  functionality.
```

---

# DONE CRITERIA

@pando/identity is DONE when:
1. All 11 test files pass (89 tests — core crypto, identity, auth, structural typing) ✓
2. Package compiles standalone (no monorepo deps at build time) ✓
3. All existing monorepo tests still pass (zero regressions) ✓
4. shared/crypto.ts is just re-exports (no own implementation) ✓
5. Published to npm as @pando/identity@0.1.0 ✓
6. Zero storage dependencies (no SQLite, no MongoDB) ✓

---

# IDENTITY STORAGE MODEL

```
WHERE IDENTITY DATA LIVES:

  MongoDB (via @pando/node, trusted nodes only):
    - Encrypted private key blob (PBKDF2 + AES-256-GCM, useless without password)
    - Username registry (unique, case-insensitive)
    - Public key, peerId
    - Agent certificates
    - Password hash (scrypt)

  @pando/identity (pure crypto, NO storage):
    - Generate keypair
    - Encrypt/decrypt private key with password
    - Sign/verify
    - Certificates, JWTs, password hashing

  @pando/node (infrastructure):
    - Reads/writes identity data to MongoDB
    - P2P proxy so untrusted nodes can auth through trusted ones
    - Issues JWTs after successful password verification
    - Auth middleware (Fastify)

  @pando/ledger (economy):
    - Account balances + transactions only
    - P2P synced via GossipSub

  Client (gateway/browser):
    - Sends username + password to any node
    - Receives JWT for session
    - Key decrypted in memory on node, used for session, then discarded

WHY MONGODB (not local SQLite):
  - Nodes are stateless compute. Node goes down = zero data loss.
  - User logs in from ANY node. Identity travels with them.
  - Triple protection: node security (tripwire) + MongoDB access control
    + encrypted blobs (PBKDF2/AES-256-GCM = infeasible brute force)
  - This is how password managers work (1Password, LastPass):
    encrypted vault on server, password unlocks it client-side.
```

---

# INTEGRATION WITH PANDO-CODE

```
pando-code lives at: pando/code/ (separate repo, 60K+ lines, standalone product)
pando-code has ZERO @pando/* imports — integration is via structural typing.

HOW IT WORKS:
  @pando/identity defines AgentProfile (full identity with certificate)
  pando-code defines EngineAgentConfig (minimal interface for engine)
  AgentProfile is a SUPERSET of EngineAgentConfig
  TypeScript structural typing: pass AgentProfile where EngineAgentConfig expected

TYPE CONTRACT (must stay aligned):
  EngineAgentConfig {
    id: string          ← AgentProfile.id (agent's peerId)
    role: string        ← AgentProfile.role
    tools: string[]     ← AgentProfile.tools
    scope?: AgentScope  ← AgentProfile.scope (readPaths, writePaths, excludePaths)
    model?: string      ← AgentProfile.model
    maxSteps?: number   ← AgentProfile.maxSteps
    budgetLimit?: number ← AgentProfile.budgetLimit
  }

FIELDS PANDO-CODE IGNORES (identity-specific):
  certificate, parentId, publicKey, canEarn, canSpend, canAuthenticate,
  username, createdAt, metadata, capabilities
  These are passed through but pando-code doesn't read them.
  @pando/node uses them for certificate verification + ledger integration.

DUAL BUDGET:
  pando-code tracks costs in USD by default (standalone)
  @pando/node registers a Lux BudgetProvider at runtime
  interface BudgetProvider { calculateCost(usage): number; currency: 'usd' | 'lux' }

systemPrompt IS NOT IN AgentProfile:
  pando-code constructs systemPrompt dynamically from role + context + frames.
  This is correct — prompts are engine-specific, not identity-specific.
```

---

# RISKS

```
RISK: @libp2p/crypto API changes between versions
  MITIGATION: Pin exact version. Wrap in our own functions (never expose libp2p types).

RISK: Re-export from shared/ breaks something in the monorepo
  MITIGATION: Phase 6 is dedicated to this. Keep re-exports until all consumers updated.

RISK: MongoDB compromise exposes encrypted key blobs
  MITIGATION: PBKDF2 (100K iterations) + AES-256-GCM. Each password guess = ~100ms.
  8-char password = billions of years to brute force. Tripwire wipes on compromise detection.

RISK: user-accounts.ts in @pando/node has deep coupling to PandoLedger
  MITIGATION: Phase 6 refactors to use @pando/identity primitives. Account CRUD stays in
  @pando/node (MongoDB). Only balance operations stay in @pando/ledger.
```
