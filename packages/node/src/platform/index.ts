/**
 * platform/index.ts — Barrel exports for the Platform layer (Layer 2).
 *
 * Platform contains higher-level services: content system,
 * scheduler, resources, hosting, projects, and more.
 *
 * Cross-layer import rule: platform/* may import from core/*, kernel/*,
 * @pando/shared, @pando/ledger, and external npm packages.
 */

export { detectCapabilities } from './capability-detector.js';
export type { DetectionResult } from './capability-detector.js';

export { CapabilityRegistry } from './capability-registry.js';

export { LocalCapabilityStore } from './local-capability-store.js';
export type { LocalCapabilityData } from './local-capability-store.js';

export { CodePipeline } from './code-pipeline.js';

export { ContentRegistry, TOPIC_CONTENT } from './content-registry.js';
export { ContentPublisher } from './content-publish.js';
export type { PublishOptions, ExtractedContent } from './content-publish.js';
export { ContentMaintenance } from './content-maintenance.js';
export type { MaintenanceConfig, MaintenanceCheck, MaintenanceIssue } from './content-maintenance.js';
export { ContentSafetyReviewer } from './content-safety.js';

export { ContributionTracker } from './contribution-tracker.js';

export { FileRegistry } from './file-registry.js';

export { PipelineRunner } from './pipeline-runner.js';
export type { PipelineRunnerConfig, PipelineStageResult, PipelineRunResult, PipelineStatus } from './pipeline-runner.js';

export { ProjectRegistry, TOPIC_PROJECTS } from './project-registry.js';
export { ProjectStore } from './project-store.js';
export type { CreateProjectOpts, ListProjectsOpts, ProjectStats } from './project-store.js';

export { QaRunner } from './qa-runner.js';

export { RegressionSuite } from './regression-suite.js';

export { ReputationWeightedGovernance } from './reputation-governance.js';

export { ResourceMarketplace } from './resource-marketplace.js';
export { ResourceMeter } from './resource-meter.js';
export { ResourceProofChallenger } from './resource-proof.js';
export { ResourceRegistry, TOPIC_RESOURCES } from './resource-registry.js';
export { ResourceRouter } from './resource-router.js';

export { ResourceHealthChecker } from './resource-health.js';
export type { HealthResult } from './resource-health.js';

export { RevenueEngine } from './revenue-engine.js';

export { Scheduler } from './scheduler.js';
export type { SchedulerConfig, SchedulerStatus, ActiveTask, TaskLifecycle } from './scheduler.js';

export { TaskDatabase, openTaskDatabase } from './task-database.js';
export { TaskQueue } from './task-queue.js';
export type { Task, TaskStatus, TaskPriority, TaskResult, TaskRoleMetadata } from './task-queue.js';

export { ThreadStore } from './thread-store.js';

export { UserAccountStore } from './user-accounts.js';
