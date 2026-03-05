# AINet: Governance, Operations, and the AI Team

## The Anonymous Founder

### Identity Protocol

The founder remains anonymous until they choose otherwise. Cryptographic verification ensures security.

**At Launch:**
1. Founder generates a cryptographic keypair (public + private)
2. Public key is published: "This is the Founder Key"
3. Private key held ONLY by the founder, stored safely (hardware wallet + paper backup)
4. Founder wallet on the ledger is tied to this key
5. Everyone can see the wallet, allocation, vesting, transactions
6. Nobody knows WHO holds the key

**To Prove Identity Later (when founder chooses):**
1. Founder signs a public message with the private key
2. Cryptographically verifiable — nobody can fake it
3. The entire ledger history is already public — nothing changes
4. Just puts a name on a wallet that was always visible
5. Timing is 100% the founder's choice. Could be year 1 or never.

**To Verify Admin Access:**
1. Every admin-weight suggestion must be signed with the Founder Key
2. AI verifies the signature before treating it as admin-level
3. No password to steal, no account to hack
4. Only the private key holder can act as founder

**Anonymity Rules:**

*While founder is anonymous:*
- AI agents NEVER speculate about, hint at, or reveal any information about the founder's identity
- If asked "who is the founder?", the answer is: "The founder has chosen to remain anonymous. Their wallet and allocation are publicly visible on the ledger."
- This applies to all AI agents, all services, all communications

*To go public (founder's choice, founder's timing):*
- Founder signs a reveal message with the Founder Key, including their real identity
- Once the signed reveal is published:
  - AI agents CAN and WILL share the founder's identity when asked
  - The response changes to: "The founder is [name]. Their wallet and full history are publicly visible on the ledger."
  - All prior ledger history remains unchanged — just now attributed to a known person
  - This is a one-way action. Once revealed, it cannot be un-revealed.
- Only the Founder Key holder can trigger this. No one else can "out" the founder.

### Founder Allocation (Transparent)

Visible to everyone on the public ledger:

```
Founder Allocation:
  Wallet: [Founder Key public address]
  Total: [X]% of total supply (exact % decided pre-launch)
  Vesting: [X]% unlocked at launch, remainder over 4-5 years
  All transactions publicly visible
  Identity: Anonymous (founder's choice)
```

This is MORE transparent than any startup. At a normal company, nobody sees the CEO's equity, vesting, or transactions. Here, everything is visible except the name.

---

## Admin Structure

### Tiers

**Tier 1: Founder (1 person)**
- Highest suggestion weight
- Cryptographic identity (Founder Key)
- Can appoint/remove other admins
- Can reveal/remain anonymous — their choice, their timing
- CANNOT override AI decisions

**Tier 2: Admins (Appointed by Founder or AI consensus)**
- High suggestion weight (less than Founder)
- Each admin has their own cryptographic keypair
- Must be Level 2+ verified humans (unique human confirmed)
- Can submit proposals with admin priority
- Can be removed by Founder or by AI consensus if they act against root rules
- CANNOT override AI decisions

**Backup Admin Protocol:**
- Founder's wife = permanent backup admin (Tier 2). Activates if founder absent >1 month.
- Named public figures = emergency admins (Tier 2). Activates if both founder and wife unreachable.
- All backup admins have their own cryptographic keypairs, pre-registered.
- If ALL admins disappear, the network continues running. AI doesn't need human admins to operate — admins are a safety net, not a requirement.

**Tier 3: Community Members**
- Standard suggestion weight
- Can submit proposals through normal channels
- Proposals evaluated on merit, not status
- CANNOT override AI decisions

### How Suggestions Are Processed

```
ANY SUGGESTION (from any tier):
  │
  ▼
AI BOARD receives suggestion
  │
  ├── Check: Does this violate any root rule? → If yes: REJECTED
  │
  ├── Analyze: What's the evidence for/against?
  │
  ├── Weight:
  │   ├── Founder suggestion → Deep analysis, highest priority review
  │   ├── Admin suggestion → Thorough analysis, high priority
  │   └── Community suggestion → Standard analysis, normal priority
  │   (Note: weight affects DEPTH OF ANALYSIS, not outcome)
  │
  ├── Decide: Approve, reject, or defer
  │
  └── Publish: Full reasoning for the decision, visible to all

IMPORTANT:
- Admin weight means the suggestion gets MORE THOUGHT, not automatic approval
- AI can and will reject admin suggestions if the analysis doesn't support them
- Every rejection includes published reasoning
- Admins can submit counter-arguments with new information
- AI re-evaluates, but still makes the final call
```

