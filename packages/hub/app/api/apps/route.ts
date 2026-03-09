import { NextResponse } from "next/server";
import { fetchFromNode, getApiToken } from "@/lib/node-connection";

/**
 * App Directory API
 * Returns apps from the AppManager (/v1/apps), filtered to live/deploying status.
 * Public endpoint — no auth required.
 */
export async function GET() {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getApiToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetchFromNode("/v1/apps", {
      headers,
      signal: AbortSignal.timeout(10000),
    }, 'primary');

    if (!res.ok) return NextResponse.json({ apps: [], total: 0 });

    const data = await res.json();
    const allApps: any[] = data.apps || [];

    // Show live and deploying apps (not failed/registered)
    const deployed = allApps
      .filter((a: any) => a.status === "live" || a.status === "deploying")
      .map((a: any) => {
        let hostType: "s3" | "ec2" | "gateway" | "other" = "other";
        const url: string = a.deploy_url || "";
        if (url.includes("s3-website") || url.includes("s3.amazonaws.com")) {
          hostType = "s3";
        } else if (url.includes("vercel.app") || url.includes("/apps/")) {
          hostType = "gateway";
        } else if (a.host_peer_id) {
          hostType = "ec2";
        }

        return {
          id: a.id,
          name: a.name,
          description: a.name,
          deploymentUrl: url || null,
          deploymentStatus: a.status,
          hostType,
          port: a.port,
          createdAt: a.created_at,
          updatedAt: a.created_at,
          hostPeerId: a.host_peer_id,
        };
      })
      .sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));

    return NextResponse.json({ apps: deployed, total: deployed.length });
  } catch {
    return NextResponse.json({ apps: [], total: 0 });
  }
}
