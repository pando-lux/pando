# Future Concerns Report

> **STATUS: REFERENCE ONLY** — Point-in-time analysis of design gaps and future concerns. Verify current state before acting on any item.
> Generated: 2026-03-08
> Scope: Logical inconsistencies, unenforced permissions, dead states, phantom features

---

## 1. No Resource Selection Strategy

When multiple credentials of the same type exist (e.g. 100 contributed OpenAI keys), `CredentialStore.getActiveByType()` simply returns the **first active, non-expired document** from MongoDB. No load balancing, no round-robin, no scoring.

- **Location**: `node/packages/node/src/core/credential-store.ts:163-189`
- **Behavior**: `collection.find({ type, status: 'active' }).toArray()` → loop → return first that decrypts
- **Impact**: One key gets hammered while 99 sit idle. If it gets rate-limited, the system has no fallback logic — it just keeps using the same one until it expires or is revoked.
- **Recommendation**: Implement round-robin or random selection. Track last-used timestamp per credential and pick least-recently-used.

---

## 2. maxUsagePerDay is Never Enforced

Every `ResourceRecord` has a `maxUsagePerDay` field, but **nothing in the codebase checks or increments a usage counter**.

- **Location**: `node/packages/node/src/platform/resource-registry.ts:78` (schema), `node/packages/shared/src/types.ts` (type definition)
- **Where it should be checked**: `credential-store.ts:getCredential()` and `getActiveByType()` — before returning a decrypted credential
- **Impact**: A contributor sets `maxUsagePerDay: 100` expecting their key to be rate-limited. The system ignores it and uses the key unlimited times.
- **Recommendation**: Add a `usage_log` collection or SQLite table. Increment on each `getCredential()` call. Skip credentials that have hit their daily cap in `getActiveByType()`.

---

## 3. No Credential Rotation or Failover

If a credential fails at runtime (e.g. OpenAI returns 401 because the key was revoked externally), there is no mechanism to:

- Mark it as unhealthy
- Try the next available credential
- Notify the contributor

- **Location**: `resource-health.ts` does periodic health checks, but the results don't feed back into `getActiveByType()` selection
- **Impact**: A bad key stays "active" in the database. Every request that uses it fails. The system keeps picking it because it's first in the list.
- **Recommendation**: Add a `lastHealthCheck` / `healthy` field. `getActiveByType()` should skip unhealthy credentials. Health checker should mark credentials as `unhealthy` after N consecutive failures.

---

## 4. MongoDB URL is Not a Contributed Resource

The MongoDB connection is **hardcoded per-node** via `PANDO_STORAGE_URL` env var or `--storage` CLI flag. It is not part of the ResourceRegistry and cannot be contributed, rotated, or shared.

- **Location**: `node/packages/node/src/cli.ts:245-300`, `node/packages/node/src/init-core.ts:30-44`
- **Current state**: Every EC2 compute node must be manually configured to point at a MongoDB instance
- **Impact**: Single point of failure. If the MongoDB goes down, all compute nodes that point to it lose credential access simultaneously.
- **Recommendation**: For now this is fine (ops concern, not code concern). Long-term, consider making the MongoDB connection a contributed resource with failover to a secondary.

---

## 5. pricePerUnit is Stored but Never Charged

Resources have a `pricePerUnit` field, but there is no billing or Lux deduction when a credential is used.

- **Location**: `node/packages/node/src/platform/resource-registry.ts:79` (schema field)
- **Impact**: Contributors who set a price expecting to earn Lux for usage get nothing. The field is cosmetic.
- **Recommendation**: When `getCredential()` is called, check `pricePerUnit`. If > 0, deduct from the requester's Lux balance via the ledger before returning the credential.

---

## 6. grantedTo Permissions are Never Checked at Credential Access Time

Resources have a `grantedTo` array (e.g. `['*']` or `['peer-abc', 'peer-xyz']`), but `getCredential()` and `getActiveByType()` don't verify that the requesting peer is in the list.

- **Location**: `node/packages/node/src/core/credential-store.ts:142-161` — no caller identity check
- **Impact**: Any node with `CREDENTIAL_MASTER_KEY` can decrypt any credential, regardless of `grantedTo`. The permission model is metadata-only theater.
- **Recommendation**: Pass `requestingPeerId` to `getCredential()`. Check `grantedTo` includes `'*'` or the peer's ID before decrypting.

---

---
---

# Governance & Network Logic (pando-node)

---

## 7. Governance Proposals Pass but Never Execute

When proposals reach consensus and status is set to `'passed'`, **no code actually executes the proposal**. No `applyProposal()` function exists. `proposal.payload` and `proposal.upgradePayload` are never read to trigger changes.

- **Location**: `node/packages/node/src/kernel/governance.ts:759, 861`
- **Impact**: Governance voting is cosmetic. Proposals can be voted on and marked "passed" but the network doesn't implement the decisions. The system claims to make decisions but doesn't act on them.
- **Severity**: CRITICAL

---

## 8. Content Report 'reviewing' Status is Unreachable

The `'reviewing'` status is queried in `content_reports` table and accepted as valid, but no code path ever sets it. Reports jump directly from `'pending'` to `'resolved'` or `'dismissed'`.

- **Location**: `node/packages/node/src/platform/project-store.ts:1809, 1831` (queried), `platform-api.ts:2849` (accepted as valid)
- **Transitions that exist**: `pending` → `resolved` | `dismissed`
- **Missing transition**: `pending` → `reviewing` → `resolved`
- **Impact**: `getContentReportStats()` reviewing count will always return 0. False sense that reports go through a review phase.
- **Severity**: MEDIUM

---

## 9. ~~enableCouncil Config Flag is Ignored~~ RESOLVED

**RESOLVED**: The `enableCouncil` flag was renamed to `enableTeams` as part of the council-to-teams migration. Teams are now enabled automatically when an EngineAdapter is available. The flag controls whether the pando-infra team (formerly "council") auto-starts on boot.

