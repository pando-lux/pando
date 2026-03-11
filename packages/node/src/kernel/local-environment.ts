/**
 * LocalEnvironment — User memory only (Envelope 1 — never P2P synced).
 *
 * KB: File indexing (indexed_files, grantDirectory, search) stripped in Phase 6.
 * KB: Only user memory remains. Memory lives in ~/.pando/memory/ as plain markdown files.
 * KB: Never synced via P2P. Only accessible via HTTP /local/memory endpoints.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface MemoryEntry {
  type: 'preference' | 'learned' | 'summary' | 'note';
  key: string;
  value: string;
  confidence?: number; // 0–1
  updatedAt?: number;
}

export class LocalEnvironment {
  private dataDir: string;
  private memoryDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || join(homedir(), '.pando');
    this.memoryDir = join(this.dataDir, 'memory');

    if (!existsSync(this.memoryDir)) {
      mkdirSync(this.memoryDir, { recursive: true });
    }
  }

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

  /** No-op — kept for interface compatibility after DB removal. */
  close(): void {}
}
