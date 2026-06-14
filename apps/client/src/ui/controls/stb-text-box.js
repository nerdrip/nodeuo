// StbTextBox — styled UO chrome text input. Mirrors ClassicUO
// `Game/UI/Controls/StbTextBox.cs` at MVP scope.
//
// Wraps a TextInput with a parchment-styled border so it fits the
// UO chrome (used by HealthBarGumpCustom name field, rename dialog,
// chat input). Plain TextInput is functionally fine but visually
// breaks the gold-on-leather palette every other gump uses.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { TextInput } from './text-input.js';

export class StbTextBox extends Control {
  constructor({ width = 160, height = 22, text = '', placeholder = '', maxLength = 64 } = {}) {
    super();
    this.width = width;
    this.height = height;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._input = new TextInput({
      width: width - 6,
      height: height - 6,
      text, placeholder, maxLength,
    });
    this._input.setPosition(3, 3);
    this.node.addChild(this._input.node);
    this._draw();
  }

  get value() { return this._input.value; }
  setValue(v) { this._input.setValue(v); }
  get text() { return this._input.value; }
  setText(v) { this._input.setValue(v); }

  set onChange(fn) { this._input.onChange = fn; }
  set onSubmit(fn) { this._input.onSubmit = fn; }

  _draw() {
    const g = this._gfx;
    g.clear();
    g.rect(0, 0, this.width, this.height)
      .fill({ color: 0x1c1612 })
      .stroke({ width: 1, color: 0x4a3818 });
    // Inner highlight for depth.
    g.rect(1, 1, this.width - 2, 1).fill({ color: 0x6a5b3a, alpha: 0.4 });
  }
}
