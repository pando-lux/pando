/**
 * ResourceMarketplace — Marketplace pricing for network resources (Phase D).
 *
 * Node operators set prices for their resources. Buyers can find the
 * cheapest provider for their requirements. Prices are broadcast via
 * GossipSub topic `pando/marketplace` and cached locally for fast lookups.
 */

import type { CapabilityRegistry } from './capability-registry.js';
import type { PandoNetwork } from '../kernel/network.js';
import type {
  ResourceType,
  PriceList,
  MarketplaceResult,
  BudgetMatch,
  MarketStats,
  ResourceRoutingRequirements,
} from '@pando/shared';

// ── Constants ──────────────────────────────────────────────────────────────

export const TOPIC_MARKETPLACE = 'pando/marketplace';

const BROADCAST_COOLDOWN_MS = 60_000; // Max one broadcast per 60 seconds

// ── Default prices (Lux per unit) ──────────────────────────────────────────

const DEFAULT_PRICES: Record<string, { pricePerUnit: number; unit: string }> = {
  relay:        { pricePerUnit: 0.001, unit: 'MB' },
  api_keys:     { pricePerUnit: 0.01,  unit: 'call' },
  compute_cpu:  { pricePerUnit: 0.1,   unit: 'minute' },
  compute_gpu:  { pricePerUnit: 0.5,   unit: 'minute' },
  storage:      { pricePerUnit: 0.001, unit: 'GB-hour' },
  gateway:      { pricePerUnit: 0.01,  unit: '1000 requests' },
  validator:    { pricePerUnit: 0.05,  unit: 'validation' },
  index:        { pricePerUnit: 0.005, unit: 'query' },
  // KB: Phase 16 — agent_labor priced per task (flat fee). Lux locked on commission, released on delivery.
  agent_labor:  { pricePerUnit: 1.0,   unit: 'task' },
};

// ── ResourceMarketplace class ──────────────────────────────────────────────

export class ResourceMarketplace {
  private registry: CapabilityRegistry;
  private network: PandoNetwork | null = null;
  private localPeerId: string = '';
  private lastBroadcastAt: number = 0;

  // Local node's prices
  private localPrices: Record<string, { pricePerUnit: number; unit: string; currency: 'lux' }> = {};

  // Cached prices from peer broadcasts: peerId -> PriceList
  private peerPrices: Map<string, PriceList> = new Map();

  constructor(registry: CapabilityRegistry) {
    this.registry = registry;

    // Initialize with default prices for all capabilities
    for (const [resource, info] of Object.entries(DEFAULT_PRICES)) {
      this.localPrices[resource] = {
        pricePerUnit: info.pricePerUnit,
        unit: info.unit,
        currency: 'lux',
      };
    }
  }

  /** Set the network reference for broadcasting. */
  setNetwork(network: PandoNetwork): void {
    this.network = network;
  }

  /** Set the local peer ID. */
  setLocalPeerId(peerId: string): void {
    this.localPeerId = peerId;
  }

  // ── Pricing ───────────────────────────────────────────────────────────

  /** Set the price for a specific resource type. */
  setPrice(resourceType: string, pricePerUnit: number): void {
    const existing = this.localPrices[resourceType];
    const unit = existing?.unit || DEFAULT_PRICES[resourceType]?.unit || 'unit';

    this.localPrices[resourceType] = {
      pricePerUnit,
      unit,
      currency: 'lux',
    };

    console.log(`[marketplace] Price set: ${resourceType} = ${pricePerUnit} Lux/${unit}`);
  }

  /** Get prices for a node (local if peerId omitted). */
  getPrices(peerId?: string): PriceList {
    if (!peerId || peerId === this.localPeerId) {
      return {
        peerId: this.localPeerId,
        prices: { ...this.localPrices },
        updatedAt: Date.now(),
      };
    }

    const cached = this.peerPrices.get(peerId);
    if (cached) return cached;

    return {
      peerId,
      prices: {},
      updatedAt: 0,
    };
  }

