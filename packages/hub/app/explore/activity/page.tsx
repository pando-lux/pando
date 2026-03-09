"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

interface ActivityStats {
  total: number;
  byAction: Record<string, number>;
  byAgent: Record<string, number>;
}

interface ActivityEvent {
  id: string;
  agentId: string;
  action: string;
  summary: string;
  timestamp: number;
}

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

function shortId(id: string) {
  if (!id) return "\u2014";
  return id.length > 16 ? id.slice(0, 8) + "\u2026" + id.slice(-4) : id;
}

export default function ActivityPage() {
  const [stats, setStats] = useState<ActivityStats | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [timeWin, setTimeWin] = useState("24h");

  const fetchStats = useCallback(async (w: string) => {
    try {
      const r = await fetch(`/api/activity/stats?window=${w}`);
      if (r.ok) setStats(await r.json());
    } catch {}
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      const r = await fetch("/api/activity/stream?limit=50");
      if (r.ok) {
        const d = await r.json();
        setEvents(d.events || []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchStats(timeWin);
    fetchEvents();
    const i = setInterval(fetchEvents, 10000);
    return () => clearInterval(i);
  }, [timeWin, fetchStats, fetchEvents]);

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-2 text-xs text-neutral-500 animate-page-fade-in">
          <a href="/explore" className="hover:text-amber-500 transition">Explore</a>
          <span>/</span>
          <span className="text-neutral-700 dark:text-neutral-300">Activity</span>
        </div>

        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100 animate-page-fade-in">Activity</h1>

        {/* Stats */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4 animate-page-fade-in-delay-1">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Activity Stats</h2>
            <div className="flex gap-1">
              {["1h", "6h", "24h", "7d"].map(w => (
                <button
                  key={w}
                  onClick={() => { setTimeWin(w); fetchStats(w); }}
                  className={`px-2.5 py-1 text-xs rounded-lg transition ${timeWin === w ? "bg-amber-500/15 text-amber-500 dark:text-amber-400 border border-amber-500/25" : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 border border-transparent"}`}
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
          {stats ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-neutral-200/50 dark:bg-neutral-800/50 border border-neutral-300 dark:border-neutral-700">
                <p className="text-xs text-neutral-500 mb-1">Total Events</p>
                <p className="text-lg font-mono font-bold text-neutral-800 dark:text-neutral-200">{stats.total ?? 0}</p>
              </div>
              <div className="p-3 rounded-lg bg-neutral-200/50 dark:bg-neutral-800/50 border border-neutral-300 dark:border-neutral-700">
                <p className="text-xs text-neutral-500 mb-1">By Action</p>
                {stats.byAction && Object.entries(stats.byAction).length > 0
                  ? Object.entries(stats.byAction).slice(0, 5).map(([a, c]) => (
                    <div key={a} className="flex justify-between text-xs">
                      <span className="text-neutral-600 dark:text-neutral-400">{a}</span>
                      <span className="text-neutral-800 dark:text-neutral-200 font-mono">{c as number}</span>
                    </div>
                  ))
                  : <span className="text-xs text-neutral-500">No data</span>}
              </div>
              <div className="p-3 rounded-lg bg-neutral-200/50 dark:bg-neutral-800/50 border border-neutral-300 dark:border-neutral-700">
                <p className="text-xs text-neutral-500 mb-1">By Agent</p>
                {stats.byAgent && Object.entries(stats.byAgent).length > 0
                  ? Object.entries(stats.byAgent).slice(0, 5).map(([a, c]) => (
                    <div key={a} className="flex justify-between text-xs">
                      <span className="text-neutral-600 dark:text-neutral-400 truncate mr-2">{shortId(a)}</span>
                      <span className="text-neutral-800 dark:text-neutral-200 font-mono">{c as number}</span>
                    </div>
                  ))
                  : <span className="text-xs text-neutral-500">No data</span>}
              </div>
            </div>
          ) : (
            <div className="text-xs text-neutral-500 text-center py-4">Loading stats...</div>
          )}
        </div>

        {/* Event Feed */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden animate-page-fade-in-delay-2">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Event Feed</h2>
          </div>
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
      </main>
    </div>
  );
}
