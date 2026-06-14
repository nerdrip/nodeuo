// UltimaStoreGump — in-game store browser (ServUO `Services/UltimaStore/`).
//
// Triggered by `[store gump`. Server emits
//   @@OPEN_STORE_GUMP@@<balance>|id|label|cost|category;id|label|cost|...
// Categories: jewelry, apparel, decor, rare.
//
// "Buy" sends `[store buy <id>` which routes through ultima-store.buy().

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

export class UltimaStoreGump extends WindowGump {
  /** @param {{ net?: any, balance?: number, items?: Array<{id,label,cost,category}> }} opts */
  constructor(opts = {}) {
    const items = Array.isArray(opts.items) ? opts.items : [];
    const balance = (opts.balance | 0) || 0;
    const height = 100 + items.length * 28;
    super({ title: 'Ultima Store', width: 480, height, x: 200, y: 140 });
    this._net = opts.net;

    this.addContent(new Label(`Sovereigns: ${balance.toLocaleString()}`,
      { fontSize: 12, hue: 0xffe0a0 }), 12, 30);
    this.addContent(new Label('Decorative items unlocked by playtime + events.',
      { fontSize: 10, hue: 0xa0a0a0 }), 12, 50);

    items.forEach((it, i) => {
      const y = 80 + i * 28;
      this.addContent(new Label(`${it.label}`, { fontSize: 11, hue: 0xffffff }), 12, y);
      this.addContent(new Label(`(${it.category})`, { fontSize: 9, hue: 0x80a0c0 }), 200, y + 2);
      this.addContent(new Label(`${it.cost} sov`, { fontSize: 11, hue: 0xffd070 }), 290, y);

      const buyable = balance >= (it.cost | 0);
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 70, height: 22,
        label: buyable ? 'Buy' : '—',
        action: ButtonAction.Activate,
      });
      b.setPosition(380, y - 2);
      b.enabled = buyable;
      b.onClick = () => {
        if (!buyable) return;
        this._sendCmd(`store buy ${it.id}`);
        this.close();
      };
      this.add(b);
    });
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'ultima-store'; }
}

export function parseStorePayload(raw) {
  if (!raw || typeof raw !== 'string') return { balance: 0, items: [] };
  const [head, ...tail] = raw.split('|');
  const balance = parseInt(head, 10) || 0;
  const rest = tail.join('|');
  const items = rest.split(';').filter(Boolean).map((row) => {
    const [id, label, cost, category] = row.split('|');
    return { id, label, cost: (cost | 0), category };
  });
  return { balance, items };
}
