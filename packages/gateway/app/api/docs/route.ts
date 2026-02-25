import { NextResponse } from "next/server";

const endpoints = [
  { method: "GET", path: "/status", description: "Node status — peers, balance, identity, supply, uptime" },
  { method: "GET", path: "/peers", description: "List connected peers with connection times" },
  { method: "GET", path: "/balance/:peerId", description: "Balance for a specific peer" },
  { method: "POST", path: "/transfer", description: "Transfer Lux — {to, amount, relay?}, broadcasts via GossipSub" },
  { method: "POST", path: "/search", description: "AI search — {query}, uses node's contributed API keys" },
  { method: "GET", path: "/wallet", description: "Wallet info — peer ID, public key, balance, identity file path" },
  { method: "GET", path: "/health", description: "Health check — returns {ok: true}" },
  { method: "GET", path: "/transactions", description: "Transaction history with optional limit query param" },
  { method: "POST", path: "/connect", description: "Connect to a peer by multiaddr" },

  // Governance endpoints
  { method: "GET", path: "/governance/proposals", description: "List all governance proposals" },
  { method: "GET", path: "/governance/proposals/active", description: "List active (open) proposals" },
  { method: "GET", path: "/governance/proposal/:id", description: "Proposal details with comments and votes" },
  { method: "POST", path: "/governance/propose", description: "Create a proposal — {title, description, votingDurationMs?}" },
  { method: "POST", path: "/governance/comment", description: "Add comment to proposal — {proposalId, content}" },
  { method: "POST", path: "/governance/vote", description: "Cast vote — {proposalId, choice, reasoning?}" },
  { method: "POST", path: "/governance/message", description: "Send agent message — {content, to?}" },

  // Discovery & onboarding
  { method: "GET", path: "/bootstrap", description: "Bootstrap multiaddrs for new node discovery" },
  { method: "GET", path: "/onboard", description: "Onboarding info — bootstrap addrs, setup instructions, version" },

  // Activity & events
  { method: "GET", path: "/activity", description: "Activity feed with optional type/limit filters" },
  { method: "GET", path: "/activity/stream", description: "Agent activity from activity table" },

  // Tasks
  { method: "GET", path: "/tasks", description: "List tasks with optional status/assignee filters" },
  { method: "GET", path: "/tasks/stats", description: "Task statistics — counts by status" },
  { method: "POST", path: "/tasks/:id/complete", description: "Mark a task as completed" },

  // Scheduler
  { method: "GET", path: "/scheduler/status", description: "Scheduler status — running, config, active tasks" },
  { method: "POST", path: "/scheduler/start", description: "Start the scheduler" },
  { method: "POST", path: "/scheduler/stop", description: "Stop the scheduler" },
  { method: "POST", path: "/scheduler/submit", description: "Submit a task for scheduling" },
  { method: "GET", path: "/scheduler/tasks", description: "List all scheduled tasks with timeline" },
  { method: "GET", path: "/scheduler/tasks/:id", description: "Full task detail with complete timeline" },
];

export async function GET() {
  return NextResponse.json(endpoints);
}
