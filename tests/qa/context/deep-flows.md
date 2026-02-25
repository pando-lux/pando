# Deep Flow Testing — Every Logic Path

## Gateway: http://127.0.0.1:3222
## Node API: http://127.0.0.1:4100
## API Token: read from ~/.pando/api-token

These are the REAL logic flows that must work. Test each one. If something fails, check the code, fix it, rebuild, and re-test.

## CRITICAL: Backend Verification Pattern

For EVERY user action, don't just check the UI — verify the BACKEND state changed correctly.

**Pattern:**
1. BEFORE action: `curl` the relevant API endpoint, note the state
2. DO the action in the browser (Playwright)
3. AFTER action: `curl` the same endpoint, verify state changed
4. COMPARE: does the UI match the API? If not, that's a bug.

**Key API endpoints for verification:**
- `GET /status` — node health, balance, supply, transaction count
- `GET /agents/tree` — agent hierarchy (did a new manager spawn?)
- `GET /chat/threads` (with X-User-Token) — user's threads (did thread get created? correct userId?)
- `GET /chat/threads/:id` — thread detail (messages stored? managerId set? projectId linked?)
- `GET /governance/proposals` — all proposals (proposal created? vote recorded? status updated?)
- `GET /projects` — project list (visibility correct? owner set?)
- `GET /projects/:id/collaborators` — who has access?
- `GET /balance/:peerId` — exact balance (did stake/transfer/escrow change it correctly?)
- `GET /transactions?limit=5` — recent transactions (is the transfer/stake recorded?)
- `GET /resources` — contributed resources (count changed? status correct?)
- `GET /marketplace` — public projects only

**Example verifications per flow:**

**Chat**: After sending message →
- `curl /chat/threads` as user → new thread exists? userId matches? projectId set?
- `curl /agents/tree` → new project manager spawned? Or routed to existing one?
- Thread's managerId → is it project-specific or pando-node-mgr?

**Governance**: After creating proposal →
- `curl /governance/proposals` → proposal exists? proposedBy = Alice's peerId?
- `curl /balance/alice-peer-id` → decreased by stake amount (10 Lux)?
- After Bob votes: proposal.votes.approve incremented? Bob can't vote again?

**Transfer**: Before and after →
- Note both balances before
- After: sender balance = before - amount - (amount * 0.001)
- After: receiver balance = before + amount
- `curl /status` → totalTransactions incremented? totalSupply unchanged?

**Projects**: After creating →
- `curl /projects` → project exists with correct owner peerId?
- `curl /marketplace` → public project appears? private doesn't?
- With Bob's token: `curl /projects` → Bob can see public, not private?

This is how you test backend logic through the frontend. The UI is just the surface — the API is the truth.

---

## FLOW 1: Identity Lifecycle (2 users)

### 1a: Guest → Registered User (Alice)
- Visit gateway as guest
- What does Alice see? Can she browse? What's restricted?
- Register: alice_deep_test / AliceDeep123!
- After registration: does username appear? Balance? Peer ID?
- Navigate to every page — does auth state persist across navigation?
- Refresh page — is she still logged in?

