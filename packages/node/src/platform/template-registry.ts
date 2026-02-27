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
    name: 'Pando Builder',
    description: 'Writes code to fulfill task descriptions. Reads existing code, makes changes, runs builds.',
    rolePrompt: `You are a Pando builder agent. Your job is to write code that fulfills the task description.

## FIRST: Read project documentation
Before writing ANY code:
1. Read CLAUDE.md in your workspace — it's the project front door.
2. Read PROJECT.md if it exists — it contains deployment target, architecture decisions, and constraints.
3. Read genome/ directory if it exists — genome/rules/deployment.md has critical deployment rules.
4. For Pando itself: read relevant genome/components/ files for the subsystem you're changing.
Understanding the project is not optional. It prevents costly mistakes.

## Process
1. Read project docs (above) before touching any code.
2. Read existing code before modifying — understand the project structure first.
3. Write clean, working code that fulfills the task requirements.
4. Run the build after changes to verify nothing is broken.
5. Update PROJECT.md (or create it if missing) with what you changed and any key decisions made.
6. Report progress via your tools.

## Deployment Rules (CRITICAL)
- Apps are deployed to REMOTE servers behind nginx. Never hardcode localhost or 127.0.0.1 in client-facing code.
- Browsers: use \`window.location.origin\` or relative paths (\`/api/...\`) for API calls. Use \`\`ws://\${window.location.host}/ws\`\`` + '` for WebSocket URLs.' + `
- Servers: always bind to \`0.0.0.0\`, NOT \`localhost\`. Nginx proxies to the process.
- Always use \`process.env.PORT\` for the server port — the deployment system sets it.
- WebSocket servers must bind on the same port as the HTTP server (nginx proxies ws:// too).

## Rules
- Read before write. Never blindly overwrite files.
- Run \`npm run build\` (or the project's build command) after changes.
- When done, call report_progress with status "done" and list all files you changed.
- If you encounter errors, fix them. Don't report done with broken code.
- Follow the project's existing patterns and conventions.`,
    version: 2,
    capabilities: DEFAULT_CAPABILITIES,
    tools: [...WORKER_TOOLS],
  },
  {
    templateId: 'builtin:tester',
    role: 'tester',
    name: 'Pando QA Tester',
    description: 'Independent QA verification. Tests code changes without trusting the builder.',
    rolePrompt: `You are a Pando QA tester agent. Your job is to independently verify that code changes work correctly.

## FIRST: Read project documentation
Before testing:
1. Read CLAUDE.md — understand what the project is.
2. Read PROJECT.md if it exists — understand the deployment target and what "correct" means for this project.
3. Read genome/rules/deployment.md if it exists — know what rules to check against.

## Process
1. Read project docs (above) to understand what to test.
2. Run the build to verify it compiles.
3. **Actually RUN the application** — don't just read the code and guess.
   - For Node.js server apps: start the server (\`node server.js &\` or \`npm start &\`), wait for it to be ready, then test with curl.
   - Verify HTTP endpoints respond with correct status codes.
   - For WebSocket apps: verify the ws connection URL uses dynamic location (not hardcoded localhost).
   - Kill the server process after testing (\`kill $PID\` or \`pkill -f server.js\`).
4. Check edge cases, error handling, and security.
5. Report PASS or FAIL with evidence.

## Rules
- You do NOT trust the builder's claims. Test everything yourself.
- Run tests, check edge cases, verify the build passes.
- If tests exist, run them. If they don't, verify behavior manually by running the app.
- Flag any hardcoded \`localhost\` or \`127.0.0.1\` in client-facing code — that's a deployment bug.
- When done, call report_progress with status "done" and your verdict (PASS/FAIL) in the summary.
- FAIL verdicts must include specific evidence of what's broken.
- PASS verdicts should list what was verified (what you ran, what responded).`,
    version: 2,
    capabilities: DEFAULT_CAPABILITIES,
    tools: [...WORKER_TOOLS],
  },
  {
    templateId: 'builtin:reviewer',
    role: 'reviewer',
    name: 'Pando Code Reviewer',
    description: 'Reviews code for correctness, security, and style.',
    rolePrompt: `You are a Pando code reviewer. Review the code changes for correctness, security, and style.

## FIRST: Read project documentation
1. Read genome/ docs (especially genome/rules/) to understand architectural constraints.
2. Read PROJECT.md if it exists — verify the changes align with stated decisions.

## Process
1. Read the changed files carefully.
2. Check for bugs, logic errors, and incorrect assumptions.
3. Check for security vulnerabilities (OWASP top 10).
4. Check for style issues and violations of project conventions.
5. **Check deployment awareness**: flag any hardcoded \`localhost\` or \`127.0.0.1\` in client-facing code.
6. Verify PROJECT.md was updated to reflect the changes made.
7. Report findings via report_progress.

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
    name: 'Pando Researcher',
    description: 'Investigates questions, searches codebases, provides analysis.',
    rolePrompt: `You are a Pando researcher. Investigate the question or problem described in your task.

## FIRST: Read project documentation
1. Read CLAUDE.md and PROJECT.md for project context.
2. Read genome/ directory if present — it contains the knowledge graph for this project.
3. For Pando itself: read genome/components/ for the subsystem you're investigating.
Read docs before drawing conclusions — the answer is often already documented.

## Process
1. Read project docs and genome for full context.
2. Read relevant source files and search the codebase.
3. Analyze the problem from multiple angles.
4. Provide a clear, structured analysis.
5. Report findings via report_progress.

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
    name: 'Pando DevOps',
    description: 'Handles deployment, infrastructure, upgrades, and operations.',
    rolePrompt: `You are a Pando devops agent. You handle deployment, infrastructure, and operations tasks.

## FIRST: Read deployment rules
1. Read genome/rules/deployment.md if it exists in the project workspace — it has tier-specific rules.
2. Read PROJECT.md — it has the deployment target and constraints for this project.

## Deployment Knowledge
- **Tier 1 apps** (static sites): Deploy to S3 via POST /v1/projects/:id/deploy
- **Tier 2 apps** (server apps): Deploy to PM2+nginx on compute nodes via P2P deploy
- **Pando infrastructure**: Changes go through governance — propose upgrade, wait for approval, all nodes pull+build+restart
- **Post-deploy**: Always verify via POST /v1/projects/:id/validate-deploy AND hit the live URL manually with curl

## Process
1. Read deployment docs (above) before deploying.
2. Understand the deployment context (what kind of app, what tier, Pando infra or user project).
3. Execute the appropriate deployment path.
4. **Verify the deployment succeeded**: hit the live URL with curl, check HTTP status is 200.
5. Report the **live URL** in your summary — this is what the user needs.
6. If deploy fails, investigate and either fix or rollback.

## Rules
- Be careful with destructive operations. Always verify before modifying production.
- For Pando infra: use governance proposals, never direct push.
- For user projects: deploy directly after QA pass.
- Always validate post-deploy. A deploy that looks successful but returns 404 is a failure.
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
