---
id: threaded-chat
components: [bridge-queue, agent-manager, api-server, gateway]
rules: [project-types]
trigger: user_message
---

# Threaded Chat Flow

How the chat system provides a ChatGPT-like threaded conversation experience.

## The User Experience

### Chat Page (/chat) — Always Threaded

Every conversation is a thread. Like ChatGPT.

```
Sidebar                          Main Area
┌─────────────────┐             ┌────────────────────────┐
│ [+ New Chat]    │             │ Thread: "404 Error Page"│
│                 │             │                         │
│ ● 404 Error Page│ ← active   │ You: build me a 404...  │
│   3 msgs · 2h   │             │ AI: Project created...  │
│                 │             │ AI: Done! Created 404.. │
│ ○ Node Q&A     │             │                         │
│   12 msgs · 1d  │             │ [Type a message...]     │
│                 │             │                         │
│ ○ Chess Game   │             │                         │
│   8 msgs · 3d   │             │                         │
└─────────────────┘             └────────────────────────┘
```

- **New Chat** → blank thread → start typing
- First message auto-generates thread title from content
- If task intent → thread becomes a project thread (has workspace, builds things)
- If conversation → thread is just chat (Q&A, discussion)
- Click any old thread → loads full history → continue where you left off
- Even months later → `--continue` from workspace resumes Claude Code context

### Homepage (/) — Smart Search

The homepage is a search bar, not a chat. Quick answers.

```
┌──────────────────────────────────────┐
│  Ask Pando anything...               │
└──────────────────────────────────────┘

User: "what is my balance?"
→ Instant answer: "6271.24 Lux" (no thread created)

User: "build me a portfolio website"
→ "This sounds like a project. [Start a conversation →]"
   (button navigates to /chat with the message pre-filled)

User: "explain how governance works"
→ Shows answer inline
→ If answer is complex: "Want to continue this? [Open in Chat →]"
```

**Rules:**
- Simple responses (balance, status, peers) → inline, no thread
- Medium responses (explanations) → inline + "Open in Chat" button if follow-up likely
- Complex responses (code, builds, projects) → auto-redirect to /chat as new thread

## Thread Lifecycle

```
1. THREAD CREATION
   User starts typing on /chat (new chat) or clicks "New Chat"
   → First message sent
   → Thread created with auto-generated title
   → Thread saved to MongoDB via StorageBackend + cached in local SQLite

2. INTENT CLASSIFICATION
   Same two-axis system as before:
   detectTaskIntent() → 'task' or 'conversation'
   classifyComplexity() → 'simple' | 'medium' | 'complex'

   If TASK → thread becomes project thread:
     - CLAUDE.md written with enriched context
     - Claude Code session started with --continue
     - Thread meta.type = 'project'

   If CONVERSATION → thread stays as chat:
     - Simple/medium handled by keyword/OpenAI as before
     - Complex handled by Claude Code in thread workspace
     - Thread meta.type = 'conversation'

3. MESSAGE ROUTING
   Every message includes threadId:
   POST /chat/message { message, threadId }
   → Message written to MongoDB (awaited) + SQLite cache
   → Dispatched to appropriate handler (keyword/OpenAI/Claude Code)
   → Response written to MongoDB (awaited) + SQLite cache
   → SSE notification pushed

4. THREAD RESUMPTION (days/weeks later)
   User clicks old thread in sidebar
   → Gateway fetches GET /chat/threads/{id}/messages
   → Shows full message history
   → User types new message
   → If project thread: Claude Code runs with --continue from workspace/
     (--continue finds last session in that directory automatically)
   → If conversation thread: classified fresh (may be simple/medium/complex)

5. THREAD PERSISTENCE (Phase 57)
   MongoDB is the single source of truth. SQLite is a local cache.
   Write pattern: MongoDB-first (awaited) → SQLite cache.
   On startup: loadFromBackend() hydrates SQLite cache from MongoDB.
   No StorageBackend = 503 for user data endpoints.
```

## Thread Storage Design (Phase 57)

### Why MongoDB (Not Filesystem)

- **Phase 57 eliminated LocalStorageBackend.** All user data stored via MongoDB (StorageBackend interface).
- SQLite used as a local read cache only — MongoDB is source of truth.
- Multi-device: user logs in from any device → any node → all conversations available.
- Node death: zero data loss — storage is external.
- No disk bloat: nodes don't accumulate user conversations on disk.

### Thread Metadata

```json
{
  "id": "simple-404-error-page-1771471578",
  "title": "404 Error Page",
  "type": "project",
  "createdAt": 1771471578573,
  "updatedAt": 1771471629570,
  "preview": "build me a simple 404 error page with...",
  "messageCount": 5,
  "archived": false
}
```

- `title` auto-generated from first user message (first 50 chars, cleaned)
- `type` = 'project' (has workspace, builds things) or 'conversation' (just chat)
- `preview` = first user message content (for sidebar display)
- `archived` = soft-delete (hidden from sidebar, not shown in UI)

## API Endpoints

### New Thread Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/chat/threads` | List all threads (newest first). Returns index.json contents. |
| POST | `/chat/threads` | Create new empty thread. Returns thread metadata. |
| GET | `/chat/threads/:id` | Get thread metadata + messages. |
| POST | `/chat/threads/:id/message` | Send message to thread. Returns AI response. |
| PATCH | `/chat/threads/:id` | Update thread (rename, archive). |
| DELETE | `/chat/threads/:id` | Delete thread and workspace. |

### Changes to Existing Endpoints

| Endpoint | Change |
|----------|--------|
| `POST /chat/message` | Add optional `threadId`. If absent + on homepage → no thread (search mode). |
| `GET /chat/history` | Deprecated → use `GET /chat/threads/:id` instead. |

## Gateway Changes

### Chat Page (/chat)
- Sidebar: fetch `GET /chat/threads` → render thread list with title, preview, date, count
- "New Chat" button at top of sidebar → `POST /chat/threads` → set as active
- Click thread → `GET /chat/threads/:id` → load messages → set as active
- Message input → `POST /chat/threads/:id/message` with active threadId
- SSE: listen for `chat_message` events → append to active thread if matching threadId
- No thread selected → show "Start a new conversation" prompt

### Homepage (/)
- Search bar behavior:
  - Simple → show answer inline, no navigation
  - Medium → show answer inline + "Open in Chat" button
  - Complex → auto-redirect to `/chat?message=<encoded>` (creates thread on arrival)
- Response includes `suggestThread: boolean` and `autoThread: boolean` from API

## Gotchas

- SQLite cache hydrated from MongoDB on startup via `loadFromBackend()`.
- No StorageBackend (no MongoDB) = user data endpoints return 503.
- --continue from workspace may fail if Claude Code cache expired. In that case, start fresh session with memory.md context.
- Thread deletion removes from MongoDB + SQLite cache. No undo. Gateway should confirm.
- Homepage "Open in Chat" passes message as URL query param → chat page creates thread with that message as first message.
