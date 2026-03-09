/**
 * Browser-side Ed25519 crypto utilities for Pando signature-based auth.
 *
 * Uses @noble/curves for Ed25519 operations — pure JS, works in all browsers.
 * Private keys are stored in localStorage (base64 encoded).
 *
 * Phase 41: Client-side E2E encrypted chat.
 * - X25519 key exchange (Ed25519 → X25519 conversion)
 * - AES-256-GCM encryption via Web Crypto API
 * - Per-thread encryption key management
 */

import { ed25519, x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from "@noble/curves/ed25519";

const PRIVATE_KEY_PREFIX = "pando_privkey_";

/**
 * Generate a new Ed25519 keypair.
 * Returns { publicKey, privateKey } as Uint8Array.
 */
export function generateKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  // ed25519.utils.randomPrivateKey() generates a 32-byte random seed
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/**
 * Sign a hex-encoded challenge string with an Ed25519 private key.
 * Returns the signature as a hex string.
 */
export function signChallenge(challengeHex: string, privateKey: Uint8Array): string {
  // Convert hex challenge to bytes
  const challengeBytes = hexToBytes(challengeHex);
  const signature = ed25519.sign(challengeBytes, privateKey);
  return bytesToHex(signature);
}

/**
 * Store a private key in localStorage (base64 encoded).
 * Phase 86: Also tracks the current active peerId.
 */
export function storePrivateKey(peerId: string, privateKey: Uint8Array): void {
  const b64 = btoa(String.fromCharCode(...privateKey));
  localStorage.setItem(PRIVATE_KEY_PREFIX + peerId, b64);
  localStorage.setItem("pando_current_peerId", peerId);
}

/**
 * Retrieve a private key from localStorage.
 * Returns null if not found.
 */
export function getPrivateKey(peerId: string): Uint8Array | null {
  const b64 = localStorage.getItem(PRIVATE_KEY_PREFIX + peerId);
  if (!b64) return null;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Remove a private key from localStorage.
 */
export function clearPrivateKey(peerId: string): void {
  localStorage.removeItem(PRIVATE_KEY_PREFIX + peerId);
}

/**
 * Get the peerId associated with the current active private key.
 * Phase 86: Uses pando_current_peerId marker to avoid returning stale keys.
 * Falls back to scanning localStorage if marker is missing.
 */
export function getStoredPeerId(): string | null {
  // Check the explicit current peerId marker first
  const currentPeerId = localStorage.getItem("pando_current_peerId");
  if (currentPeerId) {
    const hasKey = localStorage.getItem(PRIVATE_KEY_PREFIX + currentPeerId);
    if (hasKey) return currentPeerId;
  }
  // Fallback: scan for any stored key
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PRIVATE_KEY_PREFIX)) {
      return key.slice(PRIVATE_KEY_PREFIX.length);
    }
  }
  return null;
}

/**
 * Get the public key (base64) for a stored private key.
 * Returns null if no private key found.
 */
export function getPublicKeyBase64(peerId: string): string | null {
  const privateKey = getPrivateKey(peerId);
  if (!privateKey) return null;
  const publicKey = ed25519.getPublicKey(privateKey);
  return btoa(String.fromCharCode(...publicKey));
}

// ── Hex utilities ──

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Base64 utilities ──

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── Phase 41: E2E Encrypted Chat ──────────────────────────────────────────────

const THREAD_KEY_PREFIX = "pando_threadkey_";

/**
 * Convert a Uint8Array to an ArrayBuffer (needed for Web Crypto API compatibility
 * since TypeScript strict mode doesn't allow Uint8Array where BufferSource is expected).
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Convert an Ed25519 private key (32-byte seed) to an X25519 private key.
 */
export function edToX25519Private(edPrivateKey: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPriv(edPrivateKey);
}

/**
 * Convert an Ed25519 public key (32 bytes) to an X25519 public key.
 */
export function edToX25519Public(edPublicKey: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPub(edPublicKey);
}

/**
 * Derive an X25519 shared secret from my X25519 private key and their X25519 public key.
 * The shared secret is used as a key-encryption key.
 */
export function x25519SharedSecret(myX25519Private: Uint8Array, theirX25519Public: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(myX25519Private, theirX25519Public);
}

/**
 * Generate a random 256-bit thread encryption key.
 */
export function generateThreadKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Encrypt a plaintext message with AES-256-GCM.
 * Returns { ciphertext, nonce } both as base64 strings.
 */
export async function encryptMessage(
  plaintext: string,
  key: Uint8Array
): Promise<{ ciphertext: string; nonce: string }> {
  const encoder = new TextEncoder();
  const plainBytes = encoder.encode(plaintext);
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    cryptoKey,
    plainBytes
  );

  return {
    ciphertext: toBase64(new Uint8Array(ciphertextBuf)),
    nonce: toBase64(nonce),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted message.
 * Takes ciphertext and nonce as base64 strings, key as Uint8Array.
 */
export async function decryptMessage(
  ciphertext: string,
  nonce: string,
  key: Uint8Array
): Promise<string> {
  const ciphertextBytes = fromBase64(ciphertext);
  const nonceBytes = fromBase64(nonce);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    "AES-GCM",
    false,
    ["decrypt"]
  );

  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonceBytes) },
    cryptoKey,
    toArrayBuffer(ciphertextBytes)
  );

  return new TextDecoder().decode(plainBuf);
}

