// NiceButton — CUO tabbed-pill button used by Options/Journal/Macro
// gumps. Mirrors `Game/UI/Controls/NiceButton.cs`. Renders an active /
// inactive chrome rectangle with a centered Label; group radio
// behaviour via `setGroup(groupName, value)` so only one button per
// group reads as active.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';

/** Shared registry of (group → active value) so button siblings can
 *  light up the chosen tab without each one tracking the others. */
const _groups = new Map();

export class NiceButton extends Control {
  constructor({ label = '', width = 80, height = 22, value = null, group = null, onClick = null } = {}) {
    super();
    this.acceptMouseInput = true;
    this.width = width;
    this.height = height;
    this._group = group;
    this._value = value;
    this._onClick = onClick;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._label = new Label(label, { fontSize: 11, hue: 0xfff0c0, stroke: true });
    this._label.acceptMouseInput = false;
    this.add(this._label);
    this._label.setPosition(Math.max(4, (width - String(label).length * 6) / 2), 4);
    this._draw(false);
  }

  setGroup(group, value) {
    this._group = group;
    this._value = value;
    this._draw(false);
  }

  isActive() {
    return this._group != null && _groups.get(this._group) === this._value;
  }

  onMouseEnter() { this._draw(true); }
  onMouseLeave() { this._draw(false); }
  onClick() {
    if (this._group != null) {
      _groups.set(this._group, this._value);
    }
    try { this._onClick?.(this._value); } catch (e) { console.error('[nice-button] click', e); }
    this._draw(false);
  }

  _draw(hover) {
    const active = this.isActive();
    this._gfx.clear();
    this._gfx.rect(0, 0, this.width, this.height)
      .fill({ color: active ? 0x3a4660 : (hover ? 0x21283a : 0x14263e), alpha: 0.95 })
      .stroke({ width: 1, color: active ? 0xfff0a0 : 0x6a4a18 });
  }
}
