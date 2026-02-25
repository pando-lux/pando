/**
 * Scheduler — Thin task queue + approval wrapper (Phase 27).
 *
 * The Scheduler no longer spawns agents or creates workspaces. That
 * responsibility moved to AgentManager. The Scheduler:
 *   - Manages the approved-task queue
 *   - Tracks basic metrics (totalProcessed, totalSucceeded, totalFailed)
 *   - Emits task:completed / task:failed events
 *   - Provides a bridge queue reference for forwarding results
 *   - Handles parent/child cascade completion logic
 *   - Recovers orphaned tasks on startup
 *   - Auto-archives old tasks
 */

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { TaskQueue, Task, TaskCost } from './task-queue.js';
import type { FileRegistry } from './file-registry.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { ResourceRouter } from './resource-router.js';
import type { ResourceMeter } from './resource-meter.js';
import { NodeCapability } from '@pando/shared';
import type { BridgeQueue } from '../core/bridge-queue.js';

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface SchedulerConfig {
  pollIntervalMs: number;         // Default: 10000 (check queue every 10s)
  maxConcurrentTasks: number;     // Default: 2
  maxTaskDepth: number;           // Default: 3 (task -> sub-task -> sub-sub-task)
  workspaceBaseDir: string;       // Legacy — unused in Phase 27
  apiPort: number;                // Default: 4000 (HTTP API port for health checks)
}

export type TaskLifecycle = 'dormant' | 'ready' | 'running' | 'sleeping' | 'done' | 'failed';

export interface ActiveTask {
  taskId: string;
  lifecycle: TaskLifecycle;
  startedAt: number;
  pid?: number;
}

export interface SchedulerStatus {
  running: boolean;
  activeTasks: ActiveTask[];
  config: SchedulerConfig;
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed: number;
  approvedQueueLength?: number;
}

// ── Default config ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: SchedulerConfig = {
  pollIntervalMs: 10_000,
  maxConcurrentTasks: 2,
  maxTaskDepth: 3,
  workspaceBaseDir: join(homedir(), '.pando', 'workspaces'),
  apiPort: 4000,
};

// ── Scheduler Class ─────────────────────────────────────────────────────────

export class Scheduler extends EventEmitter {
  private config: SchedulerConfig;
  private taskQueue: TaskQueue;
  private fileRegistry: FileRegistry | null = null;
  private bridgeQueue: BridgeQueue | null = null;
  private claudePath: string;
  private dataDir: string;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Per-task output streaming emitters (for SSE — kept for backward compat)
  private taskEmitters: Map<string, EventEmitter> = new Map();

  // Cleanup counter (run maintenance every N poll cycles)
  private cleanupCounter = 0;
  private lastArchiveTime = 0;

  // Reputation callback (Phase 10.3) — called on task complete/fail/timeout
  private reputationCallback?: (type: string, detail: string, metadata?: Record<string, any>) => void;

  private nodeCapabilities: string[] = [];
  private capabilityRegistry: CapabilityRegistry | null = null;
  private resourceRouter: ResourceRouter | null = null;
  private resourceMeter: ResourceMeter | null = null;

  // Manager mode: queue of task IDs approved by managers for execution
  private approvedQueue: string[] = [];

  // Manager mode: profiles attached to tasks by managers at approval time
  // Stored as `any` — AgentManager retrieves these when picking up tasks
  private approvedProfiles: Map<string, any> = new Map();

  // Manager mode: callbacks fired when an approved task finishes execution
  private resultCallbacks: Map<string, (taskId: string, success: boolean, output: string) => void> = new Map();

  // Stats
  private totalProcessed = 0;
  private totalSucceeded = 0;
  private totalFailed = 0;

