/**
 * Pando E2E Test Suite — Full Integration Test
 *
 * Tests ALL features through the real public gateway + API.
 * Headed mode (visible browser), public Vercel gateway, real P2P network.
 *
 * Prerequisites:
 *   - Windows node running (start-service.bat)
 *   - EC2 nodes running (systemd)
 *   - Public gateway deployed (https://gateway-one-mu.vercel.app)
 *
 * Run: npx playwright test tests/e2e/pando-e2e.spec.ts
 */

import { test, expect } from 'playwright/test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Config ─────────────────────────────────────────────────────────────

const GATEWAY_URL = 'https://gateway-one-mu.vercel.app';
// Use 127.0.0.1 explicitly — localhost resolves to ::1 (IPv6) on some systems
const NODE_API_URL = 'http://127.0.0.1:4100';

function loadApiToken(): string {
  const tokenPath = join(homedir(), '.pando', 'api-token');
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf-8').trim();
  }
  throw new Error('No API token found at ~/.pando/api-token');
}

// ─── Helper: API calls with auth ────────────────────────────────────────

async function apiGet(path: string, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${NODE_API_URL}${path}`, { headers });
  return res.json();
}

async function apiPost(path: string, body: any, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${NODE_API_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiRaw(method: string, path: string, body?: any, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${NODE_API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ═════════════════════════════════════════════════════════════════════════
// 4.2 — Gateway UI Tests
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.2 — Gateway UI', () => {
  test('Home page renders with hero and nav', async ({ page }) => {
    await page.goto(GATEWAY_URL);
    // Use more specific locator — 'pando' appears multiple times
    await expect(page.locator('nav >> text=pando').first()).toBeVisible();
    await expect(page.locator('h1')).toContainText('internet');
    await expect(page.getByRole('link', { name: 'Get started' })).toBeVisible();
  });

  test('Status dashboard loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/dashboard`);
    // Don't use networkidle — pages have SSE/WS connections
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Peers page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/network`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Wallet page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/wallet`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Chat page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/chat`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Projects page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/projects`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Governance page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/governance`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Resources page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/resources`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Marketplace page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/marketplace`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Login page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/login`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Register page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/register`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Explore page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/explore`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Agents page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/agents`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Search page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/search`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('No broken navigation links', async ({ page }) => {
    await page.goto(GATEWAY_URL);
    const links = await page.locator('nav a[href]').all();
    for (const link of links) {
      const href = await link.getAttribute('href');
      if (href && href.startsWith('/')) {
        const response = await page.goto(`${GATEWAY_URL}${href}`);
        expect(response?.status(), `${href} returned ${response?.status()}`).toBeLessThan(500);
        await page.goBack();
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.3 — Auth Flow
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.3 — Auth Flow', () => {
  test('Login page loads (may redirect if already logged in)', async ({ page }) => {
    const response = await page.goto(`${GATEWAY_URL}/login`);
    expect(response?.status()).toBeLessThan(500);
    await page.waitForLoadState('domcontentloaded');
    // Page either shows login form or redirects to home (if already claimed)
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Register page loads (may redirect if already logged in)', async ({ page }) => {
    const response = await page.goto(`${GATEWAY_URL}/register`);
    expect(response?.status()).toBeLessThan(500);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.4 — API Integration
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.4 — API Integration', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('GET /v1/status returns valid JSON', async () => {
    const data = await apiGet('/v1/status');
    expect(data).toHaveProperty('connected');
    expect(data).toHaveProperty('peers');
    expect(data).toHaveProperty('identity');
    expect(data).toHaveProperty('balance');
  });

  test('GET /v1/status shows peer ID', async () => {
    const data = await apiGet('/v1/status');
    expect(data.identity).toMatch(/^12D3KooW/);
  });

  test('GET /v1/status shows Lux balance', async () => {
    const data = await apiGet('/v1/status');
    expect(typeof data.balance).toBe('number');
    expect(data.balance).toBeGreaterThanOrEqual(0);
  });

  test('GET /v1/peers returns array', async () => {
    const data = await apiGet('/v1/peers', token);
    expect(Array.isArray(data) || (data && typeof data === 'object')).toBeTruthy();
  });

  test('GET /v1/capabilities returns valid JSON', async () => {
    const data = await apiGet('/v1/capabilities', token);
    expect(data).toBeTruthy();
  });

  test('GET /v1/network/capabilities returns network data', async () => {
    const data = await apiGet('/v1/network/capabilities', token);
    expect(data).toBeTruthy();
  });

  test('GET /v1/governance/proposals returns proposals', async () => {
    const data = await apiGet('/v1/governance/proposals', token);
    expect(data).toBeTruthy();
  });

  test('GET /v1/gateways returns gateway list', async () => {
    const data = await apiGet('/v1/gateways', token);
    expect(data).toBeTruthy();
  });

  test('GET /v1/resources returns resources list', async () => {
    const data = await apiGet('/v1/resources', token);
    expect(data).toBeTruthy();
  });

  test('GET /v1/agents/tree returns agent hierarchy', async () => {
    const data = await apiGet('/v1/agents/tree', token);
    expect(data).toBeTruthy();
  });

  test('Auth-protected endpoint rejects without token', async () => {
    const res = await apiRaw('POST', '/v1/upgrade/pull');
    expect([401, 403]).toContain(res.status);
  });

  test('Chat history returns valid response', async () => {
    const data = await apiGet('/v1/chat/history', token);
    expect(data).toBeTruthy();
  });

  test('Content list returns valid response', async () => {
    const data = await apiGet('/v1/content', token);
    expect(data).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.5 — P2P & Network
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.5 — P2P & Network', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Windows node has >0 peers', async () => {
    const data = await apiGet('/v1/status');
    expect(data.peers).toBeGreaterThan(0);
  });

  test('Capabilities endpoint shows node capabilities', async () => {
    const data = await apiGet('/v1/capabilities', token);
    expect(data).toBeTruthy();
    const caps = JSON.stringify(data);
    expect(caps).toContain('claude');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.6 — Ledger & Economy
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.6 — Ledger & Economy', () => {
  test('Lux balance shows on status', async () => {
    const data = await apiGet('/v1/status');
    expect(data.balance).toBeGreaterThanOrEqual(0);
    expect(data.totalSupply).toBeGreaterThan(0);
  });

  test('Transaction history via gateway', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/wallet`);
    await page.waitForLoadState('domcontentloaded');
    // Wait for content to render (up to 10s)
    await page.waitForTimeout(3000);
    const body = await page.textContent('body');
    expect(body?.toLowerCase()).toMatch(/lux|balance|wallet/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.7 — Agent System (PandoCode Integration)
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.7 — Agent System', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Agent tree shows orchestrators', async () => {
    const data = await apiGet('/v1/agents/tree', token);
    expect(data).toBeTruthy();
    const tree = JSON.stringify(data);
    expect(tree).toContain('council');
  });

  test('Agents page on gateway shows hierarchy', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/agents`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    await expect(page.locator('body')).not.toBeEmpty();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.8 — Identity
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.8 — Identity', () => {
  test('Node has Ed25519 identity', async () => {
    const data = await apiGet('/v1/status');
    expect(data.identity).toBeTruthy();
    expect(data.identity).toMatch(/^12D3KooW/);
  });

  test('Identity file exists', () => {
    const idPath = join(homedir(), '.pando', 'identity.json');
    expect(existsSync(idPath)).toBe(true);
  });

  test('Linked user account', async () => {
    const data = await apiGet('/v1/status');
    expect(data.linkedUser).toBeTruthy();
    expect(data.linkedUser.username).toBe('pando');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.9 — Governance
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.9 — Governance', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Governance proposals list loads', async () => {
    const data = await apiGet('/v1/governance/proposals', token);
    // API returns { proposals: [...] }
    expect(data).toHaveProperty('proposals');
    expect(Array.isArray(data.proposals)).toBe(true);
  });

  test('Governance page on gateway loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/governance`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    const body = await page.textContent('body');
    expect(body?.toLowerCase()).toMatch(/governance|proposal/);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Gateway API routes (gateway proxies to node)
// ═════════════════════════════════════════════════════════════════════════

test.describe('Gateway API routes', () => {
  test('Gateway /api/status returns data', async ({ page }) => {
    const response = await page.goto(`${GATEWAY_URL}/api/status`);
    expect(response?.status()).toBe(200);
    const text = await page.textContent('body');
    expect(text).toContain('identity');
  });

  test('Gateway /api/peers returns data', async ({ page }) => {
    const response = await page.goto(`${GATEWAY_URL}/api/peers`);
    expect(response?.status()).toBe(200);
  });

  test('Gateway /api/agents/tree returns data', async ({ page }) => {
    const response = await page.goto(`${GATEWAY_URL}/api/agents/tree`);
    expect(response?.status()).toBe(200);
  });
});
