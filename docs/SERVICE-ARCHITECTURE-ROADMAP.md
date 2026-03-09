# Service Architecture Roadmap

> The plan to make Pando a proper modular platform where pando-code is a standalone product AND a network service, nodes are lightweight by default, and future services plug in cleanly.

## The Problem

1. `pando-code` is a **private repo** but it's core network infrastructure — nodes can't self-heal
2. It's glued in with a **broken symlink** that `npm install` destroys every upgrade
3. **Every node installs everything** — no way to run lightweight
4. No formal **service interface** — future services (exchange, storage) have no pattern to follow
5. **Credentials in git history** (AWS keys in BIBLE.md) — must clean before public

## The Vision

```
pando-code  = standalone product (build AI apps, no network needed)
            = network service (plug into pando-node for P2P, governance, Lux)

pando-node  = lightweight by default (P2P, ledger, identity, governance)
            = loads services on demand (@pando-code/core, future: @pando/exchange, etc.)
```

**Two repos. Two products. One network.**

## Architecture

### Repo Structure

```
github.com/pando-lux/pando-code   (PUBLIC — standalone AI engine)
├── packages/core/                  # @pando-code/core — npm published
├── packages/cli/                   # Standalone CLI
├── .env.example                    # Placeholder keys
└── README.md                       # "Build AI apps with PandoCode"

github.com/pando-lux/pando         (PUBLIC — the network)
├── packages/shared/                # @pando/shared
├── packages/identity/              # @pando/identity
├── packages/ledger/                # @pando/ledger
├── packages/node/                  # @pando/node (the composer)
├── packages/gateway/               # @pando/gateway
├── packages/tests/                 # @pando/tests
└── README.md                       # "Run a Pando network node"
```

### Dependency Graph

```
@pando/shared          (no deps — types, crypto, constants)
    |
    +-- @pando/identity     (Ed25519, certs, JWT)
    +-- @pando/ledger       (SQLite economy)
    +-- @pando/node         (P2P, governance, API)
    |       |
    |       +-- @pando-code/core    (OPTIONAL — AI engine, npm package)
    |       +-- @pando/exchange     (OPTIONAL — future DEX)
    |       +-- @pando/storage      (OPTIONAL — future storage)
    |
    +-- @pando-code/core    (standalone — no @pando/* deps except shared)
```

### Service Interface

```typescript
// @pando/shared — the contract all services implement
interface PandoService {
  readonly id: string;                    // 'pando-code', 'pando-exchange'
  readonly version: string;
  readonly capabilities: string[];        // what this service provides to the network

  start(ctx: ServiceContext): Promise<void>;
  stop(): Promise<void>;
  healthy(): boolean;
}

interface ServiceContext {
  peerId: string;                         // this node's identity
  dataDir: string;                        // persistent storage root
  apiPort: number;                        // HTTP API port
  apiToken?: string;                      // auth token
  registerRoutes(prefix: string, router: any): void;  // mount HTTP endpoints
  getCapability(name: string): any;       // query other services
}
```

### How pando-code Implements It

```typescript
// @pando-code/core — exports both standalone and service interfaces
export { PandoCode, EnginePool, Board, Scheduler };  // standalone API

// Service adapter (only used when loaded by pando-node)
export function createService(): PandoService {
  return {
    id: 'pando-code',
    version: '0.1.0',
    capabilities: ['ai-engine', 'agents', 'board', 'scheduler'],
    async start(ctx) { /* init EnginePool with node context */ },
    async stop() { /* shutdown engines */ },
    healthy() { return pool.healthy(); },
  };
}
```

### How Nodes Discover Services

```typescript
// @pando/node startup — service discovery
const SERVICE_PACKAGES = [
  '@pando-code/core',      // AI engine
  // future: '@pando/exchange', '@pando/storage', etc.
];

for (const pkg of SERVICE_PACKAGES) {
  try {
    const mod = await import(pkg);
    if (typeof mod.createService === 'function') {
      const svc = mod.createService();
      await svc.start(context);
      services.set(svc.id, svc);
      log(`[services] Started ${svc.id} v${svc.version}`);
    }
  } catch {
    log(`[services] ${pkg} not installed — skipping`);
  }
}
```

**No config file needed.** If the npm package is installed, the service loads. If not, it's skipped. Simple.

### How Operators Choose What to Run

```bash
# Light node (relay + validate only):
npm install                          # default — no services
node packages/node/dist/cli.js

# AI node (adds PandoCode):
npm install @pando-code/core         # adds AI capability
node packages/node/dist/cli.js       # auto-detects and loads

# Future: DEX node:
npm install @pando/exchange
node packages/node/dist/cli.js
```

---

## Phases

