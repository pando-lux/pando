/**
 * Internal API routes — peer-to-peer operations over HTTP.
 *
 * These routes are called by HttpPeerClient from other nodes.
 * Auth: Ed25519 signature verification (not JWT/API token).
 *
 * Routes: /v1/internal/storage/:method, /v1/internal/deploy,
 *         /v1/internal/credential, /v1/internal/chat-proxy
 */

import { verify } from '@pando/identity';
import { fromString as uint8ArrayFromString } from 'uint8arrays';

// ── Types ────────────────────────────────────────────────────────────────────

export interface InternalRouteDeps {
  network: { peers: Map<string, { publicKey: Uint8Array }> };
  capabilityRegistry: { getAllProfiles(): any[] };
  storageBackend: any;
  credentialStore?: { getCredential(resourceId: string): Promise<string | null>; hasDecryptionCapability(): boolean };
  deployHandler?: (payload: any) => Promise<any>;
  chatProxyHandler?: (payload: any) => Promise<any>;
  onStorageWrite?: () => void;
  /** Generic handler dispatch — looks up registered handlers by type */
  getHandler?: (type: string) => ((req: any) => Promise<any>) | undefined;
}

// ── Signature Auth ───────────────────────────────────────────────────────────

const MAX_TIMESTAMP_DRIFT_MS = 60_000;

async function verifyPeerSignature(
  request: any,
  deps: InternalRouteDeps,
): Promise<{ valid: true; peerId: string } | { valid: false; error: string; code: number }> {
  const signature = request.headers['x-pando-signature'] as string | undefined;
  const peerId = request.headers['x-pando-peerid'] as string | undefined;
  const timestamp = request.headers['x-pando-timestamp'] as string | undefined;

  if (!signature || !peerId || !timestamp) {
    return { valid: false, error: 'Missing auth headers', code: 401 };
  }

  // Replay protection
  const ts = Number(timestamp);
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > MAX_TIMESTAMP_DRIFT_MS) {
    return { valid: false, error: 'Timestamp expired or invalid', code: 401 };
  }

  // Resolve public key — try header first (self-declared), then peers map, then capability registry
  let publicKey: Uint8Array | undefined;

  // 1. Public key from header (sender includes it for verification)
  const publicKeyHeader = request.headers['x-pando-publickey'] as string | undefined;
  if (publicKeyHeader) {
    try {
      publicKey = uint8ArrayFromString(publicKeyHeader, 'base64');
    } catch {}
  }

  // 2. Peers map (connected libp2p peers)
  if (!publicKey) {
    const peer = deps.network.peers.get(peerId);
    if (peer?.publicKey) {
      publicKey = peer.publicKey;
    }
  }

  // 3. Capability registry profiles
  if (!publicKey) {
    const profiles = deps.capabilityRegistry.getAllProfiles();
    const profile = profiles.find((p: any) => p.peerId === peerId);
    if (profile?.publicKey) {
      publicKey = profile.publicKey instanceof Uint8Array
        ? profile.publicKey
        : new Uint8Array(profile.publicKey);
    }
  }

  if (!publicKey) {
    return { valid: false, error: 'Unknown peer', code: 401 };
  }

  // Build the signed payload: body string + timestamp
  // The client sends JSON.stringify(payload) + timestamp, so we reconstruct the same string.
  // Fastify parses JSON into an object, so we re-stringify to match what was signed.
  const rawBody = JSON.stringify(request.body ?? {});
  const signedData = new TextEncoder().encode(rawBody + timestamp);

  const ok = await verify(signedData, signature, publicKey);
  if (!ok) {
    return { valid: false, error: 'Invalid signature', code: 401 };
  }

  return { valid: true, peerId };
}

// ── Route Registration ───────────────────────────────────────────────────────

const ALLOWED_STORAGE_METHODS = new Set([
  'putRecord', 'getRecord', 'queryRecords', 'deleteRecord', 'listRecords', 'pushToArray',
]);
const WRITE_METHODS = new Set(['putRecord', 'deleteRecord', 'pushToArray']);
const BLOCKED_COLLECTIONS = new Set(['pando_credentials']);

