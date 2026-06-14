#!/usr/bin/env sh
SCRIPT_NAME=install
. "$(dirname -- "$0")/_common.sh"

need_cmd node
if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  corepack enable
fi
need_cmd pnpm

echo "[install] installing workspace dependencies"
pnpm install
