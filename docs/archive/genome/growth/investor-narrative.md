# Pando — Investor Narrative & Problem Statement

*For use in investor conversations. Last updated: 2026-02-24.*

---

## The Problem Statement (Use This In The Room)

> Every day, thousands of people use Claude or Cursor to write software. The AI works. The code works. And then they try to deploy it — and they hit a wall. Vercel wants a GitHub account. AWS is terrifying. Netlify has confusing settings. They give up. The idea dies.
>
> Not because AI couldn't build it. Because they didn't know how to make it live.
>
> This is the deployment wall. And it's growing. As AI makes code easier to write, more non-technical people are writing code — and hitting this exact wall in larger numbers every year.
>
> Pando removes the wall. You describe what you want. It builds it, deploys it, provisions the database, pushes the code to your GitHub, and returns a live URL. You don't touch a terminal. You don't create an AWS account. You pay per build, not per month. You own your code.

---

## The Market

### The Named Community: Vibe Coders

The term was coined by Andrej Karpathy (ex-Tesla AI, ex-OpenAI) in early 2025:
> *"There's a new kind of coding I call 'vibe coding' — you fully give in to the vibes, embrace exponentials, and forget that the code even exists."*

This is a real, named, self-identifying demographic. Not niche.

**Market size signals:**
- No-code/low-code market: $16B in 2023 → $68B by 2028
- "I built X with AI" posts on X routinely get millions of impressions when authentic
- r/vibecoding, YouTube channels, X communities — all growing fast
- Every AI coding tool that ships (Cursor, Claude, Windsurf) expands this community

**The key insight:** The deployment wall grows proportionally to AI adoption. More people using AI to write code = more people hitting the wall. Pando's market grows every time Claude or ChatGPT improves. We grow WITH the AI wave, not against it.

---

## The Target Customer

### Vibe Coders / Casual Builders (Demand Side — Viral Engine)

- 17-28 years old, technically curious but not developers
- Used Claude/Cursor/ChatGPT to build something that works locally
- Hit the deployment wall and gave up
- Lives on X, shares what they make, has a friend group that builds together
- Will pay per-build rather than per-month subscription
- Will share their live URL on X naturally — zero paid marketing needed

### Indie Hackers / Solo Developers (Supply Side — The Network)

- Run Pando nodes, contribute API keys and compute
- Earn Lux passively from other builders using their resources
- Build their own apps without subscriptions and platform lock-in
- They ARE the network — more nodes = cheaper compute = better product for everyone

### The Distinction That Matters for Investors

The vibe coder is the ACQUISITION engine. The serious builder is the BUSINESS.

The casual builder who makes something fun and shares it once = great for virality, not retention.

The casual builder who makes something their friend group uses every day = retention. They need it to stay live. They come back. They pay Lux for hosting. They tell their audience.

The journey: casual build (viral) → gets real users → needs features → becomes micro-entrepreneur → runs own node → supplies the network back.

---

## The 5 Differentiators

**1. The Last Mile — Idea to Live URL in One Conversation**
Cursor writes code. You still have to deploy it. Pando writes AND deploys AND provisions the database AND pushes to GitHub AND returns a live URL. That complete journey in one conversation doesn't exist anywhere else.

**2. Zero Account Creation**
Vercel wants GitHub. AWS wants a credit card. Netlify wants an email. Pando: sign in with X, build. No new accounts, no new passwords, no credit card.

**3. Pay Per Build, Not Per Month**
Subscriptions create anxiety for casual projects. $15/month for a fun side project = guilt every billing cycle. Lux is pay-as-you-go. Build once, pay once.

**4. You Own Your Code**
Replit hosts your app on their servers. Stop paying, it dies. Pando builds your app and pushes to YOUR GitHub repo. You own actual software. Even if Pando disappeared tomorrow, your code survives. "You own it" is not a feature — it's a psychological shift.

**5. The Network Compounds**
More nodes = more compute = lower cost per build = more users = more demand = more contributors = more nodes. Every new node makes the product better for every user. Competitors cannot replicate this — it requires a P2P network they don't have.

---

## The Business Model

**Revenue Stream 1: Per-Build Fees**
Every agent build costs Lux. Market-rate vs direct OpenAI costs + compute.
Early pricing: 5-25 Lux per build.

**Revenue Stream 2: Hosting Fees**
Apps stay live for Lux/month. Simple flat rate per deployed app.
Early pricing: 10-50 Lux/month.

