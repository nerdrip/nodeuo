@echo off
REM run-client.bat - starts Vite dev server for the browser client.
REM Open a SECOND terminal; run-server.bat must be running already.

setlocal
cd /d "%~dp0..\..\"

echo [client] starting Vite dev server on http://localhost:5173
echo [client] /game WebSocket is proxied to ws://127.0.0.1:2593
echo [client] press Ctrl+C to stop.
echo.
call pnpm --filter @uo/client dev
endlocal
