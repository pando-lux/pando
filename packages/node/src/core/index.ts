/**
 * core/index.ts — Barrel exports for the Core layer (Layer 1).
 *
 * Core contains the agent system, storage backends, payment, deployment,
 * credential management, and version protocol.
 *
 * Cross-layer import rule: core/* may import from kernel/*, @pando/shared,
 * @pando/ledger, and external npm packages. NOT from platform/*.
 */

// AI Backend abstraction (v2.1)
export type { AIBackend, AITask, AIResult } from './ai-backend.js';
export { AIBackendRegistry } from './ai-backend-registry.js';
export { ClaudeBackend, detectClaudePath } from './ai-backend-claude.js';
export { OllamaBackend } from './ai-backend-ollama.js';

// Legacy agent system removed — replaced by AgentDatabase + MessageBus + WorkerPool + OrgManager + Orchestrator

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
export { VersionProtocol } from './version-protocol.js';
export { UpgradeProtocol, TOPIC_UPGRADES } from './upgrade-protocol.js';
export type { UpgradeProtocolDeps } from './upgrade-protocol.js';

// Payment
export { PaymentGate } from './payment-gate.js';

// Cloud instances
export { CloudInstanceManager } from './cloud-instance-manager.js';

// P2P request/reply
export { RequestReplyManager } from './request-reply.js';
export type { RequestHandler, RequestReplyStats } from './request-reply.js';

// New agent system
export { MessageBus } from './message-bus.js';
export type { SendMessageOpts } from './message-bus.js';

export { WorkerPool } from './worker-pool.js';
export type { WorkerConfig, WorkerStatus, SessionStrategy } from './worker-pool.js';

export { registerWorkerRoutes, generateWorkerToolsDocs } from './worker-mcp.js';
export type { WorkerTaskResponse, WorkerIdentityResponse, ReportProgressBody } from './worker-mcp.js';
