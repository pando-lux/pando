---
id: user-journey-scale
type: flow
domain: architecture
depends_on: [pando-node, agent-manager, hosting-service, capability-registry, resource-router]
last_verified: 2026-02-23
---

# User Journey at Scale

## Overview

How Pando handles users from first contact through ongoing project collaboration, across multiple nodes. Designed for 10+ users per node, 100+ users across the network.

## Core Model: 1 Node = ~10 Projects = ~10 Managers

Each project is a living workspace with its own brain (manager), hands (builders/testers), and memory (GitHub + project-state.md). Projects are sticky to nodes (for performance) but portable (for resilience).

## Two-Layer AI: Doorman vs Manager

| Layer | Who | Cost | Speed | Persistence |
|---|---|---|---|---|
| **Doorman** | OpenAI (GPT-4o-mini) | ~$0.001/msg | < 2 seconds | Stateless |
| **Project Manager** | Claude Code session | ~$0.50/session | 30-300 seconds | Stateful (project-state.md + session resume) |

### Doorman handles:
- Greetings, small talk, questions about Pando
- "What can you build?" → answers from static knowledge base
- "Build me X" → creates project, runs preflight, spawns project manager, hands off
- "How's my project going?" → checks agent tree, returns status without waking manager
- User authentication / project lookup / routing to correct node

### Doorman does NOT handle:
- Actual building (manager + workers)
- Architecture decisions (manager)
- Code review, testing, deployment (workers)

**The doorman is the receptionist, not the doctor.** Fast, cheap, always available. The manager is expensive but does the real work.

## New User Flow (Day 1)

```
User arrives
  → "Hey, I want to build a social app"
  │
  ▼
Doorman (OpenAI, instant)
  → Classifies: this is a build request
  → Creates project: POST /projects { name, description, type }
  → Runs preflight: POST /projects/:id/preflight (auto-assigns MongoDB, generates API key)
  → Classifies tier:
      - Static app? → Tier 1 (S3 + Resource Proxy)
      - Needs backend/WebSockets? → Tier 2 (check GET /instances for available EC2)
      - Tier 2 requested but no instances? → Tell user, offer Tier 1 alternative
  → Spawns project manager: POST /agents/spawn { role: manager, projectId }
  → Returns to user: "I've set up your project. Your manager is working on it."
  │
  ▼
Project Manager (Claude Code)
  → Reads CLAUDE.md (template + project context)
  → Designs approach (3-7 steps)
  → Spawns workers: builder, tester, QA as needed
  → Monitors progress
  → Deploys when ready
  → Reports back to user with live URL
```

## Returning User Flow (Day 2+)

```
User sends message
  │
  ├─ Do we know this user? (session/cookie/account)
  │   ├─ YES → Look up their projects (MongoDB ProjectStore)
  │   │         ├─ Which project? (most recent, or user specifies)
  │   │         ├─ Which node owns it? (ProjectStore has nodeId)
  │   │         ├─ Is that node alive?
  │   │         │   ├─ YES → Route message to that node's project manager
  │   │         │   └─ NO → Reassign project to a healthy node
  │   │         │           ├─ New node clones from GitHub
  │   │         │           ├─ Spawns new project manager
  │   │         │           ├─ Manager reads project-state.md + thread history
  │   │         │           └─ Continues conversation
  │   │         └─ No active project → Doorman handles (small talk or new project)
  │   └─ NO → Doorman handles (new user flow)
```

**Priority order for routing:**
1. Same node, same manager, same session → best (instant context)
2. Same node, new manager session → good (reads project-state.md, has workspace)
3. Different node, new manager → acceptable (clones from GitHub, reads thread history)
4. Brand new → doorman creates everything fresh

## Multi-User Projects (5 Users Building Facebook)

```
Project: "Social App"
Owner: User A, collaborators: Users B, C, D, E

Node assignment: Node 1 (has capacity)

Team on Node 1:
  project-social-app (manager)
    ├── builder-frontend (React UI)
    ├── builder-backend (Express API)
    ├── builder-auth (OAuth flow)
    ├── tester-e2e (Playwright)
    ├── researcher-ux (competitor analysis)
    └── devops-deploy (EC2 setup)

User A: "Add friend requests" → routes to project-social-app manager
User B: "The login page is broken" → routes to SAME manager
User C: "Can we add dark mode?" → routes to SAME manager

Manager handles all users sequentially per bridge event.
Manager prioritizes: production bugs > blockers > feature requests.
```

