@echo off
REM Pando Node — Windows Service Supervisor (Phase 67)
REM Handles exit codes: 0=stop, 75=fast restart (2s), other=crash restart (5s)
REM Logs restarts to %USERPROFILE%\.pando\logs\restart.log

cd /d %~dp0

REM Ensure logs directory exists
if not exist "%USERPROFILE%\.pando\logs" mkdir "%USERPROFILE%\.pando\logs"

set RESTART_LOG=%USERPROFILE%\.pando\logs\restart.log
set HUB_PUBLIC_URL=https://gateway-one-mu.vercel.app
set CREDENTIAL_MASTER_KEY=9e54185ea279ccedec088582ac4968d27870cbc8c437f102126edaceec378624
set PANDO_STORAGE_URL=mongodb+srv://node_admin:EzHvHx8d3UZByYaM@cluster0.ydcixos.mongodb.net/pando

echo [%date% %time%] Pando supervisor starting >> "%RESTART_LOG%"

:loop
echo [%date% %time%] Starting Pando node... >> "%RESTART_LOG%"
echo Starting Pando node...

node packages\node\dist\cli.js --port 4001 --api-port 4100 --data-dir %USERPROFILE%\.pando --bootstrap /ip4/100.69.190.122/tcp/4001/p2p/12D3KooWCFawRRdpL9w1kehZdAK7JGQqEqUfKKV72f7qEEtmwj7K

set EXIT_CODE=%ERRORLEVEL%
echo [%date% %time%] Node exited with code %EXIT_CODE% >> "%RESTART_LOG%"

if %EXIT_CODE%==0 (
  echo Node stopped cleanly (exit 0). Not restarting.
  echo [%date% %time%] Clean stop. Exiting supervisor. >> "%RESTART_LOG%"
  goto end
)

if %EXIT_CODE%==75 (
  echo Intentional restart (exit 75). Restarting in 2 seconds...
  echo [%date% %time%] Upgrade restart (exit 75). Delay 2s. >> "%RESTART_LOG%"
  timeout /t 2 /nobreak >nul
  goto loop
)

echo Unexpected exit (code %EXIT_CODE%). Restarting in 5 seconds...
echo [%date% %time%] Crash restart (exit %EXIT_CODE%). Delay 5s. >> "%RESTART_LOG%"
timeout /t 5 /nobreak >nul
goto loop

:end
echo Supervisor stopped.
