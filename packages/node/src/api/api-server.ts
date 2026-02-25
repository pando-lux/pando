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
import { registerAgentRoutes } from '../platform/agent-tools.js';
import { hasClaudeCodeAuth } from '../platform/capability-detector.js';
import type { AgentManager } from '../core/agent-manager.js';
import type { DeployFile } from '../platform/hosting-service.js';
import type { PandoNode } from '../index.js';
import { registerKernelRoutes } from './kernel-api.js';
import { registerCoreRoutes } from './core-api.js';
import { registerPlatformRoutes } from './platform-api.js';
import type { RouteHelpers } from './middleware/auth.js';

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
    // Routes are registered asynchronously in start() via setupRoutes()
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

  private async setupRoutes(): Promise<void> {
    const deps = this.buildRouteDeps();
    await registerKernelRoutes(this.fastify, deps);
    await registerCoreRoutes(this.fastify, deps);
    await registerPlatformRoutes(this.fastify, deps, () => this.agentManager);
  }

  /** Build the RouteHelpers dependency object from this ApiServer instance. */
  private buildRouteDeps(): RouteHelpers {
    return {
      node: this.node,
      apiToken: this.apiToken,
      verifyUserJwt: (req) => this.verifyUserJwt(req),
      issueJwt: (peerId) => this.issueJwt(peerId),
      pushEvent: (event, data) => this.pushEvent(event, data),
      getSnapshot: () => this.getSnapshot(),
      getAvailableApiKeys: () => this.getAvailableApiKeys(),
      addSSEClient: (reply) => this.sseClients.add(reply),
      removeSSEClient: (reply) => this.sseClients.delete(reply),
      doormanClassify: (msg) => this.doormanClassify(msg),
      decryptIncomingMessage: (ct, n, tm, etk) => this.decryptIncomingMessage(ct, n, tm, etk),
      encryptOutgoingMessage: (pt, tm, etk) => this.encryptOutgoingMessage(pt, tm, etk),
    };
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
- Tier 1: Pure static apps (portfolio, landing page, simple form with no backend). HTML/CSS/JS only, no server.
- Tier 2: Anything that needs a server. This includes: chat, messaging, real-time, polls, voting, multiplayer, games with scores, dashboards with live data, APIs, WebSocket, Express, Node.js backend, database queries, user accounts, login systems. When in doubt, choose Tier 2 — it's safer than deploying a server app to static hosting.

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
    // Register all routes before listening
    await this.setupRoutes();

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
