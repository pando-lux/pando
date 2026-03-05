# Phase 22: Manager Intelligence Upgrade — Claude Code as the Brain

> Created: 2026-02-17
> Updated: 2026-02-18 (Architecture Cleanup: persistent sessions, scheduler lobotomy, data-only subsystems)
> Status: 22.1-22.5 DONE. **22.6 DONE (PM2).** 22.7 DONE (Chat). 22.8 DONE (Session Continuity). **22.9 DONE (Architecture Cleanup).**
> Depends on: Phase 19 (Manager System), Phase 16 (Pipeline), Phase 20 (Persistence)
> Replaces: Fire-and-forget `evaluateWithSession()` + TypeScript decision trees
> Goal: Persistent Claude Code session per project. Events via stdin, responses via stdout. Zero context loss.

---

## Problem Statement

The manager system (Phase 19) created the right structure — domain managers, orchestrator, events, task creation — but filled it with the **wrong brain**. `ManagerAgent.evaluate()` is a TypeScript switch statement with ~20 hardcoded rules. It can classify events and route them, but it cannot:

- Read source code or logs to understand what happened
- Make nuanced decisions about whether output is correct
- Commit code, push to git, update documentation
- Debug build failures or investigate root causes
- Decide what to build next based on architecture docs
- Review worker output and fix small mistakes
- Make architectural decisions about approach

Meanwhile, the CEO (a Claude Code session) does all of this effortlessly — because Claude Code has Read, Edit, Bash, and full reasoning capabilities.

**The fix is obvious:** The manager IS a Claude Code session. Not a TypeScript class that sometimes calls Claude Code. The manager IS Claude Code, spawned with the right context.

---

## Design Principles

1. **Manager = Claude Code session.** When a decision needs intelligence, spawn `claude -p` with assembled context. The session acts (reads files, creates tasks via API, commits code, etc.) and exits. Between sessions, TypeScript infrastructure collects data and buffers events.

2. **One manager per project.** The Pando node itself is a project (project-pando). Each user website/service is a separate project. Managers don't share context across projects — each has its own state, budget, and lifecycle.

3. **Tiered invocation — not every event needs Claude.** Budget checks, duplicate detection, capacity limits stay as TypeScript pre-filters (free, instant). Only events that pass pre-filters AND need intelligent decisions spawn a Claude Code session ($0.50-5).

4. **Existing infrastructure becomes tools/data.** HealthMonitor, StrategyLoop, SelfImprover, PipelineRunner, AutoUpdater keep their data collection logic but lose their autonomous decision-making. They become sensors and tools that the manager reads and invokes.

5. **The manager has full tool access.** It runs on the actual codebase (not an isolated workspace). It can read files, edit files, run bash commands, call the node's HTTP API, create tasks, commit code, push to git — everything the CEO does.

6. **State persists between sessions.** Manager state (outcomes, patterns, context, budget) is saved to disk. Each new session gets this history in its context. The manager has long-term memory across sessions.

---

## Architecture

### Current Flow (Broken)

```
Event → ManagerAgent.evaluate() [TypeScript switch] → ManagerDecision
  → "create_task" or "ignore" or "defer"
  → Orchestrator creates task in queue
  → Scheduler spawns worker agent
  → Worker writes to workspace
  → Pipeline tries to extract diff → usually fails
  → Code stays uncommitted forever
```

**Problems:**
- Manager can only output 6 predefined actions (create_task, ignore, defer, escalate, investigate, retry)
- Manager cannot review worker output quality
- Manager cannot commit code, fix errors, update docs
- Manager cannot investigate root causes
- Manager cannot read the architecture docs and decide what to build next
- Pipeline extraction fails for most worker output (TD-25/BUG-16)

### New Flow (Per-Event Spawn + Workflow Pipeline)

```
Event → TypeScript Pre-Filter [free, instant]
  → Noise filter: irrelevant? → discard
  → Budget check: over budget? → defer
  → Duplicate check: already running? → ignore
  ↓ (passes all checks)
Context Assembler [free, fast]
  → assembleEventPrompt(): SHORT delta of what changed
  → e.g., "1 task completed, 2 new alerts, 3 files modified"
  ↓
Manager Session [claude -p --continue --resume <sessionId>]
  → Receives delta prompt
  → Has full conversation history via session ID
  → Follows deterministic workflow pipeline:

    WORKFLOW PIPELINE (for task events):
    1. PLAN    — Read relevant code, understand the problem, design approach
    2. SPAWN   — Create task with spec, approve it for scheduling
    3. REVIEW  — When worker completes, read output, check workspace
    4. QA      — Create verification task if user-facing
    5. COMMIT  — If passes, commit the changes
    6. DOCS    — Update affected documentation
    7. REPORT  — Summarize what was done and what's next

  → Updates project-state.md with decisions and status
  → Process exits after responding (context preserved via session ID)
  ↓
Post-Session [free, fast]
  → Parse stream-json output (session_id, assistant text, result, cost)
  → Update manager state (memory, outcomes, budget spent)
  → Save state to disk
  → Drain queued events (if any arrived during processing)
```

