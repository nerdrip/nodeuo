// ColorPickerGump — UO hue palette selector. Mirrors ClassicUO
// Game/UI/Gumps/ColorPickerGump.cs.
//
// Renders a grid of hue swatches whose RGB comes from `hues.png` (32-
// wide RGBA bitmap shipped by the extractor). Falls back to an HSL
// rainbow if the asset is not yet decoded. The user clicks a swatch and
// the gump resolves with the chosen hue id (1..N).
//
// Usage:
//   import { pickHue } from './color-picker-gump.js';
//   const hue = await pickHue({ start: 2, count: 128 });

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Control } from '../control.js';
import { uiManagerInstance } from '../ui-manager-singleton.js';

// Cached representative RGB per hue id (sampled middle column of
// hues.png). Lazy-loaded on first picker open and reused across all
// subsequent pickers in the same session.
let _huePalette = null;          // Uint32Array | null
let _huePaletteLoading = null;   // Promise<void> | null

/** Spread `hueId` across the full 360° HSL hue circle for fallback. */
function fallbackHueColor(hueId, span = 1158) {
  // span = approximate count of "useful" hues (skin tones + dyes).
  const h = (hueId % span) / span;
  // HSL → RGB with S=0.65, L=0.55 — gives saturated but readable swatches.
  const s = 0.65, l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if      (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else             { r = c; b = x; }
  const m = l - c / 2;
  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);
  return (R << 16) | (G << 8) | B;
}

function colorForHue(hueId) {
  if (_huePalette && hueId >= 0 && hueId < _huePalette.length) {
    const v = _huePalette[hueId];
    if (v) return v;
  }
  return fallbackHueColor(hueId);
}

async function ensureHuePalette() {
  if (_huePalette) return;
  if (_huePaletteLoading) return _huePaletteLoading;
  _huePaletteLoading = (async () => {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = '/assets/hues.png';
      });
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      // Sample middle column (x=15) for each row — gives a representative
      // mid-tone shade per hue. hues.png is 32 wide × N tall.
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      const N = img.height;
      const out = new Uint32Array(N + 1);   // index by 1-based hue id
      const x = Math.min(15, img.width - 1);
      for (let y = 0; y < N; y++) {
        const off = (y * img.width + x) * 4;
        const r = data[off + 0];
        const g = data[off + 1];
        const b = data[off + 2];
        out[y + 1] = (r << 16) | (g << 8) | b;
      }
      _huePalette = out;
    } catch (e) {
      // Fall back to HSL rainbow — picker is still usable.
      console.warn('[color-picker] hues.png unavailable:', e?.message);
      _huePalette = null;
    } finally {
      _huePaletteLoading = null;
    }
  })();
  return _huePaletteLoading;
}

class HueSwatch extends Control {
  constructor({ hueId, size = 18, onPick, onHover }) {
    super();
    this.width = size; this.height = size;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._gfx.rect(0, 0, size, size)
      .fill({ color: colorForHue(hueId) })
      .stroke({ width: 1, color: 0x100A06 });
    this.acceptMouseInput = true;
    this._onPick = onPick;
    this._onHover = onHover;
    this._hueId = hueId;
  }
  onMouseDown() { this._onPick?.(this._hueId); }
  onMouseEnter() { this._onHover?.(this._hueId); }
}

export class ColorPickerGump extends WindowGump {
  constructor({ start = 0, count = 128, onResolve, columns = 16 }) {
    const rows = Math.ceil(count / columns);
    const cell = 20;
    const w = columns * cell + 24;
    const h = rows * cell + 96;
    super({ title: 'Pick a hue', width: w, height: h, x: 100, y: 100 });
    this._onResolve = onResolve;
    this._resolved = false;
    this._hoverLabel = new Label('Hover to preview · click to apply', {
      fontSize: 10, hue: 0xa08868, stroke: false,
    });
    this._hoverLabel.setPosition(12, h - 50);
    this.add(this._hoverLabel);

    let x = 12, y = 32, col = 0;
    for (let i = 0; i < count; i++) {
      const hueId = start + i;
      const sw = new HueSwatch({
        hueId, size: cell - 2,
        onPick: (id) => { this._resolved = true; this._onResolve?.(id); this.close?.(); },
        onHover: (id) => {
          this._hoverLabel?.setText?.(`hue 0x${id.toString(16)} (${id})`);
        },
      });
      sw.setPosition(x, y);
      this.add(sw);
      x += cell;
      col++;
      if (col >= columns) { col = 0; x = 12; y += cell; }
    }

    const hint = new Label('Click a swatch to apply.', { fontSize: 10, hue: 0xa08868, stroke: false });
    hint.setPosition(12, h - 30);
    this.add(hint);
  }

  close(...a) {
    if (!this._resolved) { this._resolved = true; this._onResolve?.(null); }
    return super.close?.(...a);
  }

  get type() { return 'color-picker'; }
}

export async function pickHue({ start = 0, count = 128, columns = 16 } = {}) {
  // Warm the palette before constructing the gump so the very first
  // swatches are already coloured correctly. If the asset is missing the
  // promise resolves quickly and we fall through to the HSL fallback.
  await ensureHuePalette();
  return new Promise((resolve) => {
    const g = new ColorPickerGump({ start, count, columns, onResolve: resolve });
    const ui = uiManagerInstance.get();
    if (!ui) { resolve(null); return; }
    ui.addGump(g);
  });
}
