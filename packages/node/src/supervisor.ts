/**
 * Pando Node Supervisor
 *
 * Standalone entry point — spawns dist/cli.js as a managed child process.
 * Handles restart-on-exit(75), crash backoff, and system tray with dynamic service discovery.
 * Zero imports from Pando internals — fully decoupled.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';

const RESTART_EXIT_CODE = 75;
const RESTART_DELAY_MS  = 2_000;
const CRASH_WINDOW_MS   = 5 * 60 * 1_000;
const MAX_CRASHES       = 5;
const POLL_INTERVAL_MS  = 10_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ts = () => new Date().toISOString();

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

const API_PORT = resolveApiPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;

// ─── Core Supervisor ──────────────────────────────────────────────────────

let child: ChildProcess | null = null;
let stopping = false;     // true = supervisor is exiting (SIGINT)
let userStopped = false;  // true = user clicked "Stop Node" — don't respawn
const crashTimes: number[] = [];

function spawnNode(): ChildProcess {
  const cliPath = join(__dirname, 'cli.js');
  const args = [cliPath, '--supervised', ...process.argv.slice(2)];
  console.log(`[supervisor ${ts()}] Spawning: node ${args.join(' ')}`);
  const proc = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  proc.on('exit', onChildExit);
  return proc;
}

function onChildExit(code: number | null, signal: string | null): void {
  child = null;
  lastState = { online: false, peers: 0, lux: 0, services: [], localHubPort: null };

  if (stopping) return;

  if (code === 78) {
    console.log(`[supervisor ${ts()}] Port conflict (exit 78). Stopping supervisor — kill existing process and retry.`);
    process.exit(78);
  }

  // User clicked "Stop Node" or node exited cleanly — stay alive with tray, show "Start Node"
  if (userStopped || code === 0) {
    console.log(`[supervisor ${ts()}] Node stopped${userStopped ? ' by user' : ' (exit 0)'}. Supervisor stays alive — use tray to restart.`);
    userStopped = false;
    refreshTray();
    return;
  }

  if (code === RESTART_EXIT_CODE) {
    console.log(`[supervisor ${ts()}] Restart requested (exit 75). Respawning in ${RESTART_DELAY_MS}ms…`);
    refreshTray();
    setTimeout(() => { child = spawnNode(); refreshTray(); }, RESTART_DELAY_MS);
    return;
  }

  // Crash — apply backoff
  const now = Date.now();
  crashTimes.push(now);
  const recent = crashTimes.filter(t => now - t < CRASH_WINDOW_MS);
  crashTimes.length = 0;
  crashTimes.push(...recent);
  console.log(`[supervisor ${ts()}] Crash (code=${code ?? signal}). Recent crashes: ${recent.length}/${MAX_CRASHES}`);
  if (recent.length >= MAX_CRASHES) {
    console.error(`[supervisor ${ts()}] Crash limit reached — stopping supervisor.`);
    process.exit(1);
  }
  refreshTray();
  setTimeout(() => { child = spawnNode(); refreshTray(); }, RESTART_DELAY_MS);
}

process.on('SIGINT', () => {
  stopping = true;
  console.log(`[supervisor ${ts()}] SIGINT received — shutting down.`);
  if (child) child.kill('SIGINT');
  setTimeout(() => process.exit(0), 3_000);
});

// ─── HTTP helpers ─────────────────────────────────────────────────────────

function httpGet(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${API_BASE}${path}`, (res) => {
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
  localHubPort: number | null;  // detected local hub port, null if not running
}

let lastState: NodeState = { online: false, peers: 0, lux: 0, services: [], localHubPort: null };

// Detect local hub by reading ~/.pando/hub.json (written by hub on startup)
// Format: { "port": 3002 }
// Falls back to legacy ~/.pando/gateway.json
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
  try {
    const [statusRaw, servicesRaw] = await Promise.all([
      httpGet('/v1/status'),
      httpGet('/v1/services').catch(() => '{}'),
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

// 16x16 amber "P" on dark background — PNG-in-ICO (works on Windows 10/11).
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

// Menu item indices — fixed layout, items are shown/hidden dynamically
const IDX = {
  STATUS:        0,
  SEP1:          1,
  SERVICE_SLOT:  2,
  SEP2:          3,
  HUB_LOCAL: 4,
  HUB_WEB:   5,
  SEP3:          6,
  RESTART:       7,
  STOP:          8,
  START:         9,
  QUIT:          10,
};

function makeItem(title: string, opts?: { enabled?: boolean; hidden?: boolean; tooltip?: string }) {
  return { title, tooltip: opts?.tooltip ?? '', checked: false, enabled: opts?.enabled ?? false, hidden: opts?.hidden ?? false };
}

function buildInitialMenu() {
  return [
    /*  0 STATUS        */  makeItem('Starting\u2026'),
    /*  1 SEP1          */  makeItem(''),
    /*  2 SERVICE       */  makeItem('', { hidden: true }),
    /*  3 SEP2          */  makeItem('', { hidden: true }),
    /*  4 HUB_LOCAL */  makeItem('Hub (local)', { enabled: true, hidden: true }),
    /*  5 HUB_WEB   */  makeItem('Hub (web)', { enabled: true, hidden: true }),
    /*  6 SEP3          */  makeItem(''),
    /*  7 RESTART       */  makeItem('Restart Node', { enabled: true, hidden: true }),
    /*  8 STOP          */  makeItem('Stop Node', { enabled: true, hidden: true }),
    /*  9 START         */  makeItem('Start Node', { enabled: true, hidden: true }),
    /* 10 QUIT          */  makeItem('Quit', { enabled: true }),
  ];
}

