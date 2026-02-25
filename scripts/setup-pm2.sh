#!/usr/bin/env bash
# ============================================================================
# Pando PM2 Setup — Phase 22.6 (Law II: Node Must Survive)
# ============================================================================
#
# Installs PM2, builds Pando, starts the node + gateway under PM2 supervision.
#
# Usage:
#   ./scripts/setup-pm2.sh                          # defaults (port 4001, API 4100)
#   PANDO_API_PORT=4000 ./scripts/setup-pm2.sh      # custom API port
#   ./scripts/setup-pm2.sh --gateway-only            # start only the gateway
#
# After setup:
#   pm2 status          — check process status
#   pm2 logs            — stream all logs
#   pm2 logs pando-node — stream node logs only
#   pm2 restart all     — restart everything
#   pm2 stop all        — stop everything
#   pm2 delete all      — remove from PM2 process list
#
# Exit codes:
#   Node exit 0  = clean shutdown (PM2 stops)
#   Node exit 75 = auto-update restart (PM2 restarts immediately)
#   Any other    = crash (PM2 restarts after 5s delay)
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Pando PM2 Setup (Phase 22.6 — Law II) ==="
echo ""

# --- Pre-flight checks ---

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 18+ first."
  exit 1
fi

NODE_VERSION=$(node --version)
echo "  Node.js: $NODE_VERSION"

# Install PM2 if needed
if ! command -v pm2 &>/dev/null; then
  echo "  PM2: not found, installing..."
  npm install -g pm2
else
  PM2_VERSION=$(pm2 --version 2>/dev/null || echo "unknown")
  echo "  PM2: v$PM2_VERSION"
fi

# Install pm2-logrotate for automatic log rotation
pm2 install pm2-logrotate 2>/dev/null || true
pm2 set pm2-logrotate:max_size 10M 2>/dev/null || true
pm2 set pm2-logrotate:retain 3 2>/dev/null || true
pm2 set pm2-logrotate:compress true 2>/dev/null || true

# --- Ensure log directory exists ---
LOG_DIR="$HOME/.pando/logs"
mkdir -p "$LOG_DIR"
echo "  Logs: $LOG_DIR"

# --- Build ---
echo ""
echo "Building Pando..."
cd "$PROJECT_DIR"

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies..."
  npm install
fi

npm run build
echo "  Build complete."

# --- Build gateway for production (next build) ---
echo ""
echo "Building gateway for production..."
cd "$PROJECT_DIR/packages/gateway"
npx next build 2>&1 || {
  echo "WARNING: Gateway production build failed. Gateway will not start."
  echo "  You can run it in dev mode instead: cd packages/gateway && npx next dev --port 3222"
}
cd "$PROJECT_DIR"

# --- Stop existing PM2 processes if running ---
pm2 delete pando-node 2>/dev/null || true
pm2 delete pando-gateway 2>/dev/null || true

# --- Start with PM2 ---
echo ""
echo "Starting Pando with PM2..."
pm2 start ecosystem.config.cjs
pm2 save

echo ""
echo "=== Pando is running under PM2 ==="
echo ""
pm2 status
echo ""
echo "Commands:"
echo "  pm2 status           — process status"
echo "  pm2 logs             — stream all logs"
echo "  pm2 logs pando-node  — node logs only"
echo "  pm2 monit            — real-time dashboard"
echo "  pm2 restart all      — restart everything"
echo "  pm2 stop all         — stop everything"
echo "  pm2 delete all       — remove from PM2"
echo ""
echo "Log files:"
echo "  $LOG_DIR/pm2-node-out.log"
echo "  $LOG_DIR/pm2-node-error.log"
echo "  $LOG_DIR/pm2-gateway-out.log"
echo "  $LOG_DIR/pm2-gateway-error.log"
echo ""
echo "Law II: The node will automatically restart on crash."
echo "        Exit code 75 (auto-update) triggers immediate restart."
echo "        Exit code 0 (clean shutdown) stops the process."
