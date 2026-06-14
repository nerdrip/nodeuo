#!/usr/bin/env sh
SCRIPT_NAME=bridge
. "$(dirname -- "$0")/_common.sh"

load_node_pnpm

if [ "${1:-}" != "" ]; then
  export UO_BRIDGE_DEFAULT=$1
fi
export UO_BRIDGE_PORT=${UO_BRIDGE_PORT:-2595}

echo "[bridge] WebSocket bridge: ws://127.0.0.1:$UO_BRIDGE_PORT/bridge"
if [ -n "${UO_BRIDGE_DEFAULT:-}" ]; then
  echo "[bridge] locked target: $UO_BRIDGE_DEFAULT"
fi
pnpm --filter @uo/bridge start:debug
