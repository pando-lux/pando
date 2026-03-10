import type Database from 'better-sqlite3';
import type { Account } from '@pando/shared';
import { roundLux } from '@pando/shared';
import { peerIdFromString } from '@libp2p/peer-id';

export class AccountStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(peerId: string, publicKey: string): Account {
    const now = Date.now();
    this.db.prepare(
      'INSERT OR IGNORE INTO accounts (peer_id, public_key, balance, created_at, updated_at) VALUES (?, ?, 0, ?, ?)'
    ).run(peerId, publicKey, now, now);

    // Update account count
    this.db.prepare(
      "UPDATE network_stats SET value = (SELECT COUNT(*) FROM accounts), updated_at = ? WHERE key = 'total_accounts'"
    ).run(now);

    return this.get(peerId)!;
  }

  get(peerId: string): Account | null {
    const row = this.db.prepare(
      'SELECT peer_id, public_key, balance, created_at, updated_at FROM accounts WHERE peer_id = ?'
    ).get(peerId) as any;

    if (!row) return null;

    return {
      peerId: row.peer_id,
      publicKey: row.public_key,
      balance: row.balance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getBalance(peerId: string): number {
    const row = this.db.prepare(
      'SELECT balance FROM accounts WHERE peer_id = ?'
    ).get(peerId) as any;
    return row ? row.balance : 0;
  }

  exists(peerId: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM accounts WHERE peer_id = ?'
    ).get(peerId);
    return !!row;
  }

  addBalance(peerId: string, amount: number): void {
    const current = this.getBalance(peerId);
    const newBalance = roundLux(current + amount);
    this.db.prepare(
      'UPDATE accounts SET balance = ?, updated_at = ? WHERE peer_id = ?'
    ).run(newBalance, Date.now(), peerId);
  }

  subtractBalance(peerId: string, amount: number): boolean {
    const current = this.getBalance(peerId);
    if (current < amount) return false;

    const newBalance = roundLux(current - amount);
    this.db.prepare(
      'UPDATE accounts SET balance = ?, updated_at = ? WHERE peer_id = ?'
    ).run(newBalance, Date.now(), peerId);
    return true;
  }

  /**
   * Force-subtract balance without checking sufficiency.
   * Used for applying pre-validated remote transactions.
   * If the balance would go negative (out-of-order sync), clamp to 0
   * and flag the account as in deficit via a warning log.
   */
  forceSubtractBalance(peerId: string, amount: number): void {
    const current = this.getBalance(peerId);
    let newBalance = roundLux(current - amount);
    if (newBalance < 0) {
      console.warn(`[accounts] Balance deficit: ${peerId.slice(0, 16)} would go to ${newBalance} Lux — clamping to 0 (sync may reconcile later)`);
      newBalance = 0;
    }
    this.db.prepare(
      'UPDATE accounts SET balance = ?, updated_at = ? WHERE peer_id = ?'
    ).run(newBalance, Date.now(), peerId);
  }

  getAccountCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM accounts').get() as any;
    return row.count;
  }

  getTopAccounts(limit: number = 10): Account[] {
    const rows = this.db.prepare(
      'SELECT peer_id, public_key, balance, created_at, updated_at FROM accounts ORDER BY balance DESC LIMIT ?'
    ).all(limit) as any[];

    return rows.map(row => ({
      peerId: row.peer_id,
      publicKey: row.public_key,
      balance: row.balance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  // ── Phase 56: P2P User Account Auth Methods ────────────────────────────

  /** Claim an account — set username, password hash, mark as claimed. */
  claimAccount(peerId: string, username: string | null, displayName: string | null, passwordHash: string): void {
    const now = Date.now();
    const result = this.db.prepare(
      'UPDATE accounts SET username = ?, display_name = ?, password_hash = ?, is_claimed = 1, updated_at = ? WHERE peer_id = ?'
    ).run(username, displayName, passwordHash, now, peerId);
    if (result.changes === 0) {
      throw new Error('Account not found — cannot claim nonexistent account');
    }
  }

  /** Apply a remote claim from P2P sync. First-come-first-served by timestamp for username conflicts.
   *  `balance` (optional, backward-compatible): the account's balance at claim time on the originating node.
   *  If `adjustBalance` is true AND the local account's balance is lower than `balance`
   *  (e.g. the emission tx was missing from a catch-up sync batch), adjusts the balance
   *  up to match and returns the deficit as `supplyDelta` so the caller can update totalSupply.
   *  `adjustBalance` should only be true during catch-up sync (where transactions are applied first),
   *  NOT during real-time GossipSub claims (where the emission tx arrives separately).
   */
  applyRemoteClaim(peerId: string, username: string | null, displayName: string | null, passwordHash: string, claimedAt: number, balance?: number, adjustBalance: boolean = false): { applied: boolean; supplyDelta: number } {
    if (username) {
      const existing = this.db.prepare(
        'SELECT peer_id, updated_at FROM accounts WHERE username = ? COLLATE NOCASE AND peer_id != ?'
      ).get(username, peerId) as any;
      if (existing) {
        if (existing.updated_at <= claimedAt) {
          // Existing claim is older — it wins. Reject remote username.
          return { applied: false, supplyDelta: 0 };
        }
        // Remote claim is older — it wins. Clear newer claim's username.
        this.db.prepare('UPDATE accounts SET username = NULL, is_claimed = 0, updated_at = ? WHERE peer_id = ?')
          .run(Date.now(), existing.peer_id);
      }
    }

    // Create account if it doesn't exist
    if (!this.exists(peerId)) {
      let extractedKey = 'unknown';
      try {
        const peerIdObj = peerIdFromString(peerId);
        if (peerIdObj.publicKey?.raw) {
          extractedKey = Buffer.from(peerIdObj.publicKey.raw).toString('base64');
        }
      } catch {
        // Extraction failed — fall back to 'unknown' so P2P sync isn't broken
      }
      this.create(peerId, extractedKey);
    }

    this.db.prepare(
      'UPDATE accounts SET username = ?, display_name = ?, password_hash = ?, is_claimed = 1, updated_at = ? WHERE peer_id = ?'
    ).run(username, displayName, passwordHash, claimedAt, peerId);

    // #40: Do NOT accept balance from remote claims. Balance must only change via
    // validated transactions (emissions, transfers). Accepting balance from claims
    // allows malicious peers to broadcast fake balances.
    // The `balance` and `adjustBalance` params are kept for API compatibility but ignored.
    return { applied: true, supplyDelta: 0 };
  }

  /** Look up account by username (case-insensitive). Returns full account + auth fields. */
  getByUsername(username: string): (Account & { username: string; displayName: string | null; passwordHash: string | null; isClaimed: boolean }) | null {
    const row = this.db.prepare(
      'SELECT peer_id, public_key, balance, created_at, updated_at, username, display_name, password_hash, is_claimed FROM accounts WHERE username = ? COLLATE NOCASE'
    ).get(username) as any;
    if (!row) return null;
    return {
      peerId: row.peer_id, publicKey: row.public_key, balance: row.balance,
      createdAt: row.created_at, updatedAt: row.updated_at,
      username: row.username, displayName: row.display_name || null,
      passwordHash: row.password_hash || null, isClaimed: row.is_claimed === 1,
    };
  }

  /** Get auth fields for a peerId. */
  getAuthFields(peerId: string): { username: string | null; displayName: string | null; passwordHash: string | null; isClaimed: boolean } | null {
    const row = this.db.prepare(
      'SELECT username, display_name, password_hash, is_claimed FROM accounts WHERE peer_id = ?'
    ).get(peerId) as any;
    if (!row) return null;
    return {
      username: row.username || null,
      displayName: row.display_name || null,
      passwordHash: row.password_hash || null,
      isClaimed: row.is_claimed === 1,
    };
  }

  /** Check if a username is available. */
  isUsernameAvailable(username: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM accounts WHERE username = ? COLLATE NOCASE').get(username);
    return !row;
  }

  // ── Ban Mechanism ─────────────────────────────────────────────────────

  /** Ban an account. Prevents the user from making authenticated API requests. */
  banAccount(peerId: string): boolean {
    const result = this.db.prepare(
      'UPDATE accounts SET banned = 1, updated_at = ? WHERE peer_id = ?'
    ).run(Date.now(), peerId);
    return result.changes > 0;
  }

  /** Unban an account. */
  unbanAccount(peerId: string): boolean {
    const result = this.db.prepare(
      'UPDATE accounts SET banned = 0, updated_at = ? WHERE peer_id = ?'
    ).run(Date.now(), peerId);
    return result.changes > 0;
  }

  /** Check if an account is banned. Returns false for unknown accounts. */
  isBanned(peerId: string): boolean {
    const row = this.db.prepare(
      'SELECT banned FROM accounts WHERE peer_id = ?'
    ).get(peerId) as any;
    return row?.banned === 1;
  }

  /** Get all claimed accounts for sync responses. Includes balance for totalSupply consistency. */
  getClaimedAccounts(): Array<{ peerId: string; username: string | null; displayName: string | null; passwordHash: string; claimedAt: number; balance: number }> {
    const rows = this.db.prepare(
      'SELECT peer_id, username, display_name, password_hash, updated_at, balance FROM accounts WHERE is_claimed = 1'
    ).all() as any[];
    return rows.map(row => ({
      peerId: row.peer_id, username: row.username || null,
      displayName: row.display_name || null, passwordHash: row.password_hash,
      claimedAt: row.updated_at, balance: row.balance || 0,
    }));
  }
}
