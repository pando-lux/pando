"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types ------------------------------------------------- */

interface ResourceSupply {
  providers: number;
  averagePrice: number;
  lowestPrice: number;
  unit: string;
}

interface ResourceDemand {
  totalUsage: number;
  unit: string;
  contributingNodes: number;
}

interface ResourceReward {
  rate: number;
  estimatedDaily: number;
}

interface CapacityData {
  supply: {
    totalProviders: number;
    resources: Record<string, ResourceSupply>;
  };
  demand: {
    period: string;
    resources: Record<string, ResourceDemand>;
    tasks: {
      active: number;
      queued: number;
      totalProcessed: number;
      successRate: number;
    };
  };
  rewards: {
    totalDistributed: number;
    perResource: Record<string, ResourceReward>;
  };
  network: {
    totalNodes: number;
    totalAccounts: number;
    totalSupply: number;
    nodeHealth: string;
  };
}

/* -- Helpers ------------------------------------------------ */

function typeLabel(t: string): string {
  return t.replace(/_/g, " ");
}

function healthBadgeCls(h: string): string {
  switch (h) {
    case "healthy":
      return "bg-green-500/20 text-green-400 border-green-500/30";
    case "degraded":
      return "bg-amber-500/20 text-amber-400 border-amber-500/30";
    case "critical":
      return "bg-red-500/20 text-red-400 border-red-500/30";
    default:
      return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
  }
}

