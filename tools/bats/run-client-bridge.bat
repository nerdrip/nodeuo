@echo off
REM run-client-bridge.bat - launch the browser client + WS-to-TCP bridge so
REM our client connects to ANY raw-TCP UO shard (ServUO / RunUO / OSI /
REM stand-alone classic shards). Two terminals open: bridge and Vite dev.
REM
REM Usage:
REM   run-client-bridge.bat                          - open form, pick target manually
REM   run-client-bridge.bat 127.0.0.1:2593           - lock bridge to that target
REM   run-client-bridge.bat my.shard.tld:2593        - lock to a remote shard
REM
REM After both windows are up:
REM   1. open  http://localhost:5173
REM   2. in the login card pick "TCP via bridge (ServUO/OSI)"
REM   3. Bridge WS URL: ws://127.0.0.1:2595/bridge   (default - leave as-is)
REM   4. TCP target:    HOST:PORT (or pre-filled if you passed it as arg)
REM   5. enter account / password, hit Play
REM
REM Settings persist in localStorage so subsequent runs prefill the form.
REM
REM Bridge runs with --debug so its window shows hex dumps of every chunk on
REM the wire - invaluable when the client reports "unknown opcode" errors.
REM Switch the bridge invocation to `start` (without :debug) once stable.

setlocal
set "ROOT=%~dp0.."
set "BRIDGE_TARGET=%~1"

REM Locking the bridge to a single target (UO_BRIDGE_DEFAULT) makes the
REM browser side just open ws://.../bridge with no ?target= query - useful
REM when distributing the client to other people who shouldn't have to know
REM your shard's host:port.
if not "%BRIDGE_TARGET%"=="" (
  set "UO_BRIDGE_DEFAULT=%BRIDGE_TARGET%"
  echo [bridge] locked to target: %BRIDGE_TARGET%
)

REM `start /D` sets the working directory of the new console BEFORE cmd /k
REM runs - without it the new window inherits its parent's CWD (typically
REM system32 when launched from Explorer / Windows Terminal) and any relative
REM lookup fails silently, leaving a black empty terminal.
start "UO Bridge" /D "%ROOT%" cmd /k "set UO_BRIDGE_DEFAULT=%BRIDGE_TARGET%&& pnpm --filter @uo/bridge start:debug"
timeout /t 2 >NUL
start "UO Client" /D "%ROOT%" cmd /k pnpm --filter @uo/client dev

echo.
echo Two terminals launched (bridge + client).
echo Wait a few seconds, then open:  http://localhost:5173
echo Pick "TCP via bridge" in the login card.
if not "%BRIDGE_TARGET%"=="" echo Bridge will route to: %BRIDGE_TARGET%
endlocal
