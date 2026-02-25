/**
 * P2PStorageBackend — Phase 83: Storage proxy for untrusted nodes.
 *
 * Implements the StorageBackend interface by forwarding all CRUD operations
 * via P2P request-reply to compute nodes that have MongoDB (MongoStorageBackend).
 *
 * Used on nodes without PANDO_STORAGE_URL. Compute nodes register a
 * `pando/storage-proxy` handler that executes operations against their
 * local MongoStorageBackend.
 *
 * Security:
 * - Does NOT expose getDb() — CredentialStore only initializes on compute nodes
 * - Collection blocklist enforced at handler level (pando_credentials blocked)
 * - Method allowlist at handler level (only 6 CRUD methods)
 */

import type { StorageBackend } from './storage-backend.js';
import type { RequestReplyManager } from './request-reply.js';
/** Minimal interface — avoids importing platform/ from core/ */
interface CapabilityRegistryLike {
  getAllProfiles(): import('@pando/shared').CapabilityProfile[];
}

const PROXY_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const PEER_WAIT_TIMEOUT_MS = 30_000;  // Wait up to 30s for compute peers on first call
const PEER_POLL_INTERVAL_MS = 1_000;  // Poll every 1s

export class P2PStorageBackend implements StorageBackend {
  private preferredPeerId: string | null = null;

  constructor(
    private requestReply: RequestReplyManager,
    private capabilityRegistry: CapabilityRegistryLike,
    private localPeerId: string,
  ) {}

  async init(): Promise<void> {
    // No-op — P2P network is already connected by the time this is created
  }

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

  // ─── Core proxy logic ────────────────────────────────────────────────

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

    // Try preferred peer first (sticky affinity), then others
    const ordered = this.orderPeers(computePeers);
    let lastError: Error | null = null;

    for (let i = 0; i < Math.min(MAX_ATTEMPTS, ordered.length); i++) {
      const peerId = ordered[i];
      try {
        const reply = await this.requestReply.request(
          peerId,
          'pando/storage-proxy',
          { method, args },
          PROXY_TIMEOUT_MS,
        );

        const payload = reply.payload;
        if (payload?.error) {
          throw new Error(`Storage proxy error: ${payload.error}`);
        }

        // Success — set sticky affinity
        this.preferredPeerId = peerId;
        return payload?.result;
      } catch (err) {
        lastError = err as Error;
        // Clear affinity on failure so we try a different peer next
        if (this.preferredPeerId === peerId) {
          this.preferredPeerId = null;
        }
        console.log(`[P2PStorageBackend] ${method} failed on ${peerId.slice(0, 12)}: ${(err as Error).message}`);
      }
    }

    throw lastError || new Error('[P2PStorageBackend] All compute peers failed');
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
    // Move preferred to front
    return [
      this.preferredPeerId,
      ...peers.filter(p => p !== this.preferredPeerId),
    ];
  }
}
