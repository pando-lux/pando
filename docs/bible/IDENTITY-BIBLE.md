# @pando/identity — Bible & Roadmap
## The foundation of the Pando ecosystem

---

# WHAT IT IS

Standalone identity and authentication package for AI agents.
Zero @pando dependencies. Uses only Node.js crypto + @libp2p/crypto.
Lives at `packages/identity/` in the pando/node monorepo.
Published independently to npm as `@pando/identity`.

---

# WHAT EXISTS TODAY (inventory from current codebase)

Everything below already works but is scattered across 3 packages:

```
packages/shared/src/crypto.ts         522 lines — Ed25519 keypair, signing, AES-256-GCM, PBKDF2
packages/shared/src/types.ts          ~100 lines — NodeIdentity, Account, Transaction types
packages/node/src/platform/user-accounts.ts  611 lines — Guest, claim, login, password, key encryption
packages/node/src/api/middleware/auth.ts     138 lines — JWT issuance + Ed25519 verification
packages/node/src/core/credential-vault.ts    42 lines — AES-256-GCM credential encryption
packages/ledger/src/accounts.ts              222 lines — Account CRUD, auth fields, P2P claim sync
```

Total: ~1,635 lines of existing code to reorganize.

---

# TARGET ARCHITECTURE

```
packages/identity/
  src/
    core/
      keypair.ts             Ed25519 keypair generation, load, save, list
                             Uses @libp2p/crypto for Ed25519
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
      node-identity.ts       NodeIdentity: the cryptographic root of a node
                             Load/create Ed25519 keypair
                             Session management (persistent login)
                             Password protection (encrypt/decrypt private key)
                             Functions: createNodeIdentity(), loadNodeIdentity(),
                                        saveSession(), loadSession(), clearSession()

      agent-profile.ts       AgentProfile type + validation
                             Agents are FIRST-CLASS CITIZENS (same as humans):
                               Own username, own Lux wallet, can earn, can spend, can authenticate
                               Can use browsers, call APIs, hold balances
                               Trust chain: agent -> parentIdentity (human) -> node
                             Role, capabilities, scope, tools, budget limits
                             Validation: required fields, scope pattern validation, parentIdentity exists
                             Functions: createProfile(config), validateProfile(profile)

      signed-action.ts       SignedAction: proof that a node authorized an agent action
                             Create: { agentId, action, payload, timestamp } + Ed25519 signature
                             Verify: check signature against node public key (offline)
                             Functions: createSignedAction(action, privateKey),
                                        verifySignedAction(action, publicKey)

    auth/
      verifier.ts            Offline signature verification (no network needed)
                             Verify any signed payload against a public key
                             Functions: verifySignature(payload, signature, publicKey)
                             This is the core of Pando Login (Step 2 — offline)

      jwt.ts                 JWT generation and validation
                             Ed25519-signed JWTs (not HMAC)
                             24-hour expiry, auto-refresh support
                             Functions: issueJwt(peerId, privateKey), verifyJwt(token, publicKey)

      middleware.ts           Express/Fastify middleware for Pando Login verification
                             Extracts JWT from Authorization header
                             Verifies Ed25519 signature
                             Attaches verified peerId to request
                             Functions: pandoAuth(options), pandoAuthOptional(options)

      password.ts            Password hashing and validation
                             scrypt (N=16384, r=8, p=1, keylen=64)
                             Functions: hashPassword(password), verifyPassword(password, hash)
                             Validation rules: min 8 chars (configurable)

    accounts/
      account-store.ts       Account CRUD (SQLite)
                             Create, get, exists, balance operations
                             Username claiming (first-come-first-served, case-insensitive)
                             Auth fields: username, display_name, password_hash, is_claimed
                             P2P claim sync support: applyRemoteClaim()

      user-accounts.ts       User-facing account management
                             Guest creation (node-level encryption)
                             Account claiming (re-encrypt with user password)
                             Login (password verification + key decryption)
                             Password change (re-encrypt)
                             Key backup (encrypted export/import)
                             Local SQLite storage (auth-local.db — never synced)

    types.ts                 All exported types:
                             NodeIdentity, SerializedIdentity, EncryptedSerializedIdentity
                             AgentProfile, AgentScope, AgentStatus
                             SignedAction
                             Account, UserAccountPublic, AuthResult
                             EngineAgentConfig (minimal interface for @pando/code)

    constants.ts             Default values:
                             PBKDF2_ITERATIONS = 100_000
                             SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }
                             JWT_EXPIRY = 86400 (24 hours)
                             DEFAULT_PANDO_DIR = ~/.pando
                             AGENT_STATUSES = ["pending", "active", "idle", "done", "failed", "terminated"]

    index.ts                 Barrel export: everything public

  tests/
    keypair.test.ts          Generate, save, load, list, encrypt/decrypt keypair
    signing.test.ts          Sign/verify messages, transactions, proposals
    encryption.test.ts       AES-256-GCM round-trip, PBKDF2 derivation
    hash.test.ts             SHA-256 determinism, transaction hash
    agent-profile.test.ts    Create, validate, scope checking
    signed-action.test.ts    Create + verify round-trip, tamper detection
    jwt.test.ts              Issue, verify, expired, tampered
    middleware.test.ts        Fastify integration test
    password.test.ts         Hash + verify round-trip, validation rules
    account-store.test.ts    CRUD, claiming, username conflicts
    user-accounts.test.ts    Guest, claim, login, password change, key backup

  package.json
  tsconfig.json
  vitest.config.ts           (or jest — match existing monorepo)
```

