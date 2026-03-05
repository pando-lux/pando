import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, validatePassword } from '../src/auth/password.js';

describe('password', () => {
  it('hash + verify round-trip', async () => {
    const hash = await hashPassword('my-secure-password');
    expect(hash).toContain('$');

    const valid = await verifyPassword('my-secure-password', hash);
    expect(valid).toBe(true);
  });

  it('wrong password fails verification', async () => {
    const hash = await hashPassword('correct');
    const valid = await verifyPassword('wrong', hash);
    expect(valid).toBe(false);
  });

  it('different hashes for same password (random salt)', async () => {
    const h1 = await hashPassword('same-pass');
    const h2 = await hashPassword('same-pass');
    expect(h1).not.toBe(h2); // different salt each time
  });

  it('validatePassword enforces minimum length', () => {
    expect(validatePassword('short')).toBeTruthy();
    expect(validatePassword('12345678')).toBeNull(); // 8 chars, ok
    expect(validatePassword('1234567')).toBeTruthy(); // 7 chars, fail
  });

  it('validatePassword accepts custom min length', () => {
    expect(validatePassword('abc', 3)).toBeNull();
    expect(validatePassword('ab', 3)).toBeTruthy();
  });
});
