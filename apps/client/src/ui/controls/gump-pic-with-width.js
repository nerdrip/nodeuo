// GumpPicWithWidth — like GumpPic but clamps render width via mask.
// Used by PartyGump / StatusGump health-fill bars and progress meters
// (CUO `Game/UI/Controls/GumpPicWithWidth.cs`). Pass `percent` (0..1)
// or `pixelWidth` to clip.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { GumpPic } from './gump-pic.js';

export class GumpPicWithWidth extends Control {
  constructor({ gumpId, hue = 0, width = 0, percent = 1 } = {}) {
    super();
    this.acceptMouseInput = false;
    this._pic = new GumpPic({ gumpId, hue });
    this._maskGfx = new Graphics();
    this.node.addChild(this._pic.node);
    this.node.addChild(this._maskGfx);
    this.node.mask = this._maskGfx;
    this._fullW = width | 0;
    this._percent = percent;
    this._draw();
  }

  setPercent(p) { this._percent = Math.max(0, Math.min(1, p)); this._draw(); }
  setPixelWidth(px) { this._fullW = px | 0; this._draw(); }

  _draw() {
    const w = (this._fullW || (this._pic.width | 0)) * (this._percent ?? 1);
    const h = this._pic.height | 0;
    this.width = w | 0;
    this.height = h;
    this._maskGfx.clear();
    this._maskGfx.rect(0, 0, w, h).fill({ color: 0xffffff });
  }
}
