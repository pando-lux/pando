/**
 * ProjectStore — Persistent project storage with MongoDB as source of truth.
 *
 * Phase 31.1: Project Data Model
 * Phase 31.5: Collaboration Enhancement (invites)
 * Phase 31.6: Ownership Transfer
 * Phase 44: MongoDB dual-mode support (StorageBackend)
 * Phase 57: MongoDB-first writes — backend is REQUIRED.
 *
 * Projects are first-class persistent entities. Each project has an owner,
 * collaborators, budget tracking, linked threads/agents, and revenue config.
 *
 * MongoDB-first: All writes go to MongoDB first (must succeed), then SQLite
 * is updated as a local cache. Reads use SQLite (sync) for speed.
 * loadFromBackend() hydrates SQLite from MongoDB on startup.
 *
 * Uses the same better-sqlite3 instance as the ledger to avoid multiple
 * database connections and to allow future cross-table queries.
 */

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import type {
  Project,
  ProjectCollaborator,
  ProjectType,
  ProjectVisibility,
  ProjectRevenueModel,
  ProjectStatus,
  ProjectRole,
  ProjectInvite,
  InviteUseResult,
  ProjectTransfer,
  TransferType,
  TransferStatus,
  ProjectDeployment,
  DeployType,
  DeploymentStatus,
  ProjectRating,
  ProjectRatingSummary,
  MarketplaceQuery,
  MarketplaceListResult,
  ContentReport,
  ReportReason,
  ReportStatus,
  ReportAction,
  ReportStats,
} from '@pando/shared';
import type { StorageBackend } from '../core/storage-backend.js';

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    owner_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'private',
    visibility TEXT NOT NULL DEFAULT 'owner_only',
    revenue_model TEXT NOT NULL DEFAULT 'none',
    revenue_config TEXT DEFAULT '{}',
    budget_spent REAL DEFAULT 0,
    budget_limit REAL DEFAULT 0,
    thread_id TEXT DEFAULT '',
    manager_agent_id TEXT DEFAULT '',
    deployment_url TEXT DEFAULT '',
    deployment_type TEXT DEFAULT '',
    deployment_status TEXT DEFAULT 'none',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_collaborators (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'collaborator',
    added_at INTEGER NOT NULL,
    added_by TEXT NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
  CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(type);
  CREATE INDEX IF NOT EXISTS idx_projects_visibility ON projects(visibility);
  CREATE INDEX IF NOT EXISTS idx_project_collaborators_user_id ON project_collaborators(user_id);

  CREATE TABLE IF NOT EXISTS project_invites (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'collaborator',
    created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 0,
    used_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_project_invites_code ON project_invites(code);
  CREATE INDEX IF NOT EXISTS idx_project_invites_project_id ON project_invites(project_id);

  CREATE TABLE IF NOT EXISTS project_transfers (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    transfer_type TEXT NOT NULL DEFAULT 'direct',
    sale_price REAL NOT NULL DEFAULT 0,
    escrow_hold_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_project_transfers_project_id ON project_transfers(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_transfers_status ON project_transfers(status);

  CREATE TABLE IF NOT EXISTS project_deployments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    deploy_type TEXT NOT NULL,
    deploy_url TEXT DEFAULT '',
    deploy_config TEXT DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    deployed_by TEXT NOT NULL,
    deployed_at INTEGER NOT NULL,
    error_message TEXT DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_project_deployments_project_id ON project_deployments(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_deployments_status ON project_deployments(status);

  CREATE TABLE IF NOT EXISTS project_ratings (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    review TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_project_ratings_project_id ON project_ratings(project_id);

  CREATE TABLE IF NOT EXISTS content_reports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    ai_review TEXT DEFAULT '',
    ai_safety_score REAL DEFAULT -1,
    reviewed_by TEXT DEFAULT '',
    resolved_at INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_content_reports_project_id ON content_reports(project_id);
  CREATE INDEX IF NOT EXISTS idx_content_reports_status ON content_reports(status);
  CREATE INDEX IF NOT EXISTS idx_content_reports_reporter_id ON content_reports(reporter_id);
`;

// ── Types ────────────────────────────────────────────────────────────────────

export interface CreateProjectOpts {
  /** Optional ID. If not provided, a random ID is generated. */
  id?: string;
  name: string;
  description?: string;
  ownerId: string;
  type?: ProjectType;
  visibility?: ProjectVisibility;
  budgetLimit?: number;
  threadId?: string;
  managerAgentId?: string;
  /** Phase 70: Deployment tier (1 = S3 static, 2 = EC2 compute). */
  tier?: 1 | 2;
}

export interface ListProjectsOpts {
  type?: ProjectType;
  visibility?: ProjectVisibility;
  status?: ProjectStatus;
  limit?: number;
  offset?: number;
}

export interface ProjectStats {
  totalProjects: number;
  activeProjects: number;
  publicProjects: number;
  totalCollaborators: number;
}

// ── ProjectStore Class ───────────────────────────────────────────────────────

export class ProjectStore {
  private db: Database.Database;
  private backend: StorageBackend;
  // Phase 63: Write-through callback to P2P ProjectRegistry
  private broadcastToP2P: ((action: 'register' | 'update' | 'archive', project: any) => void) | null = null;

  constructor(db: Database.Database, storageBackend: StorageBackend) {
    if (!storageBackend) {
      throw new Error('[project-store] StorageBackend is required — cannot initialize without a backend');
    }
    this.db = db;
    this.backend = storageBackend;
  }

  /** Phase 63: Set callback to broadcast project changes to P2P ProjectRegistry. */
  setBroadcastCallback(cb: (action: 'register' | 'update' | 'archive', project: any) => void): void {
    this.broadcastToP2P = cb;
  }

  /**
   * Create tables and indexes. Call once after construction.
   */
  init(): void {
    this.db.exec(SCHEMA);

    // Migration: add category column to projects table (Phase 31.8)
    try {
      const cols = this.db.prepare("PRAGMA table_info(projects)").all() as any[];
      const hasCategory = cols.some((c: any) => c.name === 'category');
      if (!hasCategory) {
        this.db.exec("ALTER TABLE projects ADD COLUMN category TEXT DEFAULT ''");
        console.log('[project-store] Migration: added category column to projects');
      }

      // Migration: add repo_url column (Phase 46)
      const hasRepoUrl = cols.some((c: any) => c.name === 'repo_url');
      if (!hasRepoUrl) {
        this.db.exec("ALTER TABLE projects ADD COLUMN repo_url TEXT DEFAULT ''");
        console.log('[project-store] Migration: added repo_url column to projects');
      }

      // Migration: add team_history column (Phase 46)
      const hasTeamHistory = cols.some((c: any) => c.name === 'team_history');
      if (!hasTeamHistory) {
        this.db.exec("ALTER TABLE projects ADD COLUMN team_history TEXT DEFAULT ''");
        console.log('[project-store] Migration: added team_history column to projects');
      }

      // Migration: add notes column (Phase 46)
      const hasNotes = cols.some((c: any) => c.name === 'notes');
      if (!hasNotes) {
        this.db.exec("ALTER TABLE projects ADD COLUMN notes TEXT DEFAULT ''");
        console.log('[project-store] Migration: added notes column to projects');
      }

      // Migration: add resources column (Phase 53)
      const hasResources = cols.some((c: any) => c.name === 'resources');
      if (!hasResources) {
        this.db.exec("ALTER TABLE projects ADD COLUMN resources TEXT DEFAULT '[]'");
        console.log('[project-store] Migration: added resources column to projects');
      }

      // Migration: add api_key column (Phase 53)
      const hasApiKey = cols.some((c: any) => c.name === 'api_key');
      if (!hasApiKey) {
        this.db.exec("ALTER TABLE projects ADD COLUMN api_key TEXT");
        console.log('[project-store] Migration: added api_key column to projects');
      }

      // Migration: add workspace_dir column (Phase 104)
      const hasWorkspaceDir = cols.some((c: any) => c.name === 'workspace_dir');
      if (!hasWorkspaceDir) {
        this.db.exec("ALTER TABLE projects ADD COLUMN workspace_dir TEXT DEFAULT ''");
        console.log('[project-store] Migration: added workspace_dir column to projects');
      }
    } catch {
      // Column may already exist
    }
  }

  /**
   * Hydrate SQLite cache from MongoDB backend.
   * Loads all projects, collaborators, invites, transfers, deployments, ratings, and reports.
   */
  async loadFromBackend(): Promise<void> {
    console.log('[project-store] Loading data from MongoDB backend...');

    // Load projects
    const projects = await this.backend.listRecords('projects');
    for (const r of projects) {
      const p = this.recordToProject(r);
      this.db.prepare(`
        INSERT OR REPLACE INTO projects (id, name, description, owner_id, type, visibility, revenue_model, revenue_config, budget_spent, budget_limit, thread_id, manager_agent_id, deployment_url, deployment_type, deployment_status, status, created_at, updated_at, category, repo_url, team_history, notes, resources, api_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        p.id, p.name, p.description, p.ownerId, p.type, p.visibility,
        p.revenueModel, JSON.stringify(p.revenueConfig), p.budgetSpent, p.budgetLimit,
        p.threadId, p.managerAgentId, p.deploymentUrl, p.deploymentType,
        p.deploymentStatus, p.status, p.createdAt, p.updatedAt,
        (p as any).category || '', p.repoUrl || '', p.teamHistory || '', p.notes || '',
        JSON.stringify(p.resources || []), p.apiKey || null,
      );
    }
    console.log(`[project-store] Loaded ${projects.length} projects from backend`);

    // Load collaborators
    const collaborators = await this.backend.listRecords('project_collaborators');
    for (const r of collaborators) {
      const c = this.recordToCollaborator(r);
      this.db.prepare(`
        INSERT OR REPLACE INTO project_collaborators (project_id, user_id, role, added_at, added_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(c.projectId, c.userId, c.role, c.addedAt, c.addedBy);
    }
    console.log(`[project-store] Loaded ${collaborators.length} collaborators from backend`);

    // Load invites
    const invites = await this.backend.listRecords('project_invites');
    for (const r of invites) {
      const inv = this.recordToInvite(r);
      this.db.prepare(`
        INSERT OR REPLACE INTO project_invites (id, project_id, code, role, created_by, expires_at, max_uses, used_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(inv.id, inv.projectId, inv.code, inv.role, inv.createdBy, inv.expiresAt, inv.maxUses, inv.usedCount);
    }
    console.log(`[project-store] Loaded ${invites.length} invites from backend`);

    // Load transfers
    const transfers = await this.backend.listRecords('project_transfers');
    for (const r of transfers) {
      const t = this.recordToTransfer(r);
      this.db.prepare(`
        INSERT OR REPLACE INTO project_transfers (id, project_id, from_user, to_user, transfer_type, sale_price, escrow_hold_id, status, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(t.id, t.projectId, t.fromUser, t.toUser, t.transferType, t.salePrice, t.escrowHoldId, t.status, t.createdAt, t.completedAt);
    }
    console.log(`[project-store] Loaded ${transfers.length} transfers from backend`);

    // Load deployments
    const deployments = await this.backend.listRecords('project_deployments');
    for (const r of deployments) {
      const d = this.recordToDeployment(r);
      this.db.prepare(`
        INSERT OR REPLACE INTO project_deployments (id, project_id, deploy_type, deploy_url, deploy_config, status, deployed_by, deployed_at, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(d.id, d.projectId, d.deployType, d.deployUrl, JSON.stringify(d.deployConfig), d.status, d.deployedBy, d.deployedAt, d.errorMessage);
    }
    console.log(`[project-store] Loaded ${deployments.length} deployments from backend`);

    // Load ratings
    const ratings = await this.backend.listRecords('project_ratings');
    for (const r of ratings) {
      const rt = this.recordToRating(r);
      this.db.prepare(`
        INSERT OR REPLACE INTO project_ratings (project_id, user_id, rating, review, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(rt.projectId, rt.userId, rt.rating, rt.review, rt.createdAt);
    }
    console.log(`[project-store] Loaded ${ratings.length} ratings from backend`);

    // Load reports
    const reports = await this.backend.listRecords('content_reports');
    for (const r of reports) {
      const rpt = this.recordToReport(r);
      this.db.prepare(`
        INSERT OR REPLACE INTO content_reports (id, project_id, reporter_id, reason, description, status, ai_review, ai_safety_score, reviewed_by, resolved_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(rpt.id, rpt.projectId, rpt.reporterId, rpt.reason, rpt.description, rpt.status, rpt.aiReview, rpt.aiSafetyScore, rpt.reviewedBy, rpt.resolvedAt, rpt.createdAt);
    }
    console.log(`[project-store] Loaded ${reports.length} reports from backend`);

    console.log('[project-store] Backend hydration complete');
  }

  // ── Create ──────────────────────────────────────────────────────────────

  /**
   * Create a new project. Automatically adds the owner as a collaborator
   * with the 'owner' role.
   */
  async createProject(opts: CreateProjectOpts): Promise<Project> {
    const id = opts.id || this.generateId();
    const now = Date.now();
    const project: Project = {
      id,
      name: opts.name,
      description: opts.description || '',
      ownerId: opts.ownerId,
      type: opts.type || 'private',
      visibility: opts.visibility || 'owner_only',
      revenueModel: 'none',
      revenueConfig: {},
      budgetSpent: 0,
      budgetLimit: opts.budgetLimit || 0,
      threadId: opts.threadId || '',
      managerAgentId: opts.managerAgentId || '',
      deploymentUrl: '',
      deploymentType: '',
      deploymentStatus: 'none',
      status: 'active',
      tier: opts.tier,
      createdAt: now,
      updatedAt: now,
    };

    // MongoDB FIRST — must succeed
    await this.backend.putRecord('projects', project.id, this.projectToRecord(project));
    await this.backend.putRecord('project_collaborators', `${id}:${opts.ownerId}`, {
      projectId: id,
      userId: opts.ownerId,
      role: 'owner',
      addedAt: now,
      addedBy: opts.ownerId,
    });

    // Then SQLite cache
    this.db.prepare(`
      INSERT INTO projects (id, name, description, owner_id, type, visibility, revenue_model, revenue_config, budget_spent, budget_limit, thread_id, manager_agent_id, deployment_url, deployment_type, deployment_status, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id, project.name, project.description, project.ownerId,
      project.type, project.visibility, project.revenueModel,
      JSON.stringify(project.revenueConfig), project.budgetSpent, project.budgetLimit,
      project.threadId, project.managerAgentId, project.deploymentUrl,
      project.deploymentType, project.deploymentStatus, project.status,
      project.createdAt, project.updatedAt,
    );

    // Add owner as collaborator in SQLite cache
    this.db.prepare(`
      INSERT OR IGNORE INTO project_collaborators (project_id, user_id, role, added_at, added_by)
      VALUES (?, ?, 'owner', ?, ?)
    `).run(id, opts.ownerId, now, opts.ownerId);

    console.log(`[project-store] Created project: ${project.name} (${id}) by ${opts.ownerId}`);

    // Phase 63: Broadcast to P2P Project Registry
    if (this.broadcastToP2P && project.apiKey) {
      try { this.broadcastToP2P('register', project); } catch { /* ignore */ }
    }

    return project;
  }

  // ── Read ────────────────────────────────────────────────────────────────

  /**
   * Get a project by ID.
   */
  getProject(projectId: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
    return row ? this.rowToProject(row) : null;
  }

  /**
   * Get a project by ID (async — prefers MongoDB when available).
   */
  async getProjectAsync(projectId: string): Promise<Project | null> {
    if (this.backend) {
      const record = await this.backend.getRecord('projects', projectId);
      return record ? this.recordToProject(record) : null;
    }
    return this.getProject(projectId);
  }

  /**
   * Get all projects owned by a user.
   */
  getProjectsByOwner(userId: string): Project[] {
    const rows = this.db.prepare(
      'SELECT * FROM projects WHERE owner_id = ? AND status != ? ORDER BY updated_at DESC'
    ).all(userId, 'archived') as any[];
    return rows.map(r => this.rowToProject(r));
  }

  /**
   * Get a project by its linked thread ID.
   */
  getProjectByThreadId(threadId: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE thread_id = ?').get(threadId) as any;
    return row ? this.rowToProject(row) : null;
  }

  /**
   * Get all projects owned by a user (async — prefers MongoDB).
   */
  async getProjectsByOwnerAsync(userId: string): Promise<Project[]> {
    if (this.backend) {
      const records = await this.backend.queryRecords('projects', { ownerId: userId }, { sort: { updatedAt: -1 } });
      return records
        .map(r => this.recordToProject(r))
        .filter(p => p.status !== 'archived');
    }
    return this.getProjectsByOwner(userId);
  }

  /**
   * Get all projects where a user is a collaborator (not owner).
   */
  getProjectsByCollaborator(userId: string): Project[] {
    const rows = this.db.prepare(`
      SELECT p.* FROM projects p
      INNER JOIN project_collaborators pc ON p.id = pc.project_id
      WHERE pc.user_id = ? AND pc.role != 'owner' AND p.status != ?
      ORDER BY p.updated_at DESC
    `).all(userId, 'archived') as any[];
    return rows.map(r => this.rowToProject(r));
  }

  /**
   * Get all projects where a user is a collaborator (async — prefers MongoDB).
   */
  async getProjectsByCollaboratorAsync(userId: string): Promise<Project[]> {
    if (this.backend) {
      const collabRecords = await this.backend.queryRecords('project_collaborators', { userId });
      const nonOwnerCollabs = collabRecords.filter(c => c.role !== 'owner');
      const projects: Project[] = [];
      for (const collab of nonOwnerCollabs) {
        const record = await this.backend.getRecord('projects', collab.projectId);
        if (record) {
          const project = this.recordToProject(record);
          if (project.status !== 'archived') {
            projects.push(project);
          }
        }
      }
      return projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
    return this.getProjectsByCollaborator(userId);
  }

  /**
   * List projects with optional filters.
   */
  listProjects(opts?: ListProjectsOpts): Project[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts?.type) {
      conditions.push('type = ?');
      params.push(opts.type);
    }
    if (opts?.visibility) {
      conditions.push('visibility = ?');
      params.push(opts.visibility);
    }
    if (opts?.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit || 100;
    const offset = opts?.offset || 0;

    const rows = this.db.prepare(
      `SELECT * FROM projects ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];
    return rows.map(r => this.rowToProject(r));
  }

  /**
   * List projects with optional filters (async — prefers MongoDB).
   */
  async listProjectsAsync(opts?: ListProjectsOpts): Promise<Project[]> {
    if (this.backend) {
      const filter: Record<string, any> = {};
      if (opts?.type) filter.type = opts.type;
      if (opts?.visibility) filter.visibility = opts.visibility;
      if (opts?.status) filter.status = opts.status;

      const records = await this.backend.queryRecords('projects', filter, {
        limit: opts?.limit || 100,
        sort: { updatedAt: -1 },
      });
      // Handle offset client-side since StorageBackend doesn't support offset
      const offset = opts?.offset || 0;
      return records.slice(offset).map(r => this.recordToProject(r));
    }
    return this.listProjects(opts);
  }

  // ── Update ──────────────────────────────────────────────────────────────

  /**
   * Update project fields. Only the provided fields are updated.
   */
  async updateProject(projectId: string, updates: Partial<Project>): Promise<Project | null> {
    const existing = this.getProject(projectId);
    if (!existing) return null;

    const fields: string[] = [];
    const params: any[] = [];

    if (updates.name !== undefined) { fields.push('name = ?'); params.push(updates.name); }
    if (updates.description !== undefined) { fields.push('description = ?'); params.push(updates.description); }
    if (updates.type !== undefined) { fields.push('type = ?'); params.push(updates.type); }
    if (updates.visibility !== undefined) { fields.push('visibility = ?'); params.push(updates.visibility); }
    if (updates.revenueModel !== undefined) { fields.push('revenue_model = ?'); params.push(updates.revenueModel); }
    if (updates.revenueConfig !== undefined) { fields.push('revenue_config = ?'); params.push(JSON.stringify(updates.revenueConfig)); }
    if (updates.budgetLimit !== undefined) { fields.push('budget_limit = ?'); params.push(updates.budgetLimit); }
    if (updates.deploymentUrl !== undefined) { fields.push('deployment_url = ?'); params.push(updates.deploymentUrl); }
    if (updates.deploymentType !== undefined) { fields.push('deployment_type = ?'); params.push(updates.deploymentType); }
    if (updates.deploymentStatus !== undefined) { fields.push('deployment_status = ?'); params.push(updates.deploymentStatus); }
    if (updates.status !== undefined) { fields.push('status = ?'); params.push(updates.status); }
    if (updates.repoUrl !== undefined) { fields.push('repo_url = ?'); params.push(updates.repoUrl); }
    if (updates.teamHistory !== undefined) { fields.push('team_history = ?'); params.push(updates.teamHistory); }
    if (updates.notes !== undefined) { fields.push('notes = ?'); params.push(updates.notes); }
    if (updates.resources !== undefined) { fields.push('resources = ?'); params.push(JSON.stringify(updates.resources)); }
    if (updates.apiKey !== undefined) { fields.push('api_key = ?'); params.push(updates.apiKey); }
    if (updates.workspaceDir !== undefined) { fields.push('workspace_dir = ?'); params.push(updates.workspaceDir); }

    if (fields.length === 0) return existing;

    fields.push('updated_at = ?');
    params.push(Date.now());
    params.push(projectId);

    // SQLite first (to get the merged result), then MongoDB
    this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    const updated = this.getProject(projectId);

    // MongoDB: persist with merge to preserve MongoDB-only fields
    if (updated) {
      await this.persistProjectToMongo(projectId, updated, updates as Record<string, any>);
    }

    // Phase 63: Broadcast update to P2P
    if (this.broadcastToP2P && updated) {
      try { this.broadcastToP2P('update', updated); } catch { /* ignore */ }
    }

    return updated;
  }

  /**
   * Soft-delete a project by setting status to 'archived'.
   */
  async deleteProject(projectId: string): Promise<boolean> {
    const now = Date.now();
    const result = this.db.prepare(
      'UPDATE projects SET status = ?, updated_at = ? WHERE id = ?'
    ).run('archived', now, projectId);
    if (result.changes > 0) {
      console.log(`[project-store] Archived project: ${projectId}`);

      // MongoDB — write archived state (merge to preserve MongoDB-only fields)
      const archived = this.getProject(projectId);
      if (archived) {
        await this.persistProjectToMongo(projectId, archived);
      }

      // Phase 63: Broadcast archive to P2P
      if (this.broadcastToP2P && archived) {
        try { this.broadcastToP2P('archive', archived); } catch { /* ignore */ }
      }
    }
    return result.changes > 0;
  }

  // ── Collaborators ───────────────────────────────────────────────────────

  /**
   * Add a collaborator to a project.
   */
  async addCollaborator(projectId: string, userId: string, role: ProjectRole, addedBy: string): Promise<void> {
    const now = Date.now();

    // MongoDB FIRST
    await this.backend.putRecord('project_collaborators', `${projectId}:${userId}`, {
      projectId,
      userId,
      role,
      addedAt: now,
      addedBy,
    });

    // Then SQLite cache
    this.db.prepare(`
      INSERT OR REPLACE INTO project_collaborators (project_id, user_id, role, added_at, added_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(projectId, userId, role, now, addedBy);

    // Touch the project updated_at
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
    const updated = this.getProject(projectId);
    if (updated) {
      await this.persistProjectToMongo(projectId, updated);
    }

    console.log(`[project-store] Added collaborator ${userId} (${role}) to project ${projectId}`);
  }

  /**
   * Remove a collaborator from a project.
   */
  async removeCollaborator(projectId: string, userId: string): Promise<void> {
    // MongoDB FIRST
    await this.backend.deleteRecord('project_collaborators', `${projectId}:${userId}`);

    // Then SQLite cache
    this.db.prepare(
      'DELETE FROM project_collaborators WHERE project_id = ? AND user_id = ?'
    ).run(projectId, userId);

    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(Date.now(), projectId);
    const updated = this.getProject(projectId);
    if (updated) {
      await this.persistProjectToMongo(projectId, updated);
    }

    console.log(`[project-store] Removed collaborator ${userId} from project ${projectId}`);
  }

  /**
   * Get all collaborators for a project.
   */
  getCollaborators(projectId: string): ProjectCollaborator[] {
    const rows = this.db.prepare(
      'SELECT * FROM project_collaborators WHERE project_id = ? ORDER BY added_at ASC'
    ).all(projectId) as any[];
    return rows.map(r => this.rowToCollaborator(r));
  }

  /**
   * Get all collaborators for a project (async — prefers MongoDB).
   */
  async getCollaboratorsAsync(projectId: string): Promise<ProjectCollaborator[]> {
    if (this.backend) {
      const records = await this.backend.queryRecords('project_collaborators', { projectId });
      return records.map(r => this.recordToCollaborator(r));
    }
    return this.getCollaborators(projectId);
  }

  /**
   * Get a user's role in a project. Returns null if no role.
   */
  getUserRole(projectId: string, userId: string): ProjectRole | null {
    const row = this.db.prepare(
      'SELECT role FROM project_collaborators WHERE project_id = ? AND user_id = ?'
    ).get(projectId, userId) as any;
    return row ? row.role as ProjectRole : null;
  }

  /**
   * Get a user's role in a project (async — prefers MongoDB).
   */
  async getUserRoleAsync(projectId: string, userId: string): Promise<ProjectRole | null> {
    if (this.backend) {
      const record = await this.backend.getRecord('project_collaborators', `${projectId}:${userId}`);
      return record ? record.role as ProjectRole : null;
    }
    return this.getUserRole(projectId, userId);
  }

  /**
   * Check if a user has access to a project.
   * Access is granted if the user is the owner, a collaborator, or the project is public.
   */
  hasAccess(projectId: string, userId: string): boolean {
    // Check collaborator table
    const role = this.getUserRole(projectId, userId);
    if (role) return true;

    // Check if project is public
    const project = this.getProject(projectId);
    if (!project) return false;
    return project.type === 'public';
  }

  /**
   * Check if a user has access to a project (async — prefers MongoDB).
   */
  async hasAccessAsync(projectId: string, userId: string): Promise<boolean> {
    const role = await this.getUserRoleAsync(projectId, userId);
    if (role) return true;

    const project = await this.getProjectAsync(projectId);
    if (!project) return false;
    return project.type === 'public';
  }

  /**
   * Transfer project ownership to a new owner.
   * The old owner is demoted to admin (or a custom role).
   */
  async transferOwnership(projectId: string, newOwnerId: string, oldOwnerRole: ProjectRole = 'admin'): Promise<void> {
    const project = this.getProject(projectId);
    if (!project) return;

    const now = Date.now();
    const oldOwnerId = project.ownerId;

    // MongoDB FIRST
    await this.backend.putRecord('project_collaborators', `${projectId}:${oldOwnerId}`, {
      projectId,
      userId: oldOwnerId,
      role: oldOwnerRole,
      addedAt: now,
      addedBy: oldOwnerId,
    });
    await this.backend.putRecord('project_collaborators', `${projectId}:${newOwnerId}`, {
      projectId,
      userId: newOwnerId,
      role: 'owner',
      addedAt: now,
      addedBy: oldOwnerId,
    });

    // Then SQLite cache
    this.db.prepare(
      'UPDATE projects SET owner_id = ?, updated_at = ? WHERE id = ?'
    ).run(newOwnerId, now, projectId);

    this.db.prepare(
      'UPDATE project_collaborators SET role = ? WHERE project_id = ? AND user_id = ?'
    ).run(oldOwnerRole, projectId, oldOwnerId);

    this.db.prepare(`
      INSERT OR REPLACE INTO project_collaborators (project_id, user_id, role, added_at, added_by)
      VALUES (?, ?, 'owner', ?, ?)
    `).run(projectId, newOwnerId, now, oldOwnerId);

    // Write updated project to MongoDB
    const updated = this.getProject(projectId);
    if (updated) {
      await this.persistProjectToMongo(projectId, updated);
    }

    console.log(`[project-store] Transferred project ${projectId} from ${oldOwnerId} to ${newOwnerId}`);
  }

  // ── Stats ───────────────────────────────────────────────────────────────

  /**
   * Get aggregate project statistics.
   */
  getStats(): ProjectStats {
    const totalProjects = (this.db.prepare(
      'SELECT COUNT(*) as cnt FROM projects'
    ).get() as any)?.cnt || 0;

    const activeProjects = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM projects WHERE status = 'active'"
    ).get() as any)?.cnt || 0;

    const publicProjects = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM projects WHERE type = 'public' AND status = 'active'"
    ).get() as any)?.cnt || 0;

    const totalCollaborators = (this.db.prepare(
      'SELECT COUNT(*) as cnt FROM project_collaborators'
    ).get() as any)?.cnt || 0;

    return { totalProjects, activeProjects, publicProjects, totalCollaborators };
  }

  /**
   * Get aggregate project statistics (async — prefers MongoDB).
   */
  async getStatsAsync(): Promise<ProjectStats> {
    if (this.backend) {
      const allProjects = await this.backend.listRecords('projects');
      const totalProjects = allProjects.length;
      const activeProjects = allProjects.filter(p => p.status === 'active').length;
      const publicProjects = allProjects.filter(p => p.type === 'public' && p.status === 'active').length;
      const allCollaborators = await this.backend.listRecords('project_collaborators');
      const totalCollaborators = allCollaborators.length;
      return { totalProjects, activeProjects, publicProjects, totalCollaborators };
    }
    return this.getStats();
  }

  // ── Budget ──────────────────────────────────────────────────────────────

  /**
   * Increment the budget spent for a project.
   */
  async updateBudgetSpent(projectId: string, amount: number): Promise<void> {
    // SQLite first (for atomic increment), then sync to MongoDB
    this.db.prepare(
      'UPDATE projects SET budget_spent = budget_spent + ?, updated_at = ? WHERE id = ?'
    ).run(amount, Date.now(), projectId);

    const updated = this.getProject(projectId);
    if (updated) {
      await this.persistProjectToMongo(projectId, updated);
    }
  }

  // ── Linking ─────────────────────────────────────────────────────────────

  /**
   * Link a chat thread to a project.
   */
  async linkThread(projectId: string, threadId: string): Promise<void> {
    this.db.prepare(
      'UPDATE projects SET thread_id = ?, updated_at = ? WHERE id = ?'
    ).run(threadId, Date.now(), projectId);

    const updated = this.getProject(projectId);
    if (updated) {
      await this.persistProjectToMongo(projectId, updated);
    }
  }

  /**
   * Link a manager agent to a project.
   */
  async linkManagerAgent(projectId: string, agentId: string): Promise<void> {
    this.db.prepare(
      'UPDATE projects SET manager_agent_id = ?, updated_at = ? WHERE id = ?'
    ).run(agentId, Date.now(), projectId);

    const updated = this.getProject(projectId);
    if (updated) {
      await this.persistProjectToMongo(projectId, updated);
    }
  }

  // ── Invites (Phase 31.5) ────────────────────────────────────────────────

  /**
   * Create an invite code for a project.
   */
  async createInvite(
    projectId: string,
    role: ProjectRole,
    createdBy: string,
    opts?: { expiresInHours?: number; maxUses?: number },
  ): Promise<ProjectInvite> {
    const id = this.generateId();
    const code = randomBytes(6).toString('hex'); // 12-char invite code
    const expiresInHours = opts?.expiresInHours || 72; // default 3 days
    const maxUses = opts?.maxUses || 0; // 0 = unlimited
    const expiresAt = Date.now() + expiresInHours * 60 * 60 * 1000;

    const invite: ProjectInvite = { id, projectId, code, role, createdBy, expiresAt, maxUses, usedCount: 0 };

    // MongoDB FIRST
    await this.backend.putRecord('project_invites', id, {
      projectId,
      code,
      role,
      createdBy,
      expiresAt,
      maxUses,
      usedCount: 0,
    });

    // Then SQLite cache
    this.db.prepare(`
      INSERT INTO project_invites (id, project_id, code, role, created_by, expires_at, max_uses, used_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(id, projectId, code, role, createdBy, expiresAt, maxUses);

    console.log(`[project-store] Created invite ${code} for project ${projectId} (role=${role})`);
    return invite;
  }

  /**
   * Use an invite code to join a project.
   * Validates the code, adds the user as a collaborator, and increments used_count.
   */
  async useInvite(code: string, userId: string): Promise<InviteUseResult> {
    const row = this.db.prepare(
      'SELECT * FROM project_invites WHERE code = ?'
    ).get(code) as any;

    if (!row) {
      return { success: false, error: 'Invalid invite code' };
    }

    const now = Date.now();

    // Check expiration
    if (row.expires_at < now) {
      return { success: false, error: 'Invite code has expired' };
    }

    // Check max uses
    if (row.max_uses > 0 && row.used_count >= row.max_uses) {
      return { success: false, error: 'Invite code has reached maximum uses' };
    }

    // Check if user is already a collaborator
    const existing = this.getUserRole(row.project_id, userId);
    if (existing) {
      return { success: false, error: 'Already a collaborator on this project' };
    }

    // Add as collaborator (now async — handles its own MongoDB write)
    await this.addCollaborator(row.project_id, userId, row.role as ProjectRole, row.created_by);

    // MongoDB FIRST — update invite with new count
    await this.backend.putRecord('project_invites', row.id, {
      projectId: row.project_id,
      code: row.code,
      role: row.role,
      createdBy: row.created_by,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      usedCount: row.used_count + 1,
    });

    // Then SQLite cache
    this.db.prepare(
      'UPDATE project_invites SET used_count = used_count + 1 WHERE id = ?'
    ).run(row.id);

    console.log(`[project-store] User ${userId} joined project ${row.project_id} via invite ${code}`);

    return { success: true, projectId: row.project_id, role: row.role as ProjectRole };
  }

  /**
   * Get active invites for a project.
   */
  getProjectInvites(projectId: string): ProjectInvite[] {
    const now = Date.now();
    const rows = this.db.prepare(
      'SELECT * FROM project_invites WHERE project_id = ? AND expires_at > ? ORDER BY expires_at DESC'
    ).all(projectId, now) as any[];

    return rows.map(r => this.rowToInvite(r));
  }

  /**
   * Get active invites for a project (async — prefers MongoDB).
   */
  async getProjectInvitesAsync(projectId: string): Promise<ProjectInvite[]> {
    if (this.backend) {
      const records = await this.backend.queryRecords('project_invites', { projectId });
      const now = Date.now();
      return records
        .map(r => this.recordToInvite(r))
        .filter(inv => inv.expiresAt > now)
        .sort((a, b) => b.expiresAt - a.expiresAt);
    }
    return this.getProjectInvites(projectId);
  }

  /**
   * Revoke an invite by ID.
   */
  async revokeInvite(inviteId: string): Promise<boolean> {
    const row = this.db.prepare('SELECT * FROM project_invites WHERE id = ?').get(inviteId) as any;
    if (!row) return false;

    // MongoDB FIRST
    await this.backend.putRecord('project_invites', inviteId, {
      projectId: row.project_id,
      code: row.code,
      role: row.role,
      createdBy: row.created_by,
      expiresAt: 0,
      maxUses: row.max_uses,
      usedCount: row.used_count,
    });

    // Then SQLite cache — set expires_at to 0 to effectively revoke
    const result = this.db.prepare(
      'UPDATE project_invites SET expires_at = 0 WHERE id = ?'
    ).run(inviteId);

    if (result.changes > 0) {
      console.log(`[project-store] Revoked invite ${inviteId}`);
    }
    return result.changes > 0;
  }

  // ── Transfers (Phase 31.6) ────────────────────────────────────────────

  /**
   * Initiate a project ownership transfer.
   */
  async initiateTransfer(
    projectId: string,
    fromUser: string,
    toUser: string,
    transferType: TransferType,
    salePrice?: number,
    escrowHoldId?: string,
  ): Promise<ProjectTransfer> {
    const id = this.generateId();
    const now = Date.now();
    const price = salePrice || 0;
    const holdId = escrowHoldId || '';

    const transfer: ProjectTransfer = {
      id,
      projectId,
      fromUser,
      toUser,
      transferType,
      salePrice: price,
      escrowHoldId: holdId,
      status: 'pending',
      createdAt: now,
      completedAt: 0,
    };

    // MongoDB FIRST
    await this.backend.putRecord('project_transfers', id, {
      projectId,
      fromUser,
      toUser,
      transferType,
      salePrice: price,
      escrowHoldId: holdId,
      status: 'pending',
      createdAt: now,
      completedAt: 0,
    });

    // Then SQLite cache
    this.db.prepare(`
      INSERT INTO project_transfers (id, project_id, from_user, to_user, transfer_type, sale_price, escrow_hold_id, status, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0)
    `).run(id, projectId, fromUser, toUser, transferType, price, holdId, now);

    console.log(`[project-store] Transfer initiated: ${projectId} from ${fromUser} to ${toUser} (${transferType})`);
    return transfer;
  }

  /**
   * Complete a pending transfer — executes the ownership change.
   */
  async completeTransfer(transferId: string): Promise<ProjectTransfer | null> {
    const row = this.db.prepare(
      'SELECT * FROM project_transfers WHERE id = ?'
    ).get(transferId) as any;

    if (!row || row.status !== 'pending') return null;

    const now = Date.now();

    // Execute the ownership transfer (now async — handles its own MongoDB writes)
    await this.transferOwnership(row.project_id, row.to_user, 'admin');

    // MongoDB FIRST — update transfer status
    await this.backend.putRecord('project_transfers', transferId, {
      projectId: row.project_id,
      fromUser: row.from_user,
      toUser: row.to_user,
      transferType: row.transfer_type,
      salePrice: row.sale_price || 0,
      escrowHoldId: row.escrow_hold_id || '',
      status: 'completed',
      createdAt: row.created_at,
      completedAt: now,
    });

    // Then SQLite cache
    this.db.prepare(
      'UPDATE project_transfers SET status = ?, completed_at = ? WHERE id = ?'
    ).run('completed', now, transferId);

    this.db.prepare(
      'UPDATE projects SET status = ?, updated_at = ? WHERE id = ?'
    ).run('active', now, row.project_id);

    // Sync project to MongoDB
    const updatedProject = this.getProject(row.project_id);
    if (updatedProject) {
      await this.persistProjectToMongo(row.project_id, updatedProject);
    }

    console.log(`[project-store] Transfer completed: ${row.project_id} -> ${row.to_user}`);
    return this.rowToTransfer({ ...row, status: 'completed', completed_at: now });
  }

  /**
   * Cancel a pending transfer.
   */
  async cancelTransfer(transferId: string): Promise<ProjectTransfer | null> {
    const row = this.db.prepare(
      'SELECT * FROM project_transfers WHERE id = ?'
    ).get(transferId) as any;

    if (!row || row.status !== 'pending') return null;

    const now = Date.now();

    // MongoDB FIRST
    await this.backend.putRecord('project_transfers', transferId, {
      projectId: row.project_id,
      fromUser: row.from_user,
      toUser: row.to_user,
      transferType: row.transfer_type,
      salePrice: row.sale_price || 0,
      escrowHoldId: row.escrow_hold_id || '',
      status: 'cancelled',
      createdAt: row.created_at,
      completedAt: now,
    });

    // Then SQLite cache
    this.db.prepare(
      'UPDATE project_transfers SET status = ?, completed_at = ? WHERE id = ?'
    ).run('cancelled', now, transferId);

    console.log(`[project-store] Transfer cancelled: ${transferId}`);
    return this.rowToTransfer({ ...row, status: 'cancelled', completed_at: now });
  }

  /**
   * Get a transfer record by ID.
   */
  getTransfer(transferId: string): ProjectTransfer | null {
    const row = this.db.prepare(
      'SELECT * FROM project_transfers WHERE id = ?'
    ).get(transferId) as any;
    return row ? this.rowToTransfer(row) : null;
  }

  /**
   * Get a transfer record by ID (async — prefers MongoDB).
   */
  async getTransferAsync(transferId: string): Promise<ProjectTransfer | null> {
    if (this.backend) {
      const record = await this.backend.getRecord('project_transfers', transferId);
      return record ? this.recordToTransfer(record) : null;
    }
    return this.getTransfer(transferId);
  }

  /**
   * Get transfer history for a project.
   */
  getProjectTransfers(projectId: string): ProjectTransfer[] {
    const rows = this.db.prepare(
      'SELECT * FROM project_transfers WHERE project_id = ? ORDER BY created_at DESC'
    ).all(projectId) as any[];
    return rows.map(r => this.rowToTransfer(r));
  }

  /**
   * Get transfer history for a project (async — prefers MongoDB).
   */
  async getProjectTransfersAsync(projectId: string): Promise<ProjectTransfer[]> {
    if (this.backend) {
      const records = await this.backend.queryRecords('project_transfers', { projectId }, { sort: { createdAt: -1 } });
      return records.map(r => this.recordToTransfer(r));
    }
    return this.getProjectTransfers(projectId);
  }

  // ── Deployments (Phase 31.7) ──────────────────────────────────────────

  /**
   * Create a new deployment record for a project.
   */
  async createDeployment(
    projectId: string,
    deployType: DeployType,
    config: Record<string, any>,
    deployedBy: string,
  ): Promise<ProjectDeployment> {
    const id = this.generateId();
    const now = Date.now();

    const deployment: ProjectDeployment = {
      id,
      projectId,
      deployType,
      deployUrl: '',
      deployConfig: config,
      status: 'pending',
      deployedBy,
      deployedAt: now,
      errorMessage: '',
    };

    // MongoDB FIRST
    await this.backend.putRecord('project_deployments', id, {
      projectId,
      deployType,
      deployUrl: '',
      deployConfig: config,
      status: 'pending',
      deployedBy,
      deployedAt: now,
      errorMessage: '',
    });

    // Then SQLite cache
    this.db.prepare(`
      INSERT INTO project_deployments (id, project_id, deploy_type, deploy_url, deploy_config, status, deployed_by, deployed_at, error_message)
      VALUES (?, ?, ?, '', ?, 'pending', ?, ?, '')
    `).run(id, projectId, deployType, JSON.stringify(config), deployedBy, now);

    // Touch the project updated_at
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);
    const updatedProject = this.getProject(projectId);
    if (updatedProject) {
      await this.persistProjectToMongo(projectId, updatedProject);
    }

    console.log(`[project-store] Deployment created: ${id} (${deployType}) for project ${projectId}`);
    return deployment;
  }

  /**
   * Update a deployment's status, optionally setting url or error message.
   * When status is 'live', also updates the project record's deployment fields.
   */
  async updateDeploymentStatus(
    deploymentId: string,
    status: DeploymentStatus,
    url?: string,
    error?: string,
  ): Promise<void> {
    const fields: string[] = ['status = ?'];
    const params: any[] = [status];

    if (url !== undefined) {
      fields.push('deploy_url = ?');
      params.push(url);
    }
    if (error !== undefined) {
      fields.push('error_message = ?');
      params.push(error);
    }

    params.push(deploymentId);
    this.db.prepare(`UPDATE project_deployments SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    // If deployment succeeded, update the project record
    if (status === 'live') {
      const deploy = this.db.prepare('SELECT * FROM project_deployments WHERE id = ?').get(deploymentId) as any;
      if (deploy) {
        const now = Date.now();
        this.db.prepare(
          'UPDATE projects SET deployment_url = ?, deployment_type = ?, deployment_status = ?, updated_at = ? WHERE id = ?'
        ).run(url || deploy.deploy_url || '', deploy.deploy_type, 'live', now, deploy.project_id);
      }
    } else if (status === 'failed' || status === 'rolled_back') {
      const deploy = this.db.prepare('SELECT * FROM project_deployments WHERE id = ?').get(deploymentId) as any;
      if (deploy) {
        const now = Date.now();
        this.db.prepare(
          'UPDATE projects SET deployment_status = ?, updated_at = ? WHERE id = ?'
        ).run(status, now, deploy.project_id);
      }
    }

    // MongoDB — sync deployment record
    const deployRow = this.db.prepare('SELECT * FROM project_deployments WHERE id = ?').get(deploymentId) as any;
    if (deployRow) {
      let deployConfig: Record<string, any> = {};
      try { deployConfig = JSON.parse(deployRow.deploy_config || '{}'); } catch { deployConfig = {}; }
      await this.backend.putRecord('project_deployments', deploymentId, {
        projectId: deployRow.project_id,
        deployType: deployRow.deploy_type,
        deployUrl: deployRow.deploy_url || '',
        deployConfig,
        status: deployRow.status,
        deployedBy: deployRow.deployed_by,
        deployedAt: deployRow.deployed_at,
        errorMessage: deployRow.error_message || '',
      });

      if (status === 'live' || status === 'failed' || status === 'rolled_back') {
        const updatedProject = this.getProject(deployRow.project_id);
        if (updatedProject) {
          await this.persistProjectToMongo(deployRow.project_id, updatedProject);
        }
      }
    }

    console.log(`[project-store] Deployment ${deploymentId} status updated to ${status}`);
  }

  /**
   * Get all deployments for a project, most recent first.
   */
  getDeployments(projectId: string): ProjectDeployment[] {
    const rows = this.db.prepare(
      'SELECT * FROM project_deployments WHERE project_id = ? ORDER BY deployed_at DESC'
    ).all(projectId) as any[];
    return rows.map(r => this.rowToDeployment(r));
  }

  /**
   * Get all deployments for a project (async — prefers MongoDB).
   */
  async getDeploymentsAsync(projectId: string): Promise<ProjectDeployment[]> {
    if (this.backend) {
      const records = await this.backend.queryRecords('project_deployments', { projectId }, { sort: { deployedAt: -1 } });
      return records.map(r => this.recordToDeployment(r));
    }
    return this.getDeployments(projectId);
  }

  /**
   * Get the most recent deployment for a project, or null.
   */
  getLatestDeployment(projectId: string): ProjectDeployment | null {
    const row = this.db.prepare(
      'SELECT * FROM project_deployments WHERE project_id = ? ORDER BY deployed_at DESC LIMIT 1'
    ).get(projectId) as any;
    return row ? this.rowToDeployment(row) : null;
  }

  /**
   * Get the most recent deployment for a project (async — prefers MongoDB).
   */
  async getLatestDeploymentAsync(projectId: string): Promise<ProjectDeployment | null> {
    if (this.backend) {
      const records = await this.backend.queryRecords('project_deployments', { projectId }, { limit: 1, sort: { deployedAt: -1 } });
      return records.length > 0 ? this.recordToDeployment(records[0]) : null;
    }
    return this.getLatestDeployment(projectId);
  }

  // ── Ratings (Phase 31.8) ────────────────────────────────────────────

  /**
   * Rate a project (INSERT OR REPLACE — one rating per user per project).
   */
  async rateProject(projectId: string, userId: string, rating: number, review?: string): Promise<void> {
    if (rating < 1 || rating > 5 || !Number.isInteger(rating)) {
      throw new Error('Rating must be an integer between 1 and 5');
    }
    const now = Date.now();

    // MongoDB FIRST
    await this.backend.putRecord('project_ratings', `${projectId}:${userId}`, {
      projectId,
      userId,
      rating,
      review: review || '',
      createdAt: now,
    });

    // Then SQLite cache
    this.db.prepare(`
      INSERT OR REPLACE INTO project_ratings (project_id, user_id, rating, review, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(projectId, userId, rating, review || '', now);

    console.log(`[project-store] User ${userId} rated project ${projectId}: ${rating}/5`);
  }

  /**
   * Get all ratings for a project with average and total.
   */
  getProjectRatings(projectId: string): ProjectRatingSummary {
    const rows = this.db.prepare(
      'SELECT * FROM project_ratings WHERE project_id = ? ORDER BY created_at DESC'
    ).all(projectId) as any[];

    const ratings: ProjectRating[] = rows.map(r => ({
      projectId: r.project_id,
      userId: r.user_id,
      rating: r.rating,
      review: r.review || '',
      createdAt: r.created_at,
    }));

    const totalRatings = ratings.length;
    const avgRating = totalRatings > 0
      ? Math.round((ratings.reduce((sum, r) => sum + r.rating, 0) / totalRatings) * 100) / 100
      : 0;

    return { ratings, avgRating, totalRatings };
  }

  /**
   * Get all ratings for a project (async — prefers MongoDB).
   */
  async getProjectRatingsAsync(projectId: string): Promise<ProjectRatingSummary> {
    if (this.backend) {
      const records = await this.backend.queryRecords('project_ratings', { projectId });
      const ratings: ProjectRating[] = records.map(r => this.recordToRating(r));
      const totalRatings = ratings.length;
      const avgRating = totalRatings > 0
        ? Math.round((ratings.reduce((sum, r) => sum + r.rating, 0) / totalRatings) * 100) / 100
        : 0;
      return { ratings, avgRating, totalRatings };
    }
    return this.getProjectRatings(projectId);
  }

  // ── Marketplace (Phase 31.8) ────────────────────────────────────────

  /**
   * Get marketplace-listed projects with optional filtering and sorting.
   * Only returns projects with visibility 'listed' or 'featured'.
   */
  getMarketplace(opts?: MarketplaceQuery): MarketplaceListResult {
    const conditions: string[] = [
      "visibility IN ('listed', 'featured')",
      "status = 'active'",
    ];
    const params: any[] = [];

    if (opts?.category) {
      conditions.push('category = ?');
      params.push(opts.category);
    }

    if (opts?.search) {
      conditions.push('(name LIKE ? OR description LIKE ?)');
      const searchTerm = `%${opts.search}%`;
      params.push(searchTerm, searchTerm);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;

    // Count total matching
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM projects ${where}`
    ).get(...params) as any;
    const total = countRow?.cnt || 0;

    // Determine sort order
    let orderBy = 'updated_at DESC'; // default: newest
    if (opts?.sortBy === 'rating') {
      // Sort by average rating — join with ratings table
      orderBy = 'avg_rating DESC, updated_at DESC';
    } else if (opts?.sortBy === 'popular') {
      // Sort by collaborator count
      orderBy = 'collab_count DESC, updated_at DESC';
    }

    const limit = opts?.limit || 50;
    const offset = opts?.offset || 0;

    let rows: any[];
    if (opts?.sortBy === 'rating') {
      rows = this.db.prepare(`
        SELECT p.*, COALESCE(r.avg_rating, 0) as avg_rating
        FROM projects p
        LEFT JOIN (
          SELECT project_id, AVG(rating) as avg_rating
          FROM project_ratings GROUP BY project_id
        ) r ON p.id = r.project_id
        ${where}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as any[];
    } else if (opts?.sortBy === 'popular') {
      rows = this.db.prepare(`
        SELECT p.*, COALESCE(c.collab_count, 0) as collab_count
        FROM projects p
        LEFT JOIN (
          SELECT project_id, COUNT(*) as collab_count
          FROM project_collaborators GROUP BY project_id
        ) c ON p.id = c.project_id
        ${where}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset) as any[];
    } else {
      rows = this.db.prepare(
        `SELECT * FROM projects ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
      ).all(...params, limit, offset) as any[];
    }

    const projects = rows.map(r => this.rowToProject(r));
    return { projects, total };
  }

  /**
   * Get marketplace-listed projects (async — prefers MongoDB).
   * NOTE: Complex JOIN queries for rating/popular sort are not supported in MongoDB mode.
   * Falls back to sorting by updatedAt descending.
   */
  async getMarketplaceAsync(opts?: MarketplaceQuery): Promise<MarketplaceListResult> {
    if (this.backend) {
      const filter: Record<string, any> = { status: 'active' };
      const records = await this.backend.queryRecords('projects', filter, { sort: { updatedAt: -1 } });
      let filtered = records
        .map(r => this.recordToProject(r))
        .filter(p => p.visibility === 'listed' || p.visibility === 'featured');

      if (opts?.category) {
        filtered = filtered.filter(p => (p as any).category === opts.category);
      }
      if (opts?.search) {
        const term = opts.search.toLowerCase();
        filtered = filtered.filter(p =>
          p.name.toLowerCase().includes(term) || p.description.toLowerCase().includes(term)
        );
      }

      const total = filtered.length;
      const limit = opts?.limit || 50;
      const offset = opts?.offset || 0;
      const projects = filtered.slice(offset, offset + limit);

      return { projects, total };
    }
    return this.getMarketplace(opts);
  }

  // ── Content Reports (Phase 31.10) ────────────────────────────────────

  /**
   * Create a content report for a project.
   */
  async createReport(projectId: string, reporterId: string, reason: ReportReason, description?: string): Promise<ContentReport> {
    const id = this.generateId();
    const now = Date.now();

    const report: ContentReport = {
      id,
      projectId,
      reporterId,
      reason,
      description: description || '',
      status: 'pending',
      aiReview: '',
      aiSafetyScore: -1,
      reviewedBy: '',
      resolvedAt: 0,
      createdAt: now,
    };

    // MongoDB FIRST
    await this.backend.putRecord('content_reports', id, {
      projectId,
      reporterId,
      reason,
      description: description || '',
      status: 'pending',
      aiReview: '',
      aiSafetyScore: -1,
      reviewedBy: '',
      resolvedAt: 0,
      createdAt: now,
    });

    // Then SQLite cache
    this.db.prepare(`
      INSERT INTO content_reports (id, project_id, reporter_id, reason, description, status, ai_review, ai_safety_score, reviewed_by, resolved_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', '', -1, '', 0, ?)
    `).run(id, projectId, reporterId, reason, description || '', now);

    console.log(`[project-store] Report created: ${id} for project ${projectId} by ${reporterId} (${reason})`);
    return report;
  }

  /**
   * Get a report by ID.
   */
  getReport(reportId: string): ContentReport | null {
    const row = this.db.prepare('SELECT * FROM content_reports WHERE id = ?').get(reportId) as any;
    return row ? this.rowToReport(row) : null;
  }

  /**
   * Get a report by ID (async — prefers MongoDB).
   */
  async getReportAsync(reportId: string): Promise<ContentReport | null> {
    if (this.backend) {
      const record = await this.backend.getRecord('content_reports', reportId);
      return record ? this.recordToReport(record) : null;
    }
    return this.getReport(reportId);
  }

  /**
   * Get all reports for a project, optionally filtered by status.
   */
  getProjectReports(projectId: string, opts?: { status?: ReportStatus }): ContentReport[] {
    let sql = 'SELECT * FROM content_reports WHERE project_id = ?';
    const params: any[] = [projectId];

    if (opts?.status) {
      sql += ' AND status = ?';
      params.push(opts.status);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => this.rowToReport(r));
  }

  /**
   * Get all reports for a project (async — prefers MongoDB).
   */
  async getProjectReportsAsync(projectId: string, opts?: { status?: ReportStatus }): Promise<ContentReport[]> {
    if (this.backend) {
      const filter: Record<string, any> = { projectId };
      if (opts?.status) filter.status = opts.status;
      const records = await this.backend.queryRecords('content_reports', filter, { sort: { createdAt: -1 } });
      return records.map(r => this.recordToReport(r));
    }
    return this.getProjectReports(projectId, opts);
  }

  /**
   * Update a report's status, optionally setting review data.
   */
  async updateReportStatus(
    reportId: string,
    status: ReportStatus,
    reviewedBy?: string,
    aiReview?: string,
    aiSafetyScore?: number,
  ): Promise<void> {
    const fields: string[] = ['status = ?'];
    const params: any[] = [status];

    if (reviewedBy !== undefined) {
      fields.push('reviewed_by = ?');
      params.push(reviewedBy);
    }
    if (aiReview !== undefined) {
      fields.push('ai_review = ?');
      params.push(aiReview);
    }
    if (aiSafetyScore !== undefined) {
      fields.push('ai_safety_score = ?');
      params.push(aiSafetyScore);
    }
    if (status === 'resolved' || status === 'dismissed') {
      fields.push('resolved_at = ?');
      params.push(Date.now());
    }

    params.push(reportId);
    this.db.prepare(`UPDATE content_reports SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    // MongoDB — sync updated record
    const row = this.db.prepare('SELECT * FROM content_reports WHERE id = ?').get(reportId) as any;
    if (row) {
      await this.backend.putRecord('content_reports', reportId, {
        projectId: row.project_id,
        reporterId: row.reporter_id,
        reason: row.reason,
        description: row.description || '',
        status: row.status,
        aiReview: row.ai_review || '',
        aiSafetyScore: row.ai_safety_score ?? -1,
        reviewedBy: row.reviewed_by || '',
        resolvedAt: row.resolved_at || 0,
        createdAt: row.created_at,
      });
    }

    console.log(`[project-store] Report ${reportId} updated to ${status}`);
  }

  /**
   * Get pending reports, most recent first.
   */
  getPendingReports(limit?: number): ContentReport[] {
    const lim = limit || 50;
    const rows = this.db.prepare(
      "SELECT * FROM content_reports WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?"
    ).all(lim) as any[];
    return rows.map(r => this.rowToReport(r));
  }

  /**
   * Get pending reports (async — prefers MongoDB).
   */
  async getPendingReportsAsync(limit?: number): Promise<ContentReport[]> {
    if (this.backend) {
      const records = await this.backend.queryRecords('content_reports', { status: 'pending' }, {
        limit: limit || 50,
        sort: { createdAt: -1 },
      });
      return records.map(r => this.recordToReport(r));
    }
    return this.getPendingReports(limit);
  }

  /**
   * Get report statistics.
   */
  getReportStats(): ReportStats {
    const total = (this.db.prepare(
      'SELECT COUNT(*) as cnt FROM content_reports'
    ).get() as any)?.cnt || 0;

    const pending = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM content_reports WHERE status = 'pending'"
    ).get() as any)?.cnt || 0;

    const reviewing = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM content_reports WHERE status = 'reviewing'"
    ).get() as any)?.cnt || 0;

    const resolved = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM content_reports WHERE status = 'resolved'"
    ).get() as any)?.cnt || 0;

    const dismissed = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM content_reports WHERE status = 'dismissed'"
    ).get() as any)?.cnt || 0;

    return { total, pending, reviewing, resolved, dismissed };
  }

  /**
   * Get report statistics (async — prefers MongoDB).
   */
  async getReportStatsAsync(): Promise<ReportStats> {
    if (this.backend) {
      const allReports = await this.backend.listRecords('content_reports');
      const total = allReports.length;
      const pending = allReports.filter(r => r.status === 'pending').length;
      const reviewing = allReports.filter(r => r.status === 'reviewing').length;
      const resolved = allReports.filter(r => r.status === 'resolved').length;
      const dismissed = allReports.filter(r => r.status === 'dismissed').length;
      return { total, pending, reviewing, resolved, dismissed };
    }
    return this.getReportStats();
  }

  /**
   * Dismiss a report.
   */
  async dismissReport(reportId: string, reviewedBy: string): Promise<void> {
    await this.updateReportStatus(reportId, 'dismissed', reviewedBy);
  }

  /**
   * Resolve a report and optionally take action on the project.
   * Actions: 'archive' = soft-delete, 'delist' = set visibility to owner_only, 'none' = no action.
   */
  async resolveReport(reportId: string, reviewedBy: string, action: ReportAction): Promise<void> {
    const report = this.getReport(reportId);
    if (!report) return;

    await this.updateReportStatus(reportId, 'resolved', reviewedBy);

    if (action === 'archive') {
      await this.deleteProject(report.projectId);
      console.log(`[project-store] Project ${report.projectId} archived due to report ${reportId}`);
    } else if (action === 'delist') {
      await this.updateProject(report.projectId, { visibility: 'owner_only' as any });
      console.log(`[project-store] Project ${report.projectId} delisted due to report ${reportId}`);
    }
  }

  // ── Resource Assignment (Phase 53) ──────────────────────────────────────

  /**
   * Assign a resource to a project.
   */
  async assignResource(projectId: string, resource: { type: string; resourceId: string }): Promise<void> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const resources = project.resources || [];
    // Check if already assigned
    if (resources.some(r => r.resourceId === resource.resourceId)) {
      throw new Error(`Resource ${resource.resourceId} is already assigned to project ${projectId}`);
    }

    resources.push({
      type: resource.type,
      resourceId: resource.resourceId,
      assignedAt: Date.now(),
      status: 'active',
    });

    await this.updateProject(projectId, { resources });
    console.log(`[project-store] Assigned resource ${resource.resourceId} (${resource.type}) to project ${projectId}`);
  }

  /**
   * Remove a resource assignment from a project.
   */
  async removeResource(projectId: string, resourceId: string): Promise<void> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const resources = (project.resources || []).filter(r => r.resourceId !== resourceId);
    await this.updateProject(projectId, { resources });
    console.log(`[project-store] Removed resource ${resourceId} from project ${projectId}`);
  }

  /**
   * Get all resources assigned to a project.
   */
  getProjectResources(projectId: string): Array<{ type: string; resourceId: string; assignedAt: number; status: string }> {
    const project = this.getProject(projectId);
    if (!project) return [];
    return (project.resources || []).map(r => ({
      type: r.type,
      resourceId: r.resourceId,
      assignedAt: r.assignedAt,
      status: r.status,
    }));
  }

  /**
   * Generate a project API key (32-byte hex) and store it on the project.
   */
  async generateApiKey(projectId: string): Promise<string> {
    const project = this.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const apiKey = crypto.randomBytes(32).toString('hex');
    await this.updateProject(projectId, { apiKey });
    console.log(`[project-store] Generated API key for project ${projectId}`);
    return apiKey;
  }

  /**
   * Look up a project by its API key.
   */
  getProjectByApiKey(apiKey: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE api_key = ?').get(apiKey) as any;
    return row ? this.rowToProject(row) : null;
  }

  /**
   * Look up a project by its API key (async, prefers MongoDB).
   */
  async getProjectByApiKeyAsync(apiKey: string): Promise<Project | null> {
    if (this.backend) {
      const records = await this.backend.queryRecords('projects', { apiKey });
      if (records.length > 0) return this.recordToProject(records[0]);
    }
    return this.getProjectByApiKey(apiKey);
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  private generateId(): string {
    return randomBytes(12).toString('hex');
  }

  /**
   * Persist project to MongoDB, merging with existing record to preserve MongoDB-only fields
   * (tier, deploymentPort, instanceId, githubRepo) that aren't tracked in SQLite.
   */
  private async persistProjectToMongo(projectId: string, project: Project, extraFields?: Record<string, any>): Promise<void> {
    const existing = await this.backend.getRecord('projects', projectId);
    const record = { ...(existing || {}), ...this.projectToRecord(project) };
    // Restore MongoDB-only fields that projectToRecord would set to undefined
    const mongoOnlyKeys = ['tier', 'deploymentPort', 'instanceId', 'githubRepo', 'deployPeerId'] as const;
    if (existing) {
      for (const key of mongoOnlyKeys) {
        if (record[key] === undefined && existing[key] !== undefined) record[key] = existing[key];
      }
    }
    // Apply any extra fields from explicit updates
    if (extraFields) {
      for (const key of mongoOnlyKeys) {
        if (extraFields[key] !== undefined) record[key] = extraFields[key];
      }
    }
    await this.backend.putRecord('projects', projectId, record);
  }

  /**
   * Convert a Project object to a plain record with camelCase keys for MongoDB.
   */
  private projectToRecord(project: Project): Record<string, any> {
    return {
      name: project.name,
      description: project.description,
      ownerId: project.ownerId,
      type: project.type,
      visibility: project.visibility,
      revenueModel: project.revenueModel,
      revenueConfig: project.revenueConfig, // native object, not JSON string
      budgetSpent: project.budgetSpent,
      budgetLimit: project.budgetLimit,
      threadId: project.threadId,
      managerAgentId: project.managerAgentId,
      deploymentUrl: project.deploymentUrl,
      deploymentType: project.deploymentType,
      deploymentStatus: project.deploymentStatus,
      status: project.status,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      repoUrl: project.repoUrl || '',
      teamHistory: project.teamHistory || '',
      notes: project.notes || '',
      resources: project.resources || [],
      apiKey: project.apiKey || null,
      tier: project.tier || undefined,
      deploymentPort: project.deploymentPort || undefined,
      instanceId: project.instanceId || undefined,
      githubRepo: (project as any).githubRepo || undefined,
      deployPeerId: (project as any).deployPeerId || undefined,
    };
  }

  /**
   * Convert a SQLite row (snake_case) to a Project.
   */
  private rowToProject(row: any): Project {
    let revenueConfig: Record<string, any> = {};
    try {
      revenueConfig = JSON.parse(row.revenue_config || '{}');
    } catch {
      revenueConfig = {};
    }

    let resources: Project['resources'] = [];
    try {
      resources = JSON.parse(row.resources || '[]');
    } catch {
      resources = [];
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      ownerId: row.owner_id,
      type: row.type as ProjectType,
      visibility: row.visibility as ProjectVisibility,
      revenueModel: row.revenue_model as ProjectRevenueModel,
      revenueConfig,
      budgetSpent: row.budget_spent || 0,
      budgetLimit: row.budget_limit || 0,
      threadId: row.thread_id || '',
      managerAgentId: row.manager_agent_id || '',
      deploymentUrl: row.deployment_url || '',
      deploymentType: row.deployment_type || '',
      deploymentStatus: row.deployment_status || 'none',
      status: row.status as ProjectStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      repoUrl: row.repo_url || '',
      teamHistory: row.team_history || '',
      notes: row.notes || '',
      resources,
      apiKey: row.api_key || undefined,
      workspaceDir: row.workspace_dir || undefined,
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a Project.
   */
  private recordToProject(r: any): Project {
    let revenueConfig: Record<string, any> = {};
    const rawConfig = r.revenueConfig || r.revenue_config || '{}';
    try {
      revenueConfig = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
    } catch {
      revenueConfig = {};
    }

    return {
      id: r.id || r._id,
      name: r.name,
      description: r.description || '',
      ownerId: r.ownerId || r.owner_id,
      type: (r.type as ProjectType),
      visibility: (r.visibility as ProjectVisibility),
      revenueModel: (r.revenueModel || r.revenue_model || 'none') as ProjectRevenueModel,
      revenueConfig,
      budgetSpent: r.budgetSpent ?? r.budget_spent ?? 0,
      budgetLimit: r.budgetLimit ?? r.budget_limit ?? 0,
      threadId: r.threadId || r.thread_id || '',
      managerAgentId: r.managerAgentId || r.manager_agent_id || '',
      deploymentUrl: r.deploymentUrl || r.deployment_url || '',
      deploymentType: r.deploymentType || r.deployment_type || '',
      deploymentStatus: (r.deploymentStatus || r.deployment_status || 'none') as any,
      status: (r.status || 'active') as ProjectStatus,
      createdAt: r.createdAt || r.created_at,
      updatedAt: r.updatedAt || r.updated_at,
      repoUrl: r.repoUrl || r.repo_url || '',
      teamHistory: r.teamHistory || r.team_history || '',
      notes: r.notes || '',
      resources: r.resources || [],
      apiKey: r.apiKey || r.api_key || undefined,
      tier: r.tier || undefined,
      deploymentPort: r.deploymentPort || r.deployment_port || undefined,
      instanceId: r.instanceId || r.instance_id || undefined,
      githubRepo: r.githubRepo || r.github_repo || undefined,
      deployPeerId: r.deployPeerId || undefined,
      workspaceDir: r.workspaceDir || r.workspace_dir || undefined,
    } as any;
  }

  private rowToCollaborator(row: any): ProjectCollaborator {
    return {
      projectId: row.project_id,
      userId: row.user_id,
      role: row.role as ProjectRole,
      addedAt: row.added_at,
      addedBy: row.added_by,
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a ProjectCollaborator.
   */
  private recordToCollaborator(r: any): ProjectCollaborator {
    return {
      projectId: r.projectId || r.project_id,
      userId: r.userId || r.user_id,
      role: (r.role as ProjectRole),
      addedAt: r.addedAt || r.added_at,
      addedBy: r.addedBy || r.added_by,
    };
  }

  private rowToInvite(row: any): ProjectInvite {
    return {
      id: row.id,
      projectId: row.project_id,
      code: row.code,
      role: row.role as ProjectRole,
      createdBy: row.created_by,
      expiresAt: row.expires_at,
      maxUses: row.max_uses,
      usedCount: row.used_count,
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a ProjectInvite.
   */
  private recordToInvite(r: any): ProjectInvite {
    return {
      id: r.id || r._id,
      projectId: r.projectId || r.project_id,
      code: r.code,
      role: (r.role as ProjectRole),
      createdBy: r.createdBy || r.created_by,
      expiresAt: r.expiresAt ?? r.expires_at,
      maxUses: r.maxUses ?? r.max_uses ?? 0,
      usedCount: r.usedCount ?? r.used_count ?? 0,
    };
  }

  private rowToTransfer(row: any): ProjectTransfer {
    return {
      id: row.id,
      projectId: row.project_id,
      fromUser: row.from_user,
      toUser: row.to_user,
      transferType: row.transfer_type as TransferType,
      salePrice: row.sale_price || 0,
      escrowHoldId: row.escrow_hold_id || '',
      status: row.status as TransferStatus,
      createdAt: row.created_at,
      completedAt: row.completed_at || 0,
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a ProjectTransfer.
   */
  private recordToTransfer(r: any): ProjectTransfer {
    return {
      id: r.id || r._id,
      projectId: r.projectId || r.project_id,
      fromUser: r.fromUser || r.from_user,
      toUser: r.toUser || r.to_user,
      transferType: (r.transferType || r.transfer_type) as TransferType,
      salePrice: r.salePrice ?? r.sale_price ?? 0,
      escrowHoldId: r.escrowHoldId || r.escrow_hold_id || '',
      status: (r.status as TransferStatus),
      createdAt: r.createdAt || r.created_at,
      completedAt: r.completedAt ?? r.completed_at ?? 0,
    };
  }

  private rowToDeployment(row: any): ProjectDeployment {
    let deployConfig: Record<string, any> = {};
    try {
      deployConfig = JSON.parse(row.deploy_config || '{}');
    } catch {
      deployConfig = {};
    }

    return {
      id: row.id,
      projectId: row.project_id,
      deployType: row.deploy_type as DeployType,
      deployUrl: row.deploy_url || '',
      deployConfig,
      status: row.status as DeploymentStatus,
      deployedBy: row.deployed_by,
      deployedAt: row.deployed_at,
      errorMessage: row.error_message || '',
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a ProjectDeployment.
   */
  private recordToDeployment(r: any): ProjectDeployment {
    let deployConfig: Record<string, any> = {};
    const rawConfig = r.deployConfig || r.deploy_config || '{}';
    try {
      deployConfig = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
    } catch {
      deployConfig = {};
    }

    return {
      id: r.id || r._id,
      projectId: r.projectId || r.project_id,
      deployType: (r.deployType || r.deploy_type) as DeployType,
      deployUrl: r.deployUrl || r.deploy_url || '',
      deployConfig,
      status: (r.status as DeploymentStatus),
      deployedBy: r.deployedBy || r.deployed_by,
      deployedAt: r.deployedAt || r.deployed_at,
      errorMessage: r.errorMessage || r.error_message || '',
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a ProjectRating.
   */
  private recordToRating(r: any): ProjectRating {
    return {
      projectId: r.projectId || r.project_id,
      userId: r.userId || r.user_id,
      rating: r.rating,
      review: r.review || '',
      createdAt: r.createdAt || r.created_at,
    };
  }

  private rowToReport(row: any): ContentReport {
    return {
      id: row.id,
      projectId: row.project_id,
      reporterId: row.reporter_id,
      reason: row.reason as ReportReason,
      description: row.description || '',
      status: row.status as ReportStatus,
      aiReview: row.ai_review || '',
      aiSafetyScore: row.ai_safety_score ?? -1,
      reviewedBy: row.reviewed_by || '',
      resolvedAt: row.resolved_at || 0,
      createdAt: row.created_at,
    };
  }

  /**
   * Convert a MongoDB record (camelCase or snake_case) to a ContentReport.
   */
  private recordToReport(r: any): ContentReport {
    return {
      id: r.id || r._id,
      projectId: r.projectId || r.project_id,
      reporterId: r.reporterId || r.reporter_id,
      reason: (r.reason as ReportReason),
      description: r.description || '',
      status: (r.status as ReportStatus),
      aiReview: r.aiReview || r.ai_review || '',
      aiSafetyScore: r.aiSafetyScore ?? r.ai_safety_score ?? -1,
      reviewedBy: r.reviewedBy || r.reviewed_by || '',
      resolvedAt: r.resolvedAt ?? r.resolved_at ?? 0,
      createdAt: r.createdAt || r.created_at,
    };
  }
}
