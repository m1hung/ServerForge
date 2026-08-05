@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install Node 20.11+ from https://nodejs.org/ then run this again.
  pause
  exit /b 1
)

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker is not installed or not on PATH.
  echo Install Docker Desktop, start it, then run this again.
  echo https://docs.docker.com/desktop/setup/install/windows-install/
  pause
  exit /b 1
)

node scripts\start-persistent.mjs %*
set EXIT_CODE=%ERRORLEVEL%
if not %EXIT_CODE%==0 (
  echo.
  echo ServerForge could not start. See the messages above.
  pause
)
exit /b %EXIT_CODE%
