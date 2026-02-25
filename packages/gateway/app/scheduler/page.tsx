"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import NavBar from "@/components/NavBar";

/* ── Types ─────────────────────────────────────────────── */

interface SchedulerStatus {
  running: boolean;
  activeTasks: number | any[];
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed: number;
}

interface TimelineEvent {
  timestamp: string;
  event: string;
  detail: string;
  metadata?: Record<string, any>;
}

interface TaskRoleMetadata {
  roleId: string;
  responsibility: string;
  projectId: string;
  verificationNeeded: boolean;
}

interface Task {
  id: string;
  title: string;
  description?: string;
  priority: string;
  status: string;
  schedulerLifecycle?: string;
  profile?: { id: string; role?: string; tier?: string; score?: number };
  createdAt: number;
  failureReason?: string;
  timeline?: TimelineEvent[];
  parentTask?: string;
  childTasks?: string[];
  roleMetadata?: TaskRoleMetadata;
  cost?: { costUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number; tier?: string; model?: string };
}

interface TaskDetail {
  id: string;
  title: string;
  description: string;
  workspace?: { path: string };
  output?: string;
  failureReason?: string;
  timeline?: TimelineEvent[];
}

interface Profile {
  id?: string;
  profileId?: string;
  role: string;
  tier: string;
  score: number;
  usageCount: number;
  contextNeeds?: string[];
}

interface ActivityStats { total: number; byAction: Record<string, number>; byAgent: Record<string, number> }
interface ActivityEvent { id: string; agentId: string; action: string; summary: string; timestamp: number }

interface LearningStats {
  outcomesTotal: number;
  preferencesCount: number;
}

interface CostStats {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  taskCount: number;
}

interface NetworkSources {
  local: string;
  remoteCount: number;
  respondedCount: number;
}

interface NetworkTask extends Task {
  sourceNode?: string;
  isLocal?: boolean;
  executedByNode?: string;
}

interface SessionStats {
  totalWorkspaces: number;
  activeWorkspaces: number;
  dormantWorkspaces: number;
  byArea: Record<string, { total: number; active: number; dormant: number }>;
}

interface AreaWorkspace {
  taskId: string;
  area: string;
  workspaceDir: string;
  status: 'active' | 'dormant';
  registeredAt: number;
  lastActiveAt: number;
  totalTokens: number;
  taskCount: number;
}

/* ── Helpers ─────────────────────────────────────────────── */

