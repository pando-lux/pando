/**
 * AppManager — Unified App Lifecycle Manager
 *
 * ONE system to register, deploy, update, monitor, rollback, and undeploy
 * all running processes on this node. pando-node is app[0], user apps are app[1..N].
 *
 * Architecture:
 * - SQLite (apps.db) is the single source of truth for all app state
 * - PM2 manages Tier 2 (server) processes
 * - S3 hosts Tier 1 (static) deployments via contributed resources
 * - nginx reverse proxy for stable URLs with WebSocket support
 * - Blue-green deployment for zero-downtime updates
 * - Health monitoring with circuit breaker (auto-restart up to max_restarts)
 *
 * See docs/APP-LIFECYCLE-ROADMAP.md for full architecture.
 */

import Database from 'better-sqlite3';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { GitOps, safeGitRef } from './git-ops.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppConfig {
  id: string;
  name: string;
  repoUrl?: string;
  buildCmd?: string;
  startCmd?: string;
  healthEndpoint?: string;
  healthTimeout?: number;
  processManager?: 'pm2' | 'systemd' | 'supervisor';
  tier?: 1 | 2 | 3; // 1=static/S3, 2=server/PM2, 3=infrastructure
  envVars?: Record<string, string>;
  hostPeerId?: string;
  hostAddress?: string;
  governance?: boolean;                // true if updates require governance approval
  deployAction?: 'pm2' | 'restart-node'; // 'pm2' = PM2 process, 'restart-node' = exit 75 to restart
}

export interface App {
  id: string;
  name: string;
  repo_url: string | null;
  current_commit: string | null;
  target_commit: string | null;
  build_cmd: string;
  start_cmd: string;
  health_endpoint: string;
  health_timeout: number;
  process_manager: string;
  port: number | null;
  previous_port: number | null;
  host_peer_id: string | null;
  host_address: string | null;
  tier: number;
  status: string;
  env_json: string;
  deploy_url: string | null;
  previous_commit: string | null;
  error_message: string | null;
  created_at: number;
  deployed_at: number | null;
  updated_at: number | null;
  last_health_at: number | null;
  restart_count: number;
  max_restarts: number;
  governance: number;        // 1 if updates require governance approval
  deploy_action: string;     // 'pm2' or 'restart-node'
}

export interface AppHistory {
  id: number;
  app_id: string;
  action: string;
  from_commit: string | null;
  to_commit: string | null;
  from_port: number | null;
  to_port: number | null;
  status: string;
  error: string | null;
  duration_ms: number | null;
  created_at: number;
}

export interface DeployResult {
  success: boolean;
  url?: string;
  port?: number;
  error?: string;
}

export interface UpdateResult {
  success: boolean;
  previousCommit?: string;
  newCommit?: string;
  error?: string;
}

export interface RollbackResult {
  success: boolean;
  restoredCommit?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXEC_OPTS = { stdio: 'pipe' as const, timeout: 30_000, windowsHide: true };
const INSTALL_OPTS = { stdio: 'pipe' as const, timeout: 120_000, windowsHide: true };
const GIT_OPTS = { stdio: 'pipe' as const, timeout: 60_000, windowsHide: true };
const NGINX_CONF_DIR = '/etc/nginx/pando-apps';
const APPS_BASE_DIR = join(homedir(), '.pando', 'hosted-apps');
const WORKSPACE_BASE_DIR = join(homedir(), '.pando', 'projects');
const DB_PATH = join(homedir(), '.pando', 'apps.db');

/** Validate that an ID is safe for shell/filesystem use. */
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const STATIC_EXTS = new Set([
  '.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif',
  '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.eot',
]);

const MIME_TYPES: Record<string, string> = {
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
};

// ---------------------------------------------------------------------------
// AppManager
// ---------------------------------------------------------------------------

export class AppManager {
  private db: Database.Database;
  private healthTimer: NodeJS.Timeout | null = null;
  private node: any; // PandoNode — typed as any to avoid circular imports

  constructor(node: any) {
    this.node = node;

    // Ensure ~/.pando/ exists
    const pandoDir = join(homedir(), '.pando');
    mkdirSync(pandoDir, { recursive: true });

    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.ensureSchema();

    console.log('[app-manager] Initialized — database at', DB_PATH);
  }

  // ── Schema ───────────────────────────────────────────────────────────────

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_url TEXT,
        current_commit TEXT,
        target_commit TEXT,
        build_cmd TEXT DEFAULT 'npm run build',
        start_cmd TEXT DEFAULT 'npm start',
        health_endpoint TEXT DEFAULT '/health',
        health_timeout INTEGER DEFAULT 10000,
        process_manager TEXT DEFAULT 'pm2',
        port INTEGER,
        previous_port INTEGER,
        host_peer_id TEXT,
        host_address TEXT,
        tier INTEGER DEFAULT 2,
        status TEXT DEFAULT 'registered',
        env_json TEXT DEFAULT '{}',
        deploy_url TEXT,
        previous_commit TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        deployed_at INTEGER,
        updated_at INTEGER,
        last_health_at INTEGER,
        restart_count INTEGER DEFAULT 0,
        max_restarts INTEGER DEFAULT 10,
        governance INTEGER DEFAULT 0,
        deploy_action TEXT DEFAULT 'pm2'
      );

