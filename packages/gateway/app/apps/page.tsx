"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types ------------------------------------------------- */

interface App {
  id: string;
  name: string;
  description: string;
  deploymentUrl: string;
  deploymentStatus: string;
  deploymentType: string;
  hostType: "s3" | "ec2" | "gateway" | "other";
  visibility: string;
  createdAt: number;
  updatedAt: number;
  ownerId: string;
  deployPeerId?: string;
  /** set by live-check */
  liveStatus?: "ok" | "error" | "checking" | "unknown";
}

/* -- Helpers ----------------------------------------------- */

function relTime(ts: number): string {
  if (!ts) return "--";
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  if (d < 86400000 * 7) return `${Math.floor(d / 86400000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function shortName(name: string): string {
  if (!name) return "Untitled";
  // Trim AI-generated long names
  if (name.length > 50) return name.slice(0, 48) + "…";
  return name;
}

function hostLabel(hostType: string): string {
  switch (hostType) {
    case "s3": return "S3";
    case "ec2": return "EC2";
    case "gateway": return "Gateway";
    default: return "Hosted";
  }
}

function hostColor(hostType: string): string {
  switch (hostType) {
    case "s3": return "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20";
    case "ec2": return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20";
    case "gateway": return "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20";
    default: return "bg-neutral-500/10 text-neutral-600 dark:text-neutral-400 border-neutral-500/20";
  }
}

function statusDot(status: string | undefined): string {
  if (status === "ok") return "bg-emerald-500";
  if (status === "error") return "bg-red-500";
  if (status === "checking") return "bg-amber-400 animate-pulse";
  return "bg-neutral-400";
}

/* -- AppCard ----------------------------------------------- */

function AppCard({ app, onOpen }: { app: App; onOpen: (url: string) => void }) {
  return (
    <div className="group relative rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 flex flex-col gap-3 hover:border-amber-500/40 hover:shadow-md transition-all">
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate" title={app.name}>
            {shortName(app.name)}
          </h3>
          {app.description && (
            <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2">
              {app.description}
            </p>
          )}
        </div>
        {/* Live status dot */}
        <span
          className={`mt-0.5 flex-shrink-0 w-2 h-2 rounded-full ${statusDot(app.liveStatus)}`}
          title={app.liveStatus === "ok" ? "Live" : app.liveStatus === "error" ? "Unreachable" : "Status unknown"}
        />
      </div>

      {/* Tags row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium ${hostColor(app.hostType)}`}>
          {hostLabel(app.hostType)}
        </span>
        {app.deploymentStatus && app.deploymentStatus !== "none" && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
            {app.deploymentStatus}
          </span>
        )}
        <span className="ml-auto text-[10px] text-neutral-400">
          {relTime(app.updatedAt || app.createdAt)}
        </span>
      </div>

      {/* URL row */}
      <div className="mt-auto pt-1 border-t border-neutral-100 dark:border-neutral-800 flex items-center gap-2">
        <span className="flex-1 min-w-0 font-mono text-[10px] text-neutral-400 truncate" title={app.deploymentUrl}>
          {app.deploymentUrl}
        </span>
        <button
          onClick={() => onOpen(app.deploymentUrl)}
          className="flex-shrink-0 px-2.5 py-1 text-[11px] font-medium rounded-lg bg-amber-500 hover:bg-amber-400 text-white transition"
        >
          Open ↗
        </button>
      </div>
    </div>
  );
}

/* -- Main Page --------------------------------------------- */

