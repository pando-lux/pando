/**
 * LocalCapabilityStore — Phase 96: Three-Tier Capability Architecture
 *
 * Separates "what this node has" (local, private) from "what it shares" (broadcast).
 *
 * Detection ≠ sharing. Detected capabilities are always available for this node's own
 * tasks regardless of sharing preferences. Shared capabilities are what peers see and
 * can request from this node.
 *
 * Tiers:
 *   Tier 0 (Local Private)    — capabilities[], never broadcast
 *   Tier 1 (Network Shared)   — sharedCapabilities[], broadcast via GossipSub
 *   Tier 2 (Group Scoped)     — future, not built yet
 *
 * Stored at: ~/.pando/local-capabilities.json
 * Never synced via P2P. Never in any GossipSub message.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface LocalCapabilityData {
  detectedAt: number;
  capabilities: string[];        // All detected (full list, for own tasks)
  sharedCapabilities: string[];  // Explicitly opted in (empty by default)
  shareCompute: boolean;         // Willing to accept network compute task requests
}

export class LocalCapabilityStore {
  private filePath: string;
  private data: LocalCapabilityData;

  constructor(dataDir?: string) {
    const dir = dataDir || join(homedir(), '.pando');
    this.filePath = join(dir, 'local-capabilities.json');
    this.data = this.load();
  }

  private load(): LocalCapabilityData {
    try {
      if (existsSync(this.filePath)) {
        return JSON.parse(readFileSync(this.filePath, 'utf-8'));
      }
    } catch { /* corrupted — start fresh */ }
    return { detectedAt: 0, capabilities: [], sharedCapabilities: [], shareCompute: false };
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  /**
   * Write the full detected capability list.
   * Called at startup by capability-detector after running all checks.
   * Does NOT touch sharedCapabilities — user opt-ins persist across restarts.
   * Removes any shared capabilities that are no longer detected (e.g. Claude uninstalled).
   */
  setDetected(capabilities: string[]): void {
    this.data.capabilities = capabilities;
    this.data.detectedAt = Date.now();
    // Prune shared caps that are no longer detected
    this.data.sharedCapabilities = this.data.sharedCapabilities.filter(c => capabilities.includes(c));
    this.data.shareCompute = this.data.sharedCapabilities.length > 0;
    this.save();
  }

  /** All capabilities this node has locally (for own task routing — never filtered) */
  getCapabilities(): string[] {
    return this.data.capabilities;
  }

  /** Whether this node has a specific capability locally (own task use) */
  has(capability: string): boolean {
    return this.data.capabilities.includes(capability);
  }

  /** Capabilities explicitly shared with the network (broadcast list) */
  getShared(): string[] {
    return this.data.sharedCapabilities;
  }

  /** Whether this node is sharing a specific capability with the network */
  isSharing(capability: string): boolean {
    return this.data.sharedCapabilities.includes(capability);
  }

  /** Whether this node is willing to accept compute task requests from peers */
  isShareCompute(): boolean {
    return this.data.shareCompute;
  }

  /**
   * Opt in to sharing a capability (called by /contribute claude-code in Phase 97).
   * No-op if capability is not locally detected (cannot share what you don't have).
   * Returns false if capability not detected.
   */
  setShared(capability: string): boolean {
    if (!this.data.capabilities.includes(capability)) return false;
    if (!this.data.sharedCapabilities.includes(capability)) {
      this.data.sharedCapabilities.push(capability);
    }
    this.data.shareCompute = true;
    this.save();
    return true;
  }

  /**
   * Opt out of sharing a capability (called by /revoke claude-code in Phase 97).
   */
  unsetShared(capability: string): void {
    this.data.sharedCapabilities = this.data.sharedCapabilities.filter(c => c !== capability);
    this.data.shareCompute = this.data.sharedCapabilities.length > 0;
    this.save();
  }

  /** Full data snapshot (for GET /v1/capabilities API response) */
  getData(): LocalCapabilityData {
    return { ...this.data };
  }
}
