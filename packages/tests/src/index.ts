import { v4 as uuidv4 } from 'uuid';
import { TestDatabase } from './database';
import { initProject, loadConfig } from './config';
import type {
  ProjectConfig,
  Playbook,
  ScenarioRecord,
  RunRecord,
  FindingRecord,
  RunStatsRecord,
  DashboardOverview,
  FindingStatus,
  FindingSeverity,
  TestMode,
} from './types';
import * as path from 'path';
import * as fs from 'fs';

export class PandoTester {
  public readonly config: ProjectConfig;
  private db: TestDatabase;

  constructor(config: ProjectConfig) {
    this.config = config;

    // Initialize project directory if it doesn't exist
    const testsDir = path.join(config.rootDir, '.pando-tests');
    if (!fs.existsSync(testsDir)) {
      initProject(config.rootDir, {
        project: config.project,
        gatewayUrl: config.gatewayUrl,
        apiUrl: config.apiUrl,
        authToken: config.authToken,
      });
    }

    const dbPath = path.join(testsDir, 'results.db');
    this.db = new TestDatabase(dbPath);
  }

  // ── Scripted Runner (stub) ────────────────────────────────────

  /**
   * Run a playbook in scripted mode (Playwright automation).
   * Phase 2 implementation.
   */
  async scripted(_playbook: Playbook): Promise<RunRecord> {
    throw new Error('Not yet implemented: scripted runner (Phase 2)');
  }

  // ── Live Runner (stub) ────────────────────────────────────────

  /**
   * Run a playbook in live/agent mode (AI-driven exploration).
   * Phase 3 implementation.
   */
  async live(_playbook: Playbook): Promise<RunRecord> {
    throw new Error('Not yet implemented: live runner (Phase 3)');
  }

  // ── Scenarios ─────────────────────────────────────────────────

  scenarios = {
    /**
     * List all registered scenarios, optionally filtered by project.
     */
    list: (project?: string): ScenarioRecord[] => {
      return this.db.listScenarios(project ?? this.config.project);
    },

    /**
     * Get a single scenario by ID.
     */
    get: (id: string): ScenarioRecord | undefined => {
      return this.db.getScenario(id);
    },

    /**
     * Register a new scenario from a playbook.
     */
    register: (playbook: Playbook): ScenarioRecord => {
      const id = uuidv4();
      const record: Omit<ScenarioRecord, 'created_at' | 'updated_at'> = {
        id,
        project: this.config.project,
        name: playbook.name,
        description: playbook.description,
        mode: playbook.mode,
        steps: JSON.stringify(playbook.steps),
        tags: playbook.tags.join(','),
      };
      this.db.insertScenario(record);
      return this.db.getScenario(id)!;
    },

    /**
     * Import a playbook JSON file and register it as a scenario.
     */
    import: (playbookPath: string): ScenarioRecord => {
      const raw = fs.readFileSync(playbookPath, 'utf-8');
      const playbook = JSON.parse(raw) as Playbook;
      return this.scenarios.register(playbook);
    },

    /**
     * Delete a scenario by ID.
     */
    delete: (id: string): void => {
      this.db.deleteScenario(id);
    },
  };

  // ── History ───────────────────────────────────────────────────

  history = {
    /**
     * Get recent test runs, optionally filtered.
     */
    getRuns: (filters?: { scenarioId?: string; mode?: TestMode; limit?: number }): RunRecord[] => {
      return this.db.listRuns(filters);
    },

    /**
     * Get aggregated stats for a date range.
     */
    getStats: (from: string, to: string): RunStatsRecord[] => {
      return this.db.getStats(this.config.project, from, to);
    },

    /**
     * Get trend data for the last N days.
     */
    getTrend: (days?: number): RunStatsRecord[] => {
      return this.db.getTrend(this.config.project, days ?? 14);
    },
  };

  // ── Findings ──────────────────────────────────────────────────

  findings = {
    /**
     * List findings with optional filters.
     */
    list: (filters?: { status?: FindingStatus; severity?: FindingSeverity; runId?: string }): FindingRecord[] => {
      return this.db.listFindings(filters);
    },

    /**
     * Acknowledge a finding (mark as seen).
     */
    acknowledge: (id: string): void => {
      this.db.acknowledgeFinding(id);
    },

    /**
     * Resolve a finding with a resolution note.
     */
    resolve: (id: string, resolution: string): void => {
      this.db.resolveFinding(id, resolution);
    },

    /**
     * Get all findings for a specific test run.
     */
    getByRun: (runId: string): FindingRecord[] => {
      return this.db.listFindings({ runId });
    },
  };

  // ── Dashboard ─────────────────────────────────────────────────

  dashboard = {
    /**
     * Get a high-level overview for the dashboard.
     */
    overview: (): DashboardOverview => {
      const scenarios = this.db.listScenarios(this.config.project);
      const runs = this.db.listRuns({ limit: 1 });
      const allRuns = this.db.listRuns({ limit: 1000 });
      const openFindings = this.db.listFindings({ status: 'open' });
      const criticalFindings = openFindings.filter(f => f.severity === 'critical');
      const trend = this.db.getTrend(this.config.project, 14);

      const passedRuns = allRuns.filter(r => r.status === 'passed').length;
      const passRate = allRuns.length > 0 ? passedRuns / allRuns.length : 0;

      return {
        project: this.config.project,
        total_scenarios: scenarios.length,
        total_runs: allRuns.length,
        last_run: runs[0] ?? null,
        pass_rate: Math.round(passRate * 10000) / 10000, // 4 decimal places
        open_findings: openFindings.length,
        critical_findings: criticalFindings.length,
        trend,
      };
    },
  };

  // ── Cleanup ───────────────────────────────────────────────────

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

// ── Re-exports ────────────────────────────────────────────────────

export { TestDatabase } from './database';
export { loadConfig, saveConfig, initProject, resolveVariables } from './config';
export type {
  ProjectConfig,
  PlaybookStep,
  Playbook,
  ScenarioRecord,
  RunRecord,
  StepResultRecord,
  FindingRecord,
  RunStatsRecord,
  DashboardOverview,
  TestEvaluator,
  StepAction,
  TestMode,
  RunStatus,
  FindingType,
  FindingSeverity,
  FindingStatus,
} from './types';
