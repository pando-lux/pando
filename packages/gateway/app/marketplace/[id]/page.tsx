"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import NavBar from "@/components/NavBar";

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

function shortPeerId(peerId: string): string {
  if (peerId.length <= 12) return peerId;
  return peerId.slice(0, 8) + "..." + peerId.slice(-4);
}

/* -- Badges ------------------------------------------------ */

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "bg-green-500/15 text-green-400 border-green-500/25",
    archived: "bg-neutral-500/15 text-neutral-400 border-neutral-500/25",
    transferred: "bg-purple-500/15 text-purple-400 border-purple-500/25",
  };
  const style = styles[status] || styles.archived;
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${style}`}>
      {status}
    </span>
  );
}

function VisibilityBadge({ visibility }: { visibility: string }) {
  if (visibility === "featured") {
    return (
      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border bg-amber-500/15 text-amber-400 border-amber-500/25">
        Featured
      </span>
    );
  }
  if (visibility === "public") {
    return (
      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border bg-blue-500/15 text-blue-400 border-blue-500/25">
        Public
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border bg-neutral-500/15 text-neutral-400 border-neutral-500/25">
      {visibility}
    </span>
  );
}

function CostBadge({ budgetLimit, revenueModel }: { budgetLimit: number; revenueModel: string }) {
  if (revenueModel === "none" || budgetLimit === 0) {
    return (
      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border bg-emerald-500/15 text-emerald-400 border-emerald-500/25">
        Free
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border bg-amber-500/15 text-amber-400 border-amber-500/25 font-mono">
      {budgetLimit} Lux
    </span>
  );
}

/* -- Page -------------------------------------------------- */

export default function MarketplaceDetailPage() {
  const params = useParams();
  const id = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    async function fetchProject() {
      try {
        const res = await fetch(`/api/marketplace/${encodeURIComponent(id)}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          setError(res.status === 404 ? "Project not found" : `Failed to load project (${res.status})`);
          setProject(null);
        } else {
          const data = await res.json();
          // Handle both { project: {...} } and flat object shapes
          const proj = data.project || data;
          if (proj && proj.id) {
            setProject(proj);
            setError(null);
          } else {
            setError("Project not found");
            setProject(null);
          }
        }
      } catch (err: any) {
        setError(err?.message || "Failed to load project");
        setProject(null);
      }
      setLoading(false);
    }
    fetchProject();
  }, [id]);

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        {/* Back link */}
        <Link
          href="/marketplace"
          className="inline-flex items-center gap-1.5 text-sm text-neutral-500 dark:text-neutral-400 hover:text-amber-600 dark:hover:text-amber-400 transition"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back to Marketplace
        </Link>

        {/* Loading State */}
        {loading && (
          <div className="space-y-4 animate-page-fade-in">
            <div className="h-10 w-2/3 rounded-lg bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
            <div className="h-6 w-1/3 rounded-lg bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
            <div className="h-40 rounded-xl bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div className="bg-red-500/10 border border-red-500/25 rounded-xl p-8 text-center animate-page-fade-in">
            <p className="text-lg font-semibold text-red-400">{error}</p>
            <p className="text-sm text-neutral-500 mt-2">
              The project may have been removed or the ID is invalid.
            </p>
            <Link
              href="/marketplace"
              className="inline-block mt-4 px-4 py-2 text-sm font-medium rounded-lg border border-neutral-700 text-neutral-300 hover:border-amber-500/50 hover:text-amber-400 transition"
            >
              Browse Marketplace
            </Link>
          </div>
        )}

        {/* Project Detail */}
        {!loading && !error && project && (
          <div className="space-y-6 animate-page-fade-in">
            {/* Header */}
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
                  {project.name}
                </h1>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusBadge status={project.status} />
                  <VisibilityBadge visibility={project.visibility} />
                  <CostBadge budgetLimit={project.budgetLimit} revenueModel={project.revenueModel} />
                </div>
              </div>
              <p className="text-sm text-neutral-500 dark:text-neutral-500 font-mono">
                by {shortPeerId(project.ownerId)}
              </p>
            </div>

            {/* Deploy button */}
            {project.deploymentUrl && (
              <a
                href={project.deploymentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-neutral-950 font-semibold text-sm transition"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
                Open App
              </a>
            )}

            {/* Description */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-500 mb-3">
                Description
              </h2>
              <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed whitespace-pre-wrap">
                {project.description || "No description provided."}
              </p>
            </div>

            {/* Details Grid */}
            <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-500 mb-3">
                Details
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-neutral-500 dark:text-neutral-500">Type</span>
                  <p className="text-neutral-800 dark:text-neutral-200 capitalize mt-0.5">{project.type}</p>
                </div>
                <div>
                  <span className="text-neutral-500 dark:text-neutral-500">Revenue Model</span>
                  <p className="text-neutral-800 dark:text-neutral-200 capitalize mt-0.5">{project.revenueModel || "none"}</p>
                </div>
                <div>
                  <span className="text-neutral-500 dark:text-neutral-500">Budget Spent</span>
                  <p className="text-neutral-800 dark:text-neutral-200 font-mono mt-0.5">{project.budgetSpent.toFixed(2)} Lux</p>
                </div>
                <div>
                  <span className="text-neutral-500 dark:text-neutral-500">Budget Limit</span>
                  <p className="text-neutral-800 dark:text-neutral-200 font-mono mt-0.5">
                    {project.budgetLimit === 0 ? "Unlimited" : `${project.budgetLimit} Lux`}
                  </p>
                </div>
                <div>
                  <span className="text-neutral-500 dark:text-neutral-500">Created</span>
                  <p className="text-neutral-800 dark:text-neutral-200 mt-0.5">{relativeTime(project.createdAt)}</p>
                </div>
                <div>
                  <span className="text-neutral-500 dark:text-neutral-500">Last Updated</span>
                  <p className="text-neutral-800 dark:text-neutral-200 mt-0.5">{relativeTime(project.updatedAt)}</p>
                </div>
                <div className="sm:col-span-2">
                  <span className="text-neutral-500 dark:text-neutral-500">Project ID</span>
                  <p className="text-neutral-800 dark:text-neutral-200 font-mono text-xs mt-0.5 break-all">{project.id}</p>
                </div>
                {project.deploymentUrl && (
                  <div className="sm:col-span-2">
                    <span className="text-neutral-500 dark:text-neutral-500">Deployment URL</span>
                    <p className="mt-0.5">
                      <a
                        href={project.deploymentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-amber-600 dark:text-amber-400 hover:underline text-xs break-all"
                      >
                        {project.deploymentUrl}
                      </a>
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
