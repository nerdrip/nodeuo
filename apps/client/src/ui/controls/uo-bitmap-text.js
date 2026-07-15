// UoBitmapText — renders a string using the canonical UO `fonts.mul`
// bitmap glyphs (extracted to `assets/fonts.png` + `assets/fonts.json`).
// Drop-in companion for `Label`; `label.js` picks this renderer when
// the atlas is loaded and falls back to Pixi `Text` otherwise.
//
// One `Sprite` is created per glyph and parented to this control's
// node. Glyph textures are cached per font/code so re-renders only pay
// a `setTexture` + `tint` swap. Whitespace and missing glyphs advance
// the cursor by the font's space width — never produce empty sprites.
//
// Safety net: if the requested font index is missing (atlas extracted
// without it, or the texture hasn't bound yet), fall back to a Pixi
// `Text` child so the label is at least readable in Consolas. Without
// this, gumps built before `assets.fontsTexture` finished loading
// silently render with width=0 — observed as "empty spellbook" when
// the user opens the book moments after the gump system spins up.

import { Container, Sprite, Texture, Rectangle, Text } from 'pixi.js';
import { Control } from '../control.js';
import { assets } from '../../assets/asset-manager.js';
import { UI_FONT_FAMILY, UI_TEXT_RESOLUTION } from '../text-quality.js';

/** @type {Map<number, Map<number, Texture>>} */
const _glyphTextureCache = new Map();

function glyphTexture(fontIndex, code) {
  const font = assets.fonts?.fonts?.[fontIndex];
  const baseTex = assets.fontsTexture;
  if (!font || !baseTex?.source) return null;
  const meta = font.glyphs?.[code];
  if (!meta || !meta.w || !meta.h) return null;

  let perFont = _glyphTextureCache.get(fontIndex);
  if (!perFont) { perFont = new Map(); _glyphTextureCache.set(fontIndex, perFont); }
  let tex = perFont.get(code);
  if (!tex) {
    tex = new Texture({
      source: baseTex.source,
      frame: new Rectangle(meta.x, meta.y, meta.w, meta.h),
    });
    perFont.set(code, tex);
  }
  return tex;
}

/** Return the first usable font index — caller's choice if available,
 *  else font 0 (UO's primary game font), else null. */
function resolveFontIndex(want) {
  const list = assets.fonts?.fonts;
  if (!list?.length) return null;
  if (list[want] && Object.keys(list[want].glyphs ?? {}).length) return want;
  if (list[0]    && Object.keys(list[0].glyphs ?? {}).length)    return 0;
  return null;
}

export class UoBitmapText extends Control {
  constructor(text = '', { hue = 0xfff0c0, fontIndex = 0, scale = 1 } = {}) {
    super();
    this.acceptMouseInput = false;
    this._text = '';
    this._requestedFontIndex = fontIndex | 0;
    this._fontIndex = fontIndex | 0;
    this._scale = scale;
    this._hue = (hue & 0xffffff) >>> 0;
    /** Glyph layer — re-used; sprites added/removed as text changes. */
    this._glyphLayer = new Container();
    this.node.addChild(this._glyphLayer);
    /** @type {Sprite[]} reusable sprite pool */
    this._pool = [];
    /** Pixi Text fallback — instantiated lazily when atlas is missing. */
    this._fallback = null;
    this.setText(text);
  }

  setText(t) {
    const str = t == null ? '' : String(t);
    if (str === this._text) return;
    this._text = str;
    this._rebuild();
  }

  setHue(h) {
    const rgb = ((typeof h === 'number' ? h : 0xfff0c0) & 0xffffff) >>> 0;
    if (rgb === this._hue) return;
    this._hue = rgb;
    for (const s of this._glyphLayer.children) s.tint = rgb;
    if (this._fallback) this._fallback.style.fill = rgb;
  }

