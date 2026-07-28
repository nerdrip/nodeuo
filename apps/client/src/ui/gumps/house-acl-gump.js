// HouseManagementGump — the browser-native equivalent of ServUO's classic
// HouseGump/HouseGumpAOS. The server remains authoritative; every action is
// dispatched through the canonical `[house` command and re-checks ACL there.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';

function decode(value, fallback = '') {
  try { return decodeURIComponent(value ?? ''); } catch { return value ?? fallback; }
}

export class HouseACLGump extends WindowGump {
  /** @param {{ net?: any, payload?: string }} opts */
  constructor(opts = {}) {
    const p = parseHousePayload(opts.payload);
    super({ title: 'House Management', width: 760, height: 610, x: 140, y: 70 });
    this._net = opts.net;
    this.house = p;

    this.addContent(new Label(p.title, { fontSize: 18, hue: 0xffe0a0 }), 14, 28);
    this.addContent(new Label(`Owner: ${p.owner}  ·  Your access: ${roleLabel(p.role)}  ·  Condition: ${p.decay}`,
      { fontSize: 11, hue: 0xd8c59b }), 14, 56);
    this.addContent(new Label(
      `Storage  ${p.lockdowns} lockdowns  ·  ${p.secures} secures  ·  ${p.vendors} vendors`,
      { fontSize: 11, hue: 0xb8c8d8 }), 14, 78);

    const manager = p.role === 'owner' || p.role === 'coowner';
    const owner = p.role === 'owner';
    this.addContent(new Label('HOUSE ACTIONS', { fontSize: 11, hue: 0xd7aa56 }), 14, 110);
    if (manager) {
      this._action('Lock down item', 14, 132, 'house lock', false, 118);
      this._action('Release item', 142, 132, 'house release', false, 108);
      this._action('Secure container', 260, 132, 'house secure', false, 130);
      this._action('Unsecure', 400, 132, 'house unsecure', false, 100);
    }
    if (owner && p.customizable) this._action('Open design mode', 510, 132, `house customize ${p.id}`, true, 144);
    if (owner && !p.customizable) {
      this.addContent(new Label('Classic house: fixed architecture', { fontSize: 10, hue: 0x9aa6b2 }), 520, 138);
    }

    if (owner) this._renderOwnershipTools(p);

    if (manager) {
      this.addContent(new Label('ACCESS LISTS', { fontSize: 11, hue: 0xd7aa56 }), 14, 356);
      const colY = 386;
      const colW = 230;
      const colH = 184;
      this._renderColumn('Friends', 14, colY, colW, colH, p.friends, 'friend', manager);
      this._renderColumn('Co-Owners', 263, colY, colW, colH, p.coowners, 'coowner', owner);
      this._renderColumn('Banned', 512, colY, colW, colH, p.bans, 'ban', manager);
    } else {
      this.addContent(new Label(
        p.role === 'banned'
          ? 'You are banned from this house.'
          : 'House access lists and management tools are available to the owner and co-owners.',
        { fontSize: 11, hue: p.role === 'banned' ? 0xff8e78 : 0xb8c8d8 }), 14, 190);
    }
  }

  _renderOwnershipTools(p) {
    this.addContent(new Label('OWNERSHIP', { fontSize: 11, hue: 0xd7aa56 }), 14, 182);
    let renameInput = null;
    try {
      renameInput = new TextInput({ width: 230, height: 24, text: p.title });
      renameInput.setPosition(14, 222); this.add(renameInput);
    } catch { /* text entry is optional on reduced UI fixtures */ }
    this._action('Rename house', 254, 222, () => {
      const title = String(renameInput?.value ?? '').trim();
      if (title) this._sendCmd(`house rename ${title}`);
    }, false, 112);

    let transferInput = null;
    try {
      transferInput = new TextInput({ width: 220, height: 24, text: '' });
      transferInput.setPosition(386, 222); this.add(transferInput);
    } catch { /* optional */ }
    this._action('Transfer', 616, 222, () => {
      const name = String(transferInput?.value ?? '').trim();
      if (name) this._sendCmd(`house transfer ${name}`);
    }, false, 104);

    this.addContent(new Label('House name', { fontSize: 10, hue: 0x9aa6b2 }), 14, 204);
    this.addContent(new Label('Transfer to an online player', { fontSize: 10, hue: 0x9aa6b2 }), 386, 204);

    this.addContent(new Label('DEMOLITION', { fontSize: 11, hue: 0xe88b72 }), 14, 272);
    const demolitionHint = new Label(
      'Demolition removes the structure and returns its exact placement deed to your backpack.',
      { fontSize: 10, hue: 0xd8c59b },
    );
    this.addContent(demolitionHint, 14, 296);
    const demolish = this._action('Demolish house', 596, 288, () => {
      if (!this._demolishArmed) {
        this._demolishArmed = true;
        demolish.setLabel('CONFIRM DEMOLITION');
        demolitionHint.setText('Click CONFIRM DEMOLITION once more. The house deed will be returned first.');
        return;
      }
      this._sendCmd(`house remove ${p.id}`);
      this.close();
    }, false, 144, true);
    if (p.customizable) {
      this.addContent(new Label(
        'Custom foundation: use “Open design mode”, place components, then Commit or Revert in the designer.',
        { fontSize: 10, hue: 0x9fc8ad },
      ), 14, 328);
    }
  }

