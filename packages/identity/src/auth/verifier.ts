import { verify, verifyPayload } from '../core/signing.js';

/**
 * Verify a raw signature against data and an Ed25519 public key.
 * This is the core of Pando Login (Step 2 — offline verification).
 * No network needed — just data, signature, and public key.
 */
export async function verifySignature(
  data: Uint8Array,
  signature: string,
  publicKeyRaw: Uint8Array,
): Promise<boolean> {
  return verify(data, signature, publicKeyRaw);
}

/**
 * Verify a JSON payload's signature against an Ed25519 public key.
 * The payload object is serialized deterministically (excluding 'signature' field).
 */
export async function verifyPayloadSignature(
  payload: Record<string, unknown>,
  signature: string,
  publicKeyRaw: Uint8Array,
): Promise<boolean> {
  return verifyPayload(payload, signature, publicKeyRaw);
}