- **Location**: `node/packages/shared/src/types.ts`
- **Original issue**: Users could set `enableCouncil: true` in config but it had zero effect.
- **Resolution**: Renamed to `enableTeams`. Teams system replaces the legacy council concept.

---

## 10. DeployPipeline Events Emitted but Nobody Listens

`DeployPipeline` emits `deploy_pipeline_started`, `deploy_pipeline_failed`, `deploy_pipeline_completed` via a `pushEvent` callback, but no code subscribes to or handles these events.

- **Location**: `node/packages/node/src/core/deploy-pipeline.ts:92, 105, 149`
- **Impact**: Deploy pipeline state changes are invisible to clients. SSE subscribers don't get pipeline status.
- **Severity**: LOW

---

## 11. Proposal 'revision_requested' is a Dead-End State

When AI reviewers recommend "revise", proposal status is set to `'revision_requested'` and stake is refunded. But there is no mechanism to resubmit a revised proposal or transition it back to active.

- **Location**: `node/packages/node/src/kernel/governance.ts:1641-1647`
- **Impact**: Proposals enter `revision_requested` and stay there forever. No way out.
- **Severity**: LOW

---

## 12. findBestBuilder() Has No Scoring

Builder peer selection just picks the first available candidate. No latency, load, or reputation scoring.

- **Location**: `node/packages/node/src/api/platform-api.ts:78`
- **Code**: `return { peerId: remoteCandidates[0].peerId, isLocal: false };`
- **Impact**: All build work routes to the same peer. No load distribution.
- **Severity**: MEDIUM

---
---

# Agent & Engine Logic (pando-teams)

---

## 13. Permission Checks Exported but Never Called

`checkToolPermission()` and `checkRiskPermission()` are fully implemented and exported from core, but **never called anywhere**. The tool registry only checks hard guardrails, not role-based permissions.

- **Location**: `code/packages/core/src/guardrails/permissions.ts:83-142`
- **Impact**: A "tester" agent can use `write_file` or `bash`. A "reviewer" agent can modify code. Role-based tool restrictions are completely unenforced.
- **Severity**: HIGH

---

## 14. Risk Tier Overrides Defined but Never Passed

Config schema defines `riskTiers.overrides: Record<string, RiskTier>`, and `classifyRisk()` accepts overrides as a parameter, but no call site ever passes them.

- **Location**: `code/packages/core/src/types.ts:394`, `code/packages/core/src/guardrails/risk.ts:70`
- **Impact**: Config-level risk tier customization is impossible despite being in the schema.
- **Severity**: MEDIUM

---

## 15. Token Budget Limits Defined but Never Enforced

Budget config defines `turn.maxInputTokens`, `turn.maxOutputTokens`, `session.maxTokens`, `task.maxTokens` — but only **USD cost** limits are enforced. Token counts are never checked.

- **Location**: `code/packages/core/src/types.ts:352-355`, `code/packages/core/src/engine/engine.ts:1388-1413`
- **Impact**: An agent can burn unlimited tokens as long as the dollar cost stays under the limit. Token limits are cosmetic.
- **Severity**: HIGH

---

## 16. Task Status "failed" and "rolled_back" are Unreachable

`TaskStatusSchema` defines `"failed"` and `"rolled_back"` but the Board class only sets `"pending"`, `"in_progress"`, `"done"`, `"cancelled"`. No code path reaches the other states.

- **Location**: `code/packages/core/src/types.ts:33-40`, `code/packages/core/src/board/board.ts:118-136`
- **Impact**: Dead enum values. Developers assume tasks can fail or roll back, but the system can't represent that.
- **Severity**: MEDIUM

---

## 17. Agent Status "failed" and "terminated" are Unreachable

Agent lifecycle only transitions between `"working"` and `"idle"`. The statuses `"failed"`, `"terminated"`, `"pending"`, `"active"`, `"done"` are defined but never set.

- **Location**: `code/packages/core/src/types.ts:237-245`, `code/packages/core/src/engine/engine.ts:824-826`
- **Impact**: No way to know if an agent crashed. Sub-agents don't track status at all.
- **Severity**: MEDIUM

---

## 18. Board Task "progress" Field is Write-Only

`updateProgress()` allows agents to write progress text to a task, and the Board reads it back into the task object, but nothing ever displays it, injects it into prompts, or uses it for decisions.

- **Location**: `code/packages/core/src/board/board.ts:153-157`, `code/packages/core/src/db/schema.ts:91`
- **Impact**: Orphaned field that appears useful but serves no purpose.
- **Severity**: MEDIUM

---

## 19. Orchestrator Config Options are All Ignored

These config values are accepted but never read by any code:
- `orchestrator.maxToolCalls`
- `orchestrator.maxWorkerSteps`
- `orchestrator.maxTicks`
- `orchestrator.sessionMaxAgeHours`
- `orchestrator.impactFileDisplayCount`

- **Location**: `code/packages/core/src/types.ts:420-427`, `code/packages/core/src/config/index.ts:33-36`
- **Impact**: Misleading config options that do nothing.
- **Severity**: LOW

---

## 20. lesson:new Event Defined but Never Emitted

`StreamEvent` union type includes `{ type: "lesson:new"; lesson: string; confidence: number }` but no code emits it. `MemoryStore.saveLessonIfNew()` doesn't emit events.

- **Location**: `code/packages/core/src/types.ts:572`
- **Impact**: Clients listening for lesson events will never receive them.
- **Severity**: LOW

---

## 21. Task Assignment Doesn't Drive Behavior

Tasks can be assigned to agents via `assignTask()`, but the assigned agent doesn't automatically pick up the task. There's no queue, no priority system, no dispatch. The assignment is purely informational.

- **Location**: `code/packages/core/src/board/board.ts:138-148`, `code/packages/core/src/tool/manage-tasks.ts:106`
- **Impact**: Assigning a task to an agent is a label, not an action. The agent won't know unless it polls.
- **Severity**: MEDIUM

