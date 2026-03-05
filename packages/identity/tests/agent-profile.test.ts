import { describe, it, expect } from 'vitest';
import { createAgent, verifyCertificate, renewCertificate, validateProfile } from '../src/identity/agent-profile.js';
import { generate } from '../src/core/keypair.js';
import type { AgentProfile, EngineAgentConfig } from '../src/types.js';

async function makeHuman() {
  const id = await generate();
  return { peerId: id.peerId, publicKey: id.publicKey, privateKey: id.privateKey };
}

const baseConfig = {
  name: 'test-agent',
  role: 'builder',
  tools: ['read', 'write', 'bash'],
};

describe('agent-profile', () => {
  it('createAgent returns profile + identity with own keypair', async () => {
    const human = await makeHuman();
    const { profile, identity } = await createAgent(baseConfig, human);

    expect(profile.id).toBeTruthy();
    expect(profile.id).toBe(identity.peerId);
    expect(profile.publicKey).toBeTruthy();
    expect(profile.parentId).toBe(human.peerId);
    expect(profile.name).toBe('test-agent');
    expect(profile.role).toBe('builder');
    expect(profile.status).toBe('pending');

    expect(identity.publicKey).toBeInstanceOf(Uint8Array);
    expect(identity.privateKey).toBeInstanceOf(Uint8Array);
    expect(identity.publicKey.length).toBe(32);
  });

  it('agent identity is different from human identity', async () => {
    const human = await makeHuman();
    const { identity } = await createAgent(baseConfig, human);
    expect(identity.peerId).not.toBe(human.peerId);
  });

  it('certificate is signed by human', async () => {
    const human = await makeHuman();
    const { profile } = await createAgent(baseConfig, human);
    const valid = await verifyCertificate(profile.certificate, human.publicKey);
    expect(valid).toBe(true);
  });

  it('certificate fails with wrong human key', async () => {
    const human1 = await makeHuman();
    const human2 = await makeHuman();
    const { profile } = await createAgent(baseConfig, human1);
    const valid = await verifyCertificate(profile.certificate, human2.publicKey);
    expect(valid).toBe(false);
  });

  it('certificate has default 90-day expiry', async () => {
    const human = await makeHuman();
    const { profile } = await createAgent(baseConfig, human);
    const expires = new Date(profile.certificate.expiresAt).getTime();
    const now = Date.now();
    // Should be roughly 90 days from now (give or take a second)
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    expect(expires - now).toBeGreaterThan(ninetyDays - 5000);
    expect(expires - now).toBeLessThan(ninetyDays + 5000);
  });

  it('certificate expiry can be customized', async () => {
    const human = await makeHuman();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days
    const { profile } = await createAgent({ ...baseConfig, expiresAt }, human);
    expect(profile.certificate.expiresAt).toBe(expiresAt);
  });

  it('expired certificate fails verification', async () => {
    const human = await makeHuman();
    const expiresAt = new Date(Date.now() - 1000).toISOString(); // already expired
    const { profile } = await createAgent({ ...baseConfig, expiresAt }, human);
    // With expiry check (default)
    const valid = await verifyCertificate(profile.certificate, human.publicKey);
    expect(valid).toBe(false);
    // Without expiry check — signature is still valid
    const sigValid = await verifyCertificate(profile.certificate, human.publicKey, { checkExpiry: false });
    expect(sigValid).toBe(true);
  });

  it('certificate contains correct permissions', async () => {
    const human = await makeHuman();
    const { profile } = await createAgent({
      ...baseConfig,
      canEarn: true,
      canSpend: true,
      canAuthenticate: true,
      budgetLimit: 500,
    }, human);
    expect(profile.certificate.permissions.canEarn).toBe(true);
    expect(profile.certificate.permissions.canSpend).toBe(true);
    expect(profile.certificate.permissions.canAuthenticate).toBe(true);
    expect(profile.certificate.permissions.budgetLimit).toBe(500);
  });

  it('permissions default to false', async () => {
    const human = await makeHuman();
    const { profile } = await createAgent(baseConfig, human);
    expect(profile.canEarn).toBe(false);
    expect(profile.canSpend).toBe(false);
    expect(profile.canAuthenticate).toBe(false);
  });

  it('agent peerId IS its wallet ID', async () => {
    const human = await makeHuman();
    const { profile, identity } = await createAgent(baseConfig, human);
    expect(profile.id).toBe(identity.peerId);
  });

  it('renewCertificate creates new cert with same agent key', async () => {
    const human = await makeHuman();
    const { profile } = await createAgent(baseConfig, human);
    // Pass a different expiry to guarantee a different canonical form
    const customExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const newCert = await renewCertificate(profile.certificate, human, customExpiry);
    expect(newCert.agentId).toBe(profile.certificate.agentId);
    expect(newCert.agentPublicKey).toBe(profile.certificate.agentPublicKey);
    expect(newCert.expiresAt).toBe(customExpiry);
    expect(newCert.expiresAt).not.toBe(profile.certificate.expiresAt);
    const valid = await verifyCertificate(newCert, human.publicKey);
    expect(valid).toBe(true);
  });

  it('renewCertificate rejects wrong human', async () => {
    const human1 = await makeHuman();
    const human2 = await makeHuman();
    const { profile } = await createAgent(baseConfig, human1);
    await expect(renewCertificate(profile.certificate, human2)).rejects.toThrow('Only the original parent');
  });

  it('throws on missing name', async () => {
    const human = await makeHuman();
    await expect(createAgent({ ...baseConfig, name: '' }, human)).rejects.toThrow('name is required');
  });

  it('throws on missing role', async () => {
    const human = await makeHuman();
    await expect(createAgent({ ...baseConfig, role: '' }, human)).rejects.toThrow('role is required');
  });

  it('throws on negative budgetLimit', async () => {
    const human = await makeHuman();
    await expect(createAgent({ ...baseConfig, budgetLimit: -1 }, human)).rejects.toThrow('budgetLimit must be non-negative');
  });

  it('validates username format', async () => {
    const human = await makeHuman();
    await expect(createAgent({ ...baseConfig, username: 'ab' }, human)).rejects.toThrow('at least 3 characters');
  });

  it('sets default scope', async () => {
    const human = await makeHuman();
    const { profile } = await createAgent(baseConfig, human);
    expect(profile.scope.readPaths).toEqual(['**/*']);
    expect(profile.scope.writePaths).toEqual([]);
  });

  it('AgentProfile satisfies EngineAgentConfig', async () => {
    const human = await makeHuman();
    const { profile } = await createAgent(baseConfig, human);
    const engineConfig: EngineAgentConfig = profile;
    expect(engineConfig.id).toBe(profile.id);
    expect(engineConfig.role).toBe(profile.role);
  });

  it('validateProfile catches missing fields', () => {
    const bad = { status: 'invalid' } as unknown as AgentProfile;
    const errors = validateProfile(bad);
    expect(errors).toContain('id is required');
    expect(errors).toContain('publicKey is required');
    expect(errors).toContain('parentId is required');
    expect(errors).toContain('certificate is required');
  });

  it('validateProfile passes for valid profile', async () => {
    const human = await makeHuman();
    const { profile } = await createAgent(baseConfig, human);
    expect(validateProfile(profile)).toEqual([]);
  });
});
