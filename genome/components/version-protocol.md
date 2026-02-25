---
id: version-protocol
type: service
domain: evolution
entry: packages/node/src/version-protocol.ts
depends_on: []
depended_by: [pipeline-runner, pando-node]
exposes:
  - getVersionInfo() — full VersionInfo (node version, protocol version, capabilities, min compatible, build timestamp)
  - isCompatible(remoteProtocolVersion, remoteMinCompatible?) — check if a remote node version is compatible
  - canClaimTask(requirement) — check if this node meets a task's version and feature requirements
  - getStatusExtension() — lightweight version metadata for peer announcements
  - checkUpgradeNeeded(latestVersion) — compare local vs latest version, return severity (none/patch/minor/major)
rules: []
last_verified: 2026-02-18
---

# Version Protocol

## What It Does
Manages protocol versioning across distributed Pando nodes. Provides version compatibility checks between peers, task eligibility based on node capabilities, and upgrade severity detection for rolling deployments.

## How It Works
- Maintains current node version (0.1.0), protocol version (1.0.0), and minimum compatible version (1.0.0) as compile-time constants.
- Default capabilities advertised by every node: `messaging`, `ledger-sync`, `governance`, `task-sync`, `code-pipeline` (all v1.0.0, all enabled).
- `isCompatible()` enforces: major versions must match, remote must be >= our minimum, and if the remote declares a minimum, we must meet it.
- `canClaimTask()` checks that node version >= task's minimum version AND all required features are present as enabled capabilities.
- `getStatusExtension()` returns a compact summary (version strings + capability names) for inclusion in peer status messages.
- `checkUpgradeNeeded()` compares against a known latest version and categorizes the gap as `none`, `patch`, `minor`, or `major`.
- All version comparison uses semantic versioning rules via `compareVersions()` helper (major > minor > patch).

## Gotchas
- Version constants (`CURRENT_NODE_VERSION`, `CURRENT_PROTOCOL_VERSION`) are hardcoded -- must be manually bumped on release.
- Capability list is static (compile-time defaults). There is no runtime mechanism to register new capabilities dynamically.
- `canClaimTask()` converts `NodeVersion` to `ProtocolVersion` for comparison, which works because both have the same `{major, minor, patch}` shape, but they are semantically different types.
- Constructor accepts overrides for all version/capability fields, primarily used in tests.

## Key Files
- `packages/node/src/version-protocol.ts` -- VersionProtocol class
- `packages/shared/src/types.ts` -- ProtocolVersion, VersionedCapability, VersionInfo, NodeVersion, TaskVersionRequirement types
