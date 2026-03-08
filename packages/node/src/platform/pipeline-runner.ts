/**
 * Pipeline Runner — orchestrates the complete autonomous code pipeline.
 *
 * Phase 16.7: Wires CodePipeline, QaRunner, DeployManager, and VersionProtocol
 * into a single sequential pipeline with rollback at each stage on failure.
 *
 * Pipeline stages:
 *   1. Version check   — verify this node meets version requirements
 *   2. Extract diff     — scan workspace output for changes (CodePipeline)
 *   3. Backup           — snapshot current repo state (DeployManager)
 *   4. Apply patch      — apply changes to repo with guardrail checks (CodePipeline)
 *   5. Build            — run `npm run build` to verify compilation (DeployManager)
 *   6. QA               — run page/API tests on affected pages (QaRunner)
 *   7. Commit           — stage and commit changes (DeployManager)
 *
 * On failure at any stage after backup, the pipeline rolls back:
 *   - Patch rollback via CodePipeline.rollback()
 *   - Repo restore via DeployManager.restoreBackup()
 *   - Commit revert via DeployManager.rollbackCommit()
 */

import { randomBytes } from 'node:crypto';
import type {
  PatchSet,
  MergeResult,
  RollbackInfo,
  QAResult,
  PipelineResult,
  GuardrailTier,
} from '@pando/shared';
import { CodePipeline } from './code-pipeline.js';
import { QaRunner } from './qa-runner.js';
import { DeployManager } from '../core/deploy-manager.js';
import type { BuildResult, CommitResult, BackupInfo } from '../core/deploy-manager.js';
import { VersionProtocol } from '../core/version-protocol.js';
import { Guardrails } from '../kernel/guardrails.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PipelineRunnerConfig {
  /** Repository root directory. */
  repoDir: string;
  /** Guardrail tier for this pipeline run. */
  tier?: GuardrailTier;
  /** Whether to skip QA tests (e.g. when Playwright is unavailable). */
  skipQa?: boolean;
  /** Whether to skip the version compatibility check. */
  skipVersionCheck?: boolean;
  /** Base URL for QA page tests. */
  qaBaseUrl?: string;
  /** Directory for QA screenshots. */
  qaScreenshotDir?: string;
  /** Required features the node must support (checked via VersionProtocol). */
  requiredFeatures?: string[];
}

export interface PipelineStageResult {
  stage: string;
  success: boolean;
  durationMs: number;
  error?: string;
  detail?: string;
}

export interface PipelineRunResult {
  pipelineId: string;
  success: boolean;
  stages: PipelineStageResult[];
  pipelineResult: PipelineResult;
  totalDurationMs: number;
}

export interface PipelineStatus {
  running: boolean;
  currentStage: string | null;
  runsCompleted: number;
  lastRun: PipelineRunResult | null;
}

// ── PipelineRunner ───────────────────────────────────────────────────────────

export class PipelineRunner {
  private readonly codePipeline: CodePipeline;
  private readonly qaRunner: QaRunner;
  private readonly deployManager: DeployManager;
  private readonly versionProtocol: VersionProtocol;
  private readonly config: PipelineRunnerConfig;
  private readonly guardrails: Guardrails | null;
  private running = false;
  private currentStage: string | null = null;
  private runsCompleted = 0;
  private lastRun: PipelineRunResult | null = null;
  constructor(
    codePipeline: CodePipeline,
    qaRunner: QaRunner,
    deployManager: DeployManager,
    versionProtocol: VersionProtocol,
    config: PipelineRunnerConfig,
    guardrails?: Guardrails,
  ) {
    this.codePipeline = codePipeline;
    this.qaRunner = qaRunner;
    this.deployManager = deployManager;
    this.versionProtocol = versionProtocol;
    this.config = config;
    this.guardrails = guardrails ?? null;
  }

  // NOTE: Restart callback removed (Phase 33). Restart decision is now made
  // by the caller (api-server.ts POST /pipeline/run) based on changed files.

  /**
   * Get the current pipeline status — whether a run is in progress,
   * which stage it's on, and the result of the last completed run.
   */
  getPipelineStatus(): PipelineStatus {
    return {
      running: this.running,
      currentStage: this.currentStage,
      runsCompleted: this.runsCompleted,
      lastRun: this.lastRun,
    };
  }

