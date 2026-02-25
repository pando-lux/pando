/**
 * RevenueEngine — Usage metering, revenue collection, and automatic Lux distribution.
 *
 * Phase 31.4: Handles all project revenue flows:
 *   - Recording revenue events (usage fees, subscriptions, tips, one-time payments)
 *   - Revenue summary and history
 *   - Automatic Lux distribution to project stakeholders based on project type
 *   - Subscription management with auto-renewal
 *   - Usage fee charging
 *
 * Phase 57: MongoDB-first writes. StorageBackend is REQUIRED.
 * MongoDB is written first (await), then SQLite cache is updated.
 * Lux DISTRIBUTION stays on P2P ledger (correct — economy is network state).
 * Read methods stay sync (from SQLite cache). Async reads prefer MongoDB.
 *
 * Uses the same better-sqlite3 instance as the ledger for consistency.
 */

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  ProjectRevenue,
  RevenueDistributionEntry,
  RevenueDistributionRecord,
  RevenueSummary,
  DistributionResult,
  ProjectSubscription,
  RevenueSource,
} from '@pando/shared';
import type { ProjectStore } from './project-store.js';
import type { StorageBackend } from './storage-backend.js';

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_revenue (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source TEXT NOT NULL,
    amount REAL NOT NULL,
    payer_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revenue_distributions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    period_start INTEGER NOT NULL,
    period_end INTEGER NOT NULL,
    total_revenue REAL NOT NULL,
    distributions TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_subscriptions (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'basic',
    price_lux REAL NOT NULL,
    started_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    auto_renew INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (project_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_project_revenue_project_id ON project_revenue(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_revenue_created_at ON project_revenue(created_at);
  CREATE INDEX IF NOT EXISTS idx_revenue_distributions_project_id ON revenue_distributions(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_subscriptions_expires_at ON project_subscriptions(expires_at);
`;

// ── Minimal Ledger Interface ─────────────────────────────────────────────────

interface LedgerLike {
  accounts: {
    getBalance(peerId: string): number;
    subtractBalance(peerId: string, amount: number): boolean;
    addBalance(peerId: string, amount: number): void;
    exists(peerId: string): boolean;
  };
}

// ── Default Distribution Shares ──────────────────────────────────────────────

/** Distribution shares for private projects. */
const PRIVATE_SHARES = { owner: 0.85, compute: 0.10, relay: 0.05 };

/** Distribution shares for public projects. */
const PUBLIC_SHARES = { contributors: 0.50, network: 0.30, compute: 0.15, relay: 0.05 };

/** The NETWORK account receives treasury shares. */
const NETWORK_ACCOUNT = 'NETWORK';

// ── RevenueEngine Class ─────────────────────────────────────────────────────

export class RevenueEngine {
  private db: Database.Database;
  private ledger: LedgerLike;
  private backend: StorageBackend;

  constructor(db: Database.Database, ledger: LedgerLike, storageBackend: StorageBackend) {
    if (!storageBackend) throw new Error('[revenue-engine] StorageBackend is required');
    this.db = db;
    this.ledger = ledger;
    this.backend = storageBackend;
  }

  /**
   * Create tables and indexes. Call once after construction.
   */
  init(): void {
    this.db.exec(SCHEMA);
    console.log('[revenue-engine] Initialized');
  }

  /**
   * Load revenue records, distributions, and subscriptions from MongoDB into SQLite cache.
   */
  async loadFromBackend(): Promise<void> {
    console.log('[revenue-engine] Loading from MongoDB...');

    // Load revenue records
    const revenueRecords = await this.backend.queryRecords('project_revenue', {});
    const insertRevenue = this.db.prepare(`
      INSERT OR REPLACE INTO project_revenue (id, project_id, source, amount, payer_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const loadRevenue = this.db.transaction(() => {
      for (const r of revenueRecords) {
        insertRevenue.run(
          r.id || r._id,
          r.projectId || r.project_id,
          r.source,
          r.amount,
          r.payerId || r.payer_id,
          r.createdAt || r.created_at,
        );
      }
    });
    loadRevenue();

    // Load distribution records
    const distRecords = await this.backend.queryRecords('revenue_distributions', {});
    const insertDist = this.db.prepare(`
      INSERT OR REPLACE INTO revenue_distributions (id, project_id, period_start, period_end, total_revenue, distributions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const loadDist = this.db.transaction(() => {
      for (const r of distRecords) {
        const rawDist = r.distributions;
        const distJson = typeof rawDist === 'string' ? rawDist : JSON.stringify(rawDist || []);
        insertDist.run(
          r.id || r._id,
          r.projectId || r.project_id,
          r.periodStart ?? r.period_start,
          r.periodEnd ?? r.period_end,
          r.totalRevenue ?? r.total_revenue,
          distJson,
          r.createdAt || r.created_at,
        );
      }
    });
    loadDist();

    // Load subscriptions
    const subRecords = await this.backend.queryRecords('project_subscriptions', {});
    const insertSub = this.db.prepare(`
      INSERT OR REPLACE INTO project_subscriptions (project_id, user_id, tier, price_lux, started_at, expires_at, auto_renew)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const loadSub = this.db.transaction(() => {
      for (const r of subRecords) {
        const autoRenew = r.autoRenew ?? r.auto_renew;
        insertSub.run(
          r.projectId || r.project_id,
          r.userId || r.user_id,
          r.tier,
          r.priceLux ?? r.price_lux,
          r.startedAt || r.started_at,
          r.expiresAt || r.expires_at,
          (autoRenew === true || autoRenew === 1) ? 1 : 0,
        );
      }
    });
    loadSub();

    console.log(`[revenue-engine] Loaded ${revenueRecords.length} revenue records, ${distRecords.length} distributions, ${subRecords.length} subscriptions from MongoDB`);
  }

  // ── Record Revenue ─────────────────────────────────────────────────────

  /**
   * Record a revenue event for a project.
   */
  async recordRevenue(projectId: string, source: RevenueSource, amount: number, payerId: string): Promise<ProjectRevenue> {
    const id = this.generateId('rev');
    const now = Date.now();

    // MongoDB-first
    await this.backend.putRecord('project_revenue', id, {
      projectId,
      source,
      amount,
      payerId,
      createdAt: now,
    });

    // SQLite cache
    this.db.prepare(`
      INSERT INTO project_revenue (id, project_id, source, amount, payer_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, projectId, source, amount, payerId, now);

    console.log(`[revenue-engine] Recorded ${source} revenue: ${amount} Lux for project ${projectId} from ${payerId}`);

    return { id, projectId, source, amount, payerId, createdAt: now };
  }

  // ── Query Revenue ──────────────────────────────────────────────────────

  /**
   * Get revenue records for a project, optionally filtered by time range.
   */
  getProjectRevenue(projectId: string, opts?: { since?: number; until?: number }): ProjectRevenue[] {
    const conditions = ['project_id = ?'];
    const params: any[] = [projectId];

    if (opts?.since) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }
    if (opts?.until) {
      conditions.push('created_at <= ?');
      params.push(opts.until);
    }

    const rows = this.db.prepare(
      `SELECT * FROM project_revenue WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
    ).all(...params) as any[];

    return rows.map(r => this.rowToRevenue(r));
  }

  /**
   * Get revenue records for a project (async — reads from MongoDB).
   */
  async getProjectRevenueAsync(projectId: string, opts?: { since?: number; until?: number }): Promise<ProjectRevenue[]> {
    const filter: Record<string, any> = { projectId };
    const records = await this.backend.queryRecords('project_revenue', filter, { sort: { createdAt: -1 } });
    let results = records.map(r => this.recordToRevenue(r));
    // Apply time range filters client-side
    if (opts?.since) {
      results = results.filter(r => r.createdAt >= opts.since!);
    }
    if (opts?.until) {
      results = results.filter(r => r.createdAt <= opts.until!);
    }
    return results;
  }

  /**
   * Get a revenue summary for a project.
   */
  getRevenueSummary(projectId: string): RevenueSummary {
    const now = Date.now();
    const thisMonthStart = new Date();
    thisMonthStart.setDate(1);
    thisMonthStart.setHours(0, 0, 0, 0);
    const thisMonthMs = thisMonthStart.getTime();

    const lastMonthStart = new Date(thisMonthStart);
    lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
    const lastMonthMs = lastMonthStart.getTime();

    // Total revenue
    const totalRow = this.db.prepare(
      'SELECT COALESCE(SUM(amount), 0) as total FROM project_revenue WHERE project_id = ?'
    ).get(projectId) as any;
    const totalRevenue = totalRow?.total || 0;

    // This month
    const thisMonthRow = this.db.prepare(
      'SELECT COALESCE(SUM(amount), 0) as total FROM project_revenue WHERE project_id = ? AND created_at >= ?'
    ).get(projectId, thisMonthMs) as any;
    const thisMonth = thisMonthRow?.total || 0;

    // Last month
    const lastMonthRow = this.db.prepare(
      'SELECT COALESCE(SUM(amount), 0) as total FROM project_revenue WHERE project_id = ? AND created_at >= ? AND created_at < ?'
    ).get(projectId, lastMonthMs, thisMonthMs) as any;
    const lastMonth = lastMonthRow?.total || 0;

    // By source
    const sourceRows = this.db.prepare(
      'SELECT source, COALESCE(SUM(amount), 0) as total FROM project_revenue WHERE project_id = ? GROUP BY source'
    ).all(projectId) as any[];

    const bySource: Record<string, number> = {};
    for (const row of sourceRows) {
      bySource[row.source] = row.total;
    }

    return { totalRevenue, thisMonth, lastMonth, bySource };
  }

  /**
   * Get a revenue summary for a project (async — reads from MongoDB).
   */
  async getRevenueSummaryAsync(projectId: string): Promise<RevenueSummary> {
    const records = await this.backend.queryRecords('project_revenue', { projectId });
    const allRevenue = records.map(r => this.recordToRevenue(r));

    const thisMonthStart = new Date();
    thisMonthStart.setDate(1);
    thisMonthStart.setHours(0, 0, 0, 0);
    const thisMonthMs = thisMonthStart.getTime();

    const lastMonthStart = new Date(thisMonthStart);
    lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
    const lastMonthMs = lastMonthStart.getTime();

    const totalRevenue = allRevenue.reduce((sum, r) => sum + r.amount, 0);
    const thisMonth = allRevenue.filter(r => r.createdAt >= thisMonthMs).reduce((sum, r) => sum + r.amount, 0);
    const lastMonth = allRevenue.filter(r => r.createdAt >= lastMonthMs && r.createdAt < thisMonthMs).reduce((sum, r) => sum + r.amount, 0);

    const bySource: Record<string, number> = {};
    for (const r of allRevenue) {
      bySource[r.source] = (bySource[r.source] || 0) + r.amount;
    }

    return { totalRevenue, thisMonth, lastMonth, bySource };
  }

  // ── Distribution ───────────────────────────────────────────────────────

  /**
   * Distribute undistributed revenue for a project to its stakeholders.
   *
   * Distribution logic depends on project type:
   *   - Private: 85% owner, 10% compute, 5% relay
   *   - Shared: configurable via project.revenueConfig
   *   - Public: 50% contributors, 30% network treasury, 15% compute, 5% relay
   */
  async distributeRevenue(projectId: string, projectStore: ProjectStore): Promise<DistributionResult> {
    const project = projectStore.getProject(projectId);
    if (!project) {
      return { success: false, distributed: 0, recipients: [], error: 'Project not found' };
    }

    // Find the last distribution end time
    const lastDist = this.db.prepare(
      'SELECT MAX(period_end) as last_end FROM revenue_distributions WHERE project_id = ?'
    ).get(projectId) as any;
    const periodStart = lastDist?.last_end || 0;
    const periodEnd = Date.now();

    // Get undistributed revenue (since last distribution)
    const revenueRows = this.db.prepare(
      'SELECT COALESCE(SUM(amount), 0) as total FROM project_revenue WHERE project_id = ? AND created_at > ? AND created_at <= ?'
    ).get(projectId, periodStart, periodEnd) as any;
    const totalRevenue = revenueRows?.total || 0;

    if (totalRevenue <= 0) {
      return { success: true, distributed: 0, recipients: [], error: 'No undistributed revenue' };
    }

    // Calculate shares based on project type
    const recipients: RevenueDistributionEntry[] = [];

    if (project.type === 'private') {
      // Private: 85% owner, 10% compute (NETWORK), 5% relay (NETWORK)
      recipients.push({
        userId: project.ownerId,
        role: 'owner',
        share: PRIVATE_SHARES.owner,
        amount: Math.round(totalRevenue * PRIVATE_SHARES.owner * 1e8) / 1e8,
      });
      recipients.push({
        userId: NETWORK_ACCOUNT,
        role: 'compute',
        share: PRIVATE_SHARES.compute,
        amount: Math.round(totalRevenue * PRIVATE_SHARES.compute * 1e8) / 1e8,
      });
      recipients.push({
        userId: NETWORK_ACCOUNT,
        role: 'relay',
        share: PRIVATE_SHARES.relay,
        amount: Math.round(totalRevenue * PRIVATE_SHARES.relay * 1e8) / 1e8,
      });
    } else if (project.type === 'shared') {
      // Shared: use revenueConfig if available, else split equally among collaborators
      const collaborators = projectStore.getCollaborators(projectId);
      const config = project.revenueConfig || {};

      if (config.shares && typeof config.shares === 'object') {
        // Custom shares: { userId: fraction }
        for (const [userId, share] of Object.entries(config.shares)) {
          const fraction = Number(share);
          if (fraction > 0) {
            recipients.push({
              userId,
              role: 'custom',
              share: fraction,
              amount: Math.round(totalRevenue * fraction * 1e8) / 1e8,
            });
          }
        }
      } else {
        // Default: equal split among all collaborators
        const count = collaborators.length || 1;
        const share = 1 / count;
        for (const collab of collaborators) {
          recipients.push({
            userId: collab.userId,
            role: collab.role,
            share,
            amount: Math.round(totalRevenue * share * 1e8) / 1e8,
          });
        }
      }
    } else {
      // Public: 50% contributors, 30% network, 15% compute, 5% relay
      const collaborators = projectStore.getCollaborators(projectId);
      const contributorShare = PUBLIC_SHARES.contributors;
      const nonOwnerCollabs = collaborators.filter(c => c.role !== 'owner');
      const contributorCount = nonOwnerCollabs.length;

      if (contributorCount > 0) {
        const perContributor = contributorShare / contributorCount;
        for (const collab of nonOwnerCollabs) {
          recipients.push({
            userId: collab.userId,
            role: 'contributor',
            share: perContributor,
            amount: Math.round(totalRevenue * perContributor * 1e8) / 1e8,
          });
        }
      } else {
        // No contributors — owner gets the contributor share
        recipients.push({
          userId: project.ownerId,
          role: 'owner_contributor',
          share: contributorShare,
          amount: Math.round(totalRevenue * contributorShare * 1e8) / 1e8,
        });
      }

      recipients.push({
        userId: NETWORK_ACCOUNT,
        role: 'network_treasury',
        share: PUBLIC_SHARES.network,
        amount: Math.round(totalRevenue * PUBLIC_SHARES.network * 1e8) / 1e8,
      });
      recipients.push({
        userId: NETWORK_ACCOUNT,
        role: 'compute',
        share: PUBLIC_SHARES.compute,
        amount: Math.round(totalRevenue * PUBLIC_SHARES.compute * 1e8) / 1e8,
      });
      recipients.push({
        userId: NETWORK_ACCOUNT,
        role: 'relay',
        share: PUBLIC_SHARES.relay,
        amount: Math.round(totalRevenue * PUBLIC_SHARES.relay * 1e8) / 1e8,
      });
    }

    // Execute Lux transfers
    for (const entry of recipients) {
      if (entry.amount > 0) {
        this.ledger.accounts.addBalance(entry.userId, entry.amount);
      }
    }

    // Record the distribution — MongoDB-first
    const distId = this.generateId('dist');
    const distCreatedAt = Date.now();

    await this.backend.putRecord('revenue_distributions', distId, {
      projectId,
      periodStart,
      periodEnd,
      totalRevenue,
      distributions: recipients, // native array, not JSON string
      createdAt: distCreatedAt,
    });

    // SQLite cache
    this.db.prepare(`
      INSERT INTO revenue_distributions (id, project_id, period_start, period_end, total_revenue, distributions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(distId, projectId, periodStart, periodEnd, totalRevenue, JSON.stringify(recipients), distCreatedAt);

    const distributed = recipients.reduce((sum, r) => sum + r.amount, 0);
    console.log(`[revenue-engine] Distributed ${distributed} Lux across ${recipients.length} recipients for project ${projectId}`);

    return { success: true, distributed, recipients };
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  /**
   * Create or update a subscription for a user on a project.
   */
  async createSubscription(
    projectId: string,
    userId: string,
    tier: string,
    priceLux: number,
    durationDays: number,
  ): Promise<ProjectSubscription> {
    const now = Date.now();
    const expiresAt = now + durationDays * 24 * 60 * 60 * 1000;

    // MongoDB-first — subscription record
    await this.backend.putRecord('project_subscriptions', `${projectId}:${userId}`, {
      projectId,
      userId,
      tier,
      priceLux,
      startedAt: now,
      expiresAt,
      autoRenew: true,
    });

    // SQLite cache
    this.db.prepare(`
      INSERT OR REPLACE INTO project_subscriptions (project_id, user_id, tier, price_lux, started_at, expires_at, auto_renew)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(projectId, userId, tier, priceLux, now, expiresAt);

    // Record as revenue (now async)
    await this.recordRevenue(projectId, 'subscription', priceLux, userId);

    console.log(`[revenue-engine] Subscription created: ${userId} -> ${projectId} (${tier}, ${durationDays} days, ${priceLux} Lux)`);

    return {
      projectId,
      userId,
      tier,
      priceLux,
      startedAt: now,
      expiresAt,
      autoRenew: true,
    };
  }

  /**
   * Get a user's subscription for a project.
   */
  getSubscription(projectId: string, userId: string): ProjectSubscription | null {
    const row = this.db.prepare(
      'SELECT * FROM project_subscriptions WHERE project_id = ? AND user_id = ?'
    ).get(projectId, userId) as any;
    return row ? this.rowToSubscription(row) : null;
  }

  /**
   * Get a user's subscription (async — reads from MongoDB).
   */
  async getSubscriptionAsync(projectId: string, userId: string): Promise<ProjectSubscription | null> {
    const record = await this.backend.getRecord('project_subscriptions', `${projectId}:${userId}`);
    return record ? this.recordToSubscription(record) : null;
  }

  /**
   * Process auto-renewal for expired subscriptions.
   * Renews subscriptions where auto_renew=1 and expires_at < now,
   * provided the user has sufficient balance.
   */
  async processSubscriptionRenewals(): Promise<{ renewed: number; failed: number; expired: number }> {
    const now = Date.now();
    const rows = this.db.prepare(
      'SELECT * FROM project_subscriptions WHERE expires_at < ? AND auto_renew = 1'
    ).all(now) as any[];

    let renewed = 0;
    let failed = 0;
    let expired = 0;

    for (const row of rows) {
      const sub = this.rowToSubscription(row);
      const balance = this.ledger.accounts.getBalance(sub.userId);

      if (balance >= sub.priceLux) {
        // Deduct and renew
        const deducted = this.ledger.accounts.subtractBalance(sub.userId, sub.priceLux);
        if (deducted) {
          // Calculate same duration as original
          const durationMs = sub.expiresAt - sub.startedAt;
          const newExpiry = now + durationMs;

          // MongoDB-first
          await this.backend.putRecord('project_subscriptions', `${sub.projectId}:${sub.userId}`, {
            projectId: sub.projectId,
            userId: sub.userId,
            tier: sub.tier,
            priceLux: sub.priceLux,
            startedAt: now,
            expiresAt: newExpiry,
            autoRenew: true,
          });

          // SQLite cache
          this.db.prepare(
            'UPDATE project_subscriptions SET started_at = ?, expires_at = ? WHERE project_id = ? AND user_id = ?'
          ).run(now, newExpiry, sub.projectId, sub.userId);

          await this.recordRevenue(sub.projectId, 'subscription', sub.priceLux, sub.userId);
          renewed++;
          console.log(`[revenue-engine] Renewed subscription: ${sub.userId} -> ${sub.projectId}`);
        } else {
          failed++;
        }
      } else {
        // Cannot afford — disable auto-renew. MongoDB-first.
        await this.backend.putRecord('project_subscriptions', `${sub.projectId}:${sub.userId}`, {
          projectId: sub.projectId,
          userId: sub.userId,
          tier: sub.tier,
          priceLux: sub.priceLux,
          startedAt: sub.startedAt,
          expiresAt: sub.expiresAt,
          autoRenew: false,
        });

        // SQLite cache
        this.db.prepare(
          'UPDATE project_subscriptions SET auto_renew = 0 WHERE project_id = ? AND user_id = ?'
        ).run(sub.projectId, sub.userId);
        expired++;
        console.log(`[revenue-engine] Subscription expired (insufficient funds): ${sub.userId} -> ${sub.projectId}`);
      }
    }

    return { renewed, failed, expired };
  }

  // ── Usage Fee ──────────────────────────────────────────────────────────

  /**
   * Charge a user a usage fee for a project. Deducts from user balance and records revenue.
   * Returns true if charged successfully, false if insufficient balance.
   */
  async chargeUsageFee(projectId: string, userId: string, amount: number, _description?: string): Promise<boolean> {
    if (amount <= 0) return true;

    const deducted = this.ledger.accounts.subtractBalance(userId, amount);
    if (!deducted) return false;

    await this.recordRevenue(projectId, 'usage_fee', amount, userId);
    return true;
  }

  // ── Distribution History ───────────────────────────────────────────────

  /**
   * Get past distribution records for a project.
   */
  getDistributionHistory(projectId: string): RevenueDistributionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM revenue_distributions WHERE project_id = ? ORDER BY created_at DESC'
    ).all(projectId) as any[];

    return rows.map(r => this.rowToDistribution(r));
  }

  /**
   * Get past distribution records (async — reads from MongoDB).
   */
  async getDistributionHistoryAsync(projectId: string): Promise<RevenueDistributionRecord[]> {
    const records = await this.backend.queryRecords('revenue_distributions', { projectId }, { sort: { createdAt: -1 } });
    return records.map(r => this.recordToDistribution(r));
  }

  // ── Private Helpers ────────────────────────────────────────────────────

  private generateId(prefix: string): string {
    return `${prefix}-${randomBytes(12).toString('hex')}`;
  }

  /**
   * Convert a SQLite row (snake_case) to a ProjectRevenue.
   */
  private rowToRevenue(row: any): ProjectRevenue {
    return {
      id: row.id,
      projectId: row.project_id,
      source: row.source as RevenueSource,
      amount: row.amount,
      payerId: row.payer_id,
      createdAt: row.created_at,
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a ProjectRevenue.
   */
  private recordToRevenue(r: any): ProjectRevenue {
    return {
      id: r.id || r._id,
      projectId: r.projectId || r.project_id,
      source: (r.source as RevenueSource),
      amount: r.amount,
      payerId: r.payerId || r.payer_id,
      createdAt: r.createdAt || r.created_at,
    };
  }

  /**
   * Convert a SQLite row (snake_case) to a ProjectSubscription.
   */
  private rowToSubscription(row: any): ProjectSubscription {
    return {
      projectId: row.project_id,
      userId: row.user_id,
      tier: row.tier,
      priceLux: row.price_lux,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      autoRenew: row.auto_renew === 1,
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a ProjectSubscription.
   */
  private recordToSubscription(r: any): ProjectSubscription {
    const autoRenew = r.autoRenew ?? r.auto_renew;
    return {
      projectId: r.projectId || r.project_id,
      userId: r.userId || r.user_id,
      tier: r.tier,
      priceLux: r.priceLux ?? r.price_lux,
      startedAt: r.startedAt || r.started_at,
      expiresAt: r.expiresAt || r.expires_at,
      autoRenew: autoRenew === true || autoRenew === 1,
    };
  }

  /**
   * Convert a SQLite row (snake_case) to a RevenueDistributionRecord.
   */
  private rowToDistribution(row: any): RevenueDistributionRecord {
    let distributions: RevenueDistributionEntry[] = [];
    try {
      distributions = JSON.parse(row.distributions || '[]');
    } catch {
      distributions = [];
    }

    return {
      id: row.id,
      projectId: row.project_id,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      totalRevenue: row.total_revenue,
      distributions,
      createdAt: row.created_at,
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a RevenueDistributionRecord.
   */
  private recordToDistribution(r: any): RevenueDistributionRecord {
    const rawDist = r.distributions || '[]';
    let distributions: RevenueDistributionEntry[] = [];
    try {
      distributions = typeof rawDist === 'string' ? JSON.parse(rawDist) : rawDist;
    } catch {
      distributions = [];
    }

    return {
      id: r.id || r._id,
      projectId: r.projectId || r.project_id,
      periodStart: r.periodStart ?? r.period_start,
      periodEnd: r.periodEnd ?? r.period_end,
      totalRevenue: r.totalRevenue ?? r.total_revenue,
      distributions,
      createdAt: r.createdAt || r.created_at,
    };
  }
}
