---
id: project-store
type: service
domain: projects
entry: packages/node/src/platform/project-store.ts
depends_on: [ledger, storage-backend]
depended_by: [api-server, agent-manager, revenue-engine]
exposes:
  - init() — create tables and indexes
  - createProject(opts) — create project with auto-collaborator for owner
  - getProject(projectId) — single project lookup (sync, SQLite)
  - getProjectAsync(projectId) — single project lookup (async, MongoDB preferred)
  - getProjectByThreadId(threadId) — lookup project by linked thread (Phase 46)
  - getProjectsByOwner(userId) — all owned projects (excludes archived)
  - getProjectsByOwnerAsync(userId) — async variant
  - getProjectsByCollaborator(userId) — projects where user has non-owner role
  - getProjectsByCollaboratorAsync(userId) — async variant
  - listProjects(opts?) — filtered listing with type/visibility/status/limit/offset
  - listProjectsAsync(opts?) — async variant
  - updateProject(projectId, updates) — partial field updates
  - deleteProject(projectId) — soft delete (status='archived')
  - addCollaborator(projectId, userId, role, addedBy) — add/replace collaborator
  - removeCollaborator(projectId, userId) — remove collaborator
  - getCollaborators(projectId) — all collaborators for a project
  - getCollaboratorsAsync(projectId) — async variant
  - getUserRole(projectId, userId) — returns role or null
  - hasAccess(projectId, userId) — checks collaborator table + public type
  - transferOwnership(projectId, newOwnerId, oldOwnerRole?) — ownership transfer
  - getStats() — aggregate counts
  - getStatsAsync() — async variant
  - updateBudgetSpent(projectId, amount) — increment budget_spent
  - linkThread(projectId, threadId) — link chat thread
  - linkManagerAgent(projectId, agentId) — link manager agent
  - assignResource(projectId, { type, resourceId }) — assign ResourceRegistry resource to project (Phase 53)
  - removeResource(projectId, resourceId) — remove resource assignment (Phase 53)
  - getProjectResources(projectId) — list assigned resources (Phase 53)
  - generateApiKey(projectId) — generate 32-byte hex API key for Resource Proxy auth (Phase 53)
  - getProjectByApiKey(apiKey) — lookup project by API key (Phase 53)
  - getProjectByApiKeyAsync(apiKey) — async variant, MongoDB preferred (Phase 53)
  - loadFromBackend() — hydrate SQLite cache from MongoDB on startup (Phase 57)
rules: [data-residency]
last_verified: 2026-02-26 (INFRA-03 E2E: deployPeerId persistence fix verified — T2 deploy + undeploy working)
---

# Project Store (Phase 31.1 + Phase 44 Data Residency + Phase 57 Clean Data)

## What It Does

Persistence for projects, collaborators, invites, transfers, deployments, and ratings. Every piece of work on Pando lives inside a project — the atomic unit of ownership, collaboration, billing, and deployment.

## MongoDB-Primary Storage (Phase 57)

ProjectStore uses MongoDB as single source of truth. SQLite is a read-performance cache, hydrated from MongoDB on startup.

- **Writes**: MongoDB first (awaited), then SQLite cache update. If MongoDB fails, the operation fails — no silent data loss.
- **Reads**: Sync methods (`getProject`, `listProjects`, etc.) read from SQLite cache. Async variants (`getProjectAsync`, `listProjectsAsync`, etc.) read from MongoDB.
- **Startup**: `loadFromBackend()` hydrates all SQLite tables from MongoDB.
- **StorageBackend required**: ProjectStore cannot be instantiated without a StorageBackend.
- **`persistProjectToMongo()` helper (Phase 79)**: All project updates go through this helper, which reads the existing MongoDB record first, merges with the SQLite-derived record, and preserves MongoDB-only fields (`tier`, `deploymentPort`, `instanceId`, `githubRepo`) that have no SQLite column. This prevents `updateProject()` from overwriting MongoDB-only fields with undefined/default values. The only exception is `createProject()`, which writes a fresh record directly.

```
Constructor: new ProjectStore(db, storageBackend)
  - db: SQLite database (cache)
  - storageBackend: StorageBackend (required — MongoDB)
```

### MongoDB Collections (7)

| Collection | `_id` Strategy | Notes |
|---|---|---|
| `projects` | project ID | Full project metadata |
| `project_collaborators` | `{projectId}:{userId}` | Composite key for uniqueness |
| `project_invites` | invite ID | `code` has unique index |
| `project_transfers` | transfer ID | Ownership transfer proposals |
| `project_deployments` | deployment ID | S3/hosting deployment records |
| `project_ratings` | `{projectId}:{userId}` | One rating per user per project |
| `content_reports` | report ID | Content safety reports |

