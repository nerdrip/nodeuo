// Line — small reusable divider/connector control.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';

export class Line extends Control {
  constructor({ x1 = 0, y1 = 0, x2 = 100, y2 = 0, color = 0xfff0c0, alpha = 1, width = 1 } = {}) {
    super();
    this.acceptMouseInput = false;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this.x1 = x1 | 0;
    this.y1 = y1 | 0;
    this.x2 = x2 | 0;
    this.y2 = y2 | 0;
    this.color = color >>> 0;
    this.alpha = alpha;
    this.lineWidth = width | 0 || 1;
    this.width = Math.abs(this.x2 - this.x1) || this.lineWidth;
    this.height = Math.abs(this.y2 - this.y1) || this.lineWidth;
    this._draw();
  }

  _draw() {
    this._gfx.clear();
    this._gfx.moveTo(this.x1, this.y1)
      .lineTo(this.x2, this.y2)
      .stroke({ width: this.lineWidth, color: this.color, alpha: this.alpha });
  }
}
