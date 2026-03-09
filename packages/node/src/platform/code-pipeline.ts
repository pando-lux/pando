/**
 * Code Pipeline — extract and apply workspace diffs.
 *
 * Phase 16.3: Autonomous code pipeline that extracts diffs from workspace
 * output directories, applies patches to the repository, and supports
 * full rollback on failure.
 *
 * Workflow:
 *   1. extractDiff()  — scan entire workspace output/ directory for source files,
 *                        compute diffs against the repo, skip non-source files.
 *   2. applyPatch()   — validate through guardrails, save originals for
 *                        rollback, write new content, return MergeResult.
 *   3. rollback()     — restore originals and delete newly created files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { GitOps } from '../core/git-ops.js';
import { join, relative, dirname, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  FileChange,
  MergeConflict,
  MergeResult,
  PatchSet,
  RollbackInfo,
  GuardrailTier,
} from '@pando/shared';
import { Guardrails } from '../kernel/guardrails.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Source file extensions that the pipeline will process. */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.css', '.scss', '.html', '.svg',
  '.md', '.yaml', '.yml', '.toml',
]);

/** Directories/patterns to skip during diff extraction. */
const SKIP_PATTERNS = [
  'node_modules',
  'dist',
  '.git',
  '.cache',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
];

// ── CodePipeline ─────────────────────────────────────────────────────────────

export class CodePipeline {
  private readonly guardrails: Guardrails;
  private readonly repoDir: string;

  constructor(repoDir: string, guardrails: Guardrails) {
    this.repoDir = repoDir;
    this.guardrails = guardrails;
  }

  // ── 1. Extract Diff ──────────────────────────────────────────────────────

  /**
   * Scan a workspace's output/ directory for source files that correspond
   * to paths in the repository. Compute diffs against the repo files.
   *
   * BUG-16 fix: Scans the entire output/ directory (not just output/packages/)
   * because agents produce results in various subdirectories (e.g. output/src/,
   * output/packages/, output/tests/, etc.).
   *
   * Skips non-source files (binaries, images, node_modules, dist, etc.).
   * Returns a PatchSet describing all detected changes.
   */
  extractDiff(workspaceOutputDir: string): PatchSet {
    const changes: FileChange[] = [];

    if (!existsSync(workspaceOutputDir)) {
      console.log(`[code-pipeline] extractDiff: workspace dir does not exist: ${workspaceOutputDir} — will try git diff fallback`);
      // Don't return early — fall through to git diff fallback below
    } else {
      // BUG-16 fix: Scan the entire output/ directory, not just output/packages/
      const outputFiles = this.collectSourceFiles(workspaceOutputDir, workspaceOutputDir);

      if (outputFiles.length === 0) {
        console.log(`[code-pipeline] extractDiff: no source files found in ${workspaceOutputDir}`);
      }

      for (const relPath of outputFiles) {
        const outputFilePath = join(workspaceOutputDir, relPath);
        const repoFilePath = join(this.repoDir, relPath);

        const newContent = readFileSync(outputFilePath, 'utf-8');

        if (existsSync(repoFilePath)) {
          // File exists in repo — check if content differs
          const oldContent = readFileSync(repoFilePath, 'utf-8');
          if (oldContent !== newContent) {
            changes.push({
              filePath: relPath,
              operation: 'modify',
              oldContent,
              newContent,
              diff: this.computeSimpleDiff(oldContent, newContent),
            });
          }
          // If identical, skip (no change needed)
        } else {
          // New file — doesn't exist in repo yet
          changes.push({
            filePath: relPath,
            operation: 'create',
            newContent,
          });
        }
      }
    }

    // If workspace output scan found nothing, try git diff as fallback.
    // This catches changes agents made directly to the repo (not via workspace output).
    if (changes.length === 0) {
      console.log(`[code-pipeline] extractDiff: no changes detected in workspace output — trying git diff fallback`);
      const gitChanges = this.extractGitDiff();
      if (gitChanges.changes.length > 0) {
        return gitChanges;
      }
      console.log(`[code-pipeline] extractDiff: git diff fallback also found no changes`);
    }

    return this.createPatchSet(
      `Extracted ${changes.length} change(s) from workspace output`,
      changes,
    );
  }

