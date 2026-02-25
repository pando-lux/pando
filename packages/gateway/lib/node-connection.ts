/**
 * Gateway ↔ Node connection.
 *
 * Talks to the Pando node via HTTP API.
 * NO direct database access. The node owns the ledger.
 *
 * Phase 43: Multi-Node Gateway — routes through NodePool for failover.
 * Configure via PANDO_NODES (comma-separated) or PANDO_NODE_URL (single node).
 */

import { getNodePool } from "./node-pool";

interface NodeStatus {
  connected: boolean;
  peers: number;
  identity: string;
  publicKey: string;    // Phase 41: Ed25519 public key (base64) for E2E encryption
  balance: number;
  totalSupply: number;
  totalAccounts: number;
  listenAddresses: string[];
  linkedUser?: { peerId: string; username: string } | null;
  uptime?: number;
}

interface SearchResult {
  answer: string;
  sources: string[];
  confidence: string;
  respondedBy: string;
}

/** Try to read the API token from ~/.pando/api-token file. */
function loadApiTokenFromFile(): string | undefined {
  try {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const tokenPath = path.join(os.homedir(), ".pando", "api-token");
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, "utf-8").trim();
    }
  } catch {}
  return undefined;
}

class NodeConnection {
  private nodeUrl: string;
  private apiToken: string | undefined;

  constructor() {
    this.nodeUrl = getNodePool().getBestNodeUrl();
    this.apiToken = process.env.PANDO_API_TOKEN || loadApiTokenFromFile();
  }

  /** Build headers with optional Authorization for authenticated requests. */
  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    // Re-read token on each request — node may regenerate api-token on restart
    const token = process.env.PANDO_API_TOKEN || loadApiTokenFromFile();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * Phase 43: Fetch with automatic failover to another node on failure.
   * Tries the best node, and on failure tries one fallback.
   */
  private async fetchWithFailover(path: string, options?: RequestInit): Promise<Response> {
    const pool = getNodePool();
    const url = pool.getBestNodeUrl();
    const start = Date.now();
    try {
      const res = await fetch(`${url}${path}`, {
        ...options,
        signal: options?.signal || AbortSignal.timeout(10000),
      });
      pool.recordSuccess(url, Date.now() - start);
      return res;
    } catch (err) {
      pool.recordFailure(url);
      // Try one fallback
      const fallbackUrl = pool.getBestNodeUrl();
      if (fallbackUrl !== url) {
        const start2 = Date.now();
        try {
          const res = await fetch(`${fallbackUrl}${path}`, {
            ...options,
            signal: options?.signal || AbortSignal.timeout(10000),
          });
          pool.recordSuccess(fallbackUrl, Date.now() - start2);
          return res;
        } catch (err2) {
          pool.recordFailure(fallbackUrl);
          throw err2;
        }
      }
      throw err;
    }
  }

