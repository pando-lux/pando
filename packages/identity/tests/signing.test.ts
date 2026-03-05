import { describe, it, expect } from 'vitest';
import { generate } from '../src/core/keypair.js';
import { sign, verify, signPayload, verifyPayload } from '../src/core/signing.js';

describe('signing', () => {
  it('sign + verify round-trip', async () => {
    const id = await generate();
    const data = new TextEncoder().encode('hello pando');
    const signature = await sign(data, id.privateKey);

    expect(signature).toBeTruthy();
    expect(typeof signature).toBe('string');

    const valid = await verify(data, signature, id.publicKey);
    expect(valid).toBe(true);
  });

  it('verify fails with tampered data', async () => {
    const id = await generate();
    const data = new TextEncoder().encode('original');
    const signature = await sign(data, id.privateKey);

    const tampered = new TextEncoder().encode('tampered');
    const valid = await verify(tampered, signature, id.publicKey);
    expect(valid).toBe(false);
  });

  it('verify fails with wrong public key', async () => {
    const id1 = await generate();
    const id2 = await generate();
    const data = new TextEncoder().encode('hello');
    const signature = await sign(data, id1.privateKey);

    const valid = await verify(data, signature, id2.publicKey);
    expect(valid).toBe(false);
  });

  it('signPayload + verifyPayload round-trip', async () => {
    const id = await generate();
    const payload = { from: 'alice', to: 'bob', amount: 100 };
    const signature = await signPayload(payload, id.privateKey);

    const valid = await verifyPayload(payload, signature, id.publicKey);
    expect(valid).toBe(true);
  });

  it('verifyPayload ignores existing signature field', async () => {
    const id = await generate();
    const payload = { from: 'alice', to: 'bob', amount: 100, signature: 'old-sig' };
    const signature = await signPayload(payload, id.privateKey);

    const valid = await verifyPayload(
      { ...payload, signature: 'something-else' },
      signature,
      id.publicKey,
    );
    expect(valid).toBe(true);
  });
});
