import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import {
  PBKDF2_ITERATIONS,
  PBKDF2_KEYLEN,
  PBKDF2_DIGEST,
  AES_ALGORITHM,
  AES_IV_LENGTH,
  SALT_LENGTH,
} from '../constants.js';

/**
 * Derive a 256-bit AES key from a password using PBKDF2.
 */
export function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
}

/**
 * Generate a random salt.
 */
export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

/**
 * Generate a random IV for AES-GCM.
 */
export function generateIv(): Buffer {
  return randomBytes(AES_IV_LENGTH);
}

/**
 * Encrypt plaintext with AES-256-GCM using a raw key.
 */
export function encrypt(plaintext: string, key: Buffer, iv: Buffer): { ciphertext: string; authTag: string } {
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

/**
 * Decrypt ciphertext with AES-256-GCM using a raw key.
 */
export function decrypt(ciphertext: string, authTag: string, key: Buffer, iv: Buffer): string {
  const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  return decipher.update(Buffer.from(ciphertext, 'hex')).toString('utf8') + decipher.final('utf8');
}

/**
 * Encrypt plaintext with a password (PBKDF2 key derivation + AES-256-GCM).
 * Returns hex-encoded salt, iv, and ciphertext (ciphertext includes auth tag).
 */
export function encryptWithPassword(
  plaintext: string,
  password: string
): { ciphertext: string; salt: string; iv: string } {
  const salt = generateSalt();
  const iv = generateIv();
  const key = deriveKey(password, salt);

  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString('hex'),
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
  };
}

/**
 * Decrypt ciphertext encrypted with encryptWithPassword.
 * Throws "Wrong password" if the password is incorrect.
 */
export function decryptWithPassword(
  ciphertext: string,
  saltHex: string,
  ivHex: string,
  password: string
): string {
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedBuffer = Buffer.from(ciphertext, 'hex');

  const authTag = encryptedBuffer.subarray(-16);
  const data = encryptedBuffer.subarray(0, -16);

  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(AES_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    return decipher.update(data).toString('utf8') + decipher.final('utf8');
  } catch {
    throw new Error('Wrong password');
  }
}
