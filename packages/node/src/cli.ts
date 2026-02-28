import './polyfills.js';
import { PandoNode, detectClaudeCode } from './index.js';
import { parsePort } from './config.js';
import { MessageType, loadSession } from '@pando/shared';
import { FileLogger } from './logger.js';
const RESTART_EXIT_CODE = 75;
import { checkAndRecordStartup, markStable, getStabilityDelay } from './kernel/crash-guard.js';
import { readRestartReason, clearRestartReason } from './kernel/restart-reason.js';
import { QaRunner } from './platform/qa-runner.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, mkdirSync, existsSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';

// @know
// entity CliEntryPoint {
//   type: module
//   blueprint: NODE_CORE
//   status: active
//   description: "Non-interactive CLI entry point: parses flags, initializes PandoNode with MongoDB/storage backend, sets up file logging, crash guard, port pre-check, post-deploy health checks, and heartbeat reporting."
//   depends_on: [PandoNode, FileLogger, QaRunner, SharedCrypto]
//   @gotcha("Session-aware: tries loadSession() first for encrypted identities. If session.json exists, the node starts with that identity without prompting for password.")
//   @gotcha("Port pre-check: if API port is occupied, CLI attempts to shut down the existing instance via POST /admin/shutdown before failing.")
//   @gotcha("RESTART_EXIT_CODE = 75 — PM2/systemd/start-node.bat restarts the process when it exits with this code.")
//   @gotcha("MSYS2 path normalization: /c/Users/... is converted to C:\\Users\\... on Windows because path.join mishandles MSYS2 paths.")
//   @why("DEFAULT_BOOTSTRAPS contains 3 nodes (LS-1, EC2-1, EC2-2) for mesh connectivity — ensures new nodes connect to at least 2 bootstrap peers.")
//   @why("Public IP auto-detection uses AWS IMDS v1 (http://169.254.169.254/latest/meta-data/public-ipv4) with 2s timeout — works on EC2 and Lightsail, silently skips elsewhere.")
// }
//
// lesson PORT_PRECHECK {
//   in: CliEntryPoint
//   what: "Node failed to start because previous instance still held the API port"
//   why: "PM2 restart or crash left the old process running, and Fastify's listen() fails immediately on EADDRINUSE"
//   fix: "Added port pre-check that attempts graceful shutdown of existing instance via /admin/shutdown API, waits up to 15s for port release"
//   severity: warning
//   date: "2026-02"
// }
// @end

/**
 * Check if a TCP port is currently in use by attempting a connection.
 * Returns true if something is listening on the port.
 */
