#!/usr/bin/env bash
# ============================================================================
# Quick-start Pando via PM2 (no setup, no build — assumes already built)
# ============================================================================
#
# Usage:
#   ./scripts/pm2-start.sh                           # start both node + gateway
#   ./scripts/pm2-start.sh --build                   # build first, then start
#   PANDO_API_PORT=4000 ./scripts/pm2-start.sh       # custom ports
#
# For full first-time setup (installs PM2, builds, etc), use:
#   ./scripts/setup-pm2.sh
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Check PM2
if ! command -v pm2 &>/dev/null; then
  echo "ERROR: PM2 not found. Run ./scripts/setup-pm2.sh first, or: npm install -g pm2"
  exit 1
fi

# Optional build
if [ "$1" = "--build" ]; then
  echo "Building Pando..."
  npm run build
  echo "Building gateway for production..."
  cd packages/gateway && npx next build 2>&1 && cd "$PROJECT_DIR"
  echo "Build complete."
  echo ""
fi

# Ensure log directory exists
mkdir -p "$HOME/.pando/logs"

# Start (or restart if already running)
echo "Starting Pando via PM2..."
pm2 start ecosystem.config.cjs
pm2 save

echo ""
pm2 status
echo ""
echo "Run 'pm2 logs' to see output."
