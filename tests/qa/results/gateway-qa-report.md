# Gateway QA Report -- 2026-02-22

## Summary
- **Total issues found: 19**
- **Critical: 3 | High: 5 | Medium: 6 | Low: 3 | Cosmetic: 2**

---

## Phase 1: Homepage & Navigation

### Pages Tested

| Page | URL | Loads? | Data? | Console Errors? | Status |
|------|-----|--------|-------|-----------------|--------|
| Home | / | Yes | Yes | None | PASS |
| Services | /services | Yes | Yes (5 services) | None | PASS |
| Marketplace | /marketplace | Yes | Empty state | None | PASS |
| Chat | /chat | Yes | Yes | None (until send) | PASS* |
| Content | /content | Yes | Empty state | None | PASS |
| Projects | /projects | Yes | Empty state | None | PASS |
| Agents | /agents | Yes (3s delay) | 2 agents shown | None | PASS |
| Wallet | /wallet | Yes | Balance + identity | None | PASS |
| Governance | /governance | Yes (5s delay) | 41 proposals | None | PASS* |
| Resources | /resources | Yes (5s delay) | All zeros | None | FAIL |
| Capacity | /capacity | Yes (5s delay) | Table data | None | PASS* |
| Council | /council | Yes (5s delay) | 1 member | None | PASS |
| Explore | /explore | Yes | 6 sub-pages | None | PASS |
| Explore/Network | /explore/network | Yes (5s delay) | 3 nodes | None | PASS* |
| Explore/How It Works | /explore/how-it-works | Yes | Static content | None | PASS |
| 404 page | /nonexistent | Yes | 404 text | 1 (expected) | PASS* |

### Issues Found
- **[BUG-01]** Homepage Total Supply shows 8,809.69 but API /status returns 13,307.44 and /capacity returns 17,307.94
- **[BUG-02]** Homepage Balance shows 125 (guest faucet) -- this is the viewer's balance, not the node's
- **[BUG-03]** Resources page shows 0 resources despite API /resources returning 4 (2 active, 2 revoked)
- **[BUG-04]** Governance shows 41 proposals but API returns 54. Missing 13 proposals from display
- **[BUG-05]** Capacity page Total Accounts shows 33 but /capacity API returns 113, /status returns 76
- **[BUG-06]** 404 page is bare -- no navigation header, no "Go Home" link, user is stranded
- **[BUG-07]** Network page Total Supply shows 8,809.69 -- same stale/wrong data source as homepage

---

## Phase 2: Auth Flow -- Alice (Tab 1)

### Registration (Claim Account)
- **PASS**: Navigate to /claim, fill username "alice_qa_2026", password "AliceTest123!", confirm password
- **PASS**: Click "Claim Account" -- redirected to homepage with "alice_qa_2026" shown in header
- **PASS**: Balance shows 125 Lux (welcome faucet)

### Logout
- **PASS**: Click "Logout" -- username disappears, shows truncated peer ID and "Claim Account" link
- **ISSUE**: After logout, a new guest identity is created with 0 Lux (expected but potentially confusing)

### Login
- **PASS**: Navigate to /login, enter "alice_qa_2026" with correct password -- redirected to homepage
- **FAIL**: After login, homepage Lux Balance shows 0 initially, then corrects to 125 on Wallet page
- **PASS**: Wallet page shows correct balance (125 Lux) and correct Peer ID
- **ISSUE**: Header shows truncated peer ID "12D3KooW..." instead of username "alice_qa_2026" after login via /login page (contrast with initial claim which showed username)

### Bad Password
- **PASS**: Enter wrong password -- shows "Invalid credentials" error in red. Does not hang.

### Issues Found
- **[BUG-08]** Username not shown in header after login (shows peer ID instead). Works correctly after claim.
- **[BUG-09]** Homepage balance shows 0 immediately after login, correct on wallet page (race condition / auth context delay)
- **[BUG-10]** Claim Account flow auto-switches theme to dark mode unexpectedly

---

## Phase 3: Auth Flow -- Bob (Tab 2)

### Registration
- **PASS**: Created new tab, logged out, navigated to /claim
- **PASS**: New guest created with different peer ID
- **PASS**: Claimed as "bob_qa_2026" with password "BobTest456!"
- **PASS**: Header shows "bob_qa_2026" correctly after claim

### Multi-Tab Session Issue
- **NOTE**: Both browser tabs share localStorage. Logging in as Bob in Tab 2 also changes Tab 1's session. This is expected browser behavior but means true multi-user testing requires separate browser profiles/incognito windows.

---

## Phase 4: Deep Page Testing (as Bob)

