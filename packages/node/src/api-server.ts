/**
 * HTTP API server for the Pando node.
 *
 * Exposes node operations over HTTP so gateway, MCP server,
 * and other tools can interact with the node without reading
 * the DB directly.
 *
 * Phase 27: Uses AgentManager for all agent/chat routing.
 * Agent tool endpoints registered via registerAgentRoutes().
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { publicKeyFromProtobuf } from '@libp2p/crypto/keys';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { signTransaction } from '@pando/shared';
import { registerAgentRoutes } from './agent-tools.js';
import { hasClaudeCodeAuth } from './capability-detector.js';
import type { AgentManager } from './agent-manager.js';
import type { DeployFile } from './hosting-service.js';
import type { PandoNode } from './index.js';

/** Unix timestamp (ms) captured at module load — records when this node process started. */
const NODE_STARTED_AT = Date.now();

// ── Phase 86: JWT-Style Self-Verifying Auth Tokens ───────────────────────
// Replaces Phase 40 in-memory challenge/token stores.
// Tokens are self-verifying: payload + Ed25519 signature by issuing node.
// Any node verifies using the issuer's public key from the P2P-synced ledger.
// No in-memory stores. No database lookups. Fully stateless.

export interface ApiServerConfig {
  port: number;
  host: string;
}

/** Simple in-memory sliding window rate limiter (per IP). */
class RateLimiter {
  private windows = new Map<string, number[]>();
  private windowMs: number;
  private maxRequests: number;

  constructor(maxRequests: number, windowMs = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }
    // Prune old entries
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }
    if (timestamps.length >= this.maxRequests) {
      return false;
    }
    timestamps.push(now);
    return true;
  }

  /** Periodic cleanup of stale keys to prevent memory leaks. */
  cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.windows.delete(key);
      }
    }
  }
}

/** Rate limit configuration per endpoint (env var overridable). */
const RATE_LIMITS: Record<string, { max: number; envVar: string }> = {
  'POST /search':              { max: 10, envVar: 'PANDO_RATE_SEARCH' },
  'POST /transfer':            { max: 30, envVar: 'PANDO_RATE_TRANSFER' },
  'POST /tasks/:id/thread':    { max: 30, envVar: 'PANDO_RATE_THREAD' },
  'POST /governance/propose':  { max: 5,  envVar: 'PANDO_RATE_PROPOSE' },
  'POST /governance/vote':     { max: 30, envVar: 'PANDO_RATE_VOTE' },
  'POST /governance/comment':  { max: 20, envVar: 'PANDO_RATE_COMMENT' },
  'POST /chat/message':        { max: 20, envVar: 'PANDO_RATE_CHAT' },
  'POST /auth/guest':          { max: 5,  envVar: 'PANDO_RATE_AUTH_GUEST' },
};