  /**
   * Run the full pipeline: extract → apply → backup → build → QA → commit.
   *
   * Each stage is executed sequentially. On failure at any stage after the
   * backup, a rollback is performed to restore the repository to its
   * pre-pipeline state.
   */
  async runPipeline(workspaceOutputDir: string, governanceApprovalId?: string, overrides?: { skipQa?: boolean; useGitDiff?: boolean }): Promise<PipelineRunResult> {
    this.running = true;
    this.currentStage = 'init';
    const pipelineId = randomBytes(16).toString('hex');
    const pipelineStart = Date.now();
    const stages: PipelineStageResult[] = [];
    const tier = this.config.tier ?? 'Standard';
    const effectiveSkipQa = overrides?.skipQa ?? this.config.skipQa;

    let patchSet: PatchSet | undefined;
    let mergeResult: MergeResult | undefined;
    let rollbackInfo: RollbackInfo | undefined;
    let backup: BackupInfo | undefined;
    let buildPassed = false;
    let testPassed = false;

    const finalize = (result: PipelineRunResult): PipelineRunResult => {
      this.running = false;
      this.currentStage = null;
      this.runsCompleted++;
      this.lastRun = result;
      return result;
    };

    // ── Stage 1: Version check ──────────────────────────────────────────
    this.currentStage = 'version-check';
    if (!this.config.skipVersionCheck) {
      const stageStart = Date.now();
      try {
        const versionInfo = this.versionProtocol.getVersionInfo();
        const hasCodePipeline = versionInfo.capabilities.some(
          c => c.name === 'code-pipeline' && c.enabled,
        );

        if (!hasCodePipeline) {
          const result = this.buildFailureResult(
            pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
            'Node does not have code-pipeline capability enabled',
          );
          stages.push({
            stage: 'version-check',
            success: false,
            durationMs: Date.now() - stageStart,
            error: 'Missing code-pipeline capability',
          });
          return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
        }

        // Check required features if specified
        if (this.config.requiredFeatures?.length) {
          const requirement = {
            taskId: pipelineId,
            minimumVersion: { major: 0, minor: 1, patch: 0 },
            requiredFeatures: this.config.requiredFeatures,
          };
          if (!this.versionProtocol.canClaimTask(requirement)) {
            const missing = this.config.requiredFeatures.filter(
              f => !versionInfo.capabilities.some(c => c.name === f && c.enabled),
            );
            const result = this.buildFailureResult(
              pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
              `Node missing required features: ${missing.join(', ')}`,
            );
            stages.push({
              stage: 'version-check',
              success: false,
              durationMs: Date.now() - stageStart,
              error: `Missing features: ${missing.join(', ')}`,
            });
            return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
          }
        }

        console.log(`[pipeline] Stage 1: Version check passed (v${versionInfo.protocolVersion.major}.${versionInfo.protocolVersion.minor}.${versionInfo.protocolVersion.patch})`);
        stages.push({
          stage: 'version-check',
          success: true,
          durationMs: Date.now() - stageStart,
          detail: `Protocol v${versionInfo.protocolVersion.major}.${versionInfo.protocolVersion.minor}.${versionInfo.protocolVersion.patch}`,
        });
      } catch (err: any) {
        console.log(`[pipeline] Stage 1 FAILED: ${err.message}`);
        stages.push({
          stage: 'version-check',
          success: false,
          durationMs: Date.now() - stageStart,
          error: err.message,
        });
        const result = this.buildFailureResult(
          pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
          `Version check failed: ${err.message}`,
        );
        return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
      }
    }

    // ── Stage 2: Extract diff ───────────────────────────────────────────
    this.currentStage = 'extract';
    {
      const stageStart = Date.now();
      try {
        const effectiveUseGitDiff = overrides?.useGitDiff ?? false;
        if (effectiveUseGitDiff) {
          console.log(`[pipeline] Stage 2: Using git diff (governance mode — bypassing workspace scan)`);
          patchSet = this.codePipeline.extractGitDiff();
        } else {
          patchSet = this.codePipeline.extractDiff(workspaceOutputDir);
        }

        if (patchSet.changes.length === 0) {
          console.log(`[pipeline] Stage 2: No changes detected — nothing to deploy`);
          stages.push({
            stage: 'extract',
            success: false,
            durationMs: Date.now() - stageStart,
            detail: 'No changes detected — nothing to deploy',
          });
          const result = this.buildFailureResult(
            pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
            'No changes detected in workspace or git working tree',
          );
          return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
        }

        console.log(`[pipeline] Stage 2: Extracted ${patchSet.changes.length} change(s)`);
        stages.push({
          stage: 'extract',
          success: true,
          durationMs: Date.now() - stageStart,
          detail: `${patchSet.changes.length} change(s) extracted`,
        });
      } catch (err: any) {
        console.log(`[pipeline] Stage 2 FAILED: ${err.message}`);
        stages.push({
          stage: 'extract',
          success: false,
          durationMs: Date.now() - stageStart,
          error: err.message,
        });
        const result = this.buildFailureResult(
          pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
          `Extract failed: ${err.message}`,
        );
        return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
      }
    }

    // ── Stage 3: Create backup ──────────────────────────────────────────
    this.currentStage = 'backup';
    {
      const stageStart = Date.now();
      try {
        backup = this.deployManager.createBackup(
          `Pre-pipeline backup for ${patchSet!.id}`,
        );
        console.log(`[pipeline] Stage 3: Backup created: ${backup.id}`);
        stages.push({
          stage: 'backup',
          success: true,
          durationMs: Date.now() - stageStart,
          detail: `Backup ${backup.id} created`,
        });
      } catch (err: any) {
        console.log(`[pipeline] Stage 3 FAILED: ${err.message}`);
        stages.push({
          stage: 'backup',
          success: false,
          durationMs: Date.now() - stageStart,
          error: err.message,
        });
        const result = this.buildFailureResult(
          pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
          `Backup failed: ${err.message}`,
        );
        return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
      }
    }

    // ── Stage 3.5: Guardrail pre-check ─────────────────────────────────
    if (this.guardrails) {
      this.currentStage = 'guardrail-precheck';
      const stageStart = Date.now();
      const filePaths = patchSet!.changes.map(c => c.filePath);

      const preCheckResult = this.guardrails.tieredPreCheck(filePaths, patchSet!.description, !!governanceApprovalId);

      console.log(`[pipeline] Stage 3.5: Guardrails ${preCheckResult.allowed ? 'passed' : 'BLOCKED'}`);
      if (!preCheckResult.allowed) {
        stages.push({
          stage: 'guardrail-precheck',
          success: false,
          durationMs: Date.now() - stageStart,
          error: preCheckResult.reason,
          detail: `Tier: ${preCheckResult.tier}, immutable violations: ${preCheckResult.immutableViolations.length}`,
        });

        // Rollback: restore from backup
        this.deployManager.restoreBackup(backup!.id);

        const result = this.buildFailureResult(
          pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
          `Guardrail pre-check blocked: ${preCheckResult.reason}`,
          patchSet,
        );
        return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
      }

      stages.push({
        stage: 'guardrail-precheck',
        success: true,
        durationMs: Date.now() - stageStart,
        detail: `Tier: ${preCheckResult.tier}, ${filePaths.length} file(s) approved`,
      });
    }

    // ── Stage 4: Apply patch ────────────────────────────────────────────
    this.currentStage = 'apply';
    {
      const stageStart = Date.now();
      try {
        mergeResult = this.codePipeline.applyPatch(patchSet!, !!governanceApprovalId);

        if (!mergeResult.success) {
          const conflictSummary = mergeResult.conflicts
            .map(c => `${c.filePath}: ${c.reason}`)
            .join('; ');

          console.log(`[pipeline] Stage 4 FAILED: Merge conflicts — ${conflictSummary}`);
          stages.push({
            stage: 'apply',
            success: false,
            durationMs: Date.now() - stageStart,
            error: `Merge conflicts: ${conflictSummary}`,
          });

          // Rollback: restore from backup
          this.deployManager.restoreBackup(backup!.id);

          const result = this.buildFailureResult(
            pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
            `Apply failed: ${conflictSummary}`,
            patchSet, mergeResult,
          );
          return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
        }

        // Extract rollback info from the merge result
        rollbackInfo = (mergeResult as MergeResult & { rollbackInfo?: RollbackInfo }).rollbackInfo;

        console.log(`[pipeline] Stage 4: Patch applied (${mergeResult.mergedFiles.length} files)`);
        stages.push({
          stage: 'apply',
          success: true,
          durationMs: Date.now() - stageStart,
          detail: `${mergeResult.mergedFiles.length} file(s) applied`,
        });
      } catch (err: any) {
        console.log(`[pipeline] Stage 4 FAILED: ${err.message}`);
        stages.push({
          stage: 'apply',
          success: false,
          durationMs: Date.now() - stageStart,
          error: err.message,
        });

        // Rollback: restore from backup
        this.deployManager.restoreBackup(backup!.id);

        const result = this.buildFailureResult(
          pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
          `Apply failed: ${err.message}`,
          patchSet,
        );
        return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
      }
    }

    // ── Stage 5: Build ──────────────────────────────────────────────────
    this.currentStage = 'build';
    {
      const stageStart = Date.now();
      try {
        const buildResult: BuildResult = this.deployManager.runBuild();
        buildPassed = buildResult.success;

        console.log(`[pipeline] Stage 5: Build ${buildResult.success ? 'PASSED' : 'FAILED'}`);
        if (!buildResult.success) {
          stages.push({
            stage: 'build',
            success: false,
            durationMs: buildResult.durationMs,
            error: buildResult.error ?? 'Build failed',
          });

          // Rollback: undo patch and restore backup
          if (rollbackInfo) {
            this.codePipeline.rollback(rollbackInfo);
          }
          this.deployManager.restoreBackup(backup!.id);

          const result = this.buildFailureResult(
            pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
            `Build failed: ${buildResult.error ?? 'unknown error'}`,
            patchSet, mergeResult, rollbackInfo,
          );
          return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
        }

        stages.push({
          stage: 'build',
          success: true,
          durationMs: buildResult.durationMs,
          detail: 'Build passed',
        });
      } catch (err: any) {
        console.log(`[pipeline] Stage 5 FAILED: ${err.message}`);
        stages.push({
          stage: 'build',
          success: false,
          durationMs: Date.now() - stageStart,
          error: err.message,
        });

        if (rollbackInfo) {
          this.codePipeline.rollback(rollbackInfo);
        }
        this.deployManager.restoreBackup(backup!.id);

        const result = this.buildFailureResult(
          pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
          `Build error: ${err.message}`,
          patchSet, mergeResult, rollbackInfo,
        );
        return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
      }
    }

    // ── Stage 5.5: Guardrail post-check ────────────────────────────────
    if (this.guardrails) {
      this.currentStage = 'guardrail-postcheck';
      const stageStart = Date.now();
      const changedFilePaths = patchSet!.changes.map(c => c.filePath);

      const postResult = this.guardrails.postCheck(changedFilePaths, this.config.repoDir, !!governanceApprovalId);

      if (!postResult.passed) {
        stages.push({
          stage: 'guardrail-postcheck',
          success: false,
          durationMs: Date.now() - stageStart,
          error: postResult.error ?? 'Post-check failed',
          detail: `buildOk=${postResult.buildOk}, testOk=${postResult.testOk}, protectedFilesOk=${postResult.protectedFilesOk}, immutableKernelOk=${postResult.immutableKernelOk}`,
        });

        // Rollback: undo patch and restore backup
        if (rollbackInfo) {
          this.codePipeline.rollback(rollbackInfo);
        }
        this.deployManager.restoreBackup(backup!.id);

        const result = this.buildFailureResult(
          pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
          `Guardrail post-check failed: ${postResult.error ?? 'unknown'}`,
          patchSet, mergeResult, rollbackInfo,
        );
        return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
      }

      stages.push({
        stage: 'guardrail-postcheck',
        success: true,
        durationMs: Date.now() - stageStart,
        detail: 'All post-check guardrails passed',
      });
    }

    // ── Stage 6: QA ─────────────────────────────────────────────────────
    this.currentStage = 'qa';
    if (!effectiveSkipQa) {
      const stageStart = Date.now();
      try {
        const affectedPages = this.qaRunner.getAffectedPages(patchSet!.changes);

        let qaResult: QAResult;
        if (affectedPages.length > 0) {
          // Launch headed browser for page-level (browser-tier) QA testing
          qaResult = await this.qaRunner.runPageTests(affectedPages, { headless: false });
        } else {
          // No affected pages — run API health check as minimum
          qaResult = await this.qaRunner.runApiTests(['/v1/status']);
        }

        testPassed = qaResult.success;
        console.log(`[pipeline] Stage 6: QA ${qaResult.success ? 'PASSED' : 'FAILED or SKIPPED'} (${qaResult.passed}/${qaResult.totalPages} pages)`);

        if (!qaResult.success) {
          const failedPages = qaResult.pages
            .filter(p => p.status !== 'passed')
            .map(p => `${p.url} (${p.status}${p.error ? ': ' + p.error : ''})`)
            .join('; ');

          stages.push({
            stage: 'qa',
            success: false,
            durationMs: qaResult.durationMs,
            error: `QA failed: ${failedPages}`,
          });

          // Rollback: undo patch and restore backup
          if (rollbackInfo) {
            this.codePipeline.rollback(rollbackInfo);
          }
          this.deployManager.restoreBackup(backup!.id);

          const result = this.buildFailureResult(
            pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
            `QA failed: ${failedPages}`,
            patchSet, mergeResult, rollbackInfo,
          );
          return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
        }

        stages.push({
          stage: 'qa',
          success: true,
          durationMs: qaResult.durationMs,
          detail: `${qaResult.passed}/${qaResult.totalPages} pages passed`,
        });
      } catch (err: any) {
        console.log(`[pipeline] Stage 6 FAILED: ${err.message}`);
        stages.push({
          stage: 'qa',
          success: false,
          durationMs: Date.now() - stageStart,
          error: err.message,
        });

        if (rollbackInfo) {
          this.codePipeline.rollback(rollbackInfo);
        }
        this.deployManager.restoreBackup(backup!.id);

        const result = this.buildFailureResult(
          pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
          `QA error: ${err.message}`,
          patchSet, mergeResult, rollbackInfo,
        );
        return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
      }
    } else {
      testPassed = true;
      console.log('[pipeline] Stage 6: QA skipped (skipQa=true)');
      stages.push({
        stage: 'qa',
        success: true,
        durationMs: 0,
        detail: 'Skipped (skipQa=true)',
      });
    }

    // ── Stage 7: Commit ─────────────────────────────────────────────────
    this.currentStage = 'commit';
    {
      const stageStart = Date.now();
      try {
        const commitResult: CommitResult = this.deployManager.commitChanges(patchSet!);

        if (!commitResult.success) {
          console.log(`[pipeline] Stage 7 FAILED: ${commitResult.error ?? commitResult.message}`);
          stages.push({
            stage: 'commit',
            success: false,
            durationMs: Date.now() - stageStart,
            error: commitResult.error ?? commitResult.message,
          });

          // Rollback: undo patch and restore backup
          if (rollbackInfo) {
            this.codePipeline.rollback(rollbackInfo);
          }
          this.deployManager.restoreBackup(backup!.id);

          const result = this.buildFailureResult(
            pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
            `Commit failed: ${commitResult.error ?? commitResult.message}`,
            patchSet, mergeResult, rollbackInfo,
          );
          return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
        }

        console.log(`[pipeline] Stage 7: Committed: ${commitResult.commitHash?.slice(0, 8)} (${commitResult.filesCommitted.length} files)`);
        stages.push({
          stage: 'commit',
          success: true,
          durationMs: Date.now() - stageStart,
          detail: `Committed ${commitResult.filesCommitted.length} file(s) — ${commitResult.commitHash?.slice(0, 8)}`,
        });
      } catch (err: any) {
        console.log(`[pipeline] Stage 7 FAILED: ${err.message}`);
        stages.push({
          stage: 'commit',
          success: false,
          durationMs: Date.now() - stageStart,
          error: err.message,
        });

        if (rollbackInfo) {
          this.codePipeline.rollback(rollbackInfo);
        }
        this.deployManager.restoreBackup(backup!.id);

        const result = this.buildFailureResult(
          pipelineId, stages, pipelineStart, tier, buildPassed, testPassed,
          `Commit error: ${err.message}`,
          patchSet, mergeResult, rollbackInfo,
        );
        return finalize({ pipelineId, success: false, stages, pipelineResult: result, totalDurationMs: Date.now() - pipelineStart });
      }
    }

    // ── Success ─────────────────────────────────────────────────────────
    const pipelineResult = this.buildSuccessResult(
      pipelineId, patchSet!, mergeResult, rollbackInfo,
      buildPassed, testPassed, tier, pipelineStart,
    );

    const result = finalize({
      pipelineId,
      success: true,
      stages,
      pipelineResult,
      totalDurationMs: Date.now() - pipelineStart,
    });

    // NOTE: Restart decision is made by the caller (api-server.ts POST /pipeline/run)
    // based on whether node source files changed. Pipeline just reports success.

    return result;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private buildSuccessResult(
    pipelineId: string,
    patchSet: PatchSet | undefined,
    mergeResult: MergeResult | undefined,
    rollbackInfo: RollbackInfo | undefined,
    buildPassed: boolean,
    testPassed: boolean,
    tier: GuardrailTier,
    startedAt: number,
  ): PipelineResult {
    return {
      pipelineId,
      success: true,
      patchSet,
      mergeResult,
      rollbackInfo,
      buildPassed,
      testPassed,
      tier,
      startedAt,
      completedAt: Date.now(),
    };
  }

  private buildFailureResult(
    pipelineId: string,
    _stages: PipelineStageResult[],
    startedAt: number,
    tier: GuardrailTier,
    buildPassed: boolean,
    testPassed: boolean,
    error: string,
    patchSet?: PatchSet,
    mergeResult?: MergeResult,
    rollbackInfo?: RollbackInfo,
  ): PipelineResult {
    return {
      pipelineId,
      success: false,
      patchSet,
      mergeResult,
      rollbackInfo,
      buildPassed,
      testPassed,
      tier,
      startedAt,
      completedAt: Date.now(),
      error,
    };
  }
}
