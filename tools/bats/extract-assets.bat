@echo off
REM extract-assets.bat - converts every UO MUL/UOP we support into PNG
REM atlases + JSON manifests + raw binaries under apps\client\public\assets\.
REM
REM Usage:
REM   extract-assets.bat                   - full extract (every step)
REM   extract-assets.bat <step>[,<step>]   - extract only listed step(s)
REM
REM Available steps (any order, comma-separated):
REM   hues tiledata art texmaps gumps cursors radarcol map statics cliloc
REM   sounds anim music multi animdata housedata
REM
REM Examples:
REM   extract-assets.bat anim              - re-extract only the mobile atlas
REM   extract-assets.bat multi,music       - just multis + music
REM   extract-assets.bat                   - everything (45-60s on a fresh box)
REM
REM Override source dir per-call:
REM   set "UO_SRC=C:\Path\To\Ultima Online Classic"
REM   extract-assets.bat
REM
REM Steps run by default:
REM   hues, tiledata, art, texmaps, gumps, cursors, radarcol, map, statics,
REM   cliloc, sounds, anim, music, multi, animdata, housedata

setlocal
chcp 65001 >NUL 2>&1
cd /d "%~dp0..\..\"

REM --- Sanity checks ------------------------------------------------------
where node >NUL 2>&1
if errorlevel 1 (
  echo.
  echo [extract] FAILED: node.exe not found in PATH.
  echo Install Node.js 20.11+ from https://nodejs.org and reopen this window.
  echo.
  pause
  exit /b 1
)

if not exist "packages\extractor\extract.js" (
  echo.
  echo [extract] FAILED: packages\extractor\extract.js missing under %CD%
  echo Run from inside the UltimaOnline repository root.
  echo.
  pause
  exit /b 1
)

if "%UO_SRC%"=="" (
  set "UO_SRC=D:\Games\Electronic Arts\Ultima Online Classic"
)
if not exist "%UO_SRC%" (
  echo.
  echo [extract] Ultima Online install not found at:
  echo     %UO_SRC%
  echo.
  echo Set UO_SRC to the folder that contains art.mul / map0.mul / hues.mul / ...
  echo Example:
  echo     set "UO_SRC=C:\Program Files (x86)\Electronic Arts\Ultima Online Classic"
  echo     tools\extract-assets.bat
  echo.
  pause
  exit /b 1
)

set "UO_OUT=%CD%\apps\client\public\assets"
REM First positional arg = subset (e.g. "anim" or "anim,multi"). Falls back
REM to the env-var override (UO_ONLY) and finally the full default list.
set "UO_SUBSET=%~1"
if not "%UO_SUBSET%"=="" set "UO_ONLY=%UO_SUBSET%"
if "%UO_ONLY%"=="" (
  set "UO_ONLY=hues,tiledata,art,texmaps,gumps,cursors,radarcol,map,statics,cliloc,sounds,anim,music,multi,animdata,housedata"
)

if not exist "%UO_OUT%" mkdir "%UO_OUT%"

echo [extract] node:
node --version
echo [extract] cwd:   %CD%
echo [extract] src:   %UO_SRC%
echo [extract] out:   %UO_OUT%
echo [extract] only:  %UO_ONLY%
echo [extract] (full extract takes ~45-60s the first time; some steps print
echo            nothing until they finish - be patient on art / gumps / sounds)
echo.

node packages\extractor\extract.js --src "%UO_SRC%" --out "%UO_OUT%" --only %UO_ONLY%
REM `if errorlevel N` is the canonical way to check exit codes in cmd
REM batch files - it returns true when ERRORLEVEL >= N.
if errorlevel 1 (
  echo.
  echo [extract] FAILED - see the log above.
  echo.
  pause
  exit /b 1
)

echo.
echo [extract] OK. Assets are in %UO_OUT%
echo.
pause
endlocal
