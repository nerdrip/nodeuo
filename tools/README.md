# Tools And Launchers

This directory contains the local development launchers and utility scripts for
the UO-Node workspace.

## Directory Layout

```text
tools/
  run-control-panel.bat   Windows Electron launcher
  run-control-panel.sh    Linux/macOS Electron launcher
  bats/                   Windows cmd launchers
  sh/                     Linux/macOS POSIX shell launchers
  audit/                  ServUO parity and coverage audit tools
  extractors/             ServUO data extraction helpers
```

## Windows Launchers

| Script | Purpose |
| --- | --- |
| `tools\bats\install.bat` | install pnpm workspace dependencies |
| `tools\bats\extract-assets.bat [steps]` | extract UO assets into `apps/client/public/assets` |
| `tools\bats\run-server.bat` | server WebSocket on `/game` |
| `tools\bats\run-server-tcp.bat` | server WebSocket plus raw TCP for ClassicUO/Razor |
| `tools\bats\run-server-admin.bat` | server plus TCP plus admin panel |
| `tools\bats\run-client.bat` | browser client Vite dev server |
| `tools\bats\run-all.bat` | server+admin and browser client |
| `tools\bats\run-bridge.bat [host:port]` | WebSocket-to-TCP bridge with debug logs |
| `tools\bats\run-bridge-quiet.bat [host:port]` | bridge without packet debug logs |
| `tools\bats\run-client-bridge.bat [host:port]` | bridge plus browser client |
| `tools\bats\build-client.bat` | production client build |
| `tools\bats\test.bat` | workspace test helper |

## Linux/macOS Launchers

Run them from the repository root or directly by path:

```bash
chmod +x tools/run-control-panel.sh tools/sh/*.sh
tools/sh/install.sh
tools/sh/extract-assets.sh
tools/sh/run-server.sh
tools/sh/run-client.sh
```

| Script | Purpose |
| --- | --- |
| `tools/sh/install.sh` | install pnpm workspace dependencies |
| `tools/sh/extract-assets.sh [steps]` | extract UO assets into `apps/client/public/assets` |
| `tools/sh/run-server.sh` | server WebSocket on `/game` |
| `tools/sh/run-server-tcp.sh` | server WebSocket plus raw TCP |
| `tools/sh/run-server-admin.sh` | server plus TCP plus admin panel |
| `tools/sh/run-client.sh` | browser client Vite dev server |
| `tools/sh/run-all.sh` | server+admin and browser client in one terminal session |
| `tools/sh/run-bridge.sh [host:port]` | WebSocket-to-TCP bridge with debug logs |
| `tools/sh/run-bridge-quiet.sh [host:port]` | bridge without packet debug logs |
| `tools/sh/run-client-bridge.sh [host:port]` | bridge plus browser client |
| `tools/sh/build-client.sh` | production client build |
| `tools/sh/test.sh` | workspace test helper |

The shell launchers share `tools/sh/_common.sh`, which resolves the repository
root, checks Node/pnpm, and supplies a few default paths.

## Control Panel

`tools/run-control-panel.bat` and `tools/run-control-panel.sh` start the
Electron control panel. It provides buttons for:

- server
- browser client
- bridge
- asset extraction
- KTX2 conversion tool checks/install
- project dependency install/update

The panel streams service logs into tabs and stops spawned child processes when
the window closes.

## Asset Extraction

The repository does not include UO client assets. Set `UO_SRC` to your local
Ultima Online Classic install and run extraction:

```bash
UO_SRC="/path/to/Ultima Online Classic" tools/sh/extract-assets.sh
```

```powershell
set "UO_SRC=C:\Program Files (x86)\Electronic Arts\Ultima Online Classic"
tools\bats\extract-assets.bat
```

The optional positional argument is a comma-separated subset:

```bash
tools/sh/extract-assets.sh anim
tools/sh/extract-assets.sh multi,music
```

Supported steps include:

```text
hues,tiledata,art,texmaps,gumps,cursors,radarcol,map,statics,cliloc,
sounds,anim,music,multi,animdata,housedata,lights,verdata,professions,
speeches,multimap,unifont
```

## Runtime Ports

| Service | Default |
| --- | --- |
| Browser client Vite | `http://localhost:5173` |
| Server WebSocket | `ws://127.0.0.1:2593/game` |
| Raw TCP listener | `127.0.0.1:2594` |
| Bridge WebSocket | `ws://127.0.0.1:2595/bridge` |
| Admin panel | `http://127.0.0.1:2596/` |

## Environment Variables

| Variable | Used by | Default |
| --- | --- | --- |
| `UO_SRC` | asset extraction | platform-specific guess |
| `UO_HOST` | server bind host | `0.0.0.0` |
| `UO_PORT` | server WebSocket port | `2593` |
| `UO_TCP_PORT` | raw TCP listener | unset except TCP launchers, then `2594` |
| `UO_ADMIN_HOST` | admin bind host | `127.0.0.1` |
| `UO_ADMIN_PORT` | admin port | `2596` |
| `UO_ADMIN_USER` | admin auth | `admin` |
| `UO_ADMIN_PASS` | admin auth | set by admin launchers, change for real use |
| `UO_BRIDGE_PORT` | bridge WebSocket port | `2595` |
| `UO_BRIDGE_DEFAULT` | locked bridge target | empty |
| `KTX2_TOKTX` | optional `toktx` path | auto-detected |

## Bridge Modes

The bridge lets the browser client connect to an external raw-TCP shard:

```text
browser client -> ws://localhost:2595/bridge -> external host:port
```

Use:

```bash
tools/sh/run-client-bridge.sh my.shard.example:2593
```

or:

```powershell
tools\bats\run-client-bridge.bat my.shard.example:2593
```

## KTX2

PNG assets are the canonical fallback. KTX2/Basis is optional and improves GPU
upload/VRAM behavior for large atlases.

```bash
pnpm extract:ktx2:tool:check
pnpm extract:ktx2:tool:install
pnpm extract:ktx2
```

More details: [packages/extractor/ktx2-readme.md](../packages/extractor/ktx2-readme.md).
