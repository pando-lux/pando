---
id: user-accounts
type: service
domain: identity
entry: packages/node/src/user-accounts.ts
depends_on: [ledger]
depended_by: [api-server, thread-store, tui]
exposes:
  - createGuest(opts?) — auto-create anonymous guest, returns AuthResult with session token + Ed25519 keypair
  - claim(token, username, password) — upgrade guest to claimed account (delegates to ledger.claimAccount, broadcasts ACCOUNT_CLAIM via P2P)
  - login(username, password, opts?) — authenticate via ledger.getByUsername + ledger.getAuthFields, returns AuthResult
  - loginByPeerId(peerId, password, opts?) — authenticate via peerId
  - logout(token) — invalidate single session (local auth-local.db)
  - logoutAll(userId) — invalidate all sessions for user
  - validateSession(token) — returns userId or null (local auth-local.db)
  - refreshSession(token) — extend session TTL
  - getProfile(token) — returns UserAccountPublic
  - getIdentityByPeerId(peerId) — lookup identity by peerId (ledger)
  - getEncryptedKey(userId) — retrieve encrypted private key from local key_store
  - storeEncryptedKey(userId, key) — store encrypted key in local key_store
  - changePassword(userId, currentPassword, newPassword) — updates ledger + invalidates sessions
  - getUserSessions(userId) — list active sessions (tokens truncated)
  - getStats() — summary statistics (total accounts, active sessions)
  - cleanupExpiredSessions() — garbage collect expired sessions
  - startCleanup() / stopCleanup() — manage cleanup timer (30-min interval)
rules: [data-residency, credential-security]
last_verified: 2026-02-22
---

# User Accounts (Phase 56: P2P User Accounts)

## What It Does

Unified Ed25519 identity system with P2P-synced auth data. Auto-guest creation, claim with password+username, login via username or peerId. Auth data lives in the ledger (P2P-synced). Sessions and encrypted keys live in local SQLite only.

## Architecture (Phase 56)

- **Auth data in ledger (P2P-synced):** `username`, `display_name`, `password_hash`, `is_claimed` columns on the ledger `accounts` table. Synced across all nodes via existing ledger GossipSub. Login works from any node.
- **Local auth-local.db (NOT synced):** Two tables: `auth_sessions` (session tokens, TTL, per-node) and `key_store` (encrypted Ed25519 private keys, per-node). These are node-local — sessions are only valid on the node that created them.
- **No MongoDB/StorageBackend dependency.** Constructor takes `PandoLedger` directly. All prior StorageBackend/MongoDB code paths removed.

## How Account Claims Work

1. Guest created via `createGuest()` — registers peerId in ledger, stores encrypted key in local `key_store`.
2. User calls `claim(token, username, password)` — calls `ledger.claimAccount(peerId, username, passwordHash)` which sets `username`, `password_hash`, `is_claimed` on the ledger account.
3. Node broadcasts `ACCOUNT_CLAIM` via GossipSub — all peers receive and call `ledger.applyRemoteClaim()` to update their local ledger copy.
4. On sync catch-up, `SYNC_RESPONSE` includes claimed accounts so new/reconnecting nodes get the full picture.
5. **Username conflict resolution:** First-come-first-served by timestamp. `isUsernameAvailable()` checks before claim.

## How Login Works (Any Node)

1. `login(username, password)` calls `ledger.getByUsername(username)` to find the account.
2. `ledger.getAuthFields(peerId)` returns `password_hash`.
3. PBKDF2 verify against stored hash. On success, creates session in local `auth-local.db`.
4. Works from any node because auth data is in the P2P-synced ledger.

## Key Details

- **Identity:** Ed25519 keypairs. Guests get auto-generated keypair. Claimed users encrypt their private key with PBKDF2 + AES-256-GCM at rest.
- **Session tokens:** 64-byte random hex (512-bit), 7-day default TTL. Auto-garbage collected every 30 minutes.
- **Password hashing:** PBKDF2 (100K iterations, SHA-512, 64-byte key, 32-byte salt). Timing-safe comparison.
- **Lux faucet:** New guests receive welcome Lux (25 base x early multiplier). Unclaimed guests older than 30 days have Lux reclaimed.

## API Routes (in api-server.ts)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /auth/guest | No | Create anonymous guest (auto Ed25519 keypair) |
| POST | /auth/claim | User token | Upgrade guest to claimed account (broadcasts ACCOUNT_CLAIM) |
| POST | /auth/login | No | Login by username+password (works from any node) |
| POST | /auth/login-peer | No | Login by peerId+password |
| POST | /auth/logout | User token | Invalidate session |
| GET | /auth/me | User token | Get current user profile + Lux balance |
| POST | /auth/refresh | User token | Extend session TTL |
| POST | /auth/change-password | User token | Change password |
| GET | /auth/sessions | User token | List active sessions |
| GET | /auth/stats | No | Public account statistics |

User token passed via `X-User-Token` header (separate from node-level `Authorization: Bearer` token).

## Key Files

- `packages/node/src/user-accounts.ts` — UserAccountStore class (takes PandoLedger)
- `packages/node/src/api-server.ts` — Auth API routes
- `packages/ledger/src/index.ts` — PandoLedger with claimAccount, applyRemoteClaim, getByUsername, getAuthFields, isUsernameAvailable, getClaimedAccounts
- `packages/shared/src/types.ts` — UserAccount, UserAccountPublic, AuthSession, AuthResult types
