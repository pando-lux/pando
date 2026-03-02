"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types -------------------------------------------------- */

interface MonitorStatus {
  nodeHealth?: string;
  uptime?: number;
  memoryUsage?: { heapUsed?: number; heapTotal?: number; rss?: number };
}

interface StatusData {
  connected?: boolean;
  peers?: number;
  totalAccounts?: number;
  totalSupply?: number;
}

interface Worker {
  id: string;
  role: string;
  status: string;
  spawnedAt: string;
  lastReportAt: string | null;
  lastReport: string | null;
}

interface Commit {
  hash: string;
  message: string;
}

interface CouncilInfo {
  orchestratorId: string;
  status: string;
  role: string;
  lastTickAt: string;
  sessionId: string | null;
  createdAt: string;
  budgetSpent: number;
}

interface DashboardData {
  council: CouncilInfo;
  workers: Worker[];
  recentCommits: Commit[];
  observer?: { status: string; lastTickAt: string } | null;
}

interface ActivityEvent {
  type: string;
  description: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface Directive {
  id: number;
  content: string;
  status: string;
  createdAt: string;
  source?: string;
}

interface Agent {
  id: string;
  role: string;
  status: string;
  lastTickAt?: string;
}

/* -- State -------------------------------------------------- */

interface AllData {
  monitor: MonitorStatus | null;
  status: StatusData | null;
  council: DashboardData | null;
  activity: ActivityEvent[];
  directives: Directive[];
  agents: Agent[];
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

function healthDotColor(health: string): string {
  const h = health?.toLowerCase() || "";
  if (h === "healthy") return "bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.5)]";
  if (h === "degraded") return "bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.5)]";
  if (h === "critical") return "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.5)]";
  return "bg-neutral-500";
}

function statusBadgeColor(status: string): string {
  const s = status?.toLowerCase() || "";
  if (s === "active" || s === "idle" || s === "running") return "bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
  if (s === "failed" || s === "error" || s === "critical") return "bg-red-500/10 dark:bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30";
  if (s === "done" || s === "completed" || s === "dissolved") return "bg-neutral-500/10 dark:bg-neutral-500/20 text-neutral-600 dark:text-neutral-400 border-neutral-500/30";
  if (s === "pending") return "bg-yellow-500/10 dark:bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 border-yellow-500/30";
  if (s === "acknowledged") return "bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30";
  return "bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30";
}

function eventIcon(type: string): string {
  if (type.includes("commit")) return "\u2022";
  if (type.includes("proposal") || type.includes("upgrade")) return "\u25B2";
  if (type.includes("spawn") || type.includes("worker")) return "\u25CF";
  if (type.includes("deploy")) return "\u25BA";
  if (type.includes("error") || type.includes("fail")) return "\u2716";
  return "\u25CB";
}

function eventColor(type: string): string {
  if (type.includes("commit")) return "text-emerald-400";
  if (type.includes("proposal") || type.includes("upgrade")) return "text-purple-400";
  if (type.includes("spawn")) return "text-blue-400";
  if (type.includes("deploy")) return "text-cyan-400";
  if (type.includes("error") || type.includes("fail")) return "text-red-400";
  return "text-neutral-500";
}

function formatMemory(bytes: number): string {
  if (!bytes) return "--";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

/* -- Page ---------------------------------------------------- */

export default function DashboardPage() {
  const [data, setData] = useState<AllData>({
    monitor: null,
    status: null,
    council: null,
    activity: [],
    directives: [],
    agents: [],
  });
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const fetchAll = useCallback(async () => {
    const results: Partial<AllData> = {};
    const errs: Record<string, string> = {};

    const fetches = await Promise.allSettled([
      fetch("/api/monitor/status", { signal: AbortSignal.timeout(5000), cache: "no-store" })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))),
      fetch("/api/status", { signal: AbortSignal.timeout(5000), cache: "no-store" })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))),
      fetch("/api/council/dashboard", { signal: AbortSignal.timeout(8000), cache: "no-store" })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))),
      fetch("/api/activity/stream?limit=20", { signal: AbortSignal.timeout(5000), cache: "no-store" })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))),
      fetch("/api/council/directive", { signal: AbortSignal.timeout(5000), cache: "no-store" })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))),
      fetch("/api/agents/list", { signal: AbortSignal.timeout(5000), cache: "no-store" })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))),
    ]);

    if (fetches[0].status === "fulfilled") results.monitor = fetches[0].value;
    else errs.monitor = "Monitor unreachable";

    if (fetches[1].status === "fulfilled") results.status = fetches[1].value;
    else errs.status = "Status unreachable";

    if (fetches[2].status === "fulfilled") results.council = fetches[2].value;
    else errs.council = "Council unreachable";

    if (fetches[3].status === "fulfilled") {
      const val = fetches[3].value;
      results.activity = Array.isArray(val) ? val : (val?.events || []);
    } else errs.activity = "Activity unreachable";

    if (fetches[4].status === "fulfilled") {
      const val = fetches[4].value;
      results.directives = Array.isArray(val) ? val : (val?.directives || []);
    } else errs.directives = "Directives unreachable";

    if (fetches[5].status === "fulfilled") {
      const val = fetches[5].value;
      results.agents = Array.isArray(val) ? val : (val?.agents || []);
    } else errs.agents = "Agents unreachable";

    setData(prev => ({
      monitor: results.monitor ?? prev.monitor,
      status: results.status ?? prev.status,
      council: results.council ?? prev.council,
      activity: results.activity ?? prev.activity,
      directives: results.directives ?? prev.directives,
      agents: results.agents ?? prev.agents,
    }));
    setErrors(errs);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    const i = setInterval(fetchAll, 15000);
    return () => clearInterval(i);
  }, [fetchAll]);

  /* -- Derived values ---------------------------------------- */

  const activeWorkerCount = (data.council?.workers || [])
    .filter(w => ["active", "running", "idle", "spawning"].includes(w.status?.toLowerCase())).length;
  const totalWorkerCount = (data.council?.workers || []).length;
  const recentCommits = (data.council?.recentCommits || []).slice(0, 8);
  const latestCommit = recentCommits[0];
  const qaAgent = data.agents.find(a => a.role?.toLowerCase().includes("qa"));
  const pendingDirectives = data.directives.filter(d => d.status === "pending" || d.status === "acknowledged");

  /* -- Render ------------------------------------------------ */

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Dashboard
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Unified operational overview. Auto-refreshes every 15s.
          </p>
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="text-center py-16 text-neutral-500">
            <div className="inline-block w-6 h-6 border-2 border-neutral-300 dark:border-neutral-600 border-t-neutral-600 dark:border-t-neutral-300 rounded-full animate-spin mb-3" />
            <p className="text-sm">Loading dashboard...</p>
          </div>
        )}

        {!loading && (
          <>
            {/* Section 1: Status Cards Row */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {/* Node Health */}
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-2">Node Health</p>
                {errors.monitor ? (
                  <p className="text-xs text-red-400">{errors.monitor}</p>
                ) : (
                  <>
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`w-2 h-2 rounded-full ${healthDotColor(data.monitor?.nodeHealth || "")}`} />
                      <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-200 capitalize">
                        {data.monitor?.nodeHealth || "--"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-neutral-500">
                      <span>Uptime: {formatUptime(data.monitor?.uptime || 0)}</span>
                      <span>Mem: {formatMemory(data.monitor?.memoryUsage?.heapUsed || 0)}</span>
                    </div>
                  </>
                )}
              </div>

              {/* Peers */}
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-2">Network</p>
                {errors.status ? (
                  <p className="text-xs text-red-400">{errors.status}</p>
                ) : (
                  <>
                    <p className="text-2xl font-bold font-mono text-indigo-600 dark:text-indigo-400">
                      {data.status?.peers ?? "--"}
                    </p>
                    <p className="text-xs text-neutral-500 mb-1">connected peers</p>
                    <div className="flex items-center justify-between text-xs text-neutral-500">
                      <span>Accounts: {data.status?.totalAccounts ?? "--"}</span>
                      <span>Supply: {data.status?.totalSupply ?? "--"}</span>
                    </div>
                  </>
                )}
              </div>

              {/* Active Workers */}
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-2">Workers</p>
                {errors.council ? (
                  <p className="text-xs text-red-400">{errors.council}</p>
                ) : (
                  <>
                    <div className="flex items-baseline gap-1">
                      <span className="text-2xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
                        {activeWorkerCount}
                      </span>
                      <span className="text-sm text-neutral-500">/ {totalWorkerCount}</span>
                    </div>
                    <p className="text-xs text-neutral-500">active workers</p>
                  </>
                )}
              </div>

              {/* Recent Commits */}
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-2">Commits</p>
                {errors.council ? (
                  <p className="text-xs text-red-400">{errors.council}</p>
                ) : (
                  <>
                    <p className="text-2xl font-bold font-mono text-amber-600 dark:text-amber-400">
                      {recentCommits.length}
                    </p>
                    {latestCommit ? (
                      <p className="text-xs text-neutral-500 mt-1 truncate">
                        <span className="font-mono text-indigo-600 dark:text-indigo-400">
                          {latestCommit.hash?.slice(0, 7)}
                        </span>{" "}
                        {truncate(latestCommit.message, 30)}
                      </p>
                    ) : (
                      <p className="text-xs text-neutral-500">No recent commits</p>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Section 2: Orchestrator Cards Row */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* CEO (Council) */}
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">CEO (Council)</h3>
                  {data.council?.council?.status && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${statusBadgeColor(data.council.council.status)}`}>
                      {data.council.council.status}
                    </span>
                  )}
                </div>
                {errors.council ? (
                  <p className="text-xs text-red-400">{errors.council}</p>
                ) : data.council?.council ? (
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Last Tick</span>
                      <span className="text-neutral-300">{relativeTime(data.council.council.lastTickAt)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Session</span>
                      <span className="font-mono text-neutral-300">
                        {data.council.council.sessionId ? data.council.council.sessionId.slice(0, 8) : "none"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Budget</span>
                      <span className="font-mono text-amber-400">
                        ${data.council.council.budgetSpent?.toFixed(2) ?? "0.00"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-neutral-500">Not running</p>
                )}
              </div>

              {/* Observer */}
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">Observer</h3>
                  {data.council?.observer?.status && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${statusBadgeColor(data.council.observer.status)}`}>
                      {data.council.observer.status}
                    </span>
                  )}
                </div>
                {errors.council ? (
                  <p className="text-xs text-red-400">{errors.council}</p>
                ) : data.council?.observer ? (
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Status</span>
                      <span className="text-neutral-300 capitalize">{data.council.observer.status}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Last Tick</span>
                      <span className="text-neutral-300">{relativeTime(data.council.observer.lastTickAt)}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-neutral-500">Not running</p>
                )}
              </div>

              {/* QA Agent */}
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">QA Agent</h3>
                  {qaAgent?.status && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${statusBadgeColor(qaAgent.status)}`}>
                      {qaAgent.status}
                    </span>
                  )}
                </div>
                {errors.agents ? (
                  <p className="text-xs text-red-400">{errors.agents}</p>
                ) : qaAgent ? (
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Status</span>
                      <span className="text-neutral-300 capitalize">{qaAgent.status}</span>
                    </div>
                    {qaAgent.lastTickAt && (
                      <div className="flex justify-between">
                        <span className="text-neutral-500">Last Tick</span>
                        <span className="text-neutral-300">{relativeTime(qaAgent.lastTickAt)}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-neutral-500">Not running</p>
                )}
              </div>
            </div>

            {/* Section 3: Two-Column Layout */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
              {/* Left column: Activity Feed (~60%) */}
              <div className="lg:col-span-3 bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
                  <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                    Live Activity Feed
                  </h2>
                </div>
                {errors.activity ? (
                  <div className="px-4 py-6 text-center">
                    <p className="text-xs text-red-400">{errors.activity}</p>
                  </div>
                ) : data.activity.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <p className="text-sm text-neutral-500">No recent activity.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-neutral-200 dark:divide-neutral-800 max-h-[480px] overflow-y-auto">
                    {data.activity.map((event, i) => (
                      <div key={i} className="px-4 py-2.5 flex items-start gap-3 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                        <span className={`mt-0.5 text-sm ${eventColor(event.type)}`}>
                          {eventIcon(event.type)}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-neutral-600 dark:text-neutral-300 break-words">
                            {event.description || event.type}
                          </p>
                          <p className="text-[10px] text-neutral-500 mt-0.5">
                            {relativeTime(event.timestamp)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Right column (~40%) */}
              <div className="lg:col-span-2 space-y-4">
                {/* Active Directives */}
                <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
                    <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                      Active Directives
                      {pendingDirectives.length > 0 && (
                        <span className="ml-2 text-xs font-normal text-neutral-500">
                          ({pendingDirectives.length})
                        </span>
                      )}
                    </h2>
                  </div>
                  {errors.directives ? (
                    <div className="px-4 py-4 text-center">
                      <p className="text-xs text-red-400">{errors.directives}</p>
                    </div>
                  ) : pendingDirectives.length === 0 ? (
                    <div className="px-4 py-6 text-center">
                      <p className="text-sm text-neutral-500">No active directives.</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-neutral-200 dark:divide-neutral-800 max-h-[240px] overflow-y-auto">
                      {pendingDirectives.map((d) => (
                        <div key={d.id} className="px-4 py-2.5 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400">
                              #{d.id}
                            </span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${statusBadgeColor(d.status)}`}>
                              {d.status}
                            </span>
                            <span className="text-[10px] text-neutral-500 ml-auto">
                              {relativeTime(d.createdAt)}
                            </span>
                          </div>
                          <p className="text-xs text-neutral-600 dark:text-neutral-400 break-words">
                            {truncate(d.content, 100)}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Recent Commits */}
                <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
                    <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                      Recent Commits
                    </h2>
                  </div>
                  {errors.council ? (
                    <div className="px-4 py-4 text-center">
                      <p className="text-xs text-red-400">{errors.council}</p>
                    </div>
                  ) : recentCommits.length === 0 ? (
                    <div className="px-4 py-6 text-center">
                      <p className="text-sm text-neutral-500">No recent commits.</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                      {recentCommits.map((c) => (
                        <div key={c.hash} className="px-4 py-2 flex items-start gap-2 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                          <span className="text-[10px] font-mono text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5">
                            {c.hash?.slice(0, 7)}
                          </span>
                          <span className="text-xs text-neutral-600 dark:text-neutral-300 break-words">
                            {truncate(c.message, 60)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
