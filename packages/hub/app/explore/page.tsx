"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

interface Status {
  connected: boolean;
  peers: number;
  balance: number;
  totalSupply: number;
  totalAccounts: number;
}

interface SchedulerStatus {
  running: boolean;
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed: number;
}

interface ActivityStats {
  total: number;
  byAction: Record<string, number>;
}

export default function ExplorePage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [activityStats, setActivityStats] = useState<ActivityStats | null>(null);
  const [proposalCount, setProposalCount] = useState<number>(0);
  const [appsCount, setAppsCount] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  const fetchData = useCallback(async () => {
    const [s, sc, as_, gov, apps] = await Promise.all([
      fetch("/api/status").then(r => r.json()).catch(() => null),
      fetch("/api/scheduler/status").then(r => r.json()).catch(() => null),
      fetch("/api/activity/stats?window=24h").then(r => r.json()).catch(() => null),
      fetch("/api/governance/proposals").then(r => r.json()).catch(() => null),
      fetch("/api/apps").then(r => r.json()).catch(() => null),
    ]);
    if (s) setStatus(s);
    if (sc) setScheduler(sc);
    if (as_) setActivityStats(as_);
    if (gov) {
      const proposals = gov.proposals || gov || [];
      const active = Array.isArray(proposals) ? proposals.filter((p: any) => p.status === "active").length : 0;
      setProposalCount(active);
    }
    if (apps) setAppsCount(apps.total ?? 0);
    setLoaded(true);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const cards = [
    {
      title: "Activity",
      description: "See what the network is doing right now",
      href: "/explore/activity",
      stat: activityStats ? `${activityStats.total} events (24h)` : null,
      color: "amber",
    },
    {
      title: "Network",
      description: "Peers, topology, and connections",
      href: "/explore/network",
      stat: status ? `${status.peers} peer${status.peers !== 1 ? "s" : ""} connected` : null,
      color: "cyan",
    },
    {
      title: "Governance",
      description: "Proposals, voting, and decisions",
      href: "/explore/governance",
      stat: proposalCount > 0 ? `${proposalCount} active proposal${proposalCount !== 1 ? "s" : ""}` : "No active proposals",
      color: "purple",
    },
    {
      title: "Economy",
      description: "Lux supply, earning, and distribution",
      href: "/explore/economy",
      stat: status ? `${status.totalSupply.toLocaleString(undefined, { maximumFractionDigits: 2 })} Lux total supply` : null,
      color: "green",
    },
    {
      title: "Health",
      description: "Peers, nodes, reputation, and capabilities",
      href: "/network",
      stat: status ? `${status.peers} peer${status.peers !== 1 ? "s" : ""} online` : null,
      color: "blue",
    },
    {
      title: "How It Works",
      description: "Learn about Pando",
      href: "/explore/how-it-works",
      stat: "FAQ, docs, architecture",
      color: "neutral",
    },
    {
      title: "Apps",
      description: "Apps built by AI agents on the network",
      href: "/apps",
      stat: appsCount !== null ? `${appsCount} deployed app${appsCount !== 1 ? "s" : ""}` : null,
      color: "orange",
    },
    {
      title: "Run a Node",
      description: "Join the network and start earning Lux",
      href: "/node-setup",
      stat: status ? `${status.totalAccounts} account${status.totalAccounts !== 1 ? "s" : ""} in network` : null,
      color: "emerald",
    },
  ];

  const colorMap: Record<string, { border: string; bg: string; text: string; dot: string }> = {
    amber: { border: "border-amber-500/20", bg: "hover:bg-amber-500/5", text: "text-amber-500 dark:text-amber-400", dot: "bg-amber-500" },
    cyan: { border: "border-cyan-500/20", bg: "hover:bg-cyan-500/5", text: "text-cyan-500 dark:text-cyan-400", dot: "bg-cyan-500" },
    purple: { border: "border-purple-500/20", bg: "hover:bg-purple-500/5", text: "text-purple-500 dark:text-purple-400", dot: "bg-purple-500" },
    green: { border: "border-green-500/20", bg: "hover:bg-green-500/5", text: "text-green-500 dark:text-green-400", dot: "bg-green-500" },
    blue: { border: "border-blue-500/20", bg: "hover:bg-blue-500/5", text: "text-blue-500 dark:text-blue-400", dot: "bg-blue-500" },
    neutral: { border: "border-neutral-500/20", bg: "hover:bg-neutral-500/5", text: "text-neutral-500 dark:text-neutral-400", dot: "bg-neutral-500" },
    orange: { border: "border-orange-500/20", bg: "hover:bg-orange-500/5", text: "text-orange-500 dark:text-orange-400", dot: "bg-orange-500" },
    emerald: { border: "border-emerald-500/20", bg: "hover:bg-emerald-500/5", text: "text-emerald-500 dark:text-emerald-400", dot: "bg-emerald-500" },
  };

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="space-y-2 animate-page-fade-in">
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">Explore the Network</h1>
          <p className="text-neutral-500 dark:text-neutral-400 text-sm">Discover what's happening on Pando — network activity, governance, economy, and more.</p>
        </div>

        {/* 6 cards grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 animate-page-fade-in-delay-1">
          {cards.map((card) => {
            const c = colorMap[card.color] || colorMap.neutral;
            return (
              <a
                key={card.title}
                href={card.href}
                className={`block border ${c.border} border-neutral-300 dark:border-neutral-800 rounded-xl p-5 transition ${c.bg} group`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                  <h2 className={`text-lg font-semibold ${c.text} group-hover:underline`}>{card.title}</h2>
                </div>
                <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-3">{card.description}</p>
                {card.stat ? (
                  <p className="text-xs text-neutral-500 dark:text-neutral-500 font-mono">{card.stat}</p>
                ) : (
                  loaded ? <p className="text-xs text-neutral-500 font-mono">—</p> : <div className="h-4 w-24 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
                )}
              </a>
            );
          })}
        </div>

        {/* Node Operator section */}
        <div className="animate-page-fade-in-delay-2">
          <details className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
            <summary className="px-5 py-4 cursor-pointer text-sm font-semibold text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50 transition select-none">
              For Node Operators
            </summary>
            <div className="px-5 pb-4 pt-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
              <a href="/network" className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50 transition text-sm text-neutral-700 dark:text-neutral-300 font-medium">
                Network
              </a>
              <a href="/resources" className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50 transition text-sm text-neutral-700 dark:text-neutral-300 font-medium">
                Resources
              </a>
              <a href="/marketplace" className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50 transition text-sm text-neutral-700 dark:text-neutral-300 font-medium">
                Marketplace
              </a>
              <a href="/search" className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50 transition text-sm text-neutral-700 dark:text-neutral-300 font-medium">
                Search
              </a>
              <a href="/wallet" className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50 transition text-sm text-neutral-700 dark:text-neutral-300 font-medium">
                Wallet
              </a>
            </div>
          </details>
        </div>

        {/* Quick stats footer */}
        {(status || scheduler) && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-page-fade-in-delay-3">
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
              <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Connected Peers</p>
              <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{status?.peers ?? "\u2014"}</p>
            </div>
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
              <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Tasks Processed</p>
              <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{scheduler?.totalProcessed ?? 0}</p>
            </div>
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
              <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Success Rate</p>
              <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
                {scheduler && scheduler.totalProcessed > 0 ? `${Math.round((scheduler.totalSucceeded / scheduler.totalProcessed) * 100)}%` : "\u2014"}
              </p>
            </div>
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
              <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Total Supply</p>
              <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
                {status ? `${status.totalSupply.toLocaleString(undefined, { maximumFractionDigits: 2 })} Lux` : "\u2014"}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
