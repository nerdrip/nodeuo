// HouseManagementGump — the browser-native equivalent of ServUO's classic
// HouseGump/HouseGumpAOS. The server remains authoritative; every action is
// dispatched through the canonical `[house` command and re-checks ACL there.
// Appearance is mapped through stable layoutIds to /client-gumps.json, so the
// admin Studio can rearrange the window without coupling data to child order.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';
import { ColorBox } from '../controls/color-box.js';
import { bus } from '../../core/event-bus.js';

const FRAME = Object.freeze({ width: 720, height: 600, x: 120, y: 54 });
const COLORS = Object.freeze({
  panel: 0x211a13,
  panelBorder: 0x8b6b36,
  dangerPanel: 0x351b18,
  dangerBorder: 0xb35d4d,
  title: 0xffe3a6,
  text: 0xf4ead2,
  muted: 0xc6b999,
  accent: 0xe9b85b,
  danger: 0xff9a83,
  success: 0x9fe0ad,
});

function decode(value, fallback = '') {
  try { return decodeURIComponent(value ?? ''); } catch { return value ?? fallback; }
}

export class HouseACLGump extends WindowGump {
  /** @param {{ net?: any, payload?: string }} opts */
  constructor(opts = {}) {
    const p = parseHousePayload(opts.payload);
    super({ title: 'House Management', ...FRAME });
    this._net = opts.net;
    this.house = p;
    this._actions = [];
    this._timers = new Set();
    this._bg.setLayoutId('window-background');
    this._title.setLayoutId('window-title');

    this._label(p.title, 'house-title', 22, 34, { fontSize: 20, hue: COLORS.title, fontWeight: 700 });
    this._label(
      `Owner: ${p.owner}   •   Access: ${roleLabel(p.role)}   •   Condition: ${p.decay}`,
      'house-meta', 22, 64, { fontSize: 13, hue: COLORS.text },
    );
    this._label(
      `Storage: ${p.lockdowns} lockdowns   •   ${p.secures} secures   •   ${p.vendors} vendors`,
      'house-storage', 22, 86, { fontSize: 12, hue: COLORS.muted },
    );

    const manager = p.role === 'owner' || p.role === 'coowner';
    const owner = p.role === 'owner';
    this._panel('actions-panel', 14, 112, 692, 78);
    this._sectionLabel('HOUSE ACTIONS', 'actions-heading', 26, 122);
    if (manager) {
      this._action('Lock down item', 'lockdown-button', 26, 149, 'house lock', false, 122);
      this._action('Release item', 'release-button', 158, 149, 'house release', false, 114);
      this._action('Secure container', 'secure-button', 282, 149, 'house secure', false, 136);
      this._action('Unsecure', 'unsecure-button', 428, 149, 'house unsecure', false, 104);
    }
    if (owner && p.customizable) {
      this._action('Open design mode', 'customize-button', 542, 149, `house customize ${p.id}`, true, 150);
    } else if (owner) {
      this._label('Classic house · fixed architecture', 'classic-house-note', 534, 154,
        { fontSize: 11, hue: COLORS.muted });
    }

    if (owner) this._renderOwnershipTools(p);

    if (manager) {
      this._panel('access-panel', 14, 362, 692, 220);
      this._sectionLabel('ACCESS LISTS', 'access-heading', 26, 373);
      const colY = 411;
      const colW = 210;
      const colH = 154;
      this._renderColumn('Friends', 'friends', 26, colY, colW, colH, p.friends, 'friend', manager);
      this._renderColumn('Co-Owners', 'coowners', 255, colY, colW, colH, p.coowners, 'coowner', owner);
      this._renderColumn('Banned', 'banned', 484, colY, colW, colH, p.bans, 'ban', manager);
    } else {
      this._panel('visitor-panel', 14, 204, 692, 104);
      this._label(
        p.role === 'banned'
          ? 'You are banned from this house.'
          : 'Management and access lists are available to the owner and co-owners.',
        'visitor-message', 28, 235,
        { fontSize: 14, hue: p.role === 'banned' ? COLORS.danger : COLORS.text },
      );
    }

    this._journalUnsub = owner
      ? bus.on('message:journal', ({ text } = {}) => this._consumeDemolitionMessage(text))
      : null;
  }