export default function AppsPage() {
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hostFilter, setHostFilter] = useState<"all" | "s3" | "ec2" | "gateway">("all");
  const [checking, setChecking] = useState(false);

  /* Fetch apps from API */
  const fetchApps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/apps");
      const data = await res.json();
      const rawApps: App[] = (data.apps || []).map((a: App) => ({ ...a, liveStatus: "unknown" }));
      setApps(rawApps);
    } catch {
      setError("Could not reach node — check connection.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  /* Live-check deployed apps via HEAD request */
  const runLiveCheck = useCallback(async () => {
    if (apps.length === 0) return;
    setChecking(true);
    // Mark all as checking
    setApps(prev => prev.map(a => ({ ...a, liveStatus: "checking" })));

    const results = await Promise.allSettled(
      apps.map(async (app) => {
        try {
          // Use a short timeout; many apps may be on external S3 with CORS
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          const r = await fetch(app.deploymentUrl, { method: "HEAD", signal: controller.signal, mode: "no-cors" });
          clearTimeout(timer);
          // no-cors returns opaque response — if we get here, it's reachable
          return { id: app.id, status: r.type === "opaque" || r.ok ? "ok" : "error" };
        } catch {
          return { id: app.id, status: "error" };
        }
      })
    );

    setApps(prev => {
      const map = new Map(prev.map(a => [a.id, a]));
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          const appEntry = map.get(r.value.id);
          if (appEntry) map.set(r.value.id, { ...appEntry, liveStatus: r.value.status as App["liveStatus"] });
        } else {
          const app = prev[i];
          if (app) map.set(app.id, { ...app, liveStatus: "error" });
        }
      });
      return Array.from(map.values());
    });
    setChecking(false);
  }, [apps]);

  /* Filtered + searched apps */
  const filtered = apps.filter(app => {
    if (hostFilter !== "all" && app.hostType !== hostFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        app.name.toLowerCase().includes(q) ||
        (app.description || "").toLowerCase().includes(q) ||
        app.deploymentUrl.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const counts = {
    all: apps.length,
    s3: apps.filter(a => a.hostType === "s3").length,
    ec2: apps.filter(a => a.hostType === "ec2").length,
    gateway: apps.filter(a => a.hostType === "gateway").length,
  };

  function openApp(url: string) {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />

      <main className="max-w-5xl mx-auto px-4 py-8">
        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">App Directory</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Deployed apps built by AI agents on the Pando network.
            {!loading && ` ${apps.length} deployed.`}
          </p>
        </div>

        {/* Controls bar */}
        <div className="mb-5 flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="flex-1 relative">
            <span className="absolute inset-y-0 left-3 flex items-center text-neutral-400 pointer-events-none">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 111 11a6 6 0 0116 0z" />
              </svg>
            </span>
            <input
              type="text"
              placeholder="Search apps…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500/50 transition"
            />
          </div>

          {/* Host filter pills */}
          <div className="flex items-center gap-1.5">
            {(["all", "s3", "ec2", "gateway"] as const).map(h => (
              <button
                key={h}
                onClick={() => setHostFilter(h)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full border transition ${
                  hostFilter === h
                    ? "bg-amber-500 text-white border-amber-500"
                    : "border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                }`}
              >
                {h === "all" ? "All" : hostLabel(h)}
                <span className="ml-1 opacity-60">{counts[h]}</span>
              </button>
            ))}
          </div>

          {/* Live check button */}
          <button
            onClick={runLiveCheck}
            disabled={checking || loading || apps.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 transition"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${checking ? "bg-amber-400 animate-pulse" : "bg-neutral-400"}`} />
            {checking ? "Checking…" : "Live check"}
          </button>

          {/* Refresh */}
          <button
            onClick={fetchApps}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 transition"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-5 animate-pulse">
                <div className="h-4 bg-neutral-200 dark:bg-neutral-700 rounded w-3/4 mb-2" />
                <div className="h-3 bg-neutral-100 dark:bg-neutral-800 rounded w-full mb-1" />
                <div className="h-3 bg-neutral-100 dark:bg-neutral-800 rounded w-2/3" />
              </div>
            ))}
          </div>
        )}

        {/* App grid */}
        {!loading && filtered.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map(app => (
              <AppCard key={app.id} app={app} onOpen={openApp} />
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && filtered.length === 0 && (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">📦</div>
            <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
              {apps.length === 0
                ? "No deployed apps yet."
                : "No apps match your search."}
            </p>
            {apps.length === 0 && (
              <p className="mt-1 text-xs text-neutral-400">
                Ask the AI to build something in <a href="/chat" className="text-amber-500 hover:underline">Chat</a>.
              </p>
            )}
          </div>
        )}

        {/* Footer count */}
        {!loading && filtered.length > 0 && (
          <p className="mt-6 text-center text-xs text-neutral-400">
            Showing {filtered.length} of {apps.length} deployed apps
            {search && ` matching "${search}"`}
          </p>
        )}
      </main>
    </div>
  );
}
