import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

/**
 * Agents Tree API — builds a hierarchy from teams and their agents.
 * Each team is a root node; its agents are children.
 */
export async function GET() {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getApiToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const teamsRes = await fetchFromNode("/v1/teams", {
      headers,
      signal: AbortSignal.timeout(5000),
    }, 'primary');
    if (!teamsRes.ok) return NextResponse.json({ tree: [] });

    const teamsData = await teamsRes.json();
    const teams: any[] = teamsData.teams || [];

    const tree: any[] = [];
    await Promise.all(teams.map(async (team: any) => {
      try {
        const res = await fetchFromNode(`/v1/teams/${encodeURIComponent(team.id)}/agents`, {
          headers,
          signal: AbortSignal.timeout(5000),
        }, 'primary');
        const agents = res.ok ? (await res.json()).agents || [] : [];

        tree.push({
          id: team.id,
          role: "manager",
          status: team.running ? "active" : "idle",
          description: team.displayName || team.id,
          taskCount: team.agentCount || agents.length,
          totalCost: 0,
          lastActive: Date.now(),
          children: agents.map((a: any) => ({
            id: `${team.id}/${a.id}`,
            role: a.role || "lead",
            status: a.status || "active",
            description: a.displayName || a.id,
            taskCount: 0,
            totalCost: 0,
            lastActive: Date.now(),
            children: [],
          })),
        });
      } catch { /* skip failed team */ }
    }));

    return NextResponse.json({ tree });
  } catch {
    return NextResponse.json({ tree: [] });
  }
}
