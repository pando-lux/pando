#!/bin/bash
# Pando Node Installer — Mac/Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/pando-lux/pando/master/scripts/install.sh | bash
#
# What this does:
#   1. Checks for Node.js 18+
#   2. Clones pando-lux/pando (or updates if already cloned)
#   3. npm install + npm run build
#   4. Starts the node connected to the live network

set -e

REPO="https://github.com/pando-lux/pando.git"
PANDO_DIR="${PANDO_DIR:-$HOME/pando}"
BOOTSTRAP="/ip4/54.82.241.132/tcp/4001/p2p/12D3KooWDRjGzaUuATiPuhg5D2k1CQTT6nCMpjdsDTVwrGDC4QVP"

# ─── Colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; AMBER='\033[0;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${AMBER}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
info() { echo -e "${CYAN}→${NC} $*"; }

echo -e "\n${BOLD}Pando Node Installer${NC}"
echo "─────────────────────────────────"

# ─── Node.js ─────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  warn "Node.js not found."
  echo ""
  echo "  Install Node.js 18+ from: https://nodejs.org"
  echo "  Or via nvm:  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
  echo "  Then re-run this script."
  echo ""
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.version.match(/^v(\d+)/)[1]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node.js 18+ required. Found: $(node -v). Please upgrade: https://nodejs.org"
fi
ok "Node.js $(node -v)"

# ─── Git ─────────────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  err "Git not found. Install git: https://git-scm.com"
fi
ok "git $(git --version | awk '{print $3}')"

# ─── Clone or update ─────────────────────────────────────────────────────────
if [ -d "$PANDO_DIR/.git" ]; then
  info "Updating existing Pando installation at $PANDO_DIR ..."
  cd "$PANDO_DIR"
  git pull --quiet
  ok "Updated to latest"
else
  info "Cloning Pando to $PANDO_DIR ..."
  git clone --quiet "$REPO" "$PANDO_DIR"
  cd "$PANDO_DIR"
  ok "Cloned"
fi

# ─── Install + build ─────────────────────────────────────────────────────────
info "Installing dependencies (this takes ~1-2 minutes on first run)..."
npm install --silent 2>&1 | tail -1 || true

info "Building all packages..."
npm run build --workspaces --if-present 2>&1 | grep -E "^(✓|>|error)" | head -20
ok "Build complete"

# ─── Launch ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Starting Pando node...${NC}"
echo "  Connecting to: $BOOTSTRAP"
echo "  API:           http://localhost:4000"
echo "  Data dir:      ~/.pando"
echo ""
echo -e "  ${AMBER}Your identity is auto-created on first run. Keep ~/.pando/identity.json safe!${NC}"
echo ""
echo "  Press Ctrl+C to stop."
echo ""

exec node "$PANDO_DIR/packages/node/dist/cli.js" \
  --port 4001 \
  --bootstrap "$BOOTSTRAP"
