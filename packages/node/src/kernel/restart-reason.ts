/**
 * Restart Reason — writes and reads a restart-reason file.
 *
 * Before an auto-update or pipeline deploy triggers a restart,
 * a restart-reason file is written to the data directory.
 * On startup, cli.ts reads this file to determine whether to run
 * post-deploy health checks. The file is cleaned up after a
 * successful health check.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const RESTART_REASON_FILE = 'restart-reason.json';

export interface RestartReason {
  reason: 'auto-update' | 'pipeline-deploy';
  timestamp: number;
}

function getReasonPath(dataDir?: string): string {
  const dir = dataDir || join(homedir(), '.pando');
  return join(dir, RESTART_REASON_FILE);
}

/**
 * Write a restart-reason file before triggering a restart.
 * Called by pipeline-runner.ts.
 */
export function writeRestartReason(reason: RestartReason['reason'], dataDir?: string): void {
  const dir = dataDir || join(homedir(), '.pando');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  const filePath = getReasonPath(dataDir);
  const data: RestartReason = { reason, timestamp: Date.now() };
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`[restart-reason] Wrote restart reason: ${reason}`);
}

/**
 * Read the restart-reason file if it exists.
 * Returns null if no restart-reason file is found.
 */
export function readRestartReason(dataDir?: string): RestartReason | null {
  const filePath = getReasonPath(dataDir);
  if (!existsSync(filePath)) return null;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (data && data.reason && data.timestamp) {
      return data as RestartReason;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Clean up (delete) the restart-reason file after a successful health check.
 */
export function clearRestartReason(dataDir?: string): void {
  const filePath = getReasonPath(dataDir);
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
      console.log('[restart-reason] Cleared restart reason file.');
    } catch {}
  }
}
