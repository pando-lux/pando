"use client";

import { useState } from "react";
import NavBar from "@/components/NavBar";

/* -- Provider Data ----------------------------------------- */

interface Provider {
  name: string;
  services: string;
  type: string;
  typeBadgeClass: string;
  steps: string[];
  freeTier: string | null;
  cost: string;
  tuiCommand: string;
  reward: string;
  note?: string;
  important?: string;
}

const providers: Provider[] = [
  {
    name: "OpenAI",
    services: "AI Search, Chat",
    type: "ai_api_key",
    typeBadgeClass: "bg-indigo-500/15 text-indigo-400 border-indigo-500/25",
    steps: [
      "Go to platform.openai.com",
      "Sign up for an account (or log in)",
      'Navigate to API Keys in the sidebar',
      'Click "Create new secret key"',
      "Copy the key (starts with sk-)",
      "Contribute it to Pando using the command below",
    ],
    freeTier: "$5 credit for new accounts",
    cost: "~$0.001 per query",
    tuiCommand: "/contribute openai sk-...",
    reward: "2.0 Lux",
  },
  {
    name: "Anthropic",
    services: "AI Agents",
    type: "ai_api_key",
    typeBadgeClass: "bg-indigo-500/15 text-indigo-400 border-indigo-500/25",
    steps: [
      "Go to console.anthropic.com",
      "Sign up for an account (or log in)",
      'Navigate to API Keys',
      'Click "Create key"',
      "Copy the key (starts with sk-ant-)",
      "Contribute it to Pando using the command below",
    ],
    freeTier: null,
    cost: "Pay-as-you-go",
    tuiCommand: "/contribute anthropic sk-ant-...",
    reward: "2.0 Lux",
  },
  {
    name: "Google Gemini",
    services: "AI Search alternative",
    type: "ai_api_key",
    typeBadgeClass: "bg-indigo-500/15 text-indigo-400 border-indigo-500/25",
    steps: [
      "Go to ai.google.dev",
      'Click "Get API key"',
      "Create a key in a Google Cloud project",
      "Copy the generated key",
      "Contribute it to Pando using the command below",
    ],
    freeTier: "15 RPM, 1M tokens/day free",
    cost: "Free tier generous for most usage",
    tuiCommand: "/contribute gemini AI...",
    reward: "2.0 Lux",
  },
  {
    name: "MongoDB Atlas",
    services: "User Data Storage",
    type: "storage_db",
    typeBadgeClass: "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
    steps: [
      "Go to cloud.mongodb.com and sign up (or log in)",
      'Create a new cluster — select M0 Free Tier (512MB storage)',
      'Go to Database Access — create a new database user with "readWriteAnyDatabase" role',
      'Go to Network Access — click "Add IP Address" and enter 0.0.0.0/0 (allow all IPs — required for P2P access)',
      'Go back to your cluster and click "Connect"',
      'Select "Drivers" as the connection method',
      "Copy the connection string and replace <password> with your database user password",
      'Your final string looks like: mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/pando',
      "Contribute it to Pando using the command below",
    ],
    freeTier: "512MB storage (M0 Free Tier)",
    cost: "Free for small usage, paid plans for more storage",
    tuiCommand: "/contribute mongodb mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/pando",
    reward: "2.0 Lux",
  },
  {
    name: "AWS S3",
    services: "File Storage, Deployments",
    type: "storage_blob",
    typeBadgeClass: "bg-teal-500/15 text-teal-400 border-teal-500/25",
    steps: [
      "Go to aws.amazon.com and sign up (or log in)",
      "Open the IAM console and create a new IAM User",
      'Attach the "AmazonS3FullAccess" policy to the user',
      'Create an access key for the user — save both the Access Key ID and Secret Access Key',
      "Open the S3 console and create a new bucket (pick a unique name and your preferred region)",
      "Contribute via the gateway Resources page (separate fields) or use the TUI command below",
    ],
    freeTier: "5GB storage, 20k GET, 2k PUT/month free for 12 months",
    cost: "~$0.023/GB/month after free tier",
    tuiCommand: '/contribute aws {"accessKeyId":"...","secretAccessKey":"...","region":"...","bucket":"..."}',
    reward: "2.0 Lux",
  },
  {
    name: "GitHub",
    services: "Code Repositories",
    type: "code_repository",
    typeBadgeClass: "bg-orange-500/15 text-orange-400 border-orange-500/25",
    steps: [
      "Go to github.com — sign up or log in",
      "Go to Settings > Developer Settings > Personal Access Tokens > Tokens (classic)",
      'Click "Generate new token (classic)"',
      'Name it "Pando Network" or similar',
      "Select scopes: repo (full control of private repositories)",
      'Click "Generate token"',
      "Copy the token (starts with ghp_)",
      "In TUI: /contribute github ghp_your-token-here",
      "Or use the Resources page contribute form",
    ],
    freeTier: "Unlimited public repos, unlimited private repos",
    cost: "Free for most usage",
    tuiCommand: "/contribute github ghp_...",
    reward: "2.0 Lux",
    important: "Token grants access to ALL repos on your account. Consider using a dedicated GitHub account for Pando.",
  },
  {
    name: "AWS Compute (EC2/Lambda)",
    services: "Servers, Background Jobs",
    type: "cloud_compute",
    typeBadgeClass: "bg-amber-500/15 text-amber-400 border-amber-500/25",
    steps: [
      "Go to aws.amazon.com — same account as S3",
      "Go to IAM > Users > select your Pando user (or create a new one)",
      'Attach policies: AmazonEC2FullAccess + AWSLambda_FullAccess (or scoped to specific resources)',
      'If new user: create access key (use case: "Application running outside AWS")',
      "Save Access Key ID + Secret Access Key",
      "Contribute via gateway Resources page (separate fields for key ID + secret)",
      'Or TUI: /contribute ec2 {"accessKeyId":"AKIA...","secretAccessKey":"..."}',
    ],
    freeTier: "750 hours t2.micro/month for 12 months",
    cost: "Varies by instance type",
    tuiCommand: '/contribute ec2 {"accessKeyId":"AKIA...","secretAccessKey":"..."}',
    reward: "2.0 Lux",
    important: "This credential can create EC2 instances that cost money. Set billing alerts!",
  },
];