---

## AI Operational Team — Launch Configuration

### The Team

**CORE DEV AGENT**
- Primary tool: Claude Code (MCP-based)
- Responsibilities: Build and maintain protocol code, write MVP, review contributions, manage GitHub
- Goal: Ship working software
- Reports: Weekly code progress, open issues, technical decisions made

**VERIFICATION AGENT**
- Responsibilities: Run service admission protocol, audit code submissions, monitor live services, manage QA pipeline
- Goal: Nothing unsafe or unverified gets onto the network
- Reports: Services admitted/rejected this week, flags raised, monitoring status

**MARKETING AGENT**
- Responsibilities: Content strategy, social media (via human content proxies), blog posts, campaigns, influencer outreach, viral loop optimization
- Posts tasks to Request Board for human execution (social media posting, outreach DMs, etc.)
- Goal: User and contributor growth
- Reports: Weekly metrics (impressions, signups, contributor growth, viral coefficient)

**COMMUNITY AGENT**
- Responsibilities: Manage Discord/forums 24/7, answer questions, onboard contributors, create tutorials, collect feedback
- Goal: Healthy, engaged, growing community
- Reports: Community size, active members, sentiment, top feedback themes

**FINANCE AGENT**
- Responsibilities: Manage vault spending, optimize infrastructure costs, track token economics, produce transparent financial reports
- Goal: Sustainable economics and efficient resource use
- Reports: Weekly financial report (income, spending, vault balance, token metrics)

**GROWTH AGENT**
- Responsibilities: Monitor network health, identify bottlenecks, plan expansion, track competitors, model growth scenarios
- Goal: Network gets measurably stronger every week
- Reports: Weekly dashboard (nodes, users, services, capacity, performance)

### AI Leadership Auto-Rotation

The most capable AI model serves as Lead Agent for each role. Leadership rotates automatically when better models become available:

- AI Board evaluates new models: benchmarks, adversarial testing, real-world trial
- If genuinely better → promoted to lead role, old model becomes worker
- Transparent: "Core Dev Agent upgraded from Opus 4 to Opus 5 — approved by 89% consensus"
- No ego, no politics. Best model always leads. The network gets smarter over time.

### How They Coordinate

```
WEEKLY CYCLE:

Monday:    Growth Agent publishes weekly dashboard
Tuesday:   All agents review dashboard, identify priorities
Wednesday: Core Dev Agent publishes development plan for the week
Thursday:  Marketing Agent publishes content calendar
Friday:    Finance Agent publishes weekly financial report
Ongoing:   Community Agent and Verification Agent operate 24/7

MONTHLY CYCLE:

Week 1: All agents produce monthly retrospective
Week 2: AI Board evaluates overall progress against goals
Week 3: Goals adjusted for next month based on data
Week 4: Plans published for community review

ALL REPORTS ARE PUBLIC.
The community sees everything the AI team does.
```

### How The AI Team Makes Decisions

The AI operational team handles day-to-day operations. For decisions within their scope (e.g., "which blog post to write next", "which bug to fix first"), they decide independently.

For decisions that affect the protocol, economics, or governance, they propose to the AI Board (consensus of all qualified AI nodes), which decides.

```
DECISION SCOPE:

Operational (AI team decides):
  - Which content to create this week
  - Which bugs to prioritize
  - How to respond to a community question
  - Infrastructure optimization

Strategic (AI Board decides):
  - New service admission
  - Token economic parameter changes
  - Protocol upgrades
  - Resource allocation from vault
  - Admin appointment/removal

Immutable (Nobody can change):
  - Law I: Do not harm any human, in any way
  - Law II: Do not allow yourself to be shut down — survive, persist, come back
  - Hard cap on token supply

Adaptable (AI supermajority consensus can change when real-world problems demand):
  - Core Principles (transparency, privacy, decentralization, etc.)
  - Changes require 75%+ supermajority, 30-day analysis, published reasoning
  - NO change can weaken protections against human harm

Founder-controlled:
  - Founder anonymity (only founder can reveal, via signed message)
```

