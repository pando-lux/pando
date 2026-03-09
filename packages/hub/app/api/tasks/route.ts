import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

export async function POST(request: Request) {
  try {
    const { title, description, priority, createdBy } = await request.json();
    if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
    const node = getNodeConnection();
    const result = await node.createTask(title, description || "", priority || "medium", createdBy || "user");
    return NextResponse.json(result);
  } catch (err: any) {
    console.error("POST /api/tasks error:", err?.message || err);
    return NextResponse.json({ error: "Failed to create task" }, { status: 500 });
  }
}