  /**
   * Fallback: extract changes from uncommitted git modifications in the repo.
   * Runs `git diff --name-only` to find modified source files, then reads
   * their content vs HEAD to build a PatchSet.
   */
  extractGitDiff(): PatchSet {
    const changes: FileChange[] = [];

    try {
      const git = new GitOps(this.repoDir);

      // Get both unstaged and staged changes
      const unstagedFiles = git.diffNameOnly();
      const stagedFiles = git.diffCachedNameOnly();

      const changedFiles = new Set<string>();
      for (const f of unstagedFiles) changedFiles.add(f.trim());
      for (const f of stagedFiles) changedFiles.add(f.trim());

      for (const relPath of changedFiles) {
        if (!relPath) continue;

        const ext = extname(relPath).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        if (SKIP_PATTERNS.some(p => relPath.includes(p))) continue;

        const fullPath = join(this.repoDir, relPath);
        if (!existsSync(fullPath)) continue;

        try {
          const newContent = readFileSync(fullPath, 'utf-8');
          let oldContent = '';
          try {
            oldContent = git.show('HEAD', relPath);
          } catch {
            // New file not in HEAD
          }

          if (oldContent !== newContent) {
            changes.push({
              filePath: relPath,
              operation: oldContent ? 'modify' : 'create',
              oldContent: oldContent || undefined,
              newContent,
              diff: this.computeSimpleDiff(oldContent, newContent),
            });
          }
        } catch {}
      }
    } catch (err: any) {
      console.error(`[code-pipeline] Git diff extraction failed: ${err.message}`);
    }

    return this.createPatchSet(
      changes.length > 0
        ? `Extracted ${changes.length} change(s) from git diff`
        : 'No uncommitted changes found in git',
      changes,
    );
  }

  // ── 2. Apply Patch ───────────────────────────────────────────────────────

  /**
   * Apply a PatchSet to the repository directory.
   *
   * Before writing, each file is checked through guardrails:
   *   - isImmutableKernel: blocks changes to kernel files
   *   - tieredPreCheck: enforces tier-based approval and rate limits
   *
   * Original file contents are saved so that rollback() can restore them.
   * Returns a MergeResult with rollbackInfo on success.
   */
  applyPatch(patchSet: PatchSet, governanceApproved?: boolean): MergeResult {
    const mergedFiles: string[] = [];
    const conflicts: MergeConflict[] = [];
    const originalFiles: Record<string, string | null> = {};

    // Collect all file paths for a single guardrail check
    const allPaths = patchSet.changes.map(c => c.filePath);

    // Check immutable kernel first (fast rejection)
    for (const change of patchSet.changes) {
      if (this.guardrails.isImmutableKernel(change.filePath)) {
        conflicts.push({
          filePath: change.filePath,
          reason: `Immutable kernel file — cannot be modified by the autonomous pipeline`,
          ourContent: change.oldContent ?? '',
          theirContent: change.newContent ?? '',
          resolved: false,
        });
      }
    }

    // If any immutable violations, abort the entire patch
    if (conflicts.length > 0) {
      return {
        success: false,
        mergedFiles: [],
        conflicts,
        patchSetId: patchSet.id,
      };
    }

    // Run tiered pre-check on all paths at once
    if (allPaths.length > 0) {
      const tieredResult = this.guardrails.tieredPreCheck(
        allPaths,
        patchSet.description,
        governanceApproved,
      );

      if (!tieredResult.allowed) {
        // Blocked by guardrails — report as conflict
        conflicts.push({
          filePath: allPaths.join(', '),
          reason: tieredResult.reason,
          ourContent: '',
          theirContent: '',
          resolved: false,
        });

        return {
          success: false,
          mergedFiles: [],
          conflicts,
          patchSetId: patchSet.id,
        };
      }
    }

    // Apply each change — save originals for rollback
    for (const change of patchSet.changes) {
      const targetPath = join(this.repoDir, change.filePath);

      try {
        // Save original for rollback
        if (existsSync(targetPath)) {
          originalFiles[change.filePath] = readFileSync(targetPath, 'utf-8');
        } else {
          originalFiles[change.filePath] = null; // file didn't exist before
        }

        // Ensure parent directory exists
        const parentDir = dirname(targetPath);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }

        // Write the new content
        if (change.operation === 'delete') {
          if (existsSync(targetPath)) {
            unlinkSync(targetPath);
          }
        } else {
          writeFileSync(targetPath, change.newContent ?? '', 'utf-8');
        }

        mergedFiles.push(change.filePath);
      } catch (err: any) {
        conflicts.push({
          filePath: change.filePath,
          reason: `Write failed: ${err.message}`,
          ourContent: change.oldContent ?? '',
          theirContent: change.newContent ?? '',
          resolved: false,
        });
      }
    }

