/**
 * Upgrade Protocol — Phase 82: Simple Git Pull + Hash Verification (E2E verified 2026-02-28)
 *
 * Governance approves upgrade → broadcasts commit hash via GossipSub →
 * all nodes: git pull → verify hash → build → restart. That's it.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type {
  UpgradeProposal,
  RiskAssessment,
  UpgradeRecord,
  UpgradeStatus,
  ReviewResult,
  UpgradeQuorumResult,
  UpgradePayload,
} from '@pando/shared';
import type { GovernanceSync } from '../kernel/governance.js';
import type { PandoNetwork } from '../kernel/network.js';
import type { DeployManager } from './deploy-manager.js';
import type { Guardrails } from '../kernel/guardrails.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Standard review period: 24 hours */
const STANDARD_REVIEW_MS = 24 * 60 * 60 * 1000;
/** Protocol change review period: 72 hours */
const PROTOCOL_REVIEW_MS = 72 * 60 * 60 * 1000;
/** Emergency rollback vote period: 1 hour */
const EMERGENCY_VOTE_MS = 60 * 60 * 1000;
/** Upgrade quorum: 60% of voters */
const UPGRADE_QUORUM = 0.60;
/** Upgrade approve margin: 2:1 */
const UPGRADE_APPROVE_MARGIN = 2.0;
/** Maximum stored upgrade history entries */
const MAX_HISTORY = 200;

export const TOPIC_UPGRADES = 'pando/upgrades';
const RESTART_EXIT_CODE = 75;

