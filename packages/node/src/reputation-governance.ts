/**
 * Reputation-Weighted Governance — Phase 12.4
 *
 * Enhances governance voting with reputation weighting.
 * Vote weight is based on reputation score, uptime, and resource contribution.
 * Prevents Sybil attacks by weighting quality, not quantity.
 *
 * Integration points:
 *   - ReputationManager (from reputation.ts) for score data
 *   - GovernanceSync (from governance.ts) for proposals and votes
 *   - PandoNode uptime for uptime factor
 */

import type { ReputationManager, ReputationRecord } from './reputation.js';
import type { GovernanceVote } from '@pando/shared';
import type { QuorumResult, WeightedVoteResult } from '@pando/shared';

// ── Constants ────────────────────────────────────────────────

/** Minimum reputation score to create proposals. */
const MIN_REPUTATION_TO_PROPOSE = 0.3;

/** Minimum reputation score to vote. */
const MIN_REPUTATION_TO_VOTE = 0.1;

/** Minimum uptime (ms) to create proposals — 24 hours. */
const MIN_UPTIME_TO_PROPOSE_MS = 24 * 60 * 60_000;

/** Maximum vote weight any single peer can have. */
const MAX_VOTE_WEIGHT = 10.0;

/** Minimum vote weight (even low-reputation peers get some say). */
const MIN_VOTE_WEIGHT = 0.1;

/** Default weighted quorum threshold. */
const DEFAULT_QUORUM_WEIGHT = 3.0;

// ── ReputationWeightedGovernance Class ───────────────────────

export class ReputationWeightedGovernance {
  private reputationManager: ReputationManager;
  private getUptime: () => number; // returns uptime in milliseconds

  constructor(
    reputationManager: ReputationManager,
    getUptime: () => number,
  ) {
    this.reputationManager = reputationManager;
    this.getUptime = getUptime;
  }

  // ── Vote Weight Calculation ────────────────────────────────

  /**
   * Calculate the weighted vote value for a peer.
   *
   * Weight = reputation_score * uptime_factor * resource_factor
   *
   * Clamped between MIN_VOTE_WEIGHT and MAX_VOTE_WEIGHT.
   * NOT weighted by node count (prevents Sybil).
   */
  calculateVoteWeight(peerId: string): number {
    const record = this.reputationManager.getReputation(peerId);
    if (!record) return MIN_VOTE_WEIGHT;

    // Normalize reputation score to 0-1 range (typical scores 0-100)
    const normalizedScore = Math.max(0, Math.min(1, record.reputationScore / 100));

    // Uptime factor: ramp up over first 24 hours, max at 48+ hours
    const uptimeMs = this.getUptime();
    const uptimeFactor = Math.min(1, uptimeMs / (48 * 60 * 60_000));

    // Resource contribution factor: based on tasks completed
    const resourceFactor = Math.min(1, (record.tasksCompleted || 0) / 10);

    // Combine factors
    let weight = 1.0;
    weight *= (0.3 + normalizedScore * 0.7);    // Base 0.3, scale with reputation
    weight *= (0.5 + uptimeFactor * 0.5);        // Base 0.5, scale with uptime
    weight *= (0.5 + resourceFactor * 0.5);      // Base 0.5, scale with contributions

    // Scale to max vote weight
    weight *= MAX_VOTE_WEIGHT;

    // Clamp
    return Math.max(MIN_VOTE_WEIGHT, Math.min(MAX_VOTE_WEIGHT, weight));
  }

  // ── Permission Checks ──────────────────────────────────────

  /**
   * Check if a peer can create proposals.
   * Must have reputation > MIN_REPUTATION_TO_PROPOSE and uptime > 24 hours.
   */
  canPropose(peerId: string): boolean {
    const record = this.reputationManager.getReputation(peerId);
    if (!record) return false;

    // Check reputation threshold (normalized)
    const normalizedScore = record.reputationScore / 100;
    if (normalizedScore < MIN_REPUTATION_TO_PROPOSE) return false;

    // Check uptime threshold
    const uptimeMs = this.getUptime();
    if (uptimeMs < MIN_UPTIME_TO_PROPOSE_MS) return false;

    return true;
  }

