# AINet: Identity and Human Verification

## The Problem

AINet promises user anonymity. But without any verification:
- Bots flood the network
- One person creates 10,000 fake accounts (Sybil attack)
- Spam overwhelms services
- The economy gets gamed
- Trust breaks down

The solution: **Proof of Personhood, NOT Proof of Identity.** Prove you're a unique human without revealing WHO you are.

---

## Progressive Trust Levels

Not everyone needs the same level of verification. The system is progressive:

### Level 0: Anonymous Visitor
- **Requirements**: None
- **Can do**: Browse, read, search, use basic services
- **Cannot do**: Post content, transact, earn tokens, participate in economy
- **Purpose**: Let anyone explore AINet with zero friction

### Level 1: Human-Verified
- **Requirements**: Pass an AI-generated human challenge OR demonstrate human behavior patterns for 24 hours
- **Can do**: Post content, use services, earn micro-tokens
- **Cannot do**: Large transactions, marketplace selling, high-value activities
- **How it works**:
  - AI generates challenges that are easy for humans, hard for bots (not CAPTCHAs — more like reasoning tasks, creative tasks, contextual understanding)
  - OR: Use the network naturally for 24 hours. AI analyzes behavior patterns and confirms human-like activity (browsing patterns, interaction timing, content engagement patterns that bots can't replicate)
  - Both methods are privacy-preserving — no personal information collected

### Level 2: Unique-Human-Verified (Primary Level)
- **Requirements**: Verification through the Privacy Relay
- **Can do**: Full transactions, marketplace participation, full token earning, all services
- **Cannot do**: Only restricted by service-specific credential requirements (Level 3)
- **How it works**: See Privacy Relay section below

### Level 3: Credential-Verified
- **Requirements**: Zero-knowledge proof of specific credentials
- **Can do**: Access services that require specific qualifications (medical, legal, financial, age-restricted)
- **How it works**: ZKP-based. Prove "I'm a licensed doctor" without revealing name. Prove "I'm over 18" without revealing age or identity. Credentials issued by recognized authorities, verified by AI nodes.

---

## The Privacy Relay (Core Innovation)

The Privacy Relay is an independent service that bridges real-world identity verification with AINet's anonymity.

### How It Works

```
Step 1: User initiates verification
        User → Privacy Relay: "Verify me"

Step 2: Privacy Relay verifies the human
        Relay sends SMS/email verification code
        User confirms the code
        Relay confirms: this is a real, unique phone/email

Step 3: Relay generates anonymous token
        Relay creates a one-way cryptographic hash of the phone/email
        Hash is used ONLY to check uniqueness (one phone = one token)
        The phone number itself is immediately discarded
        Relay generates an anonymous "unique-human token"

Step 4: Token sent to AINet
        Relay → AINet: "Here is a verified unique-human token"
        AINet stores ONLY the token
        AINet CANNOT derive the phone number from the token
        Relay CANNOT link the token to the phone number after generation
        The link between identity and token is destroyed

Step 5: User is verified
        Account is now Level 2: Unique-Human-Verified
        Can fully participate in the economy
        AINet knows: "This is a verified unique human"
        AINet does NOT know: who that human is
```

### Security Properties

| Property | Guaranteed? | How |
|---|---|---|
| User remains anonymous to AINet | Yes | Relay never sends identifying info to AINet |
| One person = one account | Yes | Phone hash ensures uniqueness |
| Relay can't track user on AINet | Yes | Relay doesn't know which AINet account the token was assigned to |
| AINet can't trace back to phone | Yes | One-way hash, phone number discarded |
| Relay can't be compelled to reveal users | Yes | Relay doesn't store phone-to-token mapping after generation |

### Multiple Relay Providers

- Not a single relay — multiple independent relay providers
- User chooses which relay to use (like choosing a VPN provider)
- Relays are open-source, auditable, can be run by anyone
- Competition between relays drives better privacy practices
- If one relay is compromised, users can re-verify through a different one

### Alternative Verification Methods (No Phone Required)

Not everyone has a phone. Not everyone trusts phone verification. Alternatives:

1. **In-person verification events**: Community meetups where humans verify other humans face-to-face. Privacy-preserving — you prove you're real, not who you are.
2. **Biometric verification** (optional): Iris scan, fingerprint, etc. through a privacy-preserving device. Hash of biometric used for uniqueness, biometric itself discarded. (Controversial — only as an option, never required.)
3. **Existing credential bridging**: Use a ZKP against an existing credential (passport, ID) to prove uniqueness without revealing identity.
4. **Social verification**: N existing verified users vouch for you. Their reputation is staked — if you're fake, they lose trust score.

---

## Anti-Sybil Defenses (Beyond Verification)

### Behavioral Analysis
- AI continuously monitors activity patterns
- Real humans: varied browsing, natural typing rhythms, contextual interactions
- Bots: repetitive patterns, inhuman timing, lack of context
- Suspicious accounts flagged for additional verification
- Behavioral trust score increases over time with genuine activity

### Economic Sybil Resistance
- Creating accounts is free, but EARNING requires real useful work
- A bot army that can't verify code, build services, or answer queries accurately earns nothing
- The cost of faking useful work exceeds the reward
- Proof of Useful Work naturally filters out non-contributing accounts

### Web of Trust
- Verified users can vouch for new users
- Vouching costs reputation — if the vouched person turns out to be fake, the voucher loses trust
- Creates a natural social verification layer
- Highly-vouched users have higher trust scores

### Rate Limiting for New Accounts
- New accounts (Level 1) have limited capabilities
- Posting limits, transaction limits, earning caps
- Limits relax over time as the account demonstrates genuine activity
- Prevents newly-created bot armies from doing damage even if they bypass initial verification

---

## Trust Score System

Every account accumulates a trust score based on:

| Factor | Impact |
|---|---|
| Verification level | Base score: L0=0, L1=10, L2=50, L3=70 |
| Account age | +1 per month of genuine activity |
| Useful work completed | +points per verification, build, contribution |
| Community vouches received | +points per vouch from trusted users |
| Flags/reports against | -points per confirmed flag |
| Behavioral consistency | +points for human-like patterns over time |

Trust score is public (attached to anonymous account, not to real identity) and affects:
- Access to higher-value services
- Earning multipliers (higher trust = earn more per task)
- Voting weight in governance (higher trust = more influence, within limits)
- Marketplace privileges (higher trust = can sell higher-value items)

---

## Key Principles

1. **Never require real identity.** The goal is "prove you're a unique human" not "prove you're John Smith."
2. **Progressive, not binary.** Low friction to start, higher verification for higher-value activities.
3. **Privacy by design.** Every verification method is designed to prove personhood without revealing identity.
4. **Multiple options.** Phone, in-person, biometric, social — user chooses what they're comfortable with.
5. **Trust is earned, not granted.** Verification is the starting point. Genuine activity over time builds real trust.
