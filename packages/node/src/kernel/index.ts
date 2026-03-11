/**
 * kernel/index.ts — Barrel exports for the Kernel layer (Layer 0).
 *
 * The Kernel contains P2P networking, ledger sync, governance, monitoring,
 * guardrails, security, reputation, and emission witness.
 *
 * Cross-layer import rule: kernel/* may only import from kernel/* itself,
 * @pando/shared, @pando/ledger, and external npm packages.
 */

export { PandoNetwork } from './network.js';
export type { MessageHandler, PeerHandler, DiscoverySource } from './network.js';

export { LedgerSync, TOPIC_TRANSACTIONS, TOPIC_SYNC, TOPIC_ACTIVITY } from './sync.js';

export { GovernanceSync, TOPIC_GOVERNANCE, TOPIC_AGENT, PROPOSAL_STAKE_LUX, EMERGENCY_STAKE_LUX, AMENDMENT_COST_LUX } from './governance.js';

export { HealthMonitor } from './monitor.js';

export { Guardrails, IMMUTABLE_KERNEL_FILES } from './guardrails.js';

export { SecurityMonitor } from './security-monitor.js';
export type { SecurityAlert, SecurityAlertType, SecurityAlertSeverity, QuarantineEntry, QuarantineLevel } from './security-monitor.js';

export { ReputationManager } from './reputation.js';
export type { ReputationRecord, ReputationEvent } from './reputation.js';

export { EmissionWitness, TOPIC_EMISSIONS } from './emission-witness.js';
export type { EmissionProposal, WitnessAttestation, EmissionStats } from './emission-witness.js';

export { LocalEnvironment } from './local-environment.js';
export type { MemoryEntry } from './local-environment.js';

export { NetworkState } from './network-state.js';
export type { NetworkStateSnapshot } from './network-state.js';

export { checkAndRecordStartup, markStable, getStabilityDelay } from './crash-guard.js';

export { writeRestartReason, readRestartReason, clearRestartReason } from './restart-reason.js';
export type { RestartReason } from './restart-reason.js';

export { analyzeStartupHealth, resetCircuitBreaker } from './startup-health.js';
export type { StartupHealthReport } from './startup-health.js';
