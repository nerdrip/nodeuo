// HtmlControl — tiny markup renderer for the limited HTML subset that
// UO server gumps emit (cliloc strings + <basefont> + <a href> +
// <i>/<b>/<u> + <br>). Mirrors ClassicUO's HtmlControl.cs at MVP.
//
// We intentionally don't reach for a real HTML engine — the input space
// is small and security matters: gump strings come from the server and
// could be hostile. We tokenize a whitelist of tags + plain text,
// render to a Pixi Text + Graphics composition, and ignore everything
// else.

import { Container, Text, Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { UI_FONT_FAMILY, UI_TEXT_RESOLUTION } from '../text-quality.js';

const ALLOWED_TAGS = new Set(['basefont', 'b', 'i', 'u', 'br', 'a', 'p', 'div', 'span', 'center']);

/**
 * Tokenize an HTML-ish string into a flat array of tokens. Each token is
 * either `{ type:'text', value }`, `{ type:'tag', name, attrs, close }`,
 * or `{ type:'br' }`.
 */
function tokenize(s) {
  const out = [];
  if (!s) return out;
  let i = 0;
  const len = s.length;
  while (i < len) {
    if (s[i] === '<') {
      const end = s.indexOf('>', i + 1);
      if (end < 0) { out.push({ type: 'text', value: s.slice(i) }); break; }
      const raw = s.slice(i + 1, end);
      const close = raw.startsWith('/');
      const body = close ? raw.slice(1) : raw;
      const ws = body.indexOf(' ');
      const name = (ws < 0 ? body : body.slice(0, ws)).toLowerCase();
      const attrStr = ws < 0 ? '' : body.slice(ws + 1);
      if (!ALLOWED_TAGS.has(name)) {
        // Unknown tag → render as escaped text so user can see it
        // (per CUO behaviour where unknown HTML degrades gracefully).
        out.push({ type: 'text', value: s.slice(i, end + 1) });
      } else if (name === 'br') {
        out.push({ type: 'br' });
      } else {
        out.push({ type: 'tag', name, attrs: parseAttrs(attrStr), close });
      }
      i = end + 1;
    } else {
      const next = s.indexOf('<', i);
      const slice = s.slice(i, next < 0 ? len : next);
      out.push({ type: 'text', value: decodeEntities(slice) });
      i = next < 0 ? len : next;
    }
  }
  return out;
}

function parseAttrs(s) {
  const out = {};
  if (!s) return out;
  // Trivial regex parser — attr="value" or attr='value' or attr=value
  const re = /([a-z][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]*))/gi;
  let m;
  while ((m = re.exec(s))) {
    out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g,  '<')
    .replace(/&gt;/g,  '>')
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Render a tokenized stream into a flat [{x,y,text,style}] layout. The
 * result feeds straight into Pixi Text instances; this lets the renderer
 * stay framework-agnostic and unit-testable.
 *
 * Layout policy:
 *   - tokens flow left→right, wrapping at `maxWidth`.
 *   - `<br>` and `<p>` start a new line.
 *   - `<basefont color="#RRGGBB" size="N">` sets the colour/size for
 *     subsequent runs (CUO-extended attribute set).
 *   - `<center>...</center>` centers the line within `maxWidth`.
 *   - `<a href="...">` underlines + highlights the run + records the
 *     link target on the run for click handling.
 */
export function layoutHtml(tokens, { maxWidth = 320, fontSize = 12, baseColor = 0xfff0c0 } = {}) {
  const runs = [];
  const stack = [{ color: baseColor, size: fontSize, bold: false, italic: false, underline: false, link: null, center: false }];
  const top = () => stack[stack.length - 1];
  let x = 0, y = 0, lineH = fontSize + 2;
  const lineRuns = [];          // current line's runs (for center alignment)

  function flushLine() {
    if (top().center && lineRuns.length) {
      const lineW = lineRuns.reduce((acc, r) => Math.max(acc, r.x + r.w), 0);
      const off = (maxWidth - lineW) / 2;
      for (const r of lineRuns) r.x += off;
    }
    y += lineH;
    x = 0;
    lineRuns.length = 0;
  }

  for (const t of tokens) {
    if (t.type === 'br') { flushLine(); continue; }
    if (t.type === 'tag') {
      const cur = top();
      const next = { ...cur };
      if (t.close) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      switch (t.name) {
        case 'basefont':
          if (t.attrs.color) next.color = parseColor(t.attrs.color);
          if (t.attrs.size)  next.size  = clamp(parseInt(t.attrs.size, 10) || fontSize, 6, 48);
          break;
        case 'b':       next.bold = true; break;
        case 'i':       next.italic = true; break;
        case 'u':       next.underline = true; break;
        case 'a':       next.underline = true; next.color = 0x60c0ff; next.link = t.attrs.href ?? ''; break;
        case 'center':  next.center = true; break;
        case 'p':       flushLine(); break;
        case 'div':     flushLine(); break;
        case 'span':    break;
      }
      stack.push(next);
      continue;
    }
    // text token — break on whitespace into words and wrap
    const cur = top();
    const words = t.value.split(/(\s+)/);
    for (const word of words) {
      if (!word) continue;
      const w = approxTextWidth(word, cur.size);
      if (x + w > maxWidth && word !== ' ') {
        flushLine();
      }
      const run = {
        type: 'text', text: word, x, y,
        color: cur.color, size: cur.size,
        bold: cur.bold, italic: cur.italic, underline: cur.underline,
        link: cur.link, w, h: cur.size + 2,
      };
      runs.push(run);
      lineRuns.push(run);
      x += w;
    }
  }
  flushLine();
  return runs;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function parseColor(c) {
  if (!c) return 0xfff0c0;
  c = c.trim();
  if (c.startsWith('#') && c.length === 7) {
    return parseInt(c.slice(1), 16) | 0;
  }
  // Named colors (small palette)
  const NAMED = {
    white: 0xfff0c0, black: 0x000000, red: 0xc62828, green: 0x2eb24a,
    blue: 0x1e88e5, yellow: 0xfdd835, gray: 0x808080, gold: 0xffd06a,
  };
  return NAMED[c.toLowerCase()] ?? 0xfff0c0;
}

function approxTextWidth(s, size) {
  // Approximate — Pixi Text would measure precisely but at construction
  // time we don't have a TextMetrics yet. Average glyph width is ~55% of
  // the font size for our sans-ish fallback.
  return Math.ceil(s.length * size * 0.55);
}

export class HtmlControl extends Control {
  constructor({
    text = '', maxWidth = 320, maxHeight = 0, fontSize = 12,
    color = 0xfff0c0, onLinkClick = null,
    background = false, scrollable = false,
  } = {}) {
    super();
    this.width = maxWidth;
    this.height = maxHeight > 0 ? maxHeight : fontSize + 2;
    this._maxWidth = maxWidth;
    this._maxHeight = maxHeight | 0;
    this._fontSize = fontSize;
    this._baseColor = color;
    this._onLinkClick = onLinkClick;
    this._scrollable = !!scrollable;
    this._scrollY = 0;
    this._textObjects = [];
    this._background = new Graphics();
    this._content = new Container();
    this._underlines = new Graphics();
    this._content.addChild(this._underlines);
    this._mask = new Graphics();
    this._scrollbar = new Graphics();
    this.node.addChild(this._background, this._content, this._mask, this._scrollbar);
    this._content.mask = this._mask;
    if (background) {
      this._background.rect(0, 0, this.width, this.height)
        .fill({ color: 0x080604, alpha: 0.72 })
        .stroke({ width: 1, color: 0x6f5425, alpha: 0.75 });
    }
    this._drawMask();
    this.acceptMouseInput = true;
    if (text) this.setText(text);
  }

  _drawMask() {
    this._mask.clear();
    this._mask.rect(0, 0, Math.max(1, this.width), Math.max(1, this.height))
      .fill({ color: 0xffffff });
  }

  setText(text) {
    // Wipe previous render
    for (const t of this._textObjects) {
      try { t.destroy(); } catch { /* ignore */ }
    }
    this._textObjects.length = 0;
    this._underlines.clear();

    const tokens = tokenize(text);
    const runs = layoutHtml(tokens, {
      maxWidth: this._maxWidth, fontSize: this._fontSize, baseColor: this._baseColor,
    });
    this._runs = runs;

    let totalH = 0;
    for (const r of runs) {
      const t = new Text({
        text: r.text,
        style: {
          fill: r.color, fontSize: r.size,
          fontFamily: UI_FONT_FAMILY,
          fontStyle:  r.italic ? 'italic' : 'normal',
          fontWeight: r.bold ? 'bold' : 'normal',
        },
        resolution: UI_TEXT_RESOLUTION,
        roundPixels: true,
      });
      t.position.set(r.x, r.y);
      this._content.addChild(t);
      this._textObjects.push(t);
      if (r.underline) {
        this._underlines.rect(r.x, r.y + r.size, r.w, 1).fill({ color: r.color });
      }
      totalH = Math.max(totalH, r.y + r.h);
    }
    this.contentHeight = totalH;
    if (this._maxHeight <= 0) {
      this.height = Math.max(this._fontSize + 2, totalH);
      this._drawMask();
    }
    this._maxScroll = Math.max(0, totalH - this.height);
    this._scrollY = Math.min(this._scrollY, this._maxScroll);
    this._applyScroll();
  }

  _applyScroll() {
    this._content.y = -this._scrollY;
    this._scrollbar.clear();
    if (!this._scrollable || this._maxScroll <= 0) return;
    const trackH = Math.max(8, this.height - 4);
    const thumbH = Math.max(12, trackH * (this.height / Math.max(this.height, this.contentHeight)));
    const travel = Math.max(0, trackH - thumbH);
    const thumbY = 2 + (this._scrollY / this._maxScroll) * travel;
    this._scrollbar.roundRect(this.width - 5, 2, 3, trackH, 1).fill({ color: 0x16100a, alpha: 0.75 });
    this._scrollbar.roundRect(this.width - 5, thumbY, 3, thumbH, 1).fill({ color: 0xc79a46, alpha: 0.95 });
  }

  onWheel(deltaY) {
    if (!this._scrollable || this._maxScroll <= 0) return;
    this._scrollY = Math.max(0, Math.min(this._maxScroll, this._scrollY + Math.sign(deltaY) * 24));
    this._applyScroll();
  }

  onMouseDown(_btn, lx, ly) {
    if (!this._runs || !this._onLinkClick) return;
    ly += this._scrollY;
    for (const r of this._runs) {
      if (!r.link) continue;
      if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) {
        try { this._onLinkClick(r.link); } catch { /* ignore */ }
        return;
      }
    }
  }
}

// Public re-exports for unit tests + non-Pixi consumers.
export { tokenize as _tokenizeForTest };
