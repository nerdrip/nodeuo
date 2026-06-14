// DragCursor — paints the currently-held item under the mouse cursor.
// Mirrors CUO `GameCursor.ItemHold` rendering. When the player lifts
// an item via `dragDrop.tryLift`, this DOM-level overlay starts
// following the mouse and shows the item's static art (so the user
// has a clear "you're carrying X" affordance). When `held` clears
// (drop confirmed or 0x27 reject), the overlay hides.
//
// Implementation note: we render via a fixed-position DOM <div> with
// a <canvas> for the icon. That's simpler than threading a Pixi
// sprite through the various scenes' world / ui containers and it
// renders ON TOP of every gump regardless of which Pixi Application
// owns it.

import { bus } from '../core/event-bus.js';
import { assets } from '../assets/asset-manager.js';
import { displayItemIdForAmount } from '../shared/stack-graphics.js';

const DOM_ID = 'uo-drag-cursor';

class DragCursor {
  constructor() {
    /** @type {HTMLDivElement | null} */
    this._el = null;
    /** @type {HTMLCanvasElement | null} */
    this._canvas = null;
    this._ctx = null;
    this._installed = false;
    /** Last `held` snapshot so we don't re-paint every mousemove. */
    this._currentSerial = 0;
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    this._el = document.createElement('div');
    this._el.id = DOM_ID;
    this._el.style.cssText = `
      position:fixed; z-index:99999; pointer-events:none;
      transform:translate(-50%, -50%); display:none;
      filter: drop-shadow(0 0 4px rgba(255,224,128,0.6));
    `;
    this._canvas = document.createElement('canvas');
    this._canvas.width = 64; this._canvas.height = 64;
    this._ctx = this._canvas.getContext('2d');
    this._el.appendChild(this._canvas);
    document.body.appendChild(this._el);

    bus.on('drag:lifted',    (it) => this._show(it));
    bus.on('drag:dropped',   () => this._hide());
    bus.on('drag:equipped',  () => this._hide());
    bus.on('drag:rejected',  () => this._hide());

    // Follow the mouse — `pointerEvents:none` keeps clicks falling
    // through to the underlying gump / world.
    window.addEventListener('mousemove', (e) => {
      if (!this._el || this._el.style.display === 'none') return;
      this._el.style.left = e.clientX + 'px';
      this._el.style.top  = e.clientY + 'px';
    });
  }

  /** @param {{serial:number,itemId:number,hue:number,amount:number}} item */
  async _show(item) {
    if (!this._el) return;
    if (this._currentSerial === item.serial) {
      this._el.style.display = '';
      return;
    }
    this._currentSerial = item.serial;
    this._el.style.display = '';
    // Pull the static texture from our atlas and rasterise it onto our
    // canvas. Pixi can't share textures with raw 2-D canvases, so we
    // re-decode through `<img>`: blob the atlas page, draw the slice.
    const tex = await assets.staticTexture(displayItemIdForAmount(item.itemId, item.amount));
    if (!tex) return;
    const src = tex.source?.resource;
    if (!(src instanceof HTMLImageElement) && !(src instanceof ImageBitmap)
        && !(src instanceof HTMLCanvasElement)) {
      // Pixi v8 may store the source as an ImageBitmapResource — try
      // its `.image` if present.
      const img = src?.image ?? src?.canvas ?? src;
      if (!img) return;
      this._paint(img, tex.frame);
      return;
    }
    this._paint(src, tex.frame);
  }

  _paint(img, frame) {
    if (!this._ctx) return;
    const w = frame.width, h = frame.height;
    this._canvas.width = w; this._canvas.height = h;
    this._ctx.clearRect(0, 0, w, h);
    try {
      this._ctx.drawImage(img, frame.x, frame.y, w, h, 0, 0, w, h);
    } catch { /* ignore — atlas page may still be loading */ }
  }

  _hide() {
    this._currentSerial = 0;
    if (this._el) this._el.style.display = 'none';
  }
}

export const dragCursor = new DragCursor();