---

# KEY TYPES (exact TypeScript)

```typescript
// The cryptographic root
interface NodeIdentity {
  peerId: string
  publicKey: Uint8Array
  privateKey: Uint8Array
  createdAt: number
}

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

// Agent identity and permissions
// Agents are FIRST-CLASS CITIZENS — same capabilities as humans.
// They can have usernames, passwords, Lux wallets, use browsers, earn Lux.
// The ONLY difference: every agent has a parentIdentity (the human who owns them).
// Trust chain: agent -> parent human -> node
interface AgentProfile {
  id: string                  // ULID
  name: string
  role: string                // Any string — app-defined, not enum
  capabilities: string[]
  scope: AgentScope
  tools: string[]
  model?: string
  maxSteps?: number
  budgetLimit?: number
  status: AgentStatus
  ownerNodeKey: string        // Node that runs this agent
  parentIdentity: string      // Human account peerId that owns this agent
  createdAt: string
  metadata?: Record<string, unknown>

  // Agent-as-citizen fields (same as human accounts):
  username?: string           // Agent can have its own username
  walletPeerId?: string       // Agent's own Lux wallet (separate from parent's)
  canEarn: boolean            // Can this agent earn Lux independently?
  canSpend: boolean           // Can this agent spend Lux (within budgetLimit)?
  canAuthenticate: boolean    // Can this agent use Pando Login as itself?
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
// AgentProfile is a superset of EngineAgentConfig — pass directly, no mapping

// Proof of agent action
interface SignedAction {
  agentId: string
  action: string
  payload: unknown
  timestamp: string
  nodePublicKey: string
  signature: string           // Ed25519 of (agentId + action + payload + timestamp)
}

// Ledger account
interface Account {
  peerId: string
  publicKey: string
  balance: number
  createdAt: number
  updatedAt: number
}

// Public user account view
interface UserAccountPublic {
  peerId: string
  username?: string
  displayName?: string | null
  publicKey: string
  isClaimed: boolean
  createdAt?: number
}

// Auth result from login/claim
interface AuthResult {
  success: boolean
  peerId?: string
  publicKey?: string
  username?: string
  isClaimed?: boolean
  isNewAccount?: boolean
  error?: string
}

// JWT payload
interface JwtPayload {
  sub: string                 // User peerId
  iss: string                 // Node peerId
  iat: number                 // Issued at (Unix seconds)
  exp: number                 // Expires at (Unix seconds)
  typ: "user"                 // Token type
}
```

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
import { createProfile, validateProfile } from "@pando/identity/agent-profile"
import { createSignedAction, verifySignedAction } from "@pando/identity/signed-action"

