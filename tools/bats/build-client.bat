@echo off
REM build-client.bat - production build of the browser client.
REM Output: apps\client\dist (static files - can be served by any HTTP server).

setlocal
cd /d "%~dp0..\..\"
call pnpm --filter @uo/client build
if errorlevel 1 exit /b 1
echo.
echo [build] OK. Output: apps\client\dist
endlocal
