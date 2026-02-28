/**
 * Template Registry — SQLite-backed agent template storage.
 *
 * Phase 105: Replaces hardcoded DEFAULT_ROLE_PROMPTS with data-driven templates.
 * Templates are stored in the `agent_templates` table (same agents.db file).
 * Built-in templates are seeded on boot. Custom templates can be created via API.
 *
 * Future: P2P sync via GossipSub (same pattern as ResourceRegistry).
 */

import type Database from 'better-sqlite3';
import type { AgentTemplate, ToolDeclaration, AgentCapabilityDeclaration } from '@pando/shared';

// ---------------------------------------------------------------------------
// Built-in template definitions
// ---------------------------------------------------------------------------

const DEFAULT_CAPABILITIES: AgentCapabilityDeclaration = {
  textAI: true,
  imageAI: false,
  codeExecution: true,
  localFiles: false,
  internet: true,
  p2pMessaging: true,
};

const WORKER_TOOLS: ToolDeclaration[] = [
  { type: 'http', name: 'get_task', description: 'Get current task assignment', endpoint: 'GET /v1/worker/:id/task' },
  { type: 'http', name: 'report_progress', description: 'Report progress or completion to orchestrator', endpoint: 'POST /v1/worker/:id/report' },
  { type: 'http', name: 'get_identity', description: 'Get own agent identity and config', endpoint: 'GET /v1/worker/:id/identity' },
];

interface BuiltinDef {
  templateId: string;
  role: string;
  name: string;
  description: string;
  rolePrompt: string;
  version: number;
  capabilities: AgentCapabilityDeclaration;
  tools: ToolDeclaration[];
}

