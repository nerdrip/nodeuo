// SystemCursor — full-time replacement of the OS mouse pointer with the
// UO sprite, mirroring CUO's `GameCursor`. Active in EVERY mode (idle,
// hover, target, drag); the more specialised TargetCursor and DragCursor
// overlays just stack on top.
//
// Behaviour:
//   - Over the gameplay viewport: pick walk-N..walk-NW based on the
//     mouse vector from the player's screen position. Eight buckets,
//     same convention CUO uses.
//   - Over UI panels / outside viewport: `default` arrow.
//   - When `setOverride(name)` is set (target prompt, war attack,
//     hourglass) the override wins.
//
// Sprites come from `assets.cursorsManifest` (extracted by
// `packages/extractor/cursors.js`). Native UO cursor sprites are
// 18..32 px — drawn at scale=1 so they look identical to CUO desktop,
// not the 2× chunky upscale we used briefly. Pixelated CSS keeps the
// few rows of pixels crisp on hi-DPI screens.
//
// Hotspots come from the manifest so click points stay accurate even
// for off-centre cursors (walk arrows have the foot at one corner,
// not the centre).

import { assets } from '../assets/asset-manager.js';
import { camera } from '../renderer/camera.js';
import { bus } from '../core/event-bus.js';
import { world } from '../world/world.js';

const DOM_ID = 'uo-system-cursor';
const SCALE  = 1;             // native UO size, no upscaling

// Atlas label remap. Historically the cursors extractor wrote out the
// wrong sprite under `target-neutral` (it pointed at the open-hand DRAG
// sprite, art-id 0x2072), so we forced every target variant onto the
// `hourglass` entry which actually held the yellow reticle. The
// extractor has been rebuilt since (2026-05-17) and `target-neutral`
// now points at the real crosshair sprite — keeping the legacy remap
// would render an HOURGLASS on every skill / spell target prompt
// (user report 2026-05-17 — "jak jest wybor czegos to ejst zly kursor
// ejst klepsudra zamiast celownika"). Empty map = pass-through, atlas
// keys agree with logical names. harmful / beneficial / self all reuse
// the neutral crosshair sprite + a hue shift; we don't model the hue
// in the atlas, just rely on the body cursor pointing at the right
// graphic so the click hot-spot lands on the cross-hair pixel.
const ATLAS_NAME_REMAP = {
  'target-harmful': 'target-neutral',
  'target-beneficial': 'target-neutral',
  'target-self': 'target-neutral',
  attack: 'target-neutral',
};
function _atlasKey(name) { return ATLAS_NAME_REMAP[name] ?? name; }

/** Per-cursor hot-spot override. The extractor sets `(w/2, h/2)` on
 *  every cursor regardless of meaning; this map points the walking
 *  arrows at their TIP and target reticles at their cross-hair so
 *  click coordinates land on the intended pixel.
 *
 *  Returns absolute pixel offset within the cursor sprite
 *  (already-scaled `w` and `h`).
 */
export function cursorHotspotFor(name, w, h) {
  // Arrow tips for walk-XXX cursors point in the named direction.
  switch (name) {
    case 'walk-n':  return { x: w / 2 | 0, y: 1 };
    case 'walk-ne': return { x: w - 2,     y: 1 };
    case 'walk-e':  return { x: w - 2,     y: h / 2 | 0 };
    case 'walk-se': return { x: w - 2,     y: h - 2 };
    case 'walk-s':  return { x: w / 2 | 0, y: h - 2 };
    case 'walk-sw': return { x: 1,         y: h - 2 };
    case 'walk-w':  return { x: 1,         y: h / 2 | 0 };
    case 'walk-nw': return { x: 1,         y: 1 };
    // Cross-hair reticles centre the click point.
    case 'target-neutral':
    case 'target-harmful':
    case 'target-beneficial':
    case 'target-self':
    case 'attack':
      return { x: w / 2 | 0, y: h / 2 | 0 };
    // Help (pen / scroll), hourglass and the default UO pointer all
    // have their click tip at the top-left of the sprite.
    case 'help':
    case 'hourglass':
    case 'default':
      return { x: 2, y: 2 };
    default:
      return { x: w / 2 | 0, y: h / 2 | 0 };
  }
}

/** Translate a screen-space (dx, dy) vector into one of 8 walk-cursor
 *  names. Same direction grid CUO uses (Animation.cs / GameCursor.cs).
 *  Returns null when the vector is short enough that no direction is
 *  meaningful — caller falls back to `default`. */
export function walkNameFor(dx, dy) {
  const r2 = dx * dx + dy * dy;
  if (r2 < 16 * 16) return null;        // 16-px deadzone around the player
  const a = Math.atan2(dy, dx);          // -pi..pi, 0 = east
  const oct = Math.round(((a + Math.PI) / (Math.PI / 4))) & 7;
  // oct 0 = west; rotate so 0 = east (matches CUO order).
  // Map: 0=W, 1=NW, 2=N, 3=NE, 4=E, 5=SE, 6=S, 7=SW (after the +PI shift)
  const NAMES = ['walk-w', 'walk-nw', 'walk-n', 'walk-ne',
                 'walk-e', 'walk-se', 'walk-s', 'walk-sw'];
  return NAMES[oct];
}

