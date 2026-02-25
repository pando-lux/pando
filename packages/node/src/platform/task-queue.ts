/**
 * Task Queue — SQLite-backed task management for agent coordination.
 *
 * Structured, priority-ordered task queue with atomic claims, file conflict
 * detection, and dependency tracking. Persisted to SQLite via TaskDatabase
 * (task-database.ts). On first startup, migrates from the legacy JSON file
 * (tasks.json) if present.
 *
 * Design: docs/architecture/agent-system.md (Task Coordination Layer)
 */

import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { MessageType, QaTier } from '@pando/shared';
import type { ThreadMessage, ResourceType } from '@pando/shared';
import type { PandoNetwork } from '../kernel/network.js';
import { openTaskDatabase, TaskDatabase } from './task-database.js';

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type TaskStatus = 'open' | 'claimed' | 'in_progress' | 'review' | 'done' | 'rejected' | 'archived' | 'expired';

export interface TaskResult {
  commitHash?: string;
  buildPassed?: boolean;
  testsPassed?: boolean;
  approved?: boolean;
  approvedBy?: string;
  note?: string;
}

export interface TaskTimelineEvent {
  timestamp: string;  // ISO 8601
  event: string;      // e.g. "created", "claimed", "planner_called", "profile_generated", "workspace_created", "agent_spawned", "completed", "failed"
  detail: string;     // Human-readable description
  metadata?: Record<string, any>;  // Extra data (profileId, tier, workspacePath, etc.)
}

export interface TaskRoleMetadata {
  roleId: string;                 // "architect", "auth-specialist", etc.
  responsibility: string;
  projectId: string;              // Links all roles in this project
  verificationNeeded: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  createdBy: string;
  assignedTo: string | null;
  files: string[];
  dependencies: string[];
  createdAt: number;
  updatedAt: number;
  result?: TaskResult;
  origin?: string; // peerId of originating node (local peerId for local, remote peerId for synced)
  timeline?: TaskTimelineEvent[];
  parentTask?: string;    // ID of the parent task (if this is a subtask)
  childTasks?: string[];  // IDs of subtasks (if this is a parent)
  roleMetadata?: TaskRoleMetadata;  // Dynamic role info (set by Project Planner)
  // Phase 8: Cross-node coordination
  claimedByNode?: string;   // peerId of the node that claimed this task
  claimedAt?: number;        // timestamp when task was claimed (for conflict resolution)
  originNode?: string;       // peerId of the node that submitted this task
  executedByNode?: string;   // peerId of the node that executed/completed this task
  // Cost tracking
  cost?: TaskCost;
  // Phase 15.2: Link to governance proposal that created this task
  proposalId?: string;
  /** QA tier for this task — set by Planner, read by Scheduler */
  qaTier?: QaTier;
  /** Conversation thread for this task (Phase 18.3) */
  thread?: ThreadMessage[];
  requiredCapabilities?: string[];
  /** Phase A: Resource types required for execution */
  requiredResources?: ResourceType[];
  /** Phase 19.2: ID of the manager that approved this task creation */
  managerId?: string;
}

export interface TaskCost {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  tier?: string;
  model?: string;
}

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['claimed', 'rejected', 'done', 'expired'],
  claimed: ['in_progress', 'open', 'done', 'rejected'],
  in_progress: ['review', 'open', 'done', 'rejected'],
  review: ['done', 'rejected'],
  done: ['rejected', 'archived'],
  rejected: ['archived'],
  archived: [],
  expired: ['archived'],
};

export class TaskQueue {
  private db: TaskDatabase;
  private agentDir: string;
  private network: PandoNetwork | null = null;

  constructor(dataDir?: string) {
    const base = dataDir || join(homedir(), '.pando');
    this.agentDir = join(base, 'agent');
    mkdirSync(this.agentDir, { recursive: true });

    // Open SQLite database
    const sqliteDb = openTaskDatabase(this.agentDir);
    this.db = new TaskDatabase(sqliteDb);

    // One-time migration from JSON if needed
    this.migrateFromJson();
  }

  // ── Migration ──

