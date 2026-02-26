---
id: file-registry
type: service
domain: support
entry: packages/node/src/platform/file-registry.ts
depends_on: []
depended_by: [scheduler]
exposes:
  - claimFile(filePath, peerId) — claim a file for editing (returns true if succeeded)
  - releaseFile(filePath, peerId) — release a file claim (owner only)
  - checkClaim(filePath, peerId) — check if file is claimed by another agent
  - clearAll() — clear all claims (used on startup)
  - listClaims() — list all active non-expired claims
rules: []
last_verified: 2026-02-18
---

# File Registry

## What It Does
File ownership registry that prevents concurrent edits by multiple agents. Local-only (no GossipSub sync). Each node tracks which files are claimed by which agent. Claims auto-expire after a configurable TTL (default 15 minutes).

## How It Works
- Maintains an in-memory `Map<string, FileClaim>` keyed by normalized file path (forward slashes, trimmed whitespace).
- `claimFile()` first prunes expired claims, then checks if the file is already claimed by another agent. If unclaimed or already claimed by the same agent, the claim is created or refreshed with a new expiration. Returns true on success, false if blocked by another agent's claim.
- `releaseFile()` only releases if the caller is the claim owner. Returns false if not found or not owned.
- `checkClaim()` returns the existing claim if held by a different agent, or null if available (own claims do not block).
- `clearAll()` removes all claims and returns the count removed. Used on startup to clear stale locks from a previous process.
- `pruneExpired()` runs before every claim/check operation. Removes claims where `expiresAt <= now`.

## Gotchas
- Local-only registry — does not sync across nodes. Two nodes can claim the same file simultaneously, leading to edit conflicts in cross-node scenarios.
- Path normalization converts backslashes to forward slashes and trims whitespace, but does NOT lowercase the path. On case-insensitive filesystems (Windows, macOS), the same file can be claimed under different cases.
- No persistence — all claims are lost on node restart. `clearAll()` is called on startup as a safety measure, but this is only needed if claims were somehow persisted elsewhere.
- The 15-minute TTL means long-running agent tasks may lose their file claims mid-edit. Tasks exceeding 15 minutes should periodically refresh their claims.

## Key Files
- `packages/node/src/file-registry.ts` — FileRegistry class (107 lines)
- `packages/shared/src/types.ts` — FileClaim type
