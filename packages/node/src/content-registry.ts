/**
 * ContentRegistry — Phase 11: Content Layer
 *
 * SQLite-backed registry of content records (websites, APIs, datasets, services,
 * documents, tools) built by agents on the Pando network.
 *
 * Syncs records across nodes via GossipSub topic `pando/content`.
 * Provides full-text search on title + description + tags.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type {
  ContentRecord,
  ContentManifest,
  ContentSearchResult,
  ContentStats,
  ContentRevenue,
  RevenueDistribution,
  ContentType,
  ContentStatus,
} from '@pando/shared';
import type { PandoNetwork } from './network.js';

export const TOPIC_CONTENT = 'pando/content';

export class ContentRegistry {
  private db: Database.Database;
  private localPeerId: string = '';
  private network: PandoNetwork | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTables();
  }

  /** Set the local node's peer ID. */
  setLocalPeerId(peerId: string): void {
    this.localPeerId = peerId;
  }

  /** Set the network instance for GossipSub broadcasting. */
  setNetwork(network: PandoNetwork): void {
    this.network = network;
  }

  /** Subscribe to the `pando/content` GossipSub topic. */
  async subscribeContentTopic(): Promise<void> {
    if (!this.network) return;
    await this.network.subscribeTopic(TOPIC_CONTENT, (message) => {
      if (!message.payload) return;
      const fromPeerId = message.from || 'unknown';
      if (fromPeerId === this.localPeerId) return;
      const payload = message.payload as any;
      if (payload.type === 'content_record' && payload.record) {
        this.mergeRemoteRecord(payload.record);
      }
    });
    console.log(`[content-registry] Subscribed to GossipSub topic: ${TOPIC_CONTENT}`);
  }

  // ── Schema ──

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_records (
        content_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner_peer_id TEXT NOT NULL,
        builder_peer_id TEXT DEFAULT NULL,
        repo_url TEXT DEFAULT NULL,
        live_url TEXT DEFAULT NULL,
        hosting_nodes TEXT NOT NULL DEFAULT '[]',
        version INTEGER NOT NULL DEFAULT 1,
        version_hash TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        tags TEXT NOT NULL DEFAULT '[]',
        lux_earned REAL NOT NULL DEFAULT 0,
        manifest TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_content_owner ON content_records(owner_peer_id);
      CREATE INDEX IF NOT EXISTS idx_content_status ON content_records(status);
      CREATE INDEX IF NOT EXISTS idx_content_type ON content_records(type);

      CREATE TABLE IF NOT EXISTS content_revenue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        role TEXT NOT NULL,
        amount REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (content_id) REFERENCES content_records(content_id)
      );

      CREATE INDEX IF NOT EXISTS idx_revenue_content ON content_revenue(content_id);
    `);
  }

  // ── CRUD ──

  /** Create a new content record. Returns the full record. */
  create(params: {
    type: ContentType;
    title: string;
    description?: string;
    ownerPeerId?: string;
    builderPeerId?: string;
    repoUrl?: string;
    liveUrl?: string;
    hostingNodes?: string[];
    tags?: string[];
    manifest?: Partial<ContentManifest>;
    status?: ContentStatus;
  }): ContentRecord {
    const contentId = randomUUID();
    const now = Date.now();
    const ownerPeerId = params.ownerPeerId || this.localPeerId;
    const hostingNodes = params.hostingNodes || (this.localPeerId ? [this.localPeerId] : []);
    const manifest: ContentManifest = {
      upgradePolicy: params.manifest?.upgradePolicy || 'owner-only',
      maintainerProfile: params.manifest?.maintainerProfile,
      updateSchedule: params.manifest?.updateSchedule,
      qualityGate: params.manifest?.qualityGate || 'none',
    };
    const versionHash = this.computeVersionHash(contentId, 1, params.title);

    const record: ContentRecord = {
      contentId,
      type: params.type,
      title: params.title,
      description: params.description || '',
      ownerPeerId,
      builderPeerId: params.builderPeerId,
      repoUrl: params.repoUrl,
      liveUrl: params.liveUrl,
      hostingNodes,
      version: 1,
      versionHash,
      status: params.status || 'draft',
      tags: params.tags || [],
      luxEarned: 0,
      manifest,
      createdAt: now,
      updatedAt: now,
    };

    this.insertRecord(record);
    this.broadcastRecord(record);
    return record;
  }

  /** Update an existing content record (owner check must be done by caller). */
  update(contentId: string, updates: Partial<{
    title: string;
    description: string;
    repoUrl: string;
    liveUrl: string;
    hostingNodes: string[];
    status: ContentStatus;
    tags: string[];
    manifest: Partial<ContentManifest>;
  }>): ContentRecord | null {
    const existing = this.get(contentId);
    if (!existing) return null;

    const now = Date.now();
    const newVersion = existing.version + 1;
    const newTitle = updates.title ?? existing.title;
    const versionHash = this.computeVersionHash(contentId, newVersion, newTitle);

    const updated: ContentRecord = {
      ...existing,
      title: newTitle,
      description: updates.description ?? existing.description,
      repoUrl: updates.repoUrl ?? existing.repoUrl,
      liveUrl: updates.liveUrl ?? existing.liveUrl,
      hostingNodes: updates.hostingNodes ?? existing.hostingNodes,
      status: updates.status ?? existing.status,
      tags: updates.tags ?? existing.tags,
      manifest: updates.manifest
        ? { ...existing.manifest, ...updates.manifest }
        : existing.manifest,
      version: newVersion,
      versionHash,
      updatedAt: now,
    };

    this.db.prepare(`
      UPDATE content_records SET
        title = ?, description = ?, repo_url = ?, live_url = ?,
        hosting_nodes = ?, status = ?, tags = ?, manifest = ?,
        version = ?, version_hash = ?, updated_at = ?
      WHERE content_id = ?
    `).run(
      updated.title, updated.description, updated.repoUrl || null,
      updated.liveUrl || null, JSON.stringify(updated.hostingNodes),
      updated.status, JSON.stringify(updated.tags),
      JSON.stringify(updated.manifest), updated.version,
      updated.versionHash, updated.updatedAt, contentId,
    );

    this.broadcastRecord(updated);
    return updated;
  }

  /** Get a single content record by ID. */
  get(contentId: string): ContentRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM content_records WHERE content_id = ?'
    ).get(contentId) as any;
    if (!row) return null;
    return this.rowToRecord(row);
  }

  /** List all content records, optionally filtered by type and/or status. */
  list(opts?: { type?: ContentType; status?: ContentStatus; limit?: number }): ContentRecord[] {
    let sql = 'SELECT * FROM content_records WHERE 1=1';
    const params: any[] = [];
    if (opts?.type) { sql += ' AND type = ?'; params.push(opts.type); }
    if (opts?.status) { sql += ' AND status = ?'; params.push(opts.status); }
    sql += ' ORDER BY updated_at DESC';
    if (opts?.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => this.rowToRecord(r));
  }

  /** Search content by query (title, description, tags). */
  search(query: string, limit = 20): ContentSearchResult[] {
    if (!query.trim()) return [];
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    const rows = this.db.prepare(
      'SELECT * FROM content_records WHERE status != ? ORDER BY updated_at DESC'
    ).all('archived') as any[];

    const results: ContentSearchResult[] = [];
    for (const row of rows) {
      const record = this.rowToRecord(row);
      const searchText = `${record.title} ${record.description} ${record.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (record.title.toLowerCase().includes(term)) score += 3;
        if (record.description.toLowerCase().includes(term)) score += 1;
        if (record.tags.some((t: string) => t.toLowerCase().includes(term))) score += 2;
      }
      if (score > 0) {
        results.push({ content: record, relevanceScore: score });
      }
    }

    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results.slice(0, limit);
  }

  /** Get all content owned by a specific peer. */
  getByOwner(peerId: string): ContentRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM content_records WHERE owner_peer_id = ? ORDER BY updated_at DESC'
    ).all(peerId) as any[];
    return rows.map(r => this.rowToRecord(r));
  }

  /** Archive a content record (soft delete). */
  archive(contentId: string): boolean {
    const result = this.db.prepare(
      'UPDATE content_records SET status = ?, updated_at = ? WHERE content_id = ?'
    ).run('archived', Date.now(), contentId);
    return result.changes > 0;
  }

  // ── Stats ──

  /** Get aggregate content statistics. */
  getStats(): ContentStats {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM content_records').get() as any).c;
    const byType: Record<string, number> = {};
    const typeRows = this.db.prepare('SELECT type, COUNT(*) as c FROM content_records GROUP BY type').all() as any[];
    for (const r of typeRows) byType[r.type] = r.c;

    const byStatus: Record<string, number> = {};
    const statusRows = this.db.prepare('SELECT status, COUNT(*) as c FROM content_records GROUP BY status').all() as any[];
    for (const r of statusRows) byStatus[r.status] = r.c;

    const totalLux = (this.db.prepare('SELECT COALESCE(SUM(lux_earned), 0) as s FROM content_records').get() as any).s;

    return { totalContent: total, byType, byStatus, totalLuxEarned: totalLux };
  }

  // ── Revenue ──

  /** Distribute revenue for a content item.
   *  40% hosting, 40% building, 20% network treasury.
   */
  distributeRevenue(contentId: string, luxAmount: number, ledger?: { transfer: (from: string, to: string, amount: number) => any }): ContentRevenue | null {
    const record = this.get(contentId);
    if (!record) return null;

    const hostingAmount = luxAmount * 0.4;
    const buildingAmount = luxAmount * 0.4;
    const networkAmount = luxAmount * 0.2;
    const now = Date.now();
    const distributions: RevenueDistribution[] = [];

    // Hosting share — split among hosting nodes
    if (record.hostingNodes.length > 0) {
      const perHost = hostingAmount / record.hostingNodes.length;
      for (const nodeId of record.hostingNodes) {
        distributions.push({ peerId: nodeId, role: 'hosting', amount: perHost, timestamp: now });
        this.db.prepare(
          'INSERT INTO content_revenue (content_id, peer_id, role, amount, timestamp) VALUES (?, ?, ?, ?, ?)'
        ).run(contentId, nodeId, 'hosting', perHost, now);
      }
    }

    // Building share — to the builder or owner
    const builder = record.builderPeerId || record.ownerPeerId;
    distributions.push({ peerId: builder, role: 'building', amount: buildingAmount, timestamp: now });
    this.db.prepare(
      'INSERT INTO content_revenue (content_id, peer_id, role, amount, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(contentId, builder, 'building', buildingAmount, now);

    // Network share — to NETWORK account
    distributions.push({ peerId: 'NETWORK', role: 'network', amount: networkAmount, timestamp: now });
    this.db.prepare(
      'INSERT INTO content_revenue (content_id, peer_id, role, amount, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(contentId, 'NETWORK', 'network', networkAmount, now);

    // Update total lux earned
    this.db.prepare(
      'UPDATE content_records SET lux_earned = lux_earned + ?, updated_at = ? WHERE content_id = ?'
    ).run(luxAmount, now, contentId);

    return {
      contentId,
      totalLux: luxAmount,
      hostingShare: hostingAmount,
      buildingShare: buildingAmount,
      networkShare: networkAmount,
      distributions,
    };
  }

  /** Get revenue breakdown for a content item. */
  getRevenue(contentId: string): ContentRevenue | null {
    const record = this.get(contentId);
    if (!record) return null;

    const rows = this.db.prepare(
      'SELECT * FROM content_revenue WHERE content_id = ? ORDER BY timestamp DESC'
    ).all(contentId) as any[];

    const distributions: RevenueDistribution[] = rows.map(r => ({
      peerId: r.peer_id,
      role: r.role as 'hosting' | 'building' | 'network',
      amount: r.amount,
      timestamp: r.timestamp,
    }));

    let hostingTotal = 0, buildingTotal = 0, networkTotal = 0;
    for (const d of distributions) {
      if (d.role === 'hosting') hostingTotal += d.amount;
      else if (d.role === 'building') buildingTotal += d.amount;
      else if (d.role === 'network') networkTotal += d.amount;
    }

    return {
      contentId,
      totalLux: record.luxEarned,
      hostingShare: hostingTotal,
      buildingShare: buildingTotal,
      networkShare: networkTotal,
      distributions,
    };
  }

  // ── Internal helpers ──

  private insertRecord(record: ContentRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO content_records (
        content_id, type, title, description, owner_peer_id, builder_peer_id,
        repo_url, live_url, hosting_nodes, version, version_hash, status,
        tags, lux_earned, manifest, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.contentId, record.type, record.title, record.description,
      record.ownerPeerId, record.builderPeerId || null,
      record.repoUrl || null, record.liveUrl || null,
      JSON.stringify(record.hostingNodes), record.version,
      record.versionHash, record.status, JSON.stringify(record.tags),
      record.luxEarned, JSON.stringify(record.manifest),
      record.createdAt, record.updatedAt,
    );
  }

  private rowToRecord(row: any): ContentRecord {
    return {
      contentId: row.content_id,
      type: row.type as ContentType,
      title: row.title,
      description: row.description || '',
      ownerPeerId: row.owner_peer_id,
      builderPeerId: row.builder_peer_id || undefined,
      repoUrl: row.repo_url || undefined,
      liveUrl: row.live_url || undefined,
      hostingNodes: safeParse(row.hosting_nodes, []),
      version: row.version,
      versionHash: row.version_hash,
      status: row.status as ContentStatus,
      tags: safeParse(row.tags, []),
      luxEarned: row.lux_earned || 0,
      manifest: safeParse(row.manifest, { upgradePolicy: 'owner-only' }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private computeVersionHash(contentId: string, version: number, title: string): string {
    return createHash('sha256')
      .update(`${contentId}:${version}:${title}:${Date.now()}`)
      .digest('hex')
      .slice(0, 16);
  }

  /** Merge a remote content record (from GossipSub). Higher version wins. */
  private mergeRemoteRecord(remote: ContentRecord): void {
    const local = this.get(remote.contentId);
    if (!local) {
      // New record — insert it
      this.insertRecord(remote);
      console.log(`[content-registry] Merged remote content: ${remote.title} (${remote.contentId.slice(0, 8)})`);
      return;
    }
    // Higher version or more recent update wins
    if (remote.version > local.version || (remote.version === local.version && remote.updatedAt > local.updatedAt)) {
      this.insertRecord(remote);
      console.log(`[content-registry] Updated content from remote: ${remote.title} v${remote.version}`);
    }
  }

  /** Broadcast a content record to the network. */
  private broadcastRecord(record: ContentRecord): void {
    if (!this.network || !this.localPeerId) return;
    this.network.publishToTopic(TOPIC_CONTENT, {
      type: 'content_record' as any,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload: { type: 'content_record', record },
    } as any).catch((err: any) => {
      console.error(`[content-registry] Broadcast failed: ${err.message}`);
    });
  }
}

function safeParse<T>(json: string | undefined | null, fallback: T): T {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}
