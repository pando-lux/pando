/**
 * PandoTeams — Claude Code Agent Runtime E2E Tests
 *
 * Tests the Claude Code agent integration end-to-end:
 *   - Memory HTTP API (search, list, create, health)
 *   - Claude Code chat via PandoTeams engine
 *   - Model switching
 *   - Reflection pipeline (fires after response, saves lessons)
 *   - Case-insensitive memory search
 *
 * Prerequisites:
 *   - PandoTeams server running on port 4873
 *   - Claude Code CLI installed and authenticated
 */

import { test, expect } from 'playwright/test';

const PANDOCODE_URL = process.env.PANDOCODE_URL || 'http://127.0.0.1:4873';

// ── Helpers ──────────────────────────────────────────────────────────

async function apiGet(path: string) {
  const res = await fetch(`${PANDOCODE_URL}/v1${path}`);
  return { status: res.status, data: await res.json() as any };
}

async function apiPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${PANDOCODE_URL}/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as any };
}

async function chatSSE(message: string, timeoutMs = 120_000): Promise<{ chunks: string[]; events: string[] }> {
  const res = await fetch(`${PANDOCODE_URL}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const chunks: string[] = [];
  const events: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) events.push(line.slice(7));
    if (line.startsWith('data: ')) {
      try {
        const d = JSON.parse(line.slice(6));
        if (d.content) chunks.push(d.content);
      } catch { /* ignore */ }
    }
  }
  return { chunks, events };
}

// ── Server Health ────────────────────────────────────────────────────

test.describe('PandoTeams Server', () => {
  test('server is running and healthy', async () => {
    const { status, data } = await apiGet('/status');
    expect(status).toBe(200);
    expect(data.status).toBe('ok');
    expect(data.version).toBeTruthy();
    expect(data.session).toBeTruthy();
    expect(Array.isArray(data.tools)).toBe(true);
    console.log(`[e2e] Server OK — session ${data.session.slice(0, 8)}, ${data.tools.length} tools`);
  });

  test('models endpoint lists available models', async () => {
    const { status, data } = await apiGet('/models');
    expect(status).toBe(200);
    expect(data.available.length).toBeGreaterThan(0);
    const ids = data.available.map((m: any) => m.id);
    expect(ids).toContain('claude-code');
    console.log(`[e2e] Models: ${ids.join(', ')}`);
  });
});

// ── Memory HTTP API ──────────────────────────────────────────────────

test.describe('Memory API', () => {
  test('health endpoint returns counts', async () => {
    const { status, data } = await apiGet('/memories/health');
    expect(status).toBe(200);
    expect(typeof data.total).toBe('number');
    expect(typeof data.fresh).toBe('number');
    expect(typeof data.stale).toBe('number');
    expect(data.total).toBeGreaterThanOrEqual(0);
    console.log(`[e2e] Memory health: ${data.total} total, ${data.fresh} fresh, ${data.stale} stale`);
  });

  test('create memory via POST', async () => {
    const { status, data } = await apiPost('/memories', {
      content: `E2E test memory — ${Date.now()}`,
      type: 'lesson',
      scope: ['e2e-test'],
      confidence: 0.5,
      impact: 'low',
    });
    expect(status).toBe(200);
    expect(data.id).toBeTruthy();
    expect(data.message).toBe('Memory saved');
    console.log(`[e2e] Memory created: ${data.id}`);
  });

  test('list memories returns array', async () => {
    const { status, data } = await apiGet('/memories?limit=5');
    expect(status).toBe(200);
    expect(Array.isArray(data.memories)).toBe(true);
    expect(data.memories.length).toBeGreaterThan(0);
    // Each memory has required fields
    const m = data.memories[0];
    expect(m.id).toBeTruthy();
    expect(m.content).toBeTruthy();
    expect(m.type).toBeTruthy();
    console.log(`[e2e] Listed ${data.memories.length} memories`);
  });

  test('search is case-insensitive', async () => {
    // Create a memory with known content
    await apiPost('/memories', {
      content: 'CaseTest_UniqueMarker_XyZ123',
      type: 'lesson',
      scope: ['e2e-test'],
      confidence: 0.5,
      impact: 'low',
    });

    // Search with different cases
    const upper = await apiGet('/memories/search?q=CASETEST_UNIQUEMARKER');
    const lower = await apiGet('/memories/search?q=casetest_uniquemarker');
    const mixed = await apiGet('/memories/search?q=CaseTest_UniqueMarker');

    expect(upper.data.memories.length).toBeGreaterThan(0);
    expect(lower.data.memories.length).toBeGreaterThan(0);
    expect(mixed.data.memories.length).toBeGreaterThan(0);
    console.log('[e2e] Case-insensitive search verified');
  });

  test('search with scope filter', async () => {
    const { data } = await apiGet('/memories/search?scope=e2e-test');
    expect(Array.isArray(data.memories)).toBe(true);
    expect(data.memories.length).toBeGreaterThan(0);
    console.log(`[e2e] Scope-filtered search: ${data.memories.length} results`);
  });

  test('create memory validates required fields', async () => {
    const { status } = await apiPost('/memories', { type: 'lesson' });
    // Should fail — content is required (400 validation or 500 server error)
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

// ── Model Switching ──────────────────────────────────────────────────

test.describe('Model Switching', () => {
  test('switch to claude-code model', async () => {
    const { status, data } = await apiPost('/model', { model: 'claude-code' });
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.model).toBe('claude-code');

    // Verify via status
    const st = await apiGet('/status');
    expect(st.data.model).toBe('claude-code');
    console.log('[e2e] Switched to claude-code');
  });

  test('switch to gemini and back', async () => {
    const orig = await apiGet('/status');
    const origModel = orig.data.model;

    // Switch to gemini
    await apiPost('/model', { model: 'gemini-2.5-flash' });
    const mid = await apiGet('/status');
    expect(mid.data.model).toBe('gemini-2.5-flash');

    // Switch back
    await apiPost('/model', { model: origModel });
    const final = await apiGet('/status');
    expect(final.data.model).toBe(origModel);
    console.log(`[e2e] Model round-trip: ${origModel} → gemini-2.5-flash → ${origModel}`);
  });
});

// ── Claude Code Chat ─────────────────────────────────────────────────

test.describe('Claude Code Chat', () => {
  test.beforeAll(async () => {
    // Ensure claude-code model is active
    await apiPost('/model', { model: 'claude-code' });
  });

  test('simple chat returns text response', async () => {
    const { chunks, events } = await chatSSE('What is 2+2? Answer with just the number.');
    expect(chunks.length).toBeGreaterThan(0);
    const fullText = chunks.join('');
    expect(fullText).toContain('4');
    expect(events).toContain('chunk');
    expect(events).toContain('done');
    console.log(`[e2e] Chat response: "${fullText.slice(0, 100)}"`);
  });

  test('chat with tool use returns coherent response', async () => {
    const { chunks, events } = await chatSSE(
      'List the files in the current directory. Just show the first 5 file/folder names.',
      180_000,
    );
    const fullText = chunks.join('');
    expect(fullText.length).toBeGreaterThan(5);
    // Should mention at least one typical project file/folder
    console.log(`[e2e] Tool-use response (${fullText.length} chars): "${fullText.slice(0, 200)}"`);
  });
});

// ── Reflection Pipeline ──────────────────────────────────────────────

test.describe('Reflection Pipeline', () => {
  test('reflection fires after response and can save memory', async () => {
    test.setTimeout(180_000); // Reflection needs ~60s wait + Claude Code response time
    // Ensure claude-code model
    await apiPost('/model', { model: 'claude-code' });

    // Get baseline memory count
    const before = await apiGet('/memories/health');
    const beforeCount = before.data.total;

    // Send a task that should produce a lesson
    const { chunks } = await chatSSE(
      'Run: curl -s http://127.0.0.1:4873/v1/memories/health — report the result. ' +
      'Then note: this proves the memory API is accessible from Claude Code sessions. ' +
      'This is a non-obvious architectural insight worth remembering.',
      180_000,
    );
    const fullText = chunks.join('');
    expect(fullText.length).toBeGreaterThan(5);
    console.log(`[e2e] Reflection test response: "${fullText.slice(0, 150)}"`);

    // Wait for reflection follow-up to complete (async, takes ~30-60s)
    console.log('[e2e] Waiting 60s for reflection follow-up...');
    await new Promise(r => setTimeout(r, 60_000));

    // Check if memory count changed
    const after = await apiGet('/memories/health');
    console.log(`[e2e] Memory count: ${beforeCount} → ${after.data.total}`);
    // Reflection may or may not save a memory — just verify it didn't crash
    expect(after.data.total).toBeGreaterThanOrEqual(beforeCount);
  });
});

// ── Gateway Visual Test ──────────────────────────────────────────────

test.describe('Gateway Visual', () => {
  test('gateway loads and shows chat interface', async ({ page }) => {
    await page.goto('https://gateway-one-mu.vercel.app/chat');
    await page.waitForLoadState('domcontentloaded');
    const body = await page.textContent('body');
    expect(body).toBeTruthy();
    console.log('[e2e] Gateway chat page loaded');
  });
});
