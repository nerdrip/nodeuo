// RadioButton — CUO `Game/UI/Controls/RadioButton.cs`. Single-select
// across a "group" (string key). When one button in a group is clicked
// it sets the static `_selection[group] = id` map and re-renders peers.
//
// Usage:
//   const r1 = new RadioButton({ group: 'race', id: 'human', label: 'Human' });
//   const r2 = new RadioButton({ group: 'race', id: 'elf',   label: 'Elf' });
//   r1.onChange = (selectedId) => { … };

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';

/** Static selection registry — one `id` per `group`. */
const SELECTION = new Map();
/** Static peer registry — per `group`, set of RadioButton refs to re-render. */
const PEERS = new Map();

export class RadioButton extends Control {
  constructor({ group, id, label = '', checked = false } = {}) {
    super();
    this.group = String(group ?? '');
    this.id = id;
    this.width = 14 + 4 + (label ? 120 : 0);
    this.height = 14;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    if (label) {
      this._lbl = new Label(label, { fontSize: 12, hue: 0xe8d0a0 });
      this._lbl.setPosition(18, 0);
      this.node.addChild(this._lbl.node);
    }
    this.acceptMouseInput = true;
    if (!PEERS.has(this.group)) PEERS.set(this.group, new Set());
    PEERS.get(this.group).add(this);
    if (checked) RadioButton.setSelection(this.group, this.id);
    this._draw();
  }

  get checked() { return SELECTION.get(this.group) === this.id; }

  static getSelection(group) { return SELECTION.get(group); }

  static setSelection(group, id) {
    const prev = SELECTION.get(group);
    if (prev === id) return;
    SELECTION.set(group, id);
    const peers = PEERS.get(group);
    if (peers) for (const p of peers) p._draw();
  }

  onMouseDown() {
    if (this.checked) return;
    RadioButton.setSelection(this.group, this.id);
    this.onChange?.(this.id);
  }

  dispose() {
    PEERS.get(this.group)?.delete(this);
    super.dispose?.();
  }

  _draw() {
    const g = this._gfx;
    g.clear();
    g.circle(7, 7, 6).fill({ color: 0x140e08 }).stroke({ width: 1, color: 0x4a3818 });
    if (this.checked) g.circle(7, 7, 3).fill({ color: 0xffd06a });
  }
}
