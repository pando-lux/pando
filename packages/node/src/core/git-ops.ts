// Verified live: unified git operations layer — all nodes upgraded via governance pipeline.
// Upgrade pipeline test: governance auto-upgrade verified on all 3 nodes (2026-03-09).
// Atomic commit-and-propose test: endpoint verified on 4-node mesh (2026-03-09).
/**
 * GitOps — Unified git operations layer.
 *
 * ALL git operations in the codebase go through this class.
 * No more scattered execSync/execFileSync git calls.
 *
 * Security: Uses execFileSync (array args, no shell injection).
 * Credential: Optional resolver injects PAT into URLs for clone/fetch/push.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Validate a git ref (commit hash, branch name, tag) to prevent injection. */
export function safeGitRef(ref: string): string {
  if (!/^[0-9a-zA-Z._\-/]{1,100}$/.test(ref)) {
    throw new Error(`Invalid git ref: ${ref.slice(0, 20)}`);
  }
  return ref;
}

/** Validate a commit hash format (hex, 6-40 chars). */
export function safeCommitHash(hash: string): string {
  if (!/^[0-9a-f]{6,40}$/i.test(hash)) {
    throw new Error(`Invalid commit hash: ${hash.slice(0, 20)}`);
  }
  return hash;
}

export interface GitOpsOptions {
  /** Resolve credentials for a repo URL. Returns authenticated URL or null. */
  credentialResolver?: (repoUrl: string) => Promise<string | null>;
}

export class GitOps {
  private readonly repoDir: string;
  private readonly credentialResolver?: (repoUrl: string) => Promise<string | null>;

  constructor(repoDir: string, options?: GitOpsOptions) {
    this.repoDir = repoDir;
    this.credentialResolver = options?.credentialResolver;
  }

  // ── Low-level ──────────────────────────────────────────────────────────

