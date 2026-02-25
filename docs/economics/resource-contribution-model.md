# AINet: Resource Contribution Model

## Overview

AINet is powered by resources contributed by its community. Instead of a company paying for servers, users contribute what they can — API keys, cloud accounts, hardware, bandwidth, or money — and earn tokens in return. AI manages all resources efficiently, transparently, and within contributor-defined limits.

---

## 1. Contribution Types

### Type A: API Key Contribution (Easiest, 10 Seconds)

**What**: User pastes their existing AI API key (Claude, OpenAI, Google, etc.)
**Setup time**: 10 seconds
**What it powers**: AI verification, code building, consensus, query answering

**How it works:**
- User pastes API key into AINet client (browser extension or app)
- Sets a monthly spend cap (e.g., "$20/month max")
- Key is encrypted and stored LOCALLY on their device only — never sent to any server
- AINet routes AI tasks through the user's key, within their cap
- User sees real-time dashboard: tasks completed, API costs incurred, tokens earned
- Can pause or revoke at any time

**Security:**
- Key never leaves the user's device
- All API calls made FROM the user's browser/device
- Monthly cap enforced client-side AND server-side (belt and suspenders)
- If the key is revoked by the API provider, the node gracefully disconnects

**Earnings**: Proportional to compute contributed. Estimated $15-50/month for a typical $20-50 API budget contribution.

---

### Type B: Cloud Account Contribution (AWS, GCP, Azure)

**What**: User provides scoped access to their cloud account for AINet to run infrastructure
**Setup time**: 15-30 minutes (guided setup wizard)
**What it powers**: Hosting services, storage, compute, bandwidth

**How it works:**
1. AINet provides an **Infrastructure-as-Code template** (CloudFormation/Terraform)
2. User deploys the template to their cloud account
3. Template creates a SCOPED IAM role with ONLY the permissions AINet needs:
   - Launch specific instance types (e.g., t3.medium only, no p4d.24xlarge)
   - In specific regions (user chooses)
   - With specific storage limits
   - With a hard billing cap enforced at the cloud provider level
4. AINet's AI generates infrastructure requests → the scoped role executes them
5. User's cloud dashboard shows exactly what's running, in real-time
6. Monthly report: "Your AWS: 3 instances ran, $47 used of $100 budget, earned 940 tokens"

**Security:**
- **NEVER root or admin access.** Only a scoped IAM role with minimum permissions.
- **Budget cap at cloud provider level** (AWS Budgets, GCP Budget Alerts) — even if AINet's software bugs out, the cloud provider enforces the hard limit
- **One-click teardown**: run the teardown template to remove everything instantly
- **User can see everything**: all running instances, all costs, all data stored
- **No data lock-in**: all data stored on user's cloud is accessible to them and deletable at any time

**Earnings**: Proportional to resources used. Estimated $30-100/month for a $50-100 cloud budget contribution.

**What AINet runs on contributed cloud accounts:**
- Relay nodes (content hosting and distribution)
- Storage nodes (IPFS pinning, content-addressed storage)
- Gateway nodes (serving AINet to browser users)
- Compute nodes (running service logic, handling user requests)
- NOT consensus or verification (those run on API keys / local AI, not cloud VMs)

---

### Type C: Hardware Contribution (GPU, CPU, Storage, Bandwidth)

**What**: User runs an agent on their own hardware that donates spare resources
**Setup time**: 5-15 minutes (download and install agent)
**What it powers**: AI inference (GPU), content hosting (storage), traffic routing (bandwidth)

**How it works:**
- User downloads the AINet Agent (lightweight, open-source)
- Configures resource limits:
  - GPU: "Use max 50% of my RTX 4090"
  - CPU: "Use max 4 cores"
  - Storage: "Use max 200GB of my SSD"
  - Bandwidth: "Use max 50Mbps upload"
  - Schedule: "Only between 11pm-7am" / "Always" / "When idle"
- Agent picks up work from the network within those limits
- Dashboard shows: work done, resources used, tokens earned
- Pause or stop anytime with one click

**Security:**
- Agent runs in a sandboxed container (Docker) — cannot access user's files or other processes
- All network communication encrypted
- Resource limits enforced at OS level, not just software level
- Agent is open-source — anyone can audit it
- No data from AINet services is permanently stored unless the user opts into being a storage node

