// === Node Identity ===

export interface NodeIdentity {
  peerId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  createdAt: number;
}

export interface SerializedIdentity {
  peerId: string;
  publicKey: string;           // base64
  privateKey: string;          // base64
  createdAt: number;
}

export interface EncryptedSerializedIdentity {
  encrypted: true;
  peerId: string;
  publicKey: string;           // base64
  salt: string;                // hex (PBKDF2 salt)
  iv: string;                  // hex (AES-GCM IV)
  encryptedPrivateKey: string; // hex (ciphertext + auth tag)
  createdAt: number;
}

export interface IdentityInfo {
  peerId: string;
  encrypted: boolean;
  filePath: string;
}

// === Agent Identity ===

/**
 * Agents are FIRST-CLASS CITIZENS — same capabilities as humans.
 * Own username, own Lux wallet, can earn/spend/authenticate.
 * Trust chain: agent -> parentIdentity (human) -> node
 */
export interface AgentProfile {
  id: string;
  name: string;
  role: string;
  capabilities: string[];
  scope: AgentScope;
  tools: string[];
  model?: string;
  maxSteps?: number;
  budgetLimit?: number;
  status: AgentStatus;
  ownerNodeKey: string;
  parentIdentity: string;
  username?: string;
  walletPeerId?: string;
  canEarn: boolean;
  canSpend: boolean;
  canAuthenticate: boolean;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface AgentScope {
  readPaths?: string[];
  writePaths?: string[];
  excludePaths?: string[];
  services?: string[];
  network?: boolean;
}

export type AgentStatus = 'pending' | 'active' | 'idle' | 'done' | 'failed' | 'terminated';

/**
 * Minimal interface for @pando/code structural typing.
 * AgentProfile is a superset — pass directly, no mapping needed.
 */
export interface EngineAgentConfig {
  id: string;
  role: string;
  tools: string[];
  scope?: { readPaths?: string[]; writePaths?: string[]; excludePaths?: string[] };
  model?: string;
  maxSteps?: number;
  budgetLimit?: number;
}

// === Signed Actions ===

export interface SignedAction {
  agentId: string;
  action: string;
  payload: unknown;
  timestamp: string;
  nodePublicKey: string;
  signature: string;
}

// === Auth ===

export interface JwtPayload {
  sub: string;
  iss: string;
  iat: number;
  exp: number;
  typ: 'user';
}
