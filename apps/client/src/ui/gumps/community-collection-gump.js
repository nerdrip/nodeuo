// CommunityCollectionGump — Community Collections donations ledger
// (ServUO `Services/CommunityCollections/Gumps/CommunityCollectionGump.cs`).
//
// Triggered by `[donate gump`. The server emits a sentinel
// `@@OPEN_COMMUNITY_GUMP@@<rows>` where `<rows>` is a `;`-joined list of
// `id|label|total|nextTier|tiersAwarded|myPoints` records. The gump
// renders a one-line summary per collection and a "Donate" button that
// dispatches `[donate <id>` (which then prompts the player to target an
// item to contribute).

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

export class CommunityCollectionGump extends WindowGump {
  /** @param {{ net?: any, rows?: string }} opts */
  constructor(opts = {}) {
    const records = parseRows(opts.rows);
    const height = 80 + records.length * 36;
    super({ title: 'Community Collections', width: 460, height, x: 220, y: 150 });
    this._net = opts.net;

    this.addContent(new Label('Donate items to advance the kingdom\'s tiers.',
      { fontSize: 11, hue: 0xffe0a0 }), 12, 30);

    records.forEach((r, i) => {
      const y = 60 + i * 36;
      const myPct = r.nextTier > 0 ? Math.min(100, Math.round((r.total / r.nextTier) * 100)) : 100;
      this.addContent(new Label(`${r.label}  —  ${r.total}/${r.nextTier || '∞'}  (${myPct}%)`,
        { fontSize: 11, hue: 0xffffff }), 12, y);
      this.addContent(new Label(`  tiers awarded: ${r.tiersAwarded}  ·  you: ${r.mine}`,
        { fontSize: 10, hue: 0xa0a0a0 }), 12, y + 14);

      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 90, height: 22,
        label: 'Donate', action: ButtonAction.Activate,
      });
      b.setPosition(360, y + 2);
      b.onClick = () => { this._sendCmd(`donate ${r.id}`); this.close(); };
      this.add(b);
    });
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'community-collection'; }
}

function parseRows(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw.split(';').map((row) => {
    const [id, label, total, nextTier, tiersAwarded, mine] = row.split('|');
    return {
      id, label,
      total: (total | 0),
      nextTier: (nextTier | 0),
      tiersAwarded: (tiersAwarded | 0),
      mine: (mine | 0),
    };
  });
}
