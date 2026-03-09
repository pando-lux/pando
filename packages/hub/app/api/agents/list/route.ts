import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

/**
 * Agents List API — aggregates agents from all teams via /v1/teams/:id/agents.
 */
export async function GET() {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getApiToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    // Get all teams
    const teamsRes = await fetchFromNode("/v1/teams", {
      headers,
      signal: AbortSignal.timeout(5000),
    }, 'primary');
    if (!teamsRes.ok) return NextResponse.json({ agents: [] });

    const teamsData = await teamsRes.json();
    const teams: any[] = teamsData.teams || [];

    // Fetch agents for each team
    const allAgents: any[] = [];
    await Promise.all(teams.map(async (team: any) => {
      try {
        const res = await fetchFromNode(`/v1/teams/${encodeURIComponent(team.id)}/agents`, {
          headers,
          signal: AbortSignal.timeout(5000),
        }, 'primary');
        if (res.ok) {
          const data = await res.json();
          const agents = data.agents || [];
          for (const agent of agents) {
            allAgents.push({
              id: `${team.id}/${agent.id}`,
              role: agent.role || "lead",
              template: agent.model || "claude-code",
              parentId: null,
              projectId: team.id,
              nodeId: team.managingNode || "",
              description: agent.displayName || agent.id,
              sessionId: null,
              status: agent.status || "active",
              createdAt: team.createdAt || Date.now(),
              lastActive: Date.now(),
              taskCount: 0,
              totalCost: 0,
              children: [],
              depth: 0,
            });
          }
        }
      } catch { /* skip failed team */ }
    }));

    return NextResponse.json({ agents: allAgents });
  } catch {
    return NextResponse.json({ agents: [] });
  }
}
