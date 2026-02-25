/**
 * File logger for Pando nodes.
 *
 * Writes timestamped, ANSI-stripped log lines to ~/.pando/logs/node.log.
 * Rotates when the file exceeds MAX_LOG_SIZE (keeps one .log.1 backup).
 * Used by both tui.ts and cli.ts so we can always inspect node output via SSH.
 */

import { createWriteStream, mkdirSync, statSync, renameSync, existsSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB

/** Strip ANSI escape sequences so the log file is plain text. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

export class FileLogger {
  private stream: WriteStream | null = null;
  private logPath: string;
  private logsDir: string;

  constructor(dataDir?: string) {
    const base = dataDir || join(homedir(), '.pando');
    this.logsDir = join(base, 'logs');
    this.logPath = join(this.logsDir, 'node.log');
    this._open();
  }

  private _open(): void {
    try {
      mkdirSync(this.logsDir, { recursive: true });
      this.stream = createWriteStream(this.logPath, { flags: 'a' });
    } catch {
      // If we can't open the log file, just silently skip (don't crash the node).
      this.stream = null;
    }
  }

  private _rotate(): void {
    try {
      const stats = statSync(this.logPath);
      if (stats.size < MAX_LOG_SIZE) return;

      // Close current stream
      this.stream?.end();

      // Rotate: node.log → node.log.1 (overwrites previous backup)
      const backupPath = this.logPath + '.1';
      if (existsSync(this.logPath)) {
        renameSync(this.logPath, backupPath);
      }

      // Re-open fresh file
      this.stream = createWriteStream(this.logPath, { flags: 'a' });
    } catch {
      // Rotation failure is non-fatal
    }
  }

  /** Write a log line with ISO timestamp. */
  log(msg: string): void {
    if (!this.stream) return;
    const ts = new Date().toISOString();
    const clean = stripAnsi(msg);
    this.stream.write(`[${ts}] ${clean}\n`);
    this._rotate();
  }

  /** Write a warning line. */
  warn(msg: string): void {
    if (!this.stream) return;
    const ts = new Date().toISOString();
    const clean = stripAnsi(msg);
    this.stream.write(`[${ts}] WARN: ${clean}\n`);
    this._rotate();
  }

  /** Write an error line. */
  error(msg: string): void {
    if (!this.stream) return;
    const ts = new Date().toISOString();
    const clean = stripAnsi(msg);
    this.stream.write(`[${ts}] ERROR: ${clean}\n`);
    this._rotate();
  }

  /** Flush and close the log file. */
  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}
