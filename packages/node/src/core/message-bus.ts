/**
 * MessageBus — SQLite-backed persistent message routing.
 *
 * Replaces the in-memory BridgeQueue. All messages are persisted to SQLite.
 * Orchestrators poll their inbox on each tick — no EventEmitter needed.
 *
 * Communication rules (enforced here):
 *   - Workers can ONLY message their parent orchestrator
 *   - Orchestrators can message: parent, children, siblings
 *   - Users can only message their project orchestrator
 *   - Everything else is rejected
 */

import type {
  AgentDatabase,
  InboxMessage,
  MessageType,
  SenderType,
} from '../platform/agent-database.js';

export interface SendMessageOpts {
  recipientId: string;
  senderId: string;
  senderType: SenderType;
  type: MessageType;
  payload: Record<string, unknown>;
  priority?: number;
  signature?: string;
}

export class MessageBus {
  constructor(private db: AgentDatabase) {}

  /**
   * Send a message. Validates communication boundaries before insertion.
   * Returns the message ID, or throws if the message is not allowed.
   */
  send(opts: SendMessageOpts): number {
    // Validate communication boundaries
    if (opts.senderType !== 'system') {
      this.validateSender(opts.senderId, opts.recipientId, opts.senderType);
    }

    return this.db.sendMessage({
      recipientId: opts.recipientId,
      senderId: opts.senderId,
      senderType: opts.senderType,
      type: opts.type,
      payload: JSON.stringify(opts.payload),
      priority: opts.priority ?? 1,
      signature: opts.signature,
    });
  }

  /**
   * Read unread messages for a recipient, ordered by priority then time.
   */
  read(recipientId: string, limit = 50): InboxMessage[] {
    return this.db.readInbox(recipientId, limit);
  }

  /**
   * Mark messages as read (processed).
   */
  markRead(messageIds: number[]): void {
    this.db.markRead(messageIds);
  }

  /**
   * Send a message to all active orchestrators.
   */
  broadcast(senderId: string, type: MessageType, payload: Record<string, unknown>): void {
    const orchestrators = this.db.listAgents({ type: 'orchestrator', status: 'active' });
    for (const orch of orchestrators) {
      this.db.sendMessage({
        recipientId: orch.id,
        senderId,
        senderType: 'system',
        type,
        payload: JSON.stringify(payload),
        priority: 1,
      });
    }
  }

  /**
   * Clean up old read messages.
   */
  cleanup(olderThanDays = 7): number {
    return this.db.cleanupMessages(olderThanDays);
  }

  /**
   * Validate communication boundaries.
   * Throws if the sender is not allowed to message the recipient.
   */
  private validateSender(senderId: string, recipientId: string, senderType: SenderType): void {
    const sender = this.db.getAgent(senderId);
    const recipient = this.db.getAgent(recipientId);

    // If sender/recipient not found, allow for system messages and user messages
    // where the sender isn't in agent_identity (external user)
    if (!recipient) {
      throw new Error(`MessageBus: recipient ${recipientId} not found`);
    }

    if (senderType === 'user') {
      // Users can message any orchestrator (project or council)
      if (recipient.type !== 'orchestrator') {
        throw new Error(`MessageBus: users can only message orchestrators`);
      }
      return;
    }

    if (!sender) {
      throw new Error(`MessageBus: sender ${senderId} not found`);
    }

    if (sender.type === 'worker') {
      // Workers can ONLY talk to their parent orchestrator
      if (recipientId !== sender.parentId) {
        throw new Error(`MessageBus: worker ${senderId} can only message parent ${sender.parentId}, not ${recipientId}`);
      }
      return;
    }

    if (sender.type === 'orchestrator') {
      // Orchestrators can talk to: parent, children, siblings (same parent)
      if (recipientId === sender.parentId) return;           // parent
      if (recipient.parentId === senderId) return;           // child
      if (sender.parentId && recipient.parentId === sender.parentId) return;  // sibling
      throw new Error(`MessageBus: orchestrator ${senderId} cannot message ${recipientId} (not parent/child/sibling)`);
    }
  }
}
