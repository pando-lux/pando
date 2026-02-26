"use client";

import { useState } from "react";
import NavBar from "@/components/NavBar";

interface SearchResult {
  answer: string;
  sources: string[];
  confidence: string;
  respondedBy: string;
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const data: SearchResult = await res.json();
      if (data.confidence === "none" && data.respondedBy === "gateway-error") {
        setError(data.answer);
      } else {
        setResult(data);
      }
    } catch {
      setError("Network error. Make sure a Pando node is running.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-3xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            AI Search
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Search the web with AI understanding. Get synthesized answers with sources.
          </p>
        </div>

        {/* Search Form */}
        <form onSubmit={handleSearch} className="space-y-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ask anything..."
              className="flex-1 bg-neutral-100 dark:bg-neutral-900 border border-neutral-300 dark:border-neutral-700 rounded-lg px-4 py-2.5 text-sm text-neutral-900 dark:text-neutral-100 placeholder-neutral-400 dark:placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-medium rounded-lg px-5 py-2.5 text-sm transition shrink-0"
            >
              Search
            </button>
          </div>
        </form>

        {/* Loading Spinner */}
        {loading && (
          <div className="flex items-center justify-center gap-3 py-8">
            <svg className="animate-spin h-5 w-5 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="text-sm text-neutral-500 dark:text-neutral-400">Searching…</span>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-5 space-y-4">
            {/* Confidence badge */}
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                  result.confidence === "high"
                    ? "bg-green-500/15 text-green-400 border-green-500/25"
                    : result.confidence === "medium"
                      ? "bg-amber-500/15 text-amber-400 border-amber-500/25"
                      : "bg-neutral-500/15 text-neutral-400 border-neutral-500/25"
                }`}
              >
                {result.confidence} confidence
              </span>
              {result.respondedBy && (
                <span className="text-[10px] text-neutral-500 dark:text-neutral-500">
                  via {result.respondedBy}
                </span>
              )}
            </div>

            {/* Answer */}
            <div className="text-sm text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap leading-relaxed">
              {result.answer}
            </div>

            {/* Sources */}
            {result.sources && result.sources.length > 0 && (
              <div className="border-t border-neutral-200 dark:border-neutral-800 pt-3 space-y-2">
                <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
                  Sources
                </p>
                <ul className="space-y-1">
                  {result.sources.map((src, i) => (
                    <li key={i} className="text-xs text-amber-600 dark:text-amber-400 truncate">
                      {src.startsWith("http") ? (
                        <a
                          href={src}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-amber-500 dark:hover:text-amber-300 transition"
                        >
                          {src}
                        </a>
                      ) : (
                        <span>{src}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Tip */}
        {!result && !error && !loading && (
          <div className="text-center pt-12 space-y-3">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-500">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Enter a query to search with AI. Results are powered by contributed API keys on the Pando network.
            </p>
            <p className="text-xs text-neutral-400 dark:text-neutral-500">
              For longer conversations, use{" "}
              <a href="/chat" className="text-amber-600 dark:text-amber-400 hover:text-amber-500 dark:hover:text-amber-300 transition">
                Chat
              </a>
              .
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
