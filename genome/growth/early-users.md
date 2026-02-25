# Early Users — Who They Are and How to Reach Them

*All personas. Last updated: 2026-02-24 (second brainstorm).*

---

## The Dual Audience (Supply + Demand)

| Side | Who | What they contribute | What they need |
|---|---|---|---|
| **Supply** | Developers, node operators, API key holders, GPU owners | Compute, API keys, storage | Lux earnings, node software, P2P routing |
| **Demand** | Vibe coders, small business owners, open source maintainers, creators | Lux spending | Zero-terminal UX, consumer gateway, fast builds |

---

## DEVELOPER SUPPLY SIDE

### Profile 1: The Indie Hacker / Solo Builder

**Who:** Developer with side project ideas. Builds nights/weekends. Hates DevOps overhead. Has been burned by platform pricing changes.

**Pain:** Idea → production takes days even for experienced devs. Heroku died. Railway charges. Vercel bills. Firebase limits changed.

**What Pando gives:** Type one sentence → app exists → own the repo. No subscription — pay Lux per build. Run a node, earn Lux from others' builds.

**Acquisition:** Hacker News (Show HN), r/SideProject, IndieHackers.com, dev.to, developer Twitter

**Viral mechanism:** The 60-second demo. "I typed one sentence and this happened."

**Conversion to contributor:** High. Will run a node to earn Lux back.

---

### Profile 2: The API Key Holder

**Who:** Developer with OpenAI/Anthropic key with $50-100/month quota unused nights/weekends. Wants passive income.

**Pain:** Paying for quota they don't fully use. No way to monetize idle quota.

**What Pando gives:** Contribute key → earn Lux passively. Install node, `/contribute anthropic sk-...`, forget about it.

**Why critical:** These ARE the compute supply side. Without contributed keys, the AI Builder and Agent Marketplace don't work at scale.

**Acquisition:** r/LocalLLaMA, r/artificial, AI Twitter, Anthropic/OpenAI Discord

**Viral mechanism:** Lux earnings screenshot. "I earned X Lux this week from doing nothing."

---

### Profile 3: The Platform Refugee

**Who:** Developer burned by Heroku, Parse, Firebase, or Replit pricing changes. Actively looking for alternatives they can trust.

**Pain:** Built something people use → platform rug-pulled → emergency migration.

**What Pando gives:** "There's no company to shut it down." Genuinely true. P2P means no one entity controls hosting.

**Why valuable:** Angry and vocal. They post without being asked. Platform refugee posts on HN regularly spike to the front page.

**Acquisition:** Hacker News (watch for shutdown posts), r/selfhosted, r/devops, "X alternatives" threads

---

### Profile 4: The Open Source Maintainer *(New from second brainstorm)*

**Who:** Maintains a widely-used open source library, framework, or tool. Has millions of downloads/month but earns nothing. Has tried GitHub Sponsors, Patreon, OpenCollective — very few users opt in to donate.

**The frustration:** Built something 50M developers rely on. Gets bug reports at 2am. Gets demanding feature requests. Earns $0 from it. The cognitive dissonance is enormous.

**What Pando gives:**
- Every import, fork, or deployment of their package → automatic micro-Lux payment to the maintainer
- No opt-in required from the user — it's built into the usage
- Accumulates over time: 1M imports × 0.001 Lux = 1,000 Lux passively
- The ContentRegistry tracks attribution; Lux flows automatically

**Why micro-payments work in Lux but not in dollars:** Transaction fees make $0.0001 payments impossible in fiat. In Lux, micro-payments are native. Hundreds of millions of micro-payments add up to significant earnings.

**Why they're strategically valuable beyond their numbers:**
- Highly influential — a trusted HN/Twitter voice
- One post from a respected open source maintainer saying "I earned Lux from my npm package today" = HN front page + tens of thousands of impressions
- They become node operators naturally (technical, invested in the network working)
- They attract the developer community that other platforms can't reach

**The broader vision (creator economy at every layer):**
Open source is just the first application. Any ContentRegistry content can be attributed Lux:
- Blog posts that get shared earn Lux per share
- Research that gets cited earns Lux per citation
- Templates deployed on Pando earn Lux per deployment
- Tools used through the agent marketplace earn Lux per run