/**
 * Encrypt a thread key for a recipient using X25519 key exchange + AES-256-GCM.
 * Both keys are Ed25519 — we convert to X25519 internally.
 * Returns the encrypted thread key as a base64 string (nonce + ciphertext concatenated).
 */
export async function encryptThreadKey(
  threadKey: Uint8Array,
  myEdPrivate: Uint8Array,
  theirEdPublic: Uint8Array
): Promise<string> {
  const myX = edToX25519Private(myEdPrivate);
  const theirX = edToX25519Public(theirEdPublic);
  const shared = x25519SharedSecret(myX, theirX);

  // Use the first 32 bytes of the shared secret as the wrapping key
  // (X25519 already returns 32 bytes)
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  const wrapKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(shared),
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    wrapKey,
    toArrayBuffer(threadKey)
  );

  // Concatenate nonce (12 bytes) + ciphertext (32 + 16 auth tag = 48 bytes) = 60 bytes total
  const result = new Uint8Array(12 + encrypted.byteLength);
  result.set(nonce, 0);
  result.set(new Uint8Array(encrypted), 12);

  return toBase64(result);
}

/**
 * Decrypt a thread key that was encrypted for us using X25519 key exchange.
 * Both keys are Ed25519 — we convert to X25519 internally.
 * Takes the encrypted key as a base64 string (nonce + ciphertext concatenated).
 */
export async function decryptThreadKey(
  encryptedKey: string,
  myEdPrivate: Uint8Array,
  theirEdPublic: Uint8Array
): Promise<Uint8Array> {
  const data = fromBase64(encryptedKey);
  const nonce = data.slice(0, 12);
  const ciphertext = data.slice(12);

  const myX = edToX25519Private(myEdPrivate);
  const theirX = edToX25519Public(theirEdPublic);
  const shared = x25519SharedSecret(myX, theirX);

  const wrapKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(shared),
    "AES-GCM",
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    wrapKey,
    toArrayBuffer(ciphertext)
  );

  return new Uint8Array(decrypted);
}

/**
 * Encrypt a thread key for a specific node (for per-request delivery).
 * Both keys are Ed25519 -- we convert to X25519 internally.
 * Returns the encrypted thread key as a base64 string (nonce + ciphertext concatenated).
 * This is functionally identical to encryptThreadKey but named for clarity.
 */
export async function encryptThreadKeyForNode(
  threadKey: Uint8Array,
  myEdPrivate: Uint8Array,
  nodeEdPublic: Uint8Array
): Promise<string> {
  return encryptThreadKey(threadKey, myEdPrivate, nodeEdPublic);
}

/**
 * Store a thread encryption key in localStorage.
 */
export function storeThreadKey(threadId: string, threadKey: Uint8Array): void {
  localStorage.setItem(THREAD_KEY_PREFIX + threadId, toBase64(threadKey));
}

/**
 * Retrieve a thread encryption key from localStorage.
 * Returns null if not found.
 */
export function getThreadKey(threadId: string): Uint8Array | null {
  const b64 = localStorage.getItem(THREAD_KEY_PREFIX + threadId);
  if (!b64) return null;
  return fromBase64(b64);
}

// ── Phase 41.5: Password-based private key encryption (multi-device backup) ──

/**
 * Encrypt a private key with a password using PBKDF2 + AES-256-GCM.
 * Uses Web Crypto API for all operations.
 * Returns a base64 string of: salt (16 bytes) + nonce (12 bytes) + ciphertext+authTag.
 */
export async function encryptPrivateKeyWithPassword(
  privateKey: Uint8Array,
  password: string
): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  // Derive AES key from password
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  // Encrypt the private key
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    aesKey,
    toArrayBuffer(privateKey)
  );

  // Concatenate: salt (16) + nonce (12) + ciphertext+authTag
  const result = new Uint8Array(16 + 12 + ciphertextBuf.byteLength);
  result.set(salt, 0);
  result.set(nonce, 16);
  result.set(new Uint8Array(ciphertextBuf), 28);

  return toBase64(result);
}

/**
 * Decrypt a private key that was encrypted with encryptPrivateKeyWithPassword.
 * Takes the encrypted string (base64) and the password.
 * Returns the decrypted private key as Uint8Array.
 * Throws on wrong password.
 */
export async function decryptPrivateKeyWithPassword(
  encrypted: string,
  password: string
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const data = fromBase64(encrypted);

  // Extract: salt (16) + nonce (12) + ciphertext+authTag
  const salt = data.slice(0, 16);
  const nonce = data.slice(16, 28);
  const ciphertext = data.slice(28);

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  // Derive AES key from password
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  // Decrypt the private key
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(nonce) },
    aesKey,
    toArrayBuffer(ciphertext)
  );

  return new Uint8Array(plainBuf);
}
