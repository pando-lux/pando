import type {
  AgentProfile,
  AgentCertificate,
  AgentPermissions,
  AgentScope,
  AgentStatus,
  KeyPair,
} from '../types.js';
import { generate } from '../core/keypair.js';
import { sign, verify } from '../core/signing.js';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { stableStringify } from './signed-action.js';

/** Default certificate lifetime: 90 days */
const DEFAULT_CERT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Configuration for creating a new agent.
 */
export interface CreateAgentConfig {
  name: string;
  role: string;
  tools: string[];
  capabilities?: string[];
  scope?: Partial<AgentScope>;
  model?: string;
  maxSteps?: number;
  budgetLimit?: number;
  username?: string;
  canEarn?: boolean;
  canSpend?: boolean;
  canAuthenticate?: boolean;
  /** Certificate expiry. Defaults to 90 days from now. */
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The human identity needed to sign an agent certificate.
 */
export interface HumanSigner {
  peerId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Result of creating an agent — the profile + the agent's own keypair.
 */
export interface CreateAgentResult {
  profile: AgentProfile;
  identity: KeyPair;
}

/**
 * Create a new agent with its own Ed25519 keypair, certified by a human.
 *
 * The human signs a certificate proving they authorized this agent.
 * The agent can then sign its own actions independently.
 * No node involved in the identity chain.
 *
 * Certificate expires in 90 days by default. No permanent certificates.
 */
export async function createAgent(
  config: CreateAgentConfig,
  human: HumanSigner,
): Promise<CreateAgentResult> {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid agent config: ${errors.join('; ')}`);
  }

  const agentIdentity = await generate();

  const permissions: AgentPermissions = {
    canEarn: config.canEarn ?? false,
    canSpend: config.canSpend ?? false,
    canAuthenticate: config.canAuthenticate ?? false,
    budgetLimit: config.budgetLimit,
  };

  const now = new Date();
  const expiresAt = config.expiresAt ?? new Date(now.getTime() + DEFAULT_CERT_LIFETIME_MS).toISOString();

  const certData: Omit<AgentCertificate, 'parentSignature'> = {
    agentId: agentIdentity.peerId,
    agentPublicKey: uint8ArrayToString(agentIdentity.publicKey, 'base64'),
    parentId: human.peerId,
    permissions,
    issuedAt: now.toISOString(),
    expiresAt,
  };

  const canonical = buildCertCanonical(certData);
  const parentSignature = await sign(new TextEncoder().encode(canonical), human.privateKey);

  const certificate: AgentCertificate = { ...certData, parentSignature };

  const profile: AgentProfile = {
    id: agentIdentity.peerId,
    publicKey: uint8ArrayToString(agentIdentity.publicKey, 'base64'),
    parentId: human.peerId,
    certificate,
    name: config.name,
    role: config.role,
    capabilities: config.capabilities ?? [],
    scope: {
      readPaths: config.scope?.readPaths ?? ['**/*'],
      writePaths: config.scope?.writePaths ?? [],
      excludePaths: config.scope?.excludePaths ?? [],
      services: config.scope?.services,
      network: config.scope?.network,
    },
    tools: config.tools,
    model: config.model,
    maxSteps: config.maxSteps,
    budgetLimit: config.budgetLimit,
    canEarn: permissions.canEarn,
    canSpend: permissions.canSpend,
    canAuthenticate: permissions.canAuthenticate,
    status: 'pending',
    username: config.username,
    createdAt: now.toISOString(),
    metadata: config.metadata,
  };

  return { profile, identity: agentIdentity };
}

/**
 * Renew an agent's certificate with a new expiry.
 * Re-signs with the human's key. The agent keeps its existing keypair.
 * Returns the new certificate (caller updates the profile).
 */
export async function renewCertificate(
  oldCertificate: AgentCertificate,
  human: HumanSigner,
  newExpiresAt?: string,
): Promise<AgentCertificate> {
  if (oldCertificate.parentId !== human.peerId) {
    throw new Error('Only the original parent can renew a certificate');
  }

  const now = new Date();
  const certData: Omit<AgentCertificate, 'parentSignature'> = {
    agentId: oldCertificate.agentId,
    agentPublicKey: oldCertificate.agentPublicKey,
    parentId: human.peerId,
    permissions: oldCertificate.permissions,
    issuedAt: now.toISOString(),
    expiresAt: newExpiresAt ?? new Date(now.getTime() + DEFAULT_CERT_LIFETIME_MS).toISOString(),
  };

  const canonical = buildCertCanonical(certData);
  const parentSignature = await sign(new TextEncoder().encode(canonical), human.privateKey);

  return { ...certData, parentSignature };
}

/**
 * Verify an agent's certificate — proves a human authorized this agent.
 * Checks signature AND expiry. Works completely offline.
 */
export async function verifyCertificate(
  certificate: AgentCertificate,
  humanPublicKey: Uint8Array,
  opts?: { checkExpiry?: boolean },
): Promise<boolean> {
  const { parentSignature, ...certData } = certificate;
  const canonical = buildCertCanonical(certData);
  const sigValid = await verify(new TextEncoder().encode(canonical), parentSignature, humanPublicKey);
  if (!sigValid) return false;

  // Check expiry by default (opt out with checkExpiry: false)
  if (opts?.checkExpiry !== false) {
    const expires = new Date(certificate.expiresAt).getTime();
    if (Date.now() > expires) return false;
  }

  return true;
}

/**
 * Validate a CreateAgentConfig. Returns array of error strings (empty = valid).
 */
function validateConfig(config: CreateAgentConfig): string[] {
  const errors: string[] = [];

  if (!config.name || config.name.trim().length === 0) {
    errors.push('name is required');
  }
  if (!config.role || config.role.trim().length === 0) {
    errors.push('role is required');
  }
  if (!Array.isArray(config.tools)) {
    errors.push('tools must be an array');
  }
  if (config.budgetLimit !== undefined && config.budgetLimit < 0) {
    errors.push('budgetLimit must be non-negative');
  }
  if (config.maxSteps !== undefined && config.maxSteps < 1) {
    errors.push('maxSteps must be at least 1');
  }
  if (config.username !== undefined) {
    const usernameErr = validateUsername(config.username);
    if (usernameErr) errors.push(usernameErr);
  }

  if (config.scope?.readPaths) {
    for (const p of config.scope.readPaths) {
      if (typeof p !== 'string') errors.push(`readPaths must be strings, got ${typeof p}`);
    }
  }
  if (config.scope?.writePaths) {
    for (const p of config.scope.writePaths) {
      if (typeof p !== 'string') errors.push(`writePaths must be strings, got ${typeof p}`);
    }
  }

  return errors;
}

/**
 * Validate an existing AgentProfile. Returns array of error strings (empty = valid).
 */
export function validateProfile(profile: AgentProfile): string[] {
  const errors: string[] = [];

  if (!profile.id) errors.push('id is required');
  if (!profile.publicKey) errors.push('publicKey is required');
  if (!profile.parentId) errors.push('parentId is required');
  if (!profile.certificate) errors.push('certificate is required');
  if (!profile.name) errors.push('name is required');
  if (!profile.role) errors.push('role is required');
  if (!Array.isArray(profile.tools)) errors.push('tools must be an array');
  if (!profile.createdAt) errors.push('createdAt is required');

  const validStatuses: AgentStatus[] = ['pending', 'active', 'idle', 'done', 'failed', 'terminated'];
  if (!validStatuses.includes(profile.status)) {
    errors.push(`status must be one of: ${validStatuses.join(', ')}`);
  }

  return errors;
}

/**
 * Build a deterministic canonical string for certificate signing/verification.
 * Uses stableStringify for the permissions object to ensure deterministic ordering.
 */
function buildCertCanonical(certData: Omit<AgentCertificate, 'parentSignature'>): string {
  return stableStringify({
    agentId: certData.agentId,
    agentPublicKey: certData.agentPublicKey,
    parentId: certData.parentId,
    permissions: certData.permissions,
    issuedAt: certData.issuedAt,
    expiresAt: certData.expiresAt,
  });
}

function validateUsername(username: string): string | null {
  if (username.length < 3) return 'username must be at least 3 characters';
  if (username.length > 30) return 'username must be at most 30 characters';
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return 'username must be alphanumeric, underscore, or hyphen';
  return null;
}
