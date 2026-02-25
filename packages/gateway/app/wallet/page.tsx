"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";
import { useAuth } from "@/lib/auth-context";

interface Peer { peerId: string; balance: number; connectedAt: number }
interface Transaction { id: string; from: string; to: string; amount: number; type: string; timestamp: number; fee?: number }

export default function WalletPage() {
  const { user, loading: authLoading, token } = useAuth();
  const [peers, setPeers] = useState<Peer[]>([]);
  const [txns, setTxns] = useState<Transaction[]>([]);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ ok?: boolean; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [nodeStatus, setNodeStatus] = useState<{ identity: string; balance: number; publicKey: string } | null>(null);

  // Derive balance and peerId from authenticated user context, with node fallback
  const balance = user?.balance ?? nodeStatus?.balance ?? null;
  const peerId = user?.peerId ?? nodeStatus?.identity ?? "";
  const pubKey = user?.publicKey ?? nodeStatus?.publicKey ?? "";

  const fetchData = useCallback(async () => {
    // Build headers with user token for authenticated transaction fetching
    const txHeaders: Record<string, string> = {};
    if (token) txHeaders["Authorization"] = `Bearer ${token}`;

    const [p, t, s] = await Promise.all([
      fetch("/api/peers").then(r => r.json()).catch(() => ({ peers: [] })),
      fetch("/api/transactions?limit=20", { headers: txHeaders }).then(r => r.json()).catch(() => ({ transactions: [], peerId: "" })),
      fetch("/api/status").then(r => r.json()).catch(() => null),
    ]);
    if (p?.peers) setPeers(p.peers);
    if (s) setNodeStatus({ identity: s.identity || "", balance: s.balance || 0, publicKey: s.publicKey || "" });
    if (t) {
      // Node already filters transactions for the authenticated user's peerId
      setTxns(t.transactions || []);
    }
  }, [token]);

  useEffect(() => {
    fetchData();
    const i = setInterval(fetchData, 10000);
    return () => clearInterval(i);
  }, [fetchData]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!recipient.trim() || !amount.trim()) return;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setSendMsg({ text: "Invalid amount" }); return; }
    setSending(true); setSendMsg(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetch("/api/transfer", {
        method: "POST", headers,
        body: JSON.stringify({ to: recipient.trim(), amount: amt }),
      });
      const data = await res.json();
      if (res.ok) {
        setSendMsg({ ok: true, text: `Sent ${amt} Lux` });
        setAmount("");
        setRecipient("");
        // Refresh wallet data immediately and again after a short delay
        // to pick up the updated balance and transaction list
        await fetchData();
        setTimeout(fetchData, 2000);
      } else {
        setSendMsg({ text: data.error || "Transfer failed" });
      }
    } catch { setSendMsg({ text: "Network error" }); }
    setSending(false);
  }

  function copyId() {
    navigator.clipboard.writeText(peerId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function shortId(id: string) { return id.length > 20 ? id.slice(0, 8) + "\u2026" + id.slice(-6) : id; }
  function relTime(ts: number) {
    const d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
    if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
    return `${Math.floor(d / 86400000)}d ago`;
  }

  function txType(tx: Transaction): { label: string; cls: string } {
    if (tx.from === "NETWORK") return { label: "Earned", cls: "text-green-400" };
    if (tx.to === peerId) return { label: "Received", cls: "text-green-400" };
    if (tx.from === peerId) return { label: "Sent", cls: "text-red-400" };
    return { label: tx.type || "Transfer", cls: "text-neutral-400" };
  }

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">Wallet</h1>

        {/* Balance */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-6 text-center">
          <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-2">Your Balance</p>
          {authLoading && balance === null ? (
            <div className="h-10 w-40 mx-auto rounded-md bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          ) : (
            <p className="text-4xl font-bold text-amber-500 dark:text-amber-400">{balance !== null ? balance.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0"} <span className="text-lg text-neutral-500">Lux</span></p>
          )}
        </div>

        {/* Send Lux */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4 space-y-3">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Send Lux</h2>
          <form onSubmit={handleSend} className="space-y-3">
            <div className="flex gap-3">
              <div className="flex-1">
                <input type="text" list="peer-list" value={recipient} onChange={e => setRecipient(e.target.value)}
                  placeholder="Recipient peer ID" className="w-full bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50" />
                <datalist id="peer-list">{peers.map(p => <option key={p.peerId} value={p.peerId}>{shortId(p.peerId)}</option>)}</datalist>
              </div>
              <input type="number" step="any" min="0" value={amount} onChange={e => setAmount(e.target.value)}
                placeholder="Amount" className="w-32 bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50" />
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" disabled={sending || !recipient.trim() || !amount.trim()}
                className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-4 py-2 text-sm transition">
                {sending ? "Sending..." : "Send"}
              </button>
              {sendMsg && <span className={`text-xs ${sendMsg.ok ? "text-green-400" : "text-red-400"}`}>{sendMsg.text}</span>}
            </div>
          </form>
        </div>

        {/* Identity */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-4 space-y-3">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Your Identity</h2>
          <div className="flex items-center gap-2">
            {authLoading && !peerId ? (
              <div className="h-6 flex-1 rounded-md bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
            ) : (
              <code className="text-xs text-neutral-600 dark:text-neutral-400 font-mono bg-neutral-200 dark:bg-neutral-800 px-2 py-1 rounded flex-1 truncate">{peerId || "Not connected"}</code>
            )}
            <button onClick={copyId} disabled={!peerId} className="bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 disabled:opacity-50 text-neutral-700 dark:text-neutral-300 rounded-lg px-3 py-1 text-xs transition">{copied ? "Copied!" : "Copy"}</button>
          </div>
          {pubKey && (
            <div>
              <button onClick={() => setShowKey(!showKey)} className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition">{showKey ? "Hide" : "Show"} public key</button>
              {showKey && <code className="block mt-1 text-xs text-neutral-500 font-mono bg-neutral-200 dark:bg-neutral-800 px-2 py-1 rounded break-all">{pubKey}</code>}
            </div>
          )}
        </div>

        {/* Transactions */}
        <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800"><h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Recent Transactions</h2></div>
          {txns.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-neutral-500">No transactions yet</div>
          ) : (
            <div className="divide-y divide-neutral-200 dark:divide-neutral-800 max-h-[400px] overflow-y-auto">
              {txns.map((tx, i) => {
                const t = txType(tx);
                return (
                  <div key={tx.id || i} className="px-4 py-2.5 flex items-center gap-3 text-xs">
                    <span className="text-neutral-500 font-mono w-16 shrink-0">{tx.timestamp ? relTime(tx.timestamp) : "—"}</span>
                    <span className={`font-medium w-16 shrink-0 ${t.cls}`}>{t.label}</span>
                    <span className="text-neutral-600 dark:text-neutral-400 font-mono truncate flex-1">{tx.from === peerId ? `To: ${shortId(tx.to)}` : `From: ${shortId(tx.from)}`}</span>
                    <span className="text-neutral-800 dark:text-neutral-200 font-mono font-medium shrink-0">{tx.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} Lux</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
