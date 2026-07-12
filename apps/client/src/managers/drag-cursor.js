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
const pngPages = new Map();

function drawableFromTexture(tex) {
  const root = tex?.source?.resource ?? tex?.source ?? tex?.baseTexture?.resource;
  const candidates = [root, root?.source, root?.resource, root?.image, root?.canvas, root?.bitmap];
  for (const value of candidates) {
    if (!value) continue;
    if (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) return value;
    if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) return value;
    if (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement) return value;
    if (typeof OffscreenCanvas !== 'undefined' && value instanceof OffscreenCanvas) return value;
  }
  return null;
}

function pngPageFor(tex) {
  const raw = String(tex?._uoAtlasPageUrl ?? '');
  if (!raw) return Promise.resolve(null);
  const url = raw.replace(/\.ktx2$/i, '.png');
  let pending = pngPages.get(url);
  if (pending) return pending;
  pending = new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  pngPages.set(url, pending);
  return pending;
}

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
    this._paintToken = 0;
    this._lastX = Math.round(window.innerWidth / 2);
    this._lastY = Math.round(window.innerHeight / 2);
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
    window.addEventListener('pointermove', (e) => {
      this._lastX = e.clientX; this._lastY = e.clientY;
      if (!this._el || this._el.style.display === 'none') return;
      this._position();
    }, { capture: true, passive: true });
  }

  _position() {
    if (!this._el) return;
    // Slight lower-right offset keeps the pointer hotspot visible while the
    // held art itself remains centred on the intended drop point.
    this._el.style.left = `${this._lastX + 8}px`;
    this._el.style.top  = `${this._lastY + 8}px`;
  }

  /** @param {{serial:number,itemId:number,hue:number,amount:number}} item */
  async _show(item) {
    if (!this._el) return;
    if (this._currentSerial === item.serial) {
      this._el.style.display = '';
      return;
    }
    this._currentSerial = item.serial;
    const token = ++this._paintToken;
    this._el.style.display = '';
    this._position();
    this._ctx?.clearRect?.(0, 0, this._canvas.width, this._canvas.height);
    // Pull the static texture from our atlas and rasterise it onto our
    // canvas. Pixi can't share textures with raw 2-D canvases, so we
    // re-decode through `<img>`: blob the atlas page, draw the slice.
    const tex = await assets.staticTexture(displayItemIdForAmount(item.itemId, item.amount));
    if (!tex || token !== this._paintToken || this._currentSerial !== item.serial) return;
    const drawable = drawableFromTexture(tex);
    if (drawable && this._paint(drawable, tex.frame)) return;
    // Production prefers KTX2 atlas pages. Compressed GPU resources cannot
    // be passed to CanvasRenderingContext2D, so use the matching PNG page
    // solely for the cursor preview (browser cache makes subsequent lifts
    // free). The old code swallowed drawImage's exception and left an empty
    // cursor while the real item had already vanished from its bag.
    const png = await pngPageFor(tex);
    if (!png || token !== this._paintToken || this._currentSerial !== item.serial) return;
    this._paint(png, tex.frame);
  }

  _paint(img, frame) {
    if (!this._ctx || !frame) return false;
    const w = frame.width, h = frame.height;
    this._canvas.width = w; this._canvas.height = h;
    this._ctx.clearRect(0, 0, w, h);
    try {
      this._ctx.drawImage(img, frame.x, frame.y, w, h, 0, 0, w, h);
      return true;
    } catch { return false; }
  }

  _hide() {
    this._currentSerial = 0;
    this._paintToken++;
    if (this._el) this._el.style.display = 'none';
  }
}

export const dragCursor = new DragCursor();
