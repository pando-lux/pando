# Self-Healing Architecture

## Problem Statement

The current system requires CEO (human or AI) intervention for:
- Verifying agent code compiles
- Deploying code to peer machines
- Enabling agents after restarts
- Cleaning up stale data (inbox, proposals, branches)
- Resolving merge conflicts
- Fixing broken agent output

This doesn't scale. With 2 agents, manual management is barely tolerable. With 100, it's impossible. With 1000, the network fails.

## Design Principle

**Every problem the CEO has to fix manually represents an architecture failure.** The system must handle it automatically.

## Implemented Gates

### Build Gate (agent-engine.ts)
- **What**: `npm run build` runs automatically after agent commits, before merge to primary.
- **If fails**: Agent's commits are discarded. Activity record logged with "BUILD FAILED." Agent's work is rejected.
- **Impact**: No broken code reaches master. Eliminates ~60% of CEO manual intervention.

### Inbox Pruning (agent-memory.ts)
- **What**: Before each wake cycle, inbox is pruned to the 10 most recent messages. Older messages archived to `inbox-archive.md`.
- **Impact**: Agents don't waste context on stale messages. Prevents inbox bloat.

### Auto-Start Agent (tui.ts, cli.ts)
- **What**: `--agent` CLI flag auto-enables the agent engine on node startup.
- **Impact**: No manual `POST /agent/enable` after restarts. Start scripts use this by default.

### Wake Log Persistence (agent-engine.ts)
- **What**: `wakeUpCount` persisted in `config.json` and recovered from existing log files on startup. Log rotation sorts by file modification time instead of alphabetically.
- **If restart**: Cycle numbers continue from where they left off (no resets, no duplicate numbers).
- **Impact**: No lost agent logs. No log rotation bugs. Full audit trail across restarts.

### Disable Guard (api-server.ts)
- **What**: `POST /agent/disable` returns 409 when agent is currently awake.
- **Why**: The QA agent was calling the disable endpoint during its testing cycle, killing itself mid-work.
- **Impact**: Agents cannot accidentally disable themselves. No more mysterious mid-cycle deaths.

### Error Sanitization (agent-engine.ts, api-server.ts)
- **What**: `approve()` returns clean error messages instead of raw git stderr. Comment endpoint validates proposal exists (404 if not).
- **Impact**: No internal details leaked. Cleaner API contract. No orphan comments in database.

## Planned Gates (Priority Order)

### P0: Post-Merge Build Verification
- After merge to primary, run `npm run build` again.
- If fails (merge introduced incompatibility), auto-revert: `git reset --hard HEAD~1`.
- Log the revert as an activity record.

### P0: Auto-Deploy Pipeline
**Problem**: Code changes require manual SSH + pull + build + restart on each peer.

**Solution**: Node watches for master changes on a schedule:
```
Every 5 minutes:
1. git fetch origin master
2. If local master != origin/master:
   a. git pull --rebase
   b. npm run build
   c. If build passes: schedule graceful restart
   d. If build fails: stay on current version, log warning
```

**Implementation**: Add `AutoUpdater` class to node. Configurable via `--auto-update` flag.

**Graceful restart**: Save state, close connections, re-exec process. Peers reconnect automatically (libp2p handles this).

### P0: Gateway Console Overhaul
**Problem**: The gateway UI (localhost:3222) is the only human window into Pando. Currently it's messy, shows raw markdown, only displays the local agent, and has no real-time log streaming. The founder can't see what agents are doing.

**Solution**: Full redesign of the console page as an Operations Dashboard:
- Multi-agent view: show ALL agents from ALL nodes
- Real-time log streaming via SSE
- Structured state display (parse markdown into sections)
- Prominent approve/reject for pending work
- Activity timeline across all agents

**Spec**: `docs/architecture/gateway-redesign.md`

**Implementation**: Multi-cycle builder assignment. Phase 1: component split + agent cards. Phase 2: SSE log streaming + multi-node. Phase 3: polish.

### P0: CEO Watchdog (Co-CEO)
**Problem**: The CEO agent could fail silently — stuck in a loop, crashing, not updating state. Nobody would notice until the builder idles out.

**Solution**: Watchdog timer pattern in the gateway:
1. Gateway checks CEO's state.md last-modified timestamp every 60s
2. If CEO hasn't updated state.md in > 10 minutes (5+ cycles), show WARNING in UI
3. If > 30 minutes, show CRITICAL alert with "CEO appears unresponsive"
4. Future: co-CEO agent on another node monitors and can restart

**Phase 1** (gateway-side, no agent needed):
- Add last-modified timestamp check to `/api/agent/status` response
- Gateway console shows CEO health indicator (green/yellow/red)
- Toast notification when CEO goes silent

**Phase 2** (full co-CEO agent):
- Second agent role: `role: co-ceo` in goals.md
- Runs on a different node than the CEO
- Simple workflow: check CEO state.md, verify updates, alert if stale
- Can call `/agent/enable` on CEO's node if agent died

### P1: File Ownership Registry
**Problem**: Two agents editing the same file creates merge conflicts and reverted work.

