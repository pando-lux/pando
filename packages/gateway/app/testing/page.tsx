"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types ------------------------------------------------- */

interface TestRun {
  id: string;
  scenarioId?: string;
  scenarioName?: string;
  mode?: string;
  status: string;
  stepsPassed?: number;
  stepsTotal?: number;
  durationMs?: number;
  createdAt?: number;
  finishedAt?: number;
}

interface Finding {
  id: string;
  severity: string;
  title: string;
  description?: string;
  status: string;
  runId?: string;
  scenarioId?: string;
  createdAt?: number;
}

interface Scenario {
  id: string;
  name: string;
  mode?: string;
  tags?: string[];
  description?: string;
}

interface OverviewStats {
  totalScenarios: number;
  totalRuns: number;
  passRate: number;
  openFindings: number;
}

/* -- Helpers ----------------------------------------------- */

function shortId(id: string): string {
  if (!id) return "--";
  return id.length > 16 ? id.slice(0, 8) + "\u2026" + id.slice(-4) : id;
}

function relTime(ts: number): string {
  if (!ts) return "--";
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function fmtDuration(ms: number | undefined): string {
  if (!ms) return "--";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function statusBadgeCls(s: string): string {
  const st = s.toLowerCase();
  if (st === "passed" || st === "pass" || st === "success") return "bg-green-500/20 text-green-400 border-green-500/30";
  if (st === "failed" || st === "fail" || st === "error") return "bg-red-500/20 text-red-400 border-red-500/30";
  if (st === "running" || st === "in_progress") return "bg-blue-500/20 text-blue-400 border-blue-500/30";
  if (st === "skipped") return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
  return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
}

function severityBadgeCls(s: string): string {
  const sv = s.toLowerCase();
  if (sv === "critical") return "bg-red-500/20 text-red-400 border-red-500/30";
  if (sv === "high") return "bg-orange-500/20 text-orange-400 border-orange-500/30";
  if (sv === "medium" || sv === "warning") return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
  if (sv === "low" || sv === "info") return "bg-blue-500/20 text-blue-400 border-blue-500/30";
  return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
}

function modeBadgeCls(m: string): string {
  const mode = (m || "").toLowerCase();
  if (mode === "scripted") return "bg-indigo-500/15 text-indigo-400 border-indigo-500/25";
  if (mode === "live") return "bg-cyan-500/15 text-cyan-400 border-cyan-500/25";
  return "bg-neutral-500/15 text-neutral-400 border-neutral-500/25";
}

/* -- Main Page ---------------------------------------------- */

export default function TestingDashboardPage() {
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [offline, setOffline] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [runsRes, findingsRes, scenariosRes] = await Promise.all([
        fetch("/api/testing/runs?limit=10").catch(() => null),
        fetch("/api/testing/findings?status=open").catch(() => null),
        fetch("/api/testing/scenarios").catch(() => null),
      ]);
      setOffline(false);

      let runsList: TestRun[] = [];
      let findingsList: Finding[] = [];
      let scenariosList: Scenario[] = [];

      if (runsRes && runsRes.ok) {
        const d = await runsRes.json();
        runsList = d.runs || d || [];
      }
      if (findingsRes && findingsRes.ok) {
        const d = await findingsRes.json();
        findingsList = d.findings || d || [];
      }
      if (scenariosRes && scenariosRes.ok) {
        const d = await scenariosRes.json();
        scenariosList = d.scenarios || d || [];
      }

      setRuns(runsList);
      setFindings(findingsList);
      setScenarios(scenariosList);

      // Compute overview stats from the fetched data
      const totalRuns = runsList.length;
      const passedRuns = runsList.filter(
        (r) => r.status.toLowerCase() === "passed" || r.status.toLowerCase() === "pass" || r.status.toLowerCase() === "success"
      ).length;
      setOverview({
        totalScenarios: scenariosList.length,
        totalRuns: totalRuns,
        passRate: totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 0,
        openFindings: findingsList.length,
      });

      setLoaded(true);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 15000);
    return () => clearInterval(i);
  }, [refresh]);

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <NavBar />
      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold">Testing Dashboard</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Scenario runs, findings, and test coverage across the network.
          </p>
        </div>

        {/* Offline Banner */}
        {offline && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
            Cannot connect to Pando node.
          </div>
        )}

        {/* Overview Cards */}
        {loaded && overview && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Scenarios" value={overview.totalScenarios} />
            <StatCard label="Total Runs" value={overview.totalRuns} />
            <StatCard
              label="Pass Rate"
              render={() => (
                <p className={`text-lg font-mono font-bold ${
                  overview.passRate >= 80 ? "text-green-400" :
                  overview.passRate >= 50 ? "text-yellow-400" :
                  "text-red-400"
                }`}>
                  {overview.totalRuns > 0 ? `${overview.passRate}%` : "--"}
                </p>
              )}
            />
            <StatCard
              label="Open Findings"
              render={() => (
                <p className={`text-lg font-mono font-bold ${
                  overview.openFindings === 0 ? "text-green-400" :
                  overview.openFindings <= 3 ? "text-yellow-400" :
                  "text-red-400"
                }`}>
                  {overview.openFindings}
                </p>
              )}
            />
          </div>
        )}

        {/* Recent Runs Table */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Recent Runs</h2>
            {loaded && (
              <span className="text-[10px] text-neutral-500 font-mono">
                {runs.length} run{runs.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {!loaded ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-neutral-500 animate-pulse">Loading runs...</p>
            </div>
          ) : runs.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">No runs yet.</p>
              <p className="text-xs text-neutral-500 mt-1">
                Test runs will appear here once scenarios are executed.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-neutral-200 dark:border-neutral-800 text-neutral-500">
                    <th className="text-left px-4 py-2 font-medium">Run ID</th>
                    <th className="text-left px-4 py-2 font-medium">Scenario</th>
                    <th className="text-left px-4 py-2 font-medium">Mode</th>
                    <th className="text-left px-4 py-2 font-medium">Status</th>
                    <th className="text-left px-4 py-2 font-medium">Steps</th>
                    <th className="text-left px-4 py-2 font-medium">Duration</th>
                    <th className="text-right px-4 py-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {runs.map((run) => (
                    <tr key={run.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-800/30 transition">
                      <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400" title={run.id}>
                        {shortId(run.id)}
                      </td>
                      <td className="px-4 py-2.5 text-neutral-800 dark:text-neutral-200 font-medium">
                        {run.scenarioName || run.scenarioId || "--"}
                      </td>
                      <td className="px-4 py-2.5">
                        {run.mode ? (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${modeBadgeCls(run.mode)}`}>
                            {run.mode}
                          </span>
                        ) : (
                          <span className="text-neutral-500">--</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${statusBadgeCls(run.status)}`}>
                          {run.status}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400">
                        {run.stepsPassed != null && run.stepsTotal != null
                          ? `${run.stepsPassed}/${run.stepsTotal}`
                          : "--"}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400">
                        {fmtDuration(run.durationMs)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-neutral-500">
                        {relTime(run.finishedAt || run.createdAt || 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Open Findings */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Open Findings</h2>
            {loaded && (
              <span className="text-[10px] text-neutral-500 font-mono">
                {findings.length} finding{findings.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {!loaded ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-neutral-500 animate-pulse">Loading findings...</p>
            </div>
          ) : findings.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-green-500 font-medium">No open findings.</p>
              <p className="text-xs text-neutral-500 mt-1">All tests are passing cleanly.</p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {findings.map((f) => (
                <div key={f.id} className="px-4 py-3 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${severityBadgeCls(f.severity)}`}>
                      {f.severity}
                    </span>
                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                      {f.title}
                    </span>
                    {f.runId && (
                      <span className="text-[10px] font-mono text-neutral-500 ml-auto" title={f.runId}>
                        Run {shortId(f.runId)}
                      </span>
                    )}
                  </div>
                  {f.description && (
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 leading-relaxed">
                      {f.description}
                    </p>
                  )}
                  {f.createdAt && (
                    <p className="text-[10px] text-neutral-500">
                      Found {relTime(f.createdAt)}
                      {f.scenarioId ? ` in scenario ${shortId(f.scenarioId)}` : ""}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Scenarios List */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Scenarios</h2>
            {loaded && (
              <span className="text-[10px] text-neutral-500 font-mono">
                {scenarios.length} scenario{scenarios.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {!loaded ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-neutral-500 animate-pulse">Loading scenarios...</p>
            </div>
          ) : scenarios.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">No scenarios defined.</p>
              <p className="text-xs text-neutral-500 mt-1">
                Add test scenarios to the genome knowledge graph.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {scenarios.map((s) => (
                <div key={s.id} className="px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
                      {s.name}
                    </p>
                    {s.description && (
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5">
                        {s.description}
                      </p>
                    )}
                  </div>
                  {s.mode && (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border flex-shrink-0 ${modeBadgeCls(s.mode)}`}>
                      {s.mode}
                    </span>
                  )}
                  {s.tags && s.tags.length > 0 && (
                    <div className="flex gap-1 flex-shrink-0 flex-wrap">
                      {s.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-700"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

      </main>
    </div>
  );
}

/* -- Stat Card Component ------------------------------------ */

function StatCard({ label, value, accent, render }: {
  label: string;
  value?: number | string;
  accent?: string;
  render?: () => React.ReactNode;
}) {
  return (
    <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors">
      <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">{label}</p>
      {render ? render() : (
        <p className={`text-lg font-mono font-bold ${accent || "text-neutral-800 dark:text-neutral-200"}`}>
          {value ?? "--"}
        </p>
      )}
    </div>
  );
}
