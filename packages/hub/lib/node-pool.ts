/**
 * Node Pool — multi-node backend management with health checking,
 * circuit breaking, and smart selection.
 *
 * Phase 43: Multi-Node Gateway — Discovery, Failover, Smart Routing.
 *
 * Bootstrap from PANDO_NODES (comma-separated) or PANDO_NODE_URL (single, backward compat).
 * Discovers additional nodes via GET /v1/network/capabilities on the primary node.
 */

export interface NodeEntry {
  url: string;
  peerId: string | null;
  healthy: boolean;
  lastCheck: number;
  latencyMs: number;
  consecutiveFailures: number;
  capabilities: string[];
  circuitOpen: boolean;
  circuitOpenUntil: number;
}

function defaultEntry(url: string): NodeEntry {
  return {
    url,
    peerId: null,
    healthy: true, // assume healthy until proven otherwise
    lastCheck: 0,
    latencyMs: 0,
    consecutiveFailures: 0,
    capabilities: [],
    circuitOpen: false,
    circuitOpenUntil: 0,
  };
}

const HEALTH_CHECK_INTERVAL = 30_000;  // 30s
const CIRCUIT_OPEN_DURATION = 60_000;  // 60s initial
const CIRCUIT_REOPEN_DURATION = 120_000; // 120s after half-open failure
const MAX_FAILURES_BEFORE_CIRCUIT = 3;
const DISCOVERY_INTERVAL = 5 * 60_000; // 5 minutes

/** Returns true if the IP is a private/local address that gateways can't reach */
function isPrivateIp(host: string): boolean {
  if (host === '0.0.0.0' || host === '127.0.0.1' || host === 'localhost') return true;
  // Tailscale CGNAT range
  if (host.startsWith('100.')) return true;
  // RFC 1918
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (host.match(/^172\.(1[6-9]|2[0-9]|3[01])\./)) return true;
  return false;
}

class NodePool {
  private nodes: Map<string, NodeEntry> = new Map();
  private primaryUrl: string;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private discoveryInterval: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor() {
    // Bootstrap seed nodes: env var > hardcoded public nodes > localhost
    // Phase 99: Only seed with trusted compute nodes that have stable public IPs.
    // Discovery via /network/capabilities will find the rest.
    const bootstrapEnv = process.env.PANDO_BOOTSTRAP_NODES?.split(',').map(s => s.trim()).filter(Boolean);
    const FALLBACK_SEEDS = bootstrapEnv?.length ? bootstrapEnv : [
      'http://44.196.69.210:4000',   // EC2-1 (pando-compute-1)
      'http://3.226.89.40:4000',     // EC2-2 (pando-compute-2)
    ];
    const nodeList = process.env.PANDO_NODES?.split(',').map(s => s.trim()).filter(Boolean);
    const singleNode = process.env.PANDO_NODE_URL;
    // Always include fallback seeds for redundancy — primary from env var takes priority
    const envUrls = nodeList?.length ? nodeList : singleNode ? [singleNode] : [];
    const combined = envUrls.length > 0 ? new Set(envUrls) : new Set(FALLBACK_SEEDS);
    const urls = combined.size > 0 ? Array.from(combined) : ['http://127.0.0.1:4000'];
    // Sanitize: replace 'localhost' with '127.0.0.1' to avoid IPv6 resolution issues on Windows
    const sanitized = urls.map(u => u.replace('://localhost', '://127.0.0.1'));
    this.primaryUrl = sanitized[0];
    for (const url of sanitized) {
      this.nodes.set(url, defaultEntry(url));
    }
  }

  /** Start background health checks and discovery */
  start(): void {
    if (this.started) return;
    this.started = true;

    // Immediate first health check
    this.healthCheckAll().catch(() => {});

    // Periodic health checks
    this.healthCheckInterval = setInterval(() => {
      this.healthCheckAll().catch(() => {});
    }, HEALTH_CHECK_INTERVAL);

    // Immediate discovery
    this.discoverNodes().catch(() => {});

    // Periodic discovery
    this.discoveryInterval = setInterval(() => {
      this.discoverNodes().catch(() => {});
    }, DISCOVERY_INTERVAL);
  }

