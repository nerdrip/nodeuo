// ArrowNumbersTextBox — CUO `Game/UI/Controls/ArrowNumbersTextBox.cs`.
// A numeric text-entry that combines a typeable input with a pair of
// up/down arrow buttons on the right. Click-and-hold on either arrow
// auto-repeats (~7 Hz after a 350 ms first-step delay), matching CUO
// behaviour for big stat ranges (e.g. property-search filters).
//
// Differences vs CUO: we sit on top of an HTMLInputElement so the
// browser handles caret / IME / clipboard. The UO chrome is rendered in
// Pixi underneath and the arrow buttons are also Pixi (single GFX call).

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { TextInput } from './text-input.js';

export class ArrowNumbersTextBox extends Control {
  constructor({ width = 90, height = 22, min = 0, max = 9999, value = 0, step = 1 } = {}) {
    super();
    this.width = width;
    this.height = height;
    this.min = min;
    this.max = max;
    this.step = step;
    this._value = clamp(value, min, max);
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);

    // Text input occupies width - 14 (arrow column).
    this._input = new TextInput({ width: width - 16, height: height - 2, numeric: true });
    this._input.setPosition(1, 1);
    this._input.setText(String(this._value));
    this._input.onChange = (t) => {
      const n = parseInt(t, 10);
      if (Number.isFinite(n)) this._setSilent(clamp(n, this.min, this.max));
    };
    this.node.addChild(this._input.node);
    this.acceptMouseInput = true;
    this._draw();
  }

  get value() { return this._value; }

  setValue(v) {
    const n = clamp(v | 0, this.min, this.max);
    if (n === this._value) return;
    this._value = n;
    this._input.setText(String(n));
    this.onChange?.(n);
  }

  _setSilent(v) {
    if (v === this._value) return;
    this._value = v;
    this.onChange?.(v);
  }

  onMouseDown(_btn, lx, ly) {
    const ax = this.width - 14;
    if (lx < ax) return;
    const half = this.height / 2;
    const up = ly < half;
    const apply = () => this.setValue(this._value + (up ? this.step : -this.step));
    apply();
    this._repeat = setTimeout(() => {
      this._repeat = setInterval(apply, 140);
    }, 350);
  }

  onMouseUp() { this._clearRepeat(); }
  onMouseLeave() { this._clearRepeat(); }

  _clearRepeat() {
    if (this._repeat) { clearTimeout(this._repeat); clearInterval(this._repeat); this._repeat = null; }
  }

  _draw() {
    const g = this._gfx;
    g.clear();
    g.rect(0, 0, this.width, this.height)
      .fill({ color: 0x140e08 })
      .stroke({ width: 1, color: 0x4a3818 });
    const ax = this.width - 14;
    g.rect(ax, 1, 13, this.height - 2).fill({ color: 0x261c10 });
    // Up triangle
    g.moveTo(ax + 6, 3).lineTo(ax + 11, 9).lineTo(ax + 1, 9).closePath().fill({ color: 0xffe080 });
    // Down triangle
    const y0 = this.height - 9;
    g.moveTo(ax + 6, y0 + 6).lineTo(ax + 11, y0).lineTo(ax + 1, y0).closePath().fill({ color: 0xffe080 });
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
