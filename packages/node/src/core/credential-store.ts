/**
 * CredentialStore — MongoDB-based encrypted credential storage.
 *
 * Phase 69: Credentials stored encrypted in MongoDB, decryptable ONLY by nodes
 * with the CREDENTIAL_MASTER_KEY environment variable (EC2 compute instances).
 * User-run nodes never have the key — they route credential requests via P2P.
 *
 * Encryption: AES-256-GCM with master key + random nonce per credential.
 * Master key: 256-bit, from CREDENTIAL_MASTER_KEY env var (hex string).
 */

import { encryptCredential, decryptCredential } from './credential-vault.js';
import type { ResourceCredentialType } from '@pando/shared';

// MongoDB types — dynamic import to avoid hard dependency
type Db = any;
type Collection = any;

const COLLECTION_NAME = 'pando_credentials';

export interface CredentialMetadata {
  resourceId: string;
  type: ResourceCredentialType;
  userId?: string;
  status: 'active' | 'revoked' | 'exhausted';
  grantedTo: string[];
  maxUsagePerDay: number;
  pricePerUnit: number;
  registeredAt: number;
  expiresAt: number | null;
  metadata?: Record<string, any>;
}

export class CredentialStore {
  private db: Db;
  private masterKey: Uint8Array | null;
  private collection: Collection | null = null;
  /** Track last usage time per credential for LRU selection */
  private lastUsedAt: Map<string, number> = new Map();
  /** Track consecutive health check failures per credential */
  private healthFailures: Map<string, number> = new Map();
  /** Credentials marked unhealthy after consecutive failures */
  private unhealthyCredentials: Set<string> = new Set();
  /** Daily usage counts per credential (keyed by `credId:YYYY-MM-DD`) */
  private dailyUsageCounts: Map<string, number> = new Map();

  constructor(db: Db, masterKeyHex?: string) {
    this.db = db;
    this.masterKey = masterKeyHex
      ? Buffer.from(masterKeyHex, 'hex')
      : null;
    if (this.masterKey && this.masterKey.length !== 32) {
      throw new Error(`CREDENTIAL_MASTER_KEY must be 64 hex chars (32 bytes), got ${masterKeyHex!.length} chars`);
    }
  }

  async init(): Promise<void> {
    this.collection = this.db.collection(COLLECTION_NAME);
    // Create indexes
    try {
      await this.collection.createIndex({ type: 1 });
      await this.collection.createIndex({ userId: 1 });
      await this.collection.createIndex({ status: 1 });
      await this.collection.createIndex({ type: 1, status: 1 });
      console.log(`[credential-store] Initialized (decryption: ${this.hasDecryptionCapability() ? 'YES' : 'NO'})`);
    } catch (err: any) {
      console.warn(`[credential-store] Index creation warning: ${err.message}`);
    }
  }

  /** Returns true if this node can encrypt/decrypt credentials (has master key) */
  hasDecryptionCapability(): boolean {
    return this.masterKey !== null;
  }

  /**
   * v2.4: Active tripwire wipe — zero out the master key in memory.
   * Called when a security compromise is detected. After wipe:
   * - hasDecryptionCapability() returns false
   * - All subsequent getCredential() calls return null
   * - The key cannot be recovered without process restart with the env var
   */
  wipe(): void {
    if (this.masterKey) {
      (this.masterKey as Buffer).fill(0);
      this.masterKey = null;
      console.warn('[credential-store] TRIPWIRE: Master key wiped from memory. Credential decryption disabled.');
    }
  }

