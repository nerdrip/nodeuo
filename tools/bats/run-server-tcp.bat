@echo off
REM run-server-tcp.bat - starts the shard with BOTH transports listening:
REM   - WebSocket on UO_PORT  (default 2593, path /game)  - browser client
REM   - Raw TCP    on UO_TCP_PORT (default 2594)          - real UO clients
REM
REM Use this when you want to plug ClassicUO desktop, Razor, OSI, or any
REM other native UO client into our server. The same world / scripts /
REM accounts back both ports - just different transports. Browser client
REM keeps connecting to the WS port unchanged.
REM
REM Override ports per-call:
REM   set "UO_PORT=2593"        WebSocket port
REM   set "UO_TCP_PORT=2594"    raw TCP port (set "" to disable)
REM   set "UO_HOST=0.0.0.0"     bind interface (LAN visibility)
REM   call tools\run-server-tcp.bat
REM
REM ClassicUO settings.json snippet to point at this server:
REM   "Last": "127.0.0.1"
REM   "LastServerNum": 1
REM   "IP": "127.0.0.1", "Port": 2594
REM
REM Leave this window open. Press Ctrl+C to stop.

setlocal
chcp 65001 >NUL 2>&1
cd /d "%~dp0..\..\"

if "%UO_PORT%"=="" set "UO_PORT=2593"
if "%UO_TCP_PORT%"=="" set "UO_TCP_PORT=2594"
if "%UO_HOST%"=="" set "UO_HOST=0.0.0.0"

echo [server] WebSocket on %UO_HOST%:%UO_PORT% (path /game)  - browser client
echo [server] Raw TCP    on %UO_HOST%:%UO_TCP_PORT%          - native UO clients (CUO/Razor/OSI)
echo [server] press Ctrl+C to stop.
echo.
call pnpm --filter @uo/server dev
endlocal
