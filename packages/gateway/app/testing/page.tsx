"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/* ─── Types ──────────────────────────────────────────────────── */

interface TestRun {
  id: string;
  scenario_id?: string;
  scenario_name?: string;
  mode?: string;
  status: string;
  total_steps?: number;
  passed_steps?: number;
  failed_steps?: number;
  duration_ms?: number;
  summary?: string;
  error?: string;
  started_at?: string;
  finished_at?: string;
}

interface Finding {
  id: string;
  severity: string;
  title: string;
  description?: string;
  status: string;
  run_id?: string;
  step_index?: number;
  created_at?: string;
}

interface PlaybookInfo {
  file: string;
  name: string;
  description: string;
  mode: string;
  tags: string[];
  steps: number;
}

interface DraftScenario {
  id: string;
  title: string;
  description: string;
  category: string;
  priority: "P0" | "P1" | "P2";
  selectedType: "static" | "live" | "both" | null;
  promotedAs?: "static" | "live" | "both" | null;
  promotedAt?: string;
  createdAt: string;
}

type Page = "dashboard" | "scripted" | "live" | "drafts";

/* ─── Helpers ────────────────────────────────────────────────── */

function relTime(ts: string | undefined): string {
  if (!ts) return "--";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "--";
  const diff = Date.now() - d.getTime();
  if (diff < 0) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function fmtDuration(ms: number | undefined): string {
  if (!ms) return "--";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtTime(ts: string | undefined): string {
  if (!ts) return "--";
  try {
    const d = new Date(ts);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ts; }
}

function statusDot(s: string): string {
  const st = s?.toLowerCase() ?? "";
  if (st === "passed" || st === "pass") return "bg-green-500";
  if (st === "failed" || st === "fail" || st === "error") return "bg-red-500";
  if (st === "running" || st === "in_progress") return "bg-blue-400 animate-pulse";
  return "bg-neutral-600";
}

function statusBadge(s: string): string {
  const st = s?.toLowerCase() ?? "";
  if (st === "passed" || st === "pass") return "bg-green-900/50 text-green-300";
  if (st === "failed" || st === "fail" || st === "error") return "bg-red-900/50 text-red-300";
  if (st === "running" || st === "in_progress") return "bg-blue-900/50 text-blue-300";
  return "bg-neutral-800 text-neutral-400";
}

const TAG_COLORS: Record<string, string> = {
  core: "text-blue-400", wallet: "text-amber-400", governance: "text-purple-400",
  gateway: "text-cyan-400", chat: "text-green-400", content: "text-pink-400",
  agent: "text-orange-400", flow: "text-indigo-400", economy: "text-yellow-400",
  navigation: "text-teal-400", lifecycle: "text-rose-400", onboarding: "text-lime-400",
  experience: "text-violet-400", general: "text-neutral-400",
};

function getTagColor(tag: string): string {
  return TAG_COLORS[tag.toLowerCase()] || "text-neutral-400";
}

const PRIORITY_COLORS: Record<string, string> = {
  P0: "bg-red-900/50 text-red-300",
  P1: "bg-amber-900/50 text-amber-300",
  P2: "bg-neutral-700/50 text-neutral-300",
};

/* ─── Draft storage (localStorage) ───────────────────────────── */

function loadDrafts(project: string): DraftScenario[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(`pando-test-drafts-${project}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveDrafts(project: string, drafts: DraftScenario[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(`pando-test-drafts-${project}`, JSON.stringify(drafts));
}

/* ═══════════════════════════════════════════════════════════════
   Main Page
   ═══════════════════════════════════════════════════════════════ */

export default function TestingPage() {
  const [page, setPage] = useState<Page>("dashboard");
  const [project, setProject] = useState("pando-node");

  // Data
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [playbooks, setPlaybooks] = useState<PlaybookInfo[]>([]);
  const [offline, setOffline] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Drafts
  const [drafts, setDrafts] = useState<DraftScenario[]>([]);

  // Detail view — store file name string so it survives API refreshes
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // Sub-tab within static/live pages
  const [subTab, setSubTab] = useState<"tests" | "history">("tests");

  // Run state
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [runOutput, setRunOutput] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterTag, setFilterTag] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  // Load drafts from localStorage
  useEffect(() => {
    setDrafts(loadDrafts(project));
  }, [project]);

  const updateDrafts = (newDrafts: DraftScenario[]) => {
    setDrafts(newDrafts);
    saveDrafts(project, newDrafts);
  };

  const refresh = useCallback(async () => {
    try {
      const [runsRes, findingsRes, playbooksRes] = await Promise.all([
        fetch(`/api/testing/runs?limit=50&project=${project}`).catch(() => null),
        fetch(`/api/testing/findings?project=${project}`).catch(() => null),
        fetch(`/api/testing/playbooks?project=${project}`).catch(() => null),
      ]);

      setOffline(false);

      if (runsRes?.ok) setRuns((await runsRes.json()) || []);
      if (findingsRes?.ok) setFindings((await findingsRes.json()) || []);
      if (playbooksRes?.ok) setPlaybooks((await playbooksRes.json()) || []);

      setLoaded(true);
    } catch {
      setOffline(true);
    }
  }, [project]);

  useEffect(() => {
    setLoaded(false);
    setSelectedFile(null);
    refresh();
    const i = setInterval(refresh, 10_000);
    return () => clearInterval(i);
  }, [refresh]);

  // Trigger a test run
  const triggerRun = async (pb: PlaybookInfo, mode: "scripted" | "live") => {
    setRunningId(pb.file);
    setRunOutput(prev => [...prev, `\n--- Running: ${pb.name} (${mode}) ---\n`]);
    try {
      const endpoint = mode === "scripted" ? "/api/testing/run/scripted" : "/api/testing/run/live";
      const body = mode === "scripted" ? { specFile: pb.file } : { playbook: pb.file };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      setRunOutput(prev => [...prev, `${d.message || "Started"}\n`]);
      showToast(d.message || "Run started");
    } catch {
      setRunOutput(prev => [...prev, "Failed to start run\n"]);
      showToast("Failed to start run");
    }
    setTimeout(() => { setRunningId(null); refresh(); }, 3000);
  };

  const triggerRunAll = async (mode: "scripted" | "live") => {
    setRunningAll(true);
    setRunOutput([]);
    const filtered = getFilteredPlaybooks();
    for (const pb of filtered) {
      await triggerRun(pb, mode);
    }
    setRunningAll(false);
  };

  // Get runs for a specific playbook
  const getPlaybookRuns = (pb: PlaybookInfo): TestRun[] => {
    return runs.filter(r => r.scenario_name === pb.name);
  };

  const getLastRun = (pb: PlaybookInfo): TestRun | undefined => {
    return getPlaybookRuns(pb)[0];
  };

  const getPlaybookStatus = (pb: PlaybookInfo): string => {
    const last = getLastRun(pb);
    return last?.status || "not_run";
  };

  // Computed
  const openFindings = findings.filter(f => f.status === "open");
  const passedRuns = runs.filter(r => r.status === "passed").length;
  const failedRuns = runs.filter(r => r.status === "failed").length;
  const allTags = [...new Set(playbooks.flatMap(pb => pb.tags))].sort();

  const getFilteredPlaybooks = () => {
    return playbooks.filter(pb => {
      if (search && !pb.name.toLowerCase().includes(search.toLowerCase()) &&
          !pb.description.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterTag && !pb.tags.includes(filterTag)) return false;
      return true;
    });
  };

  const getGroupedPlaybooks = () => {
    const filtered = getFilteredPlaybooks();
    const grouped: Record<string, PlaybookInfo[]> = {};
    for (const pb of filtered) {
      const tag = pb.tags[0] || "general";
      if (!grouped[tag]) grouped[tag] = [];
      grouped[tag].push(pb);
    }
    return grouped;
  };

  const getTagStats = (tag: string) => {
    const pbs = playbooks.filter(pb => pb.tags.includes(tag));
    const passed = pbs.filter(pb => getPlaybookStatus(pb) === "passed").length;
    const failed = pbs.filter(pb => ["failed", "error"].includes(getPlaybookStatus(pb))).length;
    const notRun = pbs.length - passed - failed;
    return { total: pbs.length, passed, failed, notRun };
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex">

      {/* ─── Sidebar ─────────────────────────────────────────── */}
      <aside className="w-[200px] flex-shrink-0 border-r border-neutral-800 bg-neutral-950 flex flex-col h-screen sticky top-0">
        <div className="px-4 py-4 border-b border-neutral-800">
          <h1 className="text-sm font-bold text-neutral-100">Pando Tests</h1>
          <p className="text-[10px] text-neutral-500 mt-0.5">Testing Dashboard</p>
        </div>

        {/* Project Selector */}
        <div className="px-3 py-3 border-b border-neutral-800">
          <label className="text-[10px] text-neutral-500 uppercase tracking-wider font-medium block mb-1.5">Project</label>
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            className="w-full text-xs font-mono bg-neutral-900 border border-neutral-700 rounded px-2 py-1.5 text-neutral-200 focus:outline-none focus:border-blue-500"
          >
            <option value="pando-node">pando-node</option>
            <option value="pando-code">pando-code</option>
          </select>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2">
          {([
            { key: "dashboard" as Page, label: "Dashboard", icon: "\u25A3", color: "text-blue-400", count: null },
            { key: "scripted" as Page, label: "Static Tests", icon: "\u25B6", color: "text-indigo-400", count: playbooks.length },
            { key: "live" as Page, label: "Live Tests", icon: "\u26A1", color: "text-cyan-400", count: playbooks.length },
            { key: "drafts" as Page, label: "Draft Scenarios", icon: "\u270E", color: "text-amber-400", count: drafts.length },
          ]).map((item) => (
            <button
              key={item.key}
              onClick={() => { setPage(item.key); setSelectedFile(null); setSubTab("tests"); setSearch(""); setFilterTag(null); }}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-colors border-l-2 ${
                page === item.key
                  ? "border-blue-400 bg-neutral-900 text-neutral-100"
                  : "border-transparent text-neutral-400 hover:bg-neutral-900/50 hover:text-neutral-200"
              }`}
            >
              <span className={`text-sm ${item.color}`}>{item.icon}</span>
              <span className="text-xs font-medium flex-1">{item.label}</span>
              {item.count !== null && <span className="text-[10px] text-neutral-500">{item.count}</span>}
            </button>
          ))}
        </nav>

        {/* Status footer */}
        <div className="px-3 py-3 border-t border-neutral-800 text-[10px] text-neutral-500 space-y-1">
          <div className="flex justify-between">
            <span>Total Runs</span>
            <span className="font-mono text-neutral-300">{runs.length}</span>
          </div>
          <div className="flex justify-between">
            <span>Findings</span>
            <span className={`font-mono ${openFindings.length === 0 ? "text-green-500" : "text-red-400"}`}>
              {openFindings.length} open
            </span>
          </div>
          {offline && <p className="text-red-400 font-medium mt-1">Node offline</p>}
        </div>
      </aside>

      {/* ─── Main Content ────────────────────────────────────── */}
      <main className="flex-1 min-h-screen overflow-y-auto">

        {/* Toast */}
        {toast && (
          <div className="fixed top-4 right-4 z-50 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium shadow-lg">
            {toast}
          </div>
        )}

        {/* ═══ Dashboard ═══ */}
        {page === "dashboard" && (
          <DashboardView
            project={project}
            playbooks={playbooks}
            runs={runs}
            findings={findings}
            openFindings={openFindings}
            passedRuns={passedRuns}
            failedRuns={failedRuns}
            allTags={allTags}
            loaded={loaded}
            getTagStats={getTagStats}
            getPlaybookStatus={getPlaybookStatus}
          />
        )}

        {/* ═══ Static / Live Tests — Tests sub-tab ═══ */}
        {(page === "scripted" || page === "live") && !selectedFile && subTab === "tests" && (
          <TestListView
            page={page}
            playbooks={playbooks}
            loaded={loaded}
            search={search}
            setSearch={setSearch}
            filterTag={filterTag}
            setFilterTag={setFilterTag}
            allTags={allTags}
            getFilteredPlaybooks={getFilteredPlaybooks}
            getGroupedPlaybooks={getGroupedPlaybooks}
            getLastRun={getLastRun}
            getPlaybookRuns={getPlaybookRuns}
            getPlaybookStatus={getPlaybookStatus}
            runningId={runningId}
            runningAll={runningAll}
            onRun={(pb) => triggerRun(pb, page === "scripted" ? "scripted" : "live")}
            onRunAll={() => triggerRunAll(page === "scripted" ? "scripted" : "live")}
            onSelect={(pb) => setSelectedFile(pb.file)}
            runOutput={runOutput}
            subTab={subTab}
            setSubTab={setSubTab}
          />
        )}

        {/* ═══ Static / Live Tests — History sub-tab ═══ */}
        {(page === "scripted" || page === "live") && !selectedFile && subTab === "history" && (
          <HistoryView
            page={page}
            runs={runs}
            playbooks={playbooks}
            findings={findings}
            loaded={loaded}
            subTab={subTab}
            setSubTab={setSubTab}
            onSelectPlaybook={(file) => { setSelectedFile(file); setSubTab("tests"); }}
          />
        )}

        {/* ═══ Detail View ═══ */}
        {(page === "scripted" || page === "live") && selectedFile && (() => {
          const pb = playbooks.find(p => p.file === selectedFile);
          if (!pb) return null;
          return (
            <TestDetailView
              pb={pb}
              runs={getPlaybookRuns(pb)}
              findings={findings.filter(f => {
                const pbRuns = getPlaybookRuns(pb);
                return pbRuns.some(r => r.id === f.run_id);
              })}
              page={page}
              runningId={runningId}
              onBack={() => setSelectedFile(null)}
              onRun={() => triggerRun(pb, page === "scripted" ? "scripted" : "live")}
            />
          );
        })()}

        {/* ═══ Draft Scenarios ═══ */}
        {page === "drafts" && (
          <DraftScenariosView
            drafts={drafts}
            onUpdateDrafts={updateDrafts}
          />
        )}

      </main>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Dashboard View
   ═══════════════════════════════════════════════════════════════ */