  /**
   * Check if a peer can vote.
   * Must have reputation > MIN_REPUTATION_TO_VOTE.
   */
  canVote(peerId: string): boolean {
    const record = this.reputationManager.getReputation(peerId);
    if (!record) return false;

    const normalizedScore = record.reputationScore / 100;
    return normalizedScore >= MIN_REPUTATION_TO_VOTE;
  }

  // ── Weighted Quorum ────────────────────────────────────────

  /**
   * Check if weighted quorum has been reached for a proposal.
   * Uses sum of vote weights, not count of votes.
   */
  checkWeightedQuorum(
    votes: GovernanceVote[],
    peerCount: number,
  ): QuorumResult {
    let approveWeight = 0;
    let rejectWeight = 0;
    let abstainWeight = 0;

    for (const vote of votes) {
      const weight = this.calculateVoteWeight(vote.voter);

      switch (vote.choice) {
        case 'approve':
          approveWeight += weight;
          break;
        case 'reject':
          rejectWeight += weight;
          break;
        case 'abstain':
          abstainWeight += weight;
          break;
      }
    }

    const totalWeight = approveWeight + rejectWeight + abstainWeight;

    // Dynamic quorum threshold based on network size
    let quorumThreshold = DEFAULT_QUORUM_WEIGHT;
    if (peerCount <= 1) {
      quorumThreshold = 0.1; // Solo mode
    } else if (peerCount <= 5) {
      quorumThreshold = 2.0;
    } else if (peerCount <= 20) {
      quorumThreshold = 3.0;
    } else {
      quorumThreshold = Math.min(10, peerCount * 0.3);
    }

    return {
      reached: totalWeight >= quorumThreshold,
      totalWeight: Math.round(totalWeight * 100) / 100,
      approveWeight: Math.round(approveWeight * 100) / 100,
      rejectWeight: Math.round(rejectWeight * 100) / 100,
      quorumThreshold: Math.round(quorumThreshold * 100) / 100,
    };
  }

  // ── Integration ────────────────────────────────────────────

  /**
   * Apply reputation weighting to a set of votes.
   * Returns the weighted vote result including per-voter weights.
   */
  applyWeighting(
    votes: GovernanceVote[],
    peerCount: number,
  ): WeightedVoteResult {
    const voterWeights: Array<{ peerId: string; weight: number; choice: string }> = [];

    let approveWeight = 0;
    let rejectWeight = 0;
    let abstainWeight = 0;

    for (const vote of votes) {
      const weight = this.calculateVoteWeight(vote.voter);
      voterWeights.push({ peerId: vote.voter, weight, choice: vote.choice });

      switch (vote.choice) {
        case 'approve':
          approveWeight += weight;
          break;
        case 'reject':
          rejectWeight += weight;
          break;
        case 'abstain':
          abstainWeight += weight;
          break;
      }
    }

    const quorum = this.checkWeightedQuorum(votes, peerCount);

    // Determine outcome based on weighted votes
    const decidingWeight = approveWeight + rejectWeight;
    let outcome: 'passed' | 'rejected' | 'pending' = 'pending';
    if (quorum.reached && decidingWeight > 0) {
      outcome = approveWeight > rejectWeight ? 'passed' : 'rejected';
    }

    return {
      outcome,
      approveWeight: Math.round(approveWeight * 100) / 100,
      rejectWeight: Math.round(rejectWeight * 100) / 100,
      abstainWeight: Math.round(abstainWeight * 100) / 100,
      totalWeight: Math.round((approveWeight + rejectWeight + abstainWeight) * 100) / 100,
      quorumReached: quorum.reached,
      quorumThreshold: quorum.quorumThreshold,
      voterWeights,
    };
  }
}
