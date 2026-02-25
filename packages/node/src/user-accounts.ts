/**
 * UserAccountStore — Phase 56: P2P-synced user accounts via ledger.
 *
 * Auth data (username, password_hash, is_claimed) lives in the ledger's accounts table,
 * synced across all nodes via GossipSub. Local-only data (encrypted private keys,
 * auth sessions) lives in auth-local.db on this node.
 *
 * Every user gets an Ed25519 keypair (same as node identities). The peerId IS the account ID.
 * Guests are auto-created with keys encrypted by a node-level secret.
 * Claimed accounts re-encrypt the key with the user's password.
 *
 * Uses PBKDF2 + AES-256-GCM for private key encryption (same as shared/crypto.ts).
 * Uses scrypt for password hashing (verification only, not key derivation).
 */

import Database from 'better-sqlite3';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { generateIdentity } from '@pando/shared';
import { toString as uint8ArrayToString } from 'uint8arrays';
import type { AuthResult, UserAccountPublic } from '@pando/shared';
import type { PandoLedger } from '@pando/ledger';

/** Promisified scrypt with options support. */
function scryptAsync(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/** Wrap a promise with a timeout. Rejects with a descriptive error if the promise doesn't settle in time. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Default session TTL: 7 days. */
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum password length. */
const MIN_PASSWORD_LENGTH = 8;

/** Maximum username length. */
const MAX_USERNAME_LENGTH = 32;

/** Minimum username length. */
const MIN_USERNAME_LENGTH = 3;

/** Username regex: alphanumeric, hyphens, underscores. */
const USERNAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/** scrypt parameters (N=16384, r=8, p=1, keylen=64). */
const SCRYPT_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
};

// ── Local Schema (auth-local.db — NOT synced, node-local only) ──────────────

const LOCAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS key_store (
    peer_id TEXT PRIMARY KEY,
    private_key_enc TEXT,
    enc_type TEXT NOT NULL DEFAULT 'node',
    encrypted_backup TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    ip_address TEXT,
    user_agent TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_peer ON auth_sessions(peer_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON auth_sessions(expires_at);
`;

// ── Encryption helpers (PBKDF2 + AES-256-GCM, compatible with shared/crypto.ts) ──

interface EncryptedKey {
  salt: string;   // hex, 16-byte PBKDF2 salt
  iv: string;     // hex, 12-byte AES-GCM IV
  data: string;   // hex, ciphertext + auth tag
}

/**
 * Encrypt a base64-encoded private key with a passphrase using PBKDF2 + AES-256-GCM.
 * Same approach as encryptIdentity() in shared/crypto.ts.
 */
function encryptPrivateKey(privateKeyBase64: string, passphrase: string): EncryptedKey {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256');

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(privateKeyBase64, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    data: Buffer.concat([encrypted, authTag]).toString('hex'),
  };
}

/**
 * Decrypt a private key encrypted with PBKDF2 + AES-256-GCM.
 * Returns the base64-encoded private key, or throws on wrong passphrase.
 */
function decryptPrivateKey(enc: EncryptedKey, passphrase: string): string {
  const salt = Buffer.from(enc.salt, 'hex');
  const iv = Buffer.from(enc.iv, 'hex');
  const encryptedBuffer = Buffer.from(enc.data, 'hex');

  const authTag = encryptedBuffer.slice(-16);
  const ciphertext = encryptedBuffer.slice(0, -16);

  const key = pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
  } catch {
    throw new Error('Decryption failed — wrong passphrase');
  }
}

// ── UserAccountStore ─────────────────────────────────────────────────────────

export class UserAccountStore {
  private localDb: Database.Database;
  private ledger: PandoLedger;
  private sessionTtlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private dataDir: string;
  private nodeSecret: string | null = null;
  private broadcastClaimFn: ((claim: { peerId: string; username: string | null; displayName: string | null; passwordHash: string; claimedAt: number; balance?: number }) => Promise<void>) | null = null;

  constructor(ledger: PandoLedger, dataDir?: string, sessionTtlMs?: number) {
    this.ledger = ledger;
    this.dataDir = dataDir || join(homedir(), '.pando');

    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    // Local-only database for private keys and sessions (NOT synced)
    const dbPath = join(this.dataDir, 'auth-local.db');
    this.localDb = new Database(dbPath);
    this.localDb.pragma('journal_mode = WAL');
    this.localDb.pragma('foreign_keys = ON');
    this.localDb.exec(LOCAL_SCHEMA);

    this.sessionTtlMs = sessionTtlMs || DEFAULT_SESSION_TTL_MS;
  }

  // ── Broadcast Wiring ──────────────────────────────────────────────────

  /**
   * Set the broadcast function for P2P claim sync.
   * Called by PandoNode after sync is initialized.
   */
  setBroadcastClaim(fn: (claim: { peerId: string; username: string | null; displayName: string | null; passwordHash: string; claimedAt: number; balance?: number }) => Promise<void>): void {
    this.broadcastClaimFn = fn;
  }

  // ── Encrypted Key Backup (Phase 41.5) ──────────────────────────────────

  /**
   * Store an encrypted private key backup for a user.
   * The key is encrypted client-side with the user's password (PBKDF2 + AES-256-GCM).
   * The node stores it opaquely -- it cannot decrypt it.
   */
  async storeEncryptedKey(userId: string, encryptedKey: string): Promise<void> {
    this.localDb.prepare(
      'UPDATE key_store SET encrypted_backup = ? WHERE peer_id = ?'
    ).run(encryptedKey, userId);
  }

  /**
   * Retrieve the encrypted private key backup for a user.
   * Returns null if no backup exists.
   */
  async getEncryptedKey(userId: string): Promise<string | null> {
    const row = this.localDb.prepare(
      'SELECT encrypted_backup FROM key_store WHERE peer_id = ?'
    ).get(userId) as any;
    return row?.encrypted_backup || null;
  }

  // ── Node Secret Management ─────────────────────────────────────────────

  /**
   * Get or create the node-level secret used to encrypt guest private keys.
   * Stored at ~/.pando/guest-secret (32-byte random hex).
   */
  private getNodeSecret(): string {
    if (this.nodeSecret) return this.nodeSecret;

    const secretPath = join(this.dataDir, 'guest-secret');
    if (existsSync(secretPath)) {
      this.nodeSecret = readFileSync(secretPath, 'utf-8').trim();
    } else {
      this.nodeSecret = randomBytes(32).toString('hex');
      writeFileSync(secretPath, this.nodeSecret, 'utf-8');
      console.log('[user-accounts] Generated new guest-secret');
    }
    return this.nodeSecret;
  }

  // ── Guest Creation ─────────────────────────────────────────────────────

  /**
   * Create a guest identity with an Ed25519 keypair.
   * Private key is encrypted with the node-level secret and stored locally.
   * Account is registered in the P2P-synced ledger.
   * Returns auth token + peerId + publicKey.
   */
  async createGuest(opts?: { ipAddress?: string; userAgent?: string }): Promise<AuthResult> {
    try {
      // Generate Ed25519 keypair
      const identity = await generateIdentity();
      const publicKeyBase64 = uint8ArrayToString(identity.publicKey, 'base64');
      const privateKeyBase64 = uint8ArrayToString(identity.privateKey, 'base64');

      // Encrypt private key with node secret
      const nodeSecret = this.getNodeSecret();
      const encryptedKey = encryptPrivateKey(privateKeyBase64, nodeSecret);
      const privateKeyEncJson = JSON.stringify(encryptedKey);

      const now = Date.now();
      const token = this.generateToken();
      const expiresAt = now + this.sessionTtlMs;

      // Register in P2P ledger (synced across network)
      this.ledger.registerNode(identity.peerId, publicKeyBase64);

      // Store encrypted private key locally (NOT synced)
      this.localDb.prepare(`
        INSERT OR REPLACE INTO key_store (peer_id, private_key_enc, enc_type, created_at)
        VALUES (?, ?, 'node', ?)
      `).run(identity.peerId, privateKeyEncJson, now);

      // Create local session
      this.localDb.prepare(`
        INSERT INTO auth_sessions (token, peer_id, created_at, expires_at, last_active_at, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(token, identity.peerId, now, expiresAt, now, opts?.ipAddress || null, opts?.userAgent || null);

      console.log(`[user-accounts] Created guest identity: ${identity.peerId.slice(0, 16)}...`);

      return {
        success: true,
        token,
        peerId: identity.peerId,
        publicKey: publicKeyBase64,
        isClaimed: false,
        isNewAccount: true,
      };
    } catch (err: any) {
      console.error('[user-accounts] Guest creation failed:', err.message);
      return { success: false, error: `Guest creation failed: ${err.message}` };
    }
  }

  /**
   * Phase 41: Create a guest identity from a browser-generated keypair.
   * The private key NEVER leaves the browser. Node only stores the public key.
   * enc_type = 'browser' means the node does not have the private key at all.
   */
  async createGuestFromBrowserKey(opts: {
    peerId: string;
    publicKey: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<AuthResult> {
    try {
      const now = Date.now();
      const token = this.generateToken();
      const expiresAt = now + this.sessionTtlMs;

      // Check if already registered in ledger
      const existing = this.ledger.accounts.exists(opts.peerId);
      if (existing) {
        // Already registered — just create a new session (NOT a new account)
        this.localDb.prepare(`
          INSERT INTO auth_sessions (token, peer_id, created_at, expires_at, last_active_at, ip_address, user_agent)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(token, opts.peerId, now, expiresAt, now, opts.ipAddress || null, opts.userAgent || null);
        return { success: true, token, peerId: opts.peerId, publicKey: opts.publicKey, isClaimed: false, isNewAccount: false };
      }

      // Register in P2P ledger
      this.ledger.registerNode(opts.peerId, opts.publicKey);

      // Store in local key_store with enc_type='browser' and empty private_key_enc
      this.localDb.prepare(`
        INSERT OR REPLACE INTO key_store (peer_id, private_key_enc, enc_type, created_at)
        VALUES (?, '', 'browser', ?)
      `).run(opts.peerId, now);

      // Create local session
      this.localDb.prepare(`
        INSERT INTO auth_sessions (token, peer_id, created_at, expires_at, last_active_at, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(token, opts.peerId, now, expiresAt, now, opts.ipAddress || null, opts.userAgent || null);

      console.log(`[user-accounts] Created browser-key guest: ${opts.peerId.slice(0, 16)}...`);
      return { success: true, token, peerId: opts.peerId, publicKey: opts.publicKey, isClaimed: false, isNewAccount: true };
    } catch (err: any) {
      console.error('[user-accounts] Browser-key guest creation failed:', err.message);
      return { success: false, error: `Guest creation failed: ${err.message}` };
    }
  }

  // ── Claim (upgrade guest to claimed) ───────────────────────────────────

  /**
   * Claim a guest account by setting a password (and optionally a username).
   * Re-encrypts the private key with the user's password.
   * Writes auth data to ledger (P2P-synced) and broadcasts claim.
   */
  async claim(
    token: string,
    password: string,
    username?: string
  ): Promise<AuthResult> {
    const peerId = await this.validateSession(token);
    if (!peerId) {
      return { success: false, error: 'Invalid or expired session token' };
    }

    // Check if already claimed in ledger
    const authFields = this.ledger.accounts.getAuthFields(peerId);
    if (authFields && authFields.isClaimed) {
      return { success: false, error: 'Account is already claimed' };
    }

    // Validate password
    const passwordError = this.validatePassword(password);
    if (passwordError) {
      return { success: false, error: passwordError };
    }

    // Validate username if provided
    const usernameVal = (username !== undefined && username !== null && username !== '') ? username : null;
    if (usernameVal) {
      const usernameError = this.validateUsername(usernameVal);
      if (usernameError) {
        return { success: false, error: usernameError };
      }

      // Check username uniqueness in ledger
      if (!this.ledger.accounts.isUsernameAvailable(usernameVal)) {
        return { success: false, error: 'Username already taken' };
      }
    }

    try {
      // Hash password with scrypt
      const passwordHash = await this.hashPassword(password);
      const now = Date.now();

      // Get local key info to handle re-encryption
      const keyRow = this.localDb.prepare('SELECT * FROM key_store WHERE peer_id = ?').get(peerId) as any;

      if (keyRow && keyRow.enc_type === 'node' && keyRow.private_key_enc) {
        // Legacy node-key guest: decrypt with node secret, re-encrypt with user password.
        const nodeSecret = this.getNodeSecret();
        const encryptedKey: EncryptedKey = JSON.parse(keyRow.private_key_enc);
        const privateKeyBase64 = decryptPrivateKey(encryptedKey, nodeSecret);
        const userEncryptedKey = encryptPrivateKey(privateKeyBase64, password);
        const newPrivateKeyEncJson = JSON.stringify(userEncryptedKey);

        this.localDb.prepare(
          'UPDATE key_store SET private_key_enc = ?, enc_type = ? WHERE peer_id = ?'
        ).run(newPrivateKeyEncJson, 'user', peerId);
      }
      // For browser-key guests, no re-encryption needed — browser handles its own key backup

      // Write claim to ledger (P2P-synced)
      this.ledger.accounts.claimAccount(peerId, usernameVal, null, passwordHash);

      // Get public key for response
      const account = this.ledger.accounts.get(peerId);
      const publicKey = account?.publicKey || '';

      console.log(`[user-accounts] Account claimed: ${peerId.slice(0, 16)}... ${usernameVal ? `(${usernameVal})` : ''}`);

      return {
        success: true,
        token,
        peerId,
        publicKey,
        username: usernameVal || undefined,
        isClaimed: true,
      };
    } catch (err: any) {
      console.error('[user-accounts] Claim failed:', err.message);
      return { success: false, error: `Claim failed: ${err.message}` };
    }
  }

  /**
   * Phase 86: Claim by peerId directly (JWT already verified by API server).
   * Same logic as claim() but skips session token validation.
   */
  async claimByPeerId(
    peerId: string,
    password: string,
    username?: string
  ): Promise<AuthResult> {
    // Check if already claimed in ledger
    const authFields = this.ledger.accounts.getAuthFields(peerId);
    if (authFields && authFields.isClaimed) {
      return { success: false, error: 'Account is already claimed' };
    }

    const passwordError = this.validatePassword(password);
    if (passwordError) {
      return { success: false, error: passwordError };
    }

    const usernameVal = (username !== undefined && username !== null && username !== '') ? username : null;
    if (usernameVal) {
      const usernameError = this.validateUsername(usernameVal);
      if (usernameError) {
        return { success: false, error: usernameError };
      }
      if (!this.ledger.accounts.isUsernameAvailable(usernameVal)) {
        return { success: false, error: 'Username already taken' };
      }
    }

    try {
      const passwordHash = await this.hashPassword(password);

      const keyRow = this.localDb.prepare('SELECT * FROM key_store WHERE peer_id = ?').get(peerId) as any;
      if (keyRow && keyRow.enc_type === 'node' && keyRow.private_key_enc) {
        const nodeSecret = this.getNodeSecret();
        const encryptedKey: EncryptedKey = JSON.parse(keyRow.private_key_enc);
        const privateKeyBase64 = decryptPrivateKey(encryptedKey, nodeSecret);
        const userEncryptedKey = encryptPrivateKey(privateKeyBase64, password);
        this.localDb.prepare(
          'UPDATE key_store SET private_key_enc = ?, enc_type = ? WHERE peer_id = ?'
        ).run(JSON.stringify(userEncryptedKey), 'user', peerId);
      }

      this.ledger.accounts.claimAccount(peerId, usernameVal, null, passwordHash);
      const account = this.ledger.accounts.get(peerId);
      const publicKey = account?.publicKey || '';

      console.log(`[user-accounts] Account claimed: ${peerId.slice(0, 16)}... ${usernameVal ? `(${usernameVal})` : ''}`);

      return {
        success: true,
        peerId,
        publicKey,
        username: usernameVal || undefined,
        isClaimed: true,
      };
    } catch (err: any) {
      console.error('[user-accounts] Claim failed:', err.message);
      return { success: false, error: `Claim failed: ${err.message}` };
    }
  }

  // ── Login ──────────────────────────────────────────────────────────────

  /**
   * Login with username or peerId + password.
   * Only works for claimed accounts. Reads auth data from P2P-synced ledger.
   */
  async login(
    identifier: string,
    password: string,
    opts?: { ipAddress?: string; userAgent?: string }
  ): Promise<AuthResult> {
    if (!identifier || !password) {
      return { success: false, error: 'Identifier and password are required' };
    }

    const loginStart = Date.now();

    try {
      // Try by username first (case-insensitive), then by peerId
      let peerId: string | null = null;
      let passwordHash: string | null = null;
      let username: string | null = null;
      let publicKey: string = '';

      const byUsername = this.ledger.accounts.getByUsername(identifier);
      if (byUsername && byUsername.isClaimed) {
        peerId = byUsername.peerId;
        passwordHash = byUsername.passwordHash;
        username = byUsername.username;
        publicKey = byUsername.publicKey;
      } else {
        // Try as peerId
        const authFields = this.ledger.accounts.getAuthFields(identifier);
        if (authFields && authFields.isClaimed) {
          peerId = identifier;
          passwordHash = authFields.passwordHash;
          username = authFields.username;
          const account = this.ledger.accounts.get(identifier);
          publicKey = account?.publicKey || '';
        }
      }

      if (!peerId || !passwordHash) {
        return { success: false, error: 'Invalid credentials' };
      }

      // Verify password
      const valid = await withTimeout(
        this.verifyPassword(password, passwordHash),
        10000,
        'Password verification timed out'
      );
      if (!valid) {
        return { success: false, error: 'Invalid credentials' };
      }

      // Create local session
      const now = Date.now();
      const token = this.generateToken();
      const expiresAt = now + this.sessionTtlMs;

      this.localDb.prepare(`
        INSERT INTO auth_sessions (token, peer_id, created_at, expires_at, last_active_at, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(token, peerId, now, expiresAt, now, opts?.ipAddress || null, opts?.userAgent || null);

      console.log(`[user-accounts] Login: ${username || peerId.slice(0, 16) + '...'} (${Date.now() - loginStart}ms)`);

      return {
        success: true,
        token,
        peerId,
        publicKey,
        username: username || undefined,
        isClaimed: true,
      };
    } catch (err: any) {
      console.error(`[user-accounts] Login failed (${Date.now() - loginStart}ms):`, err.message);
      return { success: false, error: `Login failed: ${err.message}` };
    }
  }

  // ── Profile ────────────────────────────────────────────────────────────

  /**
   * Get public profile for a session token.
   * Does NOT return private key or password hash.
   * Reads from P2P-synced ledger.
   */
  async getProfile(token: string): Promise<UserAccountPublic | null> {
    const peerId = await this.validateSession(token);
    if (!peerId) return null;

    return this.getIdentityByPeerId(peerId);
  }

  /**
   * Get public identity info by peerId directly (no session required).
   * Used for lookups like "does this user exist?".
   * Reads from P2P-synced ledger.
   */
  async getIdentityByPeerId(peerId: string): Promise<UserAccountPublic | null> {
    const account = this.ledger.accounts.get(peerId);
    if (!account) return null;

    const authFields = this.ledger.accounts.getAuthFields(peerId);

    return {
      peerId: account.peerId,
      publicKey: account.publicKey,
      username: authFields?.username || undefined,
      displayName: authFields?.displayName || undefined,
      isClaimed: authFields?.isClaimed || false,
      createdAt: account.createdAt,
    };
  }

  // ── Logout ─────────────────────────────────────────────────────────────

  /**
   * Invalidate a session token (logout).
   */
  async logout(token: string): Promise<boolean> {
    const result = this.localDb.prepare(
      'DELETE FROM auth_sessions WHERE token = ?'
    ).run(token);
    return result.changes > 0;
  }

  // ── Session Validation ─────────────────────────────────────────────────

  /**
   * Validate a session token. Returns the peerId if valid, null if invalid/expired.
   * Also updates last_active_at on valid sessions.
   */
  async validateSession(token: string): Promise<string | null> {
    if (!token) return null;

    const session = this.localDb.prepare(
      'SELECT * FROM auth_sessions WHERE token = ?'
    ).get(token) as any;

    if (!session) return null;

    if (session.expires_at < Date.now()) {
      this.localDb.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
      return null;
    }

    this.localDb.prepare(
      'UPDATE auth_sessions SET last_active_at = ? WHERE token = ?'
    ).run(Date.now(), token);

    return session.peer_id;
  }

  /**
   * Refresh a session token — extend its TTL.
   * Returns the new expiry time, or null if token is invalid.
   */
  async refreshSession(token: string): Promise<{ expiresAt: number } | null> {
    const peerId = await this.validateSession(token);
    if (!peerId) return null;

    const newExpiresAt = Date.now() + this.sessionTtlMs;

    this.localDb.prepare(
      'UPDATE auth_sessions SET expires_at = ?, last_active_at = ? WHERE token = ?'
    ).run(newExpiresAt, Date.now(), token);

    return { expiresAt: newExpiresAt };
  }

  // ── Session Cleanup ────────────────────────────────────────────────────

  /**
   * Remove all expired sessions from the local database.
   */
  cleanupExpiredSessions(): number {
    const result = this.localDb.prepare(
      'DELETE FROM auth_sessions WHERE expires_at < ?'
    ).run(Date.now());

    if (result.changes > 0) {
      console.log(`[user-accounts] Cleaned up ${result.changes} expired sessions`);
    }
    return result.changes;
  }

  /**
   * Phase 35: Reclaim Lux from expired unclaimed guest accounts.
   * Queries the ledger for unclaimed accounts older than 30 days.
   * Returns the number of guests reclaimed and total Lux recovered.
   */
  reclaimExpiredGuests(ledger: { transfer: (from: string, to: string, amount: number) => any; accounts: { getBalance: (id: string) => number; exists: (id: string) => boolean } }): { reclaimed: number; luxRecovered: number } {
    const GUEST_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    const NETWORK_ACCOUNT = 'NETWORK';
    const cutoff = Date.now() - GUEST_EXPIRY_MS;

    // Find unclaimed guests created more than 30 days ago via ledger
    // We query the ledger database directly for unclaimed accounts
    const ledgerDb = this.ledger.getDatabase();
    const expiredGuests = ledgerDb.prepare(
      'SELECT peer_id FROM accounts WHERE is_claimed = 0 AND created_at < ?'
    ).all(cutoff) as Array<{ peer_id: string }>;

    if (expiredGuests.length === 0) return { reclaimed: 0, luxRecovered: 0 };

    let reclaimed = 0;
    let luxRecovered = 0;

    for (const guest of expiredGuests) {
      try {
        // Check Lux balance
        if (!ledger.accounts.exists(guest.peer_id)) continue;
        const balance = ledger.accounts.getBalance(guest.peer_id);

        // Transfer remaining Lux back to NETWORK
        if (balance > 0) {
          ledger.transfer(guest.peer_id, NETWORK_ACCOUNT, balance);
          luxRecovered += balance;
        }

        // Clean up local sessions for this guest
        this.localDb.prepare('DELETE FROM auth_sessions WHERE peer_id = ?').run(guest.peer_id);
        // Clean up local key_store for this guest
        this.localDb.prepare('DELETE FROM key_store WHERE peer_id = ?').run(guest.peer_id);

        reclaimed++;
      } catch (err: any) {
        console.error(`[user-accounts] Failed to reclaim guest ${guest.peer_id.slice(0, 16)}: ${err.message}`);
      }
    }

    if (reclaimed > 0) {
      console.log(`[user-accounts] Reclaimed ${reclaimed} expired guest(s), recovered ${luxRecovered.toFixed(2)} Lux -> NETWORK`);
    }
    return { reclaimed, luxRecovered };
  }

  /**
   * Start periodic session cleanup (every 30 minutes).
   */
  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 30 * 60 * 1000);
  }

  /**
   * Stop periodic cleanup.
   */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────

  /**
   * Get summary statistics about accounts and sessions.
   * Account stats from ledger, session stats from local DB.
   */
  getStats(): {
    totalAccounts: number;
    claimedAccounts: number;
    guestAccounts: number;
    activeSessions: number;
  } {
    const now = Date.now();
    const ledgerDb = this.ledger.getDatabase();

    const totalAccounts = (ledgerDb.prepare(
      'SELECT COUNT(*) as cnt FROM accounts'
    ).get() as any)?.cnt || 0;

    const claimedAccounts = (ledgerDb.prepare(
      'SELECT COUNT(*) as cnt FROM accounts WHERE is_claimed = 1'
    ).get() as any)?.cnt || 0;

    const guestAccounts = (ledgerDb.prepare(
      'SELECT COUNT(*) as cnt FROM accounts WHERE is_claimed = 0'
    ).get() as any)?.cnt || 0;

    const activeSessions = (this.localDb.prepare(
      'SELECT COUNT(*) as cnt FROM auth_sessions WHERE expires_at > ?'
    ).get(now) as any)?.cnt || 0;

    return { totalAccounts, claimedAccounts, guestAccounts, activeSessions };
  }

  // ── Close ──────────────────────────────────────────────────────────────

  /**
   * Close the database and stop cleanup.
   */
  close(): void {
    this.stopCleanup();
    this.localDb.close();
  }

  /**
   * Expose local database for external queries if needed.
   */
  getDatabase(): Database.Database {
    return this.localDb;
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  private validateUsername(username: string): string | null {
    if (!username) return 'Username is required';
    if (username.length < MIN_USERNAME_LENGTH) return `Username must be at least ${MIN_USERNAME_LENGTH} characters`;
    if (username.length > MAX_USERNAME_LENGTH) return `Username must be at most ${MAX_USERNAME_LENGTH} characters`;
    if (!USERNAME_REGEX.test(username)) return 'Username can only contain letters, numbers, hyphens, and underscores';
    const reserved = ['admin', 'root', 'system', 'network', 'node', 'api', 'auth'];
    if (reserved.includes(username.toLowerCase())) return 'This username is reserved';
    return null;
  }

  private validatePassword(password: string): string | null {
    if (!password) return 'Password is required';
    if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    if (password.length > 256) return 'Password must be at most 256 characters';
    return null;
  }

  /**
   * Hash a password using scrypt with a random 32-byte salt.
   * Format: "salt:hash" where both are hex-encoded.
   */
  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(32);
    const derivedKey = await scryptAsync(password, salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
    }) as Buffer;
    return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
  }

  /**
   * Verify a password against a stored hash.
   * Uses timing-safe comparison to prevent timing attacks.
   */
  private async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    const [saltHex, hashHex] = storedHash.split(':');
    if (!saltHex || !hashHex) return false;

    const salt = Buffer.from(saltHex, 'hex');
    const storedKey = Buffer.from(hashHex, 'hex');

    const derivedKey = await scryptAsync(password, salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
    }) as Buffer;

    // Guard against mismatched buffer lengths (would throw RangeError in timingSafeEqual)
    if (derivedKey.length !== storedKey.length) return false;

    return timingSafeEqual(derivedKey, storedKey);
  }

  private generateToken(): string {
    return randomBytes(64).toString('hex');
  }
}
