@echo off
rem Double-click to start the demo. Close the "Activity demo server" window to stop it.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing, first time only...
  call npm install --no-audit --no-fund
)
start "Activity demo server - close this window to stop" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:4100/manager
start "" http://localhost:4100/
