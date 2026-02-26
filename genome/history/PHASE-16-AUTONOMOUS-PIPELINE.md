# Phase 16: Autonomous Code Pipeline

> Written by pando-node-mgr (manager agent) — 2026-02-26
> All components verified present in pando-final/src

## Overview

Phase 16 makes Pando a fully self-sustaining, AI-run network. When an agent completes a task in its isolated workspace, the pipeline automatically extracts diffs, validates through guardrails, applies patches to the real codebase, runs QA, and deploys — with zero human involvement for low-risk changes.

## Architecture

```
Task workspace output/
        ↓
  16.3 CodePipeline.extractDiff()
        ↓
  Guardrail tier check (16.1+16.2)
        ↓
  16.3 CodePipeline.applyPatch()
        ↓
  16.5 DeployManager.createBackup()
  16.5 DeployManager.commitChanges()
  16.5 DeployManager.runBuild()
        ↓ (build pass)
  16.4 QaRunner.runPageTests() / runApiTests()
        ↓ (QA pass)
  16.5 Deploy / notify
        ↓ (build or QA fail)
  16.5 DeployManager.rollbackCommit()
```

---

## Components

### 16.1 + 16.2 — Shared Types + Tiered Guardrails
**File:** `packages/shared/src/types.ts`
**Status:** Implemented (confirmed line 722+)

New types added:
- `GuardrailTier` — `'Critical' | 'Important' | 'Standard' | 'Low'`
- `TieredProtectionRule` — tier + pathPatterns + TierRequirements
- `TierRequirements` — flags: verifierMustPass, buildMustPass, playwrightQaRequired, multiAgentConsensus, humanNotification, humanApprovalRequired, governanceVoteRequired, minReviewPeriodMs
- `TieredGuardrailConfig` — extends GuardrailConfig with tiers[] and immutableKernel[]
- `NodeVersion` — protocolVersion, semver, capabilities[], buildHash?, updatedAt
- `VersionCompatibility` — compatible, localVersion, remoteVersion, missingCapabilities[], recommendation
- `PatchSet` — taskId, proposalId?, agentRole, changes: FileChange[], extractedAt, description, provenance
- `FileChange` — filePath, operation, content?, originalContent?, diffStats

**Tiered Protection Rules:**

| Tier | Files | Requirements |
|------|-------|-------------|
| Critical | network.ts, sync.ts, ledger/, crypto/ | Multi-agent consensus + Playwright QA + governance vote |
| Important | index.ts, api-server.ts, scheduler.ts | Verifier pass + build pass |
| Standard | gateway pages, UI components | Build pass + Playwright QA for visible pages |
| Low | workspace-only, tests, docs | Auto-merge if build passes |

---

### 16.3 — Code Pipeline
**File:** `packages/node/src/code-pipeline.ts`
**Class:** `CodePipeline`
**Status:** Implemented (confirmed)

**Constructor:** `(repoDir: string, workspaceBaseDir: string, guardrails: Guardrails)`

**Methods:**

1. `extractDiff(workspaceOutputDir: string): PatchSet`
   - Scans workspace `output/` for source files matching `packages/` pattern
   - Compares against `repoDir` — computes line diff stats for modified, marks new files as `add`
   - Skips non-source files: RESULT.md, workspace.json, CLAUDE.md, agent-stream*.log, .claude/
   - Falls back to git diff if no workspace output found
   - Returns `PatchSet` or null if no code changes
   - Read-only — does not modify files

2. `applyPatch(patch: PatchSet): MergeResult`
   - For each FileChange: calls `guardrails.isImmutableKernel()` and `tieredPreCheck()`
   - Saves original content for rollback before writing
   - Returns `MergeResult` — `success=false` if ANY file fails guardrail check
   - Partial applies are tracked in `rollbackInfo`

3. `rollback(rollbackInfo: RollbackInfo): void`
   - Restores all files to original content
   - Deletes new files (where original was null)

---

### 16.4 — QA Runner
**File:** `packages/node/src/qa-runner.ts`
**Class:** `QaRunner`
**Status:** Implemented (confirmed)

**Constructor:** `(gatewayUrl: string, workspaceDir: string)`

**Methods:**

1. `runPageTests(urls: string[], options?: { headless?: boolean }): Promise<QAResult>`
   - Launches Playwright headless browser
   - Navigates each page, collects console errors, captures screenshots
   - Returns structured `QAResult`

2. `runApiTests(endpoints: string[]): Promise<QAResult>`
   - Tests API endpoints via fetch
   - Validates: health check, affected routes respond 200, no 500s
   - Returns structured `QAResult`