class SystemCursor {
  constructor() {
    this._installed = false;
    /** @type {HTMLDivElement | null} */
    this._el = null;
    /** Last cursor name we painted, so we don't rebuild the canvas every
     *  mousemove. */
    this._currentName = null;
    /** Hotspot offset in already-scaled px. */
    this._hotX = 0;
    this._hotY = 0;
    /** When non-null, overrides the auto-pick (target prompt, attack
     *  prompt, hourglass, etc). */
    this._override = null;
    /** True when UIManager has reported the pointer is over a gump.
     *  Forces `default` instead of walk-XXX. */
    this._overUi = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    this._el = document.createElement('div');
    this._el.id = DOM_ID;
    this._el.style.cssText = `
      position:fixed; z-index:99997; pointer-events:none;
      display:none; transform-origin:0 0;
      image-rendering: pixelated;
      filter: drop-shadow(0 0 1.5px rgba(0,0,0,0.8));
    `;
    document.body.appendChild(this._el);
    document.body.style.cursor = 'none';
    window.addEventListener('mousemove', this._onMove);
    window.addEventListener('mouseleave', this._onLeave);
    this._unsubBus = bus.on('ui:over-gump', ({ over }) => {
      this._overUi = !!over;
      this._applyHintCss();
    });
    this._worldHint = null;
    this._unsubWorldHint = bus.on('world:cursor-hint', ({ name } = {}) => {
      this._worldHint = name || null;
      this._applyHintCss();
    });
    // Hover-derived cursor hint from UIManager. 'text' = the pointer
    // is over a TextInput; we hide our custom UO arrow and let the OS
    // I-beam show through (no clean I-beam sprite ships in the UO
    // atlas, and the OS one matches user expectation for editable
    // fields). 'pointer' = default — show the UO arrow again.
    this._cursorHint = 'pointer';
    this._unsubHint = bus.on('ui:cursor-hint', ({ hint }) => {
      this._cursorHint = hint || 'pointer';
      this._applyHintCss();
    });
    // Loading affordance — show the hourglass cursor while the asset
    // pipeline (or any explicit `loading:start` emitter) reports
    // work-in-progress. Stacks via a simple counter so multiple
    // concurrent loads release cleanly.
    this._loadingDepth = 0;
    this._unsubLoadStart = bus.on('loading:start', () => {
      this._loadingDepth++;
      if (this._loadingDepth === 1) this.setOverride('hourglass');
    });
    this._unsubLoadEnd = bus.on('loading:end', () => {
      if (this._loadingDepth > 0) this._loadingDepth--;
      if (this._loadingDepth === 0) this.setOverride(null);
    });
    this._unsubCursorReady = bus.on('cursors:ready', () => this._paint('default'));
    if (assets.cursorsManifest && assets.cursorsImage?.complete) this._paint('default');
  }

  uninstall() {
    if (!this._installed) return;
    this._installed = false;
    window.removeEventListener('mousemove', this._onMove);
    window.removeEventListener('mouseleave', this._onLeave);
    if (this._el) { this._el.remove(); this._el = null; }
    if (this._unsubBus) { this._unsubBus(); this._unsubBus = null; }
    if (this._unsubHint) { this._unsubHint(); this._unsubHint = null; }
    if (this._unsubWorldHint) { this._unsubWorldHint(); this._unsubWorldHint = null; }
    if (this._unsubLoadStart) { this._unsubLoadStart(); this._unsubLoadStart = null; }
    if (this._unsubLoadEnd)   { this._unsubLoadEnd();   this._unsubLoadEnd = null; }
    if (this._unsubCursorReady) { this._unsubCursorReady(); this._unsubCursorReady = null; }
    document.body.style.cursor = '';
  }

  /** Apply the OS-level cursor style based on the current hint +
   *  context. Three cases:
   *    - 'text'    → OS I-beam (TextInput hover); UO sprite hidden.
   *    - 'pointer' → OS pointer hand (gump hover, "palec wskazujacy");
   *                  UO sprite hidden. This is what the user wants
   *                  for the default outside the game viewport.
   *    - 'arrow'   → OS default arrow (anywhere we can't infer a UO
   *                  sprite — e.g. login screen, no-player).
   *  When _autoNameFor returns a non-null cursor name (walk-XXX inside
   *  the game viewport, or an explicit override), we paint our DOM
   *  sprite on top and set cursor:none. */
  _applyHintCss() {
    if (!this._el) return;
    if (this._cursorHint === 'text') {
      document.body.style.cursor = 'text';
      this._el.style.display = 'none';
      return;
    }
    // Default state — repaint based on cursor under the pointer.
    // Position is in `lastMouseX/Y`; if we haven't received a mouse
    // event yet, leave as-is and wait for the next move.
    const x = this._lastX ?? 0;
    const y = this._lastY ?? 0;
    const name = this._autoNameFor(x, y);
    if (name) {
      document.body.style.cursor = 'none';
      this._paint(name);
    } else {
      // Hide our sprite, let OS cursor show through.
      document.body.style.cursor = this._cursorHint === 'pointer' ? 'pointer' : 'default';
      this._el.style.display = 'none';
    }
  }

