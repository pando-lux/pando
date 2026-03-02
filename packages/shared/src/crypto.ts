import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf, publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv } from 'node:crypto';
import type { NodeIdentity, SerializedIdentity, EncryptedSerializedIdentity, PandoMessage, GovernanceProposal } from './types.js';

const DEFAULT_PANDO_DIR = join(homedir(), '.pando');

export async function generateIdentity(): Promise<NodeIdentity> {
  const privateKey = await generateKeyPair('Ed25519');
  const peerId = peerIdFromPrivateKey(privateKey);
  const serializedPrivate = privateKeyToProtobuf(privateKey);

  return {
    peerId: peerId.toString(),
    publicKey: privateKey.publicKey.raw,
    privateKey: serializedPrivate,
    createdAt: Date.now(),
  };
}

export async function saveIdentity(identity: NodeIdentity, dataDir?: string): Promise<void> {
  const dir = dataDir || DEFAULT_PANDO_DIR;
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const serialized: SerializedIdentity = {
    peerId: identity.peerId,
    publicKey: uint8ArrayToString(identity.publicKey, 'base64'),
    privateKey: uint8ArrayToString(identity.privateKey, 'base64'),
    createdAt: identity.createdAt,
  };

  await writeFile(join(dir, 'identity.json'), JSON.stringify(serialized, null, 2), 'utf-8');
}

export async function loadIdentity(dataDir?: string): Promise<NodeIdentity | null> {
  const identityFile = join(dataDir || DEFAULT_PANDO_DIR, 'identity.json');
  if (!existsSync(identityFile)) {
    return null;
  }

  const raw = await readFile(identityFile, 'utf-8');
  const parsed = JSON.parse(raw);

  // If encrypted, cannot load without password — return null
  if (isEncryptedIdentity(parsed)) {
    return null;
  }

  const serialized: SerializedIdentity = parsed;
  return {
    peerId: serialized.peerId,
    publicKey: uint8ArrayFromString(serialized.publicKey, 'base64'),
    privateKey: uint8ArrayFromString(serialized.privateKey, 'base64'),
    createdAt: serialized.createdAt,
  };
}

