// UIManager — top-level UI controller. Mirrors ClassicUO's
// Game/Managers/UIManager.cs.
//
// Owns:
//   - the list of open Gumps (Z-ordered, last = top)
//   - mouse routing: hit-test top-down, dispatch enter/leave/click/drag
//   - keyboard focus: one control may have it at a time
//   - drag handling: gumps with `canMove = true` track mouse-down on
//     their drag handle (defaults to whole gump background) and follow
//     subsequent mousemoves until release
//   - page swap requests from buttons inside server gumps
//
// Constructed once, attached to a Pixi Container that lives in the
// scene's UI overlay layer.

import { bus } from '../core/event-bus.js';
import { dragDrop } from '../managers/drag-drop.js';
import { profile } from '../managers/profile-manager.js';
import { uiManagerInstance } from './ui-manager-singleton.js';

// Audit #46 P2 — convenience accessor used by show-modal helpers
// (showMessageBox, showRaceChange, showChatChooseName). Acts as a
// proxy that delegates every call to the *current* scene's UIManager
// (the singleton in `ui-manager-singleton.js`). Calling a method on a
// not-yet-bound singleton is a silent no-op so it's safe to invoke
// from login-scene popups before GameScene mounts.
const UI_PROXY_METHODS = [
  'addGump', 'removeGump', 'findGump', 'bringToFront',
  'setModal', 'clearModal', 'isModalOpen', 'canReceiveInput',
  'show', 'topClosableGump',
];
const _proxy = {};
for (const m of UI_PROXY_METHODS) {
  _proxy[m] = (...args) => {
    const mgr = uiManagerInstance.get();
    if (!mgr) return undefined;
    // `show` is an alias for addGump used by older code paths.
    if (m === 'show') return mgr.addGump?.(...args);
    return typeof mgr[m] === 'function' ? mgr[m](...args) : undefined;
  };
}
export const uiManager = _proxy;

const DOUBLE_CLICK_MS = 350;
// CUO `Constants.MIN_PICKUP_DRAG_DISTANCE_PIXELS = 5`. Below 5 px a
// trembling hand was triggering an unwanted lift and stealing the
// double-click window for items in containers / paperdoll slots.
const DRAG_THRESHOLD_PX = 5;

export class UIManager {
  /** @param {import('pixi.js').Container} parent  the Pixi container we mount gumps under */
  constructor(parent) {
    /** @type {import('pixi.js').Container} */
    this.parent = parent;
    /** @type {import('./gump.js').Gump[]} */
    this.gumps = [];
    /** @type {import('./gump.js').Gump[]} gumps with per-frame tick hooks */
    this.tickGumps = [];
    /** @type {import('./control.js').Control | null} */
    this.focused = null;
    /** @type {import('./control.js').Control | null} */
    this.hovered = null;
    /** @type {{ ctrl: import('./control.js').Control, btn: number, sx: number, sy: number, lx:number, ly:number, t:number, moved:boolean } | null} */
    this._pressed = null;
    /** @type {{ gump: import('./gump.js').Gump, ox: number, oy: number } | null} */
    this._dragging = null;
    /** @type {{ ctrl: import('./control.js').Control, t: number } | null} */
    this._lastClick = null;
    /** dispatcher for `[opcode, params]` button presses inside server-driven gumps */
    this.serverGumpResponder = null;
    // Last mousemove screen coords. Useful for controls whose drag
    // pipeline needs the global cursor position but only receives
    // control-local lx/ly (e.g. the spellbook icon spawning a hotbar
    // shortcut at the press point).
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this._pickVersion = 0;
    this._pickCache = null;
    this._pickControlHit = { control: null, lx: 0, ly: 0 };
    this._pickScreenHit = { gump: null, control: null, lx: 0, ly: 0 };
    this.scale = 1;
    this.setScale(profile.get('ui.scale'));
    this._profileUnsubs = [
      bus.on('profile:changed', ({ path, value } = {}) => {
        if (path === 'ui.scale') this.setScale(value);
      }),
      bus.on('profile:bound', () => this.setScale(profile.get('ui.scale'))),
      bus.on('profile:reset', () => this.setScale(profile.get('ui.scale'))),
    ];

    // Wire DOM events. We listen on `window` so the UI keeps responding
    // even when the cursor leaves the canvas (drag continues past edge).
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mouseup',   this._onMouseUp);
    window.addEventListener('keydown',   this._onKeyDown);
    // Wheel scrolling — route to the topmost gump's ScrollArea (or any
    // control that exposes `onWheel`). Without this, journals / skill
    // lists / option panels could only scroll via the bar handle drag.
    // Listen with `passive:false` so we can call preventDefault and stop
    // the page from scrolling underneath the gump.
    window.addEventListener('wheel', this._onWheel, { passive: false });
  }

