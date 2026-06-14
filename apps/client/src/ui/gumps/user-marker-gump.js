// UserMarkerGump — port of ClassicUO `Game/UI/Gumps/UserMarkerGump.cs`.
// Single-marker editor: pick a label, color, and (x,y) position. The
// markers-manager-gump lists all markers; this dialog edits one.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';

const COLORS = [0xFFFFFF, 0xFF6060, 0x60FF60, 0x6080FF, 0xFFE060, 0xC080FF, 0x80FFE0];

export class UserMarkerGump extends WindowGump {
  /**
   * @param {{ id?:string, name?:string, color?:number, x?:number, y?:number, map?:number }} marker
   * @param {(m: any) => void} onSave
   */
  constructor(marker = {}, onSave = null) {
    super({ title: marker.id ? 'Edit Marker' : 'New Marker', width: 280, height: 220, x: 200, y: 200 });
    this._marker = { ...marker };
    this._onSave = onSave;

    const nameLbl = new Label('Name', { fontSize: 12, hue: 0xfff0c0 });
    nameLbl.setPosition(12, 32); this.add(nameLbl);
    this._name = new TextInput({ width: 220, height: 22, value: marker.name ?? '' });
    this._name.setPosition(12, 50);
    this.add(this._name);

    const xLbl = new Label('X', { fontSize: 12 });
    xLbl.setPosition(12, 84); this.add(xLbl);
    this._x = new TextInput({ width: 80, height: 22, value: String(marker.x ?? 0) });
    this._x.setPosition(40, 80); this.add(this._x);

    const yLbl = new Label('Y', { fontSize: 12 });
    yLbl.setPosition(140, 84); this.add(yLbl);
    this._y = new TextInput({ width: 80, height: 22, value: String(marker.y ?? 0) });
    this._y.setPosition(168, 80); this.add(this._y);

    const colLbl = new Label('Color', { fontSize: 12 });
    colLbl.setPosition(12, 114); this.add(colLbl);
    let cx = 56;
    for (const c of COLORS) {
      const sw = new Button({
        normalGumpId: 0, pressedGumpId: 0,
        buttonId: 0, action: ButtonAction.Activate,
        width: 22, height: 22, label: ' ',
      });
      sw.setPosition(cx, 110);
      sw.onClick = () => { this._marker.color = c; };
      // tint via label color
      sw._label?.setStyleColor?.(c);
      this.add(sw);
      cx += 26;
    }

    const save = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      buttonId: 0, action: ButtonAction.Activate,
      width: 70, height: 24, label: 'Save',
    });
    save.setPosition(60, 158);
    save.onClick = () => {
      this._marker.name = this._name.value;
      this._marker.x = parseInt(this._x.value, 10) | 0;
      this._marker.y = parseInt(this._y.value, 10) | 0;
      this._onSave?.(this._marker);
      this.parent?.removeGump?.(this);
    };
    this.add(save);

    const cancel = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      buttonId: 0, action: ButtonAction.Activate,
      width: 70, height: 24, label: 'Cancel',
    });
    cancel.setPosition(150, 158);
    cancel.onClick = () => { this.parent?.removeGump?.(this); };
    this.add(cancel);
  }
  get type() { return `user-marker:${this._marker.id ?? 'new'}`; }
}
