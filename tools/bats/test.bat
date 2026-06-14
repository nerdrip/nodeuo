@echo off
REM test.bat - runs the full vitest suite across the workspace,
REM then the standalone client smoke tests (login flow + gump round-trip).
REM
REM The smoke tests need a running server (run-server.bat) - the script
REM starts one in the background, runs the tests, then kills it.

setlocal
chcp 65001 >NUL 2>&1
cd /d "%~dp0..\..\"

echo [test] running vitest...
call pnpm -w test
if errorlevel 1 (
  echo.
  echo [test] vitest FAILED
  pause
  exit /b 1
)

echo.
echo [test] gump round-trip smoke (no server needed)...
call node apps\client\test-gump.mjs
if errorlevel 1 (
  echo [test] gump smoke FAILED
  pause
  exit /b 1
)

echo.
echo [test] OK.
echo (For the live login + movement smokes, start the server first via
echo  tools\run-server.bat then run:
echo    node apps\client\test-login.mjs
echo    node apps\client\test-movement.mjs)
echo.
pause
endlocal
