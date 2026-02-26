---
id: content-publish
type: service
domain: content
entry: packages/node/src/platform/content-publish.ts
depends_on: [content-registry]
depended_by: []
exposes:
  - extractContent(workspacePath) — walk workspace, collect files, compute SHA-256 content hash
  - createContentRecord(options) — create a ContentRecord via the registry
  - publish(workspacePath, options) — full flow: extract + create record + broadcast
  - updateContent(contentId, updates) — version-bump an existing record
rules: []
last_verified: 2026-02-18
---

# Content Publisher

## What It Does
Handles the publish flow for content created by agent tasks. After a task completes and produces publishable content (website, API, etc.), the publisher extracts output from the workspace, creates a ContentRecord in the registry, and announces it to the network.

## How It Works
- `extractContent()` walks the workspace directory recursively, skipping `node_modules` and hidden directories. Collects file paths and sizes, hashes the first 4KB of each file with SHA-256 for a content fingerprint (truncated to 16 hex chars).
- `createContentRecord()` delegates to `ContentRegistry.create()` which handles UUID generation, version hashing, SQLite persistence, and GossipSub broadcast.
- `publish()` is the full pipeline: extract content from workspace, then create the record. Returns null if the workspace is empty or missing.
- `updateContent()` wraps `ContentRegistry.update()` for version bumps when content is rebuilt.

## Gotchas
- Returns `null` silently if the workspace does not exist or contains no files — callers must check the return value.
- The content hash only covers the first 4KB per file, so large files with identical headers but different bodies may produce the same fingerprint.
- Requires `setLocalPeerId()` to be called before publishing; otherwise owner/builder fields will be empty strings.

## Key Files
- `packages/node/src/content-publish.ts` — ContentPublisher class (158 lines)
- `packages/node/src/content-registry.ts` — ContentRegistry (dependency for record creation)
