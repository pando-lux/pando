/**
 * core/index.ts — Barrel exports for the Core layer (Layer 1).
 *
 * Core contains storage backends, payment, deployment,
 * credential management, version protocol, and the engine adapter.
 *
 * Cross-layer import rule: core/* may import from kernel/*, @pando/shared,
 * @pando/ledger, and external npm packages. NOT from platform/*.
 */

// Engine Adapter — the ONE connection to @pando-code/core
export { EngineAdapter, PANDO_INFRA_AGENTS } from './engine-adapter.js';
export type { AdapterConfig, ReviewResult, TeamAgentConfig } from './engine-adapter.js';

// Team Registry — P2P-synced team routing metadata
export { TeamRegistry } from './team-registry.js';
export type { TeamConfig } from './team-registry.js';

// Storage
export type { StorageBackend } from './storage-backend.js';
export { MongoStorageBackend } from './mongo-backend.js';
export { P2PStorageBackend } from './p2p-storage-backend.js';

// Credentials
export { CredentialStore } from './credential-store.js';
export type { CredentialMetadata } from './credential-store.js';
export { generateDataKey, encryptCredential, decryptCredential } from './credential-vault.js';

// Deployment & versioning
export { DeployManager } from './deploy-manager.js';
export type { DeployStatus, CommitResult, BuildResult, BackupInfo } from './deploy-manager.js';
export { DeployPipeline } from './deploy-pipeline.js';
export type { DeployPipelineConfig, PipelineResult, PipelineStep } from './deploy-pipeline.js';
export { VersionProtocol } from './version-protocol.js';
export { UpgradeProtocol, TOPIC_UPGRADES } from './upgrade-protocol.js';
export type { UpgradeProtocolDeps } from './upgrade-protocol.js';

// Payment
export { PaymentGate } from './payment-gate.js';

// Cloud instances
export { CloudInstanceManager } from './cloud-instance-manager.js';

// Hosting pool
export { GatewayDeployPool, TOPIC_GATEWAYS } from './gateway-deploy-pool.js';
export { getHostingAdapter, registerHostingAdapter } from './hosting-adapters.js';
export type { HostingAdapter } from './hosting-adapters.js';

// P2P request/reply
export { RequestReplyManager } from './request-reply.js';
export type { RequestHandler, RequestReplyStats } from './request-reply.js';