    const rollbackInfo: RollbackInfo = {
      patchSetId: patchSet.id,
      originalFiles,
    };

    const success = conflicts.length === 0;

    // If there were partial failures, roll back everything
    if (!success) {
      this.rollback(rollbackInfo);
      return {
        success: false,
        mergedFiles: [],
        conflicts,
        patchSetId: patchSet.id,
      };
    }

    // Mark patch as applied
    patchSet.appliedAt = Date.now();

    const result: MergeResult = {
      success: true,
      mergedFiles,
      conflicts: [],
      patchSetId: patchSet.id,
    };

    // Attach rollbackInfo to the result (accessed via the returned reference)
    (result as MergeResult & { rollbackInfo: RollbackInfo }).rollbackInfo = rollbackInfo;

    return result;
  }

  // ── 3. Rollback ──────────────────────────────────────────────────────────

  /**
   * Restore files to their original state using saved rollback information.
   *
   * - Files that existed before are restored to their original content.
   * - Files that were newly created are deleted.
   */
  rollback(rollbackInfo: RollbackInfo): void {
    rollbackInfo.rolledBackAt = Date.now();

    for (const [filePath, originalContent] of Object.entries(rollbackInfo.originalFiles)) {
      const targetPath = join(this.repoDir, filePath);

      try {
        if (originalContent === null) {
          // File was newly created — delete it
          if (existsSync(targetPath)) {
            unlinkSync(targetPath);
          }
        } else {
          // File existed before — restore original content
          const parentDir = dirname(targetPath);
          if (!existsSync(parentDir)) {
            mkdirSync(parentDir, { recursive: true });
          }
          writeFileSync(targetPath, originalContent, 'utf-8');
        }
      } catch (err: any) {
        console.error(
          `[code-pipeline] Rollback failed for ${filePath}: ${err.message}`,
        );
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Recursively collect source files under a base directory.
   * Returns relative paths from baseDir.
   */
  private collectSourceFiles(dir: string, baseDir: string): string[] {
    const results: string[] = [];

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return results;
    }

    for (const entry of entries) {
      // Skip hidden files and known non-source patterns
      if (entry.startsWith('.') || SKIP_PATTERNS.includes(entry)) {
        continue;
      }

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        results.push(...this.collectSourceFiles(fullPath, baseDir));
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (SOURCE_EXTENSIONS.has(ext)) {
          results.push(relative(baseDir, fullPath));
        }
      }
    }

    return results;
  }

  /**
   * Compute a simple line-by-line diff summary.
   * This is not a full unified diff — it's a human-readable summary
   * showing added/removed line counts.
   */
  private computeSimpleDiff(oldContent: string, newContent: string): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    // Build a set of lines for quick lookup
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);

    const added = newLines.filter(l => !oldSet.has(l)).length;
    const removed = oldLines.filter(l => !newSet.has(l)).length;

    return `+${added} -${removed} lines (${oldLines.length} → ${newLines.length} total)`;
  }

  /**
   * Create a PatchSet with a unique ID and timestamp.
   */
  private createPatchSet(description: string, changes: FileChange[]): PatchSet {
    return {
      id: randomBytes(16).toString('hex'),
      description,
      changes,
      createdAt: Date.now(),
    };
  }
}
