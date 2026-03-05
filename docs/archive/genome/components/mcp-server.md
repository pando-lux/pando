---
id: mcp-server
type: interface
domain: agent-integration
entry: packages/mcp-server/src/index.ts
depends_on: [api-server]
depended_by: []
exposes:
  - pando_status — node status (peers, balance, supply, uptime)
  - pando_peers — list connected peers
  - pando_balance — check Lux balance (own or by peer ID)
  - pando_transfer — send Lux to another peer
  - pando_search — AI search via contributed API keys
  - pando_wallet — wallet/ownership info (peer ID, public key, balance, identity file)
rules: []
last_verified: 2026-02-18
---

# MCP Server

## What It Does
Pando MCP server that connects Claude Code to the Pando network. Provides 6 tools that Claude Code agents can use to interact with the local node. Communicates over stdio using the Model Context Protocol SDK.

## How It Works
- Uses `@modelcontextprotocol/sdk` with `StdioServerTransport` for stdio-based communication with Claude Code.
- Configured via `PANDO_NODE_URL` env var (default: `http://localhost:4000`) and `PANDO_API_TOKEN` for authenticated requests.
- `ListToolsRequestSchema` handler returns 6 tool definitions with JSON Schema input schemas.
- `CallToolRequestSchema` handler dispatches to tool-specific async functions: `handleStatus()`, `handlePeers()`, `handleBalance()`, `handleTransfer()`, `handleSearch()`, `handleWallet()`.
- Each tool handler makes HTTP requests to the node API with optional Bearer token auth and 5-10 second timeouts.
- Returns formatted text responses (not JSON) for human-readable Claude Code output.
- `pando_balance` without a peerId argument fetches own balance from `/status`; with a peerId it queries `/balance/:peerId`.

## Gotchas
- Uses `http://localhost:4000` as default (unlike the gateway which uses `127.0.0.1`). This can cause IPv6 issues on some systems — set `PANDO_NODE_URL=http://127.0.0.1:4000` explicitly if connections fail.
- No retry logic — if the node is temporarily unreachable, the tool call fails immediately with an error response.
- Transfer tool requires Bearer token auth. If `PANDO_API_TOKEN` is not set, transfer calls will be rejected by the node's auth middleware.
- Installation: `claude mcp add pando -- node /path/to/pando/packages/mcp-server/dist/index.js`

## Key Files
- `packages/mcp-server/src/index.ts` — MCP server with all 6 tool handlers
- `packages/node/src/api-server.ts` — the HTTP API that MCP tools call
