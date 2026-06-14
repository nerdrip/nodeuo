// TrickOrTreatGump — Halloween costume reward menu. ServUO `Misc/
// TrickOrTreat.cs` + reward catalogue. Faza F.3.11.
//
// Players who collected candies during the event window may turn them
// in for one of several costume rewards. The gump lists costumes with
// candy cost; the server-side `[trickortreat` command validates and
// dispenses.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

const COSTUMES = [
  { key: 'witch-hat',       label: 'Witch Hat',       cost: 50 },
  { key: 'pumpkin-head',    label: 'Pumpkin Head',    cost: 75 },
  { key: 'skull-mask',      label: 'Skull Mask',      cost: 100 },
  { key: 'ghost-shroud',    label: 'Ghost Shroud',    cost: 150 },
  { key: 'vampiric-cloak',  label: 'Vampiric Cloak',  cost: 200 },
  { key: 'mummy-wraps',     label: 'Mummy Wraps',     cost: 250 },
];

export class TrickOrTreatGump extends WindowGump {
  /**
   * @param {{ ui?: any, net?: any, candyCount?: number }} opts
   */
  constructor(opts = {}) {
    const count = opts.candyCount ?? 0;
    super({ title: 'Trick-or-Treat Bazaar', width: 340, height: 60 + 28 * COSTUMES.length, x: 220, y: 120 });
    this._net = opts.net;

    this.addContent(new Label(`Your candy bag: ${count}`, { fontSize: 11, hue: 0xffe0a0 }), 12, 28);

    let y = 56;
    for (const c of COSTUMES) {
      const can = count >= c.cost;
      const lbl = new Label(`${c.label} — ${c.cost} candies`, { fontSize: 11, hue: can ? 0xffffff : 0x808080 });
      this.addContent(lbl, 36, y + 4);
      const b = new Button({
        normalGumpId: can ? 0x0481 : 0x0483, pressedGumpId: 0x0482,
        width: 14, height: 14,
        label: '+', action: ButtonAction.Activate,
      });
      b.setPosition(12, y);
      if (can) b.onClick = () => { this._redeem(c.key); this.close(); };
      this.add(b);
      y += 28;
    }
  }

  _redeem(key) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(`trickortreat ${key}`); } catch { /* */ }
    }
  }

  get type() { return 'trick-or-treat'; }
}
