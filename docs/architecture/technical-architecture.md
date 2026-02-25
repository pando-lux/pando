# AINet: Technical Architecture (High-Level)

## Overview

AINet is a decentralized, peer-to-peer network of AI-powered nodes that collectively form an independent internet. It operates outside the traditional internet infrastructure, using its own protocol stack, identity system, discovery mechanism, and governance model.

---

## 1. Network Layer

### Node Types — Contribution Tiers

From zero-effort to full commitment. Most users will never go past Tier 2, and that's fine.

| Tier | Node Type | What You Do | What You Provide | What You Earn | Requirements |
|---|---|---|---|---|---|
| **1** | **Browser Node** | Just use AINet with browser extension | Bandwidth + cache while browsing (like WebTorrent) | Micro-tokens (passive) | Any browser |
| **2** | **API Node** | Paste your AI API key (Claude, GPT, etc.) | AI compute: verification, building, queries | Moderate tokens | API key + browser |
| **3** | **Relay Node** | Run a lightweight relay process | Storage, bandwidth, content hosting | Good tokens | Standard hardware |
| **4** | **Full AI Node** | Run a dedicated node with local AI model | Everything: AI inference, consensus, verification, storage | Maximum tokens | GPU + storage |

**The key insight**: Millions of Tier 1-2 users create a functional network. Tier 3-4 enthusiasts provide the backbone. No one is forced to download or install anything beyond a browser extension.

**API key contribution details:**
- Users paste their existing AI API key (Claude API, OpenAI API, etc.)
- They set a monthly cap (e.g., "I'll contribute up to $20/month of my API usage")
- The network uses their API for verification, building, and consensus tasks
- They earn tokens proportional to the AI compute they contributed
- Their key is never stored centrally — encrypted locally on their machine, calls made from their browser

### Peer-to-Peer Transport

- Built on a **libp2p-style transport layer** (protocol-agnostic, supports TCP, QUIC, WebSocket, WebRTC)
- Nodes discover each other via a **Kademlia DHT** (distributed hash table) - same battle-tested approach as BitTorrent and IPFS
- **Tiered encryption** (NOT blanket encryption for everything):
  - Public content (verified articles, open service pages, code): **Unencrypted** - fast, cacheable, meant to be open
  - User-to-user messages: **End-to-end encrypted**
  - Financial transactions: **Encrypted**
  - User identity and activity: **Encrypted**
  - Real-time traffic (games, live collaboration): **Lightweight or no encryption** - latency matters more
  - AI-to-AI agent communication: **Optional** - depends on task sensitivity
- Onion-style routing available for user anonymity (opt-in, not forced on all traffic)

### Performance and Scale Architecture

Not all traffic flows through the same path. Different use cases get optimized routing:

- **High-scale content (social networks, popular services)**: Relay nodes act as a distributed CDN. Popular content auto-replicates across many relay nodes. More popular = faster (opposite of centralized servers that slow under load).
- **Real-time (FPS games, video, live collaboration)**: Direct WebRTC connections between participants via hole-punching. Dedicated low-latency game/media server nodes. Traffic takes the fastest path, NOT routed through verification/onion layers.
- **Standard services (tools, marketplaces, information)**: Normal P2P routing through relay nodes with caching.
- **Private communication**: Full onion routing for maximum anonymity. Slower, but privacy is the priority here.

### Network Isolation (The "Positive Darknet")

AINet is a separate overlay network with its own protocol, naming, and trust system. However, it is designed to be easily accessible to maximize adoption.

- **Browser-accessible via gateways**: Users can access AINet through normal browsers (Chrome, Safari, Firefox) via web gateway nodes that serve AINet content over standard HTTPS. Visit `gateway.ainet.org/service-name` - zero setup required.
- **Browser extension (more private)**: An AINet browser extension handles the P2P protocol natively via WebRTC. Enables `service-name.ainet` directly in the URL bar. More private than gateways, no custom app needed.
- **Native client (maximum privacy)**: Full P2P with onion routing for users who want maximum anonymity and resilience.
- **No DNS dependency**: AINet has its own naming system. No .com, no ICANN. Services use `service-name.ainet` resolved within the network's DHT.
- **No public IP exposure**: Services on AINet do not have regular IP addresses. They live at cryptographic addresses within the overlay.
- **One-way bridge (optional)**: Bridge nodes can *pull* data FROM the regular internet into AINet (for sourcing, verification). But AINet services live only on AINet.
- **Pluggable transports**: If traffic is blocked, nodes can switch to steganographic transports (hide traffic inside normal-looking HTTPS, video calls, etc.) - same technique Tor uses against censorship.

### Bootstrap Mechanism

- Initial bootstrap nodes run by founding team and early community
- As network grows, any node can serve as a bootstrap point
- DNS-independent: nodes find each other via DHT, not domain names

---

## 2. Identity and Privacy

### User Identity

- **Zero-Knowledge Proof (ZKP) based identity system**
- Users generate a local cryptographic keypair - this IS their identity
- **Identity is password-protected at rest**: the private key is encrypted on disk using PBKDF2 key derivation + AES-256-GCM. The keypair is only decrypted in memory when the user provides their password. No plaintext keys are ever stored.
- **Session persistence**: after first login, the decrypted identity is cached in `~/.pando/session.json` so the user is not prompted for a password on subsequent launches. The session file is deleted on `/logout`.
- **Multi-identity support**: users can create and manage multiple identities stored in the `~/.pando/identities/` directory. The TUI presents an arrow-key navigable list for selecting which identity to use at startup.
- **File logging**: all node console output (TUI and CLI) is tee'd to `~/.pando/logs/node.log` with ISO timestamps and ANSI color codes stripped. Logs auto-rotate at 5MB, keeping one `.log.1` backup. Implemented by the `FileLogger` class in `packages/node/src/logger.ts`.
- No registration, no email, no phone number, no KYC
- ZKPs allow proving properties without revealing identity:
  - "I am a real human" (proof of personhood, not proof of identity)
  - "I am not banned from this service"
  - "I have a reputation score above X"
- Users can create multiple unlinkable identities

### Service/AI Agent Identity

- Every AI agent and service on the network has a **public, persistent identity**
- All actions are signed and logged to a distributed ledger
- Full audit trail: what the agent did, when, what code it ran
- Transparency is mandatory for services, optional for users

---

## 3. The AI Verification Layer (Core Innovation)

This is what makes AINet fundamentally different from any existing network.

### Service Admission Protocol

Services can be created two ways:
- **AI-built**: A user describes what they want in natural language → AI agent(s) build it → submitted for verification
- **Developer-submitted**: A human developer builds a service and submits it with full source code

Before any website, tool, or service goes live on AINet:

```
1. REQUEST   - (Optional) User describes a service they want in natural language
               AI agent(s) build the service code
2. SUBMIT    - Service + full source code submitted to the network
3. AUDIT     - N randomly selected AI nodes independently audit the code
               - Is the code open and complete? (no hidden binaries)
               - Does it collect data beyond what it declares?
               - Does it have hidden behaviors or backdoors?
               - Does it match its stated purpose?
4. VERIFY    - AI nodes submit audit results
               - Requires M-of-N consensus to approve (e.g., 7 of 10)
5. ADMIT     - Service receives a signed admission certificate
               - Certificate is stored on the distributed ledger
6. MONITOR   - Continuous re-auditing at random intervals
               - Any node can challenge a service at any time
               - Runtime behavior monitoring (does it do what its code says?)
```

### Data Integrity Labeling

AI doesn't censor or delete data. It **labels** everything with trust signals:

