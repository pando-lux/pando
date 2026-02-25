---
id: council
type: service
domain: governance
entry: packages/node/src/council.ts
depends_on: [capability-registry, reputation, health-monitor, governance]
depended_by: [pando-node, api-server, gateway]
exposes:
  - selectCouncil() — select top-reputation AI-capable nodes as council members
  - getCouncil() — returns CouncilState (members, selectedAt, rotatesAt, thisNodeOnCouncil)
  - getMinutes() — returns full council minutes text
  - appendMinutes(entry) — prepend entry to rolling 30-entry minutes log
  - runDailyReflection() — assemble reflection prompt (AI call stubbed)
  - isCouncilMember() — check if this node is on the current council
  - start() / stop() — lifecycle control (hourly tick scheduler)
rules: [governance-tiers]
last_verified: 2026-02-22
---

# Network Council

## What It Does

Rotating council of top-reputation AI-capable nodes for autonomous reflection and self-governance. The council periodically reflects on network state and proposes improvements via the governance system. Currently, the infrastructure is built but actual AI reflection calls are stubbed (prompt assembly only).

## How It Works

1. **Council Selection** (`selectCouncil()`): Queries CapabilityRegistry for all known node profiles. Filters to nodes with Claude Code capability (`compute_cpu` + `claudeCode` detail). Sorts by reputation score (highest first). Takes top 3. Includes the local node if it qualifies.

2. **Rotation**: Council rotates every 7 days. On each hourly tick, checks if rotation is due and reselects if so.

3. **Daily Reflection** (`runDailyReflection()`): If this node is on the council and 24 hours have passed since last reflection:
   - Reads `network-state.md` (metrics snapshot from NetworkState aggregator)
   - Reads last 5 entries from `council-minutes.md`
   - Reads `genome/state.md` (project health)
   - Assembles a structured prompt with instructions for the AI
   - Saves prompt to `last-prompt.md` for inspection
   - Returns a stub ReflectionResult (actual AI call to be wired later)
   - Appends a minutes entry

4. **Council Minutes**: Rolling log of up to 30 entries in `council-minutes.md`. New entries prepended. Each entry starts with `## <date>`.

5. **Hourly Tick**: Timer checks for council rotation, daily reflection due, weekly/monthly flags (infrastructure only for weekly/monthly).

## Key Files

| File | Purpose |
|---|---|
| `packages/node/src/council.ts` | Council class — selection, rotation, reflection, minutes |
| `packages/node/src/network-state.ts` | NetworkState — metrics aggregation into structured markdown |
| `packages/node/src/api-server.ts` | `GET /council`, `GET /council/minutes` endpoints |
| `packages/gateway/app/council/page.tsx` | Gateway council page |
| `packages/gateway/app/api/council/route.ts` | Gateway proxy to node `/council` |
| `packages/gateway/app/api/council/minutes/route.ts` | Gateway proxy to node `/council/minutes` |

## State Persistence

All state stored in `{dataDir}/council/`:
- `council-state.json` — current members, rotation timestamps, last reflection timestamps
- `council-minutes.md` — rolling 30-entry decision log
- `last-prompt.md` — most recent assembled reflection prompt
- `network-state.md` — written by NetworkState (read-only by Council)

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/council` | Public | Council state: members, selectedAt, rotatesAt, thisNodeOnCouncil |
| GET | `/council/minutes` | Public | Council minutes text |

## Interfaces

```typescript
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

## What Is NOT Built Yet

- Actual AI reflection calls (daily/weekly/monthly) — prompt assembly ready, Claude Code session not wired
- P2P council membership broadcast via GossipSub
- Weekly review (multi-node independent analysis + consensus)
- Monthly strategy (deep retrospective)
- Sentiment tracking from chat data
- Growth dashboard / "Built on Pando" gallery
- Self-initiated governance proposals from reflection output
