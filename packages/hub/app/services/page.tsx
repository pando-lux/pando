"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types ------------------------------------------------- */

interface StatusData {
  connected: boolean;
  peers: number;
  totalSupply: number;
  totalAccounts: number;
}

interface CapabilityData {
  supply?: {
    totalProviders: number;
    resources: Record<string, { providers: number }>;
  };
  network?: {
    totalNodes: number;
  };
}

/* -- Status Badge ------------------------------------------ */

function StatusBadge({ status }: { status: "online" | "limited" | "offline" | "unknown" }) {
  const styles: Record<string, string> = {
    online: "bg-green-500/15 text-green-400 border-green-500/25",
    limited: "bg-amber-500/15 text-amber-400 border-amber-500/25",
    offline: "bg-red-500/15 text-red-400 border-red-500/25",
    unknown: "bg-neutral-500/15 text-neutral-400 border-neutral-500/25",
  };
  const labels: Record<string, string> = {
    online: "Online",
    limited: "Limited",
    offline: "Offline",
    unknown: "Unknown",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
        status === "online" ? "bg-green-400" :
        status === "limited" ? "bg-amber-400" :
        status === "offline" ? "bg-red-400" : "bg-neutral-400"
      }`} />
      {labels[status]}
    </span>
  );
}

/* -- Service Card ------------------------------------------ */

function ServiceCard({
  title,
  description,
  cost,
  status,
  icon,
}: {
  title: string;
  description: string;
  cost: string;
  status: "online" | "limited" | "offline" | "unknown";
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-5 space-y-3 hover:border-amber-500/30 transition">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-500 shrink-0">
            {icon}
          </div>
          <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">{title}</h3>
        </div>
        <StatusBadge status={status} />
      </div>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">{description}</p>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium text-neutral-500 dark:text-neutral-500 uppercase tracking-wide">Cost</span>
        <span className="text-xs text-amber-600 dark:text-amber-400 font-mono">{cost}</span>
      </div>
    </div>
  );
}

/* -- Icons (inline SVGs) ----------------------------------- */

function ChatIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function BuildIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function StorageIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  );
}

function GovernanceIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

/* -- Page -------------------------------------------------- */

export default function ServicesPage() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    // Fetch status and capacity independently so partial results render immediately.
    // Status is fast and tells us network connectivity; capacity adds resource detail.
    const statusPromise = fetch("/api/status", { signal: AbortSignal.timeout(6000) })
      .then(r => r.ok ? r.json() : null)
      .then(s => { if (s) setStatus(s); })
      .catch(() => {});

    const capPromise = fetch("/api/capacity", { signal: AbortSignal.timeout(6000) })
      .then(r => r.ok ? r.json() : null)
      .then(c => { if (c) setCapabilities(c); })
      .catch(() => {});

    await Promise.all([statusPromise, capPromise]);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  /* -- Derive statuses ------------------------------------- */

  const networkOnline = status?.connected ?? false;
  const hasStatus = status !== null;

  // Capacity data is optional — services still show Online/Offline based on
  // network connectivity even when the /capacity endpoint is unreachable.
  const supplyResources = capabilities?.supply?.resources;

  const chatStatus: "online" | "offline" | "unknown" = loading && !hasStatus
    ? "unknown"
    : networkOnline
      ? "online"
      : hasStatus
        ? "offline"
        : "unknown";

  const computeProviders = supplyResources?.["compute_cpu"]?.providers ?? 0;
  const buildStatus: "online" | "limited" | "offline" | "unknown" = loading && !hasStatus
    ? "unknown"
    : computeProviders > 0
      ? "online"
      : networkOnline
        ? "limited"
        : hasStatus
          ? "offline"
          : "unknown";

  const apiKeyProviders = supplyResources?.["api_keys"]?.providers ?? 0;
  const searchStatus: "online" | "limited" | "offline" | "unknown" = loading && !hasStatus
    ? "unknown"
    : apiKeyProviders > 0
      ? "online"
      : networkOnline
        ? "limited"
        : hasStatus
          ? "offline"
          : "unknown";

  const storageStatus: "online" | "offline" | "unknown" = loading && !hasStatus
    ? "unknown"
    : networkOnline
      ? "online"
      : hasStatus
        ? "offline"
        : "unknown";

  const governanceStatus: "online" | "offline" | "unknown" = loading && !hasStatus
    ? "unknown"
    : networkOnline
      ? "online"
      : hasStatus
        ? "offline"
        : "unknown";

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-8">
        {/* Hero */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Pando Services
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            What can the network do for you?
          </p>
        </div>

        {/* Network status summary */}
        {hasStatus ? (
          <div className="flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
            <span className={`w-2 h-2 rounded-full ${networkOnline ? "bg-green-500" : "bg-red-500"}`} />
            <span>
              {networkOnline
                ? `Network online \u2014 ${status?.peers ?? 0} peer${(status?.peers ?? 0) !== 1 ? "s" : ""} connected`
                : "Network offline \u2014 services unavailable"}
            </span>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-3 text-xs text-neutral-400">
            <span className="w-2 h-2 rounded-full bg-neutral-400 animate-pulse" />
            <span>Connecting to network\u2026</span>
          </div>
        ) : null}

        {/* Service Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 1. AI Chat */}
          <ServiceCard
            title="AI Chat"
            description="Chat with AI assistants. Ask questions, get help with code, brainstorm ideas. Simple questions answered instantly, complex ones routed to Claude Code agents."
            cost="Simple questions: Free. Complex projects: 5-50 Lux"
            status={chatStatus}
            icon={<ChatIcon />}
          />

          {/* 2. Project Building */}
          <ServiceCard
            title="Project Building"
            description="Have AI build websites, apps, and tools — from idea to deployed product. Includes code generation, testing, and deployment to live URLs."
            cost="10-100 Lux per project"
            status={buildStatus}
            icon={<BuildIcon />}
          />

          {/* 3. AI Search */}
          <ServiceCard
            title="AI Search"
            description="Search the web with AI understanding. Get synthesized answers with sources, not just a list of links."
            cost="0.01 Lux per query"
            status={searchStatus}
            icon={<SearchIcon />}
          />

          {/* 4. Storage & Hosting */}
          <ServiceCard
            title="Storage & Hosting"
            description="Store files and host websites. Your data lives on encrypted infrastructure (MongoDB + S3). Deployment included with projects."
            cost="0.001 Lux per GB-hour, deployment included"
            status={storageStatus}
            icon={<StorageIcon />}
          />

          {/* 5. Governance */}
          <ServiceCard
            title="Governance"
            description="Propose changes to the network. Vote on upgrades. Shape how Pando evolves. Every participant has a voice."
            cost="5 Lux stake per proposal (refunded if approved), 0.1 Lux per vote"
            status={governanceStatus}
            icon={<GovernanceIcon />}
          />
        </div>

        {/* How to Pay */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            How to Pay
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Everything on Pando is paid in Lux, the network&apos;s native currency.
          </p>
          <ul className="space-y-2.5">
            <PaymentItem
              label="Welcome Grant"
              detail="New users get 25-125 Lux free on signup (early users get more)"
            />
            <PaymentItem
              label="Run a Node"
              detail="Earn Lux by contributing compute, storage, and bandwidth"
            />
            <PaymentItem
              label="Transfer"
              detail="Receive Lux from other users"
            />
          </ul>
          <a
            href="/wallet"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400 hover:text-amber-500 dark:hover:text-amber-300 transition"
          >
            Check your balance &rarr;
          </a>
        </div>

        {/* For Providers */}
        <div className="bg-gradient-to-br from-amber-500/10 to-emerald-500/10 border border-amber-500/20 rounded-xl p-6 space-y-3">
          <h2 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">
            Want to Earn Lux?
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-xl">
            Run a Pando node and contribute resources to the network. Nodes earn Lux
            for uptime, task completion, and resource contributions.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
            <EarningCard label="Uptime" value="~7.2 Lux/day" note="10-min epochs" />
            <EarningCard label="Task Completion" value="5 Lux/task" note="verified work" />
            <EarningCard label="API Keys" value="2 Lux/key" note="search resources" />
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Early adopters (first 100 accounts) earn 5x multiplier on all rewards.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <a
              href="/network"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400 hover:text-amber-500 dark:hover:text-amber-300 transition"
            >
              View network &rarr;
            </a>
            <a
              href="/resources"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-500 dark:hover:text-neutral-300 transition"
            >
              Manage resources &rarr;
            </a>
            <a
              href="/resources/guide"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-500 dark:hover:text-neutral-300 transition"
            >
              Step-by-step guide to contributing resources &rarr;
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}

/* -- Sub-components ---------------------------------------- */

function PaymentItem({ label, detail }: { label: string; detail: string }) {
  return (
    <li className="flex items-start gap-3 text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-1.5 shrink-0" />
      <span>
        <span className="font-medium text-neutral-800 dark:text-neutral-200">{label}:</span>{" "}
        <span className="text-neutral-600 dark:text-neutral-400">{detail}</span>
      </span>
    </li>
  );
}

function EarningCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-white/50 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-lg p-3">
      <p className="text-xs text-neutral-500 dark:text-neutral-500">{label}</p>
      <p className="text-base font-mono font-bold text-amber-500 dark:text-amber-400">{value}</p>
      <p className="text-[10px] text-neutral-400">{note}</p>
    </div>
  );
}