**Revenue Stream 3: The Lux Exchange (Building)**
Pando is building its own Lux exchange:
- Contributors who earn Lux get a liquid off-ramp (convert to real money)
- Builders who want to build but don't run a node can BUY Lux
- Exchange fee: 0.1-0.3% per trade (standard DEX model)
- At scale: millions of Lux trading → meaningful fee revenue independent of builds
- Solves the chicken-and-egg problem: Lux has external value from day 1

**Revenue Stream 4: Enterprise / API (Phase 3)**
Organizations deploying internal tools. Priority builds, SLA, private deployments.

---

## Why Now

1. **AI made code writing accessible** — millions of non-technical people are one conversation away from working software. The deployment wall has never been more acute or more widely felt.

2. **The vibe coding community is named and growing** — it's been ~1 year since Karpathy's tweet. The community is established but the tooling hasn't caught up. This is the window.

3. **Platform trust is at a low** — Heroku free tier death (2022), Parse shutdown (2017), Firebase pricing changes, Replit pricing changes. Casual builders are actively looking for something they can trust.

4. **Claude Code as the agent brain** — The quality of autonomous AI work is only now good enough to reliably build and deploy real applications without human intervention. 18 months ago this wasn't possible.

5. **Lux timing** — Regulatory clarity on utility tokens is forming. Utility-first positioning with a clear exchange builds a defensible economic model.

---

## Competitive Landscape

| Competitor | Who it's for | Price | Lock-in | What they miss |
|---|---|---|---|---|
| Replit | Coders | $25/month | Their servers — app dies if you stop | Not for vibe coders, still too technical |
| Devin (Cognition) | Enterprise | $500/month | Their cloud | Price kills individual builders |
| Cursor + Vercel | Technical devs | ~$40/month | Code on GitHub, infra on Vercel | Still requires deployment knowledge |
| Wix / Squarespace | Non-technical | $16-45/month | Their templates | Can't build real apps, just templates |
| Bubble / Webflow | No-code builders | $29-149/month | Their platform | Steep learning curve, still visual coding |

**What none of them have:** A P2P network that builds real code, deploys it end-to-end, lets you own the output, and gets cheaper as more people join.

---

## The Ask (What Resources We Need)

1. **Consumer Gateway** — Web front door for vibe coders. Sign in with X, 50 starter Lux, one text box. The unlock for mass market. Estimated: 2-3 sprints.

2. **@X Bot** — Viral acquisition engine. X developer account, bot infrastructure, content safety, rate limiting. Every successful reply is organic marketing. Estimated: 1 sprint.

3. **Lux Exchange** — Gives Lux external value from day 1. Opens the liquidity market. Enables institutional interest. Estimated: 4-6 sprints.

4. **Initial Compute Fund** — First 10,000 builds need to be subsidized. Starter Lux costs real API money. This is the user acquisition budget.

5. **Node Growth Incentives** — Incentives for first 1,000 anchor nodes. Supply side must exist before demand arrives.

---

## One-Liners (Use These)

**For vibe coders:**
> "Describe your app. It's live in minutes. Zero terminal. Zero setup. You own it."

**For developers:**
> "P2P network where AI builds and deploys your app. You own the code. Pay per build. No subscriptions."

**For investors:**
> "We solved the deployment wall — the last barrier between AI-written code and a live product. The market is everyone who's ever said 'I have an app idea' and never shipped it."

**For press:**
> "The AI-run network with no CEO. Nobody can shut it down. Not even the founder."

---

## The Investor Pitch Arc (Slide by Slide)

1. **The Problem:** Millions have app ideas. AI writes the code now. The deployment wall kills 90% before they launch.
2. **The Market:** $68B market, growing as AI spreads. Named community: vibe coders.
3. **The Solution:** Pando — idea to live URL in one conversation. Zero setup. Pay per build. You own it.
4. **The Demo:** [60-second video — the only slide that matters. No explanation needed after this.]
5. **The Network:** P2P — more contributors = cheaper compute = better for everyone. No central server. Can't be shut down.
6. **The Economy:** Lux = work receipt. Earn by contributing. Spend to build. Exchange for liquidity.
7. **The Business:** Per-build + hosting + exchange fees. Three revenue streams from network growth.
8. **Traction:** [Current nodes, builds completed, early users, Lux in circulation]
9. **The Ask:** Consumer gateway + @X bot + exchange + compute fund.
