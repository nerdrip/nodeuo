@echo off
REM run-control-panel.bat - launch the Electron desktop launcher.
REM
REM First time only: bootstrap pnpm via corepack and install just enough
REM for @uo/control-panel (Electron is ~250 MB, takes ~1 min). Full
REM workspace install/update can then be run from the Control Panel's
REM DEPS buttons.
REM
REM Closes every running child process when the launcher window closes.

setlocal
chcp 65001 >NUL 2>&1
cd /d "%~dp0.."

where node >NUL 2>&1
if errorlevel 1 (
  echo [control-panel] FAILED: node.exe not found in PATH.
  echo Install Node.js 20.11+ and reopen this window.
  pause
  exit /b 1
)

where pnpm >NUL 2>&1
if errorlevel 1 (
  echo [control-panel] pnpm not found - enabling via corepack...
  where corepack >NUL 2>&1
  if errorlevel 1 (
    echo [control-panel] FAILED: corepack not found. Install pnpm manually: npm i -g pnpm
    pause
    exit /b 1
  )
  call corepack enable
  if errorlevel 1 (
    echo [control-panel] FAILED: corepack enable failed. Install pnpm manually: npm i -g pnpm
    pause
    exit /b 1
  )
)

where pnpm >NUL 2>&1
if errorlevel 1 (
  echo [control-panel] pnpm still not visible after corepack enable.
  echo Try closing this terminal and running tools\run-control-panel.bat again.
  pause
  exit /b 1
)

if not exist "apps\control-panel\node_modules\electron" (
  echo [control-panel] first-time setup - installing Control Panel dependencies...
  call pnpm --filter @uo/control-panel... install
  if errorlevel 1 (
    echo [control-panel] filtered install failed - falling back to full pnpm install...
    call pnpm install
    if errorlevel 1 (
      echo [control-panel] pnpm install failed.
      pause
      exit /b 1
    )
  )
)

echo [control-panel] launching Electron window...
call pnpm --filter @uo/control-panel start
endlocal