  async getStatusAsync(): Promise<NodeStatus> {
    try {
      const res = await this.fetchWithFailover("/v1/status", {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Node not responding");
      const data = await res.json();
      return {
        connected: data.connected,
        peers: data.peers,
        identity: data.identity || data.peerId || "",
        publicKey: data.publicKey || "",  // Phase 41: Ed25519 public key (base64)
        balance: data.balance || 0,
        totalSupply: data.totalSupply || 0,
        totalAccounts: data.totalAccounts || 0,
        listenAddresses: data.listenAddresses || [],
        linkedUser: data.linkedUser || null,
        uptime: data.uptime || 0,
      };
    } catch {
      return {
        connected: false,
        peers: 0,
        identity: "",
        publicKey: "",
        balance: 0,
        totalSupply: 0,
        totalAccounts: 0,
        listenAddresses: [],
      };
    }
  }

  async search(query: string, identity?: string): Promise<SearchResult> {
    try {
      const res = await this.fetchWithFailover("/v1/search", {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ query, identity }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) throw new Error("Search failed");
      return await res.json();
    } catch {
      return {
        answer:
          "No Pando node is reachable. Make sure at least one node is running.",
        sources: [],
        confidence: "none",
        respondedBy: "gateway-error",
      };
    }
  }

  async transfer(to: string, amount: number, userToken?: string): Promise<any> {
    // Writes go to primary node (has matching auth token)
    const url = getNodePool().getBestNodeUrl('primary');
    const extra: Record<string, string> = { "Content-Type": "application/json" };
    if (userToken) extra["X-User-Token"] = userToken;
    const res = await fetch(`${url}/v1/transfer`, {
      method: "POST",
      headers: this.authHeaders(extra),
      body: JSON.stringify({ to, amount }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Transfer failed");
    }

    return await res.json();
  }

  async getBalance(peerId: string): Promise<number> {
    try {
      const res = await this.fetchWithFailover(`/v1/balance/${peerId}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get balance");
      const data = await res.json();
      return data.balance || 0;
    } catch {
      return 0;
    }
  }

  async getPeers(): Promise<{ peerId: string; connectedAt: number; lastSeen: number; balance: number }[]> {
    try {
      const res = await this.fetchWithFailover("/v1/peers", {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get peers");
      const data = await res.json();
      return data.peers || [];
    } catch {
      return [];
    }
  }

  async getProposals(): Promise<any[]> {
    try {
      const res = await this.fetchWithFailover("/v1/governance/proposals", {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get proposals");
      const data = await res.json();
      return data.proposals || [];
    } catch {
      return [];
    }
  }

  async createProposal(title: string, description: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/governance/propose`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ title, description }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to create proposal");
    }
    return await res.json();
  }

  async getProposalDetail(id: string): Promise<any> {
    try {
      const res = await this.fetchWithFailover(`/v1/governance/proposal/${encodeURIComponent(id)}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get proposal");
      return await res.json();
    } catch {
      return null;
    }
  }

  async addComment(proposalId: string, content: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/governance/comment`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ proposalId, content }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to add comment");
    }
    return await res.json();
  }

  async connectPeer(addr: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/connect`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ addr }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to connect to peer");
    }
    return await res.json();
  }

  async getTransactions(limit: number = 50, userToken?: string): Promise<{ transactions: any[]; peerId: string }> {
    try {
      const extra: Record<string, string> = {};
      if (userToken) extra["X-User-Token"] = userToken;
      const res = await this.fetchWithFailover(`/v1/transactions?limit=${limit}`, {
        headers: this.authHeaders(extra),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get transactions");
      return await res.json();
    } catch {
      return { transactions: [], peerId: "" };
    }
  }

  async getActivity(limit: number = 30): Promise<{ events: any[]; nodeId: string }> {
    try {
      const res = await this.fetchWithFailover(`/v1/activity?limit=${limit}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get activity");
      return await res.json();
    } catch {
      return { events: [], nodeId: "" };
    }
  }

  async getActivityStream(limit: number = 30): Promise<{ events: any[]; nodeId: string }> {
    try {
      const res = await this.fetchWithFailover(`/v1/activity/stream?limit=${limit}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get activity stream");
      return await res.json();
    } catch {
      return { events: [], nodeId: "" };
    }
  }

  async getNetworkOverview(): Promise<any> {
    try {
      const res = await this.fetchWithFailover("/v1/network/overview", {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get network overview");
      return await res.json();
    } catch {
      return {
        nodes: { self: "", peerCount: 0, peers: [] },
        agents: { local: null, knownAgents: [] },
        activeProposals: 0,
        recentActivity: [],
        luxMetrics: { totalSupply: 0, circulatingSupply: 0, totalBurned: 0, totalRelayFees: 0, totalAccounts: 0, totalTransactions: 0 },
        uptime: 0,
      };
    }
  }

  async sendGovernanceMessage(content: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/governance/message`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to send message");
    }
    return await res.json();
  }

  async getTopology(): Promise<any> {
    try {
      const res = await this.fetchWithFailover("/v1/network/topology", {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get topology");
      return await res.json();
    } catch {
      return { nodes: [], edges: [] };
    }
  }

  async getOnboard(): Promise<{ bootstrapAddrs: string[]; instructions: string; version: string; peerId: string; peerCount: number }> {
    try {
      const res = await this.fetchWithFailover("/v1/onboard", {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get onboard info");
      return await res.json();
    } catch {
      return { bootstrapAddrs: [], instructions: "", version: "", peerId: "", peerCount: 0 };
    }
  }

  async createTask(title: string, description: string, priority?: string, createdBy?: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/tasks`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ title, description, priority, createdBy }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to create task");
    }
    return await res.json();
  }

  async voteOnProposal(proposalId: string, choice: string, reasoning?: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/governance/vote`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ proposalId, choice, reasoning }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to vote");
    }
    return await res.json();
  }

  async getProposalReviews(proposalId: string): Promise<{ proposalId: string; reviews: any[]; summary: any | null }> {
    try {
      const res = await this.fetchWithFailover(`/v1/governance/proposals/${encodeURIComponent(proposalId)}/reviews`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get reviews");
      return await res.json();
    } catch {
      return { proposalId, reviews: [], summary: null };
    }
  }

  async getProposalReviewers(proposalId: string): Promise<{ proposalId: string; reviewers: any[]; selectedReviewers: any[]; reviewerCount: number; humanOnly: boolean }> {
    try {
      const res = await this.fetchWithFailover(`/v1/governance/proposals/${encodeURIComponent(proposalId)}/reviewers`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get reviewers");
      return await res.json();
    } catch {
      return { proposalId, reviewers: [], selectedReviewers: [], reviewerCount: 0, humanOnly: false };
    }
  }

  /* -- Projects API ----------------------------------------- */

  async getProjects(token?: string): Promise<any[]> {
    try {
      const headers: Record<string, string> = {};
      if (token) headers["X-User-Token"] = token;
      const res = await this.fetchWithFailover("/v1/projects", {
        headers: this.authHeaders(headers),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get projects");
      const data = await res.json();
      return data.projects || [];
    } catch {
      return [];
    }
  }

  async getProject(id: string, token?: string): Promise<any> {
    try {
      const headers: Record<string, string> = {};
      if (token) headers["X-User-Token"] = token;
      const res = await this.fetchWithFailover(`/v1/projects/${encodeURIComponent(id)}`, {
        headers: this.authHeaders(headers),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get project");
      return await res.json();
    } catch {
      return null;
    }
  }

  async createProject(data: { name: string; description: string; type?: string; visibility?: string }, token: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/projects`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json", "X-User-Token": token }),
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to create project");
    }
    return await res.json();
  }

  async updateProject(id: string, data: Record<string, unknown>, token: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: this.authHeaders({ "Content-Type": "application/json", "X-User-Token": token }),
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to update project");
    }
    return await res.json();
  }

  async getProjectCollaborators(id: string, token?: string): Promise<any[]> {
    try {
      const headers: Record<string, string> = {};
      if (token) headers["X-User-Token"] = token;
      const res = await this.fetchWithFailover(`/v1/projects/${encodeURIComponent(id)}/collaborators`, {
        headers: this.authHeaders(headers),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get collaborators");
      const data = await res.json();
      return data.collaborators || [];
    } catch {
      return [];
    }
  }

  async addProjectCollaborator(id: string, data: { userId: string; role?: string }, token: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/projects/${encodeURIComponent(id)}/collaborators`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json", "X-User-Token": token }),
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to add collaborator");
    }
    return await res.json();
  }

  async removeProjectCollaborator(id: string, userId: string, token: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/projects/${encodeURIComponent(id)}/collaborators/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: this.authHeaders({ "X-User-Token": token }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to remove collaborator");
    }
    return await res.json();
  }

  async generateProjectInvite(id: string, body: Record<string, unknown>, token: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/projects/${encodeURIComponent(id)}/invite`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json", "X-User-Token": token }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to generate invite");
    }
    return await res.json();
  }

  /* -- Hosting API ------------------------------------------ */

  async deployProject(projectId: string, files: any[], token: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/projects/${encodeURIComponent(projectId)}/hosting`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json", "X-User-Token": token }),
      body: JSON.stringify({ files }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to deploy project");
    }
    return await res.json();
  }

  async getProjectHosting(projectId: string, token?: string): Promise<any> {
    try {
      const headers: Record<string, string> = {};
      if (token) headers["X-User-Token"] = token;
      const res = await this.fetchWithFailover(`/v1/projects/${encodeURIComponent(projectId)}/hosting`, {
        headers: this.authHeaders(headers),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error("Failed to get hosting info");
      return await res.json();
    } catch {
      return null;
    }
  }

  async undeployProject(projectId: string, token: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/projects/${encodeURIComponent(projectId)}/undeploy`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json", "X-User-Token": token }),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to undeploy project");
    }
    return await res.json();
  }

  async removeProjectHosting(projectId: string, token: string): Promise<any> {
    const url = getNodePool().getBestNodeUrl('primary');
    const res = await fetch(`${url}/v1/projects/${encodeURIComponent(projectId)}/hosting`, {
      method: "DELETE",
      headers: this.authHeaders({ "X-User-Token": token }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to remove hosting");
    }
    return await res.json();
  }

  async getProjectStats(): Promise<{ totalProjects: number; activeProjects: number; publicProjects: number; totalCollaborators: number }> {
    try {
      const res = await this.fetchWithFailover("/v1/projects/stats", {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get project stats");
      return await res.json();
    } catch {
      return { totalProjects: 0, activeProjects: 0, publicProjects: 0, totalCollaborators: 0 };
    }
  }

  async getGovernanceStats(): Promise<{ totalProposals: number; reviewedCount: number; avgRiskScore: number; stakePool: number; humanOnlyCount: number; governanceChangeCount: number; statusCounts: Record<string, number> }> {
    try {
      const res = await this.fetchWithFailover("/v1/governance/stats", {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error("Failed to get governance stats");
      return await res.json();
    } catch {
      return { totalProposals: 0, reviewedCount: 0, avgRiskScore: 0, stakePool: 0, humanOnlyCount: 0, governanceChangeCount: 0, statusCounts: {} };
    }
  }
}

// Singleton
let connection: NodeConnection | null = null;

export function getNodeConnection(): NodeConnection {
  if (!connection) {
    connection = new NodeConnection();
  }
  return connection;
}

/**
 * Returns the best available node URL from the pool.
 * Phase 43: Multi-node aware — routes to healthiest node.
 *
 * @param preference - 'any' (default), 'claude' (nodes with Claude Code), 'primary' (write ops)
 */
export function getNodeUrl(preference?: 'any' | 'claude' | 'primary'): string {
  return getNodePool().getBestNodeUrl(preference);
}

/** Returns the API token from env var or ~/.pando/api-token file. */
export function getApiToken(): string | undefined {
  return process.env.PANDO_API_TOKEN || loadApiTokenFromFile();
}

/**
 * Phase 85: Fetch from a node with automatic failover.
 * Tries the best node, and on failure tries one fallback.
 * Use this instead of raw `getNodeUrl() + fetch()` in API routes.
 *
 * @param path - API path (e.g. "/auth/guest")
 * @param options - fetch options
 * @param preference - node preference: 'any' (default), 'claude', 'primary'
 */
export async function fetchFromNode(path: string, options?: RequestInit, preference?: 'any' | 'claude' | 'primary'): Promise<Response> {
  const pool = getNodePool();
  const url = pool.getBestNodeUrl(preference);
  const start = Date.now();
  try {
    const res = await fetch(`${url}${path}`, {
      ...options,
      signal: options?.signal || AbortSignal.timeout(10000),
    });
    pool.recordSuccess(url, Date.now() - start);
    return res;
  } catch (err) {
    pool.recordFailure(url);
    // Try one fallback
    const fallbackUrl = pool.getBestNodeUrl();
    if (fallbackUrl !== url) {
      const start2 = Date.now();
      try {
        const res = await fetch(`${fallbackUrl}${path}`, {
          ...options,
          signal: options?.signal || AbortSignal.timeout(10000),
        });
        pool.recordSuccess(fallbackUrl, Date.now() - start2);
        return res;
      } catch (err2) {
        pool.recordFailure(fallbackUrl);
        throw err2;
      }
    }
    throw err;
  }
}
