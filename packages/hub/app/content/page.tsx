"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types -- */

interface ContentRecord {
  contentId: string;
  type: string;
  title: string;
  description: string;
  ownerPeerId: string;
  builderPeerId?: string;
  repoUrl?: string;
  liveUrl?: string;
  hostingNodes: string[];
  version: number;
  versionHash: string;
  status: string;
  tags: string[];
  luxEarned: number;
  manifest: {
    upgradePolicy: string;
    maintainerProfile?: string;
    updateSchedule?: string;
    qualityGate?: string;
  };
  createdAt: number;
  updatedAt: number;
}

interface ContentStats {
  totalContent: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  totalLuxEarned: number;
}

interface ContentRevenue {
  contentId: string;
  totalLux: number;
  hostingShare: number;
  buildingShare: number;
  networkShare: number;
  distributions: { peerId: string; role: string; amount: number; timestamp: number }[];
}

/* -- Helpers -- */

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function shortId(id: string) {
  if (!id) return "\u2014";
  return id.length > 16 ? id.slice(0, 8) + "\u2026" + id.slice(-4) : id;
}

function typeBadge(type: string) {
  const colors: Record<string, string> = {
    website: "bg-blue-500/20 text-blue-400",
    api: "bg-green-500/20 text-green-400",
    dataset: "bg-purple-500/20 text-purple-400",
    service: "bg-amber-500/20 text-amber-400",
    document: "bg-neutral-500/20 text-neutral-400",
    tool: "bg-cyan-500/20 text-cyan-400",
  };
  return colors[type] || "bg-neutral-500/20 text-neutral-400";
}

function statusBadge(status: string) {
  if (status === "live") return "bg-green-500/20 text-green-400";
  if (status === "draft") return "bg-amber-500/20 text-amber-400";
  if (status === "archived") return "bg-neutral-500/20 text-neutral-500";
  return "bg-neutral-500/20 text-neutral-400";
}

/* -- Main Page -- */

