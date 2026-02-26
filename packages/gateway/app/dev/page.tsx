"use client";

import { useState, useEffect } from "react";
import NavBar from "@/components/NavBar";

/* -- Types ------------------------------------------------- */
interface LiveStat { label: string; value: string }
interface Endpoint {
  method: "GET" | "POST" | "DELETE";
  path: string;
  description: string;
  auth?: boolean;
  example?: string;
  response?: string;
}

/* -- Data -------------------------------------------------- */
const EC2_NODE = "http://54.82.241.132:4000";

const endpoints: Endpoint[] = [
  {
    method: "GET",
    path: "/v1/status",
    description: "Node health, peers, balance, and operational mode.",
    response: `{ "peerId": "12D3Koo...", "peers": 8, "balance": 1.65, "mode": 2, "health": { "kernel": "healthy", "core": "healthy", "platform": "degraded" } }`,
  },
  {
    method: "GET",
    path: "/v1/peers",
    description: "Connected peers with balance and last-seen time.",
    response: `{ "peers": [{ "peerId": "12D3Koo...", "balance": 42.5, "connectedAt": 1700000000 }] }`,
  },
  {
    method: "GET",
    path: "/v1/wallet",
    description: "This node's Lux balance and public key.",
    response: `{ "peerId": "12D3Koo...", "balance": 1.65, "publicKey": "...", "claimed": false }`,
  },
  {
    method: "GET",
    path: "/v1/ledger/accounts?limit=50",
    description: "Top accounts by balance. Public — no auth required.",
    response: `{ "accounts": [{ "peerId": "12D3Koo...", "balance": 100.0 }], "totalAccounts": 177, "totalSupply": 26297 }`,
  },
  {
    method: "GET",
    path: "/v1/ledger/transactions?limit=50",
    description: "Most recent transactions across the network.",
    response: `{ "transactions": [{ "from": "NETWORK", "to": "12D3Koo...", "amount": 0.05, "type": "emission" }], "total": 2518 }`,
  },
  {
    method: "GET",
    path: "/v1/network/capabilities",
    description: "All nodes and their capability profiles (storage, compute, AI, etc.).",
    response: `{ "count": 9, "profiles": [{ "peerId": "12D3Koo...", "storageBackend": "mongodb", "credentialAccess": true }] }`,
  },
  {
    method: "GET",
    path: "/v1/governance/proposals",
    description: "Active and past governance proposals.",
    response: `{ "proposals": [{ "id": "prop-1", "title": "...", "status": "active", "votes": { "for": 2, "against": 0 } }] }`,
  },
  {
    method: "POST",
    path: "/v1/search",
    description: "AI-powered search routed to a compute node with contributed API keys.",
    auth: true,
    example: `{ "query": "What is quantum computing?", "tier": "simple" }`,
    response: `{ "response": "Quantum computing uses quantum bits...", "tier": "simple", "respondedBy": "12D3Koo..." }`,
  },
  {
    method: "GET",
    path: "/v1/resources",
    description: "Contributed resources (AI keys, MongoDB, S3, GitHub, AWS).",
    auth: true,
    response: `{ "resources": [{ "resourceId": "...", "type": "ai_api_key", "status": "active", "metadata": { "service": "openai" } }] }`,
  },
  {
    method: "POST",
    path: "/v1/transfer",
    description: "Send Lux to a peer.",
    auth: true,
    example: `{ "to": "12D3KooW...", "amount": 5.0 }`,
    response: `{ "success": true, "txId": "...", "newBalance": 96.65 }`,
  },
  {
    method: "POST",
    path: "/v1/projects",
    description: "Create a new project (app to be built by AI agents).",
    auth: true,
    example: `{ "name": "My App", "description": "A todo list app with local storage" }`,
    response: `{ "id": "...", "name": "My App", "apiKey": "pando_..." }`,
  },
  {
    method: "POST",
    path: "/v1/chat/message",
    description: "Send a message to the Manager agent (natural language task).",
    auth: true,
    example: `{ "message": "Build a todo app with React and local storage" }`,
    response: `{ "status": "queued", "threadId": "...", "reply": "..." }`,
  },
];