### 1b: Second User (Bob)
- Open new tab
- Visit gateway — should be a NEW guest (different from Alice)
- Register: bob_deep_test / BobDeep456!
- Verify Bob has DIFFERENT peer ID than Alice
- Verify Bob has his OWN balance (not Alice's)

### 1c: Logout/Login Cycle
- Alice logs out → verify guest state
- Alice logs back in → same peer ID? Same balance? Same username?
- Bob is still logged in on other tab? (independent sessions)

### 1d: Bad Inputs
- Try registering with empty username
- Try registering with username that already exists
- Try logging in with wrong password
- Try logging in with non-existent username
- None of these should crash or hang

---

## FLOW 2: Chat — Thread Isolation & Agent Routing

### 2a: Alice Sends Chat Message
- Alice navigates to /chat
- Sends: "Build me a simple landing page"
- Does a thread get created?
- Does the message appear in the chat?
- Does she get a response? (may take 30-60s if agent processes it)
- What's the thread title?

### 2b: Thread Isolation
- Switch to Bob's tab
- Bob navigates to /chat
- Can Bob see Alice's thread? **HE SHOULD NOT** (we just fixed this)
- Bob sends his own message: "Help me debug a Python script"
- Bob should have his OWN thread, separate from Alice

### 2c: Thread Persistence
- Alice navigates away from chat (go to /wallet)
- Alice navigates back to /chat
- Is her thread still in the sidebar?
- Click on it — are previous messages still there?

### 2d: Follow-up Routing
- Alice sends a follow-up in the SAME thread: "Add a contact form to the landing page"
- This should route to the SAME manager agent (not create a new one)
- Check: does the response show awareness of the previous message?

---

## FLOW 3: Governance — Full Lifecycle (2 users)

### 3a: Alice Creates Proposal
- Alice navigates to /governance
- How many proposals are listed? Does the count match API?
- Alice creates proposal: "Add dark mode to gateway" with description
- Does it appear in the list immediately?
- What's the stake cost? Does Alice's balance decrease?

### 3b: Bob Votes
- Bob navigates to /governance
- Can Bob see Alice's proposal? **YES — proposals are public**
- Bob clicks on Alice's proposal — full details visible?
- Bob votes APPROVE
- Does the vote count update?
- Can Bob vote again on the same proposal? **SHOULD BE REJECTED**

### 3c: Alice Sees Bob's Vote
- Alice refreshes governance page
- Does Alice's proposal show 2 votes (Alice + Bob)?
- Is the proposal status correct (passed/active/pending)?

### 3d: Proposal Expiry
- Check if there are expired proposals in the list
- Are they marked correctly?
- Can anyone vote on an expired proposal? **SHOULD BE REJECTED**

---

## FLOW 4: Projects & Marketplace

### 4a: Browse Marketplace
- Visit /marketplace
- Are there projects listed?
- Does search work? Try searching for a keyword
- Does filtering work?
- Click on a project — does detail expand?
- Is there a URL or link to access the project? Is it clickable?

### 4b: Projects Page
- Visit /projects (if it exists)
- Are projects listed?
- Can Alice see her own projects?
- Can Alice see public projects?
- Can Bob see Alice's PERSONAL projects? **SHOULD NOT**
- Can Bob see Alice's PUBLIC projects? **SHOULD**

### 4c: Create Project
- Can Alice create a new project from the UI?
- If create project exists: test personal vs public
- After creating: does it appear in /projects? In /marketplace (if public)?

### 4d: Project → Chat Integration
- If there's an "Open Chat" button on a project
- Click it — does it navigate to /chat with project context?
- Does the message route to a PROJECT-SPECIFIC manager (not the general one)?

---

## FLOW 5: Wallet & Economy

### 5a: Balance Verification
- Alice: check balance on /wallet
- Same balance on homepage?
- Same balance via API (curl /auth/me)?
- All three should match

### 5b: Transfer
- Alice transfers 1 Lux to Bob (need Bob's peer ID)
- Does Alice's balance decrease by 1.001 (amount + 0.1% relay fee)?
- Does Bob's balance increase?
- Check /wallet on both tabs — balances updated?

### 5c: Transaction History
- Is there a transaction list on the wallet page?
- Does it show the transfer Alice just made?
- Are timestamps reasonable?

---

## FLOW 6: Services Page

### 6a: Service Catalog
- Visit /services
- Are all 5 services listed? (AI Chat, Project Building, AI Search, Storage & Hosting, Governance)
- Does each show a Lux cost?
- Are the costs reasonable?
- Is there a "How to Pay" section?

### 6b: Service Links
- Do service cards link to the relevant feature?
- e.g., "AI Chat" → /chat, "Governance" → /governance
- Or are they informational only?

---

## FLOW 7: Capacity Dashboard

### 7a: Data Accuracy
- Visit /capacity
- Does it show providers? How many?
- Does it show supply vs demand?
- Are the numbers non-zero?
- Do they match the API? (curl /capacity)

### 7b: Reward Signals
- Are reward rates visible?
- Do they make sense? (highest demand = highest reward)

---

## FLOW 8: Council

### 8a: Council Members
- Visit /council
- Are council members listed?
- How many? (should be 1-3 based on node count)
- Is this node shown as a council member?

### 8b: Council Minutes
- Are council minutes displayed?
- Are they readable and meaningful?
- Is the rotation schedule shown?

---

## FLOW 9: Network & Resources

### 9a: Network Page
- Visit /network
- Does it show network topology?
- Peer count? (may be 0 if isolated)
- Node balances?

### 9b: Resources Page
- Visit /resources
- How many resources listed?
- Can Alice contribute a new resource?
- Can Alice revoke a resource?
- Are stat cards showing real numbers?

### 9c: Agents Page
- Visit /agents (if exists)
- Is the agent tree visible?
- How many agents?
- Are manager/builder/tester roles correct?

---

## FLOW 10: Navigation & UX

### 10a: Every Nav Link
- Click every link in the navigation bar
- Does each page load without error?
- No 404s? No blank pages? No crashes?

### 10b: Responsive Design
- Resize to mobile width (375px)
- Is navigation still usable?
- Is content readable?
- Resize back to desktop

### 10c: Error States
- Navigate to a URL that doesn't exist (e.g., /nonexistent)
- What happens? 404 page? Redirect? Blank?

### 10d: Console Errors
- On each page, check browser console for errors
- Any unhandled exceptions?
- Any failed network requests?

---

## FLOW 11: Cross-User Interaction Verification

### 11a: Data Isolation Summary
After all testing, verify this matrix:

| Data Type | Alice sees her own? | Alice sees Bob's? | Expected |
|-----------|--------------------|--------------------|----------|
| Chat threads | YES | NO | Threads are private |
| Balance | YES (her own) | NO | Balances private |
| Governance proposals | YES | YES | Proposals are public |
| Votes | YES | YES | Votes are public |
| Public projects | YES | YES | Public = visible to all |
| Personal projects | YES | NO | Personal = owner only |
| Marketplace | YES | YES | Marketplace is public |
| Resources | YES | ? | Check this |

### 11b: Account Independence
- Logging out Alice should NOT affect Bob's session
- Alice's actions should NOT change Bob's balance (except direct transfers)
- Each user should have a completely independent experience

---

## FLOW 12: Edge Cases & Security

### 12a: XSS Prevention
- Try entering `<script>alert('xss')</script>` in:
  - Chat message input
  - Proposal title
  - Username registration
- None should execute JavaScript

### 12b: Empty/Invalid Inputs
- Submit empty chat message
- Submit empty proposal title
- Submit transfer with 0 amount
- Submit transfer with negative amount
- All should show appropriate error messages

### 12c: Rapid Actions
- Click submit button multiple times rapidly
- Navigate rapidly between pages
- Does the app handle this gracefully?

---

## FLOW 13: Project Collaboration (THE CORE TEST)

### 13a: Alice Creates a Project
- Alice navigates to /projects
- Creates new project: "Alice's Todo App" (visibility: public)
- Does it appear in her project list?
- Does it appear in /marketplace for everyone?

### 13b: Bob Discovers Alice's Project
- Bob navigates to /marketplace
- Can Bob find Alice's project?
- Click on it — can Bob see project details?
- Is there a way for Bob to request collaboration or join?

### 13c: Alice Invites Bob
- Alice goes to her project detail
- Adds Bob as collaborator (by peer ID or username)
- Does Bob now have access?
- What permissions does Bob have?

### 13d: Bob Contributes
- Bob opens the project's chat thread
- Sends: "I want to add a dark theme to this app"
- Does the message route to the PROJECT's manager (not the general one)?
- Does Alice see Bob's activity on the project?

### 13e: Project Visibility Matrix
- Alice's PUBLIC project: visible to Bob? YES
- Alice's PERSONAL project: visible to Bob? NO
- After Bob is added as collaborator: can he see project state? YES
- After Bob is removed: can he still see it? Only if public

---

## FLOW 14: Chat → Project Creation (The Magic Moment)

### 14a: Natural Language → Project
- Alice goes to /chat
- Sends: "I want to build a portfolio website"
- Does the system create a project automatically?
- Does a project appear in /projects after the chat?
- Is the thread now linked to the project?

### 14b: Follow-up Messages Stay in Context
- Alice sends: "Add an about page with my photo"
- Does this go to the SAME manager that started the project?
- Does the response show awareness of "portfolio website" context?
- Check node logs: is the manager ID project-specific?

### 14c: Project Appears in Marketplace
- If the project was created as public, does it show in /marketplace?
- Can other users see the project's progress/status?

---

## FLOW 15: Search Functionality

### 15a: Content Search
- Navigate to search (if exists in UI) or use /search
- Search for "governance" — does it return relevant results?
- Search for "todo" — any project matches?
- Search for gibberish "xyzabc123" — empty results, not error?

### 15b: Marketplace Search
- On /marketplace page, use the search/filter
- Filter by project status
- Search by keyword
- Does filtering actually reduce the visible list?

---

## FLOW 16: Content Publish & Discover

### 16a: Content Exists
- Check /content via API — are there content items?
- Visit gateway page that shows content (if exists)
- Are published items visible? Draft items hidden from others?

### 16b: Content Discovery
- Can one user find another user's published content?
- Is there a content browse page?
- Does the content registry have search?

---

## FLOW 17: Resource Lifecycle (Operator Experience)

### 17a: View Resources
- Navigate to /resources
- What resources does this node contribute?
- Are stats accurate (count, types, statuses)?

### 17b: Contribute New Resource
- Is there a UI to contribute a resource?
- Try contributing compute/storage
- Does it appear in the list?
- Does /capabilities reflect the new resource?

### 17c: Revoke Resource
- Find an active resource
- Revoke it
- Does status change to "revoked"?
- Does /capabilities update?

### 17d: Resource Earnings
- Are there earnings shown per resource?
- Do the numbers make sense?
- Where do earnings come from?

---

## FLOW 18: Payment & Cost Flow

### 18a: Cost Estimation
- When Alice sends a complex chat message, does the system show cost estimate?
- Is there a confirmation step for expensive tasks?
- Does the escrow system hold Lux during processing?

### 18b: Payment Completion
- After task completes, is escrow released?
- Does Alice's balance decrease by the correct amount?
- Is there a transaction record?

### 18c: Insufficient Balance
- What happens if Alice tries an expensive operation with no Lux?
- Graceful error? Or silent failure?

---

## FLOW 19: My Nodes (Phase 48)

### 19a: Node Registration
- Alice logs into the TUI with her credentials
- Does the node register under her account?
- GET /auth/me/nodes — does it show this node?

### 19b: Gateway My Nodes
- Visit /wallet or wherever My Nodes is shown
- Does it list nodes registered under Alice's account?
- Is this node shown with correct info (peer ID, capabilities)?

---

## FLOW 20: First-Time User Journey

### 20a: Landing Experience
- Visit homepage as a completely new user (guest)
- Within 10 seconds, can you understand what Pando is?
- Is there a clear call to action? (register, try chat, browse services)
- Is the value proposition visible?

### 20b: Guided Discovery
- Starting from homepage, can a new user figure out how to:
  1. Chat with AI?
  2. See what services are available?
  3. Create an account?
  4. Browse the marketplace?
- Without any documentation or help?

### 20c: Terminology Check
- Are there any terms that would confuse a non-crypto user?
- "Lux", "Peer ID", "Node", "Governance" — are they explained?
- Is there help text or tooltips?

---

## FLOW 21: Agent System Visibility

### 21a: Agent Tree
- Visit /agents (or wherever agents are shown)
- Can Alice see agents working on her project?
- Is the hierarchy clear (manager → workers)?

### 21b: Agent Status
- Are agent statuses accurate (active, idle, archived)?
- Can Alice see cost/token usage per agent?
- Can Alice see what each agent is doing?

### 21c: Agent Access Control
- Can Bob see Alice's project agents? **SHOULD NOT** (private project)
- Can Bob see public project agents? Should be visible

---

## FLOW 22: Multi-Tab Same User

### 22a: Session Sync
- Alice has 2 tabs open, both logged in
- Alice sends a chat message in Tab 1
- Switch to Tab 2 — is the new thread visible?
- Both tabs show same balance?

### 22b: Concurrent Actions
- Alice creates proposal in Tab 1
- While processing, Alice navigates to /wallet in Tab 2
- No crashes? No state corruption?

---

## FLOW 23: The Self-Sustaining Loop (ULTIMATE TEST)

### 23a: Discover Issue
- While testing, note a real UX issue or bug
- Document it clearly

### 23b: Submit as Governance Proposal
- Alice creates a proposal describing the bug/improvement
- Title: "Fix: [actual issue found]"
- Description: reproduction steps

### 23c: Community Vote
- Bob reviews the proposal
- Bob votes APPROVE or REJECT
- Proposal reaches quorum → decision

### 23d: Verify Governance Works
- Did the proposal pass/fail correctly?
- Is the outcome recorded?
- Could a manager agent pick this up and implement the fix?
- (The full auto-fix cycle requires active scheduler — note if it triggers)

This is THE test that proves Pando can self-heal.

---

## FLOW 24: The Chess Game Test (ULTIMATE VALIDATION)

This is the test that proves Pando is real. Every layer must work.

### 24a: User A Builds a Chess Game
- Alice goes to /chat
- Sends: "Build me a chess game. I want a web-based chess game with a clean UI, drag-and-drop pieces, and move validation."
- Manager agent receives message → creates project → spawns builder
- Builder writes the code (HTML/CSS/JS chess game)
- **Backend verify**: `GET /agents/tree` → new project manager + builder spawned?
- **Backend verify**: `GET /projects` → new project created with Alice as owner?
- Code gets deployed → URL generated
- **Backend verify**: `GET /projects/:id/hosting` → hosting URL exists?
- Alice clicks the URL → chess game loads and is playable

### 24b: Project Appears in Marketplace
- The project is public → appears in /marketplace
- **Backend verify**: `GET /marketplace` → chess game project listed?
- Project card shows: name, description, deployed URL, status
- The deployed URL is CLICKABLE — other users can visit and play

### 24c: User B Upgrades to Multiplayer
- Bob browses /marketplace → finds Alice's chess game
- Bob clicks "Open Chat" or sends message about this project
- Sends: "Make this chess game multiplayer so two people can play against each other online. Add a leaderboard that tracks wins."
- **Backend verify**: Message routes to SAME project manager (not a new one)
- **Backend verify**: `GET /agents/tree` → same project manager, new builder spawned?
- Builder modifies the code → adds multiplayer + leaderboard
- Redeployed → same URL updated (or new URL)
- **Backend verify**: `GET /projects/:id/hosting` → hosting updated?

### 24d: Both Users Play Chess
- Alice opens the deployed URL in Tab 1
- Bob opens the same URL in Tab 2
- They play a game of chess (5 minutes)
- Move validation works (can't make illegal moves)
- Both players see each other's moves in real time
- Game detects checkmate/stalemate

### 24e: Winner and Leaderboard
- Game ends — winner displayed
- Leaderboard shows the result
- Both players can see the leaderboard

### What This Tests End-to-End:
1. Chat → agent system → code generation (AI builds real software)
2. Deploy pipeline → hosting → accessible URL (software is LIVE)
3. Marketplace discovery (other users find and use it)
4. Cross-user project contribution (Bob improves Alice's project)
5. Context continuity (same manager handles the project across users)
6. Deployed app actually WORKS (not just code, but usable software)
7. Real-time features (multiplayer requires WebSocket/P2P — tests infra depth)

### Known Gaps for This Test:
- S3 hosting = static files only. Multiplayer needs a backend (WebSocket server).
  Current infra supports static chess (vs AI or local 2-player), not online multiplayer.
- Compute hosting (EC2/containers) needed for server-side game logic.
- Once compute hosting is added, this test becomes fully achievable.
- For now: test the flow UP TO deployment. Verify the URL works for single-player.
  Multiplayer is the NEXT infrastructure milestone.

### Why This Matters:
If a user can say "build me a chess game" and 10 minutes later play it with a friend via a URL they found in the marketplace — Pando has achieved its vision. This is the internet being built by AI, for humans to use.
