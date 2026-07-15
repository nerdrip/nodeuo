// Label — static text. Mirrors ClassicUO's Game/UI/Controls/Label.cs.
//
// Defaults to high-resolution Pixi `Text` using the shared modern UI stack —
// fast to render, always visible,
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
import { UI_FONT_FAMILY, UI_TEXT_RESOLUTION } from '../text-quality.js';
import { profile } from '../../managers/profile-manager.js';

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
function labelTextStyle(fill, fontSize, fontFamily, stroke, fontWeight) {
  const key = `${fill >>> 0}|${fontSize}|${fontFamily}|${stroke ? 1 : 0}|${fontWeight}`;
  let style = _textStyleCache.get(key);
  if (style) return style;
  style = new TextStyle({
    fill,
    fontSize,
    fontFamily,
    fontWeight,
    ...(stroke ? { stroke: { color: 0x000000, width: 1, join: 'round' } } : {}),
  });
  _textStyleCache.set(key, style);
  return style;
}

export class Label extends Control {
  constructor(text = '', {
    hue = 0xfff0c0, fontSize = 13,
    font = UI_FONT_FAMILY,
    fontWeight = 500,
    stroke = false,
    bitmap = false,
    maxWidth = 0,
    wordWrap = false,
    align = 'left',
    lineHeight = 0,
  } = {}) {
    super();
    this.acceptMouseInput = false;
    this._hue = normalizeHue(hue);
    const minimum = Math.max(8, Math.min(18, Number(profile.get('ui.minTextPx')) || 10));
    this._fontSize = Math.max(minimum, Number(fontSize) || minimum);
    this._fontFamily = font;
    this._fontWeight = fontWeight;
    this._stroke = stroke;
    this._cachedText = text ?? '';
    this._maxWidth = Math.max(0, Number(maxWidth) || 0);
    this._layoutStyle = { wordWrap: !!wordWrap, align, lineHeight };

    if (bitmap && uoFontsReady()) {
      this._mode = 'uo';
      this._uo = new UoBitmapText(this._cachedText, {
        hue: this._hue, fontIndex: pickUoFont(this._fontSize),
      });
      this.node.addChild(this._uo.node);
    } else {
      this._mode = 'pixi';
      this._text = new Text({
        text: this._cachedText,
        style: this._makeStyle(this._layoutStyle),
        resolution: UI_TEXT_RESOLUTION,
        roundPixels: true,
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
      this._text.style = this._makeStyle(this._layoutStyle);
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

  _makeStyle({ wordWrap = false, align = 'left', lineHeight = 0 } = {}) {
    // Keep the shared immutable style cache for the overwhelmingly common
    // one-line case. Bounded labels need their own TextStyle because Pixi
    // mutates wordWrapWidth/align on the style instance.
    if (!this._maxWidth && !wordWrap && align === 'left' && !lineHeight) {
      return labelTextStyle(
        this._hue, this._fontSize, this._fontFamily, this._stroke, this._fontWeight,
      );
    }
    return new TextStyle({
      fill: this._hue,
      fontSize: this._fontSize,
      fontFamily: this._fontFamily,
      fontWeight: this._fontWeight,
      align,
      ...(lineHeight ? { lineHeight } : {}),
      ...(wordWrap || this._maxWidth ? {
        wordWrap: true,
        wordWrapWidth: this._maxWidth || 100,
        breakWords: true,
      } : {}),
      ...(this._stroke ? { stroke: { color: 0x000000, width: 1, join: 'round' } } : {}),
    });
  }
}
