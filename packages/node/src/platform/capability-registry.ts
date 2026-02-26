/**
 * CapabilityRegistry — Network-wide capability map (Phase A).
 *
 * Stores capability profiles received from peers via GossipSub.
 * Each profile has a 15-minute TTL. Queryable by capability type.
 *
 * Used by the Scheduler to check whether the local node can execute
 * a task before claiming it, and by the API to expose the network's
 * capability map.
 */

import type { CapabilityProfile, ResourceType } from '@pando/shared';
import type { LocalCapabilityStore } from './local-capability-store.js';

interface StoredProfile {
  profile: CapabilityProfile;
  receivedAt: number;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes

export class CapabilityRegistry {
  private profiles: Map<string, StoredProfile> = new Map();
  private localProfile: CapabilityProfile | null = null;
  // Phase 96: LocalCapabilityStore for own-task routing (never filters by sharing prefs)
  private localCapStore: LocalCapabilityStore | null = null;

  /** Set the local node's profile */
  setLocalProfile(profile: CapabilityProfile): void {
    this.localProfile = profile;
    this.profiles.set(profile.peerId, { profile, receivedAt: Date.now() });
  }

  /** Get the local node's profile */
  getLocalProfile(): CapabilityProfile | null {
    return this.localProfile;
  }

  /** Store a profile received from a peer */
  updatePeerProfile(profile: CapabilityProfile): void {
    this.profiles.set(profile.peerId, { profile, receivedAt: Date.now() });
  }

  /** Get a specific peer's profile */
  getPeerProfile(peerId: string): CapabilityProfile | null {
    const stored = this.profiles.get(peerId);
    if (!stored) return null;
    if (Date.now() - stored.receivedAt > TTL_MS) {
      this.profiles.delete(peerId);
      return null;
    }
    return stored.profile;
  }

  /** Find all peers that have ALL the specified capabilities */
  findCapableNodes(requirements: ResourceType[]): CapabilityProfile[] {
    const now = Date.now();
    const results: CapabilityProfile[] = [];

    for (const [peerId, stored] of this.profiles) {
      // Expire stale entries
      if (now - stored.receivedAt > TTL_MS) {
        this.profiles.delete(peerId);
        continue;
      }

      // Check all required capabilities
      const hasAll = requirements.every(req => stored.profile.capabilities[req]);
      if (hasAll) {
        results.push(stored.profile);
      }
    }

    return results;
  }

  /**
   * Phase 96: Attach the LocalCapabilityStore for local task routing.
   * When set, canExecuteLocally() reads from the full detected capabilities
   * instead of the broadcast profile (which only reflects shared capabilities).
   */
  setLocalCapabilityStore(store: LocalCapabilityStore): void {
    this.localCapStore = store;
  }

  /** Check if local node can execute a task with given requirements */
  canExecuteLocally(requirements: ResourceType[]): boolean {
    if (requirements.length === 0) return true; // No requirements = any node
    // Phase 96: Use LocalCapabilityStore when available — reflects full detected capabilities,
    // not just shared ones. Own tasks always work regardless of sharing preferences.
    if (this.localCapStore) {
      return requirements.every(req => this.localResourceTypeAvailable(req));
    }
    // Fallback: use broadcast profile (legacy path — no LocalCapabilityStore set)
    if (!this.localProfile) return false;
    return requirements.every(req => this.localProfile!.capabilities[req]);
  }

  /**
   * Phase 96: Map a ResourceType requirement to whether this node has it locally.
   * Uses LocalCapabilityStore (full detected list, never filtered by sharing).
   */
  private localResourceTypeAvailable(req: ResourceType): boolean {
    if (!this.localCapStore) return false;
    switch (req) {
      case 'compute_cpu': return this.localCapStore.has('claude-code');
      case 'compute_gpu': return this.localCapStore.has('gpu');
      case 'storage':     return true;  // always available
      case 'relay':       return true;
      case 'gateway':     return true;
      case 'validator':   return true;
      case 'index':       return true;
      case 'api_keys':    return false; // checked at runtime via ResourceRegistry
      default:            return false;
    }
  }

  /** Get all known profiles (for API) */
  getAllProfiles(): CapabilityProfile[] {
    const now = Date.now();
    const results: CapabilityProfile[] = [];
    const localPeerId = this.localProfile?.peerId;
    for (const [_peerId, stored] of this.profiles) {
      // Never expire the local node's own profile
      if (_peerId !== localPeerId && now - stored.receivedAt > TTL_MS) {
        this.profiles.delete(_peerId);
        continue;
      }
      results.push(stored.profile);
    }
    return results;
  }

  /** Clean up expired profiles (never expires local node) */
  cleanup(): void {
    const now = Date.now();
    const localPeerId = this.localProfile?.peerId;
    for (const [peerId, stored] of this.profiles) {
      if (peerId !== localPeerId && now - stored.receivedAt > TTL_MS) {
        this.profiles.delete(peerId);
      }
    }
  }
}
