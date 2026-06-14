// TargetCursor — visible affordance for "we are picking a target".
//
// Mirrors ClassicUO's `GameCursor` switching to a coloured crosshair
// when the server (or local code) opens a target prompt via 0x6C / 0x99.
// CUO ships hand-painted cursor sprites; we draw inline SVG over a
// fixed-position div that follows the mouse, plus we flip
// `document.body.style.cursor` to `crosshair` so the OS pointer matches.
//
// What you get:
//   • a coloured crosshair / diamond / house glyph follows the mouse
//   • a one-line caption under it explains *what* mode + that Esc
//     cancels — solves the user complaint "nie wiadomo że jesteśmy w
//     trybie wybierania"
//   • body cursor flips to `crosshair` so even off-viewport hovers
//     look targety
//
// Three visual states match `target-manager.CursorType`:
//   Object   — generic crosshair (most spells, most commands)
//   Position — diamond outline (spells that take a tile, [go target)
//   Multi    — house silhouette (house / boat placement from 0x99)
//
// The colour reflects the 0x6C `flag` byte (server-side classification):
//   0 = neutral   yellow  (telekinesis, mark, GM picks)
//   1 = harmful   red     (fireball, magic-arrow, attack)
//   2 = beneficial green  (heal, bless, cure)
//
// Also handles right-click as a cancel shortcut while a prompt is live —
// matches CUO's RMB-cancel binding. Plays well with Esc which the
// game-scene already wires (see `game-scene.js` keydown handler).

import { bus } from '../core/event-bus.js';
import { CursorType, targetManager } from './target-manager.js';
import { systemCursor } from './system-cursor.js';
import { assets } from '../assets/asset-manager.js';

const DOM_ID = 'uo-target-cursor';

const FLAG_NEUTRAL = 0;
const FLAG_HARMFUL = 1;
const FLAG_BENEFICIAL = 2;

const FLAG_COLOR = {
  [FLAG_NEUTRAL]:    '#fff0c0',
  [FLAG_HARMFUL]:    '#ff5555',
  [FLAG_BENEFICIAL]: '#80ff80',
};
const FLAG_LABEL = {
  [FLAG_NEUTRAL]:    'Target',
  [FLAG_HARMFUL]:    'Hostile target',
  [FLAG_BENEFICIAL]: 'Friendly target',
};
const TYPE_HINT = {
  [CursorType.Object]:   'click an object',
  [CursorType.Position]: 'click a tile',
  [CursorType.Multi]:    'click a ground tile to place',
};

class TargetCursor {
  constructor() {
    this._installed = false;
    /** @type {HTMLDivElement | null} */
    this._el = null;
    /** @type {HTMLDivElement | null} */
    this._glyph = null;
    /** @type {HTMLDivElement | null} */
    this._caption = null;
    /** Saved body cursor so we can restore it on `target:cleared`. */
    this._savedBodyCursor = null;
    /** Bound mouse-move handler for removeEventListener on uninstall. */
    this._onMove = null;
    /** Bound contextmenu handler — RMB cancels the prompt. */
    this._onCtx = null;
  }

  install() {
    if (this._installed) return;
    this._installed = true;

    this._el = document.createElement('div');
    this._el.id = DOM_ID;
    this._el.style.cssText = `
      position:fixed; z-index:99998; pointer-events:none;
      transform:translate(-50%, -50%); display:none;
      width:36px; height:36px; outline:none;
    `;
    this._glyph = document.createElement('div');
    this._glyph.style.cssText = `
      width:36px; height:36px; display:flex;
      align-items:center; justify-content:center; outline:none;
      filter: drop-shadow(0 0 4px rgba(0,0,0,0.85));
    `;
    this._el.appendChild(this._glyph);

    this._caption = document.createElement('div');
    this._caption.style.cssText = `
      position:absolute; top:42px; left:50%; transform:translateX(-50%);
      white-space:nowrap; font:11px Consolas,monospace; letter-spacing:0.5px;
      padding:3px 8px; border-radius:3px; outline:none;
      background:rgba(12,16,24,0.88); border:1px solid #6e5520;
      text-shadow:0 1px 2px #000;
    `;
    this._el.appendChild(this._caption);

    document.body.appendChild(this._el);

    bus.on('target:active',  (info) => this._show(info));
    bus.on('target:cleared', () => { this._hide(); this._clearPreview(); });
    // Build mode: server pushes 0xBF 0x6F right before arming the
    // target prompt with the itemId to ghost. Cursor renders that
    // graphic as a translucent sprite at mouse follow position.
    bus.on('target:preview', ({ itemId, hue }) => this._setPreview(itemId, hue));

    // Follow the mouse — `pointerEvents:none` keeps clicks falling
    // through to the underlying gump / world.
    this._onMove = (e) => {
      if (!this._el || this._el.style.display === 'none') return;
      this._el.style.left = e.clientX + 'px';
      this._el.style.top  = e.clientY + 'px';
    };
    window.addEventListener('mousemove', this._onMove);

    // Right-click cancels — CUO's classic RMB binding for target prompts.
    // Only intercept when we're actually in target mode; otherwise the
    // browser's context menu (or any local handler) wins. We capture in
    // the bubble phase so the page's own RMB handlers run AFTER us only
    // when we don't consume the event.
    this._onCtx = (e) => {
      if (!targetManager.active) return;
      e.preventDefault();
      e.stopPropagation();
      targetManager.cancel();
    };
    window.addEventListener('contextmenu', this._onCtx, { capture: true });
  }

