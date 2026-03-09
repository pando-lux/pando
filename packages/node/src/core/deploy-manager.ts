/**
 * Deploy Manager — commit, build, and deploy pipeline changes.
 *
 * Uses GitOps for all git operations. Manages the deployment lifecycle
 * for changes produced by the autonomous code pipeline.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GitOps } from './git-ops.js';
import type { PatchSet } from '@pando/shared';

// ── Types ────────────────────────────────────────────────────────────────────

export interface DeployStatus {
  lastCommitHash: string | null;
  lastCommitMessage: string | null;
  lastBuildPassed: boolean | null;
  lastDeployAt: number | null;
  backupExists: boolean;
  backupId: string | null;
  pendingRollback: boolean;
}

export interface CommitResult {
  success: boolean;
  commitHash: string | null;
  message: string;
  filesCommitted: string[];
  error?: string;
}

export interface BuildResult {
  success: boolean;
  durationMs: number;
  output: string;
  error?: string;
}

export interface BackupInfo {
  id: string;
  createdAt: number;
  backupDir: string;
  description: string;
}

// ── DeployManager ────────────────────────────────────────────────────────────

export class DeployManager {
  private readonly repoDir: string;
  private readonly backupBaseDir: string;
  private readonly git: GitOps;

  /** Tracks the most recent pipeline commit hash for rollback. */
  private lastCommitHash: string | null = null;
  private lastCommitMessage: string | null = null;
  private lastBuildPassed: boolean | null = null;
  private lastDeployAt: number | null = null;
  private pendingRollback = false;

  /** Active backup metadata (only one backup at a time). */
  private activeBackup: BackupInfo | null = null;

  constructor(repoDir: string, backupBaseDir?: string) {
    this.repoDir = repoDir;
    this.backupBaseDir = backupBaseDir ?? join(repoDir, '.deploy-backups');
    this.git = new GitOps(repoDir);
  }

  // ── 1. Commit Changes ──────────────────────────────────────────────────────

  commitChanges(patchSet: PatchSet): CommitResult {
    const filePaths = patchSet.changes.map(c => c.filePath);

    if (filePaths.length === 0) {
      return {
        success: false,
        commitHash: null,
        message: 'No files to commit — PatchSet has no changes.',
        filesCommitted: [],
      };
    }

    try {
      // Stage each file individually
      for (const change of patchSet.changes) {
        const fullPath = join(this.repoDir, change.filePath);
        if (change.operation === 'delete' && !existsSync(fullPath)) {
          this.git.rm([change.filePath], true);
        } else {
          this.git.add([change.filePath]);
        }
      }

      // Build commit message from PatchSet metadata
      const commitMsg = `[pipeline] ${patchSet.description}\n\nPatchSet: ${patchSet.id}\nFiles: ${filePaths.length}`;
      const commitHash = this.git.commit(commitMsg);

      this.lastCommitHash = commitHash;
      this.lastCommitMessage = patchSet.description;
      this.lastDeployAt = Date.now();
      this.pendingRollback = false;

      return {
        success: true,
        commitHash,
        message: `Committed ${filePaths.length} file(s): ${patchSet.description}`,
        filesCommitted: filePaths,
      };
    } catch (err: any) {
      const errorMsg = (err.stderr?.toString() || err.message || 'Unknown git error').slice(0, 500);
      return {
        success: false,
        commitHash: null,
        message: `Commit failed: ${errorMsg}`,
        filesCommitted: [],
        error: errorMsg,
      };
    }
  }

  // ── 2. Run Build ───────────────────────────────────────────────────────────

  runBuild(): BuildResult {
    const startTime = Date.now();
    try {
      const output = execSync('npm run build', {
        cwd: this.repoDir,
        timeout: 180_000,
        stdio: 'pipe',
        encoding: 'utf-8',
        windowsHide: true,
      });

      const durationMs = Date.now() - startTime;
      this.lastBuildPassed = true;
      this.pendingRollback = false;

      return {
        success: true,
        durationMs,
        output: (output || '').slice(0, 2000),
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const stderr = err.stderr?.toString() || '';
      const stdout = err.stdout?.toString() || '';
      const errorOutput = (stderr || stdout || err.message || 'Build failed').slice(0, 2000);

      this.lastBuildPassed = false;
      this.pendingRollback = true;

      return {
        success: false,
        durationMs,
        output: errorOutput,
        error: errorOutput.slice(0, 500),
      };
    }
  }

  // ── 3. Rollback Commit ─────────────────────────────────────────────────────

  rollbackCommit(): CommitResult {
    if (!this.lastCommitHash) {
      return {
        success: false,
        commitHash: null,
        message: 'No pipeline commit to roll back.',
        filesCommitted: [],
      };
    }

    const targetHash = this.lastCommitHash;

    try {
      const currentHead = this.git.getCurrentCommit();
      if (currentHead !== targetHash) {
        // HEAD has moved — use revert to be safe
        this.git.revert(targetHash);
      } else {
        // HEAD matches — safe to reset
        this.git.resetSoft('HEAD~1');
        this.git.resetIndex();
        this.git.checkoutAll();
      }

      const newHead = this.git.getCurrentCommit();

      this.lastCommitHash = null;
      this.lastCommitMessage = null;
      this.pendingRollback = false;

      return {
        success: true,
        commitHash: newHead,
        message: `Rolled back commit ${targetHash.slice(0, 8)}.`,
        filesCommitted: [],
      };
    } catch (err: any) {
      const errorMsg = (err.stderr?.toString() || err.message || 'Unknown git error').slice(0, 500);
      return {
        success: false,
        commitHash: null,
        message: `Rollback failed: ${errorMsg}`,
        filesCommitted: [],
        error: errorMsg,
      };
    }
  }

  // ── 4. Create Backup ───────────────────────────────────────────────────────

  createBackup(description?: string): BackupInfo {
    if (!existsSync(this.backupBaseDir)) {
      mkdirSync(this.backupBaseDir, { recursive: true });
    }

    if (this.activeBackup && existsSync(this.activeBackup.backupDir)) {
      rmSync(this.activeBackup.backupDir, { recursive: true, force: true });
    }

    const id = `backup-${Date.now()}`;
    const backupDir = join(this.backupBaseDir, id);

    mkdirSync(backupDir, { recursive: true });

    const packagesDir = join(this.repoDir, 'packages');
    if (existsSync(packagesDir)) {
      cpSync(packagesDir, join(backupDir, 'packages'), { recursive: true });
    }

    const info: BackupInfo = {
      id,
      createdAt: Date.now(),
      backupDir,
      description: description ?? 'Pre-deploy backup',
    };

    writeFileSync(join(backupDir, 'backup-meta.json'), JSON.stringify(info, null, 2));

    this.activeBackup = info;
    return info;
  }

  // ── 5. Restore Backup ──────────────────────────────────────────────────────

  restoreBackup(backupId?: string): { success: boolean; message: string } {
    const backup = backupId
      ? this.findBackupById(backupId)
      : this.activeBackup;

    if (!backup) {
      return {
        success: false,
        message: backupId
          ? `Backup "${backupId}" not found.`
          : 'No active backup to restore from.',
      };
    }

    if (!existsSync(backup.backupDir)) {
      return {
        success: false,
        message: `Backup directory does not exist: ${backup.backupDir}`,
      };
    }

    try {
      const backupPackagesDir = join(backup.backupDir, 'packages');
      const repoPackagesDir = join(this.repoDir, 'packages');

      if (existsSync(backupPackagesDir)) {
        if (existsSync(repoPackagesDir)) {
          rmSync(repoPackagesDir, { recursive: true, force: true });
        }
        cpSync(backupPackagesDir, repoPackagesDir, { recursive: true });
      }

      return {
        success: true,
        message: `Restored from backup ${backup.id} (created ${new Date(backup.createdAt).toISOString()}).`,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Restore failed: ${(err.message || 'Unknown error').slice(0, 500)}`,
      };
    }
  }

  // ── 6. Get Deploy Status ───────────────────────────────────────────────────

  getDeployStatus(): DeployStatus {
    return {
      lastCommitHash: this.lastCommitHash,
      lastCommitMessage: this.lastCommitMessage,
      lastBuildPassed: this.lastBuildPassed,
      lastDeployAt: this.lastDeployAt,
      backupExists: this.activeBackup !== null && existsSync(this.activeBackup.backupDir),
      backupId: this.activeBackup?.id ?? null,
      pendingRollback: this.pendingRollback,
    };
  }

  // ── 7. Push to Remote ──────────────────────────────────────────────────────

  /**
   * Push committed code to a remote repository.
   *
   * GOVERNANCE ENFORCEMENT: Callers must explicitly pass `governanceApproved: true`
   * to confirm that governance approval has been obtained (or is not required).
   * Without this flag, the push is blocked. This prevents accidental bypass of
   * the governance pipeline.
   */
  pushToRemote(remote = 'origin', branch = 'master', opts?: { governanceApproved?: boolean }): CommitResult {
    if (!opts?.governanceApproved) {
      console.warn(`[deploy-manager] Push to ${remote}/${branch} BLOCKED: governanceApproved flag not set. ` +
        `Callers must confirm governance approval before pushing.`);
      return {
        success: false,
        commitHash: null,
        message: `Push blocked: governance approval not confirmed. Pass { governanceApproved: true } to pushToRemote().`,
        filesCommitted: [],
        error: 'Governance approval required',
      };
    }

    try {
      this.git.push(remote, branch);
      return {
        success: true,
        commitHash: this.lastCommitHash,
        message: `Pushed to ${remote}/${branch}`,
        filesCommitted: [],
      };
    } catch (err: any) {
      const errorMsg = (err.stderr?.toString() || err.message || 'Unknown git push error').slice(0, 500);
      return {
        success: false,
        commitHash: null,
        message: `Push failed: ${errorMsg}`,
        filesCommitted: [],
        error: errorMsg,
      };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private findBackupById(backupId: string): BackupInfo | null {
    const backupDir = join(this.backupBaseDir, backupId);
    const metaPath = join(backupDir, 'backup-meta.json');

    if (!existsSync(metaPath)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(metaPath, 'utf-8'));
    } catch {
      return null;
    }
  }
}
