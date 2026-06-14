#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

cd "$REPO_ROOT"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[$SCRIPT_NAME] missing required command: $1" >&2
    exit 1
  fi
}

load_node_pnpm() {
  need_cmd node
  if ! command -v pnpm >/dev/null 2>&1; then
    if command -v corepack >/dev/null 2>&1; then
      corepack enable >/dev/null 2>&1 || true
    fi
  fi
  need_cmd pnpm
}

default_uo_src() {
  if [ -n "${UO_SRC:-}" ]; then
    printf '%s\n' "$UO_SRC"
    return
  fi
  for path in \
    "$HOME/.wine/drive_c/Program Files (x86)/Electronic Arts/Ultima Online Classic" \
    "$HOME/Games/Ultima Online Classic" \
    "$HOME/Ultima Online Classic" \
    "/opt/ultima-online-classic"
  do
    if [ -d "$path" ]; then
      printf '%s\n' "$path"
      return
    fi
  done
  printf '%s\n' "$HOME/Ultima Online Classic"
}

ensure_assets() {
  if [ ! -f "$REPO_ROOT/apps/client/public/assets/land-atlas.json" ]; then
    echo "[$SCRIPT_NAME] no extracted assets found; running extract-assets.sh"
    "$SCRIPT_DIR/extract-assets.sh"
  fi
}
