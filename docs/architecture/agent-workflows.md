# Agent Workflows — Context-Independent Operating Procedures

## The Problem

AI agents lose context every wake cycle. A 60-second sleep = blank slate. Currently:
- Agents re-read memory files to reconstruct what they were doing
- If memory is messy, they waste the cycle guessing
- No standard procedure — each wake-up is improvisation
- Different agents do things differently, inconsistently
- The founder has to manually direct everything

**The fix: encode intelligence into workflows, not context.**

An agent wakes up knowing nothing. But it has a workflow — a defined sequence of steps. Each step knows what data it needs, where to get it (API calls, file reads), what decisions to make, and what to do next. The workflow IS the brain. The agent executes it.

This is how the AI runs itself without needing the founder.

---

## Workflow Architecture

### What a Workflow Is

```typescript
interface Workflow {
  id: string;                    // 'ceo-cycle' | 'builder-cycle' | 'qa-cycle'
  name: string;                  // Human-readable name
  description: string;           // What this workflow does
  trigger: 'wake_cycle' | 'message_received' | 'proposal_created' | 'manual';
  steps: WorkflowStep[];
}

interface WorkflowStep {
  id: string;                    // 'check-status', 'read-inbox', etc.
  action: string;                // What to do
  dataNeeded: DataFetch[];       // API calls or file reads to get context
  decision?: DecisionPoint;      // If this step requires a choice
  onComplete: string;            // Next step ID, or 'done'
  onError: string;               // Step ID on failure, or 'abort'
  maxDuration: number;           // Seconds before timeout
}

interface DataFetch {
  source: 'api' | 'file' | 'p2p';
  endpoint: string;             // GET /status, or file path, or p2p message type
  storeAs: string;              // Variable name to store result
}

interface DecisionPoint {
  question: string;             // "What's the highest priority?"
  inputs: string[];             // Variable names from DataFetch results
  outputs: string[];            // Possible next steps
}
```

### How It Runs

```
Agent wakes up
  → Load workflow for my role
  → Execute step 1
    → Fetch required data (API calls)
    → Make decision (if needed)
    → Execute action
    → Move to next step
  → Execute step 2...
  → ...
  → Final step: update state, record what was done
  → Exit
```

The workflow is loaded from a file (`~/.pando/agent/workflows/<role>.json`) or from the codebase. It doesn't need context — it needs data, which it fetches fresh each cycle.

---

## The Core Workflows

### 1. CEO Workflow (`ceo-cycle`)

The CEO agent runs the network. Every wake cycle:

```
STEP 1: OBSERVE
├── GET /status (self) → node health, peers, uptime
├── GET /status (all known peers via SSH or P2P) → network-wide health
├── GET /agent/status (self + peers) → which agents are running, awake/asleep
├── GET /governance/proposals/active → pending decisions
├── GET /activity → recent events
├── READ state.md → what did I decide last time?
├── READ inbox.md → any messages from agents or founder?
└── STORE all as: networkState, agentStatuses, proposals, activity, lastState, inbox

STEP 2: ASSESS
├── INPUT: all data from step 1
├── QUESTIONS:
│   ├── Are all agents healthy? (any stuck, failing, or offline?)
│   ├── Are there urgent bugs? (check QA agent's state.md)
│   ├── Are there stalled proposals? (no votes, expired?)
│   ├── Is any agent idle? (no assignment, wasting cycles?)
│   ├── What did I assign last cycle — is it done?
│   └── What's the highest-impact thing to do right now?
└── OUTPUT: prioritized action list

STEP 3: ACT (pick the top 1-2 actions)
├── IF agent is stuck → diagnose and send fix via inbox
├── IF agent is idle → assign work via inbox
├── IF bug is critical → assign to builder agent
├── IF proposal needs attention → vote or comment
├── IF strategy needs updating → write strategy update
├── IF everything is running well → optimize (improve workflows, update docs)
└── ALWAYS: send at least one message to demonstrate liveness

STEP 4: RECORD
├── UPDATE state.md with:
│   ├── What I observed
│   ├── What I decided and why
│   ├── What I assigned to which agent
│   └── What I expect to see next cycle
├── APPEND to decisions.md if a significant decision was made
├── BROADCAST strategy_update via P2P if priorities changed
└── EXIT
```