  /** Tear down — useful for tests or hot-reload. */
  uninstall() {
    if (!this._installed) return;
    this._installed = false;
    if (this._onMove) window.removeEventListener('mousemove', this._onMove);
    if (this._onCtx)  window.removeEventListener('contextmenu', this._onCtx, { capture: true });
    this._onMove = null;
    this._onCtx = null;
    if (this._el) { this._el.remove(); this._el = null; }
    this._glyph = null;
    this._caption = null;
    this._restoreBodyCursor();
  }

  /** Audit #40 deferred (client P3 #15) — tint the cursor sprite red
   *  when the origin tile under it would reject a multi placement.
   *  multi-ghost publishes `multi:placement-valid` per frame; we
   *  re-style the caption color so the user sees red at a glance. */
  setPlacementValid(valid) {
    if (!this._el || !this._caption) return;
    if (targetManager.cursorType !== CursorType.Multi) return;
    this._caption.style.color = valid ? '#80ff80' : '#ff5555';
  }

  _show({ cursorType = CursorType.Object, flag = FLAG_NEUTRAL } = {}) {
    if (!this._el) return;
    const color = FLAG_COLOR[flag] ?? FLAG_COLOR[FLAG_NEUTRAL];
    const label = FLAG_LABEL[flag] ?? 'Target';
    const hint  = TYPE_HINT[cursorType] ?? '';
    // Caption strip below the cursor — explains what we're targeting
    // and how to cancel. The reticle ITSELF is the UO atlas sprite
    // pushed into the systemCursor as an override, so we no longer
    // overlay our own SVG glyph (which read as oversized + clashed
    // with the OS pointer). systemCursor handles hotspots from the
    // manifest, so the click point stays accurate per cursor.
    this._glyph.innerHTML = '';
    this._caption.style.color = color;
    this._caption.textContent = hint
      ? `${label} — ${hint} (Esc / RMB to cancel)`
      : `${label} (Esc / RMB to cancel)`;
    this._el.style.display = '';
    const cursorName =
      flag === FLAG_HARMFUL    ? 'target-harmful'    :
      flag === FLAG_BENEFICIAL ? 'target-beneficial' :
                                 'target-neutral';
    systemCursor.setOverride(cursorName);
    // Don't fight the systemCursor — the OS pointer is already hidden
    // via `body.style.cursor = 'none'`. We just remember whatever
    // body cursor was so `_restoreBodyCursor` is a no-op.
    if (this._savedBodyCursor === null) {
      this._savedBodyCursor = document.body.style.cursor || '';
    }
  }

  _hide() {
    if (this._el) this._el.style.display = 'none';
    systemCursor.setOverride(null);
    this._restoreBodyCursor();
  }

  /** Set / clear the build-preview sprite. */
  async _setPreview(itemId, hue) {
    this._clearPreview();
    if (!itemId) return;
    try {
      const tex = await assets.staticTexture?.(itemId);
      if (!tex) return;
      // Render the texture into a small canvas so the DOM cursor can
      // display it as <img>. Pixi RenderTexture extract is heavier
      // than we need for a one-shot still; use the underlying
      // HTMLImageElement / canvas the atlas page provides.
      const canvas = document.createElement('canvas');
      const w = Math.min(64, tex.frame?.width  ?? tex.width  ?? 44);
      const h = Math.min(96, tex.frame?.height ?? tex.height ?? 44);
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const src = tex.source?.resource ?? tex.baseTexture?.resource;
      const img = src?.source ?? src;
      if (img && img.width > 0) {
        ctx.drawImage(img,
          tex.frame?.x ?? 0, tex.frame?.y ?? 0,
          tex.frame?.width ?? w, tex.frame?.height ?? h,
          0, 0, w, h,
        );
      } else {
        // Atlas not loaded yet — fall back to a labeled outline so the
        // user still sees SOMETHING.
        ctx.strokeStyle = '#ffd070';
        ctx.strokeRect(2, 2, w - 4, h - 4);
        ctx.fillStyle = '#ffd070'; ctx.font = '10px Consolas';
        ctx.fillText(`0x${itemId.toString(16)}`, 4, 14);
      }
      this._previewEl = document.createElement('div');
      this._previewEl.id = 'uo-build-preview';
      this._previewEl.style.cssText = `
        position:fixed; pointer-events:none; z-index:99997;
        transform:translate(-50%, -90%); opacity:0.65;
        filter:drop-shadow(0 0 6px rgba(0,0,0,0.7));
      `;
      this._previewEl.appendChild(canvas);
      document.body.appendChild(this._previewEl);
      this._previewMove = (e) => {
        if (!this._previewEl) return;
        this._previewEl.style.left = e.clientX + 'px';
        this._previewEl.style.top  = e.clientY + 'px';
      };
      window.addEventListener('mousemove', this._previewMove);
      void hue;     // hue tinting deferred — atlas pre-tints at extract time
    } catch { /* asset module not ready / atlas miss; ignore */ }
  }

