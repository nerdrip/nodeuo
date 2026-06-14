// ScrollBar — CUO `Game/UI/Controls/ScrollBar.cs`. A self-contained
// vertical scroll bar (track + thumb + up/down arrows). Used by
// `data-box.js`, `journal-gump.js` resizable wrapper, etc.
//
// Behaviour:
//   * up/down arrow buttons step by `step` (default 22 px).
//   * track click (above/below thumb) page-jumps by `pageSize`.
//   * thumb drag scrolls proportionally.
//   * `setRange(min, max, pageSize)` defines the scroll window;
//     `setValue(v)` snaps the thumb; `value` getter returns current.
//   * `onChange(value)` fires after every value change.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';

const TRACK_W   = 14;
const ARROW_H   = 14;

export class ScrollBar extends Control {
  constructor({ height = 200, min = 0, max = 100, value = 0, pageSize = 20, step = 22 } = {}) {
    super();
    this.width = TRACK_W;
    this.height = height;
    this.min = min;
    this.max = max;
    this.pageSize = pageSize;
    this.step = step;
    this._value = clamp(value, min, max);
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this.acceptMouseInput = true;
    this._draw();
  }

  get value() { return this._value; }
  get scrollableRange() { return Math.max(0, this.max - this.min - this.pageSize); }

  setRange(min, max, pageSize) {
    this.min = min;
    this.max = max;
    this.pageSize = pageSize ?? this.pageSize;
    this._value = clamp(this._value, this.min, Math.max(this.min, this.max - this.pageSize));
    this._draw();
  }

  setValue(v) {
    const cap = Math.max(this.min, this.max - this.pageSize);
    const n = clamp(v, this.min, cap);
    if (n === this._value) return;
    this._value = n;
    this._draw();
    this.onChange?.(n);
  }

  scrollBy(delta) { this.setValue(this._value + delta); }

  onMouseDown(_btn, _lx, ly) {
    if (ly < ARROW_H) { this._holdStep(-this.step); return; }
    if (ly > this.height - ARROW_H) { this._holdStep(this.step); return; }
    const { thumbY, thumbH } = this._thumbRect();
    if (ly < thumbY) { this.scrollBy(-this.pageSize); return; }
    if (ly > thumbY + thumbH) { this.scrollBy(this.pageSize); return; }
    this._dragging = true;
    this._dragGrip = ly - thumbY;
  }

  onMouseUp() { this._dragging = false; this._stopHold(); }
  onMouseLeave() { this._dragging = false; this._stopHold(); }

  onMouseMove(_lx, ly) {
    if (!this._dragging) return;
    const trackTop = ARROW_H;
    const trackBot = this.height - ARROW_H;
    const trackH = trackBot - trackTop;
    const { thumbH } = this._thumbRect();
    const usableH = Math.max(1, trackH - thumbH);
    const desiredThumbY = clamp(ly - this._dragGrip, trackTop, trackBot - thumbH);
    const ratio = (desiredThumbY - trackTop) / usableH;
    const cap = Math.max(this.min, this.max - this.pageSize);
    this.setValue(this.min + (cap - this.min) * ratio);
  }

  _holdStep(delta) {
    this.scrollBy(delta);
    this._holdTimer = setTimeout(() => {
      this._holdTimer = setInterval(() => this.scrollBy(delta), 80);
    }, 280);
  }

  _stopHold() {
    if (this._holdTimer) {
      clearTimeout(this._holdTimer);
      clearInterval(this._holdTimer);
      this._holdTimer = null;
    }
  }

  _thumbRect() {
    const trackTop = ARROW_H;
    const trackBot = this.height - ARROW_H;
    const trackH = trackBot - trackTop;
    const total = Math.max(1, this.max - this.min);
    const thumbH = Math.max(16, Math.floor((this.pageSize / total) * trackH));
    const cap = Math.max(this.min, this.max - this.pageSize);
    const range = Math.max(0, cap - this.min);
    const ratio = range > 0 ? (this._value - this.min) / range : 0;
    const usableH = Math.max(0, trackH - thumbH);
    const thumbY = trackTop + Math.round(ratio * usableH);
    return { thumbY, thumbH };
  }

  _draw() {
    const g = this._gfx;
    g.clear();
    // Track
    g.rect(0, 0, this.width, this.height).fill({ color: 0x100a06 }).stroke({ width: 1, color: 0x3a2a14 });
    // Up arrow
    g.rect(0, 0, this.width, ARROW_H).fill({ color: 0x261c10 });
    g.moveTo(this.width / 2, 3).lineTo(this.width - 2, ARROW_H - 3).lineTo(2, ARROW_H - 3).closePath().fill({ color: 0xffe080 });
    // Down arrow
    const dy = this.height - ARROW_H;
    g.rect(0, dy, this.width, ARROW_H).fill({ color: 0x261c10 });
    g.moveTo(this.width / 2, this.height - 3).lineTo(this.width - 2, dy + 3).lineTo(2, dy + 3).closePath().fill({ color: 0xffe080 });
    // Thumb
    const { thumbY, thumbH } = this._thumbRect();
    g.rect(1, thumbY, this.width - 2, thumbH).fill({ color: 0xb88040 }).stroke({ width: 1, color: 0x4a3818 });
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
