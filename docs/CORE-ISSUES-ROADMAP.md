# Core Issues Roadmap

> Active issues and improvements. Worked on directly (not via council).

## Goal 1: Universal System Tray

**The (P) tray icon becomes the single entry point to everything Pando on the user's machine.**

### Current State

- `supervisor.ts` has a basic system tray with: status polling, Open Gateway, View API, Restart, Stop
- Hardcoded to pando-node only — no awareness of services/plugins
- PandoTeams web UI (server + Vite) requires separate manual startup
- No service visibility in the tray menu

### Target State

One (P) tray icon that:
1. Starts/stops/restarts the node (already works)
2. Shows node status — peers, Lux balance, health (already works)
3. Discovers all installed services via ServiceLoader and shows them in the menu
4. Each service gets a submenu: status indicator, "Open UI" link, start/stop toggle
5. Services auto-start when the node starts (ServiceLoader already does this)
6. PandoTeams web UI starts automatically when @pando-teams/core is loaded as a service

### Tasks

| # | Task | Description | Status |
|---|------|-------------|--------|
| 1.1 | Enhance /v1/services endpoint | Return per-service detail: id, version, healthy, capabilities, uiUrl. | DONE |
| 1.2 | Fix supervisor API port | Was hardcoded to 4100 (P2P port). Now resolves from --api-port / env / default 4000. | DONE |
| 1.3 | Clean tray menu | Remove `<sep>` junk. Use proper systray2 separators. Clean layout with header + status + services + actions. | DONE |
| 1.4 | Tray polls /v1/services | Supervisor polls `/v1/services` alongside `/v1/status` every 10s. Builds dynamic menu items for each discovered service. | DONE |
| 1.5 | Service UI URLs in tray | Each service with a `uiUrl` gets a clickable "Open UI" entry in the tray. | DONE |
| 1.6 | Dynamic tray menu rebuild | `update-menu` action rebuilds the entire menu on each poll cycle — services appear/disappear automatically. | DONE |
| 1.7 | Open Gateway local fallback | Checks `localhost:3000` first, falls back to Vercel URL if local gateway isn't running. | DONE |
| 1.8 | PandoService uiUrl field | Services can declare `uiUrl` on the service object. Exposed via `/v1/services` and used by tray. | DONE |
| 1.9 | PandoTeams auto-starts web server | When @pando-teams/core starts as a service, it should also start its HTTP server + web UI automatically. | TODO (pando-teams side) |

### Architecture

```
(P) System Tray  (supervisor.ts)
 │
 ├── Pando Node  (always running)
 │    └── ServiceLoader
 │         ├── @pando-teams/core  → Web UI on :5176, API on :4873
 │         ├── @pando/exchange   → (future)
 │         └── ...
 │
 ├── GET /v1/status   → node health, peers, balance
 └── GET /v1/services → installed services, health, UI URLs
```

The tray is the **view layer** for the supervisor. The supervisor manages the node process. The node manages services via ServiceLoader. Clean hierarchy, one process tree.

### Notes

- `systray2` npm package handles the tray icon (already in use)
- Tray works on Windows/Mac, headless Linux falls back gracefully (already handled)
- Future products (exchange, storage, etc.) just implement PandoService + declare a `uiUrl` — tray picks them up automatically
