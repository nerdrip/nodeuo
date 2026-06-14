@echo off
REM run-bridge-quiet.bat - same as run-bridge.bat but without per-packet debug
REM dumps. Use this once handshake/framing is stable and the noise just gets
REM in the way of normal play sessions.

setlocal
cd /d "%~dp0..\..\"

echo [bridge] starting WS-TCP proxy on ws://127.0.0.1:2595/bridge  (debug=off)
echo [bridge] press Ctrl+C to stop.
echo.
call pnpm --filter @uo/bridge start
endlocal
