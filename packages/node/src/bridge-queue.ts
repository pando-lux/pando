/**
 * BridgeQueue — Event-driven communication hub for all agents.
 *
 * Every subsystem posts items here (scheduler, communication agent, health
 * monitor, workers). The Bridge Watcher in AgentManager dequeues
 * ONE item at a time and feeds it to the appropriate manager.
 *
 * Replaces: 5-minute heartbeat timer, pipeline commit trigger, one-way
 * worker communication, batched event routing.
 *
 * Items are per-manager, priority-ordered (CRITICAL > NORMAL > LOW),
 * then FIFO within the same priority tier.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export type BridgeItemType =
  | 'user_request'
  | 'task_completed'
  | 'task_failed'
  | 'worker_message'
  | 'health_alert'
  | 'governance_decision'
  | 'strategy_suggestion'
  | 'improvement_proposal'
  | 'stuck'
  | 'discovery'
  | 'user_question'
  | 'progress'
  | 'timeout'
  | 'directive_continuation'
  | 'directive_nudge';

export type BridgePriority = 'critical' | 'normal' | 'low';

const PRIORITY_ORDER: Record<BridgePriority, number> = {
  critical: 0,
  normal: 1,
  low: 2,
};

export interface BridgeItem {
  id: string;
  managerId: string;
  type: BridgeItemType;
  source: string;
  payload: Record<string, any>;
  priority: BridgePriority;
  timestamp: number;
  /** Phase 26 B11: Sender identifier for multi-user project collaboration */
  senderId?: string;
  /** Phase 27-D: Retry count for event retry logic (0 = first attempt) */
  retryCount: number;
  /** Phase 27-D: Originating node ID ('local' for events from this node) */
  nodeId: string;
}

export interface BridgeEnqueueOpts {
  type: BridgeItemType;
  source: string;
  payload: Record<string, any>;
  priority: BridgePriority;
  /** Phase 26 B11: Sender identifier for multi-user tracking */
  senderId?: string;
  /** Phase 27-D: Retry count (defaults to 0) */
  retryCount?: number;
  /** Phase 27-D: Originating node ID (defaults to 'local') */
  nodeId?: string;
}

export interface BridgeQueueStatus {
  length: number;
  busy: boolean;
  items: BridgeItem[];
}

// ── BridgeQueue Class ────────────────────────────────────────────────────────

export class BridgeQueue extends EventEmitter {
  /** Per-manager item queues */
  private queues: Map<string, BridgeItem[]> = new Map();

  /** Per-manager busy state (true = manager is processing an item) */
  private managerBusy: Map<string, boolean> = new Map();

  /** Callback for urgency:direct messages that bypass the Manager queue */
  private directMessageHandler: ((item: BridgeItem) => void) | null = null;

  /** Track taskIds that have already used the direct bypass (max 1 per task) */
  private directBypassUsed: Set<string> = new Set();

  /**
   * Register a handler for urgency:direct messages.
   * These bypass the Manager queue and go straight to the user via SSE.
   */
  setDirectMessageHandler(handler: (item: BridgeItem) => void): void {
    this.directMessageHandler = handler;
  }

