// CroppedText — Label clipped to a fixed server-gump rectangle.
// Mirrors ClassicUO `CroppedText`: text cannot bleed outside (w x h).

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';

const ELLIPSIS = '...';

export class CroppedText extends Control {
  constructor(text = '', { width = 0, height = 0, hue = 0xfff0c0, fontSize = 12 } = {}) {
    super();
    this.acceptMouseInput = false;
    this.width = width | 0;
    this.height = height | 0;
    this._rawText = String(text ?? '');
    this._label = new Label('', { hue, fontSize });
    this._mask = new Graphics();
    this.node.addChild(this._label.node);
    this.node.addChild(this._mask);
    this.node.mask = this._mask;
    this._drawMask();
    this._fitText();
  }

  setText(text) {
    this._rawText = String(text ?? '');
    this._fitText();
  }

  setSize(w, h) {
    super.setSize(w, h);
    this._drawMask();
    this._fitText();
  }

  _drawMask() {
    this._mask.clear();
    if (this.width > 0 && this.height > 0) {
      this._mask.rect(0, 0, this.width, this.height).fill({ color: 0xffffff });
    }
  }

  _fitText() {
    const raw = this._rawText;
    if (!raw) {
      this._label.setText('');
      return;
    }
    if (this.width <= 0) {
      this._label.setText(raw);
      return;
    }

    this._label.setText(raw);
    if (this._label.width <= this.width) return;

    this._label.setText(ELLIPSIS);
    if (this._label.width > this.width) {
      this._label.setText('');
      return;
    }

    let lo = 0;
    let hi = raw.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      this._label.setText(raw.slice(0, mid) + ELLIPSIS);
      if (this._label.width <= this.width) lo = mid;
      else hi = mid - 1;
    }
    this._label.setText(raw.slice(0, lo) + ELLIPSIS);
  }
}