  /** Force a specific cursor name (e.g. 'target-neutral' during a
   *  target prompt). Pass null to release. */
  setOverride(name) {
    this._override = name || null;
    this._applyHintCss();
  }

  /** Decide which cursor name fits a given client-space pointer
   *  position. Override wins (target prompt, hourglass during load).
   *  Otherwise: walk-XXX inside the game viewport when the player is
   *  active; null elsewhere — null means "hide our DOM cursor and let
   *  the OS pointer style apply" (handled via `document.body.style.
   *  cursor` in `_applyHintCss`). This gives the user the familiar
   *  hand/pointer cursor over UI panels and the OS arrow outside the
   *  viewport, instead of a UO sprite trying to imitate them. */
  _autoNameFor(clientX, clientY) {
    if (this._override) return this._override;
    // No player → login / character-select / loading. Let the OS
    // pointer drive — no UO sprite.
    if (!world.player) return null;
    // Over a UI gump → OS pointer takes over (sets cursor:pointer in
    // _applyHintCss). Marcin: "ma byc palec wskazujacy" on gumps.
    if (this._overUi) return null;
    // Inside the gameplay rect → directional walk arrow.
    const vx = camera.viewX | 0;
    const vy = camera.viewY | 0;
    const vw = camera.viewW | 0;
    const vh = camera.viewH | 0;
    const inViewport = vw > 0 && vh > 0 &&
      clientX >= vx && clientX <= vx + vw &&
      clientY >= vy && clientY <= vy + vh;
    if (!inViewport) return null;
    if (this._worldHint) return this._worldHint;
    const dx = clientX - (vx + vw / 2);
    const dy = clientY - (vy + vh / 2);
    return walkNameFor(dx, dy) ?? null;
  }

  _paint(name) {
    if (!this._el) return;
    if (name === 'none') {
      this._currentName = name;
      this._el.style.display = 'none';
      document.body.style.cursor = 'none';
      return;
    }
    // Don't paint over the OS I-beam when we're hinted as text-input.
    if (this._cursorHint === 'text') {
      this._el.style.display = 'none';
      this._currentName = name;
      return;
    }
    if (this._currentName === name && this._el.style.display !== 'none') return;
    const atlasName = _atlasKey(name);
    const canvas = assets.paintCursor(atlasName, SCALE);
    if (!canvas) {
      // Atlas not loaded yet — fall back to a tiny SVG arrow so we
      // never display nothing while the cursors atlas streams in.
      this._el.innerHTML = `
        <svg width="20" height="28" viewBox="0 0 20 28">
          <polygon points="2,2 2,22 8,18 12,28 16,26 12,16 20,16"
                   fill="#fff0c0" stroke="#000" stroke-width="1.4" />
        </svg>`;
      this._hotX = 2; this._hotY = 2;
    } else {
      this._el.innerHTML = '';
      this._el.appendChild(canvas);
      const meta = assets.cursorMeta(atlasName);
      // Hot-spot per cursor type — the extractor stamps each manifest
      // entry with a blanket centre point; `_hotspotFor` overrides it
      // with the correct TIP pixel (top-left for default/help/hourglass,
      // edge for walk-XXX arrows, centre for target reticles).
      const w = (meta?.w ?? 16) * SCALE;
      const h = (meta?.h ?? 16) * SCALE;
      const hot = cursorHotspotFor(name, w, h);
      this._hotX = hot.x;
      this._hotY = hot.y;
    }
    this._currentName = name;
    const colorFilter = name === 'target-harmful' || name === 'attack'
      ? 'sepia(1) saturate(7) hue-rotate(315deg)'
      : name === 'target-beneficial' || name === 'target-self'
        ? 'sepia(1) saturate(5) hue-rotate(65deg)'
        : '';
    this._el.style.filter = `${colorFilter} drop-shadow(0 0 1.5px rgba(0,0,0,0.8))`.trim();
    this._el.style.display = '';
  }

  _onMove = (e) => {
    if (!this._el) return;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    // Text-input hint short-circuit — OS I-beam owns the cursor.
    if (this._cursorHint === 'text') {
      this._el.style.display = 'none';
      return;
    }
    const name = this._autoNameFor(e.clientX, e.clientY);
    if (!name) {
      // No UO sprite for this pointer location → let the OS pointer /
      // arrow render directly. Hide our DOM sprite.
      this._el.style.display = 'none';
      document.body.style.cursor = this._cursorHint === 'pointer' ? 'pointer' : 'default';
      return;
    }
    this._paint(name);
    // Position so the hotspot lines up with where the OS cursor would
    // have been. Without the offset the sprite's top-left would track
    // the mouse, which feels off-by-half for centred hotspots.
    document.body.style.cursor = 'none';
    this._el.style.left = (e.clientX - this._hotX) + 'px';
    this._el.style.top  = (e.clientY - this._hotY) + 'px';
  };

  _onLeave = () => {
    if (this._el) this._el.style.display = 'none';
  };
}

export const systemCursor = new SystemCursor();
