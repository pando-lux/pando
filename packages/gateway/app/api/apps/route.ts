import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

/**
 * Phase 53.7 — App Directory API
 * Returns deployed apps (projects with a deploymentUrl).
 * Public endpoint — no auth required.
 */
export async function GET() {
  try {
    const node = getNodeConnection();
    const projects: any[] = (await node.getProjects(undefined)) ?? [];

    const deployed = projects
      .filter((p: any) => p.deploymentUrl && p.deploymentUrl !== "")
      .map((p: any) => {
        // Classify deployment host
        let hostType: "s3" | "ec2" | "gateway" | "other" = "other";
        const url: string = p.deploymentUrl || "";
        if (url.includes("s3-website") || url.includes("s3.amazonaws.com")) {
          hostType = "s3";
        } else if (url.includes("vercel.app") || url.includes("/apps/")) {
          hostType = "gateway";
        } else if (p.deployPeerId) {
          hostType = "ec2";
        }

        return {
          id: p.id,
          name: p.name,
          description: p.description,
          deploymentUrl: url,
          deploymentStatus: p.deploymentStatus,
          deploymentType: p.deploymentType || hostType,
          hostType,
          visibility: p.visibility,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          ownerId: p.ownerId,
          deployPeerId: p.deployPeerId,
        };
      })
      .sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0));

    return NextResponse.json({ apps: deployed, total: deployed.length });
  } catch {
    return NextResponse.json({ apps: [], total: 0 });
  }
}