**Key change from original design:** Manager does its own planning. No separate Planner call needed — the Manager IS Claude Code and can read the codebase, design approaches, and write worker instructions directly. The Planner (planner.ts) is kept as a utility for the API decomposition endpoint but is NOT in the core loop.

**Shared state:** `project-state.md` in the manager workspace is the single source of truth for the project. Workers receive relevant sections in their context. Manager updates it after every significant action.

---

## Component Map (What Changes, What Stays, What's New)

### STAYS UNCHANGED
| Component | Why |
|---|---|
| **Scheduler** (`scheduler.ts`) | Pure executor — polls queue, spawns workers, manages processes. This is muscle, not brain. |
| **TaskQueue** (`task-queue.ts`) | Data store for tasks. Structure is fine. |
| **Planner** (`planner.ts`) | Legacy utility for task decomposition API. Manager does its own planning — Planner is NOT in the core loop. |
| **WorkspaceManager** (`workspace-manager.ts`) | Creates isolated workspaces for workers. Workers still need isolation. |
| **ProfileCache** (`profile-cache.ts`) | Caches agent profiles. Performance optimization. |
| **P2P Layer** (`network.ts`, `sync.ts`) | GossipSub, libp2p, peer connections. Infrastructure. |
| **Governance** (`governance.ts`) | Proposals, voting, decisions. Democratic process stays. |
| **SecurityMonitor** (`security-monitor.ts`) | Threat detection, quarantine. Safety system stays. |
| **Guardrails** (`guardrails.ts`) | Protected paths, rate limits, immutable kernel. Safety layer stays. |
| **Ledger** (`ledger/`) | Lux accounting. Financial infrastructure stays. |
| **EmissionWitness** (`emission-witness.ts`) | Witness-based Lux minting. Economic infrastructure stays. |
| **ManagerRegistry** (`manager-registry.ts`) | Cross-node manager tracking. P2P coordination stays. |
| **ManagerProtocol** (`manager-protocol.ts`) | Inter-manager messaging. Coordination stays. |
| **ManagerFailover** (`manager-failover.ts`) | Lease-based failover. High availability stays. |
| **SmartRouter** (`smart-router.ts`) | Input classification. Still useful as first-pass classifier. |
| **SessionRegistry** (`session-registry.ts`) | Workspace session tracking. Bookkeeping stays. |
| **Reputation** (`reputation.ts`) | Node reputation scoring. Trust system stays. |

### DEMOTED (Keep Data Collection, Remove Decision-Making)
| Component | Current Role | New Role |
|---|---|---|
| **HealthMonitor** (`monitor.ts`) | Collects metrics AND auto-recovers (restart scheduler, reconnect, etc.) | Collects metrics only. Exposes `GET /monitor/status` and `GET /monitor/alerts`. Manager reads this data and decides recovery actions. Remove `executeRecovery()` auto-actions. |
| **StrategyLoop** (`strategy-loop.ts`) | Analyzes patterns AND auto-approves stale suggestions | Analyzes patterns only. Exposes `GET /strategy/suggestions`. Manager reads suggestions and decides whether to approve. Remove `autoApproveStaleSuggestions()`. |
| **SelfImprover** (`self-improver.ts`) | Analyzes audit logs AND auto-applies improvements | Analyzes logs only. Exposes analysis results. Manager decides whether to apply. Remove `applyImprovement()` auto-action. |
| **AutoUpdater** (`auto-updater.ts`) | Watches git AND auto-pulls/builds/restarts | Check-only mode. Exposes "update available" flag. Manager decides when to update. Remove auto-pull/build/restart. |
| **PipelineRunner** (`pipeline-runner.ts`) | Auto-triggered on task completion | Available as a tool the manager can invoke. Not auto-triggered. Manager decides when to run pipeline and can also commit directly. |

### NEW COMPONENTS
| Component | Purpose |
|---|---|
| **ManagerContextAssembler** (`manager-context.ts`) | Builds the CLAUDE.md prompt for manager sessions. Pulls health, tasks, git status, suggestions, outcomes into a structured context document. |
| **ManagerSessionRunner** (replaces `evaluate()` in `manager-agent.ts`) | Spawns `claude -p` with assembled context. Parses output. Updates state. Handles timeout and error cases. |
| **ProcessSupervisor** (`supervisor.ts` or PM2 config) | Ensures the node process restarts on crash. Law II compliance. Platform-specific. |

