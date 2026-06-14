// HitBox — invisible clickable rectangle for overlay and chrome hotspots.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';

export class HitBox extends Control {
  constructor({ width = 1, height = 1, debug = false, color = 0xff0000, alpha = 0.15 } = {}) {
    super();
    this.width = width | 0;
    this.height = height | 0;
    this._debug = !!debug;
    this._color = color >>> 0;
    this._alpha = alpha;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._draw();
  }

  setDebug(enabled) {
    this._debug = !!enabled;
    this._draw();
  }

  setSize(w, h) {
    super.setSize(w, h);
    this._draw();
  }

  _draw() {
    this._gfx.clear();
    if (this._debug) {
      this._gfx.rect(0, 0, this.width, this.height).fill({ color: this._color, alpha: this._alpha });
    }
  }
}