  _clearPreview() {
    if (this._previewMove) {
      window.removeEventListener('mousemove', this._previewMove);
      this._previewMove = null;
    }
    if (this._previewEl) {
      this._previewEl.remove();
      this._previewEl = null;
    }
  }

  _restoreBodyCursor() {
    if (this._savedBodyCursor === null) return;
    document.body.style.cursor = this._savedBodyCursor;
    this._savedBodyCursor = null;
  }

  /** Inline SVG glyph per cursor type — UO-styled reticles with an
   *  outer ornamental ring + cardinal tick marks + inner crosshair,
   *  plus a soft drop-shadow so the cursor reads on any tile. We can't
   *  use the canonical art.mul cursor sprites (0x205A..) because the
   *  current extractor doesn't pull them — these SVG glyphs match the
   *  "ornate ring + crosshair" silhouette CUO renders. */
  _iconSvg(cursorType, color) {
    // Shared filter for the soft glow (drop-shadow). Defining it inline
    // means each cursor variant carries its own copy — fine since
    // there's only one cursor visible at a time and reuse is cheap.
    const FILTER = `
      <defs>
        <filter id="uo-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.2" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>`;
    if (cursorType === CursorType.Position) {
      // Tile-aligned diamond reticle — heavy outline + tick marks at
      // cardinal vertices + central dot. Reads as "drop on a tile".
      return `
        <svg width="36" height="36" viewBox="0 0 56 56">
          ${FILTER}
          <g filter="url(#uo-glow)" stroke="${color}" fill="none" stroke-linejoin="round">
            <polygon points="28,4 52,28 28,52 4,28" stroke-width="2.5"/>
            <polygon points="28,12 44,28 28,44 12,28" stroke-width="1.5" stroke-opacity="0.6"/>
            <line x1="28" y1="0"  x2="28" y2="6"  stroke-width="2"/>
            <line x1="28" y1="50" x2="28" y2="56" stroke-width="2"/>
            <line x1="0"  y1="28" x2="6"  y2="28" stroke-width="2"/>
            <line x1="50" y1="28" x2="56" y2="28" stroke-width="2"/>
          </g>
          <circle cx="28" cy="28" r="3" fill="${color}" filter="url(#uo-glow)"/>
        </svg>`;
    }
    if (cursorType === CursorType.Multi) {
      // House silhouette with a doorway + corner brackets. Reads as
      // "place a structure here".
      return `
        <svg width="36" height="36" viewBox="0 0 56 56">
          ${FILTER}
          <g filter="url(#uo-glow)" stroke="${color}" fill="none" stroke-linejoin="round">
            <polygon points="8,32 28,14 48,32" stroke-width="2.5"/>
            <rect x="12" y="32" width="32" height="18" stroke-width="2.5"/>
            <line x1="28" y1="14" x2="28" y2="8" stroke-width="2"/>
            <line x1="4"  y1="50" x2="10" y2="50" stroke-width="2"/>
            <line x1="46" y1="50" x2="52" y2="50" stroke-width="2"/>
          </g>
          <rect x="25" y="38" width="6" height="12" fill="${color}" filter="url(#uo-glow)"/>
        </svg>`;
    }
    // Default = object crosshair with ornate outer ring + cardinal
    // tick marks + central dot. Echoes the look of CUO's `Cursors.tdf`
    // target reticle (gold ring + black inner with red eye).
    return `
      <svg width="36" height="36" viewBox="0 0 56 56">
        ${FILTER}
        <g filter="url(#uo-glow)" stroke="${color}" fill="none">
          <circle cx="28" cy="28" r="22" stroke-width="1.2" stroke-opacity="0.4"/>
          <circle cx="28" cy="28" r="14" stroke-width="2.4"/>
          <circle cx="28" cy="28" r="9"  stroke-width="1.4" stroke-opacity="0.7"/>
          <line x1="28" y1="2"  x2="28" y2="14" stroke-width="2"/>
          <line x1="28" y1="42" x2="28" y2="54" stroke-width="2"/>
          <line x1="2"  y1="28" x2="14" y2="28" stroke-width="2"/>
          <line x1="42" y1="28" x2="54" y2="28" stroke-width="2"/>
          <line x1="11" y1="11" x2="16" y2="16" stroke-width="1.4" stroke-opacity="0.6"/>
          <line x1="40" y1="11" x2="45" y2="16" stroke-width="1.4" stroke-opacity="0.6"/>
          <line x1="11" y1="45" x2="16" y2="40" stroke-width="1.4" stroke-opacity="0.6"/>
          <line x1="40" y1="45" x2="45" y2="40" stroke-width="1.4" stroke-opacity="0.6"/>
        </g>
        <circle cx="28" cy="28" r="2.5" fill="${color}" filter="url(#uo-glow)"/>
      </svg>`;
  }
}

export const targetCursor = new TargetCursor();