---
---

# Full Summary

| # | Issue | System | Severity |
|---|-------|--------|----------|
| 1 | No credential selection strategy | node | HIGH |
| 2 | maxUsagePerDay not enforced | node | HIGH |
| 3 | No credential failover | node | MEDIUM |
| 4 | MongoDB URL hardcoded | node | LOW |
| 5 | pricePerUnit never charged | node | MEDIUM |
| 6 | grantedTo never enforced on decrypt | node | HIGH |
| 7 | **Governance proposals pass but never execute** | node | **CRITICAL** |
| 8 | Content report 'reviewing' unreachable | node | MEDIUM |
| 9 | ~~enableCouncil config flag ignored~~ RESOLVED | node | -- |
| 10 | DeployPipeline events unhandled | node | LOW |
| 11 | Proposal 'revision_requested' dead-end | node | LOW |
| 12 | findBestBuilder() no scoring | node | MEDIUM |
| 13 | Permission checks never called | code | HIGH |
| 14 | Risk tier overrides never passed | code | MEDIUM |
| 15 | Token budget limits not enforced | code | HIGH |
| 16 | Task status "failed"/"rolled_back" unreachable | code | MEDIUM |
| 17 | Agent status "failed"/"terminated" unreachable | code | MEDIUM |
| 18 | Board task progress is write-only | code | MEDIUM |
| 19 | Orchestrator config options all ignored | code | LOW |
| 20 | lesson:new event never emitted | code | LOW |
| 21 | Task assignment doesn't drive behavior | code | MEDIUM |

---
---

# Deep Flow Traces (12 flows traced end-to-end)

---

## REPUTATION SYSTEM

### 22. Vote Weighting Implemented but Never Called

`getWeightedVoteResult()` exists in `governance.ts:318-326` and `ReputationWeightedGovernance.applyWeighting()` exists in `reputation-governance.ts:181-227`. But governance actually uses simple 1-vote-per-peer counting (`governance.ts:821-843`). Reputation weights are calculated but never applied to vote outcomes.

- **Impact**: The entire reputation-weighted governance system is decorative. A brand-new node has the same vote power as a node that's been running for a year.
- **Severity**: HIGH

### 23. No Reputation Decay

Reputation scores never decay over time. `STALE_RECORD_MS = 7 days` only prunes old peer records, not reduces scores. A node that did great work 6 months ago and has been offline since retains full reputation.

- **Location**: `node/packages/node/src/kernel/reputation.ts:56, 125-127`
- **Severity**: MEDIUM

### 24. Reputation Doesn't Affect Task Assignment

Reputation is tracked but scheduler doesn't use it for task assignment. `reputationCallback` in scheduler only RECORDS events, doesn't influence which peer gets work.

- **Location**: `node/packages/node/src/platform/scheduler.ts:105`
- **Severity**: MEDIUM

---

## LUX EMISSION / MINTING

### 25. DAILY_EMISSION_CAP Defined but Never Enforced

`DAILY_EMISSION_CAP = 500` is defined in `shared/types.ts:267` but **zero code references it**. Any node can mint unlimited Lux per day if it gets witness attestations.

- **Location**: `node/packages/shared/src/types.ts:267` (defined), nowhere (enforced)
- **Impact**: The economic model's core constraint is cosmetic. Hyperinflation possible.
- **Severity**: CRITICAL

### 26. Emission Witness Doesn't Validate Work Proof

`handleRemoteProposal()` checks anti-spoofing (peerId match) and rate limits (10/hour), but the `workProof` string is accepted without any legitimacy check. Any string passes.

- **Location**: `node/packages/node/src/kernel/emission-witness.ts:245-278`
- **Impact**: Nodes can submit fake work proofs and mint Lux for nothing.
- **Severity**: HIGH

### 27. Bootstrap Auto-Approve Bypasses Witness Quorum

When fewer than 3 nodes exist on the network, emission proposals are auto-approved immediately without any witness attestation.

- **Location**: `node/packages/node/src/kernel/emission-witness.ts:215-217`
- **Impact**: In early network, a single node can mint unlimited Lux with zero oversight.
- **Severity**: HIGH

### 28. Balances Can Go Negative During Sync

`forceSubtractBalance()` in `accounts.ts:79-80` intentionally allows negative balances for pre-validated remote transactions. If transactions arrive out of order, a peer can have a negative balance until the matching credit arrives.

- **Location**: `node/packages/ledger/src/accounts.ts:79-80`
- **Impact**: Temporary negative balances. If the credit never arrives, permanently negative.
- **Severity**: MEDIUM

---

## SECURITY MONITOR

### 29. Quarantine Only Blocks Message Ingress

When a peer is quarantined (security-monitor.ts:598-601), the ONLY enforcement is in `init-platform.ts:1121-1123` — incoming messages from the peer are dropped. But the quarantined peer can still:
- Vote on governance proposals
- Relay transactions
- Claim tasks
- Create emission proposals

- **Impact**: Quarantine is half-enforced. A detected attacker loses incoming message processing but retains all other network participation.
- **Severity**: HIGH

### 30. Auto-Release After 1 Hour

Quarantined peers are automatically released after 1 hour via `releaseExpiredQuarantines()` (security-monitor.ts:551-570). No human review required.

- **Impact**: Detected threats get automatic leniency. An attacker just waits 60 minutes.
- **Severity**: HIGH

### 31. Guardrail Violations Logged but Not Auto-Rolled-Back

`postCheck()` in guardrails.ts detects build failures, test failures, and immutable kernel file modifications. It returns `{ passed: false }` but the caller is responsible for rollback. No automatic rollback exists.

- **Location**: `node/packages/node/src/kernel/guardrails.ts:331-518`
- **Impact**: A failed build or modified kernel file is logged but code changes persist.
- **Severity**: HIGH

### 32. Tripwire System is Just a Label

