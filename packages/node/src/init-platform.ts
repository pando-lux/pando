import { WorkType, MessageType } from '@pando/shared';
import { ResourceRouter } from './platform/resource-router.js';
import { ResourceMeter } from './platform/resource-meter.js';
import { ResourceMarketplace } from './platform/resource-marketplace.js';
import { RegressionSuite } from './platform/regression-suite.js';
import { PaymentGate } from './core/payment-gate.js';
import { UserAccountStore } from './platform/user-accounts.js';
import { ProjectStore } from './platform/project-store.js';
import { RevenueEngine } from './platform/revenue-engine.js';
import { ContributionTracker } from './platform/contribution-tracker.js';
import { ContentRegistry } from './platform/content-registry.js';
import { ContentPublisher } from './platform/content-publish.js';
import { ContentMaintenance } from './platform/content-maintenance.js';
import { ThreadStore } from './platform/thread-store.js';
import { HostingService } from './platform/hosting-service.js';
import { CloudInstanceManager } from './core/cloud-instance-manager.js';
import { NetworkState } from './kernel/network-state.js';
import { LocalEnvironment } from './kernel/local-environment.js';
import { ApiServer } from './api/api-server.js';
import { safeGitReset } from './core/upgrade-protocol.js';
import { TeamRegistry } from './core/team-registry.js';
import { PANDO_INFRA_AGENTS } from './core/engine-adapter.js';
import type { CredentialStore } from './core/credential-store.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DEFAULT_MANAGER_ID = 'pando-node-mgr';

