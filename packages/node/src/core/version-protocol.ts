/**
 * Version Protocol — multi-node version coordination.
 *
 * Phase 16.6: Manages protocol versioning across distributed Pando nodes.
 * Provides version compatibility checks, task eligibility based on node
 * capabilities, and upgrade detection for rolling deployments.
 *
 * Methods:
 *   1. getVersionInfo()       — return full version info for this node
 *   2. isCompatible()         — check if a remote node version is compatible
 *   3. canClaimTask()         — check if this node meets a task's version requirements
 *   4. getStatusExtension()   — return version metadata for node status messages
 *   5. checkUpgradeNeeded()   — determine if a newer version is available
 */

import type {
  ProtocolVersion,
  VersionedCapability,
  VersionInfo,
  NodeVersion,
  TaskVersionRequirement,
} from '@pando/shared';

// Current protocol and node versions — bump these on release
const CURRENT_NODE_VERSION: NodeVersion = {
  major: 0,
  minor: 1,
  patch: 0,
};

const CURRENT_PROTOCOL_VERSION: ProtocolVersion = {
  major: 1,
  minor: 0,
  patch: 0,
};

/** Minimum protocol version this node can interoperate with. */
const MIN_COMPATIBLE_VERSION: ProtocolVersion = {
  major: 1,
  minor: 0,
  patch: 0,
};

/** Default capabilities advertised by every node. */
const DEFAULT_CAPABILITIES: VersionedCapability[] = [
  { name: 'messaging', version: { major: 1, minor: 0, patch: 0 }, enabled: true },
  { name: 'ledger-sync', version: { major: 1, minor: 0, patch: 0 }, enabled: true },
  { name: 'governance', version: { major: 1, minor: 0, patch: 0 }, enabled: true },
  { name: 'task-sync', version: { major: 1, minor: 0, patch: 0 }, enabled: true },
  { name: 'code-pipeline', version: { major: 1, minor: 0, patch: 0 }, enabled: true },
];

/** Compare two semantic versions. Returns -1, 0, or 1. */
function compareVersions(a: ProtocolVersion, b: ProtocolVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** Format a version as a semver string. */
function formatVersion(v: ProtocolVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export class VersionProtocol {
  private nodeVersion: NodeVersion;
  private protocolVersion: ProtocolVersion;
  private capabilities: VersionedCapability[];
  private minCompatibleVersion: ProtocolVersion;
  private buildTimestamp: number;

  constructor(options?: {
    nodeVersion?: NodeVersion;
    protocolVersion?: ProtocolVersion;
    capabilities?: VersionedCapability[];
    minCompatibleVersion?: ProtocolVersion;
    buildTimestamp?: number;
  }) {
    this.nodeVersion = options?.nodeVersion ?? { ...CURRENT_NODE_VERSION };
    this.protocolVersion = options?.protocolVersion ?? { ...CURRENT_PROTOCOL_VERSION };
    this.capabilities = options?.capabilities ?? DEFAULT_CAPABILITIES.map((c) => ({ ...c, version: { ...c.version } }));
    this.minCompatibleVersion = options?.minCompatibleVersion ?? { ...MIN_COMPATIBLE_VERSION };
    this.buildTimestamp = options?.buildTimestamp ?? Date.now();
  }

  /**
   * Return full version information for this node.
   */
  getVersionInfo(): VersionInfo {
    return {
      nodeVersion: { ...this.nodeVersion },
      protocolVersion: { ...this.protocolVersion },
      capabilities: this.capabilities.map((c) => ({ ...c, version: { ...c.version } })),
      minCompatibleVersion: { ...this.minCompatibleVersion },
      buildTimestamp: this.buildTimestamp,
    };
  }

  /**
   * Check whether a remote node's protocol version is compatible with ours.
   *
   * Compatibility rules:
   *   - Major version must match (breaking changes across majors).
   *   - Remote version must be >= our minimum compatible version.
   *   - Our version must be >= the remote's minimum compatible version (if provided).
   */
  isCompatible(
    remoteProtocolVersion: ProtocolVersion,
    remoteMinCompatible?: ProtocolVersion,
  ): boolean {
    // Major version mismatch is always incompatible
    if (remoteProtocolVersion.major !== this.protocolVersion.major) {
      return false;
    }

    // Remote must be at least our minimum compatible version
    if (compareVersions(remoteProtocolVersion, this.minCompatibleVersion) < 0) {
      return false;
    }

    // If the remote declares a minimum, we must meet it
    if (remoteMinCompatible && compareVersions(this.protocolVersion, remoteMinCompatible) < 0) {
      return false;
    }

    return true;
  }

  /**
   * Check whether this node can claim a task based on its version requirements.
   *
   * A node can claim a task when:
   *   - Its node version meets the task's minimum version.
   *   - All required features are present as enabled capabilities.
   */
  canClaimTask(requirement: TaskVersionRequirement): boolean {
    const minVersion = requirement.minimumVersion;

    // Check node version meets the minimum
    const nodeAsProtocol: ProtocolVersion = {
      major: this.nodeVersion.major,
      minor: this.nodeVersion.minor,
      patch: this.nodeVersion.patch,
    };
    const minAsProtocol: ProtocolVersion = {
      major: minVersion.major,
      minor: minVersion.minor,
      patch: minVersion.patch,
    };

    if (compareVersions(nodeAsProtocol, minAsProtocol) < 0) {
      return false;
    }

    // Check all required features are available and enabled
    for (const feature of requirement.requiredFeatures) {
      const cap = this.capabilities.find((c) => c.name === feature);
      if (!cap || !cap.enabled) {
        return false;
      }
    }

    return true;
  }

  /**
   * Return version metadata suitable for inclusion in node status messages.
   * This is a lightweight summary sent over the wire during peer announcements.
   */
  getStatusExtension(): Record<string, unknown> {
    return {
      nodeVersion: formatVersion(this.nodeVersion),
      protocolVersion: formatVersion(this.protocolVersion),
      minCompatibleVersion: formatVersion(this.minCompatibleVersion),
      capabilities: this.capabilities
        .filter((c) => c.enabled)
        .map((c) => c.name),
      buildTimestamp: this.buildTimestamp,
    };
  }

  /**
   * Determine whether an upgrade is needed by comparing our protocol version
   * against a known latest version (e.g. received from a peer or registry).
   *
   * Returns an object indicating whether an upgrade is needed and the details.
   */
  checkUpgradeNeeded(latestVersion: ProtocolVersion): {
    upgradeNeeded: boolean;
    currentVersion: string;
    latestVersion: string;
    severity: 'none' | 'patch' | 'minor' | 'major';
  } {
    const cmp = compareVersions(this.protocolVersion, latestVersion);

    if (cmp >= 0) {
      return {
        upgradeNeeded: false,
        currentVersion: formatVersion(this.protocolVersion),
        latestVersion: formatVersion(latestVersion),
        severity: 'none',
      };
    }

    let severity: 'patch' | 'minor' | 'major';
    if (latestVersion.major > this.protocolVersion.major) {
      severity = 'major';
    } else if (latestVersion.minor > this.protocolVersion.minor) {
      severity = 'minor';
    } else {
      severity = 'patch';
    }

    return {
      upgradeNeeded: true,
      currentVersion: formatVersion(this.protocolVersion),
      latestVersion: formatVersion(latestVersion),
      severity,
    };
  }
}
