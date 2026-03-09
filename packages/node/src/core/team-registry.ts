/**
 * TeamRegistry — manages team routing metadata via SQLite + GossipSub P2P sync.
 *
 * Phase 1 of the Pando team architecture. Teams are the unit of work routing:
 * each team maps to a set of repos, an agent count, and a managing node that
 * heartbeats to prove liveness. Orphaned teams (stale heartbeat) can be
 * re-claimed by any node.
 *
 * Persistence: better-sqlite3 (CJS loaded via createRequire).
 * P2P sync:    GossipSub topic `pando/teams`.
 */

import { createRequire } from 'module';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { dirname } from 'path';

const require = createRequire(import.meta.url);

const log = (msg: string) => console.log('[team-registry]', msg);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamConfig {
  id: string;
  displayName: string;
  managingNode: string | null;
  lastHeartbeat: number | null;
  status: 'active' | 'orphaned';
  repos: string[];
  agentCount: number;
  governanceRequired: boolean;
  createdAt: number;
  createdBy: string | null;
  claimedAt: number | null;
}

interface PandoMessage {
  type: string;
  payload: any;
  from: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOPIC = 'pando/teams';
const DEFAULT_ORPHAN_THRESHOLD_MS = 20 * 60 * 1000;      // 20 min (production)
const DEFAULT_ORPHAN_SCAN_INTERVAL_MS = 5 * 60 * 1000;  // 5 min (production)
const DEV_ORPHAN_THRESHOLD_MS = 2 * 60 * 1000;           // 2 min (dev: ≤8 peers)
const DEV_ORPHAN_SCAN_INTERVAL_MS = 30 * 1000;           // 30s (dev: ≤8 peers)
const DEDUP_CAP = 10_000;

// ---------------------------------------------------------------------------
// TeamRegistry
// ---------------------------------------------------------------------------

export class TeamRegistry {
  private db: any;
  private network: any;
  private selfPeerId: string;
  private processedIds: Set<string> = new Set();
  private processedOrder: string[] = [];
  private orphanScanInterval: any = null;

  /** External callback invoked for each team detected as orphaned. */
  onOrphanDetected: ((team: TeamConfig) => void) | null = null;

  constructor(dbPath: string, network: any, selfPeerId: string) {
    this.network = network;
    this.selfPeerId = selfPeerId;

    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open SQLite (CJS module) with corruption recovery
    const Database = require('better-sqlite3');
    try {
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      // Verify DB integrity on open
      const integrity = this.db.pragma('integrity_check');
      if (integrity[0]?.integrity_check !== 'ok') {
        throw new Error(`integrity_check failed: ${JSON.stringify(integrity[0])}`);
      }
      this.initSchema();
    } catch (err: any) {
      console.error(`[team-registry] CRITICAL: DB corrupted or unreadable: ${err.message}`);
      console.warn(`[team-registry] Recreating DB — team data will re-sync from P2P peers`);
      try { this.db?.close(); } catch {}
      // Delete corrupted DB + WAL/SHM files
      for (const suffix of ['', '-wal', '-shm']) {
        try { if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix); } catch {}
      }
      // Recreate fresh
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.initSchema();
      console.log(`[team-registry] Fresh DB created. Teams will repopulate from P2P sync.`);
    }
  }

