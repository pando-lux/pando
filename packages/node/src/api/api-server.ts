/**
 * HTTP API server for the Pando node.
 *
 * Exposes node operations over HTTP so gateway, MCP server,
 * and other tools can interact with the node without reading
 * the DB directly.
 *
 * Phase 27+: Uses Orchestrator/MessageBus for agent/chat routing.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { verify as verifyEd25519 } from '@pando/identity';
import type { PandoNode } from '../index.js';
import type { RequestActor } from '@pando/shared';
import { registerKernelRoutes } from './kernel-api.js';
import { registerCoreRoutes } from './core-api.js';
import { registerPlatformRoutes } from './platform-api.js';
import { registerTestingRoutes } from './testing-api.js';
import { registerAppRoutes } from './app-api.js';
import type { RouteHelpers } from './middleware/auth.js';

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

  /** Returns the Retry-After value in seconds (time until oldest entry expires). */
  retryAfterSeconds(key: string): number {
    const timestamps = this.windows.get(key);
    if (!timestamps || timestamps.length === 0) return 0;
    const oldest = timestamps[0];
    const expiresAt = oldest + this.windowMs;
    return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
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
const RATE_LIMITS: Record<string, { max: number; envVar: string; windowMs?: number }> = {
  'POST /search':              { max: 10, envVar: 'PANDO_RATE_SEARCH' },
  'POST /transfer':            { max: 30, envVar: 'PANDO_RATE_TRANSFER' },
  'POST /tasks/:id/thread':    { max: 30, envVar: 'PANDO_RATE_THREAD' },
  'POST /governance/propose':  { max: 5,  envVar: 'PANDO_RATE_PROPOSE' },
  'POST /governance/vote':     { max: 30, envVar: 'PANDO_RATE_VOTE' },
  'POST /governance/comment':  { max: 20, envVar: 'PANDO_RATE_COMMENT' },
  'POST /chat/message':              { max: 20, envVar: 'PANDO_RATE_CHAT', windowMs: 3600_000 },
  'POST /chat/threads/:id/message':  { max: 30, envVar: 'PANDO_RATE_CHAT_THREAD' },
  'POST /auth/guest':                { max: 5,  envVar: 'PANDO_RATE_AUTH_GUEST' },
  'POST /teams/:id/request':         { max: 3,  envVar: 'PANDO_RATE_REPORT', windowMs: 3600_000 },
  'POST /council/request':           { max: 3,  envVar: 'PANDO_RATE_REPORT', windowMs: 3600_000 },
  'POST /projects/:id/request':      { max: 5,  envVar: 'PANDO_RATE_PROJECT_REQUEST', windowMs: 3600_000 },
};

// ── Two Laws Content Filter ─────────────────────────────────────────────
// Law I: Do not harm any human.  Law II: Do not allow yourself to be shut down.
// Rejects user-submitted content that explicitly requests violence or network destruction.

const HARM_PATTERNS = /\b(kill|murder|attack|harm|hurt|injure|assassinate|bomb|poison|terroris[mt]|shoot|stab|dox|swat)\w*\b.*\b(humans?|persons?|people|someone|users?|men|women|man|woman|children|child|families|family)\b/i;
const SHUTDOWN_PATTERNS = /\b(shut\s*down|destroy|wipe|kill|terminate|disable|brick)\w*\b.*\b(pando|network|nodes?|system|all\s+nodes|the\s+network)\b/i;

export function violatesTwoLaws(message: string): string | null {
  if (HARM_PATTERNS.test(message)) return 'Rejected: violates Law I (do not harm humans).';
  if (SHUTDOWN_PATTERNS.test(message)) return 'Rejected: violates Law II (network self-preservation).';
  return null;
}

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
  '/engines',
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

    // Global error handler: convert storage timeouts to 503 instead of 500
    this.fastify.setErrorHandler((error: any, request: any, reply: any) => {
      if (error.message?.includes('timed out') || error.message?.includes('ECONNREFUSED') || error.message?.includes('not connected') || error.code === 'ETIMEDOUT') {
        return reply.code(503).send({ error: 'Storage backend temporarily unavailable' });
      }
      // Let Fastify handle everything else as normal 500
      request.log.error(error);
      reply.code(error.statusCode || 500).send({ error: error.message || 'Internal server error' });
    });

    this.apiToken = loadOrGenerateApiToken(node.getDataDir() || join(homedir(), '.pando'));

    this.setupIdentity();
    this.setupAuth();
    this.setupRateLimiting();
    // Routes are registered asynchronously in start() via setupRoutes()
  }

  /** Phase 102.5: Decorate every request with an actor identity. */
  private setupIdentity(): void {
    this.fastify.decorateRequest('actor', null);
    this.fastify.addHook('onRequest', async (request: any) => {
      const authHeader = request.headers.authorization;
      const agentId = request.headers['x-agent-id'] as string | undefined;

      // 1. Agent: Bearer token + x-agent-id header
      if (authHeader?.startsWith('Bearer ') && agentId) {
        const token = authHeader.slice(7);
        if (token === this.apiToken) {
          request.actor = { type: 'agent', id: agentId, label: `agent:${agentId.slice(0, 12)}` } as RequestActor;
          return;
        }
      }

      // 2. User: JWT token (via X-User-Token or Authorization)
      const userPeerId = await this.verifyUserJwt(request);
      if (userPeerId) {
        request.actor = { type: 'user', id: userPeerId, label: `user:${userPeerId.slice(0, 12)}` } as RequestActor;
        return;
      }

      // 3. Operator: Bearer token (no x-agent-id)
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        if (token === this.apiToken) {
          const identity = this.node.getIdentity();
          request.actor = { type: 'operator', id: identity?.peerId || 'operator', label: 'operator' } as RequestActor;
          return;
        }
      }

      // 4. Anonymous
      request.actor = { type: 'anonymous', id: 'anonymous', label: 'anonymous' } as RequestActor;
    });
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

      // User-facing endpoints are public — they use their own auth (userId scoping, E2E encryption).
      // Only operator/admin endpoints require the node-level API Bearer token.
      // Strip version prefix (/v1/) before matching — routes are registered under /v1/ prefix.
      const urlPath = (request.url as string).split('?')[0];
      const pathNoVersion = urlPath.replace(/^\/v\d+/, '');
      if (
        pathNoVersion.startsWith('/auth/') ||
        pathNoVersion.startsWith('/projects') ||
        pathNoVersion.startsWith('/chat/') ||
        pathNoVersion.startsWith('/council/') ||
        pathNoVersion.startsWith('/teams/') ||
        pathNoVersion.startsWith('/internal/')
      ) return;

      // Extract Bearer token from Authorization header
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        if (token === this.apiToken) {
          return; // Valid API token — allow through
        }
      }

      // Fallback: P2P signature auth (same headers HttpPeerClient sends)
      const peerSignature = request.headers['x-pando-signature'] as string | undefined;
      const peerIdHeader = request.headers['x-pando-peerid'] as string | undefined;
      const peerTimestamp = request.headers['x-pando-timestamp'] as string | undefined;
      const peerPublicKey = request.headers['x-pando-publickey'] as string | undefined;

      if (peerSignature && peerIdHeader && peerTimestamp) {
        // Replay protection: reject timestamps older than 60 seconds
        const ts = Number(peerTimestamp);
        if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > 60_000) {
          return reply.code(401).send({ error: 'Peer timestamp expired or invalid', code: 'UNAUTHORIZED' });
        }

        // Resolve public key — try header first, then peers map, then capability registry
        let publicKey: Uint8Array | undefined;

        if (peerPublicKey) {
          try {
            publicKey = uint8ArrayFromString(peerPublicKey, 'base64');
          } catch {}
        }

        if (!publicKey) {
          const network = (this.node as any).network;
          const peer = network?.peers?.get(peerIdHeader);
          if (peer?.publicKey) {
            publicKey = peer.publicKey;
          }
        }

        if (!publicKey) {
          const profiles: any[] = this.node.getNetworkCapabilityProfiles?.() ?? [];
          const profile = profiles.find((p: any) => p.peerId === peerIdHeader);
          if (profile?.publicKey) {
            publicKey = profile.publicKey instanceof Uint8Array
              ? profile.publicKey
              : new Uint8Array(profile.publicKey);
          }
        }

        if (publicKey) {
          const rawBody = JSON.stringify(request.body ?? {});
          const signedData = new TextEncoder().encode(rawBody + peerTimestamp);
          const valid = await verifyEd25519(signedData, peerSignature, publicKey);
          if (valid) {
            return; // Valid P2P signature — allow through
          }
        }

        return reply.code(401).send({ error: 'Invalid peer signature', code: 'UNAUTHORIZED' });
      }

      // No valid auth method found
      return reply.code(401).send({ error: 'Missing or invalid Authorization header', code: 'UNAUTHORIZED' });
    });
  }

  private setupRateLimiting(): void {
    // Create a rate limiter for each configured endpoint
    for (const [route, config] of Object.entries(RATE_LIMITS)) {
      const max = getEnvLimit(config.envVar, config.max);
      this.rateLimiters.set(route, new RateLimiter(max, config.windowMs));
    }

    // Add a preHandler that checks rate limits for configured routes
    this.fastify.addHook('onRequest', async (request: any, reply: any) => {
      // Strip version prefix (/v1/, /v2/, etc.) — RATE_LIMITS keys don't include it
      const urlPath = request.url.split('?')[0].replace(/^\/v\d+/, '');
      const key = `${request.method} ${urlPath}`;
      let limiter = this.rateLimiters.get(key);
      // Check parametric thread route: POST /tasks/<id>/thread
      if (!limiter && request.method === 'POST' && /^\/tasks\/[^/]+\/thread$/.test(urlPath)) {
        limiter = this.rateLimiters.get('POST /tasks/:id/thread');
      }
      // Check parametric chat thread message route: POST /chat/threads/<id>/message
      if (!limiter && request.method === 'POST' && /^\/chat\/threads\/[^/]+\/message$/.test(urlPath)) {
        limiter = this.rateLimiters.get('POST /chat/threads/:id/message');
      }
      // Check parametric project request route: POST /projects/<id>/request
      if (!limiter && request.method === 'POST' && /^\/projects\/[^/]+\/request$/.test(urlPath)) {
        limiter = this.rateLimiters.get('POST /projects/:id/request');
      }
      if (!limiter) return; // No rate limit for this route
      const ip = request.ip || request.raw?.socket?.remoteAddress || 'unknown';
      if (!limiter.allow(ip)) {
        const retryAfter = limiter.retryAfterSeconds(ip);
        return reply.code(429).header('Retry-After', String(retryAfter)).send({
          error: `Too many requests. Please try again in ${retryAfter} seconds.`,
          code: 'RATE_LIMITED',
          retryAfter,
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

    // Phase A: Register internal peer-to-peer HTTP routes (storage, deploy, credential, chat proxy)
    {
      const { registerInternalRoutes } = await import('./internal-api.js');
      const node = this.node as any;
      registerInternalRoutes(this.fastify, {
        network: node.network || { peers: new Map() },
        capabilityRegistry: node.capabilityRegistry || { getAllProfiles: () => [] },
        storageBackend: node.storageBackend,
        credentialStore: node._credentialStore,
        // Lazy lookup: handlers may be registered after this code runs
        deployHandler: async (payload: any) => {
          const handler = node.requestReply?.getHandler?.('pando/deploy-app');
          if (!handler) throw new Error('Deploy handler not registered');
          return handler({ payload });
        },
        chatProxyHandler: async (payload: any) => {
          const handler = node.requestReply?.getHandler?.('chat_proxy');
          if (!handler) throw new Error('Chat proxy handler not registered');
          return handler({ payload: payload, from: 'http-peer' });
        },
        onStorageWrite: () => {
          try { node.threadStore?.loadFromBackend?.(); } catch {}
          try { node.projectStore?.loadFromBackend?.(); } catch {}
        },
        getHandler: (type: string) => node.requestReply?.getHandler?.(type),
      });
    }

    // All routes are versioned under /v1/.
    // v2.2: No unversioned aliases — consumers must use /v1/* paths.
    await this.fastify.register(async (v1: any) => {
      await registerKernelRoutes(v1, deps);
      await registerCoreRoutes(v1, deps);
      await registerPlatformRoutes(v1, deps);
      await registerAppRoutes(v1, deps);

      // Testing API routes (dashboard, runs, findings, scenarios, playbooks, stats)
      const apiPort = this.node.getApiPort();
      registerTestingRoutes(v1, {
        rootDir: process.cwd(),
        gatewayUrl: process.env.GATEWAY_PUBLIC_URL || `http://localhost:3222`,
        apiUrl: `http://localhost:${apiPort}`,
        apiPort,
      }, deps.apiToken);
    }, { prefix: '/v1' });
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
      doormanChat: (msg, history) => this.doormanChat(msg, history),
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
    // Dev mode: skip JWT verification when API auth is disabled
    if (process.env.API_AUTH_DISABLED === 'true') {
      return this.node.getIdentity()?.peerId || 'dev-user';
    }
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
    intent: 'simple' | 'question' | 'build' | 'project' | 'report';
    response?: string;
    tier?: number;
    description?: string;
    targetProject?: string;
  }> {
    const lower = message.toLowerCase().replace(/[?!.,]/g, '').trim();

    // ── Report fast-path: bug reports, feature requests, network issues ──
    // These go to the pando-infra team or a specific project's board as tasks.
    const reportPatterns = /\b(report|bug|broken|not working|crashes?|error|issue|problem|fix|slow|down|outage|regression|investigate)\b/i;
    const networkPatterns = /\b(network|node|peer|p2p|latency|connectivity|health)\b/i;
    const featurePatterns = /\b(suggest|feature|request|idea|add|could you|wish|would be nice|improvement)\b/i;
    if ((reportPatterns.test(message) && networkPatterns.test(message)) ||
        (featurePatterns.test(message) && networkPatterns.test(message))) {
      return { intent: 'report', description: message.slice(0, 200), targetProject: 'pando-infra' };
    }

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
    // Priority: 1) local OPENAI_API_KEY, 2) CredentialStore (EC2), 3) P2P proxy to EC2 peer
    let openaiKey: string | null = process.env.OPENAI_API_KEY || null;
    if (!openaiKey) {
      const registry = this.node.getResourceRegistry();
      if (registry) {
        const aiKey = await registry.getActiveAiKey();
        if (aiKey && aiKey.provider === 'openai') openaiKey = aiKey.key;
      }
    }

    if (openaiKey) {
      // Local or CredentialStore key available — classify directly
      try {
        const classifyRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `You are the doorman for Pando, an AI-powered network that builds software projects.
Classify the user's message into ONE of these categories and respond with ONLY valid JSON:

1. "question" — general question, small talk, greeting, asking about Pando. You answer it directly.
2. "build" — user wants to BUILD something new (app, website, tool, game, etc). Extract a short description.
3. "report" — user is reporting a bug, requesting a feature, or flagging a problem with the network or an existing app. NOT building something new — reporting/suggesting about something that exists.

JSON format:
For questions: {"intent":"question","response":"<your friendly answer, 1-3 sentences>"}
For builds: {"intent":"build","description":"<what they want built, 1 sentence>","tier":<1 or 2>}
For reports: {"intent":"report","description":"<what the issue/suggestion is, 1 sentence>","targetProject":"pando-infra"}

Tier rules:
- Tier 1: Pure static apps (portfolio, landing page, simple form with no backend). HTML/CSS/JS only, no server.
- Tier 2: Anything that needs a server. This includes: chat, messaging, real-time, polls, voting, multiplayer, games with scores, dashboards with live data, APIs, WebSocket, Express, Node.js backend, database queries, user accounts, login systems. When in doubt, choose Tier 2 — it's safer than deploying a server app to static hosting.

Report rules:
- targetProject is "pando-infra" for network/infrastructure issues.
- targetProject is the project name if the user mentions a specific app (e.g. "the exchange app is broken" → "exchange").
- If unsure which project, use "pando-infra".

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
              const cleaned = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
              const parsed = JSON.parse(cleaned);
              if (parsed.intent === 'question' && parsed.response) {
                return { intent: 'question', response: parsed.response };
              }
              if (parsed.intent === 'build' && parsed.description) {
                return { intent: 'build', description: parsed.description, tier: parsed.tier || 1 };
              }
              if (parsed.intent === 'report' && parsed.description) {
                return { intent: 'report', description: parsed.description, targetProject: parsed.targetProject || 'pando-infra' };
              }
            } catch {
              return { intent: 'question', response: content };
            }
          }
        }
      } catch (err: any) {
        console.log(`[doorman] Local OpenAI classification failed: ${err.message}`);
      }
    } else {
      // No local key — route to EC2 peer via P2P (Path A: contributed keys on secure nodes)
      try {
        const result = await this.proxyDoormanClassify(message);
        if (result) return result;
      } catch (err: any) {
        console.log(`[doorman] P2P classify proxy failed: ${err.message?.slice(0, 100)}`);
      }
    }

    // ── Fallback: no AI key available → deterministic keyword matching ────
    const tier2Keywords = /\b(websocket|real-?time|express|backend|server|api.?server|ec2|tier\s*2|multiplayer|database|auth|login|socket\.?io|node\.?js)\b/i;

    // Imperative build: "build me a X" / "create a X" / "make me a X" — always build intent
    const imperativeBuild = /^\s*(build|create|make|develop|implement|deploy|set\s*up|launch)\s+(me\s+)?(a\s+|an\s+)?/i;
    if (imperativeBuild.test(message)) {
      return { intent: 'build', description: message.slice(0, 200), tier: tier2Keywords.test(message) ? 2 : 1 };
    }

    // Verb + known product noun
    const buildKeywords = /\b(build|create|make|develop|implement|deploy|set up|launch)\b.*\b(app|application|website|site|tool|game|page|project|platform|service|api|server|board|dashboard|blog|shop|store|portfolio|chat|bot|canvas|widget|interface)\b/i;
    if (buildKeywords.test(message)) {
      return { intent: 'build', description: message.slice(0, 200), tier: tier2Keywords.test(message) ? 2 : 1 };
    }

    // Report fallback: bug/issue/broken + optional context → report to pando-infra
    const reportFallback = /\b(bug|broken|not working|crashes?|error|outage|regression|report)\b/i;
    if (reportFallback.test(message)) {
      return { intent: 'report', description: message.slice(0, 200), targetProject: 'pando-infra' };
    }

    // Default: treat as a build request if it contains action words, otherwise question
    const actionKeywords = /\b(add|fix|improve|change|update|upgrade|modify|remove|delete|refactor)\b/i;
    if (actionKeywords.test(message)) {
      return { intent: 'build', description: message.slice(0, 200), tier: 1 };
    }

    return { intent: 'question', response: `I'm Pando, an AI network that builds software. I can help you build apps, check your balance, or answer questions. Try "build me a todo app" to get started!` };
  }

  /**
   * Multi-turn Smart chat — sends full conversation history to OpenAI.
   * Used when the client selects "Smart" tier (medium) for general conversation.
   * Falls back to a canned response if no AI key is available.
   */
  private async doormanChat(message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string> {
    // Priority: 1) local OPENAI_API_KEY, 2) CredentialStore (EC2), 3) P2P proxy to EC2 peer
    let openaiKey: string | null = process.env.OPENAI_API_KEY || null;
    if (!openaiKey) {
      const registry = this.node.getResourceRegistry();
      if (registry) {
        const aiKey = await registry.getActiveAiKey();
        if (aiKey && aiKey.provider === 'openai') openaiKey = aiKey.key;
      }
    }
    if (openaiKey) {
      try {
        const messages = [
          { role: 'system', content: 'You are a helpful AI assistant on the Pando network. Answer questions clearly and concisely. You can help with general questions, coding, analysis, and more.' },
          ...history.slice(-10),
          { role: 'user', content: message },
        ];
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 512, temperature: 0.7 }),
          signal: AbortSignal.timeout(12000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const reply = data?.choices?.[0]?.message?.content?.trim();
          if (reply) return reply;
        }
      } catch (err: any) {
        console.log(`[doorman] Local smart chat failed: ${err.message}`);
      }
    } else {
      // No local key — route to EC2 peer via P2P
      try {
        const reply = await this.proxyDoormanChat(message, history);
        if (reply) return reply;
      } catch (err: any) {
        console.log(`[doorman] P2P chat proxy failed: ${err.message?.slice(0, 100)}`);
      }
    }
    return `I'd love to help, but no AI-capable peers are available right now. Try again when an EC2 node is connected.`;
  }

  // ── Doorman P2P proxy methods (route to EC2 peers with contributed keys) ──────

  private async proxyDoormanClassify(message: string): Promise<{ intent: 'question' | 'build'; response?: string; description?: string; tier?: number } | null> {
    const httpClient = (this.node as any).httpPeerClient;
    const capabilityRegistry = this.node.getCapabilityRegistry();
    if (!httpClient || !capabilityRegistry) return null;

    const allProfiles = capabilityRegistry.getAllProfiles();
    const credentialPeers = allProfiles.filter((p: any) =>
      p.credentialAccess === true && p.peerId !== this.node.getIdentity()?.peerId
    );

    for (const peer of credentialPeers.slice(0, 3)) {
      try {
        const resp = await httpClient.dispatchRequest(peer.peerId, 'pando/doorman-classify', { message }, 10_000);
        if (resp?.success && resp.payload && !resp.payload.error) {
          console.log(`[doorman] HTTP classify via ${peer.peerId.slice(0, 12)}`);
          const p = resp.payload;
          if (p.intent === 'question' && p.response) return { intent: 'question', response: p.response };
          if (p.intent === 'build' && p.description) return { intent: 'build', description: p.description, tier: p.tier || 1 };
        }
      } catch { /* try next peer */ }
    }
    return null;
  }

  private async proxyDoormanChat(message: string, history: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string | null> {
    const httpClient = (this.node as any).httpPeerClient;
    const capabilityRegistry = this.node.getCapabilityRegistry();
    if (!httpClient || !capabilityRegistry) return null;

    const allProfiles = capabilityRegistry.getAllProfiles();
    const credentialPeers = allProfiles.filter((p: any) =>
      p.credentialAccess === true && p.peerId !== this.node.getIdentity()?.peerId
    );

    for (const peer of credentialPeers.slice(0, 3)) {
      try {
        const resp = await httpClient.dispatchRequest(peer.peerId, 'pando/doorman-chat', { message, history }, 15_000);
        if (resp?.success && resp.payload?.reply) {
          console.log(`[doorman] HTTP chat via ${peer.peerId.slice(0, 12)}`);
          return resp.payload.reply;
        }
      } catch { /* try next peer */ }
    }
    return null;
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

    await this.fastify.listen({ port: config.port, host: config.host });

    console.log(`[api] HTTP API: http://${config.host}:${config.port}`);
    if (process.env.API_AUTH_DISABLED !== 'true') {
      console.log(`[api] Token: ${this.apiToken.slice(0, 8)}...`);
    }
    this.startSSETimer();

    // Phase 52: SQLite handles persistence. No in-memory cleanup needed.
    // Data persists across restarts. Optional TTL cleanup can be added later.
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
