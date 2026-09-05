# KTX2 / Basis Universal post-processing (optional)

The standard `extract.js` pipeline emits `.png` atlas pages. The Pixi
client now prefers `.ktx2` (Basis Universal) when the file is present
next to the corresponding `.png`, falling back to PNG when not.

KTX2 reduces transfer size and lets the browser transcode UASTC payloads to a
GPU-supported block format. Actual transfer, decode and VRAM savings depend on
the browser, GPU and selected transcode target, so PNG remains the compatibility
fallback.

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

The wrapper runs `toktx --t2 --uastc --zcmp 19` by default. It skips up-to-date
`.ktx2` files unless you pass `--force` and uses up to four bounded workers by
default. Each result is published through a `.next` file, so interruption never
replaces a valid texture with a partial one.

Useful flags:

```bash
pnpm extract:ktx2 -- --only mobiles,gump
pnpm extract:ktx2 -- --jobs 2
pnpm extract:ktx2 -- --force
pnpm extract:ktx2 -- --toktx "C:\Program Files\KTX-Software\bin\toktx.exe"
pnpm extract:ktx2 -- --out apps/client/public/assets
```

## Control Panel

The Control Panel exposes the following paths:

- `Extract Assets` + `KTX2 after extract` checkbox: runs the normal
  converter and then converts the selected atlas PNG groups to `.ktx2`.
- Selecting no source group and only `KTX2 after extract` converts existing
  atlas PNGs without rebuilding MUL/UOP assets.
- `TOOLS -> Install KTX2 Tool`: downloads/installs Khronos KTX-Software
  locally when `toktx` is missing.
- `TOOLS -> Check KTX2 Tool`: prints the resolved `toktx` path/version.

If the Electron process does not see `toktx` in PATH, set
`Settings -> KTX2 toktx` to the absolute `toktx.exe` path and save.
The converter also auto-checks `tools/ktx-software/`, so the panel
installer does not require manually editing PATH.

## Browser support

Pixi's KTX2 loader uses the Basis Universal transcoder distributed with the
client build. The current full extraction contains 6 land, 135 static, 258
mobile, 58 gump and 6 texmap atlas pages. Browsers that cannot load the KTX2
variant fall back to `.png` through the asset-manager candidate chain.

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