function formatLux(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

function earningBarWidth(daily: number, maxDaily: number): string {
  if (maxDaily <= 0) return "0%";
  const pct = Math.min((daily / maxDaily) * 100, 100);
  return `${Math.max(pct, 4)}%`;
}

/* -- Page -------------------------------------------------- */

export default function CapacityPage() {
  const [data, setData] = useState<CapacityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/capacity");
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setError(null);
      } else {
        setError("Failed to load capacity data");
      }
    } catch {
      setError("Node not reachable");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const i = setInterval(fetchData, 30000);
    return () => clearInterval(i);
  }, [fetchData]);

  /* -- Derived data ----------------------------------------- */

  const supplyResources = data?.supply?.resources
    ? Object.entries(data.supply.resources)
    : [];

  const demandResources = data?.demand?.resources
    ? Object.entries(data.demand.resources)
    : [];

  const rewardEntries = data?.rewards?.perResource
    ? Object.entries(data.rewards.perResource).sort(
        (a, b) => b[1].estimatedDaily - a[1].estimatedDaily
      )
    : [];

  const maxDailyReward = rewardEntries.length > 0
    ? Math.max(...rewardEntries.map(([, r]) => r.estimatedDaily))
    : 0;

  const tasks = data?.demand?.tasks;

  /* -- Render ----------------------------------------------- */

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Capacity Dashboard
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Network supply, demand, and reward signals. Auto-refreshes every 30s.
          </p>
        </div>

        {/* Loading / Error states */}
        {loading && (
          <div className="text-center py-12 text-neutral-500">
            Loading capacity data...
          </div>
        )}

        {!loading && error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
            <p className="text-sm text-red-400">{error}</p>
            <p className="text-xs text-neutral-500 mt-1">
              Make sure a Pando node is running and reachable.
            </p>
          </div>
        )}

        {!loading && !error && data && (
          <>
            {/* ---- 1. Network Overview ---- */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <StatCard
                label="Nodes Online"
                value={data.network?.totalNodes ?? "--"}
                accent="text-emerald-400"
              />
              <StatCard
                label="Total Accounts"
                value={data.network?.totalAccounts ?? "--"}
                accent="text-indigo-400"
              />
              <StatCard
                label="Total Lux Supply"
                value={
                  data.network?.totalSupply != null
                    ? formatLux(data.network.totalSupply)
                    : "--"
                }
                accent="text-amber-400"
              />
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
                <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">
                  Network Health
                </p>
                {data.network?.nodeHealth ? (
                  <span
                    className={`inline-block text-xs px-2.5 py-1 rounded-full font-medium border ${healthBadgeCls(
                      data.network.nodeHealth
                    )}`}
                  >
                    {data.network.nodeHealth}
                  </span>
                ) : (
                  <span className="text-lg font-mono font-bold text-neutral-400">
                    --
                  </span>
                )}
              </div>
            </div>

            {/* ---- 2. Supply ---- */}
            <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                  Supply &mdash; What the Network Offers
                </h2>
                <span className="text-[10px] text-neutral-500 font-mono">
                  {data.supply?.totalProviders ?? 0} provider
                  {(data.supply?.totalProviders ?? 0) !== 1 ? "s" : ""}
                </span>
              </div>

              {supplyResources.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-neutral-500">
                    No resources registered yet. Be the first to contribute!
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-neutral-500 border-b border-neutral-200 dark:border-neutral-800">
                        <th className="text-left px-4 py-2 font-medium">Resource</th>
                        <th className="text-right px-4 py-2 font-medium">Providers</th>
                        <th className="text-right px-4 py-2 font-medium">Avg Price</th>
                        <th className="text-right px-4 py-2 font-medium">Lowest</th>
                        <th className="text-right px-4 py-2 font-medium">Unit</th>
                        <th className="text-center px-4 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                      {supplyResources.map(([type, info]) => (
                        <tr
                          key={type}
                          className="hover:bg-neutral-100/50 dark:hover:bg-neutral-800/30 transition"
                        >
                          <td className="px-4 py-2.5 font-medium text-neutral-800 dark:text-neutral-200 capitalize">
                            {typeLabel(type)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-neutral-700 dark:text-neutral-300">
                            {info.providers}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-neutral-700 dark:text-neutral-300">
                            {info.averagePrice > 0
                              ? `${info.averagePrice.toFixed(2)} Lux`
                              : "free"}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-neutral-700 dark:text-neutral-300">
                            {info.lowestPrice > 0
                              ? `${info.lowestPrice.toFixed(2)} Lux`
                              : "free"}
                          </td>
                          <td className="px-4 py-2.5 text-right text-neutral-500">
                            {info.unit || "--"}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            {info.providers > 0 ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25 font-medium">
                                Available
                              </span>
                            ) : (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25 font-medium">
                                Needed
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ---- 3. Demand ---- */}
            <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                  Demand &mdash; What&apos;s Being Used
                </h2>
              </div>

              {/* Task metrics */}
              {tasks && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-4 py-4 border-b border-neutral-200 dark:border-neutral-800">
                  <div className="text-center">
                    <p className="text-xs text-neutral-500">Active Tasks</p>
                    <p className="text-lg font-mono font-bold text-emerald-400">
                      {tasks.active}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-neutral-500">Queued</p>
                    <p className="text-lg font-mono font-bold text-amber-400">
                      {tasks.queued}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-neutral-500">Total Processed</p>
                    <p className="text-lg font-mono font-bold text-neutral-800 dark:text-neutral-200">
                      {tasks.totalProcessed}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-neutral-500">Success Rate</p>
                    <p
                      className={`text-lg font-mono font-bold ${
                        tasks.successRate >= 80
                          ? "text-green-400"
                          : tasks.successRate >= 50
                          ? "text-amber-400"
                          : "text-red-400"
                      }`}
                    >
                      {Math.round(tasks.successRate)}%
                    </p>
                  </div>
                </div>
              )}

              {/* Per-resource demand */}
              {demandResources.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-neutral-500">
                    No usage data available yet.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {demandResources.map(([type, info]) => (
                    <div
                      key={type}
                      className="px-4 py-3 flex items-center justify-between hover:bg-neutral-100/50 dark:hover:bg-neutral-800/30 transition"
                    >
                      <div>
                        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 capitalize">
                          {typeLabel(type)}
                        </p>
                        <p className="text-xs text-neutral-500 mt-0.5">
                          {info.contributingNodes} contributing node
                          {info.contributingNodes !== 1 ? "s" : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-mono text-neutral-700 dark:text-neutral-300">
                          {info.totalUsage.toLocaleString()}{" "}
                          <span className="text-neutral-500 text-xs">
                            {info.unit}
                          </span>
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ---- 4. Reward Signals ---- */}
            <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                  Reward Signals &mdash; What You&apos;d Earn
                </h2>
                {data.rewards?.totalDistributed != null && (
                  <span className="text-[10px] text-neutral-500 font-mono">
                    {formatLux(data.rewards.totalDistributed)} Lux distributed
                  </span>
                )}
              </div>

              {rewardEntries.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-neutral-500">
                    No reward data available yet.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {rewardEntries.map(([type, info]) => (
                    <div
                      key={type}
                      className="px-4 py-3 hover:bg-neutral-100/50 dark:hover:bg-neutral-800/30 transition"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 capitalize">
                          {typeLabel(type)}
                        </p>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-neutral-500 font-mono">
                            {info.rate.toFixed(2)} Lux/unit
                          </span>
                          <span className="text-sm font-mono font-bold text-amber-400">
                            ~{info.estimatedDaily.toFixed(1)} Lux/day
                          </span>
                        </div>
                      </div>
                      {/* Earnings bar */}
                      <div className="w-full bg-neutral-200 dark:bg-neutral-800 rounded-full h-1.5">
                        <div
                          className="h-1.5 rounded-full bg-gradient-to-r from-amber-500 to-emerald-500 transition-all duration-500"
                          style={{
                            width: earningBarWidth(info.estimatedDaily, maxDailyReward),
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ---- 5. Call to Action ---- */}
            <div className="bg-gradient-to-br from-amber-500/10 to-emerald-500/10 border border-amber-500/20 rounded-xl p-6 text-center">
              <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100 mb-2">
                Want to earn Lux? Run a Pando node and contribute resources.
              </h3>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-xl mx-auto mb-4">
                Nodes earn Lux for uptime, compute, storage, and task completion.
                The more scarce the resource, the higher the reward.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 text-xs font-mono text-neutral-500 dark:text-neutral-400">
                <span className="bg-neutral-200 dark:bg-neutral-800 px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700">
                  1. Start a node
                </span>
                <span className="hidden sm:inline text-neutral-400">&rarr;</span>
                <span className="bg-neutral-200 dark:bg-neutral-800 px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700">
                  2. Login
                </span>
                <span className="hidden sm:inline text-neutral-400">&rarr;</span>
                <span className="bg-neutral-200 dark:bg-neutral-800 px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700">
                  3. /contribute to offer resources
                </span>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/* -- Stat Card Component ------------------------------------ */

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: string;
}) {
  return (
    <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
      <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">
        {label}
      </p>
      <p
        className={`text-lg font-mono font-bold ${
          accent || "text-neutral-800 dark:text-neutral-200"
        }`}
      >
        {value ?? "--"}
      </p>
    </div>
  );
}
