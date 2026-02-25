import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type Transaction,
  TransactionType,
  RELAY_FEE_RATE,
  LUX_HARD_CAP,
  NETWORK_ACCOUNT,
  roundLux,
} from '@pando/shared';
import { AccountStore } from './accounts.js';

export class TransactionStore {
  private db: Database.Database;
  private accounts: AccountStore;

  constructor(db: Database.Database, accounts: AccountStore) {
    this.db = db;
    this.accounts = accounts;
  }

  /**
   * Transfer Lux between two peers.
   * The 0.1% fee goes to the relay node (not burned).
   * If no relay is specified, transfer is fee-free.
   */
  transfer(from: string, to: string, amount: number, relay?: string): Transaction {
    if (amount <= 0) throw new Error('Amount must be positive');
    if (from === to) throw new Error('Cannot transfer to self');
    if (!this.accounts.exists(from)) throw new Error(`Sender not found: ${from}`);
    if (!this.accounts.exists(to)) throw new Error(`Recipient not found: ${to}`);

    const MIN_RELAY_FEE = 0.000001; // Minimum fee floor to prevent zero-fee dust transfers
    const fee = relay ? Math.max(MIN_RELAY_FEE, Math.floor(amount * RELAY_FEE_RATE * 1e8) / 1e8) : 0;
    const totalDebit = amount + fee;

    const senderBalance = this.accounts.getBalance(from);
    if (senderBalance < totalDebit) {
      throw new Error(`Insufficient balance: have ${senderBalance}, need ${totalDebit}`);
    }

    const tx: Transaction = {
      id: this.hashTransaction(from, to, amount, fee, Date.now()),
      from,
      to,
      amount,
      fee,
      relay: relay || undefined,
      type: TransactionType.TRANSFER,
      timestamp: Date.now(),
      signature: '', // Signed by caller after creation (node layer has private keys)
    };

    // Atomic: debit sender, credit recipient, pay relay
    const doTransfer = this.db.transaction(() => {
      this.accounts.subtractBalance(from, totalDebit);
      this.accounts.addBalance(to, amount);

      // Pay fee to relay node
      if (fee > 0 && relay) {
        this.accounts.addBalance(relay, fee);
        this.updateStat('total_relay_fees', fee, true);
      }

      this.recordTransaction(tx);
    });

    doTransfer();
    return tx;
  }

