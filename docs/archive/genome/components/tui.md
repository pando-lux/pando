---
id: tui
type: interface
domain: terminal
entry: packages/node/src/tui.ts
depends_on: [ledger, network, scheduler, governance, api-server, resource-registry, user-accounts]
depended_by: []
exposes:
  - /status (/s) — node status
  - /peers (/p) — connected peers
  - /network (/n) — network topology and peer balances
  - /balance [peerId] (/b) — check Lux balance
  - /wallet (/w) — wallet and ownership info
  - /transfer <peerId> <amount> (/t) — send Lux to a peer
  - /send <peerId> <amount> — alias for /transfer
  - /search <query> — AI search (or just type without /)
  - /proposals — list governance proposals
  - /propose <title> — create a governance proposal
  - /vote <id> <approve|reject> — vote on a proposal
  - /connect <multiaddr> (/c) — connect to a peer
  - /scheduler — show scheduler status
  - /submit <description> — submit task to scheduler
  - /tasks — show task queue
  - /resources (/r) — list your contributed resources and network resource summary
  - /contribute <service> <key> — contribute a resource (openai, anthropic, gemini, mongodb, aws). MongoDB shows restart hint. AWS supports JSON format for structured credentials.
  - /revoke <id> — revoke an owned resource
  - /login — login to existing account (username+password, calls /auth/login API)
  - /register — create new account (username+password, calls /auth/guest + /auth/claim APIs)
  - /invite (/i) — share bootstrap command for new peers
  - /logout — clear operator session (node keeps running as relay, no rewards)
  - /help (/h) — show commands
  - /quit (/q) — graceful shutdown
rules: []
last_verified: 2026-02-22
---

# TUI (Terminal User Interface)

## What It Does
Interactive terminal interface for running a Pando node. The primary way to run and interact with a node. Prompts for a password on startup to decrypt the node identity, provides slash commands for all node operations, and displays real-time node activity. Phase 55 adds operator identity — `/login`, `/register` commands let node operators authenticate with the same account used on the gateway.

## How It Works
- On startup, prompts for a password to decrypt the node's Ed25519 identity from `~/.pando/identities/<peerId>.json` (or legacy `~/.pando/identity.json`). The decrypted identity is cached in `~/.pando/session.json`.
- **Startup message:** After identity decryption, shows "Node #XXXX running" (short node identifier). Then attempts auto-login from `linked-user.json`.
- **Auto-login (Phase 55):** On startup, checks for `~/.pando/linked-user.json`. If found (has peerId), calls `node.linkUser()` to restore linked state. Rewards flow to the linked user account. No linked user = relay-only (no rewards).
- Identity selection uses arrow-key navigation (up/down + Enter). Yes/no prompts use left/right + Enter.
- Slash commands are parsed from user input and dispatched to the appropriate node subsystem (ledger, network, scheduler, governance, etc.).
- Plain text input (without `/` prefix) is treated as a search query and routed to the AI search system.
- Resource management commands (`/resources`, `/contribute`, `/revoke`) use the node's ResourceRegistry to manage contributed resources (API keys, compute, storage). Values are masked in display (show last 4 chars only). **`/contribute` passes `userId` from the linked user account** (via `node.getLinkedUser()`) so resources appear in the user's "My Resources" on the gateway.
- **`/contribute mongodb`** shows a restart warning after success — MongoDB StorageBackend only activates on node restart (auto-discovery runs at startup).
- **`/contribute aws`** supports JSON format: `/contribute aws {"accessKeyId":"...","secretAccessKey":"...","region":"...","bucket":"..."}`. Validates required fields. Plain string also accepted for backward compatibility.

### Operator Identity Commands (Phase 55)

- **`/login <user> <pass>`** — Calls `POST /auth/login` on the local node API. On success, calls `node.linkUser(peerId, username)` which saves to `linked-user.json`. Rewards flow to the linked user account.
- **`/register <user> <pass>`** — Two-step: creates guest account (`POST /auth/guest`), then claims it (`POST /auth/claim`). On success, links user account to node.
- **`/logout`** — Calls `node.unlinkUser()` which deletes `linked-user.json`. Node keeps running as relay-only -- no rewards earned until next login.

### Session Persistence

- **`node.linkUser(peerId, username)`** — Writes `{peerId, username}` to `<dataDir>/linked-user.json`. Updates capability profile.
- **`node.unlinkUser()`** — Deletes `linked-user.json`. Reverts to relay-only mode.
- On startup, `linked-user.json` is read and restored automatically.

## Gotchas
- The TUI is a standalone entry point (`tui.js`), separate from the CLI entry point (`cli.ts`). The TUI wraps the full PandoNode with an interactive terminal layer.
- Password input is masked — the actual characters are not displayed. If the password is wrong, identity decryption fails and the user is re-prompted.
- Multiple identities can be stored in `~/.pando/identities/`. The TUI presents a selection menu if more than one identity exists.
- All TUI console output goes through the logger which strips ANSI color codes before writing to the log file.
- **`linked-user.json`** is separate from `session.json` (node identity session). The linked user tracks the human operator's account; the node session tracks the machine identity.

## Key Files
- `packages/node/src/tui.ts` — TUI entry point with interactive terminal, command handling, operator login
- `packages/node/src/cli.ts` — CLI entry point (non-interactive, session-aware)
- `packages/node/src/logger.ts` — FileLogger (tees console to log file)
