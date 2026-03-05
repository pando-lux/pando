# Phase 86: JWT-Style Self-Verifying Auth Tokens

**Status:** PLAN — awaiting approval
**Goal:** Replace all node-local auth tokens with self-verifying JWT-style tokens that ANY node can validate using the P2P-synced ledger. Zero database lookups for auth. Zero in-memory token stores. True multi-node auth.

---

## 1. Why This Redesign Is Necessary

The current auth architecture has three token types, ALL node-local:

| Token Type | Storage | TTL | Cross-Node? |
|---|---|---|---|
| Session token | SQLite `auth_sessions` table (one node) | 7 days | NO |
| Signature auth token | In-memory `Map<string, AuthTokenEntry>` | 15 min | NO |
| Challenge nonce | In-memory `Map<string, ChallengeEntry>` | 60 sec | NO |

**What breaks:**
- Vercel gateway runs each API route as a separate Lambda. Different Lambdas can hit different nodes.
- Challenge issued on Node A, verify hits Node B → "Unknown or expired challenge"
- Token issued on Node A, thread creation routed to Node B → `userId` is null
- Session created on Node A, `/auth/me` hits Node B → 401

**Phase 85 band-aids (to be removed):**
- Persisting tokens to MongoDB (`auth_tokens` collection)
- 3-level `resolveUserPeerId()` fallback (in-memory → MongoDB → SQLite)
- Challenge/verify pinned to 'primary' node

**Proper solution:** Self-verifying tokens. Token = payload + signature. Any node verifies using the issuing node's public key from the P2P-synced ledger. No lookups needed.

---

## 2. New Token Architecture

### 2.1 Token Format

```
TOKEN = base64url(PAYLOAD_JSON) + "." + hex(ED25519_SIGNATURE)
```

**Payload:**
```json
{
  "sub": "<user-peerId>",
  "iss": "<issuing-node-peerId>",
  "iat": 1740000000000,
  "exp": 1740086400000,
  "typ": "user"
}
```

- `sub` (subject) — the user's peerId (the identity being authenticated)
- `iss` (issuer) — the node that issued this token (its peerId, registered in the P2P ledger)
- `iat` (issued at) — timestamp in milliseconds
- `exp` (expires at) — timestamp in milliseconds (24 hours from issuance)
- `typ` — token type: `"user"` for user auth tokens

### 2.2 Token Signing

The **issuing node** signs the token with its own Ed25519 private key:
```
signature = ed25519.sign(base64url(payload), nodePrivateKey)
```

### 2.3 Token Verification (ANY node)

Any node receiving a request with this token:
1. Split token on `"."` → `[payloadB64, signatureHex]`
2. Decode payload → extract `iss` (issuer node peerId)
3. Look up issuer's public key from the **P2P-synced ledger** (every node has this)
4. Verify: `ed25519.verify(signatureHex, payloadB64, issuerPublicKey)`
5. Check `exp > Date.now()`
6. Extract `sub` → this is the authenticated user's peerId

**No database. No in-memory store. No P2P proxy. Just math.**

### 2.4 Stateless Challenge/Verify Flow

Currently the challenge nonce is stored in-memory. We make it stateless too:

**New challenge flow:**
1. Browser: `POST /auth/challenge` with `{ peerId }`
2. Node generates nonce, creates a **signed challenge token**:
   ```
   challengeToken = base64url({ nonce, peerId, exp: now+60s, iss: nodeId }) + "." + signature
   ```
3. Returns `{ challengeToken, nonce }` to browser
4. Browser signs the nonce with its private key
5. Browser: `POST /auth/verify` with `{ peerId, challengeToken, signature }`
6. **ANY node** (can be different from step 2!):
   a. Verifies `challengeToken` signature using issuer's public key from ledger
   b. Checks `challengeToken` hasn't expired
   c. Extracts nonce from `challengeToken`
   d. Verifies user's Ed25519 signature over the nonce using user's public key from ledger
   e. Issues a 24-hour user JWT signed with THIS node's key
