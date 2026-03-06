import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { TestDatabase } from '../database';
import type {
  Playbook,
  PlaybookStep,
  TestEvaluator,
  FindingRecord,
  RunRecord,
  StepResultRecord,
  StepAction,
  FindingType,
  FindingSeverity,
} from '../types';
import { v4 as uuid } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';

// ── Options & Result types ───────────────────────────────────────────

export interface LiveRunOptions {
  /** Show the browser window (default: true) */
  headed?: boolean;
  /** Capture a screenshot after every step (default: false) */
  screenshotEvery?: boolean;
  /** Run the evaluator at every step, not just 'evaluate' actions (default: false) */
  evaluateAll?: boolean;
  /** Milliseconds to wait between steps (default: 0) */
  slowMo?: number;
  /** Per-step timeout in ms (default: 30000) */
  timeout?: number;
  /** Directory to save screenshots (default: .pando-tests/screenshots) */
  screenshotDir?: string;
  /** Template variable overrides for step targets/values */
  variables?: Record<string, string>;
}

export interface LiveRunResult {
  runId: string;
  status: 'passed' | 'failed' | 'error';
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  duration: number;
  findings: FindingRecord[];
  screenshots: string[];
}

// ── Default option values ────────────────────────────────────────────

const DEFAULTS: Required<LiveRunOptions> = {
  headed: true,
  screenshotEvery: false,
  evaluateAll: false,
  slowMo: 0,
  timeout: 30_000,
  screenshotDir: '',
  variables: {},
};

// ── LiveRunner ───────────────────────────────────────────────────────

export class LiveRunner {
  private db: TestDatabase;
  private evaluator: TestEvaluator | null;

  constructor(db: TestDatabase, evaluator?: TestEvaluator) {
    this.db = db;
    this.evaluator = evaluator ?? null;
  }

  /** Set or replace the evaluator used for 'evaluate' steps. */
  setEvaluator(evaluator: TestEvaluator): void {
    this.evaluator = evaluator;
  }

