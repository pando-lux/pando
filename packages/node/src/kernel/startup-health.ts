/**
 * Startup Health — Post-restart health intelligence.
 *
 * Called once on node startup (from cli.ts, after crash-guard but before node.start()).
 * Reads crash-log.json, restart-reason.json, and monitor/alerts.json to detect
 * patterns like crash loops, recurring restarts, and unresolved alerts.
 *
 * Also implements a circuit breaker: if the node crashes 3+ times with the
 * same error pattern, it halts (exit 1) instead of restarting infinitely.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartupHealthReport {
  crashesLast24h: number;
  consecutiveFailures: number;
  unresolvedAlerts: number;
  patterns: string[];
  halted: boolean;
}

interface CircuitBreakerState {
  consecutiveFailures: number;
  lastError: string;
  lastTimestamp: number;
}

interface CrashLogEntry {
  startups: number[];
  lastRollback?: number;
}

interface AlertEntry {
  severity?: string;
  type?: string;
  resolved?: boolean;
  lastSeen?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CIRCUIT_BREAKER_FILE = 'circuit-breaker.json';
const HALTED_FILE = 'halted.json';
const CRASH_LOG_FILE = 'crash-log.json';
const RESTART_REASON_FILE = 'restart-reason.json';
const ALERTS_FILE = join('monitor', 'alerts.json');

const CIRCUIT_BREAKER_THRESHOLD = 5;  // was 3 — too aggressive for dev workflows with frequent restarts
const RECENT_CRASH_WINDOW_MS = 5 * 60 * 1000;   // 5 minutes
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveDir(dataDir?: string): string {
  return dataDir || join(homedir(), '.pando');
}

function readJson(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(path: string, data: any): void {
  try {
    const dir = join(path, '..');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

/**
 * Analyze startup health from crash logs, restart reasons, and alerts.
 * Returns a report with patterns and whether the node should halt.
 */
export function analyzeStartupHealth(dataDir?: string): StartupHealthReport {
  const dir = resolveDir(dataDir);
  const patterns: string[] = [];
  let crashesLast24h = 0;
  let unresolvedAlerts = 0;

  // 1. Analyze crash-log.json
  const crashLogPath = join(dir, CRASH_LOG_FILE);
  const crashLog = readJson(crashLogPath) as CrashLogEntry | null;
  const now = Date.now();

  if (crashLog?.startups?.length) {
    const last24h = crashLog.startups.filter((ts: number) => now - ts < DAY_MS);
    const lastHour = crashLog.startups.filter((ts: number) => now - ts < 60 * 60 * 1000);
    crashesLast24h = last24h.length;

    if (last24h.length >= 5) {
      patterns.push(`recurring_crash: ${last24h.length} startups in last 24h`);
    }
    if (lastHour.length >= 3) {
      patterns.push(`crash_burst: ${lastHour.length} startups in last hour`);
    }
  }

  // 2. Read restart-reason.json
  const reasonPath = join(dir, RESTART_REASON_FILE);
  const reason = readJson(reasonPath) as { reason?: string; timestamp?: number } | null;
  let restartSignature = '';

  if (reason?.reason) {
    console.log(`[startup-health] Last restart reason: ${reason.reason} (at ${new Date(reason.timestamp || 0).toISOString()})`);
    restartSignature = reason.reason;
  }

  // 3. Read monitor/alerts.json
  const alertsPath = join(dir, ALERTS_FILE);
  const alerts = readJson(alertsPath) as AlertEntry[] | null;

  if (Array.isArray(alerts)) {
    const unresolved = alerts.filter(a => !a.resolved);
    const criticalUnresolved = unresolved.filter(a => a.severity === 'critical');
    unresolvedAlerts = unresolved.length;

    if (criticalUnresolved.length > 0) {
      patterns.push(`unresolved_critical: ${criticalUnresolved.length} critical alert(s) from last session`);
    }

    // Count alerts by type in last 24h
    const recent = alerts.filter(a => a.lastSeen && now - a.lastSeen < DAY_MS);
    const byType = new Map<string, number>();
    for (const a of recent) {
      if (a.type) byType.set(a.type, (byType.get(a.type) || 0) + 1);
    }
    for (const [type, count] of byType) {
      if (count >= 3) {
        patterns.push(`recurring_alert: ${type} triggered ${count} times in 24h`);
      }
    }
  }

  // 4. Circuit breaker
  const cbPath = join(dir, CIRCUIT_BREAKER_FILE);
  let cbState = readJson(cbPath) as CircuitBreakerState | null;
  if (!cbState) {
    cbState = { consecutiveFailures: 0, lastError: '', lastTimestamp: 0 };
  }

  // Determine if this startup looks like a crash recovery
  const recentCrash = crashLog?.startups?.some((ts: number) => now - ts < RECENT_CRASH_WINDOW_MS && ts !== now) ?? false;
  const hasRestartReason = !!reason?.reason;

  if (recentCrash || hasRestartReason) {
    // Build error signature from restart reason or crash pattern
    const signature = restartSignature || 'crash';

    if (signature === cbState.lastError || cbState.lastError === '') {
      cbState.consecutiveFailures++;
    } else {
      // Different error — reset counter but track new one
      cbState.consecutiveFailures = 1;
    }
    cbState.lastError = signature;
    cbState.lastTimestamp = now;
  } else {
    // Clean startup (no crashes in last 5 min, no restart reason) — reset
    cbState.consecutiveFailures = 0;
    cbState.lastError = '';
    cbState.lastTimestamp = now;
  }

  writeJson(cbPath, cbState);

  // Check if we should halt
  let halted = false;
  if (cbState.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    patterns.push(`circuit_breaker: ${cbState.consecutiveFailures} consecutive failures (error: ${cbState.lastError})`);
    halted = true;

    // Write halted.json
    const haltedPath = join(dir, HALTED_FILE);
    writeJson(haltedPath, {
      reason: `Circuit breaker tripped: ${cbState.consecutiveFailures} consecutive failures`,
      lastError: cbState.lastError,
      timestamp: now,
    });
  }

  // Log patterns
  if (patterns.length > 0) {
    console.warn(`[startup-health] Detected ${patterns.length} pattern(s):`);
    for (const p of patterns) {
      console.warn(`[startup-health]   - ${p}`);
    }
  } else {
    console.log('[startup-health] Clean startup — no concerning patterns detected.');
  }

  return {
    crashesLast24h,
    consecutiveFailures: cbState.consecutiveFailures,
    unresolvedAlerts,
    patterns,
    halted,
  };
}

/**
 * Reset the circuit breaker (called after stable uptime).
 */
export function resetCircuitBreaker(dataDir?: string): void {
  const dir = resolveDir(dataDir);
  const cbPath = join(dir, CIRCUIT_BREAKER_FILE);
  const state: CircuitBreakerState = {
    consecutiveFailures: 0,
    lastError: '',
    lastTimestamp: Date.now(),
  };
  writeJson(cbPath, state);
}