  destroy() {
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup',   this._onMouseUp);
    window.removeEventListener('keydown',   this._onKeyDown);
    window.removeEventListener('wheel',     this._onWheel);
    for (const off of this._profileUnsubs ?? []) off?.();
    this._profileUnsubs = [];
    while (this.gumps.length) this.removeGump(this.gumps[this.gumps.length - 1]);
    // The Pixi UI container is reused by the next scene. Do not leak an
    // in-game accessibility zoom into the login scene or loading overlays.
    this.parent?.scale?.set?.(1);
  }

  /** Scale the UI overlay in one place while keeping every gump in its
   * native logical coordinate system. Mouse routing converts back to those
   * coordinates, so buttons, drops and drag offsets stay exact. */
  setScale(value) {
    const n = Number(value);
    const next = Math.max(0.75, Math.min(2, Number.isFinite(n) ? n : 1.25));
    this.scale = Math.round(next * 100) / 100;
    this.parent?.scale?.set?.(this.scale);
    this._invalidatePickCache?.();
  }

  _logicalPoint(sx, sy) {
    const s = this.scale || 1;
    return { x: sx / s, y: sy / s };
  }

  _onWheel = (e) => {
    const hit = this.pickAtScreen(e.clientX, e.clientY);
    if (!hit) return;
    // Walk up from the hit control toward the gump root, looking for
    // the first ancestor that owns an `onWheel` handler. ScrollArea
    // exposes one; bare gump backgrounds don't. Stops the wheel event
    // from bubbling to the page when a gump consumed it.
    let n = hit.control;
    while (n) {
      if (typeof n.onWheel === 'function') {
        try { n.onWheel(e.deltaY, hit.lx, hit.ly); }
        catch (err) { console.error('[ui] onWheel threw', err); }
        e.preventDefault();
        return;
      }
      n = n.parent;
    }
  }

  // -------------------------------------------------------------------------
  // Gump lifecycle

  /** Add a Gump to the UI. New gumps render on top of any existing
   *  ones — push at the end of the children list so the latest open
   *  is the topmost layer. CUO does the same: every newly-opened
   *  gump becomes the focused / topmost panel. */
  addGump(gump) {
    if (this.gumps.includes(gump)) {
      this.bringToFront(gump);
      return gump;
    }
    gump._uiManager = this;
    this.gumps.push(gump);
    this._invalidatePickCache();
    if (typeof gump.tick === 'function') this.tickGumps.push(gump);
    this.parent.addChild(gump.node);
    // Audit #46 P2 — AnchorManager auto-register. Gumps opt out via
    // `anchorable = false` (the AnchorManager checks this). Default-
    // allow lets HealthBar / InfoBar / CounterBar / StatusGump etc.
    // dock without per-gump boilerplate.
    if (gump.anchorable !== false) {
      try {
        // Lazy import to avoid circular: ui-manager → anchor-manager →
        // (potentially) ui-manager. We resolve from globalThis if the
        // module was already loaded by main.js.
        const am = (typeof globalThis !== 'undefined') && globalThis.__anchorManager;
        am?.register?.(gump);
      } catch { /* best-effort */ }
    }
    // Auto-restore the last-known position from localStorage. Subclasses
    // used to opt-in by calling `this.restorePosition()` in their
    // constructor — which a third of them (book, profile, journal,
    // skills, options, …) never did. Running it once here, AFTER the
    // gump's own constructor has settled its default coords, means
    // every gump that exposes a `positionKey` gets sticky positioning
    // for free. Marcin: "żeby gump przy zmianie strony pamiętał swoje
    // położenie na ekranie". `restorePosition` already clamps to the
    // current viewport so a save from a wider monitor still lands the
    // gump on-screen.
    // Constructors have finished adding their synchronous controls at this
    // point. Grow local WindowGumps for accidental child overflow so labels
    // and buttons remain inside their chrome on every DPI/font setup.
    try { gump.fitContentBounds?.(); } catch { /* best-effort */ }
    try { gump.restorePosition?.(); } catch { /* best-effort */ }
    // Explicit bringToFront — addChild already appends but on Pixi
    // containers with sortableChildren the add order doesn't always
    // win z-fighting. The bringToFront call also sets `gump.node.zIndex`.
    this.bringToFront(gump);
    return gump;
  }

