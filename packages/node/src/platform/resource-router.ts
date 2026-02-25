/**
 * ResourceRouter — Smart task routing + error correction (Phase B).
 *
 * Finds the best node for a task based on capability match, reputation,
 * latency, and current load. Forwards tasks to remote nodes via P2P
 * (RequestReplyManager). Tracks resource failures and auto-disables
 * degraded resources.
 */

import type { CapabilityRegistry } from './capability-registry.js';
import type { RequestReplyManager } from '../core/request-reply.js';
import type { ReputationManager } from '../kernel/reputation.js';
import type {
  ResourceType,
  CapabilityProfile,
  RoutingDecision,
  RoutingResult,
  ForwardResult,
  ReassignResult,
  RoutingStats,
  ResourceRoutingRequirements,
} from '@pando/shared';

// ── Failure tracking ────────────────────────────────────────────────────────

interface FailureRecord {
  consecutiveFailures: number;
  lastFailure: number;
  lastError: string;
  status: 'active' | 'degraded' | 'disabled';
}

const DEGRADE_THRESHOLD = 3;
const DISABLE_THRESHOLD = 5;

// ── ResourceRouter class ────────────────────────────────────────────────────

export class ResourceRouter {
  private registry: CapabilityRegistry;
  private requestReply: RequestReplyManager;
  private reputationManager: ReputationManager | null = null;

  // Failure tracking: peerId -> resourceType -> FailureRecord
  private failures: Map<string, Map<string, FailureRecord>> = new Map();

  // Stats
  private totalRouted = 0;
  private localExecutions = 0;
  private remoteForwards = 0;
  private reassignments = 0;
  private failuresByResource: Record<string, number> = {};

  constructor(
    registry: CapabilityRegistry,
    requestReply: RequestReplyManager,
  ) {
    this.registry = registry;
    this.requestReply = requestReply;
  }

  /** Attach the reputation manager for scoring nodes. */
  setReputationManager(manager: ReputationManager): void {
    this.reputationManager = manager;
  }

  // ── Routing ─────────────────────────────────────────────────────────────