  _renderOwnershipTools(p) {
    this._panel('ownership-panel', 14, 202, 692, 146);
    this._sectionLabel('OWNERSHIP', 'ownership-heading', 26, 213);
    this._label('House name', 'house-name-label', 26, 239, { fontSize: 11, hue: COLORS.muted });
    this._label('Transfer to an online player', 'transfer-label', 380, 239,
      { fontSize: 11, hue: COLORS.muted });

    let renameInput = null;
    try {
      renameInput = new TextInput({ width: 220, height: 28, text: p.title, fontSize: 12 });
      this._add(renameInput, 'house-name-input', 26, 258);
    } catch { /* text entry is optional on reduced UI fixtures */ }
    this._action('Rename', 'rename-button', 256, 258, () => {
      const title = String(renameInput?.value ?? '').trim();
      if (title) this._sendCmd(`house rename ${title}`);
    }, false, 100);

    let transferInput = null;
    try {
      transferInput = new TextInput({ width: 190, height: 28, text: '', fontSize: 12 });
      this._add(transferInput, 'transfer-input', 380, 258);
    } catch { /* optional */ }
    this._action('Transfer', 'transfer-button', 580, 258, () => {
      const name = String(transferInput?.value ?? '').trim();
      if (name) this._sendCmd(`house transfer ${name}`);
    }, false, 112);

    this._panel('demolition-panel', 24, 298, 672, 40, true);
    this._label('DEMOLITION', 'demolition-heading', 36, 309, { fontSize: 12, hue: COLORS.danger, fontWeight: 700 });
    this._demolitionHint = this._label(
      'Removes the complete structure, then returns its exact placement deed.',
      'demolition-hint', 132, 309, { fontSize: 11, hue: COLORS.text, maxWidth: 360 },
    );
    this._demolishButton = this._action(
      'Demolish house', 'demolish-button', 536, 305,
      () => this._requestDemolition(p), false, 148, true,
    );
  }

  _requestDemolition(p) {
    if (this._demolitionPending || this._demolitionComplete) return;
    if (!this._demolishArmed) {
      this._demolishArmed = true;
      this._demolishButton?.setLabel('CONFIRM DEMOLISH');
      this._demolitionHint?.setText('Confirm once more. No deed is returned unless every house part is removed.');
      this._replaceTimer('arm', 12000, () => this._resetDemolition(
        'Removes the complete structure, then returns its exact placement deed.',
      ));
      return;
    }
    this._clearTimer('arm');
    this._demolitionPending = true;
    this._demolishButton.enabled = false;
    this._demolishButton.setLabel('Removing…');
    this._demolitionHint.setHue(COLORS.accent);
    this._demolitionHint.setText('Server is verifying and removing every part. This window will show the result.');
    if (!this._sendCmd(`house remove ${p.id}`)) {
      this._resetDemolition('Client command channel is unavailable. Reconnect and try again.');
      return;
    }
    this._replaceTimer('pending', 10000, () => {
      if (!this._demolitionPending) return;
      this._resetDemolition('No server response was received. The house was not assumed removed; you may retry.');
    });
  }

