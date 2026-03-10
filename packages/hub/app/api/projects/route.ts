import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

function extractToken(req: Request): string {
  const authHeader = req.headers.get("authorization") || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : req.headers.get("x-user-token") || "";
}

export async function GET(req: Request) {
  try {
    const token = extractToken(req) || undefined;
    const node = getNodeConnection();
    if (token) {
      // Fetch user's projects AND all public/listed projects, then merge
      const [userProjects, allProjects] = await Promise.all([
        node.getProjects(token),
        node.getProjects(),
      ]);
      const seen = new Set<string>();
      const merged: any[] = [];
      for (const p of userProjects) {
        if (p.id && !seen.has(p.id)) { seen.add(p.id); merged.push(p); }
      }
      for (const p of allProjects) {
        if (p.id && !seen.has(p.id)) { seen.add(p.id); merged.push(p); }
      }
      return NextResponse.json({ projects: merged });
    }
    const projects = await node.getProjects();
    return NextResponse.json({ projects });
  } catch {
    return NextResponse.json({ projects: [] });
  }
}

export async function POST(req: Request) {
  try {
    const token = extractToken(req);
    const body = await req.json();
    const { name, description, type, visibility, budgetLimit } = body;
    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    const node = getNodeConnection();
    const result = await node.createProject(
      {
        name: name.trim(),
        description: description?.trim() || "",
        type,
        visibility,
        ...(budgetLimit !== undefined ? { budgetLimit } : {}),
      } as any,
      token
    );
    return NextResponse.json(result);
  } catch (err: any) {
    const cause = err.cause ? String(err.cause) : undefined;
    return NextResponse.json(
      { error: err.message || "Failed to create project", cause },
      { status: 500 }
    );
  }
}
