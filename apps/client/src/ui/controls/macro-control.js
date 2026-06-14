// MacroControl — CUO `Game/UI/Controls/MacroControl.cs`. A single row
// in the macro-editor list: action label on the left, dropdown that
// changes the action kind, optional argument input on the right, plus
// remove (✕) button. The MacroGump composes a vertical stack of these.
//
// Our implementation deliberately stays slim — the macro-manager.js
// already has flat-list registerRunner('<kind>') definitions, so the
// dropdown is a Combobox populated with kind names. The argument input
// is a plain TextInput; per-action validation is left to the runtime.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';
import { Button } from './button.js';
import { Combobox } from './combobox.js';
import { TextInput } from './text-input.js';

export class MacroControl extends Control {
  constructor({ width = 280, height = 28, action = {}, kinds = [], onChange, onRemove } = {}) {
    super();
    this.width = width;
    this.height = height;
    this._action = { kind: action.kind ?? '', args: action.args ?? '' };
    this._kinds = kinds;
    this._onChange = onChange;
    this._onRemove = onRemove;

    this._gfx = new Graphics();
    this.node.addChild(this._gfx);

    // Step number badge (set externally via setIndex).
    this._idxLbl = new Label('1', { fontSize: 11, hue: 0xfff0c0 });
    this._idxLbl.setPosition(4, 7);
    this.node.addChild(this._idxLbl.node);

    // Kind dropdown.
    this._combo = new Combobox({
      width: 120,
      items: kinds.map((k) => ({ id: k, label: k })),
      value: this._action.kind,
    });
    this._combo.setPosition(22, 4);
    this._combo.onChange = (id) => {
      this._action.kind = id;
      this._onChange?.(this._action);
    };
    this.node.addChild(this._combo.node);

    // Args input.
    this._args = new TextInput({ width: width - 22 - 120 - 24 - 8, height: 20, text: this._action.args });
    this._args.setPosition(22 + 120 + 4, 4);
    this._args.onChange = (txt) => {
      this._action.args = txt;
      this._onChange?.(this._action);
    };
    this.node.addChild(this._args.node);

    // ✕ remove button.
    this._rm = new Button({ width: 18, height: 18, label: '✕' });
    this._rm.setPosition(width - 22, 5);
    this._rm.onClick = () => this._onRemove?.();
    this.node.addChild(this._rm.node);

    this._draw();
  }

  setIndex(i) { this._idxLbl.setText(String(i + 1)); }
  getAction() { return { ...this._action }; }

  _draw() {
    this._gfx.clear()
      .rect(0, 0, this.width, this.height)
      .fill({ color: 0x100a06, alpha: 0.5 })
      .stroke({ width: 1, color: 0x3a2a14 });
  }
}
