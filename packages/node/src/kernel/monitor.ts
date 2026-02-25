/**
 * Health Monitor — DATA-ONLY node health monitoring and alert generation.
 *
 * Detects scheduler crashes, peer loss, failure rate spikes, memory pressure,
 * event loop lag, and consecutive task failures. Stores rolling metrics history
 * and persistent alerts at ~/.pando/monitor/.
 *
 * This subsystem is DATA-ONLY — it collects metrics and generates alerts
 * but NEVER takes recovery actions. The manager decides what to act on.
 *
 * Audit trail at ~/.pando/monitor/audit.json.
 * Recovery config persisted to ~/.pando/monitor/recovery-config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  MonitorConfig,
  HealthMetrics,
  MonitorAlert,
  MonitorAlertType,
  MonitorAlertSeverity,
  MonitorHealthStatus,
  RecoveryAction,
  RecoveryActionType,
  AuditEntry,
} from '@pando/shared';
/** Minimal interface — avoids importing platform/ from kernel/ */
interface SchedulerLike extends NodeJS.EventEmitter {
  getStatus(): { running: boolean; activeTasks: any[] };
}
import type { PandoNetwork } from './network.js';

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: MonitorConfig = {
  checkIntervalMs: 30_000,            // 30 seconds
  stuckPeerThresholdMs: 5 * 60_000,   // 5 minutes
  failureRateThreshold: 0.5,          // 50%
  failureRateWindowMs: 60 * 60_000,   // 1 hour
  maxConsecutiveFailures: 5,
  memoryUsageThreshold: 0.85,         // 85% heap usage
  eventLoopLagThresholdMs: 500,       // 500ms event loop lag
  ledgerSyncLagThresholdMs: 10 * 60_000, // 10 minutes
  spawnFailureRateThreshold: 0.6,     // 60% spawn failure rate
  spawnFailureWindowMs: 30 * 60_000,  // 30 minutes
};

const MAX_METRICS_HISTORY = 100;
const MAX_ALERTS = 200;
const MAX_AUDIT_ENTRIES = 500;

// If a resolved alert of the same type re-triggers within this window,
// reopen it instead of creating a new entry. Prevents oscillating conditions
// (e.g. memory usage hovering around threshold) from flooding the alerts array.
const ALERT_REOPEN_WINDOW_MS = 30 * 60_000; // 30 minutes

// Default recovery actions table
const DEFAULT_RECOVERY_ACTIONS: RecoveryAction[] = [
  {
    trigger: 'scheduler_down',
    action: 'restart_scheduler',
    cooldownMs: 5 * 60_000,           // 5 minutes
    triggerCount: 0,
    enabled: true,
  },
  {
    trigger: 'consecutive_failures',
    action: 'submit_diagnostic',
    cooldownMs: 60 * 60_000,          // 60 minutes (increased from 15m to prevent diagnostic spam)
    triggerCount: 0,
    enabled: true,
  },
  {
    trigger: 'high_failure_rate',
    action: 'reduce_concurrency',
    cooldownMs: 30 * 60_000,          // 30 minutes
    triggerCount: 0,
    enabled: true,
  },
  {
    trigger: 'no_peers',
    action: 'reconnect_bootstrap',
    cooldownMs: 5 * 60_000,           // 5 minutes
    triggerCount: 0,
    enabled: true,
  },
  {
    trigger: 'high_memory_usage',
    action: 'force_gc',
    cooldownMs: 10 * 60_000,          // 10 minutes
    triggerCount: 0,
    enabled: true,
  },
  {
    trigger: 'event_loop_lag',
    action: 'reduce_concurrency',
    cooldownMs: 15 * 60_000,          // 15 minutes
    triggerCount: 0,
    enabled: true,
  },
  {
    trigger: 'agent_spawn_failures',
    action: 'pause_spawning',
    cooldownMs: 15 * 60_000,          // 15 minutes
    triggerCount: 0,
    enabled: true,
  },
  {
    trigger: 'ledger_sync_lag',
    action: 'log_only',
    cooldownMs: 30 * 60_000,          // 30 minutes
    triggerCount: 0,
    enabled: true,
  },
];