/** Stash uncommitted changes before destructive git reset. */
export function safeGitReset(repoDir: string, target: string = 'origin/master'): void {
  // Check for local commits not yet pushed to origin — skip reset entirely to avoid destroying unpushed work
  try {
    const countStr = execSync('git rev-list origin/master..HEAD --count', {
      cwd: repoDir, encoding: 'utf-8', timeout: 10_000, stdio: 'pipe',
    }).trim();
    const count = parseInt(countStr, 10);
    if (count > 0) {
      console.warn(`[upgrade] Upgrade: skipping reset — local commits not yet pushed to origin (${count} commit(s) ahead)`);
      return;
    }
  } catch (checkErr: any) {
    console.warn(`[upgrade] Could not check for unpushed commits (${checkErr.message?.slice(0, 100)}) — proceeding.`);
  }

  const status = execSync('git status --porcelain', {
    cwd: repoDir, encoding: 'utf-8', timeout: 10_000, stdio: 'pipe',
  }).trim();

  if (status.length > 0) {
    console.warn(`[upgrade] WARNING: Uncommitted changes detected (${status.split('\n').length} files). Stashing...`);
    try {
      execSync(`git stash push -m "pando-auto-stash-${Date.now()}"`, {
        cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe', windowsHide: true,
      });
      console.warn('[upgrade] Changes stashed. Recover with: git stash pop');
    } catch (stashErr: any) {
      console.warn(`[upgrade] Stash failed (${stashErr.message}). Proceeding with reset.`);
    }
  }

  execSync(`git reset --hard ${target}`, {
    cwd: repoDir, encoding: 'utf-8', timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
}

// ── File patterns considered "protocol changes" (longer review) ──

const PROTOCOL_FILE_PATTERNS = [
  'network.ts',
  'sync.ts',
  'governance.ts',
  'types.ts',
  'crypto.ts',
];

// ── UpgradeProtocol Class ──────────────────────────────────────────────────

export interface UpgradeProtocolDeps {
  governance: GovernanceSync;
  guardrails: Guardrails;
  dataDir: string;
  repoDir: string;
  localPeerId: string;
  /** Optional: deploy manager for backup/rollback */
  deployManagerProvider?: () => DeployManager | null;
  /** Optional: network for peer count */
  networkProvider?: () => PandoNetwork | null;
  /** Returns number of active workers — safe restart requires 0 */
  workersActiveFn?: () => number;
  /** Returns true if unread messages exist — safe restart requires false */
  messagesPendingFn?: () => boolean;
}

export class UpgradeProtocol {
  private governance: GovernanceSync;
  private guardrails: Guardrails;
  private dataDir: string;
  private repoDir: string;
  private localPeerId: string;
  private deployManagerProvider: () => DeployManager | null;
  private networkProvider: () => PandoNetwork | null;

  // State
  private proposals: Map<string, UpgradeProposal> = new Map();
  private history: UpgradeRecord[] = [];
  private pinnedVersion: string | null = null;
  private appliedProposalIds: Set<string> = new Set();

  // Broadcast callback — set by PandoNode to publish to GossipSub
  private broadcastFn: ((msg: Record<string, unknown>) => Promise<void>) | null = null;

  // Persistence
  private statePath: string;

  // Restart callback — set by PandoNode
  private requestRestartFn: ((reason?: string) => void) | null = null;

  // Safe restart callbacks
  private workersActiveFn: () => number;
  private messagesPendingFn: () => boolean;

  // Commit hash that was running when this process started
  private runningCommit: string;

  constructor(deps: UpgradeProtocolDeps) {
    this.governance = deps.governance;
    this.guardrails = deps.guardrails;
    this.dataDir = deps.dataDir;
    this.repoDir = deps.repoDir;
    this.localPeerId = deps.localPeerId;
    this.deployManagerProvider = deps.deployManagerProvider || (() => null);
    this.networkProvider = deps.networkProvider || (() => null);
    this.workersActiveFn = deps.workersActiveFn || (() => 0);
    this.messagesPendingFn = deps.messagesPendingFn || (() => false);

    // Snapshot the git HEAD at startup — used to detect stale compiled code after self-commits
    try {
      this.runningCommit = execSync('git rev-parse HEAD', {
        cwd: deps.repoDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe',
      }).trim();
      console.log(`[upgrade] Running commit: ${this.runningCommit.slice(0, 8)}`);
    } catch {
      this.runningCommit = 'unknown';
    }

    // Ensure upgrade state directory
    const upgradeDir = join(this.dataDir, 'upgrade-protocol');
    if (!existsSync(upgradeDir)) {
      mkdirSync(upgradeDir, { recursive: true });
    }
    this.statePath = join(upgradeDir, 'state.json');

    this.loadState();
  }

  // ── Wiring (called by PandoNode) ──────────────────────────────────────

  setBroadcast(fn: (msg: Record<string, unknown>) => Promise<void>): void {
    this.broadcastFn = fn;
  }

  setRequestRestart(fn: (reason?: string) => void): void {
    this.requestRestartFn = fn;
  }

  /**
   * Attempt a safe restart. Exits with RESTART_EXIT_CODE (75) only when:
   * - 0 active workers (no Claude Code sessions in progress)
   * - 0 unread messages in MessageBus (no requests in-flight)
   *
   * If not safe, logs a warning and returns — the next upgrade cycle will retry.
   * NEVER call process.exit() if workers are active: kills running Claude Code sessions.
   */
  private safeRestart(builtCommit: string): void {
    // Guard: if the built commit matches the running commit, no restart needed
    if (builtCommit === this.runningCommit) {
      console.log(`[upgrade] Built commit matches running commit (${builtCommit.slice(0, 8)}) — no restart needed`);
      return;
    }

    const activeWorkers = this.workersActiveFn();
    const messagesPending = this.messagesPendingFn();

    if (activeWorkers > 0) {
      console.warn(`[upgrade] Safe restart deferred: ${activeWorkers} active worker(s) — will retry next cycle`);
      return;
    }
    if (messagesPending) {
      console.warn(`[upgrade] Safe restart deferred: unprocessed messages in-flight — will retry next cycle`);
      return;
    }

    console.log(`[upgrade] Safe restart triggered: built ${builtCommit.slice(0, 8)}, was running ${this.runningCommit.slice(0, 8)}`);
    if (this.requestRestartFn) {
      this.requestRestartFn('safe-upgrade');
    } else {
      setTimeout(() => { process.exit(RESTART_EXIT_CODE); }, 500);
    }
  }

  hasApplied(proposalId: string): boolean {
    return this.appliedProposalIds.has(proposalId);
  }

  findByGovernanceId(governanceId: string): UpgradeProposal | undefined {
    for (const p of this.proposals.values()) {
      if (p.governanceProposalId === governanceId) return p;
    }
    return undefined;
  }

  // ── Core: Git Pull + Hash Verification ──────────────────────────────────

  /**
   * Pull latest code from origin, verify commit hash, build, and restart.
   * This is the ONE upgrade path. No patches, no canary, no complexity.
   */
  async pullAndUpgrade(commitHash?: string): Promise<{ success: boolean; message: string }> {
    if (this.pinnedVersion) {
      return { success: false, message: `Version pinned to ${this.pinnedVersion}. Unpin first.` };
    }

    const repoDir = this.repoDir;

    // Step 0: If local HEAD already matches target hash, we're the proposer — skip pull
    if (commitHash) {
      try {
        const localSha = this.git('rev-parse HEAD');
        if (localSha.startsWith(commitHash) || commitHash.startsWith(localSha.slice(0, commitHash.length))) {
          console.log(`[upgrade] Already at target version ${commitHash.slice(0, 8)} — skipping pull.`);
          // Proposer node: dist/ was rebuilt by asyncOnCommit but running process uses stale in-memory code
          if (this.runningCommit !== 'unknown' && this.runningCommit !== localSha) {
            console.log(`[upgrade] Proposer node stale: running ${this.runningCommit.slice(0, 8)}, built ${localSha.slice(0, 8)} — triggering safe restart`);
            this.safeRestart(localSha);
          }
          return { success: true, message: 'Already at target version.' };
        }
      } catch {}
    }

    // Step 1: Ensure git safe.directory
    try {
      execSync(`git config --global --add safe.directory ${repoDir}`, {
        cwd: repoDir, timeout: 5_000, stdio: 'pipe', windowsHide: true,
      });
    } catch {}

    // Step 2: Fetch latest
    console.log('[upgrade] Fetching latest code...');
    try {
      execSync('git fetch origin master', {
        cwd: repoDir, encoding: 'utf-8', timeout: 60_000,
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (err: any) {
      const msg = err.stderr?.toString()?.slice(0, 500) || err.message;
      console.error(`[upgrade] Git fetch failed: ${msg}`);
      return { success: false, message: `Git fetch failed: ${msg}` };
    }

    // Step 3: Check if already up to date
    const localSha = this.git('rev-parse HEAD');
    const remoteSha = this.git('rev-parse origin/master');

    if (localSha === remoteSha) {
      console.log('[upgrade] Already up to date.');
      // Proposer node: source matches origin but dist may be stale (self-commit scenario).
      // If the running commit differs from current HEAD, we built new code — restart safely.
      if (this.runningCommit !== 'unknown' && this.runningCommit !== localSha) {
        console.log(`[upgrade] Stale dist detected: running ${this.runningCommit.slice(0, 8)}, source is now ${localSha.slice(0, 8)} — checking safe restart`);
        this.safeRestart(localSha);
      }
      return { success: true, message: 'Already up to date.' };
    }

    // Step 4: Verify commit hash if provided (governance-approved hash)
    // Soft check only — orphan branch pushes produce different hashes, so log warning but proceed
    if (commitHash && remoteSha !== commitHash && !remoteSha.startsWith(commitHash) && !commitHash.startsWith(remoteSha.slice(0, commitHash.length))) {
      // Check if proposed commit is an ancestor of origin/master (already incorporated)
      try {
        this.git(`merge-base --is-ancestor ${commitHash} origin/master`);
        console.log(`[upgrade] Proposed commit ${commitHash.slice(0, 12)} is ancestor of origin/master (${remoteSha.slice(0, 12)}) — upgrading to latest`);
      } catch {
        console.error(`[upgrade] Hash mismatch: governance approved ${commitHash.slice(0, 12)}, but origin/master is ${remoteSha.slice(0, 12)} and commit is not an ancestor — aborting upgrade`);
        return { success: false, message: `Hash mismatch: governance approved ${commitHash} but origin/master is ${remoteSha}` };
      }
    }

    // Step 5: Reset to origin/master (stash uncommitted changes first)
    console.log(`[upgrade] Updating ${localSha.slice(0, 8)} → ${remoteSha.slice(0, 8)}`);
    try {
      safeGitReset(repoDir, 'origin/master');
    } catch (err: any) {
      const msg = err.stderr?.toString()?.slice(0, 500) || err.message;
      console.error(`[upgrade] Git reset failed: ${msg}`);
      return { success: false, message: `Git reset failed: ${msg}` };
    }

    // Step 5b: If HEAD didn't move (safeGitReset skipped), mark applied without restart
    const headAfterReset = this.git('rev-parse HEAD');
    if (headAfterReset === localSha && localSha === this.runningCommit) {
      console.log(`[upgrade] HEAD unchanged after reset (local ahead) — marking ${(commitHash || remoteSha).slice(0, 8)} as applied, no restart needed`);
      const proposalId = commitHash || remoteSha;
      this.appliedProposalIds.add(proposalId);
      this.recordUpgrade(proposalId, 'success');
      this.saveState();
      return { success: true, message: 'Already incorporated (local ahead of origin).' };
    }

    // Step 6: Build
    console.log('[upgrade] Building...');
    try {
      execSync('npm run build', {
        cwd: repoDir, timeout: 180_000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (err: any) {
      const stderr = err.stderr?.toString()?.slice(-500) || err.message;
      console.error(`[upgrade] Build FAILED: ${stderr}`);
      // Rollback to previous commit
      try { execSync(`git reset --hard ${localSha}`, { cwd: repoDir, timeout: 10_000, stdio: 'pipe', windowsHide: true }); } catch {}
      return { success: false, message: `Build failed: ${stderr}` };
    }

    console.log('[upgrade] Build passed.');

    // Step 7: Record success and attempt safe restart
    const proposalId = commitHash || remoteSha;
    this.appliedProposalIds.add(proposalId);
    this.recordUpgrade(proposalId, 'success');
    this.saveState();

    const actualHead = this.git('rev-parse HEAD');
    this.safeRestart(actualHead);

    return { success: true, message: `Updated to ${actualHead.slice(0, 8)}. Restarting...` };
  }

  // ── Upgrade Proposal (for governance) ──────────────────────────────────

  /**
   * Create an upgrade proposal. Submits to governance with the remote HEAD commit hash.
   * Fetches origin/master first so the proposal targets the latest remote code, not local HEAD.
   * No diffs, no patches — just a description and a hash for peers to verify.
   */
  async createUpgradeProposal(description: string): Promise<UpgradeProposal> {
    // Fetch remote state first so we propose the remote HEAD, not local HEAD.
    // This ensures all nodes actually pull new code rather than seeing "already at target".
    try {
      this.git('fetch origin master');
    } catch (e) {
      console.warn('[upgrade] git fetch failed — proposal will use local HEAD:', e);
    }
    const commitHash = this.getRemoteVersion();
    const filesTouched = this.getRecentFilesTouched();

    // Check immutable kernel
    const kernelViolations = filesTouched.filter((fp) =>
      this.guardrails.isImmutableKernel(fp),
    );
    if (kernelViolations.length > 0) {
      throw new Error(
        `Upgrade proposal rejected: touches immutable kernel files: ${kernelViolations.join(', ')}`,
      );
    }

    const riskAssessment = this.assessRisk(filesTouched);

    const isProtocolChange = filesTouched.some((fp) =>
      PROTOCOL_FILE_PATTERNS.some(
        (pattern) => fp.endsWith(pattern) || fp.includes(`/${pattern}`),
      ),
    );
    const reviewPeriodMs = isProtocolChange ? PROTOCOL_REVIEW_MS : STANDARD_REVIEW_MS;

    const proposalId = createHash('sha256')
      .update(`upgrade:${this.localPeerId}:${Date.now()}:${randomBytes(8).toString('hex')}`)
      .digest('hex');

    const proposal: UpgradeProposal = {
      proposalId,
      commitHash,
      description,
      riskAssessment,
      reviewPeriodMs,
      proposerPeerId: this.localPeerId,
      status: 'proposed',
      createdAt: Date.now(),
    };

    // Store proposal FIRST so findByGovernanceId works when auto-approve callback fires
    this.proposals.set(proposalId, proposal);

    const upgradePayload: UpgradePayload = {
      commitHash,
      description,
      filesTouched,
    };

    try {
      const govProposal = await this.governance.createProposal(
        `[Upgrade] ${description}`,
        `Code upgrade proposal:\n\n${description}\n\nCommit: ${commitHash}\nRisk level: ${riskAssessment.riskLevel}\nFiles touched: ${filesTouched.length}\nReview period: ${reviewPeriodMs / 3600000}h`,
        reviewPeriodMs,
        { category: 'upgrade', upgradePayload },
      );
      proposal.governanceProposalId = govProposal.id;
    } catch (err: any) {
      console.error(`[upgrade-protocol] Failed to create governance proposal: ${err.message}`);
    }

    this.saveState();
    console.log(
      `[upgrade-protocol] Proposal created: ${proposalId.slice(0, 8)} — ${description} (commit: ${commitHash}, risk: ${riskAssessment.riskLevel})`,
    );

    return proposal;
  }

  /**
   * Broadcast upgrade notification to all peers.
   * Called after governance approves and local node upgrades successfully.
   */
  async broadcastUpgradeNotification(commitHash: string, description: string, governanceId?: string): Promise<void> {
    if (!this.broadcastFn) {
      console.warn('[upgrade-protocol] No broadcast function set — cannot notify peers');
      return;
    }
    await this.broadcastFn({
      type: 'upgrade_available',
      commitHash,
      description,
      governanceId,
      fromPeerId: this.localPeerId,
      timestamp: Date.now(),
    });
    const network = this.networkProvider();
    const peerCount = network?.getPeerCount() ?? 0;
    console.log(`[upgrade-protocol] Broadcast upgrade notification to ${peerCount} peer(s): commit ${commitHash.slice(0, 8)}`);
  }

  // ── Governance Integration ──────────────────────────────────────────────

  checkUpgradeQuorum(proposalId: string): UpgradeQuorumResult {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || !proposal.governanceProposalId) {
      return { reached: false, approveWeight: 0, rejectWeight: 0, margin: 0 };
    }

    const votes = this.governance.getVotes(proposal.governanceProposalId);
    const network = this.networkProvider();
    const peerCount = network ? network.getPeerCount() : 0;
    const totalVoters = peerCount + 1;

    let approveWeight = 0;
    let rejectWeight = 0;
    for (const vote of votes) {
      if (vote.choice === 'approve') approveWeight++;
      else if (vote.choice === 'reject') rejectWeight++;
    }

    const totalVotes = approveWeight + rejectWeight;
    const quorumReached = totalVoters > 0
      ? totalVotes / totalVoters >= UPGRADE_QUORUM
      : totalVotes >= 1;

    const margin = rejectWeight > 0 ? approveWeight / rejectWeight : (approveWeight > 0 ? Infinity : 0);
    const marginMet = margin >= UPGRADE_APPROVE_MARGIN;
    const reached = quorumReached && marginMet;

    if (reached && proposal.status === 'reviewing') {
      proposal.status = 'voting';
      this.saveState();
    }

    return {
      reached,
      approveWeight,
      rejectWeight,
      margin: margin === Infinity ? 999 : Math.round(margin * 100) / 100,
    };
  }

  // ── Version Pinning ──────────────────────────────────────────────────

  pinVersion(version: string): void {
    this.pinnedVersion = version;
    this.saveState();
    console.log(`[upgrade-protocol] Version pinned to ${version}`);
  }

  unpinVersion(): void {
    const prev = this.pinnedVersion;
    this.pinnedVersion = null;
    this.saveState();
    console.log(`[upgrade-protocol] Version unpinned (was: ${prev})`);
  }

  isPinned(): boolean {
    return this.pinnedVersion !== null;
  }

  // ── Emergency Rollback ──────────────────────────────────────────────────

  proposeEmergencyRollback(reason: string): void {
    console.log(`[upgrade-protocol] Emergency rollback proposed: ${reason}`);
    this.governance
      .createProposal(
        `[EMERGENCY ROLLBACK] ${reason}`,
        `Emergency rollback requested.\n\nReason: ${reason}\n\nThis proposal has a 1-hour fast-track vote period.`,
        EMERGENCY_VOTE_MS,
      )
      .then((govProposal) => {
        console.log(`[upgrade-protocol] Emergency rollback proposal created: ${govProposal.id.slice(0, 8)}`);
      })
      .catch((err: any) => {
        console.error(`[upgrade-protocol] Failed to create emergency rollback proposal: ${err.message}`);
      });
  }

  async executeRollback(targetVersion?: string): Promise<{ success: boolean; message: string }> {
    console.log(`[upgrade-protocol] Executing rollback${targetVersion ? ` to ${targetVersion}` : ''}...`);

    const deployManager = this.deployManagerProvider();
    if (deployManager) {
      const status = deployManager.getDeployStatus();
      if (status.backupExists) {
        const result = deployManager.restoreBackup();
        if (result.success) {
          try {
            execSync('npm run build', { cwd: this.repoDir, timeout: 180_000, stdio: 'pipe', windowsHide: true });
            console.log('[upgrade-protocol] Rollback + rebuild successful.');
            return { success: true, message: `Rolled back from backup: ${result.message}` };
          } catch (err: any) {
            return { success: false, message: `Backup restored but rebuild failed: ${err.message}` };
          }
        }
      }
    }

    try {
      if (targetVersion) {
        this.git(`checkout ${targetVersion} -- packages/`);
      } else {
        this.git('checkout HEAD -- packages/');
      }
      execSync('npm run build', { cwd: this.repoDir, timeout: 180_000, stdio: 'pipe', windowsHide: true });
      console.log('[upgrade-protocol] Git-based rollback successful.');
      return { success: true, message: 'Rolled back via git checkout.' };
    } catch (err: any) {
      return { success: false, message: `Rollback failed: ${err.message}` };
    }
  }

  // ── Status & History ────────────────────────────────────────────────────

  getUpgradeStatus(): UpgradeStatus {
    const currentVersion = this.getCurrentVersion();
    const activeUpgrade = Array.from(this.proposals.values()).find(
      (p) => p.status !== 'deployed' && p.status !== 'rejected' && p.status !== 'rolled_back',
    );
    return {
      currentVersion,
      pinnedVersion: this.pinnedVersion || undefined,
      activeUpgrade,
      lastUpgrade: this.history.length > 0 ? this.history[0] : undefined,
    };
  }

  getUpgradeHistory(): UpgradeRecord[] {
    return [...this.history];
  }

  getProposal(proposalId: string): UpgradeProposal | undefined {
    return this.proposals.get(proposalId);
  }

  getProposals(): UpgradeProposal[] {
    return Array.from(this.proposals.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Periodically scan governance for passed upgrade proposals this node hasn't applied.
   * Handles the case where the proposing node goes offline before broadcasting.
   * Every node independently catches up — no dependency on the proposer.
   */
  private catchupTimer: ReturnType<typeof setInterval> | null = null;
  private static CATCHUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private static CATCHUP_STARTUP_DELAY_MS = 30 * 1000; // 30s after boot

  startCatchupTimer(pullAndUpgradeFn: (commitHash: string) => Promise<{ success: boolean; message: string }>): void {
    // Initial check 30s after startup
    setTimeout(() => this.checkForMissedUpgrades(pullAndUpgradeFn), UpgradeProtocol.CATCHUP_STARTUP_DELAY_MS);

    // Then every 5 minutes
    this.catchupTimer = setInterval(
      () => this.checkForMissedUpgrades(pullAndUpgradeFn),
      UpgradeProtocol.CATCHUP_INTERVAL_MS,
    );
  }

  private async checkForMissedUpgrades(
    pullAndUpgradeFn: (commitHash: string) => Promise<{ success: boolean; message: string }>,
  ): Promise<void> {
    try {
      const proposals = this.governance.getProposals();
      const currentVersion = this.getCurrentVersion();

      for (const p of proposals) {
        if (p.status !== 'passed' || p.category !== 'upgrade') continue;
        const commitHash = p.upgradePayload?.commitHash;
        if (!commitHash) continue;
        // Skip if already applied or if we're already at this version
        if (this.hasApplied(commitHash)) continue;
        if (currentVersion.startsWith(commitHash) || commitHash.startsWith(currentVersion.slice(0, commitHash.length))) continue;
        // Skip if this commit is already in our git history (ancestor of HEAD)
        try {
          this.git(`merge-base --is-ancestor ${commitHash} HEAD`);
          this.appliedProposalIds.add(commitHash);
          this.saveState();
          continue;
        } catch { /* not an ancestor — proceed with upgrade */ }
        // Skip if pinned
        if (this.pinnedVersion) continue;

        console.log(`[upgrade] Catch-up: found unapplied upgrade ${commitHash.slice(0, 8)} — ${p.title?.slice(0, 50)}`);
        const result = await pullAndUpgradeFn(commitHash);
        if (result.success) {
          console.log(`[upgrade] Catch-up: upgrade ${commitHash.slice(0, 8)} applied successfully`);
          // Broadcast to any peers who also missed it
          await this.broadcastUpgradeNotification(
            commitHash,
            p.upgradePayload?.description || p.title || '',
            p.id,
          );
          return; // One upgrade at a time
        } else {
          console.warn(`[upgrade] Catch-up: upgrade ${commitHash.slice(0, 8)} failed: ${result.message}`);
        }
      }
    } catch (err: any) {
      console.error(`[upgrade] Catch-up check failed: ${err.message}`);
    }
  }

  stop(): void {
    if (this.catchupTimer) {
      clearInterval(this.catchupTimer);
      this.catchupTimer = null;
    }
  }

  // ── Internal Helpers ────────────────────────────────────────────────────

  private getRecentFilesTouched(): string[] {
    try {
      // Show what will change when upgrading to origin/master (pending changes).
      // Falls back to last commit diff if origin/master is unavailable.
      const output = this.git('diff --name-only HEAD origin/master');
      return output.split('\n').filter(Boolean);
    } catch {
      try {
        const output = this.git('diff --name-only HEAD~1 HEAD');
        return output.split('\n').filter(Boolean);
      } catch {
        return [];
      }
    }
  }

  private getRemoteVersion(): string {
    try { return this.git('rev-parse --short origin/master'); } catch { return this.getCurrentVersion(); }
  }

  private assessRisk(filesTouched: string[]): RiskAssessment {
    const systemsAffected: Set<string> = new Set();

    for (const fp of filesTouched) {
      if (fp.includes('network') || fp.includes('sync')) systemsAffected.add('networking');
      if (fp.includes('ledger') || fp.includes('transaction')) systemsAffected.add('ledger');
      if (fp.includes('governance')) systemsAffected.add('governance');
      if (fp.includes('scheduler') || fp.includes('planner')) systemsAffected.add('scheduler');
      if (fp.includes('api-server') || fp.includes('gateway')) systemsAffected.add('api');
      if (fp.includes('crypto') || fp.includes('identity')) systemsAffected.add('security');
      if (fp.includes('monitor') || fp.includes('guardrails')) systemsAffected.add('safety');
      if (fp.includes('manager') || fp.includes('domain')) systemsAffected.add('management');
    }

    let riskLevel: RiskAssessment['riskLevel'] = 'low';
    if (systemsAffected.has('security') || systemsAffected.has('ledger')) riskLevel = 'critical';
    else if (systemsAffected.has('networking') || systemsAffected.has('governance')) riskLevel = 'high';
    else if (systemsAffected.has('scheduler') || systemsAffected.has('safety')) riskLevel = 'medium';
    if (filesTouched.length > 20 && riskLevel === 'low') riskLevel = 'medium';
    if (filesTouched.length > 50 && riskLevel === 'medium') riskLevel = 'high';

    return {
      filesTouched,
      systemsAffected: Array.from(systemsAffected),
      rollbackPlan: 'Restore from backup or git checkout HEAD -- packages/',
      riskLevel,
    };
  }

  private git(cmd: string): string {
    return execSync(`git ${cmd}`, {
      cwd: this.repoDir, encoding: 'utf-8', timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    }).trim();
  }

  private getCurrentVersion(): string {
    try { return this.git('rev-parse --short HEAD'); } catch { return 'unknown'; }
  }

  private recordUpgrade(proposalId: string, status: UpgradeRecord['status'], reason?: string): void {
    const record: UpgradeRecord = {
      proposalId, version: this.getCurrentVersion(), status, appliedAt: Date.now(), reason,
    };
    if (status === 'rolled_back') record.rollbackAt = Date.now();
    this.history.unshift(record);
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(0, MAX_HISTORY);
    this.saveState();
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private loadState(): void {
    try {
      if (existsSync(this.statePath)) {
        const raw = JSON.parse(readFileSync(this.statePath, 'utf-8'));
        if (raw.proposals && Array.isArray(raw.proposals)) {
          for (const p of raw.proposals) this.proposals.set(p.proposalId, p);
        }
        if (raw.history && Array.isArray(raw.history)) this.history = raw.history.slice(0, MAX_HISTORY);
        if (raw.pinnedVersion) this.pinnedVersion = raw.pinnedVersion;
        if (raw.appliedProposalIds && Array.isArray(raw.appliedProposalIds)) {
          for (const id of raw.appliedProposalIds) this.appliedProposalIds.add(id);
        }
      }
    } catch (err: any) {
      console.error(`[upgrade-protocol] Failed to load state: ${err.message}`);
    }
  }

  private saveState(): void {
    try {
      const state = {
        proposals: Array.from(this.proposals.values()),
        history: this.history,
        pinnedVersion: this.pinnedVersion,
        appliedProposalIds: Array.from(this.appliedProposalIds),
        savedAt: Date.now(),
      };
      writeFileSync(this.statePath, JSON.stringify(state, null, 2));
    } catch (err: any) {
      console.error(`[upgrade-protocol] Failed to save state: ${err.message}`);
    }
  }
}
