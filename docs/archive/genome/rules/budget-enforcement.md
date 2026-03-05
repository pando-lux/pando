---
id: budget-enforcement
severity: high
applies_to: [manager, emission-witness]
created: 2026-02-17
---

# Budget Enforcement

## The Rule

Every project has a daily Lux budget. When exhausted, the manager defers non-critical work until the next period.

## Limits

| Limit | Value |
|---|---|
| Hard cap (total supply) | 10,000,000,000 Lux |
| Daily cap per node | 500 Lux |
| Default project budget | 100 Lux/day |
| Relay fee | 0.1% per transfer |

## How Lux Is Earned

| Work Type | Base Reward |
|---|---|
| Uptime epoch (10 min) | 0.05 Lux |
| Task completed | 5.0 Lux |
| API key contributed | 2.0 Lux |
| Proposal accepted | 5.0 Lux |
| Vote cast | 0.1 Lux |

## Enforcement

- ManagerAgent.checkBudget() validates before every session spawn
- ProjectSettings.budgetLuxLimit / budgetLuxSpent tracked per period
- resetBudgetIfNeeded() auto-resets at period boundary
- EmissionWitness requires 2+ peer attestations before minting
- Daily review tracks budget usage trends
