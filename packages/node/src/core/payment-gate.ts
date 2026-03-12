/**
 * Payment Gate — Lux payment escrow and cost estimation for tasks.
 *
 * Phase 18.6: Provides payment gating for task execution. Users must have
 * sufficient Lux to cover task costs. Payments are held in escrow during
 * execution and released to the executing node on completion, or refunded
 * on failure/cancellation.
 *
 * Features:
 *   - estimateCost()      — estimate Lux cost based on complexity and category
 *   - canAfford()         — check if user has sufficient balance
 *   - holdPayment()       — escrow Lux for a pending task
 *   - releasePayment()    — pay executing node on task completion
 *   - refundPayment()     — return escrowed Lux on task failure/cancellation
 *   - isFreeTier()        — check if a request is free (search, status queries)
 *   - getPaymentHistory() — query payment records
 *
 * Payment holds are in-memory with persistence to ~/.pando/payment-holds.json.
 * Actual ledger debits/credits use the PandoLedger transfer() method.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CostEstimate, PaymentHold, PaymentRecord } from '@pando/shared';

// ── Constants ────────────────────────────────────────────────────────────────

/** Complexity-to-cost mapping (Lux). */
const COMPLEXITY_COSTS: Record<string, number> = {
  trivial: 0,
  simple: 0.1,
  moderate: 1,
  complex: 5,
  project: 20,
};

/** Categories that are always free (no Lux required). */
const FREE_CATEGORIES = new Set(['search', 'ledger', 'network', 'system']);

/** The NETWORK escrow account holds funds during task execution. */
const ESCROW_ACCOUNT = 'NETWORK';

/** Payment holds expire after 24 hours. */
const HOLD_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ── Minimal Ledger Interface ─────────────────────────────────────────────────

/**
 * Minimal interface for the ledger operations PaymentGate needs.
 * Keeps the module decoupled from the full PandoLedger implementation.
 */
interface LedgerLike {
  accounts: {
    getBalance(peerId: string): number;
    subtractBalance(peerId: string, amount: number): boolean;
    addBalance(peerId: string, amount: number): void;
    exists(peerId: string): boolean;
  };
}

// ── PaymentGate ──────────────────────────────────────────────────────────────

export class PaymentGate {
  private ledger: LedgerLike;
  private holds: Map<string, PaymentHold> = new Map();
  private history: PaymentRecord[] = [];
  private readonly holdsFilePath: string;
  private readonly historyFilePath: string;

  constructor(ledger: LedgerLike, dataDir?: string) {
    this.ledger = ledger;
    const dir = dataDir || join(process.cwd(), '.pando');
    this.holdsFilePath = join(dir, 'payment-holds.json');
    this.historyFilePath = join(dir, 'payment-history.json');
    this.loadState();
    // KB: Sweep expired holds on startup — catches holds that crossed 24h TTL while node was down.
    this.expireStaleHolds();
  }

  // ── Hold Expiration ──────────────────────────────────────────────────────

  /**
   * Lazily expire stale payment holds (older than 24 hours).
   * Auto-refunds the original payer for any expired holds.
   */
  private expireStaleHolds(): void {
    const now = Date.now();
    for (const [id, hold] of this.holds) {
      if (hold.status === 'held' && now - hold.createdAt > HOLD_EXPIRY_MS) {
        if (hold.amount > 0) {
          this.ledger.accounts.addBalance(hold.peerId, hold.amount);
        }
        hold.status = 'refunded';
        hold.updatedAt = now;
        this.recordPaymentEvent(id, hold.peerId, hold.taskId, hold.amount, 'refund');
      }
    }
    this.saveState();
  }

  // ── Cost Estimation ───────────────────────────────────────────────────────

