---
id: capability-registry
type: service
domain: resources
entry: packages/node/src/platform/capability-registry.ts
depends_on: [network, local-capability-store]
depended_by: [resource-marketplace, resource-router, scheduler, api-server, gateway]
exposes:
  - setLocalProfile(profile) — set this node's CapabilityProfile
  - getLocalProfile() — get this node's profile
  - updatePeerProfile(profile) — store a peer's profile (from GossipSub)
  - getPeerProfile(peerId) — get a specific peer's profile (TTL-checked)
  - findCapableNodes(requirements) — find all peers with ALL specified capabilities
  - canExecuteLocally(requirements) — check if local node can handle given requirements (uses LocalCapabilityStore when available)
  - getAllProfiles() — get all known non-expired profiles (local profile never expires)
  - setLocalCapabilityStore(store) — attach LocalCapabilityStore for own-task routing
  - cleanup() — prune expired profiles (local profile never expires)
rules: []
last_verified: 2026-02-26
---

# Capability Registry

## What It Does
Network-wide capability map that stores capability profiles received from peers via GossipSub. Each profile has a 15-minute TTL (except the local node's own profile, which never expires). Used by the Scheduler to check whether the local node can execute a task, by the API to expose the network's capability map, and by the gateway to show "My Nodes" for multi-node users.

## How It Works
- Stores `CapabilityProfile` objects in an in-memory `Map<string, StoredProfile>` keyed by peerId. Each stored profile includes a `receivedAt` timestamp for TTL enforcement.
- `setLocalProfile()` registers the local node's capabilities and adds it to the profiles map.
- `updatePeerProfile()` stores or refreshes a peer's profile with the current timestamp.
- `getPeerProfile()` returns the profile if it exists and was received within the 15-minute TTL; otherwise deletes the stale entry and returns null.
- `findCapableNodes()` iterates all profiles, prunes expired entries, and returns those where ALL required capabilities are present (`profile.capabilities[req]` is truthy for every requirement).
- `canExecuteLocally()` returns true if the local profile has all required capabilities. Returns false if no profile is set. Tasks with no requirements (empty list) can be claimed by any node.
- `getAllProfiles()` returns all profiles. The local node's own profile is **never expired** (skips TTL check). Remote peer profiles expire after 15 minutes.
- `cleanup()` prunes expired profiles. Same rule: local profile is never pruned.

## linkedUser (Phase 60)

`CapabilityProfile` has an optional `linkedUser` field:
```typescript
linkedUser?: { username: string } | null;
```

When a user does TUI `/login`, the node updates its capability profile's `linkedUser` and rebroadcasts via GossipSub. This enables:
- **`GET /network/capabilities/user/:username`** — find ALL nodes linked to a user across the network
- **Gateway "My Nodes"** — shows all user's nodes with capability tags (Claude Code in violet)

The `linkedUser` is set by `capability-detector.ts` at startup (from `this.linkedUser`) and updated live by `updateCapabilityLinkedUser()` in `index.ts` when a user links/unlinks.

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /capabilities` | Local node's capability profile |
| `POST /capabilities` | Update local capability profile |
| `GET /network/capabilities` | All known profiles including local node |
| `GET /network/capabilities/user/:username` | Filter by `linkedUser.username` |

The `/network/capabilities` endpoint includes the local node's own profile (defensive merge — ensures it's always present even if not in the profiles map).

## Phase 87: deployPeerId + publicAddress (Deploy routing)
`CapabilityProfile` gained two fields used for deploy routing:
- `storageBackend: 'mongodb' | 'p2p'` — identifies trusted compute nodes (mongodb) vs relay nodes (p2p)
- `publicAddress?: string` — the node's public IP/hostname for Tier 2 app URLs (e.g. `http://54.82.241.132/apps/<id>/`)
- `deployPeerId` is stored on the **Project** record (not the profile) — the peerId of the node that last deployed the project

## Phase 91: publicAddress via PUBLIC_IP env var
`publicAddress` is set at node startup from the `PUBLIC_IP` environment variable (EC2 nodes set this in systemd). The deploy endpoint reads `profile.publicAddress` to construct Tier 2 app URLs. Without `PUBLIC_IP`, Tier 2 URLs would use the internal libp2p address, which is not publicly reachable.

## Phase 92: Direct TCP capability exchange
On every peer connect, the node immediately sends its CapabilityProfile via direct TCP stream (`CAPABILITY_PROFILE_DIRECT` MessageType), in addition to GossipSub broadcasts. This guarantees compute peer discovery even when GossipSub mesh fails to form (requires D=6 peers; fails in small 2-3 node networks).

## Phase 96: LocalCapabilityStore + Detection vs Sharing Split

`canExecuteLocally()` now has two code paths:
- **With LocalCapabilityStore** (normal, post-Phase 96): reads full detected capabilities via `localResourceTypeAvailable()`. Own tasks always work regardless of sharing preferences.
- **Without LocalCapabilityStore** (fallback/legacy): reads broadcast profile.

The mapping `localResourceTypeAvailable(req)`:
- `compute_cpu` → `localCapStore.has('claude-code')` — detected locally, regardless of sharing
- `compute_gpu` → `localCapStore.has('gpu')`
- `storage/relay/gateway/validator/index` → `true` (always available locally)
- `api_keys` → `false` (checked at runtime via ResourceRegistry, not capabilities)

**Key invariant:** `canExecuteLocally()` being `true` does NOT imply the node is sharing its compute with the network. Sharing is controlled by `shareCompute` in `LocalCapabilityStore`. A node that has Claude Code but hasn't run `/contribute claude-code` can still execute its OWN tasks locally.

## Gotchas
- Profiles are purely in-memory — all peer profiles are lost on node restart and must be re-discovered via GossipSub broadcasts or Phase 92 direct TCP exchange.
- TTL of 15 minutes means peers must re-broadcast regularly or be "forgotten." The local node's own profile is exempt from TTL.
- No dedup or conflict resolution — if a peer sends conflicting capability profiles, the latest one wins.
- Claude Code is a **node capability** (detected by `capability-detector.ts`), NOT a resource. It appears in CapabilityProfile, not ResourceRegistry.
- `api_keys` in CapabilityProfile is **always false** (hardcoded in capability-detector.ts). Actual API key availability is checked at runtime via `ResourceRegistry.findResources('ai_api_key')`.
- `compute_cpu` in the BROADCAST profile is only `true` when the user has explicitly opted in via `/contribute claude-code`. Detection (having the binary) ≠ sharing.

## Key Files
- `packages/node/src/platform/capability-registry.ts` — CapabilityRegistry class
- `packages/node/src/platform/capability-detector.ts` — Auto-detects capabilities at startup, accepts `localCapStore` param
- `packages/node/src/platform/local-capability-store.ts` — Stores full detected + user sharing preferences (never broadcast)
- `packages/node/src/index.ts` — `rebuildCapabilityProfile()`, `getLocalCapabilityStore()`
- `packages/shared/src/types.ts` — CapabilityProfile, ResourceType types
