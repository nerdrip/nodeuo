# KTX2 / Basis Universal post-processing (optional)

The standard `extract.js` pipeline emits `.png` atlas pages. The Pixi
client now prefers `.ktx2` (Basis Universal) when the file is present
next to the corresponding `.png`, falling back to PNG when not.

KTX2 advantages on the runtime:
- ~50 % smaller download (BC7 vs PNG, both lossless-ish for sprites)
- Zero CPU-side decode burst on first paint — the GPU samples the
  compressed blocks directly, so on cold cache the boot transition
  from "atlas pages 12/59" to "ready" feels instant.
- Half the VRAM (BC7 4 bpp vs RGBA 32 bpp) on machines that previously
  pushed against texture-memory limits with all 59 mobile atlases.

## Generating KTX2 from the existing PNG output

The extractor does not bundle a Basis Universal encoder
(`basis_encoder.wasm` is ~4 MB). It uses the Khronos `toktx` CLI as an
optional post-processing step:

```bash
# 1) Install KTX-Software CLI (`toktx`)
choco install ktx-software           # Windows / Chocolatey
brew install ktx-software            # macOS / Homebrew
apt-get install libktx-tools         # Debian / Ubuntu

# 2) See what would be converted.
pnpm extract:ktx2 -- --dry-run

# 3) Convert every atlas PNG in apps/client/public/assets/.
pnpm extract:ktx2

# Optional: run conversion immediately after a normal extract.
pnpm extract -- --src "D:\Games\Electronic Arts\Ultima Online Classic" --ktx2
pnpm extract -- --src "D:\Games\Electronic Arts\Ultima Online Classic" --ktx2 --ktx2-only mobiles,gump

# 4) Optional: drop the PNG copies once you've verified KTX2 plays.
#    Keep them while bisecting browser support.
```

The wrapper runs `toktx --t2 --uastc --zcmp 19` by default. That is the
high-quality sprite preset: lossless for flat colour areas and
near-lossless for hue ramps. It skips up-to-date `.ktx2` files unless
you pass `--force`.

Useful flags:

```bash
pnpm extract:ktx2 -- --only mobiles,gump
pnpm extract:ktx2 -- --force
pnpm extract:ktx2 -- --toktx "C:\Program Files\KTX-Software\bin\toktx.exe"
pnpm extract:ktx2 -- --out apps/client/public/assets
```

## Control Panel

The Control Panel exposes two paths under ASSETS:

- `Extract Assets` + `KTX2 after extract` checkbox: runs the normal
  converter and then converts atlas PNGs to `.ktx2`.
- `Compress KTX2` button: converts already-extracted atlas PNGs without
  rebuilding MUL/UOP assets.
- `TOOLS -> Install KTX2 Tool`: downloads/installs Khronos KTX-Software
  locally when `toktx` is missing.
- `TOOLS -> Check KTX2 Tool`: prints the resolved `toktx` path/version.

If the Electron process does not see `toktx` in PATH, set
`Settings -> KTX2 toktx` to the absolute `toktx.exe` path and save.
The converter also auto-checks `tools/ktx-software/`, so the panel
installer does not require manually editing PATH.

## Browser support

Pixi v8's KTX2 loader uses the Khronos Basis Universal transcoder which
ships as a WASM binary. Modern Chromium / Edge / Safari transcode at
~80 MB/s on a 2020 laptop — for our 6 land + 8 static + 59 mobile + 6
texmap atlases the upfront cost is ~10 s on cold cache vs 30 s for the
PNG decode path. Old Firefox builds without WASM SIMD fall back to
`.png` automatically via the asset-manager candidate chain.

## File-naming convention

The asset-manager's KTX2-first lookup expects:

```
land-atlas-00.ktx2     fallback: land-atlas-00.png
static-atlas-000.ktx2  fallback: static-atlas-000.png
mobiles-atlas-00.ktx2  fallback: mobiles-atlas-00.png
gump-atlas-000.ktx2    fallback: gump-atlas-000.png
texmap-atlas-00.ktx2   fallback: texmap-atlas-00.png
```

Padding widths are unchanged from the PNG manifest. The KTX2 file
contains the same atlas grid; manifests (`*.json`) keep referencing
the same `page` and `u/v` fields — they describe the texture coords,
not the file format, so they are format-agnostic.
