// SplitMenuGump — "how many to take from this stack?" dialog. Rendered
// when the player shift-drags a stackable item out of a container or
// shift-doubleclicks on a pile. Mirrors CUO `SplitMenuGump.cs`.
//
// On confirm, calls `onPick(amount)` with the requested quantity (clamped
// 1..max). Cancel emits 0 — caller can use that as a "user backed out"
// signal to abort the lift.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { TextInput } from '../controls/text-input.js';
import { Button, ButtonAction } from '../controls/button.js';

export class SplitMenuGump extends WindowGump {
  /**
   * @param {{maxAmount:number, itemId?:number, onPick:(amount:number)=>void,
   *          onCancel?:()=>void}} opts
   */
  constructor(opts) {
    super({ title: 'Split Stack', width: 240, height: 150, x: 240, y: 200 });
    this._max = Math.max(1, opts.maxAmount | 0);
    this._onPick   = opts.onPick   ?? (() => {});
    this._onCancel = opts.onCancel ?? (() => {});

    const lbl = new Label(`Amount (1 - ${this._max}):`, { fontSize: 11, hue: 0xfff0c0 });
    this.addContent(lbl, 12, 30);

    this._input = new TextInput({
      width: 80, height: 22, multiLine: false, maxLength: 6,
      text: String(this._max),
    });
    this.addContent(this._input, 12, 50);

    const allBtn = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 50, height: 22,
      label: 'All', action: ButtonAction.Activate,
    });
    allBtn.setPosition(110, 50);
    allBtn.onClick = () => this._input.setValue(String(this._max));
    this.add(allBtn);

    const halfBtn = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 50, height: 22,
      label: '½', action: ButtonAction.Activate,
    });
    halfBtn.setPosition(170, 50);
    halfBtn.onClick = () => this._input.setValue(String(Math.max(1, Math.floor(this._max / 2))));
    this.add(halfBtn);

    const ok = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 60, height: 22,
      label: 'OK', action: ButtonAction.Activate,
    });
    ok.setPosition(40, 100);
    ok.onClick = () => this._submit();
    this.add(ok);

    const cancel = new Button({
      normalGumpId: 0x0483, pressedGumpId: 0x0484,
      width: 60, height: 22,
      label: 'Cancel', action: ButtonAction.Activate,
    });
    cancel.setPosition(130, 100);
    cancel.onClick = () => { try { this._onCancel(); } finally { this.close(); } };
    this.add(cancel);
  }

  get type() { return 'split-menu'; }

  _submit() {
    const raw = parseInt(this._input.value, 10);
    const amt = Number.isFinite(raw) ? Math.max(1, Math.min(this._max, raw | 0)) : 1;
    try { this._onPick(amt); } finally { this.close(); }
  }
}
