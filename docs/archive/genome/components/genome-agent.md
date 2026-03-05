---
id: genome-agent
type: utility
domain: support
entry: packages/node/src/platform/genome-agent.ts
depends_on: []
depended_by: []
exposes:
  - parseGenomeYaml() — parse genome.yaml into structured registry
  - mapFilesToComponents(files) — match source files to genome component IDs
  - detectDrift() — check if genome docs match actual filesystem
  - detectNewFiles() — find .ts files not in genome.yaml
  - getScopedContext(opts) — return relevant genome sections for a task (optional optimization)
  - getState() — read genome/state.md
  - isAvailable() — check if genome.yaml exists
rules: []
last_verified: 2026-02-19
---

# GenomeAgent (Utility)

## What It Is

A TypeScript utility library — NOT a Claude agent. Provides helper functions for parsing genome.yaml, matching files to components, and checking drift. Named "Agent" historically but it's really just a YAML parser + file matcher.

## Why It's a Utility, Not Core

**Workers and Manager read genome files directly.** They're Claude Code sessions — reading files, grepping for patterns, and understanding code is literally what they do.

Workers also **persist** via `--continue --resume`. First time a worker tackles a component, it explores the genome files naturally and builds understanding. Second time? Same workspace, full context preserved. No pre-loading needed.

GenomeAgent's scoped context injection is a **premature optimization**:
- Workers build BETTER context through natural exploration than keyword-matched summaries
- Worker session persistence means exploration cost is paid once
- Manager (also Claude Code) reads genome files directly during DOCS step
- At current scale (3 nodes, ~10 tasks/day), the optimization provides negligible benefit

## What It Provides (Nice-to-Have)

| Function | What It Does | Who Could Do This Instead |
|---|---|---|
| `parseGenomeYaml()` | Builds lookup table from genome.yaml | Manager/worker can read genome.yaml directly |
| `mapFilesToComponents()` | "scheduler.ts" → "scheduler" | Manager can grep genome.yaml for the entry field |
| `detectDrift()` | Checks if entry files exist on disk | Manager can check during DOCS step |
| `getScopedContext()` | Returns relevant genome pages for a task | Worker explores and finds what it needs |

## Current Wiring

- Initialized in `PandoNode._start()` (always available if genome.yaml exists)
- WorkspaceManager can use it for Layer 8 context injection (optional)
- ManagerContextAssembler can include drift warnings in Manager prompts (optional)
- Neither is required — workers and Manager function fine without it

## Key Files

- `packages/node/src/genome-agent.ts` — GenomeAgent class
- `genome/genome.yaml` — The genome registry it parses
