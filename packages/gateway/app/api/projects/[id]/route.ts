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
    const project = await node.getProject(id, token);
    return NextResponse.json({ project });
  } catch {
    return NextResponse.json({ project: null });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const token = extractToken(req);
    const body = await req.json();
    const node = getNodeConnection();
    const result = await node.updateProject(id, body, token);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to update project" },
      { status: 500 }
    );
  }
}
