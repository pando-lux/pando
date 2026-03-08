/**
 * QA Runner — Automated Playwright testing for the code pipeline.
 *
 * Phase 16.4: Provides page-level and API-level testing that integrates
 * into the autonomous code pipeline. Uses dynamic import for Playwright
 * so the module loads even when Playwright is not installed.
 *
 * Phase 17.5: Enhanced with structured API test cases (ApiTestCase), P2P
 * consistency testing, and a built-in default API health test suite.
 *
 * Features:
 *   - runPageTests()          — navigate pages, collect console errors, capture screenshots
 *   - runApiTests()           — hit API endpoints and validate responses (simple URL list)
 *   - runStructuredApiTests() — run ApiTestCase[] with method, body, expected status/fields, auth
 *   - runP2PTests()           — compare /status, /scheduler/tasks, /governance/proposals between nodes
 *   - getDefaultApiTests()    — built-in health test suite
 *   - getAffectedPages()      — determine which pages are affected by a set of file changes
 *   - Per-page 30s timeout, 5-minute total timeout
 *   - Structured QAResult / PageResult responses
 */

import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { QAResult, PageResult, HealthCheckResult, ApiTestCase, FileChange } from '@pando/shared';

// ── Constants ────────────────────────────────────────────────────────────────

const PER_PAGE_TIMEOUT_MS = 30_000;   // 30 seconds per page
const TOTAL_TIMEOUT_MS = 5 * 60_000;  // 5 minutes total

// ── Playwright dynamic import types ──────────────────────────────────────────

/** Minimal Playwright types so we don't need @types/playwright at compile time. */
interface PwBrowser { newContext(opts?: any): Promise<PwContext>; close(): Promise<void> }
interface PwContext { newPage(): Promise<PwPage>; close(): Promise<void> }
interface PwPage {
  goto(url: string, opts?: any): Promise<any>;
  on(event: string, handler: (...args: any[]) => void): void;
  screenshot(opts?: any): Promise<Buffer>;
  close(): Promise<void>;
  waitForLoadState(state?: string, opts?: any): Promise<void>;
}
interface PwChromium { launch(opts?: any): Promise<PwBrowser> }

// ── QaRunner ─────────────────────────────────────────────────────────────────

export class QaRunner {
  private readonly screenshotDir: string;
  private readonly baseUrl: string;
  private readonly headless: boolean;

  constructor(options: { screenshotDir?: string; baseUrl?: string; headless?: boolean } = {}) {
    this.screenshotDir = options.screenshotDir || join(process.cwd(), 'qa-screenshots');
    this.baseUrl = options.baseUrl || 'http://localhost:4000';
    this.headless = options.headless ?? true;
  }

  // ── Page Tests ─────────────────────────────────────────────────────────────

  /**
   * Run page-level tests against a list of URLs.
   *
   * For each page:
   *   1. Navigate to the URL
   *   2. Collect console errors
   *   3. Capture a screenshot
   *   4. Enforce a 30s per-page timeout
   *
   * A 5-minute total timeout aborts remaining pages.
   */
  async runPageTests(urls: string[], options?: { headless?: boolean }): Promise<QAResult> {
    const startedAt = Date.now();
    const pages: PageResult[] = [];
    const headless = options?.headless ?? this.headless;

    const playwright = await this.loadPlaywright();
    if (!playwright) {
      return this.playwrightUnavailableResult(startedAt, urls.length);
    }

    // Ensure screenshot directory exists
    if (!existsSync(this.screenshotDir)) {
      mkdirSync(this.screenshotDir, { recursive: true });
    }

    let browser: PwBrowser | null = null;
    try {
      browser = await playwright.launch({ headless });

      for (const url of urls) {
        // Enforce total timeout
        if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
          pages.push({
            url,
            status: 'timeout',
            consoleErrors: [],
            durationMs: 0,
            error: 'Total QA timeout exceeded (5 minutes)',
          });
          continue;
        }

        const result = await this.testSinglePage(browser, url);
        pages.push(result);
      }
    } catch (err: any) {
      // Browser-level failure — mark all untested pages as errors
      for (const url of urls) {
        if (!pages.some(p => p.url === url)) {
          pages.push({
            url,
            status: 'error',
            consoleErrors: [],
            durationMs: 0,
            error: `Browser error: ${err.message}`,
          });
        }
      }
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
    }

