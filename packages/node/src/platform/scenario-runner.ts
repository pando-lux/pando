/**
 * ScenarioRunner — Automated test scenario executor.
 *
 * Reads test scenarios from the compiled genome knowledge graph
 * and executes automatable ones (API tests via fetch, SSH tests via child_process).
 * Results saved to e2e/results/ for graph re-ingestion.
 *
 * Integrated with the self-sustaining loop: orchestrator triggers
 * scenario runs after QA pass → commit → upgrade.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GenomeBridge, type GraphNode } from './genome-bridge.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScenarioRunnerConfig {
  graphPath: string;
  apiBaseUrl: string;
  apiToken: string;
  resultsDir?: string;
}

export interface StepResult {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  output?: string;
  durationMs?: number;
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: StepResult[];
  error?: string;
  validates?: string;
}

export interface CategoryResult {
  category: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: ScenarioResult[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface SuiteResult {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  categories: Record<string, CategoryResult>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PER_SCENARIO_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// ScenarioRunner
// ---------------------------------------------------------------------------

export class ScenarioRunner {
  private bridge: GenomeBridge;
  private apiBaseUrl: string;
  private apiToken: string;
  private resultsDir: string;
  private lastResult: SuiteResult | null = null;

  constructor(config: ScenarioRunnerConfig) {
    this.bridge = new GenomeBridge(config.graphPath);
    this.apiBaseUrl = config.apiBaseUrl.replace(/\/$/, '');
    this.apiToken = config.apiToken;
    this.resultsDir = config.resultsDir || join(process.cwd(), 'e2e', 'results');
  }

  /**
   * Load all test scenarios from the graph.
   */
  loadScenarios(): GraphNode[] {
    return this.bridge.allTests();
  }

  /**
   * Run a single scenario by name.
   */
  async runScenario(name: string): Promise<ScenarioResult> {
    const node = this.bridge.allTests().find(t => t._name === name);
    if (!node) {
      return {
        scenarioId: name,
        scenarioName: name,
        status: 'error',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        steps: [],
        error: `Scenario "${name}" not found in graph`,
      };
    }
    return this.executeScenario(node);
  }

  /**
   * Run all automatable scenarios in a category.
   */
  async runCategory(category: string): Promise<CategoryResult> {
    const scenarios = this.bridge.testsByCategory(category)
      .filter(t => t.automatable === 'true' || t.automatable === true);

    const startedAt = new Date().toISOString();
    const start = Date.now();
    const results: ScenarioResult[] = [];

    for (const scenario of scenarios) {
      const result = await this.executeScenario(scenario);
      results.push(result);
    }

    const finishedAt = new Date().toISOString();
    return {
      category,
      total: results.length,
      passed: results.filter(r => r.status === 'pass').length,
      failed: results.filter(r => r.status === 'fail').length,
      skipped: results.filter(r => r.status === 'skip').length,
      results,
      startedAt,
      finishedAt,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Run all automatable scenarios across all categories.
   */
  async runAll(): Promise<SuiteResult> {
    const allTests = this.bridge.allTests();
    const categories = new Set(allTests.map(t => t.category || 'uncategorized'));

    const startedAt = new Date().toISOString();
    const start = Date.now();
    const categoryResults: Record<string, CategoryResult> = {};
    let total = 0, passed = 0, failed = 0, skipped = 0;

    for (const cat of categories) {
      const result = await this.runCategory(cat);
      categoryResults[cat] = result;
      total += result.total;
      passed += result.passed;
      failed += result.failed;
      skipped += result.skipped;
    }

    const suite: SuiteResult = {
      total, passed, failed, skipped,
      categories: categoryResults,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
    };

    this.lastResult = suite;
    return suite;
  }

  /**
   * Get last run results.
   */
  getLastResult(): SuiteResult | null {
    return this.lastResult;
  }

  /**
   * Save results to e2e/results/ for graph re-ingestion.
   */
  saveResults(results: SuiteResult): void {
    if (!existsSync(this.resultsDir)) {
      mkdirSync(this.resultsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = join(this.resultsDir, `suite-${timestamp}.json`);
    writeFileSync(filePath, JSON.stringify(results, null, 2));
    console.log(`[scenario-runner] Results saved to ${filePath}`);
  }

  // ---------------------------------------------------------------------------
  // Private — Execution
  // ---------------------------------------------------------------------------

  private async executeScenario(node: GraphNode): Promise<ScenarioResult> {
    const startedAt = new Date().toISOString();
    const start = Date.now();

    // Skip non-automatable
    if (node.automatable !== 'true' && node.automatable !== true) {
      return {
        scenarioId: node._name,
        scenarioName: node._name,
        status: 'skip',
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        steps: [{ name: 'skip', status: 'skip', output: 'Not automatable' }],
        validates: node.validates as string | undefined,
      };
    }

    // Regression API tests (have method + path fields)
    if (node.method && node.path) {
      return this.executeApiTest(node, startedAt, start);
    }

    // E2E tests — execute steps if they're API calls
    if (node.steps && Array.isArray(node.steps)) {
      return this.executeStepBasedTest(node, startedAt, start);
    }

    // No executable format
    return {
      scenarioId: node._name,
      scenarioName: node._name,
      status: 'skip',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      steps: [{ name: 'skip', status: 'skip', output: 'No executable test format' }],
      validates: node.validates as string | undefined,
    };
  }

  /**
   * Execute a regression API test (has method, path, expectedStatus).
   */
  private async executeApiTest(node: GraphNode, startedAt: string, start: number): Promise<ScenarioResult> {
    const method = node.method as string;
    const path = node.path as string;
    const expectedStatus = node.expectedStatus as number;
    const expectedFields = node.expectedFields as string[] | undefined;
    const authRequired = node.authRequired !== false && node.authRequired !== 'false';

    try {
      const url = `${this.apiBaseUrl}${path}`;
      const headers: Record<string, string> = {};
      if (authRequired) {
        headers['Authorization'] = `Bearer ${this.apiToken}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PER_SCENARIO_TIMEOUT_MS);

      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const steps: StepResult[] = [];

      // Check status code
      const statusPass = response.status === expectedStatus;
      steps.push({
        name: `${method} ${path} → ${response.status}`,
        status: statusPass ? 'pass' : 'fail',
        output: statusPass
          ? `Expected ${expectedStatus}, got ${response.status}`
          : `FAILED: expected ${expectedStatus}, got ${response.status}`,
      });

      // Check expected fields in response body
      if (statusPass && expectedFields && response.ok) {
        try {
          const body = await response.json() as Record<string, unknown>;
          for (const field of expectedFields) {
            const exists = field in body;
            steps.push({
              name: `field "${field}" exists`,
              status: exists ? 'pass' : 'fail',
              output: exists ? 'present' : `MISSING: "${field}" not in response`,
            });
          }
        } catch {
          steps.push({ name: 'parse JSON', status: 'fail', output: 'Response is not valid JSON' });
        }
      }

      const allPass = steps.every(s => s.status === 'pass');
      return {
        scenarioId: node._name,
        scenarioName: node._name,
        status: allPass ? 'pass' : 'fail',
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
        steps,
        validates: node.validates as string | undefined,
      };
    } catch (err: any) {
      return {
        scenarioId: node._name,
        scenarioName: node._name,
        status: 'error',
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - start,
        steps: [{ name: 'execute', status: 'fail', output: err.message?.slice(0, 300) }],
        error: err.message?.slice(0, 500),
        validates: node.validates as string | undefined,
      };
    }
  }

  /**
   * Execute a step-based E2E test. Steps that start with "GET" or "POST"
   * are interpreted as API calls. Others are skipped.
   */
  private async executeStepBasedTest(node: GraphNode, startedAt: string, start: number): Promise<ScenarioResult> {
    const steps: StepResult[] = [];
    let allPass = true;

    for (const step of (node.steps as string[])) {
      const stepStart = Date.now();

      // Try to extract API call from step description
      const apiMatch = step.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(\S+)(?:.*?(?:→|->)\s*(\d{3}))?/i);
      if (apiMatch) {
        const method = apiMatch[1].toUpperCase();
        let path = apiMatch[2];

        // Normalize path
        if (!path.startsWith('/') && !path.startsWith('http')) {
          path = '/v1/' + path;
        }
        if (path.startsWith('/') && !path.startsWith('/v1/')) {
          // Already has /v1/ or is a full path
        }

        try {
          const url = path.startsWith('http') ? path : `${this.apiBaseUrl}${path}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), PER_SCENARIO_TIMEOUT_MS);

          const response = await fetch(url, {
            method,
            headers: { 'Authorization': `Bearer ${this.apiToken}` },
            signal: controller.signal,
          });
          clearTimeout(timeout);

          const expectedStatus = apiMatch[3] ? parseInt(apiMatch[3], 10) : null;
          const pass = expectedStatus ? response.status === expectedStatus : (response.ok || response.status < 500);
          steps.push({
            name: step.slice(0, 80),
            status: pass ? 'pass' : 'fail',
            output: expectedStatus
              ? `${response.status} ${response.statusText} (expected ${expectedStatus})`
              : `${response.status} ${response.statusText}`,
            durationMs: Date.now() - stepStart,
          });
          if (!pass) allPass = false;
        } catch (err: any) {
          steps.push({
            name: step.slice(0, 80),
            status: 'fail',
            output: err.message?.slice(0, 200),
            durationMs: Date.now() - stepStart,
          });
          allPass = false;
        }
      } else {
        // Non-API step — skip
        steps.push({
          name: step.slice(0, 80),
          status: 'skip',
          output: 'Step requires manual execution',
        });
      }
    }

    return {
      scenarioId: node._name,
      scenarioName: node._name,
      status: allPass ? 'pass' : (steps.some(s => s.status === 'fail') ? 'fail' : 'skip'),
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      steps,
      validates: node.validates as string | undefined,
    };
  }
}
