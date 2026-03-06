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
const NODE_API_URL = 'http://127.0.0.1:4100';

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
  const guestRes = await fetch(`${NODE_API_URL}/v1/auth/guest`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const guestData = await guestRes.json() as any;
  userJwt = guestData.token;
  expect(userJwt).toBeTruthy();
});

test('Full chat round-trip: send message → get AI response → verify in thread history', async ({ page }) => {
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

  // ── Step 2: Verify the thread was stored ──
  const historyRes = await fetch(`${NODE_API_URL}/v1/chat/history`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-User-Token': userJwt,
    },
  });
  const historyData = await historyRes.json() as any;

  // Should have messages in the history
  expect(historyData.messages).toBeTruthy();
  expect(historyData.messages.length).toBeGreaterThanOrEqual(2); // user + assistant

  // Find our messages
  const userMsg = historyData.messages.find((m: any) => m.role === 'user' && m.content.includes('What is Pando'));
  const assistantMsg = historyData.messages.find((m: any) => m.role === 'assistant');
  expect(userMsg).toBeTruthy();
  expect(assistantMsg).toBeTruthy();
  expect(assistantMsg.content.length).toBeGreaterThan(10);

  // ── Step 3: Verify via gateway browser (the real user path) ──
  await page.goto(`${GATEWAY_URL}/chat`);
  await page.waitForLoadState('networkidle');

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