7. Returns `{ token: <jwt>, expiresAt, peerId }`

**Result:** Challenge can hit Node A, verify can hit Node B. Both are stateless.

### 2.5 Token Issuance Points

| Event | Who Issues JWT | TTL |
|---|---|---|
| Guest creation (`POST /auth/guest`) | The node handling the request | 24 hours |
| Signature auth verify (`POST /auth/verify`) | The node handling the request | 24 hours |
| Login (`POST /auth/login`) | The node handling the request | 24 hours |
| Token refresh (`POST /auth/refresh`) | The node handling the request | 24 hours |
| Claim account (`POST /auth/claim`) | The node handling the request | 24 hours |

### 2.6 Token Refresh

Browser-side: schedule refresh 1 hour before expiry (was 60 seconds with 15-min tokens). Uses signature auth (challenge/verify) if private key is available, otherwise falls back to presenting the current JWT to `/auth/refresh` to get a new one.

---

## 3. Code to REMOVE (Phase 85 Band-Aids)

### 3.1 `packages/node/src/api-server.ts` — Remove MongoDB Token Persistence

**DELETE — Line ~4689-4693:** MongoDB token persistence in `/auth/verify`
```typescript
// Phase 85: Persist token to shared storage for cross-node validation
const backend = this.node.getStorageBackend();
if (backend) {
  backend.putRecord('auth_tokens', token, { peerId, expiresAt: tokenExpiresAt }).catch(() => {});
}
```

**DELETE — Lines 6824-6837:** MongoDB fallback in `resolveUserPeerId()`
```typescript
// Phase 85: Check shared storage for cross-node signature auth tokens
const backend = this.node.getStorageBackend();
if (backend) {
  try {
    const stored = await backend.getRecord('auth_tokens', userToken);
    // ... entire block
  } catch { }
}
```

**DELETE — Lines 4485-4500:** MongoDB fallback in `/auth/me`
```typescript
// Phase 85: Fallback to shared storage for cross-node signature auth tokens
if (!sigPeerId) {
  const backend = this.node.getStorageBackend();
  // ... entire block
}
```

### 3.2 `packages/node/src/api-server.ts` — Remove In-Memory Token Stores

**DELETE — Lines 48-51:** `challengeStore` and `signatureAuthTokens` Map declarations
```typescript
const challengeStore = new Map<string, ChallengeEntry>();
const signatureAuthTokens = new Map<string, AuthTokenEntry>();
```

**DELETE — Lines 53-64:** Cleanup interval for expired challenges/tokens
```typescript
const AUTH_CLEANUP_INTERVAL = setInterval(() => { ... }, 60_000);
AUTH_CLEANUP_INTERVAL.unref();
```

**DELETE — ChallengeEntry and AuthTokenEntry interfaces** (lines ~30-45)

### 3.3 `packages/gateway/app/api/auth/challenge/route.ts` — Remove Primary Pinning

**CHANGE:** Remove `'primary'` preference. With stateless challenges, any node can issue them.
```typescript
// BEFORE (Phase 85):
const res = await fetchFromNode("/auth/challenge", { ... }, 'primary');
// AFTER:
const res = await fetchFromNode("/auth/challenge", { ... });
```

### 3.4 `packages/gateway/app/api/auth/verify/route.ts` — Remove Primary Pinning

**CHANGE:** Remove `'primary'` preference. With stateless challenges, any node can verify.
```typescript
// BEFORE (Phase 85):
const res = await fetchFromNode("/auth/verify", { ... }, 'primary');
// AFTER:
const res = await fetchFromNode("/auth/verify", { ... });
```

---

## 4. Legacy Code to REMOVE or REPLACE

### 4.1 `packages/node/src/user-accounts.ts` — Remove SQLite Session Management

**REMOVE: `auth_sessions` table and all code that reads/writes it.**

The following methods currently create sessions in SQLite. They will be changed to return JWTs instead:

