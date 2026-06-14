// VvVBattleGump — minimal Vice-vs-Virtue battle status. ServUO has 6
// separate gumps (battle list, capture point, statistics, member list,
// reward, sigil). For our scope a single multi-pane gump suffices.
// Faza F.3.11.
//
// Players see the current battle state: capture point ownership,
// participant counts, member list, and a quick "claim reward" button
// (when a battle has just concluded).

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

export class VvVBattleGump extends WindowGump {
  /**
   * @param {{ ui?: any, net?: any, status?: any }} opts
   *   status: { city, owner, captureProgress, virtueCount, viceCount, rewardAvailable }
   */
  constructor(opts = {}) {
    super({ title: 'Vice vs Virtue', width: 400, height: 280, x: 200, y: 130 });
    this._net = opts.net;
    const s = opts.status ?? {};

    this.addContent(new Label(`Battle City: ${s.city ?? '(none active)'}`, { fontSize: 12, hue: 0xffe0a0 }), 12, 30);
    this.addContent(new Label(`Owner: ${s.owner ?? 'contested'}`, { fontSize: 11, hue: 0xffffff }), 12, 56);
    this.addContent(new Label(`Capture progress: ${(s.captureProgress ?? 0) | 0}%`, { fontSize: 11, hue: 0xffffff }), 12, 76);
    this.addContent(new Label(`Virtue participants: ${s.virtueCount ?? 0}`, { fontSize: 11, hue: 0x80a0ff }), 12, 100);
    this.addContent(new Label(`Vice participants:   ${s.viceCount ?? 0}`,   { fontSize: 11, hue: 0xff8080 }), 12, 120);

    const btn = (label, x, y, cmd) => {
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 160, height: 22,
        label, action: ButtonAction.Activate,
      });
      b.setPosition(x, y);
      b.onClick = () => { this._send(cmd); this.close(); };
      this.add(b);
    };

    btn('Join Virtue', 12,  160, 'vvv join virtue');
    btn('Join Vice',   200, 160, 'vvv join vice');
    btn('Member List', 12,  190, 'vvv members');
    btn('Statistics',  200, 190, 'vvv stats');
    if (s.rewardAvailable) {
      btn('Claim Battle Reward', 110, 230, 'vvv claim');
    }
  }

  _send(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'vvv-battle'; }
}