  /**
   * Estimate the Lux cost for a task based on its complexity and category.
   *
   * Cost breakdown:
   *   - compute: 70% of total (agent execution time)
   *   - storage: 10% of total (workspace, artifacts)
   *   - network: 20% of total (P2P sync, relay)
   */
  estimateCost(complexity: string, category: string): CostEstimate {
    // Free tier check
    if (this.isFreeTier(category, complexity)) {
      return {
        luxAmount: 0,
        breakdown: { compute: 0, storage: 0, network: 0 },
        tier: 'free',
      };
    }

    const baseCost = COMPLEXITY_COSTS[complexity] ?? COMPLEXITY_COSTS['moderate'];
    const compute = Math.round(baseCost * 0.7 * 1e8) / 1e8;
    const storage = Math.round(baseCost * 0.1 * 1e8) / 1e8;
    const network = Math.round(baseCost * 0.2 * 1e8) / 1e8;

    let tier: CostEstimate['tier'];
    if (baseCost <= 0) tier = 'free';
    else if (baseCost <= 0.5) tier = 'basic';
    else if (baseCost <= 5) tier = 'standard';
    else tier = 'premium';

    return {
      luxAmount: baseCost,
      breakdown: { compute, storage, network },
      tier,
    };
  }

  // ── Affordability Check ───────────────────────────────────────────────────

  /**
   * Check if a peer has enough Lux to cover the given amount.
   */
  canAfford(peerId: string, amount: number): boolean {
    if (amount <= 0) return true;
    const balance = this.ledger.accounts.getBalance(peerId);
    return balance >= amount;
  }

  // ── Payment Hold ──────────────────────────────────────────────────────────

