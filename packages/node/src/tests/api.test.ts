/**
 * Integration tests for the Pando Node HTTP API.
 *
 * Spins up a real PandoNode on random ports with an isolated data directory,
 * tests all key HTTP endpoints, then tears everything down.
 *
 * Uses node:test (built-in) — no extra dependencies required.
 * Run: node --test dist/tests/api.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PandoNode } from '../index.js';

// Polyfill for Node < 22 (Promise.withResolvers is Node 22+)
if (typeof (Promise as any).withResolvers !== 'function') {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

let node: PandoNode;
let apiBase: string;
let dataDir: string;

/** Find a free TCP port by binding to port 0. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not get port')));
      }
    });
    srv.on('error', reject);
  });
}

/** Helper: fetch JSON from the test node API. */
async function api(path: string, options?: RequestInit): Promise<{ status: number; data: any }> {
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

// ── Setup & Teardown ──

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pando-test-'));
  const apiPort = await findFreePort();
  const listenPort = await findFreePort();

  node = new PandoNode({
    dataDir,
    apiPort,
    listenPort,
    bootstrapPeers: [],
  });

  await node.start();
  apiBase = `http://127.0.0.1:${apiPort}`;

  // Brief pause for Fastify to be fully ready
  await new Promise(r => setTimeout(r, 500));
});

after(async () => {
  await node.stop();
  // Clean up test data directory
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

// ── Tests ──

describe('GET /health', () => {
  it('returns healthy status', async () => {
    const { status, data } = await api('/health');
    assert.equal(status, 200);
    assert.equal(data.status, 'healthy');
    assert.ok(data.peerId);
    assert.equal(typeof data.peers, 'number');
    assert.equal(typeof data.uptime, 'number');
    assert.equal(data.version, '0.1.0');
  });
});

describe('GET /status', () => {
  it('returns node status with expected fields', async () => {
    const { status, data } = await api('/status');
    assert.equal(status, 200);
    assert.equal(data.connected, true);
    assert.ok(data.peerId);
    assert.equal(data.peerId, data.identity);
    assert.equal(typeof data.balance, 'number');
    assert.equal(typeof data.totalSupply, 'number');
    assert.equal(typeof data.totalAccounts, 'number');
    assert.equal(typeof data.uptime, 'number');
    assert.ok(Array.isArray(data.peerList));
    assert.ok(Array.isArray(data.listenAddresses));
  });
});
describe('GET /wallet', () => {
  it('returns wallet info', async () => {
    const { status, data } = await api('/wallet');
    assert.equal(status, 200);
    assert.ok(data.peerId);
    assert.ok(data.publicKey);
    assert.equal(typeof data.balance, 'number');
    assert.ok(data.ownership);
    assert.ok(data.ownership.identityFile);
    assert.ok(data.dataDir);
  });
});

describe('GET /peers', () => {
  it('returns peers array', async () => {
    const { status, data } = await api('/peers');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.peers));
  });
});

describe('GET /balance/:peerId', () => {
  it('returns balance for own peer ID', async () => {
    const statusRes = await api('/status');
    const peerId = statusRes.data.peerId;
    const { status, data } = await api('/balance/' + peerId);
    assert.equal(status, 200);
    assert.equal(data.peerId, peerId);
    assert.equal(typeof data.balance, 'number');
  });

  it('returns zero balance for unknown peer', async () => {
    const { status, data } = await api('/balance/12D3KooWFAKEPEERIDTHATDOESNOTEXIST');
    assert.equal(status, 200);
    assert.equal(data.balance, 0);
  });
});

