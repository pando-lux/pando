/**
 * File Ownership Registry — prevents concurrent edits by multiple agents.
 *
 * Local-only registry (no GossipSub sync). Each node tracks which files
 * are claimed by which agent. Claims auto-expire after a configurable TTL.
 */

import type { FileClaim } from '@pando/shared';

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class FileRegistry {
  private claims = new Map<string, FileClaim>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Claim a file for editing. Returns true if the claim succeeded,
   * false if the file is already claimed by another agent.
   */
  claimFile(filePath: string, peerId: string): boolean {
    this.pruneExpired();
    const normalized = this.normalize(filePath);
    const existing = this.claims.get(normalized);

    if (existing && existing.claimedBy !== peerId) {
      // Claimed by another agent and not expired
      return false;
    }

    // Claim it (or refresh own claim)
    this.claims.set(normalized, {
      filePath: normalized,
      claimedBy: peerId,
      claimedAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    });
    return true;
  }

  /**
   * Release a file claim. Only the owner can release.
   * Returns true if the claim was released, false if not found or not owned.
   */
  releaseFile(filePath: string, peerId: string): boolean {
    const normalized = this.normalize(filePath);
    const existing = this.claims.get(normalized);
    if (!existing) return false;
    if (existing.claimedBy !== peerId) return false;
    this.claims.delete(normalized);
    return true;
  }

  /**
   * Check if a file is claimed by another agent (not by the given peerId).
   * Returns the claim if locked by someone else, or null if available.
   */
  checkClaim(filePath: string, peerId: string): FileClaim | null {
    this.pruneExpired();
    const normalized = this.normalize(filePath);
    const existing = this.claims.get(normalized);
    if (!existing) return null;
    if (existing.claimedBy === peerId) return null; // own claim doesn't block
    return existing;
  }

  /**
   * Clear all claims. Returns the number of claims that were removed.
   * Used on startup to ensure no stale locks persist after a restart.
   */
  clearAll(): number {
    const count = this.claims.size;
    this.claims.clear();
    return count;
  }

  /**
   * List all active (non-expired) claims.
   */
  listClaims(): FileClaim[] {
    this.pruneExpired();
    return Array.from(this.claims.values());
  }

  /**
   * Remove all expired claims.
   */
  private pruneExpired(): void {
    const now = Date.now();
    for (const [path, claim] of this.claims) {
      if (claim.expiresAt <= now) {
        this.claims.delete(path);
      }
    }
  }

  /**
   * Normalize file path for consistent lookups.
   * Forward slashes, lowercase, trim whitespace.
   */
  private normalize(filePath: string): string {
    return filePath.replace(/\\/g, '/').trim();
  }
}