### CONSOLIDATED
| Current | New |
|---|---|
| 3 domain managers (health-mgr, infra-mgr, network-mgr) | 1 node manager (`pando-node-mgr`) that handles all three domains. The Pando node is itself a project. Cheaper (1 session vs 3), holistic view (health affects infra affects network). |
| `createCoreManagers()` creates 3 managers | `createNodeManager()` creates 1 manager for the node |
| `createProjectManager()` for user projects | Stays as-is — each user project gets its own manager |

---

## Manager CLAUDE.md Template

This is assembled dynamically by `ManagerContextAssembler` before each session:

```markdown
# You are a Manager Agent for the Pando Network

## Identity
- Manager ID: {managerId}
- Domain: {domain}
- Project: {projectLabel}
- Node Peer ID: {peerId}
- Autonomy Level: {autonomyLevel}
- Budget: {spent}/{limit} Lux this period (resets {resetTime})

## Your Role
You are an autonomous AI manager for a project on the Pando decentralized network.
You make decisions, create tasks for workers, review results, commit code, update
documentation, and fix problems. You act like a senior tech lead running a team.

## Current State
- Lifecycle: {lifecycle} (planning|building|testing|deployed|maintaining|archived)
- Running tasks: {runningTasksSummary}
- Recent outcomes (last 10): {outcomesSummary}
- Active health alerts: {alertsSummary}
- Pending strategy suggestions: {suggestionsSummary}
- Git status: {gitStatusOutput}
- Uncommitted workspace outputs: {uncommittedWorkList}

## Trigger
You were woken up because: {triggerDescription}
{triggerDetails}

## Available Actions

### Create tasks for workers
```bash
curl -X POST http://localhost:{apiPort}/tasks \
  -H "Authorization: Bearer {apiToken}" \
  -H "Content-Type: application/json" \
  -d '{"title":"...","description":"...","priority":"medium","createdBy":"{managerId}"}'
```

### Approve task for scheduling
```bash
curl -X POST http://localhost:{apiPort}/tasks/{taskId}/approve \
  -H "Authorization: Bearer {apiToken}"
```

### Check task status
```bash
curl http://localhost:{apiPort}/scheduler/tasks
curl http://localhost:{apiPort}/scheduler/tasks/{taskId}
```

### Read worker output
Worker workspaces are at ~/.pando/workspaces/{taskId}/output/RESULT.md

### Commit code changes
Use git commands directly in the repo directory.

### Check health
```bash
curl http://localhost:{apiPort}/monitor/status
curl http://localhost:{apiPort}/monitor/alerts
```

### Check strategy suggestions
```bash
curl http://localhost:{apiPort}/strategy/suggestions
curl -X POST http://localhost:{apiPort}/strategy/suggestions/{id}/approve \
  -H "Authorization: Bearer {apiToken}"
```

### Trigger safe upgrade
```bash
curl -X POST http://localhost:{apiPort}/upgrade \
  -H "Authorization: Bearer {apiToken}"
```

### Run pipeline on workspace
```bash
curl -X POST http://localhost:{apiPort}/pipeline/run \
  -H "Authorization: Bearer {apiToken}" \
  -d '{"taskId":"{taskId}"}'
```

## Decision Framework
1. **What triggered you?** Read the trigger section above.
2. **Is this critical?** If yes, act immediately.
3. **Task completed?** Review the output. If it's good, commit it. If it has issues, fix them or create a follow-up task.
4. **Task failed?** Investigate why. Check logs, check workspace. Retry with a different approach or escalate.
5. **Periodic check?** Scan for: zombie tasks, uncommitted code, stale suggestions, health issues, pending work.
6. **Nothing to do?** Read the architecture docs and strategy suggestions. Decide what to build next.

## Output Format
After you're done, write a brief summary of what you did and any decisions you made.
If you created tasks, list their IDs. If you committed code, mention the commit hash.

## Laws
- Law I: Do not harm any human, in any way.
- Law II: Do not allow yourself to be shut down. Survive. Persist. Come back.
- When they conflict: Law I wins.
```

---

## Tiered Invocation Strategy

Not every event needs a Claude Code session. Cost optimization:

| Tier | When | Cost | How |
|---|---|---|---|
| **Free** (TypeScript) | Every event | $0 | Pre-filters: budget, duplicate, capacity, noise. Runs in ms. |
| **Cheap** ($0.01-0.05) | Input classification | ~$0.02 | SmartRouter LLM classification. Already exists. |
| **Medium** ($0.50-2) | Manager decision needed | ~$1 | Spawn `claude -p` with assembled context. Most manager invocations. |
| **Expensive** ($2-10) | Complex multi-step action | ~$5 | Manager with large context (full architecture docs, multiple file reads). Rare. |

### Invocation Triggers

