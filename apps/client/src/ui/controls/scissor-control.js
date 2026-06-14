// ScissorControl — rectangular clip container for child controls.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';

export class ScissorControl extends Control {
  constructor({ width = 1, height = 1 } = {}) {
    super();
    this.acceptMouseInput = false;
    this.width = width | 0;
    this.height = height | 0;
    this._mask = new Graphics();
    this.node.addChild(this._mask);
    this.node.mask = this._mask;
    this._drawMask();
  }

  setSize(w, h) {
    super.setSize(w, h);
    this._drawMask();
  }

  _drawMask() {
    this._mask.clear();
    this._mask.rect(0, 0, this.width, this.height).fill({ color: 0xffffff });
  }
}
