@echo off
setlocal

cd /d "%~dp0"

start "QueueFlow Remote Dev" cmd /k "cd /d ""%~dp0"" && npm run dev:remote"
timeout /t 4 /nobreak >nul
start "" "http://localhost:5173/app.html"

endlocal
