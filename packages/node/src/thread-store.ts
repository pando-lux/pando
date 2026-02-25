/**
 * ThreadStore — Persistent threaded conversation storage.
 *
 * Phase 24.9: Threaded Conversations
 * Phase 42: StorageBackend integration
 * Phase 57: StorageBackend is now REQUIRED. All filesystem code removed.
 *           All CRUD operations go through the StorageBackend.
 */

import type { StorageBackend } from './storage-backend.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ThreadMeta {
  id: string;
  title: string;
  type: 'conversation' | 'project';
  createdAt: number;
  updatedAt: number;
  preview: string;
  messageCount: number;
  archived: boolean;
  projectId?: string;  // Links to the ChatSessionManager project session (e.g. "simple-todo-list-app-1771476468")
  userId?: string;     // Phase 31: Owner user account ID (persistent accounts). Absent = anonymous/legacy thread.
  encryptionKeys?: Record<string, string>;  // Phase 41: peerId -> encrypted threadKey (base64). Each participant gets the thread key encrypted for their public key.
}

export interface ThreadMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;          // plaintext OR encrypted content (base64)
  timestamp: number;
  tier?: 'simple' | 'medium' | 'complex';
  activityLog?: string[];
  encrypted?: boolean;      // Phase 41: true if content is AES-256-GCM encrypted
  nonce?: string;           // Phase 41: AES-GCM nonce (base64), present when encrypted=true
}

// ─── ThreadStore ──────────────────────────────────────────────────────────────

const MAX_THREADS = 200;

export class ThreadStore {
  private index: ThreadMeta[] = [];
  private backend: StorageBackend;

