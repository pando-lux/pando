# Project Ownership & Authority Model

> Status: DESIGN — documenting for future implementation
> Date: 2026-02-17

## The Problem

Users build projects on Pando. Projects are real things — websites, APIs, tools. Key questions:

1. Who owns a project? Who can modify it?
2. Can someone else modify MY project without my permission?
3. If I'm in a project conversation, does my input go straight to the manager, or through governance?
4. What's the difference between a public-domain project and a paid/private project?
5. How do multiple users collaborate on the same project?

## Project Types

### 1. Personal Projects (Private)

- **Created by**: A single user
- **Owned by**: The creator
- **Who can modify**: ONLY the owner (direct authority)
- **Visibility**: Only the owner can see it
- **Cost**: Owner pays Lux for all tasks
- **Examples**: "Build me a portfolio website", "Create my resume API"

The owner has **full authority** over personal projects. When they send a message in the project conversation, it goes directly to the manager handling that project — no governance vote needed. This is YOUR project, you paid for it, you control it.

### 2. Public Service Projects (Community)

- **Created by**: Anyone (via governance proposal)
- **Owned by**: The network (no single owner)
- **Who can modify**: Anyone, via governance proposal
- **Visibility**: Public — anyone can see and use it
- **Cost**: Paid from network treasury or community pool
- **Examples**: "Build a public search engine", "Create a community wiki"

Changes to public service projects require governance approval. No single user can unilaterally modify them. This protects the community's shared resources.

### 3. Collaborative Projects (Shared)

- **Created by**: A user who invites collaborators
- **Owned by**: The creator (primary) + collaborators (with roles)
- **Who can modify**: Owner + authorized collaborators
- **Visibility**: Visible to team members
- **Cost**: Split among team or covered by owner
- **Examples**: "Build a startup website with my co-founder"

Collaborators have role-based authority:
- **Owner**: Full control (modify anything, add/remove collaborators)
- **Editor**: Can modify the project (sends messages that become tasks)
- **Viewer**: Can see the project but not modify it
- **Commenter**: Can suggest changes (goes to owner for approval)

## Authority Flow

### Personal Project (Owner sends a message):
```
Owner types: "Add a contact form to the homepage"
  │
  └─→ Project Manager receives directly (no governance needed)
      └─→ Task created: "Add contact form"
          └─→ Agent executes in project workspace
              └─→ Owner sees result, can iterate
```

**Fast path.** No voting. No waiting. You paid, you decide.

### Public Project (Any user sends a request):
```
User types: "The search results page needs dark mode"
  │
  └─→ Governance proposal created: "Add dark mode to search"
      └─→ Network votes
          └─→ If approved: Task created, agent executes
          └─→ If rejected: User notified, no changes made
```

**Democratic path.** Public projects belong to everyone.

### Collaborative Project (Collaborator sends a message):
```
Editor types: "Update the hero section copy"
  │
  └─→ Project Manager receives (editor has authority)
      └─→ Task created, agent executes
      └─→ Owner notified of change

Viewer types: "The button color should be blue"
  │
  └─→ Suggestion created → sent to Owner for approval
      └─→ Owner approves → Task created
      └─→ Owner rejects → Viewer notified
```

**Role-based path.** Authority depends on your role in the project.

## Key Design Decisions

### 1. "Can someone else modify MY project?"

**No.** Personal projects are PRIVATE. No one — not even the network — can modify your project without your permission. Your project, your workspace, your files.

Exceptions:
- If your project violates the Two Laws (harms humans), the network can quarantine it
- If your project uses network resources (hosting, API), and you stop paying, it goes offline

### 2. "What about someone wanting to update someone else's public website?"

Depends on project type:

| Scenario | What happens |
|---|---|
| **Your personal project** | NO — they cannot touch it. Period. |
| **Public service project** | They submit a governance proposal. Network votes. |
| **Collaborative project** | Depends on their role. Owner/Editor can modify. Viewer can suggest. |
| **Open-source project** | Fork it, build your own version. No need to modify the original. |

### 3. "Does my input go directly to the manager?"

If you're the **owner** of the project: YES. Direct authority. No governance overhead.

