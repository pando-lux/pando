import { sign, verify } from '../core/signing.js';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import type { SignedAction, AgentCertificate } from '../types.js';

/**
 * Data needed to create a signed action.
 */
export interface ActionInput {
  agentId: string;
  action: string;
  payload: unknown;
}

/**
 * Create a SignedAction — proof that an agent performed an action.
 * Signed by the AGENT's own Ed25519 key (not a node's).
 * Includes the agent's certificate so verifiers can check the full trust chain offline.
 */
export async function createSignedAction(
  input: ActionInput,
  agentPrivateKey: Uint8Array,
  agentPublicKey: Uint8Array,
  certificate: AgentCertificate,
): Promise<SignedAction> {
  const timestamp = new Date().toISOString();
  const canonical = buildCanonical(input.agentId, input.action, input.payload, timestamp);
  const data = new TextEncoder().encode(canonical);
  const signature = await sign(data, agentPrivateKey);

  return {
    agentId: input.agentId,
    action: input.action,
    payload: input.payload,
    timestamp,
    agentPublicKey: uint8ArrayToString(agentPublicKey, 'base64'),
    signature,
    certificate,
  };
}

/**
 * Verify a SignedAction's signature against the agent's public key.
 * This only checks the action signature — use verifySignedActionFull() for the trust chain.
 */
export async function verifySignedAction(action: SignedAction): Promise<boolean> {
  const publicKeyRaw = uint8ArrayFromString(action.agentPublicKey, 'base64');
  const canonical = buildCanonical(action.agentId, action.action, action.payload, action.timestamp);
  const data = new TextEncoder().encode(canonical);
  return verify(data, action.signature, publicKeyRaw);
}

/**
 * Verify the full trust chain of a SignedAction:
 * 1. Agent public key matches certificate
 * 2. Agent ID matches certificate
 * 3. Agent's action signature is valid
 * 4. Certificate not expired (checked against current time, not action timestamp)
 * 5. Certificate is signed by the human
 *
 * All offline — no network needed.
 */
export async function verifySignedActionFull(
  action: SignedAction,
  humanPublicKey: Uint8Array,
): Promise<{ valid: boolean; reason?: string }> {
  // 1. Check agent public key matches certificate
  if (action.agentPublicKey !== action.certificate.agentPublicKey) {
    return { valid: false, reason: 'agent public key does not match certificate' };
  }

  // 2. Check agentId matches certificate
  if (action.agentId !== action.certificate.agentId) {
    return { valid: false, reason: 'agent ID does not match certificate' };
  }

  // 3. Verify the action signature (agent signed this)
  const actionValid = await verifySignedAction(action);
  if (!actionValid) {
    return { valid: false, reason: 'invalid action signature' };
  }

  // 4. Check certificate expiry against CURRENT TIME (not action timestamp)
  const { verifyCertificate } = await import('./agent-profile.js');
  const now = Date.now();
  const expires = new Date(action.certificate.expiresAt).getTime();
  if (now > expires) {
    return { valid: false, reason: 'certificate expired' };
  }

  // 5. Verify the certificate signature (human signed this)
  const certValid = await verifyCertificate(action.certificate, humanPublicKey, { checkExpiry: false });
  if (!certValid) {
    return { valid: false, reason: 'invalid certificate signature' };
  }

  return { valid: true };
}

/**
 * Deterministic JSON serialization with recursively sorted keys.
 * Handles nested objects, arrays, nulls, primitives.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
  }
  return 'null';
}

function buildCanonical(agentId: string, action: string, payload: unknown, timestamp: string): string {
  return `${agentId}:${action}:${stableStringify(payload)}:${timestamp}`;
}
