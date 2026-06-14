// ScrollArea — a clipped viewport with a vertical scrollbar. Mirrors
// ClassicUO's Game/UI/Controls/ScrollArea.cs.
//
// Children are added under `content` (the scrollable inner container).
// The viewport mask uses Pixi's mask system; the bar position drives the
// content's translation.

import { Container, Graphics } from 'pixi.js';
import { Control } from '../control.js';

const BAR_W = 14;
const HANDLE_MIN_H = 16;

export class ScrollArea extends Control {
  constructor({ width = 200, height = 120, contentHeight = 0 } = {}) {
    super();
    this.width = width;
    this.height = height;

    this._mask = new Graphics();
    this._content = new Container();
    this._content.mask = this._mask;
    this._bar = new Graphics();
    this._handle = new Graphics();

    this.node.addChild(this._mask, this._content, this._bar, this._handle);

    this._scrollY = 0;
    this._contentH = contentHeight | 0;
    this._dragging = false;
    this._dragStartY = 0;
    this._dragStartScroll = 0;
    this._bulkDepth = 0;
    this._bulkDirty = false;

    this._draw();
  }

  get content() { return this._content; }
  get scrollY() { return this._scrollY; }
  get contentHeight() { return this._contentH; }

  /** Add a child Control inside the clipped scroll content. */
  add(child) {
    if (!(child instanceof Control)) throw new Error('ScrollArea.add expects a Control');
    if (child.parent) child.parent.remove(child);
    child.parent = this;
    this.children.push(child);
    this._content.addChild(child.node);
    child._setActivePage(this._activePage);
    child._applyPosition();
    this._afterContentMutation(false);
    return child;
  }

  addControl(child) { return this.add(child); }

  remove(child) {
    const idx = this.children.indexOf(child);
    if (idx < 0) return;
    this.children.splice(idx, 1);
    child.parent = null;
    if (child.node.parent === this._content) {
      this._content.removeChild(child.node);
    } else if (child.node.parent === this.node) {
      this.node.removeChild(child.node);
    }
    this._afterContentMutation(true);
  }

  /** Add a child node directly inside the clipped scroll content. */
  addContent(node) {
    if (node instanceof Control) return this.add(node);
    this._content.addChild(node);
    this._afterContentMutation(false);
    return node;
  }

  beginBulkUpdate() {
    this._bulkDepth++;
  }

  endBulkUpdate() {
    if (this._bulkDepth <= 0) return;
    this._bulkDepth--;
    if (this._bulkDepth === 0 && this._bulkDirty) {
      this._bulkDirty = false;
      this._measureContent();
      this._setScroll(this._scrollY);
      this._draw();
    }
  }

  _afterContentMutation(clampScroll) {
    if (this._bulkDepth > 0) {
      this._bulkDirty = true;
      return;
    }
    this._measureContent();
    if (clampScroll) this._setScroll(this._scrollY);
    this._draw();
  }

  setContentHeight(h) {
    this._contentH = Math.max(0, h | 0);
    this._setScroll(this._scrollY);
    this._draw();
  }

  setContentSize(_w, h) { this.setContentHeight(h); }

  setSize(w, h) { super.setSize(w, h); this._draw(); }

  /** True iff our Pixi Graphics children are still alive. Window-bound
   *  pointerup handlers (e.g. SkillsGump per-row drag) can fire AFTER
   *  the parent gump was closed and our Graphics.destroy() ran; the
   *  next `_draw()` would then call `clear()` on a null context and
   *  blow up the render loop. Callers should bail when this is false. */
  _isAlive() {
    return !!(this._mask && !this._mask.destroyed
           && this._bar  && !this._bar.destroyed);
  }

  _measureContent() {
    let max = 0;
    for (const c of this.children) {
      if (!c?.node || c.node.destroyed) continue;
      if (c.y + c.height > max) max = c.y + c.height;
    }
    for (const c of this._content.children) {
      if (!c || c.destroyed) continue;
      if (c._uoControl?.parent === this) continue;
      let bottom = 0;
      if (typeof c.getLocalBounds === 'function') {
        const b = c.getLocalBounds();
        bottom = (c.position?.y ?? c.y ?? 0) + b.y + b.height;
      } else if (typeof c.getBounds === 'function') {
        const b = c.getBounds();
        bottom = b.y + b.height;
      }
      if (bottom > max) max = bottom;
    }
    this._contentH = Math.ceil(max);
  }

  _viewportH() { return this.height; }
  _viewportW() { return this.width - BAR_W; }

  _maxScroll() { return Math.max(0, this._contentH - this._viewportH()); }

