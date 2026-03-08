/**
 * Request/Reply Messaging — Handler Registry + Broadcast Queries
 *
 * GossipSub-based broadcast query/reply over pando/agent-messages topic.
 * Unicast (point-to-point) operations use HttpPeerClient instead.
 *
 * This module provides:
 * - Handler registry (registerHandler / getHandler) for incoming request dispatch
 * - Broadcast query() for "ask all peers" patterns (e.g., "who can build this?")
 * - GossipSub subscription for receiving broadcast queries and replying
 */

import { randomUUID } from 'node:crypto';
import type { PandoNetwork } from '../kernel/network.js';
import type { PandoRequest, PandoReply } from '@pando/shared';

export type RequestHandler = (req: PandoRequest) => Promise<any>;

interface PendingQuery {
  resolve: (replies: PandoReply[]) => void;
  timer: ReturnType<typeof setTimeout>;
  replies: PandoReply[];
  maxReplies: number;
}

export interface RequestReplyStats {
  sent: number;
  received: number;
  timeouts: number;
  avgLatencyMs: number;
}

export class RequestReplyManager {
  private network: PandoNetwork;
  private handlers = new Map<string, RequestHandler>();
  private pendingQueries = new Map<string, PendingQuery>();

  private static readonly DEFAULT_TIMEOUT_MS = 30_000;

  private subscribed = false;

  constructor(network: PandoNetwork) {
    this.network = network;
  }

  /**
   * Subscribe to agent-messages and begin handling broadcast request/reply messages.
   * Call once after the network is started.
   */
  async start(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;

    this.network.onAgentMessage((msg: any, fromPeerId: string) => {
      if (!msg) return;

      const inner = msg.agentMsg || msg;
      if (!inner.messageKind) return;

      const myPeerId = this.network.getIdentity().peerId;
      if (msg.targetPeerId && msg.targetPeerId !== '*' && msg.targetPeerId !== myPeerId) return;

      if (inner.messageKind === 'request') {
        this.handleIncomingRequest(inner.data as PandoRequest, fromPeerId);
      } else if (inner.messageKind === 'reply') {
        this.handleIncomingReply(inner.data as PandoReply);
      }
    });
  }

  /** Register a handler for a request type. */
  registerHandler(type: string, handler: RequestHandler): void {
    this.handlers.set(type, handler);
  }

  /** List all registered handler type names. */
  getHandlerTypes(): string[] {
    return Array.from(this.handlers.keys());
  }

  /** Get a registered handler by type (for local self-dispatch). */
  getHandler(type: string): RequestHandler | undefined {
    return this.handlers.get(type);
  }

  /**
   * Send a broadcast query to all peers. Returns up to maxReplies
   * within the timeout window.
   */
  async query(type: string, payload: any, opts?: { timeout?: number; maxReplies?: number }): Promise<PandoReply[]> {
    const timeout = opts?.timeout ?? RequestReplyManager.DEFAULT_TIMEOUT_MS;
    const maxReplies = opts?.maxReplies ?? 10;
    const peerId = this.network.getIdentity().peerId;

    const request: PandoRequest = {
      requestId: randomUUID(),
      from: peerId,
      to: '*',
      type,
      payload,
      timeout,
      timestamp: Date.now(),
    };

    return new Promise<PandoReply[]>((resolve) => {
      const timer = setTimeout(() => {
        const q = this.pendingQueries.get(request.requestId);
        this.pendingQueries.delete(request.requestId);
        resolve(q?.replies ?? []);
      }, timeout);

      this.pendingQueries.set(request.requestId, {
        resolve,
        timer,
        replies: [],
        maxReplies,
      });

      this.network.publishAgentMessage('*', {
        messageKind: 'request',
        data: request,
      }).then(() => {
        // broadcast sent
      }).catch(() => {
        this.pendingQueries.delete(request.requestId);
        clearTimeout(timer);
        resolve([]);
      });
    });
  }

  /** Get basic stats. */
  getStats(): RequestReplyStats {
    return { sent: 0, received: 0, timeouts: 0, avgLatencyMs: 0 };
  }

  // ── Internal ──

  private async handleIncomingRequest(req: PandoRequest, _fromPeerId: string): Promise<void> {
    if (!req || !req.requestId || !req.type) return;

    const myPeerId = this.network.getIdentity().peerId;
    if (req.to !== '*' && req.to !== myPeerId) return;

    const handler = this.handlers.get(req.type);
    if (!handler) {
      await this.sendReply(req, false, null, `No handler registered for type: ${req.type}`);
      return;
    }

    try {
      const result = await handler(req);
      await this.sendReply(req, true, result);
    } catch (err: any) {
      await this.sendReply(req, false, null, err.message || 'Handler error');
    }
  }

  private async sendReply(req: PandoRequest, success: boolean, payload: any, error?: string): Promise<void> {
    const reply: PandoReply = {
      requestId: req.requestId,
      from: this.network.getIdentity().peerId,
      to: req.from,
      type: req.type,
      payload,
      success,
      error,
      timestamp: Date.now(),
    };

    try {
      await this.network.publishAgentMessage(req.from, {
        messageKind: 'reply',
        data: reply,
      });
    } catch (err: any) {
      console.error(`[request-reply] Failed to send reply: ${err.message}`);
    }
  }

  private handleIncomingReply(reply: PandoReply): void {
    if (!reply || !reply.requestId) return;

    const query = this.pendingQueries.get(reply.requestId);
    if (query) {
      query.replies.push(reply);
      if (query.replies.length >= query.maxReplies) {
        clearTimeout(query.timer);
        this.pendingQueries.delete(reply.requestId);
        query.resolve(query.replies);
      }
    }
  }
}