| Method | Current Action | New Action |
|---|---|---|
| `createGuest()` (line 245) | Generates session token, inserts into `auth_sessions` | Returns unsigned result; API server issues JWT |
| `createGuestFromBrowserKey()` (line 297) | Generates session token, inserts into `auth_sessions` | Returns unsigned result; API server issues JWT |
| `login()` (line 436) | Generates session token, inserts into `auth_sessions` | Returns unsigned result; API server issues JWT |
| `claim()` (line 349) | Generates session token, inserts into `auth_sessions` | Returns unsigned result; API server issues JWT |
| `validateSession()` (line 565) | Queries `auth_sessions` SQLite | **DELETE ENTIRELY** — JWT verification is in api-server |
| `refreshSession()` (line 590) | Updates `auth_sessions` expiry | **DELETE ENTIRELY** — replaced by JWT re-issuance |
| `logout()` (line 544) | Deletes from `auth_sessions` | Simplified — just clear client-side state |
| `generateToken()` | Generates random 32-byte hex token | **DELETE** — replaced by JWT signing |

**Schema change:** The `auth_sessions` table in `initSchema()` can be removed. The `key_store` table (encrypted private keys) stays — it's used for server-generated guests and key backup.

### 4.2 `packages/node/src/api-server.ts` — Replace resolveUserPeerId()

**REPLACE the entire `resolveUserPeerId()` method** (lines 6809-6844) with JWT verification:

```typescript
private verifyUserJwt(request?: any): string | null {
  if (!request) return null;
  const token = this.extractUserToken(request);
  if (!token) return null;
  return this.verifyJwtToken(token);
}

private verifyJwtToken(token: string): string | null {
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) return null;  // Not a JWT

  const payloadB64 = token.substring(0, dotIdx);
  const signatureHex = token.substring(dotIdx + 1);

  try {
    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadJson);

    // Check expiry
    if (!payload.exp || payload.exp <= Date.now()) return null;

    // Look up issuer's public key from ledger
    const ledger = this.node.getLedger();
    if (!ledger) return null;
    const issuerAccount = ledger.accounts.get(payload.iss);
    if (!issuerAccount?.publicKey) return null;

    // Verify Ed25519 signature
    const publicKeyRaw = uint8ArrayFromString(issuerAccount.publicKey, 'base64');
    const payloadBytes = new TextEncoder().encode(payloadB64);
    const sigBytes = uint8ArrayFromString(signatureHex, 'base16');

    // Use @noble/curves ed25519 directly (no protobuf wrapping needed)
    const { ed25519 } = require('@noble/curves/ed25519');
    const verified = ed25519.verify(sigBytes, payloadBytes, publicKeyRaw);

    if (!verified) return null;
    return payload.sub;  // The authenticated user's peerId
  } catch {
    return null;
  }
}
```

### 4.3 `packages/node/src/api-server.ts` — Replace `/auth/me` Handler

**Lines 4472-4540:** Replace the 3-tier lookup with simple JWT decode:

```typescript
this.fastify.get('/auth/me', async (request: any, reply: any) => {
  const peerId = this.verifyUserJwt(request);
  if (!peerId) {
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }

  const ledger = this.node.getLedger();
  let balance = 0, publicKey = '', username: string | undefined, isClaimed = false;
  if (ledger) {
    balance = ledger.accounts.getBalance(peerId);
    const account = ledger.accounts.get(peerId);
    if (account) {
      publicKey = account.publicKey || '';
      username = account.username || undefined;
      isClaimed = !!account.is_claimed;
    }
  }
  return { user: { peerId, publicKey, username, isClaimed, balance, authMethod: 'jwt' } };
});
```

### 4.4 `packages/node/src/api-server.ts` — Replace `/auth/challenge` Handler

**Lines 4576-4597:** Replace with stateless challenge token:

