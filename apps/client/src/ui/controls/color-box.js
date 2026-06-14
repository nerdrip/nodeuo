// ColorBox - simple reusable colour swatch. Mirrors the small CUO
// colour rectangles used by Options, paperdoll, infobar and hue pickers.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';

export function approxHueRgb(hue) {
  const h = ((hue * 2654435761) >>> 0) % 360;
  const s = 70;
  const l = 55;
  const c = (1 - Math.abs(2 * l / 100 - 1)) * (s / 100);
  const hh = h / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = l / 100 - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else { r = c; b = x; }
  return ((Math.round((r + m) * 255) << 16)
        | (Math.round((g + m) * 255) << 8)
        |  Math.round((b + m) * 255));
}

export class ColorBox extends Control {
  constructor({
    width = 20,
    height = 20,
    color = 0x000000,
    hue = null,
    hueRgbFn = approxHueRgb,
    borderColor = 0x4a3818,
    selectedBorderColor = 0xffe080,
    borderWidth = 1,
    alpha = 1,
    selected = false,
  } = {}) {
    super();
    this.width = width | 0;
    this.height = height | 0;
    this._color = color >>> 0;
    this._hue = hue == null ? null : (hue | 0);
    this._hueRgbFn = hueRgbFn;
    this._borderColor = borderColor >>> 0;
    this._selectedBorderColor = selectedBorderColor >>> 0;
    this._borderWidth = Math.max(0, borderWidth | 0);
    this._alpha = Math.max(0, Math.min(1, Number(alpha)));
    this._selected = !!selected;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this.acceptMouseInput = false;
    this._draw();
  }

  get color() { return this._color; }
  get hue() { return this._hue; }
  get selected() { return this._selected; }

  setColor(color) {
    this._hue = null;
    this._color = color >>> 0;
    this._draw();
  }

  setHue(hue) {
    this._hue = hue == null ? null : (hue | 0);
    this._draw();
  }

  setSelected(selected) {
    const next = !!selected;
    if (next === this._selected) return;
    this._selected = next;
    this._draw();
  }

  setSize(w, h) {
    super.setSize(w, h);
    this._draw();
  }

  _fillColor() {
    return this._hue == null ? this._color : (this._hueRgbFn?.(this._hue) ?? this._color);
  }

  _draw() {
    const g = this._gfx;
    g.clear();
    const bw = this._selected ? Math.max(2, this._borderWidth) : this._borderWidth;
    const stroke = this._selected ? this._selectedBorderColor : this._borderColor;
    g.rect(0, 0, Math.max(1, this.width), Math.max(1, this.height))
      .fill({ color: this._fillColor(), alpha: this._alpha });
    if (bw > 0) {
      g.rect(0, 0, Math.max(1, this.width), Math.max(1, this.height))
        .stroke({ width: bw, color: stroke });
    }
  }
}
