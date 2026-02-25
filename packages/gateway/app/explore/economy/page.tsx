"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";
import { useAuth } from "@/lib/auth-context";

/* -- Types ------------------------------------------------- */

interface EconomyStats {
  totalSupply: number;
  nodeBalance: number;
  totalAccounts: number;
  peers: number;
}

interface LedgerAccount {
  peerId: string;
  balance: number;
  createdAt: number;
  updatedAt: number;
}

interface LedgerTx {
  id: string;
  from: string;
  to: string;
  amount: number;
  fee: number;
  type: string;
  timestamp: number;
}

/* -- Helpers ----------------------------------------------- */

function shortPeer(id: string): string {
  if (!id) return "--";
  if (id === "NETWORK") return "🌐 NETWORK";
  if (id.length <= 16) return id;
  return id.slice(0, 8) + "…" + id.slice(-6);
}

function luxFmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

function relTime(ts: number): string {
  if (!ts) return "--";
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  if (d < 86400000 * 7) return `${Math.floor(d / 86400000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function txTypeBadge(type: string): string {
  switch (type) {
    case "transfer": return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20";
    case "emission": return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
    case "fee": return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20";
    default: return "bg-neutral-500/10 text-neutral-600 dark:text-neutral-400 border-neutral-500/20";
  }
}

/* -- Main Page --------------------------------------------- */

type TabKey = "accounts" | "transactions";

export default function EconomyPage() {
  const { user, isClaimed } = useAuth();

  const [stats, setStats] = useState<EconomyStats | null>(null);
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [txs, setTxs] = useState<LedgerTx[]>([]);
  const [txTotal, setTxTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("accounts");

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, acctRes, txRes] = await Promise.all([
        fetch("/api/status").then(r => r.json()).catch(() => null),
        fetch("/api/ledger?type=accounts&limit=50").then(r => r.json()).catch(() => ({ accounts: [], totalAccounts: 0, totalSupply: 0 })),
        fetch("/api/ledger?type=transactions&limit=50").then(r => r.json()).catch(() => ({ transactions: [], total: 0 })),
      ]);

      if (statusRes) {
        setStats({
          totalSupply: statusRes.totalSupply ?? 0,
          nodeBalance: statusRes.balance ?? 0,
          totalAccounts: statusRes.totalAccounts ?? 0,
          peers: statusRes.peers ?? 0,
        });
      }
      setAccounts(acctRes.accounts || []);
      setTxs(txRes.transactions || []);
      setTxTotal(txRes.total || 0);
    } catch { /* keep last state */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    const i = setInterval(fetchAll, 20000);
    return () => clearInterval(i);
  }, [fetchAll]);

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">

        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <a href="/explore" className="hover:text-amber-500 transition">Explore</a>
          <span>/</span>
          <span className="text-neutral-700 dark:text-neutral-300">Economy</span>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">Ledger Explorer</h1>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              Real-time Lux economy — accounts, balances, and transaction history across the Pando network.
            </p>
          </div>
          <button
            onClick={fetchAll}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 transition"
          >
            {loading ? "Loading…" : "↺ Refresh"}
          </button>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Total Supply", value: stats ? `${luxFmt(stats.totalSupply)} Lux` : "—", color: "text-amber-500" },
            { label: isClaimed ? "Your Balance" : "Node Balance", value: stats ? `${luxFmt(isClaimed && user?.balance != null ? user.balance : stats.nodeBalance)} Lux` : "—", color: "text-amber-500" },
            { label: "Accounts", value: stats ? stats.totalAccounts.toLocaleString() : "—", color: "" },
            { label: "Transactions", value: txTotal > 0 ? txTotal.toLocaleString() : (stats ? "—" : "—"), color: "" },
          ].map(({ label, value, color }) => (
            <div key={label} className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 p-4">
              <p className="text-xs text-neutral-500 mb-1">{label}</p>
              <p className={`text-lg font-semibold font-mono text-neutral-900 dark:text-neutral-100 ${color}`}>
                {value}
              </p>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
          {(["accounts", "transactions"] as TabKey[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${
                tab === t
                  ? "border-amber-500 text-amber-500"
                  : "border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-200"
              }`}
            >
              {t === "accounts" ? `Accounts (${accounts.length})` : `Recent Transactions (${txs.length})`}
            </button>
          ))}
        </div>

        {/* Accounts table */}
        {tab === "accounts" && (
          <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50">
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium w-8">#</th>
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">Peer ID</th>
                  <th className="text-right px-4 py-3 text-neutral-500 font-medium">Balance</th>
                  <th className="text-right px-4 py-3 text-neutral-500 font-medium hidden sm:table-cell">Share</th>
                  <th className="text-right px-4 py-3 text-neutral-500 font-medium hidden md:table-cell">Last Active</th>
                </tr>
              </thead>
              <tbody>
                {loading && accounts.length === 0 ? (
                  [...Array(8)].map((_, i) => (
                    <tr key={i} className="border-b border-neutral-100 dark:border-neutral-800/50">
                      <td className="px-4 py-3"><div className="h-3 w-4 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" /></td>
                      <td className="px-4 py-3"><div className="h-3 w-40 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" /></td>
                      <td className="px-4 py-3 text-right"><div className="h-3 w-16 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse ml-auto" /></td>
                    </tr>
                  ))
                ) : accounts.map((acct, idx) => {
                  const share = stats && stats.totalSupply > 0
                    ? ((acct.balance / stats.totalSupply) * 100).toFixed(2)
                    : "0.00";
                  const isMe = isClaimed && user?.peerId === acct.peerId;
                  return (
                    <tr
                      key={acct.peerId}
                      className={`border-b border-neutral-100 dark:border-neutral-800/50 hover:bg-neutral-50 dark:hover:bg-neutral-900/30 transition ${
                        isMe ? "bg-amber-50 dark:bg-amber-900/10" : ""
                      }`}
                    >
                      <td className="px-4 py-2.5 text-neutral-400 tabular-nums">{idx + 1}</td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-neutral-700 dark:text-neutral-300">
                          {shortPeer(acct.peerId)}
                        </span>
                        {isMe && (
                          <span className="ml-2 px-1.5 py-0.5 text-[9px] rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20 font-medium">you</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-medium text-neutral-900 dark:text-neutral-100 tabular-nums">
                        {luxFmt(acct.balance)}
                        <span className="ml-1 text-[10px] text-amber-500">Lux</span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-neutral-400 tabular-nums hidden sm:table-cell">
                        {share}%
                      </td>
                      <td className="px-4 py-2.5 text-right text-neutral-400 hidden md:table-cell">
                        {relTime(acct.updatedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {accounts.length === 0 && !loading && (
              <p className="py-10 text-center text-sm text-neutral-400">No accounts found</p>
            )}
          </div>
        )}

        {/* Transactions table */}
        {tab === "transactions" && (
          <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50">
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">Type</th>
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">From</th>
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">To</th>
                  <th className="text-right px-4 py-3 text-neutral-500 font-medium">Amount</th>
                  <th className="text-right px-4 py-3 text-neutral-500 font-medium hidden sm:table-cell">Fee</th>
                  <th className="text-right px-4 py-3 text-neutral-500 font-medium hidden md:table-cell">Time</th>
                </tr>
              </thead>
              <tbody>
                {loading && txs.length === 0 ? (
                  [...Array(8)].map((_, i) => (
                    <tr key={i} className="border-b border-neutral-100 dark:border-neutral-800/50">
                      <td className="px-4 py-3"><div className="h-3 w-14 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" /></td>
                      <td className="px-4 py-3"><div className="h-3 w-28 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" /></td>
                      <td className="px-4 py-3"><div className="h-3 w-28 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse" /></td>
                      <td className="px-4 py-3 text-right"><div className="h-3 w-16 bg-neutral-200 dark:bg-neutral-700 rounded animate-pulse ml-auto" /></td>
                    </tr>
                  ))
                ) : txs.map((tx) => (
                  <tr
                    key={tx.id}
                    className="border-b border-neutral-100 dark:border-neutral-800/50 hover:bg-neutral-50 dark:hover:bg-neutral-900/30 transition"
                  >
                    <td className="px-4 py-2.5">
                      <span className={`inline-flex px-2 py-0.5 rounded-full border text-[10px] font-medium ${txTypeBadge(tx.type)}`}>
                        {tx.type}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400">
                      {shortPeer(tx.from)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-neutral-600 dark:text-neutral-400">
                      {shortPeer(tx.to)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono font-medium text-neutral-900 dark:text-neutral-100 tabular-nums">
                      {luxFmt(tx.amount)}
                      <span className="ml-1 text-[10px] text-amber-500">Lux</span>
                    </td>
                    <td className="px-4 py-2.5 text-right text-neutral-400 tabular-nums hidden sm:table-cell">
                      {tx.fee > 0 ? luxFmt(tx.fee) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-neutral-400 hidden md:table-cell">
                      {relTime(tx.timestamp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {txs.length === 0 && !loading && (
              <p className="py-10 text-center text-sm text-neutral-400">No transactions recorded yet</p>
            )}
            {txTotal > txs.length && (
              <div className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 text-xs text-neutral-400 text-center">
                Showing {txs.length} of {txTotal.toLocaleString()} total transactions
              </div>
            )}
          </div>
        )}

        {/* About Lux */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 p-5">
          <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 mb-2">About Lux</h2>
          <div className="space-y-2 text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">
            <p>Lux is the native token of the Pando network. Hard cap: 10 billion Lux. No burning, no halving. Real work earns real pay.</p>
            <p>Nodes earn Lux for uptime, completed tasks, contributing API keys, voting, and accepted governance proposals.</p>
            <p>
              Visit the <a href="/wallet" className="text-amber-500 hover:underline">Wallet</a> page for your own transaction history and balance.
            </p>
          </div>
        </div>

      </main>
    </div>
  );
}
