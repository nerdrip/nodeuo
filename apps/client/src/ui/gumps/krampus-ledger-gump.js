// KrampusLedgerGump — naughty/nice score viewer for the Krampus seasonal
// event (ServUO `Services/Seasonal Events/Krampus/*.cs`). Faza F.3.11.
//
// Players see their accumulated nice and naughty scores plus a small
// summary of expected reward biasing. The server pushes the values via
// a `krampus:status` packet (or fetched on demand by sending `[krampus
// status` and listening for the reply).

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

export class KrampusLedgerGump extends WindowGump {
  /**
   * @param {{ ui?: any, net?: any, niceScore?: number, naughtyScore?: number, daysLeft?: number }} opts
   */
  constructor(opts = {}) {
    super({ title: 'Krampus Ledger', width: 320, height: 200, x: 220, y: 180 });
    this._net = opts.net;
    const nice = opts.niceScore ?? 0;
    const naughty = opts.naughtyScore ?? 0;
    const days = opts.daysLeft ?? 0;
    const net = nice - naughty;
    const tier = net >= 100 ? 'Beloved' : net >= 25 ? 'Approved' : net <= -100 ? 'Doomed' : net <= -25 ? 'Watched' : 'Neutral';

    this.addContent(new Label('Krampus has been watching...', { fontSize: 11, hue: 0xffe0a0 }), 12, 30);
    this.addContent(new Label(`Nice deeds:    ${nice}`,    { fontSize: 11, hue: 0x80ff80 }), 12, 60);
    this.addContent(new Label(`Naughty deeds: ${naughty}`, { fontSize: 11, hue: 0xff8080 }), 12, 80);
    this.addContent(new Label(`Net score:     ${net}`,     { fontSize: 11, hue: 0xffffff }), 12, 100);
    this.addContent(new Label(`Standing:      ${tier}`,    { fontSize: 11, hue: 0xffe0a0 }), 12, 120);
    this.addContent(new Label(`Event ends in: ${days} day(s)`, { fontSize: 10, hue: 0xc0c0c0 }), 12, 144);

    const close = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 80, height: 22,
      label: 'Close', action: ButtonAction.Activate,
    });
    close.setPosition(220, 165);
    close.onClick = () => this.close();
    this.add(close);
  }

  get type() { return 'krampus-ledger'; }
}
