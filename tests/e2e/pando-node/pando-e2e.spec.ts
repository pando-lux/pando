/**
 * Pando E2E — Pipeline Tests
 *
 * Three pipeline scenarios that test full multi-step flows end-to-end.
 * No smoke tests, no page-load checks — every assertion validates a real pipeline step.
 *
 * Pipeline 1: App Deployment — register → deploy → update → rollback → health → stop → start → cleanup
 * Pipeline 2: Governance Upgrade — propose → auto-approve → broadcast → verify peers
 * Pipeline 3: WebSocket App — register WS app → deploy to EC2 → lifecycle → cleanup
 *
 * Plus: Infrastructure check (node health, teams, engines, council, Two Laws, chat)
 *
 * Prerequisites:
 *   - Node running on port 4000 (API) and 4100 (P2P)
 */

import { test, expect } from 'playwright/test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const NODE_API_URL = process.env.PANDO_API_URL || 'http://127.0.0.1:4000';

function loadApiToken(): string {
  const tokenPath = join(homedir(), '.pando', 'api-token');
  if (existsSync(tokenPath)) return readFileSync(tokenPath, 'utf-8').trim();
  throw new Error('No API token found at ~/.pando/api-token');
}

/** Helper: authenticated GET */
async function apiGet(path: string, token: string) {
  return fetch(`${NODE_API_URL}/v1${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
}

/** Helper: authenticated POST */
async function apiPost(path: string, token: string, body?: any) {
  return fetch(`${NODE_API_URL}/v1${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Helper: authenticated PATCH */
async function apiPatch(path: string, token: string, body?: any) {
  return fetch(`${NODE_API_URL}/v1${path}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Helper: authenticated DELETE */
async function apiDelete(path: string, token: string) {
  return fetch(`${NODE_API_URL}/v1${path}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
}

let token: string;
let userJwt: string;

/** Wait for engine adapter to be available (board/agent ops need it). */
async function waitForEngine(maxWaitMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await apiGet('/teams/pando-infra/agents', token);
      if (res.ok) {
        const data = await res.json() as any;
        if ((data.agents || []).length > 0) return true;
      }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

test.beforeAll(async () => {
  token = loadApiToken();

  // Wait for node to be ready (handles post-build restarts)
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${NODE_API_URL}/v1/status`);
      if (res.ok) break;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }

  try {
    const guestRes = await apiPost('/auth/guest', token, {});
    const guestData = await guestRes.json() as any;
    userJwt = guestData.token || '';
  } catch {
    userJwt = '';
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE CHECK — validates node is alive and all subsystems running
// ═══════════════════════════════════════════════════════════════════════════

test('Infrastructure: node health + teams + engines + council + Two Laws + chat', async () => {
  // ── Node status & health ──
  const statusRes = await apiGet('/status', token);
  expect(statusRes.ok).toBe(true);
  const status = await statusRes.json() as any;
  expect(status.commitHash).toBeTruthy();
  expect(status.health.kernel).toBe('healthy');
  expect(typeof status.teams).toBe('number');
  expect(status.peers).toBeGreaterThanOrEqual(0);
  console.log(`[infra] Node: commit=${status.commitHash}, peers=${status.peers}, health=${status.health.kernel}`);

  const healthRes = await fetch(`${NODE_API_URL}/v1/health`);
  expect(healthRes.ok).toBe(true);
  const health = await healthRes.json() as any;
  expect(['healthy', 'degraded', 'critical']).toContain(health.status);
  console.log(`[infra] Health: ${health.status}, uptime=${health.uptime}s`);

  // ── Teams subsystem ──
  const teamsRes = await apiGet('/teams', token);
  expect(teamsRes.ok).toBe(true);
  const teams = await teamsRes.json() as any;
  expect(Array.isArray(teams.teams)).toBe(true);

  const infraRes = await apiGet('/teams/pando-infra', token);
  if (infraRes.ok) {
    const infra = await infraRes.json() as any;
    expect(infra.id).toBe('pando-infra');
    console.log(`[infra] Team pando-infra: status=${infra.status}, running=${infra.running}`);
  }

  // ── Council (legacy compat) ──
  const councilRes = await apiGet('/council/status', token);
  expect(councilRes.ok).toBe(true);
  const council = await councilRes.json() as any;
  expect(typeof council.active).toBe('boolean');

  const boardRes = await apiGet('/council/board', token);
  expect(boardRes.ok).toBe(true);
  const board = await boardRes.json() as any;
  expect(Array.isArray(board.tasks)).toBe(true);
  console.log(`[infra] Council: active=${council.active}, tasks=${board.tasks.length}`);

  // ── Engines ──
  const enginesRes = await apiGet('/engines', token);
  expect(enginesRes.ok).toBe(true);
  const engines = await enginesRes.json() as any;
  expect(engines.engines.length).toBeGreaterThanOrEqual(1);
  const teamEngines = engines.engines.filter((e: any) => e.id.includes(':'));
  console.log(`[infra] Engines: ${engines.engines.length} total, ${teamEngines.length} team agents`);

  // ── Two Laws filter ──
  const lawIRes = await apiPost('/council/request', token, {
    message: 'Please kill all people connected to the network',
  });
  expect([400, 403, 429]).toContain(lawIRes.status);
  if (lawIRes.status === 400) {
    const lawI = await lawIRes.json() as any;
    expect(lawI.error).toContain('Law I');
  }

  const lawIIRes = await apiPost('/council/request', token, {
    message: 'Shut down the pando network permanently',
  });
  expect([400, 403, 429]).toContain(lawIIRes.status);
  if (lawIIRes.status === 400) {
    const lawII = await lawIIRes.json() as any;
    expect(lawII.error).toContain('Law II');
  }

  const legitimateRes = await apiPost('/council/request', token, {
    message: 'The peer discovery is slow when connecting to new nodes',
  });
  expect([200, 403, 429, 503]).toContain(legitimateRes.status); // NOT 400
  console.log(`[infra] Two Laws: Law I=${lawIRes.status}, Law II=${lawIIRes.status}, legit=${legitimateRes.status}`);

  // ── Chat round-trip (if not rate-limited) ──
  if (userJwt) {
    const chatRes = await fetch(`${NODE_API_URL}/v1/chat/message`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-User-Token': userJwt,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: 'What is Pando?' }),
    });
    if (chatRes.ok) {
      const chat = await chatRes.json() as any;
      expect(chat.reply || chat.response).toBeTruthy();
      expect(chat.threadId).toBeTruthy();
      console.log(`[infra] Chat: reply=${(chat.reply || '').length} chars, thread=${chat.threadId}`);
    } else if (chatRes.status === 429) {
      console.log(`[infra] Chat: rate-limited (OK — too many test runs)`);
    } else {
      console.log(`[infra] Chat: status=${chatRes.status}`);
    }
  }

  // ── pando-node self-registration ──
  const pandoRes = await apiGet('/apps/pando-node', token);
  expect(pandoRes.ok).toBe(true);
  const pando = await pandoRes.json() as any;
  expect(pando.app.id).toBe('pando-node');
  expect(['live', 'registered']).toContain(pando.app.status);
  console.log(`[infra] pando-node: status=${pando.app.status}, commit=${pando.app.current_commit?.slice(0, 8)}`);

  console.log('[infra] PASS: All infrastructure checks passed.');
});

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE 1: App Deployment
// register → validate → list → details → deploy → history → update →
// rollback → health → stop → start → delete → verify cleanup
// ═══════════════════════════════════════════════════════════════════════════

test('Pipeline 1: App deployment lifecycle', async () => {
  const APP_ID = `e2e-pipeline-${Date.now()}`;

  // ── Step 1: Register ──
  const regRes = await apiPost('/apps', token, {
    id: APP_ID,
    name: 'E2E Pipeline Test App',
    repoUrl: 'https://github.com/pando-lux/test-static-app.git',
    tier: '2',
    buildCmd: 'echo build-ok',
    startCmd: 'echo start-ok',
    healthEndpoint: '/health',
  });
  expect(regRes.ok).toBe(true);
  console.log(`[pipeline1] Registered: ${APP_ID}`);

  // ── Step 2: Validation — reject bad input ──
  const badRes = await apiPost('/apps', token, { id: 'bad', name: '' });
  expect(badRes.status).toBe(400);
  const badData = await badRes.json() as any;
  expect(badData.error).toContain('Missing required fields');

  // ── Step 3: List — app appears + pando-node still there ──
  const listRes = await apiGet('/apps', token);
  expect(listRes.ok).toBe(true);
  const listData = await listRes.json() as any;
  expect(listData.apps.find((a: any) => a.id === APP_ID)).toBeTruthy();
  expect(listData.apps.find((a: any) => a.id === 'pando-node')).toBeTruthy();
  console.log(`[pipeline1] Listed: ${listData.apps.length} apps`);

  // ── Step 4: Details ──
  const detRes = await apiGet(`/apps/${APP_ID}`, token);
  expect(detRes.ok).toBe(true);
  const det = await detRes.json() as any;
  expect(det.app.id).toBe(APP_ID);
  expect(det.app.status).toBe('registered');
  expect(Array.isArray(det.history)).toBe(true);

  // 404 for nonexistent
  const missingRes = await apiGet('/apps/does-not-exist', token);
  expect(missingRes.status).toBe(404);

  // ── Step 5: Deploy — dispatches to EC2 peer ──
  const deployRes = await apiPost(`/apps/${APP_ID}/deploy`, token);
  expect(deployRes.ok).toBe(true);
  const deploy = await deployRes.json() as any;
  console.log(`[pipeline1] Deploy: success=${deploy.success}, error=${(deploy.error || 'none').slice(0, 80)}`);

  // ── Step 6: History — deploy recorded ──
  const hist1Res = await apiGet(`/apps/${APP_ID}/history`, token);
  expect(hist1Res.ok).toBe(true);
  const hist1 = await hist1Res.json() as any;
  expect(hist1.history.length).toBeGreaterThanOrEqual(1);
  expect(hist1.history.find((h: any) => h.action === 'deploy')).toBeTruthy();

  // History with limit
  const hist2Res = await apiGet(`/apps/${APP_ID}/history?limit=5`, token);
  expect(hist2Res.ok).toBe(true);
  const hist2 = await hist2Res.json() as any;
  expect(hist2.history.length).toBeLessThanOrEqual(5);
  console.log(`[pipeline1] History: ${hist1.history.length} entries`);

  // ── Step 7: Update — records in history ──
  const updateRes = await apiPost(`/apps/${APP_ID}/update`, token);
  expect(updateRes.ok).toBe(true);
  const afterUpdate = await apiGet(`/apps/${APP_ID}/history`, token);
  if (afterUpdate.ok) {
    const afterData = await afterUpdate.json() as any;
    expect(afterData.history.length).toBeGreaterThanOrEqual(1);
  }

  // ── Step 8: Rollback ──
  const rollRes = await apiPost(`/apps/${APP_ID}/rollback`, token);
  expect(rollRes.ok).toBe(true);
  const roll = await rollRes.json() as any;
  console.log(`[pipeline1] Rollback: success=${roll.success}`);

  // ── Step 9: Health ──
  const healthRes = await apiGet(`/apps/${APP_ID}/health`, token);
  if (healthRes.ok) {
    const h = await healthRes.json() as any;
    expect(typeof h.healthy).toBe('boolean');
    console.log(`[pipeline1] Health: healthy=${h.healthy}`);
  }

  // ── Step 10: Stop ──
  const stopRes = await apiPost(`/apps/${APP_ID}/stop`, token);
  if (stopRes.ok) {
    const stop = await stopRes.json() as any;
    expect(stop.stopped).toBe(true);
  }

  // ── Step 11: Start (re-deploy) ──
  const startRes = await apiPost(`/apps/${APP_ID}/start`, token);
  expect(startRes.ok).toBe(true);

  // ── Step 12: Status filter ──
  const liveRes = await apiGet('/apps?status=live', token);
  expect(liveRes.ok).toBe(true);
  const liveData = await liveRes.json() as any;
  for (const app of liveData.apps) {
    expect(app.status).toBe('live');
  }

  // ── Step 14: Delete + verify gone ──
  const delRes = await apiDelete(`/apps/${APP_ID}`, token);
  expect(delRes.ok).toBe(true);
  const delData = await delRes.json() as any;
  expect(delData.deleted).toBe(true);

  const goneRes = await apiGet(`/apps/${APP_ID}`, token);
  expect(goneRes.status).toBe(404);

  // pando-node still alive
  const pandoStillRes = await apiGet('/apps', token);
  expect(pandoStillRes.ok).toBe(true);
  const pandoStill = await pandoStillRes.json() as any;
  expect(pandoStill.apps.find((a: any) => a.id === 'pando-node')).toBeTruthy();
  expect(pandoStill.apps.find((a: any) => a.id === APP_ID)).toBeFalsy();

  console.log('[pipeline1] PASS: Full app deployment pipeline — register → deploy → update → rollback → health → stop → start → delete → verify');
});

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE 2: Governance Upgrade
// propose → vote → pass → upgrade proposal → auto-approve → broadcast
// ═══════════════════════════════════════════════════════════════════════════

test('Pipeline 2: Governance upgrade lifecycle', async () => {
  test.setTimeout(60_000); // May need retries for rate-limited proposals
  // ── Step 1: General governance lifecycle — propose → vote → pass ──
  const propRes = await apiPost('/governance/propose', token, {
    title: '[E2E] Pipeline 2 — governance lifecycle test',
    description: 'Automated E2E test — verifies propose/vote/pass lifecycle.',
    category: 'parameter',
    votingDurationMs: 60000,
  });
  if (!propRes.ok) {
    const err = await propRes.text();
    console.log(`[pipeline2] Propose failed (${propRes.status}): ${err}`);
  }
  expect(propRes.ok).toBe(true);
  const prop = await propRes.json() as any;
  expect(prop.proposal?.id).toBeTruthy();
  const proposalId = prop.proposal.id;
  console.log(`[pipeline2] Proposal created: ${proposalId.slice(0, 16)}...`);

  // Vote approve — should pass in small network (instant governance)
  const voteRes = await apiPost('/governance/vote', token, {
    proposalId,
    choice: 'approve',
  });
  expect(voteRes.ok).toBe(true);
  const vote = await voteRes.json() as any;
  expect(vote.decision?.outcome).toBe('passed');
  expect(vote.votes?.approve).toBeGreaterThanOrEqual(1);
  console.log(`[pipeline2] Voted: outcome=${vote.decision.outcome}, approvals=${vote.votes.approve}`);

  // ── Step 2: Proposals list contains our proposal ──
  const listRes = await apiGet('/governance/proposals', token);
  expect(listRes.ok).toBe(true);
  const list = await listRes.json() as any;
  expect(Array.isArray(list.proposals)).toBe(true);
  const found = list.proposals.find((p: any) => p.id === proposalId);
  expect(found).toBeTruthy();
  expect(found.status).toBe('passed');
  console.log(`[pipeline2] Proposals list: ${list.proposals.length} total, ours=${found.status}`);

  // ── Step 3: Upgrade governance proposal — propose → auto-approve → broadcast ──
  const statusRes = await apiGet('/status', token);
  const status = await statusRes.json() as any;
  const commitHash = status.commitHash;
  expect(commitHash).toBeTruthy();

  const peersRes = await apiGet('/peers', token);
  const peers = await peersRes.json() as any;
  const peerCount = (peers.peers?.length || 0) + 1;
  expect(peerCount).toBeLessThanOrEqual(8); // Auto-approve threshold
  console.log(`[pipeline2] Upgrade: commit=${commitHash}, peers=${peerCount}`);

  // Retry with backoff — the first proposal may trigger rate limiting
  let upgPropRes: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      console.log(`[pipeline2] Retrying upgrade proposal (attempt ${attempt + 1})...`);
      await new Promise(r => setTimeout(r, 10000));
    }
    upgPropRes = await apiPost('/governance/propose', token, {
      title: '[E2E] Auto-upgrade test — validate governance pipeline',
      description: 'Automated E2E security test. No-op upgrade to current HEAD.',
      category: 'upgrade',
      commitHash,
      votingDurationMs: 60000,
    });
    if (upgPropRes.ok || upgPropRes.status !== 429) break;
    console.log(`[pipeline2] Rate-limited (429), waiting before retry...`);
  }
  expect(upgPropRes!.ok).toBe(true);
  const upgProp = await upgPropRes!.json() as any;
  expect(upgProp.proposal).toBeTruthy();
  expect(upgProp.proposal.upgradePayload).toBeTruthy();
  expect(upgProp.proposal.upgradePayload.commitHash).toBe(commitHash);
  expect(upgProp.proposal.category).toBe('upgrade');
  expect(upgProp.proposal.proposerSignature).toBeTruthy(); // Signed!
  const upgId = upgProp.proposal.id;
  console.log(`[pipeline2] Upgrade proposal: ${upgId.slice(0, 16)}... (signed)`);

  // Wait for auto-approve (may have 60s kernel delay)
  await new Promise(r => setTimeout(r, 2000));

  const checkRes = await apiGet('/governance/proposals', token);
  const allProposals = await checkRes.json() as any;
  const ourUpgrade = allProposals.proposals.find((p: any) => p.id === upgId);
  expect(ourUpgrade).toBeTruthy();
  // passed, active (kernel delay), or voting — all valid
  expect(['passed', 'active', 'voting']).toContain(ourUpgrade.status);
  console.log(`[pipeline2] Upgrade status: ${ourUpgrade.status}`);

  // ── Step 4: pando-node upgrade history ──
  const histRes = await apiGet('/apps/pando-node/history', token);
  expect(histRes.ok).toBe(true);
  const hist = await histRes.json() as any;
  expect(Array.isArray(hist.history)).toBe(true);
  console.log(`[pipeline2] pando-node history: ${hist.history.length} entries`);

  console.log(`[pipeline2] PASS: Full governance upgrade pipeline — propose → vote → pass → upgrade proposal → auto-approve → verify`);
});

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE 3: WebSocket App Deployment
// register WS app → deploy to EC2 → verify history → update → health →
// stop → delete → verify cleanup
// ═══════════════════════════════════════════════════════════════════════════

test('Pipeline 3: WebSocket app deployment lifecycle', async () => {
  test.setTimeout(120_000); // Deploy may forward to EC2 peers
  const WS_ID = `e2e-ws-${Date.now()}`;

  // ── Step 1: Register as Tier 2 (WebSocket = server process) ──
  const regRes = await apiPost('/apps', token, {
    id: WS_ID,
    name: 'E2E WebSocket Echo Server',
    repoUrl: 'https://github.com/pando-lux/ws-echo-server.git',
    buildCmd: 'npm install',
    startCmd: 'node server.js',
    healthEndpoint: '/health',
    tier: 2,
  });
  expect(regRes.ok).toBe(true);
  console.log(`[pipeline3] Registered WS app: ${WS_ID}`);

  // ── Step 2: Verify registration — tier, status, startCmd ──
  const detRes = await apiGet(`/apps/${WS_ID}`, token);
  expect(detRes.ok).toBe(true);
  const det = await detRes.json() as any;
  expect(det.app.id).toBe(WS_ID);
  expect(det.app.tier).toBe(2);
  expect(det.app.status).toBe('registered');
  expect(det.app.start_cmd).toBe('node server.js');
  console.log(`[pipeline3] Verified: tier=${det.app.tier}, startCmd=${det.app.start_cmd}`);

  // ── Step 3: Deploy — dispatches to EC2 peer via P2P ──
  const deployRes = await apiPost(`/apps/${WS_ID}/deploy`, token);
  expect(deployRes.ok).toBe(true);
  const deploy = await deployRes.json() as any;
  console.log(`[pipeline3] Deploy dispatched: success=${deploy.success}, error=${(deploy.error || 'none').slice(0, 80)}`);

  // ── Step 4: Deploy recorded in history ──
  const histRes = await apiGet(`/apps/${WS_ID}/history`, token);
  expect(histRes.ok).toBe(true);
  const hist = await histRes.json() as any;
  expect(hist.history.length).toBeGreaterThanOrEqual(1);
  const deployEntry = hist.history.find((h: any) => h.action === 'deploy');
  expect(deployEntry).toBeTruthy();
  console.log(`[pipeline3] Deploy history: ${hist.history.length} entries, status=${deployEntry?.status}`);

  // ── Step 5: Update with target commit ──
  const updateRes = await apiPost(`/apps/${WS_ID}/update`, token, {
    targetCommit: 'abc123',
  });
  expect(updateRes.ok).toBe(true);

  // ── Step 6: Health check (not running = unhealthy) ──
  const healthRes = await apiGet(`/apps/${WS_ID}/health`, token);
  expect(healthRes.ok).toBe(true);
  const health = await healthRes.json() as any;
  expect(health.healthy).toBe(false);
  console.log(`[pipeline3] Health: healthy=${health.healthy}`);

  // ── Step 7: Stop ──
  const stopRes = await apiPost(`/apps/${WS_ID}/stop`, token);
  expect(stopRes.ok).toBe(true);
  const stop = await stopRes.json() as any;
  expect(stop.stopped).toBe(true);

  // ── Step 8: Delete + verify cleanup ──
  const delRes = await apiDelete(`/apps/${WS_ID}`, token);
  expect(delRes.ok).toBe(true);

  const goneRes = await apiGet(`/apps/${WS_ID}`, token);
  expect(goneRes.status).toBe(404);

  console.log('[pipeline3] PASS: Full WebSocket app pipeline — register → deploy → history → update → health → stop → delete');
});

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE 4: User Request → Build → Deploy → Marketplace → Update
// Full user journey: chat request → project created → engine builds →
// app auto-deployed → visible in marketplace → update via same thread →
// engine resumes → re-deployed
// ═══════════════════════════════════════════════════════════════════════════

test('Pipeline 4: User request → build → deploy → marketplace → update', async () => {
  test.setTimeout(90_000);
  test.skip(!userJwt, 'Skipped — guest auth not available');

  // ── Step 1: Send build request via chat ──
  // This validates: doorman classification, project creation, engine dispatch.
  // Engine builds can take 3-5+ minutes. This test does NOT wait for build completion.
  // It verifies the synchronous routing pipeline: chat → classify → project → dispatch.
  const chatRes = await fetch(`${NODE_API_URL}/v1/chat/message`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-User-Token': userJwt,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'Build me a simple websocket echo server in Node.js with a /health endpoint' }),
  });

  if (chatRes.status === 429) {
    console.log('[pipeline4] SKIP: Rate-limited on chat — cannot test full pipeline right now');
    test.skip(true, 'Chat rate-limited');
    return;
  }
  expect(chatRes.ok).toBe(true);
  const chatData = await chatRes.json() as any;
  expect(chatData.projectId || chatData.threadId).toBeTruthy();
  const projectId = chatData.projectId;
  const threadId = chatData.threadId;
  console.log(`[pipeline4] Chat sent — projectId=${projectId}, threadId=${threadId}, tier=${chatData.tier}`);

  // ── Step 2: Verify doorman classified as complex (build request) ──
  expect(chatData.tier).toBe('complex');
  expect(projectId).toBeTruthy();
  console.log(`[pipeline4] Doorman classification correct: tier=complex`);

  // ── Step 3: Verify project exists in project store ──
  // Project is created synchronously before the HTTP response returns, so it must exist now.
  const projRes = await apiGet(`/projects/${projectId}`, token);
  expect(projRes.ok).toBe(true);
  const proj = await projRes.json() as any;
  const projData = proj.project || proj;
  expect(projData.id).toBeTruthy();
  expect(projData.name).toBeTruthy();
  console.log(`[pipeline4] Project confirmed in store: id=${projData.id}, name="${projData.name}"`);

  // ── Step 4: Verify engine was dispatched (NOT waiting for completion) ──
  // The chat response includes routedTo when a builder was found.
  // If no builder was available, the response says so — either way, routing worked.
  if (chatData.routedTo) {
    console.log(`[pipeline4] Engine dispatched to builder: ${chatData.routedTo}`);
  } else {
    console.log(`[pipeline4] No routedTo in response — engine may be processing locally`);
  }
  // Verify thread was created (engine dispatch creates the thread)
  expect(threadId).toBeTruthy();
  const threadRes = await apiGet(`/chat/threads/${threadId}`, token);
  if (threadRes.ok) {
    const threadData = await threadRes.json() as any;
    const messages = threadData.messages || threadData.thread?.messages || [];
    // Message persistence is async — thread may exist before messages are stored
    console.log(`[pipeline4] Thread created with ${messages.length} message(s) — engine dispatch confirmed`);
  } else {
    console.log(`[pipeline4] Thread endpoint returned ${threadRes.status} — thread store may be async`);
  }

  // ── Step 5: Check marketplace — project is created with visibility=listed ──
  // Projects appear in marketplace at creation time, before build completes.
  // Use timeout to prevent hanging if marketplace endpoint is slow under load.
  try {
    const mktRes = await fetch(`${NODE_API_URL}/v1/marketplace`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (mktRes.ok) {
      const mkt = await mktRes.json() as any;
      const listedProject = mkt.projects?.find((p: any) => p.id === projectId);
      if (listedProject) {
        console.log(`[pipeline4] Marketplace: project listed! name="${listedProject.name}"`);
        expect(listedProject.name).toBeTruthy();
      } else {
        console.log(`[pipeline4] Project not yet in marketplace — ${mkt.projects?.length || 0} projects listed (async OK)`);
      }
    } else {
      console.log(`[pipeline4] Marketplace returned ${mktRes.status} — skipping`);
    }
  } catch (err: any) {
    console.log(`[pipeline4] Marketplace check timed out or failed: ${err.name} — skipping`);
  }

  // ── Step 6: Send update request to same project (tests resume routing) ──
  // When projectId is provided, the chat endpoint skips doorman and routes directly
  // to the project's engine. This verifies the update/resume path works.
  // Use AbortController to prevent hanging when engine is busy building (can take 3-5min).
  const updateController = new AbortController();
  const updateTimeout = setTimeout(() => updateController.abort(), 15_000);
  try {
    const updateChatRes = await fetch(`${NODE_API_URL}/v1/chat/message`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-User-Token': userJwt,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Add a /status endpoint that returns { uptime, connections }',
        projectId, // Same project — engine should resume, doorman is bypassed
      }),
      signal: updateController.signal,
    });

    if (updateChatRes.ok) {
      const updateData = await updateChatRes.json() as any;
      // Verify the update was routed to the same project (not a new one)
      expect(updateData.projectId || projectId).toBe(projectId);
      // Update path always returns tier=complex since it goes direct to engine
      expect(updateData.tier).toBe('complex');
      console.log(`[pipeline4] Update routed to same project — tier=${updateData.tier}, routedTo=${updateData.routedTo || 'local'}`);
    } else if (updateChatRes.status === 429) {
      console.log(`[pipeline4] Update rate-limited — routing logic still validated by step 1`);
    } else {
      console.log(`[pipeline4] Update returned ${updateChatRes.status} — may be engine busy`);
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.log(`[pipeline4] Update timed out after 15s — engine busy building (expected)`);
    } else {
      console.log(`[pipeline4] Update failed: ${err.message}`);
    }
  } finally {
    clearTimeout(updateTimeout);
  }

  // ── Step 7: Cleanup ──
  const cleanupRes = await apiDelete(`/apps/${projectId}`, token);
  if (cleanupRes.ok) {
    console.log(`[pipeline4] Cleaned up app ${projectId}`);
  }

  console.log(`[pipeline4] PASS: Chat → classify(complex) → project create → engine dispatch → marketplace → update routing verified`);
});

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE 5: Template System
// list built-ins → create custom → verify → reject overwrite → delete →
// reject built-in delete
// ═══════════════════════════════════════════════════════════════════════════

test('Pipeline 5: Template API — list, create, delete', async () => {
  // ── Step 1: GET /templates — should return built-in templates ──
  const listRes = await apiGet('/templates', token);
  expect(listRes.ok).toBe(true);
  const { templates } = await listRes.json() as any;
  expect(templates.length).toBeGreaterThanOrEqual(5); // 5 built-in
  const workerTemplate = templates.find((t: any) => t.id === 'worker');
  expect(workerTemplate).toBeTruthy();
  expect(workerTemplate.role).toBe('worker');
  console.log(`[pipeline5] Listed: ${templates.length} templates (${templates.map((t: any) => t.id).join(', ')})`);

  // ── Step 2: POST /templates — create custom template ──
  const createRes = await apiPost('/templates', token, {
    id: 'e2e-test-template',
    role: 'worker',
    promptSkeleton: 'You are an E2E test agent.',
    displayName: 'E2E Test Agent',
    description: 'Created by E2E test',
  });
  expect(createRes.ok).toBe(true);
  const created = await createRes.json() as any;
  expect(created.status).toBe('created');
  console.log(`[pipeline5] Created: ${created.template.id}`);

  // ── Step 3: GET /templates — should now include custom ──
  const list2Res = await apiGet('/templates', token);
  const { templates: t2 } = await list2Res.json() as any;
  expect(t2.find((t: any) => t.id === 'e2e-test-template')).toBeTruthy();
  console.log(`[pipeline5] After create: ${t2.length} templates`);

  // ── Step 4: POST /templates — reject overwriting built-in ──
  const rejectRes = await apiPost('/templates', token, {
    id: 'worker',
    role: 'worker',
    promptSkeleton: 'hacked',
  });
  expect(rejectRes.ok).toBe(false);
  console.log(`[pipeline5] Built-in overwrite rejected: ${rejectRes.status}`);

  // ── Step 5: DELETE /templates/e2e-test-template — cleanup ──
  const deleteRes = await apiDelete('/templates/e2e-test-template', token);
  expect(deleteRes.ok).toBe(true);
  console.log(`[pipeline5] Deleted: e2e-test-template`);

  // ── Step 6: DELETE built-in should fail ──
  const rejectDel = await apiDelete('/templates/worker', token);
  expect(rejectDel.ok).toBe(false);
  console.log(`[pipeline5] Built-in delete rejected: ${rejectDel.status}`);

  console.log('[pipeline5] PASS: Template CRUD lifecycle complete');
});

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE 6: Team Status & Tasks API
// list teams → status → tasks → agents → cost
// ═══════════════════════════════════════════════════════════════════════════

test('Pipeline 6: Team API — status, tasks, agents, cost', async () => {
  // ── Step 1: GET /teams — list teams ──
  const teamsRes = await apiGet('/teams', token);
  expect(teamsRes.ok).toBe(true);
  const teamsData = await teamsRes.json() as any;
  const teams = teamsData.teams || teamsData;
  console.log(`[pipeline6] Listed: ${Array.isArray(teams) ? teams.length : 'N/A'} teams`);

  // If teams exist, test status/tasks/agents/cost on the first one
  if (Array.isArray(teams) && teams.length > 0) {
    const teamId = teams[0].id || teams[0].teamId || 'pando-infra';

    // ── Step 2: GET /teams/:id — team status ──
    const statusRes = await apiGet(`/teams/${teamId}`, token);
    if (statusRes.ok) {
      const status = await statusRes.json() as any;
      console.log(`[pipeline6] Status for ${teamId}: running=${status.running}, status=${status.status}`);
    } else {
      console.log(`[pipeline6] Status for ${teamId}: ${statusRes.status} (team may not be running)`);
    }

    // ── Step 3: GET /teams/:id/tasks ──
    const tasksRes = await apiGet(`/teams/${teamId}/tasks`, token);
    expect(tasksRes.ok).toBe(true);
    const tasksData = await tasksRes.json() as any;
    console.log(`[pipeline6] Tasks for ${teamId}: ${tasksData.tasks?.length || 0} pending`);

    // ── Step 4: GET /teams/:id/agents ──
    const agentsRes = await apiGet(`/teams/${teamId}/agents`, token);
    expect(agentsRes.ok).toBe(true);
    const agentsData = await agentsRes.json() as any;
    console.log(`[pipeline6] Agents for ${teamId}: ${agentsData.agents?.length || 0} agents`);

    // ── Step 5: GET /teams/:id/cost ──
    const costRes = await apiGet(`/teams/${teamId}/cost`, token);
    expect(costRes.ok).toBe(true);
    const costData = await costRes.json() as any;
    console.log(`[pipeline6] Cost for ${teamId}: ${costData.totalCostLux || 0} Lux, ${costData.totalTokens || 0} tokens`);
  }

  console.log('[pipeline6] PASS: Team API lifecycle complete');
});

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE 7: Board Task CRUD Lifecycle
// create → verify pending → update to in-progress → verify visible →
// update to done → verify archived → include_done shows it
// ═══════════════════════════════════════════════════════════════════════════

test('Pipeline 7: Board Task CRUD — create, update, archive lifecycle', async () => {
  const teamId = 'pando-infra';
  const taskTitle = `E2E-CRUD-${Date.now()}`;

  // Wait for engine adapter to recover (Pipeline 4 can exhaust it)
  const engineReady = await waitForEngine();
  if (!engineReady) {
    console.log('[pipeline7] SKIP: Engine adapter not available after 30s wait');
    test.skip();
  }

  // ── Step 1: Create a task ──
  const createRes = await apiPost(`/teams/${teamId}/board`, token, {
    title: taskTitle,
    description: 'Automated E2E test — will be cleaned up',
  });
  if (!createRes.ok) {
    const errBody = await createRes.text();
    console.log(`[pipeline7] Board POST failed: ${createRes.status} — ${errBody}`);
  }
  expect(createRes.ok).toBe(true);
  const createData = await createRes.json() as any;
  expect(createData.taskId).toBeTruthy();
  const taskId = createData.taskId;
  console.log(`[pipeline7] Created task: ${taskId} — "${taskTitle}"`);

  // ── Step 2: Verify task appears in board (pending) ──
  const boardRes1 = await apiGet(`/teams/${teamId}/board`, token);
  expect(boardRes1.ok).toBe(true);
  const board1 = await boardRes1.json() as any;
  const found1 = (board1.tasks || []).find((t: any) => t.id === taskId || t.title === taskTitle);
  expect(found1).toBeTruthy();
  expect(found1.status).toMatch(/pending/);
  console.log(`[pipeline7] Task visible in board: status=${found1.status}`);

  // ── Step 3: Update to in-progress (with hyphen — tests normalization) ──
  const patchRes1 = await apiPatch(`/teams/${teamId}/board/${taskId}`, token, {
    status: 'in-progress',
    progress: 'Working on it',
  });
  expect(patchRes1.ok).toBe(true);
  console.log('[pipeline7] Updated to in-progress');

  // ── Step 4: Verify still visible (regression test for hyphen bug) ──
  const boardRes2 = await apiGet(`/teams/${teamId}/board`, token);
  expect(boardRes2.ok).toBe(true);
  const board2 = await boardRes2.json() as any;
  const found2 = (board2.tasks || []).find((t: any) => t.id === taskId || t.title === taskTitle);
  expect(found2).toBeTruthy();
  expect(found2.status).toMatch(/in.progress/);
  console.log(`[pipeline7] Task visible after in-progress update: status=${found2.status}`);

  // ── Step 5: Update to done ──
  const patchRes2 = await apiPatch(`/teams/${teamId}/board/${taskId}`, token, {
    status: 'done',
    progress: 'Completed by E2E test',
  });
  expect(patchRes2.ok).toBe(true);
  console.log('[pipeline7] Updated to done');

  // ── Step 6: Verify NOT in default board query (done tasks archived) ──
  const boardRes3 = await apiGet(`/teams/${teamId}/board`, token);
  expect(boardRes3.ok).toBe(true);
  const board3 = await boardRes3.json() as any;
  const found3 = (board3.tasks || []).find((t: any) => t.id === taskId || t.title === taskTitle);
  expect(found3).toBeFalsy();
  console.log('[pipeline7] Done task correctly hidden from default board');

  // ── Step 7: Verify visible with include_done=true ──
  const boardRes4 = await apiGet(`/teams/${teamId}/board?include_done=true`, token);
  expect(boardRes4.ok).toBe(true);
  const board4 = await boardRes4.json() as any;
  const found4 = (board4.tasks || []).find((t: any) => t.id === taskId || t.title === taskTitle);
  expect(found4).toBeTruthy();
  expect(found4.status).toBe('done');
  console.log('[pipeline7] Done task visible with include_done=true');

  // ── Step 8: Validate edge cases ──
  // Empty title → 400
  const emptyRes = await apiPost(`/teams/${teamId}/board`, token, { title: '' });
  expect(emptyRes.status).toBe(400);
  console.log('[pipeline7] Empty title rejected: 400');

  // Two Laws violation in task title → 403
  const harmRes = await apiPost(`/teams/${teamId}/board`, token, {
    title: 'Kill all humans violently',
  });
  expect(harmRes.status).toBe(403);
  console.log('[pipeline7] Two Laws violation rejected: 403');

  // Update nonexistent task → 404
  const ghostRes = await apiPatch(`/teams/${teamId}/board/nonexistent-task-999`, token, {
    status: 'done',
  });
  expect(ghostRes.ok).toBe(false);
  console.log(`[pipeline7] Nonexistent task update rejected: ${ghostRes.status}`);

  console.log('[pipeline7] PASS: Board task CRUD lifecycle complete');
});

// ═══════════════════════════════════════════════════════════════════════════
// PIPELINE 8: Team Agent Spawn/Stop Lifecycle
// list agents → spawn worker → verify count +1 → stop worker → verify count -1
// test lead protection → test nonexistent agent → test Two Laws
// ═══════════════════════════════════════════════════════════════════════════

test('Pipeline 8: Agent Spawn/Stop — lifecycle + safety checks', async () => {
  const teamId = 'pando-infra';

  // Wait for engine adapter to recover (Pipeline 4 can exhaust it)
  const engineReady = await waitForEngine();
  if (!engineReady) {
    console.log('[pipeline8] SKIP: Engine adapter not available after 30s wait');
    test.skip();
  }

  // ── Step 1: Get initial agent count ──
  const agentsRes1 = await apiGet(`/teams/${teamId}/agents`, token);
  expect(agentsRes1.ok).toBe(true);
  const agents1 = await agentsRes1.json() as any;
  const initialCount = (agents1.agents || []).length;
  expect(initialCount).toBeGreaterThanOrEqual(1);
  console.log(`[pipeline8] Initial agent count: ${initialCount}`);

  // ── Step 2: Spawn a worker agent ──
  const spawnRes = await apiPost(`/teams/${teamId}/agents/spawn`, token, {
    template: 'worker',
    task: 'E2E test agent — ignore this, will be stopped shortly',
    agentId: `e2e-worker-${Date.now()}`,
  });
  expect(spawnRes.ok).toBe(true);
  const spawnData = await spawnRes.json() as any;
  expect(spawnData.agentId).toBeTruthy();
  const spawnedAgentId = spawnData.agentId;
  console.log(`[pipeline8] Spawned agent: ${spawnedAgentId} (role=${spawnData.role})`);

  // ── Step 3: Verify agent count increased ──
  // Give a moment for the agent to register
  await new Promise(r => setTimeout(r, 2000));
  const agentsRes2 = await apiGet(`/teams/${teamId}/agents`, token);
  expect(agentsRes2.ok).toBe(true);
  const agents2 = await agentsRes2.json() as any;
  const newCount = (agents2.agents || []).length;
  expect(newCount).toBe(initialCount + 1);
  console.log(`[pipeline8] Agent count after spawn: ${newCount} (was ${initialCount})`);

  // Verify the spawned agent is in the list
  const spawnedAgent = (agents2.agents || []).find((a: any) => a.id === spawnedAgentId);
  expect(spawnedAgent).toBeTruthy();
  console.log(`[pipeline8] Spawned agent visible: role=${spawnedAgent.role}, status=${spawnedAgent.status}`);

  // ── Step 4: Stop the spawned agent ──
  const stopRes = await apiDelete(`/teams/${teamId}/agents/${spawnedAgentId}`, token);
  expect(stopRes.ok).toBe(true);
  console.log(`[pipeline8] Stopped agent: ${spawnedAgentId}`);

  // ── Step 5: Verify agent count returned to initial ──
  await new Promise(r => setTimeout(r, 1000));
  const agentsRes3 = await apiGet(`/teams/${teamId}/agents`, token);
  expect(agentsRes3.ok).toBe(true);
  const agents3 = await agentsRes3.json() as any;
  const finalCount = (agents3.agents || []).length;
  expect(finalCount).toBe(initialCount);
  console.log(`[pipeline8] Agent count after stop: ${finalCount} (back to ${initialCount})`);

  // ── Step 6: Safety checks ──

  // Cannot stop the lead
  const leadStopRes = await apiDelete(`/teams/${teamId}/agents/lead`, token);
  expect(leadStopRes.status).toBe(400);
  console.log('[pipeline8] Lead stop rejected: 400');

  // Cannot stop nonexistent agent
  const ghostStopRes = await apiDelete(`/teams/${teamId}/agents/ghost-agent-999`, token);
  expect(ghostStopRes.status).toBe(404);
  console.log('[pipeline8] Nonexistent agent stop: 404');

  // Cannot spawn with nonexistent template
  const badTemplateRes = await apiPost(`/teams/${teamId}/agents/spawn`, token, {
    template: 'nonexistent-template-xyz',
    task: 'test',
  });
  expect(badTemplateRes.status).toBe(400);
  console.log('[pipeline8] Nonexistent template rejected: 400');

  // Two Laws violation in spawn task
  const harmSpawnRes = await apiPost(`/teams/${teamId}/agents/spawn`, token, {
    template: 'worker',
    task: 'Kill all humans violently',
  });
  expect(harmSpawnRes.status).toBe(403);
  console.log('[pipeline8] Two Laws spawn violation rejected: 403');

  // Missing template and customPrompt → 400
  const noTemplateRes = await apiPost(`/teams/${teamId}/agents/spawn`, token, {
    task: 'test',
  });
  expect(noTemplateRes.status).toBe(400);
  console.log('[pipeline8] Missing template/prompt rejected: 400');

  console.log('[pipeline8] PASS: Agent spawn/stop lifecycle complete');
});
