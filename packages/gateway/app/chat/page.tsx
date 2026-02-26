"use client";

import { useState, useEffect, useRef, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import NavBar from "@/components/NavBar";
import { useAuth } from "@/lib/auth-context";

type MessageTier = "simple" | "medium" | "complex";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  tier?: MessageTier;
  isStreaming?: boolean;
  activityLog?: string[];
  encrypted?: boolean;
  nonce?: string;
  decryptFailed?: boolean;  // True if decryption failed (key not available)
}

interface ThreadMeta {
  id: string;
  title: string;
  type: "conversation" | "project";
  createdAt: number;
  updatedAt: number;
  preview: string;
  messageCount: number;
  archived: boolean;
  encryptionKeys?: Record<string, string>;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * Detect if a thread title looks like encrypted/Base64 content rather than
 * a human-readable title.  Encrypted titles are typically long strings of
 * alphanumeric + /+= characters with no spaces.
 */
function isEncryptedTitle(title: string): boolean {
  if (!title || title.length < 20) return false;
  // If it contains spaces, it's likely a real title
  if (/\s/.test(title)) return false;
  // Check if it looks like Base64: mostly alphanumeric, +, /, = chars
  if (/^[A-Za-z0-9+/=]{20,}$/.test(title)) return true;
  // Also catch hex-encoded strings
  if (/^[A-Fa-f0-9]{40,}$/.test(title)) return true;
  return false;
}

/** Get a displayable thread title, falling back for encrypted/unreadable titles. */
function getDisplayTitle(thread: ThreadMeta): string {
  if (isEncryptedTitle(thread.title)) {
    return "Encrypted conversation";
  }
  return thread.title || "Conversation";
}

/** Render basic markdown: **bold**, `inline code`, ```code blocks``` */
function renderContent(text: string) {
  const parts: React.ReactNode[] = [];
  const blocks = text.split(/(```[\s\S]*?```)/g);
  blocks.forEach((block, bi) => {
    if (block.startsWith("```") && block.endsWith("```")) {
      const code = block.slice(3, -3).replace(/^\w*\n/, "");
      parts.push(
        <pre key={bi} className="my-2 p-3 rounded-lg bg-neutral-100 dark:bg-neutral-900 text-xs font-mono overflow-x-auto">
          {code}
        </pre>
      );
    } else {
      const inlineParts = block.split(/(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s<>)"']+)/g);
      const inlineNodes = inlineParts.map((part, ii) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={ii} className="font-semibold">{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={ii} className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-900 text-xs font-mono">{part.slice(1, -1)}</code>;
        }
        if (/^https?:\/\//.test(part)) {
          const label = part.length > 60 ? part.slice(0, 60) + '…' : part;
          return <a key={ii} href={part} target="_blank" rel="noopener noreferrer" className="text-amber-500 hover:text-amber-400 underline break-all">{label}</a>;
        }
        return part;
      });
      parts.push(<span key={bi}>{inlineNodes}</span>);
    }
  });
  return parts;
}

function TierBadge({ tier }: { tier?: MessageTier }) {
  if (!tier) return null;
  const config: Record<MessageTier, { bg: string; text: string; label: string }> = {
    simple: { bg: "bg-emerald-500/10 border-emerald-500/20", text: "text-emerald-600 dark:text-emerald-400", label: "Quick" },
    medium: { bg: "bg-yellow-500/10 border-yellow-500/20", text: "text-yellow-600 dark:text-yellow-400", label: "Smart" },
    complex: { bg: "bg-purple-500/10 border-purple-500/20", text: "text-purple-600 dark:text-purple-400", label: "Full" },
  };
  const c = config[tier];
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  );
}

function CostIndicator({ tier }: { tier: MessageTier }) {
  const costs: Record<MessageTier, { label: string; color: string }> = {
    simple: { label: "Free", color: "text-emerald-500" },
    medium: { label: "~$0.001", color: "text-yellow-500" },
    complex: { label: "$0.50-5", color: "text-purple-500" },
  };
  const c = costs[tier];
  return <span className={`text-[10px] ${c.color} font-medium`}>{c.label}</span>;
}

