#!/usr/bin/env node

/**
 * Multi-node launcher for Pando.
 *
 * Starts two Pando nodes on localhost with isolated data directories,
 * waits for them to connect to each other, and verifies ledger sync.
 *
 * Usage:
 *   node scripts/launch-nodes.js              # launch + keep running
 *   node scripts/launch-nodes.js --test       # launch, verify P2P, then exit
 *   node scripts/launch-nodes.js --test-full  # launch, verify P2P + governance, then exit
 */

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'packages', 'node', 'dist', 'cli.js');

const DATA_DIR_1 = join(homedir(), '.pando-node1');
const DATA_DIR_2 = join(homedir(), '.pando-node2');

const P2P_PORT_1 = 5001;
const P2P_PORT_2 = 5002;
const API_PORT_1 = 5100;
const API_PORT_2 = 5200;

const isTest = process.argv.includes('--test') || process.argv.includes('--test-full');
const isFullTest = process.argv.includes('--test-full');
const freshStart = process.argv.includes('--fresh');

// ── helpers ──

function log(msg) {
  console.log(`[launcher] ${msg}`);
}

function logOk(msg) {
  console.log(`  ✓ ${msg}`);
}

function logFail(msg) {
  console.error(`  ✗ ${msg}`);
}

async function fetchJson(url, opts) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function pollUntil(fn, timeoutMs = 30_000, intervalMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

// ── node processes ──

const children = [];

function spawnNode(label, args) {
  log(`Starting ${label}...`);
  const child = spawn('node', [CLI, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });

  child.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.log(`  [${label}] ${line}`);
    }
  });

  child.stderr.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.error(`  [${label}:err] ${line}`);
    }
  });

  child.on('exit', (code) => {
    log(`${label} exited (code ${code})`);
  });

  children.push(child);
  return child;
}

function killAll() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
}

// Cleanup on Ctrl+C or script exit
process.on('SIGINT', () => { log('Caught SIGINT — shutting down...'); killAll(); process.exit(0); });
process.on('SIGTERM', () => { log('Caught SIGTERM — shutting down...'); killAll(); process.exit(0); });
process.on('exit', () => killAll());

// ── main ──

