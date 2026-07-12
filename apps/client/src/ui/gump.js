// Gump — base class for any pop-up window. Mirrors ClassicUO's
// Game/UI/Gumps/Gump.cs.
//
// A Gump is just a top-level Control with extra metadata:
//   - server / local serial pair (for server-driven gumps via 0xB0/0xDD)
//   - draggability (canMove)
//   - close behaviour (canClose / canCloseWithEsc / canCloseWithRMB)
//   - page state (multi-page gumps swap pages via Button switchPage)
//
// Add a gump via UIManager.addGump(g); when its server-driven response is
// needed (button click), the gump dispatches via uiManager.serverGumpResponder.

import { Control } from './control.js';

let _nextLocalSerial = 0xC0000000 >>> 0;

const POS_STORAGE_KEY = 'uo.gump-positions';

let _positionCache = null;
let _positionCacheLoaded = false;

function readPositionCache() {
  if (_positionCacheLoaded) return _positionCache;
  _positionCacheLoaded = true;
  try {
    const raw = localStorage.getItem(POS_STORAGE_KEY);
    _positionCache = raw ? JSON.parse(raw) : {};
    if (!_positionCache || typeof _positionCache !== 'object' || Array.isArray(_positionCache)) {
      _positionCache = {};
    }
  } catch {
    _positionCache = {};
  }
  return _positionCache;
}

function writePositionCache(cache) {
  try {
    localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(cache));
  } catch { /* ignore */ }
}

/** Read the persisted (x, y) for a gump key, or null if never moved. */
export function readGumpPosition(key) {
  try {
    const all = readPositionCache();
    const v = all?.[key];
    if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return v;
  } catch { /* ignore */ }
  return null;
}
/** Persist (x, y) for a gump key. Best-effort — quota errors are silent. */
export function writeGumpPosition(key, x, y) {
  try {
    const all = readPositionCache();
    all[key] = { x: x | 0, y: y | 0 };
    writePositionCache(all);
  } catch { /* ignore */ }
}

export function resetGumpPositionCacheForTests() {
  _positionCache = null;
  _positionCacheLoaded = false;
}

export class Gump extends Control {
  constructor() {
    super();
    /** @type {number} */
    this.serverSerial = 0;
    /** @type {number} */
    this.gumpSerial = (_nextLocalSerial++) >>> 0;
    this.canMove = true;
    this.canClose = true;
    this.canCloseWithEsc = true;
    this.canCloseWithRMB = true;
    /** @type {import('./ui-manager.js').UIManager | null} */
    this._uiManager = null;
    /** active page (0 = page 0; controls with page=0 always show) */
    this.activePage = 0;
  }

  setActivePage(page) {
    this.activePage = page | 0;
    super.setActivePage(this.activePage);
  }

  /** @returns {string} useful for findGump predicates */
  get type() { return 'generic'; }

  /** Storage key for position memo. Override for per-instance memo
   *  (containers use the serial; paperdoll uses just the type). */
  get positionKey() { return this.type; }

  /** Restore last-known position for this gump's storage key. Subclasses
   *  call this from their constructor AFTER the default `setPosition`
   *  sets fallback coords, so a never-moved gump keeps its initial
   *  layout. Position is saved by `UIManager` on drag-end, not on every
   *  setPosition call (constructors otherwise overwrite the memo). */
  restorePosition() {
    const v = readGumpPosition(this.positionKey);
    if (!v) return;
    // Clamp to current window bounds so a position saved from a larger
    // monitor (or one where the user dragged the gump mostly off-screen)
    // doesn't restore us where only a sliver pokes into view. Marcin:
    // "paperdoll przyciski poustawiane zle — PEACE/STATUS w rogu" —
    // the paperdoll had been saved at y≈-200, so only slots 6/7 (the
    // bottom of the side-button strip) peeked into the visible
    // viewport. Rules:
    //   • Top edge stays at y ≥ 0  (drag handle / title always visible)
    //   • Right edge stays at x + w ≤ ww (gump fully on screen if it
    //     fits; otherwise its LEFT edge is anchored at x ≥ 0)
    //   • Same vertical clamp if it fits, else top-anchored at y=0
    const scale = this._uiManager?.scale || 1;
    const ww = (window.innerWidth  || 1024) / scale;
    const wh = (window.innerHeight || 768) / scale;
    const w  = this.width  || 100;
    const h  = this.height || 100;
    let x = v.x | 0;
    let y = v.y | 0;
    if (w <= ww) x = Math.max(0, Math.min(ww - w, x));
    else         x = Math.max(ww - w, Math.min(0, x));
    if (h <= wh) y = Math.max(0, Math.min(wh - h, y));
    else         y = Math.max(wh - h, Math.min(0, y));
    super.setPosition(x, y);
  }

  /** Manager calls this on drag-end. Subclasses can override for custom
   *  logic (e.g., paperdoll: also save the matching status-bar position). */
  persistPosition() {
    if (this.positionKey) writeGumpPosition(this.positionKey, this.x, this.y);
  }

  /** Close (remove) self via the manager. */
  close() {
    if (this._uiManager) this._uiManager.removeGump(this);
  }

  /** Send a server-gump response. payload is the {buttonId, switches, textEntries}
   *  shape expected by the 0xB1 builder.
   */
  respond(payload) {
    this._uiManager?.serverGumpResponder?.({
      gumpSerial: this.gumpSerial, serverSerial: this.serverSerial, ...payload,
    });
  }
}
