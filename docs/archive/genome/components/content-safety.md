---
id: content-safety
type: safety
entry: packages/node/src/platform/content-safety.ts
depends_on: []
depended_by: [pando-node]
exposes:
  - reviewContent(files, metadata?)
rules: [two-laws]
last_verified: 2026-02-18
---

# Content Safety Reviewer

## What It Does
Rule-based content safety review for files before publishing. Scans for harmful content patterns, malicious code, OWASP vulnerability patterns, Two Laws violations, and dangerous npm dependencies -- entirely offline with no external API calls.

## How It Works
- Accepts a list of file paths and runs them through 5 pattern categories: harmful content (violence targeting humans), malicious code (eval, dynamic require, innerHTML, crypto miners), OWASP (SQL injection, XSS, path traversal, SSRF), Two Laws (human harm, surveillance, safety system disabling), and dangerous dependencies (event-stream, colors, faker).
- Each finding has a severity level: `critical`, `high`, `medium`, or `low`, and a category tag (`harmful_content`, `malicious_code`, `owasp`, `two_laws`, `dependency`).
- Computes a safety score (0.0--1.0) from findings; a score >= 0.7 means "safe" (`SAFETY_THRESHOLD`).
- Malicious code patterns have optional file extension filters (e.g., `eval()` only flagged in .js/.ts/.jsx/.tsx/.mjs files).
- For `package.json` files, checks dependency names against the known-dangerous list.
- Reviews are persisted at `~/.pando/security/safety-reviews.json`, capped at 200 entries.

## Gotchas
- Pattern matching uses single `content.match()` per rule, which only finds the first occurrence per file -- multiple instances of the same pattern in one file produce only one finding.
- The OWASP localhost/SSRF pattern can flag legitimate internal API calls (e.g., Pando's own `localhost:4000` references).
- Line number extraction relies on counting newlines before the match index, which is approximate for multi-line regex matches.
- No async scanning or streaming -- entire file content is read into memory with `readFileSync`.

## Key Files
- `packages/node/src/content-safety.ts` -- ContentSafetyReviewer class
- `packages/shared/src/types.ts` -- SafetyReview, SafetyFinding types
- `~/.pando/security/safety-reviews.json` -- persisted review history