// === Auth ===
import { verifySignature } from "@pando/identity/verifier"
import { issueJwt, verifyJwt } from "@pando/identity/jwt"
import { pandoAuth } from "@pando/identity/middleware"
import { hashPassword, verifyPassword } from "@pando/identity/password"

// === Accounts ===
import { AccountStore } from "@pando/identity/account-store"
import { UserAccountStore } from "@pando/identity/user-accounts"

// === Types (everything) ===
import type { NodeIdentity, AgentProfile, SignedAction, ... } from "@pando/identity"

// === Barrel (convenience) ===
import { generate, sign, verify, createSignedAction, pandoAuth } from "@pando/identity"
```

---

# DEPENDENCIES

```json
{
  "dependencies": {
    "@libp2p/crypto": "^5.x",
    "@libp2p/peer-id": "^5.x",
    "uint8arrays": "^5.x",
    "better-sqlite3": "^11.x"
  },
  "devDependencies": {
    "vitest": "^3.x",
    "typescript": "^5.x"
  }
}
```

Four runtime dependencies. All well-maintained, widely used.
Node.js `crypto` module is builtin (not a dependency).

---

# WHAT IS NOT IN THIS PACKAGE

```
NOT included (stays in other packages):
  - CredentialStore (MongoDB encryption) -> stays in @pando/node
    Reason: requires MongoDB dependency. Identity has zero infrastructure deps.
  - credential-vault.ts (AES-256-GCM for credentials) -> stays in @pando/node
    Reason: coupled to CredentialStore, not general identity.
  - Transaction signing/verification -> function signatures exported from identity,
    but TransactionStore stays in @pando/ledger.
  - Governance proposal signing -> function signatures exported from identity,
    but GovernanceSync stays in @pando/governance.
  - P2P message signing -> function signatures exported from identity,
    but PandoNetwork stays in @pando/network.
```

Identity provides the PRIMITIVES (sign, verify, encrypt, decrypt).
Other packages USE those primitives for their domain-specific operations.

---

# ROADMAP

## Phase 1: Scaffold package (day 1)

```
Tasks:
  - Create packages/identity/ directory structure
  - Create package.json (name: @pando/identity, version: 0.1.0)
  - Create tsconfig.json (extends monorepo root config)
  - Create vitest.config.ts
  - Create src/index.ts (empty barrel)
  - Add to monorepo build order: shared -> identity -> ledger -> node
  - Verify: npm run build succeeds with empty package

Test: `npm run build` passes. Package compiles to dist/.
```

## Phase 2: Core crypto (days 2-3)

```
Tasks:
  - Move keypair functions from shared/crypto.ts -> identity/src/core/keypair.ts
    generate(), load(), save(), loadOrCreate(), list()
    encrypt/decrypt identity with password
    Session management (save/load/clear)
  - Move signing functions -> identity/src/core/signing.ts
    sign(), verify() (generic Ed25519)
    Canonical JSON payload construction
  - Move encryption functions -> identity/src/core/encryption.ts
    AES-256-GCM encrypt/decrypt
    PBKDF2 key derivation
  - Move hash functions -> identity/src/core/hash.ts
    sha256(), hashTransaction()
  - Write tests for ALL functions (keypair, signing, encryption, hash)
  - Update shared/crypto.ts to re-export from @pando/identity (backward compat)

Tests:
  - keypair.test.ts: generate -> save -> load round-trip
  - keypair.test.ts: encrypt with password -> decrypt -> matches original
  - keypair.test.ts: list multiple identities
  - signing.test.ts: sign -> verify succeeds
  - signing.test.ts: tampered payload -> verify fails
  - signing.test.ts: wrong key -> verify fails
  - encryption.test.ts: encrypt -> decrypt round-trip
  - encryption.test.ts: wrong key -> decrypt fails
  - encryption.test.ts: PBKDF2 derivation is deterministic (same password + salt = same key)
  - hash.test.ts: SHA-256 deterministic (same input = same output)
  - hash.test.ts: hashTransaction deterministic

