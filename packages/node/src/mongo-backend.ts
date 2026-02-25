/**
 * MongoStorageBackend — MongoDB implementation of StorageBackend.
 *
 * Phase 42: Stores user data (threads, messages, user accounts, auth sessions)
 * in MongoDB Atlas, making nodes stateless for user data.
 *
 * Collections map 1:1: putRecord('threads', id, data) → db.collection('threads').upsert({_id: id}, data)
 */

import type { StorageBackend } from './storage-backend.js';

// MongoDB types — imported dynamically to avoid hard dependency when not used
type MongoClient = any;
type Db = any;
type Collection = any;

export class MongoStorageBackend implements StorageBackend {
  private connectionUrl: string;
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private connected = false;

  constructor(connectionUrl: string) {
    this.connectionUrl = connectionUrl;
  }

  async init(): Promise<void> {
    // Dynamic import — mongodb package only loaded when this backend is used
    let MongoClientClass: any;
    try {
      const mongodb = await import('mongodb');
      MongoClientClass = mongodb.MongoClient;
    } catch (err: any) {
      throw new Error(
        `MongoDB driver not available. Install it with: npm install mongodb\n` +
        `Original error: ${err.message}`
      );
    }

    try {
      this.client = new MongoClientClass(this.connectionUrl);
      await this.client.connect();
      this.db = this.client.db(); // Use DB name from connection string
      this.connected = true;
      console.log('[storage] MongoDB connected');

      // Create indexes for efficient queries
      await this.createIndexes();
    } catch (err: any) {
      this.connected = false;
      throw new Error(`MongoDB connection failed: ${err.message}`);
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.connected = false;
      console.log('[storage] MongoDB disconnected');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Get the raw MongoDB Db instance (for CredentialStore, Phase 69) */
  getDb(): any {
    return this.db;
  }

  // ─── Core operations ──────────────────────────────────────────────────

  async putRecord(collection: string, key: string, data: Record<string, any>): Promise<void> {
    this.ensureConnected();
    const coll = this.db!.collection(collection);
    // Remove _id and id from data to avoid immutable-field conflicts on update.
    // _id is set via the filter; id is an artifact from getRecord/queryRecords renaming.
    const { _id, id, ...rest } = data;
    await coll.updateOne(
      { _id: key },
      { $set: rest },
      { upsert: true },
    );
  }

  async getRecord(collection: string, key: string): Promise<Record<string, any> | null> {
    this.ensureConnected();
    const coll = this.db!.collection(collection);
    const doc = await coll.findOne({ _id: key });
    if (!doc) return null;
    // Convert MongoDB _id back to the expected format
    const { _id, ...rest } = doc;
    return { ...rest, id: _id };
  }

  async queryRecords(
    collection: string,
    filter: Record<string, any>,
    options?: { limit?: number; sort?: Record<string, 1 | -1> },
  ): Promise<Record<string, any>[]> {
    this.ensureConnected();
    const coll = this.db!.collection(collection);

    let cursor = coll.find(filter);

    if (options?.sort) {
      cursor = cursor.sort(options.sort);
    }
    if (options?.limit && options.limit > 0) {
      cursor = cursor.limit(options.limit);
    }

    const docs = await cursor.toArray();
    return docs.map((doc: any) => {
      const { _id, ...rest } = doc;
      return { ...rest, id: _id };
    });
  }

  async deleteRecord(collection: string, key: string): Promise<void> {
    this.ensureConnected();
    const coll = this.db!.collection(collection);
    await coll.deleteOne({ _id: key });
  }

  async listRecords(collection: string, filter?: Record<string, any>): Promise<Record<string, any>[]> {
    this.ensureConnected();
    const coll = this.db!.collection(collection);
    const query = filter || {};
    const docs = await coll.find(query).toArray();
    return docs.map((doc: any) => {
      const { _id, ...rest } = doc;
      return { ...rest, id: _id };
    });
  }

  async pushToArray(collection: string, key: string, field: string, value: any): Promise<void> {
    this.ensureConnected();
    const coll = this.db!.collection(collection);
    await coll.updateOne(
      { _id: key },
      { $push: { [field]: value } },
      { upsert: true },
    );
  }

  // ─── Private ──────────────────────────────────────────────────────────

  private ensureConnected(): void {
    if (!this.connected || !this.db) {
      throw new Error('MongoDB is not connected. Call init() first.');
    }
  }

  /**
   * Create indexes for efficient queries.
   * Runs on init() — MongoDB is idempotent with createIndex.
   */
  private async createIndexes(): Promise<void> {
    if (!this.db) return;

    try {
      // threads: index on userId, createdAt
      const threads = this.db.collection('threads');
      await threads.createIndex({ userId: 1 });
      await threads.createIndex({ createdAt: -1 });

      // messages: index on threadId
      const messages = this.db.collection('messages');
      await messages.createIndex({ threadId: 1 });

      // user_accounts: index on username, peerId
      const userAccounts = this.db.collection('user_accounts');
      await userAccounts.createIndex({ username: 1 });
      await userAccounts.createIndex({ peerId: 1 });

      // Phase 44: Project data collections
      const projects = this.db.collection('projects');
      await projects.createIndex({ ownerId: 1 });
      await projects.createIndex({ status: 1 });
      await projects.createIndex({ visibility: 1 });
      await projects.createIndex({ updatedAt: -1 });
      await projects.createIndex({ visibility: 1, status: 1 });

      const projectCollaborators = this.db.collection('project_collaborators');
      await projectCollaborators.createIndex({ projectId: 1 });
      await projectCollaborators.createIndex({ userId: 1 });

      const projectInvites = this.db.collection('project_invites');
      await projectInvites.createIndex({ code: 1 }, { unique: true });
      await projectInvites.createIndex({ projectId: 1 });

      const projectTransfers = this.db.collection('project_transfers');
      await projectTransfers.createIndex({ projectId: 1 });
      await projectTransfers.createIndex({ status: 1 });

      const projectDeployments = this.db.collection('project_deployments');
      await projectDeployments.createIndex({ projectId: 1 });

      const projectRatings = this.db.collection('project_ratings');
      await projectRatings.createIndex({ projectId: 1 });

      const contentReports = this.db.collection('content_reports');
      await contentReports.createIndex({ projectId: 1 });
      await contentReports.createIndex({ status: 1 });
      await contentReports.createIndex({ reporterId: 1 });

      // Phase 44: Revenue collections
      const projectRevenue = this.db.collection('project_revenue');
      await projectRevenue.createIndex({ projectId: 1 });
      await projectRevenue.createIndex({ createdAt: -1 });

      const revenueDistributions = this.db.collection('revenue_distributions');
      await revenueDistributions.createIndex({ projectId: 1 });

      const projectSubscriptions = this.db.collection('project_subscriptions');
      await projectSubscriptions.createIndex({ projectId: 1 });
      await projectSubscriptions.createIndex({ userId: 1 });
      await projectSubscriptions.createIndex({ expiresAt: 1 });

      // Phase 44: Contribution collections
      const projectContributions = this.db.collection('project_contributions');
      await projectContributions.createIndex({ projectId: 1 });
      await projectContributions.createIndex({ userId: 1 });
      await projectContributions.createIndex({ verified: 1 });

      const contributionScores = this.db.collection('contribution_scores');
      await contributionScores.createIndex({ projectId: 1 });

      console.log('[storage] MongoDB indexes created');
    } catch (err: any) {
      console.warn(`[storage] MongoDB index creation warning: ${err.message}`);
      // Non-fatal — queries will still work, just slower
    }
  }
}
