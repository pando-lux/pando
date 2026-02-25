---
id: qa-standard
severity: high
applies_to: [manager, qa-runner]
created: 2026-02-16
---

# QA Standard

## The Rule

Every change must be tested as a real user would experience it. Code review alone is NOT sufficient.

## What QA Requires

| Change Type | Required Testing |
|---|---|
| Frontend/UI | Playwright browser test — navigate, interact, verify visually |
| API endpoints | Real HTTP requests (curl/fetch), verify response data |
| P2P features | Multiple nodes running, verify cross-node sync |
| Build-only | Build verification sufficient |
| Non-code (docs) | No QA needed |

## Key Principle

If it's not tested like a user would use it, it's not done. This is the standard for all phases, all features, forever.

## Enforcement

- Manager workflow pipeline includes QA as step 4
- QA agent is always a SEPARATE agent (not the builder)
- qa-runner.ts provides structured test cases (12 API + P2P tests)
- regression-suite.ts runs 14 built-in tests on deploy
- TEST-TRACKER.md tracks all 102 tests
