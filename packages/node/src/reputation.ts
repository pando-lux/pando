/**
 * Reputation Manager — Phase 10.3
 *
 * Tracks agent performance across the network. Nodes with better track
 * records get priority for task claiming. Reputation is built from:
 * tasks completed, build/test pass rates, completion speed, and peer
 * endorsements.
 *
 * - Local reputation stored at ~/.pando/reputation.json
 * - Remote reputations stored at ~/.pando/reputation-peers.json
 * - Broadcasts via pando/agent-events with type REPUTATION_UPDATE
 * - Only broadcasts when score changes by > 5% (spam prevention)
 * - Registers "reputation_query" handler on RequestReplyManager
 * - On peer connect, requests reputation via RequestReplyManager
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import type { PandoNetwork } from './network.js';
import type { RequestReplyManager } from './request-reply.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface ReputationRecord {
  nodeId: string;
  tasksCompleted: number;
  tasksFailed: number;
  tasksTimedOut: number;
  avgCompletionMs: number;
  buildPassRate: number;         // 0.0 - 1.0
  testPassRate: number;          // 0.0 - 1.0
  profilesContributed: number;
  reputationScore: number;       // Computed weighted sum
  lastUpdated: number;
  history: ReputationEvent[];    // Last 100 events
}

export interface ReputationEvent {
  timestamp: number;
  type: 'task_completed' | 'task_failed' | 'task_timed_out' | 'profile_shared' | 'peer_endorsement';
  detail: string;
  scoreDelta: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_HISTORY = 100;
const BROADCAST_THRESHOLD = 0.05; // 5% score change triggers broadcast
const MAX_PEER_RECORDS = 1000;
const STALE_RECORD_MS = 7 * 86_400_000; // 7 days
const PRUNE_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours

// ── ReputationManager ───────────────────────────────────────────────────────

export class ReputationManager {
  private dataDir: string;
  private network: PandoNetwork;
  private requestReply: RequestReplyManager;
  private localRecord: ReputationRecord;
  private peerRecords: Map<string, ReputationRecord> = new Map();
  private localPath: string;
  private peersPath: string;
  private lastBroadcastScore: number = 0;
  private pruneInterval: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string, network: PandoNetwork, requestReply: RequestReplyManager) {
    this.dataDir = dataDir;
    this.network = network;
    this.requestReply = requestReply;
    this.localPath = join(dataDir, 'reputation.json');
    this.peersPath = join(dataDir, 'reputation-peers.json');

    // Load existing data
    this.localRecord = this.loadLocal();
    this.loadPeers();
    this.lastBroadcastScore = this.localRecord.reputationScore;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Subscribe to P2P updates and register the reputation_query request handler.
   * Call once after network and requestReply are started.
   */
  start(): void {
    // Subscribe to remote REPUTATION_UPDATE events via pando/agent-events
    this.network.onAgentEvent((payload: any, fromPeerId: string) => {
      if (payload?.type === 'REPUTATION_UPDATE' && payload.record) {
        this.handleRemoteUpdate(payload.record, fromPeerId);
      }
    });

    // Register request handler: "reputation_query" → returns local reputation
    this.requestReply.registerHandler('reputation_query', async () => {
      return this.getLocalReputation();
    });

    // On peer connect, request their reputation (5s delay for protocol setup)
    this.network.onPeerConnect((peerId: string) => {
      setTimeout(() => {
        this.requestReply.request(peerId, 'reputation_query', {}, 15_000)
          .then((reply) => {
            if (reply.success && reply.payload) {
              this.handleRemoteUpdate(reply.payload, peerId);
            }
          })
          .catch(() => {
            // Peer may not support reputation queries — that's fine
          });
      }, 5000);
    });

    // Run initial cleanup of stale peer records and enforce cap
    const prunedOnStart = this.pruneStaleRecords();
    if (prunedOnStart > 0) {
      console.log(`[reputation] Startup cleanup: pruned ${prunedOnStart} stale peer records`);
    }

    // Schedule periodic prune every 6 hours
    this.pruneInterval = setInterval(() => {
      this.pruneStaleRecords();
    }, PRUNE_INTERVAL_MS);

    console.log('[reputation] Started — tracking performance, syncing with peers');
  }

  /**
   * Record a local event (called by scheduler on task completion/failure).
   */
  recordEvent(
    type: ReputationEvent['type'],
    detail: string,
    metadata?: { durationMs?: number; buildPassed?: boolean; testsPassed?: boolean },
  ): void {
    const prevScore = this.localRecord.reputationScore;

    // Update counters based on type
    switch (type) {
      case 'task_completed': {
        this.localRecord.tasksCompleted++;
        if (metadata?.durationMs) {
          // Rolling average for completion time
          const prevTotal = this.localRecord.avgCompletionMs * (this.localRecord.tasksCompleted - 1);
          this.localRecord.avgCompletionMs = Math.round(
            (prevTotal + metadata.durationMs) / this.localRecord.tasksCompleted,
          );
        }
        if (metadata?.buildPassed !== undefined) {
          const total = this.localRecord.tasksCompleted;
          const prevPasses = this.localRecord.buildPassRate * (total - 1);
          this.localRecord.buildPassRate = (prevPasses + (metadata.buildPassed ? 1 : 0)) / total;
        }
        if (metadata?.testsPassed !== undefined) {
          const total = this.localRecord.tasksCompleted;
          const prevPasses = this.localRecord.testPassRate * (total - 1);
          this.localRecord.testPassRate = (prevPasses + (metadata.testsPassed ? 1 : 0)) / total;
        }
        break;
      }
      case 'task_failed':
        this.localRecord.tasksFailed++;
        break;
      case 'task_timed_out':
        this.localRecord.tasksTimedOut++;
        break;
      case 'profile_shared':
        this.localRecord.profilesContributed++;
        break;
      case 'peer_endorsement':
        // No counter to update; recorded in history only
        break;
    }

    // Recompute score
    this.localRecord.reputationScore = this.computeScore(this.localRecord);
    this.localRecord.lastUpdated = Date.now();

    // Calculate delta
    const scoreDelta = this.localRecord.reputationScore - prevScore;

    // Push to history (keep last 100)
    this.localRecord.history.push({
      timestamp: Date.now(),
      type,
      detail,
      scoreDelta,
    });
    if (this.localRecord.history.length > MAX_HISTORY) {
      this.localRecord.history = this.localRecord.history.slice(-MAX_HISTORY);
    }

    // Persist
    this.saveLocal();

    // Maybe broadcast if score changed significantly
    this.maybeBroadcast();

    console.log(`[reputation] Event: ${type} — score ${prevScore.toFixed(1)} → ${this.localRecord.reputationScore.toFixed(1)} (Δ${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(1)})`);
  }

  /**
   * Get reputation for a specific node.
   */
  getReputation(nodeId: string): ReputationRecord | null {
    if (nodeId === this.localRecord.nodeId) {
      return { ...this.localRecord };
    }
    const peer = this.peerRecords.get(nodeId);
    return peer ? { ...peer } : null;
  }

  /**
   * Get all known reputations (local + remote).
   */
  getAllReputations(): ReputationRecord[] {
    const all: ReputationRecord[] = [{ ...this.localRecord }];
    for (const record of this.peerRecords.values()) {
      all.push({ ...record });
    }
    return all;
  }

  /**
   * Get ranked nodes (highest reputation first).
   */
  getRankedNodes(): ReputationRecord[] {
    return this.getAllReputations().sort((a, b) => b.reputationScore - a.reputationScore);
  }

  /**
   * Get this node's local reputation record.
   */
  getLocalReputation(): ReputationRecord {
    return { ...this.localRecord };
  }

  /**
   * Broadcast local reputation update to the network via pando/agent-events.
   */
  broadcastUpdate(): void {
    const record = this.getLocalReputation();
    // Strip history from broadcast to save bandwidth
    const broadcast = { ...record, history: [] };
    this.network.publishAgentEvent({
      type: 'REPUTATION_UPDATE',
      record: broadcast,
    }).catch((err) => {
      console.error(`[reputation] Broadcast failed: ${err.message}`);
    });
    this.lastBroadcastScore = record.reputationScore;
  }

  /**
   * Score formula:
   *   (tasksCompleted * 2) + (buildPassRate * 10) + (testPassRate * 10)
   *   - (tasksFailed * 3) - (tasksTimedOut * 5) + (profilesContributed * 1)
   */
  computeScore(record: ReputationRecord): number {
    return (
      (record.tasksCompleted * 2) +
      (record.buildPassRate * 10) +
      (record.testPassRate * 10) -
      (record.tasksFailed * 3) -
      (record.tasksTimedOut * 5) +
      (record.profilesContributed * 1)
    );
  }

  /**
   * Remove peer records not updated in 7 days, then enforce the 1000-record cap
   * by pruning oldest records when exceeded. Returns count of pruned records.
   */
  pruneStaleRecords(): number {
    const cutoff = Date.now() - STALE_RECORD_MS;
    let pruned = 0;

    // Remove stale records (not updated in 7 days)
    for (const [nodeId, record] of this.peerRecords) {
      if (record.lastUpdated < cutoff) {
        this.peerRecords.delete(nodeId);
        pruned++;
      }
    }

    // Enforce cap: remove oldest records when over MAX_PEER_RECORDS
    if (this.peerRecords.size > MAX_PEER_RECORDS) {
      const sorted = Array.from(this.peerRecords.entries())
        .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);

      const toRemove = this.peerRecords.size - MAX_PEER_RECORDS;
      for (let i = 0; i < toRemove; i++) {
        this.peerRecords.delete(sorted[i][0]);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.savePeers();
      console.log(`[reputation] Pruned ${pruned} stale/excess peer records (${this.peerRecords.size} remaining)`);
    }

    return pruned;
  }

  /**
   * Stop the prune cleanup interval. Call on shutdown.
   */
  stopPruneInterval(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
      console.log('[reputation] Prune cleanup interval stopped');
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Only broadcast if score changed by > 5% since last broadcast.
   */
  private maybeBroadcast(): void {
    const current = this.localRecord.reputationScore;
    const prev = this.lastBroadcastScore;

    // Always broadcast first score change (bootstrap)
    if (prev === 0 && current !== 0) {
      this.broadcastUpdate();
      return;
    }

    if (prev === 0) return; // Avoid division by zero when both are 0

    const changePercent = Math.abs(current - prev) / Math.abs(prev);
    if (changePercent > BROADCAST_THRESHOLD) {
      this.broadcastUpdate();
    }
  }

  /**
   * Handle a remote reputation update from a peer.
   * Recomputes the score from claimed stats (don't trust self-reported score).
   */
  private handleRemoteUpdate(record: any, fromPeerId: string): void {
    if (!record || !record.nodeId) return;

    // Prevent spoofing: nodeId must match the sender
    if (record.nodeId !== fromPeerId) {
      console.warn(
        `[reputation] Ignoring update: nodeId ${String(record.nodeId).slice(0, 12)} != sender ${fromPeerId.slice(0, 12)}`,
      );
      return;
    }

    // Build a verified record — recompute score from their claimed stats
    const verified: ReputationRecord = {
      nodeId: record.nodeId,
      tasksCompleted: Math.max(0, record.tasksCompleted || 0),
      tasksFailed: Math.max(0, record.tasksFailed || 0),
      tasksTimedOut: Math.max(0, record.tasksTimedOut || 0),
      avgCompletionMs: Math.max(0, record.avgCompletionMs || 0),
      buildPassRate: Math.min(1, Math.max(0, record.buildPassRate || 0)),
      testPassRate: Math.min(1, Math.max(0, record.testPassRate || 0)),
      profilesContributed: Math.max(0, record.profilesContributed || 0),
      reputationScore: 0, // Will recompute
      lastUpdated: Date.now(),
      history: [], // Don't store remote history
    };
    verified.reputationScore = this.computeScore(verified);

    this.peerRecords.set(record.nodeId, verified);
    this.savePeers();

    console.log(
      `[reputation] Peer update: ${record.nodeId.slice(0, 12)} → score ${verified.reputationScore.toFixed(1)} (${verified.tasksCompleted} completed, ${verified.tasksFailed} failed)`,
    );
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private loadLocal(): ReputationRecord {
    try {
      if (existsSync(this.localPath)) {
        const data = JSON.parse(readFileSync(this.localPath, 'utf-8'));
        // Ensure nodeId matches current identity
        data.nodeId = this.network.getIdentity().peerId;
        return data;
      }
    } catch (err: any) {
      console.warn(`[reputation] Failed to load local reputation: ${err.message}`);
    }

    // New node — start with empty record
    return {
      nodeId: this.network.getIdentity().peerId,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksTimedOut: 0,
      avgCompletionMs: 0,
      buildPassRate: 0,
      testPassRate: 0,
      profilesContributed: 0,
      reputationScore: 0,
      lastUpdated: Date.now(),
      history: [],
    };
  }

  private saveLocal(): void {
    try {
      const dir = dirname(this.localPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.localPath, JSON.stringify(this.localRecord, null, 2));
    } catch (err: any) {
      console.error(`[reputation] Failed to save local reputation: ${err.message}`);
    }
  }

  private loadPeers(): void {
    try {
      if (existsSync(this.peersPath)) {
        const data = JSON.parse(readFileSync(this.peersPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const record of data) {
            if (record.nodeId) {
              this.peerRecords.set(record.nodeId, record);
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`[reputation] Failed to load peer reputations: ${err.message}`);
    }
  }

  private savePeers(): void {
    try {
      const dir = dirname(this.peersPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const records = Array.from(this.peerRecords.values());
      writeFileSync(this.peersPath, JSON.stringify(records, null, 2));
    } catch (err: any) {
      console.error(`[reputation] Failed to save peer reputations: ${err.message}`);
    }
  }
}