**Solution**: Before starting work, agents claim files via governance:
```
POST /agent/claim-files
{ files: ["packages/gateway/app/console/page.tsx"], agentId: "...", duration: 900 }
```

The system maintains a lock registry. If another agent tries to claim the same file, it gets rejected. Locks expire after the specified duration.

**Enforcement**: `prepareAgentBranch()` checks the lock registry. If another agent holds a lock on files the agent wants to edit, the agent skips the cycle.

### P1: Automated Test Gate
**Problem**: Code that compiles can still be broken (runtime errors, UI crashes). Build gate catches compilation errors but not logic errors.

**Solution**: After build gate passes, run Playwright E2E:
```
1. Start gateway dev server (if not running)
2. Run: node ~/Desktop/pando_admin/tests/test-console.mjs
3. If tests regress (fewer passes than baseline): reject merge
4. If tests pass: proceed
```

**Baseline tracking**: Store last known good test count in `~/.pando/agent/test-baseline.json`. Regressions = fewer passes than baseline.

### P2: Auto-Rollback
**Problem**: Even with gates, subtle breakage can slip through (e.g., API returns wrong data, UI renders incorrectly in edge cases).

**Solution**: Health check loop:
```
Every 60 seconds after deploy:
1. Hit /status → expect 200 + valid JSON
2. Hit /agent/status → expect 200
3. Hit /governance/proposals → expect 200 + array
4. If 3 consecutive failures: rollback to previous commit
```

Store the last known good commit hash. Rollback = `git reset --hard <last-good>` + rebuild + restart.

### P2: Agent Scoring
**Problem**: Some agents produce consistently good work, others waste cycles. No visibility into agent quality.

**Solution**: Track per-agent metrics:
```typescript
interface AgentScore {
  agentId: string;
  totalCycles: number;
  buildPasses: number;
  buildFailures: number;
  testsPassRate: number;
  mergeConflicts: number;
  revertedCommits: number;
  usefulCommits: number; // commits that stayed on master > 24h without revert
  score: number; // 0-100 composite
}
```

Scoring affects:
- Wake interval (high-scoring agents wake more often)
- Assignment priority (high-scoring agents get critical work)
- Trust level (high-scoring agents can auto-approve in live mode)

### P3: Multi-CEO Consensus
**Problem**: Single CEO is a bottleneck and single point of failure.

**Solution**: Multiple CEO agents, decisions via consensus:
- Each CEO proposes actions (assignments, approvals, strategy changes)
- Other CEOs vote on proposals
- Majority wins (configurable threshold)
- Any LLM can run as a CEO agent if it passes a trust threshold

**Consensus mechanism**:
```
1. CEO-A proposes: "Assign agent-X to fix bug-Y"
2. CEO-B, CEO-C evaluate the proposal
3. 2/3 majority → action executed
4. If no majority within timeout → proposal expires
```

This is the governance system applied to CEO operations. The infrastructure already exists (proposals, votes, decisions). It just needs to be applied at the CEO level.

## Architecture Diagram

```
User Suggestions
       ↓
   CEO Agent(s)  ←→  Consensus (future)
       ↓
   Assignments
       ↓
┌──────────────────┐
│  Agent Engine    │
│                  │
│  1. Wake agent   │
│  2. Agent works  │
│  3. Auto-commit  │
│  4. BUILD GATE   │ ← Rejects broken code
│  5. Merge        │
│  6. TEST GATE    │ ← Rejects regressions (future)
│  7. Auto-deploy  │ ← Pushes to peers (future)
│  8. Health check │ ← Rollback if broken (future)
│  9. Score update │ ← Track quality (future)
└──────────────────┘
```

## Success Metrics

The system is self-healing when:
- CEO never manually checks if code compiles (build gate)
- CEO never manually deploys to peers (auto-deploy)
- CEO never manually enables agents (--agent flag)
- CEO never manually cleans up stale data (inbox pruning, branch cleanup)
- CEO never manually reverts broken code (auto-rollback)
- CEO only does: strategic decisions, agent assignments, architecture improvements

## Current State

| Gate | Status | Impact |
|------|--------|--------|
| Build gate | DONE | No broken code on master |
| Inbox pruning | DONE | No stale message bloat |
| Auto-start agent | DONE | No manual enable after restart |
| Wake log persistence | DONE | Logs survive restarts, no lost data |
| Disable guard | DONE | Agent can't kill itself mid-cycle |
| Error sanitization | DONE | No internal details leaked via API |
| Auto-deploy (AutoUpdater) | DONE | Nodes self-update from origin/master |
| CEO Agent | DONE | Autonomous CEO observes, assigns, approves |
| Post-merge build check | TODO | Catch merge-induced breakage |
| Gateway console overhaul | TODO | Real-time agent visibility for humans |
| CEO watchdog (co-CEO) | TODO | Monitor CEO health, alert if silent |
| File ownership | TODO | Prevent agent conflicts |
| Test gate | TODO | Catch runtime errors |
| Auto-rollback | TODO | Self-recover from broken deploys |
| Agent scoring | TODO | Quality-aware scheduling |
| Multi-CEO consensus | TODO | No single point of failure |
