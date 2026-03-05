---
id: lux-economics
severity: high
enforced_by: [emission-witness, ledger, guardrails]
---

# Lux Economics

## Philosophy

**Lux = work receipt.** No burning, no halving, no staking, no mining. You did real work, here is your pay.

Most crypto systems invent artificial scarcity because the "work" that earns tokens is artificial:
- Bitcoin: miners solve useless math puzzles. Halving exists because otherwise infinite useless work = infinite tokens.
- Ethereum: validators lock up $80K+ as collateral. Burning exists to fight inflation from easy money.
- Solana: same staking model. Inflation schedule exists because rewards are disconnected from real value.

Pando is different. The work that earns Lux is real:
- Answering a user's AI query (costs real API dollars)
- Contributing an API key (real money)
- Relaying data between peers (real bandwidth)
- Completing Scheduler tasks (real compute time)

When work is real, you need exactly four things:
1. **A hard cap** -- 10 billion Lux, ever. This alone guarantees scarcity.
2. **Work-based emission** -- You earn only by doing verified work.
3. **Verification** -- Peers confirm work happened before you get paid.
4. **Daily caps** -- No single node can vacuum up all the Lux.

That is it. No burning (why destroy money?). No halving (the cap handles scarcity). No staking (why punish people for spending?). No mining (the work IS the mining).

---

## Hard Cap

| Parameter | Value |
|---|---|
| Total supply (hard cap) | **10,000,000,000 Lux** |
| Daily cap per node | 500 Lux/day |
| Relay fee | 0.1% per transfer (paid to relay node) |
| Network account | `NETWORK` (mints new Lux for verified work) |

---

## Work Types and Rewards

| Work | What It Means | Base Reward | Daily Cap |
|---|---|---|---|
| **Uptime** | Node is online and reachable | 0.05 Lux per 10-min epoch | 7.2 Lux/day (144 epochs) |
| **Relay** | Forwarded data between two other nodes | 0.01 Lux per verified relay | 24 Lux/day |
| **Task (API)** | Scheduler used node to answer a simple question | 1.0 Lux | -- |
| **Task (short session)** | Node ran a short AI session for the network | 5.0 Lux | -- |
| **Task (long session)** | Node ran a complex AI session | 20.0 Lux | -- |
| **Task (team)** | Node coordinated a multi-agent team | 50.0 Lux | -- |
| **Verification bonus** | Ran a verification task and it passed | +50% of task reward | -- |
| **API key** | Contributed API key was used for a network task | 2x the API cost in Lux | -- |
| **Vote** | Voted on a governance proposal | 0.1 Lux | -- |
| **Proposal accepted** | Proposal passed a vote | 5.0 Lux | -- |

**Removed rewards (anti-farming):**
- Per-PING/QUERY message rewards: removed entirely (infinite farming vector -- spam = profit)
- Per-connection peer rewards: removed entirely (replay on restart -- reconnect = earn again)

---

## Early Adopter Multiplier

| Network Size (by account number) | Multiplier | Rationale |
|---|---|---|
| First 100 accounts | **5x** | Bootstrap: reward the brave early users |
| 101 -- 1,000 | **3x** | Growth: still worth joining early |
| 1,001 -- 10,000 | **2x** | Scale: modest bonus |
| 10,001+ | **1x** | Mature: base rates, Lux is already established |

This is the ONLY special incentive. Simple, transparent, no complexity. The multiplier applies to all work type rewards.

**Example:** Account #50 completing a short task earns 5.0 x 5 = 25.0 Lux. Account #5000 completing the same task earns 5.0 x 2 = 10.0 Lux. Account #15000 earns the base 5.0 Lux.

---

## Witness Verification Flow

### Bootstrap Mode (fewer than 3 nodes on the network)

Self-minting allowed. With only 1-2 nodes, there is no economy to protect and no peers to verify. Once the 3rd peer joins, witness verification activates.

### Normal Mode (3+ nodes)

