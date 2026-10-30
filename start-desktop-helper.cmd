@echo off
rem Double-click while the demo is running: starts the real desktop helper on this laptop. It reports the
rem program in front, time since the last input, a locked screen and microphone use to the demo server.
rem Close its window to switch it off (the manager screen then shows that the desktop app stopped).
cd /d "%~dp0"
if not exist node_modules (
  echo Installing, first time only...
  call npm install --no-audit --no-fund
)
echo Who is using this laptop?
echo   1  Ananya Bose
echo   2  Rahul Sharma
echo   3  Priya Das
echo   4  Oliver Smith
choice /c 1234 /n /m "Type 1, 2, 3 or 4: "
if errorlevel 4 set WHO=oliver& goto run
if errorlevel 3 set WHO=priya& goto run
if errorlevel 2 set WHO=rahul& goto run
set WHO=ananya
:run
title Desktop helper - close this window to switch it off
node desktop-agent\agent.js %WHO%
pause
