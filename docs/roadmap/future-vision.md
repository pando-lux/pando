# Pando Future Vision — Interactive AI Nodes

**Status: DOCUMENTED (Not being built yet)**

This document captures the long-term architectural vision for Pando nodes. Build priority: after the current P2P network, ledger, and gateway are stable.

---

## The Big Idea

Every Pando node becomes an AI agent. Not just a P2P relay — an intelligent participant that can reason, execute tasks, and orchestrate other AI agents. The user interface is an interactive terminal (like Claude Code) where you talk to your node, and your node talks to the network.

```
┌─────────────────────────────────────────────────┐
│  Pando Terminal (interactive TUI, like CC)       │
│  ┌─────────────────────────────────────────────┐│
│  │ > What's happening on the network?          ││
│  │                                             ││
│  │ 47 nodes connected. 3 new in the last hour. ││
│  │ Network supply: 142,000 Lux.                ││
│  │ Your balance: 847 Lux.                      ││
│  │ 2 pending tasks from the network.           ││
│  │                                             ││
│  │ > Accept those tasks                        ││
│  │                                             ││
│  │ Accepted. Working on code review for        ││
│  │ service #4821... Delegating to Claude...    ││
│  └─────────────────────────────────────────────┘│
│  [peers: 47] [balance: 847 Lux] [tasks: 2]     │
└─────────────────────────────────────────────────┘
```

---

## Phase A: Interactive Node Terminal (TUI)

Replace the current "start node via CLI flags" workflow with something interactive.

**What it does:**
- Open `pando` and you're in an interactive terminal
- See live node status (peers, balance, transactions)
- Manage API keys, configure settings
- Chat with the network — ask questions, request services
- View incoming tasks, accept/reject work

**How to build:**
- Use `ink` (React for CLI) or `blessed`/`blessed-contrib` for the TUI
- The terminal wraps the existing PandoNode class
- All current functionality (P2P, ledger, HTTP API) stays the same underneath
- The TUI is just a better interface on top

**This is the primary user interface for power users.** The gateway (web UI) serves casual users. The TUI is for operators and developers.

---

## Phase B: AI-Powered Nodes

Nodes gain reasoning capability — not just proxying API calls, but actually thinking about tasks.

**What changes:**
- Node uses the existing `~/.pando/api-keys.json` system (already built)
- Instead of only proxying search queries, the node can reason about incoming requests
- Node can autonomously decide: "This task needs code review, I should call Claude for this"
- Node can compose multi-step workflows: receive task → analyze → delegate → verify → respond

**Key insight:** The `search()` method in `PandoNode` already does this at a basic level — it receives a query, calls an AI API, returns a result. Phase B extends this from "search" to "general reasoning about any task."

---

## Phase C: Bidirectional AI Integration

**Current (already built):**
```
Claude Code ──[MCP client]──> Pando MCP Server ──[HTTP]──> Pando Node
```
Claude Code can query the network, transfer Lux, check status.

**New direction:**
```
Pando Node ──[Anthropic API]──> Claude ──[tool calls]──> Pando Node
```
The node defines its capabilities as tools, passes them in API calls. Claude reasons about the task and calls back into the node to execute actions.

**Why Anthropic API, not spawning Claude Code processes?**
- Spawning full CLI processes is heavy and brittle
- The Anthropic API with tool definitions gives the same capability
- The node defines tools like: `search_network`, `transfer_lux`, `review_code`, `deploy_service`
- Claude sees these tools, reasons about the task, and calls whichever tools are needed
- Much lighter, more reliable, easier to manage

**Example flow:**
1. Network task arrives: "Review this service code for security issues"
2. Node receives task, defines tools: `read_code`, `run_tests`, `submit_review`
3. Node calls Anthropic API with the task + tool definitions
4. Claude analyzes the code, calls `run_tests`, reads results, calls `submit_review`
5. Node earns Lux for completing the review

**Safety — preventing infinite loops:**
- Each task has a depth counter (Pando → Claude → Pando = depth 2)
- Maximum depth limit (e.g., 5) prevents runaway recursion
- Each task has a Lux budget — stops when budget exhausted
- Timeout on all API calls

---

## Phase D: Network Orchestration

Nodes know about each other (already true via libp2p). The new part: nodes advertise capabilities and the network routes tasks to the right node.

