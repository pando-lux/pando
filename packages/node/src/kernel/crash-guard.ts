/**
 * Crash Guard — Phase 15.5 Binary Rollback Safety Net.
 *
 * Tracks node startup timestamps and detects crash loops.
 * If the node crashes 3+ times within 60 seconds, it means the current
 * compiled code is broken. The guard restores dist/ from dist.backup/
 * (created before each build) and clears the crash log.
 *
 * This is the last line of defense: even if the code itself is broken,
 * the launcher scripts (start-node.bat / start-node.command) will keep
 * restarting the node, and this guard will eventually restore a working build.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

const CRASH_LOG_FILE = 'crash-log.json';
const CRASH_WINDOW_MS = 60_000;   // 60 seconds
const CRASH_THRESHOLD = 6;        // 6 crashes in window = crash loop (was 3 — too aggressive for dev workflows)
const STABILITY_DELAY_MS = 30_000; // 30s uptime = stable

interface CrashLog {
  startups: number[];   // Array of timestamps (ms)
  lastRollback?: number; // Timestamp of last rollback
}

/**
 * Record this startup and check if we're in a crash loop.
 * If crash loop detected, restore dist.backup/ and return true.
 * Returns false if startup is normal.
 *
 * @param dataDir - Data directory (default: ~/.pando)
 * @param repoDir - Repository root (for finding dist/ and dist.backup/)
 */
export function checkAndRecordStartup(dataDir?: string, repoDir?: string): { crashLoop: boolean; rolledBack: boolean } {
  const dir = dataDir || join(homedir(), '.pando');
  const logPath = join(dir, CRASH_LOG_FILE);

  mkdirSync(dir, { recursive: true });

  // Read existing crash log
  let log: CrashLog = { startups: [] };
  if (existsSync(logPath)) {
    try {
      log = JSON.parse(readFileSync(logPath, 'utf-8'));
      if (!Array.isArray(log.startups)) log.startups = [];
    } catch {
      log = { startups: [] };
    }
  }

  const now = Date.now();

  // Clean old entries (outside the crash window)
  log.startups = log.startups.filter(ts => now - ts < CRASH_WINDOW_MS);

  // Add this startup
  log.startups.push(now);

  // Write updated log
  writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');

  // Check for crash loop
  if (log.startups.length >= CRASH_THRESHOLD) {
    console.error(`[crash-guard] CRASH LOOP DETECTED: ${log.startups.length} startups in ${CRASH_WINDOW_MS / 1000}s`);

    // Prevent double-rollback (if we already rolled back recently)
    if (log.lastRollback && now - log.lastRollback < CRASH_WINDOW_MS * 2) {
      console.error('[crash-guard] Already rolled back recently. Waiting for manual intervention.');
      return { crashLoop: true, rolledBack: false };
    }

    // Attempt rollback
    const repo = repoDir || process.cwd();
    const rolledBack = restoreDistBackups(repo);

    if (rolledBack) {
      // Clear crash log and record rollback time
      const newLog: CrashLog = { startups: [], lastRollback: now };
      writeFileSync(logPath, JSON.stringify(newLog, null, 2), 'utf-8');
      console.log('[crash-guard] Crash log cleared after rollback. Node will restart with restored code.');
    }

    return { crashLoop: true, rolledBack };
  }

  return { crashLoop: false, rolledBack: false };
}

/**
 * Mark the node as stable (clear crash log).
 * Called after the node has been running for STABILITY_DELAY_MS.
 */
export function markStable(dataDir?: string): void {
  const dir = dataDir || join(homedir(), '.pando');
  const logPath = join(dir, CRASH_LOG_FILE);

  const log: CrashLog = { startups: [] };
  writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');
  console.log('[crash-guard] Node stable — crash log cleared.');
}

/**
 * Get the stability delay (how long to wait before marking as stable).
 */
export function getStabilityDelay(): number {
  return STABILITY_DELAY_MS;
}

/**
 * Restore dist/ from dist.backup/ for all packages.
 * Returns true if at least one package was restored.
 */
function restoreDistBackups(repoDir: string): boolean {
  const packages = ['shared', 'ledger', 'node', 'gateway', 'mcp-server'];
  let restored = 0;

  for (const pkg of packages) {
    const distDir = join(repoDir, 'packages', pkg, 'dist');
    const backupDir = join(repoDir, 'packages', pkg, 'dist.backup');

    if (!existsSync(backupDir)) continue;

    try {
      if (existsSync(distDir)) {
        rmSync(distDir, { recursive: true, force: true });
      }
      cpSync(backupDir, distDir, { recursive: true });
      restored++;
      console.log(`[crash-guard] Restored ${pkg}/dist from backup`);
    } catch (err: any) {
      console.error(`[crash-guard] Failed to restore ${pkg}/dist: ${err.message}`);
    }
  }

  if (restored > 0) {
    console.log(`[crash-guard] Restored ${restored}/${packages.length} packages from dist.backup/`);
  } else {
    console.log('[crash-guard] No dist.backup/ found. Cannot rollback.');
  }

  return restored > 0;
}