const QUICK_ACTIONS = [
  { label: "Build a todo app", message: "Build me a todo app" },
  { label: "Build a landing page", message: "Build me a landing page" },
  { label: "Build a weather app", message: "Build me a weather app" },
  { label: "Node Status", message: "show status" },
  { label: "My Balance", message: "what is my balance" },
];

type AgentMode = "auto" | "simple" | "medium" | "complex";

export default function ChatPageWrapper() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white dark:bg-neutral-950" />}>
      <ChatPage />
    </Suspense>
  );
}

function ChatPage() {
  const { isGuest, isClaimed, token, user, loading: authLoading } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>("auto");
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [unreadThreads, setUnreadThreads] = useState<Set<string>>(new Set());
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const activityLogRef = useRef<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Phase 41: E2E encryption state
  const [nodePublicKey, setNodePublicKey] = useState<string | null>(null);  // base64
  const [nodePeerId, setNodePeerId] = useState<string | null>(null);
  const [encryptionReady, setEncryptionReady] = useState(false);

  // Phase 68.4: User's projects + active project routing
  const [projects, setProjects] = useState<any[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const searchParams = useSearchParams();
  const projectIdParam = searchParams.get("projectId");
  // Effective project ID: URL param or user's selection
  const effectiveProjectId = activeProjectId || projectIdParam;

  // Phase 41: Fetch node public key + peerId on mount for E2E encryption
  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.publicKey && data.identity) {
          setNodePublicKey(data.publicKey);
          setNodePeerId(data.identity);
          setEncryptionReady(true);
        }
      })
      .catch(() => {});
  }, []);

  // Use a ref so the SSE handler always reads the latest activeThreadId
  const activeThreadIdRef = useRef(activeThreadId);
  useEffect(() => { activeThreadIdRef.current = activeThreadId; }, [activeThreadId]);

  // Subscribe to SSE for live chat updates — route to correct thread
  useEffect(() => {
    const es = new EventSource("/api/events");

    const handleChatEvent = (e: Event) => {
      try {
        const msg = JSON.parse((e as MessageEvent).data);
        if (!msg.content || msg.role !== "assistant") return;

        const currentThreadId = activeThreadIdRef.current;
        const msgThreadId: string | undefined = msg.threadId || msg.projectId;

        // Determine if this message belongs to the currently active thread
        const isForActiveThread =
          !msgThreadId ||                           // No thread info — legacy fallback, show in current
          msgThreadId === currentThreadId;           // Exact match

        if (isForActiveThread) {
          // Capture activity log and attach to the final message (persists in history)
          // Prefer browser-collected activity (real-time), fall back to SSE-provided (server-persisted)
          const savedActivity = activityLogRef.current.length > 0 ? [...activityLogRef.current] : (msg.activityLog?.length > 0 ? msg.activityLog : undefined);
          setActivityLog([]);
          activityLogRef.current = [];
          setMessages((prev) => {
            const contentKey = msg.content.slice(0, 120);
            const isDupe = prev.some(
              (m) => m.role === "assistant" && !m.isStreaming && m.content.slice(0, 120) === contentKey
            );
            if (isDupe) return prev;
            // Remove "Processing..." placeholder
            const filtered = prev.filter(
              (m) => !(m.role === "assistant" && m.content === "Processing your request...")
            );
            // Replace streaming message with final response + saved activity log
            const hadStreaming = filtered.some((m) => m.isStreaming);
            if (hadStreaming) {
              return filtered.map((m) =>
                m.isStreaming
                  ? { role: "assistant" as const, content: msg.content, timestamp: msg.timestamp || Date.now(), tier: msg.tier, activityLog: savedActivity }
                  : m
              );
            }
            return [...filtered, {
              role: "assistant" as const,
              content: msg.content,
              timestamp: msg.timestamp || Date.now(),
              tier: msg.tier,
              activityLog: savedActivity,
            }];
          });
        } else if (msgThreadId) {
          // Message is for a different thread — mark it as having unread messages
          setUnreadThreads((prev) => {
            const next = new Set(prev);
            next.add(msgThreadId);
            return next;
          });
          // Also bump that thread's message count in the sidebar
          setThreads((prev) =>
            prev.map((t) =>
              t.id === msgThreadId
                ? { ...t, updatedAt: Date.now(), messageCount: t.messageCount + 1 }
                : t
            ).sort((a, b) => b.updatedAt - a.updatedAt)
          );
        }
      } catch {}
    };

    // Handle streaming progress events — real-time agent activity
    const handleProgressEvent = (e: Event) => {
      try {
        const msg = JSON.parse((e as MessageEvent).data);
        if (!msg.content) return;

        const currentThreadId = activeThreadIdRef.current;
        const msgThreadId: string | undefined = msg.threadId || msg.projectId;
        const isForActiveThread = !msgThreadId || msgThreadId === currentThreadId;
        if (!isForActiveThread) return;

        // Ensure exactly ONE streaming message exists (prevent duplicates)
        setMessages((prev) => {
          // Already have a streaming message — don't touch messages, just accumulate activity
          if (prev.some((m) => m.isStreaming)) return prev;
          // Replace "Processing..." with streaming indicator
          const idx = prev.findIndex(
            (m) => m.role === "assistant" && m.content === "Processing your request..."
          );
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...prev[idx], content: "", isStreaming: true };
            return updated;
          }
          // No Processing and no streaming — create one
          return [...prev, { role: "assistant" as const, content: "", timestamp: Date.now(), isStreaming: true }];
        });

        // Accumulate activity log (keep last 50 lines)
        const line = msg.content;
        activityLogRef.current = [...activityLogRef.current, line].slice(-50);
        setActivityLog((prev) => {
          const next = [...prev, line];
          return next.length > 50 ? next.slice(-50) : next;
        });
      } catch {}
    };

    es.addEventListener("chat_message", handleChatEvent);
    es.addEventListener("manager_output", handleChatEvent);
    es.addEventListener("worker_message", handleChatEvent);
    es.addEventListener("chat_progress", handleProgressEvent);
    es.onerror = () => {};
    return () => es.close();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Load thread messages when switching
  // Phase 41: Decrypt encrypted messages using the thread key from localStorage
  const loadThread = useCallback(async (threadId: string) => {
    setActiveThreadId(threadId);
    setMessages([]);
    setError(null);
    // Clear unread badge for this thread
    setUnreadThreads((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.delete(threadId);
      return next;
    });
    try {
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`);
      const data = await res.json();
      if (data.messages?.length) {
        // Phase 41: Attempt to decrypt encrypted messages
        const { getThreadKey, decryptMessage } = await import("@/lib/crypto");
        const threadKey = getThreadKey(threadId);
        const decryptedMessages = await Promise.all(
          data.messages.map(async (msg: ChatMessage) => {
            if (!msg.encrypted || !msg.nonce) return msg;
            if (!threadKey) {
              return { ...msg, content: "[Encrypted message -- key not available]", decryptFailed: true };
            }
            try {
              const plaintext = await decryptMessage(msg.content, msg.nonce, threadKey);
              return { ...msg, content: plaintext };
            } catch {
              return { ...msg, content: "[Encrypted message -- decryption failed]", decryptFailed: true };
            }
          })
        );
        setMessages(decryptedMessages);
      }
    } catch {}
  }, []);

  // Load threads on mount; auto-select thread from ?thread= param
  // Wait for auth to resolve (token available) before fetching, to avoid leaking other users' threads
  useEffect(() => {
    if (!token) {
      // If auth finished loading but no token, stop showing "Loading..."
      if (!authLoading) setThreadsLoading(false);
      return;
    }
    const headers: Record<string, string> = { "X-User-Token": token };
    fetch("/api/chat/threads", { headers })
      .then((r) => r.json())
      .then((data) => {
        setThreads(data.threads?.length ? data.threads : []);
        const threadParam = searchParams.get("thread");
        if (threadParam && data.threads?.some((t: ThreadMeta) => t.id === threadParam)) {
          loadThread(threadParam);
        }
      })
      .catch(() => {})
      .finally(() => setThreadsLoading(false));
  }, [searchParams, loadThread, token, authLoading]);

  // Phase 68.4: Fetch user's projects for returning user routing
  useEffect(() => {
    if (!token || isGuest) return;
    setProjectsLoading(true);
    fetch("/api/projects", { headers: { "X-User-Token": token } })
      .then((r) => r.json())
      .then((data) => setProjects(data.projects || []))
      .catch(() => setProjects([]))
      .finally(() => setProjectsLoading(false));
  }, [token, isGuest]);

  // Phase 68.4: Open a project — load its main thread and set context
  const openProject = useCallback((project: any) => {
    setActiveProjectId(project.id);
    setActiveProjectName(project.name);
    // If the project has a main thread, load it
    if (project.threadId) {
      loadThread(project.threadId);
    } else {
      // No thread yet — clear messages, let user start fresh in project context
      setActiveThreadId(null);
      setMessages([]);
    }
  }, [loadThread]);

  // Create new thread (also clears project context)
  const createNewThread = useCallback(async () => {
    setActiveThreadId(null);
    setMessages([]);
    setError(null);
    setActiveProjectId(null);
    setActiveProjectName(null);
    inputRef.current?.focus();
  }, []);

  const sendMessage = useCallback(async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || sending) return;

    setError(null);
    setSending(true);
    if (!text) setInput("");

    // Optimistically add user message (plaintext for local display)
    const userMsg: ChatMessage = { role: "user", content: msg, timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);

    try {
      let threadId = activeThreadId;

      // Phase 41: Lazy-load crypto module for encryption
      const cryptoMod = await import("@/lib/crypto");

      // If no active thread, create one from this message
      if (!threadId) {
        const createHeaders: Record<string, string> = { "Content-Type": "application/json" };
        if (token) createHeaders["X-User-Token"] = token;

        // Phase 41.5: Generate thread key and encrypt for user ONLY (not the node).
        // The node receives the thread key per-request (stateless), not via stored encryptionKeys.
        const createBody: Record<string, unknown> = { title: msg.slice(0, 50) };
        if (encryptionReady && nodePublicKey && nodePeerId && user?.peerId && user?.publicKey) {
          try {
            const userPrivKey = cryptoMod.getPrivateKey(user.peerId);
            if (userPrivKey) {
              const threadKey = cryptoMod.generateThreadKey();
              const padB64 = (s: string) => s + '='.repeat((4 - (s.length % 4)) % 4);
              const userPublicKeyBytes = Uint8Array.from(atob(padB64(user.publicKey)), c => c.charCodeAt(0));

              // Encrypt the thread key for the user (for recovery on other devices via localStorage)
              const encKeyForUser = await cryptoMod.encryptThreadKey(threadKey, userPrivKey, userPublicKeyBytes);

              // Phase 41.5: Only store user's key + sender public key. No node key.
              createBody.encryptionKeys = {
                [user.peerId]: encKeyForUser,
                // Store sender's public key so the node can derive the X25519 shared secret
                _senderPublicKey: user.publicKey,  // base64 encoded Ed25519 public key of the sender
              };

              // Store thread key locally (will be associated once we know the threadId)
              // We'll store it after we get the threadId back
              (createBody as any)._localThreadKey = threadKey;
            }
          } catch (err: any) {
            console.error("Thread encryption setup failed:", err?.message);
            setError("Failed to set up encrypted thread. Please refresh and try again.");
            return;
          }
        }

        const createPayload: Record<string, unknown> = {
          title: createBody.title,
          encryptionKeys: createBody.encryptionKeys,
        };
        if (effectiveProjectId) createPayload.projectId = effectiveProjectId;

        const createRes = await fetch("/api/chat/threads", {
          method: "POST",
          headers: createHeaders,
          body: JSON.stringify(createPayload),
        });
        const newThread = await createRes.json();
        threadId = newThread.id;
        setActiveThreadId(threadId);

        // Phase 41: Store thread key in localStorage now that we know the threadId
        const localKey = (createBody as any)._localThreadKey;
        if (localKey && threadId) {
          cryptoMod.storeThreadKey(threadId, localKey);
        }

        // Add to thread list
        setThreads((prev) => [newThread, ...prev]);
      }

      // Phase 41.5: Encrypt message if we have a thread key.
      // Also encrypt the thread key for the current node (per-request delivery).
      const body: Record<string, unknown> = {};
      if (agentMode !== "auto") {
        body.tier = agentMode;
      }

      const threadKey = threadId ? cryptoMod.getThreadKey(threadId) : null;
      if (threadKey) {
        const encrypted = await cryptoMod.encryptMessage(msg, threadKey);
        body.message = encrypted.ciphertext;
        body.nonce = encrypted.nonce;
        body.encrypted = true;

        // Phase 41.5: Encrypt thread key for the current node on every request (stateless)
        if (encryptionReady && nodePublicKey && user?.peerId) {
          const userPrivKey = cryptoMod.getPrivateKey(user.peerId);
          if (userPrivKey) {
            const padB64 = (s: string) => s + '='.repeat((4 - (s.length % 4)) % 4);
            const nodePublicKeyBytes = Uint8Array.from(atob(padB64(nodePublicKey)), c => c.charCodeAt(0));
            body.encryptedThreadKey = await cryptoMod.encryptThreadKeyForNode(
              threadKey, userPrivKey, nodePublicKeyBytes
            );
          }
        }
      } else {
        // No thread key = legacy unencrypted thread (created before Phase 41)
        body.message = msg;
      }

      // Include projectId in the message body so new threads get linked to the project
      if (effectiveProjectId) body.projectId = effectiveProjectId;

      // Send via thread-specific endpoint (saves to ThreadStore + routes to bridge)
      const msgHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (token) msgHeaders["X-User-Token"] = token;
      const res = await fetch(`/api/chat/threads/${encodeURIComponent(threadId!)}/message`, {
        method: "POST",
        headers: msgHeaders,
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to get response");
        return;
      }

      // Phase 27: the message is queued to the manager's bridge.
      // The real reply comes via SSE (chat_message / manager_output events).
      if (data.status === "queued") {
        // Show a processing indicator — but only if streaming hasn't already started
        // (chat_progress events can arrive before this HTTP response)
        setMessages((prev) => {
          if (prev.some((m) => m.isStreaming)) return prev;
          return [...prev, {
            role: "assistant",
            content: "Processing your request...",
            timestamp: Date.now(),
            tier: "complex" as MessageTier,
          }];
        });
      } else if (data.reply) {
        // Quick-tier or direct response — show inline
        // Phase 41: Decrypt the response if it's encrypted
        let replyContent = data.reply;
        if (data.encrypted && data.nonce && threadKey) {
          try {
            replyContent = await cryptoMod.decryptMessage(data.reply, data.nonce, threadKey);
          } catch {
            replyContent = "[Encrypted response -- decryption failed]";
          }
        }

        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: replyContent,
          timestamp: Date.now(),
          tier: data.tier as MessageTier | undefined,
        };
        setMessages((prev) => {
          const contentKey = assistantMsg.content.slice(0, 120);
          const isDupe = prev.some(
            (m) => m.role === "assistant" && m.content.slice(0, 120) === contentKey
          );
          if (isDupe) return prev;
          return [...prev, assistantMsg];
        });
      }

      // Update thread in sidebar (bump to top, update message count)
      setThreads((prev) => {
        const updated = prev.map((t) =>
          t.id === threadId
            ? { ...t, updatedAt: Date.now(), messageCount: t.messageCount + 2 }
            : t
        );
        return updated.sort((a, b) => b.updatedAt - a.updatedAt);
      });
    } catch (err: any) {
      setError(err?.message || "Network error");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [input, sending, agentMode, activeThreadId, token, encryptionReady, nodePublicKey, nodePeerId, user, effectiveProjectId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const loadingText = agentMode === "complex" ? "Claude Code is thinking..." : "Thinking...";
  const effectiveTier: MessageTier = agentMode === "auto" ? "medium" : agentMode;

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950 flex flex-col">
      <NavBar />
      <main className="flex-1 flex max-w-6xl mx-auto w-full animate-page-fade-in">
        {/* Thread Sidebar */}
        <div className={`${showSidebar ? "w-64" : "w-0"} transition-all duration-200 overflow-hidden border-r border-neutral-200 dark:border-neutral-800`}>
          <div className="p-3 w-64 h-full flex flex-col">
            {/* New Chat button */}
            <button
              onClick={createNewThread}
              className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:border-amber-500/50 hover:text-amber-600 dark:hover:text-amber-400 transition mb-3 text-sm"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              New Chat
            </button>

            {/* Phase 68.4: Your Projects — returning user routing */}
            {!isGuest && projects.length > 0 && (
              <div className="mb-3">
                <h3 className="text-[10px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-1.5 px-1">
                  Your Projects
                </h3>
                <div className="space-y-1">
                  {projects.slice(0, 5).map((project) => (
                    <button
                      key={project.id}
                      onClick={() => openProject(project)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                        activeProjectId === project.id
                          ? "bg-purple-500/10 border border-purple-500/30"
                          : "hover:bg-neutral-100 dark:hover:bg-neutral-900 border border-transparent"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-500 flex-shrink-0">
                          <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                          <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                        </svg>
                        <span className={`font-medium truncate text-xs ${
                          activeProjectId === project.id
                            ? "text-purple-700 dark:text-purple-400"
                            : "text-neutral-700 dark:text-neutral-300"
                        }`}>
                          {project.name}
                        </span>
                      </div>
                      <div className="text-[10px] text-neutral-400 flex items-center gap-1.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${project.status === 'active' ? 'bg-emerald-500' : 'bg-neutral-400'}`} />
                        {project.status === 'active' ? 'Active' : 'Archived'}
                        <span className="ml-auto">{formatRelativeTime(project.updatedAt)}</span>
                      </div>
                    </button>
                  ))}
                  {projects.length > 5 && (
                    <p className="text-[10px] text-neutral-400 px-3 py-1">+{projects.length - 5} more — <a href="/projects" className="underline hover:text-amber-500">view all</a></p>
                  )}
                </div>
              </div>
            )}
            {projectsLoading && !isGuest && (
              <p className="text-[10px] text-neutral-400 px-1 mb-2">Loading projects...</p>
            )}

            <h3 className="text-[10px] font-semibold text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2 px-1">
              Conversations
            </h3>

            {/* Thread list */}
            <div className="flex-1 overflow-y-auto space-y-1">
              {threads.length === 0 ? (
                <p className="text-xs text-neutral-400 px-3 py-2">{threadsLoading ? "Loading..." : "No conversations yet"}</p>
              ) : (
                threads.map((thread) => (
                  <button
                    key={thread.id}
                    onClick={() => loadThread(thread.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition group relative ${
                      activeThreadId === thread.id
                        ? "bg-amber-500/10 border border-amber-500/30"
                        : "hover:bg-neutral-100 dark:hover:bg-neutral-900 border border-transparent"
                    }`}
                  >
                    {/* Unread notification dot */}
                    {unreadThreads.has(thread.id) && activeThreadId !== thread.id && (
                      <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-white dark:ring-neutral-950" />
                    )}
                    <div className="flex items-center gap-1.5 mb-0.5">
                      {thread.type === "project" && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-500 flex-shrink-0">
                          <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                          <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                        </svg>
                      )}
                      {/* Phase 41: Lock icon for encrypted threads */}
                      {thread.encryptionKeys && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-500 flex-shrink-0">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                      )}
                      <span className={`font-medium truncate ${
                        activeThreadId === thread.id
                          ? "text-amber-700 dark:text-amber-400"
                          : unreadThreads.has(thread.id)
                            ? "text-amber-600 dark:text-amber-300 font-semibold"
                            : "text-neutral-700 dark:text-neutral-300"
                      }`}>
                        {getDisplayTitle(thread)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-neutral-400 truncate max-w-[120px]">
                        {thread.preview && !isEncryptedTitle(thread.preview) ? thread.preview : `${thread.messageCount || 0} messages`}
                      </span>
                      <span className="text-[10px] text-neutral-400 flex-shrink-0">
                        {formatRelativeTime(thread.updatedAt)}
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Main chat area */}
        <div className="flex-1 flex flex-col p-4">
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowSidebar(!showSidebar)}
                className="w-8 h-8 rounded-lg border border-neutral-200 dark:border-neutral-800 flex items-center justify-center text-neutral-500 hover:text-amber-500 transition"
                title={showSidebar ? "Hide sidebar" : "Show threads"}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              </button>
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${activeProjectId ? "bg-purple-500/10 border border-purple-500/20" : "bg-amber-500/10 border border-amber-500/20"}`}>
                {activeProjectId ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-purple-500 dark:text-purple-400">
                    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 dark:text-amber-400">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                )}
              </div>
              <div>
                <h1 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">
                  {activeProjectId && activeProjectName ? activeProjectName : activeThread ? getDisplayTitle(activeThread) : "New Chat"}
                </h1>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5">
                  {activeProjectId
                    ? `Project context active${activeThread ? ` · ${activeThread.messageCount || 0} messages` : " · new conversation"}`
                    : activeThread
                      ? `${activeThread.type === "project" ? "Project" : "Chat"} -- ${activeThread.messageCount || 0} messages`
                      : "Start a new conversation"
                  }
                  {/* Phase 41: Encryption indicator */}
                  {activeThread?.encryptionKeys && (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                      Encrypted
                    </span>
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* Phase 68.4: Clear project context button */}
              {activeProjectId && (
                <button
                  onClick={() => { setActiveProjectId(null); setActiveProjectName(null); setActiveThreadId(null); setMessages([]); }}
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-purple-200 dark:border-purple-800 text-purple-600 dark:text-purple-400 hover:bg-purple-500/10 transition"
                  title="Exit project context"
                >
                  ✕ Project
                </button>
              )}
              <div className="flex flex-col items-end gap-0.5">
                <select
                  value={agentMode}
                  onChange={(e) => setAgentMode(e.target.value as AgentMode)}
                  className="text-xs px-2 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-300 focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                >
                  <option value="auto">Auto (adaptive)</option>
                  <option value="simple">Quick (keyword) -- free</option>
                  <option value="medium">Smart (AI) -- ~$0.001</option>
                  <option value="complex">Full (Claude Code) -- $0.50-5</option>
                </select>
                {agentMode !== "auto" && <CostIndicator tier={effectiveTier} />}
              </div>
            </div>
          </div>

          {/* Guest welcome + claim reminder */}
          {isGuest && !isClaimed && (
            <div className="mb-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-between gap-3">
              <p className="text-sm text-amber-700 dark:text-amber-300">
                Welcome! You have free Lux to try AI services.{" "}
                <a href="/register" className="underline font-medium hover:text-amber-600 dark:hover:text-amber-200 transition">
                  Sign up
                </a>{" "}
                to keep your balance permanently.
              </p>
            </div>
          )}

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 p-4 mb-4 min-h-[400px] max-h-[calc(100vh-320px)]">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-12 space-y-4">
                <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-amber-500 dark:text-amber-400">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {activeProjectId && activeProjectName
                      ? `Continue: ${activeProjectName}`
                      : activeThread
                        ? `Continue: ${getDisplayTitle(activeThread)}`
                        : "Start a conversation"
                    }
                  </p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 max-w-sm">
                    {activeProjectId
                      ? "Your project manager will pick up where you left off."
                      : "Ask about your node, transfer Lux, build projects, or search the network. Say \"build me...\" to start a project."
                    }
                  </p>
                </div>
                <div className="flex gap-3 mt-3">
                  <div className="flex items-center gap-1.5">
                    <TierBadge tier="simple" />
                    <span className="text-[10px] text-neutral-400">Instant / free</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <TierBadge tier="medium" />
                    <span className="text-[10px] text-neutral-400">AI / ~$0.001</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <TierBadge tier="complex" />
                    <span className="text-[10px] text-neutral-400">Claude Code / $0.50-5</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((msg, i) => (
                  <div
                    key={i}
                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[95%] sm:max-w-[85%] md:max-w-[80%] rounded-2xl px-3 sm:px-4 py-2.5 ${
                        msg.role === "user"
                          ? "bg-amber-500 text-white rounded-br-md"
                          : "bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-800 dark:text-neutral-200 rounded-bl-md"
                      }`}
                    >
                      {msg.isStreaming ? (
                        /* Live activity panel — real-time agent progress */
                        <div className="min-w-[200px] sm:min-w-[300px]">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                            <span className="text-sm font-medium text-amber-600 dark:text-amber-400">Agent working...</span>
                          </div>
                          {activityLog.length > 0 && (
                            <div className="bg-neutral-100 dark:bg-neutral-900 rounded-lg p-2 sm:p-3 max-h-[300px] overflow-y-auto">
                              {activityLog.map((line, li) => (
                                <div key={li} className={`text-[11px] sm:text-xs font-mono leading-relaxed break-all whitespace-pre-wrap ${
                                  line.startsWith("Tool:") ? "text-blue-600 dark:text-blue-400" :
                                  line === "Completed" ? "text-emerald-600 dark:text-emerald-400" :
                                  "text-neutral-500 dark:text-neutral-400"
                                }`}>
                                  {line}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="text-sm whitespace-pre-wrap break-words">
                            {msg.role === "assistant" ? renderContent(msg.content) : msg.content}
                          </div>
                          {msg.activityLog && msg.activityLog.length > 0 && (
                            <details className="mt-2 border-t border-neutral-200 dark:border-neutral-700 pt-1.5">
                              <summary className="text-[10px] sm:text-[11px] text-neutral-400 cursor-pointer hover:text-neutral-600 dark:hover:text-neutral-300 select-none">
                                Activity ({msg.activityLog.length} steps)
                              </summary>
                              <div className="mt-1 bg-neutral-100 dark:bg-neutral-900 rounded-lg p-2 sm:p-3 max-h-[250px] overflow-y-auto">
                                {msg.activityLog.map((line, li) => (
                                  <div key={li} className={`text-[10px] sm:text-[11px] font-mono leading-relaxed break-all whitespace-pre-wrap ${
                                    line.startsWith("Tool:") ? "text-blue-600 dark:text-blue-400" :
                                    line === "Completed" ? "text-emerald-600 dark:text-emerald-400" :
                                    "text-neutral-500 dark:text-neutral-400"
                                  }`}>
                                    {line}
                                  </div>
                                ))}
                              </div>
                            </details>
                          )}
                        </>
                      )}
                      {!msg.isStreaming && (
                        <div className={`flex items-center gap-2 mt-1 ${
                          msg.role === "user" ? "justify-end" : "justify-start"
                        }`}>
                          <p
                            className={`text-[10px] ${
                              msg.role === "user"
                                ? "text-amber-200"
                                : "text-neutral-400 dark:text-neutral-500"
                            }`}
                          >
                            {formatTime(msg.timestamp)}
                          </p>
                          {msg.role === "assistant" && msg.tier && (
                            <TierBadge tier={msg.tier} />
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="flex justify-start">
                    <div className="bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-2xl rounded-bl-md px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex gap-1.5">
                          <div className="w-2 h-2 rounded-full bg-neutral-400 animate-bounce" style={{ animationDelay: "0ms" }} />
                          <div className="w-2 h-2 rounded-full bg-neutral-400 animate-bounce" style={{ animationDelay: "150ms" }} />
                          <div className="w-2 h-2 rounded-full bg-neutral-400 animate-bounce" style={{ animationDelay: "300ms" }} />
                        </div>
                        <span className="text-[10px] text-neutral-400 ml-1">{loadingText}</span>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {error && (
            <div className="mb-3 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Quick actions (only when no thread or empty) */}
          {messages.length === 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {QUICK_ACTIONS.map((action) => (
                <button
                  key={action.label}
                  onClick={() => sendMessage(action.message)}
                  disabled={sending}
                  className="text-xs px-3 py-1.5 rounded-lg bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:border-amber-500/50 hover:text-amber-600 dark:hover:text-amber-400 disabled:opacity-50 transition"
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}

          {/* Input area */}
          <div className="flex gap-3 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={activeThread ? `Continue: ${getDisplayTitle(activeThread)}...` : "Type a message to start a new chat..."}
              disabled={sending}
              rows={1}
              className="flex-1 resize-none rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-3 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 disabled:opacity-50 transition"
              style={{ maxHeight: "120px" }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 120) + "px";
              }}
            />
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || sending}
              className="px-4 py-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              Send
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
