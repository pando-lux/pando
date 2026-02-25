/**
 * Regression Suite — Persistent, auto-growing regression test suite.
 *
 * Phase 17.6: Provides a built-in set of regression tests that can be
 * extended automatically from QA results. Runs before every deploy
 * (integrated with pipeline-runner) and can be triggered via API.
 *
 * Features:
 *   - loadBuiltinTests()      — core regression tests (API health, auth, governance)
 *   - addTestFromQAResult()   — auto-grow suite from successful QA runs
 *   - runAll()                — run full regression suite
 *   - runCategory()           — run subset by category
 *   - Persistent storage at ~/.pando/regression-suite.json
 *   - Last results cached in memory for API queries
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  ApiTestCase,
  RegressionTest,
  RegressionResult,
  RegressionTestResult,
} from '@pando/shared';

// ── Constants ────────────────────────────────────────────────────────────────

const PER_TEST_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 10 * 60_000; // 10 minutes for full suite

// ── RegressionSuite ──────────────────────────────────────────────────────────

export class RegressionSuite {
  private tests: RegressionTest[] = [];
  private readonly filePath: string;
  private lastResult: RegressionResult | null = null;
  private readonly apiBaseUrl: string;

  constructor(options: { dataDir?: string; apiBaseUrl?: string } = {}) {
    const dataDir = options.dataDir || join(process.cwd(), '.pando');
    this.filePath = join(dataDir, 'regression-suite.json');
    this.apiBaseUrl = options.apiBaseUrl || 'http://127.0.0.1:4000';

    // Load persisted suite if it exists
    this.load();

    // Ensure builtin tests are present
    if (this.tests.length === 0) {
      this.loadBuiltinTests();
      this.save();
    }
  }

  // ── Builtin Tests ─────────────────────────────────────────────────────────

  /**
   * Load the built-in regression tests. These cover core API endpoints,
   * auth gating, governance, and ledger operations.
   */
  loadBuiltinTests(): void {
    const builtins: Omit<RegressionTest, 'id' | 'addedAt'>[] = [
      // API health
      {
        description: 'Node status returns 200 with peerId and uptime',
        category: 'api',
        test: { method: 'GET', path: '/status', expectedStatus: 200, expectedFields: ['peerId', 'uptime', 'peers'] },
      },
      {
        description: 'Health endpoint returns 200',
        category: 'api',
        test: { method: 'GET', path: '/health', expectedStatus: 200, expectedFields: ['status'] },
      },
      {
        description: 'Peer list returns 200',
        category: 'api',
        test: { method: 'GET', path: '/peers', expectedStatus: 200, expectedFields: ['peers'] },
      },
      {
        description: 'Wallet info returns peerId and balance',
        category: 'api',
        test: { method: 'GET', path: '/wallet', expectedStatus: 200, expectedFields: ['peerId', 'balance'] },
      },
      {
        description: 'Task list returns 200',
        category: 'api',
        test: { method: 'GET', path: '/tasks', expectedStatus: 200 },
      },
      {
        description: 'Monitor status returns 200',
        category: 'api',
        test: { method: 'GET', path: '/monitor/status', expectedStatus: 200 },
      },
      // Governance
      {
        description: 'Governance proposals returns 200',
        category: 'governance',
        test: { method: 'GET', path: '/governance/proposals', expectedStatus: 200 },
      },
      {
        description: 'Active proposals returns 200',
        category: 'governance',
        test: { method: 'GET', path: '/governance/proposals/active', expectedStatus: 200 },
      },
      // Auth gating — writes require auth
      {
        description: 'Task creation requires auth (401 without token)',
        category: 'api',
        test: { method: 'POST', path: '/tasks', expectedStatus: 401, authRequired: false },
      },
      {
        description: 'Transfer requires auth (401 without token)',
        category: 'api',
        test: { method: 'POST', path: '/transfer', expectedStatus: 401, authRequired: false },
      },
      {
        description: 'Upgrade requires auth (401 without token)',
        category: 'api',
        test: { method: 'POST', path: '/upgrade', expectedStatus: 401, authRequired: false },
      },
      // Ledger
      {
        description: 'Transactions returns 200',
        category: 'ledger',
        test: { method: 'GET', path: '/transactions', expectedStatus: 200 },
      },
      // Emissions & Security
      {
        description: 'Emission stats returns 200',
        category: 'api',
        test: { method: 'GET', path: '/emissions/stats', expectedStatus: 200 },
      },
      {
        description: 'Security stats returns 200',
        category: 'api',
        test: { method: 'GET', path: '/security/stats', expectedStatus: 200 },
      },
    ];

    const now = Date.now();
    for (const bt of builtins) {
      // Only add if not already present (by description match)
      if (!this.tests.some(t => t.description === bt.description)) {
        this.tests.push({
          id: this.generateId(),
          addedAt: now,
          ...bt,
        });
      }
    }
  }

  // ── Add Test from QA Result ───────────────────────────────────────────────

  /**
   * Create a new regression test from a QA result.
   * Use this to auto-grow the suite after successful deployments.
   */
  addTestFromQAResult(
    testCase: ApiTestCase,
    description: string,
    category: RegressionTest['category'] = 'api',
  ): RegressionTest {
    const test: RegressionTest = {
      id: this.generateId(),
      description,
      category,
      test: testCase,
      addedAt: Date.now(),
    };

    // Prevent duplicates by checking description and path
    if (!this.tests.some(t => t.description === description && t.test.path === testCase.path)) {
      this.tests.push(test);
      this.save();
    }

    return test;
  }

  // ── Run All ───────────────────────────────────────────────────────────────

  /**
   * Run the full regression suite against the specified API URL.
   */
  async runAll(apiUrl?: string): Promise<RegressionResult> {
    return this.runTests(this.tests, apiUrl);
  }

  // ── Run by Category ───────────────────────────────────────────────────────

  /**
   * Run only the tests matching a specific category.
   */
  async runCategory(category: string, apiUrl?: string): Promise<RegressionResult> {
    const filtered = this.tests.filter(t => t.category === category);
    return this.runTests(filtered, apiUrl);
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /** Get all registered tests. */
  getTests(): readonly RegressionTest[] {
    return this.tests;
  }

  /** Get the most recent run result. */
  getLastResult(): RegressionResult | null {
    return this.lastResult;
  }

  /** Get test count by category. */
  getStats(): { total: number; byCategory: Record<string, number> } {
    const byCategory: Record<string, number> = {};
    for (const t of this.tests) {
      byCategory[t.category] = (byCategory[t.category] || 0) + 1;
    }
    return { total: this.tests.length, byCategory };
  }

  /** Remove a test by ID. */
  removeTest(testId: string): boolean {
    const idx = this.tests.findIndex(t => t.id === testId);
    if (idx < 0) return false;
    this.tests.splice(idx, 1);
    this.save();
    return true;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /** Save suite to disk. */
  save(): void {
    try {
      const dir = this.filePath.replace(/[/\\][^/\\]+$/, '');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.tests, null, 2));
    } catch (err: any) {
      console.error(`[regression-suite] Failed to save: ${err.message}`);
    }
  }

  /** Load suite from disk. */
  load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.tests = parsed;
        }
      }
    } catch (err: any) {
      console.error(`[regression-suite] Failed to load: ${err.message}`);
      this.tests = [];
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Execute a list of regression tests and return aggregated results.
   */
  private async runTests(tests: RegressionTest[], apiUrl?: string): Promise<RegressionResult> {
    const startedAt = Date.now();
    const baseUrl = apiUrl || this.apiBaseUrl;
    const results: RegressionTestResult[] = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const test of tests) {
      // Enforce total timeout
      if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
        skipped += tests.length - results.length;
        break;
      }

      const testStart = Date.now();
      try {
        const result = await this.executeSingleTest(test, baseUrl);
        results.push(result);

        // Update test metadata
        test.lastRun = Date.now();
        test.lastResult = result.passed ? 'pass' : 'fail';

        if (result.passed) {
          passed++;
        } else {
          failed++;
        }
      } catch (err: any) {
        results.push({
          test,
          passed: false,
          error: err.message,
          durationMs: Date.now() - testStart,
        });
        test.lastRun = Date.now();
        test.lastResult = 'fail';
        failed++;
      }
    }

    const result: RegressionResult = {
      total: tests.length,
      passed,
      failed,
      skipped,
      duration: Date.now() - startedAt,
      results,
      runAt: Date.now(),
    };

    this.lastResult = result;
    this.save(); // Persist updated lastRun/lastResult metadata

    return result;
  }

  /**
   * Execute a single regression test.
   */
  private async executeSingleTest(test: RegressionTest, baseUrl: string): Promise<RegressionTestResult> {
    const tc = test.test;
    const testStart = Date.now();
    const url = tc.path.startsWith('http') ? tc.path : `${baseUrl}${tc.path}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_TEST_TIMEOUT_MS);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Load auth token if required
      if (tc.authRequired) {
        const token = this.loadApiToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      }

      const fetchOpts: RequestInit = {
        method: tc.method,
        signal: controller.signal,
        headers,
      };

      if (tc.body && (tc.method === 'POST' || tc.method === 'PUT')) {
        fetchOpts.body = JSON.stringify(tc.body);
      }

      const response = await fetch(url, fetchOpts);
      clearTimeout(timer);

      const errors: string[] = [];

      // Check status code
      if (response.status !== tc.expectedStatus) {
        errors.push(`Expected status ${tc.expectedStatus}, got ${response.status}`);
      }

      // Check expected fields
      if (tc.expectedFields && tc.expectedFields.length > 0 && response.status >= 200 && response.status < 300) {
        try {
          const body = await response.json() as Record<string, any>;
          for (const field of tc.expectedFields) {
            if (!(field in body)) {
              errors.push(`Missing expected field: "${field}"`);
            }
          }
        } catch {
          errors.push('Failed to parse response as JSON');
        }
      }

      return {
        test,
        passed: errors.length === 0,
        error: errors.length > 0 ? errors.join('; ') : undefined,
        durationMs: Date.now() - testStart,
        responseStatus: response.status,
      };
    } catch (err: any) {
      return {
        test,
        passed: false,
        error: err.message,
        durationMs: Date.now() - testStart,
      };
    }
  }

  /**
   * Load the API bearer token from ~/.pando/api-token.
   */
  private loadApiToken(): string | null {
    try {
      const { homedir } = require('node:os');
      const tokenPath = join(homedir(), '.pando', 'api-token');
      if (existsSync(tokenPath)) {
        const token = readFileSync(tokenPath, 'utf-8').trim();
        return token.length > 0 ? token : null;
      }
    } catch {
      // Ignore errors
    }
    return null;
  }

  /** Generate a short random ID. */
  private generateId(): string {
    return `reg-${randomBytes(6).toString('hex')}`;
  }
}
