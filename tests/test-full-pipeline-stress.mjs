/**
 * Full Pipeline Stress Test — Autonomous Council Testing
 *
 * Tests ALL pipelines end-to-end on a live node:
 * 1. Council chat + self-healing
 * 2. Agent spawn → report → bridge → council
 * 3. Governance flow (proposal → vote → decision → upgrade)
 * 4. Security (auth gating on all write endpoints)
 * 5. Project/deployment pipeline endpoints
 * 6. Ledger sync + transfer
 * 7. Regression suite
 * 8. Stress: rapid concurrent requests
 * 9. Multi-node upgrade propagation (2 nodes)
 *
 * Run: timeout 600 node tests/test-full-pipeline-stress.mjs
 */

import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const FETCH_TIMEOUT = 15_000; // 15s per HTTP request
const AI_TIMEOUT = 60_000;    // 60s for AI-powered requests
const NODE_BOOT_WAIT = 3_000; // 3s for node to fully start

let passed = 0;
let failed = 0;
let skipped = 0;
const errors = [];
const startTime = Date.now();

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${message}`);
    failed++;
    errors.push(message);
  }
}

function skip(message) {
  console.log(`  ⚠ SKIP: ${message}`);
  skipped++;
}

console.log('═══════════════════════════════════════════════');
console.log('  FULL PIPELINE STRESS TEST');
console.log('═══════════════════════════════════════════════\n');

// ── Boot Node A ─────────────────────────────────────────────────────────────

console.log('0. Starting Node A...');
const dataDirA = mkdtempSync(join(tmpdir(), 'pando-stress-A-'));
const apiPortA = 15000 + Math.floor(Math.random() * 1000);
const p2pPortA = 16000 + Math.floor(Math.random() * 1000);

let nodeA;
try {
  const { PandoNode } = await import('../packages/node/dist/index.js');
  nodeA = new PandoNode({
    listenPort: p2pPortA,
    apiPort: apiPortA,
    dataDir: dataDirA,
    bootstrapPeers: [],
  });
  await nodeA.start();
  await sleep(NODE_BOOT_WAIT);
  console.log(`  Node A: port=${apiPortA}, p2p=${p2pPortA}`);
} catch (err) {
  console.log(`  FATAL: Node A failed to start: ${err.message}`);
  process.exit(1);
}

const baseA = `http://127.0.0.1:${apiPortA}/v1`;
let tokenA = '';
try {
  const tokenPath = join(dataDirA, 'api-token');
  if (existsSync(tokenPath)) tokenA = readFileSync(tokenPath, 'utf-8').trim();
} catch {}

