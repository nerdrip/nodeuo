// DeathGump — post-death option menu (ServUO `Gumps/DeathGump.cs`).
// Faza F.3.11.
//
// Shown when the local player enters ghost state. Options:
//   • Resurrect at nearest Healer (free, but penalty/stat loss)
//   • Resurrect at nearest Shrine of Sacrifice (Virtue-gated)
//   • Stay as ghost (close → keep wandering)
//
// The actual rez request is routed through the existing
// `resurrect`/`accept-resurrect` server commands.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

export class DeathGump extends WindowGump {
  /**
   * @param {{ ui?: any, net?: any, onHealer?:()=>void, onShrine?:()=>void }} opts
   */
  constructor(opts = {}) {
    super({ title: 'You have died', width: 340, height: 200, x: 200, y: 160 });
    this._net = opts.net;
    this._onHealer = opts.onHealer ?? (() => this._sendCmd('resurrect'));
    this._onShrine = opts.onShrine ?? (() => this._sendCmd('shrine-resurrect'));

    this.addContent(new Label('A great darkness embraces you...', { fontSize: 12, hue: 0xffe0a0 }), 12, 30);
    this.addContent(new Label('Choose your fate:', { fontSize: 11, hue: 0xffffff }), 12, 56);

    const btn = (label, x, y, cb) => {
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 240, height: 22,
        label, action: ButtonAction.Activate,
      });
      b.setPosition(x, y);
      b.onClick = () => { try { cb(); } finally { this.close(); } };
      this.add(b);
    };

    btn('Resurrect at nearest Healer',  50, 86,  () => this._onHealer());
    btn('Resurrect at Shrine (Virtue)', 50, 116, () => this._onShrine());
    btn('Remain a ghost',                50, 146, () => { /* no-op */ });
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'death'; }
}
