// NameOverHeadHandlerGump — small dialog that lets the player choose
// which notoriety classes get a floating name label when AllNames mode
// is on. Mirrors ClassicUO `Game/UI/Gumps/NameOverHeadHandlerGump.cs`.
//
// Usage: opened via `Ctrl+Shift+N` (and through the macro system as
// `MacroAction.Open_NameOverheadHandler` in the future). Toggling
// AllNames itself stays bound to the `AllNames` macro / shortcut.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Checkbox } from '../controls/checkbox.js';
import { Button, ButtonAction } from '../controls/button.js';
import { nameOverheadManager } from '../../managers/name-overhead-manager.js';
import { profile } from '../../managers/profile-manager.js';

const ROWS = [
  { noto: 1, name: 'Innocent', color: 0xFFFFFF },
  { noto: 2, name: 'Ally',     color: 0x55FF55 },
  { noto: 3, name: 'Gray',     color: 0xC0C0C0 },
  { noto: 4, name: 'Criminal', color: 0xC0C0C0 },
  { noto: 5, name: 'Enemy',    color: 0xFF8000 },
  { noto: 6, name: 'Murderer', color: 0xFF3030 },
  { noto: 7, name: 'Invuln.',  color: 0xFFE060 },
];

export class NameOverHeadHandlerGump extends WindowGump {
  constructor() {
    super({ title: 'Overhead Names', width: 220, height: 240, x: 140, y: 140 });

    let y = 28;
    this._boxes = new Map();
    for (const r of ROWS) {
      const cb = new Checkbox({
        kind: 'checkbox', size: 16,
        checked: nameOverheadManager.isNotorietyVisible(r.noto),
      });
      cb.setPosition(12, y + 1);
      const orig = cb.onClick.bind(cb);
      cb.onClick = () => {
        orig();
        nameOverheadManager.setNotorietyVisible(r.noto, cb.checked);
      };
      this.add(cb);
      this._boxes.set(r.noto, cb);
      const lbl = new Label(r.name, { fontSize: 12, hue: r.color });
      lbl.setPosition(38, y);
      this.add(lbl);
      y += 22;
    }

    const allOn = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      buttonId: 0, action: ButtonAction.Activate,
      width: 86, height: 22, label: 'All On',
    });
    allOn.setPosition(12, y + 4);
    allOn.onClick = () => {
      for (const r of ROWS) {
        nameOverheadManager.setNotorietyVisible(r.noto, true);
        this._boxes.get(r.noto)?.setChecked(true, { silent: true });
      }
    };
    this.add(allOn);

    const allOff = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      buttonId: 0, action: ButtonAction.Activate,
      width: 86, height: 22, label: 'All Off',
    });
    allOff.setPosition(110, y + 4);
    allOff.onClick = () => {
      for (const r of ROWS) {
        nameOverheadManager.setNotorietyVisible(r.noto, false);
        this._boxes.get(r.noto)?.setChecked(false, { silent: true });
      }
    };
    this.add(allOff);

    // Extra row — show own name + show ground items. Both persist via
    // the NameOverheadManager → profile path.
    y += 32;
    const showOwnCb = new Checkbox({ kind: 'checkbox', size: 16,
      checked: !!profile.get('nameOverhead.showOwn') });
    showOwnCb.setPosition(12, y + 1);
    const origOwn = showOwnCb.onClick.bind(showOwnCb);
    showOwnCb.onClick = () => { origOwn(); nameOverheadManager.setShowOwn(showOwnCb.checked); };
    this.add(showOwnCb);
    const showOwnLbl = new Label('Show my own name', { fontSize: 12, hue: 0xfff0c0 });
    showOwnLbl.setPosition(38, y);
    this.add(showOwnLbl);
    y += 22;
    const showItemsCb = new Checkbox({ kind: 'checkbox', size: 16,
      checked: !!profile.get('nameOverhead.showItems') });
    showItemsCb.setPosition(12, y + 1);
    const origItems = showItemsCb.onClick.bind(showItemsCb);
    showItemsCb.onClick = () => { origItems(); nameOverheadManager.setShowItems(showItemsCb.checked); };
    this.add(showItemsCb);
    const showItemsLbl = new Label('Show ground items', { fontSize: 12, hue: 0xfff0c0 });
    showItemsLbl.setPosition(38, y);
    this.add(showItemsLbl);
  }
  get type() { return 'name-overhead-handler'; }
}