describe('POST /transfer', () => {
  it('rejects transfer with missing fields', async () => {
    const { status, data } = await api('/transfer', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('rejects transfer to self', async () => {
    const statusRes = await api('/status');
    const peerId = statusRes.data.peerId;
    const { status, data } = await api('/transfer', {
      method: 'POST',
      body: JSON.stringify({ to: peerId, amount: 1 }),
    });
    assert.equal(status, 400);
    assert.equal(data.code, 'SELF_TRANSFER');
  });

  it('rejects transfer to unknown non-peer', async () => {
    const { status, data } = await api('/transfer', {
      method: 'POST',
      body: JSON.stringify({ to: '12D3KooWFAKEPEERIDTHATDOESNOTEXIST', amount: 0.001 }),
    });
    assert.equal(status, 404);
    assert.equal(data.code, 'RECIPIENT_NOT_FOUND');
  });

  it('rejects transfer with invalid amount', async () => {
    const { status, data } = await api('/transfer', {
      method: 'POST',
      body: JSON.stringify({ to: '12D3KooWFAKEPEERIDTHATDOESNOTEXIST', amount: -5 }),
    });
    assert.equal(status, 400);
    assert.equal(data.code, 'INVALID_AMOUNT');
  });
});

describe('POST /search', () => {
  it('rejects search without query', async () => {
    const { status, data } = await api('/search', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('returns search result (may be no API key message)', async () => {
    const { status, data } = await api('/search', {
      method: 'POST',
      body: JSON.stringify({ query: 'what is Pando?' }),
    });
    assert.equal(status, 200);
    assert.ok(data.answer);
    assert.ok(data.respondedBy);
  });
});

describe('GET /agent/status (removed)', () => {
  it('returns 404 for old agent route', async () => {
    const { status } = await api('/agent/status');
    assert.equal(status, 404);
  });
});

describe('GET /bootstrap', () => {
  it('returns bootstrap info', async () => {
    const { status, data } = await api('/bootstrap');
    assert.equal(status, 200);
    assert.ok(data.peerId);
    assert.ok(Array.isArray(data.addrs));
  });
});

describe('GET /onboard', () => {
  it('returns onboarding info', async () => {
    const { status, data } = await api('/onboard');
    assert.equal(status, 200);
    assert.ok(data.bootstrapAddrs);
    assert.ok(data.instructions);
    assert.equal(data.version, '0.1.0');
    assert.ok(data.peerId);
    assert.equal(typeof data.peerCount, 'number');
  });
});
describe('GET /activity', () => {
  it('returns activity events array', async () => {
    const { status, data } = await api('/activity');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.events));
    assert.ok(data.nodeId);
  });
});

describe('POST /activity/record', () => {
  it('rejects record with missing fields', async () => {
    const { status, data } = await api('/activity/record', {
      method: 'POST',
      body: JSON.stringify({ id: 'test-1' }),
    });
    assert.equal(status, 400);
    assert.ok(data.error);
  });

  it('rejects record with invalid action type', async () => {
    const { status, data } = await api('/activity/record', {
      method: 'POST',
      body: JSON.stringify({
        id: 'test-invalid-action',
        agentId: 'test-agent',
        action: 'totally_invalid_action',
        summary: 'test',
        signature: 'test-sig',
        timestamp: Date.now(),
      }),
    });
    assert.equal(status, 400);
    assert.ok(data.error.includes('Invalid action'));
  });

  it('records valid activity', async () => {
    const { status, data } = await api('/activity/record', {
      method: 'POST',
      body: JSON.stringify({
        id: 'test-' + Date.now(),
        agentId: 'test-agent',
        action: 'health_check',
        summary: 'Integration test activity record',
        signature: 'test-sig',
        timestamp: Date.now(),
      }),
    });
    assert.equal(status, 200);
    assert.equal(data.success, true);
  });
});

describe('GET /snapshot', () => {
  it('returns snapshot info or 404 if none', async () => {
    const { status } = await api('/snapshot');
    assert.ok(status === 200 || status === 404);
  });
});

describe('Governance endpoints', () => {
  let proposalId: string;

  it('GET /governance/proposals returns array', async () => {
    const { status, data } = await api('/governance/proposals');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.proposals));
  });

  it('GET /governance/proposals/active returns array', async () => {
    const { status, data } = await api('/governance/proposals/active');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.proposals));
  });

  it('POST /governance/propose creates a proposal', async () => {
    const { status, data } = await api('/governance/propose', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Test proposal from integration tests',
        description: 'This is a test proposal created by the automated test suite.',
      }),
    });
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.ok(data.proposal);
    assert.ok(data.proposal.id);
    proposalId = data.proposal.id;
  });

  it('POST /governance/vote votes on the proposal', async () => {
    const { status, data } = await api('/governance/vote', {
      method: 'POST',
      body: JSON.stringify({
        proposalId,
        choice: 'approve',
        reasoning: 'Automated test vote',
      }),
    });
    assert.equal(status, 200);
    assert.equal(data.success, true);
  });

  it('POST /governance/comment adds a comment', async () => {
    const { status, data } = await api('/governance/comment', {
      method: 'POST',
      body: JSON.stringify({
        proposalId,
        content: 'Automated test comment',
      }),
    });
    assert.equal(status, 200);
    assert.equal(data.success, true);
  });

  it('POST /governance/comment rejects comment on nonexistent proposal', async () => {
    const { status, data } = await api('/governance/comment', {
      method: 'POST',
      body: JSON.stringify({
        proposalId: 'nonexistent-proposal-id-12345',
        content: 'This should fail',
      }),
    });
    assert.equal(status, 404);
    assert.ok(data.error);
  });

  it('GET /governance/proposal/:id returns proposal details', async () => {
    const { status, data } = await api('/governance/proposal/' + proposalId);
    assert.equal(status, 200);
    assert.ok(data.proposal);
    assert.equal(data.proposal.id, proposalId);
    assert.ok(Array.isArray(data.comments));
    assert.ok(Array.isArray(data.votes));
  });
});
describe('GET /transactions', () => {
  it('returns transactions array', async () => {
    const { status, data } = await api('/transactions');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.transactions));
    assert.ok(data.peerId);
  });
});

describe('GET /network/overview', () => {
  it('returns comprehensive overview', async () => {
    const { status, data } = await api('/network/overview');
    assert.equal(status, 200);
    assert.ok(data.nodes);
    assert.ok(data.agents);
    assert.ok(data.luxMetrics);
    assert.equal(typeof data.uptime, 'number');
    assert.equal(typeof data.luxMetrics.totalSupply, 'number');
  });
});

describe('GET /network/topology', () => {
  it('returns nodes and edges arrays', async () => {
    const { status, data } = await api('/network/topology');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.nodes));
    assert.ok(Array.isArray(data.edges));
    assert.ok(data.nodes.length >= 1);
  });
});

describe('GET /discovery', () => {
  it('returns discovery info', async () => {
    const { status, data } = await api('/discovery');
    assert.equal(status, 200);
    assert.ok(data.self);
    assert.ok(Array.isArray(data.peers));
    assert.ok(Array.isArray(data.allDiscovered));
  });
});