export async function initPlatform(node: any): Promise<void> {
    const dataDir = node.config.dataDir || join(homedir(), '.pando');

    // Phase B: Initialize ResourceRouter — smart task routing + error correction
    node.resourceRouter = new ResourceRouter(node.capabilityRegistry, node.requestReply, node.httpPeerClient);
    if (node.reputation) {
      node.resourceRouter.setReputationManager(node.reputation);
    }

    // Register task_forward handler so remote nodes can receive forwarded tasks
    node.requestReply.registerHandler('task_forward', async (req: any) => {
      const taskData = req.payload?.task;
      if (!taskData || !taskData.title) {
        return { error: 'Invalid task data' };
      }
      const tq = node.getActiveTaskQueue();
      if (!tq) {
        return { error: 'No task queue available' };
      }
      // Insert the forwarded task into local queue
      const task = tq.createTask({
        title: taskData.title,
        description: taskData.description || '',
        priority: taskData.priority || 'medium',
        createdBy: taskData.createdBy || req.from,
        managerId: taskData.managerId,
        requiredCapabilities: taskData.requiredCapabilities || (taskData as any).requiredResources,
      });
      console.log(`[resource-router] Received forwarded task ${task.id.slice(0, 8)}: ${task.title}`);
      return { taskId: task.id, accepted: true };
    });

    // Register deploy-app handler — compute nodes handle app deployment via P2P
    // Clones source from GitHub, installs deps, starts backend if needed
    // Phase 80: Persistent port registry — survives node restarts
    const PORT_REGISTRY_PATH = join(dataDir, 'app-ports.json');
    interface PortEntry { port: number; startedAt: number; appDir: string; }
    function loadPortRegistry(): Record<string, PortEntry> {
      try {
        return JSON.parse(readFileSync(PORT_REGISTRY_PATH, 'utf-8'));
      } catch { return {}; }
    }
    function savePortRegistry(registry: Record<string, PortEntry>): void {
      writeFileSync(PORT_REGISTRY_PATH, JSON.stringify(registry, null, 2));
    }
    function nextAvailablePort(registry: Record<string, PortEntry>): number {
      const used = Object.values(registry).map(e => e.port);
      return used.length === 0 ? 3001 : Math.max(...used) + 1;
    }

    node.requestReply.registerHandler('pando/deploy-app', async (req: any) => {
      const { projectId, repoUrl, tier, envVars } = req.payload || {};
      if (!projectId) return { error: 'Missing projectId' };
      if (!repoUrl) return { error: 'Missing repoUrl — GitHub is required for deployment' };

      const { join } = await import('node:path');
      const { mkdirSync, existsSync, readFileSync, readdirSync, statSync } = await import('node:fs');
      const { execSync } = await import('node:child_process');
      const appDir = join(dataDir, 'hosted-apps', projectId);
      mkdirSync(appDir, { recursive: true });

      // Phase 88: Auto-detect tier from inspecting the actual code
      function detectTierFromCode(dir: string): { detectedTier: 1 | 2; reason: string } {
        const pkgPath = join(dir, 'package.json');
        if (!existsSync(pkgPath)) {
          return { detectedTier: 1, reason: 'No package.json — static files only' };
        }

        let pkg: any;
        try { pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')); } catch {
          return { detectedTier: 1, reason: 'package.json unreadable — treating as static' };
        }

        // Check 1: start script → needs a server → Tier 2
        if (pkg.scripts?.start) {
          return { detectedTier: 2, reason: `package.json has start script: "${pkg.scripts.start}"` };
        }

        // Check 2: server-related dependencies → Tier 2
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const serverDeps = ['express', 'fastify', 'koa', 'hapi', '@hapi/hapi', '@nestjs/core', 'socket.io', 'ws', 'http-server'];
        const foundServerDep = serverDeps.find(d => d in allDeps);
        if (foundServerDep) {
          return { detectedTier: 2, reason: `Server dependency found: ${foundServerDep}` };
        }

        // Check 3: package.json "main" points to a server file → Tier 2
        const serverFileNames = ['server.js', 'server.ts', 'app.js', 'app.ts'];
        if (pkg.main && serverFileNames.includes(pkg.main)) {
          return { detectedTier: 2, reason: `package.json main points to server file: ${pkg.main}` };
        }

        // Check 4: backend/ or server/ directory → Tier 2
        if (existsSync(join(dir, 'backend')) || existsSync(join(dir, 'server'))) {
          return { detectedTier: 2, reason: 'backend/ or server/ directory found' };
        }

        // Default: package.json but no server indicators → frontend build tool or static → Tier 1
        return { detectedTier: 1, reason: 'package.json present but no server indicators — static app' };
      }

      try {
        // Kill existing process if re-deploying (Tier 2 only) — Phase 80: use PM2
        const portRegistry = loadPortRegistry();
        const existing = portRegistry[projectId];
        if (existing) {
          const pm2Name = `app-${projectId}`;
          try { execSync(`pm2 delete ${pm2Name}`, { stdio: 'pipe', timeout: 10_000 }); } catch {}
          delete portRegistry[projectId];
          savePortRegistry(portRegistry);
          console.log(`[deploy] Stopped existing PM2 process ${pm2Name} for ${projectId}`);
        }

        // Clone or pull from GitHub
        if (existsSync(join(appDir, '.git'))) {
          execSync('git pull origin main', { cwd: appDir, stdio: 'pipe', timeout: 60_000 });
          console.log(`[deploy] Updated ${repoUrl} in ${appDir}`);
        } else {
          const tmpDir = appDir + '-tmp-' + Date.now();
          execSync(`git clone ${repoUrl} ${tmpDir}`, { stdio: 'pipe', timeout: 60_000 });
          const { renameSync, rmSync } = await import('node:fs');
          for (const f of readdirSync(tmpDir)) {
            renameSync(join(tmpDir, f), join(appDir, f));
          }
          rmSync(tmpDir, { recursive: true, force: true });
          console.log(`[deploy] Cloned ${repoUrl} to ${appDir}`);
        }

        // ── Phase 88: Auto-detect tier from code ────────────────────────────
        const { detectedTier, reason: tierReason } = detectTierFromCode(appDir);
        if (detectedTier !== tier) {
          console.log(`[deploy] Tier override: requested=${tier}, detected=${detectedTier} (${tierReason})`);
        } else {
          console.log(`[deploy] Tier confirmed: ${detectedTier} (${tierReason})`);
        }
        const effectiveTier = detectedTier;

        // ── Tier 1: Upload static files to S3 ──────────────────────────────
        if (effectiveTier === 1) {
          console.log(`[deploy] Tier 1 — uploading static files to S3 for ${projectId}`);

          // Get S3 credentials from ResourceRegistry
          const registry = node.resourceRegistry;
          if (!registry) return { status: 'failed', error: 'ResourceRegistry not available on compute node' };

          const s3Resources = registry.findResources('storage_blob' as any);
          if (!s3Resources.length) return { status: 'failed', error: 'No storage_blob resource on compute node' };

          const s3Cred = await registry.getCredential(s3Resources[0].resourceId);
          if (!s3Cred) return { status: 'failed', error: 'Could not decrypt S3 credential' };

          // Parse S3 credential — JSON or simple accessKeyId:secretAccessKey format
          let s3Config: any;
          try { s3Config = JSON.parse(s3Cred); } catch {
            // Fallback: accessKeyId:secretAccessKey
            const parts = s3Cred.split(':');
            if (parts.length >= 2) {
              s3Config = {
                accessKeyId: parts[0],
                secretAccessKey: parts.slice(1).join(':'),
                region: s3Resources[0].metadata?.region || 'us-east-1',
                bucket: s3Resources[0].metadata?.bucket || 'pando-deployments',
              };
            } else {
              return { status: 'failed', error: 'S3 credential not in expected JSON or key:secret format' };
            }
          }

          // Upload files to S3
          const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
          const s3 = new S3Client({
            region: s3Config.region || 'us-east-1',
            credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey },
          });

          const bucket = s3Config.bucket || 'pando-deployments';
          const staticExts = new Set(['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.eot']);
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
            '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff',
            '.woff2': 'font/woff2', '.ttf': 'font/ttf',
          };

          // Inject gateway vars into HTML files
          const gatewayUrl = envVars?.PANDO_GATEWAY_URL || process.env.GATEWAY_PUBLIC_URL || '';
          const projectApiKey = envVars?.PANDO_PROJECT_API_KEY || '';

          let uploadCount = 0;
          const uploadPromises: Promise<void>[] = [];
          const uploadErrors: string[] = [];

          // Recursively find all static files
          const scanDir = (dir: string, prefix: string): void => {
            for (const entry of readdirSync(dir)) {
              const fullPath = join(dir, entry);
              const relPath = prefix ? `${prefix}/${entry}` : entry;
              try {
                const st = statSync(fullPath);
                if (st.isDirectory()) {
                  if (entry === 'node_modules' || entry === '.git') continue;
                  scanDir(fullPath, relPath);
                } else if (st.isFile()) {
                  const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
                  if (!staticExts.has(ext)) continue;

                  let content = readFileSync(fullPath);

                  // Inject gateway vars into HTML
                  if (ext === '.html' && gatewayUrl) {
                    let html = content.toString('utf-8');
                    const vars = [`window.PANDO_GATEWAY_URL="${gatewayUrl}"`, `window.PANDO_PROJECT_ID="${projectId}"`];
                    if (projectApiKey) vars.push(`window.PANDO_PROJECT_API_KEY="${projectApiKey}"`);
                    const script = `<script>${vars.join(';')};</script>`;
                    if (html.includes('<head>')) {
                      html = html.replace('<head>', '<head>' + script);
                    } else {
                      html = script + html;
                    }
                    content = Buffer.from(html, 'utf-8');
                  }

                  // Queue upload — collected in uploadPromises for proper await
                  const key = `public/${projectId}/${relPath}`;
                  const putCmd = new PutObjectCommand({
                    Bucket: bucket,
                    Key: key,
                    Body: content,
                    ContentType: mimeTypes[ext] || 'application/octet-stream',
                  });
                  uploadPromises.push(
                    s3.send(putCmd)
                      .then(() => { uploadCount++; })
                      .catch((e: any) => { uploadErrors.push(`${key}: ${e.message}`); })
                  );
                }
              } catch {}
            }
          };

          // Check if there's a public/ subdirectory — prefer it for Tier 1
          const publicDir = join(appDir, 'public');
          if (existsSync(publicDir) && statSync(publicDir).isDirectory()) {
            scanDir(publicDir, '');
          } else {
            scanDir(appDir, '');
          }

          // Await all S3 uploads
          await Promise.all(uploadPromises);
          if (uploadErrors.length > 0) {
            console.error(`[deploy] ${uploadErrors.length} S3 upload(s) failed: ${uploadErrors.slice(0, 3).join('; ')}`);
          }

          const s3Url = `http://${bucket}.s3-website-${s3Config.region || 'us-east-1'}.amazonaws.com/public/${projectId}/index.html`;
          console.log(`[deploy] Tier 1 complete: ${uploadCount} files uploaded → ${s3Url}`);

          return { status: 'deployed', projectId, type: 'static', s3Url, url: s3Url, fileCount: uploadCount, detectedTier: effectiveTier, tierReason };
        }

        // ── Tier 2: Run as backend app ──────────────────────────────────────
        if (effectiveTier === 2) {
          execSync('npm install --production', { cwd: appDir, stdio: 'pipe', timeout: 120_000 });
          console.log(`[deploy] Dependencies installed for ${projectId}`);

          const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf-8'));
          const startScript = pkg.scripts?.start;
          const mainFile = pkg.main || 'server.js';

          // Phase 80: PM2 process management with persistent port registry
          const currentRegistry = loadPortRegistry();
          const port = existing?.port || nextAvailablePort(currentRegistry);
          const pm2Name = `app-${projectId}`;

          // Build env var args for PM2
          const envObj: Record<string, string> = { PORT: String(port), NODE_ENV: 'production', ...(envVars || {}) };
          const envArgs = Object.entries(envObj).map(([k, v]) => `${k}=${v}`).join(' ');

          // Delete any existing PM2 process first
          try { execSync(`pm2 delete ${pm2Name}`, { stdio: 'pipe', timeout: 10_000 }); } catch {}

          if (startScript) {
            execSync(`env ${envArgs} pm2 start npm --name ${pm2Name} -- start`, { cwd: appDir, stdio: 'pipe', timeout: 30_000 });
          } else {
            execSync(`env ${envArgs} pm2 start ${mainFile} --name ${pm2Name}`, { cwd: appDir, stdio: 'pipe', timeout: 30_000 });
          }
          execSync('pm2 save', { stdio: 'pipe', timeout: 10_000 });

          // Update persistent port registry
          currentRegistry[projectId] = { port, startedAt: Date.now(), appDir };
          savePortRegistry(currentRegistry);

          // Phase 80: Write nginx reverse proxy config for stable URLs
          try {
            const { writeFileSync, mkdirSync: mkdirNginx } = await import('node:fs');
            const nginxConfDir = '/etc/nginx/pando-apps';
            mkdirNginx(nginxConfDir, { recursive: true });
            const nginxConf = `# Auto-generated by Pando deploy — ${projectId}
location /apps/${projectId}/ {
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
            writeFileSync(join(nginxConfDir, `${projectId}.conf`), nginxConf);
            execSync('sudo nginx -s reload', { stdio: 'pipe', timeout: 10_000 });
            console.log(`[deploy] nginx config written for ${projectId} → port ${port}`);
          } catch (nginxErr: any) {
            console.log(`[deploy] nginx config skipped (not on EC2?): ${nginxErr.message}`);
          }

          console.log(`[deploy] Started ${projectId} via PM2 as ${pm2Name} on port ${port}`);

          // Phase 87: Include publicAddress so caller can construct the URL
          const publicAddress = process.env.PUBLIC_IP || undefined;
          return { status: 'deployed', projectId, port, pm2Name, url: `http://localhost:${port}`, publicAddress, detectedTier: effectiveTier, tierReason };
        }

        // Fallback: code didn't match Tier 1 or Tier 2 detection — serve locally
        return { status: 'deployed', projectId, path: appDir, type: 'static', detectedTier: effectiveTier, tierReason };
      } catch (err: any) {
        console.log(`[deploy] Failed for ${projectId}: ${err.message}`);
        return { status: 'failed', error: err.message };
      }
    });

    // Phase 69 (follow-up): P2P credential proxy handler — EC2 nodes decrypt code_repository credentials
    // for non-secure nodes that lack CREDENTIAL_MASTER_KEY. Only code_repository type is allowed.
    node.requestReply.registerHandler('pando/get-credential', async (req: any) => {
      const { resourceId, type } = req.payload || {};
      if (!resourceId) return { error: 'Missing resourceId' };
      // Security: only proxy code_repository credentials (GitHub PAT). S3/MongoDB MUST stay on EC2.
      if (type !== 'code_repository') return { error: 'Credential type not proxyable' };
      const credStore = (node as any)._credentialStore as import('./core/credential-store.js').CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) return { error: 'This node cannot decrypt credentials' };
      const credential = await credStore.getCredential(resourceId);
      if (!credential) return { error: 'Credential not found or decryption failed' };
      return { credential };
    });

    // Phase 80: Register undeploy-app handler — remove apps from compute nodes
    node.requestReply.registerHandler('pando/undeploy-app', async (req: any) => {
      const { projectId, deleteFiles } = req.payload || {};
      if (!projectId) return { error: 'Missing projectId' };

      const { join } = await import('node:path');
      const { execSync } = await import('node:child_process');
      const { unlinkSync, rmSync, existsSync } = await import('node:fs');

      try {
        const pm2Name = `app-${projectId}`;

        // 1. Stop PM2 process
        try {
          execSync(`pm2 delete ${pm2Name}`, { stdio: 'pipe', timeout: 10_000 });
          execSync('pm2 save', { stdio: 'pipe', timeout: 10_000 });
          console.log(`[undeploy] PM2 process ${pm2Name} deleted`);
        } catch {
          console.log(`[undeploy] PM2 process ${pm2Name} not found (already stopped?)`);
        }

        // 2. Remove nginx config
        try {
          const nginxConf = `/etc/nginx/pando-apps/${projectId}.conf`;
          if (existsSync(nginxConf)) {
            unlinkSync(nginxConf);
            execSync('sudo nginx -s reload', { stdio: 'pipe', timeout: 10_000 });
            console.log(`[undeploy] nginx config removed for ${projectId}`);
          }
        } catch (e: any) {
          console.log(`[undeploy] nginx cleanup skipped: ${e.message}`);
        }

        // 3. Remove from port registry
        const registry = loadPortRegistry();
        delete registry[projectId];
        savePortRegistry(registry);

        // 4. Optionally delete app files
        if (deleteFiles) {
          const appDir = join(dataDir, 'hosted-apps', projectId);
          if (existsSync(appDir)) {
            rmSync(appDir, { recursive: true, force: true });
            console.log(`[undeploy] Deleted app files at ${appDir}`);
          }
        }

        console.log(`[undeploy] Project ${projectId} undeployed successfully`);
        return { status: 'undeployed', projectId };
      } catch (err: any) {
        console.log(`[undeploy] Failed for ${projectId}: ${err.message}`);
        return { status: 'failed', error: err.message };
      }
    });

    // Phase 80: Startup reconciliation — cross-check port registry with PM2 on secure/compute nodes
    if (node.config.nodeMode === 'compute' || node.config.nodeMode === 'secure') {
      try {
        const { execSync } = await import('node:child_process');
        const registry = loadPortRegistry();
        const registryIds = Object.keys(registry);

        if (registryIds.length > 0) {
          // Get PM2 process list
          let pm2Processes: string[] = [];
          try {
            const pm2Json = execSync('pm2 jlist', { stdio: 'pipe', timeout: 10_000 }).toString();
            const pm2List = JSON.parse(pm2Json);
            pm2Processes = pm2List.map((p: any) => p.name);
          } catch { /* PM2 not running or no processes */ }

          let orphans = 0;
          for (const projectId of registryIds) {
            const pm2Name = `app-${projectId}`;
            if (!pm2Processes.includes(pm2Name)) {
              console.log(`[reconcile] WARNING: ${projectId} in port registry but not in PM2 — orphan entry`);
              orphans++;
            }
          }
          // Check for PM2 processes not in registry
          for (const name of pm2Processes) {
            if (name.startsWith('app-')) {
              const projId = name.slice(4);
              if (!registry[projId]) {
                console.log(`[reconcile] WARNING: PM2 process ${name} not in port registry — unknown process`);
              }
            }
          }
          console.log(`[reconcile] Port registry: ${registryIds.length} entries, PM2: ${pm2Processes.length} app processes, orphans: ${orphans}`);
        }
      } catch (err: any) {
        console.log(`[reconcile] Startup reconciliation skipped: ${err.message}`);
      }
    }

    // Phase 67: Register pando/upgrade-node handler — compute instances can be upgraded via P2P
    node.requestReply.registerHandler('pando/upgrade-node', async (req: any) => {
      if (node.restartPending || node.upgradeInProgress) {
        return { status: 'already_in_progress' };
      }
      node.upgradeInProgress = true;
      try {
        const { execSync } = await import('node:child_process');
        const repoDir = process.cwd();

        // Ensure git safe.directory (compute instances: repo cloned by root, node runs as 'pando')
        try {
          execSync(`git config --global --add safe.directory ${repoDir}`, {
            cwd: repoDir, encoding: 'utf-8', timeout: 5_000, stdio: 'pipe',
          });
        } catch {}

        // Fetch + reset to origin/master (handles orphan-branch force pushes)
        execSync('git fetch origin master', {
          cwd: repoDir, encoding: 'utf-8', timeout: 120_000, stdio: 'pipe',
        });
        const localSha = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();
        const remoteSha = execSync('git rev-parse origin/master', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' }).trim();

        if (localSha === remoteSha) {
          node.upgradeInProgress = false;
          console.log('[upgrade-node] Already up to date');
          return { status: 'already_up_to_date', output: 'Already up to date.' };
        }

        safeGitReset(repoDir, 'origin/master');
        const pullOutput = `Updated ${localSha.slice(0, 8)} -> ${remoteSha.slice(0, 8)}`;
        console.log(`[upgrade-node] ${pullOutput}`);

        // Build
        console.log('[upgrade-node] Building...');
        execSync('npm run build', {
          cwd: repoDir, encoding: 'utf-8', timeout: 300_000, stdio: 'pipe',
        });
        console.log('[upgrade-node] Build complete. Scheduling restart...');

        // Schedule graceful restart (exit code 75 → launcher restarts)
        node.requestGracefulRestart('P2P upgrade request');
        return { status: 'restart_pending', output: pullOutput };
      } catch (err: any) {
        node.upgradeInProgress = false;
        console.error(`[upgrade-node] Failed: ${err.message}`);
        return { status: 'failed', error: err.message };
      }
    });

    // Phase 69: Register pando/ai-query handler — compute nodes serve AI queries for untrusted nodes
    node.requestReply.registerHandler('pando/ai-query', async (req: any) => {
      const credStore = (node as any)._credentialStore as CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) {
        return { error: 'Not a credential node' };
      }
      const { query } = req.payload || {};
      if (!query || typeof query !== 'string') return { error: 'Missing query' };

      const aiKey = await credStore.getActiveByType('ai_api_key');
      if (!aiKey) return { error: 'No AI keys available' };

      const result = aiKey.metadata?.provider === 'openai'
        ? await node.searchOpenAI(query, aiKey.credential, aiKey.metadata?.model || 'gpt-4o-mini')
        : await node.searchGemini(query, aiKey.credential, aiKey.metadata?.model || 'gemini-pro');
      if (result) {
        node.resourceMeter?.recordUsage(aiKey.resourceId, 'api_keys', {
          resourceType: 'api_keys', quantity: 1, unit: 'calls', timestamp: Date.now(),
        });
        // Reward contributor for API compute
        if (node.identity && node.ledger) {
          try { node.ledger.rewardWork(node.identity.peerId, WorkType.API_CONTRIBUTED, `ai-query:${req.from?.slice(0, 12)}`); } catch {}
        }
        return { answer: result.answer, sources: result.sources, confidence: result.confidence };
      }
      return { error: 'AI query failed' };
    });

    // P2P doorman proxy: EC2 nodes classify/answer chat messages using contributed OpenAI keys.
    // Non-EC2 nodes (Windows contributors) route here when they have no local OpenAI key.
    node.requestReply.registerHandler('pando/doorman-classify', async (req: any) => {
      const credStore = (node as any)._credentialStore as CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) {
        return { error: 'Not a credential node' };
      }
      const { message } = req.payload || {};
      if (!message || typeof message !== 'string') return { error: 'Missing message' };

      const aiKey = await credStore.getActiveByType('ai_api_key');
      if (!aiKey || aiKey.metadata?.provider !== 'openai') return { error: 'No OpenAI key' };

      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${aiKey.credential}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `You are the doorman for Pando, an AI-powered network that builds software projects.
Classify the user's message into ONE of these categories and respond with ONLY valid JSON:

1. "question" — general question, small talk, greeting, asking about Pando. You answer it directly.
2. "build" — user wants to BUILD something (app, website, tool, game, etc). Extract a short description.

JSON format:
For questions: {"intent":"question","response":"<your friendly answer, 1-3 sentences>"}
For builds: {"intent":"build","description":"<what they want built, 1 sentence>","tier":<1 or 2>}

Tier rules:
- Tier 1: Pure static apps (portfolio, landing page, simple form with no backend). HTML/CSS/JS only, no server.
- Tier 2: Anything that needs a server (chat, real-time, backend, database, auth, etc). When in doubt, Tier 2.

Be friendly and helpful. Keep answers short.`
              },
              { role: 'user', content: message },
            ],
            max_tokens: 256,
            temperature: 0.3,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const content = data?.choices?.[0]?.message?.content?.trim();
          if (content) {
            const cleaned = content.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
            const parsed = JSON.parse(cleaned);
            node.resourceMeter?.recordUsage(aiKey.resourceId, 'api_keys', {
              resourceType: 'api_keys', quantity: 1, unit: 'calls', timestamp: Date.now(),
            });
            return parsed;
          }
        }
      } catch (err: any) {
        console.log(`[doorman-proxy] Classification failed: ${err.message?.slice(0, 100)}`);
      }
      return { error: 'Classification failed' };
    });

    node.requestReply.registerHandler('pando/doorman-chat', async (req: any) => {
      const credStore = (node as any)._credentialStore as CredentialStore | undefined;
      if (!credStore?.hasDecryptionCapability()) {
        return { error: 'Not a credential node' };
      }
      const { message, history } = req.payload || {};
      if (!message || typeof message !== 'string') return { error: 'Missing message' };

      const aiKey = await credStore.getActiveByType('ai_api_key');
      if (!aiKey || aiKey.metadata?.provider !== 'openai') return { error: 'No OpenAI key' };

      try {
        const messages = [
          { role: 'system', content: 'You are a helpful AI assistant on the Pando network. Answer questions clearly and concisely.' },
          ...(Array.isArray(history) ? history.slice(-10) : []),
          { role: 'user', content: message },
        ];
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${aiKey.credential}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 512, temperature: 0.7 }),
          signal: AbortSignal.timeout(12000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const reply = data?.choices?.[0]?.message?.content?.trim();
          if (reply) {
            node.resourceMeter?.recordUsage(aiKey.resourceId, 'api_keys', {
              resourceType: 'api_keys', quantity: 1, unit: 'calls', timestamp: Date.now(),
            });
            return { reply };
          }
        }
      } catch (err: any) {
        console.log(`[doorman-proxy] Chat failed: ${err.message?.slice(0, 100)}`);
      }
      return { error: 'Chat failed' };
    });

    // Phase 83: Register pando/storage-proxy handler on compute nodes
    // Untrusted nodes proxy StorageBackend CRUD operations here
    node.requestReply.registerHandler('pando/storage-proxy', async (req: any) => {
      // Only serve if we have direct MongoDB (compute node)
      if (!node.storageBackend || typeof (node.storageBackend as any).getDb !== 'function') {
        return { error: 'Not a storage node' };
      }
      const { method, args } = req.payload || {};

      // Method allowlist — only StorageBackend CRUD methods
      const ALLOWED_METHODS = ['putRecord', 'getRecord', 'queryRecords', 'deleteRecord', 'listRecords', 'pushToArray'];
      if (!method || !ALLOWED_METHODS.includes(method)) {
        return { error: `Method not allowed: ${method}` };
      }

      // Collection blocklist — never proxy credential operations
      const collection = args?.collection;
      if (collection === 'pando_credentials') {
        return { error: 'Access denied: credential collection' };
      }

      try {
        const backend = node.storageBackend as any;
        let result: any;
        switch (method) {
          case 'putRecord':
            await backend.putRecord(args.collection, args.key, args.data);
            result = undefined;
            break;
          case 'getRecord':
            result = await backend.getRecord(args.collection, args.key);
            break;
          case 'queryRecords':
            result = await backend.queryRecords(args.collection, args.filter, args.options);
            break;
          case 'deleteRecord':
            await backend.deleteRecord(args.collection, args.key);
            result = undefined;
            break;
          case 'listRecords':
            result = await backend.listRecords(args.collection, args.filter);
            break;
          case 'pushToArray':
            await backend.pushToArray(args.collection, args.key, args.field, args.value);
            result = undefined;
            break;
        }
        // Phase 83: After proxy writes, refresh local caches (fire-and-forget)
        const isWrite = ['putRecord', 'deleteRecord', 'pushToArray'].includes(method);
        if (isWrite && collection) {
          if ((collection === 'threads' || collection === 'thread_messages') && node.threadStore) {
            node.threadStore.loadFromBackend().catch(() => {});
          }
        }

        return { result };
      } catch (err) {
        return { error: `Storage proxy error: ${(err as Error).message}` };
      }
    });

    // Phase C: Initialize ResourceMeter — resource usage metering
    node.resourceMeter = new ResourceMeter(dataDir);
    node.resourceMeter.startMeteringLoop(60_000); // prune + save every 60s

    // Phase D: Initialize ResourceMarketplace — marketplace pricing
    node.resourceMarketplace = new ResourceMarketplace(node.capabilityRegistry);
    node.resourceMarketplace.setNetwork(node.network);
    node.resourceMarketplace.setLocalPeerId(node.identity.peerId);

    // Subscribe to pando/marketplace GossipSub topic for peer price broadcasts
    await node.resourceMarketplace.subscribeMarketplaceTopic();

    // Also handle legacy price broadcasts via capabilities topic (Phase D backward compat)
    node.network.onPriceBroadcast((priceList: any, fromPeerId: any) => {
      node.resourceMarketplace?.handlePriceBroadcast(fromPeerId, priceList);
    });

    // Broadcast initial prices
    try {
      await node.resourceMarketplace.broadcastPrices();
    } catch {}

    console.log('[resources] ResourceRouter + ResourceMeter + ResourceMarketplace initialized');

    // Phase 17.6: Regression Suite — persistent, auto-growing test suite
    node.regressionSuite = new RegressionSuite({
      dataDir,
      apiBaseUrl: `http://127.0.0.1:${node.config.apiPort}`,
    });
    console.log(`[regression] Suite loaded: ${node.regressionSuite.getStats().total} tests`);

    // Phase 18.6: Payment Gate — Lux escrow for task execution
    node.paymentGate = new PaymentGate(node.ledger, dataDir);
    console.log('[payment-gate] Initialized');

    // Unified identity system — Ed25519 keypairs, guest auto-creation, claim flow
    // Phase 56: Auth data lives in P2P-synced ledger, local keys in auth-local.db
    // Phase 86: Sessions removed — auth is stateless JWT issued by api-server
    node.userAccountStore = new UserAccountStore(node.ledger, dataDir);
    // Phase 35: Daily guest Lux reclamation — unclaimed guests older than 30 days
    // get remaining Lux transferred back to NETWORK for reuse
    const ledgerForReclaim = node.ledger;
    setInterval(() => {
      if (node.userAccountStore && ledgerForReclaim) {
        node.userAccountStore.reclaimExpiredGuests(ledgerForReclaim);
      }
    }, 24 * 60 * 60 * 1000); // Run daily
    // Also run once on startup (catches guests that expired while node was offline)
    setTimeout(() => {
      if (node.userAccountStore && ledgerForReclaim) {
        node.userAccountStore.reclaimExpiredGuests(ledgerForReclaim);
      }
    }, 60_000); // 1 minute after boot
    console.log('[user-accounts] Initialized (with guest Lux reclamation)');

    // Phase 57: User data stores require StorageBackend (MongoDB). Skip if no backend configured.
    if (node.storageBackend) {
      node.projectStore = new ProjectStore(node.ledger.getDatabase(), node.storageBackend);
      node.projectStore.init();

      node.revenueEngine = new RevenueEngine(node.ledger.getDatabase(), node.ledger, node.storageBackend);
      node.revenueEngine.init();

      node.contributionTracker = new ContributionTracker(node.ledger.getDatabase(), node.storageBackend);
      node.contributionTracker.init();
    }

    // Phase 11: Content Layer — persistent hosting & delivery registry
    node.contentRegistry = new ContentRegistry(node.ledger.getDatabase());
    node.contentRegistry.setLocalPeerId(node.identity.peerId);
    if (node.network) {
      node.contentRegistry.setNetwork(node.network);
      await node.contentRegistry.subscribeContentTopic();
    }
    node.contentPublisher = new ContentPublisher(node.contentRegistry);
    node.contentPublisher.setLocalPeerId(node.identity.peerId);
    node.contentMaintenance = new ContentMaintenance(node.contentRegistry);
    node.contentMaintenance.setLocalPeerId(node.identity.peerId);
    // Wire task creation into the scheduler task queue
    const tq = node.getActiveTaskQueue();
    if (tq) {
      node.contentMaintenance.setTaskCreator((title: string, description: string, priority: string) => {
        tq.createTask({
          title,
          description,
          priority: priority as any,
          createdBy: 'content-maintenance',
        });
      });
    }
    node.contentMaintenance.startMaintenanceLoop();
    console.log('[content-layer] ContentRegistry, ContentPublisher, ContentMaintenance initialized');

    // Phase 57: ThreadStore + data loading — only with StorageBackend
    // IMPORTANT: Data loading is non-blocking so API starts fast. P2P storage timeouts
    // (15s each) would otherwise block API startup for minutes on slow networks.
    if (node.storageBackend) {
      node.threadStore = new ThreadStore(node.storageBackend);
      // Fire and forget — data loads in background, retries via deferred loading on peer connect
      (async () => {
        try {
          await node.threadStore!.loadFromBackend();
          if (node.projectStore) await node.projectStore.loadFromBackend();
          if (node.revenueEngine) await (node.revenueEngine as any).loadFromBackend();
          if (node.contributionTracker) await (node.contributionTracker as any).loadFromBackend();
          node._p2pDataLoaded = true;
          console.log('[data] User data stores initialized (storage-backed)');
        } catch (err: any) {
          // Phase 83: P2PStorageBackend may fail if no compute peers yet — non-fatal
          // Will retry via deferred loading when first peer connects
          console.warn(`[data] Backend load failed (will retry when peers connect): ${err.message}`);
        }
      })();
    } else {
      console.log('[data] No StorageBackend — user data features disabled (P2P features still work)');
    }

    // Phase 63: Wire ProjectStore → ProjectRegistry bridge + seed existing projects
    if (node.projectStore && node.projectRegistry) {
      const pr = node.projectRegistry;
      const peerId = node.identity.peerId;
      const username = node.linkedUser?.username;

      // Write-through: when MongoDB writes happen, broadcast to P2P
      node.projectStore.setBroadcastCallback((action: string, project: any) => {
        const resourceIds = (project.resources || []).map((r: any) => r.resourceId);
        const currentUsername = node.linkedUser?.username || username;

        if (action === 'register' && project.apiKey) {
          pr.registerProject(
            project.id, project.name, peerId, project.apiKey, project.visibility,
            resourceIds, currentUsername, project.deploymentUrl, project.deploymentType, project.description
          );
        } else if (action === 'update') {
          // If the project has an API key but isn't in the P2P registry yet,
          // register it instead of updating (fixes generateApiKey() not reaching P2P)
          if (project.apiKey && !pr.getProject(project.id)) {
            pr.registerProject(
              project.id, project.name, peerId, project.apiKey, project.visibility,
              resourceIds, currentUsername, project.deploymentUrl, project.deploymentType, project.description
            );
          } else {
            pr.updateProject(project.id, {
              name: project.name,
              visibility: project.visibility,
              resourceIds,
              status: project.status,
              deploymentUrl: project.deploymentUrl,
              deploymentType: project.deploymentType,
              description: project.description,
            });
          }
        } else if (action === 'archive') {
          pr.archiveProject(project.id);
        }
      });

      // Seed: push existing projects from SQLite cache into P2P registry
      try {
        const existing = node.projectStore.listProjects();
        let seeded = 0;
        for (const p of existing) {
          if (p.apiKey && !pr.getProject(p.id)) {
            pr.registerProject(
              p.id, p.name, peerId, p.apiKey, p.visibility,
              (p.resources || []).map((r: any) => r.resourceId),
              username, p.deploymentUrl, p.deploymentType, p.description
            );
            seeded++;
          }
        }
        if (seeded > 0) console.log(`[project-registry] Seeded ${seeded} existing projects to P2P`);
      } catch (err) {
        console.log(`[project-registry] Seed from ProjectStore skipped: ${(err as Error).message}`);
      }
    }

    // Phase 32: S3 Hosting Service
    node.hostingService = new HostingService();
    console.log('[hosting] S3 hosting service initialized');

    // Phase 64: Cloud Instance Manager — EC2 compute node lifecycle
    node.cloudInstanceManager = new CloudInstanceManager(node);
    node.cloudInstanceManager.init().catch((err: any) =>
      console.warn(`[cloud-instances] Init failed (non-fatal): ${err.message}`));

    // Phase 50: Network State Aggregator — hourly snapshot for team lead reflection
    node.networkState = new NetworkState(node, dataDir);
    node.networkState.start();
    console.log('[network-state] Aggregator started (hourly snapshots)');

    // Teams managed by EngineAdapter — initialized in startEngine() + team bootstrap

    // v2.5: Local Environment — Envelope 1 file index + user memory (always on, no network)
    try {
      node.localEnv = new LocalEnvironment(dataDir);
      console.log(`[local-env] Initialized (${node.localEnv.getStatus().grantedDirs.length} dirs indexed)`);
    } catch (err: any) {
      console.warn(`[local-env] Init failed (non-fatal): ${err.message}`);
    }

    // Start HTTP API
    node.apiServer = new ApiServer(node);
    // Windows: '::' hangs on some systems, use '0.0.0.0' directly. Linux: '::' for dual-stack.
    const apiHost = process.platform === 'win32' ? '0.0.0.0' : '::';
    await node.apiServer.start({ port: node.config.apiPort, host: apiHost });

    // Wire SSE real-time event push — transactions and governance events
    node.sync.onTransaction((tx: any) => {
      node.apiServer?.pushEvent('transaction', {
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        type: tx.type,
        timestamp: tx.timestamp,
      });

      // Auto-snapshot: check if we've crossed the snapshot interval
      node.checkAutoSnapshot();
    });
    node.governance.onVote((vote: any, proposalTitle: any) => {
      node.apiServer?.pushEvent('vote', {
        proposalId: vote.proposalId,
        proposalTitle,
        voter: vote.voter,
        choice: vote.choice,
        timestamp: vote.createdAt,
      });
    });
    node.governance.onComment((comment: any) => {
      node.apiServer?.pushEvent('comment', {
        id: comment.id,
        proposalId: comment.proposalId,
        from: comment.from,
        content: comment.content.slice(0, 200),
        timestamp: comment.createdAt,
      });
    });
    node.governance.onDecision((decision: any, proposalTitle: any) => {
      node.apiServer?.pushEvent('decision', {
        proposalId: decision.proposalId,
        proposalTitle,
        outcome: decision.outcome,
        votesFor: decision.votesFor,
        votesAgainst: decision.votesAgainst,
        timestamp: decision.decidedAt,
      });

      // Phase 15.2: Governance → Task Pipeline
      // When a proposal passes, auto-create a scheduler task and approve it
      if (decision.outcome === 'passed') {
        const proposal = node.governance?.getProposal(decision.proposalId);
        const tq = node.getActiveTaskQueue();
        let createdTaskId: string | null = null;
        if (proposal && tq) {
          const taskTitle = proposal.title;
          const taskDesc = proposal.description + `\n\n[Auto-created from approved governance proposal ${decision.proposalId.slice(0, 8)}]`;
          const task = tq.createTask({
            title: taskTitle,
            description: taskDesc,
            priority: 'high',
            createdBy: proposal.proposedBy,
            proposalId: decision.proposalId,
          });
          createdTaskId = task.id;
          console.log(`[governance→scheduler] Proposal "${taskTitle}" approved → task created (${task.id.slice(0, 8)})`);

          // Auto-approve the task so the scheduler picks it up
          try {
            if (node.scheduler) {
              node.scheduler.receiveApprovedTask(task.id, DEFAULT_MANAGER_ID);
              console.log(`[governance→scheduler] Task ${task.id.slice(0, 8)} auto-approved`);
            }
          } catch (err: any) {
            console.error(`[governance→scheduler] Failed to auto-approve task: ${err.message}`);
          }
        }

        // Governance decisions are now handled by EngineAdapter — no MessageBus routing needed.
      }
    });
    // Wire activity sync — push remote activity events to SSE
    node.sync.onActivity((record: any) => {
      node.apiServer?.pushEvent('activity', {
        id: record.id,
        agentId: record.agentId,
        action: record.action,
        summary: record.summary,
        timestamp: record.timestamp,
      });
    });

    console.log('');
    console.log('Discovering peers...');

    // Epoch-based uptime tracking (every 10 minutes)
    node.uptimeTimer = setInterval(() => {
      node.recordUptimeEpoch();
    }, 10 * 60 * 1000);

    // Peer connection handler — register unknown peers and trigger sync
    node.network.onPeerConnect((peerId: any) => {
      if (!node.ledger!.accounts.exists(peerId)) {
        node.ledger!.registerNode(peerId, 'remote-peer');
      }

      // Record peer join for Sybil detection
      node.securityMonitor?.recordPeerJoin(peerId);

      // Request governance catch-up sync from the new peer (3s delay for protocol setup)
      if (node.governance) {
        setTimeout(() => {
          node.governance?.requestSync(peerId).catch(() => {});
        }, 3000);
      }

      // Request task catch-up sync from the new peer (2s delay for protocol setup)
      setTimeout(() => {
        node.getActiveTaskQueue()?.requestSync(peerId).catch(() => {});
      }, 2000);

    });

    // Start EngineAdapter — connects to @pando-code/core brain.
    // 'secure' and 'lightweight' modes skip engines (cloud instances don't have PandoCode).
    if (node.config.nodeMode !== 'compute' && node.config.nodeMode !== 'relay'
      && node.config.nodeMode !== 'secure' && node.config.nodeMode !== 'lightweight') {
      await node.startEngine();
    } else {
      console.log(`[node] Mode '${node.config.nodeMode}' — engine skipped.`);
    }

    // ── Team Registry + Bootstrap ──────────────────────────────────────
    // Initialize the TeamRegistry (SQLite + GossipSub sync) and auto-bootstrap
    // the pando-infra team if the EngineAdapter is available.
    try {
      const teamsDbPath = join(dataDir, 'teams', 'teams.db');
      const teamRegistry = new TeamRegistry(teamsDbPath, node.network, node.identity.peerId);
      (node as any)._teamRegistry = teamRegistry;

      // Subscribe to GossipSub team topic + wire peer sync
      teamRegistry.start();

      // Start orphan scan (5-minute interval, 20-minute stale threshold)
      teamRegistry.startOrphanScan();

      // Orphan detection callback: auto-claim + start orphaned teams
      teamRegistry.onOrphanDetected = (team) => {
        const adapter = node.getEngineAdapter?.();
        if (!adapter?.available) return;
        console.log(`[team-registry] Auto-claiming orphaned team: ${team.id}`);
        const claimed = teamRegistry.claimTeam(team.id);
        if (claimed) {
          // For pando-infra, use seed agents. For others, use a single default agent.
          const agents = team.id === 'pando-infra' ? PANDO_INFRA_AGENTS : [
            { id: 'lead', role: 'lead', displayName: `${team.displayName} Lead`, prompt: `You manage the ${team.displayName} team.` },
          ];
          adapter.startTeam(team.id, agents).catch((err: any) =>
            console.warn(`[team-registry] Failed to start claimed team ${team.id}: ${err.message}`)
          );
        }
      };

      // Auto-bootstrap pando-infra if EngineAdapter is available
      const adapter = node.getEngineAdapter?.();
      if (adapter?.available) {
        const existing = teamRegistry.getTeam('pando-infra');
        if (!existing) {
          // Create pando-infra team and claim it for this node
          teamRegistry.createTeam({
            id: 'pando-infra',
            displayName: 'Pando Infrastructure',
            managingNode: node.identity.peerId,
            lastHeartbeat: Date.now(),
            status: 'active',
            repos: ['pando-lux/node', 'pando-lux/code'],
            agentCount: PANDO_INFRA_AGENTS.length,
            governanceRequired: true,
            createdBy: node.identity.peerId,
            claimedAt: Date.now(),
          });
          console.log('[team-registry] pando-infra team created and claimed.');
        } else if (!existing.managingNode || existing.status === 'orphaned') {
          // Unclaimed or orphaned — claim it
          const claimed = teamRegistry.claimTeam('pando-infra');
          if (claimed) console.log('[team-registry] pando-infra team claimed (was orphaned).');
        }

        // If we manage pando-infra, start its agents
        const infra = teamRegistry.getTeam('pando-infra');
        if (infra && infra.managingNode === node.identity.peerId) {
          adapter.startTeam('pando-infra', PANDO_INFRA_AGENTS).catch((err: any) =>
            console.warn(`[team-registry] Failed to start pando-infra team: ${err.message}`)
          );
        }

        // Heartbeat for all teams we manage (every 5 minutes)
        const heartbeatInterval = setInterval(() => {
          const myTeams = teamRegistry.getTeamsForNode(node.identity.peerId);
          for (const team of myTeams) {
            teamRegistry.updateHeartbeat(team.id);
          }
        }, 5 * 60_000);
        heartbeatInterval.unref();
      }

      console.log('[team-registry] Initialized. Teams: ' + teamRegistry.listTeams().length);
    } catch (err: any) {
      console.warn(`[team-registry] Init failed (non-fatal): ${err.message}`);
    }

    // Handle messages and reward work
    node.network.onMessage((message: any, from: any) => {
      // Security: ignore messages from quarantined peers
      if (node.securityMonitor?.isQuarantined(from)) {
        console.log(`[security] Ignoring message from quarantined peer: ${from.slice(0, 16)}`);
        return;
      }

      // Record message for security rate monitoring
      node.securityMonitor?.recordMessage(from);

      console.log(`[${message.type}] from ${from.slice(0, 16)}...`);
      if (message.payload) {
        const payloadStr = JSON.stringify(message.payload);
        console.log(`  payload: ${payloadStr.length > 500 ? payloadStr.slice(0, 500) + '...[' + payloadStr.length + ' bytes]' : payloadStr}`);
      }

      // Ensure the sending peer has an account
      if (!node.ledger!.accounts.exists(from)) {
        node.ledger!.registerNode(from, 'remote-peer');
      }

      // Handle governance sync requests/responses (direct P2P messages)
      if (message.type === MessageType.GOVERNANCE_SYNC_REQUEST) {
        node.governance?.handleSyncRequest(from);
      }
      if (message.type === MessageType.GOVERNANCE_SYNC_RESPONSE) {
        node.governance?.handleSyncResponse(message);
      }

      // Handle task sync requests/responses (direct P2P messages)
      if (message.type === MessageType.TASK_SYNC_REQUEST) {
        node.getActiveTaskQueue()?.handleSyncRequest(from);
      }
      if (message.type === MessageType.TASK_SYNC_RESPONSE) {
        const payload = message.payload as { tasks?: any[] };
        if (payload?.tasks) {
          node.getActiveTaskQueue()?.handleSyncResponse(payload.tasks);
        }
      }

      // Handle balance requests
      if (message.type === MessageType.BALANCE_REQUEST) {
        const peerId = (message.payload as any)?.peerId || from;
        const peerBalance = node.ledger!.accounts.getBalance(peerId);
        node.network!.sendMessage(from, {
          type: MessageType.BALANCE_RESPONSE,
          from: node.identity!.peerId,
          timestamp: Date.now(),
          payload: { peerId, balance: peerBalance },
        }).catch(() => {});
      }

      // Phase A: Direct TCP request/reply removed — unicast uses HTTP (HttpPeerClient)

      // Phase 92: Direct TCP stream capability profile exchange
      // Fallback for GossipSub mesh failures (small networks where mesh doesn't form)
      if (message.type === MessageType.CAPABILITY_PROFILE_DIRECT) {
        const profile = message.payload as any;
        if (profile) {
          node.capabilityRegistry.updatePeerProfile(profile);
          const activeResources = Object.entries(profile.capabilities || {})
            .filter(([, v]) => v).map(([k]) => k);
          console.log(`[capabilities] Direct profile from ${from.slice(0, 12)}: [${activeResources.join(', ')}]`);
        }
      }

      // Peer exchange: receive peer list from a connected node and dial unknown peers.
      if (message.type === MessageType.PEER_EXCHANGE) {
        const exchangedPeers = (message.payload as any)?.peers as { peerId: string; addrs: string[] }[] | undefined;
        if (exchangedPeers && Array.isArray(exchangedPeers) && node.network) {
          const network = node.network;
          const myPeerId = node.identity!.peerId;
          const connectedPeers = new Set(network.getPeers().map((p: any) => p.peerId));
          console.log(`[peer-exchange] Received ${exchangedPeers.length} peer(s) from ${from.slice(0, 12)}, already connected to ${connectedPeers.size}`);
          (async () => {
            let dialed = 0;
            for (const peer of exchangedPeers) {
              if (peer.peerId === myPeerId || connectedPeers.has(peer.peerId)) continue;
              for (const addr of peer.addrs) {
                try {
                  await network.dialPeer(addr);
                  dialed++;
                  console.log(`[peer-exchange] Connected to ${peer.peerId.slice(0, 12)} via exchange from ${from.slice(0, 12)}`);
                  break;
                } catch {
                  // addr may be unreachable, try next
                }
              }
            }
            if (dialed > 0) {
              console.log(`[peer-exchange] Discovered ${dialed} new peer(s) from ${from.slice(0, 12)}`);
            }
          })().catch(() => {});
        }
      }
    });

    // v2.4: Subscribe to node_compromised broadcasts from peers
    await node.network.subscribeNodeCompromised();
    node.network.onNodeCompromised((compromisedPeerId: any, reason: any, timestamp: any) => {
      console.warn(`[security] Peer ${compromisedPeerId.slice(0, 12)} signaled compromise (${reason}) at ${new Date(timestamp).toISOString()}`);
      // Remove compromised peer from credential routing by marking them non-credentialAccess
      const profile = node.capabilityRegistry.getPeerProfile(compromisedPeerId);
      if (profile) {
        (profile as any).credentialAccess = false;
        (profile as any).compromisedAt = timestamp;
        node.capabilityRegistry.updatePeerProfile(profile);
        console.warn(`[security] Peer ${compromisedPeerId.slice(0, 12)} removed from credential routing`);
      }
    });

    // Safe self-restart watchdog: detect when the running process has stale compiled code.
    // Checks every 5 minutes: re-reads .build-commit from disk (upgrade catch-up may
    // have rebuilt and updated it), compares against git HEAD, and exits with code 75
    // if they differ and no active workers are in flight.
    {
      const buildCommitPaths = [
        join(process.cwd(), 'packages', 'node', 'dist', '.build-commit'),
        join(process.cwd(), 'dist', '.build-commit'),
      ];
      const readBuildCommit = (): string | null => {
        for (const p of buildCommitPaths) {
          try {
            const val = readFileSync(p, 'utf8').trim();
            if (val) return val;
          } catch { /* try next */ }
        }
        return null;
      };
      const initialCommit = readBuildCommit();
      if (initialCommit) {
        console.log(`[self-restart] Stale-build watchdog active (built at ${initialCommit.slice(0, 8)})`);
        let staleSinceTs: number | null = null; // Track when staleness was first detected
        const MAX_DEFER_MS = 5 * 60_000; // Max 5 minutes deferral then restart anyway
        const selfRestartInterval = setInterval(() => {
          try {
            // Re-read .build-commit each cycle — upgrade catch-up may have rebuilt
            const builtCommit = readBuildCommit();
            if (!builtCommit) return;
            const currentCommit = (execSync('git rev-parse HEAD', {
              cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
            }) as string).trim();
            if (currentCommit === builtCommit) {
              staleSinceTs = null; // Build is fresh
              // Build matches HEAD, but did the build change since this process started?
              if (builtCommit !== initialCommit) {
                console.log(`[self-restart] Build updated since startup (was=${initialCommit.slice(0, 8)}, now=${builtCommit.slice(0, 8)}) — restarting`);
                clearInterval(selfRestartInterval);
                node.selfRestart();
              }
              return;
            }
            // Build is stale — track how long
            if (!staleSinceTs) staleSinceTs = Date.now();
            const staleMs = Date.now() - staleSinceTs;
            const activeEngines = node.engineAdapter?.getActiveEngines()?.length ?? 0;
            if (activeEngines > 0 && staleMs < MAX_DEFER_MS) {
              console.log(`[self-restart] Stale build (built=${builtCommit.slice(0, 8)}, head=${currentCommit.slice(0, 8)}) — ${activeEngines} engine(s) active, deferring (${Math.round(staleMs / 1000)}s/${MAX_DEFER_MS / 1000}s)`);
              return;
            }
            // Either no active engines, or we've deferred long enough
            if (staleMs >= MAX_DEFER_MS) {
              console.log(`[self-restart] Stale build deferred for ${Math.round(staleMs / 1000)}s (max ${MAX_DEFER_MS / 1000}s) — rebuilding and restarting`);
            } else {
              console.log(`[self-restart] Stale build detected and no active engines — restarting`);
            }
            clearInterval(selfRestartInterval);
            // Rebuild before restarting to ensure dist/ is fresh
            try {
              console.log('[self-restart] Running npm run build...');
              execSync('npm run build', { cwd: process.cwd(), timeout: 180_000, stdio: 'pipe' });
              console.log('[self-restart] Rebuild complete — restarting');
            } catch (buildErr: any) {
              console.warn(`[self-restart] Rebuild failed (restarting anyway): ${(buildErr as Error).message?.slice(0, 200)}`);
            }
            node.selfRestart();
          } catch { /* git unavailable or cwd mismatch — skip silently */ }
        }, 60 * 1000);  // Check every 60s — fast restart after CEO commits
        selfRestartInterval.unref(); // don't prevent normal node exit
      } else {
        console.log('[self-restart] No build-commit stamp found — stale-build watchdog disabled (run npm run build to enable)');
      }
    }
}