  removeGump(gump) {
    const idx = this.gumps.indexOf(gump);
    if (idx < 0) return;
    this.gumps.splice(idx, 1);
    this._invalidatePickCache();
    const tickIdx = this.tickGumps.indexOf(gump);
    if (tickIdx >= 0) this.tickGumps.splice(tickIdx, 1);
    gump._uiManager = null;
    if (this._modalGump === gump) this._modalGump = null;
    if (this.focused && this._isAncestor(gump, this.focused)) this.focused = null;
    if (this.hovered && this._isAncestor(gump, this.hovered)) this.hovered = null;
    // Audit #46 P2 — emit gump:disposed so AnchorManager / other
    // listeners can deregister.
    try { bus.emit('gump:disposed', { gump }); } catch { /* ignore */ }
    gump.dispose();
    // Audit #46 P1#12 — server gump-layout 'mastergump <serial>' binds
    // child gumps to a master so when the master closes its children
    // cascade-close too. CUO `UIManager.cs::OnClose` does the same walk.
    const closingSerial = gump.serial >>> 0;
    if (closingSerial) {
      for (let i = this.gumps.length - 1; i >= 0; i--) {
        const child = this.gumps[i];
        if ((child.masterGumpSerial >>> 0) === closingSerial) this.removeGump(child);
      }
    }
  }

  /**
   * Locate any open gump that matches a predicate (e.g. "this kind, this serial").
   * @returns {import('./gump.js').Gump | undefined}
   */
  findGump(pred) {
    return this.gumps.find(pred);
  }

  bringToFront(gump) {
    const idx = this.gumps.indexOf(gump);
    if (idx < 0) return;
    const alreadyTop = idx === this.gumps.length - 1;
    if (!alreadyTop) {
      this.gumps.splice(idx, 1);
      this.gumps.push(gump);
      this._invalidatePickCache();
      const tickIdx = this.tickGumps.indexOf(gump);
      if (tickIdx >= 0) {
        this.tickGumps.splice(tickIdx, 1);
        this.tickGumps.push(gump);
      }
    }
    if (gump.node.parent !== this.parent) {
      this.parent.addChild(gump.node);
      this._invalidatePickCache();
      return;
    }
    const childTop = this.parent.children[this.parent.children.length - 1] === gump.node;
    if (!childTop) {
      this.parent.removeChild(gump.node);
      this.parent.addChild(gump.node);
      this._invalidatePickCache();
    }
  }

  /** Audit rev.4 P2 — modal gate. CUO `UIManager` has the same idea:
   *  while a modal gump is open, every event is routed to it first and
   *  background gumps don't receive focus / clicks. Use `setModal(g)`
   *  on dialogue gumps (Resurrect prompt, Buy/Sell confirm, etc.) and
   *  `clearModal(g)` when the dialog closes. */
  setModal(gump) {
    this._modalGump = gump || null;
    if (gump) this.bringToFront(gump);
  }

  clearModal(gump) {
    if (!gump || this._modalGump === gump) this._modalGump = null;
  }

  isModalOpen() { return !!this._modalGump; }

  /** Returns true when `gump` is allowed to receive events. False
   *  background gumps while a modal is active. */
  canReceiveInput(gump) {
    return !this._modalGump || this._modalGump === gump;
  }