// ── HealthMonitor Class ───────────────────────────────────────────────────────

export class HealthMonitor extends EventEmitter {
  private config: MonitorConfig;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private eventLoopLagTimer: ReturnType<typeof setInterval> | null = null;

  // External references (set via setters)
  private getScheduler: (() => SchedulerLike | null) | null = null;
  private getNetwork: (() => PandoNetwork | null) | null = null;

  // Task tracking (independent of scheduler reset)
  private taskSuccesses: number[] = [];  // timestamps of recent successes
  private taskFailures: number[] = [];   // timestamps of recent failures
  private consecutiveFailures = 0;
  private lastTaskCompletedAt: number | null = null;

  // Peer tracking for stuck-peer detection
  private zeroPeersSince: number | null = null;

  // Agent spawn tracking
  private spawnSuccesses: number[] = [];  // timestamps of recent spawn successes
  private spawnFailures: number[] = [];   // timestamps of recent spawn failures

  // Event loop lag tracking
  private lastEventLoopCheck: number = Date.now();
  private currentEventLoopLagMs = 0;

  // Ledger sync tracking
  private lastLedgerSyncAt: number | null = null;

  // Persistent storage paths
  private monitorDir: string;
  private metricsPath: string;
  private alertsPath: string;
  private auditPath: string;
  private recoveryPath: string;
  private recoveryConfigPath: string;
  private configPath: string;

  // In-memory state
  private metricsHistory: HealthMetrics[] = [];
  private alerts: MonitorAlert[] = [];
  private auditLog: AuditEntry[] = [];
  private recoveryActions: RecoveryAction[] = [];

  // Phase 19.2: Alert callbacks for external consumers (e.g. Health Manager)
  private alertCallbacks: Array<(alert: MonitorAlert) => void> = [];

  constructor(dataDir: string, config?: Partial<MonitorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.monitorDir = join(dataDir, 'monitor');
    this.metricsPath = join(this.monitorDir, 'metrics.json');
    this.alertsPath = join(this.monitorDir, 'alerts.json');
    this.auditPath = join(this.monitorDir, 'audit.json');
    this.recoveryPath = join(this.monitorDir, 'recovery.json');
    this.recoveryConfigPath = join(this.monitorDir, 'recovery-config.json');
    this.configPath = join(this.monitorDir, 'config.json');

    // Ensure monitor directory exists
    if (!existsSync(this.monitorDir)) {
      mkdirSync(this.monitorDir, { recursive: true });
    }

    // Load persisted state
    this.loadState();
  }

  // ── Setters for external references ──

  setSchedulerProvider(fn: () => SchedulerLike | null): void {
    this.getScheduler = fn;
  }

  setNetworkProvider(fn: () => PandoNetwork | null): void {
    this.getNetwork = fn;
  }

  /**
   * Phase 19.2: Subscribe to alert events. The callback fires whenever a new
   * alert is created or an existing alert is updated. Health Managers (Phase 19.4)
   * will use this to decide whether to create diagnostic tasks.
   */
  onAlert(callback: (alert: MonitorAlert) => void): void {
    this.alertCallbacks.push(callback);
  }

  // ── Lifecycle ──

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('[monitor] Health monitor started.');

    // Start event loop lag measurement
    this.startEventLoopLagMeasurement();

    // Run first check immediately
    this.check();

    // Schedule periodic checks
    this.timer = setInterval(() => this.check(), this.config.checkIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.eventLoopLagTimer) {
      clearInterval(this.eventLoopLagTimer);
      this.eventLoopLagTimer = null;
    }
    this.saveState();
    console.log('[monitor] Health monitor stopped.');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Scheduler event hooks ──

