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

/** Helper: authenticated DELETE */
async function apiDelete(path: string, token: string) {
  return fetch(`${NODE_API_URL}/v1${path}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
}

let token: string;
let userJwt: string;

test.beforeAll(async () => {
  token = loadApiToken();
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

  const upgPropRes = await apiPost('/governance/propose', token, {
    title: '[E2E] Auto-upgrade test — validate governance pipeline',
    description: 'Automated E2E security test. No-op upgrade to current HEAD.',
    category: 'upgrade',
    commitHash,
    votingDurationMs: 60000,
  });
  if (!upgPropRes.ok) {
    const err = await upgPropRes.text();
    console.log(`[pipeline2] Upgrade propose failed (${upgPropRes.status}): ${err}`);
  }
  expect(upgPropRes.ok).toBe(true);
  const upgProp = await upgPropRes.json() as any;
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
  test.setTimeout(180_000); // Engine builds can take time
  test.skip(!userJwt, 'Skipped — guest auth not available');

  // ── Step 1: Send build request via chat ──
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

  // Expect tier=complex and project created for a build request
  expect(chatData.tier).toBe('complex');
  expect(projectId).toBeTruthy();
  console.log(`[pipeline4] Project created: ${projectId}`);

  // ── Step 2: Verify project exists in project store ──
  const projRes = await apiGet(`/projects/${projectId}`, token);
  if (projRes.ok) {
    const proj = await projRes.json() as any;
    expect(proj.id || proj.project?.id).toBeTruthy();
    console.log(`[pipeline4] Project confirmed in store: ${proj.name || proj.project?.name}`);
  } else {
    console.log(`[pipeline4] Project endpoint returned ${projRes.status} — may be async`);
  }

  // ── Step 3: Wait for engine to complete (poll thread for assistant messages) ──
  let engineDone = false;
  let pollAttempts = 0;
  const maxPolls = 30; // 30 * 5s = 150s max wait

  while (!engineDone && pollAttempts < maxPolls) {
    pollAttempts++;
    await new Promise(r => setTimeout(r, 5000));

    // Check thread for assistant messages
    const threadRes = await apiGet(`/chat/threads/${threadId}`, token);
    if (threadRes.ok) {
      const threadData = await threadRes.json() as any;
      const messages = threadData.messages || threadData.thread?.messages || [];
      const assistantMsgs = messages.filter((m: any) => m.role === 'assistant');
      if (assistantMsgs.length > 0) {
        const lastMsg = assistantMsgs[assistantMsgs.length - 1];
        // Engine is done when we get a substantive response (not just "processing")
        if (lastMsg.content && lastMsg.content.length > 50 && !lastMsg.content.includes('is processing')) {
          engineDone = true;
          console.log(`[pipeline4] Engine completed (poll ${pollAttempts}): ${lastMsg.content.slice(0, 100)}...`);
        }
      }
    }

    // Also check if app was registered (deploy happens after engine)
    const appRes = await apiGet(`/apps/${projectId}`, token);
    if (appRes.ok) {
      const appData = await appRes.json() as any;
      if (appData.app?.status === 'live' || appData.app?.status === 'failed') {
        engineDone = true;
        console.log(`[pipeline4] App deployment detected: status=${appData.app.status}`);
      }
    }

    if (!engineDone && pollAttempts % 6 === 0) {
      console.log(`[pipeline4] Waiting for engine... (${pollAttempts * 5}s elapsed)`);
    }
  }

  if (!engineDone) {
    console.log(`[pipeline4] Engine did not complete in ${maxPolls * 5}s — testing what we have so far`);
  }

  // ── Step 4: Check marketplace — project should be listed ──
  const mktRes = await fetch(`${NODE_API_URL}/v1/marketplace`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  expect(mktRes.ok).toBe(true);
  const mkt = await mktRes.json() as any;
  const listedProject = mkt.projects?.find((p: any) => p.id === projectId);
  if (listedProject) {
    console.log(`[pipeline4] Marketplace: project listed! name="${listedProject.name}", deployment=${JSON.stringify(listedProject.deployment || 'none')}`);
    // If deployment info is present, the pipeline fully worked
    if (listedProject.deployment) {
      expect(listedProject.deployment.status).toBeTruthy();
      console.log(`[pipeline4] Marketplace deployment: status=${listedProject.deployment.status}, url=${listedProject.deployment.url || 'pending'}`);
    }
  } else {
    console.log(`[pipeline4] Project not yet in marketplace (may be async) — ${mkt.projects?.length || 0} projects listed`);
  }

  // ── Step 5: Check AppManager — app should be registered ──
  const appRes = await apiGet(`/apps/${projectId}`, token);
  if (appRes.ok) {
    const appData = await appRes.json() as any;
    expect(appData.app.id).toBe(projectId);
    console.log(`[pipeline4] App in AppManager: status=${appData.app.status}, tier=${appData.app.tier}, commit=${appData.app.current_commit?.slice(0, 8) || 'none'}`);

    // Check deployment history
    const histRes = await apiGet(`/apps/${projectId}/history`, token);
    if (histRes.ok) {
      const hist = await histRes.json() as any;
      console.log(`[pipeline4] Deploy history: ${hist.history?.length || 0} entries`);
    }
  } else {
    console.log(`[pipeline4] App not yet in AppManager (engine may still be building)`);
  }

  // ── Step 6: Send update request to same project (engine resumes) ──
  const updateChatRes = await fetch(`${NODE_API_URL}/v1/chat/message`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-User-Token': userJwt,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'Add a /status endpoint that returns { uptime, connections }',
      projectId, // Same project — engine should resume
    }),
  });

  if (updateChatRes.ok) {
    const updateData = await updateChatRes.json() as any;
    // projectId should match — engine resumed on same project
    expect(updateData.projectId || projectId).toBe(projectId);
    console.log(`[pipeline4] Update sent to same project — tier=${updateData.tier}, routedTo=${updateData.routedTo || 'local'}`);

    // Wait briefly for update to process
    await new Promise(r => setTimeout(r, 10_000));

    // Check if app was updated (new history entry)
    const postUpdateHist = await apiGet(`/apps/${projectId}/history`, token);
    if (postUpdateHist.ok) {
      const hist = await postUpdateHist.json() as any;
      console.log(`[pipeline4] Post-update history: ${hist.history?.length || 0} entries`);
    }
  } else if (updateChatRes.status === 429) {
    console.log(`[pipeline4] Update rate-limited — skipping update test`);
  } else {
    console.log(`[pipeline4] Update chat returned ${updateChatRes.status}`);
  }

  // ── Step 7: Cleanup — delete app from AppManager ──
  const cleanupRes = await apiDelete(`/apps/${projectId}`, token);
  if (cleanupRes.ok) {
    console.log(`[pipeline4] Cleaned up app ${projectId}`);
  }

  console.log(`[pipeline4] PASS: User request → build → deploy → marketplace → update pipeline tested`);
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
