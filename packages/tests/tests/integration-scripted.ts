/**
 * @pando/tests Integration Test — ScriptedRunner
 *
 * Runs the existing 204 Playwright E2E tests via ScriptedRunner,
 * records results to SQLite, then verifies the data pipeline.
 *
 * Prerequisites:
 *   - Node running on port 4100
 *   - Public gateway deployed
 *
 * Run: npx tsx packages/tests/tests/integration-scripted.ts
 */

import * as path from 'path';
import { PandoTester } from '../src/index';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

async function main() {
  console.log('=== @pando/tests ScriptedRunner Integration Test ===\n');

  // Initialize PandoTester for pando-node
  const tester = new PandoTester({
    project: 'pando-node',
    rootDir: PROJECT_ROOT,
    gatewayUrl: 'https://gateway-one-mu.vercel.app',
    apiUrl: 'http://127.0.0.1:4100',
  });

  console.log('1. Running Playwright E2E suite via ScriptedRunner...\n');

  const result = await tester.scripted.run({
    configFile: path.join(PROJECT_ROOT, 'playwright.config.ts'),
    headed: true,
    timeout: 60000,
  });

  console.log(`\n2. ScriptedRunner Results:`);
  console.log(`   Run ID: ${result.runId}`);
  console.log(`   Status: ${result.status}`);
  console.log(`   Total:  ${result.total}`);
  console.log(`   Passed: ${result.passed}`);
  console.log(`   Failed: ${result.failed}`);
  console.log(`   Duration: ${result.duration}ms`);

  if (result.failures.length > 0) {
    console.log(`\n   Failures:`);
    result.failures.forEach(f => console.log(`   - ${f.title}: ${f.error}`));
  }

  // Verify data was recorded in DB
  console.log('\n3. Verifying database records...');

  const runs = tester.history.getRuns({ limit: 1 });
  console.log(`   Runs in DB: ${runs.length}`);
  if (runs.length > 0) {
    console.log(`   Latest run status: ${runs[0].status}`);
    console.log(`   Latest run steps: ${runs[0].total_steps}`);
  }

  const overview = tester.dashboard.overview();
  console.log(`   Dashboard overview:`);
  console.log(`     Total runs: ${overview.total_runs}`);
  console.log(`     Pass rate: ${(overview.pass_rate * 100).toFixed(1)}%`);
  console.log(`     Total scenarios: ${overview.total_scenarios}`);

  tester.close();

  console.log(`\n=== Integration test ${result.status === 'passed' ? 'PASSED' : 'FAILED'} ===`);
  process.exit(result.status === 'passed' ? 0 : 1);
}

main().catch(err => {
  console.error('Integration test crashed:', err);
  process.exit(1);
});
