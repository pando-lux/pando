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
    const hosting = await node.getProjectHosting(id, token);
    return NextResponse.json(hosting);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to get hosting info" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const token = extractToken(req);
    const body = await req.json();
    const { files } = body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return NextResponse.json({ error: "files array is required" }, { status: 400 });
    }
    const node = getNodeConnection();
    const result = await node.deployProject(id, files, token);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to deploy project" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const token = extractToken(req);
    const node = getNodeConnection();
    const result = await node.removeProjectHosting(id, token);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to remove hosting" },
      { status: 500 }
    );
  }
}