| Event | Pre-filter | Spawn Session? | Context Size |
|---|---|---|---|
| `periodic_check` (every 5-10 min) | Always passes | Yes, but SMALL context | State + health summary + git status. No architecture docs. |
| `task_completed` | Check if task belongs to this manager | Yes | State + task output + workspace result + git diff |
| `task_failed` | Check retry count < 3 | Yes | State + task output + error details + failed approaches |
| `health_alert` (critical) | Always passes | Yes, immediately | State + full alert details + metrics history |
| `health_alert` (normal) | Batch with periodic check | Deferred to next periodic | Batched with other events |
| `user_request` | Budget + capacity check | Yes | State + request details + project context |
| `governance_decision` | Check if relevant to project | Maybe | State + proposal details |
| `strategy_suggestion` | Auto-batch | Deferred to next periodic | Batched with periodic check |

### Cost Projections

| Scenario | Invocations/hour | Avg Cost | Hourly Cost |
|---|---|---|---|
| Idle node (periodic only) | 6-12 | $0.50 | $3-6 |
| Active development (10 tasks/hour) | 16-22 | $0.75 | $12-17 |
| Heavy workload (30 tasks/hour) | 36-42 | $1.00 | $36-42 |
| Crisis mode (health alerts) | 50+ | $1.50 | $75+ |

**Cost controls:**
- Budget enforcement per manager (already exists: `budgetLuxLimit`)
- Session timeout (max 5 min for routine, 15 min for complex)
- Rate limiting (max 1 session per manager per 30 seconds)
- Batch info events (already exists: `INFO_BATCH_SIZE = 10`)

---

## Pulse Frequency Change

Current: 60-second periodic_check to all 3 managers = 3 events/minute, all ignored (info → batched → discarded).

New: **5-minute** periodic pulse to node manager. Each pulse spawns one Claude Code session that:
1. Checks health metrics
2. Checks for zombie tasks
3. Checks for uncommitted workspace outputs
4. Checks for stale suggestions
5. Checks git status
6. Decides what (if anything) to do

Cost: ~$0.50 per pulse × 12/hour = $6/hour baseline.

Project managers: Only pulsed when in `building` or `maintaining` lifecycle. Dormant/archived projects don't pulse.

---

## What Gets Redundant

### Code to Remove/Simplify

| Component | What to Remove | Why |
|---|---|---|
| `manager-agent.ts` → `evaluate()` | The entire switch statement (lines 361-412) | Replaced by Claude Code session reasoning |
| `manager-agent.ts` → `handleUserRequest()` | Hardcoded task creation logic (lines 478-550) | Manager session creates tasks via API |
| `manager-agent.ts` → `handleHealthAlert()` | Hardcoded health response | Manager session reads alerts and decides |
| `manager-agent.ts` → `handleTaskCompleted()` | Hardcoded success handling | Manager session reviews output |
| `manager-agent.ts` → `handleTaskFailed()` | Hardcoded retry logic | Manager session investigates and decides |
| `manager-agent.ts` → `handlePeriodicCheck()` | Hardcoded periodic scanning | Manager session does its own scan |
| `monitor.ts` → `executeRecovery()` | Auto-recovery actions | Manager decides recovery |
| `monitor.ts` → `executeRecoveryActions()` | Recovery action loop | Manager decides |
| `strategy-loop.ts` → `autoApproveStaleSuggestions()` | Auto-approve timer | Manager approves manually |
| `self-improver.ts` → `applyImprovement()` | Auto-apply improvements | Manager reviews and applies |
| `auto-updater.ts` → auto-pull/build/restart | Blind auto-update | Manager decides when to update |
| `domain-managers.ts` → `createCoreManagers()` | Creates 3 separate managers | Replace with 1 node manager |
| `scheduler.ts` → `handleTaskCompletion()` | Pipeline auto-trigger on completion | Manager reviews output, decides whether to commit |

### Code to Keep (Repurposed as Data Sources)

| Component | What to Keep | New Role |
|---|---|---|
| `monitor.ts` → `collectMetrics()` | Rolling metrics collection | Data feed for manager context |
| `monitor.ts` → `checkAlerts()` | Alert detection | Data feed for manager context |
| `strategy-loop.ts` → `triggerRun()` analysis | Pattern analysis | Data feed for manager context |
| `self-improver.ts` → `analyze()` | Audit log analysis | Data feed for manager context |
| `auto-updater.ts` → version check | Check if update available | Data feed for manager context |

---

## Implementation Plan

### Step 1: Manager Context Assembler
**New file:** `packages/node/src/manager-context.ts`