**Acquisition:** Hacker News, r/programming, dev.to, GitHub community, npm/PyPI maintainer forums

**Viral mechanism:** "I earned Lux for my npm package. Here's how much." This is a genuinely new story — nobody has ever paid open source maintainers automatically per usage.

---

## CONSUMER DEMAND SIDE

### Profile 5: The Vibe Coder — THE PRIMARY VIRAL AUDIENCE

**Who:** 17-28 years old. Lives on X. Uses AI (Claude, Cursor, ChatGPT) to build things by describing what they want. No formal coding background but has shipped things. Has a ton of app ideas they share with friends but never execute.

**The term:** "Vibe coding" coined by Andrej Karpathy in early 2025. Self-identifying, named, growing community.

**The exact gap Pando fills:**
> They build something with Claude, it works locally, they try to deploy it — and hit a wall. Vercel wants a GitHub account. AWS is terrifying. Netlify is confusing. They give up. Not because AI couldn't build it. Because they didn't know how to make it live.

This happens to thousands of people every day. The market grows proportionally to AI adoption.

**What Pando gives:**
- Zero terminal. Zero setup. Sign in with X → describe it → it's live.
- 50 starter Lux on signup (one free build, no friction)
- Consumer gateway: pando.network, one screen, chat interface
- "Share on X" button after every build with pre-filled tweet
- Invite friends → earn 25 Lux per friend who completes a build

**Market size:** No-code/low-code market: $16B → $68B by 2028. "I built X with AI" posts routinely get millions of impressions.

**Why they'll keep using it:** They won't if they only build once. The retention comes from:
1. Builds that serve a COMMUNITY (Discord server, friend group) — they need the app to stay live
2. Agent jobs (Direction 10) — recurring tasks that bring them back weekly
3. The Group Chat product (Direction 12) — social retention keeps them in the conversation

**Critical requirement:** Consumer gateway must be polished before targeting this audience. Terminal = instant dropout.

**Acquisition:** @pando_network X bot, friend referrals, TikTok/YouTube Shorts demos, r/vibecoding, r/SideProject

---

### Profile 6: The Friend Group Builder *(New from second brainstorm)*

**Who:** A group of 3-8 friends who are all interested in AI, follow tech Twitter, share ideas constantly. They want to build things TOGETHER but none of them can deploy.

**The pain:** Every friend group has recurring "we should build something that does X" conversations. These ideas die because nobody knows how to actually ship.

**What Pando gives:** The Group Chat That Builds (Direction 12). A shared chat where the AI is a member that can build for the group. They describe it together, it's live in minutes, everyone in the group owns it.

**Why this persona matters:** They are the core unit for the Group Chat product. They bring MULTIPLE people to Pando simultaneously (not one-by-one). When their app gets shared, it's shared by multiple people to multiple friend groups.

**The retention hook:** The friend group's app is a SHARED artifact. Even if one person would have moved on, the group keeps the app alive and improving.

**Acquisition:** Organic (one friend who knows about Pando brings the group) + @X mechanic (group replies to the bot together)

---

### Profile 7: The Small Business Owner *(New from second brainstorm)*

**Who:** Runs a business with 1-10 employees. Hair salon, barbershop, restaurant, freelance agency, local retailer, independent consultant. Currently pays $200-2000/month across multiple SaaS tools. Not technical. Doesn't care about AI or P2P — just wants problems solved.

**Real problems they have right now:**
- Customer inquiries via email/DM that take hours to respond to
- Social media posts they know they should write but never do
- Competitor prices they want to track but don't have time to monitor
- Weekly summary of sales/bookings they want without logging into 3 different dashboards
- Website that looks outdated but costs $3,000 to update

**What Pando gives (via Agent Marketplace — Direction 10):**
- "Customer Inquiry Agent" — answers DMs and emails automatically
- "Social Media Agent" — writes 3 posts/week based on their business notes
- "Competitor Monitor Agent" — weekly report on competitor pricing/offers
- "Analytics Summary Agent" — daily email with key numbers
- "Website Update Agent" — describe a change, it's live in minutes

Each agent costs Lux per run. No monthly subscription. No contract. Cancel anytime.

