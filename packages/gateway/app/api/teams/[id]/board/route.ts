import { NextResponse, NextRequest } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const includeDone = req.nextUrl.searchParams.get("include_done") === "true";
    const node = getNodeConnection();
    const tasks = await node.getTeamBoard(id, includeDone);
    return NextResponse.json({ tasks });
  } catch {
    return NextResponse.json({ tasks: [] });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const node = getNodeConnection();
    const result = await node.addTeamBoardTask(id, body.title, body.description, body.priority);
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to add task" }, { status: 400 });
  }
}