### Chat
- **FAIL**: Sending a message returns "Invalid API token" error
- **FAIL**: Thread created with "0 messages" label and "Invalid Date" timestamp in sidebar
- **FAIL**: Console errors: 403 Forbidden on /api/chat/threads, 404 on /api/chat/threads/undefined/message
- **FAIL**: React "Each child in list should have unique key" warning
- **Root Cause**: The gateway is not correctly passing the API token (from ~/.pando/api-token) to the node API for authenticated endpoints. The chat route requires bearer token auth that gateway users don't have direct access to.

### Governance
- **PASS**: Proposals list loads with 41 items (though 13 are missing vs API)
- **PASS**: Proposal detail expands on click, showing description, proposer, vote counts, comments, comment input
- **PASS**: Status badges (passed/expired) display correctly with color coding
- **PASS**: Lux stake amounts shown where applicable
- **FAIL**: Creating a proposal fails with "fetch failed" error -- POST /api/governance/propose returns server error
- **NOT TESTED**: Voting on proposals -- all visible proposals are expired/passed, no active proposals visible in UI
- **NOTE**: API shows 1 active proposal (with garbage 200+ char title) but it's not displayed in the gateway

### Wallet
- **PASS**: Balance displays correctly (125 Lux)
- **PASS**: Peer ID displays correctly with Copy button
- **PASS**: "Show public key" toggle works
- **PASS**: Send Lux form present with recipient field and amount field
- **PASS**: Send button is properly disabled when fields are empty
- **MISS**: No username display on wallet page -- only peer ID shown

### Services
- **PASS**: All 5 services displayed (AI Chat, Project Building, AI Search, Storage & Hosting, Governance)
- **PASS**: Each service shows status (Online/Limited), description, and Lux cost
- **PASS**: "How to Pay" and "Want to Earn Lux?" sections present with correct info
- **PASS**: Links to Wallet and Capacity pages work

### Marketplace
- **PASS**: Search input and filter buttons (All/Active/Completed) present
- **PASS**: Empty state shows "No projects listed yet" with link to Chat
- **NOT TESTED**: With actual project data

### Capacity
- **PASS**: Supply table shows 8 resource types with pricing
- **PASS**: Demand section shows task metrics (Active/Queued/Total/Success Rate)
- **PASS**: Reward Signals section shows per-resource Lux/unit rates
- **FAIL**: Data mismatch -- Total Accounts (33 vs API 113), Total Supply (8.8K vs API 17.3K)
- **PASS**: Network Health status badge ("degraded") displays correctly

### Council
- **PASS**: Council member table with Peer ID, Reputation, Claude Code, Uptime, Status
- **PASS**: Council Minutes section shows reflection content
- **PASS**: Rotation countdown timer (6d 22h) displays
- **ISSUE**: "This Node" badge labels a peer (12D3KooW...ioMGDP) that isn't the current node (Windows is ...YWhCPR)
- **NOTE**: Reputation score of -174.00 for the shown council member seems anomalous

### Network (via Explore)
- **PASS**: Reputation Leaderboard with 3 nodes ranked by score
- **PASS**: Connected Peers section (empty, correct for 0 peers)
- **PASS**: Requests Sent/Received metrics shown
- **FAIL**: Same data mismatch: Total Supply 8,809.69 vs API 17,307.94

### Resources
- **FAIL**: All stat cards show 0 despite API returning 4 resources (2 active, 2 revoked)
- **PASS**: "My Resources", "My Nodes", "Contribute a Resource", "Network Resources" sections present
- **PASS**: Empty states have helpful guidance text

---

## Phase 5: Multi-User Testing

Due to browser tabs sharing localStorage, true multi-user isolation testing was limited. However:

### Governance Cross-User
- **FAIL**: Could not create a proposal as Bob -- "fetch failed" error prevents testing multi-user governance flow
- **PASS**: Both users can VIEW the same proposals list

### Chat Isolation
- **FAIL**: Chat is completely broken (Invalid API token) for both users, preventing thread isolation testing

### Wallet Isolation
- **PASS**: Alice and Bob have different peer IDs
- **PASS**: Both users get 125 Lux welcome faucet independently
- **NOTE**: Each logout creates a new guest identity consuming another 125 Lux from the network

---

## Phase 6: Edge Cases & Stress

### Empty Forms
- **PASS**: Create Proposal button disabled when fields are empty (proper validation)
- **PASS**: Chat Send button disabled when input is empty
- **PASS**: Wallet Send button disabled when recipient/amount are empty

### XSS
- **PASS**: `<script>alert(1)</script>` in chat input is displayed as text, not executed. React's JSX escaping handles this correctly.

