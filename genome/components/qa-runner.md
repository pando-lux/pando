---
id: qa-runner
type: service
domain: pipeline
entry: packages/node/src/qa-runner.ts
depends_on: []
depended_by: [pipeline-runner, pando-node, cli]
exposes:
  - runPageTests(urls, options?) — navigate pages via Playwright, collect console errors, capture screenshots
  - runApiTests(endpoints) — GET each endpoint, validate 2xx response
  - runStructuredApiTests(testCases) — run ApiTestCase[] with method, body, expected status/fields, auth
  - runP2PTests(nodeUrls) — compare /status, /scheduler/tasks, /governance/proposals between nodes
  - getDefaultApiTests() — built-in health test suite
  - getAffectedPages(changedFiles) — determine which pages are affected by file changes
  - runChecks(changedFiles) — combined API health + affected page tests (post-verifier flow)
  - runHealthCheck() — post-deploy health check (7 gateway pages + 4 API endpoints + scheduler)
rules: []
last_verified: 2026-02-18
---

# QA Runner

## What It Does
Provides automated Playwright-based page testing and HTTP-based API testing for the code pipeline. Runs page-level tests (navigate, collect errors, screenshot) and API-level tests (structured request/response validation) with configurable timeouts.

## How It Works
- Page tests dynamically import Playwright at runtime (so the module loads even when Playwright is not installed), launch a browser, navigate each URL, collect `console.error` messages, and capture screenshots.
- Per-page timeout is 30 seconds; total timeout is 5 minutes. Pages exceeding the total timeout are marked as `timeout`.
- API tests make HTTP requests using native `fetch`, validating response status codes and checking for expected JSON fields.
- `getAffectedPages()` uses heuristics to map changed file paths to gateway routes -- changes in `gateway/src/routes/` map to specific paths, changes in `packages/shared/` or `packages/node/` trigger broad impact (test all core pages).
- `runHealthCheck()` verifies 7 gateway pages + 4 core API endpoints + scheduler status for post-deploy validation.
- Structured API tests (`runStructuredApiTests`) support full request spec: method, path, body, headers, expected status, expected fields, and auth token.

## QA Agent — Autonomous Actor (Architecture Blueprint)

QA Runner provides the TEST UTILITIES, but the QA Agent is a full Claude Code session with its own structured workflow. Per `genome/flows/architecture-capabilities.md`:

```
QA AGENT TODO LIST:
  □ 1. UNDERSTAND: Read test plan from task spec + project-state.md
  □ 2. PLAN: Set up test environment, identify test data, plan test cases
  □ 3. TEST: Run each test case (Playwright for UI, fetch for API, unit tests for logic)
  □ 4. UPDATE_GENOME: Update genome/state.md with test results, mark resolved issues, log new bugs
  □ 5. REPORT: Write RESULT.md with pass/fail per test, regressions, screenshots, genome files updated
```

**QA is NOT a dumb test runner.** QA is a Claude Code session that:
- Reads project-state.md for context on what was built and what changed
- Designs test cases based on the changes
- Uses QA Runner utilities (runPageTests, runApiTests) as tools
- Updates genome with test results (freshest context about what passed/failed)
- Can talk directly to user via bridge (urgency:direct) if stuck
- Tracks regression across runs via `--continue` (knows what passed before)

**Manager triggers QA** after milestones by creating a QA task with `verificationNeeded: true`. Scheduler spawns QA agent with a QA-specific CLAUDE.md.

## Gotchas
- Playwright is a soft dependency via dynamic import. If not installed, all page tests return a `playwrightUnavailable` result (not a crash).
- Screenshots are saved to `this.screenshotDir` (default `qa-screenshots/` in cwd). The directory is created automatically if missing.
- The `getAffectedPages()` heuristic references `gateway/src/routes/` and `gateway/src/pages/` but the actual gateway uses `app/` (Next.js App Router), so the route detection may miss some pages.
- Default `baseUrl` is `http://localhost:4000` (node API), not the gateway. Page tests against gateway pages require the gateway to be running separately.

## Key Files
- `packages/node/src/qa-runner.ts` -- all QA test logic
- `packages/shared/src/types.ts` -- QAResult, PageResult, HealthCheckResult, ApiTestCase types