References to "tripwire" exist in init-platform.ts, tui.ts, and cloud-instance-manager.ts, but no activation, blocking, or remediation logic exists. It's a UI label and comments only.

- **Location**: `init-platform.ts:1635`, `tui.ts:1722`, `cloud-instance-manager.ts:623`
- **Note**: `CredentialStore.wipe()` does exist and zeros the master key — this is the one real tripwire action, but it's never triggered automatically by the security monitor.
- **Severity**: MEDIUM

---

## P2P MESSAGE HANDLING

### 33. 17 Message Types Have No Handler (Silent Drop)

Of 39 defined `MessageType` values, only ~8 have explicit handlers in `init-platform.ts:1141-1219`. The rest (including `GOVERNANCE_PROPOSAL`, `GOVERNANCE_VOTE`, `GOVERNANCE_DECISION`, `AGENT_MESSAGE`, `TRANSFER_CONFIRM`, `EMISSION_NOTIFY`, etc.) are silently dropped on receipt.

- **Note**: Some of these may be handled via GossipSub topic subscriptions rather than the main message handler. Governance messages go through `pando/governance` topic, emissions through `pando/emissions`, etc. But the main handler drops them silently.
- **Severity**: MEDIUM (partially mitigated by topic subscriptions)

### 34. Signature Verification Skipped for Unknown Peers

`network.ts:961-971` — verification only happens if BOTH `message.signature` is present AND `peer.publicKey` exists in the local peers map. For newly connected peers whose public key isn't stored, signed messages are accepted without verification.

- **Location**: `node/packages/node/src/kernel/network.ts:961-971`
- **Severity**: CRITICAL

### 35. Peer Spoofing via Placeholder Public Keys

`sync.ts:281-284` registers remote peers with `'remote-peer'` as their public key. When verification runs, it tries to verify against this string (not real key bytes), and the check silently passes or is skipped.

- **Location**: `node/packages/node/src/kernel/sync.ts:281, 284, 411, 414`
- **Impact**: Any peer can forge transactions claiming to be from another peer.
- **Severity**: CRITICAL

---

## IDENTITY & JWT

### 36. JWT Tokens Cannot Be Revoked

JWT auth is fully stateless. Once issued (24h TTL), a token cannot be revoked. No blacklist, no revocation list, no token invalidation mechanism.

- **Location**: `node/packages/identity/src/auth/jwt.ts`
- **Impact**: Compromised accounts stay active for 24 hours regardless.
- **Severity**: HIGH

### 37. No User Ban Mechanism

Account data model has: `peerId, publicKey, balance, username, displayName, passwordHash, isClaimed`. No `status`, `banned`, or `disabled` field. A compromised or malicious user cannot be banned.

- **Location**: `node/packages/ledger/src/accounts.ts:111-116`
- **Severity**: CRITICAL

### 38. No Login Rate Limiting

`POST /auth/login` has no rate limit. The RATE_LIMITS config in `api-server.ts:92-105` covers `/auth/guest` (5/min) but NOT `/auth/login`.

- **Location**: `node/packages/node/src/api/api-server.ts:92-105`
- **Impact**: Brute-force password attacks are unrestricted.
- **Severity**: HIGH

---

## LEDGER SYNC

### 39. Double-Spending Across Simultaneous Nodes

Balance is checked only on the originating node. Remote nodes apply transactions via `applyRemoteTransaction()` which skips balance validation (`sync.ts:417`). Two nodes spending the same balance simultaneously both succeed.

- **Location**: `node/packages/ledger/src/transactions.ts:36-40` (local check), `node/packages/node/src/kernel/sync.ts:417` (remote skip)
- **Impact**: Classic double-spend. Peer X has 100 Lux. Node A sends 100 to Y. Node B sends 100 to Z. Both accepted. X now has -100.
- **Severity**: CRITICAL

### 40. Malicious Peers Can Broadcast Fake Balances

Account claims include a `balance` field that is accepted without validation. `accounts.ts:164-170` applies balance and adds to totalSupply.

- **Location**: `node/packages/ledger/src/accounts.ts:164-170`
- **Impact**: A malicious peer can claim an account with 1 billion Lux balance.
- **Severity**: CRITICAL

### 41. Total Supply Double-Counting

If an emission transaction AND an account claim arrive in catch-up sync, totalSupply can be incremented twice: once for the emission tx (`transactions.ts:142-145`) and again for the claim balance (`sync.ts:322-325`).

- **Location**: `node/packages/node/src/kernel/sync.ts:322-325`, `node/packages/ledger/src/transactions.ts:142-145`
- **Impact**: Supply inflation through sync race condition.
- **Severity**: HIGH

---

## ENGINE & TASK LIFECYCLE

### 42. No Timeout on Engine Execution

If the AI engine hangs (infinite loop, blocking I/O), the async generator never completes. No timeout at engine-adapter, pool, or HTTP level. User request hangs forever.

- **Location**: `node/packages/node/src/core/engine-adapter.ts:513`
- **Severity**: CRITICAL

### 43. Budget Exhaustion Returns Silent Failure

When engine runs out of budget mid-stream, `sendToEngine()` catches the error and returns `{sent: false}` with no error message. Collected chunks are discarded. User gets no explanation.

- **Location**: `node/packages/node/src/api/platform-api.ts:42-44`
- **Severity**: HIGH

### 44. Tasks Stuck in in_progress Never Expire

`cleanupExpiredTasks()` only expires `'open'` tasks older than 48h. Tasks in `'claimed'` or `'in_progress'` are never expired, never cleaned up, never recovered (unless scheduler restarts for local tasks). Remote node tasks are explicitly skipped during recovery.

- **Location**: `node/packages/node/src/platform/task-database.ts:523-537`, `scheduler.ts:660-687`
- **Impact**: Database bloat. Zombie tasks forever.
- **Severity**: CRITICAL

### 45. Concurrent poll() Calls if Previous Runs Long

Scheduler uses `setInterval` with no guard against previous poll() still running. If poll takes longer than the interval, multiple polls run concurrently.

