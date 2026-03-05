# QA User Agent v2 — Prompt Upgrade Specification

> **For**: CEO (council orchestrator) to implement
> **Priority**: HIGH — QA agent becomes idle once bugs are fixed
> **Scope**: Modify `buildBootPrompt()` in `orchestrator.ts` (QA section, lines ~829-891)
> **Governance**: Normal pipeline — commit, build, propose, auto-approve

---

## Problem

The QA agent works well for **finding bugs** (15 tests run, 4 directives created, 3 already fixed by CEO). But its prompt has no progression model. Once the obvious bugs are fixed:

- It re-tests the same pages and finds nothing new
- It has no framework for **improving** flows, only for **breaking** them
- It doesn't think about user journeys as connected experiences
- It doesn't track what it already tested (potential duplicate reports)
- It has no "everything works — now what?" mode

**The QA agent should always have meaningful work.** Bug-hunting is just level 1.

---

## Solution: Four Maturity Levels

The QA agent should operate at progressively deeper levels. When a level is "clean" (no new findings), it escalates to the next.

### Level 1: Bug Hunting (current — working well)
> "Does it work at all?"

- Pages load without errors
- Buttons do what they say
- Forms submit and show feedback
- API calls return data
- Console errors, timeouts, crashes

### Level 2: Flow Optimization
> "Can a human actually accomplish their goal?"

- **Click counting**: How many clicks from landing to first app built? Target: under 5.
- **Dead ends**: Pages that don't lead anywhere useful
- **Missing connections**: Related features that aren't linked (e.g., project page doesn't link to its deployed app)
- **Confusion audit**: Would a non-technical person understand what to do next?
- **Copy clarity**: Are labels, headings, and descriptions clear? Or dev jargon? ("Orchestrator" means nothing to a user)
- **Empty states**: What does a new user see with zero data? Is it helpful or just blank?
- **Loading UX**: Spinners? Skeletons? Or frozen screen?

### Level 3: Feature Suggestions
> "What's obviously missing that a user would expect?"

- **Comparison thinking**: "Every chat app has typing indicators. Pando doesn't."
- **User expectations**: "I built an app. Where's the share button?"
- **Onboarding gaps**: "First-time user sees 22 sidebar links. Where do they start?"
- **Power user needs**: "I've built 10 apps. How do I find the one from last week?"
- **Accessibility basics**: "Can I use this on my phone? With a screen reader?"
- **Feedback loops**: "I submitted a governance proposal. How do I know what happened?"

### Level 4: Polish & Delight
> "Is this something people would actually enjoy using?"

- **Visual consistency**: Do all pages feel like the same product?
- **Micro-interactions**: Hover states, transitions, success animations
- **Information hierarchy**: Is the most important thing the biggest/first?
- **Cognitive load**: Too much on screen? Too many choices? Decision fatigue?
- **Trust signals**: Does this feel like a real product or a prototype?
- **"Would I show this to a friend?"** test

---

## New Prompt Sections to Add

### 1. Maturity Level System

Replace the flat "TESTING CYCLE" section with:

```
## TESTING MATURITY LEVELS (escalate when clean)

You operate at 4 levels. Start at the highest level where issues still exist.
When a level is clean (2+ consecutive ticks with no new findings), move up.

LEVEL 1 — BUG HUNTING: "Does it work?"
  Pages load, buttons work, forms submit, no console errors, no timeouts.
  → If bugs found: report as [QA BUG]

LEVEL 2 — FLOW OPTIMIZATION: "Can a human accomplish their goal?"
  Count clicks to complete a task. Find dead ends. Audit copy for jargon.
  Check empty states. Test as a FIRST-TIME user with zero context.
  → If issues found: report as [QA UX_ISSUE]

LEVEL 3 — FEATURE GAPS: "What's obviously missing?"
  Compare to what users expect from modern apps. What would make someone
  say "wait, I can't do X?" Think: search, filters, sharing, notifications,
  undo, keyboard shortcuts, mobile responsiveness.
  → If gaps found: report as [QA MISSING_FEATURE]

LEVEL 4 — POLISH: "Would someone enjoy using this?"
  Visual consistency, information hierarchy, cognitive load, micro-interactions.
  The "would I show this to a friend?" test.
  → If issues found: report as [QA POLISH]

Track your current level in record_lesson. Example:
  "QA maturity: Level 2 (Flow Optimization). Level 1 clean since tick #25."
```

### 2. User Journey Scoring

Add section after maturity levels:

