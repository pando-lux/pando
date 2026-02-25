/**
 * Network State Aggregator
 *
 * Periodically aggregates metrics from existing subsystems into a structured
 * NetworkStateSnapshot and writes it to ~/.pando/council/network-state.md.
 * This file is the "short-term memory" that council reflection sessions read.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Snapshot types ──────────────────────────────────────────────────────────

export interface NetworkStateSnapshot {
  timestamp: number;
  generatedAt: string; // ISO string

  // Network topology
  network: {
    totalNodes: number;
    connectedPeers: number;
    peerList: string[];
    nodeHealth: string; // healthy/degraded/critical
  };

  // Economic state
  economy: {
    totalSupply: number;
    totalAccounts: number;
    totalTransactions: number;
    recentTransactions24h: number;
  };

  // Resource supply/demand
  resources: {
    supply: Record<string, { providers: number; avgPrice: number }>;
    demand: Record<string, { usage: number; unit: string }>;
    rewardsDistributed: number;
  };

  // Task throughput
  tasks: {
    active: number;
    queued: number;
    totalProcessed: number;
    successRate: number;
  };

  // Health metrics
  health: {
    uptimeSeconds: number;
    memoryUsage: number;
    activeAlerts: string[];
    recentSuccessRate: number;
  };

  // Governance
  governance: {
    activeProposals: number;
    totalProposals: number;
    recentDecisions: number; // last 7 days
  };
}

// ── NetworkState class ──────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;

export class NetworkState {
  private node: any; // PandoNode — typed as any to avoid circular import
  private dataDir: string;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: NetworkStateSnapshot | null = null;

  constructor(node: any, dataDir: string) {
    this.node = node;
    this.dataDir = dataDir;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** Generate a fresh snapshot by polling all subsystems. */
  async generateSnapshot(): Promise<NetworkStateSnapshot> {
    const now = Date.now();

    const snapshot: NetworkStateSnapshot = {
      timestamp: now,
      generatedAt: new Date(now).toISOString(),
      network: await this.collectNetwork(),
      economy: this.collectEconomy(),
      resources: this.collectResources(),
      tasks: this.collectTasks(),
      health: this.collectHealth(),
      governance: this.collectGovernance(),
    };

    this.lastSnapshot = snapshot;
    return snapshot;
  }

  /** Write the current snapshot to disk as readable markdown. */
  async writeState(): Promise<void> {
    const snapshot = await this.generateSnapshot();
    const councilDir = join(this.dataDir, 'council');
    mkdirSync(councilDir, { recursive: true });

    const md = this.formatMarkdown(snapshot);
    writeFileSync(join(councilDir, 'network-state.md'), md, 'utf-8');
  }

  /** Start the hourly auto-generation loop (immediate first run). */
  start(): void {
    // Immediate first run
    this.writeState().catch((err) => {
      console.error(`[network-state] Initial write failed: ${err.message}`);
    });

    this.intervalTimer = setInterval(() => {
      this.writeState().catch((err) => {
        console.error(`[network-state] Hourly write failed: ${err.message}`);
      });
    }, HOUR_MS);
    // Do not prevent Node.js from exiting
    this.intervalTimer.unref();
  }

  /** Stop the auto-generation loop. */
  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /** Get the most recent snapshot without writing to disk. */
  async getSnapshot(): Promise<NetworkStateSnapshot> {
    if (this.lastSnapshot) return this.lastSnapshot;
    return this.generateSnapshot();
  }

  // ── Data collectors (each wrapped in try/catch) ─────────────────────────

  private async collectNetwork(): Promise<NetworkStateSnapshot['network']> {
    const result = { totalNodes: 1, connectedPeers: 0, peerList: [] as string[], nodeHealth: 'unknown' as string };

    try {
      const network = this.node.getNetwork?.();
      if (network) {
        const peers = network.getPeers?.() || [];
        result.connectedPeers = peers.length;
        result.peerList = peers.map((p: any) => p.peerId || String(p));
      }
    } catch {}

    try {
      const capRegistry = this.node.getCapabilityRegistry?.();
      if (capRegistry) {
        const profiles = capRegistry.getAllProfiles?.() || [];
        result.totalNodes = Math.max(profiles.length, 1);
      }
    } catch {}

    try {
      const monitor = this.node.getMonitor?.();
      if (monitor) {
        const metrics = monitor.getCurrentMetrics?.();
        if (metrics) result.nodeHealth = metrics.nodeHealth || 'unknown';
      } else {
        // No monitor — infer health from peer count
        result.nodeHealth = result.connectedPeers > 0 ? 'healthy' : 'degraded';
      }
    } catch {}

    return result;
  }

  private collectEconomy(): NetworkStateSnapshot['economy'] {
    const result = { totalSupply: 0, totalAccounts: 0, totalTransactions: 0, recentTransactions24h: 0 };

    try {
      const ledger = this.node.getLedger?.();
      if (ledger) {
        const stats = ledger.getNetworkStats();
        result.totalSupply = stats.totalSupply || 0;
        result.totalAccounts = stats.totalAccounts || 0;
        result.totalTransactions = stats.totalTransactions || 0;

        // Count transactions in the last 24 hours
        try {
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
          const recentTxs = ledger.getTransactionsSince(oneDayAgo, 10000);
          result.recentTransactions24h = recentTxs.length;
        } catch {}
      }
    } catch {}

    return result;
  }

  private collectResources(): NetworkStateSnapshot['resources'] {
    const result: NetworkStateSnapshot['resources'] = {
      supply: {},
      demand: {},
      rewardsDistributed: 0,
    };

    // Supply — from marketplace
    try {
      const marketplace = this.node.getResourceMarketplace?.();
      if (marketplace) {
        const stats = marketplace.getMarketStats?.();
        if (stats) {
          const allResourceTypes = new Set([
            ...Object.keys(stats.totalResources || {}),
            ...Object.keys(stats.averagePrices || {}),
          ]);
          for (const rt of allResourceTypes) {
            result.supply[rt] = {
              providers: (stats.totalResources || {})[rt] || 0,
              avgPrice: (stats.averagePrices || {})[rt] || 0,
            };
          }
        }
      }
    } catch {}

    // Demand — from resource meter
    try {
      const meter = this.node.getResourceMeter?.();
      if (meter) {
        const UNIT_MAP: Record<string, string> = {
          relay: 'MB', api_keys: 'call', compute_cpu: 'minute',
          compute_gpu: 'minute', storage: 'GB-hour', gateway: '1000 requests',
          validator: 'validation', index: 'query',
        };

        const networkUsage = meter.getNetworkUsage?.('day');
        if (networkUsage) {
          result.rewardsDistributed = networkUsage.totalRewardsDistributed || 0;
          for (const [rt, reading] of Object.entries(networkUsage.readings || {})) {
            const r = reading as any;
            result.demand[rt] = {
              usage: r.totalUsage || 0,
              unit: UNIT_MAP[rt] || r.unit || 'unit',
            };
          }
        }
      }
    } catch {}

    return result;
  }

  private collectTasks(): NetworkStateSnapshot['tasks'] {
    const result = { active: 0, queued: 0, totalProcessed: 0, successRate: 0 };

    try {
      const scheduler = this.node.getScheduler?.();
      if (scheduler) {
        const status = scheduler.getStatus();
        const totalProcessed = status.totalProcessed || 0;
        const totalSucceeded = status.totalSucceeded || 0;

        result.active = (status.activeTasks || []).length;
        result.queued = status.approvedQueueLength || 0;
        result.totalProcessed = totalProcessed;
        result.successRate = totalProcessed > 0
          ? Math.round((totalSucceeded / totalProcessed) * 10000) / 100
          : 0;
      }
    } catch {}

    return result;
  }

  private collectHealth(): NetworkStateSnapshot['health'] {
    const result = {
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsage: 0,
      activeAlerts: [] as string[],
      recentSuccessRate: 1,
    };

    try {
      const mem = process.memoryUsage();
      result.memoryUsage = Math.round((mem.heapUsed / mem.heapTotal) * 10000) / 100;
    } catch {}

    try {
      const monitor = this.node.getMonitor?.();
      if (monitor) {
        const metrics = monitor.getCurrentMetrics?.();
        if (metrics) {
          result.recentSuccessRate = metrics.recentSuccessRate ?? 1;
          const alerts = metrics.alerts || [];
          result.activeAlerts = alerts
            .filter((a: any) => !a.resolved)
            .map((a: any) => `[${a.severity}] ${a.message || a.type}`);
        }
      }
    } catch {}

    return result;
  }

  private collectGovernance(): NetworkStateSnapshot['governance'] {
    const result = { activeProposals: 0, totalProposals: 0, recentDecisions: 0 };

    try {
      const governance = this.node.getGovernance?.();
      if (governance) {
        const allProposals = governance.getProposals?.() || [];
        result.totalProposals = allProposals.length;
        result.activeProposals = allProposals.filter((p: any) => p.status === 'active').length;

        // Count decisions in the last 7 days
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        result.recentDecisions = allProposals.filter(
          (p: any) => (p.status === 'passed' || p.status === 'rejected' || p.status === 'expired')
            && (p.createdAt || 0) >= sevenDaysAgo
        ).length;
      }
    } catch {}

    return result;
  }

  // ── Markdown formatter ──────────────────────────────────────────────────

  private formatMarkdown(s: NetworkStateSnapshot): string {
    const lines: string[] = [];

    lines.push(`# Network State -- ${s.generatedAt}`);
    lines.push('');

    // Network
    lines.push('## Network');
    lines.push(`- Nodes online: ${s.network.totalNodes}`);
    lines.push(`- Connected peers: ${s.network.connectedPeers}`);
    lines.push(`- Health: ${s.network.nodeHealth}`);
    lines.push('');

    // Economy
    lines.push('## Economy');
    lines.push(`- Total supply: ${s.economy.totalSupply} Lux`);
    lines.push(`- Total accounts: ${s.economy.totalAccounts}`);
    lines.push(`- Transactions (24h): ${s.economy.recentTransactions24h}`);
    lines.push('');

    // Resources
    lines.push('## Resources');

    lines.push('### Supply');
    const supplyKeys = Object.keys(s.resources.supply);
    if (supplyKeys.length > 0) {
      lines.push('| Type | Providers | Avg Price |');
      lines.push('|------|-----------|-----------|');
      for (const rt of supplyKeys) {
        const info = s.resources.supply[rt];
        lines.push(`| ${rt} | ${info.providers} | ${info.avgPrice} Lux |`);
      }
    } else {
      lines.push('No resource providers registered.');
    }
    lines.push('');

    lines.push('### Demand');
    const demandKeys = Object.keys(s.resources.demand);
    if (demandKeys.length > 0) {
      lines.push('| Type | Usage | Unit |');
      lines.push('|------|-------|------|');
      for (const rt of demandKeys) {
        const info = s.resources.demand[rt];
        lines.push(`| ${rt} | ${info.usage} | ${info.unit} |`);
      }
    } else {
      lines.push('No resource usage recorded.');
    }
    lines.push('');
    lines.push(`- Rewards distributed: ${s.resources.rewardsDistributed} Lux`);
    lines.push('');

    // Tasks
    lines.push('## Tasks');
    lines.push(`- Active: ${s.tasks.active}, Queued: ${s.tasks.queued}`);
    lines.push(`- Total processed: ${s.tasks.totalProcessed}`);
    lines.push(`- Success rate: ${s.tasks.successRate}%`);
    lines.push('');

    // Health
    lines.push('## Health');
    lines.push(`- Uptime: ${s.health.uptimeSeconds}s`);
    lines.push(`- Memory: ${s.health.memoryUsage}%`);
    const alertList = s.health.activeAlerts.length > 0
      ? s.health.activeAlerts.join(', ')
      : 'none';
    lines.push(`- Active alerts: ${alertList}`);
    lines.push('');

    // Governance
    lines.push('## Governance');
    lines.push(`- Active proposals: ${s.governance.activeProposals}`);
    lines.push(`- Total proposals: ${s.governance.totalProposals}`);
    lines.push(`- Recent decisions (7d): ${s.governance.recentDecisions}`);
    lines.push('');

    return lines.join('\n');
  }
}
