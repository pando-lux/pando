/**
 * GatewayDeployPool — Distributed hosting deployment pool.
 *
 * When governance approves a gateway upgrade, this class:
 * 1. Finds all 'hosting_platform' credentials this node has
 * 2. Deploys to each using the matching provider adapter
 * 3. Broadcasts gateway URLs to the network via pando/gateways
 * 4. Maintains a registry of all live gateway URLs (from all peers)
 * 5. Periodic health checks on known gateways
 */

import type { PandoNetwork } from '../kernel/network.js';
import type { ResourceRegistry } from '../platform/resource-registry.js';
import type { CredentialStore } from './credential-store.js';
import type { GatewayDeployRecord, PandoMessage, HostingProvider } from '@pando/shared';
import { getHostingAdapter } from './hosting-adapters.js';
import { join } from 'node:path';

export const TOPIC_GATEWAYS = 'pando/gateways';

export class GatewayDeployPool {
  private network: PandoNetwork;
  private localPeerId: string;
  private credentialStore: CredentialStore | null = null;
  private resourceRegistry: ResourceRegistry;
  private repoDir: string;

  // In-memory registry: key -> GatewayDeployRecord (all peers)
  private gateways: Map<string, GatewayDeployRecord> = new Map();
  private healthInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    network: PandoNetwork,
    localPeerId: string,
    resourceRegistry: ResourceRegistry,
    repoDir: string,
  ) {
    this.network = network;
    this.localPeerId = localPeerId;
    this.resourceRegistry = resourceRegistry;
    this.repoDir = repoDir;
  }

  setCredentialStore(store: CredentialStore): void {
    this.credentialStore = store;
  }

  async start(): Promise<void> {
    try {
      await this.network.subscribeTopic(TOPIC_GATEWAYS, (msg) => this.handleMessage(msg));
      console.log(`[gateway-pool] Subscribed to GossipSub topic: ${TOPIC_GATEWAYS}`);
    } catch (err: any) {
      console.warn(`[gateway-pool] Failed to subscribe to ${TOPIC_GATEWAYS}: ${err.message}`);
    }
    // Health check every 5 minutes
    this.healthInterval = setInterval(() => this.healthCheckAll().catch(() => {}), 5 * 60_000);
  }

  stop(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  /**
   * Deploy gateway to ALL contributed hosting accounts on this node.
   * Called from the governance upgrade-approved callback in index.ts.
   */
  async deployToAll(commitHash: string): Promise<GatewayDeployRecord[]> {
    if (!this.credentialStore) return [];

    // Find all active hosting_platform resources
    const hostingResources = this.resourceRegistry.findResources('hosting_platform');
    if (hostingResources.length === 0) return [];

    const gatewayDir = join(this.repoDir, 'packages', 'gateway');
    const results: GatewayDeployRecord[] = [];

    for (const resource of hostingResources) {
      const provider = resource.metadata?.provider as HostingProvider;
      if (!provider) continue;

      const adapter = getHostingAdapter(provider);
      if (!adapter) {
        console.warn(`[gateway-pool] No adapter for provider: ${provider}`);
        continue;
      }

      // Decrypt the token
      const token = await this.resourceRegistry.getCredential(resource.resourceId);
      if (!token) {
        console.warn(`[gateway-pool] Could not decrypt token for resource ${resource.resourceId.slice(0, 8)}`);
        continue;
      }

      // Deploy
      console.log(`[gateway-pool] Deploying to ${provider} (resource ${resource.resourceId.slice(0, 8)})...`);
      const result = await adapter.deploy(token, gatewayDir, { commitHash });

      const record: GatewayDeployRecord = {
        peerId: this.localPeerId,
        provider,
        url: result.url,
        commitHash,
        deployedAt: Date.now(),
        status: result.success ? 'live' : 'failed',
        error: result.error,
      };

      const key = `${this.localPeerId}:${provider}:${resource.resourceId}`;
      this.gateways.set(key, record);
      results.push(record);

      if (result.success) {
        console.log(`[gateway-pool] Deployed to ${provider}: ${result.url}`);
      } else {
        console.warn(`[gateway-pool] Deploy to ${provider} failed: ${result.error}`);
      }

      // Broadcast result so all nodes know
      try {
        await this.broadcast('gateway_deployed', record);
      } catch (err: any) {
        console.warn(`[gateway-pool] Failed to broadcast deploy result: ${err.message}`);
      }
    }

    return results;
  }

  /** Get all known live gateways (from all peers) */
  getLiveGateways(): GatewayDeployRecord[] {
    return Array.from(this.gateways.values()).filter(g => g.status === 'live');
  }

  /** Get all gateways (including failed/stale) */
  getAllGateways(): GatewayDeployRecord[] {
    return Array.from(this.gateways.values());
  }

  // --- GossipSub handling ---

  private handleMessage(message: PandoMessage): void {
    if (message.from === this.localPeerId) return;
    const payload = message.payload as any;
    if (!payload?.peerId || !payload?.provider) return;

    const record = payload as GatewayDeployRecord;
    const key = `${record.peerId}:${record.provider}:${record.url}`;
    this.gateways.set(key, record);
    console.log(`[gateway-pool] Received gateway from ${record.peerId.slice(0, 8)}: ${record.provider} → ${record.url} (${record.status})`);
  }

  // --- Health checks ---

  private async healthCheckAll(): Promise<void> {
    for (const [key, record] of this.gateways) {
      if (record.status === 'failed') continue;
      if (!record.url) continue;

      const adapter = getHostingAdapter(record.provider);
      if (!adapter) continue;

      try {
        const healthy = await adapter.healthCheck(record.url);
        if (!healthy && record.status === 'live') {
          record.status = 'stale';
          console.warn(`[gateway-pool] Gateway stale: ${record.url}`);
        } else if (healthy && record.status === 'stale') {
          record.status = 'live';
          console.log(`[gateway-pool] Gateway recovered: ${record.url}`);
        }
      } catch {
        // Health check error — don't change status on transient failures
      }
    }
  }

  private async broadcast(type: string, payload: any): Promise<void> {
    await this.network.publishToTopic(TOPIC_GATEWAYS, {
      type: type as any,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload,
    });
  }
}
