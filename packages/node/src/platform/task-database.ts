/**
 * Task Database — SQLite-backed storage for the task queue.
 *
 * Replaces the JSON file (tasks.json) with a proper SQLite database (tasks.db).
 * Follows the same pattern as packages/ledger/src/database.ts: WAL mode, prepared
 * statements, row-to-object mappers.
 *
 * All SQL lives here. task-queue.ts calls into TaskDatabase for persistence.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  Task,
  TaskStatus,
  TaskPriority,
  TaskResult,
  TaskCost,
  TaskTimelineEvent,
  TaskRoleMetadata,
} from './task-queue.js';
import type { ThreadMessage, QaTier } from '@pando/shared';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'medium',
    created_by TEXT NOT NULL DEFAULT '',
    assigned_to TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    origin TEXT,
    origin_node TEXT,
    claimed_by_node TEXT,
    claimed_at INTEGER,
    executed_by_node TEXT,
    parent_task TEXT,
    proposal_id TEXT,
    qa_tier TEXT,
    required_capabilities TEXT,
    manager_id TEXT,
    -- Result fields (denormalized for query speed)
    result_commit_hash TEXT,
    result_build_passed INTEGER,
    result_tests_passed INTEGER,
    result_approved INTEGER,
    result_approved_by TEXT,
    result_note TEXT,
    -- Cost fields (denormalized)
    cost_input_tokens INTEGER,
    cost_output_tokens INTEGER,
    cost_usd REAL,
    cost_duration_ms INTEGER,
    cost_tier TEXT,
    cost_model TEXT,
    -- Role metadata (denormalized)
    role_id TEXT,
    role_responsibility TEXT,
    role_project_id TEXT,
    role_verification_needed INTEGER
  );

  CREATE TABLE IF NOT EXISTS task_files (
    task_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    PRIMARY KEY (task_id, file_path)
  );

  CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on)
  );

  CREATE TABLE IF NOT EXISTS task_children (
    parent_id TEXT NOT NULL,
    child_id TEXT NOT NULL,
    PRIMARY KEY (parent_id, child_id)
  );

  CREATE TABLE IF NOT EXISTS task_timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS task_thread_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    from_peer TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
  CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
  CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority);
  CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task);
  CREATE INDEX IF NOT EXISTS idx_tasks_proposal ON tasks(proposal_id);
  CREATE INDEX IF NOT EXISTS idx_task_timeline_task ON task_timeline(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_thread_task ON task_thread_messages(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_files_path ON task_files(file_path);
`;

// ---------------------------------------------------------------------------
// Database initializer (follows ledger/database.ts pattern)
// ---------------------------------------------------------------------------

export function openTaskDatabase(dataDir?: string): Database.Database {
  const dir = dataDir || join(homedir(), '.pando', 'agent');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const dbPath = join(dir, 'tasks.db');
  const db = new Database(dbPath);

  // Performance settings (same as ledger)
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Create schema
  db.exec(SCHEMA);

  // Migrations for existing databases
  const columns = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));
  if (!colNames.has('manager_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN manager_id TEXT');
  }

  return db;
}

// ---------------------------------------------------------------------------
// Priority ranking (used for ORDER BY)
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ---------------------------------------------------------------------------
// TaskDatabase class — all CRUD operations
// ---------------------------------------------------------------------------

export class TaskDatabase {
  private db: Database.Database;

  // Prepared statements (lazily created but cached for reuse)
  private stmtInsertTask: Database.Statement;
  private stmtGetTask: Database.Statement;
  private stmtUpdateTask: Database.Statement;
  private stmtInsertFile: Database.Statement;
  private stmtDeleteFiles: Database.Statement;
  private stmtGetFiles: Database.Statement;
  private stmtInsertDep: Database.Statement;
  private stmtDeleteDeps: Database.Statement;
  private stmtGetDeps: Database.Statement;
  private stmtInsertChild: Database.Statement;
  private stmtDeleteChildren: Database.Statement;
  private stmtGetChildren: Database.Statement;
  private stmtInsertTimeline: Database.Statement;
  private stmtGetTimeline: Database.Statement;
  private stmtInsertThread: Database.Statement;
  private stmtGetThread: Database.Statement;
  private stmtCount: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // ---- Prepare all statements ----

    this.stmtInsertTask = db.prepare(`
      INSERT OR IGNORE INTO tasks (
        id, title, description, status, priority, created_by, assigned_to,
        created_at, updated_at, origin, origin_node, claimed_by_node, claimed_at,
        executed_by_node, parent_task, proposal_id, qa_tier, required_capabilities,
        manager_id,
        result_commit_hash, result_build_passed, result_tests_passed,
        result_approved, result_approved_by, result_note,
        cost_input_tokens, cost_output_tokens, cost_usd, cost_duration_ms,
        cost_tier, cost_model,
        role_id, role_responsibility, role_project_id, role_verification_needed
      ) VALUES (
        @id, @title, @description, @status, @priority, @created_by, @assigned_to,
        @created_at, @updated_at, @origin, @origin_node, @claimed_by_node, @claimed_at,
        @executed_by_node, @parent_task, @proposal_id, @qa_tier, @required_capabilities,
        @manager_id,
        @result_commit_hash, @result_build_passed, @result_tests_passed,
        @result_approved, @result_approved_by, @result_note,
        @cost_input_tokens, @cost_output_tokens, @cost_usd, @cost_duration_ms,
        @cost_tier, @cost_model,
        @role_id, @role_responsibility, @role_project_id, @role_verification_needed
      )
    `);

    this.stmtGetTask = db.prepare('SELECT * FROM tasks WHERE id = ?');

    // updateTask is dynamic — built per call (see updateTask method)
    this.stmtUpdateTask = db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');

    this.stmtInsertFile = db.prepare('INSERT OR IGNORE INTO task_files (task_id, file_path) VALUES (?, ?)');
    this.stmtDeleteFiles = db.prepare('DELETE FROM task_files WHERE task_id = ?');
    this.stmtGetFiles = db.prepare('SELECT file_path FROM task_files WHERE task_id = ?');

    this.stmtInsertDep = db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)');
    this.stmtDeleteDeps = db.prepare('DELETE FROM task_dependencies WHERE task_id = ?');
    this.stmtGetDeps = db.prepare('SELECT depends_on FROM task_dependencies WHERE task_id = ?');

    this.stmtInsertChild = db.prepare('INSERT OR IGNORE INTO task_children (parent_id, child_id) VALUES (?, ?)');
    this.stmtDeleteChildren = db.prepare('DELETE FROM task_children WHERE parent_id = ?');
    this.stmtGetChildren = db.prepare('SELECT child_id FROM task_children WHERE parent_id = ?');

    this.stmtInsertTimeline = db.prepare(
      'INSERT INTO task_timeline (task_id, timestamp, event, detail, metadata) VALUES (?, ?, ?, ?, ?)'
    );
    this.stmtGetTimeline = db.prepare(
      'SELECT timestamp, event, detail, metadata FROM task_timeline WHERE task_id = ? ORDER BY id ASC'
    );

    this.stmtInsertThread = db.prepare(
      'INSERT OR IGNORE INTO task_thread_messages (id, task_id, from_peer, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.stmtGetThread = db.prepare(
      'SELECT id, task_id, from_peer, role, content, created_at FROM task_thread_messages WHERE task_id = ? ORDER BY created_at ASC'
    );

    this.stmtCount = db.prepare('SELECT COUNT(*) AS cnt FROM tasks');
  }

  // =========================================================================
  // Insert
  // =========================================================================

  insertTask(task: Task): void {
    const row = this.taskToRow(task);
    this.stmtInsertTask.run(row);
  }

  // =========================================================================
  // Query — single task (full, with relations)
  // =========================================================================

  getTask(id: string): Task | null {
    const row = this.stmtGetTask.get(id) as any;
    if (!row) return null;
    return this.assembleFullTask(row);
  }

  // =========================================================================
  // Query — multiple tasks (lightweight, no timeline/thread by default)
  // =========================================================================

  getTasks(opts?: {
    status?: string | string[];
    priority?: string;
    assignedTo?: string;
    limit?: number;
  }): Task[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts?.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    } else {
      conditions.push("status NOT IN ('archived', 'expired')");
    }
    if (opts?.priority) {
      conditions.push('priority = ?');
      params.push(opts.priority);
    }
    if (opts?.assignedTo) {
      conditions.push('assigned_to = ?');
      params.push(opts.assignedTo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Sort by priority rank then created_at.
    // SQLite CASE expression maps priority text to numeric rank.
    let sql = `SELECT * FROM tasks ${where} ORDER BY
      CASE priority
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 4
      END ASC,
      created_at ASC`;

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => this.rowToTask(r));
  }

  /**
   * Get next claimable task (open, no file conflict, dependencies met, not claimed by another node).
   */
  getNextClaimable(localPeerId?: string, agentId?: string): Task | null {
    // Get open tasks ordered by priority
    const openTasks = this.getTasks({ status: 'open' });

    // Get files locked by active tasks
    const activeRows = this.db.prepare(
      "SELECT id FROM tasks WHERE status IN ('claimed', 'in_progress')"
    ).all() as Array<{ id: string }>;
    const lockedFiles = new Set<string>();
    for (const ar of activeRows) {
      const files = this.getFiles(ar.id);
      for (const f of files) lockedFiles.add(f);
    }

    // Get IDs of done tasks for dependency checking
    const doneRows = this.db.prepare(
      "SELECT id FROM tasks WHERE status = 'done'"
    ).all() as Array<{ id: string }>;
    const doneIds = new Set(doneRows.map(r => r.id));

    for (const task of openTasks) {
      // File conflict check
      if (task.files.some(f => lockedFiles.has(f))) continue;
      // Dependency check
      if (!task.dependencies.every(d => doneIds.has(d))) continue;
      // Cross-node check
      if (task.claimedByNode && localPeerId && task.claimedByNode !== localPeerId) continue;
      return task;
    }

    return null;
  }

  /**
   * Get tasks claimed by a specific agent.
   */
  getClaimedTasks(agentId: string): Task[] {
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE assigned_to = ? AND status IN ('claimed', 'in_progress')
       ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC, created_at ASC`
    ).all(agentId) as any[];
    return rows.map(r => this.rowToTask(r));
  }

  /**
   * Get all active tasks (open, claimed, in_progress).
   */
  getActiveTasks(): Task[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE status IN ('open', 'claimed', 'in_progress') ORDER BY created_at ASC"
    ).all() as any[];
    // Return full tasks (with timeline/thread) for sync purposes
    return rows.map(r => this.assembleFullTask(r));
  }

  /**
   * Get task status counts.
   */
  getStats(): Record<string, number> {
    const totalRow = this.stmtCount.get() as any;
    const total = totalRow?.cnt || 0;

    const statusRows = this.db.prepare(
      'SELECT status, COUNT(*) AS cnt FROM tasks GROUP BY status'
    ).all() as Array<{ status: string; cnt: number }>;

    const stats: Record<string, number> = { total };
    for (const row of statusRows) {
      stats[row.status] = row.cnt;
    }
    return stats;
  }

  /**
   * Aggregate cost stats.
   */
  getCostStats(): {
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalDurationMs: number;
    taskCount: number;
    byTier: Record<string, { count: number; costUsd: number; tokens: number }>;
  } {
    const aggRow = this.db.prepare(`
      SELECT
        COUNT(*) AS task_count,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(cost_input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(cost_output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(cost_duration_ms), 0) AS total_duration_ms
      FROM tasks WHERE cost_usd IS NOT NULL OR cost_input_tokens IS NOT NULL
    `).get() as any;

    const tierRows = this.db.prepare(`
      SELECT
        COALESCE(cost_tier, 'unknown') AS tier,
        COUNT(*) AS cnt,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(cost_input_tokens), 0) + COALESCE(SUM(cost_output_tokens), 0) AS tokens
      FROM tasks
      WHERE cost_usd IS NOT NULL OR cost_input_tokens IS NOT NULL
      GROUP BY COALESCE(cost_tier, 'unknown')
    `).all() as Array<{ tier: string; cnt: number; cost_usd: number; tokens: number }>;

    const byTier: Record<string, { count: number; costUsd: number; tokens: number }> = {};
    for (const row of tierRows) {
      byTier[row.tier] = { count: row.cnt, costUsd: row.cost_usd, tokens: row.tokens };
    }

    return {
      totalCostUsd: aggRow.total_cost_usd,
      totalInputTokens: aggRow.total_input_tokens,
      totalOutputTokens: aggRow.total_output_tokens,
      totalDurationMs: aggRow.total_duration_ms,
      taskCount: aggRow.task_count,
      byTier,
    };
  }

  /**
   * Check if a task with the given ID exists.
   */
  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM tasks WHERE id = ? LIMIT 1').get(id);
    return !!row;
  }

  /**
   * Find a task by proposalId.
   */
  findByProposalId(proposalId: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE proposal_id = ? LIMIT 1').get(proposalId) as any;
    if (!row) return null;
    return this.rowToTask(row);
  }

  /**
   * Get active tasks (open/claimed/in_progress) for dedup checking.
   * Returns lightweight tasks without timeline/thread.
   */
  getActiveTasksForDedup(): Task[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE status IN ('open', 'claimed', 'in_progress')"
    ).all() as any[];
    return rows.map(r => this.rowToTask(r));
  }

  // =========================================================================
  // Update
  // =========================================================================

  /**
   * Dynamically update task fields. Only updates columns present in the fields object.
   */
  updateTask(id: string, fields: Record<string, any>): boolean {
    if (Object.keys(fields).length === 0) return true;

    const setClauses: string[] = [];
    const params: any[] = [];

    for (const [key, value] of Object.entries(fields)) {
      setClauses.push(`${key} = ?`);
      params.push(value === undefined ? null : value);
    }

    // Always update updated_at
    if (!fields.updated_at) {
      setClauses.push('updated_at = ?');
      params.push(Date.now());
    }

    params.push(id);
    const sql = `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`;
    const result = this.db.prepare(sql).run(...params);
    return result.changes > 0;
  }

  getArchivedTasks(limit: number = 50): Task[] {
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE status = 'archived' ORDER BY updated_at DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(r => this.rowToTask(r));
  }

  archiveTasks(olderThanMs: number): number {
    const now = Date.now();
    const cutoff = now - olderThanMs;
    const result = this.db.prepare(
      "UPDATE tasks SET status = 'archived', updated_at = ? WHERE status IN ('done', 'rejected') AND updated_at < ?"
    ).run(now, cutoff);
    return result.changes;
  }

  /**
   * Cleanup expired tasks:
   * 1. Open tasks older than 48h → mark as "expired"
   * 2. Claimed tasks older than 2h → reset to "open" (so they can be reclaimed)
   * 3. In-progress tasks older than 4h → reset to "open" (so they can be reclaimed)
   * 4. Done/rejected/expired tasks older than 7 days → delete entirely
   * Returns { expired, removed } counts.
   */
  cleanupExpiredTasks(): { expired: number; removed: number } {
    const now = Date.now();
    const expireCutoff = now - (48 * 60 * 60 * 1000);    // 48 hours
    const claimedCutoff = now - (2 * 60 * 60 * 1000);     // 2 hours
    const inProgressCutoff = now - (4 * 60 * 60 * 1000);  // 4 hours
    const removeCutoff = now - (7 * 24 * 60 * 60 * 1000); // 7 days

    // Step 1: Expire stale open tasks (>48h old)
    const expireResult = this.db.prepare(
      "UPDATE tasks SET status = 'expired', updated_at = ? WHERE status = 'open' AND created_at < ?"
    ).run(now, expireCutoff);

    // Step 2: Reset stale claimed tasks (>2h) back to open so they can be reclaimed
    const claimedResult = this.db.prepare(
      "UPDATE tasks SET status = 'open', claimed_by_node = NULL, claimed_at = NULL, assigned_to = NULL, updated_at = ? WHERE status = 'claimed' AND claimed_at < ?"
    ).run(now, claimedCutoff);

    // Step 3: Reset stale in_progress tasks (>4h) back to open so they can be reclaimed
    const inProgressResult = this.db.prepare(
      "UPDATE tasks SET status = 'open', claimed_by_node = NULL, claimed_at = NULL, assigned_to = NULL, executed_by_node = NULL, updated_at = ? WHERE status = 'in_progress' AND updated_at < ?"
    ).run(now, inProgressCutoff);

    // Step 4: Delete old terminal tasks (done/rejected/expired >7 days old)
    // First get the IDs so we can clean up related tables
    const oldTerminalRows = this.db.prepare(
      "SELECT id FROM tasks WHERE status IN ('done', 'rejected', 'expired') AND updated_at < ?"
    ).all(removeCutoff) as Array<{ id: string }>;

    let removed = 0;
    if (oldTerminalRows.length > 0) {
      const deleteFiles = this.db.prepare('DELETE FROM task_files WHERE task_id = ?');
      const deleteDeps = this.db.prepare('DELETE FROM task_dependencies WHERE task_id = ?');
      const deleteChildren = this.db.prepare('DELETE FROM task_children WHERE parent_id = ?');
      const deleteTimeline = this.db.prepare('DELETE FROM task_timeline WHERE task_id = ?');
      const deleteThread = this.db.prepare('DELETE FROM task_thread_messages WHERE task_id = ?');
      const deleteTask = this.db.prepare('DELETE FROM tasks WHERE id = ?');

      const deleteAll = this.db.transaction((ids: string[]) => {
        for (const id of ids) {
          deleteFiles.run(id);
          deleteDeps.run(id);
          deleteChildren.run(id);
          deleteTimeline.run(id);
          deleteThread.run(id);
          deleteTask.run(id);
        }
      });

      const ids = oldTerminalRows.map(r => r.id);
      deleteAll(ids);
      removed = ids.length;
    }

    return { expired: expireResult.changes + claimedResult.changes + inProgressResult.changes, removed };
  }

  // =========================================================================
  // Timeline
  // =========================================================================

  insertTimelineEvent(taskId: string, event: TaskTimelineEvent): void {
    this.stmtInsertTimeline.run(
      taskId,
      event.timestamp,
      event.event,
      event.detail,
      event.metadata ? JSON.stringify(event.metadata) : null,
    );
  }

  getTimeline(taskId: string): TaskTimelineEvent[] {
    const rows = this.stmtGetTimeline.all(taskId) as Array<{
      timestamp: string;
      event: string;
      detail: string;
      metadata: string | null;
    }>;
    return rows.map(r => ({
      timestamp: r.timestamp,
      event: r.event,
      detail: r.detail,
      ...(r.metadata ? { metadata: JSON.parse(r.metadata) } : {}),
    }));
  }

  /**
   * Check if a timeline event with the same timestamp + event type already exists.
   */
  hasTimelineEvent(taskId: string, timestamp: string, event: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM task_timeline WHERE task_id = ? AND timestamp = ? AND event = ? LIMIT 1'
    ).get(taskId, timestamp, event);
    return !!row;
  }

  // =========================================================================
  // Thread (conversation messages)
  // =========================================================================

  insertThreadMessage(msg: ThreadMessage): void {
    this.stmtInsertThread.run(
      msg.id,
      msg.taskId,
      msg.from,
      msg.role,
      msg.content,
      msg.createdAt,
    );
  }

  getThread(taskId: string): ThreadMessage[] {
    const rows = this.stmtGetThread.all(taskId) as Array<{
      id: string;
      task_id: string;
      from_peer: string;
      role: string;
      content: string;
      created_at: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      from: r.from_peer,
      role: r.role as 'user' | 'agent' | 'system',
      content: r.content,
      createdAt: r.created_at,
    }));
  }

  // =========================================================================
  // Files
  // =========================================================================

  setFiles(taskId: string, files: string[]): void {
    this.stmtDeleteFiles.run(taskId);
    for (const f of files) {
      this.stmtInsertFile.run(taskId, f);
    }
  }

  getFiles(taskId: string): string[] {
    const rows = this.stmtGetFiles.all(taskId) as Array<{ file_path: string }>;
    return rows.map(r => r.file_path);
  }

  /**
   * Get all files locked by active (claimed/in_progress) tasks.
   */
  getLockedFiles(): Set<string> {
    const rows = this.db.prepare(`
      SELECT tf.file_path FROM task_files tf
      INNER JOIN tasks t ON tf.task_id = t.id
      WHERE t.status IN ('claimed', 'in_progress')
    `).all() as Array<{ file_path: string }>;
    return new Set(rows.map(r => r.file_path));
  }

  /**
   * Check if any file in the list conflicts with active tasks.
   */
  getConflictingFiles(taskId: string, files: string[]): string | null {
    if (files.length === 0) return null;
    const lockedFiles = this.getLockedFiles();
    for (const f of files) {
      if (lockedFiles.has(f)) return f;
    }
    return null;
  }

  // =========================================================================
  // Dependencies
  // =========================================================================

  setDependencies(taskId: string, deps: string[]): void {
    this.stmtDeleteDeps.run(taskId);
    for (const d of deps) {
      this.stmtInsertDep.run(taskId, d);
    }
  }

  getDependencies(taskId: string): string[] {
    const rows = this.stmtGetDeps.all(taskId) as Array<{ depends_on: string }>;
    return rows.map(r => r.depends_on);
  }

  /**
   * Check if all dependencies of a task are done.
   */
  areDependenciesMet(taskId: string): boolean {
    const deps = this.getDependencies(taskId);
    if (deps.length === 0) return true;
    const placeholders = deps.map(() => '?').join(',');
    const row = this.db.prepare(
      `SELECT COUNT(*) AS cnt FROM tasks WHERE id IN (${placeholders}) AND status = 'done'`
    ).get(...deps) as any;
    return row.cnt === deps.length;
  }

  /**
   * Find the first unmet dependency for a task.
   */
  getUnmetDependency(taskId: string): string | null {
    const deps = this.getDependencies(taskId);
    if (deps.length === 0) return null;
    for (const depId of deps) {
      const row = this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'done' LIMIT 1").get(depId);
      if (!row) return depId;
    }
    return null;
  }

  // =========================================================================
  // Children
  // =========================================================================

  setChildren(parentId: string, childIds: string[]): void {
    this.stmtDeleteChildren.run(parentId);
    for (const c of childIds) {
      this.stmtInsertChild.run(parentId, c);
    }
  }

  getChildren(parentId: string): string[] {
    const rows = this.stmtGetChildren.all(parentId) as Array<{ child_id: string }>;
    return rows.map(r => r.child_id);
  }

  // =========================================================================
  // Transaction helper (expose db.transaction for atomic multi-row ops)
  // =========================================================================

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // =========================================================================
  // All tasks (for getAgentSummary and autoComplete)
  // =========================================================================

  getAllTasks(): Task[] {
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE status NOT IN ('archived', 'expired') ORDER BY
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC,
        created_at ASC`
    ).all() as any[];
    return rows.map(r => this.rowToTask(r));
  }

  // =========================================================================
  // Row mapping: Task <-> SQL row
  // =========================================================================

  private taskToRow(task: Task): Record<string, any> {
    return {
      id: task.id,
      title: task.title,
      description: task.description || '',
      status: task.status,
      priority: task.priority,
      created_by: task.createdBy || '',
      assigned_to: task.assignedTo ?? null,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      origin: task.origin ?? null,
      origin_node: task.originNode ?? null,
      claimed_by_node: task.claimedByNode ?? null,
      claimed_at: task.claimedAt ?? null,
      executed_by_node: task.executedByNode ?? null,
      parent_task: task.parentTask ?? null,
      proposal_id: task.proposalId ?? null,
      qa_tier: task.qaTier ?? null,
      required_capabilities: task.requiredCapabilities ? JSON.stringify(task.requiredCapabilities) : null,
      manager_id: task.managerId ?? null,
      // Result
      result_commit_hash: task.result?.commitHash ?? null,
      result_build_passed: task.result?.buildPassed != null ? (task.result.buildPassed ? 1 : 0) : null,
      result_tests_passed: task.result?.testsPassed != null ? (task.result.testsPassed ? 1 : 0) : null,
      result_approved: task.result?.approved != null ? (task.result.approved ? 1 : 0) : null,
      result_approved_by: task.result?.approvedBy ?? null,
      result_note: task.result?.note ?? null,
      // Cost
      cost_input_tokens: task.cost?.inputTokens ?? null,
      cost_output_tokens: task.cost?.outputTokens ?? null,
      cost_usd: task.cost?.costUsd ?? null,
      cost_duration_ms: task.cost?.durationMs ?? null,
      cost_tier: task.cost?.tier ?? null,
      cost_model: task.cost?.model ?? null,
      // Role metadata
      role_id: task.roleMetadata?.roleId ?? null,
      role_responsibility: task.roleMetadata?.responsibility ?? null,
      role_project_id: task.roleMetadata?.projectId ?? null,
      role_verification_needed: task.roleMetadata?.verificationNeeded != null ? (task.roleMetadata.verificationNeeded ? 1 : 0) : null,
    };
  }

  /**
   * Convert a SQL row to a Task object (lightweight, no timeline/thread/children).
   * Used by getTasks() for list queries.
   */
  private rowToTask(row: any): Task {
    const task: Task = {
      id: row.id,
      title: row.title,
      description: row.description || '',
      status: row.status as TaskStatus,
      priority: row.priority as TaskPriority,
      createdBy: row.created_by || '',
      assignedTo: row.assigned_to || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      files: this.getFiles(row.id),
      dependencies: this.getDependencies(row.id),
    };

    // Optional fields — only set if present
    if (row.origin) task.origin = row.origin;
    if (row.origin_node) task.originNode = row.origin_node;
    if (row.claimed_by_node) task.claimedByNode = row.claimed_by_node;
    if (row.claimed_at) task.claimedAt = row.claimed_at;
    if (row.executed_by_node) task.executedByNode = row.executed_by_node;
    if (row.parent_task) task.parentTask = row.parent_task;
    if (row.proposal_id) task.proposalId = row.proposal_id;
    if (row.qa_tier) task.qaTier = row.qa_tier as QaTier;
    if (row.required_capabilities) {
      try { task.requiredCapabilities = JSON.parse(row.required_capabilities); } catch {}
    }
    if (row.manager_id) task.managerId = row.manager_id;

    // Result (only if any result field is set)
    if (row.result_commit_hash != null || row.result_build_passed != null || row.result_tests_passed != null ||
        row.result_approved != null || row.result_approved_by != null || row.result_note != null) {
      task.result = {};
      if (row.result_commit_hash != null) task.result.commitHash = row.result_commit_hash;
      if (row.result_build_passed != null) task.result.buildPassed = !!row.result_build_passed;
      if (row.result_tests_passed != null) task.result.testsPassed = !!row.result_tests_passed;
      if (row.result_approved != null) task.result.approved = !!row.result_approved;
      if (row.result_approved_by != null) task.result.approvedBy = row.result_approved_by;
      if (row.result_note != null) task.result.note = row.result_note;
    }

    // Cost (only if any cost field is set)
    if (row.cost_input_tokens != null || row.cost_output_tokens != null || row.cost_usd != null ||
        row.cost_duration_ms != null || row.cost_tier != null || row.cost_model != null) {
      task.cost = {};
      if (row.cost_input_tokens != null) task.cost.inputTokens = row.cost_input_tokens;
      if (row.cost_output_tokens != null) task.cost.outputTokens = row.cost_output_tokens;
      if (row.cost_usd != null) task.cost.costUsd = row.cost_usd;
      if (row.cost_duration_ms != null) task.cost.durationMs = row.cost_duration_ms;
      if (row.cost_tier != null) task.cost.tier = row.cost_tier;
      if (row.cost_model != null) task.cost.model = row.cost_model;
    }

    // Role metadata (only if any role field is set)
    if (row.role_id != null || row.role_responsibility != null) {
      task.roleMetadata = {
        roleId: row.role_id || '',
        responsibility: row.role_responsibility || '',
        projectId: row.role_project_id || '',
        verificationNeeded: !!row.role_verification_needed,
      };
    }

    // Children (from task_children table)
    const childIds = this.getChildren(row.id);
    if (childIds.length > 0) task.childTasks = childIds;

    return task;
  }

  /**
   * Assemble a full Task from a row, including timeline, thread, files, deps, children.
   * Used by getTask(id) and getActiveTasks().
   */
  private assembleFullTask(row: any): Task {
    const task = this.rowToTask(row);

    // Add timeline
    const timeline = this.getTimeline(row.id);
    if (timeline.length > 0) task.timeline = timeline;

    // Add thread
    const thread = this.getThread(row.id);
    if (thread.length > 0) task.thread = thread;

    return task;
  }
}
