"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types -------------------------------------------------- */

interface CouncilInfo {
  orchestratorId: string;
  status: string;
  role: string;
  lastTickAt: string;
  sessionId: string | null;
  createdAt: string;
  budgetSpent: number;
}

interface Worker {
  id: string;
  role: string;
  status: string;
  spawnedAt: string;
  lastReportAt: string | null;
  lastReport: string | null;
}

interface Tick {
  tickNumber: number;
  tier: number;
  actions: string;
  durationMs: number;
  at: string;
}

interface Commit {
  hash: string;
  message: string;
}

interface NetworkInfo {
  peerId: string | null;
  peers: number;
  uptime: number;
}

interface Lesson {
  lesson: string;
  source: string | null;
  confidence: number;
  createdAt: string;
}

interface DashboardData {
  council: CouncilInfo;
  workers: Worker[];
  recentTicks: Tick[];
  recentCommits: Commit[];
  network: NetworkInfo;
  lessons: Lesson[];
}

/* -- Helpers ------------------------------------------------- */

function relativeTime(dateStr: string): string {
  if (!dateStr) return "--";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds <= 0) return "--";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function truncate(str: string, len: number): string {
  if (!str) return "--";
  return str.length > len ? str.slice(0, len) + "..." : str;
}

function statusColor(status: string): string {
  const s = status?.toLowerCase() || "";
  if (s === "active" || s === "idle" || s === "running") return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
  if (s === "failed" || s === "error") return "bg-red-500/20 text-red-400 border-red-500/30";
  if (s === "done" || s === "completed" || s === "dissolved") return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
  return "bg-amber-500/20 text-amber-400 border-amber-500/30";
}

function parseActions(actionsStr: string): string[] {
  try {
    const parsed = JSON.parse(actionsStr);
    if (Array.isArray(parsed)) {
      return parsed.map((a: { type?: string; action?: string }) => a.type || a.action || "unknown");
    }
    if (typeof parsed === "object" && parsed !== null) {
      return [parsed.type || parsed.action || "unknown"];
    }
    return [String(parsed)];
  } catch {
    if (!actionsStr || actionsStr === "null" || actionsStr === "[]") return [];
    return [actionsStr];
  }
}

function actionBadgeColor(action: string): string {
  if (action.includes("spawn")) return "bg-blue-500/20 text-blue-400 border-blue-500/30";
  if (action.includes("commit")) return "bg-emerald-500/20 text-emerald-400 border-emerald-500/30";
  if (action.includes("propose") || action.includes("upgrade")) return "bg-purple-500/20 text-purple-400 border-purple-500/30";
  if (action.includes("respond")) return "bg-cyan-500/20 text-cyan-400 border-cyan-500/30";
  if (action.includes("dissolve") || action.includes("kill")) return "bg-red-500/20 text-red-400 border-red-500/30";
  return "bg-amber-500/20 text-amber-400 border-amber-500/30";
}

/* -- Page ---------------------------------------------------- */

