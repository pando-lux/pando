/**
 * Phase 103 — E2E Test: Council → Governance → Upgrade Pipeline
 *
 * Tests:
 * 1. safeGitReset stashes uncommitted changes before reset
 * 2. Council chat handles messages and detects actionable requests
 * 3. Council creates governance proposals from builder completions
 * 4. Council routes exist and respond correctly
 * 5. RequestActor types are exported correctly
 * 6. Full pipeline: council message → builder spawn attempt → governance proposal
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

console.log('=== Phase 103: Council Pipeline E2E Test ===\n');

// ── Test 1: safeGitReset ────────────────────────────────────────────────────

console.log('1. Testing safeGitReset helper...');

try {
  // Create a temp git repo
  const tmpRepo = mkdtempSync(join(tmpdir(), 'pando-test-git-'));
  execSync('git init', { cwd: tmpRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tmpRepo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpRepo, stdio: 'pipe' });

  // Create initial commit
  writeFileSync(join(tmpRepo, 'file.txt'), 'initial');
  execSync('git add .', { cwd: tmpRepo, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: tmpRepo, stdio: 'pipe' });

  // Create a second commit to serve as "origin/master"
  writeFileSync(join(tmpRepo, 'file.txt'), 'updated');
  execSync('git add .', { cwd: tmpRepo, stdio: 'pipe' });
  execSync('git commit -m "update"', { cwd: tmpRepo, stdio: 'pipe' });
  const headSha = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();

  // Go back one commit (simulating being behind)
  execSync('git reset --hard HEAD~1', { cwd: tmpRepo, stdio: 'pipe' });

  // Make uncommitted changes
  writeFileSync(join(tmpRepo, 'dirty.txt'), 'uncommitted work');
  execSync('git add .', { cwd: tmpRepo, stdio: 'pipe' });

  // Verify dirty state
  const statusBefore = execSync('git status --porcelain', { cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  assert(statusBefore.length > 0, 'Repo has uncommitted changes before safeGitReset');

  // Import and call safeGitReset
  const { safeGitReset } = await import('../packages/node/dist/core/upgrade-protocol.js');
  assert(typeof safeGitReset === 'function', 'safeGitReset is exported as a function');

  safeGitReset(tmpRepo, headSha);

  // Verify clean state
  const statusAfter = execSync('git status --porcelain', { cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  assert(statusAfter.length === 0, 'Working directory is clean after safeGitReset');

  // Verify stash exists
  const stashList = execSync('git stash list', { cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  assert(stashList.includes('pando-auto-stash'), 'Stash was created with pando-auto-stash prefix');

  // Verify we're at the target commit
  const currentSha = execSync('git rev-parse HEAD', { cwd: tmpRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  assert(currentSha === headSha, 'HEAD is at the target commit after reset');

  console.log('');
} catch (err) {
  console.log(`  ✗ FAIL: safeGitReset test threw: ${err.message}`);
  failed++;
  console.log('');
}

// ── Test 2: RequestActor types ──────────────────────────────────────────────

console.log('2. Testing RequestActor type exports...');

try {
  // Types aren't available at runtime in JS, but we can check they're in the shared dist
  const sharedPath = join(process.cwd(), 'packages', 'shared', 'dist', 'types.js');
  if (existsSync(sharedPath)) {
    const sharedContent = readFileSync(sharedPath, 'utf-8');
    // Type-only exports won't appear in JS output, but we can verify the .d.ts
    const dtsPath = join(process.cwd(), 'packages', 'shared', 'dist', 'types.d.ts');
    if (existsSync(dtsPath)) {
      const dtsContent = readFileSync(dtsPath, 'utf-8');
      assert(dtsContent.includes('ActorType'), 'ActorType is exported in shared types');
      assert(dtsContent.includes('RequestActor'), 'RequestActor is exported in shared types');
      assert(dtsContent.includes("'operator'"), 'ActorType includes operator');
      assert(dtsContent.includes("'anonymous'"), 'ActorType includes anonymous');
    } else {
      console.log('  ⚠ .d.ts not found — skipping type export check');
    }
  }
  console.log('');
} catch (err) {
  console.log(`  ✗ FAIL: Type export test threw: ${err.message}`);
  failed++;
  console.log('');
}

// ── Test 3: Council Class ───────────────────────────────────────────────────

console.log('3. Testing Council class...');

try {
  const { Council } = await import('../packages/node/dist/platform/council.js');
  assert(typeof Council === 'function', 'Council class is importable');

  // Create a mock node
  const testDataDir = mkdtempSync(join(tmpdir(), 'pando-council-test-'));
  const mockNode = {
    getIdentity: () => ({ peerId: 'test-peer-12345' }),
    getCapabilityRegistry: () => ({
      getAllProfiles: () => [{
        peerId: 'test-peer-12345',
        capabilities: { compute_cpu: true },
        details: { compute_cpu: { claudeCode: true } },
      }],
    }),
    getReputationManager: () => ({
      getReputation: () => ({ reputationScore: 0.9 }),
    }),
    getGovernance: () => null,
    getAgentManager: () => null,
    getAIBackendRegistry: () => null,
    getApiPort: () => 4000,
    getNetwork: () => ({ getPeerCount: () => 2 }),
  };

  const council = new Council(mockNode, testDataDir);
  assert(council !== null, 'Council instance created successfully');

  // Test council selection
  const members = council.selectCouncil();
  assert(members.length > 0, 'Council selected at least one member');
  assert(members[0].peerId === 'test-peer-12345', 'This node is on the council');
  assert(council.isCouncilMember(), 'isCouncilMember returns true');

  // Test council state
  const state = council.getCouncil();
  assert(state.thisNodeOnCouncil === true, 'getCouncil shows node on council');
  assert(state.members.length === 1, 'Council has 1 member');

  // Test chat (no AI backend — falls back to keyword detection)
  const chatReply = await council.handleMessage('what is the network status?');
  assert(typeof chatReply === 'string' && chatReply.length > 0, 'handleMessage returns a reply');
  assert(chatReply.includes('peer') || chatReply.includes('Council') || chatReply.includes('manage'), 'Reply is relevant');

  // Test chat history
  const history = council.getChatHistory();
  assert(history.length >= 2, 'Chat history has user + assistant messages');
  assert(history[0].role === 'user', 'First message is from user');
  assert(history[1].role === 'assistant', 'Second message is from assistant');

  // Test actionable request detection (without AI — should detect keywords)
  const buildReply = await council.handleMessage('fix the upgrade protocol to handle edge cases');
  assert(typeof buildReply === 'string', 'Actionable request gets a reply');
  // Should mention spawning a builder (keyword match: "fix")
  assert(buildReply.includes('spawn') || buildReply.includes('builder') || buildReply.includes('Builder'), 'Reply mentions builder for actionable fix request');

  // Test minutes
  council.appendMinutes('## Test Entry\n- This is a test\n');
  const minutes = council.getMinutes();
  assert(minutes.includes('Test Entry'), 'Minutes entry was appended');

  // Test founder directives
  const directive = council.addFounderDirective('Always prioritize security', 'operator-123');
  assert(directive.id.startsWith('dir-'), 'Directive has valid ID');
  const directives = council.getFounderDirectives();
  assert(directives.length === 1, 'One directive stored');
  assert(directives[0].content === 'Always prioritize security', 'Directive content matches');

  // Test request log
  const reqLog = council.getRequestLog();
  assert(reqLog.length >= 2, 'Request log has entries from chat messages');

  // Test health alerts
  council.handleHealthAlert('High memory usage detected');
  // The alert should be available for next reflection

  // Test daily reflection (stub mode — no AI backend)
  const reflection = await council.runDailyReflection();
  assert(reflection !== null, 'Reflection returns a result');
  assert(reflection.type === 'daily', 'Reflection type is daily');
  assert(typeof reflection.summary === 'string', 'Reflection has summary');
  assert(typeof reflection.minutesEntry === 'string', 'Reflection has minutes entry');

  council.stop();
  console.log('');
} catch (err) {
  console.log(`  ✗ FAIL: Council test threw: ${err.message}`);
  console.log(`    Stack: ${err.stack?.split('\n').slice(0, 3).join('\n    ')}`);
  failed++;
  console.log('');
}

// ── Test 4: Council Bridge Item Handling (simulated) ────────────────────────

console.log('4. Testing council bridge item → governance proposal flow...');

try {
  const { Council } = await import('../packages/node/dist/platform/council.js');
  const testDataDir = mkdtempSync(join(tmpdir(), 'pando-bridge-test-'));

  let proposalCreated = false;
  let createdTitle = '';

  const mockNode = {
    getIdentity: () => ({ peerId: 'test-peer-bridge' }),
    getCapabilityRegistry: () => ({
      getAllProfiles: () => [{
        peerId: 'test-peer-bridge',
        capabilities: { compute_cpu: true },
        details: { compute_cpu: { claudeCode: true } },
      }],
    }),
    getReputationManager: () => ({
      getReputation: () => ({ reputationScore: 0.8 }),
    }),
    getGovernance: () => ({
      createProposal: async (title) => {
        proposalCreated = true;
        createdTitle = title;
        return { id: 'gov-test-123', title };
      },
    }),
    getAgentManager: () => null,
    getAIBackendRegistry: () => null,
    getApiPort: () => 4000,
    getNetwork: () => ({ getPeerCount: () => 1 }),
  };

  const council = new Council(mockNode, testDataDir);
  council.selectCouncil();

  // Simulate a bridge item for builder completion
  // We call the private method via the class directly (it's still accessible in JS)
  const bridgeItem = {
    type: 'task_completed',
    payload: {
      agentId: 'builder-agent-001',
      summary: 'Fixed the upgrade protocol edge case',
      details: 'Updated packages/node/src/core/upgrade-protocol.ts to handle disconnection during git fetch',
    },
  };

  // Access private handleBridgeItem via prototype
  await council.constructor.prototype.handleBridgeItem.call(council, bridgeItem);

  assert(proposalCreated, 'Governance proposal was created from bridge item');
  assert(createdTitle.includes('Council Fix'), 'Proposal title contains [Council Fix]');
  assert(createdTitle.includes('upgrade protocol'), 'Proposal title contains task summary');

  // Check minutes were updated
  const minutes = council.getMinutes();
  assert(minutes.includes('Builder Completed'), 'Minutes include builder completion entry');
  assert(minutes.includes('builder-agent-001'), 'Minutes include agent ID');

  // Test failure handling
  const failItem = {
    type: 'task_failed',
    payload: {
      agentId: 'builder-agent-002',
      summary: 'Build failed: TypeScript errors',
    },
  };

  await council.constructor.prototype.handleBridgeItem.call(council, failItem);
  const minutesAfterFail = council.getMinutes();
  assert(minutesAfterFail.includes('Builder Failed'), 'Minutes include builder failure entry');

  council.stop();
  console.log('');
} catch (err) {
  console.log(`  ✗ FAIL: Bridge item test threw: ${err.message}`);
  console.log(`    Stack: ${err.stack?.split('\n').slice(0, 3).join('\n    ')}`);
  failed++;
  console.log('');
}

// ── Test 5: Full Node API Test (if node is running) ─────────────────────────

console.log('5. Testing council API routes (requires running node)...');

const nodeUrl = process.env.PANDO_NODE_URL || 'http://127.0.0.1:4000';

try {
  // Check if node is running
  const statusRes = await fetch(`${nodeUrl}/v1/status`, { signal: AbortSignal.timeout(3000) });
  if (statusRes.ok) {
    console.log('  Node is running — testing API routes...');

    // GET /council
    const councilRes = await fetch(`${nodeUrl}/v1/council`, { signal: AbortSignal.timeout(5000) });
    assert(councilRes.ok, 'GET /council returns 200');
    const councilData = await councilRes.json();
    assert(Array.isArray(councilData.members), 'Council response has members array');

    // GET /council/minutes
    const minutesRes = await fetch(`${nodeUrl}/v1/council/minutes`, { signal: AbortSignal.timeout(5000) });
    assert(minutesRes.ok, 'GET /council/minutes returns 200');
    const minutesData = await minutesRes.json();
    assert(typeof minutesData.minutes === 'string', 'Minutes response has text');

    // GET /council/chat
    const chatRes = await fetch(`${nodeUrl}/v1/council/chat`, { signal: AbortSignal.timeout(5000) });
    assert(chatRes.ok, 'GET /council/chat returns 200');

    // GET /council/requests
    const reqRes = await fetch(`${nodeUrl}/v1/council/requests`, { signal: AbortSignal.timeout(5000) });
    assert(reqRes.ok, 'GET /council/requests returns 200');

    // GET /council/directives
    const dirRes = await fetch(`${nodeUrl}/v1/council/directives`, { signal: AbortSignal.timeout(5000) });
    assert(dirRes.ok, 'GET /council/directives returns 200');

    // POST /council/message (should work — council routes bypass auth)
    const msgRes = await fetch(`${nodeUrl}/v1/council/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'what is the network status?' }),
      signal: AbortSignal.timeout(15000),
    });
    // May get 401 if identity middleware requires auth for POST
    if (msgRes.ok) {
      const msgData = await msgRes.json();
      assert(msgData.status === 'ok', 'POST /council/message returns ok status');
      assert(typeof msgData.response === 'string', 'Council chat response is a string');
      console.log(`  Council reply: "${msgData.response.slice(0, 80)}..."`);
    } else {
      // 401 is expected if anonymous POST is blocked
      assert(msgRes.status === 401, `POST /council/message returns 401 for unauthenticated (got ${msgRes.status})`);
    }

    // POST /council/message with operator auth
    const apiTokenPath = join(process.env.HOME || process.env.USERPROFILE || '', '.pando', 'api-token');
    if (existsSync(apiTokenPath)) {
      const apiToken = readFileSync(apiTokenPath, 'utf-8').trim();
      const authMsgRes = await fetch(`${nodeUrl}/v1/council/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ message: 'show council members' }),
        signal: AbortSignal.timeout(15000),
      });
      assert(authMsgRes.ok, 'POST /council/message with auth returns 200');
      if (authMsgRes.ok) {
        const authMsgData = await authMsgRes.json();
        assert(authMsgData.status === 'ok', 'Authenticated council message returns ok');
        console.log(`  Auth reply: "${authMsgData.response?.slice(0, 80)}..."`);
      }

      // POST /council/directive
      const dirAddRes = await fetch(`${nodeUrl}/v1/council/directive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ content: 'Test directive from E2E test' }),
        signal: AbortSignal.timeout(5000),
      });
      assert(dirAddRes.ok, 'POST /council/directive with operator auth returns 200');

      // POST /council/reflect
      const reflectRes = await fetch(`${nodeUrl}/v1/council/reflect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiToken}`,
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30000),
      });
      assert(reflectRes.ok, 'POST /council/reflect with operator auth returns 200');
      if (reflectRes.ok) {
        const reflectData = await reflectRes.json();
        assert(reflectData.status === 'ok', 'Reflection returns ok status');
        console.log(`  Reflection: ${reflectData.result?.summary?.slice(0, 80) || '(null result — node may not be council member)'}`);
      }
    } else {
      console.log('  ⚠ No api-token found — skipping authenticated route tests');
    }
  } else {
    console.log('  ⚠ Node not responding — skipping API tests');
  }
  console.log('');
} catch (err) {
  if (err.cause?.code === 'ECONNREFUSED' || err.name === 'TimeoutError' || err.message?.includes('fetch failed')) {
    console.log('  ⚠ Node not running — skipping API tests');
  } else {
    console.log(`  ✗ FAIL: API test threw: ${err.message}`);
    failed++;
  }
  console.log('');
}

// ── Test 6: Upgrade Protocol Integration ────────────────────────────────────

console.log('6. Testing upgrade protocol with safe reset...');

try {
  const { UpgradeProtocol, safeGitReset } = await import('../packages/node/dist/core/upgrade-protocol.js');
  assert(typeof UpgradeProtocol === 'function', 'UpgradeProtocol class is importable');
  assert(typeof safeGitReset === 'function', 'safeGitReset is exported alongside UpgradeProtocol');

  // Verify it handles clean repos (no stash needed)
  const cleanRepo = mkdtempSync(join(tmpdir(), 'pando-clean-test-'));
  execSync('git init', { cwd: cleanRepo, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: cleanRepo, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: cleanRepo, stdio: 'pipe' });
  writeFileSync(join(cleanRepo, 'file.txt'), 'content');
  execSync('git add .', { cwd: cleanRepo, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: cleanRepo, stdio: 'pipe' });

  const sha = execSync('git rev-parse HEAD', { cwd: cleanRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();

  // safeGitReset on clean repo — should not stash, should not error
  safeGitReset(cleanRepo, sha);
  const stashClean = execSync('git stash list', { cwd: cleanRepo, encoding: 'utf-8', stdio: 'pipe' }).trim();
  assert(stashClean === '', 'Clean repo: no stash created');
  assert(execSync('git rev-parse HEAD', { cwd: cleanRepo, encoding: 'utf-8', stdio: 'pipe' }).trim() === sha, 'Clean repo: still at same commit');

  console.log('');
} catch (err) {
  console.log(`  ✗ FAIL: Upgrade protocol test threw: ${err.message}`);
  failed++;
  console.log('');
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════');

if (failed > 0) {
  process.exit(1);
}
