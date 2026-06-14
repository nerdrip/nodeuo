#!/usr/bin/env sh
SCRIPT_NAME=client
. "$(dirname -- "$0")/_common.sh"

load_node_pnpm

echo "[client] Vite dev server: http://localhost:5173"
echo "[client] default game socket: ws://127.0.0.1:2593/game"
pnpm --filter @uo/client dev