  private migrateFromJson(): void {
    const jsonPath = join(this.agentDir, 'tasks.json');
    if (!existsSync(jsonPath)) return;

    // Check if DB already has data (don't double-migrate)
    const stats = this.db.getStats();
    if ((stats.total || 0) > 0) return;

    try {
      const raw = readFileSync(jsonPath, 'utf-8');
      const store = JSON.parse(raw);
      const tasks: Task[] = store.tasks || [];

      this.db.transaction(() => {
        for (const task of tasks) {
          this.db.insertTask(task);
          // Insert related data
          if (task.files?.length) this.db.setFiles(task.id, task.files);
          if (task.dependencies?.length) this.db.setDependencies(task.id, task.dependencies);
          if (task.childTasks?.length) this.db.setChildren(task.id, task.childTasks);
          if (task.timeline?.length) {
            for (const evt of task.timeline) this.db.insertTimelineEvent(task.id, evt);
          }
          if (task.thread?.length) {
            for (const msg of task.thread) this.db.insertThreadMessage(msg);
          }
        }
      });

      // Rename old file (don't delete — safety)
      renameSync(jsonPath, jsonPath + '.migrated');
      console.log(`[task-queue] Migrated ${tasks.length} tasks from JSON to SQLite`);
    } catch (err) {
      console.error('[task-queue] JSON migration failed:', err);
    }
  }

  // ── Transition validation ──

