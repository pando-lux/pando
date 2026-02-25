/**
 * Pando Network Smoke Test — v2 API (post-v2.2 /v1/ prefix)
 * Run: node tests/smoke-test.mjs
 *
 * Tests priority scenarios from genome/flows/e2e-test-scenarios.md
 */

const TOKEN = "bd5b00bab232c33c259c2603a9991925287cf43fb1f9519c4f00c04501532127";
const NODES = {
  "EC2-1": "http://54.82.241.132:4000",
  "EC2-2": "http://34.201.82.126:4000",
  "LS-2":  "http://3.237.175.38:4000",
};

const HEADERS = {
  "Authorization": `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    const result = await fn();
    console.log(`  ✅ ${name}: ${result}`);
    results.push({ name, status: "PASS", detail: result });
    passed++;
  } catch (err) {
    const msg = err.message || String(err);
    console.log(`  ❌ ${name}: ${msg}`);
    results.push({ name, status: "FAIL", detail: msg });
    failed++;
  }
}

async function apiGet(url, opts = {}) {
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(8000),
    ...opts,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
  }
  return res.json();
}

// ─── Section 1: Layer 0 — Kernel Health ─────────────────────────────────────

console.log("\n=== 1. Layer 0 — Kernel Health ===\n");

await test("EC2-1 /v1/status — node online", async () => {
  const d = await apiGet(`${NODES["EC2-1"]}/v1/status`);
  if (!d.identity) throw new Error("No identity in status");
  return `peers=${d.peers} mode=${d.mode}`;
});

await test("EC2-2 /v1/status — node online", async () => {
  const d = await apiGet(`${NODES["EC2-2"]}/v1/status`);
  if (!d.identity) throw new Error("No identity in status");
  return `peers=${d.peers} mode=${d.mode}`;
});

await test("LS-2 /v1/status — node online", async () => {
  const d = await apiGet(`${NODES["LS-2"]}/v1/status`);
  if (!d.identity) throw new Error("No identity in status");
  return `peers=${d.peers} mode=${d.mode}`;
});

await test("EC2-1 NodeHealth — kernel/core/platform", async () => {
  const d = await apiGet(`${NODES["EC2-1"]}/v1/status`);
  const h = d.health;
  if (!h) throw new Error("No health field — v2.3 not deployed?");
  return `kernel=${h.kernel} core=${h.core} platform=${h.platform} mode=${h.mode}`;
});

await test("EC2-1 /v1/wallet — ledger alive", async () => {
  const d = await apiGet(`${NODES["EC2-1"]}/v1/wallet`);
  if (d.balance === undefined) throw new Error("No balance field");
  return `${d.balance} Lux`;
});

await test("EC2-1 /v1/peers — P2P connected", async () => {
  const d = await apiGet(`${NODES["EC2-1"]}/v1/peers`);
  const peers = d.peers || d;
  if (!Array.isArray(peers) || peers.length === 0) throw new Error("No peers connected");
  return `${peers.length} peers`;
});

// ─── Section 2: Ledger Explorer (new) ──────────────────────────────────────

console.log("\n=== 2. Ledger Explorer (new endpoints) ===\n");

await test("EC2-1 /v1/ledger/accounts — top accounts", async () => {
  const d = await apiGet(`${NODES["EC2-1"]}/v1/ledger/accounts?limit=10`);
  if (!d.accounts || !Array.isArray(d.accounts)) throw new Error("No accounts array");
  if (d.totalAccounts === 0) throw new Error("No accounts in ledger");
  return `${d.accounts.length} returned / ${d.totalAccounts} total | supply=${d.totalSupply} Lux`;
});

await test("EC2-1 /v1/ledger/transactions — recent txs", async () => {
  const d = await apiGet(`${NODES["EC2-1"]}/v1/ledger/transactions?limit=10`);
  if (!d.transactions || !Array.isArray(d.transactions)) throw new Error("No transactions array");
  return `${d.transactions.length} returned / ${d.total} total`;
});

await test("LS-2 /v1/ledger/accounts — untrusted node has ledger", async () => {
  const d = await apiGet(`${NODES["LS-2"]}/v1/ledger/accounts?limit=5`);
  if (!d.accounts) throw new Error("No accounts");
  return `${d.totalAccounts} accounts on LS-2`;
});

// ─── Section 3: P2P Storage ─────────────────────────────────────────────────

console.log("\n=== 3. P2P Storage (LS-2 via proxy) ===\n");

let testThreadId = null;

await test("LS-2 create thread via P2P storage", async () => {
  const d = await apiPost(`${NODES["LS-2"]}/v1/chat/threads`, { title: `Smoke Test ${Date.now()}` });
  if (!d._id && !d.id) throw new Error("No thread ID in response");
  testThreadId = d._id || d.id;
  return `threadId=${testThreadId}`;
});

await test("LS-2 read thread back", async () => {
  if (!testThreadId) throw new Error("No thread from previous test");
  const d = await apiGet(`${NODES["LS-2"]}/v1/chat/threads/${testThreadId}`);
  if (!d._id && !d.id) throw new Error("Thread not found");
  return `found thread ${testThreadId.slice(0, 8)}`;
});

await test("EC2-1 can read LS-2 thread (cross-node P2P)", async () => {
  if (!testThreadId) throw new Error("No thread from previous test");
  // Give GossipSub 3 seconds to sync
  await new Promise(r => setTimeout(r, 3000));
  const d = await apiGet(`${NODES["EC2-1"]}/v1/chat/threads/${testThreadId}`);
  if (!d._id && !d.id) throw new Error("Thread not found on EC2-1");
  return `EC2-1 has thread ${testThreadId.slice(0, 8)}`;
});

// ─── Section 4: HealthMonitor ────────────────────────────────────────────────

console.log("\n=== 4. HealthMonitor ===\n");

await test("EC2-1 NodeHealth — kernel/core health (monitor may be disabled on compute nodes)", async () => {
  // EC2-1 is a compute node — monitor is disabled (expected). Check NodeHealth instead.
  const d = await apiGet(`${NODES["EC2-1"]}/v1/status`);
  const h = d.health;
  if (!h) throw new Error("No health field in status");
  if (h.kernel !== "healthy") throw new Error(`Kernel unhealthy: ${h.kernel}`);
  if (h.core !== "healthy") throw new Error(`Core unhealthy: ${h.core}`);
  return `kernel=${h.kernel} core=${h.core} platform=${h.platform} (monitor disabled on compute — expected)`;
});

await test("LS-2 NodeHealth — kernel/core health", async () => {
  // LS-2 may not have --monitor flag — check NodeHealth instead
  const d = await apiGet(`${NODES["LS-2"]}/v1/status`);
  const h = d.health;
  if (!h) throw new Error("No health field in status");
  if (h.kernel !== "healthy") throw new Error(`Kernel unhealthy: ${h.kernel}`);
  if (h.core !== "healthy") throw new Error(`Core unhealthy: ${h.core}`);
  return `kernel=${h.kernel} core=${h.core} platform=${h.platform} mode=${h.mode}`;
});

// ─── Section 5: Governance ──────────────────────────────────────────────────

console.log("\n=== 5. Governance ===\n");

await test("EC2-1 /v1/governance/proposals — governance alive", async () => {
  const d = await apiGet(`${NODES["EC2-1"]}/v1/governance/proposals`);
  const proposals = d.proposals || d;
  if (!Array.isArray(proposals)) throw new Error("Proposals not an array");
  return `${proposals.length} proposals`;
});

// ─── Section 6: AI Search (cross-node credential routing) ──────────────────

console.log("\n=== 6. AI Search (credential routing) ===\n");

await test("LS-2 AI search via EC2-1 credentials", async () => {
  const d = await apiPost(`${NODES["LS-2"]}/v1/search`, {
    query: "What is 2+2? Answer in exactly one number.",
    tier: "simple",
  });
  if (!d.response && !d.reply && !d.answer && !d.result) throw new Error(`No answer: ${JSON.stringify(d).slice(0, 100)}`);
  const answer = d.response || d.reply || d.answer || d.result || "";
  return `got response (${answer.slice(0, 50).replace(/\n/g, " ")})`;
});

// ─── Section 7: Network Capabilities ────────────────────────────────────────

console.log("\n=== 7. Network Capabilities ===\n");

await test("EC2-1 /v1/network/capabilities — capability registry", async () => {
  const d = await apiGet(`${NODES["EC2-1"]}/v1/network/capabilities`);
  // Response: { count: N, profiles: [...] }
  const profiles = d.profiles || (Array.isArray(d) ? d : Object.values(d));
  if (!profiles || profiles.length === 0) throw new Error("No capabilities registered");
  const mongoNodes = profiles.filter((e) => e.storageBackend === "mongodb").length;
  const p2pNodes = profiles.filter((e) => e.storageBackend === "p2p").length;
  const credAccess = profiles.filter((e) => e.credentialAccess).length;
  return `${profiles.length} nodes | mongodb=${mongoNodes} p2p=${p2pNodes} credentialAccess=${credAccess}`;
});

// ─── Section 8: App Directory (new) ─────────────────────────────────────────

console.log("\n=== 8. App Directory (Phase 53.7) ===\n");

await test("EC2-1 /v1/projects — deployed apps listed", async () => {
  const d = await apiGet(`${NODES["EC2-1"]}/v1/projects`);
  const projects = d.projects || d;
  if (!Array.isArray(projects)) throw new Error("Projects not an array");
  const deployed = projects.filter((p) => p.deploymentUrl && p.deploymentUrl !== "");
  return `${projects.length} total projects | ${deployed.length} deployed`;
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`RESULTS: ${passed} PASS / ${failed} FAIL`);
console.log(`${"─".repeat(50)}\n`);

if (failed > 0) {
  console.log("FAILED TESTS:");
  results.filter(r => r.status === "FAIL").forEach(r => {
    console.log(`  ❌ ${r.name}: ${r.detail}`);
  });
  console.log("");
}

process.exit(failed > 0 ? 1 : 0);
