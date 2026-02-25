---
id: guardrails
type: safety
entry: packages/node/src/guardrails.ts
depends_on: []
depended_by: [code-pipeline, pipeline-runner, scheduler, pando-node, upgrade-protocol]
exposes:
  - getConfig()
  - updateConfig(partial)
  - preCheck(filePaths, description, reason, proposedBy, taskId?)
  - postCheck(filePaths?, repoDir?)
  - tieredPreCheck(filePaths, description, governanceApproved?)
  - getPending()
  - getAllPending()
  - getPendingById(id)
  - IMMUTABLE_KERNEL_FILES (const)
  - tieredConfig (readonly)
rules: [immutable-kernel, two-laws]
last_verified: 2026-02-20
---

# Guardrails

## What It Does
Safety system that protects the codebase from unauthorized or dangerous self-generated changes. Enforces protected paths, rate limits, tiered change requirements, an immutable kernel, and a pending-changes approval queue.

## How It Works
- Loads configuration from `~/.pando/guardrails.json` on startup, falling back to hardcoded defaults if missing or corrupt.
- **Tiered guardrail system** (Phase 16) classifies files into four tiers -- Critical, Important, Standard, Low -- each with different requirements for approval, review, tests, build, rate limits, and cooldown periods.
- **Immutable kernel** defines 7 files (crypto.ts, guardrails.ts, governance.ts, transactions.ts, code-pipeline.ts, deploy-manager.ts, identity.ts) that can never be modified by the autonomous pipeline.
- `preCheck()` validates rate limits and protected path rules before changes; creates pending approval entries for core files with a 24-hour timeout.
- `postCheck()` validates after changes are applied -- checks tier requirements, kernel violations, protected path violations, and optionally runs build verification via `execSync`.

## Governance Bypass (Phase 33.3)
- `tieredPreCheck()` accepts optional `governanceApproved?: boolean` parameter.
- When `governanceApproved = true`, bypasses: `requiresApproval` tier restrictions, rate limits, cooldowns.
- **NEVER bypassed** even with governance: immutable kernel checks (the Two Laws), protected path checks.
- Used by PipelineRunner when executing governance-approved proposals. The `proposalId` from `POST /pipeline/run` triggers the bypass.

## Gotchas
- The immutable kernel list exists in two forms: full paths (`IMMUTABLE_KERNEL_FILES`) and short filenames (`IMMUTABLE_KERNEL`). Both must stay in sync.
- `maxSelfChangesPerHour` (default 5) and `maxSelfChangesPerDay` (default 20) are tracked in-memory via `changeTimestamps[]` -- they reset on node restart.
- Pending changes are capped at 200 entries; oldest are evicted when the cap is reached.
- Config is persisted to disk on every update, but tiered config is always initialized from defaults (not from disk).

## Key Files
- `packages/node/src/guardrails.ts` -- main Guardrails class
- `packages/shared/src/types.ts` -- GuardrailConfig, PendingChange, GuardrailTier, TieredGuardrailConfig, TierRequirements types
- `~/.pando/guardrails.json` -- runtime config file
- `~/.pando/guardrails-pending.json` -- pending changes queue
