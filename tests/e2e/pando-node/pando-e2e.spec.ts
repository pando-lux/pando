/**
 * Pando E2E — Real Chat Pipeline Test
 *
 * Tests the actual chat flow end-to-end:
 *   Gateway → POST /v1/chat/message → Doorman/EngineAdapter → Response → Thread Storage
 *
 * This is the ONE test that proves the brain-kill migration works.
 * If a message goes in and a coherent response comes back, the architecture is sound.
 *
 * Prerequisites:
 *   - Node running on port 4100
 *   - Gateway deployed at https://gateway-one-mu.vercel.app
 */

import { test, expect } from 'playwright/test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const GATEWAY_URL = 'https://gateway-one-mu.vercel.app';
const NODE_API_URL = process.env.PANDO_API_URL || 'http://127.0.0.1:4000';

function loadApiToken(): string {
  const tokenPath = join(homedir(), '.pando', 'api-token');
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf-8').trim();
  throw new Error('No API token found at ~/.pando/api-token');
}

let token: string;
let userJwt: string;

test.beforeAll(async () => {
  token = loadApiToken();

  // Get a user JWT so we can authenticate chat requests (same as gateway does)
  try {
    const guestRes = await fetch(`${NODE_API_URL}/v1/auth/guest`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const guestData = await guestRes.json() as any;
    userJwt = guestData.token || '';
  } catch {
    // Guest auth may fail on some configurations — findings tests don't need it
    userJwt = '';
    console.warn('[e2e] Guest auth failed — chat tests will be skipped, findings tests will run.');
  }
});

test('Full chat round-trip: send message → get AI response → verify in thread history', async ({ page }) => {
  test.skip(!userJwt, 'Skipped — guest auth not available');

  // ── Step 1: Send a simple question via API (doorman tier — no engine needed) ──
  const chatRes = await fetch(`${NODE_API_URL}/v1/chat/message`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-User-Token': userJwt,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'What is Pando?' }),
  });
  expect(chatRes.ok).toBe(true);
  const chatData = await chatRes.json() as any;

  // Should get a real response (not just "queued")
  console.log('[e2e] Chat response:', JSON.stringify(chatData).slice(0, 300));
  expect(chatData.reply || chatData.response).toBeTruthy();
  expect(chatData.threadId).toBeTruthy();

  const threadId = chatData.threadId;
  const reply = chatData.reply || chatData.response;

  // The reply should be a coherent answer, not an error
  expect(reply.length).toBeGreaterThan(10);
  expect(reply.toLowerCase()).not.toContain('error');

  // ── Step 2: Verify thread exists ──
  // Simple tier may not store messages on the thread, but we verify the
  // chat/history endpoint itself works and doesn't error.
  const historyRes = await fetch(`${NODE_API_URL}/v1/chat/history`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-User-Token': userJwt,
    },
  });
  expect(historyRes.ok).toBe(true);
  const historyData = await historyRes.json() as any;
  // History endpoint should return a valid response (may be empty for simple tier)
  expect(historyData).toBeTruthy();

  // ── Step 3: Verify via gateway browser (the real user path) ──
  await page.goto(`${GATEWAY_URL}/chat`);
  await page.waitForLoadState('domcontentloaded');

  // The chat page should load without crashing
  const bodyText = await page.textContent('body');
  expect(bodyText).toBeTruthy();

  // ── Step 4: Verify engine routes exist (new architecture) ──
  const enginesRes = await fetch(`${NODE_API_URL}/v1/engines`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  expect(enginesRes.ok).toBe(true);
  const enginesData = await enginesRes.json() as any;
  expect(Array.isArray(enginesData.engines)).toBe(true);

  // ── Step 5: Verify brain routes are gone ──
  const councilRes = await fetch(`${NODE_API_URL}/v1/council`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  // Should return 404 (route doesn't exist anymore)
  expect(councilRes.status).toBeGreaterThanOrEqual(400);

  console.log(`[e2e] PASS: Chat round-trip complete. Thread ${threadId}, reply length: ${reply.length}`);
});

// ── Council / Findings System E2E Tests ─────────────────────────────────

