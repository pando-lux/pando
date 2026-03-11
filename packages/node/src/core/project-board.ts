/**
 * ProjectBoard — direct SQLite access to .pando-teams.db for per-project task boards.
 * KB: Bypasses pando-teams HTTP API — reads/writes .pando-teams.db directly via better-sqlite3.
 * KB: P2P sync uses ~/.pando/teams/{teamId}/board-state.json — Teams Server reads this on boot for failover.
 * KB: Two Laws content filter (HARM_PATTERNS/SHUTDOWN_PATTERNS) applied in insertBoardTask at storage level.
 */

import { join as pathJoin } from 'node:path';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HARM_PATTERNS, SHUTDOWN_PATTERNS } from '../constants.js';

export class ProjectBoard {
  /** better-sqlite3 constructor — set by EngineAdapter after start(). */
  db: any = null;
  /** EnginePool instance — set by EngineAdapter after start(). */
  pool: any = null;

  private dataDir: string;
  private projectTicks = new Set<string>();
  private projectIntervals = new Map<string, NodeJS.Timeout>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  updateDataDir(dir: string): void {
    this.dataDir = dir;
  }

  // ─── P2P Board State Sync ────────────────────────────────────────────────

  /**
   * Get the board state snapshot for a team as a JSON-serializable object.
   * Used for P2P board state sync (team failover). Returns null if no board data.
   * Reads from board-state.json — the live board is managed by Teams Server.
   */
  getBoardStateSnapshot(teamId: string): { savedAt: string; nodeId: string; tasks: any[] } | null {
    try {
      const filePath = pathJoin(this.dataDir, 'teams', teamId, 'board-state.json');
      if (!existsSync(filePath)) return null;

      const raw = readFileSync(filePath, 'utf-8');
      const snapshot = JSON.parse(raw);
      const tasks = (snapshot.tasks || []).filter((t: any) => t.status !== 'done');
      if (tasks.length === 0) return null;

      return {
        savedAt: snapshot.savedAt || new Date().toISOString(),
        nodeId: snapshot.nodeId || 'unknown',
        tasks,
      };
    } catch (err: any) {
      console.warn(`[board-sync] getBoardStateSnapshot failed for team ${teamId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Restore board state from a P2P-received snapshot (team failover).
   * Writes atomically (tmp + rename). Teams Server reads board-state.json on boot.
   */
  restoreBoardStateFromSnapshot(teamId: string, snapshot: { savedAt: string; nodeId: string; tasks: any[] }): boolean {
    try {
      if (!snapshot?.tasks?.length) return false;

      const teamDir = pathJoin(this.dataDir, 'teams', teamId);
      mkdirSync(teamDir, { recursive: true });

      const filePath = pathJoin(teamDir, 'board-state.json');
      const tmpPath = filePath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      renameSync(tmpPath, filePath);
      console.log(`[board-sync] Wrote P2P board snapshot for team ${teamId} (${snapshot.tasks.length} tasks from node ${snapshot.nodeId})`);

      return true;
    } catch (err: any) {
      console.warn(`[board-sync] restoreBoardStateFromSnapshot failed for team ${teamId}: ${err.message}`);
      return false;
    }
  }

  // ─── Project Board CRUD ──────────────────────────────────────────────────

  /** Get pending/in_progress tasks from a project's board. */
  getProjectBoard(projectId: string): any[] {
    const dbPath = this.resolveProjectDbPath(projectId);
    return this.getBoardTasks(dbPath);
  }

  /**
   * Add a task to a project's board. Used for per-project bug reports.
   * Returns the task ID on success, null on failure. Dedup by exact title match.
   * Registers a project scheduler tick if one doesn't exist yet.
   */
  addProjectBoardTask(projectId: string, title: string, description?: string): string | null {
    const dbPath = this.resolveProjectDbPath(projectId);
    const taskId = this.insertBoardTask(dbPath, title, description);
    if (taskId && dbPath) {
      this.ensureProjectTick(projectId, dbPath);
    }
    return taskId;
  }

  /** Stop all project tick intervals — called from EngineAdapter.shutdown(). */
  stopProjectTicks(): void {
    for (const [, interval] of this.projectIntervals) {
      clearInterval(interval);
    }
    this.projectIntervals.clear();
    this.projectTicks.clear();
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  private resolveProjectDbPath(projectId: string): string | null {
    try {
      const dbPath = pathJoin(this.dataDir, 'projects', projectId, '.pando-teams.db');
      return existsSync(dbPath) ? dbPath : null;
    } catch {
      return null;
    }
  }

  private getBoardTasks(dbPath: string | null, includeDone = false): any[] {
    if (!dbPath || !this.db) return [];
    try {
      const db = new this.db(dbPath);
      const statusFilter = includeDone
        ? `status IN ('pending', 'in_progress', 'in-progress', 'done')`
        : `status IN ('pending', 'in_progress', 'in-progress')`;
      const tasks = db.prepare(
        `SELECT id, title, description, status, created_at, progress FROM board_tasks
         WHERE ${statusFilter}
         ORDER BY created_at DESC LIMIT 50`
      ).all();
      db.close();
      return tasks;
    } catch {
      return [];
    }
  }

  private insertBoardTask(dbPath: string | null, title: string, description?: string): string | null {
    if (!dbPath || !this.db) return null;

    const textToCheck = `${title} ${description || ''}`;
    if (HARM_PATTERNS.test(textToCheck) || SHUTDOWN_PATTERNS.test(textToCheck)) {
      console.warn(`[ProjectBoard] insertBoardTask rejected: Two Laws violation in "${title.slice(0, 60)}"`);
      return null;
    }

    try {
      const db = new this.db(dbPath);

      const existing = db.prepare(
        `SELECT id FROM board_tasks WHERE title = ? AND status IN ('pending', 'in_progress') LIMIT 1`
      ).get(title) as { id: string } | undefined;
      if (existing) {
        db.close();
        return existing.id;
      }

      const id = `task-${randomUUID()}`;
      const session = db.prepare(
        `SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1`
      ).get() as { id: string } | undefined;
      const sessionId = session?.id || 'system';
      const maxOrder = db.prepare(
        `SELECT COALESCE(MAX("order"), 0) + 1 as next_order FROM board_tasks`
      ).get() as { next_order: number };
      db.prepare(
        `INSERT INTO board_tasks (id, session_id, title, status, "order", created_at, progress, description)
         VALUES (?, ?, ?, 'pending', ?, datetime('now'), '', ?)`
      ).run(id, sessionId, title, maxOrder.next_order, description || '');
      db.close();
      return id;
    } catch (err: any) {
      console.warn(`[ProjectBoard] insertBoardTask failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Register a periodic 6h scheduler tick for a project engine.
   * Only registers once per projectId — idempotent.
   */
  private ensureProjectTick(projectId: string, dbPath: string): void {
    if (this.projectTicks.has(projectId) || !this.pool) return;
    if (!this.pool.has(projectId)) return;

    this.projectTicks.add(projectId);

    const existing = this.projectIntervals.get(projectId);
    if (existing) clearInterval(existing);

    const projectTickMs = 6 * 60 * 60_000;
    const tickInterval = setInterval(async () => {
      try {
        const snapshot = this.getBoardSnapshot(dbPath);
        if (snapshot.includes('No pending tasks')) return;

        const message = `You are the lead for this project. Check your board and process pending tasks.\n\n${snapshot}\n\nPrioritize BUG reports. Close stale tasks (>24h). For code fixes, use spawn_agent with a builder role.`;
        for await (const event of this.pool.send(projectId, message)) {
          if (event.type === 'tool:start') {
            console.log(`[project:${projectId}] TOOL: ${event.toolName}`);
          }
        }
        console.log(`[project:${projectId}] Tick complete.`);
      } catch (err: any) {
        console.warn(`[project:${projectId}] Tick error: ${err.message}`);
      }
    }, projectTickMs);

    this.projectIntervals.set(projectId, tickInterval);
    console.log(`[ProjectBoard] Project "${projectId}" scheduler tick registered (every 6h).`);
  }

  private getBoardSnapshot(dbPath: string): string {
    if (!this.db) return 'BOARD STATE: Database not available.';
    try {
      const db = new this.db(dbPath);
      const tasks = db.prepare(
        `SELECT id, title, description, status, created_at FROM board_tasks
         WHERE status IN ('pending', 'in_progress')
         ORDER BY
           CASE WHEN title LIKE '%CRITICAL%' THEN 0
                WHEN title LIKE '%BUG:user%' THEN 1
                WHEN title LIKE '%WARNING%' THEN 2
                WHEN title LIKE '%FEATURE:user%' THEN 3
                ELSE 4 END,
           created_at ASC
         LIMIT 20`
      ).all() as { id: string; title: string; description: string; status: string; created_at: string }[];
      db.close();

      if (tasks.length === 0) return 'BOARD STATE: No pending tasks.';

      const lines = tasks.map((t) => {
        const age = Date.now() - new Date(t.created_at).getTime();
        const ageStr = age > 86400000 ? `${Math.floor(age / 86400000)}d ago`
          : age > 3600000 ? `${Math.floor(age / 3600000)}h ago`
          : `${Math.floor(age / 60000)}m ago`;
        const desc = t.description ? `\n    ${t.description.slice(0, 500)}` : '';
        return `  [${t.status}] (${t.id}) ${t.title.slice(0, 100)} — ${ageStr}${desc}`;
      });
      return `BOARD STATE (${tasks.length} active tasks):\n${lines.join('\n')}`;
    } catch {
      return 'BOARD STATE: Could not read board.';
    }
  }
}