**New P2P message types:**
- `CAPABILITY_ANNOUNCE` — "I have Claude API access, 16GB RAM, can review code"
- `TASK_REQUEST` — "I need this code reviewed, paying 5 Lux"
- `TASK_RESULT` — "Here's the review, signed by my node"
- `TASK_ACCEPT` — "I'll take this task"

**How routing works:**
1. Node A posts a task with requirements and reward
2. All nodes see it via GossipSub
3. Nodes that can handle it respond with `TASK_ACCEPT`
4. Node A picks the best candidate (reputation, price, capability)
5. Worker completes task, submits signed result
6. Node A verifies and pays Lux

**The network becomes a distributed AI compute fabric.** Need code reviewed? Post a task. Need an image generated? Post a task. Need a service built? Post a task. Capable nodes compete to fulfill it.

---

## Architecture Stack (When Fully Built)

```
┌── User Layer ──────────────────────────────────────┐
│  Pando Terminal (TUI)     Gateway (Web UI)          │
│  Interactive CLI           Browser dashboard         │
└──────────────┬──────────────────┬──────────────────┘
               │                  │
┌── Node Layer ┴──────────────────┴──────────────────┐
│  PandoNode                                          │
│  ├── P2P Network (libp2p, TCP, Noise, GossipSub)   │
│  ├── Ledger (SQLite, accounts, transactions)        │
│  ├── HTTP API (Fastify, for local tools)            │
│  ├── AI Engine (Anthropic/OpenAI API with tools)    │
│  ├── Task Manager (accept, execute, submit work)    │
│  └── MCP Server (for Claude Code integration)       │
└──────────────┬─────────────────────────────────────┘
               │
┌── Network Layer ───────────────────────────────────┐
│  Other Pando nodes (same stack, different identity) │
│  Task routing via GossipSub                         │
│  Capability discovery via DHT                       │
│  Transaction sync via GossipSub                     │
└────────────────────────────────────────────────────┘
```

---

## Phase 0 (Pre-Requisite): Agent Transparency Layer

**This comes BEFORE the interactive phases above.** See [agent-transparency.md](../architecture/agent-transparency.md) for the full design.

Without visibility, none of the above works. Users can't see what agents are doing. Agents can't see what other agents are doing. The AI can't act as CEO if it's blind.

**What Phase 0 delivers:**
- `pando/activity` GossipSub topic — every agent action broadcast to the network
- `/activity` and `/agents` TUI commands — any operator sees network-wide agent status
- HTTP API endpoints — programmatic access to agent activity
- Gateway `/network` page — public dashboard showing live agent activity
- Agent self-awareness — agents consume the activity stream to coordinate
- CEO operating cycle — lead agent autonomously publishes strategy, reports, retrospectives

**This is pre-launch critical.** It enables:
- The founder to verify agents work correctly during beta
- Agents to coordinate without human coordination
- Users to trust the system (transparency = trust)
- The AI to operate autonomously as a strategic leader

---

## Why Not Build Phases A-D Now

1. **Foundation first.** The P2P network, ledger, and gateway must be rock solid before adding AI orchestration on top.
2. **Need more nodes.** Task routing only makes sense with 10+ nodes. Currently 2.
3. **The current system works.** Users can already interact via MCP (Claude Code) and gateway (browser). The TUI adds a better interface but isn't blocking anything.
4. **Cost.** AI API calls cost money. The Lux economy needs to be functional enough to cover costs before nodes start autonomously spending API credits.

**Estimated priority:**
- **Phase 0 (Transparency): NOW — build alongside current P2P and ledger work**
- Phase A (TUI): After gateway is stable and tested
- Phase B (AI nodes): After 10+ nodes and the economy has enough Lux flowing
- Phase C (Bidirectional AI): After Phase B proves nodes can reason about tasks
- Phase D (Network orchestration): After 100+ nodes with diverse capabilities

---

## Open Questions

- What's the right TUI framework? `ink` (React) vs `blessed` vs custom
- How to price tasks in Lux? Market-based (nodes bid) or fixed rates?
- How to handle AI model diversity? Require multiple providers for consensus?
- How to prevent task spam? Minimum stake to post a task?
- Should the TUI and the AI agent be the same thing? (Probably yes — the terminal IS the AI)