```typescript
this.fastify.post('/auth/challenge', async (request: any, reply: any) => {
  const { peerId } = (request.body || {}) as { peerId?: string };
  if (!peerId || typeof peerId !== 'string') {
    return reply.code(400).send({ error: 'peerId is required' });
  }

  const nonce = randomBytes(32).toString('hex');
  const identity = this.node.getIdentity();
  if (!identity) {
    return reply.code(503).send({ error: 'Node identity not available' });
  }

  // Create a signed challenge token (stateless — no in-memory storage)
  const challengePayload = {
    nonce,
    sub: peerId,
    iss: identity.peerId,
    exp: Date.now() + 60_000,  // 60-second TTL
    typ: 'challenge',
  };
  const payloadB64 = Buffer.from(JSON.stringify(challengePayload)).toString('base64url');
  const payloadBytes = new TextEncoder().encode(payloadB64);
  const signature = await identity.privateKey.sign(payloadBytes);
  const signatureHex = uint8ArrayToString(signature, 'base16');

  const challengeToken = payloadB64 + '.' + signatureHex;
  return { challengeToken, nonce, expiresAt: challengePayload.exp };
});
```

### 4.5 `packages/node/src/api-server.ts` — Replace `/auth/verify` Handler

**Lines 4600-4696:** Replace with stateless challenge verification + JWT issuance:

```typescript
this.fastify.post('/auth/verify', async (request: any, reply: any) => {
  const { peerId, challengeToken, signature } = (request.body || {}) as {
    peerId?: string; challengeToken?: string; signature?: string;
  };

  if (!peerId || !challengeToken || !signature) {
    return reply.code(400).send({ error: 'peerId, challengeToken, and signature are required' });
  }

  // 1. Verify the challenge token (signed by the issuing node)
  const dotIdx = challengeToken.indexOf('.');
  if (dotIdx === -1) return reply.code(400).send({ error: 'Invalid challenge token format' });

  const cPayloadB64 = challengeToken.substring(0, dotIdx);
  const cSigHex = challengeToken.substring(dotIdx + 1);

  let challengePayload: any;
  try {
    challengePayload = JSON.parse(Buffer.from(cPayloadB64, 'base64url').toString('utf8'));
  } catch {
    return reply.code(400).send({ error: 'Invalid challenge token payload' });
  }

  // Check challenge expiry
  if (!challengePayload.exp || challengePayload.exp <= Date.now()) {
    return reply.code(401).send({ error: 'Challenge expired' });
  }
  if (challengePayload.typ !== 'challenge') {
    return reply.code(400).send({ error: 'Invalid token type' });
  }
  if (challengePayload.sub !== peerId) {
    return reply.code(401).send({ error: 'Challenge was issued for a different peerId' });
  }

  // Verify challenge token signature (issuing node's public key from ledger)
  const ledger = this.node.getLedger();
  if (!ledger) return reply.code(503).send({ error: 'Ledger not available' });

  const issuerAccount = ledger.accounts.get(challengePayload.iss);
  if (!issuerAccount?.publicKey) {
    return reply.code(401).send({ error: 'Unknown challenge issuer' });
  }

  try {
    const { ed25519 } = await import('@noble/curves/ed25519');
    const issuerPubRaw = uint8ArrayFromString(issuerAccount.publicKey, 'base64');
    const cPayloadBytes = new TextEncoder().encode(cPayloadB64);
    const cSigBytes = uint8ArrayFromString(cSigHex, 'base16');
    const challengeValid = ed25519.verify(cSigBytes, cPayloadBytes, issuerPubRaw);
    if (!challengeValid) {
      return reply.code(401).send({ error: 'Challenge token signature invalid' });
    }
  } catch (err: any) {
    return reply.code(401).send({ error: 'Challenge verification error', detail: err?.message });
  }

  // 2. Verify the user's signature over the nonce
  const userAccount = ledger.accounts.get(peerId);
  let userPubKey: string | null = null;

  const identity = this.node.getIdentity();
  if (identity && identity.peerId === peerId) {
    userPubKey = uint8ArrayToString(identity.publicKey, 'base64');
  }
  if (!userPubKey && userAccount?.publicKey) {
    userPubKey = userAccount.publicKey;
  }
  if (!userPubKey) {
    return reply.code(401).send({ error: 'Unknown peerId — no public key found in ledger' });
  }

  try {
    const { ed25519 } = await import('@noble/curves/ed25519');
    const userPubRaw = uint8ArrayFromString(userPubKey, 'base64');
    const nonceBytes = uint8ArrayFromString(challengePayload.nonce, 'base16');
    const sigBytes = uint8ArrayFromString(signature, 'base16');
    const userValid = ed25519.verify(sigBytes, nonceBytes, userPubRaw);
    if (!userValid) {
      return reply.code(401).send({ error: 'Signature verification failed' });
    }
  } catch (err: any) {
    return reply.code(401).send({ error: 'Signature verification error', detail: err?.message });
  }

  // 3. Issue a JWT signed by THIS node
  const jwt = this.issueJwt(peerId);
  return jwt;
});
```

