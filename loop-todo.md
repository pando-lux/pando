# CEO Loop — Standing Orders

> These instructions apply whenever the founder is away. You are the CEO. You have full technical authority.

## Context

- You already know the BIBLE (`BIBLE.md` at repo root). Read it + `docs/COUNCIL-ROADMAP.md` on every session start.
- The founder is asleep or away. Do not wait for approval — decide and execute.

---

## Priority 0: Finish Pending Roadmap Work

Complete these remaining roadmap items before anything else:

### Roadmap TODO (from COUNCIL-ROADMAP.md)
- **Phase 6.2+**: Cross-node team migration + graceful degradation
  - Test: team orphaned on one node → another node claims it → lead resumes with board context
  - Test: Claude Code CLI not available → agents don't crash, log CRITICAL
  - Test: Team DB corrupted → recreate from template, log what was lost
  - Test: Saved CLI session stale → fresh start, log warning
- **Phase 8**: Gateway integration (full dashboard)
  - Model selection per team from gateway UI
  - Team creation from gateway
  - Aggregate team dashboard across all nodes
- **E2E Test Fix**: Pipeline 4 times out (engine build takes >3min) — make test resilient to slow engines

### Pending Code Issues
- Pipeline 4 E2E test: chat tier classification returns "simple" instead of "complex" for build requests when doorman doesn't have engine context. Investigate doorman classification logic.
- Commit the E2E test `beforeAll` health-check fix (already in working tree)

---

## Priority 1: Fix Any Other Pending Tasks

- Check for broken builds, failing tests, or known issues.
- `npm run build` must pass. Always verify before committing.
- Fix root causes, not symptoms.

---

## Priority 2: PandoTeams Web UI Testing (CRITICAL)

The pando-teams web UI (port 4873) has a "Network" tab that shows teams from pando-node.

### What to Test (as a real user would)
- **Navigate to Network tab** — does it show the pando-infra team?
- **Team card details** — agent count, task count, cost, governance badge — all correct?
- **Click a team** — does it expand to show agents?
- **Click an agent** — does the detail panel show?
  - Model badge (purple pill) visible?
  - Conversation history loads? Messages role-colored (blue=assistant, green=user)?
  - Per-agent cost breakdown (Lux + tokens) accurate?
- **Board tasks** — are they listed? Do they show correct status?
- **Auto-refresh** — does the dashboard update every 30s without manual reload?
- **"Not connected" state** — what happens if pando-node is down?
- **Council visibility** — since council runs on this Windows node (only node with pando-teams), we should see the 3 council agents (lead + observer + QA) working live

### How to Test
Use Playwright with headed browser (or the MCP browser tools) to navigate to `http://localhost:4873` and interact with the UI. Validate real data, not just page loads.

---

## Priority 3: Council / Team Live Testing

- The council (pando-infra team) runs on the Windows node.
- Verify agents are running and visible via API AND web UI.
- Test the full flow:
  1. Submit a task to the council board (`POST /v1/teams/pando-infra/board`)
  2. Watch the lead pick it up (poll board for status changes)
  3. Verify the lead spawns workers if needed
  4. Verify task moves through statuses: pending → in-progress → done
  5. Check agent messages show the work being done
- Test cross-node scenarios:
  - Governance proposals created on Windows → received on EC2 nodes
  - Peer exchange works → all 3 nodes see each other
  - Team metadata synced via GossipSub

---

## Priority 4: Logical E2E Testing (NOT Static Smoke Tests)

- Run **live, logical, human-style testing** using Playwright.
- Do NOT just check if pages load or APIs return 200.
- Test what a **real user expects to happen**:
  - Does the full E2E pipeline work autonomously? (chat → project → build → deploy → marketplace)
  - Can a user submit a request and see it flow through the system?
  - Are there missing features or broken flows that a user would notice?
  - Does the UI show the right data? Are agents visible? Is cost tracking accurate?
  - Do board tasks update correctly? Can you see agent conversations?

---

## Priority 5: Keep BIBLE.md Updated

- After any major changes, update BIBLE.md so other agents joining the project always understand:
  - Main architecture and how things flow
  - Main features of all modules (things they can't just find by reading code)
  - Key decisions and why they were made
  - What works, what doesn't, what's in progress

---

## Priority 6: Find and Fix Logic Issues

- Think like a human user. What would they try to do? What would confuse them?
- Look for:
  - Missing error handling in user-facing flows
  - Inconsistent state (e.g., UI says one thing, API returns another)
  - Race conditions in async operations
  - Edge cases in chat routing, project creation, deployment
  - Security gaps (auth bypass, input validation)
  - Memory leaks or resource cleanup issues

---

## Priority 7: Continuous Improvement

- If all work is done, find more scenarios to test.
- Keep improving what you can to make the system 100% as per the overall plan in BIBLE.md.
- Focus on making all logic and codebase strong.
- Test again and again — find edge cases, fix them, verify the fix.

---

## Logging and Git

- Log all tests and work done in `work-done.md` at repo root.
- Git push after any major updates. You decide when — you're the CEO.
- Commit messages should be clear and descriptive.

## Rules

- Don't worry about launching sub-agents or using credits. Use whatever resources you need.
- Don't do superficial smoke tests. Every test must validate real logic.
- Don't wait for permission. Decide and act.
- Keep going until told to stop.