const codeExamples = [
  {
    label: "Node status",
    lang: "bash",
    code: `curl http://54.82.241.132:4000/v1/status \\
  -H "Authorization: Bearer <api-token>"`,
  },
  {
    label: "AI search",
    lang: "bash",
    code: `curl -X POST http://localhost:4000/v1/search \\
  -H "Authorization: Bearer <api-token>" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "What is 2+2?", "tier": "simple"}'`,
  },
  {
    label: "JavaScript fetch",
    lang: "js",
    code: `const NODE = "http://localhost:4000";
const TOKEN = require("fs").readFileSync(
  require("os").homedir() + "/.pando/api-token", "utf8"
).trim();

const status = await fetch(\`\${NODE}/v1/status\`, {
  headers: { Authorization: \`Bearer \${TOKEN}\` }
}).then(r => r.json());

console.log(\`Peers: \${status.peers}, Balance: \${status.balance} Lux\`);`,
  },
  {
    label: "P2P resource proxy",
    lang: "js",
    code: `// Inside your Pando app — use window.PANDO_GATEWAY_URL
// (injected at deploy time by the Pando deploy pipeline)
const GATEWAY = window.PANDO_GATEWAY_URL || "http://localhost:3222";
const PROJECT_KEY = window.PANDO_PROJECT_API_KEY;

// Query MongoDB through the Resource Proxy
const data = await fetch(\`\${GATEWAY}/api/resource-proxy/find\`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Project-Key": PROJECT_KEY,
  },
  body: JSON.stringify({ collection: "todos", filter: {} }),
}).then(r => r.json());`,
  },
];

/* -- Components -------------------------------------------- */

