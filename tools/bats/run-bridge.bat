@echo off
REM run-bridge.bat - starts the WS-to-TCP bridge in DEBUG mode so the browser
REM client can connect to a raw-TCP UO shard (ServUO, RunUO, OSI). Wire format
REM is identical (Huffman frames pass through), only transport differs.
REM
REM Usage:
REM   run-bridge.bat                       - open relay (any ?target=... ok)
REM   run-bridge.bat 127.0.0.1:2593        - lock the bridge to that target
REM   run-bridge.bat my.shard.tld:2593     - lock to a remote shard
REM
REM Defaults: listens on ws://127.0.0.1:2595/bridge?target=HOST:PORT
REM Override target / allowlist via env vars BEFORE calling this script:
REM   set UO_BRIDGE_DEFAULT=127.0.0.1:2593
REM   set UO_BRIDGE_ALLOW=127.0.0.1:2593,uoshard.example:2593
REM   call tools\run-bridge.bat
REM
REM Debug mode dumps the first 64 bytes of each decompressed server-to-client
REM chunk and every ws-to-tcp packet - used to diagnose framing drift. For a
REM quiet run (no per-packet logs) use tools\run-bridge-quiet.bat.

setlocal
cd /d "%~dp0..\..\"

set "BRIDGE_TARGET=%~1"
if not "%BRIDGE_TARGET%"=="" (
  set "UO_BRIDGE_DEFAULT=%BRIDGE_TARGET%"
  echo [bridge] locked to target: %BRIDGE_TARGET%
)

echo [bridge] starting WS-TCP proxy on ws://127.0.0.1:2595/bridge  (debug=on)
if "%BRIDGE_TARGET%"=="" (
  echo [bridge] in client login pick "TCP via bridge", set target = ServUO host:port
) else (
  echo [bridge] client can connect with NO ?target= - bridge auto-routes to %BRIDGE_TARGET%
)
echo [bridge] press Ctrl+C to stop.
echo.
call pnpm --filter @uo/bridge start:debug
endlocal
