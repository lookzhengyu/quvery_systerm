@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -match 'vite' -or $_.CommandLine -match 'mock-queue-server' -or $_.CommandLine -match 'dev-remote') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

endlocal
