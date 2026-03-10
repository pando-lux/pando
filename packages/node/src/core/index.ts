/**
 * core/index.ts — Barrel exports for the Core layer (Layer 1).
 *
 * Core contains storage backends, payment, deployment,
 * credential management, version protocol, and the engine adapter.
 *
 * Cross-layer import rule: core/* may import from kernel/*, @pando/shared,
 * @pando/ledger, and external npm packages. NOT from platform/*.
 */

// Engine Adapter — the ONE connection to @pando-teams/core
export { EngineAdapter } from './engine-adapter.js';
export type { AdapterConfig, ReviewResult } from './engine-adapter.js';

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

// Unified git operations
export { GitOps, safeGitRef, safeCommitHash } from './git-ops.js';
export type { GitOpsOptions } from './git-ops.js';

// GitHub API client
export { GitHubClient } from './github-client.js';
export type { CreateRepoOptions, RepoInfo } from './github-client.js';

// Deployment & versioning
export { DeployManager } from './deploy-manager.js';
export type { DeployStatus, CommitResult, BuildResult, BackupInfo } from './deploy-manager.js';
export { VersionProtocol } from './version-protocol.js';
export { UpgradeProtocol, TOPIC_UPGRADES } from './upgrade-protocol.js';
export type { UpgradeProtocolDeps } from './upgrade-protocol.js';

// App lifecycle — unified deploy, update, health, rollback
export { AppManager } from './app-manager.js';
export type { AppConfig, App, AppHistory, DeployResult, UpdateResult, RollbackResult } from './app-manager.js';

// Payment
export { PaymentGate } from './payment-gate.js';

// Cloud instances
export { CloudInstanceManager } from './cloud-instance-manager.js';

// HTTP peer client — direct HTTP for inter-node operations (replaces P2P unicast)
export { HttpPeerClient, HttpPeerError } from './http-peer-client.js';

// Request/Reply — handler registry + broadcast queries (unicast removed in Phase A)
export { RequestReplyManager } from './request-reply.js';
export type { RequestHandler, RequestReplyStats } from './request-reply.js';