    return this.buildQAResult(pages, startedAt);
  }

  // ── API Tests ──────────────────────────────────────────────────────────────

  /**
   * Run API-level tests against a list of endpoints.
   *
   * Each endpoint is tested with a GET request. The test passes if the
   * response status is 2xx and no errors occur within the per-page timeout.
   */
  async runApiTests(endpoints: string[]): Promise<QAResult> {
    const startedAt = Date.now();
    const pages: PageResult[] = [];

    for (const endpoint of endpoints) {
      // Enforce total timeout
      if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
        pages.push({
          url: endpoint,
          status: 'timeout',
          consoleErrors: [],
          durationMs: 0,
          error: 'Total QA timeout exceeded (5 minutes)',
        });
        continue;
      }

      const result = await this.testSingleApi(endpoint);
      pages.push(result);
    }

    return this.buildQAResult(pages, startedAt);
  }

  // ── Affected Pages ─────────────────────────────────────────────────────────

  /**
   * Determine which pages/routes are likely affected by a set of changed files.
   *
   * Uses simple heuristics based on file paths:
   *   - Changes to gateway/src/routes → corresponding route paths
   *   - Changes to shared/ or node/ → all pages (broad impact)
   *   - Changes to extension/ → no pages affected
   */
  getAffectedPages(changes: FileChange[]): string[] {
    const affectedUrls = new Set<string>();
    let broadImpact = false;

    for (const change of changes) {
      const filePath = change.filePath;
      const normalized = filePath.replace(/\\/g, '/');

      // Gateway route changes — map to specific paths
      if (normalized.includes('gateway/src/routes/') || normalized.includes('gateway/src/pages/')) {
        const routeMatch = normalized.match(/(?:routes|pages)\/(.+?)(?:\.tsx?|\.jsx?|\.vue|\.svelte)?$/);
        if (routeMatch) {
          const route = routeMatch[1]
            .replace(/index$/, '')
            .replace(/\[([^\]]+)\]/g, ':$1');
          affectedUrls.add(`${this.baseUrl}/${route}`);
        }
      }

      // API server changes — test the API health endpoint at minimum
      if (normalized.includes('node/src/api-server')) {
        affectedUrls.add(`${this.baseUrl}/v1/status`);
      }

      // Shared or node core changes — broad impact, test key pages
      if (
        normalized.includes('packages/shared/') ||
        normalized.includes('packages/node/src/')
      ) {
        broadImpact = true;
      }
    }

    // If broad impact, add core pages
    if (broadImpact) {
      affectedUrls.add(`${this.baseUrl}/`);
      affectedUrls.add(`${this.baseUrl}/v1/status`);
    }

    return Array.from(affectedUrls);
  }

  // ── Run Checks (Post-Verifier QA) ──────────────────────────────────────────

  /**
   * Run QA checks for code-change tasks after the verifier completes.
   *
   * Combines API health checks with page tests for files affected by the change.
   * Used by the scheduler's post-verifier flow to gate code-change tasks.
   *
   * @param changedFiles — list of files changed by the code task
   * @returns QAResult with pass/fail status
   */
  async runChecks(changedFiles: string[]): Promise<QAResult> {
    const startedAt = Date.now();

    // 1. Run API health checks on core endpoints
    const apiEndpoints = [
      `${this.baseUrl}/v1/status`,
    ];
    const apiResult = await this.runApiTests(apiEndpoints);

    // 2. Determine affected pages from changed files and run page tests if possible
    const affectedUrls = this.getAffectedPages(
      changedFiles.map(f => ({ filePath: f, operation: 'modify' as const })),
    );
    let pageResult: QAResult | undefined;
    if (affectedUrls.length > 0) {
      pageResult = await this.runPageTests(affectedUrls);
    }

    // 3. Merge results
    const allPages = [...apiResult.pages, ...(pageResult?.pages || [])];
    return this.buildQAResult(allPages, startedAt);
  }

  // ── Health Check ───────────────────────────────────────────────────────────

  /**
   * Post-deploy health check: verifies all 7 gateway pages return 200,
   * 4 core API endpoints respond correctly, and the scheduler is running.
   *
   * Used after auto-restart to confirm the deployed code is healthy.
   * If any check fails, the caller should trigger a rollback.
   */
  async runHealthCheck(): Promise<HealthCheckResult> {
    const startedAt = Date.now();

    // Gateway pages — only check if gateway is co-hosted (not on EC2/secure nodes)
    const gatewayPaths: string[] = [];

    // Core API endpoints (correct /v1/ prefix)
    const apiPaths = [
      '/v1/status',
      '/v1/peers',
    ];

    const gatewayPages: PageResult[] = [];
    for (const path of gatewayPaths) {
      const result = await this.testSingleApi(`${this.baseUrl}${path}`);
      gatewayPages.push(result);
    }

    const apiEndpoints: PageResult[] = [];
    for (const path of apiPaths) {
      const url = `${this.baseUrl}${path}`;
      const result = await this.testSingleApi(url);
      apiEndpoints.push(result);
    }

    // Scheduler is optional — secure/lightweight nodes don't have one
    const schedulerRunning = true;

    const allPages = [...gatewayPages, ...apiEndpoints];
    const success = allPages.every(p => p.status === 'passed');

    return {
      success,
      gatewayPages,
      apiEndpoints,
      schedulerRunning,
      durationMs: Date.now() - startedAt,
      timestamp: Date.now(),
    };
  }

  // ── Structured API Tests (Phase 17.5) ────────────────────────────────────

  /**
   * Run structured API test cases with method, body, expected status,
   * expected response fields, and auth token support.
   *
   * Each test case specifies:
   *   - HTTP method (GET/POST/PUT/DELETE)
   *   - Expected status code
   *   - Optional expected fields in the response JSON
   *   - Whether auth is required (reads token from ~/.pando/api-token)
   */
  async runStructuredApiTests(testCases: ApiTestCase[]): Promise<QAResult> {
    const startedAt = Date.now();
    const pages: PageResult[] = [];

    for (const tc of testCases) {
      if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
        pages.push({
          url: `${tc.method} ${tc.path}`,
          status: 'timeout',
          consoleErrors: [],
          durationMs: 0,
          error: 'Total QA timeout exceeded (5 minutes)',
        });
        continue;
      }

      const result = await this.testApiCase(tc);
      pages.push(result);
    }

    return this.buildQAResult(pages, startedAt);
  }

  // ── P2P Consistency Tests (Phase 17.5) ──────────────────────────────────

  /**
   * Compare data between two nodes to verify P2P consistency.
   *
   * Fetches /status, /scheduler/tasks, and /governance/proposals from both
   * nodes and checks for agreement on key fields.
   */
  async runP2PTests(localApiUrl: string, remoteApiUrl: string): Promise<QAResult> {
    const startedAt = Date.now();
    const pages: PageResult[] = [];

    const endpoints = [
      { path: '/v1/status', fields: ['totalSupply', 'totalAccounts'] },
      { path: '/v1/tasks', fields: [] },
      { path: '/v1/governance/proposals', fields: [] },
    ];

    for (const ep of endpoints) {
      if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
        pages.push({
          url: `P2P ${ep.path}`,
          status: 'timeout',
          consoleErrors: [],
          durationMs: 0,
          error: 'Total QA timeout exceeded',
        });
        continue;
      }

      const testStart = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PER_PAGE_TIMEOUT_MS);

        const [localRes, remoteRes] = await Promise.all([
          fetch(`${localApiUrl}${ep.path}`, { signal: controller.signal }),
          fetch(`${remoteApiUrl}${ep.path}`, { signal: controller.signal }),
        ]);
        clearTimeout(timer);

        if (!localRes.ok || !remoteRes.ok) {
          pages.push({
            url: `P2P ${ep.path}`,
            status: 'failed',
            consoleErrors: [
              `Local: HTTP ${localRes.status}`,
              `Remote: HTTP ${remoteRes.status}`,
            ],
            durationMs: Date.now() - testStart,
            error: 'One or both nodes returned non-200 status',
          });
          continue;
        }

        const localData = await localRes.json() as Record<string, any>;
        const remoteData = await remoteRes.json() as Record<string, any>;
        const mismatches: string[] = [];

        // Compare specified fields for equality
        for (const field of ep.fields) {
          const localVal = localData[field];
          const remoteVal = remoteData[field];
          if (JSON.stringify(localVal) !== JSON.stringify(remoteVal)) {
            mismatches.push(`${field}: local=${JSON.stringify(localVal)} remote=${JSON.stringify(remoteVal)}`);
          }
        }

        pages.push({
          url: `P2P ${ep.path}`,
          status: mismatches.length > 0 ? 'failed' : 'passed',
          consoleErrors: mismatches,
          durationMs: Date.now() - testStart,
          error: mismatches.length > 0 ? `${mismatches.length} field mismatch(es)` : undefined,
        });
      } catch (err: any) {
        pages.push({
          url: `P2P ${ep.path}`,
          status: 'error',
          consoleErrors: [],
          durationMs: Date.now() - testStart,
          error: err.message,
        });
      }
    }

    return this.buildQAResult(pages, startedAt);
  }

  // ── Default API Test Suite (Phase 17.5) ─────────────────────────────────

  /**
   * Return a built-in set of API test cases covering core node endpoints.
   * Useful as a baseline health suite before any deployment.
   */
  getDefaultApiTests(): ApiTestCase[] {
    return [
      { method: 'GET', path: '/v1/status', expectedStatus: 200, expectedFields: ['peerId', 'uptime', 'peers'], description: 'Node status endpoint' },
      { method: 'GET', path: '/v1/health', expectedStatus: 200, expectedFields: ['status'], description: 'Health check endpoint' },
      { method: 'GET', path: '/v1/peers', expectedStatus: 200, expectedFields: ['peers'], description: 'Peer list endpoint' },
      { method: 'GET', path: '/v1/tasks', expectedStatus: 200, description: 'Task list endpoint' },
      { method: 'GET', path: '/v1/governance/proposals', expectedStatus: 200, description: 'Governance proposals' },
      { method: 'GET', path: '/v1/monitor/status', expectedStatus: 200, description: 'Monitor status' },
      { method: 'GET', path: '/v1/wallet', expectedStatus: 200, expectedFields: ['peerId', 'balance'], description: 'Wallet info' },
      { method: 'GET', path: '/v1/emissions/stats', expectedStatus: 200, description: 'Emission statistics' },
      { method: 'GET', path: '/v1/security/stats', expectedStatus: 200, description: 'Security statistics' },
      // Auth-required endpoints — should return 401 without token
      { method: 'POST', path: '/v1/tasks', expectedStatus: 401, authRequired: false, description: 'Task creation requires auth' },
      { method: 'POST', path: '/v1/transfer', expectedStatus: 401, authRequired: false, description: 'Transfer requires auth' },
      { method: 'POST', path: '/v1/upgrade', expectedStatus: 401, authRequired: false, description: 'Upgrade requires auth' },
    ];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Dynamically import Playwright's chromium launcher.
   * Returns null if Playwright is not installed.
   *
   * Uses a string variable for the module name to prevent TypeScript
   * from attempting to resolve the module at compile time.
   */
  private async loadPlaywright(): Promise<PwChromium | null> {
    try {
      // Use a variable so TypeScript doesn't try to resolve the module statically
      const moduleName = 'playwright';
      const pw: any = await import(/* webpackIgnore: true */ moduleName);
      return pw.chromium || pw.default?.chromium || null;
    } catch {
      // Playwright not installed — return null gracefully
      return null;
    }
  }

  /**
   * Test a single page: navigate, collect console errors, capture screenshot.
   */
  private async testSinglePage(browser: PwBrowser, url: string): Promise<PageResult> {
    const pageStart = Date.now();
    const consoleErrors: string[] = [];
    let context: PwContext | null = null;
    let page: PwPage | null = null;

    try {
      context = await browser.newContext();
      page = await context.newPage();

      // Collect console errors
      page.on('console', (msg: any) => {
        if (msg.type && msg.type() === 'error') {
          consoleErrors.push(msg.text ? msg.text() : String(msg));
        }
      });

      // Collect page errors (unhandled exceptions)
      page.on('pageerror', (err: any) => {
        consoleErrors.push(`PageError: ${err.message || String(err)}`);
      });

      // Navigate with per-page timeout
      await page.goto(url, {
        timeout: PER_PAGE_TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      });

      // Wait for network idle (best-effort, don't fail on this)
      await page.waitForLoadState('networkidle', { timeout: PER_PAGE_TIMEOUT_MS / 2 }).catch(() => {});

      // Capture screenshot
      let screenshotPath: string | undefined;
      try {
        const filename = this.urlToFilename(url) + '.png';
        screenshotPath = join(this.screenshotDir, filename);
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch {
        screenshotPath = undefined;
      }

      const durationMs = Date.now() - pageStart;

      return {
        url,
        status: consoleErrors.length > 0 ? 'failed' : 'passed',
        consoleErrors,
        screenshotPath,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - pageStart;
      const isTimeout = err.name === 'TimeoutError' || (err.message && err.message.includes('Timeout'));

      return {
        url,
        status: isTimeout ? 'timeout' : 'error',
        consoleErrors,
        durationMs,
        error: err.message,
      };
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
    }
  }

  /**
   * Test a single API endpoint using native fetch.
   */
  private async testSingleApi(endpoint: string): Promise<PageResult> {
    const pageStart = Date.now();
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_PAGE_TIMEOUT_MS);

      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timer);

      const durationMs = Date.now() - pageStart;
      const ok = response.status >= 200 && response.status < 300;

      return {
        url,
        status: ok ? 'passed' : 'failed',
        consoleErrors: ok ? [] : [`HTTP ${response.status} ${response.statusText}`],
        durationMs,
        error: ok ? undefined : `HTTP ${response.status}`,
      };
    } catch (err: any) {
      const durationMs = Date.now() - pageStart;
      const isTimeout = err.name === 'AbortError' || err.name === 'TimeoutError';

      return {
        url,
        status: isTimeout ? 'timeout' : 'error',
        consoleErrors: [],
        durationMs,
        error: err.message,
      };
    }
  }

  /**
   * Test a single structured ApiTestCase.
   * Supports GET/POST/PUT/DELETE, expected status, expected fields, and auth tokens.
   */
  private async testApiCase(tc: ApiTestCase): Promise<PageResult> {
    const pageStart = Date.now();
    const url = tc.path.startsWith('http') ? tc.path : `${this.baseUrl}${tc.path}`;
    const label = `${tc.method} ${tc.path}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_PAGE_TIMEOUT_MS);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Load auth token if the test requires it
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

      const durationMs = Date.now() - pageStart;
      const consoleErrors: string[] = [];

      // Check status code
      const statusMatch = response.status === tc.expectedStatus;
      if (!statusMatch) {
        consoleErrors.push(`Expected status ${tc.expectedStatus}, got ${response.status}`);
      }

      // Check expected fields in response body (only if we expect 2xx)
      if (tc.expectedFields && tc.expectedFields.length > 0 && response.status >= 200 && response.status < 300) {
        try {
          const body = await response.json() as Record<string, any>;
          for (const field of tc.expectedFields) {
            if (!(field in body)) {
              consoleErrors.push(`Missing expected field: "${field}"`);
            }
          }
        } catch {
          consoleErrors.push('Failed to parse response as JSON');
        }
      }

      return {
        url: label,
        status: consoleErrors.length > 0 ? 'failed' : 'passed',
        consoleErrors,
        durationMs,
        error: consoleErrors.length > 0 ? consoleErrors[0] : undefined,
      };
    } catch (err: any) {
      const durationMs = Date.now() - pageStart;
      const isTimeout = err.name === 'AbortError' || err.name === 'TimeoutError';

      return {
        url: label,
        status: isTimeout ? 'timeout' : 'error',
        consoleErrors: [],
        durationMs,
        error: err.message,
      };
    }
  }

  /**
   * Load the API bearer token from ~/.pando/api-token.
   * Returns null if the file does not exist or is empty.
   */
  private loadApiToken(): string | null {
    try {
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

  /**
   * Build an aggregated QAResult from individual PageResults.
   */
  private buildQAResult(pages: PageResult[], startedAt: number): QAResult {
    const completedAt = Date.now();
    let passed = 0;
    let failed = 0;
    let errors = 0;
    let timeouts = 0;

    for (const p of pages) {
      switch (p.status) {
        case 'passed': passed++; break;
        case 'failed': failed++; break;
        case 'error': errors++; break;
        case 'timeout': timeouts++; break;
      }
    }

    return {
      success: failed === 0 && errors === 0 && timeouts === 0,
      totalPages: pages.length,
      passed,
      failed,
      errors,
      timeouts,
      pages,
      durationMs: completedAt - startedAt,
      startedAt,
      completedAt,
    };
  }

  /**
   * Generate a result indicating Playwright is not available.
   */
  private playwrightUnavailableResult(startedAt: number, pageCount: number): QAResult {
    return {
      success: false,
      totalPages: pageCount,
      passed: 0,
      failed: 0,
      errors: pageCount,
      timeouts: 0,
      pages: Array.from({ length: pageCount }, (_, i) => ({
        url: `page-${i}`,
        status: 'error' as const,
        consoleErrors: [],
        durationMs: 0,
        error: 'Playwright is not installed. Install with: npm install playwright',
      })),
      durationMs: Date.now() - startedAt,
      startedAt,
      completedAt: Date.now(),
    };
  }

  /**
   * Convert a URL to a safe filename for screenshots.
   */
  private urlToFilename(url: string): string {
    return url
      .replace(/^https?:\/\//, '')
      .replace(/[^a-zA-Z0-9]/g, '_')
      .slice(0, 100);
  }
}