  _consumeDemolitionMessage(text) {
    if (!this._demolitionPending || typeof text !== 'string') return;
    const id = this.house.id | 0;
    const success = text.startsWith(`House #${id} demolished.`) || text.startsWith('House demolished —');
    if (success) {
      this._clearTimer('pending');
      this._demolitionPending = false;
      this._demolitionComplete = true;
      this._demolishButton.enabled = false;
      this._demolishButton.setLabel('HOUSE REMOVED');
      this._demolitionHint.setHue(COLORS.success);
      this._demolitionHint.setText('Complete. The placement deed is now in your backpack. Closing…');
      for (const button of this._actions) button.enabled = false;
      // Defer disposal until the current journal-event dispatch completes.
      // The authoritative success message is sent only after the staged deed
      // has been revealed, so this is the exact safe close boundary.
      queueMicrotask(() => {
        if (this._demolitionComplete) this.close?.();
      });
      return;
    }
    if (/^(Demolition (?:cancelled|stopped)|Open the house sign|Only the owner|Command \[house failed)/i.test(text)) {
      this._resetDemolition(text);
    }
  }

  _resetDemolition(message) {
    this._clearTimer('arm');
    this._clearTimer('pending');
    this._demolishArmed = false;
    this._demolitionPending = false;
    if (this._demolishButton) {
      this._demolishButton.enabled = true;
      this._demolishButton.setLabel('Demolish house');
    }
    if (this._demolitionHint) {
      this._demolitionHint.setHue(COLORS.text);
      this._demolitionHint.setText(message);
    }
  }

  _replaceTimer(key, delay, fn) {
    this._clearTimer(key);
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      if (this[`_${key}Timer`] === timer) this[`_${key}Timer`] = null;
      fn();
    }, delay);
    timer.unref?.();
    this[`_${key}Timer`] = timer;
    this._timers.add(timer);
  }

  _clearTimer(key) {
    const timer = this[`_${key}Timer`];
    if (!timer) return;
    clearTimeout(timer);
    this._timers.delete(timer);
    this[`_${key}Timer`] = null;
  }

  _action(label, id, x, y, command, close = false, width = 100, danger = false) {
    const button = new Button({
      normalGumpId: danger ? 0x0FA8 : 0x0481,
      pressedGumpId: danger ? 0x0FAA : 0x0482,
      width, height: 28, label, flat: true, action: ButtonAction.Activate,
    });
    button.onClick = () => {
      if (button.enabled === false) return;
      if (typeof command === 'function') command();
      else this._sendCmd(command);
      if (close) this.close();
    };
    this._actions.push(button);
    return this._add(button, id, x, y);
  }

  _renderColumn(title, id, x, y, w, h, entries, role, editable) {
    this._label(title, `${id}-heading`, x, y - 23, { fontSize: 13, hue: COLORS.title, fontWeight: 700 });
    const shown = entries.slice(0, 5);
    shown.forEach((name, index) => {
      const rowY = y + index * 23;
      this._label(name, `${id}-entry-${index}`, x, rowY, { fontSize: 12, hue: COLORS.text });
      if (editable) this._action('×', `${id}-remove-${index}`, x + w - 30, rowY - 3,
        `house un${role} ${name}`, false, 28);
    });
    if (entries.length > shown.length) {
      this._label(`+${entries.length - shown.length} more`, `${id}-overflow`, x, y + 116,
        { fontSize: 10, hue: COLORS.muted });
    }
    if (!editable) return;

    let input = null;
    try {
      input = new TextInput({ width: w - 58, height: 25, text: '', fontSize: 11 });
      this._add(input, `${id}-input`, x, y + h - 25);
    } catch { /* optional */ }
    this._action('Add', `${id}-add`, x + w - 50, y + h - 25, () => {
      const name = String(input?.value ?? '').trim();
      if (name) this._sendCmd(`house ${role} ${name}`);
    }, false, 50);
  }

  _panel(id, x, y, width, height, danger = false) {
    return this._add(new ColorBox({
      width, height,
      color: danger ? COLORS.dangerPanel : COLORS.panel,
      borderColor: danger ? COLORS.dangerBorder : COLORS.panelBorder,
      borderWidth: 1,
      alpha: danger ? 0.72 : 0.58,
    }), id, x, y);
  }

  _sectionLabel(text, id, x, y) {
    return this._label(text, id, x, y, { fontSize: 12, hue: COLORS.accent, fontWeight: 700 });
  }

  _label(text, id, x, y, options = {}) {
    return this._add(new Label(text, options), id, x, y);
  }

  _add(control, id, x, y) {
    control.setLayoutId(id);
    control.setPosition(x, y);
    this.add(control);
    return control;
  }

  _sendCmd(cmd) {
    if (typeof this._net?.sendCommand !== 'function') return false;
    try { return this._net.sendCommand(cmd) !== false; }
    catch { return false; }
  }

  dispose() {
    this._journalUnsub?.();
    this._journalUnsub = null;
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
    super.dispose();
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
