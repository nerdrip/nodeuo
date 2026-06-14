// AlphaBlendControl — semi-transparent solid fill used by CUO gumps
// to add a chrome dimmer behind other widgets. Mirrors CUO
// `Game/UI/Controls/AlphaBlendControl.cs`.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';

export class AlphaBlendControl extends Control {
  constructor({ width = 100, height = 100, color = 0x000000, alpha = 0.5 } = {}) {
    super();
    this.acceptMouseInput = false;
    this.width = width;
    this.height = height;
    this._color = color;
    this._alpha = alpha;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._draw();
  }
  setAlpha(a) { this._alpha = a; this._draw(); }
  setColor(c) { this._color = c; this._draw(); }
  _draw() {
    this._gfx.clear();
    this._gfx.rect(0, 0, this.width, this.height).fill({ color: this._color, alpha: this._alpha });
  }
}
