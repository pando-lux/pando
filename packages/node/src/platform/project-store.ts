/**
 * ProjectStore — Persistent project storage with MongoDB as source of truth.
 *
 * Phase 31.1: Project Data Model
 * Phase 44: MongoDB dual-mode support (StorageBackend)
 * Phase 57: MongoDB-first writes — backend is REQUIRED.
 *
 * Projects are first-class persistent entities. Each project has an owner,
 * budget tracking, linked threads/agents, and revenue config.
 *
 * MongoDB-first: All writes go to MongoDB first (must succeed), then SQLite
 * is updated as a local cache. Reads use SQLite (sync) for speed.
 * loadFromBackend() hydrates SQLite from MongoDB on startup.
 *
 * Uses the same better-sqlite3 instance as the ledger to avoid multiple
 * database connections and to allow future cross-table queries.
 *
 * // KB: project_collaborators, invites, transfers, deployments, ratings, content_reports stripped in Phase 6. Only projects table remains.
 */

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import crypto from 'node:crypto';
import type {
  Project,
  ProjectType,
  ProjectVisibility,
  ProjectRevenueModel,
  ProjectStatus,
  MarketplaceQuery,
  MarketplaceListResult,
} from '@pando/shared';
import type { StorageBackend } from '../core/storage-backend.js';
import { debug } from '../logger.js';

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
    team_id TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_projects_owner_id ON projects(owner_id);
  CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
  CREATE INDEX IF NOT EXISTS idx_projects_type ON projects(type);
  CREATE INDEX IF NOT EXISTS idx_projects_visibility ON projects(visibility);
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
  /** Team managing this project. */
  teamId?: string;
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
}

// ── ProjectStore Class ───────────────────────────────────────────────────────

export class ProjectStore {
  private db: Database.Database;
  private backend: StorageBackend;
  // Phase 63: Write-through callback to P2P ProjectRegistry
  private broadcastToP2P: ((action: 'register' | 'update' | 'archive', project: any) => void) | null = null;
  // #48: Callback to cancel running tasks when a project is archived
  private taskCanceller: ((projectId: string) => void) | null = null;

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

  /** #48: Set callback to cancel running tasks when a project is archived. */
  setTaskCanceller(cb: (projectId: string) => void): void {
    this.taskCanceller = cb;
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

      // Migration: add team_id column
      const hasTeamId = cols.some((c: any) => c.name === 'team_id');
      if (!hasTeamId) {
        this.db.exec("ALTER TABLE projects ADD COLUMN team_id TEXT DEFAULT ''");
        console.log('[project-store] Migration: added team_id column to projects');
      }
    } catch {
      // Column may already exist
    }
  }

  /**
   * Hydrate SQLite cache from MongoDB backend.
   * Loads all projects from MongoDB.
   */
  async loadFromBackend(): Promise<void> {
    debug('[project-store] Loading data from MongoDB backend...');

    // Load projects
    const projects = await this.backend.listRecords('projects');
    for (const r of projects) {
      const p = this.recordToProject(r);
      this.db.prepare(`
        INSERT OR REPLACE INTO projects (id, name, description, owner_id, type, visibility, revenue_model, revenue_config, budget_spent, budget_limit, thread_id, manager_agent_id, deployment_url, deployment_type, deployment_status, team_id, status, created_at, updated_at, category, repo_url, team_history, notes, resources, api_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        p.id, p.name, p.description, p.ownerId, p.type, p.visibility,
        p.revenueModel, JSON.stringify(p.revenueConfig), p.budgetSpent, p.budgetLimit,
        p.threadId, p.managerAgentId, p.deploymentUrl, p.deploymentType,
        p.deploymentStatus, p.teamId || '', p.status, p.createdAt, p.updatedAt,
        (p as any).category || '', p.repoUrl || '', p.teamHistory || '', p.notes || '',
        JSON.stringify(p.resources || []), p.apiKey || null,
      );
    }
    debug(`[project-store] Loaded ${projects.length} projects from backend`);

    debug('[project-store] Backend hydration complete');
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
      teamId: opts.teamId || '',
      createdAt: now,
      updatedAt: now,
    };

    // MongoDB FIRST — must succeed
    await this.backend.putRecord('projects', project.id, this.projectToRecord(project));

    // Then SQLite cache
    this.db.prepare(`
      INSERT INTO projects (id, name, description, owner_id, type, visibility, revenue_model, revenue_config, budget_spent, budget_limit, thread_id, manager_agent_id, deployment_url, deployment_type, deployment_status, team_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id, project.name, project.description, project.ownerId,
      project.type, project.visibility, project.revenueModel,
      JSON.stringify(project.revenueConfig), project.budgetSpent, project.budgetLimit,
      project.threadId, project.managerAgentId, project.deploymentUrl,
      project.deploymentType, project.deploymentStatus, project.teamId || '',
      project.status, project.createdAt, project.updatedAt,
    );

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
    // Prefer local SQLite cache — avoids P2P proxy timeout on untrusted nodes
    const cached = this.getProject(projectId);
    if (cached) return cached;
    // Cache miss — try backend (MongoDB or P2P proxy)
    if (this.backend) {
      const record = await this.backend.getRecord('projects', projectId);
      if (record) {
        const project = this.recordToProject(record);
        return project;
      }
    }
    return null;
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
   * Get a project by its managing team ID.
   */
  getProjectByTeamId(teamId: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE team_id = ?').get(teamId) as any;
    return row ? this.rowToProject(row) : null;
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
    if (updates.teamId !== undefined) { fields.push('team_id = ?'); params.push(updates.teamId); }

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

      // #48: Cancel running tasks associated with this project
      if (this.taskCanceller) {
        try { this.taskCanceller(projectId); } catch { /* ignore */ }
      }
    }
    return result.changes > 0;
  }

  /**
   * Check if a user has access to a project.
   * Access is granted if the user is the owner or the project is public.
   */
  hasAccess(projectId: string, userId: string): boolean {
    const project = this.getProject(projectId);
    if (!project) return false;
    if (project.ownerId === userId) return true;
    return project.type === 'public';
  }

  /**
   * Check if a user has access to a project (async — prefers MongoDB).
   */
  async hasAccessAsync(projectId: string, userId: string): Promise<boolean> {
    const project = await this.getProjectAsync(projectId);
    if (!project) return false;
    if (project.ownerId === userId) return true;
    return project.type === 'public';
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

    return { totalProjects, activeProjects, publicProjects };
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
      return { totalProjects, activeProjects, publicProjects };
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

    const limit = opts?.limit || 50;
    const offset = opts?.offset || 0;

    const rows = this.db.prepare(
      `SELECT * FROM projects ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as any[];

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
      const testArtifactPattern = /^(hello[\s-]?world|test[\s-]?(app)?|untitled|my[\s-]?app|new[\s-]?project|demo|example|sample|asdf|foo|bar|temp|tmp|delete[\s-]?me|placeholder)$/i;
      let filtered = records
        .map(r => this.recordToProject(r))
        .filter(p => p.visibility === 'listed' || p.visibility === 'featured')
        .filter(p => !testArtifactPattern.test(p.name.trim()));

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
      teamId: project.teamId || undefined,
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
      teamId: row.team_id || undefined,
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
      teamId: r.teamId || r.team_id || undefined,
    } as any;
  }

}
