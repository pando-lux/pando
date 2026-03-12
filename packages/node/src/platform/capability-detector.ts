/**
 * Capability Detector — auto-detects node capabilities at startup.
 *
 * Checks for the presence of various tools and hardware:
 *   - claude-code: Claude Code CLI binary (contributed compute resource)
 *   - docker: Docker daemon
 *   - python: Python 3 interpreter
 *   - node: Node.js runtime (always present)
 *   - gpu: NVIDIA GPU (via nvidia-smi)
 *   - playwright: Playwright test framework
 *
 * Part of the Resource Network Phase A capability declaration system.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform, homedir } from 'node:os';
import { NodeCapability } from '@pando/shared';
import type { CapabilityProfile } from '@pando/shared';
import type { LocalCapabilityStore } from './local-capability-store.js';

export interface DetectionResult {
  capabilities: NodeCapability[];
  detectedAt: number;
}

/**
 * Detect all capabilities available on this node.
 * Optionally accepts manual overrides from config.
 */
export function detectCapabilities(manualOverrides?: string[]): DetectionResult {
  const caps: NodeCapability[] = [NodeCapability.NODE]; // Node.js is always available
  const detectedAt = Date.now();

  if (manualOverrides && manualOverrides.length > 0) {
    for (const override of manualOverrides) {
      const cap = override as NodeCapability;
      if (Object.values(NodeCapability).includes(cap) && !caps.includes(cap)) {
        caps.push(cap);
      }
    }
    return { capabilities: caps, detectedAt };
  }

  // Claude Code CLI
  if (detectClaudeCode()) {
    caps.push(NodeCapability.CLAUDE_CODE);
  }

  // PandoTeams engine (@pando-teams/core)
  if (detectPandoTeams()) {
    caps.push(NodeCapability.PANDO_TEAMS);
  }

  // Docker
  if (detectDocker()) {
    caps.push(NodeCapability.DOCKER);
  }

  // Python
  if (detectPython()) {
    caps.push(NodeCapability.PYTHON);
  }

  // GPU (NVIDIA)
  if (detectGpu()) {
    caps.push(NodeCapability.GPU);
  }

  // Playwright
  if (detectPlaywright()) {
    caps.push(NodeCapability.PLAYWRIGHT);
  }

  return { capabilities: caps, detectedAt };
}

export function detectClaudeCode(): boolean {
  try {
    const cmd = platform() === 'win32' ? 'where claude' : 'which claude';
    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
    // Binary exists — check for any known auth method
    return hasClaudeCodeAuth();
  } catch {
    return false;
  }
}

/** Check if Claude Code can actually authenticate (API key, OAuth, or Max/Pro plan) */
export function hasClaudeCodeAuth(): boolean {
  // Check ANTHROPIC_API_KEY env var (server/automated usage)
  if (process.env.ANTHROPIC_API_KEY) return true;
  // Check OAuth credentials from `claude login`
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    if (existsSync(credPath)) {
      const content = readFileSync(credPath, 'utf-8').trim();
      if (content.length > 2) return true; // more than just "{}"
    }
  } catch {
    // ignore
  }
  // Check for Claude Max/Pro plan auth — ~/.claude directory with usage history
  // indicates the user has logged in via browser/keychain at least once
  try {
    const claudeDir = join(homedir(), '.claude');
    const hasHistory = existsSync(join(claudeDir, 'history.jsonl'));
    const hasSettings = existsSync(join(claudeDir, 'settings.json'));
    if (hasHistory && hasSettings) return true;
  } catch {
    // ignore
  }
  return false;
}

function detectPandoTeams(): boolean {
  try {
    const pkgPath = join(process.cwd(), 'node_modules', '@pando-teams', 'core', 'package.json');
    return existsSync(pkgPath);
  } catch {
    return false;
  }
}

