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
const PEER_WAIT_TIMEOUT_MS = 5_000;  // #61: Reduced from 30s to 5s to avoid blocking I/O
const PEER_POLL_INTERVAL_MS = 500;
const UNHEALTHY_TTL_MS = 30_000;
const UNHEALTHY_EXTEND_MS = 60_000;  // #62: Extended unhealthy period after failed health check

export class P2PStorageBackend implements StorageBackend {
  private preferredPeerId: string | null = null;
  private unhealthyPeers = new Map<string, number>();
  private peerOnProbation = new Set<string>();  // #62: Peers that just recovered — next failure extends TTL

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

  private async proxy(method: string, args: Record<string, any>, opts?: { timeout?: number }): Promise<any> {
    let computePeers = this.getComputePeers();

    // #61: Startup grace period with reduced timeout (5s default, configurable)
    if (computePeers.length === 0) {
      const waitTimeout = opts?.timeout ?? PEER_WAIT_TIMEOUT_MS;
      const deadline = Date.now() + waitTimeout;
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

        // #60: Validate response data integrity
        const result = response?.result;
        if (method === 'getRecord' && result !== undefined && result !== null) {
          if (typeof result !== 'object') {
            console.warn(`[P2PStorageBackend] Suspicious response from ${peerId.slice(0, 12)}: getRecord returned ${typeof result} instead of object`);
          }
        }
        if ((method === 'queryRecords' || method === 'listRecords') && result !== undefined && result !== null) {
          if (!Array.isArray(result)) {
            console.warn(`[P2PStorageBackend] Suspicious response from ${peerId.slice(0, 12)}: ${method} returned ${typeof result} instead of array`);
          }
        }

        this.preferredPeerId = peerId;
        this.peerOnProbation.delete(peerId);  // #62: Successful request clears probation
        return result;
      } catch (err) {
        lastError = err as Error;
        // #62: If peer was on probation (just recovered), use extended unhealthy TTL
        const ttl = this.peerOnProbation.has(peerId) ? UNHEALTHY_EXTEND_MS : UNHEALTHY_TTL_MS;
        this.peerOnProbation.delete(peerId);
        this.unhealthyPeers.set(peerId, Date.now() + ttl);
        if (this.preferredPeerId === peerId) {
          this.preferredPeerId = null;
        }
        console.log(`[P2PStorageBackend] ${method} failed on ${peerId.slice(0, 12)}: ${(err as Error).message} (unhealthy for ${ttl / 1000}s)`);
      }
    }

    throw lastError || new Error('[P2PStorageBackend] All compute peers failed');
  }

  private isUnhealthy(peerId: string): boolean {
    const expiry = this.unhealthyPeers.get(peerId);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      // #62: Don't immediately trust recovered peers. Probe before clearing.
      // Use synchronous check — async health check would complicate the call site.
      // The peer will be tested on the next actual proxy() call. If it fails again,
      // it gets an extended unhealthy period.
      this.unhealthyPeers.delete(peerId);
      // Mark peer as "probation" — next failure extends unhealthy period
      this.peerOnProbation.add(peerId);
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
