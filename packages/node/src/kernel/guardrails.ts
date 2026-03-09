/**
 * Guardrails — safety system for self-generated changes.
 *
 * Phase 9.3: Protected paths, rate limiting, auto-rollback on build failure,
 * and a pending-changes queue for changes to core files.
 *
 * Config stored at ~/.pando/guardrails.json (created with defaults on first run).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { GitOps } from '../core/git-ops.js';
import type {
  GuardrailConfig,
  PendingChange,
  PendingChangeStatus,
  GuardrailTier,
  TieredGuardrailConfig,
  TierRequirements,
} from '@pando/shared';

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: GuardrailConfig = {
  protectedPaths: [
    'packages/shared/',
    'packages/ledger/',
    'packages/node/src/index.ts',
    'packages/node/src/network.ts',
  ],
  maxSelfChangesPerHour: 5,
  maxSelfChangesPerDay: 20,
  rollbackOnBuildFailure: true,
  rollbackOnTestFailure: true,
  requireApprovalForCore: true,
  approvalTimeout: 24 * 60 * 60 * 1000, // 24 hours
};

const MAX_PENDING_CHANGES = 200;

// ── Tiered Guardrail Defaults (Phase 16) ─────────────────────────────────────

/** Default path-to-tier mapping for the autonomous code pipeline. */
const DEFAULT_PATH_TO_TIER: Record<string, GuardrailTier> = {
  // Critical: core infrastructure
  'network.ts': 'Critical',
  'sync.ts': 'Critical',
  'ledger/': 'Critical',
  'crypto.ts': 'Critical',
  'identity.ts': 'Critical',
  'types.ts': 'Critical',
  // Important: orchestration and governance
  'index.ts': 'Important',
  'api-server.ts': 'Important',
  'scheduler.ts': 'Important',
  'governance.ts': 'Important',
  'guardrails.ts': 'Important',
  'planner.ts': 'Important',
  // Standard: gateway layer
  'gateway/': 'Standard',
  // Low: everything else is handled as default in getTier()
};

/** Default tier requirements. */
const DEFAULT_TIER_REQUIREMENTS: Record<GuardrailTier, TierRequirements> = {
  Critical: {
    tier: 'Critical',
    requiresApproval: true,
    requiresReview: true,
    requiresTest: true,
    requiresBuild: true,
    maxChangesPerHour: 2,
    cooldownMs: 30 * 60 * 1000, // 30 minutes
  },
  Important: {
    tier: 'Important',
    requiresApproval: true,
    requiresReview: true,
    requiresTest: true,
    requiresBuild: true,
    maxChangesPerHour: 5,
    cooldownMs: 10 * 60 * 1000, // 10 minutes
  },
  Standard: {
    tier: 'Standard',
    requiresApproval: false,
    requiresReview: true,
    requiresTest: true,
    requiresBuild: true,
    maxChangesPerHour: 10,
    cooldownMs: 5 * 60 * 1000, // 5 minutes
  },
  Low: {
    tier: 'Low',
    requiresApproval: false,
    requiresReview: false,
    requiresTest: false,
    requiresBuild: true,
    maxChangesPerHour: 20,
    cooldownMs: 1 * 60 * 1000, // 1 minute
  },
};

/**
 * Files that must NEVER be modified by the autonomous pipeline.
 * These form the immutable kernel of the system.
 *
 * IMPORTANT: Any upgrade proposal touching these files MUST be
 * auto-rejected with an explanation. These are the safety-critical
 * files that protect the network's integrity.
 */
export const IMMUTABLE_KERNEL_FILES: string[] = [
  'packages/shared/src/crypto.ts',
  'packages/node/src/guardrails.ts',
  'packages/node/src/governance.ts',
  'packages/ledger/src/transactions.ts',
  'packages/node/src/code-pipeline.ts',
  'packages/node/src/deploy-manager.ts',
  'packages/shared/src/identity.ts',
];

