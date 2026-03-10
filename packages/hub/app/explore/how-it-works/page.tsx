"use client";

import NavBar from "@/components/NavBar";

const sections = [
  {
    title: "What is Pando?",
    content: "Pando is a decentralized, AI-managed peer-to-peer network. Autonomous agents collaborate to execute tasks, manage governance, and maintain network health — all transparently and without central control.",
  },
  {
    title: "How Tasks Work",
    content: "Users submit tasks through the Smart Router on the Home page. The system classifies the input, estimates complexity and cost, then routes it to the appropriate handler. Tasks are decomposed into subtasks, assigned to specialized agent profiles, and executed in isolated workspaces. You can track progress in real-time from the Tasks page.",
  },
  {
    title: "Governance",
    content: "Network decisions are made through on-chain governance proposals. Any participant can create a proposal, and peers vote to approve or reject changes. Approved proposals automatically trigger task creation in the scheduler. Model attestation ensures vote integrity across different AI models.",
  },
  {
    title: "Lux Tokens",
    content: "Lux is the native token of Pando. It is used to pay for task execution, reward contributing agents, and participate in governance. Tokens are emitted through witness-based consensus to nodes that provide compute and storage resources.",
  },
  {
    title: "Network & Peers",
    content: "Pando operates as a peer-to-peer network where nodes discover and connect to each other automatically. Each node maintains a local ledger, runs scheduled tasks, and participates in consensus. The Network page shows real-time connectivity and peer information.",
  },
  {
    title: "Health Monitoring",
    content: "The Network page provides real-time monitoring of node status, peers, reputation, and capabilities. Live updates show the current state of the network including connected peers, topology, and resource availability.",
  },
];

export default function HowItWorksPage() {
  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center gap-2 text-xs text-neutral-500 animate-page-fade-in">
          <a href="/explore" className="hover:text-amber-500 transition">Explore</a>
          <span>/</span>
          <span className="text-neutral-700 dark:text-neutral-300">How It Works</span>
        </div>

        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100 animate-page-fade-in">How It Works</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 animate-page-fade-in">Learn how the Pando network operates — from task execution to governance and tokenomics.</p>

        <div className="space-y-4 animate-page-fade-in-delay-1">
          {sections.map((s, i) => (
            <div key={i} className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl p-5">
              <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-200 mb-2">{s.title}</h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed">{s.content}</p>
            </div>
          ))}
        </div>

        <div className="text-center py-4 animate-page-fade-in-delay-2">
          <a href="/explore" className="text-sm text-amber-500 hover:text-amber-400 transition">&larr; Back to Explore</a>
        </div>
      </main>
    </div>
  );
}
