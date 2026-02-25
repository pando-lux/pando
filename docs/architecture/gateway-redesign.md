# Gateway Redesign — Full User Experience

> Status: DESIGN — CEO + Jai alignment required before implementation
> Date: 2026-02-17
> Updated: Added user workspace layer (conversations, projects, history)

## The Big Realization

The gateway isn't just a **dashboard to observe** — it's a **workspace to build in**. Users don't come to Pando to look at scheduler queues. They come to:

1. **Talk to AI** — ask questions, have ongoing conversations
2. **Build things** — websites, apps, tools — with back-and-forth iteration
3. **Track their projects** — see what they've built, resume work, check deployments
4. **See the network** — transparency, economy, what's happening

The monitoring/admin stuff is secondary. The USER EXPERIENCE is primary.

## Mental Model

Think of it like combining the best of:
- **ChatGPT** — conversation threads, history, back-and-forth
- **GitHub** — project tracking, repositories, build history
- **Vercel** — deployments, live previews, status
- **A bank app** — wallet, transactions, balance

All powered by a decentralized AI network instead of a single company.

## Design Philosophy

**Tree structure.** Easy at the top, deeper as you go.

```
Layer 0: "Welcome" — I understand what this is (5 seconds)
Layer 1: "Use it"  — Talk to AI, start a project, see my stuff (Tier 1)
Layer 2: "Explore" — Network, governance, economy, health (Tier 2)
Layer 3: "Operate" — Task queues, agent profiles, strategy, pipeline (Tier 3)
```

## User Tiers

| Tier | Who they are | What they want | % of users |
|---|---|---|---|
| **Tier 1** | Non-technical. Came to try AI, build something cool. | Chat with AI. Build a project. See my history. Track my work. | 90% |
| **Tier 2** | Semi-technical. Understands nodes, voting, economy. | Explore the network. Vote on proposals. Monitor node health. Understand the economy. | 9% |
| **Tier 3** | Technical. Node operators, developers. | Raw task queues, agent profiles, strategy config, pipeline status, debug logs. | 1% |

---

## Navigation Structure

### Current (flat, overwhelming, admin-focused):
```
Home | Scheduler | Monitor | Strategy | Wallet | Network | Governance
```

### Proposed (user-first, progressive depth):

```
Home | Chat | Projects | Wallet | Explore
                                    │
                                    ├─ Activity (what's happening now)
                                    ├─ Network (peers, topology)
                                    ├─ Governance (proposals, voting)
                                    ├─ Economy (Lux supply, earning)
                                    ├─ Health (node status, managers)
                                    └─ [Node Operators]
                                         ├─ Tasks (raw queue)
                                         ├─ Strategy (brain analysis)
                                         ├─ Agents (profiles, sessions)
                                         └─ Pipeline (auto-commit status)
```

**5 top-level items** (down from 7, and user-centric):
1. **Home** — Landing, network pulse, "what is this?"
2. **Chat** — AI conversations, threads, Q&A
3. **Projects** — Things the user is building
4. **Wallet** — Personal Lux, identity, transactions
5. **Explore** — Network transparency, governance, economy, health, operator tools

---

## Page-by-Page Design

### 1. HOME (`/`)

**Purpose:** First impression. "What is this, and what can I do?"

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                         Pando                               │
│              The internet, by everyone.                      │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Ask anything, build anything...                     │    │
│  │  ___________________________________________________│    │
│  │                                            [Send]    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ── Quick Actions ─────────────────────────────────────     │
│                                                             │
│  [New Chat]          [Start a Project]      [My Wallet]     │
│  Talk to AI          Build something        See your Lux    │
│                                                             │
│  ── Network Pulse ─────────────────────────────────────     │
│                                                             │
│  ● Network alive     3 nodes       5,669 Lux supply        │
│    12 agents working  334 tasks done  99.7% uptime          │
│                                                             │
│  ── Live Feed ─────────────────────────────────────────     │
│                                                             │
│  ● Agent completed "Optimize Health Monitoring"    2m ago   │
│  ● +25 Lux earned for task completion              2m ago   │
│  ● New proposal: "Diversify Pattern Usage"         27m ago  │
│                                                             │
│  [See all activity →]     [Explore the network →]           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