/**
 * Legacy short-name list used by tiered guardrail config.
 * Kept for backward compatibility with existing TieredGuardrailConfig.
 */
const IMMUTABLE_KERNEL: string[] = [
  'code-pipeline.ts',
  'deploy-manager.ts',
  'governance.ts',
  'crypto.ts',
  'guardrails.ts',
  'identity.ts',
  'transactions.ts',
];

const DEFAULT_TIERED_CONFIG: TieredGuardrailConfig = {
  tiers: { ...DEFAULT_TIER_REQUIREMENTS },
  pathToTier: { ...DEFAULT_PATH_TO_TIER },
  immutableKernel: [...IMMUTABLE_KERNEL],
};

// ── Guardrails Class ──────────────────────────────────────────────────────────

export class Guardrails {
  private config: GuardrailConfig;
  private configPath: string;
  private pendingPath: string;
  private pending: PendingChange[] = [];

  // Rate limit tracking — timestamps of self-generated changes
  private changeTimestamps: number[] = [];

  // Tiered guardrail configuration (Phase 16)
  readonly tieredConfig: TieredGuardrailConfig;

  constructor(dataDir: string) {
    this.configPath = join(dataDir, 'guardrails.json');
    this.pendingPath = join(dataDir, 'guardrails-pending.json');

    // Ensure data directory exists
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    // Load or create config
    this.config = this.loadConfig();
    this.loadPending();

    // Initialize tiered config with defaults
    this.tieredConfig = { ...DEFAULT_TIERED_CONFIG };
  }

  // ── Config ──

  private loadConfig(): GuardrailConfig {
    try {
      if (existsSync(this.configPath)) {
        const data = JSON.parse(readFileSync(this.configPath, 'utf-8'));
        return { ...DEFAULT_CONFIG, ...data };
      }
    } catch {
      // Corrupt config — recreate
    }
    // Create default config
    this.saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  private saveConfig(config: GuardrailConfig): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (err: any) {
      console.error(`[guardrails] Failed to save config: ${err.message}`);
    }
  }

