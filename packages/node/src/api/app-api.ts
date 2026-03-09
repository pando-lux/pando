/**
 * App API routes — registered by registerAppRoutes().
 *
 * Routes: /apps, /apps/:id, /apps/:id/deploy, /apps/:id/update,
 *         /apps/:id/rollback, /apps/:id/stop, /apps/:id/start,
 *         /apps/:id/health, /apps/:id/history, /apps/:id/logs,
 *         /apps/:id/serve/* (local static file serving)
 *
 * All /apps/* endpoints require Bearer token auth (POST/PUT/DELETE).
 * GET endpoints are public (read-only).
 */

import { execFileSync } from 'node:child_process';
import { join, extname, normalize, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { RouteHelpers } from './middleware/auth.js';

const SERVE_MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

/** Validate that an ID is safe for shell/filesystem use (alphanumeric, hyphens, underscores). */
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export async function registerAppRoutes(
  fastify: any,
  deps: RouteHelpers,
): Promise<void> {
  const { node } = deps;

  // ── POST /apps — Register a new app ──────────────────────────────────
  fastify.post('/apps', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    const body = request.body as {
      id: string;
      name: string;
      repoUrl: string;
      buildCmd?: string;
      startCmd?: string;
      healthEndpoint?: string;
      tier?: string;
      envVars?: Record<string, string>;
      governance?: boolean;
      deployAction?: 'pm2' | 'restart-node';
    };

    if (!body.id || !body.name) {
      return reply.code(400).send({ error: 'Missing required fields: id, name' });
    }
    if (!SAFE_ID.test(body.id) || body.id.length > 100) {
      return reply.code(400).send({ error: 'App id must be alphanumeric/hyphens/underscores (max 100 chars)' });
    }
    if (typeof body.name !== 'string' || body.name.length > 200) {
      return reply.code(400).send({ error: 'App name must be a string (max 200 chars)' });
    }

    try {
      const app = await appManager.register(body);
      return app;
    } catch (err: any) {
      console.error('[api] App registration failed:', err.message);
      return reply.code(500).send({ error: 'App registration failed' });
    }
  });

  // ── GET /apps — List all apps ────────────────────────────────────────
  fastify.get('/apps', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    try {
      const status = (request.query as any)?.status;
      const apps = await appManager.list(status ? { status } : undefined);
      return { apps };
    } catch (err: any) {
      console.error('[api] App list failed:', err.message);
      return reply.code(500).send({ error: 'Failed to list apps' });
    }
  });

  // ── GET /apps/:id — Get app details + recent history ─────────────────
  fastify.get('/apps/:id', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    const { id } = request.params;
    try {
      const app = await appManager.get(id);
      if (!app) return reply.code(404).send({ error: 'App not found' });

      const history = await appManager.getHistory(id);
      return { app, history };
    } catch (err: any) {
      console.error('[api] App get failed:', err.message);
      return reply.code(500).send({ error: 'Failed to get app details' });
    }
  });

  // ── POST /apps/:id/deploy — Deploy (first time or re-deploy) ────────
  fastify.post('/apps/:id/deploy', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    const { id } = request.params;
    try {
      const result = await appManager.deploy(id);
      return result;
    } catch (err: any) {
      console.error('[api] App deploy failed:', err.message);
      return reply.code(500).send({ error: 'Deploy failed' });
    }
  });

  // ── POST /apps/:id/update — Trigger update (pull + blue-green) ──────
  fastify.post('/apps/:id/update', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    const { id } = request.params;
    const body = request.body as { targetCommit?: string } | undefined;
    if (body?.targetCommit && !/^[0-9a-f]{6,40}$/i.test(body.targetCommit)) {
      return reply.code(400).send({ error: 'Invalid targetCommit format — must be a hex git hash' });
    }
    const opts = body?.targetCommit ? { targetCommit: body.targetCommit } : undefined;

    try {
      const result = await appManager.update(id, opts);
      return result;
    } catch (err: any) {
      console.error('[api] App update failed:', err.message);
      return reply.code(500).send({ error: 'Update failed' });
    }
  });

  // ── POST /apps/:id/rollback — Rollback to previous commit ───────────
  fastify.post('/apps/:id/rollback', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    const { id } = request.params;
    try {
      const result = await appManager.rollback(id);
      return result;
    } catch (err: any) {
      console.error('[api] App rollback failed:', err.message);
      return reply.code(500).send({ error: 'Rollback failed' });
    }
  });

  // ── POST /apps/:id/stop — Stop app ──────────────────────────────────
  fastify.post('/apps/:id/stop', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    const { id } = request.params;
    try {
      await appManager.undeploy(id);
      return { stopped: true, id };
    } catch (err: any) {
      console.error('[api] App stop failed:', err.message);
      return reply.code(500).send({ error: 'Failed to stop app' });
    }
  });

  // ── POST /apps/:id/start — Start stopped app ────────────────────────
  fastify.post('/apps/:id/start', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    const { id } = request.params;
    try {
      const result = await appManager.deploy(id);
      return result;
    } catch (err: any) {
      console.error('[api] App start failed:', err.message);
      return reply.code(500).send({ error: 'Failed to start app' });
    }
  });

  // ── DELETE /apps/:id — Undeploy + deregister ─────────────────────────
  fastify.delete('/apps/:id', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    const { id } = request.params;
    try {
      await appManager.undeploy(id);
      await appManager.unregister(id);
      // Clean up any associated engine to free memory
      const adapter = (node as any).getEngineAdapter?.();
      if (adapter?.destroyEngine) {
        await adapter.destroyEngine(id).catch(() => {});
      }
      return { deleted: true, id };
    } catch (err: any) {
      console.error('[api] App delete failed:', err.message);
      return reply.code(500).send({ error: 'Failed to delete app' });
    }
  });

  // ── GET /apps/:id/health — On-demand health check ───────────────────
  fastify.get('/apps/:id/health', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    const { id } = request.params;
    try {
      const app = await appManager.get(id);
      if (!app) return reply.code(404).send({ error: 'App not found' });
      const healthy = await appManager.healthCheck(id);
      return { healthy, app };
    } catch (err: any) {
      console.error('[api] App health check failed:', err.message);
      return reply.code(500).send({ error: 'Health check failed' });
    }
  });

  // ── GET /apps/:id/history — Deployment history ──────────────────────
  fastify.get('/apps/:id/history', async (request: any, reply: any) => {
    const appManager = (node as any).getAppManager?.();
    if (!appManager) return reply.code(503).send({ error: 'AppManager not available' });

    const { id } = request.params;
    const limit = Math.min(parseInt((request.query as any)?.limit, 10) || 50, 200);

    try {
      const history = await appManager.getHistory(id, limit);
      return { history };
    } catch (err: any) {
      console.error('[api] App history fetch failed:', err.message);
      return reply.code(500).send({ error: 'Failed to fetch app history' });
    }
  });

  // ── GET /apps/:id/logs — PM2 logs ───────────────────────────────────
  fastify.get('/apps/:id/logs', async (request: any, reply: any) => {
    const { id } = request.params;
    if (!SAFE_ID.test(id)) {
      return reply.code(400).send({ error: 'Invalid app id' });
    }
    const lines = Math.min(Math.max(parseInt((request.query as any)?.lines, 10) || 100, 1), 10_000);

    try {
      const output = execFileSync('pm2', ['logs', `app-${id}`, '--lines', String(lines), '--nostream'], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return { logs: output };
    } catch (err: any) {
      console.error('[api] Log fetch failed:', err.message);
      return reply.code(500).send({ error: 'Failed to fetch logs' });
    }
  });

  // ── GET /apps/:id/serve/* — Serve local static files (Tier 1 fallback) ─
  fastify.get('/apps/:id/serve/*', async (request: any, reply: any) => {
    const { id } = request.params;
    if (!SAFE_ID.test(id)) {
      return reply.code(400).send({ error: 'Invalid app id' });
    }

    // Extract the file path from the wildcard segment
    const rawPath: string = (request.params as any)['*'] || 'index.html';

    // Resolve against the app's hosted directory
    const appsBase = join(homedir(), '.pando', 'hosted-apps');
    const appDir = join(appsBase, id);
    if (!existsSync(appDir)) {
      return reply.code(404).send({ error: 'App not found' });
    }

    // Prefer public/ subdirectory if it exists
    const publicDir = join(appDir, 'public');
    const serveRoot = existsSync(publicDir) && statSync(publicDir).isDirectory()
      ? publicDir : appDir;

    // Resolve and prevent path traversal
    const resolved = resolve(serveRoot, normalize(rawPath));
    if (!resolved.startsWith(resolve(serveRoot))) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    // If path is a directory, try index.html inside it
    let filePath = resolved;
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, 'index.html');
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return reply.code(404).send({ error: 'File not found' });
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = SERVE_MIME[ext] || 'application/octet-stream';

    const content = readFileSync(filePath);
    return reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'public, max-age=3600')
      .send(content);
  });

}
