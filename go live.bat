@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if /I "%~1"=="watchdog" goto tunnel_watchdog_loop

set "ROOT_DIR=%~dp0"
set "SERVER_DIR=%ROOT_DIR%server"
set "PORT=3001"
set "HEALTH_URL=http://127.0.0.1:%PORT%/health"
set "STATE_URL=http://127.0.0.1:%PORT%/state"
set "MODE_URL=http://127.0.0.1:%PORT%/api/mode"
set "TUNNEL_URL_API=http://127.0.0.1:%PORT%/api/tunnel-url"
set "TUNNEL_LOG=%TEMP%\dj-radio-tunnel.log"
set "RADIO_TUNNEL_URL="
set "MAX_WAIT_HEALTH=45"
set "MAX_WAIT_TUNNEL=60"

echo  ============================================
echo       DJ Modus starten...
echo  ============================================
echo.

call :clean_start
call :start_icecast
call :start_radio_server
call :wait_radio_health
echo     Wachten tot server klaar is...
call :set_dj_mode
call :start_butt
call :start_tunnel
call :start_tunnel_watchdog
call :start_exporter
call :start_overlay

echo.
echo  ============================================
echo   Klaar Control/stream URL is automatisch opgeslagen.
echo  ============================================
echo.
pause
exit /b 0

:clean_start
echo  [+] Oude services stoppen (clean start)...
taskkill /IM cloudflared.exe /F >nul 2>&1
taskkill /IM butt.exe /F >nul 2>&1
taskkill /IM RekordBoxSongExporter.exe /F >nul 2>&1
call :kill_port "%PORT%"
echo      Clean start klaar.
exit /b 0

:kill_port
set "TARGET_PORT=%~1"
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%TARGET_PORT% .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>&1
)
exit /b 0

:start_icecast
echo  [+] Icecast starten...
if defined ICECAST_START_CMD (
  start "Icecast" cmd /c "%ICECAST_START_CMD%"
  echo      OK
  exit /b 0
)
if exist "%ProgramFiles%\Icecast\icecast.exe" (
  start "Icecast" "%ProgramFiles%\Icecast\icecast.exe"
  echo      OK
  exit /b 0
)
if exist "%ProgramFiles(x86)%\Icecast\icecast.exe" (
  start "Icecast" "%ProgramFiles(x86)%\Icecast\icecast.exe"
  echo      OK
  exit /b 0
)
echo      Waarschuwing: Icecast startcommando niet gevonden (zet ICECAST_START_CMD).
exit /b 0

:start_radio_server
echo  [+] Radio Server starten...
if exist "%SERVER_DIR%\start.bat" (
  start "Radio Server" cmd /k "cd /d ""%SERVER_DIR%"" && call start.bat"
) else (
  start "Radio Server" cmd /k "cd /d ""%SERVER_DIR%"" && npm run start"
)
echo      OK
exit /b 0

