// ── Enums / Union Types ─────────────────────────────────────────────

export type StepAction =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'screenshot'
  | 'assert_text'
  | 'assert_visible'
  | 'assert_hidden'
  | 'assert_url'
  | 'assert_status'
  | 'api_call'
  | 'wait'
  | 'evaluate'
  | 'hover'
  | 'press_key'
  | 'scroll'
  | 'custom';

export type TestMode = 'scripted' | 'live';

export type RunStatus = 'running' | 'passed' | 'failed' | 'error' | 'cancelled';

export type FindingType = 'bug' | 'ux_issue' | 'performance' | 'accessibility' | 'visual' | 'other';

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingStatus = 'open' | 'acknowledged' | 'resolved' | 'wontfix';

// ── Project Configuration ───────────────────────────────────────────

export interface ProjectConfig {
  /** Project name / identifier */
  project: string;
  /** Absolute path to the project root directory */
  rootDir: string;
  /** Gateway base URL (e.g. https://gateway-one-mu.vercel.app) */
  gatewayUrl: string;
  /** Node HTTP API base URL (e.g. http://localhost:4000) */
  apiUrl: string;
  /** Optional bearer token for authenticated API calls */
  authToken?: string;
}

// ── Playbook Types ──────────────────────────────────────────────────

export interface PlaybookStep {
  /** Action to perform */
  action: StepAction;
  /** CSS selector, URL, or API endpoint */
  target?: string;
  /** Verification expression or expected value */
  verify?: string;
  /** Whether to take a screenshot after this step */
  screenshot?: boolean;
  /** Expected value for assertions */
  expected?: string;
  /** Value to fill / type / send */
  value?: string;
  /** Prompt for AI in live mode — describes intent */
  prompt?: string;
  /** If true, step only runs in live mode */
  live_only?: boolean;
  /** Auth requirement: 'none' | 'operator' | 'user' */
  auth?: string;
  /** HTTP method for api_call steps */
  method?: string;
  /** Request body for api_call steps (JSON string or object) */
  body?: string | Record<string, unknown>;
}

export interface Playbook {
  /** Unique playbook name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Semver version of this playbook */
  version: string;
  /** Test mode: scripted or live */
  mode: TestMode;
  /** Categorization tags */
  tags: string[];
  /** Prerequisite playbook names that must pass first */
  prerequisites: string[];
  /** Ordered steps to execute */
  steps: PlaybookStep[];
}

// ── Database Records ────────────────────────────────────────────────

export interface ScenarioRecord {
  id: string;
  project: string;
  name: string;
  description: string;
  mode: TestMode;
  /** JSON-serialized PlaybookStep[] */
  steps: string;
  /** Comma-separated tags */
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface RunRecord {
  id: string;
  scenario_id: string;
  scenario_name: string;
  mode: TestMode;
  status: RunStatus;
  agent_id: string | null;
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  duration_ms: number;
  summary: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface StepResultRecord {
  id: string;
  run_id: string;
  step_index: number;
  action: StepAction;
  target: string | null;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  expected: string | null;
  actual: string | null;
  screenshot_path: string | null;
  notes: string | null;
  duration_ms: number;
}

export interface FindingRecord {
  id: string;
  run_id: string;
  step_index: number | null;
  type: FindingType;
  severity: FindingSeverity;
  title: string;
  description: string;
  screenshot_path: string | null;
  status: FindingStatus;
  resolved_at: string | null;
  resolution: string | null;
  created_at: string;
}

export interface RunStatsRecord {
  id: string;
  project: string;
  date: string;
  scripted_runs: number;
  scripted_passed: number;
  scripted_failed: number;
  live_runs: number;
  live_passed: number;
  live_failed: number;
  findings_opened: number;
  findings_resolved: number;
  avg_duration_ms: number;
}

// ── Dashboard ───────────────────────────────────────────────────────

export interface DashboardOverview {
  project: string;
  total_scenarios: number;
  total_runs: number;
  last_run: RunRecord | null;
  pass_rate: number;
  open_findings: number;
  critical_findings: number;
  trend: RunStatsRecord[];
}

// ── AI Evaluator Interface (live mode) ──────────────────────────────

export interface TestEvaluator {
  /**
   * Given a step prompt and a page snapshot/screenshot,
   * decide what action to take and evaluate the result.
   */
  evaluate(step: PlaybookStep, context: {
    pageUrl: string;
    pageTitle: string;
    screenshotPath?: string;
    htmlSnippet?: string;
  }): Promise<{
    passed: boolean;
    actual: string;
    notes: string;
    suggestedAction?: StepAction;
    suggestedTarget?: string;
  }>;
}
