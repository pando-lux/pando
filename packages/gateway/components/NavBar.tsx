"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";
import { useAuth } from "@/lib/auth-context";

const links = [
  { href: "/", label: "Home" },
  { href: "/chat", label: "Chat" },
  { href: "/projects", label: "Projects" },
  { href: "/apps", label: "Apps" },
  { href: "/wallet", label: "Wallet" },
  { href: "/network", label: "Network" },
  { href: "/governance", label: "Governance" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/explore", label: "Explore" },
  { href: "/dev", label: "Dev" },
];

function truncatePeerId(peerId: string): string {
  if (peerId.length <= 12) return peerId;
  return peerId.slice(0, 8) + "...";
}

export default function NavBar() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const { user, loading, isClaimed, logout } = useAuth();
  const [nodeHealth, setNodeHealth] = useState<{ healthyCount: number; totalCount: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/gateway/status", { signal: AbortSignal.timeout(5000) });
        if (res.ok && !cancelled) {
          const data = await res.json();
          setNodeHealth({ healthyCount: data.healthyCount, totalCount: data.totalCount });
        }
      } catch {}
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-950/80 backdrop-blur-sm">
      <div className="flex items-center justify-between px-6 py-3">
        <div className="flex items-center gap-6">
          <a href="/" className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100 hover:text-amber-500 dark:hover:text-amber-400 transition flex items-center gap-2">
            Pando
            {nodeHealth && (
              <span className="flex items-center gap-1 text-[10px] font-normal">
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                  nodeHealth.healthyCount === 0
                    ? "bg-red-500"
                    : nodeHealth.healthyCount < nodeHealth.totalCount
                      ? "bg-amber-500"
                      : "bg-emerald-500"
                }`} />
                <span className="text-neutral-400 dark:text-neutral-500">
                  {nodeHealth.healthyCount}/{nodeHealth.totalCount}
                </span>
              </span>
            )}
          </a>
          <nav className="hidden lg:flex items-center gap-1">
            {links.map(({ href, label }) => {
              const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <a
                  key={href}
                  href={href}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
                    active
                      ? "bg-amber-500/15 text-amber-500 dark:text-amber-400 border border-amber-500/25"
                      : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  }`}
                >
                  {label}
                </a>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {/* Auth state display */}
          {!loading && (
            <div className="hidden lg:flex items-center gap-2">
              {isClaimed ? (
                <>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400 font-mono">
                    {user?.username || truncatePeerId(user?.peerId || "")}
                  </span>
                  <button
                    onClick={() => logout()}
                    className="text-xs px-2.5 py-1 rounded-full text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
                  >
                    Logout
                  </button>
                </>
              ) : (
                <>
                  <a
                    href="/login"
                    className="text-xs px-2.5 py-1 rounded-full text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
                  >
                    Login
                  </a>
                  <a
                    href="/register"
                    className="text-xs px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/25 hover:bg-amber-500/20 transition font-medium"
                  >
                    Sign up
                  </a>
                </>
              )}
            </div>
          )}
          <ThemeToggle />
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="lg:hidden p-2 rounded-lg bg-neutral-200 dark:bg-neutral-800 hover:bg-neutral-300 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-400 transition"
            aria-label="Toggle menu"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {menuOpen ? (
                <>
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </>
              ) : (
                <>
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>
      {menuOpen && (
        <nav className="lg:hidden px-6 pb-3 flex flex-col gap-1">
          {links.map(({ href, label }) => {
            const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
            return (
              <a
                key={href}
                href={href}
                onClick={() => setMenuOpen(false)}
                className={`px-3 py-2 text-sm font-medium rounded-lg transition ${
                  active
                    ? "bg-amber-500/15 text-amber-500 dark:text-amber-400 border border-amber-500/25"
                    : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                }`}
              >
                {label}
              </a>
            );
          })}
          {/* Mobile auth links */}
          {!loading && (
            <div className="border-t border-neutral-200 dark:border-neutral-800 mt-2 pt-2 flex flex-col gap-1">
              {isClaimed ? (
                <>
                  <div className="px-3 py-1 text-xs text-neutral-500 dark:text-neutral-400 font-mono">
                    {user?.username || truncatePeerId(user?.peerId || "")}
                  </div>
                  <a
                    href="/wallet"
                    onClick={() => setMenuOpen(false)}
                    className="px-3 py-2 text-sm font-medium rounded-lg text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
                  >
                    Wallet
                  </a>
                  <button
                    onClick={() => { logout(); setMenuOpen(false); }}
                    className="text-left px-3 py-2 text-sm font-medium rounded-lg text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
                  >
                    Logout
                  </button>
                </>
              ) : (
                <>
                  <a
                    href="/login"
                    onClick={() => setMenuOpen(false)}
                    className="px-3 py-2 text-sm font-medium rounded-lg text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition"
                  >
                    Login
                  </a>
                  <a
                    href="/register"
                    onClick={() => setMenuOpen(false)}
                    className="px-3 py-2 text-sm font-medium rounded-lg text-amber-600 dark:text-amber-400 hover:bg-amber-500/10 transition"
                  >
                    Sign up
                  </a>
                </>
              )}
            </div>
          )}
        </nav>
      )}
    </header>
  );
}