  /**
   * Wire up to scheduler events. Called from PandoNode after scheduler starts.
   */
  attachScheduler(scheduler: SchedulerLike): void {
    scheduler.on('task:completed', (_data: any) => {
      this.lastTaskCompletedAt = Date.now();
      this.taskSuccesses.push(Date.now());
      this.consecutiveFailures = 0;
      this.pruneTaskHistory();
    });

    scheduler.on('task:failed', (_data: any) => {
      this.taskFailures.push(Date.now());
      this.consecutiveFailures++;
      this.pruneTaskHistory();
    });

    // Track agent spawn outcomes
    scheduler.on('task:spawned', (_data: any) => {
      this.spawnSuccesses.push(Date.now());
      this.pruneSpawnHistory();
    });

    scheduler.on('task:workspace', (_data: any) => {
      // Workspace creation is a proxy for successful spawn start
    });
  }

  /**
   * Record a spawn failure (called externally when agent spawn errors are detected).
   */
  recordSpawnFailure(): void {
    this.spawnFailures.push(Date.now());
    this.pruneSpawnHistory();
  }

  /**
   * Record ledger sync activity (called externally from sync module).
   */
  recordLedgerSync(): void {
    this.lastLedgerSyncAt = Date.now();
  }

  /**
   * Remove task history entries outside the failure rate window.
   */
  private pruneTaskHistory(): void {
    const cutoff = Date.now() - this.config.failureRateWindowMs;
    this.taskSuccesses = this.taskSuccesses.filter(t => t > cutoff);
    this.taskFailures = this.taskFailures.filter(t => t > cutoff);
  }

  /**
   * Remove spawn history entries outside the spawn failure window.
   */
  private pruneSpawnHistory(): void {
    const cutoff = Date.now() - this.config.spawnFailureWindowMs;
    this.spawnSuccesses = this.spawnSuccesses.filter(t => t > cutoff);
    this.spawnFailures = this.spawnFailures.filter(t => t > cutoff);
  }

