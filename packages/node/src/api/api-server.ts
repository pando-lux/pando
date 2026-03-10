/**
 * HTTP API server for the Pando node.
 *
 * Exposes node operations over HTTP so gateway, MCP server,
 * and other tools can interact with the node without reading
 * the DB directly.
 *
 * Routes requests through EngineAdapter to @pando-teams/core for AI processing.
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
  'POST /auth/login':                { max: 5,  envVar: 'PANDO_RATE_AUTH_LOGIN' },
  'POST /auth/claim':                { max: 3,  envVar: 'PANDO_RATE_AUTH_CLAIM' },
  'POST /teams/:id/request':         { max: 3,  envVar: 'PANDO_RATE_REPORT', windowMs: 3600_000 },
  'POST /projects/:id/request':      { max: 5,  envVar: 'PANDO_RATE_PROJECT_REQUEST', windowMs: 3600_000 },
};

// ── Upload Validation (#82, #83) ───────────────────────────────────────
// File size limits and file type validation for any endpoint that accepts file uploads.

const MAX_FILE_SIZE = 50 * 1024 * 1024;     // 50 MB per file
const MAX_TOTAL_UPLOAD_SIZE = 200 * 1024 * 1024; // 200 MB total

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.sh', '.ps1', '.dll', '.so', '.dylib',
]);

/** Validate uploaded files for size and type. Returns error string or null if valid. */
export function validateUploadedFiles(files: Array<{ path: string; content: string }>): string | null {
  if (!files || !Array.isArray(files)) return null;
  let totalSize = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.content || '', 'utf-8');
    if (size > MAX_FILE_SIZE) {
      return `File "${file.path}" exceeds maximum size of 50MB (${Math.round(size / 1024 / 1024)}MB)`;
    }
    totalSize += size;
    if (totalSize > MAX_TOTAL_UPLOAD_SIZE) {
      return `Total upload size exceeds maximum of 200MB`;
    }
    // Check blocked extensions
    const ext = (file.path || '').toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return `File type "${ext}" is not allowed: ${file.path}`;
    }
  }
  return null;
}

// Two Laws Content Filter — imported from shared constants (defense-in-depth)
export { violatesTwoLaws } from '../constants.js';

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

  // #85: Per-IP SSE connection tracking
  private sseConnectionsPerIp = new Map<string, number>();
  private static readonly MAX_SSE_PER_IP = 10;

  constructor(node: PandoNode) {
    this.node = node;
    this.fastify = Fastify({ logger: false });
    this.fastify.register(cors, { origin: true });
    // Allow empty bodies with Content-Type: application/json (Fastify rejects them by default).
    // parseAs:'buffer' avoids Content-Length vs string-length mismatch on multi-byte UTF-8
    // characters (e.g. em dash —). Buffer byte length always matches Content-Length.
    this.fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req: any, body: Buffer, done: any) => {
      try {
        const str = body.length > 0 ? body.toString('utf-8') : '';
        const json = str.length > 0 ? JSON.parse(str) : {};
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
      // Log full error internally but never expose raw error.message to clients
      console.error(`[api] Unhandled error on ${request.method} ${request.url}:`, error.message);
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) {
        reply.code(statusCode).send({ error: 'Internal server error' });
      } else {
        // 4xx from Fastify (e.g. 400 bad JSON) — safe to pass through
        reply.code(statusCode).send({ error: error.message || 'Bad request' });
      }
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
        // Check ban status — banned users are rejected
        const ledger = this.node.getLedger();
        if (ledger?.accounts.isBanned(userPeerId)) {
          request.actor = { type: 'anonymous', id: 'banned', label: 'banned' } as RequestActor;
          return;
        }
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

      // User-facing endpoints use their own auth (userId scoping, E2E encryption).
      // Only operator/admin endpoints require the node-level API Bearer token.
      // NOTE: /teams/ mutations require API token (they control AI agents).
      const urlPath = (request.url as string).split('?')[0];
      const pathNoVersion = urlPath.replace(/^\/v\d+/, '');
      if (
        pathNoVersion.startsWith('/auth/') ||
        pathNoVersion.startsWith('/projects') ||
        pathNoVersion.startsWith('/chat/') ||
        pathNoVersion.startsWith('/internal/')
      ) {
        // Banned users are rejected even on user-facing endpoints
        if (request.actor?.id === 'banned') {
          return reply.code(403).send({ error: 'Account is banned', code: 'BANNED' });
        }
        return;
      }

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
        aiQueryHandler: async (payload: any) => {
          const handler = node.requestReply?.getHandler?.('pando/ai-query');
          if (!handler) throw new Error('AI query handler not registered');
          return handler({ payload, from: 'http-peer' });
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
        gatewayUrl: process.env.HUB_PUBLIC_URL || `http://localhost:3222`,
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
      // #85: SSE per-IP connection limiting
      checkSSELimit: (ip: string) => {
        const count = this.sseConnectionsPerIp.get(ip) || 0;
        return count < ApiServer.MAX_SSE_PER_IP;
      },
      trackSSEConnection: (ip: string, delta: 1 | -1) => {
        const current = this.sseConnectionsPerIp.get(ip) || 0;
        const next = current + delta;
        if (next <= 0) {
          this.sseConnectionsPerIp.delete(ip);
        } else {
          this.sseConnectionsPerIp.set(ip, next);
        }
      },
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
