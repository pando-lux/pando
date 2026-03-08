import { ReputationWeightedGovernance } from './platform/reputation-governance.js';
import { ContentSafetyReviewer } from './platform/content-safety.js';
import { ResourceRegistry } from './platform/resource-registry.js';
import { CredentialStore } from './core/credential-store.js';
import { ResourceHealthChecker } from './platform/resource-health.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function initCore(node: any): Promise<void> {
    const dataDir = node.config.dataDir || join(homedir(), '.pando');

    // Phase 12.4: Initialize ReputationWeightedGovernance — reputation-weighted voting
    node.reputationGovernance = new ReputationWeightedGovernance(
      node.reputation,
      () => Math.floor(process.uptime()) * 1000, // uptime in ms
    );
    // Wire into governance
    if (node.governance) {
      node.governance.setReputationGovernance(node.reputationGovernance);
    }

    // Phase 12.5: Initialize ContentSafetyReviewer — rule-based content safety review
    node.contentSafetyReviewer = new ContentSafetyReviewer(node.identity.peerId, dataDir);

    // Phase 69: Resource Registry (metadata-only P2P) + CredentialStore (MongoDB encrypted)
    node.resourceRegistry = new ResourceRegistry(node.network, node.identity.peerId, node.ledger.getDatabase());
    await node.resourceRegistry.start();

    // Auto-connect MongoDB via PANDO_STORAGE_URL env var (if not already set by CLI)
    if (!node.storageBackend) {
      // PANDO_STORAGE_URL env var — primary way to configure MongoDB
      const storageUrl = process.env.PANDO_STORAGE_URL;
      if (storageUrl) {
        try {
          const { MongoStorageBackend } = await import('./core/mongo-backend.js');
          const mongo = new MongoStorageBackend(storageUrl);
          await mongo.init();
          node.setStorageBackend(mongo);
          console.log('[node] MongoDB connected via PANDO_STORAGE_URL');
        } catch (err) {
          console.error(`[node] Failed to connect to MongoDB: ${(err as Error).message}`);
        }
      }
    }

    // Phase 83: If no MongoDB, create P2PStorageBackend to proxy storage to compute nodes via HTTP
    if (!node.storageBackend) {
      try {
        const { P2PStorageBackend } = await import('./core/p2p-storage-backend.js');
        const p2pBackend = new P2PStorageBackend(node.httpPeerClient, node.capabilityRegistry, node.identity.peerId);
        await p2pBackend.init();
        node.setStorageBackend(p2pBackend);
        // Update capability profile to reflect P2P storage
        const localProfile = node.capabilityRegistry.getLocalProfile();
        if (localProfile) {
          (localProfile as any).storageBackend = 'p2p';
          localProfile.updatedAt = Date.now();
          node.capabilityRegistry.setLocalProfile(localProfile);
        }
        console.log('[node] P2PStorageBackend initialized — proxying storage to compute nodes');
      } catch (err) {
        console.error(`[node] Failed to init P2PStorageBackend: ${(err as Error).message}`);
      }
    }

    // Phase 69: Wire CredentialStore to ResourceRegistry (after MongoDB is connected)
    // v2.4: Delete CREDENTIAL_MASTER_KEY from process.env immediately after loading into memory.
    if (node.storageBackend && typeof (node.storageBackend as any).getDb === 'function') {
      try {
        const mongoDb = (node.storageBackend as any).getDb();
        const credentialStore = new CredentialStore(mongoDb, process.env.CREDENTIAL_MASTER_KEY);
        await credentialStore.init();
        // v2.4: Remove env var from process environment — key now lives ONLY in credentialStore.masterKey
        if (process.env.CREDENTIAL_MASTER_KEY) {
          delete process.env.CREDENTIAL_MASTER_KEY;
          console.log('[security] CREDENTIAL_MASTER_KEY deleted from process.env (key is memory-only now)');
        }
        node.resourceRegistry.setCredentialStore(credentialStore);
        (node as any)._credentialStore = credentialStore; // Store reference for P2P handlers
        // Phase 53.8: Start resource health checker (compute nodes only)
        node.resourceHealthChecker = new ResourceHealthChecker();
        node.resourceHealthChecker.setDependencies(credentialStore, node.resourceRegistry);
        node.resourceHealthChecker.start();
      } catch (err) {
        console.error(`[node] Failed to init CredentialStore: ${(err as Error).message}`);
      }
    }

    // Phase 69 (follow-up): Wire credential proxy for non-secure nodes via HTTP.
    // If this node has no decryption capability, proxy code_repository credential requests to compute peers.
    {
      const credStore = (node as any)._credentialStore as import('./core/credential-store.js').CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) {
        node.resourceRegistry.setP2PCredentialProxy(async (resourceId: string, type: string) => {
          if (!node.httpPeerClient || !node.capabilityRegistry) return null;
          const allProfiles = node.capabilityRegistry.getAllProfiles();
          const computePeers = allProfiles.filter((p: any) =>
            p.storageBackend === 'mongodb' && p.peerId !== node.identity?.peerId
          );
          for (const peer of computePeers.slice(0, 3)) {
            try {
              const credential = await node.httpPeerClient.getCredential(peer.peerId, resourceId, type);
              if (credential) {
                console.log(`[resources] HTTP credential proxy: got ${type} from ${peer.peerId.slice(0, 12)}`);
                return credential;
              }
            } catch { /* try next peer */ }
          }
          console.warn(`[resources] HTTP credential proxy: no compute peer could decrypt ${resourceId.slice(0, 8)}`);
          return null;
        });
      }
    }

    // Gateway hosting pool removed — gateway is managed separately on Vercel.
    // App deployment is now handled by AppManager (see core/app-manager.ts).
}