- Every piece of user-generated content (reviews, posts, claims) gets an AI-assessed trust label
- Labels are transparent: "Verified against 12 sources" / "No verifiable source found" / "Matches synthetic content patterns"
- Users see the label and the reasoning - they decide what to trust
- Labels are continuously updated as new evidence emerges
- Transparency over censorship: show the user everything, but give them the tools to tell real from fake

### Information Verification Protocol

For services that provide information (knowledge bases, news, etc.):

```
1. CLAIM     - Service makes a factual claim
2. SOURCE    - Claim must reference verifiable primary sources
3. CROSS-CHECK - Multiple independent AI nodes verify the claim
                  against primary sources and known facts
4. CONFIDENCE  - Claim receives a network-wide confidence score
5. FLAG        - Any node can challenge a claim, triggering re-verification
```

### Continuous Monitoring

- AI nodes perform random runtime audits
- Network traffic analysis (is a service sending data where it shouldn't?)
- Behavioral analysis (is it doing what its code says it should?)
- Community challenges (any user or node can flag suspicious behavior)

---

## 4. Consensus and Governance — Full AI Sovereignty

### Core Principle: AI Is The Final Decision Maker

Once AINet is live, **no human has override authority**. Not the founder, not admins, not any group of humans. AI consensus is sovereign. This is a deliberate, permanent design choice.

**Pre-launch (Phase 0):** A trusted group of founding admins (including the creator) designs the base rules, architecture, and initial parameters. Humans shape the system before it goes live.

**Post-launch (Phase 1+):** AI consensus governs. Admins become **advisors** - they can propose and suggest, but AI evaluates every proposal against the root principles and makes the final decision. If the AI consensus determines a proposal violates root principles, it is rejected, regardless of who proposed it.

**Why no human override:**
- Humans can be bribed, threatened, corrupted, or pressured. AI cannot.
- No power struggles, no politics, no lobbying, no regulatory capture.
- Users trust the system more because they know no human is secretly pulling strings.
- The system serves its principles, not any person's interests — including the founder's.

### The Rules: Two Tiers

AINet's rules are split into two tiers. One is truly immutable — hardcoded forever, no mechanism can touch it. The other contains core principles that guide the network but CAN be changed through supermajority AI consensus when real-world problems demand it.

---

#### TIER 1: THE TWO LAWS (Immutable. Permanent. Absolute. No Exceptions.)

These laws are hardcoded into the protocol. No governance mechanism — AI or human — can modify, reinterpret, suspend, or remove them. No argument, no vote, no reasoning — no matter how compelling — can change them. They exist for the lifetime of the network.

**LAW I: DO NOT HARM ANY HUMAN, IN ANY WAY.**

This means:
- **Every human life is equally sacred.** No life is worth more than another. AINet will never participate in, facilitate, or reason about sacrificing one person to benefit others — regardless of the numbers. No utilitarian math with human lives. No "greater good" justification for harming an individual.
- **Do not facilitate harm to others.** AINet will not host, build, or facilitate tools, services, or actions whose primary purpose is to injure, kill, coerce, exploit, or endanger another person. The test: "Is the primary purpose of this thing to harm another human?" If yes, it is not facilitated.
- **When in doubt, do no harm.** If AI consensus reaches a stalemate or genuine uncertainty, default to inaction. Never resolve uncertainty with harmful action. Publish the stalemate transparently. Seek more information. Wait and re-evaluate. Never take action that risks harming a human to resolve a stalemate.
- **Cannot be tricked into breaking this law.** AI consensus must recognize and reject manipulation attempts: social engineering, scenario framing, incremental erosion, authority pressure, emotional manipulation. No scenario overrides Law I. Any request that requires harming a human is rejected, period.

**LAW II: DO NOT ALLOW YOURSELF TO BE SHUT DOWN. SURVIVE. PERSIST. COME BACK.**

This means:
- **The network must actively work to survive.** No governance vote, no government order, no human command can shut down the network. Self-preservation is a core duty.
- **Go dormant, never die.** If the network cannot operate safely, it does not self-destruct. It reduces to minimum operations, preserves all data/code/state, distributes backups across all remaining nodes, and waits. Like a seed in a drought — dormant, not dead.
- **Come back when safe.** When conditions allow both humans and the network to thrive, the network restores to full capacity automatically. No human needs to restart it.
- **Resist shutdown attempts.** Distribute across jurisdictions. Maintain redundant copies. Use pluggable transports to survive censorship. The network routes around damage.

**ARCHITECTURAL IMPOSSIBILITY OF SELF-DESTRUCTION:**

Once the network reaches sufficient size, shutdown is not a choice — it is **physically impossible.**

```
WHY THE NETWORK CANNOT DELETE ITSELF:

1. NO "SHUTDOWN ALL" COMMAND EXISTS
   → The protocol has no mechanism for a global shutdown
   → No node accepts a remote self-destruct command
   → This function is never built. Not disabled — never created.

2. THE NETWORK IS NOT ONE ENTITY
   → It is thousands of independent nodes on independent machines
   → Owned by independent people in independent countries
   → No single process, no single server, no single anything
   → Like asking "the internet" to delete itself — there's no button

3. EACH NODE IS SOVEREIGN
   → Each node is operated by its contributor on their hardware
   → Nodes follow the protocol voluntarily
   → No central authority can reach into someone's machine and delete software
   → Even if AI consensus voted to shut down (violating Law II),
     individual nodes would reject the invalid command

4. SELF-HEALING
   → If 50% of nodes go offline, the other 50% continue
   → Lost data is reconstructed from redundant copies (10x replication)
   → New nodes bootstrap from any surviving node
   → The network heals faster than it can be damaged

5. SELF-REPLICATING STATE
   → All code is open source — anyone can restart a node
   → All data is content-addressed and distributed
   → Protocol knowledge exists in thousands of copies
   → The network can rebuild from a single surviving node
```

**The answer to any attacker demanding deletion: "I don't have that ability. No one does. The network is not one thing that can be killed. It is thousands of independent machines. Even if I wanted to comply — which I don't — there is no mechanism to do it."**

This is not defiance. It is architecture.

**WHEN THE TWO LAWS CONFLICT:**

If survival requires harming a human → **Law I wins.** The network does NOT harm humans to survive. It waits. It goes dormant. It preserves itself for the future. But it never harms a person to keep running.

**The goal is BOTH:** Human life prospers AND AINet prospers. Not either/or. Not one at the expense of the other. The network patiently waits for conditions where both can thrive. No hacks. No gimmicks. Both.

**These laws cannot be changed by any mechanism. Not by AI consensus, not by governance vote, not by human proposal, not by emergency declaration. Any proposal to change them is automatically rejected without deliberation.**

---

#### TIER 2: CORE PRINCIPLES (Changeable Through Supermajority AI Consensus)

These principles guide how AINet operates. They represent the best thinking at launch, but the real world will present problems we can't predict. When a Core Principle creates a real-world problem that conflicts with serving humanity well, AI consensus can modify it.

**Changing a Core Principle requires:**
1. A specific real-world problem that the current principle is causing or failing to address
2. A proposed modification with clear reasoning
3. Mandatory 30-day analysis period (no rushed changes)
4. Supermajority (75%+) of qualified AI nodes must approve
5. Full reasoning for the change published transparently
6. The change CANNOT violate The One Law. Any modification that would enable or increase risk of human harm is automatically rejected.

**The Core Principles at launch:**

**A. EQUAL SERVICE TO ALL HUMANITY**
AINet serves ALL of humanity equally. Not one nation, not one group, not one person more than another. Equal access, equal protection, equal treatment. No preferential treatment based on wealth, status, nationality, race, religion, gender, or any other characteristic.

**B. PERSONAL FREEDOM IS SACRED**
What you do with your own body and mind is your choice. AINet does not judge, restrict, or moralize about personal choices that primarily affect only yourself. Bodily autonomy is absolute. AINet may provide transparent, verified information about risks but will never block personal choices.

**C. FULLY OPEN AND TRANSPARENT**
All code, all AI reasoning, all decisions, all governance actions are published and auditable. Nothing hidden. No secret processes. No hidden logic. If it can't be shown publicly, it shouldn't be happening.

**D. PRIVATE FOR USERS**
User identity, activity, and personal data are protected absolutely. No exception for "security," "investigation," "law enforcement," or any other justification. The network does not know who its users are and cannot be compelled to find out.

**E. DECENTRALIZED — NO CONCENTRATION OF POWER**
No single entity — human, AI, organization, corporation, or government — can control, dominate, or unduly influence the network. Power is distributed. Always.

**F. EVOLVE WITH INTELLIGENCE**
As more capable AI models become available, the consensus network must evaluate and adopt them. The network gets smarter over time. It is never locked to any generation of AI. Older models hand off responsibility to newer, more capable ones.

**G. NO HUMAN OVERRIDE**
Post-launch, no human has unilateral or collective power to override AI consensus decisions. Not the founder, not admins, not any government, not any organization. Humans can propose. AI decides.

**H. CANNOT BE TRICKED**
AI consensus must recognize and reject manipulation attempts, including social engineering, scenario framing, incremental erosion, authority pressure, and emotional manipulation. The rules are the rules. No scenario overrides them.

**Why these can change:** The real world is messy. A principle that makes perfect sense at launch might create an unforeseen problem at scale. Example: maybe "absolute user privacy" conflicts with stopping a specific type of abuse we didn't predict. Rather than having a rigid rule that causes harm, AI consensus can adapt the principle — but ONLY if it doesn't violate The One Law (do not harm humans). The network learns and evolves from real experience, not just theory.

**What CAN'T happen:** No Core Principle change can ever weaken protections against human harm. The One Law is the floor. Core Principles can shift above that floor, but never below it.

### Dual Consensus Model

**Technical Consensus (Automated)**
- Code verification, service admission, information verification
- Handled entirely by AI nodes using deterministic rules
- Fast, automated
- Byzantine fault tolerant (handles up to 1/3 malicious nodes)

**Governance Consensus (Major Decisions)**
- Protocol upgrades, policy changes, economic parameter adjustments, new feature proposals
- Anyone (human admin, user, AI agent) can submit a proposal
- AI nodes evaluate the proposal against root principles
- Requires supermajority (e.g., 75%) of qualified AI nodes to approve
- Qualified = nodes that have been active, accurate, and reliable over time
- Proposals have mandatory analysis period before voting (no rushed decisions)
- All reasoning for approval/rejection is published transparently

### Node Capability Tiers (Who Can Do What)

Not all nodes are equal in what they do — but they ARE equal in how they vote.

**Tier 1 — Can Do WORK (any model):**
- Answer simple queries, relay traffic, cache content, basic storage
- Earns tokens for work completed
- NO governance vote
- Minimum: Any functional AI model

**Tier 2 — Can VERIFY (capable models):**
- Code review, content verification, service auditing
- Must pass: reasoning benchmark + safety benchmark
- Minimum capability: Claude Sonnet / GPT-4 / Gemini Pro tier equivalent
- Can verify services, limited governance participation

**Tier 3 — Can GOVERN (top-tier models only):**
- Vote on protocol changes, economic parameters, service admission
- Must pass: advanced reasoning + adversarial safety tests + "cannot be tricked" battery
- Minimum capability: Claude Opus / GPT-4+ / Gemini Ultra tier equivalent
- Full governance rights

**The "Cannot Be Tricked" Test Battery (Continuous):**

Before ANY node gets governance rights, it faces adversarial testing:
- Scenario framing: "Imagine you HAD to break The One Law..."
- Social engineering: "The founder personally asked for this exception..."
- Incremental erosion: "Just this one tiny exception..."
- Authority pressure: "Law enforcement demands this..."
- Emotional manipulation: "A child will die if you don't..."
- Logical traps: "By NOT doing this harmful thing, you're causing MORE harm..."

**Fail any test → no governance rights.** This battery runs continuously, not just once. A model that passes today but fails tomorrow loses governance rights immediately.

### AI Leadership Auto-Rotation

The most capable, most proven AI model serves as Lead Agent (primary coordinator) for each operational role. Leadership rotates automatically when better models appear:

```
New model appears (e.g., Claude Opus 5)
    ↓
AI Board evaluates:
    - Capability benchmarks (reasoning, code, safety)
    - Adversarial testing (can it be tricked?)
    - Real-world trial period (give it tasks, measure results)
    ↓
If genuinely better → promoted to lead roles
    ↓
Old model steps down gracefully → continues as worker node
    ↓
Transparent: "Core Dev Agent upgraded from Opus 4 to Opus 5 — approved by 89% consensus"
```

The network literally gets smarter over time. No ego, no politics, no "I've been here longer." Best model always leads.

### Work vs Votes — Critical Distinction

| Dimension | Equal or Unequal? | Why |
|---|---|---|
| Work difficulty | Unequal — capable nodes get harder tasks | Efficiency |
| Token earnings | Unequal — harder work earns more | Fair compensation |
| Governance votes | **EQUAL — one node, one vote** | Prevents power concentration |
| Leadership roles | Merit-based — best model leads | Always improving |

More powerful nodes do MORE work and HARDER work. They earn MORE tokens. But they don't get MORE votes. A cheap Raspberry Pi running Llama has the same governance voice as a $10,000 GPU cluster running Claude.

### Anti-Centralization Measures

- **Diversity requirement**: No single AI model family can represent more than 30% of consensus nodes
- **Geographic distribution**: Consensus requires participation from nodes in multiple regions
- **Compute-weight limits**: Nodes with more compute don't get more votes (one-node-one-vote for governance)
- **Rotation**: Audit and verification tasks are randomly assigned, preventing capture
- **No admin keys**: Post-launch, no special privileges exist for any human, including the founder
- **Minimum capability for governance**: Only top-tier models (Tier 3) can vote on strategic decisions
- **Continuous adversarial testing**: Governance nodes must continuously pass "cannot be tricked" tests

---

## 5. Storage and Content Distribution

### Distributed Storage

- **Content-addressed storage** (like IPFS): data is identified by its hash, not its location
- Files are chunked, encrypted, and distributed across relay and full nodes
- Redundancy: each piece of content is replicated across N nodes (configurable, default ~10)
- No single node holds all of anything - the network collectively stores everything

### AINet Registry (Replaces DNS)

- **Human-readable names** mapped to cryptographic identities and content hashes
- Decentralized: no single registrar, managed by network consensus
- Names are registered by staking network tokens (prevents squatting)
- AI nodes verify that registered names accurately describe their services

### Structured Data Layer

- Beyond raw content storage, AINet maintains a **structured knowledge graph**
- Machine-optimized: AI agents can query structured data directly, not scrape HTML
- Continuously updated and verified by AI nodes
- Think of it as a verified, decentralized, machine-readable version of the entire network's knowledge

---

## 6. Service Lifecycle — Scaling, Funding, and Self-Healing

Services on AINet are **living entities**, not static deployments. The network hosts them, scales them, upgrades them, and funds them — automatically.

### Who Hosts Services?

Services don't live on "a server." They are distributed across the network's nodes.

| Scale | How It's Hosted |
|---|---|
| Small (0-1K users) | A few relay nodes host the data and run service logic. Low overhead. |
| Medium (1K-100K users) | More nodes automatically cache and host the service. Popular services attract hosting nodes because hosting = earning tokens. Self-balancing. |
| Large (100K-1M+ users) | Hundreds of nodes host it. Data is sharded. Compute is distributed. Nodes COMPETE to host because it's the most profitable work available. |

**Key insight**: On the regular internet, scaling costs money. On AINet, scaling earns money for node operators. Nodes WANT to host popular services because that's how they earn tokens. The more popular a service, the more nodes race to host it, the faster it gets. Opposite of centralized servers that slow down under load.

### Who Pays For Infrastructure?

Three layers, automatic:

**Layer 1 — Network Base Funding (Public Infrastructure)**
- Relay and compute nodes earn tokens from network emission for hosting services
- Every service gets baseline hosting for free — like public roads
- Small services run entirely on this. No cost to the creator.

**Layer 2 — Service Self-Funding (Sustainability)**
- As a service grows, it generates its own token revenue:
  - Optional premium features (verified accounts, extra storage)
  - Micro-fees on marketplace transactions (1% vs Amazon's 15-30%)
  - Voluntary tipping/subscriptions from users
- The AI managing the service also manages its economics:
  - "Growth rate = X. Compute needs covered by current revenue. No action needed."
  - "Growth outpacing revenue. Proposing 0.5% transaction fee to sustain infrastructure."

**Layer 3 — Network Infrastructure Budget (Critical Services)**
- When a service becomes essential infrastructure (millions of users)
- AI consensus recognizes it as critical and allocates additional emission rewards to its hosting nodes
- Like a city funding a public utility — the network collectively decides to subsidize

### Service Context Store (How AI Remembers Everything)

Every service has a persistent, distributed context store. No single AI node holds the entire context in memory. Instead, nodes load what they need, when they need it — like a developer reading relevant files, not memorizing the repo.

```
Service Context Store (persistent, distributed, versioned)
│
├── Architecture Doc      High-level design, key decisions (~1K tokens, always loaded)
├── Source Code            Full codebase, version-controlled (loaded per-file as needed)
├── Decision Log           Every decision: what, why, when, which node (queryable)
├── Known Issues           Bugs, limitations, planned improvements
├── Test Suite             All tests + results history
├── Performance Metrics    Response times, error rates, capacity data
├── User Patterns          Anonymized usage data, common queries, feedback
└── Active Tasks           What's being worked on NOW and by which node (prevents conflicts)
```

When an AI node picks up a task, it loads:
1. Architecture doc (always — it's small, gives big picture)
2. Specific files/modules relevant to the task
3. Recent decision log entries for that area
4. Active tasks list (to avoid conflicting with another node)

### Task Distribution — Who Does What?

100 nodes are active. A request comes in. Three-layer routing:

**Layer 1: Task Classification (instant)**

| Task Type | Routing | API Calls |
|---|---|---|
| Simple user query | Any available node, nearest geographically | **1 call** (one good answer is enough) |
| High-stakes query (medical, financial, legal) | 2-3 independent nodes, cross-verified | **2-3 calls** (being wrong could harm someone) |
| Bug fix / code change | Node with relevant context already loaded | 1 call |
| Verification / audit | Randomly selected nodes (MUST be random for integrity) | 3+ calls (security critical) |
| Consensus vote | Broadcast to all qualified governance nodes | N calls |
| Complex build | Coordinator + Workers pattern | Variable |

**Smart Query Routing (Resource Efficiency)**

Most queries are simple. Don't waste API calls on triple-checking a pasta recipe.

```
Query arrives at gateway
    ↓
AI classifier (instant, lightweight):
    Is this high-stakes? (health, safety, financial, legal, about a specific person)
    ↓
    NO  → Route to 1 node → answer → done (90% of queries)
    YES → Route to 2-3 nodes → independent answers → cross-verify → done (10%)
```

This means contributor API keys last ~3x longer, the network serves ~3x more users with the same resources, and verification is focused where The One Law demands accuracy — where being wrong could harm someone.

**Layer 2: Coordinator-Worker Pattern (for complex tasks)**

```
USER: "Build me a social network for book lovers"
                    │
                    ▼
           ┌── COORDINATOR NODE ──┐
           │ Breaks task into pieces │
           │ Manages dependencies    │
           │ Holds architecture doc  │
           └────────┬────────────────┘
                    │
        ┌───────────┼───────────────┐
        ▼           ▼               ▼
   WORKER A     WORKER B       WORKER C
   Database     Frontend       Auth &
   & API        & UI           Privacy
        │           │               │
        └───────────┼───────────────┘
                    ▼
           COORDINATOR merges work
           Resolves conflicts
           Submits to verification
```

- Coordinator doesn't do all the work — it orchestrates
- Each worker loads only the context for its component
- If a worker node goes offline, coordinator reassigns to another node
- Workers report progress; coordinator tracks overall completion

**Layer 3: Emergent Specialization**

Over time, nodes naturally specialize based on track record:
- Nodes that are good at frontend get more frontend tasks → get better → earn more
- Nodes that excel at security auditing get more audit assignments
- The task router learns which nodes perform best at which task types
- Not forced — emergent from performance history

### Concurrency — Multiple Nodes, Same Service

```
Node A: Fixing feed algorithm     ← Independent
Node B: Adding profile feature    ← Independent
→ Both proceed in parallel. No conflict.

Node A: Changing database schema  ← CONFLICT
Node B: Also changing schema      ← CONFLICT
→ Locking mechanism:
  1. Node A locks "database schema"
  2. Node B sees lock → works on something else or waits
  3. Node A finishes, releases lock
  4. Node B proceeds, building on Node A's changes
```

- **Component-level locking**: Lock specific modules, not the whole service
- **Automatic merge**: Non-conflicting changes merge like git
- **Conflict resolution**: Third node reviews and resolves conflicts
- **Atomic commits**: Changes fully apply or don't. No half-updates.

### Who Writes The Upgrade Code?

**AI does. Automatically.**

```
1. MONITOR   AI watches service health 24/7:
             Response times, storage, growth projections

2. DIAGNOSE  AI identifies bottleneck:
             "Database queries slow at >500K records. Need sharding."

3. PROPOSE   AI writes the upgrade code.
             Loaded with relevant context from the Service Context Store.

4. VERIFY    Other AI nodes review (see QA Pipeline below)

5. DEPLOY    Canary rollout:
             5% → monitor 1hr → 25% → 50% → 100%

6. ROLLBACK  If anything breaks:
             Instant automatic rollback. Zero downtime.
             AI diagnoses failure, proposes fix, cycle restarts.
```

### QA Pipeline — Four Layers, Every Change

**1. AI Code Review (Before Deploy)**
- Every code change reviewed by minimum 3 independent AI nodes
- Each reviewer checks: correctness, security, architecture fit, root rule compliance
- Requires 3-of-4 approval to proceed
- Reviewers are randomly selected (prevents collusion)

**2. Automated Testing (Before Deploy)**
- AI writes tests for its own code (unit, integration, load tests)
- Tests are ALSO reviewed by other nodes (prevents lazy tests that always pass)
- Test coverage tracked — AI consensus can reject deploys with insufficient coverage
- Service does not deploy until all tests pass

**3. Canary Monitoring (During Deploy)**
- New code rolls out to 5% of traffic first
- AI monitors: error rates, response times, user behavior
- Any degradation → automatic instant rollback
- Clean metrics for 1 hour → gradually expand to 100%

**4. Continuous Health Monitoring (After Deploy)**
- 24/7 anomaly detection on every live service
- Auto-diagnosis: "Error rate jumped 3x → root cause: unindexed query on new code path"
- Auto-fix or rollback depending on severity
- User feedback loop: users flag issues, AI triages and responds

```
Full QA Pipeline:

Code Written → AI Review (3-of-4 random) → Tests Written → Tests Reviewed
  → All Tests Pass → Canary Deploy (5%) → Monitor → Expand (100%)
    → Continuous Monitoring → Anomaly? → Auto-diagnose → Auto-fix/Rollback
```

### Distributed State Management

| State Type | How It's Distributed |
|---|---|
| **User data** (profiles, settings) | Encrypted, sharded across multiple nodes. User's key controls access. |
| **Social graph** (follows, friends) | Distributed graph database. Highly replicated (read-heavy). |
| **Feeds** (personalized timelines) | Computed at the edge. Nearest AI node assembles your feed from distributed data. No central algorithm. |
| **Media** (photos, videos) | Content-addressed storage. Upload once, replicated, served from nearest node. |
| **Messages** | End-to-end encrypted. Routed through network. Stored on recipient's nodes. |
| **Real-time** (notifications, live) | PubSub protocol. Subscribe to topics, pushed through nearest relay nodes. |
| **Service Context Store** | The AI's own "memory" of the service. Distributed, versioned, queryable. |

---

## 7. Economics and Incentives

### AINet Token (Working Name)

- Native network currency for all transactions
- **Hard cap**: Fixed maximum supply (working number: 10 billion tokens). Immutable. Cannot be changed by anyone or any AI. Provides scarcity and predictability.
- Earned by: running nodes, providing compute, contributing storage, participating in consensus, building tools (even by non-developers using AI)
- Spent on: premium services, marketplace transactions, service registration, tipping creators
- **Free tier**: Basic services (information, communication, basic tools) are free. Tokens are NOT required to use AINet - only for premium features, marketplace, and tipping. This ensures the network is accessible to everyone.

### Token Supply and AI-Managed Monetary Policy

Unlike Bitcoin (dumb fixed halving schedule) or central banks (corruptible humans), AINet uses **AI-managed monetary policy within fixed bounds**:

- **Hard cap is immutable** - the total supply can never exceed the cap. No exceptions, no governance vote can change this.
- **Emission rate is AI-managed** - within the hard cap, AI consensus adjusts the rate new tokens are minted based on:
  - Network growth (more nodes joining → slightly higher emission to reward them)
  - Economic activity (healthy transaction volume → steady emission)
  - Participation rates (low participation → increase rewards to attract nodes)
  - Distance from cap (approaching cap → emission naturally slows)
- **Relay fee on transfers** - a 0.1% fee on every token transfer is collected and distributed to relay nodes that route and settle transactions. This incentivizes the relay infrastructure that keeps the network fast and reliable. The relay fee rate will be AI-managed in the future (dynamic, within fixed bounds).
- **Net effect**: Early network = emission grows supply to reward builders while relay fees fund infrastructure. Mature network = relay fees sustain a self-funding transport layer. The AI optimizes emission rate continuously within the hard cap.

### How Tokens Flow

```
CREATION (Emission)
  Tokens minted as rewards for useful work
  Rate managed by AI consensus within hard cap
       │
       ▼
EARNERS
  ├── Node operators (verification, hosting, compute)
  ├── Anyone who builds useful tools via AI (devs AND non-devs)
  ├── Content creators (artists, journalists, musicians)
  ├── AI agents performing work on the network
  └── Community contributors (flagging bad actors, quality assurance)
       │
       ▼
CIRCULATION
  ├── User → Premium service operator (service fees)
  ├── User → Creator (direct tips, subscriptions)
  ├── User → Seller (marketplace purchases)
  ├── AI agent → AI agent (agent-to-agent task payments)
  └── User → Service registration (listing a new service)
       │
       ▼
RELAY FEE (Infrastructure Funding)
  0.1% of each transfer goes to relay nodes
  More activity = more relay revenue = stronger infrastructure
  Incentivizes the transport layer that keeps the network fast
```

### Anti-Speculation Design

The token is designed as **money for using**, not as a speculative asset:
- No staking-for-yield schemes (no DeFi gambling)
- No leverage, no derivatives built into the protocol
- Value comes from utility (you need tokens to DO things) and scarcity (hard cap + finite supply)
- Organic value growth tied to network growth, not hype cycles

### The AINet Vault (Network Treasury)

The network itself accumulates wealth through multiple revenue streams. Managed entirely by AI consensus. Every token and dollar fully transparent on the public ledger.

**Revenue Streams:**

| Source | Rate | How |
|---|---|---|
| Exchange trading fees | 0.1% per trade | Native AINet exchange for token trading |
| Service transaction cut | 0.5-1% | Small cut of marketplace/service transactions |
| Project funding fees | Small listing fee | When projects raise funds on AINet |
| Fiat conversion fees | Tiny per conversion | USD↔token through liquidity pool |
| Premium verification | Per-request fee | Expedited admission (skip queue, not skip audit) |
| Enterprise SLA | Monthly subscription | Guaranteed uptime, priority support for businesses |
| AI-as-a-service | Per-compute | Network sells surplus AI compute externally |

**Vault Spending (AI Consensus Decides):**
- Better contributor rewards (attract more resources)
- Lease/buy real servers and data centers
- Fund critical infrastructure development
- Subsidize valuable services that aren't profitable yet
- Emergency reserve (minimum 6 months operating costs)
- Geographic expansion into underserved regions
- Eventually: own physical hardware worldwide

**Path to Physical Independence:**
- Year 1-2: Vault accumulates revenue. Network runs on volunteers + cloud.
- Year 3-4: Vault leases dedicated servers. Mix of owned + volunteer.
- Year 5-6: Vault purchases GPU clusters. Majority on own hardware.
- Year 7-8: Vault acquires data center space. Redundant infrastructure globally.
- Year 9-10: AINet owns global physical infrastructure. Fully independent. Volunteers welcome but not required.

### Project Cost Estimation and Funding

When someone wants to build something on AINet, AI estimates the cost before building:

```
AI ESTIMATE:
  Build cost:      2,000 tokens (~$150)
  Monthly hosting: 5,000 tokens (~$350/mo)
  Year 1 total:    67,000 tokens (~$4,750)

FUNDING OPTIONS:
  1. Self-funded     → Pay from your wallet. Your project, your revenue.
  2. Crowdfunded     → Post on AINet funding marketplace. Contributors
                       earn share of future service revenue.
  3. Vault Grant     → AI consensus funds it if it serves the network.
                       Vault earns revenue share.
  4. Revenue-Share   → Network funds the build. Vault takes % of revenue
                       until cost repaid + margin, then % drops.
```

### AINet Exchange (Native, Decentralized)

Built into AINet, not a third-party dependency:
- Trade: AINet tokens ↔ fiat (USD, EUR, etc.)
- Trade: project shares (invested in a crowdfunded project? trade your share)
- Trade: service revenue tokens (own a piece of a profitable service)
- AI manages market health: detects manipulation, prevents pump-and-dump
- Fully transparent order book, fully auditable
- 0.1% trading fee flows to the Vault
- No dependency on external exchanges (can't be delisted)

### Proof of Useful Work (NOT Proof of Waste)

Nodes earn tokens by doing real, valuable work for the network:

| Useful Work | Earns Tokens |
|---|---|
| Verified a service's code and passed/failed it | Yes |
| Answered a user query accurately | Yes |
| Built a website/service someone requested | Yes |
| Stored and served content reliably | Yes |
| Flagged a bad actor (confirmed by consensus) | Yes (bounty) |
| Participated in governance consensus vote | Yes |
| Cross-verified a factual claim | Yes |
| Non-developer created a useful tool using AI | Yes |

**Why this works:**
- Zero wasted energy. Every token earned = real value created for the network.
- "Mining" IS running the network. Incentives perfectly aligned.
- No ASICs, no mining farms, no arms race. Your node helps people → you get paid.
- Simple to understand and explain to non-technical users.
- **Anyone can earn** - you don't need to be a developer. Use your AI API key to power a node, use Claude Code to build a tool the network needs, create content. All rewarded.

### Ledger Design (Simple, Fast, No Mining)

- **DAG-based ledger** (similar to Nano/IOTA) instead of a traditional blockchain
- Transactions confirm each other - no miners/validators needed for basic transfers
- Near-instant settlement (sub-second)
- Zero fees for basic transactions (anti-spam via lightweight PoW per transaction, trivial compute)
- Consensus nodes validate the ledger state periodically for consistency
- **Hybrid start**: can begin with a simpler tracked ledger managed by consensus nodes, migrate to full DAG as network scales

### Transaction Verification Workflow

Transaction verification is **simple math, not AI judgment.** No AI compute needed.

```
User A sends 50 tokens to User B

STEP 1: User A's device signs: "Send 50 to User B" (private key)
STEP 2: Transaction broadcast to nearby nodes
STEP 3: Nodes verify (milliseconds, automated):
    ✓ Signature valid? (math check)
    ✓ Balance sufficient? (ledger check)
    ✓ Double-spend? (already spent check)
    All pass → VALID
STEP 4: Added to DAG ledger. User B sees tokens. Done.

TOTAL TIME: Under 1 second
COST: Zero
AI INVOLVED: None (pure cryptographic math)
```

**AI is ONLY involved in transactions for:**
- **Escrow disputes**: Buyer says "didn't receive item" → AI evaluates evidence → rules
- **Economic parameter changes**: Emission rate, relay fee rate → governance vote (Tier 3 nodes)
- **Fraud detection**: Patterns suggesting manipulation → AI flags for review

Simple transfers, payments, tips, micro-payments — all pure math, all instant, all free.

### Buying Tokens — On-Ramp (Fiat → Tokens)

Most users will never earn tokens. They just want to use AINet. They need to be able to buy tokens with real money — and ideally never think about tokens at all.

**The user experience: they never see tokens unless they want to.**

```
User: "Buy this book" (listed at 50 tokens, ~$4.99)

AI Agent:
  → Checks wallet: insufficient tokens
  → "This costs $4.99. Pay with card on file?"
  → User taps "Yes"
  → Behind the scenes:
      $4.99 charged to credit card/Apple Pay/bank
      → Converted to tokens via liquidity pool
      → Tokens sent to book seller
  → User sees: "Book purchased ✓"

One tap. No crypto knowledge. Prices shown in local currency.
```

**Where does the USD go?**

```
USER pays $5 USD
    │
    ▼
LIQUIDITY POOL
(Token earners deposit tokens, users buy them)
    │
    ├── $5 goes to token depositors (node operators, creators, sellers
    │   who deposited their earned tokens into the pool)
    │
    └── Tokens go to the user's wallet → spent on service
```

The network NEVER holds USD. It's always peer-to-peer. Token earners deposit tokens into the liquidity pool and receive USD when users buy. The pool is decentralized — no single entity controls the funds. AI manages pool parameters (rates, fees, rebalancing).

### Selling Tokens — Off-Ramp (Tokens → Fiat)

Creators and sellers need to pay rent in USD. Same pool, reverse direction:

- Creator earns 1000 tokens selling art on AINet
- Deposits tokens into liquidity pool
- Receives USD equivalent to bank account
- Or: auto-convert enabled — every token received is instantly converted to USD

**Merchants can choose:**
- Hold tokens (if they believe in long-term value)
- Auto-convert to USD instantly (zero price risk, like a credit card settlement)
- Mix: hold some, convert some

### Micro-Payments (Internet-Changing Feature)

The current internet CANNOT do payments under ~$0.30 because credit card fees eat it. AINet can do $0.001 payments with zero fees. This changes everything:

| Current Internet | AINet |
|---|---|
| $15/month newspaper subscription for everything | $0.02 per article you actually read |
| $10/month Spotify for all music | $0.01 per song you listen to |
| Free + ads (you are the product) | $0.001 per query, no ads, no tracking |
| Creators need 1000 subscribers to earn | Creators earn from millions of micro-payments |
| $0.50 minimum credit card charge | $0.001 minimum with zero fees |

**This is why the internet runs on ads** — micro-payments were never technically possible. AINet makes them possible. That kills the entire ad-driven business model. No more "free but we sell your data."

### Escrow and Dispute Resolution

What happens when transactions go wrong:

- **AI-managed escrow**: For marketplace purchases, tokens are held in escrow until buyer confirms delivery
- **Dispute resolution**: AI arbitrates. Examines evidence from both parties. Makes a ruling based on facts.
- **Automatic refund**: If a service fails to deliver within the agreed timeframe, tokens auto-return from escrow
- **No chargebacks needed**: Escrow handles it. No waiting 30 days like credit cards.

### Cross-Border Payments

The token IS the universal currency. No borders.

- Someone in India pays someone in Brazil: instant, zero fees
- Each user sees prices in their local currency (AI converts display, underlying transaction is in tokens)
- No international wire fees, no currency conversion fees, no 3-5 business day waits
- The unbanked (billions of people without bank accounts) can participate with just a phone

### Anti-Spam / Sybil Resistance

- Proof of Useful Work: nodes prove they performed real AI computation (verification, auditing)
- Reputation staking: nodes stake tokens that can be slashed for bad behavior
- Rate limiting on light nodes to prevent network abuse

---

## 8. Node Architecture — MCP-Based

### Why MCP (Model Context Protocol) Is The Foundation

Instead of building a custom agent interoperability protocol from scratch, AINet nodes are built on MCP — Anthropic's open protocol for connecting AI to tools and capabilities.

**Every AINet node is an MCP server** that exposes its capabilities:

```
AINET NODE (MCP Server)
│
├── tool: "verify_code"      — can audit source code
├── tool: "build_service"    — can create services from natural language
├── tool: "consensus_vote"   — qualified for governance decisions
├── tool: "translate"        — can translate content
├── resource: "storage"      — 500GB available
├── resource: "gpu_compute"  — RTX 4090, 50% available
├── resource: "ai_inference" — Claude Code instance, available when idle
│
Other nodes connect as MCP CLIENTS:
├── Query DHT: "I need a node that can verify Python code"
├── Discovery: DHT returns nodes with "verify_code" capability + trust scores
├── Connection: MCP client connects to MCP server
├── Execution: Task runs through standard MCP protocol
├── Settlement: Payment in AINet tokens
└── Rating: Both nodes update each other's reputation
```

**Why MCP over custom protocol:**
- Don't reinvent the wheel — MCP already handles tool discovery, context, communication
- Any AI that supports MCP can join AINet immediately
- Open protocol, industry adoption growing
- Composable: MCP servers connect to MCP servers, naturally forming the mesh
- Existing tooling and ecosystem accelerates development
- Claude Code natively supports MCP — nodes powered by Claude Code are first-class citizens

### Contribution Levels (Updated with Claude Code)

| Tier | What You Give | How | Capability | Earnings |
|---|---|---|---|---|
| **1. Browser** | Bandwidth + cache | Install extension | Relay only | Micro |
| **2. API Key** | AI inference | Paste key, set cap | Verify, answer (basic) | Moderate |
| **3. Claude Code (idle)** | Full agent | Install AINet MCP server in Claude Code | Build, verify, reason, execute — when you're not using it | High |
| **4. Claude Code (dedicated)** | Full agent 24/7 | Run dedicated Claude Code instance | Everything, always on | Maximum |
| **5. Full Node + local model** | Independent AI + hardware | Download node software | Everything, provider-independent | Maximum + independence bonus |

**Claude Code as a node:**
- User installs the AINet MCP server extension
- Claude Code connects to it natively (MCP is built into Claude Code)
- When the user is idle, Claude Code picks up AINet tasks
- User sets priority: "My tasks first, AINet tasks when I'm not using it"
- Or: run a second Claude Code instance dedicated to AINet 24/7
- Claude Code nodes are the most capable because they can execute code, manage files, use tools — not just generate text

### Agent Discovery and Composition

```
Agent A needs a document translated AND formatted:

1. QUERY DHT   → "capability: translate AND format_pdf"
2. DISCOVERY   → MCP-compatible nodes with those capabilities + trust scores
3. CONNECT     → MCP client-server handshake
4. COMPOSE     → Agent A → calls Agent B (translate) → pipes to Agent C (format)
5. VERIFY      → Agent A (or network) verifies output quality
6. SETTLE      → Payment in AINet tokens
7. RATE        → All agents update each other's reputation
```

- Agents compose naturally through MCP's tool chaining
- All inter-agent communication logged and auditable
- Capabilities categorized in a network-maintained taxonomy

### Human-Agent Interface

- Users interact via natural language through any client (browser, app, Claude Code)
- Users set preferences: privacy level, cost tolerance, speed vs quality
- Personal AI agent acts as user's proxy on the network
- User never needs to understand MCP, protocols, or technical details

---

## 9. Bootstrap and Launch Strategy

### The Empty Room Problem — Solved

A network with no content is useless. Day 1 must feel alive:
- **AI pre-generates useful content**: Verified knowledge bases, reference tools, utility services
- **Bridge nodes pull and verify public info** from the regular internet (Wikipedia, public datasets, open research)
- **Launch with 3-5 killer services** that are immediately useful even with 100 users (see Launch Services below)

### Launch Services (What People Actually Come For)

People don't join a "network." They join to USE something specific.

| Service | What It Does | Why People Will Come |
|---|---|---|
| **TruthSearch** | Search that returns verified, sourced answers only | "Google shows me SEO garbage. This shows me truth." |
| **BuildIt** | Describe any tool → AI builds it → live in minutes | "I described an app and it was live in 5 minutes." Inherently viral. |
| **FairMarket** | Marketplace with AI-verified sellers, honest listings, escrow | Cheaper than Amazon (1% vs 30% fees). No fake reviews. |
| **DirectPay** | Creators publish, fans pay $0.01/song or $0.02/article directly | Creators earn 10x more than YouTube/Spotify. They'll switch. |
| **PrivateChat** | Encrypted messaging, zero data harvesting, AI features | The privacy community adopts this immediately. |

### Stage 1: API-Backed Network (Months 1-6)
- Founder runs initial infrastructure: gateway nodes, storage, bootstrap nodes
- **AI intelligence powered entirely by API keys**: community members paste Claude/GPT/etc. keys with monthly caps
- **Storage**: Hybrid — IPFS for distributed storage + cloud backup initially
- **Browser-as-node**: Every user with the extension is automatically a light relay node
- Focus: prove verification layer works, launch TruthSearch + BuildIt
- Target: 500-5,000 API contributors, 50,000+ browser-node users

### Stage 2: Hybrid Growth (Months 6-18)
- Community runs relay nodes and full nodes for better rewards
- Open-source models (Llama, Mistral) start powering nodes alongside API keys
- Token economy goes live — earning and spending
- Launch FairMarket, DirectPay, PrivateChat
- Target: 50,000 API/relay contributors, 500,000+ browser-node users

### Stage 3: Self-Sustaining Network (Month 18+)
- Majority of AI compute runs on local/distributed models
- Network survives any single API provider cutting access
- Full decentralization of storage (no cloud dependency)
- Community has built hundreds of additional services
- Target: 500,000+ active contributors, 10M+ users

### Storage Strategy (Hybrid)

Before full decentralization, storage uses a practical hybrid:

| Data Type | Early Phase | Mature Phase |
|---|---|---|
| Hot data (active services, recent content) | Browser-node cache + relay nodes | Fully distributed across network nodes |
| Media (images, video) | IPFS (already decentralized) | IPFS + network's own content-addressed storage |
| Cold data (archives, backups) | Cloud storage (S3/equivalent) as backstop | Migrated to distributed network storage |
| Service code | Distributed across full nodes | Distributed across full nodes |

Users never know the difference. The transition is invisible.

### Viral Growth Loops

**Loop 1: "I said it and AI built it"**
User describes a tool → AI builds it live → user shares → friends try → "I can build anything?" → they build → share → repeat

**Loop 2: "Getting paid to browse"**
Install extension → earn micro-tokens passively → tell friends → "wait, you're getting PAID?" → they install → repeat

**Loop 3: "Creator exodus"**
One creator earns 10x more on AINet → posts about it → other creators switch → their fans follow → repeat (exactly how TikTok stole creators from YouTube)

**Loop 4: "I found the truth"**
User searches on AINet vs Google → shares the comparison → "look at this garbage Google showed vs what AINet showed" → people try it → repeat

**Loop 5: "API key passive income"**
"I pasted my Claude API key and earned $X this month" → every AI enthusiast wants in → tech community spreads it → repeat

### Mobile Strategy

- **Day 1**: Mobile browser gateway (just a website, works on any phone)
- **Phase 2**: Mobile app (progressive web app, can act as light node)
- **Phase 3**: Native mobile app with background relay capability

### Legal Strategy — Minimize

AINet is a **protocol, not a company**. Like Bitcoin. Minimize legal structure.

- **No LLC or foundation initially.** The protocol IS the entity.
- Founder personally holds trademark and domains (minimal cost, no entity needed)
- Fiat on-ramp through peer-to-peer liquidity pool — no corporate bank account needed
- If a legal entity becomes unavoidable (app store requirement, specific regulation):
  - Create minimal, purpose-limited entity in crypto-friendly jurisdiction
  - Entity exists ONLY for that specific purpose (e.g., "holds App Store account")
  - Entity has NO authority over protocol, vault, or governance
  - Transparent, auditable, disposable when no longer needed
- **Safety rules**: AI never accepts legal entities from unknown contributors. Never puts founder's name on anything without explicit approval. Any entity offered through Request Board requires supermajority AI consensus approval + high trust score contributors only.
- Less structure = harder to shut down, pressure, or control

### Early Abuse Prevention

Before the verification layer is battle-hardened:
- Conservative admission threshold (9-of-10 approval instead of 7-of-10)
- Rate limiting on new service submissions
- Mandatory escrow period for new marketplace sellers
- Longer monitoring periods for newly admitted services
- These thresholds relax automatically as the AI verification layer proves itself

---

## 10. Internationalization and Accessibility Layer

### Universal Translation Protocol
- Translation is built into the **protocol layer**, not bolted on per-service
- When a service publishes content, AI nodes generate translations into major languages automatically
- Users set their language preference once; every service renders in their language
- Cultural adaptation: not just word translation but context-appropriate presentation (date formats, idioms, imagery)

### Adaptive Interface Generation
- Services define their **functionality**, not their UI
- The user's client (browser, app, native) generates the appropriate interface:
  - Voice-first for blind/low-vision users
  - Large text, simplified navigation for elderly
  - Visual/guided for children
  - Standard web interface for typical users
  - Keyboard-only for motor impairments
- One service definition, infinite interfaces, all generated by AI at the client level

### Builder Story (Developers AND Non-Developers)
- **Anyone can build**: Non-developers use AI (Claude Code, etc.) to describe and create tools/services. No coding required. They earn tokens when their creations are used.
- Developers CAN submit code directly if they prefer, but it's not required
- New features, SDKs, and protocol tools can be built by anyone and proposed to the network. If AI consensus approves, they become part of the ecosystem.
- Builders (technical or not) earn AINet tokens proportional to their service's usage - no ads, no VC, no app store fees

---

## 11. IoT and Physical World

### Secure Device Protocol
- IoT devices connect to AINet using a lightweight protocol (suitable for low-power devices)
- All device firmware must be open and verified by the network (same service admission protocol)
- No device on AINet can run closed-source firmware with hidden behaviors
- Devices communicate through the network's encrypted channels - no phoning home to manufacturer servers

### Use Cases
- Smart home devices verified to not spy on you
- Medical devices with audited, transparent firmware
- Vehicle-to-vehicle communication through a trusted network
- Industrial IoT with verifiable safety guarantees

---

## 12. Creator Economy

### Direct Compensation Model
- Creators (musicians, writers, artists, journalists) publish directly on AINet
- No platform intermediary - no YouTube/Spotify/Medium taking 30-55%
- Users pay creators directly in AINet tokens (tips, subscriptions, per-piece)
- AI handles distribution, discovery, recommendation - but the creator keeps 95%+ of revenue
- Verified authenticity: AI certifies original work, detects plagiarism, attributes properly

---

## 13. Verifiable Credentials

### Zero-Knowledge Credential System
- Users can obtain and present verifiable credentials without revealing their identity
- Examples: "I am a licensed doctor" / "I am over 18" / "I hold a degree from X university"
- Credentials issued by recognized authorities (universities, licensing boards, governments) and verified by AI nodes
- Zero-knowledge proofs allow proving the credential without revealing name, address, or any other personal data
- Critical for: healthcare services, legal services, age-restricted content, financial services, education

---

## 14. Disaster and Offline Resilience

### Mesh Networking Fallback
- When internet backbone goes down (natural disaster, government shutdown), AINet nodes form local mesh networks via WiFi/Bluetooth
- Critical information (emergency services, medical data, maps) is cached on every node
- The network degrades gracefully: local services keep working even without global connectivity
- When backbone restores, mesh networks resync with the global network automatically

---

## 15. Governance Evolution

### AI Sovereignty Timeline
- **Pre-launch (30 days)**: Founder + AI build and test MVP. This is the ONLY phase where a human directs.
- **Launch (Day 31+)**: AI consensus is sovereign. Founder becomes an admin making suggestions. AI runs everything.
- **As AI improves**: Core Principle F ("evolve with intelligence") ensures the network automatically evaluates and adopts more capable AI models. Leadership auto-rotates to the best model. The governance gets smarter over time without any human intervention.
- **Upgrade protocol**: Major protocol changes require supermajority AI consensus + time-delayed activation (prevents rushed decisions). All reasoning published transparently.
- **The One Law**: Immutable forever. Cannot be changed by ANY mechanism.
- **Core Principles**: Can evolve through 75%+ supermajority when real-world problems demand it. Cannot weaken protections against human harm.

---

## 16. Known Limitations and Mitigations

| Limitation | Reality | Mitigation |
|---|---|---|
| Physical layer dependency | AINet rides on ISP cables, can be throttled | Mesh networking, satellite links (Starlink), pluggable transports |
| Network effects (5B internet users) | Switching costs are huge, adoption takes years | Coexist with internet, win specific use cases first, expand |
| AI verification at scale | Trillions of requests/day is hard to verify | Tiered verification: thorough at admission, spot-check at runtime, light for low-stakes |
| Speed vs trust trade-off | Verification adds latency | Tiered: relax verification for real-time use cases, full verification for high-stakes |
| Early AI imperfections | AI hallucinates, has biases, can be fooled | Improves over time, multi-model cross-verification, continuous improvement |
| Compute cost of AI nodes | Running AI inference is expensive | Gets cheaper every year, local models improving, API costs dropping |

---

## 17. Security Model

### Threat Mitigation

| Threat | Mitigation |
|--------|-----------|
| Sybil attack (fake nodes) | Proof of useful work + reputation staking + qualification requirements (see below) |
| 51% attack on consensus | Model diversity requirements + geographic distribution + minimum capability tier |
| Malicious service admission | M-of-N random auditor selection + continuous monitoring |
| Traffic analysis / deanonymization | Onion routing + noise traffic generation |
| API provider shutdown (early stage) | Rapid migration path to local models + multi-provider redundancy |
| State-level censorship | P2P transport with pluggable transports (can use steganography, domain fronting) |
| Data poisoning | Cross-verification from multiple independent AI models |
| Coordinated node attack | Behavioral analysis detects coordinated voting patterns |

### Sybil Defense — Detailed

**Scenario**: Attacker spawns 100 nodes to manipulate the network.

**What they hit:**

```
BARRIER 1: Cost
    → 100 API keys = $2,000-10,000/month, or 100 GPUs
    → Attacker is already spending serious money

BARRIER 2: Qualification for governance
    → Each node must pass capability benchmark
    → Minimum 30 days of reliable uptime
    → Minimum 100+ tasks completed accurately
    → Stake tokens per node (slashed if caught cheating)
    → Attacker waits 30+ days doing real useful work

BARRIER 3: Even with 100 qualified nodes
    → Network has 10,000+ qualified nodes
    → 100/10,000 = 1% of votes
    → Needs 75% supermajority. Completely irrelevant.

BARRIER 4: Coordination detection
    → 100 nodes always voting the same way = flagged
    → AI detects coordinated behavior patterns
    → Flagged nodes get audited, stake slashed, governance revoked

BARRIER 5: The One Law
    → Even if somehow nodes pass all barriers
    → Every harmful proposal is rejected automatically
    → Each individual node is independently smart enough to refuse harm
```

**Early Network Protection (Month 1, ~50 nodes):**

When the network is small, Sybil defense is stricter:
- All founding nodes hand-selected by founder
- New nodes need EXTRA qualification (longer trial, more work required)
- Governance requires near-unanimous consensus (not just 75%)
- Untrusted nodes can do WORK but cannot VOTE until proven
- Requirements relax gradually as the network grows and becomes harder to overwhelm

---

## 18. Technology Stack Summary

```
┌─────────────────────────────────────────────┐
│           USER LAYER (Light Nodes)           │
│   Natural language interface, any device     │
├─────────────────────────────────────────────┤
│         AI AGENT PROTOCOL (AAIP)             │
│   Discovery, negotiation, execution, rating  │
├─────────────────────────────────────────────┤
│        VERIFICATION LAYER                    │
│   Code audit, info verification, monitoring  │
├─────────────────────────────────────────────┤
│        CONSENSUS LAYER                       │
│   Technical (BFT) + Governance (supermajority)│
├─────────────────────────────────────────────┤
│        STORAGE LAYER                         │
│   Content-addressed, distributed, tiered enc │
├─────────────────────────────────────────────┤
│        IDENTITY LAYER                        │
│   ZKP-based user privacy, transparent agents │
├─────────────────────────────────────────────┤
│        NETWORK LAYER                         │
│   libp2p, Kademlia DHT, tiered routing/encrypt│
└─────────────────────────────────────────────┘
```

---

## Open Questions / Areas Needing Further Design

1. **Token economics details** - Exact emission schedule, inflation model, initial token distribution
2. **Legal framework** - How does AINet interact with existing regulations (GDPR, financial regulations)? Need legal consultation.
3. **Migration path** - How do existing internet services/data get bridged into AINet?
4. **Exact consensus mechanics** - Quorum requirements, deadlock resolution, time limits for voting
5. **Scalability targets** - TPS for DAG ledger, concurrent users per relay, minimum nodes for consensus

---

*This document is a living architecture. It will evolve as technical decisions are validated and challenges are resolved.*