**Why this audience is strategically valuable:**
- Willingness to pay is HIGH — they already spend this money on SaaS tools
- Retention is VERY HIGH — they need the agents to run daily/weekly
- They share recommendations — barber tells barber, salon tells salon, local business network is dense
- They don't care about P2P or Lux philosophy — they care about outcomes
- Each small business that uses Pando daily = significant recurring Lux activity

**The critical caveat:** This audience CANNOT use Pando today. They need:
1. Consumer gateway polished to consumer-grade
2. Agent Marketplace UX designed for non-technical users
3. The pitch must NEVER mention P2P, Lux, decentralization, or blockchain
4. Lead only with outcomes: "more customers, less time on admin, cancel anytime"

**Acquisition channels:**
- Local business meetups (Chamber of Commerce, industry associations)
- Instagram/Facebook ads targeting small business owners (not Twitter)
- Word of mouth — one success story spreads through local business community fast
- Partner with business accountants/consultants who serve this market

**Verdict: HIGHEST REVENUE PER USER. Phase 2 target. Requires consumer gateway + agent marketplace UX first.**

---

### Profile 8: The Crypto / Web3 Disillusioned Developer

**Who:** Got into Web3, got burned by rug pulls and speculation. Believes in decentralization ideals but hates the culture.

**Pain:** Web3 promised decentralization, delivered gambling. IPFS too slow. Smart contracts too expensive.

**What Pando gives:** P2P without blockchain. Lux = work receipt, not speculation token. SQLite + GossipSub. Real utility.

**Why valuable:** They understand why Pando is different from Web3 hype and can articulate it better than we can. They become evangelists.

**Acquisition:** r/ethereum builder communities, Protocol Labs community, developer-focused crypto Twitter (NOT finance Twitter)

---

### Profile 9: The Privacy-First Developer / Activist

**Who:** Runs own email, self-hosts, uses Tor. Distrusts centralized platforms fundamentally.

**Pain:** Every AI tool logs queries. Can't use AI for sensitive work (legal, journalism, activism).

**What Pando gives:** Anonymous by default (no email/KYC). Queries route P2P — even Pando can't log them. Open source — fully auditable.

**Why valuable:** Outsized media influence. A recommendation from privacyguides.org or EFF reaches tens of thousands of pre-qualified users.

**Acquisition:** privacyguides.org, r/privacy, EFF community, Mastodon/Fediverse

---

## TIER 3 — Mass Market (10,000+ nodes)

These users don't run nodes. They use apps BUILT on Pando. Don't know what P2P is. Just see an app that works. They interact with Pando without knowing it. This is how mass scale happens.

---

## Acquisition Strategy by Phase

### Phase 1 (0 → 100 nodes): Manual, High-Touch
- Goal: 20 anchor nodes + first vibe coder users
- 60-second demo → HN Show HN
- DM top contributors to Claude Code tools, libp2p, ComfyUI on GitHub
- Fix every rough edge before adding new features

### Phase 2 (100 → 1,000 nodes): Consumer Gateway + Viral Push
- Consumer gateway live (sign in with X, 50 starter Lux)
- @X bot live (build success rate >90% first)
- ComfyUI bridge launch on r/StableDiffusion
- First small business pilot (find 5 local businesses, run agents for them, get testimonials)
- Open source maintainer outreach (target top 20 npm maintainers)

### Phase 3 (1,000 → 10,000 nodes): Platform Effects
- Agent marketplace UI live (browse, deploy recurring agents)
- Small business marketing (Instagram/Facebook, not Twitter)
- Group Chat product launch (pando.chat)
- Press: "The AI-run network with no CEO"
- Reddit alternative: serious evaluation begins

---

## Key Metrics Per Persona

| Persona | Primary metric | Health signal |
|---|---|---|
| Indie Hacker | Node 7-day retention | >40% |
| API Key Holder | Lux earned/week per contributor | Growing |
| Open Source Maintainer | Lux earned/month per package | Any earnings = proof of concept |
| Vibe Coder | Build completion rate | >80% |
| Friend Group Builder | Group size at time of first build | Average >2 people |
| Small Business Owner | Agent jobs run/week per business | >5 (daily or near-daily) |
