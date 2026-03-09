"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";
import { useAuth } from "@/lib/auth-context";

/* -- Types ------------------------------------------------- */

interface Project {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  type: "private" | "shared" | "public";
  visibility: "owner_only" | "collaborators" | "listed" | "featured";
  revenueModel: "none" | "usage_fee" | "subscription" | "contribution_split";
  budgetSpent: number;
  budgetLimit: number;
  threadId: string;
  managerAgentId: string;
  repoUrl: string;
  githubRepo: string;
  deploymentUrl: string;
  deploymentType: string;
  deploymentStatus: string;
  tier: number;
  status: "active" | "archived" | "transferred";
  createdAt: number;
  updatedAt: number;
}

interface Collaborator {
  userId: string;
  role: string;
  addedAt: number;
}

interface ProjectStats {
  totalProjects: number;
  activeProjects: number;
  sharedWithMe: number;
  publicProjects: number;
}

type TabKey = "mine" | "shared" | "public";

/* -- Helpers ----------------------------------------------- */

function relTime(ts: number): string {
  if (!ts) return "--";
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

function shortId(id: string): string {
  if (!id) return "--";
  return id.length > 16 ? id.slice(0, 8) + "\u2026" + id.slice(-4) : id;
}

function typeBadgeCls(type: string): string {
  switch (type) {
    case "public":
      return "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/25";
    case "shared":
      return "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/25";
    case "private":
    default:
      return "bg-neutral-500/15 text-neutral-600 dark:text-neutral-400 border-neutral-500/25";
  }
}

function statusBadgeCls(status: string): string {
  switch (status) {
    case "active":
      return "bg-green-500/20 text-green-400 border-green-500/30";
    case "archived":
      return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
    case "transferred":
      return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    default:
      return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
  }
}

function deployBadgeCls(ds: string): string {
  switch (ds) {
    case "live":
      return "bg-green-500/20 text-green-400 border-green-500/30";
    case "deploying":
      return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    case "failed":
      return "bg-red-500/20 text-red-400 border-red-500/30";
    default:
      return "";
  }
}

function revenueLabel(model: string): string {
  switch (model) {
    case "usage_fee":
      return "Usage Fee";
    case "subscription":
      return "Subscription";
    case "contribution_split":
      return "Contribution Split";
    case "none":
    default:
      return "None";
  }
}

function roleBadgeCls(role: string): string {
  switch (role) {
    case "owner":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25";
    case "collaborator":
      return "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/25";
    case "qa_lead":
      return "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/25";
    case "viewer":
      return "bg-neutral-500/15 text-neutral-600 dark:text-neutral-400 border-neutral-500/25";
    default:
      return "bg-neutral-500/15 text-neutral-600 dark:text-neutral-400 border-neutral-500/25";
  }
}

/* -- Page -------------------------------------------------- */

export default function ProjectsPage() {
  const { user, token } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("mine");

  // Create project form
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formType, setFormType] = useState("private");
  const [formVisibility, setFormVisibility] = useState("collaborators");
  const [formBudgetLimit, setFormBudgetLimit] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{
    ok?: boolean;
    text: string;
  } | null>(null);

  // Settings form (for owner inline edit)
  const [showSettings, setShowSettings] = useState(false);
  const [settingsName, setSettingsName] = useState("");
  const [settingsDesc, setSettingsDesc] = useState("");
  const [settingsType, setSettingsType] = useState("");
  const [settingsVisibility, setSettingsVisibility] = useState("");
  const [settingsBudgetLimit, setSettingsBudgetLimit] = useState(0);
  const [settingsRepoUrl, setSettingsRepoUrl] = useState("");
  const [settingsTier, setSettingsTier] = useState(1);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState<{ ok?: boolean; text: string } | null>(null);

  // Invite / collaborator management
  const [showInvite, setShowInvite] = useState(false);
  const [invitePeerId, setInvitePeerId] = useState("");
  const [inviteRole, setInviteRole] = useState("collaborator");
  const [inviteAdding, setInviteAdding] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteGenerating, setInviteGenerating] = useState(false);

  // Hosting
  const [showHosting, setShowHosting] = useState(false);
  const [hostingInfo, setHostingInfo] = useState<any>(null);
  const [hostingLoading, setHostingLoading] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployMsg, setDeployMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [hostingFiles, setHostingFiles] = useState<FileList | null>(null);

  // Undeploy
  const [undeploying, setUndeploying] = useState(false);
  const [undeployMsg, setUndeployMsg] = useState<{ ok?: boolean; text: string } | null>(null);

  // P2P Deploy (Phase 87 — GitHub + compute peer)
  const [p2pDeploying, setP2pDeploying] = useState(false);
  const [p2pDeployMsg, setP2pDeployMsg] = useState<{ ok?: boolean; text: string } | null>(null);

  const authHeaders = useCallback((): Record<string, string> => {
    const h: Record<string, string> = {};
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
  }, [token]);

  /* -- Data fetching ---------------------------------------- */

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { headers: authHeaders() }).catch(() => null);
      setOffline(false);
      if (res?.ok) {
        const d = await res.json();
        setProjects(d.projects || []);
      }
    } catch {
      setOffline(true);
    }
    setLoading(false);
  }, [authHeaders]);

  useEffect(() => {
    fetchData();
    const i = setInterval(fetchData, 15000);
    return () => clearInterval(i);
  }, [fetchData]);

  /* -- Tab filtering --------------------------------------- */

  const myPeerId = user?.peerId || "";

  const filteredProjects = projects.filter((p) => {
    switch (activeTab) {
      case "mine":
        return p.ownerId === myPeerId;
      case "shared":
        return p.ownerId !== myPeerId && p.type !== "public" && p.visibility !== "listed" && p.visibility !== "featured";
      case "public":
        return p.type === "public" || p.visibility === "listed" || p.visibility === "featured";
      default:
        return true;
    }
  });

  const tabCounts = {
    mine: projects.filter((p) => p.ownerId === myPeerId).length,
    shared: projects.filter((p) => p.ownerId !== myPeerId && p.type !== "public" && p.visibility !== "listed" && p.visibility !== "featured").length,
    public: projects.filter((p) => p.type === "public" || p.visibility === "listed" || p.visibility === "featured").length,
  };

  const stats: ProjectStats = {
    totalProjects: projects.length,
    activeProjects: projects.filter((p) => p.status === "active").length,
    sharedWithMe: tabCounts.shared,
    publicProjects: tabCounts.public,
  };

  /* -- Role for current user in a project ------------------- */

  function getMyRole(project: Project): string {
    if (project.ownerId === myPeerId) return "owner";
    // Check collaborators if this project is expanded
    if (expanded === project.id && collaborators.length > 0) {
      const me = collaborators.find((c) => c.userId === myPeerId);
      if (me) return me.role;
    }
    // Fallback: if it shows up in shared tab, we must be a collaborator
    if (project.ownerId !== myPeerId && project.type !== "public") return "collaborator";
    return "viewer";
  }

  /* -- Expand / collapse ------------------------------------ */

  async function toggleExpand(id: string) {
    if (expanded === id) {
      setExpanded(null);
      setCollaborators([]);
      setShowSettings(false);
      setShowInvite(false);
      setShowHosting(false);
      setInviteCode(null);
      setSettingsMsg(null);
      setInviteMsg(null);
      setHostingInfo(null);
      setDeployMsg(null);
      setHostingFiles(null);
      setP2pDeployMsg(null);
    } else {
      setExpanded(id);
      setCollaborators([]);
      setShowSettings(false);
      setShowInvite(false);
      setShowHosting(false);
      setInviteCode(null);
      setSettingsMsg(null);
      setInviteMsg(null);
      setHostingInfo(null);
      setDeployMsg(null);
      setHostingFiles(null);
      setP2pDeployMsg(null);

      // Pre-fill settings form
      const proj = projects.find((p) => p.id === id);
      if (proj) {
        setSettingsName(proj.name);
        setSettingsDesc(proj.description || "");
        setSettingsType(proj.type);
        setSettingsVisibility(proj.visibility || "collaborators");
        setSettingsBudgetLimit(proj.budgetLimit || 100);
        setSettingsRepoUrl(proj.repoUrl || "");
        setSettingsTier(proj.tier || 1);
      }

      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(id)}/collaborators`,
          { headers: authHeaders() }
        );
        if (res.ok) {
          const d = await res.json();
          setCollaborators(d.collaborators || []);
        }
      } catch {
        /* ignore */
      }
    }
  }

  /* -- Create project --------------------------------------- */

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim()) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name: formName.trim(),
          description: formDesc.trim(),
          type: formType,
          visibility: formVisibility,
          budgetLimit: formBudgetLimit,
        }),
      });
      if (res.ok) {
        setSubmitMsg({ ok: true, text: "Project created" });
        setFormName("");
        setFormDesc("");
        setFormType("private");
        setFormVisibility("collaborators");
        setFormBudgetLimit(100);
        setShowCreateForm(false);
        setTimeout(fetchData, 500);
      } else {
        const d = await res.json();
        setSubmitMsg({ text: d.error || "Failed to create project" });
      }
    } catch {
      setSubmitMsg({ text: "Network error" });
    }
    setSubmitting(false);
  }

  /* -- Save settings (PATCH) -------------------------------- */

  async function handleSaveSettings(projectId: string) {
    setSettingsSaving(true);
    setSettingsMsg(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          name: settingsName.trim(),
          description: settingsDesc.trim(),
          type: settingsType,
          visibility: settingsVisibility,
          budgetLimit: settingsBudgetLimit,
          repoUrl: settingsRepoUrl.trim() || undefined,
          tier: settingsTier,
        }),
      });
      if (res.ok) {
        setSettingsMsg({ ok: true, text: "Saved" });
        setTimeout(fetchData, 500);
      } else {
        const d = await res.json();
        setSettingsMsg({ text: d.error || "Failed to save" });
      }
    } catch {
      setSettingsMsg({ text: "Network error" });
    }
    setSettingsSaving(false);
  }

  /* -- Add collaborator ------------------------------------- */

  async function handleAddCollaborator(projectId: string) {
    if (!invitePeerId.trim()) return;
    setInviteAdding(true);
    setInviteMsg(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/collaborators`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ userId: invitePeerId.trim(), role: inviteRole }),
        }
      );
      if (res.ok) {
        setInviteMsg({ ok: true, text: "Collaborator added" });
        setInvitePeerId("");
        // Refresh collaborators
        const cRes = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/collaborators`,
          { headers: authHeaders() }
        );
        if (cRes.ok) {
          const d = await cRes.json();
          setCollaborators(d.collaborators || []);
        }
      } else {
        const d = await res.json();
        setInviteMsg({ text: d.error || "Failed to add collaborator" });
      }
    } catch {
      setInviteMsg({ text: "Network error" });
    }
    setInviteAdding(false);
  }

  /* -- Remove collaborator ---------------------------------- */

  async function handleRemoveCollaborator(projectId: string, userId: string) {
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/collaborators?userId=${encodeURIComponent(userId)}`,
        { method: "DELETE", headers: authHeaders() }
      );
      if (res.ok) {
        setCollaborators((prev) => prev.filter((c) => c.userId !== userId));
      }
    } catch {
      /* ignore */
    }
  }

  /* -- Generate invite code --------------------------------- */

  async function handleGenerateInvite(projectId: string) {
    setInviteGenerating(true);
    setInviteCode(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/invite`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({}),
        }
      );
      if (res.ok) {
        const d = await res.json();
        setInviteCode(d.invite?.code || d.inviteCode || d.code || JSON.stringify(d));
      }
    } catch {
      /* ignore */
    }
    setInviteGenerating(false);
  }

  /* -- Hosting ---------------------------------------------- */

  async function fetchHostingInfo(projectId: string) {
    setHostingLoading(true);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/hosting`,
        { headers: authHeaders() }
      );
      if (res.ok) {
        const d = await res.json();
        setHostingInfo(d.deployment || d);
      }
    } catch {
      /* ignore */
    }
    setHostingLoading(false);
  }

  async function handleDeploy(projectId: string) {
    if (!hostingFiles || hostingFiles.length === 0) return;
    setDeploying(true);
    setDeployMsg(null);
    try {
      const files: { path: string; content: string; contentType: string }[] = [];
      for (let i = 0; i < hostingFiles.length; i++) {
        const file = hostingFiles[i];
        const buffer = await file.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
        );
        files.push({
          path: file.webkitRelativePath || file.name,
          content: base64,
          contentType: file.type || "application/octet-stream",
        });
      }
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/hosting`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ files }),
        }
      );
      if (res.ok) {
        const d = await res.json();
        setDeployMsg({ ok: true, text: "Deployed successfully" });
        setHostingInfo(d.deployment || d);
        setHostingFiles(null);
      } else {
        const d = await res.json();
        setDeployMsg({ text: d.error || "Failed to deploy" });
      }
    } catch {
      setDeployMsg({ text: "Network error" });
    }
    setDeploying(false);
  }

  async function handleRemoveHosting(projectId: string) {
    setDeploying(true);
    setDeployMsg(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/hosting`,
        { method: "DELETE", headers: authHeaders() }
      );
      if (res.ok) {
        setDeployMsg({ ok: true, text: "Hosting removed" });
        setHostingInfo(null);
      } else {
        const d = await res.json();
        setDeployMsg({ text: d.error || "Failed to remove hosting" });
      }
    } catch {
      setDeployMsg({ text: "Network error" });
    }
    setDeploying(false);
  }

  /* -- Undeploy --------------------------------------------- */

  async function handleUndeploy(projectId: string) {
    if (!confirm("Are you sure you want to undeploy this project? The app will stop and its URL will no longer work.")) return;
    setUndeploying(true);
    setUndeployMsg(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/undeploy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({}),
        }
      );
      if (res.ok) {
        setUndeployMsg({ ok: true, text: "Undeployed successfully" });
        setTimeout(fetchData, 500);
      } else {
        const d = await res.json();
        setUndeployMsg({ text: d.error || "Failed to undeploy" });
      }
    } catch {
      setUndeployMsg({ text: "Network error" });
    }
    setUndeploying(false);
  }

  /* -- P2P Deploy (Phase 87) -------------------------------- */

  async function handleP2PDeploy(projectId: string) {
    setP2pDeploying(true);
    setP2pDeployMsg(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/deploy`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({}),
        }
      );
      if (res.ok) {
        const d = await res.json();
        const url = d.deploymentUrl || d.url || "";
        setP2pDeployMsg({
          ok: true,
          text: url ? `Deployed: ${url}` : "Deployed successfully",
        });
        setTimeout(fetchData, 1000);
      } else {
        const d = await res.json();
        setP2pDeployMsg({ text: d.error || "Deploy failed" });
      }
    } catch {
      setP2pDeployMsg({ text: "Network error" });
    }
    setP2pDeploying(false);
  }

  /* -- Render ----------------------------------------------- */

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-neutral-950">
        <NavBar />
        <main className="max-w-5xl mx-auto p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-neutral-200 dark:bg-neutral-800 rounded w-1/3" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((n) => (
                <div
                  key={n}
                  className="h-20 bg-neutral-200 dark:bg-neutral-800 rounded-xl"
                />
              ))}
            </div>
            <div className="h-32 bg-neutral-200 dark:bg-neutral-800 rounded-xl" />
            <div className="h-32 bg-neutral-200 dark:bg-neutral-800 rounded-xl" />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
              Projects
            </h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
              Manage your AI-powered projects, collaborators, and deployments.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {offline && (
              <span className="text-xs text-red-400 font-mono">
                Node offline
              </span>
            )}
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="text-xs px-3 py-1.5 rounded-lg bg-amber-500 text-black hover:bg-amber-600 transition font-medium"
            >
              {showCreateForm ? "Cancel" : "Create Project"}
            </button>
          </div>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="My Projects" value={tabCounts.mine} />
          <StatCard
            label="Active"
            value={stats.activeProjects}
            accent="text-green-400"
          />
          <StatCard
            label="Shared With Me"
            value={stats.sharedWithMe}
            accent="text-blue-400"
          />
          <StatCard
            label="Public"
            value={stats.publicProjects}
            accent="text-amber-400"
          />
        </div>

        {/* Create project form */}
        {showCreateForm && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4 space-y-3">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Create Project
            </h2>
            <form onSubmit={handleCreate} className="space-y-3">
              <input
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Project name"
                className="w-full bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
              />
              <textarea
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                placeholder="Description"
                rows={3}
                className="w-full bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 resize-none"
              />
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Type</label>
                  <select
                    value={formType}
                    onChange={(e) => setFormType(e.target.value)}
                    className="bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  >
                    <option value="private">Private</option>
                    <option value="shared">Shared</option>
                    <option value="public">Public</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Visibility</label>
                  <select
                    value={formVisibility}
                    onChange={(e) => setFormVisibility(e.target.value)}
                    className="bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  >
                    <option value="owner_only">Owner Only</option>
                    <option value="collaborators">Collaborators</option>
                    <option value="listed">Listed</option>
                    <option value="featured">Featured</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Budget Limit (Lux)</label>
                  <input
                    type="number"
                    value={formBudgetLimit}
                    onChange={(e) => setFormBudgetLimit(Number(e.target.value))}
                    min={0}
                    className="w-28 bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                  />
                </div>
                <div className="flex flex-col gap-1 justify-end">
                  <label className="text-[10px] text-transparent">_</label>
                  <button
                    type="submit"
                    disabled={submitting || !formName.trim()}
                    className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-4 py-2 text-sm transition"
                  >
                    {submitting ? "Creating..." : "Create"}
                  </button>
                </div>
                {submitMsg && (
                  <span
                    className={`text-xs self-end pb-2 ${submitMsg.ok ? "text-green-400" : "text-red-400"}`}
                  >
                    {submitMsg.text}
                  </span>
                )}
              </div>
            </form>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-1">
          {([
            { key: "mine" as TabKey, label: "My Projects", count: tabCounts.mine },
            { key: "shared" as TabKey, label: "Shared With Me", count: tabCounts.shared },
            { key: "public" as TabKey, label: "Public", count: tabCounts.public },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 text-xs font-medium py-2 px-3 rounded-lg transition ${
                activeTab === tab.key
                  ? "bg-amber-500 text-black"
                  : "text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800/50"
              }`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className={`ml-1.5 text-[10px] ${activeTab === tab.key ? "text-black/60" : "text-neutral-600"}`}>
                  ({tab.count})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Project list */}
        {filteredProjects.length === 0 ? (
          <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-12 text-center">
            <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-neutral-400"
              >
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
              {activeTab === "mine" ? "No projects yet" : activeTab === "shared" ? "No shared projects" : "No public projects"}
            </p>
            <p className="text-xs text-neutral-500 mt-1 max-w-sm mx-auto">
              {activeTab === "mine"
                ? "Start a conversation to create one, or click Create Project."
                : activeTab === "shared"
                  ? "Projects shared with you will appear here."
                  : "Public projects on the network will appear here."}
            </p>
            {activeTab === "mine" && (
              <a
                href="/chat"
                className="inline-block mt-4 text-sm text-amber-500 hover:text-amber-400 transition"
              >
                Open Chat
              </a>
            )}
          </div>
        ) : (
          <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                {activeTab === "mine" ? "My Projects" : activeTab === "shared" ? "Shared With Me" : "Public Projects"}
              </h2>
              <span className="text-[10px] text-neutral-500 font-mono">
                {filteredProjects.length} project{filteredProjects.length !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {filteredProjects.map((project) => {
                const myRole = getMyRole(project);
                const isOwner = myRole === "owner";

                return (
                  <div key={project.id}>
                    {/* Project row */}
                    <button
                      onClick={() => toggleExpand(project.id)}
                      className="w-full px-4 py-3 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Role badge */}
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${roleBadgeCls(myRole)}`}
                        >
                          {myRole}
                        </span>

                        {/* Type badge */}
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${typeBadgeCls(project.type)}`}
                        >
                          {project.type}
                        </span>

                        {/* Status badge */}
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${statusBadgeCls(project.status)}`}
                        >
                          {project.status}
                        </span>

                        {/* Deployment badge */}
                        {project.deploymentStatus &&
                          project.deploymentStatus !== "none" && (
                            <DeploymentBadge
                              status={project.deploymentStatus}
                              url={project.deploymentUrl}
                            />
                          )}

                        {/* Project name */}
                        <span className="text-sm text-neutral-800 dark:text-neutral-200 font-semibold flex-1 min-w-0 truncate">
                          {project.name}
                        </span>

                        {/* Right side metadata */}
                        <div className="flex items-center gap-3 flex-shrink-0">
                          {/* Budget */}
                          <span className="text-[10px] font-mono text-neutral-500">
                            {(project.budgetSpent || 0).toFixed(1)}/
                            {(project.budgetLimit || 0).toFixed(0)}{" "}
                            <span className="text-amber-400">Lux</span>
                          </span>

                          {/* Created */}
                          <span className="text-[10px] text-neutral-500">
                            {relTime(project.createdAt)}
                          </span>

                          {/* Expand indicator */}
                          <span className="text-neutral-500 text-[10px]">
                            {expanded === project.id ? "\u25B2" : "\u25BC"}
                          </span>
                        </div>
                      </div>
                    </button>

                    {/* Expanded detail */}
                    {expanded === project.id && (
                      <div className="px-4 pb-4 bg-neutral-100/50 dark:bg-neutral-800/30 border-t border-neutral-300 dark:border-neutral-800 space-y-4 py-3">
                        {/* Description */}
                        {project.description && (
                          <p className="text-sm text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap">
                            {project.description}
                          </p>
                        )}

                        {/* Meta row */}
                        <div className="flex flex-wrap gap-4 text-xs text-neutral-500">
                          <span>
                            Owner:{" "}
                            <span className="font-mono text-neutral-400">
                              {shortId(project.ownerId)}
                            </span>
                          </span>
                          <span>
                            Visibility:{" "}
                            <span className="text-neutral-400">
                              {project.visibility?.replace(/_/g, " ") || "--"}
                            </span>
                          </span>
                          <span>
                            Revenue:{" "}
                            <span className="text-neutral-400">
                              {revenueLabel(project.revenueModel)}
                            </span>
                          </span>
                          {project.updatedAt && (
                            <span>Updated: {relTime(project.updatedAt)}</span>
                          )}
                        </div>

                        {/* Budget bar */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-neutral-500">Budget</span>
                            <span className="font-mono text-neutral-400">
                              {(project.budgetSpent || 0).toFixed(1)} /{" "}
                              {(project.budgetLimit || 0).toFixed(0)} Lux
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-neutral-300 dark:bg-neutral-700 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                project.budgetLimit > 0 &&
                                project.budgetSpent / project.budgetLimit > 0.9
                                  ? "bg-red-500"
                                  : project.budgetLimit > 0 &&
                                      project.budgetSpent /
                                        project.budgetLimit >
                                        0.7
                                    ? "bg-yellow-500"
                                    : "bg-amber-500"
                              }`}
                              style={{
                                width: `${project.budgetLimit > 0 ? Math.min(100, (project.budgetSpent / project.budgetLimit) * 100) : 0}%`,
                              }}
                            />
                          </div>
                        </div>

                        {/* Thread link */}
                        {project.threadId && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-neutral-500">
                              Thread:
                            </span>
                            <a
                              href={`/chat?thread=${encodeURIComponent(project.threadId)}`}
                              className="text-xs text-amber-500 hover:text-amber-400 transition font-mono"
                            >
                              {shortId(project.threadId)}
                            </a>
                          </div>
                        )}

                        {/* Manager agent */}
                        {project.managerAgentId && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-neutral-500">
                              Manager Agent:
                            </span>
                            <span className="text-xs text-neutral-400 font-mono">
                              {shortId(project.managerAgentId)}
                            </span>
                          </div>
                        )}

                        {/* GitHub repo */}
                        {project.repoUrl && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-neutral-500">
                              Repo:
                            </span>
                            <a
                              href={project.repoUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-400 hover:text-blue-300 transition underline font-mono truncate max-w-xs"
                            >
                              {project.githubRepo || project.repoUrl}
                            </a>
                            {project.tier && (
                              <span className="text-[10px] text-neutral-500 font-mono">
                                Tier {project.tier}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Deployment info */}
                        {project.deploymentUrl && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-neutral-500">
                              Deployment:
                            </span>
                            <a
                              href={project.deploymentUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-400 hover:text-blue-300 transition underline"
                            >
                              {project.deploymentUrl}
                            </a>
                            {project.deploymentType && (
                              <span className="text-[10px] text-neutral-500 font-mono">
                                ({project.deploymentType})
                              </span>
                            )}
                          </div>
                        )}

                        {/* Collaborators */}
                        <div className="border-t border-neutral-300 dark:border-neutral-800 pt-3 space-y-2">
                          <h3 className="text-xs text-neutral-500 font-medium">
                            Collaborators
                          </h3>
                          {collaborators.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {collaborators.map((c, i) => (
                                <span
                                  key={i}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${
                                    c.role === "owner"
                                      ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                                      : c.role === "collaborator"
                                        ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                        : c.role === "qa_lead"
                                          ? "bg-green-500/15 text-green-600 dark:text-green-400"
                                          : "bg-neutral-500/15 text-neutral-600 dark:text-neutral-400"
                                  }`}
                                >
                                  {shortId(c.userId)}
                                  <span className="opacity-60">{c.role}</span>
                                  {isOwner && c.role !== "owner" && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleRemoveCollaborator(project.id, c.userId);
                                      }}
                                      className="ml-1 text-red-400 hover:text-red-300 transition"
                                      title="Remove collaborator"
                                    >
                                      x
                                    </button>
                                  )}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-neutral-500">
                              No collaborators
                            </p>
                          )}
                        </div>

                        {/* Owner-only: Settings section */}
                        {isOwner && (
                          <div className="border-t border-neutral-300 dark:border-neutral-800 pt-3">
                            <button
                              onClick={() => setShowSettings(!showSettings)}
                              className="text-xs font-medium text-neutral-400 hover:text-neutral-300 transition flex items-center gap-1"
                            >
                              <span>{showSettings ? "\u25B2" : "\u25BC"}</span>
                              Settings
                            </button>
                            {showSettings && (
                              <div className="mt-3 space-y-3 bg-neutral-200/50 dark:bg-neutral-900/50 rounded-lg p-3 border border-neutral-300 dark:border-neutral-700">
                                <div className="flex flex-col gap-1">
                                  <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Name</label>
                                  <input
                                    type="text"
                                    value={settingsName}
                                    onChange={(e) => setSettingsName(e.target.value)}
                                    className="bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                  />
                                </div>
                                <div className="flex flex-col gap-1">
                                  <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Description</label>
                                  <textarea
                                    value={settingsDesc}
                                    onChange={(e) => setSettingsDesc(e.target.value)}
                                    rows={2}
                                    className="bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50 resize-none"
                                  />
                                </div>
                                <div className="flex flex-wrap gap-3">
                                  <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Type</label>
                                    <select
                                      value={settingsType}
                                      onChange={(e) => setSettingsType(e.target.value)}
                                      className="bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                    >
                                      <option value="private">Private</option>
                                      <option value="shared">Shared</option>
                                      <option value="public">Public</option>
                                    </select>
                                  </div>
                                  <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Visibility</label>
                                    <select
                                      value={settingsVisibility}
                                      onChange={(e) => setSettingsVisibility(e.target.value)}
                                      className="bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                    >
                                      <option value="owner_only">Owner Only</option>
                                      <option value="collaborators">Collaborators</option>
                                      <option value="listed">Listed</option>
                                      <option value="featured">Featured</option>
                                    </select>
                                  </div>
                                  <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Budget Limit</label>
                                    <input
                                      type="number"
                                      value={settingsBudgetLimit}
                                      onChange={(e) => setSettingsBudgetLimit(Number(e.target.value))}
                                      min={0}
                                      className="w-28 bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                    />
                                  </div>
                                  <div className="flex flex-col gap-1">
                                    <label className="text-[10px] text-neutral-500 uppercase tracking-wider">Deploy Tier</label>
                                    <select
                                      value={settingsTier}
                                      onChange={(e) => setSettingsTier(Number(e.target.value))}
                                      className="bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                    >
                                      <option value={1}>Tier 1 (Static)</option>
                                      <option value={2}>Tier 2 (Server)</option>
                                    </select>
                                  </div>
                                </div>
                                <div className="flex flex-col gap-1">
                                  <label className="text-[10px] text-neutral-500 uppercase tracking-wider">
                                    GitHub Repo URL{" "}
                                    <span className="normal-case opacity-60">(enables Deploy button)</span>
                                  </label>
                                  <input
                                    type="url"
                                    value={settingsRepoUrl}
                                    onChange={(e) => setSettingsRepoUrl(e.target.value)}
                                    placeholder="https://github.com/pando-lux/my-app"
                                    className="bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 font-mono"
                                  />
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => handleSaveSettings(project.id)}
                                    disabled={settingsSaving}
                                    className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-3 py-1.5 text-xs transition"
                                  >
                                    {settingsSaving ? "Saving..." : "Save Changes"}
                                  </button>
                                  {settingsMsg && (
                                    <span className={`text-xs ${settingsMsg.ok ? "text-green-400" : "text-red-400"}`}>
                                      {settingsMsg.text}
                                    </span>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Owner-only: Invite / add collaborator section */}
                        {isOwner && (
                          <div className="border-t border-neutral-300 dark:border-neutral-800 pt-3">
                            <button
                              onClick={() => setShowInvite(!showInvite)}
                              className="text-xs font-medium text-neutral-400 hover:text-neutral-300 transition flex items-center gap-1"
                            >
                              <span>{showInvite ? "\u25B2" : "\u25BC"}</span>
                              Invite / Add Collaborator
                            </button>
                            {showInvite && (
                              <div className="mt-3 space-y-3 bg-neutral-200/50 dark:bg-neutral-900/50 rounded-lg p-3 border border-neutral-300 dark:border-neutral-700">
                                {/* Add collaborator form */}
                                <div className="space-y-2">
                                  <h4 className="text-[10px] text-neutral-500 uppercase tracking-wider font-medium">
                                    Add by Peer ID
                                  </h4>
                                  <div className="flex flex-wrap items-end gap-2">
                                    <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
                                      <input
                                        type="text"
                                        value={invitePeerId}
                                        onChange={(e) => setInvitePeerId(e.target.value)}
                                        placeholder="Peer ID or username"
                                        className="bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                      />
                                    </div>
                                    <select
                                      value={inviteRole}
                                      onChange={(e) => setInviteRole(e.target.value)}
                                      className="bg-neutral-100 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-1.5 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                                    >
                                      <option value="collaborator">Collaborator</option>
                                      <option value="viewer">Viewer</option>
                                      <option value="qa_lead">QA Lead</option>
                                    </select>
                                    <button
                                      onClick={() => handleAddCollaborator(project.id)}
                                      disabled={inviteAdding || !invitePeerId.trim()}
                                      className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-3 py-1.5 text-xs transition"
                                    >
                                      {inviteAdding ? "Adding..." : "Add"}
                                    </button>
                                  </div>
                                  {inviteMsg && (
                                    <span className={`text-xs ${inviteMsg.ok ? "text-green-400" : "text-red-400"}`}>
                                      {inviteMsg.text}
                                    </span>
                                  )}
                                </div>

                                {/* Generate invite link */}
                                <div className="border-t border-neutral-300 dark:border-neutral-700 pt-2 space-y-2">
                                  <h4 className="text-[10px] text-neutral-500 uppercase tracking-wider font-medium">
                                    Invite Link
                                  </h4>
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => handleGenerateInvite(project.id)}
                                      disabled={inviteGenerating}
                                      className="bg-neutral-300 dark:bg-neutral-700 hover:bg-neutral-400 dark:hover:bg-neutral-600 disabled:opacity-50 text-neutral-800 dark:text-neutral-200 font-medium rounded-lg px-3 py-1.5 text-xs transition"
                                    >
                                      {inviteGenerating ? "Generating..." : "Generate Invite Code"}
                                    </button>
                                  </div>
                                  {inviteCode && (
                                    <div className="bg-neutral-100 dark:bg-neutral-800 rounded-lg px-3 py-2 font-mono text-xs text-neutral-700 dark:text-neutral-300 break-all border border-neutral-300 dark:border-neutral-700">
                                      {inviteCode}
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Owner-only: Hosting section */}
                        {isOwner && (
                          <div className="border-t border-neutral-300 dark:border-neutral-800 pt-3">
                            <button
                              onClick={() => {
                                const next = !showHosting;
                                setShowHosting(next);
                                if (next && !hostingInfo) fetchHostingInfo(project.id);
                              }}
                              className="text-xs font-medium text-neutral-400 hover:text-neutral-300 transition flex items-center gap-1"
                            >
                              <span>{showHosting ? "\u25B2" : "\u25BC"}</span>
                              Hosting
                            </button>
                            {showHosting && (
                              <div className="mt-3 space-y-3 bg-neutral-200/50 dark:bg-neutral-900/50 rounded-lg p-3 border border-neutral-300 dark:border-neutral-700">
                                {hostingLoading ? (
                                  <p className="text-xs text-neutral-500">Loading hosting info...</p>
                                ) : hostingInfo?.url ? (
                                  /* Deployed state */
                                  <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border bg-green-500/20 text-green-400 border-green-500/30">
                                        live
                                      </span>
                                      <a
                                        href={hostingInfo.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-blue-400 hover:text-blue-300 transition underline break-all"
                                      >
                                        {hostingInfo.url}
                                      </a>
                                    </div>
                                    <div className="flex flex-wrap gap-4 text-xs text-neutral-500">
                                      {hostingInfo.fileCount != null && (
                                        <span>
                                          Files: <span className="text-neutral-400 font-mono">{hostingInfo.fileCount}</span>
                                        </span>
                                      )}
                                      {hostingInfo.totalSize != null && (
                                        <span>
                                          Size: <span className="text-neutral-400 font-mono">{(hostingInfo.totalSize / 1024).toFixed(1)} KB</span>
                                        </span>
                                      )}
                                      {hostingInfo.deployedAt && (
                                        <span>
                                          Deployed: <span className="text-neutral-400">{relTime(hostingInfo.deployedAt)}</span>
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2 pt-1">
                                      <button
                                        onClick={() => handleRemoveHosting(project.id)}
                                        disabled={deploying}
                                        className="bg-red-500/20 hover:bg-red-500/30 disabled:opacity-50 text-red-400 font-medium rounded-lg px-3 py-1.5 text-xs transition border border-red-500/30"
                                      >
                                        {deploying ? "Removing..." : "Remove Hosting"}
                                      </button>
                                      {deployMsg && (
                                        <span className={`text-xs ${deployMsg.ok ? "text-green-400" : "text-red-400"}`}>
                                          {deployMsg.text}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  /* Not deployed state */
                                  <div className="space-y-2">
                                    <p className="text-xs text-neutral-500">
                                      No hosting deployment. Upload files to deploy.
                                    </p>
                                    <div className="flex flex-col gap-2">
                                      <input
                                        type="file"
                                        multiple
                                        onChange={(e) => setHostingFiles(e.target.files)}
                                        className="text-xs text-neutral-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-neutral-300 dark:file:bg-neutral-700 file:text-neutral-800 dark:file:text-neutral-200 hover:file:bg-neutral-400 dark:hover:file:bg-neutral-600 file:cursor-pointer file:transition"
                                      />
                                      {hostingFiles && hostingFiles.length > 0 && (
                                        <p className="text-[10px] text-neutral-500">
                                          {hostingFiles.length} file{hostingFiles.length !== 1 ? "s" : ""} selected
                                        </p>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <button
                                        onClick={() => handleDeploy(project.id)}
                                        disabled={deploying || !hostingFiles || hostingFiles.length === 0}
                                        className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-3 py-1.5 text-xs transition"
                                      >
                                        {deploying ? "Deploying..." : "Deploy"}
                                      </button>
                                      {deployMsg && (
                                        <span className={`text-xs ${deployMsg.ok ? "text-green-400" : "text-red-400"}`}>
                                          {deployMsg.text}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-2 pt-1">
                          {project.threadId && (myRole === "owner" || myRole === "collaborator" || myRole === "qa_lead") ? (
                            <a
                              href={`/chat?thread=${encodeURIComponent(project.threadId)}`}
                              className="text-xs px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition font-medium border border-amber-500/20"
                            >
                              Open Chat
                            </a>
                          ) : project.threadId && myRole === "viewer" ? (
                            <span className="text-xs px-2.5 py-1 rounded-lg bg-neutral-500/10 text-neutral-500 border border-neutral-500/20 cursor-not-allowed">
                              Chat (view only)
                            </span>
                          ) : !project.threadId && (myRole === "owner" || myRole === "collaborator" || myRole === "qa_lead") ? (
                            <a
                              href={`/chat?projectId=${encodeURIComponent(project.id)}`}
                              className="text-xs px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition font-medium border border-amber-500/20"
                            >
                              Open Chat
                            </a>
                          ) : null}
                          {project.deploymentUrl &&
                            project.deploymentStatus === "live" && (
                              <>
                                <a
                                  href={project.deploymentUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs px-2.5 py-1 rounded-lg bg-green-500/10 text-green-400 hover:bg-green-500/20 transition font-medium border border-green-500/20"
                                >
                                  View Deployment
                                </a>
                                {isOwner && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleUndeploy(project.id);
                                    }}
                                    disabled={undeploying}
                                    className="text-xs px-2.5 py-1 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition font-medium border border-red-500/20 disabled:opacity-50"
                                  >
                                    {undeploying ? "Undeploying..." : "Undeploy"}
                                  </button>
                                )}
                              </>
                            )}
                          {undeployMsg && (
                            <span className={`text-xs ${undeployMsg.ok ? "text-green-400" : "text-red-400"}`}>
                              {undeployMsg.text}
                            </span>
                          )}
                          {/* P2P Deploy button — owner only, calls Phase 87 endpoint */}
                          {isOwner && project.repoUrl && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleP2PDeploy(project.id);
                              }}
                              disabled={p2pDeploying}
                              className="text-xs px-2.5 py-1 rounded-lg bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 transition font-medium border border-violet-500/20 disabled:opacity-50"
                            >
                              {p2pDeploying
                                ? "Deploying..."
                                : project.deploymentStatus === "live"
                                  ? "Redeploy"
                                  : "Deploy"}
                            </button>
                          )}
                          {p2pDeployMsg && (
                            <span className={`text-xs ${p2pDeployMsg.ok ? "text-green-400" : "text-red-400"}`}>
                              {p2pDeployMsg.text}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

/* -- Stat Card Component ------------------------------------ */

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value?: number | string;
  accent?: string;
}) {
  return (
    <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
      <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">
        {label}
      </p>
      <p
        className={`text-lg font-mono font-bold ${accent || "text-neutral-800 dark:text-neutral-200"}`}
      >
        {value ?? "--"}
      </p>
    </div>
  );
}

/* -- Deployment Badge Component ----------------------------- */

function DeploymentBadge({
  status,
  url,
}: {
  status: string;
  url?: string;
}) {
  const cls = deployBadgeCls(status);
  if (!cls) return null;

  if (status === "live" && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${cls} hover:opacity-80 transition`}
        onClick={(e) => e.stopPropagation()}
      >
        {status}
      </a>
    );
  }

  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${cls}`}
    >
      {status}
    </span>
  );
}