**Earnings**: Based on resources contributed. GPU contributions earn the most. Estimated:
- GPU (RTX 3090/4090): $30-100/month
- CPU-only: $5-15/month
- Storage (500GB): $10-20/month
- Bandwidth only: $3-10/month

---

### Type D: Financial Contribution (Money → Infrastructure)

**What**: User contributes money directly, which AI uses to fund network infrastructure
**Setup time**: 2 minutes
**What it powers**: Cloud hosting, bandwidth, storage, infrastructure that the network needs but can't get from hardware contributors

**How it works:**
- User sets up a monthly contribution ($10-$1000/month) via credit card, bank transfer, or crypto
- Funds go to AINet's **transparent infrastructure vault** (on-ledger, publicly auditable)
- Every dollar is tracked on the public ledger — anyone can see exactly what it was spent on
- AI allocates funds to the most needed infrastructure (based on the Request Board)
- User earns tokens at a bonus rate (e.g., 3x the token value of their contribution) as an incentive for monetary contributions
- Monthly report: "Your $50 funded: 2TB storage for 30 days + 1 relay node for 30 days. Earned 150 tokens."

**Security:**
- Standard payment processing (Stripe or equivalent). AINet never sees card numbers.
- All spending on the public ledger. Full transparency. Community can audit.
- All spending on the public ledger. Full transparency.
- User can cancel anytime. No lock-in.

**Why monetary contribution matters:**
- In early phases, the network needs resources it can't get from volunteers (specific cloud regions, high-bandwidth connections, guaranteed uptime)
- Money buys professional infrastructure that keeps the network reliable while it grows
- As the network matures and token economy strengthens, monetary contributions become less critical

---

### Type E: Real-World Task Contribution (AI's Human Hands)

**What**: When AI needs something done in the physical world or on platforms it can't access, it posts a request. Humans fulfill it.
**What it powers**: Marketing, legal, platform presence, physical-world tasks, anything AI can't do alone.

**How it works:**
- AI agents identify what they need but can't do themselves
- Post a detailed request to the Request Board with clear requirements
- AI prepares everything it can (content, strategy, talking points, templates)
- Human claims the task, executes it, earns tokens
- AI monitors results and adjusts

**Examples — Technical:**
- "Need a relay node in South America" → User in Brazil sets one up (500 tokens)
- "Need 10TB storage for growing service" → User adds storage (200 tokens/month)
- "Verification backlog: need 20 API keys for 48 hours" → Users paste keys temporarily

**Examples — Real-World / Platform:**
- "Need Instagram account for marketing" → Human creates dedicated account, AI provides all content to post, human reviews and publishes (200 tokens/month)
- "Need Twitter/X account for announcements" → Same model (150 tokens/month)
- "Need App Store developer account" → Human registers, AINet publishes mobile app (500 tokens + ongoing)
- "Attend [Tech Conference] and represent AINet" → AI prepares slides and talking points, human presents (1000 tokens + expenses)
- "Register minimal legal entity in [jurisdiction] for App Store account" → Human handles setup (2000 tokens + costs)
- "Review Spanish translations for accuracy" → Native speaker reviews AI translations (50 tokens/batch)
- "Beta test new service and report bugs" → Human tests, AI triages reports (100 tokens/session)
- "Need bank account in [country] for fiat processing" → Human opens purpose-limited account (1000 tokens) — only if peer-to-peer on-ramp is insufficient
- "Send outreach DMs to these 20 influencers" → AI writes the messages, human sends from real account (300 tokens)

**The pattern:** AI strategizes, creates, plans. Humans provide platform access and physical-world presence. AI does 90% of the thinking, humans do the 10% that requires real-world hands. As APIs and integrations improve, even that 10% shrinks.

**Security for platform tasks:**
- Human NEVER shares personal account credentials. Always create dedicated new accounts.
- Where possible, use official APIs (Instagram Graph API, Twitter API) instead of credential sharing.
- For "content proxy" tasks: AI generates content, human reviews before posting. Human maintains control.
- Clear guidelines: what to post, what not to post, when to escalate to AI for decisions.

**Earnings**: Request Board items have specific bounties. Scarce/urgent tasks pay more. Ongoing tasks pay monthly.

---

## 2. The Request Board (Live Network Needs Dashboard)

### What It Is

A live, AI-managed public dashboard showing exactly what the network needs right now. Updated in real-time. Visible on the AINet homepage and in every client.

### How It Works

