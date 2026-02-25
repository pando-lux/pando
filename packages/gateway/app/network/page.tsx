"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

interface Peer { peerId: string; balance: number; connectedAt: number; lastSeen?: number }
interface Status { connected: boolean; peers: number; totalSupply: number; totalAccounts: number }

interface ReputationRecord {
  nodeId: string;
  tasksCompleted: number;
  tasksFailed: number;
  tasksTimedOut: number;
  avgCompletionMs: number;
  buildPassRate: number;
  testPassRate: number;
  profilesContributed: number;
  reputationScore: number;
  lastUpdated: number;
}

interface ProfileSyncStats {
  shared: number;
  received: number;
  imported: number;
  rejected: number;
}

interface RequestReplyStats {
  sent: number;
  received: number;
  timeouts: number;
  avgLatencyMs: number;
}

export default function NetworkPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState("");
  const [reputations, setReputations] = useState<ReputationRecord[]>([]);
  const [profileStats, setProfileStats] = useState<ProfileSyncStats | null>(null);
  const [rrStats, setRrStats] = useState<RequestReplyStats | null>(null);

  const fetchData = useCallback(async () => {
    const [s, p, rep, prof, rr] = await Promise.all([
      fetch("/api/status").then(r => r.json()).catch(() => null),
      fetch("/api/peers").then(r => r.json()).catch(() => ({ peers: [] })),
      fetch("/api/reputation/peers").then(r => r.json()).catch(() => null),
      Promise.resolve(null), // profiles/shared API removed in Phase 27
      fetch("/api/request-reply/stats").then(r => r.json()).catch(() => null),
    ]);
    if (s) setStatus(s);
    if (p?.peers) setPeers(p.peers);
    if (rep?.reputations) setReputations(rep.reputations);
    if (prof) setProfileStats(prof);
    if (rr) setRrStats(rr);
  }, []);

  useEffect(() => {
    fetchData();
    const i = setInterval(fetchData, 10000);
    return () => clearInterval(i);
  }, [fetchData]);

  function shortId(id: string) { return id.length > 20 ? id.slice(0, 8) + "\u2026" + id.slice(-6) : id; }
  function relTime(ts: number) {
    const d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
    return `${Math.floor(d / 86400000)}d ago`;
  }

  function copyId(id: string) {
    navigator.clipboard.writeText(id);
    setCopied(id);
    setTimeout(() => setCopied(""), 2000);
  }

  function scoreColor(score: number): string {
    if (score >= 10) return "text-green-500";
    if (score >= 5) return "text-amber-500";
    if (score > 0) return "text-neutral-400";
    return "text-red-400";
  }

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">Network</h1>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
            <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Connected Peers</p>
            <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{status?.peers ?? "\u2014"}</p>
          </div>
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
            <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Total Supply</p>
            <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{status ? `${status.totalSupply.toLocaleString(undefined, { maximumFractionDigits: 2 })} Lux` : "\u2014"}</p>
          </div>
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
            <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Total Accounts</p>
            <p className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{status?.totalAccounts ?? "\u2014"}</p>
          </div>
        </div>

        {/* Network Intelligence Stats */}
        {(profileStats || rrStats) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {rrStats && (
              <>
                <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
                  <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Requests Sent</p>
                  <p className="text-lg font-mono font-bold text-neutral-900 dark:text-neutral-100">{rrStats.sent}</p>
                  {rrStats.avgLatencyMs > 0 && (
                    <p className="text-[10px] text-neutral-500 mt-1">avg {rrStats.avgLatencyMs}ms latency</p>
                  )}
                </div>
                <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
                  <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Requests Received</p>
                  <p className="text-lg font-mono font-bold text-neutral-900 dark:text-neutral-100">{rrStats.received}</p>
                  {rrStats.timeouts > 0 && (
                    <p className="text-[10px] text-red-400 mt-1">{rrStats.timeouts} timeouts</p>
                  )}
                </div>
              </>
            )}
            {profileStats && (
              <>
                <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
                  <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Profiles Shared</p>
                  <p className="text-lg font-mono font-bold text-neutral-900 dark:text-neutral-100">{profileStats.shared}</p>
                  <p className="text-[10px] text-neutral-500 mt-1">{profileStats.received} received</p>
                </div>
                <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4">
                  <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">Profiles Imported</p>
                  <p className="text-lg font-mono font-bold text-green-500">{profileStats.imported}</p>
                  {profileStats.rejected > 0 && (
                    <p className="text-[10px] text-neutral-500 mt-1">{profileStats.rejected} rejected</p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Reputation Leaderboard */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Reputation Leaderboard</h2>
          </div>
          {reputations.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-neutral-500">No reputation data yet</div>
          ) : (
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-2 text-xs text-neutral-500 font-medium">
                <div className="col-span-1">#</div>
                <div className="col-span-3">Node</div>
                <div className="col-span-2 text-right">Score</div>
                <div className="col-span-2 text-right">Tasks Done</div>
                <div className="col-span-2 text-right">Build Pass</div>
                <div className="col-span-2 text-right">Last Active</div>
              </div>
              {reputations
                .sort((a, b) => b.reputationScore - a.reputationScore)
                .map((rep, idx) => (
                <div key={rep.nodeId} className="grid grid-cols-1 sm:grid-cols-12 gap-1 sm:gap-2 px-4 py-2.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition">
                  <div className="sm:col-span-1 text-neutral-500 font-medium">{idx + 1}</div>
                  <div className="sm:col-span-3 text-neutral-700 dark:text-neutral-300 font-mono truncate">{shortId(rep.nodeId)}</div>
                  <div className={`sm:col-span-2 text-right font-mono font-bold ${scoreColor(rep.reputationScore)}`}>
                    {rep.reputationScore.toFixed(1)}
                  </div>
                  <div className="sm:col-span-2 text-right text-neutral-600 dark:text-neutral-400">
                    {rep.tasksCompleted}
                    {rep.tasksFailed > 0 && <span className="text-red-400 ml-1">({rep.tasksFailed} failed)</span>}
                  </div>
                  <div className="sm:col-span-2 text-right text-neutral-600 dark:text-neutral-400">
                    {rep.tasksCompleted > 0 ? `${Math.round(rep.buildPassRate * 100)}%` : "\u2014"}
                  </div>
                  <div className="sm:col-span-2 text-right text-neutral-500">
                    {rep.lastUpdated ? relTime(rep.lastUpdated) : "\u2014"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Peers table */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800"><h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Connected Peers</h2></div>
          {peers.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-neutral-500">No peers connected</div>
          ) : (
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
              <div className="hidden sm:grid grid-cols-12 gap-2 px-4 py-2 text-xs text-neutral-500 font-medium">
                <div className="col-span-5">Peer ID</div>
                <div className="col-span-3">Balance</div>
                <div className="col-span-4">Connected</div>
              </div>
              {peers.map(peer => (
                <div key={peer.peerId}>
                  <button onClick={() => setExpanded(expanded === peer.peerId ? null : peer.peerId)}
                    className="w-full grid grid-cols-1 sm:grid-cols-12 gap-1 sm:gap-2 px-4 py-2.5 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800/50 transition text-left">
                    <div className="sm:col-span-5 text-neutral-700 dark:text-neutral-300 font-mono truncate">{shortId(peer.peerId)}</div>
                    <div className="sm:col-span-3 text-neutral-600 dark:text-neutral-400">{peer.balance?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "\u2014"} Lux</div>
                    <div className="sm:col-span-4 text-neutral-500">{peer.connectedAt ? relTime(peer.connectedAt) : "\u2014"}</div>
                  </button>
                  {expanded === peer.peerId && (
                    <div className="px-4 pb-4 bg-neutral-100/50 dark:bg-neutral-800/30 border-t border-neutral-300 dark:border-neutral-800 space-y-2 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-neutral-500">Full ID:</span>
                        <code className="text-xs text-neutral-600 dark:text-neutral-400 font-mono bg-neutral-200 dark:bg-neutral-800 px-2 py-1 rounded flex-1 truncate">{peer.peerId}</code>
                        <button onClick={() => copyId(peer.peerId)} className="bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300 rounded px-2 py-1 text-xs transition">
                          {copied === peer.peerId ? "Copied!" : "Copy"}
                        </button>
                      </div>
                      <div className="flex gap-4 text-xs">
                        <span className="text-neutral-500">Balance: <span className="text-neutral-700 dark:text-neutral-300">{peer.balance?.toLocaleString(undefined, { maximumFractionDigits: 4 }) ?? "\u2014"} Lux</span></span>
                        {peer.lastSeen && <span className="text-neutral-500">Last seen: <span className="text-neutral-700 dark:text-neutral-300">{relTime(peer.lastSeen)}</span></span>}
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
