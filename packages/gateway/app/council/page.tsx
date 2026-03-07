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

interface BoardTask {
  id: string;
  title: string;
  status: string;
  created_at: string;
  progress: number;
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
  if (s === "active" || s === "idle" || s === "running") return "bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
  if (s === "failed" || s === "error") return "bg-red-500/10 dark:bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30";
  if (s === "done" || s === "completed" || s === "dissolved") return "bg-neutral-500/10 dark:bg-neutral-500/20 text-neutral-600 dark:text-neutral-400 border-neutral-500/30";
  return "bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30";
}

function parseActions(actionsStr: string): string[] {
  try {
    const parsed = JSON.parse(actionsStr);
    if (parsed == null) return [];
    if (Array.isArray(parsed)) {
      return parsed.map((a: any) => typeof a === 'string' ? a : (a.type || a.action || 'unknown'));
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

function formatDuration(ms: number): string {
  if (ms >= 3600000) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }
  if (ms >= 60000) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${s}s`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function actionBadgeColor(action: string): string {
  if (action.includes("spawn")) return "bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30";
  if (action.includes("commit")) return "bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
  if (action.includes("propose") || action.includes("upgrade")) return "bg-purple-500/10 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400 border-purple-500/30";
  if (action.includes("respond")) return "bg-cyan-500/10 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 border-cyan-500/30";
  if (action.includes("dissolve") || action.includes("kill")) return "bg-red-500/10 dark:bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30";
  return "bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30";
}

/* -- Page ---------------------------------------------------- */

export default function CouncilPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedLessons, setExpandedLessons] = useState<Set<number>>(new Set());
  const [showHistorical, setShowHistorical] = useState(false);

  /* Board + Submit state */
  const [boardTasks, setBoardTasks] = useState<BoardTask[]>([]);
  const [boardError, setBoardError] = useState<string | null>(null);
  const [reportMessage, setReportMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ type: "success" | "error" | "ratelimit"; text: string } | null>(null);

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

  const fetchBoard = useCallback(async () => {
    try {
      const res = await fetch("/api/council/board");
      if (res.ok) {
        const json = await res.json();
        setBoardTasks(json.tasks || []);
        setBoardError(null);
      } else {
        setBoardError(`Failed to load board (${res.status})`);
      }
    } catch {
      setBoardError("Board unreachable");
    }
  }, []);

  const submitReport = async () => {
    if (reportMessage.length < 5 || reportMessage.length > 500) return;
    setSubmitting(true);
    setSubmitResult(null);
    try {
      const res = await fetch("/api/council/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: reportMessage }),
      });
      if (res.status === 429) {
        setSubmitResult({ type: "ratelimit", text: "Rate limited. Try again later." });
      } else if (res.ok) {
        const json = await res.json();
        setSubmitResult({ type: "success", text: `Report submitted! Task ID: ${json.taskId}` });
        setReportMessage("");
        fetchBoard();
      } else {
        const json = await res.json().catch(() => ({ error: "Unknown error" }));
        setSubmitResult({ type: "error", text: json.error || "Submission failed" });
      }
    } catch {
      setSubmitResult({ type: "error", text: "Node unreachable" });
    }
    setSubmitting(false);
  };

  useEffect(() => {
    fetchData();
    fetchBoard();
    const i = setInterval(() => { fetchData(); fetchBoard(); }, 30000);
    return () => clearInterval(i);
  }, [fetchData, fetchBoard]);

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
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-6xl mx-auto p-4 sm:p-6 space-y-6">
        {/* 1. Header */}
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Council Dashboard
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Real-time view of the autonomous AI council. Auto-refreshes every 30s.
          </p>
        </div>

        {/* Loading */}
        {loading && (
          <div className="text-center py-16 text-neutral-500">
            <div className="inline-block w-6 h-6 border-2 border-neutral-300 dark:border-neutral-600 border-t-neutral-600 dark:border-t-neutral-300 rounded-full animate-spin mb-3" />
            <p className="text-sm">Loading council data...</p>
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5 text-center">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            <p className="text-xs text-neutral-500 mt-1">
              Make sure a Pando node is running and reachable.
            </p>
          </div>
        )}

        {!loading && !error && data && (
          <>
            {/* 2. Status Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 text-center hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-1">Status</p>
                <div className="flex items-center justify-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      data.council.status === "active"
                        ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                        : "bg-neutral-500"
                    }`}
                  />
                  <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-200 capitalize">
                    {data.council.status || "--"}
                  </span>
                </div>
              </div>

              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 text-center hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-1">Session</p>
                <p className="text-xs font-mono text-neutral-600 dark:text-neutral-300">
                  {data.council.sessionId
                    ? truncate(data.council.sessionId, 12)
                    : "none"}
                </p>
              </div>

              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 text-center hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-1">Uptime</p>
                <p className="text-sm font-mono font-bold text-neutral-700 dark:text-neutral-200">
                  {formatUptime(data.network.uptime)}
                </p>
              </div>

              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 text-center hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-1">Peers</p>
                <p className="text-lg font-mono font-bold text-indigo-600 dark:text-indigo-400">
                  {data.network.peers}
                </p>
              </div>

              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 text-center col-span-2 sm:col-span-1 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-1">Budget Spent</p>
                <p className="text-sm font-mono font-bold text-amber-600 dark:text-amber-400">
                  ${data.council.budgetSpent?.toFixed(2) ?? "0.00"}
                </p>
              </div>
            </div>

            {/* 3. Board Tasks */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                  Board Tasks
                  <span className="ml-2 text-xs font-normal text-neutral-500">
                    ({boardTasks.length})
                  </span>
                </h2>
                <button
                  onClick={fetchBoard}
                  className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition"
                >
                  Refresh
                </button>
              </div>
              {boardError && (
                <div className="px-4 py-2 text-xs text-red-500">{boardError}</div>
              )}
              {boardTasks.length === 0 && !boardError ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-neutral-500">No board tasks.</p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {boardTasks.map((t) => (
                    <div key={t.id} className="px-4 py-3 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                      <div className="flex items-start gap-3">
                        <span className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full font-medium border mt-0.5 ${statusColor(t.status)}`}>
                          {t.status}
                        </span>
                        <span className="text-sm text-neutral-700 dark:text-neutral-200 flex-1">
                          {t.title}
                        </span>
                        {t.progress > 0 && (
                          <span className="text-xs text-neutral-500 shrink-0">{t.progress}%</span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-neutral-500 ml-[calc(0.75rem+2rem)]">
                        {relativeTime(t.created_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 3b. Submit Report */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300 mb-3">
                Submit a Report
              </h2>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={reportMessage}
                  onChange={(e) => setReportMessage(e.target.value)}
                  placeholder="Describe an issue or feature request (5-500 chars)"
                  className="flex-1 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                  maxLength={500}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitReport(); }}
                />
                <button
                  onClick={submitReport}
                  disabled={submitting || reportMessage.length < 5}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-neutral-400 dark:disabled:bg-neutral-600 text-white text-sm font-medium rounded-lg transition shrink-0"
                >
                  {submitting ? "Submitting..." : "Submit"}
                </button>
              </div>
              {submitResult && (
                <p className={`mt-2 text-xs ${
                  submitResult.type === "success" ? "text-emerald-600 dark:text-emerald-400" :
                  submitResult.type === "ratelimit" ? "text-amber-600 dark:text-amber-400" :
                  "text-red-600 dark:text-red-400"
                }`}>
                  {submitResult.text}
                </p>
              )}
              <p className="mt-2 text-xs text-neutral-500">
                {reportMessage.length}/500 characters
              </p>
            </div>

            {/* 4. Active Workers */}
            {(() => {
              const activeStatuses = new Set(["active", "idle", "spawning"]);
              const activeWorkers = data.workers.filter((w) => activeStatuses.has(w.status?.toLowerCase()));
              const historicalWorkers = data.workers.filter((w) => !activeStatuses.has(w.status?.toLowerCase()));
              const renderWorkerTable = (workers: Worker[]) => (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-neutral-500 border-b border-neutral-200 dark:border-neutral-800">
                        <th className="text-left px-4 py-2 font-medium">Role</th>
                        <th className="text-left px-4 py-2 font-medium">Status</th>
                        <th className="text-left px-4 py-2 font-medium">Spawned</th>
                        <th className="text-left px-4 py-2 font-medium">Last Report</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                      {workers.map((w) => (
                        <tr key={w.id} className="hover:bg-neutral-100 dark:hover:bg-neutral-800/30 transition">
                          <td className="px-4 py-2.5 font-mono text-neutral-700 dark:text-neutral-200">
                            {w.role}
                          </td>
                          <td className="px-4 py-2.5">
                            <span
                              className={`inline-block text-[10px] px-2 py-0.5 rounded-full font-medium border ${statusColor(w.status)}`}
                            >
                              {w.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400 text-xs">
                            {relativeTime(w.spawnedAt)}
                          </td>
                          <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400 text-xs max-w-xs truncate">
                            {w.lastReport ? truncate(w.lastReport, 80) : "--"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
              return (
                <>
                  <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
                      <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                        Active Workers
                        <span className="ml-2 text-xs font-normal text-neutral-500">
                          ({activeWorkers.length} active{historicalWorkers.length > 0 ? `, ${historicalWorkers.length} done/failed` : ""})
                        </span>
                      </h2>
                    </div>
                    {activeWorkers.length === 0 ? (
                      <div className="px-4 py-8 text-center">
                        <p className="text-sm text-neutral-500">
                          No workers currently active.
                        </p>
                      </div>
                    ) : (
                      renderWorkerTable(activeWorkers)
                    )}
                  </div>
                  {historicalWorkers.length > 0 && (
                    <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
                      <button
                        onClick={() => setShowHistorical(!showHistorical)}
                        className="w-full px-4 py-3 flex items-center justify-between hover:bg-neutral-100 dark:hover:bg-neutral-800/30 transition"
                      >
                        <h2 className="text-sm font-semibold text-neutral-500">
                          Historical Workers ({historicalWorkers.length})
                        </h2>
                        <span className="text-neutral-600 text-xs">{showHistorical ? "▲" : "▼"}</span>
                      </button>
                      {showHistorical && renderWorkerTable(historicalWorkers)}
                    </div>
                  )}
                </>
              );
            })()}

            {/* 3b. Council Board (Live Tasks) */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                  Council Board
                  {boardTasks.length > 0 && (
                    <span className="ml-2 text-xs font-normal text-neutral-500">
                      ({boardTasks.length} task{boardTasks.length !== 1 ? "s" : ""})
                    </span>
                  )}
                </h2>
              </div>
              {boardError ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-neutral-500">{boardError}</p>
                </div>
              ) : boardTasks.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-neutral-500">
                    No pending tasks on the board.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-neutral-500 border-b border-neutral-200 dark:border-neutral-800">
                        <th className="text-left px-4 py-2 font-medium">Title</th>
                        <th className="text-left px-4 py-2 font-medium">Status</th>
                        <th className="text-left px-4 py-2 font-medium">Created</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                      {boardTasks.map((task) => {
                        const isBug = /^\[BUG:/i.test(task.title);
                        const isFeature = /^\[FEATURE:/i.test(task.title);
                        const severityBadge = isBug
                          ? "bg-red-500/10 dark:bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30"
                          : isFeature
                          ? "bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30"
                          : null;
                        const severityLabel = isBug ? "BUG" : isFeature ? "FEATURE" : null;

                        const taskStatusColor =
                          task.status === "pending"
                            ? "bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30"
                            : task.status === "in_progress"
                            ? "bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30"
                            : task.status === "done"
                            ? "bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                            : statusColor(task.status);

                        return (
                          <tr key={task.id} className="hover:bg-neutral-100 dark:hover:bg-neutral-800/30 transition">
                            <td className="px-4 py-2.5 text-neutral-700 dark:text-neutral-200 max-w-md">
                              <div className="flex items-center gap-2">
                                {severityBadge && (
                                  <span className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full font-medium border ${severityBadge}`}>
                                    {severityLabel}
                                  </span>
                                )}
                                <span className="truncate" title={task.title}>
                                  {truncate(task.title, 70)}
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-2.5">
                              <span className={`inline-block text-[10px] px-2 py-0.5 rounded-full font-medium border ${taskStatusColor}`}>
                                {task.status}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400 text-xs whitespace-nowrap">
                              {relativeTime(task.created_at)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 3c. Submit Report */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                  Submit Report
                </h2>
              </div>
              <div className="p-4 space-y-3">
                <textarea
                  value={reportMessage}
                  onChange={(e) => {
                    setReportMessage(e.target.value);
                    setSubmitResult(null);
                  }}
                  placeholder="Report a bug or suggest a feature..."
                  maxLength={500}
                  rows={3}
                  className="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 resize-none"
                />
                <div className="flex items-center justify-between">
                  <span className={`text-xs ${reportMessage.length < 5 || reportMessage.length > 500 ? "text-amber-500" : "text-neutral-500"}`}>
                    {reportMessage.length}/500
                  </span>
                  <button
                    onClick={submitReport}
                    disabled={submitting || reportMessage.length < 5 || reportMessage.length > 500}
                    className="px-4 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {submitting ? "Submitting..." : "Submit"}
                  </button>
                </div>
                {submitResult && (
                  <div
                    className={`text-sm px-3 py-2 rounded-lg border ${
                      submitResult.type === "success"
                        ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400"
                        : submitResult.type === "ratelimit"
                        ? "bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400"
                        : "bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400"
                    }`}
                  >
                    {submitResult.text}
                  </div>
                )}
              </div>
            </div>

            {/* 4. Recent Decisions (Tier 2 Ticks) */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
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
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {tier2Ticks.map((tick) => {
                    const actions = parseActions(tick.actions);
                    return (
                      <div key={tick.tickNumber} className="px-4 py-3 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                        <div className="flex items-center gap-3 mb-1.5">
                          <span className="text-xs font-mono text-neutral-500">
                            Decision #{tick.tickNumber}
                          </span>
                          <span className="text-xs text-neutral-600">
                            {formatDuration(tick.durationMs)}
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
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                  Recent Commits
                </h2>
              </div>
              {recentCommits.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-neutral-500">No recent commits.</p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {recentCommits.map((c) => (
                    <div key={c.hash} className="px-4 py-2.5 flex items-start gap-3 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                      <span className="text-xs font-mono text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5">
                        {c.hash?.slice(0, 8)}
                      </span>
                      <span className="text-sm text-neutral-600 dark:text-neutral-300">
                        {c.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 6. Network */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-4">
              <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300 mb-3">
                Network
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-neutral-500 mb-0.5">Peer ID</p>
                  <p className="font-mono text-neutral-600 dark:text-neutral-300 text-xs">
                    {data.network.peerId
                      ? truncate(data.network.peerId, 20)
                      : "--"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500 mb-0.5">Connected Peers</p>
                  <p className="font-mono text-neutral-700 dark:text-neutral-200">{data.network.peers}</p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500 mb-0.5">Uptime</p>
                  <p className="font-mono text-neutral-700 dark:text-neutral-200">
                    {formatUptime(data.network.uptime)}
                  </p>
                </div>
              </div>
            </div>

            {/* 7. Lessons Learned */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
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
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {lessons.map((l, idx) => {
                    const expanded = expandedLessons.has(idx);
                    return (
                      <button
                        key={idx}
                        onClick={() => toggleLesson(idx)}
                        className="w-full text-left px-4 py-3 hover:bg-neutral-100 dark:hover:bg-neutral-800/30 transition"
                      >
                        <div className="flex items-start gap-2">
                          {l.source && (
                            <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-full font-medium border bg-violet-500/10 dark:bg-violet-500/20 text-violet-600 dark:text-violet-400 border-violet-500/30 mt-0.5 max-w-[120px] truncate" title={l.source}>
                              {l.source}
                            </span>
                          )}
                          <span className="text-sm text-neutral-600 dark:text-neutral-300 flex-1">
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
