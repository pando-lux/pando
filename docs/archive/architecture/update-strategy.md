# Safe Update Strategy

## The Problem

Pando is a decentralized network. There's no central server to deploy to — every user runs their own node. A bad update can't be rolled back from our side. If a breaking change ships and nodes restart, the entire network could go down with no way to push a fix.

This doc covers how we ship updates without ever killing the network.

## Core Principle

**The network must never fully die.** Old nodes must keep working even when new nodes exist. New nodes must be able to talk to old nodes. A bad update must not be able to brick a node permanently.

## 1. Protocol Versioning

Every P2P message already has a structure (`PandoMessage`). We add a `version` field:

```typescript
interface PandoMessage {
  version: number;      // protocol version (1, 2, 3...)
  type: MessageType;
  from: string;
  timestamp: number;
  payload: unknown;
  signature?: string;
}
```

**Rules:**
- New fields are always **additive**. Old nodes ignore fields they don't understand.
- Removing or renaming a field requires a new protocol version.
- Nodes include their supported version range in `PEER_ANNOUNCE` messages.
- When two nodes connect, they negotiate the highest shared version.
- A node running protocol v3 can still talk to a v2 node using v2 messages.

**What this means in practice:**
- We can add new message types freely — old nodes just ignore them.
- We can add new fields to existing payloads — old nodes skip unknown keys.
- We can NOT change the meaning of existing fields or remove them.
- If we need to fundamentally change something, bump the version and support both.

## 2. Semantic Versioning for Node Releases

```
v0.3.0  →  MAJOR.MINOR.PATCH
```

- **PATCH** (0.3.0 → 0.3.1): Bug fixes, no protocol changes. Safe to update anytime.
- **MINOR** (0.3.0 → 0.4.0): New features, new message types, additive changes. Backward compatible. Old nodes still work, just don't have the new feature.
- **MAJOR** (0.x → 1.0): Breaking protocol change. Requires coordination (see section 5).

For a long time we should stay on 0.x and avoid major bumps. Additive design means we rarely need them.

## 3. Auto-Update with Rollback

Nodes should be able to update themselves, but with a safety net.

### Update Flow:

```
1. Node checks for new version (periodic, or on startup)
2. Downloads new version to staging directory
3. Verifies checksum / signature
4. Stops current node gracefully
5. Starts new version
6. Health check: is the node running after 30 seconds?
   - YES → update successful, delete old version
   - NO  → rollback to previous version, start it, report failure
```

### Implementation:

```
~/.pando/
  versions/
    0.3.0/          ← current (symlinked)
    0.3.1/          ← downloaded, staging
  current -> 0.3.0  ← symlink to active version
  rollback -> 0.2.9 ← symlink to last known good
```

- The node binary is always launched via the `current` symlink.
- On successful update, `rollback` points to the old `current`, `current` points to new.
- On failed update, `current` is restored to `rollback`.
- Always keep at least 2 versions on disk.

### Health Check Criteria:

A node is "healthy" if after 30 seconds:
- The process is still running (didn't crash)
- The HTTP API responds to `/status`
- The P2P listener is bound to a port

If any of these fail, rollback.

## 4. Update Channels

Not all nodes should update at the same time.

```
--update-channel stable    (default — updates after canary is verified)
--update-channel canary    (early adopter — gets updates first)
--update-channel manual    (no auto-update — user manages versions)
```

### Rollout timeline:

```
Day 0:  New version released
Day 0:  Canary nodes auto-update
Day 1-3: Monitor canary nodes for crashes, sync issues, ledger divergence
Day 3:  If healthy → promote to stable
Day 3:  Stable nodes auto-update
```

For us (Jai's Mac and Windows nodes), we run canary. We're always the first to test.

### How monitoring works:

- Canary nodes report version + uptime to a simple endpoint (opt-in telemetry)
- If canary nodes show high crash rates or sync failures, the stable release is held
- This can be as simple as a GitHub release marked "pre-release" vs "latest"

## 5. Breaking Changes (Major Versions)

Sometimes we genuinely need to break backward compatibility. Examples:
- Changing the ledger schema
- Changing the transaction format
- Changing the identity system

### Strategy: Dual-Protocol Transition

```
Phase 1 (v0.9):  Ship new code that understands BOTH old and new protocol.
                  Default: still uses old protocol.

Phase 2 (v0.10): Switch default to new protocol.
                  Still understands old protocol from peers.
                  Old nodes can still connect.

Phase 3 (v1.0):  Drop old protocol support.
                  Only after >90% of network is on v0.10+.
```

This means breaking changes take 3 releases minimum. That's intentional. The network should never have a "flag day" where everyone must update simultaneously.

### Ledger Migrations:

If the SQLite schema changes:
- New version detects old schema on startup
- Runs migration automatically (ALTER TABLE, new indexes, etc.)
- Migration is idempotent (can run multiple times safely)
- If migration fails, node refuses to start (doesn't corrupt data)
- User can manually rollback to old version + old schema

## 6. What We Build Now vs Later

### Now (before public launch):
- [ ] Add `version` field to `PandoMessage` (set to 1)
- [ ] Nodes log their version on startup and in `/status` API
- [ ] Nodes ignore unknown message types gracefully (already do this mostly)

### Before 100 nodes:
- [ ] Auto-update mechanism (download, verify, swap, health check)
- [ ] Update channels (canary/stable/manual)
- [ ] Version negotiation on peer connect

### Before 1000 nodes:
- [ ] Opt-in telemetry for crash/sync monitoring
- [ ] Dual-protocol support for major version transitions
- [ ] Signed releases (Ed25519 signature on release artifacts)

## 7. Emergency Kill Switch — What We Don't Have

We intentionally do NOT have a way to force-update or force-stop nodes remotely. That would be a central point of control, which violates the architecture.

If a catastrophic bug ships:
1. We update the canary/stable release immediately
2. Nodes auto-update on next check (or restart)
3. We post on GitHub, reach out to known node operators
4. Worst case: nodes with the bad version crash and auto-rollback

The network degrades gracefully. It doesn't die. Old nodes keep serving. New nodes with the fix come back online. The ledger state is preserved in SQLite on each node — nothing is lost even if a node crashes.

## Summary

| Scenario | What happens |
|---|---|
| Minor bug fix | Patch release, canary → stable rollout, zero downtime |
| New feature | Minor release, additive protocol change, old nodes unaffected |
| Bad update | Node crashes within 30s → auto-rollback to previous version |
| Breaking change | 3-phase dual-protocol transition over multiple releases |
| All nodes crash | Each auto-rollbacks independently, network recovers |
| We disappear | Nodes keep running on last version forever. It's open source. |
