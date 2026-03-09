@echo off
:: Headless Pando Node Launcher with restart loop
:: Same as start-node.bat but uses cli.js (no TUI) for background operation
:: Exit code 75 = auto-restart after upgrade

cd /d "%~dp0"

:: Load secrets
if exist "%~dp0secrets\local.env.bat" call "%~dp0secrets\local.env.bat"

:: Set gateway URL
if not defined HUB_PUBLIC_URL set "HUB_PUBLIC_URL=https://gateway-one-mu.vercel.app"

set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=--port 4100 --api-port 4000"

set /a RESTART_COUNT=0

:loop
set /a RESTART_COUNT+=1
echo [%DATE% %TIME%] Starting Pando node headless (run #%RESTART_COUNT%)...

node packages\node\dist\cli.js %ARGS%
set EXIT_CODE=%ERRORLEVEL%

echo [%DATE% %TIME%] Node exited with code %EXIT_CODE%

if %EXIT_CODE% EQU 0 (
    echo Clean shutdown. Exiting.
    goto end
)
if %EXIT_CODE% EQU 75 (
    echo Upgrade restart. Restarting in 2s...
    timeout /t 2 >nul
    goto loop
)
echo Crashed (exit %EXIT_CODE%). Restarting in 5s...
timeout /t 5 >nul
goto loop

:end
echo Supervisor stopped.
pause
