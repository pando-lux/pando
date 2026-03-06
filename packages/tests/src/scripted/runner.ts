import { spawn } from 'child_process';
import { TestDatabase } from '../database';
import type { RunRecord, StepResultRecord } from '../types';
import { v4 as uuid } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';

// ── Options & Result Types ─────────────────────────────────────────

export interface ScriptedRunOptions {
  /** Specific spec file to run (default: all in testDir) */
  specFile?: string;
  /** Filter by tags (grep pattern) */
  tags?: string[];
  /** Show browser (default: true) */
  headed?: boolean;
  /** Where spec files live */
  testDir?: string;
  /** Per-test timeout in ms */
  timeout?: number;
  /** Playwright reporter (in addition to JSON, which is always used) */
  reporter?: string;
  /** Playwright config file path */
  configFile?: string;
  /** Playwright project name */
  project?: string;
}

export interface ScriptedRunResult {
  runId: string;
  status: 'passed' | 'failed' | 'error';
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failures: Array<{ title: string; error: string }>;
}

// ── Internal Parsed Types ──────────────────────────────────────────

interface ParsedTestResult {
  title: string;
  suitePath: string[];
  status: 'passed' | 'failed' | 'skipped' | 'timedOut' | 'interrupted';
  duration: number;
  error: string | null;
}

interface ParsedResult {
  tests: ParsedTestResult[];
  totalDuration: number;
}

interface PlaywrightJsonSuite {
  title?: string;
  suites?: PlaywrightJsonSuite[];
  specs?: PlaywrightJsonSpec[];
}

interface PlaywrightJsonSpec {
  title?: string;
  tests?: PlaywrightJsonTest[];
}

interface PlaywrightJsonTest {
  results?: PlaywrightJsonTestResult[];
}

interface PlaywrightJsonTestResult {
  status?: string;
  duration?: number;
  error?: { message?: string; snippet?: string };
}

interface PlaywrightJsonReport {
  suites?: PlaywrightJsonSuite[];
  stats?: {
    duration?: number;
  };
}

// ── ScriptedRunner ─────────────────────────────────────────────────

export class ScriptedRunner {
  private db: TestDatabase;

  constructor(db: TestDatabase) {
    this.db = db;
  }

  /**
   * Run Playwright tests and record results to the database.
   */
  async run(options?: ScriptedRunOptions): Promise<ScriptedRunResult> {
    const runId = uuid();
    const scenarioName = options?.specFile
      ? path.basename(options.specFile, path.extname(options.specFile))
      : 'all-specs';
    const scenarioId = this.ensureScenario(scenarioName);
    const startTime = Date.now();

    // Create run record (status: running)
    this.db.insertRun({
      id: runId,
      scenario_id: scenarioId,
      scenario_name: scenarioName,
      mode: 'scripted',
      status: 'running',
      agent_id: null,
      total_steps: 0,
      passed_steps: 0,
      failed_steps: 0,
      duration_ms: 0,
      summary: null,
      error: null,
      finished_at: null,
    });

    try {
      const { stdout, stderr, exitCode } = await this.spawnPlaywright(options);
      const parsed = this.parsePlaywrightJson(stdout);
      const duration = Date.now() - startTime;

      // Record individual test results as step_results
      let passedCount = 0;
      let failedCount = 0;
      let skippedCount = 0;

      for (let i = 0; i < parsed.tests.length; i++) {
        const t = parsed.tests[i];
        const stepStatus = this.mapStatus(t.status);

        if (stepStatus === 'passed') passedCount++;
        else if (stepStatus === 'failed' || stepStatus === 'error') failedCount++;
        else if (stepStatus === 'skipped') skippedCount++;

        const stepResult: StepResultRecord = {
          id: uuid(),
          run_id: runId,
          step_index: i,
          action: 'custom',
          target: t.suitePath.length > 0
            ? `${t.suitePath.join(' > ')} > ${t.title}`
            : t.title,
          status: stepStatus,
          expected: 'pass',
          actual: t.status,
          screenshot_path: null,
          notes: t.error,
          duration_ms: t.duration,
        };
        this.db.insertStepResult(stepResult);
      }

      const totalCount = parsed.tests.length;
      const runStatus = failedCount > 0 ? 'failed' : 'passed';
      const failures = parsed.tests
        .filter(t => t.status === 'failed' || t.status === 'timedOut')
        .map(t => ({ title: t.title, error: t.error ?? 'Unknown error' }));

      const summary = `${passedCount}/${totalCount} passed, ${failedCount} failed, ${skippedCount} skipped`;

      // Update run record
      this.db.updateRun(runId, {
        status: runStatus,
        passed_steps: passedCount,
        failed_steps: failedCount,
        duration_ms: duration,
        summary,
        error: failures.length > 0
          ? failures.map(f => `${f.title}: ${f.error}`).join('\n')
          : null,
        finished_at: new Date().toISOString(),
      });

      return {
        runId,
        status: runStatus,
        total: totalCount,
        passed: passedCount,
        failed: failedCount,
        skipped: skippedCount,
        duration,
        failures,
      };
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const errorMsg = err?.message ?? String(err);

      this.db.updateRun(runId, {
        status: 'error',
        duration_ms: duration,
        summary: 'Runner error — could not execute Playwright',
        error: errorMsg,
        finished_at: new Date().toISOString(),
      });

      return {
        runId,
        status: 'error',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration,
        failures: [{ title: 'ScriptedRunner', error: errorMsg }],
      };
    }
  }