```
Node A completes work
    |
    v
Node A creates EmissionProposal:
    {
      beneficiary: A's peerId,
      amount: calculated reward,
      workType: "task_completed",
      proof: { taskId, outputHash, verificationSig }
    }
    |
    v
Broadcast to connected peers via GossipSub (pando/emissions topic)
    |
    v
Each peer checks: "Is this proof valid?"
    - Uptime: "Yes, I was connected to A during this epoch"
    - Relay: "Yes, A relayed my data" (sender or receiver confirms)
    - Task: "Yes, this task ID exists and output hash matches"
    |
    v
Peer signs attestation with Ed25519 key and broadcasts it
    |
    v
Quorum reached: 2 witnesses (or 51% of peers if network < 4 nodes)
    |
    v
Emission finalized --> all nodes update their ledger
    |
    v
If no quorum within 5 minutes --> emission expires, no reward
```

**Why this works:**
- A lone node cannot farm -- needs witnesses
- Witnesses validate real proof, not just rubber-stamp
- Works with as few as 3 nodes
- Scales naturally -- more nodes = more witnesses = harder to game

### Enforcement Details

| Parameter | Value |
|---|---|
| Quorum requirement | 2 witnesses (or 51% if fewer than 4 peers) |
| Emission timeout | 5 minutes |
| Rate limit | 10 emission proposals per hour per node |
| Signature type | Ed25519 (same as node identity) |
| Anti-spoofing | Proof must contain verifiable task/relay/uptime data |

**Implementation:** `emission-witness.ts` -- proposal, witness, quorum flow. API endpoints: `GET /emissions/pending`, `/history`, `/stats`.

---

## Anti-Sybil Defenses

| Attack | Defense | How It Works |
|---|---|---|
| Run 100 nodes on 1 machine | IP-hash dedup | All nodes behind same public IP share 1x uptime reward |
| Spam PING to earn | PING rewards removed | Uptime is epoch-based only. No per-message rewards exist. |
| Fake task completion | Verification agent | Checks output. Cross-node verification requires proof hash match. |
| Self-relay (A -> B, you own both) | Sender/receiver + IP check | Relay requires sender != receiver AND different IP hashes |
| Reconnect farming | Connection rewards removed | Uptime is epoch-based, rate-limit resets are meaningless |
| Colluding witnesses (2 friends confirm fake work) | Scale defense | Need 51% collusion at scale. At 100 peers, need 50 colluders. |
| Fake API key | Usage verification | API usage verified by task output (the task must actually produce a result) |

**Key principle:** The cost of gaming the system should always exceed the reward. At 0.05 Lux per epoch, running a VPN with 100 IPs to farm uptime earns ~720 Lux/day. That is not worth the VPN cost until Lux has real value -- and by then, the network is large enough that 51% collusion is impractical.

---

## The Math: Sustainability

### At 1,000 Nodes (Near-Term Target)

```
Average daily earnings per active node:
  Uptime:     ~7.2 Lux   (24h online)
  Relay:      ~10 Lux    (average relay activity)
  Tasks:      ~50 Lux    (5 tasks/day average)
  Resources:  ~20 Lux    (API key contributor)
  Governance: ~0.5 Lux
  -------------------------
  Total:      ~87.7 Lux/day per node

Network daily emission:  87,700 Lux/day
Network yearly emission: ~32,000,000 Lux/year (32 million)
```

**Time to hit hard cap (10B Lux) at 1,000 nodes: ~312 years.**

### At 100,000 Nodes (Long-Term)

```
Network yearly emission: ~3,200,000,000 Lux/year (3.2 billion)
Time to cap: ~3 years at base rate
```

At this scale, the early multiplier has long expired (1x). Three years of healthy emission before the cap starts biting is fine -- by then, Lux has real value from real network usage, and the remaining supply gets competed for. Nodes that do the most valuable work earn the most.

---

## What Happens When the Cap Is Reached

When all 10 billion Lux have been emitted:

