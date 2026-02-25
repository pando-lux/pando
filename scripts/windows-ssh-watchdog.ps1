# Pando SSH Service Watchdog (Windows)
# Monitors the OpenSSH Server (sshd) service and restarts it if stopped.
# SSH downtime blocks remote CEO recovery — 4 incidents (cycles 206, 232, 337, 481).
#
# Install (admin PowerShell):
#   schtasks /create /tn "PandoSSHWatchdog" /tr "powershell -ExecutionPolicy Bypass -File C:\Users\jaira\Desktop\pando\scripts\windows-ssh-watchdog.ps1" /sc onlogon /rl HIGHEST /it /f
#
# Or run manually (admin PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\windows-ssh-watchdog.ps1

$serviceName = "sshd"
$logFile = "$env:USERPROFILE\.pando\logs\ssh-watchdog.log"
$checkIntervalSec = 30

# Ensure log directory exists
$logDir = Split-Path $logFile
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"
    $line = "[$timestamp] $Message"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

Write-Log "SSH watchdog started. Monitoring service: $serviceName"

while ($true) {
    try {
        $svc = Get-Service -Name $serviceName -ErrorAction Stop

        if ($svc.StartType -eq "Disabled") {
            Write-Log "WARN: sshd startup type is Disabled. Setting to Automatic."
            Set-Service -Name $serviceName -StartupType Automatic
            Write-Log "OK: sshd startup type set to Automatic."
        }

        if ($svc.Status -ne "Running") {
            Write-Log "ALERT: sshd is $($svc.Status). Attempting restart..."
            Start-Service -Name $serviceName -ErrorAction Stop
            Start-Sleep -Seconds 3
            $svc = Get-Service -Name $serviceName
            if ($svc.Status -eq "Running") {
                Write-Log "OK: sshd restarted successfully."
            } else {
                Write-Log "ERROR: sshd restart failed. Status: $($svc.Status)"
            }
        }
    } catch {
        Write-Log "ERROR: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $checkIntervalSec
}
