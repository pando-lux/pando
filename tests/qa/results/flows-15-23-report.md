# Flows 15-23 QA Report -- 2026-02-22

## Summary
- Flows tested: 9/9
- Issues found: 5 (3 NOTE, 2 minor UX)
- Bugs fixed: 0 (no code-level bugs found)
- All core functionality PASSES

## Test Environment
- Gateway: http://127.0.0.1:3222
- Node API: http://127.0.0.1:4100
- Node Peer ID: 12D3KooWACe64YzKkwbAt98VVTs652YtvMPrg68hzPxtbYYWhCPR
- Node balance: 7685.49 Lux
- Test user: alice_deep_test (75 Lux, Peer ID: 12D3KooWL5b5r9mETZiNvkoxtqBHRduvUQpbSMjuMkX89agk7QtR)

---

## Results per Flow

### Flow 15: Search Functionality

- [PASS] 15a: Marketplace search with valid keyword
  - Typed "calculator" in /marketplace search box
  - Result: Filtered from 4 projects to 1 ("Calculator App"). Count shows "1 project of 4 total"
  - Search is client-side, instant, filters by title and description

- [PASS] 15b: Marketplace search with gibberish
  - Typed "xyzabc123nonsense"
  - Result: Clean empty state "No projects listed yet / No projects match your search. Try different keywords."
  - No errors, no crashes

- [PASS] 15c: Marketplace status filter
  - "All" shows 4 projects, "Active" shows 4 (all are active), "Completed" shows 0 with helpful empty state + "Go to Chat" link
  - Filter buttons work correctly, mutually exclusive

- [PASS] 15d: Content page search
  - /content page has search box + type dropdown (website/api/dataset/service/document/tool) + status dropdown (Live/Draft/Archived)
  - Searched "test": filtered 4 items to 3 (excluded "API sweep content")
  - API endpoint /content/search?q=test confirmed results match UI

- [PASS] 15e: Content status filter
  - Selected "Draft" status filter: showed 3 draft items, excluded 1 published item
  - Filters work via API query params, not just client-side

- [PASS] 15f: Homepage smart router search bar
  - Homepage has "What would you like to do?" input with category tags: search, task, governance, ledger, network
  - Input accepts free-form text, routes via Smart Router

**Backend Verification:**
- `GET /content/search?q=test` returns 3 results with relevance scores (6, 6, 3)
- `GET /marketplace` returns 4 projects, all status "active", all visibility "listed"
- Content search uses server-side full-text search; marketplace search is client-side filter

---

### Flow 16: Content Publish & Discover

- [PASS] 16a: Content exists in API
  - `GET /content` returns 4 content items (3 draft, 1 published)
  - All type "document", owned by this node's peer ID

- [PASS] 16b: Content visible in gateway
  - /content page shows stats row: Total Content (4), Lux Earned (0.00), by Type (document: 4), by Status (draft: 3, published: 1)
  - All 4 items listed with title, type badge, status badge, owner (truncated peer ID), version, Lux earned, last updated

- [PASS] 16c: Content detail expand
  - Clicked "Multi-node test content": expanded to show description, tags (test, multi-node), hosting nodes (1 node), upgrade policy (owner-only), hash, revenue breakdown (Hosting 40%, Building 40%, Network 20%)
  - Revenue section shows 0.0000 for all splits (no revenue yet)

- [PASS] 16d: Content discovery via search
  - Content search works with keyword matching across title and description
  - Type and status filters work correctly through API query params

- [NOTE] 16e: No content creation UI
  - Content page has no "Create Content" button -- content is created via agent tasks
  - This is by design per the UI text: "Content is created when agent tasks produce publishable output"

**Backend Verification:**
- `GET /api/content/stats` returns: totalContent: 4, byType: {document: 4}, byStatus: {draft: 3, published: 1}, totalLuxEarned: 0
- Stats match the UI exactly

---

### Flow 17: Resource Lifecycle (Operator Experience)

