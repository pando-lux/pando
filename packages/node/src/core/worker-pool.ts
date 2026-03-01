/**
 * WorkerPool — Manages Claude Code worker processes.
 *
 * Extracted from agent-manager.ts. Does ONE thing: spawn/kill Claude Code workers.
 * All orchestration logic lives in the Orchestrator class.
 *
 * Responsibilities:
 *   - Create workspace directories
 *   - Build slim boot prompt via buildBootPrompt() (workers query context API on demand)
 *   - Start Claude Code processes via AIBackendRegistry
 *   - Register workers in agent_identity table
 *   - Kill workers and clean up
 *
 * Does NOT:
 *   - Watch bridge queues or message buses
 *   - Manage orchestrator hierarchy
 *   - Track task lifecycle
 *   - Make scheduling decisions
 */

import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, freemem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

import type { AgentDatabase, AgentIdentity, AgentType, AgentScope } from '../platform/agent-database.js';
import type { AIBackendRegistry } from './ai-backend-registry.js';
import type { AIResult } from './ai-backend.js';
import { MessageBus } from './message-bus.js';
// generateWorkerToolsDocs is exported from worker-mcp.ts for external use
// Boot prompt (buildBootPrompt) handles tool docs inline for new workers
import type { GenomeBridge, GenomeBridgeRegistry } from '../platform/genome-bridge.js';
import type { TemplateRegistry } from '../platform/template-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerConfig {
  role: string;                    // 'builder', 'tester', 'reviewer', etc.
  orchestratorId: string;         // parent orchestrator
  templateId?: string;             // Phase 105: explicit template reference
  taskId?: string;                // task to assign
  projectId?: string;             // project context
  scope?: AgentScope;             // 'private' | 'public'
  nodeId?: string;
  budgetLimit?: number;
  fileScope?: string[];           // files this worker can touch
  rolePrompt?: string;            // short role description
  authority?: Record<string, unknown>;
  workspaceDir?: string;          // override workspace path
}

export type SessionStrategy = 'fresh' | 'resume' | 'rotate';

export interface WorkerStatus {
  id: string;
  role: string;
  status: string;
  taskId: string | null;
  pid: number | null;
  sessionId: string | null;
  budgetSpent: number;
  budgetLimit: number;
  lastReportAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// WorkerPool class
// ---------------------------------------------------------------------------

export class WorkerPool {
  private dataDir: string;
  private apiPort: number;
  private activeProcesses = new Map<string, { kill: () => void }>();
  /** Maps workerId → child process PID for memory tracking. */
  private workerPids = new Map<string, number>();

  private genomeBridge: GenomeBridge | null = null;
  private genomeBridgeRegistry: GenomeBridgeRegistry | null = null;
  private templateRegistry: TemplateRegistry | null = null;

  private reapInterval: NodeJS.Timeout | null = null;
  private watchdogInterval: NodeJS.Timeout | null = null;

  constructor(
    private db: AgentDatabase,
    private aiRegistry: AIBackendRegistry,
    private messageBus: MessageBus,
    opts?: { dataDir?: string; apiPort?: number; genomeBridge?: GenomeBridge; genomeBridgeRegistry?: GenomeBridgeRegistry; templateRegistry?: TemplateRegistry },
  ) {
    this.dataDir = opts?.dataDir || join(homedir(), '.pando');
    this.apiPort = opts?.apiPort || 4000;
    this.genomeBridgeRegistry = opts?.genomeBridgeRegistry || null;
    this.genomeBridge = opts?.genomeBridge || this.genomeBridgeRegistry?.getPandoBridge() || null;
    this.templateRegistry = opts?.templateRegistry || null;

    // Periodically reap workers whose processes have died without reporting back
    this.reapInterval = setInterval(() => this.cleanup(), 30_000);
    // Allow Node.js to exit even if this interval is still running
    this.reapInterval.unref();

    // Memory watchdog: kill workers exceeding RSS limit every 60 seconds
    this.watchdogInterval = setInterval(() => this.runMemoryWatchdog(), 60_000);
    this.watchdogInterval.unref();
  }

  /** Returns the number of currently active workers. Used by safe restart check. */
  getActiveWorkerCount(): number {
    return this.db.listAgents({ type: 'worker', status: 'active' }).length;
  }

