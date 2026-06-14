#!/usr/bin/env sh
SCRIPT_NAME=build-client
. "$(dirname -- "$0")/_common.sh"

load_node_pnpm

echo "[build-client] building @uo/client"
pnpm --filter @uo/client build