  private isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed) return false;
    if (allowed.includes(to)) return true;
    console.warn(`[task-queue] Invalid state transition: ${from} → ${to} — skipping`);
    return false;
  }

  setNetwork(network: PandoNetwork): void {
    this.network = network;
  }

  private emitTaskEvent(type: 'created' | 'claimed' | 'completed' | 'timeline', task: Task, extra?: { output?: string; duration?: number; timelineEvent?: TaskTimelineEvent }): void {
    if (!this.network) return;
    let taskPayload: any;
    if (type === 'created') {
      taskPayload = task; // send full task for remote insertion
    } else if (type === 'claimed') {
      taskPayload = {
        id: task.id, title: task.title, priority: task.priority,
        status: task.status, assignedTo: task.assignedTo,
        claimedByNode: task.claimedByNode, claimedAt: task.claimedAt,
      };
    } else if (type === 'timeline') {
      // Timeline event — minimal task info + the timeline event itself
      taskPayload = { id: task.id, title: task.title };
    } else {
      // completed — include cross-node tracking fields
      taskPayload = {
        id: task.id, title: task.title, priority: task.priority,
        status: task.status, assignedTo: task.assignedTo, result: task.result,
        executedByNode: task.executedByNode, originNode: task.originNode,
      };
    }
    const payload: any = { type, task: taskPayload };
    // For timeline events, include the timeline event data and executing node
    if (type === 'timeline' && extra?.timelineEvent) {
      payload.timelineEvent = extra.timelineEvent;
      payload.executingNode = this.localPeerId;
    }
    // For completed events, include output (truncated at 3KB) and duration
    if (type === 'completed' && extra) {
      if (extra.output) {
        payload.output = extra.output.length > 3072
          ? extra.output.slice(0, 3072) + '\n\n[Output truncated. Query executing node for full result.]'
          : extra.output;
      }
      if (extra.duration !== undefined) {
        payload.duration = extra.duration;
      }
      if (task.executedByNode) {
        payload.executedByNode = task.executedByNode;
      }
    }
    this.network.publishTaskEvent(payload)
      .catch((err: unknown) => console.error('[task-queue] Failed to publish task event:', err));
  }

  /**
   * Insert a task received from a remote peer (via GossipSub).
   * Skips if a task with the same ID already exists locally.
   */
  insertRemoteTask(task: Task): boolean {
    if (this.db.exists(task.id)) return false;
    this.db.transaction(() => {
      this.db.insertTask(task);
      if (task.files?.length) this.db.setFiles(task.id, task.files);
      if (task.dependencies?.length) this.db.setDependencies(task.id, task.dependencies);
      if (task.childTasks?.length) this.db.setChildren(task.id, task.childTasks);
      if (task.timeline?.length) {
        for (const evt of task.timeline) this.db.insertTimelineEvent(task.id, evt);
      }
      if (task.thread?.length) {
        for (const msg of task.thread) this.db.insertThreadMessage(msg);
      }
    });
    return true;
  }

  /**
   * Update a task's status from a remote peer event.
   * Only applies if the task exists locally and the new status is later in lifecycle.
   */
  updateRemoteStatus(
    taskId: string,
    status: TaskStatus,
    assignedTo?: string,
    result?: TaskResult,
    claimedByNode?: string,
    executedByNode?: string,
  ): boolean {
    const task = this.db.getTask(taskId);
    if (!task) return false;

    if (task.status === status) return true;
    if (!this.isValidTransition(task.status, status)) return false;

    const fields: Record<string, any> = {
      status,
      updated_at: Date.now(),
    };
    if (assignedTo !== undefined) fields.assigned_to = assignedTo;
    if (claimedByNode) fields.claimed_by_node = claimedByNode;
    if (executedByNode) fields.executed_by_node = executedByNode;

    // Merge result fields
    if (result) {
      const merged = { ...task.result, ...result };
      if (merged.commitHash !== undefined) fields.result_commit_hash = merged.commitHash;
      if (merged.buildPassed !== undefined) fields.result_build_passed = merged.buildPassed ? 1 : 0;
      if (merged.testsPassed !== undefined) fields.result_tests_passed = merged.testsPassed ? 1 : 0;
      if (merged.approved !== undefined) fields.result_approved = merged.approved ? 1 : 0;
      if (merged.approvedBy !== undefined) fields.result_approved_by = merged.approvedBy;
      if (merged.note !== undefined) fields.result_note = merged.note;
    }

    this.db.updateTask(taskId, fields);
    return true;
  }

  /**
   * Store remote output on a completed task (called when origin node receives results).
   */
  storeRemoteOutput(taskId: string, output: string, executedByNode?: string): boolean {
    const task = this.db.getTask(taskId);
    if (!task) return false;

    const fields: Record<string, any> = {
      result_note: output,
    };
    if (executedByNode) fields.executed_by_node = executedByNode;

    this.db.updateTask(taskId, fields);
    return true;
  }

  /**
   * Get all active tasks (open, claimed, in_progress) for catch-up sync.
   */
  getActiveTasks(): Task[] {
    return this.db.getActiveTasks();
  }

  // ── Task Catch-Up Sync (P2P) ──

  private localPeerId: string = '';

  setLocalPeerId(peerId: string): void {
    this.localPeerId = peerId;
  }

  getLocalPeerId(): string {
    return this.localPeerId;
  }

  /**
   * Request task sync from a peer — sends TASK_SYNC_REQUEST via direct P2P message.
   */
  async requestSync(peerId: string): Promise<void> {
    if (!this.network) return;
    try {
      await this.network.sendMessage(peerId, {
        type: MessageType.TASK_SYNC_REQUEST,
        from: this.localPeerId,
        timestamp: Date.now(),
        payload: { requestedAt: Date.now() },
      });
      console.log(`[task-sync] Sync requested from ${peerId.slice(0, 16)}...`);
    } catch (e: any) {
      console.log(`[task-sync] Could not request sync from ${peerId.slice(0, 16)}...: ${e.message}`);
    }
  }

  /**
   * Handle an incoming task sync request — respond with all active tasks.
   */
  handleSyncRequest(fromPeerId: string): void {
    if (!this.network) return;
    const tasks = this.getActiveTasks();
    console.log(`[task-sync] Sending ${tasks.length} active tasks to ${fromPeerId.slice(0, 16)}...`);
    this.network.sendMessage(fromPeerId, {
      type: MessageType.TASK_SYNC_RESPONSE,
      from: this.localPeerId,
      timestamp: Date.now(),
      payload: { tasks },
    }).catch((e: any) => {
      console.log(`[task-sync] Failed to send sync response to ${fromPeerId.slice(0, 16)}...: ${e.message}`);
    });
  }

  /**
   * Handle an incoming task sync response — insert all received tasks.
   */
  handleSyncResponse(tasks: Task[]): void {
    let inserted = 0;
    for (const task of tasks) {
      if (this.insertRemoteTask(task)) inserted++;
    }
    if (inserted > 0) {
      console.log(`[task-sync] Sync complete: +${inserted} tasks`);
    } else {
      console.log(`[task-sync] Sync complete: already up to date`);
    }
  }

  // ── Create ──

  createTask(opts: {
    title: string;
    description: string;
    priority?: TaskPriority;
    createdBy: string;
    files?: string[];
    dependencies?: string[];
    originNode?: string;
    proposalId?: string;
    requiredCapabilities?: string[];
    managerId?: string;
    parentTask?: string;       // If set, this is a child of a decomposed task — skip title dedup
  }): Task {
    // Dedup: if proposalId is set, reject duplicate task creation
    if (opts.proposalId) {
      const existing = this.db.findByProposalId(opts.proposalId);
      if (existing) {
        console.log(`[task-queue] Dedup: task for proposalId ${opts.proposalId.slice(0, 8)} already exists (${existing.id.slice(0, 8)}) — returning existing`);
        return existing;
      }
    }

    // Dedup: title-similarity check against open/claimed/in_progress tasks
    // Skip for child tasks (decomposed by Project Planner) — they're intentionally similar to parent
    if (!opts.parentTask) {
      const DEDUP_THRESHOLD = 0.6;
      const newTokens = new Set(
        opts.title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
      );
      if (newTokens.size > 0) {
        const activeTasks = this.db.getActiveTasksForDedup();
        for (const existing of activeTasks) {
          const existTokens = new Set(
            (existing.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
          );
          if (existTokens.size === 0) continue;
          let intersection = 0;
          for (const t of newTokens) { if (existTokens.has(t)) intersection++; }
          const union = newTokens.size + existTokens.size - intersection;
          const similarity = union === 0 ? 0 : intersection / union;
          if (similarity >= DEDUP_THRESHOLD) {
            console.log(`[task-queue] Dedup: title "${opts.title.slice(0, 40)}" is ${(similarity * 100).toFixed(0)}% similar to existing task ${existing.id.slice(0, 8)} ("${existing.title?.slice(0, 40)}") — returning existing`);
            return existing;
          }
        }
      }
    }

    const id = createHash('sha256')
      .update(`${opts.title}-${Date.now()}-${Math.random()}`)
      .digest('hex')
      .slice(0, 16);

    // Defense-in-depth: validate generated ID contains only safe characters
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`Generated task ID contains unsafe characters: ${id}`);
    }

    const now = Date.now();

    const task: Task = {
      id,
      title: opts.title,
      description: opts.description,
      priority: opts.priority || 'medium',
      status: 'open',
      createdBy: opts.createdBy,
      assignedTo: null,
      files: opts.files || [],
      dependencies: opts.dependencies || [],
      createdAt: now,
      updatedAt: now,
      originNode: opts.originNode || this.localPeerId || undefined,
      ...(opts.proposalId ? { proposalId: opts.proposalId } : {}),
      ...(opts.requiredCapabilities && opts.requiredCapabilities.length > 0 ? { requiredCapabilities: opts.requiredCapabilities } : {}),
      ...(opts.managerId ? { managerId: opts.managerId } : {}),
    };

    const createdEvent: TaskTimelineEvent = {
      timestamp: new Date(now).toISOString(),
      event: 'created',
      detail: `Task submitted with priority ${task.priority}`,
    };
    task.timeline = [createdEvent];

    // Insert task + related data atomically
    this.db.transaction(() => {
      this.db.insertTask(task);
      if (task.files.length > 0) this.db.setFiles(task.id, task.files);
      if (task.dependencies.length > 0) this.db.setDependencies(task.id, task.dependencies);
      this.db.insertTimelineEvent(task.id, createdEvent);
    });

    this.emitTaskEvent('created', task);
    return task;
  }

  // ── Read ──

  getTask(id: string): Task | null {
    return this.db.getTask(id);
  }

  getTasks(opts?: {
    status?: TaskStatus | TaskStatus[];
    priority?: TaskPriority;
    assignedTo?: string;
    limit?: number;
  }): Task[] {
    return this.db.getTasks({
      status: opts?.status ? (Array.isArray(opts.status) ? opts.status : [opts.status]) as string[] : undefined,
      priority: opts?.priority,
      assignedTo: opts?.assignedTo,
      limit: opts?.limit,
    });
  }

  getNextClaimable(agentId?: string): Task | null {
    return this.db.getNextClaimable(this.localPeerId || undefined, agentId);
  }

  // ── Update ──

  claimTask(taskId: string, agentId: string): { success: boolean; error?: string } {
    const task = this.db.getTask(taskId);
    if (!task) return { success: false, error: 'Task not found' };
    if (task.status !== 'open') return { success: false, error: `Task status is '${task.status}', not 'open'` };

    // File conflict check
    const conflict = this.db.getConflictingFiles(taskId, task.files);
    if (conflict) return { success: false, error: `File conflict: ${conflict} is locked` };

    // Dependency check
    const unmetDep = this.db.getUnmetDependency(taskId);
    if (unmetDep) return { success: false, error: `Dependency not met: ${unmetDep}` };

    const now = Date.now();
    this.db.updateTask(taskId, {
      status: 'claimed',
      assigned_to: agentId,
      claimed_by_node: this.localPeerId || null,
      claimed_at: now,
      updated_at: now,
    });

    // Re-read to get the updated task for the event
    const updated = this.db.getTask(taskId)!;
    this.emitTaskEvent('claimed', updated);
    return { success: true };
  }

  updateStatus(taskId: string, status: TaskStatus, assignedTo?: string): boolean {
    const task = this.db.getTask(taskId);
    if (!task) return false;
    if (task.status === status) return true;
    if (!this.isValidTransition(task.status, status)) return false;

    const fields: Record<string, any> = {
      status,
      updated_at: Date.now(),
    };
    if (assignedTo !== undefined) fields.assigned_to = assignedTo;

    this.db.updateTask(taskId, fields);
    return true;
  }

  completeTask(taskId: string, result?: TaskResult, completionInfo?: { executedByNode?: string; output?: string; duration?: number; cost?: TaskCost }): boolean {
    const task = this.db.getTask(taskId);
    if (!task) return false;
    if (task.status === 'done') return true;
    if (!this.isValidTransition(task.status, 'done')) return false;

    const now = Date.now();
    const fields: Record<string, any> = {
      status: 'done',
      updated_at: now,
    };

    // Result fields
    if (result) {
      if (result.commitHash !== undefined) fields.result_commit_hash = result.commitHash;
      if (result.buildPassed !== undefined) fields.result_build_passed = result.buildPassed ? 1 : 0;
      if (result.testsPassed !== undefined) fields.result_tests_passed = result.testsPassed ? 1 : 0;
      if (result.approved !== undefined) fields.result_approved = result.approved ? 1 : 0;
      if (result.approvedBy !== undefined) fields.result_approved_by = result.approvedBy;
      if (result.note !== undefined) fields.result_note = result.note;
    }

    // Execution info
    if (completionInfo?.executedByNode) {
      fields.executed_by_node = completionInfo.executedByNode;
    } else if (!task.executedByNode && this.localPeerId) {
      fields.executed_by_node = this.localPeerId;
    }

    // Cost fields
    if (completionInfo?.cost) {
      const c = completionInfo.cost;
      if (c.inputTokens !== undefined) fields.cost_input_tokens = c.inputTokens;
      if (c.outputTokens !== undefined) fields.cost_output_tokens = c.outputTokens;
      if (c.costUsd !== undefined) fields.cost_usd = c.costUsd;
      if (c.durationMs !== undefined) fields.cost_duration_ms = c.durationMs;
      if (c.tier !== undefined) fields.cost_tier = c.tier;
      if (c.model !== undefined) fields.cost_model = c.model;
    }

    // Cascade rejection: reject any open or claimed child tasks atomically
    const childIds = this.db.getChildren(taskId);
    const rejectedChildIds: string[] = [];

    this.db.transaction(() => {
      // Update the parent task
      this.db.updateTask(taskId, fields);

      // Cascade-reject children
      if (childIds.length > 0) {
        const reason = 'Parent task completed';
        for (const childId of childIds) {
          const child = this.db.getTask(childId);
          if (!child) continue;
          if (child.status !== 'open' && child.status !== 'claimed') continue;

          this.db.updateTask(childId, {
            status: 'rejected',
            assigned_to: null,
            updated_at: now,
            result_note: reason,
          });

          this.db.insertTimelineEvent(childId, {
            timestamp: new Date(now).toISOString(),
            event: 'cascade_rejected',
            detail: `Rejected: ${reason} (parent: ${taskId.slice(0, 8)})`,
            metadata: { parentTaskId: taskId, reason },
          });

          rejectedChildIds.push(childId);
        }
      }
    });

    // Re-read the updated task for the event
    const updated = this.db.getTask(taskId)!;
    this.emitTaskEvent('completed', updated, {
      output: completionInfo?.output,
      duration: completionInfo?.duration,
    });

    if (rejectedChildIds.length > 0) {
      console.log(`[task-queue] Cascade rejected ${rejectedChildIds.length} child task(s) of ${taskId.slice(0, 8)}: ${rejectedChildIds.map(c => c.slice(0, 8)).join(', ')}`);
    }

    // BUG-01 fix: Sibling auto-approve — when a child task completes,
    // find all sibling tasks of the same parent and approve any still 'open'.
    // This resolves the race condition where siblings remain unapproved
    // because the dependency-resolved approval only runs in one code path.
    const completedTask = this.db.getTask(taskId);
    if (completedTask?.parentTask) {
      const parentTask = this.db.getTask(completedTask.parentTask);
      if (parentTask?.childTasks) {
        const siblingIds = parentTask.childTasks.filter(id => id !== taskId);
        const autoApprovedSiblings: string[] = [];

        for (const siblingId of siblingIds) {
          const sibling = this.db.getTask(siblingId);
          if (!sibling) {
            console.log(`[task-queue] Sibling auto-approve: sibling ${siblingId.slice(0, 8)} not yet in queue — will retry on next poll`);
            continue;
          }
          if (sibling.status !== 'open') continue;

          // Check if all dependencies are resolved (done or rejected)
          const depsResolved = !sibling.dependencies?.length || sibling.dependencies.every(depId => {
            const dep = this.db.getTask(depId);
            return dep && (dep.status === 'done' || dep.status === 'rejected');
          });

          if (depsResolved) {
            autoApprovedSiblings.push(siblingId);
            console.log(`[task-queue] Sibling auto-approve: approving sibling ${siblingId.slice(0, 8)} (deps resolved after ${taskId.slice(0, 8)} completed)`);
            this.db.insertTimelineEvent(siblingId, {
              timestamp: new Date().toISOString(),
              event: 'sibling_auto_approved',
              detail: `Auto-approved: sibling ${taskId.slice(0, 8)} completed, all dependencies resolved`,
              metadata: { completedSiblingId: taskId, parentTaskId: completedTask.parentTask },
            });
          }
        }

        if (autoApprovedSiblings.length > 0) {
          console.log(`[task-queue] Sibling auto-approve: ${autoApprovedSiblings.length} sibling(s) approved after ${taskId.slice(0, 8)} completed: ${autoApprovedSiblings.map(s => s.slice(0, 8)).join(', ')}`);
        }
      }
    }

    return true;
  }

  /**
   * Set parent/child relationships between tasks.
   */
  setParentChild(parentId: string, childIds: string[]): boolean {
    const parent = this.db.getTask(parentId);
    if (!parent) return false;

    const now = Date.now();

    this.db.transaction(() => {
      this.db.setChildren(parentId, childIds.filter(id => id !== parentId));
      this.db.updateTask(parentId, { updated_at: now });

      for (const childId of childIds) {
        if (this.db.exists(childId)) {
          this.db.updateTask(childId, { parent_task: parentId, updated_at: now });
        }
      }
    });

    return true;
  }

  /**
   * Get all child tasks of a parent task.
   * Returns the full Task objects for each child.
   */
  getChildTasks(parentId: string): Task[] {
    const childIds = this.db.getChildren(parentId);
    const children: Task[] = [];
    for (const childId of childIds) {
      const child = this.db.getTask(childId);
      if (child) children.push(child);
    }
    return children;
  }

  /**
   * Get the parent task of a child task.
   * Returns the full Task object for the parent, or null if no parent.
   */
  getParentTask(taskId: string): Task | null {
    const task = this.db.getTask(taskId);
    if (!task || !task.parentTask) return null;
    return this.db.getTask(task.parentTask);
  }

  /**
   * Check if all child tasks of a parent are done.
   * Returns true if the parent has children and ALL are done.
   */
  areAllChildrenDone(parentId: string): boolean {
    const childIds = this.db.getChildren(parentId);
    if (childIds.length === 0) return false;
    for (const childId of childIds) {
      const child = this.db.getTask(childId);
      if (!child || child.status !== 'done') return false;
    }
    return true;
  }

  /**
   * Set a result note on a task without bypassing the public API.
   */
  setResultNote(taskId: string, note: string): void {
    if (!this.db.exists(taskId)) return;
    this.db.updateTask(taskId, { result_note: note });
  }

  /**
   * Persist a task's qaTier to SQLite.
   * Called by the scheduler after classifyQaTier() sets the in-memory value.
   */
  setQaTier(taskId: string, tier: QaTier): void {
    if (!this.db.exists(taskId)) return;
    this.db.updateTask(taskId, { qa_tier: tier });
  }

  rejectTask(taskId: string, reason?: string): boolean {
    const task = this.db.getTask(taskId);
    if (!task) return false;
    if (task.status === 'open') return true;
    if (!this.isValidTransition(task.status, 'open')) return false;

    const fields: Record<string, any> = {
      status: 'open',
      assigned_to: null,
      updated_at: Date.now(),
    };
    if (reason) fields.result_note = reason;

    this.db.updateTask(taskId, fields);
    return true;
  }

  // ── Query helpers ──

  /**
   * Get all open tasks sorted by priority: critical > high > medium > low.
   */
  getOpenTasksByPriority(): Task[] {
    return this.getTasks({ status: 'open' });
  }

  /**
   * Get all tasks currently claimed by a specific agent.
   */
  getClaimedTasks(agentId: string): Task[] {
    return this.db.getClaimedTasks(agentId);
  }

  /**
   * Release a claimed task back to open (advisory — only the claiming agent can release).
   */
  releaseTask(taskId: string, agentId: string): { success: boolean; error?: string } {
    const task = this.db.getTask(taskId);
    if (!task) return { success: false, error: 'Task not found' };
    if (task.assignedTo !== agentId) return { success: false, error: 'Task not claimed by this agent' };
    if (task.status !== 'claimed' && task.status !== 'in_progress') {
      return { success: false, error: `Cannot release task in status '${task.status}'` };
    }

    this.db.updateTask(taskId, {
      status: 'open',
      assigned_to: null,
      updated_at: Date.now(),
    });
    return { success: true };
  }

  /**
   * Force-release a claimed task back to open (for cross-node claim conflict resolution).
   * Unlike releaseTask(), this does not check agentId — used when we lose a claim race.
   */
  forceReleaseTask(taskId: string): boolean {
    const task = this.db.getTask(taskId);
    if (!task) return false;
    if (task.status !== 'claimed' && task.status !== 'in_progress') return false;

    this.db.updateTask(taskId, {
      status: 'open',
      assigned_to: null,
      claimed_by_node: null,
      claimed_at: null,
      updated_at: Date.now(),
    });
    return true;
  }

  /**
   * Auto-complete tasks whose title fuzzy-matches a commit message.
   * Uses case-insensitive substring matching: if any word sequence from the
   * task title (3+ chars) appears in the commit message, it's a match.
   * Returns the list of auto-completed tasks.
   */
  autoCompleteByCommit(commitMessage: string, commitHash?: string): Task[] {
    const completable = this.db.getTasks({ status: ['open', 'claimed', 'in_progress'] });
    const completed: Task[] = [];
    const msgLower = commitMessage.toLowerCase();

    for (const task of completable) {
      const titleLower = task.title.toLowerCase();
      let matched = false;

      // Fuzzy match: case-insensitive substring in either direction
      if (msgLower.includes(titleLower) || titleLower.includes(msgLower)) {
        matched = true;
      } else {
        // Also check if significant words from title appear as substring in commit
        const significantWords = titleLower.split(/\s+/).filter(w => w.length >= 3);
        const matchCount = significantWords.filter(w => msgLower.includes(w)).length;
        if (significantWords.length > 0 && matchCount >= Math.ceil(significantWords.length * 0.6)) {
          matched = true;
        }
      }

      if (matched) {
        const note = msgLower.includes(titleLower) || titleLower.includes(msgLower)
          ? `Auto-completed by commit: ${commitMessage.slice(0, 100)}`
          : `Auto-completed by commit (fuzzy): ${commitMessage.slice(0, 100)}`;

        this.db.updateTask(task.id, {
          status: 'done',
          updated_at: Date.now(),
          result_commit_hash: commitHash || null,
          result_build_passed: 1,
          result_note: note,
        });

        // Re-read the updated task
        const updated = this.db.getTask(task.id);
        if (updated) completed.push(updated);
      }
    }

    return completed;
  }

  // ── Stats ──

  /**
   * Push a timeline event to a specific task.
   * @param broadcast — if true (default), broadcasts the event via GossipSub. Set to false for remote events to prevent infinite loops.
   */
  pushTimelineEvent(taskId: string, event: Omit<TaskTimelineEvent, 'timestamp'>, broadcast: boolean = true): void {
    if (!this.db.exists(taskId)) return;

    const fullEvent: TaskTimelineEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.db.insertTimelineEvent(taskId, fullEvent);

    // Broadcast timeline event to peers via GossipSub
    if (broadcast) {
      const task = this.db.getTask(taskId);
      if (task) {
        this.emitTaskEvent('timeline', task, { timelineEvent: fullEvent });
      }
    }
  }

  /**
   * Apply a remote timeline event (with pre-existing timestamp) to a local task.
   * Does NOT broadcast — used for events received from other nodes.
   */
  applyRemoteTimelineEvent(taskId: string, event: TaskTimelineEvent): boolean {
    if (!this.db.exists(taskId)) return false;
    // Deduplicate: skip if same timestamp + event type already exists
    if (this.db.hasTimelineEvent(taskId, event.timestamp, event.event)) return false;
    this.db.insertTimelineEvent(taskId, event);
    return true;
  }

  // ── Conversation Thread (Phase 18.3) ──

  /**
   * Add a message to a task's conversation thread and broadcast via GossipSub.
   */
  addMessage(taskId: string, opts: { from: string; role: 'user' | 'agent' | 'system'; content: string }): ThreadMessage | null {
    if (!this.db.exists(taskId)) return null;

    const msg: ThreadMessage = {
      id: createHash('sha256')
        .update(`${taskId}-${opts.from}-${Date.now()}-${Math.random()}`)
        .digest('hex')
        .slice(0, 16),
      taskId,
      from: opts.from,
      role: opts.role,
      content: opts.content,
      createdAt: Date.now(),
    };

    this.db.insertThreadMessage(msg);
    this.db.updateTask(taskId, { updated_at: Date.now() });

    // Broadcast thread message via GossipSub
    if (this.network) {
      const task = this.db.getTask(taskId);
      if (task) {
        this.network.publishTaskEvent({
          type: 'timeline' as const,
          task: { id: task.id, title: task.title },
          timelineEvent: {
            timestamp: new Date(msg.createdAt).toISOString(),
            event: 'thread_message',
            detail: `[${msg.role}] ${msg.content.slice(0, 100)}`,
            metadata: { messageId: msg.id, from: msg.from, role: msg.role },
          },
        }).catch((err: unknown) => console.error('[task-queue] Failed to broadcast thread message:', err));
      }
    }

    return msg;
  }

  /**
   * Get all messages in a task's conversation thread.
   */
  getThread(taskId: string): ThreadMessage[] {
    return this.db.getThread(taskId);
  }

  getStats(): Record<string, number> {
    return this.db.getStats();
  }

  setRoleMetadata(taskId: string, roleMetadata: TaskRoleMetadata): void {
    this.db.updateTask(taskId, {
      role_id: roleMetadata.roleId,
      role_responsibility: roleMetadata.responsibility,
      role_project_id: roleMetadata.projectId,
      role_verification_needed: roleMetadata.verificationNeeded ? 1 : 0,
      updated_at: Date.now(),
    });
  }

  archiveOldTasks(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): { archived: number } {
    const count = this.db.archiveTasks(olderThanMs);
    if (count > 0) {
      console.log(`[task-queue] Archived ${count} old tasks (older than ${Math.round(olderThanMs / 86400000)}d)`);
    }
    return { archived: count };
  }

  /**
   * Cleanup expired tasks:
   * - Any task with status "open" older than 48 hours → set status to "expired"
   * - Any task with status "done" older than 7 days → remove from queue entirely
   * - Any task with status "failed"/"rejected" older than 7 days → remove from queue entirely
   * - Any task with status "expired" older than 7 days → remove from queue entirely
   * Called by the scheduler at the start of each poll cycle.
   */
  cleanupExpiredTasks(): { expired: number; removed: number } {
    const result = this.db.cleanupExpiredTasks();
    if (result.expired > 0) {
      console.log(`[task-queue] Auto-expired ${result.expired} stale open task(s) (>48h old)`);
    }
    if (result.removed > 0) {
      console.log(`[task-queue] Removed ${result.removed} old terminal task(s) (>7d old)`);
    }
    return result;
  }

  getArchivedTasks(limit: number = 50): Task[] {
    return this.db.getArchivedTasks(limit);
  }

  /**
   * Aggregate cost stats across all tasks with cost data.
   */
  getCostStats(): { totalCostUsd: number; totalInputTokens: number; totalOutputTokens: number; totalDurationMs: number; taskCount: number; byTier: Record<string, { count: number; costUsd: number; tokens: number }> } {
    return this.db.getCostStats();
  }

  getAgentSummary(agentId?: string): string {
    const allTasks = this.db.getAllTasks();
    const parts: string[] = ['## Task Queue\n'];

    const myTask = agentId
      ? allTasks.find(t => t.assignedTo === agentId && (t.status === 'claimed' || t.status === 'in_progress'))
      : null;

    if (myTask) {
      parts.push(`### YOUR CURRENT TASK [${myTask.priority.toUpperCase()}]`);
      parts.push(`ID: ${myTask.id}`);
      parts.push(`Title: ${myTask.title}`);
      parts.push(`Status: ${myTask.status}`);
      parts.push(myTask.description);
      parts.push('');
    } else {
      parts.push('### No current task assigned. Claim the highest-priority open task.\n');
    }

    const openTasks = allTasks.filter(t => t.status === 'open');
    if (openTasks.length > 0) {
      parts.push(`### Open Tasks (${openTasks.length})`);
      for (const t of openTasks.slice(0, 5)) {
        parts.push(`- [${t.priority.toUpperCase()}] ${t.title} (${t.id.slice(0, 8)})`);
      }
      if (openTasks.length > 5) parts.push(`  ... and ${openTasks.length - 5} more`);
      parts.push('');
    }

    const inProgress = allTasks.filter(t =>
      (t.status === 'claimed' || t.status === 'in_progress') && t.assignedTo !== agentId
    );
    if (inProgress.length > 0) {
      parts.push(`### In Progress by Others (${inProgress.length})`);
      for (const t of inProgress) {
        parts.push(`- ${t.title} → ${t.assignedTo?.slice(0, 12) || 'unknown'} [${t.status}]`);
      }
      parts.push('');
    }

    const done = allTasks.filter(t => t.status === 'done').slice(-3);
    if (done.length > 0) {
      parts.push(`### Recently Completed`);
      for (const t of done) {
        parts.push(`- ${t.title} ${t.result?.commitHash ? `(${t.result.commitHash.slice(0, 7)})` : ''}`);
      }
    }

    return parts.join('\n');
  }
}