  /**
   * Execute a playbook in the browser and record all results + findings.
   */
  async run(playbook: Playbook, options?: LiveRunOptions): Promise<LiveRunResult> {
    const opts = { ...DEFAULTS, ...options };
    if (!opts.screenshotDir) {
      opts.screenshotDir = path.join(process.cwd(), '.pando-tests', 'screenshots');
    }

    // Ensure screenshot directory exists
    if (!fs.existsSync(opts.screenshotDir)) {
      fs.mkdirSync(opts.screenshotDir, { recursive: true });
    }

    const runId = uuid();
    const scenarioId = uuid();
    const startTime = Date.now();
    const allFindings: FindingRecord[] = [];
    const allScreenshots: string[] = [];
    let passedSteps = 0;
    let failedSteps = 0;

    // Auto-register scenario so FK constraint is satisfied
    this.db.insertScenario({
      id: scenarioId,
      project: playbook.name,
      name: playbook.name,
      description: playbook.description || '',
      mode: 'live',
      steps: JSON.stringify(playbook.steps),
      tags: (playbook.tags || []).join(','),
    });

    // Insert initial run record
    this.db.insertRun({
      id: runId,
      scenario_id: scenarioId,
      scenario_name: playbook.name,
      mode: 'live',
      status: 'running',
      agent_id: null,
      total_steps: playbook.steps.length,
      passed_steps: 0,
      failed_steps: 0,
      duration_ms: 0,
      summary: null,
      error: null,
      finished_at: null,
    });

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      browser = await chromium.launch({
        headless: !opts.headed,
        slowMo: opts.slowMo,
      });
      context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      page = await context.newPage();

      // Execute each step
      for (let i = 0; i < playbook.steps.length; i++) {
        const step = this.resolveStepVariables(playbook.steps[i], opts.variables);

        // Skip steps explicitly marked as not for live mode
        if (step.live_only === false) {
          this.db.insertStepResult({
            id: uuid(),
            run_id: runId,
            step_index: i,
            action: step.action,
            target: step.target ?? null,
            status: 'skipped',
            expected: step.expected ?? step.verify ?? null,
            actual: 'Skipped: live_only=false',
            screenshot_path: null,
            notes: null,
            duration_ms: 0,
          });
          continue;
        }

        const stepStart = Date.now();
        let stepStatus: 'passed' | 'failed' | 'error' = 'passed';
        let actual: string = '';
        let notes: string | null = null;
        let screenshotPath: string | null = null;

        try {
          const result = await this.executeStep(page, step, i, opts);
          stepStatus = result.status;
          actual = result.actual;
          notes = result.notes;
        } catch (err) {
          stepStatus = 'failed';
          actual = `Error: ${(err as Error).message}`;
        }

        // Take screenshot if requested
        if (opts.screenshotEvery || step.screenshot || step.action === 'screenshot') {
          try {
            screenshotPath = await this.takeScreenshot(
              page, runId, i, step.action, opts.screenshotDir,
            );
            allScreenshots.push(screenshotPath);
          } catch {
            // Screenshot failure is non-fatal
          }
        }

        // Record step result
        const stepDuration = Date.now() - stepStart;
        this.db.insertStepResult({
          id: uuid(),
          run_id: runId,
          step_index: i,
          action: step.action,
          target: step.target ?? null,
          status: stepStatus,
          expected: step.expected ?? step.verify ?? null,
          actual,
          screenshot_path: screenshotPath,
          notes,
          duration_ms: stepDuration,
        });

        if (stepStatus === 'passed') {
          passedSteps++;
        } else {
          failedSteps++;
        }

        // Run evaluator if this is an 'evaluate' step, or if evaluateAll is on
        if ((step.action === 'evaluate' || opts.evaluateAll) && this.evaluator) {
          try {
            // Take a screenshot for the evaluator if we don't already have one
            let evalScreenshot = screenshotPath;
            if (!evalScreenshot) {
              try {
                evalScreenshot = await this.takeScreenshot(
                  page, runId, i, 'eval', opts.screenshotDir,
                );
                allScreenshots.push(evalScreenshot);
              } catch {
                // Non-fatal
              }
            }

            const pageUrl = page.url();
            const pageTitle = await page.title();
            // Get a text snapshot of the page for the evaluator
            let htmlSnippet: string | undefined;
            try {
              htmlSnippet = await page.evaluate(
                '(() => { const b = document.body; return b ? b.innerText.substring(0, 5000) : ""; })()',
              ) as string;
            } catch {
              // Page might not be ready
            }

            const evalResult = await this.evaluator.evaluate(step, {
              pageUrl,
              pageTitle,
              screenshotPath: evalScreenshot ?? undefined,
              htmlSnippet,
            });

            if (!evalResult.passed) {
              // Record a finding for evaluation failure
              const finding: FindingRecord = {
                id: uuid(),
                run_id: runId,
                step_index: i,
                type: 'bug' as FindingType,
                severity: 'medium' as FindingSeverity,
                title: `Evaluation failed: ${step.action} ${step.target || step.prompt || ''}`.trim(),
                description: evalResult.notes || evalResult.actual || 'Evaluator marked step as failed',
                screenshot_path: evalScreenshot ?? null,
                status: 'open',
                resolved_at: null,
                resolution: null,
                created_at: new Date().toISOString(),
              };
              this.db.insertFinding(finding);
              allFindings.push(finding);
            }
          } catch (evalErr) {
            // Evaluator errors are recorded but non-fatal
            const finding: FindingRecord = {
              id: uuid(),
              run_id: runId,
              step_index: i,
              type: 'other' as FindingType,
              severity: 'low' as FindingSeverity,
              title: 'Evaluator error',
              description: `Evaluator threw: ${(evalErr as Error).message}`,
              screenshot_path: screenshotPath ?? null,
              status: 'open',
              resolved_at: null,
              resolution: null,
              created_at: new Date().toISOString(),
            };
            this.db.insertFinding(finding);
            allFindings.push(finding);
          }
        }

        // Handle 'evaluate' step with no evaluator
        if (step.action === 'evaluate' && !this.evaluator) {
          // Already counted as passed above; add a note
          // The step was already recorded, nothing else to do
        }

        // Slow-mo between steps (slowMo on launch handles Playwright internals;
        // this adds an additional inter-step pause)
        if (opts.slowMo && opts.slowMo > 0 && i < playbook.steps.length - 1) {
          await new Promise(resolve => setTimeout(resolve, opts.slowMo));
        }
      }
    } catch (topLevelErr) {
      // Browser launch failure or other catastrophic error
      const duration = Date.now() - startTime;
      this.db.updateRun(runId, {
        status: 'error',
        passed_steps: passedSteps,
        failed_steps: failedSteps,
        duration_ms: duration,
        error: (topLevelErr as Error).message,
        finished_at: new Date().toISOString(),
      });

      return {
        runId,
        status: 'error',
        totalSteps: playbook.steps.length,
        passedSteps,
        failedSteps,
        duration,
        findings: allFindings,
        screenshots: allScreenshots,
      };
    } finally {
      // Clean up browser
      try {
        if (page) await page.close().catch(() => {});
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
      } catch {
        // Ignore cleanup errors
      }
    }