  /** Execute a git command. Returns trimmed stdout. */
  exec(args: string[], opts?: { timeout?: number; cwd?: string }): string {
    return execFileSync('git', args, {
      cwd: opts?.cwd || this.repoDir,
      encoding: 'utf-8',
      timeout: opts?.timeout || 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  }

  // ── Basic operations ───────────────────────────────────────────────────

  /** Synchronous clone (no credential resolution). For callers that don't need async. */
  static cloneSync(repoUrl: string, targetDir: string, branch?: string): void {
    const args = ['clone'];
    if (branch) args.push('--branch', safeGitRef(branch));
    args.push(repoUrl, targetDir);
    execFileSync('git', args, {
      timeout: 120_000, stdio: 'pipe', windowsHide: true,
    });
  }

  /** Clone a repo. Uses credential resolver if available. */
  async clone(repoUrl: string, targetDir: string, branch?: string): Promise<void> {
    let url = repoUrl;
    if (this.credentialResolver) {
      const authenticated = await this.credentialResolver(repoUrl);
      if (authenticated) url = authenticated;
    }
    const args = ['clone'];
    if (branch) args.push('--branch', safeGitRef(branch));
    args.push(url, targetDir);
    execFileSync('git', args, {
      timeout: 120_000, stdio: 'pipe', windowsHide: true,
    });
  }

  /** Fetch from remote. */
  fetch(remote = 'origin', branch?: string): void {
    const args = ['fetch', remote];
    if (branch) args.push(safeGitRef(branch));
    this.exec(args, { timeout: 60_000 });
  }

  /** Pull from remote. */
  pull(remote = 'origin', branch?: string): void {
    const args = ['pull', remote];
    if (branch) args.push(safeGitRef(branch));
    this.exec(args, { timeout: 60_000 });
  }

  /** Checkout a branch or commit. */
  checkout(ref: string): void {
    this.exec(['checkout', safeGitRef(ref)]);
  }

  /** Checkout specific files from a ref. */
  checkoutFiles(ref: string, paths: string[]): void {
    this.exec(['checkout', safeGitRef(ref), '--', ...paths]);
  }

  /** Hard reset to a target ref. */
  resetHard(target = 'origin/master'): void {
    this.exec(['reset', '--hard', safeGitRef(target)]);
  }

  /** Soft reset (keeps changes staged). */
  resetSoft(target: string): void {
    this.exec(['reset', '--soft', safeGitRef(target)]);
  }

  /** Reset index for all files. */
  resetIndex(): void {
    this.exec(['reset', 'HEAD', '.']);
  }

  /** Restore all working tree files. */
  checkoutAll(): void {
    this.exec(['checkout', '--', '.']);
  }

  // ── Commit operations ──────────────────────────────────────────────────

  /** Stage files for commit. */
  add(files: string[]): void {
    this.exec(['add', '--', ...files]);
  }

  /** Remove files from index. */
  rm(files: string[], cached = false): void {
    const args = ['rm'];
    if (cached) args.push('--cached');
    args.push('--', ...files);
    this.exec(args);
  }

  /** Create a commit. Returns the commit hash. */
  commit(message: string): string {
    this.exec(['commit', '-m', message]);
    return this.getCurrentCommit();
  }

  /** Revert a commit (creates a new revert commit). */
  revert(commitHash: string): void {
    this.exec(['revert', '--no-edit', safeCommitHash(commitHash)]);
  }

  /** Push to remote. */
  push(remote = 'origin', branch = 'master'): void {
    this.exec(['push', remote, safeGitRef(branch)], { timeout: 60_000 });
  }

  // ── Query operations ───────────────────────────────────────────────────

  /** Get current HEAD commit hash. */
  getCurrentCommit(short = false): string {
    return this.exec(['rev-parse', ...(short ? ['--short'] : []), 'HEAD']);
  }

  /** Get remote branch commit hash. */
  getRemoteCommit(remote = 'origin', branch = 'master', short = false): string {
    return this.exec(['rev-parse', ...(short ? ['--short'] : []), `${remote}/${safeGitRef(branch)}`]);
  }

  /** Check if working tree has uncommitted changes. */
  hasUncommittedChanges(): boolean {
    return this.exec(['status', '--porcelain']).length > 0;
  }

  /** Check if ancestor is an ancestor of descendant. */
  isAncestor(ancestor: string, descendant: string): boolean {
    try {
      this.exec(['merge-base', '--is-ancestor', safeCommitHash(ancestor), safeGitRef(descendant)]);
      return true;
    } catch {
      return false;
    }
  }

  /** Get full diff output between two refs. */
  diff(from?: string, to?: string, extraArgs?: string[]): string {
    const args = ['diff'];
    if (from) args.push(safeGitRef(from));
    if (to) args.push(safeGitRef(to));
    if (extraArgs) args.push(...extraArgs);
    return this.exec(args, { timeout: 15_000 });
  }

  /** Get diff stat between two refs. */
  diffStat(from?: string, to?: string): string {
    const args = ['diff'];
    if (from) args.push(safeGitRef(from));
    if (to) args.push(safeGitRef(to));
    args.push('--stat');
    return this.exec(args, { timeout: 10_000 });
  }

  /** Initialize a new git repository. */
  init(): void {
    this.exec(['init']);
  }

  /** Set git config value. */
  config(key: string, value: string): void {
    this.exec(['config', key, value]);
  }

  /** Add a remote. */
  remoteAdd(name: string, url: string): void {
    this.exec(['remote', 'add', name, url]);
  }

  /** Remove a remote. */
  remoteRemove(name: string): void {
    try { this.exec(['remote', 'remove', name]); } catch { /* not fatal */ }
  }

  /** Get list of changed files between two refs. */
  diffNameOnly(from?: string, to?: string): string[] {
    const args = ['diff', '--name-only'];
    if (from) args.push(safeGitRef(from));
    if (to) args.push(safeGitRef(to));
    const output = this.exec(args);
    return output ? output.split('\n').filter(Boolean) : [];
  }

  /** Get list of staged (cached) changed files. */
  diffCachedNameOnly(): string[] {
    const output = this.exec(['diff', '--cached', '--name-only']);
    return output ? output.split('\n').filter(Boolean) : [];
  }

  /** Show file content at a specific ref. */
  show(ref: string, filePath: string): string {
    return this.exec(['show', `${safeGitRef(ref)}:${filePath}`]);
  }

  /** Count commits ahead of a remote ref. */
  revListCount(from: string, to: string): number {
    const count = this.exec(['rev-list', `${safeGitRef(from)}..${safeGitRef(to)}`, '--count']);
    return parseInt(count, 10) || 0;
  }

  /** List remote refs (for connectivity check). */
  lsRemote(remote = 'origin', ref = 'master'): string {
    return this.exec(['ls-remote', '--exit-code', remote, ref], { timeout: 10_000 });
  }

  // ── Compound operations ────────────────────────────────────────────────

  /**
   * Stash uncommitted changes, then reset --hard to target.
   * Skips reset if local has unpushed commits to avoid destroying work.
   * Equivalent to the old safeGitReset() function.
   */
  stashAndReset(target = 'origin/master'): void {
    // Check for local commits not yet pushed — skip reset to preserve unpushed work
    try {
      const count = this.revListCount('origin/master', 'HEAD');
      if (count > 0) {
        console.warn(`[git-ops] Skipping reset — ${count} unpushed commit(s) ahead of origin`);
        return;
      }
    } catch (checkErr: any) {
      console.warn(`[git-ops] Could not check unpushed commits (${checkErr.message?.slice(0, 100)}) — proceeding`);
    }

    // Stash if uncommitted changes exist
    if (this.hasUncommittedChanges()) {
      const files = this.exec(['status', '--porcelain']).split('\n').length;
      console.warn(`[git-ops] Uncommitted changes (${files} files). Stashing...`);
      try {
        this.exec(['stash', 'push', '-m', `pando-auto-stash-${Date.now()}`], { timeout: 15_000 });
        console.warn('[git-ops] Changes stashed. Recover with: git stash pop');
      } catch (stashErr: any) {
        console.warn(`[git-ops] Stash failed (${stashErr.message}). Proceeding with reset.`);
      }
    }

    this.resetHard(target);
  }

  /** Add current repoDir as a safe directory in global git config. */
  addSafeDirectory(): void {
    try {
      execFileSync('git', ['config', '--global', '--add', 'safe.directory', this.repoDir], {
        timeout: 5_000, stdio: 'pipe', windowsHide: true,
      });
    } catch { /* non-fatal */ }
  }
}
