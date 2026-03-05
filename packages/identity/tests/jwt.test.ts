import { describe, it, expect } from 'vitest';
import { generate } from '../src/core/keypair.js';
import { issueJwt, verifyJwt, decodeJwtPayload } from '../src/auth/jwt.js';

describe('jwt', () => {
  it('issue + verify round-trip for human', async () => {
    const node = await generate();
    const token = await issueJwt('user-peer-id', node.peerId, node.privateKey);

    expect(token).toBeTruthy();
    expect(token.split('.').length).toBe(3);

    const payload = await verifyJwt(token, node.publicKey);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user-peer-id');
    expect(payload!.iss).toBe(node.peerId);
    expect(payload!.typ).toBe('human');
  });

  it('issue + verify for agent', async () => {
    const node = await generate();
    const token = await issueJwt('agent-peer-id', node.peerId, node.privateKey, { typ: 'agent' });

    const payload = await verifyJwt(token, node.publicKey);
    expect(payload).not.toBeNull();
    expect(payload!.typ).toBe('agent');
  });

  it('expired token returns null', async () => {
    const node = await generate();
    const token = await issueJwt('user', node.peerId, node.privateKey, { expirySeconds: -1 });
    const payload = await verifyJwt(token, node.publicKey);
    expect(payload).toBeNull();
  });

  it('tampered token returns null', async () => {
    const node = await generate();
    const token = await issueJwt('user', node.peerId, node.privateKey);
    const tampered = token.slice(0, -5) + 'XXXXX';
    const payload = await verifyJwt(tampered, node.publicKey);
    expect(payload).toBeNull();
  });

  it('wrong public key returns null', async () => {
    const node1 = await generate();
    const node2 = await generate();
    const token = await issueJwt('user', node1.peerId, node1.privateKey);
    const payload = await verifyJwt(token, node2.publicKey);
    expect(payload).toBeNull();
  });

  it('decodeJwtPayload reads without verifying', async () => {
    const node = await generate();
    const token = await issueJwt('user-abc', node.peerId, node.privateKey);
    const payload = decodeJwtPayload(token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user-abc');
  });

  it('decodeJwtPayload returns null for invalid token', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('')).toBeNull();
  });
});
