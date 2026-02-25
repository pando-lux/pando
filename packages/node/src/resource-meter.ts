/**
 * ResourceMeter — Resource usage metering + reward calculation (Phase C).
 *
 * Tracks per-capability resource usage for all nodes. Persists usage
 * records to disk. Calculates Lux rewards based on per-capability rates.
 * Runs a periodic metering loop that prunes old records.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ResourceUsage,
  MeterReading,
  NetworkMeterReading,
  RewardCalculation,
} from '@pando/shared';

// ── Per-capability reward rates (Lux per unit) ─────────────────────────────

const REWARD_RATES: Record<string, { rate: number; unit: string }> = {
  relay:        { rate: 0.001, unit: 'bytes' },         // 0.001 Lux per MB relayed
  api_keys:     { rate: 0.01,  unit: 'calls' },         // 0.01 Lux per API call served
  compute_cpu:  { rate: 0.1,   unit: 'minutes' },       // 0.1 Lux per compute-minute
  compute_gpu:  { rate: 0.5,   unit: 'minutes' },       // 0.5 Lux per GPU-minute
  storage:      { rate: 0.001, unit: 'gb_hours' },      // 0.001 Lux per GB-hour
  gateway:      { rate: 0.01,  unit: 'requests' },      // 0.01 Lux per 1000 requests served
  validator:    { rate: 0.05,  unit: 'validations' },   // 0.05 Lux per validation
  index:        { rate: 0.005, unit: 'requests' },      // 0.005 Lux per index query
};

// Normalization divisors: gateway rewards are per 1000 requests, relay per MB (1048576 bytes)
const UNIT_DIVISORS: Record<string, number> = {
  relay: 1_048_576,  // bytes -> MB
  gateway: 1000,     // per 1000 requests
};

// ── Retention ──────────────────────────────────────────────────────────────

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Period calculation ─────────────────────────────────────────────────────

function periodToMs(period: string): number {
  switch (period) {
    case 'hour':  return 60 * 60 * 1000;
    case 'day':   return 24 * 60 * 60 * 1000;
    case 'week':  return 7 * 24 * 60 * 60 * 1000;
    case 'month': return 30 * 24 * 60 * 60 * 1000;
    default:      return 24 * 60 * 60 * 1000; // default to day
  }
}

// ── ResourceMeter class ────────────────────────────────────────────────────

export class ResourceMeter {
  private dataDir: string;
  private filePath: string;

  // peerId -> array of usage records
  private records: Map<string, ResourceUsage[]> = new Map();

  private meteringTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, 'resource-metering.json');
    this.load();
  }

  // ── Recording ─────────────────────────────────────────────────────────

  /** Record a resource usage entry for a peer. */
  recordUsage(peerId: string, resourceType: string, usage: ResourceUsage): void {
    let peerRecords = this.records.get(peerId);
    if (!peerRecords) {
      peerRecords = [];
      this.records.set(peerId, peerRecords);
    }

    peerRecords.push({
      ...usage,
      resourceType,
      timestamp: usage.timestamp || Date.now(),
    });
  }

  // ── Reading ───────────────────────────────────────────────────────────

  /** Get metering readings for a specific peer. */
  getUsage(peerId: string, period: 'hour' | 'day' | 'week' | 'month' = 'day'): MeterReading {
    const cutoff = Date.now() - periodToMs(period);
    const peerRecords = this.records.get(peerId) || [];

    const readings: Record<string, { total: number; unit: string }> = {};

    for (const record of peerRecords) {
      if (record.timestamp < cutoff) continue;
      const rt = record.resourceType;
      if (!readings[rt]) {
        readings[rt] = {
          total: 0,
          unit: record.unit || REWARD_RATES[rt]?.unit || 'units',
        };
      }
      readings[rt].total += record.quantity;
    }

    return {
      peerId,
      period,
      readings,
      estimatedReward: this.calculateRewards(peerId, period).totalReward,
    };
  }

  /** Get network-wide metering readings. */
  getNetworkUsage(period: 'hour' | 'day' | 'week' | 'month' = 'day'): NetworkMeterReading {
    const cutoff = Date.now() - periodToMs(period);
    const readings: Record<string, { totalUsage: number; unit: string; contributingNodes: number }> = {};
    const nodesByResource: Record<string, Set<string>> = {};

    let totalRewards = 0;

    for (const [peerId, peerRecords] of this.records) {
      for (const record of peerRecords) {
        if (record.timestamp < cutoff) continue;
        const rt = record.resourceType;

        if (!readings[rt]) {
          readings[rt] = {
            totalUsage: 0,
            unit: record.unit || REWARD_RATES[rt]?.unit || 'units',
            contributingNodes: 0,
          };
          nodesByResource[rt] = new Set();
        }

        readings[rt].totalUsage += record.quantity;
        nodesByResource[rt].add(peerId);
      }

      totalRewards += this.calculateRewards(peerId, period).totalReward;
    }

    // Set contributing node counts
    for (const rt of Object.keys(readings)) {
      readings[rt].contributingNodes = nodesByResource[rt]?.size || 0;
    }

    return {
      period,
      totalNodes: this.records.size,
      readings,
      totalRewardsDistributed: totalRewards,
    };
  }

  // ── Reward calculation ────────────────────────────────────────────────

  /** Calculate Lux rewards for a peer based on their resource usage. */
  calculateRewards(peerId: string, period: 'hour' | 'day' | 'week' | 'month' = 'day'): RewardCalculation {
    const cutoff = Date.now() - periodToMs(period);
    const peerRecords = this.records.get(peerId) || [];

    // Aggregate usage per resource type
    const usageByType: Record<string, number> = {};
    for (const record of peerRecords) {
      if (record.timestamp < cutoff) continue;
      const rt = record.resourceType;
      usageByType[rt] = (usageByType[rt] || 0) + record.quantity;
    }

    // Calculate rewards
    const rewards: { resourceType: string; usage: number; rate: number; reward: number }[] = [];
    let totalReward = 0;

    for (const [resourceType, totalUsage] of Object.entries(usageByType)) {
      const rateInfo = REWARD_RATES[resourceType];
      if (!rateInfo) continue;

      const divisor = UNIT_DIVISORS[resourceType] || 1;
      const normalizedUsage = totalUsage / divisor;
      const reward = normalizedUsage * rateInfo.rate;

      rewards.push({
        resourceType,
        usage: totalUsage,
        rate: rateInfo.rate,
        reward,
      });

      totalReward += reward;
    }

    return {
      peerId,
      period,
      rewards,
      totalReward,
    };
  }

  // ── Persistence ───────────────────────────────────────────────────────

  /** Save all records to disk. */
  save(): void {
    try {
      const dir = join(this.dataDir);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Convert Map to serializable object
      const data: Record<string, ResourceUsage[]> = {};
      for (const [peerId, records] of this.records) {
        data[peerId] = records;
      }

      writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err: any) {
      console.error(`[resource-meter] Save failed: ${err.message}`);
    }
  }

  /** Load records from disk. */
  load(): void {
    try {
      if (!existsSync(this.filePath)) return;

      const raw = readFileSync(this.filePath, 'utf-8');
      const data: Record<string, ResourceUsage[]> = JSON.parse(raw);

      this.records.clear();
      for (const [peerId, records] of Object.entries(data)) {
        if (Array.isArray(records)) {
          this.records.set(peerId, records);
        }
      }
    } catch (err: any) {
      console.error(`[resource-meter] Load failed: ${err.message}`);
    }
  }

  // ── Pruning ───────────────────────────────────────────────────────────

  /** Remove records older than 30 days. */
  pruneOldRecords(): void {
    const cutoff = Date.now() - RETENTION_MS;
    let pruned = 0;

    for (const [peerId, records] of this.records) {
      const before = records.length;
      const kept = records.filter(r => r.timestamp >= cutoff);
      if (kept.length < before) {
        pruned += before - kept.length;
        if (kept.length === 0) {
          this.records.delete(peerId);
        } else {
          this.records.set(peerId, kept);
        }
      }
    }

    if (pruned > 0) {
      console.log(`[resource-meter] Pruned ${pruned} old record(s)`);
    }
  }

  // ── Metering loop ─────────────────────────────────────────────────────

  /** Start the periodic metering loop (default: every 60 seconds). */
  startMeteringLoop(intervalMs: number = 60_000): void {
    if (this.meteringTimer) return;

    this.meteringTimer = setInterval(() => {
      this.pruneOldRecords();
      this.save();
    }, intervalMs);

    console.log(`[resource-meter] Metering loop started (interval: ${intervalMs}ms)`);
  }

  /** Stop the metering loop. */
  stopMeteringLoop(): void {
    if (this.meteringTimer) {
      clearInterval(this.meteringTimer);
      this.meteringTimer = null;
    }
    // Final save
    this.save();
  }

  /** Get all peer IDs that have usage records. */
  getTrackedPeers(): string[] {
    return Array.from(this.records.keys());
  }
}