  /** Stop health checks and discovery */
  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
    this.started = false;
  }

  /** Get the best node URL for a given request type */
  getBestNodeUrl(preference: 'any' | 'primary' = 'any'): string {
    if (preference === 'primary') return this.primaryUrl;

    const now = Date.now();
    let candidates: NodeEntry[] = [];

    for (const entry of this.nodes.values()) {
      // Skip circuit-open nodes (unless expired)
      if (entry.circuitOpen && now < entry.circuitOpenUntil) continue;
      // Half-open: if circuit expired, allow one try
      if (entry.circuitOpen && now >= entry.circuitOpenUntil) {
        entry.circuitOpen = false;
      }
      if (!entry.healthy) continue;
      candidates.push(entry);
    }

    if (candidates.length === 0) {
      // All nodes down — return primary (let request fail with clear error)
      return this.primaryUrl;
    }

    // Sort by latency (lowest first)
    candidates.sort((a, b) => a.latencyMs - b.latencyMs);
    // On cold start (no health checks yet), all latencies are 0 — randomize to avoid
    // always hitting the same node (which may be down on Vercel serverless cold starts)
    if (candidates.length > 1 && candidates[0].latencyMs === 0 && candidates[0].lastCheck === 0) {
      const idx = Math.floor(Math.random() * candidates.length);
      return candidates[idx].url;
    }
    return candidates[0].url;
  }

  /** Get all healthy node URLs */
  getHealthyNodes(): string[] {
    const now = Date.now();
    const result: string[] = [];
    for (const entry of this.nodes.values()) {
      if (entry.circuitOpen && now < entry.circuitOpenUntil) continue;
      if (entry.healthy) result.push(entry.url);
    }
    return result;
  }

  /** Get pool status */
  getStatus(): { nodes: NodeEntry[]; primaryUrl: string; healthyCount: number; totalCount: number } {
    const nodes = Array.from(this.nodes.values());
    const now = Date.now();
    const healthyCount = nodes.filter(n =>
      n.healthy && !(n.circuitOpen && now < n.circuitOpenUntil)
    ).length;
    return {
      nodes,
      primaryUrl: this.primaryUrl,
      healthyCount,
      totalCount: nodes.length,
    };
  }

  /** Record a successful request to a node */
  recordSuccess(url: string, latencyMs: number): void {
    const entry = this.nodes.get(url);
    if (!entry) return;
    entry.consecutiveFailures = 0;
    entry.latencyMs = latencyMs;
    entry.healthy = true;
    entry.circuitOpen = false;
  }

  /** Record a failed request — triggers circuit breaker after 3 consecutive failures */
  recordFailure(url: string): void {
    const entry = this.nodes.get(url);
    if (!entry) return;
    entry.consecutiveFailures++;
    if (entry.consecutiveFailures >= MAX_FAILURES_BEFORE_CIRCUIT) {
      entry.circuitOpen = true;
      // If it was already circuit-open before (half-open retry failed), use longer duration
      const duration = entry.consecutiveFailures > MAX_FAILURES_BEFORE_CIRCUIT
        ? CIRCUIT_REOPEN_DURATION
        : CIRCUIT_OPEN_DURATION;
      entry.circuitOpenUntil = Date.now() + duration;
      entry.healthy = false;
    }
  }

  /** Health-check all nodes */
  private async healthCheckAll(): Promise<void> {
    const checks = Array.from(this.nodes.entries()).map(async ([url, entry]) => {
      const start = Date.now();
      try {
        const res = await fetch(`${url}/v1/status`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as any;
        const latency = Date.now() - start;

        entry.healthy = true;
        entry.latencyMs = latency;
        entry.lastCheck = Date.now();
        entry.consecutiveFailures = 0;
        entry.circuitOpen = false;
        entry.peerId = data.identity || data.peerId || null;

        // Extract capabilities from status
        if (data.capabilities && Array.isArray(data.capabilities)) {
          entry.capabilities = data.capabilities;
        }
      } catch {
        entry.lastCheck = Date.now();
        entry.consecutiveFailures++;
        if (entry.consecutiveFailures >= MAX_FAILURES_BEFORE_CIRCUIT) {
          entry.healthy = false;
          entry.circuitOpen = true;
          entry.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_DURATION;
        }
      }
    });

    await Promise.allSettled(checks);
  }

  /** Discover additional nodes from /network/capabilities on ANY healthy node.
   *  Tries all known healthy nodes (not just primary) so discovery works during failover. */
  async discoverNodes(): Promise<void> {
    // Build list of nodes to try: primary first, then any healthy node
    const tryUrls: string[] = [this.primaryUrl];
    for (const [url, entry] of this.nodes.entries()) {
      if (url !== this.primaryUrl && entry.healthy) {
        tryUrls.push(url);
      }
    }

    for (const sourceUrl of tryUrls) {
      try {
        const res = await fetch(`${sourceUrl}/v1/network/capabilities`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        const data = await res.json() as any;
        const profiles: any[] = data.profiles || data;
        if (!Array.isArray(profiles)) continue;

        for (const profile of profiles) {
          // Phase 99: Use publicAddress (set via PUBLIC_IP env var on EC2 nodes) as the
          // canonical reachable host. httpApi.host may be a private IP (NAT/VPC).
          // Only add nodes that explicitly advertise a public address.
          const publicAddress = profile.publicAddress;
          if (!publicAddress || isPrivateIp(publicAddress)) continue;

          const httpApi = profile.details?.httpApi;
          if (!httpApi || !httpApi.port) continue;

          const protocol = httpApi.https ? 'https' : 'http';
          const url = `${protocol}://${publicAddress}:${httpApi.port}`;

          // Don't re-add nodes we already know about
          if (this.nodes.has(url)) continue;

          // Add new node and health-check it
          const entry = defaultEntry(url);
          entry.peerId = profile.peerId || null;
          entry.healthy = false; // unhealthy until verified
          this.nodes.set(url, entry);

          // Verify immediately
          try {
            const start = Date.now();
            const check = await fetch(`${url}/v1/status`, {
              signal: AbortSignal.timeout(5000),
            });
            if (check.ok) {
              entry.healthy = true;
              entry.latencyMs = Date.now() - start;
              entry.lastCheck = Date.now();
            }
          } catch {
            // Remove unverified nodes
            this.nodes.delete(url);
          }
        }

        // Successfully discovered from this node — no need to try others
        return;
      } catch {
        // Try next node
        continue;
      }
    }
  }
}

// Singleton
let pool: NodePool | null = null;

export function getNodePool(): NodePool {
  if (!pool) {
    pool = new NodePool();
    pool.start();
  }
  return pool;
}
