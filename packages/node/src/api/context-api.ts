/**
 * Context API — Live context service for workers and agents.
 *
 * Replaces static assembleContext() with queryable HTTP endpoints.
 * Workers query context on demand instead of getting a 20,000 token dump at spawn.
 *
 * Endpoints:
 *   GET  /context/identity   — Agent identity, authority, tools
 *   GET  /context/project    — Project architecture, discoveries, framework
 *   GET  /context/lessons    — Relevant lessons for role + project
 *   GET  /context/team       — Sibling worker status and recent discoveries
 *   POST /context/discover   — Record a project discovery for shared memory
 */

import type { FastifyInstance } from 'fastify';
import type { AgentDatabase, DiscoveryCategory } from '../platform/agent-database.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextApiDeps {
  getDb: () => AgentDatabase;
  apiPort: number;
}

// ---------------------------------------------------------------------------
// Auto-generated project context from workspace inspection
// ---------------------------------------------------------------------------

interface AutoProjectContext {
  framework: { name: string; version: string; conventions: string[] } | null;
  dependencies: string[];
  description: string | null;
  fileTree: string[];
  buildCommand: string;
}

function detectFramework(packageJson: any): { name: string; version: string; conventions: string[] } | null {
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (deps['next']) return { name: 'next', version: deps['next'], conventions: ['App Router (Next 13+)', 'Server components by default', 'API routes in /api/ or app/api/', 'Use process.env for config'] };
  if (deps['nuxt']) return { name: 'nuxt', version: deps['nuxt'], conventions: ['Nuxt 3 auto-imports', 'File-based routing in pages/', 'Server routes in server/api/'] };
  if (deps['express']) return { name: 'express', version: deps['express'], conventions: ['Bind to 0.0.0.0', 'Use process.env.PORT', 'Middleware order matters'] };
  if (deps['fastify']) return { name: 'fastify', version: deps['fastify'], conventions: ['Schema-based validation', 'Plugin architecture', 'Use process.env.PORT'] };
  if (deps['react']) return { name: 'react', version: deps['react'], conventions: ['Functional components + hooks', 'JSX/TSX files'] };
  if (deps['vue']) return { name: 'vue', version: deps['vue'], conventions: ['Single File Components (.vue)', 'Composition API preferred'] };
  if (deps['svelte'] || deps['@sveltejs/kit']) return { name: 'svelte', version: deps['svelte'] || deps['@sveltejs/kit'], conventions: ['Svelte components (.svelte)', 'File-based routing'] };
  return null;
}

function scanFileTree(dir: string, depth = 0, maxDepth = 3): string[] {
  if (depth >= maxDepth) return [];
  const results: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === '__pycache__') continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(entry + '/');
          results.push(...scanFileTree(fullPath, depth + 1, maxDepth).map(f => entry + '/' + f));
        }
      } catch { /* skip inaccessible */ }
    }
  } catch { /* skip */ }
  return results;
}

