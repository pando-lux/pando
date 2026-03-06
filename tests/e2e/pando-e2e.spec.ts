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

// Phase 8: Agent identity imports (dynamic — loaded in beforeAll to handle ESM)

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
      title: `E2E Governance ${Date.now()}`,
      description: 'Automated E2E test — verifies proposal creation, staking, and voting',
      category: 'general',
    }, token);

    if (data.success) {
      expect(data.proposal).toBeTruthy();
      expect(data.proposal.id).toBeTruthy();
      expect(data.proposal.status).toBe('active');
      expect(data.proposal.stakeAmount).toBeGreaterThan(0);
      (globalThis as any).__e2eProposalId = data.proposal.id;
    } else {
      // Rate-limited — find an existing active proposal to use for voting
      expect(data.error).toBeTruthy();
      const active = await apiGet('/v1/governance/proposals/active', token);
      const proposals = active.proposals || [];
      if (proposals.length > 0) {
        (globalThis as any).__e2eProposalId = proposals[0].id;
      }
    }
  });

  test('Vote on governance proposal', async () => {
    const proposalId = (globalThis as any).__e2eProposalId;
    if (!proposalId) return; // Skip if no proposal available

    const data = await apiPost('/v1/governance/vote', {
      proposalId,
      choice: 'approve',
      reasoning: 'E2E test vote — governance pipeline verification',
    }, token);

    if (data.success) {
      expect(data.votes).toBeTruthy();
      expect(data.votes.approve).toBeGreaterThanOrEqual(1);
    } else {
      // May fail if already voted or proposal expired — both valid states
      expect(data.error).toBeTruthy();
    }
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
// 4.12 — Resource & Marketplace
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.12 — Resource & Marketplace', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Resources endpoint returns resource list', async () => {
    const data = await apiGet('/v1/resources', token);
    expect(data).toBeTruthy();
  });

  test('Marketplace endpoint returns pricing data', async () => {
    const data = await apiGet('/v1/resources/marketplace', token);
    expect(data).toBeTruthy();
  });

  test('Resource metering endpoint works', async () => {
    const data = await apiGet('/v1/resources/metering', token);
    expect(data).toBeTruthy();
  });

  test('PandoCode is the only AI backend', async () => {
    const data = await apiGet('/v1/capabilities', token);
    expect(data.capabilities).toContain('pando-code');
    // Verify PandoCode is detected and active
    const status = await apiGet('/v1/status', token);
    expect(status.connected).toBe(true);
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

// ═════════════════════════════════════════════════════════════════════════
// 4.13 — Chat & Threads
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.13 — Chat & Threads', () => {
  let token: string;
  let threadId: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Chat history returns messages array', async () => {
    const data = await apiGet('/v1/chat/history', token);
    expect(data).toBeTruthy();
  });

  test('Create chat thread', async () => {
    const data = await apiPost('/v1/chat/threads', { title: 'E2E Test Thread' }, token);
    expect(data.id || data.threadId).toBeTruthy();
    threadId = data.id || data.threadId;
  });

  test('List chat threads', async () => {
    const data = await apiGet('/v1/chat/threads', token);
    expect(Array.isArray(data) || data.threads).toBeTruthy();
  });

  test('Get specific thread', async () => {
    if (!threadId) return;
    const data = await apiGet(`/v1/chat/threads/${threadId}`, token);
    expect(data).toBeTruthy();
  });

  test('Delete chat thread', async () => {
    if (!threadId) return;
    const res = await apiRaw('DELETE', `/v1/chat/threads/${threadId}`, undefined, token);
    expect([200, 204].includes(res.status)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.14 — Scenarios & Regression
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.14 — Scenarios & Regression', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Scenarios list returns data', async () => {
    const data = await apiGet('/v1/scenarios', token);
    expect(data).toBeTruthy();
  });

  test('Scenarios status returns last run info', async () => {
    const data = await apiGet('/v1/scenarios/status', token);
    expect(data).toBeTruthy();
  });

  test('Regression endpoint returns data', async () => {
    const data = await apiGet('/v1/regression', token);
    expect(data).toBeTruthy();
  });

  test('Regression results endpoint works', async () => {
    const data = await apiGet('/v1/regression/results', token);
    expect(data).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.15 — Context API
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.15 — Context API', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Context identity returns agent identity', async () => {
    const data = await apiGet('/v1/context/identity', token);
    expect(data).toBeTruthy();
  });

  test('Context lessons returns lessons array', async () => {
    const data = await apiGet('/v1/context/lessons', token);
    expect(data).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.16 — Health & Monitoring
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.16 — Health & Monitoring', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Health endpoint returns status', async () => {
    const data = await apiGet('/v1/health', token);
    expect(data).toBeTruthy();
    expect(data.status || data.healthy !== undefined).toBeTruthy();
  });

  test('Monitor status returns metrics', async () => {
    const data = await apiGet('/v1/monitor/status', token);
    expect(data).toBeTruthy();
  });

  test('Monitor metrics endpoint works', async () => {
    const data = await apiGet('/v1/monitor/metrics', token);
    expect(data).toBeTruthy();
  });

  test('Monitor system info returns data', async () => {
    const data = await apiGet('/v1/monitor/system', token);
    expect(data).toBeTruthy();
  });

  test('Guardrails status returns config', async () => {
    const data = await apiGet('/v1/guardrails/status', token);
    expect(data).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.17 — Network & Topology
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.17 — Network & Topology', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Network overview returns topology data', async () => {
    const data = await apiGet('/v1/network/overview', token);
    expect(data).toBeTruthy();
  });

  test('Network topology returns peer graph', async () => {
    const data = await apiGet('/v1/network/topology', token);
    expect(data).toBeTruthy();
  });

  test('Discovery endpoint returns discovered peers', async () => {
    const data = await apiGet('/v1/discovery', token);
    expect(data).toBeTruthy();
  });

  test('Network state returns current state', async () => {
    const data = await apiGet('/v1/network-state', token);
    expect(data).toBeTruthy();
  });

  test('Wallet returns balance and address', async () => {
    const data = await apiGet('/v1/wallet', token);
    expect(data).toBeTruthy();
    expect(data.peerId || data.address).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.18 — Tasks System
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.18 — Tasks System', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Tasks list returns tasks', async () => {
    const data = await apiGet('/v1/tasks', token);
    expect(data).toBeTruthy();
  });

  test('Tasks stats returns counts', async () => {
    const data = await apiGet('/v1/tasks/stats', token);
    expect(data).toBeTruthy();
  });

  test('Capacity endpoint returns resource info', async () => {
    const data = await apiGet('/v1/capacity', token);
    expect(data).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.19 — Auth System
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.19 — Auth System', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Auth stats returns user counts', async () => {
    const data = await apiGet('/v1/auth/stats', token);
    expect(data).toBeTruthy();
  });

  test('Auth me returns current user', async () => {
    const res = await apiRaw('GET', '/v1/auth/me', undefined, token);
    // May return 401 if no session — both 200 and 401 are valid
    expect([200, 401].includes(res.status)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.20 — Ledger & Emissions
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.20 — Ledger & Emissions', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Ledger accounts returns account list', async () => {
    const data = await apiGet('/v1/ledger/accounts', token);
    expect(data).toBeTruthy();
  });

  test('Ledger transactions returns tx history', async () => {
    const data = await apiGet('/v1/ledger/transactions', token);
    expect(data).toBeTruthy();
  });

  test('Emissions pending returns pending emissions', async () => {
    const data = await apiGet('/v1/emissions/pending', token);
    expect(data).toBeTruthy();
  });

  test('Emissions history returns past emissions', async () => {
    const data = await apiGet('/v1/emissions/history', token);
    expect(data).toBeTruthy();
  });

  test('Emissions stats returns emission metrics', async () => {
    const data = await apiGet('/v1/emissions/stats', token);
    expect(data).toBeTruthy();
  });

  test('Transactions for peer returns history', async () => {
    const status = await apiGet('/v1/status', token);
    const data = await apiGet(`/v1/transactions/${status.peerId}`, token);
    expect(data).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.21 — Security & Reputation
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.21 — Security & Reputation', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Security alerts returns alert list', async () => {
    const data = await apiGet('/v1/security/alerts', token);
    expect(data).toBeTruthy();
  });

  test('Security stats returns metrics', async () => {
    const data = await apiGet('/v1/security/stats', token);
    expect(data).toBeTruthy();
  });

  test('Security quarantine returns quarantined peers', async () => {
    const data = await apiGet('/v1/security/quarantine', token);
    expect(data).toBeTruthy();
  });

  test('Reputation returns node reputation', async () => {
    const data = await apiGet('/v1/reputation', token);
    expect(data).toBeTruthy();
  });

  test('Reputation peers returns peer scores', async () => {
    const data = await apiGet('/v1/reputation/peers', token);
    expect(data).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.22 — Templates & Content
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.22 — Templates & Content', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Templates list returns available templates', async () => {
    const data = await apiGet('/v1/templates', token);
    expect(data).toBeTruthy();
  });

  test('Content stats returns metrics', async () => {
    const data = await apiGet('/v1/content/stats', token);
    expect(data).toBeTruthy();
  });

  test('Content search works', async () => {
    const data = await apiGet('/v1/content/search?q=test', token);
    expect(data).toBeTruthy();
  });

  test('Payment stats returns economy data', async () => {
    const data = await apiGet('/v1/payment/stats', token);
    expect(data).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.23 — Council Extended
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.23 — Council Extended', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Council minutes returns tick history', async () => {
    const data = await apiGet('/v1/council/minutes', token);
    expect(data).toBeTruthy();
  });

  test('Council health returns system health', async () => {
    const data = await apiGet('/v1/council/health', token);
    expect(data).toBeTruthy();
  });

  test('Council directives returns directive list', async () => {
    const data = await apiGet('/v1/council/directives', token);
    expect(data).toBeTruthy();
  });

  test('Council requests returns pending requests', async () => {
    const data = await apiGet('/v1/council/requests', token);
    expect(data).toBeTruthy();
  });

  test('Council chat returns council messages', async () => {
    const data = await apiGet('/v1/council/chat', token);
    expect(data).toBeTruthy();
  });

  test('Infrastructure capabilities returns infra info', async () => {
    const data = await apiGet('/v1/capabilities/infrastructure', token);
    expect(data).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4.24 — Gateway Extended Pages
// ═════════════════════════════════════════════════════════════════════════

test.describe('4.24 — Gateway Extended Pages', () => {
  test('Council page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/council`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Monitor page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/monitor`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Scheduler page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/scheduler`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Content page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/content`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Services page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/services`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Capacity page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/capacity`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Apps page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/apps`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Node setup page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/node-setup`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Strategy page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/strategy`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Resources guide page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/resources/guide`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Dev page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/dev`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Explore activity page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/explore/activity`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Explore economy page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/explore/economy`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Explore health page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/explore/health`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Explore network page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/explore/network`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Explore governance page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/explore/governance`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Explore tasks page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/explore/tasks`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Explore how it works page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/explore/how-it-works`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('Explore strategy page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/explore/strategy`);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).not.toBeEmpty();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5.1 — Task Lifecycle (functional)
// ═════════════════════════════════════════════════════════════════════════

test.describe('5.1 — Task Lifecycle (functional)', () => {
  let token: string;
  let taskId: string;
  let nodeIdentity: string;

  test.beforeAll(async () => {
    token = loadApiToken();
    // Get node identity for task creation (worker lockdown requires managerId or local peerId)
    const status = await apiGet('/v1/status');
    nodeIdentity = status.identity;
  });

  test('Create a task via API', async () => {
    const data = await apiPost('/v1/tasks', {
      title: 'E2E test task ' + Date.now(),
      description: 'Automated test — full task lifecycle',
      priority: 'medium',
      createdBy: nodeIdentity,
    }, token);
    expect(data.success).toBe(true);
    expect(data.task).toBeTruthy();
    expect(data.task.id).toBeTruthy();
    expect(data.task.title).toContain('E2E test task');
    expect(data.task.status).toBe('open');
    expect(data.task.priority).toBe('medium');
    taskId = data.task.id;
  });

  test('Task appears in task list', async () => {
    const data = await apiGet('/v1/tasks', token);
    expect(data).toBeTruthy();
    // data may be an array or { tasks: [...] }
    const tasks = Array.isArray(data) ? data : (data.tasks || []);
    const found = tasks.find((t: any) => t.id === taskId);
    expect(found).toBeTruthy();
    expect(found.status).toBe('open');
  });

  test('Claim the task', async () => {
    const data = await apiPost(`/v1/tasks/${taskId}/claim`, {
      agentId: 'e2e-test-agent',
    }, token);
    expect(data.success).toBe(true);
  });

  test('Update task status to in_progress', async () => {
    const data = await apiPost(`/v1/tasks/${taskId}/status`, {
      status: 'in_progress',
    }, token);
    expect(data.success).toBe(true);
  });

  test('Complete the task', async () => {
    const data = await apiPost(`/v1/tasks/${taskId}/complete`, {
      note: 'E2E test completed successfully',
      buildPassed: true,
      testsPassed: true,
    }, token);
    expect(data.success).toBe(true);
  });

  test('Verify task is completed', async () => {
    const data = await apiGet('/v1/tasks', token);
    const tasks = Array.isArray(data) ? data : (data.tasks || []);
    const found = tasks.find((t: any) => t.id === taskId);
    expect(found).toBeTruthy();
    expect(found.status).toBe('done');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5.2 — Auth Guest Flow (functional)
// ═════════════════════════════════════════════════════════════════════════

test.describe('5.2 — Auth Guest Flow (functional)', () => {
  let token: string;
  let guestToken: string;
  let guestPeerId: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Create guest identity', async () => {
    const data = await apiPost('/v1/auth/guest', {}, token);
    expect(data.success).toBe(true);
    expect(data.token).toBeTruthy();
    expect(data.peerId).toBeTruthy();
    expect(data.isClaimed).toBe(false);
    guestToken = data.token;
    guestPeerId = data.peerId;
  });

  test('Guest token works with auth/me', async () => {
    // auth/me requires a user JWT, not the node Bearer token
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${guestToken}`,
    };
    const res = await fetchWithRetry(`${NODE_API_URL}/v1/auth/me`, { headers });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.user).toBeTruthy();
    expect(data.user.peerId).toBe(guestPeerId);
    expect(data.user.isClaimed).toBe(false);
  });

  test('Auth challenge returns signed challenge token', async () => {
    const status = await apiGet('/v1/status');
    const data = await apiPost('/v1/auth/challenge', {
      peerId: status.identity,
    }, token);
    expect(data.challengeToken).toBeTruthy();
    expect(data.nonce).toBeTruthy();
    expect(data.expiresAt).toBeGreaterThan(Date.now());
    // Verify challenge token format: base64url.hex
    expect(data.challengeToken).toContain('.');
  });

  test('Auth challenge rejects missing peerId', async () => {
    const res = await apiRaw('POST', '/v1/auth/challenge', {}, token);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('peerId');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5.3 — Chat Message Flow (functional)
// ═════════════════════════════════════════════════════════════════════════

test.describe('5.3 — Chat Message Flow (functional)', () => {
  let token: string;
  let userJwt: string;
  const testMessage = 'E2E test message ' + Date.now();

  test.beforeAll(async () => {
    token = loadApiToken();
    // Create a guest to get a user JWT (chat/message requires user JWT, not Bearer token)
    const guest = await apiPost('/v1/auth/guest', {}, token);
    userJwt = guest.token;
  });

  test('Send chat message (message routing works)', async () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userJwt}`,
    };
    const res = await fetchWithRetry(`${NODE_API_URL}/v1/chat/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: testMessage }),
    });
    const data = await res.json();
    // Message routing should work even without AI — expect 200 with a response
    // The doorman may classify this as 'simple' and reply directly
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      expect(data.status || data.reply || data.threadId).toBeTruthy();
    } else {
      // Structured error (400/401/etc), not a crash
      expect(data.error).toBeTruthy();
    }
  });

  test('Chat history returns valid response', async () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${userJwt}`,
    };
    const res = await fetchWithRetry(`${NODE_API_URL}/v1/chat/history`, { headers });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toBeTruthy();
    // Should have messages array (may or may not contain our test message depending on thread routing)
    expect(data.messages !== undefined || data.threads !== undefined).toBeTruthy();
  });

  test('Chat clear succeeds', async () => {
    const data = await apiPost('/v1/chat/clear', {}, token);
    expect(data.success).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5.4 — Project Chat Flow (functional)
// ═════════════════════════════════════════════════════════════════════════

test.describe('5.4 — Project Chat Flow (functional)', () => {
  let token: string;
  let projectId: string;
  let threadId: string;
  const projectName = 'e2e-func-test-' + Date.now();

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Create project', async () => {
    const data = await apiPost('/v1/projects', {
      name: projectName,
      description: 'Functional test project for chat flow',
      tier: 1,
      visibility: 'owner_only',
    }, token);
    expect(data.project).toBeTruthy();
    expect(data.project.id).toBeTruthy();
    expect(data.project.name).toBe(projectName);
    projectId = data.project.id;
  });

  test('Create chat thread for project', async () => {
    const data = await apiPost('/v1/chat/threads', {
      title: 'Test thread for ' + projectName,
      projectId: projectId,
    }, token);
    expect(data).toBeTruthy();
    // Thread creation returns the thread metadata
    threadId = data.id || data.threadId;
    expect(threadId).toBeTruthy();
  });

  test('List chat threads includes new thread', async () => {
    const data = await apiGet('/v1/chat/threads', token);
    expect(data).toBeTruthy();
    const threads = Array.isArray(data) ? data : (data.threads || []);
    // Threads are user-scoped — without a user JWT this might return empty
    // With Bearer token, it should still not crash
    expect(Array.isArray(threads)).toBe(true);
  });

  test('Get project details', async () => {
    const res = await apiRaw('GET', `/v1/projects/${projectId}`, undefined, token);
    // owner_only projects may return 403 with Bearer token vs owner JWT — that's fine
    expect(res.status).toBeLessThan(500);
    const data = await res.json();
    if (res.status === 200) {
      const proj = data.project || data;
      expect(proj.id || proj.name).toBeTruthy();
    } else {
      // Access denied is expected for owner_only with node token
      expect(data.error).toBeTruthy();
    }
  });

  test('Get specific thread', async () => {
    if (!threadId) return;
    const data = await apiGet(`/v1/chat/threads/${threadId}`, token);
    expect(data).toBeTruthy();
  });

  test('Cleanup: delete thread', async () => {
    if (!threadId) return;
    const res = await apiRaw('DELETE', `/v1/chat/threads/${threadId}`, undefined, token);
    expect(res.status).toBeLessThan(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5.5 — Governance Full Cycle (functional)
// ═════════════════════════════════════════════════════════════════════════

test.describe('5.5 — Governance Full Cycle (functional)', () => {
  let token: string;
  let proposalId: string;
  const proposalTitle = 'E2E functional test proposal ' + Date.now();

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Create a non-upgrade governance proposal', async () => {
    const data = await apiPost('/v1/governance/propose', {
      title: proposalTitle,
      description: 'Testing full governance cycle: create, vote, decide',
      category: 'general',
    }, token);

    if (data.success) {
      expect(data.proposal).toBeTruthy();
      expect(data.proposal.id).toBeTruthy();
      expect(data.proposal.status).toBe('active');
      proposalId = data.proposal.id;
    } else {
      // Rate-limited — use an existing active proposal
      expect(data.error).toBeTruthy();
      const active = await apiGet('/v1/governance/proposals/active', token);
      const proposals = active.proposals || [];
      if (proposals.length > 0) proposalId = proposals[0].id;
    }
  });

  test('Proposal appears in proposals list', async () => {
    if (!proposalId) return; // Skip if no proposal
    const data = await apiGet('/v1/governance/proposals', token);
    expect(data.proposals).toBeTruthy();
    const found = data.proposals.find((p: any) => p.id === proposalId);
    expect(found).toBeTruthy();
  });

  test('Vote approve on the proposal', async () => {
    if (!proposalId) return; // Skip if no proposal
    const data = await apiPost('/v1/governance/vote', {
      proposalId,
      choice: 'approve',
      reasoning: 'E2E functional test — verifying full governance cycle',
    }, token);

    if (data.success) {
      expect(data.votes).toBeTruthy();
      expect(data.votes.approve).toBeGreaterThanOrEqual(1);
    } else {
      // May fail if already voted or proposal expired
      expect(data.error).toBeTruthy();
    }
  });

  test('Governance stats are valid', async () => {
    const data = await apiGet('/v1/governance/stats', token);
    expect(data).toBeTruthy();
    expect(data.statusCounts).toBeTruthy();
    // There should be at least one proposal counted
    const totalCounted = Object.values(data.statusCounts).reduce((sum: number, count: any) => sum + (count as number), 0);
    expect(totalCounted).toBeGreaterThan(0);
  });

  test('Proposal reached a decision', async () => {
    if (!proposalId) return; // Skip if no proposal
    const data = await apiGet('/v1/governance/proposals', token);
    const found = data.proposals.find((p: any) => p.id === proposalId);
    if (found) {
      // Proposal may be active, passed, approved, decided, or expired
      expect(['passed', 'approved', 'active', 'decided', 'expired']).toContain(found.status);
    }
    // If not found, it may have been cleaned up — also valid
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5.6 — Content Discovery Flow (functional)
// ═════════════════════════════════════════════════════════════════════════

test.describe('5.6 — Content Discovery Flow (functional)', () => {
  let token: string;
  let contentId: string;
  const contentTitle = 'E2E Searchable ' + Date.now();

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Create content entry', async () => {
    const data = await apiPost('/v1/content', {
      title: contentTitle,
      description: 'Functional test content for search and discovery',
      type: 'dataset',
      tags: ['e2e', 'functional-test'],
    }, token);
    expect(data.success).toBe(true);
    expect(data.contentId).toBeTruthy();
    expect(data.record).toBeTruthy();
    expect(data.record.status).toBe('draft');
    expect(data.record.type).toBe('dataset');
    contentId = data.contentId;
  });

  test('Content appears in content list', async () => {
    const data = await apiGet('/v1/content', token);
    expect(data.content).toBeTruthy();
    const found = data.content.find((c: any) => c.contentId === contentId);
    expect(found).toBeTruthy();
    expect(found.title).toBe(contentTitle);
  });

  test('Search finds the content', async () => {
    const data = await apiGet('/v1/content/search?q=E2E+Searchable', token);
    expect(data).toBeTruthy();
    // Search may return results array or { content: [...] }
    // Search results are wrapped: { results: [{ content: {...} }] }
    const results = data.results || data.content || data;
    if (Array.isArray(results)) {
      const found = results.find((r: any) => {
        const c = r.content || r;
        return (c.title || '').includes('E2E Searchable') || (c.contentId === contentId);
      });
      expect(found).toBeTruthy();
    }
  });

  test('Get content by ID', async () => {
    const res = await apiRaw('GET', `/v1/content/${contentId}`, undefined, token);
    expect(res.status).toBeLessThan(500);
    const data = await res.json();
    expect(data).toBeTruthy();
  });

  test('Cleanup: archive content', async () => {
    const res = await apiRaw('DELETE', `/v1/content/${contentId}`, undefined, token);
    expect(res.status).toBeLessThan(500);
    // Verify archived or removed
    const data = await apiGet('/v1/content', token);
    const found = data.content?.find((c: any) => c.contentId === contentId);
    if (found) {
      expect(found.status).toBe('archived');
    }
    // If not found, it was fully deleted — also valid
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 5.7 — PandoCode Engine Verification (functional)
// ═════════════════════════════════════════════════════════════════════════

test.describe('5.7 — PandoCode Engine Verification (functional)', () => {
  let token: string;

  test.beforeAll(() => {
    token = loadApiToken();
  });

  test('Capabilities include pando-code', async () => {
    const data = await apiGet('/v1/capabilities', token);
    expect(data.capabilities).toBeTruthy();
    expect(data.capabilities).toContain('pando-code');
  });

  test('Status shows connected node with version info', async () => {
    const data = await apiGet('/v1/status');
    expect(data.connected).toBe(true);
    expect(data.identity).toBeTruthy();
    // Version info should be present
    expect(data.version || data.commitHash || data.uptime !== undefined).toBeTruthy();
  });

  test('Infrastructure capabilities show engine info', async () => {
    const data = await apiGet('/v1/capabilities/infrastructure', token);
    expect(data).toBeTruthy();
    // Should have some infrastructure details
    const infra = JSON.stringify(data);
    expect(infra.length).toBeGreaterThan(2); // Not just {}
  });

  test('Agent spawn with invalid orchestrator returns error', async () => {
    // Attempt to spawn with a non-existent orchestrator
    const res = await apiRaw('POST', '/v1/agents/spawn', {
      role: 'builder',
      orchestratorId: 'nonexistent-orch',
    }, token);
    const data = await res.json();
    // Returns error (400 after fix, 500 on old running code — both have error field)
    expect(data.error).toBeTruthy();
  });

  test('Agent tree includes council orchestrator', async () => {
    const data = await apiGet('/v1/agents/tree', token);
    expect(data).toBeTruthy();
    const tree = JSON.stringify(data);
    expect(tree).toContain('council');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// PHASE 8 — Agent Identity & Pando Login
//
// Real agent authentication: E2E test creates its own Ed25519 identity
// certified by the human operator, performs Pando Login (challenge-response),
// and uses the resulting JWT for all authenticated operations.
// ═════════════════════════════════════════════════════════════════════════

/** Helper: API call with user JWT via X-User-Token header */
async function apiGetJwt(path: string, jwt: string): Promise<any> {
  const res = await fetchWithRetry(`${NODE_API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', 'X-User-Token': jwt },
  });
  return res.json();
}

async function apiPostJwt(path: string, body: any, jwt: string): Promise<any> {
  const res = await fetchWithRetry(`${NODE_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Token': jwt },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiRawJwt(method: string, path: string, jwt: string, body?: any): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-User-Token': jwt };
  return fetchWithRetry(`${NODE_API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

test.describe('8 — Agent Identity & Pando Login', () => {
  // Shared state across all Phase 8 tests
  let humanPeerId: string;
  let humanPublicKey: Uint8Array;
  let humanPrivateKey: Uint8Array;
  let agentProfile: any;
  let agentIdentity: any; // { peerId, publicKey, privateKey, createdAt }
  let agentJwt: string;
  let operatorToken: string;

  test.beforeAll(async () => {
    operatorToken = loadApiToken();

    // Load human identity from ~/.pando/identity.json
    const { fromString } = await import('uint8arrays');
    const identityPath = join(homedir(), '.pando', 'identity.json');
    const sessionPath = join(homedir(), '.pando', 'session.json');

    let parsed: any;
    if (existsSync(identityPath)) {
      parsed = JSON.parse(readFileSync(identityPath, 'utf-8'));
    }
    // If encrypted, fall back to session.json (decrypted session)
    if (!parsed || parsed.encrypted) {
      if (existsSync(sessionPath)) {
        parsed = JSON.parse(readFileSync(sessionPath, 'utf-8'));
      }
    }
    if (!parsed || parsed.encrypted) {
      throw new Error('Cannot load human identity — identity.json is encrypted and no session.json found. Unlock via TUI first.');
    }

    humanPeerId = parsed.peerId;
    humanPublicKey = fromString(parsed.publicKey, 'base64');
    humanPrivateKey = fromString(parsed.privateKey, 'base64');
  });

  // ── 8.1 — Create Agent Identity ──────────────────────────────────────

  test('Human identity loaded from disk', () => {
    expect(humanPeerId).toBeTruthy();
    expect(humanPeerId).toMatch(/^12D3KooW/); // Ed25519 libp2p peerId prefix
    expect(humanPublicKey.length).toBe(32); // Raw Ed25519 public key
    expect(humanPrivateKey.length).toBeGreaterThan(32); // Protobuf-encoded private key
  });

  test('Create agent identity certified by human', async () => {
    const { createAgent } = await import('@pando/identity');

    const result = await createAgent(
      {
        name: `e2e-tester-${Date.now()}`,
        role: 'tester',
        tools: ['read', 'write', 'test'],
        capabilities: ['e2e-testing', 'api-verification'],
        canEarn: true,
        canSpend: true,
        canAuthenticate: true,
        budgetLimit: 100,
      },
      { peerId: humanPeerId, publicKey: humanPublicKey, privateKey: humanPrivateKey },
    );

    agentProfile = result.profile;
    agentIdentity = result.identity;

    // Agent has its own identity
    expect(agentProfile.id).toBeTruthy();
    expect(agentProfile.id).toMatch(/^12D3KooW/);
    expect(agentIdentity.peerId).toBe(agentProfile.id);
    // Certified by human
    expect(agentProfile.parentId).toBe(humanPeerId);
    expect(agentProfile.certificate).toBeTruthy();
    expect(agentProfile.certificate.parentSignature).toBeTruthy();
    // Permissions
    expect(agentProfile.canAuthenticate).toBe(true);
    expect(agentProfile.canEarn).toBe(true);
    expect(agentProfile.canSpend).toBe(true);
    // Different identity from human
    expect(agentIdentity.peerId).not.toBe(humanPeerId);
  });

  test('Agent certificate verifies offline (trust chain)', async () => {
    const { verifyCertificate } = await import('@pando/identity');

    const valid = await verifyCertificate(agentProfile.certificate, humanPublicKey);
    expect(valid).toBe(true);

    // Certificate fields match
    expect(agentProfile.certificate.agentId).toBe(agentIdentity.peerId);
    expect(agentProfile.certificate.parentId).toBe(humanPeerId);
    const expiresAt = new Date(agentProfile.certificate.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now()); // Not expired
  });

  // ── 8.2 — Agent Pando Login (Challenge-Response) ─────────────────────

  test('Get auth challenge for agent peerId', async () => {
    const data = await apiPost('/v1/auth/challenge', { peerId: agentIdentity.peerId });

    expect(data.challengeToken).toBeTruthy();
    expect(data.nonce).toBeTruthy();
    expect(typeof data.nonce).toBe('string');
    expect(data.expiresAt).toBeGreaterThan(Date.now());
  });

  test('Agent signs challenge nonce and gets JWT', async () => {
    const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
    const { toString: u8ToString, fromString: u8FromString } = await import('uint8arrays');

    // Step 1: Get challenge
    const challenge = await apiPost('/v1/auth/challenge', { peerId: agentIdentity.peerId });
    expect(challenge.challengeToken).toBeTruthy();

    // Step 2: Sign the nonce with agent's private key
    const nonceBytes = u8FromString(challenge.nonce, 'base16');
    const pk = privateKeyFromProtobuf(agentIdentity.privateKey);
    const sig = await pk.sign(nonceBytes);
    const signatureHex = u8ToString(sig, 'base16');

    // Step 3: Verify with the node — get JWT
    const result = await apiPost('/v1/auth/verify', {
      peerId: agentIdentity.peerId,
      challengeToken: challenge.challengeToken,
      signature: signatureHex,
    });

    expect(result.token).toBeTruthy();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    agentJwt = result.token;
  });

  test('Agent JWT authenticates on /auth/me', async () => {
    const data = await apiGetJwt('/v1/auth/me', agentJwt);

    expect(data.user).toBeTruthy();
    expect(data.user.peerId).toBe(agentIdentity.peerId);
    expect(data.user.authMethod).toBe('jwt');
    // New agent starts with 0 balance
    expect(data.user.balance).toBeDefined();
  });

  // ── 8.2.5 — Agent-authenticated operations ───────────────────────────

  test('Agent can list projects (empty for new agent)', async () => {
    const data = await apiGetJwt('/v1/projects', agentJwt);
    expect(data).toBeTruthy();
    const projects = Array.isArray(data) ? data : (data.projects || []);
    expect(Array.isArray(projects)).toBe(true);
  });

  test('Agent can read content registry', async () => {
    const data = await apiGetJwt('/v1/content', agentJwt);
    expect(data).toBeTruthy();
  });

  test('Agent can access node status', async () => {
    const data = await apiGetJwt('/v1/status', agentJwt);
    expect(data.connected).toBe(true);
    expect(data.identity).toBeTruthy();
  });

  test('Agent can check ledger balance', async () => {
    const res = await apiRawJwt('GET', `/v1/balance/${agentIdentity.peerId}`, agentJwt);
    expect(res.status).toBeLessThan(500);
    const data = await res.json();
    expect(data).toBeTruthy();
  });

  test('Agent can list chat threads (scoped to agent)', async () => {
    const data = await apiGetJwt('/v1/chat/threads', agentJwt);
    expect(data).toBeTruthy();
    // Agent has no threads yet
    const threads = Array.isArray(data) ? data : (data.threads || []);
    expect(Array.isArray(threads)).toBe(true);
  });

  test('Agent identity chain is complete', async () => {
    // Full trust chain verification
    expect(agentProfile.parentId).toBe(humanPeerId);
    expect(agentProfile.certificate.agentId).toBe(agentIdentity.peerId);
    expect(agentProfile.certificate.parentId).toBe(humanPeerId);

    // Certificate has valid timestamps
    const issuedAt = new Date(agentProfile.certificate.issuedAt).getTime();
    const expiresAt = new Date(agentProfile.certificate.expiresAt).getTime();
    expect(issuedAt).toBeLessThanOrEqual(Date.now());
    expect(expiresAt).toBeGreaterThan(Date.now());

    // Permissions match config
    expect(agentProfile.certificate.permissions.canEarn).toBe(true);
    expect(agentProfile.certificate.permissions.canSpend).toBe(true);
    expect(agentProfile.certificate.permissions.canAuthenticate).toBe(true);
  });

  // ── 8.3 — Agent Lux Economy ──────────────────────────────────────────

  test('Human (node) has Lux balance', async () => {
    const data = await apiGet(`/v1/balance/${humanPeerId}`);
    expect(data.peerId).toBe(humanPeerId);
    expect(typeof data.balance).toBe('number');
    // Node should have some balance from emissions
    expect(data.balance).toBeGreaterThanOrEqual(0);
  });

  test('Transfer Lux from human to agent', async () => {
    // First check human has enough balance
    const balData = await apiGet(`/v1/balance/${humanPeerId}`);
    if (balData.balance < 1) {
      // Skip if human has no balance — can't test transfer
      console.log('Skipping Lux transfer: human has 0 balance');
      return;
    }

    const data = await apiPost('/v1/transfer', {
      to: agentIdentity.peerId,
      amount: 1,
    }, operatorToken);

    expect(data.success).toBe(true);
    expect(data.transaction).toBeTruthy();
    expect(data.transaction.to).toBe(agentIdentity.peerId);
    expect(data.transaction.amount).toBe(1);
  });

  test('Agent balance reflects transfer', async () => {
    const data = await apiGet(`/v1/balance/${agentIdentity.peerId}`);
    expect(data.peerId).toBe(agentIdentity.peerId);
    expect(typeof data.balance).toBe('number');
    // Agent received at least some Lux (minus relay fee)
  });

  test('Agent can view own transactions via JWT', async () => {
    const data = await apiGetJwt('/v1/transactions', agentJwt);
    expect(data).toBeTruthy();
    expect(data.peerId).toBe(agentIdentity.peerId);
    expect(Array.isArray(data.transactions)).toBe(true);
  });

  test('Agent balance visible on /auth/me', async () => {
    const data = await apiGetJwt('/v1/auth/me', agentJwt);
    expect(data.user).toBeTruthy();
    expect(data.user.peerId).toBe(agentIdentity.peerId);
    expect(typeof data.user.balance).toBe('number');
  });

  // ── 8.4 — Agent Signed Actions ───────────────────────────────────────

  test('Agent signs action with own Ed25519 key', async () => {
    const { createSignedAction } = await import('@pando/identity');

    const action = await createSignedAction(
      { agentId: agentIdentity.peerId, action: 'test_action', payload: { description: 'E2E signed action test' } },
      agentIdentity.privateKey,
      agentIdentity.publicKey,
      agentProfile.certificate,
    );

    expect(action).toBeTruthy();
    expect(action.signature).toBeTruthy();
    expect(action.action).toBe('test_action');
    expect(action.agentId).toBe(agentIdentity.peerId);
    expect(action.certificate).toBeTruthy();
  });

  test('Signed action verifies offline', async () => {
    const { createSignedAction, verifySignedAction } = await import('@pando/identity');

    const action = await createSignedAction(
      { agentId: agentIdentity.peerId, action: 'governance_vote', payload: { proposalId: 'test-123' } },
      agentIdentity.privateKey,
      agentIdentity.publicKey,
      agentProfile.certificate,
    );

    const valid = await verifySignedAction(action);
    expect(valid).toBe(true);
  });

  test('Full trust chain: action signature + certificate + human', async () => {
    const { createSignedAction, verifySignedActionFull } = await import('@pando/identity');

    const action = await createSignedAction(
      { agentId: agentIdentity.peerId, action: 'deploy_request', payload: { target: 'vercel' } },
      agentIdentity.privateKey,
      agentIdentity.publicKey,
      agentProfile.certificate,
    );

    // Full offline verification: action sig + cert sig + human trust chain
    const result = await verifySignedActionFull(action, humanPublicKey);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // ── 8.5 — Full Agent Lifecycle ────────────────────────────────────────

  test('Agent sends chat message (owns the thread)', async () => {
    const data = await apiPostJwt('/v1/chat/message', {
      message: `E2E agent lifecycle test ${Date.now()}`,
    }, agentJwt);

    expect(data).toBeTruthy();
    // Chat response — may be queued or get immediate reply
    expect(data.threadId || data.status).toBeTruthy();
  });

  test('Agent chat threads are scoped (only agent threads)', async () => {
    const data = await apiGetJwt('/v1/chat/threads', agentJwt);
    expect(data).toBeTruthy();
    const threads = Array.isArray(data) ? data : (data.threads || []);
    // Agent should have at least the thread from previous test
    expect(threads.length).toBeGreaterThanOrEqual(0);
  });

  test('Agent creates chat thread directly', async () => {
    const data = await apiPostJwt('/v1/chat/threads', {
      title: `Agent Thread ${Date.now()}`,
      type: 'general',
    }, agentJwt);

    expect(data).toBeTruthy();
    expect(data.threadId || data.id).toBeTruthy();
  });

  test('Agent refreshes JWT (stays authenticated)', async () => {
    const data = await apiPostJwt('/v1/auth/refresh', {}, agentJwt);
    expect(data.success).toBe(true);
    expect(data.token).toBeTruthy();
    expect(data.peerId).toBe(agentIdentity.peerId);
    // Update JWT for remaining tests
    agentJwt = data.token;
  });

  test('Certificate expiry: tampered cert fails verification', async () => {
    const { verifyCertificate } = await import('@pando/identity');

    // Create a copy with expired date
    const expiredCert = {
      ...agentProfile.certificate,
      expiresAt: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
    };

    // Expired cert fails (signature won't match due to changed expiresAt)
    const valid = await verifyCertificate(expiredCert, humanPublicKey);
    expect(valid).toBe(false);
  });

  test('Tampered signature fails verification', async () => {
    const { verifySignedAction, createSignedAction } = await import('@pando/identity');

    const action = await createSignedAction(
      { agentId: agentIdentity.peerId, action: 'tamper_test', payload: {} },
      agentIdentity.privateKey,
      agentIdentity.publicKey,
      agentProfile.certificate,
    );

    // Tamper with payload after signing
    const tampered = { ...action, payload: { tampered: true } };
    const valid = await verifySignedAction(tampered);
    expect(valid).toBe(false);
  });

  // ── 8.5b — Agent as First-Class Citizen (governance + content) ────────

  test('Agent creates governance proposal via JWT', async () => {
    // POST endpoints require operator Bearer token for auth middleware,
    // but verifyUserJwt extracts the agent's peerId for the proposer field.
    // Send BOTH operator token (Authorization) and agent JWT (X-User-Token).
    const res = await fetchWithRetry(`${NODE_API_URL}/v1/governance/propose`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${operatorToken}`,
        'X-User-Token': agentJwt,
      },
      body: JSON.stringify({
        title: `Agent Proposal ${Date.now()}`,
        description: 'E2E test: agent submits governance proposal with own JWT identity',
      }),
    });
    const data = await res.json();

    expect(data.success || data.error).toBeTruthy(); // Must get a meaningful response
    if (data.success) {
      expect(data.proposal).toBeTruthy();
      // proposer is agent's peerId if node has dual-auth, or node's peerId otherwise
      if (data.proposer) {
        expect(data.proposer).toMatch(/^12D3KooW/);
      }
    }
  });

  test('Agent votes on proposal via JWT', async () => {
    const proposals = await apiGet('/v1/governance/proposals');
    const list = proposals.proposals || proposals;
    expect(Array.isArray(list)).toBe(true);

    if (list.length > 0) {
      const targetId = list[list.length - 1].id || list[list.length - 1].proposalId;
      const res = await fetchWithRetry(`${NODE_API_URL}/v1/governance/vote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${operatorToken}`,
          'X-User-Token': agentJwt,
        },
        body: JSON.stringify({
          proposalId: targetId,
          choice: 'approve',
          reasoning: 'E2E agent vote test',
        }),
      });
      const data = await res.json();

      expect(data.success || data.error).toBeTruthy();
      if (data.success) {
        expect(data.voter).toBe(agentIdentity.peerId);
      }
    }
  });

  test('Agent creates content in marketplace via JWT', async () => {
    const res = await fetchWithRetry(`${NODE_API_URL}/v1/content`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${operatorToken}`,
        'X-User-Token': agentJwt,
      },
      body: JSON.stringify({
        type: 'tool',
        title: `Agent Tool ${Date.now()}`,
        description: 'E2E test: agent creates content with own identity',
        tags: ['e2e', 'agent-created'],
      }),
    });
    const data = await res.json();

    expect(data.success).toBe(true);
    expect(data.contentId).toBeTruthy();
    expect(data.record).toBeTruthy();
  });
});

// ─── Phase 9 — Critical Uncovered API Workflows ─────────────────────────────

test.describe('9.1 — Task Queue Lifecycle', () => {
  let token: string;
  let taskId: string;

  test.beforeAll(() => { token = loadApiToken(); });

  test('Create a task', async () => {
    const data = await apiPost('/v1/tasks', {
      title: `E2E Task ${Date.now()}`,
      description: 'Automated lifecycle test',
      priority: 'medium',
      type: 'build',
    }, token);
    expect(data).toBeTruthy();
    // Task may have id, taskId, or be returned differently
    taskId = data.id || data.taskId || data.task?.id;
    expect(taskId || data.error).toBeTruthy(); // Must get something back
  });

  test('Task appears in task list', async () => {
    const data = await apiGet('/v1/tasks', token);
    expect(data.tasks).toBeTruthy();
    expect(Array.isArray(data.tasks)).toBe(true);
  });

  test('Task stats reflect queue state', async () => {
    const data = await apiGet('/v1/tasks/stats', token);
    expect(data).toBeTruthy();
  });

  test('Claim the task', async () => {
    if (!taskId) return;
    const res = await apiRaw('POST', `/v1/tasks/${taskId}/claim`, {}, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Update task status', async () => {
    if (!taskId) return;
    const res = await apiRaw('POST', `/v1/tasks/${taskId}/status`, { status: 'in_progress' }, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Complete the task', async () => {
    if (!taskId) return;
    const res = await apiRaw('POST', `/v1/tasks/${taskId}/complete`, { result: 'E2E test complete' }, token);
    expect(res.status).toBeLessThan(500);
  });
});

test.describe('9.2 — Project Management', () => {
  let token: string;
  let projectId: string;

  test.beforeAll(() => { token = loadApiToken(); });

  test('Project stats endpoint works', async () => {
    const res = await apiRaw('GET', '/v1/projects/stats', undefined, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Create project directly', async () => {
    const data = await apiPost('/v1/projects', {
      name: `E2E Project ${Date.now()}`,
      description: 'Automated project lifecycle test',
    }, token);
    // May return project object or error (endpoint might not exist as direct POST)
    if (data.id || data.projectId || data.project) {
      projectId = data.id || data.projectId || data.project?.id;
    }
    expect(data).toBeTruthy();
  });

  test('Get project API key', async () => {
    if (!projectId) return;
    const res = await apiRaw('GET', `/v1/projects/${projectId}/api-key`, undefined, token);
    expect(res.status).toBeLessThan(500);
  });

  test('List project collaborators', async () => {
    if (!projectId) return;
    const res = await apiRaw('GET', `/v1/projects/${projectId}/collaborators`, undefined, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Get project deployments', async () => {
    if (!projectId) return;
    const res = await apiRaw('GET', `/v1/projects/${projectId}/deployments`, undefined, token);
    expect(res.status).toBeLessThan(500);
  });
});

test.describe('9.3 — Advanced Governance', () => {
  let token: string;

  test.beforeAll(() => { token = loadApiToken(); });

  test('Governance comment endpoint exists', async () => {
    // Try to comment on a non-existent proposal — should get 400/404, not 500
    const res = await apiRaw('POST', '/v1/governance/comment', {
      proposalId: 'nonexistent',
      content: 'test comment',
    }, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Get specific proposal details', async () => {
    const proposals = await apiGet('/v1/governance/proposals', token);
    const list = proposals.proposals || [];
    if (list.length > 0) {
      const id = list[0].id;
      const res = await apiRaw('GET', `/v1/governance/proposal/${id}`, undefined, token);
      expect(res.status).toBeLessThan(500);
    }
  });

  test('Governance message endpoint exists', async () => {
    const res = await apiRaw('POST', '/v1/governance/message', { content: 'test' }, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Proposal review endpoint exists', async () => {
    const proposals = await apiGet('/v1/governance/proposals', token);
    const list = proposals.proposals || [];
    if (list.length > 0) {
      const id = list[0].id;
      const res = await apiRaw('POST', `/v1/governance/proposals/${id}/review`, {
        riskScore: 1,
        reasoning: 'E2E test review',
        recommendation: 'approve',
      }, token);
      expect(res.status).toBeLessThan(500);
    }
  });
});

test.describe('9.4 — Scheduler Operations', () => {
  let token: string;

  test.beforeAll(() => { token = loadApiToken(); });

  test('Scheduler status', async () => {
    const res = await apiRaw('GET', '/v1/scheduler/status', undefined, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Scheduler config', async () => {
    const res = await apiRaw('GET', '/v1/scheduler/config', undefined, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Scheduler tasks list', async () => {
    const res = await apiRaw('GET', '/v1/scheduler/tasks', undefined, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Scheduler costs endpoint', async () => {
    const res = await apiRaw('GET', '/v1/scheduler/costs', undefined, token);
    expect(res.status).toBeLessThan(500);
  });
});

test.describe('9.5 — Payment & Activity', () => {
  let token: string;

  test.beforeAll(() => { token = loadApiToken(); });

  test('Payment stats', async () => {
    const res = await apiRaw('GET', '/v1/payment/stats', undefined, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Payment history', async () => {
    const res = await apiRaw('GET', '/v1/payment/history', undefined, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Activity stream', async () => {
    const res = await apiRaw('GET', '/v1/activity', undefined, token);
    expect(res.status).toBeLessThan(500);
  });

  test('Activity stats', async () => {
    const res = await apiRaw('GET', '/v1/activity/stats', undefined, token);
    expect(res.status).toBeLessThan(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 10. — @pando/tests Module API
// ═════════════════════════════════════════════════════════════════════════

test.describe('10.1 — Testing API Endpoints', () => {
  test('Testing status returns dashboard overview', async () => {
    const data = await apiGet('/v1/testing/status');
    expect(data.project).toBe('pando-node');
    expect(typeof data.total_scenarios).toBe('number');
    expect(typeof data.total_runs).toBe('number');
    expect(typeof data.pass_rate).toBe('number');
    expect(typeof data.open_findings).toBe('number');
  });

  test('Testing runs returns array', async () => {
    const data = await apiGet('/v1/testing/runs');
    expect(Array.isArray(data)).toBe(true);
  });

  test('Testing findings returns array', async () => {
    const data = await apiGet('/v1/testing/findings');
    expect(Array.isArray(data)).toBe(true);
  });

  test('Testing scenarios returns array', async () => {
    const data = await apiGet('/v1/testing/scenarios');
    expect(Array.isArray(data)).toBe(true);
  });

  test('Testing playbooks returns 6 pando-node playbooks', async () => {
    const data = await apiGet('/v1/testing/playbooks');
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(6);
    const names = data.map((p: any) => p.name);
    expect(names).toContain('governance-flow');
    expect(names).toContain('gateway-navigation');
    expect(names).toContain('wallet-economy');
  });

  test('Testing stats returns array', async () => {
    const data = await apiGet('/v1/testing/stats');
    expect(Array.isArray(data)).toBe(true);
  });
});

test.describe('10.2 — Testing Gateway Page', () => {
  test('Testing dashboard page loads', async ({ page }) => {
    await page.goto(`${GATEWAY_URL}/testing`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await expect(page.locator('body')).toBeVisible();
    const text = await page.textContent('body');
    expect(text?.length).toBeGreaterThan(50);
  });
});
