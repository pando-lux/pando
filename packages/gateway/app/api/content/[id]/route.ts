import { NextResponse } from "next/server";
import { getNodeUrl, getApiToken } from "@/lib/node-connection";

const NODE_URL = getNodeUrl();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const res = await fetch(`${NODE_URL}/content/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Content not found" }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Node not reachable" }, { status: 503 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const token = getApiToken();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`${NODE_URL}/content/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.json();
      return NextResponse.json(err, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to update content" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const token = getApiToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(`${NODE_URL}/content/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const err = await res.json();
      return NextResponse.json(err, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Failed to archive content" }, { status: 500 });
  }
}