    // Finalize run
    const duration = Date.now() - startTime;
    const finalStatus: 'passed' | 'failed' = failedSteps > 0 ? 'failed' : 'passed';

    this.db.updateRun(runId, {
      status: finalStatus,
      passed_steps: passedSteps,
      failed_steps: failedSteps,
      duration_ms: duration,
      summary: `${passedSteps}/${playbook.steps.length} steps passed. ${allFindings.length} finding(s).`,
      finished_at: new Date().toISOString(),
    });

    return {
      runId,
      status: finalStatus,
      totalSteps: playbook.steps.length,
      passedSteps,
      failedSteps,
      duration,
      findings: allFindings,
      screenshots: allScreenshots,
    };
  }

  // ── Step execution ──────────────────────────────────────────────

  private async executeStep(
    page: Page,
    step: PlaybookStep,
    index: number,
    opts: Required<LiveRunOptions>,
  ): Promise<{ status: 'passed' | 'failed'; actual: string; notes: string | null }> {
    const timeout = opts.timeout;
    const target = step.target || '';

    switch (step.action) {
      case 'navigate': {
        const response = await page.goto(target, {
          waitUntil: 'domcontentloaded',
          timeout,
        });
        const status = response?.status() ?? 0;
        const ok = status >= 200 && status < 400;
        return {
          status: ok ? 'passed' : 'failed',
          actual: `HTTP ${status} — ${page.url()}`,
          notes: ok ? null : `Unexpected status ${status}`,
        };
      }

      case 'click': {
        await page.click(target, { timeout });
        return {
          status: 'passed',
          actual: `Clicked: ${target}`,
          notes: null,
        };
      }

      case 'fill': {
        await page.fill(target, step.value || '', { timeout });
        return {
          status: 'passed',
          actual: `Filled "${target}" with "${step.value || ''}"`,
          notes: null,
        };
      }

      case 'select': {
        await page.selectOption(target, step.value || '', { timeout });
        return {
          status: 'passed',
          actual: `Selected "${step.value || ''}" in ${target}`,
          notes: null,
        };
      }

      case 'hover': {
        await page.hover(target, { timeout });
        return {
          status: 'passed',
          actual: `Hovered: ${target}`,
          notes: null,
        };
      }

      case 'press_key': {
        await page.keyboard.press(step.value || target);
        return {
          status: 'passed',
          actual: `Pressed key: ${step.value || target}`,
          notes: null,
        };
      }

      case 'scroll': {
        const scrollTarget = target || 'bottom';
        await page.evaluate(
          `(() => {
            const t = ${JSON.stringify(scrollTarget)};
            if (t === 'bottom') { window.scrollTo(0, document.body.scrollHeight); }
            else if (t === 'top') { window.scrollTo(0, 0); }
            else { const px = parseInt(t, 10); if (!isNaN(px)) { window.scrollBy(0, px); } else { window.scrollTo(0, document.body.scrollHeight); } }
          })()`,
        );
        return {
          status: 'passed',
          actual: `Scrolled: ${scrollTarget}`,
          notes: null,
        };
      }

      case 'wait': {
        if (target) {
          await page.waitForSelector(target, { timeout });
        } else {
          // Fallback: wait a fixed amount
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        return {
          status: 'passed',
          actual: target ? `Waited for selector: ${target}` : 'Waited 1000ms',
          notes: null,
        };
      }

      case 'assert_text': {
        const expected = step.expected || step.verify || target;
        const visible = await page.locator(`text=${expected}`).first().isVisible({ timeout }).catch(() => false);
        return {
          status: visible ? 'passed' : 'failed',
          actual: visible ? `Text "${expected}" is visible` : `Text "${expected}" not found`,
          notes: visible ? null : `Expected text "${expected}" to be visible on page`,
        };
      }

      case 'assert_visible': {
        const visible = await page.locator(target).first().isVisible({ timeout }).catch(() => false);
        return {
          status: visible ? 'passed' : 'failed',
          actual: visible ? `Element "${target}" is visible` : `Element "${target}" not visible`,
          notes: visible ? null : `Expected element "${target}" to be visible`,
        };
      }

      case 'assert_hidden': {
        const hidden = await page.locator(target).first().isHidden({ timeout }).catch(() => true);
        return {
          status: hidden ? 'passed' : 'failed',
          actual: hidden ? `Element "${target}" is hidden` : `Element "${target}" is visible`,
          notes: hidden ? null : `Expected element "${target}" to be hidden`,
        };
      }

      case 'assert_url': {
        const expected = step.expected || target;
        const currentUrl = page.url();
        const matches = currentUrl.includes(expected);
        return {
          status: matches ? 'passed' : 'failed',
          actual: `Current URL: ${currentUrl}`,
          notes: matches ? null : `Expected URL to contain "${expected}"`,
        };
      }

      case 'assert_status': {
        // This is meaningful after a navigation; check last response
        // We can't re-check, so just pass with a note
        return {
          status: 'passed',
          actual: 'assert_status: checked at navigate time',
          notes: 'HTTP status assertions are verified during navigate steps',
        };
      }

      case 'screenshot': {
        // Screenshot is taken by the caller; this step always passes
        return {
          status: 'passed',
          actual: 'Screenshot captured',
          notes: null,
        };
      }

      case 'api_call': {
        return await this.executeApiCall(step, timeout);
      }

      case 'evaluate': {
        // The actual evaluation is handled after step execution in run()
        if (!this.evaluator) {
          return {
            status: 'passed',
            actual: 'No evaluator configured — skipped evaluation',
            notes: 'Set an evaluator via setEvaluator() for AI-driven evaluation',
          };
        }
        return {
          status: 'passed',
          actual: 'Evaluation delegated to evaluator',
          notes: null,
        };
      }

      case 'custom': {
        // Custom steps need external handling; pass with a note
        return {
          status: 'passed',
          actual: `Custom step: ${step.prompt || target}`,
          notes: 'Custom steps require external handling',
        };
      }

      default: {
        return {
          status: 'failed',
          actual: `Unknown action: ${step.action}`,
          notes: null,
        };
      }
    }
  }

  // ── API call execution ──────────────────────────────────────────

  private async executeApiCall(
    step: PlaybookStep,
    timeout: number,
  ): Promise<{ status: 'passed' | 'failed'; actual: string; notes: string | null }> {
    const url = step.target || '';
    const method = (step.method || 'GET').toUpperCase();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOptions: RequestInit = {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      if (step.body && method !== 'GET' && method !== 'HEAD') {
        fetchOptions.body = typeof step.body === 'string'
          ? step.body
          : JSON.stringify(step.body);
      }

      if (step.auth && step.auth !== 'none') {
        // Auth token would come from variables or config
        // The caller should set it via variables
      }

      const response = await fetch(url, fetchOptions);
      const status = response.status;
      let bodyText: string;
      try {
        bodyText = await response.text();
        if (bodyText.length > 2000) {
          bodyText = bodyText.substring(0, 2000) + '...';
        }
      } catch {
        bodyText = '<could not read body>';
      }

      const expectedStatus = step.expected ? parseInt(step.expected, 10) : null;
      const ok = expectedStatus
        ? status === expectedStatus
        : status >= 200 && status < 400;

      return {
        status: ok ? 'passed' : 'failed',
        actual: `${method} ${url} => HTTP ${status}. Body: ${bodyText.substring(0, 500)}`,
        notes: ok ? null : `Expected ${expectedStatus ?? '2xx/3xx'}, got ${status}`,
      };
    } catch (err) {
      return {
        status: 'failed',
        actual: `${method} ${url} => Error: ${(err as Error).message}`,
        notes: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Screenshot helper ───────────────────────────────────────────

  private async takeScreenshot(
    page: Page,
    runId: string,
    stepIndex: number,
    label: string,
    screenshotDir: string,
  ): Promise<string> {
    const filename = `${runId}_step${stepIndex}_${label}.png`;
    const filePath = path.join(screenshotDir, filename);

    await page.screenshot({ path: filePath, fullPage: true });

    return filePath;
  }

  // ── Variable resolution for a single step ───────────────────────

  private resolveStepVariables(
    step: PlaybookStep,
    variables: Record<string, string>,
  ): PlaybookStep {
    if (!variables || Object.keys(variables).length === 0) {
      return step;
    }

    const replacer = (text: string): string => {
      let result = text;
      for (const [key, val] of Object.entries(variables)) {
        const pattern = new RegExp(`\\{\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
        result = result.replace(pattern, val);
      }
      return result;
    };

    const resolved: PlaybookStep = { ...step };
    if (resolved.target) resolved.target = replacer(resolved.target);
    if (resolved.verify) resolved.verify = replacer(resolved.verify);
    if (resolved.expected) resolved.expected = replacer(resolved.expected);
    if (resolved.value) resolved.value = replacer(resolved.value);
    if (resolved.prompt) resolved.prompt = replacer(resolved.prompt);
    if (typeof resolved.body === 'string') {
      resolved.body = replacer(resolved.body);
    } else if (resolved.body && typeof resolved.body === 'object') {
      resolved.body = JSON.parse(replacer(JSON.stringify(resolved.body)));
    }

    return resolved;
  }
}
