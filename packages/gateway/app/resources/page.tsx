"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";
import { useAuth } from "@/lib/auth-context";

/* -- Types ------------------------------------------------- */

interface HealthResult {
  resourceId: string;
  type: string;
  status: "healthy" | "degraded" | "unhealthy" | "unchecked";
  latencyMs?: number;
  checkedAt?: number;
  error?: string;
}

interface Resource {
  resourceId: string;
  type: string;
  providerPeerId: string;
  userId?: string;
  grantedTo?: string | null;
  maxUsagePerDay?: number | null;
  pricePerUnit?: number | null;
  registeredAt: number;
  expiresAt?: number | null;
  status: string;
  metadata?: Record<string, any>;
}

interface CapabilityNode {
  peerId: string;
  linkedUser?: { username: string } | null;
  capabilities: Record<string, boolean>;
  updatedAt: number;
  details?: {
    compute_cpu?: { claudeCode: boolean; maxConcurrent: number; os: string };
    compute_gpu?: { gpuModel?: string; vramMb?: number };
    storage?: { availableMb: number };
    httpApi?: { host: string; port: number; https: boolean };
  };
}

/* -- Service Presets --------------------------------------- */

interface ServiceField {
  key: string;
  label: string;
  placeholder: string;
}

interface ServicePreset {
  label: string;
  type: string | null;
  metadata: Record<string, any>;
  fields: ServiceField[];
}

const SERVICE_PRESETS: ServicePreset[] = [
  {
    label: "OpenAI",
    type: "ai_api_key",
    metadata: { provider: "openai", service: "OpenAI" },
    fields: [{ key: "apiKey", label: "API Key", placeholder: "sk-..." }],
  },
  {
    label: "Anthropic",
    type: "ai_api_key",
    metadata: { provider: "anthropic", service: "Anthropic" },
    fields: [{ key: "apiKey", label: "API Key", placeholder: "sk-ant-..." }],
  },
  {
    label: "Google Gemini",
    type: "ai_api_key",
    metadata: { provider: "gemini", service: "Google Gemini" },
    fields: [{ key: "apiKey", label: "API Key", placeholder: "AIza..." }],
  },
  {
    label: "MongoDB",
    type: "storage_db",
    metadata: { provider: "mongodb", service: "MongoDB" },
    fields: [
      {
        key: "connectionString",
        label: "Connection String",
        placeholder: "mongodb+srv://...",
      },
    ],
  },
  {
    label: "AWS S3",
    type: "storage_blob",
    metadata: { provider: "aws", service: "AWS S3" },
    fields: [
      {
        key: "accessKeyId",
        label: "Access Key ID",
        placeholder: "AKIA...",
      },
      {
        key: "secretAccessKey",
        label: "Secret Access Key",
        placeholder: "wJal...",
      },
    ],
  },
  {
    label: "GitHub",
    type: "code_repository",
    metadata: { provider: "github", service: "GitHub" },
    fields: [{ key: "token", label: "Personal Access Token", placeholder: "ghp_..." }],
  },
  {
    label: "AWS Compute (EC2/Lambda)",
    type: "cloud_compute",
    metadata: { provider: "aws", service: "AWS Compute" },
    fields: [
      {
        key: "accessKeyId",
        label: "Access Key ID",
        placeholder: "AKIA...",
      },
      {
        key: "secretAccessKey",
        label: "Secret Access Key",
        placeholder: "wJal...",
      },
    ],
  },
  {
    label: "Other",
    type: null,
    metadata: {},
    fields: [
      {
        key: "credential",
        label: "Key / Connection String",
        placeholder: "Paste your credential",
      },
    ],
  },
];

const OTHER_CATEGORIES = [
  { value: "ai_api_key", label: "AI Key" },
  { value: "storage_db", label: "Database" },
  { value: "storage_blob", label: "Storage" },
  { value: "cloud_compute", label: "Compute" },
  { value: "hosting_platform", label: "Hosting" },
  { value: "code_repository", label: "Code Repository" },
];

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

function statusBadgeCls(s: string): string {
  switch (s) {
    case "active":
      return "bg-green-500/20 text-green-400 border-green-500/30";
    case "revoked":
      return "bg-red-500/20 text-red-400 border-red-500/30";
    case "exhausted":
      return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    case "expired":
      return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
    default:
      return "bg-neutral-500/20 text-neutral-400 border-neutral-500/30";
  }
}