  // ── Discovery ─────────────────────────────────────────────────────────

  /**
   * Find the cheapest node that can fulfill the given requirements.
   * Filters by capability, sorts by total estimated cost.
   */
  findCheapest(requirements: ResourceRoutingRequirements): MarketplaceResult {
    const requiredResources = requirements.requiredResources || [];

    // Get capable nodes
    const candidates = requiredResources.length > 0
      ? this.registry.findCapableNodes(requiredResources as ResourceType[])
      : this.registry.getAllProfiles();

    if (candidates.length === 0) {
      return {
        cheapest: { peerId: '', totalCost: 0, breakdown: {} },
        alternatives: [],
      };
    }

    // Calculate total cost for each candidate
    const priced = candidates.map(profile => {
      const prices = this.getPrices(profile.peerId);
      let totalCost = 0;
      const breakdown: Record<string, number> = {};

      for (const resource of requiredResources) {
        const price = prices.prices[resource];
        if (price) {
          // Assume 1 unit of each required resource for comparison
          breakdown[resource] = price.pricePerUnit;
          totalCost += price.pricePerUnit;
        } else {
          // Use default price if no specific price set
          const defaultPrice = DEFAULT_PRICES[resource];
          if (defaultPrice) {
            breakdown[resource] = defaultPrice.pricePerUnit;
            totalCost += defaultPrice.pricePerUnit;
          }
        }
      }

      return { peerId: profile.peerId, totalCost, breakdown };
    });

    // Sort by total cost ascending
    priced.sort((a, b) => a.totalCost - b.totalCost);

    return {
      cheapest: priced[0] || { peerId: '', totalCost: 0, breakdown: {} },
      alternatives: priced.slice(1, 6).map(p => ({
        peerId: p.peerId,
        totalCost: p.totalCost,
      })),
    };
  }

  /**
   * Find nodes that can fulfill requirements within a given budget.
   */
  matchBudget(taskBudget: number, requirements: ResourceRoutingRequirements): BudgetMatch[] {
    const requiredResources = requirements.requiredResources || [];

    // Get capable nodes
    const candidates = requiredResources.length > 0
      ? this.registry.findCapableNodes(requiredResources as ResourceType[])
      : this.registry.getAllProfiles();

    if (candidates.length === 0) return [];

    // Calculate average price for comparison
    let totalNetworkCost = 0;
    let nodeCount = 0;

    const matches: BudgetMatch[] = [];

    for (const profile of candidates) {
      const prices = this.getPrices(profile.peerId);
      let totalCost = 0;

      for (const resource of requiredResources) {
        const price = prices.prices[resource];
        if (price) {
          totalCost += price.pricePerUnit;
        } else {
          const defaultPrice = DEFAULT_PRICES[resource];
          if (defaultPrice) totalCost += defaultPrice.pricePerUnit;
        }
      }

      totalNetworkCost += totalCost;
      nodeCount++;

      matches.push({
        peerId: profile.peerId,
        totalCost,
        withinBudget: totalCost <= taskBudget,
        savingsVsAverage: 0, // Will be calculated below
      });
    }

    // Calculate savings vs average
    const avgCost = nodeCount > 0 ? totalNetworkCost / nodeCount : 0;
    for (const match of matches) {
      match.savingsVsAverage = avgCost > 0
        ? ((avgCost - match.totalCost) / avgCost) * 100
        : 0;
    }

    // Sort by cost ascending
    matches.sort((a, b) => a.totalCost - b.totalCost);

    return matches;
  }

  // ── Broadcasting ──────────────────────────────────────────────────────

  /** Subscribe to the `pando/marketplace` GossipSub topic. */
  async subscribeMarketplaceTopic(): Promise<void> {
    if (!this.network) return;
    await this.network.subscribeTopic(TOPIC_MARKETPLACE, (message) => {
      if (!message.payload) return;
      const fromPeerId = message.from || 'unknown';
      if (fromPeerId === this.localPeerId) return;
      const payload = message.payload as any;
      if (payload.type === 'price_broadcast' && payload.priceList) {
        this.handlePriceBroadcast(fromPeerId, payload.priceList);
        console.log(`[marketplace] Received prices from ${fromPeerId.slice(0, 12)}`);
      }
    });
    console.log(`[marketplace] Subscribed to GossipSub topic: ${TOPIC_MARKETPLACE}`);
  }

