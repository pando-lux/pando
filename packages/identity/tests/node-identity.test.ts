import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNodeIdentity, loadNodeIdentity } from '../src/identity/node-identity.js';

let tempDir: string;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'pando-node-identity-test-'));
  return tempDir;
}

describe('node-identity', () => {
  it('createNodeIdentity generates and saves identity', async () => {
    const dir = await makeTempDir();
    const id = await createNodeIdentity({ dataDir: dir });
    expect(id.peerId).toBeTruthy();
    expect(id.publicKey).toBeInstanceOf(Uint8Array);
    expect(id.publicKey.length).toBe(32);
  });

  it('createNodeIdentity with persist=false does not save', async () => {
    const dir = await makeTempDir();
    const id = await createNodeIdentity({ dataDir: dir, persist: false });
    expect(id.peerId).toBeTruthy();
    // Loading should return a new identity (nothing was saved)
    const loaded = await loadNodeIdentity(dir);
    expect(loaded.peerId).not.toBe(id.peerId);
  });

  it('loadNodeIdentity loads existing or creates new', async () => {
    const dir = await makeTempDir();
    const id1 = await loadNodeIdentity(dir);
    const id2 = await loadNodeIdentity(dir);
    expect(id1.peerId).toBe(id2.peerId);
  });

  it('createNodeIdentity + loadNodeIdentity round-trip', async () => {
    const dir = await makeTempDir();
    const created = await createNodeIdentity({ dataDir: dir });
    const loaded = await loadNodeIdentity(dir);
    expect(loaded.peerId).toBe(created.peerId);
    expect(loaded.publicKey).toEqual(created.publicKey);
  });
});