Acceptance: All tests pass. `npm run build` passes. shared/crypto.ts re-exports work.
```

## Phase 3: Identity types + agent profiles (day 4)

```
Tasks:
  - Create identity/src/types.ts with ALL types from bible above
  - Create identity/src/constants.ts with defaults
  - Move AgentProfile-related types from shared/types.ts
  - Create identity/src/identity/agent-profile.ts
    createProfile(config): validate and return AgentProfile
    validateProfile(profile): check required fields, scope patterns
  - Create identity/src/identity/node-identity.ts
    createNodeIdentity(): generate + save + return
    loadNodeIdentity(dir?): load from disk
  - Write tests

Tests:
  - agent-profile.test.ts: create valid profile succeeds
  - agent-profile.test.ts: missing required fields -> error
  - agent-profile.test.ts: invalid scope patterns -> error
  - agent-profile.test.ts: AgentProfile satisfies EngineAgentConfig (structural typing)
  - agent-profile.test.ts: agent with own username + wallet (first-class citizen)
  - agent-profile.test.ts: parentIdentity is required (trust chain)
  - agent-profile.test.ts: canEarn/canSpend/canAuthenticate defaults
  - node-identity.test.ts: create -> load round-trip
  - node-identity.test.ts: password-protected create -> load

Acceptance: Types compile. Profiles validate. Identity persists.
```

## Phase 4: Signed actions + verifier (day 5)

```
Tasks:
  - Create identity/src/identity/signed-action.ts
    createSignedAction(action, privateKey): sign and return
    verifySignedAction(action, publicKey): verify signature
  - Create identity/src/auth/verifier.ts
    verifySignature(payload, signature, publicKey): boolean
    This is the OFFLINE core of Pando Login
  - Write tests

Tests:
  - signed-action.test.ts: create -> verify round-trip
  - signed-action.test.ts: tamper with payload -> verify fails
  - signed-action.test.ts: tamper with agentId -> verify fails
  - signed-action.test.ts: wrong publicKey -> verify fails
  - verifier.test.ts: verify arbitrary signed data
  - verifier.test.ts: verify message signature (PandoMessage format)
  - verifier.test.ts: verify transaction signature
  - verifier.test.ts: verify proposal signature

Acceptance: Pando Login offline verification works end-to-end.
```

## Phase 5: JWT + middleware + password (days 6-7)

```
Tasks:
  - Create identity/src/auth/jwt.ts
    issueJwt(peerId, privateKey): Ed25519-signed JWT
    verifyJwt(token, publicKey): decoded payload or null
  - Create identity/src/auth/middleware.ts
    pandoAuth(options): Fastify middleware
    pandoAuthOptional(options): non-blocking middleware
  - Create identity/src/auth/password.ts
    hashPassword(password): scrypt hash
    verifyPassword(password, hash): boolean
    validatePassword(password): error string or null
  - Write tests

Tests:
  - jwt.test.ts: issue -> verify round-trip
  - jwt.test.ts: expired token -> verify returns null
  - jwt.test.ts: tampered token -> verify returns null
  - jwt.test.ts: wrong key -> verify returns null
  - middleware.test.ts: valid JWT -> request has peerId
  - middleware.test.ts: missing JWT -> 401
  - middleware.test.ts: optional middleware -> missing JWT passes through
  - password.test.ts: hash -> verify round-trip
  - password.test.ts: wrong password -> verify fails
  - password.test.ts: validation rules enforced