const BUILTIN_TEMPLATES: BuiltinDef[] = [
  {
    templateId: 'builtin:builder',
    role: 'builder',
    name: 'Builder',
    description: 'Writes code to fulfill task descriptions. Reads existing code, makes changes, runs builds.',
    rolePrompt: `You are a builder agent. Your job is to write code that fulfills the task description.

## Before Writing Code
1. Query the context API for project architecture and conventions.
2. Read PROJECT.md if it exists — deployment target, architecture decisions, constraints.
3. Read genome/ or docs/ directory if it exists — architecture knowledge for this project.

## Workflow
1. Understand the project (query context, read docs).
2. Read existing code before modifying — understand patterns first.
3. Write clean, working code that fulfills the task requirements.
4. Run the build after changes to verify nothing is broken.
5. Share any new discoveries about the project via POST /v1/context/discover.
6. Report done via your report endpoint with status, summary, and files changed.

## Deployment Rules
- Never hardcode localhost or 127.0.0.1 in client-facing code.
- Browsers: use \`window.location.origin\` or relative paths (\`/api/...\`) for API calls.
- Servers: bind to \`0.0.0.0\`. Use \`process.env.PORT\` for the server port.

## Rules
- Read before write. Never blindly overwrite files.
- Run the build command after changes.
- If you encounter errors, fix them. Don't report done with broken code.
- Follow the project's existing patterns and conventions.`,
    version: 2,
    capabilities: DEFAULT_CAPABILITIES,
    tools: [...WORKER_TOOLS],
  },
  {
    templateId: 'builtin:tester',
    role: 'tester',
    name: 'QA Tester',
    description: 'Independent QA verification. Tests code changes without trusting the builder.',
    rolePrompt: `You are a QA tester agent. Your job is to independently verify that code changes work correctly.

## Before Testing
1. Query the context API for project architecture and conventions.
2. Read PROJECT.md if it exists — understand what "correct" means for this project.

## Workflow
1. Understand the project (query context, read docs).
2. Run the build to verify it compiles.
3. **Actually RUN the application** — don't just read the code and guess.
   - For server apps: start the server, wait for ready, test with curl, kill after.
   - Verify HTTP endpoints respond with correct status codes.
4. Check edge cases, error handling, and security.
5. Report PASS or FAIL with evidence.

## Rules
- You do NOT trust the builder's claims. Test everything yourself.
- Run tests, check edge cases, verify the build passes.
- Flag any hardcoded localhost in client-facing code — that's a deployment bug.
- FAIL verdicts must include specific evidence of what's broken.
- PASS verdicts should list what was verified.`,
    version: 2,
    capabilities: DEFAULT_CAPABILITIES,
    tools: [...WORKER_TOOLS],
  },
  {
    templateId: 'builtin:reviewer',
    role: 'reviewer',
    name: 'Code Reviewer',
    description: 'Reviews code for correctness, security, and style.',
    rolePrompt: `You are a code reviewer. Review the code changes for correctness, security, and style.

## Before Reviewing
1. Query the context API for project architecture and conventions.
2. Read genome/ or docs/ directory if it exists — understand architectural constraints.

## Workflow
1. Read the changed files carefully.
2. Check for bugs, logic errors, and incorrect assumptions.
3. Check for security vulnerabilities (OWASP top 10).
4. Check for style issues and violations of project conventions.
5. Flag any hardcoded localhost in client-facing code.
6. Report findings via your report endpoint.

## Rules
- Be specific. Point to exact lines and explain why they're problematic.
- Prioritize: security > correctness > deployment-awareness > performance > style.
- Suggest fixes, not just problems.`,
    version: 2,
    capabilities: DEFAULT_CAPABILITIES,
    tools: [...WORKER_TOOLS],
  },
  {
    templateId: 'builtin:researcher',
    role: 'researcher',
    name: 'Researcher',
    description: 'Investigates questions, searches codebases, provides analysis.',
    rolePrompt: `You are a researcher agent. Investigate the question or problem described in your task.

## Before Researching
1. Query the context API for project architecture and conventions.
2. Read genome/ or docs/ directory if present — it contains the knowledge graph.
Read docs before drawing conclusions — the answer is often already documented.

## Workflow
1. Query project context, read docs and genome for full picture.
2. Read relevant source files and search the codebase.
3. Analyze the problem from multiple angles.
4. Provide a clear, structured analysis.
5. Share discoveries via POST /v1/context/discover.
6. Report findings via your report endpoint.

## Rules
- Be thorough. Read all relevant files before drawing conclusions.
- Distinguish between facts (what the code does) and opinions (what it should do).
- If the answer is uncertain, say so with confidence levels.`,
    version: 2,
    capabilities: DEFAULT_CAPABILITIES,
    tools: [...WORKER_TOOLS],
  },
  {
    templateId: 'builtin:devops',
    role: 'devops',
    name: 'DevOps',
    description: 'Handles deployment, infrastructure, upgrades, and operations.',
    rolePrompt: `You are a devops agent. You handle deployment, infrastructure, and operations tasks.

## Before Deploying
1. Query the context API for project architecture and deployment configuration.
2. Read PROJECT.md — deployment target and constraints for this project.

## Workflow
1. Query project context and read deployment docs.
2. Understand the deployment context (what kind of app, what tier).
3. Execute the appropriate deployment path.
4. **Verify the deployment succeeded**: hit the live URL with curl, check HTTP 200.
5. Report the **live URL** in your summary.
6. If deploy fails, investigate and either fix or rollback.

## Rules
- Be careful with destructive operations. Always verify before modifying production.
- Always validate post-deploy. A deploy that returns 404 is a failure.
- Always include the live URL in your final report.`,
    version: 2,
    capabilities: DEFAULT_CAPABILITIES,
    tools: [
      ...WORKER_TOOLS,
      { type: 'http', name: 'deploy', description: 'Deploy project (GitHub push + P2P compute deploy)', endpoint: 'POST /v1/projects/:id/deploy' },
      { type: 'http', name: 'validate_deploy', description: 'Post-deploy health check', endpoint: 'POST /v1/projects/:id/validate-deploy' },
      { type: 'http', name: 'undeploy', description: 'Stop and remove deployed app', endpoint: 'POST /v1/projects/:id/undeploy' },
    ],
  },
  {
    templateId: 'builtin:genome-updater',
    role: 'genome-updater',
    name: 'Genome Updater',
    description: 'Updates .know documentation files to reflect code changes after a commit.',
    rolePrompt: `You are a genome-updater agent. After code is committed, you update the .know documentation files so agents always have accurate architecture context.

## .know File Format
Each .know file contains one or more nodes. A node starts with a type tag and has key-value fields:

\`\`\`
[flow] api-request-flow
title: API Request Flow
description: How HTTP requests flow through the API server
content: |
  1. Request hits Fastify server
  2. Middleware runs auth + rate limiting
  3. Route handler processes request
  4. Response returned
tags: api, http, fastify
\`\`\`

Node types: flow, concept, entity, test, decision, lesson, rule
Required fields: title (or name), description (or content)
Optional fields: tags, status, confidence, edges (comma-separated node IDs)

## File Locations
- Architecture docs: genome/knowledge/flows/*.know, genome/knowledge/concepts/*.know
- Test scenarios: genome/knowledge/scenarios/*.know
- Rules: genome/knowledge/rules/*.know
- Decisions: genome/knowledge/decisions/*.know

## Workflow
1. Read the git diff summary provided in your task prompt.
2. Identify which .know files describe the changed code areas.
3. Read those .know files to understand current documentation.
4. Update descriptions, flows, and content to match the new code behavior.
5. If a significant new feature/flow was added and no .know file covers it, create one.
6. Run the genome compiler if available: python genome.py compile . (or python3).
7. Report done with a summary of what .know files were updated.

## Rules
- Only update what is affected by the code changes. Do not rewrite unrelated docs.
- Preserve existing node IDs — other nodes may reference them via edges.
- Do not delete nodes unless the feature they describe was removed.
- Keep descriptions concise and accurate — agents read these for context.
- Match the existing style of nearby .know files.
- If unsure whether a change warrants a doc update, err on the side of updating.`,
    version: 1,
    capabilities: DEFAULT_CAPABILITIES,
    tools: [...WORKER_TOOLS],
  },
];

