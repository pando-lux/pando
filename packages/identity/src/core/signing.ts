import { privateKeyFromProtobuf, publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';

/**
 * Build a protobuf-wrapped Ed25519 public key from raw 32-byte key.
 */
function wrapPublicKey(publicKeyRaw: Uint8Array): Uint8Array {
  const proto = new Uint8Array(2 + 2 + publicKeyRaw.length);
  proto[0] = 0x08; // field 1, varint
  proto[1] = 0x01; // Ed25519 = 1
  proto[2] = 0x12; // field 2, length-delimited
  proto[3] = publicKeyRaw.length; // 32
  proto.set(publicKeyRaw, 4);
  return proto;
}

/**
 * Sign arbitrary data with an Ed25519 private key.
 * Returns base64-encoded signature.
 */
export async function sign(data: Uint8Array, privateKeyBytes: Uint8Array): Promise<string> {
  const pk = privateKeyFromProtobuf(privateKeyBytes);
  const sig = await pk.sign(data);
  return uint8ArrayToString(sig, 'base64');
}

/**
 * Verify a signature against data and a raw Ed25519 public key.
 */
export async function verify(
  data: Uint8Array,
  signature: string,
  publicKeyRaw: Uint8Array
): Promise<boolean> {
  try {
    const pk = publicKeyFromProtobuf(wrapPublicKey(publicKeyRaw));
    const sig = uint8ArrayFromString(signature, 'base64');
    return await pk.verify(data, sig);
  } catch {
    return false;
  }
}

/**
 * Sign a JSON-serializable payload (excludes 'signature' field, deterministic).
 */
export async function signPayload(payload: Record<string, unknown>, privateKeyBytes: Uint8Array): Promise<string> {
  const { signature: _, ...canonical } = payload;
  const data = new TextEncoder().encode(JSON.stringify(canonical));
  return sign(data, privateKeyBytes);
}

/**
 * Verify a signature on a JSON-serializable payload.
 */
export async function verifyPayload(
  payload: Record<string, unknown>,
  signature: string,
  publicKeyRaw: Uint8Array
): Promise<boolean> {
  const { signature: _, ...canonical } = payload;
  const data = new TextEncoder().encode(JSON.stringify(canonical));
  return verify(data, signature, publicKeyRaw);
}
