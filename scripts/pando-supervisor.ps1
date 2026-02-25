<#
.SYNOPSIS
    Pando Node Supervisor - Keeps the Pando node alive with smart restart logic.

.DESCRIPTION
    Runs the Pando node process in a supervised loop with exit-code-based behavior:
      - Exit 0   = Clean shutdown, stop supervisor
      - Exit 75  = Immediate restart (auto-update requested)
      - Any other = Wait 5 seconds, then restart (crash recovery)

    Logs all events with timestamps to ~/.pando/logs/supervisor.log.

.PARAMETER Port
    P2P listen port (default: 4001)

.PARAMETER ApiPort
    HTTP API port (default: 4100)

.PARAMETER Scheduler
    Enable the task scheduler

.PARAMETER Monitor
    Enable the health monitor

.PARAMETER Pipeline
    Enable the Phase 16 code pipeline

.PARAMETER Headless
    Run in headless/CLI mode (no TUI)

.EXAMPLE
    .\pando-supervisor.ps1
    .\pando-supervisor.ps1 -Port 4001 -ApiPort 4100 -Scheduler -Monitor
    .\pando-supervisor.ps1 -Pipeline -Headless
#>

param(
    [int]$Port = 4001,
    [int]$ApiPort = 4100,
    [switch]$Scheduler,
    [switch]$Monitor,
    [switch]$Pipeline,
    [switch]$Headless
)

# --- Configuration ---
$RESTART_EXIT_CODE = 75
$CRASH_WAIT_SECONDS = 5
$RESTART_WAIT_SECONDS = 2

# Resolve paths
$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogDir = Join-Path $env:USERPROFILE ".pando\logs"
$LogFile = Join-Path $LogDir "supervisor.log"
$MaxLogLines = 5000

# Determine entry point
if ($Headless) {
    $EntryPoint = Join-Path $RepoDir "packages\node\dist\cli.js"
}
else {
    $EntryPoint = Join-Path $RepoDir "packages\node\dist\tui.js"
}

# --- Logging ---
function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] $Message"
    Write-Host $line

    # Ensure log directory exists
    if (-not (Test-Path $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Trim-Log {
    if (Test-Path $LogFile) {
        $lines = @(Get-Content -Path $LogFile -Encoding UTF8)
        if ($lines.Count -gt $MaxLogLines) {
            $lines | Select-Object -Last $MaxLogLines | Set-Content -Path $LogFile -Encoding UTF8
            Write-Log "LOG: Trimmed to $MaxLogLines lines (was $($lines.Count))"
        }
    }
}

# --- Build node arguments ---
function Get-NodeArgs {
    $nodeArgs = @("--port", $Port, "--api-port", $ApiPort)

    if ($Scheduler) { $nodeArgs += "--scheduler" }
    if ($Monitor)   { $nodeArgs += "--monitor" }
    if ($Pipeline)  { $nodeArgs += "--pipeline" }

    return $nodeArgs
}

# --- Auto-build if needed ---
function Ensure-Built {
    if (-not (Test-Path $EntryPoint)) {
        Write-Log "First run - entry point not found. Building..."
        try {
            Push-Location $RepoDir
            & npm run build 2>&1 | ForEach-Object { Write-Log "BUILD: $_" }
            Pop-Location
            if (-not (Test-Path $EntryPoint)) {
                Write-Log "ERROR: Build completed but entry point still missing: $EntryPoint"
                return $false
            }
            Write-Log "Build complete."
        }
        catch {
            Write-Log "ERROR: Build failed - $_"
            Pop-Location
            return $false
        }
    }
    return $true
}

# --- Install dependencies if needed ---
function Ensure-Dependencies {
    $nodeModules = Join-Path $RepoDir "node_modules"
    if (-not (Test-Path $nodeModules)) {
        Write-Log "First run - installing dependencies..."
        try {
            Push-Location $RepoDir
            & npm install 2>&1 | ForEach-Object { Write-Log "NPM: $_" }
            Pop-Location
            Write-Log "Dependencies installed."
        }
        catch {
            Write-Log "ERROR: npm install failed - $_"
            Pop-Location
            return $false
        }
    }
    return $true
}

# ==================== MAIN LOOP ====================

$nodeArgs = Get-NodeArgs
$restartCount = 0
$trimCycle = 0

Write-Log "============================================"
Write-Log "PANDO SUPERVISOR STARTED"
Write-Log "  Repo:       $RepoDir"
Write-Log "  Entry:      $EntryPoint"
Write-Log "  Port:       $Port"
Write-Log "  API Port:   $ApiPort"
Write-Log "  Scheduler:  $Scheduler"
Write-Log "  Monitor:    $Monitor"
Write-Log "  Pipeline:   $Pipeline"
Write-Log "  Headless:   $Headless"
Write-Log "  Log:        $LogFile"
Write-Log "  Exit codes: 0=stop, 75=immediate restart, other=wait ${CRASH_WAIT_SECONDS}s"
Write-Log "============================================"

# Pre-flight checks
if (-not (Ensure-Dependencies)) {
    Write-Log "FATAL: Cannot install dependencies. Exiting."
    exit 1
}

if (-not (Ensure-Built)) {
    Write-Log "FATAL: Cannot build. Exiting."
    exit 1
}

while ($true) {
    $trimCycle++
    $restartCount++

    Write-Log "Starting Pando node (run #$restartCount)..."
    Write-Log "  Command: node $EntryPoint $($nodeArgs -join ' ')"

    # Run the node process
    $process = Start-Process -FilePath "node" `
        -ArgumentList (@($EntryPoint) + $nodeArgs) `
        -WorkingDirectory $RepoDir `
        -NoNewWindow `
        -PassThru `
        -Wait

    $exitCode = $process.ExitCode
    Write-Log "Node exited with code $exitCode"

    # --- Exit code routing ---
    if ($exitCode -eq 0) {
        Write-Log "Clean shutdown (exit 0). Supervisor stopping."
        break
    }
    elseif ($exitCode -eq $RESTART_EXIT_CODE) {
        Write-Log "Restart requested (exit $RESTART_EXIT_CODE, auto-update). Restarting in ${RESTART_WAIT_SECONDS}s..."
        Start-Sleep -Seconds $RESTART_WAIT_SECONDS

        # Re-check build after update
        if (-not (Ensure-Built)) {
            Write-Log "ERROR: Post-update build failed. Waiting ${CRASH_WAIT_SECONDS}s before retry..."
            Start-Sleep -Seconds $CRASH_WAIT_SECONDS
        }
    }
    else {
        Write-Log "CRASH: Unexpected exit ($exitCode). Restarting in ${CRASH_WAIT_SECONDS}s..."
        Start-Sleep -Seconds $CRASH_WAIT_SECONDS
    }

    # Trim log periodically (every 50 restarts)
    if ($trimCycle % 50 -eq 0) {
        Trim-Log
    }
}

Write-Log "PANDO SUPERVISOR STOPPED"
Write-Log "============================================"
