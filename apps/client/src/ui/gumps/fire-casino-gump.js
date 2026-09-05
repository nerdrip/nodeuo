// FireCasinoGump — dice table interface. ServUO `Services/FireCasino`.
// Phase F.3.11.
//
// Lets the player place a bet on a six-sided die roll (Big/Small/exact
// number) using casino chips. On submit, sends `[casino bet <kind>
// <amount> [number]` to the server, which rolls and credits/debits
// chips.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

export class FireCasinoGump extends WindowGump {
  /**
   * @param {{ ui?: any, net?: any, chips?: number }} opts
   */
  constructor(opts = {}) {
    const chips = opts.chips ?? 0;
    super({ title: 'Fire Casino — Dice Table', width: 360, height: 240, x: 220, y: 150 });
    this._net = opts.net;
    this._chips = chips;
    this._bet = 10;

    this.addContent(new Label('Place your bet:', { fontSize: 12, hue: 0xffe0a0 }), 12, 28);
    this.addContent(new Label(`Chips on hand: ${chips}`, { fontSize: 11, hue: 0xffe080 }), 12, 50);

    // Bet amount cycle button
    this._betLabel = new Label(`Wager: ${this._bet} chips`, { fontSize: 11, hue: 0xffffff });
    this.addContent(this._betLabel, 12, 78);
    const cycle = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 80, height: 22,
      label: 'x2 Wager', action: ButtonAction.Activate,
    });
    cycle.setPosition(220, 72);
    cycle.onClick = () => {
      this._bet = Math.min(this._bet * 2, Math.max(this._chips, 10));
      this._betLabel.setText(`Wager: ${this._bet} chips`);
    };
    this.add(cycle);

    const bet = (key, x, y, label) => {
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 100, height: 22,
        label, action: ButtonAction.Activate,
      });
      b.setPosition(x, y);
      b.onClick = () => { this._place(key); this.close(); };
      this.add(b);
    };

    bet('big',   30,  120, 'Bet BIG (4-6)');
    bet('small', 30,  150, 'Bet SMALL (1-3)');
    bet('exact-1', 160, 120, 'Exact 1');
    bet('exact-6', 160, 150, 'Exact 6');
  }

  _place(kind) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(`casino bet ${kind} ${this._bet}`); } catch { /* */ }
    }
  }

  get type() { return 'fire-casino'; }
}
