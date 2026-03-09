"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types ------------------------------------------------- */

interface HealthMetrics {
  timestamp: number;
  nodeHealth: "healthy" | "degraded" | "critical";
  peerCount: number;
  schedulerRunning: boolean;
  activeTasks: number;
  recentSuccessRate: number;
  consecutiveFailures: number;
  uptimeSeconds: number;
  lastTaskCompletedAt: number | null;
  alerts: MonitorAlert[];
}

interface MonitorAlert {
  id: string;
  severity: "info" | "warning" | "critical";
  type: string;
  message: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  resolved: boolean;
  resolvedAt?: number;
  acknowledged: boolean;
  acknowledgedAt?: number;
}

interface AuditEntry {
  id: string;
  timestamp: number;
  actor: string;
  action: string;
  reason: string;
  affectedResources: string[];
  outcome: string;
  detail?: string;
  relatedIds: Record<string, string>;
}

interface RecoveryAction {
  trigger: string;
  action: string;
  cooldownMs: number;
  triggerCount: number;
  enabled: boolean;
  lastTriggeredAt?: number;
}

interface GuardrailStatus {
  config: {
    protectedPaths: string[];
    maxSelfChangesPerHour: number;
    maxSelfChangesPerDay: number;
    rollbackOnBuildFailure: boolean;
    rollbackOnTestFailure: boolean;
  };
  changesThisHour: number;
  changesToday: number;
  pendingCount: number;
}

/* -- Helpers ----------------------------------------------- */

function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtUptime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function healthColor(h: string): string {
  if (h === "healthy") return "text-green-500";
  if (h === "degraded") return "text-amber-500";
  return "text-red-500";
}

function healthDot(h: string): string {
  if (h === "healthy") return "bg-green-500";
  if (h === "degraded") return "bg-amber-500";
  return "bg-red-500";
}

function severityColor(s: string): string {
  if (s === "critical") return "text-red-500 bg-red-500/10 border-red-500/20";
  if (s === "warning") return "text-amber-500 bg-amber-500/10 border-amber-500/20";
  return "text-blue-400 bg-blue-500/10 border-blue-500/20";
}

function outcomeColor(o: string): string {
  if (o === "success") return "text-green-400";
  if (o === "failed" || o === "rolled_back") return "text-red-400";
  return "text-amber-400";
}

/* -- Page -------------------------------------------------- */

