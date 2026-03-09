/**
 * Resource Registry — P2P metadata registry for shared resources.
 *
 * Phase 69: The registry syncs METADATA ONLY via GossipSub. No credentials
 * are stored in SQLite or transmitted over P2P. Credentials are stored
 * encrypted in MongoDB via CredentialStore, decryptable only by EC2 compute
 * nodes with CREDENTIAL_MASTER_KEY.
 *
 * Architecture:
 * - GossipSub subscribe/publish for P2P metadata replication
 * - In-memory Map + SQLite persistence (metadata only)
 * - CredentialStore (MongoDB) for encrypted credential CRUD
 * - Cleanup interval for expired resources
 */

import type { PandoNetwork } from '../kernel/network.js';
import type { PandoMessage, ResourceRecord, ResourceCredentialType } from '@pando/shared';
import type Database from 'better-sqlite3';
import type { CredentialStore } from '../core/credential-store.js';
import { randomUUID } from 'node:crypto';

export const TOPIC_RESOURCES = 'pando/resources';

/** Minimal ledger interface for Lux charges (#5) */
interface LedgerLike {
  transfer(from: string, to: string, amount: number): any;
  accounts: { getBalance(peerId: string): number };
}

export class ResourceRegistry {
  private network: PandoNetwork;
  private localPeerId: string;
  private db: Database.Database;
  private credentialStore: CredentialStore | null = null;
  // P2P proxy: used by non-secure nodes to request credential decryption from compute peers
  private p2pCredentialProxy: ((resourceId: string, type: string) => Promise<string | null>) | null = null;
  // #5: Ledger for charging pricePerUnit
  private ledger: LedgerLike | null = null;

  private resources: Map<string, ResourceRecord> = new Map();
  private processedIds: Set<string> = new Set();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  // SQLite prepared statements — lazily prepared and re-prepared on error (M2-3)
  private _stmtInsert: Database.Statement | null = null;
  private _stmtUpdateStatus: Database.Statement | null = null;
  private _stmtUpdateUserId: Database.Statement | null = null;

  constructor(network: PandoNetwork, localPeerId: string, db: Database.Database) {
    this.network = network;
    this.localPeerId = localPeerId;
    this.db = db;
  }

