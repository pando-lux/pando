---
id: local-capability-store
type: service
domain: resources
entry: packages/node/src/platform/local-capability-store.ts
depends_on: []
depended_by: [capability-registry, capability-detector, api-server, tui]
exposes:
  - setDetected(capabilities) — write full detected capability list (never broadcast)
  - has(capability) — check if capability is locally available (always, ignores sharing)
  - getShared() — list of capabilities user has opted in to share
  - isSharing(capability) — check if a specific capability is being shared
  - isShareCompute() — check if node accepts network compute task requests
  - setShared(capability) — opt in to sharing a capability (returns false if not detected)
  - unsetShared(capability) — opt out of sharing a capability
  - getData() — raw LocalCapabilityData (for API)
rules: []
last_verified: 2026-02-26
---

# Local Capability Store

## What It Does
Persists the local node's full detected capabilities and the user's sharing preferences at `~/.pando/local-capabilities.json`. **Never broadcast to peers.** Peer profiles only reflect what the user explicitly opted in to share.

This is the core of the three-tier resource model introduced in Phase 96:

```
Tier 0: Local Private (detected, never broadcast)
Tier 1: Network Shared  (detected + user opted in)
Tier 2: Group Scoped    (future)
```

**Detection ≠ Sharing.** The node always knows everything it has locally (for its own tasks). Peers only know what you chose to share.

## How It Works

### Storage
Persists at `~/.pando/local-capabilities.json` as:
```json
{
  "detectedAt": 1740000000000,
  "capabilities": ["claude-code", "docker", "python"],
  "sharedCapabilities": [],
  "shareCompute": false
}
```

`capabilities` = full detected list (what the machine actually has).
`sharedCapabilities` = subset user opted in to share (empty by default).
`shareCompute` = `true` when user runs `/contribute claude-code` — node will accept `claude_task` P2P requests.

### `setDetected(capabilities)`
Called at startup after `CapabilityDetector.detectCapabilities()`. Writes the full detected list. Automatically prunes `sharedCapabilities` entries that are no longer detected (e.g., Claude Code uninstalled).

### `has(capability)`
Used by `CapabilityRegistry.canExecuteLocally()`. Returns true if the capability is in the detected list. Does NOT check sharing preferences — own tasks always work.

### `setShared(capability)` / `unsetShared(capability)`
Called by TUI `/contribute <service>` and `/revoke <service>`. After calling, `PandoNode.rebuildCapabilityProfile()` must be called to rebroadcast the updated profile.

`setShared` returns `false` if the capability isn't detected (prevents contributing something you don't have).

## shareCompute Flag

`shareCompute: true` means:
- The broadcast `CapabilityProfile` sets `compute_cpu: true` (peers see you as capable)
- The broadcast `CapabilityProfile` sets `shareCompute: true` (peers know you accept task requests)
- `PandoNode` accepts `claude_task` P2P requests from other nodes

`shareCompute: false` (default):
- `compute_cpu: false` in broadcast profile (peers don't route to you)
- `claude_task` handler returns error: "This node is not sharing compute"
- The node can still use Claude Code for its OWN tasks

## TUI Integration

| Command | Effect |
|---|---|
| `/contribute claude-code` | `setShared('claude-code')` → `rebuildCapabilityProfile()` |
| `/revoke claude-code` | `unsetShared('claude-code')` → `rebuildCapabilityProfile()` |

Peers stop seeing you as compute-capable within 15 minutes (CapabilityRegistry TTL).

## API

`GET /capabilities` returns the local and shared sections:
```json
{
  "local": {
    "capabilities": ["claude-code", "docker"],
    "detectedAt": 1740000000000
  },
  "shared": {
    "capabilities": [],
    "shareCompute": false
  }
}
```

## Why This Exists

Before Phase 96, `capability-detector.ts` auto-detected Claude Code and immediately set `compute_cpu: true` in the broadcast profile. This had two problems:
1. Users never opted in — their Claude API quota was implicitly shared with strangers
2. `canExecuteLocally()` read the broadcast profile — if user didn't want to share, own tasks would also fail

Phase 96 separates detection from sharing. The store is the single source of truth for both.

## Key Files
- `packages/node/src/platform/local-capability-store.ts` — LocalCapabilityStore class
- `packages/node/src/platform/capability-detector.ts` — calls `localCapStore?.isSharing()` instead of raw detect
- `packages/node/src/platform/capability-registry.ts` — `canExecuteLocally()` uses `has()` from this store
- `packages/node/src/index.ts` — initializes store, wires to registry, exposes `rebuildCapabilityProfile()`
- `packages/node/src/tui.ts` — `/contribute claude-code` and `/revoke claude-code` handlers
