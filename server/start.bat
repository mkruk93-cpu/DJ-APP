@echo off
title Radio Server
cd /d "%~dp0"
echo Stopping old server on port 3001...
set "PORT=3001"
set /a KILL_TRIES=0
:kill_loop
set "FOUND_PIDS="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  set "FOUND_PIDS=1"
  echo Killed old process PID %%p
  taskkill /PID %%p /F >nul 2>&1
)
if defined FOUND_PIDS timeout /t 1 /nobreak >nul
set /a KILL_TRIES+=1
if %KILL_TRIES% GEQ 8 goto after_kill
set "FOUND_PIDS="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do set "FOUND_PIDS=1"
if defined FOUND_PIDS goto kill_loop
:after_kill
echo Starting radio server...
echo.
npx tsx src/server.ts
pause