  /** M2-3: Lazy statement preparation — prepares on first use, re-prepares on error. */
  private get stmtInsert(): Database.Statement {
    if (!this._stmtInsert) {
      this._stmtInsert = this.db.prepare(`
        INSERT OR REPLACE INTO resource_registry
        (resource_id, type, user_id, granted_to, max_usage_per_day, price_per_unit, registered_at, expires_at, status, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }
    return this._stmtInsert;
  }
  private get stmtUpdateStatus(): Database.Statement {
    if (!this._stmtUpdateStatus) {
      this._stmtUpdateStatus = this.db.prepare(`UPDATE resource_registry SET status = ? WHERE resource_id = ?`);
    }
    return this._stmtUpdateStatus;
  }
  private get stmtUpdateUserId(): Database.Statement {
    if (!this._stmtUpdateUserId) {
      this._stmtUpdateUserId = this.db.prepare(`UPDATE resource_registry SET user_id = ? WHERE resource_id = ?`);
    }
    return this._stmtUpdateUserId;
  }
  /** Invalidate cached statements (call after DB reconnect or on statement error). */
  private invalidateStatements(): void {
    this._stmtInsert = null;
    this._stmtUpdateStatus = null;
    this._stmtUpdateUserId = null;
  }

  /** Set the CredentialStore (available after MongoDB connects) */
  setCredentialStore(store: CredentialStore): void {
    this.credentialStore = store;
    console.log(`[resources] CredentialStore attached (decryption: ${store.hasDecryptionCapability() ? 'YES' : 'NO'})`);
  }

  /** #5: Set ledger for pricePerUnit charging */
  setLedger(ledger: LedgerLike): void {
    this.ledger = ledger;
  }

  /** Set P2P credential proxy — called by non-secure nodes that lack CREDENTIAL_MASTER_KEY.
   *  Only proxies code_repository credentials; S3/MongoDB credentials must stay on EC2. */
  setP2PCredentialProxy(fn: (resourceId: string, type: string) => Promise<string | null>): void {
    this.p2pCredentialProxy = fn;
    console.log('[resources] P2P credential proxy registered (non-secure node mode)');
  }

  async start(): Promise<void> {
    // Phase 69: Metadata-only SQLite table — no credential columns
    // Migration: drop old table if it has encrypted_credential column
    try {
      const info = this.db.pragma('table_info(resource_registry)') as any[];
      const hasOldColumns = info.some((col: any) => col.name === 'encrypted_credential');
      if (hasOldColumns) {
        console.log('[resources] Migrating: dropping old resource_registry table (Phase 69 — credentials moved to MongoDB)');
        this.db.exec('DROP TABLE resource_registry');
      }
    } catch { /* table doesn't exist yet */ }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resource_registry (
        resource_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        user_id TEXT,
        granted_to TEXT NOT NULL,
        max_usage_per_day INTEGER DEFAULT 0,
        price_per_unit REAL DEFAULT 0,
        registered_at INTEGER NOT NULL,
        expires_at INTEGER,
        status TEXT DEFAULT 'active',
        metadata TEXT
      )
    `);

    // M2-3: Statements are now lazily prepared via getters (stmtInsert, stmtUpdateStatus, stmtUpdateUserId).
    // Invalidate any previously cached statements in case the DB was reconnected.
    this.invalidateStatements();

    // Load metadata from SQLite
    const rows = this.db.prepare('SELECT * FROM resource_registry').all() as any[];
    for (const row of rows) {
      let grantedTo: string[];
      try {
        grantedTo = JSON.parse(row.granted_to);
      } catch {
        console.error(`[resources] Malformed granted_to JSON for resource ${row.resource_id}, defaulting to ['*']`);
        grantedTo = ['*'];
      }
      let metadata: any;
      try {
        metadata = row.metadata ? JSON.parse(row.metadata) : undefined;
      } catch {
        console.error(`[resources] Malformed metadata JSON for resource ${row.resource_id}, skipping metadata`);
        metadata = undefined;
      }
      const record: ResourceRecord = {
        resourceId: row.resource_id,
        type: row.type,
        userId: row.user_id || undefined,
        grantedTo,
        maxUsagePerDay: row.max_usage_per_day,
        pricePerUnit: row.price_per_unit,
        registeredAt: row.registered_at,
        expiresAt: row.expires_at,
        status: row.status,
        metadata,
      };
      this.resources.set(record.resourceId, record);
    }
    console.log(`[resources] Loaded ${this.resources.size} resources from database`);

    // Subscribe to GossipSub
    await this.network.subscribeTopic(TOPIC_RESOURCES, (message: PandoMessage) => {
      this.handleMessage(message);
    });

    // Cleanup interval: every 60s, check expired resources
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 60_000);
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /** Register a new resource. Stores credential in MongoDB, broadcasts metadata via P2P. */
  async registerResource(
    type: ResourceCredentialType,
    credential: string,
    options: {
      userId?: string;
      grantedTo?: string[];
      maxUsagePerDay?: number;
      pricePerUnit?: number;
      expiresAt?: number | null;
      metadata?: Record<string, any>;
    } = {},
  ): Promise<ResourceRecord> {
    const resourceId = randomUUID();
    const grantedTo = options.grantedTo || ['*'];

    // Store credential in MongoDB (requires CREDENTIAL_MASTER_KEY)
    if (!this.credentialStore) {
      throw new Error('Cannot register resource: no CredentialStore (MongoDB not connected)');
    }
    if (!this.credentialStore.hasDecryptionCapability()) {
      throw new Error('Cannot register resource: this node does not have CREDENTIAL_MASTER_KEY (route to a compute node)');
    }

    await this.credentialStore.storeCredential(resourceId, type, credential, {
      userId: options.userId,
      grantedTo,
      maxUsagePerDay: options.maxUsagePerDay,
      pricePerUnit: options.pricePerUnit,
      expiresAt: options.expiresAt,
      metadata: options.metadata,
    });

    // Create metadata-only record (no credential data)
    const record: ResourceRecord = {
      resourceId,
      type,
      userId: options.userId,
      grantedTo,
      maxUsagePerDay: options.maxUsagePerDay ?? 0,
      pricePerUnit: options.pricePerUnit ?? 0,
      registeredAt: Date.now(),
      expiresAt: options.expiresAt ?? null,
      status: 'active',
      metadata: options.metadata,
    };

    // Persist metadata to SQLite
    this.persistRecord(record);
    this.resources.set(record.resourceId, record);

    // Broadcast metadata to network (no credentials in message)
    await this.broadcast('resource_register', record);
    console.log(`[resources] Registered ${type} resource ${record.resourceId}`);
    return record;
  }

  /** Revoke a resource. Owner (userId) can do this. */
  async revokeResource(resourceId: string, userId?: string): Promise<boolean> {
    const record = this.resources.get(resourceId);
    if (!record) return false;

    // Check ownership: userId match
    if (userId && record.userId && record.userId !== userId) return false;

    record.status = 'revoked';
    this.stmtUpdateStatus.run('revoked', resourceId);

    // Revoke in MongoDB too
    if (this.credentialStore) {
      await this.credentialStore.revokeCredential(resourceId, userId);
    }

    await this.broadcast('resource_revoke', { resourceId, userId: record.userId });
    console.log(`[resources] Revoked resource ${resourceId}`);
    return true;
  }

  /** Find active resources by type (metadata only) */
  findResources(type: ResourceCredentialType): ResourceRecord[] {
    const now = Date.now();
    const results: ResourceRecord[] = [];
    for (const record of this.resources.values()) {
      if (record.type !== type) continue;
      if (record.status !== 'active') continue;
      if (record.expiresAt && record.expiresAt < now) continue;
      results.push(record);
    }
    return results;
  }

  /** Decrypt a credential via CredentialStore (MongoDB), or via P2P proxy on non-secure nodes.
   *  @param requestingPeerId — If provided, used for grantedTo checks and pricePerUnit charging. */
  async getCredential(resourceId: string, requestingPeerId?: string): Promise<string | null> {
    const record = this.resources.get(resourceId);
    if (!record || record.status !== 'active') return null;

    // #5: Check pricePerUnit — if > 0, attempt to charge the requester
    if (record.pricePerUnit > 0 && requestingPeerId && record.userId) {
      if (!this.ledger) {
        console.warn(`[resources] Cannot charge for resource ${resourceId.slice(0, 8)}: no ledger available`);
        return null;
      }
      const balance = this.ledger.accounts.getBalance(requestingPeerId);
      if (balance < record.pricePerUnit) {
        console.log(`[resources] Requester ${requestingPeerId.slice(0, 12)} cannot afford resource ${resourceId.slice(0, 8)} (balance: ${balance}, price: ${record.pricePerUnit})`);
        return null;
      }
      try {
        this.ledger.transfer(requestingPeerId, record.userId, record.pricePerUnit);
        console.log(`[resources] Charged ${record.pricePerUnit} Lux from ${requestingPeerId.slice(0, 12)} to resource owner ${record.userId.slice(0, 12)}`);
      } catch (err: any) {
        console.warn(`[resources] Lux charge failed for resource ${resourceId.slice(0, 8)}: ${err.message}`);
        return null;
      }
    }

    // Try local decryption first (EC2 nodes with CREDENTIAL_MASTER_KEY)
    if (this.credentialStore) {
      const local = await this.credentialStore.getCredential(resourceId, requestingPeerId);
      if (local !== null) return local;
    }

    // Fall back to P2P proxy (non-secure nodes — only allowed for code_repository credentials)
    if (this.p2pCredentialProxy && record.type === 'code_repository') {
      return this.p2pCredentialProxy(resourceId, record.type);
    }

    return null;
  }

  /** Get the first available AI API key, decrypted and ready to use */
  async getActiveAiKey(): Promise<{ key: string; provider: string; model: string; resourceId: string } | null> {
    if (!this.credentialStore) return null;
    const result = await this.credentialStore.getActiveByType('ai_api_key');
    if (!result) return null;
    return {
      key: result.credential,
      provider: result.metadata?.provider || 'openai',
      model: result.metadata?.model || 'gpt-4o-mini',
      resourceId: result.resourceId,
    };
  }

  /** Get a single resource (metadata only) */
  getResource(resourceId: string): ResourceRecord | null {
    return this.resources.get(resourceId) || null;
  }

  /** Get resources by owner userId */
  getOwnerResources(userId: string): ResourceRecord[] {
    return Array.from(this.resources.values()).filter(r => r.userId === userId);
  }

  /** Update a resource's userId (link to a user account). */
  updateResourceUserId(resourceId: string, newUserId: string, requesterId?: string): boolean {
    const record = this.resources.get(resourceId);
    if (!record) return false;

    if (requesterId) {
      const isOwner = !record.userId || record.userId === requesterId;
      if (!isOwner) return false;
    }

    record.userId = newUserId;
    this.stmtUpdateUserId.run(newUserId, resourceId);
    return true;
  }

  /** Get all resources (metadata — safe for API responses) */
  getAllResources(): ResourceRecord[] {
    return Array.from(this.resources.values());
  }

  /**
   * Resolve a GitHub credential for a given repo URL.
   * Checks user-scoped credentials first, then any active code_repository credential on this node.
   * Returns an authenticated URL or null if no credential available.
   */
  async resolveGitCredential(repoUrl: string, userId?: string): Promise<string | null> {
    // Find active code_repository resources
    const codeResources = this.findResources('code_repository' as ResourceCredentialType);
    if (codeResources.length === 0) return null;

    // 1. If userId provided, look for user-scoped credential first
    let resource: ResourceRecord | undefined;
    if (userId) {
      resource = codeResources.find(r => r.userId === userId);
    }
    // 2. Fall back to any active code_repository credential
    if (!resource) {
      resource = codeResources[0];
    }

    // 3. Decrypt the PAT
    const pat = await this.getCredential(resource.resourceId);
    if (!pat) return null;

    // 4. Inject PAT into the URL
    try {
      const url = new URL(repoUrl);
      if (url.hostname !== 'github.com') return null;
      url.username = 'x-access-token';
      url.password = pat;
      return url.toString();
    } catch {
      // URL parsing failed — try regex-based approach for non-standard URLs
      const stripped = repoUrl.replace(/https:\/\/[^@]+@github\.com\//, 'https://github.com/');
      const cleaned = stripped.replace(/https:\/\/github\.com\//, '');
      return `https://x-access-token:${pat}@github.com/${cleaned}`;
    }
  }

  /** Handle incoming GossipSub message */
  private handleMessage(message: PandoMessage): void {
    const payload = message.payload as any;
    if (!payload) return;

    // Dedup
    const msgId = payload.resourceId || payload.resource?.resourceId;
    const dedupKey = `${message.type}:${msgId}:${message.timestamp}`;
    if (this.processedIds.has(dedupKey)) return;
    this.processedIds.add(dedupKey);

    // Don't process our own broadcasts
    if (message.from === this.localPeerId) return;

    switch (message.type) {
      case 'resource_register':
        this.handleRemoteRegister(payload as ResourceRecord);
        break;
      case 'resource_revoke':
        this.handleRemoteRevoke(payload);
        break;
    }
  }

  private handleRemoteRegister(record: ResourceRecord): void {
    if (this.resources.has(record.resourceId)) return;
    this.persistRecord(record);
    this.resources.set(record.resourceId, record);
    console.log(`[resources] Received ${record.type} resource ${record.resourceId} from P2P`);
  }

  private handleRemoteRevoke(payload: { resourceId: string; userId?: string }): void {
    const record = this.resources.get(payload.resourceId);
    if (!record) return;
    record.status = 'revoked';
    this.stmtUpdateStatus.run('revoked', payload.resourceId);
    console.log(`[resources] Resource ${payload.resourceId} revoked via P2P`);
  }

  private persistRecord(record: ResourceRecord): void {
    this.stmtInsert.run(
      record.resourceId,
      record.type,
      record.userId || null,
      JSON.stringify(record.grantedTo),
      record.maxUsagePerDay,
      record.pricePerUnit,
      record.registeredAt,
      record.expiresAt,
      record.status,
      record.metadata ? JSON.stringify(record.metadata) : null,
    );
  }

  private async broadcast(type: string, payload: any): Promise<void> {
    try {
      await this.network.publishToTopic(TOPIC_RESOURCES, {
        type: type as any,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload,
      });
    } catch (err) {
      console.error(`[resources] Broadcast failed: ${(err as Error).message}`);
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, record] of this.resources) {
      if (record.expiresAt && record.expiresAt < now && record.status === 'active') {
        record.status = 'exhausted';
        this.stmtUpdateStatus.run('exhausted', id);
        console.log(`[resources] Resource ${id} expired`);
      }
    }
    // Prune old processedIds (keep last 10000)
    if (this.processedIds.size > 10000) {
      const arr = Array.from(this.processedIds);
      this.processedIds = new Set(arr.slice(arr.length - 5000));
    }
  }
}
