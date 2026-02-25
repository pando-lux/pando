# Pando Gateway — QA Context

## What This Is
Pando is a decentralized AI-managed network. The gateway is a Next.js web UI that connects to a local Pando node via HTTP API.

## URLs
- Gateway: http://127.0.0.1:3222
- Node API: http://127.0.0.1:4100
- API token file: ~/.pando/api-token (needed for authenticated endpoints)

## Authentication Model
- Users start as **guests** (anonymous, get 125 Lux welcome faucet)
- Guests can **claim** an account (set username + password) — keeps same peer ID
- Claimed users can **login** from any device
- Auth token stored in browser localStorage
- Node API: POST /auth/guest → POST /auth/claim → POST /auth/login → GET /auth/me

## Pages (all in gateway)
| Page | URL | What It Does |
|------|-----|-------------|
| Home | / | Dashboard: balance, network stats, peer count |
| Chat | /chat | AI chat threads, send messages to manager agent |
| Wallet | /wallet | Balance, peer ID, username, transfer UI |
| Governance | /governance | Proposals list, vote, create proposals |
| Services | /services | Service catalog (5 services with Lux costs) |
| Marketplace | /marketplace | Browse projects, search/filter |
| Capacity | /capacity | Network supply/demand, provider stats |
| Council | /council | Council members, rotation, minutes |
| Network | /network | Peer topology, node balances |
| Resources | /resources | Contributed resources, manage resources |
| Agents | /agents | Agent tree, status, hierarchy |

## Critical User Flows
1. **New user**: Land on homepage → browse services → register account → try chat
2. **Governance**: View proposals → create proposal → vote on proposals → see results
3. **Chat**: Open chat → send message → get AI response → thread persists across sessions
4. **Wallet**: Check balance → see peer ID → view transactions
5. **Multi-user governance**: User A creates proposal → User B sees it → User B votes → User A sees vote count update

## Known Past Bugs (fixed, but verify they stay fixed)
- Balance showing 0 on first load (auth context delay)
- Chat sidebar stuck on "Loading..." (auth token null handling)
- Governance showing "No proposals" despite 52+ existing proposals
- Resources showing 0 resources despite 4 existing
- Wallet showing "—" for all fields

## What Matters Most
1. **Data correctness**: Do numbers match reality? Balance, supply, peer count, proposal counts
2. **Auth flow**: Can a guest register, logout, login, and maintain identity?
3. **State persistence**: Do threads, proposals, votes persist after page navigation?
4. **Error handling**: What happens on bad input, network errors, empty states?
5. **Multi-user isolation**: Are user accounts properly isolated? Can user A see user B's private data?
6. **UX clarity**: Would a new user understand what to do?

## Node API Endpoints (for verification)
- GET /status — node health, balance, peers
- GET /chat/threads — list chat threads
- GET /governance/proposals — all proposals
- GET /marketplace — project listings
- GET /capacity — network capacity
- GET /council — council state
- POST /auth/guest — create guest identity
- POST /auth/claim — claim guest with username/password
- POST /auth/login — login with credentials
- GET /auth/me — current user profile

## Test Accounts
- Alice: username "alice_qa_2026", password "AliceTest123!"
- Bob: username "bob_qa_2026", password "BobTest456!"
- Create fresh if they don't exist (guest → claim flow)