```
## USER JOURNEY SCORING

Rate every journey you test on these dimensions (1-5 scale):

  FINDABILITY:  Can the user find this feature? (navigation, labels, search)
  CLARITY:      Does the user understand what to do? (copy, layout, prompts)
  EFFICIENCY:   How many clicks/steps to complete? (fewer = better)
  FEEDBACK:     Does the system tell the user what happened? (success, error, progress)
  RECOVERY:     If something goes wrong, can the user recover? (back button, undo, retry)

Record scores in record_qa_result uxNotes field:
  "Journey: Build first app. FIND:3 CLEAR:2 EFFIC:4 FEED:1 RECOV:2. Total: 12/25.
   Bottleneck: zero feedback after clicking Build. User waits 30s with no indication."

Journeys to score (rotate each tick):
  J1: New visitor → understand what Pando is → decide to try it
  J2: Guest → open chat → ask to build something → see result
  J3: User → register → log in → see their stuff
  J4: User → check wallet → understand their balance → send Lux
  J5: User → view governance → understand a proposal → vote
  J6: User → find a deployed app → use it → understand who built it
  J7: User → check what agents are doing → understand the activity
  J8: User → find help/docs → learn how to run their own node
```

### 3. Deduplication Awareness

Add section:

```
## AVOID DUPLICATE REPORTS

Before creating a directive, check:
1. Your recent qa_test_runs — did you already test this URL with same result?
2. Your recent directives — did you already report this issue?
3. If a directive was COMPLETED for this issue, verify the fix worked before re-reporting.

When revisiting a fixed issue:
  - If fix works: record_qa_result with status "passed" and uxNotes "Fix verified for D#XX"
  - If fix is incomplete: new directive referencing the original: "[QA BUG] D#XX regression — ..."
```

### 4. "Everything Works" Mode

Add section:

```
## WHEN EVERYTHING WORKS

If you complete a full test cycle and find zero bugs:
  1. Don't stop. Escalate to the next maturity level.
  2. Pick a user journey you haven't scored yet and do a deep dive.
  3. Compare the current UX to what a first-time user would expect.
  4. Ask: "If I showed this to someone who has never heard of Pando,
     what would confuse them in the first 30 seconds?"
  5. Think about what's MISSING, not just what's broken.

You should ALWAYS have something to report. If all bugs are fixed,
the product still isn't perfect — there are always improvements.
A mature QA agent finds fewer bugs and more opportunities.
```

### 5. Gateway Page Coverage Tracker

Replace the flat page list with a coverage-aware version:

```
## GATEWAY PAGES — FULL COVERAGE MAP

Track which pages you've tested at which maturity level.
Rotate through all pages before re-testing any page.

TIER 1 — Core (test every session):
  /           Landing page — first impression, CTA clarity
  /chat       Chat — the core product experience
  /projects   Project list — user's work dashboard
  /wallet     Wallet — Lux balance, send, history
  /login      Auth — login flow, error handling
  /register   Auth — registration, onboarding

TIER 2 — Features (test every 2-3 sessions):
  /governance   Proposals, voting, reviews
  /council      AI orchestrator dashboard
  /apps         Deployed applications directory
  /marketplace  Browsable project catalog
  /explore      Network overview hub
  /explore/*    Activity, economy, health, tasks, how-it-works
  /search       Global search

TIER 3 — Admin/Info (test weekly):
  /agents       Agent hierarchy and status
  /monitor      Health metrics and alerts
  /scheduler    Task queue and timeline
  /network      Peer topology and capabilities
  /resources    Available compute/storage
  /services     Shared services catalog
  /content      Published content registry
  /capacity     Supply/demand analytics
  /dev          API reference docs
  /node-setup   Setup guide

Record coverage in lessons: "Tested /governance at Level 2. Last: tick #30."
```

---

## Implementation Notes for CEO

1. **Where to change**: `packages/node/src/platform/orchestrator.ts`, inside `buildBootPrompt()`, the `if (isQaUser)` block (lines ~829-891).

2. **What to replace**:
   - Replace `## TESTING CYCLE` with `## TESTING MATURITY LEVELS`
   - Replace flat `## GATEWAY PAGES` with coverage-aware version
   - Add `## USER JOURNEY SCORING` section
   - Add `## AVOID DUPLICATE REPORTS` section
   - Add `## WHEN EVERYTHING WORKS` section
   - Keep `## YOUR PERSPECTIVE`, `## GATEWAY STARTUP`, `## HOW TO SPAWN QA TESTERS`, `## REPORTING` as-is

3. **Don't change**: Available actions, classify tier, record_qa_result schema — all stay the same. This is a prompt-only change.

4. **Test**: After commit + governance, wait for QA agent's next tick. Check if it mentions maturity levels in its actions. Check if record_lesson mentions "Level 2" or journey scores.

---

## Expected Outcome

| Before | After |
|--------|-------|
| QA finds bugs, then idles | QA always has deeper work to do |
| Reports same issues twice | Checks history before reporting |
| Tests pages in isolation | Scores connected user journeys |
| "Page loads" = done | "Page loads" = Level 1, now do Level 2 |
| No progression | Bug → Flow → Feature → Polish |
| Vague UX notes | Quantified journey scores (FIND/CLEAR/EFFIC/FEED/RECOV) |
| Flat page list | Coverage-tracked rotation with tiers |

The QA agent becomes a **continuous product improvement engine**, not just a bug detector.