- **Location**: `node/packages/node/src/platform/scheduler.ts:187-197`
- **Severity**: HIGH

### 46. No Task Queue Capacity Limit

No max queue size, no backpressure, no rejection when full. A malicious node could spam thousands of tasks and exhaust memory/disk.

- **Location**: `node/packages/node/src/platform/scheduler.ts` (no capacity check)
- **Severity**: MEDIUM

---

## USER AUTH & PROJECTS

### 47. Content Safety Reviews Are Advisory Only

`ContentSafetyReviewer` runs analysis and produces scores, but nothing in the publish pipeline checks or blocks based on results. Unsafe content publishes regardless.

- **Location**: `node/packages/node/src/platform/content-safety.ts:205-231`, `platform-api.ts:1506-1526`
- **Severity**: HIGH

### 48. No Task Cleanup on Project Archive

When a project is archived (soft-deleted), no code cancels or pauses running tasks associated with it. Orphaned compute tasks continue consuming resources.

- **Location**: `node/packages/node/src/platform/project-store.ts:647-667`
- **Severity**: MEDIUM

### 49. aiSafetyScore Field Written but Never Used

Content reports have an `aiSafetyScore` field initialized to -1. ContentSafetyReviewer calculates scores, but they're never written back to reports or used for auto-moderation.

- **Location**: `node/packages/node/src/platform/project-store.ts` (field exists), content-safety.ts (scores calculated)
- **Severity**: LOW

---
---

# Full Summary

| # | Issue | System | Severity |
|---|-------|--------|----------|
| 1 | No credential selection strategy | node | HIGH |
| 2 | maxUsagePerDay not enforced | node | HIGH |
| 3 | No credential failover | node | MEDIUM |
| 4 | MongoDB URL hardcoded | node | LOW |
| 5 | pricePerUnit never charged | node | MEDIUM |
| 6 | grantedTo never enforced on decrypt | node | HIGH |
| 7 | Governance proposals pass but never execute | node | CRITICAL |
| 8 | Content report 'reviewing' unreachable | node | MEDIUM |
| 9 | ~~enableCouncil config flag ignored~~ RESOLVED | node | -- |
| 10 | DeployPipeline events unhandled | node | LOW |
| 11 | Proposal 'revision_requested' dead-end | node | LOW |
| 12 | findBestBuilder() no scoring | node | MEDIUM |
| 13 | Permission checks never called | code | HIGH |
| 14 | Risk tier overrides never passed | code | MEDIUM |
| 15 | Token budget limits not enforced | code | HIGH |
| 16 | Task status "failed"/"rolled_back" unreachable | code | MEDIUM |
| 17 | Agent status "failed"/"terminated" unreachable | code | MEDIUM |
| 18 | Board task progress is write-only | code | MEDIUM |
| 19 | Orchestrator config options all ignored | code | LOW |
| 20 | lesson:new event never emitted | code | LOW |
| 21 | Task assignment doesn't drive behavior | code | MEDIUM |
| 22 | Vote weighting implemented but never called | node | HIGH |
| 23 | No reputation decay | node | MEDIUM |
| 24 | Reputation doesn't affect task assignment | node | MEDIUM |
| 25 | **DAILY_EMISSION_CAP defined but never enforced** | node | **CRITICAL** |
| 26 | Emission witness doesn't validate work proof | node | HIGH |
| 27 | Bootstrap auto-approve bypasses witness quorum | node | HIGH |
| 28 | Balances can go negative during sync | node | MEDIUM |
| 29 | Quarantine only blocks message ingress | node | HIGH |
| 30 | Quarantine auto-releases after 1 hour | node | HIGH |
| 31 | Guardrail violations not auto-rolled-back | node | HIGH |
| 32 | Tripwire system is just a label | node | MEDIUM |
| 33 | 17 message types silently dropped | node | MEDIUM |
| 34 | **Signature verification skipped for unknown peers** | node | **CRITICAL** |
| 35 | **Peer spoofing via placeholder public keys** | node | **CRITICAL** |
| 36 | JWT tokens cannot be revoked | node | HIGH |
| 37 | **No user ban mechanism** | node | **CRITICAL** |
| 38 | No login rate limiting | node | HIGH |
| 39 | **Double-spending across simultaneous nodes** | node | **CRITICAL** |
| 40 | **Malicious peers can broadcast fake balances** | node | **CRITICAL** |
| 41 | Total supply double-counting | node | HIGH |
| 42 | **No timeout on engine execution** | node | **CRITICAL** |
| 43 | Budget exhaustion returns silent failure | node | HIGH |
| 44 | **Tasks stuck in in_progress never expire** | node | **CRITICAL** |
| 45 | Concurrent poll() calls | node | HIGH |
| 46 | No task queue capacity limit | node | MEDIUM |
| 47 | Content safety reviews advisory only | node | HIGH |
| 48 | No task cleanup on project archive | node | MEDIUM |
| 49 | aiSafetyScore field never used | node | LOW |

---
---

# Round 3: Deep Flow Traces (16 more flows)

---

## CLOUD INSTANCE MANAGER

### 50. Orphan EC2 Instances on Partial Provisioning Failure

`launchInstance()` calls `ec2.send(new RunInstancesCommand())` and gets an instanceId. If subsequent steps fail (security group, IP polling, DB persistence), the EC2 instance is never terminated. Billing continues forever.

- **Location**: `node/packages/node/src/core/cloud-instance-manager.ts:202-238`
- **Severity**: CRITICAL

### 51. No Cost Tracking or Spending Limits on Instance Provisioning

`launchInstance()` accepts `instanceType` and `region` but never estimates or tracks costs. No spending limit check. A rogue agent with credential access can spin up unlimited `t3.2xlarge` instances.

- **Location**: `cloud-instance-manager.ts:126-129`
- **Impact**: `t3.2xlarge` @ $0.33/hr × 100 instances = $33/hr unchecked.
- **Severity**: CRITICAL

