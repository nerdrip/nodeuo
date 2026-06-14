// ResizableGump — WindowGump variant with a draggable bottom-right resize
// grip. Mirrors ClassicUO Game/UI/Gumps/ResizableGump.cs which wraps any
// content control in a parchment frame plus a corner handle that the user
// can drag to expand the window. Used by ResizableJournal, BulletinBoard
// and the Skills gump in CUO; we extend it here so future gumps (custom
// container windows, reports panels) get free resize behaviour.
//
// Design:
//   - inherits WindowGump's parchment + title + close button
//   - adds a 12×12 grip in the lower-right quadrant
//   - while held, mousemove deltas are added to width/height
//   - subclass overrides `onResize(w, h)` to relayout content
//   - clamps to {minW, minH} and {maxW, maxH}
//
// All sizes round to whole pixels (CUO does the same; sub-pixel sprites
// look fuzzy at small scales).

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Control } from '../control.js';

class ResizeGrip extends Control {
  constructor({ size = 12, onDrag, onEnd }) {
    super();
    this.width = size;
    this.height = size;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._dragging = false;
    this._lastX = 0; this._lastY = 0;
    this._onDrag = onDrag;
    this._onEnd = onEnd;
    this.acceptMouseInput = true;
    this._draw();
  }
  _draw() {
    // Subtle diagonal hatch — same look as CUO's corner grip.
    this._gfx.clear();
    this._gfx.rect(0, 0, this.width, this.height).fill({ color: 0x000000, alpha: 0.0 });
    for (let i = 2; i < this.width; i += 3) {
      this._gfx.moveTo(i, this.height - 1)
        .lineTo(this.width - 1, i)
        .stroke({ width: 1, color: 0xb09870, alpha: 0.7 });
    }
  }
  onMouseDown(_btn, lx, ly) {
    this._dragging = true;
    this._lastX = lx;
    this._lastY = ly;
    return true;
  }
  onMouseMove(lx, ly) {
    if (!this._dragging) return;
    const dx = lx - this._lastX, dy = ly - this._lastY;
    this._lastX = lx; this._lastY = ly;
    this._onDrag?.(dx, dy);
  }
  onMouseUp() {
    if (!this._dragging) return;
    this._dragging = false;
    this._onEnd?.();
  }
}

export class ResizableGump extends WindowGump {
  constructor(opts = {}) {
    super(opts);
    this._minW = opts.minW ?? 160;
    this._minH = opts.minH ?? 120;
    this._maxW = opts.maxW ?? 800;
    this._maxH = opts.maxH ?? 600;

    this._grip = new ResizeGrip({
      size: 12,
      onDrag: (dx, dy) => this._applyResize(dx, dy),
      onEnd: () => this._onResizeEnd(),
    });
    this._positionGrip();
    this.add(this._grip);
  }

  _positionGrip() {
    this._grip.setPosition(this._w - this._grip.width - 2, this._h - this._grip.height - 2);
  }

  _applyResize(dx, dy) {
    const w = Math.max(this._minW, Math.min(this._maxW, (this._w + dx) | 0));
    const h = Math.max(this._minH, Math.min(this._maxH, (this._h + dy) | 0));
    if (w === this._w && h === this._h) return;
    this._w = w; this._h = h;
    this.setSize(w, h);
    if (this._bg) this._bg.setSize?.(w, h);
    if (this._close) this._close.setPosition(w - 18, 4);
    this._positionGrip();
    this.onResize(w, h);
  }

  _onResizeEnd() {
    // Hook for subclasses that want to persist the new size.
    this.onResizeEnd?.(this._w, this._h);
  }

  /** Override in subclass to relayout children. Default: no-op. */
  onResize(_w, _h) {}
}
