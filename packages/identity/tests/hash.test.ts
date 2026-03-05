import { describe, it, expect } from 'vitest';
import { sha256, hashTransaction } from '../src/core/hash.js';

describe('hash', () => {
  it('sha256 produces consistent output', () => {
    const h1 = sha256('hello');
    const h2 = sha256('hello');
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64); // 32 bytes = 64 hex chars
  });

  it('sha256 produces different output for different input', () => {
    const h1 = sha256('hello');
    const h2 = sha256('world');
    expect(h1).not.toBe(h2);
  });

  it('hashTransaction returns unique IDs (nonce-based)', () => {
    const h1 = hashTransaction('alice', 'bob', 100, Date.now());
    const h2 = hashTransaction('alice', 'bob', 100, Date.now());
    expect(h1).not.toBe(h2); // nonce makes each call unique
    expect(h1.length).toBe(64);
  });
});
