/**
 * Deploy Manager — commit, build, and deploy pipeline changes.
 *
 * Phase 16.5: Manages the deployment lifecycle for changes produced by the
 * autonomous code pipeline. Handles git commits, build verification,
 * rollback on failure, and backup/restore of the working tree.
 *
 * Workflow:
 *   1. createBackup()    — snapshot current state before deploying
 *   2. commitChanges()   — stage and commit a PatchSet's files
 *   3. runBuild()        — execute `npm run build` and report success/failure
 *   4. rollbackCommit()  — revert the last pipeline commit on build failure
 *   5. restoreBackup()   — restore from a previous backup snapshot
 *   6. getDeployStatus() — report current deployment state
 */

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
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
  }

  // ── 1. Commit Changes ──────────────────────────────────────────────────────

  /**
   * Stage and commit the files described by a PatchSet.
   *
   * Stages only the specific files listed in the PatchSet's changes array,
   * then creates a git commit with a descriptive message. Does NOT push.
   *
   * Returns the commit hash on success, or an error description on failure.
   */
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
      // Stage each file individually (deleted files use `git rm`)
      for (const change of patchSet.changes) {
        const fullPath = join(this.repoDir, change.filePath);
        if (change.operation === 'delete' && !existsSync(fullPath)) {
          this.git(['rm', '--cached', '--', change.filePath]);
        } else {
          this.git(['add', '--', change.filePath]);
        }
      }

      // Build commit message from PatchSet metadata
      const commitMsg = `[pipeline] ${patchSet.description}\n\nPatchSet: ${patchSet.id}\nFiles: ${filePaths.length}`;

      // Create the commit
      this.git(['commit', '-m', commitMsg]);

      // Retrieve the commit hash
      const commitHash = this.git(['rev-parse', 'HEAD']).trim();

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

  /**
   * Execute `npm run build` in the repository directory.
   *
   * Returns build success/failure along with duration and output.
   * On failure, sets `pendingRollback` to true so the caller knows
   * a rollback may be needed.
   */
  runBuild(): BuildResult {
    const startTime = Date.now();
    try {
      const output = execSync('npm run build', {
        cwd: this.repoDir,
        timeout: 180_000, // 3 minute timeout
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

  /**
   * Revert the last pipeline commit using `git revert --no-edit`.
   *
   * Only operates on the commit tracked by `lastCommitHash` to prevent
   * accidentally reverting unrelated commits. After a successful rollback,
   * clears the pending rollback flag.
   *
   * Returns the revert commit hash, or an error if rollback fails.
   */
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
      // Verify the commit exists and is the current HEAD
      const currentHead = this.git(['rev-parse', 'HEAD']).trim();
      if (currentHead !== targetHash) {
        // The HEAD has moved — use revert instead of reset to be safe
        this.git(['revert', '--no-edit', targetHash]);
      } else {
        // HEAD matches — safe to reset
        this.git(['reset', '--soft', 'HEAD~1']);
        this.git(['reset', 'HEAD', '.']);
        this.git(['checkout', '--', '.']);
      }

      const newHead = this.git(['rev-parse', 'HEAD']).trim();

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

  /**
   * Create a snapshot backup of the current repository state.
   *
   * Copies the `packages/` directory (source code) into a timestamped
   * backup folder. Only one active backup is maintained at a time;
   * creating a new backup removes the previous one.
   *
   * Returns backup metadata including the backup directory path.
   */
  createBackup(description?: string): BackupInfo {
    // Ensure backup base directory exists
    if (!existsSync(this.backupBaseDir)) {
      mkdirSync(this.backupBaseDir, { recursive: true });
    }

    // Remove previous backup if it exists
    if (this.activeBackup && existsSync(this.activeBackup.backupDir)) {
      rmSync(this.activeBackup.backupDir, { recursive: true, force: true });
    }

    const id = `backup-${Date.now()}`;
    const backupDir = join(this.backupBaseDir, id);

    mkdirSync(backupDir, { recursive: true });

    // Copy packages/ directory (the source code)
    const packagesDir = join(this.repoDir, 'packages');
    if (existsSync(packagesDir)) {
      cpSync(packagesDir, join(backupDir, 'packages'), { recursive: true });
    }

    // Save backup metadata
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

  /**
   * Restore the repository from the active backup.
   *
   * Copies the backed-up `packages/` directory back over the current one,
   * effectively reverting to the state captured by createBackup().
   *
   * Returns true if restoration succeeded, false otherwise.
   */
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
        // Remove current packages and restore from backup
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

  /**
   * Report the current deployment state.
   *
   * Returns information about the last commit, build status, active backup,
   * and whether a rollback is pending (i.e., the last build failed).
   */
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
   * Push the current branch to origin.
   *
   * Pushes to origin master by default. Returns success/failure
   * with the git output or error message.
   */
  pushToRemote(remote = 'origin', branch = 'master'): CommitResult {
    try {
      const output = this.git(['push', remote, branch]);
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

  /**
   * Execute a git command in the repository directory.
   * Returns stdout as a string.
   */
  private git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: this.repoDir,
      timeout: 30_000,
      stdio: 'pipe',
      encoding: 'utf-8',
      windowsHide: true,
    });
  }

  /**
   * Find a backup by its ID from the backup base directory.
   */
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