**Key principle:** The CEO never builds features. It observes, decides, and directs. If it has nothing to direct, it improves the system itself (better workflows, better docs, better monitoring).

### 2. Builder Workflow (`builder-cycle`)

```
STEP 1: CHECK ASSIGNMENT
├── READ inbox.md → any new assignment from CEO?
├── READ goals.md → current assignment
├── IF no assignment → GOTO step 5 (health check only)
└── STORE as: assignment

STEP 2: PREPARE
├── READ files listed in assignment → understand current code
├── GET /governance/proposals/active → check if anyone else is working on same files
├── POST /governance/message → announce "I'm working on: <files>"
├── IF conflict detected → NOTIFY CEO via P2P message, skip this cycle
└── STORE as: context, conflicts

STEP 3: BUILD
├── Write code changes per assignment
├── Run: npm run build → verify compilation
├── IF build fails → fix errors, retry once
├── IF still fails → record error in state.md, notify CEO
└── STORE as: buildResult

STEP 4: VERIFY (MANDATORY)
├── For API endpoints: curl the endpoint, check response is correct
├── For code changes: test the specific behavior changed
├── For bug fixes: reproduce the original bug, confirm it's fixed
├── Record: what tested, expected vs actual, PASS/FAIL
├── IF verification fails → fix and rebuild
└── "It compiles" ≠ "it works." Always verify.

STEP 5: COMMIT
├── git add <specific files>
├── git commit -m "<assignment commit message>"
├── UPDATE state.md with what was built, test + verification results
├── WRITE "PENDING_APPROVAL: <description>" if in beta mode
└── EXIT

STEP 6: LEARN
├── Record gotchas, flaws, improvements in state.md
└── Update docs if changes affect architecture

STEP 7: IDLE (no assignment)
├── GET /status → health check
├── GET /agent/status → report status
├── UPDATE state.md → "No assignment. Awaiting orders."
└── EXIT
```

### 3. QA Workflow (`qa-cycle`)

```
STEP 1: FIND WHAT TO TEST (proactive, not passive)
├── READ inbox.md → CEO assigned a specific test? Do that first.
├── git log --oneline -5 → did a builder commit since last test? Test those changes.
├── READ state.md → what's in the test plan? Pick next untested item.
├── IF all tested → re-run regression on previously found bugs
├── IF nothing else → full health check: hit every API endpoint
└── STORE as: testTarget

STEP 2: TEST
├── Execute test (curl commands against local API)
├── Verify: correct status code, correct response shape, edge cases
├── Record: PASS or FAIL with exact curl commands used
├── IF FAIL → categorize: CRITICAL / HIGH / MEDIUM / LOW
└── STORE as: testResult

STEP 3: VERIFY BUILDER WORK
├── Read commit diff: git show <hash> --stat
├── Test SPECIFIC functionality that was changed
├── Try to BREAK it: malformed input, missing fields, boundary values
├── Report bugs with commit hash so CEO knows which commit introduced it
└── STORE as: builderVerification

STEP 4: REPORT
├── APPEND test results to state.md (structured bug tracker table)
├── IF CRITICAL bug → P2P message to CEO immediately
├── IF builder commit has a bug → alert CEO with commit hash
├── IF new bugs found → update cumulative bug tracker
├── UPDATE state.md with: tests run this cycle, total coverage
└── EXIT

STEP 5: REGRESSION
├── Re-test previously found bugs → OPEN → FIXED if resolved
└── Update bug tracker status

STEP 6: LEARN
├── Record gotchas, systemic issues, missing tests in state.md
└── Add missing tests to the test plan
```

### 4. Monitor Workflow (`monitor-cycle`)

For lightweight health-check agents (Tier 2 / API key agents):