function MethodBadge({ method }: { method: Endpoint["method"] }) {
  const cls = method === "GET"
    ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/25"
    : method === "POST"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25"
      : "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/25";
  return (
    <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border ${cls} flex-shrink-0`}>
      {method}
    </span>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-lg overflow-hidden border border-neutral-700 dark:border-neutral-800">
      <div className="flex items-center justify-between px-4 py-1.5 bg-neutral-800 dark:bg-neutral-900 border-b border-neutral-700">
        <span className="text-[11px] text-neutral-400 font-mono">{lang}</span>
        <button
          onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
          className="text-[11px] text-neutral-400 hover:text-neutral-200 transition"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre className="px-4 py-3 bg-neutral-950 overflow-x-auto">
        <code className="text-xs text-emerald-400 font-mono leading-relaxed whitespace-pre">{code}</code>
      </pre>
    </div>
  );
}

function EndpointRow({ ep, expanded, onToggle }: { ep: Endpoint; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition"
      >
        <MethodBadge method={ep.method} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs font-mono text-neutral-800 dark:text-neutral-200">{ep.path}</code>
            {ep.auth && (
              <span className="text-[10px] text-amber-600 dark:text-amber-400 border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 rounded">auth</span>
            )}
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{ep.description}</p>
        </div>
        <span className="text-neutral-400 text-xs mt-0.5">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-neutral-200 dark:border-neutral-800 pt-3">
          {ep.example && (
            <div>
              <p className="text-[11px] text-neutral-500 mb-1.5 font-medium">Request body</p>
              <CodeBlock code={ep.example} lang="json" />
            </div>
          )}
          {ep.response && (
            <div>
              <p className="text-[11px] text-neutral-500 mb-1.5 font-medium">Example response</p>
              <CodeBlock code={ep.response} lang="json" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* -- Main Page --------------------------------------------- */

export default function DevPage() {
  const [liveStats, setLiveStats] = useState<LiveStat[]>([]);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [expandedCode, setExpandedCode] = useState<number>(0);

  useEffect(() => {
    async function loadStats() {
      try {
        const res = await fetch("/api/status");
        if (!res.ok) return;
        const d = await res.json();
        setLiveStats([
          { label: "Live peers", value: String(d.peers ?? 0) },
          { label: "Accounts", value: String(d.totalAccounts ?? 0) },
          { label: "Lux supply", value: `${(d.totalSupply ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} Lux` },
        ]);
      } catch {}
    }
    loadStats();
  }, []);

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-4xl mx-auto px-4 py-10 space-y-10">

        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <span>pando-lux/pando</span>
            <span>·</span>
            <a href="https://github.com/pando-lux/pando" target="_blank" rel="noopener noreferrer" className="text-amber-500 hover:underline">GitHub</a>
          </div>
          <h1 className="text-3xl font-bold text-neutral-900 dark:text-neutral-100">Developer Hub</h1>
          <p className="text-neutral-500 dark:text-neutral-400 text-base">
            Build on the Pando network — every node is an HTTP API with P2P compute, AI search, and Lux payments.
          </p>
        </div>

        {/* Live stats */}
        {liveStats.length > 0 && (
          <div className="flex items-center gap-6 text-sm">
            {liveStats.map(s => (
              <div key={s.label} className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                <span className="font-mono text-amber-600 dark:text-amber-400 font-medium">{s.value}</span>
                <span className="text-neutral-500 dark:text-neutral-400">{s.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Quick start */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Quick Start</h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Clone the repo, build, and connect to the live network. Your node gets an identity and starts earning Lux in seconds.
          </p>
          <CodeBlock
            lang="bash"
            code={`git clone https://github.com/pando-lux/pando.git && cd pando
npm install && npm run build
node packages/node/dist/cli.js --port 4001 \\
  --bootstrap /ip4/54.82.241.132/tcp/4001/p2p/12D3KooWDRjGzaUuATiPuhg5D2k1CQTT6nCMpjdsDTVwrGDC4QVP`}
          />
          <p className="text-xs text-neutral-400">
            Your API token is at <code className="font-mono text-xs">~/.pando/api-token</code>. Default API port: 4000.
          </p>
        </section>

        {/* Code examples */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Code Examples</h2>
          <div className="flex gap-2 flex-wrap">
            {codeExamples.map((ex, i) => (
              <button
                key={i}
                onClick={() => setExpandedCode(i)}
                className={`text-xs px-3 py-1.5 rounded-full border transition ${
                  expandedCode === i
                    ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25"
                    : "text-neutral-500 dark:text-neutral-400 border-neutral-300 dark:border-neutral-700 hover:border-neutral-400"
                }`}
              >
                {ex.label}
              </button>
            ))}
          </div>
          <CodeBlock code={codeExamples[expandedCode].code} lang={codeExamples[expandedCode].lang} />
        </section>

        {/* API reference */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">API Reference</h2>
            <span className="text-xs text-neutral-400">All endpoints under <code className="font-mono">/v1/</code> · Bearer auth</span>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Base URL: your node URL (default <code className="font-mono text-xs">http://localhost:4000</code>).{" "}
            API token: <code className="font-mono text-xs">cat ~/.pando/api-token</code>
          </p>
          <p className="text-xs text-neutral-400">
            Live network node: <code className="font-mono text-xs">{EC2_NODE}</code> (public read-only endpoints require no auth; write endpoints require auth)
          </p>
          <div className="space-y-2">
            {endpoints.map((ep, i) => (
              <EndpointRow
                key={i}
                ep={ep}
                expanded={expandedIdx === i}
                onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
              />
            ))}
          </div>
        </section>

        {/* Architecture notes */}
        <section className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">Architecture in 30 seconds</h2>
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            {[
              { icon: "⬡", title: "P2P State", desc: "Identity, ledger, governance sync via GossipSub (libp2p). No central server." },
              { icon: "☁", title: "Internet Infra", desc: "App data lives in MongoDB + S3 — encrypted, durable, accessed from any node." },
              { icon: "🤖", title: "AI Agents", desc: "Claude Code agents build apps, manage governance, and coordinate autonomously." },
              { icon: "₿", title: "Lux Economy", desc: "Earn Lux for uptime, tasks, API keys. Pay for compute and storage in Lux." },
            ].map(item => (
              <div key={item.title} className="flex gap-3">
                <span className="text-xl">{item.icon}</span>
                <div>
                  <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">{item.title}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Links */}
        <div className="flex flex-wrap gap-3">
          <a
            href="https://github.com/pando-lux/pando"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-neutral-900 dark:bg-neutral-800 text-white text-sm font-medium hover:bg-neutral-700 transition"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17 6.7 18 7 18 7c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3z" />
            </svg>
            GitHub
          </a>
          <a href="/node-setup" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition">
            Run a Node →
          </a>
          <a href="/explore/how-it-works" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition">
            How It Works →
          </a>
          <a href="/explore/economy" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm font-medium text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition">
            Ledger Explorer →
          </a>
        </div>

      </main>
    </div>
  );
}
