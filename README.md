# Ultima Online Node

Node/Web implementation of an Ultima Online shard and browser client. The
project started as a functional migration from ServUO and ClassicUO patterns,
but the goal is an independent codebase: compatible with the UO protocol where
that is useful, and designed for Node.js, WebSocket, PixiJS, and modern browser
rendering.

This repository does not include game files. You generate runtime assets
locally from your own legal Ultima Online Classic installation.

## Public Repository Status

This project is prepared for public source distribution.

- Project code is licensed as `AGPL-3.0-or-later`.
- Modified versions that are distributed or offered as a network service must
  make the corresponding source code available to the community under the same
  license terms.
- The repository must not contain Ultima Online client files, generated assets,
  world saves, accounts, passwords, shard secrets, or private player data.
- Contribution rules are documented in `CONTRIBUTING.md`.
- The full license text is in `LICENSE`.

## What Is In This Repository

| Area | Technology | Role |
| --- | --- | --- |
| Server | Node.js, ESM, `ws` | Shard runtime, world state, accounts, persistence, scripts, gameplay systems |
| Client | Vite, PixiJS v8, WebGL | Browser UO client for the project WebSocket flow and bridge flow |
| Scripts | JavaScript ESM + Script API | Commands, items, mobiles, NPCs, AI, skills, spells, quests, spawns |
| Extractor | Node.js + `sharp` | MUL/UOP to PNG/JSON/bin assets, optional KTX2/Basis output |
| Control Panel | Electron | Start/stop server, client, bridge, extractor, tools, and logs |
| Bridge | Node.js TCP/WebSocket | Browser client to raw TCP ServUO/RunUO/OSI-style shard |

## Current Direction

The priority is functional coverage against ServUO and ClassicUO behavior
without copying their architecture one-to-one. Reference projects are used for
parity, protocol behavior, and bug fixing; the runtime design should stay
native to this repository.

Main rules:

- `apps/server` owns the engine and world indexes.
- `apps/scripts` owns gameplay content.
- Scripts should use high-level `api.game`, `api.lifecycle`, `api.systems`,
  `_inventory`, `_movement`, `_spatial`, and registry helpers.
- The client preserves UO behavior, but rendering, cache, UI, and the asset
  pipeline are built for the web.
- PNG assets are always the fallback path. `.ktx2` is an optional faster path
  for VRAM/decode if you generate it with `toktx`.
- `templates/` is reference material for audits and bug fixes, not runtime
  code.

## Repository Layout

```text
apps/
  client/         Vite + PixiJS browser client
  server/         shard, world engine, net handlers, persistence, systems
  scripts/        gameplay content and server scripting API consumers
  bridge/         WebSocket <-> raw TCP bridge for external shards
  control-panel/  Electron launcher with logs and tool buttons

packages/
  protocol/       UO binary protocol, packets, Huffman/shared helpers
  extractor/      asset pipeline: MUL/UOP -> client assets

tools/
  run-control-panel.bat  main Windows GUI launcher
  run-control-panel.sh   main Linux/macOS GUI launcher
  bats/                  Windows command launchers
  sh/                    Linux/macOS command launchers
  audit/                 ServUO/ClassicUO audits and coverage maps

docs/
  README.md              documentation index
  server-scripting.md    guide for the current server Script API

templates/
  ClassicUO/ServUO reference code, for comparison only

saves/
  local world/account saves
```

## Requirements

- Node.js `>=20.11`
- pnpm `9.12.0` through Corepack or a global install
- Windows `.bat` launchers or Linux/macOS `.sh` launchers
- A local Ultima Online Classic installation for asset extraction
- Optional Khronos KTX-Software (`toktx`) for `.ktx2` generation

Basic check:

```powershell
node -v
corepack enable
pnpm -v
```

## Quick Start

Recommended Windows path:

```powershell
tools\run-control-panel.bat
```

Recommended Linux/macOS path:

```bash
chmod +x tools/run-control-panel.sh tools/sh/*.sh
tools/run-control-panel.sh
```

The Control Panel can:

- install the dependencies needed to start the Electron launcher;
- start the server, browser client, bridge, admin panel, and extractor;
- run project install/update actions;
- check and install KTX2/`toktx` tooling;
- stream service logs in one window.

Terminal path for Linux/macOS:

```bash
pnpm install
UO_SRC="/path/to/Ultima Online Classic" tools/sh/extract-assets.sh
tools/sh/run-server.sh
tools/sh/run-client.sh
```

