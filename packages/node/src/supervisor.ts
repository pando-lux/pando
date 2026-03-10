/**
 * Pando Supervisor
 *
 * Standalone entry point — manages both pando-node and pando-teams as child processes.
 * Handles restart-on-exit(75), crash backoff, and system tray with dynamic service discovery.
 * Zero imports from Pando internals — fully decoupled.
 *
 * Usage:
 *   node supervisor.js [--teams-path <path>] [--api-port <port>]
 *
 * --teams-path: Path to pando-teams repo (default: auto-detect ../teams or ../code relative to node repo)
 */

import { spawn, ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';

const RESTART_EXIT_CODE = 75;
const RESTART_DELAY_MS  = 2_000;
const CRASH_WINDOW_MS   = 5 * 60 * 1_000;
const MAX_CRASHES       = 5;
const POLL_INTERVAL_MS  = 10_000;
const TEAMS_PORT        = 4873;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ts = () => new Date().toISOString();

/**
 * Kill a child process and its entire process tree.
 * On Windows, shell:true spawns cmd.exe wrappers — SIGINT only kills the shell,
 * not grandchild processes. taskkill /F /T kills the entire tree.
 */
function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, {
        stdio: 'pipe', windowsHide: true, timeout: 10_000,
      });
      return;
    } catch { /* process may already be dead — fall through */ }
  }

  // Unix: kill process group if possible, else direct signal
  try {
    process.kill(-proc.pid, 'SIGINT');
  } catch {
    try { proc.kill('SIGINT'); } catch { /* already dead */ }
  }
}

// Resolve API port from CLI args or env, matching cli.ts logic
function resolveApiPort(): number {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--api-port');
  if (idx !== -1 && args[idx + 1]) {
    const p = parseInt(args[idx + 1], 10);
    if (p > 0 && p < 65536) return p;
  }
  if (process.env.PANDO_API_PORT) {
    const p = parseInt(process.env.PANDO_API_PORT, 10);
    if (p > 0 && p < 65536) return p;
  }
  return 4000;
}

// Read API token from ~/.pando/api-token
function readTokenFile(): string {
  try {
    return readFileSync(join(homedir(), '.pando', 'api-token'), 'utf-8').trim();
  } catch { return ''; }
}

// Resolve pando-teams path from CLI args or auto-detect
function resolveTeamsPath(): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--teams-path');
  if (idx !== -1 && args[idx + 1]) {
    const p = resolve(args[idx + 1]);
    if (existsSync(join(p, 'packages', 'server', 'src', 'index.ts'))) return p;
    console.warn(`[supervisor] --teams-path "${p}" does not contain packages/server/src/index.ts`);
  }
  if (process.env.PANDO_TEAMS_PATH) {
    const p = resolve(process.env.PANDO_TEAMS_PATH);
    if (existsSync(join(p, 'packages', 'server', 'src', 'index.ts'))) return p;
  }
  // Auto-detect: ../teams (or legacy ../code) relative to the node repo
  // __dirname = <repo>/packages/node/dist  →  <repo>/../teams
  const nodeRepo = resolve(__dirname, '..', '..', '..');
  for (const dir of ['teams', 'code']) {
    const autoPath = join(nodeRepo, '..', dir);
    if (existsSync(join(autoPath, 'packages', 'server', 'src', 'index.ts'))) return autoPath;
  }
  return null;
}

const API_PORT = resolveApiPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const TEAMS_PATH = resolveTeamsPath();

// ─── Core Supervisor ──────────────────────────────────────────────────────

let child: ChildProcess | null = null;
let teamsChild: ChildProcess | null = null;
let stopping = false;
let userStopped = false;          // user clicked "Stop Node"
let teamsUserStopped = false;     // user clicked "Stop Teams"
const crashTimes: number[] = [];
const teamsCrashTimes: number[] = [];

