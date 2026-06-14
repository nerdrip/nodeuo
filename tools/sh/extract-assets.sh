#!/usr/bin/env sh
SCRIPT_NAME=extract
. "$(dirname -- "$0")/_common.sh"

load_node_pnpm

UO_SRC=${UO_SRC:-$(default_uo_src)}
UO_OUT=${UO_OUT:-"$REPO_ROOT/apps/client/public/assets"}
UO_ONLY=${1:-${UO_ONLY:-hues,tiledata,art,texmaps,gumps,cursors,radarcol,map,statics,cliloc,sounds,anim,music,multi,animdata,housedata,lights,verdata,professions,speeches,multimap,unifont}}

if [ ! -d "$UO_SRC" ]; then
  cat >&2 <<EOF
[extract] Ultima Online install not found:
  $UO_SRC

Set UO_SRC to the directory that contains the UO MUL/UOP files, then rerun:
  UO_SRC="/path/to/Ultima Online Classic" tools/sh/extract-assets.sh
EOF
  exit 1
fi

mkdir -p "$UO_OUT"

echo "[extract] src:  $UO_SRC"
echo "[extract] out:  $UO_OUT"
echo "[extract] only: $UO_ONLY"
node packages/extractor/extract.js --src "$UO_SRC" --out "$UO_OUT" --only "$UO_ONLY"