**QA Types (in shared/types.ts):**
- `QAResult` — passed, pages: PageResult[], screenshots, errors, duration
- `PageResult` — url, passed, consoleErrors, screenshotPath?
- `HealthCheckResult`, `ApiTestCase`, `FileChange`

---

### 16.5 — Deploy Manager
**File:** `packages/node/src/deploy-manager.ts`
**Class:** `DeployManager`
**Status:** Implemented (confirmed lines 58-302)

**Constructor:** `(repoDir: string)`

**Methods:**

1. `createBackup(description?: string): BackupInfo`
   - Snapshots current `dist/` before deploying
   - Returns `BackupInfo` for rollback reference

2. `commitChanges(patchSet: PatchSet): CommitResult`
   - Stages changed files via git add
   - Creates commit: `[auto] Task <patchSetId> — <description>`
   - Returns `{ success, commitHash?, error? }`

3. `runBuild(): BuildResult`
   - Runs `npm run build` in `repoDir`
   - Captures stdout+stderr
   - Returns `{ success, output, durationMs }`

4. `rollbackCommit(): CommitResult`
   - Runs git reset to undo last pipeline commit (soft — preserves files)

---

### 16.6 — Version Protocol
**File:** `packages/node/src/version-protocol.ts`
**Class:** `VersionProtocol`
**Status:** Implemented (confirmed)

**Constructor:** `(options?: { protocolVersion?, capabilities? })`

**Constants:**
- `CURRENT_PROTOCOL_VERSION: ProtocolVersion` — major/minor/patch
- `DEFAULT_CAPABILITIES` — e.g. `['governance-v2', 'scheduler-v3', 'pipeline-v1']`

**Methods:**

1. `getVersionInfo(): VersionInfo`
   - Returns protocolVersion, semver, and capabilities array

2. `isCompatible(remoteVersion: VersionInfo): { compatible: boolean, reason?: string }`
   - Checks if remote node version is compatible with this node
   - Used in upgrade protocol to prevent incompatible mesh connections

---

### 16.7 — Pipeline Runner (Orchestrator)
**File:** `packages/node/src/pipeline-runner.ts`
**Class:** `PipelineRunner`
**Status:** Implemented (confirmed — runPipeline() at line 132)

**Constructor:** `(repoDir: string, guardrails: Guardrails, options?: { gatewayUrl? })`
- Internally instantiates: CodePipeline, QaRunner, DeployManager, VersionProtocol

**Main Entry Point:**
`runPipeline(workspaceOutputDir, governanceApprovalId?, overrides?): Promise<PipelineRunResult>`

Full pipeline sequence:
1. `CodePipeline.extractDiff(workspaceOutputDir)` — get PatchSet
2. If no changes → return early with success (no deploy needed)
3. `CodePipeline.applyPatch(patchSet)` — apply with guardrail checks
4. If merge fails (immutable kernel violation / guardrail block) → return failure
5. `DeployManager.createBackup()` — snapshot before build
6. `DeployManager.commitChanges(patchSet)` — commit to git
7. `DeployManager.runBuild()` — compile TypeScript
8. If build fails → `DeployManager.rollbackCommit()` → return failure
9. `QaRunner.runPageTests()` + `runApiTests()` — automated QA
10. If QA fails → `DeployManager.rollbackCommit()` → return failure
11. Return success with commit hash + QA results

---

## Activation Status

All Phase 16 components are implemented in `pando-final/src`. The running node needs a restart to pick up the compiled dist. The `/pipeline/run` API endpoint is currently returning 404 — this may be because the running node binary predates Phase 16 or the route registration is not yet active.

**To activate:**
1. Rebuild: `cd pando-final && npm run build`
2. Restart the pando node process
3. Verify: `POST /pipeline/run` returns 200

---

## Known Blockers (as of 2026-02-26)

1. `/pipeline/run` endpoint returns 404 on running node — pipeline cannot be triggered via API
2. `/agents/spawn` returns 404 — manager cannot delegate tasks to specialist agents
3. All changes confirmed in `pando-final/src` and `Desktop/pando/dist` but not yet active on the live node

## Related Phases

- **Phase 17:** QA Tier Classification (17.1) + QA Agent Spawning with Playwright MCP (17.2) — extend Phase 16 QA
- **Phase 18:** Smart Router (18.1) + Unified Input Gateway (18.2) + Conversation Threads (18.3, done) + Context Detection (18.4) + Complexity Estimation (18.5)
