// === Ed25519 Keypair (used by nodes, humans, and agents) ===

export interface KeyPair {
  peerId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  createdAt: number;
}

/**
 * NodeIdentity = KeyPair used for P2P transport (Noise, GossipSub).
 * Nodes are compute infrastructure. They don't own agents or humans.
 */
export type NodeIdentity = KeyPair;

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
 * Certificate proving a human authorized an agent.
 * Signed by the human's Ed25519 key. Verifiable offline.
 *
 * Trust chain: verify agent action → verify certificate → trust the human.
 * Like a TLS certificate: human = CA, agent = server.
 */
export interface AgentCertificate {
  agentId: string;            // agent's peerId (from its own keypair)
  agentPublicKey: string;     // agent's Ed25519 public key (base64)
  parentId: string;           // human's peerId (the owner)
  permissions: AgentPermissions;
  issuedAt: string;           // ISO 8601
  expiresAt: string;          // ISO 8601 — REQUIRED. No permanent certificates.
  parentSignature: string;    // human's Ed25519 signature over all fields above
}

/**
 * What the human authorized this agent to do.
 * Locked in the certificate — cannot be changed without re-signing.
 */
export interface AgentPermissions {
  canEarn: boolean;
  canSpend: boolean;
  canAuthenticate: boolean;
  budgetLimit?: number;
}

/**
 * Agents are FIRST-CLASS CITIZENS — own keypair, own wallet, own identity.
 *
 * Every agent has its own Ed25519 keypair. The agent's peerId IS its wallet ID.
 * The human signs a certificate authorizing the agent. The agent signs its own actions.
 * Nodes are just compute — they run agents but don't own them.
 *
 * Trust chain: agent action (agent key) → certificate (human key) → human account
 */
export interface AgentProfile {
  id: string;                 // peerId (derived from agent's own Ed25519 keypair)
  publicKey: string;          // agent's Ed25519 public key (base64)
  parentId: string;           // human's peerId (the owner)
  certificate: AgentCertificate;
  name: string;
  role: string;
  capabilities: string[];
  scope: AgentScope;
  tools: string[];
  model?: string;
  maxSteps?: number;
  budgetLimit?: number;
  canEarn: boolean;
  canSpend: boolean;
  canAuthenticate: boolean;
  status: AgentStatus;
  username?: string;
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

export type AgentStatus = 'pending' | 'active' | 'working' | 'idle' | 'done' | 'failed' | 'terminated';

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

/**
 * Proof that an agent performed an action.
 * Signed by the AGENT's own Ed25519 key (not the node's).
 * Includes the agent's certificate so verifiers can check the full trust chain offline.
 */
export interface SignedAction {
  agentId: string;
  action: string;
  payload: unknown;
  timestamp: string;
  agentPublicKey: string;     // agent's Ed25519 public key (base64)
  signature: string;          // agent's Ed25519 signature
  certificate: AgentCertificate; // proves human authorized this agent
}

// === Auth ===

export interface JwtPayload {
  sub: string;                // peerId (human or agent)
  iss: string;                // node peerId (issuing node)
  iat: number;
  exp: number;
  typ: 'human' | 'agent';
  jti?: string;               // unique token ID for revocation
}
