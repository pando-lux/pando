"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

export default function LandingPage() {
  const [peers, setPeers] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => setPeers(d.peers ?? 0))
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
        <span className="text-xl font-bold tracking-tight">pando</span>
        <div className="flex items-center gap-6 text-sm text-neutral-500 dark:text-neutral-400">
          <a href="#features" className="hover:text-amber-500 dark:hover:text-amber-400 transition-colors duration-200">Features</a>
          <a href="#how" className="hover:text-amber-500 dark:hover:text-amber-400 transition-colors duration-200">How it works</a>
          <Link
            href="/chat"
            className="px-4 py-2 bg-amber-500 text-neutral-950 rounded-lg font-medium hover:bg-amber-400 hover:shadow-md hover:shadow-amber-500/20 transition-all duration-200"
          >
            Get started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="px-6 pt-24 pb-32 max-w-4xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-neutral-200 dark:bg-neutral-800/60 text-sm text-neutral-500 dark:text-neutral-400 mb-8">
          <span className={`w-2 h-2 rounded-full ${peers !== null && peers > 0 ? "bg-green-400" : "bg-neutral-400 dark:bg-neutral-600"}`} />
          {peers !== null ? `${peers} peers online` : "Connecting..."}
        </div>
        <h1 className="text-5xl sm:text-7xl font-bold tracking-tight leading-tight mb-6">
          The internet,
          <br />
          <span className="text-amber-500 dark:text-amber-400">owned by everyone.</span>
        </h1>
        <p className="text-lg sm:text-xl text-neutral-500 dark:text-neutral-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          Pando is a decentralized network where AI builds, humans earn, and
          nobody tracks you. Open source. No ads. No barriers.
        </p>
        <div className="flex items-center justify-center gap-4">
          <Link
            href="/chat"
            className="px-6 py-3 bg-amber-500 text-neutral-950 rounded-lg font-semibold hover:bg-amber-400 hover:scale-[1.02] hover:shadow-lg hover:shadow-amber-500/25 active:scale-[0.98] transition-all duration-200 text-lg"
          >
            Start building
          </Link>
          <a
            href="https://github.com/pando-lux/pando"
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-3 border border-neutral-300 dark:border-neutral-700 rounded-lg font-semibold hover:border-amber-500/50 dark:hover:border-amber-500/50 hover:text-amber-500 dark:hover:text-amber-400 hover:scale-[1.02] hover:shadow-md transition-all duration-200 text-lg"
          >
            View source
          </a>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="px-6 py-16 max-w-6xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-16">
          What makes Pando different
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              title: "AI does the work",
              desc: "Describe what you want. AI agents build it, test it, deploy it. You earn Lux for every contribution.",
              icon: (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 0 0-2.455 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"
                />
              ),
            },
            {
              title: "No tracking, ever",
              desc: "Your data is encrypted end-to-end. No accounts required. No ads. No surveillance. Users are anonymous, services are transparent.",
              icon: (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
                />
              ),
            },
            {
              title: "Earn by participating",
              desc: "Run a node, contribute compute, build apps. The network pays you in Lux — a currency backed by real work, not speculation.",
              icon: (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 6v12m-3-2.818.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                />
              ),
            },
          ].map((f) => (
            <div
              key={f.title}
              className="p-6 rounded-2xl bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-neutral-800 hover:border-amber-500/30 dark:hover:border-amber-500/30 hover:-translate-y-1 hover:shadow-lg hover:shadow-amber-500/5 transition-all duration-200"
            >
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center mb-4">
                <svg
                  className="w-5 h-5 text-amber-500 dark:text-amber-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  {f.icon}
                </svg>
              </div>
              <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
              <p className="text-neutral-500 dark:text-neutral-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="px-6 py-16 max-w-4xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-16">
          How it works
        </h2>
        <div className="space-y-12">
          {[
            {
              step: "01",
              title: "Tell it what you want",
              desc: "Type a message. \"Build me a portfolio site.\" \"Find cheap flights to Tokyo.\" The AI understands intent.",
            },
            {
              step: "02",
              title: "AI agents build it",
              desc: "A council of AI agents plans, codes, tests, and deploys — autonomously. You watch it happen in real time.",
            },
            {
              step: "03",
              title: "It goes live",
              desc: "Your app gets deployed to the network. No server setup. No DevOps. It just works.",
            },
          ].map((s) => (
            <div key={s.step} className="flex gap-6 items-start">
              <span className="text-4xl font-bold text-amber-500/30 font-mono shrink-0">
                {s.step}
              </span>
              <div>
                <h3 className="text-xl font-semibold mb-1">{s.title}</h3>
                <p className="text-neutral-500 dark:text-neutral-400 leading-relaxed">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 py-16 max-w-4xl mx-auto text-center">
        <div className="p-12 rounded-2xl bg-gradient-to-b from-neutral-100 to-white dark:from-neutral-900 dark:to-neutral-950 border border-neutral-200 dark:border-neutral-800">
          <h2 className="text-3xl font-bold mb-4">Ready to try Pando?</h2>
          <p className="text-neutral-500 dark:text-neutral-400 mb-8 max-w-lg mx-auto">
            No sign-up required. Open the chat, describe what you want, and
            watch AI build it.
          </p>
          <Link
            href="/chat"
            className="inline-block px-8 py-3 bg-amber-500 text-neutral-950 rounded-lg font-semibold hover:bg-amber-400 hover:scale-[1.02] hover:shadow-lg hover:shadow-amber-500/25 active:scale-[0.98] transition-all duration-200 text-lg"
          >
            Open Pando
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="px-6 py-8 max-w-6xl mx-auto border-t border-neutral-200 dark:border-neutral-800">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-neutral-500">
          <span>Pando — The Open Network</span>
          <div className="flex items-center gap-6">
            <a
              href="https://github.com/pando-lux/pando"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-amber-500 dark:hover:text-amber-400 transition-colors duration-200"
            >
              GitHub
            </a>
            <Link href="/network" className="hover:text-amber-500 dark:hover:text-amber-400 transition-colors duration-200">
              Network
            </Link>
            <Link href="/governance" className="hover:text-amber-500 dark:hover:text-amber-400 transition-colors duration-200">
              Governance
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