### Phase 0: Security Cleanup (BEFORE anything goes public)

**Priority: CRITICAL. Do this first.**

| # | Task | Status |
|---|------|--------|
| 0.1 | Remove AWS keys from BIBLE.md (line 1872-1873) | DONE |
| 0.2 | Rotate ALL exposed credentials (AWS, OpenAI, Google, PANDO_API_TOKEN) | TODO (manual — rotate in AWS IAM console) |
| 0.3 | Audit git history for leaked secrets (`git log -S "AKIA\|sk-proj\|AIzaSy"`) | DONE (only AWS key ID in 1 commit, no secret key) |
| 0.4 | Use `git filter-repo` to scrub secrets from history if found | TODO (scrub AKIA from commit 81181eb3 before going public) |
| 0.5 | Verify .gitignore covers: .env*, infra/.env, infra/nodes.json, .deploy-backups/, secrets/ | DONE |
| 0.6 | Add pre-commit hook to block credential patterns | DONE |
| 0.7 | Create .env.example files with placeholder values | DONE |

**Done when:** `git log -S "AKIA" --all` returns zero results. All keys rotated.

### Phase 1: Define Service Interface

**Priority: HIGH. Foundation for everything else.**

| # | Task | Status |
|---|------|--------|
| 1.1 | Add `PandoService` and `ServiceContext` interfaces to `@pando/shared/types.ts` | DONE |
| 1.2 | Create `ServiceLoader` in `@pando/node` — discovers and loads installed services | DONE |
| 1.3 | Refactor `engine-adapter.ts` to implement `PandoService` interface | DONE (createEngineService() wrapper) |
| 1.4 | Move engine-adapter HTTP routes to be registered via `ServiceContext.registerRoutes()` | DEFERRED (future — routes stay in core-api.ts during transition) |
| 1.5 | Node startup calls `ServiceLoader.loadAll()` instead of hardcoded `startEngine()` | PARTIAL (ServiceLoader initialized, loadAll() deferred until pando-code ships createService()) |
| 1.6 | Verify: node runs fine with no services installed (light mode) | DONE (build passes, nodeMode guards in place) |
| 1.7 | Verify: node runs fine with @pando-code/core installed (full mode) | DONE (build passes, existing engine flow preserved) |

**Done when:** `npm uninstall @pando-code/core && node cli.js` runs a working light node. `npm install @pando-code/core && node cli.js` runs a full node with AI.

### Phase 2: Make pando-code Public

**Priority: HIGH. Unblocks all nodes.**

| # | Task | Status |
|---|------|--------|
| 2.1 | Audit pando-code repo for secrets (agent already did this — .env is gitignored, code is clean) | TODO |
| 2.2 | Add .env.example to pando-code with placeholder keys | TODO |
| 2.3 | Add README.md for standalone usage | TODO |
| 2.4 | Add `createService()` export to @pando-code/core for pando-node integration | TODO |
| 2.5 | Publish @pando-code/core to npm (or use git-based install: `npm install github:pando-lux/pando-code`) | TODO |
| 2.6 | Change GitHub repo visibility: private → public | TODO |
| 2.7 | Update pando-node to install @pando-code/core from npm/git instead of local symlink | TODO |
| 2.8 | Test: fresh clone of pando-node + `npm install @pando-code/core` → full node works | TODO |

**Done when:** A new user can `git clone pando && npm install && npm install @pando-code/core && node cli.js` and have a working full node.

### Phase 3: Clean Rename (@pando-code/core references)

**Priority: MEDIUM. Consistency.**

This is the big mechanical rename. All 100+ references across the codebase.

| # | Task | Status |
|---|------|--------|
| 3.1 | Update all `import('@pando-code/core')` calls in engine-adapter.ts (4 locations) | TODO |
| 3.2 | Update `pando-code.d.ts` type stub | TODO |
| 3.3 | Update capability-detector.ts package check | TODO |
| 3.4 | Update upgrade-protocol.ts backup/restore paths | TODO |
| 3.5 | Update index.ts infrastructure app registration | TODO |
| 3.6 | Update types.ts NodeCapability enum if needed | TODO |
| 3.7 | Update BIBLE.md (58 references) | TODO |
| 3.8 | Update CLAUDE.md | TODO |
| 3.9 | Update docs/ROADMAP.md | TODO |
| 3.10 | Update all archive docs (optional — these are historical) | SKIP |
| 3.11 | Update gateway dropdown options | TODO |
| 3.12 | Update playwright.config.ts project list | TODO |
| 3.13 | Update .gitignore patterns (`.pando-code.db` stays — it's the app's DB name) | TODO |

**Note:** `.pando-code.db` filename stays unchanged — that's PandoCode's internal database name, not a package reference.