Terminal path for Windows:

```powershell
pnpm install
$env:UO_SRC="C:\Program Files (x86)\Electronic Arts\Ultima Online Classic"
tools\bats\extract-assets.bat
tools\bats\run-server.bat
tools\bats\run-client.bat
```

The development client normally runs at:

```text
http://localhost:5173
```

The project WebSocket server normally runs at:

```text
ws://127.0.0.1:2593/game
```

## Asset Pipeline

A full extraction creates:

```text
apps/client/public/assets/
```

That directory contains art/gump/anim/static atlases, map chunks, statics,
tiledata, hues, multi data, lights, fonts, cliloc, and manifests.

Common commands:

```powershell
pnpm extract
pnpm extract:ktx2:tool:check
pnpm extract:ktx2:tool:install
pnpm extract:ktx2
```

`pnpm extract` generates PNG/JSON/bin fallback assets. `pnpm extract:ktx2`
converts existing PNG atlases to `.ktx2` when `toktx` is available. The client
tries KTX2 where present and falls back to PNG when the parser or file is not
available.

KTX2 is mainly useful for large texture atlases: smaller transfer, lower VRAM
use, and faster GPU upload after transcoding. PNG remains the required fallback
and the easiest format for debugging.

## Runtime Modes

| Scenario | Windows | Linux/macOS |
| --- | --- | --- |
| GUI launcher | `tools\run-control-panel.bat` | `tools/run-control-panel.sh` |
| Browser client + project server | `tools\bats\run-all.bat` | `tools/sh/run-all.sh` |
| WebSocket server only | `tools\bats\run-server.bat` | `tools/sh/run-server.sh` |
| WebSocket server + raw TCP for ClassicUO | `tools\bats\run-server-tcp.bat` | `tools/sh/run-server-tcp.sh` |
| WebSocket server + TCP + admin panel | `tools\bats\run-server-admin.bat` | `tools/sh/run-server-admin.sh` |
| Vite client only | `tools\bats\run-client.bat` | `tools/sh/run-client.sh` |
| Browser client through bridge to an external shard | `tools\bats\run-client-bridge.bat host:port` | `tools/sh/run-client-bridge.sh host:port` |
| Bridge only | `tools\bats\run-bridge.bat host:port` | `tools/sh/run-bridge.sh host:port` |

Default ports:

| Service | Port |
| --- | --- |
| Browser client Vite | `5173` |
| Project WebSocket server | `2593` |
| Raw TCP listener | `2594` |
| Bridge | `2595` |
| Admin panel | `2596` |

## Important PNPM Commands

| Command | Purpose |
| --- | --- |
| `pnpm install` | install monorepo dependencies |
| `pnpm server` | start the server with `node --watch` |
| `pnpm client` | start the Vite dev server |
| `pnpm build` | build workspaces that define a build script |
| `pnpm test` | run workspace tests |
| `pnpm lint` | run ESLint for the repository |
| `pnpm extract` | extract assets from UO MUL/UOP files |
| `pnpm extract:ktx2` | generate `.ktx2` files next to PNG atlases |
| `pnpm client:perf-smoke` | run the client performance smoke test |
| `pnpm client:profile` | capture a client profile |
| `pnpm audit:servuo` | audit server functionality against ServUO |
| `pnpm audit:servuo:map:check` | check the ServUO coverage map |

## Server

`apps/server` is the runtime engine:

- accounts, sessions, and login;
- WebSocket and optional raw TCP listener;
- UO binary packets and protocol compatibility;
- world state: mobiles, items, sectors, parent/child indexes, persistence;
- movement, visibility, update ranges, pathfinding, and standing Z;
- combat, notoriety, poison, regen, party, guild, chat, corpses;
- systems dispatch: spells, crafting, housing, pets, PvP, rewards, bosses,
  quests, economy, events;
- admin panel and diagnostics.

Architectural rule: the engine should not contain concrete game content when
that content can live in `apps/scripts`. The engine exposes APIs, indexes, and
safe operations; scripts register content and behavior.

## Server Scripts

`apps/scripts/src` is the gameplay layer:

- player and admin commands;
- item definitions and item lifecycle scripts;
- NPC/mobile templates, vendors, and AI;
- skills, spells, crafting, loot tables;
- quests, regions, spawns, and events;
- JSON data in `apps/scripts/src/data`.

The canonical guide for the current API is:

```text
docs/server-scripting.md
```

