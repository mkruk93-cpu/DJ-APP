@echo off
title Radio Server
cd /d "%~dp0"
echo Starting radio server...
echo.
npx tsx src/server.ts
pause
