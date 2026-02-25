"use client";

import { useState, useEffect, useCallback } from "react";
import NavBar from "@/components/NavBar";

/* -- Types ------------------------------------------------- */

interface CouncilMember {
  peerId: string;
  reputation: number;
  hasClaudeCode: boolean;
  uptimeHours: number;
}

interface CouncilData {
  members: CouncilMember[];
  selectedAt: number;
  rotatesAt: number;
  thisNodeOnCouncil: boolean;
}

interface MinutesData {
  minutes: string;
}

/* -- Helpers ------------------------------------------------ */

function shortPeerId(peerId: string): string {
  if (peerId.length <= 16) return peerId;
  return peerId.slice(0, 8) + "..." + peerId.slice(-6);
}

function formatDate(ts: number): string {
  if (!ts) return "--";
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function daysRemaining(rotatesAt: number): string {
  if (!rotatesAt) return "--";
  const ms = rotatesAt - Date.now();
  if (ms <= 0) return "Rotation due";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

/* -- Page -------------------------------------------------- */

export default function CouncilPage() {
  const [council, setCouncil] = useState<CouncilData | null>(null);
  const [minutes, setMinutes] = useState<MinutesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [councilRes, minutesRes] = await Promise.all([
        fetch("/api/council"),
        fetch("/api/council/minutes"),
      ]);

      if (councilRes.ok) {
        setCouncil(await councilRes.json());
        setError(null);
      } else {
        setError("Failed to load council data");
      }

      if (minutesRes.ok) {
        setMinutes(await minutesRes.json());
      }
    } catch {
      setError("Node not reachable");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const i = setInterval(fetchData, 60000);
    return () => clearInterval(i);
  }, [fetchData]);

  /* -- Derived data ----------------------------------------- */

  const members = council?.members || [];
  const hasMembers = members.length > 0;

  /* -- Render ----------------------------------------------- */

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            Network Council
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            Rotating council of top-reputation AI-capable nodes for autonomous
            reflection. Auto-refreshes every 60s.
          </p>
        </div>

        {/* Loading / Error states */}
        {loading && (
          <div className="text-center py-12 text-neutral-500">
            Loading council data...
          </div>
        )}

        {!loading && error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
            <p className="text-sm text-red-400">{error}</p>
            <p className="text-xs text-neutral-500 mt-1">
              Make sure a Pando node is running and reachable.
            </p>
          </div>
        )}

        {!loading && !error && council && (
          <>
            {/* ---- 1. Rotation Info ---- */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <StatCard
                label="Council Members"
                value={members.length}
                accent="text-indigo-400"
              />
              <StatCard
                label="Selected"
                value={council.selectedAt ? formatDate(council.selectedAt) : "--"}
                accent="text-neutral-300"
                small
              />
              <StatCard
                label="Next Rotation"
                value={council.rotatesAt ? formatDate(council.rotatesAt) : "--"}
                accent="text-neutral-300"
                small
              />
              <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
                <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">
                  This Node
                </p>
                {council.thisNodeOnCouncil ? (
                  <span className="inline-block text-xs px-2.5 py-1 rounded-full font-medium border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                    On Council
                  </span>
                ) : (
                  <span className="inline-block text-xs px-2.5 py-1 rounded-full font-medium border bg-neutral-500/20 text-neutral-400 border-neutral-500/30">
                    Not on Council
                  </span>
                )}
              </div>
            </div>

            {/* ---- 2. Council Members Table ---- */}
            <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                  Council Members
                </h2>
                <span className="text-[10px] text-neutral-500 font-mono">
                  {daysRemaining(council.rotatesAt)} until rotation
                </span>
              </div>

              {!hasMembers ? (
                <div className="px-4 py-8 text-center">
                  <p className="text-sm text-neutral-500">
                    No council members selected yet. Council selection requires
                    AI-capable nodes with reputation scores.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-neutral-500 border-b border-neutral-200 dark:border-neutral-800">
                        <th className="text-left px-4 py-2 font-medium">
                          Peer ID
                        </th>
                        <th className="text-right px-4 py-2 font-medium">
                          Reputation
                        </th>
                        <th className="text-center px-4 py-2 font-medium">
                          Claude Code
                        </th>
                        <th className="text-right px-4 py-2 font-medium">
                          Uptime (hours)
                        </th>
                        <th className="text-center px-4 py-2 font-medium">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                      {members.map((member) => (
                        <tr
                          key={member.peerId}
                          className="hover:bg-neutral-100/50 dark:hover:bg-neutral-800/30 transition"
                        >
                          <td className="px-4 py-2.5 font-mono text-neutral-800 dark:text-neutral-200">
                            {shortPeerId(member.peerId)}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-neutral-700 dark:text-neutral-300">
                            {member.reputation.toFixed(2)}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            {member.hasClaudeCode ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/25 font-medium">
                                Yes
                              </span>
                            ) : (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-neutral-500/15 text-neutral-400 border border-neutral-500/25 font-medium">
                                No
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-neutral-700 dark:text-neutral-300">
                            {member.uptimeHours}
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            {council.thisNodeOnCouncil &&
                            member.peerId ===
                              members.find(() => council.thisNodeOnCouncil)
                                ?.peerId ? (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/25 font-medium">
                                This Node
                              </span>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ---- 3. Council Minutes ---- */}
            <div className="bg-white dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
                <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                  Council Minutes
                </h2>
              </div>

              <div className="px-4 py-4">
                {minutes?.minutes &&
                minutes.minutes.trim() !== "" &&
                !minutes.minutes.includes("(no entries yet)") ? (
                  <pre className="text-xs font-mono text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap leading-relaxed bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 max-h-96 overflow-y-auto">
                    {minutes.minutes}
                  </pre>
                ) : (
                  <div className="text-center py-6">
                    <p className="text-sm text-neutral-500">
                      No council minutes yet. Reflections start after 24 hours.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* ---- 4. Network State Link ---- */}
            <div className="bg-gradient-to-br from-indigo-500/10 to-violet-500/10 border border-indigo-500/20 rounded-xl p-6 text-center">
              <h3 className="text-lg font-bold text-neutral-900 dark:text-neutral-100 mb-2">
                Network State
              </h3>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-xl mx-auto mb-4">
                The council reads a snapshot of the full network state before
                each reflection session. This includes performance metrics,
                economic data, and user activity.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3 text-xs font-mono text-neutral-500 dark:text-neutral-400">
                <span className="bg-neutral-200 dark:bg-neutral-800 px-3 py-1.5 rounded-lg border border-neutral-300 dark:border-neutral-700">
                  HealthMonitor + CapabilityRegistry + Ledger + Scheduler
                </span>
              </div>
            </div>
          </>
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
  small,
}: {
  label: string;
  value: number | string;
  accent?: string;
  small?: boolean;
}) {
  return (
    <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-3 text-center">
      <p className="text-xs text-neutral-600 dark:text-neutral-500 mb-1">
        {label}
      </p>
      <p
        className={`${
          small ? "text-xs" : "text-lg"
        } font-mono font-bold ${accent || "text-neutral-800 dark:text-neutral-200"}`}
      >
        {value ?? "--"}
      </p>
    </div>
  );
}
