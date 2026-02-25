"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import NavBar from "@/components/NavBar";

/* ── Types ─────────────────────────────────────────────── */

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

interface TaskCost {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  tier?: string;
  model?: string;
}

interface TaskData {
  id: string;
  title: string;
  description?: string;
  priority: string;
  status: string;
  createdBy?: string;
  assignedTo?: string;
  files?: string[];
  dependencies?: string[];
  createdAt: number;
  updatedAt?: number;
  result?: { commitHash?: string; buildPassed?: boolean; testsPassed?: boolean; note?: string };
  failureReason?: string;
  timeline?: TimelineEvent[];
  parentTask?: string;
  childTasks?: string[];
  roleMetadata?: TaskRoleMetadata;
  schedulerLifecycle?: string;
  cost?: TaskCost;
  proposalId?: string;
}

interface ThreadMessage {
  id: string;
  taskId: string;
  from: string;
  role: "user" | "agent" | "system";
  content: string;
  createdAt: number;
}

interface SchedulerInfo {
  lifecycle?: string;
  profile?: { id: string; role?: string; tier?: string; score?: number } | null;
  workspace?: { dir?: string; path?: string; status?: string; claudeMdPath?: string } | null;
}

/* ── Helpers ─────────────────────────────────────────────── */

function relTime(ts: number | string): string {
  const d = typeof ts === "string" ? new Date(ts).getTime() : ts;
  const diff = Date.now() - d;
  if (diff < 0) return "just now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function fmtDate(ts: number | string): string {
  const d = new Date(typeof ts === "string" ? ts : ts);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusCls(s: string) {
  if (s === "done" || s === "completed") return "bg-green-500/20 text-green-600 dark:text-green-400";
  if (s === "running" || s === "in_progress") return "bg-blue-500/20 text-blue-600 dark:text-blue-400";
  if (s === "claimed") return "bg-amber-500/20 text-amber-600 dark:text-amber-400";
  if (s === "failed" || s === "rejected") return "bg-red-500/20 text-red-600 dark:text-red-400";
  return "bg-neutral-500/20 text-neutral-600 dark:text-neutral-400";
}

function prioCls(p: string) {
  if (p === "critical") return "text-red-500 dark:text-red-400 bg-red-500/10 border-red-500/20";
  if (p === "high") return "text-amber-500 dark:text-amber-400 bg-amber-500/10 border-amber-500/20";
  if (p === "low") return "text-neutral-500 bg-neutral-500/10 border-neutral-500/20";
  return "text-blue-500 dark:text-blue-400 bg-blue-500/10 border-blue-500/20";
}

function tlColor(evt: string) {
  if (evt === "completed" || evt === "parent_completed") return { dot: "bg-green-500", text: "text-green-400", bg: "bg-green-500/5" };
  if (evt === "failed") return { dot: "bg-red-500", text: "text-red-400", bg: "bg-red-500/5" };
  if (evt === "created") return { dot: "bg-neutral-500", text: "text-neutral-400", bg: "" };
  if (evt === "hierarchy_designed") return { dot: "bg-cyan-500", text: "text-cyan-400", bg: "bg-cyan-500/5" };
  if (evt === "reflection_collected") return { dot: "bg-indigo-500", text: "text-indigo-400", bg: "bg-indigo-500/5" };
  if (evt === "verification_spawned") return { dot: "bg-purple-500", text: "text-purple-400", bg: "bg-purple-500/5" };
  if (evt === "planner_consensus") return { dot: "bg-indigo-500", text: "text-indigo-400", bg: "bg-indigo-500/5" };
  if (evt === "decomposing" || evt === "decomposed") return { dot: "bg-violet-500", text: "text-violet-400", bg: "bg-violet-500/5" };
  if (["claimed", "planner_called", "profile_generated", "workspace_created", "agent_spawned"].includes(evt))
    return { dot: "bg-blue-500", text: "text-blue-400", bg: "bg-blue-500/5" };
  return { dot: "bg-amber-500", text: "text-amber-400", bg: "" };
}

function shortId(id: string) {
  if (!id) return "\u2014";
  return id.length > 16 ? id.slice(0, 8) + "\u2026" + id.slice(-4) : id;
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
        if (d.type === "log") setLines(p => { const n = [...p, { line: d.line, stream: d.stream || "stdout" }]; return n.length > 1000 ? n.slice(-1000) : n; });
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
    <div className="rounded-xl overflow-hidden border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950">
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
        className="overflow-y-auto px-4 py-3 max-h-[600px] min-h-[200px] font-mono text-xs leading-relaxed">
        {lines.length === 0 && !finalOutput && !errorMsg ? (
          <div className="text-neutral-400 dark:text-neutral-600 text-center py-12">{isLive ? "Waiting for agent output..." : "No output captured."}</div>
        ) : lines.map((e, i) => <div key={i}><span className={e.stream === "stderr" ? "text-red-500 dark:text-red-400" : "text-neutral-700 dark:text-neutral-300"}>{e.line}</span></div>)}
        {finalOutput && <div className="mt-3 pt-3 border-t border-neutral-300 dark:border-neutral-800 text-green-600 dark:text-green-400 whitespace-pre-wrap">{finalOutput}</div>}
        {errorMsg && <div className="mt-3 pt-3 border-t border-neutral-300 dark:border-neutral-800 text-red-500 dark:text-red-400 whitespace-pre-wrap">{errorMsg}</div>}
      </div>
    </div>
  );
}