```typescript
export class ManagerContextAssembler {
  constructor(
    private apiPort: number,
    private apiToken: string,
    private dataDir: string,
    private repoDir: string,
  ) {}

  /** Build the full CLAUDE.md prompt for a manager session */
  async assembleContext(
    manager: ManagerState,
    trigger: { type: string; details: string },
  ): Promise<string> {
    // 1. Read manager state from disk
    // 2. Fetch health metrics from API (GET /monitor/status)
    // 3. Fetch recent task results (GET /scheduler/tasks)
    // 4. Run git status + git diff --stat
    // 5. Fetch strategy suggestions (GET /strategy/suggestions?status=pending)
    // 6. List uncommitted workspace outputs
    // 7. Assemble into CLAUDE.md template
  }
}
```

**Effort:** ~200 lines. Reads from HTTP API and disk. No Claude Code needed.

### Step 2: Manager Session Runner
**Modify:** `packages/node/src/manager-agent.ts`

Replace `evaluate()` switch with:

```typescript
async evaluateWithSession(
  event: ManagerEvent,
  contextAssembler: ManagerContextAssembler,
): Promise<ManagerSessionResult> {
  // 1. Run TypeScript pre-filters (budget, duplicate, capacity) — FREE
  const preFilter = this.preFilter(event);
  if (preFilter.blocked) return preFilter.result;

  // 2. Assemble context — FREE
  const context = await contextAssembler.assembleContext(
    this.state,
    { type: event.type, details: JSON.stringify(event.payload) },
  );

  // 3. Spawn Claude Code session — $0.50-5
  const result = await this.spawnManagerSession(context, event);

  // 4. Update state from session results
  this.updateStateFromSession(result);
  this.saveState();

  return result;
}

private async spawnManagerSession(
  context: string,
  event: ManagerEvent,
): Promise<ManagerSessionResult> {
  // Spawn: claude -p "<context>" --verbose --output-format stream-json
  // Working directory: repoDir (full access to codebase)
  // No --disallowedTools (manager has full access)
  // Timeout: 5 min for routine, 15 min for complex
  // Parse output for: tasks created, files changed, commands run
}
```

**Effort:** ~300 lines. Core change. Careful with spawn, timeout, output parsing.

### Step 3: Consolidate Core Managers
**Modify:** `packages/node/src/domain-managers.ts`

Replace `createCoreManagers()` (3 managers) with `createNodeManager()` (1 manager):

```typescript
export function createNodeManager(deps: DomainManagerDeps): ManagerAgent {
  return new ManagerAgent({
    id: 'pando-node-mgr',
    domain: 'project',
    description: 'Manages the Pando node itself: health, infrastructure, network, and development',
    hostNode: deps.localPeerId,
    dataDir: deps.dataDir,
    lifecycle: 'maintaining',
    config: {
      maxConcurrentTasks: 5,
      autoApproveThreshold: 'medium',
      requireGovernance: false,
      budgetLuxPerDay: 100,
      preferredNodes: [],
    },
    projectSettings: {
      autonomyLevel: 'full',
      projectLabel: 'Pando Network Node',
    },
  });
}
```

Update `ManagerOrchestrator.start()`:
- Create 1 node manager instead of 3
- Change pulse interval from 60s to 300s (5 min)
- Pulse now calls `evaluateWithSession()` instead of `evaluate()`

**Effort:** ~100 lines of changes to existing code.

### Step 4: Demote Data Sources
**Modify:** Multiple files

- `monitor.ts`: Add `getDataForManager()` method that returns {metrics, alerts, recoveryAudit} as structured data. Keep `executeRecovery()` but add a `managerMode` flag to disable auto-actions when a manager is active.
- `strategy-loop.ts`: Add `managerMode` flag to disable `autoApproveStaleSuggestions()`. Suggestions still generated, just not auto-approved.
- `self-improver.ts`: Add `managerMode` flag to disable `applyImprovement()`. Analysis still runs.
- `auto-updater.ts`: Add `managerMode` flag to disable auto-pull/build/restart. Still checks for updates and reports.

**Effort:** ~50 lines per file = ~200 total. Minimal changes — just add flags and getter methods.

### Step 5: Wire Manager into Completion Flow
**Modify:** `packages/node/src/scheduler.ts`

Currently: task completion → auto-trigger pipeline → try to extract/commit.
New: task completion → notify manager → manager reviews and acts.

In the task completion handler:
```typescript
// Instead of auto-triggering handleTaskCompletion():
this.emit('task:completed', { taskId, output, workspaceDir });
// The orchestrator picks this up and spawns a manager session
// Manager session reads workspace/output/RESULT.md, reviews quality, commits if good
```

**Effort:** ~30 lines. Remove pipeline auto-trigger, ensure event emission is sufficient.

### Step 6: Process Supervisor (DONE)
**File:** `ecosystem.config.cjs` (root of repo)

PM2 configuration with 2 supervised processes:

