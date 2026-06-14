// BankerGump — bank balance + check writer (ServUO `Gumps/BankerGump.cs`).
//
// Triggered by sentinel `@@OPEN_BANKER_GUMP@@<balance>` sent when the
// player opens their bank with `[bank` near a banker. Shows the gold
// total in the bank box and a text-entry to write a check.
//
// Check sizes follow ServUO caps (5,000 .. 1,000,000 gp single check).
// On submit, the gump sends `[checks <amount>` which mints a BankCheck.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';

const MIN_CHECK = 5_000;
const MAX_CHECK = 1_000_000;

export class BankerGump extends WindowGump {
  /** @param {{ net?: any, balance?: number }} opts */
  constructor(opts = {}) {
    super({ title: 'Bank Box', width: 360, height: 220, x: 240, y: 200 });
    this._net = opts.net;
    const balance = (opts.balance | 0) || 0;

    this.addContent(new Label('Welcome to the Bank of Britannia.',
      { fontSize: 12, hue: 0xffe0a0 }), 12, 32);
    this.addContent(new Label(`Bank balance: ${balance.toLocaleString()} gp`,
      { fontSize: 11, hue: 0xa0ffa0 }), 12, 56);
    this.addContent(new Label(`Check size: ${MIN_CHECK.toLocaleString()} – ${MAX_CHECK.toLocaleString()}`,
      { fontSize: 10, hue: 0xa0a0a0 }), 12, 78);

    let amountInput;
    try {
      amountInput = new TextInput({ width: 160, height: 22, text: String(MIN_CHECK) });
      amountInput.setPosition(12, 110);
      this.add(amountInput);
    } catch { amountInput = null; }

    const btn = (label, x, y, w, cb) => {
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: w, height: 22,
        label, action: ButtonAction.Activate,
      });
      b.setPosition(x, y);
      b.onClick = () => { try { cb(); } catch { /* */ } };
      this.add(b);
    };

    btn('Write check', 180, 110, 140, () => {
      const raw = amountInput?.value ?? String(MIN_CHECK);
      const amt = parseInt(raw, 10);
      if (!Number.isFinite(amt) || amt < MIN_CHECK || amt > MAX_CHECK) return;
      this._sendCmd(`checks ${amt}`);
      this.close();
    });
    btn('Close', 130, 160, 100, () => this.close());
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'banker'; }
}
