@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "ROOT_DIR=%~dp0"

echo  ============================================
echo       DJ Overlay starten...
echo  ============================================
echo.

if defined OVERLAY_START_CMD (
  start "DJ Overlay" cmd /c "%OVERLAY_START_CMD%"
  echo  [+] Overlay gestart via OVERLAY_START_CMD.
  exit /b 0
)

if exist "%ROOT_DIR%overlay\package.json" (
  start "DJ Overlay" cmd /k "cd /d ""%ROOT_DIR%overlay"" && call npm.cmd run dev"
  echo  [+] Overlay gestart (npm run dev).
  exit /b 0
)

echo  [!] Overlay folder niet gevonden: "%ROOT_DIR%overlay"
pause
exit /b 1
