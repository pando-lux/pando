/**
 * @pando/tests Self-Test
 *
 * Exercises every non-browser API of the testing framework:
 * - Database CRUD (scenarios, runs, step_results, findings, stats)
 * - Config loader (init, load, save)
 * - Playbook loader (load, validate, resolve variables)
 * - PandoTester class (scenarios, history, findings, dashboard)
 *
 * Run: npx tsx packages/tests/tests/self-test.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { PandoTester } from '../src/index';
import { TestDatabase } from '../src/database';
import { initProject, loadConfig, saveConfig, resolveVariables } from '../src/config';
import { loadPlaybook, loadPlaybooksFromDir, validatePlaybook, resolvePlaybookVariables } from '../src/playbooks/loader';
import type { Playbook, FindingRecord } from '../src/types';

// ── Test helpers ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  FAIL: ${message}`);
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

// ── Setup ─────────────────────────────────────────────────────────

const tmpDir = path.join(os.tmpdir(), `pando-tests-self-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

// ═══════════════════════════════════════════════════════════════════
// 1. Config System
// ═══════════════════════════════════════════════════════════════════

section('1. Config System');

// initProject creates .pando-tests/ directory structure
initProject(tmpDir, { project: 'self-test', gatewayUrl: 'https://example.com', apiUrl: 'http://localhost:4100' });
assert(fs.existsSync(path.join(tmpDir, '.pando-tests')), '.pando-tests/ directory created');
assert(fs.existsSync(path.join(tmpDir, '.pando-tests', 'config.json')), 'config.json created');
assert(fs.existsSync(path.join(tmpDir, '.pando-tests', 'screenshots')), 'screenshots/ directory created');
assert(fs.existsSync(path.join(tmpDir, '.pando-tests', 'playbooks')), 'playbooks/ directory created');

// loadConfig reads back what we wrote
const config = loadConfig(tmpDir);
assert(config.project === 'self-test', 'config.project loaded correctly');
assert(config.gatewayUrl === 'https://example.com', 'config.gatewayUrl loaded correctly');

// saveConfig updates config
saveConfig(tmpDir, { ...config, apiUrl: 'http://localhost:9999' });
const config2 = loadConfig(tmpDir);
assert(config2.apiUrl === 'http://localhost:9999', 'saveConfig updates config correctly');

// resolveVariables replaces template vars (takes ProjectConfig)
const resolved = resolveVariables('Visit {{HUB_URL}}/status for {{PROJECT}}', {
  project: 'self-test',
  rootDir: tmpDir,
  gatewayUrl: 'https://example.com',
  apiUrl: 'http://localhost:4100',
});
assert(resolved === 'Visit https://example.com/status for self-test', 'resolveVariables replaces {{VAR}}');

// ═══════════════════════════════════════════════════════════════════
// 2. Database Layer
// ═══════════════════════════════════════════════════════════════════

section('2. Database Layer');

const dbPath = path.join(tmpDir, '.pando-tests', 'results.db');
const db = new TestDatabase(dbPath);

// -- Scenarios --
db.insertScenario({
  id: 'sc-1',
  project: 'self-test',
  name: 'test-scenario',
  description: 'A test scenario',
  mode: 'both',
  steps: JSON.stringify([{ action: 'navigate', target: '/test' }]),
  tags: 'smoke,core',
});
const scenario = db.getScenario('sc-1');
assert(scenario !== undefined, 'insertScenario + getScenario works');
assert(scenario?.name === 'test-scenario', 'scenario name correct');

const scenarios = db.listScenarios('self-test');
assert(scenarios.length === 1, 'listScenarios returns 1 scenario');

db.updateScenario('sc-1', { description: 'Updated description' });
const updated = db.getScenario('sc-1');
assert(updated?.description === 'Updated description', 'updateScenario works');

// -- Runs --
const now = new Date().toISOString();
db.insertRun({
  id: 'run-1',
  scenario_id: 'sc-1',
  scenario_name: 'test-scenario',
  mode: 'scripted',
  status: 'running',
  agent_id: null,
  total_steps: 5,
  passed_steps: 0,
  failed_steps: 0,
  duration_ms: 0,
  summary: '',
  error: '',
  started_at: now,
  finished_at: '',
});
const run = db.getRun('run-1');
assert(run !== undefined, 'insertRun + getRun works');
assert(run?.status === 'running', 'run status is running');

db.updateRun('run-1', { status: 'passed', passed_steps: 5, duration_ms: 1234, finished_at: now });
const updatedRun = db.getRun('run-1');
assert(updatedRun?.status === 'passed', 'updateRun works');
assert(updatedRun?.duration_ms === 1234, 'run duration recorded');

const runs = db.listRuns({ limit: 10 });
assert(runs.length === 1, 'listRuns returns 1 run');

// -- Step Results --
db.insertStepResult({
  id: 'sr-1',
  run_id: 'run-1',
  step_index: 0,
  action: 'navigate',
  target: '/test',
  status: 'passed',
  expected: 'page loads',
  actual: 'page loaded in 200ms',
  screenshot_path: null,
  notes: null,
  duration_ms: 200,
});
const steps = db.getStepResults('run-1');
assert(steps.length === 1, 'insertStepResult + getStepResults works');
assert(steps[0].status === 'passed', 'step result status correct');

// -- Findings --
db.insertFinding({
  id: 'f-1',
  run_id: 'run-1',
  step_index: 0,
  type: 'bug',
  severity: 'high',
  title: 'Test finding',
  description: 'Something is broken',
  screenshot_path: null,
  status: 'open',
  resolved_at: null,
  resolution: null,
  created_at: now,
});
const findings = db.listFindings({ status: 'open' });
assert(findings.length === 1, 'insertFinding + listFindings works');
assert(findings[0].title === 'Test finding', 'finding title correct');

db.acknowledgeFinding('f-1');
const acked = db.listFindings({ status: 'acknowledged' });
assert(acked.length === 1, 'acknowledgeFinding works');

db.resolveFinding('f-1', 'Fixed in commit abc123');
const resolved2 = db.listFindings({ status: 'resolved' });
assert(resolved2.length === 1, 'resolveFinding works');
assert(resolved2[0].resolution === 'Fixed in commit abc123', 'resolution text recorded');

// -- Stats --
db.upsertDayStats({
  id: 'stat-1',
  project: 'self-test',
  date: '2026-03-06',
  scripted_runs: 1,
  scripted_passed: 1,
  scripted_failed: 0,
  live_runs: 0,
  live_passed: 0,
  live_failed: 0,
  findings_opened: 1,
  findings_resolved: 1,
  avg_duration_ms: 1234,
});
const stats = db.getStats('self-test', '2026-03-01', '2026-03-07');
assert(stats.length === 1, 'upsertDayStats + getStats works');

const trend = db.getTrend('self-test', 14);
assert(Array.isArray(trend), 'getTrend returns array');

db.close();

// ═══════════════════════════════════════════════════════════════════
// 3. Playbook Loader
// ═══════════════════════════════════════════════════════════════════

section('3. Playbook Loader');

// Load real playbooks
const playbooksDir = path.join(__dirname, '..', 'playbooks', 'pando-node');
if (fs.existsSync(playbooksDir)) {
  const playbooks = loadPlaybooksFromDir(playbooksDir);
  assert(playbooks.length === 6, `loaded 6 playbooks from pando-node/ (got ${playbooks.length})`);

  const gov = playbooks.find(p => p.name === 'governance-flow');
  assert(gov !== undefined, 'governance-flow playbook found');
  assert(gov!.steps.length >= 5, `governance-flow has ${gov!.steps.length} steps`);

  // Resolve variables
  const resolvedPb = resolvePlaybookVariables(gov!, {
    HUB_URL: 'https://test.example.com',
    API_URL: 'http://localhost:4100',
    TIMESTAMP: 'test-123',
  });
  const firstStep = resolvedPb.steps[0];
  assert(
    typeof firstStep.target === 'string' && firstStep.target.includes('test.example.com'),
    'resolvePlaybookVariables replaces {{HUB_URL}}'
  );
} else {
  console.log('  SKIP: playbooks/pando-node/ not found');
}

// Validate playbook
const validPlaybook = validatePlaybook({
  name: 'test-playbook',
  steps: [{ action: 'navigate', target: '/test' }],
});
assert(validPlaybook.name === 'test-playbook', 'validatePlaybook accepts valid playbook');
assert(validPlaybook.mode === 'scripted', 'validatePlaybook defaults mode to scripted');
assert(validPlaybook.version === '1.0.0', 'validatePlaybook defaults version to 1.0.0');

// Invalid playbook should throw
let threw = false;
try {
  validatePlaybook({ name: '', steps: [] });
} catch {
  threw = true;
}
assert(threw, 'validatePlaybook rejects invalid playbook (empty name/steps)');

// ═══════════════════════════════════════════════════════════════════
// 4. PandoTester Class
// ═══════════════════════════════════════════════════════════════════

section('4. PandoTester Class');

const tester = new PandoTester({
  project: 'self-test',
  rootDir: tmpDir,
  gatewayUrl: 'https://example.com',
  apiUrl: 'http://localhost:4100',
});

// Register scenarios
const sc = tester.scenarios.register({
  name: 'tester-scenario',
  description: 'Test via PandoTester',
  version: '1.0.0',
  mode: 'both',
  tags: ['smoke'],
  prerequisites: {},
  steps: [
    { action: 'navigate', target: '/test' },
    { action: 'verify', target: 'page content' },
  ],
});
assert(sc.id !== undefined, 'scenarios.register returns record with id');
assert(sc.name === 'tester-scenario', 'scenarios.register stores name');

// List scenarios
const scList = tester.scenarios.list();
assert(scList.length >= 1, 'scenarios.list returns registered scenarios');

// Get scenario
const scGet = tester.scenarios.get(sc.id);
assert(scGet !== undefined, 'scenarios.get retrieves by id');

// Dashboard overview
const overview = tester.dashboard.overview();
assert(overview.project === 'self-test', 'dashboard.overview returns correct project');
assert(typeof overview.total_scenarios === 'number', 'dashboard.overview has total_scenarios');
assert(typeof overview.open_findings === 'number', 'dashboard.overview has open_findings');
assert(typeof overview.pass_rate === 'number', 'dashboard.overview has pass_rate');

// History (empty but should not crash)
const histRuns = tester.history.getRuns({ limit: 5 });
assert(Array.isArray(histRuns), 'history.getRuns returns array');

const histTrend = tester.history.getTrend(7);
assert(Array.isArray(histTrend), 'history.getTrend returns array');

// Findings (empty but should not crash)
const findList = tester.findings.list({ status: 'open' });
assert(Array.isArray(findList), 'findings.list returns array');

// Load playbooks via tester
if (fs.existsSync(playbooksDir)) {
  const pb = tester.playbooks.load(path.join(playbooksDir, 'gateway-navigation.json'));
  assert(pb.name === 'gateway-navigation', 'playbooks.load loads playbook');
  assert(pb.steps.length >= 5, 'loaded playbook has steps');
}

// Delete scenario
tester.scenarios.delete(sc.id);
const scDeleted = tester.scenarios.get(sc.id);
assert(scDeleted === undefined, 'scenarios.delete removes scenario');

tester.close();

// ═══════════════════════════════════════════════════════════════════
// 5. Cleanup & Report
// ═══════════════════════════════════════════════════════════════════

section('5. Results');

// Cleanup tmp
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'='.repeat(50)}`);
console.log(`SELF-TEST COMPLETE: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
}
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