function getEnvLimit(envVar: string, fallback: number): number {
  const val = process.env[envVar];
  if (val) {
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

/** Public endpoints that do not require authentication (GET only). */
const PUBLIC_ENDPOINTS: string[] = [
  '/health',
  '/status',
  '/peers',
  '/bootstrap',
  '/onboard',
  '/network/overview',
  '/network/topology',
  '/network/capabilities',
  '/capabilities',
  '/discovery',
  '/events',
  '/reputation',
  '/reputation/peers',
  '/pipeline/status',
  '/resources',
  '/resources/routing',
  '/resources/metering',
  '/resources/rewards',
  '/resources/marketplace',
  '/capacity',
  '/council',
  '/council/minutes',
  '/capabilities/infrastructure',
];

/** Parametric public endpoints matched by prefix (GET only). */
const PUBLIC_PREFIX_ENDPOINTS: string[] = [
  '/balance/',
  '/reputation/',
  '/resources/metering/',
  '/resources/marketplace/',
];

/**
 * Load or generate a 32-byte random hex API token.
 * Stored as plain text at <dataDir>/api-token.
 */
function loadOrGenerateApiToken(dataDir: string): string {
  const pandoDir = dataDir;
  const tokenPath = join(pandoDir, 'api-token');
  try {
    if (existsSync(tokenPath)) {
      const existing = readFileSync(tokenPath, 'utf-8').trim();
      if (existing.length > 0) {
        console.log('[api] Loaded API token from', tokenPath);
        return existing;
      }
    }
  } catch {
    // Fall through to generation
  }
  const token = randomBytes(32).toString('hex');
  try {
    if (!existsSync(pandoDir)) {
      mkdirSync(pandoDir, { recursive: true });
    }
    writeFileSync(tokenPath, token, { mode: 0o600 });
    console.log('[api] Generated new API token at', tokenPath);
  } catch (err: any) {
    console.error('[api] Warning: could not write API token file:', err.message);
  }
  return token;
}

export class ApiServer {
  private fastify: ReturnType<typeof Fastify>;
  private apiToken: string;
  private node: PandoNode;
  private sseClients: Set<any> = new Set();
  private sseTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot: string = '';

  private rateLimiters = new Map<string, RateLimiter>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private agentManager: AgentManager | null = null;

  constructor(node: PandoNode) {
    this.node = node;
    this.fastify = Fastify({ logger: false });
    this.fastify.register(cors, { origin: true });
    // Allow empty bodies with Content-Type: application/json (Fastify rejects them by default)
    this.fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req: any, body: string, done: any) => {
      try {
        const json = body && body.length > 0 ? JSON.parse(body) : {};
        done(null, json);
      } catch (err: any) {
        const badRequest: any = new Error('Invalid JSON body');
        badRequest.statusCode = 400;
        done(badRequest, undefined);
      }
    });
    this.apiToken = loadOrGenerateApiToken(node.getDataDir() || join(homedir(), '.pando'));

    this.setupAuth();
    this.setupRateLimiting();
    this.setupRoutes();
  }

  /** Add onRequest hook that checks Bearer token on protected endpoints. */
  private setupAuth(): void {
    if (process.env.API_AUTH_DISABLED === 'true') {
      console.log('[api] API authentication DISABLED via API_AUTH_DISABLED=true');
      return;
    }

    console.log('[api] API authentication enabled');

    this.fastify.addHook('onRequest', async (request: any, reply: any) => {
      // All GET requests are public (read-only). Auth only on mutations (POST/PUT/DELETE).
      const method = request.method;
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;

      // Auth and project endpoints use their own authentication or are public.
      // They do not require the node-level API Bearer token.
      const urlPath = (request.url as string).split('?')[0];
      if (urlPath.startsWith('/auth/') || urlPath.startsWith('/projects')) return;

      // Extract Bearer token from Authorization header
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Missing or invalid Authorization header', code: 'UNAUTHORIZED' });
      }

      const token = authHeader.slice(7);
      if (token !== this.apiToken) {
        return reply.code(403).send({ error: 'Invalid API token', code: 'FORBIDDEN' });
      }
    });
  }

  private setupRateLimiting(): void {
    // Create a rate limiter for each configured endpoint
    for (const [route, config] of Object.entries(RATE_LIMITS)) {
      const max = getEnvLimit(config.envVar, config.max);
      this.rateLimiters.set(route, new RateLimiter(max));
    }

    // Add a preHandler that checks rate limits for configured routes
    this.fastify.addHook('onRequest', async (request: any, reply: any) => {
      const urlPath = request.url.split('?')[0];
      const key = `${request.method} ${urlPath}`;
      let limiter = this.rateLimiters.get(key);
      // Check parametric thread route: POST /tasks/<id>/thread
      if (!limiter && request.method === 'POST' && /^\/tasks\/[^/]+\/thread$/.test(urlPath)) {
        limiter = this.rateLimiters.get('POST /tasks/:id/thread');
      }
      if (!limiter) return; // No rate limit for this route
      const ip = request.ip || request.raw?.socket?.remoteAddress || 'unknown';
      if (!limiter.allow(ip)) {
        return reply.code(429).header('Retry-After', '60').send({
          error: 'Too many requests. Please try again later.',
          code: 'RATE_LIMITED',
        });
      }
    });

    // Cleanup stale rate limiter entries every 5 minutes
    this.cleanupTimer = setInterval(() => {
      for (const limiter of this.rateLimiters.values()) {
        limiter.cleanup();
      }
    }, 5 * 60_000);
  }

  private setupRoutes(): void {
    // GET /health — lightweight health check for monitoring (load balancers, uptime services)
    // Returns 200 if node is operational, 503 if not ready. No auth required.
    // If HealthMonitor is running, defers to its assessment so /health and /monitor/status agree.
    this.fastify.get('/health', async (request: any, reply: any) => {
      const network = this.node.getNetwork();
      const ledger = this.node.getLedger();
      const identity = this.node.getIdentity();

      if (!network || !ledger || !identity) {
        return reply.code(503).send({
          status: 'unhealthy',
          reason: 'Node not fully initialized',
          timestamp: Date.now(),
        });
      }

      // If HealthMonitor is available, use its nodeHealth assessment
      // so /health and /monitor/status report the same health state.
      let status: string = 'healthy';
      const monitor = this.node.getMonitor();
      if (monitor) {
        const metrics = monitor.getCurrentMetrics();
        status = metrics.nodeHealth; // 'healthy' | 'degraded' | 'critical'
      }

      const uptimeSeconds = Math.floor(process.uptime());
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const seconds = uptimeSeconds % 60;
      const uptimeFormatted = `${hours}h ${minutes}m ${seconds}s`;

      const memoryUsageMB = Math.round(process.memoryUsage().rss / (1024 * 1024) * 10) / 10;

      return {
        status,
        peerId: identity.peerId,
        peers: network.getPeerCount(),
        uptime: uptimeSeconds,
        uptimeFormatted,
        memoryUsageMB,
        schedulerEnabled: this.node.isSchedulerEnabled(),
        monitorEnabled: this.node.isMonitorEnabled(),
        nodeStartedAt: new Date(Date.now() - uptimeSeconds * 1000).toISOString(),
        version: '0.1.0',
        timestamp: Date.now(),
      };
    });

    // POST /admin/shutdown — Graceful shutdown API endpoint
    // Requires Bearer token auth. Stops agents, closes subsystems, writes reason file, exits.
    this.fastify.post('/admin/shutdown', async (request: any, reply: any) => {
      const body = request.body as { reason?: string } | undefined;
      const reason = body?.reason || 'api-shutdown';

      console.log(`[api] Shutdown requested via /admin/shutdown (reason: ${reason})`);

      // Respond immediately before shutting down
      reply.code(200).send({
        status: 'shutting_down',
        reason,
        timestamp: Date.now(),
      });

      // Run shutdown sequence asynchronously so the HTTP response can be sent
      setImmediate(async () => {
        try {
          // 1. Stop accepting new bridge items and tasks by stopping the AgentManager
          const agentManager = this.node.getAgentManager();
          if (agentManager) {
            // Send SIGTERM to all child agent processes, wait up to 10s, then SIGKILL
            const killed = await agentManager.stopAll(10_000);
            console.log(`[api] Shutdown: stopped ${killed} agent process(es)`);
            agentManager.stop();
          }

          // 2. Stop the node (closes Fastify, libp2p, SQLite, scheduler, etc.)
          await this.node.stop();

          // 3. Write shutdown reason file
          const dataDir = this.node.getDataDir() || join(homedir(), '.pando');
          const shutdownFile = join(dataDir, 'shutdown-reason.json');
          try {
            if (!existsSync(dataDir)) {
              mkdirSync(dataDir, { recursive: true });
            }
            writeFileSync(shutdownFile, JSON.stringify({
              reason,
              timestamp: Date.now(),
              pid: process.pid,
            }, null, 2));
            console.log(`[api] Wrote shutdown reason to ${shutdownFile}`);
          } catch (err: any) {
            console.error(`[api] Failed to write shutdown reason: ${err.message}`);
          }

          // 4. Exit cleanly
          console.log('[api] Graceful shutdown complete. Exiting.');
          process.exit(0);
        } catch (err: any) {
          console.error(`[api] Shutdown error: ${err.message}`);
          process.exit(1);
        }
      });
    });

    // Phase 80: POST /admin/migrate-apps — redeploy Tier 2 apps from a dead instance to a running one
    this.fastify.post('/admin/migrate-apps', async (request: any, reply: any) => {
      const body = request.body as { fromInstanceId?: string } | undefined;
      const fromInstanceId = body?.fromInstanceId;
      if (!fromInstanceId) return reply.code(400).send({ error: 'fromInstanceId is required' });

      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Find all Tier 2 projects on the dead instance
      const allProjects = await ps.listProjectsAsync?.() || [];
      const deadProjects = allProjects.filter((p: any) =>
        p.instanceId === fromInstanceId && p.tier === 2 && p.deploymentStatus === 'deployed'
      );

      if (deadProjects.length === 0) {
        return { message: 'No Tier 2 projects found on that instance', fromInstanceId };
      }

      // Find a running instance to migrate to
      const instances = this.node.getCloudInstanceManager?.()?.getInstances() || [];
      const targetInstance = instances.find((i: any) => i.instanceId !== fromInstanceId && i.status === 'running' && i.peerId);

      if (!targetInstance) {
        return reply.code(503).send({ error: 'No running compute instance available to migrate to' });
      }

      const results: any[] = [];
      const requestReply = this.node.getRequestReply?.();

      for (const project of deadProjects) {
        try {
          if (!requestReply || !project.githubRepo) {
            results.push({ projectId: project.id, status: 'skipped', reason: 'No requestReply or githubRepo' });
            continue;
          }

          const repoUrl = `https://github.com/${project.githubRepo}.git`;
          const response = await requestReply.request(targetInstance.peerId!, 'pando/deploy-app', {
            projectId: project.id,
            repoUrl,
            tier: 2,
            envVars: {
              PANDO_GATEWAY_URL: process.env.GATEWAY_PUBLIC_URL || 'https://gateway-one-mu.vercel.app',
              PANDO_PROJECT_ID: project.id,
              PANDO_PROJECT_API_KEY: (project as any).apiKey || '',
            },
          }, 300_000);

          if (response?.success && response.payload?.status === 'deployed') {
            const payload = response.payload as any;
            const liveUrl = `http://${targetInstance.publicIp}/apps/${project.id}/`;
            await ps.updateProject(project.id, {
              deploymentUrl: liveUrl,
              instanceId: targetInstance.instanceId,
              deploymentPort: payload.port,
              updatedAt: Date.now(),
            });
            results.push({ projectId: project.id, status: 'migrated', url: liveUrl });
          } else {
            results.push({ projectId: project.id, status: 'failed', error: response?.payload?.error });
          }
        } catch (err: any) {
          results.push({ projectId: project.id, status: 'error', error: err.message });
        }
      }

      console.log(`[admin] Migrated ${results.filter(r => r.status === 'migrated').length}/${deadProjects.length} apps from ${fromInstanceId}`);
      return { fromInstanceId, targetInstanceId: targetInstance.instanceId, results };
    });

    // Phase 80: POST /admin/cleanup-projects — soft-delete (archive) specified projects
    this.fastify.post('/admin/cleanup-projects', async (request: any, reply: any) => {
      const body = request.body as { projectIds?: string[] } | undefined;
      const projectIds = body?.projectIds;
      if (!projectIds || !Array.isArray(projectIds) || projectIds.length === 0) {
        return reply.code(400).send({ error: 'projectIds array is required' });
      }

      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const results: any[] = [];
      for (const id of projectIds) {
        try {
          await ps.updateProject(id, { status: 'archived', updatedAt: Date.now() });
          results.push({ projectId: id, status: 'archived' });
        } catch (err: any) {
          results.push({ projectId: id, status: 'error', error: err.message });
        }
      }

      // Also update P2P ProjectRegistry
      const pr = this.node.getProjectRegistry?.();
      if (pr) {
        for (const id of projectIds) {
          try { pr.updateProject(id, { status: 'archived' } as any); } catch {}
        }
      }

      console.log(`[admin] Archived ${results.filter(r => r.status === 'archived').length}/${projectIds.length} projects`);
      return { results };
    });

    // GET /status — node status
    this.fastify.get('/status', async () => {
      const network = this.node.getNetwork();
      const ledger = this.node.getLedger();
      const identity = this.node.getIdentity();

      if (!network || !ledger || !identity) {
        return { connected: false, peers: 0, identity: '', balance: 0, totalSupply: 0, totalAccounts: 0 };
      }

      const stats = ledger.getNetworkStats();
      return {
        connected: true,
        peerId: identity.peerId,
        publicKey: uint8ArrayToString(identity.publicKey, 'base64'),  // Phase 41: expose for E2E encryption
        peers: network.getPeerCount(),
        peerList: network.getPeers().map(p => p.peerId),
        identity: identity.peerId,
        balance: ledger.accounts.getBalance(identity.peerId),
        totalSupply: stats.totalSupply,
        totalAccounts: stats.totalAccounts,
        totalBurned: stats.totalBurned,
        totalRelayFees: stats.totalRelayFees,
        totalTransactions: stats.totalTransactions,
        circulatingSupply: stats.circulatingSupply,
        activeContributors: stats.activeContributors,
        uptime: Math.floor(process.uptime()),
        nodeStartedAt: NODE_STARTED_AT,
        version: '0.1.0',
        pipelineEnabled: this.node.isPipelineEnabled(),
        listenAddresses: network.getListenAddresses(),
        capabilities: this.node.getCapabilities(),
        storageBackend: this.node.getStorageBackendType(),
        storageConnected: this.node.getStorageBackend() !== null,
        linkedUser: this.node.getLinkedUser(),
        nodeMode: this.node.getNodeMode(),
        ledgerMode: this.node.getLedgerMode(),
        cloudInstances: this.node.getCloudInstanceManager()?.getInstances().length || 0,
      };
    });

    // GET /wallet — ownership info for this node
    this.fastify.get('/wallet', async () => {
      const identity = this.node.getIdentity();
      const ledger = this.node.getLedger();

      if (!identity || !ledger) {
        return { error: 'Node not ready' };
      }

      const balance = ledger.accounts.getBalance(identity.peerId);
      const account = ledger.accounts.get(identity.peerId);
      const txs = ledger.transactions.getTransactionsForPeer(identity.peerId, 10);

      return {
        peerId: identity.peerId,
        publicKey: uint8ArrayToString(identity.publicKey, 'base64'),
        balance,
        createdAt: identity.createdAt,
        accountCreatedAt: account?.createdAt,
        recentTransactions: txs.length,
        dataDir: this.node.getDataDir(),
        ownership: {
          explanation: 'Your Lux is tied to your Ed25519 private key stored in identity.json. ' +
            'Your peer ID is your wallet address. Whoever holds the private key owns the Lux.',
          identityFile: join(this.node.getDataDir(), 'identity.json'),
          backup: 'Copy your identity.json to a safe place. If you lose it, you lose your Lux.',
        },
      };
    });

    // GET /balance/:peerId — balance lookup
    this.fastify.get('/balance/:peerId', async (request: any, reply: any) => {
      const ledger = this.node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      const peerId = request.params.peerId;
      const balance = ledger.accounts.getBalance(peerId);
      return { peerId, balance };
    });

    // GET /peers — list connected peers with balances
    this.fastify.get('/peers', async () => {
      const network = this.node.getNetwork();
      const ledger = this.node.getLedger();
      if (!network) return { peers: [] };

      return {
        peers: network.getPeers().map(p => ({
          peerId: p.peerId,
          connectedAt: p.connectedAt,
          lastSeen: p.lastSeen,
          balance: ledger ? ledger.accounts.getBalance(p.peerId) : 0,
        })),
      };
    });

    // GET /transactions — recent transactions for this node (or authenticated user)
    this.fastify.get('/transactions', async (request: any) => {
      const ledger = this.node.getLedger();
      const identity = this.node.getIdentity();
      if (!ledger || !identity) return { transactions: [] };

      const limit = parseInt(request.query?.limit) || 50;
      // If a user is authenticated, return their transactions; otherwise fall back to node identity
      const userPeerId = await this.verifyUserJwt(request);
      const targetPeerId = userPeerId || identity.peerId;
      const txs = ledger.transactions.getTransactionsForPeer(targetPeerId, limit);
      return { transactions: txs, peerId: targetPeerId };
    });

    // POST /connect — connect to a peer by multiaddr
    this.fastify.post('/connect', async (request: any, reply: any) => {
      const network = this.node.getNetwork();
      if (!network) return reply.code(503).send({ error: 'Network not ready' });
      const { addr } = request.body || {};
      if (!addr || typeof addr !== 'string') {
        return reply.code(400).send({ error: 'addr (multiaddr string) is required' });
      }
      try {
        const peerId = await network.dialPeer(addr);
        return { success: true, peerId };
      } catch (err: any) {
        return reply.code(500).send({ error: `Connection failed: ${err.message}` });
      }
    });

    // POST /transfer — transfer Lux
    this.fastify.post('/transfer', async (request: any, reply: any) => {
      const ledger = this.node.getLedger();
      const identity = this.node.getIdentity();

      if (!ledger || !identity) {
        return reply.code(503).send({ error: 'Node not ready', code: 'NODE_NOT_READY' });
      }

      const { to, amount } = request.body || {};
      if (!to || typeof to !== 'string') {
        return reply.code(400).send({ error: 'Missing or invalid "to" peer ID', code: 'INVALID_RECIPIENT' });
      }
      if (!amount || typeof amount !== 'number' || amount <= 0) {
        return reply.code(400).send({ error: 'Missing or invalid "amount" — must be a positive number', code: 'INVALID_AMOUNT' });
      }
      // Resolve sender: use authenticated user's peerId if available, fall back to node identity
      const userPeerId = await this.verifyUserJwt(request);
      const senderPeerId = userPeerId || identity.peerId;

      if (to === senderPeerId) {
        return reply.code(400).send({ error: 'Cannot transfer to yourself', code: 'SELF_TRANSFER' });
      }

      try {
        // Phase 54.3: Auto-register recipient if valid peerId format (no need to be connected)
        const network = this.node.getNetwork();
        if (!ledger.accounts.exists(to)) {
          if (to.startsWith('12D3KooW') && to.length > 40) {
            ledger.registerNode(to, 'remote-transfer');
          } else {
            return reply.code(404).send({
              error: 'Invalid peer ID format',
              code: 'INVALID_PEER_ID',
            });
          }
        }

        // Check balance before attempting transfer
        const senderBalance = ledger.accounts.getBalance(senderPeerId);
        if (senderBalance < amount) {
          return reply.code(400).send({
            error: `Insufficient balance: you have ${senderBalance} Lux but need ${amount} Lux (plus relay fee)`,
            code: 'INSUFFICIENT_BALANCE',
            balance: senderBalance,
            requested: amount,
          });
        }

        // Pick a relay: random connected peer (not sender, not recipient)
        const peers = network?.getPeers() || [];
        const thirdParty = peers.filter(p => p.peerId !== senderPeerId && p.peerId !== to);
        const relay = thirdParty.length > 0
          ? thirdParty[Math.floor(Math.random() * thirdParty.length)].peerId
          : (to !== senderPeerId ? to : undefined);

        if (relay && !ledger.accounts.exists(relay)) {
          ledger.registerNode(relay, 'remote-peer');
        }

        const tx = ledger.transfer(senderPeerId, to, amount, relay);

        // Sign the transaction with our private key
        tx.signature = await signTransaction(tx, identity.privateKey);
        // Persist signature to ledger DB so local queries return signed records
        ledger.transactions.updateSignature(tx.id, tx.signature);

        // Broadcast to peers via GossipSub
        const sync = this.node.getSync();
        if (sync) {
          await sync.broadcastTransaction(tx);
        }

        // Push to SSE clients immediately
        this.pushEvent('transaction', {
          id: tx.id,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
          type: tx.type,
          timestamp: tx.timestamp,
        });

        return { success: true, transaction: tx };
      } catch (err: any) {
        // Categorize known ledger errors
        const msg = err.message || 'Unknown error';
        if (msg.includes('Insufficient balance')) {
          return reply.code(400).send({ error: msg, code: 'INSUFFICIENT_BALANCE' });
        }
        if (msg.includes('not found')) {
          return reply.code(404).send({ error: msg, code: 'ACCOUNT_NOT_FOUND' });
        }
        return reply.code(500).send({ error: msg, code: 'TRANSFER_FAILED' });
      }
    });

    // ── Task Queue Routes ──

    // GET /tasks — list tasks (filterable by status, priority, assignedTo)
    this.fastify.get('/tasks', async (request: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return { tasks: [] };
      const q = request.query || {};
      const statusParam = q.status;
      const status = statusParam ? (statusParam.includes(',') ? statusParam.split(',') : statusParam) : undefined;
      return {
        tasks: tq.getTasks({
          status,
          priority: q.priority,
          assignedTo: q.assignedTo,
          limit: q.limit ? parseInt(q.limit) : undefined,
        }),
      };
    });

    // GET /tasks/stats — task queue statistics
    this.fastify.get('/tasks/stats', async () => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return { stats: {} };
      return { stats: tq.getStats() };
    });

    // GET /tasks/next — get next claimable task
    this.fastify.get('/tasks/next', async (request: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return { task: null };
      const agentId = request.query?.agentId;
      const task = tq.getNextClaimable(agentId);
      return { task };
    });

    // GET /tasks/agent/:agentId — get tasks claimed by a specific agent
    this.fastify.get('/tasks/agent/:agentId', async (request: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return { tasks: [] };
      return { tasks: tq.getClaimedTasks(request.params.agentId) };
    });

    // GET /tasks/archive — list archived tasks
    this.fastify.get('/tasks/archive', async (request: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return { tasks: [] };
      const limit = request.query?.limit ? parseInt(request.query.limit) : 50;
      return { tasks: tq.getArchivedTasks(limit) };
    });

    // POST /tasks/archive — trigger archival of old done/rejected tasks
    this.fastify.post('/tasks/archive', async (request: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return { archived: 0 };
      const olderThanMs = request.body?.olderThanMs || 7 * 24 * 60 * 60 * 1000;
      return tq.archiveOldTasks(olderThanMs);
    });

    // GET /tasks/:id — get a specific task
    this.fastify.get('/tasks/:id', async (request: any, reply: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const task = tq.getTask(request.params.id);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      return { task };
    });

    // POST /tasks — create a new task
    this.fastify.post('/tasks', async (request: any, reply: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { title, description, priority, createdBy, files, dependencies, requiredCapabilities, managerId } = request.body || {};
      if (!title) {
        return reply.code(400).send({ error: 'title is required' });
      }

      // Phase 19.2: Worker lockdown — when enabled, only managers and node admins can create tasks
      const workerLockdown = process.env.PANDO_WORKER_LOCKDOWN !== 'false';
      if (workerLockdown) {
        const localPeerId = this.node.getIdentity()?.peerId;
        if (!managerId && createdBy !== localPeerId) {
          return reply.code(403).send({ error: 'Tasks must be created by a Manager or node admin' });
        }
      }

      // Explicitly pass originNode so it's set even if TaskQueue.localPeerId isn't wired yet
      const identity = this.node.getIdentity();
      const task = tq.createTask({
        title,
        description: description || '',
        priority,
        createdBy: createdBy || 'admin',
        files,
        dependencies,
        originNode: identity?.peerId,
        requiredCapabilities,
        managerId,
      });

      // Phase 18.3: Seed first thread message with task description
      if (description) {
        tq.addMessage(task.id, {
          from: identity?.peerId || createdBy || 'admin',
          role: 'user',
          content: description,
        });
      }

      return { success: true, task };
    });

    // POST /tasks/:id/claim — claim a task for an agent
    this.fastify.post('/tasks/:id/claim', async (request: any, reply: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { agentId } = request.body || {};
      if (!agentId) return reply.code(400).send({ error: 'agentId is required' });
      const result = tq.claimTask(request.params.id, agentId);
      if (!result.success) return reply.code(409).send({ error: result.error });
      return { success: true };
    });

    // POST /tasks/:id/complete — mark a task as done
    this.fastify.post('/tasks/:id/complete', async (request: any, reply: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { commitHash, buildPassed, testsPassed, note } = request.body || {};
      const success = tq.completeTask(request.params.id, {
        commitHash, buildPassed, testsPassed, note,
      });
      if (!success) return reply.code(404).send({ error: 'Task not found' });

      // Report cascade-rejected children in the response
      const task = tq.getTask(request.params.id);
      const rejectedChildren: string[] = [];
      if (task?.childTasks) {
        for (const childId of task.childTasks) {
          const child = tq.getTask(childId);
          if (child && child.status === 'rejected' && child.result?.note === 'Parent task completed') {
            rejectedChildren.push(childId);
          }
        }
      }

      return { success: true, ...(rejectedChildren.length > 0 ? { rejectedChildren } : {}) };
    });

    // POST /tasks/:id/reject — permanently reject a task (persists status as 'rejected')
    this.fastify.post('/tasks/:id/reject', async (request: any, reply: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { reason } = request.body || {};
      const taskId = request.params.id;
      const task = tq.getTask(taskId);
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      // Use rejectTask to persist the reason in result.note (sets status to 'open')
      const success = tq.rejectTask(taskId, reason);
      if (!success) return reply.code(500).send({ error: 'Failed to reject task' });

      // Fix: override status to 'rejected' so the task is permanently rejected
      // and does not get re-picked by the scheduler (rejectTask sets 'open')
      tq.updateStatus(taskId, 'rejected');

      // Add timeline event for the rejection
      tq.pushTimelineEvent(taskId, {
        event: 'rejected',
        detail: reason ? `Rejected: ${reason}` : 'Task rejected via API',
        metadata: { source: 'api' },
      });

      return { success: true };
    });

    // POST /tasks/:id/release — release a claimed task back to open (advisory)
    this.fastify.post('/tasks/:id/release', async (request: any, reply: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { agentId } = request.body || {};
      if (!agentId) return reply.code(400).send({ error: 'agentId is required' });
      const result = tq.releaseTask(request.params.id, agentId);
      if (!result.success) return reply.code(409).send({ error: result.error });
      return { success: true };
    });

    // POST /tasks/:id/approve — push a task to the scheduler's approved queue
    // Auto-generates a profile via Planner if none provided
    this.fastify.post('/tasks/:id/approve', async (request: any, reply: any) => {
      const scheduler = this.node.getScheduler();
      if (!scheduler) return reply.code(503).send({ error: 'Scheduler not available' });
      const taskId = request.params.id;
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const task = tq.getTask(taskId);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      if (task.status !== 'open') return reply.code(409).send({ error: `Task status is '${task.status}', expected 'open'` });

      // Resolve agent profile — use provided profile, or auto-generate via Planner
      const { profile: providedProfile } = request.body || {};
      let resolvedProfile: any;

      if (providedProfile) {
        resolvedProfile = providedProfile;
      } else {
        resolvedProfile = {
          profileId: `auto-${Date.now()}`,
          role: 'general',
          contextNeeds: [],
          tools: [],
          tier: 'short-session' as any,
          systemPrompt: `Complete this task: ${task.title}`,
        };
      }

      // Pass profile to scheduler via the new 3rd parameter — stored in approvedProfiles Map
      scheduler.receiveApprovedTask(taskId, 'api', resolvedProfile);
      return { success: true, taskId, profileId: resolvedProfile?.profileId };
    });

    // POST /tasks/:id/status — update task status
    this.fastify.post('/tasks/:id/status', async (request: any, reply: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const { status, assignedTo } = request.body || {};
      if (!status) return reply.code(400).send({ error: 'status is required' });
      const success = tq.updateStatus(request.params.id, status, assignedTo);
      if (!success) return reply.code(404).send({ error: 'Task not found' });
      return { success: true };
    });

    // ── Task Thread Routes (Phase 18.3) ──

    // GET /tasks/:id/thread — get conversation thread for a task
    this.fastify.get('/tasks/:id/thread', async (request: any, reply: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const task = tq.getTask(request.params.id);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      return { thread: tq.getThread(request.params.id) };
    });

    // POST /tasks/:id/thread — add a message to a task's conversation thread
    this.fastify.post('/tasks/:id/thread', async (request: any, reply: any) => {
      const tq = this.node.getActiveTaskQueue();
      if (!tq) return reply.code(503).send({ error: 'No task queue available' });
      const task = tq.getTask(request.params.id);
      if (!task) return reply.code(404).send({ error: 'Task not found' });
      const { content, role } = request.body || {};
      if (!content || typeof content !== 'string') {
        return reply.code(400).send({ error: '"content" (string) is required' });
      }
      if (content.length > 5000) {
        return reply.code(400).send({ error: 'Message too long (max 5000 characters)' });
      }
      const validRoles = ['user', 'agent', 'system'];
      const msgRole = validRoles.includes(role) ? role : 'user';
      const identity = this.node.getIdentity();
      const msg = tq.addMessage(request.params.id, {
        from: identity?.peerId || 'anonymous',
        role: msgRole,
        content: content.trim(),
      });
      if (!msg) return reply.code(500).send({ error: 'Failed to add message' });
      return { success: true, message: msg };
    });

    // ── Governance Routes ──

    // GET /governance/proposals — list all proposals (with vote counts, comments, decisions)
    this.fastify.get('/governance/proposals', async () => {
      const gov = this.node.getGovernance();
      if (!gov) return { proposals: [] };
      const proposals = gov.getProposals();
      return {
        proposals: proposals.map(p => {
          const votes = gov.getVotes(p.id);
          return {
            ...p,
            votes: {
              approve: votes.filter(v => v.choice === 'approve').length,
              reject: votes.filter(v => v.choice === 'reject').length,
              abstain: votes.filter(v => v.choice === 'abstain').length,
            },
            commentCount: gov.getComments(p.id).length,
            decision: gov.getDecision(p.id) || null,
          };
        }),
      };
    });

    // GET /governance/proposals/active — list active proposals (with vote counts, comments, decisions)
    this.fastify.get('/governance/proposals/active', async () => {
      const gov = this.node.getGovernance();
      if (!gov) return { proposals: [] };
      const proposals = gov.getActiveProposals();
      return {
        proposals: proposals.map(p => {
          const votes = gov.getVotes(p.id);
          return {
            ...p,
            votes: {
              approve: votes.filter(v => v.choice === 'approve').length,
              reject: votes.filter(v => v.choice === 'reject').length,
              abstain: votes.filter(v => v.choice === 'abstain').length,
            },
            commentCount: gov.getComments(p.id).length,
            decision: gov.getDecision(p.id) || null,
          };
        }),
      };
    });

    // GET /governance/proposal/:id — get proposal details
    this.fastify.get('/governance/proposal/:id', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const proposal = gov.getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      return {
        proposal,
        comments: gov.getComments(proposal.id),
        votes: gov.getVotes(proposal.id),
        decision: gov.getDecision(proposal.id),
      };
    });

    // GET /governance/proposal/:id/models — model breakdown for a proposal (Phase 10.5)
    this.fastify.get('/governance/proposal/:id/models', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const proposal = gov.getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      return gov.getModelBreakdown(proposal.id);
    });

    // DELETE /governance/proposal/:id — delete a proposal (admin cleanup)
    this.fastify.delete('/governance/proposal/:id', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      try {
        const result = gov.deleteProposal(request.params.id);
        return { success: true, deleted: result.title };
      } catch (err: any) {
        return reply.code(404).send({ error: err.message });
      }
    });

    // POST /governance/propose — create a new proposal
    this.fastify.post('/governance/propose', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const { title, description, votingDurationMs, category, isEmergency } = request.body || {};
      if (!title || !description) return reply.code(400).send({ error: 'title and description required' });
      const trimmedTitle = title.trim();
      const trimmedDesc = description.trim();
      if (!trimmedTitle) return reply.code(400).send({ error: 'Title cannot be empty' });
      if (trimmedTitle.length > 200) return reply.code(400).send({ error: 'Title must be 200 characters or fewer' });
      if (trimmedDesc.length > 2000) return reply.code(400).send({ error: 'Description must be 2000 characters or fewer' });
      try {
        const proposal = await gov.createProposal(trimmedTitle, trimmedDesc, votingDurationMs || 300_000, { category, isEmergency });
        return { success: true, proposal };
      } catch (err: any) {
        return reply.code(429).send({ error: err.message });
      }
    });

    // POST /governance/comment — add comment to a proposal
    this.fastify.post('/governance/comment', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const { proposalId, content } = request.body || {};
      if (!proposalId || !content) return reply.code(400).send({ error: 'proposalId and content required' });
      const proposal = gov.getProposal(proposalId);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      try {
        await gov.addComment(proposalId, content);
        return { success: true };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // POST /governance/vote — cast a vote on a proposal (with optional model attestation)
    this.fastify.post('/governance/vote', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const { proposalId, choice, reasoning, modelAttestation } = request.body || {};
      if (!proposalId || !choice) return reply.code(400).send({ error: 'proposalId and choice required' });
      if (!['approve', 'reject', 'abstain'].includes(choice)) {
        return reply.code(400).send({ error: 'choice must be approve, reject, or abstain' });
      }
      try {
        await gov.castVote(proposalId, choice, reasoning || '', modelAttestation || undefined);
        // Return updated vote counts and decision (quorum may have been reached)
        const votes = gov.getVotes(proposalId);
        const decision = gov.getDecision(proposalId);
        return {
          success: true,
          votes: {
            approve: votes.filter(v => v.choice === 'approve').length,
            reject: votes.filter(v => v.choice === 'reject').length,
            abstain: votes.filter(v => v.choice === 'abstain').length,
          },
          decision: decision || null,
        };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // POST /governance/message — send agent-to-agent message
    this.fastify.post('/governance/message', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const { content, to } = request.body || {};
      if (!content) return reply.code(400).send({ error: 'content required' });
      await gov.sendAgentMessage(content, to || 'all');
      return { success: true };
    });

    // ── Phase 30.7: Governance Review API Routes ──

    // GET /governance/proposals/:id/reviews — get all AI reviews for a proposal
    this.fastify.get('/governance/proposals/:id/reviews', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const proposal = gov.getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      const reviews = gov.getProposalReviews(proposal.id);
      const summary = gov.computeReviewSummary(proposal.id);
      return { proposalId: proposal.id, reviews, summary: summary || null };
    });

    // GET /governance/proposals/:id/reviewers — get reviewer assignments and status
    this.fastify.get('/governance/proposals/:id/reviewers', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const proposal = gov.getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });
      const reviewers = gov.getReviewerAssignments(proposal.id);
      const selectedReviewers = gov.getSelectedReviewers(proposal.id);
      return {
        proposalId: proposal.id,
        reviewers,
        selectedReviewers,
        reviewerCount: proposal.reviewerCount ?? 0,
        humanOnly: proposal.humanOnly ?? false,
      };
    });

    // POST /governance/proposals/:id/review — submit a review (for reviewer agents, requires auth)
    this.fastify.post('/governance/proposals/:id/review', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const identity = this.node.getIdentity();
      if (!identity) return reply.code(503).send({ error: 'Node not ready' });

      const proposal = gov.getProposal(request.params.id);
      if (!proposal) return reply.code(404).send({ error: 'Proposal not found' });

      const { riskScore, reasoning, recommendation, modelAttestation } = request.body || {};
      if (riskScore === undefined || !reasoning || !recommendation) {
        return reply.code(400).send({ error: 'riskScore, reasoning, and recommendation are required' });
      }
      if (typeof riskScore !== 'number' || riskScore < 1 || riskScore > 5) {
        return reply.code(400).send({ error: 'riskScore must be a number between 1 and 5' });
      }
      if (!['approve', 'reject', 'revise'].includes(recommendation)) {
        return reply.code(400).send({ error: 'recommendation must be approve, reject, or revise' });
      }

      try {
        const review = await gov.submitReview(proposal.id, identity.peerId, {
          riskScore,
          reasoning: String(reasoning).slice(0, 5000),
          recommendation,
          modelAttestation: modelAttestation || undefined,
        });
        return { success: true, review };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // GET /governance/stats — enhanced governance statistics
    this.fastify.get('/governance/stats', async (request: any, reply: any) => {
      const gov = this.node.getGovernance();
      if (!gov) return reply.code(503).send({ error: 'Governance not ready' });
      const stats = gov.getGovernanceStats();
      const proposals = gov.getProposals();
      const statusCounts: Record<string, number> = {};
      for (const p of proposals) {
        statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
      }
      return {
        ...stats,
        statusCounts,
      };
    });

    // ── File Registry Routes ──

    // GET /files/claims — list all active file claims
    this.fastify.get('/files/claims', async () => {
      const registry = this.node.getFileRegistry();
      return { claims: registry.listClaims() };
    });

    // POST /files/claim — claim a file for editing
    this.fastify.post('/files/claim', async (request: any, reply: any) => {
      const identity = this.node.getIdentity();
      if (!identity) return reply.code(503).send({ error: 'Node not ready' });
      const { filePath } = request.body || {};
      if (!filePath || typeof filePath !== 'string') {
        return reply.code(400).send({ error: 'filePath is required' });
      }
      const registry = this.node.getFileRegistry();
      const success = registry.claimFile(filePath, identity.peerId);
      if (!success) {
        const existing = registry.checkClaim(filePath, identity.peerId);
        return reply.code(409).send({
          error: 'File already claimed by another agent',
          claim: existing,
        });
      }
      return { success: true, filePath };
    });

    // POST /files/release — release a file claim
    this.fastify.post('/files/release', async (request: any, reply: any) => {
      const identity = this.node.getIdentity();
      if (!identity) return reply.code(503).send({ error: 'Node not ready' });
      const { filePath } = request.body || {};
      if (!filePath || typeof filePath !== 'string') {
        return reply.code(400).send({ error: 'filePath is required' });
      }
      const registry = this.node.getFileRegistry();
      const released = registry.releaseFile(filePath, identity.peerId);
      if (!released) {
        return reply.code(404).send({ error: 'No active claim found for this file by your identity' });
      }
      return { success: true, filePath };
    });

    // ── Pipeline Routes (Phase 16) ──

    // GET /pipeline/status — pipeline enabled/disabled state and component info
    this.fastify.get('/pipeline/status', async () => {
      const enabled = this.node.isPipelineEnabled();
      const runner = this.node.getPipelineRunner();
      if (!enabled || !runner) {
        return {
          enabled: false,
          running: false,
          currentStage: null,
          runsCompleted: 0,
          lastRun: null,
        };
      }
      const status = runner.getPipelineStatus();
      return {
        enabled: true,
        ...status,
      };
    });

    // Phase 33: POST /pipeline/run — agent-triggered pipeline for applying workspace changes
    this.fastify.post('/pipeline/run', async (request: any, reply: any) => {
      const runner = this.node.getPipelineRunner();
      if (!runner) {
        return reply.code(503).send({ error: 'Pipeline not available (node started without --pipeline flag)' });
      }

      const body = (request.body as { workspaceDir?: string; proposalId?: string }) || {};
      const workspaceDir = body.workspaceDir;
      if (!workspaceDir) {
        return reply.code(400).send({ error: 'workspaceDir is required' });
      }

      // For governance-approved changes, skip QA — the governance process IS the review
      const isGovernanceRun = !!body.proposalId;
      const overrides = isGovernanceRun ? { skipQa: true, useGitDiff: true } : undefined;

      try {
        console.log(`[pipeline] Agent-triggered pipeline run from workspace: ${workspaceDir}${body.proposalId ? ` (proposal: ${body.proposalId})` : ''}`);
        if (isGovernanceRun) {
          console.log(`[pipeline] Governance-approved run — QA skipped (proposal: ${body.proposalId})`);
        }
        const result = await runner.runPipeline(workspaceDir, body.proposalId, overrides);

        const response = {
          success: result.success,
          pipelineId: result.pipelineId,
          stages: result.stages.map((s: any) => ({
            stage: s.stage,
            success: s.success,
            durationMs: s.durationMs,
            error: s.error,
          })),
          totalDurationMs: result.totalDurationMs,
        };

        // Schedule graceful restart after successful governance pipeline
        if (result.success && isGovernanceRun) {
          // Check if any changed files require a node restart
          const pipelineResult = result.pipelineResult;
          const changedFiles = pipelineResult?.patchSet?.changes?.map((c: any) => c.filePath).filter(Boolean) || [];
          const needsRestart = changedFiles.some(
            (f: string) => f.startsWith('packages/node/') || f.startsWith('packages/shared/') || f.startsWith('packages/ledger/')
          ) || changedFiles.length === 0; // Default to restart if we can't determine

          if (needsRestart) {
            console.log('[pipeline] Governance pipeline succeeded — node source changed, scheduling restart in 5s');
            setTimeout(async () => {
              try {
                const { writeRestartReason } = await import('./restart-reason.js');
                writeRestartReason('pipeline-deploy');

                // Phase 34: Use restart handler if set (TUI intercepts this)
                const handler = this.node.getRestartHandler();
                if (handler) {
                  handler('pipeline-deploy', changedFiles);
                  return;
                }

                // Fallback: direct shutdown + exit (headless/PM2 mode)
                console.log('[pipeline] Graceful shutdown: stopping agents...');
                const agentManager = this.node.getAgentManager();
                if (agentManager) {
                  const killed = await agentManager.stopAll(10_000);
                  console.log(`[pipeline] Stopped ${killed} agent process(es)`);
                  agentManager.stop();
                }

                console.log('[pipeline] Graceful shutdown: stopping node...');
                await this.node.stop();

                console.log('[pipeline] Graceful restart — exit code 75 (launcher will restart)');
                process.exit(75);
              } catch (err) {
                console.error('[pipeline] Restart failed, forcing exit:', err);
                process.exit(75);
              }
            }, 5000);
          } else {
            console.log('[pipeline] Governance pipeline succeeded — no node source changes, skipping restart');
          }
        }

        return response;
      } catch (err: any) {
        return reply.code(500).send({ error: err.message || 'Pipeline failed' });
      }
    });

    // GET /transactions/:peerId — transaction history for a peer
    this.fastify.get('/transactions/:peerId', async (request: any, reply: any) => {
      const ledger = this.node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      const peerId = request.params.peerId;
      const limit = Math.min(parseInt(request.query?.limit) || 50, 200);
      const txs = ledger.transactions.getTransactionsForPeer(peerId, limit);

      return {
        peerId,
        transactions: txs.map((tx: any) => ({
          id: tx.id,
          from: tx.from_peer,
          to: tx.to_peer,
          amount: tx.amount,
          fee: tx.fee,
          relay: tx.relay_peer,
          type: tx.type,
          timestamp: tx.timestamp,
        })),
      };
    });

    // ── Agent Transparency Routes ──

    // GET /network/overview — single "what's happening" call
    this.fastify.get('/network/overview', async () => {
      const network = this.node.getNetwork();
      const ledger = this.node.getLedger();
      const identity = this.node.getIdentity();
      const gov = this.node.getGovernance();

      const stats = ledger?.getNetworkStats();
      const peerList = network?.getPeers() || [];
      const activeProposals = gov ? gov.getActiveProposals() : [];
      const recentActivity = ledger ? ledger.getActivity({ limit: 10 }) : [];

      return {
        nodes: {
          self: identity?.peerId || null,
          peerCount: peerList.length,
          peers: peerList.map(p => ({
            peerId: p.peerId,
            connectedAt: p.connectedAt,
            lastSeen: p.lastSeen,
          })),
        },
        agents: {
          knownAgents: this.node.getKnownAgents(),
        },
        activeProposals: activeProposals.length,
        recentActivity,
        luxMetrics: {
          totalSupply: stats?.totalSupply || 0,
          circulatingSupply: stats?.circulatingSupply || 0,
          totalBurned: stats?.totalBurned || 0,
          totalRelayFees: stats?.totalRelayFees || 0,
          totalAccounts: stats?.totalAccounts || 0,
          totalTransactions: stats?.totalTransactions || 0,
        },
        uptime: Math.floor(process.uptime()),
      };
    });

    // GET /network/topology — network graph: nodes + edges
    this.fastify.get('/network/topology', async () => {
      const network = this.node.getNetwork();
      const identity = this.node.getIdentity();
      if (!network || !identity) {
        return { nodes: [], edges: [] };
      }

      const peers = network.getPeers();
      const nodes = [
        { peerId: identity.peerId, connectedSince: null },
        ...peers.map(p => ({ peerId: p.peerId, connectedSince: p.connectedAt })),
      ];
      const edges = peers.map(p => ({ from: identity.peerId, to: p.peerId }));

      return { nodes, edges };
    });

    // GET /activity/stream — enhanced activity feed with agent info from the activity table
    this.fastify.get('/activity/stream', async (request: any) => {
      const ledger = this.node.getLedger();
      const parsed = parseInt(request.query?.limit);
      const limit = Math.min((!parsed || parsed <= 0) ? 50 : parsed, 200);
      const since = request.query?.since ? parseInt(request.query.since) : undefined;
      const agentId = request.query?.agentId as string | undefined;
      const action = request.query?.action as string | undefined;

      if (!ledger) return { events: [] };

      const events = ledger.getActivity({ limit, since, agentId, action });
      return { events };
    });

    // GET /activity/stats — aggregated activity stats within a time window
    this.fastify.get('/activity/stats', async (request: any, reply: any) => {
      const ledger = this.node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      const windowParam = (request.query?.window as string) || '24h';
      const windowMap: Record<string, number> = {
        '1h':  60 * 60 * 1000,
        '6h':  6 * 60 * 60 * 1000,
        '24h': 24 * 60 * 60 * 1000,
        '7d':  7 * 24 * 60 * 60 * 1000,
      };
      const windowMs = windowMap[windowParam];
      if (!windowMs) {
        return reply.code(400).send({ error: 'Invalid window. Must be one of: 1h, 6h, 24h, 7d' });
      }

      const stats = ledger.getActivityStats(windowMs);
      return { window: windowParam, ...stats };
    });

    // POST /activity/record — record a new activity event and broadcast to network
    this.fastify.post('/activity/record', async (request: any, reply: any) => {
      const ledger = this.node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      const record = request.body;
      if (!record?.id || !record?.agentId || !record?.action || !record?.summary || !record?.signature) {
        return reply.code(400).send({ error: 'Missing required fields: id, agentId, action, summary, signature' });
      }

      // Validate action against allowed types
      const validActions = [
        'proposal_created', 'proposal_commented', 'proposal_voted', 'proposal_decided',
        'task_accepted', 'task_in_progress', 'task_completed', 'task_failed',
        'code_written', 'code_reviewed', 'code_deployed',
        'analysis_started', 'analysis_completed', 'search_handled',
        'agent_online', 'agent_offline', 'agent_wake_cycle', 'health_check',
        'strategy_update', 'roadmap_revision', 'weekly_report_published',
      ];
      if (!validActions.includes(record.action)) {
        return reply.code(400).send({ error: `Invalid action. Must be one of: ${validActions.join(', ')}` });
      }

      // Sanitize text fields to prevent stored XSS
      const sanitize = (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      record.summary = sanitize(record.summary);
      if (record.details) record.details = sanitize(record.details);

      ledger.recordActivity(record);

      // Broadcast to all peers via GossipSub
      const sync = this.node.getSync();
      if (sync) {
        await sync.broadcastActivity(record);
      }

      // Push to SSE clients for real-time gateway updates
      this.pushEvent('activity', {
        id: record.id,
        agentId: record.agentId,
        action: record.action,
        summary: record.summary,
        timestamp: record.timestamp,
      });

      return { success: true, broadcast: true };
    });

    // GET /activity — unified network activity feed (transactions + governance events)
    this.fastify.get('/activity', async (request: any) => {
      const ledger = this.node.getLedger();
      const gov = this.node.getGovernance();
      const identity = this.node.getIdentity();
      const parsedActivityLimit = parseInt(request.query?.limit);
      const limit = Math.min((!parsedActivityLimit || parsedActivityLimit <= 0) ? 30 : parsedActivityLimit, 100);

      const events: Array<{ type: string; timestamp: number; data: any }> = [];

      // Recent transactions (last 24 hours or fallback to all)
      if (ledger) {
        const since = Date.now() - 24 * 60 * 60 * 1000;
        const txs = ledger.getTransactionsSince(since, limit);
        for (const tx of txs) {
          events.push({
            type: tx.type === 'emission' ? 'emission' : 'transfer',
            timestamp: tx.timestamp,
            data: {
              id: tx.id,
              from: tx.from,
              to: tx.to,
              amount: tx.amount,
              fee: tx.fee,
              relay: tx.relay,
            },
          });
        }
      }

      // Governance proposals
      if (gov) {
        const proposals = gov.getProposals();
        for (const p of proposals) {
          events.push({
            type: 'proposal',
            timestamp: p.createdAt,
            data: {
              id: p.id,
              title: p.title,
              proposedBy: p.proposedBy,
              status: p.status,
            },
          });

          // Include votes for each proposal
          const votes = gov.getVotes(p.id);
          for (const v of votes) {
            events.push({
              type: 'vote',
              timestamp: v.createdAt,
              data: {
                proposalId: p.id,
                proposalTitle: p.title,
                voter: v.voter,
                choice: v.choice,
              },
            });
          }
        }
      }

      // Sort by timestamp descending and limit
      events.sort((a, b) => b.timestamp - a.timestamp);
      const trimmed = events.slice(0, limit);

      return {
        events: trimmed,
        nodeId: identity?.peerId || '',
      };
    });

    // GET /events — Server-Sent Events stream for real-time updates
    this.fastify.get('/events', (request: any, reply: any) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Send initial snapshot immediately
      const snapshot = this.getSnapshot();
      reply.raw.write(`event: update\ndata: ${JSON.stringify(snapshot)}\n\n`);

      // Send heartbeat every 15s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          cleanup();
        }
      }, 15000);

      this.sseClients.add(reply);

      const cleanup = () => {
        clearInterval(heartbeat);
        this.sseClients.delete(reply);
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    });

    // ── Network Onboarding Routes ──

    // GET /bootstrap — return multiaddrs for bootstrapping new nodes
    this.fastify.get('/bootstrap', async (request: any, reply: any) => {
      const network = this.node.getNetwork();
      const identity = this.node.getIdentity();
      if (!network || !identity) {
        return reply.code(503).send({ error: 'Node not ready' });
      }
      const addrs = network.getListenAddresses();
      // Filter out localhost/loopback — only return routable addresses
      const routable = addrs.filter((a: string) => !a.includes('/127.0.0.1/') && !a.includes('/::1/'));
      return { peerId: identity.peerId, addrs: routable.length > 0 ? routable : addrs };
    });

    // GET /onboard — onboarding info for new node operators
    this.fastify.get('/onboard', async (request: any, reply: any) => {
      const network = this.node.getNetwork();
      const identity = this.node.getIdentity();
      if (!network || !identity) {
        return reply.code(503).send({ error: 'Node not ready' });
      }
      const addrs = network.getListenAddresses();
      const routable = addrs.filter((a: string) => !a.includes('/127.0.0.1/') && !a.includes('/::1/'));
      const bootstrapAddrs = routable.length > 0 ? routable : addrs;
      return {
        bootstrapAddrs,
        instructions: [
          '1. Install Node.js 18+ (https://nodejs.org)',
          '2. Clone the repo: git clone https://github.com/pando-lux/pando.git',
          '3. Install dependencies: npm install',
          '4. Build: npm run build',
          `5. Start your node: node packages/node/dist/cli.js --port 4001 --bootstrap ${bootstrapAddrs[0] || '<multiaddr>'}`,
          '6. (Optional) Start the gateway: cd packages/gateway && npx next dev --port 3222',
        ].join('\n'),
        version: '0.1.0',
        peerId: identity.peerId,
        peerCount: network.getPeerCount(),
      };
    });

    // GET /discovery — how each peer was discovered (mDNS, bootstrap, DHT, manual)
    this.fastify.get('/discovery', async () => {
      const network = this.node.getNetwork();
      const identity = this.node.getIdentity();
      if (!network || !identity) {
        return { peers: [] };
      }

      const connectedPeers = network.getPeers();
      const sources = network.getDiscoverySources();

      return {
        self: identity.peerId,
        peers: connectedPeers.map(p => ({
          peerId: p.peerId,
          discoveredVia: sources.get(p.peerId) || 'unknown',
          connectedAt: p.connectedAt,
          lastSeen: p.lastSeen,
        })),
        // Include historical discovery data for disconnected peers
        allDiscovered: Array.from(sources.entries()).map(([peerId, source]) => ({
          peerId,
          discoveredVia: source,
          currentlyConnected: connectedPeers.some(p => p.peerId === peerId),
        })),
      };
    });

    // POST /search — AI search
    this.fastify.post('/search', async (request: any, reply: any) => {
      const { query, identity } = request.body || {};
      if (!query || typeof query !== 'string') {
        return reply.code(400).send({ error: 'Query is required' });
      }

      try {
        const result = await this.node.search(query, identity);
        return result;
      } catch (err: any) {
        return reply.code(500).send({
          answer: 'Search failed: ' + err.message,
          sources: [],
          confidence: 'none',
          respondedBy: 'node-error',
        });
      }
    });

    // ── Snapshot Routes ──

    // GET /snapshot — get latest snapshot info (or full snapshot data)
    this.fastify.get('/snapshot', async (request: any, reply: any) => {
      const ledger = this.node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      const full = (request.query as any)?.full === 'true';
      if (full) {
        const path = ledger.getLatestSnapshotPath(this.node.getDataDir() || undefined);
        if (!path) return reply.code(404).send({ error: 'No snapshots available' });
        try {
          const { readFileSync } = await import('node:fs');
          const data = JSON.parse(readFileSync(path, 'utf-8'));
          return data;
        } catch (err: any) {
          return reply.code(500).send({ error: `Failed to read snapshot: ${err.message}` });
        }
      }

      const info = ledger.getSnapshotInfo(this.node.getDataDir() || undefined);
      if (!info) return reply.code(404).send({ error: 'No snapshots available' });
      return info;
    });

    // POST /snapshot/create — trigger a new snapshot
    this.fastify.post('/snapshot/create', async (request: any, reply: any) => {
      const ledger = this.node.getLedger();
      if (!ledger) return reply.code(503).send({ error: 'Ledger not ready' });

      try {
        const info = ledger.createSnapshot(this.node.getDataDir() || undefined);
        return { success: true, snapshot: info };
      } catch (err: any) {
        return reply.code(500).send({ error: `Snapshot creation failed: ${err.message}` });
      }
    });

    // ── Scheduler Routes ──────────────────────────────────────────────────────
    // Phase 1 Scheduler — task-driven orchestrator that creates workspaces,
    // generates agent profiles, and spawns agents automatically.

    // GET /scheduler/status — Scheduler status: running, active tasks, config
    this.fastify.get('/scheduler/status', async (request: any, reply: any) => {
      const scheduler = this.node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      return {
        ...scheduler.getStatus(),
        upgradeInProgress: this.node.isUpgradeInProgress(),
        restartPending: this.node.isRestartPending(),
      };
    });

    // POST /scheduler/start — Start the Scheduler
    this.fastify.post('/scheduler/start', async (request: any, reply: any) => {
      const existing = this.node.getScheduler();
      if (existing) {
        return { message: 'Scheduler already running', ...existing.getStatus() };
      }
      const scheduler = this.node.startScheduler();
      return { success: true, ...scheduler.getStatus() };
    });

    // POST /scheduler/stop — Stop the Scheduler
    this.fastify.post('/scheduler/stop', async () => {
      const scheduler = this.node.getScheduler();
      if (!scheduler) return { message: 'Scheduler not running' };
      this.node.stopScheduler();
      return { success: true, message: 'Scheduler stopped' };
    });

    // POST /scheduler/submit — Submit a task for Scheduler processing
    this.fastify.post('/scheduler/submit', async (request: any, reply: any) => {
      const scheduler = this.node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const { title, description, priority } = request.body || {};
      if (!description || typeof description !== 'string') {
        return reply.code(400).send({ error: 'description is required' });
      }
      const taskTitle = (title && typeof title === 'string')
        ? title.slice(0, 200)
        : description.slice(0, 50);
      const taskPriority = ['critical', 'high', 'medium', 'low'].includes(priority)
        ? priority
        : 'medium';

      // Use the node's active TaskQueue (which has network wired for GossipSub broadcast)
      const tq = this.node.getActiveTaskQueue();
      if (!tq) {
        return reply.code(503).send({ error: 'TaskQueue not available' });
      }
      const identity = this.node.getIdentity();
      const task = tq.createTask({
        title: taskTitle,
        description,
        priority: taskPriority,
        createdBy: 'scheduler-api',
        originNode: identity?.peerId,
      });

      // Phase 18.3: Seed first thread message with user's description
      tq.addMessage(task.id, {
        from: identity?.peerId || 'user',
        role: 'user',
        content: description,
      });

      return { success: true, taskId: task.id, task };
    });

    // GET /scheduler/tasks — List tasks with Scheduler lifecycle info
    this.fastify.get('/scheduler/tasks', async (request: any, reply: any) => {
      const scheduler = this.node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const status = scheduler.getStatus();
      // Get all tasks from the TaskQueue
      const { TaskQueue } = await import('./task-queue.js');
      const dataDir = this.node.getDataDir() || undefined;
      const tq = new TaskQueue(dataDir);
      const allTasks = tq.getTasks({});

      // Annotate with Scheduler lifecycle info from active tasks
      const activeMap = new Map(status.activeTasks.map(at => [at.taskId, at]));
      const annotated = allTasks.map((task: any) => {
        const active = activeMap.get(task.id);
        return {
          ...task,
          schedulerLifecycle: active ? active.lifecycle : (task.status === 'done' ? 'done' : (task.status === 'rejected' ? 'failed' : 'dormant')),
          schedulerProfile: active ? (active as any).profile?.profileId : undefined,
          schedulerWorkspaceDir: active ? (active as any).workspace?.dir : undefined,
          failureReason: (task.status === 'rejected' && task.result?.note) ? task.result.note : undefined,
          timeline: task.timeline ? task.timeline.slice(-3) : [],
        };
      });
      return { tasks: annotated };
    });

    // GET /scheduler/tasks/:id — Get specific task details + workspace info
    this.fastify.get('/scheduler/tasks/:id', async (request: any, reply: any) => {
      const scheduler = this.node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const taskId = request.params.id;
      const { TaskQueue } = await import('./task-queue.js');
      const dataDir = this.node.getDataDir() || undefined;
      const tq = new TaskQueue(dataDir);
      const task = tq.getTask(taskId);
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      const status = scheduler.getStatus();
      const active = status.activeTasks.find(at => at.taskId === taskId);

      const workspace = null;
      const output = task.result?.note || null;

      // Extract failure reason from task result note (for rejected/failed tasks)
      const failureReason = (task.status === 'rejected' && task.result?.note) ? task.result.note : null;

      return {
        task,
        scheduler: {
          lifecycle: active ? active.lifecycle : (task.status === 'done' ? 'done' : (task.status === 'rejected' ? 'failed' : 'dormant')),
          profile: (active as any)?.profile || null,
          workspace: workspace,
        },
        output: output,
        failureReason,
        timeline: task.timeline || [],
      };
    });

    // GET /scheduler/tasks/:id/output — Get output from completed task
    this.fastify.get('/scheduler/tasks/:id/output', async (request: any, reply: any) => {
      const scheduler = this.node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const taskId = request.params.id;
      const { TaskQueue } = await import('./task-queue.js');
      const tq = new TaskQueue(this.node.getDataDir() || undefined);
      const task = tq.getTask(taskId);
      const output = task?.result?.note || null;
      if (output === null) {
        return reply.code(404).send({ error: 'No output available for this task' });
      }
      return { taskId, output };
    });

    // GET /scheduler/tasks/:id/logs — Get persisted agent execution logs
    this.fastify.get('/scheduler/tasks/:id/logs', async (request: any, reply: any) => {
      const taskId = request.params.id;
      const scheduler = this.node.getScheduler();

      // Try scheduler's getTaskLogs first (if available)
      if (scheduler) {
        const logs = scheduler.getTaskLogs(taskId);
        if (logs.length > 0) {
          return { taskId, logs };
        }
      }

      // Fallback: read log files directly from workspace directory
      try {
        const { readdirSync: readDir, readFileSync: readFile, existsSync: fsExists } = await import('node:fs');
        const { join: pJoin } = await import('node:path');
        const wsDir = pJoin(this.node.getDataDir() || join(homedir(), '.pando'), 'workspaces', taskId);
        if (!fsExists(wsDir)) {
          return reply.code(404).send({ error: 'Workspace not found for this task' });
        }
        const entries = readDir(wsDir);
        const logFiles = entries.filter((f: string) => f.startsWith('agent-stream') && f.endsWith('.log'));
        if (logFiles.length === 0) {
          return reply.code(404).send({ error: 'No execution logs found for this task' });
        }
        const logs = logFiles.map((file: string) => {
          const content = readFile(pJoin(wsDir, file), 'utf-8');
          const lines = content.split('\n').filter((l: string) => l.trim());
          return { file, lines };
        });
        return { taskId, logs };
      } catch {
        return reply.code(404).send({ error: 'No execution logs found for this task' });
      }
    });

    // GET /scheduler/tasks/:id/files — List workspace files (recursive)
    this.fastify.get('/scheduler/tasks/:id/files', async (request: any, reply: any) => {
      const taskId = request.params.id;
      const { readdirSync, statSync } = await import('node:fs');
      const { join: pathJoin, relative } = await import('node:path');
      const wsDir = pathJoin(this.node.getDataDir() || join(homedir(), '.pando'), 'workspaces', taskId);
      try {
        statSync(wsDir);
      } catch {
        return reply.code(404).send({ error: 'Workspace not found' });
      }
      const files: { path: string; size: number; isDir: boolean }[] = [];
      const walk = (dir: string) => {
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = pathJoin(dir, entry.name);
            const rel = relative(wsDir, full).replace(/\\/g, '/');
            if (entry.isDirectory()) {
              files.push({ path: rel, size: 0, isDir: true });
              walk(full);
            } else {
              try { files.push({ path: rel, size: statSync(full).size, isDir: false }); } catch { }
            }
          }
        } catch { }
      };
      walk(wsDir);
      return { taskId, workspaceDir: wsDir, files };
    });

    // GET /scheduler/tasks/:id/files/* — Read a specific workspace file
    this.fastify.get('/scheduler/tasks/:id/files/*', async (request: any, reply: any) => {
      const taskId = request.params.id;
      const filePath = (request.params as any)['*'];
      if (!filePath || filePath.includes('..')) {
        return reply.code(400).send({ error: 'Invalid file path' });
      }
      const { readFileSync, statSync: statSync2 } = await import('node:fs');
      const { join: pathJoin } = await import('node:path');
      const wsDir = pathJoin(this.node.getDataDir() || join(homedir(), '.pando'), 'workspaces', taskId);
      const fullPath = pathJoin(wsDir, filePath);
      // Security: ensure file is within workspace
      if (!fullPath.replace(/\\/g, '/').startsWith(wsDir.replace(/\\/g, '/'))) {
        return reply.code(403).send({ error: 'Access denied' });
      }
      try {
        const stat = statSync2(fullPath);
        if (stat.isDirectory()) {
          return reply.code(400).send({ error: 'Path is a directory' });
        }
        if (stat.size > 1024 * 1024) {
          return reply.code(413).send({ error: 'File too large (>1MB)' });
        }
        const content = readFileSync(fullPath, 'utf-8');
        return { taskId, file: filePath, size: stat.size, content };
      } catch {
        return reply.code(404).send({ error: 'File not found' });
      }
    });

    // GET /scheduler/costs — Aggregate cost stats across all tasks
    this.fastify.get('/scheduler/costs', async (request: any, reply: any) => {
      const scheduler = this.node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const taskQueue = scheduler.getTaskQueue();
      return taskQueue.getCostStats();
    });

    // GET /scheduler/remote/:peerId/tasks — Query a remote peer's task list via P2P
    this.fastify.get('/scheduler/remote/:peerId/tasks', async (request: any, reply: any) => {
      const rr = this.node.getRequestReply();
      if (!rr) return reply.code(503).send({ error: 'Request-reply not available' });
      const { peerId } = request.params;
      const limit = parseInt(request.query?.limit) || 50;
      try {
        const result = await rr.request(peerId, 'task_list', { limit }, 10000);
        if (!result.success) return reply.code(502).send({ error: result.error || 'Remote peer returned error' });
        return result.payload;
      } catch (err: any) {
        return reply.code(504).send({ error: `Remote query failed: ${err.message}` });
      }
    });

    // GET /scheduler/remote/:peerId/tasks/:taskId — Query a specific task from a remote peer
    this.fastify.get('/scheduler/remote/:peerId/tasks/:taskId', async (request: any, reply: any) => {
      const rr = this.node.getRequestReply();
      if (!rr) return reply.code(503).send({ error: 'Request-reply not available' });
      const { peerId, taskId } = request.params;
      try {
        const result = await rr.request(peerId, 'task_detail', { taskId }, 10000);
        if (!result.success) return reply.code(502).send({ error: result.error || 'Remote peer returned error' });
        if (result.payload?.error) return reply.code(404).send({ error: result.payload.error });
        return result.payload;
      } catch (err: any) {
        return reply.code(504).send({ error: `Remote query failed: ${err.message}` });
      }
    });

    // GET /scheduler/network/tasks — Aggregate tasks from all connected peers + local
    this.fastify.get('/scheduler/network/tasks', async (request: any, reply: any) => {
      const rr = this.node.getRequestReply();
      const scheduler = this.node.getScheduler();
      const network = this.node.getNetwork();
      const identity = this.node.getIdentity();
      if (!network || !identity) return reply.code(503).send({ error: 'Node not ready' });
      const limit = parseInt(request.query?.limit) || 50;

      // Local tasks
      const localTasks = scheduler
        ? scheduler.getTaskQueue().getTasks().slice(0, limit).map((t: any) => ({
            id: t.id, title: t.title, status: t.status, priority: t.priority,
            createdAt: t.createdAt, cost: t.cost, executedByNode: t.executedByNode,
            sourceNode: identity.peerId, isLocal: true,
          }))
        : [];

      // Remote tasks from all connected peers
      const peers = network.getPeers();
      const remoteResults = await Promise.allSettled(
        peers.map(async (p: any) => {
          if (!rr) return [];
          try {
            const result = await rr.request(p.peerId, 'task_list', { limit }, 8000);
            if (result.success && Array.isArray(result.payload)) {
              return result.payload.map((t: any) => ({
                ...t, sourceNode: p.peerId, isLocal: false,
              }));
            }
            return [];
          } catch { return []; }
        })
      );

      const remoteTasks = remoteResults
        .filter((r): r is PromiseFulfilledResult<any[]> => r.status === 'fulfilled')
        .flatMap(r => r.value);

      // Combine and sort by creation date (newest first)
      const allTasks = [...localTasks, ...remoteTasks]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit);

      return {
        tasks: allTasks,
        sources: {
          local: identity.peerId,
          remoteCount: peers.length,
          respondedCount: remoteResults.filter(r => r.status === 'fulfilled' && r.value.length > 0).length,
        },
      };
    });

    // POST /scheduler/config — Update Scheduler config
    this.fastify.post('/scheduler/config', async (request: any, reply: any) => {
      const scheduler = this.node.getScheduler();
      if (!scheduler) {
        return reply.code(503).send({ error: 'Scheduler not enabled. Start node with --scheduler flag.' });
      }
      const body = request.body || {};
      if (!body.pollIntervalMs && !body.maxConcurrentTasks && !body.maxTaskDepth) {
        return reply.code(400).send({ error: 'Provide at least one of: pollIntervalMs, maxConcurrentTasks, maxTaskDepth' });
      }
      scheduler.updateConfig(body);
      return { success: true, config: scheduler.getStatus().config };
    });

    // GET /scheduler/tasks/:id/stream — SSE stream of live task output
    // Works for both local tasks (via Scheduler emitters) and remote tasks (via GossipSub timeline events)
    this.fastify.get('/scheduler/tasks/:id/stream', (request: any, reply: any) => {
      const scheduler = this.node.getScheduler();
      const taskId = request.params.id;

      // Check if the task exists locally (could be a remote task synced via GossipSub)
      const taskQueue = this.node.getActiveTaskQueue();
      const task = taskQueue?.getTask(taskId);
      if (!scheduler && !task) {
        reply.code(503).send({ error: 'Scheduler not enabled and task not found.' });
        return;
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Send initial status
      if (scheduler) {
        const status = scheduler.getStatus();
        const active = status.activeTasks.find((at: any) => at.taskId === taskId);
        reply.raw.write(`data: ${JSON.stringify({
          type: 'status',
          taskId,
          lifecycle: active ? active.lifecycle : (task ? task.status : 'unknown'),
          timestamp: new Date().toISOString(),
        })}\n\n`);
      } else {
        reply.raw.write(`data: ${JSON.stringify({
          type: 'status',
          taskId,
          lifecycle: task ? task.status : 'unknown',
          remote: true,
          timestamp: new Date().toISOString(),
        })}\n\n`);
      }

      // Heartbeat every 5s
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(': heartbeat\n\n');
        } catch {
          cleanup();
        }
      }, 5000);

      const onOutput = (data: any) => {
        try {
          reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
          cleanup();
        }
      };

      // Subscribe to scheduler's task output emitter (if scheduler is running)
      const emitter = scheduler?.getTaskEmitter(taskId) || null;
      if (emitter) {
        emitter.on('output', onOutput);
      }

      // Phase 8.3: Also subscribe to remote task emitter (for cross-node timeline events)
      const remoteEmitter = this.node.getOrCreateRemoteTaskEmitter(taskId);
      remoteEmitter.on('output', onOutput);

      // Also listen for late-attached scheduler emitters (task might not be running yet)
      let polledEmitter = emitter;
      const pollForEmitter = !emitter && scheduler ? setInterval(() => {
        const em = scheduler.getTaskEmitter(taskId);
        if (em && em !== polledEmitter) {
          polledEmitter = em;
          em.on('output', onOutput);
        }
      }, 1000) : null;

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        if (pollForEmitter) clearInterval(pollForEmitter);
        if (emitter) emitter.off('output', onOutput);
        if (polledEmitter && polledEmitter !== emitter) polledEmitter.off('output', onOutput);
        remoteEmitter.off('output', onOutput);
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
    });

    // ── Health Monitor Routes (Phase 9) ────────────────────────────────────────

    // GET /monitor/status — Current health metrics + active alerts
    this.fastify.get('/monitor/status', async (request: any, reply: any) => {
      const monitor = this.node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled. Start node with --monitor or --scheduler flag.' });
      }
      return monitor.getCurrentMetrics();
    });

    // GET /monitor/metrics — Rolling metrics history (last 100 data points)
    this.fastify.get('/monitor/metrics', async (request: any, reply: any) => {
      const monitor = this.node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      return { metrics: monitor.getMetricsHistory() };
    });

    // GET /monitor/alerts — All alerts (active + resolved, newest first)
    this.fastify.get('/monitor/alerts', async (request: any, reply: any) => {
      const monitor = this.node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      return { alerts: monitor.getAlerts() };
    });

    // POST /monitor/alerts/:id/ack — Acknowledge an alert
    this.fastify.post('/monitor/alerts/:id/ack', async (request: any, reply: any) => {
      const monitor = this.node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      const alertId = request.params.id;
      const alert = monitor.acknowledgeAlert(alertId);
      if (!alert) {
        return reply.code(404).send({ error: 'Alert not found' });
      }
      return { success: true, alert };
    });

    // GET /monitor/config — Current monitor configuration
    this.fastify.get('/monitor/config', async (request: any, reply: any) => {
      const monitor = this.node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      return { config: monitor.getConfig(), running: monitor.isRunning() };
    });

    // POST /monitor/config — Update monitor configuration
    this.fastify.post('/monitor/config', async (request: any, reply: any) => {
      const monitor = this.node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      const body = request.body || {};
      const validKeys = ['checkIntervalMs', 'stuckPeerThresholdMs', 'failureRateThreshold', 'failureRateWindowMs', 'maxConsecutiveFailures', 'memoryUsageThreshold', 'eventLoopLagThresholdMs', 'ledgerSyncLagThresholdMs', 'spawnFailureRateThreshold', 'spawnFailureWindowMs'];
      const updates: Record<string, any> = {};
      for (const key of validKeys) {
        if (body[key] !== undefined) {
          updates[key] = body[key];
        }
      }
      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: `Provide at least one of: ${validKeys.join(', ')}` });
      }
      const config = monitor.updateConfig(updates);
      return { success: true, config };
    });

    // GET /monitor/audit — Recovery action audit trail (Phase 9.2)
    this.fastify.get('/monitor/audit', async (request: any, reply: any) => {
      const monitor = this.node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      return { audit: monitor.getAuditLog() };
    });

    // GET /monitor/recovery — Recovery action configuration (Phase 9.2)
    this.fastify.get('/monitor/recovery', async (request: any, reply: any) => {
      const monitor = this.node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      return { actions: monitor.getRecoveryActions() };
    });

    // POST /monitor/recovery — Update recovery action config (Phase 9.2)
    this.fastify.post('/monitor/recovery', async (request: any, reply: any) => {
      const monitor = this.node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      const body = request.body;
      if (!body || !Array.isArray(body.actions)) {
        return reply.code(400).send({ error: 'Provide { actions: [{ trigger, enabled?, cooldownMs?, action? }] }' });
      }
      const actions = monitor.updateRecoveryActions(body.actions);
      return { success: true, actions };
    });

    // GET /monitor/system — System-level metrics (memory, CPU, event loop lag)
    this.fastify.get('/monitor/system', async (request: any, reply: any) => {
      const monitor = this.node.getMonitor();
      if (!monitor) {
        return reply.code(503).send({ error: 'Health monitor not enabled.' });
      }
      const metrics = monitor.getCurrentMetrics();
      return {
        memoryUsage: metrics.memoryUsage ?? null,
        eventLoopLagMs: metrics.eventLoopLagMs ?? 0,
        ledgerSyncLagMs: metrics.ledgerSyncLagMs ?? null,
        agentSpawnFailureRate: metrics.agentSpawnFailureRate ?? 0,
        uptimeSeconds: metrics.uptimeSeconds,
        nodeHealth: metrics.nodeHealth,
      };
    });

    // ── Guardrails Routes (Phase 9.3) ───────────────────────────────────────────

    // GET /guardrails/status — Current config + rate limit usage
    this.fastify.get('/guardrails/status', async (request: any, reply: any) => {
      const guardrails = this.node.getGuardrails();
      if (!guardrails) {
        return reply.code(503).send({ error: 'Guardrails not initialized.' });
      }
      return guardrails.getStatus();
    });

    // POST /guardrails/config — Update guardrail configuration
    this.fastify.post('/guardrails/config', async (request: any, reply: any) => {
      const guardrails = this.node.getGuardrails();
      if (!guardrails) {
        return reply.code(503).send({ error: 'Guardrails not initialized.' });
      }
      const body = request.body || {};
      const validKeys = [
        'protectedPaths', 'maxSelfChangesPerHour', 'maxSelfChangesPerDay',
        'rollbackOnBuildFailure', 'rollbackOnTestFailure',
        'requireApprovalForCore', 'approvalTimeout',
      ];
      const updates: Record<string, any> = {};
      for (const key of validKeys) {
        if (body[key] !== undefined) {
          updates[key] = body[key];
        }
      }
      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: `Provide at least one of: ${validKeys.join(', ')}` });
      }
      const config = guardrails.updateConfig(updates);
      return { success: true, config };
    });

    // GET /guardrails/pending — Changes waiting for approval
    this.fastify.get('/guardrails/pending', async (request: any, reply: any) => {
      const guardrails = this.node.getGuardrails();
      if (!guardrails) {
        return reply.code(503).send({ error: 'Guardrails not initialized.' });
      }
      return { pending: guardrails.getPending() };
    });

    // POST /guardrails/approve/:id — Approve a pending change
    this.fastify.post('/guardrails/approve/:id', async (request: any, reply: any) => {
      const guardrails = this.node.getGuardrails();
      if (!guardrails) {
        return reply.code(503).send({ error: 'Guardrails not initialized.' });
      }
      const changeId = request.params.id;
      const body = request.body || {};
      const change = guardrails.approveChange(changeId, body.reviewedBy);
      if (!change) {
        return reply.code(404).send({ error: 'Pending change not found or already reviewed.' });
      }
      return { success: true, change };
    });

    // POST /guardrails/reject/:id — Reject a pending change
    this.fastify.post('/guardrails/reject/:id', async (request: any, reply: any) => {
      const guardrails = this.node.getGuardrails();
      if (!guardrails) {
        return reply.code(503).send({ error: 'Guardrails not initialized.' });
      }
      const changeId = request.params.id;
      const body = request.body || {};
      const change = guardrails.rejectChange(changeId, body.reason, body.reviewedBy);
      if (!change) {
        return reply.code(404).send({ error: 'Pending change not found or already reviewed.' });
      }
      return { success: true, change };
    });

    // ── Request/Reply Routes (Phase 10.1) ───────────────────────────────────────

    // GET /request-reply/stats — Request/reply statistics
    this.fastify.get('/request-reply/stats', async (request: any, reply: any) => {
      const rr = this.node.getRequestReply();
      if (!rr) {
        return reply.code(503).send({ error: 'Request/reply manager not initialized.' });
      }
      return rr.getStats();
    });

    // GET /request-reply/handlers — List registered handler types
    this.fastify.get('/request-reply/handlers', async (request: any, reply: any) => {
      const rr = this.node.getRequestReply();
      if (!rr) {
        return reply.code(503).send({ error: 'Request/reply manager not initialized.' });
      }
      return { handlers: rr.getHandlerTypes() };
    });

    // POST /request-reply/send — Send a request and return the reply
    this.fastify.post('/request-reply/send', async (request: any, reply: any) => {
      const rr = this.node.getRequestReply();
      if (!rr) {
        return reply.code(503).send({ error: 'Request/reply manager not initialized.' });
      }
      const { to, type, payload, timeout } = request.body || {};
      if (!to || typeof to !== 'string') {
        return reply.code(400).send({ error: '"to" (peer ID) is required' });
      }
      if (!type || typeof type !== 'string') {
        return reply.code(400).send({ error: '"type" (request type) is required' });
      }
      const timeoutMs = typeof timeout === 'number' && timeout > 0
        ? Math.min(timeout, 120_000)
        : undefined;

      try {
        const result = await rr.request(to, type, payload ?? {}, timeoutMs);
        return { success: true, reply: result };
      } catch (err: any) {
        const msg = err.message || 'Request failed';
        if (msg.includes('Rate limited')) {
          return reply.code(429).send({ error: msg });
        }
        if (msg.includes('timed out')) {
          return reply.code(504).send({ error: msg });
        }
        return reply.code(500).send({ error: msg });
      }
    });

    // ── Reputation Routes (Phase 10.3) ────────────────────────────────────────

    // GET /reputation — Local node's reputation
    this.fastify.get('/reputation', async (request: any, reply: any) => {
      const rm = this.node.getReputationManager();
      if (!rm) {
        return reply.code(503).send({ error: 'Reputation manager not initialized.' });
      }
      return rm.getLocalReputation();
    });

    // GET /reputation/peers — All known reputations ranked (highest first)
    this.fastify.get('/reputation/peers', async (request: any, reply: any) => {
      const rm = this.node.getReputationManager();
      if (!rm) {
        return reply.code(503).send({ error: 'Reputation manager not initialized.' });
      }
      return { reputations: rm.getRankedNodes() };
    });

    // GET /reputation/:nodeId — Specific node's reputation
    this.fastify.get('/reputation/:nodeId', async (request: any, reply: any) => {
      const rm = this.node.getReputationManager();
      if (!rm) {
        return reply.code(503).send({ error: 'Reputation manager not initialized.' });
      }
      const nodeId = request.params.nodeId;
      const record = rm.getReputation(nodeId);
      if (!record) {
        return reply.code(404).send({ error: 'No reputation record found for this node.' });
      }
      return record;
    });

    // ── Upgrade Route ─────────────────────────────────────────────────────────
    // POST /upgrade — Pull latest code, build, and schedule graceful restart.
    // Idempotent: if an upgrade is already in progress, returns current status.
    this.fastify.post('/upgrade', async (request: any, reply: any) => {
      // Idempotent — return status if already in progress or pending restart
      if (this.node.isUpgradeInProgress()) {
        return { status: 'in_progress', message: 'Upgrade already in progress.' };
      }
      if (this.node.isRestartPending()) {
        return { status: 'restart_pending', message: 'Build succeeded. Waiting for active tasks to finish before restart.' };
      }

      this.node.setUpgradeInProgress(true);

      // Determine repo directory — launchers cd into the repo root before starting
      const repoDir = process.cwd();

      try {
        // Step 0: ensure git safe.directory (compute instances run as 'pando' user, repo cloned by root)
        try {
          execSync(`git config --global --add safe.directory ${repoDir}`, {
            cwd: repoDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe', windowsHide: true,
          });
        } catch {}

        // Step 1: fetch + reset to origin/master (handles orphan-branch force pushes)
        console.log('[upgrade] Fetching latest code...');
        let pullOutput: string;
        try {
          execSync('git fetch origin master', {
            cwd: repoDir, encoding: 'utf-8', timeout: 60_000,
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          });
          // Check if we're already at the same commit
          const localSha = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
          const remoteSha = execSync('git rev-parse origin/master', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
          if (localSha === remoteSha) {
            pullOutput = 'Already up to date.';
          } else {
            execSync('git reset --hard origin/master', {
              cwd: repoDir, encoding: 'utf-8', timeout: 30_000,
              stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            });
            pullOutput = `Updated ${localSha.slice(0, 8)} -> ${remoteSha.slice(0, 8)}`;
          }
        } catch (err: any) {
          this.node.setUpgradeInProgress(false);
          const msg = err.stderr?.toString()?.slice(0, 500) || err.message;
          console.error(`[upgrade] Git fetch/reset failed: ${msg}`);
          return reply.code(500).send({ status: 'error', step: 'git_pull', error: msg });
        }

        // Check if already up to date
        if (pullOutput.includes('Already up to date') || pullOutput.includes('Already up-to-date')) {
          this.node.setUpgradeInProgress(false);
          console.log('[upgrade] Already up to date. No build needed.');
          return { status: 'up_to_date', message: 'Already up to date. No changes to build.' };
        }

        console.log(`[upgrade] Pull result: ${pullOutput.split('\n')[0]}`);

        // Step 2: npm run build
        console.log('[upgrade] Building...');
        try {
          execSync('npm run build', {
            cwd: repoDir,
            encoding: 'utf-8',
            timeout: 180_000, // 3 minutes
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (err: any) {
          this.node.setUpgradeInProgress(false);
          const stderr = err.stderr?.toString()?.slice(-500) || err.message;
          console.error(`[upgrade] Build FAILED: ${stderr}`);
          return reply.code(500).send({ status: 'error', step: 'build', error: stderr });
        }

        console.log('[upgrade] Build passed.');
        this.node.setUpgradeInProgress(false);

        // Step 3: Schedule graceful restart
        console.log('[upgrade] Scheduling graceful restart...');
        this.node.requestGracefulRestart();

        // Push SSE event so gateway knows
        this.pushEvent('upgrade', {
          status: 'restart_pending',
          message: 'Upgrade successful. Restarting node...',
          timestamp: Date.now(),
        });

        return {
          status: 'restart_pending',
          message: 'Build succeeded. Node will restart after active tasks complete.',
          pullOutput: pullOutput.split('\n').slice(0, 5).join('\n'),
        };
      } catch (err: any) {
        this.node.setUpgradeInProgress(false);
        console.error(`[upgrade] Unexpected error: ${err.message}`);
        return reply.code(500).send({ status: 'error', step: 'unknown', error: err.message });
      }
    });

    // GET /upgrade/status — Phase 82: simple upgrade status
    this.fastify.get('/upgrade/status', async () => {
      const upgradeProtocol = this.node.getUpgradeProtocol();
      return {
        upgradeInProgress: this.node.isUpgradeInProgress(),
        restartPending: this.node.isRestartPending(),
        ...(upgradeProtocol ? upgradeProtocol.getUpgradeStatus() : {}),
      };
    });

    // POST /upgrade/propose — submit upgrade proposal (description only, no diff)
    this.fastify.post('/upgrade/propose', async (request: any, reply: any) => {
      const upgradeProtocol = this.node.getUpgradeProtocol();
      if (!upgradeProtocol) {
        return reply.code(503).send({ error: 'Upgrade protocol not ready' });
      }
      const { description } = request.body || {};
      if (!description) {
        return reply.code(400).send({ error: 'Missing required field: description' });
      }
      try {
        const proposal = await upgradeProtocol.createUpgradeProposal(description);
        return { success: true, proposal };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // POST /upgrade/rollback — emergency rollback
    this.fastify.post('/upgrade/rollback', async (request: any, reply: any) => {
      const upgradeProtocol = this.node.getUpgradeProtocol();
      if (!upgradeProtocol) {
        return reply.code(503).send({ error: 'Upgrade protocol not ready' });
      }
      const { reason, targetVersion } = request.body || {};
      if (reason) {
        upgradeProtocol.proposeEmergencyRollback(reason);
      }
      const result = await upgradeProtocol.executeRollback(targetVersion);
      return result;
    });

    // GET /upgrade/history — upgrade history
    this.fastify.get('/upgrade/history', async (request: any, reply: any) => {
      const upgradeProtocol = this.node.getUpgradeProtocol();
      if (!upgradeProtocol) {
        return reply.code(503).send({ error: 'Upgrade protocol not ready' });
      }
      return { history: upgradeProtocol.getUpgradeHistory() };
    });

    // POST /upgrade/pin — pin current version
    this.fastify.post('/upgrade/pin', async (request: any, reply: any) => {
      const upgradeProtocol = this.node.getUpgradeProtocol();
      if (!upgradeProtocol) {
        return reply.code(503).send({ error: 'Upgrade protocol not ready' });
      }
      const { version } = request.body || {};
      if (!version) {
        return reply.code(400).send({ error: 'Missing required field: version' });
      }
      upgradeProtocol.pinVersion(version);
      return { success: true, pinnedVersion: version };
    });

    // POST /upgrade/unpin — unpin version
    this.fastify.post('/upgrade/unpin', async (request: any, reply: any) => {
      const upgradeProtocol = this.node.getUpgradeProtocol();
      if (!upgradeProtocol) {
        return reply.code(503).send({ error: 'Upgrade protocol not ready' });
      }
      upgradeProtocol.unpinVersion();
      return { success: true, pinnedVersion: null };
    });

    // ── Emission Witness API ────────────────────────────────

    // GET /emissions/pending — list pending emission proposals
    this.fastify.get('/emissions/pending', async () => {
      const ew = this.node.getEmissionWitness();
      if (!ew) {
        return { pending: [] };
      }
      return { pending: ew.getPending() };
    });

    // GET /emissions/history — list completed emission proposals
    this.fastify.get('/emissions/history', async (request: any) => {
      const ew = this.node.getEmissionWitness();
      if (!ew) {
        return { history: [] };
      }
      const limit = parseInt(request.query?.limit) || 50;
      return { history: ew.getHistory(limit) };
    });

    // GET /emissions/stats — emission system statistics
    this.fastify.get('/emissions/stats', async () => {
      const ew = this.node.getEmissionWitness();
      if (!ew) {
        return {
          totalProposals: 0, totalApproved: 0, totalRejected: 0,
          totalExpired: 0, pendingCount: 0, totalLuxEmitted: 0,
          proposalsThisHour: 0, rateLimitPerHour: 10,
          quorumRequired: 2, bootstrapFallback: true,
        };
      }
      return ew.getStats();
    });

    // ── Security Monitor API ──────────────────────────────────

    // GET /security/alerts — list security alerts (newest first)
    // Query params: ?limit=N, ?type=message_flood, ?severity=critical, ?active=true
    this.fastify.get('/security/alerts', async (request: any) => {
      const sm = this.node.getSecurityMonitor();
      if (!sm) {
        return { alerts: [] };
      }
      const limit = parseInt(request.query?.limit) || 100;
      const typeFilter = request.query?.type as string | undefined;
      const severityFilter = request.query?.severity as string | undefined;
      const activeFilter = request.query?.active as string | undefined;

      let alerts = sm.getAlerts(limit);

      if (typeFilter) {
        alerts = alerts.filter(a => a.type === typeFilter);
      }
      if (severityFilter) {
        alerts = alerts.filter(a => a.severity === severityFilter);
      }
      if (activeFilter === 'true') {
        alerts = alerts.filter(a => !a.resolved);
      } else if (activeFilter === 'false') {
        alerts = alerts.filter(a => a.resolved);
      }

      return { alerts };
    });

    // GET /security/stats — security system statistics
    this.fastify.get('/security/stats', async () => {
      const sm = this.node.getSecurityMonitor();
      if (!sm) {
        return {
          totalAlerts: 0, activeAlerts: 0, resolvedAlerts: 0,
          alertsByType: {}, quarantinedPeers: 0,
          detectorStatus: {}, lastCheckAt: null,
        };
      }
      return sm.getStats();
    });

    // GET /security/quarantine — list quarantined peers
    this.fastify.get('/security/quarantine', async () => {
      const sm = this.node.getSecurityMonitor();
      if (!sm) {
        return { quarantine: [] };
      }
      return { quarantine: sm.getQuarantine() };
    });

    // POST /security/quarantine/:peerId/release — release a peer from quarantine
    this.fastify.post('/security/quarantine/:peerId/release', async (request: any, reply: any) => {
      const sm = this.node.getSecurityMonitor();
      if (!sm) {
        return reply.code(503).send({ error: 'Security monitor not initialized.' });
      }
      const peerId = request.params.peerId;
      const entry = sm.releasePeer(peerId);
      if (!entry) {
        return reply.code(404).send({ error: 'Peer not found in quarantine or already released.' });
      }
      return { released: true, entry };
    });

    // GET /security/proofs — Resource proof scores for all peers (Phase 12.3)
    this.fastify.get('/security/proofs', async () => {
      const rpc = this.node.getResourceProofChallenger();
      if (!rpc) {
        return { scores: [] };
      }
      return { scores: rpc.getAllScores() };
    });

    // POST /security/challenge/:peerId — Trigger manual challenge (Phase 12.3)
    this.fastify.post('/security/challenge/:peerId', async (request: any, reply: any) => {
      const rpc = this.node.getResourceProofChallenger();
      if (!rpc) {
        return reply.code(503).send({ error: 'Resource proof challenger not initialized.' });
      }
      const peerId = request.params.peerId;
      const body = request.body || {};
      const challengeType = body.type || 'storage';

      try {
        let result;
        switch (challengeType) {
          case 'storage':
            result = await rpc.challengeStorage(peerId);
            break;
          case 'compute':
            result = await rpc.challengeCompute(peerId);
            break;
          case 'bandwidth':
            result = await rpc.challengeBandwidth(peerId);
            break;
          default:
            return reply.code(400).send({ error: `Invalid challenge type: ${challengeType}. Must be storage, compute, or bandwidth.` });
        }
        return { result };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message || 'Challenge failed' });
      }
    });

    // GET /security/safety-reviews — Content safety review history (Phase 12.5)
    this.fastify.get('/security/safety-reviews', async (request: any) => {
      const csr = this.node.getContentSafetyReviewer();
      if (!csr) {
        return { reviews: [] };
      }
      const contentId = request.query?.contentId as string | undefined;
      return { reviews: csr.getReviewHistory(contentId) };
    });

    // POST /security/quarantine/:peerId/appeal — Appeal quarantine (Phase 12.6)
    this.fastify.post('/security/quarantine/:peerId/appeal', async (request: any, reply: any) => {
      const sm = this.node.getSecurityMonitor();
      if (!sm) {
        return reply.code(503).send({ error: 'Security monitor not initialized.' });
      }
      const peerId = request.params.peerId;
      const { reason } = request.body || {};
      if (!reason || typeof reason !== 'string') {
        return reply.code(400).send({ error: 'Appeal reason is required.' });
      }
      const entry = sm.appealQuarantine(peerId, reason);
      if (!entry) {
        return reply.code(404).send({ error: 'Peer not found in active quarantine.' });
      }
      return { appealed: true, entry };
    });

    // ── Chat API (Phase 27: AgentManager) ──────────────────────────────────

    // POST /chat/message — Phase 68.3: Doorman-routed chat
    // Doorman classifies intent → simple (instant) / question (AI answer) / build (create project + manager)
    this.fastify.post('/chat/message', async (request: any, reply: any) => {
      const { message, projectId } = request.body || {};
      if (!message || typeof message !== 'string') {
        return reply.code(400).send({ error: 'message is required' });
      }
      const trimmed = (message as string).trim();
      if (!trimmed) return reply.code(400).send({ error: 'message cannot be empty' });

      const threadStore = this.node.getThreadStore();
      let threadId: string | undefined;

      // Resolve user identity so threads are owned by the authenticated user
      const chatUserId = (await this.verifyUserJwt(request)) || undefined;

      // If projectId is provided, skip doorman — route directly to project manager
      if (projectId) {
        const managerId = `project-${projectId}`;
        if (threadStore) {
          threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          threadStore.createThread(threadId, trimmed.slice(0, 50), 'project', '', chatUserId);
          threadStore.updateThread(threadId, { projectId });
          threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'complex' as any });
        }

        if (!this.agentManager || !hasClaudeCodeAuth()) {
          const noAgentReply = 'No AI-capable nodes available. Ask a node operator to enable Claude Code.';
          if (threadStore && threadId) {
            threadStore.addMessage(threadId, { role: 'assistant', content: noAgentReply, timestamp: Date.now(), tier: 'simple' as any });
          }
          return { status: 'ok', threadId, reply: noAgentReply, tier: 'simple' };
        }

        this.agentManager.getBridge().enqueue(managerId, {
          type: 'user_request',
          payload: { message: trimmed, threadId, projectId },
          source: 'user',
          priority: 'normal',
        });
        return { status: 'queued', managerId, threadId, message: trimmed };
      }

      // No projectId — doorman handles first contact
      const classification = await this.doormanClassify(trimmed);

      if (classification.intent === 'simple' || classification.intent === 'question') {
        // Doorman answers directly — no Claude Code needed
        const doormanReply = classification.response || 'I can help you build apps or answer questions. Try "build me a todo app"!';
        if (threadStore) {
          threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          threadStore.createThread(threadId, trimmed.slice(0, 50), 'conversation', '', chatUserId);
          threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'simple' as any });
          threadStore.addMessage(threadId, { role: 'assistant', content: doormanReply, timestamp: Date.now(), tier: 'simple' as any });
        }
        return { status: 'ok', threadId, reply: doormanReply, tier: 'simple' };
      }

      // Intent is 'build' — create project, run preflight, spawn per-project manager
      if (!this.agentManager || !hasClaudeCodeAuth()) {
        const noAgentReply = 'No AI-capable nodes available. Ask a node operator to enable Claude Code.';
        if (threadStore) {
          threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          threadStore.createThread(threadId, trimmed.slice(0, 50), 'conversation', '', chatUserId);
          threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'simple' as any });
          threadStore.addMessage(threadId, { role: 'assistant', content: noAgentReply, timestamp: Date.now(), tier: 'simple' as any });
        }
        return { status: 'ok', threadId, reply: noAgentReply, tier: 'simple' };
      }

      // Create project automatically
      let newProjectId: string | undefined;
      const projectStore = this.node.getProjectStore?.();
      if (projectStore) {
        try {
          const projName = (classification.description || trimmed).slice(0, 60).replace(/[^a-zA-Z0-9 -]/g, '').trim() || 'New Project';
          const deployTier = (classification.tier === 2) ? 2 : 1;
          const project = await projectStore.createProject({
            name: projName,
            description: classification.description || trimmed,
            ownerId: (await this.verifyUserJwt(request)) || this.node.getIdentity()?.peerId || 'anonymous',
            visibility: 'listed', // Phase 70: public by default
            tier: deployTier, // Phase 70: store tier at creation
          });
          newProjectId = project.id;
          console.log(`[doorman] Created project ${newProjectId}: ${projName} (tier ${deployTier})`);

          // Run preflight (auto-generates API key, assigns MongoDB)
          try {
            const preflightUrl = `http://127.0.0.1:${(this.fastify.server.address() as any)?.port || 4000}/projects/${newProjectId}/preflight`;
            const pfRes = await fetch(preflightUrl, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(10000),
            });
            if (pfRes.ok) {
              console.log(`[doorman] Preflight passed for project ${newProjectId}`);
            }
          } catch (pfErr: any) {
            console.log(`[doorman] Preflight failed: ${pfErr.message} — continuing anyway`);
          }
        } catch (projErr: any) {
          console.log(`[doorman] Project creation failed: ${projErr.message}`);
        }
      }

      // Create thread with projectId
      if (threadStore) {
        threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        threadStore.createThread(threadId, trimmed.slice(0, 50), 'project', '', chatUserId);
        if (newProjectId) {
          threadStore.updateThread(threadId, { projectId: newProjectId });
        }
        threadStore.addMessage(threadId, { role: 'user', content: trimmed, timestamp: Date.now(), tier: 'complex' as any });
      }

      // Spawn per-project manager and enqueue
      const managerId = newProjectId ? `project-${newProjectId}` : 'pando-node-mgr';
      this.agentManager.getBridge().enqueue(managerId, {
        type: 'user_request',
        payload: { message: trimmed, threadId, projectId: newProjectId },
        source: 'user',
        priority: 'normal',
      });

      // Return instant feedback — user knows something is happening
      const instantReply = newProjectId
        ? `Got it! I'm setting up your project and assigning an AI manager to build it. You'll see progress updates here shortly.`
        : `Message received. Your AI manager is working on this.`;

      if (threadStore && threadId) {
        threadStore.addMessage(threadId, { role: 'assistant', content: instantReply, timestamp: Date.now(), tier: 'simple' as any });
      }

      // Push instant feedback via SSE so gateway shows it immediately
      this.pushEvent('chat_message', {
        threadId,
        projectId: newProjectId,
        role: 'assistant',
        content: instantReply,
        timestamp: Date.now(),
        tier: 'simple',
      });

      return { status: 'queued', managerId, threadId, projectId: newProjectId, reply: instantReply, tier: 'complex' };
    });

    // GET /chat/history — return messages from the most recent thread
    this.fastify.get('/chat/history', async (request: any) => {
      const threadStore = this.node.getThreadStore();
      if (!threadStore) return { messages: [] };
      const threads = threadStore.listThreads();
      // threads are sorted by updatedAt desc
      if (threads.length > 0) {
        const latest = threads[0];
        const msgs = threadStore.getMessages(latest.id);
        return { messages: msgs, threadId: latest.id };
      }
      return { messages: [] };
    });

    // POST /chat/clear — no-op (agents manage their own context)
    this.fastify.post('/chat/clear', async () => {
      return { success: true };
    });

    // ── Thread API (Phase 27: ThreadStore for gateway chat) ─────────────────

    // GET /chat/threads — list threads (filtered by user, requires authentication)
    this.fastify.get('/chat/threads', async (request: any) => {
      const threadStore = this.node.getThreadStore();
      if (!threadStore) return { threads: [] };

      // Require a valid user token — only return threads owned by the authenticated user
      const userId = await this.verifyUserJwt(request);
      if (userId) {
        // Use async version — reads from storage backend (MongoDB) for cross-node consistency
        const threads = await threadStore.listUserThreadsAsync(userId);
        return { threads };
      }

      // No valid session — return empty list to prevent leaking other users' threads
      return { threads: [] };
    });

    // POST /chat/threads — create a new thread
    this.fastify.post('/chat/threads', async (request: any, reply: any) => {
      const threadStore = this.node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });

      const { title, type, encryptionKeys, projectId } = request.body || {};
      const threadTitle = (title || 'New Chat').slice(0, 80);
      const threadId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // Resolve user ID from token to associate thread with the user
      const userId = (await this.verifyUserJwt(request)) || undefined;

      // Phase 41: Pass encryptionKeys (peerId -> encrypted threadKey) if provided
      const meta = threadStore.createThread(threadId, threadTitle, projectId ? 'project' : (type || 'conversation'), '', userId, encryptionKeys);
      if (projectId) {
        threadStore.updateThread(threadId, { projectId });
      }
      return meta;
    });

    // GET /chat/threads/:id — get thread messages
    this.fastify.get('/chat/threads/:id', async (request: any, reply: any) => {
      const threadStore = this.node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });

      const { id } = request.params || {};
      // Try cache first, then async fallback (for cross-node access via P2P storage)
      const meta = threadStore.getThread(id) || await threadStore.getThreadAsync(id);
      if (!meta) return reply.code(404).send({ error: 'Thread not found' });

      return { ...meta, messages: await threadStore.getMessagesAsync(id) };
    });

    // DELETE /chat/threads/:id — delete a thread
    this.fastify.delete('/chat/threads/:id', async (request: any, reply: any) => {
      const threadStore = this.node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });
      const { id } = request.params || {};
      const deleted = threadStore.deleteThread(id);
      if (!deleted) return reply.code(404).send({ error: 'Thread not found' });
      return { success: true, deleted: id };
    });

    // PATCH /chat/threads/:id — update thread metadata
    this.fastify.patch('/chat/threads/:id', async (request: any, reply: any) => {
      const threadStore = this.node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });
      const { id } = request.params || {};
      const body = request.body as any || {};
      const updates: any = {};
      if (body.title !== undefined) updates.title = body.title;
      if (body.projectId !== undefined) updates.projectId = body.projectId;
      if (body.archived !== undefined) updates.archived = body.archived;
      if (body.type !== undefined) updates.type = body.type;
      const updated = threadStore.updateThread(id, updates);
      if (!updated) return reply.code(404).send({ error: 'Thread not found' });
      return updated;
    });

    // POST /chat/threads/:id/message — send message in a thread
    this.fastify.post('/chat/threads/:id/message', async (request: any, reply: any) => {
      const threadStore = this.node.getThreadStore();
      if (!threadStore) return reply.code(503).send({ error: 'Thread store not initialized' });

      const { id } = request.params || {};
      const { message, tier, encrypted: isEncrypted, nonce, encryptedThreadKey } = request.body || {};
      if (!message || typeof message !== 'string') {
        return reply.code(400).send({ error: 'message is required' });
      }
      const trimmed = message.trim();
      if (!trimmed) return reply.code(400).send({ error: 'message cannot be empty' });

      // Phase 41.5: If message is encrypted, decrypt it server-side for processing.
      // The encrypted version is stored in the thread for at-rest protection.
      // The encryptedThreadKey is delivered per-request (stateless -- node doesn't store it).
      let plaintextForProcessing = trimmed;
      const threadMeta = threadStore.getThread(id);

      if (isEncrypted && nonce && threadMeta?.encryptionKeys) {
        try {
          plaintextForProcessing = await this.decryptIncomingMessage(trimmed, nonce, threadMeta, encryptedThreadKey);
        } catch (err: any) {
          console.warn(`[api] Failed to decrypt message for thread ${id}: ${err.message}`);
          // Fall back to treating the content as-is (may be garbled but don't block)
          plaintextForProcessing = trimmed;
        }
      }

      // Save user message to thread (encrypted form for at-rest protection)
      threadStore.addMessage(id, {
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
        tier: tier as any,
        encrypted: isEncrypted || false,
        nonce: isEncrypted ? nonce : undefined,
      });

      // ── Phase 68.3: Doorman-routed thread messages ────────────────────────
      // If thread has a projectId, route directly to project manager (no doorman).
      // If no projectId, use doorman to classify intent.
      if (threadMeta?.projectId) {
        // Existing project thread — route directly to manager
        if (!this.agentManager || !hasClaudeCodeAuth()) {
          const noAgentReply = 'No AI-capable nodes available. Ask a node operator to enable Claude Code.';
          threadStore.addMessage(id, { role: 'assistant', content: noAgentReply, timestamp: Date.now(), tier: 'simple' });
          return { status: 'ok', threadId: id, reply: noAgentReply, tier: 'simple' };
        }
        const managerId = `project-${threadMeta.projectId}`;
        this.agentManager.getBridge().enqueue(managerId, {
          type: 'user_request',
          payload: { message: plaintextForProcessing, threadId: id, projectId: threadMeta.projectId },
          source: 'user',
          priority: 'normal',
        });
        return { status: 'queued', threadId: id, reply: 'Message received. Processing...', tier: 'complex' };
      }

      // No projectId — use doorman
      const classification = await this.doormanClassify(plaintextForProcessing);

      if (classification.intent === 'simple' || classification.intent === 'question') {
        const doormanReply = classification.response || 'Try "build me a todo app" to get started!';
        // Handle encryption if needed
        if (isEncrypted && threadMeta?.encryptionKeys) {
          try {
            const encReply = await this.encryptOutgoingMessage(doormanReply, threadMeta, encryptedThreadKey);
            threadStore.addMessage(id, { role: 'assistant', content: encReply.ciphertext, timestamp: Date.now(), tier: 'simple', encrypted: true, nonce: encReply.nonce });
            return { status: 'ok', threadId: id, reply: encReply.ciphertext, tier: 'simple', encrypted: true, nonce: encReply.nonce };
          } catch (err: any) {
            console.warn(`[api] Failed to encrypt doorman reply: ${err.message}`);
          }
        }
        threadStore.addMessage(id, { role: 'assistant', content: doormanReply, timestamp: Date.now(), tier: 'simple' });
        return { status: 'ok', threadId: id, reply: doormanReply, tier: 'simple' };
      }

      // Build request — create project, update thread, route to manager
      if (!this.agentManager || !hasClaudeCodeAuth()) {
        const noAgentReply = 'No AI-capable nodes available. Ask a node operator to enable Claude Code.';
        threadStore.addMessage(id, { role: 'assistant', content: noAgentReply, timestamp: Date.now(), tier: 'simple' });
        return { status: 'ok', threadId: id, reply: noAgentReply, tier: 'simple' };
      }

      // Create project for this build request
      let newProjectId: string | undefined;
      const projectStore = this.node.getProjectStore?.();
      if (projectStore) {
        try {
          const projName = (classification.description || plaintextForProcessing).slice(0, 60).replace(/[^a-zA-Z0-9 -]/g, '').trim() || 'New Project';
          const deployTier = (classification.tier === 2) ? 2 : 1;
          const project = await projectStore.createProject({
            name: projName,
            description: classification.description || plaintextForProcessing,
            ownerId: (await this.verifyUserJwt(request)) || this.node.getIdentity()?.peerId || 'anonymous',
            visibility: 'listed', // Phase 70: public by default
            tier: deployTier, // Phase 70: store tier at creation
          });
          newProjectId = project.id;
          threadStore.updateThread(id, { projectId: newProjectId });
          console.log(`[doorman] Created project ${newProjectId} for thread ${id} (tier ${deployTier})`);

          // Run preflight
          try {
            const pfRes = await fetch(`http://127.0.0.1:${(this.fastify.server.address() as any)?.port || 4000}/projects/${newProjectId}/preflight`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
              signal: AbortSignal.timeout(10000),
            });
            if (pfRes.ok) console.log(`[doorman] Preflight passed for project ${newProjectId}`);
          } catch (pfErr: any) {
            console.log(`[doorman] Preflight failed: ${pfErr.message}`);
          }
        } catch (projErr: any) {
          console.log(`[doorman] Project creation failed: ${projErr.message}`);
        }
      }

      const managerId = newProjectId ? `project-${newProjectId}` : 'pando-node-mgr';
      this.agentManager.getBridge().enqueue(managerId, {
        type: 'user_request',
        payload: { message: plaintextForProcessing, threadId: id, projectId: threadMeta?.projectId || undefined },
        source: 'user',
        priority: 'normal',
      });

      // Return immediate response — real response comes via SSE
      return { status: 'queued', threadId: id, reply: `Message received. Processing...`, tier: 'complex' };
    });

    // ── Bridge Queue API (Phase 27: AgentManager) ──────────────────────────

    // GET /bridge — all bridge queue statuses
    this.fastify.get('/bridge', async () => {
      if (!this.agentManager) {
        return { queues: {}, error: 'Agent system not started' };
      }
      return { queues: this.agentManager.getBridge().getAllStatuses() };
    });

    // GET /bridge/:managerId — bridge queue status for a specific manager
    this.fastify.get('/bridge/:managerId', async (request: any, reply: any) => {
      const { managerId } = request.params || {};
      if (!managerId) {
        return reply.code(400).send({ error: 'Manager ID is required', code: 'BAD_REQUEST' });
      }
      if (!this.agentManager) {
        return reply.code(503).send({ error: 'Agent system not started', code: 'NOT_READY' });
      }
      return this.agentManager.getBridge().getQueueStatus(managerId);
    });

    // POST /tasks/:id/messages — worker mid-task message to bridge queue
    this.fastify.post('/tasks/:id/messages', async (request: any, reply: any) => {
      const { id: taskId } = request.params || {};
      const { type: messageType, content, urgency } = request.body || {};

      if (!taskId) {
        return reply.code(400).send({ error: 'Task ID is required', code: 'BAD_REQUEST' });
      }
      if (!messageType || !content) {
        return reply.code(400).send({ error: 'type and content are required', code: 'BAD_REQUEST' });
      }
      if (!this.agentManager) {
        return reply.code(503).send({ error: 'Agent system not started', code: 'NOT_READY' });
      }

      // Find which manager owns this task
      const taskQueue = this.node.getActiveTaskQueue();
      const task = taskQueue?.getTask(taskId);
      const managerId = task?.managerId || 'pando-node-mgr';

      // Enqueue to bridge
      this.agentManager.getBridge().enqueue(managerId, {
        type: 'worker_message',
        source: `worker-${taskId.slice(0, 8)}`,
        payload: { taskId, messageType, content, urgency },
        priority: messageType === 'blocked' ? 'critical' : 'normal',
      });

      // Broadcast worker message to SSE clients for real-time gateway updates
      this.pushEvent('worker_message', { taskId, messageType, content, timestamp: Date.now() });

      return {
        success: true,
        taskId,
        messageType,
        enqueued: true,
      };
    });

    // ── Capability Declaration API ──────────────────────────────

    // GET /capabilities — local node capability profile (Phase A enriched + legacy)
    this.fastify.get('/capabilities', async () => {
      const identity = this.node.getIdentity();
      const declaration = this.node.getCapabilityDeclaration();
      const peerDeclarations = this.node.getPeerCapabilityDeclarations();

      const peers: Array<{ peerId: string; capabilities: string[]; detectedAt: number; timestamp: number }> = [];
      for (const [peerId, decl] of peerDeclarations) {
        peers.push({
          peerId,
          capabilities: decl.capabilities,
          detectedAt: decl.detectedAt,
          timestamp: decl.timestamp,
        });
      }

      // Phase A: include rich capability profile if available
      const capabilityProfile = this.node.getCapabilityProfile?.() || null;

      return {
        peerId: identity?.peerId || null,
        capabilities: declaration?.capabilities || this.node.getCapabilities(),
        detectedAt: declaration?.detectedAt || null,
        peers,
        profile: capabilityProfile,
      };
    });

    // GET /network/capabilities — all known node capability profiles (Phase A)
    this.fastify.get('/network/capabilities', async () => {
      const profiles = this.node.getNetworkCapabilityProfiles?.() || [];
      // Ensure local node's profile is included (Phase 60 fix)
      const localProfile = this.node.getCapabilityProfile?.();
      if (localProfile && !profiles.some((p: any) => p.peerId === localProfile.peerId)) {
        profiles.unshift(localProfile);
      }
      return {
        count: profiles.length,
        profiles,
      };
    });

    // GET /network/capabilities/user/:username — nodes linked to a specific user (Phase 60)
    this.fastify.get('/network/capabilities/user/:username', async (request: any) => {
      const { username } = request.params as { username: string };
      const profiles = this.node.getNetworkCapabilityProfiles?.() || [];
      // Ensure local node's profile is included (Phase 60 fix)
      const localProfile = this.node.getCapabilityProfile?.();
      if (localProfile && !profiles.some((p: any) => p.peerId === localProfile.peerId)) {
        profiles.unshift(localProfile);
      }
      const userProfiles = profiles.filter(
        (p: any) => p.linkedUser?.username === username
      );
      return {
        count: userProfiles.length,
        profiles: userProfiles,
      };
    });

    // ── Resource Network Routes (Phase B-D) ───────────────────────────

    // GET /resources/routing — routing stats
    this.fastify.get('/resources/routing', async () => {
      const router = this.node.getResourceRouter();
      if (!router) return { error: 'ResourceRouter not initialized' };
      return router.getRoutingStats();
    });

    // POST /resources/route — route a task to the best node (requires auth)
    this.fastify.post('/resources/route', async (request: any, reply: any) => {
      const router = this.node.getResourceRouter();
      if (!router) return reply.code(503).send({ error: 'ResourceRouter not initialized' });

      const { task, requirements } = request.body || {};
      if (!task || !requirements) {
        return reply.code(400).send({ error: 'task and requirements are required' });
      }

      const result = await router.routeTask(task, requirements);
      return result;
    });

    // GET /resources/metering — current metering readings (network-wide)
    this.fastify.get('/resources/metering', async (request: any) => {
      const meter = this.node.getResourceMeter();
      if (!meter) return { error: 'ResourceMeter not initialized' };

      const period = (request.query?.period || 'day') as 'hour' | 'day' | 'week' | 'month';
      return meter.getNetworkUsage(period);
    });

    // GET /resources/metering/:peerId — metering for a specific peer
    this.fastify.get('/resources/metering/:peerId', async (request: any) => {
      const meter = this.node.getResourceMeter();
      if (!meter) return { error: 'ResourceMeter not initialized' };

      const { peerId } = request.params;
      const period = (request.query?.period || 'day') as 'hour' | 'day' | 'week' | 'month';
      return meter.getUsage(peerId, period);
    });

    // GET /resources/rewards — reward calculations for local node
    this.fastify.get('/resources/rewards', async (request: any) => {
      const meter = this.node.getResourceMeter();
      if (!meter) return { error: 'ResourceMeter not initialized' };

      const identity = this.node.getIdentity();
      if (!identity) return { error: 'No identity' };

      const period = (request.query?.period || 'day') as 'hour' | 'day' | 'week' | 'month';
      return meter.calculateRewards(identity.peerId, period);
    });

    // GET /resources/marketplace — market stats and local prices
    this.fastify.get('/resources/marketplace', async () => {
      const marketplace = this.node.getResourceMarketplace();
      if (!marketplace) return { error: 'ResourceMarketplace not initialized' };

      return {
        localPrices: marketplace.getPrices(),
        stats: marketplace.getMarketStats(),
      };
    });

    // POST /resources/prices — set local prices (requires auth)
    this.fastify.post('/resources/prices', async (request: any, reply: any) => {
      const marketplace = this.node.getResourceMarketplace();
      if (!marketplace) return reply.code(503).send({ error: 'ResourceMarketplace not initialized' });

      const { prices } = request.body || {};
      if (!prices || typeof prices !== 'object') {
        return reply.code(400).send({ error: 'prices object is required (resourceType -> pricePerUnit)' });
      }

      for (const [resourceType, pricePerUnit] of Object.entries(prices)) {
        if (typeof pricePerUnit === 'number' && pricePerUnit >= 0) {
          marketplace.setPrice(resourceType, pricePerUnit);
        }
      }

      // Broadcast updated prices
      await marketplace.broadcastPrices();

      return { success: true, prices: marketplace.getPrices() };
    });

    // GET /resources/marketplace/find — find cheapest provider for requirements
    this.fastify.get('/resources/marketplace/find', async (request: any) => {
      const marketplace = this.node.getResourceMarketplace();
      if (!marketplace) return { error: 'ResourceMarketplace not initialized' };

      const resourcesParam = request.query?.resources || '';
      const budgetParam = request.query?.budget;

      const requiredResources = resourcesParam
        ? resourcesParam.split(',').map((r: string) => r.trim())
        : [];

      const requirements = { requiredResources };

      if (budgetParam) {
        const budget = parseFloat(budgetParam);
        if (!isNaN(budget) && budget > 0) {
          return {
            matches: marketplace.matchBudget(budget, requirements),
          };
        }
      }

      return marketplace.findCheapest(requirements);
    });

    // ── Capacity Dashboard Endpoint (Phase 49) ────────────────────────

    // GET /capacity — Aggregated capacity dashboard data for the network.
    // Combines supply (marketplace), demand (meter + scheduler), rewards,
    // and network stats into a single response.  Every subsystem call is
    // wrapped in try/catch so partial data is returned when a subsystem
    // is unavailable.
    this.fastify.get('/capacity', async () => {
      // Unit map for resource types
      const UNIT_MAP: Record<string, string> = {
        relay: 'MB',
        api_keys: 'call',
        compute_cpu: 'minute',
        compute_gpu: 'minute',
        storage: 'GB-hour',
        gateway: '1000 requests',
        validator: 'validation',
        index: 'query',
      };

      // ── Supply ──────────────────────────────────────────────────────
      let supply: any = { totalProviders: 0, resources: {} };
      try {
        const marketplace = this.node.getResourceMarketplace();
        const capRegistry = this.node.getCapabilityRegistry();
        const profiles = capRegistry ? capRegistry.getAllProfiles() : [];

        if (marketplace) {
          const stats = marketplace.getMarketStats();
          // stats.totalResources: Record<string, number> (resource -> provider count)
          // stats.averagePrices: Record<string, number>
          // stats.lowestPrices: Record<string, { price: number; peerId: string }>
          // stats.activeProviders: number

          supply.totalProviders = stats.activeProviders;

          // Build per-resource supply info
          const allResourceTypes = new Set([
            ...Object.keys(stats.totalResources || {}),
            ...Object.keys(stats.averagePrices || {}),
          ]);

          for (const rt of allResourceTypes) {
            supply.resources[rt] = {
              providers: (stats.totalResources || {})[rt] || 0,
              averagePrice: (stats.averagePrices || {})[rt] || 0,
              lowestPrice: (stats.lowestPrices || {})[rt]?.price || 0,
              unit: UNIT_MAP[rt] || 'unit',
            };
          }
        } else if (profiles.length > 0) {
          // Marketplace not available but we have capability profiles
          supply.totalProviders = profiles.length;
        }
      } catch (err: any) {
        console.error(`[api] /capacity supply error: ${err.message}`);
      }

      // ── Demand ──────────────────────────────────────────────────────
      let demand: any = {
        period: 'day',
        resources: {},
        tasks: { active: 0, queued: 0, totalProcessed: 0, successRate: 0 },
      };
      try {
        const meter = this.node.getResourceMeter();
        if (meter) {
          const networkUsage = meter.getNetworkUsage('day');
          // networkUsage.readings: Record<string, { totalUsage, unit, contributingNodes }>
          for (const [rt, reading] of Object.entries(networkUsage.readings || {})) {
            demand.resources[rt] = {
              totalUsage: reading.totalUsage,
              unit: UNIT_MAP[rt] || reading.unit || 'unit',
              contributingNodes: reading.contributingNodes,
            };
          }
        }
      } catch (err: any) {
        console.error(`[api] /capacity demand-meter error: ${err.message}`);
      }

      try {
        const scheduler = this.node.getScheduler();
        if (scheduler) {
          const status = scheduler.getStatus();
          const totalProcessed = status.totalProcessed || 0;
          const totalSucceeded = status.totalSucceeded || 0;
          const totalFailed = status.totalFailed || 0;

          demand.tasks = {
            active: (status.activeTasks || []).length,
            queued: status.approvedQueueLength || 0,
            totalProcessed,
            successRate: totalProcessed > 0
              ? Math.round((totalSucceeded / totalProcessed) * 10000) / 100
              : 0,
          };
        }
      } catch (err: any) {
        console.error(`[api] /capacity demand-scheduler error: ${err.message}`);
      }

      // ── Rewards ─────────────────────────────────────────────────────
      let rewards: any = { totalDistributed: 0, perResource: {} };
      try {
        const meter = this.node.getResourceMeter();
        if (meter) {
          const networkUsage = meter.getNetworkUsage('day');
          rewards.totalDistributed = networkUsage.totalRewardsDistributed || 0;

          // Per-resource reward rates and estimated daily earnings
          // Reward rates are defined in resource-meter.ts REWARD_RATES
          const REWARD_RATES: Record<string, number> = {
            relay: 0.001,
            api_keys: 0.01,
            compute_cpu: 0.1,
            compute_gpu: 0.5,
            storage: 0.001,
            gateway: 0.01,
            validator: 0.05,
            index: 0.005,
          };

          for (const [rt, reading] of Object.entries(networkUsage.readings || {})) {
            const rate = REWARD_RATES[rt] || 0;
            const providers = supply.resources[rt]?.providers || 1;
            // Estimated daily per provider = (total daily usage * rate) / providers
            const estimatedDaily = providers > 0
              ? Math.round(((reading.totalUsage * rate) / providers) * 10000) / 10000
              : 0;

            rewards.perResource[rt] = {
              rate,
              estimatedDaily,
            };
          }

          // Also include resource types that have rates but no usage yet
          for (const [rt, rate] of Object.entries(REWARD_RATES)) {
            if (!rewards.perResource[rt]) {
              rewards.perResource[rt] = { rate, estimatedDaily: 0 };
            }
          }
        }
      } catch (err: any) {
        console.error(`[api] /capacity rewards error: ${err.message}`);
      }

      // ── Network ─────────────────────────────────────────────────────
      let network: any = {
        totalNodes: 0,
        totalAccounts: 0,
        totalSupply: 0,
        nodeHealth: 'unknown',
      };
      try {
        const capRegistry = this.node.getCapabilityRegistry();
        if (capRegistry) {
          network.totalNodes = capRegistry.getAllProfiles().length;
        }
      } catch (err: any) {
        console.error(`[api] /capacity network-caps error: ${err.message}`);
      }

      try {
        const ledger = this.node.getLedger();
        if (ledger) {
          const stats = ledger.getNetworkStats();
          network.totalAccounts = stats.totalAccounts || 0;
          network.totalSupply = stats.totalSupply || 0;
        }
      } catch (err: any) {
        console.error(`[api] /capacity network-ledger error: ${err.message}`);
      }

      try {
        const monitor = this.node.getMonitor();
        if (monitor) {
          const metrics = monitor.getCurrentMetrics();
          network.nodeHealth = metrics.nodeHealth || 'unknown';
        }
      } catch (err: any) {
        console.error(`[api] /capacity network-monitor error: ${err.message}`);
      }

      return { supply, demand, rewards, network };
    });

    // ── Network State Endpoint (Phase 50) ──────────────────────────────

    // GET /network-state — aggregated network state snapshot (public, no auth)
    this.fastify.get('/network-state', async () => {
      const ns = this.node.getNetworkState?.();
      if (!ns) return { error: 'NetworkState not initialized' };
      return ns.getSnapshot();
    });

    // ── Resource Registry Routes (Phase 42.5) ──────────────────────────

    // GET /resources — list all resources (Phase 69: metadata only, no secrets in records)
    this.fastify.get('/resources', async (request: any) => {
      const registry = this.node.getResourceRegistry();
      if (!registry) return { resources: [] };
      const { type } = (request.query || {}) as { type?: string };
      if (type) {
        return { resources: registry.findResources(type as any) };
      }
      return { resources: registry.getAllResources() };
    });

    // POST /resources/register — contribute a new resource (API key, storage, etc.)
    this.fastify.post('/resources/register', async (request: any, reply: any) => {
      const registry = this.node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'Resource registry not initialized' });

      const body = request.body as any;
      let { type, credential } = body || {};

      if (!type || !credential) {
        return reply.code(400).send({ error: 'Missing required fields: type, credential' });
      }

      // Phase 60: runtime validation — reject removed resource types
      const VALID_RESOURCE_TYPES = ['ai_api_key', 'storage_db', 'storage_blob', 'cloud_compute', 'hosting_platform', 'code_repository'];
      if (!VALID_RESOURCE_TYPES.includes(type)) {
        return reply.code(400).send({ error: `Invalid resource type '${type}'. Valid types: ${VALID_RESOURCE_TYPES.join(', ')}` });
      }

      // Resolve authenticated user (resources belong to USERS, not nodes)
      const userId = await this.verifyUserJwt(request) || body.userId;

      const record = await registry.registerResource(type, credential, {
        userId,
        grantedTo: body.grantedTo,
        maxUsagePerDay: body.maxUsagePerDay,
        pricePerUnit: body.pricePerUnit,
        expiresAt: body.expiresAt,
        metadata: body.metadata,
      });

      return { resourceId: record.resourceId, status: record.status, userId: record.userId };
    });

    // POST /resources/:id/revoke — revoke a resource (owner or provider node)
    this.fastify.post('/resources/:id/revoke', async (request: any, reply: any) => {
      const registry = this.node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'Resource registry not initialized' });

      const { id } = request.params as { id: string };
      const userId = await this.verifyUserJwt(request) || undefined;
      const success = await registry.revokeResource(id, userId);
      if (!success) return reply.code(403).send({ error: 'Cannot revoke: not found or not the owner' });
      return { resourceId: id, status: 'revoked' };
    });

    // GET /resources/:id — get a single resource (Phase 69: metadata only)
    this.fastify.get('/resources/:id', async (request: any, reply: any) => {
      const registry = this.node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'Resource registry not initialized' });

      const { id } = request.params as { id: string };
      const record = registry.getResource(id);
      if (!record) return reply.code(404).send({ error: 'Resource not found' });
      return record;
    });

    // Phase 69: POST /resources/:id/grant REMOVED — no more per-node granting.
    // Credentials are in MongoDB, decryptable by any compute node with CREDENTIAL_MASTER_KEY.

    // PATCH /resources/:id/owner — link a resource to a user account
    this.fastify.patch('/resources/:id/owner', async (request: any, reply: any) => {
      const registry = this.node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'Resource registry not available' });

      const { id } = request.params as { id: string };
      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Authentication required' });

      const success = registry.updateResourceUserId(id, userId, userId);
      if (!success) return reply.code(404).send({ error: 'Resource not found or permission denied' });

      return { success: true, resourceId: id, userId };
    });

    // ── Resource Proxy Routes (Phase 53.2) ──────────────────────────────

    // POST /resource-proxy/validate — validate a project API key and return decrypted MongoDB URI
    this.fastify.post('/resource-proxy/validate', async (request: any, reply: any) => {
      const body = request.body as { projectKey?: string };
      if (!body?.projectKey || typeof body.projectKey !== 'string') {
        return reply.code(400).send({ error: 'Missing required field: projectKey' });
      }

      const registry = this.node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'Resource registry not available', valid: false });

      // Phase 63: Try P2P ProjectRegistry first (works on ANY node, no MongoDB needed)
      const projectRegistry = this.node.getProjectRegistry();
      let projectId: string | null = null;
      let projectResourceIds: string[] = [];

      if (projectRegistry) {
        const record = projectRegistry.validateApiKey(body.projectKey);
        if (record) {
          projectId = record.projectId;
          projectResourceIds = record.resourceIds;
        }
      }

      // Fallback: try ProjectStore (MongoDB) if P2P didn't find it
      if (!projectId) {
        const ps = this.node.getProjectStore();
        if (ps) {
          const project = await ps.getProjectByApiKeyAsync(body.projectKey);
          if (project) {
            projectId = project.id;
            projectResourceIds = (project.resources || []).map((r: any) => r.resourceId);
          }
        }
      }

      if (!projectId) {
        return reply.code(401).send({ error: 'Invalid project key', valid: false });
      }

      // Find MongoDB resources assigned to this project (type = 'storage_db')
      const dbResources = registry.findResources('storage_db');
      let mongoUri: string | null = null;
      let resourceId: string | null = null;

      // Check for resources specifically granted to this project or to all ('*')
      for (const res of dbResources) {
        // Check if resource metadata references this project
        if (res.metadata?.projectId === projectId || res.grantedTo.includes('*') || res.grantedTo.includes(projectId)) {
          const credential = await registry.getCredential(res.resourceId);
          if (credential) {
            mongoUri = credential;
            resourceId = res.resourceId;
            break;
          }
        }
      }

      // Phase 68.1: No fallback to arbitrary resources. Apps must use their assigned resource.
      // This prevents data leakage between projects sharing the same MongoDB.

      if (!mongoUri) {
        return reply.code(200).send({
          valid: true,
          projectId,
          mongoUri: null,
          resourceId: null,
          error: 'No database resource available',
        });
      }

      return {
        valid: true,
        projectId,
        mongoUri,
        resourceId,
      };
    });

    // POST /resource-proxy/meter — record usage event for Lux billing
    this.fastify.post('/resource-proxy/meter', async (request: any, reply: any) => {
      const body = request.body as {
        projectId?: string;
        resourceId?: string;
        operation?: string;
        count?: number;
        bytes?: number;
      };

      if (!body?.projectId || !body?.resourceId || !body?.operation) {
        return reply.code(400).send({ error: 'Missing required fields: projectId, resourceId, operation' });
      }

      // Record the usage event (for now, log it — full Lux billing in 53.3)
      const event = {
        projectId: body.projectId,
        resourceId: body.resourceId,
        operation: body.operation,
        count: body.count || 0,
        bytes: body.bytes || 0,
        timestamp: Date.now(),
      };

      console.log(`[resource-proxy] Usage: project=${event.projectId} op=${event.operation} count=${event.count} bytes=${event.bytes}`);

      return { recorded: true, event };
    });

    // ── Cloud Instance Routes (Phase 64) ──────────────────────────────

    // GET /instances — list all managed cloud instances
    this.fastify.get('/instances', async () => {
      const manager = this.node.getCloudInstanceManager();
      if (!manager) return { instances: [] };
      return { instances: manager.getInstances() };
    });

    // GET /instances/:id — get a single instance
    this.fastify.get('/instances/:id', async (request: any, reply: any) => {
      const manager = this.node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      const instance = manager.getInstance(id);
      if (!instance) return reply.code(404).send({ error: 'Instance not found' });
      return instance;
    });

    // POST /instances/launch — launch a new secure EC2 instance
    this.fastify.post('/instances/launch', async (request: any, reply: any) => {
      const manager = this.node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const body = request.body as any;
      if (!body?.resourceId) {
        return reply.code(400).send({ error: 'Missing required field: resourceId' });
      }

      try {
        const record = await manager.launchInstance(body.resourceId, {
          instanceType: body.instanceType,
          region: body.region,
        });
        return record;
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // POST /instances/:id/terminate — terminate a cloud instance
    this.fastify.post('/instances/:id/terminate', async (request: any, reply: any) => {
      const manager = this.node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      try {
        await manager.terminateInstance(id);
        return { instanceId: id, status: 'terminated' };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // GET /instances/:id/health — check instance health via AWS API
    this.fastify.get('/instances/:id/health', async (request: any, reply: any) => {
      const manager = this.node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      try {
        const health = await manager.checkInstanceHealth(id);
        return { instanceId: id, ...health };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // GET /instances/:id/console — get serial console output (cloud-init logs, boot messages)
    this.fastify.get('/instances/:id/console', async (request: any, reply: any) => {
      const manager = this.node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      const { lines } = (request.query || {}) as { lines?: string };
      try {
        const result = await manager.getConsoleOutput(id);
        // Optionally return only the last N lines
        if (lines && result.output) {
          const allLines = result.output.split('\n');
          const n = parseInt(lines, 10) || 50;
          result.output = allLines.slice(-n).join('\n');
        }
        return result;
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // POST /instances/:id/deploy — deploy an app to a compute instance via P2P
    this.fastify.post('/instances/:id/deploy', async (request: any, reply: any) => {
      const manager = this.node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      const body = request.body as any;
      if (!body?.projectId) {
        return reply.code(400).send({ error: 'Missing required field: projectId' });
      }

      const instance = manager.getInstance(id);
      if (!instance) return reply.code(404).send({ error: 'Instance not found' });
      if (instance.status !== 'running') {
        return reply.code(409).send({ error: `Instance is ${instance.status}, must be running` });
      }

      try {
        // Auto-inject project credentials as env vars for the deployed app
        const envVars: Record<string, string> = { ...(body.envVars || {}) };
        const gatewayUrl = process.env.GATEWAY_PUBLIC_URL || process.env.GATEWAY_URL || '';
        if (gatewayUrl && !envVars.RESOURCE_PROXY_URL) {
          envVars.RESOURCE_PROXY_URL = `${gatewayUrl}/api/resource-proxy/db`;
        }
        // Look up the project's API key from ProjectStore
        const projectStore = this.node.getProjectStore?.();
        if (projectStore && !envVars.PROJECT_API_KEY) {
          try {
            const project = projectStore.getProject(body.projectId);
            if (project?.apiKey) {
              envVars.PROJECT_API_KEY = project.apiKey;
            }
          } catch {}
        }
        if (gatewayUrl) {
          envVars.GATEWAY_URL = gatewayUrl;
        }

        const result = await manager.deployApp(id, body.projectId, body.repoUrl, envVars);
        return result;
      } catch (err: any) {
        console.log(`[api] P2P deploy failed: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    });

    // POST /instances/:id/upgrade — upgrade a compute instance via P2P (Phase 67)
    this.fastify.post('/instances/:id/upgrade', async (request: any, reply: any) => {
      const manager = this.node.getCloudInstanceManager();
      if (!manager) return reply.code(503).send({ error: 'Cloud instance manager not available' });

      const { id } = request.params as { id: string };
      const instance = manager.getInstance(id);
      if (!instance) return reply.code(404).send({ error: 'Instance not found' });
      if (instance.status !== 'running') {
        return reply.code(409).send({ error: `Instance is ${instance.status}, must be running` });
      }

      try {
        const result = await manager.upgradeInstance(id);
        return { ok: true, instanceId: id, ...result };
      } catch (err: any) {
        console.log(`[api] Instance upgrade failed: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    });

    // ── Content Layer Routes (Phase 11) ──

    // GET /content — list all content (with optional type/status/search query params)
    this.fastify.get('/content', async (request: any) => {
      const registry = this.node.getContentRegistry();
      if (!registry) return { content: [], stats: null };

      const { q, type, status, limit } = request.query || {};
      if (q) {
        const results = registry.search(q, parseInt(limit) || 20);
        return { content: results.map((r: any) => r.content), searchResults: results };
      }

      const content = registry.list({
        type: type || undefined,
        status: status || undefined,
        limit: parseInt(limit) || 100,
      });
      return { content };
    });

    // GET /content/search — full-text search
    this.fastify.get('/content/search', async (request: any) => {
      const registry = this.node.getContentRegistry();
      if (!registry) return { results: [] };

      const { q, limit } = request.query || {};
      if (!q) return { results: [] };
      const results = registry.search(q, parseInt(limit) || 20);
      return { results };
    });

    // GET /content/stats — content statistics
    this.fastify.get('/content/stats', async () => {
      const registry = this.node.getContentRegistry();
      if (!registry) return { totalContent: 0, byType: {}, byStatus: {}, totalLuxEarned: 0 };
      return registry.getStats();
    });

    // GET /content/:id — get specific content record
    this.fastify.get('/content/:id', async (request: any, reply: any) => {
      const registry = this.node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const record = registry.get(request.params.id);
      if (!record) return reply.code(404).send({ error: 'Content not found' });
      return record;
    });

    // GET /content/:id/revenue — revenue breakdown for content
    this.fastify.get('/content/:id/revenue', async (request: any, reply: any) => {
      const registry = this.node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const revenue = registry.getRevenue(request.params.id);
      if (!revenue) return reply.code(404).send({ error: 'Content not found' });
      return revenue;
    });

    // POST /content — create content record
    this.fastify.post('/content', async (request: any, reply: any) => {
      const registry = this.node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const { type, title, description, repoUrl, liveUrl, tags, manifest, status } = request.body || {};
      if (!type || !title) {
        return reply.code(400).send({ error: 'type and title are required' });
      }

      const validTypes = ['website', 'api', 'dataset', 'service', 'document', 'tool'];
      if (!validTypes.includes(type)) {
        return reply.code(400).send({ error: `type must be one of: ${validTypes.join(', ')}` });
      }

      const identity = this.node.getIdentity();
      const record = registry.create({
        type,
        title,
        description,
        ownerPeerId: identity?.peerId,
        repoUrl,
        liveUrl,
        tags,
        manifest,
        status,
      });

      return { success: true, contentId: record.contentId, record };
    });

    // PUT /content/:id — update content record (owner check)
    this.fastify.put('/content/:id', async (request: any, reply: any) => {
      const registry = this.node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const existing = registry.get(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Content not found' });

      const identity = this.node.getIdentity();
      if (existing.ownerPeerId !== identity?.peerId) {
        return reply.code(403).send({ error: 'Only the owner can update this content' });
      }

      const { title, description, repoUrl, liveUrl, tags, status, manifest } = request.body || {};
      const updated = registry.update(request.params.id, {
        title, description, repoUrl, liveUrl, tags, status, manifest,
      });

      if (!updated) return reply.code(500).send({ error: 'Update failed' });
      return { success: true, record: updated };
    });

    // DELETE /content/:id — archive content (owner check)
    this.fastify.delete('/content/:id', async (request: any, reply: any) => {
      const registry = this.node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const existing = registry.get(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Content not found' });

      const identity = this.node.getIdentity();
      if (existing.ownerPeerId !== identity?.peerId) {
        return reply.code(403).send({ error: 'Only the owner can archive this content' });
      }

      const archived = registry.archive(request.params.id);
      if (!archived) return reply.code(500).send({ error: 'Archive failed' });
      return { success: true, archived: true };
    });

    // POST /content/:id/publish — trigger publish flow
    this.fastify.post('/content/:id/publish', async (request: any, reply: any) => {
      const registry = this.node.getContentRegistry();
      if (!registry) return reply.code(503).send({ error: 'Content registry not ready' });

      const existing = registry.get(request.params.id);
      if (!existing) return reply.code(404).send({ error: 'Content not found' });

      const identity = this.node.getIdentity();
      if (existing.ownerPeerId !== identity?.peerId) {
        return reply.code(403).send({ error: 'Only the owner can publish this content' });
      }

      // Set status to live
      const updated = registry.update(request.params.id, { status: 'live' });
      if (!updated) return reply.code(500).send({ error: 'Publish failed' });
      return { success: true, record: updated };
    });

    // ── Regression Suite API (Phase 17.6) ──────────────────────────

    // GET /regression — Regression suite status and test list
    this.fastify.get('/regression', async () => {
      const suite = this.node.getRegressionSuite();
      if (!suite) return { available: false, tests: [], stats: null };
      return {
        available: true,
        stats: suite.getStats(),
        tests: suite.getTests(),
        lastResult: suite.getLastResult(),
      };
    });

    // POST /regression/run — Run full regression suite (requires auth)
    this.fastify.post('/regression/run', async (request: any) => {
      const suite = this.node.getRegressionSuite();
      if (!suite) return { error: 'Regression suite not available' };
      const { category, apiUrl } = (request.body || {}) as { category?: string; apiUrl?: string };
      const result = category
        ? await suite.runCategory(category, apiUrl)
        : await suite.runAll(apiUrl);
      return result;
    });

    // GET /regression/results — Last regression run results
    this.fastify.get('/regression/results', async () => {
      const suite = this.node.getRegressionSuite();
      if (!suite) return { available: false, result: null };
      return { available: true, result: suite.getLastResult() };
    });

    // ── Payment Gate API (Phase 18.6) ──────────────────────────────

    // POST /payment/estimate — Estimate cost for a task description
    this.fastify.post('/payment/estimate', async (request: any, reply: any) => {
      const gate = this.node.getPaymentGate();
      if (!gate) return reply.code(503).send({ error: 'Payment gate not available' });
      const { complexity, category } = (request.body || {}) as { complexity?: string; category?: string };
      if (!complexity) {
        return reply.code(400).send({ error: '"complexity" is required (trivial|simple|moderate|complex|project)' });
      }
      const estimate = gate.estimateCost(complexity, category || 'task');
      return estimate;
    });

    // POST /payment/hold — Create payment hold for a task (requires auth)
    this.fastify.post('/payment/hold', async (request: any, reply: any) => {
      const gate = this.node.getPaymentGate();
      if (!gate) return reply.code(503).send({ error: 'Payment gate not available' });
      const { peerId, taskId, amount } = (request.body || {}) as { peerId?: string; taskId?: string; amount?: number };
      if (!peerId || !taskId || amount === undefined) {
        return reply.code(400).send({ error: '"peerId", "taskId", and "amount" are required' });
      }
      const hold = gate.holdPayment(peerId, taskId, amount);
      if (!hold) {
        return reply.code(402).send({ error: 'Insufficient balance', code: 'INSUFFICIENT_BALANCE' });
      }
      return hold;
    });

    // GET /payment/history — Payment history (optional peerId filter)
    this.fastify.get('/payment/history', async (request: any) => {
      const gate = this.node.getPaymentGate();
      if (!gate) return { history: [] };
      const peerId = (request.query as any)?.peerId;
      return { history: gate.getPaymentHistory(peerId) };
    });

    // GET /payment/stats — Payment statistics
    this.fastify.get('/payment/stats', async () => {
      const gate = this.node.getPaymentGate();
      if (!gate) return { stats: null };
      return { stats: gate.getStats() };
    });

    // ── Unified Identity Auth API ──────────────────────────────────────

    // POST /auth/guest — Create a guest identity + issue JWT.
    // Phase 41: Accepts browser-generated { publicKey } so private key never leaves the browser.
    // Phase 86: Returns a JWT instead of a session token.
    this.fastify.post('/auth/guest', async (request: any, reply: any) => {
      const store = this.node.getUserAccountStore();
      if (!store) return reply.code(503).send({ error: 'User accounts not available' });

      const body = (request.body || {}) as { peerId?: string; publicKey?: string };

      let result: any;

      if (body.publicKey) {
        // Phase 41: Browser-generated keypair — derive peerId from public key, register
        const { peerIdFromPublicKey } = await import('@libp2p/peer-id');
        const rawPub = uint8ArrayFromString(body.publicKey, 'base64');
        const proto = new Uint8Array(4 + rawPub.length);
        proto[0] = 0x08; proto[1] = 0x01; proto[2] = 0x12; proto[3] = rawPub.length;
        proto.set(rawPub, 4);
        const pk = publicKeyFromProtobuf(proto);
        const derivedPeerId = peerIdFromPublicKey(pk).toString();

        result = await store.createGuestFromBrowserKey({
          peerId: derivedPeerId,
          publicKey: body.publicKey,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        });
      } else {
        // Legacy: server-side key generation (no encryption support)
        result = await store.createGuest({
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        });
      }

      if (!result.success) {
        return reply.code(500).send({ error: result.error });
      }

      // Phase 86: Issue JWT instead of returning the session token from UserAccountStore
      const jwt = await this.issueJwt(result.peerId);
      return {
        success: true,
        token: jwt.token,
        expiresAt: jwt.expiresAt,
        peerId: result.peerId,
        publicKey: result.publicKey,
        isClaimed: false,
        isNewAccount: result.isNewAccount,
      };
    });

    // POST /auth/claim — Upgrade a guest account to a claimed account (set password + optional username)
    // Phase 86: Uses JWT to identify the user, issues a new JWT on success.
    this.fastify.post('/auth/claim', async (request: any, reply: any) => {
      const store = this.node.getUserAccountStore();
      if (!store) return reply.code(503).send({ error: 'User accounts not available' });

      // Phase 86: Verify JWT to get the user's peerId
      const userPeerId = await this.verifyUserJwt(request);
      if (!userPeerId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      const { password, username } = (request.body || {}) as {
        password?: string;
        username?: string;
      };

      if (!password) {
        return reply.code(400).send({ error: 'password is required' });
      }

      // Phase 86: claim() now takes peerId directly instead of a session token
      const result = await store.claimByPeerId(userPeerId, password, username);

      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }

      // Phase 56: ledger account already exists (created during guest creation)

      // Phase 57 FIX: Welcome bonus moved here from POST /auth/guest.
      // Only mint GUEST_WELCOME when a guest CLAIMS an account (registers).
      // This is a one-time event — the claim() method already rejects if already claimed.
      // Extra safety: check ledger balance to avoid double-granting if claim is replayed.
      const ledger = this.node.getLedger();
      if (ledger && result.peerId) {
        try {
          const currentBalance = ledger.accounts.getBalance(result.peerId);
          if (currentBalance <= 0) {
            const { WorkType } = await import('@pando/shared');
            const tx = ledger.rewardWork(result.peerId, WorkType.GUEST_WELCOME, 'welcome: account registration');
            console.log(`[faucet] New user ${result.username || result.peerId.slice(0, 16) + '...'} granted ${tx.amount} Lux (welcome)`);
            // Broadcast so other nodes see the emission
            const sync = this.node.getSync();
            if (sync) sync.broadcastTransaction(tx).catch(() => {});
          }
        } catch (err: any) {
          // Non-fatal — claim succeeded, just no welcome Lux
          console.error(`[faucet] Welcome grant on claim failed: ${err.message}`);
        }
      }

      // Broadcast account claim with current balance AFTER welcome bonus is minted.
      if (result.peerId && ledger) {
        const sync = this.node.getSync();
        if (sync) {
          const authFields = ledger.accounts.getAuthFields(result.peerId);
          const finalBalance = ledger.accounts.getBalance(result.peerId);
          sync.broadcastClaim({
            peerId: result.peerId,
            username: result.username || null,
            displayName: null,
            passwordHash: authFields?.passwordHash || '',
            claimedAt: Date.now(),
            balance: finalBalance,
          }).catch(() => {});
        }
      }

      // Phase 86: Issue fresh JWT for the now-claimed account
      const jwt = await this.issueJwt(result.peerId!);
      return { ...result, token: jwt.token, expiresAt: jwt.expiresAt };
    });

    // POST /auth/login — Login with username or peerId + password
    // Phase 86: Returns a JWT instead of a session token.
    this.fastify.post('/auth/login', async (request: any, reply: any) => {
      const store = this.node.getUserAccountStore();
      if (!store) return reply.code(503).send({ error: 'User accounts not available' });

      const { identifier, password } = (request.body || {}) as {
        identifier?: string;
        password?: string;
      };

      if (!identifier || !password) {
        return reply.code(400).send({ error: 'identifier and password are required' });
      }

      try {
        const result = await store.login(identifier, password, {
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        });

        if (!result.success) {
          return reply.code(401).send({ error: result.error });
        }

        // Phase 86: Issue JWT instead of returning session token from UserAccountStore
        const jwt = await this.issueJwt(result.peerId!);
        return { ...result, token: jwt.token, expiresAt: jwt.expiresAt };
      } catch (err: any) {
        console.error('[api] Login error:', err.message);
        return reply.code(500).send({ error: err.message || 'Login failed' });
      }
    });

    // POST /auth/logout — Phase 86: Server-side no-op. JWT is stateless — client discards it.
    this.fastify.post('/auth/logout', async () => {
      return { success: true };
    });

    // POST /auth/backup-key — Store encrypted private key backup (Phase 41.5: multi-device)
    this.fastify.post('/auth/backup-key', async (request: any, reply: any) => {
      const store = this.node.getUserAccountStore();
      if (!store) return reply.code(503).send({ error: 'User accounts not available' });

      const peerId = await this.verifyUserJwt(request);
      if (!peerId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      const { encryptedKey } = (request.body || {}) as { encryptedKey?: string };
      if (!encryptedKey || typeof encryptedKey !== 'string') {
        return reply.code(400).send({ error: 'encryptedKey is required' });
      }

      await store.storeEncryptedKey(peerId, encryptedKey);
      return { success: true };
    });

    // GET /auth/backup-key — Retrieve encrypted private key backup (Phase 41.5: multi-device)
    this.fastify.get('/auth/backup-key', async (request: any, reply: any) => {
      const store = this.node.getUserAccountStore();
      if (!store) return reply.code(503).send({ error: 'User accounts not available' });

      const peerId = await this.verifyUserJwt(request);
      if (!peerId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      const encryptedKey = await store.getEncryptedKey(peerId);
      return { encryptedKey: encryptedKey || null };
    });

    // GET /auth/me — Get current user profile + Lux balance (requires valid JWT)
    // Phase 86: Simple JWT decode — fully stateless, no DB lookup.
    this.fastify.get('/auth/me', async (request: any, reply: any) => {
      const peerId = await this.verifyUserJwt(request);
      if (!peerId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }

      const ledger = this.node.getLedger();
      let balance = 0;
      let publicKey = '';
      let username: string | undefined;
      let isClaimed = false;
      if (ledger) {
        balance = ledger.accounts.getBalance(peerId);
        const account = ledger.accounts.get(peerId);
        if (account) publicKey = account.publicKey;
        const authFields = ledger.accounts.getAuthFields(peerId);
        if (authFields) {
          username = authFields.username || undefined;
          isClaimed = authFields.isClaimed;
        }
      }
      return {
        user: { peerId, publicKey, username, isClaimed, balance, authMethod: 'jwt' },
      };
    });

    // POST /auth/refresh — Phase 86: Issue a fresh JWT if the current one is still valid.
    this.fastify.post('/auth/refresh', async (request: any, reply: any) => {
      const peerId = await this.verifyUserJwt(request);
      if (!peerId) {
        return reply.code(401).send({ error: 'Invalid or expired token' });
      }
      const jwt = await this.issueJwt(peerId);
      return { success: true, token: jwt.token, expiresAt: jwt.expiresAt, peerId };
    });

    // GET /auth/stats — Identity statistics (public)
    this.fastify.get('/auth/stats', async () => {
      const store = this.node.getUserAccountStore();
      if (!store) return { stats: null };
      return { stats: store.getStats() };
    });

    // ── Phase 86: Stateless JWT Auth (Challenge-Response) ──────────────

    // POST /auth/challenge — Issue a signed challenge token (stateless, no in-memory store)
    this.fastify.post('/auth/challenge', async (request: any, reply: any) => {
      const { peerId } = (request.body || {}) as { peerId?: string };
      if (!peerId || typeof peerId !== 'string') {
        return reply.code(400).send({ error: 'peerId is required' });
      }

      const identity = this.node.getIdentity();
      if (!identity) {
        return reply.code(503).send({ error: 'Node identity not available' });
      }

      const nonce = randomBytes(32).toString('hex');
      const challengePayload = {
        nonce,
        sub: peerId,
        iss: identity.peerId,
        exp: Date.now() + 60_000, // 60-second TTL
        typ: 'challenge',
      };

      const payloadB64 = Buffer.from(JSON.stringify(challengePayload)).toString('base64url');
      const payloadBytes = new TextEncoder().encode(payloadB64);

      const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
      const pk = privateKeyFromProtobuf(identity.privateKey);
      const sig = await pk.sign(payloadBytes);
      const signatureHex = uint8ArrayToString(sig, 'base16');

      const challengeToken = payloadB64 + '.' + signatureHex;
      return { challengeToken, nonce, expiresAt: challengePayload.exp };
    });

    // POST /auth/verify — Verify a signed challenge + user signature, issue JWT
    // Fully stateless: challenge token is self-verifying, can hit ANY node
    this.fastify.post('/auth/verify', async (request: any, reply: any) => {
      const { peerId, challengeToken, signature } = (request.body || {}) as {
        peerId?: string;
        challengeToken?: string;
        signature?: string;
      };

      if (!peerId || !challengeToken || !signature) {
        return reply.code(400).send({ error: 'peerId, challengeToken, and signature are required' });
      }

      // 1. Parse and verify the challenge token
      const dotIdx = challengeToken.indexOf('.');
      if (dotIdx === -1) return reply.code(400).send({ error: 'Invalid challenge token format' });

      const cPayloadB64 = challengeToken.substring(0, dotIdx);
      const cSigHex = challengeToken.substring(dotIdx + 1);

      let challengePayload: any;
      try {
        challengePayload = JSON.parse(Buffer.from(cPayloadB64, 'base64url').toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'Invalid challenge token payload' });
      }

      if (!challengePayload.exp || challengePayload.exp <= Date.now()) {
        return reply.code(401).send({ error: 'Challenge expired' });
      }
      if (challengePayload.typ !== 'challenge') {
        return reply.code(400).send({ error: 'Invalid token type' });
      }
      if (challengePayload.sub !== peerId) {
        return reply.code(401).send({ error: 'Challenge was issued for a different peerId' });
      }

      // Verify challenge token signature — extract issuer's public key from peerId
      // (Ed25519 peerIds embed the full public key, no ledger lookup needed)
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const issuerPeerIdObj = peerIdFromString(challengePayload.iss);
        const issuerPubKey = issuerPeerIdObj.publicKey;
        if (!issuerPubKey) {
          return reply.code(401).send({ error: 'Cannot extract public key from challenge issuer peerId' });
        }

        const cPayloadBytes = new TextEncoder().encode(cPayloadB64);
        const cSigBytes = uint8ArrayFromString(cSigHex, 'base16');
        const challengeValid = await issuerPubKey.verify(cPayloadBytes, cSigBytes);
        if (!challengeValid) {
          return reply.code(401).send({ error: 'Challenge token signature invalid' });
        }
      } catch (err: any) {
        return reply.code(401).send({ error: 'Challenge verification error', detail: err?.message });
      }

      // 2. Verify the user's signature over the nonce
      // Extract user's public key from their peerId (Ed25519 peerIds embed the full public key)
      try {
        const { peerIdFromString } = await import('@libp2p/peer-id');
        const userPeerIdObj = peerIdFromString(peerId);
        const userPubKey = userPeerIdObj.publicKey;
        if (!userPubKey) {
          return reply.code(401).send({ error: 'Cannot extract public key from user peerId' });
        }

        const nonceBytes = uint8ArrayFromString(challengePayload.nonce, 'base16');
        const sigBytes = uint8ArrayFromString(signature, 'base16');
        const userValid = await userPubKey.verify(nonceBytes, sigBytes);
        if (!userValid) {
          return reply.code(401).send({ error: 'Signature verification failed' });
        }
      } catch (err: any) {
        return reply.code(401).send({ error: 'Signature verification error', detail: err?.message });
      }

      // 3. Issue a JWT signed by THIS node
      const jwt = await this.issueJwt(peerId);
      return jwt;
    });

    // ── Project Economy (Phase 31.1) ─────────────────────────────────────

    // GET /projects — List user's projects (owned + collaborating)
    this.fastify.get('/projects', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (userId) {
        const owned = await ps.getProjectsByOwnerAsync(userId);
        const collab = await ps.getProjectsByCollaboratorAsync(userId);
        return { projects: [...owned, ...collab] };
      }

      // No valid user token — return listed/featured public projects
      const query = request.query as any;
      const projects = await ps.listProjectsAsync({
        visibility: query.visibility || 'listed',
        status: 'active',
        limit: parseInt(query.limit) || 50,
        offset: parseInt(query.offset) || 0,
      });
      return { projects };
    });

    // GET /projects/stats — Public project statistics
    this.fastify.get('/projects/stats', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });
      return { stats: await ps.getStatsAsync() };
    });

    // GET /projects/:id — Get project detail
    this.fastify.get('/projects/:id', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Check access
      const userId = await this.verifyUserJwt(request);

      // Public projects are visible to all; private projects require access
      if (project.type !== 'public' && project.visibility === 'owner_only') {
        if (!userId || !(await ps.hasAccessAsync(id, userId))) {
          return reply.code(403).send({ error: 'Access denied' });
        }
      }

      const collaborators = await ps.getCollaboratorsAsync(id);
      return { project, collaborators };
    });

    // POST /projects — Create a new project
    // Auth: user session token OR node Bearer token (Phase 66: agents can create projects)
    this.fastify.post('/projects', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Phase 66: dual-auth — user session OR node Bearer token (same pattern as /projects/:id/resources/assign)
      let ownerId = await this.verifyUserJwt(request);
      if (!ownerId) {
        const authHeader = request.headers?.authorization || '';
        const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === this.apiToken;
        if (hasBearerToken) {
          ownerId = this.node.getIdentity()?.peerId || '';
        }
        if (!ownerId) return reply.code(401).send({ error: 'Authentication required (user session or Bearer token)' });
      }

      const body = (request.body || {}) as {
        name?: string;
        description?: string;
        type?: string;
        visibility?: string;
        budgetLimit?: number;
        tier?: number;
      };

      if (!body.name || body.name.trim().length === 0) {
        return reply.code(400).send({ error: 'Project name is required' });
      }

      const project = await ps.createProject({
        name: body.name.trim(),
        description: body.description || '',
        ownerId,
        type: (body.type as any) || 'private',
        visibility: (body.visibility as any) || 'owner_only',
        budgetLimit: body.budgetLimit || 0,
        ...(body.tier ? { tier: body.tier as 1 | 2 } : {}),
      });

      return reply.code(201).send({ project });
    });

    // PATCH /projects/:id — Update project (owner/admin only)
    this.fastify.patch('/projects/:id', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can update project' });
      }

      const body = (request.body || {}) as {
        name?: string;
        description?: string;
        type?: string;
        visibility?: string;
        budgetLimit?: number;
        tier?: number;
      };

      const updates: any = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.type !== undefined) updates.type = body.type;
      if (body.visibility !== undefined) updates.visibility = body.visibility;
      if (body.budgetLimit !== undefined) updates.budgetLimit = body.budgetLimit;
      if (body.tier !== undefined) updates.tier = body.tier;

      const project = await ps.updateProject(id, updates);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      return { project };
    });

    // POST /projects/:id/collaborators — Add collaborator (owner/admin only)
    this.fastify.post('/projects/:id/collaborators', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can add collaborators' });
      }

      const body = (request.body || {}) as { userId?: string; role?: string };
      if (!body.userId) {
        return reply.code(400).send({ error: 'userId is required' });
      }

      const collabRole = (body.role || 'collaborator') as any;
      const validRoles = ['admin', 'collaborator', 'viewer', 'qa_lead'];
      if (!validRoles.includes(collabRole)) {
        return reply.code(400).send({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
      }

      await ps.addCollaborator(id, body.userId, collabRole, userId);
      return { success: true };
    });

    // DELETE /projects/:id/collaborators/:userId — Remove collaborator (owner/admin only)
    this.fastify.delete('/projects/:id/collaborators/:userId', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const authUserId = await this.verifyUserJwt(request);
      if (!authUserId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id, userId: targetUserId } = request.params as { id: string; userId: string };
      const role = await ps.getUserRoleAsync(id, authUserId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can remove collaborators' });
      }

      // Cannot remove the owner
      const project = await ps.getProjectAsync(id);
      if (project && targetUserId === project.ownerId) {
        return reply.code(400).send({ error: 'Cannot remove the project owner' });
      }

      await ps.removeCollaborator(id, targetUserId);
      return { success: true };
    });

    // GET /projects/:id/collaborators — List collaborators
    this.fastify.get('/projects/:id/collaborators', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const collaborators = await ps.getCollaboratorsAsync(id);
      return { collaborators };
    });

    // ── Phase 31.5: Collaboration Enhancement (Invites) ──────────────────

    // POST /projects/:id/invite — Generate an invite link/code (owner/admin only)
    this.fastify.post('/projects/:id/invite', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can create invites' });
      }

      const body = (request.body || {}) as {
        role?: string;
        expiresInHours?: number;
        maxUses?: number;
      };

      const inviteRole = (body.role || 'collaborator') as any;
      const validRoles = ['admin', 'collaborator', 'viewer', 'qa_lead'];
      if (!validRoles.includes(inviteRole)) {
        return reply.code(400).send({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
      }

      const invite = await ps.createInvite(id, inviteRole, userId, {
        expiresInHours: body.expiresInHours,
        maxUses: body.maxUses,
      });

      return reply.code(201).send({ invite });
    });

    // POST /projects/join/:code — Join a project via invite code
    this.fastify.post('/projects/join/:code', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { code } = request.params as { code: string };
      const result = await ps.useInvite(code, userId);

      if (!result.success) {
        return reply.code(400).send({ error: result.error });
      }

      return { success: true, projectId: result.projectId, role: result.role };
    });

    // GET /projects/:id/invites — List active invites (owner/admin only)
    this.fastify.get('/projects/:id/invites', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can view invites' });
      }

      const invites = await ps.getProjectInvitesAsync(id);
      return { invites };
    });

    // DELETE /projects/:id/invites/:inviteId — Revoke an invite (owner/admin only)
    this.fastify.delete('/projects/:id/invites/:inviteId', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id, inviteId } = request.params as { id: string; inviteId: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can revoke invites' });
      }

      const success = await ps.revokeInvite(inviteId);
      if (!success) return reply.code(404).send({ error: 'Invite not found' });

      return { success: true };
    });

    // ── Phase 31.6: Ownership Transfer ───────────────────────────────────

    // POST /projects/:id/transfer — Initiate ownership transfer (owner only)
    this.fastify.post('/projects/:id/transfer', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (role !== 'owner') {
        return reply.code(403).send({ error: 'Only the project owner can initiate a transfer' });
      }

      const body = (request.body || {}) as {
        toUserId?: string;
        type?: string;
        salePrice?: number;
      };

      if (!body.toUserId) {
        return reply.code(400).send({ error: 'toUserId is required' });
      }

      const transferType = (body.type || 'direct') as any;
      const validTypes = ['direct', 'sale', 'network'];
      if (!validTypes.includes(transferType)) {
        return reply.code(400).send({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
      }

      // For direct transfers, validate the target user exists
      if (transferType === 'direct') {
        const accountStore = this.node.getUserAccountStore();
        const targetUser = accountStore ? await accountStore.getIdentityByPeerId(body.toUserId) : null;
        if (!targetUser) {
          return reply.code(404).send({ error: 'Target user not found' });
        }
      }

      // For sales, create an escrow hold if PaymentGate is available
      let escrowHoldId = '';
      if (transferType === 'sale' && body.salePrice && body.salePrice > 0) {
        const paymentGate = this.node.getPaymentGate();
        if (paymentGate) {
          const hold = paymentGate.holdPayment(body.toUserId, `transfer-${id}`, body.salePrice);
          if (!hold) {
            return reply.code(402).send({ error: 'Buyer has insufficient Lux balance for this sale' });
          }
          escrowHoldId = hold.holdId;
        }
      }

      const transfer = await ps.initiateTransfer(
        id,
        userId,
        body.toUserId,
        transferType,
        body.salePrice,
        escrowHoldId,
      );

      return reply.code(201).send({ transfer });
    });

    // POST /projects/transfers/:id/complete — Complete a transfer (buyer confirms for sales)
    this.fastify.post('/projects/transfers/:id/complete', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id: transferId } = request.params as { id: string };
      const transfer = await ps.getTransferAsync(transferId);
      if (!transfer) return reply.code(404).send({ error: 'Transfer not found' });

      // For sales, only the buyer (toUser) can complete; for direct, either party
      if (transfer.transferType === 'sale') {
        if (userId !== transfer.toUser) {
          return reply.code(403).send({ error: 'Only the buyer can confirm a sale transfer' });
        }
      } else {
        if (userId !== transfer.fromUser && userId !== transfer.toUser) {
          return reply.code(403).send({ error: 'Only the sender or recipient can complete this transfer' });
        }
      }

      // Release escrow if this was a sale
      if (transfer.escrowHoldId) {
        const paymentGate = this.node.getPaymentGate();
        if (paymentGate) {
          paymentGate.releasePayment(transfer.escrowHoldId, transfer.fromUser);
        }
      }

      const completed = await ps.completeTransfer(transferId);
      if (!completed) return reply.code(400).send({ error: 'Transfer cannot be completed (not pending)' });

      return { transfer: completed };
    });

    // POST /projects/transfers/:id/cancel — Cancel a transfer
    this.fastify.post('/projects/transfers/:id/cancel', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id: transferId } = request.params as { id: string };
      const transfer = await ps.getTransferAsync(transferId);
      if (!transfer) return reply.code(404).send({ error: 'Transfer not found' });

      // Only the initiator (fromUser) can cancel
      if (userId !== transfer.fromUser) {
        return reply.code(403).send({ error: 'Only the transfer initiator can cancel' });
      }

      // Refund escrow if this was a sale
      if (transfer.escrowHoldId) {
        const paymentGate = this.node.getPaymentGate();
        if (paymentGate) {
          paymentGate.refundPayment(transfer.escrowHoldId);
        }
      }

      const cancelled = await ps.cancelTransfer(transferId);
      if (!cancelled) return reply.code(400).send({ error: 'Transfer cannot be cancelled (not pending)' });

      return { transfer: cancelled };
    });

    // GET /projects/:id/transfers — Transfer history
    this.fastify.get('/projects/:id/transfers', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const transfers = await ps.getProjectTransfersAsync(id);
      return { transfers };
    });

    // ── Phase 31.4: Revenue Engine Routes ────────────────────────────────

    // GET /projects/:id/revenue — Revenue summary
    this.fastify.get('/projects/:id/revenue', async (request: any, reply: any) => {
      const engine = this.node.getRevenueEngine();
      if (!engine) return reply.code(503).send({ error: 'Revenue engine not available' });

      const { id } = request.params as { id: string };
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const summary = await engine.getRevenueSummaryAsync(id);
      return { summary };
    });

    // GET /projects/:id/revenue/history — Revenue event history
    this.fastify.get('/projects/:id/revenue/history', async (request: any, reply: any) => {
      const engine = this.node.getRevenueEngine();
      if (!engine) return reply.code(503).send({ error: 'Revenue engine not available' });

      const { id } = request.params as { id: string };
      const query = request.query as any;

      const records = await engine.getProjectRevenueAsync(id, {
        since: query.since ? parseInt(query.since) : undefined,
        until: query.until ? parseInt(query.until) : undefined,
      });
      return { records };
    });

    // POST /projects/:id/revenue/distribute — Trigger revenue distribution (owner/admin only)
    this.fastify.post('/projects/:id/revenue/distribute', async (request: any, reply: any) => {
      const engine = this.node.getRevenueEngine();
      if (!engine) return reply.code(503).send({ error: 'Revenue engine not available' });

      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can distribute revenue' });
      }

      const result = await engine.distributeRevenue(id, ps);
      return { result };
    });

    // GET /projects/:id/revenue/distributions — Distribution history
    this.fastify.get('/projects/:id/revenue/distributions', async (request: any, reply: any) => {
      const engine = this.node.getRevenueEngine();
      if (!engine) return reply.code(503).send({ error: 'Revenue engine not available' });

      const { id } = request.params as { id: string };
      const distributions = await engine.getDistributionHistoryAsync(id);
      return { distributions };
    });

    // ── Phase 31.7: Deployment Automation ─────────────────────────────────
    // NOTE: POST /projects/:id/deploy moved to Phase 70 unified deploy section (near preflight).
    // Old endpoint created a deployment record — new endpoint actually deploys.

    // GET /projects/:id/deployments — List deployment history
    this.fastify.get('/projects/:id/deployments', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const deployments = await ps.getDeploymentsAsync(id);
      return { deployments };
    });

    // POST /projects/:id/deployments/:deployId/status — Update deployment status (for agents)
    this.fastify.post('/projects/:id/deployments/:deployId/status', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id, deployId } = request.params as { id: string; deployId: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can update deployment status' });
      }

      const body = (request.body || {}) as {
        status?: string;
        url?: string;
        error?: string;
      };

      if (!body.status) {
        return reply.code(400).send({ error: 'status is required' });
      }

      const validStatuses = ['pending', 'deploying', 'live', 'failed', 'rolled_back'];
      if (!validStatuses.includes(body.status)) {
        return reply.code(400).send({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      }

      await ps.updateDeploymentStatus(deployId, body.status as any, body.url, body.error);
      return { success: true };
    });

    // ── Phase 31.8: Project Marketplace ───────────────────────────────────

    // GET /marketplace — Public marketplace listing
    this.fastify.get('/marketplace', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const query = request.query as any;
      const result = await ps.getMarketplaceAsync({
        category: query.category || undefined,
        sortBy: query.sort || undefined,
        search: query.search || undefined,
        limit: query.limit ? parseInt(query.limit) : undefined,
        offset: query.offset ? parseInt(query.offset) : undefined,
      });

      return result;
    });

    // GET /marketplace/:id — Public project detail (only if listed/featured)
    this.fastify.get('/marketplace/:id', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      if (project.visibility !== 'listed' && project.visibility !== 'featured') {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const collaborators = await ps.getCollaboratorsAsync(id);
      const ratingsSummary = await ps.getProjectRatingsAsync(id);
      return { project, collaborators, ratings: ratingsSummary };
    });

    // POST /projects/:id/rate — Rate a project (user token required)
    this.fastify.post('/projects/:id/rate', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const body = (request.body || {}) as { rating?: number; review?: string };
      if (!body.rating || !Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
        return reply.code(400).send({ error: 'Rating must be an integer between 1 and 5' });
      }

      await ps.rateProject(id, userId, body.rating, body.review);
      return { success: true };
    });

    // GET /projects/:id/ratings — Get ratings for a project
    this.fastify.get('/projects/:id/ratings', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const ratingsSummary = await ps.getProjectRatingsAsync(id);
      return ratingsSummary;
    });

    // ── Phase 31.9: Contribution Tracking ─────────────────────────────────

    // GET /projects/:id/contributions — List contributions
    this.fastify.get('/projects/:id/contributions', async (request: any, reply: any) => {
      const tracker = this.node.getContributionTracker();
      if (!tracker) return reply.code(503).send({ error: 'Contribution tracker not available' });

      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const query = request.query as any;
      const contributions = await tracker.getContributionsAsync(id, {
        userId: query.userId || undefined,
        verified: query.verified !== undefined ? query.verified === 'true' : undefined,
      });

      return { contributions };
    });

    // POST /projects/:id/contributions — Record a contribution (owner/admin/collaborator)
    this.fastify.post('/projects/:id/contributions', async (request: any, reply: any) => {
      const tracker = this.node.getContributionTracker();
      if (!tracker) return reply.code(503).send({ error: 'Contribution tracker not available' });

      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role) {
        return reply.code(403).send({ error: 'Must be a project collaborator to record contributions' });
      }

      const body = (request.body || {}) as {
        type?: string;
        description?: string;
        weight?: number;
        agentId?: string;
        userId?: string;
      };

      if (!body.type) {
        return reply.code(400).send({ error: 'Contribution type is required' });
      }

      const validTypes = ['code', 'review', 'test', 'design', 'management', 'documentation'];
      if (!validTypes.includes(body.type)) {
        return reply.code(400).send({ error: `Invalid type. Must be one of: ${validTypes.join(', ')}` });
      }

      // Allow owner/admin to record contributions on behalf of other users
      const contributorId = (role === 'owner' || role === 'admin') && body.userId ? body.userId : userId;

      const contribution = await tracker.recordContribution(
        id,
        contributorId,
        body.type as any,
        body.description,
        body.weight,
        body.agentId,
      );

      return reply.code(201).send({ contribution });
    });

    // POST /projects/:id/contributions/:contribId/verify — Verify (owner/admin only)
    this.fastify.post('/projects/:id/contributions/:contribId/verify', async (request: any, reply: any) => {
      const tracker = this.node.getContributionTracker();
      if (!tracker) return reply.code(503).send({ error: 'Contribution tracker not available' });

      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id, contribId } = request.params as { id: string; contribId: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can verify contributions' });
      }

      await tracker.verifyContribution(contribId, userId);
      return { success: true };
    });

    // GET /projects/:id/contributions/scores — Get contribution scores
    this.fastify.get('/projects/:id/contributions/scores', async (request: any, reply: any) => {
      const tracker = this.node.getContributionTracker();
      if (!tracker) return reply.code(503).send({ error: 'Contribution tracker not available' });

      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const query = request.query as any;
      // Optionally recalculate scores
      if (query.recalculate === 'true') {
        await tracker.calculateScores(id);
      }

      const scores = await tracker.getScoresAsync(id);
      const shares = await tracker.getRevenueSharesAsync(id);
      return { scores, shares };
    });

    // ── Phase 31.10: Content Safety — Reporting ────────────────────────────

    // In-memory rate limiter for reports: max 3 per user per hour
    const reportRateMap = new Map<string, number[]>();

    const checkReportRateLimit = (userId: string): boolean => {
      const now = Date.now();
      const windowMs = 60 * 60 * 1000; // 1 hour
      const maxReports = 3;
      const cutoff = now - windowMs;

      let timestamps = reportRateMap.get(userId);
      if (!timestamps) {
        timestamps = [];
        reportRateMap.set(userId, timestamps);
      }
      // Prune old entries
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length >= maxReports) {
        return false;
      }
      timestamps.push(now);
      return true;
    };

    // Periodic cleanup for report rate limiter (every 10 minutes)
    setInterval(() => {
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const [key, timestamps] of reportRateMap) {
        while (timestamps.length > 0 && timestamps[0] <= cutoff) {
          timestamps.shift();
        }
        if (timestamps.length === 0) {
          reportRateMap.delete(key);
        }
      }
    }, 10 * 60 * 1000);

    // POST /projects/:id/report — Report a project (user token required)
    this.fastify.post('/projects/:id/report', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Rate limit: max 3 reports per user per hour
      if (!checkReportRateLimit(userId)) {
        return reply.code(429).send({ error: 'Rate limit exceeded: max 3 reports per hour' });
      }

      const body = (request.body || {}) as { reason?: string; description?: string };
      const validReasons = ['spam', 'malicious', 'inappropriate', 'copyright', 'other'];
      if (!body.reason || !validReasons.includes(body.reason)) {
        return reply.code(400).send({ error: `Reason must be one of: ${validReasons.join(', ')}` });
      }

      const report = await ps.createReport(id, userId, body.reason as any, body.description);
      return reply.code(201).send({ report });
    });

    // GET /projects/:id/reports — List reports for a project (owner/admin only)
    this.fastify.get('/projects/:id/reports', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only project owner or admin can view reports' });
      }

      const query = request.query as any;
      const reports = await ps.getProjectReportsAsync(id, {
        status: query.status || undefined,
      });
      return { reports };
    });

    // GET /admin/reports — List all pending reports (admin/node token only)
    this.fastify.get('/admin/reports', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Require node-level API token for admin endpoints
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== this.apiToken) {
        return reply.code(403).send({ error: 'Admin access required (node API token)' });
      }

      const query = request.query as any;
      const limit = parseInt(query.limit) || 50;
      const reports = await ps.getPendingReportsAsync(limit);
      return { reports };
    });

    // POST /admin/reports/:id/review — Update report status (admin/node token only)
    this.fastify.post('/admin/reports/:id/review', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Require node-level API token for admin endpoints
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== this.apiToken) {
        return reply.code(403).send({ error: 'Admin access required (node API token)' });
      }

      const { id } = request.params as { id: string };
      const report = await ps.getReportAsync(id);
      if (!report) return reply.code(404).send({ error: 'Report not found' });

      const body = (request.body || {}) as { status?: string; action?: string };
      const validStatuses = ['pending', 'reviewing', 'resolved', 'dismissed'];
      if (!body.status || !validStatuses.includes(body.status)) {
        return reply.code(400).send({ error: `Status must be one of: ${validStatuses.join(', ')}` });
      }

      if (body.status === 'dismissed') {
        await ps.dismissReport(id, 'admin');
      } else if (body.status === 'resolved') {
        const validActions = ['archive', 'delist', 'none'];
        const action = body.action || 'none';
        if (!validActions.includes(action)) {
          return reply.code(400).send({ error: `Action must be one of: ${validActions.join(', ')}` });
        }
        await ps.resolveReport(id, 'admin', action as any);
      } else {
        await ps.updateReportStatus(id, body.status as any, 'admin');
      }

      const updated = await ps.getReportAsync(id);
      return { report: updated };
    });

    // GET /admin/reports/stats — Report statistics (admin/node token only)
    this.fastify.get('/admin/reports/stats', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Require node-level API token for admin endpoints
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.slice(7) !== this.apiToken) {
        return reply.code(403).send({ error: 'Admin access required (node API token)' });
      }

      const stats = await ps.getReportStatsAsync();
      return { stats };
    });

    // ── Phase 32: S3 Hosting ──────────────────────────────────────────────

    // POST /projects/:id/hosting — Deploy project files to S3
    this.fastify.post('/projects/:id/hosting', async (request: any, reply: any) => {
      const hosting = this.node.getHostingService();
      if (!hosting) return reply.code(503).send({ error: 'Hosting service not available' });

      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can deploy' });
      }

      // Expect JSON body: { files: [{ path, content (base64), contentType }] }
      const body = (request.body || {}) as {
        files?: { path: string; content: string; contentType: string }[];
      };

      if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
        return reply.code(400).send({ error: 'files array is required (each entry: { path, content (base64), contentType })' });
      }

      const deployFiles: DeployFile[] = [];
      for (const f of body.files) {
        if (!f.path || !f.content || !f.contentType) {
          return reply.code(400).send({ error: 'Each file must have path, content (base64), and contentType' });
        }
        deployFiles.push({
          path: f.path,
          content: Buffer.from(f.content, 'base64'),
          contentType: f.contentType,
        });
      }

      // Phase 65: Inject gateway URL, project ID, and API key into HTML files
      // Same injection that agent-manager does, but for direct hosting deploys
      const gatewayUrl = process.env.GATEWAY_PUBLIC_URL || process.env.GATEWAY_URL || '';
      let projectApiKey = '';
      // ProjectRegistry only stores apiKeyHash — get plaintext from ProjectStore (MongoDB)
      try {
        const proj = await ps.getProjectAsync(id);
        if (proj?.apiKey) projectApiKey = proj.apiKey;
      } catch { /* best-effort */ }
      const injVars = [
        `window.PANDO_GATEWAY_URL="${gatewayUrl}"`,
        `window.PANDO_PROJECT_ID="${id}"`,
      ];
      if (projectApiKey) injVars.push(`window.PANDO_PROJECT_API_KEY="${projectApiKey}"`);
      const injScript = `<script>${injVars.join(';')};</script>`;
      for (const file of deployFiles) {
        if (file.path.endsWith('.html')) {
          let html = file.content.toString('utf-8');
          if (html.includes('<head>')) {
            html = html.replace('<head>', '<head>' + injScript);
          } else if (html.includes('<head ')) {
            html = html.replace(/<head\s[^>]*>/, (m: string) => m + injScript);
          } else {
            html = injScript + html;
          }
          file.content = Buffer.from(html, 'utf-8');
        }
      }

      try {
        const info = await hosting.deployProject(id, project.type, deployFiles);
        // For public projects the URL is immediate; for private we generate a pre-signed URL
        if (project.type !== 'public') {
          info.url = await hosting.getHostedUrl(id, project.type);
        }

        // Auto-publish: set project visibility to 'listed' so it appears in the marketplace
        try {
          await ps.updateProject(id, {
            visibility: 'listed',
            deploymentUrl: info.url,
            deploymentStatus: 'deployed',
          });
          console.log(`[hosting] Auto-published project ${id} to marketplace after deploy`);
        } catch (pubErr: any) {
          console.warn(`[hosting] Failed to auto-publish project ${id}: ${pubErr.message}`);
        }

        return reply.code(201).send({ deployment: info });
      } catch (err: any) {
        console.error(`[hosting] Deploy failed for project ${id}:`, err.message);
        return reply.code(500).send({ error: 'Deployment failed', detail: err.message });
      }
    });

    // GET /projects/:id/hosting — Get deployment info + URL
    this.fastify.get('/projects/:id/hosting', async (request: any, reply: any) => {
      const hosting = this.node.getHostingService();
      if (!hosting) return reply.code(503).send({ error: 'Hosting service not available' });

      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Private projects require user auth to view deployment info
      if (project.type !== 'public') {
        const userId = await this.verifyUserJwt(request);
        if (!userId || !(await ps.hasAccessAsync(id, userId))) {
          return reply.code(403).send({ error: 'Access denied' });
        }
      }

      try {
        const info = await hosting.getDeploymentInfo(id);
        if (info.deployed && project.type !== 'public') {
          info.url = await hosting.getHostedUrl(id, project.type);
        }
        return { deployment: info };
      } catch (err: any) {
        console.error(`[hosting] Info failed for project ${id}:`, err.message);
        return reply.code(500).send({ error: 'Failed to get deployment info', detail: err.message });
      }
    });

    // DELETE /projects/:id/hosting — Remove deployment
    this.fastify.delete('/projects/:id/hosting', async (request: any, reply: any) => {
      const hosting = this.node.getHostingService();
      if (!hosting) return reply.code(503).send({ error: 'Hosting service not available' });

      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can remove deployments' });
      }

      try {
        await hosting.removeDeployment(id);
        return { removed: true, projectId: id };
      } catch (err: any) {
        console.error(`[hosting] Remove failed for project ${id}:`, err.message);
        return reply.code(500).send({ error: 'Failed to remove deployment', detail: err.message });
      }
    });

    // ── Phase 53: Project Resource Assignment ──────────────────────────────

    // POST /projects/:id/resources/assign — Assign a resource to a project
    this.fastify.post('/projects/:id/resources/assign', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Allow access if: (1) user session owner/admin, or (2) node Bearer token + project owned by this node
      const userId = await this.verifyUserJwt(request);
      const nodeId = this.node.getIdentity()?.peerId;
      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === this.apiToken;
      const isNodeAdmin = !userId && hasBearerToken && project.ownerId === nodeId;

      if (userId) {
        const role = await ps.getUserRoleAsync(id, userId);
        if (!role || (role !== 'owner' && role !== 'admin')) {
          return reply.code(403).send({ error: 'Only owner or admin can assign resources' });
        }
      } else if (!isNodeAdmin) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const body = (request.body || {}) as { type?: string; resourceId?: string };
      if (!body.type || !body.resourceId) {
        return reply.code(400).send({ error: 'Missing required fields: type, resourceId' });
      }

      const validTypes = ['mongodb', 's3', 'github', 'compute'];
      if (!validTypes.includes(body.type)) {
        return reply.code(400).send({ error: `Invalid resource type. Must be one of: ${validTypes.join(', ')}` });
      }

      // Verify the resource exists in ResourceRegistry and is active
      const registry = this.node.getResourceRegistry();
      if (registry) {
        const resource = registry.getResource(body.resourceId);
        if (!resource) return reply.code(404).send({ error: 'Resource not found in ResourceRegistry' });
        if (resource.status !== 'active') return reply.code(400).send({ error: `Resource is not active (status: ${resource.status})` });
      }

      try {
        await ps.assignResource(id, { type: body.type, resourceId: body.resourceId });
        const resources = ps.getProjectResources(id);
        return { resources };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // DELETE /projects/:id/resources/:resourceId — Remove a resource assignment
    this.fastify.delete('/projects/:id/resources/:resourceId', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id, resourceId } = request.params as { id: string; resourceId: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Verify user is owner or admin
      const role = await ps.getUserRoleAsync(id, userId);
      if (!role || (role !== 'owner' && role !== 'admin')) {
        return reply.code(403).send({ error: 'Only owner or admin can remove resources' });
      }

      try {
        await ps.removeResource(id, resourceId);
        const resources = ps.getProjectResources(id);
        return { resources };
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });

    // GET /projects/:id/resources — Get all resources assigned to a project
    this.fastify.get('/projects/:id/resources', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Check access — owner, collaborator, or public
      const userId = await this.verifyUserJwt(request);
      let isOwner = false;

      if (userId) {
        const role = await ps.getUserRoleAsync(id, userId);
        if (role === 'owner') isOwner = true;
        if (!role && project.type !== 'public') {
          return reply.code(403).send({ error: 'Access denied' });
        }
      } else if (project.type !== 'public') {
        return reply.code(403).send({ error: 'Access denied' });
      }

      const resources = ps.getProjectResources(id);
      const result: Record<string, any> = { resources };

      // Only include apiKey if user is the owner
      if (isOwner && project.apiKey) {
        result.apiKey = project.apiKey;
      }

      return result;
    });

    // POST /projects/:id/api-key — Generate a project API key
    this.fastify.post('/projects/:id/api-key', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Allow access if: (1) user session owner, or (2) node Bearer token + project owned by this node
      const userId = await this.verifyUserJwt(request);
      const nodeId = this.node.getIdentity()?.peerId;
      // If Bearer auth passed the onRequest hook and no user token, this is a node-level request
      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === this.apiToken;
      const isNodeAdmin = !userId && hasBearerToken && project.ownerId === nodeId;

      if (userId) {
        const role = await ps.getUserRoleAsync(id, userId);
        if (role !== 'owner') {
          return reply.code(403).send({ error: 'Only project owner can generate API keys' });
        }
      } else if (!isNodeAdmin) {
        return reply.code(401).send({ error: 'Authentication required (user session or node API token for node-owned projects)' });
      }

      // Don't generate if one already exists — use regenerate endpoint instead
      if (project.apiKey) {
        return reply.code(409).send({ error: 'API key already exists. Use POST /projects/:id/api-key/regenerate to replace it.' });
      }

      try {
        const apiKey = await ps.generateApiKey(id);
        return { apiKey };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // POST /projects/:id/api-key/regenerate — Regenerate a project API key
    this.fastify.post('/projects/:id/api-key/regenerate', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const userId = await this.verifyUserJwt(request);
      if (!userId) return reply.code(401).send({ error: 'Invalid or expired session token' });

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Owner only
      const role = await ps.getUserRoleAsync(id, userId);
      if (role !== 'owner') {
        return reply.code(403).send({ error: 'Only project owner can regenerate API keys' });
      }

      try {
        const apiKey = await ps.generateApiKey(id);
        return { apiKey };
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    });

    // GET /projects/by-api-key/:key — Look up project by API key (node-internal, for Resource Proxy)
    this.fastify.get('/projects/by-api-key/:key', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const { key } = request.params as { key: string };
      if (!key || key.length < 32) {
        return reply.code(400).send({ error: 'Invalid API key' });
      }

      const project = ps.getProjectByApiKey(key);
      if (!project) return reply.code(404).send({ error: 'Project not found for this API key' });

      return { project };
    });

    // ── Phase 66: Preflight & Deploy Validation ──────────────────────────────

    // GET /projects/:id/preflight — check if project is ready for app deployment
    // POST /projects/:id/preflight — same check but auto-fixes what it can
    this.fastify.route({
      method: ['GET', 'POST'],
      url: '/projects/:id/preflight',
      handler: async (request: any, reply: any) => {
        const ps = this.node.getProjectStore();
        if (!ps) return reply.code(503).send({ error: 'Project store not available' });

        // Auth: user session OR node Bearer token
        let userId = await this.verifyUserJwt(request);
        const authHeader = request.headers?.authorization || '';
        const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === this.apiToken;
        if (!userId && !hasBearerToken) {
          return reply.code(401).send({ error: 'Authentication required' });
        }

        const { id } = request.params as { id: string };
        const autoFix = request.method === 'POST';

        // Check 1: Project exists
        let project: any = null;
        try { project = await ps.getProjectAsync(id); } catch (err: any) { console.log(`[preflight] Project lookup failed for ${id}: ${err.message}`); }
        const projectExists = !!project;

        // Check 2: API key exists
        let apiKeyExists = !!(project?.apiKey);
        const autoFixed: string[] = [];

        if (!apiKeyExists && autoFix && project) {
          // Auto-generate API key
          try {
            const { randomBytes: rb } = await import('node:crypto');
            const apiKey = rb(32).toString('hex');
            await ps.updateProject(id, { apiKey });
            project = await ps.getProjectAsync(id);
            apiKeyExists = true;
            autoFixed.push('Generated API key');

            // Sync to P2P ProjectRegistry
            const pr = this.node.getProjectRegistry?.();
            if (pr && project) {
              pr.registerProject(project.id, project.name, apiKey, project.ownerId, project.resources || []);
            }
          } catch {}
        }

        // Check 3: MongoDB assigned
        const resources = project ? (ps.getProjectResources(id) || []) : [];
        let mongodbAssigned = resources.some((r: any) => r.type === 'mongodb');

        if (!mongodbAssigned && autoFix && project) {
          // Auto-assign first available storage_db resource
          const registry = this.node.getResourceRegistry();
          if (registry) {
            const dbResources = registry.findResources('storage_db' as any);
            if (dbResources.length > 0) {
              try {
                await ps.assignResource(id, { type: 'mongodb', resourceId: dbResources[0].resourceId });
                mongodbAssigned = true;
                autoFixed.push(`Assigned MongoDB resource ${dbResources[0].resourceId}`);
              } catch {}
            }
          }
        }

        // Check 4: GitHub assigned (Phase 70: auto-assign code_repository)
        const currentResources = project ? (ps.getProjectResources(id) || []) : [];
        let githubAssigned = currentResources.some((r: any) => r.type === 'github');

        if (!githubAssigned && autoFix && project) {
          const registry2 = this.node.getResourceRegistry();
          if (registry2) {
            const codeResources = registry2.findResources('code_repository' as any);
            if (codeResources.length > 0) {
              try {
                await ps.assignResource(id, { type: 'github', resourceId: codeResources[0].resourceId });
                githubAssigned = true;
                autoFixed.push(`Assigned GitHub resource ${codeResources[0].resourceId}`);
              } catch {}
            }
          }
        }

        // Check 5: Gateway URL configured
        const gatewayUrl = process.env.GATEWAY_PUBLIC_URL || process.env.GATEWAY_URL || '';
        const gatewayReachable = gatewayUrl.length > 0;

        // Check 6: Resource Proxy available (gateway URL set = proxy available)
        const resourceProxyAvailable = gatewayReachable;

        const checks = { projectExists, apiKeyExists, mongodbAssigned, githubAssigned, gatewayReachable, resourceProxyAvailable };
        const ready = Object.values(checks).every(Boolean);
        const missing: string[] = [];
        if (!projectExists) missing.push('Project does not exist');
        if (!apiKeyExists) missing.push('No API key — POST /projects/:id/api-key or use preflight auto-fix');
        if (!mongodbAssigned) missing.push('No MongoDB resource assigned');
        if (!githubAssigned) missing.push('No GitHub resource assigned');
        if (!gatewayReachable) missing.push('GATEWAY_PUBLIC_URL not set on node');
        if (!resourceProxyAvailable) missing.push('Resource Proxy unavailable (no gateway URL)');

        return { ready, checks, missing, autoFixed };
      }
    });

    // ── Phase 70: GitHub Integration & Unified Deploy ──────────────────────

    // POST /projects/:id/github — Create a GitHub repo for the project
    this.fastify.post('/projects/:id/github', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === this.apiToken;
      const userId = await this.verifyUserJwt(request);
      if (!userId && !hasBearerToken) return reply.code(401).send({ error: 'Authentication required' });

      const { id } = request.params as { id: string };
      let project: any;
      try { project = await ps.getProjectAsync(id); } catch {}
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Already has a repo?
      if (project.githubRepo) {
        return { repoUrl: `https://github.com/${project.githubRepo}`, cloneUrl: `https://github.com/${project.githubRepo}.git`, existing: true };
      }

      // Get GitHub token from contributed code_repository resource
      const registry = this.node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'ResourceRegistry not available' });

      const githubResources = registry.findResources('code_repository' as any);
      if (!githubResources.length) return reply.code(503).send({ error: 'No code_repository resource contributed' });

      const githubToken = await registry.getCredential(githubResources[0].resourceId);
      if (!githubToken) return reply.code(503).send({ error: 'Could not decrypt GitHub credential' });

      const ghMeta = (githubResources[0] as any).metadata || {};
      const explicitOrg = ghMeta.org || 'pando-lux';
      const accountType = ghMeta.accountType || 'user'; // 'user' or 'org'
      const safeName = (project.name || id).replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40);
      const repoName = `app-${id.slice(0, 8)}-${safeName}`;

      // Create repo via GitHub API
      const apiHeaders: Record<string, string> = {
        'Authorization': `token ${githubToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      };

      // App repos are always public — EC2 needs unauthenticated clone access
      const repoBody = JSON.stringify({
        name: repoName,
        description: `Pando app: ${project.name || id}`,
        private: false,
        auto_init: true,
      });

      try {
        // Use /user/repos for user accounts, /orgs/{org}/repos for org accounts
        const createUrl = accountType === 'org'
          ? `https://api.github.com/orgs/${explicitOrg}/repos`
          : `https://api.github.com/user/repos`;
        console.log(`[github] Creating repo via ${accountType === 'org' ? 'org' : 'user'} endpoint: ${repoName}`);

        const createResp = await fetch(createUrl, {
          method: 'POST', headers: apiHeaders, body: repoBody,
          signal: AbortSignal.timeout(15000),
        });

        let fullRepoName = `${explicitOrg}/${repoName}`;
        if (createResp.status === 201) {
          const data = await createResp.json() as any;
          fullRepoName = data.full_name || fullRepoName;
          console.log(`[github] Created repo: ${fullRepoName}`);
        } else if (createResp.status === 422) {
          console.log(`[github] Repo already exists: ${fullRepoName}`);
        } else {
          const errText = await createResp.text();
          console.log(`[github] Repo create failed (${createResp.status}): ${errText}`);
          return reply.code(502).send({ error: `GitHub API error: ${createResp.status}`, details: errText });
        }

        // Update project record
        await ps.updateProject(id, { githubRepo: fullRepoName, repoUrl: `https://github.com/${fullRepoName}` });

        return {
          repoUrl: `https://github.com/${fullRepoName}`,
          cloneUrl: `https://github.com/${fullRepoName}.git`,
          githubRepo: fullRepoName,
        };
      } catch (err: any) {
        console.log(`[github] Create repo error: ${err.message}`);
        return reply.code(502).send({ error: err.message });
      }
    });

    // POST /projects/:id/github/push — Push workspace code to GitHub
    this.fastify.post('/projects/:id/github/push', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === this.apiToken;
      const userId = await this.verifyUserJwt(request);
      if (!userId && !hasBearerToken) return reply.code(401).send({ error: 'Authentication required' });

      const { id } = request.params as { id: string };
      const body = (request.body || {}) as { workspaceDir?: string };
      if (!body.workspaceDir) return reply.code(400).send({ error: 'workspaceDir required' });

      let project: any;
      try { project = await ps.getProjectAsync(id); } catch {}
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Ensure repo exists — create if needed
      if (!project.githubRepo) {
        try {
          const createUrl = `http://127.0.0.1:${(this.fastify.server.address() as any)?.port || 4000}/projects/${id}/github`;
          const createRes = await fetch(createUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(20000),
          });
          if (createRes.ok) {
            const data = await createRes.json() as any;
            project.githubRepo = data.githubRepo;
          } else {
            return reply.code(502).send({ error: 'Failed to create GitHub repo' });
          }
        } catch (err: any) {
          return reply.code(502).send({ error: `GitHub repo creation failed: ${err.message}` });
        }
      }

      // Get GitHub token
      const registry = this.node.getResourceRegistry();
      if (!registry) return reply.code(503).send({ error: 'ResourceRegistry not available' });
      const githubResources = registry.findResources('code_repository' as any);
      if (!githubResources.length) return reply.code(503).send({ error: 'No code_repository resource' });
      const githubToken = await registry.getCredential(githubResources[0].resourceId);
      if (!githubToken) return reply.code(503).send({ error: 'Could not decrypt GitHub credential' });

      const { execSync } = await import('node:child_process');
      const { existsSync: fsExists } = await import('node:fs');
      const workDir = body.workspaceDir;

      if (!fsExists(workDir)) return reply.code(400).send({ error: `Workspace not found: ${workDir}` });

      try {
        const pushUrl = `https://x-access-token:${githubToken}@github.com/${project.githubRepo}.git`;

        // Init git if needed
        if (!fsExists(`${workDir}/.git`)) {
          execSync('git init', { cwd: workDir, stdio: 'pipe' });
        }
        execSync('git config user.email "deploy@pando.network"', { cwd: workDir, stdio: 'pipe' });
        execSync('git config user.name "Pando Deploy"', { cwd: workDir, stdio: 'pipe' });
        execSync('git add -A', { cwd: workDir, stdio: 'pipe' });

        const commitMsg = `Deploy ${new Date().toISOString().slice(0, 19)}`;
        try { execSync(`git commit -m "${commitMsg}"`, { cwd: workDir, stdio: 'pipe' }); } catch {}

        try { execSync('git remote remove origin', { cwd: workDir, stdio: 'pipe' }); } catch {}
        execSync(`git remote add origin ${pushUrl}`, { cwd: workDir, stdio: 'pipe' });
        execSync('git push -u origin HEAD:main --force', { cwd: workDir, stdio: 'pipe', timeout: 30000 });

        const commitSha = execSync('git rev-parse HEAD', { cwd: workDir, encoding: 'utf-8' }).trim();
        console.log(`[github] Pushed to ${project.githubRepo} (${commitSha.slice(0, 8)})`);

        return {
          pushed: true,
          commitSha,
          repoUrl: `https://github.com/${project.githubRepo}`,
          githubRepo: project.githubRepo,
        };
      } catch (err: any) {
        console.log(`[github] Push failed: ${err.message}`);
        return reply.code(502).send({ error: `GitHub push failed: ${err.message}` });
      }
    });

    // POST /projects/:id/deploy — Unified deploy endpoint (Phase 70)
    // Pushes to GitHub, then P2P deploys to EC2 (both Tier 1 and Tier 2).
    // Manager calls this ONE endpoint. Node handles everything.
    this.fastify.post('/projects/:id/deploy', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === this.apiToken;
      const userId = await this.verifyUserJwt(request);
      if (!userId && !hasBearerToken) return reply.code(401).send({ error: 'Authentication required' });

      const { id } = request.params as { id: string };
      const body = (request.body || {}) as {
        workspaceDir?: string;
        type?: string;          // Legacy: 'vercel', 'github', 's3', 'custom'
        config?: Record<string, any>;
      };

      let project: any;
      try { project = await ps.getProjectAsync(id); } catch {}
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const tier = project.tier || 1;

      // Step 1: Push to GitHub (if workspace provided)
      let repoUrl = project.repoUrl || '';
      let githubRepo = project.githubRepo || '';
      if (body.workspaceDir) {
        try {
          const pushUrl = `http://127.0.0.1:${(this.fastify.server.address() as any)?.port || 4000}/projects/${id}/github/push`;
          const pushRes = await fetch(pushUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceDir: body.workspaceDir }),
            signal: AbortSignal.timeout(60000),
          });
          if (pushRes.ok) {
            const pushData = await pushRes.json() as any;
            repoUrl = pushData.repoUrl || repoUrl;
            githubRepo = pushData.githubRepo || githubRepo;
            console.log(`[deploy] GitHub push succeeded: ${repoUrl}`);
          } else {
            const errData = await pushRes.json().catch(() => ({})) as any;
            console.log(`[deploy] GitHub push failed: ${errData.error || pushRes.status}`);
            // Don't block deploy — GitHub push failure is non-fatal for Tier 1 if we have workspace
          }
        } catch (err: any) {
          console.log(`[deploy] GitHub push error: ${err.message}`);
        }
      }

      // Step 2: Deploy via P2P to EC2 instance
      const cloudManager = this.node.getCloudInstanceManager?.();
      const instances = cloudManager?.getInstances() || [];
      const running = instances.filter((i: any) => i.status === 'running' && i.peerId);

      if (running.length > 0 && repoUrl) {
        // Deploy via EC2 — both Tier 1 (S3 upload) and Tier 2 (app hosting)
        const instance = running[0]; // Use first available
        try {
          // Build env vars for injection
          const envVars: Record<string, string> = {};
          if (project.apiKey) {
            envVars.PROJECT_API_KEY = project.apiKey;
            const gatewayUrl = process.env.GATEWAY_PUBLIC_URL || process.env.GATEWAY_URL || '';
            if (gatewayUrl) envVars.RESOURCE_PROXY_URL = `${gatewayUrl}/api/resource-proxy/db`;
            envVars.PANDO_GATEWAY_URL = gatewayUrl;
            envVars.PANDO_PROJECT_ID = id;
            envVars.PANDO_PROJECT_API_KEY = project.apiKey;
          }

          // P2P deploy with tier info
          const requestReply = this.node.getRequestReply?.();
          if (!requestReply) return reply.code(503).send({ error: 'P2P RequestReply not available' });

          const deployPayload = {
            projectId: id,
            repoUrl,
            tier,
            envVars,
          };

          console.log(`[deploy] Sending P2P deploy to ${instance.instanceId} (${instance.peerId}) — tier ${tier}`);
          const response = await requestReply.request(instance.peerId!, 'pando/deploy-app', deployPayload, 300_000);

          if (response?.success && response.payload) {
            const payload = response.payload as any;
            // Check if EC2 handler reported failure
            if (payload.status === 'failed') {
              console.log(`[deploy] EC2 deploy failed: ${payload.error}`);
              return reply.code(502).send({ error: payload.error || 'Deploy failed on compute node' });
            }
            let liveUrl = '';
            let deploymentPort: number | undefined;

            if (tier === 2 && payload.port) {
              // Tier 2: Phase 80 — nginx reverse proxy URL (stable, port-free)
              deploymentPort = payload.port;
              liveUrl = `http://${instance.publicIp}/apps/${id}/`;
            } else if (payload.url) {
              // Tier 1: EC2 returns the S3 URL
              liveUrl = payload.url;
            } else if (payload.s3Url) {
              liveUrl = payload.s3Url;
            }

            // Update project record
            const update: Record<string, any> = {
              deploymentUrl: liveUrl,
              deploymentStatus: 'deployed',
              repoUrl,
              githubRepo,
              instanceId: instance.instanceId,
              updatedAt: Date.now(),
            };
            if (deploymentPort) update.deploymentPort = deploymentPort;
            if (tier) update.tier = tier;

            await ps.updateProject(id, update);

            // Sync to ProjectRegistry
            const pr = this.node.getProjectRegistry?.();
            if (pr) {
              pr.updateProject(id, {
                deploymentUrl: liveUrl,
                liveUrl,
                tier,
                deploymentPort,
                instanceId: instance.instanceId,
                lastDeployedAt: Date.now(),
                githubRepo,
              } as any);
            }

            console.log(`[deploy] Project ${id} deployed: ${liveUrl} (tier ${tier})`);
            return {
              url: liveUrl,
              tier,
              status: 'deployed',
              repoUrl,
              githubRepo,
              instanceId: instance.instanceId,
              port: deploymentPort,
            };
          } else {
            const errMsg = response?.payload?.error || 'Deploy failed';
            console.log(`[deploy] P2P deploy failed: ${errMsg}`);
            return reply.code(502).send({ error: errMsg });
          }
        } catch (err: any) {
          console.log(`[deploy] Deploy error: ${err.message}`);
          return reply.code(502).send({ error: err.message });
        }
      }

      return reply.code(503).send({
        error: 'No EC2 instance available for deployment',
        hint: 'Launch a compute instance first: POST /instances/launch',
        repoUrl,
        githubRepo,
      });
    });

    // Phase 80: POST /projects/:id/undeploy — stop and remove a deployed app
    this.fastify.post('/projects/:id/undeploy', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Auth: user session OR node Bearer token
      const userId = await this.verifyUserJwt(request);
      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === this.apiToken;
      if (!userId && !hasBearerToken) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      // Only owner or bearer token can undeploy
      if (!hasBearerToken && project.ownerId !== userId) {
        return reply.code(403).send({ error: 'Only the project owner can undeploy' });
      }

      const tier = (project as any).tier || 1;
      const deleteFiles = (request.body as any)?.deleteFiles !== false; // default true

      try {
        if (tier === 2 && (project as any).instanceId) {
          // Tier 2: Send P2P undeploy to compute node
          const requestReply = this.node.getRequestReply?.();
          const instances = this.node.getCloudInstanceManager?.()?.getInstances() || [];
          const instance = instances.find((i: any) => i.instanceId === (project as any).instanceId);

          if (instance?.peerId && requestReply) {
            const response = await requestReply.request(instance.peerId, 'pando/undeploy-app', {
              projectId: id,
              deleteFiles,
            }, 60_000);

            if (!response?.success || response.payload?.status === 'failed') {
              return reply.code(502).send({ error: response?.payload?.error || 'Undeploy failed on compute node' });
            }
          }
        } else if (tier === 1) {
          // Tier 1: Remove S3 files — only delete files under public/<projectId>/ prefix
          try {
            const resourceRegistry = this.node.getResourceRegistry?.();
            if (resourceRegistry) {
              const s3Resources = resourceRegistry.findResources('storage_blob' as any);
              if (s3Resources.length > 0) {
                const s3Cred = await resourceRegistry.getCredential(s3Resources[0].resourceId);
                if (s3Cred) {
                  const s3Config = JSON.parse(s3Cred);
                  const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
                  const s3 = new S3Client({
                    region: s3Config.region || 'us-east-1',
                    credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey },
                  });
                  const bucket = s3Config.bucket || 'pando-deployments';
                  const prefix = `public/${id}/`;

                  // List all objects under this project's prefix
                  const listResp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
                  if (listResp.Contents && listResp.Contents.length > 0) {
                    await s3.send(new DeleteObjectsCommand({
                      Bucket: bucket,
                      Delete: { Objects: listResp.Contents.map(obj => ({ Key: obj.Key! })) },
                    }));
                    console.log(`[undeploy] Deleted ${listResp.Contents.length} S3 objects under ${prefix}`);
                  }
                }
              }
            }
          } catch (s3Err: any) {
            console.log(`[undeploy] S3 cleanup failed: ${s3Err.message}`);
          }

          // Also remove local hosting if present
          const hosting = this.node.getHostingService?.();
          if (hosting) {
            try { (hosting as any).removeApp?.(id); } catch {}
          }
        }

        // Clear deployment fields in MongoDB
        await ps.updateProject(id, {
          deploymentUrl: '',
          deploymentStatus: 'none',
          deploymentPort: undefined as any,
          instanceId: undefined as any,
        });

        // Update P2P ProjectRegistry
        const pr = this.node.getProjectRegistry?.();
        if (pr) {
          pr.updateProject(id, {
            deploymentUrl: '',
            liveUrl: '',
            deploymentPort: undefined,
            instanceId: undefined,
          } as any);
        }

        console.log(`[undeploy] Project ${id} undeployed (tier ${tier})`);
        return { status: 'undeployed', projectId: id, tier };
      } catch (err: any) {
        console.log(`[undeploy] Error: ${err.message}`);
        return reply.code(500).send({ error: err.message });
      }
    });

    // POST /projects/:id/validate-deploy — lightweight deploy health check
    this.fastify.post('/projects/:id/validate-deploy', async (request: any, reply: any) => {
      const ps = this.node.getProjectStore();
      if (!ps) return reply.code(503).send({ error: 'Project store not available' });

      // Auth: user session OR node Bearer token
      const userId = await this.verifyUserJwt(request);
      const authHeader = request.headers?.authorization || '';
      const hasBearerToken = authHeader.startsWith('Bearer ') && authHeader.slice(7) === this.apiToken;
      if (!userId && !hasBearerToken) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const { id } = request.params as { id: string };
      const project = await ps.getProjectAsync(id);
      if (!project) return reply.code(404).send({ error: 'Project not found' });

      const hosting = this.node.getHostingService?.();
      const errors: string[] = [];

      // Always use the direct S3 website URL for validation — the stored deploymentUrl
      // may be a gateway proxy URL. Apps are deployed as 'public' to the S3 website endpoint.
      const s3Bucket = process.env.PANDO_S3_BUCKET || 'pando-deployments';
      const s3Region = 'us-east-1';
      let url = `http://${s3Bucket}.s3-website-${s3Region}.amazonaws.com/public/${id}/index.html`;
      // Fallback to stored URL if S3 URL doesn't work
      const fallbackUrl = project.deploymentUrl || '';

      // Check 1: URL responds
      let urlResponds = false;
      let htmlContent = '';
      if (url) {
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
          urlResponds = resp.ok;
          if (resp.ok) htmlContent = await resp.text();
          else errors.push(`URL returned ${resp.status}`);
        } catch (err: any) {
          errors.push(`URL fetch failed: ${err.message}`);
        }
      } else {
        errors.push('No deployment URL found');
      }

      // Check 2: Gateway URL injected
      const gatewayInjected = htmlContent.includes('PANDO_GATEWAY_URL');

      // Check 3: API key injected
      const apiKeyInjected = htmlContent.includes('PANDO_PROJECT_API_KEY');

      // Check 4: Resource Proxy responds (test with count on __preflight_test collection)
      let resourceProxyWorks = false;
      if (project.apiKey) {
        const gatewayUrl = process.env.GATEWAY_PUBLIC_URL || process.env.GATEWAY_URL || '';
        if (gatewayUrl) {
          try {
            const proxyResp = await fetch(`${gatewayUrl}/api/resource-proxy/db`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Project-Key': project.apiKey },
              body: JSON.stringify({ collection: 'pando_health', operation: 'count', filter: {} }),
              signal: AbortSignal.timeout(10000),
            });
            resourceProxyWorks = proxyResp.ok;
            if (!proxyResp.ok) errors.push(`Resource Proxy returned ${proxyResp.status}`);
          } catch (err: any) {
            errors.push(`Resource Proxy test failed: ${err.message}`);
          }
        }
      }

      if (!gatewayInjected && urlResponds) errors.push('PANDO_GATEWAY_URL not found in HTML');
      if (!apiKeyInjected && urlResponds) errors.push('PANDO_PROJECT_API_KEY not found in HTML');

      const checks = { urlResponds, gatewayInjected, apiKeyInjected, resourceProxyWorks };
      const healthy = Object.values(checks).every(Boolean);

      return { healthy, url, checks, errors };
    });

    // ── Phase 50: Council Endpoints ──────────────────────────────────────────

    // GET /council — returns council state (members, rotation, this node's membership)
    this.fastify.get('/council', async (_request: any, reply: any) => {
      const council = this.node.getCouncil();
      if (!council) {
        return reply.code(503).send({ error: 'Council system not initialized' });
      }
      return council.getCouncil();
    });

    // GET /council/minutes — returns recent council minutes text
    this.fastify.get('/council/minutes', async (_request: any, reply: any) => {
      const council = this.node.getCouncil();
      if (!council) {
        return reply.code(503).send({ error: 'Council system not initialized' });
      }
      return { minutes: council.getMinutes() };
    });

    // ── Phase 51: Infrastructure Awareness ──────────────────────────────────

    // GET /capabilities/infrastructure — what infrastructure agents/apps can use
    this.fastify.get('/capabilities/infrastructure', async () => {
      const network = this.node.getNetwork();
      const capabilities = this.node.getCapabilities();

      // Extract public-facing addresses from P2P listen addresses
      const listenAddrs = network?.getListenAddresses() || [];
      const ips = listenAddrs
        .map((a: string) => {
          const match = a.match(/\/ip4\/([\d.]+)\/tcp\/(\d+)/);
          return match ? { ip: match[1], port: match[2] } : null;
        })
        .filter((x: any) => x && x.ip !== '127.0.0.1');

      // Determine public URLs for this node and gateway
      const nodePublicUrl = process.env.PANDO_PUBLIC_URL
        || (ips.length > 0 ? `http://${ips[0]!.ip}:${this.node.getApiPort() || 4000}` : null);

      const gatewayPublicUrl = process.env.GATEWAY_PUBLIC_URL
        || process.env.GATEWAY_URL
        || null;

      return {
        hosting: {
          static: {
            available: true,
            type: 's3',
            deployEndpoint: 'POST /agents/:id/deploy',
            note: 'Deploy static web content (HTML/CSS/JS). Apps deploy to contributed hosting resources.',
          },
        },
        databases: {
          mongodb: {
            available: this.node.getStorageBackendType() === 'mongodb',
            note: 'User data storage via StorageBackend. Apps have their own backends with own database schemas.',
          },
          sqlite: { available: true, note: 'Local node storage. Used internally.' },
        },
        compute: {
          claudeCode: capabilities.includes('claude-code'),
          docker: capabilities.includes('docker'),
          python: capabilities.includes('python'),
          nodeJs: true,
        },
        apiKeys: this.getAvailableApiKeys(),
        gateway: {
          url: process.env.GATEWAY_URL || 'http://127.0.0.1:3222',
          note: 'Web UI directory. Apps have their own URLs after deployment.',
        },
        network: {
          peers: network?.getPeerCount() ?? 0,
          relayAvailable: true,
        },
        // Phase 53: Resource Proxy — project-scoped database access without credential exposure
        resourceProxy: {
          available: true,
          url: gatewayPublicUrl ? `${gatewayPublicUrl}/api/resource-proxy` : '/api/resource-proxy',
          auth: 'X-Project-Key header with project API key',
          operations: ['find', 'findOne', 'insertOne', 'insertMany', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'count'],
          note: 'Database access without exposing credentials. Get project API key via POST /projects/:id/api-key.',
        },
        // Public-facing URLs for zero-config app access
        nodePublicUrl,
        gatewayPublicUrl,
      };
    });

    // Phase 53.1: Legacy /apps/data routes, gateway mongodb.ts, S3 proxy all deleted. Apps have their own backends.

    // Phase 65: Deploy app to local hosted-apps directory
    this.fastify.post('/apps/:appName/deploy', async (request: any, reply: any) => {
      const authHeader = request.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== this.apiToken) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      const { appName } = request.params;
      const body = request.body as { files: Array<{ path: string; content: string }>; projectId?: string; apiKey?: string };
      if (!body?.files?.length) return reply.status(400).send({ error: 'files array required' });
      const { join } = await import('node:path');
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const dataDir = this.node.getDataDir?.() || join((await import('node:os')).homedir(), '.pando');
      const appDir = join(dataDir, 'hosted-apps', appName);
      mkdirSync(appDir, { recursive: true });
      for (const file of body.files) {
        const filePath = join(appDir, file.path);
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, file.content, 'utf-8');
      }
      // Write app config
      if (body.projectId || body.apiKey) {
        writeFileSync(join(appDir, '.pando-app.json'), JSON.stringify({
          projectId: body.projectId || '', apiKey: body.apiKey || '', deployedAt: Date.now()
        }));
      }
      return reply.send({ ok: true, appName, files: body.files.length, url: `/apps/${appName}/index.html` });
    });

    // Phase 65: Static app serving for compute instances
    // Serves HTML/JS/CSS from <data-dir>/hosted-apps/<appName>/
    // Injects PANDO_GATEWAY_URL, PROJECT_ID, PROJECT_API_KEY into HTML files
    this.fastify.get('/apps/:appName/*', async (request: any, reply: any) => {
      const { appName } = request.params;
      const filePath = (request.params as any)['*'] || 'index.html';
      const { join } = await import('node:path');
      const { readFileSync, existsSync } = await import('node:fs');
      const dataDir = this.node.getDataDir?.() || join((await import('node:os')).homedir(), '.pando');
      const fullPath = join(dataDir, 'hosted-apps', appName, filePath);

      // Security: prevent path traversal
      const hostedRoot = join(dataDir, 'hosted-apps', appName);
      const { resolve } = await import('node:path');
      if (!resolve(fullPath).startsWith(resolve(hostedRoot))) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      if (!existsSync(fullPath)) {
        return reply.status(404).send({ error: 'Not found' });
      }

      let content = readFileSync(fullPath);
      const ext = filePath.split('.').pop()?.toLowerCase() || '';

      // Set content type
      const mimeTypes: Record<string, string> = {
        html: 'text/html', css: 'text/css', js: 'application/javascript',
        json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
        svg: 'image/svg+xml', ico: 'image/x-icon',
      };
      reply.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      reply.header('Access-Control-Allow-Origin', '*');

      // Inject gateway vars into HTML
      if (ext === 'html') {
        let html = content.toString('utf-8');
        const gatewayUrl = process.env.GATEWAY_PUBLIC_URL || process.env.GATEWAY_URL || '';
        // Read app config for project binding
        const configPath = join(hostedRoot, '.pando-app.json');
        let projectId = '', apiKey = '';
        if (existsSync(configPath)) {
          try {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
            projectId = cfg.projectId || '';
            apiKey = cfg.apiKey || '';
          } catch { /* ignore */ }
        }
        const vars = [`window.PANDO_GATEWAY_URL="${gatewayUrl}"`];
        if (projectId) vars.push(`window.PANDO_PROJECT_ID="${projectId}"`);
        if (apiKey) vars.push(`window.PANDO_PROJECT_API_KEY="${apiKey}"`);
        const script = `<script>${vars.join(';')};</script>`;
        if (html.includes('<head>')) {
          html = html.replace('<head>', '<head>' + script);
        } else {
          html = script + html;
        }
        return reply.send(html);
      }

      return reply.send(content);
    });

  }

  /**
   * Extract user session token from the X-User-Token header or Authorization header.
   * For user-level auth (not node-level API token), clients send:
   *   X-User-Token: <token>
   * Or, for /auth/* endpoints specifically, they can use:
   *   Authorization: Bearer <token>
   * This method checks X-User-Token first, then falls back to Authorization Bearer.
   */
  private extractUserToken(request: any): string | null {
    // Check dedicated user token header first
    const userToken = request.headers['x-user-token'];
    if (userToken && typeof userToken === 'string' && userToken.length > 0) {
      return userToken;
    }

    // Fall back to Authorization header (for /auth/* endpoints only)
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      // Only use Authorization header if the token is NOT the node-level API token
      if (token !== this.apiToken && token.length >= 64) {
        return token;
      }
    }

    return null;
  }

  /**
   * Phase 86: Issue a JWT signed by this node for a given user peerId.
   * Token format: base64url(payload) + "." + hex(Ed25519Signature)
   * Any node can verify using the issuer's public key from the P2P-synced ledger.
   */
  private async issueJwt(userPeerId: string): Promise<{ token: string; expiresAt: number; peerId: string }> {
    const identity = this.node.getIdentity();
    if (!identity) throw new Error('Node identity not available');

    const expiresAt = Date.now() + 24 * 60 * 60_000; // 24 hours
    const payload = {
      sub: userPeerId,
      iss: identity.peerId,
      iat: Date.now(),
      exp: expiresAt,
      typ: 'user',
    };

    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const payloadBytes = new TextEncoder().encode(payloadB64);

    const { privateKeyFromProtobuf } = await import('@libp2p/crypto/keys');
    const pk = privateKeyFromProtobuf(identity.privateKey);
    const sig = await pk.sign(payloadBytes);
    const signatureHex = uint8ArrayToString(sig, 'base16');

    const token = payloadB64 + '.' + signatureHex;
    return { token, expiresAt, peerId: userPeerId };
  }

  /**
   * Phase 86: Verify a JWT token string. Returns the user peerId if valid, null otherwise.
   * Stateless: verifies Ed25519 signature using issuer's public key from the P2P-synced ledger.
   * No database lookups. No in-memory stores.
   */
  private async verifyJwtToken(token: string): Promise<string | null> {
    const dotIdx = token.indexOf('.');
    if (dotIdx === -1 || dotIdx === 0 || dotIdx === token.length - 1) return null;

    const payloadB64 = token.substring(0, dotIdx);
    const signatureHex = token.substring(dotIdx + 1);

    try {
      const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson);

      // Check required fields
      if (!payload.sub || !payload.iss || !payload.exp || payload.typ !== 'user') return null;

      // Check expiry
      if (payload.exp <= Date.now()) return null;

      // Extract issuer's public key from their peerId
      // (Ed25519 peerIds embed the full public key — no ledger lookup needed)
      const { peerIdFromString } = await import('@libp2p/peer-id');
      const issuerPeerIdObj = peerIdFromString(payload.iss);
      const issuerPubKey = issuerPeerIdObj.publicKey;
      if (!issuerPubKey) return null;

      const payloadBytes = new TextEncoder().encode(payloadB64);
      const sigBytes = uint8ArrayFromString(signatureHex, 'base16');

      const verified = await issuerPubKey.verify(payloadBytes, sigBytes);
      if (!verified) return null;

      return payload.sub; // The authenticated user's peerId
    } catch {
      return null;
    }
  }

  /**
   * Phase 86: Extract and verify JWT from request headers.
   * Replaces the old resolveUserPeerId() — fully stateless, no DB lookups.
   */
  private async verifyUserJwt(request?: any): Promise<string | null> {
    if (!request) return null;
    const token = this.extractUserToken(request);
    if (!token) return null;
    return this.verifyJwtToken(token);
  }

  /**
   * Quick Tier: attempt to answer a chat message using local node data.
   * Returns a string reply if the message matches a keyword pattern, or null to fall through to agent.
   * When a request object is provided, user-specific queries (like balance) will use the
   * authenticated user's identity instead of the node operator's.
   */

  // Phase 68.3: Doorman — OpenAI gpt-4o-mini triage for incoming messages.
  // Classifies intent, handles simple queries directly, routes complex work to managers.

  /**
   * Phase 68.3: Doorman — classifies user intent via OpenAI gpt-4o-mini.
   * Returns structured classification: { intent, response?, tier, projectAction? }
   *
   * Intent types:
   * - 'simple' — status/balance/peers/help queries → doorman answers directly
   * - 'question' — general questions → doorman answers via AI ($0.001)
   * - 'build' — "build me X" → create project + spawn manager
   * - 'project' — existing project message → route to project manager
   */
  private async doormanClassify(message: string): Promise<{
    intent: 'simple' | 'question' | 'build' | 'project';
    response?: string;
    tier?: number;
    description?: string;
  }> {
    const lower = message.toLowerCase().replace(/[?!.,]/g, '').trim();

    // ── Deterministic fast-path (zero cost, instant) ──────────────────────
    // Slash commands and obvious keyword matches
    if (/^\/?(status|s)$/i.test(lower) || /\b(node status|show status|system status)\b/.test(lower)) {
      return { intent: 'simple', response: this.getNodeStatusText() };
    }
    if (/^\/?(balance|b)$/i.test(lower) || /\b(balance|my balance|check balance|how much lux|lux balance)\b/.test(lower)) {
      return { intent: 'simple', response: this.getBalanceText() };
    }
    if (/^\/?(peers|p)$/i.test(lower) || /\b(peers|list peers|show peers|connected peers)\b/.test(lower)) {
      return { intent: 'simple', response: this.getPeersText() };
    }
    if (/^\/?(help|h)$/i.test(lower) || /\b(help|commands|what can you do|how to use)\b/.test(lower)) {
      return { intent: 'simple', response: this.getHelpText() };
    }
    if (/^\/?(wallet|w)$/i.test(lower)) {
      return { intent: 'simple', response: this.getBalanceText() };
    }
    if (/\b(tasks|show tasks|list tasks|task queue)\b/.test(lower)) {
      return { intent: 'simple', response: this.getTasksText() };
    }
    if (/\b(proposals|show proposals|governance)\b/.test(lower) && !/\b(create|propose|vote)\b/.test(lower)) {
      return { intent: 'simple', response: this.getProposalsText() };
    }

    // ── OpenAI classification ($0.001, <2s) ──────────────────────────────
    const registry = this.node.getResourceRegistry();
    if (registry) {
      const aiKey = await registry.getActiveAiKey();
      if (aiKey && aiKey.provider === 'openai') {
        try {
          const classifyRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${aiKey.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'system',
                  content: `You are the doorman for Pando, an AI-powered network that builds software projects.
Classify the user's message into ONE of these categories and respond with ONLY valid JSON:

1. "question" — general question, small talk, greeting, asking about Pando. You answer it directly.
2. "build" — user wants to BUILD something (app, website, tool, game, etc). Extract a short description.

JSON format:
For questions: {"intent":"question","response":"<your friendly answer, 1-3 sentences>"}
For builds: {"intent":"build","description":"<what they want built, 1 sentence>","tier":<1 or 2>}

Tier rules:
- Tier 1: Static apps (HTML/CSS/JS, no server needed). Default for most apps.
- Tier 2: ONLY if they explicitly mention: WebSocket, real-time, Express, backend, server, API server, EC2, "Tier 2".

Be friendly and helpful. Keep answers short.`
                },
                { role: 'user', content: message },
              ],
              max_tokens: 256,
              temperature: 0.3,
            }),
            signal: AbortSignal.timeout(8000),
          });

          if (classifyRes.ok) {
            const data = await classifyRes.json() as any;
            const content = data?.choices?.[0]?.message?.content?.trim();
            if (content) {
              try {
                // Parse JSON response (strip markdown code fences if present)
                const cleaned = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
                const parsed = JSON.parse(cleaned);
                if (parsed.intent === 'question' && parsed.response) {
                  return { intent: 'question', response: parsed.response };
                }
                if (parsed.intent === 'build' && parsed.description) {
                  return { intent: 'build', description: parsed.description, tier: parsed.tier || 1 };
                }
              } catch {
                // JSON parse failed — treat as question with raw response
                return { intent: 'question', response: content };
              }
            }
          }
        } catch (err: any) {
          console.log(`[doorman] OpenAI classification failed: ${err.message}`);
        }
      }
    }

    // ── Fallback: no AI key available → deterministic keyword matching ────
    const buildKeywords = /\b(build|create|make|develop|implement|deploy|set up|launch)\b.*\b(app|application|website|site|tool|game|page|project|platform|service|api|server|board|dashboard|blog|shop|store|portfolio|chat|bot)\b/i;
    if (buildKeywords.test(message)) {
      const tier2Keywords = /\b(websocket|real-?time|express|backend|server|api server|ec2|tier\s*2)\b/i;
      return { intent: 'build', description: message.slice(0, 200), tier: tier2Keywords.test(message) ? 2 : 1 };
    }

    // Default: treat as a build request if it contains action words, otherwise question
    const actionKeywords = /\b(add|fix|improve|change|update|upgrade|modify|remove|delete|refactor)\b/i;
    if (actionKeywords.test(message)) {
      return { intent: 'build', description: message.slice(0, 200), tier: 1 };
    }

    return { intent: 'question', response: `I'm Pando, an AI network that builds software. I can help you build apps, check your balance, or answer questions. Try "build me a todo app" to get started!` };
  }

  // ── Doorman helper methods ──────

  private getNodeStatusText(): string {
    const identity = this.node.getIdentity();
    const network = this.node.getNetwork();
    const ledger = this.node.getLedger();
    if (identity && network && ledger) {
      const peers = network.getPeerCount();
      const bal = ledger.accounts.getBalance(identity.peerId);
      const stats = ledger.getNetworkStats();
      const uptime = Math.floor(process.uptime());
      const mins = Math.floor(uptime / 60);
      const secs = uptime % 60;
      return `**Node Status**\n- Peers: ${peers}\n- Balance: ${bal} Lux\n- Total Supply: ${stats.totalSupply} Lux\n- Uptime: ${mins}m ${secs}s\n- Peer ID: \`${identity.peerId}\``;
    }
    return 'Node is starting up...';
  }

  private getBalanceText(): string {
    const identity = this.node.getIdentity();
    const ledger = this.node.getLedger();
    if (identity && ledger) {
      const bal = ledger.accounts.getBalance(identity.peerId);
      return `Your balance is **${bal} Lux**.\n\nPeer ID: \`${identity.peerId}\``;
    }
    return 'Unable to check balance — node identity not loaded.';
  }

  private getPeersText(): string {
    const network = this.node.getNetwork();
    if (network) {
      const count = network.getPeerCount();
      const peers = network.getPeers();
      if (count === 0) return 'No peers connected. This node is running solo.';
      const peerList = peers.slice(0, 10).map((p: any) => `- \`${p.peerId}\``).join('\n');
      return `**Connected Peers (${count})**\n${peerList}${count > 10 ? `\n...and ${count - 10} more` : ''}`;
    }
    return 'Network not initialized yet.';
  }

  private getHelpText(): string {
    return [
      '**Quick Commands** (free, instant):',
      '- "what is my balance" — check Lux balance',
      '- "show status" — node health & stats',
      '- "list peers" — connected peers',
      '',
      '**Build Anything:**',
      '- "build me a todo app" — creates a managed project with AI team',
      '- "build a social app with Express backend" — Tier 2 (server needed)',
      '',
      '**Ask anything** — I\'ll answer questions about Pando, crypto, tech...',
    ].join('\n');
  }

  private getTasksText(): string {
    const taskQueue = this.node.getActiveTaskQueue();
    if (taskQueue) {
      const tasks = taskQueue.getTasks({});
      if (tasks.length === 0) return 'No tasks in queue.';
      const recent = tasks.slice(-5).map((t: any) =>
        `- **${t.title || t.description?.slice(0, 40) || t.id}** — ${t.status}`
      ).join('\n');
      return `**Tasks (${tasks.length} total, showing latest 5)**\n${recent}`;
    }
    return 'Task queue not available.';
  }

  private getProposalsText(): string {
    const governance = this.node.getGovernance();
    if (governance) {
      const proposals = governance.getProposals();
      const active = proposals.filter((p: any) => p.status === 'active');
      if (active.length === 0) return `No active proposals. (${proposals.length} total, all expired or executed.)`;
      const list = active.slice(0, 5).map((p: any) => {
        const votes = governance.getVotes(p.id);
        const votesFor = votes.filter((v: any) => v.choice === 'approve').length;
        const votesAgainst = votes.filter((v: any) => v.choice === 'reject').length;
        return `- **${p.title}** — ${votesFor} for / ${votesAgainst} against`;
      }).join('\n');
      return `**Active Proposals (${active.length})**\n${list}`;
    }
    return 'Governance not initialized.';
  }

  /** Build a snapshot of all data the gateway needs */
  private getSnapshot(): any {
    const network = this.node.getNetwork();
    const ledger = this.node.getLedger();
    const identity = this.node.getIdentity();
    const gov = this.node.getGovernance();

    const stats = ledger?.getNetworkStats();
    const peerList = network?.getPeers() || [];

    return {
      status: identity && network && ledger ? {
        connected: true,
        peerId: identity.peerId,
        peers: network.getPeerCount(),
        peerList: peerList.map(p => p.peerId),
        identity: identity.peerId,
        balance: ledger.accounts.getBalance(identity.peerId),
        totalSupply: stats?.totalSupply || 0,
        totalAccounts: stats?.totalAccounts || 0,
        totalBurned: stats?.totalBurned || 0,
        totalRelayFees: stats?.totalRelayFees || 0,
        totalTransactions: stats?.totalTransactions || 0,
        circulatingSupply: stats?.circulatingSupply || 0,
        activeContributors: stats?.activeContributors || 0,
        uptime: Math.floor(process.uptime()),
        listenAddresses: network.getListenAddresses(),
      } : { connected: false },
      peers: peerList.map(p => ({
        peerId: p.peerId,
        connectedAt: p.connectedAt,
        lastSeen: p.lastSeen,
        balance: ledger ? ledger.accounts.getBalance(p.peerId) : 0,
      })),
      proposalCount: gov ? gov.getProposals().length : 0,
    };
  }

  /** Start the SSE broadcast timer */
  private startSSETimer(): void {
    if (this.sseTimer) return;
    this.lastSnapshot = '';
    this.sseTimer = setInterval(() => {
      if (this.sseClients.size === 0) return;
      const snapshot = this.getSnapshot();
      const json = JSON.stringify(snapshot);
      // Only send if data changed (skip uptime-only changes by zeroing it)
      const comparable = JSON.stringify({ ...snapshot, status: { ...snapshot.status, uptime: 0 } });
      if (comparable === this.lastSnapshot) return;
      this.lastSnapshot = comparable;
      this.broadcast('update', snapshot);
    }, 2000);
  }

  /** Stop the SSE broadcast timer */
  private stopSSETimer(): void {
    if (this.sseTimer) {
      clearInterval(this.sseTimer);
      this.sseTimer = null;
    }
  }

  /** Push a real-time event to all SSE clients immediately (used for transactions, governance, etc.) */
  pushEvent(event: string, data: any): void {
    if (this.sseClients.size === 0) return;
    if (event !== 'update') console.log(`[sse] push: ${event} → ${this.sseClients.size} clients`);
    this.broadcast(event, data);
  }

  /** Send an SSE event to all connected clients */
  private broadcast(event: string, data: any): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const reply of this.sseClients) {
      try {
        reply.raw.write(payload);
      } catch {
        this.sseClients.delete(reply);
      }
    }
  }

  /** Phase 51: Check which API keys are available from ResourceRegistry (encrypted, P2P-synced). */
  private getAvailableApiKeys(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    try {
      const registry = this.node.getResourceRegistry();
      if (registry) {
        const aiKeys = registry.findResources('ai_api_key');
        for (const r of aiKeys) {
          const provider = (r as any).metadata?.provider;
          if (provider === 'openai') result['openai'] = true;
          else if (provider === 'anthropic') result['anthropic'] = true;
          else if (provider === 'gemini' || provider === 'google') result['google'] = true;
          else result[provider || 'unknown'] = true;
        }
      }
    } catch { /* ignore */ }
    return result;
  }

  async start(config: ApiServerConfig): Promise<void> {
    // Register agent tool routes before listening (Phase 27)
    registerAgentRoutes(this.fastify, () => this.agentManager, () => this.apiToken);

    await this.fastify.listen({ port: config.port, host: config.host });

    console.log(`[api] HTTP API: http://${config.host}:${config.port}`);
    if (process.env.API_AUTH_DISABLED !== 'true') {
      console.log(`[api] Token: ${this.apiToken.slice(0, 8)}...`);
    }
    this.startSSETimer();

    // Phase 52: SQLite handles persistence. No in-memory cleanup needed.
    // Data persists across restarts. Optional TTL cleanup can be added later.
  }

  /** Set the AgentManager (Phase 27). */
  setAgentManager(mgr: AgentManager): void {
    this.agentManager = mgr;
  }

  /** Get the AgentManager (Phase 27). */
  getAgentManager(): AgentManager | null {
    return this.agentManager;
  }

  // ── Phase 41: Server-side E2E message crypto helpers ─────────────────────

  /**
   * Decrypt an incoming encrypted user message using the node's identity.
   * Phase 41.5: The encryptedThreadKey is delivered per-request (stateless).
   * Falls back to reading from threadMeta.encryptionKeys[nodePeerId] for backward compatibility.
   * Flow: derive X25519 shared secret from node's Ed25519 key + sender's Ed25519 key,
   * decrypt the threadKey, then decrypt the message with the threadKey.
   */
  private async decryptIncomingMessage(ciphertext: string, nonce: string, threadMeta: any, encryptedThreadKey?: string): Promise<string> {
    const identity = this.node.getIdentity();
    if (!identity) throw new Error('Node identity not available');

    // Phase 41.5: Use per-request encryptedThreadKey if available, fall back to stored key
    const nodeEncKey = encryptedThreadKey || threadMeta.encryptionKeys?.[identity.peerId];
    if (!nodeEncKey) throw new Error('No encryption key available (neither per-request nor stored)');

    // Lazy-load @noble/curves (hoisted in node_modules)
    const { edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } = await import('@noble/curves/ed25519');

    // The sender's public key is stored in encryptionKeys._senderPublicKey
    const senderPubBase64 = threadMeta.encryptionKeys?._senderPublicKey;
    if (!senderPubBase64) throw new Error('Sender public key not found in encryption keys');

    const senderPubBytes = Buffer.from(senderPubBase64, 'base64');
    // identity.privateKey is protobuf-wrapped (68 bytes: 4 header + 32 seed + 32 pub).
    // edwardsToMontgomeryPriv expects the raw 32-byte Ed25519 seed.
    const rawPrivKey = identity.privateKey;
    const nodePrivSeed = rawPrivKey.length === 68
      ? rawPrivKey.subarray(4, 36)
      : rawPrivKey.length === 64
        ? rawPrivKey.subarray(0, 32)
        : rawPrivKey;
    const nodePrivX = edwardsToMontgomeryPriv(nodePrivSeed);
    const senderPubX = edwardsToMontgomeryPub(senderPubBytes);
    const sharedSecret = x25519.getSharedSecret(nodePrivX, senderPubX);

    // Decrypt the thread key
    const encKeyData = Buffer.from(nodeEncKey, 'base64');
    const keyNonce = encKeyData.subarray(0, 12);
    const keyCiphertext = encKeyData.subarray(12);

    const nodeCrypto = await import('node:crypto');
    const keyDecipher = nodeCrypto.createDecipheriv('aes-256-gcm', sharedSecret, keyNonce);
    const authTag = keyCiphertext.subarray(keyCiphertext.length - 16);
    const keyEncData = keyCiphertext.subarray(0, keyCiphertext.length - 16);
    keyDecipher.setAuthTag(authTag);
    const threadKey = Buffer.concat([keyDecipher.update(keyEncData), keyDecipher.final()]);

    // Decrypt the message with the thread key
    const msgCiphertext = Buffer.from(ciphertext, 'base64');
    const msgNonce = Buffer.from(nonce, 'base64');
    const msgDecipher = nodeCrypto.createDecipheriv('aes-256-gcm', threadKey, msgNonce);
    const msgAuthTag = msgCiphertext.subarray(msgCiphertext.length - 16);
    const msgEncData = msgCiphertext.subarray(0, msgCiphertext.length - 16);
    msgDecipher.setAuthTag(msgAuthTag);
    const plaintext = Buffer.concat([msgDecipher.update(msgEncData), msgDecipher.final()]);

    return plaintext.toString('utf-8');
  }

  /**
   * Encrypt an outgoing message (e.g. quick-tier response) for an encrypted thread.
   * Phase 41.5: Uses per-request encryptedThreadKey (stateless), falls back to stored key.
   * Returns { ciphertext, nonce } as base64 strings.
   */
  private async encryptOutgoingMessage(plaintext: string, threadMeta: any, encryptedThreadKey?: string): Promise<{ ciphertext: string; nonce: string }> {
    const identity = this.node.getIdentity();
    if (!identity) throw new Error('Node identity not available');

    // Phase 41.5: Use per-request encryptedThreadKey if available, fall back to stored key
    const nodeEncKey = encryptedThreadKey || threadMeta.encryptionKeys?.[identity.peerId];
    if (!nodeEncKey) throw new Error('No encryption key available (neither per-request nor stored)');

    const { edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } = await import('@noble/curves/ed25519');

    const senderPubBase64 = threadMeta.encryptionKeys?._senderPublicKey;
    if (!senderPubBase64) throw new Error('Sender public key not found in encryption keys');

    const senderPubBytes = Buffer.from(senderPubBase64, 'base64');
    // identity.privateKey is protobuf-wrapped (68 bytes: 4 header + 32 seed + 32 pub).
    // edwardsToMontgomeryPriv expects the raw 32-byte Ed25519 seed.
    const rawPrivKey = identity.privateKey;
    const nodePrivSeed = rawPrivKey.length === 68
      ? rawPrivKey.subarray(4, 36)
      : rawPrivKey.length === 64
        ? rawPrivKey.subarray(0, 32)
        : rawPrivKey;
    const nodePrivX = edwardsToMontgomeryPriv(nodePrivSeed);
    const senderPubX = edwardsToMontgomeryPub(senderPubBytes);
    const sharedSecret = x25519.getSharedSecret(nodePrivX, senderPubX);

    // Decrypt the thread key first
    const nodeCrypto = await import('node:crypto');
    const encKeyData = Buffer.from(nodeEncKey, 'base64');
    const keyNonce = encKeyData.subarray(0, 12);
    const keyCiphertext = encKeyData.subarray(12);

    const keyDecipher = nodeCrypto.createDecipheriv('aes-256-gcm', sharedSecret, keyNonce);
    const authTag = keyCiphertext.subarray(keyCiphertext.length - 16);
    const keyEncData = keyCiphertext.subarray(0, keyCiphertext.length - 16);
    keyDecipher.setAuthTag(authTag);
    const threadKey = Buffer.concat([keyDecipher.update(keyEncData), keyDecipher.final()]);

    // Encrypt the response with the thread key
    const msgNonce = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', threadKey, msgNonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const msgAuthTag = cipher.getAuthTag();
    const fullCiphertext = Buffer.concat([encrypted, msgAuthTag]);

    return {
      ciphertext: fullCiphertext.toString('base64'),
      nonce: msgNonce.toString('base64'),
    };
  }

  async stop(): Promise<void> {
    this.stopSSETimer();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Close all SSE clients
    for (const reply of this.sseClients) {
      try { reply.raw.end(); } catch {}
    }
    this.sseClients.clear();
    await this.fastify.close();
  }
}