  constructor(
    config: Partial<SchedulerConfig>,
    taskQueue: TaskQueue,
    _profileCache: any,       // Legacy — ignored (Phase 27)
    _workspaceManager: any,   // Legacy — ignored (Phase 27)
    claudePath?: string,
    dataDir?: string,
    private rewardWork?: (workType: string, workProof: string) => void,
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.taskQueue = taskQueue;
    this.dataDir = dataDir || join(homedir(), '.pando');
    // claudePath kept for reference but no longer used for spawning
    this.claudePath = claudePath || 'claude';
    if (rewardWork) this.rewardWork = rewardWork;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Set the FileRegistry so the scheduler can clear stale claims on startup.
   */
  setFileRegistry(registry: FileRegistry): void {
    this.fileRegistry = registry;
  }

  /**
   * Set the BridgeQueue so the Scheduler can enqueue task results for the Manager.
   */
  setBridgeQueue(queue: BridgeQueue): void {
    this.bridgeQueue = queue;
    console.log('[scheduler] BridgeQueue attached');
  }

  /**
   * Get the BridgeQueue reference (null if not wired yet).
   */
  getBridgeQueue(): BridgeQueue | null {
    return this.bridgeQueue;
  }

  /**
   * Start the scheduler (begins polling the task queue).
   */
  start(): void {
    if (this.running) {
      console.log('[scheduler] Already running.');
      return;
    }
    this.running = true;

    // Recover orphaned in_progress/claimed tasks from a previous crash
    this.recoverOrphanedTasks();

    // Clear stale file claims from previous session (BUG-04)
    if (this.fileRegistry) {
      const staleCount = this.fileRegistry.clearAll();
      if (staleCount > 0) {
        console.log(`[scheduler] File registry cleared — ${staleCount} stale claims removed`);
      } else {
        console.log('[scheduler] File registry clean — 0 claims');
      }
    }

    console.log(`[scheduler] Started. Polling every ${this.config.pollIntervalMs}ms, max ${this.config.maxConcurrentTasks} concurrent tasks.`);

    // Run first poll immediately
    this.poll().catch(err => {
      console.error(`[scheduler] Poll error: ${err.message}`);
    });

    // Then on interval
    this.pollTimer = setInterval(() => {
      this.poll().catch(err => {
        console.error(`[scheduler] Poll error: ${err.message}`);
      });
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    console.log('[scheduler] Stopped.');
  }

  /**
   * Get the task queue used by this scheduler.
   */
  getTaskQueue(): TaskQueue {
    return this.taskQueue;
  }

  /**
   * Get the current status of the scheduler.
   */
  getStatus(): SchedulerStatus {
    return {
      running: this.running,
      activeTasks: [],
      config: { ...this.config },
      totalProcessed: this.totalProcessed,
      totalSucceeded: this.totalSucceeded,
      totalFailed: this.totalFailed,
      approvedQueueLength: this.approvedQueue.length,
    };
  }

  /**
   * Get the output streaming emitter for a task (used by SSE endpoint).
   * Returns null if task has no emitter.
   */
  getTaskEmitter(taskId: string): EventEmitter | null {
    return this.taskEmitters.get(taskId) || null;
  }

  /**
   * Register a task emitter for SSE streaming (called by AgentManager).
   */
  setTaskEmitter(taskId: string, emitter: EventEmitter): void {
    this.taskEmitters.set(taskId, emitter);
  }

  /**
   * Get persisted log content for a task.
   * Returns an array of { file, lines } objects — one per log file found
   * in the workspace (e.g. agent-stream.log).
   */
  getTaskLogs(taskId: string): { file: string; lines: string[] }[] {
    const wsDir = join(this.config.workspaceBaseDir, taskId);
    if (!existsSync(wsDir)) return [];

    try {
      const { readdirSync } = require('node:fs');
      const entries = readdirSync(wsDir);
      const logFiles = entries.filter((f: string) => f.startsWith('agent-stream') && f.endsWith('.log'));

      return logFiles.map((file: string) => {
        const content = readFileSync(join(wsDir, file), 'utf-8');
        const lines = content.split('\n').filter((l: string) => l.trim());
        return { file, lines };
      });
    } catch {
      return [];
    }
  }

  /**
   * Set a callback for reputation events (Phase 10.3).
   */
  setReputationCallback(cb: (type: string, detail: string, metadata?: Record<string, any>) => void): void {
    this.reputationCallback = cb;
  }

  /**
   * Set a callback for broadcasting high-scoring profiles (Phase 10.2).
   * Phase 27: No-op — profile broadcasting moved to AgentManager.
   */
  setProfileBroadcaster(_fn: any): void {
    // No-op — kept for backward compat with index.ts wiring
  }

  /**
   * Set a callback for publishing graduated memories to the network.
   * Phase 27: No-op — memory publishing moved to AgentManager.
   */
  setMemoryPublisher(_fn: any): void {
    // No-op — kept for backward compat with index.ts wiring
  }

  /**
   * Set a callback for injecting shared memories into workspaces.
   * Phase 27: No-op — memory injection moved to AgentManager.
   */
  setMemoryInjector(_fn: any): void {
    // No-op — kept for backward compat with index.ts wiring
  }

  setNodeCapabilities(capabilities: string[]): void {
    this.nodeCapabilities = capabilities;
  }

  /**
   * Set the CapabilityRegistry for resource-based capability checks.
   */
  setCapabilityRegistry(registry: CapabilityRegistry): void {
    this.capabilityRegistry = registry;
    console.log('[scheduler] CapabilityRegistry attached');
  }

  /**
   * Set the ResourceRouter for smart task routing (Phase B).
   */
  setResourceRouter(router: ResourceRouter): void {
    this.resourceRouter = router;
    console.log('[scheduler] ResourceRouter attached');
  }

  /**
   * Set the ResourceMeter for tracking resource usage (Phase C).
   */
  setResourceMeter(meter: ResourceMeter): void {
    this.resourceMeter = meter;
    console.log('[scheduler] ResourceMeter attached');
  }

  /**
   * Receive a task that has been approved by a Manager.
   * The Manager has already decided this task should run — it is queued
   * for pickup by the AgentManager.
   */
  async receiveApprovedTask(taskId: string, managerId: string, profile?: any): Promise<void> {
    const task = this.taskQueue.getTask(taskId);
    if (!task) {
      console.error(`[scheduler] receiveApprovedTask: task ${taskId} not found`);
      return;
    }

    // Capability check — reject before queuing if clearly incapable
    if (this.capabilityRegistry) {
      const resourceReqs = task.requiredResources;
      if (resourceReqs && resourceReqs.length > 0 && !this.capabilityRegistry.canExecuteLocally(resourceReqs)) {
        console.log(`[scheduler] Rejecting task ${taskId.slice(0, 8)}: local node missing resource capabilities [${resourceReqs.join(', ')}]`);
        this.taskQueue.pushTimelineEvent(taskId, {
          event: 'capability_rejected',
          detail: `Local node cannot execute: missing resources [${resourceReqs.join(', ')}]`,
          metadata: { managerId, missingResources: resourceReqs },
        });
        return;
      }
    }

    // Store the attached profile so AgentManager can retrieve it
    if (profile) {
      this.approvedProfiles.set(taskId, profile);
    }

    console.log(`[scheduler] Received approved task ${taskId.slice(0, 8)} from manager ${managerId}: ${task.title}${profile ? ` (profile: ${profile.profileId})` : ''}`);
    this.taskQueue.pushTimelineEvent(taskId, {
      event: 'manager_approved',
      detail: `Task approved by manager ${managerId}${profile ? ` with profile ${profile.profileId}` : ''}`,
      metadata: { managerId, profileId: profile?.profileId },
    });

    this.approvedQueue.push(taskId);

    // Notify listeners (index.ts wires this to AgentManager's bridge queue)
    this.emit('task:approved', { taskId, managerId: task?.managerId || null });
  }

  /**
   * Dequeue the next approved task for execution by AgentManager.
   * Returns { taskId, profile } or null if queue is empty.
   */
  dequeueApproved(): { taskId: string; profile: any } | null {
    while (this.approvedQueue.length > 0) {
      const taskId = this.approvedQueue[0];
      const task = this.taskQueue.getTask(taskId);

      if (!task) {
        this.approvedQueue.shift();
        continue;
      }

      // Skip tasks that are no longer open
      if (task.status !== 'open') {
        this.approvedQueue.shift();
        this.approvedProfiles.delete(taskId);
        continue;
      }

      // W8: Dependency tracking — skip tasks whose dependencies are not yet resolved
      if (task.dependencies && task.dependencies.length > 0) {
        const blockedByIds: string[] = [];
        for (const depId of task.dependencies) {
          const depTask = this.taskQueue.getTask(depId);
          if (!depTask || (depTask.status !== 'done' && depTask.status !== 'rejected' && depTask.status !== 'archived')) {
            blockedByIds.push(depId);
          }
        }
        if (blockedByIds.length > 0) {
          // Move to back of queue so other tasks can proceed
          this.approvedQueue.shift();
          this.approvedQueue.push(taskId);
          return null;
        }
      }

      // Capability check
      if (this.capabilityRegistry) {
        const resourceReqs = task.requiredResources;
        if (resourceReqs && resourceReqs.length > 0 && !this.capabilityRegistry.canExecuteLocally(resourceReqs)) {
          this.approvedQueue.shift();
          this.approvedProfiles.delete(taskId);
          continue;
        }
      }
      // Legacy NodeCapability string check
      const required = (task.requiredCapabilities && task.requiredCapabilities.length > 0)
        ? task.requiredCapabilities
        : [NodeCapability.CLAUDE_CODE];
      const missing = required.filter((c: string) => !this.nodeCapabilities.includes(c));
      if (missing.length > 0) {
        this.approvedQueue.shift();
        this.approvedProfiles.delete(taskId);
        continue;
      }

      // Dequeue and return
      this.approvedQueue.shift();
      const profile = this.approvedProfiles.get(taskId);
      this.approvedProfiles.delete(taskId);
      return { taskId, profile };
    }

    return null;
  }

  /**
   * Get the number of approved tasks waiting in queue.
   */
  getApprovedQueueLength(): number {
    return this.approvedQueue.length;
  }

  /**
   * Register a callback to be notified when a specific task finishes execution.
   * Used by managers to learn about task outcomes without polling.
   * The callback is automatically removed after it fires.
   */
  onTaskResult(taskId: string, callback: (taskId: string, success: boolean, output: string) => void): void {
    this.resultCallbacks.set(taskId, callback);
  }

  /**
   * Report a task as completed (called by AgentManager after execution).
   */
  reportTaskCompleted(taskId: string, output: string, cost?: TaskCost): void {
    this.totalProcessed++;
    this.totalSucceeded++;

    const task = this.taskQueue.getTask(taskId);
    const title = task?.title || taskId;

    this.emit('task:completed', { taskId, output: output.slice(0, 500), title });
    this.reputationCallback?.('task_completed', `Task completed: ${title.slice(0, 50)}`, {
      buildPassed: true,
    });

    // Emit Lux reward for task completion
    if (this.rewardWork) {
      this.rewardWork('task_completed', `task completed: ${title.slice(0, 50)}`);
    }

    // Phase C: Record resource usage
    if (this.resourceMeter && cost?.durationMs) {
      const durationMin = cost.durationMs / 60_000;
      this.resourceMeter.recordUsage(this.taskQueue.getLocalPeerId?.() || '', 'compute_cpu', {
        resourceType: 'compute_cpu',
        quantity: durationMin,
        unit: 'minutes',
        taskId,
        timestamp: Date.now(),
      });
    }
    // Phase B: Report resource recovery on success
    if (this.resourceRouter) {
      const localPeerId = this.taskQueue.getLocalPeerId?.() || '';
      if (localPeerId) {
        this.resourceRouter.reportResourceRecovery(localPeerId, 'compute_cpu');
      }
    }

    // Check if this subtask's parent should be marked done
    if (task?.parentTask) {
      this.checkParentCompletion(task.parentTask);
    }

    this.fireResultCallback(taskId, true, output.slice(0, 2000));
  }

  /**
   * Report a task as failed (called by AgentManager after execution).
   */
  reportTaskFailed(taskId: string, error: string): void {
    this.totalProcessed++;
    this.totalFailed++;

    const task = this.taskQueue.getTask(taskId);
    const title = task?.title || taskId;

    this.emit('task:failed', { taskId, error });
    this.reputationCallback?.('task_failed', `Task failed: ${title.slice(0, 50)}: ${error.slice(0, 80)}`);

    // Phase B: Report resource failure for error correction
    if (this.resourceRouter) {
      const localPeerId = this.taskQueue.getLocalPeerId?.() || '';
      if (localPeerId) {
        this.resourceRouter.reportResourceFailure(localPeerId, 'compute_cpu', error);
      }
    }

    // Enqueue task failure to Bridge Queue for Manager review
    try {
      if (this.bridgeQueue && task) {
        const managerId = task.managerId || 'pando-node-mgr';
        this.bridgeQueue.enqueue(managerId, {
          type: 'task_failed',
          source: 'scheduler',
          payload: {
            taskId,
            result: { stdout: error.slice(0, 4000), exitCode: 1 },
          },
          priority: 'normal',
        });
      }
    } catch (bridgeErr: any) {
      console.error(`[scheduler] Failed to enqueue task_failed to bridge for ${taskId.slice(0, 8)}: ${bridgeErr.message}`);
    }

    this.fireResultCallback(taskId, false, error);
  }

  /**
   * Update config at runtime.
   */
  updateConfig(updates: Partial<SchedulerConfig>): void {
    if (updates.pollIntervalMs !== undefined) {
      this.config.pollIntervalMs = updates.pollIntervalMs;
      // Restart polling with new interval
      if (this.running && this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = setInterval(() => {
          this.poll().catch(err => {
            console.error(`[scheduler] Poll error: ${err.message}`);
          });
        }, this.config.pollIntervalMs);
      }
    }
    if (updates.maxConcurrentTasks !== undefined) {
      this.config.maxConcurrentTasks = updates.maxConcurrentTasks;
    }
    if (updates.maxTaskDepth !== undefined) {
      this.config.maxTaskDepth = updates.maxTaskDepth;
    }
  }

  // ── Core Loop ─────────────────────────────────────────────────────────────

  /**
   * Single poll cycle: maintenance tasks — parent completion scan,
   * emitter cleanup, task archiving.
   *
   * Phase 27: The poll loop no longer dequeues or spawns tasks.
   * AgentManager calls dequeueApproved() to pick up approved tasks.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    this.cleanupCounter++;

    // Task expiry cleanup every poll cycle:
    // - Open tasks >48h old → expired
    // - Done/rejected/expired tasks >7d old → removed entirely
    this.taskQueue.cleanupExpiredTasks();

    // Sweep stale taskEmitters every 10th cycle to prevent memory leaks (TD-11)
    if (this.cleanupCounter % 10 === 0) {
      this.sweepStaleEmitters();
    }

    // BUG-02 safety net: Scan all in_progress parent tasks with children
    // and auto-complete parents when all children are terminal (done/rejected).
    if (this.cleanupCounter % 6 === 0) {
      this.safetyNetParentCompletionScan();
    }

    // Auto-archive old done/rejected tasks once per hour
    const now = Date.now();
    if (now - this.lastArchiveTime >= 3_600_000) {
      this.lastArchiveTime = now;
      this.taskQueue.archiveOldTasks();
    }
  }

  // ── Result Callback (Manager Mode) ──────────────────────────────────────

  /**
   * Fire the result callback for a task if one was registered via onTaskResult().
   * Removes the callback after firing (one-shot).
   */
  private fireResultCallback(taskId: string, success: boolean, output: string): void {
    const cb = this.resultCallbacks.get(taskId);
    if (cb) {
      this.resultCallbacks.delete(taskId);
      try {
        cb(taskId, success, output);
      } catch (err: any) {
        console.error(`[scheduler] Result callback error for ${taskId.slice(0, 8)}: ${err.message}`);
      }
    }
  }

  // ── Orphaned Task Recovery ─────────────────────────────────────────────

  /**
   * On startup, scan the task DB for tasks stuck in 'claimed' or 'in_progress'
   * from a previous session. Reset them to 'open' so they can be re-claimed.
   */
  private recoverOrphanedTasks(): void {
    try {
      const claimed = this.taskQueue.getTasks({ status: 'claimed' });
      const inProgress = this.taskQueue.getTasks({ status: 'in_progress' });
      const allStuck = [...claimed, ...inProgress];

      let recovered = 0;
      for (const task of allStuck) {
        // Skip tasks claimed by a remote node
        if (task.claimedByNode && task.claimedByNode !== 'local' && task.executedByNode) {
          continue;
        }

        this.taskQueue.updateStatus(task.id, 'open');
        this.taskQueue.pushTimelineEvent(task.id, {
          event: 'orphan_recovered',
          detail: `Reset from '${task.status}' to 'open' on startup (no active process)`,
        });
        recovered++;
      }

      if (recovered > 0) {
        console.log(`[scheduler] Recovered ${recovered} orphaned task(s) to 'open' status`);
      }
    } catch (err: any) {
      console.error(`[scheduler] Failed to recover orphaned tasks: ${err.message}`);
    }
  }

  /**
   * Sweep stale taskEmitters to prevent unbounded Map growth (TD-11).
   */
  private sweepStaleEmitters(): void {
    for (const taskId of this.taskEmitters.keys()) {
      const task = this.taskQueue.getTask(taskId);
      if (task && (task.status === 'open' || task.status === 'claimed' || task.status === 'in_progress')) continue;
      // Task is done/rejected/missing — remove stale emitter
      this.taskEmitters.delete(taskId);
    }
  }

  // ── Parent/Child Task Completion ──────────────────────────────────────

  /**
   * Check if all children of a parent task are terminal (done or rejected).
   * If so, mark the parent as done.
   */
  private checkParentCompletion(parentId: string): void {
    const parent = this.taskQueue.getTask(parentId);
    if (!parent) return;

    // If parent is already done, clean up any orphaned children
    if (parent.status === 'done' && parent.childTasks) {
      this.cancelOrphanedChildren(parent);
      return;
    }

    // Check if all children are terminal
    const childIds = (parent.childTasks || []).filter(id => id !== parentId);
    if (childIds.length === 0) return;
    const allTerminal = childIds.every(childId => {
      const child = this.taskQueue.getTask(childId);
      return child && (child.status === 'done' || child.status === 'rejected');
    });
    if (!allTerminal) return;

    if (parent.status === 'done' || parent.status === 'rejected') return;

    const allDone = childIds.every(childId => {
      const child = this.taskQueue.getTask(childId);
      return child && child.status === 'done';
    });

    if (allDone) {
      console.log(`[scheduler] Cascade completion: all ${childIds.length} subtasks done for parent ${parentId.slice(0, 8)} — marking parent as done`);
      this.taskQueue.pushTimelineEvent(parentId, {
        event: 'completed',
        detail: 'All subtasks completed successfully — parent task done (cascade)',
        metadata: { childTasks: parent.childTasks, childCount: childIds.length },
      });
      this.taskQueue.completeTask(parentId, {
        buildPassed: true,
        note: `Parent task completed: all ${parent.childTasks?.length || 0} subtasks done`,
      });
    } else {
      const rejectedChildren = childIds.filter(childId => {
        const child = this.taskQueue.getTask(childId);
        return child && child.status === 'rejected';
      });
      console.log(`[scheduler] Cascade rejection: ${rejectedChildren.length}/${childIds.length} subtasks rejected for parent ${parentId.slice(0, 8)} — marking parent as rejected`);
      this.taskQueue.pushTimelineEvent(parentId, {
        event: 'rejected',
        detail: `Parent rejected: ${rejectedChildren.length} of ${childIds.length} subtasks were rejected`,
        metadata: { childTasks: parent.childTasks, childCount: childIds.length, rejectedCount: rejectedChildren.length },
      });
      this.taskQueue.updateStatus(parentId, 'rejected');
      this.taskQueue.setResultNote(parentId, `Parent rejected: ${rejectedChildren.length} of ${childIds.length} subtasks failed`);
    }

    if (allDone) {
      this.emit('task:completed', { taskId: parentId, output: 'All subtasks completed' });
    } else {
      this.emit('task:failed', { taskId: parentId, error: 'Some subtasks were rejected' });
    }

    // BUG-02 fix: Recursively check if the parent's own parent should also complete
    if (parent.parentTask) {
      const cascadeVerb = allDone ? 'completed' : 'rejected';
      console.log(`[scheduler] Cascade ${cascadeVerb}: parent ${parentId.slice(0, 8)} ${cascadeVerb} — recursively checking grandparent ${parent.parentTask.slice(0, 8)}`);
      this.checkParentCompletion(parent.parentTask);
    }
  }

  /**
   * BUG-02 safety net: Scan all in_progress tasks that have children and
   * auto-complete parents when all children are terminal.
   */
  private safetyNetParentCompletionScan(): void {
    const parentCandidates = this.taskQueue.getTasks({
      status: ['open', 'claimed', 'in_progress'] as any,
    });

    let completedCount = 0;

    for (const task of parentCandidates) {
      if (!task.childTasks || task.childTasks.length === 0) continue;

      const childIds = task.childTasks.filter(id => id !== task.id);
      if (childIds.length === 0) continue;

      const allTerminal = childIds.every(childId => {
        const child = this.taskQueue.getTask(childId);
        return child && (child.status === 'done' || child.status === 'rejected');
      });

      if (allTerminal) {
        console.log(`[scheduler] Safety net: parent ${task.id.slice(0, 8)} has all ${childIds.length} children terminal — triggering cascade completion`);
        this.checkParentCompletion(task.id);
        completedCount++;
      }
    }

    if (completedCount > 0) {
      console.log(`[scheduler] Safety net scan: completed ${completedCount} parent tasks`);
    }
  }

  /**
   * Cancel orphaned children of a completed parent task.
   */
  private cancelOrphanedChildren(parent: Task): void {
    if (!parent.childTasks) return;
    for (const childId of parent.childTasks) {
      const child = this.taskQueue.getTask(childId);
      if (!child) continue;
      if (child.status === 'done' || child.status === 'rejected') continue;

      const reason = `Orphaned: parent task ${parent.id.slice(0, 8)} completed directly`;
      console.log(`[scheduler] Cancelling orphaned child ${childId.slice(0, 8)}: ${reason}`);
      this.taskQueue.pushTimelineEvent(childId, {
        event: 'cancelled',
        detail: reason,
        metadata: { parentTaskId: parent.id, parentStatus: parent.status },
      });
      this.taskQueue.updateStatus(childId, 'rejected');
      this.taskQueue.setResultNote(childId, reason);
    }
  }
}
