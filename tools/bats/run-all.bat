@echo off
REM run-all.bat - one-shot launcher: ensures assets are extracted, then opens
REM server (with admin panel + TCP listener) + browser client in two windows.
REM
REM What you get:
REM   - WS  on 127.0.0.1:2593 (browser client)
REM   - TCP on 127.0.0.1:2594 (CUO/Razor/OSI desktop clients)
REM   - Admin panel on http://127.0.0.1:2596/  user=admin pass=admin
REM   - Vite dev server on http://localhost:5173 (our browser client)
REM
REM Override env vars before calling for non-default ports / passwords.

setlocal
chcp 65001 >NUL 2>&1
cd /d "%~dp0..\..\"

REM First-run check: if there's no land-atlas yet, extract everything.
if not exist "%CD%\apps\client\public\assets\land-atlas.json" (
  echo [run-all] no extracted assets found - running tools\bats\extract-assets.bat
  call "%~dp0extract-assets.bat"
  if errorlevel 1 (
    echo [run-all] extract-assets failed.
    pause
    exit /b 1
  )
)

start "UO Server (WS+TCP+Admin)" cmd /k "%~dp0run-server-admin.bat"
timeout /t 2 >NUL
start "UO Client (Vite)" cmd /k "%~dp0run-client.bat"

echo.
echo Three terminals launched:
echo   - server  (WebSocket 2593, raw TCP 2594, admin http://localhost:2596/)
echo   - client  (Vite dev http://localhost:5173)
echo.
echo Admin login: admin / admin    -- change UO_ADMIN_PASS before LAN expose!
endlocal
