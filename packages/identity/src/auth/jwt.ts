import { sign, verify } from '../core/signing.js';
import { JWT_EXPIRY_SECONDS } from '../constants.js';
import type { JwtPayload } from '../types.js';

/**
 * Issue a Pando JWT signed with the node's Ed25519 private key.
 * Structure: base64url(header).base64url(payload).base64url(signature)
 */
export async function issueJwt(
  subjectPeerId: string,
  issuerPeerId: string,
  privateKeyBytes: Uint8Array,
  opts?: { expirySeconds?: number; typ?: 'human' | 'agent' },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT' };
  const payload: JwtPayload = {
    sub: subjectPeerId,
    iss: issuerPeerId,
    iat: now,
    exp: now + (opts?.expirySeconds ?? JWT_EXPIRY_SECONDS),
    typ: opts?.typ ?? 'human',
  };

  const headerB64 = toBase64Url(JSON.stringify(header));
  const payloadB64 = toBase64Url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await sign(new TextEncoder().encode(signingInput), privateKeyBytes);
  const signatureB64 = base64ToBase64Url(signature);

  return `${signingInput}.${signatureB64}`;
}

/**
 * Verify and decode a Pando JWT against the node's Ed25519 public key.
 * Returns the payload if valid, null if invalid or expired.
 */
export async function verifyJwt(
  token: string,
  publicKeyRaw: Uint8Array,
): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64UrlToBase64(signatureB64);

  const valid = await verify(
    new TextEncoder().encode(signingInput),
    signature,
    publicKeyRaw,
  );
  if (!valid) return null;

  try {
    const payload: JwtPayload = JSON.parse(fromBase64Url(payloadB64));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Decode a JWT payload WITHOUT verifying the signature.
 * Use only when you need to inspect the payload (e.g., to find the issuer).
 */
export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(fromBase64Url(parts[1]));
  } catch {
    return null;
  }
}

// === Base64url helpers ===

function toBase64Url(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64url');
}

function fromBase64Url(b64url: string): string {
  return Buffer.from(b64url, 'base64url').toString('utf-8');
}

function base64ToBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBase64(b64url: string): string {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return b64;
}
