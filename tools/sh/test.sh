#!/usr/bin/env sh
SCRIPT_NAME=test
. "$(dirname -- "$0")/_common.sh"

load_node_pnpm

echo "[test] running workspace tests"
pnpm -w test

echo "[test] running client gump smoke"
node apps/client/test-gump.mjs