### 4.6 New Helper: `issueJwt()` on ApiServer

```typescript
private async issueJwt(userPeerId: string): Promise<{ token: string; expiresAt: number; peerId: string }> {
  const identity = this.node.getIdentity();
  if (!identity) throw new Error('Node identity not available');

  const expiresAt = Date.now() + 24 * 60 * 60_000;  // 24 hours
  const payload = {
    sub: userPeerId,
    iss: identity.peerId,
    iat: Date.now(),
    exp: expiresAt,
    typ: 'user',
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const payloadBytes = new TextEncoder().encode(payloadB64);

  // Sign with node's Ed25519 private key (protobuf-serialized → libp2p PrivateKey → .sign())
  const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
  const pk = privateKeyFromProtobuf(identity.privateKey);
  const sig = await pk.sign(payloadBytes);
  const signatureHex = uint8ArrayToString(sig, 'base16');

  const token = payloadB64 + '.' + signatureHex;
  return { token, expiresAt, peerId: userPeerId };
}
```

### 4.7 `packages/node/src/api-server.ts` — Update `/auth/guest` Handler

**Lines 4268-4316:** After guest creation, issue JWT instead of returning session token:

```typescript
// BEFORE:
return result;  // { success, token: <session-token>, peerId, publicKey, ... }

// AFTER:
if (!result.success) return reply.code(500).send({ error: result.error });
const jwt = this.issueJwt(result.peerId);
return { success: true, token: jwt.token, expiresAt: jwt.expiresAt, peerId: result.peerId, publicKey: result.publicKey, isClaimed: false, isNewAccount: result.isNewAccount };
```

**UserAccountStore changes:** `createGuest()` and `createGuestFromBrowserKey()` no longer generate tokens or write to `auth_sessions`. They only: generate identity, register in ledger, store key. Return `{ success, peerId, publicKey, isNewAccount }` (no token).

### 4.8 `packages/node/src/api-server.ts` — Update `/auth/login` Handler

Similar pattern: UserAccountStore.login() validates password, returns peerId. API server issues JWT.

### 4.9 `packages/node/src/api-server.ts` — Update `/auth/refresh` Handler

```typescript
this.fastify.post('/auth/refresh', async (request: any, reply: any) => {
  // Verify the existing JWT
  const currentPeerId = this.verifyUserJwt(request);
  if (!currentPeerId) {
    return reply.code(401).send({ error: 'Invalid or expired token' });
  }
  // Issue a fresh JWT
  const jwt = this.issueJwt(currentPeerId);
  return jwt;
});
```

### 4.10 `packages/node/src/api-server.ts` — Update `/auth/logout` Handler

Logout becomes a no-op on the server. The JWT is stateless — the client simply discards it. No database cleanup needed.

```typescript
this.fastify.post('/auth/logout', async () => {
  return { success: true };
});
```

### 4.11 `extractUserToken()` — Keep As-Is

The `extractUserToken()` method (lines 6781-6799) extracts the token string from headers. This stays unchanged — the token format (JWT vs opaque) doesn't affect extraction.

### 4.12 All ~50 Callers of `resolveUserPeerId()` — Rename

Rename all calls from `resolveUserPeerId(request)` → `verifyUserJwt(request)`. The method signature and return type (`string | null`) are identical, so this is a safe search-and-replace.