  /**
   * Measure event loop lag by scheduling a timer and checking actual vs expected delay.
   * Uses a 1-second interval; lag = (actual delay - expected delay).
   */
  private startEventLoopLagMeasurement(): void {
    const interval = 1000;
    this.lastEventLoopCheck = Date.now();
    this.eventLoopLagTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastEventLoopCheck;
      // Lag is how much longer than expected the callback took
      this.currentEventLoopLagMs = Math.max(0, elapsed - interval);
      this.lastEventLoopCheck = now;
    }, interval);
    // Don't keep the process alive just for lag measurement
    if (this.eventLoopLagTimer && typeof this.eventLoopLagTimer === 'object' && 'unref' in this.eventLoopLagTimer) {
      (this.eventLoopLagTimer as NodeJS.Timeout).unref();
    }
  }

  // ── Core health check ──

  private check(): void {
    const metrics = this.collectMetrics();
    this.evaluateRules(metrics);
    this.resolveStaleAlerts(metrics);
    this.computeOverallHealth(metrics);

    // Re-collect active alerts after rules have run (so new alerts appear in metrics)
    metrics.alerts = this.alerts.filter(a => !a.resolved);

    // Store in rolling history
    this.metricsHistory.push(metrics);
    if (this.metricsHistory.length > MAX_METRICS_HISTORY) {
      this.metricsHistory = this.metricsHistory.slice(-MAX_METRICS_HISTORY);
    }

    // Persist
    this.saveState();

    // Emit for listeners (e.g., SSE)
    this.emit('metrics', metrics);
  }

  private collectMetrics(): HealthMetrics {
    const scheduler = this.getScheduler?.() ?? null;
    const network = this.getNetwork?.() ?? null;

    const schedulerRunning = scheduler !== null && scheduler.getStatus().running;
    const peerCount = network?.getPeerCount() ?? 0;
    const activeTasks = scheduler ? scheduler.getStatus().activeTasks.length : 0;

    // Calculate success rate over the failure window
    this.pruneTaskHistory();
    const totalRecent = this.taskSuccesses.length + this.taskFailures.length;
    const recentSuccessRate = totalRecent > 0
      ? this.taskSuccesses.length / totalRecent
      : 1; // no data = healthy

    // Calculate agent spawn failure rate
    this.pruneSpawnHistory();
    const totalSpawns = this.spawnSuccesses.length + this.spawnFailures.length;
    const agentSpawnFailureRate = totalSpawns > 0
      ? this.spawnFailures.length / totalSpawns
      : 0; // no data = healthy

    // Collect memory usage
    const mem = process.memoryUsage();
    const memoryUsage = {
      heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024) * 100) / 100,
      heapTotalMB: Math.round(mem.heapTotal / (1024 * 1024) * 100) / 100,
      rssMB: Math.round(mem.rss / (1024 * 1024) * 100) / 100,
      heapUsedFraction: mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0,
    };

    // Ledger sync lag
    const ledgerSyncLagMs = this.lastLedgerSyncAt !== null
      ? Date.now() - this.lastLedgerSyncAt
      : null;

    // Get active (unresolved) alerts
    const activeAlerts = this.alerts.filter(a => !a.resolved);

    return {
      timestamp: Date.now(),
      nodeHealth: 'healthy', // computed later
      peerCount,
      schedulerRunning,
      activeTasks,
      recentSuccessRate,
      consecutiveFailures: this.consecutiveFailures,
      uptimeSeconds: Math.floor(process.uptime()),
      lastTaskCompletedAt: this.lastTaskCompletedAt,
      alerts: activeAlerts,
      memoryUsage,
      eventLoopLagMs: this.currentEventLoopLagMs,
      ledgerSyncLagMs,
      agentSpawnFailureRate,
    };
  }

  // ── Alert evaluation rules ──

  private evaluateRules(metrics: HealthMetrics): void {
    // Rule 1: SchedulerLike down
    if (!metrics.schedulerRunning && this.getScheduler) {
      // Only alert if a scheduler provider is configured (node has --scheduler)
      this.upsertAlert('scheduler_down', 'critical', 'Scheduler is not running.');
    }

    // Rule 2: No peers
    if (metrics.peerCount === 0) {
      if (this.zeroPeersSince === null) {
        this.zeroPeersSince = Date.now();
      }
      const noPeersDuration = Date.now() - this.zeroPeersSince;
      if (noPeersDuration >= this.config.stuckPeerThresholdMs) {
        this.upsertAlert(
          'no_peers',
          'warning',
          `No peers connected for ${Math.floor(noPeersDuration / 60_000)} minutes.`,
        );
      }
    } else {
      this.zeroPeersSince = null;
    }

    // Rule 3: High failure rate
    const totalRecent = this.taskSuccesses.length + this.taskFailures.length;
    if (totalRecent >= 5 && metrics.recentSuccessRate < (1 - this.config.failureRateThreshold)) {
      const pct = Math.round((1 - metrics.recentSuccessRate) * 100);
      this.upsertAlert(
        'high_failure_rate',
        'warning',
        `Task failure rate is ${pct}% over the last ${Math.floor(this.config.failureRateWindowMs / 60_000)} minutes.`,
      );
    }

    // Rule 4: Consecutive failures
    if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      this.upsertAlert(
        'consecutive_failures',
        'warning',
        `${this.consecutiveFailures} consecutive task failures detected.`,
      );
    }

    // Rule 5: High memory usage
    if (metrics.memoryUsage && metrics.memoryUsage.heapUsedFraction >= this.config.memoryUsageThreshold) {
      const pct = Math.round(metrics.memoryUsage.heapUsedFraction * 100);
      const severity: MonitorAlertSeverity = metrics.memoryUsage.heapUsedFraction >= 0.95 ? 'critical' : 'warning';
      this.upsertAlert(
        'high_memory_usage',
        severity,
        `Heap memory usage at ${pct}% (${metrics.memoryUsage.heapUsedMB}MB / ${metrics.memoryUsage.heapTotalMB}MB).`,
      );
    }

    // Rule 6: Event loop lag
    if (metrics.eventLoopLagMs !== undefined && metrics.eventLoopLagMs >= this.config.eventLoopLagThresholdMs) {
      const severity: MonitorAlertSeverity = metrics.eventLoopLagMs >= this.config.eventLoopLagThresholdMs * 3 ? 'critical' : 'warning';
      this.upsertAlert(
        'event_loop_lag',
        severity,
        `Event loop lag is ${metrics.eventLoopLagMs}ms (threshold: ${this.config.eventLoopLagThresholdMs}ms).`,
      );
    }

    // Rule 7: Ledger sync lag (only alert if we have sync data and it's stale)
    if (metrics.ledgerSyncLagMs !== null && metrics.ledgerSyncLagMs !== undefined
        && metrics.ledgerSyncLagMs >= this.config.ledgerSyncLagThresholdMs) {
      const lagMinutes = Math.floor(metrics.ledgerSyncLagMs / 60_000);
      this.upsertAlert(
        'ledger_sync_lag',
        'warning',
        `Ledger sync stale for ${lagMinutes} minutes (last sync: ${new Date(this.lastLedgerSyncAt!).toISOString()}).`,
      );
    }

    // Rule 8: Agent spawn failures (require minimum sample size to avoid false positives)
    const totalSpawns = this.spawnSuccesses.length + this.spawnFailures.length;
    if (totalSpawns >= 3 && metrics.agentSpawnFailureRate !== undefined
        && metrics.agentSpawnFailureRate >= this.config.spawnFailureRateThreshold) {
      const pct = Math.round(metrics.agentSpawnFailureRate * 100);
      this.upsertAlert(
        'agent_spawn_failures',
        'warning',
        `Agent spawn failure rate is ${pct}% (${this.spawnFailures.length} failures out of ${totalSpawns} spawns in ${Math.floor(this.config.spawnFailureWindowMs / 60_000)} minutes).`,
      );
    }
  }

  /**
   * Auto-resolve alerts whose conditions have cleared.
   */
  private resolveStaleAlerts(metrics: HealthMetrics): void {
    for (const alert of this.alerts) {
      if (alert.resolved) continue;

      let shouldResolve = false;

      switch (alert.type) {
        case 'scheduler_down':
          if (metrics.schedulerRunning) shouldResolve = true;
          break;
        case 'no_peers':
          if (metrics.peerCount > 0) shouldResolve = true;
          break;
        case 'high_failure_rate':
          if (metrics.recentSuccessRate >= (1 - this.config.failureRateThreshold)) shouldResolve = true;
          break;
        case 'consecutive_failures':
          if (this.consecutiveFailures < this.config.maxConsecutiveFailures) shouldResolve = true;
          break;
        case 'high_memory_usage':
          if (metrics.memoryUsage && metrics.memoryUsage.heapUsedFraction < this.config.memoryUsageThreshold) shouldResolve = true;
          break;
        case 'event_loop_lag':
          if (metrics.eventLoopLagMs !== undefined && metrics.eventLoopLagMs < this.config.eventLoopLagThresholdMs) shouldResolve = true;
          break;
        case 'ledger_sync_lag':
          if (metrics.ledgerSyncLagMs !== null && metrics.ledgerSyncLagMs !== undefined
              && metrics.ledgerSyncLagMs < this.config.ledgerSyncLagThresholdMs) shouldResolve = true;
          break;
        case 'agent_spawn_failures': {
          const totalSpawns = this.spawnSuccesses.length + this.spawnFailures.length;
          if (totalSpawns < 3 || (metrics.agentSpawnFailureRate !== undefined
              && metrics.agentSpawnFailureRate < this.config.spawnFailureRateThreshold)) shouldResolve = true;
          break;
        }
      }

      if (shouldResolve) {
        alert.resolved = true;
        alert.resolvedAt = Date.now();
        console.log(`[monitor] Alert auto-resolved: ${alert.type}`);
        this.emit('alert:resolved', alert);
      }
    }
  }

  /**
   * Compute overall health status from active alerts.
   */
  private computeOverallHealth(metrics: HealthMetrics): void {
    const activeAlerts = this.alerts.filter(a => !a.resolved);
    if (activeAlerts.some(a => a.severity === 'critical')) {
      metrics.nodeHealth = 'critical';
    } else if (activeAlerts.some(a => a.severity === 'warning')) {
      metrics.nodeHealth = 'degraded';
    } else {
      metrics.nodeHealth = 'healthy';
    }
  }

  // ── Alert management ──

  /**
   * Create or update an alert. Deduplicates by type:
   * 1. If an unresolved alert of the same type exists, increment its count (no new entry).
   * 2. If a recently-resolved alert of the same type exists (within ALERT_REOPEN_WINDOW_MS),
   *    reopen it instead of creating a new entry. This prevents oscillating conditions
   *    (e.g. memory usage hovering near threshold) from flooding the alerts array.
   * 3. Otherwise, create a new alert entry.
   */
  private upsertAlert(type: MonitorAlertType, severity: MonitorAlertSeverity, message: string): void {
    // Case 1: Active (unresolved) alert of the same type — just increment count
    const existing = this.alerts.find(a => a.type === type && !a.resolved);
    if (existing) {
      existing.lastSeen = Date.now();
      existing.count++;
      existing.message = message; // update with latest details
      return;
    }

    // Case 2: Recently-resolved alert of the same type — reopen it
    const now = Date.now();
    const recentlyResolved = this.alerts.find(
      a => a.type === type && a.resolved && a.resolvedAt && (now - a.resolvedAt) < ALERT_REOPEN_WINDOW_MS
    );
    if (recentlyResolved) {
      recentlyResolved.resolved = false;
      recentlyResolved.resolvedAt = undefined;
      recentlyResolved.lastSeen = now;
      recentlyResolved.count++;
      recentlyResolved.severity = severity;
      recentlyResolved.message = message;
      return;
    }

    // Case 3: No matching alert — create a new entry
    const alert: MonitorAlert = {
      id: randomBytes(8).toString('hex'),
      severity,
      type,
      message,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      count: 1,
      resolved: false,
      acknowledged: false,
    };

    this.alerts.unshift(alert);

    // Trim old alerts
    if (this.alerts.length > MAX_ALERTS) {
      this.alerts = this.alerts.slice(0, MAX_ALERTS);
    }

    console.log(`[monitor] Alert: [${severity}] ${type} — ${message}`);
    this.emit('alert', alert);

    // Phase 19.2: Notify external alert subscribers
    for (const cb of this.alertCallbacks) {
      try { cb(alert); } catch {}
    }
  }

  /**
   * Acknowledge an alert by ID.
   */
  acknowledgeAlert(alertId: string): MonitorAlert | null {
    const alert = this.alerts.find(a => a.id === alertId);
    if (!alert) return null;
    alert.acknowledged = true;
    alert.acknowledgedAt = Date.now();
    this.saveState();
    return alert;
  }

  // ── Audit Log ──

  /**
   * Record an action in the audit log.
   */
  private recordAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    const auditEntry: AuditEntry = {
      id: randomBytes(8).toString('hex'),
      timestamp: Date.now(),
      ...entry,
    };

    this.auditLog.unshift(auditEntry);

    // Trim to max entries
    if (this.auditLog.length > MAX_AUDIT_ENTRIES) {
      this.auditLog = this.auditLog.slice(0, MAX_AUDIT_ENTRIES);
    }

    this.saveAudit();
    this.emit('audit', auditEntry);
  }

  // ── Public getters ──

  /**
   * Get current health metrics snapshot (latest collected).
   */
  getCurrentMetrics(): HealthMetrics {
    if (this.metricsHistory.length > 0) {
      return this.metricsHistory[this.metricsHistory.length - 1];
    }
    // No metrics yet — return a baseline
    return this.collectMetrics();
  }

  /**
   * Get rolling metrics history (up to MAX_METRICS_HISTORY data points).
   */
  getMetricsHistory(): HealthMetrics[] {
    return [...this.metricsHistory];
  }

  /**
   * Get all alerts (active + resolved), newest first.
   */
  getAlerts(): MonitorAlert[] {
    return [...this.alerts];
  }

  /**
   * Get current monitor configuration.
   */
  getConfig(): MonitorConfig {
    return { ...this.config };
  }

  /**
   * Update monitor configuration. Restarts the timer if interval changed.
   * Persists changes to disk so they survive restarts.
   */
  updateConfig(partial: Partial<MonitorConfig>): MonitorConfig {
    const oldInterval = this.config.checkIntervalMs;
    Object.assign(this.config, partial);

    // Restart timer if interval changed and we're running
    if (this.running && this.config.checkIntervalMs !== oldInterval) {
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.check(), this.config.checkIntervalMs);
    }

    this.saveConfig();
    this.saveState();
    return { ...this.config };
  }

  /**
   * Get the audit log (newest first).
   */
  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }

  /**
   * Get structured data for the manager to read.
   * Returns metrics, alerts, and audit trail in a single object.
   */
  getDataForManager(): { metrics: HealthMetrics[]; alerts: MonitorAlert[]; auditTrail: AuditEntry[] } {
    return {
      metrics: this.getMetricsHistory(),
      alerts: this.getAlerts(),
      auditTrail: this.getAuditLog(),
    };
  }

  /**
   * Get recovery actions configuration.
   */
  getRecoveryActions(): RecoveryAction[] {
    return this.recoveryActions.map(r => ({ ...r }));
  }

  /**
   * TD-27: Set the full recovery config (replaces all recovery actions).
   * Persists to ~/.pando/monitor/recovery-config.json on every call.
   * Follows the same pattern as guardrails.json (sync write on change).
   */
  setRecoveryConfig(actions: RecoveryAction[]): RecoveryAction[] {
    this.recoveryActions = actions.map(r => ({ ...r }));
    this.saveRecoveryConfig();
    return this.getRecoveryActions();
  }

  /**
   * Update recovery action configuration.
   * Merges updates by trigger name — only updates matching actions.
   * Persists to recovery-config.json after update.
   */
  updateRecoveryActions(updates: Array<{
    trigger: MonitorAlertType;
    enabled?: boolean;
    cooldownMs?: number;
    action?: RecoveryActionType;
  }>): RecoveryAction[] {
    for (const update of updates) {
      const existing = this.recoveryActions.find(r => r.trigger === update.trigger);
      if (existing) {
        if (update.enabled !== undefined) existing.enabled = update.enabled;
        if (update.cooldownMs !== undefined) existing.cooldownMs = update.cooldownMs;
        if (update.action !== undefined) existing.action = update.action;
      }
    }
    this.saveRecoveryConfig();
    return this.getRecoveryActions();
  }

  // ── Persistence ──

  /**
   * TD-27: Load recovery config from disk (sync read on startup).
   * Reads from recovery-config.json; falls back to legacy recovery.json
   * for backward compatibility; uses defaults if neither file exists.
   * Same pattern as guardrails.json loadConfig().
   */
  private loadRecoveryConfig(): void {
    // Try the new recovery-config.json first
    try {
      if (existsSync(this.recoveryConfigPath)) {
        const data = JSON.parse(readFileSync(this.recoveryConfigPath, 'utf-8'));
        if (Array.isArray(data) && data.length > 0) {
          this.recoveryActions = data;
          return;
        }
      }
    } catch {
      // Corrupt config — fall through to legacy or defaults
    }

    // Backward compat: try legacy recovery.json
    try {
      if (existsSync(this.recoveryPath)) {
        const data = JSON.parse(readFileSync(this.recoveryPath, 'utf-8'));
        if (Array.isArray(data) && data.length > 0) {
          this.recoveryActions = data;
          // Migrate: write to the new config file so future reads use it
          this.saveRecoveryConfig();
          return;
        }
      }
    } catch {
      // Corrupt legacy config — fall through to defaults
    }

    // No config file exists — use defaults and persist
    this.recoveryActions = DEFAULT_RECOVERY_ACTIONS.map(r => ({ ...r }));
    this.saveRecoveryConfig();
  }

  /**
   * TD-27: Save recovery config to disk (sync write on change).
   * Writes to ~/.pando/monitor/recovery-config.json.
   * Same pattern as guardrails.json saveConfig().
   */
  private saveRecoveryConfig(): void {
    try {
      writeFileSync(this.recoveryConfigPath, JSON.stringify(this.recoveryActions, null, 2));
    } catch (err: any) {
      console.error(`[monitor] Failed to save recovery config: ${err.message}`);
    }
  }

  private loadState(): void {
    try {
      if (existsSync(this.metricsPath)) {
        const data = JSON.parse(readFileSync(this.metricsPath, 'utf-8'));
        if (Array.isArray(data)) {
          this.metricsHistory = data.slice(-MAX_METRICS_HISTORY);
        }
      }
    } catch {
      this.metricsHistory = [];
    }

    try {
      if (existsSync(this.alertsPath)) {
        const data = JSON.parse(readFileSync(this.alertsPath, 'utf-8'));
        if (Array.isArray(data)) {
          this.alerts = data.slice(0, MAX_ALERTS);
        }
      }
    } catch {
      this.alerts = [];
    }

    // Load audit log
    try {
      if (existsSync(this.auditPath)) {
        const data = JSON.parse(readFileSync(this.auditPath, 'utf-8'));
        if (Array.isArray(data)) {
          this.auditLog = data.slice(0, MAX_AUDIT_ENTRIES);
        }
      }
    } catch {
      this.auditLog = [];
    }

    // Load persisted monitor config (overrides defaults, preserving runtime overrides)
    try {
      if (existsSync(this.configPath)) {
        const data = JSON.parse(readFileSync(this.configPath, 'utf-8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          this.config = { ...this.config, ...data };
        }
      }
    } catch {
      // Persisted config corrupt or unreadable — keep current config
    }

    // TD-27: Load recovery config from dedicated file (with backward compat)
    this.loadRecoveryConfig();

    // Restore consecutive failures from persisted metrics
    if (this.metricsHistory.length > 0) {
      const last = this.metricsHistory[this.metricsHistory.length - 1];
      this.consecutiveFailures = last.consecutiveFailures || 0;
      this.lastTaskCompletedAt = last.lastTaskCompletedAt || null;
    }
  }

  private saveState(): void {
    try {
      writeFileSync(this.metricsPath, JSON.stringify(this.metricsHistory, null, 2));
    } catch (err: any) {
      console.error(`[monitor] Failed to save metrics: ${err.message}`);
    }
    try {
      writeFileSync(this.alertsPath, JSON.stringify(this.alerts, null, 2));
    } catch (err: any) {
      console.error(`[monitor] Failed to save alerts: ${err.message}`);
    }
  }

  private saveAudit(): void {
    try {
      writeFileSync(this.auditPath, JSON.stringify(this.auditLog, null, 2));
    } catch (err: any) {
      console.error(`[monitor] Failed to save audit log: ${err.message}`);
    }
  }

  private saveConfig(): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (err: any) {
      console.error(`[monitor] Failed to save monitor config: ${err.message}`);
    }
  }
}