/* -- Reward Table Data ------------------------------------- */

const rewardRows = [
  { resource: "AI API Key (OpenAI, Anthropic, Gemini)", reward: "2.0 Lux", multiplier: "10.0 Lux" },
  { resource: "Database (MongoDB Atlas)", reward: "2.0 Lux", multiplier: "10.0 Lux" },
  { resource: "Blob Storage (AWS S3)", reward: "2.0 Lux", multiplier: "10.0 Lux" },
  { resource: "Code Repository (GitHub)", reward: "2.0 Lux", multiplier: "10.0 Lux" },
  { resource: "Cloud Compute (EC2/Lambda)", reward: "2.0 Lux", multiplier: "10.0 Lux" },
  { resource: "Node with Claude Code — per task completed", reward: "5.0 Lux", multiplier: "25.0 Lux" },
  { resource: "Node Uptime (per 10-min epoch)", reward: "0.05 Lux", multiplier: "0.25 Lux" },
  { resource: "Task Completed", reward: "5.0 Lux", multiplier: "25.0 Lux" },
];

/* -- Page -------------------------------------------------- */

export default function ResourceGuidePage() {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  function toggle(idx: number) {
    setOpenIdx(openIdx === idx ? null : idx);
  }

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <NavBar />
      <main className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-xs text-neutral-500 animate-page-fade-in">
          <a href="/resources" className="hover:text-amber-500 transition">Resources</a>
          <span>/</span>
          <span className="text-neutral-700 dark:text-neutral-300">Contribution Guide</span>
        </div>

        {/* Hero */}
        <div className="space-y-2 animate-page-fade-in">
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            How to Contribute Resources
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 max-w-2xl">
            Earn Lux by sharing API keys, storage, and compute with the Pando network.
            Every resource you contribute makes the network stronger and earns you
            rewards. This guide walks you through each provider step by step.
          </p>
        </div>

        {/* Reward Table */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden animate-page-fade-in-delay-1">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800">
            <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
              Reward Overview
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-300 dark:border-neutral-800">
                  <th className="text-left px-4 py-2 text-xs font-medium text-neutral-500 uppercase tracking-wide">Resource</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-neutral-500 uppercase tracking-wide">Base Reward</th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-neutral-500 uppercase tracking-wide">Early Adopter (5x)</th>
                </tr>
              </thead>
              <tbody>
                {rewardRows.map((row, i) => (
                  <tr key={i} className="border-b border-neutral-200 dark:border-neutral-800 last:border-b-0">
                    <td className="px-4 py-2.5 text-neutral-700 dark:text-neutral-300">{row.resource}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-amber-600 dark:text-amber-400">{row.reward}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-amber-500">{row.multiplier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 border-t border-neutral-200 dark:border-neutral-800">
            <p className="text-[10px] text-neutral-500">
              Early adopter multiplier: accounts 1-100 get 5x, 101-1,000 get 3x, 1,001-10,000 get 2x, then 1x.
            </p>
          </div>
        </div>

        {/* Provider Sections */}
        <div className="space-y-3 animate-page-fade-in-delay-2">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Provider Setup Guides
          </h2>
          {providers.map((p, idx) => (
            <div
              key={p.name}
              className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden"
            >
              {/* Header / Toggle */}
              <button
                onClick={() => toggle(idx)}
                className="w-full px-4 py-3.5 text-left flex items-center justify-between hover:bg-neutral-200/50 dark:hover:bg-neutral-800/50 transition"
              >
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                    {p.name}
                  </span>
                  <span className="text-xs text-neutral-500 dark:text-neutral-400">
                    {p.services}
                  </span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium border ${p.typeBadgeClass}`}>
                    {p.type.replace(/_/g, " ")}
                  </span>
                </div>
                <span className="text-neutral-500 text-sm ml-2 shrink-0">
                  {openIdx === idx ? "\u25B2" : "\u25BC"}
                </span>
              </button>

              {/* Expanded Content */}
              {openIdx === idx && (
                <div className="px-4 pb-4 border-t border-neutral-300 dark:border-neutral-800 pt-4 space-y-4">
                  {/* Note (e.g. Claude Code special notice) */}
                  {p.note && (
                    <div className="bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed">
                      {p.note}
                    </div>
                  )}

                  {/* Steps */}
                  <ol className="space-y-2">
                    {p.steps.map((step, si) => (
                      <li key={si} className="flex items-start gap-3 text-sm">
                        <span className="w-5 h-5 rounded-full bg-amber-500/15 border border-amber-500/25 text-amber-500 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                          {si + 1}
                        </span>
                        <span className="text-neutral-700 dark:text-neutral-300 leading-relaxed">
                          {step}
                        </span>
                      </li>
                    ))}
                  </ol>

                  {/* Important notice */}
                  {p.important && (
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed">
                      <span className="font-semibold text-amber-600 dark:text-amber-400">Important: </span>
                      {p.important}
                    </div>
                  )}

                  {/* Cost & Free Tier */}
                  <div className="flex flex-wrap gap-4 text-xs">
                    {p.freeTier && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wide">Free tier</span>
                        <span className="text-green-500 dark:text-green-400">{p.freeTier}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wide">Cost</span>
                      <span className="text-neutral-600 dark:text-neutral-400">{p.cost}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wide">Reward</span>
                      <span className="font-mono text-amber-500">{p.reward}</span>
                    </div>
                  </div>

                  {/* TUI Command */}
                  <div>
                    <p className="text-[10px] font-medium text-neutral-500 uppercase tracking-wide mb-1">TUI Command</p>
                    <div className="bg-neutral-200 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 font-mono text-xs text-neutral-800 dark:text-neutral-200 overflow-x-auto">
                      {p.tuiCommand}
                    </div>
                  </div>

                  {/* Alt link */}
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    Or use the{" "}
                    <a href="/resources" className="text-amber-500 hover:text-amber-400 transition underline">
                      Resources page
                    </a>{" "}
                    to contribute through the web interface.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Claude Code Node Setup */}
        <div className="bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-300 dark:border-neutral-800 rounded-xl overflow-hidden animate-page-fade-in-delay-2">
          <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center gap-3">
            <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
              Claude Code Node Setup
            </h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium border bg-violet-500/15 text-violet-400 border-violet-500/25">
              node capability
            </span>
          </div>
          <div className="px-4 pb-4 pt-4 space-y-4">
            <div className="bg-violet-500/10 border border-violet-500/20 rounded-lg px-3 py-2 text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed">
              Claude Code is not a contributed resource — it is a <strong>node capability</strong>.
              Your node detects Claude Code automatically and broadcasts it to the network.
              It appears under &ldquo;My Nodes&rdquo; on the Resources page, not as a contributed resource.
            </div>

            <ol className="space-y-2">
              <li className="flex items-start gap-3 text-sm">
                <span className="w-5 h-5 rounded-full bg-violet-500/15 border border-violet-500/25 text-violet-400 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">1</span>
                <span className="text-neutral-700 dark:text-neutral-300 leading-relaxed">
                  Install Claude Code on the machine running your Pando node:{" "}
                  <code className="bg-neutral-200 dark:bg-neutral-800 px-1 py-0.5 rounded text-xs">npm install -g @anthropic-ai/claude-code</code>
                </span>
              </li>
              <li className="flex items-start gap-3 text-sm">
                <span className="w-5 h-5 rounded-full bg-violet-500/15 border border-violet-500/25 text-violet-400 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">2</span>
                <span className="text-neutral-700 dark:text-neutral-300 leading-relaxed">
                  Authenticate via the browser: run{" "}
                  <code className="bg-neutral-200 dark:bg-neutral-800 px-1 py-0.5 rounded text-xs">claude</code>{" "}
                  and follow the login flow (creates <code className="bg-neutral-200 dark:bg-neutral-800 px-1 py-0.5 rounded text-xs">~/.claude/.credentials.json</code>).
                  Alternatively, set the <code className="bg-neutral-200 dark:bg-neutral-800 px-1 py-0.5 rounded text-xs">ANTHROPIC_API_KEY</code> environment variable.
                </span>
              </li>
              <li className="flex items-start gap-3 text-sm">
                <span className="w-5 h-5 rounded-full bg-violet-500/15 border border-violet-500/25 text-violet-400 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">3</span>
                <span className="text-neutral-700 dark:text-neutral-300 leading-relaxed">
                  Start (or restart) your Pando node. The capability detector automatically checks for Claude Code and broadcasts it to the network.
                </span>
              </li>
              <li className="flex items-start gap-3 text-sm">
                <span className="w-5 h-5 rounded-full bg-violet-500/15 border border-violet-500/25 text-violet-400 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">4</span>
                <span className="text-neutral-700 dark:text-neutral-300 leading-relaxed">
                  Your node now shows a{" "}
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/15 text-violet-400 border border-violet-500/25">Claude Code</span>{" "}
                  tag on the Resources page under &ldquo;My Nodes&rdquo;. Tasks requiring AI agents will be routed to your node, earning 5.0 Lux per completed task.
                </span>
              </li>
            </ol>

            <div className="flex flex-wrap gap-4 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wide">Cost</span>
                <span className="text-neutral-600 dark:text-neutral-400">Your Anthropic plan (Max or API)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-neutral-500 uppercase tracking-wide">Reward</span>
                <span className="font-mono text-amber-500">5.0 Lux per task</span>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom CTA */}
        <div className="bg-gradient-to-br from-amber-500/10 to-emerald-500/10 border border-amber-500/20 rounded-xl p-6 space-y-3 animate-page-fade-in-delay-3">
          <h2 className="text-lg font-bold text-neutral-900 dark:text-neutral-100">
            Ready to contribute?
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 max-w-xl">
            Head to the Resources page to contribute your first resource and start earning Lux.
            Every contribution makes Pando faster, smarter, and more resilient.
          </p>
          <a
            href="/resources"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400 hover:text-amber-500 dark:hover:text-amber-300 transition"
          >
            Go to Resources &rarr;
          </a>
        </div>

        {/* Back link */}
        <div className="text-center py-4 animate-page-fade-in-delay-3">
          <a href="/resources" className="text-sm text-amber-500 hover:text-amber-400 transition">&larr; Back to Resources</a>
        </div>
      </main>
    </div>
  );
}
