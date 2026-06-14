// ScrollFlag — compact CUO-style vertical scroll thumb. It is the small
// movable flag used by Journal/Html/ScrollArea in ClassicUO.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';

const FLAG_W = 14;
const FLAG_H = 16;

export class ScrollFlag extends Control {
  constructor({ height = 120, min = 0, max = 0, value = 0, showTrack = false } = {}) {
    super();
    this.acceptMouseInput = true;
    this.width = FLAG_W;
    this.height = Math.max(FLAG_H, height | 0);
    this.min = min | 0;
    this.max = Math.max(this.min, max | 0);
    this._value = clamp(value | 0, this.min, this.max);
    this.showTrack = !!showTrack;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._dragging = false;
    this._draw();
  }

  get value() { return this._value; }
  get scrollable() { return this.max > this.min; }

  setRange(min, max) {
    this.min = min | 0;
    this.max = Math.max(this.min, max | 0);
    this.setValue(this._value, false);
    this._draw();
  }

  setValue(value, emit = true) {
    const next = clamp(value | 0, this.min, this.max);
    if (next === this._value) return;
    this._value = next;
    this._draw();
    if (emit) this.onChange?.(this._value);
  }

  setSize(w, h) {
    super.setSize(w || FLAG_W, Math.max(FLAG_H, h | 0));
    this._draw();
  }

  sliderY() {
    if (!this.scrollable) return 0;
    const area = Math.max(1, this.height - FLAG_H);
    return Math.round(area * ((this._value - this.min) / (this.max - this.min)));
  }

  onMouseDown(btn, lx, ly) {
    if (btn !== 0 || !this.scrollable) return;
    this._dragging = true;
    this._setByLocalY(ly);
    const onMove = (e) => {
      if (!this._dragging) return;
      const top = this.node.getGlobalPosition?.().y ?? 0;
      this._setByLocalY((e.clientY ?? 0) - top);
    };
    const onUp = () => {
      this._dragging = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  onMouseUp() { this._dragging = false; }

  onWheel(deltaY) {
    const step = Math.max(1, Math.round((this.max - this.min) / 12));
    this.setValue(this._value + (deltaY > 0 ? step : -step));
  }

  _setByLocalY(ly) {
    const area = Math.max(1, this.height - FLAG_H);
    const y = clamp(Math.round(ly - FLAG_H / 2), 0, area);
    const ratio = y / area;
    this.setValue(Math.round(this.min + ratio * (this.max - this.min)));
  }

  _draw() {
    const g = this._gfx;
    g.clear();
    if (this.showTrack) {
      g.rect(FLAG_W / 2 - 1, 0, 2, this.height).fill({ color: 0x1a1208, alpha: 0.65 });
    }
    if (!this.scrollable) return;
    const y = this.sliderY();
    g.roundRect(1, y, FLAG_W - 2, FLAG_H - 2, 2)
      .fill({ color: 0xb88040, alpha: 0.98 })
      .stroke({ width: 1, color: 0x4a3818 });
    g.moveTo(FLAG_W - 2, y + 4)
      .lineTo(FLAG_W + 3, y + FLAG_H / 2)
      .lineTo(FLAG_W - 2, y + FLAG_H - 4)
      .closePath()
      .fill({ color: 0xb88040, alpha: 0.98 })
      .stroke({ width: 1, color: 0x4a3818 });
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