  /** Store an encrypted credential in MongoDB */
  async storeCredential(
    resourceId: string,
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
  ): Promise<CredentialMetadata> {
    if (!this.masterKey) {
      throw new Error('Cannot store credentials: CREDENTIAL_MASTER_KEY not set (this node is not a credential node)');
    }
    if (!this.collection) throw new Error('CredentialStore not initialized');

    const { ciphertext, nonce } = encryptCredential(credential, this.masterKey);

    const doc = {
      _id: resourceId,
      type,
      userId: options.userId || null,
      encryptedCredential: ciphertext,
      nonce,
      status: 'active' as const,
      grantedTo: options.grantedTo || ['*'],
      maxUsagePerDay: options.maxUsagePerDay || 0,
      pricePerUnit: options.pricePerUnit || 0,
      registeredAt: Date.now(),
      expiresAt: options.expiresAt ?? null,
      metadata: options.metadata || null,
    };

    await this.collection.updateOne(
      { _id: resourceId },
      { $set: doc },
      { upsert: true },
    );

    console.log(`[credential-store] Stored ${type} credential ${resourceId.slice(0, 8)}...`);

    return {
      resourceId,
      type,
      userId: doc.userId || undefined,
      status: doc.status,
      grantedTo: doc.grantedTo,
      maxUsagePerDay: doc.maxUsagePerDay,
      pricePerUnit: doc.pricePerUnit,
      registeredAt: doc.registeredAt,
      expiresAt: doc.expiresAt,
      metadata: doc.metadata || undefined,
    };
  }

  /** Decrypt and return a credential by resource ID.
   *  @param requestingPeerId — If provided, checks grantedTo permissions. */
  async getCredential(resourceId: string, requestingPeerId?: string): Promise<string | null> {
    if (!this.masterKey) return null;
    if (!this.collection) return null;

    try {
      const doc = await this.collection.findOne({ _id: resourceId, status: 'active' });
      if (!doc) return null;

      // Check expiry
      if (doc.expiresAt && doc.expiresAt < Date.now()) {
        await this.collection.updateOne({ _id: resourceId }, { $set: { status: 'exhausted' } });
        return null;
      }

      // #6: Check grantedTo permissions
      if (requestingPeerId && doc.grantedTo) {
        const granted = doc.grantedTo as string[];
        if (!granted.includes('*') && !granted.includes(requestingPeerId)) {
          return null;
        }
      }

      // #3: Skip unhealthy credentials
      if (this.unhealthyCredentials.has(resourceId)) {
        return null;
      }

      // #2: Check daily usage cap
      if (doc.maxUsagePerDay && doc.maxUsagePerDay > 0) {
        const today = new Date().toISOString().slice(0, 10);
        const usageKey = `${resourceId}:${today}`;
        const currentUsage = this.dailyUsageCounts.get(usageKey) || 0;
        if (currentUsage >= doc.maxUsagePerDay) {
          return null;
        }
        this.dailyUsageCounts.set(usageKey, currentUsage + 1);
      }

      // #1: Track last usage for LRU
      this.lastUsedAt.set(resourceId, Date.now());

      return decryptCredential(doc.encryptedCredential, doc.nonce, this.masterKey);
    } catch (err: any) {
      console.error(`[credential-store] Failed to decrypt ${resourceId.slice(0, 8)}: ${err.message}`);
      return null;
    }
  }