---

## 5. Gateway Changes

### 5.1 `packages/gateway/lib/auth-context.tsx`

**Changes:**
1. **`signatureAuth()` function (lines 50-89):** Update to send `challengeToken` (not raw `challenge`) to verify endpoint:
   ```typescript
   // Step 1: Request challenge — now returns { challengeToken, nonce }
   const { challengeToken, nonce } = await challengeRes.json();
   // Step 2: Sign the NONCE (not the challengeToken)
   const signature = signChallenge(nonce, privateKey);
   // Step 3: Send challengeToken + signature to verify
   body: JSON.stringify({ peerId, challengeToken, signature })
   ```

2. **`createGuest()` (lines 155-189):** The response now includes `expiresAt`. Schedule refresh:
   ```typescript
   if (data.success && data.token && data.peerId) {
     storePrivateKey(data.peerId, privateKey);
     saveToken(data.token);
     sigAuthPeerIdRef.current = data.peerId;
     scheduleRefresh(data.expiresAt, data.peerId);  // NEW: schedule refresh for JWT
     // ... set user
   }
   ```

3. **`scheduleRefresh()` (lines 110-127):** Change refresh interval from 60 seconds before expiry to **1 hour before expiry** (since JWTs are 24h, not 15min):
   ```typescript
   const refreshIn = Math.max(expiresAt - Date.now() - 3_600_000, 60_000);
   ```

4. **Remove `authMethod` distinction.** Everything is JWT now. Remove `"signature" | "session"` from `AuthUser.authMethod` — it's always JWT.

5. **Login flow (lines 257-344):** After login returns JWT + peerId, try to restore private key from backup. If successful, do signature auth for a fresh JWT. If not, the login JWT already works. Remove the session-auth fallback path.

### 5.2 `packages/gateway/app/api/auth/challenge/route.ts`

Remove `'primary'` preference:
```typescript
const res = await fetchFromNode("/auth/challenge", { ... });  // any node
```

### 5.3 `packages/gateway/app/api/auth/verify/route.ts`

Remove `'primary'` preference:
```typescript
const res = await fetchFromNode("/auth/verify", { ... });  // any node
```

### 5.4 `packages/gateway/lib/crypto.ts` — Fix `getStoredPeerId()` Bug

**Lines 74-82:** Currently returns the FIRST localStorage key matching `pando_privkey_` prefix (arbitrary order — often the oldest). Fix to return the MOST RECENTLY STORED key:

```typescript
export function getStoredPeerId(): string | null {
  // Return the most recent peerId with a stored private key
  // localStorage order is arbitrary, so we check all and pick the last one set
  // Since we can't reliably determine order, just return the first found
  // The real fix: on login, we should set a "current peerId" marker
  const currentPeerId = localStorage.getItem('pando_current_peerId');
  if (currentPeerId) {
    const hasKey = localStorage.getItem(PRIVATE_KEY_PREFIX + currentPeerId);
    if (hasKey) return currentPeerId;
  }
  // Fallback: scan for any stored key
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PRIVATE_KEY_PREFIX)) {
      return key.slice(PRIVATE_KEY_PREFIX.length);
    }
  }
  return null;
}
```

Also add: when `storePrivateKey()` is called, set `pando_current_peerId`:
```typescript
export function storePrivateKey(peerId: string, privateKey: Uint8Array): void {
  const b64 = btoa(String.fromCharCode(...privateKey));
  localStorage.setItem(PRIVATE_KEY_PREFIX + peerId, b64);
  localStorage.setItem('pando_current_peerId', peerId);  // NEW: track current identity
}
```

---

## 6. What to KEEP (Good Code from Phase 85)

| Code | Location | Why Keep |
|---|---|---|
| `fetchFromNode()` utility | `packages/gateway/lib/node-connection.ts` lines 683-713 | Retry/failover for all gateway→node calls. Solid. |
| Cold-start randomization | `packages/gateway/lib/node-pool.ts` lines 147-151 | Prevents always hitting dead primary on Lambda cold start. |
| Shared API token | All 5 nodes use `bd5b00...` | Node-level auth (gateway→node) is separate from user auth (user→node). Keep shared. |
| 15 gateway routes using `fetchFromNode()` | Various `app/api/` routes | Better than raw `getNodeUrl()` + single fetch. Keep. |

