"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types ------------------------------------------------- */

interface OnboardData {
  bootstrapAddrs: string[];
  startCommand: string;
  repoUrl: string;
  version: string;
  peerCount: number;
  totalSupply: number;
  totalAccounts: number;
}

/* -- CopyButton -------------------------------------------- */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      onClick={copy}
      className="flex-shrink-0 px-2.5 py-1 text-[11px] font-medium rounded-lg border border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
    >
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

/* -- CodeBlock --------------------------------------------- */

function CodeBlock({ code, caption }: { code: string; caption?: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
      {caption && (
        <div className="px-4 py-2 bg-neutral-100 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700 text-[11px] text-neutral-500 font-medium">
          {caption}
        </div>
      )}
      <div className="flex items-start gap-2 px-4 py-3 bg-neutral-950 dark:bg-black">
        <code className="flex-1 font-mono text-xs text-emerald-400 whitespace-pre-wrap break-all leading-relaxed">
          {code}
        </code>
        <CopyButton text={code} />
      </div>
    </div>
  );
}

/* -- Step -------------------------------------------------- */

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-amber-500 text-white text-xs font-bold flex items-center justify-center mt-0.5">
        {n}
      </div>
      <div className="flex-1 space-y-2">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</h3>
        {children}
      </div>
    </div>
  );
}

/* -- Main Page --------------------------------------------- */