function relTime(ts: number | string): string {
  const diff = Date.now() - (typeof ts === "string" ? new Date(ts).getTime() : ts);
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function statusCls(s: string) {
  if (s === "done" || s === "completed") return "bg-green-500/20 text-green-600 dark:text-green-400";
  if (s === "running" || s === "in_progress") return "bg-blue-500/20 text-blue-600 dark:text-blue-400";
  if (s === "claimed") return "bg-amber-500/20 text-amber-600 dark:text-amber-400";
  if (s === "failed" || s === "rejected") return "bg-red-500/20 text-red-600 dark:text-red-400";
  return "bg-neutral-500/20 text-neutral-600 dark:text-neutral-400";
}

function prioCls(p: string) {
  if (p === "critical") return "text-red-500 dark:text-red-400";
  if (p === "high") return "text-amber-500 dark:text-amber-400";
  if (p === "low") return "text-neutral-500";
  return "text-neutral-700 dark:text-neutral-300";
}

function shortId(id: string) {
  if (!id) return "\u2014";
  return id.length > 16 ? id.slice(0, 8) + "\u2026" + id.slice(-4) : id;
}

function profileKey(p: Profile) { return p.profileId || p.id || ""; }

function roleBadgeCls(meta: TaskRoleMetadata) {
  if (meta.verificationNeeded) return "bg-purple-500/20 text-purple-400 border-purple-500/30";
  return "bg-cyan-500/20 text-cyan-400 border-cyan-500/30";
}

/* ── TaskTimeline ─────────────────────────────────────── */

function tlColor(evt: string) {
  if (evt === "completed" || evt === "parent_completed") return { dot: "bg-green-500", text: "text-green-400" };
  if (evt === "failed") return { dot: "bg-red-500", text: "text-red-400" };
  if (evt === "created") return { dot: "bg-neutral-500", text: "text-neutral-400" };
  if (evt === "hierarchy_designed") return { dot: "bg-cyan-500", text: "text-cyan-400" };
  if (evt === "verification_spawned") return { dot: "bg-purple-500", text: "text-purple-400" };
  if (evt === "planner_consensus") return { dot: "bg-indigo-500", text: "text-indigo-400" };
  if (evt === "tool_scoping") return { dot: "bg-orange-500", text: "text-orange-400" };
  if (["claimed", "planner_called", "profile_generated", "workspace_created", "agent_spawned"].includes(evt))
    return { dot: "bg-blue-500", text: "text-blue-400" };
  return { dot: "bg-amber-500", text: "text-amber-400" };
}

function TaskTimeline({ events, isRunning }: { events: TimelineEvent[]; isRunning: boolean }) {
  if (!events?.length) return <div className="text-xs text-neutral-400 dark:text-neutral-600 text-center py-4">No timeline events.</div>;

  const first = events[0], last = events[events.length - 1];
  let dur: string | null = null;
  if (last.event === "completed" || last.event === "failed" || last.event === "parent_completed") {
    try {
      const s = (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / 1000;
      dur = s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(0)}s`;
    } catch {}
  }

  return (
    <div className="bg-neutral-50 dark:bg-neutral-950 rounded-lg p-4">
      <div className="relative">
        {events.map((evt, i) => {
          const c = tlColor(evt.event);
          const isLast = i === events.length - 1;
          const pulse = isLast && isRunning && evt.event !== "completed" && evt.event !== "failed" && evt.event !== "parent_completed";
          return (
            <div key={i} className="flex gap-3 relative">
              <div className="flex flex-col items-center flex-shrink-0 w-4">
                <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${pulse ? "bg-amber-500 animate-pulse" : c.dot}`} />
                {!isLast && <div className="w-0.5 flex-1 min-h-[16px] bg-neutral-300 dark:bg-neutral-800 mt-0.5" />}
              </div>
              <div className={isLast ? "pb-0" : "pb-3"}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-neutral-500 text-[10px] font-mono">{relTime(evt.timestamp)}</span>
                  <span className={`text-sm font-medium ${c.text}`}>{evt.event.replace(/_/g, " ")}</span>
                </div>
                <p className="text-neutral-600 dark:text-neutral-400 text-sm mt-0.5">{evt.detail}</p>
                {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {Object.entries(evt.metadata).map(([k, v]) => v != null && (
                      <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-500 font-mono">
                        {k}: {typeof v === "object" ? JSON.stringify(v) : String(v)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {dur && (
        <div className={`mt-3 pt-2 border-t border-neutral-300 dark:border-neutral-800 text-xs font-medium ${last.event === "failed" ? "text-red-500 dark:text-red-400" : "text-green-500 dark:text-green-400"}`}>
          {last.event === "failed" ? `Failed after ${dur}` : `Completed in ${dur}`}
        </div>
      )}
    </div>
  );
}

/* ── TaskLogStream ──────────────────────────────────────── */

function TaskLogStream({ taskId }: { taskId: string }) {
  const [lines, setLines] = useState<{ line: string; stream: string }[]>([]);
  const [status, setStatus] = useState("connecting");
  const [finalOutput, setFinalOutput] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  useEffect(() => { if (autoScroll.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);

  useEffect(() => {
    const es = new EventSource(`/api/scheduler/tasks/${encodeURIComponent(taskId)}/stream`);
    let closed = false;
    es.onopen = () => { if (!closed) setStatus("connected"); };
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === "log") setLines(p => { const n = [...p, { line: d.line, stream: d.stream || "stdout" }]; return n.length > 500 ? n.slice(-500) : n; });
        else if (d.type === "status") setStatus(d.status || "running");
        else if (d.type === "done") { setStatus("done"); setFinalOutput(d.output || null); es.close(); }
        else if (d.type === "error") { setStatus("error"); setErrorMsg(d.error || "Unknown error"); es.close(); }
      } catch {}
    };
    es.onerror = () => { if (!closed) setStatus("disconnected"); es.close(); };
    return () => { closed = true; es.close(); };
  }, [taskId]);

  const isLive = status === "connected" || status === "running";

  return (
    <div className="mt-3 rounded-xl overflow-hidden border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950">
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-300 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        <div className="flex items-center gap-2">
          {isLive ? (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-500/20 border border-green-500/30">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-[11px] font-semibold text-green-600 dark:text-green-400 uppercase tracking-wider">Live</span>
            </span>
          ) : (
            <span className={`text-[11px] font-medium ${status === "done" ? "text-green-600 dark:text-green-400" : status === "error" ? "text-red-500 dark:text-red-400" : "text-neutral-500"}`}>
              {status === "done" ? "Completed" : status === "error" ? "Failed" : status}
            </span>
          )}
          {lines.length > 0 && <span className="text-[10px] text-neutral-400 dark:text-neutral-600">{lines.length} lines</span>}
        </div>
        <span className="text-[10px] text-neutral-400 dark:text-neutral-600 font-mono">Agent Output</span>
      </div>
      <div ref={ref} onScroll={() => { if (ref.current) { const { scrollTop, scrollHeight, clientHeight } = ref.current; autoScroll.current = scrollHeight - scrollTop - clientHeight < 40; }}}
        className="overflow-y-auto px-4 py-3 max-h-[400px] min-h-[120px] font-mono text-xs leading-relaxed">
        {lines.length === 0 && !finalOutput && !errorMsg ? (
          <div className="text-neutral-400 dark:text-neutral-600 text-center py-8">{isLive ? "Waiting for agent output..." : "No output yet."}</div>
        ) : lines.map((e, i) => <div key={i}><span className={e.stream === "stderr" ? "text-red-500 dark:text-red-400" : "text-neutral-700 dark:text-neutral-300"}>{e.line}</span></div>)}
        {finalOutput && <div className="mt-3 pt-3 border-t border-neutral-300 dark:border-neutral-800 text-green-600 dark:text-green-400 whitespace-pre-wrap">{finalOutput}</div>}
        {errorMsg && <div className="mt-3 pt-3 border-t border-neutral-300 dark:border-neutral-800 text-red-500 dark:text-red-400 whitespace-pre-wrap">{errorMsg}</div>}
      </div>
    </div>
  );
}

/* ── TaskRow (single task row — used for both parents and children) ── */

function TaskRow({
  task,
  isChild,
  isExpanded,
  onToggle,
  detail,
  loadingDetail,
  childProgress,
}: {
  task: Task;
  isChild?: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  detail: TaskDetail | null;
  loadingDetail: boolean;
  childProgress?: string;
}) {
  const hasChildren = task.childTasks && task.childTasks.length > 0;

  return (
    <div className={isChild ? "border-l-2 border-neutral-300 dark:border-neutral-700 ml-4" : ""}>
      <button onClick={onToggle} className="w-full grid grid-cols-1 sm:grid-cols-12 gap-1 sm:gap-2 px-4 py-2.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition text-left">
        <div className="sm:col-span-4 flex items-center gap-2 min-w-0">
          {hasChildren && (
            <span className="text-neutral-500 text-[10px] flex-shrink-0">{isExpanded ? "\u25BC" : "\u25B6"}</span>
          )}
          {isChild && <span className="text-neutral-600 flex-shrink-0">\u2514</span>}
          <span className="text-neutral-700 dark:text-neutral-300 truncate font-medium hover:text-amber-500 dark:hover:text-amber-400">{task.title}</span>
        </div>
        <div className="sm:col-span-1 flex items-center gap-1.5">
          <span className={prioCls(task.priority)}>{task.priority}</span>
        </div>
        <div className="sm:col-span-2 flex items-center gap-1.5">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusCls(task.status)}`}>{task.status}</span>
          {task.roleMetadata && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${roleBadgeCls(task.roleMetadata)}`}>
              {task.roleMetadata.roleId}
            </span>
          )}
        </div>
        <div className="sm:col-span-2 text-neutral-500 truncate">
          {childProgress || task.schedulerLifecycle || "\u2014"}
        </div>
        <div className="sm:col-span-2 text-neutral-500 truncate">{task.profile ? shortId(task.profile.id) : "\u2014"}</div>
        <div className="sm:col-span-1 text-neutral-500">
          {task.cost?.costUsd ? (
            <span className="text-green-500 font-mono" title={`${task.cost.inputTokens?.toLocaleString() || '?'} in / ${task.cost.outputTokens?.toLocaleString() || '?'} out`}>${task.cost.costUsd < 0.01 ? task.cost.costUsd.toFixed(4) : task.cost.costUsd.toFixed(2)}</span>
          ) : task.createdAt ? relTime(task.createdAt) : "\u2014"}
        </div>
      </button>
      {isExpanded && (
        <div className="px-4 pb-4 bg-neutral-100/50 dark:bg-neutral-800/30 border-t border-neutral-300 dark:border-neutral-800">
          {loadingDetail ? <div className="py-4 text-xs text-neutral-500">Loading...</div> : detail ? (
            <div className="py-3 space-y-4 text-xs">
              {detail.description && <div><span className="text-neutral-500 font-medium">Description:</span><p className="text-neutral-600 dark:text-neutral-400 mt-1 whitespace-pre-wrap">{detail.description}</p></div>}
              {task.roleMetadata && (
                <div className="flex flex-wrap gap-3">
                  <div><span className="text-neutral-500 font-medium">Role:</span> <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${roleBadgeCls(task.roleMetadata)}`}>{task.roleMetadata.roleId}</span></div>
                  <div><span className="text-neutral-500 font-medium">Responsibility:</span> <span className="text-neutral-600 dark:text-neutral-400 ml-1">{task.roleMetadata.responsibility}</span></div>
                  {task.roleMetadata.verificationNeeded && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/20 text-purple-400 border border-purple-500/30">Verifier</span>}
                </div>
              )}
              {((detail.timeline?.length ?? 0) > 0 || (task.timeline?.length ?? 0) > 0) && (
                <div><span className="text-neutral-500 font-medium text-xs mb-2 block">Timeline</span>
                  <TaskTimeline events={(detail.timeline?.length ?? 0) > 0 ? detail.timeline! : (task.timeline || [])} isRunning={task.status === "in_progress" || task.schedulerLifecycle === "running"} />
                </div>
              )}
              {(task.status === "in_progress" || task.schedulerLifecycle === "running") && <TaskLogStream taskId={task.id} />}
              {(task.failureReason || detail.failureReason) && (
                <div><span className="text-red-500 font-medium">Failure:</span>
                  <p className="mt-1 p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 font-mono whitespace-pre-wrap text-[11px]">{task.failureReason || detail.failureReason}</p>
                </div>
              )}
              {detail.output && <div><span className="text-neutral-500 font-medium">Output:</span><pre className="mt-1 p-2 rounded-lg bg-neutral-200 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto text-[11px]">{detail.output}</pre></div>}
              {detail.workspace?.path && <div><span className="text-neutral-500 font-medium">Workspace:</span><code className="ml-2 text-neutral-600 dark:text-neutral-400 font-mono">{detail.workspace.path}</code></div>}
              <div className="pt-2"><a href={`/scheduler/task/${task.id}`} className="text-xs text-amber-500 hover:text-amber-400 underline transition">View full detail page &rarr;</a></div>
            </div>
          ) : <div className="py-4 text-xs text-neutral-500">No details available</div>}
        </div>
      )}
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────── */

export default function SchedulerPage() {
  const [tab, setTab] = useState<"tasks" | "profiles" | "activity">("tasks");
  const [sched, setSched] = useState<SchedulerStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [offline, setOffline] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());

  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formPrio, setFormPrio] = useState("medium");
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [showPrioHelp, setShowPrioHelp] = useState(false);
  const prioHelpRef = useRef<HTMLDivElement>(null);

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [timeWin, setTimeWin] = useState("24h");

  const [learning, setLearning] = useState<LearningStats>({ outcomesTotal: 0, preferencesCount: 0 });
  const [costs, setCosts] = useState<CostStats>({ totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, taskCount: 0 });

  // Sessions state removed — sessions/stats endpoints were dead routes

  const [viewMode, setViewMode] = useState<"local" | "network">("local");
  const [networkTasks, setNetworkTasks] = useState<NetworkTask[]>([]);
  const [networkSources, setNetworkSources] = useState<NetworkSources | null>(null);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [networkExpanded, setNetworkExpanded] = useState<string | null>(null);
  const [networkDetail, setNetworkDetail] = useState<any>(null);
  const [networkDetailLoading, setNetworkDetailLoading] = useState(false);

  const fetchTasks = useCallback(async () => {
    try {
      const [sr, tr] = await Promise.all([
        fetch("/api/scheduler/status"),
        fetch("/api/scheduler/tasks"),
      ]);
      setOffline(false);
      if (sr.ok) { setSched(await sr.json()); setLoaded(true); }
      if (tr.ok) { const d = await tr.json(); setTasks(d.tasks || d || []); }
    } catch { setOffline(true); }
  }, []);

  const fetchDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/scheduler/tasks/${encodeURIComponent(id)}`);
      if (res.ok) {
        const d = await res.json();
        setDetail({
          id: d.task?.id || id, title: d.task?.title || "", description: d.task?.description || "",
          workspace: d.scheduler?.workspace ? { path: d.scheduler.workspace.dir || d.scheduler.workspace.path } : undefined,
          output: d.output || undefined, failureReason: d.failureReason || undefined,
          timeline: d.timeline || d.task?.timeline || [],
        });
      }
    } catch {}
    setLoadingDetail(false);
  }, []);

  const fetchProfiles = useCallback(async () => {
    // Profiles endpoint removed (dead route). Profiles are no longer fetched from the server.
    setProfiles([]);
  }, []);

  const fetchStats = useCallback(async (w: string) => {
    try { const r = await fetch(`/api/activity/stats?window=${w}`); if (r.ok) setStats(await r.json()); } catch {}
  }, []);

  const fetchEvents = useCallback(async () => {
    try { const r = await fetch("/api/activity/stream?limit=50"); if (r.ok) { const d = await r.json(); setEvents(d.events || []); } } catch {}
  }, []);

  const fetchLearning = useCallback(async () => {
    // Outcomes endpoint removed (dead route). Learning stats are no longer fetched from the server.
    setLearning({ outcomesTotal: 0, preferencesCount: 0 });
  }, []);

  const fetchCosts = useCallback(async () => {
    try {
      const r = await fetch("/api/scheduler/costs");
      if (r.ok) { const cd = await r.json(); setCosts({ totalCostUsd: cd.totalCostUsd ?? 0, totalInputTokens: cd.totalInputTokens ?? 0, totalOutputTokens: cd.totalOutputTokens ?? 0, taskCount: cd.taskCount ?? 0 }); }
    } catch {}
  }, []);

  const fetchNetworkDetail = useCallback(async (task: NetworkTask) => {
    const key = `${task.sourceNode}-${task.id}`;
    if (networkExpanded === key) { setNetworkExpanded(null); setNetworkDetail(null); return; }
    setNetworkExpanded(key);
    setNetworkDetailLoading(true);
    setNetworkDetail(null);
    try {
      // For local tasks, use the regular detail endpoint; for remote, use the P2P relay
      const url = task.isLocal
        ? `/api/scheduler/tasks/${encodeURIComponent(task.id)}`
        : `/api/scheduler/remote/${encodeURIComponent(task.sourceNode || "")}/tasks/${encodeURIComponent(task.id)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (r.ok) setNetworkDetail(await r.json());
    } catch {}
    setNetworkDetailLoading(false);
  }, [networkExpanded]);

  const fetchNetworkTasks = useCallback(async () => {
    setNetworkLoading(true);
    try {
      const r = await fetch("/api/scheduler/network/tasks?limit=100");
      if (r.ok) {
        const d = await r.json();
        setNetworkTasks(d.tasks || []);
        setNetworkSources(d.sources || null);
      }
    } catch {}
    setNetworkLoading(false);
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (prioHelpRef.current && !prioHelpRef.current.contains(e.target as Node)) setShowPrioHelp(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setShowPrioHelp(false);
    }
    if (showPrioHelp) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [showPrioHelp]);

  useEffect(() => { fetchTasks(); fetchLearning(); fetchCosts(); const i = setInterval(() => { fetchTasks(); fetchCosts(); }, 5000); return () => clearInterval(i); }, [fetchTasks, fetchLearning, fetchCosts]);
  useEffect(() => { if (viewMode === "network") { fetchNetworkTasks(); const i = setInterval(fetchNetworkTasks, 8000); return () => clearInterval(i); } }, [viewMode, fetchNetworkTasks]);
  useEffect(() => { if (tab === "profiles") fetchProfiles(); }, [tab, fetchProfiles]);
  useEffect(() => {
    if (tab !== "activity") return;
    fetchStats(timeWin); fetchEvents();
    const i = setInterval(fetchEvents, 10000);
    return () => clearInterval(i);
  }, [tab, timeWin, fetchStats, fetchEvents]);

  const handleSubmit = async () => {
    if (!formTitle.trim()) return;
    setSubmitting(true); setSubmitMsg(null);
    try {
      const r = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: formTitle, description: formDesc, priority: formPrio }) });
      if (r.ok) { const d = await r.json(); setSubmitMsg({ ok: true, text: `Task created (${shortId(d.id || d.taskId || "")})` }); setFormTitle(""); setFormDesc(""); setFormPrio("medium"); setTimeout(fetchTasks, 500); }
      else { const e = await r.json(); setSubmitMsg({ text: e.error || "Failed" }); }
    } catch { setSubmitMsg({ text: "Network error" }); }
    setSubmitting(false);
  };

  const toggle = (id: string) => { if (expanded === id) { setExpanded(null); setDetail(null); } else { setExpanded(id); fetchDetail(id); } };

  const toggleParent = (id: string) => {
    setExpandedParents(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Group tasks: top-level (no parentTask) first, children nested inside parents
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const parentTasks = tasks.filter(t => !t.parentTask);
  const childTasksById = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.parentTask) {
      const list = childTasksById.get(t.parentTask) || [];
      list.push(t);
      childTasksById.set(t.parentTask, list);
    }
  }

  function getChildProgress(parentId: string): string | undefined {
    const children = childTasksById.get(parentId);
    if (!children || children.length === 0) return undefined;
    const done = children.filter(c => c.status === "done" || c.status === "completed").length;
    return `${done}/${children.length} roles complete`;
  }

  const tabs = [{ id: "tasks" as const, label: "Tasks" }, { id: "profiles" as const, label: "Profiles" }, { id: "activity" as const, label: "Activity" }];

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Tabs */}
        <div className="flex gap-1 bg-neutral-100 dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-800 rounded-xl p-1">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex-1 px-4 py-2 text-sm font-medium rounded-lg transition ${tab === t.id ? "bg-amber-500/15 text-amber-500 dark:text-amber-400 border border-amber-500/25" : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 border border-transparent"}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Tasks Tab ─────────────────────────────────── */}
        {tab === "tasks" && (
          <div className="space-y-6">
            {offline && <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">Cannot connect to Pando node.</div>}
            {!offline && loaded && sched && !sched.running && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm text-center">
                Scheduler not running — start node with <code className="font-mono bg-amber-500/10 px-1 rounded">--scheduler</code>
              </div>
            )}

            {/* View mode toggle */}
            <div className="flex items-center gap-3">
              <div className="flex bg-neutral-100 dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-800 rounded-lg p-0.5">
                <button onClick={() => setViewMode("local")}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "local" ? "bg-amber-500/15 text-amber-500 dark:text-amber-400 border border-amber-500/25" : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 border border-transparent"}`}>
                  My Node
                </button>
                <button onClick={() => setViewMode("network")}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${viewMode === "network" ? "bg-cyan-500/15 text-cyan-500 dark:text-cyan-400 border border-cyan-500/25" : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 border border-transparent"}`}>
                  Entire Network
                </button>
              </div>
              {viewMode === "network" && networkSources && (
                <span className="text-[10px] text-neutral-500">
                  {networkSources.respondedCount}/{networkSources.remoteCount} peers responded
                  {networkLoading && <span className="ml-1 text-cyan-400 animate-pulse">syncing...</span>}
                </span>
              )}
            </div>

            {/* Stats row + Learning indicator + Cost */}
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-4">
              {[
                { label: "Scheduler", render: () => (
                  <div className="flex items-center justify-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${!loaded ? "bg-neutral-400 animate-pulse" : sched?.running ? "bg-green-500" : "bg-red-500"}`} />
                    <span className={`text-sm font-medium ${!loaded ? "text-neutral-500" : sched?.running ? "text-green-400" : "text-red-400"}`}>
                      {!loaded ? "Loading..." : sched?.running ? "Running" : "Stopped"}
                    </span>
                  </div>
                )},
                { label: "Active", value: Array.isArray(sched?.activeTasks) ? sched.activeTasks.length : (sched?.activeTasks ?? 0) },
                { label: "Processed", value: sched?.totalProcessed ?? 0 },
                { label: "Success / Fail", render: () => (
                  <p className="text-lg font-mono font-bold"><span className="text-green-400">{sched?.totalSucceeded ?? 0}</span><span className="text-neutral-600 mx-1">/</span><span className="text-red-400">{sched?.totalFailed ?? 0}</span></p>
                )},
                { label: "Learning", render: () => (
                  <div className="text-center">
                    <p className="text-xs text-neutral-400">
                      <span className="text-amber-400 font-mono font-bold">{learning.outcomesTotal}</span>
                      <span className="text-neutral-600 mx-1">outcomes</span>
                    </p>
                    <p className="text-xs text-neutral-400">
                      <span className="text-amber-400 font-mono font-bold">{learning.preferencesCount}</span>
                      <span className="text-neutral-600 mx-1">preferences</span>
                    </p>
                  </div>
                )},
                { label: "Cost", render: () => (
                  <div className="text-center">
                    <p className="text-lg font-mono font-bold text-green-400">
                      ${costs.totalCostUsd < 0.01 ? costs.totalCostUsd.toFixed(4) : costs.totalCostUsd.toFixed(2)}
                    </p>
                    <p className="text-[10px] text-neutral-500">
                      {costs.taskCount} tasks tracked
                    </p>
                  </div>
                )},
              ].map((c, i) => (
                <div key={i} className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
                  <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">{c.label}</p>
                  {c.render ? c.render() : <p className="text-lg font-mono font-bold text-neutral-800 dark:text-neutral-200">{c.value}</p>}
                </div>
              ))}
            </div>

            {/* Submit form */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4 space-y-3">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Submit Task</h2>
              <div className="flex gap-3">
                <input type="text" value={formTitle} onChange={e => { setFormTitle(e.target.value); setSubmitMsg(null); }} onKeyDown={e => e.key === "Enter" && handleSubmit()}
                  placeholder="Task title" className="flex-1 px-3 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50" />
                <div className="relative flex items-center gap-1.5" ref={prioHelpRef}>
                  <select value={formPrio} onChange={e => setFormPrio(e.target.value)} className="px-3 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 text-sm text-neutral-700 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-amber-500/50">
                    <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setShowPrioHelp(prev => !prev)}
                    className="w-5 h-5 flex items-center justify-center rounded-full bg-neutral-300 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-amber-500/30 hover:text-amber-500 dark:hover:text-amber-400 transition flex-shrink-0"
                    aria-label="Priority level help"
                    aria-expanded={showPrioHelp}
                    aria-describedby={showPrioHelp ? "prio-help-tooltip" : undefined}
                    title="What do priority levels mean?"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M8 7v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      <circle cx="8" cy="4.5" r="0.75" fill="currentColor" />
                    </svg>
                  </button>
                  {showPrioHelp && (
                    <div id="prio-help-tooltip" className="absolute top-full right-0 mt-2 w-64 sm:w-72 bg-white dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded-xl shadow-lg z-50 p-3 space-y-2 text-xs" role="tooltip">
                      <p className="font-semibold text-neutral-700 dark:text-neutral-300 mb-1">Priority Levels</p>
                      <div className="flex items-start gap-2">
                        <span className="text-neutral-500 font-medium w-14 shrink-0">Low</span>
                        <span className="text-neutral-600 dark:text-neutral-400">Background tasks. Processed when no higher-priority work is pending.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-neutral-700 dark:text-neutral-300 font-medium w-14 shrink-0">Medium</span>
                        <span className="text-neutral-600 dark:text-neutral-400">Default. Standard processing order, suitable for most tasks.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-amber-500 dark:text-amber-400 font-medium w-14 shrink-0">High</span>
                        <span className="text-neutral-600 dark:text-neutral-400">Urgent work. Jumped ahead of low and medium tasks in the queue.</span>
                      </div>
                      <div className="flex items-start gap-2">
                        <span className="text-red-500 dark:text-red-400 font-medium w-14 shrink-0">Critical</span>
                        <span className="text-neutral-600 dark:text-neutral-400">Top priority. Processed immediately, ahead of all other tasks.</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <textarea value={formDesc} onChange={e => setFormDesc(e.target.value)} placeholder="Description (optional)" rows={2}
                className="w-full px-3 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 resize-none" />
              <div className="flex items-center gap-3">
                <button onClick={handleSubmit} disabled={submitting || !formTitle.trim()}
                  className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-4 py-2 text-sm transition">
                  {submitting ? "Submitting..." : "Submit"}
                </button>
                {submitMsg && <span className={`text-xs ${submitMsg.ok ? "text-green-400" : "text-red-400"}`}>{submitMsg.text}</span>}
              </div>
            </div>

            {/* Task table — Local view */}
            {viewMode === "local" && (
              <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800"><h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Task Queue</h2></div>
                {tasks.length === 0 ? (
                  <div className="px-4 py-12 text-center"><p className="text-sm text-neutral-600 dark:text-neutral-400">No tasks yet.</p><p className="text-xs text-neutral-500 mt-1">Submit one above to get started.</p></div>
                ) : (
                  <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                    <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-2 text-xs text-neutral-500 font-medium">
                      <div className="col-span-4">Title</div><div className="col-span-1">Priority</div><div className="col-span-2">Status / Role</div>
                      <div className="col-span-2">Lifecycle</div><div className="col-span-2">Profile</div><div className="col-span-1">Age</div>
                    </div>
                    {parentTasks.map(task => {
                      const children = childTasksById.get(task.id) || [];
                      const hasChildren = children.length > 0;
                      const isParentExpanded = expandedParents.has(task.id);

                      return (
                        <div key={task.id}>
                          <div className="relative">
                            {hasChildren && (
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleParent(task.id); }}
                                className="absolute left-1 top-1/2 -translate-y-1/2 z-10 w-6 h-6 flex items-center justify-center text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition text-[10px]"
                                title={isParentExpanded ? "Collapse subtasks" : "Expand subtasks"}
                              >
                                {isParentExpanded ? "\u25BC" : "\u25B6"}
                              </button>
                            )}
                            <TaskRow
                              task={task}
                              isExpanded={expanded === task.id}
                              onToggle={() => toggle(task.id)}
                              detail={expanded === task.id ? detail : null}
                              loadingDetail={expanded === task.id ? loadingDetail : false}
                              childProgress={getChildProgress(task.id)}
                            />
                          </div>

                          {hasChildren && isParentExpanded && (
                            <div className="bg-neutral-50 dark:bg-neutral-900/30">
                              {children.map(child => (
                                <div key={child.id} className="border-t border-neutral-200 dark:border-neutral-800/50">
                                  <TaskRow
                                    task={child}
                                    isChild
                                    isExpanded={expanded === child.id}
                                    onToggle={() => toggle(child.id)}
                                    detail={expanded === child.id ? detail : null}
                                    loadingDetail={expanded === child.id ? loadingDetail : false}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Task table — Network view */}
            {viewMode === "network" && (
              <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Network Tasks</h2>
                  <span className="text-[10px] text-neutral-500 font-mono">
                    {networkTasks.length} tasks from {networkSources ? `${networkSources.respondedCount + 1} nodes` : "..."}
                  </span>
                </div>
                {networkLoading && networkTasks.length === 0 ? (
                  <div className="px-4 py-12 text-center">
                    <p className="text-sm text-neutral-500 animate-pulse">Querying network peers...</p>
                  </div>
                ) : networkTasks.length === 0 ? (
                  <div className="px-4 py-12 text-center">
                    <p className="text-sm text-neutral-600 dark:text-neutral-400">No tasks found across the network.</p>
                    <p className="text-xs text-neutral-500 mt-1">Connect more peers or submit tasks.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                    <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-2 text-xs text-neutral-500 font-medium">
                      <div className="col-span-4">Title</div><div className="col-span-1">Priority</div><div className="col-span-2">Status</div>
                      <div className="col-span-2">Source Node</div><div className="col-span-2">Cost</div><div className="col-span-1">Age</div>
                    </div>
                    {networkTasks.map(task => {
                      const key = `${task.sourceNode}-${task.id}`;
                      const isExp = networkExpanded === key;
                      return (
                        <div key={key}>
                          <button onClick={() => fetchNetworkDetail(task)}
                            className="w-full grid grid-cols-1 sm:grid-cols-12 gap-1 sm:gap-2 px-4 py-2.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition text-left">
                            <div className="sm:col-span-4 flex items-center gap-2 min-w-0">
                              {task.isLocal ? (
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" title="Local" />
                              ) : (
                                <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 flex-shrink-0" title="Remote" />
                              )}
                              <span className="text-neutral-700 dark:text-neutral-300 truncate font-medium hover:text-amber-500 dark:hover:text-amber-400">{task.title}</span>
                            </div>
                            <div className="sm:col-span-1">
                              <span className={prioCls(task.priority)}>{task.priority}</span>
                            </div>
                            <div className="sm:col-span-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusCls(task.status)}`}>{task.status}</span>
                            </div>
                            <div className="sm:col-span-2 text-neutral-500 font-mono truncate" title={task.sourceNode}>
                              {task.isLocal ? (
                                <span className="text-amber-400">local</span>
                              ) : (
                                shortId(task.sourceNode || "")
                              )}
                            </div>
                            <div className="sm:col-span-2 text-neutral-500">
                              {task.cost?.costUsd ? (
                                <span className="text-green-500 font-mono">${task.cost.costUsd < 0.01 ? task.cost.costUsd.toFixed(4) : task.cost.costUsd.toFixed(2)}</span>
                              ) : "\u2014"}
                            </div>
                            <div className="sm:col-span-1 text-neutral-500">
                              {task.createdAt ? relTime(task.createdAt) : "\u2014"}
                            </div>
                          </button>
                          {isExp && (
                            <div className="px-4 pb-4 bg-neutral-100/50 dark:bg-neutral-800/30 border-t border-neutral-300 dark:border-neutral-800">
                              {networkDetailLoading ? (
                                <div className="py-4 text-xs text-neutral-500 animate-pulse">
                                  {task.isLocal ? "Loading..." : "Querying remote node via P2P..."}
                                </div>
                              ) : networkDetail ? (
                                <div className="py-3 space-y-3 text-xs">
                                  {/* Description */}
                                  {(networkDetail.task?.description || networkDetail.description) && (
                                    <div>
                                      <span className="text-neutral-500 font-medium">Description:</span>
                                      <p className="text-neutral-600 dark:text-neutral-400 mt-1 whitespace-pre-wrap">
                                        {networkDetail.task?.description || networkDetail.description}
                                      </p>
                                    </div>
                                  )}
                                  {/* Source */}
                                  <div className="flex flex-wrap gap-3">
                                    <div>
                                      <span className="text-neutral-500 font-medium">Source:</span>
                                      <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-mono ${task.isLocal ? "bg-amber-500/20 text-amber-400" : "bg-cyan-500/20 text-cyan-400"}`}>
                                        {task.isLocal ? "local" : shortId(task.sourceNode || "")}
                                      </span>
                                    </div>
                                    {(networkDetail.task?.executedByNode || task.executedByNode) && (
                                      <div>
                                        <span className="text-neutral-500 font-medium">Executed by:</span>
                                        <span className="ml-1 text-neutral-600 dark:text-neutral-400 font-mono text-[10px]">
                                          {shortId(networkDetail.task?.executedByNode || task.executedByNode || "")}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                  {/* Cost */}
                                  {(networkDetail.task?.cost || task.cost) && (
                                    <div className="flex flex-wrap gap-3">
                                      {(networkDetail.task?.cost?.costUsd ?? task.cost?.costUsd) != null && (
                                        <span className="text-green-500 font-mono">${(networkDetail.task?.cost?.costUsd ?? task.cost?.costUsd ?? 0).toFixed(4)} USD</span>
                                      )}
                                      {(networkDetail.task?.cost?.model || task.cost?.model) && (
                                        <span className="text-purple-400 font-mono">{networkDetail.task?.cost?.model || task.cost?.model}</span>
                                      )}
                                      {(networkDetail.task?.cost?.tier || task.cost?.tier) && (
                                        <span className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 text-[10px]">{networkDetail.task?.cost?.tier || task.cost?.tier}</span>
                                      )}
                                    </div>
                                  )}
                                  {/* Timeline */}
                                  {((networkDetail.timeline?.length ?? 0) > 0 || (networkDetail.task?.timeline?.length ?? 0) > 0) && (
                                    <div>
                                      <span className="text-neutral-500 font-medium text-xs mb-2 block">Timeline</span>
                                      <TaskTimeline
                                        events={networkDetail.timeline?.length ? networkDetail.timeline : (networkDetail.task?.timeline || [])}
                                        isRunning={task.status === "in_progress"}
                                      />
                                    </div>
                                  )}
                                  {/* Output */}
                                  {(networkDetail.output || networkDetail.task?.output) && (
                                    <div>
                                      <span className="text-neutral-500 font-medium">Output:</span>
                                      <pre className="mt-1 p-2 rounded-lg bg-neutral-200 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto text-[11px]">
                                        {networkDetail.output || networkDetail.task?.output}
                                      </pre>
                                    </div>
                                  )}
                                  {/* Failure reason */}
                                  {(networkDetail.failureReason || networkDetail.task?.failureReason) && (
                                    <div>
                                      <span className="text-red-500 font-medium">Failure:</span>
                                      <p className="mt-1 p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 font-mono whitespace-pre-wrap text-[11px]">
                                        {networkDetail.failureReason || networkDetail.task?.failureReason}
                                      </p>
                                    </div>
                                  )}
                                  {/* Link to full detail */}
                                  {task.isLocal && (
                                    <div className="pt-2">
                                      <a href={`/scheduler/task/${task.id}`} className="text-xs text-amber-500 hover:text-amber-400 underline transition">
                                        View full detail page &rarr;
                                      </a>
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="py-4 text-xs text-neutral-500">
                                  {task.isLocal ? "No details available" : "Could not reach remote node"}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Profiles Tab ────────────────────────────────── */}
        {tab === "profiles" && (
          <div>
            {profiles.length === 0 ? (
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl px-4 py-8 text-center text-sm text-neutral-500">No cached profiles. Submit tasks to generate profiles.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {profiles.map(p => (
                  <div key={profileKey(p)} className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
                    <button onClick={() => setExpandedProfile(expandedProfile === profileKey(p) ? null : profileKey(p))} className="w-full p-4 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/30 transition">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-mono text-neutral-500">{shortId(profileKey(p))}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${p.tier === "deep" ? "bg-purple-500/20 text-purple-400" : p.tier === "quick" ? "bg-blue-500/20 text-blue-400" : "bg-neutral-500/20 text-neutral-400"}`}>{p.tier || "standard"}</span>
                      </div>
                      <p className="text-sm text-neutral-700 dark:text-neutral-300 line-clamp-2 mb-2">{p.role?.slice(0, 100) || "No role defined"}</p>
                      <div className="flex items-center gap-4 text-xs">
                        <span className={`px-1.5 py-0.5 rounded font-medium ${(p.score ?? 0) > 0 ? "bg-green-500/20 text-green-400" : (p.score ?? 0) < 0 ? "bg-red-500/20 text-red-400" : "bg-neutral-500/20 text-neutral-400"}`}>Score: {p.score ?? 0}</span>
                        <span className="text-neutral-500">Used: {p.usageCount ?? 0}</span>
                      </div>
                    </button>
                    {expandedProfile === profileKey(p) && (
                      <div className="px-4 pb-4 border-t border-neutral-300 dark:border-neutral-800 space-y-2">
                        <div className="pt-3"><span className="text-xs text-neutral-500 font-medium">Full Role Prompt:</span><pre className="mt-1 text-xs text-neutral-600 dark:text-neutral-400 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">{p.role || "\u2014"}</pre></div>
                        {p.contextNeeds?.length ? (
                          <div><span className="text-xs text-neutral-500 font-medium">Context Needs:</span>
                            <div className="mt-1 flex flex-wrap gap-1">{p.contextNeeds.map((n, i) => <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400">{n}</span>)}</div>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Activity Tab ────────────────────────────────── */}
        {tab === "activity" && (
          <div className="space-y-6">
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Activity Stats</h2>
                <div className="flex gap-1">
                  {["1h", "6h", "24h", "7d"].map(w => (
                    <button key={w} onClick={() => { setTimeWin(w); fetchStats(w); }}
                      className={`px-2.5 py-1 text-xs rounded-lg transition ${timeWin === w ? "bg-amber-500/15 text-amber-500 dark:text-amber-400 border border-amber-500/25" : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 border border-transparent"}`}>{w}</button>
                  ))}
                </div>
              </div>
              {stats ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-3 rounded-lg bg-neutral-200/50 dark:bg-neutral-800/50 border border-neutral-300 dark:border-neutral-700"><p className="text-xs text-neutral-500 mb-1">Total Events</p><p className="text-lg font-mono font-bold text-neutral-800 dark:text-neutral-200">{stats.total ?? 0}</p></div>
                  <div className="p-3 rounded-lg bg-neutral-200/50 dark:bg-neutral-800/50 border border-neutral-300 dark:border-neutral-700"><p className="text-xs text-neutral-500 mb-1">By Action</p>
                    {stats.byAction && Object.entries(stats.byAction).length > 0 ? Object.entries(stats.byAction).slice(0, 5).map(([a, c]) => <div key={a} className="flex justify-between text-xs"><span className="text-neutral-600 dark:text-neutral-400">{a}</span><span className="text-neutral-800 dark:text-neutral-200 font-mono">{c as number}</span></div>) : <span className="text-xs text-neutral-500">No data</span>}
                  </div>
                  <div className="p-3 rounded-lg bg-neutral-200/50 dark:bg-neutral-800/50 border border-neutral-300 dark:border-neutral-700"><p className="text-xs text-neutral-500 mb-1">By Agent</p>
                    {stats.byAgent && Object.entries(stats.byAgent).length > 0 ? Object.entries(stats.byAgent).slice(0, 5).map(([a, c]) => <div key={a} className="flex justify-between text-xs"><span className="text-neutral-600 dark:text-neutral-400 truncate mr-2">{shortId(a)}</span><span className="text-neutral-800 dark:text-neutral-200 font-mono">{c as number}</span></div>) : <span className="text-xs text-neutral-500">No data</span>}
                  </div>
                </div>
              ) : <div className="text-xs text-neutral-500 text-center py-4">Loading stats...</div>}
            </div>

            <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800"><h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Event Feed</h2></div>
              {events.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-neutral-500">No activity recorded yet.</div>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800 max-h-[500px] overflow-y-auto">
                  {events.map((e, i) => (
                    <div key={e.id || i} className="px-4 py-2.5 flex items-start gap-3 text-xs">
                      <span className="text-neutral-500 font-mono w-14 shrink-0">{e.timestamp ? relTime(e.timestamp) : "\u2014"}</span>
                      <span className="text-neutral-500 font-mono w-20 shrink-0 truncate">{shortId(e.agentId || "")}</span>
                      <span className="px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 shrink-0">{e.action || "\u2014"}</span>
                      <span className="text-neutral-600 dark:text-neutral-400 truncate">{e.summary || "\u2014"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
