import type Database from 'better-sqlite3';
import {
  type ApiContribution,
  type Transaction,
  ApiProvider,
  WorkType,
  EMISSION_REWARDS,
  EARLY_MULTIPLIERS,
} from '@pando/shared';
import { AccountStore } from './accounts.js';
import { TransactionStore } from './transactions.js';

export class ContributionStore {
  private db: Database.Database;
  private accounts: AccountStore;
  private transactions: TransactionStore;

  constructor(db: Database.Database, accounts: AccountStore, transactions: TransactionStore) {
    this.db = db;
    this.accounts = accounts;
    this.transactions = transactions;
  }

  /**
   * Register an API key contribution.
   * The key itself is NEVER stored — only metadata about the contribution.
   */
  register(peerId: string, provider: ApiProvider, monthlyCap: number): ApiContribution {
    if (!this.accounts.exists(peerId)) {
      throw new Error(`Account not found: ${peerId}`);
    }

    const now = Date.now();
    const result = this.db.prepare(
      'INSERT INTO api_contributions (peer_id, provider, monthly_cap, registered_at) VALUES (?, ?, ?, ?)'
    ).run(peerId, provider, monthlyCap, now);

    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): ApiContribution | null {
    const row = this.db.prepare(
      'SELECT * FROM api_contributions WHERE id = ?'
    ).get(id) as any;

    if (!row) return null;
    return this.rowToContribution(row);
  }

  getByPeer(peerId: string): ApiContribution[] {
    const rows = this.db.prepare(
      'SELECT * FROM api_contributions WHERE peer_id = ? AND active = 1'
    ).all(peerId) as any[];

    return rows.map(row => this.rowToContribution(row));
  }

  /**
   * Record that a contributed API key was used for a task.
   * Emits Lux tokens as reward.
   */
  recordUsage(contributionId: number, costUsd: number, workProof: string): number {
    const contribution = this.get(contributionId);
    if (!contribution) throw new Error(`Contribution not found: ${contributionId}`);
    if (!contribution.active) throw new Error('Contribution is inactive');

    // Check monthly cap
    if (contribution.usedUsd + costUsd > contribution.monthlyCap) {
      throw new Error(`Monthly cap exceeded: used $${contribution.usedUsd}, cap $${contribution.monthlyCap}`);
    }

    // Calculate reward with early multiplier
    const baseReward = EMISSION_REWARDS[WorkType.API_CONTRIBUTED];
    const multiplier = this.getMultiplier();
    const reward = baseReward * multiplier;

    const now = Date.now();

    const doRecord = this.db.transaction(() => {
      // Update contribution stats
      this.db.prepare(
        'UPDATE api_contributions SET used_usd = used_usd + ?, tasks_completed = tasks_completed + 1, lux_earned = lux_earned + ?, last_used_at = ? WHERE id = ?'
      ).run(costUsd, reward, now, contributionId);

      // Emit tokens
      this.transactions.emit(
        contribution.peerId,
        reward,
        WorkType.API_CONTRIBUTED,
        workProof
      );
    });

    doRecord();
    return reward;
  }

  /**
   * Reward any type of work with Lux tokens.
   */
  rewardWork(peerId: string, workType: WorkType, workProof: string): Transaction {
    if (!this.accounts.exists(peerId)) {
      throw new Error(`Account not found: ${peerId}`);
    }

    const baseReward = EMISSION_REWARDS[workType];
    const multiplier = this.getMultiplier();
    const reward = baseReward * multiplier;

    return this.transactions.emit(peerId, reward, workType, workProof);
  }

  deactivate(id: number): void {
    this.db.prepare(
      'UPDATE api_contributions SET active = 0 WHERE id = ?'
    ).run(id);
  }

  getActiveContributorCount(): number {
    const row = this.db.prepare(
      'SELECT COUNT(DISTINCT peer_id) as count FROM api_contributions WHERE active = 1'
    ).get() as any;
    return row.count;
  }

  getTotalApiSpend(): number {
    const row = this.db.prepare(
      'SELECT SUM(used_usd) as total FROM api_contributions'
    ).get() as any;
    return row.total || 0;
  }

  private getMultiplier(): number {
    const accountCount = this.accounts.getAccountCount();
    if (accountCount <= 100) return EARLY_MULTIPLIERS.FIRST_100;
    if (accountCount <= 1000) return EARLY_MULTIPLIERS.FIRST_1000;
    if (accountCount <= 10000) return EARLY_MULTIPLIERS.FIRST_10000;
    return EARLY_MULTIPLIERS.AFTER;
  }

  private rowToContribution(row: any): ApiContribution {
    return {
      id: row.id,
      peerId: row.peer_id,
      provider: row.provider as ApiProvider,
      monthlyCap: row.monthly_cap,
      usedUsd: row.used_usd,
      tasksCompleted: row.tasks_completed,
      luxEarned: row.lux_earned,
      registeredAt: row.registered_at,
      lastUsedAt: row.last_used_at,
      active: !!row.active,
    };
  }
}
