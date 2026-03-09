import { NextResponse } from "next/server";
import { getNodeConnection } from "@/lib/node-connection";

/**
 * Onboard API — enriched with public bootstrap addresses + live network stats.
 * The raw /v1/onboard returns private IPs (EC2 internal), so we replace with public addresses.
 */

// Public bootstrap peers (EC2-1 + EC2-2)
const PUBLIC_BOOTSTRAPS = [
  "/ip4/44.196.69.210/tcp/4001/p2p/12D3KooWJL2UxKRw2te6DNPsLa9KjRmB5SkML6Kd5wsndA8vJysN",
  "/ip4/3.226.89.40/tcp/4001/p2p/12D3KooWLMnoeqedX6uTWoBbq2ZfRyYKpDtttdtp6uNfm3PeJ33d",
];

export async function GET() {
  try {
    const node = getNodeConnection();
    const [onboard, status] = await Promise.all([
      node.getOnboard().catch(() => null),
      node.getStatusAsync().catch(() => null),
    ]);

    return NextResponse.json({
      bootstrapAddrs: PUBLIC_BOOTSTRAPS,
      startCommand: `node packages/node/dist/cli.js --port 4001 --bootstrap ${PUBLIC_BOOTSTRAPS[0]}`,
      repoUrl: "https://github.com/pando-lux/pando",
      version: onboard?.version || "0.1.0",
      peerCount: onboard?.peerCount ?? status?.peers ?? 0,
      totalSupply: status?.totalSupply ?? 0,
      totalAccounts: status?.totalAccounts ?? 0,
    });
  } catch {
    return NextResponse.json({
      bootstrapAddrs: PUBLIC_BOOTSTRAPS,
      startCommand: `node packages/node/dist/cli.js --port 4001 --bootstrap ${PUBLIC_BOOTSTRAPS[0]}`,
      repoUrl: "https://github.com/pando-lux/pando",
      version: "0.1.0",
      peerCount: 0,
      totalSupply: 0,
      totalAccounts: 0,
    });
  }
}