function typeBadgeCls(t: string): string {
  switch (t) {
    case "ai_api_key":
      return "bg-indigo-500/15 text-indigo-400 border-indigo-500/25";
    case "storage_db":
      return "bg-cyan-500/15 text-cyan-400 border-cyan-500/25";
    case "storage_blob":
      return "bg-teal-500/15 text-teal-400 border-teal-500/25";
    case "cloud_compute":
      return "bg-amber-500/15 text-amber-400 border-amber-500/25";
    case "hosting_platform":
      return "bg-purple-500/15 text-purple-400 border-purple-500/25";
    case "code_repository":
      return "bg-orange-500/15 text-orange-400 border-orange-500/25";
    default:
      return "bg-neutral-500/15 text-neutral-400 border-neutral-500/25";
  }
}

function typeLabel(t: string): string {
  return t.replace(/_/g, " ");
}

/** Display name for a resource: prefer metadata.service, fall back to type */
function resourceDisplayName(r: Resource): string {
  return r.metadata?.service || typeLabel(r.type);
}

/* -- Main Page ---------------------------------------------- */

export default function ResourcesPage() {
  const { user, token, isClaimed, loading: authLoading } = useAuth();
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [localNodePeerId, setLocalNodePeerId] = useState<string>("");

  // Multi-node capabilities
  const [myNodes, setMyNodes] = useState<CapabilityNode[]>([]);
  const [myNodesLoading, setMyNodesLoading] = useState(true);

  // Contribute form state
  const [formOpen, setFormOpen] = useState(false);
  const [formServiceIdx, setFormServiceIdx] = useState(0);
  const [formFields, setFormFields] = useState<Record<string, string>>({});
  const [formLabel, setFormLabel] = useState("");
  // "Other" specific
  const [formOtherCategory, setFormOtherCategory] = useState("ai_api_key");
  const [formOtherServiceName, setFormOtherServiceName] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{
    ok?: boolean;
    text: string;
  } | null>(null);

  // Revoke feedback
  const [revokeMsg, setRevokeMsg] = useState<
    Record<string, { ok?: boolean; text: string }>
  >({});

  // Link-to-account feedback
  const [linkMsg, setLinkMsg] = useState<
    Record<string, { ok?: boolean; text: string }>
  >({});

  // Show revoked resources toggle (Network Resources section)
  const [showRevoked, setShowRevoked] = useState(false);

  // Phase 53.8: Resource health check results
  const [healthResults, setHealthResults] = useState<Map<string, HealthResult>>(new Map());
  const [healthAvailable, setHealthAvailable] = useState(false);

  const myUserId = user?.peerId || "";
  const selectedPreset = SERVICE_PRESETS[formServiceIdx];
  const isOther = selectedPreset.type === null;

  /* -- Data fetching ---------------------------------------- */

  const fetchResources = useCallback(async () => {
    try {
      const res = await fetch("/api/resources");
      if (res.ok) {
        const data = await res.json();
        setResources(data.resources || []);
        setError(null);
      } else {
        setError("Failed to load resources");
      }
    } catch {
      setError("Node not reachable");
    }
    setLoading(false);
  }, []);

  const fetchPeers = useCallback(async () => {
    try {
      const res = await fetch("/api/peers");
      if (res.ok) {
        const data = await res.json();
        const peerIds = (data.peers || []).map((p: any) => p.peerId);
        setConnectedPeers(peerIds);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const fetchNodeStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/status");
      if (res.ok) {
        const data = await res.json();
        if (data.identity) setLocalNodePeerId(data.identity);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const fetchMyNodes = useCallback(async () => {
    if (!user?.username || !isClaimed) {
      setMyNodes([]);
      setMyNodesLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/capabilities/network/user/${encodeURIComponent(user.username)}`);
      if (res.ok) {
        const data = await res.json();
        setMyNodes(data.profiles || []);
      }
    } catch { /* ignore */ }
    setMyNodesLoading(false);
  }, [user?.username, isClaimed]);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/resources/health");
      if (res.ok) {
        const data = await res.json();
        if (data.available && Array.isArray(data.results)) {
          const map = new Map<string, HealthResult>();
          for (const r of data.results) map.set(r.resourceId, r);
          setHealthResults(map);
          setHealthAvailable(true);
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchResources();
    fetchPeers();
    fetchNodeStatus();
    fetchMyNodes();
    fetchHealth();
    const i = setInterval(() => {
      fetchResources();
      fetchNodeStatus();
      fetchMyNodes();
      fetchHealth();
    }, 10000);
    return () => clearInterval(i);
  }, [fetchResources, fetchPeers, fetchNodeStatus, fetchMyNodes, fetchHealth]);

  /* -- Actions ---------------------------------------------- */

  function handleServiceChange(idx: number) {
    setFormServiceIdx(idx);
    setFormFields({});
    setSubmitMsg(null);
  }

  async function handleContribute(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitMsg(null);

    const preset = SERVICE_PRESETS[formServiceIdx];

    // Build credential
    let credential: string;
    if (preset.fields.length === 0) {
      // No credential fields — node will verify locally (e.g. Claude Code)
      credential = "verify";
    } else if (preset.fields.length === 1) {
      credential = (formFields[preset.fields[0].key] || "").trim();
    } else {
      // Multi-field: JSON-encode all field values
      const obj: Record<string, string> = {};
      for (const f of preset.fields) {
        obj[f.key] = (formFields[f.key] || "").trim();
      }
      credential = JSON.stringify(obj);
    }

    if (!credential) {
      setSubmitMsg({ text: "Please fill in the credential field(s)" });
      setSubmitting(false);
      return;
    }

    // Determine type
    let type: string;
    if (preset.type) {
      type = preset.type;
    } else {
      // "Other" — use selected category
      type = formOtherCategory;
    }

    // Build metadata
    const metadata: Record<string, any> = { ...preset.metadata };
    if (isOther && formOtherServiceName.trim()) {
      metadata.service = formOtherServiceName.trim();
    }
    if (formLabel.trim()) {
      metadata.label = formLabel.trim();
    }

    const body: Record<string, any> = {
      type,
      credential,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["X-User-Token"] = token;
      const res = await fetch("/api/resources", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setSubmitMsg({ ok: true, text: "Resource contributed successfully" });
        setFormFields({});
        setFormLabel("");
        setFormOtherServiceName("");
        setTimeout(fetchResources, 500);
      } else {
        setSubmitMsg({ text: data.error || "Registration failed" });
      }
    } catch {
      setSubmitMsg({ text: "Network error" });
    }
    setSubmitting(false);
  }

  async function handleRevoke(resourceId: string) {
    setRevokeMsg((prev) => ({
      ...prev,
      [resourceId]: { text: "Revoking..." },
    }));
    try {
      const headers: Record<string, string> = {};
      if (token) headers["X-User-Token"] = token;
      const res = await fetch(`/api/resources/${resourceId}`, {
        method: "DELETE",
        headers,
      });
      const data = await res.json();
      if (res.ok) {
        setRevokeMsg((prev) => ({
          ...prev,
          [resourceId]: { ok: true, text: "Revoked" },
        }));
        setTimeout(fetchResources, 500);
      } else {
        setRevokeMsg((prev) => ({
          ...prev,
          [resourceId]: { text: data.error || "Revoke failed" },
        }));
      }
    } catch {
      setRevokeMsg((prev) => ({
        ...prev,
        [resourceId]: { text: "Network error" },
      }));
    }
  }

  async function handleLinkToAccount(resourceId: string) {
    if (!token) return;
    setLinkMsg((prev) => ({
      ...prev,
      [resourceId]: { text: "Linking..." },
    }));
    try {
      const res = await fetch(`/api/resources/${resourceId}/owner`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-User-Token": token,
        },
      });
      const data = await res.json();
      if (res.ok) {
        setLinkMsg((prev) => ({
          ...prev,
          [resourceId]: { ok: true, text: "Linked to your account" },
        }));
        setTimeout(fetchResources, 500);
      } else {
        setLinkMsg((prev) => ({
          ...prev,
          [resourceId]: { text: data.error || "Link failed" },
        }));
      }
    } catch {
      setLinkMsg((prev) => ({
        ...prev,
        [resourceId]: { text: "Network error" },
      }));
    }
  }

  /* -- Check if submit is disabled -------------------------- */

  const hasRequiredFields = (() => {
    for (const f of selectedPreset.fields) {
      if (!(formFields[f.key] || "").trim()) return false;
    }
    return true;
  })();

  /* -- Stats ------------------------------------------------ */

  // Split resources into active and revoked for display
  const activeResources = resources.filter((r) => r.status === "active");
  const revokedResources = resources.filter((r) => r.status === "revoked");
  const activeCount = activeResources.length;
  const typeBreakdown: Record<string, number> = {};
  for (const r of activeResources) {
    typeBreakdown[r.type] = (typeBreakdown[r.type] || 0) + 1;
  }
  // Network Resources list: active only by default, all if toggled
  const networkResources = showRevoked ? resources : activeResources;

  // My resources
  const myResources = myUserId
    ? resources.filter((r) => r.userId === myUserId)
    : [];
  const myActiveCount = myResources.filter(
    (r) => r.status === "active"
  ).length;

  /* -- Render ----------------------------------------------- */

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Resources
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Contribute API keys, storage, compute, and hosting to the network.
          </p>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            label="Total Resources"
            value={loading ? "--" : activeCount}
          />
          <StatCard
            label="Active"
            value={loading ? "--" : activeCount}
            accent="text-green-400"
          />
          <StatCard
            label="Types"
            value={loading ? "--" : Object.keys(typeBreakdown).length}
            accent="text-indigo-400"
          />
          <StatCard
            label="My Nodes"
            value={myNodesLoading ? "--" : myNodes.length}
            accent="text-violet-400"
          />
        </div>

        {/* My Resources + My Nodes (logged in) or Login Prompt (guest) */}
        {authLoading ? (
          <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-6 space-y-4">
            <div className="h-5 w-32 rounded-md bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
            <div className="h-4 w-64 rounded-md bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
            <div className="h-4 w-48 rounded-md bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          </div>
        ) : isClaimed ? (
          <>
            {/* My Resources Section */}
            <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                  My Resources
                </h2>
                <span className="text-[10px] text-neutral-500 font-mono">
                  {myActiveCount} active / {myResources.length} total
                </span>
              </div>

              {loading ? (
                <div className="px-4 py-6 text-center text-sm text-neutral-500">
                  Loading...
                </div>
              ) : myResources.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-neutral-500">
                    You haven&apos;t contributed any resources. Use the TUI{" "}
                    <code className="text-xs bg-neutral-200 dark:bg-neutral-800 px-1.5 py-0.5 rounded font-mono">
                      /contribute
                    </code>{" "}
                    command or contribute below.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {myResources.map((r) => (
                    <div
                      key={r.resourceId}
                      className="px-4 py-3 hover:bg-neutral-100/50 dark:hover:bg-neutral-800/30 transition"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Service name */}
                        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                          {resourceDisplayName(r)}
                        </span>

                        {/* Type badge */}
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 ${typeBadgeCls(
                            r.type
                          )}`}
                        >
                          {typeLabel(r.type)}
                        </span>

                        {/* Status badge */}
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 ${statusBadgeCls(
                            r.status
                          )}`}
                        >
                          {r.status}
                        </span>

                        {/* Health badge (Phase 53.8 — only shown when checker is running on a compute node) */}
                        {healthAvailable && (() => {
                          const h = healthResults.get(r.resourceId);
                          if (!h || h.status === "unchecked") return null;
                          const cls = h.status === "healthy"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25"
                            : h.status === "degraded"
                              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25"
                              : "bg-red-500/10 text-red-500 dark:text-red-400 border-red-500/25";
                          const dot = h.status === "healthy" ? "bg-emerald-500" : h.status === "degraded" ? "bg-amber-500" : "bg-red-500";
                          return (
                            <span
                              title={h.error ? `Last error: ${h.error}` : h.latencyMs ? `${h.latencyMs}ms` : undefined}
                              className={`text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 flex items-center gap-1 ${cls}`}
                            >
                              <span className={`w-1 h-1 rounded-full ${dot}`} />
                              {h.status}
                            </span>
                          );
                        })()}

                        {/* Label */}
                        {r.metadata?.label && (
                          <span className="text-[10px] text-neutral-500 italic">
                            {r.metadata.label}
                          </span>
                        )}

                        <div className="flex-1" />

                        {/* Resource ID (masked) */}
                        <span
                          className="text-[10px] font-mono text-neutral-400"
                          title={r.resourceId}
                        >
                          {shortId(r.resourceId)}
                        </span>

                        {/* Time */}
                        <span className="text-[10px] text-neutral-500">
                          {relTime(r.registeredAt)}
                        </span>

                        {/* Revoke button */}
                        {r.status === "active" && (
                          <button
                            onClick={() => handleRevoke(r.resourceId)}
                            className="bg-red-500/15 hover:bg-red-500/25 text-red-500 dark:text-red-400 border border-red-500/25 rounded-lg px-2.5 py-1 text-[10px] font-medium transition"
                          >
                            Revoke
                          </button>
                        )}
                      </div>

                      {/* Revoke feedback */}
                      {revokeMsg[r.resourceId] && (
                        <p
                          className={`text-[10px] mt-1 ${
                            revokeMsg[r.resourceId].ok
                              ? "text-green-400"
                              : "text-red-400"
                          }`}
                        >
                          {revokeMsg[r.resourceId].text}
                        </p>
                      )}

                      {/* Details row */}
                      <div className="flex items-center gap-4 mt-1.5 text-[10px] text-neutral-500">
                        {r.maxUsagePerDay != null && (
                          <span>Max usage: {r.maxUsagePerDay}/day</span>
                        )}
                        {r.grantedTo && (
                          <span>
                            Granted to:{" "}
                            <span className="font-mono" title={r.grantedTo}>
                              {shortId(r.grantedTo)}
                            </span>
                          </span>
                        )}
                        {r.expiresAt && (
                          <span>
                            Expires:{" "}
                            {new Date(r.expiresAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* My Nodes Section */}
            <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                  My Nodes
                </h2>
                <span className="text-[10px] text-neutral-500 font-mono">
                  {myNodesLoading ? "--" : myNodes.length} node{myNodes.length !== 1 ? "s" : ""}
                </span>
              </div>

              {myNodesLoading ? (
                <div className="px-4 py-6 text-center text-sm text-neutral-500">
                  Loading...
                </div>
              ) : myNodes.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-neutral-500">
                    No nodes linked to your account. Use{" "}
                    <code className="text-xs bg-neutral-200 dark:bg-neutral-800 px-1.5 py-0.5 rounded font-mono">
                      /login
                    </code>{" "}
                    on your node to link it.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {myNodes.map((node) => {
                    const isLocal = node.peerId === localNodePeerId;
                    const os = node.details?.compute_cpu?.os;
                    const hasClaude = node.details?.compute_cpu?.claudeCode;
                    const capKeys = Object.entries(node.capabilities || {})
                      .filter(([, v]) => v)
                      .map(([k]) => k);
                    return (
                      <div
                        key={node.peerId}
                        className="px-4 py-3 hover:bg-neutral-100/50 dark:hover:bg-neutral-800/30 transition"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Green dot */}
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0 bg-green-400"
                            title="Online"
                          />
                          {/* Peer ID */}
                          <span
                            className="text-sm font-mono text-neutral-700 dark:text-neutral-300"
                            title={node.peerId}
                          >
                            {shortId(node.peerId)}
                          </span>
                          {/* Online badge */}
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 bg-green-500/20 text-green-400 border-green-500/30">
                            online
                          </span>
                          {/* This node badge */}
                          {isLocal && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 bg-amber-500/20 text-amber-400 border-amber-500/30">
                              this node
                            </span>
                          )}
                          {/* OS */}
                          {os && (
                            <span className="text-[10px] text-neutral-500">
                              {os}
                            </span>
                          )}
                          <div className="flex-1" />
                          {/* Last seen */}
                          <span className="text-[10px] text-neutral-500">
                            {relTime(node.updatedAt)}
                          </span>
                        </div>
                        {/* Capability tags */}
                        {(hasClaude || capKeys.length > 0) && (
                          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                            {hasClaude && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 bg-violet-500/20 text-violet-400 border-violet-500/30">
                                Claude Code
                              </span>
                            )}
                            {capKeys
                              .filter((k) => k !== "compute_cpu")
                              .map((cap) => (
                                <span
                                  key={cap}
                                  className="text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 bg-neutral-500/15 text-neutral-400 border-neutral-500/25"
                                >
                                  {cap.replace(/_/g, " ")}
                                </span>
                              ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-6 text-center">
            <p className="text-sm text-neutral-500 mb-3">
              Log in to see your contributed resources and linked nodes.
            </p>
            <div className="flex items-center justify-center gap-3">
              <a href="/login" className="text-sm px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-black font-medium transition">Login</a>
              <a href="/register" className="text-sm px-4 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition">Sign up</a>
            </div>
          </div>
        )}

        {/* Guide Banner */}
        <div className="bg-gradient-to-r from-amber-500/10 to-transparent border border-amber-500/20 rounded-xl px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            New to contributing?{" "}
            <a
              href="/resources/guide"
              className="text-amber-500 hover:text-amber-400 font-medium transition"
            >
              Follow our step-by-step guide &rarr;
            </a>
          </p>
        </div>

        {/* Contribute Form */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <button
            onClick={() => setFormOpen(!formOpen)}
            className="w-full px-4 py-3 text-left flex items-center justify-between hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50 transition"
          >
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
              Contribute a Resource
            </h2>
            <span className="text-neutral-500 text-sm">
              {formOpen ? "\u25B2" : "\u25BC"}
            </span>
          </button>
          {formOpen && !isClaimed && (
            <div className="px-4 pb-4 border-t border-neutral-300 dark:border-neutral-800 pt-4">
              <p className="text-sm text-neutral-500">
                You must be logged in to contribute resources.{" "}
                <a href="/login" className="text-amber-500 hover:text-amber-400 underline">
                  Log in or create an account
                </a>{" "}
                to get started.
              </p>
            </div>
          )}
          {formOpen && isClaimed && (
            <form
              onSubmit={handleContribute}
              className="px-4 pb-4 space-y-4 border-t border-neutral-300 dark:border-neutral-800 pt-4"
            >
              {/* Service selector */}
              <div>
                <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
                  Service
                </label>
                <select
                  value={formServiceIdx}
                  onChange={(e) => handleServiceChange(Number(e.target.value))}
                  className="w-full bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                >
                  {SERVICE_PRESETS.map((p, i) => (
                    <option key={p.label} value={i}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* "Other" — category + service name */}
              {isOther && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
                      Category
                    </label>
                    <select
                      value={formOtherCategory}
                      onChange={(e) => setFormOtherCategory(e.target.value)}
                      className="w-full bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                    >
                      {OTHER_CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
                      Service Name
                    </label>
                    <input
                      type="text"
                      value={formOtherServiceName}
                      onChange={(e) => setFormOtherServiceName(e.target.value)}
                      placeholder="e.g. Mistral, Supabase"
                      className="w-full bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                    />
                  </div>
                </div>
              )}

              {/* Dynamic credential fields */}
              {selectedPreset.fields.length === 0 ? (
                <div className="bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-3 text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">
                  Claude Code is verified directly on your node. No API key needed
                  — your node checks that Claude Code is installed and authenticated.
                </div>
              ) : (
                <>
                  {selectedPreset.fields.map((field) => (
                    <div key={field.key}>
                      <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
                        {field.label}
                      </label>
                      <input
                        type="password"
                        value={formFields[field.key] || ""}
                        onChange={(e) =>
                          setFormFields((prev) => ({
                            ...prev,
                            [field.key]: e.target.value,
                          }))
                        }
                        placeholder={field.placeholder}
                        className="w-full bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50 font-mono"
                      />
                    </div>
                  ))}
                  <p className="text-[10px] text-neutral-500 -mt-2">
                    Your credential is encrypted end-to-end before being stored on
                    the network.
                  </p>
                </>
              )}

              {/* Label (optional) */}
              <div>
                <label className="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">
                  Label (optional)
                </label>
                <input
                  type="text"
                  value={formLabel}
                  onChange={(e) => setFormLabel(e.target.value)}
                  placeholder='e.g. "my work key", "personal"'
                  className="w-64 bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                />
              </div>

              {/* Submit */}
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={submitting || !hasRequiredFields}
                  className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-4 py-2 text-sm transition"
                >
                  {submitting ? "Contributing..." : "Contribute Resource"}
                </button>
                {submitMsg && (
                  <span
                    className={`text-xs ${
                      submitMsg.ok ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    {submitMsg.text}
                  </span>
                )}
              </div>
            </form>
          )}
        </div>

        {/* Network Resource List */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
              Network Resources
            </h2>
            <span className="text-[10px] text-neutral-500 font-mono">
              {activeCount} active resource{activeCount !== 1 ? "s" : ""}
            </span>
          </div>

          {loading ? (
            <div className="px-4 py-8 text-center text-sm text-neutral-500">
              Loading resources...
            </div>
          ) : error ? (
            <div className="px-4 py-8 text-center text-sm text-red-400">
              {error}
            </div>
          ) : networkResources.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-neutral-500">
                No resources on the network yet. Be the first to contribute!
              </p>
            </div>
          ) : (
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {networkResources.map((r) => (
                <div
                  key={r.resourceId}
                  className="px-4 py-3 hover:bg-neutral-100/50 dark:hover:bg-neutral-800/30 transition"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* Service name */}
                    <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                      {resourceDisplayName(r)}
                    </span>

                    {/* Type badge */}
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 ${typeBadgeCls(
                        r.type
                      )}`}
                    >
                      {typeLabel(r.type)}
                    </span>

                    {/* Status badge */}
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-medium border flex-shrink-0 ${statusBadgeCls(
                        r.status
                      )}`}
                    >
                      {r.status}
                    </span>

                    {/* Label */}
                    {r.metadata?.label && (
                      <span className="text-[10px] text-neutral-500 italic">
                        {r.metadata.label}
                      </span>
                    )}

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Provider peerId */}
                    <span
                      className="text-[10px] font-mono text-neutral-400"
                      title={r.providerPeerId}
                    >
                      {shortId(r.providerPeerId)}
                    </span>

                    {/* Time */}
                    <span className="text-[10px] text-neutral-500">
                      {relTime(r.registeredAt)}
                    </span>

                    {/* Link to account button — only for claimed users, only for unowned resources from this node */}
                    {isClaimed &&
                      token &&
                      !r.userId &&
                      r.providerPeerId === localNodePeerId &&
                      r.status === "active" && (
                        <button
                          onClick={() => handleLinkToAccount(r.resourceId)}
                          className="bg-amber-500/15 hover:bg-amber-500/25 text-amber-500 dark:text-amber-400 border border-amber-500/25 rounded-lg px-2.5 py-1 text-[10px] font-medium transition"
                        >
                          Link to my account
                        </button>
                      )}

                    {/* Revoke button - only for logged-in owner */}
                    {isClaimed &&
                      r.userId === myUserId &&
                      r.status === "active" && (
                        <button
                          onClick={() => handleRevoke(r.resourceId)}
                          className="bg-red-500/15 hover:bg-red-500/25 text-red-500 dark:text-red-400 border border-red-500/25 rounded-lg px-2.5 py-1 text-[10px] font-medium transition"
                        >
                          Revoke
                        </button>
                      )}
                  </div>

                  {/* Link feedback */}
                  {linkMsg[r.resourceId] && (
                    <p
                      className={`text-[10px] mt-1 ${
                        linkMsg[r.resourceId].ok
                          ? "text-green-400"
                          : "text-red-400"
                      }`}
                    >
                      {linkMsg[r.resourceId].text}
                    </p>
                  )}

                  {/* Revoke feedback */}
                  {revokeMsg[r.resourceId] && (
                    <p
                      className={`text-[10px] mt-1 ${
                        revokeMsg[r.resourceId].ok
                          ? "text-green-400"
                          : "text-red-400"
                      }`}
                    >
                      {revokeMsg[r.resourceId].text}
                    </p>
                  )}

                  {/* Second row: additional details */}
                  <div className="flex items-center gap-4 mt-1.5 text-[10px] text-neutral-500">
                    <span className="font-mono" title={r.resourceId}>
                      ID: {shortId(r.resourceId)}
                    </span>
                    {r.maxUsagePerDay != null && (
                      <span>Max usage: {r.maxUsagePerDay}/day</span>
                    )}
                    {r.grantedTo && (
                      <span>
                        Granted to:{" "}
                        <span className="font-mono" title={r.grantedTo}>
                          {shortId(r.grantedTo)}
                        </span>
                      </span>
                    )}
                    {r.expiresAt && (
                      <span>
                        Expires:{" "}
                        {new Date(r.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Show/hide revoked toggle */}
          {!loading && !error && revokedResources.length > 0 && (
            <div className="px-4 py-2 border-t border-neutral-200 dark:border-neutral-800">
              <button
                onClick={() => setShowRevoked(!showRevoked)}
                className="text-[11px] text-neutral-500 hover:text-neutral-400 transition"
              >
                {showRevoked
                  ? "Hide revoked"
                  : `Show ${revokedResources.length} revoked`}
              </button>
            </div>
          )}
        </div>
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
  value: number | string;
  accent?: string;
}) {
  return (
    <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
      <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">
        {label}
      </p>
      <p
        className={`text-lg font-mono font-bold ${
          accent || "text-neutral-800 dark:text-neutral-200"
        }`}
      >
        {value ?? "--"}
      </p>
    </div>
  );
}