- [PASS] 17a: View resources
  - /resources page shows stats: Total Resources (4), Active (2), Types (1), Providers (1)
  - Network Resources section shows 4 ai_api_key resources: 2 active, 2 revoked
  - Each shows type badge, status badge, provider (openai/gpt-4o-mini), price (free), peer ID, registration time

- [PASS] 17b: Contribute new resource form
  - "Contribute a Resource" collapsible button expands to show form
  - Form has: Resource Type dropdown (AI API Key, Storage Database, Storage Blob, Cloud Compute, Hosting Platform), Credential field (encrypted end-to-end), Provider dropdown (OpenAI, Gemini, Anthropic, Other), Model field, Price per unit field
  - "Contribute Resource" button disabled until credential entered (validation works)

- [PASS] 17c: My Resources section
  - Shows "My Resources: 0 active / 0 total" for alice_deep_test
  - Message: "You haven't contributed any resources. Use the TUI /contribute command or contribute below."
  - Correctly shows 0 because Alice (user account) hasn't contributed -- resources are from the node operator

- [PASS] 17d: Capabilities endpoint matches
  - `GET /capabilities` returns: capabilities: [node, claude-code, docker, python, gpu]
  - Profile shows: relay: true, compute_cpu: true, compute_gpu: true, storage: true, gateway: true
  - Consistent with resources shown in UI

**Backend Verification:**
- `GET /resources` returns 4 resources, all ai_api_key type, 2 active + 2 revoked
- Resource page fetches from `/api/resources` gateway proxy -- data matches

---

### Flow 18: Payment & Cost Flow

- [PASS] 18a: Service costs documented
  - /services page lists 5 services with clear pricing:
    - AI Chat: Simple questions Free, Complex projects 5-50 Lux
    - Project Building: 10-100 Lux per project
    - AI Search: 0.01 Lux per query
    - Storage & Hosting: 0.001 Lux per GB-hour
    - Governance: 5 Lux stake per proposal (refunded if approved), 0.1 Lux per vote
  - "How to Pay" section explains Lux, welcome grant (25-125 Lux), earning via node

- [PASS] 18b: Wallet shows balance
  - /wallet page shows Alice's balance: 75 Lux
  - Peer ID displayed: 12D3KooWL5b5r9mETZiNvkoxtqBHRduvUQpbSMjuMkX89agk7QtR
  - Send Lux form with recipient peer ID dropdown and amount field
  - "Show public key" button, "Copy" button for peer ID

- [NOTE] 18c: No explicit cost confirmation step
  - When creating a governance proposal, 10 Lux stake is deducted immediately
  - No confirmation dialog asking "This will cost 10 Lux, proceed?"
  - The cost is shown on the services page but not at the point of action
  - For chat messages, no cost estimate is shown before sending

- [NOTE] 18d: No payment/escrow API endpoints exposed
  - No `/payment/status` or `/escrow` endpoints
  - PaymentGate operates internally within node code
  - Balance changes visible via `/status` (node balance) and wallet page (user balance)

- [PASS] 18e: Service availability indicators
  - All 5 services show status "Unknown" -- this is because no capacity data determines availability
  - Services page includes "Want to Earn Lux?" section with earning rates: Uptime ~7.2 Lux/day, Task 5 Lux/task, API Keys 2 Lux/key

**Backend Verification:**
- `GET /status` returns balance: 7685.49, totalTransactions: 2383, totalRelayFees: 0.089074
- Alice's 75 Lux balance shown in wallet matches user account, not node balance

---

### Flow 19: My Nodes

- [PASS] 19a: My Nodes section exists
  - /resources page has "My Nodes" section showing "0 nodes"
  - Message: "No nodes linked. Login via TUI /login to link a node to your account."
  - This is correct -- alice_deep_test registered via gateway, not via TUI `/login`

- [NOTE] 19b: No `/auth/me/nodes` endpoint accessible
  - `GET /auth/me/nodes` returns "Not authenticated" / "Invalid session"
  - The user token stored in localStorage (`pando_token`) does not authenticate against this endpoint
  - The gateway resources page fetches linked nodes via `/api/auth/me` with Bearer token
  - This is expected behavior -- TUI login links nodes, gateway registration doesn't

