---
id: council
type: service
domain: governance
entry: packages/node/src/platform/council.ts
depends_on: [capability-registry, reputation, health-monitor, governance, ai-backend-registry, regression-suite]
depended_by: [pando-node, api-server, gateway]
exposes:
  - selectCouncil() -- select top-reputation AI-capable nodes as council members
  - getCouncil() -- returns CouncilState (members, selectedAt, rotatesAt, thisNodeOnCouncil)
  - getMinutes() -- returns full council minutes text
  - appendMinutes(entry) -- prepend entry to rolling 30-entry minutes log
  - runDailyReflection() -- AI-powered reflection via AIBackendRegistry (real Claude Code)
  - isCouncilMember() -- check if this node is on the current council
  - handleMessage(msg, actor?) -- AI-powered chat with action detection
  - getChatHistory() -- returns chat messages
  - getActiveTasks() -- returns ActiveTask array (lifecycle tracking)
  - addFounderDirective(content, addedBy) -- add a founder directive
  - getFounderDirectives() -- list all directives
  - getRequestLog() -- audit log of council requests
  - handleHealthAlert(alert) -- process health alerts for next reflection
  - start() / stop() -- lifecycle control (hourly tick + bridge watcher)
rules: [governance-tiers]
last_verified: 2026-02-27
---

# Network Council

## What It Does

Rotating council of top-reputation AI-capable nodes for autonomous reflection, chat, builder spawning, real QA verification, and self-governance. The council is the brain of the self-sustaining loop: it thinks (AI reflection), acts (spawn builders), verifies (spawn QA testers), and governs (create proposals).

## How It Works

1. **Council Selection** (`selectCouncil()`): Queries CapabilityRegistry for all known node profiles. Filters to nodes with Claude Code capability (`compute_cpu` + `claudeCode` detail). Sorts by reputation score (highest first). Takes top 3. Includes the local node if it qualifies.

2. **Rotation**: Council rotates every 7 days. On each hourly tick, checks if rotation is due and reselects if so.

3. **AI Reflection** (`runDailyReflection()`): If this node is on the council and enough time has passed:
   - Reads `network-state.md`, `council-minutes.md`, `genome/state.md`
   - Assembles structured prompt with instructions
   - Calls `AIBackendRegistry.getBest("text-generation")` -- real Claude Code
   - Parses structured JSON response (summary, proposals, concerns)
   - If proposals contain actionable items, triggers `runSelfHealingLoop()`
   - Falls back to `stubReflectionResult()` if no AI backend available

4. **Chat Interface** (`handleMessage()`): AI-powered conversation with action detection.
   - Uses AIBackendRegistry for responses when available
   - Detects actionable requests (fix, build, add, update keywords)
   - Spawns builders for actionable requests
   - Maintains chat history (max 200 entries)
   - All requests logged with RequestActor identity

5. **Builder Spawning** (`spawnFixAgent()`): POST to `/v1/agents/spawn` with `role=builder`, taskContext, and builder template. Tracked as ActiveTask.

6. **QA Pipeline** (Phase 103e): When a builder reports completion via bridge queue:
   - Creates/updates ActiveTask (`builder` -> `qa` -> `governance` -> `done`/`failed`)
   - Runs optional regression suite pre-check (14 fast HTTP tests)
   - Spawns real QA tester agent via `spawnQAAgent()` -- independent Claude Code session
   - QA agent tests from scratch, reports PASS/FAIL verdict
   - PASS: `commitAndPush()` + `createCouncilProposal()`
   - FAIL: retry with failure context (max 3 attempts)
   - Falls through to governance if QA agent cannot be spawned

7. **Bridge Watcher**: Polls bridge queue every 10s for builder/QA completion events. Routes to task lifecycle handlers.

8. **Founder Directives**: Persistent directives from the founder/operator, included in reflection prompts.

## Key Files

| File | Purpose |
|---|---|
| `packages/node/src/platform/council.ts` | Council class -- selection, rotation, reflection, chat, builder/QA pipeline |
| `packages/node/src/platform/qa-memory.ts` | QAMemory -- persistent QA result history for learning |
| `packages/node/src/platform/network-state.ts` | NetworkState -- metrics aggregation |
| `packages/node/src/api/platform-api.ts` | Council API endpoints |
| `packages/gateway/app/council/page.tsx` | Gateway council page |

## State Persistence

All state stored in `{dataDir}/council/`:
- `council-state.json` -- members, rotation, reflection timestamps, active tasks
- `council-minutes.md` -- rolling 30-entry decision log
- `last-prompt.md` -- most recent reflection prompt
- `network-state.md` -- written by NetworkState (read-only)
- `chat-history.json` -- council chat history (max 200 entries)
- `request-log.json` -- audit log of council requests
- `directives.json` -- founder directives
- `qa-memory.json` -- QA result history (max 500 entries)

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/v1/council` | Public | Council state: members, rotation, thisNodeOnCouncil |
| GET | `/v1/council/minutes` | Public | Council minutes text |
| GET | `/v1/council/chat` | Public | Chat history |
| POST | `/v1/council/message` | Operator | Send message to council |
| POST | `/v1/council/reflect` | Operator | Trigger manual reflection |
| POST | `/v1/council/directive` | Operator | Add founder directive |
| GET | `/v1/council/directives` | Public | List founder directives |
| GET | `/v1/council/requests` | Public | Request audit log |
| POST | `/v1/council/veto/:id` | Operator | Veto a governance proposal |

## Interfaces

```typescript
interface ActiveTask {
  taskId: string;
  description: string;
  stage: 'builder' | 'qa' | 'governance' | 'done' | 'failed';
  builderAgentId: string | null;
  qaAgentId: string | null;
  retryCount: number;
  maxRetries: number;  // default 3
  startedAt: number;
  builderSummary?: string;
  qaVerdict?: string;
}

interface CouncilMember {
  peerId: string;
  reputation: number;
  hasClaudeCode: boolean;
  uptimeHours: number;
}

interface CouncilState {
  members: CouncilMember[];
  selectedAt: number;
  rotatesAt: number;
  thisNodeOnCouncil: boolean;
}

interface ReflectionResult {
  timestamp: number;
  type: 'daily' | 'weekly' | 'monthly';
  summary: string;
  proposals: string[];
  minutesEntry: string;
}
```