function isPortInUse(port: number, host: string = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Wait for a port to become free, polling every 1s up to maxWaitMs.
 * Returns true if the port is free, false if still occupied after timeout.
 */
async function waitForPortFree(port: number, maxWaitMs: number = 15_000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const inUse = await isPortInUse(port);
    if (!inUse) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

/**
 * Try to gracefully shut down an existing node instance on the given port
 * by calling POST /admin/shutdown with the API token from disk.
 */
async function tryShutdownExistingNode(apiPort: number, dataDir?: string): Promise<boolean> {
  // Load API token from disk
  const pandoDir = dataDir || join(homedir(), '.pando');
  const tokenPath = join(pandoDir, 'api-token');
  let apiToken = '';
  try {
    if (existsSync(tokenPath)) {
      apiToken = readFileSync(tokenPath, 'utf-8').trim();
    }
  } catch {
    return false;
  }

  if (!apiToken) {
    console.log('[cli] No API token found — cannot request shutdown of existing instance');
    return false;
  }

  try {
    console.log(`[cli] Requesting graceful shutdown of existing instance on port ${apiPort}...`);
    const response = await fetch(`http://127.0.0.1:${apiPort}/admin/shutdown`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'port-precheck-restart' }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      console.log('[cli] Existing instance accepted shutdown request');
      return true;
    } else {
      console.log(`[cli] Shutdown request returned HTTP ${response.status}`);
      return false;
    }
  } catch (err: any) {
    console.log(`[cli] Failed to contact existing instance: ${err.message}`);
    return false;
  }
}

// Default public bootstrap nodes for peer discovery.
// Phase 87: Multiple bootstraps for mesh connectivity (2+ peers per node).
// Phase 91: EC2-2 added now that it announces its public IP via announceAddresses.
const DEFAULT_BOOTSTRAPS: string[] = [
  '/ip4/54.145.144.221/tcp/4001/p2p/12D3KooWNSUWHf6tzHPb8uzUkaRfk3VfuMVrjzGgyueR4yioMGDP', // LS-1
  '/ip4/54.82.241.132/tcp/4001/p2p/12D3KooWDRjGzaUuATiPuhg5D2k1CQTT6nCMpjdsDTVwrGDC4QVP',  // EC2-1
  '/ip4/34.201.82.126/tcp/4001/p2p/12D3KooWLMnoeqedX6uTWoBbq2ZfRyYKpDtttdtp6uNfm3PeJ33d',  // EC2-2
];

async function main() {
  const args = process.argv.slice(2);

  // Phase 15.5: Crash Guard — detect crash loops and auto-rollback
  const dataDirFlag0 = args.indexOf('--data-dir');
  let dataDir0 = dataDirFlag0 !== -1 ? args[dataDirFlag0 + 1] : undefined;
  // Normalize MSYS2 paths on Windows (early, before crash guard needs the path)
  if (dataDir0 && process.platform === 'win32' && /^\/[a-zA-Z]\//.test(dataDir0)) {
    dataDir0 = dataDir0[1].toUpperCase() + ':' + dataDir0.slice(2).replace(/\//g, '\\');
  }
  const crashCheck = checkAndRecordStartup(dataDir0, process.cwd());
  if (crashCheck.rolledBack) {
    console.log('[cli] Binary rollback complete. Restarting with restored code...');
    process.exit(75); // Tell launcher to restart
  }
  if (crashCheck.crashLoop && !crashCheck.rolledBack) {
    console.error('[cli] CRASH LOOP: No backup available. Manual intervention required.');
    // Continue anyway — maybe the crash was transient
  }

  // --port <n> (P2P listen port)
  const portFlag = args.indexOf('--port');
  const port = portFlag !== -1 ? parsePort(args[portFlag + 1]) : 0;

  // --api-port <n> (HTTP API port, default 4000)
  // Falls back to PANDO_API_PORT env var, then 4000
  const apiPortFlag = args.indexOf('--api-port');
  const apiPort = apiPortFlag !== -1
    ? parsePort(args[apiPortFlag + 1])
    : (process.env.PANDO_API_PORT ? parsePort(process.env.PANDO_API_PORT) : 4000);

  // --data-dir <path> (isolate identity + ledger, default ~/.pando)
  const dataDirFlag = args.indexOf('--data-dir');
  let dataDir = dataDirFlag !== -1 ? args[dataDirFlag + 1] : undefined;
  // Normalize MSYS2 paths on Windows: /c/Users/... → C:\Users\...
  // Git Bash expands ~ to /c/Users/name which path.join() mishandles as \c\Users\...
  if (dataDir && process.platform === 'win32' && /^\/[a-zA-Z]\//.test(dataDir)) {
    dataDir = dataDir[1].toUpperCase() + ':' + dataDir.slice(2).replace(/\//g, '\\');
  }

  // --public — configure for public VPS deployment (binds to 0.0.0.0, logs public info)
  const isPublic = args.includes('--public') || args.includes('--relay');

  // --relay — act as a circuit relay server for NAT-ed peers (implies --public)
  const isRelay = args.includes('--relay');

  // --no-bootstrap — skip all default bootstrap peers (useful for the bootstrap node itself)
  const noBootstrap = args.includes('--no-bootstrap');

  // --bootstrap <multiaddr> (can repeat); falls back to default public nodes
  const bootstrapPeers: string[] = [];
  if (!noBootstrap) {
    let idx = args.indexOf('--bootstrap');
    while (idx !== -1) {
      if (args[idx + 1]) bootstrapPeers.push(args[idx + 1]);
      idx = args.indexOf('--bootstrap', idx + 1);
    }
    if (bootstrapPeers.length === 0) {
      bootstrapPeers.push(...DEFAULT_BOOTSTRAPS);
    }
  }

  // --mode <full|compute|relay> (node specialization, default: full)
  // 'full' = everything (default for double-click launchers, zero config)
  // 'compute' = P2P + hosting + resource proxy (auto-set for cloud instances)
  // 'relay' = P2P only, routing + network growth
  const modeFlag = args.indexOf('--mode');
  const nodeMode = modeFlag !== -1 ? (args[modeFlag + 1] as any) : 'full';
  if (!['full', 'compute', 'relay'].includes(nodeMode)) {
    console.error(`[cli] Invalid --mode: ${nodeMode}. Must be full, compute, or relay.`);
    process.exit(1);
  }

  // --ledger-mode <full|light> (ledger retention, default: full)
  // 'full' = keep all transactions forever
  // 'light' = keep last 30 days + balance checkpoints (for scale)
  const ledgerModeFlag = args.indexOf('--ledger-mode');
  const ledgerMode = ledgerModeFlag !== -1 ? (args[ledgerModeFlag + 1] as any) : 'full';
  if (!['full', 'light'].includes(ledgerMode)) {
    console.error(`[cli] Invalid --ledger-mode: ${ledgerMode}. Must be full or light.`);
    process.exit(1);
  }

  // MongoDB storage via PANDO_STORAGE_URL env var
  let storageUrl = process.env.PANDO_STORAGE_URL;
  // Legacy: --storage flag (still accepted, maps to same path)
  const storageFlag = args.indexOf('--storage');
  if (storageFlag !== -1 && args[storageFlag + 1]) {
    storageUrl = args[storageFlag + 1];
  }

  let publicIp = process.env.PUBLIC_IP?.trim() || undefined;

  // Auto-detect public IP for cloud nodes (when PUBLIC_IP env var isn't set).
  // Uses AWS IMDS (EC2/Lightsail) first, falls back to external service.
  if (!publicIp) {
    try {
      // AWS Instance Metadata Service v1 (works on EC2 and Lightsail)
      const imdsRes = await fetch('http://169.254.169.254/latest/meta-data/public-ipv4', {
        signal: AbortSignal.timeout(2000),
      });
      if (imdsRes.ok) {
        const ip = (await imdsRes.text()).trim();
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          publicIp = ip;
          console.log(`[cli] Auto-detected public IP via IMDS: ${publicIp}`);
        }
      }
    } catch {
      // Not on AWS or IMDS not available — skip
    }
  }

  const node = new PandoNode({
    listenPort: port,
    apiPort,
    bootstrapPeers,
    ...(dataDir ? { dataDir } : {}),
    ...(isRelay ? { relay: true } : {}),
    nodeMode: nodeMode as any,
    ledgerMode: ledgerMode as any,
    ...(publicIp ? { publicIp } : {}),
  });

  // Initialize MongoDB storage backend
  if (storageUrl && storageUrl !== 'local') {
    if (storageUrl.startsWith('mongodb')) {
      console.log('[cli] Initializing MongoDB storage backend...');
      try {
        const { MongoStorageBackend } = await import('./core/mongo-backend.js');
        const mongoBackend = new MongoStorageBackend(storageUrl);
        await mongoBackend.init();
        node.setStorageBackend(mongoBackend);
        console.log('[cli] MongoDB storage backend connected');
      } catch (err: any) {
        console.error(`[cli] FATAL: MongoDB storage backend failed to initialize: ${err.message}`);
        process.exit(1);
      }
    } else {
      console.error(`[cli] Unknown storage backend: ${storageUrl}. Use a MongoDB URL (mongodb://... or mongodb+srv://...).`);
      process.exit(1);
    }
  }

  // File logging — tee all console output to ~/.pando/logs/node.log
  const fileLogger = new FileLogger(dataDir);
  const origLog = console.log.bind(console);
  const origError = console.error.bind(console);
  console.log = (...args: any[]) => {
    const msg = args.map(String).join(' ');
    fileLogger.log(msg);
    origLog(...args);
  };
  console.error = (...args: any[]) => {
    const msg = args.map(String).join(' ');
    fileLogger.error(msg);
    origError(...args);
  };
  const origWarn = console.warn.bind(console);
  console.warn = (...args: any[]) => {
    const msg = args.map(String).join(' ');
    fileLogger.warn(msg);
    origWarn(...args);
  };

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await node.stop();
    fileLogger.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Port pre-check: ensure the API port is free before starting
  const portInUse = await isPortInUse(apiPort);
  if (portInUse) {
    console.log(`[cli] Port ${apiPort} is already in use. Attempting to shut down existing instance...`);

    const shutdownSent = await tryShutdownExistingNode(apiPort, dataDir);

    if (shutdownSent) {
      // Wait for the old instance to release the port (up to 15 seconds)
      const portFreed = await waitForPortFree(apiPort, 15_000);
      if (!portFreed) {
        console.error(`[cli] ERROR: Port ${apiPort} still in use after 15s. Cannot start node.`);
        console.error(`[cli] Kill the existing process manually and try again.`);
        process.exit(1);
      }
      console.log(`[cli] Port ${apiPort} is now free. Continuing startup...`);
    } else {
      // Could not send shutdown — wait briefly in case it's transient
      const portFreed = await waitForPortFree(apiPort, 5_000);
      if (!portFreed) {
        console.error(`[cli] ERROR: Port ${apiPort} is occupied and could not shut down the existing instance.`);
        console.error(`[cli] Kill the existing process manually or use --api-port to choose a different port.`);
        process.exit(1);
      }
      console.log(`[cli] Port ${apiPort} is now free. Continuing startup...`);
    }
  }

  // Try session.json first (works with encrypted identities)
  const session = await loadSession(node.getDataDir());
  if (session) {
    console.log(`[cli] Session restored: ${session.peerId}`);
    await node.startWithIdentity(session);
  } else {
    await node.start();
  }

  // Welcome message with peer ID and status URL
  const identity = node.getIdentity();
  if (identity) {
    console.log('');
    console.log('Pando — The Open Network');
    console.log(`  Peer ID:    ${identity.peerId}`);
    console.log(`  Mode:       ${nodeMode}${nodeMode === 'full' ? '' : ` (${nodeMode === 'compute' ? 'hosting + P2P' : 'P2P routing only'})`}`);
    console.log(`  Status:     http://127.0.0.1:${apiPort}/status`);
    console.log(`  Health:     http://127.0.0.1:${apiPort}/health`);
    console.log(`  Bootstrap:  ${bootstrapPeers.join(', ')}`);
    if (isPublic) {
      console.log('');
      console.log(isRelay ? '  ** RELAY NODE MODE **' : '  ** PUBLIC NODE MODE **');
      console.log(`  API bound to 0.0.0.0:${apiPort} (all interfaces)`);
      console.log(`  Ensure ports ${port || '<random>'} (P2P) and ${apiPort} (API) are open in your firewall`);
      console.log(`  Health check: http://<your-ip>:${apiPort}/health`);
      if (isRelay) {
        console.log('  Circuit relay: ACTIVE — NAT-ed peers can connect through this node');
      }
    }
    console.log('');
    console.log('Node running. Press Ctrl+C to stop.');
    console.log('');
  }

  // Agent system, pipeline, and scheduler only run in 'full' mode.
  // 'compute' and 'relay' modes skip these (no Claude Code on cloud instances).
  let schedulerEnabled = false;
  if (nodeMode === 'full') {
    // Enable Phase 16 pipeline if --pipeline flag was passed (must precede scheduler start)
    if (args.includes('--pipeline')) {
      console.log('[cli] Enabling Phase 16 code pipeline (--pipeline flag)...');
      node.enablePipeline();
    }

    // Phase 52.3: Scheduler auto-detection
    const explicitScheduler = args.includes('--scheduler');
    const noScheduler = args.includes('--no-scheduler');
    schedulerEnabled = explicitScheduler;

    if (!schedulerEnabled && !noScheduler) {
      const claudeDetected = detectClaudeCode();
      if (claudeDetected) {
        schedulerEnabled = true;
        console.log('[scheduler] Auto-detected Claude Code — scheduler enabled. Use --no-scheduler to disable.');
      }
    } else if (explicitScheduler) {
      console.log('[cli] Auto-starting scheduler (--scheduler flag)...');
    }

    if (schedulerEnabled) {
      node.startScheduler();
    }
  } else {
    console.log(`[cli] Mode '${nodeMode}' — agent system and scheduler disabled.`);
  }

  // Auto-start health monitor if scheduler is enabled or --monitor flag is passed
  if (args.includes('--monitor') || schedulerEnabled) {
    console.log('[cli] Auto-starting health monitor...');
    node.startMonitor();
  }

  // Post-deploy health check: detect restart-reason file and verify system health
  const restartReason = readRestartReason(dataDir);
  if (restartReason) {
    console.log(`[cli] Restart detected — reason: ${restartReason.reason} (at ${new Date(restartReason.timestamp).toISOString()})`);
    console.log('[cli] Waiting 5s for services to stabilize before health check...');

    // Wait 5 seconds for services to fully initialize
    await new Promise(resolve => setTimeout(resolve, 5000));

    const qaRunner = new QaRunner({ baseUrl: `http://localhost:${apiPort}` });
    try {
      const healthResult = await qaRunner.runHealthCheck();

      if (healthResult.success) {
        console.log(`[cli] Health check PASSED (${healthResult.durationMs}ms) — all gateway pages, API endpoints, and scheduler OK`);
        clearRestartReason(dataDir);
      } else {
        // Log details of what failed
        const failedGateway = healthResult.gatewayPages.filter(p => p.status !== 'passed');
        const failedApi = healthResult.apiEndpoints.filter(p => p.status !== 'passed');

        console.error(`[cli] Health check FAILED after ${restartReason.reason} restart:`);
        if (failedGateway.length > 0) {
          console.error(`[cli]   Failed gateway pages: ${failedGateway.map(p => `${p.url} (${p.status})`).join(', ')}`);
        }
        if (failedApi.length > 0) {
          console.error(`[cli]   Failed API endpoints: ${failedApi.map(p => `${p.url} (${p.status})`).join(', ')}`);
        }
        if (!healthResult.schedulerRunning) {
          console.error('[cli]   Scheduler is NOT running');
        }

        // Trigger rollback: restore dist.backup/ and restart
        console.error('[cli] Triggering rollback — restoring dist.backup/ ...');
        const repoDir = process.cwd();
        const packages = ['shared', 'ledger', 'node', 'gateway', 'mcp-server'];
        let restored = 0;

        for (const pkg of packages) {
          const distDir = join(repoDir, 'packages', pkg, 'dist');
          const backupDir = join(repoDir, 'packages', pkg, 'dist.backup');
          if (existsSync(backupDir)) {
            try {
              if (existsSync(distDir)) {
                rmSync(distDir, { recursive: true, force: true });
              }
              cpSync(backupDir, distDir, { recursive: true });
              restored++;
            } catch (err: any) {
              console.error(`[cli] Failed to restore ${pkg}/dist: ${err.message}`);
            }
          }
        }

        if (restored > 0) {
          console.log(`[cli] Restored ${restored} dist/ directories from backup. Restarting...`);
          clearRestartReason(dataDir);
          process.exit(RESTART_EXIT_CODE);
        } else {
          console.error('[cli] No dist.backup/ found. Cannot rollback. Continuing with current code.');
          clearRestartReason(dataDir);
        }
      }
    } catch (err: any) {
      console.error(`[cli] Health check error: ${err.message}. Continuing without rollback.`);
      clearRestartReason(dataDir);
    }
  }

  // Phase 15.5: Mark node as stable after 30s of successful uptime
  setTimeout(() => {
    markStable(dataDir);
  }, getStabilityDelay());

  // Heartbeat + status report every 30 seconds
  const heartbeatDir = dataDir || join(homedir(), '.pando');
  const heartbeatPath = join(heartbeatDir, 'heartbeat.json');
  // Ensure data directory exists for heartbeat file
  try { mkdirSync(heartbeatDir, { recursive: true }); } catch {}

  setInterval(() => {
    // Write heartbeat timestamp for external process supervisor
    try {
      writeFileSync(heartbeatPath, JSON.stringify({
        timestamp: Date.now(),
        uptime: Math.floor(process.uptime()),
        pid: process.pid,
      }));
    } catch {}

    const network = node.getNetwork();
    const ledger = node.getLedger();
    const identity = node.getIdentity();
    if (network && ledger && identity) {
      const peerCount = network.getPeerCount();
      const balance = ledger.accounts.getBalance(identity.peerId);
      const stats = ledger.getNetworkStats();
      console.log(`[status] peers: ${peerCount} | balance: ${balance} Lux | supply: ${stats.totalSupply} Lux | uptime: ${Math.floor(process.uptime())}s`);
    }
  }, 30_000);

  // If --ping flag, send a ping to all peers every 10 seconds
  if (args.includes('--ping')) {
    setInterval(async () => {
      const network = node.getNetwork();
      const identity = node.getIdentity();
      if (network && identity && network.getPeerCount() > 0) {
        console.log('Sending ping to all peers...');
        await network.broadcast({
          type: MessageType.PING,
          from: identity.peerId,
          timestamp: Date.now(),
          payload: { message: 'ping from Pando node' },
        });
      }
    }, 10_000);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