export default function ContentPage() {
  const [content, setContent] = useState<ContentRecord[]>([]);
  const [stats, setStats] = useState<ContentStats | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [revenue, setRevenue] = useState<ContentRevenue | null>(null);
  const [revenueLoading, setRevenueLoading] = useState(false);
  const [offline, setOffline] = useState(false);

  const fetchContent = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchQuery) params.set("q", searchQuery);
      if (filterType) params.set("type", filterType);
      if (filterStatus) params.set("status", filterStatus);

      const [cr, sr] = await Promise.all([
        fetch(`/api/content?${params.toString()}`),
        fetch("/api/content/stats"),
      ]);
      setOffline(false);
      if (cr.ok) {
        const d = await cr.json();
        setContent(d.content || []);
      }
      if (sr.ok) setStats(await sr.json());
    } catch {
      setOffline(true);
    }
  }, [searchQuery, filterType, filterStatus]);

  const fetchRevenue = useCallback(async (contentId: string) => {
    setRevenueLoading(true);
    setRevenue(null);
    try {
      const r = await fetch(`/api/content/${encodeURIComponent(contentId)}/revenue`);
      if (r.ok) setRevenue(await r.json());
    } catch {}
    setRevenueLoading(false);
  }, []);

  useEffect(() => {
    fetchContent();
    const i = setInterval(fetchContent, 10000);
    return () => clearInterval(i);
  }, [fetchContent]);

  const toggle = (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      setRevenue(null);
    } else {
      setExpanded(id);
      fetchRevenue(id);
    }
  };

  const types = ["website", "api", "dataset", "service", "document", "tool"];

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        {offline && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
            Cannot connect to Pando node.
          </div>
        )}

        {/* Stats row */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
              <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Total Content</p>
              <p className="text-lg font-mono font-bold text-neutral-800 dark:text-neutral-200">{stats.totalContent}</p>
            </div>
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
              <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Lux Earned</p>
              <p className="text-lg font-mono font-bold text-green-400">{stats.totalLuxEarned.toFixed(2)}</p>
            </div>
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
              <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">By Type</p>
              <div className="flex flex-wrap gap-1 justify-center mt-1">
                {Object.entries(stats.byType).map(([t, c]) => (
                  <span key={t} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBadge(t)}`}>
                    {t}: {c}
                  </span>
                ))}
              </div>
            </div>
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
              <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">By Status</p>
              <div className="flex flex-wrap gap-1 justify-center mt-1">
                {Object.entries(stats.byStatus).map(([s, c]) => (
                  <span key={s} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusBadge(s)}`}>
                    {s}: {c}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Search + Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search content..."
            className="flex-1 px-3 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
          />
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="px-3 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 text-sm text-neutral-700 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
          >
            <option value="">All Types</option>
            {types.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="px-3 py-2 rounded-lg bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 text-sm text-neutral-700 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
          >
            <option value="">All Statuses</option>
            <option value="live">Live</option>
            <option value="draft">Draft</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        {/* Content list */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Content Registry</h2>
          </div>

          {content.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">No content registered yet.</p>
              <p className="text-xs text-neutral-500 mt-1">
                Content is created when agent tasks produce publishable output.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-2 text-xs text-neutral-500 font-medium">
                <div className="col-span-4">Title</div>
                <div className="col-span-1">Type</div>
                <div className="col-span-1">Status</div>
                <div className="col-span-2">Owner</div>
                <div className="col-span-1">Version</div>
                <div className="col-span-1">Lux</div>
                <div className="col-span-2">Updated</div>
              </div>
              {content.map((item) => (
                <div key={item.contentId}>
                  <button
                    onClick={() => toggle(item.contentId)}
                    className="w-full grid grid-cols-1 sm:grid-cols-12 gap-1 sm:gap-2 px-4 py-2.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition text-left"
                  >
                    <div className="sm:col-span-4 flex items-center gap-2 min-w-0">
                      <span className="text-neutral-700 dark:text-neutral-300 truncate font-medium hover:text-amber-500 dark:hover:text-amber-400">
                        {item.title}
                      </span>
                    </div>
                    <div className="sm:col-span-1">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBadge(item.type)}`}>
                        {item.type}
                      </span>
                    </div>
                    <div className="sm:col-span-1">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${statusBadge(item.status)}`}>
                        {item.status}
                      </span>
                    </div>
                    <div className="sm:col-span-2 text-neutral-500 font-mono truncate" title={item.ownerPeerId}>
                      {shortId(item.ownerPeerId)}
                    </div>
                    <div className="sm:col-span-1 text-neutral-500 font-mono">
                      v{item.version}
                    </div>
                    <div className="sm:col-span-1 text-green-400 font-mono">
                      {item.luxEarned > 0 ? item.luxEarned.toFixed(2) : "\u2014"}
                    </div>
                    <div className="sm:col-span-2 text-neutral-500">
                      {relTime(item.updatedAt)}
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {expanded === item.contentId && (
                    <div className="px-4 pb-4 bg-neutral-100/50 dark:bg-neutral-800/30 border-t border-neutral-300 dark:border-neutral-800">
                      <div className="py-3 space-y-3 text-xs">
                        {item.description && (
                          <div>
                            <span className="text-neutral-500 font-medium">Description:</span>
                            <p className="text-neutral-600 dark:text-neutral-400 mt-1 whitespace-pre-wrap">
                              {item.description}
                            </p>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-3">
                          {item.repoUrl && (
                            <div>
                              <span className="text-neutral-500 font-medium">Repo:</span>
                              <a href={item.repoUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-amber-500 hover:text-amber-400 underline">
                                {item.repoUrl}
                              </a>
                            </div>
                          )}
                          {item.liveUrl && (
                            <div>
                              <span className="text-neutral-500 font-medium">Live:</span>
                              <a href={item.liveUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-green-500 hover:text-green-400 underline">
                                {item.liveUrl}
                              </a>
                            </div>
                          )}
                        </div>

                        {item.tags.length > 0 && (
                          <div>
                            <span className="text-neutral-500 font-medium">Tags:</span>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {item.tags.map((tag, i) => (
                                <span key={i} className="px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 text-[10px]">
                                  {tag}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="flex flex-wrap gap-3">
                          <div>
                            <span className="text-neutral-500 font-medium">Hosting Nodes:</span>
                            <span className="ml-1 text-neutral-600 dark:text-neutral-400 font-mono">
                              {item.hostingNodes.length} node{item.hostingNodes.length !== 1 ? "s" : ""}
                            </span>
                          </div>
                          <div>
                            <span className="text-neutral-500 font-medium">Upgrade Policy:</span>
                            <span className="ml-1 px-1.5 py-0.5 rounded bg-neutral-200 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 text-[10px]">
                              {item.manifest.upgradePolicy}
                            </span>
                          </div>
                          {item.manifest.qualityGate && item.manifest.qualityGate !== "none" && (
                            <div>
                              <span className="text-neutral-500 font-medium">Quality Gate:</span>
                              <span className="ml-1 px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 text-[10px]">
                                {item.manifest.qualityGate}
                              </span>
                            </div>
                          )}
                          <div>
                            <span className="text-neutral-500 font-medium">Hash:</span>
                            <span className="ml-1 text-neutral-500 font-mono text-[10px]">{item.versionHash}</span>
                          </div>
                        </div>

                        {/* Revenue section */}
                        <div className="pt-2 border-t border-neutral-300 dark:border-neutral-800">
                          <span className="text-neutral-500 font-medium">Revenue</span>
                          {revenueLoading ? (
                            <p className="text-neutral-500 mt-1">Loading...</p>
                          ) : revenue && revenue.contentId === item.contentId ? (
                            <div className="mt-2 grid grid-cols-3 gap-2">
                              <div className="p-2 rounded bg-neutral-200 dark:bg-neutral-900 text-center">
                                <p className="text-[10px] text-neutral-500">Hosting (40%)</p>
                                <p className="text-sm font-mono text-green-400">{revenue.hostingShare.toFixed(4)}</p>
                              </div>
                              <div className="p-2 rounded bg-neutral-200 dark:bg-neutral-900 text-center">
                                <p className="text-[10px] text-neutral-500">Building (40%)</p>
                                <p className="text-sm font-mono text-green-400">{revenue.buildingShare.toFixed(4)}</p>
                              </div>
                              <div className="p-2 rounded bg-neutral-200 dark:bg-neutral-900 text-center">
                                <p className="text-[10px] text-neutral-500">Network (20%)</p>
                                <p className="text-sm font-mono text-green-400">{revenue.networkShare.toFixed(4)}</p>
                              </div>
                            </div>
                          ) : (
                            <p className="text-neutral-500 mt-1">No revenue data</p>
                          )}
                        </div>
                      </div>
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
