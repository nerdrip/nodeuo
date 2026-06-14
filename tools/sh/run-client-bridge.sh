#!/usr/bin/env sh
SCRIPT_NAME=client-bridge
. "$(dirname -- "$0")/_common.sh"

load_node_pnpm

if [ "${1:-}" != "" ]; then
  export UO_BRIDGE_DEFAULT=$1
fi

echo "[client-bridge] starting bridge and browser client"
"$SCRIPT_DIR/run-bridge.sh" "${UO_BRIDGE_DEFAULT:-}" &
BRIDGE_PID=$!
sleep 2
"$SCRIPT_DIR/run-client.sh" &
CLIENT_PID=$!

cleanup() {
  kill "$BRIDGE_PID" "$CLIENT_PID" >/dev/null 2>&1 || true
}
trap cleanup INT TERM EXIT

echo "[client-bridge] bridge pid: $BRIDGE_PID"
echo "[client-bridge] client pid: $CLIENT_PID"
echo "[client-bridge] open http://localhost:5173 and choose TCP via bridge"
wait
