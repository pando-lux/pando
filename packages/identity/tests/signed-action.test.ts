import { describe, it, expect } from 'vitest';
import { generate } from '../src/core/keypair.js';
import { createAgent } from '../src/identity/agent-profile.js';
import {
  createSignedAction,
  verifySignedAction,
  verifySignedActionFull,
  stableStringify,
} from '../src/identity/signed-action.js';

async function makeHumanAndAgent(certOpts?: { expiresAt?: string }) {
  const human = await generate();
  const { profile, identity: agent } = await createAgent(
    { name: 'test-agent', role: 'builder', tools: ['read'], ...certOpts },
    { peerId: human.peerId, publicKey: human.publicKey, privateKey: human.privateKey },
  );
  return { human, agent, profile };
}

describe('signed-action', () => {
  it('create + verify round-trip', async () => {
    const { agent, profile } = await makeHumanAndAgent();
    const action = await createSignedAction(
      { agentId: agent.peerId, action: 'deploy', payload: { project: 'test' } },
      agent.privateKey, agent.publicKey, profile.certificate,
    );
    expect(action.agentId).toBe(agent.peerId);
    expect(action.signature).toBeTruthy();
    expect(await verifySignedAction(action)).toBe(true);
  });

  it('tampered payload fails', async () => {
    const { agent, profile } = await makeHumanAndAgent();
    const action = await createSignedAction(
      { agentId: agent.peerId, action: 'deploy', payload: { project: 'test' } },
      agent.privateKey, agent.publicKey, profile.certificate,
    );
    action.payload = { project: 'hacked' };
    expect(await verifySignedAction(action)).toBe(false);
  });

  it('tampered agentId fails', async () => {
    const { agent, profile } = await makeHumanAndAgent();
    const action = await createSignedAction(
      { agentId: agent.peerId, action: 'deploy', payload: {} },
      agent.privateKey, agent.publicKey, profile.certificate,
    );
    action.agentId = 'agent-evil';
    expect(await verifySignedAction(action)).toBe(false);
  });

  it('wrong agent key fails', async () => {
    const { agent, profile } = await makeHumanAndAgent();
    const otherAgent = await generate();
    const action = await createSignedAction(
      { agentId: agent.peerId, action: 'deploy', payload: {} },
      agent.privateKey, agent.publicKey, profile.certificate,
    );
    const { toString } = await import('uint8arrays');
    action.agentPublicKey = toString(otherAgent.publicKey, 'base64');
    expect(await verifySignedAction(action)).toBe(false);
  });

  it('full trust chain verification', async () => {
    const { human, agent, profile } = await makeHumanAndAgent();
    const action = await createSignedAction(
      { agentId: agent.peerId, action: 'deploy', payload: { x: 1 } },
      agent.privateKey, agent.publicKey, profile.certificate,
    );
    const result = await verifySignedActionFull(action, human.publicKey);
    expect(result.valid).toBe(true);
  });

  it('full verification fails with wrong human key', async () => {
    const { agent, profile } = await makeHumanAndAgent();
    const wrongHuman = await generate();
    const action = await createSignedAction(
      { agentId: agent.peerId, action: 'deploy', payload: {} },
      agent.privateKey, agent.publicKey, profile.certificate,
    );
    const result = await verifySignedActionFull(action, wrongHuman.publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid certificate signature');
  });

  it('full verification catches mismatched certificate agentId', async () => {
    const { human, agent, profile } = await makeHumanAndAgent();
    const action = await createSignedAction(
      { agentId: agent.peerId, action: 'deploy', payload: {} },
      agent.privateKey, agent.publicKey, profile.certificate,
    );
    action.agentId = 'fake-id';
    const result = await verifySignedActionFull(action, human.publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('agent ID does not match');
  });

  it('full verification rejects expired certificate', async () => {
    const expiresAt = new Date(Date.now() - 1000).toISOString();
    const { human, agent, profile } = await makeHumanAndAgent({ expiresAt });
    const action = await createSignedAction(
      { agentId: agent.peerId, action: 'deploy', payload: {} },
      agent.privateKey, agent.publicKey, profile.certificate,
    );
    const result = await verifySignedActionFull(action, human.publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('certificate expired');
  });

  it('certificate from agent A cannot be used for agent B', async () => {
    const { human, profile: profileA } = await makeHumanAndAgent();
    const { agent: agentB, profile: profileB } = await makeHumanAndAgent();

    // Agent B signs action but attaches agent A's certificate
    const action = await createSignedAction(
      { agentId: agentB.peerId, action: 'deploy', payload: {} },
      agentB.privateKey, agentB.publicKey, profileA.certificate,
    );
    const result = await verifySignedActionFull(action, human.publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('does not match certificate');
  });

  it('handles null payload', async () => {
    const { agent, profile } = await makeHumanAndAgent();
    const action = await createSignedAction(
      { agentId: agent.peerId, action: 'noop', payload: null },
      agent.privateKey, agent.publicKey, profile.certificate,
    );
    expect(await verifySignedAction(action)).toBe(true);
  });

  it('handles nested object payload deterministically', async () => {
    const { agent, profile } = await makeHumanAndAgent();
    const action = await createSignedAction(
      { agentId: agent.peerId, action: 'deploy', payload: { b: { z: 1, a: 2 }, a: [3, 1] } },
      agent.privateKey, agent.publicKey, profile.certificate,
    );
    expect(await verifySignedAction(action)).toBe(true);
  });
});

describe('stableStringify', () => {
  it('sorts top-level keys', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested keys recursively', () => {
    expect(stableStringify({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('handles arrays (preserves order)', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles null and undefined', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
  });

  it('handles primitives', () => {
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(true)).toBe('true');
  });
});