1. **Transfer fees (0.1%) still flow** -- relay nodes earn fees from every Lux transfer on the network
2. **Network value creates demand** -- people need Lux to pay for network services (AI queries, code builds, storage, content)
3. **Lux gets recycled** -- users spend Lux on services, service providers earn Lux, providers spend Lux, cycle continues
4. **No new Lux is created** -- but existing Lux circulates through the economy

This is how a real economy works. You do not need to print new dollars forever -- money circulates.

### What Lux Is Actually Worth

Lux has value because the network provides real services people pay for:

```
Network services (what users want):
  - AI queries answered
  - Code built and verified
  - Data stored and served
  - Content discovered and relayed
  - Governance decisions made

User pays Lux --> Node does work --> Node earns Lux --> Cycle

The "price" of Lux emerges from supply (hard cap) and demand (network usage).
```

**Price discovery is organic:** If the network answers 1M queries/month and each query costs $0.01 in real API compute, the network generates $10K/month of real value. The Lux emitted for that work captures that value.

No token sale needed. No exchange listing needed. No DeFi or liquidity pools needed. Real usage creates real value.

---

## Comparison vs Traditional Crypto

| Feature | Bitcoin | Ethereum | Solana | **Pando** |
|---|---|---|---|---|
| Work type | Useless math | Lock up money | Lock up money | **Real AI compute** |
| Earning method | Mining | Staking | Staking | **Doing actual work** |
| Minimum to participate | $10K+ hardware | $80K+ stake | $1K+ hardware | **Just run a node** |
| Burning | No | Yes (fees) | Yes (fees) | **No (why destroy value?)** |
| Halving | Yes (every 4 years) | No | Inflation schedule | **No (hard cap is enough)** |
| Scarcity mechanism | Halving + cap | Burning + issuance | Inflation decay | **Hard cap only (simple)** |
| Energy waste | Massive | Minimal | Minimal | **None** |
| Complexity | High | Very high | High | **Low** |
| What earns tokens | Solving puzzles | Locking capital | Locking capital | **Real services** |
| Who can participate | Rich miners | Rich stakers | Rich stakers | **Anyone with a computer** |

**Pando's edge:** The work is real. The rewards are proportional to real value created. No artificial games needed.

---

## Migration Path (Historical)

The reward system was implemented in three phases:

### Phase A: Fix the Basics (DONE -- commits `1cba1fa`, `4dbb447`, `b891efa`, `448865c`)
- Removed per-message PING/QUERY rewards (infinite farming vector)
- Removed per-connection peer rewards (replay vector)
- Added epoch-based uptime tracking (10-min intervals)
- Added task completion emissions in Scheduler
- Added per-node daily emission cap (500 Lux/day)
- Kept early multiplier as-is (5x/3x/2x/1x)

### Phase B: Witness Verification (DONE -- Phase 12.1, commit `b61763f`)
- New GossipSub topic: `pando/emissions`
- EmissionProposal message type
- Witness attestation protocol (peers validate + sign with Ed25519)
- Quorum: 2 witnesses, 5-min timeout, 10/hour rate limit
- Bootstrap mode: self-mint when fewer than 3 peers

### Phase C: Full Economy (Built -- Phase 18, Resources A-D)
- Cross-node task delegation via resource router
- Resource metering (API cost tracking, verifiable)
- Payment gate (cost estimation, escrow, hold/release/refund)
- Capability registry (what each node can do)
- Resource marketplace (operator pricing, find cheapest provider)

---

## Open Questions

1. **Should relay fees (0.1% on transfers) go to the relay node or be distributed?**
   Recommendation: Keep going to relay node. Simplest incentive for nodes to relay.

2. **Should there be a reputation multiplier?** (Nodes with 99% uptime earn more per task than nodes with 50% uptime)
   Recommendation: Yes, but deferred. Keep it simple first.

3. **How do we handle the transition from self-mint to witness-based?** Existing Lux balances were self-minted during bootstrap.
   Decision: Honor all existing balances. The amounts are tiny (bootstrap phase). Not worth the complexity of a reset.

4. **Should users be able to tip nodes for good work?**
   Decision: Yes -- this is just a normal Lux transfer. Already supported. No new feature needed.
