// UI Control — base class for every widget in the UI tree. Mirrors
// ClassicUO's Game/UI/Controls/Control.cs.
//
// Each control owns a Pixi Container that holds its visual nodes. A
// control is positioned relative to its parent (`x`/`y`); the Pixi
// container's position is updated whenever those change. Children are
// rendered above the parent in the order they were added.
//
// Mouse / keyboard events bubble up through `Control.handleEvent()`. The
// UIManager calls handleEvent for the topmost gump first; bubbling stops
// when a control returns true.

import { Container } from 'pixi.js';
import { AsyncGenerationOwner } from '../shared/runtime-governor.js';

let _nextLocalSerial = 1;

export class Control {
  constructor() {
    this.localSerial = _nextLocalSerial++;
    /** @type {Control | null} */
    this.parent = null;
    /** @type {Control[]} */
    this.children = [];
    this.x = 0;
    this.y = 0;
    this.width = 0;
    this.height = 0;
    this.visible = true;
    this.acceptMouseInput = true;
    this.acceptKeyboardInput = false;
    this.keyboardFocusable = false;
    /** When true, mouse-down on this control starts a gump drag. Default
     *  for ResizePic backgrounds + WindowGump title bars. */
    this.isDragHandle = false;
    this.page = 0;            // belongs to which page; 0 = visible on all
    this._activePage = 0;     // current page filter (set by parent gump)
    /** @type {Container} */
    this.node = new Container();
    this.node._uoControl = this;
    // Every control owns one async generation. Texture/image callbacks must
    // validate it before mutating Pixi state; dispose invalidates all pending
    // work in one place instead of relying on ad-hoc booleans per widget.
    this.asyncOwner = new AsyncGenerationOwner();
  }

  /** Add a child below this control in the tree. */
  add(child) {
    if (!(child instanceof Control)) throw new Error('Control.add expects a Control');
    if (child.parent) child.parent.remove(child);
    child.parent = this;
    this.children.push(child);
    this.node.addChild(child.node);
    child._setActivePage(this._activePage);
    child._applyPosition();
    this._invalidateUiPickCache();
    return child;
  }

  remove(child) {
    const idx = this.children.indexOf(child);
    if (idx < 0) return;
    this.children.splice(idx, 1);
    child.parent = null;
    this.node.removeChild(child.node);
    this._invalidateUiPickCache();
  }

  /** Recursively dispose all children + Pixi nodes. */
  dispose() {
    this.asyncOwner.dispose();
    while (this.children.length) {
      this.children[this.children.length - 1].dispose();
    }
    this.children.length = 0;
    if (this.parent) this.parent.remove(this);
    this.node.destroy({ children: true });
  }

  beginAsyncGeneration() { return this.asyncOwner.invalidate(); }
  captureAsyncGeneration() { return this.asyncOwner.capture(); }
  asyncGenerationValid(generation) { return this.asyncOwner.valid(generation); }

  setPosition(x, y) {
    // Server-authored gumps are untrusted input. Bitwise coercion turns
    // Infinity/NaN into surprising values and very large coordinates can
    // explode Pixi bounds calculations. Keep the useful signed range while
    // preserving legitimate negative art offsets used by classic gumps.
    const nx = Number.isFinite(Number(x))
      ? Math.max(-32768, Math.min(32767, Math.trunc(Number(x)))) : 0;
    const ny = Number.isFinite(Number(y))
      ? Math.max(-32768, Math.min(32767, Math.trunc(Number(y)))) : 0;
    if (nx === this.x && ny === this.y) return;
    this.x = nx;
    this.y = ny;
    this._applyPosition();
    this._invalidateUiPickCache();
  }

  setSize(w, h) {
    const safeSize = (value) => Number.isFinite(Number(value))
      ? Math.max(0, Math.min(8192, Math.trunc(Number(value)))) : 0;
    this.width  = safeSize(w);
    this.height = safeSize(h);
    this.onResize?.();
  }

  _applyPosition() {
    this.node.position.set(this.x, this.y);
  }

  /** Set the active page filter recursively. Controls with `page === 0`
   * are always shown; others only when their `page` matches. */
  setActivePage(page) {
    this._activePage = page;
    this._applyPageVisibility();
    for (const c of this.children) c._setActivePage(page);
  }

  _setActivePage(page) {
    this._activePage = page;
    this._applyPageVisibility();
    for (const c of this.children) c._setActivePage(page);
  }

  _applyPageVisibility() {
    const ok = this.page === 0 || this.page === this._activePage;
    const next = this.visible && ok;
    if (this.node.visible === next) return;
    this.node.visible = next;
    this._invalidateUiPickCache();
  }

  // --- Hit testing ---------------------------------------------------------

  /** Convert a point in the parent's local space to this control's local space. */
  localPointFromParent(px, py) { return { x: px - this.x, y: py - this.y }; }

  /** True if (lx, ly) lies within this control's bounding box (in its
   * own local space). Override for non-rectangular controls. */
  hitTest(lx, ly) {
    return lx >= 0 && ly >= 0 && lx < this.width && ly < this.height;
  }

  /** Find the deepest control under (lx, ly) given in *this* control's
   * local space. Returns `{ control, lx, ly }` (lx/ly local to the hit
   * control), or null if nothing is hit. Visibility-aware. */
  pickAt(lx, ly, out = null) {
    if (!this.node.visible) return null;
    if (!this.hitTest(lx, ly)) return null;
    // Test children in reverse order — newer additions sit "on top".
    for (let i = this.children.length - 1; i >= 0; i--) {
      const c = this.children[i];
      if (!c.acceptMouseInput || !c.node.visible) continue;
      const hit = c.pickAt(lx - c.x, ly - c.y, out);
      if (hit) return hit;
    }
    if (out) {
      out.control = this;
      out.lx = lx;
      out.ly = ly;
      return out;
    }
    return { control: this, lx, ly };
  }

  _invalidateUiPickCache() {
    let n = this;
    while (n?.parent) n = n.parent;
    n?._uiManager?._invalidatePickCache?.();
  }

  // --- Event hooks (override) ---------------------------------------------

  /** Called when a mouse button is pressed inside the control. */
  onMouseDown(_btn, _lx, _ly) {}
  /** Called when a mouse button is released inside the control. */
  onMouseUp(_btn, _lx, _ly) {}
  /** Called for a click (down + up without significant move). */
  onClick(_btn, _lx, _ly) {}
  /** Pointer entered / left. */
  onMouseEnter() {}
  onMouseLeave() {}
  /** Keyboard events. */
  onKeyDown(_e) {}
}
