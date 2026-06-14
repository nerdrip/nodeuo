// HoveredLabel — Label that flips its hue when the cursor is over it.
// Mirrors CUO `Game/UI/Controls/HoveredLabel.cs`. Useful for clickable
// row entries (skill names, menu items) without re-rolling the hover
// bookkeeping in every gump.

import { Label } from './label.js';

export class HoveredLabel extends Label {
  constructor(text, { hue = 0xfff0c0, hoverHue = 0xffff80, fontSize = 11, stroke = false } = {}) {
    super(text, { hue, fontSize, stroke });
    this.acceptMouseInput = true;
    this._baseHue = hue;
    this._hoverHue = hoverHue;
  }

  setHueBase(h)  { this._baseHue = h;  if (!this._hovered) this.setHue?.(h); }
  setHueHover(h) { this._hoverHue = h; if (this._hovered)  this.setHue?.(h); }

  onMouseEnter() { this._hovered = true;  this.setHue?.(this._hoverHue); }
  onMouseLeave() { this._hovered = false; this.setHue?.(this._baseHue); }
}