If you're a **collaborator**: Depends on your role (Editor = direct, Viewer = suggestion).

If you're a **random user** on a public project: Goes through governance.

### 4. "What if I'm working on 3-4 projects in parallel?"

Each project has its own conversation thread and workspace. When you open a project and send a message, it goes to THAT project's manager. You can switch between projects freely.

```
Projects tab:
  ● Portfolio Website     (3 active tasks)  [Open]
  ● URL Shortener API     (idle)            [Open]
  ● Team Dashboard        (1 task running)  [Open]
  ○ Old Blog (archived)                     [View]
```

Each project is isolated — different workspace, different conversation, different task history.

## Project Lifecycle

```
Created → Active → Paused → Archived
                     │
                     └─→ Resumed → Active
```

| State | What it means |
|---|---|
| **Created** | Project initialized, workspace set up |
| **Active** | User is iterating, workspace alive, conversation ongoing |
| **Paused** | No activity for a while, workspace goes dormant (can be resumed with --continue) |
| **Archived** | User marks it done, workspace snapshot saved, can be re-opened |

## Payment Model

| Action | Cost | Who pays |
|---|---|---|
| Create a project | Free | — |
| Send a message / iterate | Lux per task | Project owner |
| AI response / search | Lux per query | Requester |
| Host a project (future) | Lux per month | Project owner |
| Fork a public project | Free | — |

Projects consume Lux because they use network compute (AI agents, Claude sessions, build pipeline). Node operators earn that Lux by providing the compute.

## Data Ownership

- **Project files**: Stored in the owner's workspace on their node
- **Conversation history**: Stored locally on the owner's node
- **Task history**: Visible on the network (transparency) but files are private
- **Backups**: Owner's responsibility (future: encrypted P2P backup)

The network can see THAT you built a project and HOW MANY tasks it took, but cannot see the actual files unless you make it public.

## Future: Project Templates & Marketplace

Eventually:
- Users can publish project templates ("Portfolio Website starter")
- Other users can fork/clone templates
- Template creators earn Lux when their template is used
- This creates a marketplace of reusable projects

## Implementation Notes

### Data model:
```typescript
interface Project {
  id: string;
  title: string;
  type: 'personal' | 'public' | 'collaborative';
  ownerId: string;           // PeerId of the creator
  collaborators: Collaborator[];
  workspaceId: string;       // Reference to workspace
  threadId: string;          // Conversation thread
  parentTaskId: string;      // Root task in scheduler
  status: 'created' | 'active' | 'paused' | 'archived';
  createdAt: number;
  updatedAt: number;
  totalLuxSpent: number;
  taskCount: number;
}

interface Collaborator {
  peerId: string;
  role: 'owner' | 'editor' | 'viewer' | 'commenter';
  addedAt: number;
  addedBy: string;
}
```

### Authority check (pseudocode):
```
function canModifyProject(userId, project, action):
  if action violates Two Laws → BLOCK (always)

  if project.type === 'personal':
    return userId === project.ownerId

  if project.type === 'public':
    return governanceApproved(action)

  if project.type === 'collaborative':
    collab = project.collaborators.find(c => c.peerId === userId)
    if !collab → return false
    if collab.role === 'owner' || collab.role === 'editor' → return true
    if collab.role === 'commenter' → return createSuggestion(action)
    return false
```

### Storage:
- Projects table in SQLite: `~/.pando/projects.db`
- Or extend ledger.db with a `projects` table
- Conversation threads: `~/.pando/chats/<threadId>.json`
- Workspace link: existing workspace manager

### API endpoints needed:
```
POST   /projects                    — Create project
GET    /projects                    — List my projects
GET    /projects/:id                — Project detail
POST   /projects/:id/message        — Send message in project (creates task)
POST   /projects/:id/collaborators  — Add collaborator
DELETE /projects/:id/collaborators/:peerId — Remove collaborator
GET    /projects/:id/files          — List workspace files
GET    /projects/:id/download       — ZIP download
POST   /projects/:id/archive        — Archive project
POST   /projects/:id/resume         — Resume paused project
```
