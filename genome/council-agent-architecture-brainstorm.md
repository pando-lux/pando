# Council & Agent Architecture Brainstorm

> **Status:** Active brainstorm — NOT final spec. Discussion between founder and Strategy CEO.
> **Date:** 2026-02-26
> **Participants:** Jai (founder), Claude (Strategy CEO)

---

## Core Principle

**No human ever writes code in Pando.** Not in apps, not in node infrastructure. All code is written by agents. Humans describe what they want. Agents build, test, deploy, and maintain it.

This is not a tool for developers. This is an autonomous development platform.

---

## The Two Pipelines

### 1. Node/Infrastructure Code → Council Pipeline

```
Human suggestion (TUI, Gateway, Claude Code, API)
  → Council receives as message
  → Council evaluates (constitution + network state + genome)
  → Council proposes (governance proposal)
  → DEV: instant auto-approve, no timer
  → BETA: vote + waiting period
  → LIVE: full governance vote
  → Builder agent writes code in sandbox
  → QA agent tests (Ring 1-3)
  → Council reviews results
  → Deploy (if approved)
```

**Key:** Users NEVER push node updates directly. Council is the ONLY path to node code changes. Even founder suggestions go through council — in DEV mode they just execute instantly.

### 2. App Code → App Manager Pipeline

```
Human describes app ("build me a math tutoring app")
  → App Manager (Tier 3) plans architecture
  → Builder agents write code
  → QA agents test
  → App Manager deploys
  → Runtime agents (Tier 1/2) serve users inside the app
```

Council doesn't touch app code. App agents don't touch node code. Clean separation.

---

## DEV Mode Dogfooding (CRITICAL UPDATE)

**Even in DEV mode, ALL work flows through council.** The difference is:
- DEV: No timer, no voting period. Council receives suggestion → evaluates → executes instantly.
- BETA: Short timer, lightweight vote.
- LIVE: Full governance vote by all nodes.

**Why:** If we bypass council in DEV, we never stress-test the actual pipeline. By the time we reach LIVE mode, council needs to have processed hundreds of real tasks. Start now.

**Claude Code sessions can insert council messages via API:**
```
POST /v1/council/message
{ "message": "The gateway needs a dark mode toggle", "from": "founder" }
```

This means:
- Jai's Claude Code sessions → `POST /v1/council/message` → council processes it
- Jai in TUI → `/council suggest ...` → same path
- Jai in Gateway → council chat → same path
- External user → Gateway council chat → same path (once public)

Everything takes the same path. The only variable is speed (DEV=instant, LIVE=governance).

---

## Agent Taxonomy

### Two Fundamental Kinds

**Builders (Tier 3)** — Write code. Temporary. Expensive.
- Claude Code sessions with filesystem, git, shell access
- Spawned by council (node work) or app manager (app work)
- Ephemeral workspaces, cleaned after task
- All current agent roles are specializations: manager, builder, tester, reviewer, researcher, devops, council
- Cost: 5-50 Lux per task

**Runners (Tier 1/2)** — Serve users inside apps. Permanent. Cheap.
- API calls with a system prompt + tools
- No filesystem, no git, no shell
- Defined in app config/manifest by the builder agent that created the app
- Two sub-tiers:
  - **Tier 1 (Stateless):** Single API call. No memory. Math solver, translator, content mod.
  - **Tier 2 (Session):** Conversation with memory. App-scoped storage. Tutor, assistant, support bot.
- Cost: 0.01-0.1 Lux per call (Tier 1), 0.5-5 Lux per session (Tier 2)

### Agent Lifecycle Comparison

| | Build-time Agents (Tier 3) | Runtime Agents (Tier 1/2) |
|---|---|---|
| **Purpose** | Write code, test, deploy | Serve users inside apps |
| **Lifespan** | Task duration (min-hours) | App lifetime (permanent) |
| **Cost** | High (5-50 Lux/task) | Low (0.01-5 Lux/call) |
| **Spawned by** | Council / App Manager | App definition |
| **Access** | Filesystem, git, shell | App-scoped API + storage only |
| **Backend** | Claude Code CLI | LLM API (OpenAI/Anthropic/Ollama) |
| **Workspace** | Ephemeral, cleaned after | None (stateless or app storage) |

---

## Agent Ownership & Access

### Four Levels

**1. Private** — My node, my compute, only I use it.
- Example: "my personal Claude Code assistant for my files"

**2. Shared (invited)** — I created it, I whitelist specific peerIds.
- Example: "my wife can use my math tutor agent"
- Free or Lux-priced (owner decides)

**3. Published (template)** — Agent template on Content Registry, anyone can instantiate on their own node.
- Example: "I made a great code reviewer template, network uses it"
- Uses THEIR resources, not mine

**4. Hosted (marketplace)** — Runs on my node, serves the network, priced in Lux.
- Example: "I run a GPT-4 agent, anyone can use it for 2 Lux/min"
- Revenue flows to operator via ResourceMarketplace

---

## Agent Definition Format (Draft)

For Tier 1/2 Runner agents inside apps:

