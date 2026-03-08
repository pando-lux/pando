/**
 * P2PStorageBackend — Storage proxy for untrusted nodes.
 *
 * Forwards all CRUD operations via HTTP to compute nodes that have MongoDB.
 *
 * Security:
 * - Does NOT expose getDb() — CredentialStore only initializes on compute nodes
 * - Collection blocklist enforced at handler level (pando_credentials blocked)
 * - Method allowlist at handler level (only 6 CRUD methods)
 */

import type { StorageBackend } from './storage-backend.js';
import type { HttpPeerClient } from './http-peer-client.js';

interface CapabilityRegistryLike {
  getAllProfiles(): import('@pando/shared').CapabilityProfile[];
}

const MAX_ATTEMPTS = 3;
const PEER_WAIT_TIMEOUT_MS = 30_000;
const PEER_POLL_INTERVAL_MS = 1_000;
const UNHEALTHY_TTL_MS = 30_000;

export class P2PStorageBackend implements StorageBackend {
  private preferredPeerId: string | null = null;
  private unhealthyPeers = new Map<string, number>();

  constructor(
    private httpPeerClient: HttpPeerClient,
    private capabilityRegistry: CapabilityRegistryLike,
    private localPeerId: string,
  ) {}

  async init(): Promise<void> {}

  async close(): Promise<void> {
    this.preferredPeerId = null;
  }

  async putRecord(collection: string, key: string, data: Record<string, any>): Promise<void> {
    await this.proxy('putRecord', { collection, key, data });
  }

  async getRecord(collection: string, key: string): Promise<Record<string, any> | null> {
    const result = await this.proxy('getRecord', { collection, key });
    return result ?? null;
  }

  async queryRecords(
    collection: string,
    filter: Record<string, any>,
    options?: { limit?: number; sort?: Record<string, 1 | -1> },
  ): Promise<Record<string, any>[]> {
    const result = await this.proxy('queryRecords', { collection, filter, options });
    return result ?? [];
  }

  async deleteRecord(collection: string, key: string): Promise<void> {
    await this.proxy('deleteRecord', { collection, key });
  }

  async listRecords(collection: string, filter?: Record<string, any>): Promise<Record<string, any>[]> {
    const result = await this.proxy('listRecords', { collection, filter });
    return result ?? [];
  }

  async pushToArray(collection: string, key: string, field: string, value: any): Promise<void> {
    await this.proxy('pushToArray', { collection, key, field, value });
  }

  private async proxy(method: string, args: Record<string, any>): Promise<any> {
    let computePeers = this.getComputePeers();

    // Startup grace period: wait for compute peers to connect
    if (computePeers.length === 0) {
      const deadline = Date.now() + PEER_WAIT_TIMEOUT_MS;
      while (computePeers.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, PEER_POLL_INTERVAL_MS));
        computePeers = this.getComputePeers();
      }
      if (computePeers.length === 0) {
        throw new Error('[P2PStorageBackend] No compute peers available for storage proxy');
      }
      console.log(`[P2PStorageBackend] Found ${computePeers.length} compute peer(s) after waiting`);
    }

    const ordered = this.orderPeers(computePeers);
    const healthy = ordered.filter(p => !this.isUnhealthy(p));
    const candidates = healthy.length > 0 ? healthy : ordered;
    let lastError: Error | null = null;

    for (let i = 0; i < Math.min(MAX_ATTEMPTS, candidates.length); i++) {
      const peerId = candidates[i];
      try {
        const response = await this.httpPeerClient.storageProxy(peerId, method, args);

        if (response?.error) {
          throw new Error(`Storage proxy error: ${response.error}`);
        }

        this.preferredPeerId = peerId;
        return response?.result;
      } catch (err) {
        lastError = err as Error;
        this.unhealthyPeers.set(peerId, Date.now() + UNHEALTHY_TTL_MS);
        if (this.preferredPeerId === peerId) {
          this.preferredPeerId = null;
        }
        console.log(`[P2PStorageBackend] ${method} failed on ${peerId.slice(0, 12)}: ${(err as Error).message}`);
      }
    }

    throw lastError || new Error('[P2PStorageBackend] All compute peers failed');
  }

  private isUnhealthy(peerId: string): boolean {
    const expiry = this.unhealthyPeers.get(peerId);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.unhealthyPeers.delete(peerId);
      return false;
    }
    return true;
  }

  private getComputePeers(): string[] {
    const allProfiles = this.capabilityRegistry.getAllProfiles();
    return allProfiles
      .filter(p =>
        p.peerId !== this.localPeerId &&
        (p as any).storageBackend === 'mongodb',
      )
      .map(p => p.peerId);
  }

  private orderPeers(peers: string[]): string[] {
    if (!this.preferredPeerId || !peers.includes(this.preferredPeerId)) {
      return peers;
    }
    return [
      this.preferredPeerId,
      ...peers.filter(p => p !== this.preferredPeerId),
    ];
  }
}