function autoGenerateProjectContext(workspaceDir: string): AutoProjectContext {
  const ctx: AutoProjectContext = {
    framework: null,
    dependencies: [],
    description: null,
    fileTree: [],
    buildCommand: 'npm run build',
  };

  // package.json
  const pkgPath = join(workspaceDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      ctx.framework = detectFramework(pkg);
      ctx.dependencies = Object.keys(pkg.dependencies || {}).slice(0, 20);
      ctx.description = pkg.description || null;
      if (pkg.scripts?.build) ctx.buildCommand = 'npm run build';
      if (pkg.scripts?.dev) ctx.buildCommand = 'npm run build';
    } catch { /* skip */ }
  }

  // Python project
  const reqPath = join(workspaceDir, 'requirements.txt');
  if (existsSync(reqPath)) {
    ctx.framework = { name: 'python', version: '', conventions: ['Use venv', 'requirements.txt for deps', 'python -m pytest for tests'] };
    ctx.buildCommand = 'pip install -r requirements.txt';
  }

  // Go project
  const goModPath = join(workspaceDir, 'go.mod');
  if (existsSync(goModPath)) {
    ctx.framework = { name: 'go', version: '', conventions: ['go build', 'go test ./...', 'Module-based imports'] };
    ctx.buildCommand = 'go build ./...';
  }

  // Rust project
  const cargoPath = join(workspaceDir, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    ctx.framework = { name: 'rust', version: '', conventions: ['cargo build', 'cargo test', 'Module system'] };
    ctx.buildCommand = 'cargo build';
  }

  // README
  const readmePath = join(workspaceDir, 'README.md');
  if (existsSync(readmePath)) {
    try {
      const readme = readFileSync(readmePath, 'utf-8');
      // Take first 500 chars of README as description
      if (!ctx.description && readme.length > 0) {
        ctx.description = readme.slice(0, 500).trim();
      }
    } catch { /* skip */ }
  }

  // File tree (3 levels deep)
  ctx.fileTree = scanFileTree(workspaceDir).slice(0, 50);

  return ctx;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerContextRoutes(
  server: FastifyInstance,
  deps: ContextApiDeps,
): void {

  // -------------------------------------------------------------------------
  // GET /context/identity — Who am I, what can I do
  // -------------------------------------------------------------------------
  server.get<{ Querystring: { agentId?: string } }>('/context/identity', async (request, reply) => {
    const agentId = (request.query as any).agentId;
    if (!agentId) return reply.status(400).send({ error: 'agentId query parameter required' });

    const db = deps.getDb();
    const agent = db.getAgent(agentId);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    let authority = null;
    if (agent.authority) {
      try { authority = JSON.parse(agent.authority); } catch { /* skip */ }
    }

    return reply.send({
      agentId: agent.id,
      role: agent.role,
      type: agent.type,
      scope: agent.scope,
      parentId: agent.parentId,
      projectId: agent.projectId,
      workspaceDir: agent.workspaceDir,
      authority,
      templateId: agent.templateId,
      apiPort: deps.apiPort,
      endpoints: {
        getTask: `GET http://localhost:${deps.apiPort}/v1/worker/${agent.id}/task`,
        report: `POST http://localhost:${deps.apiPort}/v1/worker/${agent.id}/report`,
        identity: `GET http://localhost:${deps.apiPort}/v1/worker/${agent.id}/identity`,
        contextProject: `GET http://localhost:${deps.apiPort}/v1/context/project`,
        contextLessons: `GET http://localhost:${deps.apiPort}/v1/context/lessons`,
        contextTeam: `GET http://localhost:${deps.apiPort}/v1/context/team`,
        discover: `POST http://localhost:${deps.apiPort}/v1/context/discover`,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /context/project — Project architecture, discoveries
  // -------------------------------------------------------------------------
  server.get<{ Querystring: { id?: string; task?: string; workspaceDir?: string } }>('/context/project', async (request, reply) => {
    const query = request.query as any;
    const projectId = query.id || null;
    const task = query.task || '';
    const workspaceDir = query.workspaceDir || null;
    const db = deps.getDb();

    // Auto-generated project context (from workspace)
    let autoContext: AutoProjectContext | null = null;
    if (workspaceDir && existsSync(workspaceDir)) {
      autoContext = autoGenerateProjectContext(workspaceDir);
    }

    // Discoveries from shared project memory
    let discoveries: any[] = [];
    if (projectId) {
      discoveries = db.getDiscoveries({ projectId, limit: 15 });
    }

    return reply.send({
      projectId,
      framework: autoContext?.framework || null,
      dependencies: autoContext?.dependencies || [],
      description: autoContext?.description || null,
      fileTree: autoContext?.fileTree || [],
      buildCommand: autoContext?.buildCommand || 'npm run build',
      discoveries: discoveries.map(d => ({
        category: d.category,
        content: d.content,
        confidence: d.confidence,
        fileScope: d.fileScope ? JSON.parse(d.fileScope) : null,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // GET /context/lessons — Relevant lessons for role + project
  // -------------------------------------------------------------------------
  server.get<{ Querystring: { role?: string; projectId?: string; orchestratorId?: string; limit?: string } }>('/context/lessons', async (request, reply) => {
    const query = request.query as any;
    const db = deps.getDb();

    const lessons = db.getLessons({
      orchestratorId: query.orchestratorId || undefined,
      projectId: query.projectId || undefined,
      role: query.role || undefined,
      minConfidence: 0.3,
      limit: parseInt(query.limit) || 15,
    });

    // Mark lessons as used (so confidence tracking works)
    for (const l of lessons) {
      db.incrementLessonUse(l.id);
    }

    const orgKnowledge = db.getOrgKnowledge({
      role: query.role || undefined,
      limit: 5,
    });

    return reply.send({
      lessons: lessons.map(l => ({
        lesson: l.lesson,
        confidence: l.confidence,
        source: l.source,
        projectId: l.projectId,
      })),
      orgKnowledge: orgKnowledge.map(k => ({
        knowledge: k.knowledge,
        category: k.category,
        confidence: k.confidence,
      })),
    });
  });

  // -------------------------------------------------------------------------
  // GET /context/team — Sibling worker status and recent discoveries
  // -------------------------------------------------------------------------
  server.get<{ Querystring: { orchestratorId?: string; projectId?: string } }>('/context/team', async (request, reply) => {
    const query = request.query as any;
    const db = deps.getDb();

    // Get active/recent workers under this orchestrator
    let workers: any[] = [];
    if (query.orchestratorId) {
      const all = db.listAgents({
        parentId: query.orchestratorId,
        type: 'worker',
      });
      // Show active + recently completed (last 2 hours)
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      workers = all
        .filter(w => w.status === 'active' || w.status === 'spawning' || w.updatedAt! > twoHoursAgo)
        .slice(0, 20)
        .map(w => ({
          id: w.id,
          role: w.role,
          status: w.status,
          taskSnippet: w.rolePrompt?.slice(0, 100) || null,
          lastReportAt: w.lastReportAt,
        }));
    }

    // Recent discoveries on this project
    let recentDiscoveries: any[] = [];
    if (query.projectId) {
      recentDiscoveries = db.getDiscoveries({ projectId: query.projectId, limit: 10 })
        .map(d => ({
          workerId: d.workerId,
          category: d.category,
          content: d.content,
          confidence: d.confidence,
        }));
    }

    return reply.send({
      workers,
      recentDiscoveries,
    });
  });

  // -------------------------------------------------------------------------
  // POST /context/discover — Record a project discovery
  // -------------------------------------------------------------------------
  server.post('/context/discover', async (request, reply) => {
    const body = request.body as any;
    if (!body) return reply.status(400).send({ error: 'Request body required' });

    const { agentId, projectId, category, content, fileScope, confidence } = body;

    if (!projectId || !category || !content) {
      return reply.status(400).send({ error: 'projectId, category, and content are required' });
    }

    const validCategories: DiscoveryCategory[] = ['convention', 'gotcha', 'dependency', 'pattern', 'decision'];
    if (!validCategories.includes(category)) {
      return reply.status(400).send({ error: `Invalid category. Must be one of: ${validCategories.join(', ')}` });
    }

    const db = deps.getDb();
    const id = db.addDiscovery({
      projectId,
      workerId: agentId || 'unknown',
      category,
      content,
      confidence: confidence ?? 0.7,
      fileScope: fileScope || undefined,
    });

    return reply.send({ id, status: 'stored' });
  });
}
