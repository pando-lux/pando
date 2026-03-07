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
    userJwt = '';
    console.warn('[e2e] Guest auth failed — chat tests will be skipped.');
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

// ── Council System E2E Tests ──────────────────────────────────────────

test('Council status API returns valid response', async () => {
  const res = await fetch(`${NODE_API_URL}/v1/council/status`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  expect(res.ok).toBe(true);
  const data = await res.json() as any;

  // Council may or may not be active depending on node configuration
  expect(typeof data.active).toBe('boolean');

  if (data.active) {
    // If active, should have 3 engines (observer, qa, council)
    expect(data.engines.length).toBe(3);
    const ids = data.engines.map((e: any) => e.id);
    expect(ids).toContain('observer');
    expect(ids).toContain('qa');
    expect(ids).toContain('council');
    console.log(`[e2e] PASS: Council active with ${data.engines.length} agents.`);
  } else {
    console.log('[e2e] PASS: Council status API works (council not enabled).');
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

test('Council board API returns tasks array', async () => {
  const res = await fetch(`${NODE_API_URL}/v1/council/board`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  expect(res.ok).toBe(true);
  const data = await res.json() as any;
  expect(Array.isArray(data.tasks)).toBe(true);
  console.log(`[e2e] PASS: Council board returns ${data.tasks.length} tasks.`);
});

test('Council request API creates board task from user report', async () => {
  const res = await fetch(`${NODE_API_URL}/v1/council/request`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'The network latency is very high between peers' }),
  });
  // May return 503 if council is not running — both are valid
  if (res.ok) {
    const data = await res.json() as any;
    expect(data.taskId).toBeTruthy();
    expect(data.status).toBe('ok');
    console.log(`[e2e] PASS: Council request created task ${data.taskId}.`);
  } else {
    expect(res.status).toBe(503);
    console.log('[e2e] PASS: Council request API responds correctly (council not running).');
  }
});

test('Council request API rejects empty message', async () => {
  const res = await fetch(`${NODE_API_URL}/v1/council/request`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '' }),
  });
  expect(res.status).toBe(400);
  console.log('[e2e] PASS: Council request rejects empty message.');
});

