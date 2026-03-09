/**
 * PM2 Process Supervisor Configuration — Phase 22.6 (Law II Compliance)
 *
 * The Pando node MUST survive crashes. PM2 ensures automatic restart on
 * unexpected exits, memory limits, and structured logging.
 *
 * Architecture:
 *   pando-node    — The core P2P node (one process with --scheduler --monitor flags)
 *   pando-hub    — Next.js web UI (connects to node via HTTP)
 *
 * Exit codes:
 *   0  = Clean shutdown (PM2 stops the process)
 *   75 = Intentional restart from pipeline-runner (PM2 restarts, does NOT count as crash)
 *   *  = Unexpected crash (PM2 restarts after delay, counts toward max_restarts)
 *
 * Environment variables (override defaults):
 *   PANDO_P2P_PORT    — P2P listen port (default: 4001)
 *   PANDO_API_PORT    — HTTP API port (default: 4100)
 *   PANDO_GATEWAY_PORT — Hub web UI port (default: 3222)
 *   PANDO_NODE_FLAGS  — Additional CLI flags (e.g. "--pipeline")
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 start ecosystem.config.cjs --only pando-node
 *   pm2 start ecosystem.config.cjs --only pando-hub
 *   PANDO_API_PORT=4000 pm2 start ecosystem.config.cjs
 */

const path = require('path');
const os = require('os');

// Resolve log directory: ~/.pando/logs/
const pandoLogDir = path.join(os.homedir(), '.pando', 'logs');

// Configurable ports via environment variables
const p2pPort = process.env.PANDO_P2P_PORT || '4001';
const apiPort = process.env.PANDO_API_PORT || '4100';
const gatewayPort = process.env.PANDO_GATEWAY_PORT || '3222';
const extraFlags = process.env.PANDO_NODE_FLAGS || '';

// Bootstrap peer — connect to relay on startup
const bootstrapPeer = process.env.PANDO_BOOTSTRAP || '/ip4/54.145.144.221/tcp/4001/p2p/12D3KooWNSUWHf6tzHPb8uzUkaRfk3VfuMVrjzGgyueR4yioMGDP';

// Build node args string
const nodeArgs = `--port ${p2pPort} --api-port ${apiPort} --scheduler --monitor --pipeline --bootstrap ${bootstrapPeer}${extraFlags ? ' ' + extraFlags : ''}`;

module.exports = {
  apps: [
    // ----------------------------------------------------------------
    // pando-node — The core P2P node process
    // ----------------------------------------------------------------
    {
      name: 'pando-node',
      script: 'packages/node/dist/cli.js',
      args: nodeArgs,
      interpreter: 'node',
      cwd: __dirname,

      // --- Restart behavior ---
      autorestart: true,
      stop_exit_codes: [0],       // Only exit 0 = intentional stop. Exit 75 and crashes both restart.
      max_restarts: 10,           // Max 10 crashes within min_uptime window before PM2 gives up
      min_uptime: '30s',          // Process must run 30s to be considered "started" (not a boot crash)
      restart_delay: 5000,        // Wait 5s between crash restarts (let ports release)
      exp_backoff_restart_delay: 100, // Exponential backoff on rapid crashes (100ms * 2^n, capped at 15s)
      kill_timeout: 10000,        // Give 10s for graceful shutdown (SIGTERM) before SIGKILL

      // --- Logging ---
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(pandoLogDir, 'pm2-node-error.log'),
      out_file: path.join(pandoLogDir, 'pm2-node-out.log'),
      merge_logs: true,
      max_size: '10M',            // Auto-rotate at 10MB (requires pm2-logrotate module)

      // --- Environment ---
      env: {
        NODE_ENV: 'production',
        FORCE_COLOR: '0',         // Disable ANSI colors in PM2 logs (FileLogger strips them anyway)
        HUB_PUBLIC_URL: 'https://gateway-one-mu.vercel.app',
      },

      // --- Resource limits ---
      max_memory_restart: '1G',   // Restart if memory exceeds 1GB (leak protection)
      node_args: '--max-old-space-size=1024', // Match V8 heap to PM2 memory limit

      // --- Watch mode OFF ---
      // We control restarts via exit code 75 (pipeline-runner) and PM2 autorestart.
      // File watching would cause spurious restarts during builds.
      watch: false,
    },

    // ----------------------------------------------------------------
    // pando-hub — Next.js web UI
    // ----------------------------------------------------------------
    {
      name: 'pando-hub',
      script: 'node_modules/.bin/next',
      args: `start --port ${gatewayPort}`,
      interpreter: 'none',        // next is already a Node script, don't double-invoke
      cwd: path.join(__dirname, 'packages', 'hub'),

      // --- Restart behavior ---
      autorestart: true,
      stop_exit_codes: [0],
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      kill_timeout: 5000,

      // --- Logging ---
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(pandoLogDir, 'pm2-hub-error.log'),
      out_file: path.join(pandoLogDir, 'pm2-hub-out.log'),
      merge_logs: true,
      max_size: '10M',

      // --- Environment ---
      env: {
        PANDO_NODE_URL: `http://127.0.0.1:${apiPort}`,
        NODE_ENV: 'production',
        PORT: gatewayPort,
      },

      // --- Resource limits ---
      max_memory_restart: '512M',

      // --- Watch mode OFF ---
      watch: false,
    },
  ],
};