export default function CouncilPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedLessons, setExpandedLessons] = useState<Set<number>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/council/dashboard");
      if (res.ok) {
        setData(await res.json());
        setError(null);
      } else {
        setError(`Failed to load dashboard (${res.status})`);
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

  const toggleLesson = (idx: number) => {
    setExpandedLessons((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const tier2Ticks = (data?.recentTicks || [])
    .filter((t) => t.tier === 2)
    .slice(0, 10);

  const recentCommits = (data?.recentCommits || []).slice(0, 10);
  const lessons = data?.lessons || [];

  /* -- Render ------------------------------------------------ */

  return (
    <div className="min-h-screen bg-neutral-950">
      <NavBar />
      <main className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
        {/* 1. Header */}
        <div>
          <h1 className="text-2xl font-bold text-neutral-100">
            Council Dashboard
          </h1>
          <p className="text-sm text-neutral-400 mt-1">
            Real-time view of the autonomous AI council. Auto-refreshes every 30s.
          </p>
        </div>

        {/* Loading */}
        {loading && (
          <div className="text-center py-16 text-neutral-500">
            <div className="inline-block w-6 h-6 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin mb-3" />
            <p className="text-sm">Loading council data...</p>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5 text-center">
            <p className="text-sm text-red-400">{error}</p>
            <p className="text-xs text-neutral-500 mt-1">
              Make sure a Pando node is running and reachable.
            </p>
          </div>
        )}

        {!loading && !error && data && (
          <>
            {/* 2. Status Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-3 text-center">
                <p className="text-xs text-neutral-500 mb-1">Status</p>
                <div className="flex items-center justify-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      data.council.status === "active"
                        ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                        : "bg-neutral-500"
                    }`}
                  />
                  <span className="text-sm font-semibold text-neutral-200 capitalize">
                    {data.council.status || "--"}
                  </span>
                </div>
              </div>

              <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-3 text-center">
                <p className="text-xs text-neutral-500 mb-1">Session</p>
                <p className="text-xs font-mono text-neutral-300">
                  {data.council.sessionId
                    ? truncate(data.council.sessionId, 12)
                    : "none"}
                </p>
              </div>

              <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-3 text-center">
                <p className="text-xs text-neutral-500 mb-1">Uptime</p>
                <p className="text-sm font-mono font-bold text-neutral-200">
                  {formatUptime(data.network.uptime)}
                </p>
              </div>

              <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-3 text-center">
                <p className="text-xs text-neutral-500 mb-1">Peers</p>
                <p className="text-lg font-mono font-bold text-indigo-400">
                  {data.network.peers}
                </p>
              </div>

              <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-3 text-center col-span-2 sm:col-span-1">
                <p className="text-xs text-neutral-500 mb-1">Budget Spent</p>
                <p className="text-sm font-mono font-bold text-amber-400">
                  ${data.council.budgetSpent?.toFixed(2) ?? "0.00"}
                </p>
              </div>
            </div>

            {/* 3. Active Workers */}
            <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-300">
                  Active Workers
                </h2>
              </div>
              {data.workers.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-neutral-500">
                    No workers currently spawned.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-neutral-500 border-b border-neutral-800">
                        <th className="text-left px-4 py-2 font-medium">Role</th>
                        <th className="text-left px-4 py-2 font-medium">Status</th>
                        <th className="text-left px-4 py-2 font-medium">Spawned</th>
                        <th className="text-left px-4 py-2 font-medium">Last Report</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-800">
                      {data.workers.map((w) => (
                        <tr key={w.id} className="hover:bg-neutral-800/30 transition">
                          <td className="px-4 py-2.5 font-mono text-neutral-200">
                            {w.role}
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={`inline-block text-[10px] px-2 py-0.5 rounded-full font-medium border ${statusColor(w.status)}`}
                            >
                              {w.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-neutral-400 text-xs">
                            {relativeTime(w.spawnedAt)}
                          </td>
                          <td className="px-4 py-2.5 text-neutral-400 text-xs max-w-xs truncate">
                            {w.lastReport ? truncate(w.lastReport, 80) : "--"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 4. Recent Decisions (Tier 2 Ticks) */}
            <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-300">
                  Recent Decisions
                </h2>
              </div>
              {tier2Ticks.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-neutral-500">
                    No Tier 2 decisions yet.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-800">
                  {tier2Ticks.map((tick) => {
                    const actions = parseActions(tick.actions);
                    return (
                      <div key={tick.tickNumber} className="px-4 py-3">
                        <div className="flex items-center gap-3 mb-1.5">
                          <span className="text-xs font-mono text-neutral-500">
                            Tick #{tick.tickNumber}
                          </span>
                          <span className="text-xs text-neutral-600">
                            {tick.durationMs}ms
                          </span>
                          <span className="text-xs text-neutral-600 ml-auto">
                            {relativeTime(tick.at)}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {actions.length > 0 ? (
                            actions.map((action, i) => (
                              <span
                                key={i}
                                className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${actionBadgeColor(action)}`}
                              >
                                {action}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-neutral-600">
                              no actions
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 5. Recent Commits */}
            <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-300">
                  Recent Commits
                </h2>
              </div>
              {recentCommits.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-neutral-500">No recent commits.</p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-800">
                  {recentCommits.map((c) => (
                    <div key={c.hash} className="px-4 py-2.5 flex items-start gap-3">
                      <span className="text-xs font-mono text-indigo-400 shrink-0 mt-0.5">
                        {c.hash?.slice(0, 8)}
                      </span>
                      <span className="text-sm text-neutral-300">
                        {c.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 6. Network */}
            <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-neutral-300 mb-3">
                Network
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-neutral-500 mb-0.5">Peer ID</p>
                  <p className="font-mono text-neutral-300 text-xs">
                    {data.network.peerId
                      ? truncate(data.network.peerId, 20)
                      : "--"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500 mb-0.5">Connected Peers</p>
                  <p className="font-mono text-neutral-200">{data.network.peers}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500 mb-0.5">Uptime</p>
                  <p className="font-mono text-neutral-200">
                    {formatUptime(data.network.uptime)}
                  </p>
                </div>
              </div>
            </div>

            {/* 7. Lessons Learned */}
            <div className="bg-neutral-900/50 border border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-300">
                  Lessons Learned
                </h2>
              </div>
              {lessons.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-neutral-500">
                    No lessons recorded yet.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-800">
                  {lessons.map((l, idx) => {
                    const expanded = expandedLessons.has(idx);
                    return (
                      <button
                        key={idx}
                        onClick={() => toggleLesson(idx)}
                        className="w-full text-left px-4 py-3 hover:bg-neutral-800/30 transition"
                      >
                        <div className="flex items-start gap-2">
                          {l.source && (
                            <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full font-medium border bg-violet-500/20 text-violet-400 border-violet-500/30 mt-0.5">
                              {l.source}
                            </span>
                          )}
                          <span className="text-sm text-neutral-300 flex-1">
                            {expanded ? l.lesson : truncate(l.lesson, 100)}
                          </span>
                          <span className="text-neutral-600 text-xs shrink-0 mt-0.5">
                            {expanded ? "▲" : "▼"}
                          </span>
                        </div>
                        {expanded && (
                          <div className="mt-2 flex gap-4 text-xs text-neutral-500">
                            <span>Confidence: {(l.confidence * 100).toFixed(0)}%</span>
                            <span>{relativeTime(l.createdAt)}</span>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