  /** scrollY is in content pixels (positive = scroll down). */
  scrollBy(dy) { this._setScroll(this._scrollY + dy); }
  scrollTo(y)  { this._setScroll(y); }
  _setScroll(y) {
    const max = this._maxScroll();
    const next = Math.max(0, Math.min(max, y));
    if (next === this._scrollY) {
      this._content.position.y = -this._scrollY;
      this._drawHandle();
      return;
    }
    this._scrollY = next;
    this._content.position.y = -this._scrollY;
    this._drawHandle();
    try { this.onScroll?.(this._scrollY); } catch { /* ignore */ }
  }

  _draw() {
    // Bail on post-destroy reentry — see `_isAlive()`.
    if (!this._isAlive()) return;
    // Clip mask (also acts as the inner background).
    this._mask.clear();
    this._mask.rect(0, 0, this._viewportW(), this._viewportH()).fill(0xffffff);
    // Bar background.
    this._bar.clear();
    this._bar.rect(this.width - BAR_W, 0, BAR_W, this.height)
             .fill({ color: 0x0a0a0a, alpha: 0.8 })
             .stroke({ width: 1, color: 0x4a3818, alpha: 0.7 });
    this._drawHandle();
  }

  _drawHandle() {
    if (!this._handle || this._handle.destroyed) return;
    const max = this._maxScroll();
    const ratio = max > 0 ? this._viewportH() / (this._contentH || 1) : 1;
    const handleH = Math.max(HANDLE_MIN_H, Math.round(this._viewportH() * ratio));
    const trackH = this._viewportH() - handleH;
    const y = max > 0 ? Math.round(trackH * (this._scrollY / max)) : 0;
    this._handle.clear();
    this._handle.roundRect(this.width - BAR_W + 2, y, BAR_W - 4, handleH, 2)
                .fill({ color: 0x6e5520, alpha: 0.95 });
  }

  hitTest(lx, ly) { return lx >= 0 && ly >= 0 && lx < this.width && ly < this.height; }

  pickAt(lx, ly, out = null) {
    if (!this.node.visible) return null;
    if (!this.hitTest(lx, ly)) return null;
    if (lx < this._viewportW()) {
      const cy = ly + this._scrollY;
      for (let i = this.children.length - 1; i >= 0; i--) {
        const c = this.children[i];
        if (!c.acceptMouseInput || !c.node.visible) continue;
        const hit = c.pickAt(lx - c.x, cy - c.y, out);
        if (hit) return hit;
      }
    }
    if (out) {
      out.control = this;
      out.lx = lx;
      out.ly = ly;
      return out;
    }
    return { control: this, lx, ly };
  }

  onMouseDown(_btn, lx, ly) {
    if (lx < this.width - BAR_W) return;
    // Click on the scrollbar. Anywhere outside the handle = jump-
    // scroll one viewport; click on the handle starts a drag.
    const max = this._maxScroll();
    const ratio = max > 0 ? this._viewportH() / (this._contentH || 1) : 1;
    const handleH = Math.max(HANDLE_MIN_H, Math.round(this._viewportH() * ratio));
    const handleTop = max > 0 ? (this._scrollY / max) * (this._viewportH() - handleH) : 0;
    if (ly < handleTop || ly > handleTop + handleH) {
      this._setScroll(this._scrollY + (ly < handleTop ? -this._viewportH() : this._viewportH()));
      return;
    }
    // Begin handle drag. Register window-level move/up listeners for
    // the lifetime of the drag — UIManager doesn't dispatch
    // onMouseMove to arbitrary controls (different controls use
    // incompatible signatures and feeding them mismatched args froze
    // the page when ResizeGrip/Worldmap received btn-byte as lx).
    // Mirrors how a gump's drag-handle is handled inside UIManager.
    this._dragging = true;
    this._dragStartScreenY = 0;
    this._dragStartScroll = this._scrollY;
    const onMove = (e) => {
      if (!this._dragging) return;
      const cur = e.clientY ?? 0;
      if (this._dragStartScreenY === 0) this._dragStartScreenY = cur;
      const max2 = this._maxScroll();
      if (max2 <= 0) return;
      const ratio2 = this._viewportH() / (this._contentH || 1);
      const handleH2 = Math.max(HANDLE_MIN_H, Math.round(this._viewportH() * ratio2));
      const trackH = this._viewportH() - handleH2;
      if (trackH <= 0) return;
      const dy = cur - this._dragStartScreenY;
      this._setScroll(this._dragStartScroll + (dy / trackH) * max2);
    };
    const onUp = () => {
      this._dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Hook up wheel scrolling on the host gump or scene as desired.
  onWheel(deltaY) { this._setScroll(this._scrollY + deltaY); }
}