```json
{
  "name": "math-tutor",
  "tier": 1,
  "description": "Patient math tutor for K-12",
  "system_prompt": "You are a patient math tutor...",
  "backend": "api",
  "model_preference": ["claude-sonnet-4-6", "gpt-4o", "ollama/llama3"],
  "tools": ["calculator", "latex_render", "app_storage"],
  "permissions": {
    "filesystem": false,
    "shell": false,
    "http_allowlist": ["api.mathjs.org"],
    "storage": "app_scoped"
  },
  "pricing": {
    "per_call": 0.01,
    "free_tier_calls": 10
  },
  "owner": "12D3KooW...",
  "access": "public"
}
```

For Tier 3 Builder agents: defined by template .md files + constitution. NOT user-configurable — part of the node system.

---

## Communication Flow (Full Picture)

```
┌─────────────────────────────────────────────────────────┐
│                    HUMAN INPUT                           │
│  "Build me X" / "Fix Y" / "Add Z to my app"            │
│  (Gateway, TUI, Claude Code via API, External)          │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
              ┌────────────────┐
              │  Intent Router │  What kind of work?
              │  (SmartRouter) │
              └───────┬────────┘
                      │
         ┌────────────┴────────────┐
         ▼                         ▼
  ┌──────────────┐         ┌──────────────┐
  │  APP WORK    │         │  NODE WORK   │
  │  (user apps) │         │  (infra)     │
  └──────┬───────┘         └──────┬───────┘
         │                        │
         ▼                        ▼
  ┌──────────────┐         ┌──────────────┐
  │  App Manager │         │   Council    │  ← ALL node changes
  │  (Tier 3)    │         │  (Tier 2/3)  │     go through here
  │  per-project │         │  top 3 nodes │
  └──────┬───────┘         └──────┬───────┘
         │                        │
         ▼                        ▼
  ┌──────────────┐         ┌──────────────┐
  │  Builder(s)  │         │  Governance  │
  │  QA          │         │  DEV=instant │
  │  (Tier 3)    │         │  LIVE=vote   │
  └──────┬───────┘         └──────┬───────┘
         │                        │
         ▼                        ▼
  ┌──────────────┐         ┌──────────────┐
  │  App Deploy  │         │  Builder(s)  │
  │  (S3/nginx)  │         │  QA (Ring3)  │
  └──────┬───────┘         └──────┬───────┘
         │                        │
         ▼                        ▼
  ┌──────────────┐         ┌──────────────┐
  │  RUNNING APP │         │  Node Deploy │
  │  ┌────────┐  │         │  (verified)  │
  │  │Runner  │  │         └──────────────┘
  │  │Agents  │  │
  │  │(T1/T2) │  │
  │  └────────┘  │
  └──────────────┘
```

---

## Council as Node Manager

**Why council instead of a dedicated "node manager" agent?**

Because a single manager is a single point of failure and a single perspective. Council is 3 nodes with highest reputation, rotating weekly. This gives:
- **Redundancy** — if one council member goes down, 2 remain
- **Diversity** — different nodes see different network conditions
- **Accountability** — rotation prevents entrenchment
- **Decentralization** — no single node controls development

The council IS the manager for node infrastructure. It just has checks and balances built in.

---

## Template Evolution (Most Important Long-Term)

If agents write everything, template quality = output quality. Therefore:

1. Council monitors build outcomes (success rate, QA failures, deploy failures)
2. Council identifies patterns ("builders keep forgetting to handle auth in gateway routes")
3. Council proposes template updates with evidence
4. Governance approves template changes
5. All future agents get improved templates

This is Phase 103 (Genome Evolution) — should be high priority after council is stable.

---

## What Needs Building (Priority Order)

1. **Council message API for Claude Code** — `POST /v1/council/message` accepts suggestions, council processes instantly in DEV mode. (Enables dogfooding now.)
2. **API-only agent backend** — Tier 1/2 runner agents. LLM API + tools, no filesystem. (Enables intelligent apps.)
3. **App agent manifest** — JSON format for declaring runner agents inside apps.
4. **Agent sandbox enforcement** — runner agents can ONLY call declared tools/APIs.
5. **Template evolution loop** — council proposes template updates from QA outcomes (Phase 103).

---

## Open Questions

- [ ] How does council prioritize when 5 suggestions come in simultaneously?
- [ ] Should app managers be able to request node-level resources (e.g., "my app needs a database")?
- [ ] What's the maximum number of runner agents per app?
- [ ] How do runner agents get API keys? Via ResourceRouter? Per-app credential scoping?
- [ ] Should published agent templates be versioned? (Template v1 vs v2)
- [ ] Per-minute vs per-call pricing — per-call is simpler, per-minute incentivizes slow agents (bad). Leaning per-call or per-task.

---

## Key Principles (From This Discussion)

1. **No human writes code.** Agents write everything. Humans describe intent.
2. **Everything flows through council** (for node) or **app manager** (for apps). No bypasses.
3. **DEV mode = instant council.** Same pipeline, no timer. Stress-test from day one.
4. **Builders are temporary, Runners are permanent.** Two fundamentally different agent lifecycles.
5. **Templates are the product.** Template quality determines output quality. Council evolves them.
6. **Agent access is layered.** Private → Shared → Published → Hosted. Natural progression.
7. **Council is the node manager.** 3 nodes, rotating, redundant. Not a single point of failure.