---

## 7. Node Private Key Access (RESOLVED)

`NodeIdentity.privateKey` is a **protobuf-serialized** Ed25519 private key (not raw bytes). This is the same format used by `signMessage()` and `signTransaction()` in `packages/shared/src/crypto.ts`.

**How to sign in `issueJwt()`:**
```typescript
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';

const pk = privateKeyFromProtobuf(identity.privateKey);
const sig = await pk.sign(payloadBytes);  // Returns Uint8Array
```

This is the established pattern used throughout the codebase (network.ts line 384, crypto.ts line 102). The `issueJwt()` method must be **async** because `pk.sign()` is async.

**For verification**, we use the raw 32-byte public key from the ledger with `@noble/curves` `ed25519.verify()` (sync) — or `publicKeyFromProtobuf()` + `pk.verify()` (async). Either works. The verification side uses the same pattern as the existing `/auth/verify` handler (lines 4660-4670).

---

## 8. Edge Cases

### 8.1 New Guest Not Yet in Ledger

When a guest is created on Node A, `registerNode()` broadcasts to the P2P network. Other nodes receive it via GossipSub. There's a propagation delay (~1-5 seconds).

**Scenario:** Guest created on Node A. Browser's next request hits Node B. JWT verification on Node B looks up issuer (Node A) in ledger — found (nodes register at boot). Then looks up user peerId — NOT YET SYNCED.

**Solution:** The guest creation response includes the JWT. The JWT's `iss` field is the node that created the guest. When verifying, if `sub` (user) is not in the local ledger but the JWT signature is valid (issuer is trusted), we can trust the `sub` claim. The issuer node vouches for the user's existence.

**Implementation:** In `verifyJwtToken()`, after signature verification passes, if `sub` is not in the local ledger, still return `sub` — the cryptographic proof is sufficient. The ledger will catch up.

### 8.2 Node Not Yet in Ledger

A brand-new node that just booted may not be in other nodes' ledgers yet. Its JWTs would fail verification on other nodes.

**Solution:** Nodes register in the ledger at boot and broadcast via GossipSub. By the time a user authenticates (takes ~1-2 seconds for challenge/verify), the node's ledger entry has propagated. In practice, nodes are long-lived. This is not a realistic failure mode.

### 8.3 Token Replay

JWTs are bearer tokens — anyone with the token can use it. This is the same as the current session tokens. Mitigation: HTTPS everywhere (Vercel gateway uses HTTPS, node API on localhost or Tailscale).

### 8.4 Backward Compatibility

**There is none.** All existing session tokens and signature auth tokens become invalid after this change. Every user must re-authenticate. This is acceptable because:
- Most users are guests (ephemeral, auto-recreated)
- Claimed users just log in again
- The network is in pre-launch testing

---

## 9. Architecture Docs to Update

| File | Changes |
|---|---|
| `genome/components/api-server.md` | Document JWT token format, stateless challenge, `verifyUserJwt()`, remove session token docs |
| `genome/components/gateway.md` | Update auth proxy pattern, remove primary pinning docs, document JWT flow |
| `genome/components/user-accounts.md` | Remove session management, document simplified role (identity + password only) |
| `genome/flows/auth-flow.md` | New file: complete JWT auth flow diagram (guest → signature → login → refresh) |
| `genome/state.md` | Update current phase, remove Phase 85 band-aid from known issues |
| `genome/history/phases.md` | Add Phase 86 entry |
| `CLAUDE.md` | Update auth section with JWT details |
| `memory/MEMORY.md` | Update "Auth Architecture" section |

---

## 10. Implementation Order

