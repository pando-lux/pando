# Pando Node Watchdog (Windows)
# Checks heartbeat file every 30s. If stale >2 minutes, restarts the node.
# Install: schtasks /create /tn "PandoWatchdog" /tr "powershell -ExecutionPolicy Bypass -File C:\Users\jaira\Desktop\pando\scripts\watchdog.ps1" /sc onlogon /it /f

$heartbeatFile = "$env:USERPROFILE\.pando\heartbeat.json"
$repoDir = "$env:USERPROFILE\Desktop\pando"
$staleThresholdSec = 120
$checkIntervalSec = 30

while ($true) {
    Start-Sleep -Seconds $checkIntervalSec

    # Check if node process is running
    $nodeProc = Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*pando*" -or $_.CommandLine -like "*tui.js*" }

    if (-not $nodeProc) {
        Write-Host "[watchdog] Node not running. Starting..."
        Start-Process -FilePath "cmd" -ArgumentList "/k cd /d $repoDir && node bin\pando.js --port 4001 --api-port 4100" -WindowStyle Normal
        Start-Sleep -Seconds 15
        continue
    }

    # Check heartbeat staleness
    if (Test-Path $heartbeatFile) {
        try {
            $hb = Get-Content $heartbeatFile -Raw | ConvertFrom-Json
            $lastBeat = [DateTime]::Parse($hb.timestamp)
            $ageSec = (Get-Date).Subtract($lastBeat).TotalSeconds

            if ($ageSec -gt $staleThresholdSec) {
                Write-Host "[watchdog] Heartbeat stale (${ageSec}s). Restarting node..."
                $nodeProc | Stop-Process -Force
                Start-Sleep -Seconds 5
                Start-Process -FilePath "cmd" -ArgumentList "/k cd /d $repoDir && node bin\pando.js --port 4001 --api-port 4100" -WindowStyle Normal
            }
        } catch {
            Write-Host "[watchdog] Error reading heartbeat: $_"
        }
    }
}