### 52. Security Group Creation Race Condition

Multiple concurrent `launchInstance()` calls can trigger simultaneous security group creation. AWS may return "GroupAlreadyExists" on the second request, failing the launch. Created group is never cleaned up.

- **Location**: `cloud-instance-manager.ts:490-546`
- **Severity**: HIGH

### 53. Async IP Polling Race with Callers

Instance record is persisted with `public_ip = null`. `pollForPublicIp()` runs async. Callers checking `!record.publicIp` may fail even though IP appears seconds later.

- **Location**: `cloud-instance-manager.ts:206-227`
- **Severity**: HIGH

---

## GATEWAY DEPLOY POOL

### 54. Partial Deploy Across Hosting Accounts (No Rollback)

`deployToAll()` iterates hosting resources. If provider #2 fails, provider #1 is already deployed. No rollback of previous successes. Gateway runs old code on some providers.

- **Location**: `node/packages/node/src/core/gateway-deploy-pool.ts:70-130`
- **Severity**: HIGH

### 55. Stale Gateway Has No Failover

Health check marks gateways as `'stale'` but no automatic redeploy or switchover. If all gateways go stale, network has zero gateway with no remediation triggered.

- **Location**: `gateway-deploy-pool.ts:157-178`
- **Severity**: CRITICAL

### 56. Version Mismatch Across Providers

All providers deploy same commit hash, but if one times out mid-deploy, requests to different gateways get different code versions. No version verification on health check.

- **Location**: `gateway-deploy-pool.ts:98-119`
- **Severity**: MEDIUM

---

## DEPLOY PIPELINE

### 57. GitHub Push Succeeds but Pipeline Fails — Repo Left Dangling

If GitHub push (step 1) succeeds but finding deploy target (step 2) fails, repo is public on GitHub but project metadata is inconsistent. No cleanup — repo stays public forever.

- **Location**: `node/packages/node/src/core/deploy-pipeline.ts:84-164`
- **Severity**: HIGH

### 58. No Deploy Target Load Balancing

Selects first secure node matching `credentialAccess === true` (arbitrary order). No load balancing, no health check, no fallback to next-best candidate.

- **Location**: `deploy-pipeline.ts:205-250`
- **Severity**: MEDIUM

### 59. GitHub Push Timeout Creates Zombie Repos

If GitHub API call succeeds but HTTP response times out, repo is created but caller thinks it failed. Next call tries to recreate repo with same name → fails with "already exists".

- **Location**: `deploy-pipeline.ts:168-203`
- **Severity**: MEDIUM

---

## P2P STORAGE BACKEND (PROXY MODE)

### 60. Malicious Compute Peer Can Return Fake Data

All CRUD operations delegate to remote compute peer via `proxy()`. No data validation on returned values. No integrity check, no signature verification. A compromised peer can return fabricated records.

- **Location**: `node/packages/node/src/core/p2p-storage-backend.ts:49-78`
- **Severity**: CRITICAL

### 61. Peer Unavailability Blocks I/O for 30 Seconds

If no compute peers are connected, `proxy()` blocks for up to 30 seconds waiting. This blocks the entire node's request processing.

- **Location**: `p2p-storage-backend.ts:83-96`
- **Severity**: HIGH

### 62. Unhealthy Peer TTL Assumes Recovery Without Verification

Peer marked unhealthy for 30 seconds, then assumed recovered. No health confirmation after TTL expiry — corrupted peer data accepted without verification.

- **Location**: `p2p-storage-backend.ts:32-33, 137-145`
- **Severity**: HIGH

---

## NODE STARTUP SEQUENCE

### 63. No Error Handling in Init Cascade

`index.ts:290-292`: `await initKernel(this); await initCore(this); await initPlatform(this);` — no try-catch. If `network.start()` fails, node enters partially initialized zombie state.

- **Location**: `node/packages/node/src/index.ts:290-292`
- **Severity**: CRITICAL

### 64. API Server Starts Before Full Initialization

API starts at `init-platform.ts:921` before scheduler/engine are ready (line 1044). `GET /v1/health` returns `nodeHealth: 'healthy'` even if core systems haven't finished initializing.

- **Location**: `node/packages/node/src/init-platform.ts:921, 1044`
- **Severity**: CRITICAL

### 65. Tasks Created Locally but Never Broadcast

If network dies during init but TaskQueue is created, API can accept task creation requests. Tasks created locally but never broadcast to peers = inconsistent state.

- **Location**: `init-kernel.ts:107, 226`, `init-platform.ts:41-61`
- **Severity**: HIGH

---

## NODE SHUTDOWN

### 66. In-Flight P2P Requests Not Drained

`RequestReply` is just nulled during shutdown (`index.ts:1600`). No explicit cleanup of pending request handlers or timeouts. If a P2P request handler is executing, it may crash on null references.

- **Location**: `node/packages/node/src/index.ts:1600-1608`
- **Severity**: HIGH

### 67. Database Writes Not Fully Drained Before Ledger Close

`ledger.close()` is called last (line 1616) but governance/projectRegistry may have pending writes. No flush guarantee before close.

- **Location**: `index.ts:1549, 1588, 1616`
- **Severity**: HIGH

### 68. No Shutdown Timeout

`stop()` is async but has no timeout. If `apiServer.stop()` hangs, `network.stop()` never happens. Process can hang indefinitely.

- **Location**: `index.ts:1508-1620`
- **Severity**: HIGH

### 69. Intervals Not All Cleared — Race with Null Subsystems

`uptimeTimer` (init-platform.ts:1013-1015) may still fire after emissionWitness is set to null (line 1533), causing null reference crashes.

- **Location**: `init-platform.ts:1013-1015`, `index.ts:1533`
- **Severity**: MEDIUM

---

## HEALTH MONITOR

### 70. Health Monitor is Data-Only — Never Triggers Recovery

