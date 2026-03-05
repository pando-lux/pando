---
id: thread-store
type: service
domain: chat
entry: packages/node/src/platform/thread-store.ts
depends_on: [storage-backend]
depended_by: [api-server, agent-manager]
exposes:
  - createThread(opts) — create chat thread
  - getThread(threadId) — thread lookup
  - listThreads(filter?) — filtered thread listing
  - listUserThreads(userId) — threads for a specific user
  - addMessage(threadId, message) — append message to thread
  - getMessages(threadId) — all messages in thread
  - deleteThread(threadId) — delete thread and messages
  - updateThread(threadId, updates) — partial field updates
  - loadFromBackend() — hydrate cache from MongoDB on startup
rules: [data-residency]
last_verified: 2026-02-22
---

# Thread Store (Phase 42 + Phase 57 Clean Data)

## What It Does

Persistence for chat threads and messages. Every conversation on Pando (user-to-agent, agent-to-agent) lives in a thread.

## MongoDB-Primary Storage (Phase 57)

ThreadStore uses MongoDB (StorageBackend) as its sole storage layer. The old dual-mode (filesystem fallback + optional MongoDB) was removed in Phase 57.

- **Writes**: All writes go to MongoDB via StorageBackend (`putRecord`, `pushToArray`).
- **Reads**: All reads go to MongoDB via StorageBackend (`getRecord`, `queryRecords`).
- **StorageBackend required**: ThreadStore cannot be instantiated without a StorageBackend. No `db` param, no filesystem fallback.

```
Constructor: new ThreadStore(storageBackend)
  - storageBackend: StorageBackend (required — MongoDB)
```

### MongoDB Collections (2)

| Collection | `_id` Strategy | Notes |
|---|---|---|
| `threads` | thread ID | Thread metadata (title, userId, projectId, type) |
| `messages` | thread ID | Messages stored via `pushToArray` for atomic appends |

## Gotchas

- **`getMessages()` is sync and returns `[]`** — this is a stub for backward compatibility. Always use `getMessagesAsync(threadId)` for actual message retrieval from MongoDB. The `GET /chat/threads/:id` endpoint was fixed in Phase 60 to use the async version.

## Key Files

- `packages/node/src/thread-store.ts` — ThreadStore class (MongoDB-only, Phase 57)
- `packages/node/src/api-server.ts` — Chat API routes
- `packages/node/src/agent-manager.ts` — Agent message persistence