export async function loadOrCreateIdentity(dataDir?: string): Promise<NodeIdentity> {
  // Check if an encrypted identity exists — don't overwrite it
  const identityFile = join(dataDir || DEFAULT_PANDO_DIR, 'identity.json');
  if (existsSync(identityFile)) {
    const raw = await readFile(identityFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (isEncryptedIdentity(parsed)) {
      throw new Error(
        'Identity is password-protected. Use the interactive TUI (tui.js) to unlock it, ' +
        'or use --data-dir to specify a different data directory.'
      );
    }
  }

  const existing = await loadIdentity(dataDir);
  if (existing) {
    return existing;
  }

  const identity = await generateIdentity();
  await saveIdentity(identity, dataDir);
  return identity;
}

export function getPrivateKeyFromIdentity(identity: NodeIdentity): import('@libp2p/interface').PrivateKey {
  return privateKeyFromProtobuf(identity.privateKey);
}

export function getPandoDir(dataDir?: string): string {
  return dataDir || DEFAULT_PANDO_DIR;
}

/**
 * Sign a PandoMessage with Ed25519 private key.
 * Returns base64-encoded signature.
 */
export async function signMessage(message: PandoMessage, privateKeyBytes: Uint8Array): Promise<string> {
  const pk = privateKeyFromProtobuf(privateKeyBytes);
  // Create canonical payload (exclude signature field)
  const { signature: _, ...payload } = message as any;
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await pk.sign(data);
  return uint8ArrayToString(sig, 'base64');
}

/**
 * Verify a PandoMessage signature with Ed25519 public key.
 * publicKeyRaw should be the 32-byte raw public key.
 */
export async function verifySignature(
  message: PandoMessage,
  signature: string,
  publicKeyRaw: Uint8Array
): Promise<boolean> {
  try {
    // Build the Ed25519 protobuf-wrapped public key (type 1 = Ed25519)
    // Protobuf: varint(8) = field 1 wire type 0, varint(1) = Ed25519 type
    //           varint(18) = field 2 wire type 2, varint(32) = length, then 32 bytes
    const proto = new Uint8Array(2 + 2 + publicKeyRaw.length);
    proto[0] = 0x08; // field 1, varint
    proto[1] = 0x01; // Ed25519 = 1
    proto[2] = 0x12; // field 2, length-delimited
    proto[3] = publicKeyRaw.length; // 32
    proto.set(publicKeyRaw, 4);

    const pk = publicKeyFromProtobuf(proto);
    const { signature: _, ...payload } = message as any;
    const data = new TextEncoder().encode(JSON.stringify(payload));
    const sig = uint8ArrayFromString(signature, 'base64');
    return await pk.verify(data, sig);
  } catch (err) {
    return false;
  }
}

// ── Identity encryption (PBKDF2 + AES-256-GCM) ──

/**
 * Check if a parsed identity.json is encrypted.
 */
export function isEncryptedIdentity(
  data: SerializedIdentity | EncryptedSerializedIdentity
): data is EncryptedSerializedIdentity {
  return (data as any).encrypted === true;
}

/**
 * Load identity.json as raw parsed JSON (without decrypting).
 * Returns null if file doesn't exist.
 */
export async function loadRawIdentityFile(
  dataDir?: string
): Promise<SerializedIdentity | EncryptedSerializedIdentity | null> {
  const identityFile = join(dataDir || DEFAULT_PANDO_DIR, 'identity.json');
  if (!existsSync(identityFile)) {
    return null;
  }
  const raw = await readFile(identityFile, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Encrypt a NodeIdentity's private key with a password.
 * Uses PBKDF2 (100k iterations, SHA-256) to derive a 256-bit AES key,
 * then AES-256-GCM to encrypt the private key.
 */
export function encryptIdentity(
  identity: NodeIdentity,
  password: string
): EncryptedSerializedIdentity {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, 100_000, 32, 'sha256');

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const privateKeyBase64 = uint8ArrayToString(identity.privateKey, 'base64');
  const encrypted = Buffer.concat([
    cipher.update(privateKeyBase64, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: true,
    peerId: identity.peerId,
    publicKey: uint8ArrayToString(identity.publicKey, 'base64'),
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    encryptedPrivateKey: Buffer.concat([encrypted, authTag]).toString('hex'),
    createdAt: identity.createdAt,
  };
}

/**
 * Decrypt an encrypted identity using a password.
 * Throws "Wrong password" if the password is incorrect (GCM auth tag fails).
 */
export function decryptIdentity(
  data: EncryptedSerializedIdentity,
  password: string
): NodeIdentity {
  const salt = Buffer.from(data.salt, 'hex');
  const iv = Buffer.from(data.iv, 'hex');
  const encryptedBuffer = Buffer.from(data.encryptedPrivateKey, 'hex');

  const authTag = encryptedBuffer.slice(-16);
  const ciphertext = encryptedBuffer.slice(0, -16);

  const key = pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  let decrypted: string;
  try {
    decrypted = decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
  } catch {
    throw new Error('Wrong password');
  }

  return {
    peerId: data.peerId,
    publicKey: uint8ArrayFromString(data.publicKey, 'base64'),
    privateKey: uint8ArrayFromString(decrypted, 'base64'),
    createdAt: data.createdAt,
  };
}

/**
 * Save an encrypted identity to disk.
 */
export async function saveEncryptedIdentity(
  data: EncryptedSerializedIdentity,
  dataDir?: string
): Promise<void> {
  const dir = dataDir || DEFAULT_PANDO_DIR;
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(dir, 'identity.json'), JSON.stringify(data, null, 2), 'utf-8');
}

// ── Session management ──
// Session file stores the decrypted identity so the user doesn't have to
// re-enter their password on every restart. Deleted on /logout.

/**
 * Save a decrypted identity as a session file (stays logged in across restarts).
 */
export async function saveSession(identity: NodeIdentity, dataDir?: string): Promise<void> {
  const dir = dataDir || DEFAULT_PANDO_DIR;
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  const data: SerializedIdentity = {
    peerId: identity.peerId,
    publicKey: uint8ArrayToString(identity.publicKey, 'base64'),
    privateKey: uint8ArrayToString(identity.privateKey, 'base64'),
    createdAt: identity.createdAt,
  };
  await writeFile(join(dir, 'session.json'), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Load session file — returns decrypted identity or null if no session.
 */
export async function loadSession(dataDir?: string): Promise<NodeIdentity | null> {
  const sessionFile = join(dataDir || DEFAULT_PANDO_DIR, 'session.json');
  if (!existsSync(sessionFile)) return null;
  try {
    const raw = await readFile(sessionFile, 'utf-8');
    const parsed: SerializedIdentity = JSON.parse(raw);
    return {
      peerId: parsed.peerId,
      publicKey: uint8ArrayFromString(parsed.publicKey, 'base64'),
      privateKey: uint8ArrayFromString(parsed.privateKey, 'base64'),
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * Delete session file (called on /logout).
 */
export async function clearSession(dataDir?: string): Promise<void> {
  const sessionFile = join(dataDir || DEFAULT_PANDO_DIR, 'session.json');
  if (existsSync(sessionFile)) {
    await unlink(sessionFile);
  }
}

// ── Multiple identity management ──

export interface IdentityInfo {
  peerId: string;
  encrypted: boolean;
  filePath: string;
}

/**
 * List all identities in the data directory.
 * Checks identities/ subfolder and legacy identity.json.
 */
export function listIdentities(dataDir?: string): IdentityInfo[] {
  const dir = dataDir || DEFAULT_PANDO_DIR;
  const identities: IdentityInfo[] = [];
  const seenPeerIds = new Set<string>();

  // Check identities/ directory
  const identitiesDir = join(dir, 'identities');
  if (existsSync(identitiesDir)) {
    const files = readdirSync(identitiesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = join(identitiesDir, file);
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (raw.peerId) {
          identities.push({
            peerId: raw.peerId,
            encrypted: raw.encrypted === true,
            filePath,
          });
          seenPeerIds.add(raw.peerId);
        }
      } catch { /* skip corrupt files */ }
    }
  }

  // Check legacy identity.json
  const legacyPath = join(dir, 'identity.json');
  if (existsSync(legacyPath)) {
    try {
      const raw = JSON.parse(readFileSync(legacyPath, 'utf-8'));
      if (raw.peerId && !seenPeerIds.has(raw.peerId)) {
        identities.push({
          peerId: raw.peerId,
          encrypted: raw.encrypted === true,
          filePath: legacyPath,
        });
      }
    } catch { /* skip corrupt */ }
  }

  return identities;
}

/**
 * Load an identity file by path (encrypted or unencrypted).
 * Returns the raw JSON for the TUI to handle decryption.
 */
export async function loadIdentityFile(
  filePath: string
): Promise<SerializedIdentity | EncryptedSerializedIdentity> {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Ensure identities/ directory exists and return its path.
 */
export async function ensureIdentitiesDir(dataDir?: string): Promise<string> {
  const dir = join(dataDir || DEFAULT_PANDO_DIR, 'identities');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Save an encrypted identity to the identities/ directory.
 */
export async function saveEncryptedIdentityToDir(
  data: EncryptedSerializedIdentity,
  dataDir?: string
): Promise<void> {
  const dir = await ensureIdentitiesDir(dataDir);
  await writeFile(join(dir, `${data.peerId}.json`), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Save an unencrypted identity to the identities/ directory.
 */
export async function saveIdentityToDir(
  identity: NodeIdentity,
  dataDir?: string
): Promise<void> {
  const dir = await ensureIdentitiesDir(dataDir);
  const serialized: SerializedIdentity = {
    peerId: identity.peerId,
    publicKey: uint8ArrayToString(identity.publicKey, 'base64'),
    privateKey: uint8ArrayToString(identity.privateKey, 'base64'),
    createdAt: identity.createdAt,
  };
  await writeFile(join(dir, `${identity.peerId}.json`), JSON.stringify(serialized, null, 2), 'utf-8');
}

/**
 * Hash transaction data for deterministic ID.
 */
export function hashTransaction(from: string, to: string, amount: number, timestamp: number): string {
  const nonce = randomBytes(8).toString('hex');
  const data = `${from}:${to}:${amount}:${timestamp}:${nonce}`;
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Create a canonical byte representation of a transaction for signing.
 * Excludes the signature field itself to avoid circular dependency.
 */
function canonicalTransactionBytes(tx: { id: string; from: string; to: string; amount: number; fee: number; relay?: string; type: string; timestamp: number }): Uint8Array {
  const canonical = `${tx.id}:${tx.from}:${tx.to}:${tx.amount}:${tx.fee}:${tx.relay || ''}:${tx.type}:${tx.timestamp}`;
  return new TextEncoder().encode(canonical);
}

/**
 * Sign a transaction with Ed25519 private key.
 * Returns base64-encoded signature.
 */
export async function signTransaction(
  tx: { id: string; from: string; to: string; amount: number; fee: number; relay?: string; type: string; timestamp: number },
  privateKeyBytes: Uint8Array
): Promise<string> {
  const pk = privateKeyFromProtobuf(privateKeyBytes);
  const data = canonicalTransactionBytes(tx);
  const sig = await pk.sign(data);
  return uint8ArrayToString(sig, 'base64');
}

/**
 * Verify a transaction signature with Ed25519 public key.
 * publicKeyRaw should be the 32-byte raw public key.
 */
export async function verifyTransactionSignature(
  tx: { id: string; from: string; to: string; amount: number; fee: number; relay?: string; type: string; timestamp: number },
  signature: string,
  publicKeyRaw: Uint8Array
): Promise<boolean> {
  try {
    // Build the Ed25519 protobuf-wrapped public key (type 1 = Ed25519)
    const proto = new Uint8Array(2 + 2 + publicKeyRaw.length);
    proto[0] = 0x08; // field 1, varint
    proto[1] = 0x01; // Ed25519 = 1
    proto[2] = 0x12; // field 2, length-delimited
    proto[3] = publicKeyRaw.length; // 32
    proto.set(publicKeyRaw, 4);

    const pk = publicKeyFromProtobuf(proto);
    const data = canonicalTransactionBytes(tx);
    const sig = uint8ArrayFromString(signature, 'base64');
    return await pk.verify(data, sig);
  } catch {
    return false;
  }
}

// ── Governance proposal signing (governance hardening) ──

/**
 * Build a canonical signable payload from a GovernanceProposal.
 * Deterministic: fixed key order, no signature field, no transient fields.
 */
export function buildProposalSignablePayload(proposal: GovernanceProposal): string {
  const canonical = {
    category: proposal.category || '',
    createdAt: proposal.createdAt,
    description: proposal.description,
    id: proposal.id,
    proposedBy: proposal.proposedBy,
    title: proposal.title,
    upgradePayload: proposal.upgradePayload || null,
  };
  return JSON.stringify(canonical);
}

/**
 * Sign a GovernanceProposal with Ed25519 private key.
 * Returns base64-encoded signature.
 */
export async function signProposal(
  proposal: GovernanceProposal,
  privateKeyBytes: Uint8Array
): Promise<string> {
  const pk = privateKeyFromProtobuf(privateKeyBytes);
  const data = new TextEncoder().encode(buildProposalSignablePayload(proposal));
  const sig = await pk.sign(data);
  return uint8ArrayToString(sig, 'base64');
}

/**
 * Verify a GovernanceProposal signature.
 * Extracts the public key from the proposedBy peerId — no ledger lookup needed.
 */
export async function verifyProposalSignature(
  proposal: GovernanceProposal,
  signature: string
): Promise<boolean> {
  try {
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const peerId = peerIdFromString(proposal.proposedBy);
    const pubKeyRaw = peerId.publicKey;
    if (!pubKeyRaw) return false;

    // Build Ed25519 protobuf-wrapped public key (same pattern as verifySignature)
    const rawBytes = pubKeyRaw.raw ?? pubKeyRaw;
    const proto = new Uint8Array(2 + 2 + 32);
    proto[0] = 0x08; proto[1] = 0x01; proto[2] = 0x12; proto[3] = 32;
    proto.set(rawBytes instanceof Uint8Array && rawBytes.length === 32 ? rawBytes : (pubKeyRaw as any).raw ?? new Uint8Array(32), 4);

    const pk = publicKeyFromProtobuf(proto);
    const data = new TextEncoder().encode(buildProposalSignablePayload(proposal));
    const sig = uint8ArrayFromString(signature, 'base64');
    return await pk.verify(data, sig);
  } catch {
    return false;
  }
}
