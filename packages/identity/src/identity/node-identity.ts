import { generate, save, load, loadOrCreate } from '../core/keypair.js';
import type { NodeIdentity } from '../types.js';

/**
 * Create a new node identity (Ed25519 keypair) and optionally save to disk.
 */
export async function createNodeIdentity(opts?: {
  dataDir?: string;
  persist?: boolean;
}): Promise<NodeIdentity> {
  const identity = await generate();
  if (opts?.persist !== false) {
    await save(identity, opts?.dataDir);
  }
  return identity;
}

/**
 * Load an existing node identity from disk, or create one if none exists.
 */
export async function loadNodeIdentity(dataDir?: string): Promise<NodeIdentity> {
  return loadOrCreate(dataDir);
}
