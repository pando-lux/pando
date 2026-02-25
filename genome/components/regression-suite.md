---
id: regression-suite
type: service
domain: evolution
entry: packages/node/src/regression-suite.ts
depends_on: []
depended_by: [pando-node]
exposes:
  - loadBuiltinTests() — load 14 built-in regression tests (API health, auth gating, governance, ledger, emissions, security)
  - addTestFromQAResult(testCase, description, category?) — auto-grow suite from successful QA runs
  - runAll(apiUrl?) — run full regression suite against API
  - runCategory(category, apiUrl?) — run subset by category
  - getTests() — all registered RegressionTest records
  - getLastResult() — most recent RegressionResult
  - getStats() — test count total and by category
  - removeTest(testId) — remove a test by ID
rules: []
last_verified: 2026-02-18
---

# Regression Suite

## What It Does
Persistent, auto-growing regression test suite that runs before every deploy. Provides 14 built-in tests covering API health, auth gating, governance, ledger, emissions, and security. Can be extended automatically from QA results and triggered via API.

## How It Works
- On construction, loads persisted tests from `~/.pando/regression-suite.json`. If empty, initializes with 14 built-in tests covering core endpoints.
- Built-in tests include: `/status` (200, expected fields), `/health` (200), `/peers` (200), `/wallet` (200, expected fields), `/tasks` (200), `/monitor/status` (200), governance proposals (200), active proposals (200), task creation auth (401 without token), transfer auth (401), upgrade auth (401), `/transactions` (200), `/emissions/stats` (200), `/security/stats` (200).
- `runAll()` executes all tests via HTTP `fetch` against the API base URL, with 30-second per-test timeout and 10-minute total timeout.
- `addTestFromQAResult()` takes an `ApiTestCase` from a successful QA run and adds it to the suite (deduplicates by description + path).
- Each test records `lastRun` timestamp and `lastResult` (pass/fail) after execution.
- Results are cached as `lastResult` for API queries. Tests are persisted to disk on any mutation (add/remove).
- Categories: `api`, `governance`, `ledger`.

## Gotchas
- The suite only tests HTTP API endpoints. It does not run Playwright page tests.
- Deduplication uses description + path matching. If the same endpoint is tested with different methods or bodies, duplicates can occur.
- Auth tests send requests WITHOUT a token and expect 401. If auth is disabled (e.g., in test environments), these tests will fail.
- The 10-minute total timeout means large suites may have tests skipped at the end.
- `removeTest()` deletes by ID, not by description. The ID is a random 16-byte hex string generated at creation time.

## Key Files
- `packages/node/src/regression-suite.ts` -- RegressionSuite class
- `~/.pando/regression-suite.json` -- persisted test definitions
- `packages/shared/src/types.ts` -- ApiTestCase, RegressionTest, RegressionResult, RegressionTestResult types