### Record-to-Object Helpers

Each collection has a `recordTo*()` helper that handles:
- **Boolean normalization**: SQLite stores 0/1, MongoDB stores true/false
- **JSON parsing**: `revenueConfig` is a JSON string in SQLite, native object in MongoDB
- **camelCase conversion**: MongoDB uses camelCase field names

## How It Works

- **Storage:** MongoDB-primary. SQLite as read cache, hydrated on startup. See `genome/rules/data-residency.md`.
- **Project types:** private (default, owner-only), shared (collaborators), public (network-owned).
- **Visibility:** owner_only, collaborators, listed (marketplace), featured.
- **Revenue models:** none, usage_fee, subscription, contribution_split.
- **Access control:** `hasAccess()` checks collaborator table + public project type. `getUserRole()` returns specific role.
- **Soft delete:** `deleteProject()` sets status='archived', not actual DELETE.
- **Auto-collaborator:** `createProject()` automatically adds owner as collaborator with 'owner' role.
- **Ownership transfer:** `transferOwnership()` updates owner_id, adds new owner as 'owner' collaborator, demotes old owner to specified role (default: 'collaborator').
- **5 indexes** for efficient queries on owner_id, status, type, visibility, and collaborator user_id.
- **Manifest fields (Phase 46):** `repoUrl` (GitHub/S3 path), `teamHistory` (JSON stringified agent history), `notes` (manager summary for cross-node pickup). These enable any node to pick up a project cold.
- **Resource fields (Phase 53):** `resources` (array of `{ type, resourceId, assignedAt, status }` — assigned ResourceRegistry resources), `apiKey` (32-byte hex for Resource Proxy auth). Resources are contributed via ResourceRegistry and assigned per-project.
- **Deployment fields (Phase 79+87):** MongoDB-persisted `tier` (1=S3 static, 2=EC2 compute), `deploymentPort` (backend port), `deployPeerId` (Phase 87: peerId of compute node hosting the app), `instanceId` (legacy, pre-Phase 87), `githubRepo` (org/repo name). These fields live only in MongoDB — SQLite caches the rest but `updateProject()` explicitly preserves MongoDB-only fields during writes.
  - **Critical**: `deployPeerId` must be in `mongoOnlyKeys`, `projectToRecord`, AND `recordToProject` — all three serialization paths in project-store.ts. If any is missing, `deployPeerId` silently returns `undefined` from `getProjectAsync()`, breaking undeploy (P2P request never sent, PM2+nginx left running). Fixed in commit `05ea747a` (found during INFRA-03).

## API Routes (in api-server.ts)

| Method | Path | Auth | Async? | Description |
|---|---|---|---|---|
| GET | /projects | Optional user token | Yes | User's projects or public listed |
| GET | /projects/stats | None | Yes | Public aggregate stats |
| GET | /projects/:id | Optional user token | Yes | Project detail + collaborators |
| POST | /projects | User token | Yes | Create project |
| PATCH | /projects/:id | Owner/admin token | Yes | Update project fields |
| POST | /projects/:id/collaborators | Owner/admin token | Yes | Add collaborator |
| DELETE | /projects/:id/collaborators/:userId | Owner/admin token | Yes | Remove collaborator |
| GET | /projects/:id/collaborators | None | Yes | List collaborators |
| POST | /projects/:id/resources/assign | User token (owner) | No | Assign resource to project (Phase 53) |
| DELETE | /projects/:id/resources/:resourceId | User token (owner) | No | Remove resource assignment (Phase 53) |
| GET | /projects/:id/resources | User token | No | List project resources (Phase 53) |
| POST | /projects/:id/api-key | User token (owner) | No | Generate API key (Phase 53) |
| POST | /projects/:id/api-key/regenerate | User token (owner) | No | Regenerate API key (Phase 53) |
| GET | /projects/by-api-key/:key | Node-internal | No | Lookup project by API key (Phase 53) |

All API routes use the async variants when StorageBackend is configured (Phase 44).

## Key Files
- `packages/node/src/project-store.ts` — ProjectStore class (MongoDB-primary, Phase 57)
- `packages/node/src/api-server.ts` — Project API routes
- `packages/node/src/agent-manager.ts` — Auto-persist on project creation
- `packages/shared/src/types.ts` — Project (+ repoUrl, teamHistory, notes since Phase 46, resources + apiKey since Phase 53), ProjectCollaborator types
- `packages/gateway/app/projects/page.tsx` — Gateway projects page
- `packages/gateway/app/api/projects/[id]/resources/route.ts` — Resource assignment proxy (Phase 53)
- `packages/gateway/app/api/projects/[id]/api-key/route.ts` — API key proxy (Phase 53)
