# Quickstart

This is the shortest path to a local development shard. The full project
overview is in [README.md](README.md), and launcher details are in
[tools/README.md](tools/README.md).

## Requirements

- Node.js `>=20.11`
- pnpm `9.12.x` through Corepack or a global install
- A legal local installation of Ultima Online Classic if you need to extract
  client assets

```bash
node -v
corepack enable
pnpm -v
```

## Install

```bash
pnpm install
```

## Extract Assets

The repository does not ship Ultima Online art, maps, sounds, or client data.
Generate local assets from your own UO Classic install:

```bash
# Linux/macOS/Git Bash
UO_SRC="/path/to/Ultima Online Classic" tools/sh/extract-assets.sh
```

```powershell
# Windows PowerShell
$env:UO_SRC="C:\Program Files (x86)\Electronic Arts\Ultima Online Classic"
tools\bats\extract-assets.bat
```

Output goes to:

```text
apps/client/public/assets/
```

That directory is ignored by Git.

## Run

### Linux/macOS

```bash
tools/sh/run-server.sh
```

In another terminal:

```bash
tools/sh/run-client.sh
```

### Windows

```powershell
tools\bats\run-server.bat
```

In another terminal:

```powershell
tools\bats\run-client.bat
```

Open:

```text
http://localhost:5173
```

The browser client connects to:

```text
ws://127.0.0.1:2593/game
```

## One-Command Dev Launch

Linux/macOS:

```bash
tools/sh/run-all.sh
```

Windows:

```powershell
tools\bats\run-all.bat
```

`run-all` starts the server with TCP and admin enabled, then starts the browser
client. The admin panel is local-only by default:

```text
http://127.0.0.1:2596/
user: admin
pass: admin
```

Change `UO_ADMIN_PASS` before exposing the admin panel outside your machine.

## Optional: Native UO Clients

To connect ClassicUO/Razor/OSI-style clients directly to this server, start the
raw TCP listener:

```bash
tools/sh/run-server-tcp.sh
```

or:

```powershell
tools\bats\run-server-tcp.bat
```

Then point the native client at:

```text
127.0.0.1:2594
```

## Useful In-Game Commands

Commands are typed into chat with the `[` prefix.

| Command | Effect |
| --- | --- |
| `[help` | list commands |
| `[who` | online players |
| `[where` | current position and region |
| `[go 1495 1626 10` | teleport to coordinates |
| `[tele` | targeted teleport |
| `[bag` | open backpack |
| `[bank` | open bank |
| `[paperdoll` | character paperdoll |
| `[skills` | skill list |
| `[add torch` | add a torch |
| `[vendor` | spawn/test vendor |
| `[light 0` / `[light 31` | light level |
| `[daynight on` | day/night cycle |
| `[weather rain` | weather |
| `[reload` | hot-reload gameplay scripts |

## Tests

```bash
pnpm test
pnpm --filter @uo/server test
pnpm --filter @uo/client build
```

Client smoke tests are more granular and live in `apps/client/package.json`.

## Common Problems

| Problem | Check |
| --- | --- |
| Blank client screen | `apps/client/public/assets/meta.json` exists |
| Missing art/map | run asset extraction from a valid UO Classic directory |
| `toktx` missing | run `pnpm extract:ktx2:tool:install` or skip KTX2 |
| Port `5173` busy | stop old Vite process or change Vite port |
| Port `2593` busy | stop old server or set `UO_PORT` |
| ClassicUO cannot connect | use `run-server-tcp` and port `2594` |
