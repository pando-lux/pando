"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import NavBar from "@/components/NavBar";
import { useAuth } from "@/lib/auth-context";

/* -- Types ------------------------------------------------- */

interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  type: string;
  visibility: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  budgetSpent: number;
  budgetLimit: number;
  deploymentUrl: string;
  revenueModel: string;
}

interface MarketplaceData {
  projects: Project[];
  total: number;
}

/* -- Helpers ----------------------------------------------- */

function relativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) {
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + "...";
}

function shortPeerId(peerId: string): string {
  if (peerId.length <= 12) return peerId;
  return peerId.slice(0, 8) + "..." + peerId.slice(-4);
}

/* -- Status Badge ------------------------------------------ */

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "bg-green-500/15 text-green-400 border-green-500/25",
    archived: "bg-neutral-500/15 text-neutral-400 border-neutral-500/25",
    transferred: "bg-purple-500/15 text-purple-400 border-purple-500/25",
  };
  const style = styles[status] || styles.archived;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${style}`}>
      {status}
    </span>
  );
}

/* -- Visibility Badge -------------------------------------- */

function VisibilityBadge({ visibility }: { visibility: string }) {
  if (visibility === "featured") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-500/15 text-amber-400 border-amber-500/25">
        Featured
      </span>
    );
  }
  return null;
}

/* -- Cost Badge -------------------------------------------- */

function CostBadge({ budgetLimit, revenueModel }: { budgetLimit: number; revenueModel: string }) {
  if (revenueModel === "none" || budgetLimit === 0) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-emerald-500/15 text-emerald-400 border-emerald-500/25">
        Free
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-500/15 text-amber-400 border-amber-500/25 font-mono">
      {budgetLimit} Lux
    </span>
  );
}

/* -- Project Card ------------------------------------------ */

function ProjectCard({ project }: { project: Project; myPeerId: string; authHeaders: Record<string, string>; onRefresh: () => void }) {
  const router = useRouter();

  return (
    <div
      className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-5 space-y-3 hover:border-amber-500/30 transition cursor-pointer"
      onClick={() => router.push(`/marketplace/${encodeURIComponent(project.id)}`)}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 truncate">
              {project.name}
            </h3>
            <VisibilityBadge visibility={project.visibility} />
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-500 mt-0.5 font-mono">
            {shortPeerId(project.ownerId)}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={project.status} />
          <CostBadge budgetLimit={project.budgetLimit} revenueModel={project.revenueModel} />
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
        {truncate(project.description || "No description provided.", 100)}
      </p>

      {/* Footer meta */}
      <div className="flex items-center gap-4 text-[11px] text-neutral-500 dark:text-neutral-500">
        <span>{relativeTime(project.createdAt)}</span>
        <span className="capitalize">{project.type}</span>
        {project.deploymentUrl && (
          <a
            href={project.deploymentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber-600 dark:text-amber-400 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Live
          </a>
        )}
      </div>
    </div>
  );
}

/* -- Search Box -------------------------------------------- */

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500"
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        placeholder="Search projects..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500/50 transition"
      />
    </div>
  );
}

/* -- Filter Tabs ------------------------------------------- */

function FilterTabs({ active, onChange, counts }: { active: string; onChange: (v: string) => void; counts: Record<string, number> }) {
  const tabs = [
    { value: "all", label: "All" },
    { value: "active", label: "Active" },
  ];
  return (
    <div className="flex items-center gap-1">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          onClick={() => onChange(tab.value)}
          className={`px-3 py-1.5 text-xs font-medium rounded-full transition cursor-pointer ${
            active === tab.value
              ? "bg-amber-500/15 text-amber-500 dark:text-amber-400 border border-amber-500/25"
              : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          }`}
        >
          {tab.label}
          {counts[tab.value] !== undefined && (
            <span className="ml-1.5 inline-flex items-center justify-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300">
              {counts[tab.value]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* -- Page -------------------------------------------------- */

const PAGE_SIZE = 12;

export default function MarketplacePage() {
  const { user, token } = useAuth();
  const [data, setData] = useState<MarketplaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  const myPeerId = user?.peerId || "";
  const authHdrs = useMemo(() => {
    const h: Record<string, string> = {};
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }, [token]);

  const fetchData = useCallback(async () => {
    try {
      const offset = (page - 1) * PAGE_SIZE;
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      const res = await fetch(`/api/marketplace?${params}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        setError(`Failed to fetch marketplace (${res.status})`);
        setData({ projects: [], total: 0 });
      } else {
        const json = await res.json();
        // Handle both array and object response shapes
        if (Array.isArray(json)) {
          setData({ projects: json, total: json.length });
        } else if (json.projects) {
          setData(json);
        } else {
          setData({ projects: [], total: 0 });
        }
        setError(null);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to fetch marketplace");
      setData({ projects: [], total: 0 });
    }
    setLoading(false);
  }, [page]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Reset to page 1 when search or filter changes
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter]);

  /* -- Client-side filtering -------------------------------- */

  /* Base filtered = dedup + test filter + search (no status filter yet) */
  const baseFiltered = useMemo(() => {
    if (!data?.projects) return [];
    let result = data.projects;

    // Deduplicate by name+owner (keep most recent)
    const dedupeMap = new Map<string, Project>();
    for (const p of result) {
      const key = `${p.name.toLowerCase()}::${p.ownerId}`;
      const existing = dedupeMap.get(key);
      if (!existing || (p.updatedAt || p.createdAt) > (existing.updatedAt || existing.createdAt)) {
        dedupeMap.set(key, p);
      }
    }
    result = Array.from(dedupeMap.values());

    // Filter out test artifacts — exact matches + partial patterns
    const testExactPattern = /^(hello[\s-]?world|test[\s-]?(app)?|untitled|my[\s-]?app|new[\s-]?project|demo|example|sample|asdf|foo|bar|temp|tmp|delete[\s-]?me|placeholder)$/i;
    const testPartialPattern = /^test-|\btest-(message|static|poll|verify)|^QA\s+test|^infra-\d+|^phase\d+-test|hello\s+from\s+tester|\.(ts|js|tsx|jsx)\s*$|^Add\s+(a\s+)?\w+\s+(at|to|in)\s+/i;
    result = result.filter((p) => { const n = p.name.trim(); return !testExactPattern.test(n) && !testPartialPattern.test(n); });

    // Text search
    if (search.trim()) {
      const term = search.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(term) ||
          (p.description || "").toLowerCase().includes(term)
      );
    }

    return result;
  }, [data, search]);

  /* Filter counts for badge display */
  const filterCounts = useMemo(() => ({
    all: baseFiltered.length,
    active: baseFiltered.filter((p) => p.status === "active").length,
  }), [baseFiltered]);

  /* Final filtered = base + status filter */
  const filteredProjects = useMemo(() => {
    if (statusFilter === "all") return baseFiltered;
    return baseFiltered.filter((p) => p.status === statusFilter);
  }, [baseFiltered, statusFilter]);

  // When client-side search/filter is active, pagination reflects filtered results
  const totalPages = search.trim()
    ? Math.max(1, Math.ceil(filteredProjects.length / PAGE_SIZE))
    : Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  const featuredProjects = useMemo(
    () => filteredProjects.filter((p) => p.visibility === "featured"),
    [filteredProjects]
  );

  const regularProjects = useMemo(
    () => filteredProjects.filter((p) => p.visibility !== "featured"),
    [filteredProjects]
  );

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-6xl mx-auto p-6 space-y-8">
        {/* Header */}
        <div className="space-y-2 animate-page-fade-in">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
              Pando Marketplace
            </h1>
            <button
              onClick={() => { setLoading(true); fetchData(); }}
              className="bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-700 dark:text-neutral-300 transition cursor-pointer"
            >
              Refresh
            </button>
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Discover projects built on the network
          </p>
        </div>

        {/* Search & Filter */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 animate-page-fade-in-delay-1">
          <div className="flex-1 w-full sm:w-auto">
            <SearchBox value={search} onChange={setSearch} />
          </div>
          <FilterTabs active={statusFilter} onChange={setStatusFilter} counts={filterCounts} />
        </div>

        {/* Loading State */}
        {loading && (
          <div className="space-y-4 animate-page-fade-in-delay-1">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-32 rounded-xl bg-neutral-200 dark:bg-neutral-800 animate-pulse"
              />
            ))}
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-8 text-center animate-page-fade-in-delay-1">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Unable to load marketplace. The network might be busy.
            </p>
            <button
              onClick={() => { setLoading(true); setError(null); fetchData(); }}
              className="mt-4 w-full py-2.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-black font-medium text-sm transition cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && filteredProjects.length === 0 && (
          <div className="text-center py-12 animate-page-fade-in-delay-1">
            <p className="text-neutral-400">
              {search
                ? "No projects match your search. Try different keywords."
                : "No apps deployed yet. Be the first to build something on Pando!"}
            </p>
          </div>
        )}

        {/* Featured Projects */}
        {!loading && featuredProjects.length > 0 && (
          <section className="space-y-3 animate-page-fade-in-delay-1">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
              Featured
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {featuredProjects.map((project) => (
                <ProjectCard key={project.id} project={project} myPeerId={myPeerId} authHeaders={authHdrs} onRefresh={fetchData} />
              ))}
            </div>
          </section>
        )}

        {/* All Public Projects */}
        {!loading && regularProjects.length > 0 && (
          <section className="space-y-3 animate-page-fade-in-delay-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-500">
                {featuredProjects.length > 0 ? "All Projects" : "Public Projects"}
              </h2>
              <span className="text-xs text-neutral-400 dark:text-neutral-500">
                {filteredProjects.length} project{filteredProjects.length !== 1 ? "s" : ""}
                {data && data.total > filteredProjects.length && ` of ${data.total} total`}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {regularProjects.map((project) => (
                <ProjectCard key={project.id} project={project} myPeerId={myPeerId} authHeaders={authHdrs} onRefresh={fetchData} />
              ))}
            </div>
          </section>
        )}

        {/* All projects shown in featured section only — show count */}
        {!loading && featuredProjects.length > 0 && regularProjects.length === 0 && filteredProjects.length > 0 && (
          <div className="text-center text-xs text-neutral-500 dark:text-neutral-500 py-4 animate-page-fade-in-delay-2">
            Showing {filteredProjects.length} featured project{filteredProjects.length !== 1 ? "s" : ""}
          </div>
        )}

        {/* Pagination Controls */}
        {!loading && !error && totalPages > 1 && (
          <div className="flex items-center justify-center gap-4 pt-4 pb-2 animate-page-fade-in-delay-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:border-amber-500/50 hover:text-amber-600 dark:hover:text-amber-400 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-neutral-300 dark:disabled:hover:border-neutral-700 disabled:hover:text-neutral-700 dark:disabled:hover:text-neutral-300"
            >
              Previous
            </button>
            <span className="text-sm text-neutral-500 dark:text-neutral-400 tabular-nums">
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:border-amber-500/50 hover:text-amber-600 dark:hover:text-amber-400 transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-neutral-300 dark:disabled:hover:border-neutral-700 disabled:hover:text-neutral-700 dark:disabled:hover:text-neutral-300"
            >
              Next
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
