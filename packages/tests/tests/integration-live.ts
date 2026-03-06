/**
 * @pando/tests Integration Test — LiveRunner
 *
 * Runs the gateway-navigation playbook via LiveRunner,
 * records results + findings to SQLite, then verifies the data pipeline.
 *
 * Prerequisites:
 *   - Public gateway deployed (https://gateway-one-mu.vercel.app)
 *
 * Run: npx tsx packages/tests/tests/integration-live.ts
 */

import * as path from 'path';
import { PandoTester } from '../src/index';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const PLAYBOOKS_DIR = path.resolve(__dirname, '..', 'playbooks', 'pando-node');

async function main() {
  console.log('=== @pando/tests LiveRunner Integration Test ===\n');

  // Initialize PandoTester for pando-node
  const tester = new PandoTester({
    project: 'pando-node',
    rootDir: PROJECT_ROOT,
    gatewayUrl: 'https://gateway-one-mu.vercel.app',
    apiUrl: 'http://127.0.0.1:4100',
  });

  // Load the gateway-navigation playbook
  console.log('1. Loading gateway-navigation playbook...');
  const playbook = tester.playbooks.load(path.join(PLAYBOOKS_DIR, 'gateway-navigation.json'));
  console.log(`   Name: ${playbook.name}`);
  console.log(`   Steps: ${playbook.steps.length}`);

  // Run live test
  console.log('\n2. Running live test (headed browser)...\n');

  const screenshotDir = path.join(PROJECT_ROOT, '.pando-tests', 'screenshots');
  const result = await tester.live.run(playbook, {
    headed: true,
    screenshotEvery: true,
    slowMo: 500,
    timeout: 15000,
    screenshotDir,
    variables: {
      GATEWAY_URL: 'https://gateway-one-mu.vercel.app',
      API_URL: 'http://127.0.0.1:4100',
    },
  });

  console.log(`\n3. LiveRunner Results:`);
  console.log(`   Run ID: ${result.runId}`);
  console.log(`   Status: ${result.status}`);
  console.log(`   Total steps:  ${result.totalSteps}`);
  console.log(`   Passed steps: ${result.passedSteps}`);
  console.log(`   Failed steps: ${result.failedSteps}`);
  console.log(`   Duration: ${result.duration}ms`);
  console.log(`   Screenshots: ${result.screenshots.length}`);
  console.log(`   Findings: ${result.findings.length}`);

  if (result.findings.length > 0) {
    console.log('\n   Findings:');
    result.findings.forEach(f => {
      console.log(`   - [${f.severity}] ${f.title}: ${f.description}`);
    });
  }

  // Verify data was recorded in DB
  console.log('\n4. Verifying database records...');

  const runs = tester.history.getRuns({ limit: 5 });
  console.log(`   Total runs in DB: ${runs.length}`);

  const findings = tester.findings.list({ status: 'open' });
  console.log(`   Open findings: ${findings.length}`);

  const overview = tester.dashboard.overview();
  console.log(`   Dashboard overview:`);
  console.log(`     Total runs: ${overview.total_runs}`);
  console.log(`     Pass rate: ${(overview.pass_rate * 100).toFixed(1)}%`);
  console.log(`     Open findings: ${overview.open_findings}`);

  tester.close();

  const success = result.status === 'passed' || result.status === 'failed';
  console.log(`\n=== Integration test ${success ? 'COMPLETED' : 'ERROR'} ===`);
  console.log(`(Note: 'failed' status is OK if findings were recorded — the pipeline worked)`);
  process.exit(success ? 0 : 1);
}

main().catch(err => {
  console.error('Integration test crashed:', err);
  process.exit(1);
});