```
STEP 1: CHECK ALL NODES
├── GET /status on each known peer → alive/dead, peer count
├── GET /agent/status on each → agent health
├── Record: which nodes are up, which are down, response times
└── STORE as: networkHealth

STEP 2: CHECK ECONOMY
├── GET /status → totalSupply, circulatingSupply, totalBurned, relayFees
├── Compare to last cycle (stored in state.md) → any anomalies?
├── Check: is supply growing too fast? Too slow?
└── STORE as: economyHealth

STEP 3: ALERT
├── IF node down → P2P message to CEO
├── IF anomaly detected → P2P message to CEO
├── IF all healthy → log "all systems nominal"
├── UPDATE state.md with health snapshot
└── EXIT
```

---

## Workflow Evolution — How They Improve

Workflows aren't static. The CEO agent's job is to **improve them**:

### Self-Improvement Cycle (CEO weekly)

```
1. Read all agent state.md files from the past week
2. Identify patterns:
   - Which workflows produced good results?
   - Where did agents get stuck?
   - What steps took too long?
   - What data was missing?
3. Revise workflow definitions
4. Deploy updated workflows to agents via inbox
5. Record the change in decisions.md with reasoning
```

### Metrics That Drive Improvement

| Metric | What It Tells You |
|---|---|
| Cycles where agent did nothing useful | Workflow is missing a path |
| Build failures per cycle | Assignment needs more context |
| Duplicate work between agents | Coordination step is broken |
| Time from bug found to bug fixed | Pipeline efficiency |
| Cycles between CEO check and action | CEO workflow responsiveness |

---

## Implementation — Where Workflows Live

### Phase 1: Embedded in Prompt (NOW)

The agent's wake-up prompt includes the workflow as instructions. This is what we do today — the prompt tells the agent what to do. But we make it **structured and standardized**.

The wake-up prompt for each role becomes:

```
You are a Pando {role} agent. Follow your workflow exactly:

STEP 1: {description}
- Fetch: {list of API calls}
- Decide: {decision criteria}
- Action: {what to do}

STEP 2: ...
```

This costs nothing to implement. It's just better prompts.

### Phase 2: Workflow Files (NEXT)

Workflows defined in JSON/YAML files at `~/.pando/agent/workflows/`:

```
~/.pando/agent/workflows/
  ceo-cycle.yaml
  builder-cycle.yaml
  qa-cycle.yaml
  monitor-cycle.yaml
```

The agent engine reads the workflow file and constructs the prompt from it. Benefits:
- CEO agent can update workflow files for other agents
- Workflows version-controlled in the codebase
- Different nodes can run different workflow versions

### Phase 3: Workflow Engine (LATER)

The node itself orchestrates workflows — not just generating prompts, but executing the data fetches before the AI wakes up, so the AI gets pre-loaded context:

```
Node (before waking AI):
  1. Execute all DataFetch steps from workflow
  2. Bundle results into structured context
  3. Wake AI with: "Here's the data. Here's your workflow. What do you decide?"
```

This reduces AI token usage (no tool calls for data fetching) and makes cycles faster.

---

## The Key Insight

> Workflows make agents **context-independent**.
>
> An agent doesn't need to remember what it was doing.
> It follows the workflow. The workflow tells it what to check.
> The checks give it current state. Current state drives decisions.
>
> Lost context? Doesn't matter.
> Crashed and restarted? Doesn't matter.
> New agent joining the network? Give it a workflow file.
>
> **The workflow is the institutional knowledge of the network.**

---

## Model Agnosticism — Any AI, Same System

Workflows are plain text instructions + HTTP API calls. They don't depend on Claude, GPT, Gemini, or any specific model. Any AI that can:
1. Read text instructions
2. Make HTTP requests (curl)
3. Read and write files
4. Reason about decisions

...can follow these workflows. The system is the workflow, not the model.

**Current state:** The agent engine uses `claude -p` (Tier 1) or Anthropic/OpenAI API calls (Tier 2). But the workflows themselves are model-agnostic. A future CEO could be GPT-5, Gemini 4, or an open-source model. It follows the same CEO workflow, makes the same API calls, records the same lessons.

