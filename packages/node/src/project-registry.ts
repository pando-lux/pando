/**
 * ProjectRegistry — P2P project metadata registry.
 *
 * Phase 63: Syncs project metadata (id, name, owner, API key hash, resource
 * assignments, deployment info) across the network via GossipSub. Enables any
 * node to validate project API keys without MongoDB.
 *
 * Pattern: mirrors ResourceRegistry (Phase 42.5) — SQLite table, in-memory
 * cache, GossipSub broadcast, dedup, catch-up sync via LedgerSync.
 *
 * Security: API keys stored as SHA-256 hashes only. Never syncs plaintext keys.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { MessageType } from '@pando/shared';
import type { PandoMessage, ProjectRegistryRecord } from '@pando/shared';
import type { PandoNetwork } from './network.js';

export const TOPIC_PROJECTS = 'pando/projects';

function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export class ProjectRegistry {
  private network: PandoNetwork;
  private localPeerId: string;
  private db: Database.Database;

  // In-memory cache (mirrors SQLite)
  private projects: Map<string, ProjectRegistryRecord> = new Map();
  // Dedup set for GossipSub messages
  private processedIds: Set<string> = new Set();

  // Prepared statements
  private stmtInsert!: Database.Statement;
  private stmtUpdate!: Database.Statement;
  private stmtUpdateStatus!: Database.Statement;

  constructor(network: PandoNetwork, localPeerId: string, db: Database.Database) {
    this.network = network;
    this.localPeerId = localPeerId;
    this.db = db;
  }

  async start(): Promise<void> {
    // Create table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_registry (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_peer_id TEXT NOT NULL,
        owner_username TEXT,
        api_key_hash TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'owner_only',
        resource_ids TEXT DEFAULT '[]',
        deployment_url TEXT,
        deployment_type TEXT,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        registered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Indexes
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pr_api_key_hash ON project_registry(api_key_hash)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pr_owner ON project_registry(owner_peer_id)`);
    } catch { /* indexes may exist */ }

    // Prepared statements
    this.stmtInsert = this.db.prepare(`
      INSERT OR REPLACE INTO project_registry
        (project_id, name, owner_peer_id, owner_username, api_key_hash, visibility, resource_ids, deployment_url, deployment_type, description, status, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtUpdate = this.db.prepare(`
      UPDATE project_registry SET name = ?, visibility = ?, resource_ids = ?, deployment_url = ?, deployment_type = ?, description = ?, status = ?, updated_at = ?
      WHERE project_id = ?
    `);
    this.stmtUpdateStatus = this.db.prepare(`UPDATE project_registry SET status = ?, updated_at = ? WHERE project_id = ?`);

    // Load from SQLite
    const rows = this.db.prepare('SELECT * FROM project_registry').all() as any[];
    for (const row of rows) {
      const record = this.rowToRecord(row);
      this.projects.set(record.projectId, record);
    }

    // Subscribe to GossipSub
    await this.network.subscribeTopic(TOPIC_PROJECTS, (message: PandoMessage) => {
      this.handleMessage(message);
    });

    console.log(`[project-registry] Started — ${this.projects.size} projects loaded, subscribed to ${TOPIC_PROJECTS}`);
  }

  stop(): void {
    this.processedIds.clear();
  }

  // ── Core Operations ─────────────────────────────────────────────────────

  /**
   * Register a project on the P2P network.
   * API key is hashed with SHA-256 — plaintext never stored or synced.
   */
  registerProject(
    projectId: string,
    name: string,
    ownerPeerId: string,
    apiKey: string,
    visibility: string,
    resourceIds: string[] = [],
    ownerUsername?: string,
    deploymentUrl?: string,
    deploymentType?: string,
    description?: string
  ): ProjectRegistryRecord {
    const now = Date.now();
    const record: ProjectRegistryRecord = {
      projectId,
      name,
      ownerPeerId,
      ownerUsername,
      apiKeyHash: hashApiKey(apiKey),
      visibility,
      resourceIds,
      deploymentUrl,
      deploymentType,
      description,
      status: 'active',
      registeredAt: now,
      updatedAt: now,
    };

    this.persistRecord(record);
    this.projects.set(projectId, record);
    this.broadcast(MessageType.PROJECT_REGISTER, record);
    return record;
  }

  /**
   * Update project metadata and broadcast change.
   */
  updateProject(projectId: string, updates: Partial<Pick<ProjectRegistryRecord, 'name' | 'visibility' | 'resourceIds' | 'status' | 'deploymentUrl' | 'deploymentType' | 'description'>>): boolean {
    const existing = this.projects.get(projectId);
    if (!existing) return false;

    const updated: ProjectRegistryRecord = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    this.stmtUpdate.run(
      updated.name, updated.visibility, JSON.stringify(updated.resourceIds),
      updated.deploymentUrl || null, updated.deploymentType || null, updated.description || null,
      updated.status, updated.updatedAt, projectId
    );
    this.projects.set(projectId, updated);
    this.broadcast(MessageType.PROJECT_UPDATE, updated);
    return true;
  }

  /**
   * Archive a project (soft delete).
   */
  archiveProject(projectId: string): boolean {
    const existing = this.projects.get(projectId);
    if (!existing) return false;

    const now = Date.now();
    existing.status = 'archived';
    existing.updatedAt = now;
    this.stmtUpdateStatus.run('archived', now, projectId);
    this.projects.set(projectId, existing);
    this.broadcast(MessageType.PROJECT_ARCHIVE, existing);
    return true;
  }

  // ── Lookups ─────────────────────────────────────────────────────────────

  /**
   * Validate an API key by hashing it and looking up the hash.
   * This is the critical method for Resource Proxy validation.
   */
  validateApiKey(apiKey: string): ProjectRegistryRecord | null {
    const hash = hashApiKey(apiKey);
    for (const record of this.projects.values()) {
      if (record.apiKeyHash === hash && record.status === 'active') {
        return record;
      }
    }
    return null;
  }

  getProject(projectId: string): ProjectRegistryRecord | null {
    return this.projects.get(projectId) || null;
  }

  getAllProjects(): ProjectRegistryRecord[] {
    return Array.from(this.projects.values());
  }

  getProjectsByOwner(ownerPeerId: string): ProjectRegistryRecord[] {
    return Array.from(this.projects.values()).filter(p => p.ownerPeerId === ownerPeerId);
  }

  getActiveProjects(): ProjectRegistryRecord[] {
    return Array.from(this.projects.values()).filter(p => p.status === 'active');
  }

  getListedProjects(): ProjectRegistryRecord[] {
    return Array.from(this.projects.values()).filter(
      p => p.status === 'active' && (p.visibility === 'listed' || p.visibility === 'featured')
    );
  }

  // ── P2P Sync ────────────────────────────────────────────────────────────

  /**
   * Apply a remote record from GossipSub or catch-up sync.
   * Returns true if the record was new or updated.
   */
  applyRemoteRecord(record: ProjectRegistryRecord): boolean {
    if (!record?.projectId || !record?.apiKeyHash) return false;

    const existing = this.projects.get(record.projectId);
    if (existing && existing.updatedAt >= record.updatedAt) {
      return false; // We already have a newer or equal version
    }

    this.persistRecord(record);
    this.projects.set(record.projectId, record);
    return true;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private handleMessage(message: PandoMessage): void {
    const payload = message.payload as any;
    if (!payload?.projectId) return;

    // Dedup
    const dedupKey = `${message.type}:${payload.projectId}:${message.timestamp}`;
    if (this.processedIds.has(dedupKey)) return;
    this.processedIds.add(dedupKey);

    // Trim dedup set if too large
    if (this.processedIds.size > 10000) {
      const arr = Array.from(this.processedIds);
      this.processedIds = new Set(arr.slice(arr.length - 5000));
    }

    // Don't process our own broadcasts
    if (message.from === this.localPeerId) return;

    const record: ProjectRegistryRecord = {
      projectId: payload.projectId,
      name: payload.name || '',
      ownerPeerId: payload.ownerPeerId || message.from,
      ownerUsername: payload.ownerUsername,
      apiKeyHash: payload.apiKeyHash,
      visibility: payload.visibility || 'owner_only',
      resourceIds: payload.resourceIds || [],
      deploymentUrl: payload.deploymentUrl,
      deploymentType: payload.deploymentType,
      description: payload.description,
      status: payload.status || 'active',
      registeredAt: payload.registeredAt || message.timestamp,
      updatedAt: payload.updatedAt || message.timestamp,
    };

    switch (message.type) {
      case MessageType.PROJECT_REGISTER:
      case MessageType.PROJECT_UPDATE:
        this.applyRemoteRecord(record);
        break;
      case MessageType.PROJECT_ARCHIVE:
        record.status = 'archived';
        this.applyRemoteRecord(record);
        break;
    }
  }

  private persistRecord(record: ProjectRegistryRecord): void {
    this.stmtInsert.run(
      record.projectId, record.name, record.ownerPeerId, record.ownerUsername || null,
      record.apiKeyHash, record.visibility, JSON.stringify(record.resourceIds),
      record.deploymentUrl || null, record.deploymentType || null, record.description || null,
      record.status, record.registeredAt, record.updatedAt
    );
  }

  private async broadcast(type: MessageType, record: ProjectRegistryRecord): Promise<void> {
    try {
      await this.network.publishToTopic(TOPIC_PROJECTS, {
        type,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: { ...record },
      });
    } catch (err) {
      // Ignore publish errors (no peers connected, etc.)
    }
  }

  private rowToRecord(row: any): ProjectRegistryRecord {
    let resourceIds: string[] = [];
    try { resourceIds = JSON.parse(row.resource_ids || '[]'); } catch { /* ignore */ }
    return {
      projectId: row.project_id,
      name: row.name,
      ownerPeerId: row.owner_peer_id,
      ownerUsername: row.owner_username || undefined,
      apiKeyHash: row.api_key_hash,
      visibility: row.visibility,
      resourceIds,
      deploymentUrl: row.deployment_url || undefined,
      deploymentType: row.deployment_type || undefined,
      description: row.description || undefined,
      status: row.status,
      registeredAt: row.registered_at,
      updatedAt: row.updated_at,
    };
  }
}
