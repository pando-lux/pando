# Claude Code Integration — Architecture Plan

> Claude Code as a model choice in PandoCode. Not an architectural change — a provider swap.
> User selects "Claude Code" or "Gemini 2.5 Flash" etc. from the same dropdown.

## The Comparison Table

| # | Work | Who Does It Now (API Mode) | Who Does It (Claude Code Mode) | Notes |
|---|---|---|---|---|
| **FRAME & CONTEXT** |||||
| 1 | Build system prompt (identity, rules) | PandoCode FrameBuilder | PandoCode FrameBuilder | No change. Same builder, output goes to `--system-prompt` flag instead of API body |
| 2 | Inject memories into prompt | PandoCode FrameBuilder reads MemoryStore | PandoCode FrameBuilder reads same MemoryStore | No change. Same data, same layer (L3) |
| 3 | Inject board/goals into prompt | PandoCode reads board_tasks SQLite | PandoCode reads same board_tasks SQLite | No change. Injected in tick message or `--append-system-prompt` |
| 4 | Inject inbox (messages from other agents) | LLM calls `check_agents` tool (prompt tells it to) | Claude Code calls `pando_check_inbox` MCP tool (prompt tells it to) | No change. Same pattern — prompt says "check inbox", LLM calls the tool |
| **LLM CALL** |||||
| 5 | Generate AI response | PandoCode sends prompt to Gemini HTTP API | PandoCode pipes prompt to `claude -p` subprocess stdin | **New provider class.** ~200 lines. Same interface |
| 6 | Stream response tokens | PandoCode reads Gemini API stream | PandoCode reads Claude Code stdout (stream-json) | Same `EngineEvent` output. Different parser |
| **TOOL EXECUTION** |||||
| 7 | Read/Write/Edit files | Gemini says "call tool" → PandoCode executes it | Claude Code executes its own built-in tools | **Key change.** PandoCode stops executing coding tools. Claude Code does it |
| 8 | Run bash/tests | Gemini says "call bash" → PandoCode executes it | Claude Code runs its own Bash tool | Same as above |
| 9 | pando_deploy | Gemini calls tool → PandoCode → HTTP POST to 127.0.0.1 | Claude Code calls MCP tool → MCP server → same HTTP POST | Same HTTP call underneath. Goes through MCP protocol instead |
| 10 | pando_status, pando_peers, etc. | Gemini calls tool → PandoCode → HTTP GET to 127.0.0.1 | Claude Code calls MCP tool → MCP server → same HTTP GET | Same HTTP call underneath. Goes through MCP protocol instead |
| 11 | pando_propose (governance) | Gemini calls tool → PandoCode → HTTP POST | Claude Code calls MCP tool → same HTTP POST | Identical result |
| **REFLECTION & MEMORY** |||||
| 12 | Reflection (learn from work) | PandoCode auto-hook runs after response completes | PandoCode sends reminder via stdin: "Reflect now" → Claude Code reflects | **Trigger changes.** Auto-hook → message. Same purpose |
| 13 | Save memories/lessons | PandoCode's reflection auto-writes to MemoryStore | Claude Code calls `pando_save_memory` MCP tool → same MemoryStore | **New MCP tool needed.** Same storage |
| **BOARD & AGENTS** |||||
| 14 | Update board task status | Gemini calls `manage_tasks` tool → PandoCode writes SQLite | Claude Code calls `pando_board_update` MCP tool → same SQLite | **New MCP tool needed.** Same storage |
| 15 | Create board task | Gemini calls `manage_tasks` tool | Claude Code calls `pando_board_create` MCP tool | **New MCP tool needed.** Same storage |
| 16 | Message other agents | Gemini calls `send_message` tool → PandoCode writes state table | Claude Code calls `pando_send_message` MCP tool → same state table | **New MCP tool needed.** Same storage |
| 17 | Spawn sub-agents | Gemini calls `spawn_agent` → PandoCode creates sub-agent | Claude Code uses its native Agent tool | No change needed. Claude Code sub-agents are arguably better |
| **LIFECYCLE** |||||
| 18 | Session persistence | PandoCode manages in SQLite | Claude Code manages natively (`--session-id`, `--resume`) | Different storage. PandoCode just tracks session ID |
| 19 | Cost → Lux accounting | PandoCode counts tokens × price table | Claude Code reports `cost_usd` in result → PandoCode converts | Same Lux output. Different cost source |
| 20 | Scheduler wake-up ticks | Scheduler calls `engine.send(message)` | Scheduler writes message to Claude Code stdin | Same timer. Different delivery pipe |
| 21 | SSE to gateway (live progress) | PandoCode yields `EngineEvent` from API stream | PandoCode parses stream-json → yields same `EngineEvent` | Same event types. Gateway sees no difference |
| 22 | Auth / API keys | PandoCode loads from .env / env vars | Claude Code uses its own login (`claude login`) | Simpler. No key management |
| 23 | Deploy pipeline trigger | After build → `triggerDeployPipeline()` | After build → same `triggerDeployPipeline()` | No change |
| 24 | Capability detection | Checks PandoCode, storage, compute | Same + checks `claude --version` | One extra check |