  _action(label, x, y, command, close = false, width = 90, danger = false) {
    const b = new Button({
      normalGumpId: danger ? 0x0FA8 : 0x0481,
      pressedGumpId: danger ? 0x0FAA : 0x0482,
      width, height: 22, label, action: ButtonAction.Activate,
    });
    b.setPosition(x, y);
    b.onClick = () => {
      if (typeof command === 'function') command();
      else this._sendCmd(command);
      if (close) this.close();
    };
    this.add(b);
    return b;
  }

  _renderColumn(title, x, y, w, h, entries, role, editable) {
    this.addContent(new Label(title, { fontSize: 12, hue: 0xffe0a0 }), x, y - 19);
    const shown = entries.slice(0, 7);
    shown.forEach((name, i) => {
      const ry = y + i * 22;
      this.addContent(new Label(name, { fontSize: 10, hue: 0xffffff }), x, ry);
      if (!editable) return;
      this._action('×', x + w - 28, ry - 2, `house un${role} ${name}`, false, 26);
    });
    if (entries.length > shown.length) {
      this.addContent(new Label(`+${entries.length - shown.length} more`, { fontSize: 9, hue: 0x9aa6b2 }), x, y + 157);
    }
    if (!editable) return;

    let input = null;
    try {
      input = new TextInput({ width: w - 54, height: 20, text: '' });
      input.setPosition(x, y + h - 24); this.add(input);
    } catch { /* optional */ }
    this._action('Add', x + w - 50, y + h - 26, () => {
      const name = String(input?.value ?? '').trim();
      if (name) this._sendCmd(`house ${role} ${name}`);
    }, false, 48);
  }

  _sendCmd(cmd) {
    try { this._net?.sendCommand?.(cmd); } catch { /* socket may be closing */ }
  }

  get type() { return 'house-acl'; }
}

function roleLabel(role) {
  return ({ owner: 'Owner', coowner: 'Co-owner', friend: 'Friend', banned: 'Banned', visitor: 'Visitor' })[role] ?? 'Visitor';
}

export function parseHousePayload(raw) {
  if (!raw || typeof raw !== 'string') {
    return {
      id: 0, owner: 'Unknown', title: 'House', role: 'visitor',
      lockdowns: '0/0', secures: '0/0', vendors: '0/0',
      friends: [], coowners: [], bans: [], customizable: false,
      houseSerial: 0, decay: 'Unknown',
    };
  }
  const [id, owner, lockdowns, secures, friendsCsv, coownersCsv, bansCsv,
    role, title, customizable, houseSerial, decay, vendors] = raw.split('|');
  const names = (csv) => decode(csv).split(',').map((name) => name.trim()).filter(Boolean);
  return {
    id: id | 0,
    owner: decode(owner, 'Unknown') || 'Unknown',
    lockdowns: lockdowns ?? '0/0',
    secures: secures ?? '0/0',
    friends: names(friendsCsv),
    coowners: names(coownersCsv),
    bans: names(bansCsv),
    role: role || 'visitor',
    title: decode(title, `House #${id | 0}`) || `House #${id | 0}`,
    customizable: customizable === '1',
    houseSerial: Number(houseSerial) >>> 0,
    decay: decay || 'Unknown',
    vendors: vendors ?? '0/0',
  };
}
