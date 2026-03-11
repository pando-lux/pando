import { ReputationWeightedGovernance } from './platform/reputation-governance.js';
import { ContentSafetyReviewer } from './platform/content-safety.js';
// KB: ResourceRegistry, CredentialStore wiring, and ResourceHealthChecker deleted Phase 6.
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

    // Gateway hosting pool removed — gateway is managed separately on Vercel.
    // App deployment is now handled by AppManager (see core/app-manager.ts).
}