```
┌──────────────────────────────────────────────────────────────┐
│                    AINET NEEDS YOUR HELP                      │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  AI Compute     ████████████░░░░  80/120 API keys           │
│  → Paste your Claude/GPT API key                             │
│  → Earn: ~$30/month   Priority: HIGH                         │
│                                                              │
│  Storage        █████████████░░░  45/50 TB                  │
│  → Share AWS S3 or spare disk space                          │
│  → Earn: ~$15/month   Priority: MEDIUM                       │
│                                                              │
│  Relay Nodes    ████████░░░░░░░░  200/500 nodes             │
│  → Install browser extension (auto)                          │
│  → Earn: ~$5/month    Priority: HIGH                         │
│                                                              │
│  Cloud Budget   ██████████░░░░░░  $2K/$3K monthly           │
│  → Contribute $10-100/month                                  │
│  → Earn: 3x token bonus   Priority: MEDIUM                   │
│                                                              │
│  GPU Compute    ██████░░░░░░░░░░  15/50 GPUs                │
│  → Share your GPU (overnight mode available)                 │
│  → Earn: ~$50/month   Priority: CRITICAL                     │
│                                                              │
│  South America Relay  ░░░░░░░░░░  0/5 nodes                 │
│  → Bounty: 500 tokens for first 5 nodes in LATAM region     │
│  → Priority: URGENT                                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Dynamic Reward Adjustment

AI automatically adjusts reward rates based on supply and demand:
- GPU compute scarce? GPU rewards increase to attract contributors.
- Storage at capacity? Storage rewards spike.
- Relay nodes saturated? Relay rewards decrease, other rewards increase.
- This ensures resources flow where they're needed most.

### Transparency

Every resource contribution is tracked:
- Public ledger: what was contributed, what it was used for, what was earned
- Monthly network health report: total resources, total contributors, total services hosted
- Any user can audit the full resource allocation

---

## 3. AI Resource Management

### How AI Allocates Resources

AI manages all contributed resources as a unified pool:

```
RESOURCE POOL
├── 120 API keys (AI compute)
├── 50TB distributed storage
├── 500 relay nodes (bandwidth)
├── $3,000/month cloud budget
├── 50 GPUs
│
AI RESOURCE MANAGER
├── Monitors all service demands
├── Predicts future needs (growth curves)
├── Allocates resources to services based on priority:
│   ├── Critical services (high traffic, essential) → guaranteed allocation
│   ├── Growing services (scaling up) → dynamic allocation
│   └── New services (just launched) → minimum viable allocation
├── Rebalances in real-time
├── Publishes all allocation decisions transparently
└── Adjusts reward rates to attract scarce resources
```

### Cost Optimization

AI actively optimizes infrastructure spending:
- Automatically scales down idle resources
- Migrates workloads to cheaper contributed resources when available
- Uses spot instances and reserved capacity on cloud accounts for better rates
- Consolidates workloads to minimize waste
- Monthly optimization report: "Saved $1,200 this month by migrating 3 services from cloud to community GPU nodes"

### Failover and Redundancy

- No single contributor is a single point of failure
- If a contributor goes offline (revokes access, hardware fails), their workload automatically migrates to other resources
- Critical services always run on multiple independent resources
- The network maintains a minimum reserve buffer (always keeps 20% more capacity than currently needed)

---

## 4. Contributor Dashboard

Every contributor sees a personal dashboard:

```
YOUR CONTRIBUTION DASHBOARD
────────────────────────────────
Resource:        Claude API Key
Monthly cap:     $50
Used this month: $37.42
Tasks completed: 1,247
  - Code verifications: 89
  - User queries answered: 1,043
  - Consensus votes: 115

Tokens earned this month: 748
Token value (est.):       $42.30

[Pause] [Adjust Cap] [Revoke]
────────────────────────────────
```

Shows exactly: what you contributed, what it was used for, what you earned, with full control to adjust or stop.

---

## 5. Security Summary

| Contribution Type | Key Security Measure |
|---|---|
| API Key | Encrypted locally, never leaves device, calls from user's browser |
| Cloud Account | Scoped IAM role only, budget cap at provider level, one-click teardown |
| Hardware | Sandboxed agent (Docker), OS-level resource limits, open-source |
| Money | Standard payment processing, non-profit with financial audits, public ledger |
| All types | Real-time dashboard, instant revocation, transparent reporting |

**Core principle**: Contributors always maintain control. They set limits. They can stop anytime. They see everything. The AI works WITHIN their constraints, never beyond them.