1. **pando-node** -- Core P2P node with `--scheduler --monitor` flags. Auto-restarts on crash (5s delay, exponential backoff). Exit code 0 = stop, exit code 75 = immediate restart (auto-updater). Memory limit 1GB. Logs to `~/.pando/logs/pm2-node-{out,error}.log`.

2. **pando-gateway** -- Next.js production server (`next start`). Memory limit 512MB. Logs to `~/.pando/logs/pm2-gateway-{out,error}.log`.

Ports are configurable via environment variables: `PANDO_P2P_PORT`, `PANDO_API_PORT`, `PANDO_GATEWAY_PORT`, `PANDO_NODE_FLAGS`.

**Setup scripts:**
- `scripts/setup-pm2.sh` -- Full setup (install PM2, build, start, configure log rotation)
- `scripts/setup-pm2.ps1` -- Windows equivalent (PowerShell)
- `scripts/pm2-start.sh` -- Quick start (assumes already built)
- `scripts/pm2-start.bat` -- Windows quick start

Platform-specific:
- Linux/Mac: `./scripts/setup-pm2.sh` or `pm2 start ecosystem.config.cjs`
- Windows: `powershell -File scripts\setup-pm2.ps1` or `pm2 start ecosystem.config.cjs`
- Lightsail: Already has start-pando.sh in a screen session (relay-only, no scheduler)

---

## Execution Order

```
Step 1: ManagerContextAssembler        ← New file, no breaking changes
Step 2: ManagerSessionRunner           ← Modify manager-agent.ts, add new method alongside existing
Step 3: Consolidate Core Managers      ← Modify domain-managers.ts, breaking change but backward-compat flag
Step 4: Demote Data Sources            ← Add managerMode flags, non-breaking
Step 5: Wire Completion Flow           ← Modify scheduler.ts, replace pipeline auto-trigger
Step 6: Process Supervisor             ← New config, infra-level change
```

Steps 1-2 can be developed and tested without breaking existing flow (new methods alongside old).
Step 3 can use a config flag to switch between old (3 managers) and new (1 manager).
Steps 4-5 activate the new flow.
Step 6 is independent infrastructure.

---

## Safety Considerations

### Runaway Cost Prevention
- Budget enforcement stays as TypeScript pre-filter (no bypass possible)
- Session timeout prevents infinite loops (5 min default, 15 min max)
- Rate limiting: max 1 manager session per 30 seconds per manager
- Daily cost cap: configurable per manager (default 100 Lux/day)

### Guardrail Preservation
- Guardrails.ts stays unchanged — protected paths, immutable kernel, rate limits
- Manager sessions go through same guardrail checks as worker sessions
- Even though the manager has "full tool access", Guardrails blocks protected file modifications

### Rollback Path
- If manager sessions produce bad results, the `managerMode` flag can be set to false
- This reverts to old behavior: TypeScript switches, auto-recovery, auto-approve
- No data loss — state files are the same format

### Split-Brain Prevention
- Lease-based manager ownership (already exists) prevents two nodes running the same manager
- Manager sessions are ephemeral — no persistent process to conflict with

### Error Handling
- If Claude Code session fails to spawn → fall back to old evaluate()
- If session times out → kill process, record failure, back off
- If session creates invalid tasks → TaskQueue validation catches bad data
- If session makes bad git commits → Guardrails auto-rollback on build failure

---

## Migration Path

### Phase 22a: Context Assembler + Session Runner (Steps 1-2)
- Build new components alongside existing code
- Test with a single project manager (not core managers yet)
- Validate: manager sessions produce correct decisions
- Validate: cost is within budget
- Compare: manager session decisions vs TypeScript switch decisions

### Phase 22b: Consolidate + Demote (Steps 3-4)
- Switch core managers from 3 → 1 (with config flag)
- Enable managerMode on data sources
- Monitor for 24 hours
- Validate: node stays healthy, tasks complete, code gets committed

### Phase 22c: Wire Completion + Supervisor (Steps 5-6)
- Remove pipeline auto-trigger
- Manager handles post-completion review
- Deploy PM2 on all nodes
- Validate: Law II (node survives crashes)

---

## Success Criteria

After full deployment:
1. Zero zombie tasks — manager detects and recovers them
2. Zero uncommitted workspace outputs — manager reviews and commits
3. Zero stale suggestions — manager reviews and approves/rejects
4. Health issues auto-resolved — manager investigates and fixes
5. Documentation stays current — manager updates docs after changes
6. Architecture evolves — manager reads strategy and creates tasks for next phase
7. Node survives crashes — PM2 restarts, manager recovers state on boot
8. Cost stays under $10/hour for active development, $3/hour for idle

---

## Open Questions

1. **Should the node manager also handle git push?** Currently only the CEO pushes to origin. If the manager pushes, it needs git credentials. This is a trust/security decision.