/* ── ExecutionLogView ───────────────────────────────────── */

function ExecutionLogView({ file, lines, taskStatus }: { file: string; lines: string[]; taskStatus: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(true);

  // Parse JSONL lines into displayable entries
  const parsed = lines.map((raw) => {
    try {
      const evt = JSON.parse(raw);
      if (evt.type === "log") {
        return { text: evt.line || "", stream: evt.stream || "stdout", ts: evt.timestamp };
      }
      if (evt.type === "status") {
        return { text: `[Status: ${evt.status}]`, stream: "system" as const, ts: evt.timestamp };
      }
      if (evt.type === "done") {
        return { text: evt.output ? `[Done] ${evt.output.slice(0, 500)}` : "[Done]", stream: "system" as const, ts: evt.timestamp };
      }
      if (evt.type === "error") {
        return { text: `[Error] ${evt.error || "Unknown"}`, stream: "stderr" as const, ts: evt.timestamp };
      }
      return { text: raw, stream: "stdout" as const, ts: evt.timestamp };
    } catch {
      return { text: raw, stream: "stdout" as const, ts: "" };
    }
  });

  const label = file.replace("agent-stream-", "").replace("agent-stream", "main").replace(".log", "");

  return (
    <div className="rounded-xl overflow-hidden border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 mb-3">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 border-b border-neutral-300 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition">
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-medium ${taskStatus === "done" ? "text-green-600 dark:text-green-400" : taskStatus === "rejected" ? "text-red-500 dark:text-red-400" : "text-neutral-500"}`}>
            {taskStatus === "done" ? "Completed" : taskStatus === "rejected" ? "Failed" : taskStatus}
          </span>
          <span className="text-[10px] text-neutral-400 dark:text-neutral-600">{parsed.length} lines</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-neutral-400 dark:text-neutral-600 font-mono">{label}</span>
          <span className="text-neutral-400 text-[10px]">{expanded ? "\u25B2" : "\u25BC"}</span>
        </div>
      </button>
      {expanded && (
        <div ref={ref} className="overflow-y-auto px-4 py-3 max-h-[600px] min-h-[100px] font-mono text-xs leading-relaxed">
          {parsed.length === 0 ? (
            <div className="text-neutral-400 dark:text-neutral-600 text-center py-12">No log entries.</div>
          ) : parsed.map((e, i) => (
            <div key={i}>
              <span className={
                e.stream === "stderr" ? "text-red-500 dark:text-red-400" :
                e.stream === "system" ? "text-blue-500 dark:text-blue-400" :
                "text-neutral-700 dark:text-neutral-300"
              }>{e.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── WorkspaceFileBrowser ──────────────────────────────── */

interface WsFile { path: string; size: number; isDir: boolean }

function WorkspaceFileBrowser({ taskId }: { taskId: string }) {
  const [files, setFiles] = useState<WsFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/scheduler/tasks/${encodeURIComponent(taskId)}/files`);
        if (!res.ok) { setError("Workspace not found"); setLoading(false); return; }
        const d = await res.json();
        setFiles((d.files || []).filter((f: WsFile) => !f.isDir));
      } catch { setError("Failed to load files"); }
      setLoading(false);
    })();
  }, [taskId]);

  const loadFile = async (path: string) => {
    if (selectedFile === path) { setSelectedFile(null); setFileContent(null); return; }
    setSelectedFile(path);
    setFileContent(null);
    setLoadingFile(true);
    try {
      const res = await fetch(`/api/scheduler/tasks/${encodeURIComponent(taskId)}/files/${path}`);
      if (res.ok) { const d = await res.json(); setFileContent(d.content || ""); }
      else setFileContent("[Error loading file]");
    } catch { setFileContent("[Error loading file]"); }
    setLoadingFile(false);
  };

  if (loading) return <div className="text-xs text-neutral-500 py-4 text-center">Loading workspace files...</div>;
  if (error) return <div className="text-xs text-neutral-500 py-4 text-center">{error}</div>;
  if (files.length === 0) return <div className="text-xs text-neutral-500 py-4 text-center">No files in workspace.</div>;

  // Group files by directory
  const dirs = new Map<string, WsFile[]>();
  for (const f of files) {
    const parts = f.path.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push(f);
  }

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  function fileIcon(path: string): string {
    if (path.endsWith(".md")) return "\ud83d\udcc4";
    if (path.endsWith(".ts") || path.endsWith(".js")) return "\ud83d\udcdc";
    if (path.endsWith(".json")) return "\ud83d\udccb";
    if (path.endsWith(".yaml") || path.endsWith(".yml")) return "\u2699\ufe0f";
    if (path.endsWith(".sh")) return "\ud83d\udcbb";
    if (path.endsWith(".service")) return "\u2699\ufe0f";
    if (path.endsWith(".patch")) return "\ud83e\ude79";
    return "\ud83d\udcc4";
  }

  return (
    <div className="space-y-1">
      {[...dirs.entries()].map(([dir, dirFiles]) => (
        <div key={dir}>
          <div className="text-[10px] text-neutral-500 uppercase tracking-wider px-2 py-1 font-medium">{dir === "." ? "root" : dir}/</div>
          {dirFiles.map(f => {
            const name = f.path.split("/").pop() || f.path;
            const isSelected = selectedFile === f.path;
            return (
              <div key={f.path}>
                <button onClick={() => loadFile(f.path)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-neutral-200/50 dark:hover:bg-neutral-800/30 transition text-left rounded ${isSelected ? "bg-neutral-200/80 dark:bg-neutral-800/50" : ""}`}>
                  <span className="text-[11px]">{fileIcon(f.path)}</span>
                  <span className="text-neutral-700 dark:text-neutral-300 font-mono flex-1 truncate">{name}</span>
                  <span className="text-neutral-400 text-[10px] font-mono">{fmtSize(f.size)}</span>
                </button>
                {isSelected && (
                  <div className="mx-3 mb-2 rounded-lg overflow-hidden border border-neutral-300 dark:border-neutral-700">
                    {loadingFile ? (
                      <div className="px-4 py-8 text-xs text-neutral-500 text-center">Loading...</div>
                    ) : (
                      <pre className="text-[11px] text-neutral-600 dark:text-neutral-400 font-mono whitespace-pre-wrap p-3 max-h-80 overflow-y-auto bg-neutral-50 dark:bg-neutral-950 leading-relaxed">{fileContent}</pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ── ConversationThread (Phase 18.3) ──────────────────── */

function ConversationThread({ taskId }: { taskId: string }) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  const fetchThread = useCallback(async () => {
    try {
      const res = await fetch(`/api/scheduler/tasks/${encodeURIComponent(taskId)}/thread`);
      if (res.ok) {
        const d = await res.json();
        setMessages(d.thread || []);
      }
    } catch {}
    setLoading(false);
  }, [taskId]);

  useEffect(() => { fetchThread(); }, [fetchThread]);

  // Auto-refresh thread every 5 seconds
  useEffect(() => {
    const i = setInterval(fetchThread, 5000);
    return () => clearInterval(i);
  }, [fetchThread]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (autoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/scheduler/tasks/${encodeURIComponent(taskId)}/thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: trimmed, role: "user" }),
      });
      if (res.ok) {
        setInput("");
        await fetchThread();
      }
    } catch {}
    setSending(false);
  };

  const roleBadge = (role: string) => {
    if (role === "user") return "bg-blue-500/20 text-blue-600 dark:text-blue-400 border-blue-500/30";
    if (role === "agent") return "bg-purple-500/20 text-purple-600 dark:text-purple-400 border-purple-500/30";
    return "bg-neutral-500/20 text-neutral-600 dark:text-neutral-400 border-neutral-500/30";
  };

  if (loading) return <div className="text-xs text-neutral-500 py-4 text-center">Loading thread...</div>;

  return (
    <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Conversation Thread{messages.length > 0 ? ` (${messages.length})` : ""}</h2>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={() => {
          if (scrollRef.current) {
            const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
            autoScroll.current = scrollHeight - scrollTop - clientHeight < 40;
          }
        }}
        className="overflow-y-auto max-h-[400px] min-h-[100px] divide-y divide-neutral-200 dark:divide-neutral-800"
      >
        {messages.length === 0 ? (
          <div className="text-xs text-neutral-500 text-center py-8">No messages yet. Start the conversation below.</div>
        ) : messages.map((msg) => (
          <div key={msg.id} className="px-4 py-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${roleBadge(msg.role)}`}>
                {msg.role}
              </span>
              <span className="text-[10px] text-neutral-500 font-mono">{shortId(msg.from)}</span>
              <span className="text-[10px] text-neutral-400">{fmtDate(msg.createdAt)}</span>
              <span className="text-[10px] text-neutral-400">({relTime(msg.createdAt)})</span>
            </div>
            <p className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap leading-relaxed">{msg.content}</p>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-neutral-300 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Type a message..."
            maxLength={5000}
            className="flex-1 px-3 py-2 text-sm rounded-lg border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {sending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────── */

export default function TaskDetailPage() {
  const params = useParams();
  const taskId = params.id as string;

  const [task, setTask] = useState<TaskData | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerInfo | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [childTasks, setChildTasks] = useState<TaskData[]>([]);
  const [reflection, setReflection] = useState<{ slowedBy: string; missingContext: string; hierarchySuggestion: string; infraIssues: string; confidence: string } | null>(null);
  const [executionLogs, setExecutionLogs] = useState<{ file: string; lines: string[] }[] | null>(null);

  const fetchTask = useCallback(async () => {
    try {
      const res = await fetch(`/api/scheduler/tasks/${encodeURIComponent(taskId)}`);
      if (!res.ok) { setError(res.status === 404 ? "Task not found" : "Failed to load task"); setLoading(false); return; }
      const d = await res.json();
      setTask(d.task || null);
      setScheduler(d.scheduler || null);
      setOutput(d.output || null);
      setTimeline(d.timeline || d.task?.timeline || []);
      setError(null);

      // Fetch reflection and execution logs for completed/failed tasks
      if (d.task?.status === "done" || d.task?.status === "rejected") {
        try {
          const outcomeRes = await fetch(`/api/scheduler/outcomes/${encodeURIComponent(taskId)}`);
          if (outcomeRes.ok) {
            const outcomeData = await outcomeRes.json();
            if (outcomeData.outcome?.reflection) {
              setReflection(outcomeData.outcome.reflection);
            }
          }
        } catch {}

        // Fetch persisted execution logs
        try {
          const logsRes = await fetch(`/api/scheduler/tasks/${encodeURIComponent(taskId)}/logs`);
          if (logsRes.ok) {
            const logsData = await logsRes.json();
            if (logsData.logs?.length) {
              setExecutionLogs(logsData.logs);
            }
          }
        } catch {}
      }

      // Fetch child tasks if any
      const children = d.task?.childTasks;
      if (children?.length) {
        const childResults = await Promise.all(
          children.map((cid: string) => fetch(`/api/scheduler/tasks/${encodeURIComponent(cid)}`).then(r => r.ok ? r.json() : null).catch(() => null))
        );
        setChildTasks(childResults.filter(Boolean).map((r: any) => r.task).filter(Boolean));
      }
    } catch { setError("Cannot connect to node"); }
    setLoading(false);
  }, [taskId]);

  useEffect(() => { fetchTask(); }, [fetchTask]);

  // Auto-refresh for running tasks
  useEffect(() => {
    if (!task || (task.status !== "in_progress" && task.schedulerLifecycle !== "running")) return;
    const i = setInterval(fetchTask, 5000);
    return () => clearInterval(i);
  }, [task, fetchTask]);

  const isRunning = task?.status === "in_progress" || task?.schedulerLifecycle === "running";

  // Compute duration from timeline
  let duration: string | null = null;
  if (timeline.length >= 2) {
    const first = timeline[0];
    const last = timeline[timeline.length - 1];
    if (last.event === "completed" || last.event === "failed" || last.event === "parent_completed") {
      const s = (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / 1000;
      duration = s < 60 ? `${s.toFixed(1)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-neutral-950">
        <NavBar />
        <main className="max-w-4xl mx-auto p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-neutral-200 dark:bg-neutral-800 rounded w-2/3" />
            <div className="h-4 bg-neutral-200 dark:bg-neutral-800 rounded w-1/3" />
            <div className="h-64 bg-neutral-200 dark:bg-neutral-800 rounded" />
          </div>
        </main>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="min-h-screen bg-white dark:bg-neutral-950">
        <NavBar />
        <main className="max-w-4xl mx-auto p-6">
          <div className="text-center py-20">
            <p className="text-lg text-red-500 dark:text-red-400 mb-4">{error || "Task not found"}</p>
            <a href="/explore/tasks" className="text-amber-500 hover:text-amber-400 text-sm underline">Back to Tasks</a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <a href="/explore/tasks" className="hover:text-amber-500 transition">Tasks</a>
          <span>/</span>
          {task.parentTask && (
            <>
              <a href={`/scheduler/task/${task.parentTask}`} className="hover:text-amber-500 transition">{shortId(task.parentTask)}</a>
              <span>/</span>
            </>
          )}
          <span className="text-neutral-700 dark:text-neutral-300 font-mono">{shortId(task.id)}</span>
        </div>

        {/* Header */}
        <div className="space-y-3">
          <div className="flex items-start gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100 flex-1">{task.title}</h1>
            {isRunning && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/15 border border-blue-500/25">
                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="text-xs font-medium text-blue-500 dark:text-blue-400">Running</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusCls(task.status)}`}>{task.status}</span>
            <span className={`px-2 py-0.5 rounded text-xs font-medium border ${prioCls(task.priority)}`}>{task.priority}</span>
            {task.roleMetadata && (
              <span className={`px-2 py-0.5 rounded text-xs font-medium border ${task.roleMetadata.verificationNeeded ? "bg-purple-500/20 text-purple-400 border-purple-500/30" : "bg-cyan-500/20 text-cyan-400 border-cyan-500/30"}`}>
                {task.roleMetadata.roleId}{task.roleMetadata.verificationNeeded ? " (verifier)" : ""}
              </span>
            )}
            {duration && (
              <span className="text-xs text-neutral-500 font-mono">{duration}</span>
            )}
            {task.createdAt && (
              <span className="text-xs text-neutral-500">Created {fmtDate(task.createdAt)}</span>
            )}
          </div>
        </div>

        {/* Info grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3">
            <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Task ID</p>
            <p className="text-xs font-mono text-neutral-700 dark:text-neutral-300 break-all">{task.id}</p>
          </div>
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3">
            <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Created By</p>
            <p className="text-xs text-neutral-700 dark:text-neutral-300">{task.createdBy || "\u2014"}</p>
          </div>
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3">
            <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Lifecycle</p>
            <p className="text-xs text-neutral-700 dark:text-neutral-300">{scheduler?.lifecycle || task.schedulerLifecycle || "\u2014"}</p>
          </div>
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3">
            <p className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Profile</p>
            <p className="text-xs font-mono text-neutral-700 dark:text-neutral-300">{scheduler?.profile?.id ? shortId(scheduler.profile.id) : "\u2014"}</p>
          </div>
        </div>

        {/* Governance link */}
        {task.proposalId && (
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 flex items-center gap-3">
            <span className="text-amber-500 text-sm font-semibold">Governance</span>
            <span className="text-xs text-neutral-600 dark:text-neutral-400">
              Created from approved proposal
            </span>
            <a href="/explore/governance" className="text-xs text-amber-500 hover:text-amber-400 font-mono underline">
              {task.proposalId.slice(0, 12)}...
            </a>
          </div>
        )}

        {/* Description */}
        {task.description && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-2">Description</h2>
            <div className="text-sm text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap leading-relaxed">{task.description}</div>
          </div>
        )}

        {/* Role metadata */}
        {task.roleMetadata && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-2">Role Assignment</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
              <div><span className="text-neutral-500">Role:</span> <span className="text-cyan-500 font-medium ml-1">{task.roleMetadata.roleId}</span></div>
              <div><span className="text-neutral-500">Project:</span> <span className="text-neutral-700 dark:text-neutral-300 ml-1 font-mono">{shortId(task.roleMetadata.projectId)}</span></div>
              <div><span className="text-neutral-500">Verification:</span> <span className={`ml-1 ${task.roleMetadata.verificationNeeded ? "text-purple-400" : "text-neutral-400"}`}>{task.roleMetadata.verificationNeeded ? "Required" : "Not required"}</span></div>
            </div>
            {task.roleMetadata.responsibility && (
              <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">{task.roleMetadata.responsibility}</p>
            )}
          </div>
        )}

        {/* Cost tracking */}
        {task.cost && (task.cost.costUsd || task.cost.inputTokens || task.cost.durationMs) && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-2">Cost</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              {task.cost.costUsd != null && (
                <div>
                  <span className="text-neutral-500">USD:</span>
                  <span className="text-green-500 font-semibold ml-1">${task.cost.costUsd < 0.01 ? task.cost.costUsd.toFixed(6) : task.cost.costUsd.toFixed(4)}</span>
                </div>
              )}
              {task.cost.inputTokens != null && (
                <div>
                  <span className="text-neutral-500">Input:</span>
                  <span className="text-neutral-700 dark:text-neutral-300 ml-1">{task.cost.inputTokens.toLocaleString()} tok</span>
                </div>
              )}
              {task.cost.outputTokens != null && (
                <div>
                  <span className="text-neutral-500">Output:</span>
                  <span className="text-neutral-700 dark:text-neutral-300 ml-1">{task.cost.outputTokens.toLocaleString()} tok</span>
                </div>
              )}
              {task.cost.durationMs != null && (
                <div>
                  <span className="text-neutral-500">Duration:</span>
                  <span className="text-neutral-700 dark:text-neutral-300 ml-1">{(task.cost.durationMs / 1000).toFixed(1)}s</span>
                </div>
              )}
              {task.cost.model && (
                <div>
                  <span className="text-neutral-500">Model:</span>
                  <span className="text-purple-500 ml-1 font-mono">{task.cost.model}</span>
                </div>
              )}
              {task.cost.tier && (
                <div>
                  <span className="text-neutral-500">Tier:</span>
                  <span className="text-blue-500 ml-1">{task.cost.tier}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Files / Dependencies */}
        {((task.files?.length ?? 0) > 0 || (task.dependencies?.length ?? 0) > 0) && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4 space-y-3">
            {(task.files?.length ?? 0) > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-neutral-500 mb-1.5">Files ({task.files!.length})</h3>
                <div className="flex flex-wrap gap-1.5">
                  {task.files!.map((f, i) => <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 font-mono">{f}</span>)}
                </div>
              </div>
            )}
            {(task.dependencies?.length ?? 0) > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-neutral-500 mb-1.5">Dependencies ({task.dependencies!.length})</h3>
                <div className="flex flex-wrap gap-1.5">
                  {task.dependencies!.map((d, i) => <a key={i} href={`/scheduler/task/${d}`} className="text-[10px] px-2 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800 text-amber-500 hover:text-amber-400 font-mono">{shortId(d)}</a>)}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Child tasks */}
        {(task.childTasks?.length ?? 0) > 0 && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Subtasks ({task.childTasks!.length})</h2>
            </div>
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {childTasks.length > 0 ? childTasks.map(child => (
                <a key={child.id} href={`/scheduler/task/${child.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/30 transition text-xs">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusCls(child.status)}`}>{child.status}</span>
                  <span className="text-neutral-700 dark:text-neutral-300 flex-1 truncate">{child.title}</span>
                  {child.roleMetadata && (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${child.roleMetadata.verificationNeeded ? "bg-purple-500/20 text-purple-400 border-purple-500/30" : "bg-cyan-500/20 text-cyan-400 border-cyan-500/30"}`}>
                      {child.roleMetadata.roleId}
                    </span>
                  )}
                  <span className="text-neutral-500 font-mono">{shortId(child.id)}</span>
                </a>
              )) : task.childTasks!.map(cid => (
                <a key={cid} href={`/scheduler/task/${cid}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-200/50 dark:hover:bg-neutral-800/30 transition text-xs">
                  <span className="text-neutral-500 font-mono">{shortId(cid)}</span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Timeline */}
        {timeline.length > 0 && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-4">Timeline ({timeline.length} events)</h2>
            <div className="relative">
              {timeline.map((evt, i) => {
                const c = tlColor(evt.event);
                const isLast = i === timeline.length - 1;
                const pulse = isLast && isRunning && evt.event !== "completed" && evt.event !== "failed";
                return (
                  <div key={i} className={`flex gap-4 relative ${c.bg}`}>
                    <div className="flex flex-col items-center flex-shrink-0 w-5">
                      <div className={`w-3 h-3 rounded-full mt-1.5 flex-shrink-0 ${pulse ? "bg-amber-500 animate-pulse" : c.dot}`} />
                      {!isLast && <div className="w-0.5 flex-1 min-h-[20px] bg-neutral-300 dark:bg-neutral-800 mt-0.5" />}
                    </div>
                    <div className={isLast ? "pb-0" : "pb-4"}>
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className={`text-sm font-semibold ${c.text}`}>{evt.event.replace(/_/g, " ")}</span>
                        <span className="text-neutral-500 text-[11px] font-mono">{fmtDate(evt.timestamp)}</span>
                        <span className="text-neutral-500 text-[10px]">({relTime(evt.timestamp)})</span>
                      </div>
                      <p className="text-neutral-600 dark:text-neutral-400 text-sm mt-1">{evt.detail}</p>
                      {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {Object.entries(evt.metadata).map(([k, v]) => v != null && (
                            <span key={k} className="text-[10px] px-2 py-0.5 rounded bg-neutral-200 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-500 font-mono">
                              {k}: {Array.isArray(v) ? v.length + " items" : typeof v === "object" ? JSON.stringify(v) : String(v).slice(0, 80)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {duration && (
              <div className={`mt-4 pt-3 border-t border-neutral-300 dark:border-neutral-800 text-sm font-semibold ${timeline[timeline.length - 1]?.event === "failed" ? "text-red-500" : "text-green-500 dark:text-green-400"}`}>
                {timeline[timeline.length - 1]?.event === "failed" ? `Failed after ${duration}` : `Completed in ${duration}`}
              </div>
            )}
          </div>
        )}

        {/* Conversation Thread (Phase 18.3) */}
        <ConversationThread taskId={task.id} />

        {/* Live stream (for running tasks) or historical output (for completed tasks) */}
        {isRunning ? (
          <div>
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-3">Live Agent Output</h2>
            <TaskLogStream taskId={task.id} />
          </div>
        ) : output && (
          <div>
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-3">Agent Output</h2>
            <div className="rounded-xl overflow-hidden border border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-950">
              <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-300 dark:border-neutral-800 bg-white dark:bg-neutral-900">
                <span className={`text-[11px] font-medium ${task.status === "done" ? "text-green-600 dark:text-green-400" : task.status === "rejected" || task.status === "failed" ? "text-red-500 dark:text-red-400" : "text-neutral-500"}`}>
                  {task.status === "done" ? "Completed" : task.status === "rejected" ? "Failed" : task.status}
                </span>
                <span className="text-[10px] text-neutral-400 dark:text-neutral-600 font-mono">Agent Output</span>
              </div>
              <pre className="overflow-y-auto px-4 py-3 max-h-[600px] min-h-[100px] font-mono text-xs leading-relaxed text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap">{output}</pre>
            </div>
          </div>
        )}

        {/* Execution Logs (for completed tasks with persisted logs) */}
        {!isRunning && executionLogs && executionLogs.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-3">Execution Logs</h2>
            {executionLogs.map((logFile) => (
              <ExecutionLogView key={logFile.file} file={logFile.file} lines={logFile.lines} taskStatus={task.status} />
            ))}
          </div>
        )}

        {/* Result */}
        {task.result && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4 space-y-3">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Result</h2>
            <div className="flex items-center gap-3 flex-wrap text-xs">
              {task.result.commitHash && (
                <span className="px-2 py-0.5 rounded bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 font-mono">commit: {task.result.commitHash}</span>
              )}
              {task.result.buildPassed != null && (
                <span className={`px-2 py-0.5 rounded font-medium ${task.result.buildPassed ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  build: {task.result.buildPassed ? "passed" : "failed"}
                </span>
              )}
              {task.result.testsPassed != null && (
                <span className={`px-2 py-0.5 rounded font-medium ${task.result.testsPassed ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                  tests: {task.result.testsPassed ? "passed" : "failed"}
                </span>
              )}
            </div>
            {task.result.note && (
              <pre className="text-xs text-neutral-600 dark:text-neutral-400 font-mono whitespace-pre-wrap max-h-96 overflow-y-auto p-3 rounded-lg bg-neutral-200/50 dark:bg-neutral-800/50 leading-relaxed">{task.result.note}</pre>
            )}
          </div>
        )}

        {/* Agent Reflection (Phase 15.1) */}
        {reflection && (
          <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-xl p-4 space-y-3">
            <h2 className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">Agent Reflection</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="space-y-1">
                <p className="text-neutral-500 font-medium">Slowed By</p>
                <p className="text-neutral-700 dark:text-neutral-300">{reflection.slowedBy}</p>
              </div>
              <div className="space-y-1">
                <p className="text-neutral-500 font-medium">Missing Context</p>
                <p className="text-neutral-700 dark:text-neutral-300">{reflection.missingContext}</p>
              </div>
              <div className="space-y-1">
                <p className="text-neutral-500 font-medium">Hierarchy Suggestion</p>
                <p className="text-neutral-700 dark:text-neutral-300">{reflection.hierarchySuggestion}</p>
              </div>
              <div className="space-y-1">
                <p className="text-neutral-500 font-medium">Infrastructure Issues</p>
                <p className="text-neutral-700 dark:text-neutral-300">{reflection.infraIssues}</p>
              </div>
            </div>
            <div className="pt-2 border-t border-indigo-500/10">
              <span className="text-neutral-500 text-xs font-medium">Confidence: </span>
              <span className={`text-xs font-medium ${reflection.confidence.startsWith("high") ? "text-green-500" : reflection.confidence.startsWith("low") ? "text-red-400" : "text-amber-400"}`}>
                {reflection.confidence}
              </span>
            </div>
          </div>
        )}

        {/* Output (only shown if not already displayed in terminal view above) */}
        {output && !isRunning && task.result?.note && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-3">Raw Output</h2>
            <pre className="text-xs text-neutral-600 dark:text-neutral-400 font-mono whitespace-pre-wrap max-h-96 overflow-y-auto p-3 rounded-lg bg-neutral-200/50 dark:bg-neutral-800/50 leading-relaxed">{output}</pre>
          </div>
        )}

        {/* Failure reason */}
        {task.failureReason && (
          <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-red-500 dark:text-red-400 mb-2">Failure Reason</h2>
            <pre className="text-xs text-red-400 font-mono whitespace-pre-wrap">{task.failureReason}</pre>
          </div>
        )}

        {/* Workspace + File Browser */}
        {scheduler?.workspace && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Workspace Files</h2>
              <div className="flex items-center gap-3 mt-1 text-xs text-neutral-500">
                <span>{scheduler.workspace.status || "active"}</span>
                <code className="font-mono text-[10px]">{scheduler.workspace.dir || scheduler.workspace.path}</code>
              </div>
            </div>
            <WorkspaceFileBrowser taskId={task.id} />
          </div>
        )}

        {/* Profile */}
        {scheduler?.profile && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-2">Agent Profile</h2>
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-3">
                <span className="text-neutral-500">ID:</span> <span className="font-mono text-neutral-700 dark:text-neutral-300">{scheduler.profile.id}</span>
                {scheduler.profile.tier && <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${scheduler.profile.tier === "long-session" ? "bg-purple-500/20 text-purple-400" : scheduler.profile.tier === "short-session" ? "bg-blue-500/20 text-blue-400" : "bg-neutral-500/20 text-neutral-400"}`}>{scheduler.profile.tier}</span>}
                {scheduler.profile.score != null && <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${scheduler.profile.score > 0 ? "bg-green-500/20 text-green-400" : scheduler.profile.score < 0 ? "bg-red-500/20 text-red-400" : "bg-neutral-500/20 text-neutral-400"}`}>score: {scheduler.profile.score}</span>}
              </div>
              {scheduler.profile.role && (
                <pre className="text-neutral-600 dark:text-neutral-400 font-mono whitespace-pre-wrap text-[11px] p-2 rounded-lg bg-neutral-200/50 dark:bg-neutral-800/50 max-h-48 overflow-y-auto">{scheduler.profile.role}</pre>
              )}
            </div>
          </div>
        )}

        {/* Back link */}
        <div className="pt-4 border-t border-neutral-200 dark:border-neutral-800">
          <a href="/explore/tasks" className="text-xs text-amber-500 hover:text-amber-400 transition">&larr; Back to Tasks</a>
        </div>
      </main>
    </div>
  );
}