### Invalid Navigation
- **PASS**: /nonexistent returns 404 page
- **FAIL**: 404 page has no navigation -- user is completely stranded

### Rapid Navigation
- **PASS**: Quickly clicking between pages works without crashes
- **NOTE**: Some pages flash "Loading..." for 1-5 seconds before data appears

### Theme Persistence
- **PASS**: Dark mode toggle works and persists across page navigation
- **FAIL**: Theme changes unexpectedly during account claim flow

---

## Phase 7: UX Review

### Navigation
- **GOOD**: Top navigation bar is clean and consistent across all pages
- **CONCERN**: 13 items in nav bar is overwhelming. Consider grouping (e.g., "Explore" could contain Network, Council, Content)
- **CONCERN**: "Chat" and "Content" are next to each other but serve very different purposes -- potential confusion
- **GOOD**: Active page is highlighted with orange pill

### New User Experience
- **GOOD**: Homepage clearly communicates "The Open Network" concept
- **GOOD**: "What would you like to do?" input box is inviting and central
- **GOOD**: Quick action tags (search, task, governance, ledger, network) help categorize
- **GOOD**: Services page explains what you can do and what it costs
- **FAIL**: Chat (the primary user action) is broken, which kills the new user experience
- **CONCERN**: "Claim Account" button text is confusing -- "Sign Up" or "Create Account" would be clearer

### Error Messages
- **GOOD**: "Invalid credentials" on login is clear
- **BAD**: "fetch failed" on proposal creation is generic and unhelpful
- **BAD**: "Invalid API token" in chat is a technical error exposed to end users
- **BAD**: "Invalid Date" in sidebar is a rendering bug exposed to users

### Visual Design
- **GOOD**: Consistent orange accent color throughout
- **GOOD**: Card-based layout is clean and readable
- **GOOD**: Dark mode implementation is thorough
- **GOOD**: Status badges (passed/expired/online/limited) are color-coded and clear
- **CONCERN**: Monospace font for Lux costs on Services page looks like code, not currency
- **MINOR**: The "1/2" indicator next to "Pando" in the logo area is unexplained (appears to be a peer count ratio)

### Terminology
- **CONCERN**: "Peer ID" is technical jargon -- consider "Account ID" or "Node Address" for user-facing pages
- **CONCERN**: "Lux" has no immediate meaning for new users -- the Services page helps but the homepage doesn't explain it
- **GOOD**: "Governance" is self-explanatory in context

### Would I Use This App?
The foundation is solid and the design is clean. However, the critical chat functionality being broken means the primary user flow is dead. If chat and governance creation worked, this would be a usable early-stage product. The data inconsistencies across pages undermine trust -- when I see different numbers for the same metric on different pages, I don't know what to believe.

---

## Bug List (sorted by severity)

