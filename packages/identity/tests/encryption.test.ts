import { describe, it, expect } from 'vitest';
import {
  deriveKey,
  generateSalt,
  generateIv,
  encrypt,
  decrypt,
  encryptWithPassword,
  decryptWithPassword,
} from '../src/core/encryption.js';

describe('encryption', () => {
  it('generateSalt returns 16 bytes Buffer', () => {
    const salt = generateSalt();
    expect(Buffer.isBuffer(salt)).toBe(true);
    expect(salt.length).toBe(16);
  });

  it('generateIv returns 12 bytes Buffer', () => {
    const iv = generateIv();
    expect(Buffer.isBuffer(iv)).toBe(true);
    expect(iv.length).toBe(12);
  });

  it('deriveKey produces consistent output for same inputs', () => {
    const salt = generateSalt();
    const key1 = deriveKey('password', salt);
    const key2 = deriveKey('password', salt);
    expect(key1).toEqual(key2);
  });

  it('deriveKey produces different output for different passwords', () => {
    const salt = generateSalt();
    const key1 = deriveKey('password1', salt);
    const key2 = deriveKey('password2', salt);
    expect(key1).not.toEqual(key2);
  });

  it('encrypt + decrypt round-trip with key', () => {
    const salt = generateSalt();
    const key = deriveKey('my-password', salt);
    const iv = generateIv();
    const plaintext = 'secret data here';

    const { ciphertext, authTag } = encrypt(plaintext, key, iv);
    expect(ciphertext).not.toBe(plaintext);

    const decrypted = decrypt(ciphertext, authTag, key, iv);
    expect(decrypted).toBe(plaintext);
  });

  it('decrypt with wrong key throws', () => {
    const salt = generateSalt();
    const key1 = deriveKey('correct', salt);
    const key2 = deriveKey('wrong', salt);
    const iv = generateIv();

    const { ciphertext, authTag } = encrypt('secret', key1, iv);
    expect(() => decrypt(ciphertext, authTag, key2, iv)).toThrow();
  });

  it('encryptWithPassword + decryptWithPassword round-trip', () => {
    const password = 'strong-password-123';
    const plaintext = 'my private key data';

    const { ciphertext, salt, iv } = encryptWithPassword(plaintext, password);
    const decrypted = decryptWithPassword(ciphertext, salt, iv, password);
    expect(decrypted).toBe(plaintext);
  });

  it('decryptWithPassword with wrong password throws', () => {
    const { ciphertext, salt, iv } = encryptWithPassword('secret', 'correct');
    expect(() => decryptWithPassword(ciphertext, salt, iv, 'wrong')).toThrow();
  });
});
