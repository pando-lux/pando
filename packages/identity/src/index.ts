// Types
export type {
  KeyPair,
  NodeIdentity,
  SerializedIdentity,
  EncryptedSerializedIdentity,
  IdentityInfo,
  AgentCertificate,
  AgentPermissions,
  AgentProfile,
  AgentScope,
  AgentStatus,
  EngineAgentConfig,
  SignedAction,
  JwtPayload,
} from './types.js';

// Constants
export {
  DEFAULT_PANDO_DIR,
  PBKDF2_ITERATIONS,
  AGENT_STATUSES,
  JWT_EXPIRY_SECONDS,
  MIN_PASSWORD_LENGTH,
} from './constants.js';

// Core: Keypair
export {
  generate,
  save,
  load,
  loadOrCreate,
  isEncrypted,
  loadRaw,
  encrypt,
  decrypt,
  saveEncrypted,
  saveSession,
  loadSession,
  clearSession,
  list,
  loadFile,
  saveToDir,
  getPrivateKey,
} from './core/keypair.js';

// Core: Signing
export {
  sign,
  verify,
  signPayload,
  verifyPayload,
} from './core/signing.js';

// Core: Encryption
export {
  deriveKey,
  generateSalt,
  generateIv,
  encryptWithPassword,
  decryptWithPassword,
  encrypt as aesEncrypt,
  decrypt as aesDecrypt,
} from './core/encryption.js';

// Core: Hash
export {
  sha256,
  hashTransaction,
} from './core/hash.js';

// Identity: Agent Profile + Certificate
export type { CreateAgentConfig, HumanSigner, CreateAgentResult } from './identity/agent-profile.js';
export {
  createAgent,
  verifyCertificate,
  renewCertificate,
  validateProfile,
} from './identity/agent-profile.js';

// Identity: Node Identity helpers
export {
  createNodeIdentity,
  loadNodeIdentity,
} from './identity/node-identity.js';

// Identity: Signed Actions
export type { ActionInput } from './identity/signed-action.js';
export {
  createSignedAction,
  verifySignedAction,
  verifySignedActionFull,
  stableStringify,
} from './identity/signed-action.js';

// Auth: Signature verification (offline Pando Login)
export {
  verifySignature,
  verifyPayloadSignature,
} from './auth/verifier.js';

// Auth: JWT (Ed25519-signed)
export {
  issueJwt,
  verifyJwt,
  decodeJwtPayload,
  revokeToken,
  isRevoked,
} from './auth/jwt.js';

// Auth: Password hashing (scrypt)
export {
  hashPassword,
  verifyPassword,
  validatePassword,
} from './auth/password.js';
