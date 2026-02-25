@echo off
:: Pando Supervised Node Launcher (Windows)
:: Double-click this file to start a supervised Pando node.
:: The PowerShell supervisor handles auto-restart on crash or update.
::
:: Default: port 4001, API port 4100, scheduler enabled.
:: To customize, edit the parameters below or run from command line:
::   start-supervised.bat -Port 5001 -ApiPort 5100 -Monitor
::
:: Exit codes handled by supervisor:
::   0  = clean shutdown (stop)
::   75 = auto-update restart (immediate)
::   *  = crash restart (5s delay)

cd /d "%~dp0.."

:: Find PowerShell (prefer pwsh, fall back to powershell)
where pwsh >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set "PS=pwsh"
) else (
    set "PS=powershell"
)

:: Launch the supervisor with default parameters
:: Pass any command-line arguments through to the PowerShell script
%PS% -ExecutionPolicy Bypass -NoProfile -File "%~dp0pando-supervisor.ps1" -Scheduler %*

:: Keep window open on exit so user can see final message
pause
