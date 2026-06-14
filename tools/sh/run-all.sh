#!/usr/bin/env sh
SCRIPT_NAME=run-all
. "$(dirname -- "$0")/_common.sh"

load_node_pnpm
ensure_assets

echo "[run-all] starting server+admin and client"
"$SCRIPT_DIR/run-server-admin.sh" &
SERVER_PID=$!
sleep 2
"$SCRIPT_DIR/run-client.sh" &
CLIENT_PID=$!

cleanup() {
  kill "$SERVER_PID" "$CLIENT_PID" >/dev/null 2>&1 || true
}
trap cleanup INT TERM EXIT

echo "[run-all] server pid: $SERVER_PID"
echo "[run-all] client pid: $CLIENT_PID"
echo "[run-all] open http://localhost:5173"
wait
