@echo off
rem Double-click while the demo is running: pretends to be 2,000 employees for 30 seconds
rem (one check-in every 30 seconds each) and prints the server's memory and CPU use.
cd /d "%~dp0"
call npm run loadtest -- 2000 30 30
pause
