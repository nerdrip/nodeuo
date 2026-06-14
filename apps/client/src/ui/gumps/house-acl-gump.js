// HouseACLGump — full house access-control panel
// (ServUO `Gumps/HouseGumpAOS.cs` consolidated to a single overlay).
//
// Triggered by `[house gump`. Server sends:
//   @@OPEN_HOUSE_GUMP@@<id>|<owner>|<lockdowns>|<secures>|<friendsCsv>|<coownersCsv>|<bansCsv>
//
// Three columns: Friends · Co-Owners · Bans. Each cell has a "remove"
// button that dispatches `[house un<role> <name>`. A footer text-entry
// + Add button lets the owner add a new name (sends `[house <role> <name>`).

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';

export class HouseACLGump extends WindowGump {
  /** @param {{ net?: any, payload?: string }} opts */
  constructor(opts = {}) {
    const p = parseHousePayload(opts.payload);
    super({ title: `House #${p.id} — ${p.owner}`, width: 560, height: 460, x: 180, y: 120 });
    this._net = opts.net;

    this.addContent(new Label(`Lockdowns: ${p.lockdowns}`,
      { fontSize: 11, hue: 0xffd070 }), 12, 30);
    this.addContent(new Label(`Secures: ${p.secures}`,
      { fontSize: 11, hue: 0xffd070 }), 200, 30);

    const colY = 70;
    const colW = 170;
    const colH = 280;
    this._renderColumn('Friends',   12,                 colY, colW, colH, p.friends,  'friend');
    this._renderColumn('Co-Owners', 12 + colW + 12,     colY, colW, colH, p.coowners, 'coowner');
    this._renderColumn('Banned',    12 + (colW + 12)*2, colY, colW, colH, p.bans,     'ban');
  }

  _renderColumn(title, x, y, w, h, entries, role) {
    this.addContent(new Label(title, { fontSize: 12, hue: 0xffe0a0 }), x, y - 18);
    entries.forEach((name, i) => {
      const ry = y + i * 22;
      this.addContent(new Label(name, { fontSize: 10, hue: 0xffffff }), x, ry);
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 40, height: 18,
        label: 'X', action: ButtonAction.Activate,
      });
      b.setPosition(x + w - 44, ry - 2);
      b.onClick = () => { this._sendCmd(`house un${role} ${name}`); this.close(); };
      this.add(b);
    });

    let nameInput;
    try {
      nameInput = new TextInput({ width: w - 50, height: 20, text: '' });
      nameInput.setPosition(x, y + h - 24);
      this.add(nameInput);
    } catch { nameInput = null; }

    const add = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 44, height: 20,
      label: 'Add', action: ButtonAction.Activate,
    });
    add.setPosition(x + w - 46, y + h - 26);
    add.onClick = () => {
      const n = (nameInput?.value ?? '').trim();
      if (!n) return;
      this._sendCmd(`house ${role} ${n}`);
      this.close();
    };
    this.add(add);
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'house-acl'; }
}

export function parseHousePayload(raw) {
  if (!raw || typeof raw !== 'string') {
    return { id: 0, owner: 'Unknown', lockdowns: '0/0', secures: '0/0', friends: [], coowners: [], bans: [] };
  }
  const [id, owner, lockdowns, secures, friendsCsv, coownersCsv, bansCsv] = raw.split('|');
  return {
    id: id | 0,
    owner: owner ?? 'Unknown',
    lockdowns: lockdowns ?? '0/0',
    secures: secures ?? '0/0',
    friends: (friendsCsv ?? '').split(',').filter(Boolean),
    coowners: (coownersCsv ?? '').split(',').filter(Boolean),
    bans: (bansCsv ?? '').split(',').filter(Boolean),
  };
}
