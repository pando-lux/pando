/**
 * Server-side account store.
 *
 * Stores encrypted account data so users can sign in from any device.
 * The server NEVER has access to unencrypted private keys or passwords.
 * It only stores the encrypted blob that the browser created.
 *
 * Storage: ~/.pando/accounts.json (local file for now, network-synced later)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface StoredAccountServer {
  username: string;
  publicKey: string;
  encryptedPrivateKey: string; // base64 — encrypted by the browser
  salt: string; // base64
  iv: string; // base64
  createdAt: number;
}

const ACCOUNTS_PATH = join(homedir(), ".pando", "accounts.json");

function ensureDir() {
  const dir = join(homedir(), ".pando");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadAll(): StoredAccountServer[] {
  if (!existsSync(ACCOUNTS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(ACCOUNTS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveAll(accounts: StoredAccountServer[]) {
  ensureDir();
  writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2));
}

/** Register a new account. Returns false if username is taken. */
export function registerAccount(account: StoredAccountServer): boolean {
  const accounts = loadAll();
  const existing = accounts.find(
    (a) => a.username.toLowerCase() === account.username.toLowerCase()
  );
  if (existing) return false;
  accounts.push(account);
  saveAll(accounts);
  return true;
}

/** Look up an account by username. Returns the encrypted data. */
export function getAccount(username: string): StoredAccountServer | null {
  const accounts = loadAll();
  return (
    accounts.find(
      (a) => a.username.toLowerCase() === username.toLowerCase()
    ) || null
  );
}

/** Check if a username is taken. */
export function isUsernameTaken(username: string): boolean {
  return getAccount(username) !== null;
}

/** Update account (e.g., after password change — new encrypted key). */
export function updateAccount(
  username: string,
  updates: Partial<Pick<StoredAccountServer, "encryptedPrivateKey" | "salt" | "iv">>
): boolean {
  const accounts = loadAll();
  const idx = accounts.findIndex(
    (a) => a.username.toLowerCase() === username.toLowerCase()
  );
  if (idx === -1) return false;
  accounts[idx] = { ...accounts[idx], ...updates };
  saveAll(accounts);
  return true;
}

/** Delete an account. */
export function deleteAccountServer(username: string): boolean {
  const accounts = loadAll();
  const filtered = accounts.filter(
    (a) => a.username.toLowerCase() !== username.toLowerCase()
  );
  if (filtered.length === accounts.length) return false;
  saveAll(filtered);
  return true;
}