  /** Stop the periodic reap and watchdog intervals (call on node shutdown). */
  stopReaper(): void {
    if (this.reapInterval) {
      clearInterval(this.reapInterval);
      this.reapInterval = null;
    }
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  /**
   * Spawn or resume a Claude Code worker process.
   * Checks for existing workers with same role + orchestrator that have a session.
   * If found, resumes the existing worker instead of creating a new one.
   */
  async spawn(config: WorkerConfig): Promise<string> {
    // ── Memory guard: refuse to spawn if system RAM is critically low ──────
    const freeRam = freemem();
    const THREE_GB = 3 * 1024 * 1024 * 1024;
    if (freeRam < THREE_GB) {
      const freeMB = Math.round(freeRam / (1024 * 1024));
      console.warn(`[WorkerPool] Spawn rejected for role "${config.role}": only ${freeMB}MB free RAM (need 3GB). Skipping.`);
      throw new Error(`Insufficient free RAM to spawn worker: ${freeMB}MB free, 3 GB required`);
    }

    // ── Check for existing worker to resume ──────────────────────────────
    let workerId: string;
    let resumeSessionId: string | undefined;
    let workspaceDir: string;
    let agent: AgentIdentity;

    // Phase 105: Resolve template for this role
    const template = this.templateRegistry?.resolveTemplate(config.role, config.templateId) || null;
    const resolvedRolePrompt = config.rolePrompt || template?.rolePrompt || 'Complete the assigned task.';

    const existing = this.findResumableWorker(config);

    if (existing) {
      // Resume existing worker — preserve session context
      workerId = existing.id;
      resumeSessionId = existing.sessionId || undefined;
      workspaceDir = existing.workspaceDir || join(this.dataDir, 'agents', workerId);

      // Update worker with new task
      this.db.updateAgent(workerId, {
        status: 'spawning',
        currentTaskId: config.taskId || null,
        rolePrompt: config.rolePrompt || existing.rolePrompt || null,
      });
      agent = this.db.getAgent(workerId)!;

      console.log(`[WorkerPool] Resuming ${config.role} worker ${workerId} (session: ${resumeSessionId?.slice(0, 8) || 'none'})`);
    } else {
      // Create fresh worker
      workerId = `worker-${config.role}-${randomUUID().slice(0, 8)}`;
      workspaceDir = config.workspaceDir || join(this.dataDir, 'agents', workerId);
      if (!existsSync(workspaceDir)) {
        mkdirSync(workspaceDir, { recursive: true });
      }

      agent = this.db.createAgent({
        id: workerId,
        role: config.role,
        type: 'worker' as AgentType,
        scope: config.scope || 'private',
        parentId: config.orchestratorId,
        nodeId: config.nodeId || null,
        status: 'spawning',
        authority: config.authority ? JSON.stringify(config.authority) : null,
        fileScope: config.fileScope ? JSON.stringify(config.fileScope) : null,
        budgetLimit: config.budgetLimit ?? 50,
        projectId: config.projectId || null,
        workspaceDir,
        currentTaskId: config.taskId || null,
        rolePrompt: resolvedRolePrompt,
        templateId: template?.templateId || null,
        contextVersion: null,
        sessionId: null,
        pid: null,
        persistent: false,
        tickIntervalMs: null,
        lastTickAt: null,
        maxWorkers: 0,
        maxChildren: 0,
        lastReportAt: null,
      });

      console.log(`[WorkerPool] Creating fresh ${config.role} worker ${workerId}`);
    }

    // Build boot prompt — slim context injected at spawn (~500 tokens)
    // Workers query /v1/context/* for rich project/lesson context on demand

    // Get AI backend
    const backend = this.aiRegistry.getBest('code-execution');
    if (!backend) {
      this.db.updateAgent(workerId, { status: 'failed' });
      throw new Error('No AI backend available (Claude Code not found)');
    }

    // Build the task prompt
    // For resumed workers: shorter prompt (they already know the codebase)
    // For fresh workers: full context in prompt
    // Phase 104: Workers run in project workspace if set, otherwise Pando repo root
    let projectRoot = config.workspaceDir || process.cwd();

    // Issue 8: Create git worktree for builder workers to isolate writes
    let worktreePath: string | null = null;
    if (config.role === 'builder' && !resumeSessionId) {
      try {
        const wtDir = join(this.dataDir, 'worktrees');
        if (!existsSync(wtDir)) mkdirSync(wtDir, { recursive: true });
        worktreePath = join(wtDir, workerId);
        const branchName = `worker/${workerId}`;
        execSync(`git worktree add "${worktreePath}" -b "${branchName}" HEAD`, {
          cwd: projectRoot,
          encoding: 'utf-8',
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        projectRoot = worktreePath;
        this.db.updateAgent(workerId, { workspaceDir: worktreePath });
        console.log(`[WorkerPool] Created worktree for ${workerId} at ${worktreePath}`);
      } catch (wtErr: any) {
        console.warn(`[WorkerPool] Worktree creation failed for ${workerId}, using shared root: ${wtErr.message?.slice(0, 200)}`);
        worktreePath = null;
      }
    }

    let taskPrompt: string;

    if (resumeSessionId) {
      // Resumed worker — they already have context. Just give them the new task.
      taskPrompt = `You are continuing your work. Your agent ID is: ${workerId}\n`;
      taskPrompt += `Project root: ${projectRoot}\n`;
      taskPrompt += `Scratch workspace: ${workspaceDir}\n`;
      if (config.taskId) {
        taskPrompt += `New task ID: ${config.taskId}\n`;
      }
      taskPrompt += `\n## New Task\n`;
      taskPrompt += resolvedRolePrompt;
      taskPrompt += `\n\nWhen you finish, report via HTTP:\n`;
      taskPrompt += `curl -s -X POST http://localhost:${this.apiPort}/v1/worker/${workerId}/report -H "Content-Type: application/json" --data-raw '{"status":"done","summary":"<what you did>","filesChanged":["list","of","files"]}'\n`;
      taskPrompt += `\nIMPORTANT: The build MUST pass (npm run build) before you report "done".\n`;
      taskPrompt += `Start working now.`;
    } else {
      // Fresh worker — boot prompt + context API for on-demand rich context
      taskPrompt = this.buildBootPrompt(agent, config, workerId, projectRoot, workspaceDir);
    }

    // Clone backend for per-worker callbacks
    const claudeBackend = backend as any;
    const onProgressOrig = claudeBackend.onProgress;
    const onPidOrig = claudeBackend.onPid;

    claudeBackend.onPid = (pid: number) => {
      this.db.updateAgent(workerId, { pid, status: 'active' });
      this.workerPids.set(workerId, pid);  // track for memory monitoring
    };

    // Start Claude Code process — with session resume if available
    const resultPromise = backend.execute({
      type: 'code',
      prompt: taskPrompt,
      sessionId: resumeSessionId,
      options: { cwd: projectRoot },
    });

    // Track the process for killing
    this.activeProcesses.set(workerId, {
      kill: () => {
        const agent = this.db.getAgent(workerId);
        if (agent?.pid) {
          try { process.kill(agent.pid, 'SIGTERM'); } catch { /* already dead */ }
        }
      },
    });

    console.log(`[WorkerPool] Spawned ${config.role} worker ${workerId} in ${projectRoot}`);

    // Handle completion asynchronously
    resultPromise.then((result: AIResult) => {
      // Restore original callbacks
      claudeBackend.onProgress = onProgressOrig;
      claudeBackend.onPid = onPidOrig;

      this.activeProcesses.delete(workerId);
      this.workerPids.delete(workerId);  // stop tracking memory

      const currentAgent = this.db.getAgent(workerId);
      if (!currentAgent) return;

      // Update session ID for future resume
      if (result.sessionId) {
        this.db.updateAgent(workerId, { sessionId: result.sessionId });
      }

      // Update budget
      if (result.cost) {
        this.db.updateAgent(workerId, { budgetSpent: (currentAgent.budgetSpent || 0) + result.cost });
      }

      console.log(`[WorkerPool] Worker ${workerId} finished — success=${result.success}, cost=$${result.cost?.toFixed(4) || '0'}`);

      // Issue 8: Merge worktree changes back to main repo BEFORE reporting
      // If merge fails after worker reported success, downgrade to failed
      let mergeOk = true;
      if (worktreePath) {
        try {
          this.mergeAndCleanupWorktree(workerId, worktreePath, result.success);
        } catch {
          mergeOk = false;
          console.warn(`[WorkerPool] Worktree merge failed for ${workerId} — downgrading status to failed`);
        }
      }

      // If worker didn't report via HTTP (crashed or timed out), auto-report
      if (currentAgent.status === 'active' || currentAgent.status === 'spawning') {
        const effectiveSuccess = result.success && mergeOk;
        const status = effectiveSuccess ? 'done' : 'failed';
        this.db.updateAgent(workerId, { status });

        // Build summary with full error details for orchestrator diagnosis
        const isResume = !!(currentAgent.sessionId);
        let summary: string;
        if (effectiveSuccess) {
          summary = `Worker completed. Output: ${result.output?.slice(0, 3000) || 'no output'}`;
        } else if (!mergeOk) {
          summary = `Worker completed but worktree merge failed — changes may be lost`;
        } else {
          const errMsg = result.error?.slice(0, 500) || 'Worker process failed';
          const exitCode = (result as any).exitCode ?? 'unknown';
          const stderr = (result as any).stderr?.slice(-500) || '';
          summary = `FAILED (exit=${exitCode}, resume=${isResume}): ${errMsg}`;
          if (stderr) summary += `\nStderr (last 500 chars): ${stderr}`;
        }
        if (effectiveSuccess) {
          try {
            const diffStat = execSync('git diff --stat HEAD~1', {
              cwd: config.workspaceDir || process.cwd(),
              encoding: 'utf-8',
              timeout: 5000,
              stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
            if (diffStat) {
              summary += `\n\nGit diff stat:\n${diffStat.slice(0, 500)}`;
            }
          } catch { /* no git or no commits — skip */ }
        }

        // Notify orchestrator
        this.messageBus.send({
          recipientId: config.orchestratorId,
          senderId: workerId,
          senderType: 'worker',
          type: 'worker_report',
          payload: {
            status: effectiveSuccess ? 'done' : 'failed',
            summary,
            taskId: config.taskId,
            auto: true,  // auto-generated, not from worker HTTP report
          },
          priority: effectiveSuccess ? 1 : 0,
        });
        console.log(`[WorkerPool] Auto-reported ${status} for worker ${workerId} to orchestrator`);
      }

      // Clear session ID so next spawn for this role starts fresh
      this.db.updateAgent(workerId, { sessionId: null });
    }).catch((err) => {
      claudeBackend.onProgress = onProgressOrig;
      claudeBackend.onPid = onPidOrig;
      this.activeProcesses.delete(workerId);
      this.workerPids.delete(workerId);  // stop tracking memory
      const agentBeforeCrash = this.db.getAgent(workerId);
      if (!agentBeforeCrash || !['done', 'failed', 'dissolved'].includes(agentBeforeCrash.status)) {
        this.db.updateAgent(workerId, { status: 'failed', pid: null });
      }
      console.error(`[WorkerPool] Worker ${workerId} crashed:`, err.message?.slice(0, 200));

      // Notify orchestrator about crash with full error details
      const crashAgent = this.db.getAgent(workerId);
      const wasResume = !!(crashAgent?.sessionId);
      try {
        this.messageBus.send({
          recipientId: config.orchestratorId,
          senderId: workerId,
          senderType: 'worker',
          type: 'worker_report',
          payload: {
            status: 'failed',
            summary: `CRASHED (resume=${wasResume}): ${err.message?.slice(0, 500) || 'unknown error'}${err.stack ? `\nStack: ${err.stack.slice(0, 300)}` : ''}`,
            taskId: config.taskId,
            auto: true,
          },
          priority: 0,
        });
      } catch { /* best-effort notification */ }

      // Issue 8: Clean up worktree — merge if worker reported done, discard if truly failed
      if (worktreePath) {
        const doneBeforeCleanup = this.db.getAgent(workerId);
        if (doneBeforeCleanup?.status === 'done') {
          try { this.mergeAndCleanupWorktree(workerId, worktreePath, true); } catch { this.cleanupWorktree(workerId, worktreePath); }
        } else {
          this.cleanupWorktree(workerId, worktreePath);
        }
      }
    });

    return workerId;
  }

  /**
   * Kill a worker process.
   */
  kill(workerId: string): void {
    const proc = this.activeProcesses.get(workerId);
    if (proc) {
      proc.kill();
      this.activeProcesses.delete(workerId);
    }
    this.workerPids.delete(workerId);

    const agent = this.db.getAgent(workerId);
    if (agent && !['done', 'failed', 'dissolved', 'idle'].includes(agent.status)) {
      this.db.updateAgent(workerId, { status: 'failed', pid: null });
    }
  }

  /**
   * Get worker status from database.
   */
  getStatus(workerId: string): WorkerStatus | null {
    const agent = this.db.getAgent(workerId);
    if (!agent || agent.type !== 'worker') return null;
    return {
      id: agent.id,
      role: agent.role,
      status: agent.status,
      taskId: agent.currentTaskId,
      pid: agent.pid,
      sessionId: agent.sessionId,
      budgetSpent: agent.budgetSpent,
      budgetLimit: agent.budgetLimit,
      lastReportAt: agent.lastReportAt,
      createdAt: agent.createdAt,
    };
  }

  /**
   * List all active workers.
   */
  listActive(): WorkerStatus[] {
    return this.db.listAgents({ type: 'worker', status: 'active' }).map(a => ({
      id: a.id,
      role: a.role,
      status: a.status,
      taskId: a.currentTaskId,
      pid: a.pid,
      sessionId: a.sessionId,
      budgetSpent: a.budgetSpent,
      budgetLimit: a.budgetLimit,
      lastReportAt: a.lastReportAt,
      createdAt: a.createdAt,
    }));
  }

  /** Phase 105: Expose template registry for role validation */
  getTemplateRegistry(): TemplateRegistry | null {
    return this.templateRegistry;
  }

  // ---- Issue 8: Worktree helpers ----

  /**
   * Merge worker worktree changes back to main repo, then clean up.
   * Called on successful completion. Attempts ff-only merge for commits,
   * or git diff + apply for uncommitted changes.
   */
  private mergeAndCleanupWorktree(workerId: string, wtPath: string, success: boolean): void {
    const mainRepo = process.cwd();
    const branchName = `worker/${workerId}`;

    if (!success) {
      this.cleanupWorktree(workerId, wtPath);
      return;
    }

    try {
      // Check if worktree branch has commits ahead of current branch
      const logOutput = execSync(`git log HEAD..${JSON.stringify(branchName)} --oneline`, {
        cwd: mainRepo,
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      if (logOutput) {
        // Commits exist — fast-forward merge into main repo
        execSync(`git merge ${JSON.stringify(branchName)} --ff-only`, {
          cwd: mainRepo,
          encoding: 'utf-8',
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        console.log(`[WorkerPool] Merged ${branchName} into main repo (ff-only)`);
      } else {
        // No commits — check for dirty (uncommitted) files in worktree
        const diff = execSync('git diff', {
          cwd: wtPath,
          encoding: 'utf-8',
          timeout: 10_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        if (diff) {
          // Apply the patch to the main repo
          execSync('git apply --allow-empty -', {
            cwd: mainRepo,
            input: diff,
            encoding: 'utf-8',
            timeout: 10_000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          console.log(`[WorkerPool] Applied uncommitted changes from ${workerId} worktree to main repo`);
        } else {
          console.log(`[WorkerPool] No changes in ${workerId} worktree to merge`);
        }
      }
    } catch (mergeErr: any) {
      console.warn(`[WorkerPool] Worktree merge failed for ${workerId}: ${mergeErr.message?.slice(0, 200)}`);
    }

    this.cleanupWorktree(workerId, wtPath);
  }

  /**
   * Remove a worker's git worktree and delete its branch.
   * Safe to call even if the worktree or branch doesn't exist.
   */
  private cleanupWorktree(workerId: string, wtPath: string): void {
    const mainRepo = process.cwd();
    const branchName = `worker/${workerId}`;

    try {
      execSync(`git worktree remove "${wtPath}" --force`, {
        cwd: mainRepo,
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* worktree may already be removed */ }

    try {
      execSync(`git branch -D "${branchName}"`, {
        cwd: mainRepo,
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { /* branch may not exist */ }

    // Also remove the directory if it lingers
    try {
      if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
    } catch { /* best-effort */ }

    console.log(`[WorkerPool] Cleaned up worktree for ${workerId}`);
  }

  /**
   * Read RSS (resident set size) of every tracked worker process.
   * Returns an array of { workerId, pid, rssBytes } for all active workers
   * whose PIDs could be read. Workers with dead/unreadable PIDs are omitted.
   *
   * Uses /proc/<pid>/status on Linux, tasklist on Windows, ps on macOS/other.
   */
  getWorkerMemoryStats(): { workerId: string; pid: number; rssBytes: number }[] {
    const stats: { workerId: string; pid: number; rssBytes: number }[] = [];
    for (const [workerId, pid] of this.workerPids) {
      const rssBytes = readPidRss(pid);
      if (rssBytes !== null) {
        stats.push({ workerId, pid, rssBytes });
      }
    }
    return stats;
  }

  /**
   * Kill any worker whose RSS exceeds 5 GB.
   * Called every 60 seconds by the watchdog interval.
   */
  private runMemoryWatchdog(): void {
    // Use system free RAM as the trigger, not a hard per-worker limit.
    // Claude Code sessions vary wildly in size depending on machine RAM — a 9GB worker is
    // fine on a 64GB EC2 but catastrophic on an 8GB laptop. Let the OS tell us when we're desperate.
    const TWO_GB  = 2 * 1024 * 1024 * 1024;
    const ONE_GB  = 1 * 1024 * 1024 * 1024;
    const freeRam = freemem();
    const freeMB  = Math.round(freeRam / (1024 * 1024));

    if (freeRam > TWO_GB) {
      // Plenty of RAM — let all workers live
      return;
    }

    const stats = this.getWorkerMemoryStats();
    if (stats.length === 0) return;

    const killWorker = (workerId: string, pid: number, rssBytes: number, reason: string) => {
      const mb = Math.round(rssBytes / (1024 * 1024));
      console.warn(`[WorkerPool] Watchdog: ${reason} Killing worker ${workerId} (PID ${pid}, RSS=${mb}MB).`);
      this.kill(workerId);
      const agent = this.db.getAgent(workerId);
      if (agent?.parentId) {
        this.messageBus.send({
          recipientId: agent.parentId,
          senderId: workerId,
          senderType: 'worker',
          type: 'worker_report',
          payload: {
            status: 'failed',
            summary: `Worker killed by memory watchdog: ${reason} System free RAM=${freeMB}MB, worker RSS=${mb}MB.`,
            taskId: agent.currentTaskId,
            auto: true,
          },
          priority: 0,
        });
      }
    };

    if (freeRam < ONE_GB) {
      // Emergency: kill ALL workers
      console.warn(`[WorkerPool] Watchdog: System free RAM critically low (${freeMB}MB < 1GB). Killing ALL workers.`);
      for (const { workerId, pid, rssBytes } of stats) {
        killWorker(workerId, pid, rssBytes, `System free RAM critically low (${freeMB}MB).`);
      }
    } else {
      // Desperate: kill only the largest worker
      const largest = stats.reduce((a, b) => a.rssBytes > b.rssBytes ? a : b);
      const largestMB = Math.round(largest.rssBytes / (1024 * 1024));
      console.warn(`[WorkerPool] Watchdog: System free RAM critically low (${freeMB}MB). Killing largest worker ${largest.workerId} (RSS=${largestMB}MB) to prevent OOM.`);
      killWorker(largest.workerId, largest.pid, largest.rssBytes, `System free RAM critically low (${freeMB}MB).`);
    }
  }

  /**
   * Clean up orphaned processes and old workspaces.
   * Called on startup and every 30 seconds to reap dead workers.
   */
  cleanup(): void {
    const activeWorkers = this.db.listAgents({ type: 'worker', status: 'active' });
    let reaped = 0;
    for (const worker of activeWorkers) {
      if (worker.pid && !this.activeProcesses.has(worker.id)) {
        // Check if process is actually running
        // process.kill(pid, 0) throws ESRCH if dead, EPERM if alive-but-unpermitted
        let alive = true;
        try {
          process.kill(worker.pid, 0);
        } catch (e: any) {
          if (e.code === 'ESRCH') alive = false;
          // EPERM = process exists but we can't signal it → still alive
        }
        if (!alive) {
          // Re-read agent status to avoid race: worker may have transitioned
          // to idle/done between the listAgents query and now
          const current = this.db.getAgent(worker.id);
          if (current && ['done', 'failed', 'dissolved', 'idle'].includes(current.status)) continue;
          this.db.updateAgent(worker.id, {
            status: 'failed',
            pid: null,
          });
          // Notify parent orchestrator so it can decide to retry or escalate
          if (worker.parentId) {
            this.messageBus.send({
              recipientId: worker.parentId,
              senderId: worker.id,
              senderType: 'worker',
              type: 'worker_report',
              payload: {
                status: 'failed',
                summary: 'Worker process died unexpectedly (reaped — process no longer running)',
                taskId: worker.currentTaskId,
                auto: true,
              },
              priority: 0,
            });
          }
          reaped++;
        }
      }
    }
    if (reaped > 0) {
      console.log(`[WorkerPool] Reaped ${reaped} dead worker(s) with stale 'active' status`);
    }
  }

  /**
   * Determine session strategy for a worker.
   */
  determineSessionStrategy(workerId: string): SessionStrategy {
    const agent = this.db.getAgent(workerId);
    if (!agent || !agent.sessionId) return 'fresh';

    // If worker has a current task that's in progress → resume
    if (agent.currentTaskId && agent.status === 'active') {
      return 'resume';
    }

    // If worker has a project but different task → rotate (new session, same workspace)
    if (agent.projectId) {
      return 'rotate';
    }

    return 'fresh';
  }

  /**
   * Find an existing worker that can be resumed for this config.
   * Matches by: same role + same orchestrator + has a session + not currently active.
   * Prefers workers with matching projectId. Returns null if no resumable worker found.
   */
  private findResumableWorker(config: WorkerConfig): AgentIdentity | null {
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    // Find completed/idle workers under this orchestrator with same role
    const candidates = this.db.listAgents({
      parentId: config.orchestratorId,
      type: 'worker' as AgentType,
      role: config.role,
    }).filter(w =>
      // Must have a session to resume
      w.sessionId &&
      // Must not be currently running
      !this.activeProcesses.has(w.id) &&
      // Must be in a resumable state (done, idle, or failed — not actively spawning/running)
      ['done', 'idle', 'failed'].includes(w.status) &&
      // Must be recent — stale sessions (>15 min since last activity) are not resumable.
      // Old sessions may have dead Claude Code processes, outdated context, or wrong task state.
      (w.lastReportAt || w.updatedAt || w.createdAt || '') >= fifteenMinAgo
    );

    if (candidates.length === 0) return null;

    // Prefer workers from the same project
    if (config.projectId) {
      const sameProject = candidates.find(w => w.projectId === config.projectId);
      if (sameProject) return sameProject;
    }

    // Otherwise return most recent worker with a session
    return candidates[0]; // listAgents returns DESC by created_at
  }

  /**
   * Build a slim boot prompt for fresh workers (~500 tokens).
   * Workers use the context API to query rich project/lesson context on demand.
   * Replaces the old 20,000 token assembleContext() dump for initial spawn.
   */
  private buildBootPrompt(
    agent: AgentIdentity,
    config: WorkerConfig,
    workerId: string,
    projectRoot: string,
    workspaceDir: string,
  ): string {
    const port = this.apiPort;
    const projectId = agent.projectId || config.projectId || null;
    const task = config.rolePrompt || 'Complete the assigned task.';
    const base = `http://localhost:${port}/v1`;

    // Resolve role workflow from template
    let roleWorkflow = '';
    let guardrails = '';
    if (agent.templateId && this.templateRegistry) {
      const tmpl = this.templateRegistry.getTemplate(agent.templateId);
      if (tmpl?.rolePrompt) {
        roleWorkflow = tmpl.rolePrompt;
      }
    }
    if (!roleWorkflow && this.templateRegistry) {
      const tmpl = this.templateRegistry.getByRole(agent.role);
      if (tmpl?.rolePrompt) roleWorkflow = tmpl.rolePrompt;
    }

    const lines: string[] = [];

    // Identity
    lines.push(`You are agent ${workerId} on the Pando network.`);
    lines.push(`Role: ${agent.role}. Reports to: ${agent.parentId || 'none'}.`);
    if (projectId) lines.push(`Project: ${projectId}`);
    lines.push(`Workspace: ${projectRoot}`);
    lines.push('');

    // Context API — query before starting
    lines.push('## Get Context Before Starting');
    lines.push('Query these endpoints to understand the project:');
    if (projectId) {
      lines.push(`  curl "${base}/context/project?id=${encodeURIComponent(projectId)}&task=${encodeURIComponent(task.slice(0, 80))}&workspaceDir=${encodeURIComponent(projectRoot)}"`);
    } else {
      lines.push(`  curl "${base}/context/project?workspaceDir=${encodeURIComponent(projectRoot)}"`);
    }
    lines.push(`  curl "${base}/context/lessons?role=${agent.role}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}"`);
    if (agent.parentId) {
      lines.push(`  curl "${base}/context/team?orchestratorId=${encodeURIComponent(agent.parentId)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}"`);
    }
    lines.push('');

    // Role workflow
    if (roleWorkflow) {
      lines.push('## Your Role');
      lines.push(roleWorkflow);
      lines.push('');
    }

    // Authority
    if (agent.authority) {
      try {
        const auth = JSON.parse(agent.authority);
        if (auth.files?.forbidden?.length || auth.commands?.forbidden?.length) {
          lines.push('## Restrictions');
          if (auth.files?.forbidden) lines.push(`Do NOT touch: ${JSON.stringify(auth.files.forbidden)}`);
          if (auth.commands?.forbidden) lines.push(`Do NOT run: ${JSON.stringify(auth.commands.forbidden)}`);
          lines.push('');
        }
      } catch { /* skip */ }
    }

    // Task
    lines.push('## Your Task');
    if (config.taskId) lines.push(`Task ID: ${config.taskId}`);
    lines.push(task);
    if (config.fileScope?.length) lines.push(`Files: ${config.fileScope.join(', ')}`);
    lines.push('');

    // Report and discover endpoints
    lines.push('## When You Finish');
    lines.push('Share discoveries:');
    lines.push(`  curl -s -X POST ${base}/context/discover -H "Content-Type: application/json" -d '{"agentId":"${workerId}","projectId":"${projectId || ''}","category":"convention","content":"<what you learned>"}'`);
    lines.push('Report done:');
    lines.push(`  curl -s -X POST ${base}/worker/${workerId}/report -H "Content-Type: application/json" --data-raw '{"status":"done","summary":"<what you did>","filesChanged":["list","of","files"]}'`);
    lines.push('');

    // Universal rules
    lines.push('## Rules');
    lines.push('- Query project context (above) before writing any code.');
    lines.push('- Read existing code before modifying it.');
    lines.push('- Build MUST pass before reporting done.');
    lines.push('- Never modify .env, .git/, or credential files.');
    lines.push('- Report stuck if blocked.');
    lines.push('');
    lines.push('Start working now.');

    return lines.join('\n');
  }

}

// ---------------------------------------------------------------------------
// Module-level helper: read RSS of a process by PID
// ---------------------------------------------------------------------------

/**
 * Read the RSS (Resident Set Size) of a process in bytes.
 * Returns null if the process is not found or the OS call fails.
 *
 * - Linux:   reads /proc/<pid>/status (VmRSS line)
 * - Windows: runs `tasklist /FI "PID eq <pid>" /FO CSV /NH`
 * - macOS/other: runs `ps -o rss= -p <pid>`
 */
function readPidRss(pid: number): number | null {
  if (process.platform === 'linux') {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (m) return parseInt(m[1], 10) * 1024;
    } catch { /* process may have exited */ }
    return null;
  }

  if (process.platform === 'win32') {
    try {
      const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf-8',
        timeout: 5_000,
      });
      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.trim().split('\n')) {
          if (!line.trim() || line.includes('INFO:')) continue;
          // CSV columns: "Image","PID","Session","Sess#","Mem Usage"
          const cols = line.split('","');
          if (cols.length >= 5) {
            // last col may end with `"` — strip non-numeric chars then parse KB
            const memStr = cols[4].replace(/[^0-9]/g, '');
            if (memStr) return parseInt(memStr, 10) * 1024;
          }
        }
      }
    } catch { /* tasklist failed */ }
    return null;
  }

  // macOS / other POSIX
  try {
    const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    if (result.status === 0 && result.stdout) {
      const kb = parseInt(result.stdout.trim(), 10);
      if (!isNaN(kb)) return kb * 1024;
    }
  } catch { /* ps failed */ }
  return null;
}
