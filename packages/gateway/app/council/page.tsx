"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types matching actual backend responses -------------------- */

/** GET /v1/council/status response shape */
interface CouncilStatus {
  active: boolean;
  engines: CouncilEngine[];
  schedules: CouncilSchedule[];
}

interface CouncilEngine {
  id: string;
  role: string;
  status: string;
}

interface CouncilSchedule {
  name: string;
  interval: number;
}

/** GET /v1/council/board response shape */
interface BoardTask {
  id: string;
  title: string;
  status: string;
  created_at: string;
  progress: number;
  assignedAgent?: string;
  description?: string;
}

/** POST /v1/council/trigger/:agent response shape */
interface TriggerResult {
  agent: string;
  toolCalls: { tool: string; args?: any; success?: boolean; output?: string }[];
  response: string;
}

/* -- Helpers ---------------------------------------------------- */

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

function truncate(str: string, len: number): string {
  if (!str) return "--";
  return str.length > len ? str.slice(0, len) + "..." : str;
}

function statusColor(status: string): string {
  const s = status?.toLowerCase() || "";
  if (s === "active" || s === "idle" || s === "running")
    return "bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
  if (s === "failed" || s === "error")
    return "bg-red-500/10 dark:bg-red-500/20 text-red-600 dark:text-red-400 border-red-500/30";
  if (s === "done" || s === "completed" || s === "dissolved")
    return "bg-neutral-500/10 dark:bg-neutral-500/20 text-neutral-600 dark:text-neutral-400 border-neutral-500/30";
  return "bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30";
}

function taskStatusColor(status: string): string {
  switch (status) {
    case "pending":
      return "bg-amber-500/10 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400 border-amber-500/30";
    case "in_progress":
      return "bg-blue-500/10 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30";
    case "done":
      return "bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
    default:
      return statusColor(status);
  }
}