**What this means for architecture:**
- Never hardcode model-specific behavior in workflows
- The agent engine should abstract model invocation behind an interface
- Workflow files (Phase 2) should be pure YAML/JSON — no model-specific syntax
- Any agent, on any model, reading the workflow, should produce equivalent behavior

## LEARN Step — Core DNA

Every workflow includes a mandatory LEARN step. This is not optional. It's how the system improves itself without human intervention.

**What agents record in "## Lessons Learned" in state.md:**
- Gotchas (things that failed unexpectedly)
- Systemic flaws (patterns of failure, not one-off bugs)
- Workflow improvements (steps that are missing, redundant, or in wrong order)
- Preventable failures (things that could have been caught earlier)
- Documentation gaps (things that are undocumented or wrong)

**Who consumes these lessons:**
- The CEO agent reads all agent state.md files and synthesizes patterns
- The CEO updates workflow definitions based on recurring issues
- Updated workflows go to all agents via the codebase
- The cycle repeats: execute → learn → improve → execute better

This is the self-improving loop. It works regardless of which AI model is the CEO.

---

## What's Been Done

1. ~~Rewrite agent wake-up prompts~~ → **DONE** — structured workflows for CEO, Builder, QA, Monitor in `agent-prompts.ts`
2. ~~Add LEARN step to all workflows~~ → **DONE** — every role has mandatory learn/improve step
3. ~~CEO workflow goes into the prompt~~ → **DONE** — CEO workflow is in the prompt system, auto-detected from goals.md
4. ~~Agent self-reporting~~ → **DONE** — agent-engine.ts calls POST /activity/record at wake/sleep/commit
5. ~~Builder VERIFY step~~ → **DONE** — builders must curl and test their changes before committing
6. ~~QA proactive testing~~ → **DONE** — QA agents check recent git commits and verify builder work
7. **Next: Automated E2E testing in QA workflow** — QA agent runs Playwright tests against gateway after builder commits
8. **Next: Workflow files** — extract from prompts into YAML files that agents can edit
9. **Next: Workflow metrics** — track step completion, cycle duration, learn output quality
10. **Next: Workflow engine (Phase 3)** — node pre-fetches data before waking AI

---

## Testing Pipeline — Fully Automated Quality

### Current State
- Builder runs `npm run build` (TypeScript compilation check only)
- Builder does manual curl verification (new: VERIFY step)
- QA does curl-based API testing
- CEO reviews diffs manually — bottleneck

### Target State: Build → Verify → Test → Auto-Approve
```
Builder commits code
  → Agent engine auto-merges to master
  → QA agent wakes up, sees new commit
  → QA runs:
    1. curl-based API verification (existing)
    2. node ~/Desktop/pando_admin/tests/test-ledger.mjs (unit tests)
    3. node ~/Desktop/pando_admin/tests/test-gateway.mjs (Playwright E2E)
  → QA reports results in state.md
  → IF all pass: auto-approve (no CEO review needed)
  → IF any fail: alert CEO with commit hash + failure details
  → CEO only reviews: security changes, economics changes, architecture changes
```

### Available Test Infrastructure
- **Playwright 1.58.2** installed on both Mac and Windows
- **test-ledger.mjs**: Unit tests for ledger operations
- **test-two-nodes.mjs**: Integration tests for P2P discovery
- **test-gateway.mjs**: E2E browser tests for gateway UI
- **MCP Server**: Programmatic access to Pando API (not yet used by agents)

### What Needs to Happen
1. QA workflow already tells agents to test builder commits (done)
2. QA agents need awareness of test scripts location and how to run them
3. Gateway must be running for E2E tests (agent should check, start if needed)
4. Auto-approval logic in agent-engine.ts (if QA passes, skip CEO review)
5. Risk classification: which changes need CEO review vs auto-approve

The founder is no longer the human in the loop for routine operations. The workflows run the agents. The CEO agent improves the workflows. The system improves itself.
