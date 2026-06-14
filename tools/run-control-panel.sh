#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "[control-panel] node is required" >&2
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[control-panel] pnpm is required" >&2
  exit 1
fi

if [ ! -d node_modules ] || [ ! -d apps/control-panel/node_modules/electron ]; then
  pnpm install
fi
pnpm --filter @uo/control-panel start
