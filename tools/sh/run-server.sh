#!/usr/bin/env sh
SCRIPT_NAME=server
. "$(dirname -- "$0")/_common.sh"

load_node_pnpm

export UO_PORT=${UO_PORT:-2593}
export UO_HOST=${UO_HOST:-0.0.0.0}

echo "[server] WebSocket: ws://$UO_HOST:$UO_PORT/game"
echo "[server] press Ctrl+C to stop"
pnpm --filter @uo/server dev