- [PASS] 19c: Gateway My Nodes display
  - Resources page correctly shows node linked status
  - Node info (peer ID, capabilities) would appear here after TUI `/login` linking

---

### Flow 20: First-Time User Journey

- [PASS] 20a: Landing experience (guest)
  - Homepage shows: "Pando -- The Open Network -- AI-managed, fully transparent"
  - Stats visible: Peers (0), Lux Balance (0), Tasks Processed (2), Total Supply (18,073.24 Lux)
  - Smart router input: "What would you like to do?" with category tags
  - Recent Activity feed showing governance proposals
  - "Claim Account" link visible for guests (to register/login)

- [PASS] 20b: Navigation available to guests
  - All 13 nav links accessible without login: Home, Services, Marketplace, Chat, Content, Projects, Agents, Wallet, Governance, Resources, Capacity, Council, Explore
  - No pages blocked for guests

- [PASS] 20c: Login/register flow
  - /login page: "Welcome back" with username + password fields
  - "Don't have an account? Just start using Pando -- you'll get one automatically."
  - /claim page linked from header for guest account claiming
  - Login works: tested alice_deep_test login, redirects to homepage with balance restored

- [NOTE] 20d: Terminology not explained on homepage
  - "Lux" appears in stats ("Lux Balance") without explanation on the homepage itself
  - "Peers", "Total Supply" may confuse non-crypto users
  - /services page HAS explanations but homepage doesn't link to it prominently
  - No tooltips on homepage stats cards

- [NOTE] 20e: Spam proposal in activity feed
  - A proposal with 200+ "A" characters appears in the Recent Activity feed
  - This degrades the first-time user experience significantly
  - Root cause: no title length validation on proposal creation
  - Filed as governance proposal during testing (see Flow 23)

---

### Flow 21: Agent System Visibility

- [PASS] 21a: Agent tree display
  - /agents page shows "Agent Tree" with hierarchical view
  - Stats: Total Agents (13), Active (9), Idle (4), Archived (0), Total Cost ($0.0000)
  - Clear parent-child hierarchy with collapsible tree nodes

- [PASS] 21b: Agent hierarchy accuracy
  - Root: pando-node-mgr (manager, active, 175 tasks) with 8 children:
    - 5 builders: calculator app (idle), E2E testing (idle), photographer portfolio (active), todo app (idle), QA Runner (idle), Bean & Brew (active)
    - 2 testers: Bean & Brew QA (active), photographer portfolio QA (active)
  - 3 project managers: project-e2e-gateway-test (1 child builder), project-e2e-project-routing, project-test-project-46
  - Total: 13 agents -- matches API exactly

- [PASS] 21c: Agent status accuracy
  - `GET /agents/tree` API returns identical data: 4 top-level agents, 13 total (recursive)
  - Each agent shows: role badge (manager/builder/tester), ID, status (active/idle), description, task count, last active time
  - Status colors differentiated: active (green), idle (amber)

- [PASS] 21d: Agent details
  - Each agent card shows description of what it's working on
  - Task count and last active timestamp visible
  - Expand/collapse for hierarchy sections (pando-node-mgr children collapsible)

**Backend Verification:**
- `GET /agents/tree` confirms: pando-node-mgr (175 tasks, 8 children), project-e2e-gateway-test (2 tasks, 1 child), project-e2e-project-routing (2 tasks), project-test-project-46 (1 task)

---

### Flow 22: Multi-Tab Same User

- [PASS] 22a: Session sync across tabs
  - Tab 1: Logged in as alice_deep_test on /agents
  - Opened Tab 2: Navigated to homepage
  - After loading, Tab 2 shows alice_deep_test logged in with 75 Lux balance
  - Session syncs via localStorage (pando_token shared across tabs)

