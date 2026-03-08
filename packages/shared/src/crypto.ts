/**
 * @pando/shared — Crypto Functions
 *
 * Re-exports @pando/identity primitives under legacy names for backward compatibility.
 * Domain-specific wrappers (transaction, proposal, message signing) delegate to identity.
 *
 * New code should import directly from @pando/identity where possible.
 */

import {
  // Core keypair operations
  generate as _generate,
  save as _save,
  loadOrCreate as _loadOrCreate,
  isEncrypted as _isEncrypted,
  loadRaw as _loadRaw,
  encrypt as _encrypt,
  decrypt as _decrypt,
  saveSession as _saveSession,
  loadSession as _loadSession,
  clearSession as _clearSession,
  list as _list,
  loadFile as _loadFile,
  saveToDir as _saveToDir,
  getPrivateKey as _getPrivateKey,
  // Core signing operations
  sign as _sign,
  verify as _verify,
  // Core hashing
  hashTransaction as _hashTransaction,
} from '@pando/identity';
import type {
  NodeIdentity,
  IdentityInfo,
} from '@pando/identity';
import type { PandoMessage, GovernanceProposal } from './types.js';

// ── Re-exports: identity operations ──
// These delegate to @pando/identity. Old names preserved for backward compat.

export const generateIdentity = _generate;
export const saveIdentity = _save;
export const loadOrCreateIdentity = _loadOrCreate;
export const isEncryptedIdentity = _isEncrypted;
export const loadRawIdentityFile = _loadRaw;
export const encryptIdentity = _encrypt;
export const decryptIdentity = _decrypt;
export const saveSession = _saveSession;
export const loadSession = _loadSession;
export const clearSession = _clearSession;
export const listIdentities = _list;
export const loadIdentityFile = _loadFile;
export const getPrivateKeyFromIdentity = _getPrivateKey;

/**
 * Save an unencrypted identity to the identities/ directory.
 */
export async function saveIdentityToDir(identity: NodeIdentity, dataDir?: string): Promise<void> {
  return _saveToDir(identity, dataDir);
}

// Re-export the IdentityInfo type (used by TUI)
export type { IdentityInfo };

// ── Domain-specific signing: PandoMessage ──

/**
 * Sign a PandoMessage with Ed25519 private key.
 * Returns base64-encoded signature.
 */
export async function signMessage(message: PandoMessage, privateKeyBytes: Uint8Array): Promise<string> {
  const { signature: _, ...payload } = message as any;
  const data = new TextEncoder().encode(JSON.stringify(payload));
  return _sign(data, privateKeyBytes);
}

/**
 * Verify a PandoMessage signature with Ed25519 public key (raw 32 bytes).
 */
export async function verifySignature(
  message: PandoMessage,
  signature: string,
  publicKeyRaw: Uint8Array
): Promise<boolean> {
  try {
    const { signature: _, ...payload } = message as any;
    const data = new TextEncoder().encode(JSON.stringify(payload));
    return await _verify(data, signature, publicKeyRaw);
  } catch {
    return false;
  }
}

// ── Domain-specific signing: Transactions ──

export const hashTransaction = _hashTransaction;

function canonicalTransactionBytes(tx: { id: string; from: string; to: string; amount: number; fee: number; relay?: string; type: string; timestamp: number }): Uint8Array {
  const canonical = `${tx.id}:${tx.from}:${tx.to}:${tx.amount}:${tx.fee}:${tx.relay || ''}:${tx.type}:${tx.timestamp}`;
  return new TextEncoder().encode(canonical);
}

/**
 * Sign a transaction with Ed25519 private key.
 */
export async function signTransaction(
  tx: { id: string; from: string; to: string; amount: number; fee: number; relay?: string; type: string; timestamp: number },
  privateKeyBytes: Uint8Array
): Promise<string> {
  const data = canonicalTransactionBytes(tx);
  return _sign(data, privateKeyBytes);
}

/**
 * Verify a transaction signature with Ed25519 public key (raw 32 bytes).
 */
export async function verifyTransactionSignature(
  tx: { id: string; from: string; to: string; amount: number; fee: number; relay?: string; type: string; timestamp: number },
  signature: string,
  publicKeyRaw: Uint8Array
): Promise<boolean> {
  try {
    const data = canonicalTransactionBytes(tx);
    return await _verify(data, signature, publicKeyRaw);
  } catch {
    return false;
  }
}

// ── Domain-specific signing: Governance Proposals ──

/**
 * Build a canonical signable payload from a GovernanceProposal.
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
 */
export async function signProposal(
  proposal: GovernanceProposal,
  privateKeyBytes: Uint8Array
): Promise<string> {
  const data = new TextEncoder().encode(buildProposalSignablePayload(proposal));
  return _sign(data, privateKeyBytes);
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

    const rawBytes = pubKeyRaw.raw ?? pubKeyRaw;
    const publicKeyBytes = rawBytes instanceof Uint8Array && rawBytes.length === 32
      ? rawBytes
      : (pubKeyRaw as any).raw;
    if (!(publicKeyBytes instanceof Uint8Array) || publicKeyBytes.length !== 32) return false;

    const data = new TextEncoder().encode(buildProposalSignablePayload(proposal));
    return await _verify(data, signature, publicKeyBytes);
  } catch {
    return false;
  }
}
