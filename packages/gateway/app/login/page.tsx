"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import NavBar from "@/components/NavBar";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const router = useRouter();
  const { login, loading, isClaimed } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  // If already claimed (logged in), redirect to home
  useEffect(() => {
    if (!loading && isClaimed) router.push("/");
  }, [loading, isClaimed, router]);

  if (loading || isClaimed) {
    return (
      <div className="min-h-screen bg-white dark:bg-neutral-950">
        <NavBar />
        <main className="max-w-md mx-auto px-6 py-16 text-center text-neutral-500">Loading...</main>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier.trim() || !password) return;

    setError(null);
    setSubmitting(true);
    try {
      const result = await login(identifier.trim(), password);
      if (result.success) {
        setSuccess(true);
        setTimeout(() => router.push("/"), 1500);
      } else {
        setError(result.error || "Login failed");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-md mx-auto px-6 py-16 animate-page-fade-in">
        <div className="space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
              Welcome back
            </h1>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Sign in to your Pando account
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="identifier"
                className="block text-xs font-medium text-neutral-600 dark:text-neutral-400"
              >
                Username or Peer ID
              </label>
              <input
                id="identifier"
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="alice or 12D3KooW..."
                className="w-full px-3 py-2.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition"
                autoFocus
                autoComplete="username"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="password"
                className="block text-xs font-medium text-neutral-600 dark:text-neutral-400"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                className="w-full px-3 py-2.5 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 transition"
                autoComplete="current-password"
              />
            </div>

            {error && (
              <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || success || !identifier.trim() || !password}
              className="w-full py-2.5 rounded-lg bg-amber-500 hover:bg-amber-600 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed text-black font-medium text-sm transition"
            >
              {submitting ? "Signing in..." : "Login"}
            </button>

            {success && (
              <div className="px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-sm text-center">
                Welcome back! Redirecting...
              </div>
            )}
          </form>

          <div className="text-center">
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Don&apos;t have an account?{" "}
              <a
                href="/register"
                className="text-amber-600 dark:text-amber-400 hover:text-amber-500 dark:hover:text-amber-300 transition"
              >
                Sign up
              </a>
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