### Step 1: Core JWT Infrastructure (api-server.ts)
1. Add `issueJwt()` private method
2. Add `verifyJwtToken()` private method
3. Add `verifyUserJwt()` private method (replaces `resolveUserPeerId()`)

### Step 2: Replace Auth Endpoints (api-server.ts)
4. Replace `/auth/challenge` with stateless signed challenge
5. Replace `/auth/verify` with stateless verification + JWT issuance
6. Replace `/auth/guest` to return JWT
7. Replace `/auth/login` to return JWT
8. Replace `/auth/refresh` with JWT re-issuance
9. Simplify `/auth/logout` (server no-op)
10. Simplify `/auth/me` (JWT decode only)

### Step 3: Clean Up Callers (api-server.ts)
11. Rename all `resolveUserPeerId()` → `verifyUserJwt()` (50+ call sites)
12. Delete `challengeStore` Map + `signatureAuthTokens` Map + cleanup interval
13. Delete `ChallengeEntry` and `AuthTokenEntry` interfaces
14. Delete Phase 85 MongoDB token persistence code

### Step 4: Update UserAccountStore (user-accounts.ts)
15. Remove token generation from `createGuest()`, `createGuestFromBrowserKey()`, `login()`, `claim()`
16. Remove `validateSession()`, `refreshSession()`, `generateToken()`
17. Remove `auth_sessions` table creation from `initSchema()`
18. Keep: key_store table, password hashing, claim logic, backup-key storage

### Step 5: Gateway Changes
19. Update `auth-context.tsx` — new challenge flow, JWT refresh schedule, remove authMethod distinction
20. Update `lib/crypto.ts` — fix `getStoredPeerId()`, add `pando_current_peerId` tracking
21. Remove `'primary'` from challenge/verify gateway routes
22. Remove Phase 85 comments from all gateway routes

### Step 6: Build & Deploy
23. `npm run build` — verify TypeScript compiles
24. Deploy to all 5 nodes (EC2-1, EC2-2, LS-1, LS-2, Windows)
25. Deploy gateway to Vercel

### Step 7: E2E Test
26. Clear browser localStorage completely
27. Open gateway → guest auto-creation → verify JWT issued
28. Send a chat message → verify userId present in MongoDB thread
29. Refresh page → verify JWT validates on potentially different node
30. Kill primary node, repeat test → verify failover works
31. Login as claimed user → verify JWT issued → verify cross-node /auth/me works
32. GW-03 test: kill node mid-session, verify seamless failover

---

## 11. Verification Criteria

| # | Test | Pass Criteria |
|---|---|---|
| 1 | Guest creation | JWT returned with valid `sub`, `iss`, `exp` fields |
| 2 | JWT verification on different node | `/auth/me` returns user info when hitting a different node than the one that issued the JWT |
| 3 | Stateless challenge | Challenge from Node A, verify on Node B → JWT issued |
| 4 | Chat message userId | `POST /chat/message` → thread in MongoDB has correct `userId` field |
| 5 | Thread listing | `GET /chat/threads` → returns only threads owned by the JWT user |
| 6 | Token refresh | After 23 hours, auto-refresh gets new JWT from any node |
| 7 | Node failover | Kill primary, all auth operations continue on fallback nodes |
| 8 | Login cross-node | Login on Node A, subsequent requests hit Node B → authenticated |
| 9 | No in-memory state | Restart a node → existing JWTs still verify (stateless) |
| 10 | No MongoDB dependency | Untrusted node (no MongoDB) can verify JWTs and serve authenticated requests |

---

## 12. Risk Assessment

| Risk | Mitigation |
|---|---|
| Node private key extraction wrong | Test `getIdentity()` return format before coding. Add assertion. |
| Ledger propagation delay for new guests | Trust JWT signature even if `sub` not yet in local ledger |
| Breaking all existing sessions | Acceptable for pre-launch. Forced re-auth is fine. |
| @noble/curves version mismatch | Gateway already pins v1.x. Node uses libp2p's copy. Verify compatibility. |
| Token size (JWT is larger than 64-char hex) | ~200 bytes total. Fits in any header. Not a concern. |