Comment at `monitor.ts:8-9`: "This subsystem is DATA-ONLY — it collects metrics and generates alerts but NEVER takes recovery actions." Recovery action table exists (lines 61-118) but is dead code — never executed.

- **Location**: `node/packages/node/src/kernel/monitor.ts:8-9, 61-118`
- **Severity**: CRITICAL

### 71. Health Metrics Not Accessible to Decision Makers

Metrics emitted via EventEmitter (`monitor.ts:349`) but no component subscribes. Node doesn't know its own health status; only external peers querying P2P health_check do.

- **Location**: `monitor.ts:349, 667-673`
- **Severity**: HIGH

### 72. Recovery Actions Defined but Never Executed

`setRecoveryConfig()` and `updateRecoveryActions()` exist but are dead code. Recovery config is persisted but never consulted or acted upon.

- **Location**: `monitor.ts:746-772`
- **Severity**: HIGH

---

## CAPABILITY REGISTRY

### 73. Capabilities Can Be Faked by Malicious Peers

Peers send CapabilityProfile via GossipSub. No validation of claimed capabilities. Registry stores whatever peers claim. Scheduler trusts `findCapableNodes()` blindly.

- **Location**: `node/packages/node/src/platform/capability-registry.ts:39-42, 56-75`
- **Severity**: CRITICAL

### 74. No Capability Verification Protocol

No challenge-response to prove a peer actually has claimed capabilities. Task sent to peer that claims `compute_cpu` but can't execute = wasted effort + timeout.

- **Location**: `capability-registry.ts` (no verification code)
- **Severity**: HIGH

### 75. 15-Minute Capability TTL Too Long

Peer broadcasts capabilities, then loses GPU at T=10min. Other nodes route GPU tasks to it until T=75min (15min after last broadcast). 65 minutes of wasted task attempts.

- **Location**: `capability-registry.ts:20`
- **Severity**: MEDIUM

### 76. Capability Broadcast Not Guaranteed in Small Networks

Initial capability broadcast is fire-and-forget. If GossipSub mesh doesn't form in small networks, peers don't receive capabilities. Scheduler can't route tasks to new peer.

- **Location**: `init-kernel.ts:561-580, 641-644`
- **Severity**: HIGH

---

## LEDGER INTERNALS & CRYPTO

### 77. Transaction ID Uses Math.random() in Ledger (Not randomBytes)

`transactions.ts:242` uses `Math.random()` for transaction ID nonce. Meanwhile `identity/hash.ts:15` correctly uses `randomBytes()`. Collision risk on concurrent transactions within same millisecond.

- **Location**: `node/packages/ledger/src/transactions.ts:242` vs `node/packages/identity/src/core/hash.ts:15`
- **Severity**: HIGH

### 78. SQLite Write Failure in Transaction Not Caught

`db.transaction()` callback runs without try-catch. If SQLite write fails (disk full, I/O error), better-sqlite3 rolls back, but caller returns `tx` object as if it succeeded. Balance changes lost.

- **Location**: `transactions.ts:55-68, 100-111, 124-148`
- **Severity**: HIGH

### 79. Proposal Signature Verification Falls Back to Zero Key

`crypto.ts:201-221`: If public key extraction from peerId fails, code falls back to `new Uint8Array(32)` (all zeros). Should return `false` immediately instead.

- **Location**: `node/packages/shared/src/crypto.ts:214`
- **Severity**: MEDIUM

---

## API ROUTE AUTHORIZATION

### 80. /admin/* Routes Have No Auth Checks

`POST /admin/shutdown`, `POST /admin/wipe-credentials`, `POST /admin/migrate-apps`, `POST /admin/cleanup-projects` — none require authentication. The `setupAuth()` hook exempts `/admin/*` from auth, treating them as public.

- **Location**: `node/packages/node/src/api/kernel-api.ts:74-202, 286-314`
- **Impact**: Anyone can shut down a node, wipe credentials, or delete projects.
- **Severity**: CRITICAL

### 81. Path Traversal in /apps/:appName/deploy

`file.path` from request body is joined directly without validation: `join(appDir, file.path)`. Attacker can supply `../../../../etc/passwd` and write anywhere on filesystem. The GET handler HAS path traversal protection but the POST handler does NOT.

- **Location**: `platform-api.ts:4103`
- **Severity**: CRITICAL

### 82. No File Size Limits on Upload

`POST /apps/:appName/deploy` accepts `body.files[].content` with no size check. Attacker can upload gigabyte-sized files.

- **Location**: `platform-api.ts:4095-4105`
- **Severity**: MEDIUM

### 83. No Upload File Type Validation

No MIME type validation, no extension whitelist. Attacker can upload `.exe`, `.sh`, `.bat` to hosted-apps directory.

- **Location**: `platform-api.ts:4095-4105`
- **Severity**: MEDIUM

### 84. Workspace Files Readable by Any Authenticated User

`GET /scheduler/tasks/:id/files/*` — any authenticated user can read any task's workspace files with just the taskId. No ownership check.

- **Location**: `kernel-api.ts:1758-1786`
- **Impact**: A user who knows another user's task ID can read all output files, logs, and secrets.
- **Severity**: HIGH

### 85. SSE Connections Unlimited Per IP

No per-IP connection limits on SSE endpoints. Attacker can open unlimited SSE connections, exhausting server memory. `sseClients` Set grows unbounded.

- **Location**: `kernel-api.ts:1396`, `api-server.ts:198`
- **Severity**: MEDIUM

### 86. SSE Emitter Memory Leak

`getOrCreateRemoteTaskEmitter(taskId)` caches emitters. When stream closes, listener is removed but emitter object may persist in cache indefinitely.

- **Location**: `kernel-api.ts:1961-1962`
- **Severity**: MEDIUM

---
---

# Full Summary (All Rounds)

