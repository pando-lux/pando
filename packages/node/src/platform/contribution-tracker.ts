/**
 * ContributionTracker — Track verified work contributions to projects.
 *
 * Phase 31.9: Records individual contributions (code, review, test, design,
 * management, documentation), verifies them via manager/admin, calculates
 * time-decayed scores, and derives proportional revenue shares.
 *
 * Phase 57: MongoDB-first writes. StorageBackend is REQUIRED.
 * MongoDB is written first (await), then SQLite cache is updated.
 * Read methods stay sync (from SQLite cache). Async reads prefer MongoDB.
 *
 * Uses the same better-sqlite3 instance as the ledger for consistency.
 */

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import type {
  ProjectContribution,
  ContributionScore,
  ContributionType,
  RevenueShare,
} from '@pando/shared';
import type { StorageBackend } from '../core/storage-backend.js';

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS project_contributions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    contribution_type TEXT NOT NULL,
    description TEXT DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0,
    verified_by TEXT DEFAULT '',
    weight REAL NOT NULL DEFAULT 1.0,
    agent_id TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contribution_scores (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    raw_score REAL NOT NULL DEFAULT 0,
    decayed_score REAL NOT NULL DEFAULT 0,
    last_calculated INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_project_contributions_project_id ON project_contributions(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_contributions_user_id ON project_contributions(user_id);
  CREATE INDEX IF NOT EXISTS idx_project_contributions_verified ON project_contributions(verified);
  CREATE INDEX IF NOT EXISTS idx_contribution_scores_project_id ON contribution_scores(project_id);
`;

// ── Valid Contribution Types ─────────────────────────────────────────────────

const VALID_CONTRIBUTION_TYPES: ContributionType[] = [
  'code', 'review', 'test', 'design', 'management', 'documentation',
];

// ── ContributionTracker Class ────────────────────────────────────────────────

export class ContributionTracker {
  private db: Database.Database;
  private backend: StorageBackend;

  constructor(db: Database.Database, storageBackend: StorageBackend) {
    if (!storageBackend) throw new Error('[contribution-tracker] StorageBackend is required');
    this.db = db;
    this.backend = storageBackend;
  }

  /**
   * Create tables and indexes. Call once after construction.
   */
  init(): void {
    this.db.exec(SCHEMA);
    console.log('[contribution-tracker] Initialized');
  }

  /**
   * Load contribution records and scores from MongoDB into SQLite cache.
   */
  async loadFromBackend(): Promise<void> {
    console.log('[contribution-tracker] Loading from MongoDB...');

    // Load contributions
    const contribRecords = await this.backend.queryRecords('project_contributions', {});
    const insertContrib = this.db.prepare(`
      INSERT OR REPLACE INTO project_contributions (id, project_id, user_id, contribution_type, description, verified, verified_by, weight, agent_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const loadContribs = this.db.transaction(() => {
      for (const r of contribRecords) {
        const verified = r.verified ?? r.verified;
        insertContrib.run(
          r.id || r._id,
          r.projectId || r.project_id,
          r.userId || r.user_id,
          r.contributionType || r.contribution_type,
          r.description || '',
          (verified === true || verified === 1) ? 1 : 0,
          r.verifiedBy || r.verified_by || '',
          r.weight || 1.0,
          r.agentId || r.agent_id || '',
          r.createdAt || r.created_at,
        );
      }
    });
    loadContribs();

    // Load scores
    const scoreRecords = await this.backend.queryRecords('contribution_scores', {});
    const insertScore = this.db.prepare(`
      INSERT OR REPLACE INTO contribution_scores (project_id, user_id, raw_score, decayed_score, last_calculated)
      VALUES (?, ?, ?, ?, ?)
    `);
    const loadScores = this.db.transaction(() => {
      for (const r of scoreRecords) {
        insertScore.run(
          r.projectId || r.project_id,
          r.userId || r.user_id,
          r.rawScore ?? r.raw_score ?? 0,
          r.decayedScore ?? r.decayed_score ?? 0,
          r.lastCalculated || r.last_calculated,
        );
      }
    });
    loadScores();

    console.log(`[contribution-tracker] Loaded ${contribRecords.length} contributions, ${scoreRecords.length} scores from MongoDB`);
  }

  // ── Record ──────────────────────────────────────────────────────────────

  /**
   * Record a new contribution to a project.
   */
  async recordContribution(
    projectId: string,
    userId: string,
    type: ContributionType,
    description?: string,
    weight?: number,
    agentId?: string,
  ): Promise<ProjectContribution> {
    if (!VALID_CONTRIBUTION_TYPES.includes(type)) {
      throw new Error(`Invalid contribution type: ${type}. Must be one of: ${VALID_CONTRIBUTION_TYPES.join(', ')}`);
    }

    const id = this.generateId('contrib');
    const now = Date.now();
    const w = weight !== undefined && weight > 0 ? weight : 1.0;

    // MongoDB-first
    await this.backend.putRecord('project_contributions', id, {
      projectId,
      userId,
      contributionType: type,
      description: description || '',
      verified: false,
      verifiedBy: '',
      weight: w,
      agentId: agentId || '',
      createdAt: now,
    });

    // SQLite cache
    this.db.prepare(`
      INSERT INTO project_contributions (id, project_id, user_id, contribution_type, description, verified, verified_by, weight, agent_id, created_at)
      VALUES (?, ?, ?, ?, ?, 0, '', ?, ?, ?)
    `).run(id, projectId, userId, type, description || '', w, agentId || '', now);

    console.log(`[contribution-tracker] Recorded ${type} contribution by ${userId} for project ${projectId} (weight=${w})`);

    return {
      id,
      projectId,
      userId,
      contributionType: type,
      description: description || '',
      verified: false,
      verifiedBy: '',
      weight: w,
      agentId: agentId || '',
      createdAt: now,
    };
  }

  // ── Verify ──────────────────────────────────────────────────────────────

  /**
   * Verify a contribution (mark as verified by a manager/admin).
   */
  async verifyContribution(contributionId: string, verifiedBy: string): Promise<void> {
    // Read current record from SQLite to get full data for MongoDB write
    const row = this.db.prepare('SELECT * FROM project_contributions WHERE id = ?').get(contributionId) as any;
    if (!row) return;

    // MongoDB-first
    await this.backend.putRecord('project_contributions', contributionId, {
      projectId: row.project_id,
      userId: row.user_id,
      contributionType: row.contribution_type,
      description: row.description || '',
      verified: true,
      verifiedBy,
      weight: row.weight || 1.0,
      agentId: row.agent_id || '',
      createdAt: row.created_at,
    });

    // SQLite cache
    this.db.prepare(
      'UPDATE project_contributions SET verified = 1, verified_by = ? WHERE id = ?'
    ).run(verifiedBy, contributionId);

    console.log(`[contribution-tracker] Contribution ${contributionId} verified by ${verifiedBy}`);
  }

  // ── Query ───────────────────────────────────────────────────────────────

  /**
   * Get contributions for a project, optionally filtered by user and/or verification status.
   */
  getContributions(
    projectId: string,
    opts?: { userId?: string; verified?: boolean },
  ): ProjectContribution[] {
    const conditions: string[] = ['project_id = ?'];
    const params: any[] = [projectId];

    if (opts?.userId) {
      conditions.push('user_id = ?');
      params.push(opts.userId);
    }
    if (opts?.verified !== undefined) {
      conditions.push('verified = ?');
      params.push(opts.verified ? 1 : 0);
    }

    const rows = this.db.prepare(
      `SELECT * FROM project_contributions WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
    ).all(...params) as any[];

    return rows.map(r => this.rowToContribution(r));
  }

  /**
   * Get contributions for a project (async — reads from MongoDB).
   */
  async getContributionsAsync(
    projectId: string,
    opts?: { userId?: string; verified?: boolean },
  ): Promise<ProjectContribution[]> {
    const filter: Record<string, any> = { projectId };
    if (opts?.userId) filter.userId = opts.userId;
    if (opts?.verified !== undefined) filter.verified = opts.verified;
    const records = await this.backend.queryRecords('project_contributions', filter, { sort: { createdAt: -1 } });
    return records.map(r => this.recordToContribution(r));
  }

  // ── Score Calculation ───────────────────────────────────────────────────

  /**
   * Recalculate all contribution scores for a project.
   * Uses 10% monthly decay: score = weight * 0.9^(monthsSinceContribution).
   * Only verified contributions count.
   */
  async calculateScores(projectId: string): Promise<ContributionScore[]> {
    const now = Date.now();
    const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000; // ~30 days

    // Get all verified contributions for this project
    const rows = this.db.prepare(
      'SELECT * FROM project_contributions WHERE project_id = ? AND verified = 1'
    ).all(projectId) as any[];

    // Aggregate scores per user
    const userScores = new Map<string, { raw: number; decayed: number }>();

    for (const row of rows) {
      const userId = row.user_id;
      const weight = row.weight || 1.0;
      const monthsSince = (now - row.created_at) / MS_PER_MONTH;
      const decayedWeight = weight * Math.pow(0.9, monthsSince);

      const existing = userScores.get(userId) || { raw: 0, decayed: 0 };
      existing.raw += weight;
      existing.decayed += decayedWeight;
      userScores.set(userId, existing);
    }

    const results: ContributionScore[] = [];

    // MongoDB-first — write each score
    for (const [userId, scores] of userScores) {
      const rawScore = Math.round(scores.raw * 1e8) / 1e8;
      const decayedScore = Math.round(scores.decayed * 1e8) / 1e8;
      await this.backend.putRecord('contribution_scores', `${projectId}:${userId}`, {
        projectId,
        userId,
        rawScore,
        decayedScore,
        lastCalculated: now,
      });
      results.push({ projectId, userId, rawScore, decayedScore, lastCalculated: now });
    }

    // SQLite cache
    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO contribution_scores (project_id, user_id, raw_score, decayed_score, last_calculated)
      VALUES (?, ?, ?, ?, ?)
    `);
    const upsertMany = this.db.transaction(() => {
      for (const score of results) {
        upsert.run(score.projectId, score.userId, score.rawScore, score.decayedScore, score.lastCalculated);
      }
    });
    upsertMany();

    console.log(`[contribution-tracker] Recalculated scores for project ${projectId}: ${results.length} contributors`);

    return results;
  }

  /**
   * Recalculate scores (async — reads contributions from MongoDB, writes scores MongoDB-first).
   */
  async calculateScoresAsync(projectId: string): Promise<ContributionScore[]> {
    const now = Date.now();
    const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

    // Read verified contributions from MongoDB
    const records = await this.backend.queryRecords('project_contributions', { projectId, verified: true });

    // Aggregate scores per user
    const userScores = new Map<string, { raw: number; decayed: number }>();

    for (const r of records) {
      const userId = r.userId || r.user_id;
      const weight = r.weight || 1.0;
      const createdAt = r.createdAt || r.created_at;
      const monthsSince = (now - createdAt) / MS_PER_MONTH;
      const decayedWeight = weight * Math.pow(0.9, monthsSince);

      const existing = userScores.get(userId) || { raw: 0, decayed: 0 };
      existing.raw += weight;
      existing.decayed += decayedWeight;
      userScores.set(userId, existing);
    }

    const results: ContributionScore[] = [];

    // MongoDB-first — write each score
    for (const [userId, scores] of userScores) {
      const rawScore = Math.round(scores.raw * 1e8) / 1e8;
      const decayedScore = Math.round(scores.decayed * 1e8) / 1e8;
      await this.backend.putRecord('contribution_scores', `${projectId}:${userId}`, {
        projectId,
        userId,
        rawScore,
        decayedScore,
        lastCalculated: now,
      });
      results.push({ projectId, userId, rawScore, decayedScore, lastCalculated: now });
    }

    // SQLite cache
    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO contribution_scores (project_id, user_id, raw_score, decayed_score, last_calculated)
      VALUES (?, ?, ?, ?, ?)
    `);
    const upsertMany = this.db.transaction(() => {
      for (const score of results) {
        upsert.run(score.projectId, score.userId, score.rawScore, score.decayedScore, score.lastCalculated);
      }
    });
    upsertMany();

    return results;
  }

  /**
   * Get contribution scores for a project, sorted by decayed_score descending.
   */
  getScores(projectId: string): ContributionScore[] {
    const rows = this.db.prepare(
      'SELECT * FROM contribution_scores WHERE project_id = ? ORDER BY decayed_score DESC'
    ).all(projectId) as any[];

    return rows.map(r => this.rowToScore(r));
  }

  /**
   * Get contribution scores for a project (async — reads from MongoDB).
   */
  async getScoresAsync(projectId: string): Promise<ContributionScore[]> {
    const records = await this.backend.queryRecords('contribution_scores', { projectId }, { sort: { decayedScore: -1 } });
    return records.map(r => this.recordToScore(r));
  }

  /**
   * Get a single user's contribution score for a project.
   */
  getScore(projectId: string, userId: string): ContributionScore | null {
    const row = this.db.prepare(
      'SELECT * FROM contribution_scores WHERE project_id = ? AND user_id = ?'
    ).get(projectId, userId) as any;

    return row ? this.rowToScore(row) : null;
  }

  /**
   * Get a single user's contribution score (async — reads from MongoDB).
   */
  async getScoreAsync(projectId: string, userId: string): Promise<ContributionScore | null> {
    const record = await this.backend.getRecord('contribution_scores', `${projectId}:${userId}`);
    return record ? this.recordToScore(record) : null;
  }

  /**
   * Get proportional revenue shares based on decayed contribution scores.
   * Returns each user's proportional share (0-1) of the total.
   */
  getRevenueShares(projectId: string): RevenueShare[] {
    const scores = this.getScores(projectId);
    const totalDecayed = scores.reduce((sum, s) => sum + s.decayedScore, 0);

    if (totalDecayed <= 0) return [];

    return scores.map(s => ({
      userId: s.userId,
      share: Math.round((s.decayedScore / totalDecayed) * 1e8) / 1e8,
    }));
  }

  /**
   * Get proportional revenue shares (async — prefers MongoDB).
   */
  async getRevenueSharesAsync(projectId: string): Promise<RevenueShare[]> {
    const scores = await this.getScoresAsync(projectId);
    const totalDecayed = scores.reduce((sum, s) => sum + s.decayedScore, 0);

    if (totalDecayed <= 0) return [];

    return scores.map(s => ({
      userId: s.userId,
      share: Math.round((s.decayedScore / totalDecayed) * 1e8) / 1e8,
    }));
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  private generateId(prefix: string): string {
    return `${prefix}-${randomBytes(12).toString('hex')}`;
  }

  /**
   * Convert a SQLite row (snake_case) to a ProjectContribution.
   */
  private rowToContribution(row: any): ProjectContribution {
    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      contributionType: row.contribution_type as ContributionType,
      description: row.description || '',
      verified: row.verified === 1,
      verifiedBy: row.verified_by || '',
      weight: row.weight || 1.0,
      agentId: row.agent_id || '',
      createdAt: row.created_at,
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a ProjectContribution.
   */
  private recordToContribution(r: any): ProjectContribution {
    const verified = r.verified ?? r.verified;
    return {
      id: r.id || r._id,
      projectId: r.projectId || r.project_id,
      userId: r.userId || r.user_id,
      contributionType: (r.contributionType || r.contribution_type) as ContributionType,
      description: r.description || '',
      verified: verified === true || verified === 1,
      verifiedBy: r.verifiedBy || r.verified_by || '',
      weight: r.weight || 1.0,
      agentId: r.agentId || r.agent_id || '',
      createdAt: r.createdAt || r.created_at,
    };
  }

  /**
   * Convert a SQLite row (snake_case) to a ContributionScore.
   */
  private rowToScore(row: any): ContributionScore {
    return {
      projectId: row.project_id,
      userId: row.user_id,
      rawScore: row.raw_score || 0,
      decayedScore: row.decayed_score || 0,
      lastCalculated: row.last_calculated,
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a ContributionScore.
   */
  private recordToScore(r: any): ContributionScore {
    return {
      projectId: r.projectId || r.project_id,
      userId: r.userId || r.user_id,
      rawScore: r.rawScore ?? r.raw_score ?? 0,
      decayedScore: r.decayedScore ?? r.decayed_score ?? 0,
      lastCalculated: r.lastCalculated || r.last_calculated,
    };
  }
}
