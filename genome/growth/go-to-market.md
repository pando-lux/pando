# Go-To-Market — Phase Plan, Launch Checklist, Retention Strategy

*Last updated: 2026-02-24 (third brainstorm — personal assistant direction added).*

---

## ⚠️ GTM STRATEGY NOT FINALIZED

As of 2026-02-24, no final go-to-market strategy has been selected. Multiple directions are documented and ranked in `market-analysis.md`. The key open decision:

**What is the front door to Pando for consumers?**

| Option | What it means | Status |
|---|---|---|
| A. App Builder | Consumer signs up, describes an app, watches it get built | Current assumption — but has retention problem |
| B. Agent Marketplace | Consumer signs up, browses recurring agent jobs to deploy | Phase 2 — requires UX that doesn't exist yet |
| C. Personal AI Assistant | Consumer gets a persistent agent on signup, talks to it via Telegram | Strong new direction — changes architecture assumptions |
| D. All three as one product | Personal agent IS the front door — it builds apps when asked, deploys marketplace agents when needed, lives in Telegram | Most coherent but highest design effort |

**Critical open questions before finalizing GTM:**
1. Does every consumer get a personal agent on signup? If yes, what does day 1 look like?
2. Is Telegram integration a Phase 1 or Phase 2 feature? (Changes the entire consumer onboarding design)
3. What is the primary retention mechanism: agent jobs (marketplace), relationship (personal assistant), or social (group chat)?
4. Do we build for vibe coders first, or small business owners first? (Different UX, different messaging, different channels)

These questions need a dedicated strategy discussion before finalizing phases and launch sequencing.

---

## The Core Problem We Solved (And One We Haven't)

### What We Solved: The Build Problem
P2P AI-managed app building. One sentence → multi-agent build → deployed live URL → GitHub repo → you own it. This works. The demo will prove it.

### What We Haven't Solved: The Retention Problem

> **The App Builder is the right demo. It is not the right final product.**

Here's why: A user builds an app. It works. It's live. They're thrilled.

Then what?

If the app is just for them — they built it, they're done, they never come back. The Lux is spent. There's no reason to return. No recurring engagement. No word-of-mouth. One-and-done.

**The retention gap is the business model gap.** Without retention, every user is an acquisition cost with no lifetime value.

This is not a hypothetical risk. This is the exact pattern every "build your app" platform hits (Glide, Bubble, Draftbit). Users love the first build. Churn starts at day 3.

---

## The Strategic Pivot: From App Builder to Agent Marketplace

### The insight:
The reason someone comes back to Pando is not to build another app.

The reason someone comes back is because **a Pando agent is doing something for them every week.**

This reframes everything:
- Build path = acquisition (one-time spark, shows capability)
- Agent path = retention (recurring jobs, recurring Lux activity, recurring value)

### The repositioning:
**Before:** "Pando builds your app in minutes."
**After:** "Hire AI agents to run your business. Pay per run. No subscription."

Same infrastructure. Same agent system. Same Lux economy. Dramatically better retention.

### Why this works for the Lux economy:
- One-time build: user spends 50 Lux, churns
- Weekly agent job: user spends 5-10 Lux/week × 52 weeks = 260-520 Lux/year
- Monthly top-up behavior → users become buyers in the Lux exchange
- As Lux gets external value (exchange), holding Lux becomes interesting to new users

---

## Phase 1: 0 → 100 Nodes — Proof It Works

