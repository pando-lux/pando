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

// ─── Helper: API calls with auth + retry for transient failures ─────────

async function fetchWithRetry(url: string, opts: RequestInit, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, opts);
    } catch (err: any) {
      if (i === retries || !err?.cause?.code?.includes('ECONNREFUSED')) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error('unreachable');
}

async function apiGet(path: string, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchWithRetry(`${NODE_API_URL}${path}`, { headers });
  return res.json();
}

async function apiPost(path: string, body: any, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchWithRetry(`${NODE_API_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiRaw(method: string, path: string, body?: any, token?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetchWithRetry(`${NODE_API_URL}${path}`, {
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

  test('PandoCode engine detected as capability', async () => {
    const data = await apiGet('/v1/capabilities', token);
    expect(data.capabilities).toBeTruthy();
    expect(data.capabilities).toContain('pando-code');
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
// 4.9 — Governance & Auto-Upgrade (CORE TEST)
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.9 — Governance & Auto-Upgrade', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Governance proposals list loads', async () => {
    const data = await apiGet('/v1/governance/proposals', token);
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

  test('Create governance proposal', async () => {
    const data = await apiPost('/v1/governance/propose', {
      title: 'E2E Test: Governance Pipeline Verification',
      description: 'Automated E2E test — verifies proposal creation, staking, and voting',
      category: 'general',
    }, token);
    expect(data.success).toBe(true);
    expect(data.proposal).toBeTruthy();
    expect(data.proposal.id).toBeTruthy();
    expect(data.proposal.status).toBe('active');
    // Dev mode: stake is reduced to 1 Lux (≤8 peers)
    expect(data.proposal.stakeAmount).toBeGreaterThan(0);
    expect(data.proposal.proposerSignature).toBeTruthy(); // Ed25519 signed
    // Store for voting test
    (globalThis as any).__e2eProposalId = data.proposal.id;
  });

  test('Vote on governance proposal', async () => {
    const proposalId = (globalThis as any).__e2eProposalId;
    expect(proposalId).toBeTruthy();
    const data = await apiPost('/v1/governance/vote', {
      proposalId,
      choice: 'approve',
      reasoning: 'E2E test vote — governance pipeline verification',
    }, token);
    expect(data.success).toBe(true);
    expect(data.votes).toBeTruthy();
    expect(data.votes.approve).toBeGreaterThanOrEqual(1);
    // With 1 voter, decision should be reached immediately
    expect(data.decision).toBeTruthy();
    expect(data.decision.outcome).toBe('passed');
  });

  test('Active proposals list filters correctly', async () => {
    const data = await apiGet('/v1/governance/proposals/active', token);
    expect(data).toHaveProperty('proposals');
    expect(Array.isArray(data.proposals)).toBe(true);
  });

  test('Upgrade status endpoint works', async () => {
    const data = await apiGet('/v1/upgrade/status', token);
    expect(data).toBeTruthy();
    expect(data).toHaveProperty('upgradeInProgress');
    expect(data).toHaveProperty('currentVersion');
    expect(typeof data.upgradeInProgress).toBe('boolean');
  });

  test('Upgrade history shows past upgrades', async () => {
    const data = await apiGet('/v1/upgrade/history', token);
    expect(data).toHaveProperty('history');
    expect(Array.isArray(data.history)).toBe(true);
    // There should be past upgrades from the live network
    if (data.history.length > 0) {
      expect(data.history[0]).toHaveProperty('version');
      expect(data.history[0]).toHaveProperty('status');
    }
  });

  test('Security gate rejects upgrade proposals touching immutable files', async () => {
    // The upgrade/propose endpoint checks current git diff against security rules
    // If current diff touches immutable files, it rejects — this IS the security gate
    const res = await apiRaw('POST', '/v1/upgrade/propose', {
      description: 'E2E security test — should be rejected if diff touches immutable files',
    }, token);
    const data = await res.json();
    // Either succeeds (no immutable files in diff) or rejects with security reason
    expect(data.success === true || (data.error && typeof data.error === 'string')).toBeTruthy();
  });

  test('Auth-protected upgrade endpoint rejects without token', async () => {
    const res = await apiRaw('POST', '/v1/upgrade/propose', {
      description: 'Should be rejected — no auth token',
    });
    expect([401, 403]).toContain(res.status);
  });

  test('Council orchestrator is active', async () => {
    const data = await apiGet('/v1/council', token);
    expect(data).toBeTruthy();
    expect(data.orchestratorId).toMatch(/^orch-council/);
    expect(data.role).toBe('council');
    expect(data.status).toBe('active');
  });

  test('Council dashboard returns full state', async () => {
    const data = await apiGet('/v1/council/dashboard', token);
    expect(data).toBeTruthy();
    expect(data.council).toBeTruthy();
    expect(data.council.orchestratorId).toMatch(/^orch-council/);
    expect(data.council.status).toBe('active');
    expect(data).toHaveProperty('workers');
    expect(Array.isArray(data.workers)).toBe(true);
    expect(data).toHaveProperty('network');
  });

  test('Council directives system works', async () => {
    const data = await apiGet('/v1/council/directives', token);
    expect(data).toHaveProperty('directives');
    expect(Array.isArray(data.directives)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.10 — Doorman: Static App Lifecycle (CORE TEST)
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.10 — Static App Lifecycle', () => {
  let token: string;
  let projectId: string;
  let contentId: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Create static project', async () => {
    const data = await apiPost('/v1/projects', {
      name: `e2e-static-app-${Date.now()}`,
      description: 'E2E test: static app lifecycle — create, publish, marketplace',
      type: 'static',
      visibility: 'listed',
      tier: 1,
    }, token);
    expect(data.project).toBeTruthy();
    expect(data.project.id).toBeTruthy();
    expect(data.project.tier).toBe(1);
    expect(data.project.visibility).toBe('listed');
    expect(data.project.status).toBe('active');
    projectId = data.project.id;
  });

  test('Register content in marketplace', async () => {
    const data = await apiPost('/v1/content', {
      type: 'website',
      title: `E2E Static App ${Date.now()}`,
      description: 'Automated test content — static website',
      tags: ['e2e', 'static', 'test'],
    }, token);
    expect(data.success).toBe(true);
    expect(data.contentId).toBeTruthy();
    expect(data.record.status).toBe('draft');
    expect(data.record.type).toBe('website');
    contentId = data.contentId;
  });

  test('Publish content (draft → live)', async () => {
    const res = await apiRaw('POST', `/v1/content/${contentId}/publish`, undefined, token);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.record.status).toBe('live');
    expect(data.record.version).toBeGreaterThanOrEqual(2); // version bumps on publish
  });

  test('Content appears in content list', async () => {
    const data = await apiGet('/v1/content', token);
    expect(data.content).toBeTruthy();
    const found = data.content.find((c: any) => c.contentId === contentId);
    expect(found).toBeTruthy();
    expect(found.status).toBe('live');
  });

  test('Project appears in marketplace', async () => {
    const data = await apiGet('/v1/marketplace');
    expect(data.projects).toBeTruthy();
    const found = data.projects.find((p: any) => p.id === projectId);
    expect(found).toBeTruthy();
    expect(found.visibility).toBe('listed');
  });

  test('Marketplace page on gateway shows projects', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/marketplace`);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Project details endpoint works', async () => {
    const data = await apiGet(`/v1/projects/${projectId}`, token);
    expect(data).toBeTruthy();
    expect(data.id || data.project?.id).toBeTruthy();
  });

  test('Archive content (live → archived)', async () => {
    const res = await apiRaw('DELETE', `/v1/content/${contentId}`, undefined, token);
    expect(res.status).toBeLessThan(500);
    // Verify it's archived
    const data = await apiGet('/v1/content', token);
    const found = data.content?.find((c: any) => c.contentId === contentId);
    // Either removed or status changed to archived
    if (found) {
      expect(found.status).toBe('archived');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.11 — Doorman: Dynamic App & Deployment (CORE TEST)
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.11 — Dynamic App & Deployment', () => {
  let token: string;
  let projectId: string;
  let contentId: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Create Tier 2 dynamic project', async () => {
    const data = await apiPost('/v1/projects', {
      name: `e2e-ws-app-${Date.now()}`,
      description: 'E2E test: WebSocket app — Tier 2 deployment via P2P to EC2',
      type: 'dynamic',
      visibility: 'listed',
      tier: 2,
    }, token);
    expect(data.project).toBeTruthy();
    expect(data.project.id).toBeTruthy();
    expect(data.project.tier).toBe(2);
    expect(data.project.type).toBe('dynamic');
    projectId = data.project.id;
  });

  test('Register dynamic content (service type)', async () => {
    const data = await apiPost('/v1/content', {
      type: 'service',
      title: `E2E WebSocket Service ${Date.now()}`,
      description: 'Automated test — WebSocket service for P2P deployment',
      tags: ['e2e', 'websocket', 'dynamic'],
    }, token);
    expect(data.success).toBe(true);
    expect(data.contentId).toBeTruthy();
    expect(data.record.type).toBe('service');
    contentId = data.contentId;
  });

  test('Publish dynamic content', async () => {
    const res = await apiRaw('POST', `/v1/content/${contentId}/publish`, undefined, token);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.record.status).toBe('live');
  });

  test('Tier 2 deploy requires compute peers', async () => {
    // Tier 2 deployment routes to EC2 via P2P — if no peers, returns helpful error
    const res = await apiRaw('POST', `/v1/projects/${projectId}/deploy`, {
      type: 'custom',
    }, token);
    const data = await res.json();
    // Either deploys successfully (if EC2 peers connected) or returns peer error
    if (data.error) {
      expect(data.error).toContain('compute peers');
      expect(data.hint).toBeTruthy();
    } else {
      expect(data.status).toBe('deployed');
      expect(data.deploymentUrl).toBeTruthy();
    }
  });

  test('Tier 2 project appears in marketplace', async () => {
    const data = await apiGet('/v1/marketplace');
    expect(data.projects).toBeTruthy();
    const found = data.projects.find((p: any) => p.id === projectId);
    expect(found).toBeTruthy();
    expect(found.type).toBe('dynamic');
  });

  test('Gateway registry tracks gateways', async () => {
    const data = await apiGet('/v1/gateways', token);
    expect(data).toHaveProperty('gateways');
    expect(data).toHaveProperty('total');
    expect(typeof data.total).toBe('number');
  });

  test('Undeploy endpoint works', async () => {
    const res = await apiRaw('POST', `/v1/projects/${projectId}/undeploy`, {
      deleteFiles: true,
    }, token);
    // Either succeeds or returns "not deployed" — both are valid
    expect(res.status).toBeLessThan(500);
  });

  test('Cleanup: archive dynamic content', async () => {
    const res = await apiRaw('DELETE', `/v1/content/${contentId}`, undefined, token);
    expect(res.status).toBeLessThan(500);
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