  // -----------------------------------------------------------------------
  // Schema
  // -----------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_config (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        managing_node TEXT,
        last_heartbeat INTEGER,
        status TEXT DEFAULT 'active',
        repos TEXT NOT NULL DEFAULT '[]',
        agent_count INTEGER DEFAULT 1,
        governance_required INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        created_by TEXT,
        claimed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_config_status ON team_config(status);
      CREATE INDEX IF NOT EXISTS idx_config_managing ON team_config(managing_node);
    `);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    try {
      this.network.subscribeTopic(TOPIC, (msg: any) => this.handleTeamMessage(msg));

      this.network.onPeerConnect((peerId: string) => {
        setTimeout(() => this.requestSync(peerId), 5_000);
        setTimeout(() => this.requestSync(peerId), 30_000);
      });

      log('started — subscribed to ' + TOPIC);
    } catch (err: any) {
      log('start: network not ready — ' + (err?.message || err));
    }
  }

  stop(): void {
    if (this.orphanScanInterval) {
      clearInterval(this.orphanScanInterval);
      this.orphanScanInterval = null;
    }
    log('stopped');
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  createTeam(config: Omit<TeamConfig, 'createdAt'>): TeamConfig {
    const now = Date.now();
    const full: TeamConfig = { ...config, createdAt: now };

    const row = this.configToRow(full);
    this.db.prepare(`
      INSERT INTO team_config
        (id, display_name, managing_node, last_heartbeat, status, repos, agent_count, governance_required, created_at, created_by, claimed_at)
      VALUES
        (@id, @display_name, @managing_node, @last_heartbeat, @status, @repos, @agent_count, @governance_required, @created_at, @created_by, @claimed_at)
    `).run(row);

    log('created team ' + full.id);
    this.broadcastTeamUpdate(full);
    return full;
  }

  getTeam(id: string): TeamConfig | null {
    const row = this.db.prepare('SELECT * FROM team_config WHERE id = ?').get(id);
    return row ? this.rowToConfig(row) : null;
  }

  listTeams(): TeamConfig[] {
    const rows = this.db.prepare('SELECT * FROM team_config').all();
    return rows.map((r: any) => this.rowToConfig(r));
  }

  updateTeam(id: string, updates: Partial<TeamConfig>): void {
    const existing = this.getTeam(id);
    if (!existing) return;

    const merged: TeamConfig = { ...existing, ...updates, id }; // id is immutable
    const row = this.configToRow(merged);

    this.db.prepare(`
      UPDATE team_config SET
        display_name = @display_name,
        managing_node = @managing_node,
        last_heartbeat = @last_heartbeat,
        status = @status,
        repos = @repos,
        agent_count = @agent_count,
        governance_required = @governance_required,
        created_at = @created_at,
        created_by = @created_by,
        claimed_at = @claimed_at
      WHERE id = @id
    `).run(row);

    this.broadcastTeamUpdate(merged);
  }

  deleteTeam(id: string): void {
    this.db.prepare('DELETE FROM team_config WHERE id = ?').run(id);
    log('deleted team ' + id);
  }

  // -----------------------------------------------------------------------
  // Team operations
  // -----------------------------------------------------------------------

  /**
   * Atomically claim an unclaimed or orphaned team for this node.
   * Returns true if the claim succeeded.
   */
  claimTeam(id: string): boolean {
    const now = Date.now();
    const result = this.db.prepare(`
      UPDATE team_config
      SET managing_node = ?, claimed_at = ?, last_heartbeat = ?, status = 'active'
      WHERE id = ? AND (managing_node IS NULL OR status = 'orphaned')
    `).run(this.selfPeerId, now, now, id);

    if (result.changes > 0) {
      log('claimed team ' + id);
      const team = this.getTeam(id);
      if (team) this.broadcastTeamUpdate(team);
      return true;
    }
    return false;
  }

  /** Update heartbeat timestamp for a team this node manages. */
  updateHeartbeat(id: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE team_config SET last_heartbeat = ?, status = 'active'
      WHERE id = ? AND managing_node = ?
    `).run(now, id, this.selfPeerId);

    const team = this.getTeam(id);
    if (team) this.broadcastTeamUpdate(team);
  }

  /** Return teams whose heartbeat is older than the threshold and not managed by self. */
  getOrphanedTeams(staleThresholdMs: number = DEFAULT_ORPHAN_THRESHOLD_MS): TeamConfig[] {
    const cutoff = Date.now() - staleThresholdMs;
    const rows = this.db.prepare(`
      SELECT * FROM team_config
      WHERE last_heartbeat < ? AND managing_node != ? AND status != 'orphaned'
    `).all(cutoff, this.selfPeerId);
    return rows.map((r: any) => this.rowToConfig(r));
  }

  /** Return all teams managed by a given node. */
  getTeamsForNode(peerId: string): TeamConfig[] {
    const rows = this.db.prepare('SELECT * FROM team_config WHERE managing_node = ?').all(peerId);
    return rows.map((r: any) => this.rowToConfig(r));
  }

  // -----------------------------------------------------------------------
  // P2P sync
  // -----------------------------------------------------------------------

  private handleTeamMessage(msg: any): void {
    const data: PandoMessage = typeof msg === 'string' ? JSON.parse(msg) : msg;

    if (data.from === this.selfPeerId) return;

    switch (data.type) {
      case 'team_config_update': {
        const config: TeamConfig = data.payload;
        if (!config || !config.id) return;

        // Dedup
        const dedupKey = `${data.type}:${config.id}:${config.claimedAt || config.lastHeartbeat}`;
        if (this.processedIds.has(dedupKey)) return;
        this.addProcessedId(dedupKey);

        // Heartbeat-only update: only accept from the managing node
        const existing = this.getTeam(config.id);
        if (existing && this.isHeartbeatOnly(existing, config)) {
          if (data.from !== config.managingNode) return;
        }

        this.mergeTeamConfig(config);
        break;
      }

      case 'team_sync_request': {
        const since: number = data.payload?.since || 0;
        this.respondWithTeams(data.from, since);
        break;
      }

      case 'team_sync_response': {
        const teams: TeamConfig[] = data.payload?.teams || [];
        for (const config of teams) {
          this.mergeTeamConfig(config);
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * Check if the incoming config only differs from existing in lastHeartbeat.
   */
  private isHeartbeatOnly(existing: TeamConfig, incoming: TeamConfig): boolean {
    return (
      existing.managingNode === incoming.managingNode &&
      existing.claimedAt === incoming.claimedAt &&
      existing.agentCount === incoming.agentCount &&
      existing.status === incoming.status &&
      existing.displayName === incoming.displayName &&
      JSON.stringify(existing.repos) === JSON.stringify(incoming.repos) &&
      existing.governanceRequired === incoming.governanceRequired &&
      existing.lastHeartbeat !== incoming.lastHeartbeat
    );
  }

  /**
   * Merge an incoming config into local DB.
   * Conflict resolution: latest claimedAt wins; if equal, latest lastHeartbeat wins.
   * Returns true if the local DB was updated.
   */
  private mergeTeamConfig(config: TeamConfig): boolean {
    const existing = this.getTeam(config.id);

    if (!existing) {
      // New team — insert directly
      const row = this.configToRow(config);
      this.db.prepare(`
        INSERT OR IGNORE INTO team_config
          (id, display_name, managing_node, last_heartbeat, status, repos, agent_count, governance_required, created_at, created_by, claimed_at)
        VALUES
          (@id, @display_name, @managing_node, @last_heartbeat, @status, @repos, @agent_count, @governance_required, @created_at, @created_by, @claimed_at)
      `).run(row);
      return true;
    }

    // Conflict resolution
    const incomingClaimed = config.claimedAt || 0;
    const existingClaimed = existing.claimedAt || 0;

    let shouldUpdate = false;

    if (incomingClaimed > existingClaimed) {
      shouldUpdate = true;
    } else if (incomingClaimed === existingClaimed) {
      const incomingHb = config.lastHeartbeat || 0;
      const existingHb = existing.lastHeartbeat || 0;
      if (incomingHb > existingHb) {
        shouldUpdate = true;
      }
    }

    if (shouldUpdate) {
      const row = this.configToRow(config);
      this.db.prepare(`
        UPDATE team_config SET
          display_name = @display_name,
          managing_node = @managing_node,
          last_heartbeat = @last_heartbeat,
          status = @status,
          repos = @repos,
          agent_count = @agent_count,
          governance_required = @governance_required,
          created_at = @created_at,
          created_by = @created_by,
          claimed_at = @claimed_at
        WHERE id = @id
      `).run(row);
      return true;
    }

    return false;
  }

  private broadcastTeamUpdate(config: TeamConfig): void {
    try {
      const msg: PandoMessage = {
        type: 'team_config_update',
        payload: config,
        from: this.selfPeerId,
        timestamp: Date.now(),
      };
      this.network.publishToTopic(TOPIC, msg);
    } catch (err: any) {
      log('broadcastTeamUpdate failed — ' + (err?.message || err));
    }
  }

  private requestSync(peerId: string): void {
    try {
      const msg: PandoMessage = {
        type: 'team_sync_request',
        payload: { since: 0 },
        from: this.selfPeerId,
        timestamp: Date.now(),
      };
      this.network.publishToTopic(TOPIC, msg);
    } catch (err: any) {
      log('requestSync failed for ' + peerId + ' — ' + (err?.message || err));
    }
  }

  private respondWithTeams(peerId: string, since: number): void {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM team_config WHERE last_heartbeat >= ? OR claimed_at >= ? OR created_at >= ?
      `).all(since, since, since);

      const teams = rows.map((r: any) => this.rowToConfig(r));

      const msg: PandoMessage = {
        type: 'team_sync_response',
        payload: { teams },
        from: this.selfPeerId,
        timestamp: Date.now(),
      };
      this.network.publishToTopic(TOPIC, msg);
    } catch (err: any) {
      log('respondWithTeams failed — ' + (err?.message || err));
    }
  }

  // -----------------------------------------------------------------------
  // Orphan management
  // -----------------------------------------------------------------------

  private orphanThresholdMs: number = DEFAULT_ORPHAN_THRESHOLD_MS;

  startOrphanScan(intervalMs: number = DEFAULT_ORPHAN_SCAN_INTERVAL_MS, thresholdMs?: number): void {
    if (this.orphanScanInterval) {
      clearInterval(this.orphanScanInterval);
    }
    if (thresholdMs) this.orphanThresholdMs = thresholdMs;
    this.orphanScanInterval = setInterval(() => this.scanForOrphans(), intervalMs);
    log(`orphan scan started — interval ${intervalMs}ms, threshold ${this.orphanThresholdMs}ms`);
  }

  /** Use fast orphan detection for small networks (≤8 peers). */
  startOrphanScanDevMode(): void {
    this.startOrphanScan(DEV_ORPHAN_SCAN_INTERVAL_MS, DEV_ORPHAN_THRESHOLD_MS);
  }

  private scanForOrphans(): void {
    const orphans = this.getOrphanedTeams(this.orphanThresholdMs);
    if (orphans.length === 0) return;

    log('orphan scan found ' + orphans.length + ' orphaned team(s)');

    for (const team of orphans) {
      // Mark as orphaned in DB
      this.db.prepare(`UPDATE team_config SET status = 'orphaned' WHERE id = ?`).run(team.id);

      if (this.onOrphanDetected) {
        this.onOrphanDetected({ ...team, status: 'orphaned' });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Dedup helpers
  // -----------------------------------------------------------------------

  private addProcessedId(key: string): void {
    this.processedIds.add(key);
    this.processedOrder.push(key);

    // Evict oldest when cap exceeded
    while (this.processedOrder.length > DEDUP_CAP) {
      const oldest = this.processedOrder.shift()!;
      this.processedIds.delete(oldest);
    }
  }

  // -----------------------------------------------------------------------
  // Row / Config conversion
  // -----------------------------------------------------------------------

  private rowToConfig(row: any): TeamConfig {
    return {
      id: row.id,
      displayName: row.display_name,
      managingNode: row.managing_node ?? null,
      lastHeartbeat: row.last_heartbeat ?? null,
      status: row.status as 'active' | 'orphaned',
      repos: JSON.parse(row.repos || '[]'),
      agentCount: row.agent_count ?? 1,
      governanceRequired: row.governance_required === 1,
      createdAt: row.created_at,
      createdBy: row.created_by ?? null,
      claimedAt: row.claimed_at ?? null,
    };
  }

  private configToRow(config: TeamConfig): any {
    return {
      id: config.id,
      display_name: config.displayName,
      managing_node: config.managingNode ?? null,
      last_heartbeat: config.lastHeartbeat ?? null,
      status: config.status,
      repos: JSON.stringify(config.repos),
      agent_count: config.agentCount,
      governance_required: config.governanceRequired ? 1 : 0,
      created_at: config.createdAt,
      created_by: config.createdBy ?? null,
      claimed_at: config.claimedAt ?? null,
    };
  }
}