async function main() {
  // Optionally wipe data dirs for a fresh start
  if (freshStart) {
    log('Wiping data directories for fresh start...');
    for (const dir of [DATA_DIR_1, DATA_DIR_2]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }

  // Ensure data directories exist
  mkdirSync(DATA_DIR_1, { recursive: true });
  mkdirSync(DATA_DIR_2, { recursive: true });

  // ── Start Node 1 (no bootstrap — it's the first node) ──
  spawnNode('node1', [
    '--port', String(P2P_PORT_1),
    '--api-port', String(API_PORT_1),
    '--data-dir', DATA_DIR_1,
    '--no-bootstrap',
  ]);

  // Wait for Node 1 to be ready
  log('Waiting for Node 1 API...');
  const status1 = await pollUntil(async () => {
    return await fetchJson(`http://127.0.0.1:${API_PORT_1}/health`);
  }, 30_000);

  if (!status1) {
    logFail('Node 1 failed to start within 30s');
    killAll();
    process.exit(1);
  }
  logOk(`Node 1 ready on API port ${API_PORT_1}`);

  // Read Node 1's peer ID from /status
  const s1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/status`);
  if (!s1 || !s1.peerId) {
    logFail('Could not read Node 1 peer ID');
    killAll();
    process.exit(1);
  }
  const peerId1 = s1.peerId;
  log(`Node 1 Peer ID: ${peerId1}`);

  // Build bootstrap multiaddr for Node 1
  const bootstrapAddr = `/ip4/127.0.0.1/tcp/${P2P_PORT_1}/p2p/${peerId1}`;

  // ── Start Node 2 (bootstraps from Node 1) ──
  // Note: do NOT use --no-bootstrap here — it disables explicit --bootstrap too
  spawnNode('node2', [
    '--port', String(P2P_PORT_2),
    '--api-port', String(API_PORT_2),
    '--data-dir', DATA_DIR_2,
    '--bootstrap', bootstrapAddr,
  ]);

  // Wait for Node 2 to be ready
  log('Waiting for Node 2 API...');
  const status2 = await pollUntil(async () => {
    return await fetchJson(`http://127.0.0.1:${API_PORT_2}/health`);
  }, 30_000);

  if (!status2) {
    logFail('Node 2 failed to start within 30s');
    killAll();
    process.exit(1);
  }
  logOk(`Node 2 ready on API port ${API_PORT_2}`);

  const s2 = await fetchJson(`http://127.0.0.1:${API_PORT_2}/status`);
  const peerId2 = s2?.peerId;
  log(`Node 2 Peer ID: ${peerId2}`);

  // ── Wait for peer discovery ──
  log('Waiting for nodes to discover each other...');
  const peersConnected = await pollUntil(async () => {
    const p1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/peers`);
    const p2 = await fetchJson(`http://127.0.0.1:${API_PORT_2}/peers`);
    const count1 = p1?.peers?.length ?? 0;
    const count2 = p2?.peers?.length ?? 0;
    if (count1 > 0 && count2 > 0) return { p1, p2 };
    return null;
  }, 60_000, 2000);

  if (!peersConnected) {
    logFail('Nodes did not discover each other within 30s');
    killAll();
    process.exit(1);
  }
  logOk('Nodes discovered each other');

  // ── Summary ──
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  Pando Multi-Node Launcher');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Node 1: http://127.0.0.1:${API_PORT_1}/status`);
  console.log(`          Peer ID: ${peerId1}`);
  console.log(`          Data:    ${DATA_DIR_1}`);
  console.log(`  Node 2: http://127.0.0.1:${API_PORT_2}/status`);
  console.log(`          Peer ID: ${peerId2}`);
  console.log(`          Data:    ${DATA_DIR_2}`);
  console.log('═══════════════════════════════════════════════');
  console.log('');

  if (!isTest) {
    log('Nodes running. Press Ctrl+C to stop both.');
    // Keep running forever
    await new Promise(() => {});
  }

  // ─────────────────────────────────────────────
  //  TEST MODE — verify P2P features then exit
  // ─────────────────────────────────────────────

  let passed = 0;
  let failed = 0;

  function check(ok, msg) {
    if (ok) { logOk(msg); passed++; }
    else { logFail(msg); failed++; }
  }

  console.log('');
  log('=== P2P Verification Tests ===');
  console.log('');

  // Test 1: /peers shows each other
  {
    const p1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/peers`);
    const p2 = await fetchJson(`http://127.0.0.1:${API_PORT_2}/peers`);
    const list1 = p1?.peers ?? [];
    const list2 = p2?.peers ?? [];
    const node1SeesNode2 = list1.some(p => p.peerId === peerId2);
    const node2SeesNode1 = list2.some(p => p.peerId === peerId1);
    check(node1SeesNode2, 'Node 1 /peers shows Node 2');
    check(node2SeesNode1, 'Node 2 /peers shows Node 1');
  }

  // Test 2: Transfer Lux from Node 1 → Node 2
  // (amounts must be small — nodes start with ~0.01 Lux from genesis + peer reward)
  {
    const before1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/balance/${peerId1}`);
    const before2on1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/balance/${peerId2}`);
    const bal1Before = before1?.balance ?? 0;
    const bal2on1Before = before2on1?.balance ?? 0;
    log(`Balances before: Node1=${bal1Before}, Node2(on Node1 ledger)=${bal2on1Before}`);

    const txResult = await fetchJson(`http://127.0.0.1:${API_PORT_1}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: peerId2, amount: 0.001 }),
    });
    check(txResult?.success === true, `Transfer 0.001 Lux: Node 1 → Node 2 (tx: ${txResult?.transaction?.id?.slice(0,8) ?? txResult?.error ?? 'none'})`);

    // Wait for GossipSub sync
    await sleep(4000);

    const after1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/balance/${peerId1}`);
    const after2on1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/balance/${peerId2}`);
    const after2on2 = await fetchJson(`http://127.0.0.1:${API_PORT_2}/balance/${peerId2}`);

    check(after1?.balance < bal1Before, `Node 1 balance decreased (${bal1Before} → ${after1?.balance})`);
    check(after2on1?.balance > bal2on1Before, `Node 2 balance on Node 1 ledger increased (${bal2on1Before} → ${after2on1?.balance})`);
    check(after2on2?.balance > 0, `Node 2 balance on Node 2 ledger synced via GossipSub (${after2on2?.balance})`);
  }

  // Test 3: Transfer Lux from Node 2 → Node 1
  {
    const before2 = await fetchJson(`http://127.0.0.1:${API_PORT_2}/balance/${peerId2}`);
    const before1on2 = await fetchJson(`http://127.0.0.1:${API_PORT_2}/balance/${peerId1}`);
    const bal2Before = before2?.balance ?? 0;
    const bal1on2Before = before1on2?.balance ?? 0;
    log(`Balances before: Node2=${bal2Before}, Node1(on Node2 ledger)=${bal1on2Before}`);

    const txResult = await fetchJson(`http://127.0.0.1:${API_PORT_2}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: peerId1, amount: 0.001 }),
    });
    check(txResult?.success === true, `Transfer 0.001 Lux: Node 2 → Node 1 (tx: ${txResult?.transaction?.id?.slice(0,8) ?? txResult?.error ?? 'none'})`);

    await sleep(4000);

    const after2 = await fetchJson(`http://127.0.0.1:${API_PORT_2}/balance/${peerId2}`);
    const after1on2 = await fetchJson(`http://127.0.0.1:${API_PORT_2}/balance/${peerId1}`);
    const after1on1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/balance/${peerId1}`);

    check(after2?.balance < bal2Before, `Node 2 balance decreased (${bal2Before} → ${after2?.balance})`);
    check(after1on2?.balance > bal1on2Before, `Node 1 balance on Node 2 ledger increased (${bal1on2Before} → ${after1on2?.balance})`);
    check(after1on1?.balance > 0, `Node 1 balance on Node 1 ledger synced (${after1on1?.balance})`);
  }

  // ── Full test: Governance ──
  if (isFullTest) {
    console.log('');
    log('=== Governance Sync Tests ===');
    console.log('');

    // Test 4: Create proposal on Node 1, verify on Node 2
    {
      const propResult = await fetchJson(`http://127.0.0.1:${API_PORT_1}/governance/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Test Proposal from Node 1',
          description: 'Automated test — verifying governance GossipSub sync between two local nodes.',
          votingDurationMs: 3_600_000,
        }),
      });
      check(propResult?.success === true, `Created proposal on Node 1 (id: ${propResult?.proposal?.id?.slice(0,8) ?? 'none'})`);
      const proposalId = propResult?.proposal?.id;

      // Wait for GossipSub governance sync
      await sleep(3000);

      // Check Node 2 sees it
      const proposals2 = await fetchJson(`http://127.0.0.1:${API_PORT_2}/governance/proposals`);
      const list2 = proposals2?.proposals ?? (Array.isArray(proposals2) ? proposals2 : []);
      const found = list2.some(p => p.id === proposalId);
      check(found, 'Proposal visible on Node 2 via GossipSub');

      // Test 5: Vote on Node 2, verify on Node 1
      if (proposalId) {
        const voteResult = await fetchJson(`http://127.0.0.1:${API_PORT_2}/governance/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ proposalId, choice: 'approve', reasoning: 'Automated test vote' }),
        });
        check(voteResult?.success === true, 'Voted on proposal from Node 2');

        await sleep(3000);

        // Check Node 1 sees the vote
        const detail1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/governance/proposal/${proposalId}`);
        const votes = detail1?.votes ?? detail1?.proposal?.votes ?? [];
        const voteFound = votes.some(v => v.voter === peerId2);
        check(voteFound, 'Vote from Node 2 visible on Node 1');
      }
    }
  }

  // ── Test: Bootstrap reconnection ──
  console.log('');
  log('=== Bootstrap Reconnection Test ===');
  console.log('');

  {
    // Kill Node 2
    log('Killing Node 2...');
    const node2 = children[1];
    node2.kill('SIGTERM');
    await sleep(3000);

    // Restart Node 2
    log('Restarting Node 2...');
    spawnNode('node2-restart', [
      '--port', String(P2P_PORT_2),
      '--api-port', String(API_PORT_2),
      '--data-dir', DATA_DIR_2,
      '--bootstrap', bootstrapAddr,
    ]);

    // Wait for Node 2 to come back
    const restarted = await pollUntil(async () => {
      return await fetchJson(`http://127.0.0.1:${API_PORT_2}/health`);
    }, 30_000);
    check(!!restarted, 'Node 2 restarted successfully');

    // Wait for reconnection
    const reconnected = await pollUntil(async () => {
      const p1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/peers`);
      const list1 = p1?.peers ?? [];
      return list1.length > 0 ? true : null;
    }, 60_000, 2000);
    check(!!reconnected, 'Node 2 reconnected to Node 1 after restart');
  }

  // ── Test: Ledger catch-up after offline period ──
  console.log('');
  log('=== Ledger Catch-Up Test ===');
  console.log('');

  {
    // Get current balances
    const s2restart = await fetchJson(`http://127.0.0.1:${API_PORT_2}/status`);
    const peerId2r = s2restart?.peerId;

    // Kill Node 2 again
    log('Killing Node 2 for catch-up test...');
    const node2r = children[children.length - 1];
    node2r.kill('SIGTERM');
    await sleep(3000);

    // Make a transfer on Node 1 while Node 2 is down
    const balBefore = await fetchJson(`http://127.0.0.1:${API_PORT_1}/balance/${peerId2r ?? peerId2}`);
    const offlineTransfer = await fetchJson(`http://127.0.0.1:${API_PORT_1}/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: peerId2r ?? peerId2, amount: 0.001 }),
    });
    check(offlineTransfer?.success === true, 'Transfer made while Node 2 offline');
    const balAfterOnNode1 = await fetchJson(`http://127.0.0.1:${API_PORT_1}/balance/${peerId2r ?? peerId2}`);
    log(`Node 2 balance on Node 1 ledger: ${balBefore?.balance} → ${balAfterOnNode1?.balance}`);

    // Restart Node 2
    log('Restarting Node 2 for catch-up...');
    spawnNode('node2-catchup', [
      '--port', String(P2P_PORT_2),
      '--api-port', String(API_PORT_2),
      '--data-dir', DATA_DIR_2,
      '--bootstrap', bootstrapAddr,
    ]);

    await pollUntil(async () => {
      return await fetchJson(`http://127.0.0.1:${API_PORT_2}/health`);
    }, 30_000);

    // Wait for catch-up sync
    await sleep(5000);

    const balCaughtUp = await fetchJson(`http://127.0.0.1:${API_PORT_2}/balance/${peerId2r ?? peerId2}`);
    check(
      balCaughtUp?.balance >= (balAfterOnNode1?.balance ?? 0),
      `Node 2 caught up after restart (balance: ${balCaughtUp?.balance})`
    );
  }

  // ── Results ──
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════');
  console.log('');

  killAll();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  killAll();
  process.exit(1);
});