  /**
   * Run all specs (convenience wrapper).
   */
  async runAll(options?: Omit<ScriptedRunOptions, 'specFile' | 'tags'>): Promise<ScriptedRunResult> {
    return this.run(options);
  }

  /**
   * Parse Playwright's JSON reporter output into a flat list of test results.
   *
   * The JSON reporter outputs nested suites. This method walks the tree
   * recursively, collecting every spec result into a flat array.
   */
  parsePlaywrightJson(jsonStr: string): ParsedResult {
    let report: PlaywrightJsonReport;
    try {
      // Playwright may output non-JSON lines before the JSON blob.
      // Find the first '{' and last '}' to extract the JSON.
      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace === -1 || lastBrace === -1) {
        return { tests: [], totalDuration: 0 };
      }
      report = JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1));
    } catch {
      return { tests: [], totalDuration: 0 };
    }

    const tests: ParsedTestResult[] = [];
    const walkSuites = (suites: PlaywrightJsonSuite[], parentPath: string[]): void => {
      for (const suite of suites) {
        const currentPath = suite.title
          ? [...parentPath, suite.title]
          : parentPath;

        // Walk nested suites
        if (suite.suites && suite.suites.length > 0) {
          walkSuites(suite.suites, currentPath);
        }

        // Walk specs
        if (suite.specs) {
          for (const spec of suite.specs) {
            const specTitle = spec.title ?? 'Untitled';
            if (spec.tests) {
              for (const test of spec.tests) {
                // Use the last result (retries produce multiple results)
                const results = test.results ?? [];
                const lastResult = results[results.length - 1];
                if (lastResult) {
                  const status = lastResult.status as ParsedTestResult['status'] ?? 'skipped';
                  const errorMsg = lastResult.error?.message ?? lastResult.error?.snippet ?? null;
                  tests.push({
                    title: specTitle,
                    suitePath: currentPath,
                    status,
                    duration: lastResult.duration ?? 0,
                    error: errorMsg,
                  });
                }
              }
            }
          }
        }
      }
    };

    if (report.suites) {
      walkSuites(report.suites, []);
    }

    const totalDuration = report.stats?.duration ?? tests.reduce((s, t) => s + t.duration, 0);
    return { tests, totalDuration };
  }

  // ── Private Helpers ────────────────────────────────────────────

  /**
   * Spawn the Playwright test process and capture output.
   */
  private spawnPlaywright(
    options?: ScriptedRunOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const args: string[] = ['playwright', 'test'];

      // Config file
      if (options?.configFile) {
        args.push('--config', options.configFile);
      }

      // Always use JSON reporter for parsing
      args.push('--reporter=json');

      // Specific spec file
      if (options?.specFile) {
        args.push(options.specFile);
      }

      // Test directory
      if (options?.testDir) {
        args.push('--test-dir', options.testDir);
      }

      // Tag filter via grep
      if (options?.tags && options.tags.length > 0) {
        args.push('--grep', options.tags.join('|'));
      }

      // Headed / headless
      if (options?.headed === false) {
        // Playwright defaults to headless; only add --headed if explicitly true
      } else {
        // Default: headed = true
        args.push('--headed');
      }

      // Timeout
      if (options?.timeout) {
        args.push('--timeout', String(options.timeout));
      }

      // Project
      if (options?.project) {
        args.push('--project', options.project);
      }

      let stdout = '';
      let stderr = '';

      const proc = spawn('npx', args, {
        cwd: process.cwd(),
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Force color off for clean JSON output
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
      });

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn Playwright: ${err.message}`));
      });

      proc.on('close', (code) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
        });
      });
    });
  }

  /**
   * Map Playwright test status to our StepResultRecord status.
   */
  private mapStatus(pwStatus: string): StepResultRecord['status'] {
    switch (pwStatus) {
      case 'passed':
        return 'passed';
      case 'failed':
      case 'timedOut':
        return 'failed';
      case 'skipped':
        return 'skipped';
      case 'interrupted':
        return 'error';
      default:
        return 'error';
    }
  }

  /**
   * Ensure a scenario record exists for the given name, returning its ID.
   * Creates one if it doesn't exist.
   */
  private ensureScenario(name: string): string {
    // Check if a scenario with this name already exists
    const all = this.db.listScenarios();
    const existing = all.find(s => s.name === name && s.mode === 'scripted');
    if (existing) return existing.id;

    // Create a new scenario
    const id = uuid();
    this.db.insertScenario({
      id,
      project: 'default',
      name,
      description: `Auto-created scenario for Playwright spec: ${name}`,
      mode: 'scripted',
      steps: '[]',
      tags: 'auto,scripted',
    });
    return id;
  }
}
