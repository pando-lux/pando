import { createHash, randomBytes } from 'node:crypto';

/**
 * SHA-256 hash of arbitrary data.
 */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hash transaction fields for a deterministic-ish transaction ID.
 * Includes a random nonce to prevent ID collisions for identical transactions.
 */
export function hashTransaction(from: string, to: string, amount: number, timestamp: number): string {
  const nonce = randomBytes(8).toString('hex');
  const data = `${from}:${to}:${amount}:${timestamp}:${nonce}`;
  return sha256(data);
}
