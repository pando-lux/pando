---
id: project-types
type: rule
domain: governance
enforced_by: [agent-manager, payment-gate, guardrails]
---

# Project Types Rule

When a user requests work, the project type determines funding, governance requirements, and access rules. The Manager agent enforces these rules via the bridge queue.

## Three Project Types

### Personal Project
- **Owner:** Single user (identified by session or linked wallet)
- **Funding:** User pays from their Lux balance
- **Governance:** Not required (user's own money)
- **Access:** Only the owner can modify or view
- **Payment flow:** Balance check -> escrow hold -> task execution -> release on completion / refund on failure
- **Example:** "Build me a personal dashboard", "Fix my portfolio site"

### Public Project (Network Utility)
- **Owner:** The network (no single owner, governed by consensus)
- **Funding:** Network-funded from NETWORK account or community contributions
- **Governance:** REQUIRED — proposal with 2+ node approval before any work starts
- **Access:** Any user can view. Contributors need governance approval.
- **Payment flow:** Governance proposal -> vote -> approved budget allocated from NETWORK -> tasks funded from budget
- **Example:** "Build a chess game for all Pando users", "Add a marketplace page to the gateway"

### Admin/Operator Project
- **Owner:** Node operator running the local node
- **Funding:** Own resources (own Claude Code session, own compute). No Lux cost.
- **Governance:** Not required (operator's own machine)
- **Access:** Local API only — not accessible from external gateway requests
- **Payment flow:** None — using own resources
- **Example:** "Fix the bug in my scheduler", "Update the node configuration"

## Security Rules (All Types)

- Cannot modify core node code without governance approval (Guardrails `immutable-kernel` rule)
- Cannot access other users' data, wallets, or identity files
- Cannot bypass per-action rate limits (UserIdentity enforcement)
- Cannot spend more Lux than the escrowed amount
- Protected paths (`~/.pando/identity.json`, `ledger.db`, etc.) are read-only via Guardrails
- Law I and Law II apply to all AI actions within projects
- Workers for user projects run in isolated workspaces (WorkspaceManager)

## Detection

The Communication Agent determines project type from context:
- **Local API call** (no external session) → Admin project
- **User explicitly requests public** ("make this for everyone", "propose this to the network") → Public project
- **Default** → Personal project (safest assumption — user pays)