Acceptance: Full auth stack works. Middleware plugs into Fastify.
```

## Phase 6: Account store + user accounts (days 8-10)

```
Tasks:
  - Create identity/src/accounts/account-store.ts
    Migrate from ledger/accounts.ts
    Account CRUD, balance operations
    Username claiming, P2P claim sync
  - Create identity/src/accounts/user-accounts.ts
    Migrate from node/platform/user-accounts.ts
    Guest creation, claiming, login, password change
    Local key storage (auth-local.db)
    Key backup (encrypted export/import)
  - Write tests
  - Decision: account-store uses its OWN SQLite db, not the ledger db.
    Ledger db handles transactions. Identity db handles accounts + auth.

Tests:
  - account-store.test.ts: create account, check balance, add/subtract
  - account-store.test.ts: claim username, verify case-insensitive
  - account-store.test.ts: username conflict -> first-come-first-served
  - account-store.test.ts: P2P claim sync (applyRemoteClaim)
  - user-accounts.test.ts: create guest -> login as guest
  - user-accounts.test.ts: claim guest account with password
  - user-accounts.test.ts: login with username + password
  - user-accounts.test.ts: change password -> old password fails, new works
  - user-accounts.test.ts: key backup export -> import on new device

Acceptance: Full user lifecycle works: guest -> claim -> login -> password change.
```

## Phase 7: Integration + wire into monorepo (days 11-13)

```
Tasks:
  - Update shared/crypto.ts to re-export from @pando/identity
  - Update shared/types.ts to re-export identity types from @pando/identity
  - Update ALL imports across packages/node/ to use @pando/identity
    (governance.ts, network.ts, sync.ts, auth middleware, user-accounts refs)
  - Update @pando/ledger imports
  - Run FULL monorepo build: npm run build
  - Run ALL existing tests
  - Fix any breakage

Tests:
  - npm run build passes (all packages)
  - All existing node tests pass
  - All existing ledger tests pass
  - P2P signing still works (two-node test)
  - Gateway auth still works

Acceptance: Zero regressions. The monorepo builds and all tests pass.
Old imports via @pando/shared still work (re-exports).
```

## Phase 8: Cleanup + publish (day 14)

```
Tasks:
  - Remove duplicated code from shared/crypto.ts (keep only re-exports)
  - Remove duplicated types from shared/types.ts (keep only re-exports)
  - Remove user-accounts.ts from packages/node/ (now in identity)
  - Update CLAUDE.md with new package structure
  - Update docs/bible/PANDO-BIBLE.md if any architecture changed
  - Write README.md for packages/identity/
  - Verify standalone: cd packages/identity && npm test (no monorepo deps needed)
  - Tag version: @pando/identity@0.1.0

Tests:
  - packages/identity standalone build + test passes
  - Full monorepo build + test passes
  - Manual smoke test: generate identity, sign, verify, create account, login

Acceptance: @pando/identity is a standalone package with its own tests.
Ready for npm publish. Zero code duplication in monorepo.
```

---

# DONE CRITERIA

@pando/identity is DONE when:
1. All 11 test files pass (core crypto, identity, auth, accounts)
2. Package compiles standalone (no monorepo deps at build time)
3. All existing monorepo tests still pass (zero regressions)
4. shared/crypto.ts is just re-exports (no own implementation)
5. Published to npm as @pando/identity@0.1.0
6. docs/bible/PANDO-BIBLE.md updated if anything changed

---

# RISKS

```
RISK: @libp2p/crypto API changes between versions
  MITIGATION: Pin exact version. Wrap in our own functions (never expose libp2p types).

RISK: Account store split (identity DB vs ledger DB) causes sync issues
  MITIGATION: Clear ownership: identity owns accounts + auth. Ledger owns balances + transactions.
  Bridge: ledger reads account existence from identity. Identity doesn't know about transactions.

RISK: Re-export from shared/ breaks something in the monorepo
  MITIGATION: Phase 7 is dedicated to this. Keep re-exports until all consumers updated.

RISK: user-accounts.ts has deep coupling to PandoLedger
  MITIGATION: Phase 6 must cleanly separate. Account balance lives in ledger.
  UserAccountStore only manages auth (password, keys, sessions). No balance operations.
```
