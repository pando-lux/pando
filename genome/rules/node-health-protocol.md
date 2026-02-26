---
id: node-health-protocol
type: rule
domain: governance
depends_on: [governance-tiers, credential-security, council]
last_verified: 2026-02-26
---

# Rule: Node Health Protocol — Maintenance Agreement Model

## The Rule

When an operator contributes a node to the network, they choose a maintenance tier (M0–M3). This pre-authorization defines what the network may do autonomously if the node fails — no per-incident governance vote required within the chosen tier. Consent is given ONCE at contribution time.

## Why This Exists

Phase 112 (Council Infrastructure Repair Loop) handles the mechanics of autonomous repair. But it assumes:
1. The operator has consented to autonomous action on their node.
2. There is a way to notify the operator before action is taken.

Without the Maintenance Agreement Model, any repair on an externally-contributed node requires a separate governance vote for every incident. That is too slow for a 3am service crash, and unworkable for a network of hundreds of nodes.

## Maintenance Tiers

| Tier | Name | What the Network May Do | Notification Window Before Action |
|---|---|---|---|
| **M0** | Notify Only | Nothing. Alerts sent only. | 72h for operator to act. |
| **M1** | Restart | PM2/systemd restart if down 24h+ | 1h owner window to reject. |
| **M2** | Instance Reboot | EC2/VPS reboot if M1 fails. | 12h owner window to reject. |
| **M3** | Full Maintenance | All `SAFE_REPAIR_OPS` (Phase 111). | No notification window. |

Default tier for new contributions: **M0** (safest — no autonomous action without explicit opt-in).

## Pre-Authorization Model

The governance vote that approves M1/M2/M3 action templates happens ONCE at the network level — not per-incident. The Council's per-incident check is: "Does this repair fall within the operator's pre-authorized tier?" If yes, no new governance vote needed.

The flow for a pre-authorized repair:
1. HealthMonitor detects node down
2. Council runs automated pre-diagnosis (no credentials required)
3. Council checks `maintenanceTier` on the node's resource record
4. Council sends notification + starts owner notification window (M1: 1h, M2: 12h)
5. If window expires with no rejection, or tier is M3: repair executes via DevOps agent (Phase 111)
6. Result logged to Council minutes

## Automated Pre-Diagnosis

Before any repair, Council runs an observational chain using NO credentials:

```
Step 1: P2P reachable?
  YES → node alive, likely API or routing issue. Skip repair, log alert.
  NO  → proceed to Step 2.

Step 2: API port reachable? (HTTP GET /v1/status, no auth)
  YES → node alive, P2P routing issue (NAT/firewall). Notify operator, no repair.
  NO  → proceed to Step 3.

Step 3: EC2 instance state? (read-only DescribeInstances via Phase 110 scoped token)
  RUNNING    → instance alive, OS/systemd crash. Matches M1 repair.
  STOPPED    → instance stopped (billing or manual). Matches M2 or human escalation.
  TERMINATED → catastrophic. Human escalation ONLY. No autonomous action ever.

Step 4: Pattern detection
  3+ nodes in same AWS region/provider with same symptom within 1h:
  → systemic cause (AWS outage / policy change / shared dependency failure)
  → SKIP all individual repairs
  → Council proposes governance update to bootstrap config (Tier 2 vote, not Tier 4 instant)
```

## Operator Notification Channels

Before acting within a notification window, Council attempts all available channels in order:
1. **P2P message** — delivered on next connection (works even if node is currently offline)
2. **Telegram** — if operator linked Telegram account via `/contribute telegram-bot`
3. **Governance identity page** — public record that action is pending (visible via gateway)

**Anonymous operators** (no Telegram linked, node offline 24h+, M1+ chosen):
- Action proceeds without notification window.
- This is an explicit consequence of choosing M1+ without providing a contact channel.
- Council minutes log: "Node X: M1 pre-authorized, no contact channel available, proceeding."
- Recommendation: operators who want control over autonomous actions must either choose M0 or provide a notification channel.

## Security Constraints

### Why this doesn't give AI unlimited access to operator nodes

- Maintenance tier is CHOSEN BY THE OPERATOR at contribution time. Default is M0 (no action).
- Repair commands are restricted to the pre-approved `SAFE_REPAIR_OPS` list (Phase 111). No arbitrary shell.
- All repairs use scoped credentials via Phase 110 — AI never holds the raw key; only a 30-min scoped token.
- Every repair is logged to Council minutes and visible on the governance page.
- The operator can change their maintenance tier at any time via `PATCH /v1/resources/:id`.

### Pattern detection prevents misuse

If the Council detects 3+ nodes in the same region failing within 1 hour, it STOPS repair actions and raises a systemic failure flag. This prevents the Council from restarting dozens of nodes during a legitimate AWS outage — where the correct response is a governance policy update, not individual reboots.

### Limits on M3

Even M3 (Full Maintenance) is bounded by `SAFE_REPAIR_OPS`. M3 does not mean "AI can do anything to my server." It means "AI may attempt any pre-approved repair without waiting for notification." Commands outside `SAFE_REPAIR_OPS` always require an explicit governance vote regardless of maintenance tier.

## Current Status

| Aspect | Status |
|---|---|
| `maintenanceTier` field on ResourceRegistry | PLANNED — Phase 113 |
| Pre-diagnosis chain in `platform/council.ts` | PLANNED — Phase 113 |
| Notification window logic | PLANNED — Phase 113 |
| Pattern detection → governance | PLANNED — Phase 113 |
| Scoped credentials for repair ops | PLANNED — Phase 110 |
| DevOps agent execution | PLANNED — Phase 111 |
| Full repair loop (Council → DevOps → minutes) | PLANNED — Phase 112 |

## Related

- `genome/rules/governance-tiers.md` — tier voting model that repair proposals use
- `genome/rules/credential-security.md` — how repair credentials are scoped and issued
- `genome/roadmap.md` Phase 112 — Council Infrastructure Repair Loop (mechanics)
- `genome/roadmap.md` Phase 113 — Node Health Protocol implementation spec
- `docs/pando/01-foundation/the-stack.md` — Node Health Protocol overview
