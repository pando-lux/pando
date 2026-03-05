---
id: resource-marketplace
type: service
domain: resources
entry: packages/node/src/platform/resource-marketplace.ts
depends_on: [capability-registry, network]
depended_by: []
exposes:
  - setPrice(resourceType, pricePerUnit) — set local node price for a resource type
  - getPrices(peerId?) — get price list for a node (local or cached peer)
  - findCheapest(requirements) — find cheapest capable node for given requirements
  - matchBudget(taskBudget, requirements) — find nodes within a Lux budget
  - getMarketStats() — aggregate marketplace statistics
  - broadcastPrices() — broadcast local prices via GossipSub
rules: []
last_verified: 2026-02-18
---

# Resource Marketplace

## What It Does
Marketplace pricing layer for network resources. Node operators set prices for their capabilities (relay, compute, storage, etc.). Buyers can find the cheapest provider for their requirements. Prices are broadcast via GossipSub and cached locally.

## How It Works
- Initializes with default prices for all resource types: relay=0.001 Lux/MB, api_keys=0.01/call, compute_cpu=0.1/minute, compute_gpu=0.5/minute, storage=0.001/GB-hour, gateway=0.01/1000 requests, validator=0.05/validation, index=0.005/query.
- `setPrice()` allows node operators to override default prices for any resource type.
- `findCheapest()` queries the CapabilityRegistry for all nodes matching the required resources, calculates total cost per candidate using their advertised prices (falling back to defaults), and returns the cheapest option plus up to 5 alternatives.
- `matchBudget()` finds all capable nodes whose total estimated cost fits within a given Lux budget, marking each as `withinBudget: true/false` and whether they are below `averageCost`.
- Peer prices are cached in-memory from GossipSub broadcasts. Cache uses peerId as key with a `PriceList` value containing per-resource prices and an `updatedAt` timestamp.

## Gotchas
- Default prices are hardcoded. If the CapabilityRegistry returns a node but the marketplace has no cached prices for it, default prices are used — this may not reflect the remote node's actual pricing.
- Cost comparison in `findCheapest()` assumes 1 unit of each required resource for comparison. Actual costs depend on task duration/volume which is unknown at routing time.
- No price validation — a node can set a price of 0 or negative, which would sort it as cheapest.
- Peer price cache has no TTL — stale prices persist until overwritten by a new broadcast.

## Key Files
- `packages/node/src/resource-marketplace.ts` — ResourceMarketplace class
- `packages/node/src/capability-registry.ts` — provides node capability data
- `packages/shared/src/types.ts` — PriceList, MarketplaceResult, BudgetMatch, MarketStats types
