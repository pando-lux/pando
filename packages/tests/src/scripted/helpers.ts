import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Reusable Test Helpers ──────────────────────────────────────────
//
// Extracted from pando-e2e.spec.ts patterns. These are parameterized
// (take baseUrl) so they can be used from any spec or runner.

/**
 * Fetch with automatic retry on transient connection errors (ECONNREFUSED, etc.).
 *
 * @param url      Full URL to fetch
 * @param opts     Standard RequestInit options
 * @param retries  Number of retries (default: 2)
 */
export async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  retries: number = 2,
): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, opts);
    } catch (err: any) {
      const isTransient =
        err?.cause?.code?.includes('ECONNREFUSED') ||
        err?.cause?.code?.includes('ECONNRESET') ||
        err?.cause?.code?.includes('UND_ERR_CONNECT_TIMEOUT') ||
        err?.code === 'ECONNREFUSED' ||
        err?.code === 'ECONNRESET';
      if (i === retries || !isTransient) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('fetchWithRetry: unreachable');
}

/**
 * Load the operator API token from ~/.pando/api-token.
 *
 * @param tokenPath  Override the token file path (default: ~/.pando/api-token)
 * @returns          The trimmed token string
 * @throws           If the token file does not exist
 */
export function loadApiToken(tokenPath?: string): string {
  const resolved = tokenPath ?? join(homedir(), '.pando', 'api-token');
  if (existsSync(resolved)) {
    return readFileSync(resolved, 'utf-8').trim();
  }
  throw new Error(`No API token found at ${resolved}`);
}

/**
 * Make an authenticated GET request to the node API and return parsed JSON.
 *
 * @param baseUrl  Node API base URL (e.g. "http://127.0.0.1:4100")
 * @param path     API path (e.g. "/v1/status")
 * @param token    Optional bearer token for authenticated endpoints
 */
export async function apiGet(
  baseUrl: string,
  path: string,
  token?: string,
): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchWithRetry(`${baseUrl}${path}`, { headers });
  return res.json();
}

/**
 * Make an authenticated POST request to the node API and return parsed JSON.
 *
 * @param baseUrl  Node API base URL
 * @param path     API path
 * @param body     Request body (will be JSON.stringify'd)
 * @param token    Optional bearer token
 */
export async function apiPost(
  baseUrl: string,
  path: string,
  body: any,
  token?: string,
): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchWithRetry(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * Make an authenticated request to the node API and return the raw Response.
 * Useful when you need to inspect status codes, headers, or stream the body.
 *
 * @param baseUrl  Node API base URL
 * @param method   HTTP method (GET, POST, PUT, DELETE, PATCH, etc.)
 * @param path     API path
 * @param body     Optional request body (will be JSON.stringify'd)
 * @param token    Optional bearer token
 */
export async function apiRaw(
  baseUrl: string,
  method: string,
  path: string,
  body?: any,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetchWithRetry(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}
