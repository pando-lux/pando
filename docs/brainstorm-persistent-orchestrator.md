# Brainstorm: Persistent Session Orchestrator (2026-02-28)

**STATUS: IMPLEMENTED** — See orchestrator.ts, template-registry.ts (`builtin:manager`), ai-backend-claude.ts.

Key changes from brainstorm:
- Session rotation: 50 ticks (not 30)
- 3-layer JSON parser for tool-use output (pure JSON → code fence → backward bracket scan)
- Boot prompt + tick update pattern (as proposed)
- All models upgraded to `claude-opus-4-6`
- Worker auto-reports enriched to 3000 chars + git diff stat

## The Problem

The current orchestrator is a **stateless, blind CEO**:
- Each tick (60s) is a fresh AI call — zero memory between ticks
- `noTools: true` — can't read files, can't explore code, can't verify anything
- Worker reports are truncated to 500 chars — orchestrator can't see what workers actually did
- Uses Sonnet — misses nuances in the complex 3000-token decision prompt
- Makes decisions about code it has never seen

**Result**: Orchestrator knows WHAT is happening (builder active, tester failed) but not WHY or HOW. Two extremes exist — workers have deep context but no big picture, orchestrator has big picture but no deep context. Neither has both.

## The Solution: Session-Persistent Orchestrator with Tools

### Architecture

```
Deterministic Tick Loop (Node.js, 60s interval)
  │
  ├── Reads board state from SQLite (workers, inbox, lessons, directives)
  ├── Builds "tick message" with fresh state
  ├── Resumes orchestrator session: --continue --resume <sessionId>
  │     │
  │     └── Orchestrator AI (Opus, persistent session, full tool access)
  │           ├── HAS: persistent memory (remembers all previous ticks, goals, decisions)
  │           ├── HAS: fresh state (board injected every tick)
  │           ├── CAN: read files, grep, check logs (investigate problems)
  │           ├── DOES NOT: write code, edit files, run builds
  │           ├── DELEGATES: spawns workers for all real work
  │           └── OUTPUTS: JSON action array (same as current)
  │
  └── Parses actions, executes them (spawn, commit, propose, respond)
```

### How It Works

1. **Every tick**, deterministic code reads the board from SQLite (fresh every time)
2. Builds a "tick message": `"TICK UPDATE: [full board state]. Decide."`
3. Resumes the orchestrator session with that tick message
4. Orchestrator responds — may investigate with tools, then outputs actions
5. Parse actions, execute them (same execution engine as today)

### What the Orchestrator Gets

- **Persistent memory**: session resume — remembers all previous ticks, the user's goal, what it decided before, what workers reported
- **Fresh state**: every tick injects the latest board — can't get out of sync
- **Tool access**: CAN read files, grep, check logs — but template says DON'T do work
- **Opus brain**: better at following complex instructions, using researchers, making nuanced decisions

### Safety Mechanisms

1. **Tick grounding**: Even if orchestrator goes exploring, next tick resumes with "Here's the board. Your builder finished 2 min ago. What do you do?" — snaps it back to reality
2. **Template discipline**: Boot prompt explicitly says THINK/DECIDE/DELEGATE, not DO
3. **Self-regulating tick loop**: If AI call takes 20 min, ticks skip (via `ticking` guard). When it finishes, next tick fires immediately with accumulated board state. Nothing is lost — inbox messages sit in SQLite waiting.
4. **Let it run free**: Workers are autonomous — they don't need orchestrator to do their job. They work and report when done. Quality of orchestrator decisions > speed.
5. **Session rotation**: Periodically rotate sessions (every ~30-50 resumes) to prevent context bloat from compression artifacts

### Template: `builtin:manager`

Used by ALL orchestrators (council and project). Same rules, different deployment context.

```
You are the manager. You have persistent memory across ticks.

## Rules
- NEVER write code, edit files, or run builds yourself
- To do ANY work: spawn_worker with a clear rolePrompt
- You CAN read files and grep to UNDERSTAND problems
- You CAN check worker output by reading their session logs
- If a worker hasn't reported in 10 min, investigate their status
- Every ~60s you'll get a fresh board state — always read it first
- Your job: THINK, DECIDE, DELEGATE. Not DO.

## When you get a tick update:
1. Read the board state (workers, inbox, alerts)
2. Process any new reports/messages
3. Decide actions (spawn, commit, kill, respond)
4. Output your JSON action array
5. Don't keep exploring endlessly — but investigate deeply when needed
```

### Council vs Project — Same Architecture, Different Pipelines

The `Orchestrator` class is already used at every level. Only callbacks differ:

| | Council Manager | Project Manager |
|---|---|---|
| **Manages** | Pando network | User's project |
| **onCommit** | git commit + push origin | git commit in workspace + push GitHub |
| **Deployment** | propose_upgrade → governance → all nodes pull | deploy to S3/Vercel/compute |
| **Boot context** | "You manage the Pando network" | "You manage project X for the user" |
| **Session** | Persistent, accumulates network knowledge | Persistent, learns user's project over time |

Both use the same persistent session approach, same tick loop, same template, same tool access.

### Why This Beats Alternatives

| Approach | Memory | Context | Risk | Complexity |
|---|---|---|---|---|
| **Current (stateless)** | None | Blind | Zero | Simple |
| **Context document (narrative log)** | Partial (last 20 entries) | Still blind | Zero | Trivial |
| **Session-persistent (this proposal)** | Full | Can explore | Low-medium | Moderate |
| **Full persistent agent (no tick loop)** | Full | Full | High (runaway) | High |

Session-persistent gives best of both worlds: persistent memory + fresh grounding + tool access, without losing the reliable deterministic tick loop.

### Implementation Scope (rough)

1. **orchestrator.ts**: `callAI()` — use sessionId, resume instead of fresh call, shorter tick prompt
2. **orchestrator.ts**: `buildTickMessage()` — new method, replaces `buildAIPrompt()` for resumed ticks (fresh board state only, ~500 tokens instead of 3000)
3. **orchestrator.ts**: First tick still uses full `buildAIPrompt()` as boot prompt, subsequent ticks use `buildTickMessage()`
4. **ai-backend-claude.ts**: Default model → `claude-opus-4-6`
5. **template-registry.ts**: Add `builtin:manager` template with orchestrator-specific rolePrompt
6. **worker-pool.ts**: Increase auto-report from 500 chars to 3000 chars, include files changed
7. **orchestrator.ts**: Save/restore orchestratorSessionId in SQLite
8. **orchestrator.ts**: Session rotation logic (fresh session every N resumes)

### Open Questions

- Session rotation threshold: every 30 resumes? 50? Based on context size?
- Should orchestrator have a CLAUDE.md in its workspace? Or is the template enough?
- How to handle orchestrator session dying on node restart? (Resume with boot prompt + context doc as fallback?)
- Should the tick interval increase for persistent orchestrators? (120s instead of 60s?)
- Cost monitoring: Opus + tools per tick — need to track and alert if spending exceeds threshold
