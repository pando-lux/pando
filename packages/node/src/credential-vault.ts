/**
 * Credential Vault — AES-256-GCM encryption utilities for credentials.
 *
 * Phase 69: Simplified to just encrypt/decrypt. Used by CredentialStore for
 * encrypting credentials in MongoDB with the master key.
 *
 * The X25519 ECDH key wrapping (wrapDataKey, unwrapDataKey) was removed in
 * Phase 69 — credentials are no longer wrapped per-node. Instead, a single
 * master key (CREDENTIAL_MASTER_KEY) is used, held only by trusted EC2 nodes.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/** Generate a random 256-bit AES data key */
export function generateDataKey(): Uint8Array {
  return randomBytes(32);
}

/** AES-256-GCM encrypt a plaintext string. Returns base64 ciphertext and nonce. */
export function encryptCredential(plaintext: string, dataKey: Uint8Array): { ciphertext: string; nonce: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([enc, tag]);
  return {
    ciphertext: combined.toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

/** AES-256-GCM decrypt. ciphertext and nonce are base64. */
export function decryptCredential(ciphertext: string, nonce: string, dataKey: Uint8Array): string {
  const combined = Buffer.from(ciphertext, 'base64');
  const nonceBytes = Buffer.from(nonce, 'base64');
  const tag = combined.subarray(combined.length - 16);
  const encrypted = combined.subarray(0, combined.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', dataKey, nonceBytes);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