:wait_radio_health
set /a WAIT_TRIES=0
:wait_radio_health_loop
set /a WAIT_TRIES+=1
curl -fsS "%HEALTH_URL%" >nul 2>&1
if not errorlevel 1 exit /b 0
if !WAIT_TRIES! GEQ %MAX_WAIT_HEALTH% (
  echo      Waarschuwing: server health check timeout.
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait_radio_health_loop

:set_dj_mode
echo  [+] Modus automatisch zetten: DJ...
curl -fsS -X POST "%MODE_URL%" -H "Content-Type: application/json" -d "{\"mode\":\"dj\"}" >nul 2>&1
set /a MODE_TRIES=0
:mode_verify_loop
set /a MODE_TRIES+=1
curl -fsS "%STATE_URL%" 2>nul | findstr /I /C:"\"mode\":\"dj\"" >nul
if not errorlevel 1 (
  echo      OK
  exit /b 0
)
if !MODE_TRIES! GEQ 15 (
  echo      Waarschuwing: modus verify faalde (dj)
  exit /b 0
)
timeout /t 1 /nobreak >nul
goto mode_verify_loop

:start_butt
echo  [+] BUTT starten...
if defined BUTT_START_CMD (
  start "BUTT" cmd /c "%BUTT_START_CMD%"
  echo      OK
  exit /b 0
)
if exist "%ProgramFiles(x86)%\BUTT\butt.exe" (
  start "BUTT" "%ProgramFiles(x86)%\BUTT\butt.exe"
  echo      OK
  exit /b 0
)
if exist "%ProgramFiles%\BUTT\butt.exe" (
  start "BUTT" "%ProgramFiles%\BUTT\butt.exe"
  echo      OK
  exit /b 0
)
echo      Waarschuwing: BUTT startcommando niet gevonden (zet BUTT_START_CMD).
exit /b 0

:start_tunnel
echo  [+] Cloudflare Tunnel - Radio Server starten...
del /q "%TUNNEL_LOG%" >nul 2>&1
if defined CLOUDFLARE_TUNNEL_CMD (
  start "Cloudflare Tunnel - Radio Server" cmd /c "%CLOUDFLARE_TUNNEL_CMD% > ""%TUNNEL_LOG%"" 2>&1"
) else (
  start "Cloudflare Tunnel - Radio Server" cmd /c "cloudflared tunnel --url http://127.0.0.1:%PORT% --no-autoupdate > ""%TUNNEL_LOG%"" 2>&1"
)
echo      Wachten op tunnel URL...
set "RADIO_TUNNEL_URL="
set /a TUNNEL_TRIES=0
:wait_tunnel_url
set /a TUNNEL_TRIES+=1
for /f "tokens=1" %%u in ('findstr /R /C:"https://[a-z0-9-][a-z0-9-]*\.trycloudflare\.com" "%TUNNEL_LOG%"') do (
  set "RADIO_TUNNEL_URL=%%u"
)
if defined RADIO_TUNNEL_URL goto tunnel_url_found
if !TUNNEL_TRIES! GEQ %MAX_WAIT_TUNNEL% (
  echo      Waarschuwing: tunnel URL niet gevonden.
  exit /b 0
)
timeout /t 1 /nobreak >nul
goto wait_tunnel_url

:tunnel_url_found
echo      Radio Tunnel URL: !RADIO_TUNNEL_URL!
curl -fsS -X POST "%TUNNEL_URL_API%" -H "Content-Type: application/json" -d "{\"url\":\"!RADIO_TUNNEL_URL!\"}" >nul 2>&1
if errorlevel 1 (
  echo      Waarschuwing: radio_server_url opslaan faalde
) else (
  echo      OK: radio_server_url opgeslagen en geverifieerd
)
exit /b 0

:start_tunnel_watchdog
if not defined RADIO_TUNNEL_URL exit /b 0
start "Radio Tunnel Watchdog" /min cmd /c ""%~f0" watchdog"
exit /b 0

:start_exporter
echo  [+] RekordBoxSongExporter starten...
if defined EXPORTER_START_CMD (
  start "RekordBoxSongExporter" cmd /c "%EXPORTER_START_CMD%"
  echo      OK
  exit /b 0
)
if exist "%ROOT_DIR%bridge\bridge.py" (
  start "RekordBoxSongExporter" cmd /c "cd /d ""%ROOT_DIR%bridge"" && python bridge.py"
  echo      OK
  exit /b 0
)
echo      Waarschuwing: exporter startcommando niet gevonden (zet EXPORTER_START_CMD).
exit /b 0

:start_overlay
echo  [+] Overlay starten (DJ modus)...
if defined OVERLAY_START_CMD (
  start "DJ Overlay" cmd /c "%OVERLAY_START_CMD%"
  echo      OK
  exit /b 0
)
if exist "%ROOT_DIR%overlay\package.json" (
  start "DJ Overlay" cmd /k "cd /d ""%ROOT_DIR%overlay"" && npm run dev"
  echo      OK
  exit /b 0
)
echo      Waarschuwing: overlay folder niet gevonden.
exit /b 0

:tunnel_watchdog_loop
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "PORT=3001"
set "HEALTH_URL=http://127.0.0.1:%PORT%/health"
set "TUNNEL_URL_API=http://127.0.0.1:%PORT%/api/tunnel-url"
set "TUNNEL_LOG=%TEMP%\dj-radio-tunnel.log"
set "LAST_URL="

:watchdog_tick
timeout /t 25 /nobreak >nul
curl -fsS "%HEALTH_URL%" >nul 2>&1
if errorlevel 1 goto watchdog_tick

set "LATEST_URL="
for /f "tokens=1" %%u in ('findstr /R /C:"https://[a-z0-9-][a-z0-9-]*\.trycloudflare\.com" "%TUNNEL_LOG%"') do (
  set "LATEST_URL=%%u"
)
if not defined LATEST_URL goto watchdog_tick
if /I "!LATEST_URL!"=="!LAST_URL!" goto watchdog_tick

set "LAST_URL=!LATEST_URL!"
curl -fsS -X POST "%TUNNEL_URL_API%" -H "Content-Type: application/json" -d "{\"url\":\"!LATEST_URL!\"}" >nul 2>&1
goto watchdog_tick