function refreshTray(): void {
  if (!tray) return;

  const nodeRunning = child !== null;
  const nodeReady = lastState.online;

  // Status text
  let statusText: string;
  if (!nodeRunning) {
    statusText = 'Stopped';
  } else if (!nodeReady) {
    statusText = 'Starting\u2026';
  } else {
    statusText = `Online | ${lastState.peers} peer${lastState.peers !== 1 ? 's' : ''} | ${lastState.lux} Lux`;
  }

  // Service line
  const svc = lastState.services[0]; // primary service (pando-teams)
  const hasSvc = nodeReady && !!svc;
  let svcText = '';
  if (hasSvc) {
    const dot = svc.healthy ? '\u25CF' : '\u25CB';
    const label = svc.id.replace(/^pando-/, '').replace(/^\w/, c => c.toUpperCase());
    svcText = `${dot} ${label} v${svc.version}`;
  }

  const hasLocalHub = nodeReady && lastState.localHubPort !== null;
  const showHub = nodeReady && (hasLocalHub || true); // always show web hub when online

  try {
    updateItem(IDX.STATUS,        statusText, { enabled: false });
    updateItem(IDX.SERVICE_SLOT,  svcText,    { enabled: hasSvc && !!svc?.uiUrl, hidden: !hasSvc });
    updateItem(IDX.SEP2,          '',         { hidden: !hasSvc && !showHub });
    updateItem(IDX.HUB_LOCAL, `Hub (localhost:${lastState.localHubPort})`, { enabled: true, hidden: !hasLocalHub });
    updateItem(IDX.HUB_WEB,   'Hub (web)', { enabled: true, hidden: !nodeReady });
    updateItem(IDX.RESTART,       'Restart Node', { enabled: true, hidden: !nodeRunning });
    updateItem(IDX.STOP,          'Stop Node',    { enabled: true, hidden: !nodeRunning });
    updateItem(IDX.START,         'Start Node',   { enabled: true, hidden: nodeRunning });
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

async function initTray(
  getChild: () => ChildProcess | null,
): Promise<void> {
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
      else if (seq === IDX.START) {
        if (!child) { child = spawnNode(); refreshTray(); }
      }
      else if (seq === IDX.RESTART) {
        const c = getChild(); if (c) c.kill('SIGINT');
      }
      else if (seq === IDX.STOP) {
        userStopped = true;
        const c = getChild(); if (c) c.kill('SIGINT');
      }
      else if (seq === IDX.QUIT) {
        stopping = true;
        if (child) child.kill('SIGINT');
        setTimeout(() => process.exit(0), 2_000);
      }
    } catch { /* ignore */ }
  });

  console.log('[supervisor] System tray initialized.');
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

// Poll node status + services — first poll after 5s (wait for node boot), then every 10s
setTimeout(() => { pollState().catch(() => {}); }, 5_000);
const pollTimer = setInterval(() => { pollState().catch(() => {}); }, POLL_INTERVAL_MS);
pollTimer.unref();

// Skip tray on headless systems
const isHeadless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
if (!isHeadless) {
  initTray(
    () => child,
  ).catch((e: unknown) => {
    console.log(`[supervisor] Tray init failed: ${e instanceof Error ? e.message : String(e)}`);
  });
} else {
  console.log('[supervisor] Headless system detected — skipping system tray.');
}

child = spawnNode();