| # | Severity | Page | Description | Expected | Actual | Fix Suggestion |
|---|----------|------|-------------|----------|--------|----------------|
| 1 | CRITICAL | Chat | Sending any message fails with "Invalid API token" | Message sent and response received | 403 Forbidden error, message stuck | Gateway API routes need to forward the node's API token from server-side, not rely on client-side auth |
| 2 | CRITICAL | Governance | Creating a proposal fails with "fetch failed" | Proposal created successfully | Server error on POST /api/governance/propose | Check gateway API route for governance -- likely missing API token forwarding or wrong endpoint |
| 3 | CRITICAL | Chat | Thread ID is "undefined" -- API call to /api/chat/threads/undefined/message | Valid thread ID generated | Thread creation fails silently, subsequent message POST uses undefined ID | Fix thread creation flow -- likely the initial POST to create thread fails, leaving ID as undefined |
| 4 | HIGH | Multiple Pages | Total Supply disagrees across pages: Homepage 8,809, Network 8,809, Capacity 8.8K, API /status 13,307, API /capacity 17,307 | Consistent number from authoritative source | 3+ different values shown | Determine single source of truth for supply data, use consistently |
| 5 | HIGH | Multiple Pages | Total Accounts disagrees: Capacity 33, Network 33, API /status 76, API /capacity 113 | Consistent number | 4 different values | Same fix as above -- unify data source |
| 6 | HIGH | Resources | Page shows 0 resources despite API /resources returning 4 (2 active, 2 revoked) | 4 resources displayed (or 2 if filtering active only) | All stat cards show 0, network resources section empty | Check if Resources page is calling the right API endpoint and parsing response correctly |
| 7 | HIGH | Governance | Only 41 of 54 proposals shown (missing 13) | All proposals visible | 24% of proposals missing from UI | Check if gateway is filtering proposals incorrectly or using a stale/cached list |
| 8 | HIGH | Chat | Thread sidebar shows "Invalid Date" | Formatted timestamp | "Invalid Date" text | Fix date parsing in thread list component -- likely receiving null/undefined timestamp |
| 9 | MEDIUM | Auth | Homepage balance shows 0 immediately after login, then corrects on other pages | Balance shown immediately after login | Shows 0 briefly due to auth context race | Add loading state for balance, or ensure auth context is fully resolved before rendering |
| 10 | MEDIUM | Auth | Header shows peer ID instead of username after login (works after claim) | Username displayed when available | Truncated peer ID shown | Login flow may not be updating the user context with username field |
| 11 | MEDIUM | Auth | Claim Account flow auto-switches to dark mode | Theme unchanged after account creation | Dark mode activates unexpectedly | Check if theme state is being reset or overwritten during the claim redirect |
| 12 | MEDIUM | Council | "This Node" badge labels wrong peer (shows ORC node, not Windows node) | Badge on current node's row | Badge on different peer's row | Cross-check peerId comparison logic in council member rendering |
| 13 | MEDIUM | Governance | Active proposal with 200+ char garbage title exists in API but not shown in gateway | Active proposals shown prominently | Not visible in the 41 shown proposals | Check if gateway has a character limit filter or is dropping active proposals |
| 14 | MEDIUM | Chat | React key warning: "Each child in a list should have a unique key" | No console warnings | Warning in console | Add unique key prop to message/thread list items |
| 15 | LOW | 404 | 404 page has no navigation header or "Go Home" link | Branded 404 page with nav and link back | Generic Next.js 404, user is stranded | Create custom 404 page with layout wrapper |
| 16 | LOW | Wallet | Username not displayed on wallet page -- only peer ID | Username shown alongside peer ID | Only peer ID displayed | Add username to wallet identity section when user has claimed account |
| 17 | LOW | Auth | Login form pre-fills with "testuser" / "TestPass123" from previous session | Empty or autofilled by browser | Static test values in form fields | Check if these are hardcoded defaults in the login component |
| 18 | COSMETIC | Nav | "1/2" displayed next to Pando logo with no explanation | Clear indicator label or nothing | Mysterious "1/2" ratio | Either label it (e.g., "1 of 2 nodes") or remove it if not meaningful |
| 19 | COSMETIC | Services | Lux costs displayed in monospace/code font | Regular or currency-styled font | Code-styled text for costs | Use normal font for cost values, or style them as currency |

---

## What Works Well

1. **Navigation is clean and consistent** -- top bar with active highlighting, breadcrumbs on sub-pages
2. **Auth flow (claim) works end-to-end** -- guest creation, claim, login, logout all functional
3. **Bad password handling** -- clear error message, no hanging or crashes
4. **XSS protection** -- React's JSX properly escapes script tags in user input
5. **Empty states** -- pages without data show helpful messages and calls-to-action
6. **Service catalog** -- clearly explains what Pando offers with costs, well-designed cards
7. **Governance detail view** -- expandable proposals with description, votes, comments, timestamps
8. **Agent tree** -- real data from node, hierarchical display with role badges
9. **Dark mode** -- thorough implementation across all pages
10. **Explore section** -- well-organized hub for network information
11. **How It Works page** -- concise and educational
12. **Capacity dashboard** -- comprehensive supply/demand/reward view with proper table layout
13. **Council page** -- useful rotation timer, member table, minutes section
14. **Quick action buttons** in chat (Node Status, My Balance, etc.) -- good UX shortcut
15. **Responsive loading states** -- "Loading..." indicators while data fetches

---

## Recommendations (Priority Order)

1. **Fix chat API token forwarding** -- this is the #1 user flow and it's completely broken
2. **Fix governance proposal creation** -- second most important user action
3. **Unify data sources** -- total supply, total accounts must come from one authoritative endpoint
4. **Fix resources page** -- it has data but doesn't show it
5. **Fix governance proposal filtering** -- show all proposals, especially active ones
6. **Add custom 404 page** -- low effort, high polish improvement
7. **Show username in header consistently** -- after both claim AND login
8. **Fix thread sidebar date rendering** -- "Invalid Date" looks unprofessional

---

## Test Environment

- **Gateway**: http://127.0.0.1:3222 (Next.js 16 dev mode)
- **Node API**: http://127.0.0.1:4100
- **Node Peer ID**: 12D3KooWACe64YzKkwbAt98VVTs652YtvMPrg68hzPxtbYYWhCPR
- **Browser**: Chromium (via Playwright)
- **Platform**: Windows 11
- **Test accounts created**: alice_qa_2026, bob_qa_2026
- **Screenshots**: saved to tests/qa/screenshots/ (19 screenshots)
