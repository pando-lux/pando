---
id: immutable-kernel
severity: critical
applies_to: [guardrails, upgrade-protocol]
created: 2026-02-18
---

# Immutable Kernel

## The Rule

Certain core files cannot be modified by agents or automated processes. Only human-approved governance proposals can change kernel files.

## Protected Files

Defined in `guardrails.ts` as `IMMUTABLE_KERNEL_FILES`:
- `packages/node/src/guardrails.ts` — the safety layer itself
- `packages/shared/src/crypto.ts` — identity and signing
- `packages/ledger/src/transactions.ts` — financial operations
- Core identity and consensus files

## Why This Exists

An agent that can modify the safety layer can disable the safety layer. An agent that can modify crypto can forge signatures. These files are the foundation of trust.

## How Changes Happen

1. Human proposes governance upgrade targeting kernel file
2. Extended vote period (not fast-track)
3. Supermajority required
4. All nodes: git pull + build + verify (Phase 82)
5. Automatic rollback if build fails

## Enforcement

- guardrails.ts `isImmutableKernel()` blocks all agent modifications
- tieredPreCheck() rejects workspace diffs touching kernel files
- upgrade-protocol.ts requires governance approval for kernel changes
