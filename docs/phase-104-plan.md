# Phase 104: Universal Project Pipeline

## The Core Idea

Every orchestrator — whether managing Pando's infrastructure (the "council") or building a user's landing page — is the **same class** with the same tick loop, AI brain, worker spawn, QA cycle, and retry logic. What differs is the config and callbacks.

**Council** = the orchestrator for the "pando" project.
**Project manager** = an orchestrator for a user's project.
Same machine. Different instructions.

```
User: "fix the wallet bug"          → doorman → council orchestrator
User: "build me a landing page"     → doorman → project orchestrator (new or resumed)
Marketplace: "pando" project page   → chat → council orchestrator
```

---

## What's Broken Today

| Gap | Root Cause |
|---|---|
| Project orchestrators never start | `getOrchestratorForProject()` creates a DB row only — no live Orchestrator, no tick loop |
| Workers build in wrong place | `process.cwd()` = Pando repo root for ALL workers, even user app builders |
| No deploy pipeline | `onDeploy` callback exists in interface, never wired for any orchestrator |
| No project docs | No CLAUDE.md or project-state.md in project workspace |
| No resume from GitHub | Git clone not triggered when project orchestrator restarts |
| Doorman can't route infra tasks | Only 4 intents: simple/question/build/project — no "council" intent |
| Council invisible in marketplace | No "pando" project record; council has no projectId |

---

## Implementation Plan

### Step 1 — WorkerConfig gets `cwd` field (worker-pool.ts)
Add optional `cwd?: string` to `WorkerConfig`. When set, workers run in that directory instead of `process.cwd()`. This is the foundation for project workspace isolation.

### Step 2 — OrchestratorDeps gets project context (orchestrator.ts)
Add optional fields to `OrchestratorDeps`:
- `projectId?: string` — which project this orchestrator manages
- `projectWorkspaceDir?: string` — where workers build
- `apiPort?: number` — for self-calling deploy/commit endpoints

When these are set, the orchestrator passes `cwd = projectWorkspaceDir` to all workers it spawns.

### Step 3 — PandoNode gets `createProjectOrchestrator()` (index.ts)
A factory method that takes a `projectId` and:
1. Calls `OrgManager.getOrchestratorForProject()` for the DB row
2. Instantiates `new Orchestrator(orchId, { ..., projectId, projectWorkspaceDir, onCommit, onDeploy })`
3. Sets project-scoped callbacks:
   - `onCommit` → git add/commit in workspace + GitHub push via `POST /projects/:id/github/push`
   - `onDeploy` → S3 or PM2 deploy via `POST /projects/:id/deploy`
4. Starts the tick loop
5. Stores in `this.projectOrchestrators: Map<string, Orchestrator>`

### Step 4 — OrgManager fires hook when creating orchestrators (org-manager.ts)
Add `onOrchCreated?: (orchId: string, projectId?: string) => void` callback.
When `getOrchestratorForProject()` creates a NEW DB row, fire the hook.
PandoNode registers this hook → calls `createProjectOrchestrator()`.
Result: every project creation automatically gets a live orchestrator.

### Step 5 — Project workspace setup (index.ts)
When `createProjectOrchestrator()` runs:
1. Create `~/.pando/projects/<projectId>/` if it doesn't exist
2. If `project.githubRepo` exists → `git clone` the repo into workspace (resume)
3. If new project → `git init` + write project CLAUDE.md with project metadata
4. Write `project-state.md` skeleton

### Step 6 — Project CLAUDE.md template
Written to `<workspace>/CLAUDE.md` when project starts. Contains:
- Project name, description, tier (1=static, 2=server)
- Build instructions by tier
- Current status from project-state.md
- Deploy target info

### Step 7 — project-state.md pattern
Written/updated by orchestrator `onCommit`. Contains:
```
## Status: in_progress | completed | deployed
## Last action: <what was last committed>
## Next: <what the manager decided to do next>
## Team: <worker roles, session IDs, last active>
## Deploy: <URL if deployed>
```
Committed to project GitHub repo. On resume, manager reads this to pick up where it left off.

### Step 8 — Council as the "pando" project (index.ts)
On startup, ensure a "pando" system project exists in ProjectStore:
- `id: 'pando-system'`, `name: 'Pando'`, `visibility: 'featured'`
- Council's `orchId` set as `managerAgentId`
- Council gets `projectId: 'pando-system'`, `projectWorkspaceDir: process.cwd()` (Pando repo IS the workspace)
- Council's `onCommit` = same as today (git add -A in Pando repo)
- Gateway marketplace shows "Pando" as a featured project with a chat link

### Step 9 — Re-hydrate project orchestrators on restart (index.ts)
After creating the council, query all active project orchestrators from AgentDatabase:
```typescript
const activeProjects = db.listAgents({ type: 'orchestrator', status: 'active' })
  .filter(a => a.projectId && a.projectId !== 'pando-system');
for (const agent of activeProjects) {
  createProjectOrchestrator(agent.projectId);
}
```
This restores in-progress projects after a node restart.

### Step 10 — Doorman "council" intent (api-server.ts)
Add 5th intent to `doormanClassify()`:
- Fast-path keywords: "pando bug", "network issue", "wallet broken", "node down", "fix pando", "upgrade"
- OpenAI prompt: distinguish "infrastructure" from "build new app"
- Routes to council via `sendToCouncil()` instead of creating a new project

### Step 11 — Doorman project context hint (platform-api.ts)
When chat message includes `projectId` in request body:
- Skip doorman, route directly to that project's orchestrator
- If `projectId === 'pando-system'` → route to council
- This is how marketplace project pages work: they pass their projectId

### Step 12 — Update docs
- `CLAUDE.md` (root) — update agent architecture section
- `genome/knowledge/scenarios/` — add project pipeline scenarios
- `output/graph.json` — patch to add new scenario nodes
- Update this plan file with completion notes

---

## File Change Map

| File | Change |
|---|---|
| `core/worker-pool.ts` | Add `cwd?: string` to WorkerConfig, use it in spawn() |
| `platform/orchestrator.ts` | Add `projectId`, `projectWorkspaceDir`, `apiPort` to OrchestratorDeps; pass cwd to workers |
| `platform/org-manager.ts` | Add `onOrchCreated` hook; fire it when getOrchestratorForProject creates new row |
| `index.ts` | Add `createProjectOrchestrator()`, register OrgManager hook, re-hydrate on startup, wire council to pando-system project |
| `api/api-server.ts` | Add "council" intent to doormanClassify() |
| `api/platform-api.ts` | Route council-intent messages to council; route project-page messages by projectId |
| `CLAUDE.md` | Update agent architecture docs |

---

## Test Scenarios (post-build)

1. **Scenario A — Council infra task**: Send "the wallet has a bug" via `/v1/chat/message` → doorman classifies as "council" → council receives it → spawns builder → fixes → QA → commit
2. **Scenario B — New user app**: Send "build me a landing page" via `/v1/chat/message` → doorman "build" → project created → project orchestrator INSTANTLY starts (not dead) → builder works in `~/.pando/projects/<id>/` → QA → commit → GitHub push → S3 deploy
3. **Scenario C — Resume**: Restart the node → project orchestrator re-hydrates → git pulls workspace → resumes where it left off
4. **Scenario D — Marketplace**: Gateway shows "Pando" as featured project → user clicks chat → message goes to council

---

## What Does NOT Change

- Tick loop logic
- Worker session resume (still works)
- P2P proxy for untrusted nodes (still works)
- Deploy endpoints (already exist)
- GitHub push endpoint (already exists)
- QA cycle and retry logic