### Goal
- 20 anchor nodes (developers who understand what they're running)
- First 50 vibe coder users (consumer gateway, sign in with X, 50 starter Lux)
- Build success rate >90% before any viral push
- One working demo video

### Who we're targeting in Phase 1

**Supply side (nodes):**
- Indie hackers and solo builders on Hacker News + r/SideProject
- API key holders on r/LocalLLaMA (OpenAI/Anthropic key contributors)
- Platform refugees (burned by Heroku, Parse, Firebase, Replit) on HN shutdown threads
- Open source maintainers (top npm/PyPI packages) — DM directly on GitHub

**Demand side (vibe coders):**
- NOT targeted yet at scale — consumer gateway must be polished first
- First users come organically through the demo video

### What "polished" means for the consumer gateway (before mass push):
1. Sign in with X — one click, no account creation form
2. 50 Lux on signup, visible immediately
3. One input: "Describe what you want to build"
4. Real-time build progress visible (SSE streaming)
5. Live URL appears when done
6. GitHub repo link appears (they own the code)
7. Pre-filled X share button: "I just built [app name] with @pando_network — it took [X] minutes"
8. Zero terminal. Zero setup. Zero mention of nodes, P2P, or Lux mechanics.

**Terminal = instant dropout for this audience. One friction point = they never come back.**

### Phase 1 Acquisition Actions (in order)

1. **Make the 60-second demo video** — unedited, real-time, no cuts. See demo script below.
2. **Post to Hacker News** (Show HN: "We built an AI that builds and deploys your app from a sentence")
3. **Post on X** (native video, NOT a YouTube link — native gets 3-5x reach)
4. **DM the top 20 npm maintainers** about the Lux micro-payment system
5. **DM top contributors** to Claude Code tools, libp2p, ComfyUI on GitHub
6. **Fix every rough edge immediately** — Phase 1 is about reputation, not scale

### Phase 1 Success Metrics
| Metric | Target |
|---|---|
| Active nodes (7-day retention) | 20 |
| Build success rate | >90% |
| Build completion rate (user-side) | >80% |
| Vibe coder builds completed | 50 |
| HN Show HN upvotes | >100 |

---

## Phase 2: 100 → 1,000 Nodes — Viral Consumer Push

### Prerequisites (must exist before Phase 2 push)
- [ ] Consumer gateway polished (all 8 requirements above)
- [ ] Build success rate >90% (measured over 7+ days)
- [ ] Content safety gate live and tested
- [ ] @X bot live (see @X bot launch checklist below)
- [ ] Agent Marketplace UX exists (at minimum: 5 agent templates users can deploy)
- [ ] Lux top-up flow works (user can buy Lux when balance hits zero)

### What we push in Phase 2

**@X Bot launch** — see checklist below.

**ComfyUI bridge launch:**
- Target: r/StableDiffusion, r/comfyui, Civitai
- Message: "Earn Lux by contributing your GPU's idle time. Others pay Lux to run ComfyUI workflows without owning a GPU."
- This unlocks a GPU supplier base that is currently untapped

**Open source maintainer outreach:**
- Target: Top 20 npm packages by weekly downloads
- Message: "Your package earned X Lux this week from being imported in Pando builds. Opt in to receive it."
- Even one HN post from a respected maintainer = front page

**First small business pilot:**
- Find 5 local businesses (barbershop, restaurant, consultant)
- Run agents for them (social posts, inquiry responder, competitor monitor)
- Get testimonials + screenshots
- These 5 are the seed for word-of-mouth in the local business community

**Pando Dare campaign:**
- Launch hashtag: #PandoDare
- Seed with 5 weird builds: "An app that only shows dad jokes from the 1980s and plays a rimshot when you read one"
- Let the community generate content

### Phase 2 Retention Mechanics (Critical)
The primary failure mode of Phase 2 is: users build one app, never return. Counter this with:

1. **Agent jobs** — every user who deploys a recurring agent has a reason to return daily/weekly
2. **Community app** — "Pando Vibes" or similar — evolves weekly, users feel ownership
3. **Referral Lux** — 25 Lux per friend who completes a build
4. **X share mechanic** — pre-filled tweet after every build keeps top-of-mind

### Phase 2 Success Metrics
| Metric | Target |
|---|---|
| Active nodes (7-day) | 100 |
| Vibe coder builds | 1,000 |
| @X bot successful replies | 200/week |
| Small business agent jobs/week | >50 total across 5 pilots |
| Lux exchange volume (monthly) | Growing |

---

## Phase 3: 1,000 → 10,000 Nodes — Platform Effects

### When network effects kick in:
At 1,000 nodes, Pando has:
- Meaningful P2P redundancy (no single point of failure)
- Diverse capability coverage (compute, storage, AI keys)
- Enough traffic for the Lux economy to be self-sustaining
- Enough users for the Agent Marketplace to have variety

### Phase 3 expansions:
- **Agent Marketplace UI** — browse, deploy, configure recurring agents
- **Small business marketing at scale** — Instagram/Facebook ads (NOT Twitter), targeting local business owners, "cancel your SaaS stack" messaging
- **Group Chat product** (pando.chat) — if consumer gateway is stable and vibe coder UX is proven
- **Reddit Alternative — serious evaluation** — with 1,000 nodes and ContentRegistry working, run an internal feasibility sprint. Don't announce publicly yet. Assess: can we match Reddit's core loop (post, vote, comment, discover) with P2P infra?
- **Press push** — "The AI-run network with no CEO." Target: Wired, TechCrunch, The Verge, Hacker News.

### The Reddit Alternative decision gate:
At 1,000 nodes, answer these before committing:
1. Does the ContentRegistry handle Reddit-scale write throughput? (Benchmark: 5,000 posts/second)
2. Does P2P search return results in <500ms? (Benchmark vs Reddit search, which is notoriously bad)
3. Can Lux creator earnings be explained to a non-technical user in 10 seconds?
4. Do we have a team that can build a consumer social product? (Different skill set from P2P infra)

If yes to all four: **Reddit Alternative becomes the primary product. AI Builder and Agent Marketplace become acquisition channels for it.**

---

## The 60-Second Demo Script

**Recording setup:** OBS or QuickTime. 1080p. Real terminal or consumer gateway if ready. Timestamp visible in corner. No music. No voiceover (or minimal). Real-time, no cuts.

### Script (exactly what to do, step by step):

**[0:00]** Open terminal or consumer gateway at pando.network
**[0:05]** Type: "Build me a subscription SaaS for meal planning with user auth and a dashboard"
**[0:10]** Hit Enter. Show the output starting immediately.
**[0:15-2:30]** Watch: Manager agent spawns → Builder builds → Tester runs → DevOps deploys
- Show the real terminal output. The messy parts are the proof it's real.
- Developers are deeply skeptical of polished demos. Messy = credible.
**[2:30]** Show: Live URL appears.
**[2:35]** Open the URL in browser. Show: It loads. It works. User auth visible.
**[2:45]** Show: GitHub repo link. Open it. Code is there. Real code.
**[2:55]** Show: Timestamp. 2 minutes and 47 seconds total.
**[3:00]** End card text (don't say it, show it):
> "You own the code. Pay per build, not per month. No company runs this. pando.network"

**Why no voiceover:** Let developers pause and read the terminal output. The proof is in the output. Any narration competes with the thing that builds credibility.

**Where to post (in this order):**
1. X as native video — NOT a YouTube link. Native video gets 3-5x more reach on X.
2. HN Show HN with the video embedded in the first comment
3. dev.to article with the video at the top + written explanation
4. r/SideProject, r/webdev, r/LocalLLaMA

---

## @X Bot Launch Checklist

### Pre-launch requirements (hard gates — do not skip):

- [ ] X developer account ($100/month Basic tier) — apply early, approval takes days
- [ ] Build success rate >90% measured over 7+ days (not just today)
- [ ] Content safety gate: 5-category classifier (harmful, sexual, illegal, spam, abuse) before any description reaches agents
- [ ] Rate limiting: 20 builds/day max initially. Queue auto-reply: "You're #3 in queue, estimated 30 min"
- [ ] Failure handling: if build fails, @pando_network replies "Build failed — we're investigating. DM us your description and we'll run it manually."
- [ ] Monitoring: human checks all @pando_network replies for first 72 hours post-launch

### Bot behavior spec:

**Trigger:** Tweet containing "@pando_network build me [anything]"
**Response time target:** <60 minutes
**Reply format:**
> "Built! Your app is live: [URL] — Code: [GitHub repo] — [X] min, [N] agents — powered by @pando_network"

**Queue reply (when at capacity):**
> "You're #[N] in queue. Estimated [time]. We'll reply when it's live. 🔧"

**Failure reply:**
> "Build hit an error. DM us the description and we'll run it manually. Sorry about that."

**Follow-up change request (in same thread):**
User: "can you add [feature]?"
Pando: "Updated! Same URL works, [feature] added. [X] min, [N] agents."

### Launch sequence:

1. Run bot silently for 48 hours (no public announcement). Fix any issues.
2. Manually seed 5 interesting/funny builds from accounts in the community. These are your seed content.
3. Post the launch thread: "We built 5 apps from 5 random tweets today. Here they are." Show: original tweet → Pando reply → live URL → GitHub repo → build time. That thread IS the launch content.
4. Pin the launch thread to @pando_network profile.
5. Monitor replies for 72 hours. Fix failures fast. Public failures are PR disasters.

### The ongoing content engine:

Every successful @pando_network reply is organic marketing. Every weird request is entertainment. The reply history IS the product portfolio. The bot's feed is a continuous demo reel.

Pick the funniest/most impressive build each week and quote-tweet it from a personal/founder account. "This week's weirdest build: someone asked us to build [description]. Here's what happened." This is the weekly content schedule — zero effort required.

---

## The Viral Loop (Complete)

```
[Person hears about Pando]
[Source: @X reply / Dare / Group Chat invite / Agent Marketplace post / friend share / HN]
         │
         ▼
[Consumer Gateway: pando.network]
[Sign in with X → 50 starter Lux → no friction, no setup]
         │
         ├──────────────────────┐
         ▼                      ▼
[Build path]              [Agent path]
[Type what to build]      [Browse agent marketplace]
[Watch Claude Code work]  [Deploy recurring agent]
[App goes live]           [Agent runs weekly/daily]
         │                      │
         ▼                      ▼
[Share on X — pre-filled tweet]  [Top up Lux when balance low]
[Or: invite friend group          [Tell other small biz owners]
 → pando.chat Group Chat]
         │
         ▼
[Their followers see it → some try it → loop restarts]
         │
         │ (power user path over time)
         ▼
[Wants more Lux → runs a node → contributes API key or GPU]
[Consumer becomes contributor — demand becomes supply]
         │
         │ (open source maintainer path)
         ▼
[npm package earns micro-Lux per import]
[Maintainer posts on HN → HN front page → thousands of new users]
```

**The most important transition:** Consumer → Contributor. The vibe coder who starts spending Lux eventually runs a node to earn it back. The small business owner who gets value might contribute their unused API key. The demand side becomes the supply side over time. This is what makes the network self-sustaining without a company funding it.

---

## What NOT To Do

**Do NOT push to vibe coders before consumer gateway is polished.**
One bad experience = negative tweet = thousands of impressions working against you.
Terminal prompt = instant dropout. One confusing step = they leave and never say why.

**Do NOT launch @X bot before build success rate >90%.**
Bot failures are public. One "sorry, build failed" reply gets screenshotted.
A successful reply gets maybe 50 views. A failure reply gets 5,000.

**Do NOT target small business owners before Agent Marketplace UX exists.**
They cannot use a terminal. They will not read docs. The product must be self-evident.
When pitching to them: NEVER mention P2P, Lux, decentralization, or blockchain.
Lead with outcomes: "more customers, less time on admin, cancel anytime."

**Do NOT oversell the Reddit Alternative publicly.**
It requires full product focus — different team, different UX, different go-to-market.
Park it at 1,000 nodes. Discuss seriously then. If you announce it too early, you set expectations you can't meet and confuse your current audience.

**Do NOT encourage Lux speculation.**
The moment Lux becomes a speculative asset, you attract the wrong users and regulators.
Lux = work receipt. External exchange value emerges from utility, not hype.

---

## The Master Metric

**For the network:** 7-day node retention >40%. This is the core health signal. If nodes are leaving within a week, everything else is noise.

**For the product:** Build completion rate >80%. If 20% of users who start a build don't finish it, that's a UX problem, not a marketing problem.

**For the economy:** Lux velocity (transactions per day, trending up). A network where Lux isn't moving is a dead network regardless of node count.

**For virality:** @X bot successful replies per week, trending up. Each reply is a public demo.

---

## Messaging by Audience

### For developers (Hacker News, r/SideProject):
> "One sentence → agents build → GitHub repo → live URL. You own the code. Pay per build in Lux. Run a node, earn Lux from others' builds."

### For vibe coders (X, TikTok):
> "You described the app. Claude Code built it. It's live. You own the code. You didn't touch a terminal. That's Pando."

### For small business owners (Facebook, Instagram, word of mouth):
> "Stop paying $200/month for 5 SaaS tools. Hire an AI agent to do the same work. Pay only when it runs. Cancel anytime."

### For open source maintainers (GitHub, HN, dev.to):
> "Your npm package earned Lux this week. 50 million developers rely on your code. Now they can pay you automatically — per import, no opt-in required."

### For investors:
> "The deployment wall is the $16B problem nobody talks about. Every developer who uses AI to build apps hits it. We removed it. The network runs itself. The AI is the management team."

### For privacy advocates (Mastodon, r/privacy):
> "Anonymous by default. No email, no KYC. Queries route P2P — we can't log them even if we wanted to. Fully auditable open source. No company owns it."