function DashboardView({
  project, playbooks, runs, findings, openFindings, passedRuns, failedRuns, allTags, loaded, getTagStats, getPlaybookStatus,
}: {
  project: string;
  playbooks: PlaybookInfo[];
  runs: TestRun[];
  findings: Finding[];
  openFindings: Finding[];
  passedRuns: number;
  failedRuns: number;
  allTags: string[];
  loaded: boolean;
  getTagStats: (tag: string) => { total: number; passed: number; failed: number; notRun: number };
  getPlaybookStatus: (pb: PlaybookInfo) => string;
}) {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-lg font-bold">Test Dashboard</h2>
        <p className="text-xs text-neutral-500 mt-1">
          Overview for <span className="text-neutral-300 font-mono">{project}</span>
        </p>
      </div>

      {/* Stat Cards */}
      {loaded && (
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Passed" value={passedRuns} color="text-green-400" bg="bg-green-500/10" />
          <StatCard label="Failed" value={failedRuns} color="text-red-400" bg="bg-red-500/10" />
          <StatCard label="Playbooks" value={playbooks.length} color="text-blue-400" bg="bg-blue-500/10" />
          <StatCard label="Findings" value={openFindings.length} color={openFindings.length === 0 ? "text-green-400" : "text-red-400"} bg={openFindings.length === 0 ? "bg-green-500/10" : "bg-red-500/10"} />
        </div>
      )}

      {loaded && (
        <p className="text-xs text-neutral-500">
          {runs.length} total runs -- <span className="text-indigo-400">{playbooks.length} playbooks</span> available
        </p>
      )}

      {/* Tag Breakdown */}
      {loaded && allTags.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {allTags.map(tag => {
            const stats = getTagStats(tag);
            return (
              <div key={tag} className="bg-neutral-900 rounded-lg border border-neutral-800 p-3">
                <div className={`text-[10px] font-semibold uppercase tracking-wider mb-1.5 ${getTagColor(tag)}`}>
                  {tag}
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-bold text-neutral-100">{stats.passed}</span>
                  <span className="text-[10px] text-neutral-500">/ {stats.total} pass</span>
                </div>
                <div className="flex gap-1.5 mt-1.5 flex-wrap">
                  {stats.failed > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-900/30 text-red-300">{stats.failed} fail</span>}
                  {stats.notRun > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400">{stats.notRun} not run</span>}
                  {stats.failed === 0 && stats.notRun === 0 && <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-900/30 text-green-300">all clear</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recent Runs */}
      {loaded && runs.length > 0 && (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800">
          <div className="px-4 py-3 border-b border-neutral-800">
            <h3 className="text-sm font-semibold text-neutral-300">Recent Runs</h3>
          </div>
          <div className="divide-y divide-neutral-800">
            {runs.slice(0, 10).map(run => (
              <div key={run.id} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(run.status)}`} />
                <span className="text-neutral-200 font-medium flex-1 truncate">{run.scenario_name || "Unknown"}</span>
                <span className="text-neutral-500 font-mono">
                  {run.total_steps ? `${run.passed_steps ?? 0}/${run.total_steps}` : "--"}
                </span>
                <span className="text-neutral-500 font-mono">{fmtDuration(run.duration_ms)}</span>
                <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded ${statusBadge(run.status)}`}>
                  {run.status}
                </span>
                <span className="text-neutral-600 text-[10px] w-16 text-right">{relTime(run.finished_at || run.started_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open Findings */}
      {loaded && openFindings.length > 0 && (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800">
          <div className="px-4 py-3 border-b border-neutral-800">
            <h3 className="text-sm font-semibold text-red-400">Open Findings ({openFindings.length})</h3>
          </div>
          <div className="divide-y divide-neutral-800">
            {openFindings.slice(0, 10).map(f => (
              <div key={f.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded ${
                    f.severity === "critical" ? "bg-red-900/50 text-red-300" :
                    f.severity === "high" ? "bg-orange-900/50 text-orange-300" :
                    f.severity === "medium" ? "bg-amber-900/50 text-amber-300" :
                    "bg-blue-900/50 text-blue-300"
                  }`}>{f.severity}</span>
                  <span className="text-xs font-medium text-neutral-200">{f.title}</span>
                </div>
                {f.description && <p className="text-[11px] text-neutral-500 mt-1">{f.description}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {!loaded && <div className="py-16 text-center text-sm text-neutral-500 animate-pulse">Loading...</div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Stat Card
   ═══════════════════════════════════════════════════════════════ */

function StatCard({ label, value, color, bg }: { label: string; value: number; color: string; bg: string }) {
  return (
    <div className={`rounded-lg border border-neutral-800 p-4 ${bg}`}>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-neutral-500 mt-1">{label}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Test List View
   ═══════════════════════════════════════════════════════════════ */

function SubTabBar({ subTab, setSubTab, isStatic }: { subTab: "tests" | "history"; setSubTab: (t: "tests" | "history") => void; isStatic: boolean }) {
  const accent = isStatic ? "indigo" : "cyan";
  return (
    <div className="flex gap-1 border-b border-neutral-800 mb-4">
      {([
        { key: "tests" as const, label: "Tests" },
        { key: "history" as const, label: "History" },
      ]).map(tab => (
        <button
          key={tab.key}
          onClick={() => setSubTab(tab.key)}
          className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 ${
            subTab === tab.key
              ? `border-${accent}-400 text-${accent}-300`
              : "border-transparent text-neutral-500 hover:text-neutral-300"
          }`}
          style={subTab === tab.key ? { borderColor: isStatic ? "#818cf8" : "#22d3ee" } : {}}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function TestListView({
  page, playbooks, loaded, search, setSearch, filterTag, setFilterTag,
  allTags, getFilteredPlaybooks, getGroupedPlaybooks, getLastRun, getPlaybookRuns,
  getPlaybookStatus, runningId, runningAll, onRun, onRunAll, onSelect, runOutput,
  subTab, setSubTab,
}: {
  page: Page;
  playbooks: PlaybookInfo[];
  loaded: boolean;
  search: string;
  setSearch: (s: string) => void;
  filterTag: string | null;
  setFilterTag: (t: string | null) => void;
  allTags: string[];
  getFilteredPlaybooks: () => PlaybookInfo[];
  getGroupedPlaybooks: () => Record<string, PlaybookInfo[]>;
  getLastRun: (pb: PlaybookInfo) => TestRun | undefined;
  getPlaybookRuns: (pb: PlaybookInfo) => TestRun[];
  getPlaybookStatus: (pb: PlaybookInfo) => string;
  runningId: string | null;
  runningAll: boolean;
  onRun: (pb: PlaybookInfo) => void;
  onRunAll: () => void;
  onSelect: (pb: PlaybookInfo) => void;
  runOutput: string[];
  subTab: "tests" | "history";
  setSubTab: (t: "tests" | "history") => void;
}) {
  const isStatic = page === "scripted";
  const filtered = getFilteredPlaybooks();
  const grouped = getGroupedPlaybooks();

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className={`text-lg font-bold ${isStatic ? "text-indigo-300" : "text-cyan-300"}`}>
            {isStatic ? "Static Tests" : "Live Tests"}
          </h2>
          <p className="text-xs text-neutral-500 mt-1">
            {isStatic ? "Playwright scripted test suites" : "Agent-driven browser testing with playbooks"}
            {" -- "}{playbooks.length} playbooks in {allTags.length} categories
          </p>
        </div>
        <button
          onClick={onRunAll}
          disabled={runningAll || filtered.length === 0}
          className={`px-4 py-2 text-xs font-semibold rounded transition-colors ${
            runningAll
              ? "bg-neutral-800 text-neutral-500 cursor-wait"
              : isStatic
                ? "bg-indigo-600 hover:bg-indigo-500 text-white"
                : "bg-cyan-600 hover:bg-cyan-500 text-white"
          }`}
        >
          {runningAll ? "Running..." : `Run All (${filtered.length})`}
        </button>
      </div>

      <SubTabBar subTab={subTab} setSubTab={setSubTab} isStatic={isStatic} />

      {/* Search + Tag Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search tests..."
          className="w-full max-w-xs text-xs px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-blue-500"
        />
        <div className="flex gap-1 flex-wrap">
          {allTags.map(tag => (
            <button
              key={tag}
              onClick={() => setFilterTag(filterTag === tag ? null : tag)}
              className={`px-2.5 py-1 text-[10px] font-semibold rounded transition-colors capitalize ${
                filterTag === tag
                  ? isStatic
                    ? "bg-indigo-900/50 text-indigo-300 border border-indigo-500/40"
                    : "bg-cyan-900/50 text-cyan-300 border border-cyan-500/40"
                  : "bg-neutral-900 text-neutral-500 hover:text-neutral-300 border border-transparent"
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      {/* Grouped Test List */}
      {!loaded ? (
        <div className="py-16 text-center text-sm text-neutral-500 animate-pulse">Loading...</div>
      ) : Object.keys(grouped).length === 0 ? (
        <div className="text-sm text-neutral-500 py-8 text-center">
          {search || filterTag ? "No matching tests" : "No playbooks found."}
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([tag, items]) => (
            <div key={tag}>
              <h3 className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2">
                <span className={getTagColor(tag)}>{tag}</span>
                <span className="text-[10px] text-neutral-600 font-normal">({items.length})</span>
              </h3>
              <div className="space-y-1.5">
                {items.map(pb => {
                  const status = getPlaybookStatus(pb);
                  const lastRun = getLastRun(pb);
                  const pbRuns = getPlaybookRuns(pb);
                  const isRunning = runningId === pb.file;

                  return (
                    <div
                      key={pb.file}
                      className="bg-neutral-900 rounded-lg border border-neutral-800 p-3 flex items-center gap-3"
                    >
                      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isRunning ? "bg-blue-400 animate-pulse" : statusDot(status)}`} />
                      <div className="flex-1 min-w-0">
                        <button
                          onClick={() => onSelect(pb)}
                          className="text-xs font-medium text-neutral-200 hover:text-blue-400 transition-colors text-left"
                        >
                          {pb.name}
                        </button>
                        <div className="flex items-center gap-3 mt-0.5">
                          <span className="text-[10px] text-neutral-500">{pb.steps} steps</span>
                          {lastRun && lastRun.total_steps && (
                            <span className="flex items-center gap-1.5">
                              {(lastRun.passed_steps ?? 0) > 0 && <span className="text-[9px] text-green-400">{lastRun.passed_steps}P</span>}
                              {(lastRun.failed_steps ?? 0) > 0 && <span className="text-[9px] text-red-400">{lastRun.failed_steps}F</span>}
                            </span>
                          )}
                          {lastRun && (
                            <span className="text-[10px] text-neutral-600">Last: {relTime(lastRun.finished_at || lastRun.started_at)}</span>
                          )}
                          {pbRuns.length > 0 && (
                            <span className="text-[10px] text-neutral-600">{pbRuns.length} runs</span>
                          )}
                        </div>
                      </div>
                      <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded ${isRunning ? "bg-blue-900/50 text-blue-300" : statusBadge(status)}`}>
                        {isRunning ? "running" : status === "not_run" ? "not run" : status}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); onRun(pb); }}
                        disabled={runningAll || isRunning}
                        className={`px-2.5 py-1 text-[10px] font-semibold rounded transition-colors ${
                          isRunning
                            ? "bg-neutral-800 text-neutral-500 cursor-wait"
                            : isStatic
                              ? "bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/40 border border-indigo-500/30"
                              : "bg-cyan-600/20 text-cyan-300 hover:bg-cyan-600/40 border border-cyan-500/30"
                        }`}
                      >
                        {isRunning ? "..." : "Run"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Run Output Console */}
      {runOutput.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider">Output</h3>
          <pre className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 text-[11px] text-neutral-400 font-mono whitespace-pre-wrap overflow-y-auto max-h-[300px]">
            {runOutput.join("")}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   History View (two-column: chronological run list + detail)
   ═══════════════════════════════════════════════════════════════ */

function HistoryView({
  page, runs, playbooks, findings, loaded, subTab, setSubTab, onSelectPlaybook,
}: {
  page: Page;
  runs: TestRun[];
  playbooks: PlaybookInfo[];
  findings: Finding[];
  loaded: boolean;
  subTab: "tests" | "history";
  setSubTab: (t: "tests" | "history") => void;
  onSelectPlaybook: (file: string) => void;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [searchH, setSearchH] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const isStatic = page === "scripted";

  // Sort runs newest first (they should already be, but be safe)
  const sortedRuns = [...runs].sort((a, b) => {
    const ta = new Date(b.finished_at || b.started_at || 0).getTime();
    const tb = new Date(a.finished_at || a.started_at || 0).getTime();
    return ta - tb;
  });

  // Filter
  const filteredRuns = sortedRuns.filter(r => {
    if (searchH && !(r.scenario_name || "").toLowerCase().includes(searchH.toLowerCase())) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    return true;
  });

  const selectedRun = selectedRunId ? runs.find(r => r.id === selectedRunId) : null;
  const selectedPb = selectedRun
    ? playbooks.find(pb => pb.name === selectedRun.scenario_name)
    : null;
  const runFindings = selectedRun
    ? findings.filter(f => f.run_id === selectedRun.id)
    : [];

  // Status counts for filter pills
  const passedCount = sortedRuns.filter(r => r.status === "passed").length;
  const failedCount = sortedRuns.filter(r => ["failed", "error"].includes(r.status)).length;

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div>
        <h2 className={`text-lg font-bold ${isStatic ? "text-indigo-300" : "text-cyan-300"}`}>
          {isStatic ? "Static Tests" : "Live Tests"}
        </h2>
        <p className="text-xs text-neutral-500 mt-1">
          Run history across all {isStatic ? "static" : "live"} tests — newest first
        </p>
      </div>

      <SubTabBar subTab={subTab} setSubTab={setSubTab} isStatic={isStatic} />

      {!loaded ? (
        <div className="py-16 text-center text-sm text-neutral-500 animate-pulse">Loading...</div>
      ) : sortedRuns.length === 0 ? (
        <div className="text-sm text-neutral-500 py-8 text-center">No run history yet.</div>
      ) : (
        <>
          {/* Search + status filters */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="text"
              value={searchH}
              onChange={e => setSearchH(e.target.value)}
              placeholder="Search by test name..."
              className="w-full max-w-xs text-xs px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-blue-500"
            />
            <div className="flex gap-1">
              {([
                { key: null, label: `All (${sortedRuns.length})` },
                { key: "passed", label: `Passed (${passedCount})` },
                { key: "failed", label: `Failed (${failedCount})` },
              ] as const).map(f => (
                <button
                  key={f.label}
                  onClick={() => setStatusFilter(statusFilter === f.key ? null : f.key)}
                  className={`px-2.5 py-1 text-[10px] font-semibold rounded transition-colors ${
                    statusFilter === f.key
                      ? f.key === "passed"
                        ? "bg-green-900/50 text-green-300 border border-green-500/40"
                        : f.key === "failed"
                          ? "bg-red-900/50 text-red-300 border border-red-500/40"
                          : isStatic
                            ? "bg-indigo-900/50 text-indigo-300 border border-indigo-500/40"
                            : "bg-cyan-900/50 text-cyan-300 border border-cyan-500/40"
                      : "bg-neutral-900 text-neutral-500 hover:text-neutral-300 border border-transparent"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Two-column layout */}
          <div className="flex gap-0 border border-neutral-800 rounded-lg overflow-hidden" style={{ height: "calc(100vh - 260px)" }}>
            {/* Left: Run list */}
            <div className="w-[340px] flex-shrink-0 border-r border-neutral-800 overflow-y-auto bg-neutral-900/30">
              {filteredRuns.length === 0 ? (
                <div className="px-4 py-8 text-xs text-neutral-600 text-center">No matching runs</div>
              ) : (
                filteredRuns.map(run => {
                  const isActive = selectedRunId === run.id;
                  const pb = playbooks.find(p => p.name === run.scenario_name);

                  return (
                    <button
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      className={`w-full text-left px-4 py-3 border-b border-neutral-800 transition-colors ${
                        isActive
                          ? "bg-neutral-800 border-l-2"
                          : "hover:bg-neutral-800/50 border-l-2 border-l-transparent"
                      }`}
                      style={isActive ? { borderLeftColor: isStatic ? "#818cf8" : "#22d3ee" } : {}}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(run.status)}`} />
                        <span className="text-xs font-medium text-neutral-200 flex-1 truncate">
                          {run.scenario_name || "Unknown"}
                        </span>
                        <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${statusBadge(run.status)}`}>
                          {run.status}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 ml-4 text-[10px] text-neutral-500">
                        <span>{fmtTime(run.finished_at || run.started_at)}</span>
                        <span>{fmtDuration(run.duration_ms)}</span>
                        {run.total_steps ? (
                          <span>{run.passed_steps ?? 0}/{run.total_steps} steps</span>
                        ) : null}
                      </div>
                      {pb && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onSelectPlaybook(pb.file); }}
                          className="text-[10px] text-blue-400 hover:text-blue-300 mt-1 ml-4 transition-colors"
                        >
                          View test &rarr;
                        </button>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Right: Selected run detail */}
            <div className="flex-1 overflow-y-auto">
              {selectedRun ? (
                <RunDetailContent
                  run={selectedRun}
                  pb={selectedPb || { file: "", name: selectedRun.scenario_name || "Unknown", description: "", mode: "", tags: [], steps: 0 }}
                  findings={runFindings}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-neutral-600">
                  Select a run to view details
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Test Detail View (two-column: run list + content)
   ═══════════════════════════════════════════════════════════════ */

function TestDetailView({
  pb, runs, findings, page, runningId, onBack, onRun,
}: {
  pb: PlaybookInfo;
  runs: TestRun[];
  findings: Finding[];
  page: Page;
  runningId: string | null;
  onBack: () => void;
  onRun: () => void;
}) {
  const [selectedRunIndex, setSelectedRunIndex] = useState<number | null>(null);
  const isRunning = runningId === pb.file;
  const isStatic = page === "scripted";
  const selectedRun = selectedRunIndex !== null ? runs[selectedRunIndex] : null;

  return (
    <div className="h-screen flex flex-col">
      {/* Breadcrumb */}
      <div className="px-6 py-3 border-b border-neutral-800 bg-neutral-900/50 flex items-center gap-3 flex-shrink-0">
        <button onClick={onBack} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
          &larr; Back to {isStatic ? "Static" : "Live"} Tests
        </button>
        <span className="text-xs text-neutral-600">/</span>
        <span className="text-xs text-neutral-400">{pb.name}</span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: Run List */}
        <div className="w-[220px] flex-shrink-0 border-r border-neutral-800 flex flex-col bg-neutral-900/30">
          {/* Test Header */}
          <div className="px-3 py-3 border-b border-neutral-800">
            <h3 className="text-sm font-semibold text-neutral-200 truncate">{pb.name}</h3>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded ${isStatic ? "bg-indigo-900/50 text-indigo-300" : "bg-cyan-900/50 text-cyan-300"}`}>
                {isStatic ? "Static" : "Live"}
              </span>
              <span className="text-[10px] text-neutral-500">{pb.steps} steps</span>
            </div>
          </div>

          {/* Definition Link */}
          <button
            onClick={() => setSelectedRunIndex(null)}
            className={`w-full flex items-center gap-2 px-3 py-2 text-left border-l-2 transition-colors text-xs ${
              selectedRunIndex === null
                ? "border-blue-400 bg-neutral-800 text-neutral-100"
                : "border-transparent text-neutral-400 hover:bg-neutral-800/50"
            }`}
          >
            <span className="text-blue-400">&#x25C6;</span>
            Definition
          </button>

          {/* Run History */}
          <div className="px-3 py-2 border-b border-t border-neutral-800">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              History ({runs.length})
            </span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {runs.length === 0 && (
              <div className="px-3 py-4 text-xs text-neutral-600 text-center">No runs yet</div>
            )}
            {runs.map((run, i) => (
              <button
                key={run.id}
                onClick={() => setSelectedRunIndex(i)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left border-l-2 transition-colors ${
                  selectedRunIndex === i
                    ? "border-blue-400 bg-neutral-800"
                    : "border-transparent hover:bg-neutral-800/50"
                }`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(run.status)}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] text-neutral-200 truncate">{fmtTime(run.finished_at || run.started_at)}</div>
                  <div className="text-[10px] text-neutral-500">{fmtDuration(run.duration_ms)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: Content */}
        <div className="flex-1 overflow-y-auto">
          {selectedRun ? (
            <RunDetailContent run={selectedRun} pb={pb} findings={findings.filter(f => f.run_id === selectedRun.id)} />
          ) : (
            <DefinitionContent pb={pb} isStatic={isStatic} isRunning={isRunning} onRun={onRun} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Definition Content ─────────────────────────────────────── */

function DefinitionContent({ pb, isStatic, isRunning, onRun }: {
  pb: PlaybookInfo;
  isStatic: boolean;
  isRunning: boolean;
  onRun: () => void;
}) {
  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-neutral-100">{pb.name}</h2>
          <p className="text-xs text-neutral-500 mt-1">{pb.description}</p>
        </div>
        <button
          onClick={onRun}
          disabled={isRunning}
          className={`px-4 py-2 text-xs font-semibold rounded transition-colors ${
            isRunning
              ? "bg-neutral-800 text-neutral-500 cursor-wait"
              : isStatic
                ? "bg-indigo-600 hover:bg-indigo-500 text-white"
                : "bg-cyan-600 hover:bg-cyan-500 text-white"
          }`}
        >
          {isRunning ? "Running..." : "Run Test"}
        </button>
      </div>

      {/* Metadata */}
      <div className="flex flex-wrap gap-4 text-xs">
        <div>
          <span className="text-neutral-500">Steps: </span>
          <span className="text-neutral-300 font-medium">{pb.steps}</span>
        </div>
        <div>
          <span className="text-neutral-500">Mode: </span>
          <span className={isStatic ? "text-indigo-300" : "text-cyan-300"}>
            {isStatic ? "Static (Playwright)" : "Live (Agent)"}
          </span>
        </div>
        <div>
          <span className="text-neutral-500">File: </span>
          <span className="text-neutral-400 font-mono">{pb.file}</span>
        </div>
      </div>

      {/* Tags */}
      {pb.tags.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {pb.tags.map(t => (
            <span key={t} className={`text-[10px] font-mono px-2 py-0.5 rounded bg-neutral-800 border border-neutral-700 ${getTagColor(t)}`}>
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Run Detail Content ─────────────────────────────────────── */

function RunDetailContent({ run, pb, findings }: {
  run: TestRun;
  pb: PlaybookInfo;
  findings: Finding[];
}) {
  return (
    <div className="p-6 space-y-6 max-w-3xl">
      {/* Run Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-neutral-100">{pb.name}</h2>
          <p className="text-xs text-neutral-500 mt-1">{fmtTime(run.finished_at || run.started_at)}</p>
        </div>
        <span className={`text-xs font-bold uppercase px-2.5 py-1 rounded ${statusBadge(run.status)}`}>
          {run.status}
        </span>
      </div>

      {/* Summary Stats */}
      <div className="flex gap-6 text-xs">
        <div>
          <span className="text-neutral-500">Duration: </span>
          <span className="text-neutral-200 font-medium">{fmtDuration(run.duration_ms)}</span>
        </div>
        <div>
          <span className="text-neutral-500">Steps: </span>
          <span className="text-neutral-200 font-medium">
            {run.passed_steps ?? 0}/{run.total_steps ?? 0} passed
          </span>
          {(run.failed_steps ?? 0) > 0 && (
            <span className="text-red-400 ml-1">({run.failed_steps} failed)</span>
          )}
        </div>
        {run.mode && (
          <div>
            <span className="text-neutral-500">Mode: </span>
            <span className="text-neutral-200">{run.mode}</span>
          </div>
        )}
      </div>

      {/* Summary */}
      {run.summary && (
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-4">
          <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">Summary</h3>
          <p className="text-sm text-neutral-300">{run.summary}</p>
        </div>
      )}

      {/* Error */}
      {run.error && (
        <div className="bg-red-950/20 rounded-lg border border-red-900/50 p-4">
          <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-2">Errors</h3>
          <pre className="text-xs text-red-300 font-mono whitespace-pre-wrap">{run.error}</pre>
        </div>
      )}

      {/* Findings for this run */}
      {findings.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Findings ({findings.length})</h3>
          <div className="space-y-2">
            {findings.map(f => (
              <div key={f.id} className="bg-neutral-900 rounded-lg border border-neutral-800 p-3">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded ${
                    f.severity === "critical" ? "bg-red-900/50 text-red-300" :
                    f.severity === "high" ? "bg-orange-900/50 text-orange-300" :
                    f.severity === "medium" ? "bg-amber-900/50 text-amber-300" :
                    "bg-blue-900/50 text-blue-300"
                  }`}>{f.severity}</span>
                  <span className="text-xs font-medium text-neutral-200">{f.title}</span>
                  {f.step_index !== undefined && (
                    <span className="text-[10px] text-neutral-500 ml-auto">Step {f.step_index + 1}</span>
                  )}
                </div>
                {f.description && <p className="text-[11px] text-neutral-500 mt-1">{f.description}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Draft Scenarios View
   ═══════════════════════════════════════════════════════════════ */

function DraftScenariosView({
  drafts, onUpdateDrafts,
}: {
  drafts: DraftScenario[];
  onUpdateDrafts: (drafts: DraftScenario[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [filterPriority, setFilterPriority] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newCategory, setNewCategory] = useState("general");
  const [newPriority, setNewPriority] = useState<"P0" | "P1" | "P2">("P1");
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [promotingAll, setPromotingAll] = useState(false);

  const categories = [...new Set(drafts.map(d => d.category))].sort();

  const filtered = drafts.filter(d => {
    if (search && !d.title.toLowerCase().includes(search.toLowerCase()) && !d.description.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterPriority && d.priority !== filterPriority) return false;
    return true;
  });

  const grouped: Record<string, DraftScenario[]> = {};
  for (const d of filtered) {
    if (!grouped[d.category]) grouped[d.category] = [];
    grouped[d.category].push(d);
  }

  const handleAdd = () => {
    if (!newTitle.trim()) return;
    const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const draft: DraftScenario = {
      id,
      title: newTitle.trim(),
      description: newDesc.trim(),
      category: newCategory,
      priority: newPriority,
      selectedType: null,
      createdAt: new Date().toISOString(),
    };
    onUpdateDrafts([...drafts, draft]);
    setNewTitle("");
    setNewDesc("");
    setShowAdd(false);
  };

  const handleToggle = (id: string, type: "static" | "live") => {
    const updated = drafts.map(d => {
      if (d.id !== id) return d;
      let newType: DraftScenario["selectedType"];
      if (type === "static") {
        if (d.selectedType === "static") newType = null;
        else if (d.selectedType === "both") newType = "live";
        else if (d.selectedType === "live") newType = "both";
        else newType = "static";
      } else {
        if (d.selectedType === "live") newType = null;
        else if (d.selectedType === "both") newType = "static";
        else if (d.selectedType === "static") newType = "both";
        else newType = "live";
      }
      return { ...d, selectedType: newType };
    });
    onUpdateDrafts(updated);
  };

  const handleDelete = (id: string) => {
    onUpdateDrafts(drafts.filter(d => d.id !== id));
  };

  // Promote a single draft → sends to Pando orchestrator via chat API
  const handlePromote = async (draft: DraftScenario) => {
    if (!draft.selectedType) return;
    setPromotingId(draft.id);

    const typeLabel = draft.selectedType === "both" ? "static and live" : draft.selectedType;
    const message = [
      `Create ${typeLabel} test(s) from this draft scenario:`,
      ``,
      `**Title:** ${draft.title}`,
      `**Category:** ${draft.category}`,
      `**Priority:** ${draft.priority}`,
      draft.description ? `**Description:** ${draft.description}` : "",
      ``,
      draft.selectedType === "static" || draft.selectedType === "both"
        ? `Create a Playwright .spec.ts file in the tests/e2e/ directory for this scenario.`
        : "",
      draft.selectedType === "live" || draft.selectedType === "both"
        ? `Create a live playbook JSON in packages/tests/playbooks/pando-node/ for this scenario.`
        : "",
    ].filter(Boolean).join("\n");

    try {
      await fetch("/api/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, project: "testing" }),
      });
      // Mark as promoted
      const updated = drafts.map(d =>
        d.id === draft.id
          ? { ...d, promotedAs: d.selectedType, promotedAt: new Date().toISOString() }
          : d
      );
      onUpdateDrafts(updated);
    } catch { /* ignore */ }

    setPromotingId(null);
  };

  // Promote all selected drafts
  const handlePromoteAll = async () => {
    const toPromote = filtered.filter(d => d.selectedType && !d.promotedAs);
    if (toPromote.length === 0) return;
    setPromotingAll(true);
    for (const draft of toPromote) {
      await handlePromote(draft);
    }
    setPromotingAll(false);
  };

  const selectedCount = drafts.filter(d => d.selectedType).length;
  const staticCount = drafts.filter(d => d.selectedType === "static" || d.selectedType === "both").length;
  const liveCount = drafts.filter(d => d.selectedType === "live" || d.selectedType === "both").length;
  const promotedCount = drafts.filter(d => d.promotedAs).length;
  const readyToPromote = filtered.filter(d => d.selectedType && !d.promotedAs).length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-bold text-amber-300">Draft Scenarios</h2>
          <p className="text-xs text-neutral-500 mt-1">
            Brainstorm test ideas. Check Static, Live, or Both -- then promote to real tests via AI agent.
          </p>
          <div className="flex items-center gap-3 mt-2 text-[10px] text-neutral-500">
            <span>{drafts.length} total</span>
            <span>{selectedCount} selected</span>
            <span className="text-indigo-400">{staticCount} static</span>
            <span className="text-cyan-400">{liveCount} live</span>
            {promotedCount > 0 && <span className="text-green-400">{promotedCount} promoted</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {readyToPromote > 0 && (
            <button
              onClick={handlePromoteAll}
              disabled={promotingAll}
              className={`px-3 py-1.5 text-xs font-semibold rounded transition-colors ${
                promotingAll
                  ? "bg-neutral-800 text-neutral-500 cursor-wait"
                  : "bg-green-600 hover:bg-green-500 text-white"
              }`}
            >
              {promotingAll ? "Promoting..." : `Promote ${readyToPromote} to Agent`}
            </button>
          )}
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="px-3 py-1.5 text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
          >
            + New Draft
          </button>
        </div>
      </div>

      {/* How it works */}
      <div className="bg-neutral-900/50 rounded-lg border border-neutral-800 p-4 text-xs text-neutral-500 space-y-1">
        <p className="text-neutral-400 font-medium">How it works:</p>
        <p>1. Add test ideas below (brainstorm freely)</p>
        <p>2. Check <span className="text-indigo-400">Static</span> (Playwright), <span className="text-cyan-400">Live</span> (AI agent), or both</p>
        <p>3. Click <span className="text-green-400">Promote</span> to send to the AI agent, which will create the actual test files</p>
      </div>

      {/* Add Form */}
      {showAdd && (
        <div className="bg-neutral-900 rounded-lg border border-amber-500/30 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Title</label>
              <input
                type="text"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleAdd()}
                placeholder="e.g. Verify wallet transfer"
                className="w-full text-xs px-3 py-2 rounded bg-neutral-800 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Category</label>
              <input
                type="text"
                value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                placeholder="e.g. wallet, governance"
                className="w-full text-xs px-3 py-2 rounded bg-neutral-800 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-500"
              />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-neutral-500 uppercase tracking-wider block mb-1">Description</label>
            <textarea
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              placeholder="What should this test verify? Be detailed -- the AI agent will use this to create the test."
              rows={3}
              className="w-full text-xs px-3 py-2 rounded bg-neutral-800 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-500 resize-y"
            />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              {(["P0", "P1", "P2"] as const).map(p => (
                <button
                  key={p}
                  onClick={() => setNewPriority(p)}
                  className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors ${
                    newPriority === p ? PRIORITY_COLORS[p] : "bg-neutral-800 text-neutral-500"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <button
              onClick={() => { setShowAdd(false); setNewTitle(""); setNewDesc(""); }}
              className="px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={!newTitle.trim()}
              className="px-4 py-1.5 text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors disabled:opacity-50"
            >
              Add Draft
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search scenarios..."
          className="w-full max-w-xs text-xs px-3 py-2 rounded bg-neutral-900 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-amber-500"
        />
        <div className="flex gap-1">
          {(["P0", "P1", "P2"] as const).map(p => (
            <button
              key={p}
              onClick={() => setFilterPriority(filterPriority === p ? null : p)}
              className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors ${
                filterPriority === p ? PRIORITY_COLORS[p] : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-neutral-500">{filtered.length} scenarios</span>
      </div>

      {/* Grouped Table */}
      {Object.keys(grouped).length === 0 ? (
        <div className="text-sm text-neutral-500 py-8 text-center">
          {search || filterPriority
            ? "No matching scenarios"
            : "No draft scenarios yet. Click \"+ New Draft\" to brainstorm test ideas."}
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category}>
              <h3 className="text-xs font-semibold uppercase tracking-wider mb-2 flex items-center gap-2">
                <span className={getTagColor(category)}>{category}</span>
                <span className="text-[10px] text-neutral-600 font-normal">({items.length})</span>
              </h3>
              <div className="border border-neutral-800 rounded-lg overflow-hidden">
                {/* Table Header */}
                <div className="bg-neutral-900/80 px-4 py-2 flex items-center gap-3 text-[10px] text-neutral-500 uppercase tracking-wider border-b border-neutral-800">
                  <span className="w-8">Pri</span>
                  <span className="flex-1">Scenario</span>
                  <span className="w-16 text-center">Static</span>
                  <span className="w-16 text-center">Live</span>
                  <span className="w-20 text-center">Action</span>
                  <span className="w-8"></span>
                </div>
                {/* Rows */}
                {items.map(d => {
                  const isStatic = d.selectedType === "static" || d.selectedType === "both";
                  const isLive = d.selectedType === "live" || d.selectedType === "both";
                  const isPromoting = promotingId === d.id;
                  const isPromoted = !!d.promotedAs;

                  return (
                    <div
                      key={d.id}
                      className={`px-4 py-2.5 flex items-center gap-3 border-b border-neutral-800 last:border-b-0 transition-colors ${
                        isPromoted ? "bg-green-950/10" : d.selectedType ? "bg-neutral-900/30" : "bg-transparent"
                      }`}
                    >
                      <span className={`text-[10px] font-bold w-8 px-1 py-0.5 rounded text-center ${PRIORITY_COLORS[d.priority] || "text-neutral-500"}`}>
                        {d.priority}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-neutral-200">{d.title}</span>
                          {isPromoted && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-300 font-semibold">
                              PROMOTED {d.promotedAs === "both" ? "(S+L)" : d.promotedAs === "static" ? "(S)" : "(L)"}
                            </span>
                          )}
                        </div>
                        {d.description && <div className="text-[10px] text-neutral-500 mt-0.5 truncate">{d.description}</div>}
                        {d.promotedAt && (
                          <div className="text-[9px] text-green-600 mt-0.5">Sent to agent {relTime(d.promotedAt)}</div>
                        )}
                      </div>
                      <div className="w-16 flex justify-center">
                        <button
                          onClick={() => handleToggle(d.id, "static")}
                          disabled={isPromoted}
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                            isStatic
                              ? "border-indigo-400 bg-indigo-600 text-white"
                              : "border-neutral-700 hover:border-indigo-400"
                          } ${isPromoted ? "opacity-50 cursor-not-allowed" : ""}`}
                        >
                          {isStatic && <span className="text-[10px]">&#x2713;</span>}
                        </button>
                      </div>
                      <div className="w-16 flex justify-center">
                        <button
                          onClick={() => handleToggle(d.id, "live")}
                          disabled={isPromoted}
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                            isLive
                              ? "border-cyan-400 bg-cyan-600 text-white"
                              : "border-neutral-700 hover:border-cyan-400"
                          } ${isPromoted ? "opacity-50 cursor-not-allowed" : ""}`}
                        >
                          {isLive && <span className="text-[10px]">&#x2713;</span>}
                        </button>
                      </div>
                      <div className="w-20 flex justify-center">
                        {isPromoted ? (
                          <span className="text-[9px] text-green-500">&#x2713; Done</span>
                        ) : d.selectedType ? (
                          <button
                            onClick={() => handlePromote(d)}
                            disabled={isPromoting}
                            className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors ${
                              isPromoting
                                ? "bg-neutral-800 text-neutral-500 cursor-wait"
                                : "bg-green-600/20 text-green-300 hover:bg-green-600/40 border border-green-500/30"
                            }`}
                          >
                            {isPromoting ? "..." : "Promote"}
                          </button>
                        ) : (
                          <span className="text-[9px] text-neutral-600">Select type</span>
                        )}
                      </div>
                      <button
                        onClick={() => handleDelete(d.id)}
                        className="w-8 text-center text-[10px] text-red-400/40 hover:text-red-400 transition-colors"
                        title="Delete draft"
                      >
                        &#x2715;
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
