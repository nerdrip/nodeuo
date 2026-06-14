#!/usr/bin/env sh
SCRIPT_NAME=server-admin
. "$(dirname -- "$0")/_common.sh"

load_node_pnpm

export UO_PORT=${UO_PORT:-2593}
export UO_TCP_PORT=${UO_TCP_PORT:-2594}
export UO_HOST=${UO_HOST:-0.0.0.0}
export UO_ADMIN_HOST=${UO_ADMIN_HOST:-127.0.0.1}
export UO_ADMIN_PORT=${UO_ADMIN_PORT:-2596}
export UO_ADMIN_USER=${UO_ADMIN_USER:-admin}
export UO_ADMIN_PASS=${UO_ADMIN_PASS:-admin}

echo "[server] WebSocket: ws://$UO_HOST:$UO_PORT/game"
echo "[server] Raw TCP:   $UO_HOST:$UO_TCP_PORT"
echo "[admin ] Panel:     http://$UO_ADMIN_HOST:$UO_ADMIN_PORT/ user=$UO_ADMIN_USER pass=$UO_ADMIN_PASS"
echo "[admin ] change UO_ADMIN_PASS before exposing this outside localhost"
pnpm --filter @uo/server dev