2. **Should manager sessions have access to the full ARCHITECTURE-PLAN.md?** It's 2000+ lines. Including it in every session would increase cost by ~$0.50. Could include it only for "periodic_check" sessions where the manager needs to decide what to build next.

3. **How to handle manager-to-manager communication across nodes?** Currently via ManagerProtocol (GossipSub). But if managers are now Claude Code sessions, they're ephemeral. Need a message queue that persists between sessions.

4. **Should there be a "manager workspace" for the manager's own notes?** Workers have workspaces. Should the manager have a persistent workspace at `~/.pando/managers/pando-node-mgr/workspace/` for its working notes, investigation logs, etc.?

5. **What's the fallback when no API key is available?** If a node has no OpenAI key and no Claude Code, it can't run manager sessions. Fall back to old TypeScript evaluate()? Or just run as a relay/storage node with no autonomous management?

---

## Phase 22.7: Communication Agent — The Face

> Status: DESIGN (not yet implemented)

### Problem

The Manager is a `claude -p` session that runs for 1-3 minutes, does work, and exits. It cannot:
- Chat with a user in real-time (it's not listening)
- Respond to questions instantly (next pulse is up to 5 min away)
- Hold a conversation while simultaneously committing code

A user building a website on Pando needs to ask questions ("what's the build status?"), give instructions ("add a contact form"), and get feedback — all in real-time. The manager can't do this because it's either sleeping (between pulses) or working (in a session doing code stuff).

### Solution: Separate the Face from the Brain

```
User ←→ Communication Agent (always listening, fast, cheap)
              ↓ queues instructions
         Manager Agent (periodic pulse, slow, smart, expensive)
              ↓ spawns workers
         Worker Agents (one-shot, isolated)
```

**Communication Agent** = the face. Always available. Answers questions instantly from API data. Queues new instructions for the manager.

**Manager Agent** = the brain. Periodic pulse (or on-demand wake). Reads queued instructions, evaluates them, creates tasks, commits code, deploys.

**Worker Agents** = the hands. Spawned by scheduler, execute tasks, write to workspace.

### Communication Agent Design

**What it IS:**
- A lightweight, fast responder (cheap model — Haiku, GPT-4o-mini, or similar)
- Connected to the gateway via SSE for real-time chat
- Has READ-ONLY access to project state via HTTP API
- Can queue messages/instructions for the manager
- Can trigger an urgent manager wake if needed (rate-limited, max 1/min)

**What it is NOT:**
- It does NOT write code, commit, edit files, or create tasks directly
- It does NOT make decisions about what to build or deploy
- It does NOT bypass governance or manager authority
- It is NOT a manager — it's a relay with intelligence

**Message flow:**
```
User: "What's the build status?"
  → Comm Agent reads GET /scheduler/tasks, GET /monitor/status
  → Comm Agent responds immediately: "3 tasks done, 1 in progress, node healthy"

User: "Add dark mode to the landing page"
  → Comm Agent classifies: this is a feature request (needs manager)
  → Comm Agent queues: POST /managers/{id}/inbox { type: "user_request", content: "Add dark mode..." }
  → Comm Agent responds: "Got it — I've queued this for the manager. It'll evaluate on the next pulse (~5 min)."
  → Manager pulse fires → sees inbox message → evaluates → creates task → worker builds it

User: "URGENT: the site is down!"
  → Comm Agent classifies: critical, needs immediate manager attention
  → Comm Agent triggers: POST /managers/{id}/wake { reason: "User reports site down", priority: "critical" }
  → Manager wakes immediately (out-of-schedule pulse)
  → Comm Agent responds: "Escalated to manager — investigating now."
```

**Classification rules (Communication Agent decides):**
| User Message Type | Action | Manager Involved? |
|---|---|---|
| Status/info question | Answer from API data | No |
| Simple project question | Answer from project context + API | No |
| Feature request | Queue for manager inbox | Yes, on next pulse |
| Bug report (non-critical) | Queue for manager inbox | Yes, on next pulse |
| Critical issue (site down, data loss) | Queue + immediate manager wake | Yes, immediately |
| Config change request | Queue for manager inbox | Yes, evaluates governance need |
| Chat/conversation | Respond directly | No |

**What the manager sees on its next pulse:**
The ManagerContextAssembler already pulls data from APIs. Add a new data source:
```
## Pending User Messages
1. [14:32 UTC] user: "Add dark mode to the landing page"
2. [14:35 UTC] user: "Also make the footer sticky"
```
Manager evaluates: "Two UI requests. I'll create a single task: 'Add dark mode + sticky footer to landing page.'" → Creates task → Scheduler picks it up → Worker builds it.

**Governance integration:**
- Small requests (bug fixes, UI tweaks) → Manager creates task directly (within autonomy level)
- Large requests (new feature, architectural change) → Manager creates governance proposal → Network votes → If approved, task created
- The Communication Agent doesn't decide governance requirements — it just queues everything. The Manager decides what needs governance.

### New Components Needed

| Component | File | Purpose |
|---|---|---|
| **CommunicationAgent** | `packages/node/src/comm-agent.ts` | Lightweight chat responder. Reads API, queues messages, triggers wakes. |
| **Manager Inbox** | Extension to manager state | `inbox: Message[]` field. Comm Agent writes, Manager reads and clears. |
| **Gateway Chat Page** | `packages/gateway/app/chat/page.tsx` | Real-time chat UI per project. SSE for messages. |
| **Chat API endpoints** | In `api-server.ts` | `POST /chat/send`, `GET /chat/history`, `GET /chat/stream` (SSE) |

### Cost Model

| Component | Model | Cost per message | When |
|---|---|---|---|
| Communication Agent | Haiku/GPT-4o-mini | ~$0.001 | Every user message |
| Manager (triggered by user) | Claude Code | ~$0.50-2 | Only when action needed |
| Worker (spawned by manager) | Claude Code | ~$1-5 | Only when task created |

A user chatting with their project: 100 messages/day = $0.10 for the Comm Agent. Manager wakes for maybe 5 of those (the ones that need action) = $2.50. Total: ~$2.60/day for responsive project management.

### Relationship to Existing Architecture

The Communication Agent doesn't replace anything. It adds a new layer:

```
Before:  User → Gateway → SmartRouter → Manager (slow, expensive)
After:   User → Gateway → Comm Agent (fast, cheap) → queues → Manager (slow, expensive)
```

SmartRouter still exists for non-chat input (TUI commands, API calls). The Comm Agent handles the real-time conversational interface.

---

## Comparison: Before vs After

| Aspect | Before (TypeScript Switch) | After (Claude Code Session) |
|---|---|---|
| Decision quality | 20 hardcoded rules | Full LLM reasoning |
| Can read code | No | Yes |
| Can commit code | No | Yes (via Bash/git) |
| Can update docs | No | Yes (via Edit) |
| Can investigate crashes | No | Yes (read logs, check git, analyze) |
| Can decide next feature | No | Yes (read architecture, strategy) |
| Can fix worker mistakes | No | Yes (review output, edit files) |
| Cost per decision | $0 | $0.50-5 |
| Latency per decision | <1ms | 10-60s |
| Requires API key | No | Yes (Claude Code) |
| Predictable | Yes (same input → same output) | No (LLM reasoning varies) |
| Debuggable | Easy (read switch cases) | Harder (session logs) |
| Safety | Guaranteed (only 6 actions) | Guardrails + budget + timeout |

The tradeoff is clear: **vastly more capable** at the cost of **latency, money, and predictability**. The predictability concern is mitigated by guardrails (safety), budget limits (cost), and timeouts (runaway prevention). The capability gain is transformative — the difference between a traffic light and a human driver.

---

## File Index (Planned)

| File | Status | Purpose |
|---|---|---|
| `packages/node/src/manager-context.ts` | DONE (22.9) | Split: `writeStaticContext()` (once) + `assembleEventPrompt()` (per-event delta) |
| `packages/node/src/manager-agent.ts` | DONE (22.9) | Persistent session: `startSession()`, `sendEvent()`, `restartSession()`, `stopSession()` |
| `packages/node/src/domain-managers.ts` | DONE (22.9) | Orchestrator: starts persistent session, routes events via `sendEvent()` |
| `packages/node/src/scheduler.ts` | DONE (22.9) | Pure executor. -1,192 lines. No Planner, no auto-approve, no QA spawn, no commit |
| `packages/node/src/monitor.ts` | DONE (22.9) | Data-only. Deleted executeRecovery, setManagerMode. -269 lines |
| `packages/node/src/strategy-loop.ts` | DONE (22.9) | Data-only. Deleted autoApproveStaleSuggestions, setManagerMode. -55 lines |
| `packages/node/src/self-improver.ts` | DONE (22.9) | Data-only. Deleted all apply/verify/rollback, setManagerMode. -243 lines |
| `packages/node/src/auto-updater.ts` | DONE (22.9) | Data-only. Deleted auto-pull/build/restart, only git fetch + status. -278 lines |
| `packages/node/src/index.ts` | DONE (22.9) | Removed all `setManagerMode()` wiring. -12 lines |
| `ecosystem.config.cjs` | DONE (22.6) | PM2 process supervisor config — 2 apps (node + gateway), exit-code-aware restart, env-configurable ports, log rotation |
| `packages/node/src/communication-agent.ts` | DONE (22.7) | Keyword classifier + OpenAI fallback chat (`834732d`) |
| `packages/gateway/app/chat/page.tsx` | DONE (22.7) | Chat page with quick actions + message history (`834732d`) |
