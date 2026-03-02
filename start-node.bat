@echo off
:: Pando Node Launcher (Windows)
:: Double-click this file to start a Pando node.
:: Auto-installs and builds on first run.
:: Restarts automatically on upgrade (exit code 75) or crash (wait 5s).
::
:: Usage:
::   start-node.bat                         - start with defaults
::   start-node.bat --port 5001 --api-port 5100
::
:: For full supervised mode with logging, use:
::   scripts\start-supervised.bat
::
:: Exit codes:
::   0  = clean shutdown (stop)
::   75 = auto-update restart (immediate, 2s delay for port release)
::   *  = crash restart (5s delay)

cd /d "%~dp0"

:: Ensure log directory exists
if not exist "%USERPROFILE%\.pando\logs" mkdir "%USERPROFILE%\.pando\logs"

:: Log startup
echo [%DATE% %TIME%] start-node.bat launched >> "%USERPROFILE%\.pando\logs\supervisor.log"

:: Install dependencies if needed
if not exist "node_modules" (
    echo First run — installing dependencies...
    echo [%DATE% %TIME%] Installing dependencies... >> "%USERPROFILE%\.pando\logs\supervisor.log"
    npm install
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: npm install failed. Exiting.
        echo [%DATE% %TIME%] ERROR: npm install failed >> "%USERPROFILE%\.pando\logs\supervisor.log"
        pause
        exit /b 1
    )
)

:: Build if entry point missing
if not exist "packages\node\dist\tui.js" (
    echo First run — building Pando...
    echo [%DATE% %TIME%] Building... >> "%USERPROFILE%\.pando\logs\supervisor.log"
    npm run build
    if %ERRORLEVEL% NEQ 0 (
        echo ERROR: Build failed. Exiting.
        echo [%DATE% %TIME%] ERROR: Build failed >> "%USERPROFILE%\.pando\logs\supervisor.log"
        pause
        exit /b 1
    )
)

:: Set gateway URL for deployed apps (URL injection at deploy time)
if not defined GATEWAY_PUBLIC_URL set "GATEWAY_PUBLIC_URL=https://gateway-one-mu.vercel.app"

:: Vercel deploy token for gateway auto-deploy after governance approval
:: Set VERCEL_DEPLOY_TOKEN in secrets/local.env.bat (gitignored) or system env vars
if exist "%~dp0secrets\local.env.bat" call "%~dp0secrets\local.env.bat"

:: Default arguments if none provided
set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=--port 4100 --api-port 4000"

set /a RESTART_COUNT=0

:loop
set /a RESTART_COUNT+=1
echo [%DATE% %TIME%] Starting Pando node (run #%RESTART_COUNT%)...
echo [%DATE% %TIME%] Starting node (run #%RESTART_COUNT%) with args: %ARGS% >> "%USERPROFILE%\.pando\logs\supervisor.log"

node packages\node\dist\tui.js %ARGS%
set EXIT_CODE=%ERRORLEVEL%

echo [%DATE% %TIME%] Node exited with code %EXIT_CODE% >> "%USERPROFILE%\.pando\logs\supervisor.log"

if %EXIT_CODE% EQU 0 (
    echo Clean shutdown. Exiting.
    echo [%DATE% %TIME%] Clean shutdown >> "%USERPROFILE%\.pando\logs\supervisor.log"
    goto end
)
if %EXIT_CODE% EQU 75 (
    echo Upgrade complete. Restarting in 2s...
    echo [%DATE% %TIME%] Restart requested (exit 75 - auto-update) >> "%USERPROFILE%\.pando\logs\supervisor.log"
    timeout /t 2 >nul
    goto loop
)
echo Crashed (exit %EXIT_CODE%). Restarting in 5s...
echo [%DATE% %TIME%] CRASH: exit %EXIT_CODE%, restarting in 5s >> "%USERPROFILE%\.pando\logs\supervisor.log"
timeout /t 5 >nul
goto loop

:end
echo [%DATE% %TIME%] Supervisor stopped >> "%USERPROFILE%\.pando\logs\supervisor.log"
pause
