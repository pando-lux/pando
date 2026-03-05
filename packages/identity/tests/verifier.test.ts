import { describe, it, expect } from 'vitest';
import { generate } from '../src/core/keypair.js';
import { sign } from '../src/core/signing.js';
import { verifySignature, verifyPayloadSignature } from '../src/auth/verifier.js';

describe('verifier', () => {
  it('verifySignature accepts valid signature', async () => {
    const id = await generate();
    const data = new TextEncoder().encode('test data');
    const signature = await sign(data, id.privateKey);
    expect(await verifySignature(data, signature, id.publicKey)).toBe(true);
  });

  it('verifySignature rejects tampered data', async () => {
    const id = await generate();
    const data = new TextEncoder().encode('original');
    const signature = await sign(data, id.privateKey);
    const tampered = new TextEncoder().encode('tampered');
    expect(await verifySignature(tampered, signature, id.publicKey)).toBe(false);
  });

  it('verifySignature rejects wrong key', async () => {
    const id1 = await generate();
    const id2 = await generate();
    const data = new TextEncoder().encode('test');
    const signature = await sign(data, id1.privateKey);
    expect(await verifySignature(data, signature, id2.publicKey)).toBe(false);
  });

  it('verifyPayloadSignature round-trip', async () => {
    const id = await generate();
    const { signPayload } = await import('../src/core/signing.js');
    const payload = { action: 'transfer', amount: 100, to: 'bob' };
    const signature = await signPayload(payload, id.privateKey);
    expect(await verifyPayloadSignature(payload, signature, id.publicKey)).toBe(true);
  });

  it('verifyPayloadSignature rejects tampered payload', async () => {
    const id = await generate();
    const { signPayload } = await import('../src/core/signing.js');
    const payload = { action: 'transfer', amount: 100 };
    const signature = await signPayload(payload, id.privateKey);
    expect(await verifyPayloadSignature({ action: 'transfer', amount: 999 }, signature, id.publicKey)).toBe(false);
  });
});