  /**
   * Enqueue an item for a manager. Items are sorted by priority then FIFO.
   * Emits 'newItem' so the Bridge Watcher can trigger processing.
   *
   * If the item has `urgency: 'direct'` in its payload, it bypasses the
   * Manager queue and is delivered straight to the user via the direct
   * message handler (max 1 direct message per task).
   */
  enqueue(managerId: string, opts: BridgeEnqueueOpts): BridgeItem {
    const item: BridgeItem = {
      id: randomUUID(),
      managerId,
      type: opts.type,
      source: opts.source,
      payload: opts.payload,
      priority: opts.priority,
      timestamp: Date.now(),
      senderId: opts.senderId,
      retryCount: opts.retryCount ?? 0,
      nodeId: opts.nodeId ?? 'local',
    };

    // B4: urgency:direct bypass — skip Manager queue, deliver to user via SSE
    const taskId = opts.payload?.taskId as string | undefined;
    if (opts.payload?.urgency === 'direct' && this.directMessageHandler) {
      if (taskId && this.directBypassUsed.has(taskId)) {
        console.log(
          `[bridge] Direct bypass already used for task ${taskId}, routing to Manager queue`,
        );
      } else {
        if (taskId) this.directBypassUsed.add(taskId);
        console.log(
          `[bridge] Direct bypass: ${item.type} for ${managerId} ` +
          `(taskId: ${taskId || 'unknown'}) → SSE to user`,
        );
        this.directMessageHandler(item);
        return item;
      }
    }

    if (!this.queues.has(managerId)) {
      this.queues.set(managerId, []);
    }

    const queue = this.queues.get(managerId)!;
    queue.push(item);

    // Stable sort: priority first, then arrival order (FIFO within tier)
    queue.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority];
      const pb = PRIORITY_ORDER[b.priority];
      if (pa !== pb) return pa - pb;
      return a.timestamp - b.timestamp;
    });

    console.log(
      `[bridge] Enqueued ${item.type} for ${managerId} ` +
      `(priority: ${item.priority}, queue: ${queue.length})`,
    );

    this.emit('newItem', managerId, item);
    return item;
  }

  /**
   * Dequeue the next item for a manager (highest priority, then oldest).
   * Returns null if the queue is empty.
   */
  dequeue(managerId: string): BridgeItem | null {
    const queue = this.queues.get(managerId);
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  }

  /**
   * Peek at the next item without removing it.
   */
  peek(managerId: string): BridgeItem | null {
    const queue = this.queues.get(managerId);
    if (!queue || queue.length === 0) return null;
    return queue[0];
  }

  /**
   * Number of items waiting for a manager.
   */
  length(managerId: string): number {
    return this.queues.get(managerId)?.length || 0;
  }

  /**
   * Whether the queue is empty for a manager.
   */
  isEmpty(managerId: string): boolean {
    return this.length(managerId) === 0;
  }

  /**
   * Mark a manager as busy (processing an item) or idle.
   * When set to idle, emits 'managerIdle' so the Bridge Watcher
   * can check for the next item.
   */
  setManagerBusy(managerId: string, busy: boolean): void {
    this.managerBusy.set(managerId, busy);
    if (!busy) {
      this.emit('managerIdle', managerId);
    }
  }

  /**
   * Whether a manager is currently processing an item.
   */
  isManagerBusy(managerId: string): boolean {
    return this.managerBusy.get(managerId) || false;
  }

  /**
   * Get full status for a specific manager's queue.
   */
  getQueueStatus(managerId: string): BridgeQueueStatus {
    return {
      length: this.length(managerId),
      busy: this.isManagerBusy(managerId),
      items: [...(this.queues.get(managerId) || [])],
    };
  }

  /**
   * Phase 26 B11: Get unique participants (senders) for a manager's queue.
   * Scans current queue items for distinct senderId values.
   */
  getParticipants(managerId: string): string[] {
    const queue = this.queues.get(managerId);
    if (!queue) return [];
    const senders = new Set<string>();
    for (const item of queue) {
      if (item.senderId) senders.add(item.senderId);
    }
    return Array.from(senders);
  }

  /**
   * Get summary status for all known manager queues.
   */
  getAllStatuses(): Record<string, { length: number; busy: boolean }> {
    const result: Record<string, { length: number; busy: boolean }> = {};

    for (const [managerId] of this.queues) {
      result[managerId] = {
        length: this.length(managerId),
        busy: this.isManagerBusy(managerId),
      };
    }

    // Include managers tracked as busy but with no items
    for (const [managerId, busy] of this.managerBusy) {
      if (!result[managerId]) {
        result[managerId] = { length: 0, busy };
      }
    }

    return result;
  }
}