## Change Summary

| Category | Count | What |
|---|---|---|
| **No change at all** | 10 | Frame building, memory injection, goals, deploy, governance, routing, SSE format, scheduler timer, capability system, Lux formula |
| **Same storage, different tool protocol** | 6 | pando_deploy, pando_status, board update, board create, send_message, save_memory — all go through MCP instead of direct registration. Same HTTP/SQLite underneath |
| **New code needed** | 4 | ClaudeCodeProvider (~200 lines), 4 new MCP tools (~120 lines), engine loop boolean check (~5 lines), reflection reminder injection (~10 lines) |

## How Inbox Works (check_agents)

The council prompt says:
```
STEP 1: Check your inbox: check_agents (action: "inbox")
```
This is a PROMPT INSTRUCTION. The LLM reads this and calls the tool as its first action. PandoCode does NOT auto-call it.

Same in both modes:
- **API mode:** Gemini calls `check_agents` tool because the prompt says to.
- **Claude Code mode:** Claude Code calls `pando_check_inbox` MCP tool because the prompt says to.

Same pattern, same behavior. The prompt drives it, the LLM executes it.

## How Reflection Works

In API mode, PandoCode's engine has a post-turn hook that runs ONCE after all tool calls in a response complete. It auto-extracts lessons and saves to MemoryStore.

In Claude Code mode, after Claude Code finishes its response, PandoCode sends a follow-up message via stdin: "Reflect on what you did. Save lessons via pando_save_memory." Claude Code processes this and calls the MCP tool.

## Long-Running Sessions

With `--session-id` + `--input-format stream-json`:
- One persistent Claude Code process per project
- PandoCode sends periodic messages via stdin (scheduler ticks)
- Claude Code resumes context from previous turns
- Sessions can run for days — resume with `--resume <session-id>`

## MCP (how pando tools reach Claude Code)

MCP = Model Context Protocol. A standard for giving LLMs extra tools via an external server.

PandoCode writes a temp config file:
```json
{
  "mcpServers": {
    "pando": {
      "command": "node",
      "args": ["/path/to/packages/mcp-server/dist/index.js"],
      "env": { "PANDO_API_URL": "http://127.0.0.1:4000" }
    }
  }
}
```

Claude Code starts with `--mcp-config /tmp/pando-mcp.json`. It connects to the MCP server, discovers pando_* tools, and can call them like any other tool. The MCP server makes HTTP calls to the node API — same as PandoCode does now with registered tools.

Existing `packages/mcp-server/` already implements this. Needs 4 new tools: `pando_save_memory`, `pando_board_update`, `pando_board_create`, `pando_send_message`.

## Fallback

```
IF contributor has Claude Code CLI:  → Use ClaudeCodeProvider (subprocess, bidirectional)
IF contributor does NOT:             → Use existing API provider (Gemini/OpenAI/Anthropic)
Same board, same memory, same tools, same interface.
```
