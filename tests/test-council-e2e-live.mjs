/**
 * Phase 103e — LIVE E2E Test: Full Council Pipeline
 *
 * Starts a REAL PandoNode and exercises:
 * 1. Node boots with council system
 * 2. Council chat responds to messages
 * 3. Actionable requests trigger builder spawn
 * 4. Builder completion -> ActiveTask -> QA -> governance
 * 5. ActiveTask lifecycle tracking
 *
 * Run: node tests/test-council-e2e-live.mjs
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, message) {
  if (condition) { console.log(`  \u2713 ${message}`); passed++; }
  else { console.log(`  \u2717 FAIL: ${message}`); failed++; errors.push(message); }
}

console.log('=== Phase 103e: LIVE E2E Council Pipeline Test ===\n');
console.log('0. Starting PandoNode...');

const testDataDir = mkdtempSync(join(tmpdir(), 'pando-e2e-'));
const apiPort = 14000 + Math.floor(Math.random() * 1000);

let node;
try {
  const { PandoNode } = await import('../packages/node/dist/index.js');
  node = new PandoNode({ listenPort: 0, apiPort, dataDir: testDataDir, bootstrapPeers: [] });
  await node.start();
  console.log(`  Node started on API port ${apiPort}`);
  await sleep(2000);
} catch (err) {
  console.log(`  \u2717 FATAL: ${err.message}`);
  process.exit(1);
}

const baseUrl = `http://127.0.0.1:${apiPort}/v1`;
let apiToken = '';
try {
  const tokenPath = join(testDataDir, 'api-token');
  if (existsSync(tokenPath)) { apiToken = readFileSync(tokenPath, 'utf-8').trim(); console.log(`  API token: ${apiToken.slice(0,8)}...`); }
} catch {}

function authHeaders() { return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiToken}` }; }

// Test 1: Node health
console.log('\n1. Testing node health...');
try {
  const res = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(5000) });
  assert(res.ok, 'GET /status returns 200');
  const data = await res.json();
  assert(data.peerId || data.identity, 'Status response has peer identity');
} catch (err) { assert(false, `Node health: ${err.message}`); }

// Test 2: Council system
console.log('\n2. Testing council system...');
try {
  const res = await fetch(`${baseUrl}/council`, { signal: AbortSignal.timeout(5000) });
  assert(res.ok, 'GET /council returns 200');
  const data = await res.json();
  assert(Array.isArray(data.members), 'Council has members array');
  assert(typeof data.selectedAt === 'number', 'Council has selectedAt');
  console.log(`  Council members: ${data.members.length}, on council: ${data.thisNodeOnCouncil}`);
} catch (err) { assert(false, `Council: ${err.message}`); }

// Test 3: Council minutes
console.log('\n3. Testing council minutes...');
try {
  const res = await fetch(`${baseUrl}/council/minutes`, { signal: AbortSignal.timeout(5000) });
  assert(res.ok, 'GET /council/minutes returns 200');
} catch (err) { assert(false, `Minutes: ${err.message}`); }

// Test 4: Council chat
console.log('\n4. Testing council chat...');
try {
  const unauthRes = await fetch(`${baseUrl}/council/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'test' }), signal: AbortSignal.timeout(10000) });
  assert(unauthRes.status === 401, 'Unauth POST returns 401');

  const res = await fetch(`${baseUrl}/council/message`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ message: 'What is the network status?' }), signal: AbortSignal.timeout(60000) });
  assert(res.ok, 'Auth POST /council/message returns 200');
  const data = await res.json();
  assert(data.status === 'ok', 'Council message ok');
  assert(typeof data.response === 'string' && data.response.length > 0, 'Non-empty response');
  console.log(`  Reply: "${data.response.slice(0,100)}"`);
} catch (err) { assert(false, `Chat: ${err.message}`); }

// Test 5: Actionable request
console.log('\n5. Testing actionable request...');
try {
  const res = await fetch(`${baseUrl}/council/message`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ message: 'Fix the upgrade protocol' }), signal: AbortSignal.timeout(15000) });
  assert(res.ok, 'Actionable message returns 200');
  const data = await res.json();
  const reply = data.response.toLowerCase();
  assert(reply.includes('spawn') || reply.includes('builder') || reply.includes('agent'), 'Mentions builder');
} catch (err) { assert(false, `Actionable: ${err.message}`); }

// Test 6: Founder directives
console.log('\n6. Testing founder directives...');
try {
  const addRes = await fetch(`${baseUrl}/council/directive`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ content: 'Prioritize stability' }), signal: AbortSignal.timeout(5000) });
  assert(addRes.ok, 'POST /council/directive returns 200');
  const listRes = await fetch(`${baseUrl}/council/directives`, { signal: AbortSignal.timeout(5000) });
  assert(listRes.ok, 'GET /council/directives returns 200');
} catch (err) { assert(false, `Directives: ${err.message}`); }

// Test 7: Reflection
console.log('\n7. Testing reflection...');
try {
  const res = await fetch(`${baseUrl}/council/reflect`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({}), signal: AbortSignal.timeout(30000) });
  assert(res.ok, 'POST /council/reflect returns 200');
} catch (err) { assert(false, `Reflection: ${err.message}`); }

// Test 8: Request log
console.log('\n8. Testing request log...');
try {
  const res = await fetch(`${baseUrl}/council/requests`, { signal: AbortSignal.timeout(5000) });
  assert(res.ok, 'GET /council/requests returns 200');
  const data = await res.json();
  assert(Array.isArray(data.requests) && data.requests.length >= 2, 'At least 2 requests logged');
} catch (err) { assert(false, `Request log: ${err.message}`); }

// Test 9: Full pipeline
console.log('\n9. Testing full pipeline: builder -> ActiveTask -> QA -> governance...');
try {
  const council = node.getCouncil();
  assert(council !== null, 'Council accessible from node');
  if (council) {
    const governance = node.getGovernance();
    const before = governance ? governance.getProposals().length : 0;

    const bridgeItem = { type: 'task_completed', payload: { agentId: 'builder-e2e-001', summary: 'Fixed upgrade protocol', details: 'Added retry logic' } };
    await council.constructor.prototype.handleBridgeItem?.call(council, bridgeItem);

    const activeTasks = council.getActiveTasks();
    assert(Array.isArray(activeTasks), 'getActiveTasks returns array');
    const task = activeTasks.find(t => t.builderAgentId === 'builder-e2e-001');
    assert(task !== undefined, 'ActiveTask created');
    if (task) {
      assert(['done', 'governance', 'qa'].includes(task.stage), `Task progressed (stage: ${task.stage})`);
      console.log(`  Task ${task.taskId}: stage=${task.stage}`);
    }

    if (governance) {
      const after = governance.getProposals().length;
      assert(after > before, 'Governance proposal created');
    }

    assert(council.getMinutes().includes('Builder Completed'), 'Minutes have builder completion');
  }
} catch (err) { assert(false, `Pipeline: ${err.message}`); }

// Test 10: Identity middleware
console.log('\n10. Testing identity middleware...');
try {
  assert((await fetch(`${baseUrl}/council/chat`, { signal: AbortSignal.timeout(5000) })).ok, 'Anonymous GET works');
  assert((await fetch(`${baseUrl}/council/message`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ message: 'identity test' }), signal: AbortSignal.timeout(10000) })).ok, 'Operator POST works');
} catch (err) { assert(false, `Identity: ${err.message}`); }

// Cleanup
console.log('\nCleaning up...');
try { await node.stop(); console.log('  Node stopped.'); } catch (err) { console.log(`  Warning: ${err.message}`); }

// Summary
console.log('\n' + '\u2550'.repeat(47));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (errors.length > 0) { console.log('\nFailed:'); errors.forEach(e => console.log(`  - ${e}`)); }
console.log('\u2550'.repeat(47));
if (failed > 0) process.exit(1);