function detectDocker(): boolean {
  try {
    const cmd = platform() === 'win32' ? 'where docker' : 'which docker';
    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function detectPython(): boolean {
  try {
    const cmd = platform() === 'win32' ? 'where python' : 'which python3';
    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function detectGpu(): boolean {
  try {
    if (platform() === 'win32') {
      execSync('where nvidia-smi', { encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
    } else {
      execSync('which nvidia-smi', { encoding: 'utf-8', stdio: 'pipe', windowsHide: true });
    }
    // Verify nvidia-smi actually runs (binary exists but GPU may not be available)
    execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function detectPlaywright(): boolean {
  try {
    const pkgPath = join(process.cwd(), 'node_modules', '@playwright', 'test', 'package.json');
    return existsSync(pkgPath);
  } catch {
    return false;
  }
}

// === Phase A: Rich Capability Profile ===

/**
 * Detect a full CapabilityProfile for the local node.
 * This is the Phase A rich profile with ResourceType capabilities,
 * used by the CapabilityRegistry for routing decisions (broadcast to peers).
 *
 * Phase 96: If localCapStore is provided, compute_cpu and the capabilities list
 * reflect only what the user has explicitly SHARED — not everything detected.
 * This ensures claude-code is not advertised to peers unless the user opted in.
 */
export function detectCapabilityProfile(peerId: string, apiPort?: number, linkedUser?: { username: string } | null, localCapStore?: LocalCapabilityStore | null): CapabilityProfile {
  const hasClaudeCodeBinary = detectClaudeCode();
  const hasGpuHardware = detectGpu();
  const hasKeys = hasApiKeys();

  // Phase 96: Use shared capabilities for broadcast, fall back to detection if no store
  const isSharingClaudeCode = localCapStore ? localCapStore.isSharing('claude-code') : hasClaudeCodeBinary;
  const isSharingGpu = localCapStore ? localCapStore.isSharing('gpu') : hasGpuHardware;

  return {
    peerId,
    schemaVersion: 1,
    updatedAt: Date.now(),
    linkedUser: linkedUser || null,
    // Phase 69: credentialAccess = true only if CREDENTIAL_MASTER_KEY is set (EC2 compute nodes)
    credentialAccess: !!process.env.CREDENTIAL_MASTER_KEY,
    // Phase 83: storageBackend type — 'mongodb' if direct, 'none' at startup (becomes 'p2p' after P2PStorageBackend init)
    storageBackend: process.env.PANDO_STORAGE_URL ? 'mongodb' : 'none',
    // Phase 87: Public address for HTTP access (Tier 2 URL construction)
    publicAddress: detectPublicAddress(),
    // Phase 97: shareCompute flag — true only if user has explicitly opted in via /contribute
    shareCompute: localCapStore ? localCapStore.isShareCompute() : false,
    capabilities: {
      relay: true,                       // every node relays
      api_keys: hasKeys,
      compute_cpu: isSharingClaudeCode,  // Phase 96: only true if user opted in
      compute_gpu: isSharingGpu,         // Phase 96: only true if user opted in
      storage: true,                     // assume storage is always available
      gateway: true,                     // API port is open since we're running
      validator: true,                   // lightweight — always available
      index: true,                       // search index — always available
      // KB: Phase 17A — agent_labor true when PANDO_API_KEY is set (start.sh sets it when teams is configured).
      // KB: hasKeys (api_keys) is always false (dynamic, checked at runtime). agent_labor is different — it indicates
      // KB: that this node has a pando-teams instance running and ready to accept commission tasks.
      agent_labor: !!process.env.PANDO_API_KEY,
    },
    details: {
      compute_cpu: {
        claudeCode: isSharingClaudeCode,
        maxConcurrent: 3,
        os: platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'mac' : 'linux',
      },
      httpApi: apiPort ? { host: '0.0.0.0', port: apiPort, https: false } : undefined,
    },
  };
}

/**
 * Phase 87: Detect the node's public IP address for HTTP access.
 * Uses PUBLIC_IP env var (set on EC2/cloud nodes).
 * Returns undefined for private/local nodes (they don't host Tier 2 apps).
 */
function detectPublicAddress(): string | undefined {
  const publicIp = process.env.PUBLIC_IP;
  if (publicIp && publicIp.trim()) {
    return publicIp.trim();
  }
  return undefined;
}

/**
 * API key availability is dynamic (ResourceRegistry, P2P-synced) and cannot be
 * determined at startup time. Always return false here — the actual availability
 * is checked at runtime via ResourceRegistry.findResources('ai_api_key').
 */
function hasApiKeys(): boolean {
  return false;
}