  constructor(storageBackend: StorageBackend) {
    this.backend = storageBackend;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** List all threads, newest first. Excludes archived by default. */
  listThreads(includeArchived = false): ThreadMeta[] {
    // Synchronous API — return cached index; async load happens via loadFromBackend()
    const threads = includeArchived
      ? this.index
      : this.index.filter(t => !t.archived);
    return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Async version of listThreads for StorageBackend usage. */
  async listThreadsAsync(includeArchived = false): Promise<ThreadMeta[]> {
    const all = await this.backend.listRecords('threads') as ThreadMeta[];
    const threads = includeArchived
      ? all
      : all.filter(t => !t.archived);
    // Update local cache
    this.index = all;
    return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** List threads owned by a specific user, newest first. */
  listUserThreads(userId: string, includeArchived = false): ThreadMeta[] {
    const threads = this.index.filter(t =>
      t.userId === userId && (includeArchived || !t.archived)
    );
    return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Async version of listUserThreads for StorageBackend usage. */
  async listUserThreadsAsync(userId: string, includeArchived = false): Promise<ThreadMeta[]> {
    const filter: Record<string, any> = { userId };
    if (!includeArchived) {
      filter.archived = false;
    }
    const threads = await this.backend.queryRecords('threads', filter, {
      sort: { updatedAt: -1 },
    }) as ThreadMeta[];
    return threads;
  }

  /** Get a single thread's metadata. */
  getThread(threadId: string): ThreadMeta | null {
    return this.index.find(t => t.id === threadId) || null;
  }

  /** Async version of getThread for StorageBackend usage. */
  async getThreadAsync(threadId: string): Promise<ThreadMeta | null> {
    const record = await this.backend.getRecord('threads', threadId);
    return record as ThreadMeta | null;
  }

  /** Create a new thread. Returns the metadata. */
  createThread(id: string, title: string, type: 'conversation' | 'project' = 'conversation', preview = '', userId?: string, encryptionKeys?: Record<string, string>): ThreadMeta {
    // Check if thread already exists
    const existing = this.index.find(t => t.id === id);
    if (existing) return existing;

    const meta: ThreadMeta = {
      id,
      title: title.slice(0, 80),
      type,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      preview: preview.slice(0, 200),
      messageCount: 0,
      archived: false,
      userId,
    };

    // Phase 41: Store per-participant encrypted thread keys
    if (encryptionKeys && Object.keys(encryptionKeys).length > 0) {
      meta.encryptionKeys = encryptionKeys;
    }

    // Write via StorageBackend (fire-and-forget for sync API compat)
    // Messages doc created automatically by pushToArray (upsert) on first addMessage
    this.backend.putRecord('threads', id, meta).catch(err => {
      console.error(`[threads] Backend putRecord failed: ${err.message}`);
    });

    this.index.push(meta);
    this.trimIndex();

    console.log(`[threads] Created thread: ${id} (${type})`);
    return meta;
  }

  /** Add a message to a thread. Creates thread if it doesn't exist. */
  addMessage(threadId: string, message: ThreadMessage): void {
    // Ensure thread exists
    let meta = this.index.find(t => t.id === threadId);
    if (!meta) {
      // Auto-create thread from first user message
      const title = message.role === 'user'
        ? this.generateTitle(message.content)
        : 'New conversation';
      meta = this.createThread(threadId, title, 'conversation', message.content);
    }

    // Update metadata
    meta.updatedAt = Date.now();
    meta.messageCount++;
    if (message.role === 'user' && !meta.preview) {
      meta.preview = message.content.slice(0, 200);
    }

    // Update via backend (fire-and-forget for sync API compat)
    this.backend.putRecord('threads', threadId, meta).catch(err => {
      console.error(`[threads] Backend update meta failed: ${err.message}`);
    });
    // Atomic push — no read-modify-write race
    this.backend.pushToArray('messages', threadId, 'messages', message).catch(err => {
      console.error(`[threads] Backend addMessage failed: ${err.message}`);
    });
  }

  /** Get all messages for a thread (sync — returns empty, use getMessagesAsync). */
  getMessages(threadId: string): ThreadMessage[] {
    // Backend is async-only — sync callers get empty. Use getMessagesAsync().
    return [];
  }

  /** Async version of getMessages for StorageBackend usage. */
  async getMessagesAsync(threadId: string): Promise<ThreadMessage[]> {
    const record = await this.backend.getRecord('messages', threadId);
    return record?.messages || [];
  }

  /** Update thread metadata (rename, archive, change type, link project, set owner). */
  updateThread(threadId: string, updates: Partial<Pick<ThreadMeta, 'title' | 'archived' | 'type' | 'projectId' | 'userId'>>): ThreadMeta | null {
    const meta = this.index.find(t => t.id === threadId);
    if (!meta) return null;

    if (updates.title !== undefined) meta.title = updates.title.slice(0, 80);
    if (updates.archived !== undefined) meta.archived = updates.archived;
    if (updates.type !== undefined) meta.type = updates.type;
    if (updates.projectId !== undefined) meta.projectId = updates.projectId;
    if (updates.userId !== undefined) meta.userId = updates.userId;
    meta.updatedAt = Date.now();

    this.backend.putRecord('threads', threadId, meta).catch(err => {
      console.error(`[threads] Backend updateThread failed: ${err.message}`);
    });
    return meta;
  }

  /** Delete a thread and its data. */
  deleteThread(threadId: string): boolean {
    const idx = this.index.findIndex(t => t.id === threadId);
    if (idx === -1) return false;

    this.index.splice(idx, 1);

    this.backend.deleteRecord('threads', threadId).catch(err => {
      console.error(`[threads] Backend deleteThread failed: ${err.message}`);
    });
    this.backend.deleteRecord('messages', threadId).catch(err => {
      console.error(`[threads] Backend deleteMessages failed: ${err.message}`);
    });

    console.log(`[threads] Deleted thread: ${threadId}`);
    return true;
  }

  /**
   * Load index from backend on startup (async init).
   * Call this after construction.
   */
  async loadFromBackend(): Promise<void> {
    try {
      const records = await this.backend.listRecords('threads');
      this.index = records as ThreadMeta[];
      console.log(`[threads] Loaded ${this.index.length} threads from storage backend`);
    } catch (err: any) {
      console.warn(`[threads] Failed to load from backend: ${err.message}`);
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Auto-archive oldest non-archived threads when over MAX_THREADS. */
  private trimIndex(): void {
    const active = this.index.filter(t => !t.archived);
    if (active.length <= MAX_THREADS) return;

    // Archive oldest
    const sorted = active.sort((a, b) => a.updatedAt - b.updatedAt);
    const toArchive = sorted.slice(0, active.length - MAX_THREADS);
    for (const t of toArchive) {
      t.archived = true;
      console.log(`[threads] Auto-archived old thread: ${t.id}`);
    }
  }

  /** Generate a thread title from the first user message. */
  private generateTitle(content: string): string {
    // Take first line, clean up, cap at 50 chars
    const firstLine = content.split('\n')[0].trim();
    const cleaned = firstLine
      .replace(/^(build|create|make|implement|deploy|fix|update|add|write)\s+(me\s+)?(a\s+|the\s+)?/i, '')
      .trim();
    if (cleaned.length > 50) return cleaned.slice(0, 47) + '...';
    return cleaned || content.slice(0, 50);
  }
}
