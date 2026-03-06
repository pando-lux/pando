import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type {
  ScenarioRecord,
  RunRecord,
  StepResultRecord,
  FindingRecord,
  RunStatsRecord,
  TestMode,
  FindingStatus,
  FindingSeverity,
} from './types';

export class TestDatabase {
  private db: Database.Database;
  private stmts: ReturnType<TestDatabase['prepareStatements']>;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(process.cwd(), '.pando-tests', 'results.db');
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.createTables();
    this.stmts = this.prepareStatements();
  }

  // ── Schema ──────────────────────────────────────────────────────

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scenarios (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'scripted',
        steps TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL,
        scenario_name TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'scripted',
        status TEXT NOT NULL DEFAULT 'running',
        agent_id TEXT,
        total_steps INTEGER NOT NULL DEFAULT 0,
        passed_steps INTEGER NOT NULL DEFAULT 0,
        failed_steps INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        FOREIGN KEY (scenario_id) REFERENCES scenarios(id)
      );

      CREATE TABLE IF NOT EXISTS step_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        status TEXT NOT NULL DEFAULT 'passed',
        expected TEXT,
        actual TEXT,
        screenshot_path TEXT,
        notes TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );

      CREATE TABLE IF NOT EXISTS findings (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_index INTEGER,
        type TEXT NOT NULL DEFAULT 'bug',
        severity TEXT NOT NULL DEFAULT 'medium',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        screenshot_path TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        resolved_at TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );

      CREATE TABLE IF NOT EXISTS run_stats (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        date TEXT NOT NULL,
        scripted_runs INTEGER NOT NULL DEFAULT 0,
        scripted_passed INTEGER NOT NULL DEFAULT 0,
        scripted_failed INTEGER NOT NULL DEFAULT 0,
        live_runs INTEGER NOT NULL DEFAULT 0,
        live_passed INTEGER NOT NULL DEFAULT 0,
        live_failed INTEGER NOT NULL DEFAULT 0,
        findings_opened INTEGER NOT NULL DEFAULT 0,
        findings_resolved INTEGER NOT NULL DEFAULT 0,
        avg_duration_ms REAL NOT NULL DEFAULT 0,
        UNIQUE(project, date)
      );

      CREATE INDEX IF NOT EXISTS idx_runs_scenario ON runs(scenario_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_step_results_run ON step_results(run_id);
      CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
      CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
      CREATE INDEX IF NOT EXISTS idx_run_stats_project_date ON run_stats(project, date);
    `);
  }

  // ── Prepared Statements ─────────────────────────────────────────

  private prepareStatements() {
    return {
      // Scenarios
      insertScenario: this.db.prepare(`
        INSERT INTO scenarios (id, project, name, description, mode, steps, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `),
      getScenario: this.db.prepare(`SELECT * FROM scenarios WHERE id = ?`),
      listScenarios: this.db.prepare(`SELECT * FROM scenarios WHERE project = ? ORDER BY name`),
      listAllScenarios: this.db.prepare(`SELECT * FROM scenarios ORDER BY name`),
      updateScenario: this.db.prepare(`
        UPDATE scenarios SET name = ?, description = ?, mode = ?, steps = ?, tags = ?, updated_at = datetime('now')
        WHERE id = ?
      `),
      deleteScenario: this.db.prepare(`DELETE FROM scenarios WHERE id = ?`),

      // Runs
      insertRun: this.db.prepare(`
        INSERT INTO runs (id, scenario_id, scenario_name, mode, status, agent_id, total_steps, passed_steps, failed_steps, duration_ms, summary, error, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `),
      updateRun: this.db.prepare(`
        UPDATE runs SET status = ?, passed_steps = ?, failed_steps = ?, duration_ms = ?, summary = ?, error = ?, finished_at = ?
        WHERE id = ?
      `),
      getRun: this.db.prepare(`SELECT * FROM runs WHERE id = ?`),
      listRunsAll: this.db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`),
      listRunsByScenario: this.db.prepare(`SELECT * FROM runs WHERE scenario_id = ? ORDER BY started_at DESC LIMIT ?`),
      listRunsByMode: this.db.prepare(`SELECT * FROM runs WHERE mode = ? ORDER BY started_at DESC LIMIT ?`),
      listRunsByScenarioAndMode: this.db.prepare(`SELECT * FROM runs WHERE scenario_id = ? AND mode = ? ORDER BY started_at DESC LIMIT ?`),

      // Step Results
      insertStepResult: this.db.prepare(`
        INSERT INTO step_results (id, run_id, step_index, action, target, status, expected, actual, screenshot_path, notes, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getStepResults: this.db.prepare(`SELECT * FROM step_results WHERE run_id = ? ORDER BY step_index`),

      // Findings
      insertFinding: this.db.prepare(`
        INSERT INTO findings (id, run_id, step_index, type, severity, title, description, screenshot_path, status, resolved_at, resolution, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `),
      updateFinding: this.db.prepare(`
        UPDATE findings SET type = ?, severity = ?, title = ?, description = ?, screenshot_path = ?, status = ?, resolved_at = ?, resolution = ?
        WHERE id = ?
      `),
      getFinding: this.db.prepare(`SELECT * FROM findings WHERE id = ?`),
      listFindingsAll: this.db.prepare(`SELECT * FROM findings ORDER BY created_at DESC`),
      listFindingsByStatus: this.db.prepare(`SELECT * FROM findings WHERE status = ? ORDER BY created_at DESC`),
      listFindingsBySeverity: this.db.prepare(`SELECT * FROM findings WHERE severity = ? ORDER BY created_at DESC`),
      listFindingsByRun: this.db.prepare(`SELECT * FROM findings WHERE run_id = ? ORDER BY step_index`),
      listFindingsByStatusAndSeverity: this.db.prepare(`SELECT * FROM findings WHERE status = ? AND severity = ? ORDER BY created_at DESC`),
      resolveFinding: this.db.prepare(`
        UPDATE findings SET status = 'resolved', resolved_at = datetime('now'), resolution = ? WHERE id = ?
      `),
      acknowledgeFinding: this.db.prepare(`
        UPDATE findings SET status = 'acknowledged' WHERE id = ?
      `),

      // Run Stats
      upsertDayStats: this.db.prepare(`
        INSERT INTO run_stats (id, project, date, scripted_runs, scripted_passed, scripted_failed, live_runs, live_passed, live_failed, findings_opened, findings_resolved, avg_duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project, date) DO UPDATE SET
          scripted_runs = excluded.scripted_runs,
          scripted_passed = excluded.scripted_passed,
          scripted_failed = excluded.scripted_failed,
          live_runs = excluded.live_runs,
          live_passed = excluded.live_passed,
          live_failed = excluded.live_failed,
          findings_opened = excluded.findings_opened,
          findings_resolved = excluded.findings_resolved,
          avg_duration_ms = excluded.avg_duration_ms
      `),
      getStats: this.db.prepare(`
        SELECT * FROM run_stats WHERE project = ? AND date >= ? AND date <= ? ORDER BY date
      `),
      getTrend: this.db.prepare(`
        SELECT * FROM run_stats WHERE project = ? ORDER BY date DESC LIMIT ?
      `),
    };
  }

  // ── Scenarios ───────────────────────────────────────────────────

  insertScenario(scenario: Omit<ScenarioRecord, 'created_at' | 'updated_at'>): void {
    this.stmts.insertScenario.run(
      scenario.id,
      scenario.project,
      scenario.name,
      scenario.description,
      scenario.mode,
      scenario.steps,
      scenario.tags,
    );
  }

  getScenario(id: string): ScenarioRecord | undefined {
    return this.stmts.getScenario.get(id) as ScenarioRecord | undefined;
  }

  listScenarios(project?: string): ScenarioRecord[] {
    if (project) {
      return this.stmts.listScenarios.all(project) as ScenarioRecord[];
    }
    return this.stmts.listAllScenarios.all() as ScenarioRecord[];
  }

  updateScenario(id: string, updates: Partial<Pick<ScenarioRecord, 'name' | 'description' | 'mode' | 'steps' | 'tags'>>): void {
    const existing = this.getScenario(id);
    if (!existing) throw new Error(`Scenario ${id} not found`);
    this.stmts.updateScenario.run(
      updates.name ?? existing.name,
      updates.description ?? existing.description,
      updates.mode ?? existing.mode,
      updates.steps ?? existing.steps,
      updates.tags ?? existing.tags,
      id,
    );
  }

  deleteScenario(id: string): void {
    this.stmts.deleteScenario.run(id);
  }

  // ── Runs ────────────────────────────────────────────────────────

  insertRun(run: Omit<RunRecord, 'started_at'>): void {
    this.stmts.insertRun.run(
      run.id,
      run.scenario_id,
      run.scenario_name,
      run.mode,
      run.status,
      run.agent_id,
      run.total_steps,
      run.passed_steps,
      run.failed_steps,
      run.duration_ms,
      run.summary,
      run.error,
      run.finished_at,
    );
  }

  updateRun(id: string, updates: Partial<Pick<RunRecord, 'status' | 'total_steps' | 'passed_steps' | 'failed_steps' | 'duration_ms' | 'summary' | 'error' | 'finished_at'>>): void {
    const existing = this.getRun(id);
    if (!existing) throw new Error(`Run ${id} not found`);
    this.stmts.updateRun.run(
      updates.status ?? existing.status,
      updates.passed_steps ?? existing.passed_steps,
      updates.failed_steps ?? existing.failed_steps,
      updates.duration_ms ?? existing.duration_ms,
      updates.summary ?? existing.summary,
      updates.error ?? existing.error,
      updates.finished_at ?? existing.finished_at,
      id,
    );
    // Update total_steps separately if provided (not in the main UPDATE statement)
    if (updates.total_steps !== undefined) {
      this.db.prepare('UPDATE runs SET total_steps = ? WHERE id = ?').run(updates.total_steps, id);
    }
  }

  getRun(id: string): RunRecord | undefined {
    return this.stmts.getRun.get(id) as RunRecord | undefined;
  }

  listRuns(filters?: { scenarioId?: string; mode?: TestMode; limit?: number }): RunRecord[] {
    const limit = filters?.limit ?? 50;
    if (filters?.scenarioId && filters?.mode) {
      return this.stmts.listRunsByScenarioAndMode.all(filters.scenarioId, filters.mode, limit) as RunRecord[];
    }
    if (filters?.scenarioId) {
      return this.stmts.listRunsByScenario.all(filters.scenarioId, limit) as RunRecord[];
    }
    if (filters?.mode) {
      return this.stmts.listRunsByMode.all(filters.mode, limit) as RunRecord[];
    }
    return this.stmts.listRunsAll.all(limit) as RunRecord[];
  }

  // ── Step Results ────────────────────────────────────────────────

  insertStepResult(result: StepResultRecord): void {
    this.stmts.insertStepResult.run(
      result.id,
      result.run_id,
      result.step_index,
      result.action,
      result.target,
      result.status,
      result.expected,
      result.actual,
      result.screenshot_path,
      result.notes,
      result.duration_ms,
    );
  }

  getStepResults(runId: string): StepResultRecord[] {
    return this.stmts.getStepResults.all(runId) as StepResultRecord[];
  }

  // ── Findings ────────────────────────────────────────────────────

  insertFinding(finding: Omit<FindingRecord, 'created_at'>): void {
    this.stmts.insertFinding.run(
      finding.id,
      finding.run_id,
      finding.step_index,
      finding.type,
      finding.severity,
      finding.title,
      finding.description,
      finding.screenshot_path,
      finding.status,
      finding.resolved_at,
      finding.resolution,
    );
  }

  updateFinding(id: string, updates: Partial<Omit<FindingRecord, 'id' | 'run_id' | 'created_at'>>): void {
    const existing = this.getFinding(id);
    if (!existing) throw new Error(`Finding ${id} not found`);
    this.stmts.updateFinding.run(
      updates.type ?? existing.type,
      updates.severity ?? existing.severity,
      updates.title ?? existing.title,
      updates.description ?? existing.description,
      updates.screenshot_path ?? existing.screenshot_path,
      updates.status ?? existing.status,
      updates.resolved_at ?? existing.resolved_at,
      updates.resolution ?? existing.resolution,
      id,
    );
  }

  getFinding(id: string): FindingRecord | undefined {
    return this.stmts.getFinding.get(id) as FindingRecord | undefined;
  }

  listFindings(filters?: { status?: FindingStatus; severity?: FindingSeverity; runId?: string }): FindingRecord[] {
    if (filters?.runId) {
      return this.stmts.listFindingsByRun.all(filters.runId) as FindingRecord[];
    }
    if (filters?.status && filters?.severity) {
      return this.stmts.listFindingsByStatusAndSeverity.all(filters.status, filters.severity) as FindingRecord[];
    }
    if (filters?.status) {
      return this.stmts.listFindingsByStatus.all(filters.status) as FindingRecord[];
    }
    if (filters?.severity) {
      return this.stmts.listFindingsBySeverity.all(filters.severity) as FindingRecord[];
    }
    return this.stmts.listFindingsAll.all() as FindingRecord[];
  }

  resolveFinding(id: string, resolution: string): void {
    this.stmts.resolveFinding.run(resolution, id);
  }

  acknowledgeFinding(id: string): void {
    this.stmts.acknowledgeFinding.run(id);
  }

  // ── Run Stats ───────────────────────────────────────────────────

  upsertDayStats(stats: RunStatsRecord): void {
    this.stmts.upsertDayStats.run(
      stats.id,
      stats.project,
      stats.date,
      stats.scripted_runs,
      stats.scripted_passed,
      stats.scripted_failed,
      stats.live_runs,
      stats.live_passed,
      stats.live_failed,
      stats.findings_opened,
      stats.findings_resolved,
      stats.avg_duration_ms,
    );
  }

  getStats(project: string, from: string, to: string): RunStatsRecord[] {
    return this.stmts.getStats.all(project, from, to) as RunStatsRecord[];
  }

  getTrend(project: string, days: number = 14): RunStatsRecord[] {
    const rows = this.stmts.getTrend.all(project, days) as RunStatsRecord[];
    return rows.reverse(); // chronological order
  }

  // ── Utilities ───────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