  getConfig(): GuardrailConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<GuardrailConfig>): GuardrailConfig {
    Object.assign(this.config, partial);
    this.saveConfig(this.config);
    return { ...this.config };
  }

  // ── Pending Changes ──

  private loadPending(): void {
    try {
      if (existsSync(this.pendingPath)) {
        const data = JSON.parse(readFileSync(this.pendingPath, 'utf-8'));
        if (Array.isArray(data)) {
          this.pending = data.slice(0, MAX_PENDING_CHANGES);
        }
      }
    } catch {
      this.pending = [];
    }
  }

  private savePending(): void {
    try {
      writeFileSync(this.pendingPath, JSON.stringify(this.pending, null, 2));
    } catch (err: any) {
      console.error(`[guardrails] Failed to save pending changes: ${err.message}`);
    }
  }

  getPending(): PendingChange[] {
    // Expire stale entries
    const now = Date.now();
    let changed = false;
    for (const p of this.pending) {
      if (p.status === 'pending' && p.expiresAt <= now) {
        p.status = 'expired';
        p.reviewedAt = now;
        changed = true;
      }
    }
    if (changed) this.savePending();
    return this.pending.filter(p => p.status === 'pending');
  }

  getAllPending(): PendingChange[] {
    return [...this.pending];
  }

  getPendingById(id: string): PendingChange | null {
    return this.pending.find(p => p.id === id) || null;
  }

  // ── Pre-Change Check ──

  /**
   * Check whether a proposed change is allowed. Returns an object with:
   * - allowed: true if the change can proceed immediately
   * - reason: explanation if blocked
   * - pendingId: if the change was queued for approval
   */
  preCheck(filePaths: string[], description: string, reason: string, proposedBy: string, taskId?: string): {
    allowed: boolean;
    reason: string;
    pendingId?: string;
  } {
    // 1. Check rate limits
    const rateLimitResult = this.checkRateLimits();
    if (!rateLimitResult.allowed) {
      return rateLimitResult;
    }

    // 2. Check protected paths
    const protectedFiles = this.getProtectedFiles(filePaths);
    if (protectedFiles.length > 0 && this.config.requireApprovalForCore) {
      // Queue for approval
      const pendingChange: PendingChange = {
        id: randomBytes(8).toString('hex'),
        filePaths,
        description,
        reason,
        proposedBy,
        taskId,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + this.config.approvalTimeout,
      };

      this.pending.unshift(pendingChange);
      if (this.pending.length > MAX_PENDING_CHANGES) {
        this.pending = this.pending.slice(0, MAX_PENDING_CHANGES);
      }
      this.savePending();

      console.log(`[guardrails] Change queued for approval: ${pendingChange.id.slice(0, 8)} — ${description}`);
      console.log(`[guardrails]   Protected files: ${protectedFiles.join(', ')}`);

      return {
        allowed: false,
        reason: `Change affects protected paths: ${protectedFiles.join(', ')}. Queued for approval.`,
        pendingId: pendingChange.id,
      };
    }

    // 3. Allowed — record the change timestamp for rate limiting
    this.recordChange();

    return { allowed: true, reason: 'Change permitted.' };
  }

  // ── Post-Change Verification ──

  /**
   * Verify a change after it was applied. Runs build (and optionally tests)
   * with comprehensive guardrails for error handling and condition validation.
   *
   * Guardrails applied:
   *   1. Working directory validation — ensures cwd exists and contains package.json
   *   2. Tier-aware checks — respects tier requirements (skip build/test when not required)
   *   3. package.json validation — safely parses and validates before running scripts
   *   4. Build verification — runs `npm run build` with timeout and error sanitization
   *   5. Test verification — runs `npm test` only when a real test script is configured
   *   6. Error sanitization — truncates and strips absolute paths from error messages
   *   7. Timeout protection — enforces strict timeouts to prevent runaway processes
   *
   * Returns whether verification passed. If it fails and rollback is enabled,
   * the caller is responsible for reverting (guardrails just reports the result).
   *
   * @param filePaths — optional list of changed file paths for tier-aware checking
   */
  postCheck(filePaths?: string[], repoDir?: string, governanceApproved?: boolean): {
    passed: boolean;
    buildOk: boolean;
    testOk: boolean;
    protectedFilesOk: boolean;
    immutableKernelOk: boolean;
    error?: string;
  } {
    let buildOk = true;
    let testOk = true;
    let protectedFilesOk = true;
    let immutableKernelOk = true;
    let error: string | undefined;

    // ── Guard 1: Determine tier requirements when file paths are provided ──
    let requiresBuild = this.config.rollbackOnBuildFailure;
    let requiresTest = this.config.rollbackOnTestFailure;

    if (filePaths && filePaths.length > 0) {
      // Determine the highest tier among changed files
      const tierOrder: GuardrailTier[] = ['Critical', 'Important', 'Standard', 'Low'];
      let highestTierIndex = tierOrder.length - 1;

      for (const fp of filePaths) {
        const tier = this.getTier(fp);
        const idx = tierOrder.indexOf(tier);
        if (idx < highestTierIndex) {
          highestTierIndex = idx;
        }
      }

      const effectiveTier = tierOrder[highestTierIndex];
      const requirements = this.getRequirements(effectiveTier);

      // Tier requirements override config — tier can only make checks stricter, not skip them
      requiresBuild = requiresBuild || requirements.requiresBuild;
      requiresTest = requiresTest || requirements.requiresTest;

      console.log(`[guardrails] postCheck: tier="${effectiveTier}", requiresBuild=${requiresBuild}, requiresTest=${requiresTest}`);
    }

    // ── Guard 2: Verify no immutable kernel files were modified ──
    if (filePaths && filePaths.length > 0) {
      const kernelViolations = filePaths.filter(fp => this.isImmutableKernel(fp));
      if (kernelViolations.length > 0) {
        immutableKernelOk = false;
        error = `Immutable kernel files were modified: ${kernelViolations.join(', ')}`;
        console.error(`[guardrails] postCheck: ${error}`);
        return { passed: false, buildOk: false, testOk: false, protectedFilesOk, immutableKernelOk, error };
      }
    }

    // ── Guard 3: Verify no protected paths were modified without approval ──
    // Governance-approved changes bypass protected path checks (voting IS the approval)
    if (!governanceApproved && filePaths && filePaths.length > 0) {
      const protectedViolations = this.getProtectedFiles(filePaths);
      if (protectedViolations.length > 0 && this.config.requireApprovalForCore) {
        // Check if these changes were previously approved in the pending queue
        const unapproved = protectedViolations.filter(fp => {
          const approvedChange = this.pending.find(
            p => p.status === 'approved' && p.filePaths.some(
              pf => pf.replace(/\\/g, '/') === fp.replace(/\\/g, '/'),
            ),
          );
          return !approvedChange;
        });

        if (unapproved.length > 0) {
          protectedFilesOk = false;
          error = `Protected files were modified without approval: ${unapproved.join(', ')}`;
          console.error(`[guardrails] postCheck: ${error}`);
          return { passed: false, buildOk: false, testOk: false, protectedFilesOk, immutableKernelOk, error };
        }
      }
    }

    // ── Guard 4: Validate working directory ──
    const cwd = repoDir || process.cwd();
    if (!cwd || !existsSync(cwd)) {
      return {
        passed: false,
        buildOk: false,
        testOk: false,
        protectedFilesOk,
        immutableKernelOk,
        error: 'Working directory does not exist or is inaccessible.',
      };
    }

    const packageJsonPath = join(cwd, 'package.json');
    if (!existsSync(packageJsonPath)) {
      // No package.json — cannot run npm scripts; treat as a pass if no checks required
      if (!requiresBuild && !requiresTest) {
        return { passed: true, buildOk: true, testOk: true, protectedFilesOk, immutableKernelOk };
      }
      return {
        passed: false,
        buildOk: false,
        testOk: false,
        protectedFilesOk,
        immutableKernelOk,
        error: 'No package.json found in working directory — cannot run build or test scripts.',
      };
    }

    // ── Guard 5: Validate package.json is parseable ──
    let pkg: Record<string, any>;
    try {
      const raw = readFileSync(packageJsonPath, 'utf-8');
      pkg = JSON.parse(raw);
      if (typeof pkg !== 'object' || pkg === null) {
        throw new Error('package.json is not a valid JSON object');
      }
    } catch (parseErr: any) {
      return {
        passed: false,
        buildOk: false,
        testOk: false,
        protectedFilesOk,
        immutableKernelOk,
        error: `Invalid package.json: ${this.sanitizeError(parseErr.message)}`,
      };
    }

    // ── Guard 6: Build check ──
    if (requiresBuild) {
      // Verify a build script actually exists
      if (!pkg.scripts?.build) {
        console.warn('[guardrails] postCheck: no "build" script in package.json — skipping build check');
      } else {
        try {
          execSync('npm run build', {
            cwd,
            timeout: 120_000, // 2 minute timeout
            stdio: 'pipe',
            maxBuffer: 10 * 1024 * 1024, // 10 MB buffer to prevent truncation errors
            windowsHide: true,
          });
        } catch (err: any) {
          buildOk = false;
          const rawMsg = err.stderr?.toString() || err.stdout?.toString() || err.message || 'Unknown build error';
          error = `Build failed: ${this.sanitizeError(rawMsg)}`;
          console.error(`[guardrails] ${error}`);
        }
      }
    }

    // ── Guard 7: Test check (only if build passed) ──
    if (buildOk && requiresTest) {
      // Validate that a real test script exists (not the npm default placeholder)
      const testScript = pkg.scripts?.test;
      const isPlaceholder = !testScript
        || testScript === 'echo "Error: no test specified" && exit 1'
        || testScript.trim() === '';

      if (isPlaceholder) {
        console.log('[guardrails] postCheck: no real test script configured — skipping test check');
      } else {
        try {
          execSync('npm test', {
            cwd,
            timeout: 300_000, // 5 minute timeout
            stdio: 'pipe',
            maxBuffer: 10 * 1024 * 1024, // 10 MB buffer
            windowsHide: true,
          });
        } catch (err: any) {
          testOk = false;
          const rawMsg = err.stderr?.toString() || err.stdout?.toString() || err.message || 'Unknown test error';
          error = `Tests failed: ${this.sanitizeError(rawMsg)}`;
          console.error(`[guardrails] ${error}`);
        }
      }
    }

    // ── Guard 8: Post-execution guardrail invariant check ──
    // Verify rate limit state is consistent (no negative counters, timestamps in past)
    const now = Date.now();
    this.changeTimestamps = this.changeTimestamps.filter(t => t > 0 && t <= now);

    const passed = buildOk && testOk && protectedFilesOk && immutableKernelOk;

    if (passed) {
      console.log('[guardrails] postCheck: all checks passed');
    } else {
      // #31: Auto-rollback on postCheck failure (build failure or immutable file modification)
      if ((!buildOk || !immutableKernelOk) && existsSync(join(cwd, '.git'))) {
        try {
          new GitOps(cwd).checkoutAll();
          console.log(`[guardrails] postCheck: auto-rollback executed (git checkout -- .) in ${cwd}`);
        } catch (rollbackErr: any) {
          console.error(`[guardrails] postCheck: auto-rollback failed: ${rollbackErr.message}`);
        }
      }
    }

    return { passed, buildOk, testOk, protectedFilesOk, immutableKernelOk, error };
  }

  /**
   * Sanitize error messages to prevent leaking sensitive paths or excessive output.
   * Truncates to 500 chars and strips common absolute path prefixes.
   */
  private sanitizeError(message: string): string {
    // Strip absolute paths (Windows and Unix) to prevent leaking directory structure
    let sanitized = message
      .replace(/[A-Z]:\\[\w\\.-]+/gi, '<path>')
      .replace(/\/(?:home|Users|var|tmp|opt)\/[\w/.-]+/g, '<path>');

    // Truncate to prevent oversized error messages
    if (sanitized.length > 500) {
      sanitized = sanitized.slice(0, 497) + '...';
    }

    return sanitized;
  }

  // ── Approval / Rejection ──

  approveChange(id: string, reviewedBy?: string): PendingChange | null {
    const change = this.pending.find(p => p.id === id);
    if (!change || change.status !== 'pending') return null;

    change.status = 'approved';
    change.reviewedAt = Date.now();
    change.reviewedBy = reviewedBy;
    this.savePending();

    // Record the change for rate limiting
    this.recordChange();

    console.log(`[guardrails] Change approved: ${id.slice(0, 8)} — ${change.description}`);
    return change;
  }

  rejectChange(id: string, rejectReason?: string, reviewedBy?: string): PendingChange | null {
    const change = this.pending.find(p => p.id === id);
    if (!change || change.status !== 'pending') return null;

    change.status = 'rejected';
    change.reviewedAt = Date.now();
    change.reviewedBy = reviewedBy;
    change.rejectReason = rejectReason;
    this.savePending();

    console.log(`[guardrails] Change rejected: ${id.slice(0, 8)} — ${rejectReason || 'no reason'}`);
    return change;
  }

  // ── Rate Limiting ──

  private checkRateLimits(): { allowed: boolean; reason: string } {
    const now = Date.now();

    // Prune old timestamps
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    this.changeTimestamps = this.changeTimestamps.filter(t => t > oneDayAgo);

    // Check hourly limit
    const changesThisHour = this.changeTimestamps.filter(t => t > oneHourAgo).length;
    if (changesThisHour >= this.config.maxSelfChangesPerHour) {
      return {
        allowed: false,
        reason: `Hourly rate limit reached: ${changesThisHour}/${this.config.maxSelfChangesPerHour} changes this hour.`,
      };
    }

    // Check daily limit
    const changesToday = this.changeTimestamps.length;
    if (changesToday >= this.config.maxSelfChangesPerDay) {
      return {
        allowed: false,
        reason: `Daily rate limit reached: ${changesToday}/${this.config.maxSelfChangesPerDay} changes today.`,
      };
    }

    return { allowed: true, reason: 'Within rate limits.' };
  }

  private recordChange(): void {
    this.changeTimestamps.push(Date.now());
  }

  /**
   * Get current rate limit usage.
   */
  getRateLimitStatus(): {
    changesThisHour: number;
    maxPerHour: number;
    changesToday: number;
    maxPerDay: number;
  } {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    this.changeTimestamps = this.changeTimestamps.filter(t => t > oneDayAgo);

    return {
      changesThisHour: this.changeTimestamps.filter(t => t > oneHourAgo).length,
      maxPerHour: this.config.maxSelfChangesPerHour,
      changesToday: this.changeTimestamps.length,
      maxPerDay: this.config.maxSelfChangesPerDay,
    };
  }

  // ── Protected Path Detection ──

  /**
   * Return which of the given file paths are protected.
   */
  getProtectedFiles(filePaths: string[]): string[] {
    return filePaths.filter(fp => this.isProtected(fp));
  }

  /**
   * Check if a single file path matches any protected path pattern.
   * Protected paths can be directories (ending with /) or exact files.
   */
  isProtected(filePath: string): boolean {
    // Normalize path separators
    const normalized = filePath.replace(/\\/g, '/');

    for (const pp of this.config.protectedPaths) {
      const normalizedPP = pp.replace(/\\/g, '/');
      if (normalizedPP.endsWith('/')) {
        // Directory match — check if file is under this directory
        if (normalized.startsWith(normalizedPP) || normalized.includes(`/${normalizedPP}`)) {
          return true;
        }
      } else {
        // Exact file match
        if (normalized === normalizedPP || normalized.endsWith(`/${normalizedPP}`)) {
          return true;
        }
      }
    }
    return false;
  }

  // ── Status ──

  /**
   * Get full guardrails status — config, rate limits, pending count.
   */
  getStatus(): {
    config: GuardrailConfig;
    rateLimit: ReturnType<Guardrails['getRateLimitStatus']>;
    pendingCount: number;
    protectedPathCount: number;
  } {
    return {
      config: this.getConfig(),
      rateLimit: this.getRateLimitStatus(),
      pendingCount: this.getPending().length,
      protectedPathCount: this.config.protectedPaths.length,
    };
  }

  // ── Tiered Guardrails (Phase 16) ─────────────────────────────────────────

  /**
   * Determine the guardrail tier for a given file path.
   * Matches against the pathToTier mapping; defaults to 'Low' for unmatched paths.
   */
  getTier(filePath: string): GuardrailTier {
    const normalized = filePath.replace(/\\/g, '/');

    for (const [pattern, tier] of Object.entries(this.tieredConfig.pathToTier)) {
      if (pattern.endsWith('/')) {
        // Directory pattern — match if the path contains this directory segment
        if (normalized.includes(pattern) || normalized.includes(`/${pattern}`)) {
          return tier;
        }
      } else {
        // File pattern — match if path ends with this filename
        if (normalized.endsWith(`/${pattern}`) || normalized === pattern) {
          return tier;
        }
      }
    }

    return 'Low';
  }

  /**
   * Get the tier requirements for a given guardrail tier.
   */
  getRequirements(tier: GuardrailTier): TierRequirements {
    return { ...this.tieredConfig.tiers[tier] };
  }

  /**
   * Check whether a file path is part of the immutable kernel.
   * Immutable kernel files must NEVER be modified by the autonomous pipeline.
   *
   * Checks against both the short-name list (tieredConfig) and the
   * full-path IMMUTABLE_KERNEL_FILES constant (Phase 12.7).
   */
  isImmutableKernel(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');

    // Check short-name list (backward compatible)
    const shortMatch = this.tieredConfig.immutableKernel.some(
      kernelFile => normalized.endsWith(`/${kernelFile}`) || normalized === kernelFile,
    );
    if (shortMatch) return true;

    // Check full-path list (Phase 12.7)
    return IMMUTABLE_KERNEL_FILES.some(
      kernelPath => normalized.endsWith(kernelPath) || normalized.includes(kernelPath),
    );
  }

  /**
   * Get the explanation for why a file is immutable.
   * Returns null if the file is not immutable.
   */
  getImmutableReason(filePath: string): string | null {
    if (!this.isImmutableKernel(filePath)) return null;

    const normalized = filePath.replace(/\\/g, '/');

    if (normalized.includes('crypto.ts')) {
      return 'crypto.ts: Core cryptographic identity system — modification could compromise all node identities.';
    }
    if (normalized.includes('guardrails.ts')) {
      return 'guardrails.ts: Safety enforcement system — modification could disable all safety checks.';
    }
    if (normalized.includes('governance.ts')) {
      return 'governance.ts: Core voting logic — modification could compromise democratic decision-making.';
    }
    if (normalized.includes('transactions.ts')) {
      return 'transactions.ts: Consensus rules for Lux transfers — modification could enable theft or inflation.';
    }
    if (normalized.includes('code-pipeline.ts')) {
      return 'code-pipeline.ts: Autonomous code application — modification could enable unrestricted code changes.';
    }
    if (normalized.includes('deploy-manager.ts')) {
      return 'deploy-manager.ts: Deployment system — modification could enable unauthorized deployments.';
    }
    if (normalized.includes('identity.ts')) {
      return 'identity.ts: Node identity management — modification could enable identity spoofing.';
    }

    return 'This file is part of the immutable kernel and cannot be modified by the autonomous pipeline.';
  }

  /**
   * Tiered pre-check for the autonomous code pipeline.
   * Evaluates proposed changes against tier-specific requirements.
   * This is ADDITIVE — the existing preCheck() method remains unchanged.
   *
   * Returns an object with:
   * - allowed: true if the change can proceed immediately
   * - reason: explanation if blocked
   * - tier: the highest (most restrictive) tier among the affected files
   * - requirements: the tier requirements that apply
   */
  tieredPreCheck(
    filePaths: string[],
    description: string,
    governanceApproved?: boolean,
  ): {
    allowed: boolean;
    reason: string;
    tier: GuardrailTier;
    requirements: TierRequirements;
    immutableViolations: string[];
    protectedPathViolations: string[];
  } {
    // 0. Input validation — reject empty or invalid inputs
    if (!filePaths || filePaths.length === 0) {
      return {
        allowed: false,
        reason: 'No file paths provided — cannot evaluate guardrail checks.',
        tier: 'Low',
        requirements: this.getRequirements('Low'),
        immutableViolations: [],
        protectedPathViolations: [],
      };
    }

    const invalidPaths = filePaths.filter(fp => typeof fp !== 'string' || fp.trim() === '');
    if (invalidPaths.length > 0) {
      return {
        allowed: false,
        reason: `Invalid file paths detected: ${invalidPaths.length} path(s) are empty or non-string.`,
        tier: 'Low',
        requirements: this.getRequirements('Low'),
        immutableViolations: [],
        protectedPathViolations: [],
      };
    }

    // 1. Check for immutable kernel violations
    const immutableViolations = filePaths.filter(fp => this.isImmutableKernel(fp));
    if (immutableViolations.length > 0) {
      const highestTier = 'Critical' as GuardrailTier;
      return {
        allowed: false,
        reason: `Immutable kernel files cannot be modified: ${immutableViolations.join(', ')}`,
        tier: highestTier,
        requirements: this.getRequirements(highestTier),
        immutableViolations,
        protectedPathViolations: [],
      };
    }

    // 2. Check protected paths from base config
    // Governance-approved changes bypass protected path restrictions (voting IS the approval)
    const protectedPathViolations = this.getProtectedFiles(filePaths);
    if (!governanceApproved && protectedPathViolations.length > 0 && this.config.requireApprovalForCore) {
      return {
        allowed: false,
        reason: `Protected paths require approval: ${protectedPathViolations.join(', ')}`,
        tier: 'Critical',
        requirements: this.getRequirements('Critical'),
        immutableViolations: [],
        protectedPathViolations,
      };
    }

    // 3. Check global rate limits (hourly + daily from base config)
    // Governance-approved changes bypass global rate limits (voting period IS rate control)
    if (!governanceApproved) {
      const globalRateResult = this.checkRateLimits();
      if (!globalRateResult.allowed) {
        return {
          allowed: false,
          reason: globalRateResult.reason,
          tier: 'Low',
          requirements: this.getRequirements('Low'),
          immutableViolations: [],
          protectedPathViolations: [],
        };
      }
    }

    // 4. Determine the highest (most restrictive) tier among all affected files
    const tierOrder: GuardrailTier[] = ['Critical', 'Important', 'Standard', 'Low'];
    let highestTierIndex = tierOrder.length - 1; // Start at 'Low'

    for (const fp of filePaths) {
      const tier = this.getTier(fp);
      const tierIndex = tierOrder.indexOf(tier);
      if (tierIndex < highestTierIndex) {
        highestTierIndex = tierIndex;
      }
    }

    const effectiveTier = tierOrder[highestTierIndex];
    const requirements = this.getRequirements(effectiveTier);

    // Log governance bypass when applicable
    if (governanceApproved) {
      console.log(`[guardrails] tieredPreCheck: governance-approved bypass for tier "${effectiveTier}" — ${filePaths.length} file(s)`);
    }

    // 5. Check tier-specific rate limits
    // Governance-approved changes bypass tier rate limits
    if (!governanceApproved) {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const recentChanges = this.changeTimestamps.filter(t => t > oneHourAgo).length;

      if (recentChanges >= requirements.maxChangesPerHour) {
        return {
          allowed: false,
          reason: `Tier "${effectiveTier}" rate limit reached: ${recentChanges}/${requirements.maxChangesPerHour} changes this hour. ${description}`,
          tier: effectiveTier,
          requirements,
          immutableViolations: [],
          protectedPathViolations: [],
        };
      }
    }

    // 6. Enforce tier cooldown — check time since last change
    // Governance-approved changes bypass cooldown
    if (!governanceApproved && this.changeTimestamps.length > 0) {
      const now = Date.now();
      const lastChangeAt = this.changeTimestamps[this.changeTimestamps.length - 1];
      const elapsed = now - lastChangeAt;
      if (elapsed < requirements.cooldownMs) {
        const remainingMs = requirements.cooldownMs - elapsed;
        const remainingSec = Math.ceil(remainingMs / 1000);
        return {
          allowed: false,
          reason: `Tier "${effectiveTier}" cooldown active: ${remainingSec}s remaining before next change is allowed.`,
          tier: effectiveTier,
          requirements,
          immutableViolations: [],
          protectedPathViolations: [],
        };
      }
    }

    // 7. If approval is required for this tier, block with explanation
    // Governance-approved changes bypass approval requirement (governance IS the approval)
    if (requirements.requiresApproval && !governanceApproved) {
      return {
        allowed: false,
        reason: `Tier "${effectiveTier}" requires approval for changes to: ${filePaths.join(', ')}`,
        tier: effectiveTier,
        requirements,
        immutableViolations: [],
        protectedPathViolations: [],
      };
    }

    // 8. Allowed
    console.log(`[guardrails] tieredPreCheck: allowed under tier "${effectiveTier}" — ${filePaths.length} file(s), ${description}`);
    return {
      allowed: true,
      reason: `Change permitted under tier "${effectiveTier}".`,
      tier: effectiveTier,
      requirements,
      immutableViolations: [],
      protectedPathViolations: [],
    };
  }
}