export default function NodeSetupPage() {
  const [data, setData] = useState<OnboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/onboard");
      const d = await res.json();
      setData(d);
    } catch { /* use defaults */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const defaultBootstrap = process.env.NEXT_PUBLIC_BOOTSTRAP_NODE || "/ip4/44.196.69.210/tcp/4001/p2p/12D3KooWJL2UxKRw2te6DNPsLa9KjRmB5SkML6Kd5wsndA8vJysN";
  const bootstrap = data?.bootstrapAddrs?.[0] || defaultBootstrap;
  const startCmd = data?.startCommand || `node packages/node/dist/cli.js --port 4001 --bootstrap ${bootstrap}`;

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />

      <main className="max-w-3xl mx-auto px-4 py-10 space-y-8">

        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold text-neutral-900 dark:text-neutral-100">Run a Pando Node</h1>
          <p className="mt-2 text-base text-neutral-500 dark:text-neutral-400">
            Join the network in minutes. Earn Lux for contributing compute and uptime.
          </p>
        </div>

        {/* Live network stats */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Live Peers", value: loading ? "…" : String(data?.peerCount ?? 0) },
            { label: "Total Accounts", value: loading ? "…" : String(data?.totalAccounts ?? 0) },
            { label: "Lux Supply", value: loading ? "…" : `${(data?.totalSupply ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} Lux` },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 p-4 text-center">
              <p className="text-xs text-neutral-500 mb-1">{label}</p>
              <p className="text-lg font-bold font-mono text-amber-500">{value}</p>
            </div>
          ))}
        </div>

        {/* Requirements */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 space-y-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Requirements</h2>
          <ul className="space-y-1 text-sm text-neutral-600 dark:text-neutral-400">
            <li className="flex items-center gap-2">
              <span className="text-emerald-500 font-bold">✓</span>
              Node.js 18+ (<a href="https://nodejs.org" target="_blank" rel="noopener noreferrer" className="text-amber-500 hover:underline">nodejs.org</a>)
            </li>
            <li className="flex items-center gap-2">
              <span className="text-emerald-500 font-bold">✓</span>
              Git
            </li>
            <li className="flex items-center gap-2">
              <span className="text-emerald-500 font-bold">✓</span>
              ~500MB disk space
            </li>
            <li className="flex items-center gap-2">
              <span className="text-neutral-400">○</span>
              <span className="text-neutral-400">Claude Code (optional — enables AI agent work)</span>
            </li>
          </ul>
        </div>

        {/* One-liner install */}
        <div className="rounded-xl border border-amber-500/30 bg-amber-50 dark:bg-amber-900/10 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">⚡</span>
            <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300">One-line install (Mac / Linux)</h2>
          </div>
          <CodeBlock
            caption="Paste in your terminal"
            code={`curl -fsSL https://raw.githubusercontent.com/pando-lux/pando/master/scripts/install.sh | bash`}
          />
          <p className="text-xs text-amber-700/70 dark:text-amber-400/70">
            This script checks for Node.js 18+, clones the repo, builds, and starts the node automatically.
            Windows users: see manual steps below.
          </p>
        </div>

        {/* Setup steps */}
        <div className="space-y-6">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Manual Setup Steps</h2>

          <Step n={1} title="Clone the repository">
            <CodeBlock
              caption="Terminal"
              code={`git clone ${data?.repoUrl || "https://github.com/pando-lux/pando.git"}
cd pando`}
            />
          </Step>

          <Step n={2} title="Install dependencies and build">
            <CodeBlock
              caption="Terminal"
              code={`npm install
npm run build`}
            />
            <p className="text-xs text-neutral-400">Takes ~2 minutes. Builds all packages: shared → ledger → node → hub → mcp-server.</p>
          </Step>

          <Step n={3} title="Start your node">
            <CodeBlock
              caption="Connects to live network"
              code={startCmd}
            />
            <p className="text-xs text-neutral-400">
              Your node auto-creates an Ed25519 identity, connects to the bootstrap peers, and starts earning Lux immediately.
            </p>
          </Step>

          <Step n={4} title="(Optional) Start the hub">
            <CodeBlock
              caption="Local web UI at http://localhost:3003"
              code={`cd packages/hub
PANDO_NODES=http://localhost:4000 npx next dev --port 3003`}
            />
          </Step>
        </div>

        {/* What you get */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-amber-50 dark:bg-amber-900/10 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400">What you earn</h2>
          <div className="grid sm:grid-cols-2 gap-2 text-sm">
            {[
              { earn: "0.05–0.25 Lux / 10 min", for: "Node uptime" },
              { earn: "5 Lux", for: "Completed AI task" },
              { earn: "2 Lux", for: "Contributing an API key" },
              { earn: "0.1 Lux", for: "Governance vote" },
            ].map(({ earn, for: forWhat }) => (
              <div key={forWhat} className="flex items-center gap-2">
                <span className="font-mono text-amber-600 dark:text-amber-400 font-semibold text-xs">{earn}</span>
                <span className="text-neutral-500 dark:text-neutral-400">for {forWhat}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-neutral-400">
            Early node multiplier: first 100 accounts earn 5× rewards. You&apos;re probably still eligible.
          </p>
        </div>

        {/* Bootstrap peers */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Bootstrap Peers</h2>
          <p className="text-xs text-neutral-400">
            Your node uses these to join the network on first start. They are automatically saved and re-used on subsequent starts.
          </p>
          {(data?.bootstrapAddrs || [bootstrap]).map((addr) => (
            <div key={addr} className="flex items-center gap-2 bg-neutral-950 dark:bg-black rounded-lg px-3 py-2">
              <code className="flex-1 font-mono text-[11px] text-emerald-400 break-all">{addr}</code>
              <CopyButton text={addr} />
            </div>
          ))}
        </div>

        {/* Links */}
        <div className="flex flex-wrap gap-3">
          <a
            href="https://github.com/pando-lux/pando"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-neutral-900 dark:bg-neutral-800 text-white text-sm font-medium hover:bg-neutral-700 transition"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17 6.7 18 7 18 7c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3z"/>
            </svg>
            GitHub
          </a>
          <a
            href="/explore/how-it-works"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 text-sm font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
          >
            How it works →
          </a>
          <a
            href="/explore/economy"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 text-sm font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
          >
            Ledger Explorer →
          </a>
          <a
            href="/apps"
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 text-sm font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
          >
            Built Apps →
          </a>
        </div>

      </main>
    </div>
  );
}
