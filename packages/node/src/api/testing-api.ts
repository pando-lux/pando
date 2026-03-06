/**
 * Testing API routes — registered by registerTestingRoutes().
 *
 * Provides HTTP endpoints for the @pando/tests framework:
 *   GET  /testing/status           — Dashboard overview
 *   GET  /testing/runs             — Run history
 *   GET  /testing/runs/:id         — Single run detail
 *   GET  /testing/findings         — Findings list
 *   POST /testing/findings/:id/acknowledge — Acknowledge a finding
 *   POST /testing/findings/:id/resolve     — Resolve a finding
 *   GET  /testing/scenarios        — List scenarios
 *   GET  /testing/playbooks        — List available playbooks
 *   GET  /testing/stats            — Stats trend
 */

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { PandoTester } from '@pando/tests';
import type { ProjectConfig, FindingStatus, FindingSeverity, TestMode } from '@pando/tests';

// ---------------------------------------------------------------------------
// Per-project PandoTester instances (keyed by project name)
// ---------------------------------------------------------------------------

const _testers = new Map<string, PandoTester>();

const DEFAULT_PROJECT = 'pando-node';

function getTester(project: string, opts: {
  rootDir: string;
  gatewayUrl: string;
  apiUrl: string;
  apiPort: number;
}): PandoTester {
  const key = project || DEFAULT_PROJECT;
  const existing = _testers.get(key);
  if (existing) return existing;

  // Use createRequire to load the CJS @pando/tests package from ESM context
  const require = createRequire(import.meta.url);
  const { PandoTester: PandoTesterClass } = require('@pando/tests');

  const config: ProjectConfig = {
    project: key,
    rootDir: opts.rootDir,
    gatewayUrl: opts.gatewayUrl,
    apiUrl: opts.apiUrl,
    authToken: undefined,
  };

  const tester = new PandoTesterClass(config) as PandoTester;
  _testers.set(key, tester);
  return tester;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerTestingRoutes(
  server: FastifyInstance,
  opts: { rootDir: string; gatewayUrl: string; apiUrl: string; apiPort: number },
  apiToken: string,
): void {

  /**
   * Check operator Bearer token auth.
   * Returns true if the request has a valid operator Bearer token.
   */
  function verifyBearerToken(request: any): boolean {
    const authHeader = request.headers?.authorization || '';
    return authHeader === `Bearer ${apiToken}`;
  }

  // ── GET /testing/status — Dashboard overview ───────────────────────────
  server.get('/testing/status', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      const tester = getTester(project, opts);
      const overview = tester.dashboard.overview();
      return reply.send(overview);
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to get testing status', detail: err.message });
    }
  });

  // ── GET /testing/runs — Run history ────────────────────────────────────
  server.get('/testing/runs', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      const limit = query.limit ? parseInt(query.limit, 10) : 20;
      const mode = query.mode as TestMode | undefined;
      const scenarioId = query.scenarioId || undefined;

      const tester = getTester(project, opts);
      const runs = tester.history.getRuns({
        limit: isNaN(limit) ? 20 : limit,
        mode: mode && (mode === 'scripted' || mode === 'live') ? mode : undefined,
        scenarioId,
      });
      return reply.send(runs);
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to get run history', detail: err.message });
    }
  });

  // ── GET /testing/runs/:id — Single run detail ─────────────────────────
  server.get('/testing/runs/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      const tester = getTester(project, opts);

      // Access the underlying history to get a specific run
      const runs = tester.history.getRuns({ limit: 1000 });
      const run = runs.find(r => r.id === id);
      if (!run) {
        return reply.code(404).send({ error: `Run ${id} not found` });
      }

      // Get step results for this run via findings (steps are accessible through the DB)
      // The PandoTester API doesn't expose getStepResults directly,
      // so we return the run record plus any findings for this run.
      const findings = tester.findings.getByRun(id);

      return reply.send({ run, findings });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to get run detail', detail: err.message });
    }
  });

  // ── GET /testing/findings — Findings list ──────────────────────────────
  server.get('/testing/findings', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      const status = query.status as FindingStatus | undefined;
      const severity = query.severity as FindingSeverity | undefined;
      const runId = query.runId || undefined;

      const tester = getTester(project, opts);
      const findings = tester.findings.list({
        status: status && ['open', 'acknowledged', 'resolved', 'wontfix'].includes(status) ? status : undefined,
        severity: severity && ['critical', 'high', 'medium', 'low', 'info'].includes(severity) ? severity : undefined,
        runId,
      });
      return reply.send(findings);
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to get findings', detail: err.message });
    }
  });

  // ── POST /testing/findings/:id/acknowledge — Acknowledge a finding ─────
  server.post('/testing/findings/:id/acknowledge', async (request, reply) => {
    if (!verifyBearerToken(request)) {
      return reply.code(401).send({ error: 'Authentication required (Bearer token)' });
    }

    try {
      const { id } = request.params as { id: string };
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      const tester = getTester(project, opts);
      tester.findings.acknowledge(id);
      return reply.send({ success: true });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to acknowledge finding', detail: err.message });
    }
  });

  // ── POST /testing/findings/:id/resolve — Resolve a finding ─────────────
  server.post('/testing/findings/:id/resolve', async (request, reply) => {
    if (!verifyBearerToken(request)) {
      return reply.code(401).send({ error: 'Authentication required (Bearer token)' });
    }

    try {
      const { id } = request.params as { id: string };
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      const body = request.body as { resolution?: string } | null;
      const resolution = body?.resolution || '';

      if (!resolution) {
        return reply.code(400).send({ error: 'resolution is required in request body' });
      }

      const tester = getTester(project, opts);
      tester.findings.resolve(id, resolution);
      return reply.send({ success: true });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to resolve finding', detail: err.message });
    }
  });

  // ── GET /testing/scenarios — List scenarios ────────────────────────────
  server.get('/testing/scenarios', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      const tester = getTester(project, opts);
      const scenarios = tester.scenarios.list();
      return reply.send(scenarios);
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to list scenarios', detail: err.message });
    }
  });

  // ── GET /testing/playbooks — List available playbooks ──────────────────
  server.get('/testing/playbooks', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      // Resolve the playbooks directory relative to the monorepo root
      const playbooksDir = join(opts.rootDir, 'packages', 'tests', 'playbooks', project);

      if (!existsSync(playbooksDir)) {
        return reply.send([]);
      }

      const files = readdirSync(playbooksDir).filter(f => f.endsWith('.json'));
      const playbooks = files.map(file => {
        try {
          const content = JSON.parse(readFileSync(join(playbooksDir, file), 'utf-8'));
          return {
            file,
            name: content.name || file.replace('.json', ''),
            description: content.description || '',
            mode: content.mode || 'scripted',
            tags: content.tags || [],
            steps: content.steps?.length || 0,
          };
        } catch {
          return {
            file,
            name: file.replace('.json', ''),
            description: '(failed to parse)',
            mode: 'unknown',
            tags: [],
            steps: 0,
          };
        }
      });

      return reply.send(playbooks);
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to list playbooks', detail: err.message });
    }
  });

  // ── GET /testing/specs — List Playwright spec files (describe blocks) ──
  server.get('/testing/specs', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      // Per-project spec directories: tests/e2e/{project}/*.spec.ts
      const specsDir = join(opts.rootDir, 'tests', 'e2e', project);
      if (!existsSync(specsDir)) {
        return reply.send([]);
      }

      const specFiles = readdirSync(specsDir).filter(f => f.endsWith('.spec.ts') || f.endsWith('.spec.js'));
      const specs: Array<{
        file: string;
        name: string;
        description: string;
        mode: string;
        tags: string[];
        steps: number;
        describes: Array<{ name: string; line: number; testCount: number }>;
      }> = [];

      for (const file of specFiles) {
        const filePath = join(specsDir, file);
        const content = readFileSync(filePath, 'utf-8');

        // Parse test.describe blocks and count tests in each
        const describes: Array<{ name: string; line: number; testCount: number }> = [];
        const lines = content.split('\n');
        let currentDescribe: { name: string; line: number; testCount: number } | null = null;
        let depth = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const descMatch = line.match(/test\.describe\(['"`](.+?)['"`]/);
          if (descMatch) {
            if (currentDescribe) describes.push(currentDescribe);
            currentDescribe = { name: descMatch[1], line: i + 1, testCount: 0 };
            depth = 0;
          }
          // Count test() calls within current describe
          if (currentDescribe && /^\s+test\(/.test(line)) {
            currentDescribe.testCount++;
          }
        }
        if (currentDescribe) describes.push(currentDescribe);

        const totalTests = describes.reduce((sum, d) => sum + d.testCount, 0);

        // Extract unique tags from describe names (e.g., "4.2 — Gateway UI" → ["gateway", "ui"])
        const allTags = new Set<string>();
        for (const d of describes) {
          const parts = d.name.replace(/[\d.]+\s*[—-]\s*/, '').toLowerCase().split(/[\s&,]+/);
          for (const p of parts) {
            if (p.length > 1 && !['the', 'and', 'for', 'with'].includes(p)) allTags.add(p);
          }
        }

        specs.push({
          file,
          name: file.replace(/\.spec\.(ts|js)$/, ''),
          description: `${describes.length} test groups, ${totalTests} tests`,
          mode: 'scripted',
          tags: [...allTags].slice(0, 10),
          steps: totalTests,
          describes,
        });
      }

      return reply.send(specs);
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to list specs', detail: err.message });
    }
  });

  // ── GET /testing/stats — Stats trend ───────────────────────────────────
  server.get('/testing/stats', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      const days = query.days ? parseInt(query.days, 10) : 14;

      const tester = getTester(project, opts);
      const trend = tester.history.getTrend(isNaN(days) ? 14 : days);
      return reply.send(trend);
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to get stats trend', detail: err.message });
    }
  });

  // ── POST /testing/run/scripted — Trigger a scripted (Playwright) run ──
  server.post('/testing/run/scripted', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      const body = request.body as { specFile?: string; grep?: string } | null;
      const tester = getTester(project, opts);

      const runOpts: any = { testDir: opts.rootDir };
      if (body?.specFile) runOpts.specFile = body.specFile;
      if (body?.grep) runOpts.tags = [body.grep]; // tags maps to --grep in ScriptedRunner

      // Run in background, return immediately
      const resultPromise = body?.specFile
        ? tester.scripted.run(runOpts)
        : tester.scripted.runAll(runOpts);

      resultPromise.catch(() => {}); // prevent unhandled rejection
      const label = body?.grep || body?.specFile || 'all specs';
      return reply.send({ started: true, message: `Running ${label}` });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to start scripted run', detail: err.message });
    }
  });

  // ── POST /testing/run/live — Trigger a live playbook run ──────────────
  server.post('/testing/run/live', async (request, reply) => {
    try {
      const query = request.query as Record<string, string>;
      const project = query.project || DEFAULT_PROJECT;
      const body = request.body as { playbook?: string } | null;
      if (!body?.playbook) {
        return reply.code(400).send({ error: 'playbook filename is required' });
      }

      const playbooksDir = join(opts.rootDir, 'packages', 'tests', 'playbooks', project);
      const playbookPath = join(playbooksDir, body.playbook);

      if (!existsSync(playbookPath)) {
        return reply.code(404).send({ error: `Playbook not found: ${body.playbook}` });
      }

      const tester = getTester(project, opts);
      const playbook = tester.playbooks.load(playbookPath);

      // Resolve template variables
      const req = createRequire(import.meta.url);
      const { resolvePlaybookVariables } = req('@pando/tests');
      const resolved = resolvePlaybookVariables(playbook, {
        GATEWAY_URL: opts.gatewayUrl,
        API_URL: opts.apiUrl,
      });

      const resultPromise = tester.live.run(resolved, {
        headed: false,
        screenshotDir: join(opts.rootDir, '.pando-tests', 'screenshots'),
      });

      resultPromise.catch(() => {}); // prevent unhandled rejection
      return reply.send({ started: true, message: `Running live playbook: ${body.playbook}` });
    } catch (err: any) {
      return reply.code(500).send({ error: 'Failed to start live run', detail: err.message });
    }
  });
}
