import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

function extractToken(req: Request): string {
  const authHeader = req.headers.get("authorization") || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : req.headers.get("x-user-token") || "";
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const token = extractToken(req);
    const node = getNodeConnection();
    const result = await node.undeployProject(id, token);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to undeploy project" },
      { status: 500 }
    );
  }
}
