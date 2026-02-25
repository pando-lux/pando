/**
 * Request/Reply Messaging — Phase 10.1
 *
 * Enables structured request/reply conversations between Pando nodes
 * over the existing pando/agent-messages GossipSub topic.
 *
 * Messages are distinguished by `messageKind: 'request' | 'reply'` in
 * the GossipSub envelope, keeping full backward compatibility with
 * existing agent-messages.
 */

import { randomUUID } from 'node:crypto';
import type { PandoNetwork } from './network.js';
import type { PandoRequest, PandoReply } from '@pando/shared';

export type RequestHandler = (req: PandoRequest) => Promise<any>;

interface PendingRequest {
  resolve: (reply: PandoReply) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sentAt: number;
}

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
  private pending = new Map<string, PendingRequest>();
  private pendingQueries = new Map<string, PendingQuery>();

  // Rate limiting: sliding window counters
  private outboundRequests: number[] = [];
  private outboundReplies: number[] = [];
  private static readonly MAX_REQUESTS_PER_MIN = 120;  // Phase 83: increased from 30 for storage proxy traffic
  private static readonly MAX_REPLIES_PER_MIN = 240;   // Phase 83: increased from 60 for storage proxy traffic

  // Stats
  private statsSent = 0;
  private statsReceived = 0;
  private statsTimeouts = 0;
  private latencies: number[] = [];
  private static readonly MAX_LATENCY_SAMPLES = 200;

  private static readonly DEFAULT_TIMEOUT_MS = 30_000;

  private subscribed = false;

  constructor(network: PandoNetwork) {
    this.network = network;
  }

  /**
   * Subscribe to agent-messages and begin handling request/reply messages.
   * Call once after the network is started.
   */
  async start(): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;

    // Listen on the existing agent-messages topic for request/reply envelopes.
    // publishAgentMessage wraps as { targetPeerId, agentMsg }, so unwrap here.
    this.network.onAgentMessage((msg: any, fromPeerId: string) => {
      if (!msg) return;

      // Unwrap the agentMsg envelope from publishAgentMessage
      const inner = msg.agentMsg || msg;
      if (!inner.messageKind) return; // Not a request/reply message — ignore

      // Filter by targetPeerId — only process messages meant for us (or broadcast '*')
      const myPeerId = this.network.getIdentity().peerId;
      if (msg.targetPeerId && msg.targetPeerId !== '*' && msg.targetPeerId !== myPeerId) return;

      if (inner.messageKind === 'request') {
        this.handleIncomingRequest(inner.data as PandoRequest, fromPeerId);
      } else if (inner.messageKind === 'reply') {
        this.handleIncomingReply(inner.data as PandoReply);
      }
    });
  }

  /**
   * Register a handler for a request type.
   */
  registerHandler(type: string, handler: RequestHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * List all registered handler type names.
   */
  getHandlerTypes(): string[] {
    return Array.from(this.handlers.keys());
  }

  /** Get a registered handler by type (for local self-dispatch) */
  getHandler(type: string): RequestHandler | undefined {
    return this.handlers.get(type);
  }

  /**
   * Send a request to a specific peer and wait for a reply.
   */
  async request(to: string, type: string, payload: any, timeoutMs?: number): Promise<PandoReply> {
    const timeout = timeoutMs ?? RequestReplyManager.DEFAULT_TIMEOUT_MS;
    const peerId = this.network.getIdentity().peerId;

    // Rate limit outbound requests
    if (!this.checkRateLimit(this.outboundRequests, RequestReplyManager.MAX_REQUESTS_PER_MIN)) {
      throw new Error('Rate limited: too many outbound requests (max 120/min)');
    }

    const request: PandoRequest = {
      requestId: randomUUID(),
      from: peerId,
      to,
      type,
      payload,
      timeout,
      timestamp: Date.now(),
    };

    return new Promise<PandoReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        this.statsTimeouts++;
        reject(new Error(`Request timed out after ${timeout}ms (type: ${type}, to: ${to.slice(0, 16)})`));
      }, timeout);

      this.pending.set(request.requestId, { resolve, reject, timer, sentAt: Date.now() });

      // Publish via the agent-messages topic with messageKind envelope
      this.network.publishAgentMessage(to, {
        messageKind: 'request',
        data: request,
      }).then(() => {
        this.statsSent++;
      }).catch((err) => {
        this.pending.delete(request.requestId);
        clearTimeout(timer);
        reject(new Error(`Failed to send request: ${err.message}`));
      });
    });
  }

  /**
   * Send a broadcast query to all peers. Returns up to maxReplies
   * within the timeout window.
   */
  async query(type: string, payload: any, opts?: { timeout?: number; maxReplies?: number }): Promise<PandoReply[]> {
    const timeout = opts?.timeout ?? RequestReplyManager.DEFAULT_TIMEOUT_MS;
    const maxReplies = opts?.maxReplies ?? 10;
    const peerId = this.network.getIdentity().peerId;

    // Rate limit outbound requests
    if (!this.checkRateLimit(this.outboundRequests, RequestReplyManager.MAX_REQUESTS_PER_MIN)) {
      throw new Error('Rate limited: too many outbound requests (max 120/min)');
    }

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
        this.statsSent++;
      }).catch(() => {
        // Broadcast might fail if no peers — resolve with empty
        this.pendingQueries.delete(request.requestId);
        clearTimeout(timer);
        resolve([]);
      });
    });
  }

  /**
   * Get request/reply statistics.
   */
  getStats(): RequestReplyStats {
    const avgLatencyMs = this.latencies.length > 0
      ? Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length)
      : 0;

    return {
      sent: this.statsSent,
      received: this.statsReceived,
      timeouts: this.statsTimeouts,
      avgLatencyMs,
    };
  }

  // ── Internal ──

  private async handleIncomingRequest(req: PandoRequest, fromPeerId: string): Promise<void> {
    if (!req || !req.requestId || !req.type) return;

    // If this message is targeted at a specific peer and it's not us, ignore
    const myPeerId = this.network.getIdentity().peerId;
    if (req.to !== '*' && req.to !== myPeerId) return;

    this.statsReceived++;

    const handler = this.handlers.get(req.type);
    if (!handler) {
      // No handler registered — send error reply
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
    // Rate limit outbound replies
    if (!this.checkRateLimit(this.outboundReplies, RequestReplyManager.MAX_REPLIES_PER_MIN)) {
      console.warn('[request-reply] Reply rate limited, dropping reply for', req.requestId.slice(0, 8));
      return;
    }

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

    // Check if it's for a single request
    const pending = this.pending.get(reply.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(reply.requestId);

      // Record latency
      const latency = Date.now() - pending.sentAt;
      this.latencies.push(latency);
      if (this.latencies.length > RequestReplyManager.MAX_LATENCY_SAMPLES) {
        this.latencies.shift();
      }

      pending.resolve(reply);
      return;
    }

    // Check if it's for a broadcast query
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

  /**
   * Sliding window rate limiter. Returns true if under limit.
   */
  private checkRateLimit(timestamps: number[], maxPerMin: number): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;

    // Prune old entries
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= maxPerMin) {
      return false;
    }

    timestamps.push(now);
    return true;
  }
}
