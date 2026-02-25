/**
 * LocalEnvironment — v2.5: Envelope 1 local file indexing + user memory.
 *
 * PRIVACY INVARIANT: Everything here is Envelope 1.
 * - NEVER synced via P2P GossipSub
 * - NEVER uploaded to MongoDB or S3
 * - NEVER accessible from outside this machine
 * - Lives only in ~/.pando/memory/ and ~/.pando/file-index.db
 *
 * Agents access local files via HTTP API only — never direct filesystem.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { homedir } from 'node:os';

const INDEXABLE_EXTENSIONS = new Set([
  '.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.py', '.json', '.yaml', '.yml',
  '.html', '.css', '.sh', '.bash', '.env', '.conf', '.config', '.toml', '.xml',
  '.rs', '.go', '.java', '.c', '.cpp', '.h', '.cs', '.rb', '.php', '.swift',
]);

const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512KB — skip large files

// Paths that are NEVER readable (Guardrails hard-block)
const PROTECTED_PATH_PREFIXES = [
  '.pando/identities',
  '.pando/identity.json',
  '.pando/session.json',
  '.pando/api-token',
  '.ssh',
  '.gnupg',
  '.aws/credentials',
];

export interface IndexedDir {
  path: string;
  grantedAt: number;
  fileCount: number;
  lastIndexedAt: number;
}

export interface SearchResult {
  path: string;
  snippet: string;
  score: number;
}

export interface LocalStatus {
  grantedDirs: IndexedDir[];
  totalFiles: number;
  dbPath: string;
  memoryPath: string;
}

export interface MemoryEntry {
  type: 'preference' | 'learned' | 'summary' | 'note';
  key: string;
  value: string;
  confidence?: number; // 0–1
  updatedAt?: number;
}

export class LocalEnvironment {
  private db: Database.Database;
  private dataDir: string;
  private configPath: string;
  private memoryDir: string;
  private grantedDirs: Map<string, IndexedDir> = new Map();

  constructor(dataDir?: string) {
    this.dataDir = dataDir || join(homedir(), '.pando');
    this.configPath = join(this.dataDir, 'local-env.json');
    this.memoryDir = join(this.dataDir, 'memory');

    // Open SQLite DB for file index
    const dbPath = join(this.dataDir, 'file-index.db');
    this.db = new Database(dbPath);
    this._initDb();

    // Ensure memory directory exists
    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }

    // Load persisted granted dirs
    this._loadConfig();
  }

  private _initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_files (
        path TEXT PRIMARY KEY,
        dir TEXT NOT NULL,
        content TEXT,
        size INTEGER,
        indexed_at INTEGER
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        path,
        content,
        content='indexed_files',
        content_rowid='rowid'
      );
    `);
  }

  private _loadConfig(): void {
    try {
      if (existsSync(this.configPath)) {
        const data = JSON.parse(readFileSync(this.configPath, 'utf-8'));
        for (const entry of data.grantedDirs || []) {
          this.grantedDirs.set(entry.path, entry);
        }
      }
    } catch { /* first run */ }
  }

  private _saveConfig(): void {
    const data = { grantedDirs: Array.from(this.grantedDirs.values()) };
    writeFileSync(this.configPath, JSON.stringify(data, null, 2));
  }

  private _isProtected(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    const home = homedir().replace(/\\/g, '/');
    const relative = normalized.startsWith(home) ? normalized.slice(home.length + 1) : normalized;
    return PROTECTED_PATH_PREFIXES.some(p => relative.startsWith(p));
  }

  private _isInGrantedDir(filePath: string): boolean {
    const abs = resolve(filePath);
    for (const dir of this.grantedDirs.keys()) {
      if (abs.startsWith(resolve(dir))) return true;
    }
    return false;
  }

  /**
   * Grant a directory for indexing. Triggers immediate indexing.
   */
  async grantDirectory(dirPath: string): Promise<{ added: number; skipped: number }> {
    const abs = resolve(dirPath);
    if (!existsSync(abs)) throw new Error(`Directory not found: ${abs}`);
    if (!statSync(abs).isDirectory()) throw new Error(`Not a directory: ${abs}`);

    const entry: IndexedDir = {
      path: abs,
      grantedAt: Date.now(),
      fileCount: 0,
      lastIndexedAt: 0,
    };
    this.grantedDirs.set(abs, entry);
    this._saveConfig();

    const result = await this._indexDirectory(abs);
    entry.fileCount = result.added;
    entry.lastIndexedAt = Date.now();
    this._saveConfig();
    return result;
  }

  /**
   * Revoke a directory from the index and remove its entries.
   */
  revokeDirectory(dirPath: string): void {
    const abs = resolve(dirPath);
    this.grantedDirs.delete(abs);
    this.db.prepare('DELETE FROM indexed_files WHERE dir = ?').run(abs);
    // Rebuild FTS index
    this.db.exec('INSERT INTO files_fts(files_fts) VALUES(\'rebuild\')');
    this._saveConfig();
  }

  private async _indexDirectory(dir: string): Promise<{ added: number; skipped: number }> {
    let added = 0;
    let skipped = 0;

    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO indexed_files (path, dir, content, size, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const walk = (currentDir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(currentDir);
      } catch { return; }

      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules' || entry === '.git') continue;
        const fullPath = join(currentDir, entry);
        try {
          const st = statSync(fullPath);
          if (st.isDirectory()) {
            walk(fullPath);
          } else if (st.isFile()) {
            const ext = extname(entry).toLowerCase();
            if (!INDEXABLE_EXTENSIONS.has(ext)) { skipped++; continue; }
            if (st.size > MAX_FILE_SIZE_BYTES) { skipped++; continue; }
            if (this._isProtected(fullPath)) { skipped++; continue; }

            try {
              const content = readFileSync(fullPath, 'utf-8');
              insertStmt.run(fullPath, dir, content, st.size, Date.now());
              added++;
            } catch { skipped++; }
          }
        } catch { skipped++; }
      }
    };

    walk(dir);

    // Rebuild FTS after batch insert
    try {
      this.db.exec('INSERT INTO files_fts(files_fts) VALUES(\'rebuild\')');
    } catch {}

    return { added, skipped };
  }

  /**
   * Full-text search over indexed files.
   */
  search(query: string, limit = 10): SearchResult[] {
    try {
      const rows = this.db.prepare(`
        SELECT path, snippet(files_fts, 1, '[', ']', '...', 20) as snippet, rank
        FROM files_fts
        WHERE files_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit) as any[];

      return rows.map(row => ({
        path: row.path,
        snippet: row.snippet || '',
        score: Math.abs(row.rank || 0),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Read a file's content. Only works for files in granted directories.
   * Protected paths are always blocked.
   */
  readFile(filePath: string): string {
    const abs = resolve(filePath);
    if (this._isProtected(abs)) throw new Error('Access denied: protected path');
    if (!this._isInGrantedDir(abs)) throw new Error('Access denied: directory not granted');
    if (!existsSync(abs)) throw new Error('File not found');
    return readFileSync(abs, 'utf-8');
  }

  /**
   * Get local environment status.
   */
  getStatus(): LocalStatus {
    const totalFiles = (this.db.prepare('SELECT COUNT(*) as n FROM indexed_files').get() as any)?.n || 0;
    return {
      grantedDirs: Array.from(this.grantedDirs.values()),
      totalFiles,
      dbPath: join(this.dataDir, 'file-index.db'),
      memoryPath: this.memoryDir,
    };
  }

  // ── User Memory ──────────────────────────────────────────────────────────────

  /**
   * Read the full user memory context (user-memory.md contents).
   * Returns null if no memory file exists yet.
   */
  getMemory(): string | null {
    const memFile = join(this.memoryDir, 'user-memory.md');
    if (!existsSync(memFile)) return null;
    try {
      return readFileSync(memFile, 'utf-8');
    } catch { return null; }
  }

  /**
   * Read a specific memory file.
   */
  getMemoryFile(filename: string): string | null {
    // Restrict to only files in memory dir — no path traversal
    const basename = filename.replace(/[/\\]/g, '');
    const filePath = join(this.memoryDir, basename);
    if (!existsSync(filePath)) return null;
    try {
      return readFileSync(filePath, 'utf-8');
    } catch { return null; }
  }

  /**
   * Append a memory entry to user-memory.md.
   * Agents call this to record learned facts, preferences, notes.
   */
  appendMemory(entry: MemoryEntry): void {
    const memFile = join(this.memoryDir, 'user-memory.md');
    const timestamp = new Date().toISOString().slice(0, 10);
    const confidence = entry.confidence !== undefined ? ` (confidence: ${entry.confidence})` : '';
    const line = `\n- **${entry.key}** [${entry.type}]${confidence}: ${entry.value} _(${timestamp})_`;

    try {
      if (!existsSync(memFile)) {
        writeFileSync(memFile, '# User Memory\n\nThis file is auto-updated by Pando agents.\n');
      }
      const existing = readFileSync(memFile, 'utf-8');
      writeFileSync(memFile, existing + line + '\n');
    } catch (err: any) {
      throw new Error(`Failed to write memory: ${err.message}`);
    }
  }

  /**
   * Close the database on shutdown.
   */
  close(): void {
    try { this.db.close(); } catch {}
  }
}