function spawnNode(): ChildProcess {
  const cliPath = join(__dirname, 'cli.js');
  const args = [cliPath, '--supervised', ...process.argv.slice(2).filter(a => a !== '--teams-path' && !a.startsWith('--teams-path='))];
  // Filter out --teams-path and its value
  const filtered: string[] = [];
  const rawArgs = process.argv.slice(2);
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--teams-path') { i++; continue; }
    if (rawArgs[i].startsWith('--teams-path=')) continue;
    filtered.push(rawArgs[i]);
  }
  const finalArgs = [cliPath, '--supervised', ...filtered];
  console.log(`[supervisor ${ts()}] Spawning Node`);
  const proc = spawn(process.execPath, finalArgs, { stdio: 'inherit', windowsHide: true });
  proc.on('exit', onChildExit);
  return proc;
}

function resolveTsxCli(teamsPath: string): string | null {
  // Try to find tsx CLI entry point directly — avoids shell:true on Windows
  const candidates = [
    join(teamsPath, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(teamsPath, 'node_modules', 'tsx', 'dist', 'cli.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function spawnTeams(): ChildProcess | null {
  if (!TEAMS_PATH) {
    console.warn(`[supervisor ${ts()}] Cannot start Teams — path not found. Use --teams-path or set PANDO_TEAMS_PATH`);
    return null;
  }
  const serverEntry = join(TEAMS_PATH, 'packages', 'server', 'src', 'index.ts');
  console.log(`[supervisor ${ts()}] Spawning Teams (port ${TEAMS_PORT})`);
  const apiPort = resolveApiPort();
  const teamsEnv = {
    ...process.env,
    PANDO_NODE_URL: process.env.PANDO_NODE_URL || `http://127.0.0.1:${apiPort}`,
    PANDO_NODE_PATH: process.env.PANDO_NODE_PATH || resolve(__dirname, '..', '..', '..'),
    PANDO_API_TOKEN: process.env.PANDO_API_TOKEN || readTokenFile(),
  };

  // Prefer direct tsx CLI resolution (no shell wrapper = no orphan problem)
  const tsxCli = resolveTsxCli(TEAMS_PATH);
  let proc: ChildProcess;
  if (tsxCli) {
    console.log(`[supervisor ${ts()}] Using direct tsx CLI: ${tsxCli}`);
    proc = spawn(process.execPath, [tsxCli, serverEntry, '--port', String(TEAMS_PORT)], {
      cwd: TEAMS_PATH,
      stdio: 'inherit',
      windowsHide: true,
      env: teamsEnv,
    });
  } else {
    // Fallback: npx tsx — needs shell on Windows, but killProcessTree handles cleanup
    console.warn(`[supervisor ${ts()}] tsx CLI not found, falling back to npx tsx (shell:true)`);
    proc = spawn('npx', ['tsx', serverEntry, '--port', String(TEAMS_PORT)], {
      cwd: TEAMS_PATH,
      stdio: 'inherit',
      windowsHide: true,
      shell: true,
      env: teamsEnv,
    });
  }
  proc.on('exit', onTeamsExit);

  // Write .build-commit so the unified watchdog can detect future code changes
  try {
    const head = execSync('git rev-parse HEAD', {
      cwd: TEAMS_PATH, timeout: 10_000, encoding: 'utf8', windowsHide: true,
    }).trim();
    if (head) writeFileSync(join(TEAMS_PATH, '.build-commit'), head + '\n');
  } catch { /* non-fatal — watchdog just won't track this app */ }

  return proc;
}

function onChildExit(code: number | null, signal: string | null): void {
  child = null;
  lastState = { ...lastState, online: false, peers: 0, lux: 0, services: [] };

  if (stopping) return;

  if (code === 78) {
    console.log(`[supervisor ${ts()}] Port conflict (exit 78). Stopping supervisor — kill existing process and retry.`);
    process.exit(78);
  }

  if (userStopped || code === 0) {
    console.log(`[supervisor ${ts()}] Node stopped${userStopped ? ' by user' : ' (exit 0)'}.`);
    userStopped = false;
    refreshTray();
    return;
  }

  if (code === RESTART_EXIT_CODE) {
    console.log(`[supervisor ${ts()}] Node restart requested (exit 75). Respawning in ${RESTART_DELAY_MS}ms…`);
    refreshTray();
    setTimeout(() => { child = spawnNode(); refreshTray(); }, RESTART_DELAY_MS);
    return;
  }

  const now = Date.now();
  crashTimes.push(now);
  const recent = crashTimes.filter(t => now - t < CRASH_WINDOW_MS);
  crashTimes.length = 0;
  crashTimes.push(...recent);
  console.warn(`[supervisor ${ts()}] Node crash (code=${code ?? signal}). Recent: ${recent.length}/${MAX_CRASHES}`);
  if (recent.length >= MAX_CRASHES) {
    console.error(`[supervisor ${ts()}] Node crash limit reached.`);
    refreshTray();
    return; // Don't exit supervisor — Teams may still be running
  }
  refreshTray();
  setTimeout(() => { child = spawnNode(); refreshTray(); }, RESTART_DELAY_MS);
}

function onTeamsExit(code: number | null, signal: string | null): void {
  teamsChild = null;
  teamsOnline = false;

  if (stopping) return;

  if (teamsUserStopped || code === 0) {
    console.log(`[supervisor ${ts()}] Teams stopped${teamsUserStopped ? ' by user' : ' (exit 0)'}.`);
    teamsUserStopped = false;
    refreshTray();
    return;
  }

  const now = Date.now();
  teamsCrashTimes.push(now);
  const recent = teamsCrashTimes.filter(t => now - t < CRASH_WINDOW_MS);
  teamsCrashTimes.length = 0;
  teamsCrashTimes.push(...recent);
  console.warn(`[supervisor ${ts()}] Teams crash (code=${code ?? signal}). Recent: ${recent.length}/${MAX_CRASHES}`);
  if (recent.length >= MAX_CRASHES) {
    console.error(`[supervisor ${ts()}] Teams crash limit reached.`);
    refreshTray();
    return;
  }
  refreshTray();
  setTimeout(() => { teamsChild = spawnTeams(); refreshTray(); }, RESTART_DELAY_MS);
}

function gracefulShutdown(signal: string): void {
  stopping = true;
  console.log(`[supervisor ${ts()}] ${signal} received — shutting down.`);
  if (child) killProcessTree(child);
  if (teamsChild) killProcessTree(teamsChild);
  setTimeout(() => process.exit(0), 3_000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ─── HTTP helpers ─────────────────────────────────────────────────────────

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(5_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── State ────────────────────────────────────────────────────────────────

interface ServiceInfo {
  id: string;
  version: string;
  healthy: boolean;
  uiUrl?: string;
}

interface NodeState {
  online: boolean;
  peers: number;
  lux: number;
  services: ServiceInfo[];
  localHubPort: number | null;
}

let lastState: NodeState = { online: false, peers: 0, lux: 0, services: [], localHubPort: null };
let teamsOnline = false;

function detectLocalHub(): number | null {
  for (const filename of ['hub.json', 'gateway.json']) {
    try {
      const file = join(homedir(), '.pando', filename);
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      if (typeof data.port === 'number' && data.port > 0) return data.port;
    } catch { /* file doesn't exist or invalid */ }
  }
  return null;
}

async function pollState(): Promise<void> {
  // Poll Node
  try {
    const [statusRaw, servicesRaw] = await Promise.all([
      httpGet(`${API_BASE}/v1/status`),
      httpGet(`${API_BASE}/v1/services`).catch(() => '{}'),
    ]);
    const status = JSON.parse(statusRaw);
    const svcData = JSON.parse(servicesRaw);
    const gwPort = detectLocalHub();

    lastState = {
      online: true,
      peers: status.peers ?? 0,
      lux: Math.floor(status.balance ?? 0),
      services: Array.isArray(svcData.services) ? svcData.services : [],
      localHubPort: gwPort,
    };
  } catch {
    lastState = { ...lastState, online: false, peers: 0, lux: 0, services: [], localHubPort: null };
  }

  // Poll Teams (simple health check)
  if (teamsChild) {
    try {
      await httpGet(`http://127.0.0.1:${TEAMS_PORT}/`);
      teamsOnline = true;
    } catch {
      teamsOnline = false;
    }
  } else {
    teamsOnline = false;
  }

  refreshTray();
}

// ─── Open URL ─────────────────────────────────────────────────────────────

function openUrl(url: string): void {
  try {
    const cmd = process.platform === 'win32'  ? `start "" "${url}"` :
                process.platform === 'darwin' ? `open "${url}"` :
                                                `xdg-open "${url}"`;
    execSync(cmd, { stdio: 'ignore', windowsHide: true });
  } catch { /* ignore */ }
}

// ─── System Tray ──────────────────────────────────────────────────────────

const ICON_ICO_B64 =
  'AAABAAEAEBAAAAAAIADmAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAQAAAAEAgGAAAAH/P/YQAAAK1J' +
  'REFUeJxjlJNT+c9AAWCiRDNVDGBBF5AR+c1wtPchnP/nLyPDqw/MDF1rhBnWH+Ml3gUrD/IxKCSo' +
  'MJjlKzC8eM/C0Jf2kkFB/DfxBoDA//8MDG8/MzOsOMTHwMTIwGCp+Z2BrDDgYP1PfBggA0ZGBgYx' +
  '/j8MkfafwGFx+AonA9EGhNt/AuNffxgZ7r9gZciYLMHw5A0r8QasPMjHUDZPjGHwJyTGoZ8XKDYg' +
  'OhyIzgQAABUVLxVoLCCFAAAAAElFTkSuQmCC';

function getIconPath(): string {
  const icoPath = join(tmpdir(), 'pando-tray.ico');
  try { writeFileSync(icoPath, Buffer.from(ICON_ICO_B64, 'base64')); } catch { /* ignore */ }
  return icoPath;
}

const ICON_PATH = getIconPath();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tray: any = null;

// Menu item indices — fixed layout
const IDX = {
  NODE_STATUS:    0,
  TEAMS_STATUS:   1,
  SEP1:           2,
  SERVICE_SLOT:   3,
  SEP2:           4,
  HUB_LOCAL:      5,
  HUB_WEB:        6,
  OPEN_TEAMS:     7,
  SEP3:           8,
  RESTART_NODE:   9,
  STOP_NODE:      10,
  START_NODE:     11,
  RESTART_TEAMS:  12,
  STOP_TEAMS:     13,
  START_TEAMS:    14,
  SEP4:           15,
  QUIT:           16,
};

function makeItem(title: string, opts?: { enabled?: boolean; hidden?: boolean; tooltip?: string }) {
  return { title, tooltip: opts?.tooltip ?? '', checked: false, enabled: opts?.enabled ?? false, hidden: opts?.hidden ?? false };
}

function buildInitialMenu() {
  const hasTeams = TEAMS_PATH !== null;
  return [
    /*  0 NODE_STATUS    */  makeItem('Node: Starting\u2026'),
    /*  1 TEAMS_STATUS   */  makeItem(hasTeams ? 'Teams: Starting\u2026' : 'Teams: Not configured', { hidden: !hasTeams }),
    /*  2 SEP1           */  makeItem(''),
    /*  3 SERVICE        */  makeItem('', { hidden: true }),
    /*  4 SEP2           */  makeItem('', { hidden: true }),
    /*  5 HUB_LOCAL      */  makeItem('Hub (local)', { enabled: true, hidden: true }),
    /*  6 HUB_WEB        */  makeItem('Hub (web)', { enabled: true, hidden: true }),
    /*  7 OPEN_TEAMS     */  makeItem(`Open Teams (localhost:${TEAMS_PORT})`, { enabled: true, hidden: !hasTeams }),
    /*  8 SEP3           */  makeItem(''),
    /*  9 RESTART_NODE   */  makeItem('Restart Node', { enabled: true, hidden: true }),
    /* 10 STOP_NODE      */  makeItem('Stop Node', { enabled: true, hidden: true }),
    /* 11 START_NODE     */  makeItem('Start Node', { enabled: true, hidden: true }),
    /* 12 RESTART_TEAMS  */  makeItem('Restart Teams', { enabled: true, hidden: true }),
    /* 13 STOP_TEAMS     */  makeItem('Stop Teams', { enabled: true, hidden: true }),
    /* 14 START_TEAMS    */  makeItem('Start Teams', { enabled: true, hidden: true }),
    /* 15 SEP4           */  makeItem(''),
    /* 16 QUIT           */  makeItem('Quit', { enabled: true }),
  ];
}

function refreshTray(): void {
  if (!tray) return;

  const nodeRunning = child !== null;
  const nodeReady = lastState.online;
  const teamsRunning = teamsChild !== null;
  const hasTeams = TEAMS_PATH !== null;

  // Node status text
  let nodeStatusText: string;
  if (!nodeRunning) {
    nodeStatusText = 'Node: Stopped';
  } else if (!nodeReady) {
    nodeStatusText = 'Node: Starting\u2026';
  } else {
    nodeStatusText = `Node: ${lastState.peers} peer${lastState.peers !== 1 ? 's' : ''} | ${lastState.lux} Lux`;
  }

  // Teams status text
  let teamsStatusText: string;
  if (!hasTeams) {
    teamsStatusText = 'Teams: Not configured';
  } else if (!teamsRunning) {
    teamsStatusText = 'Teams: Stopped';
  } else if (!teamsOnline) {
    teamsStatusText = 'Teams: Starting\u2026';
  } else {
    teamsStatusText = `Teams: Online (port ${TEAMS_PORT})`;
  }

  // Service line (from node's /v1/services)
  const svc = lastState.services[0];
  const hasSvc = nodeReady && !!svc;
  let svcText = '';
  if (hasSvc) {
    const dot = svc.healthy ? '\u25CF' : '\u25CB';
    const label = svc.id.replace(/^pando-/, '').replace(/^\w/, c => c.toUpperCase());
    svcText = `${dot} ${label} v${svc.version}`;
  }

  const hasLocalHub = nodeReady && lastState.localHubPort !== null;

  try {
    updateItem(IDX.NODE_STATUS,     nodeStatusText, { enabled: false });
    updateItem(IDX.TEAMS_STATUS,    teamsStatusText, { enabled: false, hidden: !hasTeams });
    updateItem(IDX.SERVICE_SLOT,    svcText,    { enabled: hasSvc && !!svc?.uiUrl, hidden: !hasSvc });
    updateItem(IDX.SEP2,            '',         { hidden: !hasSvc && !hasLocalHub && !nodeReady });
    updateItem(IDX.HUB_LOCAL, `Hub (localhost:${lastState.localHubPort})`, { enabled: true, hidden: !hasLocalHub });
    updateItem(IDX.HUB_WEB,   'Hub (web)', { enabled: true, hidden: !nodeReady });
    updateItem(IDX.OPEN_TEAMS, `Open Teams (localhost:${TEAMS_PORT})`, { enabled: teamsOnline, hidden: !hasTeams });
    updateItem(IDX.RESTART_NODE,    'Restart Node', { enabled: true, hidden: !nodeRunning });
    updateItem(IDX.STOP_NODE,       'Stop Node',    { enabled: true, hidden: !nodeRunning });
    updateItem(IDX.START_NODE,      'Start Node',   { enabled: true, hidden: nodeRunning });
    updateItem(IDX.RESTART_TEAMS,   'Restart Teams', { enabled: true, hidden: !teamsRunning || !hasTeams });
    updateItem(IDX.STOP_TEAMS,      'Stop Teams',    { enabled: true, hidden: !teamsRunning || !hasTeams });
    updateItem(IDX.START_TEAMS,     'Start Teams',   { enabled: true, hidden: teamsRunning || !hasTeams });
  } catch { /* ignore */ }
}

function updateItem(seqId: number, title: string, opts?: { enabled?: boolean; hidden?: boolean }): void {
  if (!tray) return;
  tray.sendAction({
    type: 'update-item',
    item: {
      title,
      tooltip: '',
      checked: false,
      enabled: opts?.enabled ?? false,
      hidden: opts?.hidden ?? false,
    },
    seq_id: seqId,
  });
}

async function initTray(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SysTray: any;
  try {
    // @ts-ignore
    const mod = await import('systray2');
    SysTray = mod.default?.default || mod.default || mod;
  } catch {
    console.log('[supervisor] Running in headless mode (systray2 unavailable or unsupported)');
    return;
  }

  const items = buildInitialMenu();

  try {
    tray = new SysTray({
      menu: { icon: ICON_PATH, title: '', tooltip: 'Pando', items },
      debug: false,
      copyDir: true,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[supervisor] Running in headless mode (${msg})`);
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tray.onClick((action: any) => {
    try {
      const seq: number = action?.seq_id ?? -1;

      if (seq === IDX.SERVICE_SLOT) {
        const svc = lastState.services[0];
        if (svc?.uiUrl) openUrl(svc.uiUrl);
      }
      else if (seq === IDX.HUB_LOCAL) {
        if (lastState.localHubPort) openUrl(`http://localhost:${lastState.localHubPort}`);
      }
      else if (seq === IDX.HUB_WEB) {
        openUrl('https://gateway-one-mu.vercel.app');
      }
      else if (seq === IDX.OPEN_TEAMS) {
        openUrl(`http://localhost:${TEAMS_PORT}`);
      }
      // Node controls
      else if (seq === IDX.START_NODE) {
        if (!child) { child = spawnNode(); refreshTray(); }
      }
      else if (seq === IDX.RESTART_NODE) {
        if (child) killProcessTree(child);
      }
      else if (seq === IDX.STOP_NODE) {
        userStopped = true;
        if (child) killProcessTree(child);
      }
      // Teams controls
      else if (seq === IDX.START_TEAMS) {
        if (!teamsChild) { teamsChild = spawnTeams(); refreshTray(); }
      }
      else if (seq === IDX.RESTART_TEAMS) {
        if (teamsChild) killProcessTree(teamsChild);
      }
      else if (seq === IDX.STOP_TEAMS) {
        teamsUserStopped = true;
        if (teamsChild) killProcessTree(teamsChild);
      }
      else if (seq === IDX.QUIT) {
        stopping = true;
        if (child) killProcessTree(child);
        if (teamsChild) killProcessTree(teamsChild);
        setTimeout(() => process.exit(0), 3_000);
      }
    } catch { /* ignore */ }
  });

  console.log('[supervisor] System tray initialized.');
}

// ─── App Registry & Unified Watchdog (BIBLE 1.9.2) ───────────────────────

interface AppEntry {
  name: string;
  repoPath: string;
  buildDir: string;              // where .build-commit lives
  watchDirs: string[];           // only restart if changes touch these dirs
  mode: 'governed' | 'direct';  // governed = verify proposal exists before restart
  getChild: () => ChildProcess | null;
  killChild: () => void;
}

const WATCHDOG_INTERVAL_MS = 60_000;
const NODE_REPO = resolve(__dirname, '..', '..', '..');

function buildAppRegistry(): AppEntry[] {
  const apps: AppEntry[] = [
    {
      name: 'node',
      repoPath: NODE_REPO,
      buildDir: join(NODE_REPO, 'packages', 'node', 'dist'),
      watchDirs: ['packages/node/', 'packages/shared/', 'packages/mcp-server/'],
      mode: 'governed',
      getChild: () => child,
      killChild: () => { if (child) killProcessTree(child); },
    },
  ];

  if (TEAMS_PATH) {
    apps.push({
      name: 'teams',
      repoPath: TEAMS_PATH,
      buildDir: TEAMS_PATH,  // teams uses tsx — no dist, just detect git changes
      watchDirs: ['packages/server/', 'packages/core/'],
      mode: 'governed',
      getChild: () => teamsChild,
      killChild: () => { if (teamsChild) killProcessTree(teamsChild); },
    });
  }

  return apps;
}

function readBuildCommit(buildDir: string): string | null {
  const paths = [
    join(buildDir, '.build-commit'),
    join(buildDir, '..', '..', '..', 'dist', '.build-commit'),  // fallback for monorepo root
  ];
  for (const p of paths) {
    try {
      const val = readFileSync(p, 'utf8').trim();
      if (val) return val;
    } catch { /* try next */ }
  }
  return null;
}

function getGitHead(repoPath: string): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: repoPath, timeout: 10_000, encoding: 'utf8', windowsHide: true,
    }).trim();
  } catch { return null; }
}

function getChangedFiles(repoPath: string, fromCommit: string, toCommit: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${fromCommit}..${toCommit}`, {
      cwd: repoPath, timeout: 10_000, encoding: 'utf8', windowsHide: true,
    }).trim();
    return output ? output.split('\n') : [];
  } catch { return []; }
}

// Track per-app staleness so we don't spam logs
const staleSince: Record<string, number | null> = {};

function watchdogCheck(): void {
  const apps = buildAppRegistry();

  for (const app of apps) {
    try {
      const proc = app.getChild();
      if (!proc) continue;  // app not running — nothing to restart

      const builtCommit = readBuildCommit(app.buildDir);
      const headCommit = getGitHead(app.repoPath);
      if (!builtCommit || !headCommit) continue;

      if (builtCommit === headCommit) {
        staleSince[app.name] = null;
        continue;  // build is fresh
      }

      // Check if changes actually touch watched dirs
      const changed = getChangedFiles(app.repoPath, builtCommit, headCommit);
      const hasRelevant = changed.some(f => app.watchDirs.some(d => f.startsWith(d)));
      if (!hasRelevant) {
        staleSince[app.name] = null;
        continue;  // only data/docs changed — no restart needed
      }

      // Stale build detected
      if (!staleSince[app.name]) staleSince[app.name] = Date.now();
      const staleMs = Date.now() - (staleSince[app.name] ?? Date.now());

      // For 'node': rebuild first then kill (supervisor auto-respawns)
      if (app.name === 'node') {
        console.log(`[watchdog] ${app.name}: stale build (built=${builtCommit.slice(0, 8)}, head=${headCommit.slice(0, 8)}, stale ${Math.round(staleMs / 1000)}s) — rebuilding and restarting`);
        try {
          execSync('npm run build', {
            cwd: app.repoPath, timeout: 180_000, stdio: 'pipe', windowsHide: true,
          });
          console.log(`[watchdog] ${app.name}: rebuild complete — killing child for respawn`);
        } catch (err: unknown) {
          console.warn(`[watchdog] ${app.name}: rebuild failed — restarting anyway: ${(err as Error).message?.slice(0, 200)}`);
        }
      } else {
        // Teams: no build step, just restart
        console.log(`[watchdog] ${app.name}: code changed (built=${builtCommit.slice(0, 8)}, head=${headCommit.slice(0, 8)}) — restarting`);
      }

      staleSince[app.name] = null;
      app.killChild();  // supervisor onChildExit / onTeamsExit will auto-respawn
    } catch (err: unknown) {
      console.warn(`[watchdog] ${app.name}: check failed — ${(err as Error).message?.slice(0, 100)}`);
    }
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────

process.on('uncaughtException', (err: Error) => {
  if (err.message?.includes('systray') || err.message?.includes('tray_linux') || err.message?.includes('EACCES')) {
    console.log(`[supervisor] Ignoring tray error on headless system: ${err.message}`);
    return;
  }
  console.error(`[supervisor] Uncaught exception: ${err.message}`);
  process.exit(1);
});

// Poll state — first poll after 5s, then every 10s
setTimeout(() => { pollState().catch(() => {}); }, 5_000);
const pollTimer = setInterval(() => { pollState().catch(() => {}); }, POLL_INTERVAL_MS);
pollTimer.unref();

// Skip tray on headless systems
const isHeadless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
if (!isHeadless) {
  initTray().catch((e: unknown) => {
    console.log(`[supervisor] Tray init failed: ${e instanceof Error ? e.message : String(e)}`);
  });
} else {
  console.log('[supervisor] Headless system detected — skipping system tray.');
}

// Spawn both processes
child = spawnNode();
if (TEAMS_PATH) {
  teamsChild = spawnTeams();
  console.log(`[supervisor] Teams path: ${TEAMS_PATH}`);
} else {
  console.log('[supervisor] Teams not found — running Node only. Use --teams-path to enable.');
}

// Unified watchdog — checks all registered apps every 60s
console.log(`[supervisor] Unified watchdog active (interval ${WATCHDOG_INTERVAL_MS / 1000}s)`);
const watchdogTimer = setInterval(watchdogCheck, WATCHDOG_INTERVAL_MS);
watchdogTimer.unref();
