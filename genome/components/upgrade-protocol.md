---
id: upgrade-protocol
type: service
domain: evolution
entry: packages/node/src/core/upgrade-protocol.ts
depends_on: [governance, guardrails, network]
depended_by: []
exposes:
  - pullAndUpgrade(commitHash?) — git pull, verify hash, build, restart
  - createUpgradeProposal(description) — propose upgrade via governance
  - broadcastUpgradeNotification(commitHash, description) — notify peers via GossipSub
  - checkUpgradeQuorum(proposalId) — check voting quorum
  - executeRollback(targetVersion?) — emergency rollback
  - proposeEmergencyRollback(reason) — fast-track governance rollback
  - pinVersion(version) / unpinVersion() — pin/unpin to a specific version
  - getProposal(id) / getHistory() / getUpgradeStatus() — query state
  - startCatchupTimer(pullFn) — periodic scan for missed upgrades (5min interval)
  - hasApplied(proposalId) — dedup check
  - findByGovernanceId(governanceId) — lookup by governance ID
  - TOPIC_UPGRADES — GossipSub topic ('pando/upgrades')
rules: []
last_verified: 2026-02-25
---

# Upgrade Protocol

## What It Does
Simple self-upgrade for the Pando network. Governance approves → commit hash broadcasts via GossipSub → all nodes `git pull` → verify hash → build → restart.

## How It Works
- `createUpgradeProposal(description)` creates a governance proposal with the current commit hash. No diffs, no patches. Governance votes on the description + hash.
- When governance approves (auto-approve in dev mode ≤8 peers, or supermajority vote in live mode), `onUpgradeApproved` fires.
- The proposing node calls `pullAndUpgrade()` locally, then broadcasts a `upgrade_available` notification via GossipSub `pando/upgrades` topic.
- All receiving nodes call `pullAndUpgrade(commitHash)`: `git fetch origin master` → verify `origin/master` matches the governance-approved hash → `git reset --hard origin/master` → `npm run build` → restart (exit code 75).
- **Catch-up timer**: Every node independently scans governance every 5 minutes for passed upgrade proposals it hasn't applied. If the proposer goes offline before broadcasting, peers still discover and apply the upgrade on their own. No single point of failure.
- If the build fails, the node rolls back to the previous commit automatically.
- Version pinning (`pinVersion`/`unpinVersion`) blocks auto-upgrades.
- Emergency rollback via `executeRollback()` restores from backup or `git checkout HEAD -- packages/`.

## Gotchas
- **Phase 82:** Replaced the Phase 73 patch-distribution system (base64 diffs via GossipSub, `git apply`, canary monitoring) with simple `git pull` + hash verification. All canary, rollout, and patch code deleted.
- `POST /upgrade` endpoint in api-server.ts does the same git-pull logic independently — useful for manual upgrades without governance.
- Hash verification is optional: if no commit hash in the governance payload, nodes just pull latest.
- Build timeout is 180 seconds. If your build takes longer, the upgrade will fail.
- **Process supervisors**: Lightsail uses PM2, EC2 uses systemd (`pando-node.service`). Both auto-restart on exit code 75. The `pando` user on EC2 has shell `/bin/false` (security) which prevents PM2 daemon — hence systemd.

## Key Files
- `packages/node/src/upgrade-protocol.ts` — UpgradeProtocol class
- `packages/node/src/governance.ts` — governance proposals/voting, auto-approve threshold
- `packages/node/src/index.ts` — GossipSub subscription + governance callback wiring
- `packages/node/src/api-server.ts` — `/upgrade`, `/upgrade/propose`, `/upgrade/status`, etc.