| # | Issue | System | Severity |
|---|-------|--------|----------|
| 1 | No credential selection strategy | node | HIGH |
| 2 | maxUsagePerDay not enforced | node | HIGH |
| 3 | No credential failover | node | MEDIUM |
| 4 | MongoDB URL hardcoded | node | LOW |
| 5 | pricePerUnit never charged | node | MEDIUM |
| 6 | grantedTo never enforced on decrypt | node | HIGH |
| 7 | Governance proposals pass but never execute | node | CRITICAL |
| 8 | Content report 'reviewing' unreachable | node | MEDIUM |
| 9 | ~~enableCouncil config flag ignored~~ RESOLVED | node | -- |
| 10 | DeployPipeline events unhandled | node | LOW |
| 11 | Proposal 'revision_requested' dead-end | node | LOW |
| 12 | findBestBuilder() no scoring | node | MEDIUM |
| 13 | Permission checks never called | code | HIGH |
| 14 | Risk tier overrides never passed | code | MEDIUM |
| 15 | Token budget limits not enforced | code | HIGH |
| 16 | Task status "failed"/"rolled_back" unreachable | code | MEDIUM |
| 17 | Agent status "failed"/"terminated" unreachable | code | MEDIUM |
| 18 | Board task progress is write-only | code | MEDIUM |
| 19 | Orchestrator config options all ignored | code | LOW |
| 20 | lesson:new event never emitted | code | LOW |
| 21 | Task assignment doesn't drive behavior | code | MEDIUM |
| 22 | Vote weighting implemented but never called | node | HIGH |
| 23 | No reputation decay | node | MEDIUM |
| 24 | Reputation doesn't affect task assignment | node | MEDIUM |
| 25 | DAILY_EMISSION_CAP defined but never enforced | node | CRITICAL |
| 26 | Emission witness doesn't validate work proof | node | HIGH |
| 27 | Bootstrap auto-approve bypasses witness quorum | node | HIGH |
| 28 | Balances can go negative during sync | node | MEDIUM |
| 29 | Quarantine only blocks message ingress | node | HIGH |
| 30 | Quarantine auto-releases after 1 hour | node | HIGH |
| 31 | Guardrail violations not auto-rolled-back | node | HIGH |
| 32 | Tripwire system is just a label | node | MEDIUM |
| 33 | 17 message types silently dropped | node | MEDIUM |
| 34 | Signature verification skipped for unknown peers | node | CRITICAL |
| 35 | Peer spoofing via placeholder public keys | node | CRITICAL |
| 36 | JWT tokens cannot be revoked | node | HIGH |
| 37 | No user ban mechanism | node | CRITICAL |
| 38 | No login rate limiting | node | HIGH |
| 39 | Double-spending across simultaneous nodes | node | CRITICAL |
| 40 | Malicious peers can broadcast fake balances | node | CRITICAL |
| 41 | Total supply double-counting | node | HIGH |
| 42 | No timeout on engine execution | node | CRITICAL |
| 43 | Budget exhaustion returns silent failure | node | HIGH |
| 44 | Tasks stuck in in_progress never expire | node | CRITICAL |
| 45 | Concurrent poll() calls | node | HIGH |
| 46 | No task queue capacity limit | node | MEDIUM |
| 47 | Content safety reviews advisory only | node | HIGH |
| 48 | No task cleanup on project archive | node | MEDIUM |
| 49 | aiSafetyScore field never used | node | LOW |
| 50 | Orphan EC2 instances on provisioning failure | node | CRITICAL |
| 51 | No cost tracking on instance provisioning | node | CRITICAL |
| 52 | Security group creation race condition | node | HIGH |
| 53 | Async IP polling race with callers | node | HIGH |
| 54 | Partial deploy across hosts (no rollback) | node | HIGH |
| 55 | Stale gateway no failover | node | CRITICAL |
| 56 | Version mismatch across providers | node | MEDIUM |
| 57 | GitHub push succeeds but pipeline fails — dangling repo | node | HIGH |
| 58 | No deploy target load balancing | node | MEDIUM |
| 59 | GitHub push timeout creates zombie repos | node | MEDIUM |
| 60 | P2P storage proxy trusts compute peers blindly | node | CRITICAL |
| 61 | Peer unavailability blocks I/O for 30s | node | HIGH |
| 62 | Unhealthy peer TTL assumes recovery | node | HIGH |
| 63 | No error handling in init cascade | node | CRITICAL |
| 64 | API serves before full init — false "healthy" | node | CRITICAL |
| 65 | Tasks created locally but never broadcast | node | HIGH |
| 66 | In-flight P2P requests not drained on shutdown | node | HIGH |
| 67 | Database writes not flushed before ledger close | node | HIGH |
| 68 | No shutdown timeout — process hangs forever | node | HIGH |
| 69 | Intervals race with null subsystems on shutdown | node | MEDIUM |
| 70 | Health monitor never triggers recovery | node | CRITICAL |
| 71 | Health metrics not accessible to decision makers | node | HIGH |
| 72 | Recovery actions defined but never executed | node | HIGH |
| 73 | Capabilities faked by malicious peers | node | CRITICAL |
| 74 | No capability verification protocol | node | HIGH |
| 75 | 15-minute capability TTL too long | node | MEDIUM |
| 76 | Capability broadcast not guaranteed | node | HIGH |
| 77 | Transaction ID uses Math.random() not randomBytes() | node | HIGH |
| 78 | SQLite write failure in transaction not caught | node | HIGH |
| 79 | Proposal signature falls back to zero key | node | MEDIUM |
| 80 | /admin/* routes have no auth | node | CRITICAL |
| 81 | Path traversal in /apps/:appName/deploy | node | CRITICAL |
| 82 | No file size limits on upload | node | MEDIUM |
| 83 | No upload file type validation | node | MEDIUM |
| 84 | Workspace files readable by any authenticated user | node | HIGH |
| 85 | SSE connections unlimited per IP | node | MEDIUM |
| 86 | SSE emitter memory leak | node | MEDIUM |

**Grand totals: 19 CRITICAL, 37 HIGH, 22 MEDIUM, 8 LOW — 86 issues**
