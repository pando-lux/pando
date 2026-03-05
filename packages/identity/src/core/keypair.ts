import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PANDO_DIR } from '../constants.js';
import { encryptWithPassword, decryptWithPassword } from './encryption.js';
import type { NodeIdentity, SerializedIdentity, EncryptedSerializedIdentity, IdentityInfo } from '../types.js';

/**
 * Generate a new Ed25519 keypair identity.
 */
export async function generate(): Promise<NodeIdentity> {
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

/**
 * Save an identity to disk (unencrypted).
 */
export async function save(identity: NodeIdentity, dataDir?: string): Promise<void> {
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

/**
 * Load an identity from disk. Returns null if not found or if encrypted.
 */
export async function load(dataDir?: string): Promise<NodeIdentity | null> {
  const identityFile = join(dataDir || DEFAULT_PANDO_DIR, 'identity.json');
  if (!existsSync(identityFile)) {
    return null;
  }

  const raw = await readFile(identityFile, 'utf-8');
  const parsed = JSON.parse(raw);

  if (isEncrypted(parsed)) {
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

/**
 * Load existing identity or create a new one.
 */
export async function loadOrCreate(dataDir?: string): Promise<NodeIdentity> {
  const identityFile = join(dataDir || DEFAULT_PANDO_DIR, 'identity.json');
  if (existsSync(identityFile)) {
    const raw = await readFile(identityFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (isEncrypted(parsed)) {
      throw new Error(
        'Identity is password-protected. Use the interactive TUI to unlock it, ' +
        'or use --data-dir to specify a different data directory.'
      );
    }
  }

  const existing = await load(dataDir);
  if (existing) {
    return existing;
  }

  const identity = await generate();
  await save(identity, dataDir);
  return identity;
}

/**
 * Check if a parsed identity file is encrypted.
 */
export function isEncrypted(
  data: SerializedIdentity | EncryptedSerializedIdentity
): data is EncryptedSerializedIdentity {
  return (data as EncryptedSerializedIdentity).encrypted === true;
}

/**
 * Load identity.json as raw JSON without decrypting.
 */
export async function loadRaw(
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
 * Encrypt an identity with a password (PBKDF2 + AES-256-GCM).
 */
export function encrypt(identity: NodeIdentity, password: string): EncryptedSerializedIdentity {
  const privateKeyBase64 = uint8ArrayToString(identity.privateKey, 'base64');
  const { ciphertext, salt, iv } = encryptWithPassword(privateKeyBase64, password);

  return {
    encrypted: true,
    peerId: identity.peerId,
    publicKey: uint8ArrayToString(identity.publicKey, 'base64'),
    salt,
    iv,
    encryptedPrivateKey: ciphertext,
    createdAt: identity.createdAt,
  };
}

/**
 * Decrypt an encrypted identity using a password.
 */
export function decrypt(data: EncryptedSerializedIdentity, password: string): NodeIdentity {
  const decrypted = decryptWithPassword(data.encryptedPrivateKey, data.salt, data.iv, password);

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
export async function saveEncrypted(data: EncryptedSerializedIdentity, dataDir?: string): Promise<void> {
  const dir = dataDir || DEFAULT_PANDO_DIR;
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(dir, 'identity.json'), JSON.stringify(data, null, 2), 'utf-8');
}

// === Session management ===

/**
 * Save decrypted identity as a session (persistent login across restarts).
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
 * Load session file. Returns null if no session exists.
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
 * Delete session file (logout).
 */
export async function clearSession(dataDir?: string): Promise<void> {
  const sessionFile = join(dataDir || DEFAULT_PANDO_DIR, 'session.json');
  if (existsSync(sessionFile)) {
    await unlink(sessionFile);
  }
}

// === Multiple identity management ===

/**
 * List all identities in the data directory.
 */
export function list(dataDir?: string): IdentityInfo[] {
  const dir = dataDir || DEFAULT_PANDO_DIR;
  const identities: IdentityInfo[] = [];
  const seenPeerIds = new Set<string>();

  const identitiesDir = join(dir, 'identities');
  if (existsSync(identitiesDir)) {
    const files = readdirSync(identitiesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = join(identitiesDir, file);
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (raw.peerId) {
          identities.push({ peerId: raw.peerId, encrypted: raw.encrypted === true, filePath });
          seenPeerIds.add(raw.peerId);
        }
      } catch { /* skip corrupt files */ }
    }
  }

  const legacyPath = join(dir, 'identity.json');
  if (existsSync(legacyPath)) {
    try {
      const raw = JSON.parse(readFileSync(legacyPath, 'utf-8'));
      if (raw.peerId && !seenPeerIds.has(raw.peerId)) {
        identities.push({ peerId: raw.peerId, encrypted: raw.encrypted === true, filePath: legacyPath });
      }
    } catch { /* skip corrupt */ }
  }

  return identities;
}

/**
 * Load an identity file by path (encrypted or unencrypted).
 */
export async function loadFile(filePath: string): Promise<SerializedIdentity | EncryptedSerializedIdentity> {
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Save identity to identities/ directory.
 */
export async function saveToDir(
  identity: NodeIdentity,
  dataDir?: string,
  password?: string
): Promise<void> {
  const dir = join(dataDir || DEFAULT_PANDO_DIR, 'identities');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  if (password) {
    const encrypted = encrypt(identity, password);
    await writeFile(join(dir, `${identity.peerId}.json`), JSON.stringify(encrypted, null, 2), 'utf-8');
  } else {
    const serialized: SerializedIdentity = {
      peerId: identity.peerId,
      publicKey: uint8ArrayToString(identity.publicKey, 'base64'),
      privateKey: uint8ArrayToString(identity.privateKey, 'base64'),
      createdAt: identity.createdAt,
    };
    await writeFile(join(dir, `${identity.peerId}.json`), JSON.stringify(serialized, null, 2), 'utf-8');
  }
}

/**
 * Get the libp2p PrivateKey object from identity bytes.
 */
export function getPrivateKey(identity: NodeIdentity): import('@libp2p/interface').PrivateKey {
  return privateKeyFromProtobuf(identity.privateKey);
}
