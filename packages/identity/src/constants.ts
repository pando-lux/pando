import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_PANDO_DIR = join(homedir(), '.pando');
export const PBKDF2_ITERATIONS = 100_000;
export const PBKDF2_KEYLEN = 32;
export const PBKDF2_DIGEST = 'sha256';
export const AES_ALGORITHM = 'aes-256-gcm';
export const AES_IV_LENGTH = 12;
export const AES_AUTH_TAG_LENGTH = 16;
export const SALT_LENGTH = 16;
export const AGENT_STATUSES = ['pending', 'active', 'idle', 'done', 'failed', 'terminated'] as const;

// JWT
export const JWT_EXPIRY_SECONDS = 86_400; // 24 hours

// Password hashing (scrypt)
export const SCRYPT_N = 16_384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
export const MIN_PASSWORD_LENGTH = 8;