The old pattern of scanning `world.items` or `world.mobiles` directly is an
exception. New code should use:

- `api.game` for gameplay operations and indexed reads;
- `api.lifecycle` for hot-reload-safe commands, events, and timers;
- `api.systems` for engine domains;
- `_inventory.js`, `_movement.js`, `_spatial.js`, and `_entities.js`;
- declarative `defineScript()` for simple modules.

## Client

`apps/client` is a web implementation of the UO client:

- Vite + PixiJS v8;
- isometric WebGL renderer;
- map streaming and chunk cache;
- PNG atlases with optional KTX2/Basis;
- mobile/static animations, gumps, paperdoll, journal, macro/hotkey flow;
- dynamic lights from world and equipment;
- roof/ceiling autohide for buildings;
- UI that follows ClassicUO behavior while using DOM/WebGL-friendly patterns;
- smoke tests for protocol, UI, rendering, pathfinder, asset cache, lights,
  gumps, animation, and performance budgets.

Useful checks after renderer changes:

```powershell
pnpm --filter @uo/client run smoke:roof
pnpm --filter @uo/client run smoke:light
pnpm --filter @uo/client build
```

Full client smoke:

```powershell
pnpm --filter @uo/client run smoke
```

## Bridge And Compatibility

The project supports three practical configurations:

```text
browser client -> project WebSocket server
ClassicUO/Razor -> project raw TCP server
browser client -> WebSocket bridge -> external ServUO/RunUO raw TCP shard
```

This lets the browser client evolve without abandoning protocol compatibility,
and it lets the server be tested with native clients.

## Data And Saves

Local saves live in:

```text
saves/world.json
saves/accounts.json
```

Locally generated assets live in:

```text
apps/client/public/assets/
```

These paths are environment data. Do not treat them as source-of-truth review
material unless you are intentionally testing persistence migration or the
asset pipeline.

## Documentation

| Document | Role |
| --- | --- |
| `QUICKSTART.md` | short setup and launch guide |
| `CONTRIBUTING.md` | contribution, testing, and licensing rules |
| `LICENSE` | full AGPL license text |
| `CODE_OF_CONDUCT.md` | behavior rules for the public project |
| `docs/README.md` | repository documentation index |
| `docs/server-scripting.md` | current server scripting rules |
| `tools/README.md` | launchers, Control Panel, bridge, and environment variables |
| `apps/server/src/content/ARCHITECTURE.md` | engine vs scripts split |
| `apps/server/src/systems/README.md` | systems layer overview |

## Development Workflow

Before a larger change:

```powershell
git status --short
pnpm test
```

After server changes:

```powershell
pnpm --filter @uo/server test
```

After client changes:

```powershell
pnpm --filter @uo/client build
pnpm --filter @uo/client run smoke:client-perf
```

After script changes:

```powershell
pnpm --filter @uo/server test
pnpm audit:servuo:map:check
```

After asset pipeline changes:

```powershell
pnpm extract:ktx2:tool:check
pnpm --filter @uo/extractor run ktx2:dry-run
```

## Contributions

Before opening a pull request:

- read `CONTRIBUTING.md`;
- explain what changed and why;
- include tests or manual verification;
- keep refactors, features, and data changes separate where practical;
- do not add generated assets, world saves, or private data;
- make sure the contribution can be licensed as `AGPL-3.0-or-later`.

## Coding Rules

- Do not migrate scripts back to the old raw runtime API.
- Do not scan `world.items` or `world.mobiles` in hot paths when an indexed
  facade exists.
- Do not assign `item.parent` or `mob.x/y/z/map` directly from gameplay code;
  use `api.game.item.move`, `api.game.mobile.move`, or
  `api.game.mobile.teleport`.
- Script registrations should be hot-reload-safe through `api.lifecycle`.
- The client should preserve UO behavior, but implementation can be web-native:
  batching, caches, atlases, lazy loading, dirty regions, and fixed-row virtual
  lists are preferred.
- `templates/` is for audits, comparisons, and bug fixing; it is not runtime
  code.

## License And Legal Notes

Project code is licensed as `AGPL-3.0-or-later`. The intent is simple: you may
use, copy, host, and modify the project, but project changes should return to
the community under the same terms when distributed or offered over a network.

This repository does not distribute Ultima Online files. Asset extraction
requires your own legal copy of the UO client. Original code in this repository
is a separate implementation; for any files ported from or based on external
projects, respect the licenses noted in headers, history, and documentation.
