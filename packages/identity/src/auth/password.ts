import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_KEYLEN, MIN_PASSWORD_LENGTH } from '../constants.js';

/**
 * Hash a password using scrypt.
 * Returns format: salt$hash (both hex-encoded).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt);
  return `${salt}$${hash}`;
}

/**
 * Verify a password against a stored hash.
 * Uses timing-safe comparison.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, expectedHash] = stored.split('$');
  if (!salt || !expectedHash) return false;

  const hash = await scryptAsync(password, salt);
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hash, 'hex');

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Validate password strength. Returns null if valid, error string if invalid.
 */
export function validatePassword(password: string, minLength?: number): string | null {
  const min = minLength ?? MIN_PASSWORD_LENGTH;
  if (password.length < min) return `password must be at least ${min} characters`;
  return null;
}

/**
 * scrypt promisified wrapper.
 */
function scryptAsync(password: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}
