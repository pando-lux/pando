# AINet: 30-Day Build Plan

## Goal

30 days to build and test in stealth. Private testing with founder + AI agents until everything is solid. Go public only when ready — no rushed launch.

---

## What The MVP Looks Like On Day 30

A real, working product accessible from any browser:

| Feature | Status on Day 30 |
|---|---|
| Web gateway (visit a URL, you're on AINet) | Working |
| TruthSearch (verified, sourced answers) | Working |
| BuildIt (describe it, AI builds it) | Working |
| API key contribution (paste key, earn tokens) | Working |
| Browser extension (become a node) | Working |
| Token ledger (earn, spend, see balance) | Working |
| AI verification (services reviewed before going live) | Working |
| Content moderation (The Two Laws enforced) | Working |
| Multiple relay nodes | Running |

**What it's NOT on Day 30** (comes post-launch, built BY the network):
- Full DAG ledger (simple database first)
- Full M-of-N consensus with thousands of nodes (simplified threshold)
- Exchange, marketplace, fiat ramp
- Mobile app (browser gateway works on phones)
- Physical infrastructure

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Language | TypeScript / Node.js | Fastest dev speed, browser + server, Claude Code excels at it |
| P2P | libp2p (JS implementation) | Battle-tested, same as IPFS, works in browser |
| Gateway | Next.js | Fast SSR, good UX, deploys anywhere |
| Database | SQLite → distributed later | Simple, fast, no setup, replaceable |
| Browser Extension | Chrome Manifest V3 | Largest market share, Firefox port later |
| AI Layer | Claude API + contributed keys | Best code generation, MCP-native |
| Storage | IPFS (JS) + S3 backstop | Content-addressed + cloud backup |
| Real-time | WebRTC + WebSocket | Direct P2P + signaling |
| Hosting (Day 1) | Founder's AWS | Replaced by community nodes rapidly |

---

## Day-By-Day Plan

### WEEK 1 (Days 1-7): The Skeleton

**Days 1-2: Project Setup + Core Node**
- Initialize monorepo: `packages/node`, `packages/gateway`, `packages/extension`, `packages/shared`
- Build basic AINet node software:
  - Starts up, generates identity (keypair)
  - Connects to libp2p network
  - Discovers peers via Kademlia DHT
  - Sends/receives messages
- Basic MCP server skeleton per node (expose capabilities)
- Node-to-node encrypted messaging
- Config: node type, API key (optional), resource limits
- **Deliverable: Two nodes on different machines find each other and communicate**

**Days 3-4: Gateway + Identity**
- Next.js web gateway application
  - Landing page: What is AINet + how to contribute
  - Search/query interface (the main UX)
  - Service browser (list of live services)
- Local keypair generation in browser (your anonymous identity)
- Session management via keypair (no login, no password)
- Gateway connects to node network as lightweight MCP client
- **Deliverable: Visit gateway URL → you're on AINet → you have an identity**

**Days 5-7: Token Ledger + Contribution System**
- Token ledger (SQLite database tracking balances and transactions)
  - Accounts (public key → balance)
  - Transactions (from, to, amount, signature, timestamp)
  - Emission records (work completed → tokens minted)
- API key contribution flow:
  - User pastes API key in gateway/extension
  - Key encrypted with user's public key, stored locally only
  - Node registers as API contributor with capability + monthly cap
  - Network can route AI tasks to this node
- Contribution tracking: tasks completed, API costs incurred, tokens earned
- Basic contributor dashboard (real-time stats)
- **Deliverable: Paste API key → see tasks being processed → see tokens accumulating**

---

### WEEK 2 (Days 8-14): First Killer Services

**Days 8-10: TruthSearch**
- Query interface: user types a question
- Smart routing:
  - Simple query → 1 AI node answers
  - High-stakes query (medical, financial, legal) → 2-3 nodes answer independently, cross-verify
- AI classifier determines query type (instant, lightweight)
- Response format:
  - Clear, direct answer
  - Sources cited (with links where available)
  - Confidence score (how sure the network is)
  - Trust label ("Verified by N independent AI nodes")
- Result caching: identical/similar queries served from cache
- **Deliverable: Ask a question → get a verified answer with sources → better than Google**

**Days 11-13: BuildIt**
- Input: natural language description ("Build me a portfolio website with dark mode")
- AI generates full working code (HTML/CSS/JS or React)
- Code submitted to verification pipeline (other AI nodes review)
- If approved: deployed to relay nodes, accessible via gateway
- User gets a permanent link to their creation
- Basic templates for common requests (portfolio, blog, landing page, todo app)
- **Deliverable: Describe something → AI builds it → it's live on AINet in minutes**

**Day 14: Service Submission Framework**
- Service submission form (upload code + description + metadata)
- AI verification pipeline:
  - 3 randomly selected AI nodes review independently
  - Each checks: open source, no hidden behavior, matches description, safe
  - Requires 3-of-3 approval at launch (conservative, relaxes over time)
- Admission certificate stored on ledger
- Service deployed to relay nodes and accessible via gateway
- **Deliverable: Anyone can submit a service → AI verifies → it's live**

---

### WEEK 3 (Days 15-21): The Network Layer

**Days 15-16: Browser Extension**
- Chrome extension (Manifest V3)
  - Auto-connects to AINet P2P network via WebRTC
  - Becomes a light relay node (routes traffic, caches content)
  - Status badge: "Helping AINet — X tasks relayed"
  - One-click API key contribution
  - Token balance display
  - Quick access to TruthSearch and BuildIt
- **Deliverable: Install extension → you're a node → you're earning**

**Days 17-18: Content Distribution**
- Content-addressed storage (hash-based, IPFS-style)
- Upload: content chunked → hashed → stored on multiple relay nodes
- Retrieval: request by hash → nearest node serves it
- Popular content auto-replicates (more requests = more copies = faster)
- Gateway serves cached content (CDN-like performance)
- **Deliverable: Content loads fast because it's distributed and cached**

**Days 19-21: AI Verification + Content Moderation**
- Full service admission protocol:
  - Random node selection from qualified pool
  - Independent review + consensus
  - Admission/rejection with published reasoning
- Content moderation pipeline:
  - **Automatic removal**: CSAM detection (hash matching + AI scanning), direct harm instructions, doxxing
  - **Consensus evaluation**: Edge cases flagged for Tier 3 node review
  - **Protected content**: Political speech, opinions, personal freedom content — never removed
- Data integrity labeling: trust scores on all user-generated content
- Continuous monitoring: runtime behavior checks on admitted services
- **Deliverable: The network enforces The One Law automatically**

---

### WEEK 4 (Days 22-30): Testing + Launch Prep

**Days 22-24: Security + Stress Testing**
- Adversarial testing: attempt to trick AI verification with malicious code
- Load testing: simulate 1,000 concurrent gateway users
- Sybil testing: attempt to register fake nodes, verify they can't govern
- API key security audit: confirm keys never leave devices, calls are local
- Encryption audit: confirm private messages are actually E2E encrypted
- Transaction testing: verify ledger correctness, no double-spends
- Fix every issue found

**Days 25-27: Internal Alpha**
- Invite 20-50 trusted early testers
- Real usage: TruthSearch queries, BuildIt requests, API key contributions
- Bug reports collected and prioritized
- Performance data gathered
- UX feedback incorporated
- Daily fix cycles

**Days 28-29: Polish + Content Seeding**
- AI pre-generates verified knowledge base content for TruthSearch
- Bridge nodes pull verified public data (Wikipedia, open datasets, public research)
- Landing page finalized
- Contributor onboarding flow polished
- Request Board live (shows what the network needs)
- All documentation published: The Two Laws, Core Principles, architecture, content moderation framework

**Day 30: Launch Ready**
- All systems tested and green
- Multiple relay nodes running (founder AWS + early contributors)
- Gateway accessible and fast
- TruthSearch returning quality results
- BuildIt creating functional sites/tools
- Browser extension installable and working
- Token system functional (earning + basic spending)
- AI verification active and catching bad submissions
- Content moderation detecting harmful content
- **GREEN LIGHT FOR DAY 31**

---

## DAY 31+: STEALTH TESTING

- Founder + AI agents test everything thoroughly
- Stress test services, token system, verification, content moderation
- Fix issues. No deadline pressure. Ship when it's right.
- Invite small group of trusted testers when founder is satisfied
- Iterate until everything is solid

## PUBLIC LAUNCH (When Founder Says Go)

- **AI agents take over all operations** (Core Dev, Verification, Marketing, Community, Finance, Growth)
- **The founder becomes an admin** — suggestions, not orders
- **Weekly reports are published** — transparent from Day 1
- **The network governs itself** — upgrades, fixes, grows autonomously
- **Anyone can suggest improvements** — AI evaluates on merit, implements if good

---

## Post-Launch Milestones

| Timeline | Target |
|---|---|
| Day 31-45 | 100+ API key contributors, 1,000+ gateway users, TruthSearch handling real queries |
| Day 46-60 | Launch PrivateChat, begin FairMarket, 500+ contributors |
| Day 61-90 | Token economy active, 1,000+ nodes, creator outreach begins |
| Month 4-6 | DirectPay, exchange, creator exodus viral loop, 5,000+ nodes |
| Month 6-12 | 10,000+ nodes across 20+ countries, approaching untouchable threshold |
| Month 12+ | Self-sustaining. Network survives any single provider going down. |

---

## What Could Go Wrong (And The Fixes)

| Risk | Fix |
|---|---|
| Not enough contributors at launch | Pre-recruit 50-100 committed API key contributors before Day 30 |
| TruthSearch gives bad answers | Conservative confidence scoring. "We're not sure" > wrong answer. |
| Government attention too early | MVP is boring-useful (search + build). Not controversial. |
| Bugs in token system | Start small, audit constantly, AI monitors anomalies |
| Network too slow | Relay caching + CDN architecture. Optimize hot paths. |
| Founder's AWS shuts down | By Day 31+, community nodes running. Distributed. |
| Contributor enthusiasm fades | Early multipliers (5x first 100), visible token earnings, weekly public progress |

---

## Pre-Build Checklist (Before Day 1)

- [ ] Secure domains (ainet.org, ainet.network, etc.)
- [ ] Set up GitHub repo (private initially, open-source at launch)
- [ ] File trademark for "AINet" in US
- [ ] Set up Discord for early community
- [ ] Founder AWS account ready with budget
- [ ] Pre-recruit 20+ committed early testers
- [ ] Founder generates cryptographic keypair (Founder Key)

---

*30 days to build. Then it lives on its own.*
