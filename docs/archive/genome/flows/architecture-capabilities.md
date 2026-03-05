---
id: architecture-capabilities
components: [bridge-queue, agent-manager, scheduler, qa-runner, payment-gate, governance]
rules: [project-types, lux-economics, p2p-first]
trigger: user_message
---

# Architecture Capabilities — Master Blueprint

> **This document is the SINGLE SOURCE OF TRUTH for how Pando handles every type of user interaction.**
> Every code change must preserve these flows. If a capability breaks, this document tells you what broke.
> Before building any new feature, trace through this document to verify the flow is covered.
> Last updated: 2026-02-20

---

## Design Philosophy (WHY We Do What We Do)

**Why this document exists:** Architecture kept changing session-to-session. Code was fixed then re-fixed because the target moved. This document is the FIXED TARGET. All code must match it. If a scenario isn't here, add it here FIRST, then build the code. Not the other way around.

**Why todo lists, not code pipelines:** A hardcoded 7-stage pipeline can't handle writing a book, building a DEX, and fixing a typo. Todo lists are dynamic — Manager designs 3-11 steps per task. Claude Code's todo list survives context compaction (it's a tool, not memory). The todo IS the workflow.

**Why templates evolve:** Session 1 uses a default template. Session 10 uses a template refined by 9 REFLECT steps. Templates live in project-state.md (file, not memory). They survive context compression, crashes, months of inactivity. Each project's Manager becomes an expert at THAT project over time.

**Why project-state.md (external brain):** Claude Code's context window compresses old messages. A 6-month project will lose early decisions from memory. project-state.md is a file — it NEVER compresses. Manager reads it at session start, writes it at session end. All critical decisions live here. This is why Pando projects can run for months/years without losing context.

**Why the bridge queue:** Everything talks through ONE channel. Workers, QA, users, health monitors — all post to the bridge. Manager pulls ONE item at a time (no confusion from batching). The bridge is an audit trail — every interaction is logged. At scale, swap SQLite for Redis/Kafka. The pattern doesn't change.

**Why workers are autonomous (not dumb executors):** Workers are full Claude Code sessions. They can read files, write code, run tests, update docs, and think. They follow their own todo list (UNDERSTAND → PLAN → BUILD → TEST → UPDATE_GENOME → REPORT → REFLECT). They report discoveries (bugs found outside their scope). They talk directly to users when stuck. They update genome files because they have the freshest context about what they just changed. Manager oversees but doesn't micromanage.

**Why genome is the knowledge system:** Every project built on Pando inherits this thought process. The genome documents WHAT exists, HOW it works, and WHY decisions were made. Workers and QA update genome as part of their todo. Manager verifies accuracy. Genome survives everything — it's git-tracked files, not memory. Any new agent session reads genome to understand the system. No tribal knowledge. No context loss.

**Why the architecture won't need to be redone at scale:** The pattern is: `Message → Bridge → Manager → Workers → Bridge → Output`. At 10 users the bridge is SQLite. At 100,000 users swap it for Kafka. The actors don't change. The flow doesn't change. The rules don't change. You upgrade building blocks, not architecture. This is how every scalable system works.

**Why 3 tiers (keyword / OpenAI / Claude Code):** Cost. 10,000 messages/day at $0.50 = $5,000/day. With keyword tier, 90% are free. Speed: Claude Code takes 5-30s, keyword answers in <50ms. When cheap models gain Claude Code abilities, collapse to 1 tier. The ThreadStore is tier-agnostic — ready for the swap.

---

## The Three Brains (Who Does What)

| Brain | What it literally is | Cost | When to use |
|---|---|---|---|
| **Router** | ONE OpenAI API call (gpt-4o-mini). Stateless. No memory. | $0.001 / ~2 sec | First contact ONLY. Classifies intent, picks route. Never inside a project. |
| **Node.js glue** | TypeScript code. Zero AI. If/else, HTTP fetch, regex. | Free / instant | Simple actions: check balance, transfer Lux, create task entry, API calls. |
| **Claude Code** | Stateful AI agent. Reads/writes files, runs bash, persists via `--continue`. | $0.50-5 per session | Building things, reviewing code, QA, managing projects, writing, research. |

**Rule: Router DECIDES. Node.js EXECUTES simple things. Claude Code BUILDS complex things.**
**Rule: Router is the DOORMAN — it gets you into the right room, then gets out of the way.**

---

## The Four Actors in a Project

For complex projects, Claude Code takes on different ROLES. Same tool, different system prompt.

| Actor | Role | Lives where | Persistence |
|---|---|---|---|
| **Router** | Doorman. Classifies. Routes. Only at first contact. | OpenAI API (stateless) | None — fresh every call |
| **Manager** | Project Lead. Plans, delegates, reviews, verifies genome accuracy. Talks to user. | `~/.pando/managers/{id}/workspace/` | `--continue --resume {sessionId}` — remembers everything |
| **Builder Worker** | Builder. Builds what Manager assigns. Has own todo list. Reports discoveries. Updates genome for what it built. Can talk directly to user via bridge. | `~/.pando/workspaces/{taskId}/` | `--continue` — can be resumed for feedback/revisions |
| **QA Agent** | Tester. Playwright + API tests after every milestone. Updates genome with test results and known issues. Can talk directly to user via bridge. | `~/.pando/workspaces/{qaTaskId}/` | `--continue` — knows what passed before, tracks regression |

**For simple projects:** Manager does everything itself (no workers).
**For medium projects:** Manager + 1 Builder.
**For complex projects:** Manager + Builder(s) + QA Agent.
**Genome updates:** Every actor updates genome for what it touches. Workers update component docs after code changes. QA updates state.md with test results. Manager verifies accuracy during REVIEW — does NOT need to rewrite docs about code it didn't write.

---

## project-state.md: The External Brain

**Critical concept: Claude Code's context window compresses over time. Files don't.**

Every project has a `project-state.md` file in its workspace. This is the **external brain** — the persistent memory that survives context compaction, session restarts, and months-long projects.

```
~/.pando/projects/{projectId}/project-state.md

Contents:
  ## Architecture Decisions
  - [2026-02-19] Using time-priority matching (user requested, session 1)
  - [2026-02-20] Added stop-loss orders (user request, session 5)
  - [2026-02-21] Switched from REST to WebSocket for live order book (performance)

  ## Current Status
  - Milestone 1: COMPLETE (core engine)
  - Milestone 2: IN PROGRESS (API layer, 60% done)
  - Milestone 3: NOT STARTED (frontend)

  ## Known Issues
  - Partial fills rounding error (discovered by Worker B, session 3)
  - WebSocket reconnection not handled (QA found, session 7)

  ## Worker Registry
  - Worker A (order-book): session-id-abc, last active 2026-02-19
  - Worker B (matching-engine): session-id-def, last active 2026-02-20
  - QA Agent: session-id-ghi, last active 2026-02-20

  ## Manager Workflow Template (self-evolved)
  [Current todo template the Manager follows — updated after each REFLECT step]

  ## Budget
  - Allocated: 500 Lux
  - Spent: 127 Lux
  - Remaining: 373 Lux
```

**Rules:**
- Manager reads project-state.md at the START of every session
- Manager writes to project-state.md at the END of every session
- All critical decisions go here — not just in conversation memory
- Workers read project-state.md for context (via CLAUDE.md injection)
- If Manager forgets something due to context compression, project-state.md is the recovery

---

## How Costs Are Controlled

**Rule: Nothing expensive happens without the user knowing.**

```
COST FLOW:

1. Router classifies message                          → $0.001 (always paid by node)
2. If project: Router returns cost estimate            → free (estimate only)
3. PaymentGate checks user balance                     → free
4. User sees: "This will cost ~X Lux. Proceed? [Y/N]" → free
5. User confirms → Lux escrowed (held, not spent)     → Lux locked
6. Work happens (Manager + Workers + QA)               → real cost accumulates
7. On completion → escrow released (actual cost)       → Lux spent
8. On failure → escrow refunded                        → Lux returned
```

**Who decides cost?**
- **Router** provides initial estimate (based on complexity classification)
- **PaymentGate** enforces: checks balance, holds escrow, releases/refunds
- **Manager** tracks budget: won't spawn workers beyond budget
- **User** has final say: can cancel anytime (partial refund for work done)

**Retry budget (prevents infinite cost spiral):**
- Manager allows max 3 attempts per task before escalating to user
- After 3 failed QA cycles on the same issue, Manager asks user for direction
- Manager tracks spend-per-task in project-state.md
- If a task exceeds 2x its estimate, Manager pauses and reports to user

**Free tier:**
- Simple questions (2+2, weather, balance) → free, always
- Actions on own node (transfer, status) → free (node operator cost)
- First project per day → free (onboarding incentive — configurable)

---

## Governance: Who Approves What

| Project Type | Who Pays | Governance Required? | Detection |
|---|---|---|---|
| **Personal** | User's Lux balance | No — your money, your choice | Default for all requests |
| **Public** | NETWORK account (community funded) | YES — proposal + 2+ node votes | User says "for everyone" / "for the network" / "public project" |
| **Admin** | Node operator (free, own resources) | No — operator's machine | Local API call, no external session |

**Public project governance flow:**
```
User: "build a chess game for all Pando users"
  → Router detects: public project (keywords: "for all", "for Pando users")
  → Node.js auto-creates governance proposal: "Chess Game for Pando"
  → Returns: "This is a public project. I've created a governance proposal.
              It needs 2+ node votes to proceed. Proposal ID: gov-123"
  → [Network votes over hours/days]
  → Votes pass → Manager spawned, funded from NETWORK account
  → Votes fail → User notified: "Proposal rejected. You can modify and re-propose."
```

**Budget expansion governance:**
```
Manager working on public chess project (budget: 100 Lux, spent: 85 Lux):
  User B requests: "Add multiplayer"
  Manager estimates: +40 Lux needed.
  Manager: "Budget expansion needed. Creating governance proposal."
  → POST /governance/propose { title: "Chess: Add Multiplayer (+40 Lux)" }
  → Network votes → approved → budget increased to 140 Lux
```

---

## THE WORKER'S TODO LIST + SELF-REFLECTION

Workers are NOT dumb executors. They are full Claude Code sessions — they can read files, write code, run tests, update documentation, and think. They follow their own structured workflow, report discoveries, and talk directly to users when needed.

```
WORKER TODO LIST (included in every worker's CLAUDE.md):

  □ 1. UNDERSTAND: Read task spec + context files + project-state.md.
       Note any ambiguities or missing information.
       If blocked by missing info → POST /tasks/{taskId}/messages { messageType: "question" }
       If Manager is busy and you're completely blocked:
         → POST /tasks/{taskId}/messages { messageType: "stuck", urgency: "direct" }
         → This goes straight to the user (bridge bypasses Manager queue)

  □ 2. PLAN: What files to create/modify. What approach.
       If multiple approaches exist, pick the best one and document WHY.

  □ 3. BUILD: Write the code/content.
       If you discover a bug or issue OUTSIDE your task scope:
         → POST /tasks/{taskId}/messages { messageType: "discovery", content: "..." }
         → Do NOT fix it yourself (scope creep). Document and continue.

  □ 4. TEST: Run tests you wrote. Fix failures.
       If stuck on a test failure for >5 minutes:
         → POST /tasks/{taskId}/messages { messageType: "stuck", content: "..." }
         → Continue working on other parts if possible.

  □ 5. UPDATE_GENOME: Update genome files for what you just built/changed.
       - If you created a new component → create/update genome/components/{name}.md
       - If you changed a flow → update genome/flows/{name}.md
       - If you changed behavior → update genome/state.md
       - If you found issues → add to Known Issues in genome/state.md
       Manager will VERIFY your genome updates during REVIEW (you don't need to be perfect,
       but you have the freshest context about what you just changed — capture it).

  □ 6. REPORT: Write RESULT.md with:
       - What I built (files created/modified, line counts)
       - Decisions I made (and why — so Manager can verify)
       - Issues discovered but not fixed (out of scope)
       - Suggested follow-up tasks
       - Test results (X passing, Y failing, why)
       - Genome files updated (so Manager knows what to verify)

  □ 7. REFLECT: Was the task spec clear enough?
       What would have helped me work faster?
       Write reflections to RESULT.md under "## Worker Feedback"
       (Manager reads this to improve future task specs)
```

```
QA AGENT TODO LIST (included in every QA agent's CLAUDE.md):

  □ 1. UNDERSTAND: Read test plan from task spec + project-state.md.
       What was built? What files changed? What should be tested?

  □ 2. PLAN: Set up test environment, identify test data, plan test cases.

  □ 3. TEST: Run each test case.
       For UI → Playwright browser tests + screenshots.
       For API → endpoint regression tests.
       For logic → unit tests.
       If stuck for >5 minutes:
         → POST /tasks/{taskId}/messages { messageType: "stuck", content: "..." }
         → Skip blocked tests, continue with others.

  □ 4. UPDATE_GENOME: Update genome files for what you tested.
       - Update genome/state.md Known Issues if you found bugs
       - Update component docs with "Tested: [date], [results]" if applicable
       - Mark resolved issues in state.md if your tests prove they're fixed

  □ 5. REPORT: Write RESULT.md with:
       - Pass/fail per test case + screenshots
       - Regressions found (things that worked before but don't now)
       - New issues discovered
       - Genome files updated
```

**Worker discovery flow (found a bug while fixing something else):**

```
Worker B (building matching engine) discovers settlement rounding error:

  Worker B → POST /tasks/{taskId}/messages {
    messageType: "discovery",
    content: "Found rounding error in settlement.ts line 47.
              0.1 + 0.2 produces 0.30000000000000004.
              Not part of my task but will cause balance discrepancies.
              Suggesting: use integer math (store amounts as smallest unit).",
    severity: "critical"
  }
  │
  ▼
  BRIDGE → MANAGER:
    Manager reads discovery.
    Manager creates new task: "Fix floating point rounding in settlement"
    Manager prioritizes it: CRITICAL (financial calculations).
    Worker B continues with its original matching engine task.
```

---

## STUCK DETECTION + ESCALATION

Workers and QA agents can get stuck. The architecture must handle this gracefully.

```
STUCK DETECTION RULES (in every Worker/QA CLAUDE.md):

  "If you are blocked for more than 5 minutes on a single problem:
   1. Document what you're stuck on
   2. POST /tasks/{taskId}/messages { messageType: 'stuck', content: '...' }
   3. Continue working on other parts of the task if possible
   4. If completely blocked, write PARTIAL_RESULT.md and exit"
```

**Escalation chain:**

```
LEVEL 1: Worker/QA self-resolves
  Worker tries 2-3 approaches before asking for help.
  Most issues resolved here.

LEVEL 2: Worker → Manager (via bridge)
  Worker posts 'stuck' message.
  Manager reads it, provides direction:
    - "Try approach X instead"
    - "Read file Y for context"
    - "I'll assign a different worker to help"

LEVEL 3: Manager → User
  Manager also doesn't know the answer.
  Manager → User: "The worker building your login page is stuck.
    The page at localhost:3000/login won't load.
    I've checked the config and it looks correct.
    Can you help?
    - Is there a firewall blocking port 3000?
    - Did you change the URL structure recently?"

LEVEL 4: Timeout + Partial Result
  If no resolution after timeout (15-60 min depending on task type):
    Worker writes PARTIAL_RESULT.md with:
      - What was completed
      - Where it got stuck
      - Suggested next steps
    Scheduler kills worker gracefully.
    Manager reviews partial result, decides: retry, reassign, or ask user.
```

**Urgent bypass (worker → user directly, skipping Manager):**

```
When Manager is busy processing another bridge item AND worker has an
urgent blocking question:

  Worker → POST /tasks/{taskId}/messages {
    messageType: "stuck",
    urgency: "direct",        ← bypasses Manager queue
    content: "Need database credentials to continue. Can't proceed without them."
  }
  │
  ▼
  Bridge → SSE → USER (immediately, no Manager delay)

  User responds → Bridge → Worker directly (since worker tagged it as direct)
                        → Also logged for Manager to see when it catches up

RULES for urgent:direct:
  - Only for truly blocking issues (can't continue AT ALL)
  - Normal questions still go through Manager (filter noise)
  - Manager sees the exchange in bridge audit trail
  - Max 1 direct message per worker per task (prevents spam)
```

---

## CONFLICTING USER INSTRUCTIONS (Multi-User Projects)

When multiple users contribute to the same public project, instructions may conflict.

```
Bridge queue for chess project:
  [1] User A: "Make the board 3D with WebGL"
  [2] User B: "Keep the board simple 2D, 3D is bloat"

Manager processes sequentially, detects conflict:

  Manager thinks: "User A wants 3D. User B wants 2D. These contradict.
    This is a public project — I can't just pick one. Need governance."

  Manager → public project thread:
    "Conflicting requests from contributors:
     - User A: 3D board with WebGL
     - User B: Simple 2D board

     This needs a community decision. Creating a governance proposal:
     'Chess Board: 2D vs 3D rendering'

     Please vote. I'll implement whichever wins."

  → POST /governance/propose { title: "Chess Board: 2D vs 3D" }
  → Network votes → decision made → Manager implements winning option

RULES for conflict resolution:
  - Personal projects: user is always right (their money, their choice)
  - Public projects: governance vote resolves conflicts
  - Admin projects: node operator decides
  - Manager NEVER picks sides on public project disputes
```

---

## RETRY BUDGET + INFINITE LOOP PREVENTION

```
Manager tracks per-task attempts:

  Task: "Fix partial fill remainder"
  Attempt 1: Worker fixes → QA fails (new edge case)
  Attempt 2: Worker fixes edge case → QA fails (different issue)
  Attempt 3: Worker fixes → QA fails AGAIN

  Manager (after 3rd failure):
    "I've tried to fix this 3 times and QA keeps failing.
     The issue might be architectural, not a simple bug.

     Options:
     1. I'll try a completely different approach (~5 more Lux)
     2. Let me show you the failing tests and get your input
     3. Skip this feature and move on

     Task spend so far: 8 Lux (estimated 3 Lux).
     Remaining project budget: 45 Lux of 500."

  → User decides direction
  → Manager proceeds based on user's choice

RULES:
  - Max 3 attempts per task before user escalation
  - Manager logs each attempt + failure reason in project-state.md
  - If task exceeds 2x estimated cost → Manager pauses and reports
  - Manager NEVER enters an infinite retry loop
  - On 3rd failure, Manager includes the QA failure details so user can help diagnose
```

---

## DEPENDENCY MANAGEMENT (Blocked Tasks)

```
Complex project: DEX has 12 tasks across 3 milestones.
  Task C depends on Task A and B.
  Task F depends on Task D.
  Task H depends on everything.

Manager tracks dependencies in project-state.md.

SCENARIO: Task A takes 3x longer than expected.

  Manager (during MONITOR step):
    "Task A is at 90 min (estimated 30 min).
     Tasks C and H are blocked by A.
     But Tasks D, E, F, G are independent — they can run now.

     Decision:
     1. Start independent tasks D, E, F, G in parallel
     2. Check on Task A worker at 120 min mark
     3. If Task A still stuck at 120 min → escalate (stuck detection)"

  Manager spawns Workers for D, E, F, G while waiting.
  At 120 min → Manager checks Task A worker:
    - If progressing: wait
    - If stuck: help or reassign
    - If failed: handle failure, unblock dependents differently

RULES:
  - Manager NEVER lets blocked tasks silently waste time
  - Independent tasks are started in parallel whenever possible
  - Manager checks long-running workers at 50% and 100% of estimated time
  - Dependency graph is tracked in project-state.md
```

---

## SCENARIO 1: Simple Question (No Project)

**User input:** "What is 2+2?" (fresh chat, no project context)

```
USER: "What is 2+2?"
  │
  ▼
GATEWAY: POST /chat/message { message: "What is 2+2?", threadId: null }
  │
  ▼
ROUTER (OpenAI, $0.001):
  Thinks: "Arithmetic question. I can answer directly."
  Returns: {
    type: "answer",
    response: "4",
    cost: 0
  }
  │
  ▼
NODE.JS: Returns response directly to gateway.
  Creates a new thread (auto-titled "Quick Math").
  Saves message + response to thread.
  │
  ▼
USER SEES: "4"

Total cost: $0.001 (paid by node operator, not user)
Total time: ~2 seconds
Actors involved: Router only
```

**Other examples that follow this path:**
- "What is the weather?" → "I'm a Pando network assistant, I don't have weather data."
- "How does governance work?" → Router answers from system prompt context.
- "What is Pando?" → Router answers.

---

## SCENARIO 2: Node Action (Balance, Transfer, Status)

**User input:** "What's my balance?" (fresh chat)

```
USER: "What's my balance?"
  │
  ▼
ROUTER (OpenAI, $0.001):
  Thinks: "They want their balance. This is a node API action."
  Returns: {
    type: "action",
    action: "get_balance",
    params: {}
  }
  │
  ▼
NODE.JS (free, instant):
  Calls: GET /status (internal, no network hop)
  Reads: balance = 6271.24
  Formats: "Your balance is **6,271.24 Lux**."
  │
  ▼
USER SEES: "Your balance is 6,271.24 Lux."

Total cost: $0.001
Total time: ~2 seconds
Actors involved: Router + Node.js glue
```

**Other examples:**
- "Transfer 5 Lux to 12D3Koo..." → action: transfer → POST /transfer → "Done. Tx: abc123"
- "Show my peers" → action: get_peers → GET /peers → "3 peers connected: ..."
- "Create a task: fix homepage" → action: create_task → POST /tasks → "Task created (ID: t-456)"
- "Show proposals" → action: get_proposals → GET /governance/proposals → "2 active proposals..."

---

## SCENARIO 3: Simple Project (Build a Calculator)

**User input:** "Build me a calculator app" (fresh chat)

```
USER: "Build me a calculator app"
  │
  ▼
ROUTER (OpenAI, $0.001):
  Thinks: "User wants something built. This is a project.
           It's simple — one component, no backend, no auth.
           Personal project (no 'for everyone' keywords)."
  Returns: {
    type: "project",
    projectType: "personal",
    title: "Calculator App",
    complexity: "simple",
    estimatedCost: 2,
    suggestedTemplate: "single-page-app"
  }
  │
  ▼
PAYMENT GATE (free, instant):
  Checks: user balance = 6271.24 Lux
  Estimate: ~2 Lux
  Result: sufficient
  │
  ▼
NODE.JS → USER (via SSE):
  "I'll build you a calculator app. Estimated cost: ~2 Lux.
   Starting now..."

  Creates project thread (auto-titled "Calculator App")
  Creates project workspace: ~/.pando/projects/calculator-app-{ts}/
  │
  ▼
BRIDGE QUEUE:
  enqueue('project-calculator-app', {
    type: 'user_request',
    source: 'chat',
    payload: { message: "Build me a calculator app", projectType: "personal", budget: 2 }
  })
  │
  ▼
MANAGER (Claude Code, $0.50-1):
  Spawned: claude -p "{event prompt}" --continue --resume {sessionId}

  Manager reads project-state.md (empty — new project).
  Manager thinks: "Simple project. I'll build this myself, no workers needed."

  DECLARES WORKFLOW via POST /managers/{id}/workflow:
    Step 1: PLAN — understand requirements
    Step 2: BUILD — create the calculator
    Step 3: QA — test it works
    Step 4: DELIVER — notify user

  TODO LIST (Manager's working checklist):
    □ PLAN: Single HTML/JS calculator. Add/subtract/multiply/divide. Clean UI.
    □ BUILD: Create index.html with calculator logic and styling.
    □ QA: Open in browser, test basic operations.
    □ DELIVER: Tell user it's done, show preview.

  Manager builds it directly (no workers for simple tasks).
  Creates files in project workspace.
  Updates project-state.md with decisions and status.
  Reports each step via POST /managers/{id}/step.
  │
  ▼
MANAGER → BRIDGE → USER (via SSE):
  "Done! Your calculator app is ready.
   Files: index.html (calculator with +, -, ×, ÷)
   [Preview link] [Download]"

Total cost: ~1.5 Lux
Total time: ~3-5 minutes
Actors involved: Router → Payment Gate → Manager (does everything)
```

---

## SCENARIO 4: Complex Project (Build a DEX like Binance)

**User input:** "Build me a decentralized exchange" (fresh chat)

```
USER: "Build me a decentralized exchange"
  │
  ▼
ROUTER (OpenAI, $0.001):
  Returns: {
    type: "project",
    projectType: "personal",
    title: "Decentralized Exchange",
    complexity: "massive",
    estimatedCost: 500,
    clarifications: ["What trading pairs?", "What chain for settlement?", "Any existing codebase?"]
  }
  │
  ▼
PAYMENT GATE:
  Checks balance: 6271.24 Lux
  Estimate: ~500 Lux
  Result: sufficient but large
  │
  ▼
NODE.JS → USER:
  "This is a large project (~500 Lux). Before I start, I need to understand your requirements.
   I'm creating a project workspace and connecting you with a project lead."

  Creates project thread + workspace + project-state.md.
  │
  ▼
BRIDGE QUEUE → MANAGER (Claude Code, project lead):
  Spawned with CLAUDE.md that says:
    "You are the project lead for 'Decentralized Exchange'.
     Budget: 500 Lux. This is a personal project.
     Your first job: understand requirements, then plan milestones."

  ═══════════════════════════════════════════════════════════════
  MANAGER'S FIRST SESSION — PLANNING
  ═══════════════════════════════════════════════════════════════

  Manager reads project-state.md (empty — new project).

  Manager → USER (via bridge → SSE):
    "I'm your project lead for the DEX. Before I start building, I need to understand:
     1. What trading pairs do you want? (crypto only, or also fiat?)
     2. Order types: limit orders, market orders, stop-loss?
     3. Do you have any existing code or starting from scratch?
     4. What's the priority — get a working prototype fast, or full production?"

  ▼
USER: "Crypto only. Limit and market orders. From scratch. Prototype first."
  │
  ▼
BRIDGE QUEUE → MANAGER (same session, --continue):

  Manager thinks: "Got requirements. Now I'll plan milestones."

  Writes to project-state.md:
    ## Architecture Decisions
    - Crypto pairs only (user request, session 1)
    - Limit + market orders (user request, session 1)
    - From scratch, no existing code
    - Prototype-first approach

  DECLARES WORKFLOW:
    Step 1: PLAN — architecture + milestones
    Step 2: MILESTONE 1 — core engine (order book + matching)
    Step 3: MILESTONE 2 — API layer
    Step 4: MILESTONE 3 — frontend
    Step 5: INTEGRATION QA — full E2E testing
    Step 6: DELIVER — prototype ready

  Manager creates milestone plan in project-state.md:

  ┌──────────────────────────────────────────────────┐
  │ MILESTONE 1: Core Engine (3 tasks, ~50 Lux)      │
  │   Task A: Order book data structure               │
  │   Task B: Matching engine (limit + market)        │
  │   Task C: Trade settlement (blocked by A, B)      │
  │                                                  │
  │ MILESTONE 2: API Layer (2 tasks, ~30 Lux)        │
  │   Task D: REST API endpoints                      │
  │   Task E: WebSocket for live order book           │
  │                                                  │
  │ MILESTONE 3: Frontend (3 tasks, ~60 Lux)         │
  │   Task F: Trading UI (order form + book display)  │
  │   Task G: Portfolio / balance view                │
  │   Task H: Charts (price history)                  │
  │                                                  │
  │ QA: Integration testing after each milestone      │
  │                                                  │
  │ Dependencies: C→[A,B], H→[D,E]                   │
  └──────────────────────────────────────────────────┘

  Manager → USER: "Here's my plan: [shows milestones]. Starting with the core engine.
                    I'll keep you updated at each milestone. Budget: ~140 Lux for Phase 1."

  ═══════════════════════════════════════════════════════════════
  MANAGER'S SECOND SESSION — MILESTONE 1 EXECUTION
  ═══════════════════════════════════════════════════════════════

  Manager reads project-state.md (has plan from session 1).
  Creates 3 tasks via POST /tasks:
    Task A: { title: "Order book engine", description: "...", priority: "high" }
    Task B: { title: "Matching engine", description: "...", priority: "high" }
    Task C: { title: "Trade settlement", description: "...", priority: "medium", blockedBy: [A, B] }

  Manager approves Task A and B (can run in parallel — no dependency).
  Task C stays pending until A and B complete.
  │
  ▼
SCHEDULER picks up Task A + B:
  Creates isolated workspaces:
    ~/.pando/workspaces/task-A/ (CLAUDE.md with order book spec + worker todo template)
    ~/.pando/workspaces/task-B/ (CLAUDE.md with matching engine spec + worker todo template)

  Spawns Worker A: claude -p "Build order book..." --continue --resume {workerA-session}
  Spawns Worker B: claude -p "Build matching engine..." --continue --resume {workerB-session}
  │
  ├── WORKER A follows its todo list:
  │     □ UNDERSTAND: Read task spec
  │     □ PLAN: Order book as sorted array, O(log n) insert
  │     □ BUILD: order-book.ts, types.ts
  │     □ TEST: 45 unit tests, all passing
  │     □ REPORT: RESULT.md with files, decisions, test results
  │     □ REFLECT: "Task spec was clear, no issues"
  │     → Posts to bridge: "Done"
  │
  └── WORKER B follows its todo list:
        □ UNDERSTAND: Read task spec
        □ PLAN: Matching engine with price-time priority
        □ BUILD: matching-engine.ts
        □ TEST: 22 unit tests, all passing
        □ REPORT: RESULT.md
        □ REFLECT: "Spec didn't mention partial fills — I assumed remainder stays in book"
        *** DISCOVERY: "Found rounding error in settlement.ts line 47.
            0.1 + 0.2 = 0.30000000000000004. Not my task but critical."
        → POST /tasks/{taskId}/messages { messageType: "discovery", severity: "critical" }
        → Posts to bridge: "Done + discovery"
  │
  ▼
BRIDGE QUEUE → MANAGER (--continue, remembers plan):

  Manager reads Worker A's output:
    "Order book implemented. 45 unit tests passing."
    → Reviews code → APPROVED
    → Updates project-state.md: "Task A: COMPLETE"

  Manager reads Worker B's output:
    "Matching engine done. 22 unit tests. Note: assumed partial fill remainder stays in book."
    → Reviews → finds issue: "Worker assumed partial fills but spec wasn't explicit."
    → Checks with user? No — Worker's assumption is correct for a DEX.
    → APPROVED with note: "Confirm partial fill behavior in QA"
    → Updates project-state.md: "Task B: COMPLETE"

  Manager reads Worker B's DISCOVERY:
    "Rounding error in settlement.ts — floating point issue."
    → Creates new task: "Fix floating point rounding in settlement"
    → Priority: CRITICAL (financial calculations)
    → Adds to Milestone 1 (dependency for Task C)

  Manager approves Task C (A and B now complete).
  │
  ▼
  ... Task C runs, completes ...

  ═══════════════════════════════════════════════════════════════
  QA AFTER MILESTONE 1
  ═══════════════════════════════════════════════════════════════

  Manager thinks: "Milestone 1 code complete. Time for QA."

  Creates QA task: {
    title: "QA: Core Engine Milestone 1",
    description: "Run integration tests on order book + matching + settlement.
                  Use Playwright for any UI. Run API endpoint tests.
                  Test cases:
                    1. Create limit buy order
                    2. Create limit sell order
                    3. Orders match at crossing price
                    4. Partial fill leaves remainder in book
                    5. Settlement updates both balances correctly
                    6. Verify no floating point rounding issues"
  }
  │
  ▼
SCHEDULER → QA WORKER (Claude Code + Playwright):
  QA Worker follows its own todo:
    □ UNDERSTAND: Read test plan from task spec
    □ PLAN: Set up test environment, identify test data
    □ TEST: Run each test case
    □ REPORT: RESULT.md with pass/fail per test case + screenshots

  Results:
    ✅ Create limit buy order — pass
    ✅ Create limit sell order — pass
    ✅ Orders match at crossing price — pass
    ❌ Partial fill leaves remainder in book — FAIL (remainder lost)
    ✅ Settlement updates both balances — pass
    ✅ No floating point rounding — pass (after fix)

  QA Worker → RESULT.md: "5/6 pass. Bug: partial fills lose remainder."
  │
  ▼
BRIDGE → MANAGER:
  Manager reads QA results.

  RETRY ATTEMPT 1:
  Manager → creates bug fix task: "Fix partial fill remainder not persisted"
  Worker B resumes (--continue, remembers building the matching engine) → fixes
  │
  ▼
  Manager triggers QA re-run → QA Worker (--continue, knows previous results):
    Re-tests partial fill → PASS ✅
    Regression check on other tests → all still passing ✅
  │
  ▼
MANAGER → USER (via SSE):
    "Milestone 1 complete! Core engine working.
     Order book ✅ Matching ✅ Settlement ✅ QA passed (6/6).
     Starting Milestone 2 (API layer). Estimated: ~30 Lux."

  Updates project-state.md:
    Milestone 1: COMPLETE
    Milestone 2: IN PROGRESS

  ═══════════════════════════════════════════════════════════════
  USER FEEDBACK MID-PROJECT
  ═══════════════════════════════════════════════════════════════

USER: "Actually, I want stop-loss orders too. And the order book should be red/green themed."
  │
  ▼
BRIDGE QUEUE → MANAGER (--continue, has full project context):

  Manager reads project-state.md → knows current status, knows milestones.

  Manager thinks:
    "Two requests:
     1. Stop-loss orders — new feature, affects matching engine (Milestone 1 code)
        and API layer (Milestone 2). Need a worker task.
     2. Red/green theme — this is UI, belongs in Milestone 3.

     I'll add stop-loss to Milestone 2 since it affects the API layer.
     Theme goes into Milestone 3 task list."

  Manager → USER:
    "Got it!
     - Stop-loss orders: adding to Milestone 2 (will implement with API layer)
     - Red/green theme: noted for Milestone 3 (frontend)
     Updated budget estimate: ~520 Lux total (was 500)."

  Updates project-state.md with new requirements + revised budget.
  Creates new task: "Implement stop-loss order type" for Milestone 2.

  ... project continues through Milestones 2, 3, QA ...

  ═══════════════════════════════════════════════════════════════
  USER SAYS "STOP EVERYTHING"
  ═══════════════════════════════════════════════════════════════

USER: "Stop everything. The matching engine is wrong. It should use time priority not price priority."
  │
  ▼
BRIDGE QUEUE → MANAGER:

  Manager reads the urgent message.
  Manager → active workers: writes STOP_REQUESTED file in their workspaces
  Workers save partial results and exit.

  Manager → USER:
    "Stopped all active work. You want time-priority matching instead of price-priority.
     This affects the core engine (Milestone 1 code).

     I'll create a refactoring task. The matching-engine.ts needs to be rewritten.
     Other milestones are paused until this is resolved.
     Additional cost: ~15 Lux for the refactor + re-QA."

  Updates project-state.md:
    ## Architecture Decisions
    - [2026-02-21] CHANGED: time-priority matching (was price-priority) — user request

  Creates refactor task → Worker B resumes (--continue, knows the codebase) → fixes → QA → continues

TOTAL PROJECT:
  Duration: days to weeks (user provides feedback at their pace)
  Cost: ~500-600 Lux
  Sessions used: 1 Manager (persistent) + 3-8 Workers (persistent per task) + QA Agent (persistent)
  All sessions resumable via --continue indefinitely
```

---

## SCENARIO 5: User Feedback Inside a Project Thread

**User input:** "I don't like the login page" (inside Binance DEX project thread)

```
USER (in project thread "Decentralized Exchange"):
  "I don't like the login page"
  │
  ▼
GATEWAY: POST /chat/message {
  message: "I don't like the login page",
  threadId: "dex-project-123",
  projectId: "decentralized-exchange-1739..."
}
  │
  ▼
NODE.JS:
  Sees projectId → this is an EXISTING PROJECT conversation.
  NO ROUTER CALL. Router is bypassed — user is already in a project.
  │
  ▼
BRIDGE QUEUE:
  enqueue('project-decentralized-exchange', {
    type: 'user_request',
    source: 'user:jai',
    payload: { message: "I don't like the login page" }
  })
  │
  ▼
MANAGER (--continue, has FULL context of the DEX project):

  Manager reads project-state.md → knows Worker F built the frontend.

  Manager thinks:
    "User doesn't like the login page.
     Worker F built the frontend in Milestone 3. Login page is in src/pages/login.tsx.
     I have Worker F's session in project-state.md — it knows the codebase.

     But I need more info — what specifically don't they like?"

  Manager → USER (via bridge → SSE):
    "I hear you on the login page. What specifically would you change?
     - Layout / positioning?
     - Colors / theme?
     - Too many fields?
     - Something else?"
  │
  ▼
USER: "Too cluttered. Just email and password. Remove the social login buttons."
  │
  ▼
BRIDGE → MANAGER:
  Manager thinks: "Clear feedback. Worker F can handle this."

  Checks project-state.md for Worker F's session ID.
  Creates task: {
    title: "Simplify login page",
    description: "Remove social login buttons. Keep only email + password.
                  Clean up layout — less cluttered.
                  File: src/pages/login.tsx",
    workerSession: "worker-F-session-id"  ← resume existing worker
  }
  │
  ▼
SCHEDULER → WORKER F (--continue, remembers building the frontend):

  Worker F follows its todo:
    □ UNDERSTAND: Simplify login — remove social buttons, email+password only
    □ PLAN: Edit login.tsx, remove OAuthButtons component, simplify form
    □ BUILD: Edit src/pages/login.tsx
    □ TEST: Visual check — login form renders correctly
    □ REPORT: RESULT.md
    □ REFLECT: "Task was clear and quick. No issues."

  Worker F → RESULT.md → bridge
  │
  ▼
MANAGER → triggers QA:
  QA Agent (--continue): tests login page → screenshot → passes
  │
  ▼
MANAGER → USER:
  "Done! Simplified the login page — email + password only.
   [Screenshot] [Preview link]"

  Updates project-state.md: "Login page simplified per user request"

Total cost: ~2-3 Lux (one worker task + QA)
Total time: ~5-10 minutes
Router: NOT involved (user was already in project thread)
```

---

## SCENARIO 6: Worker Asks User a Question (Two Paths)

**Worker needs user input during a task. Two paths depending on urgency.**

### Path A: Normal question (through Manager — Manager can add context or answer itself)

```
WORKER F (building login page, needs design decision):

  Worker F (during BUILD step): "The user said 'clean layout' but I need to know:
    light theme or dark theme for the login page?"

  Worker F → POST /tasks/{taskId}/messages {
    messageType: "question",
    content: "Should the login page use light or dark theme?"
  }
  │
  ▼
BRIDGE QUEUE → MANAGER (--continue):
  Manager sees worker's question.

  Manager thinks: "I know from project-state.md that the rest of the app
    uses dark theme. I can answer this myself — no need to bother the user."

  Manager → Worker F (via bridge):
    "Use dark theme — the rest of the app uses dark theme. Match the existing palette."
  │
  ▼
WORKER F (--continue): "Got it." Continues building.
```

**When Manager adds value:** Manager has project-wide context. It can answer questions workers can't (like "what theme does the rest of the app use?"). Manager can also BATCH multiple worker questions into one user message instead of spamming.

### Path B: Direct to user (Manager can't answer, or Manager is busy)

```
WORKER F (building login page, needs user preference):

  Worker F: "User said 'make it pretty' — but pretty means different things
    to different people. I need their preference."

  Worker F → POST /tasks/{taskId}/messages {
    messageType: "question",
    urgency: "direct",
    content: "I'm building your login page. What style do you prefer?
              1. Minimal (white space, clean lines)
              2. Bold (large typography, bright colors)
              3. Playful (rounded corners, illustrations)"
  }
  │
  ▼
BRIDGE: Sees urgency: "direct" → bypasses Manager queue
  │
  ▼
SSE → USER (immediately):
  "Worker building your login page asks:
   **What style do you prefer?**
   1. Minimal  2. Bold  3. Playful"
  │
  ▼
USER: "Minimal"
  │
  ▼
BRIDGE → WORKER F directly
  Worker F: "Minimal it is." Continues building.

Meanwhile: Manager sees the exchange in bridge audit trail.
  Updates project-state.md: "Login page style: minimal (user preference)"
```

**When workers talk directly:**
- Manager is busy processing another item (don't wait)
- Question is pure user preference (Manager can't answer — only user knows)
- Worker is completely blocked and needs answer NOW
- Manager sees everything in the bridge audit trail (never out of the loop)

---

## SCENARIO 7: Worker Stuck + Urgent Direct Question

**Worker is completely blocked and Manager is busy.**

```
Worker G (building charts) is completely blocked:
  "I need the API endpoint URL for price history data.
   It's not in my task spec or CLAUDE.md. Can't continue."

  Manager is currently busy processing a milestone review (takes ~5 min).

  Worker G → POST /tasks/{taskId}/messages {
    messageType: "stuck",
    urgency: "direct",
    content: "Need price history API endpoint URL. Not in my task spec.
              Can't build charts without it. Is it /api/prices or /api/history?"
  }
  │
  ▼
BRIDGE: Sees urgency: "direct" → bypasses Manager queue
  │
  ▼
SSE → USER (immediately):
  "Worker building charts needs help:
   **What's the price history API endpoint? /api/prices or /api/history?**"
  │
  ▼
USER: "/api/prices — it returns the last 30 days by default"
  │
  ▼
BRIDGE → WORKER G directly (not through Manager):
  Worker G: "Got it — /api/prices, last 30 days."
  Continues building charts.

Meanwhile: Manager finishes its current work, sees the exchange in bridge audit trail.
  Manager updates project-state.md: "Price history endpoint: /api/prices (30 day default)"
  (So no one has to ask again)
```

---

## SCENARIO 8: "Create a Task to Fix the Login Bug" (Explicit Task Creation)

**User input:** "Create a task to fix the login bug" (in DEX project thread)

```
USER (in DEX project thread): "Create a task to fix the login bug"
  │
  ▼
NODE.JS: Sees projectId → routes to project bridge (no Router call)
  │
  ▼
BRIDGE → MANAGER (--continue, knows the project):

  Manager reads project-state.md:
    Recent QA: login page passed all tests.
    No known bugs logged.

  Manager → USER:
    "I don't have a logged bug for the login page. Can you describe what's happening?
     - Does the page not load?
     - Does login fail with correct credentials?
     - Is it a visual issue?"
  │
  ▼
USER: "Login fails when email has a + in it, like john+test@gmail.com"
  │
  ▼
BRIDGE → MANAGER:
  Manager: "Got it — URL encoding bug with + character in emails."

  Creates task: POST /tasks {
    title: "Fix login: email with + character fails",
    description: "The + character in email (e.g. john+test@gmail.com) causes login failure.
                  Likely URL encoding issue. File: src/pages/login.tsx or src/api/auth.ts.
                  Reproduce: try logging in with an email containing +.",
    priority: "high",
    project: "decentralized-exchange"
  }

  Approves task immediately (clear bug, clear fix).
  Updates project-state.md:
    ## Known Issues
    - Login fails with + in email (URL encoding) — task created, assigned
  │
  ▼
SCHEDULER → WORKER (--continue from previous auth work if available):
  Worker follows todo: understand → plan → fix → test → report
  Worker fixes the + encoding bug → RESULT.md → bridge
  │
  ▼
MANAGER → QA:
  QA Agent tests: login with john+test@gmail.com → passes ✅
  │
  ▼
MANAGER → USER:
  "Fixed! The + character in emails was being URL-decoded incorrectly.
   QA verified: login with special characters now works."

  Updates project-state.md: known issue resolved.

Total cost: ~2-3 Lux
Key: MANAGER added context that the user didn't provide (file names, likely cause)
```

**Contrast: Same message OUTSIDE a project thread:**

```
USER (fresh chat, no project): "Create a task to fix the login bug"
  │
  ▼
ROUTER (OpenAI):
  Returns: { type: "action", action: "needs_context",
             question: "Which project has the login bug?" }
  │
  ▼
NODE.JS checks user's projects:
  Found: [decentralized-exchange, portfolio-site, blog-app]
  │
  ▼
USER SEES:
  "Which project has the login bug?
   1. Decentralized Exchange
   2. Portfolio Site
   3. Blog App
   4. Other (describe it)"
  │
  ▼
USER: "1" (Decentralized Exchange)
  → Redirects to DEX project thread → same flow as above
```

---

## SCENARIO 9: Public Project (Multiple Users Collaborating)

**User A:** "Build a chess game for all Pando users"

```
═══════════════════════════════════════════════════════════════
  PHASE 1: PROPOSAL (User A initiates)
═══════════════════════════════════════════════════════════════

USER A: "Build a chess game for all Pando users"
  │
  ▼
ROUTER:
  Detects "for all Pando users" → projectType: "public"
  Returns: { type: "project", projectType: "public", title: "Chess Game" }
  │
  ▼
NODE.JS:
  Public project → governance required.
  Creates proposal: POST /governance/propose {
    title: "Public Project: Chess Game",
    description: "Build a chess game accessible to all Pando users.
                  Proposed by: User A (peer: 12D3Koo...)",
    budget: 100,
    fundingSource: "NETWORK"
  }
  │
  ▼
USER A SEES:
  "This is a public project — it needs network approval.
   Governance proposal created: 'Chess Game' (ID: gov-789).
   Needs 2+ node votes to proceed. I'll notify you when approved."

NETWORK VOTES (happens over hours/days):
  Node B: "approve" (reason: "good for user engagement")
  Node C: "approve" (reason: "agreed, games attract users")
  → 2+ approvals → PROPOSAL PASSES
  │
  ▼
NODE.JS:
  Proposal passed → creates public project workspace
  Spawns Manager funded from NETWORK account (not User A's balance)
  Notifies User A: "Chess Game approved! Work is starting."

═══════════════════════════════════════════════════════════════
  PHASE 2: BUILDING (Manager + Workers)
═══════════════════════════════════════════════════════════════

MANAGER (Claude Code, project lead for "Chess Game"):
  Plans milestones, spawns workers, builds chess game.
  Same flow as Scenario 4 (complex project).

  Manager posts progress updates to public project thread.
  Any user can see the thread (it's public).

═══════════════════════════════════════════════════════════════
  PHASE 3: OTHER USERS CONTRIBUTE
═══════════════════════════════════════════════════════════════

USER B (discovers chess game on /projects page):
  "Add multiplayer support to the chess game"
  │
  ▼
ROUTER:
  Detects: references existing project "Chess Game"
  Returns: { type: "project", existingProject: "chess-game-gov789" }
  │
  ▼
NODE.JS:
  Finds existing public project → routes to its bridge queue
  │
  ▼
BRIDGE QUEUE for chess-game:

  ┌────────────────────────────────────────────────────┐
  │  Queue (FIFO with priority):                        │
  │                                                    │
  │  [1] user_request from User B: "Add multiplayer"    │
  │  [2] worker_message from Worker: "Board UI done"    │
  │  [3] user_request from User C: "Fix pawn movement"  │
  │                                                    │
  │  Manager processes ONE at a time.                   │
  └────────────────────────────────────────────────────┘

MANAGER processes queue:

  Item 1 — User B wants multiplayer:
    Manager checks project-state.md: budget = 100 Lux, spent = 55 Lux.
    Multiplayer estimate: ~40 Lux. 55 + 40 = 95 Lux — within budget.
    Manager: "Within budget. Creating multiplayer tasks."

    (If over budget: Manager creates governance proposal for budget increase.)

  Item 2 — Worker finished board UI:
    Manager reviews, triggers QA, merges.

  Item 3 — User C found a bug:
    Manager creates fix task, assigns to worker.
    Manager → User C: "Thanks for reporting! Fixing pawn movement now."

═══════════════════════════════════════════════════════════════
  CONFLICTING INSTRUCTIONS
═══════════════════════════════════════════════════════════════

USER A: "Make the board 3D with WebGL"
USER B: "Keep the board simple 2D, 3D is bloat"
  │
  ▼
Manager detects conflict:
  Manager → public thread:
    "Conflicting requests:
     - User A: 3D board with WebGL
     - User B: Simple 2D board

     This needs a community vote. Creating proposal:
     'Chess Board: 2D vs 3D rendering'

     Please vote!"
  → POST /governance/propose { title: "Chess: 2D vs 3D" }
  → Network votes → winner implemented

═══════════════════════════════════════════════════════════════
  MULTI-USER MESSAGE FLOW
═══════════════════════════════════════════════════════════════

All users see the public project thread (read access).
Users send messages → their messages include their identity (peer ID / session).
Bridge queue tags each message with sender identity.
Manager knows WHO said WHAT:

  Bridge item: {
    type: 'user_request',
    source: 'user:12D3KooW-userB',
    payload: { message: "Add multiplayer" }
  }

Manager responds to the right user via SSE (tagged with recipient):

  SSE event: {
    type: 'chat_message',
    projectId: 'chess-game',
    recipient: 'user:12D3KooW-userB',  ← only User B sees this
    content: "Working on multiplayer. ETA: 2 days."
  }

Public updates go to ALL watchers:

  SSE event: {
    type: 'project_update',
    projectId: 'chess-game',
    content: "Milestone 2 complete: Board UI + basic moves. QA passed."
  }
```

---

## SCENARIO 10: Writing a Book (Non-Code Project)

**User input:** "Write me a book about artificial intelligence" (fresh chat)

```
USER: "Write me a book about artificial intelligence"
  │
  ▼
ROUTER:
  Returns: {
    type: "project",
    projectType: "personal",
    title: "Book: Artificial Intelligence",
    complexity: "complex",
    estimatedCost: 50,
    suggestedTemplate: "writing-project"
  }
  │
  ▼
PAYMENT GATE → confirm cost → user says yes
  │
  ▼
BRIDGE → MANAGER (Claude Code, writing project lead):

  Manager's CLAUDE.md includes writing template:
    "You are a project lead for a writing project.
     Your workflow: RESEARCH → OUTLINE → DRAFT → EDIT → DELIVER.
     You have workers for research and drafting.
     You review and edit yourself (quality control on voice/tone).
     Use markdown files for chapters."

  Manager DECLARES WORKFLOW:
    Step 1: RESEARCH — gather topics, structure, key themes
    Step 2: OUTLINE — chapter plan (get user approval before drafting)
    Step 3: DRAFT — write chapters (can parallelize across workers)
    Step 4: EDIT — review, refine, consistency check
    Step 5: DELIVER — compile final book

  Manager → USER:
    "I'll write your AI book. First, let me propose an outline:

     Chapter 1: What Is Intelligence?
     Chapter 2: How Neural Networks Work
     Chapter 3: Large Language Models
     ...
     Chapter 10: The Future of AI and Humanity

     Does this structure work? Want to add or remove chapters?"
  │
  ▼
USER: "Add a chapter on AI ethics. Remove the history chapter — boring."
  │
  ▼
MANAGER:
  Updates outline in project-state.md.

  For a 10-chapter book, Manager spawns parallel workers:
    Worker A: Draft chapters 1-3 (CLAUDE.md: "Write in accessible, engaging style...")
    Worker B: Draft chapters 4-6
    Worker C: Draft chapters 7-10

  Workers write in markdown: chapter-01.md, chapter-02.md, etc.
  Workers follow their todo: understand → plan → write → self-review → report.
  Manager reviews each chapter for quality, consistency, and voice.

  (Same feedback loop — user can say "chapter 3 is too technical" →
   Manager sends revision task to Worker A who resumes with --continue)

Total: Book delivered as a set of markdown files.
```

---

## SCENARIO 11: Suggestion, Not Task

**User input:** "You should change your node architecture to use microservices"

```
USER: "You should change your node architecture to use microservices"
  │
  ▼
ROUTER:
  Thinks: "This is a SUGGESTION, not a task request. Conversation, not project."
  Returns: {
    type: "answer",
    response: "Interesting suggestion. Currently Pando uses a monolith architecture
               because [reasons]. Microservices would add [benefits] but also [tradeoffs].
               Want me to create a governance proposal so the network can vote on this?"
  }
  │
  ▼
USER SEES: Architecture discussion + offer to create proposal.

If user says "yes, create a proposal":
  → action: create_proposal → POST /governance/propose { ... }
  → "Proposal created. Needs network votes."

Cost: $0.001 (just the Router call)
```

---

## SCENARIO 12: Long-Running Evolving Project (Months/Years)

**User:** "Research quantum computing and write quarterly reports"

```
USER: "Research quantum computing advances and write a quarterly report"
  │
  ▼
ROUTER → project, complexity: "ongoing", estimatedCost: "20 Lux/quarter"
PAYMENT GATE → user confirms recurring cost
  │
  ▼
MANAGER (persistent, survives months via --continue):

  DECLARES WORKFLOW (recurring):
    Step 1: RESEARCH — web search, paper collection
    Step 2: ANALYZE — identify trends, breakthroughs
    Step 3: DRAFT — write quarterly report
    Step 4: REVIEW — fact-check, edit
    Step 5: DELIVER — send to user
    Step 6: WAIT — schedule next run in 90 days
    Step 7: SELF-REFLECT — adapt template for next quarter

  Manager completes Q1 report. Then REFLECTS:

    "Q1 reflection:
     - Spent too much time on hardware, not enough on algorithms
     - User said 'more practical examples' — should add a section
     - My RESEARCH step was too broad — narrow to top 10 papers

     Updated workflow template for Q2:
       Step 1: RESEARCH — top 10 papers only + industry news
       Step 1b: PRACTICAL — find 3 real-world implementations
       Step 2: ANALYZE — trends + practical implications
       Step 3: DRAFT — include 'Real World' section
       ..."

  Updates project-state.md with evolved template.
  Q2 uses the improved template. Q3 improves further. The Manager gets BETTER.

KEY:
  - project-state.md persists the evolved workflow template
  - Even if Claude Code's context compresses, the template survives in the file
  - Manager reads project-state.md every session → always has latest template
  - Over months/years, the Manager becomes an expert at this specific project
```

---

## SCENARIO 13: QA Agent Stuck (Infrastructure Issue)

```
QA Agent running login page tests:
  → Opens Playwright browser → navigates to /login
  → Page shows loading spinner... keeps loading...
  → 5 minutes pass. Element not found.

QA Agent follows stuck protocol:
  □ Takes screenshot
  □ Posts: POST /tasks/{taskId}/messages {
      messageType: "stuck",
      content: "Login page not loading. Shows infinite spinner.
                Possible causes: dev server down, port blocked, app crash.
                Screenshot attached: loading-spinner.png"
    }
  □ Skips login tests, continues with other test suites
  □ Reports in RESULT.md: "4/10 suites passed. Login suite SKIPPED (page not loading)."
  │
  ▼
BRIDGE → MANAGER:
  Manager reads stuck report.
  Manager checks: "Is the dev server running?"

  Manager can:
    a) Fix it: "Dev server config looks wrong, port changed"
       → Creates fix task for worker → fix → re-run QA
    b) Can't fix: Escalate to user
       → "QA found that the login page won't load.
          Is the dev server running? Did you change the port?"
  │
  ▼
USER: "Oh, I moved it to port 8080 yesterday."
  │
  ▼
MANAGER:
  Updates project config.
  Updates project-state.md: "Dev server port: 8080 (changed from 3000)"
  Re-triggers QA → QA Agent resumes (--continue) → tests pass
```

---

## SCENARIO 14: Node Crash + Recovery (Kill-Proof)

```
Worker B is building the matching engine.
Windows reboots (automatic update).
Worker process killed. No RESULT.md written.

RECOVERY:
  1. Windows reboots → PM2 restarts Pando node
  2. Node starts → Scheduler calls recoverOrphanedTasks()
  3. Finds Task B: status "in_progress", no result, worker dead
  4. Scheduler resumes Worker B:
     claude -p "Continue your task" --continue --resume {workerB-session}
  5. Worker B wakes up with full context (Claude Code session persisted on disk)
  6. Worker B: "I was building the matching engine. Let me check where I left off..."
  7. Reads its own files in workspace → sees partially written matching-engine.ts
  8. Continues from where it stopped

WHAT'S PRESERVED:
  ✅ Worker B's Claude Code session (on disk, survives reboot)
  ✅ Worker B's workspace files (partially written code)
  ✅ Manager's session (resumes when bridge watcher triggers it)
  ✅ Bridge queue (on disk, items not lost)
  ✅ project-state.md (all decisions, status, worker registry)

WHAT'S LOST:
  ❌ In-memory state of running Claude Code process (re-loaded from session file)
  ❌ Any unsaved work in Claude Code's buffer (last few seconds of work)

NET RESULT: ~30 seconds of work lost. Everything else recovers automatically.
```

---

## THE MANAGER'S SELF-EVOLVING WORKFLOW

```
═══════════════════════════════════════════════════════════════
  SESSION 1 (first task — default template)
═══════════════════════════════════════════════════════════════

  TODO LIST:
    □ 1. CONTEXT: Read project-state.md — what's the current state?
    □ 2. PLAN: Read task, understand requirements.
    □ 3. SPAWN: Create worker task, write worker CLAUDE.md.
    □ 4. MONITOR: Check worker at 50% estimated time. If stuck → help.
    □ 5. REVIEW: Read worker output, check quality.
    □ 6. QA: Launch QA agent, run tests.
    □ 7. COMMIT: If QA passes, commit + push.
    □ 8. VERIFY GENOME: Check genome updates from workers/QA. Correct if wrong.
    □ 9. DOCS: Update project-state.md. Update genome only for what Manager did directly.
    □ 10. REPORT: Tell user what was done.
    □ 11. REFLECT: Should I change my process? Update template.

═══════════════════════════════════════════════════════════════
  SESSION 2 (learns from session 1)
═══════════════════════════════════════════════════════════════

  REFLECTION from Session 1:
    "QA found 3 bugs after I approved the worker's code.
     I should review MORE carefully.
     Also, the worker didn't write tests — I should require them."

  UPDATED TODO:
    □ 2. SPAWN: *** REQUIRE: Worker must include unit tests ***
    □ 5. REVIEW: *** Check: error handling, edge cases, test coverage ***
    □ 6. QA: Skip if review fails → send back to worker first.

═══════════════════════════════════════════════════════════════
  SESSION 10 (experienced manager)
═══════════════════════════════════════════════════════════════

  Evolved template:
    □ 1. CONTEXT: Read project-state.md. What changed since last session?
    □ 2. TRIAGE: Is this critical, normal, or trivial?
           Critical → detailed plan + dedicated worker
           Normal → standard worker task
           Trivial → Manager does it directly (saves worker spawn cost)
    □ 3. SPAWN: If worker needed:
           - Full context from project-state.md
           - Required: tests + error handling
           - Include related file paths in CLAUDE.md
           - Workspace has project memory injected
    □ 4. MONITOR: Check worker at 50% and 100% of estimate.
           If stuck → review progress, suggest direction.
           If idle → check for errors, restart if needed.
           If over budget → pause and report.
    □ 5. REVIEW: Thorough code review:
           Security, edge cases, test coverage, style.
           Read worker's REFLECT feedback for next time.
    □ 6. QA: Automated tests (QA agent).
           For UI changes: screenshot comparison.
           For API changes: endpoint regression.
           Max 3 retry cycles → then escalate to user.
    □ 7. INTEGRATE: Merge worker output into main codebase.
           Resolve conflicts if multiple workers contributed.
    □ 8. COMMIT+PUSH: git add, commit, push.
    □ 9. DOCS: Update project-state.md, genome if applicable.
    □ 10. REPORT: Summary to user + recommended next actions.
    □ 11. REFLECT: What went well? What broke? Update template.
           - Did worker deliver on first attempt?
           - Did QA catch what review missed?
           - Did user request changes after delivery?
           - Was any step unnecessary?
           - Save updated template to project-state.md.

═══════════════════════════════════════════════════════════════
  WHY THIS WORKS
═══════════════════════════════════════════════════════════════

  The Manager's todo is stored in project-state.md (file, not memory).
  Even if Claude Code's context window compresses after 200+ events:
    → Manager reads project-state.md at session start
    → Gets its evolved template back
    → Continues improving from where it left off
    → Never regresses to the default template

  The template is PROJECT-SPECIFIC:
    → DEX project Manager might add "security audit" step
    → Book project Manager might add "consistency check" step
    → Each Manager evolves differently based on its project's needs
```

---

## COMPLETE ARCHITECTURE DIAGRAM

```
┌──────────────────────────────────────────────────────────────────────┐
│                           USER MESSAGE                                │
│         (Gateway: web UI, or TUI: terminal, or MCP: Claude Code)     │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │   Is user INSIDE a       │
                    │   project thread?        │
                    └────────────┬────────────┘
                         │              │
                        NO             YES
                         │              │
                         ▼              ▼
                  ┌──────────┐   ┌─────────────────┐
                  │  ROUTER  │   │  BRIDGE QUEUE    │
                  │ (OpenAI) │   │  (direct to      │
                  │  $0.001  │   │   project mgr)   │
                  └────┬─────┘   └────────┬────────┘
                       │                  │
            ┌──────────┼──────────┐       │
            │          │          │       │
            ▼          ▼          ▼       │
        "answer"   "action"  "project"   │
            │          │          │       │
            ▼          ▼          │       │
         Return     Node.js      │       │
         to user    executes     │       │
                    (free)       │       │
                                 │       │
                    ┌────────────┘       │
                    │                    │
                    ▼                    ▼
             ┌──────────────┐    ┌──────────────┐
             │ PAYMENT GATE │    │              │
             │ Check balance│    │              │
             │ Show estimate│    │              │
             │ Get confirm  │    │              │
             └──────┬───────┘    │              │
                    │            │              │
                    ▼            │              │
             ┌──────────────────────────────────┐
             │         BRIDGE QUEUE              │
             │  (per-project, FIFO + priority)   │
             │                                  │
             │  Items from:                      │
             │    - User messages                │
             │    - Worker results               │
             │    - Worker discoveries           │
             │    - Worker stuck reports         │
             │    - QA results                   │
             │    - Health alerts                │
             │    - Strategy suggestions         │
             └──────────────┬───────────────────┘
                            │
                            ▼
             ┌──────────────────────────────────┐
             │           MANAGER                │
             │    (Claude Code, persistent)      │
             │    --continue --resume {id}       │
             │                                  │
             │    Processes ONE item at a time.  │
             │    Reads project-state.md first.  │
             │    Follows self-evolving todo.    │
             │    Writes project-state.md last.  │
             │                                  │
             │    DECIDES:                       │
             │      → Do it myself (trivial)     │
             │      → Spawn worker (complex)     │
             │      → Resume worker (revision)   │
             │      → Ask user (needs input)     │
             │      → Run QA (after milestone)   │
             │      → Create proposal (public)   │
             │      → Refuse (over budget)       │
             │      → Escalate conflict (multi)  │
             └──────┬──────┬──────┬─────────────┘
                    │      │      │
            ┌───────┘      │      └────────┐
            ▼              ▼               ▼
     ┌───────────┐  ┌───────────┐   ┌───────────┐
     │  WORKER   │  │ QA AGENT  │   │   USER    │
     │  (Claude  │  │ (Claude   │   │  (via SSE │
     │   Code,   │  │  Code +   │   │   in      │
     │  persist) │  │ Playwright│   │  gateway)  │
     │           │  │  persist) │   │           │
     │  Own todo │  │  Own todo │   │  Sees     │
     │  Reports  │  │  Reports  │   │  progress │
     │  discover │  │  regress  │   │  Gives    │
     │  ies      │  │  track    │   │  feedback │
     └─────┬─────┘  └─────┬────┘   │           │
           │               │        │ urgent:   │
           │               │        │ direct ◄──┤
           └───────┬───────┘        └───────────┘
                   │                      ▲
                   ▼                      │
            BRIDGE QUEUE ─────────────────┘
            (results + discoveries + stuck reports flow back)
```

---

## WHAT THIS ARCHITECTURE GUARANTEES

| Property | How it's achieved |
|---|---|
| **Kill-proof** | All sessions persist on disk. `--continue` resumes from any crash. PM2 restarts node. Bridge queue on disk. project-state.md survives everything. |
| **Context-preserving** | project-state.md = external brain. Survives context compression. Manager reads it every session. Workers get relevant context in CLAUDE.md. Genome files capture what each actor built/tested. |
| **Cost-controlled** | PaymentGate checks before ANY project starts. Manager tracks budget in project-state.md. Retry budget (3 max). 2x overspend pauses work. User can cancel anytime. |
| **Feedback-friendly** | User talks to Manager directly in project thread. Workers can talk directly to user when needed (urgency:direct). No Router delay. Back-and-forth like chatting with a team. |
| **QA-integrated** | QA Agent runs after every milestone. Manager won't deliver without QA pass. QA tracks regression across runs via --continue. QA updates genome with test results. |
| **Multi-user safe** | Bridge queue serializes. Manager processes one message at a time. No conflicts. Conflicting instructions → governance vote. |
| **Self-improving** | Manager REFLECT step evolves workflow template. Stored in project-state.md (file, not memory). Workers give feedback too. System gets better over time. |
| **Self-documenting** | Every actor updates genome for what it touches. Workers update component docs after code changes. QA updates state with test results. Manager verifies accuracy. No drift between code and docs. |
| **Scalable** | One node handles 20-50 users. ResourceRouter sends heavy tasks to bigger nodes. Same architecture, different machine. Swap SQLite for Kafka at scale — pattern doesn't change. |
| **Governance-aware** | Public projects require network vote. Budget expansions require vote. Conflicts require vote. Manager never picks sides. |
| **Discovery-aware** | Workers report bugs found outside their scope. Manager triages and creates new tasks. Nothing gets silently ignored. |
| **Stuck-resilient** | Workers self-detect stuck state. Can talk to user directly if Manager is busy. Escalation chain: self → Manager → user → timeout. Urgent bypass available. |
| **Never-dying** | Node restarts → sessions resume. Projects survive months/years. Templates evolve. External brain (project-state.md) never forgets. Genome captures the full knowledge. |

---

## WHAT'S ALREADY BUILT vs. WHAT'S MISSING

| Capability | Code exists? | Wired? | Status |
|---|---|---|---|
| Simple tier routing (keyword / Claude Code) | ✅ api-server.ts FREE_PATTERNS | ✅ Wired (Phase 28) | DONE |
| Node.js actions (balance, transfer) | ✅ handleLocalFallback + FREE_PATTERNS | ✅ Works | DONE |
| Bridge Queue | ✅ bridge-queue.ts | ✅ Works | DONE |
| Manager spawning + sessions | ✅ agent.ts + agent-manager.ts | ✅ Works | DONE |
| Manager workflow/todo | ✅ CLAUDE.md template + API | ✅ Works | DONE |
| Manager self-reflection | ✅ In CLAUDE.md instructions | ✅ Works (Claude follows) | DONE |
| Worker spawning + isolation | ✅ agent-manager.ts spawnAgent() | ✅ Works + delegation E2E verified (27-I) | DONE |
| Worker → bridge communication | ✅ POST /agents/:id/report | ✅ Wired | DONE |
| Worker todo list + reflect + genome update | ✅ builder.md Mandatory Workflow (Phase 28) | ✅ In templates | DONE |
| Worker → user direct communication | ✅ urgency:direct bypass in agent-manager.ts (Phase 28) | ✅ Wired | DONE |
| Worker discovery flow | ✅ messageType "discovery" handled in bridge | ✅ Prompt includes it | DONE |
| Stuck detection + escalation | ✅ stuckTimer (3 min) + timeout (5 min) in agent-manager.ts (Phase 28) | ✅ Wired | DONE |
| QA todo list + genome update | ✅ tester.md Mandatory QA Workflow (Phase 28) | ✅ In templates | DONE |
| Chat sessions (Claude Code) | ✅ ThreadStore + agent.ts | ✅ Works | DONE |
| Thread persistence | ✅ ThreadStore + activity logs | ✅ Works | DONE |
| Payment Gate | ✅ payment-gate.ts + agent-manager.ts (Phase 28) | ✅ Wired to chat flow | DONE |
| QA Agent auto-prompt | ✅ buildPromptFromBridgeItem includes QA instructions (Phase 28) | ✅ Manager prompted to spawn QA | DONE |
| Budget tracking + overspend pause | ✅ agent.ts budgetSpent/budgetLimit + agent-manager.ts check (Phase 28) | ✅ Wired | DONE |
| project-state.md as external brain | ✅ Auto-created by agent.ts buildClaudeMd() (Phase 28) | ✅ Enforced: auto-create + read/inject + protocol instructions | DONE |
| Chat → Bridge (project routing) | ✅ api-server.ts thread message → bridge.enqueue | ✅ Works (Phase 27-F) | DONE |
| Manager decision execution | ✅ Bridge events → agent.sendEvent() | ✅ Works (Phase 27) | DONE |
| Worker persistence (--continue) | ✅ agent.ts --continue --resume | ✅ Works (continuation E2E verified) | DONE |
| Parent context injection for workers | ✅ Layer 2b in buildClaudeMd() (Phase 28) | ✅ Wired | DONE |
| Manager verifies worker output | ✅ manager.md Verifying Worker Output section (Phase 28) | ✅ In templates | DONE |
| Node crash recovery | ✅ recoverOrphanedTasks + stale processing reset | ✅ Works | DONE |
| Agent-driven deployment | ✅ POST /agents/:id/deploy + deployAgentWorkspace() | ✅ E2E verified (Phase 32.5) | DONE |
| Event prompt injection (context compression) | ✅ buildPromptFromBridgeItem() injects critical instructions | ✅ Works (Phase 32.5) | DONE |
| Session reset | ✅ POST /agents/:id/reset-session + resetSession() | ✅ Works (Phase 32.5) | DONE |
| Project discovery (find existing) | ❌ No semantic search | ❌ | BUILD |
| Multi-user project threads | ⚠️ ProjectEntry registry exists (27-E) | ⚠️ No shared thread views | BUILD |
| Conflicting instructions → governance | ❌ No conflict detection | ❌ | BUILD |
| Governance → project trigger | ❌ Proposals exist but don't trigger builds | ❌ | BUILD |
| Dependency management | ⚠️ Task blockedBy exists | ❌ Manager doesn't track actively | WIRE |

**Summary: 28 DONE, 1 WIRE, 4 BUILD (was: 25 DONE after Phase 28)**

**Phase 32.5 resolved 3 items** (agent-driven deployment, event prompt injection, session reset).
**Phase 28 resolved 13 items** (7 WIRE → DONE, 5 BUILD → DONE, 1 SIMPLIFY → replaced with simple tier routing).

**Remaining priority order:**
1. **WIRE** (1 item) — dependency management in Manager's task tracking
2. **BUILD** (4 items) — project discovery, multi-user thread views, conflict → governance, governance → project trigger

---

## SCENARIO 15: Self-Governing Development (Node Change via Governance)

**User input:** "Fix the ledger sync bug — balances diverge after 24 hours" (in gateway chat)

This scenario covers the full self-governing development flow where a user requests a change to the node software itself. The manager classifies it as a node change, builds the fix, creates a governance proposal, and (on approval) applies the fix via pipeline.

```
======================================================================
  PHASE 1: CLASSIFICATION (Manager decides this needs governance)
======================================================================

USER: "Fix the ledger sync bug — balances diverge after 24 hours"
  |
  v
BRIDGE QUEUE → MANAGER (pando-node-mgr, --continue):

  Manager reads event prompt (injected classification rules):
    "If the request involves node software, ledger, P2P, governance,
     or any packages/ code: this is a NODE CHANGE. Governance REQUIRED."

  Manager thinks: "Ledger sync = packages/node/src/sync.ts.
    This is node software. I need governance approval."

  Manager → USER (via SSE):
    "I see the ledger sync divergence issue. I'll investigate and build
     a fix, then submit it for governance approval before applying."

======================================================================
  PHASE 2: BUILD (Manager builds fix in isolated workspace)          — DONE
======================================================================

  Manager spawns builder worker (or does it itself for small fixes).
  Fix built in workspace: ~/.pando/agents/pando-node-mgr/workspace/
  Manager verifies the fix works (unit tests in workspace).

======================================================================
  PHASE 3: GOVERNANCE GATE (Manager creates proposal)                — DONE
======================================================================

  Manager → POST /governance/proposals {
    title: "Fix ledger sync divergence after 24h",
    description: "sync.ts always requests from genesis, limit 10000.
                  Prevents balance drift from missed historical txns.",
    category: "bug_fix"
  }

  Proposer node auto-votes APPROVE on its own proposal.
  (Normal behavior — real check comes from OTHER nodes.)

  SINGLE-NODE: If only 1 node on network, early resolution triggers
  immediately (all nodes = 1, all have voted = 1). Proposal PASSES.
  This is ceremonial — accepted for dev, flagged as limitation.

  MULTI-NODE: Proposal broadcast via GossipSub. Other nodes:
    - Phase 30 reviewer selection: hash-based deterministic selection
    - Selected node spawns reviewer agent (different AI instance)
    - Reviewer evaluates: risk score, reasoning, recommendation
    - Community votes (24h window or early resolution when all voted)

  Manager → USER: "Governance proposal created (ID: gov-456).
    Waiting for network approval."

======================================================================
  PHASE 4: PIPELINE (On approval, apply changes)                     — BUILD
======================================================================

  Governance decision: APPROVED
    → Bridge event: { type: 'governance_decision', outcome: 'approved' }
    → Manager receives event via bridge watcher

  Manager → POST /pipeline/run {
    workspaceDir: "~/.pando/agents/pando-node-mgr/workspace/",
    targetDir: "/path/to/pando/"
  }

  PipelineRunner executes 7 stages:
    1. Extract diff from workspace
    2. Backup current files
    3. Apply diff to real codebase
    4. npm run build
    5. QA tests (regression suite)
    6. git commit with governance reference
    7. Report success/failure

  On SUCCESS:
    Manager → USER: "Fix applied and committed (hash: abc123).
      Restarting node to apply changes."
    → Graceful restart via POST /admin/shutdown
    → Phase 29 watchdog brings node back up
    → Manager verifies /health after restart

  On FAILURE:
    PipelineRunner rolls back to backup.
    Manager → USER: "Pipeline failed at build step. Rolled back.
      Error: [build error]. I'll investigate."
    TODO: Notify governance that rollback occurred (not yet wired).

======================================================================
  PHASE 5: CROSS-NODE DISTRIBUTION                                   — PLANNED
======================================================================

  After local success, other nodes need the code:
    Current: git pull from shared repository (assumes all nodes track same repo)
    Future: P2P code distribution via signed artifacts or GossipSub diffs

  UpgradeProtocol stages (exist but not wired to Phase 33):
    Canary (1 node) → Rollout (all nodes) → Monitor → Rollback if needed

Total flow: User message → classification → build → governance → pipeline → restart
Status: Phases 1-3 DONE, Phase 4 BUILD, Phase 5 PLANNED.
```

**Contrast: Same user, different project types:**

```
PRIVATE PROJECT:  "Build me a portfolio site"
  → Manager classifies: private project, no governance
  → Build → Deploy to S3 → Done
  → (Existing flow, works today)

PUBLIC PROJECT:  "Build a chess game for the community"
  → Manager classifies: public project, network governance
  → Build → Governance proposal (all nodes vote) → Pipeline → Deploy
  → (33.0-33.2 done, pipeline trigger not yet E2E tested)

NODE CHANGE:  "Fix the ledger sync bug"
  → Manager classifies: node software, network governance REQUIRED
  → Build → Governance proposal → Pipeline → Restart
  → (33.0-33.2 done, restart not yet E2E tested)

FUTURE — PROJECT GOVERNANCE:  "Add dark mode to our team chess project"
  → Manager classifies: shared/public project, project-level governance
  → Build → Project governance (only collaborators vote, not whole network) → Deploy
  → (33.6 PLANNED — two-tier governance not yet built)
```

---

## WHAT'S ALREADY BUILT vs. WHAT'S MISSING

| Capability | Code exists? | Wired? | Status |
|---|---|---|---|
| Simple tier routing (keyword / Claude Code) | Yes api-server.ts FREE_PATTERNS | Yes Wired (Phase 28) | DONE |
| Node.js actions (balance, transfer) | Yes handleLocalFallback + FREE_PATTERNS | Yes Works | DONE |
| Bridge Queue | Yes bridge-queue.ts | Yes Works | DONE |
| Manager spawning + sessions | Yes agent.ts + agent-manager.ts | Yes Works | DONE |
| Manager workflow/todo | Yes CLAUDE.md template + API | Yes Works | DONE |
| Manager self-reflection | Yes In CLAUDE.md instructions | Yes Works (Claude follows) | DONE |
| Worker spawning + isolation | Yes agent-manager.ts spawnAgent() | Yes Works + delegation E2E verified (27-I) | DONE |
| Worker to bridge communication | Yes POST /agents/:id/report | Yes Wired | DONE |
| Worker todo list + reflect + genome update | Yes builder.md Mandatory Workflow (Phase 28) | Yes In templates | DONE |
| Worker to user direct communication | Yes urgency:direct bypass in agent-manager.ts (Phase 28) | Yes Wired | DONE |
| Worker discovery flow | Yes messageType "discovery" handled in bridge | Yes Prompt includes it | DONE |
| Stuck detection + escalation | Yes stuckTimer (3 min) + timeout (5 min) in agent-manager.ts (Phase 28) | Yes Wired | DONE |
| QA todo list + genome update | Yes tester.md Mandatory QA Workflow (Phase 28) | Yes In templates | DONE |
| Chat sessions (Claude Code) | Yes ThreadStore + agent.ts | Yes Works | DONE |
| Thread persistence | Yes ThreadStore + activity logs | Yes Works | DONE |
| Payment Gate | Yes payment-gate.ts + agent-manager.ts (Phase 28) | Yes Wired to chat flow | DONE |
| QA Agent auto-prompt | Yes buildPromptFromBridgeItem includes QA instructions (Phase 28) | Yes Manager prompted to spawn QA | DONE |
| Budget tracking + overspend pause | Yes agent.ts budgetSpent/budgetLimit + agent-manager.ts check (Phase 28) | Yes Wired | DONE |
| project-state.md as external brain | Yes Auto-created by agent.ts buildClaudeMd() (Phase 28) | Yes Enforced: auto-create + read/inject + protocol instructions | DONE |
| Chat to Bridge (project routing) | Yes api-server.ts thread message to bridge.enqueue | Yes Works (Phase 27-F) | DONE |
| Manager decision execution | Yes Bridge events to agent.sendEvent() | Yes Works (Phase 27) | DONE |
| Worker persistence (--continue) | Yes agent.ts --continue --resume | Yes Works (continuation E2E verified) | DONE |
| Parent context injection for workers | Yes Layer 2b in buildClaudeMd() (Phase 28) | Yes Wired | DONE |
| Manager verifies worker output | Yes manager.md Verifying Worker Output section (Phase 28) | Yes In templates | DONE |
| Node crash recovery | Yes recoverOrphanedTasks + stale processing reset | Yes Works | DONE |
| Agent-driven deployment | Yes POST /agents/:id/deploy + deployAgentWorkspace() | Yes E2E verified (Phase 32.5) | DONE |
| Event prompt injection (context compression) | Yes buildPromptFromBridgeItem() injects critical instructions | Yes Works (Phase 32.5) | DONE |
| Session reset | Yes POST /agents/:id/reset-session + resetSession() | Yes Works (Phase 32.5) | DONE |
| Request classification (node vs project) | Yes Event prompt injection in manager template | Yes E2E verified (Phase 33.0) | DONE |
| Governance gate for node changes | Yes Manager creates proposals via HTTP | Yes E2E verified (Phase 33.1) | DONE |
| Pipeline trigger endpoint | Yes POST /pipeline/run | Yes Endpoint exists (Phase 33.2) | DONE |
| Auto-vote on own proposals | Yes governance.ts auto-vote | Yes Works (Phase 33.1) | DONE |
| Early resolution (all nodes voted) | Yes governance.ts early resolution check | Yes Works (Phase 33.1) | DONE |
| E2E pipeline (governance to restart) | Partial PipelineRunner + watchdog exist | No Not wired end-to-end | BUILD |
| Project discovery (find existing) | No No semantic search | No | BUILD |
| Multi-user project threads | Partial ProjectEntry registry exists (27-E) | Partial No shared thread views | BUILD |
| Conflicting instructions to governance | No No conflict detection | No | BUILD |
| Project-level governance (two-tier) | No Only network-level exists | No | PLANNED |
| Cross-node code distribution | Partial UpgradeProtocol uses git pull | No Not wired to Phase 33 | PLANNED |
| Cross-node project membership | No No project-scoped GossipSub | No | PLANNED |
| Dependency management | Partial Task blockedBy exists | No Manager does not track actively | WIRE |

**Summary: 33 DONE, 1 WIRE, 4 BUILD, 3 PLANNED (was: 28 DONE after Phase 32.5)**

**Phase 33.0-33.2 resolved 5 items** (request classification, governance gate, pipeline trigger, auto-vote, early resolution).
**Phase 32.5 resolved 3 items** (agent-driven deployment, event prompt injection, session reset).
**Phase 28 resolved 13 items** (7 WIRE to DONE, 5 BUILD to DONE, 1 SIMPLIFY replaced with simple tier routing).

**Remaining priority order:**
1. **BUILD** (4 items) — E2E pipeline, project discovery, multi-user thread views, conflict to governance
2. **WIRE** (1 item) — dependency management in Manager's task tracking
3. **PLANNED** (3 items) — project-level governance, cross-node code distribution, cross-node project membership

---

*This document is the architecture contract. All code must match these flows.*
*Test against these scenarios before shipping any feature.*
*If a scenario is missing, add it here FIRST, then build the code.*
*Every actor updates genome for what it touches. No actor leaves knowledge only in memory.*
*The pattern survives scale — upgrade building blocks, not architecture.*
