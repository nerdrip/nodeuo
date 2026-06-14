// IgnoreManagerGump — list editor for the ignore set. Mirrors CUO
// `Game/UI/Gumps/IgnoreManagerGump.cs`.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Control } from '../control.js';
import { ignoreManager } from '../../managers/ignore-manager.js';
import { bus } from '../../core/event-bus.js';

const ROW_H = 22;

class IgnoreRow extends Control {
  constructor(name, onRemove) {
    super();
    this.width = 280;
    this.height = ROW_H;
    this.acceptMouseInput = true;
    const f = new Graphics();
    f.rect(0, 0, this.width, this.height)
      .fill({ color: 0x161c2a, alpha: 0.85 })
      .stroke({ width: 1, color: 0x6a4a18 });
    this.node.addChild(f);
    this._lbl = new Label('', { fontSize: 11, hue: 0xfff0c0 });
    this._lbl.setPosition(6, 5);
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
    this._rm = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      buttonId: 0, action: ButtonAction.Activate,
      width: 60, height: 18, label: 'Remove',
    });
    this._rm.setPosition(this.width - 66, 2);
    this.add(this._rm);
    this.update(name, onRemove);
  }

  update(name, onRemove) {
    this.name = name;
    this._lbl.setText(name);
    this._rm.onClick = () => onRemove?.(name);
    this.visible = true;
    this.node.visible = true;
  }
}

export class IgnoreManagerGump extends WindowGump {
  constructor() {
    super({ title: 'Ignored', width: 320, height: 320, x: 120, y: 120 });
    this._scroll = new ScrollArea({ width: 300, height: 220 });
    this.addContent(this._scroll, 8, 28);
    this._rows = [];

    this._input = new TextInput({ width: 220, height: 22, placeholder: 'name to ignore' });
    this._input.setPosition(8, 260);
    this.add(this._input);

    const addBtn = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      buttonId: 0, action: ButtonAction.Activate,
      width: 60, height: 22, label: 'Add',
    });
    addBtn.setPosition(232, 260);
    addBtn.onClick = () => {
      const v = (this._input.value || '').trim();
      if (!v) return;
      ignoreManager.add(v);
      this._input.value = '';
    };
    this.add(addBtn);

    this._unsubs = [
      bus.on('ignore:changed', () => this._render()),
    ];
    this._render();
  }
  get type() { return 'ignore'; }
  dispose() { for (const u of this._unsubs) u(); super.dispose(); }
  _render() {
    let y = 0;
    let used = 0;
    for (const n of ignoreManager.list()) {
      let row = this._rows[used];
      if (!row) {
        row = new IgnoreRow(n, (name) => ignoreManager.remove(name));
        this._rows[used] = row;
        this._scroll.add(row);
      }
      row.update(n, (name) => ignoreManager.remove(name));
      row.setPosition(2, y);
      y += ROW_H + 2;
      used++;
    }
    for (let i = used; i < this._rows.length; i++) {
      this._rows[i].visible = false;
      this._rows[i].node.visible = false;
    }
    this._scroll.setContentHeight?.(y);
  }
}
