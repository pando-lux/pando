# TESTING-BIBLE — @pando/tests
## The Pando Testing Module
## 2026-03-06

---

## CURRENT STATUS

- Package: PHASES 1-4 COMPLETE — scaffold, database, runners, playbooks, API, and gateway dashboard all built and validated
- Self-test: 48/48 non-browser API tests pass
- ScriptedRunner: 227/227 Playwright tests pass through pipeline
- LiveRunner: gateway-navigation playbook runs end-to-end (13/15 steps, 15 screenshots)
- 6 starter playbooks for pando-node
- Zero @pando/* dependencies — standalone, usable by anyone on any project
- Gateway dashboard LIVE at /testing — full myreze-inspired UX with sidebar nav, History tab, Draft Scenarios, per-project switching, two-column detail view
- Next: Phase 5 (CLI), Phase 6 (polish)

---

## WHAT IT IS

`@pando/tests` is a standalone, modular testing framework that provides two levels of testing:

1. **Scripted Testing** — Automated Playwright specs that run fast and answer "does it work?" (pass/fail)
2. **Live Testing** — Agent-driven browser interaction that answers "is it good?" (findings, suggestions, screenshots)

It is a **standalone package** with zero `@pando/*` dependencies. Any developer can use it for any project. It has its own SQLite database, its own playbook format, and its own dashboard data provider.

Think of it as: **Playwright for robots, but with a brain when you need one.**

**Single-project context:** The entire system — dashboard, database, screenshots, playbooks, findings — operates on ONE loaded project at a time. When you initialize `PandoTester({ project: 'pando-node' })`, everything is scoped to that project. Switch projects by pointing to a different root directory. No multi-project views — keep it simple.

---

## DESIGN PRINCIPLES

1. **Standalone** — zero @pando/* imports. Works for any web project.
2. **Per-project** — all state (DB, screenshots, playbooks) lives in `.pando-tests/` inside the project root. Delete the folder = clean slate.
3. **Two modes, one truth** — scripted and live tests share the same scenario definitions, the same database, the same history. One source of truth.
4. **Agent-friendly** — clean TypeScript API that any AI agent can import and use. No CLI required (but CLI available).
5. **History matters** — every run, every finding, every screenshot is recorded. You can see trends, regressions, improvements over time.
6. **Playbooks are data** — structured JSON, not prose. Machines read them, humans read them. Both modes consume the same playbook.
7. **Findings are persistent** — live test findings (bugs, UX issues, suggestions) are tracked with status lifecycle: open → acknowledged → resolved / wont_fix.

---

## ARCHITECTURE

### Package Structure

```
packages/tests/
  package.json
  tsconfig.json
  src/
    index.ts                        # Public API: PandoTester class
    types.ts                        # All TypeScript types
    database.ts                     # SQLite storage layer
    config.ts                       # Configuration loading + defaults

    scripted/
      runner.ts                     # ScriptedRunner — wraps Playwright test runner
      helpers.ts                    # fetchWithRetry, auth helpers, assertions

    live/
      runner.ts                     # LiveRunner — agent-driven Playwright MCP
      evaluator.ts                  # AI evaluation at each step (pluggable)

    playbooks/
      loader.ts                     # Load/validate playbook JSON
      defaults/                     # Built-in playbooks (optional starter set)
        smoke-test.json

    reporters/
      console.ts                    # Terminal output
      json.ts                       # Machine-readable JSON report
      html.ts                       # HTML report (future)
```

### Per-Project Storage

```
any-project/
  .pando-tests/                     # Created on first run
    config.json                     # Project config (URLs, auth, mode prefs)
    results.db                      # SQLite: all test state
    screenshots/                    # PNG captures, organized by run
      run-47/
        step-01-governance-page.png
        step-04-proposal-created.png
    playbooks/                      # Project-specific playbooks
      governance-flow.json
      agent-onboarding.json
      custom-checkout-flow.json     # Any project's custom scenarios
```

The `.pando-tests/` directory should be added to `.gitignore` (contains local results, screenshots, and the database). Playbooks can optionally be committed if the team wants to share scenarios.

---

## DATA MODEL (SQLite)

### scenarios
The test plans — what we test.
```sql
CREATE TABLE scenarios (
  id            TEXT PRIMARY KEY,       -- UUID
  project       TEXT NOT NULL,          -- project name (e.g., 'pando-node')
  name          TEXT NOT NULL UNIQUE,   -- human name (e.g., 'governance-flow')
  description   TEXT,
  mode          TEXT NOT NULL DEFAULT 'both',  -- 'scripted' | 'live' | 'both'
  steps         TEXT NOT NULL,          -- JSON array of Step objects
  tags          TEXT,                   -- JSON array of strings
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

### runs
Each execution of a scenario or suite.
```sql
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,       -- UUID
  scenario_id   TEXT,                   -- FK to scenarios (null for ad-hoc)
  scenario_name TEXT NOT NULL,          -- denormalized for quick queries
  mode          TEXT NOT NULL,          -- 'scripted' | 'live'
  status        TEXT NOT NULL,          -- 'running' | 'passed' | 'failed' | 'error'
  agent_id      TEXT,                   -- which agent ran it (null for human/CLI)
  total_steps   INTEGER NOT NULL DEFAULT 0,
  passed_steps  INTEGER NOT NULL DEFAULT 0,
  failed_steps  INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  summary       TEXT,                   -- human-readable summary
  error         TEXT,                   -- error message if status='error'
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id)
);
```

### step_results
Per-step outcome within a run.
```sql
CREATE TABLE step_results (
  id              TEXT PRIMARY KEY,     -- UUID
  run_id          TEXT NOT NULL,        -- FK to runs
  step_index      INTEGER NOT NULL,     -- 0-based position in scenario
  action          TEXT NOT NULL,        -- 'navigate' | 'click' | 'fill' | 'verify' | 'evaluate' | 'screenshot' | 'api_call'
  target          TEXT,                 -- what was acted on
  status          TEXT NOT NULL,        -- 'passed' | 'failed' | 'skipped' | 'error'
  expected        TEXT,                 -- what we expected
  actual          TEXT,                 -- what actually happened
  screenshot_path TEXT,                 -- relative path in .pando-tests/screenshots/
  notes           TEXT,                 -- agent observations (live mode)
  duration_ms     INTEGER,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
```

### findings
Intelligence from live tests — bugs, UX issues, suggestions.
```sql
CREATE TABLE findings (
  id              TEXT PRIMARY KEY,     -- UUID
  run_id          TEXT NOT NULL,        -- FK to runs
  step_index      INTEGER,             -- which step triggered this (optional)
  type            TEXT NOT NULL,        -- 'bug' | 'ux_issue' | 'suggestion' | 'performance' | 'security'
  severity        TEXT NOT NULL,        -- 'critical' | 'high' | 'medium' | 'low'
  title           TEXT NOT NULL,        -- short description
  description     TEXT NOT NULL,        -- detailed explanation
  screenshot_path TEXT,                 -- evidence
  status          TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'acknowledged' | 'resolved' | 'wont_fix'
  resolved_at     TEXT,
  resolution      TEXT,                 -- how it was fixed
  created_at      TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);
```

### run_stats
Daily aggregated stats for trend tracking.
```sql
CREATE TABLE run_stats (
  id              TEXT PRIMARY KEY,
  project         TEXT NOT NULL,
  date            TEXT NOT NULL,        -- YYYY-MM-DD
  scripted_runs   INTEGER DEFAULT 0,
  scripted_passed INTEGER DEFAULT 0,
  scripted_failed INTEGER DEFAULT 0,
  live_runs       INTEGER DEFAULT 0,
  live_passed     INTEGER DEFAULT 0,
  live_failed     INTEGER DEFAULT 0,
  findings_opened INTEGER DEFAULT 0,
  findings_resolved INTEGER DEFAULT 0,
  avg_duration_ms INTEGER,
  UNIQUE(project, date)
);
```

---

## PLAYBOOK FORMAT

Playbooks are structured JSON files that both scripted and live runners consume.

```json
{
  "name": "governance-flow",
  "description": "Full governance cycle: create proposal, vote, verify outcome",
  "version": "1.0.0",
  "mode": "both",
  "tags": ["governance", "core", "smoke"],
  "prerequisites": {
    "urls": {
      "gateway": "{{GATEWAY_URL}}",
      "api": "{{API_URL}}"
    },
    "auth": "bearer",
    "node_running": true
  },
  "steps": [
    {
      "action": "navigate",
      "target": "{{GATEWAY_URL}}/governance",
      "verify": "page loads without error",
      "screenshot": true
    },
    {
      "action": "verify",
      "target": "proposals list",
      "expected": "list or empty state visible"
    },
    {
      "action": "api_call",
      "method": "POST",
      "target": "{{API_URL}}/v1/governance/propose",
      "body": { "title": "Test proposal {{TIMESTAMP}}", "description": "E2E test" },
      "verify": "201 or 200 status",
      "auth": true
    },
    {
      "action": "navigate",
      "target": "{{GATEWAY_URL}}/governance",
      "verify": "new proposal visible in list",
      "screenshot": true
    },
    {
      "action": "evaluate",
      "prompt": "Review the governance page. Is the proposal list well-formatted? Are timestamps readable? Any UX issues?",
      "live_only": true
    }
  ]
}
```

### Step Actions

| Action | Description | Scripted | Live |
|--------|-------------|----------|------|
| `navigate` | Go to URL | Playwright goto | Playwright MCP navigate |
| `click` | Click element | querySelector + click | MCP browser_click |
| `fill` | Fill form field | fill() | MCP browser_fill_form |
| `verify` | Check something exists/visible | assertion | assertion + AI evaluation |
| `screenshot` | Capture page state | page.screenshot() | MCP browser_take_screenshot |
| `api_call` | HTTP request to API | fetch() | fetch() |
| `evaluate` | AI thinks about what it sees | SKIPPED (scripted) | Agent evaluates, may create findings |
| `submit` | Submit form | click submit button | MCP browser_click |
| `wait` | Wait for condition | waitForSelector | MCP browser_wait_for |

### Template Variables

Playbooks use `{{VAR}}` syntax. Variables resolved at runtime from config:
- `{{GATEWAY_URL}}` — from config.json
- `{{API_URL}}` — from config.json
- `{{TIMESTAMP}}` — generated at runtime
- `{{AUTH_TOKEN}}` — from config.json (never stored in playbook)

---

## PUBLIC API

### PandoTester (main class)

```typescript
import { PandoTester } from '@pando/tests';

// Initialize for a project
const tester = new PandoTester({
  project: 'pando-node',
  rootDir: '/path/to/project',          // .pando-tests/ created here
  config: {                              // or loaded from .pando-tests/config.json
    gatewayUrl: 'https://gateway-one-mu.vercel.app',
    apiUrl: 'http://127.0.0.1:4100',
    authToken: process.env.PANDO_API_TOKEN
  }
});

// --- SCRIPTED MODE ---
const result = await tester.scripted.runAll();
// → { total: 204, passed: 204, failed: 0, duration: 47200, runId: 'uuid' }

const result = await tester.scripted.run('governance');
// → runs only tests tagged 'governance'

const result = await tester.scripted.run(['auth', 'identity']);
// → runs tests matching multiple tags

// --- LIVE MODE ---
const result = await tester.live.run('governance-flow', {
  headed: true,              // visible browser
  screenshotEvery: true,     // capture at each step
  evaluateAll: true          // AI evaluates at every step, not just 'evaluate' actions
});
// → { status: 'passed', steps: [...], findings: [...], screenshots: [...] }

// --- SCENARIOS ---
tester.scenarios.list();                              // all registered scenarios
tester.scenarios.get('governance-flow');               // get one
tester.scenarios.register(playbookJson);               // add new
tester.scenarios.import('./my-playbooks/*.json');       // bulk import

// --- HISTORY ---
tester.history.getRuns({ last: 10 });                  // recent runs
tester.history.getRuns({ scenario: 'governance-flow', mode: 'live' });
tester.history.getStats('2026-03-01', '2026-03-06');   // daily aggregates
tester.history.getTrend('pando-node', 30);             // 30-day pass rate trend

// --- FINDINGS ---
tester.findings.list({ status: 'open' });              // open findings
tester.findings.list({ severity: 'high' });
tester.findings.acknowledge(findingId);
tester.findings.resolve(findingId, 'Fixed in commit abc123');
tester.findings.getByRun(runId);

// --- DASHBOARD DATA ---
tester.dashboard.overview();
// → { scripted: { total: 204, passing: 204 }, live: { scenarios: 6, lastRun: '...' }, findings: { open: 3, ... } }
tester.dashboard.scenarioList();
tester.dashboard.runDetail(runId);
tester.dashboard.findingsBoard();
```

### LiveRunner Evaluator (pluggable AI)

The live runner needs an AI to "think" at `evaluate` steps. This is pluggable:

```typescript
interface TestEvaluator {
  evaluate(context: {
    screenshot: Buffer;           // current page screenshot
    step: PlaybookStep;           // the evaluate step definition
    previousSteps: StepResult[];  // what happened so far
    pageSnapshot: string;         // accessibility tree / DOM snapshot
  }): Promise<{
    passed: boolean;
    notes: string;                // what the agent observed
    findings: Finding[];          // bugs/suggestions discovered
  }>;
}
```

Default evaluator: uses whatever AI provider is available (Anthropic, OpenAI, etc. via env vars).
Custom evaluator: pass your own implementation to `tester.live.setEvaluator(myEvaluator)`.

For Pando specifically: PandoCode engine instances can serve as evaluators.

---

## INTEGRATION POINTS

### With @pando/node (optional — only for Pando projects)
```
@pando/node
  api/testing-api.ts          # Mounts /v1/testing/* routes
    GET  /v1/testing/status    # Dashboard overview
    GET  /v1/testing/runs      # Run history
    GET  /v1/testing/runs/:id  # Single run detail
    GET  /v1/testing/findings  # Findings list
    POST /v1/testing/run       # Trigger a test run (legacy)
    POST /v1/testing/run/scripted  # Trigger scripted test run
    POST /v1/testing/run/live      # Trigger live test run
    GET  /v1/testing/scenarios # List scenarios
    GET  /v1/testing/stats     # Daily aggregated stats
```

### With @pando/gateway (optional — only for Pando projects)
```
Gateway page: /testing — myreze-inspired dashboard UX
  Sidebar navigation:
    - Dashboard        Overview cards (scripted pass rate, live scenarios, open findings)
    - Static Tests     Flat test list grouped by tag, search/filter, per-test Run button, Run All
    - Live Tests       Agent-driven test scenarios, run with AI evaluation
    - Draft Scenarios  Brainstorm test ideas, mark static/live/both, promote to AI agent via chat API

  Per-project switching: pando-node, pando-code (dropdown in sidebar)

  Tests sub-tab:
    - Flat test list grouped by tag
    - Search and filter controls
    - Per-test Run button + Run All
    - 10s auto-refresh

  History sub-tab:
    - Chronological run list (newest first)
    - Two-column layout: run list (left) + detail panel (right)
    - Search/filter by status
    - Per-run detail: Definition tab, summary, errors, findings

  Detail view:
    - Two-column: run history list + content
    - Definition tab shows scenario steps
    - Per-run detail with summary/errors/findings
    - Toast notifications on run completion
    - Run output console

  Draft Scenarios:
    - Brainstorm test ideas in freeform
    - Mark as static, live, or both
    - Promote to AI agent via chat API integration
```

### With any project (standalone)
```bash
# Install
npm install @pando/tests

# Initialize in project
npx pando-tests init

# Run scripted tests
npx pando-tests run --scripted

# Run live test
npx pando-tests run --live governance-flow

# View results
npx pando-tests report
npx pando-tests findings --open
npx pando-tests history --last 10
```

---

## CLI

```
npx pando-tests <command> [options]

Commands:
  init                          Initialize .pando-tests/ in current directory
  run [scenario]                Run tests
    --scripted                  Scripted mode (default if no scenario specified)
    --live                      Live agent mode
    --headed                    Show browser (default for live, optional for scripted)
    --tag <tag>                 Filter by tag
    --all                       Run all scenarios
  scenarios                     List registered scenarios
    --add <file.json>           Register a new playbook
    --import <glob>             Import multiple playbooks
  findings                      List findings
    --open                      Only open findings
    --severity <level>          Filter by severity
    --resolve <id> <note>       Mark finding as resolved
  history                       View run history
    --last <n>                  Last N runs
    --scenario <name>           Filter by scenario
    --stats                     Show daily stats
  report [runId]                Show detailed report for a run
  dashboard                     Open dashboard in browser (serves HTML report)
```

---

## DEPENDENCIES

### Runtime
- `better-sqlite3` — database (same as @pando/node, proven)
- `playwright` or `@playwright/test` — browser automation
- `uuid` — run/finding IDs

### Peer (optional, for live mode AI evaluation)
- Any AI SDK (Anthropic, OpenAI, etc.) — for the evaluator
- Or bring your own evaluator implementation

### Zero @pando/* dependencies
This package does NOT import from @pando/identity, @pando/code, @pando/node, or any other @pando package. It is fully standalone.

---

## WHAT IS NOT IN THIS PACKAGE

- **AI engine** — the evaluator interface accepts any AI, but doesn't bundle one
- **Web server** — the dashboard data provider returns JSON; the actual web page is in @pando/gateway
- **CI/CD integration** — future: GitHub Actions, etc.
- **Load testing** — out of scope (different tool)
- **Unit testing** — this is for integration/E2E/UX testing, not unit tests

---

## BUILD PHASES

### Phase 1: Scaffold + Database + Types — DONE
- [x] Create `packages/tests/` with package.json, tsconfig.json
- [x] Define all TypeScript types (types.ts) — 17 types, 6 union types
- [x] Implement SQLite database layer (database.ts) — 5 tables, WAL mode, prepared statements
- [x] Implement config loader (config.ts) — per-project .pando-tests/, template vars
- [x] Implement playbook loader + validator (playbooks/loader.ts)
- [x] Self-test: 48/48 non-browser API tests pass

### Phase 2: Scripted Runner — DONE
- [x] Implement ScriptedRunner wrapping Playwright (spawns npx playwright test, parses JSON)
- [x] Reusable helpers: fetchWithRetry, apiGet/Post/Raw (parameterized baseUrl)
- [x] Wire runner to record runs + step results in SQLite
- [x] Verified: 227/227 Playwright tests pass through ScriptedRunner pipeline
- [ ] Move existing tests from `tests/e2e/` into package (deferred — working fine in current location)

### Phase 3: Live Runner — DONE
- [x] Implement LiveRunner using Playwright library API (chromium.launch, direct page control)
- [x] Implement evaluator interface + BasicEvaluator + AIEvaluator (pluggable)
- [x] Create 6 starter playbooks for pando-node (governance, agent-onboarding, content-lifecycle, gateway-navigation, wallet-economy, chat-experience)
- [x] Wire findings + screenshots to SQLite
- [x] Verified: gateway-navigation playbook runs end-to-end (13/15 steps pass, 15 screenshots captured)
- [ ] Wire AIEvaluator to actual AI API (placeholder — falls back to BasicEvaluator)

### Phase 4: API + Dashboard — DONE (full redesign complete)
- [x] Add /v1/testing/* routes to @pando/node (11 endpoints: status, runs, runs/:id, findings, acknowledge, resolve, scenarios, playbooks, stats, run/scripted, run/live)
- [x] Create /testing page in @pando/gateway — full myreze-inspired dashboard redesign
- [x] Sidebar navigation: Dashboard, Static Tests, Live Tests, Draft Scenarios
- [x] Per-project switching (pando-node, pando-code)
- [x] Two-column detail view: run history list + content panel
- [x] History tab: chronological run list (newest first), search/filter by status
- [x] Draft Scenarios: brainstorm ideas, mark static/live/both, promote to AI agent via chat API
- [x] 10s auto-refresh, toast notifications, run output console
- [x] API proxy route in gateway (/api/testing/[...path])
- [x] @pando/tests wired as workspace dependency + TypeScript project references
- [x] Full monorepo build passes (npm run build zero errors)
- [x] API endpoints verified live: /v1/testing/status returns real data from test runs

### Phase 5: CLI
- [ ] Implement CLI commands (init, run, scenarios, findings, history, report)
- [ ] Publish as `npx pando-tests`

### Phase 6: Polish
- [ ] HTML reporter
- [ ] Screenshot gallery in dashboard
- [ ] Trend graphs
- [ ] CI/CD integration helpers

---

## RISKS

1. **Playwright dependency size** — Playwright downloads browsers (~400MB). Mitigation: peer dependency, browsers installed separately.
2. **AI evaluator cost** — Live tests call AI at each evaluate step. Mitigation: evaluateAll is optional, use sparingly.
3. **Screenshot storage growth** — Long-running projects accumulate screenshots. Mitigation: configurable retention policy (default: keep last 30 days).
4. **Cross-platform** — Playwright works on Windows/Mac/Linux. SQLite via better-sqlite3 is native. Should work everywhere.

---

## KEY PRINCIPLES

1. **Tests are first-class data.** Every run, every step, every finding is persisted and queryable.
2. **Two modes, one system.** Scripted and live testing share the same database, same scenarios, same reporting.
3. **Standalone above all.** No @pando/* dependencies. Any developer, any project.
4. **Playbooks are the contract.** The playbook JSON format is the interface between humans, agents, and runners.
5. **Findings drive improvement.** Live test findings aren't just logs — they have status, severity, resolution tracking.
6. **History enables decisions.** Trend data over time shows whether the project is getting better or worse.
