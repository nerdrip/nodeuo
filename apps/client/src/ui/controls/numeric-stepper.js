// NumericStepper — +/- value control. Mirrors ClassicUO
// `Game/UI/Controls/NumericStepper.cs` (small numeric input with
// two arrows and a label).

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';

export class NumericStepper extends Control {
  constructor({ width = 80, height = 22, min = 0, max = 100, value = 0, step = 1 } = {}) {
    super();
    this.width = width;
    this.height = height;
    this.min = min;
    this.max = max;
    this.step = step;
    this._value = Math.max(min, Math.min(max, value));
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._lbl = new Label(String(this._value), { fontSize: 11, hue: 0xe8d0a0 });
    this._lbl.setPosition(8, 4);
    this.node.addChild(this._lbl.node);
    this.acceptMouseInput = true;
    this._draw();
  }

  get value() { return this._value; }

  setValue(v) {
    const next = Math.max(this.min, Math.min(this.max, v));
    if (next === this._value) return;
    this._value = next;
    this._lbl.setText(String(next));
    this._draw();
    this.onChange?.(next);
  }

  onMouseDown(_btn, lx) {
    // Right third = '+'; middle third = ignore; left third (of arrow zone) = '-'.
    const arrowX = this.width - 24;
    if (lx >= arrowX && lx < arrowX + 12) this.setValue(this._value + this.step);
    else if (lx >= arrowX + 12) this.setValue(this._value - this.step);
  }

  _draw() {
    const g = this._gfx;
    g.clear();
    g.rect(0, 0, this.width, this.height)
      .fill({ color: 0x1c1612 })
      .stroke({ width: 1, color: 0x4a3818 });
    // '+' button
    const ax = this.width - 24;
    g.rect(ax, 1, 12, this.height - 2).fill({ color: 0x3a2a14, alpha: 0.95 });
    g.moveTo(ax + 6, 5).lineTo(ax + 6, this.height - 5).stroke({ width: 1, color: 0xfff0c0 });
    g.moveTo(ax + 2, this.height / 2).lineTo(ax + 10, this.height / 2).stroke({ width: 1, color: 0xfff0c0 });
    // '-' button
    g.rect(ax + 12, 1, 12, this.height - 2).fill({ color: 0x3a2a14, alpha: 0.95 });
    g.moveTo(ax + 14, this.height / 2).lineTo(ax + 22, this.height / 2).stroke({ width: 1, color: 0xfff0c0 });
  }
}