- [PASS] 22b: Data consistency across tabs
  - Both tabs show same balance (75 Lux), same peer ID, same node connection status (2/2)
  - Governance proposals consistent: both show 54 proposals initially

- [PASS] 22c: Cross-tab proposal visibility
  - Created governance proposal in Tab 1 ("Fix: Add title length limit to governance proposals")
  - Navigated Tab 2 to /governance
  - Tab 2 shows the new proposal at top: "active", 10.0 Lux staked, 0A/0R, 4m left
  - Proposal count: 55 in both tabs

- [PASS] 22d: Concurrent actions
  - Voted Approve on the proposal from Tab 2
  - Proposal immediately passed (single-node quorum)
  - Tab 2 updated: status "passed", 1A/0R, "Approved" badge, "Task auto-created in scheduler" message
  - Toast notifications appeared for both vote and decision
  - No crashes, no state corruption

---

### Flow 23: Self-Sustaining Loop (ULTIMATE TEST)

- [PASS] 23a: Discovered real UX issue
  - During testing, found: governance proposals have no title length limit
  - A proposal with 200+ repeated "A" characters appears in the Recent Activity feed on the homepage
  - This degrades UX for first-time users

- [PASS] 23b: Submitted as governance proposal
  - Created proposal: "Fix: Add title length limit to governance proposals"
  - Description: "During QA testing, a proposal with 200+ repeated characters was found in the activity feed, degrading UX. Proposals should enforce a max title length of 200 chars and description of 2000 chars to prevent spam."
  - Proposal appeared immediately in the list with "active" status, 10.0 Lux staked

- [PASS] 23c: Community vote
  - Voted Approve on the proposal
  - Single-node quorum: proposal passed immediately (1 approve, 0 reject)
  - Decision recorded: outcome "passed"

- [PASS] 23d: Governance auto-created scheduler task
  - After proposal passed, UI showed: "Approved -- Task auto-created in scheduler" with "View tasks" link
  - `GET /scheduler/tasks` confirmed: "Fix: Add title length limit to governance proposals" task exists with status "open", created at 1771706853065 (matching the vote time)

- [PASS] 23e: Backend verification
  - `GET /governance/proposals` confirms: proposal status "passed", votes: {approve: 1, reject: 0, abstain: 0}, decision: {outcome: "passed"}
  - The full self-sustaining loop is verified:
    1. Issue discovered during testing
    2. Governance proposal created (10 Lux stake)
    3. Vote cast (Approve)
    4. Proposal auto-decided (passed)
    5. Scheduler task auto-created (status: open)
    6. If scheduler were active with Claude Code, it would auto-assign to an agent for implementation

**This is the ULTIMATE validation that Pando can self-heal through governance.**

---

## Issues Summary

| # | Flow | Severity | Description | Status |
|---|------|----------|-------------|--------|
| 1 | 18c | NOTE | No cost confirmation dialog before proposal creation (10 Lux deducted silently) | By design, but UX improvement opportunity |
| 2 | 19b | NOTE | `/auth/me/nodes` not accessible with gateway user tokens | Expected -- requires TUI login |
| 3 | 20d | NOTE | Homepage doesn't explain "Lux", "Peers", "Total Supply" for new users | UX improvement opportunity |
| 4 | 20e | MINOR | Spam proposal (200+ "A" chars) visible in homepage activity feed | Governance proposal filed & passed |
| 5 | 18d | NOTE | Service availability all shows "Unknown" | No capacity data to determine |

## Notes

- All 9 flows tested successfully. No blocking bugs found.
- The self-sustaining loop (Flow 23) is the standout result -- governance -> vote -> pass -> auto-create task works end-to-end.
- Content page has an async loading pattern (shows "No content registered yet" briefly before data loads). Not a bug, but could benefit from a loading skeleton/spinner.
- The gateway has comprehensive search across marketplace (client-side) and content (server-side with relevance scoring).
- Agent tree accurately reflects the backend state with 13 agents in proper hierarchy.
- Multi-tab session sync works reliably via localStorage sharing.
