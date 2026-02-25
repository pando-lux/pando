/**
 * Security Monitor — anomaly detection, alert management, and quarantine system.
 *
 * Detects security threats via 5 specialized detectors:
 *   1. MessageRateMonitor — detects GossipSub message flooding
 *   2. TransactionConflictDetector — detects double-spend / conflicting transactions
 *   3. SybilDetector — detects clusters of suspiciously correlated peers
 *   4. ProfilePoisoningDetector — detects malicious profile payloads
 *   5. EmissionAbuseDetector — detects abnormal emission patterns
 *
 * Auto-quarantine: peers that trigger critical alerts are quarantined.
 * Alert persistence: stored at ~/.pando/security/alerts.json
 * Event emission: emits 'security:alert' for HealthMonitor integration.
 *
 * Follows patterns from health-monitor.ts and guardrails.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PandoNetwork } from './network.js';
import type { PandoLedger } from '@pando/ledger';
import type { EmissionWitness } from './emission-witness.js';

// ── Types ────────────────────────────────────────────────────

export type SecurityAlertSeverity = 'info' | 'warning' | 'critical';

export type SecurityAlertType =
  | 'message_flood'
  | 'transaction_conflict'
  | 'sybil_cluster'
  | 'profile_poisoning'
  | 'emission_abuse';

export interface SecurityAlert {
  id: string;
  type: SecurityAlertType;
  severity: SecurityAlertSeverity;
  source: string;           // the peer that triggered the alert
  description: string;      // human-readable alert message
  evidence: Record<string, any>; // supporting data for the alert
  timestamp: number;
  resolved: boolean;
  resolvedAt?: number;
}

export type QuarantineLevel = 1 | 2 | 3;

export interface QuarantineEntry {
  peerId: string;
  reason: string;
  alertId: string;
  quarantinedAt: number;
  releasedAt?: number;
  active: boolean;
  level: QuarantineLevel;      // Phase 12.6: quarantine severity level
  appealReason?: string;       // Phase 12.6: appeal reason if appealed
  appealedAt?: number;         // Phase 12.6: when appeal was submitted
}

export interface SecurityStats {
  totalAlerts: number;
  activeAlerts: number;
  resolvedAlerts: number;
  alertsByType: Record<SecurityAlertType, number>;
  quarantinedPeers: number;
  detectorStatus: Record<string, boolean>;
  lastCheckAt: number | null;
}

// ── Constants ────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 30_000;          // 30 seconds
const MAX_ALERTS = 200;
const MAX_QUARANTINE_ENTRIES = 200;

// MessageRateMonitor thresholds
const MSG_RATE_WINDOW_MS = 60_000;         // 1 minute window
const MSG_RATE_THRESHOLD = 100;            // 100 msgs/min per peer = flood

// TransactionConflictDetector
const TX_CONFLICT_WINDOW_MS = 5 * 60_000;  // 5 minute window
const TX_CONFLICT_THRESHOLD = 3;            // 3 conflicting txs = alert

// SybilDetector
const SYBIL_CORRELATION_WINDOW_MS = 60 * 60_000; // 1 hour window
const SYBIL_PEERS_PER_IP_THRESHOLD = 3;           // 3 peers per IP per hour = suspicious
const SYBIL_JOIN_BURST_THRESHOLD = 5;             // 5 peers joining in 30s = suspicious burst

// ProfilePoisoningDetector
const PROFILE_MAX_FIELD_LENGTH = 10_000;    // 10KB max for any profile field
const PROFILE_SUSPICIOUS_SCORE_THRESHOLD = 10; // score > 10 = suspicious
const PROFILE_SUSPICIOUS_PATTERNS = [
  /<script/i,
  /javascript:/i,
  /data:text\/html/i,
  /\0/,                                      // null bytes
];

// EmissionAbuseDetector
const EMISSION_ABUSE_WINDOW_MS = 60 * 60_000; // 1 hour
const EMISSION_ABUSE_THRESHOLD = 50;           // >50 emission proposals/hour = suspicious

// Quarantine
const QUARANTINE_DURATION_MS = 60 * 60_000;   // 1 hour quarantine duration

// ── Detector Interfaces ──────────────────────────────────────

interface DetectorContext {
  network: PandoNetwork | null;
  ledger: PandoLedger | null;
  emissionWitness: EmissionWitness | null;
  localPeerId: string;
}

interface AnomalyDetector {
  name: string;
  enabled: boolean;
  check(ctx: DetectorContext): SecurityAlert[];
}

// ── MessageRateMonitor ───────────────────────────────────────

class MessageRateMonitor implements AnomalyDetector {
  name = 'MessageRateMonitor';
  enabled = true;
  // peerId → timestamps of recent messages
  private messageLog: Map<string, number[]> = new Map();

  recordMessage(peerId: string): void {
    const now = Date.now();
    const timestamps = this.messageLog.get(peerId) || [];
    timestamps.push(now);
    this.messageLog.set(peerId, timestamps);
  }

  check(ctx: DetectorContext): SecurityAlert[] {
    const alerts: SecurityAlert[] = [];
    const now = Date.now();
    const cutoff = now - MSG_RATE_WINDOW_MS;

    for (const [peerId, timestamps] of this.messageLog) {
      if (peerId === ctx.localPeerId) continue;
      const recent = timestamps.filter(t => t > cutoff);
      this.messageLog.set(peerId, recent);

      if (recent.length >= MSG_RATE_THRESHOLD) {
        alerts.push({
          id: randomBytes(8).toString('hex'),
          type: 'message_flood',
          severity: recent.length >= MSG_RATE_THRESHOLD * 2 ? 'critical' : 'warning',
          source: peerId,
          description: `Peer ${peerId.slice(0, 12)} sent ${recent.length} messages in the last minute (threshold: ${MSG_RATE_THRESHOLD})`,
          timestamp: now,
          resolved: false,
          evidence: { messageCount: recent.length, windowMs: MSG_RATE_WINDOW_MS, detectorName: this.name },
        });
      }
    }

    // Cleanup peers with no recent messages
    for (const [peerId, timestamps] of this.messageLog) {
      if (timestamps.length === 0) {
        this.messageLog.delete(peerId);
      }
    }

    return alerts;
  }
}

// ── TransactionConflictDetector ──────────────────────────────

class TransactionConflictDetector implements AnomalyDetector {
  name = 'TransactionConflictDetector';
  enabled = true;
  // peerId → [{ txId, timestamp }]
  private txLog: Map<string, Array<{ id: string; timestamp: number; from: string; to: string; amount: number }>> = new Map();

  recordTransaction(peerId: string, tx: { id: string; from: string; to: string; amount: number }): void {
    const entries = this.txLog.get(peerId) || [];
    entries.push({ ...tx, timestamp: Date.now() });
    this.txLog.set(peerId, entries);
  }

  check(ctx: DetectorContext): SecurityAlert[] {
    const alerts: SecurityAlert[] = [];
    const now = Date.now();
    const cutoff = now - TX_CONFLICT_WINDOW_MS;

    for (const [peerId, txs] of this.txLog) {
      // Prune old entries
      const recent = txs.filter(t => t.timestamp > cutoff);
      this.txLog.set(peerId, recent);

      if (recent.length < 2) continue;

      // Detect conflicting transactions: same sender, overlapping time, different recipients or amounts
      const conflicts: string[] = [];
      for (let i = 0; i < recent.length; i++) {
        for (let j = i + 1; j < recent.length; j++) {
          const a = recent[i];
          const b = recent[j];
          // Same from, same amount, different to — potential double-spend
          if (a.from === b.from && a.amount === b.amount && a.to !== b.to) {
            conflicts.push(`${a.id.slice(0, 8)} vs ${b.id.slice(0, 8)}`);
          }
        }
      }

      if (conflicts.length >= TX_CONFLICT_THRESHOLD) {
        alerts.push({
          id: randomBytes(8).toString('hex'),
          type: 'transaction_conflict',
          severity: 'critical',
          source: peerId,
          description: `Peer ${peerId.slice(0, 12)} has ${conflicts.length} conflicting transactions in the last ${TX_CONFLICT_WINDOW_MS / 60_000} minutes`,
          timestamp: now,
          resolved: false,
          evidence: { conflictCount: conflicts.length, conflicts: conflicts.slice(0, 10), detectorName: this.name },
        });
      }
    }

    return alerts;
  }
}

// ── SybilDetector ────────────────────────────────────────────

class SybilDetector implements AnomalyDetector {
  name = 'SybilDetector';
  enabled = true;
  // Track peer join timestamps
  private joinLog: Array<{ peerId: string; timestamp: number }> = [];

  recordPeerJoin(peerId: string): void {
    this.joinLog.push({ peerId, timestamp: Date.now() });
  }

  check(ctx: DetectorContext): SecurityAlert[] {
    const alerts: SecurityAlert[] = [];
    const now = Date.now();
    const cutoff = now - SYBIL_CORRELATION_WINDOW_MS;

    // Prune old entries
    this.joinLog = this.joinLog.filter(e => e.timestamp > cutoff);

    // Check for burst joins: many peers appearing within a short window
    const recentJoins = this.joinLog.filter(e => e.timestamp > now - 30_000); // last 30 seconds
    if (recentJoins.length >= SYBIL_JOIN_BURST_THRESHOLD) {
      const peerIds = recentJoins.map(e => e.peerId);
      // Deduplicate
      const uniquePeers = [...new Set(peerIds)];
      if (uniquePeers.length >= SYBIL_JOIN_BURST_THRESHOLD) {
        alerts.push({
          id: randomBytes(8).toString('hex'),
          type: 'sybil_cluster',
          severity: 'warning',
          source: uniquePeers[0],
          description: `${uniquePeers.length} peers joined within 30 seconds — possible Sybil cluster`,
          timestamp: now,
          resolved: false,
          evidence: {
            peerCount: uniquePeers.length,
            peerIds: uniquePeers.map(p => p.slice(0, 12)),
            windowSeconds: 30,
            detectorName: this.name,
          },
        });
      }
    }

    return alerts;
  }
}

// ── ProfilePoisoningDetector ─────────────────────────────────

class ProfilePoisoningDetector implements AnomalyDetector {
  name = 'ProfilePoisoningDetector';
  enabled = true;
  private flaggedProfiles: Map<string, number> = new Map();

  recordProfile(peerId: string, profile: Record<string, any>): void {
    let suspiciousScore = 0;

    for (const [_key, value] of Object.entries(profile)) {
      if (typeof value !== 'string') continue;

      // Check field length
      if (value.length > PROFILE_MAX_FIELD_LENGTH) {
        suspiciousScore += 2;
      }

      // Check for injection patterns
      for (const pattern of PROFILE_SUSPICIOUS_PATTERNS) {
        if (pattern.test(value)) {
          suspiciousScore += 3;
        }
      }
    }

    if (suspiciousScore > 0) {
      const prev = this.flaggedProfiles.get(peerId) || 0;
      this.flaggedProfiles.set(peerId, prev + suspiciousScore);
    }
  }

  check(_ctx: DetectorContext): SecurityAlert[] {
    const alerts: SecurityAlert[] = [];
    const now = Date.now();

    for (const [peerId, score] of this.flaggedProfiles) {
      if (score > PROFILE_SUSPICIOUS_SCORE_THRESHOLD) {
        alerts.push({
          id: randomBytes(8).toString('hex'),
          type: 'profile_poisoning',
          severity: score > PROFILE_SUSPICIOUS_SCORE_THRESHOLD * 2 ? 'critical' : 'warning',
          source: peerId,
          description: `Peer ${peerId.slice(0, 12)} has suspicious profile content (score: ${score})`,
          timestamp: now,
          resolved: false,
          evidence: { suspiciousScore: score, detectorName: this.name },
        });
      }
    }

    // Reset after check
    this.flaggedProfiles.clear();

    return alerts;
  }
}

// ── EmissionAbuseDetector ────────────────────────────────────

class EmissionAbuseDetector implements AnomalyDetector {
  name = 'EmissionAbuseDetector';
  enabled = true;
  // peerId → proposal timestamps
  private proposalLog: Map<string, number[]> = new Map();

  recordProposal(peerId: string): void {
    const timestamps = this.proposalLog.get(peerId) || [];
    timestamps.push(Date.now());
    this.proposalLog.set(peerId, timestamps);
  }

  check(ctx: DetectorContext): SecurityAlert[] {
    const alerts: SecurityAlert[] = [];
    const now = Date.now();
    const cutoff = now - EMISSION_ABUSE_WINDOW_MS;

    for (const [peerId, timestamps] of this.proposalLog) {
      const recent = timestamps.filter(t => t > cutoff);
      this.proposalLog.set(peerId, recent);

      if (recent.length >= EMISSION_ABUSE_THRESHOLD) {
        alerts.push({
          id: randomBytes(8).toString('hex'),
          type: 'emission_abuse',
          severity: recent.length >= EMISSION_ABUSE_THRESHOLD * 2 ? 'critical' : 'warning',
          source: peerId,
          description: `Peer ${peerId.slice(0, 12)} submitted ${recent.length} emission proposals in the last hour (threshold: ${EMISSION_ABUSE_THRESHOLD})`,
          timestamp: now,
          resolved: false,
          evidence: { proposalCount: recent.length, windowMs: EMISSION_ABUSE_WINDOW_MS, detectorName: this.name },
        });
      }
    }

    // Cleanup peers with no recent proposals
    for (const [peerId, timestamps] of this.proposalLog) {
      if (timestamps.length === 0) {
        this.proposalLog.delete(peerId);
      }
    }

    return alerts;
  }
}

// ── SecurityMonitor Class ────────────────────────────────────

export class SecurityMonitor extends EventEmitter {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private localPeerId: string;

  // External references
  private network: PandoNetwork | null = null;
  private ledger: PandoLedger | null = null;
  private emissionWitness: EmissionWitness | null = null;

  // Detectors
  private messageRateMonitor: MessageRateMonitor;
  private transactionConflictDetector: TransactionConflictDetector;
  private sybilDetector: SybilDetector;
  private profilePoisoningDetector: ProfilePoisoningDetector;
  private emissionAbuseDetector: EmissionAbuseDetector;
  private detectors: AnomalyDetector[];

  // Alert storage
  private alerts: SecurityAlert[] = [];

  // Quarantine
  private quarantine: QuarantineEntry[] = [];

  // Persistence paths
  private securityDir: string;
  private alertsPath: string;
  private quarantinePath: string;

  // Stats
  private lastCheckAt: number | null = null;

  constructor(dataDir: string, localPeerId: string) {
    super();
    this.localPeerId = localPeerId;
    this.securityDir = join(dataDir, 'security');
    this.alertsPath = join(this.securityDir, 'alerts.json');
    this.quarantinePath = join(this.securityDir, 'quarantine.json');

    // Ensure security directory exists
    if (!existsSync(this.securityDir)) {
      mkdirSync(this.securityDir, { recursive: true });
    }

    // Initialize detectors
    this.messageRateMonitor = new MessageRateMonitor();
    this.transactionConflictDetector = new TransactionConflictDetector();
    this.sybilDetector = new SybilDetector();
    this.profilePoisoningDetector = new ProfilePoisoningDetector();
    this.emissionAbuseDetector = new EmissionAbuseDetector();

    this.detectors = [
      this.messageRateMonitor,
      this.transactionConflictDetector,
      this.sybilDetector,
      this.profilePoisoningDetector,
      this.emissionAbuseDetector,
    ];

    // Load persisted state
    this.loadState();
  }

  // ── Dependency injection ───────────────────────────────────

  setNetwork(network: PandoNetwork): void {
    this.network = network;
  }

  setLedger(ledger: PandoLedger): void {
    this.ledger = ledger;
  }

  setEmissionWitness(ew: EmissionWitness): void {
    this.emissionWitness = ew;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('[security] Security monitor started.');

    // Run first check immediately
    this.runCheck();

    // Schedule periodic checks
    this.timer = setInterval(() => this.runCheck(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.saveState();
    console.log('[security] Security monitor stopped.');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Event Recording (called from PandoNode / network hooks) ─

  /** Record a GossipSub message for rate monitoring. */
  recordMessage(peerId: string): void {
    this.messageRateMonitor.recordMessage(peerId);
  }

  /** Record a transaction for conflict detection. */
  recordTransaction(peerId: string, tx: { id: string; from: string; to: string; amount: number }): void {
    this.transactionConflictDetector.recordTransaction(peerId, tx);
  }

  /** Record a peer join event for Sybil detection. */
  recordPeerJoin(peerId: string): void {
    this.sybilDetector.recordPeerJoin(peerId);
  }

  /** Record a profile update for poisoning detection. */
  recordProfile(peerId: string, profile: Record<string, any>): void {
    this.profilePoisoningDetector.recordProfile(peerId, profile);
  }

  /** Record an emission proposal for abuse detection. */
  recordEmissionProposal(peerId: string): void {
    this.emissionAbuseDetector.recordProposal(peerId);
  }

  // ── Core check loop ────────────────────────────────────────

  private runCheck(): void {
    const ctx: DetectorContext = {
      network: this.network,
      ledger: this.ledger,
      emissionWitness: this.emissionWitness,
      localPeerId: this.localPeerId,
    };

    for (const detector of this.detectors) {
      if (!detector.enabled) continue;

      try {
        const newAlerts = detector.check(ctx);
        for (const alert of newAlerts) {
          this.processAlert(alert);
        }
      } catch (err: any) {
        console.error(`[security] Detector ${detector.name} error: ${err.message}`);
      }
    }

    // Auto-release quarantined peers after QUARANTINE_DURATION_MS (1 hour)
    this.releaseExpiredQuarantines();

    this.lastCheckAt = Date.now();
    this.saveState();
  }

  /** Auto-release quarantined peers whose quarantine duration has expired. */
  private releaseExpiredQuarantines(): void {
    const now = Date.now();
    for (const entry of this.quarantine) {
      if (entry.active && (now - entry.quarantinedAt) >= QUARANTINE_DURATION_MS) {
        entry.active = false;
        entry.releasedAt = now;

        // Resolve associated alert
        const alert = this.alerts.find(a => a.id === entry.alertId && !a.resolved);
        if (alert) {
          alert.resolved = true;
          alert.resolvedAt = now;
        }

        console.log(`[security] Auto-released quarantined peer: ${entry.peerId.slice(0, 12)} (1 hour expired)`);
        this.emit('security:release', entry);
      }
    }
  }

  // ── Alert processing ───────────────────────────────────────

  private processAlert(alert: SecurityAlert): void {
    // Deduplicate: if an active alert of the same type for the same peer exists, skip
    const existing = this.alerts.find(
      a => a.type === alert.type && a.source === alert.source && !a.resolved,
    );
    if (existing) {
      // Update timestamp on existing alert
      existing.timestamp = alert.timestamp;
      existing.evidence = alert.evidence;
      return;
    }

    this.alerts.unshift(alert);

    // Trim old alerts
    if (this.alerts.length > MAX_ALERTS) {
      this.alerts = this.alerts.slice(0, MAX_ALERTS);
    }

    console.log(`[security] Alert: [${alert.severity}] ${alert.type} — ${alert.description}`);

    // Emit event for HealthMonitor integration
    this.emit('security:alert', alert);

    // Auto-quarantine on critical alerts
    if (alert.severity === 'critical') {
      this.quarantinePeer(alert.source, alert.description, alert.id);
    }
  }

  // ── Quarantine system ──────────────────────────────────────

  private quarantinePeer(peerId: string, reason: string, alertId: string, level: QuarantineLevel = 1): void {
    // Don't quarantine ourselves
    if (peerId === this.localPeerId) return;

    // Check if already quarantined — upgrade level if needed
    const existing = this.quarantine.find(q => q.peerId === peerId && q.active);
    if (existing) {
      if (level > existing.level) {
        existing.level = level;
        existing.reason = reason;
        console.log(`[security] Quarantine level upgraded for ${peerId.slice(0, 12)}: level ${existing.level} → ${level}`);
        this.emit('security:quarantine_upgrade', existing);
        this.saveState();
      }
      return;
    }

    const entry: QuarantineEntry = {
      peerId,
      reason,
      alertId,
      quarantinedAt: Date.now(),
      active: true,
      level,
    };

    this.quarantine.unshift(entry);

    // Trim old entries
    if (this.quarantine.length > MAX_QUARANTINE_ENTRIES) {
      this.quarantine = this.quarantine.slice(0, MAX_QUARANTINE_ENTRIES);
    }

    console.log(`[security] Quarantined peer: ${peerId.slice(0, 12)} — level ${level} — ${reason}`);
    this.emit('security:quarantine', entry);
    this.saveState();
  }

  /** Release a peer from quarantine. */
  releasePeer(peerId: string): QuarantineEntry | null {
    const entry = this.quarantine.find(q => q.peerId === peerId && q.active);
    if (!entry) return null;

    entry.active = false;
    entry.releasedAt = Date.now();

    // Resolve associated alert
    const alert = this.alerts.find(a => a.id === entry.alertId && !a.resolved);
    if (alert) {
      alert.resolved = true;
      alert.resolvedAt = Date.now();
    }

    console.log(`[security] Released peer from quarantine: ${peerId.slice(0, 12)}`);
    this.emit('security:release', entry);
    this.saveState();
    return entry;
  }

  /** Check if a peer is currently quarantined. */
  isQuarantined(peerId: string): boolean {
    return this.quarantine.some(q => q.peerId === peerId && q.active);
  }

  /** Get the quarantine level for a peer (0 if not quarantined). */
  getQuarantineLevel(peerId: string): QuarantineLevel | 0 {
    const entry = this.quarantine.find(q => q.peerId === peerId && q.active);
    return entry ? entry.level : 0;
  }

  // ── Tiered Quarantine Protocol (Phase 12.6) ───────────────

  /**
   * Level 1 (suspicious): stop accepting messages, log interactions, alert governance.
   * Triggered by warning-level alerts.
   */
  quarantineLevel1(peerId: string, reason: string): QuarantineEntry | null {
    if (peerId === this.localPeerId) return null;

    const alertId = randomBytes(8).toString('hex');
    const alert: SecurityAlert = {
      id: alertId,
      type: 'message_flood',
      severity: 'warning',
      source: peerId,
      description: `Level 1 quarantine: ${reason}`,
      timestamp: Date.now(),
      resolved: false,
      evidence: { quarantineLevel: 1, reason },
    };
    this.processAlert(alert);
    this.quarantinePeer(peerId, reason, alertId, 1);

    console.log(`[security] Level 1 quarantine for ${peerId.slice(0, 12)}: stop accepting messages, logging interactions`);
    this.emit('security:quarantine_level1', { peerId, reason });

    return this.quarantine.find(q => q.peerId === peerId && q.active) || null;
  }

  /**
   * Level 2 (confirmed): broadcast quarantine notice to peers.
   * Triggered by critical alerts or escalation from Level 1.
   */
  quarantineLevel2(peerId: string, reason: string): QuarantineEntry | null {
    if (peerId === this.localPeerId) return null;

    const alertId = randomBytes(8).toString('hex');
    const alert: SecurityAlert = {
      id: alertId,
      type: 'transaction_conflict',
      severity: 'critical',
      source: peerId,
      description: `Level 2 quarantine: ${reason}`,
      timestamp: Date.now(),
      resolved: false,
      evidence: { quarantineLevel: 2, reason },
    };
    this.processAlert(alert);
    this.quarantinePeer(peerId, reason, alertId, 2);

    console.log(`[security] Level 2 quarantine for ${peerId.slice(0, 12)}: broadcasting quarantine notice to peers`);
    this.emit('security:quarantine_level2', { peerId, reason });

    return this.quarantine.find(q => q.peerId === peerId && q.active) || null;
  }

  /**
   * Level 3 (network threat): trigger emergency governance vote.
   * Only for the most severe threats — requires governance consensus.
   */
  quarantineLevel3(peerId: string, reason: string): QuarantineEntry | null {
    if (peerId === this.localPeerId) return null;

    const alertId = randomBytes(8).toString('hex');
    const alert: SecurityAlert = {
      id: alertId,
      type: 'sybil_cluster',
      severity: 'critical',
      source: peerId,
      description: `Level 3 quarantine (network threat): ${reason}`,
      timestamp: Date.now(),
      resolved: false,
      evidence: { quarantineLevel: 3, reason, emergencyVoteRequired: true },
    };
    this.processAlert(alert);
    this.quarantinePeer(peerId, reason, alertId, 3);

    console.log(`[security] Level 3 quarantine for ${peerId.slice(0, 12)}: emergency governance vote triggered`);
    this.emit('security:quarantine_level3', { peerId, reason, emergencyVoteRequired: true });

    return this.quarantine.find(q => q.peerId === peerId && q.active) || null;
  }

  /**
   * Get all quarantined peers (active only) with full entry data.
   */
  getQuarantinedPeers(): QuarantineEntry[] {
    return this.quarantine.filter(q => q.active);
  }

  /**
   * Appeal a quarantine. Records the appeal reason and emits an event
   * for governance to review. Does NOT automatically release the peer.
   */
  appealQuarantine(peerId: string, appealReason: string): QuarantineEntry | null {
    const entry = this.quarantine.find(q => q.peerId === peerId && q.active);
    if (!entry) return null;

    entry.appealReason = appealReason;
    entry.appealedAt = Date.now();

    console.log(`[security] Quarantine appeal from ${peerId.slice(0, 12)}: ${appealReason}`);
    this.emit('security:appeal', { peerId, appealReason, entry });
    this.saveState();

    return entry;
  }

  // ── Public getters (for API endpoints) ─────────────────────

  getAlerts(limit = 100): SecurityAlert[] {
    return this.alerts.slice(0, limit);
  }

  getActiveAlerts(): SecurityAlert[] {
    return this.alerts.filter(a => !a.resolved);
  }

  getQuarantine(): QuarantineEntry[] {
    return this.quarantine.filter(q => q.active);
  }

  getAllQuarantine(): QuarantineEntry[] {
    return [...this.quarantine];
  }

  getStats(): SecurityStats {
    const activeAlerts = this.alerts.filter(a => !a.resolved);
    const resolvedAlerts = this.alerts.filter(a => a.resolved);
    const alertsByType: Record<SecurityAlertType, number> = {
      message_flood: 0,
      transaction_conflict: 0,
      sybil_cluster: 0,
      profile_poisoning: 0,
      emission_abuse: 0,
    };

    for (const alert of this.alerts) {
      alertsByType[alert.type]++;
    }

    const detectorStatus: Record<string, boolean> = {};
    for (const detector of this.detectors) {
      detectorStatus[detector.name] = detector.enabled;
    }

    return {
      totalAlerts: this.alerts.length,
      activeAlerts: activeAlerts.length,
      resolvedAlerts: resolvedAlerts.length,
      alertsByType,
      quarantinedPeers: this.quarantine.filter(q => q.active).length,
      detectorStatus,
      lastCheckAt: this.lastCheckAt,
    };
  }

  // ── Persistence ────────────────────────────────────────────

  private loadState(): void {
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

    try {
      if (existsSync(this.quarantinePath)) {
        const data = JSON.parse(readFileSync(this.quarantinePath, 'utf-8'));
        if (Array.isArray(data)) {
          this.quarantine = data.slice(0, MAX_QUARANTINE_ENTRIES);
        }
      }
    } catch {
      this.quarantine = [];
    }
  }

  private saveState(): void {
    try {
      writeFileSync(this.alertsPath, JSON.stringify(this.alerts, null, 2));
    } catch (err: any) {
      console.error(`[security] Failed to save alerts: ${err.message}`);
    }
    try {
      writeFileSync(this.quarantinePath, JSON.stringify(this.quarantine, null, 2));
    } catch (err: any) {
      console.error(`[security] Failed to save quarantine: ${err.message}`);
    }
  }
}
