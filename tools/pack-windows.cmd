@echo off
rem V-Mirror asset pack from a clone of the repository: double-click this file.
rem Runs public\pack.ps1 on this checkout (no download of the source); extra arguments are
rem passed on, e.g.  tools\pack-windows.cmd -Game "D:\Games\Cyberpunk 2077" -Out D:\v-mirror-pack
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\public\pack.ps1" -Source "%~dp0.." %*
set "VM_CODE=%ERRORLEVEL%"
echo.
pause
exit /b %VM_CODE%
