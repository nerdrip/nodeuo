// HSliderBar — horizontal slider with label + numeric readout.
// Mirrors ClassicUO `Game/UI/Controls/HSliderBar.cs`.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';

export class HSliderBar extends Control {
  constructor({ width = 160, min = 0, max = 100, value = 0, step = 1, label = '', showValue = true } = {}) {
    super();
    this.width = width;
    this.height = 22;
    this.min = min;
    this.max = max;
    this.step = step;
    this._value = Math.max(min, Math.min(max, value));
    this._label = label;
    this._showValue = showValue;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    if (label) {
      this._lblText = new Label(label, { fontSize: 11, hue: 0xe8d0a0 });
      this._lblText.setPosition(0, -14);
      this.node.addChild(this._lblText.node);
    }
    if (showValue) {
      this._valText = new Label(String(value), { fontSize: 11, hue: 0xffe080 });
      this._valText.setPosition(width + 6, 4);
      this.node.addChild(this._valText.node);
    }
    this.acceptMouseInput = true;
    this._draw();
  }

  get value() { return this._value; }

  setValue(v) {
    const next = Math.max(this.min, Math.min(this.max, v));
    if (next === this._value) return;
    this._value = next;
    this._draw();
    this.onChange?.(next);
  }

  onMouseDown(_btn, lx) { this._dragSet(lx); this._dragging = true; }
  onMouseUp() { this._dragging = false; }
  onMouseMove(lx) { if (this._dragging) this._dragSet(lx); }

  _dragSet(lx) {
    const ratio = Math.max(0, Math.min(1, lx / this.width));
    const raw = this.min + (this.max - this.min) * ratio;
    const stepped = Math.round(raw / this.step) * this.step;
    this.setValue(stepped);
  }

  _draw() {
    const g = this._gfx;
    g.clear();
    // Track
    g.rect(0, 8, this.width, 6).fill({ color: 0x140e08 }).stroke({ width: 1, color: 0x3a2a14 });
    // Fill
    const ratio = (this._value - this.min) / Math.max(1, this.max - this.min);
    g.rect(0, 8, this.width * ratio, 6).fill({ color: 0xb88040 });
    // Knob
    const kx = this.width * ratio;
    g.circle(kx, 11, 6).fill({ color: 0xffd06a }).stroke({ width: 1, color: 0x4a3818 });
    if (this._valText) this._valText.setText(String(this._value));
  }
}
