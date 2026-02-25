"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import NavBar from "@/components/NavBar";
import { useAuth } from "@/lib/auth-context";

interface Status {
  connected: boolean;
  peers: number;
  identity: string;
  balance: number;
  totalSupply: number;
  totalAccounts: number;
}

interface SchedulerStatus {
  running: boolean;
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed: number;
}

interface ActivityEvent {
  id: string;
  action: string;
  summary: string;
  timestamp: string;
  agentId?: string;
}


export default function HomePage() {
  const router = useRouter();
  const { user, token } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [inputText, setInputText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [openingChat, setOpeningChat] = useState(false);
  const [chatResult, setChatResult] = useState<{
    status?: string;
    reply?: string;
    threadId?: string;
    tier?: string;
    error?: string;
  } | null>(null);

  const fetchData = useCallback(async () => {
    const [s, sc, a] = await Promise.all([
      fetch("/api/status").then(r => r.json()).catch(() => null),
      fetch("/api/scheduler/status").then(r => r.json()).catch(() => ({ running: false, totalProcessed: 0, totalSucceeded: 0, totalFailed: 0 })),
      fetch("/api/activity/stream?limit=5").then(r => r.json()).catch(() => ({ events: [] })),
    ]);
    if (s) setStatus(s);
    if (sc) setScheduler(sc);
    if (a?.events) setActivity(a.events);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  async function handleInputSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    if (!inputText.trim()) return;
    setSubmitting(true);
    setChatResult(null);
    try {
      const msgHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (token) msgHeaders["X-User-Token"] = token;
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: msgHeaders,
        body: JSON.stringify({ message: inputText.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setChatResult({
          status: data.status,
          reply: data.reply,
          threadId: data.threadId,
          tier: data.tier,
        });
      } else {
        setChatResult({ error: data.error || "Failed to send message" });
      }
    } catch {
      setChatResult({ error: "Network error" });
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    setChatResult(null);
  }

  async function openInChat(message?: string) {
    const text = (message || inputText).trim();
    if (!text || openingChat) return;
    setOpeningChat(true);
    try {
      // Create a thread with the message as title
      const threadHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (token) threadHeaders["X-User-Token"] = token;
      const res = await fetch("/api/chat/threads", {
        method: "POST",
        headers: threadHeaders,
        body: JSON.stringify({ title: text.slice(0, 50) }),
      });
      const thread = await res.json();
      if (thread?.id) {
        // Send the first message to the thread
        await fetch(`/api/chat/threads/${encodeURIComponent(thread.id)}/message`, {
          method: "POST",
          headers: threadHeaders,
          body: JSON.stringify({ message: text }),
        });
        // Navigate to chat — the thread will be visible in the sidebar
        router.push(`/chat?thread=${encodeURIComponent(thread.id)}`);
      }
    } catch {
      // Fallback: just navigate to chat page
      router.push("/chat");
    } finally {
      setOpeningChat(false);
    }
  }

  function timeAgo(ts: string) {
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  }

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Hero */}
        <div className="space-y-2 animate-page-fade-in">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-neutral-900 dark:text-neutral-100">Pando</h1>
            {status && (
              <span className="relative group flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400 cursor-default">
                <span className={`w-2 h-2 rounded-full ${status.connected ? "bg-green-500" : "bg-red-500"}`} />
                {status.connected ? `${status.peers} peer${status.peers !== 1 ? "s" : ""}` : "offline"}
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-2 px-3 py-1.5 rounded-lg bg-neutral-800 dark:bg-neutral-700 text-white text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-150 shadow-lg z-50"
                >
                  {status.connected
                    ? `Connected to ${status.peers} peer${status.peers !== 1 ? "s" : ""} on the network`
                    : "Not connected to the Pando network"}
                </span>
              </span>
            )}
          </div>
          <p className="text-neutral-500 dark:text-neutral-400">The Open Network — AI-managed, fully transparent</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 animate-page-fade-in-delay-1">
          <StatCard label="Peers" value={status?.peers ?? "—"} loading={!status} />
          <StatCard label="Lux Balance" value={
            (user?.balance ?? status?.balance)
              ? (user?.balance || status?.balance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })
              : "0"
          } loading={!status && !user} />
          <StatCard label="Tasks Processed" value={scheduler?.totalProcessed ?? 0} loading={!scheduler} />
          <StatCard label="Total Supply" value={status ? `${status.totalSupply.toLocaleString(undefined, { maximumFractionDigits: 2 })} Lux` : "—"} loading={!status} />
        </div>

        {/* Unified Input Gateway */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4 space-y-4 animate-page-fade-in-delay-2">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">What would you like to do?</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Ask a question, create a task, check your balance, manage governance — the Smart Router figures out the rest.</p>
          <form onSubmit={handleInputSubmit} className="space-y-3">
            <textarea
              placeholder="e.g. &quot;What is quantum computing?&quot; or &quot;Build a login page&quot;"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              rows={3}
              className="w-full bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 resize-none"
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (inputText.trim() && !submitting) {
                    handleInputSubmit(e);
                  }
                }
              }}
            />
            <div className="flex items-center justify-between">
              <div className="flex gap-1.5 flex-wrap">
                {(["search", "task", "governance", "ledger", "network"] as const).map(cat => (
                  <CategoryBadge key={cat} category={cat} />
                ))}
              </div>
              <button
                type="submit"
                disabled={submitting || !inputText.trim()}
                className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-4 py-2 text-sm transition shrink-0"
              >
                {submitting ? "Routing..." : "Send"}
              </button>
            </div>
          </form>
          {chatResult && !chatResult.error && (
            <div className="bg-neutral-200/60 dark:bg-neutral-800/60 border border-neutral-300 dark:border-neutral-700 rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${chatResult.status === "ok" ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300" : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"}`}>
                  {chatResult.status === "ok" ? "Replied" : "Queued"}
                </span>
                {chatResult.tier && (
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    tier: {chatResult.tier}
                  </span>
                )}
              </div>
              {chatResult.reply && (
                <p className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap">{chatResult.reply}</p>
              )}
              {!chatResult.reply && chatResult.status === "queued" && (
                <p className="text-sm text-neutral-500 dark:text-neutral-400">Message queued for processing by the manager agent.</p>
              )}
              <div className="flex items-center gap-2 pt-1">
                {chatResult.threadId && (
                  <a
                    href={`/chat?thread=${encodeURIComponent(chatResult.threadId)}`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-amber-600 dark:text-amber-400 hover:text-amber-500 dark:hover:text-amber-300 transition"
                  >
                    Open in Chat &rarr;
                  </a>
                )}
                {!chatResult.threadId && (
                  <button
                    onClick={() => openInChat()}
                    disabled={openingChat}
                    className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-4 py-1.5 text-sm transition flex items-center gap-2"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    {openingChat ? "Opening..." : "Continue in Chat"}
                  </button>
                )}
                <button
                  onClick={handleCancel}
                  className="bg-neutral-300 dark:bg-neutral-700 hover:bg-neutral-400 dark:hover:bg-neutral-600 text-neutral-800 dark:text-neutral-200 font-medium rounded-lg px-4 py-1.5 text-sm transition"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {chatResult?.error && <p className="text-sm text-red-400">{chatResult.error}</p>}
        </div>

        {/* Recent Activity */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4 space-y-3 animate-page-fade-in-delay-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Recent Activity</h2>
            <a href="/explore/tasks" className="text-xs text-amber-500 dark:text-amber-400 hover:text-amber-400 dark:hover:text-amber-300">View all &rarr;</a>
          </div>
          {activity.length === 0 ? (
            <p className="text-sm text-neutral-600 dark:text-neutral-500">No recent activity</p>
          ) : (
            <div className="space-y-2">
              {activity.map((evt, i) => (
                <div key={evt.id || i} className="flex items-start gap-3 text-sm">
                  <span className="text-neutral-600 dark:text-neutral-500 shrink-0 w-16 text-xs">{timeAgo(evt.timestamp)}</span>
                  <span className="text-amber-500/80 dark:text-amber-400/80 shrink-0 w-24 text-xs font-medium">{evt.action}</span>
                  <span className="text-neutral-700 dark:text-neutral-300 truncate">{evt.summary}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const CATEGORY_STYLES: Record<string, string> = {
  search: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  task: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  governance: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  ledger: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  network: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/40 dark:text-cyan-300",
  system: "bg-gray-100 text-gray-800 dark:bg-gray-700/40 dark:text-gray-300",
  unknown: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800/40 dark:text-neutral-400",
};

function CategoryBadge({ category }: { category: string }) {
  const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.unknown;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${style}`}>
      {category}
    </span>
  );
}


function StatCard({ label, value, loading }: { label: string; value: string | number; loading?: boolean }) {
  return (
    <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
      <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">{label}</p>
      {loading ? (
        <div className="h-7 w-20 rounded-md bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
      ) : (
        <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100 animate-stat-fade-in">{value}</p>
      )}
    </div>
  );
}
