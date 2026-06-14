@echo off
REM run-server.bat - starts the shard on ws://127.0.0.1:2593/game
REM Leave this window open. Press Ctrl+C to stop.

setlocal
cd /d "%~dp0..\..\"

if "%UO_PORT%"=="" set "UO_PORT=2593"
if "%UO_HOST%"=="" set "UO_HOST=0.0.0.0"

echo [server] starting on %UO_HOST%:%UO_PORT% (WS path: /game)
echo [server] press Ctrl+C to stop.
echo.
call pnpm --filter @uo/server dev
endlocal
