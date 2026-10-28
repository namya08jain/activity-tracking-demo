@echo off
rem Double-click before a presentation to wipe the demo's saved history (data\activity.json),
rem so leftover test days don't show up in the reports. Asks before deleting anything.
cd /d "%~dp0"
netstat -ano | findstr ":4100 " | findstr LISTENING >nul
if not errorlevel 1 (
  echo The demo server is still running. Close the "Activity demo server" window first,
  echo otherwise it saves the old history again. Then double-click this file again.
  pause
  exit /b
)
if not exist data\activity.json (
  echo There is no saved demo history. Nothing to delete.
  pause
  exit /b
)
echo This deletes ALL saved demo history: your test days and the made-up sample week.
choice /m "Delete the demo history now"
if errorlevel 2 (
  echo Nothing was deleted.
  pause
  exit /b
)
del data\activity.json
echo Done. Double-click start-demo.cmd, then add the sample week on the Reports page.
pause
