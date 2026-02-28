/**
 * Pando Node Supervisor
 *
 * Standalone entry point — spawns dist/cli.js as a managed child process.
 * Handles restart-on-exit(75), crash backoff, and optional system tray icon.
 * Zero imports from Pando internals — fully decoupled.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';
import { execSync } from 'node:child_process';

const RESTART_EXIT_CODE = 75;
const RESTART_DELAY_MS  = 2_000;
const CRASH_WINDOW_MS   = 5 * 60 * 1_000;
const MAX_CRASHES       = 5;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ts = () => new Date().toISOString();

// ─── Core Supervisor (<50 lines) ───────────────────────────────────────────

let child: ChildProcess | null = null;
let stopping = false;
const crashTimes: number[] = [];

function spawnNode(): ChildProcess {
  const cliPath = join(__dirname, 'cli.js');
  const args = [cliPath, '--supervised', ...process.argv.slice(2)];
  console.log(`[supervisor ${ts()}] Spawning: node ${args.join(' ')}`);
  const proc = spawn(process.execPath, args, { stdio: 'inherit' });
  proc.on('exit', onChildExit);
  return proc;
}

function onChildExit(code: number | null, signal: string | null): void {
  child = null;
  setTrayStatus('restarting', 'Status: Restarting…');
  if (stopping) return;

  if (code === 0) {
    console.log(`[supervisor ${ts()}] Node exited cleanly (0). Stopping supervisor.`);
    process.exit(0);
  }

  if (code === RESTART_EXIT_CODE) {
    console.log(`[supervisor ${ts()}] Restart requested (exit 75). Respawning in ${RESTART_DELAY_MS}ms…`);
    setTimeout(() => { child = spawnNode(); }, RESTART_DELAY_MS);
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
  setTimeout(() => { child = spawnNode(); }, RESTART_DELAY_MS);
}

process.on('SIGINT', () => {
  stopping = true;
  console.log(`[supervisor ${ts()}] SIGINT received — shutting down.`);
  if (child) child.kill('SIGINT');
  setTimeout(() => process.exit(0), 3_000);
});

// ─── Tray helpers ──────────────────────────────────────────────────────────

type TrayStatus = 'green' | 'yellow' | 'restarting' | 'red';
let trayUpdateFn: ((status: TrayStatus, text: string) => void) | null = null;

function setTrayStatus(status: TrayStatus, text: string): void {
  if (trayUpdateFn) trayUpdateFn(status, text);
}

// ─── Status poller ─────────────────────────────────────────────────────────

function pollStatus(): void {
  const req = http.get('http://127.0.0.1:4100/v1/status', (res) => {
    let body = '';
    res.on('data', (c: Buffer) => { body += c.toString(); });
    res.on('end', () => {
      try {
        const d = JSON.parse(body);
        const peers: number  = d.peers   ?? 0;
        const lux: number    = Math.floor(d.balance ?? 0);
        const text = `Status: Online | ${peers} peer${peers !== 1 ? 's' : ''} | ${lux} Lux`;
        setTrayStatus(peers > 0 ? 'green' : 'yellow', text);
      } catch { /* ignore parse errors */ }
    });
  });
  req.on('error', () => {
    if (!stopping) setTrayStatus('red', 'Status: Offline');
  });
  req.setTimeout(5_000, () => req.destroy());
}

// ─── Open URL ──────────────────────────────────────────────────────────────

function openUrl(url: string): void {
  try {
    const cmd = process.platform === 'win32'  ? `start "" "${url}"` :
                process.platform === 'darwin' ? `open "${url}"` :
                                                `xdg-open "${url}"`;
    execSync(cmd, { stdio: 'ignore', windowsHide: true });
  } catch { /* ignore */ }
}

// ─── System tray (optional — headless fallback) ────────────────────────────

// 16×16 "P" icon: amber P on dark background (Pando brand).
const ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALUlEQVR4nGPQ1dX9' +
  'TwlmGHwG/N/PgBfTzwBixWlnwOALA5KjcQgbQHFSprsBAKmBwGAyMyKZAAAAAElF' +
  'TkSuQmCC';

async function initTray(
  getChild: () => ChildProcess | null,
  stop: () => void,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let SysTray: any;
  try {
    // Dynamic import — systray2 is optional; fails gracefully on headless systems
    // @ts-ignore — no type declarations for systray2
    const mod = await import('systray2');
    // Handle ESM/CJS interop — systray2 may nest default exports
    SysTray = mod.default?.default || mod.default || mod;
  } catch {
    console.log('[supervisor] Running in headless mode (systray2 unavailable or unsupported)');
    return;
  }

  const STATUS_IDX = 1; // index of status item in menu
  const items = [
    { title: 'Pando Node',           tooltip: '',                        checked: false, enabled: false },
    { title: 'Status: Starting…',    tooltip: 'Node status',             checked: false, enabled: false },
    { title: '<sep>',                tooltip: '',                        checked: false, enabled: false },
    { title: 'Open Gateway',         tooltip: 'Open Pando web gateway',  checked: false, enabled: true  },
    { title: 'View API',             tooltip: 'Open local API',          checked: false, enabled: true  },
    { title: '<sep>',                tooltip: '',                        checked: false, enabled: false },
    { title: 'Restart Node',         tooltip: 'Restart the Pando node',  checked: false, enabled: true  },
    { title: 'Stop Node',            tooltip: 'Stop Pando and exit',     checked: false, enabled: true  },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tray: any;
  try {
    tray = new SysTray({
      menu: { icon: ICON_B64, title: '', tooltip: 'Pando Node — Running', items },
      debug: false,
      copyDir: true,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[supervisor] Running in headless mode (${msg})`);
    return;
  }

  trayUpdateFn = (_status: TrayStatus, text: string) => {
    try {
      tray.sendAction({
        type: 'update-item',
        item: { ...items[STATUS_IDX], title: text },
        seq_id: STATUS_IDX,
      });
    } catch { /* ignore */ }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tray.onClick((action: any) => {
    try {
      const title: string = action?.item?.title ?? '';
      if      (title === 'Open Gateway')  openUrl('https://gateway-one-mu.vercel.app');
      else if (title === 'View API')      openUrl('http://127.0.0.1:4100');
      else if (title === 'Restart Node')  { const c = getChild(); if (c) c.kill('SIGINT'); }
      else if (title === 'Stop Node')     stop();
    } catch { /* ignore */ }
  });

  console.log('[supervisor] System tray initialized.');
}

// ─── Boot ──────────────────────────────────────────────────────────────────

const pollTimer = setInterval(pollStatus, 10_000);
pollTimer.unref(); // don't prevent process exit

initTray(
  () => child,
  () => { stopping = true; if (child) child.kill('SIGINT'); setTimeout(() => process.exit(0), 3_000); },
).catch((e: unknown) => {
  console.log(`[supervisor] Tray init failed: ${e instanceof Error ? e.message : String(e)}`);
});

child = spawnNode();
