"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import NavBar from "@/components/NavBar";
import { useAuth } from "@/lib/auth-context";

/* -- Types ------------------------------------------------- */

interface Proposal {
  id: string;
  title: string;
  description?: string;
  status: string;
  votingDeadline?: number;
  votingEndsAt?: number;
  votes?: { approve: number; reject: number; abstain: number };
  comments?: { content: string; author: string; timestamp: number }[];
  proposedBy?: string;
  createdAt?: number;
  category?: string;
  stakeAmount?: number;
  reviewerCount?: number;
  humanOnly?: boolean;
  commentCount?: number;
}

interface ProposalReview {
  id: string;
  proposalId: string;
  reviewerPeerId: string;
  riskScore: number;
  reasoning: string;
  recommendation: "approve" | "reject" | "revise";
  modelAttestation?: string;
  createdAt: number;
}

interface ReviewSummary {
  avgRiskScore: number;
  reviewCount: number;
  recommendations: { approve: number; reject: number; revise: number };
}

interface ReviewerAssignment {
  peerId: string;
  agentId: string;
  status: string;
  riskScore: number;
  submittedAt: number;
}

interface GovernanceStats {
  totalProposals: number;
  reviewedCount: number;
  avgRiskScore: number;
  stakePool: number;
  humanOnlyCount: number;
  governanceChangeCount: number;
  statusCounts: Record<string, number>;
}

interface ModelBreakdown {
  modelId: string;
  count: number;
}

/* -- Helpers ------------------------------------------------ */

function shortId(id: string): string {
  if (!id) return "--";
  return id.length > 16 ? id.slice(0, 8) + "\u2026" + id.slice(-4) : id;
}

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