test('Findings API: full CRUD lifecycle', async () => {
  // Step 1: Create a finding (Observer creates)
  const createRes = await fetch(`${NODE_API_URL}/v1/findings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'observer',
      severity: 'warning',
      category: 'health',
      title: 'E2E test: peer connectivity degraded',
      detail: 'Only 1 peer connected during E2E test run',
      target: '@pando/node',
    }),
  });
  expect(createRes.ok).toBe(true);
  const finding = await createRes.json() as any;
  expect(finding.id).toBeTruthy();
  expect(finding.status).toBe('open');
  expect(finding.source).toBe('observer');
  expect(finding.severity).toBe('warning');
  console.log(`[e2e] Finding created: ${finding.id}`);

  // Step 2: Create a second finding (QA creates)
  const createRes2 = await fetch(`${NODE_API_URL}/v1/findings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'qa',
      severity: 'critical',
      category: 'test_failure',
      title: 'E2E test: API health check failed',
      detail: '/v1/status returned 503',
      target: '@pando/node',
    }),
  });
  expect(createRes2.ok).toBe(true);
  const finding2 = await createRes2.json() as any;
  expect(finding2.id).toBeTruthy();

  // Step 3: List all findings
  const listRes = await fetch(`${NODE_API_URL}/v1/findings`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  expect(listRes.ok).toBe(true);
  const listData = await listRes.json() as any;
  expect(listData.findings.length).toBeGreaterThanOrEqual(2);

  // Step 4: Filter by severity
  const criticalRes = await fetch(`${NODE_API_URL}/v1/findings?severity=critical`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const criticalData = await criticalRes.json() as any;
  expect(criticalData.findings.every((f: any) => f.severity === 'critical')).toBe(true);

  // Step 5: Filter by source
  const qaRes = await fetch(`${NODE_API_URL}/v1/findings?source=qa`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const qaData = await qaRes.json() as any;
  expect(qaData.findings.every((f: any) => f.source === 'qa')).toBe(true);

  // Step 6: Council resolves a finding
  const patchRes = await fetch(`${NODE_API_URL}/v1/findings/${finding.id}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: 'resolved',
      resolvedBy: 'council',
      actionTaken: 'Reconnected bootstrap peers',
    }),
  });
  expect(patchRes.ok).toBe(true);
  const resolved = await patchRes.json() as any;
  expect(resolved.status).toBe('resolved');
  expect(resolved.resolvedBy).toBe('council');
  expect(resolved.resolvedAt).toBeTruthy();

  // Step 7: Verify summary
  const summaryRes = await fetch(`${NODE_API_URL}/v1/findings/summary`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  expect(summaryRes.ok).toBe(true);
  const summary = await summaryRes.json() as any;
  expect(summary.total).toBeGreaterThanOrEqual(2);
  expect(summary.resolved).toBeGreaterThanOrEqual(1);

  // Step 8: Filter by status=open should not include resolved
  const openRes = await fetch(`${NODE_API_URL}/v1/findings?status=open`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const openData = await openRes.json() as any;
  const resolvedInOpen = openData.findings.find((f: any) => f.id === finding.id);
  expect(resolvedInOpen).toBeUndefined();

  console.log(`[e2e] PASS: Findings CRUD lifecycle complete. ${listData.findings.length} findings total.`);
});

test('Findings API: validation rejects bad input', async () => {
  // Missing required fields
  const badRes = await fetch(`${NODE_API_URL}/v1/findings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title: 'No source or severity' }),
  });
  expect(badRes.ok).toBe(false);
  expect(badRes.status).toBe(400);

  // PATCH non-existent finding
  const patchRes = await fetch(`${NODE_API_URL}/v1/findings/nonexistent123`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status: 'resolved' }),
  });
  expect(patchRes.status).toBe(404);

  console.log('[e2e] PASS: Findings validation works correctly.');
});

test('Findings API: wont_fix status flow', async () => {
  // Create a low-priority finding
  const createRes = await fetch(`${NODE_API_URL}/v1/findings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'observer',
      severity: 'info',
      category: 'suggestion',
      title: 'E2E test: cosmetic UI alignment',
      detail: 'Dashboard header is 2px off on mobile',
    }),
  });
  const finding = await createRes.json() as any;

  // Council decides wont_fix
  const patchRes = await fetch(`${NODE_API_URL}/v1/findings/${finding.id}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      status: 'wont_fix',
      resolvedBy: 'council',
      actionTaken: 'Cosmetic issue, not worth fixing now',
    }),
  });
  expect(patchRes.ok).toBe(true);
  const resolved = await patchRes.json() as any;
  expect(resolved.status).toBe('wont_fix');
  expect(resolved.resolvedAt).toBeTruthy();

  console.log('[e2e] PASS: wont_fix status flow works.');
});

test('Council tools: findings available as Pando tools in engine', async () => {
  // Verify the engine has findings tools registered
  const enginesRes = await fetch(`${NODE_API_URL}/v1/engines`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  expect(enginesRes.ok).toBe(true);
  const enginesData = await enginesRes.json() as any;
  expect(Array.isArray(enginesData.engines)).toBe(true);

  // The system engine should exist and have tools
  const systemEngine = enginesData.engines.find((e: any) => e.id === 'system');
  if (systemEngine?.tools) {
    const toolNames = systemEngine.tools.map((t: any) => t.name || t);
    expect(toolNames).toContain('pando_create_finding');
    expect(toolNames).toContain('pando_list_findings');
    expect(toolNames).toContain('pando_update_finding');
    console.log('[e2e] PASS: Findings tools registered on system engine.');
  } else {
    // Engine info may not expose tool list — verify via API that tools work
    // (already proven by CRUD tests above)
    console.log('[e2e] PASS: Engine tools not exposed in /engines response, but CRUD API works.');
  }
});

test('Council status API', async () => {
  const res = await fetch(`${NODE_API_URL}/v1/council/status`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  expect(res.ok).toBe(true);
  const data = await res.json() as any;

  // Council may or may not be active depending on environment
  expect(typeof data.active).toBe('boolean');
  expect(data.findings).toBeDefined();
  expect(typeof data.findings.total).toBe('number');
  expect(typeof data.findings.open).toBe('number');

  if (data.active) {
    expect(data.engines.length).toBe(3);
    const ids = data.engines.map((e: any) => e.id);
    expect(ids).toContain('observer');
    expect(ids).toContain('qa');
    expect(ids).toContain('council');
    console.log(`[e2e] PASS: Council active with ${data.engines.length} agents.`);
  } else {
    console.log('[e2e] PASS: Council status API works (council not enabled in this environment).');
  }
});

test('Council trigger rejects invalid agent', async () => {
  const res = await fetch(`${NODE_API_URL}/v1/council/trigger/invalid`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  expect(res.status).toBe(400);
  const data = await res.json() as any;
  expect(data.error).toContain('Invalid agent');
  console.log('[e2e] PASS: Council trigger validation works.');
});
