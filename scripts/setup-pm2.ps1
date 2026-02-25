# ============================================================================
# Pando PM2 Setup (Windows) — Phase 22.6 (Law II: Node Must Survive)
# ============================================================================
#
# Installs PM2, builds Pando, starts the node + gateway under PM2 supervision.
#
# Usage (from repo root or scripts/ directory):
#   .\scripts\setup-pm2.ps1                                # defaults
#   $env:PANDO_API_PORT="4000"; .\scripts\setup-pm2.ps1    # custom API port
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

$ErrorActionPreference = "Stop"

# Resolve project directory (parent of scripts/)
$ScriptDir = Split-Path -Parent $PSCommandPath
$ProjectDir = Split-Path -Parent $ScriptDir

Write-Host "=== Pando PM2 Setup (Windows) — Phase 22.6 (Law II) ===" -ForegroundColor Cyan
Write-Host ""

# --- Pre-flight checks ---

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js not found. Install Node.js 18+ first." -ForegroundColor Red
    exit 1
}

$nodeVersion = & node --version
Write-Host "  Node.js: $nodeVersion"

# Install PM2 if needed
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
    Write-Host "  PM2: not found, installing..."
    & npm install -g pm2
}
else {
    $pm2Version = & pm2 --version 2>$null
    Write-Host "  PM2: v$pm2Version"
}

# Install pm2-logrotate for automatic log rotation
try {
    & pm2 install pm2-logrotate 2>$null
    & pm2 set pm2-logrotate:max_size 10M 2>$null
    & pm2 set pm2-logrotate:retain 3 2>$null
    & pm2 set pm2-logrotate:compress true 2>$null
}
catch {
    Write-Host "  Note: pm2-logrotate setup skipped (non-critical)" -ForegroundColor Yellow
}

# --- Ensure log directory exists ---
$LogDir = Join-Path $env:USERPROFILE ".pando\logs"
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}
Write-Host "  Logs: $LogDir"

# --- Build ---
Write-Host ""
Write-Host "Building Pando..."
Push-Location $ProjectDir

# Install dependencies if node_modules is missing
if (-not (Test-Path "node_modules")) {
    Write-Host "  Installing dependencies..."
    & npm install
}

& npm run build
Write-Host "  Build complete."

# --- Build gateway for production (next build) ---
Write-Host ""
Write-Host "Building gateway for production..."
Push-Location (Join-Path $ProjectDir "packages\gateway")
try {
    & npx next build 2>&1
    Write-Host "  Gateway build complete."
}
catch {
    Write-Host "WARNING: Gateway production build failed. Gateway will not start." -ForegroundColor Yellow
    Write-Host "  You can run it in dev mode: cd packages\gateway && npx next dev --port 3222" -ForegroundColor Yellow
}
Pop-Location

# --- Stop existing PM2 processes if running ---
try { & pm2 delete pando-node 2>$null } catch {}
try { & pm2 delete pando-gateway 2>$null } catch {}

# --- Start with PM2 ---
Write-Host ""
Write-Host "Starting Pando with PM2..."
& pm2 start ecosystem.config.cjs
& pm2 save

Write-Host ""
Write-Host "=== Pando is running under PM2 ===" -ForegroundColor Green
Write-Host ""
& pm2 status
Write-Host ""
Write-Host "Commands:" -ForegroundColor Cyan
Write-Host "  pm2 status           - process status"
Write-Host "  pm2 logs             - stream all logs"
Write-Host "  pm2 logs pando-node  - node logs only"
Write-Host "  pm2 monit            - real-time dashboard"
Write-Host "  pm2 restart all      - restart everything"
Write-Host "  pm2 stop all         - stop everything"
Write-Host "  pm2 delete all       - remove from PM2"
Write-Host ""
Write-Host "Log files:" -ForegroundColor Cyan
Write-Host "  $LogDir\pm2-node-out.log"
Write-Host "  $LogDir\pm2-node-error.log"
Write-Host "  $LogDir\pm2-gateway-out.log"
Write-Host "  $LogDir\pm2-gateway-error.log"
Write-Host ""
Write-Host "Law II: The node will automatically restart on crash." -ForegroundColor Green
Write-Host "        Exit code 75 (auto-update) triggers immediate restart."
Write-Host "        Exit code 0 (clean shutdown) stops the process."

Pop-Location