  /**
   * Escrow Lux for a pending task. Deducts from the peer's balance
   * and creates a hold record. Returns null if the peer cannot afford it.
   */
  holdPayment(peerId: string, taskId: string, amount: number): PaymentHold | null {
    // Expire stale holds first (lazy cleanup)
    this.expireStaleHolds();

    if (amount <= 0) {
      // Free tasks don't need a hold — create a zero-amount record
      const hold: PaymentHold = {
        holdId: this.generateId(),
        peerId,
        taskId,
        amount: 0,
        status: 'held',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.holds.set(hold.holdId, hold);
      this.saveState();
      return hold;
    }

    // Check balance
    if (!this.canAfford(peerId, amount)) {
      return null;
    }

    // Deduct from balance
    const deducted = this.ledger.accounts.subtractBalance(peerId, amount);
    if (!deducted) {
      return null;
    }

    const hold: PaymentHold = {
      holdId: this.generateId(),
      peerId,
      taskId,
      amount,
      status: 'held',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.holds.set(hold.holdId, hold);
    this.recordPaymentEvent(hold.holdId, peerId, taskId, amount, 'payment');
    this.saveState();

    return hold;
  }

  // ── Release Payment ───────────────────────────────────────────────────────

  /**
   * Release escrowed Lux to the executing node (task completed successfully).
   * The hold amount is credited to the recipient's balance.
   */
  releasePayment(holdId: string, recipientPeerId: string): boolean {
    const hold = this.holds.get(holdId);
    if (!hold || hold.status !== 'held') {
      return false;
    }

    if (hold.amount > 0) {
      // Credit the recipient
      this.ledger.accounts.addBalance(recipientPeerId, hold.amount);
    }

    hold.status = 'released';
    hold.updatedAt = Date.now();

    this.recordPaymentEvent(holdId, recipientPeerId, hold.taskId, hold.amount, 'earning');
    this.saveState();

    return true;
  }

  // ── Refund Payment ────────────────────────────────────────────────────────

  /**
   * Refund escrowed Lux to the original payer (task failed or cancelled).
   */
  refundPayment(holdId: string): boolean {
    const hold = this.holds.get(holdId);
    if (!hold || hold.status !== 'held') {
      return false;
    }

    if (hold.amount > 0) {
      // Return to the original payer
      this.ledger.accounts.addBalance(hold.peerId, hold.amount);
    }

    hold.status = 'refunded';
    hold.updatedAt = Date.now();

    this.recordPaymentEvent(holdId, hold.peerId, hold.taskId, hold.amount, 'refund');
    this.saveState();

    return true;
  }

  // ── Free Tier Check ───────────────────────────────────────────────────────

  /**
   * Check if a request falls into the free tier.
   * Simple queries (search, status, balance checks) are always free.
   * Tasks that require compute cost Lux.
   */
  isFreeTier(category: string, complexity: string): boolean {
    if (FREE_CATEGORIES.has(category)) return true;
    if (complexity === 'trivial') return true;
    return false;
  }

  // ── Payment History ───────────────────────────────────────────────────────

  /**
   * Get payment history, optionally filtered by peer ID.
   */
  getPaymentHistory(peerId?: string): PaymentRecord[] {
    // Expire stale holds first (lazy cleanup)
    this.expireStaleHolds();

    if (!peerId) return [...this.history];
    return this.history.filter(r => r.peerId === peerId);
  }

  /**
   * Get all active (held) payment holds.
   */
  getActiveHolds(): PaymentHold[] {
    return Array.from(this.holds.values()).filter(h => h.status === 'held');
  }

  /**
   * Get a specific hold by ID.
   */
  getHold(holdId: string): PaymentHold | undefined {
    return this.holds.get(holdId);
  }

  /**
   * Get a hold for a specific task.
   */
  getHoldForTask(taskId: string): PaymentHold | undefined {
    for (const hold of this.holds.values()) {
      if (hold.taskId === taskId && hold.status === 'held') {
        return hold;
      }
    }
    return undefined;
  }

  /**
   * Get summary statistics.
   */
  getStats(): {
    totalHolds: number;
    activeHolds: number;
    totalLuxHeld: number;
    totalLuxReleased: number;
    totalLuxRefunded: number;
  } {
    let active = 0;
    let held = 0;
    let released = 0;
    let refunded = 0;

    for (const hold of this.holds.values()) {
      switch (hold.status) {
        case 'held':
          active++;
          held += hold.amount;
          break;
        case 'released':
          released += hold.amount;
          break;
        case 'refunded':
          refunded += hold.amount;
          break;
      }
    }

    return {
      totalHolds: this.holds.size,
      activeHolds: active,
      totalLuxHeld: held,
      totalLuxReleased: released,
      totalLuxRefunded: refunded,
    };
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Clean up old completed holds (older than 7 days) to prevent unbounded growth.
   */
  cleanup(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [id, hold] of this.holds) {
      if (hold.status !== 'held' && hold.updatedAt < cutoff) {
        this.holds.delete(id);
      }
    }

    // Trim history to last 1000 records
    if (this.history.length > 1000) {
      this.history = this.history.slice(-1000);
    }

    this.saveState();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private recordPaymentEvent(
    holdId: string,
    peerId: string,
    taskId: string,
    amount: number,
    type: PaymentRecord['type'],
  ): void {
    this.history.push({
      holdId,
      peerId,
      taskId,
      amount,
      type,
      timestamp: Date.now(),
    });
  }

  private generateId(): string {
    return `pay-${randomBytes(8).toString('hex')}`;
  }

  private saveState(): void {
    try {
      const dir = this.holdsFilePath.replace(/[/\\][^/\\]+$/, '');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const holdsData = Array.from(this.holds.values());
      writeFileSync(this.holdsFilePath, JSON.stringify(holdsData, null, 2));

      writeFileSync(this.historyFilePath, JSON.stringify(this.history.slice(-500), null, 2));
    } catch (err: any) {
      console.error(`[payment-gate] Failed to save state: ${err.message}`);
    }
  }

  private loadState(): void {
    try {
      if (existsSync(this.holdsFilePath)) {
        const raw = readFileSync(this.holdsFilePath, 'utf-8');
        const parsed: PaymentHold[] = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const h of parsed) {
            this.holds.set(h.holdId, h);
          }
        }
      }
    } catch (err: any) {
      console.error(`[payment-gate] Failed to load holds: ${err.message}`);
    }

    try {
      if (existsSync(this.historyFilePath)) {
        const raw = readFileSync(this.historyFilePath, 'utf-8');
        const parsed: PaymentRecord[] = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.history = parsed;
        }
      }
    } catch (err: any) {
      console.error(`[payment-gate] Failed to load history: ${err.message}`);
    }
  }
}
