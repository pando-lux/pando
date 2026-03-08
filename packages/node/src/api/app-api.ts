/**
 * App API routes — registered by registerAppRoutes().
 *
 * Routes: /apps, /apps/:id, /apps/:id/deploy, /apps/:id/update,
 *         /apps/:id/rollback, /apps/:id/stop, /apps/:id/start,
 *         /apps/:id/health, /apps/:id/history, /apps/:id/logs
 *
 * All /apps/* endpoints require Bearer token auth (POST/PUT/DELETE).
 * GET endpoints are public (read-only).
 */

import { execFileSync } from 'node:child_process';
import type { RouteHelpers } from './middleware/auth.js';

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
    };

    if (!body.id || !body.name) {
      return reply.code(400).send({ error: 'Missing required fields: id, name' });
    }

    try {
      const app = await appManager.register(body);
      return app;
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
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
      return reply.code(500).send({ error: err.message });
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
      return reply.code(500).send({ error: err.message });
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
      return reply.code(500).send({ error: err.message });
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
      return reply.code(500).send({ error: err.message });
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
      return reply.code(500).send({ error: err.message });
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
      return reply.code(500).send({ error: err.message });
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
      return reply.code(500).send({ error: err.message });
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
      return { deleted: true, id };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
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
      return reply.code(500).send({ error: err.message });
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
      return reply.code(500).send({ error: err.message });
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
      return reply.code(500).send({ error: `Failed to fetch logs: ${err.message}` });
    }
  });

}
