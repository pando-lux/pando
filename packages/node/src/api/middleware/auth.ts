/**
 * Auth middleware helpers — Phase 86 JWT-based stateless auth.
 *
 * These helpers are used by all route modules.
 * They are constructed from the ApiServer instance and passed to route
 * registration functions as part of the RouteHelpers dependency object.
 */

import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { publicKeyFromProtobuf } from '@libp2p/crypto/keys';
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
  doormanClassify(message: string): Promise<{
    intent: 'simple' | 'question' | 'build' | 'project';
    response?: string;
    tier?: number;
    description?: string;
  }>;
  doormanChat(message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string>;
  decryptIncomingMessage(ciphertext: string, nonce: string, threadMeta: any, encryptedThreadKey?: string): Promise<string>;
  encryptOutgoingMessage(plaintext: string, threadMeta: any, encryptedThreadKey?: string): Promise<{ ciphertext: string; nonce: string }>;
}

// ── Auth Helper Factory ──────────────────────────────────────────────────────

/**
 * Create auth helpers bound to a node instance and API token.
 * Called once by ApiServer constructor; the returned object is passed
 * to all registerRoutes functions.
 */
export function createAuthHelpers(node: PandoNode, apiToken: string) {
  /**
   * Extract user session token from the X-User-Token header or Authorization header.
   */
  function extractUserToken(request: any): string | null {
    const userToken = request.headers['x-user-token'];
    if (userToken && typeof userToken === 'string' && userToken.length > 0) {
      return userToken;
    }
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (token !== apiToken && token.length >= 64) {
        return token;
      }
    }
    return null;
  }

  /**
   * Phase 86: Verify a JWT token string.
   * Returns the user peerId if valid, null otherwise.
   */
  async function verifyJwtToken(token: string): Promise<string | null> {
    const dotIdx = token.indexOf('.');
    if (dotIdx === -1 || dotIdx === 0 || dotIdx === token.length - 1) return null;

    const payloadB64 = token.substring(0, dotIdx);
    const signatureHex = token.substring(dotIdx + 1);

    try {
      const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson);

      if (!payload.sub || !payload.iss || !payload.exp || payload.typ !== 'user') return null;
      if (payload.exp <= Date.now()) return null;

      const { peerIdFromString } = await import('@libp2p/peer-id');
      const issuerPeerIdObj = peerIdFromString(payload.iss);
      const issuerPubKey = issuerPeerIdObj.publicKey;
      if (!issuerPubKey) return null;

      const payloadBytes = new TextEncoder().encode(payloadB64);
      const sigBytes = uint8ArrayFromString(signatureHex, 'base16');

      const verified = await issuerPubKey.verify(payloadBytes, sigBytes);
      if (!verified) return null;

      return payload.sub;
    } catch {
      return null;
    }
  }

  /**
   * Phase 86: Extract and verify JWT from request headers.
   */
  async function verifyUserJwt(request?: any): Promise<string | null> {
    if (!request) return null;
    const token = extractUserToken(request);
    if (!token) return null;
    return verifyJwtToken(token);
  }

  /**
   * Phase 86: Issue a JWT signed by this node for a given user peerId.
   */
  async function issueJwt(userPeerId: string): Promise<{ token: string; expiresAt: number; peerId: string }> {
    const identity = node.getIdentity();
    if (!identity) throw new Error('Node identity not available');

    const expiresAt = Date.now() + 24 * 60 * 60_000;
    const payload = {
      sub: userPeerId,
      iss: identity.peerId,
      iat: Date.now(),
      exp: expiresAt,
      typ: 'user',
    };

    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const payloadBytes = new TextEncoder().encode(payloadB64);

    const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
    const pk = privateKeyFromProtobuf(identity.privateKey);
    const sig = await pk.sign(payloadBytes);
    const signatureHex = uint8ArrayToString(sig, 'base16');

    const token = payloadB64 + '.' + signatureHex;
    return { token, expiresAt, peerId: userPeerId };
  }

  return { verifyUserJwt, issueJwt };
}
