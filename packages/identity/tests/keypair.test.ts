import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generate,
  save,
  load,
  loadOrCreate,
  encrypt,
  decrypt,
  saveEncrypted,
  isEncrypted,
  loadRaw,
  list,
  saveToDir,
  getPrivateKey,
} from '../src/core/keypair.js';

let tempDir: string;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'pando-identity-test-'));
  return tempDir;
}

describe('keypair', () => {
  it('generate creates a valid Ed25519 identity', async () => {
    const id = await generate();
    expect(id.peerId).toBeTruthy();
    expect(id.publicKey).toBeInstanceOf(Uint8Array);
    expect(id.privateKey).toBeInstanceOf(Uint8Array);
    expect(id.publicKey.length).toBe(32);
    expect(id.createdAt).toBeGreaterThan(0);
  });

  it('save + load round-trip', async () => {
    const dir = await makeTempDir();
    const id = await generate();
    await save(id, dir);
    const loaded = await load(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.peerId).toBe(id.peerId);
    expect(loaded!.publicKey).toEqual(id.publicKey);
    expect(loaded!.privateKey).toEqual(id.privateKey);
  });

  it('load returns null if no identity exists', async () => {
    const dir = await makeTempDir();
    const result = await load(dir);
    expect(result).toBeNull();
  });

  it('loadOrCreate creates identity if none exists', async () => {
    const dir = await makeTempDir();
    const id = await loadOrCreate(dir);
    expect(id.peerId).toBeTruthy();
    // Second call loads the same identity
    const id2 = await loadOrCreate(dir);
    expect(id2.peerId).toBe(id.peerId);
  });

  it('encrypt + decrypt round-trip', async () => {
    const id = await generate();
    const password = 'test-password-123';
    const encrypted = encrypt(id, password);
    expect(encrypted.encrypted).toBe(true);
    expect(encrypted.peerId).toBe(id.peerId);
    expect(isEncrypted(encrypted)).toBe(true);

    const decrypted = decrypt(encrypted, password);
    expect(decrypted.peerId).toBe(id.peerId);
    expect(decrypted.publicKey).toEqual(id.publicKey);
    expect(decrypted.privateKey).toEqual(id.privateKey);
  });

  it('decrypt with wrong password throws', async () => {
    const id = await generate();
    const encrypted = encrypt(id, 'correct');
    expect(() => decrypt(encrypted, 'wrong')).toThrow();
  });

  it('saveEncrypted + loadRaw round-trip', async () => {
    const dir = await makeTempDir();
    const id = await generate();
    const encrypted = encrypt(id, 'pass123');
    await saveEncrypted(encrypted, dir);

    const raw = await loadRaw(dir);
    expect(raw).not.toBeNull();
    expect(isEncrypted(raw!)).toBe(true);

    // load() returns null for encrypted identity
    const plain = await load(dir);
    expect(plain).toBeNull();
  });

  it('list finds identities', async () => {
    const dir = await makeTempDir();
    const id1 = await generate();
    await save(id1, dir);
    const ids = list(dir);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids[0].peerId).toBe(id1.peerId);
  });

  it('saveToDir saves to identities/ subdirectory', async () => {
    const dir = await makeTempDir();
    const id = await generate();
    await saveToDir(id, dir);
    const ids = list(dir);
    expect(ids.some(i => i.peerId === id.peerId)).toBe(true);
  });

  it('getPrivateKey returns a usable PrivateKey object', async () => {
    const id = await generate();
    const pk = getPrivateKey(id);
    expect(pk).toBeTruthy();
    expect(pk.type).toBe('Ed25519');
  });
});