export default function MonitorPage() {
  const [metrics, setMetrics] = useState<HealthMetrics | null>(null);
  const [alerts, setAlerts] = useState<MonitorAlert[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [recovery, setRecovery] = useState<RecoveryAction[]>([]);
  const [guardrails, setGuardrails] = useState<GuardrailStatus | null>(null);
  const [offline, setOffline] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [mr, ar, aur, rr, gr] = await Promise.all([
        fetch("/api/monitor/status"),
        fetch("/api/monitor/alerts"),
        fetch("/api/monitor/audit"),
        fetch("/api/monitor/recovery"),
        fetch("/api/guardrails/status").catch(() => null),
      ]);
      setOffline(false);
      if (mr.ok) setMetrics(await mr.json());
      if (ar.ok) { const d = await ar.json(); setAlerts(d.alerts || []); }
      if (aur.ok) { const d = await aur.json(); setAudit(d.audit || []); }
      if (rr.ok) { const d = await rr.json(); setRecovery(d.actions || []); }
      if (gr && gr.ok) setGuardrails(await gr.json());
    } catch { setOffline(true); }
  }, []);

  useEffect(() => { refresh(); const i = setInterval(refresh, 5000); return () => clearInterval(i); }, [refresh]);

  const ackAlert = async (id: string) => {
    await fetch(`/api/monitor/alerts/${id}/ack`, { method: "POST" });
    refresh();
  };

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <NavBar />
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* Status Header */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-bold">Monitor</h1>
              {metrics && (
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${healthDot(metrics.nodeHealth)} ${metrics.nodeHealth !== "healthy" ? "animate-pulse" : ""}`} />
                  <span className={`text-sm font-semibold capitalize ${healthColor(metrics.nodeHealth)}`}>
                    {metrics.nodeHealth}
                  </span>
                </div>
              )}
            </div>
            {offline && <span className="text-xs text-red-400 font-mono">Node offline</span>}
          </div>

          {/* Stats Row */}
          {metrics && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mt-4">
              {[
                { label: "Peers", value: metrics.peerCount },
                { label: "Scheduler", value: metrics.schedulerRunning ? "Running" : "Stopped", color: metrics.schedulerRunning ? "text-green-400" : "text-red-400" },
                { label: "Active Tasks", value: metrics.activeTasks },
                { label: "Success Rate", value: `${Math.round(metrics.recentSuccessRate * 100)}%`, color: metrics.recentSuccessRate >= 0.8 ? "text-green-400" : metrics.recentSuccessRate >= 0.5 ? "text-amber-400" : "text-red-400" },
                { label: "Uptime", value: fmtUptime(metrics.uptimeSeconds) },
              ].map(({ label, value, color }) => (
                <div key={label} className="text-center">
                  <p className="text-xs text-neutral-500">{label}</p>
                  <p className={`text-lg font-mono font-bold ${color || "text-neutral-800 dark:text-neutral-200"}`}>{value}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Alerts */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
              Active Alerts ({alerts.filter(a => !a.resolved).length})
            </h2>
          </div>
          <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {alerts.filter(a => !a.resolved).length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-green-500 font-medium">No active alerts. System healthy.</p>
              </div>
            ) : (
              alerts.filter(a => !a.resolved).map(alert => (
                <div key={alert.id} className="px-4 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${severityColor(alert.severity)}`}>
                      {alert.severity}
                    </span>
                    <div>
                      <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">{alert.type.replace(/_/g, " ")}</p>
                      <p className="text-xs text-neutral-500">{alert.message} · {ago(alert.firstSeen)}{alert.count > 1 ? ` (x${alert.count})` : ""}</p>
                    </div>
                  </div>
                  {!alert.acknowledged && (
                    <button onClick={() => ackAlert(alert.id)} className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1 rounded hover:bg-neutral-800 transition">
                      Ack
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Audit Actions */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
              Recovery Actions ({audit.length})
            </h2>
          </div>
          <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {audit.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-neutral-500">No recovery actions taken yet.</p>
              </div>
            ) : (
              audit.slice(0, 20).map(entry => (
                <div key={entry.id} className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-mono ${outcomeColor(entry.outcome)}`}>{entry.outcome}</span>
                      <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">{entry.action}</span>
                    </div>
                    <span className="text-xs text-neutral-500">{ago(entry.timestamp)}</span>
                  </div>
                  <p className="text-xs text-neutral-500 mt-1">{entry.reason}</p>
                  {entry.detail && <p className="text-xs text-neutral-400 mt-0.5">{entry.detail}</p>}
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recovery Configuration */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Recovery Configuration</h2>
          </div>
          <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {recovery.map(r => (
              <div key={r.trigger} className="px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-mono text-neutral-800 dark:text-neutral-200">
                    <span className="text-amber-500">{r.trigger.replace(/_/g, " ")}</span> &rarr; {r.action.replace(/_/g, " ")}
                  </p>
                  <p className="text-xs text-neutral-500">
                    Cooldown: {Math.round(r.cooldownMs / 60000)}m · Triggered: {r.triggerCount}x
                    {r.lastTriggeredAt ? ` · Last: ${ago(r.lastTriggeredAt)}` : ""}
                  </p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded ${r.enabled ? "text-green-400 bg-green-500/10" : "text-red-400 bg-red-500/10"}`}>
                  {r.enabled ? "enabled" : "disabled"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Guardrails */}
        {guardrails && (
          <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Guardrails</h2>
            </div>
            <div className="px-4 py-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-neutral-500">Changes this hour</p>
                  <p className="text-lg font-mono font-bold text-neutral-800 dark:text-neutral-200">
                    {guardrails.changesThisHour}/{guardrails.config.maxSelfChangesPerHour}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Changes today</p>
                  <p className="text-lg font-mono font-bold text-neutral-800 dark:text-neutral-200">
                    {guardrails.changesToday}/{guardrails.config.maxSelfChangesPerDay}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-neutral-500">Auto-rollback</p>
                  <p className={`text-lg font-mono font-bold ${guardrails.config.rollbackOnBuildFailure ? "text-green-400" : "text-red-400"}`}>
                    {guardrails.config.rollbackOnBuildFailure ? "Enabled" : "Disabled"}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-neutral-500 mb-1">Protected paths ({guardrails.config.protectedPaths.length})</p>
                <div className="flex flex-wrap gap-1">
                  {guardrails.config.protectedPaths.map(p => (
                    <span key={p} className="text-[10px] font-mono px-2 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-700">
                      {p}
                    </span>
                  ))}
                </div>
              </div>
              {guardrails.pendingCount > 0 && (
                <p className="text-xs text-amber-500 font-medium">{guardrails.pendingCount} changes pending approval</p>
              )}
            </div>
          </div>
        )}

        {/* Alert History */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Alert History</h2>
          </div>
          <div className="divide-y divide-neutral-200 dark:divide-neutral-800 max-h-64 overflow-y-auto">
            {alerts.filter(a => a.resolved).length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-neutral-500">No resolved alerts.</p>
              </div>
            ) : (
              alerts.filter(a => a.resolved).slice(0, 20).map(alert => (
                <div key={alert.id} className="px-4 py-2 flex items-center justify-between opacity-60">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-neutral-500">{alert.type.replace(/_/g, " ")}</span>
                    <span className="text-xs text-neutral-500">{alert.message}</span>
                  </div>
                  <span className="text-[10px] text-neutral-500">resolved {alert.resolvedAt ? ago(alert.resolvedAt) : ""}</span>
                </div>
              ))
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