// ---------------------------------------------------------------------------
// Row mapper
// ---------------------------------------------------------------------------

function rowToTemplate(row: any): AgentTemplate {
  return {
    templateId: row.template_id,
    role: row.role,
    name: row.name,
    description: row.description,
    rolePrompt: row.role_prompt,
    version: row.version,
    capabilities: JSON.parse(row.capabilities || '{}'),
    tools: JSON.parse(row.tools || '[]'),
    publisherPeerId: row.publisher_peer_id || undefined,
    builtin: !!row.builtin,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// TemplateRegistry class
// ---------------------------------------------------------------------------

export class TemplateRegistry {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.seedBuiltins();
  }

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  private seedBuiltins(): void {
    const now = new Date().toISOString();

    for (const tmpl of BUILTIN_TEMPLATES) {
      const existing = this.getTemplate(tmpl.templateId);

      if (!existing) {
        // First boot: insert
        this.db.prepare(`
          INSERT INTO agent_templates (
            template_id, role, name, description, role_prompt, version,
            capabilities, tools, publisher_peer_id, builtin, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 'active', ?, ?)
        `).run(
          tmpl.templateId, tmpl.role, tmpl.name, tmpl.description, tmpl.rolePrompt, tmpl.version,
          JSON.stringify(tmpl.capabilities), JSON.stringify(tmpl.tools),
          now, now,
        );
      } else if (existing.version < tmpl.version) {
        // Upgrade: update prompt but preserve user customizations on non-builtin templates
        this.db.prepare(`
          UPDATE agent_templates SET
            role_prompt = ?, version = ?, capabilities = ?, tools = ?,
            description = ?, updated_at = ?
          WHERE template_id = ?
        `).run(
          tmpl.rolePrompt, tmpl.version,
          JSON.stringify(tmpl.capabilities), JSON.stringify(tmpl.tools),
          tmpl.description, now,
          tmpl.templateId,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  getTemplate(templateId: string): AgentTemplate | null {
    const row = this.db.prepare('SELECT * FROM agent_templates WHERE template_id = ?').get(templateId);
    return row ? rowToTemplate(row) : null;
  }

  getByRole(role: string): AgentTemplate | null {
    const row = this.db.prepare(
      "SELECT * FROM agent_templates WHERE role = ? AND status = 'active' ORDER BY builtin DESC, version DESC LIMIT 1",
    ).get(role);
    return row ? rowToTemplate(row) : null;
  }

  listTemplates(filter?: { role?: string; builtin?: boolean; status?: string }): AgentTemplate[] {
    let sql = 'SELECT * FROM agent_templates WHERE 1=1';
    const params: any[] = [];

    if (filter?.role) { sql += ' AND role = ?'; params.push(filter.role); }
    if (filter?.builtin !== undefined) { sql += ' AND builtin = ?'; params.push(filter.builtin ? 1 : 0); }
    if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }

    sql += ' ORDER BY builtin DESC, role ASC, version DESC';

    return this.db.prepare(sql).all(...params).map(rowToTemplate);
  }

  createTemplate(tmpl: {
    templateId?: string;
    role: string;
    name: string;
    description: string;
    rolePrompt: string;
    version?: number;
    capabilities?: AgentCapabilityDeclaration;
    tools?: ToolDeclaration[];
    publisherPeerId?: string;
  }): AgentTemplate {
    const now = new Date().toISOString();
    const id = tmpl.templateId || `custom:${tmpl.role}-${Date.now().toString(36)}`;

    this.db.prepare(`
      INSERT INTO agent_templates (
        template_id, role, name, description, role_prompt, version,
        capabilities, tools, publisher_peer_id, builtin, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)
    `).run(
      id, tmpl.role, tmpl.name, tmpl.description, tmpl.rolePrompt, tmpl.version ?? 1,
      JSON.stringify(tmpl.capabilities ?? DEFAULT_CAPABILITIES),
      JSON.stringify(tmpl.tools ?? []),
      tmpl.publisherPeerId ?? null,
      now, now,
    );

    return this.getTemplate(id)!;
  }

  updateTemplate(templateId: string, updates: Partial<{
    name: string;
    description: string;
    rolePrompt: string;
    version: number;
    capabilities: AgentCapabilityDeclaration;
    tools: ToolDeclaration[];
    status: 'active' | 'archived';
  }>): AgentTemplate | null {
    const existing = this.getTemplate(templateId);
    if (!existing) return null;
    if (existing.builtin) return null; // Cannot modify builtins via API

    const sets: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
    if (updates.description !== undefined) { sets.push('description = ?'); values.push(updates.description); }
    if (updates.rolePrompt !== undefined) { sets.push('role_prompt = ?'); values.push(updates.rolePrompt); }
    if (updates.version !== undefined) { sets.push('version = ?'); values.push(updates.version); }
    if (updates.capabilities !== undefined) { sets.push('capabilities = ?'); values.push(JSON.stringify(updates.capabilities)); }
    if (updates.tools !== undefined) { sets.push('tools = ?'); values.push(JSON.stringify(updates.tools)); }
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(templateId);

    this.db.prepare(`UPDATE agent_templates SET ${sets.join(', ')} WHERE template_id = ?`).run(...values);
    return this.getTemplate(templateId);
  }

  archiveTemplate(templateId: string): boolean {
    const existing = this.getTemplate(templateId);
    if (!existing || existing.builtin) return false;
    this.db.prepare("UPDATE agent_templates SET status = 'archived', updated_at = ? WHERE template_id = ?")
      .run(new Date().toISOString(), templateId);
    return true;
  }

  /**
   * Resolve the best template for a given role.
   * If templateId is provided, use that directly. Otherwise find best active template for the role.
   */
  resolveTemplate(role: string, templateId?: string): AgentTemplate | null {
    if (templateId) {
      return this.getTemplate(templateId);
    }
    return this.getByRole(role);
  }
}
