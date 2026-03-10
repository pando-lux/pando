/**
 * Auth middleware helpers — Phase 86 JWT-based stateless auth.
 *
 * These helpers are used by all route modules.
 * They are constructed from the ApiServer instance and passed to route
 * registration functions as part of the RouteHelpers dependency object.
 */

import type { PandoNode } from '../../index.js';

// ── Type Exports ────────────────────────────────────────────────────────────

/** All dependencies passed to route registration functions. */
export interface RouteHelpers {
  node: PandoNode;
  apiToken: string;
  verifyUserJwt(request: any): Promise<string | null>;
  issueJwt(userPeerId: string): Promise<{ token: string; expiresAt: number; peerId: string }>;
  pushEvent(event: string, data: any): void;
  getSnapshot(): any;
  getAvailableApiKeys(): Record<string, boolean>;
  addSSEClient(reply: any): void;
  removeSSEClient(reply: any): void;
  /** #85: Check if an IP has reached the SSE connection limit. Returns true if allowed. */
  checkSSELimit(ip: string): boolean;
  /** #85: Track SSE connection open/close per IP. */
  trackSSEConnection(ip: string, delta: 1 | -1): void;
  doormanClassify(message: string, userPeerId?: string): Promise<{
    intent: 'simple' | 'question' | 'build' | 'project' | 'report' | 'feedback';
    response?: string;
    tier?: number;
    description?: string;
    targetProject?: string;
  }>;
  doormanChat(message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string>;
  decryptIncomingMessage(ciphertext: string, nonce: string, threadMeta: any, encryptedThreadKey?: string): Promise<string>;
  encryptOutgoingMessage(plaintext: string, threadMeta: any, encryptedThreadKey?: string): Promise<{ ciphertext: string; nonce: string }>;
}
