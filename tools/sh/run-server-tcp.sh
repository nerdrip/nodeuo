#!/usr/bin/env sh
SCRIPT_NAME=server-tcp
. "$(dirname -- "$0")/_common.sh"

load_node_pnpm

export UO_PORT=${UO_PORT:-2593}
export UO_TCP_PORT=${UO_TCP_PORT:-2594}
export UO_HOST=${UO_HOST:-0.0.0.0}

echo "[server] WebSocket: ws://$UO_HOST:$UO_PORT/game"
echo "[server] Raw TCP:   $UO_HOST:$UO_TCP_PORT"
echo "[server] press Ctrl+C to stop"
pnpm --filter @uo/server dev
