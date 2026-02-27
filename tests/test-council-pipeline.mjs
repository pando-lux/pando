/**
 * Phase 103e — E2E Test: Council → ActiveTask → QA Agent → Governance Pipeline
 *
 * Tests:
 * 1. safeGitReset stashes uncommitted changes before reset
 * 2. RequestActor types are exported correctly
 * 3. Council class basic functionality
 * 4. Bridge item creates ActiveTask, runs through QA flow
 * 5. QA verdict parsing
 * 6. Upgrade protocol integration
 * 7. Council API routes (if node running)
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) { console.log(`  \u2713 ${message}`); passed++; }
  else { console.log(`  \u2717 FAIL: ${message}`); failed++; }
}

console.log('=== Phase 103e: Council Pipeline E2E Test ===\n');

// Test 1: safeGitReset
console.log('1. Testing safeGitReset helper...');
try {
  const tmpRepo = mkdtempSync(join(tmpdir(), 'pando-test-git-'));
  execSync('git init', { cwd: tmpRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tmpRepo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpRepo, stdio: 'pipe' });
  writeFileSync(join(tmpRepo, 'file.txt'), 'initial');
  execSync('git add .', { cwd: tmpRepo, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: tmpRepo, stdio: 'pipe' });
  writeFileSync(join(tmpRepo, 'file.txt'), 'updated');
  execSync('git add .', { cwd: tmpRepo, stdio: 'pipe' });
  execSync('git commit -m "update"', { cwd: tmpRepo, stdio: 'pipe' });
  const headSha = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  execSync('git reset --hard HEAD~1', { cwd: tmpRepo, stdio: 'pipe' });
  writeFileSync(join(tmpRepo, 'dirty.txt'), 'uncommitted work');
  execSync('git add .', { cwd: tmpRepo, stdio: 'pipe' });
  const statusBefore = execSync('git status --porcelain', { cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  assert(statusBefore.length > 0, 'Repo has uncommitted changes before safeGitReset');

  const { safeGitReset } = await import('../packages/node/dist/core/upgrade-protocol.js');
  assert(typeof safeGitReset === 'function', 'safeGitReset is exported as a function');
  safeGitReset(tmpRepo, headSha);

  const statusAfter = execSync('git status --porcelain', { cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  assert(statusAfter.length === 0, 'Working directory is clean after safeGitReset');
  const stashList = execSync('git stash list', { cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  assert(stashList.includes('pando-auto-stash'), 'Stash was created with pando-auto-stash prefix');
  const currentSha = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  assert(currentSha === headSha, 'HEAD is at the target commit after reset');
  console.log('');
} catch (err) { console.log(`  \u2717 FAIL: safeGitReset: ${err.message}`); failed++; console.log(''); }

// Test 2: RequestActor types
console.log('2. Testing RequestActor type exports...');
try {
  const dtsPath = join(process.cwd(), 'packages', 'shared', 'dist', 'types.d.ts');
  if (existsSync(dtsPath)) {
    const dtsContent = readFileSync(dtsPath, 'utf-8');
    assert(dtsContent.includes('ActorType'), 'ActorType is exported in shared types');
    assert(dtsContent.includes('RequestActor'), 'RequestActor is exported in shared types');
    assert(dtsContent.includes("'operator'"), 'ActorType includes operator');
    assert(dtsContent.includes("'anonymous'"), 'ActorType includes anonymous');
  } else { console.log('  \u26A0 .d.ts not found'); }
  console.log('');
} catch (err) { console.log(`  \u2717 FAIL: ${err.message}`); failed++; console.log(''); }

// Test 3: Council class
console.log('3. Testing Council class...');
try {
  const { Council } = await import('../packages/node/dist/platform/council.js');
  assert(typeof Council === 'function', 'Council class is importable');

  const testDataDir = mkdtempSync(join(tmpdir(), 'pando-council-test-'));
  const mockNode = {
    getIdentity: () => ({ peerId: 'test-peer-12345' }),
    getCapabilityRegistry: () => ({ getAllProfiles: () => [{ peerId: 'test-peer-12345', capabilities: { compute_cpu: true }, details: { compute_cpu: { claudeCode: true } } }] }),
    getReputationManager: () => ({ getReputation: () => ({ reputationScore: 0.9 }) }),
    getGovernance: () => null, getAgentManager: () => null, getAIBackendRegistry: () => null,
    getApiPort: () => 4000, getNetwork: () => ({ getPeerCount: () => 2 }),
  };

  const council = new Council(mockNode, testDataDir);
  assert(council !== null, 'Council instance created');
  const members = council.selectCouncil();
  assert(members.length > 0, 'Council selected at least one member');
  assert(council.isCouncilMember(), 'isCouncilMember returns true');

  const chatReply = await council.handleMessage('what is the network status?');
  assert(typeof chatReply === 'string' && chatReply.length > 0, 'handleMessage returns a reply');

  const history = council.getChatHistory();
  assert(history.length >= 2, 'Chat history has user + assistant messages');

  const buildReply = await council.handleMessage('fix the upgrade protocol to handle edge cases');
  assert(typeof buildReply === 'string', 'Actionable request gets a reply');

  council.appendMinutes('## Test Entry\n- This is a test\n');
  assert(council.getMinutes().includes('Test Entry'), 'Minutes entry was appended');

  const directive = council.addFounderDirective('Always prioritize security', 'operator-123');
  assert(directive.id.startsWith('dir-'), 'Directive has valid ID');

  const reflection = await council.runDailyReflection();
  assert(reflection !== null, 'Reflection returns a result');
  assert(reflection.type === 'daily', 'Reflection type is daily');

  const tasks = council.getActiveTasks();
  assert(Array.isArray(tasks), 'getActiveTasks returns an array');

  council.stop();
  console.log('');
} catch (err) { console.log(`  \u2717 FAIL: Council test: ${err.message}\n    ${err.stack?.split('\n').slice(0,3).join('\n    ')}`); failed++; console.log(''); }

// Test 4: Bridge item -> ActiveTask -> QA pipeline
console.log('4. Testing bridge item -> ActiveTask -> QA -> governance flow...');
try {
  const { Council } = await import('../packages/node/dist/platform/council.js');
  const testDataDir = mkdtempSync(join(tmpdir(), 'pando-bridge-test-'));

  let proposalCreated = false;
  let createdTitle = '';

  const mockNode = {
    getIdentity: () => ({ peerId: 'test-peer-bridge' }),
    getCapabilityRegistry: () => ({ getAllProfiles: () => [{ peerId: 'test-peer-bridge', capabilities: { compute_cpu: true }, details: { compute_cpu: { claudeCode: true } } }] }),
    getReputationManager: () => ({ getReputation: () => ({ reputationScore: 0.8 }) }),
    getGovernance: () => ({ createProposal: async (title) => { proposalCreated = true; createdTitle = title; return { id: 'gov-test-123', title }; } }),
    getAgentManager: () => null, getAIBackendRegistry: () => null,
    getRegressionSuite: () => ({ runAll: async () => ({ total: 14, passed: 14, failed: 0, skipped: 0, duration: 150, results: [], runAt: Date.now() }) }),
    getApiPort: () => 4000, getNetwork: () => ({ getPeerCount: () => 1 }),
  };

  const council = new Council(mockNode, testDataDir);
  council.selectCouncil();

  const bridgeItem = {
    type: 'task_completed',
    payload: { agentId: 'builder-agent-001', summary: 'Fixed the upgrade protocol edge case', details: 'Updated upgrade-protocol.ts' },
  };

  await council.constructor.prototype.handleBridgeItem.call(council, bridgeItem);

  assert(proposalCreated, 'Governance proposal created after QA fallback');
  assert(createdTitle.includes('Council Fix'), 'Proposal title contains [Council Fix]');

  const minutes = council.getMinutes();
  assert(minutes.includes('Builder Completed'), 'Minutes include builder completion entry');
  assert(minutes.includes('builder-agent-001'), 'Minutes include agent ID');

  const activeTasks = council.getActiveTasks();
  assert(Array.isArray(activeTasks), 'getActiveTasks returns array');
  const doneTask = activeTasks.find(t => t.builderAgentId === 'builder-agent-001');
  assert(doneTask !== undefined, 'ActiveTask created for builder-agent-001');
  assert(doneTask.stage === 'done' || doneTask.stage === 'governance', 'Task reached done/governance stage');

  const failItem = { type: 'task_failed', payload: { agentId: 'builder-agent-002', summary: 'Build failed' } };
  await council.constructor.prototype.handleBridgeItem.call(council, failItem);
  assert(council.getMinutes().includes('Agent Failed'), 'Minutes include agent failure');

  council.stop();
  console.log('');
} catch (err) { console.log(`  \u2717 FAIL: Bridge item: ${err.message}\n    ${err.stack?.split('\n').slice(0,3).join('\n    ')}`); failed++; console.log(''); }

// Test 5: QA verdict parsing
console.log('5. Testing QA verdict parsing...');
try {
  const { Council } = await import('../packages/node/dist/platform/council.js');
  const testDataDir = mkdtempSync(join(tmpdir(), 'pando-verdict-test-'));
  const mockNode = {
    getIdentity: () => ({ peerId: 'test-peer-v' }),
    getCapabilityRegistry: () => ({ getAllProfiles: () => [{ peerId: 'test-peer-v', capabilities: { compute_cpu: true }, details: { compute_cpu: { claudeCode: true } } }] }),
    getReputationManager: () => ({ getReputation: () => ({ reputationScore: 0.8 }) }),
    getGovernance: () => null, getAgentManager: () => null, getAIBackendRegistry: () => null,
    getApiPort: () => 4000, getNetwork: () => ({ getPeerCount: () => 1 }),
  };
  const council = new Council(mockNode, testDataDir);
  const parse = council.constructor.prototype.parseQAVerdict.bind(council);

  assert(parse('PASS: All tests passing').pass === true, 'PASS: verdict parsed as pass');
  assert(parse('FAIL: Build error').pass === false, 'FAIL: verdict parsed as fail');
  assert(parse('The build failed with errors').pass === false, 'Implicit fail from keyword');
  assert(parse('Everything looks good').pass === true, 'Implicit pass when no fail keywords');

  council.stop();
  console.log('');
} catch (err) { console.log(`  \u2717 FAIL: Verdict parsing: ${err.message}`); failed++; console.log(''); }

// Test 6: Upgrade protocol
console.log('6. Testing upgrade protocol with safe reset...');
try {
  const { UpgradeProtocol, safeGitReset } = await import('../packages/node/dist/core/upgrade-protocol.js');
  assert(typeof UpgradeProtocol === 'function', 'UpgradeProtocol class is importable');
  assert(typeof safeGitReset === 'function', 'safeGitReset exported');

  const cleanRepo = mkdtempSync(join(tmpdir(), 'pando-clean-test-'));
  execSync('git init', { cwd: cleanRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: cleanRepo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: cleanRepo, stdio: 'pipe' });
  writeFileSync(join(cleanRepo, 'file.txt'), 'content');
  execSync('git add .', { cwd: cleanRepo, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: cleanRepo, stdio: 'pipe' });
  const sha = execSync('git rev-parse HEAD', { cwd: cleanRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  safeGitReset(cleanRepo, sha);
  assert(execSync('git stash list', { cwd: cleanRepo, encoding: 'utf-8', stdio: 'pipe' }).trim() === '', 'Clean repo: no stash');
  console.log('');
} catch (err) { console.log(`  \u2717 FAIL: Upgrade protocol: ${err.message}`); failed++; console.log(''); }

// Test 7: API routes
console.log('7. Testing council API routes (requires running node)...');
const nodeUrl = process.env.PANDO_NODE_URL || 'http://127.0.0.1:4000';
try {
  const statusRes = await fetch(`${nodeUrl}/v1/status`, { signal: AbortSignal.timeout(3000) });
  if (statusRes.ok) {
    console.log('  Node is running...');
    const councilRes = await fetch(`${nodeUrl}/v1/council`, { signal: AbortSignal.timeout(5000) });
    assert(councilRes.ok, 'GET /council returns 200');
    const minutesRes = await fetch(`${nodeUrl}/v1/council/minutes`, { signal: AbortSignal.timeout(5000) });
    assert(minutesRes.ok, 'GET /council/minutes returns 200');
  } else { console.log('  \u26A0 Node not responding'); }
  console.log('');
} catch (err) {
  if (err.cause?.code === 'ECONNREFUSED' || err.name === 'TimeoutError') { console.log('  \u26A0 Node not running'); }
  else { console.log(`  \u2717 FAIL: ${err.message}`); failed++; }
  console.log('');
}

// Summary
console.log('\u2550'.repeat(47));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('\u2550'.repeat(47));
if (failed > 0) process.exit(1);