  /**
   * Emit new Lux tokens for work done.
   * Checks hard cap before minting.
   */
  emit(to: string, amount: number, workType: string, workProof: string): Transaction {
    if (amount <= 0) throw new Error('Emission amount must be positive');
    if (!this.accounts.exists(to)) throw new Error(`Recipient not found: ${to}`);

    // Check hard cap
    const totalSupply = this.getTotalSupply();
    if (totalSupply + amount > LUX_HARD_CAP) {
      const remaining = LUX_HARD_CAP - totalSupply;
      if (remaining <= 0) throw new Error('Hard cap reached. No more Lux can be minted.');
      // Mint only what's available
      amount = remaining;
    }

    const tx: Transaction = {
      id: this.hashTransaction(NETWORK_ACCOUNT, to, amount, 0, Date.now()),
      from: NETWORK_ACCOUNT,
      to,
      amount,
      fee: 0,
      type: TransactionType.EMISSION,
      timestamp: Date.now(),
      signature: 'network-emission',
    };

    const doEmit = this.db.transaction(() => {
      this.accounts.addBalance(to, amount);
      this.recordTransaction(tx);
      this.updateStat('total_supply', amount, true);

      // Record emission
      this.db.prepare(
        'INSERT INTO emissions (id, peer_id, amount, work_type, work_proof, timestamp) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(tx.id, to, amount, workType, workProof, tx.timestamp);
    });

    doEmit();
    return tx;
  }

  /**
   * Apply a pre-validated remote transaction.
   * Credits the recipient without checking sender balance.
   * Used for GossipSub sync — the originating node already validated it.
   */
  applyRemoteTransaction(tx: Transaction): void {
    // Skip if already recorded
    if (this.getTransaction(tx.id)) return;

    const doApply = this.db.transaction(() => {
      // For transfers, debit the sender (trust originating node's validation)
      if (tx.type === TransactionType.TRANSFER && tx.from !== NETWORK_ACCOUNT) {
        this.accounts.forceSubtractBalance(tx.from, tx.amount + tx.fee);
      }

      // Credit recipient
      this.accounts.addBalance(tx.to, tx.amount);

      // Pay fee to relay node
      if (tx.fee > 0 && tx.relay && this.accounts.exists(tx.relay)) {
        this.accounts.addBalance(tx.relay, tx.fee);
        this.updateStat('total_relay_fees', tx.fee, true);
      }

      // Record the transaction
      this.recordTransaction(tx);

      // Track the supply change if it's an emission
      if (tx.type === TransactionType.EMISSION) {
        this.updateStat('total_supply', tx.amount, true);
      }
    });

    doApply();
  }

  getTransaction(id: string): Transaction | null {
    const row = this.db.prepare(
      'SELECT id, from_peer, to_peer, amount, fee, relay_peer, type, timestamp, signature FROM transactions WHERE id = ?'
    ).get(id) as any;

    if (!row) return null;

    return {
      id: row.id,
      from: row.from_peer,
      to: row.to_peer,
      amount: row.amount,
      fee: row.fee,
      relay: row.relay_peer || undefined,
      type: row.type as TransactionType,
      timestamp: row.timestamp,
      signature: row.signature,
    };
  }

  getTransactionsForPeer(peerId: string, limit: number = 50): Transaction[] {
    const rows = this.db.prepare(
      'SELECT id, from_peer, to_peer, amount, fee, relay_peer, type, timestamp, signature FROM transactions WHERE from_peer = ? OR to_peer = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(peerId, peerId, limit) as any[];

    return rows.map(row => ({
      id: row.id,
      from: row.from_peer,
      to: row.to_peer,
      amount: row.amount,
      fee: row.fee,
      relay: row.relay_peer || undefined,
      type: row.type as TransactionType,
      timestamp: row.timestamp,
      signature: row.signature,
    }));
  }

  getTotalSupply(): number {
    return this.getStatNumber('total_supply');
  }

  // Legacy — burning removed, this returns historical burns only
  getTotalBurned(): number {
    return this.getStatNumber('total_burned');
  }

  getTotalRelayFees(): number {
    return this.getStatNumber('total_relay_fees');
  }

  getTransactionsSince(timestamp: number, limit: number = 500): Transaction[] {
    const rows = this.db.prepare(
      'SELECT id, from_peer, to_peer, amount, fee, relay_peer, type, timestamp, signature FROM transactions WHERE timestamp > ? ORDER BY timestamp ASC LIMIT ?'
    ).all(timestamp, limit) as any[];

    return rows.map(row => ({
      id: row.id,
      from: row.from_peer,
      to: row.to_peer,
      amount: row.amount,
      fee: row.fee,
      relay: row.relay_peer || undefined,
      type: row.type as TransactionType,
      timestamp: row.timestamp,
      signature: row.signature,
    }));
  }

  getTransactionCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM transactions').get() as any;
    return row.count;
  }

  /**
   * Update the signature on an existing transaction record.
   * Called by the node layer after signing with the sender's private key.
   */
  updateSignature(txId: string, signature: string): void {
    this.db.prepare(
      'UPDATE transactions SET signature = ? WHERE id = ?'
    ).run(signature, txId);
  }

  private recordTransaction(tx: Transaction): void {
    this.db.prepare(
      'INSERT INTO transactions (id, from_peer, to_peer, amount, fee, relay_peer, type, timestamp, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(tx.id, tx.from, tx.to, tx.amount, tx.fee, tx.relay || '', tx.type, tx.timestamp, tx.signature);
  }

  private hashTransaction(from: string, to: string, amount: number, fee: number, timestamp: number): string {
    const data = `${from}:${to}:${amount}:${fee}:${timestamp}:${Math.random()}`;
    return createHash('sha256').update(data).digest('hex');
  }

  private getStatNumber(key: string): number {
    const row = this.db.prepare(
      'SELECT value FROM network_stats WHERE key = ?'
    ).get(key) as any;
    return row ? parseFloat(row.value) : 0;
  }

  private updateStat(key: string, addValue: number, accumulate: boolean): void {
    if (accumulate) {
      const current = this.getStatNumber(key);
      this.db.prepare(
        'UPDATE network_stats SET value = ?, updated_at = ? WHERE key = ?'
      ).run(String(roundLux(current + addValue)), Date.now(), key);
    } else {
      this.db.prepare(
        'UPDATE network_stats SET value = ?, updated_at = ? WHERE key = ?'
      ).run(String(roundLux(addValue)), Date.now(), key);
    }
  }
}