The input box on home is a **quick start** — submitting here either:
- Creates a new chat thread (if it's a question)
- Starts a new project (if it's a "build me X" request)
- Routes to the right place via Smart Router (existing logic)

### 2. CHAT (`/chat`)

**Purpose:** Ongoing conversations with AI. Like ChatGPT but decentralized.

```
┌─────────────────────────────────────────────────────────────┐
│  ┌─ Threads ──────┐  ┌─ Conversation ────────────────────┐  │
│  │                 │  │                                    │  │
│  │  + New Chat     │  │  You: What is quantum computing?   │  │
│  │                 │  │                                    │  │
│  │  Today          │  │  Pando: Quantum computing uses     │  │
│  │  ● Quantum      │  │  quantum mechanical phenomena...   │  │
│  │    computing    │  │                                    │  │
│  │  ● Best pizza   │  │  You: How does it relate to        │  │
│  │    in Dubai     │  │  cryptography?                     │  │
│  │                 │  │                                    │  │
│  │  Yesterday      │  │  Pando: Great question. Quantum    │  │
│  │  ○ React vs Vue │  │  computers threaten current...     │  │
│  │  ○ Pando help   │  │                                    │  │
│  │                 │  │                                    │  │
│  │  This Week      │  │  ┌─────────────────────────────┐   │  │
│  │  ○ AI ethics    │  │  │ Type a message...     [Send] │   │  │
│  │  ○ Node setup   │  │  └─────────────────────────────┘   │  │
│  │                 │  │                                    │  │
│  └─────────────────┘  └────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**How it works under the hood:**
- Each thread = a search query or conversation routed through the node's AI search
- Threads are stored locally (in the browser or in `~/.pando/chats/`)
- Multi-turn: user can continue a conversation, context is maintained
- Cost: each message costs a small amount of Lux (paid to the network for AI compute)
- Transparency: user can see "Answered by node X, model Y, cost: 0.05 Lux"

**Thread sidebar:**
- Grouped by time (Today, Yesterday, This Week, Older)
- Search across all threads
- Pin/star important conversations
- Delete threads

**What's needed to build this:**
- Chat thread storage (local SQLite or browser localStorage, later sync to node)
- Multi-turn conversation context management
- Cost display per message
- Thread CRUD API endpoints on the node

### 3. PROJECTS (`/projects`)

**Purpose:** Track things the user is building with Pando. This is the BIG differentiator.

```
┌─────────────────────────────────────────────────────────────┐
│  My Projects                              [+ New Project]   │
│                                                             │
│  ┌──────────────────────────────────────────────────┐       │
│  │  My Portfolio Website                    ● Active │       │
│  │  Started 2 days ago · 12 tasks completed          │       │
│  │  Last: "Added contact form" · 3h ago              │       │
│  │  Cost: 4.5 Lux                                    │       │
│  │  [Open] [View History]                            │       │
│  └──────────────────────────────────────────────────┘       │
│                                                             │
│  ┌──────────────────────────────────────────────────┐       │
│  │  URL Shortener API                       ● Active │       │
│  │  Started 5 days ago · 8 tasks completed           │       │
│  │  Last: "Added rate limiting" · 1d ago             │       │
│  │  Cost: 3.2 Lux                                    │       │
│  │  [Open] [View History]                            │       │
│  └──────────────────────────────────────────────────┘       │
│                                                             │
│  ┌──────────────────────────────────────────────────┐       │
│  │  React Dashboard                       ○ Complete │       │
│  │  Completed 1 week ago · 15 tasks                  │       │
│  │  Total cost: 7.8 Lux                             │       │
│  │  [View] [View History] [Download]                 │       │
│  └──────────────────────────────────────────────────┘       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Clicking "Open" on a project goes to the project workspace:**

```
┌─────────────────────────────────────────────────────────────┐
│  ← My Portfolio Website                          ● Active   │
│                                                             │
│  ┌─ Chat ──────────────────────────────────────────────┐    │
│  │                                                      │    │
│  │  You: Build me a portfolio website with React        │    │
│  │                                                      │    │
│  │  Pando: I'll create a portfolio website for you.     │    │
│  │  Here's my plan:                                     │    │
│  │  1. React + Tailwind setup                           │    │
│  │  2. Home page with hero section                      │    │
│  │  3. Projects gallery                                 │    │
│  │  4. Contact form                                     │    │
│  │  [Working on it...]                                  │    │
│  │                                                      │    │
│  │  ✓ Task completed: "React project scaffold"          │    │
│  │    Duration: 45s | Cost: 0.3 Lux                     │    │
│  │                                                      │    │
│  │  You: Add a dark mode toggle                         │    │
│  │                                                      │    │
│  │  Pando: Adding dark mode toggle to the navbar...     │    │
│  │  [Working on it...]                                  │    │
│  │                                                      │    │
│  │  ┌─────────────────────────────────────────────┐     │    │
│  │  │ What's next?                         [Send] │     │    │
│  │  └─────────────────────────────────────────────┘     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                             │
│  ── Project Details ────────────────── [expand ▼]           │
│  Tasks: 12 done, 1 in progress | Cost: 4.5 Lux             │
│  Files: 23 files | Workspace: /workspaces/abc123            │
│  [View Files] [Download ZIP] [View Task History]            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**How it works under the hood:**
- "Start a project" = creates a task in the scheduler with a conversation thread attached
- Each follow-up message = a new task (child of the project's parent task)
- The workspace persists across tasks (workspace reuse / --continue)
- Project = a parent task with children, plus a conversation thread, plus a workspace
- Files are in the workspace directory, downloadable as ZIP
- Task history shows every step the network took to build it

**Project lifecycle:**
- **Active** — user is iterating, workspace is alive
- **Paused** — user hasn't interacted in a while, workspace goes dormant
- **Complete** — user marks it done, workspace archived
- **Template** — user can share a project as a template for others

**What's needed to build this:**
- Project entity (wraps a parent task + conversation thread + workspace reference)
- Project CRUD API on the node
- Conversation-to-task routing (Smart Router already does classification)
- File browser for workspace contents
- ZIP download endpoint
- Project list/dashboard in gateway

### 4. WALLET (`/wallet`)

**Purpose:** Your money, your identity, your activity.

```
┌─────────────────────────────────────────────────────────────┐
│  My Wallet                                                  │
│                                                             │
│  ┌────────────────────────────────┐                         │
│  │  Balance                       │                         │
│  │  5,313.99 Lux                  │                         │
│  │                                │                         │
│  │  [Send Lux]  [Receive]         │                         │
│  └────────────────────────────────┘                         │
│                                                             │
│  ── Your Stats ────────────────────────────────────────     │
│  Projects built: 3     │  Tasks contributed: 47             │
│  Total spent: 15.5 Lux │  Reputation score: 288             │
│  Member since: Feb 2026 │  Uptime: 14 days                  │
│                                                             │
│  ── Recent Transactions ───────────────────────────────     │
│  +25.00  Task reward: "Optimize Monitoring"     2m ago      │
│  -0.30   Project: "Portfolio Website" task #12  3h ago      │
│  +0.05   Uptime reward (10 min epoch)           10m ago     │
│  -10.00  Sent to 12D3KooW...NSUW                1d ago     │
│                                                             │
│  ── Identity ──────────────────────── [expand ▼]            │
│  Peer ID: 12D3KooWACe6...                                   │
│  Public Key: [show]                                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Mostly the same as current, but with:
- **Your Stats** section — makes the user feel connected to the network
- Transactions labeled with context (which project, which task)
- Identity section collapsed by default (technical detail)

### 5. EXPLORE (`/explore`)

**Purpose:** Discover the network. Hub page with progressive depth.

```
┌─────────────────────────────────────────────────────────────┐
│  Explore the Network                                        │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  ◉ Activity   │  │   Network    │  │  Governance   │      │
│  │               │  │              │  │              │      │
│  │  See what     │  │  3 nodes     │  │  5 active    │      │
│  │  the network  │  │  connected   │  │  proposals   │      │
│  │  is doing     │  │              │  │              │      │
│  │  right now    │  │              │  │              │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Economy    │  │    Health    │  │   How It     │      │
│  │              │  │              │  │   Works      │      │
│  │  5,669 Lux   │  │  All systems │  │              │      │
│  │  total       │  │  green       │  │  Learn about │      │
│  │  supply      │  │              │  │  Pando       │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
│  ── For Node Operators ──────────────────── [expand ▼]      │
│                                                             │
│  Tasks    Strategy    Agent Profiles    Pipeline             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Sub-pages under Explore (same as previous design):
- `/explore/activity` — Live dashboard of network work
- `/explore/network` — Peer graph, connections, topology
- `/explore/governance` — Proposals, voting, decisions
- `/explore/economy` — Lux supply, earning, top contributors
- `/explore/health` — Node health, managers, alerts
- `/explore/how-it-works` — FAQ, docs, "what is governance?", "what is strategy?"

Operator tools (Tier 3, collapsed by default):
- `/explore/tasks` — Raw task queue with summary header
- `/explore/strategy` — Read-only brain analysis
- `/explore/agents` — Agent profiles, sessions, --continue stats
- `/explore/pipeline` — Auto-commit pipeline status, commit log

---

## The Full User Journey

### New user (Tier 1):
1. Lands on **Home** → sees "The internet, by everyone" + input box
2. Types "What is quantum computing?" → gets an answer (routed to Chat)
3. Types "Build me a portfolio website" → project created, work begins
4. Goes to **Projects** → sees their portfolio being built, can chat with the agent
5. Goes to **Wallet** → sees they have Lux, earned some from uptime
6. Never needs to see scheduler, strategy, or governance

### Curious user (Tier 2):
1. Uses Chat and Projects for a while
2. Clicks **Explore** → sees Activity, Network, Governance cards
3. Opens **Governance** → sees proposals, votes on one
4. Opens **Activity** → watches agents working in real time
5. Opens **Economy** → understands how Lux works
6. Feels informed and connected

### Node operator (Tier 3):
1. Uses everything above
2. Opens **Explore** → expands "For Node Operators"
3. Opens **Tasks** → sees raw queue, manages tasks
4. Opens **Strategy** → sees what the brain is analyzing
5. Opens **Pipeline** → checks auto-commit status
6. Full visibility into system internals

---

## What Needs to Be Built

### Already exists (just needs reorganization):
- [x] AI search/input (Smart Router, unified input)
- [x] Task queue UI (scheduler page)
- [x] Governance UI (proposals, voting, comments)
- [x] Wallet UI (balance, transfer, transactions)
- [x] Network UI (peers, reputation)
- [x] Monitor UI (health, alerts, managers)
- [x] Strategy UI (run history, suggestions)
- [x] SSE real-time updates
- [x] Dark/light mode

### Needs to be built (new features):
- [ ] **Chat threads** — conversation persistence, multi-turn, thread sidebar
- [ ] **Projects** — project entity, project list, project workspace view
- [ ] **Project chat** — conversation within a project context
- [ ] **Activity page** — unified "what's happening now" dashboard
- [ ] **Explore hub** — card-based discovery page
- [ ] **Economy page** — network-wide Lux overview
- [ ] **How It Works** — inline docs/FAQ
- [ ] **File browser** — view workspace files for a project
- [ ] **Download ZIP** — export project files
- [ ] **Navigation restructure** — 5 top-level items, Explore sub-pages
- [ ] **Strategy page cleanup** — remove approve/reject buttons, make read-only

### New API endpoints needed on node:
- [ ] `POST /chat` — send a message in a conversation thread
- [ ] `GET /chat/threads` — list conversation threads
- [ ] `GET /chat/threads/:id` — get a thread with messages
- [ ] `DELETE /chat/threads/:id` — delete a thread
- [ ] `POST /projects` — create a project (wraps parent task + thread + workspace)
- [ ] `GET /projects` — list user's projects
- [ ] `GET /projects/:id` — project detail (tasks, files, conversation)
- [ ] `GET /projects/:id/files` — list workspace files
- [ ] `GET /projects/:id/download` — ZIP download of workspace
- [ ] `POST /projects/:id/message` — send a message within a project (creates child task)

### Data storage:
- Chat threads: SQLite table in ledger.db (threadId, messages[], createdAt, updatedAt)
- Projects: SQLite table in ledger.db (projectId, parentTaskId, threadId, workspaceDir, status, title, createdAt)
- Or: separate `~/.pando/chats.db` and `~/.pando/projects.db` to keep ledger clean

---

## Implementation Priority

| # | What | Impact | Effort |
|---|---|---|---|
| 1 | **Navigation restructure** | High — fixes overwhelming first impression | Medium |
| 2 | **Activity page** | High — answers "what is happening?" | Low-Medium |
| 3 | **Home page redesign** | High — first impression, network pulse | Medium |
| 4 | **Chat threads** | Critical — core user experience | High |
| 5 | **Projects** | Critical — the big differentiator | High |
| 6 | **Strategy cleanup** | Medium — remove manual buttons | Low |
| 7 | **Explore hub** | Medium — discovery UX | Low |
| 8 | **Economy page** | Medium — Lux transparency | Low-Medium |
| 9 | **File browser + download** | Medium — project utility | Medium |
| 10 | **How It Works / FAQ** | Medium — onboarding | Low |

Items 1-3 can be done now (reorganize existing code).
Items 4-5 are the big builds (new features, new API, new storage).
Items 6-10 are incremental improvements.