**Done when:** `grep -r "pando-code" packages/node/src/ --include="*.ts"` only returns the `.pando-code.db` filename references and the `PANDO_CODE` capability enum (which is the network identifier).

### Phase 4: Legacy Cleanup

**Priority: MEDIUM. Code health.**

| # | Task | Status |
|---|------|--------|
| 4.1 | Remove PM2 from app-manager.ts — replace with systemd unit generation | REVISED — PM2 is actively used for Tier 2 app hosting. Keep. |
| 4.2 | Remove PM2 from cloud-instance-manager.ts bootstrap script | REVISED — PM2 actively used on EC2. Keep. |
| 4.3 | Remove PM2 references from cli.ts, api files | REVISED — PM2 env detection is active code. Keep. |
| 4.4 | Delete legacy `/council/*` routes in core-api.ts (migrate gateway first) | BLOCKED — gateway still calls /api/council/*. Migrate gateway first. |
| 4.5 | Remove `workspaceBaseDir` from scheduler config | REVISED — still used by getTaskLogs(). Keep. |
| 4.6 | Update comments: remove Lightsail references, update to reflect current infra | TODO |
| 4.7 | Delete the symlink backup/restore hack from upgrade-protocol.ts | DEFERRED — bridge code needed until Phase 2 (npm package) is done. |
| 4.8 | Remove `@pando-code/core` from all package.json and package-lock.json | DONE (d084f15) |

**Revised assessment:** PM2 is actively used (Tier 2 app hosting), not dead code. Council routes blocked on gateway migration. Symlink hack is bridge code for Phase 2.

### Phase 5: Documentation

**Priority: MEDIUM. Update the truth.**

| # | Task | Status |
|---|------|--------|
| 5.1 | Update BIBLE.md: new service architecture section | DONE (Section 5.11) |
| 5.2 | Update BIBLE.md: remove/update brain/body split to reflect service interface | DONE (brain/body stays — service layer added on top) |
| 5.3 | Update BIBLE.md: document ServiceLoader, PandoService interface | DONE (Section 4.2 + 5.11) |
| 5.4 | Update CLAUDE.md: new package structure, service pattern | TODO |
| 5.5 | Update infra/DEV-MODE.md: document service installation for nodes | TODO |
| 5.6 | Create README.md for pando-node: "How to run a node" (light vs full) | TODO |
| 5.7 | Update MEMORY.md with new architecture | TODO |

**Done when:** BIBLE.md reflects reality. New contributor can understand the architecture from docs alone.

### Phase 6: Dynamic Testing

**Priority: HIGH. Prove it works.**

| # | Task | Status |
|---|------|--------|
| 6.1 | Fresh clone test: `git clone pando && npm install && node cli.js` → light node works | TODO |
| 6.2 | Service install test: `npm install @pando-code/core` → AI capability activates | TODO |
| 6.3 | Service uninstall test: `npm uninstall @pando-code/core` → node gracefully degrades | TODO |
| 6.4 | Upgrade test: commit-and-propose → all 4 nodes upgrade → services survive | TODO |
| 6.5 | Failover test: kill managing node → another node claims → services restart | TODO |
| 6.6 | Multi-service test: (future) install two services → both load | TODO |

**Done when:** All tests pass on live 4-node network.

---

## What We're NOT Doing

- **Not merging repos.** pando-code stays separate — it's a standalone product.
- **Not publishing to npm registry (yet).** Git-based install (`github:pando-lux/pando-code`) works for now. npm publish when we have more users.
- **Not changing the P2P protocol.** Service loading is local-only. P2P layer unchanged.
- **Not renaming `.pando-code.db`.** That's PandoCode's internal database — changing it would break existing installations.
- **Not building a service marketplace (yet).** That's Phase 4 in the main roadmap. This roadmap is about making the foundation right.

---

## Order of Execution

```
Phase 0 (security) ──→ Phase 1 (interface) ──→ Phase 2 (public) ──→ Phase 6 (test)
                                    |
                              Phase 3 (rename) ──→ Phase 4 (cleanup)
                                                        |
                                                  Phase 5 (docs)
```

Phase 0 must be first (security). Phase 1 before Phase 2 (need interface before publishing). Phases 3-5 can overlap. Phase 6 is continuous.

## Success Criteria

1. **Light node:** `git clone && npm install && node cli.js` — works, P2P connects, earns relay fees
2. **Full node:** `npm install @pando-code/core` — AI agents activate, teams run, board works
3. **Standalone PandoCode:** `git clone pando-code && npm install && npx pando-code` — works without network
4. **No symlinks, no hacks, no backup/restore** — standard npm dependency management
5. **Any future service follows the same pattern** — implement PandoService, publish to npm, install on node
