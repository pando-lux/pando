/**
 * StorageBackend — Pluggable storage interface for user data.
 *
 * Phase 42: Making nodes stateless for user data.
 * Nodes become compute proxies; user data (threads, messages, user accounts)
 * is stored via a pluggable StorageBackend.
 *
 * Phase 57: LocalStorageBackend removed. StorageBackend is now required
 * (provided by MongoStorageBackend or another implementation).
 */

// ─── Interface ───────────────────────────────────────────────────────────────

export interface StorageBackend {
  /** Initialize the backend (connect, create dirs/indexes, etc.) */
  init(): Promise<void>;

  /** Close connections and release resources. */
  close(): Promise<void>;

  /** Insert or update a record in a collection. */
  putRecord(collection: string, key: string, data: Record<string, any>): Promise<void>;

  /** Get a single record by key. Returns null if not found. */
  getRecord(collection: string, key: string): Promise<Record<string, any> | null>;

  /**
   * Query records with a filter object.
   * Filter keys are matched with equality against record fields.
   * Optional: limit and sort.
   */
  queryRecords(
    collection: string,
    filter: Record<string, any>,
    options?: { limit?: number; sort?: Record<string, 1 | -1> },
  ): Promise<Record<string, any>[]>;

  /** Delete a record by key. */
  deleteRecord(collection: string, key: string): Promise<void>;

  /** List all records in a collection, optionally filtered. */
  listRecords(collection: string, filter?: Record<string, any>): Promise<Record<string, any>[]>;

  /** Atomically push a value onto an array field in a record. Creates the record if it doesn't exist. */
  pushToArray(collection: string, key: string, field: string, value: any): Promise<void>;
}