  /** Get the least-recently-used active credential of a given type, decrypted.
   *  Sorts by lastUsedAt ascending (#1), skips unhealthy (#3), daily-capped (#2),
   *  and permission-restricted (#6) credentials.
   *  @param requestingPeerId — If provided, checks grantedTo permissions. */
  async getActiveByType(type: ResourceCredentialType, requestingPeerId?: string): Promise<{
    credential: string;
    resourceId: string;
    metadata: Record<string, any> | null;
  } | null> {
    if (!this.masterKey) return null;
    if (!this.collection) return null;

    try {
      const docs = await this.collection.find({ type, status: 'active' }).toArray();
      const now = Date.now();
      const today = new Date().toISOString().slice(0, 10);

      // #1: Sort by lastUsedAt ascending (least recently used first)
      docs.sort((a: any, b: any) => {
        const aTime = this.lastUsedAt.get(a._id) || 0;
        const bTime = this.lastUsedAt.get(b._id) || 0;
        return aTime - bTime;
      });

      for (const doc of docs) {
        // Skip expired
        if (doc.expiresAt && doc.expiresAt < now) continue;

        // #3: Skip unhealthy credentials
        if (this.unhealthyCredentials.has(doc._id)) continue;

        // #6: Check grantedTo permissions
        if (requestingPeerId && doc.grantedTo) {
          const granted = doc.grantedTo as string[];
          if (!granted.includes('*') && !granted.includes(requestingPeerId)) continue;
        }

        // #2: Check daily usage cap
        if (doc.maxUsagePerDay && doc.maxUsagePerDay > 0) {
          const usageKey = `${doc._id}:${today}`;
          const currentUsage = this.dailyUsageCounts.get(usageKey) || 0;
          if (currentUsage >= doc.maxUsagePerDay) continue;
        }

        try {
          const credential = decryptCredential(doc.encryptedCredential, doc.nonce, this.masterKey);

          // #1: Update last usage time
          this.lastUsedAt.set(doc._id, now);

          // #2: Increment daily usage count
          if (doc.maxUsagePerDay && doc.maxUsagePerDay > 0) {
            const usageKey = `${doc._id}:${today}`;
            const currentUsage = this.dailyUsageCounts.get(usageKey) || 0;
            this.dailyUsageCounts.set(usageKey, currentUsage + 1);
          }

          return { credential, resourceId: doc._id, metadata: doc.metadata };
        } catch {
          continue; // Try next if decryption fails
        }
      }
      return null;
    } catch (err: any) {
      console.error(`[credential-store] Failed to get active ${type}: ${err.message}`);
      return null;
    }
  }

  /** #3: Mark a credential as healthy or unhealthy based on health check results.
   *  Called by ResourceHealthChecker. After 3 consecutive failures, credential
   *  is marked unhealthy and skipped by getActiveByType() / getCredential(). */
  markHealthStatus(resourceId: string, healthy: boolean): void {
    if (healthy) {
      this.healthFailures.delete(resourceId);
      this.unhealthyCredentials.delete(resourceId);
    } else {
      const failures = (this.healthFailures.get(resourceId) || 0) + 1;
      this.healthFailures.set(resourceId, failures);
      if (failures >= 3) {
        this.unhealthyCredentials.add(resourceId);
        console.warn(`[credential-store] Credential ${resourceId.slice(0, 8)} marked unhealthy after ${failures} consecutive failures`);
      }
    }
  }

  /** Check if a credential is marked unhealthy. */
  isUnhealthy(resourceId: string): boolean {
    return this.unhealthyCredentials.has(resourceId);
  }

  /** Revoke a credential */
  async revokeCredential(resourceId: string, userId?: string): Promise<boolean> {
    if (!this.collection) return false;
    try {
      const filter: any = { _id: resourceId };
      if (userId) filter.userId = userId; // Only owner can revoke
      const result = await this.collection.updateOne(filter, { $set: { status: 'revoked' } });
      if (result.modifiedCount > 0) {
        console.log(`[credential-store] Revoked credential ${resourceId.slice(0, 8)}...`);
        return true;
      }
      return false;
    } catch (err: any) {
      console.error(`[credential-store] Revoke failed: ${err.message}`);
      return false;
    }
  }

  /** List credential metadata (no decryption — works on any node with MongoDB access) */
  async listMetadata(filter?: { type?: ResourceCredentialType; userId?: string; status?: string }): Promise<CredentialMetadata[]> {
    if (!this.collection) return [];
    try {
      const query: any = {};
      if (filter?.type) query.type = filter.type;
      if (filter?.userId) query.userId = filter.userId;
      if (filter?.status) query.status = filter.status;

      const docs = await this.collection.find(query).toArray();
      return docs.map((doc: any) => ({
        resourceId: doc._id,
        type: doc.type,
        userId: doc.userId || undefined,
        status: doc.status,
        grantedTo: doc.grantedTo || ['*'],
        maxUsagePerDay: doc.maxUsagePerDay || 0,
        pricePerUnit: doc.pricePerUnit || 0,
        registeredAt: doc.registeredAt,
        expiresAt: doc.expiresAt,
        metadata: doc.metadata || undefined,
      }));
    } catch (err: any) {
      console.error(`[credential-store] listMetadata failed: ${err.message}`);
      return [];
    }
  }
}