function formatInterval(ms: number): string {
  if (!ms || ms <= 0) return "--";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

function engineRoleLabel(id: string): string {
  switch (id) {
    case "observer": return "Observer";
    case "qa": return "QA";
    case "council": return "Council Lead";
    default: return id;
  }
}

function engineRoleDescription(id: string): string {
  switch (id) {
    case "observer": return "Monitors codebase and reports findings";
    case "qa": return "Runs health checks and tests";
    case "council": return "Reviews board, coordinates agents";
    default: return "";
  }
}

/* -- Page ------------------------------------------------------- */

export default function CouncilPage() {
  /* Council status state */
  const [status, setStatus] = useState<CouncilStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  /* Board state */
  const [boardTasks, setBoardTasks] = useState<BoardTask[]>([]);
  const [boardError, setBoardError] = useState<string | null>(null);

  /* Submit report state */
  const [reportMessage, setReportMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{
    type: "success" | "error" | "ratelimit";
    text: string;
  } | null>(null);

  /* Trigger agent state */
  const [triggering, setTriggering] = useState<string | null>(null);
  const [triggerResult, setTriggerResult] = useState<TriggerResult | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  /* ---- Data fetching ------------------------------------------ */

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/council/dashboard");
      if (res.ok) {
        setStatus(await res.json());
        setStatusError(null);
      } else {
        setStatusError(`Failed to load status (${res.status})`);
      }
    } catch {
      setStatusError("Node not reachable");
    }
    setStatusLoading(false);
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
        setSubmitResult({
          type: "success",
          text: `Report submitted! Task ID: ${json.taskId}`,
        });
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

  const triggerAgent = async (agentId: string) => {
    setTriggering(agentId);
    setTriggerResult(null);
    setTriggerError(null);
    try {
      const res = await fetch("/api/council/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agentId }),
      });
      if (res.ok) {
        setTriggerResult(await res.json());
      } else {
        const json = await res.json().catch(() => ({ error: "Unknown error" }));
        setTriggerError(json.error || `Trigger failed (${res.status})`);
      }
    } catch {
      setTriggerError("Node unreachable");
    }
    setTriggering(null);
  };

  useEffect(() => {
    fetchStatus();
    fetchBoard();
    const i = setInterval(() => {
      fetchStatus();
      fetchBoard();
    }, 30000);
    return () => clearInterval(i);
  }, [fetchStatus, fetchBoard]);

  /* ---- Derived data ------------------------------------------- */

  const activeEngines = status?.engines || [];
  const schedules = status?.schedules || [];
  const pendingTasks = boardTasks.filter((t) => t.status === "pending" || t.status === "in_progress");
  const doneTasks = boardTasks.filter((t) => t.status !== "pending" && t.status !== "in_progress");

  /* ---- Render ------------------------------------------------- */

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Council Dashboard
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Real-time view of the autonomous AI council. Auto-refreshes every 30s.
          </p>
        </div>

        {/* Loading */}
        {statusLoading && (
          <div className="text-center py-16 text-neutral-500">
            <div className="inline-block w-6 h-6 border-2 border-neutral-300 dark:border-neutral-600 border-t-neutral-600 dark:border-t-neutral-300 rounded-full animate-spin mb-3" />
            <p className="text-sm">Loading council data...</p>
          </div>
        )}

        {/* Error */}
        {!statusLoading && statusError && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5 text-center">
            <p className="text-sm text-red-600 dark:text-red-400">{statusError}</p>
            <p className="text-xs text-neutral-500 mt-1">
              Make sure a Pando node is running and reachable.
            </p>
          </div>
        )}

        {!statusLoading && !statusError && status && (
          <>
            {/* Status Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 text-center hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-1">Council</p>
                <div className="flex items-center justify-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      status.active
                        ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"
                        : "bg-neutral-500"
                    }`}
                  />
                  <span className="text-sm font-semibold text-neutral-700 dark:text-neutral-200">
                    {status.active ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>

              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 text-center hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-1">Engines</p>
                <p className="text-lg font-mono font-bold text-indigo-600 dark:text-indigo-400">
                  {activeEngines.length}
                </p>
              </div>

              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl p-3 text-center col-span-2 sm:col-span-1 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors">
                <p className="text-xs text-neutral-500 mb-1">Board Tasks</p>
                <p className="text-lg font-mono font-bold text-amber-600 dark:text-amber-400">
                  {boardTasks.length}
                  {pendingTasks.length > 0 && (
                    <span className="text-xs font-normal text-neutral-500 ml-1">
                      ({pendingTasks.length} active)
                    </span>
                  )}
                </p>
              </div>
            </div>

            {/* Council Engines */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                  Council Agents
                  <span className="ml-2 text-xs font-normal text-neutral-500">
                    ({activeEngines.length})
                  </span>
                </h2>
                <button
                  onClick={fetchStatus}
                  className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition"
                >
                  Refresh
                </button>
              </div>
              {activeEngines.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-neutral-500">
                    No council engines running.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {activeEngines.map((engine) => (
                    <div
                      key={engine.id}
                      className="px-4 py-3 hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                              {engineRoleLabel(engine.id)}
                            </span>
                            <span
                              className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${statusColor(engine.status)}`}
                            >
                              {engine.status}
                            </span>
                            {engine.role && engine.role !== engine.id && (
                              <span className="text-[10px] text-neutral-500 font-mono">
                                role: {engine.role}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-neutral-500">
                            {engineRoleDescription(engine.id)}
                          </p>
                        </div>
                        <button
                          onClick={() => triggerAgent(engine.id)}
                          disabled={triggering !== null}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                        >
                          {triggering === engine.id ? "Running..." : "Trigger"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Trigger Result */}
            {(triggerResult || triggerError) && (
              <div
                className={`border rounded-xl p-4 ${
                  triggerError
                    ? "bg-red-500/10 border-red-500/20"
                    : "bg-emerald-500/10 border-emerald-500/20"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                    {triggerError ? "Trigger Failed" : `Agent: ${triggerResult!.agent}`}
                  </h3>
                  <button
                    onClick={() => {
                      setTriggerResult(null);
                      setTriggerError(null);
                    }}
                    className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                  >
                    Dismiss
                  </button>
                </div>
                {triggerError && (
                  <p className="text-sm text-red-600 dark:text-red-400">{triggerError}</p>
                )}
                {triggerResult && (
                  <>
                    {triggerResult.toolCalls.length > 0 && (
                      <div className="mb-2">
                        <p className="text-xs text-neutral-500 mb-1">Tool calls:</p>
                        <div className="flex flex-wrap gap-1.5">
                          {triggerResult.toolCalls.map((tc, i) => (
                            <span
                              key={i}
                              className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${
                                tc.success === false
                                  ? "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30"
                                  : "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30"
                              }`}
                            >
                              {tc.tool}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {triggerResult.response && (
                      <p className="text-xs text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
                        {triggerResult.response}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Schedules */}
            {schedules.length > 0 && (
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
                  <h2 className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">
                    Schedules
                    <span className="ml-2 text-xs font-normal text-neutral-500">
                      ({schedules.length})
                    </span>
                  </h2>
                </div>
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {schedules.map((s) => (
                    <div
                      key={s.name}
                      className="px-4 py-2.5 flex items-center justify-between hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors"
                    >
                      <span className="text-sm font-mono text-neutral-700 dark:text-neutral-200">
                        {s.name}
                      </span>
                      <span className="text-xs text-neutral-500">
                        every {formatInterval(s.interval)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Board Tasks */}
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

                        return (
                          <tr
                            key={task.id}
                            className="hover:bg-neutral-200 dark:hover:bg-neutral-800/50 transition-colors"
                          >
                            <td className="px-4 py-2.5 text-neutral-700 dark:text-neutral-200 max-w-md">
                              <div className="flex items-center gap-2">
                                {severityBadge && (
                                  <span
                                    className={`shrink-0 text-[10px] px-2 py-0.5 rounded-full font-medium border ${severityBadge}`}
                                  >
                                    {severityLabel}
                                  </span>
                                )}
                                <span className="truncate" title={task.title}>
                                  {truncate(task.title, 70)}
                                </span>
                                {task.progress > 0 && (
                                  <span className="text-[10px] text-neutral-500 shrink-0">
                                    {task.progress}%
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-2.5">
                              <span
                                className={`inline-block text-[10px] px-2 py-0.5 rounded-full font-medium border ${taskStatusColor(task.status)}`}
                              >
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

            {/* Submit Report */}
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
                  <span
                    className={`text-xs ${
                      reportMessage.length < 5 || reportMessage.length > 500
                        ? "text-amber-500"
                        : "text-neutral-500"
                    }`}
                  >
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
          </>
        )}
      </main>
    </div>
  );
}
