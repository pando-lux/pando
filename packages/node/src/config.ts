import { join } from 'node:path';
import { homedir } from 'node:os';
import type { NodeConfig } from '@pando/shared';
import { NodeTier } from '@pando/shared';

const PANDO_DIR = join(homedir(), '.pando');

export function getDefaultConfig(overrides?: Partial<NodeConfig>): NodeConfig {
  return {
    listenPort: 0,
    apiPort: 4000,
    dataDir: PANDO_DIR,
    bootstrapPeers: [],
    tier: NodeTier.WORK,
    nodeMode: 'full',
    ledgerMode: 'full',
    ...overrides,
  };
}

export function parsePort(portArg?: string): number {
  if (!portArg) return 0;
  const port = parseInt(portArg, 10);
  if (isNaN(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portArg}`);
  }
  return port;
}