export function registerInternalRoutes(fastify: any, deps: InternalRouteDeps): void {
  // Peer-signature preHandler for all /v1/internal/* routes
  fastify.addHook('onRoute', (routeOptions: any) => {
    if (routeOptions.url?.startsWith('/v1/internal/')) {
      const existing = routeOptions.preHandler;
      const authHook = async (request: any, reply: any) => {
        const result = await verifyPeerSignature(request, deps);
        if (!result.valid) {
          return reply.code(result.code).send({ error: result.error });
        }
        (request as any).peerId = result.peerId;
      };
      routeOptions.preHandler = existing
        ? [].concat(existing, authHook as any)
        : [authHook];
    }
  });

  // ── POST /v1/internal/storage/:method ──────────────────────────────────────

  fastify.post('/v1/internal/storage/:method', async (request: any, reply: any) => {
    const { method } = request.params;

    if (!ALLOWED_STORAGE_METHODS.has(method)) {
      return reply.code(400).send({ error: `Unknown storage method: ${method}` });
    }

    const args = request.body ?? {};

    // Block credential collections
    const collection = args.collection ?? args.collectionName;
    if (collection && BLOCKED_COLLECTIONS.has(collection)) {
      return reply.code(403).send({ error: 'Access to this collection is forbidden' });
    }

    if (!deps.storageBackend || typeof deps.storageBackend[method] !== 'function') {
      return reply.code(501).send({ error: 'Storage backend not available' });
    }

    try {
      let result: any;
      // Dispatch with correct argument signatures
      switch (method) {
        case 'putRecord':
          result = await deps.storageBackend.putRecord(args.collection, args.key, args.data);
          break;
        case 'getRecord':
          result = await deps.storageBackend.getRecord(args.collection, args.key);
          break;
        case 'queryRecords':
          result = await deps.storageBackend.queryRecords(args.collection, args.filter, args.options);
          break;
        case 'deleteRecord':
          result = await deps.storageBackend.deleteRecord(args.collection, args.key);
          break;
        case 'listRecords':
          result = await deps.storageBackend.listRecords(args.collection, args.filter);
          break;
        case 'pushToArray':
          result = await deps.storageBackend.pushToArray(args.collection, args.key, args.field, args.value);
          break;
      }
      if (WRITE_METHODS.has(method)) {
        deps.onStorageWrite?.();
      }
      return { result };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message ?? 'Storage operation failed' });
    }
  });

  // ── POST /v1/internal/deploy ───────────────────────────────────────────────

  fastify.post('/v1/internal/deploy', async (request: any, reply: any) => {
    if (!deps.deployHandler) {
      return reply.code(501).send({ error: 'Deploy handler not available' });
    }
    try {
      const result = await deps.deployHandler(request.body);
      return result;
    } catch (err: any) {
      return reply.code(500).send({ error: err.message ?? 'Deploy failed' });
    }
  });

  // ── POST /v1/internal/credential ───────────────────────────────────────────

  fastify.post('/v1/internal/credential', async (request: any, reply: any) => {
    if (!deps.credentialStore) {
      return reply.code(501).send({ error: 'Credential store not available' });
    }

    const { resourceId, type } = request.body ?? {};
    if (!resourceId || !type) {
      return reply.code(400).send({ error: 'resourceId and type are required' });
    }

    // Security: only code_repository creds are served remotely
    if (type !== 'code_repository') {
      return reply.code(403).send({ error: 'Only code_repository credentials can be retrieved remotely' });
    }

    try {
      const credential = await deps.credentialStore.getCredential(resourceId);
      if (!credential) {
        return reply.code(404).send({ error: 'Credential not found' });
      }
      return { credential };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message ?? 'Credential retrieval failed' });
    }
  });

  // ── POST /v1/internal/chat-proxy ───────────────────────────────────────────

  fastify.post('/v1/internal/chat-proxy', async (request: any, reply: any) => {
    if (!deps.chatProxyHandler) {
      return reply.code(501).send({ error: 'Chat proxy handler not available' });
    }
    try {
      const result = await deps.chatProxyHandler(request.body);
      return result;
    } catch (err: any) {
      return reply.code(500).send({ error: err.message ?? 'Chat proxy failed' });
    }
  });

  // ── POST /v1/internal/dispatch ───────────────────────────────────────────
  // Generic handler dispatch — routes to any registered handler by type.
  // Used by HttpPeerClient.dispatchRequest() for resource proofs, task forwarding, etc.

  fastify.post('/v1/internal/dispatch', async (request: any, reply: any) => {
    const { type, payload } = request.body ?? {};
    if (!type) {
      return reply.code(400).send({ error: 'type is required' });
    }

    const handler = deps.getHandler?.(type);
    if (!handler) {
      return reply.code(404).send({ error: `No handler for type: ${type}` });
    }

    try {
      // Wrap payload as a PandoRequest-like object for handler compatibility
      const req = {
        requestId: `http-${Date.now()}`,
        from: (request as any).peerId || 'unknown',
        to: '*',
        type,
        payload,
        timeout: 30_000,
        timestamp: Date.now(),
      };
      const result = await handler(req);
      return { success: true, payload: result };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message ?? 'Handler failed' });
    }
  });
}
