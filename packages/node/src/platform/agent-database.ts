/**
 * Agent Database — SQLite-backed storage for the new agent orchestration system.
 *
 * Tables:
 *   agent_identity  — unified record for every agent (worker or orchestrator)
 *   message_inbox   — persistent message routing (replaces in-memory BridgeQueue)
 *   tick_log        — orchestrator decision audit trail
 *   lessons         — per-orchestrator learning with confidence scoring
 *   org_knowledge   — cross-team institutional memory
 *   directives      — admin/founder instructions to orchestrators
 *   reflections     — self-healing growth records
 *
 * Follows the same pattern as task-database.ts: WAL mode, prepared statements,
 * row-to-object mappers. Shares the same data directory but uses a separate
 * SQLite file (agents.db) to avoid schema conflicts with tasks.db.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentType = 'worker' | 'orchestrator';
export type AgentScope = 'private' | 'public';
export type AgentStatus = 'pending' | 'spawning' | 'active' | 'idle' | 'done' | 'failed' | 'dissolved';
export type MessageType = 'worker_report' | 'health_alert' | 'cross_team' | 'user_request' | 'directive' | 'task_assignment' | 'escalation' | 'governance_decision' | 'task_result' | 'worker_message';
export type SenderType = 'worker' | 'orchestrator' | 'user' | 'system';
export type ReflectionLevel = 'task' | 'project' | 'pattern' | 'organization';

export interface AgentIdentity {
  id: string;
  role: string;
  type: AgentType;
  scope: AgentScope;
  parentId: string | null;
  nodeId: string | null;
  status: AgentStatus;

  // Authority & security
  authority: string | null;       // JSON: AgentAuthority
  fileScope: string | null;       // JSON array of assigned files
  budgetSpent: number;
  budgetLimit: number;

  // Context
  projectId: string | null;
  workspaceDir: string | null;
  currentTaskId: string | null;
  rolePrompt: string | null;
  contextVersion: string | null;

  // Session & process
  sessionId: string | null;
  pid: number | null;
  persistent: boolean;

  // Orchestrator-specific
  tickIntervalMs: number | null;
  lastTickAt: string | null;
  maxWorkers: number;
  maxChildren: number;

  // Worker-specific
  lastReportAt: string | null;

  // Timestamps
  createdAt: string;
  updatedAt: string | null;
}

export interface InboxMessage {
  id: number;
  recipientId: string;
  senderId: string;
  senderType: SenderType;
  type: MessageType;
  payload: string;              // JSON
  priority: number;             // 0=critical, 1=normal, 2=low
  signature: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface TickLogEntry {
  id: number;
  orchestratorId: string;
  tickNumber: number;
  tier: number;                 // 1=deterministic, 2=AI judgment
  boardSnapshot: string | null;
  aiInput: string | null;
  aiOutput: string | null;
  actionsTaken: string | null;  // JSON
  durationMs: number;
  createdAt: string;
}

export interface Lesson {
  id: number;
  orchestratorId: string;
  projectId: string | null;
  lesson: string;
  source: string | null;
  relevanceTags: string | null; // JSON array
  timesUsed: number;
  confidence: number;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface OrgKnowledge {
  id: number;
  category: string;
  knowledge: string;
  source: string | null;
  relevanceTags: string | null;
  timesUsed: number;
  confidence: number;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Directive {
  id: number;
  targetId: string | null;     // orchestrator ID, or null = all
  content: string;
  addedBy: string;
  active: boolean;
  createdAt: string;
}

export interface Reflection {
  id: number;
  orchestratorId: string;
  level: ReflectionLevel;
  trigger: string;
  inputSummary: string | null;
  output: string;
  lessonsCreated: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS agent_identity (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    type TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'private',
    parent_id TEXT,
    node_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',

    authority TEXT,
    file_scope TEXT,
    budget_spent REAL NOT NULL DEFAULT 0,
    budget_limit REAL NOT NULL DEFAULT 50,

    project_id TEXT,
    workspace_dir TEXT,
    current_task_id TEXT,
    role_prompt TEXT,
    context_version TEXT,

    session_id TEXT,
    pid INTEGER,
    persistent INTEGER NOT NULL DEFAULT 0,

    tick_interval_ms INTEGER,
    last_tick_at TEXT,
    max_workers INTEGER NOT NULL DEFAULT 10,
    max_children INTEGER NOT NULL DEFAULT 5,

    last_report_at TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT,

    FOREIGN KEY (parent_id) REFERENCES agent_identity(id)
  );

  CREATE INDEX IF NOT EXISTS idx_identity_parent ON agent_identity(parent_id);
  CREATE INDEX IF NOT EXISTS idx_identity_project ON agent_identity(project_id);
  CREATE INDEX IF NOT EXISTS idx_identity_status ON agent_identity(status, type);
  CREATE INDEX IF NOT EXISTS idx_identity_node ON agent_identity(node_id);

  CREATE TABLE IF NOT EXISTS message_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    signature TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_recipient ON message_inbox(recipient_id, read_at, priority);
  CREATE INDEX IF NOT EXISTS idx_inbox_sender ON message_inbox(sender_id);

  CREATE TABLE IF NOT EXISTS tick_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestrator_id TEXT NOT NULL,
    tick_number INTEGER NOT NULL,
    tier INTEGER NOT NULL,
    board_snapshot TEXT,
    ai_input TEXT,
    ai_output TEXT,
    actions_taken TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ticklog_orch ON tick_log(orchestrator_id, created_at);

  CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestrator_id TEXT NOT NULL,
    project_id TEXT,
    lesson TEXT NOT NULL,
    source TEXT,
    relevance_tags TEXT,
    times_used INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_lessons_orch ON lessons(orchestrator_id);
  CREATE INDEX IF NOT EXISTS idx_lessons_project ON lessons(project_id);

  CREATE TABLE IF NOT EXISTS org_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    knowledge TEXT NOT NULL,
    source TEXT,
    relevance_tags TEXT,
    times_used INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 1.0,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_orgknow_category ON org_knowledge(category);

  CREATE TABLE IF NOT EXISTS directives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT,
    content TEXT NOT NULL,
    added_by TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_directives_target ON directives(target_id, active);

  CREATE TABLE IF NOT EXISTS reflections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orchestrator_id TEXT NOT NULL,
    level TEXT NOT NULL,
    trigger TEXT NOT NULL,
    input_summary TEXT,
    output TEXT NOT NULL,
    lessons_created INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reflections_orch ON reflections(orchestrator_id, created_at);
`;

// ---------------------------------------------------------------------------
// Row mappers (snake_case → camelCase)
// ---------------------------------------------------------------------------

function rowToIdentity(row: any): AgentIdentity {
  return {
    id: row.id,
    role: row.role,
    type: row.type,
    scope: row.scope,
    parentId: row.parent_id,
    nodeId: row.node_id,
    status: row.status,
    authority: row.authority,
    fileScope: row.file_scope,
    budgetSpent: row.budget_spent,
    budgetLimit: row.budget_limit,
    projectId: row.project_id,
    workspaceDir: row.workspace_dir,
    currentTaskId: row.current_task_id,
    rolePrompt: row.role_prompt,
    contextVersion: row.context_version,
    sessionId: row.session_id,
    pid: row.pid,
    persistent: !!row.persistent,
    tickIntervalMs: row.tick_interval_ms,
    lastTickAt: row.last_tick_at,
    maxWorkers: row.max_workers,
    maxChildren: row.max_children,
    lastReportAt: row.last_report_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: any): InboxMessage {
  return {
    id: row.id,
    recipientId: row.recipient_id,
    senderId: row.sender_id,
    senderType: row.sender_type,
    type: row.type,
    payload: row.payload,
    priority: row.priority,
    signature: row.signature,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

function rowToTickLog(row: any): TickLogEntry {
  return {
    id: row.id,
    orchestratorId: row.orchestrator_id,
    tickNumber: row.tick_number,
    tier: row.tier,
    boardSnapshot: row.board_snapshot,
    aiInput: row.ai_input,
    aiOutput: row.ai_output,
    actionsTaken: row.actions_taken,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

function rowToLesson(row: any): Lesson {
  return {
    id: row.id,
    orchestratorId: row.orchestrator_id,
    projectId: row.project_id,
    lesson: row.lesson,
    source: row.source,
    relevanceTags: row.relevance_tags,
    timesUsed: row.times_used,
    confidence: row.confidence,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function rowToOrgKnowledge(row: any): OrgKnowledge {
  return {
    id: row.id,
    category: row.category,
    knowledge: row.knowledge,
    source: row.source,
    relevanceTags: row.relevance_tags,
    timesUsed: row.times_used,
    confidence: row.confidence,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function rowToDirective(row: any): Directive {
  return {
    id: row.id,
    targetId: row.target_id,
    content: row.content,
    addedBy: row.added_by,
    active: !!row.active,
    createdAt: row.created_at,
  };
}

function rowToReflection(row: any): Reflection {
  return {
    id: row.id,
    orchestratorId: row.orchestrator_id,
    level: row.level,
    trigger: row.trigger,
    inputSummary: row.input_summary,
    output: row.output,
    lessonsCreated: row.lessons_created,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class AgentDatabase {
  private db: Database.Database;

  constructor(dataDir?: string) {
    const dir = dataDir || join(homedir(), '.pando');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const dbPath = join(dir, 'agents.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Expose raw db for transactions that span multiple methods */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // =========================================================================
  // Agent Identity
  // =========================================================================

  createAgent(agent: Omit<AgentIdentity, 'createdAt' | 'updatedAt' | 'budgetSpent'>): AgentIdentity {
    const now = new Date().toISOString();
    const id = agent.id || randomUUID();

    this.db.prepare(`
      INSERT INTO agent_identity (
        id, role, type, scope, parent_id, node_id, status,
        authority, file_scope, budget_spent, budget_limit,
        project_id, workspace_dir, current_task_id, role_prompt, context_version,
        session_id, pid, persistent,
        tick_interval_ms, last_tick_at, max_workers, max_children,
        last_report_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, 0, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      id, agent.role, agent.type, agent.scope ?? 'private', agent.parentId, agent.nodeId, agent.status ?? 'pending',
      agent.authority, agent.fileScope, agent.budgetLimit ?? 50,
      agent.projectId, agent.workspaceDir, agent.currentTaskId, agent.rolePrompt, agent.contextVersion,
      agent.sessionId, agent.pid, agent.persistent ? 1 : 0,
      agent.tickIntervalMs, agent.lastTickAt, agent.maxWorkers ?? 10, agent.maxChildren ?? 5,
      agent.lastReportAt, now, now,
    );

    return this.getAgent(id)!;
  }

  /**
   * Mark all non-persistent active/spawning agents as 'failed' on startup.
   * This handles stale agents left from previous node runs.
   * Persistent orchestrators get reset to 'pending' so they can be re-created cleanly.
   * Returns the number of agents cleaned up.
   */
  cleanupStaleAgents(): number {
    const now = new Date().toISOString();

    // Non-persistent active/spawning agents → failed
    const r1 = this.db.prepare(`
      UPDATE agent_identity SET status = 'failed', updated_at = ?
      WHERE persistent = 0 AND status IN ('active', 'spawning', 'idle')
    `).run(now);

    // Delete persistent orchestrators and their children from previous runs
    // Must delete children first due to FOREIGN KEY (parent_id) constraint
    const orchIds = this.db.prepare(`
      SELECT id FROM agent_identity WHERE type = 'orchestrator' AND persistent = 1
    `).all().map((r: any) => r.id);

    let r2Changes = 0;
    for (const orchId of orchIds) {
      // Delete children (workers) first
      const childResult = this.db.prepare(`
        DELETE FROM agent_identity WHERE parent_id = ?
      `).run(orchId);
      r2Changes += childResult.changes || 0;
      // Then delete the orchestrator
      const orchResult = this.db.prepare(`
        DELETE FROM agent_identity WHERE id = ?
      `).run(orchId);
      r2Changes += orchResult.changes || 0;
    }

    // Clean unread messages for deleted agents
    this.db.prepare(`
      DELETE FROM message_inbox WHERE read_at IS NULL
      AND recipient_id NOT IN (SELECT id FROM agent_identity WHERE status IN ('active', 'spawning', 'idle', 'pending'))
    `).run();

    return (r1.changes || 0) + r2Changes;
  }

  getAgent(id: string): AgentIdentity | null {
    const row = this.db.prepare('SELECT * FROM agent_identity WHERE id = ?').get(id);
    return row ? rowToIdentity(row) : null;
  }

  updateAgent(id: string, fields: Partial<AgentIdentity>): void {
    const sets: string[] = [];
    const values: any[] = [];

    const fieldMap: Record<string, string> = {
      role: 'role', type: 'type', scope: 'scope', parentId: 'parent_id',
      nodeId: 'node_id', status: 'status', authority: 'authority',
      fileScope: 'file_scope', budgetSpent: 'budget_spent', budgetLimit: 'budget_limit',
      projectId: 'project_id', workspaceDir: 'workspace_dir',
      currentTaskId: 'current_task_id', rolePrompt: 'role_prompt',
      contextVersion: 'context_version', sessionId: 'session_id',
      pid: 'pid', persistent: 'persistent',
      tickIntervalMs: 'tick_interval_ms', lastTickAt: 'last_tick_at',
      maxWorkers: 'max_workers', maxChildren: 'max_children',
      lastReportAt: 'last_report_at',
    };

    for (const [key, val] of Object.entries(fields)) {
      const col = fieldMap[key];
      if (!col) continue;
      sets.push(`${col} = ?`);
      values.push(key === 'persistent' ? (val ? 1 : 0) : val);
    }

    if (sets.length === 0) return;

    sets.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(id);

    this.db.prepare(`UPDATE agent_identity SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteAgent(id: string): void {
    this.db.prepare('DELETE FROM agent_identity WHERE id = ?').run(id);
  }

  listAgents(filter?: { type?: AgentType; status?: AgentStatus; parentId?: string; projectId?: string; nodeId?: string; role?: string }): AgentIdentity[] {
    let sql = 'SELECT * FROM agent_identity WHERE 1=1';
    const params: any[] = [];

    if (filter?.type) { sql += ' AND type = ?'; params.push(filter.type); }
    if (filter?.status) { sql += ' AND status = ?'; params.push(filter.status); }
    if (filter?.parentId) { sql += ' AND parent_id = ?'; params.push(filter.parentId); }
    if (filter?.projectId) { sql += ' AND project_id = ?'; params.push(filter.projectId); }
    if (filter?.nodeId) { sql += ' AND node_id = ?'; params.push(filter.nodeId); }
    if (filter?.role) { sql += ' AND role = ?'; params.push(filter.role); }

    sql += ' ORDER BY created_at DESC';
    return this.db.prepare(sql).all(...params).map(rowToIdentity);
  }

  getChildren(parentId: string): AgentIdentity[] {
    return this.db.prepare('SELECT * FROM agent_identity WHERE parent_id = ? ORDER BY created_at')
      .all(parentId).map(rowToIdentity);
  }

  getActiveWorkers(orchestratorId: string): AgentIdentity[] {
    return this.db.prepare(
      `SELECT * FROM agent_identity WHERE parent_id = ? AND type = 'worker' AND status IN ('spawning', 'active', 'idle') ORDER BY created_at`
    ).all(orchestratorId).map(rowToIdentity);
  }

  /** Recursive CTE to get full hierarchy tree from a root */
  getTree(rootId?: string): AgentIdentity[] {
    if (rootId) {
      return this.db.prepare(`
        WITH RECURSIVE tree AS (
          SELECT * FROM agent_identity WHERE id = ?
          UNION ALL
          SELECT ai.* FROM agent_identity ai JOIN tree t ON ai.parent_id = t.id
        )
        SELECT * FROM tree ORDER BY created_at
      `).all(rootId).map(rowToIdentity);
    }
    // All top-level agents (no parent) and their descendants
    return this.db.prepare(`
      WITH RECURSIVE tree AS (
        SELECT * FROM agent_identity WHERE parent_id IS NULL
        UNION ALL
        SELECT ai.* FROM agent_identity ai JOIN tree t ON ai.parent_id = t.id
      )
      SELECT * FROM tree ORDER BY created_at
    `).all().map(rowToIdentity);
  }

  // =========================================================================
  // Message Inbox
  // =========================================================================

  sendMessage(msg: { recipientId: string; senderId: string; senderType: SenderType; type: MessageType; payload: string; priority?: number; signature?: string }): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO message_inbox (recipient_id, sender_id, sender_type, type, payload, priority, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msg.recipientId, msg.senderId, msg.senderType, msg.type, msg.payload, msg.priority ?? 1, msg.signature ?? null, now);
    return Number(result.lastInsertRowid);
  }

  readInbox(recipientId: string, limit = 50): InboxMessage[] {
    return this.db.prepare(`
      SELECT * FROM message_inbox
      WHERE recipient_id = ? AND read_at IS NULL
      ORDER BY priority ASC, created_at ASC
      LIMIT ?
    `).all(recipientId, limit).map(rowToMessage);
  }

  markRead(messageIds: number[]): void {
    if (messageIds.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = messageIds.map(() => '?').join(',');
    this.db.prepare(`UPDATE message_inbox SET read_at = ? WHERE id IN (${placeholders})`).run(now, ...messageIds);
  }

  getMessage(id: number): InboxMessage | null {
    const row = this.db.prepare('SELECT * FROM message_inbox WHERE id = ?').get(id);
    return row ? rowToMessage(row) : null;
  }

  cleanupMessages(olderThanDays = 7): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const result = this.db.prepare('DELETE FROM message_inbox WHERE read_at IS NOT NULL AND created_at < ?').run(cutoff);
    return result.changes;
  }

  // =========================================================================
  // Tick Log
  // =========================================================================

  logTick(entry: Omit<TickLogEntry, 'id' | 'createdAt'>): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO tick_log (orchestrator_id, tick_number, tier, board_snapshot, ai_input, ai_output, actions_taken, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(entry.orchestratorId, entry.tickNumber, entry.tier, entry.boardSnapshot, entry.aiInput, entry.aiOutput, entry.actionsTaken, entry.durationMs, now);
    return Number(result.lastInsertRowid);
  }

  getTickLog(orchestratorId: string, limit = 20): TickLogEntry[] {
    return this.db.prepare(`
      SELECT * FROM tick_log WHERE orchestrator_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(orchestratorId, limit).map(rowToTickLog);
  }

  getLatestTickNumber(orchestratorId: string): number {
    const row = this.db.prepare('SELECT MAX(tick_number) as n FROM tick_log WHERE orchestrator_id = ?').get(orchestratorId) as any;
    return row?.n ?? 0;
  }

  // =========================================================================
  // Lessons
  // =========================================================================

  addLesson(lesson: { orchestratorId: string; projectId?: string; lesson: string; source?: string; relevanceTags?: string[]; confidence?: number }): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO lessons (orchestrator_id, project_id, lesson, source, relevance_tags, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(lesson.orchestratorId, lesson.projectId ?? null, lesson.lesson, lesson.source ?? null,
      lesson.relevanceTags ? JSON.stringify(lesson.relevanceTags) : null, lesson.confidence ?? 1.0, now);
    return Number(result.lastInsertRowid);
  }

  getLessons(filter: { orchestratorId?: string; projectId?: string; role?: string; minConfidence?: number; limit?: number }): Lesson[] {
    let sql = 'SELECT * FROM lessons WHERE confidence >= ?';
    const params: any[] = [filter.minConfidence ?? 0.3];

    if (filter.orchestratorId) { sql += ' AND orchestrator_id = ?'; params.push(filter.orchestratorId); }
    if (filter.projectId) { sql += ' AND project_id = ?'; params.push(filter.projectId); }
    if (filter.role) { sql += ' AND relevance_tags LIKE ?'; params.push(`%${filter.role}%`); }

    sql += ' ORDER BY times_used DESC, created_at DESC LIMIT ?';
    params.push(filter.limit ?? 10);

    return this.db.prepare(sql).all(...params).map(rowToLesson);
  }

  incrementLessonUse(id: number): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE lessons SET times_used = times_used + 1, last_used_at = ? WHERE id = ?').run(now, id);
  }

  adjustLessonConfidence(id: number, delta: number): void {
    this.db.prepare('UPDATE lessons SET confidence = MAX(0, MIN(1, confidence + ?)) WHERE id = ?').run(delta, id);
  }

  // =========================================================================
  // Org Knowledge
  // =========================================================================

  addOrgKnowledge(entry: { category: string; knowledge: string; source?: string; relevanceTags?: string[] }): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO org_knowledge (category, knowledge, source, relevance_tags, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entry.category, entry.knowledge, entry.source ?? null,
      entry.relevanceTags ? JSON.stringify(entry.relevanceTags) : null, now);
    return Number(result.lastInsertRowid);
  }

  getOrgKnowledge(filter?: { category?: string; role?: string; limit?: number }): OrgKnowledge[] {
    let sql = 'SELECT * FROM org_knowledge WHERE confidence >= 0.3';
    const params: any[] = [];

    if (filter?.category) { sql += ' AND category = ?'; params.push(filter.category); }
    if (filter?.role) { sql += ' AND relevance_tags LIKE ?'; params.push(`%${filter.role}%`); }

    sql += ' ORDER BY times_used DESC, created_at DESC LIMIT ?';
    params.push(filter?.limit ?? 10);

    return this.db.prepare(sql).all(...params).map(rowToOrgKnowledge);
  }

  // =========================================================================
  // Directives
  // =========================================================================

  addDirective(directive: { targetId?: string; content: string; addedBy: string }): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO directives (target_id, content, added_by, active, created_at)
      VALUES (?, ?, ?, 1, ?)
    `).run(directive.targetId ?? null, directive.content, directive.addedBy, now);
    return Number(result.lastInsertRowid);
  }

  getDirectives(targetId?: string): Directive[] {
    return this.db.prepare(`
      SELECT * FROM directives
      WHERE active = 1 AND (target_id = ? OR target_id IS NULL)
      ORDER BY created_at ASC
    `).all(targetId ?? null).map(rowToDirective);
  }

  deactivateDirective(id: number): void {
    this.db.prepare('UPDATE directives SET active = 0 WHERE id = ?').run(id);
  }

  // =========================================================================
  // Reflections
  // =========================================================================

  addReflection(reflection: { orchestratorId: string; level: ReflectionLevel; trigger: string; inputSummary?: string; output: string; lessonsCreated?: number }): number {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO reflections (orchestrator_id, level, trigger, input_summary, output, lessons_created, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(reflection.orchestratorId, reflection.level, reflection.trigger,
      reflection.inputSummary ?? null, reflection.output, reflection.lessonsCreated ?? 0, now);
    return Number(result.lastInsertRowid);
  }

  getReflections(orchestratorId: string, limit = 10): Reflection[] {
    return this.db.prepare(`
      SELECT * FROM reflections WHERE orchestrator_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(orchestratorId, limit).map(rowToReflection);
  }
}
