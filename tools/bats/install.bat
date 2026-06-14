@echo off
REM install.bat - one-time dependency install for the whole monorepo.
REM Requires: Node.js 20.11+ and pnpm. If pnpm is missing, we install it via corepack.

setlocal
chcp 65001 >NUL 2>&1
cd /d "%~dp0..\..\"

where pnpm >NUL 2>&1
if errorlevel 1 (
  echo [install] pnpm not found - enabling via corepack...
  call corepack enable
  if errorlevel 1 (
    echo.
    echo [install] corepack failed. Install pnpm manually: npm i -g pnpm
    pause
    exit /b 1
  )
)

echo [install] running: pnpm install
call pnpm install
if errorlevel 1 (
  echo.
  echo [install] pnpm install FAILED
  pause
  exit /b 1
)

echo.
echo [install] OK. Next steps:
echo   1. tools\extract-assets.bat   (once - extracts every UO class, ~45-60s)
echo                                  Re-run subsets:
echo                                    tools\extract-anim.bat   (mobile sprites)
echo                                    tools\extract-music.bat  (mp3s + index)
echo                                    tools\extract-multi.bat  (house templates)
echo   2. tools\run-server.bat       (leave open)
echo   3. tools\run-client.bat       (in a second terminal)
echo   4. open http://localhost:5173 in the browser
echo.
echo Or one-shot:  tools\run-all.bat
echo.
pause
endlocal
