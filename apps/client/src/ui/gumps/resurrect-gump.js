// ResurrectGump — third-party rez offer prompt
// (ServUO `Gumps/ResurrectGump.cs`).
//
// Shown when another player casts Resurrection on the local ghost.
// Server emits `@@OPEN_RESURRECT_GUMP@@<casterName>` system message;
// game-scene parses and instantiates this gump with `caster` set.
//
// Buttons send the canonical `[accept` / `[decline` commands.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

export class ResurrectGump extends WindowGump {
  /**
   * @param {{ ui?: any, net?: any, caster?: string }} opts
   */
  constructor(opts = {}) {
    super({ title: 'Resurrection Offered', width: 360, height: 220, x: 220, y: 180 });
    this._net = opts.net;
    const caster = opts.caster ?? 'A stranger';

    this.addContent(new Label(`${caster} offers to resurrect you.`,
      { fontSize: 12, hue: 0xffe0a0 }), 12, 32);
    this.addContent(new Label('You have 30 seconds to respond.',
      { fontSize: 10, hue: 0xa0a0a0 }), 12, 54);

    const btn = (label, x, y, cb) => {
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 260, height: 22,
        label, action: ButtonAction.Activate,
      });
      b.setPosition(x, y);
      b.onClick = () => { try { cb(); } finally { this.close(); } };
      this.add(b);
    };

    btn('Accept resurrection',      40,  90, () => this._sendCmd('accept'));
    btn('Resurrect my pet (if any)', 40, 120, () => this._sendCmd('petres'));
    btn('Decline — remain a ghost',  40, 150, () => this._sendCmd('decline'));
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'resurrect-offer'; }
}