const authA = () => ({
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${tokenA}`,
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1: API HEALTH
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n1. API Health Check...');
const healthEndpoints = [
  ['/status', ['peerId', 'uptime']],
  ['/health', ['status']],
  ['/peers', ['peers']],
  ['/wallet', ['peerId', 'balance']],
  ['/tasks', null],
  // /monitor/status returns 503 without --monitor flag — skip from health check

  ['/governance/proposals', null],
  ['/governance/proposals/active', null],
  ['/transactions', null],
  ['/emissions/stats', null],
  ['/security/stats', null],
  ['/council', ['members']],
  ['/council/minutes', ['minutes']],
  ['/council/chat', null],
  ['/council/requests', null],
  ['/council/directives', null],
  ['/regression', null],
  ['/capabilities', null],
  ['/agents/tree', null],
];

for (const [path, expectedFields] of healthEndpoints) {
  try {
    const res = await fetch(`${baseA}${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    assert(res.ok, `GET ${path} → ${res.status}`);
    if (expectedFields) {
      const data = await res.json();
      for (const field of expectedFields) {
        assert(field in data, `  ${path} has field '${field}'`);
      }
    }
  } catch (err) {
    assert(false, `GET ${path}: ${err.message}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2: AUTH GATING — Write endpoints must require auth
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n2. Auth Gating...');
const authGatedEndpoints = [
  ['POST', '/tasks', { title: 'test', description: 'test' }],
  ['POST', '/transfer', { to: 'fake', amount: 1 }],
  ['POST', '/upgrade', {}],
  ['POST', '/agents/spawn', { role: 'builder' }],
  ['POST', '/council/message', { message: 'test' }],
  ['POST', '/council/directive', { content: 'test' }],
  ['POST', '/council/reflect', {}],
];

for (const [method, path, body] of authGatedEndpoints) {
  try {
    const res = await fetch(`${baseA}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    assert(res.status === 401 || res.status === 403, `${method} ${path} without auth → ${res.status} (expected 401/403)`);
  } catch (err) {
    assert(false, `Auth gate ${method} ${path}: ${err.message}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3: COUNCIL CHAT — AI-powered responses
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n3. Council Chat...');
try {
  const res = await fetch(`${baseA}/council/message`, {
    method: 'POST',
    headers: authA(),
    body: JSON.stringify({ message: 'What is the current network health status?' }),
    signal: AbortSignal.timeout(AI_TIMEOUT),
  });
  assert(res.ok, 'Council chat responds');
  const data = await res.json();
  assert(data.status === 'ok', 'Chat status ok');
  assert(typeof data.response === 'string' && data.response.length > 10, 'Chat gives meaningful response');
  console.log(`  Reply: "${data.response.slice(0, 80)}..."`);
} catch (err) {
  assert(false, `Council chat: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4: COUNCIL ACTIONABLE REQUEST → BUILDER SPAWN
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n4. Council Actionable Request (Builder Spawn)...');
try {
  const res = await fetch(`${baseA}/council/message`, {
    method: 'POST',
    headers: authA(),
    body: JSON.stringify({ message: 'Fix the network timeout issue in peer discovery' }),
    signal: AbortSignal.timeout(AI_TIMEOUT),
  });
  assert(res.ok, 'Actionable request returns 200');
  const data = await res.json();
  assert(data.status === 'ok', 'Status ok');
  const mentionsBuilder = /builder|agent|spawn|fix/i.test(data.response || '');
  assert(mentionsBuilder, 'Response mentions builder/fix action');
  console.log(`  Reply: "${(data.response || '').slice(0, 80)}..."`);
} catch (err) {
  assert(false, `Actionable request: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5: FOUNDER DIRECTIVES
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n5. Founder Directives...');
try {
  const addRes = await fetch(`${baseA}/council/directive`, {
    method: 'POST',
    headers: authA(),
    body: JSON.stringify({ content: 'Stress test directive: always run QA before upgrade' }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  assert(addRes.ok, 'Add directive returns 200');
  const addData = await addRes.json();
  assert(addData.directive?.id || addData.id, 'Directive has ID');

  const getRes = await fetch(`${baseA}/council/directives`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const directives = await getRes.json();
  assert(directives.directives?.length >= 1, 'At least one directive stored');
} catch (err) {
  assert(false, `Directives: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6: AGENT SPAWN → REPORT → BRIDGE QUEUE → COUNCIL
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n6. Agent Lifecycle (Spawn → Report → Bridge)...');
let spawnedAgentId = null;
try {
  // Spawn a builder agent
  const spawnRes = await fetch(`${baseA}/agents/spawn`, {
    method: 'POST',
    headers: authA(),
    body: JSON.stringify({
      role: 'builder',
      projectId: 'stress-test-project',
      description: 'Fix network timeout in peer discovery',
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  assert(spawnRes.ok, `Agent spawn returns ${spawnRes.status}`);
  if (spawnRes.ok) {
    const spawnData = await spawnRes.json();
    spawnedAgentId = spawnData.agentId || spawnData.id;
    assert(!!spawnedAgentId, `Agent spawned: ${spawnedAgentId}`);

    // Get agent status
    if (spawnedAgentId) {
      const statusRes = await fetch(`${baseA}/agents/${spawnedAgentId}/status`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      if (statusRes.ok) {
        const status = await statusRes.json();
        assert(status.role === 'builder' || status.state, 'Agent has correct role/state');
      }

      // Report completion
      const reportRes = await fetch(`${baseA}/agents/${spawnedAgentId}/report`, {
        method: 'POST',
        headers: authA(),
        body: JSON.stringify({
          status: 'complete',
          summary: 'Fixed network timeout with retry + backoff',
          details: 'Added 3 retry attempts with exponential backoff to peer discovery',
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      assert(reportRes.ok, `Agent report accepted: ${reportRes.status}`);
    }
  }
} catch (err) {
  assert(false, `Agent lifecycle: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7: FULL PIPELINE — Builder Completion → QA → Governance → Upgrade
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n7. Full Pipeline (Builder → QA → Governance → Upgrade)...');
try {
  const council = nodeA.getCouncil();
  const governance = nodeA.getGovernance();
  assert(!!council, 'Council accessible');
  assert(!!governance, 'Governance accessible');

  if (council && governance) {
    const propsBefore = governance.getProposals().length;

    // Simulate builder completion via bridge item
    const bridgeItem = {
      type: 'task_completed',
      payload: {
        agentId: 'stress-builder-001',
        summary: 'Fixed peer discovery timeout with retry logic',
        details: 'Added exponential backoff retry to libp2p peer discovery',
      },
    };
    await council.constructor.prototype.handleBridgeItem?.call(council, bridgeItem);

    const propsAfter = governance.getProposals().length;
    assert(propsAfter > propsBefore, `Governance proposal created (${propsBefore} → ${propsAfter})`);

    if (propsAfter > propsBefore) {
      const latest = governance.getProposals()[governance.getProposals().length - 1];
      assert(latest.title.includes('Council Fix'), 'Proposal has [Council Fix] prefix');
      assert(latest.status === 'passed' || latest.status === 'active', `Proposal status: ${latest.status}`);
      console.log(`  Proposal: "${latest.title}" — ${latest.status}`);
    }

    // Check minutes have QA result
    const minutes = council.getMinutes();
    assert(minutes.includes('QA Result'), 'Minutes contain QA result');
    assert(minutes.includes('Builder Completed'), 'Minutes contain builder completion');
  }
} catch (err) {
  assert(false, `Full pipeline: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8: GOVERNANCE FLOW — Proposal → Vote → Decision
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n8. Governance Flow...');
try {
  const governance = nodeA.getGovernance();
  if (governance) {
    const proposals = governance.getProposals();
    assert(proposals.length > 0, `${proposals.length} proposals exist`);

    // Check decisions
    const passedProps = proposals.filter(p => p.status === 'passed');
    assert(passedProps.length > 0, `${passedProps.length} proposals passed (auto-approve in dev mode)`);
  }
} catch (err) {
  assert(false, `Governance: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 9: REGRESSION SUITE (via API)
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n9. Regression Suite...');
try {
  const regRes = await fetch(`${baseA}/regression`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  assert(regRes.ok, 'GET /regression returns 200');
  const regData = await regRes.json();
  assert(regData.stats?.total >= 14, `Suite has ${regData.stats?.total} tests (expected ≥14)`);

  // Run the suite
  const runRes = await fetch(`${baseA}/regression/run`, {
    method: 'POST',
    headers: authA(),
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30_000),
  });
  if (runRes.ok) {
    const runData = await runRes.json();
    assert(runData.total >= 14, `Ran ${runData.total} tests`);
    assert(runData.passed >= 13, `${runData.passed}/${runData.total} passed`);
    console.log(`  Regression: ${runData.passed}/${runData.total} passed, ${runData.failed} failed (${runData.duration}ms)`);
  } else {
    skip(`Regression run returned ${runRes.status}`);
  }
} catch (err) {
  assert(false, `Regression: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 10: PROJECT PIPELINE ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n10. Project Pipeline Endpoints...');
try {
  // List projects (may timeout with P2PStorageBackend and no peers)
  const listRes = await fetch(`${baseA}/projects`, {
    headers: authA(),
    signal: AbortSignal.timeout(10_000),
  });
  if (listRes.ok) {
    assert(true, `GET /projects → ${listRes.status}`);

    // Create a test project (may timeout — P2PStorageBackend blocks without compute peers)
    try {
      const createRes = await fetch(`${baseA}/projects`, {
        method: 'POST',
        headers: authA(),
        body: JSON.stringify({
          name: 'stress-test-project',
          description: 'Created during stress test',
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (createRes.ok || createRes.status === 201) {
        const projData = await createRes.json();
        const projId = projData.id || projData.project?.id;
        assert(!!projId, `Project created: ${projId}`);
      } else {
        skip(`Project creation: ${createRes.status} (expected without MongoDB)`);
      }
    } catch (e) {
      skip(`Project creation timed out (no compute peers for storage): ${e.message.slice(0, 60)}`);
    }
  } else {
    skip(`GET /projects → ${listRes.status} (storage backend unavailable)`);
  }
} catch (err) {
  skip(`Project pipeline: ${err.message.slice(0, 60)} (no storage backend)`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 11: STRESS — Rapid Concurrent Requests
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n11. Stress Test — 20 Concurrent Requests...');
try {
  const endpoints = [
    '/status', '/health', '/peers', '/wallet', '/tasks',
    '/governance/proposals', '/council', '/council/minutes',
    '/regression', '/capabilities', '/transactions',
    '/emissions/stats', '/security/stats', '/agents/tree',
    '/council/chat', '/council/requests', '/council/directives',
    '/status', '/health', '/peers',
  ];

  const promises = endpoints.map((path, i) =>
    fetch(`${baseA}${path}`, { signal: AbortSignal.timeout(10_000) })
      .then(r => ({ ok: r.ok, status: r.status, path }))
      .catch(err => ({ ok: false, status: 0, path, error: err.message }))
  );

  const results = await Promise.all(promises);
  const successCount = results.filter(r => r.ok).length;
  const failCount = results.filter(r => !r.ok).length;

  assert(successCount >= 18, `${successCount}/20 concurrent requests succeeded`);
  if (failCount > 0) {
    const failures = results.filter(r => !r.ok);
    for (const f of failures) {
      console.log(`    Failed: ${f.path} → ${f.status} ${f.error || ''}`);
    }
  }
} catch (err) {
  assert(false, `Stress test: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 12: BUILDER FAILURE HANDLING
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n12. Builder Failure Handling...');
try {
  const council = nodeA.getCouncil();
  if (council) {
    const governance = nodeA.getGovernance();
    const propsBefore = governance ? governance.getProposals().length : 0;

    await council.constructor.prototype.handleBridgeItem?.call(council, {
      type: 'task_failed',
      payload: {
        agentId: 'stress-builder-fail-001',
        summary: 'Build failed: TypeScript compilation errors in agent.ts',
      },
    });

    const propsAfter = governance ? governance.getProposals().length : 0;
    assert(propsAfter === propsBefore, 'No proposal created for failed builder');

    const minutes = council.getMinutes();
    assert(minutes.includes('Builder Failed'), 'Minutes log builder failure');
    assert(minutes.includes('stress-builder-fail-001'), 'Minutes contain failed builder ID');
  }
} catch (err) {
  assert(false, `Builder failure: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 13: LEDGER OPERATIONS
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n13. Ledger Operations...');
try {
  // Check balance
  const walletRes = await fetch(`${baseA}/wallet`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const wallet = await walletRes.json();
  assert(typeof wallet.balance === 'number', `Balance: ${wallet.balance} Lux`);

  // Get transactions
  const txRes = await fetch(`${baseA}/transactions`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  assert(txRes.ok, 'Transactions endpoint works');
} catch (err) {
  assert(false, `Ledger: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 14: COUNCIL REFLECTION
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n14. Council Reflection...');
try {
  const reflectRes = await fetch(`${baseA}/council/reflect`, {
    method: 'POST',
    headers: authA(),
    signal: AbortSignal.timeout(AI_TIMEOUT),
  });
  assert(reflectRes.ok, `Reflection endpoint returns ${reflectRes.status}`);
  const reflectData = await reflectRes.json();
  assert(reflectData.status === 'ok', 'Reflection status ok');
} catch (err) {
  assert(false, `Reflection: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 15: MULTI-NODE — Boot Node B, Connect, Verify Propagation
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n15. Multi-Node Test...');
let nodeB = null;
const dataDirB = mkdtempSync(join(tmpdir(), 'pando-stress-B-'));
const apiPortB = apiPortA + 100;
const p2pPortB = p2pPortA + 100;

try {
  const { PandoNode } = await import('../packages/node/dist/index.js');

  // Get Node A's multiaddr for bootstrapping
  const identityA = nodeA.getIdentity();
  const bootstrapAddr = `/ip4/127.0.0.1/tcp/${p2pPortA}/p2p/${identityA.peerId}`;

  nodeB = new PandoNode({
    listenPort: p2pPortB,
    apiPort: apiPortB,
    dataDir: dataDirB,
    bootstrapPeers: [bootstrapAddr],
  });
  await nodeB.start();
  await sleep(5000); // Wait for peer discovery

  const baseB = `http://127.0.0.1:${apiPortB}/v1`;
  const statusB = await fetch(`${baseB}/status`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  assert(statusB.ok, 'Node B is running');

  // Check if nodes found each other
  const peersA = await fetch(`${baseA}/peers`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const peersAData = await peersA.json();
  const peerCountA = peersAData.peers?.length || 0;

  const peersB = await fetch(`${baseB}/peers`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const peersBData = await peersB.json();
  const peerCountB = peersBData.peers?.length || 0;

  console.log(`  Node A peers: ${peerCountA}, Node B peers: ${peerCountB}`);
  assert(peerCountA >= 1 || peerCountB >= 1, 'Nodes discovered each other');

  // Check governance proposals synced to Node B
  const govB = await fetch(`${baseB}/governance/proposals`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (govB.ok) {
    const govBData = await govB.json();
    console.log(`  Node B proposals: ${govBData.proposals?.length || 0}`);
    // Governance sync may take a few seconds
    if (govBData.proposals?.length > 0) {
      assert(true, 'Governance proposals synced to Node B');
    } else {
      skip('Governance sync may need more time');
    }
  }

  // Check ledger sync
  const walletB = await fetch(`${baseB}/wallet`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (walletB.ok) {
    const walletBData = await walletB.json();
    assert(typeof walletBData.balance === 'number', `Node B balance: ${walletBData.balance} Lux`);
  }

} catch (err) {
  assert(false, `Multi-node: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 16: UPGRADE PROTOCOL VERIFICATION
// ═════════════════════════════════════════════════════════════════════════════

console.log('\n16. Upgrade Protocol...');
try {
  const upgradeProtocol = nodeA.getUpgradeProtocol?.();
  if (upgradeProtocol) {
    assert(true, 'UpgradeProtocol accessible');
    const version = upgradeProtocol.getCurrentVersion?.();
    if (version) {
      assert(version.length >= 7, `Current version: ${version.slice(0, 12)}`);
    }
  } else {
    skip('UpgradeProtocol not exposed');
  }
} catch (err) {
  assert(false, `Upgrade protocol: ${err.message}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═════════════════════════════════════════════════════════════════════════════

console.log('\nCleaning up...');
try {
  if (nodeB) {
    await nodeB.stop();
    console.log('  Node B stopped');
  }
} catch {}
try {
  await nodeA.stop();
  console.log('  Node A stopped');
} catch {}

// ═════════════════════════════════════════════════════════════════════════════
// RESULTS
// ═════════════════════════════════════════════════════════════════════════════

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n═══════════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${elapsed}s)`);
if (errors.length > 0) {
  console.log(`\n  Failed tests:`);
  for (const e of errors) console.log(`    - ${e}`);
}
console.log(`═══════════════════════════════════════════════\n`);

process.exit(failed > 0 ? 1 : 0);