  setFontIndex(i) {
    const idx = i | 0;
    if (idx === this._requestedFontIndex) return;
    this._requestedFontIndex = idx;
    this._rebuild();
  }

  _ensureFallback() {
    if (this._fallback) return;
    this._fallback = new Text({
      text: this._text,
      style: {
        fill: this._hue,
        // Approximate UO bitmap-font cap-heights so the fallback doesn't
        // jump in size: font 9 (system) ≈ 10 px; font 0 default ≈ 12 px;
        // font 3 (titles) ≈ 16 px. Otherwise track requested scale.
        fontSize: Math.max(8, Math.round(
          (this._requestedFontIndex === 3 ? 16 :
           this._requestedFontIndex === 9 ? 10 : 12) * this._scale)),
        fontFamily: UI_FONT_FAMILY,
        stroke: { color: 0x000000, width: 0.5 },
      },
      resolution: UI_TEXT_RESOLUTION,
      roundPixels: true,
    });
    this.node.addChild(this._fallback);
  }

  _hideFallback() {
    if (this._fallback) {
      this._fallback.text = '';
      this._fallback.visible = false;
    }
  }

  _showFallbackOnly() {
    // No usable atlas — render the string as Pixi Text instead.
    this._ensureFallback();
    this._fallback.text = this._text;
    this._fallback.style.fill = this._hue;
    this._fallback.visible = true;
    // Hide any leftover glyph sprites.
    for (const s of this._glyphLayer.children) s.visible = false;
    this.width  = Math.ceil(this._fallback.width);
    this.height = Math.ceil(this._fallback.height);
  }

  _rebuild() {
    const idx = resolveFontIndex(this._requestedFontIndex);
    if (idx == null) {
      this._showFallbackOnly();
      return;
    }
    this._fontIndex = idx;
    this._hideFallback();
    const font = assets.fonts.fonts[idx];
    const scale = this._scale;
    const lineH = (font.lineHeight ?? 12) * scale;
    let cursorX = 0;
    let cursorY = 0;
    let maxX = 0;
    let used = 0;
    for (let i = 0; i < this._text.length; i++) {
      const code = this._text.charCodeAt(i);
      if (code === 0x0A) {
        // Newline.
        if (cursorX > maxX) maxX = cursorX;
        cursorX = 0;
        cursorY += lineH;
        continue;
      }
      const meta = font.glyphs?.[code];
      const tex = (meta && meta.w && meta.h) ? glyphTexture(idx, code) : null;
      if (!tex) {
        // Unknown / empty glyph (space, tab, control). Advance by the
        // font's metadata width if any, otherwise a default 4 px.
        cursorX += (meta?.w || 4) * scale;
        continue;
      }
      const sprite = this._acquireSprite(used);
      sprite.texture = tex;
      sprite.tint = this._hue;
      sprite.scale.set(scale, scale);
      sprite.position.set(cursorX, cursorY);
      sprite.visible = true;
      cursorX += meta.w * scale;
      used++;
    }
    if (cursorX > maxX) maxX = cursorX;
    // Hide leftover pool sprites.
    for (let i = used; i < this._glyphLayer.children.length; i++) {
      this._glyphLayer.children[i].visible = false;
    }
    this.width = Math.ceil(maxX);
    this.height = Math.ceil(cursorY + lineH);
  }

  _acquireSprite(index) {
    // Glyph order is stable inside one rebuild, so index directly into
    // the reusable pool. The old "find first hidden" scan made long
    // labels O(n^2) and showed up when large server gumps repainted.
    let s = this._pool[index];
    if (s) return s;
    s = new Sprite();
    s.roundPixels = true;
    this._pool[index] = s;
    this._glyphLayer.addChild(s);
    return s;
  }
}

/** True once both `assets.fonts` manifest and `assets.fontsTexture`
 *  are usable. `label.js` polls this in its constructor. */
export function uoFontsReady() {
  return !!(assets.fonts?.fonts?.length && assets.fontsTexture?.source);
}