This works because users on ONE project collaborate, not compete. Sequential is correct — you don't want parallel managers on the same project making conflicting decisions.

The bottleneck is 10 DIFFERENT projects, not 5 users on one project. Each project gets its own manager, so 10 projects = 10 independent managers (resource-limited by CPU/memory, not by architecture).

## Network Topology at Scale

```
┌──────────────────────────────────────────────────────┐
│                    GATEWAY (Vercel)                   │
│  - Static UI, user accounts, session management      │
│  - Routes returning users to their project's node    │
│  - New users → any available node                    │
└──────────────┬───────────────────────────────────────┘
               │
       ┌───────▼───────┐      ┌───────────────┐
       │   Node A       │◄────►│   Node B       │  P2P
       │   5 projects   │      │   5 projects   │
       │   5 managers   │      │   5 managers   │
       │   Doorman (AI) │      │   Doorman (AI) │
       └───────┬────────┘      └───────────────┘
               │
    ┌──────────┼──────────┐
    ▼          ▼          ▼
 Project 1  Project 2  Project 3 ...
 Manager    Manager    Manager
 Builder    Builder    QA
 Tester
```

## What Gets Saved Per Project (Resume Package)

When a node goes down and the project needs to resume elsewhere:

| What | Where Stored | Status |
|---|---|---|
| Source code | GitHub (`pando-lux/app-<id>-<name>`) | DONE |
| Project metadata | MongoDB (ProjectStore) | DONE |
| Project state (manager's brain) | `project-state.md` in GitHub repo | DONE |
| Conversation history | MongoDB (ThreadStore) | DONE |
| Deployment info | MongoDB (ProjectStore.deploymentUrl) | DONE |
| Resources assigned | MongoDB (ProjectStore.resources) | DONE |
| Team structure | **NOT saved yet — FUTURE** | Planned |
| Worker session state | **NOT saved yet — FUTURE** | Planned |
| Template versions per agent | **NOT saved yet — FUTURE** | Planned |

### Future: Team State Persistence

A `team-state.json` committed to the GitHub repo, updated by the manager after every significant event:

```json
{
  "manager": { "sessionId": "...", "lastActive": "..." },
  "workers": [
    { "role": "builder", "task": "Add friend requests", "status": "in_progress" },
    { "role": "tester", "task": "QA friend request flow", "status": "waiting" }
  ],
  "nextSteps": ["Deploy after QA passes", "Update marketplace listing"]
}
```

When a new node picks up the project, the new manager reads this and knows exactly where things stand. Not needed for launch — GitHub code + project-state.md + conversation history is enough to resume.

## Conversation Memory Model

| Scenario | How It Works |
|---|---|
| Message #1 (new project) | Doorman handles fast, creates project, manager gets full context |
| Message #50 (deep in build) | Manager has compressed context, reads project-state.md for decisions, recent thread for conversation |
| User returns next day | Manager starts fresh session, reads project-state.md + last N thread messages as "Previously on..." |
| Node goes down | New node clones GitHub, reads thread history from MongoDB, spawns new manager with full context |

**Key principle:** project-state.md is the external brain. Thread history is the conversation log. The Claude Code session is ephemeral. Any manager on any node can pick up any project cold.

## Tier Classification (Deterministic, Not AI)

Tier is decided by the doorman in code, not by the manager's AI brain:

| Signal | Tier | Reason |
|---|---|---|
| User says "Tier 2" or "EC2" | Tier 2 | Explicit request — always honor |
| Message mentions WebSocket, real-time, Express, backend, server | Tier 2 | Needs persistent server |
| Everything else | Tier 1 | S3 + Resource Proxy handles it |
| Tier 2 requested but no instances available | Tier 1 with explanation | Tell user, don't silently downgrade |

The manager gets told "this is Tier 2, use instance X" — it doesn't decide. This prevents stale-memory overrides.