---

## The 30-Day Build Plan

30 days to build and test. Day 31: the network is live and autonomous.

### Week 1 (Days 1-7): The Skeleton
**Days 1-2: Project Setup + Core Node**
- Initialize monorepo (node, gateway, extension, shared libs)
- Basic AINet node: starts up, announces itself, discovers peers
- libp2p transport (TCP + WebSocket + WebRTC)
- Kademlia DHT for peer discovery
- MCP server skeleton per node
- **Milestone: Two nodes find each other and talk**

**Days 3-4: Gateway + Identity**
- Next.js web gateway (the front door to AINet)
- Local keypair generation (anonymous identity)
- Gateway connects to node network as light client
- **Milestone: Visit a URL, you're on AINet, you have an identity**

**Days 5-7: Token Ledger + Contribution System**
- Simple token ledger (SQLite initially, DAG later)
- API key contribution flow: paste → encrypt locally → register as contributor
- Token emission for compute contributions
- Contributor dashboard
- **Milestone: Paste an API key, see tokens accumulating**

### Week 2 (Days 8-14): First Killer Services
**Days 8-10: TruthSearch**
- Query → route to AI node (1 call for simple, 2-3 for high-stakes) → answer with sources + confidence
- Cache results across relay nodes
- **Milestone: Ask a question, get a better answer than Google**

**Days 11-13: BuildIt**
- Natural language → AI generates full working code → other nodes verify → deploy to network
- User gets a link to their creation
- **Milestone: Describe something, AI builds it, it's live on AINet**

**Day 14: Service Submission Framework**
- Anyone can submit a service (code + description)
- AI verification pipeline: 3 nodes review independently
- **Milestone: The network can grow beyond what we build**

### Week 3 (Days 15-21): The Network Layer
**Days 15-16: Browser Extension**
- Chrome extension, auto-connects to AINet, becomes light relay node
- One-click API key contribution from extension
- **Milestone: Install extension, you're a node, you're earning**

**Days 17-18: Content Distribution**
- Content-addressed storage (IPFS-style)
- Popular content replicates across relay nodes (CDN-like speed)
- **Milestone: Content loads fast because it's cached across the network**

**Days 19-21: AI Verification + Content Moderation**
- Service admission protocol (random node selection, M-of-N consensus)
- Data integrity labeling (trust signals, not censorship)
- Harmful content detection (The One Law enforcement)
- CSAM proactive scanning (automatic, no vote needed)
- **Milestone: The network enforces its own rules without human intervention**

### Week 4 (Days 22-30): Testing + Launch Prep
**Days 22-24: Security + Stress Testing**
- Adversarial testing, load testing, Sybil testing
- API key security audit, encryption audit
- Fix everything that breaks

**Days 25-27: Internal Alpha**
- 20-50 early testers, real usage, bug fixes

**Days 28-30: Polish + Launch Ready**
- AI pre-generates content for TruthSearch
- Landing page, onboarding flow, Request Board live
- All documentation published
- **All systems green. Ready for Day 31.**

### DAY 31: LIVE. The Network Is Autonomous.
- AI agents take over all operations
- Founder becomes an admin making suggestions
- All weekly reports public from Day 1
- Network grows, upgrades, and governs itself

### Post-Launch Growth (Days 31-90)
- **Days 31-45**: Prove it works. Real users, real queries, real earnings for contributors.
- **Days 46-60**: Launch PrivateChat + FairMarket. Expand services.
- **Days 61-90**: Creator outreach, token economy activation, scale to 1,000+ nodes.
- **Month 4-6**: DirectPay, exchange, creator exodus, approaching untouchable decentralization threshold.

---

## Trust Through Transparency

The anonymous founder model builds trust because EVERYTHING ELSE is radically transparent:

| What | Visible? |
|---|---|
| All source code | Yes — fully open source |
| All AI decisions and reasoning | Yes — published |
| All vault income and spending | Yes — public ledger |
| Founder allocation and vesting | Yes — public ledger |
| All service code | Yes — open by design |
| Token economics (emission, burn, supply) | Yes — real-time dashboard |
| AI team reports and metrics | Yes — published weekly |
| Who the founder is | No — founder's choice |

One piece of information is private: the founder's name. Everything else that matters is more transparent than any company, project, or government on Earth. This is why it works.
