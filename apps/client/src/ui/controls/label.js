// Label — static text. Mirrors ClassicUO's Game/UI/Controls/Label.cs.
//
// Defaults to Pixi `Text` (Consolas) — fast to render, always visible,
// and matches the look of every other text Control in our codebase
// (Button labels, world overhead names, journal lines, …). Callers
// can pass `bitmap: true` to opt into the UO fonts.mul bitmap-glyph
// renderer via `UoBitmapText`; that path is reserved for cases where
// the classic shard typography is the explicit goal (server-driven
// gumps that hue text by ServUO color tables, etc.) — for everyday
// gump chrome the Pixi path is preferred because it side-steps the
// glyph-atlas timing + tint-multiplication quirks that historically
// produced "invisible labels in spellbook / paperdoll" reports.

import { Text, TextStyle } from 'pixi.js';
import { Control } from '../control.js';
import { UoBitmapText, uoFontsReady } from './uo-bitmap-text.js';

/** Map our requested CSS-ish fontSize to one of the 10 UO ASCII fonts.
 *  Font 0 is the standard UO game text (~ 9-px cap height). Fonts 3/9
 *  are slightly larger; fonts 6/7 are headlines. Anything beyond the
 *  atlas range falls back to font 0. Used only when `bitmap: true`. */
function pickUoFont(fontSize) {
  if (fontSize >= 16) return 3;     // bigger title font
  if (fontSize <= 9)  return 9;     // tiny system font
  return 0;
}

/** Normalise an incoming hue to a 24-bit RGB number Pixi will accept.
 *  Historical CUO sources sometimes smuggled an alpha byte into a
 *  32-bit literal (0xb0fff0c0) which crashes Pixi v8 Color parsing —
 *  mask it down. Pure black (0x000000) on UO's grey-pixel glyph atlas
 *  multiplies to invisible, so promote it to a dark inked grey that
 *  still reads as "black" against light parchment. */
function normalizeHue(h) {
  if (typeof h !== 'number') return 0xfff0c0;
  let rgb = (h & 0xffffff) >>> 0;
  if (rgb === 0x000000) rgb = 0x101010;
  return rgb;
}

const _textStyleCache = new Map();
function labelTextStyle(fill, fontSize, fontFamily, stroke) {
  const key = `${fill >>> 0}|${fontSize | 0}|${fontFamily}|${stroke ? 1 : 0}`;
  let style = _textStyleCache.get(key);
  if (style) return style;
  style = new TextStyle({
    fill,
    fontSize,
    fontFamily,
    ...(stroke ? { stroke: { color: 0x000000, width: 2 } } : {}),
  });
  _textStyleCache.set(key, style);
  return style;
}

export class Label extends Control {
  constructor(text = '', {
    hue = 0xfff0c0, fontSize = 12,
    font = 'Consolas, monospace',
    stroke = true,
    bitmap = false,
  } = {}) {
    super();
    this.acceptMouseInput = false;
    this._hue = normalizeHue(hue);
    this._fontSize = fontSize;
    this._fontFamily = font;
    this._stroke = stroke;
    this._cachedText = text ?? '';

    if (bitmap && uoFontsReady()) {
      this._mode = 'uo';
      this._uo = new UoBitmapText(this._cachedText, {
        hue: this._hue, fontIndex: pickUoFont(fontSize),
      });
      this.node.addChild(this._uo.node);
    } else {
      this._mode = 'pixi';
      this._text = new Text({
        text: this._cachedText,
        style: labelTextStyle(this._hue, fontSize, font, stroke),
      });
      this.node.addChild(this._text);
    }
    this._sync();
  }

  setText(t) {
    const next = t ?? '';
    if (next === this._cachedText) return;
    this._cachedText = next;
    if (this._mode === 'uo') {
      this._uo.setText(next);
    } else {
      this._text.text = next;
    }
    this._sync();
  }

  setHue(h) {
    const rgb = normalizeHue(h);
    if (rgb === this._hue) return;
    this._hue = rgb;
    if (this._mode === 'uo') {
      this._uo.setHue(rgb);
    } else {
      this._text.style = labelTextStyle(rgb, this._fontSize, this._fontFamily, this._stroke);
    }
  }

  _sync() {
    if (this._mode === 'uo') {
      this.width  = this._uo.width;
      this.height = this._uo.height;
    } else {
      this.width  = Math.ceil(this._text.width);
      this.height = Math.ceil(this._text.height);
    }
  }
}
