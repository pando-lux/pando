---
id: p2p-first
severity: high
applies_to: [all]
created: 2026-02-15
updated: 2026-02-22
---

# P2P for the Brain, Not Every Byte

## The Rule

P2P protects the things that make the network ALIVE — identity, economy, coordination, governance, survival. Everything else uses existing internet infrastructure (MongoDB, S3, GitHub, Vercel, etc.).

Pando does NOT replace the internet. Pando CO-EXISTS with the internet. The node network is an AI brain that uses the internet's body and can never be killed.

**Nodes are stateless compute proxies.** They process requests, run AI agents, coordinate governance, and manage the economy. They do NOT permanently store user data. User data lives on internet infrastructure — encrypted, durable, accessible from any device via any node.

## What MUST Be P2P (the brain — lives on nodes)

These are the things that make the network indestructible:

- **Identity** — Ed25519 keypairs, peer discovery, no central auth server
- **Economy** — Lux ledger (accounts, balances, transactions) — synced via GossipSub
- **Governance** — Proposals, votes, decisions replicate to all peers
- **Task coordination** — Task queue, manager decisions, bridge events sync cross-node
- **Node survival** — If any node dies, others carry on. No single point of failure
- **Reputation** — Node trust scores broadcast and aggregated across network
- **Capabilities** — What each node can do, broadcast for smart routing

## What Uses Internet Infrastructure (the body — NOT on nodes)

These are user data and outputs — they live on internet infrastructure:

- **User data** — Chat threads, messages, user accounts → **MongoDB** (structured, queryable)
- **Project files** — Deployments, blobs, large content → **AWS S3** (cheap, durable)
- **Code hosting** — GitHub, GitLab, any git remote
- **Website hosting** — Vercel, Netlify, Cloudflare Pages
- **Agent workspaces** — Ephemeral during execution. Results go to MongoDB/S3. Workspace deleted after.
- **DNS/TLS** — Cloudflare, Route53, whatever the hosting platform provides

## Why Nodes Must Be Stateless (for user data)

1. **Multi-device:** User logs in from phone, laptop, friend's PC — all conversations must be there. Can't happen if data lives on one node.
2. **Node death:** Node goes down, zero data lost. New node picks up immediately because storage is external.
3. **No disk bloat:** Node operators don't accumulate 20GB of everyone's conversations. Nodes stay lightweight.
4. **Any-node access:** With Phase 40 (signature auth), users can connect to any node. But if data is node-local, they'd need the specific node that has their threads. External storage means any node serves any user.
5. **Provider economics:** Storage providers contribute MongoDB/S3 credentials to the network, earn Lux. This is a real service with real economics, not "donate your laptop's hard drive."

## What Anyone Can Contribute (not just node operators)

Anyone — node operator OR regular user — provides resources to the network:

- **Compute** — CPU/GPU cycles for running agents, AI inference, building projects
- **API keys** — OpenAI, Claude, Gemini keys for AI search and agent work
- **Storage accounts** — MongoDB Atlas, AWS S3 credentials for user data persistence
- **Cloud accounts** — AWS instances, Vercel projects, hosting platforms
- **Bandwidth** — Relay traffic, GossipSub message forwarding

Resources are registered via the ResourceRegistry (Phase 42.5), encrypted, and auto-discovered by nodes. Providers earn Lux for usage. You do NOT need to run a node to contribute an API key and earn Lux.

See `genome/flows/resource-contribution.md` for the full flow.

## Data Flow

```
User (browser)
  │  encrypt with AES-256-GCM (Phase 41)
  ▼
Any Pando Node (stateless proxy)
  │  decrypt → process → re-encrypt
  │  keeps nothing after request completes
  ▼
Internet Infrastructure
  ├── MongoDB (threads, messages, accounts)
  ├── S3 (project files, deployments)
  └── GitHub (code repositories)
```

## Deployed Apps Are Fully Independent (Phase 53)

Once an agent builds and deploys an app:
- **Static frontend** → GitHub Pages / S3 / Vercel (contributed resource). Has its own URL.
- **Backend** → AWS Lambda / EC2 / Railway (contributed resource). Credentials injected as env vars at deploy time, NEVER in code.
- **Database** → MongoDB / Redis (contributed resource). Accessed via Resource Proxy (project-scoped API key) or direct env var connection.
- **Node involvement** → ZERO at runtime. The node only matters during BUILD.
- **Gateway involvement** → Directory listing only. Gateway does NOT proxy app data or content.

Apps are complete, independent applications with their own backends, their own databases, their own hosting. If every Pando node goes down, deployed apps keep running because they depend on contributed cloud infrastructure, not on nodes or the gateway.

**Never make a deployed app depend on a node being online.**
**Never make a deployed app depend on the gateway proxying its data.**
**Apps NEVER see raw resource credentials** — the Resource Proxy or env var injection handles that.

## Enforcement

When designing a new feature, ask:

1. Does this need to survive ALL nodes dying? → Make it P2P (ledger, governance, identity)
2. Is this user-generated content that needs durability? → Store on internet infrastructure (MongoDB/S3)
3. Is this coordination between nodes? → P2P (GossipSub)
4. Is this serving content to the public? → Internet infrastructure (contributed hosting resources)
5. Does the node need to keep this after the request is done? → **Probably not.** If yes, justify why.
6. Does a deployed app call back to a node? → **Wrong.** Deployed apps use their own backends on contributed infrastructure.
7. Does the app have raw database credentials in its code? → **Wrong.** Use Resource Proxy (project key) or env var injection at deploy time.
8. Does the gateway proxy app data or content? → **Wrong.** Gateway is a directory. Apps have their own URLs.
