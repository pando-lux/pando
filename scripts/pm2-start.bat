@echo off
:: ============================================================================
:: Quick-start Pando via PM2 (Windows)
:: ============================================================================
::
:: Usage:
::   scripts\pm2-start.bat                  - start both node + gateway
::   scripts\pm2-start.bat --build          - build first, then start
::   set PANDO_API_PORT=4000 && scripts\pm2-start.bat  - custom ports
::
:: For full first-time setup, use:
::   powershell -File scripts\setup-pm2.ps1
:: ============================================================================

cd /d "%~dp0.."

:: Check PM2
where pm2 >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: PM2 not found. Run setup-pm2.ps1 first, or: npm install -g pm2
    pause
    exit /b 1
)

:: Optional build
if "%1"=="--build" (
    echo Building Pando...
    npm run build
    echo Building gateway for production...
    cd packages\gateway
    call npx next build
    cd /d "%~dp0.."
    echo Build complete.
    echo.
)

:: Ensure log directory exists
if not exist "%USERPROFILE%\.pando\logs" mkdir "%USERPROFILE%\.pando\logs"

:: Start (or restart if already running)
echo Starting Pando via PM2...
pm2 start ecosystem.config.cjs
pm2 save

echo.
pm2 status
echo.
echo Run 'pm2 logs' to see output.