  /** Audit #33 P2.5 — ESC walks the gump stack top-down for the first
   *  one that opts in via `canCloseWithRMB !== false`. CUO ESC chain
   *  closes the highest closable gump after a target cancel. */
  topClosableGump() {
    for (let i = this.gumps.length - 1; i >= 0; i--) {
      const g = this.gumps[i];
      if (!g) continue;
      if (g.canCloseWithRMB === false) continue;
      return g;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Hit testing

  /**
   * Top-down search: gump → its deepest control under (sx, sy).
   * Returns `{ gump, control, lx, ly }` (lx/ly are control-local), or null.
   */
  pickAtScreen(sx, sy) {
    const ix = sx | 0;
    const iy = sy | 0;
    const cached = this._pickCache;
    if (cached && cached.x === ix && cached.y === iy && cached.version === this._pickVersion) {
      return cached.hit;
    }
    const remember = (hit) => {
      const cache = this._pickCache ?? (this._pickCache = { x: 0, y: 0, version: 0, hit: null });
      cache.x = ix;
      cache.y = iy;
      cache.version = this._pickVersion;
      cache.hit = hit;
      return hit;
    };
    const screenHit = (g, hit) => {
      if (!hit) return null;
      const out = this._pickScreenHit;
      out.gump = g;
      out.control = hit.control;
      out.lx = hit.lx;
      out.ly = hit.ly;
      return out;
    };
    const logical = this._logicalPoint(sx, sy);
    const ux = logical.x;
    const uy = logical.y;
    // Audit #46 P1#15 — modal gate: when a modal is open, only that
    // gump is hittable. Background clicks fall through to world (or
    // nothing) instead of waking buttons/inputs behind the modal.
    if (this._modalGump) {
      const g = this._modalGump;
      if (!g.node.visible) return null;
      if (g.width > 0 && g.height > 0) {
        if (ux < g.x || uy < g.y) return null;
        if (ux >= g.x + g.width || uy >= g.y + g.height) return null;
      }
      const hit = g.pickAt(ux - g.x, uy - g.y, this._pickControlHit);
      return remember(screenHit(g, hit));
    }
    for (let i = this.gumps.length - 1; i >= 0; i--) {
      const g = this.gumps[i];
      if (!g.node.visible) continue;
      // Quick AABB reject — every Gump declares (x, y, width, height)
      // so we can skip the deep hitTest walk for ~95 % of mousemove
      // events that don't hit a gump at all. Cuts the worst-case
      // pickAtScreen from O(gumps × controls) to O(gumps) on idle hovers.
      if (g.width > 0 && g.height > 0) {
        if (ux < g.x || uy < g.y) continue;
        if (ux >= g.x + g.width || uy >= g.y + g.height) continue;
      }
      const hit = g.pickAt(ux - g.x, uy - g.y, this._pickControlHit);
      if (hit) return remember(screenHit(g, hit));
    }
    return remember(null);
  }

  // -------------------------------------------------------------------------
  // Event dispatch

  _isAncestor(maybeAncestor, target) {
    let n = target;
    while (n) {
      if (n === maybeAncestor) return true;
      n = n.parent;
    }
    return false;
  }

  _onMouseMove = (e) => {
    const pointer = this._logicalPoint(e.clientX, e.clientY);
    this.lastMouseX = pointer.x;
    this.lastMouseY = pointer.y;
    if (this._dragging) {
      const g = this._dragging.gump;
      const oldX = g.x | 0, oldY = g.y | 0;
      g.setPosition(pointer.x - this._dragging.ox, pointer.y - this._dragging.oy);
      // Audit #46 P2 — emit per-step delta so AnchorManager can move
      // attached children with the parent in real time.
      const dx = (g.x | 0) - oldX;
      const dy = (g.y | 0) - oldY;
      if (dx || dy) {
        this._invalidatePickCache();
        try { bus.emit('gump:dragged', { gump: g, dx, dy }); } catch { /* ignore */ }
      }
      return;
    }
    const hit = this.pickAtScreen(e.clientX, e.clientY);
    // Notify the system cursor whenever we cross into / out of a gump
    // so it can flip from the directional walk arrow to the default
    // pointer over UI panels. Marcin asked for the cursor to follow
    // what's under it (walk over world, default over gumps).
    const overGump = !!hit;
    if (this._lastOverGump !== overGump) {
      this._lastOverGump = overGump;
      bus.emit('ui:over-gump', { over: overGump });
    }
    if (this._pressed && !this._pressed.moved) {
      const dx = e.clientX - this._pressed.sx;
      const dy = e.clientY - this._pressed.sy;
      if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        // Only suppress the upcoming onClick when the press landed on
        // an actual drag-handle (gump background / title bar / explicit
        // flag). Without this guard a Button received `moved = true`
        // from any tiny cursor jitter and its click was eaten — the
        // paperdoll side buttons looked dead.
        const g = this._gumpOf(this._pressed.ctrl);
        const ctrl = this._pressed.ctrl;
        // Walk the parent chain looking for an `isDragHandle` ancestor
        // (gump bg, title strip, etc) so a click that landed on a
        // decorative child label still drags the gump. Marcin: "drag
        // gumpa z dowolnego miejsca, bo teraz różnie bywa". Skip when
        // the clicked control or any ancestor below the drag handle
        // declares an `onDragStart` of its own — that path is for
        // item-lift drags from slot grids and shouldn't move the gump.
        let dragViaAncestor = false;
        if (g && g.canMove) {
          if (typeof ctrl.onDragStart !== 'function') {
            let n = ctrl;
            while (n && n !== g) {
              if (n.isDragHandle) { dragViaAncestor = true; break; }
              n = n.parent;
            }
            // Gump-level drag too — clicking the background of the
            // gump itself (no interactive control under cursor) drags.
            if (!dragViaAncestor && ctrl === g) dragViaAncestor = true;
          }
        }
        if (dragViaAncestor) {
          this._pressed.moved = true;
          this._dragging = { gump: g, ox: pointer.x - g.x, oy: pointer.y - g.y };
          this.bringToFront(g);
        } else if (typeof ctrl.onDragStart === 'function') {
          // The control wants to participate in drag-with-mouse-down:
          // first cursor movement past DRAG_THRESHOLD asks it to start
          // a drag (e.g. SlotControl issues `dragDrop.tryLift` here
          // instead of on mouse-down). This keeps a quick click → DC
          // path alive: a user double-clicking a slot never crosses
          // the threshold, so `onDragStart` is never called and the
          // click → onDoubleClick path can fire normally.
          this._pressed.moved = true;
          try { ctrl.onDragStart(this._pressed.btn, this._pressed.lx, this._pressed.ly); }
          catch (err) { console.error('[ui] onDragStart threw', err); }
        } else if (dragDrop.isHolding()) {
          // Already-holding case (lift originated elsewhere, e.g.
          // paperdoll re-equip): cursor moved → dispatch onDrop on
          // mouse-up via the moved branch in `_onMouseUp`.
          this._pressed.moved = true;
        }
      }
    }
    // NOTE: do NOT forward onMouseMove to pressed.ctrl here. Different
    // controls use incompatible signatures — ScrollArea expects
    // `(btn, lx, ly)`, ResizeGrip/Worldmap expect `(lx, ly)`. Calling
    // them with the wrong shape silently feeds the btn-byte as lx and
    // turns the drag math into an infinite mutation loop (Marcin
    // reported the whole tab freezing when dragging on a gump element
    // that happened to expose onMouseMove). Drag-aware controls
    // register their own window-level mousemove listener for the
    // duration of the drag — see scroll-area.js onMouseDown.
    const newCtrl = hit?.control ?? null;
    // Cursor-hint dispatch. system-cursor listens for this to flip
    // between the UO default-arrow sprite ('pointer'), the OS I-beam
    // when the cursor sits over a text-entry control ('text'), and
    // any explicit overrides (target reticles, attack cursor) set
    // elsewhere via setOverride.
    const hint = (newCtrl?.acceptKeyboardInput ? 'text' : 'pointer');
    if (hint !== this._lastCursorHint) {
      this._lastCursorHint = hint;
      bus.emit('ui:cursor-hint', { hint });
    }
    if (newCtrl !== this.hovered) {
      // Forward the originating PointerEvent so handlers that anchor a
      // tooltip near the cursor can read `e.global.{x,y}` (or
      // `e.clientX/Y` as a flat fallback). Earlier handlers crashed on
      // `Cannot read properties of undefined (reading 'global')` after
      // the spell-prepare hover triggered `tooltips.showText(e.global.x,
      // ...)` with `e === undefined`.
      const evt = { global: { x: e.clientX, y: e.clientY }, clientX: e.clientX, clientY: e.clientY };
      this.hovered?.onMouseLeave?.(evt);
      this.hovered = newCtrl;
      newCtrl?.onMouseEnter?.(evt);
    }
  };

  _onMouseDown = (e) => {
    const hit = this.pickAtScreen(e.clientX, e.clientY);
    if (!hit) return; // let the world layer handle it
    // Universal RMB-close (CUO behaviour). Right-click on any gump
    // closes it unless the gump explicitly opted out via
    // `canCloseWithRMB = false` (top-bar toolbar, hotbar — anything
    // pinned-by-default). Marcin: "kliknięcie prawym na gumpie
    // zamyka go" — replaces the per-gump close-X chrome we used to
    // mount in the title bar.
    if (e.button === 2 && hit.gump && hit.gump.canCloseWithRMB !== false) {
      e.preventDefault();
      e.stopPropagation();
      try { hit.gump.close?.(); } catch (err) { console.error('[ui] gump.close threw', err); }
      this._pressed = null;
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.bringToFront(hit.gump);
    this.focused = hit.control.acceptKeyboardInput ? hit.control : null;
    this._pressed = {
      ctrl: hit.control, btn: e.button,
      sx: e.clientX, sy: e.clientY,
      lx: hit.lx, ly: hit.ly, t: performance.now(), moved: false,
      // CUO `Game/Managers/StackedSelectionGump.cs` shift+drag on a
      // stackable item pops the split-amount UI. We capture the
      // modifier here so per-slot onDragStart can branch on it.
      shift: !!e.shiftKey, ctrlKey: !!e.ctrlKey, alt: !!e.altKey,
    };
    hit.control.onMouseDown(e.button, hit.lx, hit.ly);
  };

  _onMouseUp = (e) => {
    if (this._dragging) {
      // Persist the gump's new (x, y) so it reopens at the user's last
      // chosen position. `persistPosition` is overridable per-gump for
      // shadow saves (e.g. paperdoll → also save status-bar coords).
      try { this._dragging.gump.persistPosition?.(); } catch { /* ignore */ }
      // Audit #46 P2 — emit gump:dropped for AnchorManager to evaluate
      // snap targets at the drop position.
      try { bus.emit('gump:dropped', { gump: this._dragging.gump }); } catch { /* ignore */ }
      this._dragging = null; this._pressed = null; return;
    }
    if (!this._pressed) return;
    const press = this._pressed;
    this._pressed = null;
    press.ctrl.onMouseUp(press.btn, press.lx, press.ly);
    // Physical-drag drop dispatch. When the user pressed on one control
    // and released over a DIFFERENT one (mouse moved past the drag
    // threshold), invoke `onDrop` on whatever control sits under the
    // release point. This is how UO handles drag-from-pack-to-paperdoll
    // — without this branch the user has to click TWICE (once to lift,
    // once to drop) which doesn't match the "drag-and-drop" mental
    // model players come in with.
    if (press.moved && press.btn === 0) {
      const upHit = this.pickAtScreen(e.clientX, e.clientY);
      let claimed = false;
      if (upHit && upHit.control !== press.ctrl) {
        if (typeof upHit.control.onDrop === 'function') {
          try { upHit.control.onDrop(press.btn, upHit.lx, upHit.ly); }
          catch (err) { console.error('[ui] onDrop threw', err); }
          claimed = true;
        } else {
          // The drop landed on a control with no onDrop handler — walk
          // up the parent chain so a child icon (e.g. ItemPic inside a
          // SlotControl) can be drop-transparent and let the parent
          // SlotControl claim the drop.
          //
          // Translate the screen point to each ancestor's LOCAL space
          // as we walk up — passing 0,0 here used to send every drop
          // to the bag's top-left corner regardless of where the user
          // released, which is the "items appear in another spot"
          // bug Marcin asked us to fix. ContainerGump.onDrop reads
          // these to compute the in-bag pixel coords for the server.
          let n = upHit.control.parent;
          let lx = upHit.lx + upHit.control.x;
          let ly = upHit.ly + upHit.control.y;
          while (n) {
            if (typeof n.onDrop === 'function') {
              try { n.onDrop(press.btn, lx, ly); }
              catch (err) { console.error('[ui] onDrop threw', err); }
              claimed = true;
              break;
            }
            lx += n.x;
            ly += n.y;
            n = n.parent;
          }
        }
      }
      // Drop landed on the world (no control under the cursor, OR a
      // control with no `onDrop` anywhere up its parent chain — e.g.
      // the journal panel or a chat-line label). Fire a dedicated
      // bus event so the scene's drop-on-ground handler can run.
      // Earlier code only emitted when `upHit` was strictly null,
      // which meant any decorative gump body absorbed the drop and
      // the item simply vanished from the cursor with no packet.
      if (!claimed) {
        bus.emit('drag:dropped-on-world', { x: e.clientX, y: e.clientY });
      }
      // Higher-level drag payloads (spells, abilities, future macros) need a
      // deterministic completion signal after the target had a chance to
      // consume them. Item dragging keeps using drag:dropped-on-world above.
      bus.emit('ui:physical-drag-finished', {
        claimed, x: e.clientX, y: e.clientY,
      });
    }
    if (!press.moved) {
      // Drop-on-click while holding: if the user lifted an item from the
      // ground / paperdoll / another bag and clicks on an OPEN gump
      // (e.g. a container body, header, decorative chrome), the press
      // may have landed on a child control with no `onClick` of its
      // own — the bare background sprite, a paperdoll panel, etc. Walk
      // up the parent chain to find the first ancestor that knows how
      // to take the drop, so e.g. clicking anywhere on an open
      // backpack/chest puts the held item inside instead of vanishing
      // into a no-op base-Control.onClick.
      let claimedDrop = false;
      if (press.btn === 0 && dragDrop.isHolding()) {
        let n = press.ctrl;
        let lx = press.lx;
        let ly = press.ly;
        while (n) {
          // Base Control has no onDrop, so any `typeof === 'function'`
          // is an explicit subclass handler (ContainerGump, paperdoll
          // slots, etc).
          if (typeof n.onDrop === 'function') {
            try { n.onDrop(press.btn, lx, ly); }
            catch (err) { console.error('[ui] onDrop threw', err); }
            claimedDrop = true; break;
          }
          // Translate to parent's coord space (same pattern as the
          // drag-release path above) so the (lx, ly) we hand the
          // parent's onDrop is in that parent's local space.
          lx += n.x; ly += n.y;
          n = n.parent;
        }
      }
      if (!claimedDrop) press.ctrl.onClick(press.btn, press.lx, press.ly);
      const now = performance.now();
      if (this._lastClick && this._lastClick.ctrl === press.ctrl
          && now - this._lastClick.t < DOUBLE_CLICK_MS) {
        press.ctrl.onDoubleClick?.(press.btn, press.lx, press.ly);
        this._lastClick = null;
      } else {
        this._lastClick = { ctrl: press.ctrl, t: now };
      }
    }
  };

  _onKeyDown = (e) => {
    if (this.focused) {
      this.focused.onKeyDown(e);
    }
  };

  /** Walk up from a control to find the gump it belongs to. */
  _gumpOf(ctrl) {
    let n = ctrl;
    while (n && n.parent) n = n.parent;
    // Top of UI tree should be a Gump (which has _uiManager).
    return n && n._uiManager ? n : null;
  }

  _invalidatePickCache() {
    this._pickVersion = (this._pickVersion + 1) >>> 0;
    this._pickCache = null;
  }
}