  /** Broadcast local prices to the network via GossipSub.
   *  Spam-limited to one broadcast per 60 seconds. */
  async broadcastPrices(): Promise<void> {
    if (!this.network || !this.localPeerId) return;

    // Spam prevention: don't broadcast more than once per 60s
    const now = Date.now();
    if (now - this.lastBroadcastAt < BROADCAST_COOLDOWN_MS) {
      console.log('[marketplace] Broadcast throttled (60s cooldown)');
      return;
    }

    const prices: Array<{ resourceType: string; pricePerUnit: number; currency: string }> = [];
    for (const [resourceType, info] of Object.entries(this.localPrices)) {
      prices.push({
        resourceType,
        pricePerUnit: info.pricePerUnit,
        currency: info.currency,
      });
    }

    const priceList: PriceList = {
      peerId: this.localPeerId,
      prices: { ...this.localPrices },
      updatedAt: now,
    };

    try {
      await this.network.publishToTopic(TOPIC_MARKETPLACE, {
        type: 'price_broadcast' as any,
        from: this.localPeerId,
        timestamp: now,
        payload: {
          type: 'price_broadcast',
          peerId: this.localPeerId,
          prices,
          priceList,
          timestamp: now,
        },
      } as any);
      this.lastBroadcastAt = now;
      console.log(`[marketplace] Broadcast ${prices.length} prices to ${TOPIC_MARKETPLACE}`);
    } catch (err: any) {
      console.error(`[marketplace] Price broadcast failed: ${err.message}`);
    }
  }

  /** Handle an incoming price broadcast from a peer. */
  handlePriceBroadcast(peerId: string, prices: PriceList): void {
    this.peerPrices.set(peerId, {
      ...prices,
      peerId, // Ensure peerId is set correctly
    });
  }

  // ── Market stats ──────────────────────────────────────────────────────

  /** Get market-wide statistics. */
  getMarketStats(): MarketStats {
    const allPrices = new Map<string, number[]>();
    const allPriceLists = [this.getPrices(), ...Array.from(this.peerPrices.values())];

    for (const priceList of allPriceLists) {
      for (const [resource, priceInfo] of Object.entries(priceList.prices)) {
        let arr = allPrices.get(resource);
        if (!arr) {
          arr = [];
          allPrices.set(resource, arr);
        }
        arr.push(priceInfo.pricePerUnit);
      }
    }

    const averagePrices: Record<string, number> = {};
    const lowestPrices: Record<string, { price: number; peerId: string }> = {};

    for (const [resource, prices] of allPrices) {
      // Average
      const sum = prices.reduce((a, b) => a + b, 0);
      averagePrices[resource] = prices.length > 0 ? sum / prices.length : 0;

      // Find lowest and which node
      let lowest = Infinity;
      let lowestPeer = '';

      for (const priceList of allPriceLists) {
        const p = priceList.prices[resource];
        if (p && p.pricePerUnit < lowest) {
          lowest = p.pricePerUnit;
          lowestPeer = priceList.peerId;
        }
      }

      if (lowest < Infinity) {
        lowestPrices[resource] = { price: lowest, peerId: lowestPeer };
      }
    }

    // Count total resources offered across all nodes
    const totalResources: Record<string, number> = {};
    const profiles = this.registry.getAllProfiles();
    for (const profile of profiles) {
      for (const [resource, enabled] of Object.entries(profile.capabilities)) {
        if (enabled) {
          totalResources[resource] = (totalResources[resource] || 0) + 1;
        }
      }
    }

    return {
      averagePrices,
      lowestPrices,
      activeProviders: allPriceLists.length,
      totalResources,
    };
  }
}
