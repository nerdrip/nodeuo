@echo off
REM run-server-admin.bat - starts the shard with the WEB ADMIN PANEL enabled.
REM
REM The admin panel is a single-page UI on http://127.0.0.1:2596/ that lets
REM you browse accounts, characters, items, spawners, edit gameplay scripts
REM live, force a save, broadcast messages, kick players, etc. Mutations are
REM gated by Basic auth against UO_ADMIN_USER (default "admin") and
REM UO_ADMIN_PASS (no default - this bat sets one).
REM
REM Override before calling:
REM   set "UO_ADMIN_PASS=secret"     change the password (recommended)
REM   set "UO_ADMIN_USER=admin"      change the username
REM   set "UO_ADMIN_HOST=0.0.0.0"    bind to LAN (default 127.0.0.1, local-only)
REM   set "UO_ADMIN_PORT=2596"       change the panel port
REM
REM Same WS / TCP listeners as run-server-tcp.bat - browser AND native UO
REM clients can play while you administer.

setlocal
chcp 65001 >NUL 2>&1
cd /d "%~dp0..\..\"

if "%UO_PORT%"=="" set "UO_PORT=2593"
if "%UO_TCP_PORT%"=="" set "UO_TCP_PORT=2594"
if "%UO_HOST%"=="" set "UO_HOST=0.0.0.0"
if "%UO_ADMIN_PASS%"=="" set "UO_ADMIN_PASS=admin"
if "%UO_ADMIN_USER%"=="" set "UO_ADMIN_USER=admin"
if "%UO_ADMIN_HOST%"=="" set "UO_ADMIN_HOST=127.0.0.1"
if "%UO_ADMIN_PORT%"=="" set "UO_ADMIN_PORT=2596"

echo [server] WebSocket on %UO_HOST%:%UO_PORT%      (browser client)
echo [server] Raw TCP    on %UO_HOST%:%UO_TCP_PORT% (CUO/Razor/OSI)
echo [admin ] Panel      on http://%UO_ADMIN_HOST%:%UO_ADMIN_PORT%/  user=%UO_ADMIN_USER% pass=%UO_ADMIN_PASS%
echo [admin ] CHANGE THE PASSWORD before exposing this port to LAN!
echo [server] press Ctrl+C to stop.
echo.
call pnpm --filter @uo/server dev
endlocal
