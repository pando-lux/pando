import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

function extractToken(req: Request): string {
  const authHeader = req.headers.get("authorization") || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : req.headers.get("x-user-token") || "";
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const token = extractToken(req) || undefined;
    const node = getNodeConnection();
    const collaborators = await node.getProjectCollaborators(id, token);
    return NextResponse.json({ collaborators });
  } catch {
    return NextResponse.json({ collaborators: [] });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const token = extractToken(req);
    const body = await req.json();
    const { userId, role } = body;
    if (!userId?.trim()) {
      return NextResponse.json({ error: "userId is required" }, { status: 400 });
    }
    const node = getNodeConnection();
    const result = await node.addProjectCollaborator(id, { userId: userId.trim(), role }, token);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to add collaborator" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const token = extractToken(req);
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId");
    if (!userId?.trim()) {
      return NextResponse.json({ error: "userId query param is required" }, { status: 400 });
    }
    const node = getNodeConnection();
    const result = await node.removeProjectCollaborator(id, userId.trim(), token);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to remove collaborator" },
      { status: 500 }
    );
  }
}