function timeLeft(deadline?: number): string {
  if (!deadline) return "";
  const d = deadline - Date.now();
  if (d <= 0) return "Ended";
  if (d < 3600000) return `${Math.floor(d / 60000)}m left`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h left`;
  return `${Math.floor(d / 86400000)}d left`;
}

function statusBadgeCls(s: string): string {
  switch (s) {
    case "active": return "bg-blue-500/20 text-blue-400 border-blue-500/30";
    case "in_review": return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    case "passed": case "approved": return "bg-green-500/20 text-green-400 border-green-500/30";
    case "rejected": return "bg-red-500/20 text-red-400 border-red-500/30";
    case "revision_requested": return "bg-orange-500/20 text-orange-400 border-orange-500/30";
    case "expired": return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
    default: return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
  }
}

function categoryBadgeCls(c: string): string {
  switch (c) {
    case "code_change": return "bg-indigo-500/15 text-indigo-400 border-indigo-500/25";
    case "config_change": return "bg-cyan-500/15 text-cyan-400 border-cyan-500/25";
    case "economic_change": return "bg-amber-500/15 text-amber-400 border-amber-500/25";
    case "governance_change": return "bg-purple-500/15 text-purple-400 border-purple-500/25";
    case "social": return "bg-teal-500/15 text-teal-400 border-teal-500/25";
    case "emergency": return "bg-red-500/15 text-red-400 border-red-500/25";
    default: return "bg-neutral-500/15 text-neutral-400 border-neutral-500/25";
  }
}

function categoryLabel(c: string): string {
  return c.replace(/_/g, " ");
}

function riskColor(score: number): string {
  if (score <= 1) return "text-green-400";
  if (score <= 2) return "text-blue-400";
  if (score <= 3) return "text-yellow-400";
  if (score <= 4) return "text-orange-400";
  return "text-red-400";
}

function riskBgColor(score: number): string {
  if (score <= 1) return "bg-green-500";
  if (score <= 2) return "bg-blue-500";
  if (score <= 3) return "bg-yellow-500";
  if (score <= 4) return "bg-orange-500";
  return "bg-red-500";
}

function recommendationCls(r: string): string {
  switch (r) {
    case "approve": return "bg-green-500/20 text-green-400 border-green-500/30";
    case "reject": return "bg-red-500/20 text-red-400 border-red-500/30";
    case "revise": return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    default: return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
  }
}

function reviewerStatusCls(s: string): string {
  switch (s) {
    case "completed": return "bg-green-500/20 text-green-400";
    case "reviewing": return "bg-blue-500/20 text-blue-400";
    case "pending": return "bg-yellow-500/20 text-yellow-400";
    case "failed": return "bg-red-500/20 text-red-400";
    default: return "bg-neutral-500/20 text-neutral-400";
  }
}

/* -- Main Page ---------------------------------------------- */

export default function GovernancePage() {
  const { token } = useAuth();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Proposal | null>(null);
  const [stats, setStats] = useState<GovernanceStats | null>(null);

  // Pagination & filtering
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 25;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Reviews and reviewers for expanded proposal
  const [reviews, setReviews] = useState<ProposalReview[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary | null>(null);
  const [reviewers, setReviewers] = useState<ReviewerAssignment[]>([]);
  const [reviewerMeta, setReviewerMeta] = useState<{ reviewerCount: number; humanOnly: boolean } | null>(null);

  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ ok?: boolean; text: string } | null>(null);

  const [voteMsg, setVoteMsg] = useState<Record<string, string>>({});
  const [commentText, setCommentText] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [modelBreakdown, setModelBreakdown] = useState<ModelBreakdown[]>([]);

  /* -- Data fetching ---------------------------------------- */

  const fetchProposals = useCallback(async () => {
    try {
      const res = await fetch("/api/governance/proposals");
      if (res.ok) { const d = await res.json(); setProposals(d.proposals || d || []); }
    } catch { /* ignore */ }
    setProposalsLoading(false);
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/governance/stats");
      if (res.ok) { setStats(await res.json()); }
    } catch { /* ignore */ }
  }, []);

  const fetchDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/governance/proposal?id=${encodeURIComponent(id)}`);
      if (res.ok) {
        const d = await res.json();
        const p = d.proposal || d;
        const votesArr = Array.isArray(d.votes) ? d.votes : [];
        const commentsArr = Array.isArray(d.comments) ? d.comments : [];
        // Use individual vote records if available, otherwise fall back to decision or proposal aggregates
        const dec = d.decision;
        const aggregatedVotes = votesArr.length > 0
          ? {
              approve: votesArr.filter((v: any) => v.choice === "approve").length,
              reject: votesArr.filter((v: any) => v.choice === "reject").length,
              abstain: votesArr.filter((v: any) => v.choice === "abstain").length,
            }
          : {
              approve: p.votes?.approve ?? dec?.votesFor ?? 0,
              reject: p.votes?.reject ?? dec?.votesAgainst ?? 0,
              abstain: p.votes?.abstain ?? dec?.votesAbstain ?? 0,
            };
        setDetail({
          ...p,
          votingDeadline: p.votingEndsAt || p.votingDeadline,
          votes: aggregatedVotes,
          comments: commentsArr.map((c: any) => ({
            content: c.content,
            author: c.from || c.author || "unknown",
            timestamp: c.createdAt || c.timestamp || Date.now(),
          })),
        });
      }
    } catch { /* ignore */ }
  }, []);

  const fetchReviews = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/governance/proposal/${encodeURIComponent(id)}/reviews`);
      if (res.ok) {
        const d = await res.json();
        setReviews(d.reviews || []);
        setReviewSummary(d.summary || null);
      } else {
        setReviews([]);
        setReviewSummary(null);
      }
    } catch {
      setReviews([]);
      setReviewSummary(null);
    }
  }, []);

  const fetchReviewers = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/governance/proposal/${encodeURIComponent(id)}/reviewers`);
      if (res.ok) {
        const d = await res.json();
        setReviewers(d.reviewers || []);
        setReviewerMeta({ reviewerCount: d.reviewerCount || 0, humanOnly: d.humanOnly || false });
      } else {
        setReviewers([]);
        setReviewerMeta(null);
      }
    } catch {
      setReviewers([]);
      setReviewerMeta(null);
    }
  }, []);

  const fetchModels = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/governance/proposal/${encodeURIComponent(id)}/models`);
      if (res.ok) { const d = await res.json(); setModelBreakdown(d.models || []); }
      else { setModelBreakdown([]); }
    } catch { setModelBreakdown([]); }
  }, []);

  useEffect(() => {
    fetchProposals();
    fetchStats();
    const i = setInterval(() => { fetchProposals(); fetchStats(); }, 15000);
    return () => clearInterval(i);
  }, [fetchProposals, fetchStats]);

  /* -- Filtered & paginated proposals ----------------------- */

  const filteredProposals = useMemo(() => {
    let result = proposals;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(p => p.title.toLowerCase().includes(q));
    }
    if (statusFilter !== "all") {
      result = result.filter(p => p.status === statusFilter);
    }
    return result;
  }, [proposals, search, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredProposals.length / PAGE_SIZE));
  const paginatedProposals = filteredProposals.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, statusFilter]);

  /* -- Actions ---------------------------------------------- */

  async function handlePropose(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true); setSubmitMsg(null);
    try {
      const res = await fetch("/api/governance/propose", {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-User-Token": token } : {}) },
        body: JSON.stringify({ title: title.trim(), description: desc.trim() }),
      });
      if (res.ok) {
        setSubmitMsg({ ok: true, text: "Proposal created" });
        setTitle(""); setDesc("");
        setTimeout(() => { fetchProposals(); fetchStats(); }, 500);
      } else {
        const d = await res.json(); setSubmitMsg({ text: d.error || "Failed" });
      }
    } catch { setSubmitMsg({ text: "Network error" }); }
    setSubmitting(false);
  }

  async function handleVote(proposalId: string, choice: string) {
    try {
      const res = await fetch("/api/governance/vote", {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-User-Token": token } : {}) },
        body: JSON.stringify({ proposalId, choice }),
      });
      if (res.ok) {
        setVoteMsg(v => ({ ...v, [proposalId]: `Voted: ${choice}` }));
        fetchDetail(proposalId); fetchProposals();
      } else {
        const d = await res.json();
        setVoteMsg(v => ({ ...v, [proposalId]: d.error || "Vote failed" }));
      }
    } catch { setVoteMsg(v => ({ ...v, [proposalId]: "Network error" })); }
  }

  async function handleComment(proposalId: string) {
    if (!commentText.trim()) return;
    setCommenting(true);
    try {
      const res = await fetch("/api/governance/comment", {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-User-Token": token } : {}) },
        body: JSON.stringify({ proposalId, content: commentText.trim() }),
      });
      if (res.ok) { setCommentText(""); fetchDetail(proposalId); }
    } catch { /* ignore */ }
    setCommenting(false);
  }

  function toggle(id: string) {
    if (expanded === id) {
      setExpanded(null); setDetail(null); setModelBreakdown([]);
      setReviews([]); setReviewSummary(null); setReviewers([]); setReviewerMeta(null);
    } else {
      setExpanded(id);
      fetchDetail(id);
      fetchModels(id);
      fetchReviews(id);
      fetchReviewers(id);
    }
  }

  /* -- Render ----------------------------------------------- */

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">Governance</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            AI-powered proposal review, voting, and decision-making.
          </p>
        </div>

        {/* Summary Stats */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Total Proposals" value={stats.totalProposals} />
            <StatCard label="AI Reviewed" value={stats.reviewedCount} accent="text-indigo-400" />
            <StatCard
              label="Avg Risk Score"
              render={() => (
                <div className="flex items-center justify-center gap-2">
                  <span className={`text-lg font-mono font-bold ${riskColor(stats.avgRiskScore)}`}>
                    {stats.avgRiskScore > 0 ? stats.avgRiskScore.toFixed(1) : "--"}
                  </span>
                  <span className="text-[10px] text-neutral-500">/5</span>
                </div>
              )}
            />
            <StatCard
              label="Active Stake Pool"
              render={() => (
                <p className="text-lg font-mono font-bold text-amber-400">
                  {stats.stakePool > 0 ? stats.stakePool.toFixed(1) : "0"} <span className="text-xs text-neutral-500">Lux</span>
                </p>
              )}
            />
          </div>
        )}

        {/* Create Proposal */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4 space-y-3">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Create Proposal</h2>
          <form onSubmit={handlePropose} className="space-y-3">
            <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="Proposal title"
              className="w-full bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50" />
            <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Description" rows={3}
              className="w-full bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 resize-none" />
            <div className="flex items-center gap-3">
              <button type="submit" disabled={submitting || !title.trim()}
                className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-4 py-2 text-sm transition">
                {submitting ? "Creating..." : "Create Proposal"}
              </button>
              {submitMsg && <span className={`text-xs ${submitMsg.ok ? "text-green-400" : "text-red-400"}`}>{submitMsg.text}</span>}
            </div>
          </form>
        </div>

        {/* Proposals List */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Proposals</h2>
            {stats && (
              <span className="text-[10px] text-neutral-500 font-mono">
                {(search.trim() || statusFilter !== "all") ? filteredProposals.length : stats.totalProposals} proposal{((search.trim() || statusFilter !== "all") ? filteredProposals.length : stats.totalProposals) !== 1 ? "s" : ""}
              </span>
            )}
          </div>

          {/* Search & Filter */}
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center gap-3">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search proposals..."
              className="flex-1 bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            />
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="in_review">In Review</option>
              <option value="passed">Passed</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="revision_requested">Revision Requested</option>
              <option value="expired">Expired</option>
            </select>
          </div>

          {paginatedProposals.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-neutral-500">{proposalsLoading ? "Loading proposals..." : (search || statusFilter !== "all") ? "No matching proposals" : "No proposals yet"}</div>
          ) : (
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {paginatedProposals.map(p => (
                <div key={p.id}>
                  {/* Proposal row */}
                  <button onClick={() => toggle(p.id)} className="w-full px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition overflow-hidden relative">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2">
                      {/* Title — always visible, shown first on mobile */}
                      <span className="text-sm text-neutral-800 dark:text-neutral-200 font-medium min-w-0 truncate order-first sm:order-none sm:flex-1">
                        {p.title}
                      </span>

                      {/* Badges row */}
                      <div className="flex items-center gap-2 flex-wrap order-last sm:order-first sm:flex-shrink-0">
                        {/* Status badge */}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 ${statusBadgeCls(p.status)}`}>
                          {p.status.replace(/_/g, " ")}
                        </span>

                        {/* Category badge */}
                        {p.category && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 ${categoryBadgeCls(p.category)}`}>
                            {categoryLabel(p.category)}
                          </span>
                        )}

                        {/* Human-only badge */}
                        {p.humanOnly && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-pink-500/15 text-pink-400 border border-pink-500/25 flex-shrink-0">
                            human only
                          </span>
                        )}
                      </div>

                      {/* Right side metadata */}
                      <div className="hidden sm:flex items-center gap-3 flex-shrink-0">
                        {/* Stake */}
                        {p.stakeAmount != null && p.stakeAmount > 0 && (
                          <span className="text-[10px] font-mono text-amber-400" title="Lux staked">
                            {p.stakeAmount.toFixed(1)} Lux
                          </span>
                        )}

                        {/* Reviewer count */}
                        {p.reviewerCount != null && p.reviewerCount > 0 && (
                          <span className="text-[10px] text-indigo-400 font-mono" title="Assigned reviewers">
                            {p.reviewerCount} reviewer{p.reviewerCount !== 1 ? "s" : ""}
                          </span>
                        )}

                        {/* Vote counts */}
                        {p.votes && (
                          <span className="text-[10px] text-neutral-500 font-mono">
                            {p.votes.approve}A / {p.votes.reject}R
                          </span>
                        )}

                        {/* Time remaining */}
                        {(p.votingDeadline || p.votingEndsAt) && (
                          <span className="text-[10px] text-neutral-500">
                            {timeLeft(p.votingDeadline || p.votingEndsAt)}
                          </span>
                        )}

                        {/* Expand indicator */}
                        <span className="text-neutral-500 text-[10px]">
                          {expanded === p.id ? "\u25B2" : "\u25BC"}
                        </span>
                      </div>

                      {/* Mobile expand indicator */}
                      <span className="sm:hidden text-neutral-500 text-[10px] self-end absolute right-4 top-3">
                        {expanded === p.id ? "\u25B2" : "\u25BC"}
                      </span>
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {expanded === p.id && detail && (
                    <div className="px-4 pb-4 bg-neutral-100/50 dark:bg-neutral-800/30 border-t border-neutral-300 dark:border-neutral-800 space-y-4 py-3">
                      {/* Description */}
                      {detail.description && (
                        <div className="text-sm text-neutral-600 dark:text-neutral-400 space-y-1.5">
                          {detail.description.split("\n").filter(line => line.trim() !== "").map((line, i) => {
                            const labelMatch = line.match(/^([A-Za-z][A-Za-z0-9 _-]*):(.+)$/);
                            if (labelMatch) {
                              return (
                                <p key={i}>
                                  <span className="font-semibold text-neutral-700 dark:text-neutral-300">{labelMatch[1]}:</span>
                                  {labelMatch[2]}
                                </p>
                              );
                            }
                            return <p key={i}>{line}</p>;
                          })}
                        </div>
                      )}

                      {/* Meta row */}
                      <div className="flex flex-wrap gap-4 text-xs text-neutral-500">
                        {detail.proposedBy && <span>Proposed by: <span className="font-mono text-neutral-400">{shortId(detail.proposedBy)}</span></span>}
                        {detail.createdAt && <span>{relTime(detail.createdAt)}</span>}
                        {detail.stakeAmount != null && detail.stakeAmount > 0 && (
                          <span>Staked: <span className="text-amber-400 font-mono">{detail.stakeAmount.toFixed(1)} Lux</span></span>
                        )}
                      </div>

                      {/* AI Reviews Section */}
                      {reviews.length > 0 && (
                        <div className="border-t border-neutral-300 dark:border-neutral-800 pt-3 space-y-3">
                          <div className="flex items-center gap-2">
                            <h3 className="text-xs text-neutral-500 font-medium">AI Reviews</h3>
                            {reviewSummary && (
                              <span className="text-[10px] text-neutral-500 font-mono">
                                ({reviewSummary.reviewCount} review{reviewSummary.reviewCount !== 1 ? "s" : ""})
                              </span>
                            )}
                          </div>

                          {/* Review Summary Bar */}
                          {reviewSummary && (
                            <div className="bg-neutral-200 dark:bg-neutral-800/60 rounded-lg p-3 space-y-2">
                              <div className="flex items-center gap-4 text-xs">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-neutral-500">Avg Risk:</span>
                                  <span className={`font-bold font-mono ${riskColor(reviewSummary.avgRiskScore)}`}>
                                    {reviewSummary.avgRiskScore.toFixed(1)}
                                  </span>
                                  <span className="text-neutral-600">/5</span>
                                </div>
                                <div className="flex-1 h-1.5 bg-neutral-300 dark:bg-neutral-700 rounded-full overflow-hidden">
                                  <div
                                    className={`h-full rounded-full ${riskBgColor(reviewSummary.avgRiskScore)}`}
                                    style={{ width: `${(reviewSummary.avgRiskScore / 5) * 100}%` }}
                                  />
                                </div>
                              </div>
                              <div className="flex gap-4 text-[10px]">
                                <span className="text-green-400">
                                  Approve: {reviewSummary.recommendations.approve}
                                </span>
                                <span className="text-red-400">
                                  Reject: {reviewSummary.recommendations.reject}
                                </span>
                                <span className="text-yellow-400">
                                  Revise: {reviewSummary.recommendations.revise}
                                </span>
                              </div>
                            </div>
                          )}

                          {/* Individual Reviews */}
                          <div className="space-y-2">
                            {reviews.map(r => (
                              <div key={r.id} className="bg-neutral-200 dark:bg-neutral-800/40 rounded-lg p-3 space-y-1.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-[10px] font-mono text-neutral-400" title={r.reviewerPeerId}>
                                    {shortId(r.reviewerPeerId)}
                                  </span>

                                  {/* Risk score badge */}
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold font-mono ${riskColor(r.riskScore)}`}>
                                    Risk: {r.riskScore}/5
                                  </span>

                                  {/* Risk bar */}
                                  <div className="w-16 h-1 bg-neutral-300 dark:bg-neutral-700 rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full ${riskBgColor(r.riskScore)}`}
                                      style={{ width: `${(r.riskScore / 5) * 100}%` }}
                                    />
                                  </div>

                                  {/* Recommendation badge */}
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${recommendationCls(r.recommendation)}`}>
                                    {r.recommendation}
                                  </span>

                                  {/* Model attestation */}
                                  {r.modelAttestation && (
                                    <span className="text-[10px] text-indigo-400 font-mono">
                                      {r.modelAttestation}
                                    </span>
                                  )}

                                  <span className="ml-auto text-[10px] text-neutral-500">
                                    {relTime(r.createdAt)}
                                  </span>
                                </div>
                                <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
                                  {r.reasoning}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Reviewer Assignments */}
                      {(reviewers.length > 0 || (reviewerMeta && reviewerMeta.reviewerCount > 0)) && (
                        <div className="border-t border-neutral-300 dark:border-neutral-800 pt-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <h3 className="text-xs text-neutral-500 font-medium">Reviewer Assignments</h3>
                            {reviewerMeta && (
                              <span className="text-[10px] text-neutral-500 font-mono">
                                ({reviewerMeta.reviewerCount} assigned)
                              </span>
                            )}
                            {reviewerMeta?.humanOnly && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-pink-500/15 text-pink-400 border border-pink-500/25">
                                human only
                              </span>
                            )}
                          </div>
                          {reviewers.length > 0 ? (
                            <div className="space-y-1">
                              {reviewers.map((rv, i) => (
                                <div key={i} className="flex items-center gap-2 text-xs">
                                  <span className="font-mono text-neutral-400 w-24 truncate" title={rv.peerId}>
                                    {shortId(rv.peerId)}
                                  </span>
                                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${reviewerStatusCls(rv.status)}`}>
                                    {rv.status}
                                  </span>
                                  {rv.riskScore > 0 && (
                                    <span className={`text-[10px] font-mono ${riskColor(rv.riskScore)}`}>
                                      risk {rv.riskScore}/5
                                    </span>
                                  )}
                                  {rv.submittedAt > 0 && (
                                    <span className="text-[10px] text-neutral-500 ml-auto">
                                      {relTime(rv.submittedAt)}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-neutral-500">No reviewer assignments yet.</p>
                          )}
                        </div>
                      )}

                      {/* Vote buttons (active proposals) */}
                      {detail.status === "active" && (
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-neutral-500 font-medium mr-1">Vote:</span>
                          <button onClick={() => handleVote(p.id, "approve")} className="bg-green-500/15 hover:bg-green-500/25 text-green-600 dark:text-green-400 border border-green-500/25 rounded-lg px-3 py-1.5 text-xs font-medium transition">Approve</button>
                          <button onClick={() => handleVote(p.id, "reject")} className="bg-red-500/15 hover:bg-red-500/25 text-red-500 dark:text-red-400 border border-red-500/25 rounded-lg px-3 py-1.5 text-xs font-medium transition">Reject</button>
                          <button onClick={() => handleVote(p.id, "abstain")} className="bg-neutral-500/15 hover:bg-neutral-500/25 text-neutral-600 dark:text-neutral-400 border border-neutral-500/25 rounded-lg px-3 py-1.5 text-xs font-medium transition">Abstain</button>
                          {voteMsg[p.id] && <span className="text-xs text-neutral-600 dark:text-neutral-400">{voteMsg[p.id]}</span>}
                        </div>
                      )}

                      {/* Approved banner */}
                      {(detail.status === "passed" || detail.status === "approved") && (
                        <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-2.5 flex items-center gap-2">
                          <span className="text-green-500 text-xs font-semibold">Approved</span>
                          <span className="text-xs text-neutral-600 dark:text-neutral-400">Task auto-created in scheduler</span>
                          <span className="text-xs text-amber-500 ml-auto">Task auto-created</span>
                        </div>
                      )}

                      {/* Vote counts */}
                      {detail.votes && (
                        <div className="flex gap-4 text-xs">
                          <span className="text-green-600 dark:text-green-400">Approve: {detail.votes.approve}</span>
                          <span className="text-red-500 dark:text-red-400">Reject: {detail.votes.reject}</span>
                          <span className="text-neutral-500">Abstain: {detail.votes.abstain}</span>
                        </div>
                      )}

                      {/* Model Attestation */}
                      {modelBreakdown.length > 0 && (
                        <div className="border-t border-neutral-300 dark:border-neutral-800 pt-3">
                          <p className="text-xs text-neutral-500 font-medium mb-2">Model Attestation</p>
                          <div className="flex flex-wrap gap-2">
                            {modelBreakdown.map(m => (
                              <span key={m.modelId} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-xs">
                                <span className="text-indigo-600 dark:text-indigo-400 font-medium">{m.modelId}</span>
                                <span className="text-neutral-500">{m.count} vote{m.count !== 1 ? "s" : ""}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Comments */}
                      {detail.comments && detail.comments.length > 0 && (
                        <div className="space-y-2 border-t border-neutral-300 dark:border-neutral-800 pt-3">
                          <p className="text-xs text-neutral-500 font-medium">Comments</p>
                          {detail.comments.map((c, i) => (
                            <div key={i} className="text-xs">
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-neutral-500 font-mono">{shortId(c.author)}</span>
                                <span className="text-neutral-400 dark:text-neutral-600">{relTime(c.timestamp)}</span>
                              </div>
                              <p className="text-neutral-600 dark:text-neutral-400">{c.content}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Add comment */}
                      <div className="flex gap-2">
                        <input type="text" value={commentText} onChange={e => setCommentText(e.target.value)}
                          onKeyDown={e => e.key === "Enter" && handleComment(p.id)}
                          placeholder="Add a comment..." className="flex-1 bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50" />
                        <button onClick={() => handleComment(p.id)} disabled={commenting || !commentText.trim()}
                          className="bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded-lg px-3 py-1.5 text-xs transition disabled:opacity-50">Send</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
              >
                Prev
              </button>
              <span className="text-xs text-neutral-500 font-mono">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
              >
                Next
              </button>
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