      CREATE TABLE IF NOT EXISTS app_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_id TEXT NOT NULL,
        action TEXT NOT NULL,
        from_commit TEXT,
        to_commit TEXT,
        from_port INTEGER,
        to_port INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL
      );
    `);

    // Migrations for existing databases — add new columns if missing
    try { this.db.exec('ALTER TABLE apps ADD COLUMN governance INTEGER DEFAULT 0'); } catch {}
    try { this.db.exec('ALTER TABLE apps ADD COLUMN deploy_action TEXT DEFAULT \'pm2\''); } catch {}
  }

  // ── Registration ─────────────────────────────────────────────────────────

  register(config: AppConfig): void {
    const now = Date.now();
    const envJson = config.envVars ? JSON.stringify(config.envVars) : '{}';

    this.db.prepare(`
      INSERT OR REPLACE INTO apps
        (id, name, repo_url, build_cmd, start_cmd, health_endpoint, health_timeout,
         process_manager, tier, env_json, host_peer_id, host_address,
         governance, deploy_action, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.id,
      config.name,
      config.repoUrl || null,
      config.buildCmd || 'npm run build',
      config.startCmd || 'npm start',
      config.healthEndpoint || '/health',
      config.healthTimeout || 10000,
      config.processManager || 'pm2',
      config.tier ?? 2,
      envJson,
      config.hostPeerId || null,
      config.hostAddress || null,
      config.governance ? 1 : 0,
      config.deployAction || 'pm2',
      now,
      now,
    );

    console.log(`[app-manager] Registered app: ${config.id} (${config.name})`);
  }

  get(appId: string): App | null {
    const row = this.db.prepare('SELECT * FROM apps WHERE id = ?').get(appId) as App | undefined;
    return row || null;
  }

  list(filter?: { status?: string; hostPeerId?: string }): App[] {
    if (filter?.status && filter?.hostPeerId) {
      return this.db.prepare('SELECT * FROM apps WHERE status = ? AND host_peer_id = ?')
        .all(filter.status, filter.hostPeerId) as App[];
    }
    if (filter?.status) {
      return this.db.prepare('SELECT * FROM apps WHERE status = ?')
        .all(filter.status) as App[];
    }
    if (filter?.hostPeerId) {
      return this.db.prepare('SELECT * FROM apps WHERE host_peer_id = ?')
        .all(filter.hostPeerId) as App[];
    }
    return this.db.prepare('SELECT * FROM apps').all() as App[];
  }

  unregister(appId: string): void {
    this.db.prepare('DELETE FROM app_history WHERE app_id = ?').run(appId);
    this.db.prepare('DELETE FROM apps WHERE id = ?').run(appId);
    console.log(`[app-manager] Unregistered app: ${appId}`);
  }

  findByRepoUrl(repoUrl: string): App | null {
    const row = this.db.prepare('SELECT * FROM apps WHERE repo_url = ?').get(repoUrl) as App | undefined;
    return row || null;
  }

  /** Mark an app as live (used for pando-node self-registration) */
  markLive(appId: string, opts?: { port?: number; commit?: string }): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE apps SET status = 'live',
        port = COALESCE(?, port),
        current_commit = COALESCE(?, current_commit),
        deployed_at = COALESCE(deployed_at, ?),
        updated_at = ?
      WHERE id = ?
    `).run(opts?.port ?? null, opts?.commit ?? null, now, now, appId);
  }

  // ── Deploy ───────────────────────────────────────────────────────────────

  async deploy(appId: string): Promise<DeployResult> {
    const startTime = Date.now();
    let app = this.get(appId);
    if (!app) {
      return { success: false, error: `App ${appId} not found` };
    }

    if (app.status === 'deploying' || app.status === 'updating') {
      return { success: false, error: `App ${appId} is already ${app.status}` };
    }

    if (app.status !== 'registered' && app.status !== 'failed' && app.status !== 'stopped') {
      return { success: false, error: `App ${appId} has status '${app.status}' — must be 'registered', 'failed', or 'stopped' to deploy` };
    }

    // Check for workspace-based source (chat-created projects)
    const workspaceDir = this.resolveWorkspace(appId);
    const hasWorkspace = workspaceDir !== null;

    if (!app.repo_url && !hasWorkspace) {
      return { success: false, error: `App ${appId} has no repo_url and no workspace — cannot deploy without source` };
    }

    // Auto-detect tier from workspace if tier is default and workspace exists
    if (hasWorkspace && app.tier === 2) {
      const detected = AppManager.detectTier(workspaceDir);
      if (detected.tier !== app.tier) {
        this.db.prepare('UPDATE apps SET tier = ?, updated_at = ? WHERE id = ?')
          .run(detected.tier, Date.now(), appId);
        app = this.get(appId)!;
        console.log(`[app-manager] Auto-detected tier ${detected.tier} for ${appId}: ${detected.reason}`);
      }
    }

    // P2P dispatch: if no host set, find a deploy target
    const selfPeerId = this.node.getIdentity?.()?.peerId;
    if (!app.host_peer_id) {
      const target = this.findDeployTarget();
      if (target) {
        // Update local record with target info
        this.db.prepare('UPDATE apps SET host_peer_id = ?, host_address = ?, updated_at = ? WHERE id = ?')
          .run(target.peerId, target.address, Date.now(), appId);
        app = this.get(appId)!; // refresh
      }
    }

    // If the app should run on a REMOTE node, forward the request
    if (app.host_peer_id && app.host_peer_id !== selfPeerId) {
      try {
        this.db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?')
          .run('deploying', Date.now(), appId);

        const result = await this.forwardToRemote(app.host_peer_id, appId, 'deploy', {
          id: app.id,
          name: app.name,
          repoUrl: app.repo_url || undefined,
          buildCmd: app.build_cmd,
          startCmd: app.start_cmd,
          healthEndpoint: app.health_endpoint,
          healthTimeout: app.health_timeout,
          processManager: app.process_manager as any,
          tier: app.tier as 1 | 2 | 3,
          envVars: app.env_json ? JSON.parse(app.env_json) : undefined,
          hostPeerId: app.host_peer_id,
          hostAddress: app.host_address || undefined,
        });

        // Update local record with remote result
        if ((result as DeployResult).success) {
          this.db.prepare(`
            UPDATE apps SET status = 'live', deploy_url = ?, deployed_at = ?, updated_at = ?, error_message = NULL
            WHERE id = ?
          `).run((result as DeployResult).url || null, Date.now(), Date.now(), appId);

          this.recordHistory(appId, 'deploy', {
            status: 'success',
            duration_ms: Date.now() - startTime,
          });
        } else {
          this.db.prepare('UPDATE apps SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
            .run('failed', (result as DeployResult).error || 'Remote deploy failed', Date.now(), appId);

          this.recordHistory(appId, 'deploy', {
            status: 'failed',
            error: (result as DeployResult).error,
            duration_ms: Date.now() - startTime,
          });
        }

        return result as DeployResult;
      } catch (err: any) {
        const error = `Remote deploy to ${app.host_peer_id.slice(0, 8)} failed: ${err.message}`;
        this.db.prepare('UPDATE apps SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
          .run('failed', error, Date.now(), appId);
        this.recordHistory(appId, 'deploy', {
          status: 'failed',
          error,
          duration_ms: Date.now() - startTime,
        });
        return { success: false, error };
      }
    }

    // Local deploy continues below...

    // Mark as deploying
    this.db.prepare('UPDATE apps SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?')
      .run('deploying', Date.now(), appId);

    try {
      const appDir = join(APPS_BASE_DIR, appId);
      mkdirSync(appDir, { recursive: true });

      if (app.repo_url) {
        // Clone or pull from GitHub
        this.cloneOrPull(appDir, app.repo_url);
      } else if (hasWorkspace) {
        // Copy workspace files to hosted-apps directory
        this.copyWorkspaceToAppDir(workspaceDir, appDir);
        console.log(`[app-manager] Copied workspace ${workspaceDir} → ${appDir}`);
      }

      const currentCommit = this.getCommit(appDir);

      if (app.tier === 1) {
        return await this.deployTier1(app, appDir, currentCommit, startTime);
      } else {
        return await this.deployTier2(app, appDir, currentCommit, startTime);
      }
    } catch (err: any) {
      const error = err.message || String(err);
      this.db.prepare('UPDATE apps SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run('failed', error, Date.now(), appId);
      this.recordHistory(appId, 'deploy', {
        to_commit: null,
        status: 'failed',
        error,
        duration_ms: Date.now() - startTime,
      });
      console.log(`[app-manager] Deploy failed for ${appId}: ${error}`);
      return { success: false, error };
    }
  }

  private async deployTier1(
    app: App, appDir: string, currentCommit: string, startTime: number,
  ): Promise<DeployResult> {
    console.log(`[app-manager] Tier 1 deploy — uploading static files to S3 for ${app.id}`);

    // Run build command if package.json exists and has build script
    this.runBuildIfNeeded(appDir, app.build_cmd);

    // Get S3 credentials from ResourceRegistry (contributed resources)
    const registry = this.node.resourceRegistry;
    if (!registry) {
      throw new Error('ResourceRegistry not available on this node');
    }

    const s3Resources = registry.findResources('storage_blob' as any);
    if (!s3Resources.length) {
      throw new Error('No storage_blob resource contributed to this node');
    }

    const s3Cred = await registry.getCredential(s3Resources[0].resourceId);
    if (!s3Cred) {
      throw new Error('Could not decrypt S3 credential');
    }

    // Parse S3 credential — JSON or accessKeyId:secretAccessKey format
    let s3Config: any;
    try {
      s3Config = JSON.parse(s3Cred);
    } catch {
      const parts = s3Cred.split(':');
      if (parts.length >= 2) {
        s3Config = {
          accessKeyId: parts[0],
          secretAccessKey: parts.slice(1).join(':'),
          region: s3Resources[0].metadata?.region || 'us-east-1',
          bucket: s3Resources[0].metadata?.bucket || 'pando-deployments',
        };
      } else {
        throw new Error('S3 credential not in expected JSON or key:secret format');
      }
    }

    // Dynamic import @aws-sdk/client-s3
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: s3Config.region || 'us-east-1',
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
    });

    const bucket = s3Config.bucket || 'pando-deployments';
    const envVars: Record<string, string> = app.env_json ? JSON.parse(app.env_json) : {};
    const gatewayUrl = envVars.PANDO_GATEWAY_URL || process.env.GATEWAY_PUBLIC_URL || '';
    const projectApiKey = envVars.PANDO_PROJECT_API_KEY || '';

    let uploadCount = 0;
    const uploadPromises: Promise<void>[] = [];
    const uploadErrors: string[] = [];

    // Recursively scan for static files
    const scanDir = (dir: string, prefix: string): void => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const relPath = prefix ? `${prefix}/${entry}` : entry;

        try {
          const st = statSync(fullPath);
          if (st.isDirectory()) {
            if (entry === 'node_modules' || entry === '.git') continue;
            scanDir(fullPath, relPath);
          } else if (st.isFile()) {
            const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
            if (!STATIC_EXTS.has(ext)) continue;

            let content: Buffer = readFileSync(fullPath);

            // Inject gateway vars into HTML files
            if (ext === '.html' && gatewayUrl) {
              let html = content.toString('utf-8');
              const vars = [
                `window.PANDO_GATEWAY_URL="${gatewayUrl}"`,
                `window.PANDO_PROJECT_ID="${app.id}"`,
              ];
              if (projectApiKey) vars.push(`window.PANDO_PROJECT_API_KEY="${projectApiKey}"`);
              const script = `<script>${vars.join(';')};</script>`;
              if (html.includes('<head>')) {
                html = html.replace('<head>', '<head>' + script);
              } else {
                html = script + html;
              }
              content = Buffer.from(html, 'utf-8');
            }

            const key = `public/${app.id}/${relPath}`;
            const putCmd = new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: content,
              ContentType: MIME_TYPES[ext] || 'application/octet-stream',
            });
            uploadPromises.push(
              s3.send(putCmd)
                .then(() => { uploadCount++; })
                .catch((e: any) => { uploadErrors.push(`${key}: ${e.message}`); }),
            );
          }
        } catch { /* skip unreadable entries */ }
      }
    };

    // Prefer public/ subdirectory for Tier 1 apps
    const publicDir = join(appDir, 'public');
    if (existsSync(publicDir) && statSync(publicDir).isDirectory()) {
      scanDir(publicDir, '');
    } else {
      scanDir(appDir, '');
    }

    // Await all S3 uploads
    await Promise.all(uploadPromises);

    if (uploadErrors.length > 0) {
      console.log(`[app-manager] ${uploadErrors.length} S3 upload(s) failed: ${uploadErrors.slice(0, 3).join('; ')}`);
    }

    const region = s3Config.region || 'us-east-1';
    const s3Url = `http://${bucket}.s3-website-${region}.amazonaws.com/public/${app.id}/index.html`;

    // Update DB
    this.db.prepare(`
      UPDATE apps SET
        status = 'live', current_commit = ?, deploy_url = ?,
        deployed_at = ?, updated_at = ?, error_message = NULL
      WHERE id = ?
    `).run(currentCommit, s3Url, Date.now(), Date.now(), app.id);

    this.recordHistory(app.id, 'deploy', {
      to_commit: currentCommit,
      status: 'success',
      duration_ms: Date.now() - startTime,
    });

    console.log(`[app-manager] Tier 1 deploy complete: ${uploadCount} files uploaded → ${s3Url}`);
    return { success: true, url: s3Url };
  }

  private async deployTier2(
    app: App, appDir: string, currentCommit: string, startTime: number,
  ): Promise<DeployResult> {
    console.log(`[app-manager] Tier 2 deploy — starting server for ${app.id}`);

    // Install dependencies
    execSync('npm install --production', { ...INSTALL_OPTS, cwd: appDir });
    console.log(`[app-manager] Dependencies installed for ${app.id}`);

    // Run build
    this.runBuildIfNeeded(appDir, app.build_cmd);

    // Allocate port
    const port = this.allocatePort();
    const pm2Name = `app-${app.id}`;

    // Build env vars — use process env option, never shell interpolation
    const envVars: Record<string, string> = app.env_json ? JSON.parse(app.env_json) : {};
    const processEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(port),
      NODE_ENV: 'production',
      ...envVars,
    };

    // Delete any existing PM2 process
    try { execFileSync('pm2', ['delete', pm2Name], EXEC_OPTS); } catch { /* not running */ }

    // Start via PM2
    const pkg = this.readPackageJson(appDir);
    if (pkg?.scripts?.start) {
      execFileSync('pm2', ['start', 'npm', '--name', pm2Name, '--', 'start'], { ...EXEC_OPTS, cwd: appDir, env: processEnv });
    } else {
      const mainFile = pkg?.main || 'server.js';
      execFileSync('pm2', ['start', mainFile, '--name', pm2Name], { ...EXEC_OPTS, cwd: appDir, env: processEnv });
    }

    console.log(`[app-manager] PM2 process ${pm2Name} started on port ${port}`);

    // Wait for process to initialize
    await this.sleep(3000);

    // Health check
    const healthy = await this.healthCheck(app.id, port, app.health_endpoint, app.health_timeout);

    if (healthy) {
      // Write nginx config and reload
      this.updateNginx(app.id, port);

      // Construct deploy URL
      const publicAddress = app.host_address || process.env.PUBLIC_IP || null;
      const deployUrl = publicAddress
        ? `http://${publicAddress}/apps/${app.id}/`
        : `http://localhost:${port}`;

      // Update DB: status=live
      this.db.prepare(`
        UPDATE apps SET
          status = 'live', port = ?, current_commit = ?, deploy_url = ?,
          deployed_at = ?, updated_at = ?, error_message = NULL, restart_count = 0
        WHERE id = ?
      `).run(port, currentCommit, deployUrl, Date.now(), Date.now(), app.id);

      this.recordHistory(app.id, 'deploy', {
        to_commit: currentCommit,
        to_port: port,
        status: 'success',
        duration_ms: Date.now() - startTime,
      });

      console.log(`[app-manager] Tier 2 deploy complete: ${app.id} live on port ${port}`);
      return { success: true, url: deployUrl, port };
    } else {
      // Health check failed — clean up
      try { execFileSync('pm2', ['delete', pm2Name], EXEC_OPTS); } catch { /* best effort */ }

      const error = 'Health check failed after deploy — process started but did not respond to health probe';
      this.db.prepare('UPDATE apps SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run('failed', error, Date.now(), app.id);

      this.recordHistory(app.id, 'deploy', {
        to_commit: currentCommit,
        to_port: port,
        status: 'failed',
        error,
        duration_ms: Date.now() - startTime,
      });

      console.log(`[app-manager] Deploy failed for ${app.id}: health check did not pass`);
      return { success: false, error };
    }
  }

  // ── Update (Blue-Green) ──────────────────────────────────────────────────

  async update(appId: string, opts?: { targetCommit?: string }): Promise<UpdateResult> {
    const startTime = Date.now();
    let app = this.get(appId);

    // Auto-register: if app not found, check ProjectStore and register it
    if (!app) {
      const projectStore = this.node.getProjectStore?.();
      if (projectStore) {
        const project = projectStore.getProject(appId);
        if (project) {
          // Auto-detect tier from workspace if available
          let tier: 1 | 2 = 2;
          const wsDir = project.workspaceDir || join(WORKSPACE_BASE_DIR, appId);
          if (existsSync(wsDir)) {
            tier = AppManager.detectTier(wsDir).tier;
          }

          // Determine repoUrl — may be absent for chat-created projects
          const repoUrl = project.repoUrl
            ? project.repoUrl
            : project.githubRepo
              ? `https://github.com/${project.githubRepo}.git`
              : undefined;

          this.register({
            id: appId,
            name: project.name || appId,
            repoUrl,
            tier,
          });

          // Now try deploy instead of update (it's a new app)
          // deploy() will fall back to workspace if repoUrl is absent
          return await this.deploy(appId) as any;
        }
      }

      // Even without ProjectStore, check if a workspace directory exists
      const fallbackWorkspace = this.resolveWorkspace(appId);
      if (fallbackWorkspace) {
        const detected = AppManager.detectTier(fallbackWorkspace);
        this.register({
          id: appId,
          name: appId,
          tier: detected.tier,
        });
        return await this.deploy(appId) as any;
      }

      return { success: false, error: `App ${appId} not found` };
    }

    // Remote dispatch for updates
    const selfPeerId = this.node.getIdentity?.()?.peerId;
    if (app.host_peer_id && app.host_peer_id !== selfPeerId) {
      try {
        this.db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?')
          .run('updating', Date.now(), appId);

        const result = await this.forwardToRemote(app.host_peer_id, appId, 'update');

        if ((result as UpdateResult).success) {
          this.db.prepare(`
            UPDATE apps SET status = 'live', current_commit = ?, previous_commit = ?, updated_at = ?, error_message = NULL
            WHERE id = ?
          `).run(
            (result as UpdateResult).newCommit || app.current_commit,
            app.current_commit,
            Date.now(),
            appId,
          );
        } else {
          this.db.prepare('UPDATE apps SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
            .run('live', (result as UpdateResult).error || 'Remote update failed', Date.now(), appId);
        }

        return result as UpdateResult;
      } catch (err: any) {
        // Restore status on failure
        this.db.prepare('UPDATE apps SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
          .run('live', `Remote update failed: ${err.message}`, Date.now(), appId);
        return { success: false, error: `Remote update failed: ${err.message}` };
      }
    }

    if (app.status === 'deploying' || app.status === 'updating') {
      return { success: false, error: `App ${appId} is already ${app.status}` };
    }

    if (app.status !== 'live' && app.status !== 'unhealthy') {
      return { success: false, error: `App ${appId} has status '${app.status}' — must be 'live' or 'unhealthy' to update` };
    }

    // For workspace-based apps without repo_url, re-sync from workspace
    const updateWorkspace = this.resolveWorkspace(appId);
    if (!app.repo_url && !updateWorkspace) {
      return { success: false, error: `App ${appId} has no repo_url and no workspace` };
    }

    const appDir = join(APPS_BASE_DIR, appId);

    // If workspace-based, re-copy latest workspace files to hosted-apps
    if (!app.repo_url && updateWorkspace) {
      this.copyWorkspaceToAppDir(updateWorkspace, appDir);
      console.log(`[app-manager] Re-synced workspace for update: ${updateWorkspace} → ${appDir}`);
    }

    if (!existsSync(appDir)) {
      return { success: false, error: `App directory ${appDir} does not exist` };
    }

    // Mark as updating
    this.db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?')
      .run('updating', Date.now(), appId);

    try {
      if (app.tier === 1) {
        return await this.updateTier1(app, appDir, startTime);
      } else {
        return await this.updateTier2(app, appDir, opts?.targetCommit, startTime);
      }
    } catch (err: any) {
      const error = err.message || String(err);
      // Restore previous status
      this.db.prepare('UPDATE apps SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run(app.status === 'unhealthy' ? 'unhealthy' : 'live', error, Date.now(), appId);
      this.recordHistory(appId, 'update', {
        from_commit: app.current_commit,
        status: 'failed',
        error,
        duration_ms: Date.now() - startTime,
      });
      console.log(`[app-manager] Update failed for ${appId}: ${error}`);
      return { success: false, error };
    }
  }

  private async updateTier1(app: App, appDir: string, startTime: number): Promise<UpdateResult> {
    const oldCommit = app.current_commit;
    const isGitRepo = existsSync(join(appDir, '.git'));

    let newCommit: string;
    if (isGitRepo) {
      // Pull latest from git
      const git = new GitOps(appDir);
      git.pull('origin', 'main');
      newCommit = this.getCommit(appDir);
    } else {
      // Workspace-based: files were already re-copied by update(), use timestamp as "commit"
      newCommit = `workspace-${Date.now()}`;
    }

    if (isGitRepo && newCommit === oldCommit) {
      // Already current — restore status
      this.db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?')
        .run('live', Date.now(), app.id);
      console.log(`[app-manager] ${app.id} already at latest commit ${newCommit?.slice(0, 8)}`);
      return { success: true, previousCommit: oldCommit || undefined, newCommit: newCommit || undefined };
    }

    // Rebuild
    this.runBuildIfNeeded(appDir, app.build_cmd);

    // Re-upload to S3 (same logic as deployTier1 upload phase)
    const registry = this.node.resourceRegistry;
    if (!registry) throw new Error('ResourceRegistry not available on this node');

    const s3Resources = registry.findResources('storage_blob' as any);
    if (!s3Resources.length) throw new Error('No storage_blob resource contributed to this node');

    const s3Cred = await registry.getCredential(s3Resources[0].resourceId);
    if (!s3Cred) throw new Error('Could not decrypt S3 credential');

    let s3Config: any;
    try { s3Config = JSON.parse(s3Cred); } catch {
      const parts = s3Cred.split(':');
      if (parts.length >= 2) {
        s3Config = {
          accessKeyId: parts[0],
          secretAccessKey: parts.slice(1).join(':'),
          region: s3Resources[0].metadata?.region || 'us-east-1',
          bucket: s3Resources[0].metadata?.bucket || 'pando-deployments',
        };
      } else {
        throw new Error('S3 credential not in expected JSON or key:secret format');
      }
    }

    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: s3Config.region || 'us-east-1',
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
    });

    const bucket = s3Config.bucket || 'pando-deployments';
    const envVars: Record<string, string> = app.env_json ? JSON.parse(app.env_json) : {};
    const gatewayUrl = envVars.PANDO_GATEWAY_URL || process.env.GATEWAY_PUBLIC_URL || '';
    const projectApiKey = envVars.PANDO_PROJECT_API_KEY || '';

    let uploadCount = 0;
    const uploadPromises: Promise<void>[] = [];

    const scanDir = (dir: string, prefix: string): void => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const relPath = prefix ? `${prefix}/${entry}` : entry;
        try {
          const st = statSync(fullPath);
          if (st.isDirectory()) {
            if (entry === 'node_modules' || entry === '.git') continue;
            scanDir(fullPath, relPath);
          } else if (st.isFile()) {
            const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
            if (!STATIC_EXTS.has(ext)) continue;

            let content: Buffer = readFileSync(fullPath);
            if (ext === '.html' && gatewayUrl) {
              let html = content.toString('utf-8');
              const vars = [
                `window.PANDO_GATEWAY_URL="${gatewayUrl}"`,
                `window.PANDO_PROJECT_ID="${app.id}"`,
              ];
              if (projectApiKey) vars.push(`window.PANDO_PROJECT_API_KEY="${projectApiKey}"`);
              const script = `<script>${vars.join(';')};</script>`;
              if (html.includes('<head>')) {
                html = html.replace('<head>', '<head>' + script);
              } else {
                html = script + html;
              }
              content = Buffer.from(html, 'utf-8');
            }

            const key = `public/${app.id}/${relPath}`;
            const putCmd = new PutObjectCommand({
              Bucket: bucket,
              Key: key,
              Body: content,
              ContentType: MIME_TYPES[ext] || 'application/octet-stream',
            });
            uploadPromises.push(
              s3.send(putCmd).then(() => { uploadCount++; }).catch(() => {}),
            );
          }
        } catch { /* skip */ }
      }
    };

    const publicDir = join(appDir, 'public');
    if (existsSync(publicDir) && statSync(publicDir).isDirectory()) {
      scanDir(publicDir, '');
    } else {
      scanDir(appDir, '');
    }

    await Promise.all(uploadPromises);

    // Update DB
    this.db.prepare(`
      UPDATE apps SET
        status = 'live', current_commit = ?, previous_commit = ?, updated_at = ?, error_message = NULL
      WHERE id = ?
    `).run(newCommit, oldCommit, Date.now(), app.id);

    this.recordHistory(app.id, 'update', {
      from_commit: oldCommit,
      to_commit: newCommit,
      status: 'success',
      duration_ms: Date.now() - startTime,
    });

    console.log(`[app-manager] Tier 1 update complete for ${app.id}: ${uploadCount} files re-uploaded`);
    return { success: true, previousCommit: oldCommit || undefined, newCommit: newCommit || undefined };
  }

  private async updateTier2(
    app: App, appDir: string, targetCommit: string | undefined, startTime: number,
  ): Promise<UpdateResult> {
    const oldCommit = app.current_commit;
    const oldPort = app.port;
    const isGitRepo = existsSync(join(appDir, '.git'));

    let newCommit: string;

    if (isGitRepo) {
      const git = new GitOps(appDir);

      // Fetch latest from remote
      git.fetch('origin');

      // Determine target commit
      if (targetCommit) {
        newCommit = targetCommit;
      } else {
        newCommit = git.getRemoteCommit('origin', 'main');
      }

      // Check if already at target
      if (newCommit === oldCommit) {
        this.db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?')
          .run('live', Date.now(), app.id);
        console.log(`[app-manager] ${app.id} already at commit ${newCommit.slice(0, 8)}`);
        return { success: true, previousCommit: oldCommit || undefined, newCommit };
      }

      // Checkout new commit
      git.checkout(newCommit);
    } else {
      // Workspace-based: files were already re-copied by update(), use timestamp as "commit"
      newCommit = `workspace-${Date.now()}`;
    }

    // Install deps and build
    execSync('npm install --production', { ...INSTALL_OPTS, cwd: appDir });
    this.runBuildIfNeeded(appDir, app.build_cmd);

    // Allocate a TEMP port (different from current) for blue-green
    const tempPort = this.allocatePort();
    const pm2NameStaging = `app-${app.id}-staging`;

    // Build env vars — use process env option, never shell interpolation
    const envVars: Record<string, string> = app.env_json ? JSON.parse(app.env_json) : {};
    const processEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: String(tempPort),
      NODE_ENV: 'production',
      ...envVars,
    };

    // Delete any stale staging process
    try { execFileSync('pm2', ['delete', pm2NameStaging], EXEC_OPTS); } catch { /* not running */ }

    // Start staging process on temp port
    const pkg = this.readPackageJson(appDir);
    if (pkg?.scripts?.start) {
      execFileSync('pm2', ['start', 'npm', '--name', pm2NameStaging, '--', 'start'], { ...EXEC_OPTS, cwd: appDir, env: processEnv });
    } else {
      const mainFile = pkg?.main || 'server.js';
      execFileSync('pm2', ['start', mainFile, '--name', pm2NameStaging], { ...EXEC_OPTS, cwd: appDir, env: processEnv });
    }

    console.log(`[app-manager] Staging process ${pm2NameStaging} started on port ${tempPort}`);

    // Wait for staging process to initialize
    await this.sleep(3000);

    // Health check staging
    const healthy = await this.healthCheck(app.id, tempPort, app.health_endpoint, app.health_timeout);

    if (healthy) {
      // Blue-green swap: update nginx to point to new port
      this.updateNginx(app.id, tempPort);

      // Kill old PM2 process
      const pm2Name = `app-${app.id}`;
      try { execFileSync('pm2', ['delete', pm2Name], EXEC_OPTS); } catch { /* best effort */ }

      // Rename staging → production
      try {
        execFileSync('pm2', ['restart', pm2NameStaging, '--name', pm2Name], EXEC_OPTS);
      } catch {
        // pm2 rename is not a real command — delete staging and re-start with production name
        try { execFileSync('pm2', ['delete', pm2NameStaging], EXEC_OPTS); } catch { /* best effort */ }

        if (pkg?.scripts?.start) {
          execFileSync('pm2', ['start', 'npm', '--name', pm2Name, '--', 'start'], { ...EXEC_OPTS, cwd: appDir, env: processEnv });
        } else {
          const mainFile = pkg?.main || 'server.js';
          execFileSync('pm2', ['start', mainFile, '--name', pm2Name], { ...EXEC_OPTS, cwd: appDir, env: processEnv });
        }
      }

      // Construct deploy URL
      const publicAddress = app.host_address || process.env.PUBLIC_IP || null;
      const deployUrl = publicAddress
        ? `http://${publicAddress}/apps/${app.id}/`
        : `http://localhost:${tempPort}`;

      // Update DB
      this.db.prepare(`
        UPDATE apps SET
          status = 'live', port = ?, previous_port = ?,
          current_commit = ?, previous_commit = ?,
          deploy_url = ?, updated_at = ?, error_message = NULL, restart_count = 0
        WHERE id = ?
      `).run(tempPort, oldPort, newCommit, oldCommit, deployUrl, Date.now(), app.id);

      this.recordHistory(app.id, 'update', {
        from_commit: oldCommit,
        to_commit: newCommit,
        from_port: oldPort,
        to_port: tempPort,
        status: 'success',
        duration_ms: Date.now() - startTime,
      });

      console.log(`[app-manager] Blue-green update complete for ${app.id}: ${oldCommit?.slice(0, 8)} → ${newCommit.slice(0, 8)}`);
      return { success: true, previousCommit: oldCommit || undefined, newCommit };
    } else {
      // Staging health check failed — clean up staging, restore old commit
      try { execFileSync('pm2', ['delete', pm2NameStaging], EXEC_OPTS); } catch { /* best effort */ }

      // Restore old commit so old process's code is intact
      if (oldCommit) {
        try {
          const git = new GitOps(appDir);
          git.checkout(oldCommit);
        } catch { /* best effort — old process is still running on old port */ }
      }

      const error = 'Staging health check failed — old process continues running (zero downtime preserved)';

      // Restore status (old process is still live)
      this.db.prepare('UPDATE apps SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run(app.status === 'unhealthy' ? 'unhealthy' : 'live', error, Date.now(), app.id);

      this.recordHistory(app.id, 'update', {
        from_commit: oldCommit,
        to_commit: newCommit,
        from_port: oldPort,
        to_port: tempPort,
        status: 'failed',
        error,
        duration_ms: Date.now() - startTime,
      });

      console.log(`[app-manager] Update failed for ${app.id}: staging health check did not pass`);
      return { success: false, error };
    }
  }

  // ── Rollback ─────────────────────────────────────────────────────────────

  async rollback(appId: string): Promise<RollbackResult> {
    const startTime = Date.now();
    const app = this.get(appId);
    if (!app) {
      return { success: false, error: `App ${appId} not found` };
    }

    if (!app.previous_commit) {
      return { success: false, error: `App ${appId} has no previous commit to rollback to` };
    }

    if (app.status === 'deploying' || app.status === 'updating') {
      return { success: false, error: `App ${appId} is already ${app.status}` };
    }

    const appDir = join(APPS_BASE_DIR, appId);
    if (!existsSync(appDir)) {
      return { success: false, error: `App directory ${appDir} does not exist` };
    }

    // Mark as updating
    this.db.prepare('UPDATE apps SET status = ?, updated_at = ? WHERE id = ?')
      .run('updating', Date.now(), appId);

    try {
      const targetCommit = app.previous_commit;
      const currentCommit = app.current_commit;

      // Checkout previous commit
      const git = new GitOps(appDir);
      git.checkout(targetCommit);

      // Reinstall deps and rebuild
      execSync('npm install --production', { ...INSTALL_OPTS, cwd: appDir });
      this.runBuildIfNeeded(appDir, app.build_cmd);

      if (app.tier === 1) {
        // For Tier 1: re-upload via the update path
        // Temporarily set current_commit to trigger re-upload
        const updateResult = await this.updateTier1(
          { ...app, current_commit: 'force-reupload' },
          appDir,
          startTime,
        );

        if (updateResult.success) {
          // Override the commit history: rolled back, no more previous
          this.db.prepare(`
            UPDATE apps SET current_commit = ?, previous_commit = NULL, updated_at = ? WHERE id = ?
          `).run(targetCommit, Date.now(), appId);

          this.recordHistory(appId, 'rollback', {
            from_commit: currentCommit,
            to_commit: targetCommit,
            status: 'success',
            duration_ms: Date.now() - startTime,
          });

          return { success: true, restoredCommit: targetCommit };
        } else {
          throw new Error(updateResult.error || 'Tier 1 rollback upload failed');
        }
      } else {
        // Tier 2: blue-green rollback
        const oldPort = app.port;
        const tempPort = this.allocatePort();
        const pm2NameStaging = `app-${appId}-staging`;

        // Build env vars — use process env option, never shell interpolation
        const envVars: Record<string, string> = app.env_json ? JSON.parse(app.env_json) : {};
        const processEnv: Record<string, string> = {
          ...process.env as Record<string, string>,
          PORT: String(tempPort),
          NODE_ENV: 'production',
          ...envVars,
        };

        // Delete any stale staging process
        try { execFileSync('pm2', ['delete', pm2NameStaging], EXEC_OPTS); } catch { /* not running */ }

        // Start staging with rolled-back code
        const pkg = this.readPackageJson(appDir);
        if (pkg?.scripts?.start) {
          execFileSync('pm2', ['start', 'npm', '--name', pm2NameStaging, '--', 'start'], { ...EXEC_OPTS, cwd: appDir, env: processEnv });
        } else {
          const mainFile = pkg?.main || 'server.js';
          execFileSync('pm2', ['start', mainFile, '--name', pm2NameStaging], { ...EXEC_OPTS, cwd: appDir, env: processEnv });
        }

        await this.sleep(3000);

        // Health check staging
        const healthy = await this.healthCheck(appId, tempPort, app.health_endpoint, app.health_timeout);

        if (healthy) {
          // Swap: update nginx, kill old, rename staging
          this.updateNginx(appId, tempPort);

          const pm2Name = `app-${appId}`;
          try { execFileSync('pm2', ['delete', pm2Name], EXEC_OPTS); } catch { /* best effort */ }

          // Re-start with production name
          try { execFileSync('pm2', ['delete', pm2NameStaging], EXEC_OPTS); } catch { /* best effort */ }
          if (pkg?.scripts?.start) {
            execFileSync('pm2', ['start', 'npm', '--name', pm2Name, '--', 'start'], { ...EXEC_OPTS, cwd: appDir, env: processEnv });
          } else {
            const mainFile = pkg?.main || 'server.js';
            execFileSync('pm2', ['start', mainFile, '--name', pm2Name], { ...EXEC_OPTS, cwd: appDir, env: processEnv });
          }

          const publicAddress = app.host_address || process.env.PUBLIC_IP || null;
          const deployUrl = publicAddress
            ? `http://${publicAddress}/apps/${appId}/`
            : `http://localhost:${tempPort}`;

          // Update DB: rolled back — clear previous_commit
          this.db.prepare(`
            UPDATE apps SET
              status = 'live', port = ?, previous_port = ?,
              current_commit = ?, previous_commit = NULL,
              deploy_url = ?, updated_at = ?, error_message = NULL, restart_count = 0
            WHERE id = ?
          `).run(tempPort, oldPort, targetCommit, deployUrl, Date.now(), appId);

          this.recordHistory(appId, 'rollback', {
            from_commit: currentCommit,
            to_commit: targetCommit,
            from_port: oldPort,
            to_port: tempPort,
            status: 'success',
            duration_ms: Date.now() - startTime,
          });

          console.log(`[app-manager] Rollback complete for ${appId}: restored to ${targetCommit.slice(0, 8)}`);
          return { success: true, restoredCommit: targetCommit };
        } else {
          // Rollback staging failed — restore original commit
          try { execFileSync('pm2', ['delete', pm2NameStaging], EXEC_OPTS); } catch { /* best effort */ }

          if (currentCommit) {
            try { const gitRestore = new GitOps(appDir); gitRestore.checkout(currentCommit); } catch { /* best effort */ }
          }

          const error = 'Rollback staging health check failed — original process continues running';
          this.db.prepare('UPDATE apps SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
            .run('live', error, Date.now(), appId);

          this.recordHistory(appId, 'rollback', {
            from_commit: currentCommit,
            to_commit: targetCommit,
            from_port: oldPort,
            to_port: tempPort,
            status: 'failed',
            error,
            duration_ms: Date.now() - startTime,
          });

          console.log(`[app-manager] Rollback failed for ${appId}: staging health check did not pass`);
          return { success: false, error };
        }
      }
    } catch (err: any) {
      const error = err.message || String(err);
      this.db.prepare('UPDATE apps SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
        .run('live', error, Date.now(), appId);
      this.recordHistory(appId, 'rollback', {
        from_commit: app.current_commit,
        to_commit: app.previous_commit,
        status: 'failed',
        error,
        duration_ms: Date.now() - startTime,
      });
      console.log(`[app-manager] Rollback failed for ${appId}: ${error}`);
      return { success: false, error };
    }
  }

  // ── Migrate ──────────────────────────────────────────────────────────────

  async migrate(appId: string, targetPeerId?: string): Promise<DeployResult> {
    const app = this.get(appId);
    if (!app) return { success: false, error: `App ${appId} not found` };

    // Find new target if not specified
    let newTarget: { peerId: string; address: string } | null = null;
    if (targetPeerId) {
      const capRegistry = this.node.getCapabilityRegistry?.();
      const profile = capRegistry?.getAllProfiles()?.find((p: any) => p.peerId === targetPeerId);
      if (profile) {
        newTarget = { peerId: targetPeerId, address: profile.publicAddress || '' };
      }
    } else {
      newTarget = this.findDeployTarget();
    }

    if (!newTarget) {
      return { success: false, error: 'No migration target available' };
    }

    // Undeploy from old host (best-effort)
    if (app.host_peer_id) {
      try {
        const httpClient = this.node.httpPeerClient;
        if (httpClient) {
          await httpClient.sendRequest(app.host_peer_id, `/v1/apps/${encodeURIComponent(appId)}`, {}, 30_000);
        }
      } catch { /* old host may be down — that's why we're migrating */ }
    }

    // Update to new target
    this.db.prepare('UPDATE apps SET host_peer_id = ?, host_address = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(newTarget.peerId, newTarget.address, 'registered', Date.now(), appId);

    // Deploy on new target
    const result = await this.deploy(appId);

    if (result.success) {
      this.recordHistory(appId, 'migrate', {
        status: 'success',
      });
      console.log(`[app-manager] Migrated ${appId} to ${newTarget.peerId.slice(0, 8)}`);
    }

    return result;
  }

  // ── Undeploy ─────────────────────────────────────────────────────────────

  async undeploy(appId: string): Promise<void> {
    const app = this.get(appId);
    if (!app) {
      console.log(`[app-manager] Cannot undeploy ${appId}: not found`);
      return;
    }

    const pm2Name = `app-${appId}`;

    // 1. Stop PM2 process
    if (app.tier === 2) {
      try {
        execFileSync('pm2', ['delete', pm2Name], EXEC_OPTS);
        console.log(`[app-manager] PM2 process ${pm2Name} deleted`);
      } catch {
        console.log(`[app-manager] PM2 process ${pm2Name} not found (already stopped?)`);
      }
    }

    // 2. Remove nginx config
    this.removeNginx(appId);

    // 3. Optionally delete app files
    const appDir = join(APPS_BASE_DIR, appId);
    if (existsSync(appDir)) {
      try {
        rmSync(appDir, { recursive: true, force: true });
        console.log(`[app-manager] Deleted app files at ${appDir}`);
      } catch (err: any) {
        console.log(`[app-manager] Could not delete app files: ${err.message}`);
      }
    }

    // 4. Update DB
    this.db.prepare(`
      UPDATE apps SET
        status = 'stopped', port = NULL, previous_port = NULL,
        error_message = NULL, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), appId);

    this.recordHistory(appId, 'undeploy', {
      from_commit: app.current_commit,
      from_port: app.port,
      status: 'success',
    });

    console.log(`[app-manager] Undeployed ${appId}`);
  }

  // ── Health Check ─────────────────────────────────────────────────────────

  async healthCheck(
    appId: string,
    port?: number | null,
    endpoint?: string | null,
    timeout?: number | null,
  ): Promise<boolean> {
    // Resolve actual values from app record if not provided directly
    let resolvedPort = port;
    let resolvedEndpoint = endpoint;
    let resolvedTimeout = timeout;

    if (resolvedPort === undefined || resolvedEndpoint === undefined || resolvedTimeout === undefined) {
      const app = this.get(appId);
      if (!app) return false;
      if (resolvedPort === undefined || resolvedPort === null) resolvedPort = app.port;
      if (resolvedEndpoint === undefined || resolvedEndpoint === null) resolvedEndpoint = app.health_endpoint;
      if (resolvedTimeout === undefined || resolvedTimeout === null) resolvedTimeout = app.health_timeout;
    }

    if (!resolvedPort) return false;

    const url = `http://127.0.0.1:${resolvedPort}${resolvedEndpoint || '/health'}`;
    const timeoutMs = resolvedTimeout || 10_000;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok; // 2xx
    } catch {
      return false;
    }
  }

  // ── Monitoring ───────────────────────────────────────────────────────────

  startMonitoring(intervalMs: number = 30_000): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
    }

    this.healthTimer = setInterval(async () => {
      await this.monitorCycle();
    }, intervalMs);

    console.log(`[app-manager] Health monitoring started (interval: ${intervalMs}ms)`);
  }

  stopMonitoring(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
      console.log('[app-manager] Health monitoring stopped');
    }
  }

  private async monitorCycle(): Promise<void> {
    // Only check Tier 2 apps that are live or unhealthy
    const apps = this.db.prepare(
      "SELECT * FROM apps WHERE tier = 2 AND status IN ('live', 'unhealthy')",
    ).all() as App[];

    for (const app of apps) {
      if (!app.port) continue;

      const healthy = await this.healthCheck(app.id, app.port, app.health_endpoint, app.health_timeout);

      if (healthy) {
        // Update last_health_at
        this.db.prepare('UPDATE apps SET last_health_at = ? WHERE id = ?')
          .run(Date.now(), app.id);

        // If was unhealthy, mark as live again and reset restart count
        if (app.status === 'unhealthy') {
          this.db.prepare('UPDATE apps SET status = ?, restart_count = 0, error_message = NULL WHERE id = ?')
            .run('live', app.id);
          console.log(`[app-manager] ${app.id} recovered — status: live`);
        }
      } else {
        // Health check failed
        const newRestartCount = app.restart_count + 1;

        if (newRestartCount < app.max_restarts) {
          // Attempt restart
          const pm2Name = `app-${app.id}`;
          try {
            execFileSync('pm2', ['restart', pm2Name], EXEC_OPTS);
            console.log(`[app-manager] Restarted ${app.id} (attempt ${newRestartCount}/${app.max_restarts})`);
          } catch (err: any) {
            console.log(`[app-manager] Failed to restart ${app.id}: ${err.message}`);
          }

          this.db.prepare(`
            UPDATE apps SET status = 'unhealthy', restart_count = ?, error_message = ?, updated_at = ?
            WHERE id = ?
          `).run(newRestartCount, `Health check failed — restart attempt ${newRestartCount}`, Date.now(), app.id);

          this.recordHistory(app.id, 'restart', {
            from_port: app.port,
            to_port: app.port,
            status: 'success',
          });
        } else {
          // Circuit breaker — stop restarting
          const error = `Max restarts exceeded (${app.max_restarts}) — circuit breaker tripped`;
          this.db.prepare(`
            UPDATE apps SET status = 'failed', restart_count = ?, error_message = ?, updated_at = ?
            WHERE id = ?
          `).run(newRestartCount, error, Date.now(), app.id);

          this.recordHistory(app.id, 'restart', {
            from_port: app.port,
            to_port: app.port,
            status: 'failed',
            error,
          });

          console.log(`[app-manager] Circuit breaker for ${app.id}: ${error}`);
        }
      }
    }
  }

  // ── History ──────────────────────────────────────────────────────────────

  recordHistory(
    appId: string,
    action: string,
    details: {
      from_commit?: string | null;
      to_commit?: string | null;
      from_port?: number | null;
      to_port?: number | null;
      status: string;
      error?: string | null;
      duration_ms?: number | null;
    },
  ): void {
    this.db.prepare(`
      INSERT INTO app_history
        (app_id, action, from_commit, to_commit, from_port, to_port, status, error, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      appId,
      action,
      details.from_commit || null,
      details.to_commit || null,
      details.from_port ?? null,
      details.to_port ?? null,
      details.status,
      details.error || null,
      details.duration_ms ?? null,
      Date.now(),
    );
  }

  getHistory(appId: string, limit: number = 50): AppHistory[] {
    return this.db.prepare(
      'SELECT * FROM app_history WHERE app_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(appId, limit) as AppHistory[];
  }

  // ── Port Allocation ──────────────────────────────────────────────────────

  allocatePort(): number {
    // Find lowest available port starting at 3001 by checking what's already allocated in DB
    const usedPorts = this.db.prepare(
      "SELECT port FROM apps WHERE port IS NOT NULL AND status NOT IN ('stopped')",
    ).all() as { port: number }[];

    const usedSet = new Set(usedPorts.map(r => r.port));

    let port = 3001;
    while (usedSet.has(port)) {
      port++;
    }

    return port;
  }

  releasePort(port: number): void {
    // Clear previous_port for any app that has this port stored as previous
    this.db.prepare('UPDATE apps SET previous_port = NULL WHERE previous_port = ?').run(port);
  }

  // ── nginx ────────────────────────────────────────────────────────────────

  updateNginx(appId: string, port: number): void {
    try {
      mkdirSync(NGINX_CONF_DIR, { recursive: true });

      const nginxConf = `# Auto-generated by Pando AppManager — ${appId}
location /apps/${appId}/ {
    proxy_pass http://127.0.0.1:${port}/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
`;
      writeFileSync(join(NGINX_CONF_DIR, `${appId}.conf`), nginxConf);
      execSync('sudo nginx -s reload', { ...EXEC_OPTS, timeout: 10_000 });
      console.log(`[app-manager] nginx config written for ${appId} → port ${port}`);
    } catch (err: any) {
      console.log(`[app-manager] nginx config skipped (not on EC2?): ${err.message}`);
    }
  }

  removeNginx(appId: string): void {
    try {
      const confPath = join(NGINX_CONF_DIR, `${appId}.conf`);
      if (existsSync(confPath)) {
        unlinkSync(confPath);
        execSync('sudo nginx -s reload', { ...EXEC_OPTS, timeout: 10_000 });
        console.log(`[app-manager] nginx config removed for ${appId}`);
      }
    } catch (err: any) {
      console.log(`[app-manager] nginx cleanup skipped: ${err.message}`);
    }
  }

  // ── Tier Detection ───────────────────────────────────────────────────────

  /**
   * Detect whether a directory contains a Tier 1 (static) or Tier 2 (server) app.
   * Static method — can be called without an AppManager instance.
   */
  static detectTier(appDir: string): { tier: 1 | 2; reason: string } {
    const pkgPath = join(appDir, 'package.json');
    if (!existsSync(pkgPath)) {
      return { tier: 1, reason: 'No package.json — static files only' };
    }

    let pkg: any;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      return { tier: 1, reason: 'package.json unreadable — treating as static' };
    }

    // Check 1: start script → needs a server → Tier 2
    if (pkg.scripts?.start) {
      return { tier: 2, reason: `package.json has start script: "${pkg.scripts.start}"` };
    }

    // Check 2: server-related dependencies → Tier 2
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const serverDeps = [
      'express', 'fastify', 'koa', 'hapi', '@hapi/hapi', '@nestjs/core',
      'socket.io', 'ws', 'http-server',
    ];
    const foundServerDep = serverDeps.find(d => d in allDeps);
    if (foundServerDep) {
      return { tier: 2, reason: `Server dependency found: ${foundServerDep}` };
    }

    // Check 3: package.json "main" points to a server file → Tier 2
    const serverFileNames = ['server.js', 'server.ts', 'app.js', 'app.ts'];
    if (pkg.main && serverFileNames.includes(pkg.main)) {
      return { tier: 2, reason: `package.json main points to server file: ${pkg.main}` };
    }

    // Check 4: backend/ or server/ directory → Tier 2
    if (existsSync(join(appDir, 'backend')) || existsSync(join(appDir, 'server'))) {
      return { tier: 2, reason: 'backend/ or server/ directory found' };
    }

    // Default: package.json but no server indicators → Tier 1
    return { tier: 1, reason: 'package.json present but no server indicators — static app' };
  }

  // ── P2P Deploy Dispatch ──────────────────────────────────────────────────

  /**
   * Find a secure EC2 node to deploy this app on.
   * Secure nodes have credentialAccess=true and storageBackend='mongodb'.
   * Returns the peerId + address of the best target, or null if none found (deploy locally).
   */
  private findDeployTarget(): { peerId: string; address: string } | null {
    const capRegistry = this.node.getCapabilityRegistry?.();
    if (!capRegistry) return null;

    const profiles = capRegistry.getAllProfiles();
    const selfPeerId = this.node.getIdentity?.()?.peerId;

    // Find remote secure nodes (prefer remote over self)
    const candidates = profiles.filter((p: any) =>
      p.credentialAccess === true &&
      p.storageBackend === 'mongodb' &&
      p.peerId !== selfPeerId
    );

    if (candidates.length > 0) {
      const target = candidates[0];
      return {
        peerId: target.peerId,
        address: target.publicAddress || target.details?.httpApi?.host || '',
      };
    }

    // Fallback: self-deploy if THIS node is secure
    const selfProfile = profiles.find((p: any) => p.peerId === selfPeerId);
    if (selfProfile?.credentialAccess === true) {
      return null; // null = deploy locally
    }

    return null; // No secure nodes available — try locally anyway
  }

  /**
   * Forward an app operation to a remote node via HTTP.
   * Uses the remote node's /v1/apps/* API endpoints.
   */
  private async forwardToRemote(
    peerId: string,
    appId: string,
    operation: 'deploy' | 'update' | 'rollback',
    appConfig?: AppConfig,
  ): Promise<DeployResult | UpdateResult | RollbackResult> {
    const httpClient = this.node.httpPeerClient;
    if (!httpClient) {
      throw new Error('HttpPeerClient not available — cannot forward to remote node');
    }

    // If this is a new app, register it on the remote node first
    if (appConfig) {
      try {
        await httpClient.sendRequest(peerId, '/v1/apps', appConfig, 30_000);
        console.log(`[app-manager] Registered ${appId} on remote node ${peerId.slice(0, 8)}`);
      } catch (err: any) {
        // If already registered, that's fine
        if (!err.message?.includes('already')) {
          console.warn(`[app-manager] Remote registration note: ${err.message?.slice(0, 100)}`);
        }
      }
    }

    // Forward the operation
    const result = await httpClient.sendRequest(
      peerId,
      `/v1/apps/${encodeURIComponent(appId)}/${operation}`,
      {},
      300_000, // 5 min timeout for deploy/update
    );

    console.log(`[app-manager] Forwarded ${operation} for ${appId} to ${peerId.slice(0, 8)} — result:`, result?.success);
    return result;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private cloneOrPull(appDir: string, repoUrl: string): void {
    // Validate repoUrl to prevent command injection (only allow valid git URLs)
    if (!/^https?:\/\/[^\s;|&`$]+$/.test(repoUrl) && !/^git@[^\s;|&`$]+$/.test(repoUrl)) {
      throw new Error(`Invalid repo URL: ${repoUrl.slice(0, 50)}`);
    }
    if (existsSync(join(appDir, '.git'))) {
      const git = new GitOps(appDir);
      git.pull('origin', 'main');
      console.log(`[app-manager] Updated ${repoUrl} in ${appDir}`);
    } else {
      // Clone to tmp dir, move files, delete tmp (same pattern as init-platform.ts)
      const tmpDir = appDir + '-tmp-' + Date.now();
      GitOps.cloneSync(repoUrl, tmpDir);

      const { renameSync } = require('node:fs') as typeof import('node:fs');
      for (const f of readdirSync(tmpDir)) {
        renameSync(join(tmpDir, f), join(appDir, f));
      }
      rmSync(tmpDir, { recursive: true, force: true });
      console.log(`[app-manager] Cloned ${repoUrl} to ${appDir}`);
    }
  }

  private getCommit(appDir: string): string {
    try {
      const git = new GitOps(appDir);
      return git.getCurrentCommit();
    } catch {
      return 'unknown';
    }
  }

  private readPackageJson(appDir: string): any | null {
    const pkgPath = join(appDir, 'package.json');
    if (!existsSync(pkgPath)) return null;
    try {
      return JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  private runBuildIfNeeded(appDir: string, buildCmd: string): void {
    const pkg = this.readPackageJson(appDir);
    if (!pkg) return;

    // Check if build script exists in package.json
    if (buildCmd === 'npm run build') {
      if (!pkg.scripts?.build) return;
    }

    // Security: only allow `npm run <script>` or `npx <tool>` patterns to prevent injection
    const allowedPattern = /^(npm run [a-zA-Z0-9_:.-]+|npx [a-zA-Z0-9_@/.:-]+)$/;
    if (!allowedPattern.test(buildCmd)) {
      console.warn(`[app-manager] Rejected unsafe buildCmd: ${buildCmd.slice(0, 50)}`);
      return;
    }

    try {
      // Split into command + args for execFileSync (no shell injection)
      const parts = buildCmd.split(' ');
      execFileSync(parts[0], parts.slice(1), { ...INSTALL_OPTS, cwd: appDir });
      console.log(`[app-manager] Build complete: ${buildCmd}`);
    } catch (err: any) {
      console.log(`[app-manager] Build failed (continuing): ${err.message?.slice(0, 200)}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Resolve a workspace directory for a given appId.
   * Chat-created projects live at ~/.pando/projects/{appId}.
   * Returns the path if it exists and has deployable content, null otherwise.
   */
  private resolveWorkspace(appId: string): string | null {
    if (!SAFE_ID.test(appId)) return null;
    const wsDir = join(WORKSPACE_BASE_DIR, appId);
    // Guard against path traversal
    const rel = relative(WORKSPACE_BASE_DIR, wsDir);
    if (rel.startsWith('..') || rel.includes('..')) return null;
    if (!existsSync(wsDir)) return null;

    // Verify workspace has deployable content
    try {
      const entries = readdirSync(wsDir);
      const hasContent = entries.some(e =>
        e === 'package.json' || e === 'index.html' || e === 'server.js' ||
        e === 'app.js' || e === 'index.js' || e === 'main.js',
      );
      if (!hasContent && entries.length === 0) return null;
      // Even if no recognized entry file, a non-empty directory is still deployable
      // (could have subdirectories with content like public/)
      if (entries.length > 0) return wsDir;
    } catch {
      return null;
    }

    return null;
  }

  /**
   * Copy workspace files to the hosted-apps directory for deployment.
   * Skips node_modules and .git to keep the copy lightweight.
   */
  private copyWorkspaceToAppDir(workspaceDir: string, appDir: string): void {
    mkdirSync(appDir, { recursive: true });

    const entries = readdirSync(workspaceDir);
    for (const entry of entries) {
      // Skip heavy/irrelevant directories
      if (entry === 'node_modules' || entry === '.git') continue;

      const src = join(workspaceDir, entry);
      const dest = join(appDir, entry);

      try {
        const st = statSync(src);
        if (st.isDirectory()) {
          cpSync(src, dest, { recursive: true, force: true });
        } else {
          cpSync(src, dest, { force: true });
        }
      } catch (err: any) {
        console.log(`[app-manager] Could not copy ${entry}: ${err.message}`);
      }
    }
  }

  /**
   * Close the database connection and stop monitoring.
   * Call this during node shutdown.
   */
  close(): void {
    this.stopMonitoring();
    try { this.db.close(); } catch { /* already closed */ }
    console.log('[app-manager] Closed');
  }
}
