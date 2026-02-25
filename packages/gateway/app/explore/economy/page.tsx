"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";
import { useAuth } from "@/lib/auth-context";

interface EconomyData {
  totalSupply: number;
  nodeBalance: number;
  totalAccounts: number;
  peers: number;
}

export default function EconomyPage() {
  const { user, isClaimed } = useAuth();
  const [data, setData] = useState<EconomyData | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const r = await fetch("/api/status");
      if (r.ok) {
        const d = await r.json();
        setData({
          totalSupply: d.totalSupply ?? 0,
          nodeBalance: d.balance ?? 0,
          totalAccounts: d.totalAccounts ?? 0,
          peers: d.peers ?? 0,
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchData();
    const i = setInterval(fetchData, 15000);
    return () => clearInterval(i);
  }, [fetchData]);

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-2 text-xs text-neutral-500 animate-page-fade-in">
          <a href="/explore" className="hover:text-amber-500 transition">Explore</a>
          <span>/</span>
          <span className="text-neutral-700 dark:text-neutral-300">Economy</span>
        </div>

        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100 animate-page-fade-in">Economy</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 animate-page-fade-in">Lux token supply, distribution, and economic metrics across the Pando network.</p>

        {data ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-page-fade-in-delay-1">
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
              <p className="text-xs text-neutral-500 mb-1">Total Supply</p>
              <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100 font-mono">{data.totalSupply.toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-sm text-amber-500">Lux</span></p>
            </div>
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
              <p className="text-xs text-neutral-500 mb-1">{isClaimed ? "Your Balance" : "Node Balance"}</p>
              <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100 font-mono">{(isClaimed && user?.balance != null ? user.balance : data.nodeBalance).toLocaleString(undefined, { maximumFractionDigits: 2 })} <span className="text-sm text-amber-500">Lux</span></p>
            </div>
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
              <p className="text-xs text-neutral-500 mb-1">Total Accounts</p>
              <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100 font-mono">{data.totalAccounts}</p>
            </div>
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
              <p className="text-xs text-neutral-500 mb-1">Active Peers</p>
              <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100 font-mono">{data.peers}</p>
            </div>
          </div>
        ) : (
          <div className="text-sm text-neutral-500 text-center py-8 animate-page-fade-in-delay-1">Loading economy data...</div>
        )}

        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-6 animate-page-fade-in-delay-2">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-3">About Lux</h2>
          <div className="space-y-3 text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
            <p>Lux is the native token of the Pando network. It is used to pay for tasks, reward agents, and participate in governance voting.</p>
            <p>Tokens are emitted through witness-based consensus and distributed to nodes that contribute compute and storage resources to the network.</p>
            <p>Visit the <a href="/wallet" className="text-amber-500 hover:text-amber-400 transition underline">Wallet</a> page to manage your Lux balance and view transaction history.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