  /**
   * Find the best node for a task based on requirements.
   * Scores nodes by: capability match, reputation, resource health.
   * Returns ranked list of candidate nodes.
   */
  findBestNode(requirements: ResourceRoutingRequirements): RoutingDecision {
    const requiredResources = requirements.requiredResources || [];
    const preferredNodes = requirements.preferredNodes || [];
    const minReputation = requirements.minReputation ?? 0;

    // Get all nodes that have ALL required capabilities
    const candidates = requiredResources.length > 0
      ? this.registry.findCapableNodes(requiredResources as ResourceType[])
      : this.registry.getAllProfiles();

    if (candidates.length === 0) {
      return {
        targetNode: '',
        score: 0,
        reason: 'No capable nodes found',
        alternatives: [],
      };
    }

    // Score each candidate
    const scored = candidates.map(profile => ({
      peerId: profile.peerId,
      score: this.scoreNode(profile, requiredResources, preferredNodes, minReputation),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Filter out nodes below minimum reputation
    const filtered = scored.filter(s => s.score > 0);

    if (filtered.length === 0) {
      return {
        targetNode: '',
        score: 0,
        reason: 'All candidate nodes scored below threshold',
        alternatives: [],
      };
    }

    const best = filtered[0];
    const localProfile = this.registry.getLocalProfile();
    const isLocal = localProfile ? best.peerId === localProfile.peerId : false;

    return {
      targetNode: best.peerId,
      score: best.score,
      reason: isLocal ? 'Local node is best candidate' : `Remote node ${best.peerId.slice(0, 12)} scored highest`,
      alternatives: filtered.slice(1, 6).map(s => ({ peerId: s.peerId, score: s.score })),
    };
  }

  /**
   * Route a task to the best available node.
   * If local node is best, returns immediately for local execution.
   * If remote node is better, forwards via P2P.
   */
  async routeTask(task: any, requirements: ResourceRoutingRequirements): Promise<RoutingResult> {
    this.totalRouted++;

    const decision = this.findBestNode(requirements);

    if (!decision.targetNode) {
      return {
        success: false,
        targetNode: '',
        local: false,
        forwardedViaP2P: false,
        error: decision.reason,
      };
    }

    const localProfile = this.registry.getLocalProfile();
    const isLocal = localProfile ? decision.targetNode === localProfile.peerId : false;

    if (isLocal) {
      this.localExecutions++;
      return {
        success: true,
        targetNode: decision.targetNode,
        local: true,
        forwardedViaP2P: false,
      };
    }

    // Forward to remote node
    const forwardResult = await this.forwardTask(task, decision.targetNode);
    if (forwardResult.success) {
      this.remoteForwards++;
    }

    return {
      success: forwardResult.success,
      targetNode: decision.targetNode,
      local: false,
      forwardedViaP2P: true,
      error: forwardResult.error,
    };
  }

  /**
   * Forward a task to a specific remote node via RequestReply.
   * The target node's scheduler picks it up.
   */
  async forwardTask(task: any, targetPeerId: string): Promise<ForwardResult> {
    try {
      const reply = await this.requestReply.request(targetPeerId, 'task_forward', {
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          requiredResources: task.requiredResources,
          requiredCapabilities: task.requiredCapabilities,
          createdBy: task.createdBy,
          managerId: task.managerId,
        },
      }, 30_000);

      if (reply.success) {
        return {
          success: true,
          remoteTaskId: reply.payload?.taskId || task.id,
        };
      }

      return {
        success: false,
        error: reply.error || 'Remote node rejected task',
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Forward failed: ${err.message}`,
      };
    }
  }

  // ── Error correction ──────────────────────────────────────────────────

  /**
   * Report a resource failure for a node.
   * 3 consecutive failures -> mark as 'degraded'.
   * 5 consecutive failures -> mark as 'disabled'.
   */
  reportResourceFailure(peerId: string, resourceType: string, error: string): void {
    this.failuresByResource[resourceType] = (this.failuresByResource[resourceType] || 0) + 1;

    let nodeFailures = this.failures.get(peerId);
    if (!nodeFailures) {
      nodeFailures = new Map();
      this.failures.set(peerId, nodeFailures);
    }

    let record = nodeFailures.get(resourceType);
    if (!record) {
      record = {
        consecutiveFailures: 0,
        lastFailure: 0,
        lastError: '',
        status: 'active',
      };
      nodeFailures.set(resourceType, record);
    }

    record.consecutiveFailures++;
    record.lastFailure = Date.now();
    record.lastError = error;

    if (record.consecutiveFailures >= DISABLE_THRESHOLD) {
      record.status = 'disabled';
      console.log(`[resource-router] Node ${peerId.slice(0, 12)} resource '${resourceType}' DISABLED (${record.consecutiveFailures} consecutive failures)`);
    } else if (record.consecutiveFailures >= DEGRADE_THRESHOLD) {
      record.status = 'degraded';
      console.log(`[resource-router] Node ${peerId.slice(0, 12)} resource '${resourceType}' DEGRADED (${record.consecutiveFailures} consecutive failures)`);
    }
  }

  /**
   * Report resource recovery for a node (success after degradation).
   * Resets the failure counter and marks the resource as 'active' again.
   */
  reportResourceRecovery(peerId: string, resourceType: string): void {
    const nodeFailures = this.failures.get(peerId);
    if (!nodeFailures) return;

    const record = nodeFailures.get(resourceType);
    if (!record) return;

    const prevStatus = record.status;
    record.consecutiveFailures = 0;
    record.status = 'active';

    if (prevStatus !== 'active') {
      console.log(`[resource-router] Node ${peerId.slice(0, 12)} resource '${resourceType}' recovered: ${prevStatus} -> active`);
    }
  }

  /**
   * Auto-reassign a failed task to the next capable node.
   * Excludes the failed node from consideration.
   */
  async reassignFailedTask(task: any, failedNodeId: string, error: string): Promise<ReassignResult> {
    this.reassignments++;
    const requiredResources = task.requiredResources || [];

    // Find candidates excluding the failed node
    const candidates = requiredResources.length > 0
      ? this.registry.findCapableNodes(requiredResources as ResourceType[])
      : this.registry.getAllProfiles();

    const viable = candidates.filter(c => c.peerId !== failedNodeId);

    if (viable.length === 0) {
      return {
        success: false,
        attempts: 1,
        error: 'No alternative nodes available',
      };
    }

    // Score and pick the best alternative
    const scored = viable.map(profile => ({
      peerId: profile.peerId,
      score: this.scoreNode(profile, requiredResources, [], 0),
    })).sort((a, b) => b.score - a.score);

    // Try up to 3 alternatives
    let attempts = 0;
    for (const candidate of scored.slice(0, 3)) {
      attempts++;
      const localProfile = this.registry.getLocalProfile();
      const isLocal = localProfile ? candidate.peerId === localProfile.peerId : false;

      if (isLocal) {
        return {
          success: true,
          newNode: candidate.peerId,
          attempts,
        };
      }

      const forward = await this.forwardTask(task, candidate.peerId);
      if (forward.success) {
        return {
          success: true,
          newNode: candidate.peerId,
          attempts,
        };
      }
    }

    return {
      success: false,
      attempts,
      error: `Failed to reassign after ${attempts} attempts`,
    };
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  /** Get routing statistics. */
  getRoutingStats(): RoutingStats {
    // Build node health map
    const nodeHealth: Record<string, { active: string[]; degraded: string[]; disabled: string[] }> = {};

    for (const [peerId, nodeFailures] of this.failures) {
      const health = { active: [] as string[], degraded: [] as string[], disabled: [] as string[] };
      for (const [resourceType, record] of nodeFailures) {
        health[record.status].push(resourceType);
      }
      if (health.degraded.length > 0 || health.disabled.length > 0) {
        nodeHealth[peerId] = health;
      }
    }

    return {
      totalRouted: this.totalRouted,
      localExecutions: this.localExecutions,
      remoteForwards: this.remoteForwards,
      reassignments: this.reassignments,
      failuresByResource: { ...this.failuresByResource },
      nodeHealth,
    };
  }

  // ── Internal scoring ──────────────────────────────────────────────────

  /**
   * Score a node for task suitability.
   * Factors: capability match, reputation, resource health, preference.
   */
  private scoreNode(
    profile: CapabilityProfile,
    requiredResources: string[],
    preferredNodes: string[],
    minReputation: number,
  ): number {
    let score = 50; // Base score

    // Capability match bonus (0-20 points)
    if (requiredResources.length > 0) {
      const matchCount = requiredResources.filter(r =>
        profile.capabilities[r as ResourceType]
      ).length;
      score += (matchCount / requiredResources.length) * 20;
    } else {
      score += 20; // No requirements = full match
    }

    // Reputation score (0-30 points)
    if (this.reputationManager) {
      const rep = this.reputationManager.getReputation(profile.peerId);
      if (rep) {
        const repScore = Math.min(rep.reputationScore / 100, 1) * 30;
        if (rep.reputationScore < minReputation) {
          return 0; // Below minimum — exclude entirely
        }
        score += repScore;
      } else {
        score += 15; // Unknown node — neutral reputation
      }
    } else {
      score += 15; // No reputation manager — neutral
    }

    // Resource health penalty
    const nodeFailures = this.failures.get(profile.peerId);
    if (nodeFailures) {
      for (const resourceType of requiredResources) {
        const record = nodeFailures.get(resourceType);
        if (record) {
          if (record.status === 'disabled') return 0; // Exclude entirely
          if (record.status === 'degraded') score -= 20;
        }
      }
    }

    // Preferred node bonus
    if (preferredNodes.includes(profile.peerId)) {
      score += 10;
    }

    // Local node slight preference (avoids P2P latency)
    const localProfile = this.registry.getLocalProfile();
    if (localProfile && profile.peerId === localProfile.peerId) {
      score += 5;
    }

    return Math.max(0, score);
  }
}
